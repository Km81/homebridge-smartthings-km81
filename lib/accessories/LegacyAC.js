'use strict';

const fs = require('fs');
const path = require('path');
const pkg = require('../../package.json');
const { LegacyACClient, getCertificate } = require('../api/LegacyACClient');

const CONSTANTS = {
  // package.json의 버전을 직접 참조해 FirmwareRevision이 자동으로 최신화되도록 한다.
  PLUGIN_VERSION: pkg.version,
  DEFAULT_CACHE_DURATION_MS: 30000,
  // 폴링 미설정 + 영구 오프라인일 때 마지막 상태를 무한정 보여주지 않도록 하는 상한.
  // 캐시가 이보다 오래되면(백그라운드 새로고침이 계속 실패) 옛 값 대신 통신오류(no-response)로 표시한다.
  STALE_HARD_CAP_MS: 180000,
  DEFAULT_TIMEOUT_MS: 5000,
  // 네트워크 단절 시 _cmdMutex 체인이 무한 누적되어 HomeKit이 응답 없음으로 빠지는 것을 막기 위한
  // 동시 명령 한도. 일반 사용에서는 절대 도달하지 않는다.
  MAX_PENDING_COMMANDS: 5,
  POWER: { ON: 'On', OFF: 'Off' },
  // v1.8.20 — 전원 ON 후속 재전송 체인의 단계 간격. 구형 firmware가 짧은 간격의 다중 명령을
  // 놓치므로 모드 → 자동건조 사이에 이만큼 띄운다.
  POWER_ON_RESEND_STEP_MS: 2000,
  // v1.8.24 신설·v1.8.26 2500→4000·v1.8.28 단일 소스화 — 값과 근거는 lib/shared.js 참조.
  // SmartAC와 반드시 같은 값이어야 하므로 여기서 직접 수정하지 말 것.
  OFF_SCENE_SUPPRESS_MS: require('../shared.js').OFF_SCENE_SUPPRESS_MS,
  // v1.8.26 — 폴링 공유 창: 이 시간 내 성공 응답이 있으면 기기 GET을 생략(폴 간격 10s 전제).
  POLL_SHARE_MAX_AGE_MS: 7000,
  SWING: { UP_DOWN: 'Up_And_Low', FIX: 'Fix' },
  COMFORT: { NANO_ON: 'Comode_Nano', NANO_OFF: 'Comode_Off' },
  AUTOCLEAN: { ON: 'Autoclean_On', OFF: 'Autoclean_Off' }
};

class SwingModeHandler {
  constructor(type) { this.type = type; }
  getValue(state) {
    if (!state) return false;
    if (this.type === 'wind') return state.Wind?.direction === CONSTANTS.SWING.UP_DOWN;
    return state.Mode?.options?.includes(CONSTANTS.COMFORT.NANO_ON);
  }
  getCommand(enable) {
    if (this.type === 'wind') {
      const dir = enable ? CONSTANTS.SWING.UP_DOWN : CONSTANTS.SWING.FIX;
      return { endpoint: '/wind', data: { direction: dir } };
    }
    const opt = enable ? CONSTANTS.COMFORT.NANO_ON : CONSTANTS.COMFORT.NANO_OFF;
    return { endpoint: '/mode', data: { options: [opt] } };
  }
}

class LegacyAC {
  constructor({ log, config, api, accessory, packageRoot }) {
    this.log = log;
    this.config = config;
    this.accessory = accessory;
    this.api = api;
    this.packageRoot = packageRoot;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    // 인증서/네트워크 초기 실패 시 절반-구성 상태로 남는 것을 막기 위한 플래그.
    // shutdown은 이 플래그를 확인해 미초기화 필드 접근으로 인한 TypeError를 회피한다.
    this._initialized = false;

    this.name = this.config.name;
    this.deviceIndex = this.config.deviceIndex ?? 0;
    this.setDeviceIndex = this.config.setDeviceIndex ?? this.deviceIndex;
    this.cacheDuration = this.config.cacheDuration ?? CONSTANTS.DEFAULT_CACHE_DURATION_MS;
    this.timeout = this.config.timeout ?? CONSTANTS.DEFAULT_TIMEOUT_MS;
    this.pollingInterval = this.config.pollingInterval;
    this.minTemp = this.config.minTemp ?? 18;
    this.maxTemp = this.config.maxTemp ?? 30;
    this.debugMode = this.config.debug === true;
    this.pollTimer = null;

    const defaultCertPath = path.join(this.packageRoot, 'cert', 'cert.pem');
    const certPath = this.config.certPath || defaultCertPath;
    const keyPath = this.config.keyPath || certPath;

    try {
      const certBuffer = getCertificate(certPath);
      const keyBuffer = getCertificate(keyPath);
      // v1.8.24 — 같은 IP(2in1 기기)를 쓰는 액세서리들이 클라이언트를 공유한다.
      // 단일 연결 서버에 대한 동시 접속 경합 제거 + GET /devices 병합(응답 하나에 두 기기 상태).
      this.client = LegacyACClient.getShared(this.config.ip, this.config.token, this.log, {
        timeout: this.timeout, cert: certBuffer, key: keyBuffer
      });
    } catch (e) {
      this.log.error(`[${this.name}] 인증서 처리 오류: ${e.message}`);
      return;
    }

    this.coolModeStr = this._resolveCoolMode();
    this.swingBinding = this._resolveSwingBinding();
    this.lockBinding = this._resolveLockBinding();
    this.swingModeHandler = new SwingModeHandler(this.swingBinding === 'wind' ? 'wind' : 'comfort');

    this.deviceState = null;
    this.lastStateUpdate = 0;
    this.stateRequestPromise = null;

    this._cmdMutex = Promise.resolve();
    this._stopped = false;
    this._pendingCmdCount = 0;
    // 동시 탭 흡수용 in-flight 표식 (Active 전용; null/POWER.ON/POWER.OFF)
    this._activeInFlight = null;

    // ===== v1.7.0 — 다중 명령 보호 =====
    // ON 보호 윈도우: Active=1 직후 이 시간 동안 다른 setter는 실제 명령 송신을 건너뛰고
    // _state만 patch. 윈도우 종료 후, 'queue' 전략이면 누적된 명령을 한 번에 발사.
    const guardMs = Number(this.config.legacyOnGuardMs);
    this._onGuardMs = Number.isFinite(guardMs) && guardMs >= 0 ? Math.min(guardMs, 10000) : 2000;
    this._onGuardStrategy = this.config.legacyOnGuardStrategy === 'queue' ? 'queue' : 'drop';
    this._onGuardUntil = 0;
    this._onGuardTimer = null;
    this._deferredCommands = new Map(); // endpoint → { data, patchFn }

    // ===== v1.8.18 — 전원 ON 후속 모드 재전송 (opt-in) =====
    // 이 firmware는 power=on 직후의 모드 명령을 무시하고(F6, 보호 윈도우가 drop),
    // HomeKit이 타일 탭/Siri에서는 Active만 보내 모드 명령 자체가 없는 경우도 있다.
    // 이 옵션이 켜져 있으면 전원 ON마다 보호 윈도우 종료 후 hkCoolMode를 1회 전송해
    // 항상 설정 모드(예: DryClean)로 켜지도록 보장한다.
    this._resendModeOnPowerOn = this.config.resendModeOnPowerOn === true;
    // v1.8.20 — 모드 재전송 2초 뒤 자동건조 ON도 전송 (opt-in)
    this._resendAutoCleanOnPowerOn = this.config.resendAutoCleanOnPowerOn === true;
    // v1.8.21 — 체인 마지막에 스윙 끄기 전송 (opt-in). 일부 기기(벽걸이)가 켜질 때/모드 변경 때
    // 스스로 회전을 켜는 것을 원위치시킨다.
    this._resendSwingOffOnPowerOn = this.config.resendSwingOffOnPowerOn === true;
    // v1.8.21 — 스윙/잠금 토글을 HomeKit 노출에서만 숨긴다 (opt-in). iOS 홈 앱이 타일 탭의
    // 기본 동작으로 SwingMode를 골라(실측: 탭이 SET SwingMode로 들어옴) 전원 토글이 안 되는
    // 문제의 해법 — 숨기면 탭이 고를 토글이 Active뿐이라 탭=전원이 된다.
    // 바인딩 자체(swingBinding/lockBinding)는 유지되므로 후속 재전송 체인은 계속 동작한다.
    this._hideSwingToggle = this.config.hideSwingToggle === true;
    this._hideLockToggle = this.config.hideLockToggle === true;
    // v1.8.21 — 체인 단계 간격을 기기별로 조정 가능(반응이 느린 firmware용, 기본 2000ms)
    const stepMs = Number(this.config.powerOnResendStepMs);
    this._powerOnResendStepMs = Number.isFinite(stepMs) && stepMs >= 1000 && stepMs <= 10000
      ? stepMs : CONSTANTS.POWER_ON_RESEND_STEP_MS;
    this._powerOnModeTimer = null;
    // 체인 세대 표식 — OFF/재켜기 시 증가시켜, in-flight .then()이 낡은 체인을 되살리는 것을 막는다.
    this._powerOnResendGen = 0;

    // ===== v1.8.24 — 끄기 장면(scene) 형제 write 억제 =====
    // HomeKit 자동화/장면의 "끄기" 액션은 Active=0만이 아니라 저장된 스냅샷(TargetState·온도·
    // 스윙·잠금)을 함께 write한다(승준 SmartAC 23:59 자동화 실사고 — off 1초 뒤 후속 명령이
    // 기기를 도로 켬). off 의도 직후 짧은 창 동안 형제 setter의 실제 송신을 건너뛴다.
    // 특히 이 클래스의 TargetState setter는 "꺼져 있으면 전원 ON을 보내는" 설계라, 끄기 장면에서
    // 이 가드가 없으면 플러그인 스스로 기기를 재점등시킨다. ON 의도는 마커를 즉시 해제한다.
    this._offIntentTs = 0;
    // v1.8.26 — 끄기 전송 실패 시 1회 지연 재시도 타이머 + 폴 실패 스트릭(로그 억제)
    this._offRetryTimer = null;
    // v1.8.28 — 끄기 흡수 후 실측 검증 타이머(v1.8.29에서 생성자 선언 정리)
    this._offVerifyTimer = null;
    this._pollFailStreak = 0;

    // ===== v1.8.23 — 상태 파일 덤프 (opt-in, stateDumpFile) =====
    // HA 등 외부 소비자가 이 기기를 직접 폴링하는 대신 홈브릿지의 캐시를 파일로 읽게 하는
    // 단일 소유자(Single Owner) 브릿지. EnerTalk 파일브릿지와 동일 패턴: 비동기 쓰기 + tmp→rename
    // 원자적 교체 + 실패 전부 삼킴(debugLog) — HAP 경로에 어떤 예외/블로킹도 전파되지 않는다.
    this._stateDumpFile = typeof this.config.stateDumpFile === 'string' && this.config.stateDumpFile.trim()
      ? this.config.stateDumpFile.trim() : null;
    this._lastStateDump = 0;
    this._stateDumpTimer = null; // 스로틀 trailing flush용
    this._lastFetchTs = 0;       // 실측(fetch) 시각 — 낙관 patch와 구분해 소비자에 제공
    this._lastMutSrc = null;     // 'fetch' | 'patch'

    // 단일 trailing-debounced refresh: 여러 set가 연쇄적으로 일어나도 1회만 강제 갱신.
    this._refreshTimer = null;

    // pending 명령 디바운스 타이머들 — Active=OFF 시 모두 취소해야 한다.
    this._pendingDebounces = new Map(); // key → setTimeout handle

    this.aircoService = this.accessory.getService(this.Service.HeaterCooler) ||
      this.accessory.addService(this.Service.HeaterCooler, this.name);

    this.accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, this.config.manufacturer || 'Samsung')
      .setCharacteristic(this.Characteristic.Model, this.config.model || 'AC-Model')
      .setCharacteristic(this.Characteristic.SerialNumber, this.config.serialNumber || this.name)
      .setCharacteristic(this.Characteristic.FirmwareRevision, CONSTANTS.PLUGIN_VERSION);

    this.setupCharacteristics();
    this.startPolling();
    this._initialized = true;

    const guardLabel = this._onGuardMs > 0
      ? `${this._onGuardMs}ms/${this._onGuardStrategy}`
      : '꺼짐';
    const resendSteps = [
      this._resendModeOnPowerOn ? this.coolModeStr : null,
      this._resendAutoCleanOnPowerOn ? '자동건조' : null,
      this._resendSwingOffOnPowerOn ? '스윙끄기' : null,
    ].filter(Boolean);
    const resendLabel = resendSteps.length
      ? `${resendSteps.join('→')} (간격 ${this._powerOnResendStepMs}ms)` : '꺼짐';
    const dumpLabel = this._stateDumpFile ? path.basename(this._stateDumpFile) : '꺼짐';
    this.log.info(`[${this.name}] LegacyAC 초기화 완료. (Cool=${this.coolModeStr}, Swing=${this.swingBinding}, Lock=${this.lockBinding}, ON보호=${guardLabel}, ON후속모드=${resendLabel}, 상태덤프=${dumpLabel})`);
  }

  _resolveCoolMode() {
    const cfg = this.config;
    const allowed = new Set(['Cool', 'CoolClean', 'Dry', 'DryClean']);
    if (typeof cfg.hkCoolMode === 'string' && allowed.has(cfg.hkCoolMode)) return cfg.hkCoolMode;
    if (typeof cfg.hkCoolMode === 'string' && cfg.hkCoolMode.length > 0 && cfg.hkCoolMode !== 'none') {
      this.log.warn(`[${this.name}] hkCoolMode='${cfg.hkCoolMode}'는 v1.4.0에서 지원하지 않습니다. 'Cool'로 대체합니다.`);
      return 'Cool';
    }
    if (Array.isArray(cfg.hkCoolModes) && cfg.hkCoolModes.length > 0) {
      const first = String(cfg.hkCoolModes[0]).trim();
      if (allowed.has(first)) return first;
    }
    return 'Cool';
  }

  _resolveSwingBinding() {
    const cfg = this.config;
    if (typeof cfg.legacySwingBinding === 'string') {
      if (['comfort', 'wind', 'none'].includes(cfg.legacySwingBinding)) return cfg.legacySwingBinding;
    }
    if (cfg.enableSwingMode === false) return 'none';
    if (cfg.swingModeType === 'wind') return 'wind';
    return 'comfort';
  }

  _resolveLockBinding() {
    const cfg = this.config;
    if (typeof cfg.legacyLockBinding === 'string') {
      if (['autoClean', 'none'].includes(cfg.legacyLockBinding)) return cfg.legacyLockBinding;
    }
    if (cfg.enableLockPhysicalControls === false) return 'none';
    return 'autoClean';
  }

  shutdown() {
    // 인증서 실패 등으로 초기화가 완료되지 못한 인스턴스는 내부 자료구조가 없으므로 즉시 종료.
    if (!this._initialized) {
      this.log.debug?.(`[${this.name}] 미초기화 인스턴스 shutdown — 작업 건너뜀.`);
      return;
    }
    this.log.info(`[${this.name}] 폴링 타이머를 정리합니다.`);
    this._stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this._onGuardTimer) {
      clearTimeout(this._onGuardTimer);
      this._onGuardTimer = null;
    }
    if (this._powerOnModeTimer) {
      clearTimeout(this._powerOnModeTimer);
      this._powerOnModeTimer = null;
    }
    if (this._offRetryTimer) {
      clearTimeout(this._offRetryTimer);
      this._offRetryTimer = null;
    }
    if (this._offVerifyTimer) {
      clearTimeout(this._offVerifyTimer);
      this._offVerifyTimer = null;
    }
    if (this._stateDumpTimer) {
      clearTimeout(this._stateDumpTimer);
      this._stateDumpTimer = null;
    }
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    for (const t of this._pendingDebounces.values()) clearTimeout(t);
    this._pendingDebounces.clear();
    this._deferredCommands.clear();
  }

  // ===== ON 보호 윈도우 헬퍼 =====
  _isOnGuardActive() {
    return this._onGuardMs > 0 && Date.now() < this._onGuardUntil;
  }

  // v1.8.24 — 끄기 장면 창: Active=0 의도 직후 형제 setter(모드/온도/스윙/잠금)의 실제 송신을
  // 건너뛰어야 하는 구간인가. 마커는 Active setter가 off 의도 즉시(await 전) 세우고 ON 의도가 해제.
  _isOffSceneWindow() {
    return this._offIntentTs > 0 &&
      (Date.now() - this._offIntentTs) < CONSTANTS.OFF_SCENE_SUPPRESS_MS;
  }

  // v1.8.26 — 끄기 전송이 "실패"했을 때만 재시도(성공 경로는 건드리지 않음 — '띠' 원칙).
  // 그 사이 ON 의도가 오면(_offIntentTs가 0이 되거나 다른 off로 갱신) 재시도를 포기한다.
  // 주의: 재시도는 마커(_offIntentTs)를 재스탬프하지 않는다 — 형제 write가 4~5s 사이에 도착하는
  // 극단 꼬리에서는 형제가 먼저 가고 off가 뒤에 이겨 최종 상태는 off로 수렴(순차 처리).
  // v1.8.28 — 1회 → 2회(5s→15s 백오프): 명령 큐 초과(혼잡) 같은 조건은 5초 뒤에도 지속되기
  // 쉬워, 방어가 가장 필요한 상황에서 정확히 1회 재시도가 무력했다. off는 멱등이라 안전.
  _scheduleOffRetry(attempt = 1) {
    const OFF_RETRY_DELAYS_MS = [5000, 15000];
    if (attempt > OFF_RETRY_DELAYS_MS.length) return;
    const delay = OFF_RETRY_DELAYS_MS[attempt - 1];
    if (this._offRetryTimer) clearTimeout(this._offRetryTimer);
    this.log.warn(`[${this.name}] 끄기 전송 실패 — ${delay / 1000}초 뒤 재시도합니다 (${attempt}/${OFF_RETRY_DELAYS_MS.length}).`);
    const intentTs = this._offIntentTs;
    this._offRetryTimer = setTimeout(() => {
      this._offRetryTimer = null;
      if (this._stopped) return;
      if (this._offIntentTs === 0 || this._offIntentTs !== intentTs) return; // ON/새 off가 끼어듦
      this.sendCommand('', { Operation: { power: CONSTANTS.POWER.OFF } })
        .then(() => {
          this.log.info(`[${this.name}] 끄기 재시도 성공.`);
          this._patchState(st => {
            st.Operation = st.Operation || {};
            st.Operation.power = CONSTANTS.POWER.OFF;
          });
          this._scheduleRefresh();
        })
        .catch(e => {
          if (attempt < OFF_RETRY_DELAYS_MS.length) {
            this.log.warn(`[${this.name}] 끄기 재시도 실패(${e.message}) — 한 번 더 시도합니다.`);
            this._scheduleOffRetry(attempt + 1);
          } else {
            this.log.warn(`[${this.name}] 끄기 재시도 실패 — 포기: ${e.message}`);
          }
        });
    }, delay);
  }

  // v1.8.28 — OFF가 "이미 꺼짐"으로 흡수됐을 때의 오흡수 방어. 폴 10s+공유캐시 7s 창에서
  // 리모컨/HA(samsung_ac_local)로 방금 켜진 기기는 deviceState가 stale 'Off'라 끄기가 무시될
  // 수 있다(SmartAC v1.8.25에서 고친 결함의 LegacyAC 대응). 2초 뒤 강제 실측으로 검증하고,
  // 실제로 켜져 있으면 off를 재전송한다. 진짜 꺼진 기기에는 아무 PUT도 안 나가 '띠' 없음.
  _scheduleOffAbsorbVerify() {
    if (this._offVerifyTimer) clearTimeout(this._offVerifyTimer);
    const intentTs = this._offIntentTs;
    this._offVerifyTimer = setTimeout(async () => {
      this._offVerifyTimer = null;
      if (this._stopped) return;
      if (this._offIntentTs === 0 || this._offIntentTs !== intentTs) return; // ON/새 off가 끼어듦
      let onConfirmed = false;
      try {
        // v1.8.29 — forceFresh: in-flight/캐시 조인 없이 반드시 새 실측(의도 이전 스냅샷 오판 차단).
        // 새 GET은 직렬 큐에 얹혀 호출 시점 이후의 기기 상태를 읽으므로, 완료되면 항상 의도 이후 값.
        await this.getCachedState(true, 0, true);
        if (this._stopped) return;
        if (this._offIntentTs === 0 || this._offIntentTs !== intentTs) return;
        if (!(this._lastFetchTs > intentTs)) return; // 방어(정상 경로에선 항상 참)
        onConfirmed = this.deviceState?.Operation?.power === CONSTANTS.POWER.ON;
      } catch (e) {
        this.debugLog(`끄기 흡수 검증 실측 실패(무해 — 다음 폴이 보정): ${e.message}`);
        return;
      }
      if (!onConfirmed) return;
      // 실측이 '켜짐'을 확인 — 오흡수였다. off 재전송하되, 재전송 실패는 메인 경로처럼
      // _scheduleOffRetry(5s→15s 백오프)로 넘겨 "켜진 채 방치"를 막는다(v1.8.29 #2).
      this.log.warn(`[${this.name}] 끄기 흡수 후 실측 '켜짐' — stale 상태 오흡수였음, off 재전송(자가치유).`);
      try {
        await this.sendCommand('', { Operation: { power: CONSTANTS.POWER.OFF } });
        this._patchState(st => {
          st.Operation = st.Operation || {};
          st.Operation.power = CONSTANTS.POWER.OFF;
        });
        this._scheduleRefresh();
      } catch (e) {
        if (this._offIntentTs === intentTs) {
          this.log.warn(`[${this.name}] 끄기 흡수 검증 재전송 실패(${e.message}) — 재시도 예약.`);
          this._scheduleOffRetry();
        }
      }
    }, 2000);
  }

  _openOnGuard() {
    if (this._onGuardMs <= 0) return;
    if (this._onGuardTimer) clearTimeout(this._onGuardTimer);
    // v1.8.19 — 여기서 _deferredCommands를 비우지 않는다. _closeOnGuard(양 분기)와
    // _cancelAllPendingWrites가 항상 비우므로, 이 시점에 남아 있는 항목은 "지금 이 전원 ON의
    // in-flight 구간에 보류된 의도"뿐이다(예: Active 전송 중 TargetState의 /mode). 비우면
    // 'queue' 전략에서 그 의도가 윈도우 종료 후에도 발사되지 못하고 유실된다.
    this._onGuardUntil = Date.now() + this._onGuardMs;
    this.log.info(`[${this.name}] ON 보호 시작 — 이후 ${this._onGuardMs}ms 동안 다른 명령은 ${this._onGuardStrategy === 'queue' ? '큐잉됩니다.' : '무시됩니다.'}`);
    this._onGuardTimer = setTimeout(() => this._closeOnGuard('expired'), this._onGuardMs);
  }

  _closeOnGuard(reason) {
    if (this._onGuardTimer) {
      clearTimeout(this._onGuardTimer);
      this._onGuardTimer = null;
    }
    const wasActive = this._onGuardUntil > 0;
    this._onGuardUntil = 0;
    if (wasActive) this.log.info(`[${this.name}] ON 보호 종료 (${reason})`);

    if (reason !== 'expired') {
      // OFF 등 외부 사유로 닫힌 경우는 대기열을 모두 폐기.
      this._deferredCommands.clear();
      return;
    }
    if (this._onGuardStrategy === 'queue' && this._deferredCommands.size > 0) {
      const queued = Array.from(this._deferredCommands.values());
      this._deferredCommands.clear();
      this.log.info(`[${this.name}] ON 보호 큐 전송 — ${queued.length}개 명령`);
      // v1.8.25 — 재생 도중 OFF/취소가 오면 잔여 명령을 버린다. 큐를 이미 로컬로 복사해
      // _cancelAllPendingWrites의 맵 clear가 닿지 않으므로, 세대·마커·종료를 매 반복 재확인.
      const gen = this._powerOnResendGen;
      (async () => {
        for (const { endpoint, data } of queued) {
          if (this._stopped || gen !== this._powerOnResendGen || this._isOffSceneWindow()) {
            this.log.info(`[${this.name}] 보호 큐 재생 중단 (끄기/취소/종료) — 잔여 폐기`);
            return;
          }
          try { await this.sendCommand(endpoint, data); }
          catch (e) { this.log.warn(`[${this.name}] 보호 종료 후 명령 실패 (${endpoint}): ${e.message}`); }
        }
        this._scheduleRefresh();
      })().catch(() => {});
    } else {
      this._deferredCommands.clear();
    }
  }

  // v1.8.18/1.8.20 — 전원 ON 후속 재전송 체인. 보호 윈도우가 끝난 뒤 ① 설정 모드(hkCoolMode),
  // ② 그 2초 뒤 자동건조 ON을(각각 opt-in) 단독 PUT으로 순차 전송한다(F7 준수).
  // 주의: 여기서 deviceState 기반 idempotency 검사를 하면 안 된다 — _sendUnlessOnGuard가
  // drop된 명령도 patchFn으로 deviceState를 선-patch하므로, 실제로 전송되지 않은 값이
  // "이미 적용됨"으로 보여 재전송이 무산된다(이 기능이 잡으려는 바로 그 시나리오).
  _schedulePowerOnResends() {
    // v1.8.25 — 끄기 장면 창에서는 체인을 예약하지 않는다. 형제-먼저 순서에서 TargetState의
    // 전원 ON continuation이 Active=0 이후 체인을 재예약(gen 재발급)하는 유출 경로 차단 —
    // 체인의 자가중단은 deviceState 재조회에 의존하는데 stale 'On' 보고 시 뚫리기 때문에
    // 예약 시점에 막는 것이 확실하다. 정상 켜기(Active=1·TargetState 단독)는 마커가 0이라 무영향.
    if (this._isOffSceneWindow()) {
      this.debugLog('끄기 장면 창 — 전원 ON 후속 체인 예약 생략');
      return;
    }
    const steps = [];
    if (this._resendModeOnPowerOn && this.coolModeStr && this.coolModeStr !== 'none') {
      const mode = this.coolModeStr;
      steps.push({
        label: `모드(${mode})`,
        data: { modes: [mode] },
        patch: st => { st.Mode = st.Mode || {}; st.Mode.modes = [mode]; },
      });
    }
    if (this._resendAutoCleanOnPowerOn) {
      steps.push({
        label: '자동건조',
        data: { options: [CONSTANTS.AUTOCLEAN.ON] },
        patch: st => {
          st.Mode = st.Mode || {};
          const cur = Array.isArray(st.Mode.options) ? st.Mode.options : [];
          const filtered = cur.filter(o => o !== CONSTANTS.AUTOCLEAN.ON && o !== CONSTANTS.AUTOCLEAN.OFF);
          filtered.push(CONSTANTS.AUTOCLEAN.ON);
          st.Mode.options = filtered;
        },
      });
    }
    if (this._resendSwingOffOnPowerOn && this.swingBinding !== 'none') {
      const cmd = this.swingModeHandler.getCommand(false);
      const isWind = this.swingBinding === 'wind';
      steps.push({
        label: '스윙 끄기',
        endpoint: cmd.endpoint,
        data: cmd.data,
        patch: st => {
          if (isWind) {
            st.Wind = st.Wind || {};
            st.Wind.direction = CONSTANTS.SWING.FIX;
          } else {
            st.Mode = st.Mode || {};
            const cur = Array.isArray(st.Mode.options) ? st.Mode.options : [];
            const filtered = cur.filter(o => o !== CONSTANTS.COMFORT.NANO_ON && o !== CONSTANTS.COMFORT.NANO_OFF);
            filtered.push(CONSTANTS.COMFORT.NANO_OFF);
            st.Mode.options = filtered;
          }
        },
      });
    }
    if (steps.length === 0) return;
    const stepGapMs = Number.isFinite(this._powerOnResendStepMs)
      ? this._powerOnResendStepMs : CONSTANTS.POWER_ON_RESEND_STEP_MS;
    if (this._powerOnModeTimer) clearTimeout(this._powerOnModeTimer);
    this._powerOnResendGen += 1;
    const gen = this._powerOnResendGen;
    let idx = 0;
    const fire = (retried) => {
      this._powerOnModeTimer = null;
      if (this._stopped || gen !== this._powerOnResendGen) return;
      // Active/TargetState 중복 power-on 레이스로 윈도우가 재개장됐으면 남은 시간만큼 재대기
      if (this._isOnGuardActive()) {
        this._powerOnModeTimer = setTimeout(() => fire(retried), Math.max(this._onGuardUntil - Date.now(), 0) + 100);
        return;
      }
      if (this.deviceState?.Operation?.power !== CONSTANTS.POWER.ON) {
        // 주기 폴링이 윈도우 안에 끼어들면 firmware가 아직 반영 못한 'Off'로 deviceState가
        // 덮일 수 있다(이 firmware는 명령 반영이 ~2s 느림). v1.8.21 — 같은 캐시를 다시 읽는
        // 수동 대기(1s)는 폴링이 우연히 끼어들 때만 살아나 간헐 무산의 원인이었다(침실 실측).
        // 강제 조회 → 1초 대기 → 재판정을 최대 4회 — 느린 firmware에 반영 여유를 준다.
        // (v1.8.22: 2회→4회. 껐다가 ~20초 내 재켜기 시 이 벽걸이 firmware가 '켜짐' 보고까지
        //  8초+ 걸리는 사례가 실측되어 유예를 ~5-9초로 확대. HomeKit발 OFF는 타이머/세대로
        //  즉시 끊기므로 여기 오래 머물러도 안전하다.)
        if (retried < 4) {
          this.getCachedState(true).catch(() => {}).then(() => {
            if (this._stopped || gen !== this._powerOnResendGen) return;
            this._powerOnModeTimer = setTimeout(() => fire(retried + 1), 1000);
          });
          return;
        }
        // 4회 강제 조회 후에도 Off → 진짜 꺼짐. 침묵 취소가 진단을 어렵게 했으므로 로그를 남긴다.
        this.log.info(`[${this.name}] 전원 ON 후속 재전송 중단 — 기기 전원 Off 확인 (남은 단계: ${steps.slice(idx).map(s => s.label).join(', ')})`);
        return;
      }
      const step = steps[idx];
      this.log.info(`[${this.name}] 전원 ON 후속 재전송 (${idx + 1}/${steps.length}): ${step.label}`);
      this.sendCommand(step.endpoint || '/mode', step.data)
        .then(() => {
          if (this._stopped || gen !== this._powerOnResendGen) return;
          this._patchState(step.patch);
          idx += 1;
          if (idx < steps.length) {
            this._powerOnModeTimer = setTimeout(() => fire(0), stepGapMs);
          } else {
            this._scheduleRefresh();
          }
        })
        .catch(e => this.log.warn(`[${this.name}] 전원 ON 후속 재전송 실패 (${step.label}): ${e.message}`));
    };
    const delay = (this._onGuardMs > 0 ? this._onGuardMs : 2000) + 100;
    this._powerOnModeTimer = setTimeout(() => fire(0), delay);
  }

  // 보호 윈도우 동안 호출되면 명령을 발사하지 않고 endpoint별 마지막 의도만 보관.
  // 항상 _patchState로 in-memory를 갱신하므로 HomeKit UI는 일시적으로 사용자 의도값을 보이며,
  // 윈도우 종료 후 강제 refresh가 실제 기기 상태로 보정한다.
  // 참고: /mode 엔드포인트는 Swing/Lock/TargetState가 공유한다. 같은 키로 덮어쓰여도 각 setter가
  //       _mergeOptions를 통해 in-memory Mode.options를 누적 갱신하므로 마지막 페이로드에 모든
  //       의도 옵션이 포함되어 실제 데이터 손실은 없다.
  async _sendUnlessOnGuard(endpoint, data, patchFn) {
    // v1.8.25 — 끄기 장면 창에서는 송신도 patch도 하지 않는다(심층 방어). setter 입구 가드를
    // 우회하는 늦은 continuation(예: TargetState가 전원 ON 완료 후 /mode를 이어 보내는 경로)이
    // off 이후 명령 송신·deviceState/덤프 오염을 만드는 것을 여기서 최종 차단한다.
    if (this._isOffSceneWindow()) {
      this.debugLog(`끄기 장면 창 — ${endpoint} 송신/패치 생략`);
      return;
    }
    if (typeof patchFn === 'function') this._patchState(patchFn);
    // v1.8.19 — 전원 ON 전송이 아직 in-flight면 보호 윈도우가 곧 열릴 상황이므로 함께 보류한다.
    // (Active가 먼저 오고 TargetState가 중복 전원을 생략한 직후, 윈도우가 열리기 전의 짧은 틈으로
    //  /mode가 새어나가 firmware가 무시하는 것을 방지.)
    // 단 legacyOnGuardMs=0(보호 명시적 해제)이면 이 보류도 하지 않는다 — 그 설정에서는
    // _openOnGuard가 no-op이라 보류된 명령을 아무도 회수하지 못하고 그대로 유실된다.
    if (this._isOnGuardActive() || (this._onGuardMs > 0 && this._activeInFlight === CONSTANTS.POWER.ON)) {
      this._deferredCommands.set(endpoint, { endpoint, data, patchFn });
      if (this._onGuardStrategy === 'drop') {
        this.log.info(`[${this.name}] ON 보호 중 명령 무시: ${endpoint} -> ${JSON.stringify(data)}`);
      } else {
        this.debugLog(`ON 보호 큐에 추가: ${endpoint} -> ${JSON.stringify(data)}`);
      }
      return;
    }
    await this.sendCommand(endpoint, data);
  }

  // 여러 setter가 연달아 호출돼도 1회만 강제 refresh — 단, 보호 윈도우 중에는 윈도우 종료 후로 미룬다.
  // v1.8.11: 기존 500ms는 구형 AC 펌웨어가 명령을 반영하기 전에 fetch가 일어나 stale 상태로
  // patch 값을 덮어쓰는 회귀가 보고됨 ("스윙 끄면 잠깐 다시 켜졌다가 돌아옴"). 기기 반영 시간을
  // 충분히 확보하기 위해 기본값을 2000ms로 늘린다. LegacyAC는 외부 변경 채널이 없으므로
  // (로컬 TLS, 사용자 1명) 늦어도 무해하다.
  _scheduleRefresh(delayMs = 2000) {
    if (this._stopped) return;
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    const runAt = this._isOnGuardActive()
      ? Math.max(delayMs, this._onGuardUntil - Date.now() + 200)
      : delayMs;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      if (this._stopped) return;
      this.getCachedState(true).catch(e => this.debugLog(`refresh 실패: ${e.message}`));
    }, runAt);
  }

  // OFF 시 pending writes 모두 취소
  _cancelAllPendingWrites() {
    for (const t of this._pendingDebounces.values()) clearTimeout(t);
    this._pendingDebounces.clear();
    this._deferredCommands.clear();
    // 세대 증가 — 체인 단계가 send 중(타이머 없음)이어도 .then()이 다음 단계를 되살리지 못하게.
    this._powerOnResendGen += 1;
    if (this._powerOnModeTimer) {
      clearTimeout(this._powerOnModeTimer);
      this._powerOnModeTimer = null;
    }
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  // /mode 옵션 병합: 새 옵션이 충돌 키들과만 부딪치고, 다른 옵션은 보존
  _mergeOptions(newOptions, conflictKeys) {
    const current = this.deviceState?.Mode?.options || [];
    const conflict = new Set(conflictKeys);
    const preserved = current.filter(o => !conflict.has(o) && !newOptions.includes(o));
    return [...preserved, ...newOptions];
  }

  debugLog(msg) { if (this.debugMode) this.log.info(`[${this.name}] ${msg}`); }

  startPolling() {
    const interval = Number(this.pollingInterval);
    if (Number.isFinite(interval) && interval >= 1) {
      this.pollingInterval = interval;
      this.log.info(`[${this.name}] ${this.pollingInterval}초 간격으로 상태 폴링을 시작합니다.`);
      this._poll();
    }
  }

  async _poll() {
    if (this._stopped) return;
    this.debugLog('폴링 실행...');
    // v1.8.26 — 폴링은 공유 클라이언트의 최근 성공 응답(7초 내)을 재사용한다. 한 응답에 두 기기
    // 상태가 다 있으므로 거실/침실 폴이 실질 1회로 합쳐져 기기 TLS 부하가 절반이 된다.
    // 명령 후 강제 조회(getCachedState(true) 기본형)는 maxAge 없이 항상 실측.
    try {
      await this.getCachedState(true, CONSTANTS.POLL_SHARE_MAX_AGE_MS);
      if (this._pollFailStreak > 1) this.log.info(`[${this.name}] 폴링 복구 — 연속 ${this._pollFailStreak}회 실패 후 정상화`);
      this._pollFailStreak = 0;
    }
    catch (e) {
      // 로그 억제: 클라이언트가 스트릭 관리(첫 실패 상세 + 매 10회 1줄)를 하므로 여기는
      // 스트릭 첫 실패만 남기고 이후는 debug로 강등(무응답 30분 = 640줄 방지).
      this._pollFailStreak = (this._pollFailStreak || 0) + 1;
      if (this._pollFailStreak === 1) this.log.error(`[${this.name}] 폴링 중 오류: ${e.message}`);
      else this.debugLog(`폴링 중 오류(연속 ${this._pollFailStreak}회): ${e.message}`);
    }
    finally {
      if (this._stopped) return;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(() => this._poll(), this.pollingInterval * 1000);
    }
  }

  async getCachedState(force = false, maxAgeMs = 0, forceFresh = false) {
    const now = Date.now();
    if (!force && this.deviceState && (now - this.lastStateUpdate < this.cacheDuration)) {
      this.debugLog('캐시된 상태 사용');
      return this.deviceState;
    }
    if (this._stopped) return this.deviceState;   // 종료 후엔 새 네트워크 요청을 시작하지 않는다
    // v1.8.29 — forceFresh는 진행 중인 조회에 합류하지 않는다(그 조회는 끄기 의도 이전에
    // 시작됐을 수 있어 stale 스냅샷일 위험). 완전히 새 실측을 시작하고, 동시에 진행 중인
    // 일반 조회의 stateRequestPromise를 건드리지 않도록(clobber 방지) 자기 프라미스만 관리한다.
    if (!forceFresh && this.stateRequestPromise) return this.stateRequestPromise;
    const fetchPromise = (async () => {
      try {
        // v1.8.26 — maxAgeMs>0(폴링 전용)이면 공유 클라이언트의 최근 성공 응답을 재사용.
        const response = await this.client.getDeviceStatus(maxAgeMs, forceFresh);
        if (!response?.Devices?.[this.deviceIndex]) {
          throw new Error(`API 응답에 장치(index: ${this.deviceIndex})가 없습니다.`);
        }
        this.deviceState = response.Devices[this.deviceIndex];
        this.lastStateUpdate = Date.now();
        // fetchTs는 "기기에서 실제로 읽은 시각" — 캐시 서빙이면 그 원본 fetch 시각을 쓴다
        // (HA data_time 가드가 신선하지만 낡은 값을 신선하다고 믿지 않도록).
        this._lastFetchTs = this.client.lastStatusTs || this.lastStateUpdate;
        this._lastMutSrc = 'fetch';
        this._dumpState();
        return this.deviceState;
      } catch (e) {
        // 네트워크류는 클라이언트(_logFinalFailure)가 스트릭 관리와 함께 이미 기록 — 여기서 또
        // error를 내면 실패 1회당 로그가 배가된다(무응답 창 로그 폭증의 절반이 이 줄이었음).
        // 단 비네트워크 오류(응답 구조 이상 등 클라이언트가 성공으로 보는 것)는 여기서만 보이므로 유지.
        if (/시간 초과|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|EPIPE|TLS 소켓 오류/.test(e.message)) {
          this.debugLog(`상태 가져오기 오류: ${e.message}`);
        } else {
          this.log.error(`상태 가져오기 오류: ${e.message}`);
        }
        throw e;
      }
    })();
    // forceFresh 조회는 공유 대상이 아니므로 stateRequestPromise에 등록하지 않는다
    // (등록하면 finally에서 동시 진행 중인 일반 조회의 프라미스를 null로 지울 위험).
    if (!forceFresh) {
      this.stateRequestPromise = fetchPromise;
      fetchPromise.then(
        () => { if (this.stateRequestPromise === fetchPromise) this.stateRequestPromise = null; },
        () => { if (this.stateRequestPromise === fetchPromise) this.stateRequestPromise = null; }
      );
    }
    return fetchPromise;
  }

  async sendCommand(endpoint, data) {
    // v1.5.x 이전의 1.5초 sig dedupe은 정상적인 사용자 재시도까지 묵음 처리해
    // "켰는데 즉시 꺼져 보임" 깜빡임의 원인이 됐다. 직렬화는 _cmdMutex로 충분히 보장된다.
    // 네트워크 단절 시 mutex 체인이 무한히 쌓이지 않도록 동시 한도를 둔다.
    if (this._pendingCmdCount >= CONSTANTS.MAX_PENDING_COMMANDS) {
      this.log.warn(`[${this.name}] 명령 큐 초과(${this._pendingCmdCount}). 네트워크 단절 의심 — 새 명령을 거부합니다.`);
      throw new Error('명령 큐 초과 (네트워크 상태를 확인하세요)');
    }
    this._pendingCmdCount++;
    const job = async () => {
      try {
        this.log.info(`[${this.name}] 명령 전송: ${endpoint || '(root)'} -> ${JSON.stringify(data)}`);
        await this.client.sendCommand(this.setDeviceIndex, endpoint, data);
        await new Promise(r => setTimeout(r, 300));
      } finally {
        this._pendingCmdCount = Math.max(0, this._pendingCmdCount - 1);
      }
    };
    this._cmdMutex = this._cmdMutex.then(job, job);
    return this._cmdMutex;
  }

  // 명령 송신 직후, 다음 GET이 device 측 반영 이전 상태를 가져와 UI가 깜빡이는 것을 막기 위해
  // 보내려는 값으로 in-memory deviceState를 먼저 patch한다. 곧이어 force refresh로 보정.
  // 첫 부팅 등 deviceState가 아직 없으면 빈 셸을 만들어 patch가 무효화되지 않도록 한다.
  _patchState(patchFn) {
    try {
      if (!this.deviceState) this.deviceState = {};
      patchFn(this.deviceState);
      this.lastStateUpdate = Date.now();
      this._lastMutSrc = 'patch';
      this._dumpState(); // 낙관 선반영도 외부 소비자(HA)에 1~2초 내 보이도록
    } catch (e) {
      this.debugLog(`state patch 실패: ${e.message}`);
    }
  }

  // v1.8.23 — 상태 파일 덤프 (opt-in). 캐시 갱신·낙관 patch 시점마다 호출되며 1초 스로틀
  // (+trailing flush — 스로틀에 걸린 마지막 변경도 잔여시간 뒤 반드시 기록. 명령 직후의
  //  실측치가 다음 폴링까지 유실되지 않게 하고, 쓰기 체인을 직렬화해 tmp 충돌도 방지).
  // 소비자 계약: {schema:1, ts(쓰기 시각), src:'fetch'|'patch'(마지막 갱신 유래),
  //   fetchTs(마지막 실측 조회 시각 — HA data_time 가드는 이 값을 쓸 것),
  //   name, deviceIndex, state: deviceState 전체}.
  // ts가 60초 이상 뒤처지면 소비자는 unavailable로 취급할 것(홈브릿지 정지/기기 장기 오프라인).
  _dumpState() {
    if (!this._stateDumpFile || !this.deviceState) return;
    const now = Date.now();
    const since = now - this._lastStateDump;
    if (since < 1000) {
      if (!this._stateDumpTimer) {
        this._stateDumpTimer = setTimeout(() => {
          this._stateDumpTimer = null;
          if (this._stopped) return;
          this._dumpState();
        }, 1000 - since + 20);
      }
      return;
    }
    this._lastStateDump = now;
    let payload;
    try {
      payload = JSON.stringify({
        schema: 1,
        ts: now,
        src: this._lastMutSrc,
        fetchTs: this._lastFetchTs,
        name: this.name,
        deviceIndex: this.deviceIndex,
        state: this.deviceState,
      });
    } catch (e) {
      this.debugLog(`state dump 직렬화 실패: ${e.message}`);
      return;
    }
    const f = this._stateDumpFile;
    // tmp→rename 원자적 교체(소비자의 반쪽 읽기 방지). 전부 비동기 — HAP 경로 블로킹 없음.
    fs.writeFile(f + '.tmp', payload, err => {
      if (err) return this.debugLog(`state dump 쓰기 실패: ${err.message}`);
      fs.rename(f + '.tmp', f, err2 => {
        if (err2) this.debugLog(`state dump rename 실패: ${err2.message}`);
      });
    });
  }

  async _refreshState() {
    // 기기 측 반영을 기다린 뒤 강제 갱신해 in-memory patch와 실측치를 맞춘다.
    await new Promise(r => setTimeout(r, 500));
    if (this._stopped) return;
    await this.getCachedState(true);
  }

  _createGetter(name, extractor) {
    return async () => {
      this.debugLog(`GET ${name}`);
      // 1) 이미 알고 있는 상태가 있으면 즉시 그 값으로 응답한다(네트워크 블로킹 X).
      //    AC가 오프라인(EHOSTUNREACH/timeout)일 때 read handler 안에서 LAN 요청을 기다리면
      //    Homebridge가 "read handler ... was slow to respond"로 경고하고 HomeKit이 멈칫한다.
      //    캐시가 오래됐으면 백그라운드로만 새로고침을 던지고(응답은 막지 않음), 폴링도 갱신을 돕는다.
      // 알고 있는 상태가 너무 오래되지 않았으면(STALE_HARD_CAP 이내) 즉답한다. 오프라인이 길어져
      // 백그라운드 새로고침이 계속 실패하면 lastStateUpdate가 늙어 cap을 넘고, 그때는 옛 값을
      // 계속 보여주는 대신 통신오류(no-response)로 정직하게 표시한다(아래 강제 조회 경로로 폴백).
      const age = Date.now() - this.lastStateUpdate;
      if (this.deviceState && age < CONSTANTS.STALE_HARD_CAP_MS) {
        if (age >= this.cacheDuration) {
          this.getCachedState(true).catch(e => this.debugLog(`백그라운드 새로고침 실패: ${e.message}`));
        }
        try {
          const value = extractor(this.deviceState);
          this.debugLog(`> ${name}: ${value}`);
          return value;
        } catch (_) { /* 캐시 형태가 안 맞으면 아래에서 강제 조회 */ }
      }
      // 2) 아직 한 번도 상태를 못 받았으면(부팅 직후/계속 오프라인) 한 번 시도하고,
      //    실패하면 plain Error를 던지지 않고 HapStatusError로 변환한다 — 안 그러면 Homebridge가
      //    "Unhandled error thrown inside read handler"로 시끄럽게 기록한다.
      try {
        // cap 초과(또는 캐시 없음) → 반드시 실제 fetch 한다(force=true). force 없이는 cacheDuration 을
        // STALE_HARD_CAP_MS 보다 크게 설정한 경우 getCachedState 가 그대로 stale 캐시를 돌려줘 cap 이
        // 무력화된다(옛 값 무한정 표시). force 면 새 값을 받거나, 실패 시 아래 catch 로 통신오류 처리된다.
        const state = await this.getCachedState(true);
        const value = extractor(state);
        this.debugLog(`> ${name}: ${value}`);
        return value;
      } catch (e) {
        this.debugLog(`GET ${name} 통신 실패(HAP 통신오류로 보고): ${e.message}`);
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    };
  }

  setupCharacteristics() {
    const C = this.Characteristic;
    const s = this.aircoService;

    s.getCharacteristic(C.Active)
      .onGet(this._createGetter('Active', state => state.Operation?.power === CONSTANTS.POWER.ON ? 1 : 0))
      .onSet(async (value) => {
        this.log.info(`[${this.name}] SET Active -> ${value}`);
        const targetPower = value ? CONSTANTS.POWER.ON : CONSTANTS.POWER.OFF;
        // v1.8.24 — 끄기 장면 마커. 아래의 흡수/idempotency 조기 return보다 먼저 세운다:
        // 기기가 이미 꺼져 있어 off 명령이 생략되는 밤에도 장면의 형제 write(온도 등)는
        // 그대로 도착하므로, 마커 없이는 그 write가 꺼진 기기를 켤 수 있다.
        this._offIntentTs = value === 0 ? Date.now() : 0;
        // v1.8.28 — OFF 의도는 아래 흡수/idempotency 결과와 무관하게 보호 윈도우·보류 큐를
        // 항상 정리한다. 이전엔 "이미 Off" 흡수 경로가 취소를 건너뛰어, stale 'Off'로 흡수될 때
        // 살아 있던 ON 후속 체인/디바운스가 뒤늦게 재점등시킬 수 있었다.
        if (value === 0) {
          this._closeOnGuard('user-off');
          this._cancelAllPendingWrites();
        }
        // 진행 중인 같은 목표의 명령이 있으면 두 번째 탭을 흡수해 중복 송신을 막는다.
        // (멀티 홈허브에서 두 사용자가 거의 동시에 같은 토글을 누르는 경우 등)
        if (this._activeInFlight === targetPower) {
          this.debugLog(`Active 진행 중(${targetPower}) — 중복 탭 흡수`);
          return;
        }
        const currentPower = this.deviceState?.Operation?.power;
        // v1.8.24 — 반대 방향 전원 명령이 in-flight면 idempotency를 건너뛰지 않는다.
        // 끄기 장면이 TargetState 먼저 도착하는 순서에서: TargetState가 ON을 전송 중일 때
        // Active=0이 오면 deviceState는 아직 'Off'(patch 전)라 예전 코드는 OFF를 "이미 Off"로
        // 흡수 → 기기가 켜진 채 밤을 남. 반대 명령 뒤에 큐잉해 최종 상태를 의도대로 보장한다.
        const opposite = value === 0 ? CONSTANTS.POWER.ON : CONSTANTS.POWER.OFF;
        if (currentPower === targetPower && this._activeInFlight !== opposite) {
          this.debugLog(`Active 이미 ${targetPower} — 명령 생략`);
          // v1.8.28 — deviceState가 stale 'Off'(리모컨/HA로 방금 켠 기기를 폴 10s+공유캐시 7s가
          // 아직 못 봄)여서 오흡수됐을 가능성을 실측으로 검증한다. SmartAC는 v1.8.25에서
          // "OFF 항상 전송"으로 풀었지만, 구형은 꺼진 기기에 중복 off PUT을 보내면 수신음('띠')
          // 우려가 있어 "생략 후 검증·틀렸으면 재전송"으로 같은 보장을 무음으로 달성한다.
          if (value === 0) this._scheduleOffAbsorbVerify();
          return;
        }
        this._activeInFlight = targetPower;
        try {
          if (value === 0) {
            // (보호 윈도우·디바운스/큐 취소는 위에서 이미 수행)
            await this.sendCommand('', { Operation: { power: CONSTANTS.POWER.OFF } });
            this._patchState(st => {
              st.Operation = st.Operation || {};
              st.Operation.power = CONSTANTS.POWER.OFF;
            });
            this._scheduleRefresh();
            return;
          }
          // ON: power:On 단독 발사 후 보호 윈도우 시작
          await this.sendCommand('', { Operation: { power: CONSTANTS.POWER.ON } });
          this._patchState(st => {
            st.Operation = st.Operation || {};
            st.Operation.power = CONSTANTS.POWER.ON;
          });
          this._openOnGuard();
          this._schedulePowerOnResends();
          this._scheduleRefresh();
        } catch (e) {
          this.log.error(`SET Active 오류:`, e.message);
          // v1.8.26 — 끄기 전송 실패는 방치하면 밤새 켜짐(무인 자동화가 특히 취약).
          // off는 멱등이라 5초 뒤 1회만 재시도한다(그 사이 ON 의도가 오면 자동 취소).
          if (value === 0) this._scheduleOffRetry();
          throw e;
        } finally {
          // 같은 인스턴스 변수를 본 다음 탭이 같은 target이면 흡수, 다른 target이면 통과.
          if (this._activeInFlight === targetPower) this._activeInFlight = null;
        }
      });

    s.getCharacteristic(C.CurrentHeaterCoolerState)
      .setProps({ validValues: [
        C.CurrentHeaterCoolerState.INACTIVE,
        C.CurrentHeaterCoolerState.IDLE,
        C.CurrentHeaterCoolerState.COOLING
      ] })
      .onGet(this._createGetter('CurrentState', state => {
        if (state.Operation?.power !== CONSTANTS.POWER.ON) return C.CurrentHeaterCoolerState.INACTIVE;
        return C.CurrentHeaterCoolerState.COOLING;
      }));

    s.getCharacteristic(C.TargetHeaterCoolerState)
      .setProps({ validValues: [C.TargetHeaterCoolerState.COOL] })
      .onGet(() => C.TargetHeaterCoolerState.COOL)
      .onSet(async (value) => {
        this.log.info(`[${this.name}] SET TargetState -> ${value}`);
        // v1.8.24 — 끄기 장면의 스냅샷 write: 이 setter는 "꺼져 있으면 ON을 보내는" 설계라
        // 가드가 없으면 끄기 장면이 플러그인 스스로 기기를 재점등시킨다. 통째로 스킵.
        if (this._isOffSceneWindow()) {
          this.debugLog('TargetState: 끄기 장면 창 — 송신 생략');
          return;
        }
        try {
          const currentlyOn = this.deviceState?.Operation?.power === CONSTANTS.POWER.ON;
          // 꺼진 상태에서 TargetState를 받으면 ON을 보내고 보호 윈도우를 연다.
          // 이때 /mode 명령은 보호 윈도우에 의해 자연스럽게 가드된다 ('drop' 기본).
          if (!currentlyOn) {
            // v1.8.19 — HomeKit이 켤 때 Active와 TargetState를 함께 보내면 두 경로가 전원 ON을
            // 각각 전송해 기기가 수신음('띠')을 두 번 냈다. Active 경로가 이미 전송 중이면 생략
            // (보호 윈도우/후속 모드 재전송은 그 경로가 담당). in-flight 표식은 Active와 공유.
            if (this._activeInFlight === CONSTANTS.POWER.ON) {
              this.debugLog('TargetState: 전원 ON 전송 중(Active) — 중복 전원 명령 생략');
            } else {
              this._activeInFlight = CONSTANTS.POWER.ON;
              try {
                await this.sendCommand('', { Operation: { power: CONSTANTS.POWER.ON } });
                this._patchState(st => {
                  st.Operation = st.Operation || {};
                  st.Operation.power = CONSTANTS.POWER.ON;
                });
                this._openOnGuard();
                this._schedulePowerOnResends();
              } finally {
                if (this._activeInFlight === CONSTANTS.POWER.ON) this._activeInFlight = null;
              }
            }
          }
          // 모드 idempotency: 이미 같은 모드면 명령 생략
          const currentModes = this.deviceState?.Mode?.modes || [];
          if (this.coolModeStr && this.coolModeStr !== 'none' &&
              !(currentModes.length === 1 && currentModes[0] === this.coolModeStr)) {
            await this._sendUnlessOnGuard('/mode', { modes: [this.coolModeStr] }, st => {
              st.Mode = st.Mode || {};
              st.Mode.modes = [this.coolModeStr];
            });
          }
          this._scheduleRefresh();
        } catch (e) {
          this.log.error(`SET TargetState 오류:`, e.message);
          throw e;
        }
      });

    s.getCharacteristic(C.CurrentTemperature)
      .onGet(this._createGetter('CurrentTemp', state => state.Temperatures?.[0]?.current ?? 18));

    // 슬라이더 드래그: trailing-debounce(400ms) + 보호 윈도우 인지.
    // 주의: setter에서 deviceState를 미리 patch하면 flush 시 idempotency가 자기 자신과 비교되어
    //       명령이 항상 생략되는 버그가 있었다(v1.7.0~v1.7.1). 따라서 patch는 _sendUnlessOnGuard
    //       내부에서 송신 시점에만 수행한다.
    let pendingTempValue = null;
    let lastSentDesired = null; // 마지막으로 송신했거나 디바이스 실측에서 알려진 desired
    const flushTempSet = async () => {
      this._pendingDebounces.delete('temp');
      const value = pendingTempValue;
      pendingTempValue = null;
      // v1.8.24 — 끄기 장면의 온도 스냅샷(디바운스 400ms 뒤 도착)은 송신하지 않는다.
      if (this._isOffSceneWindow()) {
        this.debugLog(`TargetTemp ${value}: 끄기 장면 창 — 송신 생략`);
        return;
      }
      // 디바이스 실측 desired와 비교. 같은 값을 다시 보내지 않는다.
      // v1.8.28 — lastSent만으로 생략하면 리모컨/HA로 값이 바뀐 뒤 홈킷에서 "원래 값으로
      // 되돌리기"가 영구 무시된다(24→리모컨 26→홈킷 24 = lastSent 24라 생략). lastSent와
      // 실측이 **둘 다** 목표값과 같을 때만 생략한다(실측 미상이면 멱등 쓰기라 그냥 보냄).
      const deviceDesired = this.deviceState?.Temperatures?.[0]?.desired;
      const sentMatches = lastSentDesired == null || lastSentDesired === value;
      if (deviceDesired === value && sentMatches) {
        this.debugLog(`TargetTemp 이미 ${value} — 명령 생략`);
        return;
      }
      try {
        await this._sendUnlessOnGuard('/temperatures/0', { desired: value }, st => {
          if (!Array.isArray(st.Temperatures)) st.Temperatures = [{ }];
          if (!st.Temperatures[0]) st.Temperatures[0] = {};
          st.Temperatures[0].desired = value;
        });
        lastSentDesired = value;
        this._scheduleRefresh();
      } catch (e) {
        this.log.error(`SET TargetTemp 오류:`, e.message);
      }
    };
    s.getCharacteristic(C.CoolingThresholdTemperature)
      .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
      .onGet(this._createGetter('TargetTemp', state => state.Temperatures?.[0]?.desired ?? this.minTemp))
      .onSet(async (value) => {
        this.log.info(`[${this.name}] SET TargetTemp -> ${value}`);
        pendingTempValue = value;
        const existing = this._pendingDebounces.get('temp');
        if (existing) clearTimeout(existing);
        this._pendingDebounces.set('temp', setTimeout(flushTempSet, 400));
      });

    if (this.swingBinding !== 'none' && !this._hideSwingToggle) {
      s.getCharacteristic(C.SwingMode)
        .onGet(this._createGetter('SwingMode', state => this.swingModeHandler.getValue(state) ? 1 : 0))
        .onSet(async (value) => {
          this.log.info(`[${this.name}] SET SwingMode -> ${value}`);
          // v1.8.24 — 끄기 장면의 스윙 스냅샷은 송신하지 않는다.
          if (this._isOffSceneWindow()) {
            this.debugLog('SwingMode: 끄기 장면 창 — 송신 생략');
            return;
          }
          try {
            // Idempotency: 이미 같은 값이면 명령 생략
            const currentValue = this.swingModeHandler.getValue(this.deviceState) ? 1 : 0;
            if (currentValue === value) {
              this.debugLog(`SwingMode 이미 ${value} — 명령 생략`);
              return;
            }
            if (this.swingBinding === 'wind') {
              // /wind 엔드포인트: 다른 옵션과 충돌 없음
              const direction = value === 1 ? CONSTANTS.SWING.UP_DOWN : CONSTANTS.SWING.FIX;
              await this._sendUnlessOnGuard('/wind', { direction }, st => {
                st.Wind = st.Wind || {};
                st.Wind.direction = direction;
              });
            } else {
              // v1.8.8: comfort 바인딩도 Lock과 동일하게 단일 옵션으로 발사 (v1.6.x 동작 복원).
              // 거실 에어컨에서 무풍제어가 작동하지 않는 회귀가 보고됨 — _mergeOptions로 다른 옵션과
              // 함께 발사하면 일부 구형 펌웨어가 명령을 무시한다.
              const newOpt = value === 1 ? CONSTANTS.COMFORT.NANO_ON : CONSTANTS.COMFORT.NANO_OFF;
              await this._sendUnlessOnGuard('/mode', { options: [newOpt] }, st => {
                st.Mode = st.Mode || {};
                const cur = Array.isArray(st.Mode.options) ? st.Mode.options : [];
                const filtered = cur.filter(o => o !== CONSTANTS.COMFORT.NANO_ON && o !== CONSTANTS.COMFORT.NANO_OFF);
                filtered.push(newOpt);
                st.Mode.options = filtered;
              });
            }
            this._scheduleRefresh();
          } catch (e) { this.log.error(`SET SwingMode 오류:`, e.message); throw e; }
        });
    } else if (s.testCharacteristic(C.SwingMode)) {
      s.removeCharacteristic(s.getCharacteristic(C.SwingMode));
    }

    if (this.lockBinding !== 'none' && !this._hideLockToggle) {
      s.getCharacteristic(C.LockPhysicalControls)
        .onGet(this._createGetter('LockControls', state =>
          state.Mode?.options?.includes(CONSTANTS.AUTOCLEAN.ON) ? 1 : 0))
        .onSet(async (value) => {
          this.log.info(`[${this.name}] SET LockControls -> ${value}`);
          // v1.8.24 — 끄기 장면의 잠금(자동건조) 스냅샷은 송신하지 않는다.
          if (this._isOffSceneWindow()) {
            this.debugLog('LockControls: 끄기 장면 창 — 송신 생략');
            return;
          }
          try {
            const opt = value ? CONSTANTS.AUTOCLEAN.ON : CONSTANTS.AUTOCLEAN.OFF;
            // v1.8.7: 일부 구형 펌웨어가 `/mode {options:[...]}`에 여러 항목이 섞이면
            // 자동건조 명령을 무시하는 회귀가 보고됨. v1.7.0의 _mergeOptions를 거치지 않고
            // Autoclean 옵션만 단독으로 발사한다 (v1.6.x 동작 복원).
            // in-memory state는 in-place로 갱신해 UI 일관성은 유지.
            await this._sendUnlessOnGuard('/mode', { options: [opt] }, st => {
              st.Mode = st.Mode || {};
              const cur = Array.isArray(st.Mode.options) ? st.Mode.options : [];
              const filtered = cur.filter(o => o !== CONSTANTS.AUTOCLEAN.ON && o !== CONSTANTS.AUTOCLEAN.OFF);
              filtered.push(opt);
              st.Mode.options = filtered;
            });
            this._scheduleRefresh();
          } catch (e) { this.log.error(`SET LockControls 오류:`, e.message); throw e; }
        });
    } else if (s.testCharacteristic(C.LockPhysicalControls)) {
      s.removeCharacteristic(s.getCharacteristic(C.LockPhysicalControls));
    }
  }
}

module.exports = LegacyAC;
