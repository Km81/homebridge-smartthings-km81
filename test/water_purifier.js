'use strict';

/**
 * 정수기 — ★홈킷 액세서리가 없는 첫 기기. MQTT 가 유일한 출구다.
 *
 * ★왜 이 스위트가 필요한가: 홈킷 타일이 없으니 **빠져도 사용자가 알아챌 방법이 없다.**
 *   그래서 "조용히 실패하지 않는가"가 다른 기기보다 훨씬 중요하다.
 *   실제로 배포 당일 두 번 그 일이 났다 —
 *     ① 신원 조회가 한 번 실패하자 재시작 전까지 영영 안 붙었다(v2.13.1 에서 재시도 추가)
 *     ② 연결 후 기기가 죽으면 **로그 0줄·요약선 제외·HA 는 옛 값 그대로**였다(v2.13.2)
 *
 * ⚠️여기서 재는 것은 "값이 맞는가"보다 **"틀렸을 때 티가 나는가"**다.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const MqttBridge = require('../lib/mqtt/MqttBridge');
const { attachWaterPurifier } = require('../lib/mqtt/attach');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

// hb_watch 어휘(오프라인 회귀용 최소 집합 — 정본 대조는 NAS 계측기가 한다)
const ALARM_WORDS = ['제어되지 않습니다', '사실상 클라우드로 동작 중', '폴링 실패',
  '상태 조회 실패', '상태 폴링 오류', '연결 실패', '폴링 중 오류', '상태 조회 오류', '기기 오프라인'];
const RECOVER_WORDS = ['복구', '연결됨', '로컬 복귀', '수신 복귀', '기기 접속됨',
  '폴링 회복됨', '기기 온라인 복귀'];
const hasAny = (line, words) => words.some((w) => line.includes(w));

// ── 실측 응답(2026-08-04, TP2X_WATERPURIFIER_20K) ────────────────────────────
const REAL = {
  'filter/waterfilter/vs/0': {
    'x.com.samsung.da.filterUsage': '57',          // ★사용률 — 앱은 잔여 43%
    'x.com.samsung.da.filterStatus': 'normal',
    'x.com.samsung.da.lastResetDate': '2026-01-07T12:01:45',
  },
  'status/waterpurifier/vs/0': {
    'x.com.samsung.da.status': 'Ready',
    'x.com.samsung.da.filterDoorStatus': 'Close',
    'x.com.samsung.da.sterilizeRunTime': '0',
    'x.com.samsung.da.sterilizeLastTime': '2026-08-03T17:09:20',   // ⚠️기기는 UTC
    'x.com.samsung.da.sterilizePlanTime': '2026-08-06T17:00:00',
    'x.com.samsung.da.sterilizePeriod': '3',
  },
  'setting/waterpurifier/vs/0': {
    'x.com.samsung.da.tempDesiredHotWater': '85',
    'x.com.samsung.da.desiredCapacity': '120',
    'x.com.samsung.da.desiredType': 'coldwater',
    'x.com.samsung.da.pourStatus': 'Off',
  },
  'status/lock/vs/0': {
    'x.com.samsung.da.hotwaterLock': 'Unlocked',
    'x.com.samsung.da.coldwaterLock': 'Unlocked',
    'x.com.samsung.da.buzzLock': 'Unlocked',
  },
  'selfcheck/vs/0': { 'x.com.samsung.da.status': 'Ready', 'x.com.samsung.da.result': 'Success' },
  'favorite/capacity/vs/0': {
    'x.com.samsung.da.switchCapacity': 'On',        // 앱의 '나만의 출수량' 토글
    'x.com.samsung.da.defaultCapacity': '120',
    'x.com.samsung.da.capacityList': ['120', '240', '480', '960', '9999'],
  },
};

function makeClient({ dead = false, overrides = {} } = {}) {
  const lines = [];
  const rec = (lv) => (...a) => lines.push({ lv, m: a.join(' ') });
  const log = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  const c = new LocalApplianceClient(log, { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'km81-wp-')) });
  c._ready = true;
  c.cloud = null;
  c.devices.set('WP', { host: '10.0.0.63', port: 49155, label: '정수기', fallbackToCloud: false });
  c._verified.set('WP', true);
  c._rpc = async ({ path: segs }) => {
    if (dead) { const e = new Error('로컬 요청 시간 초과'); e.sent = false; throw e; }
    const key = segs.join('/');
    if (key in overrides) return { code: 69, data: overrides[key] };
    if (!(key in REAL)) { const e = new Error('없음'); e.notFound = true; throw e; }
    return { code: 69, data: REAL[key] };
  };
  return { c, lines, log };
}

function makeBridge(log) {
  const published = [];
  const b = new MqttBridge(log, { enabled: true, host: 'x' });
  b._publish = (topic, payload) => published.push({ topic, payload });
  b._client = {};
  return { b, published };
}

(async () => {
  // ── ① 실측 응답이 그대로 발행된다 (앱 화면과 대조)
  {
    const { c, log } = makeClient();
    const { b, published } = makeBridge(log);
    const timers = [];
    const realST = global.setTimeout;
    global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
    let ok;
    try {
      ok = attachWaterPurifier({ bridge: b, log, client: c, deviceId: 'WP',
        configDevice: {}, slug: 'water_purifier', label: '정수기', platform: null });
    } finally { global.setTimeout = realST; }
    check(ok === true, 'attach 가 성공한다');

    await timers[0].fn();
    await new Promise((r) => realST(r, 30));
    const st = published.filter((p) => p.topic.endsWith('/water_purifier/state')).pop();
    const v = JSON.parse(st.payload);
    check(v.filter_remain === 43, `★사용률 57 을 **잔여 43%** 로 뒤집는다 (실측 ${v.filter_remain})`);
    check(v.hot_temp === 85 && v.capacity_ml === 120, '온수 온도·출수량이 그대로 나간다');
    check(v.pouring === 'OFF', '출수 중 아님');
    check(v.lock_hot === 'OFF' && v.lock_cold === 'OFF', 'Unlocked → 잠금 OFF');
    check(v.sterilize_last === '2026-08-03T17:09:20Z',
      `★기기가 UTC 로 주므로 Z 를 붙인다 (안 붙이면 HA 가 9시간 어긋난다) — 실측 ${v.sterilize_last}`);
    check(v.status === 'Ready' && v.selfcheck_status === 'Ready', '상태·자가진단');
    check(v.favorite_enabled === 'ON' && v.favorite_ml === 120,
      `★'나만의 출수량' 토글과 값이 나간다 (실측 ${v.favorite_enabled}/${v.favorite_ml})`);
  }

  // ── ② ★★기기가 죽으면 티가 난다 (경보 + 복구 짝)
  //    v2.13.1 까지는 getter 가 오류를 전부 삼켜 **로그 0줄**이었다. 홈킷 타일도 없으니
  //    HA 는 retained 마지막 값으로 영원히 정상처럼 보였다.
  {
    const { c, lines, log } = makeClient({ dead: true });
    const { b, published } = makeBridge(log);
    const timers = [];
    const realST = global.setTimeout;
    global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
    try {
      attachWaterPurifier({ bridge: b, log, client: c, deviceId: 'WP',
        configDevice: {}, slug: 'water_purifier', label: '정수기', platform: null });
    } finally { global.setTimeout = realST; }

    const tick = timers[0].fn;
    for (let i = 0; i < 10; i++) { await tick(); await new Promise((r) => realST(r, 5)); }

    const alarms = lines.filter((l) => l.lv === 'error' && hasAny(l.m, ALARM_WORDS));
    check(alarms.length === 1,
      `★★기기가 죽으면 경보를 낸다 (실측 ${alarms.length}줄 — 예전엔 0줄이었다)`);
    check(published.filter((p) => p.topic.endsWith('/state')).length === 0,
      '★죽은 동안 옛 값을 새 값인 척 다시 밀지 않는다');

    // 24시간 요약선에 실린다 — 예전엔 `total===0` 이라 통째로 빠졌다
    const stat = c._stats.get('WP');
    check(stat && stat.fail >= 10, `★24시간 요약 집계에 실린다 (실측 fail=${stat && stat.fail})`);

    // 복구
    c._rpc = async ({ path: segs }) => ({ code: 69, data: REAL[segs.join('/')] || {} });
    await tick();
    await new Promise((r) => realST(r, 20));
    const recov = lines.filter((l) => l.lv === 'info' && hasAny(l.m, RECOVER_WORDS));
    check(recov.length === 1,
      `★★복구도 짝으로 낸다 (없으면 감시기 🔴 가 영원히 안 풀린다) — 실측 ${recov.length}줄`);
    check(recov[0] && /클라우드 미사용/.test(recov[0].m), '클라우드를 안 썼다는 사실도 말한다');

    const seq = lines.filter((l) => hasAny(l.m, ALARM_WORDS) || hasAny(l.m, RECOVER_WORDS))
      .map((l) => (hasAny(l.m, RECOVER_WORDS) ? 'R' : 'A'));
    check(seq.join('') === 'AR', `★경보 뒤에 복구가 온다 (실측 순서: ${seq.join('') || '없음'})`);
  }

  // ── ③ 짧은 순단은 조용하다 (하루 수십 줄이 되면 안 된다)
  {
    const { c, lines, log } = makeClient({ dead: true });
    const { b } = makeBridge(log);
    const timers = [];
    const realST = global.setTimeout;
    global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
    try {
      attachWaterPurifier({ bridge: b, log, client: c, deviceId: 'WP',
        configDevice: {}, slug: 'water_purifier', label: '정수기', platform: null });
    } finally { global.setTimeout = realST; }
    const tick = timers[0].fn;
    for (let i = 0; i < 3; i++) { await tick(); await new Promise((r) => realST(r, 5)); }
    c._rpc = async ({ path: segs }) => ({ code: 69, data: REAL[segs.join('/')] || {} });
    await tick();
    await new Promise((r) => realST(r, 20));
    check(!lines.some((l) => l.lv === 'error'), '3회 순단으로는 경보하지 않는다');
    check(!lines.some((l) => l.lv === 'info' && /로컬 복귀/.test(l.m)),
      '★경보를 안 냈으면 복구도 info 로 올리지 않는다 (로그 폭주 방지)');
  }

  // ── ④ ★값이 없을 때 있는 척하지 않는다 (경계)
  {
    const { c, log } = makeClient({
      overrides: {
        'filter/waterfilter/vs/0': { 'x.com.samsung.da.filterStatus': 'normal' },   // filterUsage 없음
        'setting/waterpurifier/vs/0': { 'x.com.samsung.da.tempDesiredHotWater': '85' }, // pourStatus 없음
      },
    });
    const filter = await c.getWaterFilter('WP');
    check(filter === null,
      '★filterUsage 가 없으면 null — `Number(null)=0` 때문에 **잔여 100%(새 필터)로 오표시**되던 것');
    const setting = await c.getWaterPurifierSetting('WP');
    check(setting && setting.pouring === null,
      '★pourStatus 가 없으면 null — `!== "Off"` 라 **출수 중으로 오표시**되던 것');
  }

  // ── ⑤ slug 가 없으면(충돌) 중계하지 않는다
  {
    const { c, log } = makeClient();
    const { b, published } = makeBridge(log);
    const ok = attachWaterPurifier({ bridge: b, log, client: c, deviceId: 'WP',
      configDevice: {}, slug: null, label: '정수기', platform: null });
    check(ok === false, '★slug 충돌 시 중계하지 않는다');
    check(published.length === 0,
      '★`km81/appliance/null/state` 로 발행하지 않는다 (경고문이 거짓이 되면 안 된다)');
  }

  // ── ⑥ ★★"조회 성공·값 없음"과 "조회 실패"를 구분한다 (2026-08-05, 세 번째로 밟은 함정)
  //    둘 다 null 을 돌려주면 호출측이 undefined("안 읽음")로 바꿔 발행을 건너뛰고,
  //    **HA 센서가 옛 값에 영구 고착**된다. 오늘만 세 번 당했다 —
  //    `publishLaundryState` 의 `String(s.state||'unknown')`,
  //    `alarm && alarm.code ? … : undefined`, 그리고 새 getter 3종.
  {
    // (a) 조회는 성공했는데 값이 없다 → **객체**(필드만 null)
    const { c } = makeClient({ overrides: { 'favorite/capacity/vs/0': {} } });
    const fav = await c.getFavoriteCapacity('WP');
    check(fav !== null && fav.enabled === null,
      `★성공·빈 값이면 객체를 돌려준다(필드만 null) — 실측 ${JSON.stringify(fav)}`);

    // (b) 조회 자체가 실패 → **null**
    const dead = makeClient({ dead: true });
    const favDead = await dead.c.getFavoriteCapacity('WP');
    check(favDead === null, '★조회 실패면 null — 둘이 구분된다');

    // (c) 그래서 HA 에서 값이 **지워진다**(고착되지 않는다)
    const { log } = makeClient();
    const { b, published } = makeBridge(log);
    b.registerWaterPurifier({ slug: 'wp2', label: '정수기' });
    b.publishWaterPurifierState('wp2', { favorite_enabled: true, favorite_ml: 120 });
    b.publishWaterPurifierState('wp2', { favorite_enabled: null, favorite_ml: null });
    const last = JSON.parse(published.filter((p) => p.topic.endsWith('/wp2/state')).pop().payload);
    check(!('favorite_enabled' in last),
      `★★값이 사라지면 HA 에서도 지워진다 (옛 값 고착 금지) — 실측 ${JSON.stringify(last)}`);
  }

  // ── ⑦ ★`Number(null)`·`Number('')` 이 0 이 되어 "값 없음"을 진짜 0 으로 둔갑시키지 않는다
  //    `getWaterFilter` 에는 가드를 달아 놓고 같은 날 쓴 다른 getter 에 안 달았던 것(리뷰 M-2).
  {
    for (const bad of [null, '']) {
      const { c } = makeClient({
        overrides: {
          'favorite/capacity/vs/0': {
            'x.com.samsung.da.switchCapacity': 'On',
            'x.com.samsung.da.defaultCapacity': bad,
          },
        },
      });
      const fav = await c.getFavoriteCapacity('WP');
      check(fav && fav.default_ml === null,
        `★출수량이 ${JSON.stringify(bad)} 이면 null (0mL 아님) — 실측 ${fav && fav.default_ml}`);
    }
    // 대조군 — 진짜 0 은 0 으로 나가야 한다
    const { c } = makeClient({
      overrides: {
        'favorite/capacity/vs/0': {
          'x.com.samsung.da.switchCapacity': 'On',
          'x.com.samsung.da.defaultCapacity': '0',
        },
      },
    });
    const fav = await c.getFavoriteCapacity('WP');
    check(fav && fav.default_ml === 0, '진짜 0 은 0 으로 나간다 (대조군)');
  }

  console.log(`\n[정수기] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
