'use strict';
// v2.14.11/12 — "기기는 살아 있는데 세션만 죽은" 상태에서 빠져나오는 경로의 회귀.
//
// ★왜 만들었나 (2026-08-13 정수기 실사고)
//   ARP 는 REACHABLE 인데 홈브릿지와 4시간 39분 무통신이었고, 재기동 8초 만에 같은 포트로 복구.
//   복구 트리거가 **프로세스 죽음뿐**이라 "프로세스는 살아 있는데 못 붙는" 상태는 방치됐다.
//
// ⚠️v2.14.12 — v2.14.11 의 이 파일은 대부분이 **소스 정규식 검사**여서, 적대 리뷰가
//   ①호출부에서 kill 제거 ②임계 상수 무력화 ③카운터 키 변조 ④사유 제거 **4종을 적용한 채로
//   전 30스위트를 초록으로 통과**시켰다. 그래서 판정 로직을 `maybeRestartBridge` 한 곳에 모으고
//   여기서는 **행위로** 잰다.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
// ⚠️CRLF 체크아웃에서도 같은 결과를 내야 한다 — 개행 하나로 계측기가 사문이 된 적이 있다
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8').split('\r\n').join('\n');
const LAC_SRC = read('lib/api/LocalApplianceClient.js');
const ATTACH_SRC = read('lib/mqtt/attach.js');
const PY_SRC = read('lib/local/bridge.py');
const LocalApplianceClient = require(path.join(REPO, 'lib/api/LocalApplianceClient.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function makeClient() {
  const o = Object.create(LocalApplianceClient.prototype);
  o.__calls = [];
  o.log = { warn: m => o.__calls.push(m), info: () => {}, error: () => {}, debug: () => {} };
  o._labelOf = () => '정수기';
  o._stopped = false;
  o.__killed = 0;
  o._proc = { kill: () => { o.__killed += 1; } };
  return o;
}
// 상수는 소스에서 뽑는다 — 테스트가 값을 베끼면 상수를 바꿔도 안 깨진다
const AFTER = Number((LAC_SRC.match(/const BRIDGE_RESTART_AFTER\s*=\s*(\d+)/) || [])[1]);
const MAX = Number((LAC_SRC.match(/const BRIDGE_RESTART_MAX\s*=\s*(\d+)/) || [])[1]);

console.log('#1 임계 판정 — 행위로 잰다');
{
  const o = makeClient();
  check('상수를 읽었다', Number.isFinite(AFTER) && Number.isFinite(MAX), `AFTER=${AFTER} MAX=${MAX}`);
  check('임계 미만이면 재시작하지 않는다', o.maybeRestartBridge('d', AFTER - 1) === false && o.__killed === 0);
  check('임계에서 재시작한다', o.maybeRestartBridge('d', AFTER) === true && o.__killed === 1);
  check('경고에 횟수를 적는다', /1\/\d+회째/.test(o.__calls[0] || ''), o.__calls[0]);
  // ⚠️문구는 사실만 — 발화 조건은 기기 응답 여부를 구분하지 못한다
  check('"기기가 응답한다"고 단정하지 않는다',
    !/기기는 응답하는데/.test(o.__calls[0] || ''), o.__calls[0]);
  check('전원이 꺼진 경우를 안내한다', /전원이 꺼져 있으면/.test(o.__calls[0] || ''), o.__calls[0]);
  check('streak 이 숫자가 아니면 무시', o.maybeRestartBridge('d', undefined) === false);
}

console.log('#2 ★시간 쿨다운 — 폴이 빠른 기기에서 임계가 금방 다시 차도 연달아 죽이지 않는다');
{
  const o = makeClient();
  o.maybeRestartBridge('d', AFTER);
  check('첫 재시작', o.__killed === 1);
  check('쿨다운 안에서는 무동작', o.maybeRestartBridge('d', AFTER * 2) === false && o.__killed === 1);
  // 쿨다운을 지난 것처럼 되돌린다
  o._lastBridgeRestart = Date.now() - (31 * 60 * 1000);
  check('쿨다운이 지나면 다시 시도', o.maybeRestartBridge('d', AFTER * 3) === true && o.__killed === 2);
}

console.log('#3 ★횟수 상한 — 기기가 물리적으로 죽어 있으면 재시작은 소용없다(영구 반복 금지)');
{
  const o = makeClient();
  for (let i = 0; i < MAX + 3; i++) {
    o._lastBridgeRestart = 0;              // 쿨다운은 이 시험의 관심사가 아니다
    o.maybeRestartBridge('d', AFTER);
  }
  check(`상한 ${MAX}회에서 멈춘다`, o.__killed === MAX, `killed=${o.__killed}`);
  // 로컬이 한 번이라도 성공하면 다음 장애를 다시 구제해야 한다
  o._noteLocalOk();
  o._lastBridgeRestart = 0;
  check('로컬 성공 뒤 상한이 리셋된다', o.maybeRestartBridge('d', AFTER) === true && o.__killed === MAX + 1);
}

console.log('#4 죽일 대상이 없거나 종료 중이면 무동작 / kill 예외는 삼킨다');
{
  const a = makeClient(); a._proc = null;
  check('_proc 없으면 무동작', a.maybeRestartBridge('d', AFTER) === false && a.__calls.length === 0);
  const b = makeClient(); b._stopped = true;
  check('_stopped 면 무동작', b.maybeRestartBridge('d', AFTER) === false && b.__killed === 0);
  const c = makeClient(); c._proc = { kill: () => { throw new Error('ESRCH'); } };
  let threw = false;
  try { c.maybeRestartBridge('d', AFTER); } catch (_) { threw = true; }
  check('예외가 새어 나오지 않는다', !threw);
  // ★직접 _spawn 하지 않는다 — exit 핸들러가 백오프 후 띄운다(이중 spawn 방지)
  check('여기서 _spawn 하지 않는다',
    !/maybeRestartBridge[\s\S]{0,900}?this\._spawn\(\)/.test(LAC_SRC));
}

console.log('#5 ★호출부가 둘 다 연결돼 있다 (v2.14.11 은 정수기가 빠져 있었다)');
{
  // 적대 리뷰 M1: 호출부에서 kill 을 지워도 전 스위트가 초록이었다 → 존재를 명시적으로 못 박는다
  check('홈킷/폴백 경로에서 부른다', /this\.maybeRestartBridge\(deviceId, streak\)/.test(LAC_SRC));
  check('★정수기 폴러에서도 부른다',
    /client\.maybeRestartBridge\(deviceId, deadStreak, label\)/.test(ATTACH_SRC));
  // 정수기 getter 가 _withFallback 을 안 타는 구조는 그대로다 — 그래서 별도 연결이 필요하다
  check('정수기 연결에 근거 주석이 있다', /안전망 밖/.test(ATTACH_SRC));
}

console.log('#6 bridge.py — CoAP 오류에서도 세션을 버린다');
{
  const errBlock = (PY_SRC.match(/if not \(64 <= code <= 95\):[\s\S]{0,1400}?return \{[^}]*\}/) || [''])[0];
  check('오류 분기를 찾았다', !!errBlock);
  check('drop_session 을 호출한다', /drop_session\(host, port\)/.test(errBlock));
  check('5.xx 는 즉시', /\(code >> 5\) == 5/.test(errBlock));
  check('4.xx 는 연속 N회에서만(정상 쿨다운 보호)', /streak >= COAP_FAIL_DROP_AFTER/.test(errBlock));
  // ★4.04 는 기기의 확정 답이다 — JS 계약(notfound_not_failure)과 어긋나면 건강한 세션을 끊는다
  check('★4.04 는 실패로 세지 않는다', /if code != COAP_NOT_FOUND:/.test(errBlock));
  check('4.04 상수가 정의돼 있다', /COAP_NOT_FOUND\s*=\s*132/.test(PY_SRC));
  check('진단용 계수를 응답에 싣는다', /"coapStreak"/.test(errBlock) && /"sessionDropped"/.test(errBlock));
}

console.log('#7 bridge.py — 연속 카운터가 세션 경계를 넘지 않는다');
{
  // ★적대 리뷰가 하네스로 실증: 예외 경로 drop 뒤 새 세션의 첫 오류가 coapStreak 2 였다.
  //   정리를 drop_session 안에 두면 예외·CoAP 어느 경로로 버려도 '연속'이 끊긴다.
  const dropFn = (PY_SRC.match(/def drop_session\(host, port\):[\s\S]*?\n\ndef /) || [''])[0];
  check('drop_session 안에서 카운터를 지운다', /_coap_fail\.pop\(k, None\)/.test(dropFn), dropFn.slice(0, 80));
  check('성공 경로에서도 리셋한다',
    /_coap_fail\.pop\("%s:%d" % \(host, port\), None\)[\s\S]{0,200}?return \{"id": rid, "ok": True/.test(PY_SRC));
  // 호출부에 중복 pop 이 남아 있으면 정리 지점이 둘로 갈린다(이번에 없앤 것)
  const errBlock2 = (PY_SRC.match(/if not \(64 <= code <= 95\):[\s\S]{0,1400}?return \{[^}]*\}/) || [''])[0];
  check('오류 분기에 중복 pop 이 없다', !/_coap_fail\.pop\(k, None\)/.test(errBlock2));
}

console.log('#8 사망 경보에 마지막 실패 사유가 실린다');
{
  check('why 를 조립한다', /마지막 실패: \$\{e\.message\}/.test(LAC_SRC));
  check('폴백 유무 두 문구 모두에 붙는다',
    (LAC_SRC.match(/제어되지 않습니다[^`]*\$\{why\}/) || []).length === 1
    && (LAC_SRC.match(/사실상 클라우드로 동작 중[^`]*\$\{why\}/) || []).length === 1);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
