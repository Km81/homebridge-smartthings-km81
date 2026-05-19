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

    this._setupValveService(accessory);
    this._setupNotificationSensors(accessory, configDevice, packageVersion);
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
    const deviceId = accessory.context.device.deviceId;
    const service = accessory.getService(this.Service.Valve) ||
      accessory.addService(this.Service.Valve, accessory.displayName);
    service.setCharacteristic(C.ValveType, C.ValveType.IRRIGATION);

    const getDeviceActiveState = async () => {
      const components = await this.smartthings.getStatus(deviceId);
      const mainComp = components.main;
      const subComp = components.sub || components['hca.main'];
      return isComponentActive(mainComp) || isComponentActive(subComp);
    };

    this._bindCharacteristic({
      service,
      characteristic: C.Active,
      getter: async () => (await getDeviceActiveState())
        ? C.Active.ACTIVE
        : C.Active.INACTIVE,
    });

    this._bindCharacteristic({
      service,
      characteristic: C.InUse,
      getter: async () => (await getDeviceActiveState())
        ? C.InUse.IN_USE
        : C.InUse.NOT_IN_USE,
    });

    // HomeKit RemainingDuration 표준 최대값은 3600초이므로 cap 처리
    service.getCharacteristic(C.RemainingDuration)
      .setProps({ maxValue: HK_REMAINING_DURATION_MAX });

    this._bindCharacteristic({
      service,
      characteristic: C.RemainingDuration,
      getter: async () => {
        const components = await this.smartthings.getStatus(deviceId);
        const mainComp = components.main;
        const subComp = components.sub || components['hca.main'];
        const mainDuration = getComponentDuration(mainComp);
        const subDuration = getComponentDuration(subComp);
        const seconds = mainDuration > 0 ? mainDuration : (subDuration > 0 ? subDuration : 0);
        return Math.min(seconds, HK_REMAINING_DURATION_MAX);
      },
    });
  }

  _setupNotificationSensors(accessory, configDevice, packageVersion) {
    if (!configDevice.enableNotificationSensor) return;

    const pollIntervalSec = Number.isFinite(configDevice.sensorPollInterval) && configDevice.sensorPollInterval >= 5
      ? configDevice.sensorPollInterval
      : DEFAULT_SENSOR_POLL_SEC;

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

    // 폴링 상태머신
    const deviceId = device.deviceId;
    let previousActive = null;
    let pulseTimer = null;

    const triggerPulse = () => {
      sensorService.updateCharacteristic(this.Characteristic.MotionDetected, true);
      this.log.info(`[${baseLabel}] 종료 알림 센서 트리거`);
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => {
        sensorService.updateCharacteristic(this.Characteristic.MotionDetected, false);
        pulseTimer = null;
      }, COMPLETION_PULSE_MS);
    };

    const pollOnce = async () => {
      try {
        this.smartthings.invalidateStatusCache(deviceId);
        const components = await this.smartthings.getStatus(deviceId);
        const mainComp = components.main;
        const subComp = components.sub || components['hca.main'];
        const currentActive = isComponentActive(mainComp) || isComponentActive(subComp);

        if (previousActive === true && currentActive === false) {
          triggerPulse();
        }
        previousActive = currentActive;
      } catch (e) {
        this.log.warn(`[${baseLabel}] 알림 센서 폴링 오류: ${e.message}`);
      }
    };

    pollOnce();
    const timer = setInterval(pollOnce, pollIntervalSec * 1000);
    this.platform.registerShutdown(() => {
      clearInterval(timer);
      if (pulseTimer) clearTimeout(pulseTimer);
    });

    this.log.info(`[${baseLabel}] 종료 알림 모션 센서 '${displayName}' 구성 완료 (폴링 ${pollIntervalSec}s).`);
  }
}

module.exports = Laundry;
