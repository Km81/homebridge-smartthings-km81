'use strict';

/**
 * 리소스 부재(CoAP 4.04)를 통신 실패로 세지 않는다.
 *
 * 실사용자 로그(2026-07-31, 천장형 에어컨 2대): 그 보드에 표준 온도 리소스가 없다는
 * 이유만으로 `포트를 다시 탐지합니다` 28회와 `이 기기는 지금 제어되지 않습니다` 경보가
 * 났다. 그동안 전원·모드는 정상이었다. 4.04는 전송 실패가 아니라 '그 리소스가 없다'는
 * 확정 답이므로 연속 실패 계수에서 빼야 한다.
 *
 * ⚠️이 스위트는 전송 실패(타임아웃)에서는 그 경보가 **그대로 나오는지**도 함께 본다.
 *   안 그러면 "경보가 안 난다"를 통과시키는 빈 테스트가 된다.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

function makeClient() {
  const lines = [];
  const rec = (level) => (m) => lines.push(`${level}|${m}`);
  const log = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km81-test-'));
  const c = new LocalApplianceClient(log, { stateDir });
  c._ready = true;                       // 브릿지가 떠 있는 상태로 둔다
  c.cloud = null;                        // 폴백 없음 = 경보가 나야 하는 구성
  c.devices.set('D', { host: '192.168.0.205', port: 49154, fallbackToCloud: false, label: '천장형' });
  return { c, lines, stateDir };
}

async function hammer(c, makeError, times = 12) {
  for (let i = 0; i < times; i++) {
    try {
      await c._withFallback('D', '실내온도 조회', async () => { throw makeError(); }, null, { kind: 'read' });
    } catch (_) { /* 실패는 예상된 것 */ }
  }
}

(async () => {
  // ── ① 리소스 부재를 반복해도 전송 진단이 헛돌지 않는다
  {
    const { c, lines } = makeClient();
    const before = c.devices.get('D').port;
    await hammer(c, () => { const e = new Error('/temperature/current/0 조회 거부됨 — CoAP 4.04'); e.notFound = true; return e; });

    check(!lines.some(l => /포트를 다시 탐지/.test(l)), '4.04가 반복돼도 포트를 다시 탐지하지 않는다');
    check(!lines.some(l => /제어되지 않습니다/.test(l)), '★4.04는 「제어되지 않습니다」 경보를 내지 않는다');
    check(!lines.some(l => /사실상 클라우드로 동작 중/.test(l)), '4.04는 클라우드 전환 경보도 내지 않는다');
    check(c.devices.get('D').port === before, '학습한 포트를 버리지 않는다');
    check((c._fallbackStreak.get('D') || 0) === 0, '연속 실패 계수가 올라가지 않는다');
  }

  // ── ② 진짜 전송 실패에서는 그 경보가 그대로 나온다 (테스트가 비지 않았음을 증명)
  {
    const { c, lines } = makeClient();
    await hammer(c, () => new Error('요청 시간 초과'));

    check(lines.some(l => /포트를 다시 탐지/.test(l)), '전송 실패에서는 포트 재탐지가 그대로 동작한다');
    check(lines.some(l => /제어되지 않습니다/.test(l)), '전송 실패에서는 「제어되지 않습니다」 경보가 그대로 난다');
    check((c._fallbackStreak.get('D') || 0) >= 12, '전송 실패는 연속 실패로 센다');
  }

  // ── ③ 4.04가 섞여도 전송 실패 계수를 오염시키지 않는다
  {
    const { c } = makeClient();
    await hammer(c, () => { const e = new Error('CoAP 4.04'); e.notFound = true; return e; }, 30);
    await hammer(c, () => new Error('요청 시간 초과'), 2);
    check((c._fallbackStreak.get('D') || 0) === 2,
      '★4.04 30회 뒤에도 전송 실패 계수는 2에서 시작한다');
  }

  // ── ④ _assertOk가 4.04에만 표식을 단다
  {
    const codeOf = (maj, min) => (maj << 5) | min;
    const grab = (code) => {
      try { LocalApplianceClient._assertOk({ code }, '조회'); return null; } catch (e) { return e; }
    };
    check(grab(codeOf(4, 4))?.notFound === true, '4.04에는 리소스 부재 표식이 붙는다');
    check(grab(codeOf(4, 3))?.notFound === undefined, '4.03(권한)에는 붙지 않는다');
    check(grab(codeOf(4, 0))?.notFound === undefined, '4.00(잘못된 요청)에는 붙지 않는다');
    check(grab(codeOf(5, 3))?.notFound === undefined, '5.03(기기 오류)에는 붙지 않는다');
    check(LocalApplianceClient._assertOk({ code: codeOf(2, 5) }, '조회') !== null, '2.05는 그대로 통과한다');
    check(/CoAP 4\.04/.test(grab(codeOf(4, 4))?.message || ''), '메시지에 응답 코드가 남는다');
  }

  // ── ⑤ 폴백을 켠 구성 — 리소스 부재가 조용한 과금이 되지 않는다
  {
    const { c, lines } = makeClient();
    let cloudCalls = 0;
    c.cloud = { get: () => { cloudCalls++; return 25; } };
    c.devices.get('D').fallbackToCloud = true;

    const permanent = () => { const e = new Error('CoAP 4.04'); e.notFound = true; return e; };
    for (let i = 0; i < 8; i++) {
      try {
        await c._withFallback('D', '실내온도 조회',
          async () => { throw permanent(); }, () => c.cloud.get(), { kind: 'read' });
      } catch (_) { /* 폴백이 받아 준다 */ }
    }

    check(cloudCalls === 8, '리소스가 없으면 폴마다 클라우드로 대체한다 (읽기 유예 없이)');
    const notices = lines.filter(l => /앞으로 폴링마다 클라우드를 부릅니다/.test(l));
    check(notices.length === 1,
      '★조용한 과금이 되지 않게 한 번은 알린다 — 그리고 딱 한 번만 알린다');
    check((notices[0] || '').startsWith('warn|'), '그 알림은 warn이다');
    check(!lines.some(l => /응답 없음/.test(l)),
      '기기가 답을 한 것이므로 「응답 없음」이라 하지 않는다');
    check(!lines.some(l => /\(0회째\)/.test(l)), '세지 않는 계수를 「0회째」로 찍지 않는다');

    // ★핵심: 이 상황이 `_fallbackSince`를 남기면 안 된다.
    check(!c._fallbackSince.has('D'),
      '★리소스 부재는 폴백 시작 시각을 남기지 않는다 (연속 실패로 안 세므로 영영 정리되지 않는다)');

    // 이제 무관한 순단 1회 → 복구. 클라우드를 쓰지 않았으므로 그렇게 말하면 안 된다.
    lines.length = 0;
    try {
      await c._withFallback('D', '희망온도 조회',
        async () => { throw new Error('요청 시간 초과'); }, () => 25, { kind: 'read' });
    } catch (_) { /* 읽기 유예 */ }
    await c._withFallback('D', '희망온도 조회', async () => 25, () => 25, { kind: 'read' });
    check(!lines.some(l => /초간 클라우드 사용/.test(l)),
      '★그 뒤 순단이 복구될 때 「N초간 클라우드 사용」이라는 거짓 문구가 붙지 않는다');
  }

  // ── ⑥ 쓰기 도중의 '조회' 실패는 결과 불명이 아니다
  //    온도 경로 판별 때문에 쓰기 작업 안에서도 조회가 먼저 나간다. 그 조회가 시간 초과된 것을
  //    '결과 불명'으로 보면 안전한 클라우드 재전송까지 막혀 사용자가 누른 버튼이 무시된다.
  {
    const { c, lines } = makeClient();
    let cloudCalls = 0;
    c.cloud = { set: () => { cloudCalls++; return true; } };
    c.devices.get('D').fallbackToCloud = true;

    const timeout = (sent) => { const e = new Error('로컬 요청 시간 초과'); e.sent = sent; return e; };

    try {
      await c._withFallback('D', '온도 전송',
        async () => { throw timeout(false); }, () => c.cloud.set(),
        { kind: 'write', fallbackOnUnknown: false });
    } catch (_) { /* 막히면 아래 검사가 잡는다 */ }
    check(cloudCalls === 1,
      '★조회가 시간 초과된 것(sent=false)은 기기에 아무것도 안 갔으므로 클라우드로 재전송한다');
    check(!lines.some(l => /순서 역전 위험/.test(l)), '거짓 사유를 대지 않는다');

    // 대조군 — 진짜 쓰기가 시간 초과된 경우는 여전히 막아야 한다(재점등 방지).
    lines.length = 0;
    let threw = false;
    try {
      await c._withFallback('D', '온도 전송',
        async () => { throw timeout(true); }, () => c.cloud.set(),
        { kind: 'write', fallbackOnUnknown: false });
    } catch (_) { threw = true; }
    check(threw && cloudCalls === 1,
      '★쓰기가 시간 초과된 것(sent=true)은 그대로 막는다 — 이 보호가 살아 있어야 한다');
    check(lines.some(l => /순서 역전 위험/.test(l)), '그때는 사유를 밝힌다');
  }

  console.log(`\n[리소스 부재 ≠ 통신 실패] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
