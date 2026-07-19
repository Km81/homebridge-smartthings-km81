'use strict';
// ============================================================================
// audit_efficiency.js — 효율·자원·최적화 차원의 표적 시뮬레이션 (v2.1.1 / HEAD)
//
// 원칙: lib/ 소스는 읽기 전용. 실제 prototype 메서드 + 실제 타이머를 구동하고
//       I/O(TLS 소켓 / axios)만 mock 하여 **기기로 실제로 나가는 왕복 횟수**를 센다.
//
// 시간 축 축소 고지:
//   - E1(폴 공유)만 실제 상수 그대로(pollingInterval 10s, POLL_SHARE_MAX_AGE_MS 7s)
//     25초를 실시간으로 돌린다. 이 시나리오는 "폴 간격 vs 공유창"의 비(ratio)가
//     본질이라 축소하면 검증이 무의미해지므로 축소하지 않았다.
//   - E4/E5의 ON 보호창(_onGuardMs)과 재전송 간격(_powerOnResendStepMs)은 실환경
//     4000ms → 400/600ms로 **축소**했다. 축소한 것은 '간격'뿐이고 세는 대상(왕복 횟수)은
//     간격과 무관하다. E4 시나리오 주석에 축소값을 명시했다.
//   - 그 외(E2,E3,E6~E10)는 상수 축소 없음.
// ============================================================================
const path = require('path');
const REPO = path.join(__dirname, '..');
const LegacyAC = require(path.join(REPO, 'lib/accessories/LegacyAC.js'));
const { LegacyACClient, getCertificate } = require(path.join(REPO, 'lib/api/LegacyACClient.js'));
const SmartThingsClient = require(path.join(REPO, 'lib/api/SmartThingsClient.js'));
const { LRUCache } = require('lru-cache');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let total = 0, fail = 0;
const anomalies = [];
function S(id, title) {
  console.log(`\n=== [${id}] ${title}`);
  return {
    check(name, cond, extra) {
      total++; if (!cond) fail++;
      console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
    },
    measure(name, value) { console.log(`  MEAS ${name} = ${value}`); },
    note(msg) { console.log(`  NOTE ${msg}`); },
    anomaly(msg) { anomalies.push(`[${id}] ${msg}`); console.log(`  ANOMALY ${msg}`); },
  };
}
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------
// 폴링 전용 경량 LegacyAC rig (HAP 없음). 실제 _poll/getCachedState를 구동.
// ---------------------------------------------------------------------------
function makePollRig(name, deviceIndex, client, pollingInterval) {
  const o = Object.create(LegacyAC.prototype);
  o.log = quietLog;
  o.name = name;
  o.debugMode = false;
  o.deviceIndex = deviceIndex;
  o.setDeviceIndex = deviceIndex;
  o.cacheDuration = 30000;
  o.pollingInterval = pollingInterval;
  o.pollTimer = null;
  o.deviceState = null;
  o.lastStateUpdate = 0;
  o.stateRequestPromise = null;
  o._stopped = false;
  o._lastFetchTs = 0; o._lastMutSrc = null;
  o._stateDumpFile = null; o._lastStateDump = 0; o._stateDumpTimer = null;
  o._pollFailStreak = 0;
  o._refreshTimer = null;
  o._pendingDebounces = new Map(); o._deferredCommands = new Map();
  o._onGuardMs = 0; o._onGuardUntil = 0; o._onGuardTimer = null;
  o._powerOnResendGen = 0; o._powerOnModeTimer = null;
  o._offRetryTimer = null; o._offVerifyTimer = null;
  o._initialized = true;
  o.client = client;
  return o;
}

// ---------------------------------------------------------------------------
// setter/getter까지 실제로 등록되는 full rig (sim_v1824 패턴 차용)
// ---------------------------------------------------------------------------
function makeFullRig(opts = {}) {
  const wire = [];
  let t0 = Date.now();
  const rel = () => Date.now() - t0;
  const C = {
    Active: { displayName: 'Active' },
    CurrentHeaterCoolerState: { displayName: 'CurrentState', INACTIVE: 0, IDLE: 1, COOLING: 2 },
    TargetHeaterCoolerState: { displayName: 'TargetState', COOL: 2 },
    CurrentTemperature: { displayName: 'CurrentTemp' },
    CoolingThresholdTemperature: { displayName: 'CoolingThreshold' },
    SwingMode: { displayName: 'SwingMode' },
    LockPhysicalControls: { displayName: 'Lock' },
  };
  const chars = new Map();
  const svc = {
    getCharacteristic(c) {
      if (!chars.has(c)) {
        chars.set(c, {
          _get: null, _set: null,
          onGet(fn) { this._get = fn; return this; },
          onSet(fn) { this._set = fn; return this; },
          setProps() { return this; },
        });
      }
      return chars.get(c);
    },
    testCharacteristic(c) { return chars.has(c); },
    removeCharacteristic() {},
  };

  const o = Object.create(LegacyAC.prototype);
  o.log = quietLog;
  o.api = { hap: { HapStatusError: class HapStatusError extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } };
  o.Service = { HeaterCooler: 'HC' };
  o.Characteristic = C;
  o.aircoService = svc;
  o.name = opts.name || 'AC';
  o.debugMode = false;
  o.deviceIndex = 0; o.setDeviceIndex = 0;
  o.cacheDuration = opts.cacheDuration != null ? opts.cacheDuration : 30000;
  o.timeout = 5000; o.pollingInterval = undefined; o.pollTimer = null;
  o.minTemp = 18; o.maxTemp = 30;
  o.coolModeStr = 'DryClean';
  o.swingBinding = 'comfort'; o.lockBinding = 'autoClean';
  o.swingModeHandler = {
    getValue: st => !!(st && st.Mode && st.Mode.options && st.Mode.options.includes('Comode_Nano')),
    getCommand: en => ({ endpoint: '/mode', data: { options: [en ? 'Comode_Nano' : 'Comode_Off'] } }),
  };
  o.deviceState = opts.noState ? null : {
    Operation: { power: opts.power || 'On' },
    Mode: { modes: opts.modes || ['Auto'], options: opts.options || ['Comode_Off'] },
    Temperatures: [{ current: 26, desired: opts.desired != null ? opts.desired : 26 }],
  };
  o.lastStateUpdate = opts.noState ? 0 : (opts.stateAge != null ? Date.now() - opts.stateAge : Date.now());
  o.stateRequestPromise = null;
  o._cmdMutex = Promise.resolve(); o._stopped = false; o._pendingCmdCount = 0; o._activeInFlight = null;
  o._onGuardMs = opts.guardMs != null ? opts.guardMs : 400;   // 실환경 4000 → 400 축소
  o._onGuardStrategy = 'drop'; o._onGuardUntil = 0; o._onGuardTimer = null; o._deferredCommands = new Map();
  o._resendModeOnPowerOn = opts.resendMode !== false;
  o._resendAutoCleanOnPowerOn = opts.resendAutoClean !== false;
  o._resendSwingOffOnPowerOn = opts.resendSwingOff === true;
  o._hideSwingToggle = false; o._hideLockToggle = false;
  o._powerOnResendStepMs = opts.stepMs != null ? opts.stepMs : 600;  // 실환경 4000 → 600 축소
  o._powerOnModeTimer = null; o._powerOnResendGen = 0;
  o._offIntentTs = 0;
  o._stateDumpFile = null; o._lastStateDump = 0; o._stateDumpTimer = null; o._lastFetchTs = 0; o._lastMutSrc = null;
  o._refreshTimer = null; o._pendingDebounces = new Map();
  o._offRetryTimer = null; o._offVerifyTimer = null; o._pollFailStreak = 0;
  o._initialized = true;

  const lat = opts.clientLatency != null ? opts.clientLatency : 20;
  o.client = {
    lastStatusTs: 0,
    sendCommand: async (idx, ep, data) => {
      wire.push({ t: rel(), kind: 'PUT', ep, data: JSON.stringify(data) });
      await sleep(lat);
      if (opts.putFails) throw new Error('요청 시간 초과 (5000ms)');
    },
    getDeviceStatus: async (maxAgeMs = 0, forceFresh = false) => {
      wire.push({ t: rel(), kind: 'GET', maxAgeMs, forceFresh });
      await sleep(lat);
      o.client.lastStatusTs = Date.now();
      if (opts.getFails) throw new Error('요청 시간 초과 (5000ms)');
      return { Devices: [o.deviceState || { Operation: { power: 'Off' } }] };
    },
  };
  o.setupCharacteristics();
  return {
    o, C, svc, wire,
    start() { t0 = Date.now(); },
    set(char, v) { return Promise.resolve().then(() => svc.getCharacteristic(char)._set(v)).catch(() => {}); },
    get(char) { return Promise.resolve().then(() => svc.getCharacteristic(char)._get()).catch(e => e); },
    puts() { return wire.filter(w => w.kind === 'PUT'); },
    gets() { return wire.filter(w => w.kind === 'GET'); },
    fmt() { return wire.map(w => `${w.t}ms ${w.kind}${w.ep !== undefined && w.kind === 'PUT' ? ' ' + (w.ep || '(root)') : ''}${w.data ? ' ' + w.data : ''}${w.forceFresh ? ' FRESH' : ''}`).join(' | '); },
    stop() { try { o.shutdown(); } catch (_) {} },
  };
}

// ===========================================================================
(async () => {

// ---------------------------------------------------------------------------
// E1 — 폴 공유가 실제로 기기 TLS 왕복을 줄이는가 (코드 주석의 "실질 1회 / 부하 절반" 주장)
//      시간 축 미축소: pollingInterval 10s, POLL_SHARE_MAX_AGE_MS 7000ms 그대로 25초 관측.
// ---------------------------------------------------------------------------
async function e1() {
  const e = S('E1', '폴 공유 — 거실/침실 2 액세서리, 실제 10s 폴 x 25s (시간축 미축소)');

  async function run(label, offsetMs) {
    const client = new LegacyACClient('10.0.0.1', 'tok', quietLog, { timeout: 500 });
    let deviceGets = 0;
    client._request = async () => {
      deviceGets++;
      await sleep(30);
      return { Devices: [{ Operation: { power: 'On' } }, { Operation: { power: 'On' } }] };
    };
    const a = makePollRig('거실', 0, client, 10);
    const b = makePollRig('침실', 1, client, 10);
    let logicalPolls = 0;
    const wrap = (rig) => {
      const orig = LegacyAC.prototype.getCachedState.bind(rig);
      rig.getCachedState = (...args) => { logicalPolls++; return orig(...args); };
    };
    wrap(a); wrap(b);
    a.startPolling();
    setTimeout(() => b.startPolling(), offsetMs);
    await sleep(25000);
    a.shutdown(); b.shutdown();
    return { label, deviceGets, logicalPolls };
  }

  const [inPhase, antiPhase] = await Promise.all([run('동위상(0ms)', 0), run('역위상(8000ms)', 8000)]);
  for (const r of [inPhase, antiPhase]) {
    e.measure(`${r.label}: 논리 폴 ${r.logicalPolls}회 → 기기 GET ${r.deviceGets}회 (절감 ${(100 * (1 - r.deviceGets / r.logicalPolls)).toFixed(0)}%)`, '');
  }
  e.check('동위상: 기기 GET < 논리 폴 (공유 성립)', inPhase.deviceGets < inPhase.logicalPolls,
    `${inPhase.deviceGets}/${inPhase.logicalPolls}`);
  e.check('동위상: 논리 폴의 60% 이상 절감 ("실질 1회" 주장)', inPhase.deviceGets <= inPhase.logicalPolls * 0.6,
    `${inPhase.deviceGets}/${inPhase.logicalPolls}`);
  e.check('역위상(8s 어긋남)에서도 절감 성립', antiPhase.deviceGets < antiPhase.logicalPolls,
    `${antiPhase.deviceGets}/${antiPhase.logicalPolls}`);
  if (antiPhase.deviceGets >= antiPhase.logicalPolls) {
    e.anomaly(`폴이 공유창(7s)보다 크게 어긋나면 공유가 완전히 무너짐 — 기기 GET ${antiPhase.deviceGets}/${antiPhase.logicalPolls}`);
  }
}

// ---------------------------------------------------------------------------
// E2 — HomeKit 다중 특성 동시 read: 기기 왕복이 1회로 합쳐지는가
// ---------------------------------------------------------------------------
async function e2() {
  const e = S('E2', 'HomeKit 특성 7종 동시 read → 기기 GET 합류(coalescing)');

  // (a) 콜드부트: 캐시 전무 → 7 getter 동시 호출
  {
    const rig = makeFullRig({ noState: true });
    rig.o.deviceState = null;
    rig.start();
    const cs = [rig.C.Active, rig.C.CurrentHeaterCoolerState, rig.C.CurrentTemperature,
      rig.C.CoolingThresholdTemperature, rig.C.SwingMode, rig.C.LockPhysicalControls];
    await Promise.all(cs.map(c => rig.get(c)));
    e.measure('콜드부트 6 getter 동시 → 기기 GET', rig.gets().length);
    e.check('콜드부트: 기기 GET 정확히 1회', rig.gets().length === 1, rig.fmt());
    rig.stop();
  }

  // (b) stale 캐시(cacheDuration 초과, STALE_HARD_CAP 이내) → 즉답 + 백그라운드 refresh
  {
    const rig = makeFullRig({ cacheDuration: 1000, stateAge: 5000 });
    rig.start();
    const cs = [rig.C.Active, rig.C.CurrentHeaterCoolerState, rig.C.CurrentTemperature,
      rig.C.CoolingThresholdTemperature, rig.C.SwingMode, rig.C.LockPhysicalControls];
    const t0 = Date.now();
    const vals = await Promise.all(cs.map(c => rig.get(c)));
    const readMs = Date.now() - t0;
    await sleep(120);
    e.measure('stale 캐시 6 getter 동시 → 기기 GET', rig.gets().length);
    e.measure('read handler 응답 지연(ms)', readMs);
    e.check('즉답(네트워크 블로킹 없음, <10ms)', readMs < 10, `${readMs}ms`);
    e.check('백그라운드 refresh는 1회로 합류', rig.gets().length === 1, rig.fmt());
    e.check('모든 값이 캐시에서 정상 반환', vals.every(v => !(v instanceof Error)), JSON.stringify(vals));
    rig.stop();
  }
}

// ---------------------------------------------------------------------------
// E3 — 온도 슬라이더 드래그: 디바운스가 PUT을 1회로 접는가
// ---------------------------------------------------------------------------
async function e3() {
  const e = S('E3', '온도 슬라이더 드래그 20스텝 → 기기 PUT 횟수 (디바운스 400ms, 미축소)');
  const rig = makeFullRig({ desired: 26 });
  rig.start();
  for (let v = 26; v >= 18; v--) { rig.set(rig.C.CoolingThresholdTemperature, v); await sleep(15); }
  for (let v = 19; v <= 24; v++) { rig.set(rig.C.CoolingThresholdTemperature, v); await sleep(15); }
  await sleep(900);
  const puts = rig.puts().filter(p => p.ep === '/temperatures/0');
  e.measure('슬라이더 write 15회 → 기기 PUT', puts.length);
  e.check('PUT 정확히 1회', puts.length === 1, rig.fmt());
  e.check('마지막 값(24)만 전송', puts[0] && /"desired":24/.test(puts[0].data), puts[0] && puts[0].data);
  const refreshGets = rig.gets().length;
  e.measure('드래그 후 확인 GET', refreshGets);
  rig.stop();
}

// ---------------------------------------------------------------------------
// E4 — 사용자 동작 1회당 기기 왕복 원가 (단일 커넥션 기기라 이 수가 곧 부하)
//      축소: _onGuardMs 400(실환경 4000), stepMs 600(실환경 4000). 왕복 '횟수'는 불변.
// ---------------------------------------------------------------------------
async function e4() {
  const e = S('E4', '동작 1회당 기기 왕복 원가 (guard 400ms·step 600ms로 간격만 축소)');

  // (a) 켜져 있는 기기에 OFF 1탭
  {
    const rig = makeFullRig({ power: 'On' });
    rig.start();
    await rig.set(rig.C.Active, 0);
    await sleep(3200);
    e.measure('OFF 1탭 → PUT/GET', `${rig.puts().length}/${rig.gets().length}`);
    e.check('OFF 1탭: PUT 정확히 1회', rig.puts().length === 1, rig.fmt());
    e.check('OFF 1탭: 확인 GET 1회 이하', rig.gets().length <= 1, rig.fmt());
    rig.stop();
  }

  // (b) 이미 꺼진 기기에 OFF 1탭 (흡수 + 2초 뒤 강제 실측)
  {
    const rig = makeFullRig({ power: 'Off' });
    rig.start();
    await rig.set(rig.C.Active, 0);
    await sleep(3000);
    const fresh = rig.gets().filter(g => g.forceFresh);
    e.measure('이미 꺼짐 OFF 1탭 → PUT/GET(forceFresh)', `${rig.puts().length}/${rig.gets().length}(${fresh.length})`);
    e.check('흡수: PUT 0회 (\'띠\' 없음)', rig.puts().length === 0, rig.fmt());
    e.check('흡수 검증: forceFresh GET 정확히 1회', fresh.length === 1, rig.fmt());
    rig.stop();
  }

  // (c) ON 1탭 + 전체 재전송 체인(모드→자동건조→스윙끄기)
  //     관측창을 체인 종료 + _scheduleRefresh(2000ms) 이후까지 충분히 연다.
  {
    const rig = makeFullRig({ power: 'Off', resendSwingOff: true });
    rig.start();
    await rig.set(rig.C.Active, 1);
    await sleep(6500);
    const lastPut = rig.puts()[rig.puts().length - 1];
    const midChainGets = rig.gets().filter(g => g.t < lastPut.t);
    e.measure('ON 1탭(체인 3단계) → PUT/GET', `${rig.puts().length}/${rig.gets().length}`);
    e.measure('와이어 타임라인', rig.fmt());
    e.check('ON 1탭: PUT 4회(전원+모드+자동건조+스윙)', rig.puts().length === 4, rig.fmt());
    e.check('단계마다 확인 GET을 쏘지는 않음(GET < PUT)', rig.gets().length < rig.puts().length, rig.fmt());
    e.measure('체인 종료 전에 끼어든 확인 GET', midChainGets.length);
    if (rig.gets().length > 1) {
      e.anomaly(`ON 1탭에 확인 GET ${rig.gets().length}회 — Active setter의 _scheduleRefresh(2000ms)와 체인 최종 단계의 _scheduleRefresh가 서로 디바운스되지 않는다`);
    }
    if (midChainGets.length > 0) {
      e.anomaly(`확인 GET ${midChainGets.length}회가 재전송 체인이 끝나기 전(마지막 PUT ${lastPut.t}ms)에 발사됨 — 단일 커넥션 큐에서 체인 PUT을 1 RTT 지연시키고, 곧 덮일 상태를 읽는다`);
    }
    rig.stop();
  }

  // (d) 끄기 장면(Active=0 + 형제 스냅샷 4종) 총 원가
  {
    const rig = makeFullRig({ power: 'On', desired: 26 });
    rig.start();
    rig.set(rig.C.Active, 0);
    await sleep(30);
    rig.set(rig.C.TargetHeaterCoolerState, 2);
    rig.set(rig.C.CoolingThresholdTemperature, 22);
    rig.set(rig.C.SwingMode, 1);
    rig.set(rig.C.LockPhysicalControls, 1);
    await sleep(3500);
    e.measure('끄기 장면(5 write) → PUT/GET', `${rig.puts().length}/${rig.gets().length}`);
    e.check('끄기 장면: PUT 정확히 1회(off만)', rig.puts().length === 1, rig.fmt());
    e.check('전송된 PUT이 off', rig.puts()[0] && /"power":"Off"/.test(rig.puts()[0].data), rig.fmt());
    rig.stop();
  }
}

// ---------------------------------------------------------------------------
// E5 — 기기 무응답 중 명령 폭주: 큐/카운터가 무한 성장하지 않는가
// ---------------------------------------------------------------------------
async function e5() {
  const e = S('E5', '기기 무응답 + 명령 40회 폭주 → 큐 한도·카운터 회수');
  const rig = makeFullRig({ power: 'On', putFails: true, clientLatency: 30 });
  rig.start();
  let rejected = 0, accepted = 0;
  let peak = 0;
  const probe = setInterval(() => { peak = Math.max(peak, rig.o._pendingCmdCount); }, 5);
  const jobs = [];
  for (let i = 0; i < 40; i++) {
    jobs.push(rig.o.sendCommand('/mode', { modes: ['DryClean'] }).then(() => accepted++, (err) => {
      if (/명령 큐 초과/.test(err.message)) rejected++; else accepted++;
    }));
  }
  await Promise.all(jobs);
  clearInterval(probe);
  await sleep(400);
  e.measure('_pendingCmdCount 피크', peak);
  e.measure('수락/거부', `${accepted}/${rejected}`);
  e.measure('종료 후 _pendingCmdCount', rig.o._pendingCmdCount);
  e.check('MAX_PENDING_COMMANDS(5) 초과 안 함', peak <= 5, `peak=${peak}`);
  e.check('초과분은 즉시 거부(무한 큐 없음)', rejected > 0, `rejected=${rejected}`);
  e.check('종료 후 카운터 0으로 회수(누수 없음)', rig.o._pendingCmdCount === 0, String(rig.o._pendingCmdCount));
  rig.stop();
}

// ---------------------------------------------------------------------------
// E6 — LegacyACClient._waiting 카운터 무결성
//      누수 시 yieldToWaiter가 영구 true → GET 재시도가 조용히 영구 비활성.
// ---------------------------------------------------------------------------
async function e6() {
  const e = S('E6', 'LegacyACClient._waiting 누수 — 성공/실패/타임아웃 혼합 60회');
  const client = new LegacyACClient('10.0.0.9', 'tok', quietLog, { timeout: 200 });
  let n = 0;
  const seen = [];
  client._rawRequest = async (p, m) => {
    const i = n++;
    seen.push(client._waiting);
    await sleep(5);
    if (i % 3 === 0) throw new Error('요청 시간 초과 (200ms)');
    if (i % 7 === 0) throw new Error('TLS 소켓 오류: ECONNRESET');
    return { Devices: [{ Operation: { power: 'On' } }] };
  };
  const jobs = [];
  for (let i = 0; i < 30; i++) {
    jobs.push(client.getDeviceStatus(0, true).catch(() => {}));
    jobs.push(client.sendCommand(0, '/mode', { modes: ['Cool'] }).catch(() => {}));
  }
  await Promise.all(jobs);
  await sleep(300);
  e.measure('_waiting 최종값', client._waiting);
  e.measure('_waiting 관측 최대', Math.max(...seen));
  e.check('_waiting이 0으로 회수', client._waiting === 0, String(client._waiting));
  e.check('_waiting 음수 미발생', Math.min(...seen) >= 0, String(Math.min(...seen)));
  if (client._waiting !== 0) e.anomaly(`_waiting 누수 ${client._waiting} — GET 재시도가 영구 비활성화됨`);

  // 캐시 무효화 세대(_putSeq)가 PUT마다 증가하며 stale 캐시를 남기지 않는지
  e.check('PUT 후 _statusCache 무효', client._statusCache === null || client._putSeq > 0,
    `putSeq=${client._putSeq} cache=${client._statusCache ? 'set' : 'null'}`);
  e.check('_statusInFlight 누수 없음', client._statusInFlight === null,
    client._statusInFlight ? 'in-flight 프라미스가 남음' : '');
}

// ---------------------------------------------------------------------------
// E7 — shutdown 후 타이머 누수 (홈브릿지 재시작/기기 제거 시 자원 회수)
// ---------------------------------------------------------------------------
async function e7() {
  const e = S('E7', 'shutdown 후 잔존 타이머 (자원 회수)');
  const live = new Map();
  const realSet = global.setTimeout, realClear = global.clearTimeout;
  let seq = 0;
  global.setTimeout = function (fn, ms, ...a) {
    const id = ++seq;
    const h = realSet(function () { live.delete(h); return fn.apply(this, arguments); }, ms, ...a);
    live.set(h, { id, ms, stack: new Error().stack.split('\n')[2] || '' });
    return h;
  };
  global.clearTimeout = function (h) { live.delete(h); return realClear(h); };

  const rig = makeFullRig({ power: 'Off', resendSwingOff: true, stepMs: 600, guardMs: 400 });
  rig.start();
  rig.o.pollingInterval = 1; rig.o.startPolling();      // 폴 타이머
  await rig.set(rig.C.Active, 1);                        // ON + guard + 재전송 체인 + refresh
  rig.set(rig.C.CoolingThresholdTemperature, 21);        // 디바운스 타이머
  await sleep(150);
  const before = live.size;
  rig.o.shutdown();
  await sleep(50);
  // 300ms(sendCommand 내부 대기)/500ms(_refreshState) 같은 in-flight sleep은 곧 소멸 → 유예 후 재측정
  const remainingLong = [...live.values()].filter(v => v.ms >= 400);
  await sleep(1400);
  const after = [...live.values()];

  global.setTimeout = realSet; global.clearTimeout = realClear;

  e.measure('shutdown 직전 활성 타이머', before);
  e.measure('shutdown 직후 400ms+ 잔존', remainingLong.length);
  e.measure('shutdown +1.4s 잔존 총계', after.length);
  e.check('shutdown 직후 장기 타이머 전부 해제', remainingLong.length === 0,
    remainingLong.map(v => `${v.ms}ms @${v.stack.trim()}`).join(' | '));
  e.check('1.4초 뒤 잔존 타이머 0', after.length === 0,
    after.map(v => `${v.ms}ms @${v.stack.trim()}`).join(' | '));
  if (after.length > 0) e.anomaly(`shutdown 후 타이머 ${after.length}개 잔존: ${after.map(v => v.ms + 'ms').join(',')}`);
  e.check('shutdown 후 폴 타이머 null', rig.o.pollTimer === null);
  e.check('shutdown 후 디바운스 맵 비움', rig.o._pendingDebounces.size === 0);
}

// ---------------------------------------------------------------------------
// E8 — SmartThingsClient: 클라우드 호출 절감 (캐시 5s TTL + statusPromises 합류)
//      + v2.1.x 신규 코드(_fmtCommands/_labelOf)가 통과하는 sendCommand 경로 계측
// ---------------------------------------------------------------------------
function makeStClient(opts = {}) {
  const c = Object.create(SmartThingsClient.prototype);
  c.log = quietLog;
  c.cache = new LRUCache({ max: 100, ttl: opts.ttl != null ? opts.ttl : 5000 });
  c.statusPromises = new Map();
  c._statusFailStreaks = new Map();
  c._deviceLabels = new Map();
  c._lastNonOffCmdTs = new Map();
  const counts = { get: 0, post: 0 };
  c.client = {
    get: async () => { counts.get++; await sleep(15); return { data: { components: { main: { switch: { switch: { value: 'on' } }, temperatureMeasurement: { temperature: { value: 25 } } } } } }; },
    post: async () => { counts.post++; await sleep(10); if (opts.postFails) { const e2 = new Error('Request failed with status code 422'); e2.response = { status: 422, data: { error: { code: 'ConstraintViolationError' } } }; throw e2; } return { data: {} }; },
  };
  return { c, counts };
}

async function e8() {
  const e = S('E8', 'SmartThingsClient — 클라우드 GET 절감 및 명령 후 재조회 원가');
  const DEV = 'dev-uuid-1';

  // (a) HomeKit 전체 read: 6개 getter 동시 → HTTP GET 1회
  {
    const { c, counts } = makeStClient();
    await Promise.all([
      c.getPower(DEV), c.getCurrentTemperature(DEV), c.getCoolingSetpoint(DEV),
      c.getWindFree(DEV), c.getAutoClean(DEV), c.getPower(DEV),
    ]);
    e.measure('동시 6 getter → HTTP GET', counts.get);
    e.check('동시 6 getter가 HTTP GET 1회로 합류', counts.get === 1, String(counts.get));
    e.check('statusPromises 누수 없음', c.statusPromises.size === 0, String(c.statusPromises.size));
  }

  // (b) 순차 read (TTL 5s 내) → 캐시 적중, 추가 GET 0
  {
    const { c, counts } = makeStClient();
    await c.getPower(DEV);
    for (let i = 0; i < 20; i++) await c.getCurrentTemperature(DEV);
    e.measure('첫 조회 후 순차 20회 → 총 HTTP GET', counts.get);
    e.check('TTL 내 순차 20회 추가 호출 0', counts.get === 1, String(counts.get));
  }

  // (c) 명령 1회의 재조회 원가: sendCommand는 즉시 + 1500ms 두 번 무효화
  {
    const { c, counts } = makeStClient();
    c.registerDeviceLabel(DEV, '승준 에어컨');
    await c.getPower(DEV);                    // GET#1
    const g0 = counts.get;
    await c.setPower(DEV, false);             // 즉시 무효화
    await c.getPower(DEV);                    // GET#2 (무효화 때문)
    const gAfterCmd = counts.get;
    await c.getPower(DEV);                    // 캐시 적중 기대
    const gCached = counts.get;
    await sleep(1700);                        // 1500ms 지연 무효화 발동
    await c.getPower(DEV);                    // GET#3
    e.measure('명령 1회 전후 HTTP GET 추이', `${g0} → ${gAfterCmd} → ${gCached} → ${counts.get}`);
    e.check('명령 직후 무효화로 1회 재조회', gAfterCmd === g0 + 1, `${g0}->${gAfterCmd}`);
    e.check('그 직후 조회는 캐시 적중', gCached === gAfterCmd, `${gAfterCmd}->${gCached}`);
    e.check('1500ms 지연 무효화가 추가 1회 유발', counts.get === gCached + 1, `${gCached}->${counts.get}`);
    e.note('명령 1건당 클라우드 GET 원가 = 최대 2회(즉시 무효화 + 1500ms 재무효화). 의도된 설계.');
  }

  // (d) v2.1.x 신규 포매터가 실패 경로에서도 예외를 만들지 않는가 (커버리지 0 구역)
  {
    const { c, counts } = makeStClient({ postFails: true });
    c.registerDeviceLabel(DEV, '승준 에어컨');
    const logs = [];
    c.log = { info: m => logs.push(['info', m]), error: m => logs.push(['error', m]), warn: () => {}, debug: m => logs.push(['debug', m]) };
    let threw = null;
    try { await c.setPower(DEV, false); } catch (err) { threw = err; }
    e.check('POST 실패가 상위로 전파됨', threw !== null, String(threw && threw.message));
    e.check('실패 로그가 기기 라벨을 사용', logs.some(l => l[0] === 'error' && /승준 에어컨/.test(l[1])), JSON.stringify(logs));
    e.check('실패 로그에 한국어 명령 표기', logs.some(l => l[0] === 'error' && /전원 → 꺼짐/.test(l[1])), JSON.stringify(logs));
    e.check('에러 본문은 debug로만 (기본 로그레벨에서 원인코드 소실)',
      logs.some(l => l[0] === 'debug' && /ConstraintViolationError/.test(l[1])) &&
      !logs.some(l => l[0] === 'error' && /ConstraintViolationError/.test(l[1])), JSON.stringify(logs));
    e.measure('실패 시 POST 시도', counts.post);
  }

  // (e) 상태 Map 3종이 기기 수 이상으로 커지지 않는가 (누수 검증)
  {
    const { c } = makeStClient();
    for (let i = 0; i < 500; i++) {
      await c.setMode('dev-A', 'cool');
      await c.setPower('dev-B', false);
      await c.setTemperature('dev-C', 24);
    }
    e.measure('_lastNonOffCmdTs 크기', c._lastNonOffCmdTs.size);
    e.measure('_deviceLabels 크기', c._deviceLabels.size);
    e.measure('_statusFailStreaks 크기', c._statusFailStreaks.size);
    e.check('_lastNonOffCmdTs가 기기 수(3)로 제한', c._lastNonOffCmdTs.size <= 3, String(c._lastNonOffCmdTs.size));
    e.check('명령 1500건 후에도 Map 무한 성장 없음',
      c._lastNonOffCmdTs.size + c._deviceLabels.size + c._statusFailStreaks.size <= 10,
      `${c._lastNonOffCmdTs.size}/${c._deviceLabels.size}/${c._statusFailStreaks.size}`);
    await sleep(1700); // 지연 무효화 타이머 배수
  }

  // (f) 상태 조회 실패 스트릭 Map이 복구 시 정리되는가
  {
    const { c } = makeStClient();
    c.client.get = async () => { throw new Error('ETIMEDOUT'); };
    for (let i = 0; i < 5; i++) { await c.getPower(DEV).catch(() => {}); }
    const streak = c._statusFailStreaks.get(DEV);
    c.client.get = async () => ({ data: { components: { main: { switch: { switch: { value: 'on' } } } } } });
    await c.getPower(DEV);
    e.measure('연속 실패 5회 후 스트릭', streak);
    e.check('스트릭 누적', streak === 5, String(streak));
    e.check('복구 시 스트릭 엔트리 삭제(누수 없음)', !c._statusFailStreaks.has(DEV), String(c._statusFailStreaks.size));
  }
}

// ---------------------------------------------------------------------------
// E9 — 인증서 파일 읽기 메모이제이션 (액세서리 N개 = 디스크 읽기 1회)
// ---------------------------------------------------------------------------
async function e9() {
  const e = S('E9', 'getCertificate 메모이제이션');
  const fs = require('fs');
  const p = path.join(REPO, 'package.json'); // 존재하는 아무 파일
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (f, ...a) { if (f === p) reads++; return real.call(fs, f, ...a); };
  for (let i = 0; i < 10; i++) getCertificate(p);
  fs.readFileSync = real;
  e.measure('getCertificate 10회 → 디스크 읽기', reads);
  e.check('디스크 읽기 1회로 메모이즈', reads === 1, String(reads));
}

// ---------------------------------------------------------------------------
// E10 — 직렬 큐 프라미스 체인이 메모리를 누적시키지 않는가
// ---------------------------------------------------------------------------
async function e10() {
  const e = S('E10', 'LegacyACClient 직렬 큐 — 5000 요청 후 힙/구조 잔존');
  const client = new LegacyACClient('10.0.0.7', 'tok', quietLog, { timeout: 200 });
  client._rawRequest = async () => ({ Devices: [{ Operation: { power: 'On' } }] });
  if (global.gc) global.gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 5000; i++) await client.getDeviceStatus(0, true);
  if (global.gc) global.gc();
  const h1 = process.memoryUsage().heapUsed;
  const growthKB = Math.round((h1 - h0) / 1024);
  e.measure('5000 요청 후 heapUsed 증가(KB)', growthKB);
  e.measure('_waiting / _statusInFlight', `${client._waiting} / ${client._statusInFlight === null ? 'null' : 'LEAK'}`);
  e.check('_waiting 0', client._waiting === 0, String(client._waiting));
  e.check('_statusInFlight 해제', client._statusInFlight === null);
  e.check('힙 증가 5MB 미만 (체인 누적 없음)', growthKB < 5120, `${growthKB}KB`);
  e.note('gc 미노출 실행에서는 힙 수치가 보수적(과대)으로 나온다 — --expose-gc로 재확인 가능.');
}

// ---------------------------------------------------------------------------
// E11 — 실환경 상수(거실/침실: legacyOnGuardMs=4000, powerOnResendStepMs=4000)로
//       ON 1탭의 왕복 타임라인을 재현. 시간축 미축소(16s 관측).
// ---------------------------------------------------------------------------
async function e11() {
  const e = S('E11', 'ON 1탭 @ 실환경 상수(guard 4000 / step 4000) — 확인 GET 위치');
  const rig = makeFullRig({ power: 'Off', resendSwingOff: true, guardMs: 4000, stepMs: 4000, clientLatency: 40 });
  rig.start();
  await rig.set(rig.C.Active, 1);
  await sleep(16000);
  const puts = rig.puts(), gets = rig.gets();
  const lastPut = puts[puts.length - 1];
  const mid = gets.filter(g => g.t < lastPut.t);
  e.measure('타임라인', rig.fmt());
  e.measure('PUT/GET', `${puts.length}/${gets.length}`);
  e.check('PUT 4회 (전원+모드+자동건조+스윙)', puts.length === 4, rig.fmt());
  e.check('확인 GET은 2회 이하', gets.length <= 2, String(gets.length));
  e.measure('체인 종료 전 끼어든 확인 GET', `${mid.length}회 @ ${mid.map(g => g.t + 'ms').join(',')}`);
  if (mid.length > 0) {
    e.anomaly(`실환경 상수에서도 확인 GET ${mid.length}회가 체인 중간(마지막 PUT ${lastPut.t}ms 이전)에 발사됨 — 단일 커넥션 큐 점유 + 곧 덮일 스냅샷`);
  }
  rig.stop();
}

// ===========================================================================
  const t0 = Date.now();
  await e2(); await e3(); await e4(); await e5(); await e6();
  await e7(); await e8(); await e9(); await e10();
  await Promise.all([e1(), e11()]); // 느린 둘(25s/16s)은 병렬
  console.log(`\n${'='.repeat(70)}`);
  console.log(`총 ${total}개 체크 / 실패 ${fail}개 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (anomalies.length) {
    console.log('\n이상 징후:');
    for (const a of anomalies) console.log(`  - ${a}`);
  } else {
    console.log('이상 징후: 없음');
  }
  process.exit(fail ? 1 : 0);
})();
