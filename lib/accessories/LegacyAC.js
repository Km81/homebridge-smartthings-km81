'use strict';

const path = require('path');
const { LegacyACClient, getCertificate } = require('../api/LegacyACClient');

const CONSTANTS = {
  PLUGIN_VERSION: '1.4.2',
  DEFAULT_CACHE_DURATION_MS: 30000,
  DEFAULT_TIMEOUT_MS: 5000,
  POWER: { ON: 'On', OFF: 'Off' },
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
      this.client = new LegacyACClient(this.config.ip, this.config.token, this.log, {
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

    this.aircoService = this.accessory.getService(this.Service.HeaterCooler) ||
      this.accessory.addService(this.Service.HeaterCooler, this.name);

    this.accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, this.config.manufacturer || 'Samsung')
      .setCharacteristic(this.Characteristic.Model, this.config.model || 'AC-Model')
      .setCharacteristic(this.Characteristic.SerialNumber, this.config.serialNumber || this.name)
      .setCharacteristic(this.Characteristic.FirmwareRevision, CONSTANTS.PLUGIN_VERSION);

    this.setupCharacteristics();
    this.startPolling();

    this.log.info(`[${this.name}] LegacyAC 초기화 완료. (Cool=${this.coolModeStr}, Swing=${this.swingBinding}, Lock=${this.lockBinding})`);
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
    this.log.info(`[${this.name}] 폴링 타이머를 정리합니다.`);
    this._stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
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
    try { await this.getCachedState(true); }
    catch (e) { this.log.error(`[${this.name}] 폴링 중 오류: ${e.message}`); }
    finally {
      if (this._stopped) return;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(() => this._poll(), this.pollingInterval * 1000);
    }
  }

  async getCachedState(force = false) {
    const now = Date.now();
    if (!force && this.deviceState && (now - this.lastStateUpdate < this.cacheDuration)) {
      this.debugLog('캐시된 상태 사용');
      return this.deviceState;
    }
    if (this.stateRequestPromise) return this.stateRequestPromise;
    this.stateRequestPromise = (async () => {
      try {
        const response = await this.client.getDeviceStatus();
        if (!response?.Devices?.[this.deviceIndex]) {
          throw new Error(`API 응답에 장치(index: ${this.deviceIndex})가 없습니다.`);
        }
        this.deviceState = response.Devices[this.deviceIndex];
        this.lastStateUpdate = Date.now();
        return this.deviceState;
      } catch (e) {
        this.log.error(`상태 가져오기 오류: ${e.message}`);
        throw e;
      } finally { this.stateRequestPromise = null; }
    })();
    return this.stateRequestPromise;
  }

  async sendCommand(endpoint, data) {
    // v1.5.x 이전의 1.5초 sig dedupe은 정상적인 사용자 재시도까지 묵음 처리해
    // "켰는데 즉시 꺼져 보임" 깜빡임의 원인이 됐다. 직렬화는 _cmdMutex로 충분히 보장된다.
    const job = async () => {
      this.log.info(`[${this.name}] 명령 전송: ${endpoint || '(root)'} -> ${JSON.stringify(data)}`);
      await this.client.sendCommand(this.setDeviceIndex, endpoint, data);
      await new Promise(r => setTimeout(r, 300));
    };
    this._cmdMutex = this._cmdMutex.then(job, job);
    return this._cmdMutex;
  }

  // 명령 송신 직후, 다음 GET이 device 측 반영 이전 상태를 가져와 UI가 깜빡이는 것을 막기 위해
  // 보내려는 값으로 in-memory deviceState를 먼저 patch한다. 곧이어 force refresh로 보정.
  _patchState(patchFn) {
    try {
      if (!this.deviceState) return;
      patchFn(this.deviceState);
      this.lastStateUpdate = Date.now();
    } catch (e) {
      this.debugLog(`state patch 실패: ${e.message}`);
    }
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
      try {
        const state = await this.getCachedState();
        const value = extractor(state);
        this.debugLog(`> ${name}: ${value}`);
        return value;
      } catch (e) { this.log.error(`GET ${name} 오류:`, e.message); throw e; }
    };
  }

  setupCharacteristics() {
    const C = this.Characteristic;
    const s = this.aircoService;

    s.getCharacteristic(C.Active)
      .onGet(this._createGetter('Active', state => state.Operation?.power === CONSTANTS.POWER.ON ? 1 : 0))
      .onSet(async (value) => {
        this.log.info(`[${this.name}] SET Active -> ${value}`);
        try {
          await this.sendCommand('', {
            Operation: { power: value ? CONSTANTS.POWER.ON : CONSTANTS.POWER.OFF }
          });
          // 다음 GET이 기기 반영 이전 상태를 가져오는 것을 막기 위해 in-memory 우선 갱신
          this._patchState(st => {
            st.Operation = st.Operation || {};
            st.Operation.power = value ? CONSTANTS.POWER.ON : CONSTANTS.POWER.OFF;
          });
          this._refreshState().catch(() => {});
        } catch (e) {
          this.log.error(`SET Active 오류:`, e.message);
          throw e;
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
        try {
          const currentlyOn = this.deviceState?.Operation?.power === CONSTANTS.POWER.ON;
          if (!currentlyOn) {
            await this.sendCommand('', { Operation: { power: CONSTANTS.POWER.ON } });
            this._patchState(st => {
              st.Operation = st.Operation || {};
              st.Operation.power = CONSTANTS.POWER.ON;
            });
          }
          if (this.coolModeStr && this.coolModeStr !== 'none') {
            await this.sendCommand('/mode', { modes: [this.coolModeStr] });
            this._patchState(st => {
              st.Mode = st.Mode || {};
              st.Mode.modes = [this.coolModeStr];
            });
          }
          this._refreshState().catch(() => {});
        } catch (e) {
          this.log.error(`SET TargetState 오류:`, e.message);
          throw e;
        }
      });

    s.getCharacteristic(C.CurrentTemperature)
      .onGet(this._createGetter('CurrentTemp', state => state.Temperatures?.[0]?.current ?? 18));

    // 슬라이더 드래그 중 요청 폭주를 막기 위한 trailing-debounce + in-memory 즉시 patch
    let tempDebounceTimer = null;
    let pendingTempValue = null;
    const flushTempSet = async () => {
      const value = pendingTempValue;
      tempDebounceTimer = null;
      try {
        await this.sendCommand('/temperatures/0', { desired: value });
        this._refreshState().catch(() => {});
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
        // UI 안정을 위해 in-memory state는 즉시 사용자 의도값으로 patch
        this._patchState(st => {
          if (Array.isArray(st.Temperatures) && st.Temperatures[0]) {
            st.Temperatures[0].desired = value;
          }
        });
        if (tempDebounceTimer) clearTimeout(tempDebounceTimer);
        tempDebounceTimer = setTimeout(flushTempSet, 400);
      });

    if (this.swingBinding !== 'none') {
      s.getCharacteristic(C.SwingMode)
        .onGet(this._createGetter('SwingMode', state => this.swingModeHandler.getValue(state) ? 1 : 0))
        .onSet(async (value) => {
          this.log.info(`[${this.name}] SET SwingMode -> ${value}`);
          try {
            const { endpoint, data } = this.swingModeHandler.getCommand(value === 1);
            await this.sendCommand(endpoint, data);
            // Swing 종류에 따라 patch 대상 필드가 다름
            this._patchState(st => {
              if (this.swingBinding === 'wind') {
                st.Wind = st.Wind || {};
                st.Wind.direction = value === 1 ? CONSTANTS.SWING.UP_DOWN : CONSTANTS.SWING.FIX;
              } else {
                st.Mode = st.Mode || {};
                st.Mode.options = st.Mode.options || [];
                const opts = st.Mode.options.filter(
                  o => o !== CONSTANTS.COMFORT.NANO_ON && o !== CONSTANTS.COMFORT.NANO_OFF
                );
                opts.push(value === 1 ? CONSTANTS.COMFORT.NANO_ON : CONSTANTS.COMFORT.NANO_OFF);
                st.Mode.options = opts;
              }
            });
            this._refreshState().catch(() => {});
          } catch (e) { this.log.error(`SET SwingMode 오류:`, e.message); throw e; }
        });
    } else if (s.testCharacteristic(C.SwingMode)) {
      s.removeCharacteristic(s.getCharacteristic(C.SwingMode));
    }

    if (this.lockBinding !== 'none') {
      s.getCharacteristic(C.LockPhysicalControls)
        .onGet(this._createGetter('LockControls', state =>
          state.Mode?.options?.includes(CONSTANTS.AUTOCLEAN.ON) ? 1 : 0))
        .onSet(async (value) => {
          this.log.info(`[${this.name}] SET LockControls -> ${value}`);
          try {
            const opt = value ? CONSTANTS.AUTOCLEAN.ON : CONSTANTS.AUTOCLEAN.OFF;
            await this.sendCommand('/mode', { options: [opt] });
            this._patchState(st => {
              st.Mode = st.Mode || {};
              st.Mode.options = st.Mode.options || [];
              const opts = st.Mode.options.filter(
                o => o !== CONSTANTS.AUTOCLEAN.ON && o !== CONSTANTS.AUTOCLEAN.OFF
              );
              opts.push(opt);
              st.Mode.options = opts;
            });
            this._refreshState().catch(() => {});
          } catch (e) { this.log.error(`SET LockControls 오류:`, e.message); throw e; }
        });
    } else if (s.testCharacteristic(C.LockPhysicalControls)) {
      s.removeCharacteristic(s.getCharacteristic(C.LockPhysicalControls));
    }
  }
}

module.exports = LegacyAC;
