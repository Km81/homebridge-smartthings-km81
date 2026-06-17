'use strict';

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { LRUCache } = require('lru-cache');
const { default: axiosRetry } = require('axios-retry');

const CAPABILITY = {
  OPTIONAL_MODE: 'custom.airConditionerOptionalMode',
  AUTO_CLEANING: 'custom.autoCleaningMode',
  SWITCH: 'switch',
  MODE: 'airConditionerMode',
  COOL_SETPOINT: 'thermostatCoolingSetpoint',
  TEMP: 'temperatureMeasurement'
};

const TOKEN_FILENAME = 'smartthings_km81_token.json';

class SmartThingsClient {
  constructor(log, api, config) {
    this.log = log;
    this.api = api;
    this.config = config;

    this.tokenPath = path.join(this.api.user.persistPath(), TOKEN_FILENAME);
    this.tokens = null;
    // 401 시 모든 동시 요청을 큐잉하고 단일 refresh Promise를 await하도록 통일.
    // 기존 isRefreshing 플래그는 async 경계에서 두 번 refresh가 시작될 수 있어 단일 Promise로 대체.
    this.refreshPromise = null;
    // refresh 토큰 자체가 만료된 경우 호출되는 재인증 트리거 (index.js에서 등록).
    this._reauthCallback = null;
    this._reauthTriggered = false;

    this.client = axios.create({
      baseURL: 'https://api.smartthings.com/v1',
      timeout: 10000
    });

    axiosRetry(this.client, {
      retries: 3,
      retryDelay: (n, error) => {
        this.log.info(`SmartThings API 재시도 (${n}회차)... 응답코드: ${error.response?.status}`);
        return Math.pow(2, n - 1) * 1000 + Math.random() * 500;
      },
      retryCondition: (err) => {
        // 비-멱등 명령(POST /commands)은 재시도 차단: 중복 송신으로 토글이 두 번 실행되는 것을 방지
        const cfg = err.config || {};
        const method = (cfg.method || '').toLowerCase();
        const isCommandPost = method === 'post' && /\/commands(\?|$)/.test(cfg.url || '');
        if (isCommandPost) return false;

        const s = err.response?.status;
        return axiosRetry.isNetworkOrIdempotentRequestError(err) || s === 429 || (s >= 500 && s < 600);
      }
    });

    this._setupInterceptors();

    // 5초 TTL: 세탁기 RemainingDuration 실시간성을 위해 짧게 유지
    this.cache = new LRUCache({ max: 100, ttl: 5 * 1000 });
    this.statusPromises = new Map();
  }

  _setupInterceptors() {
    this.client.interceptors.request.use(
      (cfg) => {
        if (this.tokens?.access_token) cfg.headers.Authorization = `Bearer ${this.tokens.access_token}`;
        return cfg;
      },
      (e) => Promise.reject(e)
    );

    this.client.interceptors.response.use(
      (res) => res,
      async (error) => {
        const original = error.config;
        if (error.response?.status !== 401 || !original || original._retry) {
          return Promise.reject(error);
        }
        original._retry = true;
        try {
          const newAccess = await this._refreshTokenSingleFlight();
          original.headers = original.headers || {};
          original.headers.Authorization = `Bearer ${newAccess}`;
          return this.client(original);
        } catch (e) {
          this.log.error('토큰 갱신 실패: 재인증이 필요합니다.');
          // refresh 토큰까지 만료된 상태. 1회만 자동 재인증 흐름을 트리거한다.
          this._triggerReauth().catch(err => this.log.warn(`재인증 트리거 오류: ${err.message}`));
          return Promise.reject(e);
        }
      }
    );
  }

  setReauthCallback(fn) {
    this._reauthCallback = typeof fn === 'function' ? fn : null;
  }

  async _triggerReauth() {
    if (this._reauthTriggered) return;
    this._reauthTriggered = true;
    // 만료된 토큰 파일은 삭제해 다음 부팅 시 깨끗한 인증 흐름이 되도록 한다.
    try {
      await fs.unlink(this.tokenPath);
      this.log.warn('만료된 OAuth 토큰 파일을 삭제했습니다.');
    } catch (e) {
      if (e.code !== 'ENOENT') this.log.warn(`토큰 파일 삭제 실패: ${e.message}`);
    }
    this.tokens = null;
    if (this._reauthCallback) {
      try {
        await this._reauthCallback();
      } catch (e) {
        this.log.warn(`재인증 콜백 실패: ${e.message}`);
      }
    } else {
      this.log.warn('Homebridge를 재시작하면 인증 URL이 다시 출력됩니다.');
    }
  }

  // refresh는 동시에 한 번만 수행되고, 동시에 도착한 모든 401 요청은 같은 Promise를 await한다.
  _refreshTokenSingleFlight() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshToken().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async init() {
    try {
      this.tokens = JSON.parse(await fs.readFile(this.tokenPath, 'utf8'));
      this.log.info(`저장된 OAuth 토큰을 성공적으로 불러왔습니다. (${TOKEN_FILENAME})`);
      return true;
    } catch {
      this.log.warn(`저장된 토큰이 없습니다. (${TOKEN_FILENAME}) 사용자 인증이 필요합니다.`);
      return false;
    }
  }

  async getInitialTokens(code) {
    const tokenUrl = 'https://api.smartthings.com/oauth/token';
    const auth = 'Basic ' + Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');

    try {
      const resp = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: auth } }
      );
      await this._saveTokens(resp.data);
    } catch (e) {
      this.log.error(`초기 토큰 발급 실패: ${e.response?.status}`, e.response?.data || e.message);
      throw new Error('초기 토큰 발급 실패. 코드/리디렉트 URL을 확인하세요.');
    }
  }

  async refreshToken() {
    if (!this.tokens?.refresh_token) throw new Error('리프레시 토큰 없음');

    const tokenUrl = 'https://api.smartthings.com/oauth/token';
    const auth = 'Basic ' + Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');

    try {
      const resp = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.tokens.refresh_token
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: auth } }
      );
      await this._saveTokens(resp.data);
      return this.tokens.access_token;
    } catch (e) {
      this.log.error('토큰 갱신 실패:', e.message);
      throw e;
    }
  }

  async _saveTokens(tokens) {
    this.tokens = tokens;
    // Atomic write: tmp 파일에 먼저 쓰고 rename으로 교체.
    // 중간에 프로세스가 죽어도 기존 토큰 파일이 truncate되지 않아 재인증을 강제하지 않는다.
    const tmpPath = `${this.tokenPath}.tmp`;
    const payload = JSON.stringify(tokens, null, 2);
    await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, this.tokenPath);
    this.log.info('토큰 저장/갱신 완료');
  }

  async getDevices() {
    try {
      const res = await this.client.get('/devices');
      return res.data.items || [];
    } catch (e) {
      this.log.error('디바이스 목록 조회 오류:', e.message);
      throw e;
    }
  }

  // 전체 components 객체 반환 (washer가 main, sub, hca.main 모두 접근)
  async getStatus(deviceId) {
    const key = `status-${deviceId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (this.statusPromises.has(deviceId)) return this.statusPromises.get(deviceId);

    const p = this.client
      .get(`/devices/${deviceId}/status`)
      .then((res) => {
        const components = res.data?.components || {};
        this.cache.set(key, components);
        return components;
      })
      .catch((e) => {
        this.log.error(`[${deviceId}] 상태 조회 실패:`, e.message);
        throw new Error(`[${deviceId}] 상태 조회에 실패했습니다.`);
      })
      .finally(() => this.statusPromises.delete(deviceId));

    this.statusPromises.set(deviceId, p);
    return p;
  }

  invalidateStatusCache(deviceId) {
    this.cache.delete(`status-${deviceId}`);
  }

  async sendCommand(deviceId, command) {
    const commands = Array.isArray(command) ? command : [command];
    try {
      this.invalidateStatusCache(deviceId);
      await this.client.post(`/devices/${deviceId}/commands`, { commands });
      this.log.info(`[명령 전송] ${deviceId} -> ${JSON.stringify(commands)}`);
      // 명령 처리가 SmartThings 측에서 반영될 시간을 확보하기 위해 짧은 지연 후 한 번 더 무효화.
      // 그 사이의 status get은 상위 호출자(SmartAC)가 in-memory 캐시로 보호한다.
      setTimeout(() => this.invalidateStatusCache(deviceId), 1500);
    } catch (e) {
      const status = e.response?.status;
      const body = e.response?.data;
      this.log.error(`[명령 전송 실패] ${deviceId}: ${status || ''} ${e.message}${body ? ' / ' + JSON.stringify(body) : ''}`);
      throw e;
    }
  }

  // ===== AC capability helpers (main 컴포넌트 기준) =====
  async _getMainCap(deviceId, capability, attribute, def) {
    const components = await this.getStatus(deviceId);
    const main = components.main || {};
    const shortKey = capability.split('.').pop();
    const obj = main[shortKey] || main[capability];
    const v = obj?.[attribute]?.value;
    return v == null ? def : v;
  }

  async getPower(deviceId) {
    return (await this._getMainCap(deviceId, CAPABILITY.SWITCH, 'switch', 'off')) === 'on';
  }
  async getCurrentTemperature(deviceId) {
    return Number(await this._getMainCap(deviceId, CAPABILITY.TEMP, 'temperature', 18));
  }
  async getCoolingSetpoint(deviceId) {
    return Number(await this._getMainCap(deviceId, CAPABILITY.COOL_SETPOINT, 'coolingSetpoint', 18));
  }
  async getWindFree(deviceId) {
    return (await this._getMainCap(deviceId, CAPABILITY.OPTIONAL_MODE, 'acOptionalMode', 'off')) === 'windFree';
  }
  async getAutoClean(deviceId) {
    return (await this._getMainCap(deviceId, CAPABILITY.AUTO_CLEANING, 'autoCleaningMode', 'off')) === 'on';
  }

  setPower(deviceId, on) {
    return this.sendCommand(deviceId, { component: 'main', capability: CAPABILITY.SWITCH, command: on ? 'on' : 'off' });
  }
  setMode(deviceId, mode) {
    return this.sendCommand(deviceId, {
      component: 'main', capability: CAPABILITY.MODE, command: 'setAirConditionerMode', arguments: [mode]
    });
  }
  setTemperature(deviceId, value) {
    return this.sendCommand(deviceId, {
      component: 'main', capability: CAPABILITY.COOL_SETPOINT, command: 'setCoolingSetpoint', arguments: [value]
    });
  }
  setWindFree(deviceId, enable) {
    return this.sendCommand(deviceId, {
      component: 'main', capability: CAPABILITY.OPTIONAL_MODE, command: 'setAcOptionalMode',
      arguments: [enable ? 'windFree' : 'off']
    });
  }
  setAutoClean(deviceId, enable) {
    return this.sendCommand(deviceId, {
      component: 'main', capability: CAPABILITY.AUTO_CLEANING, command: 'setAutoCleaningMode',
      arguments: [enable ? 'on' : 'off']
    });
  }
}

module.exports = SmartThingsClient;
module.exports.TOKEN_FILENAME = TOKEN_FILENAME;
