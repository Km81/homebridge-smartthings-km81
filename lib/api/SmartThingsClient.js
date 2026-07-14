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
    // v1.8.28 — 기기별 "마지막 비-off 명령" 시각. off 재시도(axios 계층)가 그 사이 도착한
    // 사용자 ON 명령을 뒤집지 않도록 재시도 조건에서 참조한다(기기 수만큼만 커져 무해).
    this._lastNonOffCmdTs = new Map();

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
        // 비-멱등 명령(POST /commands)은 재시도 차단: 중복 송신으로 토글이 두 번 실행되는 것을 방지.
        // v1.8.26 — 예외: 단독 switch:off는 멱등(꺼진 기기에 off는 무변화)이고, 심야 자동화의
        // 끄기가 일시 네트워크 오류/429로 유실되면 밤새 켜지는 실피해가 있어 재시도를 허용한다.
        const cfg = err.config || {};
        const method = (cfg.method || '').toLowerCase();
        const isCommandPost = method === 'post' && /\/commands(\?|$)/.test(cfg.url || '');
        if (isCommandPost && !SmartThingsClient._isIdempotentOffCommand(cfg)) return false;
        // v1.8.28 — off 재시도가 그 사이 사용자가 보낸 다른 명령(예: ON)을 뒤집지 않도록,
        // 이 off 발사 이후 같은 기기로 비-off 명령이 나갔으면 재시도를 포기한다.
        // (액세서리 계층의 5s 자가치유는 의도 가드가 있는데 axios 계층엔 없던 층간 불일치 봉합.)
        if (isCommandPost) {
          const sentAt = cfg._sentAt || 0;
          const lastNonOff = cfg._deviceId ? (this._lastNonOffCmdTs.get(cfg._deviceId) || 0) : 0;
          if (lastNonOff > sentAt) {
            this.log.warn('switch:off 재시도 취소 — 이후 같은 기기로 다른 명령이 전송되었습니다.');
            return false;
          }
        }

        const s = err.response?.status;
        return axiosRetry.isNetworkOrIdempotentRequestError(err) || s === 429 || (s >= 500 && s < 600);
      }
    });

    this._setupInterceptors();

    // 5초 TTL: 세탁기 RemainingDuration 실시간성을 위해 짧게 유지
    this.cache = new LRUCache({ max: 100, ttl: 5 * 1000 });
    this.statusPromises = new Map();
    this._statusFailStreaks = new Map(); // 기기별 상태 조회 연속 실패 수 — 복구 로그·스트릭 억제용 (v2.0.0)
  }

  // v1.8.28 — 토큰 엔드포인트 에러 응답에서 안전한 필드만 추출해 로깅한다.
  // raw body 전체를 덤프하면 IdP가 요청 파라미터를 에코하는 경우 code/자격 관련 값이
  // 홈브릿지 로그(파일/UI로 보존)에 남을 수 있다.
  static _safeOAuthError(data) {
    if (!data || typeof data !== 'object') return '';
    const out = {};
    if (data.error) out.error = String(data.error);
    if (data.error_description) out.error_description = String(data.error_description);
    return Object.keys(out).length ? JSON.stringify(out) : '';
  }

  // 명령 본문이 "단독 switch:off"인지 판정 (재시도 허용 판정용).
  // axios 버전에 따라 config.data가 문자열/객체 둘 다 올 수 있어 양쪽 처리.
  static _isIdempotentOffCommand(cfg) {
    let body = cfg?.data;
    if (body == null) return false;
    if (typeof body !== 'string') {
      try { body = JSON.stringify(body); } catch { return false; }
    }
    const commandCount = (body.match(/"command":/g) || []).length;
    return commandCount === 1 && /"capability":"switch"/.test(body) && /"command":"off"/.test(body);
  }

  _setupInterceptors() {
    this.client.interceptors.request.use(
      (cfg) => {
        // 재인증이 진행 중이거나 토큰이 비어있으면 unauth 요청 폭주를 막기 위해 빠르게 거부한다.
        // 새 토큰 발급 후 인터셉터가 다시 정상 동작한다.
        if (!this.tokens?.access_token) {
          const err = new Error('SmartThings 인증 토큰이 없습니다 — 재인증이 필요합니다.');
          err._noToken = true;
          return Promise.reject(err);
        }
        cfg.headers.Authorization = `Bearer ${this.tokens.access_token}`;
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
          // v1.8.26 — 파기(재인증 요구)는 refresh 토큰이 "무효"라고 확인된 경우(400/401,
          // e._fatalAuth)로 한정한다. 네트워크/5xx 등 일시 실패에 토큰 파일을 지우면
          // 아직 유효한 refresh 토큰이 전소되어 수동 재인증 전까지 전 기기가 죽는다.
          if (e._fatalAuth) {
            this.log.error('토큰 갱신 거부(무효 토큰): 재인증이 필요합니다.');
            this._triggerReauth().catch(err => this.log.warn(`재인증 트리거 오류: ${err.message}`));
          } else {
            this.log.warn('토큰 갱신 일시 실패 — 토큰을 보존하고 다음 요청에서 다시 시도합니다.');
          }
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
      this._validateTokenResponse(resp.data, /*requireRefresh=*/true);
      await this._saveTokens(resp.data);
      // 새 인증이 성공하면 _reauthTriggered를 리셋해 다음 만료 시 자동 재시도가 다시 가능하도록.
      this._reauthTriggered = false;
    } catch (e) {
      const safe = SmartThingsClient._safeOAuthError(e.response?.data);
      this.log.error(`초기 토큰 발급 실패: ${e.response?.status || ''} ${safe || e.message}`);
      throw new Error('초기 토큰 발급 실패. 코드/리디렉트 URL을 확인하세요.');
    }
  }

  async refreshToken() {
    if (!this.tokens?.refresh_token) {
      const e = new Error('리프레시 토큰 없음');
      e._fatalAuth = true; // 토큰 자체가 없음 — 재인증 외 방법 없음
      throw e;
    }

    const tokenUrl = 'https://api.smartthings.com/oauth/token';
    const auth = 'Basic ' + Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const previousRefresh = this.tokens.refresh_token;

    // v1.8.26 — 이 POST는 생 axios라 axios-retry가 적용되지 않는다. 갱신이 필요한 바로 그 순간의
    // 일시 장애(네트워크/타임아웃/5xx/429)로 유효한 토큰을 잃지 않도록 여기서 직접 재시도한다.
    // 400/401(invalid_grant)은 refresh 토큰이 무효라는 확정 신호 — 재시도 없이 _fatalAuth로 표시.
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await axios.post(
          tokenUrl,
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: previousRefresh
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: auth }, timeout: 10000 }
        );
        this._validateTokenResponse(resp.data, /*requireRefresh=*/false);
        // 일부 IdP는 refresh_token을 회전시키지 않고 응답에서 누락한다. 기존 값을 보존.
        const merged = {
          ...resp.data,
          refresh_token: resp.data.refresh_token || previousRefresh,
        };
        await this._saveTokens(merged);
        return this.tokens.access_token;
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        if (status === 400 || status === 401) {
          e._fatalAuth = true;
          const safe = SmartThingsClient._safeOAuthError(e.response?.data);
          this.log.error(`토큰 갱신 거부 (status=${status}): refresh 토큰 무효 — 재인증 필요${safe ? ' / ' + safe : ''}`);
          throw e;
        }
        this.log.warn(`토큰 갱신 일시 실패 (status=${status || 'N/A'}, ${attempt}/3): ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    throw lastErr;
  }

  _validateTokenResponse(data, requireRefresh) {
    if (!data || typeof data !== 'object') {
      throw new Error('토큰 응답 형식 오류 — 객체가 아닙니다.');
    }
    if (typeof data.access_token !== 'string' || data.access_token.length < 10) {
      throw new Error('토큰 응답에 access_token이 없습니다.');
    }
    if (requireRefresh && typeof data.refresh_token !== 'string') {
      throw new Error('토큰 응답에 refresh_token이 없습니다.');
    }
  }

  async _saveTokens(tokens) {
    // 메모리 반영은 항상 즉시 한다 — SmartThings는 refresh 토큰을 "회전"시키므로, 새 토큰을
    // 버리면 런타임까지 즉시 죽는다(옛 refresh는 서버에서 이미 무효). 디스크는 재시작 대비용.
    this.tokens = tokens;
    // Atomic write: tmp 파일에 먼저 쓰고 rename으로 교체.
    // 중간에 프로세스가 죽어도 기존 토큰 파일이 truncate되지 않아 재인증을 강제하지 않는다.
    const tmpPath = `${this.tokenPath}.tmp`;
    const payload = JSON.stringify(tokens, null, 2);
    try {
      await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, this.tokenPath);
    } catch (e) {
      // rename 실패 시 평문 토큰이 담긴 tmp 파일이 남지 않도록 정리.
      // unlink 자체도 실패할 수 있으므로(디스크 full / 권한 등) 그 경우 사용자에게 경고.
      try {
        await fs.unlink(tmpPath);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') {
          this.log.warn(`임시 토큰 파일 정리 실패 — 수동 삭제 권장: ${tmpPath} (${unlinkErr.message})`);
        }
      }
      // v1.8.28 — throw하지 않는다. 여기서 throw하면 refreshToken()의 재시도 루프가 갱신 POST를
      // 다시 쏴 토큰을 또 회전시키고(디스크는 여전히 못 씀), 재시작 시 invalid_grant → 전소로
      // 이어진다. 메모리 토큰은 유효하므로 런타임은 정상 — 디스크 문제만 크게 알린다.
      this.log.error(`★ 토큰 디스크 저장 실패(${e.message}) — 지금은 정상 동작하지만, 이 상태로 Homebridge를 재시작하면 재인증이 필요할 수 있습니다. 디스크 용량/권한을 확인하세요: ${this.tokenPath}`);
      return;
    }
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
        // 실패 로그가 찍힌 뒤 첫 성공 — 복구를 명시 (v2.0.0)
        const streak = this._statusFailStreaks.get(deviceId);
        if (streak) {
          this.log.info(`[${deviceId}] 상태 조회 복구 — 연속 ${streak}회 실패 후 정상화`);
          this._statusFailStreaks.delete(deviceId);
        }
        this.cache.set(key, components);
        return components;
      })
      .catch((e) => {
        // 첫 실패만 error, 이후 매 10회 warn, 나머지 debug (장애 지속 시 로그 홍수 방지, v2.0.0)
        const streak = (this._statusFailStreaks.get(deviceId) || 0) + 1;
        this._statusFailStreaks.set(deviceId, streak);
        if (streak === 1) this.log.error(`[${deviceId}] 상태 조회 실패:`, e.message);
        else if (streak % 10 === 0) this.log.warn(`[${deviceId}] 상태 조회 실패 지속 x${streak}:`, e.message);
        else this.log.debug(`[${deviceId}] 상태 조회 실패 x${streak}:`, e.message);
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
      // v1.8.28 — off 재시도 의도 가드용 메타: 비-off 명령은 기기별 시각을 기록하고,
      // 요청 config에 기기/발사시각을 실어 retryCondition이 역전 여부를 판정하게 한다.
      const isOffOnly = SmartThingsClient._isIdempotentOffCommand({ data: { commands } });
      if (!isOffOnly) this._lastNonOffCmdTs.set(deviceId, Date.now());
      await this.client.post(`/devices/${deviceId}/commands`, { commands }, { _deviceId: deviceId, _sentAt: Date.now() });
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
