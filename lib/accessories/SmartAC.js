'use strict';

// 명령 전송 후 실제 상태로 재동기화하기까지의 지연(ms).
// 이 시간 동안 in-memory _state가 사용자 의도를 보존해 UI 깜빡임("켰는데 즉시 꺼짐")을 막는다.
const RESYNC_DELAY_MS = 2000;
// 슬라이더 드래그 시 마지막 값만 보내기 위한 trailing-debounce 간격(ms).
const SLIDER_DEBOUNCE_MS = 400;

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
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

    // 이전 인스턴스가 남긴 타이머가 있으면 정리 (재-configure 안전성)
    if (this._resyncTimers) for (const t of this._resyncTimers.values()) clearTimeout(t);

    // get 핸들러가 즉답하고 setter가 의도값을 보존하는 공유 상태.
    this._state = {
      power: undefined,
      currentTemp: undefined,
      coolingSetpoint: undefined,
      windFree: undefined,
      autoClean: undefined,
    };
    this._resyncTimers = new Map();
    // 각 키마다 단조 증가 sequence. resync fetch가 끝났을 때 자신의 seq가 최신이 아니면 값 적용을 포기.
    // (사용자가 빠르게 토글하면 in-flight fetch가 stale 값으로 새 _state를 덮어쓰는 race 방지)
    this._stateSeq = new Map();

    this._setupHeaterCooler(accessory, configDevice);
    this._setupOptionalSwitches(accessory.context.device, configDevice, packageVersion);
  }

  // 명령 송신 후, 잠시 후 실제 상태를 가져와 _state와 HomeKit 모두를 보정.
  // 빠른 연속 토글 시 in-flight fetch가 stale 값으로 새 _state를 덮어쓰지 않도록 seq tag로 보호.
  _scheduleResync(key, fetchActual, updateService) {
    const existing = this._resyncTimers.get(key);
    if (existing) clearTimeout(existing);
    // 이 set 시점에 새 seq 발급. fetch 완료 시 자신의 seq가 여전히 최신이면 적용.
    const mySeq = (this._stateSeq.get(key) || 0) + 1;
    this._stateSeq.set(key, mySeq);
    const timer = setTimeout(async () => {
      this._resyncTimers.delete(key);
      try {
        const actual = await fetchActual();
        // 사이에 새로운 set가 일어나 seq가 바뀌었으면 이 결과는 stale — 적용 안 함
        if (this._stateSeq.get(key) !== mySeq) {
          this.log.debug?.(`[resync ${key}] 더 새로운 set 감지 — stale 결과 폐기`);
          return;
        }
        this._state[key] = actual;
        updateService(actual);
      } catch (e) {
        this.log.debug?.(`[resync ${key}] 실패: ${e.message}`);
      }
    }, RESYNC_DELAY_MS);
    this._resyncTimers.set(key, timer);
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

    // _state의 값이 비어 있을 때만 SmartThings에서 가져오고, 채워지면 캐시 즉답.
    const lazyGet = async (key, fetchFn) => {
      if (this._state[key] === undefined) {
        this._state[key] = await fetchFn();
      }
      return this._state[key];
    };

    // ===== Active (전원) =====
    this._bindCharacteristic({
      service,
      characteristic: C.Active,
      getter: async () => (await lazyGet('power', () => this.smartthings.getPower(deviceId))) ? 1 : 0,
      setter: async (value) => {
        const target = value === 1;
        await this.smartthings.setPower(deviceId, target);
        this._state.power = target;
        // CurrentHeaterCoolerState도 power에 종속되므로 함께 보정
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

    // ===== CurrentHeaterCoolerState (power 기반) =====
    this._bindCharacteristic({
      service,
      characteristic: C.CurrentHeaterCoolerState,
      getter: async () => {
        const on = await lazyGet('power', () => this.smartthings.getPower(deviceId));
        return on ? C.CurrentHeaterCoolerState.COOLING : C.CurrentHeaterCoolerState.INACTIVE;
      },
    });

    // ===== TargetHeaterCoolerState (COOL 고정) =====
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

    // ===== CurrentTemperature (read-only, 자주 변하지 않으므로 캐시 즉답) =====
    this._bindCharacteristic({
      service,
      characteristic: C.CurrentTemperature,
      getter: () => lazyGet('currentTemp', () => this.smartthings.getCurrentTemperature(deviceId)),
    });

    // ===== CoolingThresholdTemperature (목표 온도, 슬라이더 debounce) =====
    const tempProps = resolveTempProps(this.platform.config || {}, configDevice || {});
    const debouncedSetTemp = debounceTrailing(async (value) => {
      const clamped = clampNumber(value, tempProps.minValue, tempProps.maxValue);
      await this.smartthings.setTemperature(deviceId, clamped);
      this._state.coolingSetpoint = clamped;
      this._scheduleResync(
        'coolingSetpoint',
        () => this.smartthings.getCoolingSetpoint(deviceId),
        (actual) => service.updateCharacteristic(
          C.CoolingThresholdTemperature,
          clampNumber(actual, tempProps.minValue, tempProps.maxValue)
        )
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
      setter: (value) => {
        // 슬라이더 드래그 중에는 마지막 값만 실제 전송. in-memory state는 즉시 갱신해 UI 안정화.
        this._state.coolingSetpoint = clampNumber(value, tempProps.minValue, tempProps.maxValue);
        return debouncedSetTemp(value);
      },
    });

    // ===== SwingMode (WindFree 매핑) =====
    const swingBinding = (configDevice.swingBinding || 'windFree');
    if (swingBinding !== 'none') {
      this._bindCharacteristic({
        service,
        characteristic: C.SwingMode,
        getter: async () => (await lazyGet('windFree', () => this.smartthings.getWindFree(deviceId))) ? 1 : 0,
        setter: async (value) => {
          const target = value === 1;
          await this.smartthings.setWindFree(deviceId, target);
          this._state.windFree = target;
          this._scheduleResync(
            'windFree',
            () => this.smartthings.getWindFree(deviceId),
            (actual) => service.updateCharacteristic(C.SwingMode, actual ? 1 : 0)
          );
        }
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
        setter: async (value) => {
          const target = value === 1;
          await this.smartthings.setAutoClean(deviceId, target);
          this._state.autoClean = target;
          this._scheduleResync(
            'autoClean',
            () => this.smartthings.getAutoClean(deviceId),
            (actual) => service.updateCharacteristic(C.LockPhysicalControls, actual ? 1 : 0)
          );
        }
      });
    } else if (service.testCharacteristic(C.LockPhysicalControls)) {
      service.removeCharacteristic(service.getCharacteristic(C.LockPhysicalControls));
    }

    // shutdown 시 진행 중인 resync 타이머 정리
    this.platform.registerShutdown(() => {
      for (const t of this._resyncTimers.values()) clearTimeout(t);
      this._resyncTimers.clear();
    });
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
