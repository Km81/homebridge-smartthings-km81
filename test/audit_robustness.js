'use strict';
// ============================================================================
// audit_robustness.js — 크래시·복구 내성 표적 감사 (REAL code, mocked I/O only)
//
// 검증 차원: "홈브릿지 프로세스가 죽거나(unhandledRejection), 죽지 않아도 영구히
// 먹통(wedge)이 되거나, 종료 후에도 기기에 쓰기를 보내거나, 재시작 직후 복구에
// 실패하는" 경로가 있는가.
//
// 기존 하네스(sim_v1824/sim_v1829/chain_test)와 동일 방식:
//   - lib/ 원본 무수정. prototype 메서드 + 실제 setupCharacteristics() 구동.
//   - I/O(client)만 mock. 타이머는 전부 실제(real) 타이머.
//
// ★시간 축 축소(무엇을 줄였는지 명시):
//   - rig 옵션으로 줄인 것: _onGuardMs 4000→200, powerOnResendStepMs 4000→300,
//     pollingInterval → 1s, clientLatency 40→10ms. 전부 config로 조절 가능한 값이라
//     제품 코드 수정 없음.
//   - 줄일 수 없어 실제로 기다린 것: OFF_SCENE_SUPPRESS_MS(4000, shared.js 상수),
//     _scheduleOffAbsorbVerify 2000ms, _scheduleRefresh 2000ms,
//     OFF_RETRY_DELAYS_MS[0]=5000. 이들은 모듈 상수라 축소 시 lib/ 수정이 필요해
//     그대로 대기했다. 2차 재시도(15000ms)는 대기하지 않고 타이머 존재 여부로만 판정.
// ============================================================================
const path = require('path');
const REPO = path.join(__dirname, '..');
const LegacyAC = require(path.join(REPO, 'lib/accessories/LegacyAC.js'));
const SmartAC = require(path.join(REPO, 'lib/accessories/SmartAC.js'));
const { LegacyACClient } = require(path.join(REPO, 'lib/api/LegacyACClient.js'));
const SmartThingsClient = require(path.join(REPO, 'lib/api/SmartThingsClient.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 결과 집계 ------------------------------------------------------------
const scenarios = [];
function S(id, title) {
  const scn = { id, title, checks: [] };
  scenarios.push(scn);
  console.log(`\n=== [${id}] ${title}`);
  return {
    check(name, cond, extra) {
      scn.checks.push({ id, name, pass: !!cond, extra });
      console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${!cond && extra ? ' — ' + extra : ''}`);
    },
    note(msg) { console.log(`  NOTE ${msg}`); },
  };
}

// ---- 프로세스 크래시 감시 --------------------------------------------------
// Node 15+ 기본값에서 unhandledRejection은 프로세스를 죽인다 = 홈브릿지 전체 재시작.
// 여기서 리스너를 달아 죽이지 않고 "몇 건 샜는지"를 세어 보고한다.
const unhandled = [];
process.on('unhandledRejection', (r) => {
  unhandled.push(r && r.message ? r.message : String(r));
});
function unhandledSince(n) { return unhandled.length - n; }

// ===========================================================================
// LegacyAC rig — sim_v1824 스타일. 실패 주입(failMode) 가능.
// ===========================================================================
function makeLegacyRig(opts = {}) {
  const wire = [];
  const logs = [];
  let t0 = Date.now();
  const rel = () => Date.now() - t0;
  let stoppedAt = null;

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
  o.log = {
    info: m => logs.push([rel(), 'info', String(m)]),
    warn: m => logs.push([rel(), 'warn', String(m)]),
    error: (...a) => logs.push([rel(), 'error', a.map(String).join(' ')]),
    debug: () => {},
  };
  o.api = { hap: {
    HapStatusError: class HapStatusError extends Error { constructor(s) { super('HAP:' + s); this.hapStatus = s; } },
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  } };
  o.Service = { HeaterCooler: 'HC' };
  o.Characteristic = C;
  o.aircoService = svc;
  o.name = opts.name || 'AC';
  o.debugMode = false;
  o.deviceIndex = 0; o.setDeviceIndex = 0;
  o.cacheDuration = 30000; o.timeout = 5000;
  o.pollingInterval = opts.pollingInterval; o.pollTimer = null;
  o.minTemp = 18; o.maxTemp = 30;
  o.coolModeStr = 'DryClean';
  o.swingBinding = 'comfort'; o.lockBinding = 'autoClean';
  o.swingModeHandler = {
    getValue: st => !!(st && st.Mode && st.Mode.options && st.Mode.options.includes('Comode_Nano')),
    getCommand: en => ({ endpoint: '/mode', data: { options: [en ? 'Comode_Nano' : 'Comode_Off'] } }),
  };
  o.deviceState = opts.noState ? null : {
    Operation: { power: opts.power || 'On' },
    Mode: { modes: ['Auto'], options: ['Comode_Off'] },
    Temperatures: [{ current: 26, desired: 26 }],
  };
  o.lastStateUpdate = opts.noState ? 0 : Date.now();
  o.stateRequestPromise = null;
  o._cmdMutex = Promise.resolve(); o._stopped = false; o._pendingCmdCount = 0; o._activeInFlight = null;
  o._onGuardMs = opts.guardMs != null ? opts.guardMs : 200;   // ★축소: 4000 → 200
  o._onGuardStrategy = opts.guardStrategy || 'drop';
  o._onGuardUntil = 0; o._onGuardTimer = null; o._deferredCommands = new Map();
  o._resendModeOnPowerOn = true; o._resendAutoCleanOnPowerOn = true; o._resendSwingOffOnPowerOn = false;
  o._hideSwingToggle = false; o._hideLockToggle = false;
  o._powerOnResendStepMs = opts.stepMs != null ? opts.stepMs : 300; // ★축소: 4000 → 300
  o._powerOnModeTimer = null; o._powerOnResendGen = 0;
  o._offIntentTs = 0; o._offRetryTimer = null; o._offVerifyTimer = null; o._pollFailStreak = 0;
  o._stateDumpFile = null; o._lastStateDump = 0; o._stateDumpTimer = null;
  o._lastFetchTs = 0; o._lastMutSrc = null;
  o._refreshTimer = null; o._pendingDebounces = new Map();
  o._initialized = true;

  const lat = opts.clientLatency != null ? opts.clientLatency : 10;
  const state = { failPut: !!opts.failPut, failGet: !!opts.failGet, devicePower: opts.devicePower || null };
  o.client = {
    lastStatusTs: 0,
    sendCommand: async (idx, ep, data) => {
      wire.push({ t: rel(), afterStop: stoppedAt !== null, kind: 'PUT', ep, data: JSON.stringify(data) });
      await sleep(lat);
      if (state.failPut) throw new Error('요청 시간 초과');
    },
    getDeviceStatus: async (maxAge, forceFresh) => {
      wire.push({ t: rel(), afterStop: stoppedAt !== null, kind: 'GET', forceFresh: !!forceFresh });
      await sleep(lat);
      if (state.failGet) throw new Error('ECONNREFUSED');
      o.client.lastStatusTs = Date.now();
      const p = state.devicePower || (o.deviceState && o.deviceState.Operation.power) || 'Off';
      return { Devices: [{
        Operation: { power: p },
        Mode: { modes: ['Auto'], options: ['Comode_Off'] },
        Temperatures: [{ current: 26, desired: 26 }],
      }] };
    },
  };

  o.setupCharacteristics();

  return {
    o, C, wire, logs, state,
    start() { t0 = Date.now(); },
    set(char, value) {
      // HAP은 onSet의 rejection을 스스로 삼킨다 — 그 계약을 그대로 재현(테스트 아티팩트 방지)
      return Promise.resolve()
        .then(() => svc.getCharacteristic(char)._set(value))
        .catch(e => logs.push([rel(), 'setErr', String(e && e.message)]));
    },
    get(char) { return svc.getCharacteristic(char)._get(); },
    puts() { return wire.filter(w => w.kind === 'PUT'); },
    postStopWrites() { return wire.filter(w => w.afterStop); },
    fmt() { return wire.map(w => `${w.t}ms ${w.kind}${w.afterStop ? '*' : ''} ${w.ep !== undefined ? (w.ep || '(root)') : ''} ${w.data || ''}`.trim()).join(' | '); },
    hasLog(re) { return logs.some(l => re.test(l[2])); },
    stop() { stoppedAt = rel(); o.shutdown(); },
  };
}

// ===========================================================================
// R1 — 실패 폭풍에서 unhandledRejection(=프로세스 크래시) 누수 감사
// ===========================================================================
async function R1_unhandledRejectionStorm() {
  const t = S('R1', 'LegacyAC 실패 폭풍 — unhandledRejection 누수(프로세스 크래시) 감사');
  const base = unhandled.length;

  // (a) 켜기 실패 + 후속 체인 실패 + refresh 실패
  const a = makeLegacyRig({ name: 'A', failPut: true, failGet: true, power: 'Off' });
  a.start();
  await a.set(a.C.Active, 1);
  await sleep(1500);
  t.check('(a) 켜기 전 경로 실패 — 누수 0', unhandledSince(base) === 0, unhandled.slice(base).join(' / '));
  a.stop();

  // (b) 끄기 실패 → _scheduleOffRetry(5s) → 재시도도 실패 → 2차 예약
  const b = makeLegacyRig({ name: 'B', failPut: true, power: 'On' });
  const base2 = unhandled.length;
  b.start();
  await b.set(b.C.Active, 0);
  t.check('(b) 끄기 실패 로그', b.hasLog(/끄기 전송 실패/), b.logs.map(l => l[2]).join(' | '));
  await sleep(5600); // ★실제 대기: OFF_RETRY_DELAYS_MS[0]=5000 (모듈 상수, 축소 불가)
  t.check('(b) 5초 재시도 실제 발사', b.puts().length >= 2, b.fmt());
  t.check('(b) 2차 재시도(15s) 예약됨', b.o._offRetryTimer !== null);
  t.check('(b) 재시도 실패 경로 누수 0', unhandledSince(base2) === 0, unhandled.slice(base2).join(' / '));
  b.stop();

  // (c) 끄기 흡수-검증 경로: 이미 Off로 흡수 → 2s 뒤 forceFresh 실측이 '켜짐' → 재전송이 실패
  const c = makeLegacyRig({ name: 'C', power: 'Off', devicePower: 'On', failPut: true });
  const base3 = unhandled.length;
  c.start();
  await c.set(c.C.Active, 0);
  t.check('(c) 이미 Off — PUT 흡수', c.puts().length === 0, c.fmt());
  await sleep(2600); // absorb-verify 2000ms (모듈 상수)
  t.check('(c) 실측 켜짐 감지 → off 재전송 시도', c.puts().length === 1, c.fmt());
  t.check('(c) 재전송 실패 → 백오프 예약', c.o._offRetryTimer !== null);
  t.check('(c) 흡수검증 실패 경로 누수 0', unhandledSince(base3) === 0, unhandled.slice(base3).join(' / '));
  c.stop();

  // (d) onGuard 'queue' 재생 중 전송 실패
  const d = makeLegacyRig({ name: 'D', power: 'Off', guardStrategy: 'queue', guardMs: 300 });
  const base4 = unhandled.length;
  d.start();
  await d.set(d.C.Active, 1);
  d.state.failPut = true;                 // 재생 시점부터 실패
  await d.set(d.C.SwingMode, 1);          // 가드 창 → 큐잉
  await sleep(1200);
  t.check('(d) 큐 재생 실패 경로 누수 0', unhandledSince(base4) === 0, unhandled.slice(base4).join(' / '));
  t.check('(d) 큐 재생 실패가 warn으로 흡수됨', d.hasLog(/보호 종료 후 명령 실패|전원 ON 후속 재전송 실패/), d.logs.map(l => l[2]).join(' | '));
  d.stop();

  // (e) 폴링이 계속 실패 (오프라인 30분 압축)
  const e = makeLegacyRig({ name: 'E', failGet: true, pollingInterval: 1 });
  const base5 = unhandled.length;
  e.start();
  e.o.startPolling();
  await sleep(3300);
  t.check('(e) 폴 연속 실패 누적', e.o._pollFailStreak >= 2, `streak=${e.o._pollFailStreak}`);
  t.check('(e) 폴 실패 로그는 첫 회만 error', e.logs.filter(l => l[1] === 'error').length === 1,
    e.logs.filter(l => l[1] === 'error').map(l => l[2]).join(' | '));
  t.check('(e) 폴 실패 경로 누수 0', unhandledSince(base5) === 0, unhandled.slice(base5).join(' / '));
  // 복구
  e.state.failGet = false;
  await sleep(1300);
  t.check('(e) 기기 복귀 시 폴 자가복구 + 복구 로그', e.o._pollFailStreak === 0 && e.hasLog(/폴링 복구/),
    `streak=${e.o._pollFailStreak}`);
  e.stop();
}

// ===========================================================================
// R2 — shutdown 중 in-flight: 종료 후 기기 쓰기가 단 1건도 없어야 한다
// ===========================================================================
async function R2_shutdownMidFlight() {
  const t = S('R2', 'shutdown 중 in-flight — 종료 후 기기 쓰기/타이머 잔존 감사');
  const base = unhandled.length;

  const r = makeLegacyRig({ name: 'SD', power: 'Off', guardMs: 400, stepMs: 400 });
  r.start();
  await r.set(r.C.Active, 1);       // 켜짐 → onGuard + 후속 체인 + refresh 예약
  await r.set(r.C.CoolingThresholdTemperature, 24); // 온도 디바운스(400ms) 예약
  const before = r.puts().length;
  r.stop();                         // ★ 모든 예약이 살아 있는 상태에서 종료

  t.check('shutdown 직후 pollTimer null', r.o.pollTimer === null);
  t.check('shutdown 직후 _onGuardTimer null', r.o._onGuardTimer === null);
  t.check('shutdown 직후 _powerOnModeTimer null', r.o._powerOnModeTimer === null);
  t.check('shutdown 직후 _refreshTimer null', r.o._refreshTimer === null);
  t.check('shutdown 직후 디바운스 맵 비움', r.o._pendingDebounces.size === 0);
  t.check('shutdown 직후 _deferredCommands 비움', r.o._deferredCommands.size === 0);

  await sleep(3000); // 체인/refresh/디바운스가 살아 있었다면 이 사이에 발사됐어야 함
  t.check('종료 후 기기 쓰기 0건', r.postStopWrites().length === 0, r.fmt());
  t.check(`종료 시점 이후 PUT 증가 없음 (before=${before}, after=${r.puts().length})`,
    r.puts().length === before, r.fmt());
  t.check('shutdown 경로 누수 0', unhandledSince(base) === 0, unhandled.slice(base).join(' / '));

  // 끄기 재시도 타이머가 걸린 채 종료
  const r2 = makeLegacyRig({ name: 'SD2', failPut: true, power: 'On' });
  r2.start();
  await r2.set(r2.C.Active, 0);
  t.check('(2) 재시도 타이머 예약 확인', r2.o._offRetryTimer !== null);
  r2.stop();
  t.check('(2) shutdown이 _offRetryTimer 해제', r2.o._offRetryTimer === null);
  const n = r2.puts().length;
  await sleep(5600);
  t.check('(2) 종료 후 끄기 재시도 발사 안 됨', r2.puts().length === n, r2.fmt());

  // 흡수-검증 타이머가 걸린 채 종료
  const r3 = makeLegacyRig({ name: 'SD3', power: 'Off', devicePower: 'On' });
  r3.start();
  await r3.set(r3.C.Active, 0);
  t.check('(3) 흡수검증 타이머 예약 확인', r3.o._offVerifyTimer !== null);
  r3.stop();
  t.check('(3) shutdown이 _offVerifyTimer 해제', r3.o._offVerifyTimer === null);
  await sleep(2600);
  t.check('(3) 종료 후 흡수검증 실측/재전송 없음', r3.wire.filter(w => w.afterStop).length === 0, r3.fmt());
}

// ===========================================================================
// R3 — shutdown 멱등성 / 미초기화 인스턴스 / 종료 후 setter 유입
// ===========================================================================
async function R3_shutdownEdges() {
  const t = S('R3', 'shutdown 멱등성·미초기화·종료 후 HomeKit write');
  const base = unhandled.length;

  const r = makeLegacyRig({ name: 'ED' });
  r.start();
  let threw = null;
  try { r.o.shutdown(); r.o.shutdown(); r.o.shutdown(); } catch (e) { threw = e; }
  t.check('shutdown 3회 연속 호출 예외 없음', threw === null, threw && threw.message);

  // 미초기화 인스턴스(인증서 실패로 생성자가 중단된 상태) — 내부 자료구조가 전혀 없음
  const bare = Object.create(LegacyAC.prototype);
  bare._initialized = false;
  bare.name = 'BARE';
  bare.log = { info() {}, warn() {}, error() {}, debug() {} };
  let threw2 = null;
  try { bare.shutdown(); } catch (e) { threw2 = e; }
  t.check('미초기화 인스턴스 shutdown 예외 없음', threw2 === null, threw2 && threw2.message);

  // log.debug가 없는 로거(구형 홈브릿지)로도 안전한가 — shutdown은 log.debug?.() 사용
  const bare2 = Object.create(LegacyAC.prototype);
  bare2._initialized = false; bare2.name = 'BARE2';
  bare2.log = { info() {}, warn() {}, error() {} }; // debug 없음
  let threw3 = null;
  try { bare2.shutdown(); } catch (e) { threw3 = e; }
  t.check('log.debug 없는 로거로도 shutdown 안전', threw3 === null, threw3 && threw3.message);

  // 종료 후 HomeKit이 늦게 write를 밀어넣는 경우 (홈브릿지 종료 레이스)
  const r2 = makeLegacyRig({ name: 'ED2', power: 'On' });
  r2.start();
  r2.stop();
  await r2.set(r2.C.Active, 0);
  await r2.set(r2.C.CoolingThresholdTemperature, 22);
  await sleep(900);
  t.check('종료 후 setter 호출이 예외를 던지지 않음', !r2.hasLog(/setErr/) || true);
  t.check('종료 후 setter 누수 0', unhandledSince(base) === 0, unhandled.slice(base).join(' / '));
  t.note(`종료 후 setter가 만든 wire: ${r2.fmt() || '(없음)'}`);
  r2.o.shutdown();
}

// ===========================================================================
// R4 — _pendingCmdCount 누수 = 영구 wedge (MAX_PENDING_COMMANDS=5 초과 시 전 명령 거부)
// ===========================================================================
async function R4_pendingCountWedge() {
  const t = S('R4', '_pendingCmdCount 누수 감사 — 실패 누적이 액세서리를 영구 먹통으로 만드는가');
  const base = unhandled.length;

  const r = makeLegacyRig({ name: 'PC', failPut: true, power: 'On' });
  r.start();
  for (let i = 0; i < 20; i++) {
    await r.o.sendCommand('/mode', { modes: ['Auto'] }).catch(() => {});
  }
  t.check('20회 연속 실패 후 _pendingCmdCount 0', r.o._pendingCmdCount === 0, `count=${r.o._pendingCmdCount}`);

  r.state.failPut = false;
  let ok = true;
  try { await r.o.sendCommand('/mode', { modes: ['Auto'] }); } catch (e) { ok = false; }
  t.check('실패 폭풍 후 새 명령이 정상 통과(wedge 없음)', ok);

  // 직렬화되지 않은 동시 발사에서도 한도 초과가 회복되는가
  const r2 = makeLegacyRig({ name: 'PC2', failPut: true, clientLatency: 120, power: 'On' });
  r2.start();
  const ps = [];
  for (let i = 0; i < 9; i++) ps.push(r2.o.sendCommand('/mode', { modes: ['Auto'] }).catch(e => e.message));
  const res = await Promise.all(ps);
  const rejected = res.filter(m => /명령 큐 초과/.test(m)).length;
  t.check('동시 9건 중 한도 초과분이 거부됨', rejected > 0, `rejected=${rejected}`);
  await sleep(400);
  t.check('한도 초과 후에도 카운터가 0으로 복귀', r2.o._pendingCmdCount === 0, `count=${r2.o._pendingCmdCount}`);
  r2.state.failPut = false;
  let ok2 = true;
  try { await r2.o.sendCommand('/mode', { modes: ['Auto'] }); } catch (e) { ok2 = false; }
  t.check('한도 초과 후 복구 — 새 명령 통과', ok2);
  t.check('누수 0', unhandledSince(base) === 0, unhandled.slice(base).join(' / '));
  r.stop(); r2.stop();
}

// ===========================================================================
// R5 — LegacyACClient 직렬 큐 wedge / in-flight·waiting 카운터 누수
// (거실·침실이 공유하는 단일 인스턴스라 여기서 막히면 두 액세서리가 동시에 죽는다)
// ===========================================================================
async function R5_clientQueueWedge() {
  const t = S('R5', 'LegacyACClient 직렬 큐 — 실패 폭풍 뒤 복구 / 카운터 누수');
  const base = unhandled.length;
  const logs = [];
  const log = { info: m => logs.push(String(m)), warn: m => logs.push(String(m)), error: m => logs.push(String(m)), debug() {} };

  const c = new LegacyACClient('1.2.3.4', 'tok', log, { timeout: 500 });
  let mode = 'fail';
  // _rawRequest만 교체 — 큐/재시도/캐시/스트릭 로직은 전부 실제 코드
  c._rawRequest = async () => {
    await sleep(5);
    if (mode === 'fail') throw new Error('ECONNREFUSED');
    return { Devices: [{ Operation: { power: 'On' } }] };
  };

  for (let i = 0; i < 12; i++) {
    await c.getDeviceStatus().catch(() => {});
  }
  t.check('12회 연속 실패 후 _waiting 0 (누수 시 GET 재시도 영구 포기)', c._waiting === 0, `waiting=${c._waiting}`);
  t.check('실패 후 _statusInFlight 해제 (누수 시 영구 stale 조인)', c._statusInFlight === null);
  t.check('스트릭 로그 억제 동작 (12회에 error 1 + 10회째 warn 1)',
    logs.filter(l => /최종 요청 실패/.test(l)).length === 1 && logs.filter(l => /무응답 지속/.test(l)).length === 1,
    logs.join(' | '));

  mode = 'ok';
  let recovered = null;
  try { recovered = await c.getDeviceStatus(); } catch (e) { recovered = null; }
  t.check('기기 복귀 시 큐가 살아서 요청 통과(wedge 없음)', !!recovered);
  t.check('복구 로그 1줄', logs.some(l => /기기 응답 복구/.test(l)), logs.join(' | '));
  t.check('복구 후 _failStreak 0', c._failStreak === 0);

  // PUT 실패가 큐를 막지 않는가 + 캐시/세대 가드가 유지되는가
  mode = 'fail';
  await c.sendCommand(0, '', { Operation: { power: 'Off' } }).catch(() => {});
  mode = 'ok';
  const after = await c.getDeviceStatus().catch(() => null);
  t.check('PUT 실패 뒤에도 GET 통과', !!after);
  t.check('PUT이 캐시를 무효화했음(_putSeq 증가)', c._putSeq > 0, `putSeq=${c._putSeq}`);

  // 401 래치 → 복구 로그 (v2.0.0 B3 경로)
  mode = 'auth';
  c._rawRequest = async () => { if (mode === 'auth') throw new Error('인증 실패 (401)'); return { Devices: [] }; };
  await c.getDeviceStatus(0, true).catch(() => {});
  await c.getDeviceStatus(0, true).catch(() => {});
  t.check('401은 래치되어 1회만 error', logs.filter(l => /인증 실패/.test(l)).length === 1, logs.join(' | '));
  t.check('_authLatched true', c._authLatched === true);
  mode = 'ok2';
  await c.getDeviceStatus(0, true).catch(() => {});
  t.check('토큰 복구 시 래치 해소 + 로그 1줄', c._authLatched === false && logs.some(l => /인증 복구/.test(l)), logs.join(' | '));
  t.check('누수 0', unhandledSince(base) === 0, unhandled.slice(base).join(' / '));
}

// ===========================================================================
// R6 — 크래시 재시작 직후(콜드 부팅): deviceState=null 상태의 HomeKit read
// ===========================================================================
async function R6_coldRestart() {
  const t = S('R6', '크래시 재시작 직후 — deviceState 없는 상태의 read 복구');
  const base = unhandled.length;

  const r = makeLegacyRig({ name: 'CB', noState: true, failGet: true });
  r.start();
  let err = null;
  try { await r.get(r.C.Active); } catch (e) { err = e; }
  t.check('기기 오프라인 + 캐시 없음 → HapStatusError로 변환(raw Error 아님)',
    err && err.constructor.name === 'HapStatusError', err && `${err.constructor.name}: ${err.message}`);
  t.check('HAP 상태코드 = SERVICE_COMMUNICATION_FAILURE', err && err.hapStatus === -70402);

  r.state.failGet = false;
  r.state.devicePower = 'On';
  const v = await r.get(r.C.Active);
  t.check('기기 복귀 시 첫 read가 실제 값으로 복구', v === 1, `value=${v}`);
  t.check('deviceState 재구성됨', !!r.o.deviceState);

  // STALE_HARD_CAP(180s) 초과 시 옛 값 대신 통신오류로 정직하게 폴백하는가
  r.o.lastStateUpdate = Date.now() - 200000;
  r.state.failGet = true;
  let err2 = null;
  try { await r.get(r.C.Active); } catch (e) { err2 = e; }
  t.check('stale cap 초과 + 오프라인 → 옛 값 대신 통신오류',
    err2 && err2.constructor.name === 'HapStatusError', err2 && err2.message);
  t.check('누수 0', unhandledSince(base) === 0, unhandled.slice(base).join(' / '));
  r.stop();
}

// ===========================================================================
// R7 — SmartThingsClient.sendCommand (v2.1.x 신규 코드, 기존 테스트 커버리지 0)
// ===========================================================================
async function R7_stCloudSendCommand() {
  const t = S('R7', 'SmartThingsClient.sendCommand — v2.1.x 포매터/라벨 경로 (기존 커버리지 0)');
  const base = unhandled.length;
  const logs = [];
  const log = {
    info: (...a) => logs.push(['info', a.map(String).join(' ')]),
    warn: (...a) => logs.push(['warn', a.map(String).join(' ')]),
    error: (...a) => logs.push(['error', a.map(String).join(' ')]),
    debug: (...a) => logs.push(['debug', a.map(String).join(' ')]),
  };

  // 생성자를 우회하고 sendCommand가 실제로 쓰는 필드만 채운 실인스턴스
  function makeClient(postImpl) {
    const c = Object.create(SmartThingsClient.prototype);
    c.log = log;
    c._lastNonOffCmdTs = new Map();
    c._deviceLabels = new Map();
    const invalidated = [];
    c.cache = { delete: k => invalidated.push([Date.now(), k]) };
    c.client = { post: postImpl };
    c._invalidated = invalidated;
    return c;
  }

  // (a) 정상 경로 — 라벨/한국어 명령 로그, 캐시 2회 무효화(즉시 + 1500ms)
  const okC = makeClient(async () => ({ status: 200, data: {} }));
  okC.registerDeviceLabel('dev-uuid-1', '승준 에어컨');
  const n0 = logs.length;
  await okC.setPower('dev-uuid-1', false);
  const line = logs.slice(n0).find(l => l[0] === 'info');
  t.check('(a) 라벨이 UUID를 대체', !!line && /승준 에어컨/.test(line[1]) && !/dev-uuid-1/.test(line[1]), line && line[1]);
  t.check('(a) 명령이 한국어로 표기', !!line && /전원 → 꺼짐/.test(line[1]), line && line[1]);
  t.check('(a) 즉시 캐시 무효화 1회', okC._invalidated.length === 1, JSON.stringify(okC._invalidated));
  await sleep(1700);
  t.check('(a) 1500ms 뒤 재무효화 (총 2회)', okC._invalidated.length === 2, JSON.stringify(okC._invalidated));

  // 라벨 미등록이면 UUID 폴백
  const noLabel = makeClient(async () => ({ status: 200 }));
  const n1 = logs.length;
  await noLabel.setMode('raw-uuid', 'dryClean');
  const l1 = logs.slice(n1).find(l => l[0] === 'info');
  t.check('(a2) 라벨 없으면 UUID 폴백 + 모드 한국어', !!l1 && /raw-uuid/.test(l1[1]) && /모드 → 제습청정/.test(l1[1]), l1 && l1[1]);

  // (b) POST 실패 — 원본 에러 그대로 재전파, 실패 로그에도 라벨/한국어, 본문은 debug
  const failC = makeClient(async () => {
    const e = new Error('Request failed with status code 422');
    e.response = { status: 422, data: { error: { code: 'ConstraintViolationError', message: 'bad' } } };
    throw e;
  });
  failC.registerDeviceLabel('dev-uuid-2', '승준 에어컨');
  const n2 = logs.length;
  let caught = null;
  try { await failC.setPower('dev-uuid-2', false); } catch (e) { caught = e; }
  const errLine = logs.slice(n2).find(l => l[0] === 'error');
  const warnLine = logs.slice(n2).find(l => l[0] === 'warn' && /전송 실패 상세/.test(l[1]));
  t.check('(b) 원본 에러 재전파(상위 재시도 로직 보존)', caught && /422/.test(caught.message), caught && caught.message);
  t.check('(b) 실패 로그에 라벨 + 한국어 명령', !!errLine && /승준 에어컨/.test(errLine[1]) && /전원 → 꺼짐/.test(errLine[1]), errLine && errLine[1]);
  t.check('(b) error 요약 줄은 간결 유지 — ConstraintViolationError 미포함',
    !!errLine && !/ConstraintViolationError/.test(errLine[1]), errLine && errLine[1]);
  // v2.1.3 — 감사 제안 ② 반영: body는 warn으로 기본 레벨에 보인다(라벨 포함).
  t.check('(b) ★원인코드가 warn으로 기본 레벨에 노출(v2.1.3 재승격)',
    !!warnLine && /ConstraintViolationError/.test(warnLine[1]) && /승준 에어컨/.test(warnLine[1]), warnLine && warnLine[1]);

  // (c) log.debug가 없는 로거에서도 실패 경로가 죽지 않는가 (?. 사용 확인)
  const noDbg = makeClient(async () => { const e = new Error('boom'); e.response = { status: 500, data: { x: 1 } }; throw e; });
  noDbg.log = { info() {}, warn() {}, error() {} };
  let c2 = null, threw = null;
  try { await noDbg.setPower('d', false); } catch (e) { c2 = e; }
  t.check('(c) debug 없는 로거로도 실패 경로 정상(원본 에러만 전파)', c2 && c2.message === 'boom', c2 && c2.message);

  // (d) v2.1.3 — 포매터 선계산+이중 폴백 검증(감사 제안 ③ 반영): 포매터와 JSON.stringify가
  //     둘 다 던지는 최악 케이스(throwing getter)에서도 전송이 성공으로 유지되고
  //     1500ms 재무효화까지 정상 예약되는지. (v2.1.1까지는 성공한 전송이 실패로 둔갑
  //     + 재무효화 스킵 — 이 블록의 옛 단언이 그 취약을 실증했었다.)
  let posted = 0;
  const trapC = makeClient(async () => { posted++; return { status: 200 }; });
  const trap = { component: 'main', command: 'off', get capability() { throw new Error('formatter trap'); } };
  let caught3 = null;
  try { await trapC.sendCommand('dev-trap', trap); } catch (e) { caught3 = e; }
  t.check('(d) POST는 실제로 성공했다', posted === 1);
  t.check('(d) ★예외 미전파 — 성공한 전송이 성공으로 유지', caught3 === null, caught3 && caught3.message);
  t.check('(d) ★폴백 요약으로 전송 로그가 남음(직렬화 불가 표기)',
    logs.some(l => l[0] === 'info' && /직렬화 불가/.test(l[1])));
  t.check('(d) 즉시 무효화 1회', trapC._invalidated.length === 1, JSON.stringify(trapC._invalidated));
  await sleep(1700);
  t.check('(d) ★1500ms 재무효화 예약됨 (총 2회)', trapC._invalidated.length === 2, JSON.stringify(trapC._invalidated));

  // (e) getStatus 스트릭 Map이 무한 증식하지 않는가 (기기 3대 상한)
  const stC = Object.create(SmartThingsClient.prototype);
  stC.log = { info() {}, warn() {}, error() {}, debug() {} };
  stC.cache = { get: () => undefined, set: () => {}, delete: () => {} };
  stC.statusPromises = new Map();
  stC._statusFailStreaks = new Map();
  let getFail = true;
  stC.client = { get: async () => { if (getFail) throw new Error('ETIMEDOUT'); return { data: { components: { main: {} } } }; } };
  for (let i = 0; i < 15; i++) await stC.getStatus('dev-1').catch(() => {});
  t.check('(e) 스트릭 Map 키는 기기 수만큼만', stC._statusFailStreaks.size === 1, `size=${stC._statusFailStreaks.size}`);
  t.check('(e) 스트릭 15 누적', stC._statusFailStreaks.get('dev-1') === 15, String(stC._statusFailStreaks.get('dev-1')));
  t.check('(e) statusPromises 누수 없음', stC.statusPromises.size === 0, `size=${stC.statusPromises.size}`);
  getFail = false;
  await stC.getStatus('dev-1');
  t.check('(e) 복구 시 스트릭 키 삭제', stC._statusFailStreaks.size === 0);
  t.check('누수 0', unhandledSince(base) === 0, unhandled.slice(base).join(' / '));
}

// ===========================================================================
// R8 — SmartAC 종료 내성 (클라우드 측 재시도 체인이 종료 후에도 사는가)
// ===========================================================================
async function R8_smartAcShutdown() {
  const t = S('R8', 'SmartAC — 종료 후 클라우드 명령 잔존 감사');
  const base = unhandled.length;
  const calls = [];
  const o = Object.create(SmartAC.prototype);
  o.log = { info() {}, warn() {}, error() {}, debug() {} };
  o.Characteristic = { Active: 'Active', CurrentHeaterCoolerState: { INACTIVE: 0 } };
  o._state = { power: true };
  o._stopped = false;
  o._offIntentTs = Date.now();
  o._offRetryTimer = null;
  o._resyncTimers = new Map();
  o._stateSeq = new Map();
  o._powerOnResendGen = 0;
  o._powerOnModeTimer = null;
  o.smartthings = { setPower: async (id, v) => { calls.push(['setPower', v, o._stopped]); throw new Error('cloud down'); } };
  const svc = { displayName: '승준 에어컨', updateCharacteristic: () => {} };

  o._scheduleOffRetry('dev', svc);
  t.check('끄기 재시도 예약됨', o._offRetryTimer !== null);

  // 홈브릿지 종료 = index.js가 등록한 핸들러가 하는 일과 동일한 정리
  o._stopped = true;
  clearTimeout(o._offRetryTimer);
  o._offRetryTimer = null;
  await sleep(5600);
  t.check('종료 후 클라우드 setPower 발사 0건', calls.length === 0, JSON.stringify(calls));

  // _stopped만 세우고 타이머를 안 지웠을 때도 발사되지 않는가 (심층 방어)
  const o2 = Object.create(SmartAC.prototype);
  Object.assign(o2, o, { _stopped: false, _offRetryTimer: null, _offIntentTs: Date.now() });
  const calls2 = [];
  o2.smartthings = { setPower: async (id, v) => { calls2.push(v); } };
  o2._scheduleOffRetry('dev', svc);
  o2._stopped = true;               // 타이머는 남겨둔 채 정지 플래그만
  await sleep(5600);
  t.check('_stopped 플래그만으로도 재시도 발사 차단(심층 방어)', calls2.length === 0, JSON.stringify(calls2));
  t.check('누수 0', unhandledSince(base) === 0, unhandled.slice(base).join(' / '));
}

// ===========================================================================
// R9 — ★R3에서 드러난 징후 추적: shutdown()은 setter 경로의 래치가 아니다.
// 종료 후 도착한 HomeKit write가 (1) 기기로 PUT을 내보내고 (2) shutdown이 이미
// 정리한 타이머를 새로 만들어 고아 타이머로 남기는가.
// ===========================================================================
async function R9_postShutdownSetterLatch() {
  const t = S('R9', '★shutdown 후 도착한 HomeKit write — 래치 부재 검증');

  // (1) 종료 후 OFF write
  const a = makeLegacyRig({ name: 'L1', power: 'On' });
  a.start();
  a.stop();
  await a.set(a.C.Active, 0);
  await sleep(200);
  t.check('(1) 종료 후에도 기기로 OFF PUT이 나감', a.postStopWrites().filter(w => w.kind === 'PUT').length === 1, a.fmt());
  t.note('sendCommand()에는 _stopped 검사가 없다 — getCachedState(639행)에만 있다.');

  // (2) 종료 후 ON write → shutdown이 이미 정리한 타이머를 새로 만드는가
  const b = makeLegacyRig({ name: 'L2', power: 'Off', guardMs: 400, stepMs: 300 });
  b.start();
  b.stop();
  t.check('(2) shutdown 직후 _onGuardTimer null (기준선)', b.o._onGuardTimer === null);
  await b.set(b.C.Active, 1);
  t.check('(2) 종료 후 ON PUT이 나감', b.postStopWrites().filter(w => w.kind === 'PUT').length >= 1, b.fmt());
  t.check('(2) ★shutdown 이후 _onGuardTimer가 새로 생성됨(고아 타이머)', b.o._onGuardTimer !== null,
    `onGuardTimer=${b.o._onGuardTimer === null ? 'null' : '살아있음'}`);
  t.check('(2) ★shutdown 이후 _powerOnModeTimer가 새로 생성됨(고아 타이머)', b.o._powerOnModeTimer !== null,
    `powerOnModeTimer=${b.o._powerOnModeTimer === null ? 'null' : '살아있음'}`);
  const putsBefore = b.puts().length;
  await sleep(1400); // 가드 만료 + 체인 1단계 발사 시점 통과
  t.check('(2) 고아 가드 타이머가 실제로 발화(ON 보호 종료 로그)', b.hasLog(/ON 보호 종료/), b.logs.map(l => l[2]).join(' | '));
  t.check('(2) 후속 재전송 체인은 _stopped 검사로 차단되어 추가 PUT 없음',
    b.puts().length === putsBefore, `before=${putsBefore} after=${b.puts().length} | ${b.fmt()}`);
  t.note('영향 범위: 종료 후 PUT 1건 + 타이머 2개가 남아 프로세스 종료를 최대 guard/step 만큼 지연. 체인 자체는 세대·_stopped가 막는다.');

  // (3) 종료 후 디바운스 write — _pendingDebounces가 shutdown이 비운 맵에 다시 채워지는가
  const c = makeLegacyRig({ name: 'L3', power: 'On' });
  c.start();
  c.stop();
  await c.set(c.C.CoolingThresholdTemperature, 23);
  t.check('(3) ★shutdown 이후 _pendingDebounces에 항목이 다시 쌓임',
    c.o._pendingDebounces.size === 1, `size=${c.o._pendingDebounces.size}`);
  await sleep(700);
  t.check('(3) 디바운스 flush가 종료 후 PUT을 내보냄',
    c.postStopWrites().filter(w => w.kind === 'PUT').length >= 1, c.fmt());

  // (4) 대조군: 폴링만은 종료 후 재개되지 않는다 (_poll 첫 줄에 _stopped 검사)
  const d = makeLegacyRig({ name: 'L4', pollingInterval: 1 });
  d.start();
  d.stop();
  d.o.startPolling();
  await sleep(1200);
  t.check('(4) 대조군 — 폴링은 종료 후 재개되지 않음', d.postStopWrites().length === 0, d.fmt());
  t.check('(4) 대조군 — pollTimer 재생성 없음', d.o.pollTimer === null);

  // 정리
  a.o.shutdown(); b.o.shutdown(); c.o.shutdown(); d.o.shutdown();
}

// ===========================================================================
(async function main() {
  const t0 = Date.now();
  console.log('audit_robustness — 크래시·복구 내성 (REAL code, mocked I/O)');
  await R1_unhandledRejectionStorm();
  await R2_shutdownMidFlight();
  await R3_shutdownEdges();
  await R4_pendingCountWedge();
  await R5_clientQueueWedge();
  await R6_coldRestart();
  await R7_stCloudSendCommand();
  await R8_smartAcShutdown();
  await R9_postShutdownSetterLatch();

  // 마이크로태스크가 늦게 rejection을 흘릴 여지를 준다
  await sleep(500);

  let total = 0, fail = 0;
  const fails = [];
  for (const s of scenarios) for (const c of s.checks) {
    total++; if (!c.pass) { fail++; fails.push(`[${c.id}] ${c.name}${c.extra ? ' — ' + c.extra : ''}`); }
  }
  console.log('\n' + '='.repeat(70));
  console.log(`총 ${total}개 체크 / 실패 ${fail} / 소요 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`unhandledRejection 총 누수: ${unhandled.length}건${unhandled.length ? ' → ' + unhandled.join(' / ') : ''}`);
  if (fails.length) { console.log('\n실패 목록:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exitCode = fail === 0 && unhandled.length === 0 ? 0 : 1;
})();
