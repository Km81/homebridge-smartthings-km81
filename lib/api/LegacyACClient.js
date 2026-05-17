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

      const socket = tls.connect(this.tlsOptions, () => socket.write(requestData));
      let responseChunks = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => { responseChunks += chunk; });
      socket.on('end', () => {
        try {
          if (responseChunks.includes('HTTP/1.1 204 No Content')) return resolve({});
          const sep = '\r\n\r\n';
          const idx = responseChunks.indexOf(sep);
          if (idx === -1) return reject(new Error('HTTP 본문 구분자를 찾을 수 없습니다.'));
          const body = responseChunks.slice(idx + sep.length).trim();
          if (!body) return resolve({});
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`응답 처리 실패: ${e.message}, 응답: "${responseChunks}"`));
        } finally {
          if (!socket.destroyed) socket.destroy();
        }
      });
      socket.setTimeout(this.timeout, () => {
        socket.destroy();
        reject(new Error(`요청 시간 초과 (${this.timeout}ms)`));
      });
      socket.on('error', err => {
        if (!socket.destroyed) socket.destroy();
        reject(new Error(`TLS 소켓 오류: ${err.message}`));
      });
    });
  }
}

module.exports = { LegacyACClient, getCertificate };
