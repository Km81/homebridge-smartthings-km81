'use strict';

/**
 * 기기 기능 목록 덤프 (문제 보고용).
 *
 * 왜: 기기마다 무엇을 지원하는지가 모델·펌웨어 세대마다 다르다. 사용자 로그를 받아도
 * 그 목록이 없으면 "무엇을 더 만들 수 있는지"를 알 수 없어 왕복이 길어진다.
 * `/device/0`은 배치 인터페이스라 **왕복 한 번에** 리소스와 현재 값을 전부 준다.
 *
 * ⚠️여기서 가장 중요한 검사는 **가림 처리**다. 사용자가 이 로그를 그대로 보내는 것을
 *   전제로 하므로, WiFi SSID·MAC·시리얼이 평문으로 나가면 안 된다.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

// 실기기 `/device/0` 응답을 본뜬 것 (승준 에어컨 실측 구조 + 개인정보 리소스)
const BATCH = [
  { href: '/temperatures/vs/0', rep: { 'x.com.samsung.da.items': [{ 'x.com.samsung.da.id': '0', 'x.com.samsung.da.current': '29.0', 'x.com.samsung.da.desired': '25.0', 'x.com.samsung.da.increment': '0.5' }] } },
  { href: '/power/vs/0', rep: { 'x.com.samsung.da.power': 'Off', causeSource: '46' } },
  { href: '/mode/vs/0', rep: { 'x.com.samsung.da.modes': ['Cool'], 'x.com.samsung.da.supportedModes': ['Cool', 'Dry', 'Wind', 'Auto'] } },
  { href: '/wirelessinfo/vs/0', rep: { macaddressWiFi: 'AA:BB:CC:DD:EE:FF', macaddressBLE: '11:22:33:44:55:66', connectedApSsid: '우리집공유기' } },
  { href: '/information/vs/0', rep: { 'x.com.samsung.da.modelNum': 'TP1X_DA-AC-CAC-01001_0000', 'x.com.samsung.da.serialNum': 'BNNJP3FL411437A' } },
  { href: '/oic/d', rep: { di: '3ea2a924-1111-2222-3333-444455556666', n: 'Samsung System A/C' } },
];

function makeClient(rpcImpl) {
  const lines = [];
  const log = {
    info: () => {}, warn: () => {}, error: () => {},
    debug: (m) => lines.push(String(m)),
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km81-dump-'));
  const c = new LocalApplianceClient(log, { stateDir });
  c._ready = true;
  c.devices.set('D', { host: '192.168.0.205', port: 49154, label: '놀이방 에어컨' });
  let calls = 0;
  c._rpc = async (payload) => { calls++; return rpcImpl(payload); };
  return { c, lines, calls: () => calls };
}

(async () => {
  // ── ① 목록이 debug 로그에 남는다
  {
    const { c, lines } = makeClient(async () => ({ code: 69, data: BATCH, port: 49154 }));
    await c._dumpResourcesOnce('D');
    const joined = lines.join('\n');
    check(/기기 기능 목록 6개/.test(joined), '리소스 개수와 함께 목록을 연다');
    check(/기능 목록 끝/.test(joined), '목록의 끝을 표시한다 (로그에서 잘라내기 쉽게)');
    check(/\/temperatures\/vs\/0/.test(joined), '리소스 경로가 그대로 남는다');
    check(/29\.0/.test(joined) && /0\.5/.test(joined),
      '★현재 값도 남는다 (증분 0.5 같은 것이 개발 판단의 근거다)');
    check(/supportedModes/.test(joined), '지원 모드 목록이 남는다');
    check(lines.every((l) => l.startsWith('[놀이방 에어컨]')),
      '모든 줄에 기기 라벨이 붙는다 (같은 이름 기기가 둘일 때 구분)');
  }

  // ── ② ★개인정보는 가린다 (사용자가 이 로그를 그대로 보낸다)
  {
    const { c, lines } = makeClient(async () => ({ code: 69, data: BATCH, port: 49154 }));
    await c._dumpResourcesOnce('D');
    const joined = lines.join('\n');
    check(!joined.includes('AA:BB:CC:DD:EE:FF'), '★WiFi MAC 주소가 평문으로 나가지 않는다');
    check(!joined.includes('11:22:33:44:55:66'), '★BLE MAC 주소가 평문으로 나가지 않는다');
    check(!joined.includes('우리집공유기'), '★공유기 이름(SSID)이 평문으로 나가지 않는다');
    check(!joined.includes('BNNJP3FL411437A'), '★기기 시리얼 번호가 평문으로 나가지 않는다');
    check(!joined.includes('3ea2a924-1111-2222-3333-444455556666'), '★기기 고유 ID가 평문으로 나가지 않는다');
    check(/가림/.test(joined), '가려진 자리를 표시해 둔다 (항목이 있었다는 사실은 남는다)');
    check(/wirelessinfo/.test(joined) && /macaddressWiFi/.test(joined),
      '어떤 항목이 있는지는 남는다 (가리는 것은 값뿐)');
    check(/TP1X_DA-AC-CAC-01001_0000/.test(joined),
      '모델명은 남긴다 — 진단에 필요하고 개인정보가 아니다');
  }

  // ── ③ 부팅당 기기당 한 번만
  {
    const { c, lines, calls } = makeClient(async () => ({ code: 69, data: BATCH, port: 49154 }));
    await c._dumpResourcesOnce('D');
    const after = lines.length;
    await c._dumpResourcesOnce('D');
    await c._dumpResourcesOnce('D');
    check(calls() === 1, '★기기에 한 번만 물어본다 (단일 세션 기기를 방해하지 않는다)');
    check(lines.length === after, '로그도 한 번만 남는다');
  }

  // ── ④ 실패해도 기기 동작에 영향이 없다
  {
    const { c, lines } = makeClient(async () => { throw new Error('로컬 요청 시간 초과'); });
    let threw = false;
    try { await c._dumpResourcesOnce('D'); } catch (_) { threw = true; }
    check(!threw, '★진단이 실패해도 예외를 올리지 않는다 (기기 사용을 막으면 안 된다)');
    check(lines.some((l) => /읽지 못했습니다/.test(l)), '실패 사실은 debug에 남긴다');
  }

  // ── ⑤ 배치를 지원하지 않는 기기
  {
    const { c, lines } = makeClient(async () => ({ code: 69, data: { some: 'object' }, port: 49154 }));
    await c._dumpResourcesOnce('D');
    check(lines.some((l) => /배치 조회를 지원하지 않는/.test(l)),
      '목록 형태가 아니면 그렇게 적는다 (빈 목록으로 오해하지 않게)');
  }

  // ── ⑥ 아주 긴 값은 잘라 로그를 지키지 않는다
  {
    const big = { href: '/big/vs/0', rep: { data: 'x'.repeat(9000) } };
    const { c, lines } = makeClient(async () => ({ code: 69, data: [big], port: 49154 }));
    await c._dumpResourcesOnce('D');
    check(lines.every((l) => l.length < 2300), '한 줄이 지나치게 길어지지 않는다');
    check(lines.some((l) => /자\)/.test(l)), '잘렸다는 사실과 원래 길이를 남긴다');
  }

  // ── ⑦ ★긴 지원 목록이 잘리지 않는다
  //   진단에서 가장 쓸모 있는 것이 supportedModes 같은 목록이다. 거기서 잘리면
  //   "이 기기가 무엇을 지원하는가"를 알려는 이 기능의 목적이 사라진다.
  {
    const modes = Array.from({ length: 40 }, (_, i) => `Mode_${i}`);
    const one = [{ href: '/mode/vs/0', rep: { 'x.com.samsung.da.supportedModes': modes } }];
    const { c, lines } = makeClient(async () => ({ code: 69, data: one, port: 49154 }));
    await c._dumpResourcesOnce('D');
    const j = lines.join('\n');
    check(j.includes('Mode_0') && j.includes('Mode_39'),
      '★지원 목록 40개가 처음부터 끝까지 남는다');
  }

  // ── ⑧ 실기기 규모에서도 감당할 만한 로그량인가 (실측 39항목 / 8,800자)
  {
    const many = Array.from({ length: 39 }, (_, i) => ({
      href: `/res${i}/vs/0`,
      rep: { 'x.com.samsung.da.value': 'v'.repeat(180) },
    }));
    const { c, lines } = makeClient(async () => ({ code: 69, data: many, port: 49154 }));
    await c._dumpResourcesOnce('D');
    const total = lines.join('\n').length;
    check(lines.length === 39 + 2, '항목 수만큼 줄이 나오고 앞뒤로 머리말·꼬리말이 붙는다');
    check(total < 40000, `실기기 규모 로그량이 과하지 않다 (실측 ${total}자)`);
  }

  console.log(`\n[기기 기능 목록 덤프] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
