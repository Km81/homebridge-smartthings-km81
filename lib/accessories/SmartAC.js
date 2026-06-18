'use strict';

// 명령 전송 후 실제 상태로 재동기화하기까지의 지연(ms).
// 이 시간 동안 in-memory _state가 사용자 의도를 보존해 UI 깜빡임("켰는데 즉시 꺼짐")을 막는다.
const RESYNC_DELAY_MS = 2000;
// 슬라이더 드래그 시 마지막 값만 보내기 위한 trailing-debounce 간격(ms).
const SLIDER_DEBOUNCE_MS = 400;
// 외부 변경(SmartThings 앱/리모컨) 반영을 위한 백그라운드 폴링 최소 간격.
// v1.8.10: 최소 폴링 간격을 10초까지 허용 (SmartThings API rate limit 대비 충분히 여유).
// 1회 폴링당 실제 네트워크 호출은 GET /status 1회 (5개 필드는 5초 LRU 캐시 공유).
// 10초보다 더 낮추면 burst limit 충돌 / HomeKit setter와의 race 위험이 생긴다.
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
  const safeStep = 1;
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
    const C = this.Characteristic;
    accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'Samsung')
      .setCharacteristic(C.Model, configDevice.model || 'AC-Model')
      .setCharacteristic(C.SerialNumber, configDevice.serialNumber || accessory.context.device.deviceId)
      .setCharacteristic(C.FirmwareRevision, packageVersion);

    // 재-configure 안전성: 이전 타이머/핸들 정리
    if (this._resyncTimers) for (const t of this._resyncTimers.values()) clearTimeout(t);
    if (this._backgroundPollTimer) clearTimeout(this._backgroundPollTimer);

    // 공유 상태: get 핸들러가 즉답하고 setter가 의도값을 보존
    this._state = {
      power: undefined,
      currentTemp: undefined,
      coolingSetpoint: undefined,
      windFree: undefined,
      autoClean: undefined,
    };
    this._resyncTimers = new Map();
    this._stateSeq = new Map();
    this._backgroundPollTimer = null;
    this._stopped = false;
    // 옵셔널 스위치 service 참조 (선언만 — 실제는 _setupOptionalSwitches에서 채움).
    // SwingMode/Lock과 같은 capability를 공유하므로 setter가 양쪽 service를 함께 push해야 한다.
    this._linkedSwitchServices = { windFree: null, autoClean: null };

    this._setupHeaterCooler(accessory, configDevice);
    this._setupOptionalSwitches(accessory.context.device, configDevice, packageVersion);
    this._setupBackgroundPolling(accessory, configDevice);

    this.platform.registerShutdown(() => {
      this._stopped = true;
      for (const t of this._resyncTimers.values()) clearTimeout(t);
      this._resyncTimers.clear();
      if (this._backgroundPollTimer) clearTimeout(this._backgroundPollTimer);
    });
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
    this._mainService = service;

    // _state가 비어 있을 때만 SmartThings에서 fetch (lazy seeding)
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
        // Idempotency: 이미 같은 상태면 명령 생략 (SmartThings POST 절약)
        if (this._state.power === target) {
          this.log.debug?.(`[${service.displayName}] Active 이미 ${target} — 명령 생략`);
          return;
        }
        await this.smartthings.setPower(deviceId, target);
        this._state.power = target;
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
    const ALLOWED_COOL_CMDS = new Set(['cool', 'coolClean', 'dry', 'dryClean']);
    const rawCoolCmd = configDevice.coolCommand || configDevice.coolModeCommand || 'cool';
    const coolCmd = ALLOWED_COOL_CMDS.has(rawCoolCmd) ? rawCoolCmd : 'cool';
    this._bindCharacteristic({
      service,
      characteristic: C.TargetHeaterCoolerState,
      props: { validValues: [C.TargetHeaterCoolerState.COOL] },
      getter: () => C.TargetHeaterCoolerState.COOL,
      setter: async (value) => {
        if (value !== C.TargetHeaterCoolerState.COOL) return;
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
    // 주의(v1.7.2 LegacyAC 버그와 동형): setter에서 _state를 즉시 patch하면 idempotency가 자신과
    // 비교되어 명령이 항상 생략된다. _state.coolingSetpoint는 send 성공 후에만 갱신.
    let lastSentSetpoint = null;
    const debouncedSetTemp = debounceTrailing(async (value) => {
      const clamped = clampNumber(value, tempProps.minValue, tempProps.maxValue);
      if (lastSentSetpoint === clamped) {
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
    const swingBinding = (configDevice.swingBinding || 'windFree');
    if (swingBinding !== 'none') {
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
  async _setWindFree(deviceId, target, originService) {
    const C = this.Characteristic;
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
    if (this._mainService && this._mainService !== originService && this._mainService.testCharacteristic(C.SwingMode)) {
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
        getter: async () => {
          if (this._state[stateKey] === undefined) {
            this._state[stateKey] = await fetchFn();
          }
          return !!this._state[stateKey];
        },
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
      if (!Number.isFinite(n) || n <= 0) return; // 명시적 비활성
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
          const autoClean = await this.smartthings.getAutoClean(deviceId);

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
          if (this._state.windFree !== windFree) {
            this._state.windFree = windFree;
            if (main.testCharacteristic(C.SwingMode)) main.updateCharacteristic(C.SwingMode, windFree ? 1 : 0);
            if (this._linkedSwitchServices.windFree) this._linkedSwitchServices.windFree.updateCharacteristic(C.On, !!windFree);
          }
          if (this._state.autoClean !== autoClean) {
            this._state.autoClean = autoClean;
            if (main.testCharacteristic(C.LockPhysicalControls)) main.updateCharacteristic(C.LockPhysicalControls, autoClean ? 1 : 0);
            if (this._linkedSwitchServices.autoClean) this._linkedSwitchServices.autoClean.updateCharacteristic(C.On, !!autoClean);
          }
        }
      } catch (e) {
        this.log.debug?.(`SmartAC 폴링 오류: ${e.message}`);
      } finally {
        if (!this._stopped) this._backgroundPollTimer = setTimeout(pollOnce, sec * 1000);
      }
    };
    this.log.info(`[${accessory.displayName}] SmartAC 백그라운드 폴링 시작 (${sec}s).`);
    this._backgroundPollTimer = setTimeout(pollOnce, sec * 1000);
  }
}

module.exports = SmartAC;
