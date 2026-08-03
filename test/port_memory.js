'use strict';

/**
 * DTLS 포트 기억 (부팅 간 유지).
 *
 * ★왜: 포트를 안 주면 브릿지가 49152~49160을 훑는다. **실측 3초**가 걸리고, 그동안
 * 홈킷 콜드 리드 6발이 줄을 서 홈브릿지 `slow to respond`(임계 3초)를 넘겼다
 * (2026-08-03, 재시작마다 6줄). 포트를 주면 브릿지는 탐지를 **통째로 건너뛴다**.
 *
 * ⚠️여기서 재는 것은 "빨라졌는가"가 아니라 **"틀린 포트를 오래 붙들지 않는가"**다.
 *   캐시는 3초를 아끼자는 것인데, 그것 때문에 1분을 잃으면 손해다.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

const HOST = '192.168.1.78';

function makeClient(stateDir) {
  const lines = [];
  const rec = (lv) => (m) => lines.push({ lv, m: String(m) });
  const log = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  const c = new LocalApplianceClient(log, { stateDir });
  c._ready = true;
  c.cloud = null;
  return { c, lines };
}

(async () => {
  // ── ① 첫 부팅은 종전대로 자동 탐지, 확인되면 기억한다
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km81-port-'));
  {
    const { c, lines } = makeClient(dir);
    c.registerDevice('D', { host: HOST, label: '승준 에어컨' });
    check(c.devices.get('D').port === undefined, '첫 부팅에는 포트가 없다 (탐지에 맡긴다)');
    check(lines.some((l) => /포트 자동 탐지/.test(l.m)), '자동 탐지라고 알린다');

    c._learnPort('D', 49154);
    check(JSON.parse(fs.readFileSync(path.join(dir, 'ports.json'), 'utf8'))[HOST].port === 49154,
      '★확인된 포트를 디스크에 기억한다');
    check(lines.some((l) => /DTLS 포트 확인됨 — 49154/.test(l.m)), '확인 사실을 알린다');
  }

  // ── ② ★다음 부팅은 탐지를 건너뛴다 (이 스위트의 목적)
  {
    const { c, lines } = makeClient(dir);
    c.registerDevice('D', { host: HOST, label: '승준 에어컨' });
    check(c.devices.get('D').port === 49154,
      '★★다음 부팅에는 기억한 포트로 바로 붙는다 (49152~49160 탐지 3초를 건너뛴다)');
    check(lines.some((l) => /지난 부팅에서 확인한 포트/.test(l.m)),
      '기억한 포트를 썼다는 것을 알린다 (탐지한 것처럼 말하지 않는다)');
  }

  // ── ③ ⚠️설정에 적은 포트가 우선이다 (캐시가 사용자 설정을 덮으면 안 된다)
  {
    const { c } = makeClient(dir);
    c.registerDevice('D', { host: HOST, port: 49157, label: '승준 에어컨' });
    check(c.devices.get('D').port === 49157, '설정 포트가 캐시보다 우선한다');
    check(c.devices.get('D').portFromCache !== true, '설정 포트를 캐시로 취급하지 않는다');
  }

  // ── ④ ★★기억한 포트가 틀리면 **첫 실패에 바로 버린다**
  //    PORT_RESET_AFTER(3회)를 기다리면 20초×3 = 1분을 허비한다.
  //    캐시로 아끼려던 것이 3초인데 1분을 잃으면 손해다.
  {
    const { c, lines } = makeClient(dir);
    c.registerDevice('D', { host: HOST, label: '승준 에어컨' });
    check(c.devices.get('D').port === 49154, '(전제) 기억한 포트를 들고 시작한다');

    try {
      await c._withFallback('D', '상태 조회',
        async () => { throw new Error('로컬 요청 시간 초과'); }, null, { kind: 'read' });
    } catch (_) { /* 폴백이 없으면 던진다 */ }

    check(c.devices.get('D').port === undefined,
      '★★한 번 실패하면 기억한 포트를 즉시 버린다 (3회를 기다리지 않는다)');
    check(!fs.existsSync(path.join(dir, 'ports.json'))
      || !JSON.parse(fs.readFileSync(path.join(dir, 'ports.json'), 'utf8'))[HOST],
      '★디스크에서도 지운다 (다음 부팅에 같은 낡은 포트를 되살리지 않는다)');
    check(!lines.some((l) => l.lv === 'warn' || l.lv === 'error'),
      '이 되돌림은 사용자 문제가 아니므로 조용하다 (debug만)');
  }

  // ── ⑤ 실제 통신으로 확인된 포트는 첫 실패에 안 버린다 (순단에 과민반응하면 안 된다)
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'km81-port2-'));
    const { c } = makeClient(dir2);
    c.registerDevice('D', { host: HOST, label: '승준 에어컨' });
    c._learnPort('D', 49154);                    // 실제 왕복으로 확인됨
    check(c.devices.get('D').portFromCache === false, '확인된 포트는 더는 캐시 취급이 아니다');

    try {
      await c._withFallback('D', '상태 조회',
        async () => { throw new Error('로컬 요청 시간 초과'); }, null, { kind: 'read' });
    } catch (_) { /* 폴백 없음 */ }
    check(c.devices.get('D').port === 49154,
      '★순단 1회로는 확인된 포트를 버리지 않는다 (매번 재탐지하면 더 느려진다)');
  }

  // ── ⑥ 연속 실패로 재탐지에 들어가면 디스크 기억도 함께 지운다
  {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'km81-port3-'));
    const { c } = makeClient(dir3);
    c.registerDevice('D', { host: HOST, label: '승준 에어컨' });
    c._learnPort('D', 49154);
    for (let i = 0; i < 3; i++) {
      try {
        await c._withFallback('D', '상태 조회',
          async () => { throw new Error('로컬 요청 시간 초과'); }, null, { kind: 'read' });
      } catch (_) { /* 폴백 없음 */ }
    }
    check(c.devices.get('D').port === undefined, '연속 실패 3회면 포트를 버린다 (종전 동작)');
    const f = path.join(dir3, 'ports.json');
    check(!fs.existsSync(f) || !JSON.parse(fs.readFileSync(f, 'utf8'))[HOST],
      '★★디스크 기억도 함께 지운다 (안 지우면 다음 부팅에 낡은 포트가 되살아난다)');
  }

  // ── ⑦ 파일이 깨져 있어도 죽지 않는다 (종전대로 탐지)
  {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'km81-port4-'));
    fs.writeFileSync(path.join(dir4, 'ports.json'), '{ 이건 JSON이 아니다');
    const { c } = makeClient(dir4);
    c.registerDevice('D', { host: HOST, label: '승준 에어컨' });
    check(c.devices.get('D').port === undefined, '깨진 파일은 없는 것으로 보고 탐지에 맡긴다');
  }

  // ── ⑧ 브릿지 계약 — 포트를 주면 탐지 단계를 건너뛴다 (이 최적화의 전제)
  {
    const py = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local', 'bridge.py'), 'utf8');
    check(/if not port:\s*\n\s*try:\s*\n\s*port = resolve_port\(host\)/.test(py),
      '★브릿지는 포트가 있으면 resolve_port를 아예 부르지 않는다 (전제가 깨지면 이 최적화는 무의미)');
  }

  console.log(`\n[DTLS 포트 기억] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
