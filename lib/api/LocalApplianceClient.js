'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { AsyncLocalStorage } = require('async_hooks');
const { CONNECTION_ERROR_RE } = require('../shared');

// 기기별 순서 체인의 '실행 컨텍스트' — 재진입(체인 내부 파생 호출) 판별에 쓴다.
const CHAIN_CTX = new AsyncLocalStorage();

// 로컬(DTLS-CoAP) 가전 클라이언트.
// SmartThingsClient와 "같은 메서드 이름·같은 반환 형태"를 제공해, 액세서리 코드를
// 한 줄도 고치지 않고 transport만 바꿔 끼울 수 있게 한다.
//
// 실제 DTLS 통신은 파이썬 자식 프로세스(lib/local/bridge.py)가 담당한다 —
// Node에는 DTLS 구현이 없고, 유일한 후보 라이브러리는 이 기기와 ClientHello 단계에서
// 실패하는 것을 실측했다(2026-07-28). 별도 컨테이너는 만들지 않는다: 홈브릿지 컨테이너에
// 파이썬 3.12가 이미 있고, /homebridge는 이미지 갱신에도 남는 영구 볼륨이다.

const DEFAULT_STATE_DIR = '/homebridge/.km81-local';
const REQUEST_TIMEOUT_MS = 20000;   // 최초 요청은 DTLS 핸드셰이크를 포함한다
const PIP_TIMEOUT_MS = 180000;      // 의존성 설치가 영원히 매달리지 않게
const CACHE_TTL_MS = 3000;      // 폴 1회에 5~6개 리소스를 연달아 읽으므로 그 버스트만 합친다
const RESTART_BACKOFF_MS = [2000, 5000, 15000, 30000];
const WRITE_SETTLE_MS = 8000;   // 쓰기 직후 이 창에서는 읽기를 클라우드로 폴백하지 않는다
const PORT_RESET_AFTER = 3;     // 연속 실패 N회면 학습 포트를 버리고 재탐지
// 읽기 폴백 유예: 이 횟수 미만의 연속 실패는 클라우드로 넘어가지 않고 다음 폴을 기다린다.
// 2 = "한 번은 봐준다". 부팅 직후 첫 접촉 실패(DTLS 세션 수립 지연)가 정확히 1회짜리라
// 이 값 하나로 재시작마다 나가던 클라우드 호출이 사라진다. 쓰기에는 적용하지 않는다.
const READ_FALLBACK_AFTER = 2;
const LOCAL_DEAD_AFTER = 10;    // 연속 실패 N회면 '사실상 클라우드 동작' 경고 승격

// 클라우드 모드 이름 → 로컬 OCF 모드 이름.
// ★config.schema.json의 coolModeCommand 선택지(cool/coolClean/dry/dryClean)를 전부 덮어야 한다.
// 기기의 로컬 supportedModes는 ['AIComfort','Cool','Dry','Fan']뿐이라 '청정' 변형은 대응이 없어
// 각각 Cool/Dry로 근사한다(실측: 승준 에어컨 AW7000). 매핑이 없으면 조용히 넘기지 말고
// 예외로 올려 클라우드 폴백을 태운다 — 무성 유실이 최악이다.
const MODE_MAP = {
  cool: 'Cool',
  coolclean: 'Cool',     // 냉방청정 → 로컬 Cool 근사
  dry: 'Dry',
  dryclean: 'Dry',       // 제습청정 → 로컬 Dry 근사
  wind: 'Fan',
  fan: 'Fan',
  auto: 'AIComfort',
  aicomfort: 'AIComfort',
};

class LocalApplianceClient {
  constructor(log, opts = {}) {
    this.log = log;
    this.stateDir = opts.stateDir || DEFAULT_STATE_DIR;
    this.libDir = opts.libDir || path.join(this.stateDir, 'lib');
    this.certPath = opts.certPath || path.join(this.stateDir, 'certs', 'fullchain.pem');
    this.keyPath = opts.keyPath || path.join(this.stateDir, 'certs', 'leaf.key');
    this.caPath = opts.caPath || path.join(__dirname, '..', '..', 'cert', 'cert.pem');
    this.pythonBin = opts.pythonBin || 'python3';
    this.cloud = opts.cloudClient || null;   // 폴백 대상

    this.devices = new Map();   // deviceId → { host, port, label, kind, localPort }
    this._pending = new Map();  // rpc id → { resolve, reject, timer }
    this._cache = new Map();    // `${deviceId}|${path}` → { ts, value }
    this._chains = new Map();   // deviceId → Promise (기기별 직렬화 체인)
    this._inChain = new Map();  // deviceId → 체인 실행 중 (재진입 허용용)
    this._lastWriteTs = new Map();   // deviceId → 마지막 로컬 쓰기 시각
    this._fallbackStreak = new Map();// deviceId → 연속 실패 횟수
    this._fallbackSince = new Map(); // deviceId → 폴백 시작 시각 (복귀 알림용, v2.3.6)
    this._verified = new Map();      // deviceId → 신원 확인 결과
    this._seq = 0;
    this._proc = null;
    this._ready = false;
    this._readyWaiters = [];
    this._restarts = 0;
    this._stopped = false;
  }

  // ===== 기기 등록 =====
  registerDevice(deviceId, info) {
    this.devices.set(deviceId, info);
    this.log.info(`[${info.label}] 로컬 경로 등록 — ${info.host}:${info.port || '포트 자동 탐지'}`);
  }

  // 브릿지가 포트를 탐지했으면 그 값을 받아 두 번째 요청부터 바로 쓴다(로그도 1회만).
  _learnPort(deviceId, port) {
    const d = this.devices.get(deviceId);
    if (d && port && d.port !== port) {
      d.port = port;
      this.log.info(`[${this._labelOf(deviceId)}] DTLS 포트 확인됨 — ${port}`);
    }
  }

  // v2.3.6 — 브릿지(파이썬) 로그를 사람이 읽는 형태로 바꿔 중계한다.
  //   ① "[로컬] … 192.168.1.62:49155" → "[건조기] … 49155"
  //      (IP만 찍혀서 어느 기기인지 알 수 없다는 사용자 지적)
  //   ② level에 따라 debug/warn으로 내려보낸다 — 정상 동작인 세션 연결/해제는 debug라
  //      평소 로그에서 사라지고, 폴백·복귀 같은 진짜 사건만 남는다.
  //   레벨이 없는 옛 브릿지 메시지는 info로 처리해 하위 호환을 지킨다.
  _relayBridgeLog(msg) {
    const level = ['debug', 'info', 'warn', 'error'].includes(msg.level) ? msg.level : 'info';
    let text = String(msg.message == null ? '' : msg.message);
    let tag = '로컬';
    for (const [, d] of this.devices) {
      if (!d.host || !text.includes(d.host)) continue;
      tag = d.label || tag;
      const esc = d.host.replace(/\./g, '\\.');
      // "192.168.1.62:49155" → "49155" / 포트가 안 붙은 IP는 통째로 지운다.
      // 태그에 이미 기기 이름이 있으므로 "기기" 같은 대체어를 넣으면 군더더기가 된다
      // ("포트 자동 탐지: 기기 → 49155" → "포트 자동 탐지 → 49155").
      text = text.replace(new RegExp(esc + ':(\\d+)', 'g'), '$1')
        .replace(new RegExp(esc, 'g'), '')
        .replace(/\s*:\s*(?=→|$)/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      break;
    }
    const fn = this.log[level] || this.log.info;
    fn.call(this.log, `[${tag}] ${text}`);
  }

  registerDeviceLabel(deviceId, label) {
    const d = this.devices.get(deviceId);
    if (d) d.label = label;
  }

  _labelOf(deviceId) {
    return this.devices.get(deviceId)?.label || deviceId;
  }

  // ===== 프로세스 수명주기 =====
  async start() {
    await this._ensureDeps();
    this._spawn();
    return this._waitReady();
  }

  stop() {
    this._stopped = true;
    if (this._proc) {
      try { this._proc.kill(); } catch (_) { /* 이미 종료됨 */ }
      this._proc = null;
    }
  }

  // 파이썬 의존성은 영구 볼륨(/homebridge/.km81-local/lib)에 1회만 설치한다.
  // node_modules 밖이라 npm 재설치·플러그인 업데이트에도 살아남는다.
  async _ensureDeps() {
    // v2.2.1 — 완료 스탬프로 판정한다(감사 MEDIUM-1). 디렉터리 존재만 보면 중단된 설치가
    // 껍데기만 남겼을 때 영구히 import 실패한다.
    const stamp = path.join(this.libDir, '.km81-install-ok');
    if (fs.existsSync(stamp)) return;
    this.log.info('로컬 경로 의존성 최초 설치 — 잠시 걸립니다');
    await new Promise((resolve, reject) => {
      const p = spawn(this.pythonBin, ['-m', 'pip', 'install', '-q',
        '--target', this.libDir, 'smartthings-local'], { stdio: 'inherit' });
      // 타임아웃이 없으면 정착하지 않는 프라미스가 되어 기기 바인딩이 통째로 멈춘다.
      const timer = setTimeout(() => {
        try { p.kill(); } catch (_) { /* 이미 종료됨 */ }
        reject(new Error('의존성 설치 시간 초과(180초)'));
      }, PIP_TIMEOUT_MS);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`의존성 설치 실패 (코드 ${code})`));
        try { fs.writeFileSync(stamp, new Date().toISOString()); } catch (_) { /* 스탬프 실패는 치명적이지 않음 */ }
        resolve();
      });
    });
    this.log.info('로컬 경로 의존성 설치됨');
  }

  _spawn() {
    if (this._stopped) return;
    const script = path.join(__dirname, '..', 'local', 'bridge.py');
    this._proc = spawn(this.pythonBin, ['-u', script], {
      env: {
        ...process.env,
        KM81_LOCAL_LIB: this.libDir,
        KM81_LOCAL_CERT: this.certPath,
        KM81_LOCAL_KEY: this.keyPath,
        KM81_LOCAL_CA: this.caPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    readline.createInterface({ input: this._proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return this.log.debug?.(`브릿지 출력: ${line}`); }
      this._onMessage(msg);
    });

    // v2.2.3 — stdin 파손(EPIPE) 처리. 브릿지가 죽는 순간 요청을 쓰면 unhandled 'error'로
    // 홈브릿지 전체(구형 에어컨 포함)가 같이 죽는다. 반경을 로컬 경로로 가둔다.
    this._proc.stdin.on('error', (err) => {
      this.log.warn(`로컬 브릿지 입력 파이프 오류: ${err.message}`);
    });

    this._proc.stderr.on('data', (b) => {
      const s = String(b).trim();
      if (s) this.log.warn(`로컬 브릿지 오류 출력: ${s.split('\n').slice(-3).join(' / ')}`);
    });

    // spawn 자체가 실패하는 경우(파이썬 미설치 등) — 처리하지 않으면 unhandled 'error'로
    // 홈브릿지 전체가 죽는다. 여기서 삼키고 아래 exit 경로의 재시작·폴백으로 흘려보낸다.
    this._proc.on('error', (err) => {
      this.log.error(`로컬 브릿지 실행 실패: ${err.message} (파이썬 설치 여부 확인) — 클라우드로 동작합니다`);
      this._ready = false;
      const waiters = this._readyWaiters.splice(0);
      waiters.forEach(w => w.reject(err));
    });

    this._proc.on('exit', (code) => {
      this._ready = false;
      this._proc = null;
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error('로컬 브릿지가 종료됨'));
      }
      this._pending.clear();
      // v2.2.1 — ready를 기다리던 쪽도 반드시 깨운다(감사 HIGH-3).
      // 브릿지가 ready 전에 죽으면(예: 파이썬 의존성 파손) 아무도 깨우지 않아
      // 기기 바인딩이 120초 멈추고, 그동안 홈킷 조작이 조용히 유실된다.
      const waiters = this._readyWaiters.splice(0);
      waiters.forEach(w => w.reject(new Error(`로컬 브릿지가 준비 전에 종료됨(코드 ${code})`)));
      if (this._stopped) return;
      const delay = RESTART_BACKOFF_MS[Math.min(this._restarts, RESTART_BACKOFF_MS.length - 1)];
      this._restarts += 1;
      this.log.warn(`로컬 브릿지 종료됨(코드 ${code}) — ${delay / 1000}초 뒤 재시작 (${this._restarts}회째)`);
      setTimeout(() => this._spawn(), delay);
    });
  }

  _onMessage(msg) {
    if (msg.event === 'ready') {
      this._ready = !!msg.ok;
      if (msg.ok) {
        this._restarts = 0;
        this.log.info('로컬 브릿지 준비됨');
      } else {
        this.log.error(`로컬 브릿지 준비 실패: ${msg.error}`);
      }
      const waiters = this._readyWaiters.splice(0);
      waiters.forEach(w => msg.ok ? w.resolve() : w.reject(new Error(msg.error)));
      return;
    }
    if (msg.event === 'log') return this._relayBridgeLog(msg);
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) return p.resolve(msg);
    const err = new Error(msg.error || '로컬 요청 실패');
    err.sent = msg.sent === true;   // 브릿지가 '명령을 이미 내보냈을 수 있음'으로 표시
    p.reject(err);
  }

  _waitReady() {
    if (this._ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this._readyWaiters.push({ resolve, reject });
      setTimeout(() => reject(new Error('로컬 브릿지 준비 대기 시간 초과')), 120000);
    });
  }

  _rpc(payload) {
    if (!this._proc || !this._ready) return Promise.reject(new Error('로컬 브릿지 미준비'));
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const e = new Error('로컬 요청 시간 초과');
        // 쓰기는 이미 기기로 나갔을 수 있다 = 결과 불명. 읽기는 재시도해도 안전하다.
        e.sent = payload.op === 'post';
        reject(e);
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      this._proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  // ===== 저수준 접근 =====
  _dev(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d) throw new Error(`로컬 경로 미등록 기기: ${deviceId}`);
    return d;
  }

  // v2.2.1 — 기기별 직렬화(감사 HIGH-2). 같은 기기로 가는 요청이 겹치면 브릿지가
  // 스레드를 병렬로 띄워 도착 순서가 뒤집힐 수 있다. 끄기 뒤에 모드가 착탄하면 재점등한다.
  // 기기당 DTLS 세션이 어차피 1개라 병렬로 얻는 이득도 없다.
  // v2.2.3 — 재진입 허용(감사 HIGH-B). 폴백까지 이 체인 안에서 돌려야 순서가 보장되는데,
  // 그러면 내부의 _get/_post가 같은 기기로 다시 들어온다. 재진입을 그냥 통과시키지 않으면
  // 자기 자신을 기다리는 교착이 된다.
  // ★v2.3.3 — 재진입 판정을 **실행 컨텍스트**로 바꿨다(3차 감사 H3).
  // 이전엔 기기 전역 불리언(_inChain)이라, 체인이 RPC를 기다리는 최대 20초 동안 도착한
  // **새 외부 호출**(홈킷 탭·다른 폴)까지 "재진입"으로 오인해 큐를 건너뛰었다. 그러면
  // v2.2.1이 막은 "끄기 뒤 모드 착탄 → 재점등"이 다시 열린다.
  // AsyncLocalStorage는 await 사슬을 따라 전파되므로 **체인 내부에서 파생된 호출만**
  // 재진입으로 인정되고, 밖에서 새로 들어온 호출은 정상적으로 큐를 탄다.
  _serialize(deviceId, fn) {
    const store = CHAIN_CTX.getStore();
    if (store && store.deviceId === deviceId) return Promise.resolve().then(fn);
    const run = async () => {
      this._inChain.set(deviceId, true);   // 진단용(로그·테스트에서만 참조)
      try {
        return await CHAIN_CTX.run({ deviceId }, fn);
      } finally {
        this._inChain.delete(deviceId);
      }
    };
    const prev = this._chains.get(deviceId) || Promise.resolve();
    const next = prev.then(run, run);   // 앞 요청의 성공·실패와 무관하게 이어서 실행
    this._chains.set(deviceId, next.then(() => {}, () => {}));
    return next;
  }

  // 응답코드 2차 검증 — 브릿지가 이미 판정하지만, 계약이 어긋나도 조용히 성공으로
  // 넘어가지 않도록 클라이언트에서도 확인한다.
  static _assertOk(res, what) {
    if (res && res.code != null && !(res.code >= 64 && res.code <= 95)) {
      throw new Error(`${what} 거부됨 — CoAP ${res.code >> 5}.${String(res.code & 31).padStart(2, '0')}`);
    }
    return res;
  }

  // v2.2.3 — 기기 신원 확인(감사 medium). config에 IP를 잘못 넣으면 엉뚱한 기기가 명령을
  // 받아들이고 성공으로 보고된다. OCF 기기 식별자(di)가 SmartThings deviceId와 같다는 것을
  // 두 기기 실측으로 확인했으므로(승준 에어컨·건조기), 첫 요청 때 한 번 대조한다.
  // 불일치면 로컬을 끄고 클라우드로 내려간다 — 조용히 엉뚱한 기기를 조작하는 것보다 낫다.
  async _ensureIdentity(deviceId) {
    // 단일 비행 — getStatus처럼 한 체인 안에서 두 요청이 동시에 나가면 신원 확인이 중복 실행돼
    // 기기에 불필요한 탐지 트래픽이 간다(단일 세션 기기에는 그 자체가 방해가 된다).
    if (this._identityInflight?.has(deviceId)) return this._identityInflight.get(deviceId);
    if (this._verified.has(deviceId)) {
      if (this._verified.get(deviceId) === false) {
        throw new Error('로컬 기기 신원 불일치 — 로컬 경로 비활성');
      }
      return;
    }
    if (!this._identityInflight) this._identityInflight = new Map();
    const run = this._doVerify(deviceId).finally(() => this._identityInflight.delete(deviceId));
    this._identityInflight.set(deviceId, run);
    return run;
  }

  async _doVerify(deviceId) {
    const d = this._dev(deviceId);
    let res;
    try {
      res = await this._rpc({ op: 'get', host: d.host, port: d.port, path: ['oic', 'd'], localPort: d.localPort });
    } catch (e) {
      // 실명령을 보내기 '전' 단계의 실패 — 기기엔 아무것도 가지 않았다(3차 감사 H4).
      e.preCommand = true;
      throw e;
    }
    const di = res?.data?.di;
    const name = res?.data?.n;
    if (di && String(di).toLowerCase() !== String(deviceId).toLowerCase()) {
      this._verified.set(deviceId, false);
      this.log.error(`[${this._labelOf(deviceId)}] ★로컬 기기 신원 불일치 — ${d.host}에 있는 기기는 '${name}'(di ${di})입니다. `
        + 'config의 기기 IP를 확인하세요. 로컬 경로를 끄고 클라우드로 동작합니다.');
      throw new Error('로컬 기기 신원 불일치 — 로컬 경로 비활성');
    }
    this._verified.set(deviceId, true);
    this._learnPort(deviceId, res.port);
    if (name) this.log.info(`[${this._labelOf(deviceId)}] 로컬 기기 확인 — ${name}`);
  }

  async _get(deviceId, segs, { fresh = false } = {}) {
    const key = `${deviceId}|${segs.join('/')}`;
    const hit = this._cache.get(key);
    if (!fresh && hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.value;
    const d = this._dev(deviceId);
    // 신원 확인도 반드시 순서 체인 '안'에서 — 밖에서 하면 동시 요청이 서로 추월한다.
    const res = await this._serialize(deviceId, async () => {
      if (segs[0] !== 'oic') await this._ensureIdentity(deviceId);
      return this._rpc({ op: 'get', host: d.host, port: d.port, path: segs, localPort: d.localPort });
    });
    LocalApplianceClient._assertOk(res, `/${segs.join('/')} 조회`);
    this._learnPort(deviceId, res.port);
    this._cache.set(key, { ts: Date.now(), value: res.data });
    return res.data;
  }

  async _post(deviceId, segs, payload) {
    const d = this._dev(deviceId);
    const res = await this._serialize(deviceId, async () => {
      await this._ensureIdentity(deviceId);
      return this._rpc({ op: 'post', host: d.host, port: d.port, path: segs, payload, localPort: d.localPort });
    });
    LocalApplianceClient._assertOk(res, `/${segs.join('/')} 전송`);
    this._learnPort(deviceId, res.port);
    this._lastWriteTs.set(deviceId, Date.now());
    this.invalidateStatusCache(deviceId);
    return res;
  }

  invalidateStatusCache(deviceId) {
    for (const k of this._cache.keys()) {
      if (k.startsWith(`${deviceId}|`)) this._cache.delete(k);
    }
  }

  // 로컬이 실패하면 클라우드로 폴백한다(설정된 경우). 홈킷 동작이 끊기지 않는 것이 우선.
  //
  // v2.2.3 — ★폴백까지 기기별 순서 체인 안에서 실행한다(감사 HIGH-B).
  // 밖에서 실행하면: 로컬 모드 전송이 20초 타임아웃 → 그 사이 로컬 끄기가 먼저 성공 →
  // 뒤늦게 클라우드 모드 명령이 꺼진 기기에 착탄 → 재점등. v2.2.1이 로컬끼리 막은 역전이
  // 폴백 경로로 되살아나 있었다.
  //
  // 옵션:
  //   kind: 'read' | 'write'
  //   fallbackOnUnknown — 결과를 알 수 없는 실패(타임아웃)에서도 클라우드로 재전송할지.
  //     비멱등·순서 민감 명령(모드·온도)은 false. 전원 끄기처럼 유실이 더 나쁜 것만 true.
  async _withFallback(deviceId, label, localFn, cloudFn, opts = {}) {
    const { kind = 'read', fallbackOnUnknown = true } = opts;
    return this._serialize(deviceId, async () => {
      try {
        const r = await localFn();
        // ★v2.3.6 — 폴백 경고는 있는데 **복귀 알림이 없어**, 로그만 봐서는 아직도 클라우드로
        // 도는지 알 수 없었다(사용자 지적). 실패가 쌓였다가 성공하면 한 줄로 알린다.
        const had = this._fallbackStreak.get(deviceId) || 0;
        if (had > 0) {
          const since = this._fallbackSince.get(deviceId);
          const forSec = since ? Math.round((Date.now() - since) / 1000) : 0;
          this._fallbackSince.delete(deviceId);
          this.log.info(`[${this._labelOf(deviceId)}] 로컬 복귀 — ${had}회 실패 후 정상화`
            + (forSec ? ` (${forSec}초간 클라우드 사용)` : ''));
        }
        this._fallbackStreak.set(deviceId, 0);
        return r;
      } catch (e) {
        const d = this.devices.get(deviceId);
        // ★v2.3.3 — '결과 불명' 판정을 문자열 추측이 아니라 **플래그**로 한다(3차 감사 H2).
        // 이전엔 한국어 정규식만 봤는데, 브릿지(파이썬)는 오류를 영어로 돌려주고 라이브러리
        // 타임아웃(8초)이 JS 타임아웃(20초)보다 짧아 **가장 흔한 불명 실패를 전부 놓쳤다**.
        // 그러면 "비멱등 명령은 불명 시 재전송 금지"라는 보호가 무력해져 재점등이 열린다.
        const unknown = e.sent === true
          || /시간 초과|종료됨|timeout|timed out/i.test(e.message || '');
        // ★신원 확인처럼 **명령을 보내기 전에** 실패한 경우는 불명이 아니다 — 기기에 아무것도
        // 가지 않았으므로 폴백해도 순서가 뒤집힐 수 없다(3차 감사 H4).
        const preCommand = e.preCommand === true;

        // 연속 실패가 쌓이면 학습한 포트를 버리고 다음 요청에서 다시 탐지한다
        // (기기 재부팅으로 포트가 바뀌면 재시작 전까지 영구 폴백되던 문제).
        const streak = (this._fallbackStreak.get(deviceId) || 0) + 1;
        this._fallbackStreak.set(deviceId, streak);
        if (streak === 1) this._fallbackSince.set(deviceId, Date.now());
        if (streak === PORT_RESET_AFTER && d) {
          d.port = undefined;
          this.log.warn(`[${this._labelOf(deviceId)}] 로컬 연속 실패 ${streak}회 — 포트를 다시 탐지합니다`);
        }
        const canFallback = this.cloud && d?.fallbackToCloud !== false && typeof cloudFn === 'function';
        if (streak === LOCAL_DEAD_AFTER) {
          // ★폴백을 꺼 둔 구성에서는 이 한 줄이 **사용자가 받는 유일한 신호**다
          //   (v2.4.5부터 읽기 실패는 debug로 내려간다). 그런데 문구가 늘 "클라우드로 동작 중"이라
          //   폴백이 없는데도 그렇게 말해 진단을 어긋나게 했다. 상황에 맞게 나눈다.
          this.log.error(canFallback
            ? `[${this._labelOf(deviceId)}] 로컬 경로가 계속 실패해 사실상 클라우드로 동작 중입니다 — 브릿지/기기 확인 필요`
            : `[${this._labelOf(deviceId)}] 로컬 경로가 ${streak}회 연속 실패했고 클라우드 폴백도 꺼져 있습니다 — 이 기기는 지금 제어되지 않습니다. 브릿지/기기/IP를 확인하세요`);
        }

        if (canFallback && unknown && !fallbackOnUnknown && !preCommand) {
          this.log.warn(`[${this._labelOf(deviceId)}] 로컬 ${label} 결과 불명(${e.message}) — 순서 역전 위험이 있어 클라우드 재전송은 하지 않습니다`);
          throw e;
        }
        // 방금 로컬로 쓴 값이 있는데 읽기가 실패한 경우, 클라우드의 낡은 값으로 덮으면
        // 홈킷 타일이 조작 직전 상태로 튄다. 그 창에서는 폴백 대신 실패를 올린다.
        if (canFallback && kind === 'read') {
          const lastWrite = this._lastWriteTs.get(deviceId) || 0;
          if (Date.now() - lastWrite < WRITE_SETTLE_MS) {
            this.log.warn(`[${this._labelOf(deviceId)}] 로컬 ${label} 실패 — 최근 쓰기 직후라 클라우드 값으로 덮지 않습니다`);
            throw e;
          }
        }
        // ★읽기 유예 (v2.4.5 감사 C-1/C-2). 세탁기(8888)는 이미 "연결이 안 되는 것은
        //   상태이지 사건이 아니다"로 처리하는데, 이쪽(DTLS)만 **첫 실패에 곧장 클라우드**로
        //   갔다. 그 결과 ①재시작할 때마다 불필요한 클라우드 호출 1회(실측 확인)
        //   ②로컬이 죽으면 하루 수천 번 클라우드 호출 — 10월 유료화 뒤엔 그대로 비용이다.
        //   읽기는 어차피 10~30초 뒤 다시 온다. 한 번 더 기다렸다가 그때도 안 되면 간다.
        //   ⚠️쓰기는 유예하지 않는다 — 사용자가 방금 누른 버튼이라 즉시 동작해야 한다.
        // ⚠️유예는 **연결이 안 닿은 실패에만** 준다. 신원 불일치·매핑 없음처럼
        //    다시 시도해도 결과가 뻔한 실패까지 미루면 홈킷이 괜히 한 박자 늦어진다.
        //    (세탁기 8888 경로도 정확히 같은 기준을 쓴다 — 정책을 한 곳에 맞춘 것이다.)
        const connish = unknown || CONNECTION_ERROR_RE.test(e.message || '');
        if (canFallback && kind === 'read' && connish && streak < READ_FALLBACK_AFTER) {
          this.log.debug(`[${this._labelOf(deviceId)}] 로컬 ${label} 실패 ${streak}회 — 다음 폴까지 기다립니다: ${e.message}`);
          e._transient = true;
          throw e;
        }
        if (canFallback) {
          // ⚠️문구에 `상태 조회 실패`가 들어가면 NAS의 hb-watch 감시기가 경보를 낸다
          //   (label='상태 조회'이므로 예전 문구 "로컬 상태 조회 실패"가 정확히 걸렸다 — 감사 L-F3).
          //   진짜 경보는 아래 LOCAL_DEAD_AFTER의 error 한 줄이 맡는다.
          const line = `[${this._labelOf(deviceId)}] 로컬 ${label} 응답 없음 — 클라우드로 대체 (${streak}회째): ${e.message}`;
          // 폴백 진입 시 1줄만 알린다. 계속 실패하는 동안은 조용히 — 복귀하면 위에서 요약해 준다.
          if (streak === READ_FALLBACK_AFTER || kind === 'write') this.log.warn(line);
          else this.log.debug(line);
          const r = await cloudFn();
          if (kind === 'write') this.invalidateStatusCache(deviceId);
          return r;
        }
        e._transient = kind === 'read';
        throw e;
      }
    });
  }

  // ===== 에어컨: SmartThingsClient와 동일한 시그니처 =====
  async getPower(deviceId) {
    return this._withFallback(deviceId, '전원 조회',
      async () => {
        const r = await this._get(deviceId, ['power', 'vs', '0']);
        return r?.['x.com.samsung.da.power'] === 'On';
      },
      () => this.cloud.getPower(deviceId));
  }

  async getCurrentTemperature(deviceId) {
    return this._withFallback(deviceId, '실내온도 조회',
      async () => {
        const r = await this._get(deviceId, ['temperature', 'current', '0']);
        const v = Number(r?.temperature);
        // v2.2.1 — 값이 없으면 조용히 18℃를 지어내지 않는다. 던져야 폴백이 작동한다(감사 HIGH-1).
        if (!Number.isFinite(v)) throw new Error('실내온도 응답에 값이 없습니다');
        return v;
      },
      () => this.cloud.getCurrentTemperature(deviceId));
  }

  async getCoolingSetpoint(deviceId) {
    return this._withFallback(deviceId, '희망온도 조회',
      async () => {
        const r = await this._get(deviceId, ['temperature', 'desired', '0']);
        const v = Number(r?.temperature);
        if (!Number.isFinite(v)) throw new Error('희망온도 응답에 값이 없습니다');
        return v;
      },
      () => this.cloud.getCoolingSetpoint(deviceId));
  }

  async getWindFree(deviceId) {
    return this._withFallback(deviceId, '무풍 조회',
      async () => {
        const r = await this._get(deviceId, ['mode', 'convenient', 'vs', '0']);
        return r?.['x.com.samsung.da.modes'] === 'Nano';
      },
      () => this.cloud.getWindFree(deviceId));
  }

  async getAutoClean(deviceId) {
    return this._withFallback(deviceId, '자동건조 조회',
      async () => {
        const r = await this._get(deviceId, ['option', 'autoclean', 'vs', '0']);
        return r?.['x.com.samsung.da.settingStatus'] === 'On';
      },
      () => this.cloud.getAutoClean(deviceId));
  }

  // ── v2.6.0 로컬 모니터링 조회 (HA 중계용) ─────────────────────────────────
  // 이 값들은 대부분 클라우드에 없다(§3-5 실측) → 폴백 없이 로컬만. 실패는 null 반환
  // (throw하지 않는다 — 모니터링 값 하나가 안 와도 제어·다른 센서에 영향 주지 않게).
  // 파싱 키는 2026-07-30 실기기 raw 캡처로 확정(승준 에어컨·건조기).
  async getEnergy(deviceId) {
    try {
      const r = await this._get(deviceId, ['energy', 'consumption', 'vs', '0']);
      const w = Number(r?.['x.com.samsung.da.instantaneousPower']);
      const wh = Number(r?.['x.com.samsung.da.cumulativePower']);
      return {
        // 대기 중 음수(측정 노이즈, 건조기 -500 실측)는 0으로 — HA 전력 센서가 음수로 튀지 않게.
        power_w: Number.isFinite(w) ? Math.max(0, Math.round(w)) : null,
        cumulative_kwh: Number.isFinite(wh) ? Math.round(wh / 10) / 100 : null,
      };
    } catch (e) { return null; }
  }

  async getHumidity(deviceId) {
    try {
      const r = await this._get(deviceId, ['humidity', 'vs', '0']);
      // 실측: da.humidity=0(미지원), da.fivepercentHumidity가 실제값(5% 해상도).
      const h = Number(r?.['x.com.samsung.da.fivepercentHumidity']);
      return Number.isFinite(h) && h > 0 ? h : null;
    } catch (e) { return null; }
  }

  async getFilterUsage(deviceId) {
    try {
      const r = await this._get(deviceId, ['filter', 'airdustfilter', 'vs', '0']);
      const used = Number(r?.['x.com.samsung.da.filterUsage']);
      const cap = Number(r?.['x.com.samsung.da.filterCapacity'])
        || Number(r?.['x.com.samsung.da.filterDesiredUsage']);
      if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
      const percent = Math.min(100, Math.round((used / cap) * 1000) / 10);   // 교체 지연 시 >100 방지
      return { used_hour: used, capacity_hour: cap, percent };
    } catch (e) { return null; }
  }

  async getLight(deviceId) {
    try {
      const r = await this._get(deviceId, ['light', 'vs', '0']);
      if (r?.mode === 'On') return true;
      if (r?.mode === 'Off') return false;
      return null;
    } catch (e) { return null; }
  }

  // 디스플레이 조명 제어 — 재점등 위험이 없는 무해 리소스라 억제창 없이 직접 전송.
  // 실패 시 throw(호출측이 잡는다). 클라우드 폴백은 두지 않는다(로컬 전용 편의 기능).
  setLight(deviceId, on) {
    return this._post(deviceId, ['light', 'vs', '0'], { mode: on ? 'On' : 'Off' });
  }

  // 효과음(조작 수신음) — 별도 리소스가 아니라 mode/vs/0 options의 `Volume_*`에 있다
  // (2026-07-30 실측: Volume_Mute ↔ Volume_100 왕복 성공, 다른 옵션 비훼손 확인).
  // true=소리 남(Volume_100) / false=무음(Volume_Mute). 옵션은 단독 배열로만 전송.
  async getSoundEffect(deviceId) {
    try {
      const r = await this._get(deviceId, ['mode', 'vs', '0']);
      const vol = (r?.['x.com.samsung.da.options'] || []).find(o => typeof o === 'string' && o.startsWith('Volume_'));
      if (!vol) return null;
      return vol !== 'Volume_Mute';
    } catch (e) { return null; }
  }

  setSoundEffect(deviceId, on) {
    return this._post(deviceId, ['mode', 'vs', '0'],
      { 'x.com.samsung.da.options': [on ? 'Volume_100' : 'Volume_Mute'] });
  }

  setPower(deviceId, on) {
    return this._withFallback(deviceId, '전원 전송',
      () => this._post(deviceId, ['power', 'vs', '0'],
        { 'x.com.samsung.da.power': on ? 'On' : 'Off' }),
      () => this.cloud.setPower(deviceId, on),
      { kind: 'write' });
  }

  setMode(deviceId, mode) {
    return this._withFallback(deviceId, '모드 전송',
      () => {
        const local = MODE_MAP[String(mode).toLowerCase()];
        // v2.2.2 — 매핑이 없으면 조용히 성공한 척하지 않는다. 던져서 클라우드로 넘긴다.
        if (!local) throw new Error(`로컬 모드 매핑 없음(${mode})`);
        return this._post(deviceId, ['mode', 'vs', '0'], { 'x.com.samsung.da.modes': [local] });
      },
      () => this.cloud.setMode(deviceId, mode),
      { kind: 'write', fallbackOnUnknown: false });
  }

  setTemperature(deviceId, value) {
    return this._withFallback(deviceId, '온도 전송',
      () => this._post(deviceId, ['temperature', 'desired', '0'], { temperature: Number(value) }),
      () => this.cloud.setTemperature(deviceId, value),
      { kind: 'write', fallbackOnUnknown: false });
  }

  setWindFree(deviceId, enable) {
    return this._withFallback(deviceId, '무풍 전송',
      () => this._post(deviceId, ['mode', 'convenient', 'vs', '0'],
        { 'x.com.samsung.da.modes': enable ? 'Nano' : 'Off' }),
      () => this.cloud.setWindFree(deviceId, enable),
      { kind: 'write', fallbackOnUnknown: false });
  }

  setAutoClean(deviceId, enable) {
    return this._withFallback(deviceId, '자동건조 전송',
      () => this._post(deviceId, ['option', 'autoclean', 'vs', '0'],
        { 'x.com.samsung.da.settingStatus': enable ? 'On' : 'Off' }),
      () => this.cloud.setAutoClean(deviceId, enable),
      { kind: 'write', fallbackOnUnknown: false });
  }

  // ===== 세탁기/건조기: 클라우드 status 형태로 변환해 돌려준다 =====
  // Laundry 액세서리는 components.main.<...>OperatingState 를 읽는다. 로컬 기기는
  // /operational/state/0 에 같은 의미의 값이 있으므로 그 모양으로 만들어 준다.
  // opts.localOnly=true → 클라우드 폴백 없이 로컬만(실패 시 throw). MQTT 모니터링 폴러 전용.
  //   폴백을 타면 (a) v2.4.5가 없앤 클라우드 호출이 30초마다 되살아나고 (b) 클라우드 응답엔
  //   remainingMinRaw/progressPercentage가 없어 비용만 내고 얻는 게 없다(적대 감사 MEDIUM-3).
  async getStatus(deviceId, opts = {}) {
    const localFn = async () => {
        const [power, op] = await Promise.all([
          this._get(deviceId, ['power', 'vs', '0']),
          this._get(deviceId, ['operational', 'state', '0']),
        ]);
        const on = power?.['x.com.samsung.da.power'] === 'On';
        const cur = op?.currentMachineState;
        // OCF(active/idle/pause) → SmartThings(run/stop/pause/on).
        // v2.3.2 — ★'idle'을 'stop'으로 단정하지 않는다.
        // 'stop'은 Laundry가 jobState를 보지도 않고 즉시 '종료'로 확정하는 값이라,
        // 안티주름(WrinklePrevent)처럼 machineState가 idle로 떨어진 채 도는 단계에서
        // **종료 알림이 조기 발사**된다. 켜져 있는데 idle이면 'on'으로 넘겨
        // jobState 기반 판정(POST_CYCLE_ACTIVE)이 살아 있게 한다.
        // 전원이 꺼져 있을 때만 확정적으로 'stop'.
        let machineState = 'stop';
        if (on && cur === 'active') machineState = 'run';
        else if (on && cur === 'pause') machineState = 'pause';
        else if (on) machineState = 'on';
        const remainMin = LocalApplianceClient._hhmmssToMinutes(op?.remainingTime);
        const main = {
          samsungce: {},
          dryerOperatingState: {
            machineState: { value: machineState },
            // ★v2.3.3 — Laundry가 실제로 읽는 키는 `dryerJobState`/`washerJobState`다(Laundry.js:68).
            // v2.3.2에서 `jobState`로 내보내는 바람에 **항상 null**이 되어, 고쳤다고 한
            // "안티주름 조기 종료 알림 방지"가 로컬 경로에서 사문이었다(3차 감사 적발).
            dryerJobState: { value: LocalApplianceClient._jobState(op?.currentJobState) },
            washerJobState: { value: LocalApplianceClient._jobState(op?.currentJobState) },
            jobState: { value: LocalApplianceClient._jobState(op?.currentJobState) },
            // 밸브(스프링클러) 액세서리의 잔여 시간 카운트다운 소스.
            // 운전 중(run)과 일시정지(pause)에서만 유효값, 그 외엔 0.
            remainingTime: { value: (machineState === 'run' || machineState === 'pause') ? remainMin : 0 },
            // v2.6.0 — MQTT 중계용 raw 남은시간(분)·진행률. HomeKit Valve(60분 상한)와 달리
            // 로컬 raw는 상한이 없다(건조기 109분 실측). 진행률은 op의 progressPercentage(0~100).
            // 액세서리(Valve)는 이 두 키를 읽지 않으므로 기존 동작에 영향 없음.
            // run/pause에서만 유효 남은시간(idle에 남은 stale 값이 '대기 중 + 109분'으로 공존하지 않게).
            remainingMinRaw: { value: (machineState === 'run' || machineState === 'pause') ? remainMin : 0 },
            progressPercentage: { value: (() => { const p = Number(op?.progressPercentage); return Number.isFinite(p) ? p : null; })() },
          },
        };
        return { main };
    };
    if (opts.localOnly) return localFn();
    return this._withFallback(deviceId, '상태 조회', localFn, () => this.cloud.getStatus(deviceId));
  }

  // v2.2.3 — 로컬 jobState를 클라우드와 같은 표기로 옮긴다(감사 medium).
  // null로 접으면 Laundry가 machineState만 보고 판정해, 안티주름처럼 machineState가 idle로
  // 떨어진 채 도는 단계에서 "끝났다" 알림이 조기 발사된다(클라우드 시절 잡았던 버그의 재림).
  static _jobState(v) {
    if (!v || typeof v !== 'string') return null;
    const MAP = {
      none: 'none', finish: 'finished', finished: 'finished',
      weightsensing: 'weightSensing', wrinkleprevent: 'wrinklePrevent',
      wrinklecare: 'wrinkleCare', airdry: 'airDry',
    };
    const k = v.toLowerCase();
    return MAP[k] || (v.charAt(0).toLowerCase() + v.slice(1));
  }

  static _hhmmssToMinutes(str) {
    if (typeof str !== 'string') return 0;
    const m = str.match(/^(\d+):(\d+):(\d+)$/);
    if (!m) return 0;
    return Number(m[1]) * 60 + Number(m[2]);
  }
}

module.exports = LocalApplianceClient;
