'use strict';

const ACTIVE_JOB_STATES = new Set([
  'running', 'drying', 'cooling',                // Dryer
  'washing', 'rinse', 'spin', 'detergentSupply'  // Washer
]);
const ACTIVE_MACHINE_STATES = new Set(['run', 'on']);

const COMPLETION_PULSE_MS = 10 * 1000;
const DEFAULT_SENSOR_POLL_SEC = 30;
const HK_REMAINING_DURATION_MAX = 3600;

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

function isComponentActive(component) {
  const op = pickOperatingState(component);
  if (!op) return false;
  const jobState = op.dryerJobState?.value || op.washerJobState?.value;
  const machineState = op.machineState?.value;
  return ACTIVE_JOB_STATES.has(jobState) || ACTIVE_MACHINE_STATES.has(machineState);
}

function getComponentDuration(component) {
  const op = pickOperatingState(component);
  if (!op) return 0;

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

  return 0;
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

    // 폴링이 갱신하는 공유 상태 (get 핸들러도 이 값을 즉답하여 push와 일관성 유지)
    this._state = { active: false, duration: 0 };

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

    // SetDuration이 있어야 Home 앱이 잔여 시간 카운트다운을 렌더링함 (없으면 "대기 중..." 고착).
    // 모니터링 전용이므로 쓰기 권한을 제거(읽기 전용)하고 HIDDEN으로 슬라이더 UI를 숨긴다.
    service.getCharacteristic(C.SetDuration)
      .setProps({
        maxValue: HK_REMAINING_DURATION_MAX,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY, Perms.HIDDEN],
      });

    // get 핸들러는 폴링이 들고 있는 최신 상태를 즉답 (push 값과 항상 일치)
    this._bindCharacteristic({
      service,
      characteristic: C.Active,
      getter: async () => this._state.active ? C.Active.ACTIVE : C.Active.INACTIVE,
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

    return service;
  }

  _setupNotificationSensor(accessory, configDevice, packageVersion) {
    if (!configDevice.enableNotificationSensor) return null;

    const device = accessory.context.device;
    const baseLabel = device.label;
    const customName = (configDevice.sensorName || '').trim();
    const displayName = customName || `${baseLabel} 종료알림`;
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

    let previousActive = null;
    let pulseTimer = null;

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

    const poll = async () => {
      try {
        this.smartthings.invalidateStatusCache(deviceId);
        const components = await this.smartthings.getStatus(deviceId);
        const mainComp = components.main;
        const subComp = components.sub || components['hca.main'];
        const active = isComponentActive(mainComp) || isComponentActive(subComp);
        const rawDuration = Math.max(getComponentDuration(mainComp), getComponentDuration(subComp));
        const duration = Math.min(rawDuration, HK_REMAINING_DURATION_MAX);

        this.log.debug(`[${baseLabel}] 폴링: active=${active}, remaining=${rawDuration}s (cap ${duration}s)`);

        // 공유 상태 갱신 (get 핸들러가 이 값을 즉답)
        this._state.active = active;
        this._state.duration = active ? duration : 0;

        // 운전 시작(비활성->활성) 전환 시 SetDuration을 설정해 Home 앱 카운트다운을 트리거
        if (active && previousActive !== true) {
          valveService.updateCharacteristic(C.SetDuration, duration);
        }

        // Valve 상태 push 업데이트 (실시간 반영)
        valveService.updateCharacteristic(C.Active, active ? C.Active.ACTIVE : C.Active.INACTIVE);
        valveService.updateCharacteristic(C.InUse, active ? C.InUse.IN_USE : C.InUse.NOT_IN_USE);
        valveService.updateCharacteristic(C.RemainingDuration, active ? duration : 0);

        // 종료 알림 센서: active -> inactive 전환 시 1회 펄스
        if (previousActive === true && active === false) {
          triggerPulse();
        }
        previousActive = active;
      } catch (e) {
        this.log.warn(`[${baseLabel}] 상태 폴링 오류: ${e.message}`);
      }
    };

    poll();
    const timer = setInterval(poll, pollIntervalSec * 1000);
    this.platform.registerShutdown(() => {
      clearInterval(timer);
      if (pulseTimer) clearTimeout(pulseTimer);
    });

    this.log.info(`[${baseLabel}] 상태 폴링 시작 (${pollIntervalSec}s)${sensorService ? ', 종료 알림 센서 활성' : ''}.`);
  }
}

module.exports = Laundry;
