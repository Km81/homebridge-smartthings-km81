'use strict';
// audit_log-regression.js
// 표적: v2.0.0 → v2.1.1 "로그 표기 개편, 제어 로직 무변경" 주장 검증.
// 기존 test/ 스타일과 동일: 실제 프로토타입 메서드 + I/O만 mock + 실타이머.
//
// 시간축 축소 내역 (실축소한 것만 명시):
//  - sendCommand 내부의 setTimeout(…, 1500) 재무효화만 실제 1500ms를 기다린다(T1에서 1회, 총 ~1.7s).
//    그 외 대기 없음. getStatus 스트릭(10회)은 mock이 즉시 resolve/reject 하므로 실시간 소요 ~0ms.
//  - lib/ 소스는 읽기 전용. 상수·타이머 상수 패치 없음.

const path = require('path');
const REPO = path.join(__dirname, '..');
const SmartThingsClient = require(path.join(REPO, 'lib/api/SmartThingsClient.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const AC_ID = '11111111-2222-3333-4444-555555555555';   // 승준 에어컨
const WASH_ID = '99999999-8888-7777-6666-555555555555'; // 세탁기

// ---------- harness ----------
// 실제 생성자는 axios/파일I/O를 건드리므로 프로토타입만 재사용하고 필드를 직접 채운다
// (chain_test.js / sim_v1829.js 와 동일한 Object.create 방식).
function makeClient(opts = {}) {
  const logs = [];
  const c = Object.create(SmartThingsClient.prototype);
  const mkLog = lvl => (...a) => logs.push([lvl, a.map(x => (typeof x === 'string' ? x : String(x))).join(' ')]);
  c.log = { info: mkLog('info'), warn: mkLog('warn'), error: mkLog('error') };
  if (!opts.noDebug) c.log.debug = mkLog('debug');
  // LRUCache 대체 (get/set/delete 동일 시그니처만 사용됨)
  const store = new Map();
  c.cache = {
    get: k => store.get(k),
    set: (k, v) => store.set(k, v),
    delete: k => { logs.push(['cacheDel', k]); return store.delete(k); },
    _store: store,
  };
  c.statusPromises = new Map();
  c._statusFailStreaks = new Map();
  c._deviceLabels = new Map();
  c._lastNonOffCmdTs = new Map();
  c.client = {
    post: async (url, body, cfg) => {
      logs.push(['POST', url, JSON.stringify(body), JSON.stringify({ _deviceId: cfg?._deviceId, hasSentAt: !!cfg?._sentAt })]);
      if (opts.postFail) throw opts.postFail;
      return { data: {} };
    },
    get: async (url) => {
      logs.push(['GET', url]);
      if (opts.getFail) throw opts.getFail;
      return { data: { components: { main: { switch: { switch: { value: 'on' } } } } } };
    },
  };
  c._logs = logs;
  return c;
}
const lines = c => c._logs.filter(l => ['info', 'warn', 'error', 'debug'].includes(l[0]));
const txt = c => lines(c).map(l => `${l[0]}|${l[1]}`);

function axiosErr(status, data, msg) {
  const e = new Error(msg || 'Request failed with status code ' + status);
  e.response = { status, data };
  return e;
}

// ================= T1 =================
// 성공 경로: v2.1.1이 try 블록 안에 새 포매터를 넣었다. POST 전후 순서·부수효과가
// v1.8.29와 동일한지(캐시 무효화 2회, POST 바디 무변경, throw 없음) 확인.
async function T1() {
  console.log('T1 sendCommand 성공 경로 — 순서/부수효과/POST 바디');
  const c = makeClient();
  c.registerDeviceLabel(AC_ID, '승준 에어컨');
  const t0 = Date.now();
  await c.setPower(AC_ID, false);
  const seq = c._logs.map(l => l[0]);
  check('POST 이전에 캐시 무효화', seq.indexOf('cacheDel') >= 0 && seq.indexOf('cacheDel') < seq.indexOf('POST'));
  const post = c._logs.find(l => l[0] === 'POST');
  check('POST 바디 = {commands:[{switch off}]}',
    post[2] === JSON.stringify({ commands: [{ component: 'main', capability: 'switch', command: 'off' }] }), post[2]);
  check('POST config에 _deviceId/_sentAt 유지 (off 재시도 가드)',
    post[3] === JSON.stringify({ _deviceId: AC_ID, hasSentAt: true }), post[3]);
  check('성공 로그 = "[승준 에어컨] 전송: 전원 → 꺼짐"',
    txt(c).includes('info|[승준 에어컨] 전송: 전원 → 꺼짐'), JSON.stringify(txt(c)));
  check('off 명령은 _lastNonOffCmdTs 미기록 (재시도 허용 유지)', !c._lastNonOffCmdTs.has(AC_ID));
  // 1500ms 지연 재무효화 — 이 테스트에서 유일하게 실제 대기하는 구간
  const before = c._logs.filter(l => l[0] === 'cacheDel').length;
  await sleep(1700);
  const after = c._logs.filter(l => l[0] === 'cacheDel').length;
  check('1500ms 후 2차 캐시 무효화 발화', after === before + 1, `${before}→${after}`);
  console.log(`  (T1 실대기 ${Date.now() - t0}ms)`);
}

// ================= T2 =================
// v2.1.1 신규 _fmtCommand — 실제 5개 헬퍼가 만드는 명령 전수 + 미지 명령 폴백.
async function T2() {
  console.log('T2 _fmtCommand 매핑 (실제 헬퍼 5종 + 폴백)');
  const cases = [
    ['setPower on', c => c.setPower(AC_ID, true), '전원 → 켜짐'],
    ['setPower off', c => c.setPower(AC_ID, false), '전원 → 꺼짐'],
    ['setMode cool', c => c.setMode(AC_ID, 'cool'), '모드 → 냉방'],
    ['setTemperature 24', c => c.setTemperature(AC_ID, 24), '설정온도 → 24°C'],
    ['setWindFree true', c => c.setWindFree(AC_ID, true), '무풍 → 켜짐'],
    ['setWindFree false', c => c.setWindFree(AC_ID, false), '무풍 → 꺼짐'],
    ['setAutoClean true', c => c.setAutoClean(AC_ID, true), '자동건조 → 켜짐'],
    ['setAutoClean false', c => c.setAutoClean(AC_ID, false), '자동건조 → 꺼짐'],
  ];
  for (const [name, fn, expect] of cases) {
    const c = makeClient();
    c.registerDeviceLabel(AC_ID, '승준 에어컨');
    await fn(c);
    check(name, txt(c).includes(`info|[승준 에어컨] 전송: ${expect}`), JSON.stringify(txt(c).filter(t => t.startsWith('info'))));
  }
  // 미지 명령 폴백 + 다중 명령 join
  const c = makeClient();
  await c.sendCommand(AC_ID, [
    { component: 'main', capability: 'custom.spiMode', command: 'setSpiMode', arguments: ['on', 2] },
    { component: 'main', capability: 'switch', command: 'on' },
  ]);
  check('미지 capability 폴백 + 다중 join',
    txt(c).some(t => t.includes('custom.spiMode.setSpiMode(on, 2), 전원 → 켜짐')), JSON.stringify(txt(c)));
  // 모드 매핑에 없는 값 → undefined 노출 여부
  const c2 = makeClient();
  await c2.setMode(AC_ID, 'sleep');
  check('미지 모드값은 원문 노출(‘undefined’ 아님)',
    txt(c2).some(t => t.includes('모드 → sleep')), JSON.stringify(txt(c2)));
}

// ================= T3 =================
// v2.1.0 라벨. 등록 전에는 UUID 노출(= index.js가 등록 못 한 기기는 로그 가독성 회귀).
async function T3() {
  console.log('T3 _labelOf 라벨/UUID 폴백');
  const c = makeClient();
  await c.setPower(WASH_ID, true);                       // 미등록
  c.registerDeviceLabel(WASH_ID, '세탁기');
  await c.setPower(WASH_ID, false);                      // 등록 후
  check('미등록 → UUID 노출', txt(c).some(t => t.includes(`[${WASH_ID}] 전송`)));
  check('등록 후 → 라벨 노출', txt(c).some(t => t.includes('[세탁기] 전송')));
  c.registerDeviceLabel(WASH_ID, '');                    // 빈 라벨 무시되는지
  check('빈 라벨은 기존 등록을 덮어쓰지 않음', c._labelOf(WASH_ID) === '세탁기', c._labelOf(WASH_ID));
}

// ================= T4 =================
// B4 회귀: getStatus 실패 스트릭 로그 강등이 (a) 기기별로 격리되는지
// (b) 반환/throw/캐시/statusPromises 계약을 바꾸지 않는지.
async function T4() {
  console.log('T4 getStatus 스트릭 억제 — 기기 격리 + 계약 불변');
  const c = makeClient({ getFail: new Error('socket hang up') });
  const levels = [];
  for (let i = 1; i <= 11; i++) {
    try { await c.getStatus(AC_ID); } catch (e) {
      if (i === 1) check('throw 메시지 계약 불변', e.message === `[${AC_ID}] 상태 조회에 실패했습니다.`, e.message);
    }
    levels.push(lines(c).slice(-1)[0][0]);
  }
  check('1회=error, 2~9=debug, 10=warn, 11=debug',
    levels.join(',') === 'error,debug,debug,debug,debug,debug,debug,debug,debug,warn,debug', levels.join(','));
  check('실패 시 statusPromises 누수 없음', c.statusPromises.size === 0, String(c.statusPromises.size));
  check('실패는 캐시에 적재되지 않음', c.cache._store.size === 0, String(c.cache._store.size));

  // 기기 격리: AC가 10연속 실패 중이어도 세탁기의 첫 실패는 error여야 한다
  const before = lines(c).length;
  try { await c.getStatus(WASH_ID); } catch { /* expected */ }
  check('다른 기기의 첫 실패는 여전히 error (Map 기기별 키)',
    lines(c)[before][0] === 'error' && lines(c)[before][1].includes(WASH_ID), JSON.stringify(lines(c)[before]));

  // 복구 로그 + 스트릭 리셋
  c.client.get = async () => ({ data: { components: { main: {} } } });
  const n = lines(c).length;
  await c.getStatus(AC_ID);
  check('복구 로그 info + 연속 횟수 표기',
    lines(c)[n][0] === 'info' && /상태 조회 복구 — 연속 11회 실패 후 정상화/.test(lines(c)[n][1]), JSON.stringify(lines(c)[n]));
  check('복구 후 스트릭 삭제', !c._statusFailStreaks.has(AC_ID));
  const n2 = lines(c).length;
  await c.getStatus(AC_ID);
  check('연속 성공은 복구 로그 재출력 안 함', lines(c).length === n2);
  check('성공은 캐시 적재', c.cache._store.has(`status-${AC_ID}`));
}

// ================= T5 =================
// ★ 실제 결함 후보: v2.0.0이 넣은 SmartThingsClient.js:351 은 코드베이스에서 유일하게
// 옵셔널 호출(`debug?.`)이 아닌 `this.log.debug(...)` 이다. debug 없는 로거에서
// .catch() 핸들러 자체가 TypeError로 터져 계약된 에러 메시지가 소실되는지 실측한다.
async function T5() {
  console.log('T5 log.debug 미보유 로거 — getStatus 2회차 (v2.0.0 신규 라인 351)');
  const c = makeClient({ noDebug: true, getFail: new Error('ETIMEDOUT') });
  let e1 = null, e2 = null;
  try { await c.getStatus(AC_ID); } catch (e) { e1 = e; }
  check('1회차(error 경로)는 정상 — 계약 메시지 유지',
    e1 && e1.message === `[${AC_ID}] 상태 조회에 실패했습니다.`, e1 && e1.message);
  try { await c.getStatus(AC_ID); } catch (e) { e2 = e; }
  console.log(`    2회차 실제 rejection: ${e2 && e2.constructor.name}: ${e2 && e2.message}`);
  // 현재 동작을 기준선으로 고정한다(의도된 동작이 아니라 "지금 이렇다"의 기록).
  // 도달성: index.js:58 이 홈브릿지 Logger를 그대로 넘기고 Logger는 항상 debug를 가지므로
  // 실가동에서는 도달하지 않는다 → 결함이 아니라 컨벤션 이탈(잠재). 351행에 `?.`를 붙이면
  // 아래 두 체크가 뒤집히며, 그때 이 블록을 "계약 메시지 유지"로 갱신하면 된다.
  check('[기준선] 2회차는 TypeError로 치환됨 — 계약 메시지 소실',
    e2 instanceof TypeError && /log\.debug is not a function/.test(e2.message), `${e2 && e2.constructor.name}: ${e2 && e2.message}`);
  check('[기준선] 스트릭은 이미 증가한 상태로 남음', c._statusFailStreaks.get(AC_ID) === 2, String(c._statusFailStreaks.get(AC_ID)));
  check('   ↳ statusPromises 정리는 finally라 유지', c.statusPromises.size === 0);
  // 대조군: sendCommand 쪽 debug는 `?.` 라 같은 로거에서 안전한가
  const ok = makeClient({ noDebug: true });
  let sendErr = null;
  try { await ok.setPower(AC_ID, false); } catch (e) { sendErr = e; }
  check('대조군: sendCommand 성공 경로는 debug 없어도 무사 (debug?. 사용)', sendErr === null, sendErr && sendErr.message);
}

// ================= T6 =================
// v2.1.3 — 포매터 선계산+이중 폴백으로 위 취약이 봉합됐는지 실측(감사 제안 ③ 반영 검증).
// (v2.1.1까지: 포매터가 제어 경로 try 안이라 던지면 성공한 전송이 실패로 둔갑 + 로그 0줄
//  + 1500ms 재무효화 스킵 — 이 블록의 옛 단언이 그 결함을 문서화했었다.)
async function T6() {
  console.log('T6 포매터가 던지는 명령 — v2.1.3: 전송 성공 유지 + 폴백 요약 로그');
  const c = makeClient();
  c.registerDeviceLabel(AC_ID, '승준 에어컨');
  let err = null;
  try { await c.sendCommand(AC_ID, null); } catch (e) { err = e; }   // commands=[null] — _fmtCommand가 던짐
  const posted = c._logs.some(l => l[0] === 'POST');
  check('POST는 실제로 전송됨(기기에 명령 도달)', posted);
  check('★sendCommand가 정상 resolve (성공이 실패로 둔갑하지 않음)', err === null, String(err));
  check('★폴백 요약으로 전송 로그가 남음', txt(c).some(s => s.includes('전송: [null]')), JSON.stringify(txt(c)));
  const delsBefore = c._logs.filter(l => l[0] === 'cacheDel').length;
  await sleep(1700);
  check('★1500ms 2차 무효화 예약됨 (총 2회)',
    c._logs.filter(l => l[0] === 'cacheDel').length === 2 && delsBefore === 1,
    `before=${delsBefore} after=${c._logs.filter(l => l[0] === 'cacheDel').length}`);
}

// ================= T7 =================
// v2.x 로그 편집이 인접 라인을 건드린 off-재시도 안전망이 그대로인지.
async function T7() {
  console.log('T7 _isIdempotentOffCommand 분류 불변 (off 재시도 안전망)');
  const off = { component: 'main', capability: 'switch', command: 'off' };
  const on = { component: 'main', capability: 'switch', command: 'on' };
  const mode = { component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['cool'] };
  const F = SmartThingsClient._isIdempotentOffCommand;
  check('단독 off = idempotent', F({ data: { commands: [off] } }) === true);
  check('on = 비idempotent', F({ data: { commands: [on] } }) === false);
  check('mode = 비idempotent', F({ data: { commands: [mode] } }) === false);
  check('off+mode 묶음 = 비idempotent', F({ data: { commands: [off, mode] } }) === false);
  check('문자열 body도 처리', F({ data: JSON.stringify({ commands: [off] }) }) === true);
  // 비-off 명령이 _lastNonOffCmdTs를 기록해야 retryCondition이 역전을 감지한다
  const c = makeClient();
  await c.setMode(AC_ID, 'cool');
  check('비-off 명령은 _lastNonOffCmdTs 기록', c._lastNonOffCmdTs.has(AC_ID));
}

// ================= T8 =================
// 실패 경로 로그 — v2.1.3 정책: 에러 body는 warn으로 기본 레벨에서 보인다(감사 제안 ② 반영).
// (v2.1.1까지는 debug 강등이라 기본 레벨에서 원인코드가 사라졌음 — 감사에서 지적돼 재승격.)
async function T8() {
  console.log('T8 sendCommand 실패 로그 — 원인 body 가시성 (v2.1.3: warn 재승격)');
  const body = { error: { code: 'ConstraintViolationError', message: 'device is offline' } };
  const c = makeClient({ postFail: axiosErr(422, body, 'Request failed with status code 422') });
  c.registerDeviceLabel(AC_ID, '승준 에어컨');
  let err = null;
  try { await c.setPower(AC_ID, false); } catch (e) { err = e; }
  check('원본 axios 에러 그대로 rethrow (status 보존 → SmartAC 재시도 판정)',
    err && err.response && err.response.status === 422, String(err && err.message));
  const errLine = lines(c).find(l => l[0] === 'error');
  check('error 라인에 한국어 명령 표기', errLine && errLine[1].includes('[승준 에어컨] 전송 실패: 전원 → 꺼짐'), JSON.stringify(errLine));
  check('★원인 코드가 기본 레벨(warn)에 보임 — v2.1.3 재승격',
    lines(c).some(l => l[0] === 'warn' && l[1].includes('ConstraintViolationError')));
  check('warn 상세 라인에 기기 라벨 표기',
    lines(c).some(l => l[0] === 'warn' && l[1].includes('[전송 실패 상세] 승준 에어컨')));
  console.log(`    기본 레벨에서 보이는 것: ${errLine && errLine[1]}`);
}

(async () => {
  const t0 = Date.now();
  for (const t of [T1, T2, T3, T4, T5, T6, T7, T8]) { await t(); console.log(''); }
  console.log(`총 실패 ${failures}건 / 소요 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failures ? 1 : 0);
})();
