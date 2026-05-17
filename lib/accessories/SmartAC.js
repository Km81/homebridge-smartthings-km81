'use strict';

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

  const step = Number.isFinite(deviceCfg.temperatureStep)
    ? deviceCfg.temperatureStep
    : Number.isFinite(platformCfg.temperatureStep)
      ? platformCfg.temperatureStep
      : DEFAULTS.step;

  const safeStep = step >= 0.1 ? step : DEFAULTS.step;
  const safeMin = Math.min(min, max - safeStep);
  const safeMax = Math.max(max, safeMin + safeStep);

  return { minValue: safeMin, maxValue: safeMax, minStep: safeStep };
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
    const C = this.Characteristic;
    accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'Samsung')
      .setCharacteristic(C.Model, configDevice.model || 'AC-Model')
      .setCharacteristic(C.SerialNumber, configDevice.serialNumber || accessory.context.device.deviceId)
      .setCharacteristic(C.FirmwareRevision, packageVersion);

    this._setupHeaterCooler(accessory, configDevice);
    this._setupOptionalSwitches(accessory.context.device, configDevice, packageVersion);
  }

  _bindCharacteristic({ service, characteristic, props, getter, setter }) {
    const char = service.getCharacteristic(characteristic);
    char.removeAllListeners('get');
    if (setter) char.removeAllListeners('set');
    if (props) char.setProps(props);

    char.on('get', async (callback) => {
      try {
        const value = await getter();
        callback(null, value);
      } catch (e) {
        this.log.error(`[${service.displayName}] ${characteristic.displayName} GET 오류:`, e.message);
        callback(e);
      }
    });

    if (setter) {
      char.on('set', async (value, callback) => {
        try {
          await setter(value);
          callback(null);
        } catch (e) {
          this.log.error(`[${service.displayName}] ${characteristic.displayName} SET 오류:`, e.message);
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

    this._bindCharacteristic({
      service,
      characteristic: C.Active,
      getter: () => this.smartthings.getPower(deviceId).then(p => p ? 1 : 0),
      setter: (value) => this.smartthings.setPower(deviceId, value === 1),
    });

    this._bindCharacteristic({
      service,
      characteristic: C.CurrentHeaterCoolerState,
      getter: async () => {
        if (!await this.smartthings.getPower(deviceId)) {
          return C.CurrentHeaterCoolerState.INACTIVE;
        }
        return C.CurrentHeaterCoolerState.COOLING;
      },
    });

    const ALLOWED_COOL_CMDS = new Set(['cool', 'coolClean', 'dry', 'dryClean']);
    const rawCoolCmd = configDevice.coolCommand || configDevice.coolModeCommand || 'cool';
    const coolCmd = ALLOWED_COOL_CMDS.has(rawCoolCmd) ? rawCoolCmd : 'cool';
    this._bindCharacteristic({
      service,
      characteristic: C.TargetHeaterCoolerState,
      props: { validValues: [C.TargetHeaterCoolerState.COOL] },
      getter: () => C.TargetHeaterCoolerState.COOL,
      setter: async (value) => {
        if (value === C.TargetHeaterCoolerState.COOL) {
          await this.smartthings.setMode(deviceId, coolCmd);
        }
      },
    });

    this._bindCharacteristic({
      service,
      characteristic: C.CurrentTemperature,
      getter: () => this.smartthings.getCurrentTemperature(deviceId),
    });

    const tempProps = resolveTempProps(this.platform.config || {}, configDevice || {});
    this._bindCharacteristic({
      service,
      characteristic: C.CoolingThresholdTemperature,
      props: tempProps,
      getter: async () => {
        const current = await this.smartthings.getCoolingSetpoint(deviceId);
        return clampNumber(current, tempProps.minValue, tempProps.maxValue);
      },
      setter: (value) => this.smartthings.setTemperature(deviceId, clampNumber(value, tempProps.minValue, tempProps.maxValue)),
    });

    const swingBinding = (configDevice.swingBinding || 'windFree');
    if (swingBinding !== 'none') {
      this._bindCharacteristic({
        service,
        characteristic: C.SwingMode,
        getter: async () => (await this.smartthings.getWindFree(deviceId)) ? 1 : 0,
        setter: async (value) => { await this.smartthings.setWindFree(deviceId, value === 1); }
      });
    } else {
      const existing = service.getCharacteristic(C.SwingMode);
      if (existing) service.removeCharacteristic(existing);
    }

    const lockBinding = (configDevice.lockBinding || 'autoClean');
    if (lockBinding !== 'none') {
      this._bindCharacteristic({
        service,
        characteristic: C.LockPhysicalControls,
        getter: async () => (await this.smartthings.getAutoClean(deviceId)) ? 1 : 0,
        setter: async (value) => { await this.smartthings.setAutoClean(deviceId, value === 1); }
      });
    } else {
      const existing = service.getCharacteristic(C.LockPhysicalControls);
      if (existing) service.removeCharacteristic(existing);
    }
  }

  _setupOptionalSwitches(device, configDevice, packageVersion) {
    const C = this.Characteristic;
    const baseLabel = device.label;

    const maybeCreateSwitch = (keySuffix, displayName, getter, setter) => {
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

      this._bindCharacteristic({
        service: sw,
        characteristic: C.On,
        getter: async () => !!(await getter()),
        setter: async (v) => setter(!!v),
      });
    };

    if (configDevice.exposeWindFreeSwitch) {
      maybeCreateSwitch('windfree', '무풍',
        () => this.smartthings.getWindFree(device.deviceId),
        (enable) => this.smartthings.setWindFree(device.deviceId, enable));
    }

    if (configDevice.exposeAutoCleanSwitch) {
      maybeCreateSwitch('autoclean', '자동건조',
        () => this.smartthings.getAutoClean(device.deviceId),
        (enable) => this.smartthings.setAutoClean(device.deviceId, enable));
    }
  }
}

module.exports = SmartAC;
