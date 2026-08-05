'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { AsyncLocalStorage } = require('async_hooks');
const { CONNECTION_ERROR_RE } = require('../shared');
const AcTempChannel = require('../local/AcTempChannel');

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

// ★기본 상태 폴더는 **홈브릿지 저장 경로 아래**에 만든다(v2.6.7).
//   예전엔 `/homebridge/.km81-local`로 하드코딩돼 있었는데, 그건 **도커 이미지에서만** 존재하는
//   경로다. hb-service(네이티브)·라즈베리파이·시놀로지 설치에서는 그 폴더가 없고 홈브릿지가
//   root도 아니라 **루트에 폴더를 만들 수 없다** → `pip install --target`이 권한 오류로 죽고
//   신형 기기 로컬 경로가 통째로 성립하지 않았다(사용자 실사례의 유력 원인).
//   홈브릿지 저장 경로는 어떤 설치 형태에서도 쓰기 가능이 보장된다 — 토큰 파일도 그 경로를 쓴다.
const LEGACY_DOCKER_STATE_DIR = '/homebridge/.km81-local';
function defaultStateDir(api) {
  try {
    const base = api && api.user && api.user.storagePath && api.user.storagePath();
    if (base) return path.join(base, '.km81-local');
  } catch (_) { /* 아래 폴백 */ }
  return LEGACY_DOCKER_STATE_DIR;
}
// 파이썬 도우미 패키지가 요구하는 최소 버전 (PyPI `requires_python: >=3.11`, 2026-07-30 실조회).
// 이보다 낮으면 pip이 "Could not find a version…"을 내는데, 그건 네트워크 문제가 아니라
// **버전 미달**이다. 예전엔 그걸 네트워크로 오진해 사용자를 엉뚱한 곳으로 보냈다.
const MIN_PYTHON = [3, 11];
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
// ★신원 불일치를 잠가 두는 시간. DHCP가 IP를 잠깐 다른 기기에 줬다가 돌려주는 경우가
//   흔해서, 영구 잠금은 폴백 없는 구성에서 기기를 재시작 전까지 죽인다(적대 리뷰 H2).
const IDENTITY_RETRY_MS = 10 * 60 * 1000;
// 기기당 하루 한 줄. 조용한 로컬 전용 구성에서 "그동안 무슨 일이 있었나"를 남기는 유일한 줄이다.
const SUMMARY_EVERY_MS = 24 * 60 * 60 * 1000;
// ★기능 목록 덤프를 미루는 시간. 부팅 직후의 홈킷 콜드 리드 6발이 다 지나간 뒤에 돈다.
const DUMP_DELAY_MS = 60 * 1000;

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
  // ★기기는 `Auto` 와 `AIComfort` 를 **별개 모드로** 지원한다(실사용자 천장형 앱 화면에
  //   '자동'과 'AI 쾌적'이 따로 있고, supportedModes 도 둘 다 들고 있다).
  //   v2.9.2 까지 `auto` 가 `AIComfort` 로 매핑돼 있었는데, 그때는 설정 목록에 `auto` 가
  //   없어 도달 불가능한 죽은 매핑이었다. 목록에 넣으면서 바로잡는다.
  auto: 'Auto',
  aicomfort: 'AIComfort',
};

class LocalApplianceClient {
  constructor(log, opts = {}) {
    this.log = log;
    // ★기존 도커 설치 호환: `/homebridge/.km81-local`에 이미 설치돼 있으면 그대로 쓴다.
    //   (안 그러면 업데이트만으로 경로가 바뀌어 인증서·의존성을 다시 받게 된다)
    this.stateDir = opts.stateDir
      || (fs.existsSync(LEGACY_DOCKER_STATE_DIR) ? LEGACY_DOCKER_STATE_DIR : defaultStateDir(opts.api));
    this.libDir = opts.libDir || path.join(this.stateDir, 'lib');
    this.certPath = opts.certPath || path.join(this.stateDir, 'certs', 'fullchain.pem');
    this.keyPath = opts.keyPath || path.join(this.stateDir, 'certs', 'leaf.key');
    this.caPath = opts.caPath || path.join(__dirname, '..', '..', 'cert', 'cert.pem');
    this.pythonBin = opts.pythonBin || 'python3';
    this.cloud = opts.cloudClient || null;   // 폴백 대상

    // 온도 리소스 경로는 보드마다 다르다 — 판별과 읽기·쓰기를 이쪽에 맡긴다.
    this.tempChannel = new AcTempChannel(this);

    this.devices = new Map();   // deviceId → { host, port, label, kind, localPort }
    this._pending = new Map();  // rpc id → { resolve, reject, timer }
    this._cache = new Map();    // `${deviceId}|${path}` → { ts, value }
    this._chains = new Map();   // deviceId → Promise (기기별 직렬화 체인)
    this._inChain = new Map();  // deviceId → 체인 실행 중 (재진입 허용용)
    this._lastWriteTs = new Map();   // deviceId → 마지막 로컬 쓰기 시각
    this._fallbackStreak = new Map();// deviceId → 연속 실패 횟수
    this._fallbackSince = new Map(); // deviceId → 폴백 시작 시각 (복귀 알림용, v2.3.6)
    this._permanentNotified = new Set(); // `deviceId|작업` → 리소스 부재를 이미 알린 것
    this._deadAnnounced = new Set();     // '제어되지 않습니다' 경보를 건 기기 (복구 시 풀어 준다)
    this._stats = new Map();             // deviceId → 24시간 집계(아래 _startDailySummary)
    this._outageStart = new Map();       // deviceId → 이번 순단이 시작된 시각
    this._labelStreak = new Map();       // `deviceId|항목` → 그 항목만의 연속 실패
    this._labelWarned = new Set();       // 그 항목의 지속 실패를 이미 알린 곳
    this._summaryTimer = null;
    this._dumped = new Set();        // 기능 목록을 이미 남긴 기기 (부팅당 1회)
    this._dumpTimers = new Map();    // deviceId → 덤프 예약 타이머
    this._verified = new Map();      // deviceId → 신원 확인 결과
    this._verifyRetryAt = new Map(); // deviceId → 불일치 재확인 가능 시각(ms)
    this._seq = 0;
    this._proc = null;
    this._ready = false;
    this._readyWaiters = [];
    this._restarts = 0;
    this._stopped = false;
  }

  // ===== 기기 등록 =====
  registerDevice(deviceId, info) {
    this._startDailySummary();   // 첫 기기가 등록될 때 하루 타이머를 건다(멱등)
    // ★★2026-08-03 — 지난 부팅에 확인한 DTLS 포트를 되살린다.
    //   포트를 안 주면 브릿지가 49152~49160을 훑는데 **실측 3초**가 걸리고, 그동안
    //   홈킷 콜드 리드 6발이 줄을 서 홈브릿지 `slow to respond`(임계 3초)를 넘겼다.
    //   포트를 주면 브릿지는 탐지 단계를 **통째로 건너뛴다**(`bridge.py` — `if not port:`).
    //   ⚠️설정에 포트를 적었으면 그것이 우선이다. 캐시는 빈칸일 때만 채운다.
    if (!info.port) {
      const cached = this._readPort(info.host);
      if (cached) {
        info.port = cached;
        info.portFromCache = true;   // 한 번만 실패해도 바로 버린다(아래)
      }
    }
    this.devices.set(deviceId, info);
    this.log.info(`[${info.label}] 로컬 경로 등록 — ${info.host}:`
      + (info.portFromCache ? `${info.port} (지난 부팅에서 확인한 포트)` : (info.port || '포트 자동 탐지')));
  }

  // ───────── 24시간 요약 (일주일 실측용, 2026-08-03) ─────────
  //
  // ★왜: 로컬 전용 구성의 로그는 **극단적으로 조용하다.** 실측(적대 리뷰 C)에 따르면
  //   정상 하루에 보이는 줄이 1줄, 10분 미만 순단은 어휘 0줄, 2분 미만 순단은 완전 무흔적,
  //   심지어 **종일 죽어 있어도 보이는 줄은 2줄**이다. 조용한 건 좋지만, 일주일 뒤
  //   "그동안 무슨 일이 있었나"를 로그로 되짚을 수 없다는 뜻이기도 하다.
  //   특히 알 수 없는 것 둘 — **짧은 순단의 빈도**와 **클라우드를 정말 0회 불렀는가.**
  //   기기당 하루 한 줄이면 그 둘이 다 남는다.
  // ⚠️문구에 감시 어휘를 넣지 않는다 — 실패 어휘가 섞이면 허위 경보가 되고,
  //   복구 어휘(`복구`)가 섞이면 **진짜 경보를 잘못 풀어 준다**. 그래서 `순단`을 쓴다.
  _stat(deviceId) {
    let st = this._stats.get(deviceId);
    if (!st) {
      // ★`lastOk` = **마지막으로 기기와 실제로 통신에 성공한 시각**(epoch ms).
      //   HA 가 "값이 안 바뀐 것"과 "기기가 죽은 것"을 구분하는 유일한 근거다
      //   — 브리지 availability 는 브리지 생사만 알려 주고, 기기별 availability 를 켜면
      //   **"전원을 끈 것"과 "죽은 것"이 섞인다**(요청서 §4-2 계약).
      //   ⚠️실패에는 건드리지 않는다 — 마지막 성공 시각이 그대로 남아야 경과가 커진다.
      st = { ok: 0, fail: 0, cmdFail: 0, cloud: 0, outages: 0, longestMs: 0, since: Date.now(), lastOk: 0 };
      this._stats.set(deviceId, st);
    }
    return st;
  }

  _startDailySummary() {
    if (this._summaryTimer || this._stopped) return;
    const tick = () => {
      this._summaryTimer = null;
      if (this._stopped) return;
      for (const [deviceId, st] of this._stats) {
        const total = st.ok + st.fail;
        if (total === 0) continue;
        const longest = st.longestMs >= 60000
          ? `${Math.round(st.longestMs / 60000)}분`
          : `${Math.round(st.longestMs / 1000)}초`;
        this.log.info(`[${this._labelOf(deviceId)}] 지난 24시간 로컬: 성공 ${st.ok}/${total}`
          + ` · 순단 ${st.outages}건${st.outages ? ` (최장 ${longest})` : ''}`
          + ` · 명령 실패 ${st.cmdFail}건 · 클라우드 호출 ${st.cloud}회`);
      }
      // ⛔`clear()` 로 통째로 지우면 **`lastOk` 까지 사라진다** — 그러면 죽은 기기의
      //   마지막 수신 시각이 하루마다 리셋돼 HA 가 사망을 판정할 수 없다(이 기능의 존재 이유가
      //   무너진다). 요약이 리셋할 것은 **카운터뿐**이다. 8/5 hb_watch 에서 잡은
      //   "노화를 복구로 오인" 과 같은 부류가 HA 안에서 재현될 자리였다(적대 리뷰 F1).
      for (const st of this._stats.values()) {
        st.ok = 0; st.fail = 0; st.cmdFail = 0; st.cloud = 0;
        st.outages = 0; st.longestMs = 0; st.since = Date.now();
        // st.lastOk 는 **보존한다**.
      }
      this._startDailySummary();
    };
    const t = setTimeout(tick, SUMMARY_EVERY_MS);
    if (typeof t.unref === 'function') t.unref();
    this._summaryTimer = t;
  }

  // ───────── DTLS 포트 기억 (부팅 간 유지) ─────────
  _portsPath() { return path.join(this.stateDir, 'ports.json'); }

  _readPort(host) {
    if (!host) return null;
    try {
      const all = JSON.parse(fs.readFileSync(this._portsPath(), 'utf8'));
      const p = all && all[host] && Number(all[host].port);
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch (_) { return null; }       // 없거나 깨졌으면 종전대로 탐지한다
  }

  _writePort(host, port) {
    if (!host || !port) return;
    let all = {};
    try { all = JSON.parse(fs.readFileSync(this._portsPath(), 'utf8')) || {}; } catch (_) { /* 새로 만든다 */ }
    if (all[host] && Number(all[host].port) === Number(port)) return;   // 바뀐 게 없으면 안 쓴다
    all[host] = { port: Number(port), at: new Date().toISOString() };
    try { this._writeJsonAtomic(this._portsPath(), all); }
    catch (e) {
      // 기억 실패는 치명적이지 않다 — 다음 부팅에 다시 탐지하면 된다.
      this.log.debug?.(`DTLS 포트 기억 실패: ${e.message}`);
    }
  }

  /**
   * ★★2026-08-03 — 상태 파일은 **임시 파일에 쓴 뒤 이름을 바꾼다**(적대 리뷰 A-L1).
   *   그냥 `writeFileSync`로 덮다가 크래시하면 파일이 반쪽으로 남고, 다음 읽기의
   *   `catch → {}`가 **다른 호스트 항목까지 조용히 버린다.**
   *   ⚠️그 소실이 곧 "discovered 캐시가 비어 있음"이고, 그건 액세서리 영구 삭제와
   *     영구 미바인딩의 **트리거 조건 그 자체**다. 자가 치유되는 파일이라고 가볍게 볼 게 아니다.
   */
  _writeJsonAtomic(file, obj) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  }

  _forgetPort(host) {
    if (!host) return;
    try {
      const all = JSON.parse(fs.readFileSync(this._portsPath(), 'utf8'));
      if (!all || !all[host]) return;
      delete all[host];
      this._writeJsonAtomic(this._portsPath(), all);
    } catch (_) { /* 없으면 지울 것도 없다 */ }
  }

  // 브릿지가 포트를 탐지했으면 그 값을 받아 두 번째 요청부터 바로 쓴다(로그도 1회만).
  _learnPort(deviceId, port) {
    const d = this.devices.get(deviceId);
    if (!d || !port) return;
    if (d.port !== port) {
      d.port = port;
      this.log.info(`[${this._labelOf(deviceId)}] DTLS 포트 확인됨 — ${port}`);
    }
    // 확인된 포트는 **성공한 뒤에만** 기억한다 — 다음 부팅의 3초 탐지를 없앤다.
    d.portFromCache = false;   // 실제 통신으로 확인됐으니 더는 '의심스러운 캐시'가 아니다
    this._writePort(d.host, port);
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

  // 첫 설치가 진행 중인가 — index.js가 "기동 실패"와 "아직 설치 중"을 구분하는 데 쓴다.
  // pip은 최대 180초인데 기동 예산은 20초라, 성공하는 첫 설치도 반드시 예산을 넘긴다.
  isInstalling() { return this._installing === true; }
  // ===== 프로세스 수명주기 =====
  async start() {
    await this._ensureDeps();
    this._spawn();
    return this._waitReady();
  }

  stop() {
    this._stopped = true;
    if (this._summaryTimer) { clearTimeout(this._summaryTimer); this._summaryTimer = null; }
    for (const t of this._dumpTimers.values()) clearTimeout(t);
    this._dumpTimers.clear();
    if (this._proc) {
      try { this._proc.kill(); } catch (_) { /* 이미 종료됨 */ }
      this._proc = null;
    }
  }

  /** 파이썬의 major.minor를 문자열로. 실행 불가면 null. */
  _probePython() {
    return new Promise((resolve) => {
      const p = spawn(this.pythonBin, ['-c',
        'import sys;print("%d.%d"%(sys.version_info[0],sys.version_info[1]))'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
      let o = '';
      p.stdout.on('data', (b) => { o += String(b); });
      p.on('error', () => resolve(null));
      p.on('exit', () => resolve(o.trim() || null));
    });
  }

  // 파이썬 의존성은 영구 볼륨(<홈브릿지 저장경로>/.km81-local/lib)에 1회만 설치한다.
  // node_modules 밖이라 npm 재설치·플러그인 업데이트에도 살아남는다.
  async _ensureDeps() {
    // v2.2.1 — 완료 스탬프로 판정한다(감사 MEDIUM-1). 디렉터리 존재만 보면 중단된 설치가
    // 껍데기만 남겼을 때 영구히 import 실패한다.
    const stamp = path.join(this.libDir, '.km81-install-ok');

    // ★파이썬 버전을 **pip을 돌리기 전에** 본다(v2.6.7).
    //   `smartthings-local`은 3.11 이상을 요구한다(PyPI 실조회). 미달이면 pip이
    //   "Could not find a version…"을 내는데, 그 문구만 보고는 버전 문제인지 알 수 없다.
    //   라즈베리파이 Bullseye(3.9)·구형 데비안 등 홈브릿지 최다 환경이 여기 걸린다.
    const ver = await this._probePython();
    this._pyVersionText = ver;

    // ★스탬프에 파이썬 버전을 함께 남긴다(v2.6.8).
    //   설치된 패키지에는 파이썬 버전에 묶인 바이너리가 있다(cryptography 등).
    //   나중에 `localPythonBin`을 바꾸거나 OS가 파이썬을 올리면, 스탬프는 '설치됨'인데
    //   그 라이브러리는 **못 읽는 상태**가 된다. 그러면 브릿지가 import 오류로 죽고
    //   원인은 어디에도 안 나온다. 버전이 달라졌으면 조용히 다시 설치한다.
    //   ⚠️v2.6.7 이전 스탬프는 날짜 문자열뿐이라 버전을 모른다 — 그건 그대로 인정한다
    //   (업데이트했다고 모두가 재설치하는 일이 없도록).
    let changedFrom = null;
    if (fs.existsSync(stamp)) {
      let stamped = null;
      try { stamped = JSON.parse(fs.readFileSync(stamp, 'utf8')).python; } catch (_) { /* 옛 형식 */ }
      if (!stamped || !ver || stamped === ver) return;
      changedFrom = stamped;
    }

    this._installing = true;
    this.log.info(changedFrom
      ? `파이썬이 ${changedFrom} → ${ver}로 바뀌어 로컬 경로 의존성을 다시 설치합니다 — 잠시 걸립니다`
      : `로컬 경로 의존성 최초 설치 — 잠시 걸립니다 (설치 위치: ${this.stateDir})`);

    if (ver) {
      const [maj, min] = ver.split('.').map(Number);
      if (Number.isFinite(maj) && (maj < MIN_PYTHON[0] || (maj === MIN_PYTHON[0] && min < MIN_PYTHON[1]))) {
        this._installing = false;
        this.log.error(`신형 기기 로컬 제어에는 파이썬 ${MIN_PYTHON.join('.')} 이상이 필요합니다 — 지금은 ${ver}입니다.`);
        this.log.error(`※ 새 파이썬을 설치한 뒤 플러그인 설정의 'localPythonBin'에 그 실행 경로를 지정하세요`
          + ` (예: /usr/bin/python3.12). 그 전까지 신형 기기는 로컬로 제어할 수 없습니다.`);
        throw new Error(`파이썬 ${ver} — ${MIN_PYTHON.join('.')} 이상 필요`);
      }
    }

    // ★v2.6.6 — 이전엔 `stdio:'inherit'`이라 pip 출력이 홈브릿지 로그에 안 남았다.
    //   그래서 실패하면 `의존성 설치 실패 (코드 2)` 한 줄만 보였고, **사용자가 원인을
    //   알 방법이 없었다**(다른 사용자 실사례 2026-07-30: 에어컨 2대가 '응답 없음'인데
    //   왜인지 알 수 없었다). 이제 출력을 잡아 마지막 줄들을 로그에 싣고, 흔한 원인은
    //   조치 방법까지 알려 준다.
    const runPip = (extraArgs) => new Promise((resolve) => {
      // ★`--upgrade`가 없으면 재설치가 **아무 파일도 바꾸지 못한다**(v2.7.1).
      //   `--target`에 파일이 이미 있으면 pip은 경고만 내고 건너뛴 뒤 **exit 0**을 준다
      //   ("Target directory … already exists. Specify --upgrade to force replacement.").
      //   우리는 code===0만 보고 성공으로 판정해 스탬프를 덮어썼고, 스탬프가 찍히면 이후
      //   부팅은 _ensureDeps 첫머리에서 즉시 return 한다 → **폴더를 손으로 지우기 전엔
      //   영구 복구 불가**. 중단된 첫 설치의 잔해나, 파이썬 버전이 바뀌어 v2.6.8 자가치유가
      //   발동한 경우(휠이 cp3xx에 묶여 있어 import가 죽는다)에 정확히 이 상태가 된다.
      const args = ['-m', 'pip', 'install', '--upgrade', '--target', this.libDir,
        ...extraArgs, 'smartthings-local'];
      const p = spawn(this.pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const grab = (b) => { out += String(b); if (out.length > 8000) out = out.slice(-8000); };
      p.stdout.on('data', grab);
      p.stderr.on('data', grab);
      const timer = setTimeout(() => {
        try { p.kill(); } catch (_) { /* 이미 종료됨 */ }
        resolve({ code: -1, out, timedOut: true });
      }, PIP_TIMEOUT_MS);
      p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, spawnError: e }); });
      p.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });

    let r = await runPip([]);

    // ★PEP 668: 최신 데비안/우분투 계열은 시스템 파이썬에 pip 설치를 막는다
    //   (`externally-managed-environment`). `--target`으로 격리 설치하는 우리 경우엔
    //   시스템을 건드리지 않으므로 이 차단을 넘겨도 안전하다. 자동 재시도한다 —
    //   이게 첫 설치 실패의 가장 흔한 원인이다.
    if (r.code !== 0 && /externally-managed-environment|break-system-packages/i.test(r.out)) {
      this.log.warn('파이썬이 시스템 보호(PEP 668)로 설치를 막았습니다 — 격리 설치이므로 안전하게 다시 시도합니다.');
      r = await runPip(['--break-system-packages']);
    }

    if (r.code === 0) {
      this._installing = false;
      try {
        fs.writeFileSync(stamp, JSON.stringify({ at: new Date().toISOString(), python: ver }));
      } catch (_) { /* 스탬프 실패는 치명적이지 않음 */ }
      this.log.info('로컬 경로 의존성 설치됨');
      return;
    }

    // 실패 — 원인을 사용자가 볼 수 있게 남기고, 아는 유형은 조치까지 안내한다.
    const tail = r.out.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
    if (r.spawnError && r.spawnError.code === 'ENOENT') {
      this.log.error(`파이썬을 찾을 수 없습니다(${this.pythonBin}) — 신형 기기 로컬 제어에는 파이썬 3이 필요합니다. `
        + '설치 후 재시작하거나, 설정의 `localPythonBin`에 실행 경로를 지정하세요.');
    } else if (/No module named pip|no module named pip/.test(r.out)) {
      this.log.error('파이썬에 pip이 없습니다 — `python3 -m ensurepip --upgrade` 또는 '
        + '`apt install python3-pip` 후 홈브릿지를 재시작하세요.');
    } else if (/Temporary failure in name resolution|Network is unreachable|timed out|ProxyError/i.test(r.out)) {
      this.log.error('의존성 설치가 네트워크 문제로 실패했습니다 — 최초 1회는 인터넷(PyPI) 접속이 필요합니다. '
        + `연결을 확인한 뒤 재시작하세요. (pip 출력: ${tail})`);
    } else if (/Could not find a version|No matching distribution/i.test(r.out)) {
      // ★네트워크가 아니라 **파이썬 버전 미달**일 때 나오는 문구다(v2.6.7).
      //   예전엔 이걸 네트워크로 분류해 "인터넷을 확인하세요"라고 안내했고,
      //   인터넷이 멀쩡한 사용자는 막다른 골목에 갇혔다.
      // ⚠️v2.7.2 — 반대 방향으로도 틀렸다. DNS가 죽은 리눅스의 pip 출력에는
      //   `Could not find a version`과 네트워크 문구가 **동시에** 들어 있어서, 이 분기가
      //   앞서 있으면 인터넷 장애를 "파이썬 3.11 이상이 필요합니다 (현재 3.12)"라는
      //   자기모순 문장으로 오진했다. 그래서 네트워크 분기를 위로 올렸다.
      this.log.error(`설치할 수 있는 버전을 찾지 못했습니다 — 파이썬 ${MIN_PYTHON.join('.')} 이상이 필요합니다`
        + ` (현재 ${this._pyVersionText || '알 수 없음'}). 새 파이썬을 설치한 뒤 설정 'localPythonBin'에`
        + ` 그 실행 경로를 지정하고, 로컬 자산 폴더(${this.stateDir})를 지운 뒤 재시작하세요.`);
    } else if (r.timedOut) {
      this.log.error('의존성 설치 시간 초과(180초) — 다음 재시작에서 다시 시도합니다. '
        + `느린 회선이면 한 번 더 재시작해 보세요. (pip 출력: ${tail})`);
    } else if (r.spawnError) {
      // ENOENT 외의 spawn 오류(EACCES 등)는 pip 출력이 비어 원인이 통째로 사라졌었다.
      this.log.error(`의존성 설치 실패 — 파이썬 실행 오류: ${r.spawnError.code || ''} ${r.spawnError.message}`
        + ` (실행 권한 또는 'localPythonBin' 경로를 확인하세요)`);
    } else if (/Permission denied|Errno 13|EACCES/i.test(r.out)) {
      this.log.error(`의존성 설치가 권한 문제로 실패했습니다 — '${this.stateDir}'에 쓸 수 없습니다.`
        + ` 설정 'localStateDir'에 홈브릿지가 쓸 수 있는 경로를 지정하세요. (pip 출력: ${tail})`);
    } else {
      this.log.error(`의존성 설치 실패 (코드 ${r.code}) — pip 출력: ${tail || '(출력 없음)'}`);
    }
    this._installing = false;
    this.log.error('※ 직접 확인: '
      + `${this.pythonBin} -m pip install --target ${this.libDir} smartthings-local`);
    // 스탬프를 쓰지 않았으므로 **다음 재시작에서 자동 재시도**된다.
    throw new Error(r.timedOut ? '의존성 설치 시간 초과(180초)' : `의존성 설치 실패 (코드 ${r.code})`);
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
      this.log.error(`로컬 브릿지 실행 실패: ${err.message} — 파이썬 실행 파일을 확인하세요`
        + ` (설정 'localPythonBin'에 전체 경로를 지정할 수 있습니다). 로컬 제어는 사용할 수 없습니다.`);
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
    // ★★브릿지는 2.xx가 아닌 CoAP 응답을 **실패로** 돌려준다(`{ok:false, code, error}`).
    //   여기서 `code`를 버리면 4.04(리소스 없음)를 통신 실패와 구분할 수 없다.
    //   v2.8.0~2.8.2는 `_assertOk`에만 표식을 달았는데, 그 함수는 **성공 응답에만** 실행되므로
    //   실기기 4.04는 표식 없이 도착했고 온도 경로 판별과 4.04 처리가 전부 사문이었다.
    //   ⚠️회귀 테스트는 반드시 **브릿지가 만드는 메시지 형태**로 주입할 것 —
    //     손으로 `notFound`를 붙여 만든 에러로 시험하면 이 결함을 다시 놓친다.
    if (typeof msg.code === 'number') {
      err.code = msg.code;
      if ((msg.code >> 5) === 4 && (msg.code & 31) === 4) err.notFound = true;
    }
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
      const major = res.code >> 5;
      const minor = res.code & 31;
      const err = new Error(`${what} 거부됨 — CoAP ${major}.${String(minor).padStart(2, '0')}`);
      // 4.04 = 그 리소스가 이 기기에 없다. 통신은 정상이므로 전송 실패와 구분한다.
      // 구분하지 않으면 포트 재탐지와 '제어되지 않습니다' 경보가 헛돈다.
      if (major === 4 && minor === 4) err.notFound = true;
      throw err;
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
        // ★★2026-08-03 — 불일치 래치에 **유효기간**을 둔다(적대 리뷰 H2).
        //   예전엔 한 번 불일치가 나면 홈브릿지를 재시작할 때까지 영영 잠겼다. 그런데
        //   불일치의 흔한 원인은 **DHCP가 그 IP를 잠깐 다른 기기에 준 것**이고, 곧 원래
        //   기기가 돌아온다. 그때도 안 풀렸다 — 폴백이 없는 10월 구성에서는 그 기기가
        //   **재시작 전까지 완전히 죽는다.**
        //   ⚠️완화가 아니다. 불일치는 여전히 즉시·시끄럽게 막고, 다만 IDENTITY_RETRY_MS
        //     뒤에 **한 번 더 물어볼 뿐**이다. 진짜 오타면 같은 error가 다시 난다.
        const until = this._verifyRetryAt.get(deviceId) || 0;
        if (Date.now() < until) throw new Error('로컬 기기 신원 불일치 — 로컬 경로 비활성');
        this._verified.delete(deviceId);
        this._verifyRetryAt.delete(deviceId);
        this.log.info(`[${this._labelOf(deviceId)}] 신원을 다시 확인해 봅니다 (IP가 원래 기기로 돌아왔을 수 있습니다).`);
      } else {
        return;
      }
    }
    if (!this._identityInflight) this._identityInflight = new Map();
    const run = this._doVerify(deviceId).finally(() => this._identityInflight.delete(deviceId));
    this._identityInflight.set(deviceId, run);
    return run;
  }

  // ───────── deviceId 로컬 자동 확인 (v2.7.0) ─────────
  // 기기는 `oic/d`로 자기 `di`(=SmartThings deviceId)와 `n`(모델명)을 알려준다.
  // 실측 2026-07-31: 응답 키 ['di','dmv','icv','if','n','rt'], di는 36자 UUID.
  // 이걸 쓰면 config에 deviceId를 적지 않아도, SmartThings 클라우드 없이 기기를 지목할 수 있다.

  _discoveredPath() { return path.join(this.stateDir, 'discovered.json'); }

  /** 디스크 캐시 읽기. 기기가 꺼져 있는 부팅에서도 deviceId를 잃지 않게 한다. */
  readDiscovered(host) {
    try {
      const all = JSON.parse(fs.readFileSync(this._discoveredPath(), 'utf8'));
      return all && all[host] ? all[host] : null;
    } catch (_) { return null; }        // 없거나 깨졌으면 없는 것으로 본다
  }

  /** 그 IP의 자동 확인 결과를 버린다(신원 불일치 = 캐시가 낡았을 수 있다). */
  _forgetDiscovered(host) {
    if (!host) return;
    try {
      const all = JSON.parse(fs.readFileSync(this._discoveredPath(), 'utf8'));
      if (!all || !all[host]) return;
      delete all[host];
      this._writeJsonAtomic(this._discoveredPath(), all);
      this.log.info(`${host}의 자동 확인 결과를 지웠습니다 — 다음 부팅에 기기에 다시 물어봅니다.`);
    } catch (_) { /* 없으면 지울 것도 없다 */ }
  }

  writeDiscovered(host, rec) {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(this._discoveredPath(), 'utf8')) || {}; } catch (_) { /* 새로 만든다 */ }
    all[host] = { deviceId: rec.deviceId, name: rec.name || null, at: new Date().toISOString() };
    try {
      this._writeJsonAtomic(this._discoveredPath(), all);
    } catch (e) {
      // 캐시 실패는 치명적이지 않다 — 다음 부팅에 다시 물어보면 된다.
      this.log.debug?.(`deviceId 캐시 기록 실패: ${e.message}`);
    }
  }

  /**
   * 등록되지 않은 기기에 직접 물어 신원을 읽는다.
   * registerDevice 이전에 쓰이므로 devices 레지스트리를 거치지 않는다.
   */
  async probeIdentity(host, port, localPort) {
    const res = await this._rpc({ op: 'get', host, port: port || 0, path: ['oic', 'd'], localPort });
    LocalApplianceClient._assertOk(res, '기기 신원 조회');
    this._stat(deviceId).lastOk = Date.now();   // 신원 확인도 실통신이다(적대 리뷰 F7)
    const di = res?.data?.di;
    if (!di || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(di))) {
      throw new Error('기기가 deviceId를 알려주지 않았습니다');
    }
    return { deviceId: String(di).toLowerCase(), name: res?.data?.n || null, port: res.port };
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
      this._verifyRetryAt.set(deviceId, Date.now() + IDENTITY_RETRY_MS);
      // ★폴백을 끈 구성에서 "클라우드로 동작합니다"는 거짓이다(v2.7.2).
      //   registerDevice가 fallbackToCloud를 이미 들고 있는데 쓰지 않고 하드코딩돼 있었다.
      //   이 상황은 IP 오타만으로도 성립하므로 상시 노출되는 문구다.
      const canCloud = !!this.cloud && d?.fallbackToCloud !== false;
      this.log.error(`[${this._labelOf(deviceId)}] ★로컬 기기 신원 불일치 — ${d.host}에 있는 기기는 '${name}'(di ${di})입니다. `
        + 'config의 기기 IP를 확인하세요. 로컬 경로를 끕니다'
        + (canCloud ? ' — 클라우드로 동작합니다.' : ' — 클라우드 폴백이 꺼져 있어 이 기기는 제어되지 않습니다.'));
      // 캐시로 잘못 배운 deviceId일 수 있으니 그 IP의 자동 확인 결과를 버린다.
      // 다음 부팅에서 다시 물어보게 해, 기기 교체·IP 재배정 후 영구 사망을 막는다.
      this._forgetDiscovered(d.host);
      throw new Error('로컬 기기 신원 불일치 — 로컬 경로 비활성');
    }
    this._verified.set(deviceId, true);
    this._learnPort(deviceId, res.port);
    // ★★2026-08-03 — 문구를 `기기 접속됨`(복구 어휘)으로 둔다(적대 리뷰 C-H1).
    //   `_fallbackStreak`·`_deadAnnounced`는 **메모리 전용**이라, 🔴 경보가 걸린 채
    //   홈브릿지가 재시작되고 기기가 그 뒤에 살아 돌아오면 새 프로세스는 streak 0에서
    //   시작해 `로컬 복귀`가 **영영 안 나온다.** 감시기의 🔴는 6시간마다 계속 울린다.
    //   실사용 중 가장 그럴듯한 순서다 — 무응답 → 🔴 → 사용자가 재시작 → 기기 복귀.
    //   부팅당 기기당 1줄이라 로그량 영향이 없고, 이 한 단어로 그 구멍이 닫힌다.
    //   ⚠️`if (name)` 게이트를 뒀더니 **이름을 안 주는 기기에서는 아예 안 찍혔다** — 제거.
    this.log.info(`[${this._labelOf(deviceId)}] 로컬 기기 접속됨${name ? ` — ${name}` : ''}`);
    // ★★2026-08-03 — 기능 목록 덤프를 **부팅 임계 경로에서 뺀다.**
    //   여기서 `await` 하면 이 왕복(실측 8,800자/39항목)이 **모든 첫 읽기 앞을 막는다.**
    //   콜드 부팅에는 홈킷이 특성 6개를 한꺼번에 읽으러 오는데, 기기당 요청이 한 줄로
    //   서 있어 포트 탐지 → 신원 확인 → **덤프** 뒤에야 첫 답이 나간다. 실측 ~7초로
    //   홈브릿지 3초 임계를 넘겨 `slow to respond`가 재시작마다 6줄씩 났다.
    //   ⚠️덤프는 순수 진단용이고 출력이 debug라 평소엔 보이지도 않는다 — 급할 이유가 없다.
    //   ⛔**절대 fire-and-forget으로 바꾸지 말 것** — 기기당 DTLS 세션이 1개뿐이라
    //     직렬화 밖으로 나가면 진행 중인 요청과 같은 세션에서 충돌한다.
    //     그래서 **지연 후 다시 큐에 넣는다**(`_scheduleDump`).
    this._scheduleDump(deviceId);
  }

  /** 기능 목록 덤프를 부팅이 끝난 뒤 큐에 넣는다(임계 경로 회피). */
  _scheduleDump(deviceId) {
    if (this._stopped || this._dumped.has(deviceId) || this._dumpTimers.has(deviceId)) return;
    const t = setTimeout(() => {
      this._dumpTimers.delete(deviceId);
      if (this._stopped) return;
      // ★직렬화 큐를 그대로 탄다 — 세션 충돌 방지.
      this._serialize(deviceId, () => this._dumpResourcesOnce(deviceId)).catch(() => {});
    }, DUMP_DELAY_MS);
    if (typeof t.unref === 'function') t.unref();   // 이것 때문에 프로세스가 안 죽으면 안 된다
    this._dumpTimers.set(deviceId, t);
  }

  // ───────── 기기 기능 목록 덤프 (문제 보고용) ─────────
  // `/device/0`은 배치 인터페이스라 **왕복 한 번에** 그 기기가 가진 리소스와 현재 값을 전부
  // 준다(우리 실기기 실측 39개). 기기마다 무엇을 지원하는지가 모델·펌웨어 세대마다 달라서,
  // 이게 없으면 사용자 로그를 받아도 "무엇을 더 만들 수 있는지"를 알 수 없다.
  // 부팅당 기기당 1회, debug 로그에만 남긴다.
  //
  // ⚠️응답에 WiFi SSID·MAC·시리얼이 섞여 있다. 사용자가 로그를 그대로 보내는 것을 전제로
  //    하므로 값을 가린다 — 어떤 항목이 있는지만 알면 되고, 그 값은 우리에게 필요 없다.
  async _dumpResourcesOnce(deviceId) {
    if (this._dumped.has(deviceId)) return;
    this._dumped.add(deviceId);
    const label = this._labelOf(deviceId);
    try {
      const d = this._dev(deviceId);
      const res = await this._rpc({ op: 'get', host: d.host, port: d.port, path: ['device', '0'], localPort: d.localPort });
      const list = Array.isArray(res?.data) ? res.data : null;
      if (!list) {
        this.log.debug?.(`[${label}] 기기 기능 목록: 배치 조회를 지원하지 않는 기기입니다`);
        return;
      }
      const rows = list
        .filter((it) => it && typeof it === 'object' && it.href)
        .map((it) => `${it.href}  ${LocalApplianceClient._safeJson(it.rep ?? it)}`);
      this.log.debug?.(`[${label}] ── 기기 기능 목록 ${rows.length}개 (문제 보고용) ──`);
      for (const row of rows) this.log.debug?.(`[${label}]   ${row}`);
      this.log.debug?.(`[${label}] ── 기능 목록 끝 ──`);
    } catch (e) {
      // 진단용이므로 실패해도 기기 동작에 영향이 없다.
      this.log.debug?.(`[${label}] 기기 기능 목록을 읽지 못했습니다: ${e.message}`);
    }
  }

  /** 개인정보가 될 수 있는 값을 가리고 JSON으로 만든다. 길면 잘라 로그를 지키지 않는다. */
  static _safeJson(rep) {
    // ⚠️키 이름은 실기기 덤프에서 확인한 것만 넣는다. 같은 값이 **다른 이름으로 다시** 나온다:
    //    `di`(oic/d) = `x.com.samsung.da.deviceId`(personality/presence),
    //    `x.com.samsung.da.subdeviceIdList`(2in1 하위기기 UUID),
    //    `x.com.samsung.da.otnDUID`(펌웨어 고유 식별자).
    //    `\bdi\b`는 `deviceId`에 매치되지 않으므로 따로 적어야 한다.
    const SECRET = /serial|mac|ssid|token|password|passwd|secret|\bkey\b|uuid|duid|deviceid|subdevice|\bdi\b/i;
    const mask = (v) => (typeof v === 'string' ? `‹가림 ${v.length}자›` : '‹가림›');
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = SECRET.test(k) ? mask(val) : walk(val);
        return out;
      }
      return v;
    };
    let s;
    try { s = JSON.stringify(walk(rep)); } catch (_) { return '‹표현 불가›'; }
    // ⚠️여유 있게 자른다. 진단에서 가장 쓸모 있는 것이 `supportedModes` 같은 **긴 목록**인데
    //    거기서 잘리면 이 기능의 목적이 사라진다. 기기 전체 응답이 1만 자 안팎이라
    //    (실측 8,800자/39항목) 이 한도로도 로그가 감당 못 할 만큼 커지지 않는다.
    return s.length > 2000 ? `${s.slice(0, 2000)}… (${s.length}자)` : s;
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
    // ★여기서도 `lastOk` 를 갱신한다 — `_withFallback` 에만 넣었더니 **에어컨 경로가 통째로
    //   빠졌다**(에어컨 getter 들은 `_get` 을 직접 부른다). 배포 후 실측에서 `last_seen` 이
    //   에어컨만 비어 있는 것으로 드러났다. 조회가 성공한 모든 경로에서 갱신해야 한다.
    this._stat(deviceId).lastOk = Date.now();
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
    // 조회든 전송이든 **응답이 왔으면 통신 성공**이다 — `last_seen` 은 "마지막으로 기기와
    // 실제로 통신한 시각"이므로 여기서도 갱신한다(적대 리뷰 F6).
    this._stat(deviceId).lastOk = Date.now();
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
        {
          const st0 = this._stat(deviceId);
          st0.ok += 1;
          st0.lastOk = Date.now();
        }
        {
          const lk = `${deviceId}|${label}`;
          this._labelStreak.set(lk, 0);
          if (this._labelWarned.delete(lk)) {
            this.log.info(`[${this._labelOf(deviceId)}] ${label} 다시 됩니다 — 값 갱신을 재개합니다.`);
          }
        }
        // ★v2.3.6 — 폴백 경고는 있는데 **복귀 알림이 없어**, 로그만 봐서는 아직도 클라우드로
        // 도는지 알 수 없었다(사용자 지적). 실패가 쌓였다가 성공하면 한 줄로 알린다.
        const had = this._fallbackStreak.get(deviceId) || 0;
        if (had > 0) {
          // ★클라우드를 **실제로 쓴 경우에만** 그렇게 말한다(v2.7.2).
          //   `_fallbackSince`가 없다는 건 읽기 유예로 다음 폴을 기다렸을 뿐이라는 뜻이다.
          //   그건 사건이 아니므로 debug로 내린다 — 하루 수십 줄이 여기서 나왔다.
          const since = this._fallbackSince.get(deviceId);
          this._fallbackSince.delete(deviceId);
          // ★★폴백을 끈 구성(10월 유료화 대비)에서는 `_fallbackSince`가 **절대 세워지지 않는다**
          //   — 그 값은 `canFallback` 블록 안에서만 찍히기 때문이다. 그래서 복구가 늘 debug로
          //   떨어졌고, `제어되지 않습니다` 경보(error)는 걸리는데 **푸는 문구가 없었다.**
          //   NAS 감시기(hb-watch)는 복구 어휘로 `로컬 복귀`를 보는데 `로컬 순단 … 정상화`에는
          //   그 말이 없다 → 🔴가 뜨면 기기가 살아나도 영원히 안 풀린다.
          //   (2026-07-31 에너톡에서 겪은 것과 같은 구조 — 로그스타일 §8 규칙 1 위반이었다.)
          //   → **경보가 실제로 걸린 뒤(연속 10회 이상)에만** 복구를 info로 올린다.
          //     짧은 순단까지 info로 올리면 하루 수십 줄이 되므로 그건 debug 그대로 둔다.
          // 순단 1건 종료 — 길이를 기록한다(일일 요약용).
          {
            const st = this._stat(deviceId);
            st.outages += 1;
            const startedAt = this._outageStart.get(deviceId);
            if (startedAt) {
              st.longestMs = Math.max(st.longestMs, Date.now() - startedAt);
              this._outageStart.delete(deviceId);
            }
          }
          const wasAnnouncedDead = this._deadAnnounced.has(deviceId);
          this._deadAnnounced.delete(deviceId);
          if (since) {
            const forSec = Math.round((Date.now() - since) / 1000);
            this.log.info(`[${this._labelOf(deviceId)}] 로컬 복귀 — ${had}회 실패 후 정상화`
              + (forSec ? ` (${forSec}초간 클라우드 사용)` : ''));
          } else if (wasAnnouncedDead) {
            this.log.info(`[${this._labelOf(deviceId)}] 로컬 복귀 — ${had}회 실패 후 정상화 (클라우드 미사용)`);
          } else {
            this.log.debug(`[${this._labelOf(deviceId)}] 로컬 순단 ${had}회 후 정상화 (클라우드 미사용)`);
          }
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
        // `e.sent === false`는 **조회가 시간 초과된 것**이다(`_rpc`가 op으로 판정).
        // 쓰기 작업 안에서도 조회가 먼저 나가는 경우가 있는데(온도 경로 판별), 그 조회가
        // 실패한 것을 '결과 불명'으로 보면 안전한 클라우드 재전송까지 막혀 버튼이 무시된다.
        const preCommand = e.preCommand === true || e.sent === false;

        // 연속 실패가 쌓이면 학습한 포트를 버리고 다음 요청에서 다시 탐지한다
        // (기기 재부팅으로 포트가 바뀌면 재시작 전까지 영구 폴백되던 문제).
        // ★CoAP 4.04는 '이 기기에 그 리소스가 없다'는 확정 답이다. 전송은 멀쩡하므로
        //   연속 실패로 세지 않는다 — 세면 포트 재탐지와 '제어되지 않습니다' 경보가 헛돈다.
        //   실사용자 로그(2026-07-31, 천장형 2대): 온도 리소스가 없다는 이유만으로 포트
        //   재탐지 28회와 허위 경보가 났고, 그동안 전원·모드는 정상 동작하고 있었다.
        const permanent = e.notFound === true;
        const streak = permanent
          ? (this._fallbackStreak.get(deviceId) || 0)
          : (this._fallbackStreak.get(deviceId) || 0) + 1;
        if (!permanent) this._fallbackStreak.set(deviceId, streak);

        // ★★2026-08-03 — **항목별** 연속 실패(적대 리뷰 C-M2).
        //   기기 단위 streak는 폴 라운드의 **첫 성공이 0으로 되돌린다.** 전원 조회는 되는데
        //   온도 조회만 계속 타임아웃이면 streak가 0↔1로 진동해 임계 10에 **영영 못 미친다.**
        //   실측: 하루 1,440라운드에서 보이는 줄 1 · 경보 0 · debug 2,879 — 홈킷 온도는
        //   조용히 동결되는데 로그에는 아무 흔적이 없었다.
        //   ⚠️감시 어휘를 넣지 않는다 — 기기는 살아 있으니 🔴를 띄울 일이 아니다.
        //     사람이 로그를 볼 때 보이면 된다.
        if (!permanent) {
          const lk = `${deviceId}|${label}`;
          const ls = (this._labelStreak.get(lk) || 0) + 1;
          this._labelStreak.set(lk, ls);
          if (ls === LOCAL_DEAD_AFTER && !this._labelWarned.has(lk)) {
            this._labelWarned.add(lk);
            this.log.warn(`[${this._labelOf(deviceId)}] ${label}만 ${ls}회 연속 안 됩니다 `
              + '— 다른 항목은 되고 있어 이 값만 갱신이 멈춥니다.');
          }
        }
        // 일일 요약 집계 — 리소스 부재(permanent)는 통신 실패가 아니므로 세지 않는다.
        if (!permanent) {
          const st = this._stat(deviceId);
          st.fail += 1;
          if (kind !== 'read') st.cmdFail += 1;
          if (!this._outageStart.has(deviceId)) this._outageStart.set(deviceId, Date.now());
        }
        // ★`_fallbackSince`는 **실제로 클라우드를 부른 순간**에만 찍는다(v2.7.2).
        //   v2.7.1까지는 첫 실패에서 무조건 찍었는데, 첫 실패는 읽기 유예(READ_FALLBACK_AFTER)로
        //   **클라우드에 가지 않고 다음 폴을 기다린다.** 그래서 다음 폴이 성공하면
        //   `로컬 복귀 — 1회 실패 후 정상화 (N초간 클라우드 사용)`이라는 **거짓 문구**가 나왔다.
        //   11일치 계측에서 34건 중 22건이 이 경우였고, 그 숫자로 폴백 해제를 판단할 뻔했다.
        //   이제 아래 `cloudFn()` 직전에 찍는다.
        // ★★기억해 둔 포트는 **첫 실패에 바로 버린다**(2026-08-03).
        //   기기가 포트를 바꿨을 때 PORT_RESET_AFTER(3회)를 기다리면 20초×3 = 1분을
        //   허비한다. 캐시는 어디까지나 탐지 3초를 아끼자는 것이지, 그것 때문에 1분을
        //   잃으면 손해다. 버려도 잃는 건 그 3초뿐이고 곧바로 재탐지로 복구된다.
        //   ⚠️실제 통신으로 확인된 포트(`_learnPort`)는 이 분기에 걸리지 않는다.
        if (!permanent && streak === 1 && d && d.portFromCache) {
          d.port = undefined;
          d.portFromCache = false;
          this._forgetPort(d.host);
          this.log.debug?.(`[${this._labelOf(deviceId)}] 기억해 둔 포트가 안 맞아 다시 탐지합니다`);
        }
        if (!permanent && streak === PORT_RESET_AFTER && d) {
          // ★브릿지가 아예 안 떠 있으면 원인은 포트가 아니다(v2.6.7).
          //   실사용자 로그에서 pip 실패로 브릿지가 없는데 "포트를 다시 탐지합니다"가 찍혀
          //   포트 문제로 오인하게 만들었다. 재탐지도 실제로는 일어나지 않는다.
          if (!this._ready) {
            this.log.warn(`[${this._labelOf(deviceId)}] 로컬 브릿지가 떠 있지 않아 요청이 계속 실패합니다 `
              + `— 부팅 로그의 '의존성 설치' 오류를 확인하세요. 재시작하면 설치를 다시 시도합니다.`);
          } else if (this._verified.get(deviceId) === false) {
            // ★신원 불일치로 잠겨 있으면 원인은 포트가 아니다(적대 리뷰 C-L2).
            //   여기서 "포트를 다시 탐지합니다"라고 하면 엉뚱한 곳을 보게 만들고,
            //   재탐지도 잠금 때문에 실제로는 아무 의미가 없다.
            this.log.debug?.(`[${this._labelOf(deviceId)}] 신원 불일치로 잠긴 상태 — 포트 재탐지는 건너뜁니다`);
          } else {
            d.port = undefined;
            // ★기억해 둔 포트도 함께 버린다 — 안 그러면 다음 부팅에 같은 낡은 포트를 되살린다.
            this._forgetPort(d.host);
            this.log.warn(`[${this._labelOf(deviceId)}] 로컬 연속 실패 ${streak}회 — 포트를 다시 탐지합니다`);
          }
        }
        const canFallback = this.cloud && d?.fallbackToCloud !== false && typeof cloudFn === 'function';
        if (!permanent && streak === LOCAL_DEAD_AFTER) {
          // 이 경보를 걸었다는 사실을 남긴다 — 복구 때 info로 풀어 주기 위해서다.
          this._deadAnnounced.add(deviceId);
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
        // ★★리소스 부재 안내는 **폴백 유무와 무관하게** 낸다(2026-08-03 적대 리뷰, 독립 2기 합치).
        //   v2.10.1까지는 이 안내가 `if (canFallback)` 안에 갇혀 있어, **폴백을 끄면 로그가
        //   0줄**이었다 — debug조차 없었다. 리소스 부재는 연속 실패로도 안 세므로
        //   `제어되지 않습니다` 경보도 안 걸린다 → 그 값이 홈킷에서 영영 비어 있는데
        //   **사용자가 이유를 알 방법이 아예 없었다.**
        //   ⚠️천장형 에어컨의 온도 리소스 부재(§0-A16)가 정확히 이 경우다. 10월 이후
        //     폴백을 끈 사용자에게 그 일이 그대로 일어난다.
        //   `_fallbackSince`를 고친 것과 **같은 부류 — 진단 문구가 폴백 분기에 갇힌 것**이다.
        if (permanent) {
          const key = `${deviceId}|${label}`;
          if (!this._permanentNotified.has(key)) {
            this._permanentNotified.add(key);
            this.log.warn(canFallback
              ? `[${this._labelOf(deviceId)}] 이 기기에 ${label} 리소스가 없어 앞으로 폴링마다 클라우드를 부릅니다`
              : `[${this._labelOf(deviceId)}] 이 기기에 ${label} 리소스가 없습니다 — 그 값은 홈킷에 표시되지 않습니다`);
          }
        }

        if (canFallback) {
          // ⚠️문구에 `상태 조회 실패`가 들어가면 NAS의 hb-watch 감시기가 경보를 낸다
          //   (label='상태 조회'이므로 예전 문구 "로컬 상태 조회 실패"가 정확히 걸렸다 — 감사 L-F3).
          //   진짜 경보는 아래 LOCAL_DEAD_AFTER의 error 한 줄이 맡는다.
          // ★리소스 부재는 '응답 없음'이 아니다 — 기기가 없다고 **답한** 것이고, 연속 실패로
          //   세지 않으므로 `(N회째)`도 늘 0이다. 문구를 따로 쓴다.
          const line = permanent
            ? `[${this._labelOf(deviceId)}] 로컬에 ${label} 리소스가 없어 클라우드로 대체: ${e.message}`
            : `[${this._labelOf(deviceId)}] 로컬 ${label} 응답 없음 — 클라우드로 대체 (${streak}회째): ${e.message}`;
          // 폴백 진입 시 1줄만 알린다. 계속 실패하는 동안은 조용히 — 복귀하면 위에서 요약해 준다.
          if (!permanent && (streak === READ_FALLBACK_AFTER || kind === 'write')) this.log.warn(line);
          else this.log.debug(line);
          if (!permanent && !this._fallbackSince.has(deviceId)) {
            // ⚠️`_fallbackSince`는 **연속 실패가 복구될 때** 정리된다. 리소스 부재는 그 계수를
            //   올리지 않아 영영 정리되지 않으므로, 여기서 찍으면 나중에 무관한 순단이 복구될 때
            //   `(N초간 클라우드 사용)`이라는 거짓 문구가 붙는다(v2.7.2가 고쳤던 그 문구).
            this._fallbackSince.set(deviceId, Date.now());
          }
          this._stat(deviceId).cloud += 1;
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

  // 온도는 보드마다 리소스 경로가 달라 `tempChannel`이 판별해 읽고 쓴다.
  // 표준 경로를 가진 보드에서는 예전과 같은 요청이 나간다(값이 없으면 던져 폴백이 작동한다).
  async getCurrentTemperature(deviceId) {
    return this._withFallback(deviceId, '실내온도 조회',
      () => this.tempChannel.readCurrent(deviceId),
      () => this.cloud.getCurrentTemperature(deviceId));
  }

  async getCoolingSetpoint(deviceId) {
    return this._withFallback(deviceId, '희망온도 조회',
      () => this.tempChannel.readDesired(deviceId),
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

  /**
   * 그 기기가 실제로 지원하는 운전 모드 목록. 알 수 없으면 빈 배열.
   * ⚠️모델마다 다르다 — 실측 2026-08-01: 창문형 `[AIComfort, Cool, Dry, Fan]`(자동 없음),
   *    천장형 CAC `[Auto, Cool, Dry, Fan, AIComfort]`. 하나를 기준으로 목록을 고정하면
   *    다른 기기 사용자에게 "없는 걸 고르게" 하거나 "있는 걸 못 고르게" 한다.
   */
  async getSupportedModes(deviceId) {
    try {
      const r = await this._get(deviceId, ['mode', 'vs', '0']);
      const list = r?.['x.com.samsung.da.supportedModes'];
      return Array.isArray(list) ? list.map(String) : [];
    } catch (_) { return []; }
  }

  // ───────── 바람방향 (v2.9.0) ─────────
  // `/wind/direction/vs/0` — 실기기 보고 예: modes "Fix",
  // supportedModes ["Up_And_Low","Fix","Left_And_Right","All"].
  // ⚠️SmartThings 클라우드에는 대응 기능이 없다. 로컬 경로 전용이며, 폴백이 불릴 일이
  //   없도록 명확한 오류를 던진다(조용히 성공한 척하면 토글이 거짓말을 한다).
  // ⚠️바람방향은 SmartThings 클라우드에 대응 기능이 **없다**. 그래서 폴백 함수를 주지 않는다
  //   (`cloudFn = null` → `_withFallback`이 클라우드를 부르지 않고 로컬 오류를 그대로 올린다).
  //   v2.10.0까지는 '항상 던지는 스텁'을 줬는데, `_withFallback`이 그걸 클라우드 호출로 여겨
  //   **매 폴마다 실행**했고 그 예외가 **폴 라운드 전체를 죽였다**(적대 리뷰 H2):
  //   전원·온도·희망온도·무풍·자동건조 갱신까지 통째로 유실되고 로그는 debug 한 줄뿐이었다.

  async getWindDirection(deviceId) {
    return this._withFallback(deviceId, '바람방향 조회',
      async () => {
        const r = await this._get(deviceId, ['wind', 'direction', 'vs', '0']);
        const mode = r?.['x.com.samsung.da.modes'];
        if (!mode) throw new Error('바람방향 응답에 값이 없습니다');
        return String(mode);
      },
      null);
  }

  /**
   * 현재 운전 모드(Cool·Dry·Fan·AIComfort…). **로컬 응답에 이미 실려 오던 값**인데
   * v2.12.0까지는 `supportedModes`(목록)만 읽고 현재값을 버리고 있었다(2026-08-04 지적).
   * ★홈킷은 '냉방/끔' 2모드로 고정돼 있고, `coolModeCommand`(우리 집은 `dry`) 때문에
   *   홈킷의 '냉방'이 실제로는 제습으로 나간다 — 그래서 **홈킷 표시와 기기 실모드가 다르다**.
   *   이 getter는 그 '실제 모드'를 알려준다(표시 전용, 제어는 기존 경로 그대로).
   * 값 형태가 문자열/배열 둘 다 관측되는 리소스라 양쪽을 받아 첫 값을 쓴다.
   * 실패는 null — 폴백(클라우드)을 부르지 않는다(로컬 전용 운영).
   */
  // ─────────────────────────────────────────────────────────────────────────
  // ★getter 반환 계약 (2026-08-05 통일 — 적대 리뷰에서 21종 중 15종이 어기고 있었다)
  //
  //   조회 실패(통신 오류·타임아웃)  → **undefined**  = "못 읽었다" → 소비자는 손대지 않는다
  //   조회 성공 + 값 없음            → **null**       = "값이 없다" → 소비자는 키를 지운다
  //   조회 성공 + 값 있음            → 실제 값
  //
  // ⚠️이 둘을 뭉개면 증상은 **항상 같다**: 값이 사라져도 HA 센서가 옛 값에 영구 고착된다.
  //   같은 함정을 이틀에 여섯 번 밟았고, 그때마다 주석으로 규칙을 적어 놓고 다음 날 어겼다.
  //   ⛔**주석은 안 지켜진다 — `test/getter_contract.js` 회귀가 이 계약을 강제한다.**
  // ─────────────────────────────────────────────────────────────────────────
  async getMode(deviceId) {
    try {
      const r = await this._get(deviceId, ['mode', 'vs', '0']);
      const m = r?.['x.com.samsung.da.modes'];
      const v = Array.isArray(m) ? m[0] : m;
      return (v === undefined || v === null || v === '') ? null : String(v);
    } catch (e) { return undefined; }
  }

  /** 그 기기가 실제로 지원하는 바람방향 목록. 알 수 없으면 빈 배열. */
  async getSupportedWindDirections(deviceId) {
    try {
      const r = await this._get(deviceId, ['wind', 'direction', 'vs', '0']);
      const list = r?.['x.com.samsung.da.supportedModes'];
      return Array.isArray(list) ? list.map(String) : [];
    } catch (_) { return []; }
  }

  setWindDirection(deviceId, mode) {
    return this._withFallback(deviceId, '바람방향 전송',
      () => this._post(deviceId, ['wind', 'direction', 'vs', '0'],
        { 'x.com.samsung.da.modes': String(mode) }),
      null,
      { kind: 'write', fallbackOnUnknown: false });
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
    } catch (e) { return undefined; }
  }

  async getHumidity(deviceId) {
    try {
      const r = await this._get(deviceId, ['humidity', 'vs', '0']);
      // 실측: da.humidity=0(미지원), da.fivepercentHumidity가 실제값(5% 해상도).
      const h = Number(r?.['x.com.samsung.da.fivepercentHumidity']);
      return Number.isFinite(h) && h > 0 ? h : null;
    } catch (e) { return undefined; }
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
    } catch (e) { return undefined; }
  }

  // ───────── HA 전용 읽기 (홈킷엔 없지만 HA에서 쓸 수 있는 값들, 2026-08-04) ─────────
  //
  // ★왜: 기기가 `/device/0` 로 보고하는 값 중 상당수가 **아무 데도 안 가고 있었다**
  //   (에어컨 37 리소스 중 우리가 쓰던 건 일부). 홈킷에 자리가 없다고 버릴 이유는 없다 —
  //   HA 는 숫자·상태·이력을 제대로 담고, 나중에 무엇에 쓸지는 그때 정하면 된다.
  // ⚠️전부 실패해도 null 을 돌려준다. 이 값들 때문에 폴 라운드가 죽으면 안 된다.
  // ⚠️**없는 값을 있는 척 만들지 않는다** — 실측에서 `/sensors/vs/0` 는 `{}`,
  //   `/personality/presence` 는 빈 문자열이었다. 그런 리소스는 아예 읽지 않는다.

  /** 바람세기 — Auto/1~5. 실측: modes "0", supportedModes ["0".."5"], modesName ["Auto","1".."5"] */
  async getWindStrength(deviceId) {
    try {
      const r = await this._get(deviceId, ['wind', 'strength', 'vs', '0']);
      const cur = String(r?.['x.com.samsung.da.modes'] ?? '');
      if (!cur) return null;
      const names = r?.['x.com.samsung.da.modesName'];
      const list = r?.['x.com.samsung.da.supportedModes'];
      let label = cur;
      if (Array.isArray(names) && Array.isArray(list)) {
        const i = list.indexOf(cur);
        if (i >= 0 && names[i]) label = String(names[i]);
      }
      return { level: cur, label };
    } catch (e) { return undefined; }
  }

  /** 편의 모드 — 실측: Off/Quiet/Nano(무풍)/NanoSleep. 무풍 스위치와 같은 리소스다. */
  async getConvenientMode(deviceId) {
    try {
      const r = await this._get(deviceId, ['mode', 'convenient', 'vs', '0']);
      const m = r?.['x.com.samsung.da.modes'];
      const cur = Array.isArray(m) ? m[0] : m;
      return (typeof cur === 'string' && cur) ? cur : null;
    } catch (e) { return undefined; }
  }

  /** 자동건조(에어컨) 진행 상태 — 홈킷 스위치는 켜짐/꺼짐뿐이라 **진행률이 안 보인다**. */
  async getAutoCleanProgress(deviceId) {
    try {
      const r = await this._get(deviceId, ['option', 'autoclean', 'vs', '0']);
      const pct = Number(r?.['x.com.samsung.da.progress']);
      return {
        running: r?.['x.com.samsung.da.status'] === 'Start',
        enabled: r?.['x.com.samsung.da.settingStatus'] === 'On',
        progress: Number.isFinite(pct) ? pct : null,
      };
    } catch (e) { return undefined; }
  }

  /** 기기 알람(오류코드). 실측 정상값은 `ErrorCode_OFF`. */
  async getAlarm(deviceId) {
    try {
      const r = await this._get(deviceId, ['alarms', 'vs', '0']);
      const items = r?.['x.com.samsung.da.items'];
      if (!Array.isArray(items) || items.length === 0) return { code: null, ok: true };
      const code = String(items[0]?.['x.com.samsung.da.code'] || '');
      if (!code) return { code: null, ok: true };
      return { code, ok: /_OFF$|NONE/i.test(code) };
    } catch (e) { return undefined; }
  }

  /** 자가진단 상태 — 에어컨·정수기 공통 리소스 */
  async getSelfCheck(deviceId) {
    try {
      const r = await this._get(deviceId, ['selfcheck', 'vs', '0']);
      const st = r?.['x.com.samsung.da.status'];
      if (typeof st !== 'string' || !st) return null;
      const err = r?.['x.com.samsung.da.error'];
      return {
        status: st,
        result: r?.['x.com.samsung.da.result'] ?? null,
        error: Array.isArray(err) ? err[0] : (err ?? null),
      };
    } catch (e) { return undefined; }
  }

  /** ★★원격제어 허용 여부 — false 면 **HA 명령이 기기에 안 먹는다**. 몰라서 헤매기 딱 좋다. */
  async getRemoteControl(deviceId) {
    try {
      const r = await this._get(deviceId, ['remotectrl', 'vs', '0']);
      const v = r?.['x.com.samsung.da.remoteControlEnabled'];
      if (v === true || v === 'true') return true;
      if (v === false || v === 'false') return false;
      return null;
    } catch (e) { return undefined; }
  }

  /** 어린이 잠금 (세탁/건조) */
  async getKidsLock(deviceId) {
    try {
      const r = await this._get(deviceId, ['kidslock', 'vs', '0']);
      const v = r?.['x.com.samsung.da.kidsLock'];
      if (typeof v !== 'string' || !v) return null;
      return v;   // 실측 'Ready' — 값 어휘를 우리가 해석하지 않고 그대로 넘긴다
    } catch (e) { return undefined; }
  }

  /** 건조 설정 — 건조 강도·구김방지 */
  async getDryerSetting(deviceId) {
    try {
      const r = await this._get(deviceId, ['washer', 'vs', '0']);
      const lvl = r?.['x.com.samsung.da.dryLevel'];
      if (typeof lvl !== 'string' || !lvl) return null;
      return {
        dryLevel: lvl,
        wrinklePrevent: r?.['x.com.samsung.da.wrinklePrevent'] === 'On',
      };
    } catch (e) { return undefined; }
  }

  // ───────── 정수기 (2026-08-04, HA 전용 — 홈킷 액세서리 없음) ─────────
  //
  // 실측(192.168.1.63, TP2X_WATERPURIFIER_20K): 리소스 16개, 포트 49155.
  // ⚠️**오늘 출수량(L)·일일 그래프는 로컬에 없다** — 앱의 그 화면은 클라우드 집계다.
  //   `pourStatus` 로 HA 가 직접 셀 수는 있으나 폴링으로는 짧은 출수를 놓친다(별건).

  /** 필터 — 실측 filterUsage "57" = **사용률**. 앱은 잔여 43% 로 보여 준다. */
  async getWaterFilter(deviceId) {
    try {
      const r = await this._get(deviceId, ['filter', 'waterfilter', 'vs', '0']);
      // ⚠️`Number(null)` 은 0 이라, 값이 없을 때 **잔여 100%("새 필터")로 오표시**된다(리뷰 L-5).
      const raw = r?.['x.com.samsung.da.filterUsage'];
      if (raw == null || raw === '') return null;
      const used = Number(raw);
      if (!Number.isFinite(used)) return null;
      return {
        used_percent: used,
        remain_percent: Math.max(0, Math.min(100, 100 - used)),
        status: r?.['x.com.samsung.da.filterStatus'] ?? null,
        last_reset: r?.['x.com.samsung.da.lastResetDate'] ?? null,
      };
    } catch (e) { return undefined; }
  }

  /** 본체 상태 + 살균 일정. ⚠️기기 시각은 **UTC** 다(실측: 앱 표시와 +9h 차이). */
  async getWaterPurifierStatus(deviceId) {
    try {
      const r = await this._get(deviceId, ['status', 'waterpurifier', 'vs', '0']);
      const st = r?.['x.com.samsung.da.status'];
      if (typeof st !== 'string' || !st) return null;
      const run = Number(r?.['x.com.samsung.da.sterilizeRunTime']);
      return {
        status: st,
        filter_door: r?.['x.com.samsung.da.filterDoorStatus'] ?? null,
        sterilize_last: r?.['x.com.samsung.da.sterilizeLastTime'] ?? null,
        sterilize_next: r?.['x.com.samsung.da.sterilizePlanTime'] ?? null,
        sterilize_period_day: Number(r?.['x.com.samsung.da.sterilizePeriod']) || null,
        sterilize_running: Number.isFinite(run) ? run > 0 : null,
      };
    } catch (e) { return undefined; }
  }

  /** 설정 — 온수 온도(40/75/85)·출수량(50~2000mL)·출수 중 여부 */
  async getWaterPurifierSetting(deviceId) {
    try {
      const r = await this._get(deviceId, ['setting', 'waterpurifier', 'vs', '0']);
      const hot = Number(r?.['x.com.samsung.da.tempDesiredHotWater']);
      const cap = Number(r?.['x.com.samsung.da.desiredCapacity']);
      const pour = r?.['x.com.samsung.da.pourStatus'];
      if (!Number.isFinite(hot) && !Number.isFinite(cap) && pour === undefined) return null;
      return {
        hot_temp: Number.isFinite(hot) ? hot : null,
        capacity_ml: Number.isFinite(cap) ? cap : null,
        desired_type: r?.['x.com.samsung.da.desiredType'] ?? null,
        // ⚠️`pour` 가 null·빈문자면 `!== 'Off'` 가 **true(출수 중)** 가 된다(리뷰 L-1).
        //   모르는 건 모른다고 한다.
        pouring: (typeof pour === 'string' && pour) ? pour !== 'Off' : null,
      };
    } catch (e) { return undefined; }
  }

  /** 잠금 3종 — 온수·냉수·소리. 실측 어휘 'Locked'/'Unlocked'. */
  async getWaterPurifierLocks(deviceId) {
    try {
      const r = await this._get(deviceId, ['status', 'lock', 'vs', '0']);
      const conv = (v) => (typeof v === 'string' && v ? v === 'Locked' : null);
      const hot = r?.['x.com.samsung.da.hotwaterLock'];
      if (hot === undefined) return null;
      return {
        hot: conv(hot),
        cold: conv(r?.['x.com.samsung.da.coldwaterLock']),
        buzz: conv(r?.['x.com.samsung.da.buzzLock']),
      };
    } catch (e) { return undefined; }
  }

  /** 건조 코스 — 실측 `options` 배열에 `Course_03` 형태로 들어 있다.
   *  ⚠️번호만 오고 이름은 안 온다. **우리가 이름을 지어내지 않는다** — 번호를 그대로 넘긴다.
   *  (HA 쪽에서 필요하면 사용자가 아는 매핑을 붙이면 된다.) */
  async getDryerCourse(deviceId) {
    try {
      const r = await this._get(deviceId, ['course', 'vs', '0']);
      const opts = r?.['x.com.samsung.da.options'];
      // ★★"조회는 성공했는데 값이 없다"와 "조회 자체가 실패했다"를 **구분한다**(리뷰 M-1).
      //   둘 다 null 을 돌려주면 호출측이 undefined("안 읽음")로 바꿔 발행을 건너뛰고,
      //   **HA 의 코스 센서가 옛 값에 영구 고착**된다. `getAlarm` 이 쓰는 방식과 같게 맞춘다.
      //   ⚠️오늘만 세 번째다 — `publishLaundryState` · `alarm_code` · 여기.
      const hit = Array.isArray(opts)
        ? opts.find((o) => typeof o === 'string' && /^Course_/.test(o))
        : null;
      if (!hit) return { code: null, number: null };   // 성공·빈 값
      const num = hit.slice('Course_'.length);
      return { code: hit, number: /^\d+$/.test(num) ? Number(num) : null };
    } catch (e) { return undefined; }                        // 조회 실패
  }

  /** 열대야쾌면 — 실측: displayNightMode Off, elapsedTime 0, sleepTime "14002200".
   *  ⚠️`sleepTime` 은 `HHMMHHMM`(시작·종료)로 **보이지만 미검증**이라 발행하지 않는다.
   *  ⚠️★`elapsedTime` 의 **단위도 미검증**이다 — 실측값이 `"0"` 하나뿐이라 분인지 초인지
   *    판별할 수 없다. `sleepTime` 은 "미검증"이라 적어 놓고 이것만 분으로 못박았던 것을
   *    되돌린다(리뷰 M-3). 열대야쾌면을 실제로 한 번 돌려 대조하기 전까지 **단위를 안 붙인다.** */
  async getAiSleep(deviceId) {
    try {
      const r = await this._get(deviceId, ['aisleep', 'vs', '0']);
      const night = r?.['x.com.samsung.da.displayNightMode'];
      // ⚠️`Number(null)`·`Number('')` 은 **0** 이다 — 값 없음이 "0분"으로 둔갑한다(리뷰 M-2).
      //   `getWaterFilter` 에는 이 가드를 달아 놓고 **같은 날 쓴 여기엔 안 달았다.**
      //   (이 저장소의 "버그 수정은 전 스크립트에 전파" 원칙을 스스로 어긴 것이다.)
      const rawEl = r?.['x.com.samsung.da.elapsedTime'];
      const el = (rawEl == null || rawEl === '') ? NaN : Number(rawEl);
      return {
        // 성공했는데 값이 없으면 필드만 null — 조회 실패(아래 catch)와 구분된다(M-1)
        night_mode: (typeof night === 'string' && night) ? night === 'On' : null,
        elapsed: Number.isFinite(el) ? el : null,
      };
    } catch (e) { return undefined; }
  }

  /** 정수기 '나만의 출수량' — 앱의 그 토글이 `switchCapacity` 다. */
  async getFavoriteCapacity(deviceId) {
    try {
      const r = await this._get(deviceId, ['favorite', 'capacity', 'vs', '0']);
      const sw = r?.['x.com.samsung.da.switchCapacity'];
      const rawDef = r?.['x.com.samsung.da.defaultCapacity'];
      const def = (rawDef == null || rawDef === '') ? NaN : Number(rawDef);   // M-2
      return {
        enabled: (typeof sw === 'string' && sw) ? sw === 'On' : null,          // M-1
        default_ml: Number.isFinite(def) ? def : null,
      };
    } catch (e) { return undefined; }
  }

  async getLight(deviceId) {
    try {
      const r = await this._get(deviceId, ['light', 'vs', '0']);
      if (r?.mode === 'On') return true;
      if (r?.mode === 'Off') return false;
      return null;
    } catch (e) { return undefined; }
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
    } catch (e) { return undefined; }
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
      () => this.tempChannel.writeDesired(deviceId, value),
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

// 설정값 → 기기 모드값 대응. 액세서리가 지원 여부를 판정할 때 쓴다.
LocalApplianceClient.MODE_MAP = MODE_MAP;

module.exports = LocalApplianceClient;
