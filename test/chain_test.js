'use strict';
// Adversarial behavioral test of the v1.8.20 power-on resend chain.
// Uses the REAL prototype methods with mocked I/O; real (short) timers.
const path = require('path');
const REPO = path.join(__dirname, '..');
const SmartAC = require(path.join(REPO, 'lib/accessories/SmartAC.js'));
const LegacyACsrc = require('fs').readFileSync(path.join(REPO, 'lib/accessories/LegacyAC.js'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---------- SmartAC harness ----------
function makeSmart(calls) {
  const o = Object.create(SmartAC.prototype);
  o.log = { info: () => {}, warn: (m) => calls.push(['warn', m]), debug: () => {}, error: () => {} };
  o.Characteristic = { On: 'On', LockPhysicalControls: 'Lock' };
  o._state = { power: true, autoClean: true };
  o._powerOnModeTimer = null;
  o._powerOnResendGen = 0;
  o._stopped = false;
  o._resyncTimers = new Map();
  o._stateSeq = new Map();
  o._linkedSwitchServices = { windFree: null, autoClean: { updateCharacteristic: (c, v) => calls.push(['switchUpd', c, v]) } };
  o._mainService = { testCharacteristic: () => true, updateCharacteristic: (c, v) => calls.push(['mainUpd', String(c), v]) };
  o.smartthings = {
    setMode: async (id, m) => { calls.push(['setMode', m]); },
    setAutoClean: async (id, v) => { calls.push(['setAutoClean', v]); },
    getAutoClean: async () => true,
  };
  return o;
}
// shrink timers: monkeypatch is impossible for module consts (2000ms). Use real 2000ms? Too slow x many tests.
// Instead we accept the 2000ms steps but run tests concurrently.

async function smartHappy() {
  console.log('SmartAC #1 happy chain (mode+autoClean, both flags)');
  const calls = [];
  const o = makeSmart(calls);
  const t0 = Date.now();
  const times = {};
  const st = o.smartthings;
  const oldMode = st.setMode, oldAC = st.setAutoClean;
  st.setMode = async (id, m) => { times.mode = Date.now() - t0; return oldMode(id, m); };
  st.setAutoClean = async (id, v) => { times.ac = Date.now() - t0; return oldAC(id, v); };
  o._schedulePowerOnResends('dev', { mode: 'dryClean', autoClean: true, displayName: 'AC' });
  await sleep(5000);
  const seq = calls.filter(c => c[0] === 'setMode' || c[0] === 'setAutoClean').map(c => c[0]);
  check('order mode->autoClean', JSON.stringify(seq) === JSON.stringify(['setMode', 'setAutoClean']), JSON.stringify(calls));
  check('mode at ~2000ms', times.mode >= 1900 && times.mode < 2500, `mode=${times.mode}`);
  check('gap ~2000ms', times.ac - times.mode >= 1900 && times.ac - times.mode < 2600, `gap=${times.ac - times.mode}`);
  check('autoClean payload true', calls.some(c => c[0] === 'setAutoClean' && c[1] === true));
  check('idempotency bypassed (state was already true)', calls.filter(c => c[0] === 'setAutoClean').length === 1);
  check('UI: linked switch updated', calls.some(c => c[0] === 'switchUpd' && c[2] === true));
  check('UI: main Lock updated', calls.some(c => c[0] === 'mainUpd' && c[2] === 1));
  check('resync scheduled for autoClean', o._resyncTimers.has('autoClean'));
  for (const t of o._resyncTimers.values()) clearTimeout(t);
}

async function smartOffMidChain() {
  console.log('SmartAC #2 OFF between mode and autoClean (timer pending)');
  const calls = [];
  const o = makeSmart(calls);
  o._schedulePowerOnResends('dev', { mode: 'dryClean', autoClean: true, displayName: 'AC' });
  await sleep(2500); // mode sent, autoclean timer pending
  // simulate the Active OFF setter's synchronous prefix
  o._powerOnResendGen += 1;
  if (o._powerOnModeTimer) { clearTimeout(o._powerOnModeTimer); o._powerOnModeTimer = null; }
  o._state.power = false;
  await sleep(3500);
  check('mode was sent', calls.some(c => c[0] === 'setMode'));
  check('autoClean NOT sent after OFF', !calls.some(c => c[0] === 'setAutoClean'), JSON.stringify(calls));
  check('no orphan timer', o._powerOnModeTimer === null);
}

async function smartOffDuringSend() {
  console.log('SmartAC #3 OFF while mode send in flight (timer null, .then pending)');
  const calls = [];
  const o = makeSmart(calls);
  let releaseMode;
  o.smartthings.setMode = (id, m) => new Promise(res => { releaseMode = () => { calls.push(['setMode', m]); res(); }; });
  o._schedulePowerOnResends('dev', { mode: 'dryClean', autoClean: true, displayName: 'AC' });
  await sleep(2200); // fire() ran, setMode in flight, _powerOnModeTimer === null
  check('timer is null during send', o._powerOnModeTimer === null);
  // OFF intent arrives now
  o._powerOnResendGen += 1;
  o._state.power = false;
  releaseMode(); // mode send resolves AFTER the gen bump
  await sleep(3000);
  check('autoClean NOT sent (gen killed .then)', !calls.some(c => c[0] === 'setAutoClean'), JSON.stringify(calls));
  check('no timer resurrected by stale .then', o._powerOnModeTimer === null);
}

async function smartRapidOffOn() {
  console.log('SmartAC #4 rapid OFF->ON mid-chain: exactly one fresh chain, no double-fire');
  const calls = [];
  const o = makeSmart(calls);
  let releaseMode1;
  let firstCall = true;
  o.smartthings.setMode = (id, m) => {
    if (firstCall) { firstCall = false; return new Promise(res => { releaseMode1 = () => { calls.push(['setMode', 'gen1']); res(); }; }); }
    calls.push(['setMode', 'gen2']); return Promise.resolve();
  };
  o._schedulePowerOnResends('dev', { mode: 'dryClean', autoClean: true, displayName: 'AC' });
  await sleep(2200); // chain1 mode in flight
  // OFF
  o._powerOnResendGen += 1;
  if (o._powerOnModeTimer) { clearTimeout(o._powerOnModeTimer); o._powerOnModeTimer = null; }
  o._state.power = false;
  // ON again immediately -> new chain
  o._state.power = true;
  o._schedulePowerOnResends('dev', { mode: 'dryClean', autoClean: true, displayName: 'AC' });
  releaseMode1(); // stale chain-1 .then resolves AFTER chain2 scheduled — must not schedule anything
  await sleep(5000);
  const acCount = calls.filter(c => c[0] === 'setAutoClean').length;
  const m2 = calls.filter(c => c[0] === 'setMode' && c[1] === 'gen2').length;
  check('chain2 mode sent once', m2 === 1, JSON.stringify(calls));
  check('autoClean sent exactly once (no double-fire)', acCount === 1, `count=${acCount} calls=${JSON.stringify(calls)}`);
  for (const t of o._resyncTimers.values()) clearTimeout(t);
}

async function smartAutoCleanFail() {
  console.log('SmartAC #5 autoClean API failure -> _state.autoClean left undefined');
  const calls = [];
  const o = makeSmart(calls);
  o.smartthings.setAutoClean = async () => { throw new Error('cloud 500'); };
  o._schedulePowerOnResends('dev', { mode: null, autoClean: true, displayName: 'AC' });
  await sleep(3500);
  check('warn logged', calls.some(c => c[0] === 'warn' && /자동건조/.test(c[1])), JSON.stringify(calls));
  check('_state.autoClean === undefined after failure', o._state.autoClean === undefined,
    `value=${o._state.autoClean} (Lock getter now reads 0 until next poll corrects)`);
}

// ---------- LegacyAC harness (extract class without hap deps) ----------
function makeLegacy(calls, opts = {}) {
  const LegacyAC = require(path.join(REPO, 'lib/accessories/LegacyAC.js'));
  const o = Object.create(LegacyAC.prototype);
  o.log = { info: (m) => calls.push(['info', m]), warn: (m) => calls.push(['warn', m]), error: () => {} };
  o.name = 'AC';
  o.debugMode = false;
  o._stopped = false;
  o.coolModeStr = 'DryClean';
  o._resendModeOnPowerOn = opts.mode !== false;
  o._resendAutoCleanOnPowerOn = opts.autoClean !== false;
  o._powerOnModeTimer = null;
  o._powerOnResendGen = 0;
  o._onGuardMs = 400; // shrink guard for test speed
  o._onGuardUntil = 0;
  o._onGuardTimer = null;
  o._refreshTimer = null;
  o._pendingDebounces = new Map();
  o._deferredCommands = new Map();
  o.deviceState = { Operation: { power: 'On' }, Mode: { modes: ['Auto'], options: ['Autoclean_Off', 'Comode_Nano'] } };
  o.lastStateUpdate = Date.now();
  o.sendCommand = async (ep, data) => { calls.push(['send', ep, JSON.stringify(data)]); };
  o.getCachedState = async () => o.deviceState;
  return o;
}

async function legacyHappy() {
  console.log('LegacyAC #6 happy chain + F7 payload isolation');
  const calls = [];
  const o = makeLegacy(calls);
  const t0 = Date.now();
  o.sendCommand = async (ep, data) => { calls.push(['send', ep, JSON.stringify(data), Date.now() - t0]); };
  o._schedulePowerOnResends();
  await sleep(3500);
  const sends = calls.filter(c => c[0] === 'send');
  check('two sends', sends.length === 2, JSON.stringify(sends));
  check('step1 = modes only', sends[0] && sends[0][2] === '{"modes":["DryClean"]}', sends[0] && sends[0][2]);
  check('step2 = options only (F7: no merge)', sends[1] && sends[1][2] === '{"options":["Autoclean_On"]}', sends[1] && sends[1][2]);
  check('step1 at ~guard+100 (500ms)', sends[0] && sends[0][3] >= 450 && sends[0][3] < 900, sends[0] && String(sends[0][3]));
  check('step2 ~2000ms after step1', sends[1] && (sends[1][3] - sends[0][3]) >= 1950 && (sends[1][3] - sends[0][3]) < 2600, sends[1] && String(sends[1][3] - sends[0][3]));
  check('patch: modes updated', JSON.stringify(o.deviceState.Mode.modes) === '["DryClean"]');
  check('patch: Autoclean_On present, _Off removed, Comode preserved',
    JSON.stringify(o.deviceState.Mode.options) === '["Comode_Nano","Autoclean_On"]', JSON.stringify(o.deviceState.Mode.options));
  check('getter would report lock=1', o.deviceState.Mode.options.includes('Autoclean_On'));
  check('refresh scheduled after last step', o._refreshTimer !== null);
  if (o._refreshTimer) clearTimeout(o._refreshTimer);
}

async function legacyOffMidChain() {
  console.log('LegacyAC #7 HomeKit OFF between steps -> chain dead');
  const calls = [];
  const o = makeLegacy(calls);
  o._schedulePowerOnResends();
  await sleep(900); // step1 (mode) sent at ~500ms; autoclean timer pending
  o._closeOnGuard('user-off');
  o._cancelAllPendingWrites();
  o.deviceState.Operation.power = 'Off';
  await sleep(3000);
  const sends = calls.filter(c => c[0] === 'send');
  check('only mode sent, autoclean cancelled', sends.length === 1 && sends[0][2].includes('modes'), JSON.stringify(sends));
  check('timer cleared', o._powerOnModeTimer === null);
}

async function legacyOffDuringSend() {
  console.log('LegacyAC #8 OFF while step send in flight');
  const calls = [];
  const o = makeLegacy(calls);
  let release;
  o.sendCommand = (ep, data) => new Promise(res => { release = () => { calls.push(['send', ep, JSON.stringify(data)]); res(); }; });
  o._schedulePowerOnResends();
  await sleep(700); // fire ran, mode send in flight, timer null
  check('timer null during send', o._powerOnModeTimer === null);
  o._cancelAllPendingWrites(); // OFF path (gen bump happens even with timer null)
  release();
  await sleep(3000);
  check('stale .then did not schedule step2', o._powerOnModeTimer === null);
  check('no autoclean send', !calls.some(c => c[0] === 'send' && c[2].includes('Autoclean')), JSON.stringify(calls.filter(c => c[0] === 'send')));
}

async function legacyRapidOffOn() {
  console.log('LegacyAC #9 rapid OFF->ON: stale .then vs fresh chain');
  const calls = [];
  const o = makeLegacy(calls);
  let release; let first = true;
  const realSend = async (ep, data, tag) => { calls.push(['send', tag, JSON.stringify(data)]); };
  o.sendCommand = (ep, data) => {
    if (first) { first = false; return new Promise(res => { release = () => { realSend(ep, data, 'gen1').then(res); }; }); }
    return realSend(ep, data, 'gen2');
  };
  o._schedulePowerOnResends();          // chain1
  await sleep(700);                      // chain1 mode in flight
  o._cancelAllPendingWrites();           // OFF
  o._openOnGuard();                      // ON again
  o._schedulePowerOnResends();           // chain2
  release();                             // chain1 .then resolves after chain2 scheduled
  await sleep(4000);
  const gen2sends = calls.filter(c => c[0] === 'send' && c[1] === 'gen2');
  const acSends = calls.filter(c => c[0] === 'send' && c[2].includes('Autoclean'));
  check('chain2 completed mode+autoclean', gen2sends.length === 2, JSON.stringify(gen2sends));
  check('autoclean fired exactly once', acSends.length === 1, JSON.stringify(acSends));
  if (o._refreshTimer) clearTimeout(o._refreshTimer);
}

async function legacyStaleOffRetry() {
  console.log('LegacyAC #10 transient stale Off at step2 -> 1s retry -> proceeds');
  const calls = [];
  const o = makeLegacy(calls);
  o._schedulePowerOnResends();
  await sleep(900); // step1 done at ~500ms; step2 fires at ~2500ms
  o.deviceState.Operation.power = 'Off'; // stale poll wrote Off
  setTimeout(() => { o.deviceState.Operation.power = 'On'; }, 2000); // corrected at ~2900ms, before retry (~3500ms)
  await sleep(5000);
  const acSends = calls.filter(c => c[0] === 'send' && c[2].includes('Autoclean'));
  check('autoclean sent after retry', acSends.length === 1, JSON.stringify(calls.filter(c => c[0] === 'send')));
  if (o._refreshTimer) clearTimeout(o._refreshTimer);
}

async function legacyModeOnly() {
  console.log('LegacyAC #11 regression: only resendModeOnPowerOn (v1.8.19 parity)');
  const calls = [];
  const o = makeLegacy(calls, { autoClean: false });
  let refreshScheduled = false;
  const origSR = o._scheduleRefresh.bind(o);
  o._scheduleRefresh = (...a) => { refreshScheduled = true; return origSR(...a); };
  o._schedulePowerOnResends();
  await sleep(3000);
  const sends = calls.filter(c => c[0] === 'send');
  check('exactly one send: mode', sends.length === 1 && sends[0][2] === '{"modes":["DryClean"]}', JSON.stringify(sends));
  check('refresh scheduled', refreshScheduled);
  check('deviceState patched', JSON.stringify(o.deviceState.Mode.modes) === '["DryClean"]');
  if (o._refreshTimer) clearTimeout(o._refreshTimer);
}

async function legacyBothOff() {
  console.log('LegacyAC #12 both flags off -> pure no-op (no gen bump, no timer)');
  const calls = [];
  const o = makeLegacy(calls, { mode: false, autoClean: false });
  const genBefore = o._powerOnResendGen;
  o._schedulePowerOnResends();
  check('no timer', o._powerOnModeTimer === null);
  check('gen untouched', o._powerOnResendGen === genBefore);
  await sleep(600);
  check('no sends', !calls.some(c => c[0] === 'send'));
}

async function legacyStepFailure() {
  console.log('LegacyAC #13 step1 send failure -> chain stops (autoclean not sent)');
  const calls = [];
  const o = makeLegacy(calls);
  o.sendCommand = async () => { throw new Error('EHOSTUNREACH'); };
  o._schedulePowerOnResends();
  await sleep(3500);
  check('warn logged with step label', calls.some(c => c[0] === 'warn' && /모드/.test(c[1])), JSON.stringify(calls.filter(c => c[0] === 'warn')));
  check('no dangling timer', o._powerOnModeTimer === null);
}

// ---------- v1.8.24 off-scene suppression ----------
async function smartOffSceneSuppress() {
  console.log('SmartAC #14 off-scene window suppresses windFree/autoClean sends');
  const calls = [];
  const o = makeSmart(calls);
  o._state = { power: true, autoClean: false, windFree: false };
  o.smartthings.setWindFree = async (id, v) => { calls.push(['setWindFree', v]); };
  o.smartthings.getWindFree = async () => false;
  // off 의도 직후(장면): 형제 write 억제
  o._offIntentTs = Date.now();
  await o._setWindFree('dev', true, null);
  await o._setAutoClean('dev', true, null);
  check('windFree suppressed in off window', !calls.some(c => c[0] === 'setWindFree'), JSON.stringify(calls));
  check('autoClean suppressed in off window', !calls.some(c => c[0] === 'setAutoClean'), JSON.stringify(calls));
  // 창 밖(4s 경과): 정상 송신 (v1.8.26: OFF_SCENE_SUPPRESS_MS 4000)
  o._offIntentTs = Date.now() - 4500;
  await o._setWindFree('dev', true, null);
  check('windFree sends after window', calls.some(c => c[0] === 'setWindFree' && c[1] === true), JSON.stringify(calls));
  // ON 의도가 마커 해제 → 체인의 자동건조 정상 (마커 0)
  o._offIntentTs = 0;
  o._state.autoClean = undefined;
  await o._setAutoClean('dev', true, null);
  check('autoClean sends after ON clears marker', calls.some(c => c[0] === 'setAutoClean' && c[1] === true), JSON.stringify(calls));
  for (const t of o._resyncTimers.values()) clearTimeout(t);
}

async function legacyOffSceneHelper() {
  console.log('LegacyAC #15 _isOffSceneWindow marker semantics + chain unaffected');
  const calls = [];
  const o = makeLegacy(calls);
  o._offIntentTs = 0;
  check('no marker -> not suppressed', o._isOffSceneWindow() === false);
  o._offIntentTs = Date.now();
  check('fresh off marker -> suppressed', o._isOffSceneWindow() === true);
  o._offIntentTs = Date.now() - 4100;
  check('stale marker (>4s) -> not suppressed', o._isOffSceneWindow() === false);
  // v1.8.25 — 끄기 장면 창 안에서는 체인 예약 자체가 생략된다(형제-먼저 순서의 continuation이
  // off 이후 체인을 재예약하는 유출 차단). 창 밖/마커 해제 시에는 정상 예약.
  o._offIntentTs = Date.now();
  o.deviceState = { Operation: { power: 'On' }, Mode: { modes: ['Auto'], options: [] } };
  o._schedulePowerOnResends();
  check('chain NOT scheduled inside off window', o._powerOnModeTimer === null);
  o._offIntentTs = 0; // ON 의도가 마커 해제
  o._schedulePowerOnResends();
  check('chain scheduled after marker cleared', o._powerOnModeTimer !== null);
  await sleep(3000);
  check('cleared-marker chain sends mode', calls.some(c => c[0] === 'send' && /modes/.test(c[2])), JSON.stringify(calls.filter(c => c[0] === 'send')));
}

// ---------- v1.8.24 LegacyACClient: retry regex + serialization + GET coalescing ----------
async function clientRetryAndCoalesce() {
  console.log('Client #16 timeout retries + GET coalescing + serialization + getShared');
  const { LegacyACClient } = require(path.join(REPO, 'lib/api/LegacyACClient.js'));
  const logs = [];
  const mkLog = { warn: m => logs.push(['warn', m]), error: m => logs.push(['error', m]), info: () => {}, debug: () => {} };

  // (a) 한글 타임아웃 메시지도 재시도된다
  const c1 = new LegacyACClient('10.0.0.1', 't', mkLog, { timeout: 100 });
  let raw = 0;
  c1._rawRequest = async () => {
    raw++;
    if (raw < 3) throw new Error('요청 시간 초과 (5000ms)');
    return { Devices: [{}, {}] };
  };
  const r = await c1.getDeviceStatus();
  check('timeout retried to success (3rd attempt)', raw === 3 && !!r.Devices, `raw=${raw}`);
  check('retry warn logged', logs.some(l => l[0] === 'warn' && /재시도 1\/3/.test(l[1])), JSON.stringify(logs));

  // (b) 동시 GET 병합: 진행 중이면 같은 프라미스 공유
  const c2 = new LegacyACClient('10.0.0.2', 't', mkLog, { timeout: 100 });
  let gets = 0;
  c2._rawRequest = async () => { gets++; await sleep(80); return { Devices: ['a'] }; };
  const [g1, g2, g3] = await Promise.all([c2.getDeviceStatus(), c2.getDeviceStatus(), c2.getDeviceStatus()]);
  check('3 concurrent GETs -> 1 raw request', gets === 1, `gets=${gets}`);
  check('coalesced results identical', g1 === g2 && g2 === g3);
  const gAfter = await c2.getDeviceStatus();
  check('next GET after settle is fresh', gets === 2 && !!gAfter, `gets=${gets}`);

  // (c) 직렬화: 동시 요청이 wire에서는 절대 겹치지 않는다 (FIFO)
  const c3 = new LegacyACClient('10.0.0.3', 't', mkLog, { timeout: 100 });
  let inFlight = 0, maxInFlight = 0;
  const order = [];
  c3._rawRequest = async (p, m) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`${m} start`);
    await sleep(50);
    inFlight--; order.push(`${m} end`);
    return {};
  };
  await Promise.all([c3.sendCommand(0, '/mode', { x: 1 }), c3.getDeviceStatus(), c3.sendCommand(1, '/mode', { y: 1 })]);
  check('never concurrent on the wire', maxInFlight === 1, `max=${maxInFlight} order=${order.join(',')}`);
  check('FIFO order preserved', order[0] === 'PUT start' && order[1] === 'PUT end', order.join(','));

  // (d) 실패해도 큐가 계속 흐른다
  const c4 = new LegacyACClient('10.0.0.4', 't', mkLog, { timeout: 100 });
  let n4 = 0;
  c4._rawRequest = async () => { n4++; if (n4 <= 3) throw new Error('TLS 소켓 오류: connect ECONNREFUSED'); return {}; };
  await c4.sendCommand(0, '/a', {}).catch(() => {});
  const ok = await c4.sendCommand(0, '/b', {}).then(() => true, () => false);
  check('queue survives a failed request', ok === true, `n4=${n4}`);

  // (e) getShared: 같은 IP는 같은 인스턴스(+불일치 경고), 다른 IP는 다른 인스턴스
  const s1 = LegacyACClient.getShared('10.9.9.9', 't', mkLog, { timeout: 100 });
  const s2 = LegacyACClient.getShared('10.9.9.9', 't2', mkLog, { timeout: 200 });
  const s3 = LegacyACClient.getShared('10.9.9.8', 't', mkLog, { timeout: 100 });
  check('same ip -> shared instance', s1 === s2);
  check('mismatch warned', logs.some(l => l[0] === 'warn' && /설정 불일치/.test(l[1])));
  check('different ip -> separate instance', s1 !== s3);

  // (f) 응답 타임아웃('요청 시간 초과')은 PUT에서는 재시도하지 않는다 (중복 '띠' 방지)
  const c5 = new LegacyACClient('10.0.0.5', 't', mkLog, { timeout: 100 });
  let puts = 0;
  c5._rawRequest = async () => { puts++; throw new Error('요청 시간 초과 (5000ms)'); };
  const putFailed = await c5.sendCommand(0, '/mode', {}).then(() => false, () => true);
  check('PUT timeout: single attempt, no retry', putFailed && puts === 1, `puts=${puts}`);
  // 연결 실패(ECONNREFUSED)는 명령 미적용 확실 → PUT도 재시도
  const c6 = new LegacyACClient('10.0.0.6', 't', mkLog, { timeout: 100 });
  let puts6 = 0;
  c6._rawRequest = async () => { puts6++; if (puts6 < 2) throw new Error('TLS 소켓 오류: connect ECONNREFUSED'); return {}; };
  const putOk = await c6.sendCommand(0, '/mode', {}).then(() => true, () => false);
  check('PUT connect-failure retried to success', putOk && puts6 === 2, `puts6=${puts6}`);
}

// ---------- v1.8.26 ----------
async function clientMaxAgeCache() {
  console.log('Client #17 maxAge 상태 캐시(폴 공유) + PUT 무효화 + 신선도');
  const { LegacyACClient } = require(path.join(REPO, 'lib/api/LegacyACClient.js'));
  const log = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
  const c = new LegacyACClient('10.0.1.1', 't', log, { timeout: 100 });
  let gets = 0, puts = 0;
  c._rawRequest = async (p, m) => {
    if (m === 'GET') { gets++; return { Devices: [{ n: gets }] }; }
    puts++; return {};
  };
  const a = await c.getDeviceStatus(5000);
  const b = await c.getDeviceStatus(5000);
  check('maxAge 내 2번째 폴은 캐시 서빙(원시 GET 1회)', gets === 1, `gets=${gets}`);
  check('캐시 서빙은 새 객체(공유 변형 오염 없음)', a !== b && b.Devices[0].n === 1);
  check('lastStatusTs 기록', c.lastStatusTs > 0);
  await c.getDeviceStatus(); // maxAge 0 = 강제 실측
  check('maxAge=0은 항상 실측', gets === 2, `gets=${gets}`);
  await c.sendCommand(0, '/mode', { x: 1 });
  await c.getDeviceStatus(5000);
  check('PUT이 캐시 무효화 → 직후 폴은 실측', gets === 3 && puts === 1, `gets=${gets} puts=${puts}`);

  // v1.8.26 리뷰 반영 — GET 진행 중 PUT이 끼면 그 GET 결과(명령 이전)를 캐시에 넣지 않는다
  const c2 = new LegacyACClient('10.0.1.9', 't', log, { timeout: 100 });
  let g2 = 0;
  c2._rawRequest = async (p, m) => {
    if (m === 'GET') { g2++; await sleep(120); return { Devices: [{ n: g2 }] }; }
    return {};
  };
  const slowGet = c2.getDeviceStatus();     // GET 시작(느림)
  await sleep(20);
  const putP = c2.sendCommand(0, '/mode', { y: 1 }); // GET 완료 전 PUT 큐잉(seq 증가)
  await slowGet; await putP;
  check('in-flight GET은 PUT 이후 캐시 재오염 금지(_putSeq)', c2._statusCache === null, JSON.stringify(c2._statusCache));
  await c2.getDeviceStatus(5000);
  check('그 다음 폴은 실측(캐시 없음)', g2 === 2, `g2=${g2}`);
}

async function clientWaiterYield() {
  console.log('Client #18 무응답 중 대기자 양보(GET 재시도 중단 → PUT 신속 처리)');
  const { LegacyACClient } = require(path.join(REPO, 'lib/api/LegacyACClient.js'));
  const logs = [];
  const log = { warn: m => logs.push(['warn', m]), error: m => logs.push(['error', m]), info: m => logs.push(['info', m]), debug: () => {} };
  const c = new LegacyACClient('10.0.1.2', 't', log, { timeout: 100 });
  let gets = 0, puts = 0;
  c._rawRequest = async (p, m) => {
    await sleep(80);
    if (m === 'GET') { gets++; throw new Error('요청 시간 초과 (100ms)'); }
    puts++; return {};
  };
  const t0 = Date.now();
  const gp = c.getDeviceStatus().catch(() => {});
  await sleep(30); // GET attempt1 진행 중에 PUT이 큐에 도착
  await c.sendCommand(0, '/mode', { x: 1 });
  const putDelay = Date.now() - t0;
  await gp;
  check('GET가 양보(원시 GET 1회로 중단)', gets === 1, `gets=${gets}`);
  check('PUT 신속 처리(재시도 사이클 대기 없음, <1.2s)', putDelay < 1200, `delay=${putDelay}ms`);
  check('양보 사유 로그', logs.some(l => /양보/.test(l[1])), JSON.stringify(logs.slice(0, 3)));
}

async function smartOffRetry() {
  console.log('SmartAC #19 끄기 실패 → 5초 뒤 1회 재시도 / ON 의도 시 취소');
  const calls = [];
  const o = makeSmart(calls);
  o.Characteristic = { Active: 'Active', CurrentHeaterCoolerState: { INACTIVE: 0 } };
  o._offRetryTimer = null;
  o._offIntentTs = Date.now(); // 방금 off 의도(전송 실패했다고 가정)
  o.smartthings.setPower = async (id, v) => { calls.push(['setPower', v]); };
  const svc = { displayName: '승준', updateCharacteristic: (ch, v) => calls.push(['upd', String(ch), v]) };
  o._scheduleOffRetry('dev', svc);
  await sleep(5600);
  check('재시도가 setPower(false) 전송', calls.some(c => c[0] === 'setPower' && c[1] === false), JSON.stringify(calls));
  check('UI Active->0 반영', calls.some(c => c[0] === 'upd' && c[1] === 'Active' && c[2] === 0), JSON.stringify(calls));
  // ON 의도가 끼어들면 재시도 포기
  const calls2 = [];
  const o2 = makeSmart(calls2);
  o2.Characteristic = o.Characteristic;
  o2._offRetryTimer = null;
  o2._offIntentTs = Date.now();
  o2.smartthings.setPower = async () => { calls2.push(['setPower']); };
  o2._scheduleOffRetry('dev', svc);
  o2._offIntentTs = 0; // ON 의도 도착
  await sleep(5600);
  check('ON 의도가 재시도 취소(전송 0)', !calls2.some(c => c[0] === 'setPower'), JSON.stringify(calls2));
}

(async () => {
  // run sequentially to keep timing clean
  await smartHappy();
  await smartOffMidChain();
  await smartOffDuringSend();
  await smartRapidOffOn();
  await smartAutoCleanFail();
  await legacyHappy();
  await legacyOffMidChain();
  await legacyOffDuringSend();
  await legacyRapidOffOn();
  await legacyStaleOffRetry();
  await legacyModeOnly();
  await legacyBothOff();
  await legacyStepFailure();
  await smartOffSceneSuppress();
  await legacyOffSceneHelper();
  await clientRetryAndCoalesce();
  await clientMaxAgeCache();
  await clientWaiterYield();
  await smartOffRetry();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
