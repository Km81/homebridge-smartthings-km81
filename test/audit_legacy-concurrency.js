'use strict';
// ============================================================================
// audit_legacy-concurrency.js — LegacyAC 동시성·상태머신 표적 감사 (REAL code)
//
// 기존 sim_* 하네스와 같은 방식: lib/ 원본 프로토타입 메서드를 그대로 구동하고
// I/O(=LegacyACClient._rawRequest, TLS 소켓)만 가짜로 바꾼다. 클라이언트는 **진짜**
// LegacyACClient를 쓴다 — 직렬 큐(_queue)·재시도(_requestWithRetry)·대기자 양보
// (_waiting/yieldToWaiter)·_putSeq 가드가 모두 실제 코드로 돌아야 이 감사가 의미 있음.
//
// 표적 가설 (기존 test/가 건드리지 않는 지점):
//  A. 끄기 흡수 검증(_scheduleOffAbsorbVerify)의 forceFresh GET이 "실패"하면
//     자가치유 OFF 재전송이 조용히 사라지는가? (catch가 return만 함 — 340~345)
//  B. 그 GET 실패가 얼마나 쉽게 일어나는가 — 클라이언트의 대기자 양보(yieldToWaiter)가
//     이 안전 필수 GET에도 적용되어 재시도 3회가 1회로 깎이는가?
//  C. 대조군: 대기자가 없으면 같은 일시적 오류를 재시도가 흡수해 자가치유가 성사되는가?
//  D. 실패 후 다음 폴이 정말 "보정"하는가? (코드 주석의 주장 검증)
//  E. _powerOnResendGen 세대 가드가 체인 진행 중 OFF를 실제로 끊는가? (+민감도 대조군)
//  F. getShared 공유 클라이언트가 단일 커넥션 기기 불변식(동시 raw 요청 ≤ 1)을 지키는가?
//
// 시간축 축소: 없음. LegacyAC의 검증 타이머(2000ms)·재시도 백오프(5s/15s)·체인 지연은
// 원본 상수를 그대로 쓴다. 대신 TLS 왕복만 20~40ms로 축소(실제 LAN은 수십~수백 ms).
// 15s 재시도까지 기다리는 케이스는 5s 1차 재시도까지만 관측하고 명시한다.
// ============================================================================

const path = require('path');
const REPO = path.join(__dirname, '..');
const LegacyAC = require(path.join(REPO, 'lib/accessories/LegacyAC.js'));
const { LegacyACClient } = require(path.join(REPO, 'lib/api/LegacyACClient.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let total = 0, fail = 0;
function S(id, title) {
  console.log(`\n=== [${id}] ${title}`);
  return {
    check(name, cond, extra) {
      total++; if (!cond) fail++;
      console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
    },
    note(m) { console.log(`  ....      ${m}`); },
  };
}
function recLog() {
  const logs = [];
  const push = (...a) => logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  return { logs, info: push, warn: push, error: push, debug: () => {}, has: re => logs.some(l => re.test(l)) };
}

// --- 진짜 LegacyACClient + 가짜 전송층 -------------------------------------
// handler(path, method, data, ctx) → 결과 객체 반환 or throw. ctx.attempt = 이 raw 호출 순번.
function makeClient(handler, log) {
  const client = new LegacyACClient('10.99.0.77', 'tok', log, { timeout: 500 });
  const wire = [];
  let inFlight = 0, maxInFlight = 0;
  client._rawRequest = async (p, method, data) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const rec = { method, path: p, data: data ? JSON.stringify(data) : null, t: Date.now() };
    wire.push(rec);
    try {
      return await handler(p, method, data, { n: wire.length, client, wire });
    } finally { inFlight--; }
  };
  return { client, wire, stats: () => ({ maxInFlight }) };
}

// --- LegacyAC 경량 rig (HAP 없이 프로토타입 메서드만 구동) -------------------
function makeRig(client, opts = {}) {
  const log = recLog();
  const o = Object.create(LegacyAC.prototype);
  o.log = log;
  o.name = opts.name || '거실';
  o.debugMode = false;
  o.deviceIndex = opts.deviceIndex ?? 0;
  o.setDeviceIndex = opts.deviceIndex ?? 0;
  o.cacheDuration = 30000;
  o.deviceState = opts.deviceState || { Operation: { power: 'Off' } };
  o.lastStateUpdate = Date.now();
  o.stateRequestPromise = null;
  o._lastFetchTs = 0; o._lastMutSrc = null;
  o._stateDumpFile = null; o._lastStateDump = 0; o._stateDumpTimer = null;
  o._stopped = false; o._pendingCmdCount = 0; o._cmdMutex = Promise.resolve();
  o._activeInFlight = null;
  o._offIntentTs = 0; o._offVerifyTimer = null; o._offRetryTimer = null;
  o._refreshTimer = null; o._pollFailStreak = 0;
  o._onGuardMs = opts.onGuardMs ?? 0; o._onGuardUntil = 0; o._onGuardTimer = null;
  o._onGuardStrategy = 'drop';
  o._deferredCommands = new Map(); o._pendingDebounces = new Map();
  o._powerOnResendGen = 0; o._powerOnModeTimer = null;
  o._powerOnResendStepMs = 2000;
  o._resendModeOnPowerOn = opts.resendMode === true;
  o._resendAutoCleanOnPowerOn = false; o._resendSwingOffOnPowerOn = false;
  o.coolModeStr = 'DryClean'; o.swingBinding = 'comfort';
  o.client = client;
  o._initialized = true;
  return { o, log };
}
function teardown(o) {
  o._stopped = true;
  for (const k of ['_offVerifyTimer', '_offRetryTimer', '_refreshTimer', '_powerOnModeTimer', '_onGuardTimer', '_stateDumpTimer']) {
    if (o[k]) { clearTimeout(o[k]); o[k] = null; }
  }
  for (const t of o._pendingDebounces.values()) clearTimeout(t);
  o._pendingDebounces.clear();
}

(async () => {

// ===========================================================================
const A = S('A', '끄기 흡수 검증의 forceFresh GET이 실패하면 자가치유 OFF가 사라지는가');
{
  // 상황: HomeKit 끄기 장면 → Active=0. deviceState는 stale 'Off'(리모컨/HA가 방금 켬)라
  // 흡수됨 → _scheduleOffAbsorbVerify. 그런데 검증 GET이 네트워크 오류로 전부 실패.
  const { client, wire } = makeClient(async (p, method) => {
    if (method === 'GET') throw new Error('TLS 소켓 오류: connect ETIMEDOUT 10.99.0.77:8888');
    return {};
  }, recLog());
  const { o, log } = makeRig(client);
  o._offIntentTs = Date.now();          // 끄기 의도 (흡수 직전 마커)
  o._scheduleOffAbsorbVerify();
  // 검증 타이머 2000ms + GET 3회 재시도(1s,2s 백오프) ≈ 3s → 넉넉히 대기
  await sleep(6500);

  const gets = wire.filter(w => w.method === 'GET');
  const puts = wire.filter(w => w.method === 'PUT');
  A.check('검증 GET을 실제로 시도함', gets.length >= 1, `GET ${gets.length}회`);
  A.check('★ GET 전패 → OFF 재전송 PUT 0건', puts.length === 0, `PUT ${puts.length}건`);
  A.check('★ 재시도 타이머도 예약되지 않음(_offRetryTimer=null)', o._offRetryTimer === null);
  A.check('★ 경고/오류 로그 없음(debugLog로만 삼킴)', !log.has(/오흡수|재전송|재시도/),
    log.logs.length ? `로그: ${JSON.stringify(log.logs)}` : '로그 0줄');
  A.note(`실제 raw GET 시도 횟수 = ${gets.length} (재시도 3회 정책)`);
  teardown(o);
}

// ===========================================================================
const B = S('B', '대기자 양보(yieldToWaiter)가 안전필수 검증 GET의 재시도를 1회로 깎는가');
{
  // 형제 액세서리(침실)의 요청이 큐에 하나만 걸려 있으면 _waiting>0 →
  // GET은 첫 실패에서 남은 재시도를 포기한다(_requestWithRetry:154-155).
  const { client, wire } = makeClient(async (p, method, data, ctx) => {
    if (method === 'GET') {
      // 이 GET이 "실행 중"인 동안 형제 요청 하나를 큐에 얹는다 → _waiting = 1
      if (ctx.n === 1) ctx.client._request('PUT', '/devices/1/mode', { modes: ['Cool'] }).catch(() => {});
      await sleep(20);
      throw new Error('TLS 소켓 오류: connect ETIMEDOUT 10.99.0.77:8888');
    }
    await sleep(20);
    return {};
  }, recLog());
  const { o } = makeRig(client);
  o._offIntentTs = Date.now();
  o._scheduleOffAbsorbVerify();
  await sleep(6500);

  const gets = wire.filter(w => w.method === 'GET');
  const offPuts = wire.filter(w => w.method === 'PUT' && /"power":"Off"/.test(w.data || ''));
  B.check('★ 형제 요청이 대기 중이면 검증 GET이 1회만 시도되고 포기', gets.length === 1, `GET ${gets.length}회`);
  B.check('★ 자가치유 OFF 재전송 0건', offPuts.length === 0, `OFF PUT ${offPuts.length}건`);
  B.note('형제(침실) 폴/명령 1건만 큐에 있어도 검증 GET의 재시도 3회 → 1회로 축소됨');
  teardown(o);
}

// ===========================================================================
const C = S('C', '대조군 — 대기자가 없으면 같은 일시적 오류를 재시도가 흡수하고 자가치유 성사');
{
  let getN = 0;
  let devicePower = 'On';   // 실제 기기: 리모컨/HA로 켜져 있음. OFF PUT을 받으면 꺼진다.
  const { client, wire } = makeClient(async (p, method, data) => {
    if (method === 'GET') {
      getN++;
      await sleep(20);
      if (getN === 1) throw new Error('TLS 소켓 오류: connect ETIMEDOUT 10.99.0.77:8888');
      return { Devices: [{ Operation: { power: devicePower } }, { Operation: { power: 'Off' } }] };
    }
    await sleep(20);
    if (data?.Operation?.power === 'Off') devicePower = 'Off';
    return {};
  }, recLog());
  const { o, log } = makeRig(client);
  o._offIntentTs = Date.now();
  o._scheduleOffAbsorbVerify();
  await sleep(6500);

  const offPuts = wire.filter(w => w.method === 'PUT' && /"power":"Off"/.test(w.data || ''));
  C.check('일시적 GET 실패를 재시도가 흡수', getN >= 2, `GET ${getN}회`);
  C.check('실측 On 확인 → 자가치유 OFF 재전송 1건', offPuts.length === 1, `OFF PUT ${offPuts.length}건`);
  C.check('자가치유 경고 로그 존재', log.has(/오흡수/));
  C.check('메모리 상태 Off로 보정', o.deviceState?.Operation?.power === 'Off');
  C.note('B와 C의 유일한 차이 = 큐에 형제 요청이 있었는가. 같은 오류가 한쪽은 복구, 한쪽은 유실.');
  teardown(o);
}

// ===========================================================================
const D = S('D', '검증 실패 후 "다음 폴이 보정"한다는 주석(343행)이 실제로 성립하는가');
{
  let mode = 'fail';
  const { client, wire } = makeClient(async (p, method) => {
    if (method === 'GET') {
      await sleep(20);
      if (mode === 'fail') throw new Error('TLS 소켓 오류: connect ETIMEDOUT 10.99.0.77:8888');
      return { Devices: [{ Operation: { power: 'On' } }] };  // 기기는 여전히 켜져 있음
    }
    await sleep(20);
    return {};
  }, recLog());
  const { o } = makeRig(client);
  o._offIntentTs = Date.now();
  o._scheduleOffAbsorbVerify();
  await sleep(6500);                       // 검증 전패
  mode = 'ok';                              // 네트워크 회복
  await o.getCachedState(true).catch(() => {});   // "다음 폴" 1회
  await sleep(400);

  const puts = wire.filter(w => w.method === 'PUT');
  D.check('회복된 폴이 deviceState를 실측 On으로 갱신', o.deviceState?.Operation?.power === 'On');
  D.check('★ 그러나 OFF를 재전송하는 코드는 없음 → PUT 0건', puts.length === 0, `PUT ${puts.length}건`);
  D.note('결과: 사용자는 "껐다"고 믿지만 기기는 켜진 채로 남고 홈킷 타일만 나중에 켜짐으로 되돌아옴');
  teardown(o);
}

// ===========================================================================
const E = S('E', '_powerOnResendGen 세대 가드가 체인 진행 중 OFF를 끊는가 (+민감도 대조군)');
{
  // E-1 대조군: 취소하지 않으면 체인이 /mode PUT을 실제로 쏜다 (테스트가 민감한지 확인)
  {
    const { client, wire } = makeClient(async (p, method) => {
      await sleep(20);
      if (method === 'GET') return { Devices: [{ Operation: { power: 'On' } }] };
      return {};
    }, recLog());
    const { o } = makeRig(client, { resendMode: true, deviceState: { Operation: { power: 'On' } } });
    o._schedulePowerOnResends();
    await sleep(3200);                       // delay 2100 + 전송
    const modePuts = wire.filter(w => w.method === 'PUT' && /modes/.test(w.data || ''));
    E.check('[대조군] 취소 없으면 모드 재전송 PUT 1건', modePuts.length === 1, `PUT ${modePuts.length}건`);
    teardown(o);
  }
  // E-2: 체인 발사 전에 OFF(_cancelAllPendingWrites)가 들어오면 끊긴다
  {
    const { client, wire } = makeClient(async (p, method) => {
      await sleep(20);
      if (method === 'GET') return { Devices: [{ Operation: { power: 'On' } }] };
      return {};
    }, recLog());
    const { o } = makeRig(client, { resendMode: true, deviceState: { Operation: { power: 'On' } } });
    o._schedulePowerOnResends();
    await sleep(900);
    o._offIntentTs = Date.now();
    o._cancelAllPendingWrites();             // Active=0 경로가 하는 일
    await sleep(3200);
    const modePuts = wire.filter(w => w.method === 'PUT' && /modes/.test(w.data || ''));
    E.check('OFF 후 모드 재전송 PUT 0건 (세대·타이머 취소)', modePuts.length === 0, `PUT ${modePuts.length}건`);
    teardown(o);
  }
  // E-3: 체인이 "전원 Off 재확인" 대기 루프(getCachedState await) 안에 있을 때 OFF가 들어와도 끊기는가
  {
    let power = 'Off';                        // fire()가 재확인 루프로 들어가게
    const { client, wire } = makeClient(async (p, method) => {
      await sleep(60);
      if (method === 'GET') return { Devices: [{ Operation: { power } }] };
      return {};
    }, recLog());
    const { o } = makeRig(client, { resendMode: true, deviceState: { Operation: { power: 'Off' } } });
    o._schedulePowerOnResends();
    await sleep(2300);                        // fire(0) 진입 → 재확인 루프 안
    power = 'On';                             // 기기가 뒤늦게 켜짐 보고
    o._offIntentTs = Date.now();
    o._cancelAllPendingWrites();              // 그 사이 사용자가 OFF
    await sleep(4000);
    const modePuts = wire.filter(w => w.method === 'PUT' && /modes/.test(w.data || ''));
    E.check('재확인 루프 중 OFF → 늦은 continuation이 체인을 되살리지 못함', modePuts.length === 0, `PUT ${modePuts.length}건`);
    teardown(o);
  }
}

// ===========================================================================
const F = S('F', '공유 클라이언트 단일커넥션 불변식 — 두 액세서리 동시 부하에서 raw 동시성 ≤ 1');
{
  const { client, wire, stats } = makeClient(async (p, method) => {
    await sleep(15 + Math.floor(Math.random() * 25));
    if (method === 'GET') return { Devices: [{ Operation: { power: 'On' } }, { Operation: { power: 'Off' } }] };
    return {};
  }, recLog());
  const { o: living } = makeRig(client, { name: '거실', deviceIndex: 0 });
  const { o: bed } = makeRig(client, { name: '침실', deviceIndex: 1 });

  const work = [];
  for (let i = 0; i < 6; i++) {
    work.push(living.getCachedState(true).catch(() => {}));
    work.push(bed.getCachedState(true, 7000).catch(() => {}));
    work.push(living.sendCommand('', { Operation: { power: 'Off' } }).catch(() => {}));
    work.push(bed.sendCommand('/mode', { modes: ['Cool'] }).catch(() => {}));
    work.push(living.getCachedState(true, 0, true).catch(() => {}));  // forceFresh 섞기
  }
  await Promise.all(work);
  await sleep(200);

  F.check('★ 어떤 순간에도 raw 요청 동시 실행 없음', stats().maxInFlight === 1, `maxInFlight=${stats().maxInFlight}`);
  F.check('요청이 실제로 발생했다(빈 검증 아님)', wire.length >= 10, `raw ${wire.length}건`);
  // 시간 겹침 이중 확인: 시작시각이 모두 서로 다른 구간인지(직렬)
  F.check('명령 카운터 누수 없음(_pendingCmdCount=0)',
    living._pendingCmdCount === 0 && bed._pendingCmdCount === 0,
    `거실=${living._pendingCmdCount} 침실=${bed._pendingCmdCount}`);
  teardown(living); teardown(bed);
}

console.log(`\n총 체크 ${total}개 / 실패 ${fail}개`);
process.exit(fail === 0 ? 0 : 1);
})();
