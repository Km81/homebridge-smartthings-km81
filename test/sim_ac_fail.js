'use strict';
// ============================================================================
// sim_ac_fail.js — v1.8.25 실패·동시성 시나리오 시뮬레이션 (REAL code, mocked I/O)
// 대상: homebridge-smartthings-km81 v1.8.25 (배포본 HEAD)
// 방식: sim_v1824.js와 동일 — Object.create(prototype) + fake HAP service가
//       실제 onGet/onSet 핸들러를 등록받고, 우리가 HomeKit인 척 직접 구동.
//       타이머는 전부 real. 네트워크(I/O)만 mock.
// 신규 시나리오: S1 off PUT 실패 / S2 기기 blip 중 off 지연 / S3 재시작 중단 /
//               S4 HA 외부 writer 충돌 / S5 off 장면 창 중 Siri ON /
//               S6 온도 단독 자동화 잔여 클래스 / S7 오늘 23:59 정밀 리플레이
// ============================================================================
const path = require('path');
const REPO = path.join(__dirname, '..');
const LegacyAC = require(path.join(REPO, 'lib/accessories/LegacyAC.js'));
const SmartAC = require(path.join(REPO, 'lib/accessories/SmartAC.js'));
const { LegacyACClient } = require(path.join(REPO, 'lib/api/LegacyACClient.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const scenarios = [];
function S(id, title) {
  const scn = { id, title, checks: [] };
  scenarios.push(scn);
  console.log(`\n=== [${id}] ${title}`);
  return {
    check(name, cond, extra) {
      scn.checks.push({ name, pass: !!cond, extra });
      console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${!cond && extra ? ' — ' + extra : ''}`);
    },
    obs(name, extra) { // 판정 없는 관측(계측치)
      scn.checks.push({ name: `(obs) ${name}`, pass: true, doc: true });
      console.log(`  OBS  ${name}${extra ? ' — ' + extra : ''}`);
    },
    note(msg) { scn.checks.push({ name: `(doc) ${msg}`, pass: true, doc: true }); console.log(`  NOTE ${msg}`); },
  };
}

// ---------------------------------------------------------------------------
// LegacyAC rig (거실/침실 실환경 config: guard 4000 drop, step 4000, DryClean,
// resendMode+AutoClean, timeout 5000). opts.putFail(ep,data,rel)→errMsg 로 PUT 실패 주입.
// ---------------------------------------------------------------------------
function makeLegacyRig(opts = {}) {
  const wire = [];
  const logs = [];
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
  o.log = {
    info: m => logs.push([rel(), 'info', String(m)]),
    warn: m => logs.push([rel(), 'warn', String(m)]),
    error: (...a) => logs.push([rel(), 'error', a.join(' ')]),
    debug: () => {},
  };
  o.api = { hap: { HapStatusError: class HapStatusError extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } };
  o.Service = { HeaterCooler: 'HC' };
  o.Characteristic = C;
  o.aircoService = svc;
  o.name = opts.name || 'AC';
  o.debugMode = true;
  o.deviceIndex = 0; o.setDeviceIndex = 0;
  o.cacheDuration = 30000; o.timeout = 5000; o.pollingInterval = undefined; o.pollTimer = null;
  o.minTemp = 18; o.maxTemp = 30;
  o.coolModeStr = 'DryClean';
  o.swingBinding = 'comfort'; o.lockBinding = 'autoClean';
  o.swingModeHandler = {
    getValue: st => !!(st && st.Mode && st.Mode.options && st.Mode.options.includes('Comode_Nano')),
    getCommand: en => ({ endpoint: '/mode', data: { options: [en ? 'Comode_Nano' : 'Comode_Off'] } }),
  };
  o.deviceState = {
    Operation: { power: opts.power || 'On' },
    Mode: { modes: opts.modes || ['Auto'], options: opts.options || ['Comode_Off'] },
    Temperatures: [{ current: 26, desired: opts.desired != null ? opts.desired : 26 }],
  };
  o.lastStateUpdate = Date.now(); o.stateRequestPromise = null;
  o._cmdMutex = Promise.resolve(); o._stopped = false; o._pendingCmdCount = 0; o._activeInFlight = null;
  o._onGuardMs = opts.guardMs != null ? opts.guardMs : 4000;
  o._onGuardStrategy = 'drop'; o._onGuardUntil = 0; o._onGuardTimer = null; o._deferredCommands = new Map();
  o._resendModeOnPowerOn = true; o._resendAutoCleanOnPowerOn = true; o._resendSwingOffOnPowerOn = false;
  o._hideSwingToggle = false; o._hideLockToggle = false;
  o._powerOnResendStepMs = opts.stepMs != null ? opts.stepMs : 4000;
  o._powerOnModeTimer = null; o._powerOnResendGen = 0;
  o._offIntentTs = 0;
  o._stateDumpFile = null; o._lastStateDump = 0; o._stateDumpTimer = null; o._lastFetchTs = 0; o._lastMutSrc = null;
  o._refreshTimer = null; o._pendingDebounces = new Map();
  o._initialized = true;

  const lat = opts.clientLatency != null ? opts.clientLatency : 40;
  o.client = {
    sendCommand: async (idx, ep, data) => {
      wire.push({ t: rel(), kind: 'PUT', ep, data: JSON.stringify(data) });
      await sleep(lat);
      if (opts.putFail) {
        const msg = opts.putFail(ep, data, rel());
        if (msg) throw new Error(msg);
      }
    },
    getDeviceStatus: async () => {
      wire.push({ t: rel(), kind: 'GET' });
      await sleep(lat);
      return opts.statusFn ? opts.statusFn(rel()) : { Devices: [o.deviceState] };
    },
  };

  o.setupCharacteristics(); // ★ 실제 코드가 핸들러 등록

  return {
    o, C, wire, logs, svc,
    start() { t0 = Date.now(); },
    rel,
    set(char, value) {
      return Promise.resolve()
        .then(() => svc.getCharacteristic(char)._set(value))
        .catch(e => logs.push([rel(), 'setErr', String(e && e.message)]));
    },
    // HAP set 왕복시간·에러 계측 버전
    setTimed(char, value) {
      const t = rel();
      return Promise.resolve()
        .then(() => svc.getCharacteristic(char)._set(value))
        .then(() => ({ ok: true, ms: rel() - t }),
          e => { logs.push([rel(), 'setErr', String(e && e.message)]); return { ok: false, ms: rel() - t, err: String(e && e.message) }; });
    },
    get(char) { return Promise.resolve().then(() => svc.getCharacteristic(char)._get()); },
    puts() { return wire.filter(w => w.kind === 'PUT'); },
    fmt() { return wire.map(w => `${w.t}ms ${w.kind} ${w.ep !== undefined ? w.ep || '(root)' : ''} ${w.data || ''}`.trim()).join(' | '); },
    hasLog(re) { return logs.some(l => re.test(l[2])); },
    errLogs() { return logs.filter(l => l[1] === 'setErr').map(l => `${l[0]}ms ${l[2]}`); },
    stop() { o.shutdown(); },
  };
}

// ---------------------------------------------------------------------------
// SmartAC rig (승준 실환경 config: dryClean, step 2000, resend 둘 다, 클라우드 모델:
// setMode/setTemperature/setWindFree가 꺼진 기기를 재점등 — 2026-07-12 실사고 관측 동작.
// ※ setMode 재점등은 HA 레코더로 확정된 사실, setpoint/windFree 재점등은 동일 클래스 추정).
// opts.failPower(v, rel)→true 면 setPower가 cloud 반영 없이 reject (cloud 500 모델).
// ---------------------------------------------------------------------------
function makeSmartRig(opts = {}) {
  const calls = []; const logs = []; const uiUpdates = [];
  let t0 = Date.now();
  const rel = () => Date.now() - t0;

  const cloud = {
    power: opts.cloudPower != null ? opts.cloudPower : true,
    setpoint: 26, windFree: false, autoClean: false, temp: 27,
  };
  let pollFetches = 0;
  const st = {
    setPower: async (id, v) => {
      calls.push({ t: rel(), cmd: 'setPower', v });
      await sleep(30);
      if (opts.failPower && opts.failPower(v, rel())) throw new Error('SmartThings API 오류 (status 500)');
      cloud.power = v;
    },
    setMode: async (id, m) => { calls.push({ t: rel(), cmd: 'setMode', v: m }); await sleep(30); if (!cloud.power) cloud.power = true; },
    setTemperature: async (id, v) => { calls.push({ t: rel(), cmd: 'setTemperature', v }); await sleep(30); cloud.setpoint = v; if (!cloud.power) cloud.power = true; },
    setWindFree: async (id, v) => { calls.push({ t: rel(), cmd: 'setWindFree', v }); await sleep(30); cloud.windFree = v; if (!cloud.power) cloud.power = true; },
    setAutoClean: async (id, v) => { calls.push({ t: rel(), cmd: 'setAutoClean', v }); await sleep(30); cloud.autoClean = v; },
    getPower: async () => cloud.power,
    getCoolingSetpoint: async () => cloud.setpoint,
    getWindFree: async () => cloud.windFree,
    getAutoClean: async () => cloud.autoClean,
    getCurrentTemperature: async () => cloud.temp,
    invalidateStatusCache: () => { pollFetches++; },
  };

  const C = {
    Active: { displayName: 'Active' },
    CurrentHeaterCoolerState: { displayName: 'CurrentState', INACTIVE: 0, IDLE: 1, COOLING: 2 },
    TargetHeaterCoolerState: { displayName: 'TargetState', COOL: 2 },
    CurrentTemperature: { displayName: 'CurrentTemp' },
    CoolingThresholdTemperature: { displayName: 'CoolingThreshold' },
    SwingMode: { displayName: 'SwingMode' },
    LockPhysicalControls: { displayName: 'Lock' },
    On: { displayName: 'On' },
  };
  const chars = new Map();
  const svc = {
    displayName: opts.name || '승준AC',
    getCharacteristic(c) {
      if (!chars.has(c)) {
        chars.set(c, {
          _get: null, _set: null,
          removeAllListeners() {},
          setProps() { return this; },
          on(ev, fn) { if (ev === 'get') this._get = fn; else if (ev === 'set') this._set = fn; return this; },
        });
      }
      return chars.get(c);
    },
    testCharacteristic(c) { return chars.has(c); },
    removeCharacteristic() {},
    updateCharacteristic(c, v) { uiUpdates.push([rel(), c.displayName, v]); },
  };

  const o = Object.create(SmartAC.prototype);
  o.log = {
    info: m => logs.push([rel(), 'info', String(m)]),
    warn: m => logs.push([rel(), 'warn', String(m)]),
    error: (...a) => logs.push([rel(), 'error', a.join(' ')]),
    debug: m => logs.push([rel(), 'debug', String(m)]),
  };
  o.api = { hap: { HapStatusError: class HapStatusError extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } };
  o.smartthings = st;
  o.platform = { config: {} };
  o.Service = { HeaterCooler: 'HC' };
  o.Characteristic = C;
  o._state = {
    power: opts.statePower != null ? opts.statePower : true,
    currentTemp: 27, coolingSetpoint: 26, windFree: false, autoClean: false,
  };
  o._resyncTimers = new Map(); o._stateSeq = new Map(); o._seedInFlight = {}; o._seeded = new Set();
  o._backgroundPollTimer = null; o._powerOnModeTimer = null; o._powerOnResendGen = 0;
  o._offIntentTs = 0; o._stopped = false;
  o._linkedSwitchServices = { windFree: null, autoClean: null };

  const accessory = { context: { device: { deviceId: 'dev1' } }, displayName: svc.displayName, getService: () => svc, addService: () => svc };
  const configDevice = { coolModeCommand: 'dryClean', resendModeOnPowerOn: true, resendAutoCleanOnPowerOn: true, powerOnResendStepMs: 2000 };
  o._setupHeaterCooler(accessory, configDevice); // ★ 실제 코드가 핸들러 등록 (폴링 미기동)

  return {
    o, C, calls, logs, cloud, uiUpdates, accessory,
    rel,
    pollFetchCount: () => pollFetches,
    start() { t0 = Date.now(); },
    set(char, value) {
      return new Promise(res => {
        svc.getCharacteristic(char)._set(value, e => {
          if (e) logs.push([rel(), 'setErr', String(e.message || e)]);
          res();
        });
      });
    },
    setTimed(char, value) {
      const t = rel();
      return new Promise(res => {
        svc.getCharacteristic(char)._set(value, e => {
          if (e) logs.push([rel(), 'setErr', String(e.message || e)]);
          res({ ok: !e, ms: rel() - t, err: e && String(e.message || e) });
        });
      });
    },
    get(char) {
      return new Promise((res, rej) => svc.getCharacteristic(char)._get((e, v) => e ? rej(e) : res(v)));
    },
    cmds() { return calls.map(c => `${c.t}ms ${c.cmd}(${c.v})`).join(' | '); },
    hasLog(re) { return logs.some(l => re.test(l[2])); },
    errLogs() { return logs.filter(l => l[1] === 'setErr').map(l => `${l[0]}ms ${l[2]}`); },
    stop() {
      o._stopped = true;
      for (const t of o._resyncTimers.values()) clearTimeout(t);
      o._resyncTimers.clear();
      if (o._backgroundPollTimer) clearTimeout(o._backgroundPollTimer);
      if (o._powerOnModeTimer) clearTimeout(o._powerOnModeTimer);
    },
    // configure()가 registerShutdown에 등록하는 실제 핸들러 본문과 동일 (S3용)
    simulateShutdown() {
      o._stopped = true;
      for (const t of o._resyncTimers.values()) clearTimeout(t);
      o._resyncTimers.clear();
      if (o._backgroundPollTimer) clearTimeout(o._backgroundPollTimer);
      if (o._powerOnModeTimer) clearTimeout(o._powerOnModeTimer);
    },
  };
}

// 실제 LegacyACClient + mock raw layer (S2/S4용). timeoutMs = 스케일된 소켓 타임아웃.
function makeRawMockClient({ timeoutMs, mode, recoverAt = Infinity, busyWindows = [] }) {
  const clientLogs = [];
  const log = { warn: m => clientLogs.push(['warn', String(m)]), error: m => clientLogs.push(['error', String(m)]), info: () => {}, debug: () => {} };
  const client = new LegacyACClient('10.9.9.' + Math.floor(Math.random() * 250), 'tok', log, { timeout: timeoutMs });
  const attempts = [];
  const device = { power: 'On', modes: ['Auto'], options: ['Comode_Off'], desired: 26 };
  let t0 = Date.now();
  const rel = () => Date.now() - t0;
  client._rawRequest = async (p, method, data) => {
    const start = rel();
    if (mode === 'blip' && start < recoverAt) {
      await sleep(timeoutMs); // 소켓 무응답 → setTimeout 발화 모델
      attempts.push({ t: start, end: rel(), method, p, ok: false, why: 'timeout' });
      throw new Error(`요청 시간 초과 (${timeoutMs}ms)`);
    }
    if (mode === 'busy' && busyWindows.some(([a, b]) => start >= a && start < b)) {
      await sleep(30); // 단일 연결 점유 → 빠른 접속 거부 모델
      attempts.push({ t: start, end: rel(), method, p, ok: false, why: 'refused' });
      throw new Error('TLS 소켓 오류: connect ECONNREFUSED 192.168.1.3:8888');
    }
    await sleep(120);
    if (method === 'PUT' && data && data.Operation && data.Operation.power) device.power = data.Operation.power;
    attempts.push({ t: start, end: rel(), method, p, ok: true });
    if (method === 'GET') {
      return { Devices: [{ Operation: { power: device.power }, Mode: { modes: device.modes, options: device.options }, Temperatures: [{ current: 26, desired: device.desired }] }] };
    }
    return {};
  };
  return {
    client, attempts, device, clientLogs,
    syncStart(startEpoch) { t0 = startEpoch; },
    fmt() { return attempts.map(a => `${a.t}→${a.end}ms ${a.method} ${a.p} ${a.ok ? 'OK' : a.why}`).join(' | '); },
  };
}

// ===========================================================================
// S1. off PUT 실패 (클라우드 500 / 로컬 타임아웃) — 자가치유 부재 확인
// ===========================================================================
async function scenarioS1() {
  const T = S('S1', 'off PUT 실패: HomeKit 에러 전파·상태 오염 없음·수렴 경로·자가치유 부재');

  // --- S1-SmartAC: 끄기 장면 첫 write(setPower false)가 cloud 500 ---
  const sm = makeSmartRig({
    statePower: true, cloudPower: true, name: 'S1-SM',
    failPower: (v, t) => v === false && t < 5000, // 5초 내 OFF만 실패
  });
  // --- S1-LegacyAC-a: off PUT 응답 타임아웃, 기기는 미적용(여전히 On) ---
  const la = makeLegacyRig({
    power: 'On', name: 'S1-LA',
    putFail: (ep, data, t) => (ep === '' && t < 3000) ? '요청 시간 초과 (5000ms)' : null,
    statusFn: () => ({ Devices: [{ Operation: { power: 'On' }, Mode: { modes: ['Auto'], options: [] }, Temperatures: [{ current: 26, desired: 26 }] }] }),
  });
  // --- S1-LegacyAC-b: off PUT 응답 타임아웃이지만 기기는 실제로 적용(모호 실패의 반대면) ---
  const lb = makeLegacyRig({
    power: 'On', name: 'S1-LB',
    putFail: (ep, data, t) => (ep === '' && t < 3000) ? '요청 시간 초과 (5000ms)' : null,
    statusFn: () => ({ Devices: [{ Operation: { power: 'Off' }, Mode: { modes: ['Auto'], options: [] }, Temperatures: [{ current: 26, desired: 26 }] }] }),
  });
  sm.start(); la.start(); lb.start();

  // SmartAC: 장면 순서(off→형제) 그대로 + off 실패
  const smTap = sm.setTimed(sm.C.Active, 0);
  setTimeout(() => sm.set(sm.C.TargetHeaterCoolerState, 2), 300);
  setTimeout(() => sm.set(sm.C.SwingMode, 1), 600);
  const smMarkerAtTap = new Promise(res => setTimeout(() => res(sm.o._isOffSceneWindow()), 80));

  // LegacyAC: 단독 off 탭 실패
  const laTap = la.setTimed(la.C.Active, 0);
  const lbTap = lb.setTimed(lb.C.Active, 0);
  // 1초 뒤 폴링 가동(실환경 10s 주기를 1s로 스케일) → 실측 수렴 확인
  setTimeout(() => { la.o.pollingInterval = 1; la.o.startPolling(); }, 1000);
  setTimeout(() => { lb.o.pollingInterval = 1; lb.o.startPolling(); }, 1000);

  // SmartAC 백그라운드 폴링(최소 10s) 가동 → 폴링이 무엇을 하는지 실코드로 관측
  sm.o._setupBackgroundPolling(sm.accessory, { pollingInterval: 10 });

  const [smRes, laRes, lbRes] = await Promise.all([smTap, laTap, lbTap]);
  await sleep(4200);

  // --- SmartAC 판정 ---
  T.check('SM: HomeKit이 off 실패를 에러로 수신(setter throw)', !smRes.ok && /500/.test(smRes.err || ''), JSON.stringify(smRes));
  T.check('SM: _state.power 오염 없음(여전히 true — 낙관 patch가 send 성공 후라 안전)', sm.o._state.power === true, String(sm.o._state.power));
  T.check('SM: 실패 시 power resync 미예약(throw가 스케줄 이전)', !sm.o._resyncTimers.has('power'));
  T.check('SM: 마커는 의도 시점에 이미 세워짐 → 형제 write 억제는 유지', (await smMarkerAtTap) === true);
  T.check('SM: 형제 setMode/setWindFree 억제됨(off 실패와 무관)', !sm.calls.some(c => c.cmd === 'setMode' || c.cmd === 'setWindFree'), sm.cmds());
  T.check('SM: 4초 시점까지는 재전송 없음(v1.8.26 자가치유는 +5s에 발화)', sm.calls.filter(c => c.cmd === 'setPower').length === 1, sm.cmds());
  T.obs('SM: 사용자 가시 상태 = iOS가 setter 에러로 타일을 이전 값(켜짐)으로 롤백 + 기기 실제 켜짐 유지(진실과 일치)');

  // 폴링 1회 통과(10s) 후: _state와 cloud 일치라 push 없음 확인 → 그 뒤 사용자 재탭 성공
  await sleep(6600); // 총 ~10.8s
  T.check('SM: 10s 폴링 실행됨', sm.pollFetchCount() >= 1, `fetches=${sm.pollFetchCount()}`);
  // v1.8.26 — off 전송 실패 시 5초 뒤 1회 자가치유 재시도(setPower 총 2회, 둘 다 false)
  const smPowers = sm.calls.filter(c => c.cmd === 'setPower');
  T.check('SM[v1.8.26]: off 자가치유 재시도 1회 발화(총 2회, 전부 false)', smPowers.length === 2 && smPowers.every(c => c.v === false), sm.cmds());
  const smTap2 = await sm.setTimed(sm.C.Active, 0); // 사용자 재탭(이제 cloud 정상)
  await sleep(300);
  T.check('SM: 사용자 재탭은 성공(v1.8.25 OFF 무조건 전송 → 유일한 치유 경로=사람)', smTap2.ok && sm.cloud.power === false, JSON.stringify(smTap2));

  // --- LegacyAC-a 판정 (기기 미적용) ---
  T.check('LA: HomeKit이 off 실패를 에러로 수신', !laRes.ok && /시간 초과/.test(laRes.err || ''), JSON.stringify(laRes));
  T.check('LA: deviceState 오염 없음(patch가 send 성공 후 — 여전히 On)', la.o.deviceState.Operation.power === 'On');
  T.check('LA: refresh 미예약(_cancelAllPendingWrites 후 throw)', la.o._refreshTimer === null);
  // v1.8.26 — 클라이언트 레벨 무재시도('띠' 방지)는 유지하되, 세터 레벨 자가치유가 +5s에 off 1회 재전송
  const laPuts = la.puts();
  T.check('LA[v1.8.26]: off 자가치유 재시도 1회(전체 PUT 2회, 둘 다 off)', laPuts.length === 2 && laPuts.every(p => /"power":"Off"/.test(p.data)), la.fmt());
  T.check('LA: 폴링이 실측 On으로 수렴(HomeKit=진실, 그러나 꺼지지 않음)', (await la.get(la.C.Active)) === 1);
  T.obs('LA: 결과 = "끄기 실패가 조용히 켜짐 유지로 남음" — 사용자가 화면을 다시 봐야 알 수 있음');

  // --- LegacyAC-b 판정 (기기 실제 적용 — 모호 실패의 반대면) ---
  T.check('LB: 기기가 적용했다면 폴링이 Off로 수렴(에러 표시 후 조용히 성공)', (await lb.get(lb.C.Active)) === 0);
  T.note('LB: PUT 응답 타임아웃은 "적용됐는지 모름" — 재전송 안 하는 것은 띠 중복 방지 트레이드오프(수용됨). 다만 미적용 케이스(LA)는 아무도 교정하지 않음 = 잔여 리스크.');

  sm.stop(); la.stop(); lb.stop();
}

// ===========================================================================
// S2. 기기 blip 중 off 탭 — 직렬 큐 + GET 재시도가 OFF를 얼마나 늦추나 (실 클라이언트)
// 스케일: timeout 5000ms→1000ms (GET 사이클 18s→6s). 백오프(1s,2s)는 실코드 고정값.
// ===========================================================================
async function scenarioS2() {
  const T = S('S2', 'LegacyAC blip 중 off: GET 재시도 사이클이 직렬 큐를 점유 → OFF 지연 실측');

  // S2a: blip이 계속됨(최악) — OFF는 GET 사이클 완료 후에야 와이어에 오르고, 자신도 타임아웃
  const ma = makeRawMockClient({ timeoutMs: 1000, mode: 'blip', recoverAt: Infinity });
  const ra = makeLegacyRig({ power: 'On', name: 'S2a' });
  ra.o.client = ma.client;
  // S2b: 4.5s에 기기 회복 — 3번째 GET 시도가 성공하고 OFF가 이어짐
  const mb = makeRawMockClient({ timeoutMs: 1000, mode: 'blip', recoverAt: 4500 });
  const rb = makeLegacyRig({ power: 'On', name: 'S2b' });
  rb.o.client = mb.client;

  ra.start(); ma.syncStart(Date.now());
  rb.start(); mb.syncStart(Date.now());

  // t=0: 주기 폴링이 막 발화(불운의 타이밍) → GET 재시도 사이클 시작
  ra.o.getCachedState(true).catch(() => {});
  rb.o.getCachedState(true).catch(() => {});
  // t=200ms: 사용자 off 탭
  let tapA, tapB;
  setTimeout(() => { tapA = ra.setTimed(ra.C.Active, 0); }, 200);
  setTimeout(() => { tapB = rb.setTimed(rb.C.Active, 0); }, 200);

  await sleep(9000);
  const resA = await tapA; const resB = await tapB;

  // --- S2a ---
  const putA = ma.attempts.filter(a => a.method === 'PUT');
  const getA = ma.attempts.filter(a => a.method === 'GET');
  // v1.8.26 — 대기자 양보: PUT이 큐에 서면 GET는 남은 재시도를 포기 → OFF가 즉시 와이어에 오름
  T.check('S2a[v1.8.26]: GET가 대기자에 양보(1회 시도 후 중단)', getA.length === 1, ma.fmt());
  T.check('S2a[v1.8.26]: OFF PUT 와이어 진입 ≈1s(양보 덕분 — 구 버전 ≈6s)', putA.length >= 1 && putA[0].t >= 900 && putA[0].t <= 2500, ma.fmt());
  T.check('S2a[v1.8.26]: PUT 시도 2회 = 탭 1 + 자가치유 재시도 1(클라이언트 레벨 무재시도는 유지)', putA.length === 2, `PUT attempts=${putA.length}`);
  T.check('S2a[v1.8.26]: 탭→HomeKit 에러 ≈2s(스케일 — 구 6.8s)', !resA.ok && resA.ms >= 1500 && resA.ms <= 3200, JSON.stringify(resA));
  T.obs(`S2a 계측: 탭→와이어 ${putA[0] ? putA[0].t - 200 : '?'}ms, 탭→에러 ${resA.ms}ms (timeout 1s 스케일)`);
  T.note('S2a 실환경 환산(timeout 5000): 탭→와이어 ≈5s(진행 중 GET 1회만 대기), 탭→에러 ≈10s(구 22.8s), 자가치유 재시도 +5s. blip 창에서도 명령이 큐에 갇히지 않음.');
  T.check('S2a: 실패 후 deviceState 오염 없음(On 유지)', ra.o.deviceState.Operation.power === 'On');

  // --- S2b ---
  const putB = mb.attempts.filter(a => a.method === 'PUT');
  // v1.8.26 — 탭 PUT은 회복 전에 빨리 실행돼 실패하지만, 자가치유 재시도(+5s)가 회복 후 OFF를 착지시킴
  T.check('S2b[v1.8.26]: 탭 PUT 실패 후 자가치유 재시도가 회복 후 OFF 착지', putB.length === 2 && !putB[0].ok && putB[1].ok, mb.fmt());
  T.check('S2b[v1.8.26]: 재시도 착지 ≈7s(실패 시점+5s)', putB[1] && putB[1].end >= 6300 && putB[1].end <= 8500, mb.fmt());
  T.check('S2b[v1.8.26]: 탭 자체는 빠른 에러로 완결(자가치유가 뒤에서 마무리)', resB.ok === false, JSON.stringify(resB));
  T.check('S2b: 최종 전원 Off(기기·캐시 일치)', mb.device.power === 'Off' && rb.o.deviceState.Operation.power === 'Off');
  T.note('S2b 실환산: 회복이 GET 사이클 중이면 OFF 착지 ≈13~18s. 큐가 명령을 잃지는 않음(지연만).');

  ra.stop(); rb.stop();
}

// ===========================================================================
// S3. 홈브릿지 재시작이 체인 중간에 — 종료 후 송신 0 + 재시작 후 모드 미집행 갭
// ===========================================================================
async function scenarioS3() {
  const T = S('S3', '재시작 mid-chain: 종료 후 송신 없음(깨끗한 중단) + 체인 망각 갭');

  // L-a: ON(체인: guard 4s 후 모드) → +2s에 shutdown → 모드 영원히 미전송
  const la = makeLegacyRig({ power: 'Off', name: 'S3-La' });
  // L-b: 체인 1단계(모드 PUT)가 와이어에 오른 '도중' shutdown → 그 PUT은 완료되나 다음 단계 없음
  const lb = makeLegacyRig({ power: 'Off', name: 'S3-Lb', clientLatency: 300 });
  // SM: SmartAC ON(체인 2s) → +1s에 shutdown(실제 registerShutdown 핸들러 본문)
  const sm = makeSmartRig({ statePower: false, cloudPower: false, name: 'S3-SM' });

  la.start(); lb.start(); sm.start();
  la.set(la.C.Active, 1);
  lb.set(lb.C.Active, 1);
  sm.set(sm.C.Active, 1);

  setTimeout(() => la.o.shutdown(), 2000);
  // lb: ON 전송(~0.6s 완료) → guard 열림 → 체인 발화 ≈ 0.6+4.1=4.7s, PUT 4.7~5.0s → 4.85s에 shutdown
  setTimeout(() => lb.o.shutdown(), 4850);
  setTimeout(() => sm.simulateShutdown(), 1000);

  await sleep(10500);

  // --- L-a ---
  {
    const p = la.puts();
    const afterShutdown = p.filter(x => x.t > 2050);
    T.check('La: shutdown(+2s) 이후 송신 0 (체인 타이머 정리)', afterShutdown.length === 0, la.fmt());
    T.check('La: 와이어 = 전원 ON 1건뿐 — 모드/자동건조 영원히 미전송', p.length === 1 && p[0].data.includes('"power":"On"'), la.fmt());
    T.check('La: 체인 타이머 정리됨', la.o._powerOnModeTimer === null && la.o._stopped === true);
  }
  // --- L-b (in-flight 중 종료) ---
  {
    const p = lb.puts();
    const kinds = p.map(x => x.data.includes('"power":"On"') ? 'ON' : x.data.includes('modes') ? 'MODE' : x.data.includes('Autoclean') ? 'ACLEAN' : '?');
    T.check('Lb: 와이어에 이미 오른 모드 PUT은 완료(회수 불가 — 예상 동작)', kinds.includes('MODE'), lb.fmt());
    T.check('Lb: shutdown 후 다음 단계(자동건조) 미발화(.then의 _stopped 가드)', !kinds.includes('ACLEAN'), lb.fmt());
  }
  // --- SM ---
  {
    T.check('SM: shutdown(+1s) 후 체인 미발화 — setPower(true) 1건만', sm.calls.length === 1 && sm.calls[0].cmd === 'setPower' && sm.calls[0].v === true, sm.cmds());
    T.check('SM: cloud는 켜졌고 모드는 영원히 미전송', sm.cloud.power === true && !sm.calls.some(c => c.cmd === 'setMode'));
  }
  // --- 재시작 후 세계(새 프로세스 = 새 rig): 체인 기억 없음, HomeKit 뷰의 갭 ---
  const fresh = makeLegacyRig({ power: 'On', modes: ['Auto'], name: 'S3-fresh' }); // 잘못된 모드로 켜져 있음
  fresh.start();
  const act = await fresh.get(fresh.C.Active);
  const ts = await fresh.get(fresh.C.TargetHeaterCoolerState);
  T.check('재시작 후: Active=1(진실) + TargetState=COOL 고정 표시 — 실제 모드 Auto인데 HomeKit으론 구분 불가', act === 1 && ts === 2);
  T.note('갭(사실): 체인은 메모리 전용 — 재시작하면 "설정 모드 집행"이 소실되고, 기기는 잘못된 모드로 계속 돈다. HomeKit UI로는 모드 불일치가 보이지 않음(TargetState 고정 COOL). 단 발생 조건 = 전원 ON 후 2~8초 사이 재시작이라 확률 낮음.');
  la.stop(); lb.stop(); sm.stop(); fresh.stop();
}

// ===========================================================================
// S4. HA 외부 writer 충돌(단일 연결 점유) — off 지연 1~3s에도 억제창 유지되나
// ===========================================================================
async function scenarioS4() {
  const T = S('S4', 'HA SharedClient 외부 충돌: 기기 점유로 OFF 지연 — 장면 억제창 마진 분석');
  const mc = makeRawMockClient({ timeoutMs: 1000, mode: 'busy', busyWindows: [[0, 1200]] });
  const r = makeLegacyRig({ power: 'On', name: 'S4' });
  r.o.client = mc.client;
  r.start(); mc.syncStart(Date.now());

  // 끄기 장면(실측 순서): off@0 + 형제 0.3/0.4/0.6s(온도 flush 1.0s). 외부 writer가 0~1.2s 점유.
  const tap = r.setTimed(r.C.Active, 0);
  setTimeout(() => r.set(r.C.TargetHeaterCoolerState, 2), 300);
  setTimeout(() => r.set(r.C.SwingMode, 1), 400);
  setTimeout(() => r.set(r.C.CoolingThresholdTemperature, 25), 600);
  const res = await tap;
  await sleep(4500);

  const put = mc.attempts.filter(a => a.method === 'PUT');
  const refused = put.filter(a => !a.ok);
  const landed = put.filter(a => a.ok);
  T.check('OFF는 ECONNREFUSED 분류로 PUT도 재시도됨(유실 없음)', refused.length === 2 && landed.length === 1, mc.fmt());
  T.check('OFF 착지 ≈3.1s(백오프 1s+2s 후 3차 성공)', landed[0] && landed[0].end >= 2900 && landed[0].end <= 3800, mc.fmt());
  T.check('형제 write 3종 전부 억제(와이어 도달 0)', landed.length === 1 && put.every(a => a.p === '/devices/0'), mc.fmt());
  T.check('억제 로그 3종', r.hasLog(/TargetState: 끄기 장면 창/) && r.hasLog(/SwingMode: 끄기 장면 창/) && r.hasLog(/TargetTemp 25: 끄기 장면 창/));
  T.check('마커는 의도 시점 고정 — OFF 지연이 억제창을 침식하지 않음', r.o._offIntentTs > 0);
  T.check('최종 전원 Off(기기·캐시)', mc.device.power === 'Off' && r.o.deviceState.Operation.power === 'Off');
  T.check('탭 완결(성공) — 재시도 포함 왕복', res.ok && res.ms >= 2900 && res.ms <= 4200, JSON.stringify(res));
  T.obs(`마진 계산: 억제창 2500ms(의도 시점 기준) − 마지막 형제 flush ≈1000ms = 여유 ≈1500ms. 외부 점유가 OFF를 1~3s 늦춰도 형제 억제는 무관(마커가 send가 아닌 intent에 앵커). OFF 자체 지연만 발생: 이번 실측 착지 ${landed[0] ? landed[0].end : '?'}ms.`);
  T.note('한계(추정): 외부 writer가 점유 중 "전원 ON"을 쓰면(우리 off 이후) 플러그인은 이를 되돌리지 않음 — S1과 같은 잔여 클래스. 또 점유가 refuse가 아닌 hang이면 S2 패턴(타임아웃 5s+GET 재시도)으로 퇴화.');
  r.stop();
}

// ===========================================================================
// S5. off 장면 창 활성 중 Siri/타일 ON — ON 유실 없어야 함
// ===========================================================================
async function scenarioS5() {
  const T = S('S5', 'off 장면 창 중 ON(1.5s): 마커 해제·체인 생존·ON 유실 없음');

  // L1: 장면 off@0(+형제 0.3~0.6), Siri ON@1.5s — 장면 온도 flush(1.0s)는 창내 억제
  const l1 = makeLegacyRig({ power: 'On', name: 'S5-L1' });
  // L2: 장면 온도가 늦게(1.3s, flush 1.7s) — ON(1.5s) 후 flush: 마커는 해제, ON guard가 drop
  const l2 = makeLegacyRig({ power: 'On', name: 'S5-L2' });
  // SM: 승준 동일 시퀀스
  const sm = makeSmartRig({ statePower: true, cloudPower: true, name: 'S5-SM' });
  l1.start(); l2.start(); sm.start();

  l1.set(l1.C.Active, 0);
  setTimeout(() => l1.set(l1.C.TargetHeaterCoolerState, 2), 300);
  setTimeout(() => l1.set(l1.C.CoolingThresholdTemperature, 25), 600);
  setTimeout(() => l1.set(l1.C.Active, 1), 1500);

  l2.set(l2.C.Active, 0);
  setTimeout(() => l2.set(l2.C.CoolingThresholdTemperature, 25), 1300); // flush 1.7s
  setTimeout(() => l2.set(l2.C.Active, 1), 1500);

  sm.set(sm.C.Active, 0);
  setTimeout(() => sm.set(sm.C.TargetHeaterCoolerState, 2), 300);
  setTimeout(() => sm.set(sm.C.SwingMode, 1), 400);
  setTimeout(() => sm.set(sm.C.CoolingThresholdTemperature, 25), 600);
  setTimeout(() => sm.set(sm.C.Active, 1), 1500);

  await sleep(11500);

  // --- L1 ---
  {
    const p = l1.puts();
    const seq = p.map(x => x.data.includes('"power":"On"') ? 'ON' : x.data.includes('"power":"Off"') ? 'OFF'
      : x.data.includes('modes') ? 'MODE' : x.data.includes('Autoclean') ? 'ACLEAN' : x.ep);
    T.check('L1: [OFF, ON, MODE, ACLEAN] — ON 유실 없음 + 체인 완주', JSON.stringify(seq) === '["OFF","ON","MODE","ACLEAN"]', l1.fmt());
    T.check('L1: 장면 온도(창내 flush)는 억제됨', !p.some(x => x.ep === '/temperatures/0'), l1.fmt());
    T.check('L1: 마커 해제(_offIntentTs=0)', l1.o._offIntentTs === 0);
    T.check('L1: 최종 전원 On·모드 DryClean', l1.o.deviceState.Operation.power === 'On' && (l1.o.deviceState.Mode.modes || [])[0] === 'DryClean');
  }
  // --- L2 ---
  {
    const p = l2.puts();
    T.check('L2: ON 유실 없음(전원 On 1회 송신)', p.filter(x => x.data.includes('"power":"On"')).length === 1, l2.fmt());
    T.check('L2: 늦은 장면 온도 flush(1.7s)는 마커 해제됐지만 ON guard가 drop — 와이어 0', !p.some(x => x.ep === '/temperatures/0') && l2.hasLog(/ON 보호 중 명령 무시: \/temperatures\/0/), l2.fmt());
    T.check('L2: 체인 완주(MODE, ACLEAN)', p.some(x => x.data.includes('modes')) && p.some(x => x.data.includes('Autoclean')), l2.fmt());
    T.check('L2: 최종 전원 On', l2.o.deviceState.Operation.power === 'On');
  }
  // --- SM ---
  {
    const c = sm.calls;
    const offs = c.filter(x => x.cmd === 'setPower' && x.v === false);
    const ons = c.filter(x => x.cmd === 'setPower' && x.v === true);
    T.check('SM: OFF 1회 → ON 1회(유실 없음)', offs.length === 1 && ons.length === 1 && ons[0].t > offs[0].t, sm.cmds());
    T.check('SM: 장면 형제(setMode/setWindFree/setTemperature) 억제 유지', !c.some(x => x.t < 1500 && ['setMode', 'setWindFree', 'setTemperature'].includes(x.cmd)), sm.cmds());
    const chainMode = c.find(x => x.cmd === 'setMode');
    const chainAC = c.find(x => x.cmd === 'setAutoClean');
    T.check('SM: ON 체인 생존 — setMode(+2s)·자동건조(+4s)', chainMode && chainAC && chainMode.t >= 3300 && chainAC.t >= 5300, sm.cmds());
    T.check('SM: 최종 cloud 전원 ON', sm.cloud.power === true);
    T.check('SM: ON 이후 어떤 OFF도 없음(억제 resync가 전원을 건드리지 않음)', !c.some(x => x.cmd === 'setPower' && x.v === false && x.t > 1500), sm.cmds());
  }
  T.note('23:59 자동화 직후 Siri "켜줘"는 안전: 마커가 ON 의도에서 즉시 해제되고 체인이 정상 가동. 단, 장면의 온도 스냅샷은 (창내면 억제 / 창밖+guard면 drop) 어느 쪽이든 무시됨 — 사용자가 ON 후 원하는 온도는 직접 설정해야 함(기존 설계와 동일).');
  l1.stop(); l2.stop(); sm.stop();
}

// ===========================================================================
// S6. 온도 단독 자동화(Active write 없음) — 마커 없는 잔여 클래스 정량화
// ===========================================================================
async function scenarioS6() {
  const T = S('S6', '온도 단독 write(기기 Off): 마커 없음 → 송신됨 → (클라우드) 재점등 잔여 클래스');
  const sm = makeSmartRig({ statePower: false, cloudPower: false, name: 'S6-SM' });
  const lg = makeLegacyRig({ power: 'Off', name: 'S6-LG' });
  sm.start(); lg.start();

  sm.set(sm.C.CoolingThresholdTemperature, 25); // 가상의 "온도 25 설정" 자동화
  lg.set(lg.C.CoolingThresholdTemperature, 25);
  await sleep(3500);

  const c = sm.calls;
  T.check('SM: setTemperature 송신됨(억제 장치 없음 — Active write가 없어 마커 부재)', c.some(x => x.cmd === 'setTemperature' && x.v === 25), sm.cmds());
  T.check('SM: (모델) 클라우드가 꺼진 기기를 재점등 — 아무도 끄지 않음', sm.cloud.power === true, sm.cmds());
  T.check('SM: 이후 setPower(false) 0회 — off가 뒤따르지 않는 것이 이 클래스의 본질', !c.some(x => x.cmd === 'setPower'), sm.cmds());
  T.obs('SM: 폴링/resync은 "켜짐"을 HomeKit에 정직하게 반영할 뿐 되돌리지 않음(정확성 우선 설계)');
  const lp = lg.puts();
  T.check('LG: /temperatures/0 송신됨(동일 — 가드 없음)', lp.some(x => x.ep === '/temperatures/0'), lg.fmt());
  T.note('사실/추정 구분: SmartThings 클라우드의 재점등은 setMode에서 HA 레코더로 확정(7/12 사고). setpoint 단독 write의 재점등은 같은 클래스로 "추정"(미실측). LegacyAC 로컬 프로토콜의 온도 write가 꺼진 기기를 켜는지는 미확인(추정: 안 켤 가능성이 높지만 검증 필요). 현재 이런 자동화는 없음 — 사용자가 만들면 발현되는 잠재 클래스.');
  sm.stop(); lg.stop();
}

// ===========================================================================
// S7. 오늘 23:59 정밀 리플레이 — SmartAC, 기기 Off, 실측 순서/오프셋
// ===========================================================================
async function scenarioS7() {
  const T = S('S7', '23:59 리플레이(v1.8.25): Active=0 → TS(0.3s) → Swing(0.6s) → 온도(1.0s)');
  const r = makeSmartRig({ statePower: false, cloudPower: false, name: '승준-2359' });
  r.start();
  r.set(r.C.Active, 0);
  setTimeout(() => r.set(r.C.TargetHeaterCoolerState, 2), 300);
  setTimeout(() => r.set(r.C.SwingMode, 1), 600);
  setTimeout(() => r.set(r.C.CoolingThresholdTemperature, 25), 1000); // flush 1.4s
  await sleep(4600);

  const c = r.calls;
  T.check('setPower(false) 정확히 1회(기기 이미 Off여도 무조건 전송 — v1.8.25)', c.length === 1 && c[0].cmd === 'setPower' && c[0].v === false, r.cmds());
  T.check('모드/무풍/온도 송신 0건', !c.some(x => ['setMode', 'setWindFree', 'setTemperature'].includes(x.cmd)), r.cmds());
  T.check('억제 로그 3종(TS/무풍/온도)', r.hasLog(/TargetState: 끄기 장면 창/) && r.hasLog(/WindFree: 끄기 장면 창/) && r.hasLog(/Setpoint 25: 끄기 장면 창/));
  T.check('최종 cloud 전원 OFF(밤새 꺼짐 유지)', r.cloud.power === false);
  T.check('억제 resync 완료 — resync 타이머 잔존 0', r.o._resyncTimers.size === 0, `size=${r.o._resyncTimers.size}`);
  T.check('전원 ON 체인 타이머 잔존 없음', r.o._powerOnModeTimer === null);
  T.check('마커 창 자연 만료(잔존 억제 없음 — 이후 수동 조작 정상)', r.o._offIntentTs > 0 && !r.o._isOffSceneWindow());
  const activeUpdates = r.uiUpdates.filter(u => u[1] === 'Active');
  T.check('HAP 표시 최종 Active=0(켜짐으로 오표시 없음)', activeUpdates.length > 0 && activeUpdates.every(u => u[2] === 0), JSON.stringify(activeUpdates));
  const swingResync = r.uiUpdates.find(u => u[1] === 'SwingMode');
  const setpResync = r.uiUpdates.find(u => u[1] === 'CoolingThreshold');
  T.check('억제된 스냅샷 값이 표시에 고착되지 않음(무풍→실측 0, 온도→실측 26)', swingResync && swingResync[2] === 0 && setpResync && setpResync[2] === 26, JSON.stringify(r.uiUpdates));
  T.check('setter 에러 없음(HomeKit에 전 write 정상 완료로 보고)', r.errLogs().length === 0, JSON.stringify(r.errLogs()));
  r.stop();
}

// ===========================================================================
(async () => {
  const t0 = Date.now();
  await scenarioS1();
  await scenarioS2();
  await scenarioS3();
  await scenarioS4();
  await scenarioS5();
  await scenarioS6();
  await scenarioS7();

  console.log('\n' + '='.repeat(76));
  console.log('결과 요약 (sim_ac_fail — v1.8.25 실패·동시성)');
  console.log('='.repeat(76));
  let totalFail = 0;
  for (const s of scenarios) {
    const fails = s.checks.filter(c => !c.pass);
    totalFail += fails.length;
    console.log(`[${s.id}] ${fails.length === 0 ? 'PASS' : 'FAIL(' + fails.length + ')'} — ${s.title}`);
    for (const f of fails) console.log(`     ✗ ${f.name}${f.extra ? ' — ' + f.extra : ''}`);
  }
  console.log(`\n총 소요 ${(Date.now() - t0) / 1000}s / 체크 ${scenarios.reduce((a, s) => a + s.checks.length, 0)}개 / 실패 ${totalFail}개`);
  process.exit(totalFail === 0 ? 0 : 1);
})().catch(e => { console.error('SIM CRASH:', e); process.exit(2); });
