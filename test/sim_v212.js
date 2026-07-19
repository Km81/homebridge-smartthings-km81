'use strict';
/**
 * sim_v212.js — v2.1.2 수정 2건 표적 검증
 *
 * #1 LegacyAC 끄기 흡수 검증(absorb-verify) 실측 실패 시:
 *    - 기존(v2.1.1): catch가 debugLog 한 줄 남기고 영구 포기 → 오흡수가 무음으로 남음
 *    - 수정(v2.1.2): 실측을 2s→5s→15s 재시도. OFF는 실측 '켜짐' 확인 후에만 전송('띠' 무발생 유지).
 *      3회 전패 시 log.warn으로 가시화.
 * #2 SmartAC OFF in-flight 중 ON 탭:
 *    - 기존(v2.1.1): _state.power가 아직 true라 멱등 생략 → ON이 클라우드에 안 나감
 *    - 수정(v2.1.2): _powerInFlight === false(OFF 전송 중)면 생략하지 않고 ON 전송.
 *
 * 방식: 기존 하네스(sim_v1829.js 등)와 동일 — Object.create(prototype)로 실제 메서드 사용,
 * 클라이언트만 스텁. lib/ 소스는 수정하지 않는다.
 */
const path = require('path');
const LegacyAC = require(path.join(__dirname, '..', 'lib', 'accessories', 'LegacyAC.js'));


let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeLogs() {
  const logs = { warn: [], info: [], error: [], debug: [] };
  const log = {
    warn: (...a) => logs.warn.push(a.join(' ')),
    info: (...a) => logs.info.push(a.join(' ')),
    error: (...a) => logs.error.push(a.join(' ')),
    debug: (...a) => logs.debug.push(a.join(' ')),
  };
  return { logs, log };
}

// ---------- #1 LegacyAC absorb-verify 실측 실패 재시도 ----------
function makeVerifyRig({ getBehavior }) {
  // getBehavior(callIndex) → 'fail' | 'On' | 'Off'
  const { logs, log } = makeLogs();
  const o = Object.create(LegacyAC.prototype);
  o.name = '침실';
  o.log = log;
  o.debugMode = false;
  o.debugLog = (...a) => logs.debug.push(a.join(' '));
  o._stopped = false;
  o._offIntentTs = Date.now();
  o._offVerifyTimer = null;
  o._offRetryTimer = null;
  o._pendingDebounces = new Map();
  o.deviceState = { Operation: { power: 'Off' } }; // stale 'Off' (오흡수 상황)
  o._lastFetchTs = 0;
  let getCalls = 0;
  const puts = [];
  o.getCachedState = async (force, maxAgeMs, forceFresh) => {
    const i = getCalls++;
    const b = getBehavior(i);
    if (b === 'fail') throw new Error('ETIMEDOUT');
    o.deviceState = { Operation: { power: b } };
    o._lastFetchTs = Date.now();
    return o.deviceState;
  };
  o.sendCommand = async (ep, body) => { puts.push(body); };
  o._patchState = (fn) => fn(o.deviceState);
  o._scheduleRefresh = () => {};
  o._scheduleOffRetry = () => { logs.warn.push('__OFF_RETRY_CALLED__'); };
  return { o, logs, puts, getCallCount: () => getCalls };
}

async function test1() {
  console.log('\n[1] 실측 1회 실패 → 재시도에서 On 확인 → OFF 재전송(자가치유 생존)');
  const rig = makeVerifyRig({ getBehavior: i => (i === 0 ? 'fail' : 'On') });
  rig.o._scheduleOffAbsorbVerify();
  await sleep(2400);            // attempt1(2s) 실패
  check('1차 실패 후 OFF 미전송(성급한 재전송 없음)', rig.puts.length === 0);
  check('재시도 예약됨(타이머 존재)', rig.o._offVerifyTimer !== null);
  await sleep(4000);            // t≈6.4s — attempt2 지연(5s=7.0s 발화) 도래 전
  check('★재시도 간격 준수: 5초 지연 전엔 실측 미발사(GET 1회 유지)', rig.getCallCount() === 1);
  await sleep(1400);            // t≈7.8s — attempt2(2.0s+5s≈7.0s) 발화 후
  check('실측 On 확인 후 OFF 1건 전송', rig.puts.length === 1 && rig.puts[0]?.Operation?.power === 'Off');
  check('오흡수 자가치유 warn 로그', rig.logs.warn.some(w => w.includes("실측 '켜짐'")));
  check('GET 2회(1실패+1성공) — 과잉 호출 없음', rig.getCallCount() === 2);
}

async function test2() {
  console.log('\n[2] 실측 3회 전패 → log.warn 가시화 + OFF 0건(무조건 재전송 안 함 = 띠 안전)');
  const rig = makeVerifyRig({ getBehavior: () => 'fail' });
  rig.o._scheduleOffAbsorbVerify();
  await sleep(2000 + 5000 + 15000 + 1500);
  check('OFF 전송 0건(실측 미확인 상태로는 절대 안 쏨)', rig.puts.length === 0);
  check('최종 실패가 기본 로그(warn)에 가시화', rig.logs.warn.some(w => w.includes('모두 실패')));
  check('_scheduleOffRetry로 우회하지 않음(띠 방지)', !rig.logs.warn.includes('__OFF_RETRY_CALLED__'));
  check('GET 3회 시도(2s→5s→15s)', rig.getCallCount() === 3);
  check('재시도 소진 후 타이머 정리', rig.o._offVerifyTimer === null);
}

async function test3() {
  console.log('\n[3] 실측 실패 재시도 중 ON 의도 개입 → 재시도 중단(기존 가드 유지)');
  const rig = makeVerifyRig({ getBehavior: () => 'fail' });
  rig.o._scheduleOffAbsorbVerify();
  await sleep(2400);            // attempt1 실패, attempt2 예약됨
  rig.o._offIntentTs = 0;       // ON 의도 개입
  await sleep(5400);
  check('ON 개입 후 GET 추가 호출 없음', rig.getCallCount() === 1);
  check('OFF 전송 0건', rig.puts.length === 0);
}

async function test4() {
  console.log('\n[4] 회귀: 실측이 정상이고 진짜 꺼져 있으면 아무 것도 안 함(기존 무음 흡수 유지)');
  const rig = makeVerifyRig({ getBehavior: () => 'Off' });
  rig.o._scheduleOffAbsorbVerify();
  await sleep(2400);
  check('OFF 전송 0건(띠 없음)', rig.puts.length === 0);
  check('warn 로그 0건', rig.logs.warn.length === 0);
  check('재시도 미예약(성공 실측이므로)', rig.o._offVerifyTimer === null);
}

async function test5() {
  console.log('\n[5] 회귀: 실측이 첫 시도에 On이면 즉시 재전송(v1.8.29 동작 보존)');
  const rig = makeVerifyRig({ getBehavior: () => 'On' });
  rig.o._scheduleOffAbsorbVerify();
  await sleep(2400);
  check('OFF 1건 즉시 전송', rig.puts.length === 1);
  check('GET 1회', rig.getCallCount() === 1);
}

// ---------- #2 SmartAC OFF in-flight 중 ON ----------
// SmartAC는 setupCharacteristics 전체를 띄우기엔 HAP 의존이 커서, 수정된 setter 로직과
// 동일한 형태를 프로토타입 없이 재구성하지 않고 — 실제 파일의 setter를 직접 구동한다.
const SmartAC = require(path.join(__dirname, '..', 'lib', 'accessories', 'SmartAC.js'));

function makeSmartRig({ offDelayMs }) {
  const { logs, log } = makeLogs();
  const o = Object.create(SmartAC.prototype);
  o.log = log;
  o._state = { power: true };
  o._offIntentTs = 0;
  o._powerOnResendGen = 0;
  o._powerOnModeTimer = null;
  o._offRetryTimer = null;
  o._powerInFlight = null;
  o._stopped = false;
  const posts = [];
  o.smartthings = {
    setPower: async (id, target) => {
      posts.push({ target, ts: Date.now() });
      await sleep(target === false ? offDelayMs : 30);
    },
  };
  o._scheduleOffRetry = () => {};
  o._schedulePowerOnResends = () => {};
  o._scheduleResync = () => {};
  return { o, logs, posts };
}

// 수정된 setter 본문과 동일 로직을 파일에서 직접 추출해 실행하는 대신,
// 핵심 분기(멱등 가드 + in-flight 세팅/해제)를 실제 소스 코드 문자열로 검증한 뒤
// 동작 시뮬레이션은 로직 등가 재구성으로 수행한다.
const fs = require('fs');
const smartSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'accessories', 'SmartAC.js'), 'utf8');

async function test6() {
  console.log('\n[6] 소스 검증: 수정이 실제 코드에 존재');
  check('멱등 가드가 _powerInFlight !== false 조건 포함', /target && this\._state\.power === true && this\._powerInFlight !== false/.test(smartSrc));
  check('전송 전 _powerInFlight = target 세팅', /this\._powerInFlight = target;\s*\n\s*try \{\s*\n\s*await this\.smartthings\.setPower/.test(smartSrc));
  check('finally에서 같은 방향만 해제', /finally \{[\s\S]{0,300}?if \(this\._powerInFlight === target\) this\._powerInFlight = null;/.test(smartSrc));
  check('생성자에서 _powerInFlight = null 초기화', /this\._powerInFlight = null;/.test(smartSrc));
}

// setter 로직 등가 재구성(수정 후 코드와 1:1 — 소스 검증은 test6이 담당)
function makeSetter(rig) {
  return async (value) => {
    const target = value === 1;
    rig.o._offIntentTs = target ? 0 : Date.now();
    if (target && rig.o._state.power === true && rig.o._powerInFlight !== false) {
      rig.logs.debug.push('멱등 생략');
      return;
    }
    if (!target) rig.o._powerOnResendGen += 1;
    rig.o._powerInFlight = target;
    try {
      await rig.o.smartthings.setPower('dev1', target);
    } catch (e) {
      throw e;
    } finally {
      if (rig.o._powerInFlight === target) rig.o._powerInFlight = null;
    }
    rig.o._state.power = target;
  };
}

async function test7() {
  console.log('\n[7] OFF in-flight 중 ON 탭 → ON이 클라우드로 전송됨(v2.1.1에선 삼켜지던 케이스)');
  const rig = makeSmartRig({ offDelayMs: 300 });
  const setter = makeSetter(rig);
  const pOff = setter(0);           // OFF 시작(300ms 소요)
  await sleep(50);                  // OFF in-flight 창
  check('OFF in-flight 마커', rig.o._powerInFlight === false);
  const pOn = setter(1);            // 그 창에서 ON 탭
  await Promise.all([pOff, pOn]);
  const onSent = rig.posts.filter(p => p.target === true).length;
  const offSent = rig.posts.filter(p => p.target === false).length;
  check('ON 전송 1건(삼켜지지 않음)', onSent === 1);
  check('OFF 전송 1건(정상)', offSent === 1);
  check('멱등 생략 미발동', !rig.logs.debug.includes('멱등 생략'));
  check('완료 후 in-flight 해제', rig.o._powerInFlight === null);
}

async function test8() {
  console.log('\n[8] 회귀: in-flight 없이 이미 켜진 기기의 ON 탭 → 여전히 멱등 생략(스팸 방지 유지)');
  const rig = makeSmartRig({ offDelayMs: 300 });
  const setter = makeSetter(rig);
  await setter(1);                  // power=true, in-flight 없음
  check('멱등 생략 발동', rig.logs.debug.includes('멱등 생략'));
  check('전송 0건', rig.posts.length === 0);
}

async function test9() {
  console.log('\n[9] 회귀: ON in-flight 중 OFF → OFF는 원래 항상 전송(변화 없음) + finally 방향 보존');
  const rig = makeSmartRig({ offDelayMs: 30 });
  const setter = makeSetter(rig);
  rig.o._state.power = false;
  const pOn = setter(1);            // ON 시작(30ms)
  await sleep(5);
  const pOff = setter(0);           // ON in-flight 중 OFF
  await Promise.all([pOn, pOff]);
  check('ON 1건 + OFF 1건 전송', rig.posts.length === 2);
  check('완료 후 in-flight 해제', rig.o._powerInFlight === null);
}

(async () => {
  const t0 = Date.now();
  await test1();
  await test2();
  await test3();
  await test4();
  await test5();
  await test6();
  await test7();
  await test8();
  await test9();
  console.log(`\n총 소요 ${((Date.now() - t0) / 1000).toFixed(1)}s / 체크 ${pass + fail}개 / 실패 ${fail}개`);
  process.exit(fail > 0 ? 1 : 0);
})();
