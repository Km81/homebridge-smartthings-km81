'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

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
    this.log.info(`[${info.label}] 로컬 경로 등록 — ${info.host}:${info.port}`);
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
    if (msg.event === 'log') return this.log.info(`[로컬] ${msg.message}`);
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error || '로컬 요청 실패'));
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
        reject(new Error('로컬 요청 시간 초과'));
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
  _serialize(deviceId, fn) {
    const prev = this._chains.get(deviceId) || Promise.resolve();
    const next = prev.then(fn, fn);   // 앞 요청의 성공·실패와 무관하게 이어서 실행
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

  async _get(deviceId, segs, { fresh = false } = {}) {
    const key = `${deviceId}|${segs.join('/')}`;
    const hit = this._cache.get(key);
    if (!fresh && hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.value;
    const d = this._dev(deviceId);
    const res = await this._serialize(deviceId, () =>
      this._rpc({ op: 'get', host: d.host, port: d.port, path: segs, localPort: d.localPort }));
    LocalApplianceClient._assertOk(res, `/${segs.join('/')} 조회`);
    this._cache.set(key, { ts: Date.now(), value: res.data });
    return res.data;
  }

  async _post(deviceId, segs, payload) {
    const d = this._dev(deviceId);
    const res = await this._serialize(deviceId, () =>
      this._rpc({ op: 'post', host: d.host, port: d.port, path: segs, payload, localPort: d.localPort }));
    LocalApplianceClient._assertOk(res, `/${segs.join('/')} 전송`);
    this.invalidateStatusCache(deviceId);
    return res;
  }

  invalidateStatusCache(deviceId) {
    for (const k of this._cache.keys()) {
      if (k.startsWith(`${deviceId}|`)) this._cache.delete(k);
    }
  }

  // 로컬이 실패하면 클라우드로 폴백한다(설정된 경우). 홈킷 동작이 끊기지 않는 것이 우선.
  async _withFallback(deviceId, label, localFn, cloudFn) {
    try {
      return await localFn();
    } catch (e) {
      const d = this.devices.get(deviceId);
      if (this.cloud && d?.fallbackToCloud !== false && typeof cloudFn === 'function') {
        this.log.warn(`[${this._labelOf(deviceId)}] 로컬 ${label} 실패 — 클라우드로 폴백: ${e.message}`);
        return cloudFn();
      }
      throw e;
    }
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

  setPower(deviceId, on) {
    return this._withFallback(deviceId, '전원 전송',
      () => this._post(deviceId, ['power', 'vs', '0'],
        { 'x.com.samsung.da.power': on ? 'On' : 'Off' }),
      () => this.cloud.setPower(deviceId, on));
  }

  setMode(deviceId, mode) {
    return this._withFallback(deviceId, '모드 전송',
      () => {
        const local = MODE_MAP[String(mode).toLowerCase()];
        // v2.2.2 — 매핑이 없으면 조용히 성공한 척하지 않는다. 던져서 클라우드로 넘긴다.
        if (!local) throw new Error(`로컬 모드 매핑 없음(${mode})`);
        return this._post(deviceId, ['mode', 'vs', '0'], { 'x.com.samsung.da.modes': [local] });
      },
      () => this.cloud.setMode(deviceId, mode));
  }

  setTemperature(deviceId, value) {
    return this._withFallback(deviceId, '온도 전송',
      () => this._post(deviceId, ['temperature', 'desired', '0'], { temperature: Number(value) }),
      () => this.cloud.setTemperature(deviceId, value));
  }

  setWindFree(deviceId, enable) {
    return this._withFallback(deviceId, '무풍 전송',
      () => this._post(deviceId, ['mode', 'convenient', 'vs', '0'],
        { 'x.com.samsung.da.modes': enable ? 'Nano' : 'Off' }),
      () => this.cloud.setWindFree(deviceId, enable));
  }

  setAutoClean(deviceId, enable) {
    return this._withFallback(deviceId, '자동건조 전송',
      () => this._post(deviceId, ['option', 'autoclean', 'vs', '0'],
        { 'x.com.samsung.da.settingStatus': enable ? 'On' : 'Off' }),
      () => this.cloud.setAutoClean(deviceId, enable));
  }

  // ===== 세탁기/건조기: 클라우드 status 형태로 변환해 돌려준다 =====
  // Laundry 액세서리는 components.main.<...>OperatingState 를 읽는다. 로컬 기기는
  // /operational/state/0 에 같은 의미의 값이 있으므로 그 모양으로 만들어 준다.
  async getStatus(deviceId) {
    return this._withFallback(deviceId, '상태 조회',
      async () => {
        const [power, op] = await Promise.all([
          this._get(deviceId, ['power', 'vs', '0']),
          this._get(deviceId, ['operational', 'state', '0']),
        ]);
        const on = power?.['x.com.samsung.da.power'] === 'On';
        const cur = op?.currentMachineState;
        // OCF(active/idle/pause) → SmartThings(run/stop/pause).
        // 전원이 꺼져 있으면 무조건 stop — 사용자 요구는 "작동 여부"뿐이다.
        let machineState = 'stop';
        if (on && cur === 'active') machineState = 'run';
        else if (on && cur === 'pause') machineState = 'pause';
        const remainMin = LocalApplianceClient._hhmmssToMinutes(op?.remainingTime);
        const main = {
          samsungce: {},
          dryerOperatingState: {
            machineState: { value: machineState },
            jobState: { value: null },
            remainingTime: { value: machineState === 'run' ? remainMin : 0 },
          },
        };
        return { main };
      },
      () => this.cloud.getStatus(deviceId));
  }

  static _hhmmssToMinutes(str) {
    if (typeof str !== 'string') return 0;
    const m = str.match(/^(\d+):(\d+):(\d+)$/);
    if (!m) return 0;
    return Number(m[1]) * 60 + Number(m[2]);
  }
}

module.exports = LocalApplianceClient;
