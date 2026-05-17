'use strict';

const path = require('path');
const { LegacyACClient, getCertificate } = require('../api/LegacyACClient');

const CONSTANTS = {
  PLUGIN_VERSION: '1.0.0',
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

    // 통합 패키지 cert/ 폴더 기준 fallback
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

    this.aircoService = this.accessory.getService(this.Service.HeaterCooler) ||
      this.accessory.addService(this.Service.HeaterCooler, this.name);

    this.accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, this.config.manufacturer || 'Samsung')
      .setCharacteristic(this.Characteristic.Model, this.config.model || 'AC-Model')
      .setCharacteristic(this.Characteristic.SerialNumber, this.config.serialNumber || this.name)
      .setCharacteristic(this.Characteristic.FirmwareRevision, CONSTANTS.PLUGIN_VERSION);

    this.setupCharacteristics();
    this.startPolling();

    this.log.info(`[${this.name}] LegacyAC 초기화 완료.`);
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
    this.log.info(`[${this.name}] 명령 전송: ${endpoint} -> ${JSON.stringify(data)}`);
    await this.client.sendCommand(this.setDeviceIndex, endpoint, data);
    await new Promise(r => setTimeout(r, 500));
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
      } catch (e) {
        this.log.error(`GET ${name} 오류:`, e.message);
        throw e;
      }
    };
  }

  _createSetter(name, commandBuilder) {
    return async (value) => {
      this.log.info(`[${this.name}] SET ${name} -> ${value}`);
      try {
        const { endpoint, data } = commandBuilder(value);
        await this.sendCommand(endpoint, data);
      } catch (e) {
        this.log.error(`SET ${name} 오류:`, e.message);
        throw e;
      }
    };
  }

  setupCharacteristics() {
    const C = this.Characteristic;
    const s = this.aircoService;

    s.getCharacteristic(C.Active)
      .onGet(this._createGetter('Active', state => state.Operation.power === CONSTANTS.POWER.ON ? 1 : 0))
      .onSet(this._createSetter('Active', value => ({
        endpoint: '',
        data: { Operation: { power: value ? CONSTANTS.POWER.ON : CONSTANTS.POWER.OFF } }
      })));

    s.getCharacteristic(C.CurrentHeaterCoolerState)
      .onGet(this._createGetter('CurrentState', state =>
        state.Operation.power !== CONSTANTS.POWER.ON
          ? C.CurrentHeaterCoolerState.INACTIVE
          : C.CurrentHeaterCoolerState.COOLING));

    s.getCharacteristic(C.TargetHeaterCoolerState)
      .setProps({ validValues: [C.TargetHeaterCoolerState.COOL] })
      .onGet(this._createGetter('TargetState', () => C.TargetHeaterCoolerState.COOL))
      .onSet(value => this.log.info(`[${this.name}] SET TargetState -> ${value} (COOL 모드만 지원)`));

    s.getCharacteristic(C.CurrentTemperature)
      .onGet(this._createGetter('CurrentTemp', state => state.Temperatures[0].current));

    s.getCharacteristic(C.CoolingThresholdTemperature)
      .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
      .onGet(this._createGetter('TargetTemp', state => state.Temperatures[0].desired))
      .onSet(this._createSetter('TargetTemp', value => ({
        endpoint: '/temperatures/0',
        data: { desired: value }
      })));

    s.getCharacteristic(C.SwingMode)
      .onGet(this._createGetter('SwingMode', state => this.swingModeHandler.getValue(state) ? 1 : 0))
      .onSet(this._createSetter('SwingMode', value => this.swingModeHandler.getCommand(value === 1)));

    s.getCharacteristic(C.LockPhysicalControls)
      .onGet(this._createGetter('LockControls', state =>
        state.Mode.options.includes(CONSTANTS.AUTOCLEAN.ON) ? 1 : 0))
      .onSet(this._createSetter('LockControls', value => ({
        endpoint: '/mode',
        data: { options: [value ? CONSTANTS.AUTOCLEAN.ON : CONSTANTS.AUTOCLEAN.OFF] }
      })));
  }
}

module.exports = LegacyAC;
