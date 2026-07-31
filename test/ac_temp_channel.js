'use strict';

/**
 * 온도 리소스 경로 판별 (lib/local/AcTempChannel.js).
 *
 * 왜 이 스위트가 있나: 천장형 에어컨 2대를 쓰는 사용자 로그(2026-07-31)에서 온도 조회가
 * 계속 CoAP 4.04로 실패했다. 그 보드에는 표준 온도 리소스가 아예 없고 제조사 경로만
 * 있는데, 그걸 통신 실패로 취급해 포트 재탐지 28회와 '제어되지 않습니다' 허위 경보까지
 * 났다. 여기서 검증하는 것은 ①경로를 기기에 물어 정한다 ②표준을 가진 보드는 예전과
 * 똑같은 요청을 낸다 ③제조사 경로의 문자열·형식 규약을 지킨다, 세 가지다.
 */

const assert = require('assert');
const AcTempChannel = require('../lib/local/AcTempChannel');

const ITEMS = AcTempChannel.ITEMS;
const F = AcTempChannel.FIELD;

let pass = 0;
const fails = [];
function check(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}

function notFound() {
  const e = new Error('/x 조회 거부됨 — CoAP 4.04');
  e.notFound = true;
  return e;
}

/** 보드를 흉내 내는 가짜 클라이언트. 어떤 경로로 무엇을 요청했는지 기록한다. */
function fakeClient({ standard = null, vendor = null, getErr = null } = {}) {
  const calls = { get: [], post: [] };
  const logs = [];
  return {
    calls,
    logs,
    log: {
      info: (m) => logs.push(['info', m]),
      debug: (m) => logs.push(['debug', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    _labelOf: () => '테스트기기',
    async _get(deviceId, segs) {
      const key = segs.join('/');
      calls.get.push(key);
      if (getErr) { const e = getErr(key); if (e) throw e; }
      if (key === 'temperature/current/0') {
        if (!standard) throw notFound();
        return { range: [16, 30], units: 'C', temperature: standard.current };
      }
      if (key === 'temperature/desired/0') {
        if (!standard) throw notFound();
        return { range: [16, 30], units: 'C', temperature: standard.desired };
      }
      if (key === 'temperatures/vs/0') {
        if (!vendor) throw notFound();
        return {
          [ITEMS]: [{
            [F.id]: '0',
            [F.current]: vendor.current,
            [F.desired]: vendor.desired,
            [F.minimum]: vendor.min ?? '18',
            [F.maximum]: vendor.max ?? '30',
            [F.increment]: vendor.step ?? '1',
          }],
        };
      }
      throw notFound();
    },
    async _post(deviceId, segs, payload) {
      calls.post.push({ path: segs.join('/'), payload });
      return { code: 68 };
    },
  };
}

(async () => {
  // ── ① 표준 경로를 가진 보드 (승준 에어컨과 같은 구성)
  {
    const c = fakeClient({ standard: { current: 29, desired: 25 }, vendor: { current: '29.0', desired: '25.0' } });
    const ch = new AcTempChannel(c);
    const cur = await ch.readCurrent('D1');
    const des = await ch.readDesired('D1');
    check(ch.channelOf('D1') === AcTempChannel.STANDARD, '표준 리소스가 있으면 표준 경로로 굳는다');
    check(cur === 29 && des === 25, '표준 경로에서 현재·희망 온도를 읽는다');
    check(!c.calls.get.includes('temperatures/vs/0'),
      '★표준 보드에서는 제조사 경로를 아예 건드리지 않는다 (예전과 같은 요청)');

    await ch.writeDesired('D1', 24);
    check(c.calls.post.length === 1
      && c.calls.post[0].path === 'temperature/desired/0'
      && c.calls.post[0].payload.temperature === 24,
      '표준 경로 쓰기는 { temperature: 숫자 } 그대로다');
  }

  // ── ② 제조사 경로만 있는 보드 (천장형)
  {
    const c = fakeClient({ standard: null, vendor: { current: '28.5', desired: '28.0' } });
    const ch = new AcTempChannel(c);
    const cur = await ch.readCurrent('D2');
    const des = await ch.readDesired('D2');
    check(ch.channelOf('D2') === AcTempChannel.VENDOR, '표준이 4.04면 제조사 경로로 굳는다');
    check(cur === 28.5 && des === 28, '제조사 경로의 문자열 값을 숫자로 읽는다');
    check(c.logs.some(([lv, m]) => lv === 'info' && /표준 온도 리소스가 없어/.test(m)),
      '경로가 바뀐 사실을 한 줄로 알린다');
    check(c.logs.filter(([lv, m]) => lv === 'info' && /표준 온도 리소스가 없어/.test(m)).length === 1,
      '그 안내는 조회를 반복해도 한 번만 나온다');

    await ch.writeDesired('D2', 23.4);
    const sent = c.calls.post[0];
    check(sent.path === 'temperatures/vs/0', '제조사 경로로 쓴다');
    const item = sent.payload[ITEMS][0];
    check(Object.keys(item).length === 2 && item[F.id] === '0',
      '★id와 desired만 보낸다 (읽은 값을 되돌려 보내면 기기가 거부한다)');
    check(item[F.desired] === '23' && typeof item[F.desired] === 'string',
      '★1℃ 단위 기기에는 문자열 정수를 보낸다 (실기기에서 확인된 형식)');
  }

  // ── ②-2 ★0.5℃ 단위 기기 — 정수로 뭉개지 않는다
  //   실사용자 천장형(AJ023BN1PBC1, 앱 버전 CAC.5.1.11)의 앱 화면이 27.5℃·범위 18~30이었다.
  //   정수로 반올림해 보내면 사용자가 앱에서 맞춰 둔 값이 바뀐다.
  {
    const c = fakeClient({ standard: null, vendor: { current: '28.5', desired: '28.0', step: '0.5' } });
    const ch = new AcTempChannel(c);
    await ch.writeDesired('DH', 27.5);
    check(c.calls.post[0].payload[ITEMS][0][F.desired] === '27.5',
      '★0.5 단위 기기에는 27.5를 그대로 보낸다');

    await ch.writeDesired('DH', 27.3);
    check(c.calls.post[1].payload[ITEMS][0][F.desired] === '27.5',
      '단위에 맞춰 가까운 값으로 스냅한다 (27.3 → 27.5)');

    await ch.writeDesired('DH', 26);
    check(c.calls.post[2].payload[ITEMS][0][F.desired] === '26',
      '스냅 결과가 정수면 소수를 붙이지 않는다 (확인된 형식 유지)');
  }

  // ── ③ 판별은 항목당 한 번만
  {
    const c = fakeClient({ standard: null, vendor: { current: '25.0', desired: '24.0' } });
    const ch = new AcTempChannel(c);
    await ch.readCurrent('D3');
    await ch.readDesired('D3');          // 여기까지가 두 항목의 판별
    const settled = c.calls.get.length;
    await ch.readCurrent('D3');
    await ch.readDesired('D3');
    check(c.calls.get.length === settled + 2,
      '판별이 끝나면 조회 1건당 요청 1건이다 (매번 다시 탐지하지 않는다)');
    const probes = c.calls.get.filter(k => k === 'temperature/current/0').length;
    check(probes === 1, '표준 경로 탐지는 항목당 1회로 끝난다');
  }

  // ── ④ 동시 호출이 판별을 중복 실행하지 않는다
  {
    const c = fakeClient({ standard: null, vendor: { current: '25.0', desired: '24.0' } });
    const ch = new AcTempChannel(c);
    await Promise.all([ch.readCurrent('D4'), ch.readDesired('D4'), ch.readCurrent('D4')]);
    const probes = c.calls.get.filter(k => k === 'temperature/current/0').length;
    check(probes === 1, '동시에 불러도 표준 경로 탐지는 1회만 나간다');
  }

  // ── ⑤ 통신 실패는 경로를 굳히지 않는다
  {
    let boom = true;
    const c = fakeClient({
      standard: { current: 27, desired: 24 },
      getErr: (key) => (boom && key === 'temperature/current/0' ? new Error('시간 초과') : null),
    });
    const ch = new AcTempChannel(c);
    let threw = false;
    try { await ch.readCurrent('D5'); } catch (_) { threw = true; }
    check(threw, '통신 실패는 그대로 올린다');
    check(ch.channelOf('D5') === null,
      '★순단 한 번으로 경로를 잘못 굳히지 않는다');
    boom = false;
    check(await ch.readCurrent('D5') === 27, '통신이 돌아오면 정상 판별된다');
    check(ch.channelOf('D5') === AcTempChannel.STANDARD, '그때 표준으로 굳는다');
  }

  // ── ⑥ 값이 없으면 던진다 (조용히 지어내지 않는다)
  {
    const c = fakeClient({ standard: { current: null, desired: null }, vendor: { current: '', desired: '' } });
    const ch = new AcTempChannel(c);
    let threw = false;
    try { await ch.readCurrent('D6'); } catch (_) { threw = true; }
    check(threw, '두 경로 모두 값이 없으면 던진다 (기본값을 지어내면 폴백이 죽는다)');
  }

  // ── ⑦ 온도 범위
  {
    const std = new AcTempChannel(fakeClient({ standard: { current: 29, desired: 25 } }));
    check(JSON.stringify(await std.readLimits('D7')) === JSON.stringify({ min: 16, max: 30 }),
      '표준 보드의 범위는 range에서 읽는다');
    const ven = new AcTempChannel(fakeClient({ standard: null, vendor: { current: '28.5', desired: '28.0', min: '18', max: '30' } }));
    check(JSON.stringify(await ven.readLimits('D8')) === JSON.stringify({ min: 18, max: 30 }),
      '제조사 보드의 범위는 items에서 읽는다');
  }

  // ── ⑧ ★표준이 '빈 값'을 줬다고 해서 제조사로 굳히지 않는다
  //
  // 이게 왜 중요한가: 두 경로를 다 가진 보드(우리 실기기가 그 유형)가 제조사 쪽으로 잘못
  // 고정되면, 그런 보드는 제조사 쓰기를 **무시**하므로 온도 명령이 성공으로 보고되면서
  // 조용히 사라진다. 읽기는 두 경로 값이 같아 어떤 로그로도 드러나지 않는다.
  // 굳히는 근거는 '없다'는 확정 답(4.04)뿐이어야 한다.
  {
    let onceEmpty = true;
    const c = fakeClient({
      standard: { current: 29, desired: 25 },
      vendor: { current: '28.0', desired: '25.0' },
    });
    const orig = c._get.bind(c);
    c._get = async (id, segs) => {
      if (onceEmpty && segs.join('/') === 'temperature/current/0') {
        onceEmpty = false;
        c.calls.get.push(segs.join('/'));
        return { range: [16, 30], units: 'C', temperature: null };   // 응답은 했는데 값이 빈다
      }
      return orig(id, segs);
    };
    const ch = new AcTempChannel(c);

    check(await ch.readCurrent('D9') === 28, '표준이 비면 그 회차는 제조사 값으로 채운다');
    check(ch.channelOf('D9', AcTempChannel.CURRENT) === null,
      '★빈 값으로는 경로를 굳히지 않는다 (일시 상태일 수 있다)');
    check(await ch.readCurrent('D9') === 29
      && ch.channelOf('D9', AcTempChannel.CURRENT) === AcTempChannel.STANDARD,
      '값이 돌아오면 표준으로 정상 판별된다');
  }

  // ── ⑧-2 forget
  {
    const c = fakeClient({ standard: null, vendor: { current: '26.0', desired: '25.0' } });
    const ch = new AcTempChannel(c);
    await ch.readCurrent('D9b');
    check(ch.channelOf('D9b') === AcTempChannel.VENDOR, '4.04는 굳힌다 (확정 답이므로)');
    ch.forget('D9b');
    check(ch.channelOf('D9b') === null, 'forget으로 판별 결과를 버릴 수 있다');
  }

  // ── ⑧-3 공백만 든 값을 0℃로 읽지 않는다
  {
    const c = fakeClient({ standard: null, vendor: { current: '  ', desired: '25.0' } });
    const ch = new AcTempChannel(c);
    let threw = false;
    try { await ch.readCurrent('D9c'); } catch (_) { threw = true; }
    check(threw, "★공백만 든 값('  ')을 0℃로 읽지 않는다");
    check(await ch.readDesired('D9c') === 25, '같은 기기의 다른 항목은 정상 동작한다');
  }

  // ── ⑨ ★두 항목이 서로 다른 경로인 보드 (현재는 표준, 희망은 제조사)
  {
    const c = fakeClient({
      standard: { current: 27, desired: 24 },
      vendor: { current: '27.0', desired: '24.0' },
      getErr: (key) => (key === 'temperature/desired/0' ? notFound() : null),
    });
    const ch = new AcTempChannel(c);
    check(await ch.readCurrent('DA') === 27, '현재온도는 표준 경로로 읽는다');
    check(await ch.readDesired('DA') === 24, '★희망온도는 제조사 경로로 읽는다 (같은 기기인데 경로가 다르다)');
    check(ch.channelOf('DA', AcTempChannel.CURRENT) === AcTempChannel.STANDARD
      && ch.channelOf('DA', AcTempChannel.DESIRED) === AcTempChannel.VENDOR,
      '항목별로 따로 굳는다');

    await ch.writeDesired('DA', 22);
    check(c.calls.post[0].path === 'temperatures/vs/0',
      '★쓰기는 희망온도를 읽는 쪽과 같은 경로로 간다 (갈라지면 명령이 생략된다)');

    check(c.logs.filter(([lv, m]) => lv === 'info' && /표준 온도 리소스가 없어/.test(m)).length === 1,
      '두 항목이 갈려도 안내는 기기당 한 줄이다');
  }

  console.log(`\n[온도 경로 판별] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
