'use strict';
// v2.14.11 — "기기는 살아 있는데 세션만 죽은" 상태에서 빠져나오는 경로의 회귀.
//
// ★왜 만들었나 (2026-08-13 정수기 실사고)
//   ARP 는 REACHABLE 인데 홈브릿지와 4시간 39분 무통신이었고, 홈브릿지 재기동 8초 만에
//   같은 포트로 복구됐다. 조사 결과 복구 트리거가 **프로세스 죽음뿐**이었다 —
//   "프로세스는 살아 있는데 못 붙는" 상태는 아무도 손대지 않아 사람이 재기동할 때까지 방치됐다.
//   ⚠️로그로 원인(예외 vs CoAP 오류)을 가를 수도 없었다.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const LAC_SRC = fs.readFileSync(path.join(REPO, 'lib/api/LocalApplianceClient.js'), 'utf8');
const PY_SRC = fs.readFileSync(path.join(REPO, 'lib/local/bridge.py'), 'utf8');
const LocalApplianceClient = require(path.join(REPO, 'lib/api/LocalApplianceClient.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---------- 1. _restartBridge 동작 ----------
function makeClient() {
  const o = Object.create(LocalApplianceClient.prototype);
  const calls = [];
  o.log = { warn: m => calls.push(['warn', m]), info: () => {}, error: () => {}, debug: () => {} };
  o._labelOf = () => '정수기';
  o._stopped = false;
  o.__calls = calls;
  o.__killed = 0;
  o._proc = { kill: () => { o.__killed += 1; } };
  return o;
}

console.log('#1 _restartBridge — 프로세스를 죽여 exit 경로의 재spawn 을 유발한다');
{
  const o = makeClient();
  o._restartBridge('dev', 30);
  check('kill 1회', o.__killed === 1, `killed=${o.__killed}`);
  const w = o.__calls.find(c => c[0] === 'warn');
  check('경고를 남긴다', !!w, JSON.stringify(o.__calls));
  check('연속 실패 횟수를 적는다', !!w && /30회/.test(w[1]), w && w[1]);
  // ★직접 _spawn 하지 않는다 — exit 핸들러가 백오프 후 띄운다(이중 spawn 방지)
  check('여기서 _spawn 하지 않는다', !/_restartBridge[\s\S]{0,400}?this\._spawn\(\)/.test(LAC_SRC));
}

console.log('#2 _restartBridge — 죽일 대상이 없거나 종료 중이면 아무것도 안 한다');
{
  const o = makeClient(); o._proc = null;
  o._restartBridge('dev', 30);
  check('_proc 없으면 무동작', o.__calls.length === 0, JSON.stringify(o.__calls));

  const o2 = makeClient(); o2._stopped = true;
  o2._restartBridge('dev', 30);
  check('_stopped 면 무동작', o2.__killed === 0 && o2.__calls.length === 0, JSON.stringify(o2.__calls));
}

console.log('#3 _restartBridge — kill 이 던져도 삼킨다(이미 종료된 프로세스)');
{
  const o = makeClient();
  o._proc = { kill: () => { throw new Error('ESRCH'); } };
  let threw = false;
  try { o._restartBridge('dev', 60); } catch (_) { threw = true; }
  check('예외가 새어 나오지 않는다', !threw);
}

// ---------- 2. 호출 조건 (소스 계약) ----------
console.log('#4 호출 조건 — 임계에서 한 번만 돌고 마는 `===` 이면 안 된다');
{
  // ★`streak === N` 으로 두면 그 한 번을 놓쳤을 때 영영 재시도가 없다.
  //   이 저장소가 이미 밟은 부류라 회귀로 못 박는다.
  const m = LAC_SRC.match(/streak\s*>=\s*BRIDGE_RESTART_AFTER\s*&&\s*streak\s*%\s*BRIDGE_RESTART_AFTER\s*===\s*0/);
  check('>= + 나머지 0 으로 반복 발화한다', !!m, '조건식을 찾지 못함');
  check('임계 상수가 정의돼 있다', /const BRIDGE_RESTART_AFTER\s*=\s*\d+/.test(LAC_SRC));
  const n = Number((LAC_SRC.match(/const BRIDGE_RESTART_AFTER\s*=\s*(\d+)/) || [])[1]);
  // 사망 경보(LOCAL_DEAD_AFTER)보다 뒤여야 한다 — 경보도 없이 프로세스를 죽이면 진단이 어렵다
  const dead = Number((LAC_SRC.match(/const LOCAL_DEAD_AFTER\s*=\s*(\d+)/) || [])[1]);
  check('사망 경보 임계보다 크다', n > dead, `restart=${n} dead=${dead}`);
}

console.log('#5 사망 경보에 마지막 실패 사유가 실린다');
{
  // ★이게 없어 8/13 에 "예외(무응답)"와 "CoAP 오류(응답은 함)"를 가를 수 없었다 — 조치가 정반대다
  check('why 를 조립한다', /마지막 실패: \$\{e\.message\}/.test(LAC_SRC));
  const both = (LAC_SRC.match(/제어되지 않습니다[^`]*\$\{why\}/) || []).length === 1
    && (LAC_SRC.match(/사실상 클라우드로 동작 중[^`]*\$\{why\}/) || []).length === 1;
  check('폴백 유무 두 문구 모두에 붙는다', both);
}

// ---------- 3. bridge.py 세션 해제 계약 ----------
console.log('#6 bridge.py — CoAP 오류에서도 세션을 버릴 수 있어야 한다');
{
  // ★근본 원인: CoAP 4.xx/5.xx 는 예외가 아니라 return 이라 drop_session 을 안 탔고,
  //   session_for 는 캐시된 죽은 세션을 검사 없이 그대로 돌려줬다 → 영구 재사용.
  const errBlock = PY_SRC.match(/if not \(64 <= code <= 95\):[\s\S]{0,900}?return \{[^}]*\}/);
  check('오류 분기를 찾았다', !!errBlock);
  const b = errBlock ? errBlock[0] : '';
  check('오류 분기에서 drop_session 을 호출한다', /drop_session\(host, port\)/.test(b));
  check('5.xx 는 즉시 버린다', /\(code >> 5\) == 5/.test(b));
  check('4.xx 는 연속 N회에서만 버린다(정상 쿨다운 보호)',
    /streak >= COAP_FAIL_DROP_AFTER/.test(b));
  check('임계 상수가 있다', /COAP_FAIL_DROP_AFTER\s*=\s*\d+/.test(PY_SRC));
  check('연속 카운터를 응답에 실어 보낸다(진단)', /"coapStreak"/.test(b) && /"sessionDropped"/.test(b));
}

console.log('#7 bridge.py — 성공하면 연속 카운터가 리셋된다');
{
  // 리셋이 없으면 간헐 오류가 누적돼 멀쩡한 세션을 끊는다(반대 방향 사고)
  check('성공 경로에서 _coap_fail 을 지운다',
    /_coap_fail\.pop\("%s:%d" % \(host, port\), None\)[\s\S]{0,200}?return \{"id": rid, "ok": True/.test(PY_SRC));
  check('카운터 접근이 락 안에서 이뤄진다',
    (PY_SRC.match(/with _registry_lock:\s*\n\s*(streak = )?_coap_fail/g) || []).length >= 2);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
