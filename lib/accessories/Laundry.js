'use strict';

const ACTIVE_JOB_STATES = new Set([
  'running', 'drying', 'cooling',                // Dryer
  'washing', 'rinse', 'spin', 'detergentSupply'  // Washer
]);
const ACTIVE_MACHINE_STATES = new Set(['run', 'on']);

const COMPLETION_PULSE_MS = 10 * 1000;
const DEFAULT_SENSOR_POLL_SEC = 30;

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

    this._bindCharacteristic({
      service,
      characteristic: C.RemainingDuration,
      getter: async () => {
        const components = await this.smartthings.getStatus(deviceId);
        const mainComp = components.main;
        const subComp = components.sub || components['hca.main'];
        const mainDuration = getComponentDuration(mainComp);
        const subDuration = getComponentDuration(subComp);
        if (mainDuration > 0) return mainDuration;
        if (subDuration > 0) return subDuration;
        return 0;
      },
    });
  }

  _setupNotificationSensors(accessory, configDevice, packageVersion) {
    if (!configDevice.enableNotificationSensor) return;

    const sensorTypes = Array.isArray(configDevice.sensorTypes) && configDevice.sensorTypes.length > 0
      ? configDevice.sensorTypes
      : ['contact'];
    const triggerModes = Array.isArray(configDevice.triggerMode) && configDevice.triggerMode.length > 0
      ? configDevice.triggerMode
      : ['onCompletion'];
    const pollIntervalSec = Number.isFinite(configDevice.sensorPollInterval) && configDevice.sensorPollInterval >= 5
      ? configDevice.sensorPollInterval
      : DEFAULT_SENSOR_POLL_SEC;

    const device = accessory.context.device;
    const baseLabel = device.label;
    const sensors = [];

    const SENSOR_DEFS = {
      contact:   { typeKey: 'contact',   name: '접촉',   serviceClass: this.Service.ContactSensor,   characteristic: this.Characteristic.ContactSensorState,
                   activeValue: this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
                   inactiveValue: this.Characteristic.ContactSensorState.CONTACT_DETECTED },
      motion:    { typeKey: 'motion',    name: '모션',   serviceClass: this.Service.MotionSensor,    characteristic: this.Characteristic.MotionDetected,
                   activeValue: true, inactiveValue: false },
      occupancy: { typeKey: 'occupancy', name: '점유',   serviceClass: this.Service.OccupancySensor, characteristic: this.Characteristic.OccupancyDetected,
                   activeValue: this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED,
                   inactiveValue: this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED },
    };

    const TRIGGER_LABEL = {
      onCompletion: '종료 알림',
      duringRun: '운전 중'
    };

    const ensureSensorAccessory = (triggerMode, sensorTypeKey) => {
      const def = SENSOR_DEFS[sensorTypeKey];
      if (!def) return null;
      const triggerLabel = TRIGGER_LABEL[triggerMode] || triggerMode;
      const displayName = `${baseLabel} - ${triggerLabel} (${def.name})`;
      const keySuffix = `notif:${triggerMode}:${sensorTypeKey}`;
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

      const sensorService = acc.getService(def.serviceClass) || acc.addService(def.serviceClass, displayName);
      // 초기값 inactive
      sensorService.updateCharacteristic(def.characteristic, def.inactiveValue);

      return { accessory: acc, service: sensorService, def, triggerMode, sensorTypeKey };
    };

    for (const trigger of triggerModes) {
      for (const stype of sensorTypes) {
        const s = ensureSensorAccessory(trigger, stype);
        if (s) sensors.push(s);
      }
    }

    if (sensors.length === 0) return;

    // 폴링 상태머신
    const deviceId = device.deviceId;
    let previousActive = null;
    const pulseTimers = new Map(); // sensor key -> timeout

    const setSensorActive = (sensor, active) => {
      const value = active ? sensor.def.activeValue : sensor.def.inactiveValue;
      sensor.service.updateCharacteristic(sensor.def.characteristic, value);
    };

    const triggerPulse = (sensor) => {
      const key = `${sensor.triggerMode}:${sensor.sensorTypeKey}`;
      setSensorActive(sensor, true);
      this.log.info(`[${baseLabel}] 종료 알림 센서 트리거: ${sensor.def.name}`);
      if (pulseTimers.has(key)) clearTimeout(pulseTimers.get(key));
      pulseTimers.set(key, setTimeout(() => {
        setSensorActive(sensor, false);
        pulseTimers.delete(key);
      }, COMPLETION_PULSE_MS));
    };

    const pollOnce = async () => {
      try {
        this.smartthings.invalidateStatusCache(deviceId);
        const components = await this.smartthings.getStatus(deviceId);
        const mainComp = components.main;
        const subComp = components.sub || components['hca.main'];
        const currentActive = isComponentActive(mainComp) || isComponentActive(subComp);

        for (const sensor of sensors) {
          if (sensor.triggerMode === 'duringRun') {
            setSensorActive(sensor, currentActive);
          } else if (sensor.triggerMode === 'onCompletion') {
            if (previousActive === true && currentActive === false) {
              triggerPulse(sensor);
            }
          }
        }
        previousActive = currentActive;
      } catch (e) {
        this.log.warn(`[${baseLabel}] 알림 센서 폴링 오류: ${e.message}`);
      }
    };

    // 즉시 한 번 실행 후 주기 폴링
    pollOnce();
    const timer = setInterval(pollOnce, pollIntervalSec * 1000);
    this.platform.registerShutdown(() => {
      clearInterval(timer);
      for (const t of pulseTimers.values()) clearTimeout(t);
    });

    this.log.info(`[${baseLabel}] 알림 센서 ${sensors.length}개 구성 완료 (폴링 ${pollIntervalSec}s).`);
  }
}

module.exports = Laundry;
