'use strict';

const tls = require('tls');
const fs = require('fs');
const { constants } = require('crypto');

const API_PORT = 8888;
const API_DEVICES_PATH = '/devices';
const DEFAULT_RETRY_ATTEMPTS = 3;

const certificateCache = new Map();
function getCertificate(p) {
  if (certificateCache.has(p)) return certificateCache.get(p);
  const buf = fs.readFileSync(p);
  certificateCache.set(p, buf);
  return buf;
}

// v1.8.24 — 같은 IP(같은 기기)를 바라보는 액세서리들이 클라이언트를 공유한다.
// 구형 2in1 에어컨은 단일 연결 서버라, 거실/침실 액세서리가 각자 소켓을 열면
// 동시 접속 경합 + GET /devices 중복(응답 하나에 두 기기 상태가 모두 들어 있음)이 생긴다.
const sharedClients = new Map();

class LegacyACClient {
  // 같은 IP는 하나의 인스턴스를 재사용(요청 직렬화·GET 병합이 기기 단위로 걸리게).
  // 첫 호출자의 token/timeout이 쓰인다 — 같은 기기이므로 실질 동일 전제.
  static getShared(ip, token, log, options) {
    let client = sharedClients.get(ip);
    if (!client) {
      client = new LegacyACClient(ip, token, log, options);
      sharedClients.set(ip, client);
    } else if (client.token !== token || client.timeout !== options.timeout) {
      // 같은 IP의 두 config 블록이 다른 token/timeout을 갖고 있으면 뒤의 값은 무시된다 —
      // 진단이 어려운 조합("토큰 바꿨는데 401")이므로 명시적으로 알린다.
      log.warn(`[LegacyACClient] ${ip} 공유 클라이언트 설정 불일치 — 먼저 생성된 값(timeout ${client.timeout}ms)을 사용합니다. 같은 기기의 config 블록들은 token/timeout을 동일하게 맞추세요.`);
    }
    return client;
  }

  constructor(ip, token, log, options) {
    this.ip = ip;
    this.token = token;
    this.log = log;
    this.timeout = options.timeout;
    // 기기가 동시 연결을 처리하지 못하므로 이 클라이언트를 지나는 모든 요청(GET/PUT)을 직렬화.
    this._queue = Promise.resolve();
    // 진행 중(대기열 포함)인 GET /devices 프라미스 — 동시 폴링을 요청 1개로 병합.
    this._statusInFlight = null;
    // v1.8.26 — 최근 성공 상태 캐시(문자열 보관 — patch 오염 없이 매번 새 객체로 재파싱).
    // 폴링 호출자가 maxAgeMs를 주면 이 창 안에서는 기기 GET을 생략(두 액세서리 폴 공유).
    // PUT마다 무효화되어 명령 후 강제 조회는 항상 실측을 받는다.
    this._statusCache = null;
    this.lastStatusTs = 0; // 마지막으로 서빙한 상태의 실제 fetch 시각(캐시 서빙 포함)
    // PUT 세대 — GET 시작~완료 사이에 PUT이 끼면 그 GET 결과(명령 이전 스냅샷)를 캐시에 넣지 않는다.
    this._putSeq = 0;
    // v1.8.26 — 큐 대기자 수. 무응답 재시도 중 사용자 명령이 대기하면 GET 재시도를 양보한다.
    this._waiting = 0;
    // v1.8.26 — 연속 실패 스트릭(로그 억제용) + 401 래치(무한 반복 로그 방지)
    this._failStreak = 0;
    this._authLatched = false;
    this.tlsOptions = {
      host: this.ip,
      port: API_PORT,
      cert: options.cert,
      key: options.key,
      rejectUnauthorized: false,
      honorCipherOrder: true,
      ciphers: 'DEFAULT@SECLEVEL=0',
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1',
      secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
    };
  }

  async getDeviceStatus(maxAgeMs = 0) {
    // v1.8.26 — 폴링 호출자(maxAgeMs>0)는 최근 성공 응답을 재사용: 한 GET /devices 응답에
    // 두 기기 상태가 모두 들어 있으므로 거실/침실 폴을 실질 1회로 합친다(기기 TLS 부하 절반).
    // 명령 후 강제 조회는 maxAgeMs=0(기본)이라 항상 실측 + PUT마다 캐시 무효화로 이중 안전.
    if (maxAgeMs > 0 && this._statusCache && (Date.now() - this._statusCache.ts) < maxAgeMs) {
      this.lastStatusTs = this._statusCache.ts;
      return JSON.parse(this._statusCache.json);
    }
    // 진행 중(대기열 포함) GET이 있으면 그 결과를 공유 — 거실/침실이 같은 순간 폴링해도 기기에는 1회.
    if (this._statusInFlight) return this._statusInFlight;
    const seq = this._putSeq;
    const p = this._request('GET', API_DEVICES_PATH).then((result) => {
      const ts = Date.now();
      // GET 진행 중 PUT이 끼었으면(seq 변화) 이 결과는 명령 이전 스냅샷 — 캐시 재오염 방지.
      if (seq === this._putSeq) {
        try { this._statusCache = { json: JSON.stringify(result), ts }; } catch { this._statusCache = null; }
      }
      this.lastStatusTs = ts;
      return result;
    });
    this._statusInFlight = p;
    const clear = () => { if (this._statusInFlight === p) this._statusInFlight = null; };
    p.then(clear, clear);
    return p;
  }

  async sendCommand(index, endpoint, data) {
    // 명령이 나가면 직전 상태 스냅샷은 더 이상 진실이 아님 — 캐시 폐기 + 세대 증가
    // (진행 중이던 GET이 완료되며 명령 이전 스냅샷으로 캐시를 되채우는 것도 차단).
    this._statusCache = null;
    this._putSeq++;
    await this._request('PUT', `/devices/${index}${endpoint}`, data);
  }

  // 모든 요청을 기기 단위 큐로 직렬화한다. 실패해도 큐는 계속 흐른다.
  async _request(method, path, data = null, retries = DEFAULT_RETRY_ATTEMPTS) {
    this._waiting++;
    const run = () => {
      this._waiting--;
      return this._requestWithRetry(method, path, data, retries);
    };
    const p = this._queue.then(run, run);
    this._queue = p.then(() => {}, () => {});
    return p;
  }

  async _requestWithRetry(method, path, data, retries) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this._rawRequest(path, method, data);
        // v1.8.26 — 복구 요약: 억제된 실패들이 있었으면 여기서 한 줄로 알린다.
        if (this._failStreak > 1) {
          this.log.info(`[LegacyACClient] 기기 응답 복구 — 연속 ${this._failStreak}회 실패 후 정상화`);
        }
        this._failStreak = 0;
        this._authLatched = false;
        return result;
      } catch (e) {
        // v1.8.24 — 타임아웃 에러 메시지가 한글('요청 시간 초과')이라 기존 영문 코드 정규식에
        // 안 걸려 재시도가 한 번도 돌지 않던 버그 수정. ECONNREFUSED(기기 재부팅 중)도 추가.
        // 단, 응답 대기 타임아웃('요청 시간 초과')은 기기가 명령을 이미 적용했을 수 있는
        // 모호한 실패라 GET만 재시도한다 — PUT을 재전송하면 수신음('띠')이 중복될 수 있다
        // (연결 자체가 안 된 ECONNREFUSED 등은 명령 미적용이 확실해 PUT도 재시도).
        const connectError = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|EPIPE/.test(e.message);
        const responseTimeout = /시간 초과/.test(e.message);
        const isNetworkError = connectError || (responseTimeout && method === 'GET');
        // v1.8.26 — 대기자 양보: 무응답 창에서 GET 재시도 사이클(~18s)이 직렬 큐 선두를 점유하면
        // 뒤에 선 사용자 명령(PUT)이 최악 ~23s 지연된다(시뮬 S2 계측). 다른 요청이 기다리면
        // 폴링 GET은 남은 재시도를 포기한다 — 폴은 10초 뒤 어차피 다시 온다.
        const yieldToWaiter = method === 'GET' && this._waiting > 0;
        if (isNetworkError && attempt < retries && !yieldToWaiter) {
          // 스트릭 중에는 재시도 경고도 소음 — 첫 사이클만 warn.
          if (this._failStreak === 0) {
            this.log.warn(`[LegacyACClient] 네트워크 오류, 재시도 ${attempt}/${retries}... (${e.message})`);
          }
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          this._logFinalFailure(e, attempt, yieldToWaiter && isNetworkError && attempt < retries);
          throw e;
        }
      }
    }
  }

  // v1.8.26 — 실패 로그 억제: 무응답 30분에 640줄이 쌓이던 것을 "첫 실패 상세 + 매 10회째 1줄 +
  // 복구 요약 1줄"로 줄인다. 401(인증 실패)은 래치로 상태 전이 시 1회만 error.
  _logFinalFailure(e, attempt, yielded) {
    const isAuth = /인증 실패/.test(e.message);
    if (isAuth) {
      if (!this._authLatched) {
        this._authLatched = true;
        this.log.error(`[LegacyACClient] ${e.message} — 해소될 때까지 이 오류는 반복 기록하지 않습니다.`);
      }
      return;
    }
    this._failStreak++;
    const suffix = yielded ? ` (대기 중인 명령에 양보 — ${attempt}회만 시도)` : ` (${attempt}회 시도)`;
    if (this._failStreak === 1) {
      this.log.error(`[LegacyACClient] 최종 요청 실패${suffix}: ${e.message}`);
    } else if (this._failStreak % 10 === 0) {
      this.log.warn(`[LegacyACClient] 기기 무응답 지속 — 연속 ${this._failStreak}회 실패 (마지막: ${e.message})`);
    }
    // 그 외에는 침묵(복구 시 요약 1줄) — 상세가 필요하면 debug 레벨.
  }

  _rawRequest(path, method, data) {
    return new Promise((resolve, reject) => {
      const jsonData = data ? JSON.stringify(data) : '';
      const requestData = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${this.ip}`,
        `Authorization: Bearer ${this.token}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(jsonData)}`,
        'Connection: close',
        '',
        jsonData
      ].join('\r\n');

      let settled = false;
      const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
      const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };

      const socket = tls.connect(this.tlsOptions, () => socket.write(requestData));
      let responseChunks = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => { responseChunks += chunk; });
      socket.on('end', () => {
        try {
          // HTTP/1.1 상태 라인 파싱: 일부 펌웨어는 비표준 status line을 보낼 수 있으므로
          // 표준 형식이 잡힐 때만 검증하고, 그렇지 않으면 기존 동작(JSON 파싱 시도)으로 호환 유지.
          const firstLine = responseChunks.split('\r\n', 1)[0] || '';
          const m = firstLine.match(/^HTTP\/1\.\d\s+(\d{3})/);
          if (m) {
            const status = parseInt(m[1], 10);
            if (status === 204) return safeResolve({});
            if (status >= 400) {
              // 인증 만료/권한 거부 등을 명시적으로 surface해서 사용자가 진단 가능하게.
              if (status === 401 || status === 403) {
                return safeReject(new Error(`인증 실패 (status ${status}): 토큰을 다시 추출해야 할 수 있습니다.`));
              }
              return safeReject(new Error(`기기 응답 오류 (status ${status})`));
            }
          } else if (responseChunks.includes('HTTP/1.1 204 No Content')) {
            return safeResolve({});
          }

          const sep = '\r\n\r\n';
          const idx = responseChunks.indexOf(sep);
          if (idx === -1) return safeReject(new Error('HTTP 본문 구분자를 찾을 수 없습니다.'));
          const body = responseChunks.slice(idx + sep.length).trim();
          if (!body) return safeResolve({});
          safeResolve(JSON.parse(body));
        } catch (e) {
          safeReject(new Error(`응답 처리 실패: ${e.message}, 응답: "${responseChunks}"`));
        } finally {
          if (!socket.destroyed) socket.destroy();
        }
      });
      socket.setTimeout(this.timeout, () => {
        socket.destroy();
        safeReject(new Error(`요청 시간 초과 (${this.timeout}ms)`));
      });
      socket.on('error', err => {
        if (!socket.destroyed) socket.destroy();
        safeReject(new Error(`TLS 소켓 오류: ${err.message}`));
      });
    });
  }
}

module.exports = { LegacyACClient, getCertificate };
