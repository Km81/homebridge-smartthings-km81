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

class LegacyACClient {
  constructor(ip, token, log, options) {
    this.ip = ip;
    this.token = token;
    this.log = log;
    this.timeout = options.timeout;
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

  async getDeviceStatus() {
    return this._request('GET', API_DEVICES_PATH);
  }

  async sendCommand(index, endpoint, data) {
    await this._request('PUT', `/devices/${index}${endpoint}`, data);
  }

  async _request(method, path, data = null, retries = DEFAULT_RETRY_ATTEMPTS) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this._rawRequest(path, method, data);
      } catch (e) {
        const isNetworkError = /ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENOTFOUND/.test(e.message);
        if (isNetworkError && attempt < retries) {
          this.log.warn(`[LegacyACClient] 네트워크 오류, 재시도 ${attempt}/${retries}... (${e.message})`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          this.log.error(`[LegacyACClient] 최종 요청 실패 (${attempt}회 시도): ${e.message}`);
          throw e;
        }
      }
    }
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
