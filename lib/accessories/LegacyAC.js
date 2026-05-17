'use strict';

const path = require('path');
const { LegacyACClient, getCertificate } = require('../api/LegacyACClient');

const CONSTANTS = {
  PLUGIN_VERSION: '1.2.2',
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
    this.swingModeType = this.config.swingModeType ?? 'comfort';
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

    this.swingModeHandler = new SwingModeHandler(this.swingModeType);
    this.deviceState = null;
    this.lastStateUpdate = 0;
    this.stateRequestPromise = null;

    this._cmdMutex = Promise.resolve();
    this._lastTargetStateSetTs = 0;

    this.hkPresets = this._buildHkPresets();

    this.aircoService = this.accessory.getService(this.Service.HeaterCooler) ||
      this.accessory.addService(this.Service.HeaterCooler, this.name);

    this.accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, this.config.manufacturer || 'Samsung')
      .setCharacteristic(this.Characteristic.Model, this.config.model || 'AC-Model')
      .setCharacteristic(this.Characteristic.SerialNumber, this.config.serialNumber || this.name)
      .setCharacteristic(this.Characteristic.FirmwareRevision, CONSTANTS.PLUGIN_VERSION);

    this.setupCharacteristics();
    this.startPolling();

    this.log.info(`[${this.name}] LegacyAC 초기화 완료. (HK presets: ${
      Object.entries(this.hkPresets)
        .filter(([, p]) => p.enabled)
        .map(([n, p]) => `${n}=[${p.modes.join(',')}]`)
        .join(' / ') || '(none)'
    })`);
  }

  _buildHkPresets() {
    const cfg = this.config;
    const norm = (arr) => Array.isArray(arr)
      ? arr.map(s => String(s).trim()).filter(s => s.length > 0)
      : [];

    // v1.2.0+ simple shape: hkCoolMode (enum)
    // Legacy v1.1.x fallback: hkCoolEnabled + hkCoolModes[]
    // v1.2.2: dropped Comode_Nano coupling. Use HomeKit SwingMode for WindFree.
    const resolve = (modeField, enabledField, modesField, defaults) => {
      const mode = cfg[modeField];
      if (typeof mode === 'string' && mode.length > 0) {
        if (mode === 'none') return { enabled: false, modes: [], options: [] };
        return { enabled: true, modes: [mode], options: [] };
      }
      const enabled = cfg[enabledField] === undefined ? defaults.enabled : cfg[enabledField] !== false;
      if (!enabled) return { enabled: false, modes: [], options: [] };
      return {
        enabled: true,
        modes: norm(cfg[modesField] ?? defaults.modes),
        options: []
      };
    };

    return {
      cool: resolve('hkCoolMode', 'hkCoolEnabled', 'hkCoolModes', { enabled: true, modes: ['Cool'] }),
      heat: resolve('hkHeatMode', 'hkHeatEnabled', 'hkHeatModes', { enabled: false, modes: [] }),
      auto: resolve('hkAutoMode', 'hkAutoEnabled', 'hkAutoModes', { enabled: false, modes: [] }),
    };
  }

  _resolvePowerOnPreset() {
    const cfg = this.config;
    if (typeof cfg.powerOnMode === 'string' && cfg.powerOnMode.length > 0) {
      if (cfg.powerOnMode === 'none') return null;
      return { label: cfg.powerOnMode, modes: [cfg.powerOnMode], options: [] };
    }
    const legacy = cfg.powerOnHkMode;
    if (typeof legacy === 'string' && legacy !== 'none' && this.hkPresets[legacy]?.enabled) {
      const p = this.hkPresets[legacy];
      return { label: `(legacy:${legacy}) [${p.modes.join(',')}]`, modes: p.modes, options: p.options };
    }
    return null;
  }

  shutdown() {
    this.log.info(`[${this.name}] 폴링 타이머를 정리합니다.`);
    if (this.pollTimer) clearTimeout(this.pollTimer);
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
    this.debugLog('폴링 실행...');
    try {
      await this.getCachedState(true);
    } catch (e) {
      this.log.error(`[${this.name}] 폴링 중 오류: ${e.message}`);
    } finally {
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
    if (this.stateRequestPromise) {
      this.debugLog('진행 중인 요청에 합류합니다.');
      return this.stateRequestPromise;
    }
    this.debugLog('장치에서 새 상태를 가져옵니다.');
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
      } finally {
        this.stateRequestPromise = null;
      }
    })();
    return this.stateRequestPromise;
  }

  async sendCommand(endpoint, data) {
    // Dedupe identical commands queued within a short window. HomeKit sometimes
    // fires Active + TargetState in parallel; both setters may want to send
    // `power:On`. Without dedupe the legacy AC beeps for each redundant cmd.
    const sig = `${endpoint}:${JSON.stringify(data)}`;
    if (this._lastQueuedSig === sig && Date.now() - this._lastQueuedTs < 1500) {
      this.debugLog(`Command dedupe: ${sig}`);
      return Promise.resolve();
    }
    this._lastQueuedSig = sig;
    this._lastQueuedTs = Date.now();

    // Serialize commands so multiple HomeKit setters firing in parallel don't
    // interleave at the network layer.
    const job = async () => {
      this.log.info(`[${this.name}] 명령 전송: ${endpoint || '(root)'} -> ${JSON.stringify(data)}`);
      await this.client.sendCommand(this.setDeviceIndex, endpoint, data);
      await new Promise(r => setTimeout(r, 300));
    };
    this._cmdMutex = this._cmdMutex.then(job, job);
    return this._cmdMutex;
  }

  async _refreshState() {
    await this.getCachedState(true);
  }

  async _applyPreset(presetName) {
    const preset = this.hkPresets[presetName];
    if (!preset) {
      this.log.warn(`[${this.name}] 알 수 없는 HK preset: ${presetName}`);
      return;
    }
    if (!preset.enabled) {
      this.debugLog(`Preset '${presetName}'은 비활성화되어 적용을 건너뜁니다.`);
      return;
    }
    const hasModes = preset.modes.length > 0;
    const hasOptions = preset.options.length > 0;
    if (!hasModes && !hasOptions) {
      this.debugLog(`Preset '${presetName}'에 modes/options가 비어있어 전송할 게 없습니다.`);
      return;
    }
    if (hasModes) {
      await this.sendCommand('/mode', { modes: preset.modes });
    }
    if (hasOptions) {
      await this.sendCommand('/mode', { options: preset.options });
    }
  }

  _hkValidValues() {
    const C = this.Characteristic.TargetHeaterCoolerState;
    const valid = [];
    if (this.hkPresets.cool.enabled) valid.push(C.COOL);
    if (this.hkPresets.heat.enabled) valid.push(C.HEAT);
    if (this.hkPresets.auto.enabled) valid.push(C.AUTO);
    if (valid.length === 0) valid.push(C.COOL);
    return valid;
  }

  _hkNameFromTargetState(value) {
    const C = this.Characteristic.TargetHeaterCoolerState;
    if (value === C.HEAT) return 'heat';
    if (value === C.AUTO) return 'auto';
    return 'cool';
  }

  _targetStateFromCurrentMode(state) {
    const C = this.Characteristic.TargetHeaterCoolerState;
    const currentMode = state?.Mode?.modes?.[0];
    if (currentMode) {
      for (const name of ['cool', 'heat', 'auto']) {
        const p = this.hkPresets[name];
        if (p.enabled && p.modes.includes(currentMode)) {
          if (name === 'cool') return C.COOL;
          if (name === 'heat') return C.HEAT;
          if (name === 'auto') return C.AUTO;
        }
      }
    }
    if (this.hkPresets.cool.enabled) return C.COOL;
    if (this.hkPresets.heat.enabled) return C.HEAT;
    if (this.hkPresets.auto.enabled) return C.AUTO;
    return C.COOL;
  }

  _createGetter(name, extractor) {
    return async () => {
      this.debugLog(`GET ${name}`);
      try {
        const state = await this.getCachedState();
        const value = extractor(state);
        this.debugLog(`> ${name}: ${value}`);
        return value;
      } catch (e) {
        this.log.error(`GET ${name} 오류:`, e.message);
        throw e;
      }
    };
  }

  setupCharacteristics() {
    const C = this.Characteristic;
    const s = this.aircoService;

    // ===== Active (power) =====
    s.getCharacteristic(C.Active)
      .onGet(this._createGetter('Active', state => state.Operation.power === CONSTANTS.POWER.ON ? 1 : 0))
      .onSet(async (value) => {
        this.log.info(`[${this.name}] SET Active -> ${value}`);
        try {
          await this.sendCommand('', {
            Operation: { power: value ? CONSTANTS.POWER.ON : CONSTANTS.POWER.OFF }
          });
          if (value === 1) {
            const sinceLastTarget = Date.now() - this._lastTargetStateSetTs;
            if (this._lastTargetStateSetTs > 0 && sinceLastTarget < 3000) {
              this.debugLog(`Active=1: 최근(${sinceLastTarget}ms) TargetState 변경 감지, powerOnMode 적용 건너뜀`);
            } else {
              const preset = this._resolvePowerOnPreset();
              if (preset) {
                this.log.info(`[${this.name}] 전원 ON: '${preset.label}' 자동 적용합니다.`);
                if (preset.modes.length > 0) {
                  await this.sendCommand('/mode', { modes: preset.modes });
                }
                if (preset.options.length > 0) {
                  await this.sendCommand('/mode', { options: preset.options });
                }
              }
            }
          }
          await this._refreshState();
        } catch (e) {
          this.log.error(`SET Active 오류:`, e.message);
          throw e;
        }
      });

    // ===== CurrentHeaterCoolerState =====
    s.getCharacteristic(C.CurrentHeaterCoolerState)
      .onGet(this._createGetter('CurrentState', state => {
        if (state.Operation.power !== CONSTANTS.POWER.ON) {
          return C.CurrentHeaterCoolerState.INACTIVE;
        }
        const t = this._targetStateFromCurrentMode(state);
        if (t === C.TargetHeaterCoolerState.HEAT) return C.CurrentHeaterCoolerState.HEATING;
        return C.CurrentHeaterCoolerState.COOLING;
      }));

    // ===== TargetHeaterCoolerState =====
    s.getCharacteristic(C.TargetHeaterCoolerState)
      .setProps({ validValues: this._hkValidValues() })
      .onGet(this._createGetter('TargetState', state => this._targetStateFromCurrentMode(state)))
      .onSet(async (value) => {
        this.log.info(`[${this.name}] SET TargetState -> ${value}`);
        this._lastTargetStateSetTs = Date.now();
        try {
          // If AC is currently off (per cached state), send power=On FIRST so
          // the mode change applies to a powered-on unit. Some legacy AC
          // firmwares ignore mode changes received while off, or apply them
          // in an unexpected order when HomeKit fires Active+TargetState in
          // parallel and TargetState's setter happens to run first.
          const currentlyOn = this.deviceState?.Operation?.power === CONSTANTS.POWER.ON;
          if (!currentlyOn) {
            await this.sendCommand('', { Operation: { power: CONSTANTS.POWER.ON } });
          }
          const name = this._hkNameFromTargetState(value);
          await this._applyPreset(name);
          await this._refreshState();
        } catch (e) {
          this.log.error(`SET TargetState 오류:`, e.message);
          throw e;
        }
      });

    // ===== CurrentTemperature =====
    s.getCharacteristic(C.CurrentTemperature)
      .onGet(this._createGetter('CurrentTemp', state => state.Temperatures[0].current));

    // ===== CoolingThresholdTemperature =====
    s.getCharacteristic(C.CoolingThresholdTemperature)
      .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
      .onGet(this._createGetter('TargetTemp', state => state.Temperatures[0].desired))
      .onSet(async (value) => {
        this.log.info(`[${this.name}] SET TargetTemp -> ${value}`);
        try {
          await this.sendCommand('/temperatures/0', { desired: value });
          await this._refreshState();
        } catch (e) {
          this.log.error(`SET TargetTemp 오류:`, e.message);
          throw e;
        }
      });

    // ===== HeatingThresholdTemperature (only if HEAT enabled) =====
    if (this.hkPresets.heat.enabled) {
      s.getCharacteristic(C.HeatingThresholdTemperature)
        .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
        .onGet(this._createGetter('HeatTargetTemp', state => state.Temperatures[0].desired))
        .onSet(async (value) => {
          this.log.info(`[${this.name}] SET HeatTargetTemp -> ${value}`);
          try {
            await this.sendCommand('/temperatures/0', { desired: value });
            await this._refreshState();
          } catch (e) {
            this.log.error(`SET HeatTargetTemp 오류:`, e.message);
            throw e;
          }
        });
    }

    // ===== SwingMode =====
    if (this.config.enableSwingMode !== false) {
      s.getCharacteristic(C.SwingMode)
        .onGet(this._createGetter('SwingMode', state => this.swingModeHandler.getValue(state) ? 1 : 0))
        .onSet(async (value) => {
          this.log.info(`[${this.name}] SET SwingMode -> ${value}`);
          try {
            const { endpoint, data } = this.swingModeHandler.getCommand(value === 1);
            await this.sendCommand(endpoint, data);
            await this._refreshState();
          } catch (e) {
            this.log.error(`SET SwingMode 오류:`, e.message);
            throw e;
          }
        });
    } else {
      const existing = s.getCharacteristic(C.SwingMode);
      if (existing) s.removeCharacteristic(existing);
    }

    // ===== LockPhysicalControls =====
    if (this.config.enableLockPhysicalControls !== false) {
      s.getCharacteristic(C.LockPhysicalControls)
        .onGet(this._createGetter('LockControls', state =>
          state.Mode.options.includes(CONSTANTS.AUTOCLEAN.ON) ? 1 : 0))
        .onSet(async (value) => {
          this.log.info(`[${this.name}] SET LockControls -> ${value}`);
          try {
            const opt = value ? CONSTANTS.AUTOCLEAN.ON : CONSTANTS.AUTOCLEAN.OFF;
            await this.sendCommand('/mode', { options: [opt] });
            await this._refreshState();
          } catch (e) {
            this.log.error(`SET LockControls 오류:`, e.message);
            throw e;
          }
        });
    } else {
      const existing = s.getCharacteristic(C.LockPhysicalControls);
      if (existing) s.removeCharacteristic(existing);
    }
  }
}

module.exports = LegacyAC;
