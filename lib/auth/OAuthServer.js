'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_PORT = 8999;
const SCOPE = 'r:devices:* w:devices:* x:devices:*';
// v1.8.28 — 요청 body 상한(무제한 축적 방지) 및 웹훅 확인 URL 아웃바운드 타임아웃.
const MAX_BODY_BYTES = 64 * 1024;
const CONFIRM_TIMEOUT_MS = 10000;

class OAuthServer {
  constructor({ log, smartthings, config }) {
    this.log = log;
    this.smartthings = smartthings;
    this.config = config;
    this.server = null;
    this.port = DEFAULT_PORT;
  }

  start(onAuthenticated) {
    let redirectPath;
    try {
      redirectPath = new URL(this.config.redirectUri).pathname || '/';
    } catch (e) {
      this.log.error(`'redirectUri'가 유효한 URL 형식이 아닙니다: ${this.config.redirectUri}`);
      return;
    }

    const launch = () => {
      // v1.8.28 — CSRF/코드 주입 방어용 1회성 state. 콜백 도메인이 리버스 프록시로 외부에
      // 노출된 환경에서, 외부인이 자기 계정의 code를 주입해 브리지를 탈취-바인딩하는 것을 막는다.
      this._state = crypto.randomBytes(16).toString('hex');
      this.server = http.createServer((req, res) => {
        let body = '';
        let overflow = false;
        // v1.8.28 — 스트림 에러 핸들러(중도 절단 시 크래시 방지) + body 크기 상한.
        req.on('error', (e) => { this.log.warn(`인증 서버 요청 스트림 오류: ${e.message}`); });
        req.on('data', chunk => {
          if (overflow) return;
          body += chunk.toString();
          if (body.length > MAX_BODY_BYTES) {
            overflow = true;
            try {
              res.writeHead(413, { 'Content-Type': 'text/plain' });
              res.end('Payload Too Large');
            } catch (_) {}
            req.destroy();
          }
        });
        req.on('end', async () => {
          if (overflow) return;
          // url.parse는 deprecated이지만 호환을 위해 새 URL 사용
          let pathname = '/';
          let queryObj = {};
          try {
            const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            pathname = u.pathname;
            queryObj = Object.fromEntries(u.searchParams.entries());
          } catch (_) {}

          if (req.method === 'GET' && pathname === redirectPath) {
            await this._handleOAuthCallback(req, res, { pathname, query: queryObj }, onAuthenticated);
          } else if (req.method === 'POST') {
            this._handleWebhookConfirmation(req, res, body);
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
          }
        });
      });

      this.server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          this.log.error(`인증 서버가 포트 ${this.port}를 사용할 수 없습니다 (이미 사용 중). 리버스 프록시 또는 다른 프로세스를 확인해주세요.`);
        } else {
          this.log.error(`인증 서버 오류: ${e.message}`);
        }
      });

      this.server.listen(this.port, () => {
        const authUrl = `https://api.smartthings.com/oauth/authorize?client_id=${this.config.clientId}&scope=${encodeURIComponent(SCOPE)}&response_type=code&redirect_uri=${encodeURIComponent(this.config.redirectUri)}&state=${this._state}`;

        this.log.warn('====================[ 스마트싱스 인증 필요 ]====================');
        this.log.warn(`1. 임시 인증 서버가 포트 ${this.port}에서 실행 중입니다.`);
        this.log.warn('2. 아래 URL을 복사하여 웹 브라우저에서 열고, SmartThings에 로그인하여 권한을 허용해주세요.');
        this.log.warn(`인증 URL: ${authUrl}`);
        this.log.warn('3. 권한 허용 후, 자동으로 인증이 처리됩니다.');
        this.log.warn('================================================================');
      });
    };

    if (this.server) {
      // 이전 인스턴스가 listen 중인 동안 새 listen을 시도하면 EADDRINUSE — close 완료 후 launch.
      this.server.close(() => launch());
    } else {
      launch();
    }
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async _handleOAuthCallback(req, res, reqUrl, onAuthenticated) {
    const code = reqUrl.query.code;
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>인증 실패</h1><p>URL에서 인증 코드를 찾을 수 없습니다.</p>');
      return;
    }
    // v1.8.28 — state 검증(1회성): 우리가 발급한 인증 URL을 거치지 않은 code 주입을 차단.
    // 소진은 토큰 교환 "성공 후"에만 한다(아래) — 교환이 일시 실패했을 때 state를 미리 태우면
    // 같은 인증 URL로 재시도할 길이 막혀 재시작 전까지 인증 흐름이 벽돌이 된다.
    if (!this._state || reqUrl.query.state !== this._state) {
      this.log.warn('인증 콜백 state 불일치 — 요청을 무시합니다 (코드 주입 시도 또는 만료된 인증 URL).');
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>인증 실패</h1><p>state가 일치하지 않습니다. Homebridge 로그의 최신 인증 URL로 다시 시도해주세요.</p>');
      return;
    }

    this.log.info('인증 코드를 성공적으로 수신했습니다. 토큰을 발급받습니다...');

    try {
      await this.smartthings.getInitialTokens(code);
      this._state = null; // 교환 성공 — state 1회 사용 소진 (replay는 code가 1회용이라 어차피 실패)
      // 토큰 발급 성공 후에만 브라우저에 성공 응답을 전송한다.
      // (이전엔 응답을 먼저 보내서, 토큰 발급이 실패해도 사용자는 "성공"으로 인식하는 문제가 있었다.)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>인증 성공!</h1><p>SmartThings 인증에 성공했습니다. 이 창을 닫고 Homebridge를 재시작해주세요.</p>');
      this.log.info('최초 토큰 발급 완료! Homebridge를 재시작하면 장치가 연동됩니다.');
      this.stop();
      if (typeof onAuthenticated === 'function') {
        try { await onAuthenticated(); } catch (e) { this.log.error('인증 후 콜백 오류:', e.message); }
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>인증 실패</h1><p>토큰 발급 중 오류가 발생했습니다: ${e.message}</p><p>Homebridge 로그를 확인해주세요.</p>`);
      this.log.error('수신된 코드로 토큰 발급 중 오류 발생:', e.message);
    }
  }

  _handleWebhookConfirmation(req, res, body) {
    try {
      const payload = JSON.parse(body);
      if (payload.lifecycle === 'CONFIRMATION' && payload.confirmationData?.confirmationUrl) {
        const confirmationUrl = payload.confirmationData.confirmationUrl;
        // v1.8.28 — SSRF 방어: 확인 URL 호스트를 SmartThings 도메인으로 화이트리스트.
        // (무인증 POST가 임의 URL을 넣으면 홈서버가 내부망으로 요청을 쏘는 프록시가 됐었다.)
        let host = '';
        try { host = new URL(confirmationUrl).hostname; } catch (_) {}
        const allowed = host === 'api.smartthings.com' || host.endsWith('.smartthings.com');
        if (!allowed) {
          this.log.warn(`Webhook 확인 URL 호스트 불허(${host || '파싱 불가'}) — 요청을 무시합니다.`);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
          return;
        }
        this.log.info('SmartThings로부터 Webhook CONFIRMATION 요청을 수신했습니다. 확인 URL에 접속합니다...');
        this.log.info(`확인 URL: ${confirmationUrl}`);

        const creq = https.get(confirmationUrl, { timeout: CONFIRM_TIMEOUT_MS }, (confirmRes) => {
          confirmRes.resume(); // 응답 스트림 소진(소켓 회수)
          this.log.info(`Webhook 확인 완료, 상태 코드: ${confirmRes.statusCode}`);
        });
        creq.on('timeout', () => creq.destroy(new Error('요청 시간 초과')));
        creq.on('error', (e) => {
          this.log.error(`Webhook 확인 요청 오류: ${e.message}`);
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ targetUrl: confirmationUrl }));
      } else {
        res.writeHead(200);
        res.end();
      }
    } catch (e) {
      this.log.error('POST 요청 처리 중 오류:', e.message);
      res.writeHead(400);
      res.end();
    }
  }
}

module.exports = OAuthServer;
module.exports.SCOPE = SCOPE;
