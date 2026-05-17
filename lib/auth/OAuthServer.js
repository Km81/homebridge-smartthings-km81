'use strict';

const http = require('http');
const url = require('url');
const https = require('https');

const DEFAULT_PORT = 8999;
const SCOPE = 'r:devices:* w:devices:* x:devices:*';

class OAuthServer {
  constructor({ log, smartthings, config }) {
    this.log = log;
    this.smartthings = smartthings;
    this.config = config;
    this.server = null;
    this.port = DEFAULT_PORT;
  }

  start(onAuthenticated) {
    if (this.server) this.server.close();

    let redirectPath;
    try {
      redirectPath = new URL(this.config.redirectUri).pathname || '/';
    } catch (e) {
      this.log.error(`'redirectUri'가 유효한 URL 형식이 아닙니다: ${this.config.redirectUri}`);
      return;
    }

    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        const reqUrl = url.parse(req.url, true);

        if (req.method === 'GET' && reqUrl.pathname === redirectPath) {
          await this._handleOAuthCallback(req, res, reqUrl, onAuthenticated);
        } else if (req.method === 'POST') {
          this._handleWebhookConfirmation(req, res, body);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });
    }).listen(this.port, () => {
      const authUrl = `https://api.smartthings.com/oauth/authorize?client_id=${this.config.clientId}&scope=${encodeURIComponent(SCOPE)}&response_type=code&redirect_uri=${encodeURIComponent(this.config.redirectUri)}`;

      this.log.warn('====================[ 스마트싱스 인증 필요 ]====================');
      this.log.warn(`1. 임시 인증 서버가 포트 ${this.port}에서 실행 중입니다.`);
      this.log.warn('2. 아래 URL을 복사하여 웹 브라우저에서 열고, SmartThings에 로그인하여 권한을 허용해주세요.');
      this.log.warn(`인증 URL: ${authUrl}`);
      this.log.warn('3. 권한 허용 후, 자동으로 인증이 처리됩니다.');
      this.log.warn('================================================================');
    });

    this.server.on('error', (e) => { this.log.error(`인증 서버 오류: ${e.message}`); });
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

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>인증 성공!</h1><p>SmartThings 인증에 성공했습니다. 이 창을 닫고 Homebridge를 재시작해주세요.</p>');
    this.log.info('인증 코드를 성공적으로 수신했습니다. 토큰을 발급받습니다...');

    try {
      await this.smartthings.getInitialTokens(code);
      this.log.info('최초 토큰 발급 완료! Homebridge를 재시작하면 장치가 연동됩니다.');
      this.stop();
      if (typeof onAuthenticated === 'function') {
        try { await onAuthenticated(); } catch (e) { this.log.error('인증 후 콜백 오류:', e.message); }
      }
    } catch (e) {
      this.log.error('수신된 코드로 토큰 발급 중 오류 발생:', e.message);
    }
  }

  _handleWebhookConfirmation(req, res, body) {
    try {
      const payload = JSON.parse(body);
      if (payload.lifecycle === 'CONFIRMATION' && payload.confirmationData?.confirmationUrl) {
        const confirmationUrl = payload.confirmationData.confirmationUrl;
        this.log.info('SmartThings로부터 Webhook CONFIRMATION 요청을 수신했습니다. 확인 URL에 접속합니다...');
        this.log.info(`확인 URL: ${confirmationUrl}`);

        https.get(confirmationUrl, (confirmRes) => {
          this.log.info(`Webhook 확인 완료, 상태 코드: ${confirmRes.statusCode}`);
        }).on('error', (e) => {
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
