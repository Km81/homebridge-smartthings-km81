'use strict';

// 안티주름(wrinklePrevent), 에어드라이, 사전세탁 등 — Phase D 분석에서 발견된 누락 상태를 추가.
// 이전엔 안티주름 중에 active=false가 되어 종료 알림이 오발사되는 문제가 있었다 (DV90B6800 등).
const ACTIVE_JOB_STATES = new Set([
  // 공통 / 사전 단계
  'preWash', 'weightSensing',
  // Dryer
  'running', 'drying', 'cooling', 'refresh', 'airDry',
  'wrinklePrevent', 'wrinkleCare',
  // Washer
  'washing', 'rinse', 'spin', 'detergentSupply', 'soaking', 'soak'
]);
// machineState 기반 활성 판정.
// 'on'은 단순히 전원이 켜진 대기 상태일 뿐 실제 운전이 아니므로 active로 보지 않는다.
// (v1.8.3 fix: 운전 종료 후에도 machineState='on'이 보고되어 active가 영구 유지되던 버그)
const ACTIVE_MACHINE_STATES = new Set(['run']);
// 운전 종료를 명확히 지시하는 jobState — 이 값이 보고되면 machineState와 관계없이 비활성.
// 'error'는 사이클이 강제 중단된 상태이므로 종료로 간주(사용자에게 알림 발사).
const FINISHED_JOB_STATES = new Set(['none', 'finished', 'stop', 'end', 'error']);
// 일시정지/대기성 machineState (전원은 켜져있지만 운전은 안 함)
const IDLE_MACHINE_STATES = new Set(['on', 'wakeUp', 'standby', 'off']);
// 실제로 cycle 후 동작 중인 단계들 — machineState가 idle이라도 이 jobState면 RUNNING 유지.
// (안티주름은 드럼이 간헐 회전하므로 machineState='on'으로 보고하는 모델이 존재)
const POST_CYCLE_ACTIVE_JOB_STATES = new Set([
  'wrinklePrevent', 'wrinkleCare', 'refresh', 'airDry',
]);

const COMPLETION_PULSE_MS = 10 * 1000;
const DEFAULT_SENSOR_POLL_SEC = 30;
const HK_REMAINING_DURATION_MAX = 3600;
// 폴링 연속 실패 시 backoff (오류 누적되어도 30초마다 hammering하지 않도록).
const POLL_BACKOFF_THRESHOLD = 3;
const POLL_BACKOFF_MAX_SEC = 300;

// 운전 상태 분류 — v1.8.5에서 도입.
// 일시정지를 RUNNING/FINISHED와 분리해 종료 펄스 오발사를 막는다.
const STATE = {
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  FINISHED: 'FINISHED',
  UNKNOWN: 'UNKNOWN',
};

// 로그 표기용 한글 이름 (v2.1.0 — 시인성)
const STATE_KO = {
  RUNNING: '동작중',
  PAUSED: '일시정지',
  FINISHED: '완료',
  UNKNOWN: '알수없음',
};
const stateKo = (s) => STATE_KO[s] || s;

function pickOperatingState(component) {
  if (!component) return null;
  return (
    component.samsungce?.dryerOperatingState ||
    component.samsungce?.washerOperatingState ||
    component.dryerOperatingState ||
    component.washerOperatingState ||
    null
  );
}

function _readJobAndMachineState(component) {
  const op = pickOperatingState(component);
  if (!op) return { jobState: null, machineState: null };
  const jobState = op.dryerJobState?.value || op.washerJobState?.value || null;
  const machineState = op.machineState?.value || null;
  return { jobState, machineState };
}

// 단일 컴포넌트를 3-상태로 분류한다.
// 분류 우선순위 (v1.8.5):
//   1. 명시적 종료 jobState (none/finished/stop/end) → FINISHED
//   2. machineState='stop' → FINISHED
//   3. machineState ∈ {on, wakeUp, standby, off} && jobState가 active set에 없음 → FINISHED
//   4. machineState='pause' → PAUSED
//   5. machineState='run' → RUNNING
//   6. machineState 없음 + jobState ∈ ACTIVE_JOB_STATES → RUNNING (구형 모델 대비)
//   7. 그 외 → UNKNOWN (정보 부족 — 이전 상태 유지)
function classifyComponent(component) {
  const { jobState, machineState } = _readJobAndMachineState(component);
  if (!jobState && !machineState) return STATE.UNKNOWN;

  if (jobState && FINISHED_JOB_STATES.has(jobState)) return STATE.FINISHED;
  if (machineState === 'stop') return STATE.FINISHED;
  if (machineState && IDLE_MACHINE_STATES.has(machineState)) {
    // 대기 상태(`on`/`standby`/`wakeUp`/`off`)는 보통 종료를 의미하지만,
    // 안티주름 등 cycle 후 단계는 machineState가 idle로 떨어진 채로 jobState가 active를 유지한다.
    // 사용자 모델의 stale `weightSensing` 같은 pre-cycle 상태와는 구분되어야 하므로
    // POST_CYCLE_ACTIVE_JOB_STATES 멤버일 때만 RUNNING으로 본다.
    if (jobState && POST_CYCLE_ACTIVE_JOB_STATES.has(jobState)) return STATE.RUNNING;
    return STATE.FINISHED;
  }
  if (machineState === 'pause') return STATE.PAUSED;
  if (machineState === 'run') return STATE.RUNNING;

  // machineState가 없는 모델 — jobState로 fallback.
  if (jobState && ACTIVE_JOB_STATES.has(jobState)) return STATE.RUNNING;
  return STATE.UNKNOWN;
}

// main + sub 컴포넌트 분류를 합친다. 우선순위: RUNNING > PAUSED > FINISHED > UNKNOWN.
function combineStates(...states) {
  if (states.includes(STATE.RUNNING)) return STATE.RUNNING;
  if (states.includes(STATE.PAUSED)) return STATE.PAUSED;
  if (states.includes(STATE.FINISHED)) return STATE.FINISHED;
  return STATE.UNKNOWN;
}

// 기존 호환성을 위한 wrapper — 외부 호출자 (없지만 안전을 위해 유지).
function isComponentActive(component) {
  return classifyComponent(component) === STATE.RUNNING;
}

// null 반환 = "잔여 시간 정보 없음" (운전 시작 직후 SmartThings가 아직 데이터를 안 줄 때).
// 0 반환 = "확실히 0초" (사용 안 함). 호출자가 두 경우를 구분해 stale duration을 보존할 수 있다.
function getComponentDuration(component) {
  const op = pickOperatingState(component);
  if (!op) return null;

  const remainingMin = op.remainingTime?.value;
  if (typeof remainingMin === 'number' && remainingMin > 0) {
    return remainingMin * 60;
  }

  const completionTimeStr = op.completionTime?.value;
  if (completionTimeStr) {
    const remainingSec = Math.round((new Date(completionTimeStr) - Date.now()) / 1000);
    return remainingSec > 0 ? remainingSec : 0;
  }

  const timeStr = op.remainingTimeStr?.value;
  if (typeof timeStr === 'string' && timeStr.includes(':')) {
    const [minStr, secStr] = timeStr.split(':');
    const min = parseInt(minStr) || 0;
    const sec = parseInt(secStr) || 0;
    return min * 60 + sec;
  }

  return null;
}

class Laundry {
  constructor({ log, api, smartthings, platform, deviceKind /* 'washer' | 'dryer' */ }) {
    this.log = log;
    this.api = api;
    this.smartthings = smartthings;
    this.platform = platform;
    this.deviceKind = deviceKind;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.UUIDGen = api.hap.uuid;
  }

  configure(accessory, configDevice, packageVersion) {
    const C = this.Characteristic;
    accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'Samsung')
      .setCharacteristic(C.Model, configDevice.model || (this.deviceKind === 'dryer' ? 'Dryer' : 'Washer'))
      .setCharacteristic(C.SerialNumber, configDevice.serialNumber || accessory.context.device.deviceId)
      .setCharacteristic(C.FirmwareRevision, packageVersion);

    // ★v2.4.0 — 2-in-1 세탁기(애드워시+콤팩트워시)를 홈킷에 어떻게 보일지 선택한다.
    //   splitCompartments=false(기본) : 지금까지처럼 **하나로 합침**.
    //                                   둘 중 하나라도 돌면 '가동 중'(combineStates).
    //   splitCompartments=true        : 두 세탁조를 **각각 액세서리로** 등록한다.
    // 분리를 껐을 때 보조 액세서리는 activeUUIDs에 넣지 않으므로 index.js의 stale 정리가
    // 자동으로 지운다(재시작 1회로 원복).
    const device = accessory.context.device;
    const split = configDevice.splitCompartments === true;
    const baseLabel = device.label;

    /** @type {Array<{key:string,label:string,valve:any,sensor:any,state:object,prev:any,unknownCarry:number,pulseTimer:any}>} */
    this.units = [];

    const mkUnit = (key, label, acc) => {
      const unit = {
        key,
        label,
        // 폴링이 갱신하는 상태 (get 핸들러도 이 값을 즉답하여 push와 일관성 유지).
        // v1.8.5: state는 3-상태 분류값을 그대로 보관해 Valve.Active(RUNNING ∪ PAUSED)와
        //         InUse(RUNNING)를 분리 표현한다.
        state: { active: false, duration: 0, state: STATE.UNKNOWN },
        prev: null,
        unknownCarry: 0,
        // 이 유닛이 평소 정보를 받아 온 구획 수. 이보다 줄면 "부분 응답"으로 보고
        // 종료 판정을 미룬다(적대 감사 F-1). 1조 기기는 늘 1이라 영향 없음.
        maxInformative: 0,
        pulseTimer: null,
      };
      unit.valve = this._setupValveService(acc, unit);
      unit.sensor = this._setupNotificationSensor(acc, configDevice, packageVersion, unit);
      this.units.push(unit);
      return unit;
    };

    // HAP가 거부할 수 있는 특수문자를 제거(센서 이름과 같은 규칙). 빈 문자열이 되면 폴백을 쓴다.
    const sanitizeName = (s) => String(s || '').replace(/[^\p{L}\p{N}\s\-]/gu, '').trim().substring(0, 64);

    if (!split) {
      mkUnit('combined', baseLabel, accessory);
    } else {
      let mainName = sanitizeName(configDevice.mainCompartmentName) || `${baseLabel} 메인`;
      let subName = sanitizeName(configDevice.subCompartmentName) || `${baseLabel} 보조`;
      // 두 조 이름이 같으면 홈킷에서 구분이 안 된다 — 보조에 표식을 붙여 강제로 갈라 놓는다.
      if (mainName === subName) {
        subName = `${subName} 보조`;
        this.log.warn(`[${baseLabel}] 두 세탁조 이름이 같아 보조를 '${subName}'로 바꿨습니다.`);
      }
      // 메인은 **기존 액세서리를 그대로 재사용**한다(홈킷 재페어링·자동화 파손 방지).
      accessory.displayName = mainName;
      mkUnit('main', mainName, accessory);
      const subAcc = this._ensureAccessory(device, 'compartment:sub', subName, configDevice, packageVersion);
      mkUnit('sub', subName, subAcc);
      this.log.info(`[${baseLabel}] 세탁조 분리 노출 — '${mainName}' / '${subName}'`);
    }

    // 하위 호환: 예전 코드가 참조하던 단일 상태는 첫 유닛을 가리키게 둔다.
    this._state = this.units[0].state;

    this._startPolling(accessory, configDevice, this.units);
  }

  /** 보조 세탁조처럼 부가 액세서리가 필요할 때 찾거나 만든다. */
  _ensureAccessory(device, keySuffix, displayName, configDevice, packageVersion) {
    const uuid = this.UUIDGen.generate(`${device.deviceId}:${keySuffix}`);
    let acc = this.platform.accessories.find(a => a.UUID === uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(displayName, uuid);
      acc.context.device = device;
      this.api.registerPlatformAccessories(this.platform.PLUGIN_NAME, this.platform.PLATFORM_NAME, [acc]);
      this.platform.accessories.push(acc);
    } else {
      acc.displayName = displayName;
      acc.context.device = device;
    }
    this.platform.activeUUIDs.add(uuid);

    const C = this.Characteristic;
    const info = acc.getService(this.Service.AccessoryInformation) || acc.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(C.Manufacturer, 'Samsung')
      .setCharacteristic(C.Model, configDevice.model || (this.deviceKind === 'dryer' ? 'Dryer' : 'Washer'))
      .setCharacteristic(C.SerialNumber, `${device.deviceId}-${keySuffix}`)
      .setCharacteristic(C.FirmwareRevision, packageVersion);
    return acc;
  }

  _bindCharacteristic({ service, characteristic, getter }) {
    const C = this.Characteristic;
    // ★특성 이름은 **인스턴스**(`char`)에서 읽는다. 인자로 넘어오는 `characteristic`은

    //   HAP 특성 **클래스**(예: `C.Active`)라 `displayName`이 없어 로그에 `undefined`가 찍힌다.

    //   실제로 다른 사용자 로그에서 `[아기방 에어컨] undefined GET 오류`로 관측됐다(2026-07-30).

    const char = service.getCharacteristic(characteristic);
    char.removeAllListeners('get');
    char.on('get', async (callback) => {
      try {
        const value = await getter();
        callback(null, value);
      } catch (e) {
        this.log.error(`[${service.displayName}] '${char.displayName}' GET 오류: ${e.message}. 기본값으로 처리합니다.`);
        switch (characteristic) {
          case C.Active: return callback(null, C.Active.INACTIVE);
          case C.InUse: return callback(null, C.InUse.NOT_IN_USE);
          case C.RemainingDuration: return callback(null, 0);
          default: return callback(e);
        }
      }
    });
  }

  _setupValveService(accessory, unit) {
    const C = this.Characteristic;
    const Perms = this.api.hap.Perms;
    const service = accessory.getService(this.Service.Valve) ||
      accessory.addService(this.Service.Valve, accessory.displayName);
    service.setCharacteristic(C.ValveType, C.ValveType.IRRIGATION);
    // 분리 모드에서 액세서리 이름이 바뀌면 서비스 이름도 따라가야 홈 앱 표시가 일치한다.
    service.setCharacteristic(C.Name, accessory.displayName);
    const st = unit.state;

    // HomeKit 표준 최대값은 3600초이므로 cap 처리
    service.getCharacteristic(C.RemainingDuration)
      .setProps({ maxValue: HK_REMAINING_DURATION_MAX });

    // SetDuration이 있어야 Home 앱이 잔여 시간 카운트다운을 렌더링함(없으면 "대기 중..." 고착).
    // Home 앱이 HIDDEN을 무시해 슬라이더는 노출되지만, 쓰기 권한을 제거해 조작은 무효 처리한다.
    service.getCharacteristic(C.SetDuration)
      .setProps({
        maxValue: HK_REMAINING_DURATION_MAX,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY, Perms.HIDDEN],
      });

    // get 핸들러는 폴링이 들고 있는 최신 상태를 즉답 (push 값과 항상 일치).
    // Valve.Active: 사이클이 로드된 상태(RUNNING ∪ PAUSED).
    // InUse: 실제로 동작 중인 상태(RUNNING).
    this._bindCharacteristic({
      service,
      characteristic: C.Active,
      getter: async () => {
        const s = st.state;
        return (s === STATE.RUNNING || s === STATE.PAUSED) ? C.Active.ACTIVE : C.Active.INACTIVE;
      },
    });
    this._bindCharacteristic({
      service,
      characteristic: C.InUse,
      getter: async () => st.active ? C.InUse.IN_USE : C.InUse.NOT_IN_USE,
    });
    // RemainingDuration/SetDuration: RUNNING과 PAUSED 모두에서 마지막 알려진 잔여시간을 반환.
    // (v1.8.5 버그: _state.active만 보아서 PAUSED 시 0 반환 → HomeKit 앱 재시작 시 카운트다운이 0으로 점프하던 문제)
    this._bindCharacteristic({
      service,
      characteristic: C.RemainingDuration,
      getter: async () => {
        const s = st.state;
        return (s === STATE.RUNNING || s === STATE.PAUSED) ? st.duration : 0;
      },
    });
    this._bindCharacteristic({
      service,
      characteristic: C.SetDuration,
      getter: async () => {
        const s = st.state;
        return (s === STATE.RUNNING || s === STATE.PAUSED) ? st.duration : 0;
      },
    });

    // 사용자가 홈 앱에서 Valve를 토글하더라도 실제 기기 명령은 보내지 않고,
    // 즉시 실제 상태로 되돌려 UI 어긋남을 방지(조회 전용 동작).
    const activeChar = service.getCharacteristic(C.Active);
    activeChar.removeAllListeners('set');
    activeChar.on('set', (_value, callback) => {
      callback(null);
      setImmediate(() => {
        const s = st.state;
        const v = (s === STATE.RUNNING || s === STATE.PAUSED) ? C.Active.ACTIVE : C.Active.INACTIVE;
        activeChar.updateValue(v);
      });
    });

    return service;
  }

  _setupNotificationSensor(accessory, configDevice, packageVersion, unit) {
    if (!configDevice.enableNotificationSensor) return null;

    const device = accessory.context.device;
    const baseLabel = unit ? unit.label : device.label;
    // HAP가 거부할 수 있는 특수문자를 제거. 한글/영문/숫자/공백/하이픈만 허용.
    const sanitize = (s) => String(s).replace(/[^\p{L}\p{N}\s\-]/gu, '').trim().substring(0, 64);
    // ★분리 모드에서는 세탁조마다 별도 센서가 필요하다. sensorName(사용자 지정)은 합침 모드
    //   전용으로 둔다 — 분리 상태에서 같은 이름을 두 개 만들면 홈킷에서 구분이 안 된다.
    const isSplit = unit && unit.key !== 'combined';
    const customName = isSplit ? '' : sanitize(configDevice.sensorName || '');
    const displayName = customName || `${sanitize(baseLabel)} 종료알림`;
    // 메인/합침은 **기존 UUID를 유지**해 재페어링을 피하고, 보조만 새 키를 쓴다.
    const keySuffix = (unit && unit.key === 'sub')
      ? 'notif:onCompletion:motion:sub'
      : 'notif:onCompletion:motion';
    const uuid = this.UUIDGen.generate(`${device.deviceId}:${keySuffix}`);

    let acc = this.platform.accessories.find(a => a.UUID === uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(displayName, uuid);
      acc.context.device = device;
      this.api.registerPlatformAccessories(this.platform.PLUGIN_NAME, this.platform.PLATFORM_NAME, [acc]);
      this.platform.accessories.push(acc);
    } else {
      acc.displayName = displayName;
      acc.context.device = device;
    }
    this.platform.activeUUIDs.add(uuid);

    const info = acc.getService(this.Service.AccessoryInformation) || acc.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(this.Characteristic.Model, `${configDevice.model || (this.deviceKind === 'dryer' ? 'Dryer' : 'Washer')} - Sensor`)
      .setCharacteristic(this.Characteristic.SerialNumber, `${device.deviceId}-${keySuffix}`)
      .setCharacteristic(this.Characteristic.FirmwareRevision, packageVersion);

    const sensorService = acc.getService(this.Service.MotionSensor) || acc.addService(this.Service.MotionSensor, displayName);
    sensorService.setCharacteristic(this.Characteristic.Name, displayName);
    sensorService.updateCharacteristic(this.Characteristic.MotionDetected, false);

    this.log.info(`[${baseLabel}] 종료 알림 모션 센서 '${displayName}' 구성 완료.`);
    return sensorService;
  }

  _startPolling(accessory, configDevice, units) {
    const C = this.Characteristic;
    const device = accessory.context.device;
    const deviceId = device.deviceId;
    const baseLabel = device.label;
    const pollIntervalSec = Number.isFinite(configDevice.sensorPollInterval) && configDevice.sensorPollInterval >= 5
      ? configDevice.sensorPollInterval
      : DEFAULT_SENSOR_POLL_SEC;

    let consecutiveFailures = 0;
    // ★사용자 로그에 실제로 남긴 실패만 따로 센다(v2.7.2).
    //   `consecutiveFailures`는 backoff 계산에 쓰이므로 debug로 억제한 순단도 포함해야 하는데,
    //   복구 줄이 그 값을 그대로 노출해 **사용자가 본 적 없는 횟수**를 결론처럼 알렸다
    //   (실측: 전원 OFF 시나리오에서 `전원 꺼짐` 바로 다음 줄에 `폴링 복구 (4회 실패 후 정상화)`).
    let visibleFailures = 0;
    let pollTimer = null;
    let stopped = false;
    let warnedMissingSub = false;
    // v1.8.6: 빈 응답이 무한 carry-over되어 영원히 RUNNING으로 잡히는 것을 막기 위한 한도.
    // 10회 (기본 30s × 10 = 5분) 동안 UNKNOWN이 지속되면 강제로 FINISHED로 전환한다.
    const MAX_UNKNOWN_CARRY = 10;

    const triggerPulse = (unit) => {
      if (!unit.sensor) return;
      unit.sensor.updateCharacteristic(C.MotionDetected, true);
      this.log.info(`[${unit.label}] 종료 알림 센서 트리거`);
      if (unit.pulseTimer) clearTimeout(unit.pulseTimer);
      unit.pulseTimer = setTimeout(() => {
        unit.sensor.updateCharacteristic(C.MotionDetected, false);
        unit.pulseTimer = null;
      }, COMPLETION_PULSE_MS);
    };

    const computeBackoffSec = () => {
      if (consecutiveFailures < POLL_BACKOFF_THRESHOLD) return pollIntervalSec;
      const factor = Math.min(consecutiveFailures - POLL_BACKOFF_THRESHOLD + 1, 5);
      return Math.min(pollIntervalSec * Math.pow(2, factor), POLL_BACKOFF_MAX_SEC);
    };

    const poll = async () => {
      if (stopped) return;
      try {
        this.smartthings.invalidateStatusCache(deviceId);
        const components = await this.smartthings.getStatus(deviceId);
        const mainComp = components.main;
        const realSub = components.sub;
        // ★합침 모드는 옛 기기 호환으로 `hca.main`도 보조로 쳐준다(기존 동작 유지).
        //   분리 모드에서는 **인정하지 않는다** — `hca.main`은 HCA 미러 컴포넌트이지 두 번째
        //   세탁조가 아니다. 이걸 sub로 받아들이면 아래 "보조 구획 없음" 경고가 영영 뜨지 않아
        //   죽은 타일이 안내 없이 방치된다(적대 감사 H-1). 실측: 우리 2-in-1은 `sub`를 주고
        //   `hca.main`은 아예 없다(2026-07-29 클라우드 응답 확인).
        const isSplit = units.length > 1;
        const subComp = realSub || (isSplit ? undefined : components['hca.main']);

        if (visibleFailures > 0) {
          // ★`visibleFailures`는 **경고를 낸 횟수**다 — backoff 진입 후에는 더 세지 않으므로
          //   4에서 멈춘다(v2.7.4). 그 값을 "실패 N회"로 쓰면 4시간 장애도 "4회"가 된다.
          //   숫자를 부풀리는 대신 무엇을 센 것인지 밝힌다.
          this.log.info(`[${baseLabel}] 폴링 복구 (경고 ${visibleFailures}회 후 정상화)`);
        }
        consecutiveFailures = 0;
        visibleFailures = 0;

        if (!realSub && isSplit && !warnedMissingSub) {
          warnedMissingSub = true;
          this.log.warn(`[${baseLabel}] 세탁조 분리가 켜져 있는데 보조 구획이 응답에 없습니다 — 2-in-1이 아닌 기기일 수 있습니다. 설정에서 분리를 끄세요.`);
        }


        // 상태 조회는 **기기당 1회**로 끝내고, 유닛(합침 1개 또는 분리 2개)마다 자기 구획만 해석한다.
        // → 분리를 켜도 API 호출량은 그대로다.
        for (const unit of units) {
          const comps = unit.key === 'combined' ? [mainComp, subComp]
            : unit.key === 'sub' ? [subComp]
              : [mainComp];
          // v1.8.5: 3-상태 분류 — 일시정지 케이스를 RUNNING/FINISHED와 정확히 구분.
          const classes = comps.map(c => (c ? classifyComponent(c) : STATE.UNKNOWN));
          let currentState = combineStates(...classes);
          const previousState = unit.prev;

          // ★부분 응답 보호 (v2.4.5 적대 감사 F-1).
          // combineStates는 FINISHED를 UNKNOWN보다 우선한다 — 그래서 두 구획 중
          // **한쪽만 정보가 사라져도** 남은 구획이 대기 중이면 합산 결과가 '종료'가 되고,
          // 바로 종료 알림이 발사된다(그리고 복구되면 진짜 종료 때 두 번째 알림).
          // 평소 정보를 주던 구획 수보다 줄었으면 "정보 부족"으로 보고 아래 carry에 맡긴다.
          const informative = classes.filter(s => s !== STATE.UNKNOWN).length;
          if (informative > unit.maxInformative) unit.maxInformative = informative;
          if (informative > 0 && informative < unit.maxInformative
              && currentState === STATE.FINISHED) {
            this.log.debug(`[${unit.label}] 구획 정보 일부 없음(${informative}/${unit.maxInformative}) — 종료 판정 보류`);
            currentState = STATE.UNKNOWN;
          }

          // UNKNOWN은 정보 부족(폴링이 잠시 빈 응답)이므로 이전 상태를 유지해 잘못된 전환을 막는다.
          // 단 무한 carry-over는 오프라인 가전이 영원히 RUNNING으로 잡히는 원인이 되므로
          // MAX_UNKNOWN_CARRY를 넘으면 강제로 FINISHED로 fallback (마지막 종료 펄스 1회 발사).
          if (currentState === STATE.UNKNOWN && previousState && previousState !== STATE.UNKNOWN) {
            unit.unknownCarry++;
            if (unit.unknownCarry > MAX_UNKNOWN_CARRY) {
              this.log.warn(`[${unit.label}] 상태 정보가 ${unit.unknownCarry}회 연속 비어있어 '완료'로 처리합니다 (가전 오프라인 의심).`);
              currentState = STATE.FINISHED;
              unit.unknownCarry = 0;
            } else {
              currentState = previousState;
            }
          } else {
            unit.unknownCarry = 0;
          }

          const isRunning = currentState === STATE.RUNNING;
          const isPaused = currentState === STATE.PAUSED;
          const isFinished = currentState === STATE.FINISHED;

          // duration 계산: getComponentDuration이 null=정보 없음, 0+=실제 값.
          const durs = comps.map(c => getComponentDuration(c));
          let rawDuration;
          if (durs.every(d => d == null)) {
            // 정보 없음: 사이클이 진행 중(또는 일시정지 중)이면 직전 값을 보존.
            rawDuration = (isRunning || isPaused) ? (unit.state.duration || 0) : 0;
          } else {
            rawDuration = Math.max(...durs.map(d => d ?? 0));
          }
          const duration = Math.min(rawDuration, HK_REMAINING_DURATION_MAX);

          // ★v2.4.1 — 유닛은 **자기 구획 값만** 찍는다. 이전엔 분리 모드에서 두 줄이 서로
          // 상대 구획 데이터까지 함께 출력해, 어느 조 얘긴지 알 수 없고 잡음만 두 배였다.
          const detail = comps
            .map((c, i) => {
              if (!c) return null;
              const who = unit.key === 'combined' ? (i === 0 ? '메인' : '보조') : '';
              const js = _readJobAndMachineState(c);
              return `${who ? who + ' ' : ''}작업=${js.jobState ?? '-'} 기기=${js.machineState ?? '-'}`;
            })
            .filter(Boolean)
            .join(' | ');

          this.log.debug(
            `[${unit.label}] 폴링: 상태=${stateKo(currentState)}` +
            `(이전 ${previousState ? stateKo(previousState) : '없음'}), 잔여 ${rawDuration}초` +
            (rawDuration !== duration ? `(상한 적용 ${duration}초)` : '') +
            ` | ${detail}`
          );
          if (previousState && previousState !== currentState) {
            this.log.info(`[${unit.label}] 상태 → ${stateKo(currentState)} (이전 ${stateKo(previousState)})`);
          }

          // state.active = "실제 동작 중"(InUse 의미). state.state = 분류된 상태.
          unit.state.active = isRunning;
          unit.state.state = currentState;
          if (isFinished) {
            unit.state.duration = 0;
          } else if (isRunning) {
            unit.state.duration = duration;
          } else if (isPaused && !unit.state.duration && duration) {
            // ★일시정지 중에 홈브릿지가 (재)시작하면 저장값이 없어 카운트다운이 0에 고착됐다
            // (적대 감사 M-2). 저장값이 **없을 때만** 신선한 값으로 시드한다 — 동결 의도는 유지.
            unit.state.duration = duration;
          }
          // 그 밖의 PAUSED는 duration을 그대로 유지 (이전 값 보존)

          // Valve.Active = 사이클이 로드되어 있는 상태 (RUNNING ∪ PAUSED).
          // InUse = 지금 동작 중 (RUNNING만).
          // RemainingDuration = 진짜 운전 중일 때만 카운트다운, 일시정지는 마지막 값 유지, 종료는 0.
          const valveActive = isRunning || isPaused;
          unit.valve.updateCharacteristic(C.Active, valveActive ? C.Active.ACTIVE : C.Active.INACTIVE);
          unit.valve.updateCharacteristic(C.InUse, isRunning ? C.InUse.IN_USE : C.InUse.NOT_IN_USE);
          if (isRunning) {
            unit.valve.updateCharacteristic(C.SetDuration, duration);
            unit.valve.updateCharacteristic(C.RemainingDuration, duration);
          } else if (isPaused) {
            // 일시정지: 카운트다운 동결. SetDuration 재push하지 않는다 (이미 마지막 값으로 설정됨).
            unit.valve.updateCharacteristic(C.RemainingDuration, unit.state.duration || 0);
          } else {
            unit.valve.updateCharacteristic(C.RemainingDuration, 0);
          }

          // 종료 펄스: RUNNING/PAUSED → FINISHED 전환에서만 발사.
          // 일시정지는 펄스를 발사하지 않으며, 일시정지 후 종료도 정확히 한 번만 발사.
          if (
            (previousState === STATE.RUNNING || previousState === STATE.PAUSED) &&
            currentState === STATE.FINISHED
          ) {
            triggerPulse(unit);
          }
          unit.prev = currentState;
        }
      } catch (e) {
        consecutiveFailures++;
        // 재인증 윈도우 등으로 토큰이 비어있어 인터셉터가 거부한 경우는 정상 동작 일부이므로 debug로.
        if (e?._noToken) {
          this.log.debug?.(`[${baseLabel}] 폴링 보류 (재인증 대기): ${e.message}`);
        } else if (e?._transient) {
          // ★꺼져 있는 게 정상인 기기(세탁기)의 **순단**은 사건이 아니다 (v2.4.5 감사 L-F2).
          // 전송 계층이 "아직 꺼졌다고 단정할 단계는 아니다"라고 판단해 올린 예외이고,
          // 이 계층은 그걸 직전 상태 유지로 이미 올바르게 처리한다. 그런데도 warn을 찍으면
          // NAS의 hb-watch 감시기가 `상태 폴링 오류` 문구를 잡아 **텔레그램 오경보**를 낸다.
          // (세탁 중 와이파이가 잠깐 끊길 때마다 알림이 가던 경로 — 실측으로 확인됨)
          this.log.debug?.(`[${baseLabel}] 일시적 무응답 ${consecutiveFailures}회 — 직전 상태 유지: ${e.message}`);
        } else if (consecutiveFailures <= POLL_BACKOFF_THRESHOLD) {
          visibleFailures++;
          this.log.warn(`[${baseLabel}] 상태 폴링 오류 (${consecutiveFailures}회 연속): ${e.message}`);
        } else if (consecutiveFailures === POLL_BACKOFF_THRESHOLD + 1) {
          visibleFailures++;
          this.log.warn(`[${baseLabel}] 폴링 실패 누적 — backoff 모드로 전환합니다.`);
        }
      } finally {
        if (!stopped) {
          const nextSec = computeBackoffSec();
          pollTimer = setTimeout(poll, nextSec * 1000);
        }
      }
    };

    poll();
    this.platform.registerShutdown(() => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      for (const u of units) if (u.pulseTimer) clearTimeout(u.pulseTimer);
    });

    const withSensor = units.some(u => u.sensor);
    const shape = units.length > 1 ? ` · 세탁조 분리(${units.length}개)` : '';
    this.log.info(`[${baseLabel}] 상태 폴링 시작 (${pollIntervalSec}s)${withSensor ? ', 종료 알림 센서 활성' : ''}${shape}.`);
  }
}

module.exports = Laundry;
// ★정본 판정기 공유(2026-07-30) — MQTT attach.js가 세탁물 운전 상태를 재정의하지 않고
//   이걸 그대로 쓴다. 판정기가 두 벌이면 run+none(사이클 종료 직후) 같은 조합에서
//   홈킷과 MQTT가 갈린다(실사고: 건조기 종료 후 HA만 '운전 중' 고착).
module.exports.classifyComponent = classifyComponent;
module.exports.STATE = STATE;
