'use strict';

// 명령 전송 후 실제 상태로 재동기화하기까지의 지연(ms).
// 이 시간 동안 in-memory _state가 사용자 의도를 보존해 UI 깜빡임("켰는데 즉시 꺼짐")을 막는다.
const RESYNC_DELAY_MS = 2000;
// v1.8.18 — 전원 ON 후속 모드 재전송 지연(ms). LegacyAC의 ON 보호 윈도우(기본 2000ms)와 맞춤.
const POWER_ON_MODE_RESEND_MS = 2000;
// 슬라이더 드래그 시 마지막 값만 보내기 위한 trailing-debounce 간격(ms).
const SLIDER_DEBOUNCE_MS = 400;
// v1.8.24 — 끄기 장면(scene) 형제 write 억제 창(ms). HomeKit 자동화의 "끄기" 액션은 Active=0만이
// 아니라 저장된 스냅샷(모드·온도·스윙)을 함께 write한다. 실사고(2026-07-12 23:59 승준):
// switch:off 후 0.3~1.0s에 setMode/setAcOptionalMode/setCoolingSetpoint가 뒤따라 기기가 1초 만에
// 재점등(HA 레코더로 확정). off 의도 직후 이 창 동안 형제 setter의 실제 송신을 건너뛴다.
// v1.8.26 — 2500→4000: 홈허브 지연 꼬리 케이스 마진(ON 의도가 마커를 즉시 해제하므로 비용 0).
// v1.8.28 — LegacyAC와 값 드리프트 방지를 위해 단일 소스화(lib/shared.js). 여기서 수정하지 말 것.
const OFF_SCENE_SUPPRESS_MS = require('../shared.js').OFF_SCENE_SUPPRESS_MS;
const COOL_MODE_COMMANDS = require('../shared.js').COOL_MODE_COMMANDS;
// v1.8.26 — 끄기 전송 실패 시 지연 재시도 간격(ms). off는 멱등이라 안전.
// v1.8.28 — 1회 → 2회(5s→15s): 혼잡/장기 blip에서 1회 재시도가 무력했던 꼬리 보강.
const OFF_RETRY_DELAYS_MS = [5000, 15000];
// 외부 변경(SmartThings 앱/리모컨) 반영을 위한 백그라운드 폴링 최소 간격.
// v1.8.13: 최소 폴링 간격을 10초로 환원 (사용자 결정 — 5초의 좁은 race 마진보다 10초의 안정성 선호).
// 10초는 resync(2s) + fetch(~0.5s) = 2.5s 점유 + 7.5s 여유로 매우 안전.
// SmartThings API rate limit(250 req/min/token) 대비 1 SmartAC × 6회/min = 2.4% 사용.
const MIN_BACKGROUND_POLL_SEC = 10;
// 외부(SmartThings 앱/리모컨)에서 변경한 상태를 HomeKit에 반영하기 위한 기본 폴링 간격(초).
// pollingInterval을 명시하지 않으면 이 값으로 자동 활성화된다. 0/음수로 두면 완전 비활성.
const DEFAULT_BACKGROUND_POLL_SEC = 30;

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function resolveTempProps(platformCfg = {}, deviceCfg = {}) {
  const DEFAULTS = { min: 18, max: 30, step: 1 };

  const min = Number.isFinite(deviceCfg.temperatureMin)
    ? deviceCfg.temperatureMin
    : Number.isFinite(platformCfg.temperatureMin)
      ? platformCfg.temperatureMin
      : DEFAULTS.min;

  const max = Number.isFinite(deviceCfg.temperatureMax)
    ? deviceCfg.temperatureMax
    : Number.isFinite(platformCfg.temperatureMax)
      ? platformCfg.temperatureMax
      : DEFAULTS.max;

  // v1.8.11: LegacyAC와 일관되게 SmartAC도 1℃ 단위로 고정 (사용자 요청).
  // 설정에 다른 값이 있어도 무시한다.
  //
  // v2.8.3 — 단 **시스템 에어컨은 0.5℃**다(사용자 지시). 실사용자 천장형 기기의 앱 화면이
  // 27.5℃였다. 1℃로 두면 홈킷에서 그 값을 만들 수 없고, 기기가 27.5인 상태를 홈킷이
  // 28로 반올림해 보여 준다.
  // ⚠️기기가 실제로는 1℃ 단위여도 안전하다 — 쓰기가 기기가 알려준 increment에 스냅한다
  //    (`lib/local/AcTempChannel.js`). 홈킷이 0.5를 보내도 기기에는 맞는 값이 간다.
  const safeStep = deviceCfg.__km81SystemAc ? 0.5 : 1;
  const safeMin = Math.floor(Math.min(min, max - safeStep));
  const safeMax = Math.ceil(Math.max(max, safeMin + safeStep));

  return { minValue: safeMin, maxValue: safeMax, minStep: safeStep };
}

function debounceTrailing(fn, wait) {
  let timer = null;
  let pendingValue;
  let pendingResolves = [];
  return function (value) {
    pendingValue = value;
    return new Promise((resolve, reject) => {
      pendingResolves.push({ resolve, reject });
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const value = pendingValue;
        const resolves = pendingResolves;
        timer = null;
        pendingResolves = [];
        try {
          await fn(value);
          for (const r of resolves) r.resolve();
        } catch (e) {
          for (const r of resolves) r.reject(e);
        }
      }, wait);
    });
  };
}

class SmartAC {
  constructor({ log, api, smartthings, platform }) {
    this.log = log;
    this.api = api;
    this.smartthings = smartthings;
    this.platform = platform;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.UUIDGen = api.hap.uuid;
  }

  configure(accessory, configDevice, packageVersion) {
    this._label = accessory.displayName;
    const C = this.Characteristic;
    accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'Samsung')
      .setCharacteristic(C.Model, configDevice.model || 'AC-Model')
      .setCharacteristic(C.SerialNumber, configDevice.serialNumber || accessory.context.device.deviceId)
      .setCharacteristic(C.FirmwareRevision, packageVersion);

    // 재-configure 안전성: 이전 타이머/핸들 정리
    if (this._resyncTimers) for (const t of this._resyncTimers.values()) clearTimeout(t);
    if (this._backgroundPollTimer) clearTimeout(this._backgroundPollTimer);
    if (this._powerOnModeTimer) clearTimeout(this._powerOnModeTimer);

    // 공유 상태: get 핸들러가 즉답하고 setter가 의도값을 보존
    this._state = {
      power: undefined,
      currentTemp: undefined,
      coolingSetpoint: undefined,
      windFree: undefined,
      windDirection: undefined,
      autoClean: undefined,
    };
    this._resyncTimers = new Map();
    this._stateSeq = new Map();
    // lazy-seed 추적(재-configure 시 반드시 비워 stale seed 가 살아남지 않도록).
    this._seedInFlight = {};
    this._seeded = new Set();
    this._backgroundPollTimer = null;
    this._powerOnModeTimer = null;
    // 체인 세대 표식 — OFF/재켜기 시 증가시켜, in-flight .then()이 낡은 체인을 되살리는 것을 막는다.
    this._powerOnResendGen = 0;
    // v1.8.24 — 끄기 장면 마커(ms epoch). Active setter가 off 의도 즉시 세우고 ON 의도가 해제.
    this._offIntentTs = 0;
    // v1.8.26 — 끄기 전송 실패 시 1회 지연 재시도 타이머
    if (this._offRetryTimer) clearTimeout(this._offRetryTimer);
    this._offRetryTimer = null;
    // v2.1.2 — 전원 명령 in-flight 방향(true=ON, false=OFF, null=없음). LegacyAC의
    // _activeInFlight 대응물: OFF POST가 나가 있는 동안 도착한 ON 탭이 "_state.power가 아직
    // true"라는 이유로 멱등 생략되면, ON이 클라우드에 안 나간 채 OFF만 완료되어 기기가
    // 꺼진 채 남는다("껐다 바로 켰는데 다시 꺼짐"). 반대 방향 in-flight 중에는 생략하지 않는다.
    this._powerInFlight = null;
    this._stopped = false;
    // 옵셔널 스위치 service 참조 (선언만 — 실제는 _setupOptionalSwitches에서 채움).
    // SwingMode/Lock과 같은 capability를 공유하므로 setter가 양쪽 service를 함께 push해야 한다.
    this._linkedSwitchServices = { windFree: null, autoClean: null };
    // 재-configure 안전성: 한 번만 내는 경고·자동 선택 결과를 초기화한다(적대 리뷰 L4).
    // ⚠️경고 플래그는 **용도별로 분리**한다 — 하나를 공유하면 한쪽이 다른 쪽을 침묵시킨다.
    this._rotateDir = null;
    this._coolModeWarned = false;
    this._warnedWindDir = false;
    this._warnedNoRotate = false;

    this._setupHeaterCooler(accessory, configDevice);
    this._setupOptionalSwitches(accessory.context.device, configDevice, packageVersion);
    this._setupBackgroundPolling(accessory, configDevice);

    this.platform.registerShutdown(() => {
      this._stopped = true;
      for (const t of this._resyncTimers.values()) clearTimeout(t);
      this._resyncTimers.clear();
      if (this._backgroundPollTimer) clearTimeout(this._backgroundPollTimer);
      if (this._powerOnModeTimer) clearTimeout(this._powerOnModeTimer);
      if (this._offRetryTimer) clearTimeout(this._offRetryTimer);
    });
  }

  // v1.8.24 — 끄기 장면 창: Active=0 의도 직후 형제 setter(모드/온도/무풍/자동건조)의 실제
  // 송신을 건너뛰어야 하는 구간인가. HomeKit 장면이 off와 함께 write하는 스냅샷 값이 SmartThings
  // 클라우드에서 기기를 재점등시키는 것을 막는다(전원 ON 장면은 마커가 즉시 해제되어 영향 없음).
  _isOffSceneWindow() {
    return this._offIntentTs > 0 && (Date.now() - this._offIntentTs) < OFF_SCENE_SUPPRESS_MS;
  }

  // v1.8.26 — 끄기 전송이 "실패"했을 때만 지연 재시도(성공 경로 무변경).
  // 그 사이 ON 의도가 오면(_offIntentTs 해제/갱신) 포기한다.
  // v1.8.28 — 1회 → 2회(5s→15s 백오프): 장기 blip에서 1회 재시도 전멸 시 밤새 켜지는 꼬리 보강.
  _scheduleOffRetry(deviceId, service, attempt = 1) {
    if (attempt > OFF_RETRY_DELAYS_MS.length) return;
    const delay = OFF_RETRY_DELAYS_MS[attempt - 1];
    if (this._offRetryTimer) clearTimeout(this._offRetryTimer);
    this.log.warn(`[${service.displayName}] 끄기 전송 실패 — ${delay / 1000}초 뒤 재시도합니다 (${attempt}/${OFF_RETRY_DELAYS_MS.length}).`);
    const intentTs = this._offIntentTs;
    this._offRetryTimer = setTimeout(async () => {
      this._offRetryTimer = null;
      if (this._stopped) return;
      if (this._offIntentTs === 0 || this._offIntentTs !== intentTs) return; // ON/새 off가 끼어듦
      try {
        await this.smartthings.setPower(deviceId, false);
        this._state.power = false;
        this.log.info(`[${service.displayName}] 끄기 재시도 성공.`);
        service.updateCharacteristic(this.Characteristic.Active, 0);
        service.updateCharacteristic(
          this.Characteristic.CurrentHeaterCoolerState,
          this.Characteristic.CurrentHeaterCoolerState.INACTIVE
        );
      } catch (e) {
        if (attempt < OFF_RETRY_DELAYS_MS.length) {
          this.log.warn(`[${service.displayName}] 끄기 재시도 실패(${e.message}) — 한 번 더 시도합니다.`);
          this._scheduleOffRetry(deviceId, service, attempt + 1);
        } else {
          this.log.warn(`[${service.displayName}] 끄기 재시도 실패 — 포기: ${e.message}`);
        }
      }
    }, delay);
  }

  // 명령 송신 후, 잠시 후 실제 상태를 가져와 _state와 HomeKit 모두를 보정.
  // 두 가지 race 방어:
  //  (1) seq tag — 빠른 연속 setter 호출 시 stale 결과가 새 _state를 덮어쓰지 않게.
  //  (2) _resyncTimers 항목을 fetch 완료까지 유지 — 백그라운드 폴링이 `_resyncTimers.size === 0`
  //      가드에서 in-flight resync를 정확히 인지하도록. delete를 finally로 이동.
  _scheduleResync(key, fetchActual, updateService) {
    if (this._stopped) return;
    const existing = this._resyncTimers.get(key);
    if (existing) clearTimeout(existing);
    const mySeq = (this._stateSeq.get(key) || 0) + 1;
    this._stateSeq.set(key, mySeq);
    const timer = setTimeout(async () => {
      if (this._stopped) {
        this._resyncTimers.delete(key);
        return;
      }
      try {
        const actual = await fetchActual();
        if (this._stateSeq.get(key) !== mySeq) {
          this.log.debug?.(`[resync ${key}] 더 새로운 set 감지 — stale 결과 폐기`);
          return;
        }
        this._state[key] = actual;
        updateService(actual);
      } catch (e) {
        this.log.debug?.(`[resync ${key}] 실패: ${e.message}`);
      } finally {
        // fetch + updateService가 모두 끝난 뒤에야 in-flight 표식을 제거한다.
        // 그래야 그 사이에 시작된 백그라운드 poll이 _resyncTimers.size>0를 보고 skip한다.
        if (this._resyncTimers.get(key) === timer) {
          this._resyncTimers.delete(key);
        }
      }
    }, RESYNC_DELAY_MS);
    this._resyncTimers.set(key, timer);
  }

  // v1.8.18/1.8.20 — 전원 ON 후속 재전송 체인 (opt-in resendModeOnPowerOn / resendAutoCleanOnPowerOn).
  // HomeKit이 타일 탭/Siri에서는 Active만 보내 모드 명령이 아예 없고, TargetState를 함께 보내는
  // 경우에도 기기가 켜지는 중이라 명령을 놓칠 수 있다. ON 2초 뒤 설정 모드(coolModeCommand),
  // 그 2초 뒤 자동건조 ON을 순차 전송해 항상 설정 상태로 켜지도록 보장한다.
  _schedulePowerOnResends(deviceId, { mode, autoClean, stepMs, displayName }) {
    // ★끄기 장면 창에서는 체인을 예약하지 않는다(v2.6.10).
    //   LegacyAC는 v1.8.25에 같은 가드를 넣었는데 여기에 전파되지 않아 **한쪽만 뚫려 있었다**.
    //   유출 경로: 켜기 직후 끄기가 겹치면, 뒤늦게 도착한 켜기 응답이 _state.power를 되돌리며
    //   체인을 재예약한다 → 4초 뒤 setMode가 **꺼진 기기를 다시 켠다**(밤새 켜짐).
    //   정상 켜기는 ON 의도가 _offIntentTs를 0으로 지우므로 이 가드에 걸리지 않는다.
    if (this._isOffSceneWindow()) {
      this.log.debug?.(`[${displayName}] 끄기 장면 창 — 전원 ON 후속 체인 예약 생략`);
      return;
    }
    const stepGapMs = Number.isFinite(stepMs) ? stepMs : POWER_ON_MODE_RESEND_MS;
    if (this._powerOnModeTimer) clearTimeout(this._powerOnModeTimer);
    this._powerOnResendGen += 1;
    const gen = this._powerOnResendGen;
    const steps = [];
    if (mode) {
      steps.push({ label: `모드(${mode})`, run: () => this.smartthings.setMode(deviceId, mode) });
    }
    if (autoClean) {
      steps.push({
        label: '자동건조',
        run: () => {
          // 전원 사이클 후 실제 autoClean 상태는 불명(꺼진 동안의 stale 값일 수 있음) —
          // idempotency를 우회해 반드시 전송. _setAutoClean이 UI 동기화+resync까지 처리한다.
          this._state.autoClean = undefined;
          return this._setAutoClean(deviceId, true, null);
        },
      });
    }
    if (steps.length === 0) return;
    let idx = 0;
    const fire = (retried) => {
      this._powerOnModeTimer = null;
      if (this._stopped || gen !== this._powerOnResendGen) return;
      if (this._state.power !== true) {
        // set 시점에 in-flight였던 폴링 배치가 stale 'off'를 _state에 늦게 쓸 수 있다.
        // 즉시 취소하지 않고 1초 뒤 한 번만 재확인(resync가 실측값으로 보정할 시간).
        // HomeKit발 OFF는 setter가 세대 증가+타이머 해제로 체인을 직접 끊는다.
        if (!retried) {
          this._powerOnModeTimer = setTimeout(() => fire(true), 1000);
          return;
        }
        return; // 재확인에도 off → 진짜 꺼짐, 남은 체인 전체 취소
      }
      const step = steps[idx];
      this.log.info(`[${displayName}] 전원 ON 후속 재전송 (${idx + 1}/${steps.length}): ${step.label}`);
      Promise.resolve(step.run())
        .then(() => {
          if (this._stopped || gen !== this._powerOnResendGen) return;
          idx += 1;
          if (idx < steps.length) {
            this._powerOnModeTimer = setTimeout(() => fire(false), stepGapMs);
          }
        })
        .catch(e => this.log.warn(`[${displayName}] 전원 ON 후속 재전송 실패 (${step.label}): ${e.message}`));
    };
    this._powerOnModeTimer = setTimeout(() => fire(false), POWER_ON_MODE_RESEND_MS);
  }

  // get 핸들러용 lazy 캐시 시드.
  //  - _state[key]가 이미 있으면 즉답(논블로킹) — 백그라운드 폴링이 채운 값.
  //  - 아직 없으면(cold boot) 같은 key 동시 요청은 한 번의 fetch를 공유하고(6개 char 동시 stall 완화),
  //    실패 시 plain Error 대신 HapStatusError로 보고한다. 안 그러면 SmartThings 장애 + cold boot가
  //    겹칠 때 모든 characteristic이 동시에 stall하며 "slow to respond"/"Unhandled error"/no-response로
  //    빠진다. _state가 채워지면(백그라운드 폴링/다음 read) 그때부터 정상값이 나온다.
  //    (LegacyAC v1.8.15의 _createGetter와 동일한 사상.)
  async _lazyGet(key, fetchFn) {
    // _state[key]가 정의돼 있거나(폴링/이전 seed) 한 번 seed된 적이 있으면 즉답한다.
    // _seeded를 따로 추적하는 이유: fetchFn이 정당하게 undefined를 반환하는(기기가 보고하지 않는
    // 옵셔널 capability) 경우 _state[key]가 계속 undefined라, !== undefined만 보면 매 read마다
    // 영원히 재fetch한다(모든 폴 라운드가 SmartThings round-trip). 한 번 받았으면 다시 안 받도록 한다.
    if (this._state[key] !== undefined || (this._seeded && this._seeded.has(key))) return this._state[key];
    if (!this._seedInFlight) this._seedInFlight = {};
    if (!this._seedInFlight[key]) {
      this._seedInFlight[key] = (async () => {
        try {
          this._state[key] = await fetchFn();
          if (!this._seeded) this._seeded = new Set();
          this._seeded.add(key);   // 성공(undefined 포함) → "받았음" 기록. 실패면 기록 안 해 다음 read에 재시도.
          return this._state[key];
        } finally { delete this._seedInFlight[key]; }
      })();
    }
    try {
      return await this._seedInFlight[key];
    } catch (e) {
      this.log.debug?.(`[SmartAC] '${key}' 시드 실패 — HAP 통신오류로 보고: ${e.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  _bindCharacteristic({ service, characteristic, props, getter, setter }) {
    // ★특성 이름은 **인스턴스**(`char`)에서 읽는다. 인자로 넘어오는 `characteristic`은
    //   HAP 특성 **클래스**(예: `C.Active`)라 `displayName`이 없어 로그에 `undefined`가 찍힌다.
    //   실제로 다른 사용자 로그에서 `[아기방 에어컨] undefined GET 오류`로 관측됐다(2026-07-30).
    const char = service.getCharacteristic(characteristic);
    char.removeAllListeners('get');
    if (setter) char.removeAllListeners('set');
    if (props) char.setProps(props);

    char.on('get', async (callback) => {
      try {
        const value = await getter();
        callback(null, value);
      } catch (e) {
        this.log.error(`[${service.displayName}] ${char.displayName} GET 오류:`, e.message);
        callback(e);
      }
    });

    if (setter) {
      char.on('set', async (value, callback) => {
        try {
          await setter(value);
          callback(null);
        } catch (e) {
          this.log.error(`[${service.displayName}] ${char.displayName} SET 오류:`, e.message);
          callback(e);
        }
      });
    }
  }

  _setupHeaterCooler(accessory, configDevice) {
    const C = this.Characteristic;
    const deviceId = accessory.context.device.deviceId;
    const service = accessory.getService(this.Service.HeaterCooler) ||
      accessory.addService(this.Service.HeaterCooler, accessory.displayName);
    this._mainService = service;

    // _state가 비어 있을 때만 SmartThings에서 fetch (lazy seeding). 캐시 즉답 + cold-boot 시드 공유
    // + 실패 시 HapStatusError 변환은 _lazyGet 에서 처리한다(아래 호출부는 그대로 유지).
    const lazyGet = (key, fetchFn) => this._lazyGet(key, fetchFn);

    // HomeKit COOL → 실제 전송 모드 매핑 (Active setter의 ON 후속 재전송도 이 값을 쓴다)
    // ★목록은 lib/shared.js 한 곳에만 있다 — 설정 화면(config.schema.json)도 같은 목록을
    //   쓰고, test/schema_ui.js가 둘이 어긋나면 실패한다(감사 S-1).
    const ALLOWED_COOL_CMDS = new Set(COOL_MODE_COMMANDS);
    // `coolCommand`는 스키마에 없는 옛 별칭이다. 설정 화면에서 바꾼 값이 조용히 무시되지
    // 않도록, 남아 있으면 알려 준다(감사 S-5).
    if (configDevice.coolCommand) {
      this.log.warn(`[${configDevice.deviceLabel || '신형 에어컨'}] 설정의 'coolCommand'는 옛 이름입니다 — 'coolModeCommand'로 바꿔주세요. (지금은 옛 값이 우선 적용됩니다)`);
    }
    const rawCoolCmd = configDevice.coolCommand || configDevice.coolModeCommand || 'cool';
    const coolCmd = ALLOWED_COOL_CMDS.has(rawCoolCmd) ? rawCoolCmd : 'cool';
    this._coolCmd = coolCmd;
    if (rawCoolCmd !== coolCmd) {
      this.log.warn(`[${configDevice.deviceLabel || '신형 에어컨'}] 알 수 없는 냉방 모드 '${rawCoolCmd}' — '냉방(cool)'으로 대신합니다. 쓸 수 있는 값: ${COOL_MODE_COMMANDS.join(', ')}`);
    }
    // v1.8.18 — 전원 ON 후속 모드 재전송 (opt-in). v1.8.20 — 자동건조 체인 추가 (opt-in)
    const resendModeOnPowerOn = configDevice.resendModeOnPowerOn === true;
    const resendAutoCleanOnPowerOn = configDevice.resendAutoCleanOnPowerOn === true;
    // v1.8.21 — 체인 단계 간격 기기별 조정 (기본 2000ms)
    const stepMsRaw = Number(configDevice.powerOnResendStepMs);
    const powerOnResendStepMs = Number.isFinite(stepMsRaw) && stepMsRaw >= 1000 && stepMsRaw <= 10000
      ? stepMsRaw : POWER_ON_MODE_RESEND_MS;

    // ===== Active (전원) =====
    this._bindCharacteristic({
      service,
      characteristic: C.Active,
      getter: async () => (await lazyGet('power', () => this.smartthings.getPower(deviceId))) ? 1 : 0,
      setter: async (value) => {
        const target = value === 1;
        // v1.8.24 — 끄기 장면 마커. 아래 idempotency 조기 return보다 먼저 세운다: 기기가 이미
        // 꺼져 있어 off 명령이 생략되는 밤에도 장면의 형제 write(모드/온도)는 그대로 도착하므로,
        // 마커 없이는 그 write가 꺼진 기기를 켠다. ON 의도는 마커를 즉시 해제(켜기 장면 보호).
        this._offIntentTs = target ? 0 : Date.now();
        // v1.8.25 — idempotency는 ON에만 적용한다. OFF까지 생략하면 ①폴링이 채운 stale
        // _state.power(리모컨/앱으로 방금 켠 기기)로 끄기 탭이 무시되고 ②끄기 장면이 형제-먼저
        // 순서로 오면 형제 write(setMode)가 기기를 켠 뒤 OFF가 "이미 꺼짐"으로 생략되어 밤새
        // 켜진 채 남는다(LegacyAC 반대방향 in-flight 하드닝의 SmartAC 대응물 — 시뮬레이션 FB에서
        // 확정). OFF는 멱등·저비용이라 항상 전송하는 것이 최종 상태를 보장한다.
        // v2.1.2 — OFF가 in-flight인 동안의 ON은 생략하지 않는다: _state.power 대입은 await
        // 성공 뒤(아래)라 OFF 전송 중엔 여전히 true이고, 여기서 생략하면 ON이 클라우드에
        // 안 나간 채 OFF만 완료되어 기기가 꺼진 채 남는다(LegacyAC :849 반대방향 가드 대응).
        // ★★2026-08-03 — **폴이 실패 중이면 생략하지 않는다**(적대 리뷰 M6).
        //   생략의 전제는 "_state.power가 기기의 현재 상태와 같다"인데, 그 값을 채우는 건
        //   폴이다. 기기가 끊긴 동안 폴은 통째로 catch로 빠지므로 값이 **마지막으로 본
        //   그대로 얼어붙는다**. 그 상태에서 켜기 탭이 오면 명령이 debug 한 줄만 남기고
        //   사라지는데 홈킷에는 **성공으로 보고**된다 — 사용자는 켰다고 믿고, 기기는 꺼져 있다.
        //   ⚠️폴백이 없는 10월 구성에서 이게 정확히 열린다.
        //   신선하지 않으면 그냥 보낸다. 기기가 정말 죽었으면 전송이 실패하고, 그 실패가
        //   홈킷에 그대로 보이는 편이 **조용한 성공보다 정직하다**.
        if (target && this._state.power === true && this._powerInFlight !== false
          && this._stateFresh !== false) {
          this.log.debug?.(`[${service.displayName}] Active 이미 ${target} — 명령 생략`);
          return;
        }
        // OFF는 의도 시점에 즉시 재전송을 취소한다 — await 뒤에 지우면 OFF 전송(수백 ms) 중에
        // 타이머가 발화해 mode 명령이 OFF와 클라우드에서 경합할 수 있다(LegacyAC의 cancel-at-intent와 동일).
        if (!target) {
          this._powerOnResendGen += 1; // send 중인 체인 단계의 .then()도 무효화
          if (this._powerOnModeTimer) {
            clearTimeout(this._powerOnModeTimer);
            this._powerOnModeTimer = null;
          }
        }
        this._powerInFlight = target;
        try {
          await this.smartthings.setPower(deviceId, target);
        } catch (e) {
          // v1.8.26 — 끄기 전송 실패는 방치하면 밤새 켜짐(무인 자동화가 특히 취약).
          // off는 멱등이라 5초 뒤 1회만 재시도(그 사이 ON 의도가 오면 자동 취소).
          if (!target) this._scheduleOffRetry(deviceId, service);
          throw e;
        } finally {
          // 같은 방향만 해제 — 이 전송 중 반대 방향 setter가 겹쳤으면 그쪽 값이 살아 있어야 한다.
          if (this._powerInFlight === target) this._powerInFlight = null;
        }
        this._state.power = target;
        if (target && (resendModeOnPowerOn || resendAutoCleanOnPowerOn)) {
          this._schedulePowerOnResends(deviceId, {
            mode: resendModeOnPowerOn ? coolCmd : null,
            autoClean: resendAutoCleanOnPowerOn,
            stepMs: powerOnResendStepMs,
            displayName: service.displayName,
          });
        }
        service.updateCharacteristic(
          C.CurrentHeaterCoolerState,
          target ? C.CurrentHeaterCoolerState.COOLING : C.CurrentHeaterCoolerState.INACTIVE
        );
        this._scheduleResync(
          'power',
          () => this.smartthings.getPower(deviceId),
          (actual) => {
            service.updateCharacteristic(C.Active, actual ? 1 : 0);
            service.updateCharacteristic(
              C.CurrentHeaterCoolerState,
              actual ? C.CurrentHeaterCoolerState.COOLING : C.CurrentHeaterCoolerState.INACTIVE
            );
          }
        );
      },
    });

    // ===== CurrentHeaterCoolerState =====
    this._bindCharacteristic({
      service,
      characteristic: C.CurrentHeaterCoolerState,
      getter: async () => {
        const on = await lazyGet('power', () => this.smartthings.getPower(deviceId));
        return on ? C.CurrentHeaterCoolerState.COOLING : C.CurrentHeaterCoolerState.INACTIVE;
      },
    });

    // ===== TargetHeaterCoolerState (COOL 고정) =====
    // 주의: mode는 외부(SmartThings 앱/리모컨)에서 drift할 수 있고 우리 _state에는 추적되지 않으므로
    //       in-process 캐시 기반 idempotency는 안전하지 않다. 매번 명령을 보내 정확성 우선.
    this._bindCharacteristic({
      service,
      characteristic: C.TargetHeaterCoolerState,
      props: { validValues: [C.TargetHeaterCoolerState.COOL] },
      getter: () => C.TargetHeaterCoolerState.COOL,
      setter: async (value) => {
        if (value !== C.TargetHeaterCoolerState.COOL) return;
        // v1.8.24 — 끄기 장면의 스냅샷 write: setMode는 꺼진 기기를 재점등시킬 수 있으므로 스킵
        // (2026-07-12 23:59 실사고 — off 0.3s 뒤 setMode 등 후속 명령에 기기가 1초 만에 재점등).
        if (this._isOffSceneWindow()) {
          this.log.debug?.(`[${service.displayName}] TargetState: 끄기 장면 창 — 송신 생략`);
          return;
        }
        await this.smartthings.setMode(deviceId, coolCmd);
      },
    });

    // ===== CurrentTemperature =====
    this._bindCharacteristic({
      service,
      characteristic: C.CurrentTemperature,
      getter: () => lazyGet('currentTemp', () => this.smartthings.getCurrentTemperature(deviceId)),
    });

    // ===== CoolingThresholdTemperature (슬라이더 debounce + send 후 patch) =====
    const tempProps = resolveTempProps(this.platform.config || {}, configDevice || {});
    // 홈킷 슬라이더가 몇 도 단위로 움직이는지를 로그로 확인할 수 있게 한다.
    // (사용자가 "0.5도였던 것 같은데 1도로 움직인다"고 했을 때 물어볼 것이 없었다.)
    this.log.info(`[${accessory.displayName}] 홈킷 온도 ${tempProps.minValue}~${tempProps.maxValue}℃ · `
      + `${tempProps.minStep}℃ 단위`);
    // 주의(v1.7.2 LegacyAC 버그와 동형): setter에서 _state를 즉시 patch하면 idempotency가 자신과
    // 비교되어 명령이 항상 생략된다. _state.coolingSetpoint는 send 성공 후에만 갱신.
    let lastSentSetpoint = null;
    const debouncedSetTemp = debounceTrailing(async (value) => {
      // v1.8.28 — shutdown 후 트레일링 발화 방어(LegacyAC _pendingDebounces 정리와 대칭).
      if (this._stopped) return;
      const clamped = clampNumber(value, tempProps.minValue, tempProps.maxValue);
      // v1.8.24 — 끄기 장면의 온도 스냅샷(디바운스 400ms 뒤 도착): setCoolingSetpoint는 꺼진
      // 기기를 재점등시킬 수 있으므로 스킵. v1.8.25 — 억제 시 resync를 걸어 HAP characteristic이
      // 장면 스냅샷 값에 고정되지 않게 한다(폴링 push는 _state 변화 시에만 발화해 못 고침).
      if (this._isOffSceneWindow()) {
        this.log.debug?.(`[${service.displayName}] Setpoint ${clamped}: 끄기 장면 창 — 송신 생략`);
        this._scheduleResync(
          'coolingSetpoint',
          () => this.smartthings.getCoolingSetpoint(deviceId),
          (actual) => {
            const a = clampNumber(actual, tempProps.minValue, tempProps.maxValue);
            lastSentSetpoint = a;
            service.updateCharacteristic(C.CoolingThresholdTemperature, a);
          }
        );
        return;
      }
      // v1.8.28 — lastSent만으로 생략하면 리모컨/앱으로 값이 바뀐 뒤 "원래 값으로 되돌리기"가
      // 영구 무시된다(24→리모컨 26→홈킷 24 = lastSent 24라 생략). 폴링/resync가 채우는 실측
      // (_state.coolingSetpoint)까지 같을 때만 생략한다(실측 미상이면 기존 동작 유지).
      const measuredSetpoint = this._state.coolingSetpoint;
      if (lastSentSetpoint === clamped && (measuredSetpoint == null || measuredSetpoint === clamped)) {
        this.log.debug?.(`[${service.displayName}] Setpoint 이미 ${clamped} — 명령 생략`);
        return;
      }
      await this.smartthings.setTemperature(deviceId, clamped);
      lastSentSetpoint = clamped;
      this._state.coolingSetpoint = clamped;
      this._scheduleResync(
        'coolingSetpoint',
        () => this.smartthings.getCoolingSetpoint(deviceId),
        (actual) => {
          const a = clampNumber(actual, tempProps.minValue, tempProps.maxValue);
          lastSentSetpoint = a;
          service.updateCharacteristic(C.CoolingThresholdTemperature, a);
        }
      );
    }, SLIDER_DEBOUNCE_MS);

    this._bindCharacteristic({
      service,
      characteristic: C.CoolingThresholdTemperature,
      props: tempProps,
      getter: async () => {
        const current = await lazyGet('coolingSetpoint', () => this.smartthings.getCoolingSetpoint(deviceId));
        return clampNumber(current, tempProps.minValue, tempProps.maxValue);
      },
      setter: (value) => debouncedSetTemp(value),
    });

    // ===== SwingMode (WindFree 매핑) =====
    // 설정 항목이 종류마다 다르다 — 시스템 에어컨만 방향을 직접 고를 수 있고,
    // 신형은 `회전`(기기가 지원하는 방향 자동)뿐이다. 화면에도 하나씩만 뜬다.
    // ⚠️`deviceType`은 이 시점에 이미 `smartAc`로 정규화돼 있으므로 표식을 봐야 한다.
    const swingBinding = configDevice.__km81SystemAc
      ? (configDevice.systemSwingBinding || 'windFree')
      : (configDevice.swingBinding || 'windFree');
    // ⚠️종류를 바꾸면 읽는 항목도 바뀐다 — 예전 항목에 무풍이 아닌 값이 남아 있으면
    //   설정이 **조용히 무풍으로 되돌아간 것처럼** 보인다(적대 리뷰 L3). 그때만 짚어 준다.
    const staleKey = configDevice.__km81SystemAc ? 'swingBinding' : 'systemSwingBinding';
    const stale = configDevice[staleKey];
    if (!configDevice[configDevice.__km81SystemAc ? 'systemSwingBinding' : 'swingBinding']
      && stale && stale !== 'windFree') {
      this.log.warn(`[${this._label}] 장치 종류를 바꾸면서 스윙 토글 설정이 초기화됐습니다 `
        + `(이전 '${staleKey}' = ${stale}). 지금은 '무풍'으로 동작합니다 — 설정에서 다시 골라 주세요.`);
    }
    this._swingBinding = swingBinding;
    // ★바람방향은 **로컬 경로 전용**이다 — SmartThings 클라우드에는 대응 기능이 없어
    //   `SmartThingsClient`에 그 메서드가 아예 없다. 클라우드 클라이언트로 묶인 기기에서
    //   방향 바인딩을 쓰면 폴과 setter가 매번 `TypeError`로 죽는다(적대 리뷰 H3).
    //   ⚠️`전송 경로 = 로컬`로 두어도 IP 누락·브릿지 기동 실패면 클라우드 클라이언트가
    //     조용히 반환된다(index.js `_clientFor`) — 그 경로가 실사용자 전례가 있다.
    //   그래서 **설정이 아니라 실제 클라이언트 능력**으로 판정한다.
    const canWindDirection = typeof this.smartthings?.getWindDirection === 'function'
      && typeof this.smartthings?.setWindDirection === 'function';
    if (SmartAC.SWING_DIRECTIONS.includes(swingBinding) && !canWindDirection) {
      this.log.warn(`[${this._label}] 스윙 토글이 바람방향으로 설정돼 있지만 이 기기는 `
        + `로컬 경로로 붙지 않아 바람방향을 쓸 수 없습니다 — 스윙 토글을 만들지 않습니다. `
        + `'전송 경로'를 로컬로 두고 '기기 IP'를 확인하세요.`);
      this._swingBinding = 'none';
      if (service.testCharacteristic(C.SwingMode)) {
        service.removeCharacteristic(service.getCharacteristic(C.SwingMode));
      }
    } else if (SmartAC.SWING_DIRECTIONS.includes(swingBinding)) {
      // 스윙 토글 하나로 무풍과 바람방향을 모두 고를 수 있다(v2.9.0).
      // `rotate`는 기기가 지원한다고 알려준 방향을 자동으로 고른다 — 기기마다 다르기
      // 때문이다(실측: 승준 에어컨은 좌우만, 천장형은 네 방향 전부).
      this._bindCharacteristic({
        service,
        characteristic: C.SwingMode,
        getter: async () => {
          const cur = await lazyGet('windDirection', () => this.smartthings.getWindDirection(deviceId));
          return cur && cur !== 'Fix' ? 1 : 0;
        },
        setter: async (value) => {
          const target = value === 1 ? await this._resolveSwingDirection(deviceId) : 'Fix';
          if (target) { await this._setWindDirection(deviceId, target, service); return; }
          // ★보낼 방향을 못 정했으면 토글을 실제 상태로 되돌린다(적대 리뷰 M4).
          //   안 그러면 켜짐(거짓)으로 남고 `_state`도 안 바뀌어 폴이 고쳐 주지도 않는다.
          this._scheduleResync('windDirection',
            () => this.smartthings.getWindDirection(deviceId),
            (actual) => {
              if (service.testCharacteristic(C.SwingMode)) {
                service.updateCharacteristic(C.SwingMode, actual && actual !== 'Fix' ? 1 : 0);
              }
            });
        },
      });
    } else if (swingBinding !== 'none') {
      this._bindCharacteristic({
        service,
        characteristic: C.SwingMode,
        getter: async () => (await lazyGet('windFree', () => this.smartthings.getWindFree(deviceId))) ? 1 : 0,
        setter: (value) => this._setWindFree(deviceId, value === 1, service),
      });
    } else if (service.testCharacteristic(C.SwingMode)) {
      service.removeCharacteristic(service.getCharacteristic(C.SwingMode));
    }

    // ===== LockPhysicalControls (AutoClean 매핑) =====
    const lockBinding = (configDevice.lockBinding || 'autoClean');
    if (lockBinding !== 'none') {
      this._bindCharacteristic({
        service,
        characteristic: C.LockPhysicalControls,
        getter: async () => (await lazyGet('autoClean', () => this.smartthings.getAutoClean(deviceId))) ? 1 : 0,
        setter: (value) => this._setAutoClean(deviceId, value === 1, service),
      });
    } else if (service.testCharacteristic(C.LockPhysicalControls)) {
      service.removeCharacteristic(service.getCharacteristic(C.LockPhysicalControls));
    }
  }

  // WindFree/AutoClean은 메인 HeaterCooler의 SwingMode/Lock + 옵셔널 스위치가
  // 같은 SmartThings 필드를 가리키므로, 한쪽 setter가 양쪽 service를 모두 push해야 일관됨.
  /**
   * 고른 냉방 모드를 기기가 실제로 지원하는지 확인한다 (v2.10.0 — 구형 AC와 같은 방식).
   * ⚠️지원 목록은 **모델마다 다르다** — 실측 2026-08-01: 창문형 `[AIComfort,Cool,Dry,Fan]`
   *    (자동 없음), 천장형 CAC `[Auto,Cool,Dry,Fan,AIComfort]`. 하나를 기준으로 목록을
   *    고정할 수 없어 설정에는 합집합을 두고, 안 되는 조합만 여기서 짚어 준다.
   * 안 되는 모드를 골라 두면 냉방을 눌러도 아무 일이 없는데 그 이유가 어디에도 안 나온다.
   * 기기가 목록을 알려줄 때만, 한 번만 알린다. **명령을 막지는 않는다** — 우리 판정이
   * 틀렸을 때 멀쩡한 기기를 못 쓰게 만드는 쪽이 더 나쁘다.
   */
  async _warnUnsupportedCoolMode(deviceId, coolCmd) {
    if (this._coolModeWarned) return;
    const supported = await this.smartthings.getSupportedModes?.(deviceId) || [];
    // ⚠️판정 여부와 무관하게 **한 번 물어봤으면 끝**이다. v2.10.0까지는 목록이 비면
    //   표식을 안 세워 **매 폴마다** CoAP GET 이 나갔다(적대 리뷰 M5).
    this._coolModeWarned = true;
    if (supported.length === 0) return;                 // 알려주지 않는 기기면 판정하지 않는다
    const LocalApplianceClient = require('../api/LocalApplianceClient');
    const wanted = (LocalApplianceClient.MODE_MAP || {})[String(coolCmd).toLowerCase()];
    if (!wanted || supported.includes(wanted)) return;
    this.log.warn(`[${this._label}] 이 기기는 냉방 버튼에 설정된 모드 '${coolCmd}'(${wanted})를 `
      + `지원하지 않습니다 — 지원: ${supported.join(', ')}. `
      + `설정의 '냉방 버튼 → 보낼 모드'를 바꾸세요.`);
  }

  /**
   * 스윙을 켤 때 보낼 방향을 정한다.
   * 설정에서 방향을 콕 집었으면 그대로, `rotate`면 기기가 지원한다고 알려준 것 중에서 고른다.
   * ⚠️기기마다 다르다 — 실측: 승준 에어컨(창문형)은 `Fix`·`Left_And_Right`만,
   *    천장형은 네 방향 전부. 그래서 `rotate`가 필요하다.
   */
  async _resolveSwingDirection(deviceId) {
    if (this._swingBinding !== 'rotate') return this._swingBinding;
    if (this._rotateDir) return this._rotateDir;
    const supported = await this.smartthings.getSupportedWindDirections?.(deviceId) || [];
    const pick = SmartAC.ROTATE_PREFERENCE.find((m) => supported.includes(m))
      || supported.find((m) => m !== 'Fix')
      || null;
    if (!pick) {
      // ⚠️'회전 불가'와 '미지원 방향'은 **다른 경고**다. 플래그를 공유하면 한쪽이 다른 쪽을
      //   침묵시키고, 미지원 차단 가드까지 함께 풀린다(적대 리뷰 L4).
      if (!this._warnedNoRotate) {
        this._warnedNoRotate = true;
        this.log.warn(`[${this._label}] 이 기기는 회전할 수 있는 바람방향이 없습니다`
          + `${supported.length ? ` — 지원: ${supported.join(', ')}` : ''}. `
          + `스윙 토글을 '무풍'이나 '사용 안 함'으로 두세요.`);
      }
      return null;
    }
    this._rotateDir = pick;
    this.log.info(`[${this._label}] 스윙 회전 방향 = ${pick} (기기가 지원하는 값에서 고름)`);
    return pick;
  }

  /**
   * 바람방향 전송 (스윙 토글이 바람방향에 묶였을 때).
   * ⚠️무풍과 같은 보호를 그대로 쓴다 — 끄기 장면 창에서는 보내지 않는다(재점등 방지).
   */
  async _setWindDirection(deviceId, target, originService) {
    const C = this.Characteristic;
    const push = (actual) => {
      if (this._mainService?.testCharacteristic(C.SwingMode)) {
        this._mainService.updateCharacteristic(C.SwingMode, actual && actual !== 'Fix' ? 1 : 0);
      }
    };
    if (this._isOffSceneWindow()) {
      this.log.debug?.('바람방향: 끄기 장면 창 — 송신 생략');
      this._scheduleResync('windDirection', () => this.smartthings.getWindDirection(deviceId), push);
      return;
    }
    if (this._state.windDirection === target) {
      this.log.debug?.(`바람방향 이미 ${target} — 명령 생략`);
      return;
    }
    // 기기가 지원하지 않는 값을 조용히 보내지 않는다 — 지원 목록과 함께 알린다(구형 AC와 같은 방식).
    // ⚠️**차단은 매번** 한다. v2.10.0까지는 `!this._warnedWindDir`가 검사 자체를 감싸고 있어
    //   두 번째 시도부터는 미지원 값이 그대로 기기로 나갔다(적대 리뷰 M3).
    //   경고만 한 번으로 줄이고, 판정은 계속한다.
    if (target !== 'Fix') {
      const supported = await this.smartthings.getSupportedWindDirections?.(deviceId) || [];
      if (supported.length > 0 && !supported.includes(target)) {
        if (!this._warnedWindDir) {
          this._warnedWindDir = true;
          this.log.warn(`[${this._label}] 이 기기는 바람방향 '${target}'을 지원하지 않습니다 `
            + `— 지원: ${supported.join(', ')}. 설정의 스윙 토글 항목을 바꾸세요.`);
        }
        // ★보내지 않았으니 홈킷 토글을 실제 상태로 되돌린다(적대 리뷰 M4).
        //   안 되돌리면 `_state`도 안 바뀌어 다음 폴도 push를 생략 → 켜짐(거짓)으로 영구 잔류.
        this._scheduleResync('windDirection', () => this.smartthings.getWindDirection(deviceId), push);
        return;
      }
    }
    await this.smartthings.setWindDirection(deviceId, target);
    this._state.windDirection = target;
    push(target);
  }

  async _setWindFree(deviceId, target, originService) {
    const C = this.Characteristic;
    // v1.8.24 — 끄기 장면의 무풍 스냅샷: setAcOptionalMode는 꺼진 기기를 재점등시킬 수 있으므로 스킵.
    // v1.8.25 — 억제 시 resync로 HAP 표시값을 실측으로 되돌린다(폴링 push는 _state 변화 시에만 발화).
    if (this._isOffSceneWindow()) {
      this.log.debug?.('WindFree: 끄기 장면 창 — 송신 생략');
      this._scheduleResync(
        'windFree',
        () => this.smartthings.getWindFree(deviceId),
        (actual) => {
          // ★스윙이 바람방향에 묶였으면 무풍이 그 표시를 건드리면 안 된다(적대 리뷰 M2).
          if (!SmartAC.SWING_DIRECTIONS.includes(this._swingBinding)
            && this._mainService?.testCharacteristic(C.SwingMode)) {
            this._mainService.updateCharacteristic(C.SwingMode, actual ? 1 : 0);
          }
          if (this._linkedSwitchServices.windFree) {
            this._linkedSwitchServices.windFree.updateCharacteristic(C.On, !!actual);
          }
        }
      );
      return;
    }
    if (this._state.windFree === target) {
      this.log.debug?.(`WindFree 이미 ${target} — 명령 생략`);
      return;
    }
    await this.smartthings.setWindFree(deviceId, target);
    this._state.windFree = target;
    const linkedSwitch = this._linkedSwitchServices.windFree;
    if (linkedSwitch && linkedSwitch !== originService) {
      linkedSwitch.updateCharacteristic(C.On, target);
    }
    // ★'방향은 스윙 토글, 무풍은 별도 스위치'가 의도된 조합이다 — 무풍이 스윙 표시를
    //   덮으면 방향 스윙이 꺼져 있어도 켜짐으로 보인다(적대 리뷰 M2).
    if (!SmartAC.SWING_DIRECTIONS.includes(this._swingBinding)
      && this._mainService && this._mainService !== originService
      && this._mainService.testCharacteristic(C.SwingMode)) {
      this._mainService.updateCharacteristic(C.SwingMode, target ? 1 : 0);
    }
    this._scheduleResync(
      'windFree',
      () => this.smartthings.getWindFree(deviceId),
      (actual) => {
        if (this._mainService?.testCharacteristic(C.SwingMode)) {
          this._mainService.updateCharacteristic(C.SwingMode, actual ? 1 : 0);
        }
        if (this._linkedSwitchServices.windFree) {
          this._linkedSwitchServices.windFree.updateCharacteristic(C.On, !!actual);
        }
      }
    );
  }

  async _setAutoClean(deviceId, target, originService) {
    const C = this.Characteristic;
    // v1.8.24 — 끄기 장면의 잠금(자동건조) 스냅샷은 송신하지 않는다. 전원 ON 후속 체인의 호출은
    // ON 의도가 마커를 해제한 뒤(≥2s)라 이 가드에 걸리지 않는다.
    // v1.8.25 — 억제 시 resync로 HAP 표시값을 실측으로 되돌린다.
    if (this._isOffSceneWindow()) {
      this.log.debug?.('AutoClean: 끄기 장면 창 — 송신 생략');
      this._scheduleResync(
        'autoClean',
        () => this.smartthings.getAutoClean(deviceId),
        (actual) => {
          if (this._mainService?.testCharacteristic(C.LockPhysicalControls)) {
            this._mainService.updateCharacteristic(C.LockPhysicalControls, actual ? 1 : 0);
          }
          if (this._linkedSwitchServices.autoClean) {
            this._linkedSwitchServices.autoClean.updateCharacteristic(C.On, !!actual);
          }
        }
      );
      return;
    }
    if (this._state.autoClean === target) {
      this.log.debug?.(`AutoClean 이미 ${target} — 명령 생략`);
      return;
    }
    await this.smartthings.setAutoClean(deviceId, target);
    this._state.autoClean = target;
    const linkedSwitch = this._linkedSwitchServices.autoClean;
    if (linkedSwitch && linkedSwitch !== originService) {
      linkedSwitch.updateCharacteristic(C.On, target);
    }
    if (this._mainService && this._mainService !== originService && this._mainService.testCharacteristic(C.LockPhysicalControls)) {
      this._mainService.updateCharacteristic(C.LockPhysicalControls, target ? 1 : 0);
    }
    this._scheduleResync(
      'autoClean',
      () => this.smartthings.getAutoClean(deviceId),
      (actual) => {
        if (this._mainService?.testCharacteristic(C.LockPhysicalControls)) {
          this._mainService.updateCharacteristic(C.LockPhysicalControls, actual ? 1 : 0);
        }
        if (this._linkedSwitchServices.autoClean) {
          this._linkedSwitchServices.autoClean.updateCharacteristic(C.On, !!actual);
        }
      }
    );
  }

  _setupOptionalSwitches(device, configDevice, packageVersion) {
    const C = this.Characteristic;
    const baseLabel = device.label;

    const maybeCreateSwitch = (keySuffix, displayName, stateKey, setterFn, fetchFn) => {
      const uuid = this.UUIDGen.generate(`${device.deviceId}:${keySuffix}`);
      let acc = this.platform.accessories.find(a => a.UUID === uuid);

      if (!acc) {
        acc = new this.api.platformAccessory(`${baseLabel} - ${displayName}`, uuid);
        acc.context.device = device;
        this.api.registerPlatformAccessories(this.platform.PLUGIN_NAME, this.platform.PLATFORM_NAME, [acc]);
        this.platform.accessories.push(acc);
      } else {
        acc.displayName = `${baseLabel} - ${displayName}`;
        acc.context.device = device;
      }
      this.platform.activeUUIDs.add(uuid);

      const info = acc.getService(this.Service.AccessoryInformation) || acc.addService(this.Service.AccessoryInformation);
      info
        .setCharacteristic(C.Manufacturer, 'Samsung')
        .setCharacteristic(C.Model, (configDevice?.model) || 'AC-Feature')
        .setCharacteristic(C.SerialNumber, `${device.deviceId}-${keySuffix}`)
        .setCharacteristic(C.FirmwareRevision, packageVersion);

      const sw = acc.getService(this.Service.Switch) || acc.addService(this.Service.Switch, acc.displayName);
      this._linkedSwitchServices[stateKey] = sw;

      this._bindCharacteristic({
        service: sw,
        characteristic: C.On,
        getter: async () => !!(await this._lazyGet(stateKey, fetchFn)),
        setter: (v) => setterFn(device.deviceId, !!v, sw),
      });
    };

    if (configDevice.exposeWindFreeSwitch) {
      maybeCreateSwitch('windfree', '무풍', 'windFree',
        (id, t, origin) => this._setWindFree(id, t, origin),
        () => this.smartthings.getWindFree(device.deviceId));
    }

    if (configDevice.exposeAutoCleanSwitch) {
      maybeCreateSwitch('autoclean', '자동건조', 'autoClean',
        (id, t, origin) => this._setAutoClean(id, t, origin),
        () => this.smartthings.getAutoClean(device.deviceId));
    }
  }

  // 백그라운드 폴링 (옵션). SmartThings 앱/리모컨에서 변경한 상태가 HomeKit에 반영되도록.
  // 사용자가 명시적으로 설정하지 않으면 비활성 (기본 동작 유지).
  _setupBackgroundPolling(accessory, configDevice) {
    // 기본 정책 (v1.8.9):
    //  - pollingInterval 미지정 → DEFAULT_BACKGROUND_POLL_SEC(60s)로 자동 활성화.
    //  - 0 또는 음수 → 명시적 비활성.
    //  - 그 외 숫자 → 최소 MIN_BACKGROUND_POLL_SEC(30s)로 clamp.
    const raw = configDevice.pollingInterval;
    let sec;
    if (raw == null || raw === '') {
      sec = DEFAULT_BACKGROUND_POLL_SEC;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        // ★★2026-08-03 적대 리뷰 M5 — 폴링을 끄면 **기기 사망을 알아챌 방법이 사라진다.**
        //   연속 실패를 세는 곳이 폴이라, `제어되지 않습니다` 경보도, NAS 감시기가 보는
        //   문구도 영영 안 나온다. 폴백까지 없으면 그 기기는 **조용히 죽은 채 남는다.**
        //   설정을 무시하지는 않는다(사용자의 명시적 선택이다) — 대신 사실을 말한다.
        if (configDevice.transport === 'local' && configDevice.local?.fallbackToCloud === false) {
          this.log.warn(`[${accessory.displayName}] 폴링이 꺼져 있고 클라우드 폴백도 없습니다 — `
            + '기기가 끊겨도 알림이 나가지 않습니다(감시 불가). 감시가 필요하면 폴링 주기를 두세요.');
        }
        return; // 명시적 비활성
      }
      sec = Math.max(n, MIN_BACKGROUND_POLL_SEC);
    }
    const C = this.Characteristic;
    const deviceId = accessory.context.device.deviceId;
    const main = this._mainService;
    const pollOnce = async () => {
      if (this._stopped) return;
      try {
        // 진행 중인 resync가 있으면 폴링을 건너뛰어 race 회피
        if (this._resyncTimers.size === 0) {
          this.smartthings.invalidateStatusCache(deviceId);
          const power = await this.smartthings.getPower(deviceId);
          const temp = await this.smartthings.getCurrentTemperature(deviceId);
          const setpoint = await this.smartthings.getCoolingSetpoint(deviceId);
          const windFree = await this.smartthings.getWindFree(deviceId);
          // ⚠️이 조회가 던지면 **폴 라운드 전체**가 catch로 빠져 전원·온도까지 통째로 유실된다
          //   (적대 리뷰 H2). 표시용 보조 값이므로 실패해도 라운드를 이어간다.
          let windDir;
          if (SmartAC.SWING_DIRECTIONS.includes(this._swingBinding)) {
            try { windDir = await this.smartthings.getWindDirection(deviceId); }
            catch (e) {
              this.log.debug?.(`[${accessory.displayName}] 바람방향 조회 실패(표시만 보류): ${e.message}`);
            }
          }
          const autoClean = await this.smartthings.getAutoClean(deviceId);
          // 첫 성공 폴에서 한 번만 — 기기가 그 모드를 지원하는지 확인해 준다.
          if (!this._coolModeWarned) {
            this._warnUnsupportedCoolMode(deviceId, this._coolCmd).catch(() => {});
          }

          // 여기까지 왔으면 이번 라운드는 기기에서 실제 값을 받아온 것이다.
          this._stateFresh = true;

          if (this._state.power !== power) {
            this._state.power = power;
            main.updateCharacteristic(C.Active, power ? 1 : 0);
            main.updateCharacteristic(
              C.CurrentHeaterCoolerState,
              power ? C.CurrentHeaterCoolerState.COOLING : C.CurrentHeaterCoolerState.INACTIVE
            );
          }
          if (this._state.currentTemp !== temp) {
            this._state.currentTemp = temp;
            main.updateCharacteristic(C.CurrentTemperature, temp);
          }
          if (this._state.coolingSetpoint !== setpoint) {
            this._state.coolingSetpoint = setpoint;
            main.updateCharacteristic(C.CoolingThresholdTemperature, setpoint);
          }
          if (windDir !== undefined && this._state.windDirection !== windDir) {
            this._state.windDirection = windDir;
            if (main.testCharacteristic(C.SwingMode)) {
              main.updateCharacteristic(C.SwingMode, windDir !== 'Fix' ? 1 : 0);
            }
          }
          if (this._state.windFree !== windFree) {
            this._state.windFree = windFree;
            // ★스윙 토글이 바람방향에 묶였으면 무풍 값으로 덮으면 안 된다(적대 리뷰 M1).
            //   첫 폴에서 방향 스윙이 켜져 있어도 0으로 덮여 표시가 영영 어긋났다.
            if (!SmartAC.SWING_DIRECTIONS.includes(this._swingBinding)
              && main.testCharacteristic(C.SwingMode)) {
              main.updateCharacteristic(C.SwingMode, windFree ? 1 : 0);
            }
            if (this._linkedSwitchServices.windFree) this._linkedSwitchServices.windFree.updateCharacteristic(C.On, !!windFree);
          }
          if (this._state.autoClean !== autoClean) {
            this._state.autoClean = autoClean;
            if (main.testCharacteristic(C.LockPhysicalControls)) main.updateCharacteristic(C.LockPhysicalControls, autoClean ? 1 : 0);
            if (this._linkedSwitchServices.autoClean) this._linkedSwitchServices.autoClean.updateCharacteristic(C.On, !!autoClean);
          }
        }
      } catch (e) {
        // ★캐시가 낡았음을 표시한다 — 켜기 생략(idempotency)이 이 값을 본다.
        this._stateFresh = false;
        // 라벨을 붙인다 — 같은 이름의 기기가 여럿이면 어느 쪽인지 알 수 없었다.
        this.log.debug?.(`[${accessory.displayName}] 백그라운드 폴링 오류: ${e.message}`);
      } finally {
        if (!this._stopped) this._backgroundPollTimer = setTimeout(pollOnce, sec * 1000);
      }
    };
    this.log.info(`[${accessory.displayName}] SmartAC 백그라운드 폴링 시작 (${sec}s).`);
    this._backgroundPollTimer = setTimeout(pollOnce, sec * 1000);
  }
}

// 온도 범위·단계 계산은 순수 함수라 따로 시험한다(회귀 계약: test/first_boot.js).
// 스윙 토글이 바람방향을 모는 값들. 스키마의 선택지와 이 목록이 어긋나면 계약 검사가 깨진다.
SmartAC.SWING_DIRECTIONS = ["rotate", "Up_And_Low", "Left_And_Right", "All"];
// `회전`이 고를 우선순위. 앞엣것부터 기기 지원 목록에서 찾는다.
SmartAC.ROTATE_PREFERENCE = ["Up_And_Low", "Left_And_Right", "All"];

SmartAC._resolveTempProps = resolveTempProps;

module.exports = SmartAC;
