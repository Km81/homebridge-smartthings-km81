'use strict';
// ============================================================================
// sim_v1829.js — v1.8.29 수정 검증 (REAL code, mocked I/O only)
// ① LegacyACClient.getDeviceStatus(forceFresh): in-flight/캐시 조인 우회
// ② getCachedState(force,0,true): 동시 진행 중 stateRequestPromise 미오염
// ③ _scheduleOffAbsorbVerify: forceFresh 실측으로 stale 'Off' 오흡수 교정 → OFF 재전송
// ④ _scheduleOffAbsorbVerify: 재전송 실패 시 _scheduleOffRetry(백오프) 예약
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
      console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${!cond && extra ? ' — ' + extra : ''}`);
    },
  };
}
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
function recLog() {
  const logs = [];
  return {
    logs,
    info: m => logs.push(String(m)), warn: m => logs.push(String(m)),
    error: (...a) => logs.push(a.join(' ')), debug: () => {},
    has: re => logs.some(l => re.test(l)),
  };
}

// 절연-verify 전용 경량 LegacyAC rig(HAP 없이 prototype 메서드만 구동).
function makeAbsorbRig(opts = {}) {
  const wire = [];
  const log = recLog();
  const o = Object.create(LegacyAC.prototype);
  o.log = log;
  o.name = opts.name || 'AC';
  o.debugMode = false;
  o.deviceIndex = 0; o.setDeviceIndex = 0;
  o.cacheDuration = 30000;
  o.deviceState = { Operation: { power: 'Off' } }; // 흡수된 상태(플러그인이 믿는 값)
  o.lastStateUpdate = Date.now(); o.stateRequestPromise = null;
  o._lastFetchTs = 0; o._lastMutSrc = null;
  o._stateDumpFile = null; o._lastStateDump = 0; o._stateDumpTimer = null;
  o._stopped = false; o._pendingCmdCount = 0; o._cmdMutex = Promise.resolve();
  o._offIntentTs = 0; o._offVerifyTimer = null; o._offRetryTimer = null;
  o._refreshTimer = null; o._onGuardMs = 0; o._onGuardUntil = 0;
  o._powerOnResendGen = 0; o._powerOnModeTimer = null; o._pendingDebounces = new Map();
  o._deferredCommands = new Map();

  // 기기 실측: forceFresh 조회가 반환할 "진짜" 전원. 리모컨/HA가 켠 상태를 흉내.
  let devicePower = opts.devicePower || 'On';
  let sendShouldFail = opts.sendFailTimes || 0;
  o.client = {
    lastStatusTs: 0,
    getDeviceStatus: async (maxAgeMs = 0, forceFresh = false) => {
      wire.push({ kind: 'GET', forceFresh });
      await sleep(20);
      o.client.lastStatusTs = Date.now();
      return { Devices: [{ Operation: { power: devicePower } }] };
    },
    sendCommand: async (idx, ep, data) => {
      wire.push({ kind: 'PUT', ep, data: JSON.stringify(data) });
      await sleep(20);
      if (sendShouldFail > 0) { sendShouldFail--; throw new Error('요청 시간 초과 (500ms)'); }
      devicePower = 'Off';
    },
  };
  return { o, wire, log, setDevicePower(p) { devicePower = p; } };
}

(async () => {
  // ---------------------------------------------------------------------------
  const a = S('A', 'LegacyACClient.getDeviceStatus(forceFresh): in-flight 조인 우회');
  {
    const client = new LegacyACClient('10.99.0.1', 'tok', quietLog, { timeout: 500 });
    let reqN = 0;
    const snaps = [
      new Promise(res => setTimeout(() => res({ Devices: [{ Operation: { power: 'Off' } }] }), 120)), // GET#1 pre-intent, 느림
      Promise.resolve({ Devices: [{ Operation: { power: 'On' } }] }),                                   // GET#2 fresh
    ];
    client._request = async () => snaps[reqN++];

    const p1 = client.getDeviceStatus();          // GET#1 시작(in-flight)
    const pJoin = client.getDeviceStatus();        // 일반 조회 → in-flight 조인(새 요청 X)
    const pFresh = client.getDeviceStatus(0, true); // forceFresh → 조인 거부, 새 GET#2
    const [rJoin, rFresh] = await Promise.all([pJoin, pFresh]);
    await p1;

    a.check('일반 조회는 in-flight에 조인(원시 요청 1회)', reqN === 2, `reqN=${reqN}`);
    a.check('조인 결과 = 낡은 스냅샷(Off)', rJoin.Devices[0].Operation.power === 'Off');
    a.check('forceFresh 결과 = 새 실측(On)', rFresh.Devices[0].Operation.power === 'On');
  }

  // ---------------------------------------------------------------------------
  const b = S('B', 'getCachedState(force,0,true)는 동시 일반 조회 프라미스를 오염시키지 않음');
  {
    const { o } = makeAbsorbRig({ devicePower: 'On' });
    // 느린 일반 조회 하나를 띄우고, 그 진행 중 forceFresh 조회를 동시에 실행.
    let slowResolve;
    const orig = o.client.getDeviceStatus;
    let call = 0;
    o.client.getDeviceStatus = async (maxAgeMs = 0, forceFresh = false) => {
      call++;
      if (!forceFresh) { // 일반 조회: 느리게
        await new Promise(r => { slowResolve = r; });
      } else {
        await sleep(10);
      }
      o.client.lastStatusTs = Date.now();
      return { Devices: [{ Operation: { power: 'On' } }] };
    };
    const pNormal = o.getCachedState(true);            // stateRequestPromise 등록(느림)
    await sleep(5);
    const hadPromise = o.stateRequestPromise != null;
    const pFresh = o.getCachedState(true, 0, true);    // forceFresh: 등록/오염 없이 별도 진행
    await pFresh;                                        // 먼저 끝남
    // async 함수는 반환 프라미스를 새로 래핑하므로 pNormal !== 내부 fetchPromise.
    // 핵심 검증 = forceFresh가 진행 중 일반 조회의 등록을 null로 지우지 않았는지.
    const stillHasNormalPromise = o.stateRequestPromise != null;
    slowResolve && slowResolve();
    await pNormal;
    b.check('일반 조회가 stateRequestPromise 등록', hadPromise);
    b.check('forceFresh 완료 후에도 일반 조회 등록 생존(clobber 없음)', stillHasNormalPromise);
    b.check('일반 조회 정상 완료', o.stateRequestPromise === null);
  }

  // ---------------------------------------------------------------------------
  const c = S('C', '_scheduleOffAbsorbVerify: stale Off 오흡수 → forceFresh 실측 On → OFF 재전송');
  {
    const { o, wire, log } = makeAbsorbRig({ devicePower: 'On' }); // 실제 기기는 켜져 있음
    o._offIntentTs = Date.now();
    o._scheduleOffAbsorbVerify();
    await sleep(2700); // 2s 타이머 + 실측(20ms) + 재전송(sendCommand 300ms 후처리 포함)
    const gets = wire.filter(w => w.kind === 'GET');
    const puts = wire.filter(w => w.kind === 'PUT');
    c.check('강제 실측이 forceFresh로 호출됨', gets.length >= 1 && gets[0].forceFresh === true);
    c.check('실측이 On 확인 → OFF PUT 1건 재전송', puts.length === 1 && /"power":"Off"/.test(puts[0].data), JSON.stringify(puts));
    c.check('자가치유 경고 로그', log.has(/오흡수/));
    c.check('메모리 상태 Off로 보정', o.deviceState.Operation.power === 'Off');
    o.shutdown && o.shutdown();
    o._stopped = true;
    if (o._refreshTimer) clearTimeout(o._refreshTimer);
  }

  // ---------------------------------------------------------------------------
  const d = S('D', '_scheduleOffAbsorbVerify: 재전송 실패 → _scheduleOffRetry 예약');
  {
    const { o, wire, log } = makeAbsorbRig({ devicePower: 'On', sendFailTimes: 1 }); // 첫 OFF PUT 실패
    o._offIntentTs = Date.now();
    o._scheduleOffAbsorbVerify();
    await sleep(2300);
    const afterVerify = wire.filter(w => w.kind === 'PUT').length;
    d.check('재전송 시도(실패) 후 재시도 예약됨', o._offRetryTimer != null || log.has(/재시도 예약/));
    d.check('재전송 실패 로그', log.has(/재전송 실패/));
    // 재시도(5s)까지 대기해 최종 OFF 성사 확인
    await sleep(5200);
    const puts = wire.filter(w => w.kind === 'PUT');
    d.check('백오프 재시도가 OFF 재전송해 최종 성사', puts.length >= 2 && o.deviceState.Operation.power === 'Off', `puts=${puts.length}`);
    o._stopped = true;
    if (o._refreshTimer) clearTimeout(o._refreshTimer);
    if (o._offRetryTimer) clearTimeout(o._offRetryTimer);
  }

  console.log(`\n총 체크 ${total}개 / 실패 ${fail}개`);
  process.exit(fail === 0 ? 0 : 1);
})();
