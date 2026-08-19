'use strict';
// v2.14.14 — 로컬(DTLS) 세탁가전이 무응답일 때 홈킷이 옛 값에 고착되지 않는지.
//
// ★왜 (2026-08-19 사용자 신고)
//   건조기가 다 돌고 꺼져 네트워크에서 사라졌는데 **SmartThings 는 오프라인, 홈킷은 "작동 중"**.
//   건조기는 DTLS 경로라 무응답이 예외로 올라오고, 폴 catch 가 직전 상태를 그대로 둔다.
//   세탁기(8888)는 클라이언트가 합성 '꺼짐'을 만들어 이 문제가 없다 → 같은 판정을 액세서리에 넣었다.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8').split('\r\n').join('\n');
const SRC = read('lib/accessories/Laundry.js');
const Laundry = require(path.join(REPO, 'lib/accessories/Laundry.js'));

let failures = 0;
const check = (n, c, x) => { if (c) console.log(`  PASS ${n}`); else { failures++; console.log(`  FAIL ${n}${x ? ' — ' + x : ''}`); } };

const AFTER = Number((SRC.match(/const LOCAL_OFFLINE_AFTER\s*=\s*(\d+)/) || [])[1]);
const netErr = () => Object.assign(new Error('요청 시간 초과 (5000ms)'), {});

function mk(gate = true) {
  const o = Object.create(Laundry.prototype);
  o._localSyntheticOff = gate;
  return o;
}

console.log('#1 상수·게이트');
check('LOCAL_OFFLINE_AFTER 를 읽었다', Number.isFinite(AFTER), String(AFTER));
check('게이트는 config 에서 세운다 (로컬+토큰없음)',
  /this\._localSyntheticOff = !!\(_lc && _lc\.host && !_lc\.token\)/.test(SRC));
check('★게이트가 꺼져 있으면 아무것도 안 만든다',
  mk(false)._syntheticOffFor(netErr(), 99, false, 1) === null);

console.log('#2 ★꺼져 있던 기기는 즉시 꺼짐으로 본다 (홈브릿지 재시작 직후 UX)');
{
  const off = mk()._syntheticOffFor(netErr(), 1, /*wasRunning*/false, 1);
  check('1회 실패로도 합성 꺼짐', !!off);
  check('main 구획이 있다', !!(off && off.main));
  check('machineState=stop', off && off.main.washerOperatingState.machineState.value === 'stop');
  check('jobState 는 비운다(판정을 machineState 에 맡김)',
    off && off.main.dryerOperatingState.dryerJobState.value === null);
  // ★__synthetic 이 없으면 last_seen 이 전진해 사망 판정이 영영 안 난다(적대 리뷰 F4·F5)
  check('★__synthetic 마커가 붙는다', off && off.__synthetic === true);
  check('마커는 열거되지 않는다(구획 순회에 안 걸림)',
    off && Object.keys(off).indexOf('__synthetic') === -1, JSON.stringify(Object.keys(off || {})));
}

console.log('#3 ★★운전 중이었으면 연속 실패를 요구한다 — 거짓 종료 알림 방지');
{
  const o = mk();
  for (let i = 1; i < AFTER; i++) {
    check(`  ${i}회째는 아직 아니다`, o._syntheticOffFor(netErr(), i, true, 1) === null);
  }
  check(`★${AFTER}회째에 꺼짐으로 단정`, !!o._syntheticOffFor(netErr(), AFTER, true, 1));
}

console.log('#4 네트워크류가 아닌 실패는 삼키지 않는다');
{
  const o = mk();
  check('응답 구조 이상은 통과시킨다(진짜 오류)',
    o._syntheticOffFor(new Error('API 응답에 장치가 없습니다'), 99, false, 1) === null);
  check('토큰 대기(_noToken)는 제외', o._syntheticOffFor(Object.assign(new Error('x'), { _noToken: true }), 99, false, 1) === null);
  // ★★v2.14.15 — `_transient` 로 거르면 안 된다. DTLS 클라이언트는 **모든 읽기 실패**에 이 플래그를
  //   달아서(`e._transient = kind === 'read'`), 제외하면 건조기에서 기능이 통째로 사문이 된다
  //   (v2.14.14 실측: `off=null transient=true reMatch=true`). 세탁기의 같은 이름과 뜻이 다르다.
  check('★_transient 가 붙어 있어도 막지 않는다',
    !!o._syntheticOffFor(Object.assign(new Error('로컬 요청 시간 초과'), { _transient: true }), 99, false, 1));
}

console.log('#5 구획 수를 마지막으로 본 것과 맞춘다');
{
  const o = mk();
  const two = o._syntheticOffFor(netErr(), 1, false, 2);
  check('2구획이면 main+sub', !!(two && two.main && two.sub));
  const one = o._syntheticOffFor(netErr(), 1, false, 1);
  check('1구획이면 main 만', !!(one && one.main) && !one.sub);
}

console.log('#6 폴 루프에 실제로 연결돼 있다');
{
  // ★호출부가 없으면 위 로직이 전부 사문이다(이 저장소가 반복해 밟은 부류)
  check('getStatus 실패를 감싸 합성 꺼짐을 쓴다',
    /catch \(e\) \{[\s\S]{0,400}?_syntheticOffFor\(e, consecutiveFailures \+ 1, wasRunning, units\.length\)/.test(SRC));
  check('만들지 못하면 원래 예외를 다시 던진다', /if \(!off\) throw e;/.test(SRC));
  check('직전 운전 여부를 prev 로 판정',
    /u\.prev === STATE\.RUNNING \|\| u\.prev === STATE\.PAUSED/.test(SRC));
  check('실제 응답이 오면 안내 플래그를 푼다', /this\._synthOffAnnounced = false;/.test(SRC));
  // ⚠️'실패/오류' 어휘를 쓰면 hb-watch 가 텔레그램 오경보를 낸다
  check('안내 문구가 세탁기와 같다(전원 꺼짐 — 로컬 응답 없음)',
    /전원 꺼짐 — 로컬 응답 없음/.test(SRC));
  check('경보 어휘를 쓰지 않는다',
    !/(상태 폴링 오류|폴링 실패|연결 실패)[^\n]*_synthOffAnnounced/.test(SRC));
}

console.log('#7 MQTT 중계 경로도 같은 판정을 쓴다 (v2.14.15 는 홈킷만 고친 반쪽이었다)');
{
  const ATTACH = read('lib/mqtt/attach.js');
  const { buildSyntheticOff } = require(path.join(REPO, 'lib/accessories/Laundry.js'));
  // 판정이 두 곳에 복제되면 다음에 한쪽만 고친다 — 공용 함수 하나를 쓰는지 못 박는다
  check('Laundry 가 순수 함수를 export 한다', typeof buildSyntheticOff === 'function');
  check('attach 가 그것을 import 한다', ATTACH.indexOf('classifyComponent, buildSyntheticOff') !== -1);
  check('MQTT 폴러가 실패를 감싸 합성 꺼짐을 쓴다',
    ATTACH.indexOf('buildSyntheticOff({') !== -1 && ATTACH.indexOf('enabled: local,') !== -1);
  check('만들지 못하면 원래 예외를 다시 던진다(진짜 오류 은폐 금지)',
    ATTACH.indexOf('if (!off) throw e;') !== -1);
  check('꺼짐으로 중계하면 running 도 내린다(주기 적응)',
    ATTACH.indexOf('comps = off;') !== -1 && ATTACH.indexOf('running = false;') !== -1);
  // 같은 사건을 홈킷 경로가 info 로 알린다 — MQTT 쪽이 또 info 를 찍으면 두 줄이 된다
  check('MQTT 쪽 안내는 debug 로', ATTACH.indexOf('로컬 응답 없음 — 꺼짐으로 중계합니다') !== -1);

  const err = Object.assign(new Error('로컬 요청 시간 초과'), { _transient: true });
  check('enabled=false 면 null',
    buildSyntheticOff({ err, streak: 99, wasRunning: false, unitCount: 1, enabled: false }) === null);
  check('enabled=true 면 합성 꺼짐',
    !!buildSyntheticOff({ err, streak: 99, wasRunning: false, unitCount: 1, enabled: true }));
  check('운전 중이었으면 여기서도 연속 실패를 요구한다',
    buildSyntheticOff({ err, streak: 1, wasRunning: true, unitCount: 1, enabled: true }) === null);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
