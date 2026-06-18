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
const FINISHED_JOB_STATES = new Set(['none', 'finished', 'stop', 'end']);
// 일시정지/대기성 machineState (전원은 켜져있지만 운전은 안 함)
const IDLE_MACHINE_STATES = new Set(['on', 'wakeUp', 'standby', 'off']);

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
    // 대기 상태 + jobState도 active가 아니면 FINISHED. (사용자 모델은 jobState가 stale 'weightSensing' 등을 보내므로
    // ACTIVE_JOB_STATES 멤버여도 machineState가 명확한 대기면 FINISHED로 본다.)
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

    // 폴링이 갱신하는 공유 상태 (get 핸들러도 이 값을 즉답하여 push와 일관성 유지).
    // v1.8.5: state는 3-상태 분류값을 그대로 보관해 Valve.Active(RUNNING ∪ PAUSED)와
    //         InUse(RUNNING)를 분리 표현한다.
    this._state = { active: false, duration: 0, state: STATE.UNKNOWN };

    const valveService = this._setupValveService(accessory);
    const sensorService = this._setupNotificationSensor(accessory, configDevice, packageVersion);
    this._startPolling(accessory, configDevice, valveService, sensorService);
  }

  _bindCharacteristic({ service, characteristic, getter }) {
    const C = this.Characteristic;
    const char = service.getCharacteristic(characteristic);
    char.removeAllListeners('get');
    char.on('get', async (callback) => {
      try {
        const value = await getter();
        callback(null, value);
      } catch (e) {
        this.log.error(`[${service.displayName}] '${characteristic.displayName}' GET 오류: ${e.message}. 기본값으로 처리합니다.`);
        switch (characteristic) {
          case C.Active: return callback(null, C.Active.INACTIVE);
          case C.InUse: return callback(null, C.InUse.NOT_IN_USE);
          case C.RemainingDuration: return callback(null, 0);
          default: return callback(e);
        }
      }
    });
  }

  _setupValveService(accessory) {
    const C = this.Characteristic;
    const Perms = this.api.hap.Perms;
    const service = accessory.getService(this.Service.Valve) ||
      accessory.addService(this.Service.Valve, accessory.displayName);
    service.setCharacteristic(C.ValveType, C.ValveType.IRRIGATION);

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
        const s = this._state.state;
        return (s === STATE.RUNNING || s === STATE.PAUSED) ? C.Active.ACTIVE : C.Active.INACTIVE;
      },
    });
    this._bindCharacteristic({
      service,
      characteristic: C.InUse,
      getter: async () => this._state.active ? C.InUse.IN_USE : C.InUse.NOT_IN_USE,
    });
    this._bindCharacteristic({
      service,
      characteristic: C.RemainingDuration,
      getter: async () => this._state.active ? this._state.duration : 0,
    });
    this._bindCharacteristic({
      service,
      characteristic: C.SetDuration,
      getter: async () => this._state.active ? this._state.duration : 0,
    });

    // 사용자가 홈 앱에서 Valve를 토글하더라도 실제 기기 명령은 보내지 않고,
    // 즉시 실제 상태로 되돌려 UI 어긋남을 방지(조회 전용 동작).
    const activeChar = service.getCharacteristic(C.Active);
    activeChar.removeAllListeners('set');
    activeChar.on('set', (_value, callback) => {
      callback(null);
      setImmediate(() => {
        const s = this._state.state;
        const v = (s === STATE.RUNNING || s === STATE.PAUSED) ? C.Active.ACTIVE : C.Active.INACTIVE;
        activeChar.updateValue(v);
      });
    });

    return service;
  }

  _setupNotificationSensor(accessory, configDevice, packageVersion) {
    if (!configDevice.enableNotificationSensor) return null;

    const device = accessory.context.device;
    const baseLabel = device.label;
    // HAP가 거부할 수 있는 특수문자를 제거. 한글/영문/숫자/공백/하이픈만 허용.
    const sanitize = (s) => String(s).replace(/[^\p{L}\p{N}\s\-]/gu, '').trim().substring(0, 64);
    const customName = sanitize(configDevice.sensorName || '');
    const displayName = customName || `${sanitize(baseLabel)} 종료알림`;
    const keySuffix = 'notif:onCompletion:motion';
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

  _startPolling(accessory, configDevice, valveService, sensorService) {
    const C = this.Characteristic;
    const device = accessory.context.device;
    const deviceId = device.deviceId;
    const baseLabel = device.label;
    const pollIntervalSec = Number.isFinite(configDevice.sensorPollInterval) && configDevice.sensorPollInterval >= 5
      ? configDevice.sensorPollInterval
      : DEFAULT_SENSOR_POLL_SEC;

    let previousState = null; // v1.8.5: 3-상태 분류 (RUNNING/PAUSED/FINISHED/UNKNOWN)
    let pulseTimer = null;
    let consecutiveFailures = 0;
    let pollTimer = null;
    let stopped = false;

    const triggerPulse = () => {
      if (!sensorService) return;
      sensorService.updateCharacteristic(C.MotionDetected, true);
      this.log.info(`[${baseLabel}] 종료 알림 센서 트리거`);
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => {
        sensorService.updateCharacteristic(C.MotionDetected, false);
        pulseTimer = null;
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
        const subComp = components.sub || components['hca.main'];

        // v1.8.5: 3-상태 분류 — 일시정지 케이스를 RUNNING/FINISHED와 정확히 구분.
        const mainState = classifyComponent(mainComp);
        const subState = subComp ? classifyComponent(subComp) : STATE.UNKNOWN;
        let currentState = combineStates(mainState, subState);

        // UNKNOWN은 정보 부족(폴링이 잠시 빈 응답)이므로 이전 상태를 유지해 잘못된 전환을 막는다.
        if (currentState === STATE.UNKNOWN && previousState && previousState !== STATE.UNKNOWN) {
          currentState = previousState;
        }

        const isRunning = currentState === STATE.RUNNING;
        const isPaused = currentState === STATE.PAUSED;
        const isFinished = currentState === STATE.FINISHED;

        // duration 계산: getComponentDuration이 null=정보 없음, 0+=실제 값.
        const mainDur = getComponentDuration(mainComp);
        const subDur = getComponentDuration(subComp);
        let rawDuration;
        if (mainDur == null && subDur == null) {
          // 정보 없음: 사이클이 진행 중(또는 일시정지 중)이면 직전 값을 보존.
          rawDuration = (isRunning || isPaused) ? (this._state.duration || 0) : 0;
        } else {
          rawDuration = Math.max(mainDur ?? 0, subDur ?? 0);
        }
        const duration = Math.min(rawDuration, HK_REMAINING_DURATION_MAX);

        if (consecutiveFailures > 0) {
          this.log.info(`[${baseLabel}] 폴링 복구 (${consecutiveFailures}회 실패 후 정상화)`);
        }
        consecutiveFailures = 0;

        const mainStates = _readJobAndMachineState(mainComp);
        const subStates = _readJobAndMachineState(subComp);
        this.log.debug(
          `[${baseLabel}] 폴링: state=${currentState} (prev=${previousState ?? 'null'}), ` +
          `remaining=${rawDuration}s (cap ${duration}s) ` +
          `| main job=${mainStates.jobState ?? '-'} machine=${mainStates.machineState ?? '-'}` +
          (subComp ? ` | sub job=${subStates.jobState ?? '-'} machine=${subStates.machineState ?? '-'}` : '')
        );
        if (previousState && previousState !== currentState) {
          this.log.info(`[${baseLabel}] 상태 전이: ${previousState} → ${currentState}`);
        }

        // _state.active = "실제 동작 중"(InUse 의미). _state.state = 분류된 상태.
        this._state.active = isRunning;
        this._state.state = currentState;
        if (isFinished) {
          this._state.duration = 0;
        } else if (isRunning) {
          this._state.duration = duration;
        }
        // PAUSED일 때는 _state.duration을 그대로 유지 (이전 값 보존)

        // Valve.Active = 사이클이 로드되어 있는 상태 (RUNNING ∪ PAUSED).
        // InUse = 지금 동작 중 (RUNNING만).
        // RemainingDuration = 진짜 운전 중일 때만 카운트다운, 일시정지는 마지막 값 유지, 종료는 0.
        const valveActive = isRunning || isPaused;
        valveService.updateCharacteristic(C.Active, valveActive ? C.Active.ACTIVE : C.Active.INACTIVE);
        valveService.updateCharacteristic(C.InUse, isRunning ? C.InUse.IN_USE : C.InUse.NOT_IN_USE);
        if (isRunning) {
          valveService.updateCharacteristic(C.SetDuration, duration);
          valveService.updateCharacteristic(C.RemainingDuration, duration);
        } else if (isPaused) {
          // 일시정지: 카운트다운 동결. SetDuration 재push하지 않는다 (이미 마지막 값으로 설정됨).
          valveService.updateCharacteristic(C.RemainingDuration, this._state.duration || 0);
        } else {
          valveService.updateCharacteristic(C.RemainingDuration, 0);
        }

        // 종료 펄스: RUNNING/PAUSED → FINISHED 전환에서만 발사.
        // 일시정지는 펄스를 발사하지 않으며, 일시정지 후 종료도 정확히 한 번만 발사.
        if (
          (previousState === STATE.RUNNING || previousState === STATE.PAUSED) &&
          currentState === STATE.FINISHED
        ) {
          triggerPulse();
        }
        previousState = currentState;
      } catch (e) {
        consecutiveFailures++;
        // 재인증 윈도우 등으로 토큰이 비어있어 인터셉터가 거부한 경우는 정상 동작 일부이므로 debug로.
        if (e?._noToken) {
          this.log.debug?.(`[${baseLabel}] 폴링 보류 (재인증 대기): ${e.message}`);
        } else if (consecutiveFailures <= POLL_BACKOFF_THRESHOLD) {
          this.log.warn(`[${baseLabel}] 상태 폴링 오류 (${consecutiveFailures}회 연속): ${e.message}`);
        } else if (consecutiveFailures === POLL_BACKOFF_THRESHOLD + 1) {
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
      if (pulseTimer) clearTimeout(pulseTimer);
    });

    this.log.info(`[${baseLabel}] 상태 폴링 시작 (${pollIntervalSec}s)${sensorService ? ', 종료 알림 센서 활성' : ''}.`);
  }
}

module.exports = Laundry;
