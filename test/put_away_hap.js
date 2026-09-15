'use strict';
/**
 * put_away_hap.js — 「임시 연결해제」를 **실제 hap-nodejs 로** 잰다 (v2.16.1, 2026-09-15 신설)
 *
 * 왜 있나: 2.16.0 의 회귀는 hap 을 **모형**으로 흉내 냈고, 모형이 새 방식 `onGet` 만 알아서
 *   SmartAC·세탁기의 옛 `on('get'/'set')` 리스너가 봉인을 빠져나가는 것을 못 봤다 — 스위트는 초록,
 *   승준 에어컨 타일을 누르면 `setPower` 가 나갔다(적대 리뷰 3기 독립 발견).
 *   ⇒ 여기서는 **진짜 `Accessory`·`Characteristic` 을 만들고**, 진짜 액세서리 코드를 붙인 뒤,
 *     홈 앱이 부르는 것과 같은 `handleGetRequest`·`handleSetRequest` 로 읽고 누른다.
 *
 * ⛔hap 을 못 찾으면 **건너뛰지 않고 실패**한다(「의존 패키지 없어 skip=pass」 전례).
 *   CI 는 devDependencies 의 `@homebridge/hap-nodejs` 를 설치한다. NAS 사본에서 돌릴 때는
 *   `HAP_NODEJS_PATH` 로 홈브릿지가 쓰는 hap 을 가리킨다.
 *
 * ★대조군 두 개: ①putAway 가 아니면 탭이 **실제로 명령을 보낸다** ②2.16.0 방식(`removeOnGet/Set` 만)으로
 *   떼면 **여전히 명령이 나간다** — 이 둘이 통과해야 아래의 「0회」가 뜻을 갖는다.
 */
const assert = require('assert');
const path = require('path');

function loadHap() {
  try { return require('@homebridge/hap-nodejs'); } catch (_) { /* 아래 */ }
  if (process.env.HAP_NODEJS_PATH) return require(process.env.HAP_NODEJS_PATH);
  console.log('FAIL hap-nodejs 를 찾지 못했다 — npm install(devDependencies) 또는 HAP_NODEJS_PATH 필요. 건너뛰지 않는다.');
  process.exit(1);
}
const hap = loadHap();
const REPO = path.join(__dirname, '..');
const SmartAC = require('../lib/accessories/SmartAC');
const Laundry = require('../lib/accessories/Laundry');
const LegacyAC = require('../lib/accessories/LegacyAC');
const { makePutAwayClient, PUT_AWAY_SEAL_EMPTY } = require('../lib/common/putAway');
const { installFakeTimers } = require('./_hap_stub');

const S = hap.Service, C = hap.Characteristic;
const INFO = S.AccessoryInformation.UUID;

let total = 0, failed = 0;
const t = async (name, fn) => {
  total++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e}`); }
};
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

function mkLog() {
  const lines = [];
  const push = (lv) => (...a) => lines.push([lv, a.map(String).join(' ')]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

function mkEnv() {
  const api = {
    hap,
    platformAccessory: function (name, uuid) { const a = new hap.Accessory(name, uuid); a.context = {}; return a; },
    registerPlatformAccessories() {}, updatePlatformAccessories() {}, unregisterPlatformAccessories() {},
  };
  const platform = { accessories: [], activeUUIDs: new Set(), PLUGIN_NAME: 'p', PLATFORM_NAME: 'P', registerShutdown() {} };
  return { api, platform };
}

/** 클라우드·로컬 클라이언트 흉내 — 불린 메서드 이름을 센다. 값은 그럴듯한 기본값. */
function countingClient() {
  const calls = [];
  const vals = { getPower: false, getCurrentTemperature: 25, getCoolingSetpoint: 24, getWindFree: false,
    getAutoClean: false, getWindDirection: 'Fix', getSupportedModes: [], getSupportedWindDirections: [] };
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === '__calls') return calls;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return async () => { calls.push(String(prop)); return vals[prop]; };
    },
  });
}

/** 한 특성에 대해 「홈 앱이 줄 법한 다른 값」을 고른다. */
function otherValue(ch) {
  const v = ch.value, p = ch.props;
  if (typeof v === 'boolean') return !v;
  if (Array.isArray(p.validValues) && p.validValues.length > 1) return p.validValues.find((x) => x !== v);
  if (typeof p.minValue === 'number' && typeof p.maxValue === 'number') return v === p.minValue ? p.maxValue : p.minValue;
  return undefined;
}

function charsOf(accs) {
  const out = [];
  for (const a of accs) for (const s of a.services) {
    if (s.UUID === INFO) continue;
    for (const ch of s.characteristics) out.push({ acc: a, svc: s, ch });
  }
  return out;
}

/** ★봉인 판정 — 읽기는 마지막 값, 탭은 통신 0 + 되돌림, 처리기·리스너 0. */
async function assertSealed(accs, client, label) {
  const rows = charsOf(accs);
  assert.ok(rows.length > 0, `${label}: 특성이 없다 — 판정할 것이 없다`);
  let taps = 0;
  for (const { ch } of rows) {
    const who = `${label} · ${ch.displayName}`;
    assert.strictEqual(ch.listenerCount('get') + ch.listenerCount('set'), 0, `${who}: 옛 리스너가 남았다`);
    assert.strictEqual(ch.getHandler, undefined, `${who}: onGet 이 남았다`);
    if (ch.props.perms.includes('pr') && ch.value !== null) {
      const before = ch.value;
      assert.strictEqual(await ch.handleGetRequest(), before, `${who}: 마지막 값으로 답하지 않는다`);
      assert.strictEqual(ch.statusCode, 0, `${who}: statusCode 가 남았다(응답 없음)`);
    }
    if (ch.props.perms.includes('pw') && ch.value !== null) {
      const before = ch.value, nv = otherValue(ch);
      if (nv === undefined) continue;
      await ch.handleSetRequest(nv, undefined);
      await flush();
      assert.strictEqual(ch.value, before, `${who}: 탭한 값이 남았다 — 재시작 뒤 거짓 「마지막 상태」`);
      taps++;
    }
  }
  assert.ok(taps > 0, `${label}: 누를 수 있는 특성을 하나도 못 눌렀다 — 판정 무효`);
  const calls = client && client.__calls ? client.__calls : [];
  assert.deepStrictEqual(calls, [], `${label}: 통신이 나갔다 — ${calls.join(',')}`);
  return taps;
}

/* ── SmartAC ─────────────────────────────────────────────────────── */
function buildSmartAC({ putAway, client }) {
  const env = mkEnv();
  const deviceId = 'AC-1';
  const main = env.api.platformAccessory('에어컨', hap.uuid.generate(deviceId));
  main.context.device = { deviceId, label: '에어컨' };
  // 캐시에서 복원된 모습을 흉내 낸다 — 이 값이 「마지막 상태」다.
  const hc = main.addService(S.HeaterCooler, '에어컨');
  hc.getCharacteristic(C.Active).updateValue(1);
  hc.getCharacteristic(C.CurrentTemperature).updateValue(27);
  hc.getCharacteristic(C.CoolingThresholdTemperature).updateValue(23);
  env.platform.accessories.push(main);
  for (const [k, n] of [['windfree', '무풍'], ['autoclean', '자동건조']]) {
    const sw = env.api.platformAccessory(`에어컨 - ${n}`, hap.uuid.generate(`${deviceId}:${k}`));
    sw.addService(S.Switch, n).getCharacteristic(C.On).updateValue(true);
    env.platform.accessories.push(sw);
  }
  const log = mkLog();
  const timers = installFakeTimers();
  const ac = new SmartAC({ log, api: env.api, smartthings: client, platform: env.platform });
  ac.configure(main, { deviceType: 'smartAc', deviceLabel: '에어컨', putAway, exposeWindFreeSwitch: true, exposeAutoCleanSwitch: true }, '9.9.9');
  return { env, main, ac, log, timers };
}

(async () => {
  console.log('put_away_hap — 실제 hap-nodejs 로 임시 연결해제 봉인 확인 (st)');
  console.log(`  (hap-nodejs ${require(path.join(path.dirname(require.resolve(process.env.HAP_NODEJS_PATH || '@homebridge/hap-nodejs')), '..', 'package.json')).version})`);

  await t('[대조군①] putAway 가 아니면 SmartAC 타일 탭이 실제로 명령을 보낸다', async () => {
    const client = countingClient();
    const { main, timers } = buildSmartAC({ putAway: false, client });
    try {
      const act = main.getService(S.HeaterCooler).getCharacteristic(C.Active);
      const p = act.handleSetRequest(0, undefined).catch(() => {});
      for (let i = 0; i < 5; i++) await timers.tick();
      await p;
      assert.ok(client.__calls.some((c) => /^set/.test(c)), `명령이 안 나갔다(${client.__calls.join(',')}) — 이 하네스는 무의미하다`);
    } finally { timers.restore(); }
  });

  await t('[대조군②] 2.16.0 방식(removeOnGet/removeOnSet 만)으로는 SmartAC 탭이 여전히 명령을 보낸다', async () => {
    const client = countingClient();
    const { env, main, timers } = buildSmartAC({ putAway: false, client });
    try {
      for (const { ch } of charsOf(env.platform.accessories)) { ch.removeOnGet(); ch.removeOnSet(); }
      const act = main.getService(S.HeaterCooler).getCharacteristic(C.Active);
      const p = act.handleSetRequest(0, undefined).catch(() => {});
      for (let i = 0; i < 5; i++) await timers.tick();
      await p;
      assert.ok(client.__calls.some((c) => /^set/.test(c)), '재현 실패 — 이 시험은 2.16.0 의 결함을 못 본다');
    } finally { timers.restore(); }
  });

  await t('★★SmartAC putAway — 본체·무풍·자동건조 전부 봉인, 읽기=마지막 값, 탭=통신 0·되돌림', async () => {
    const client = countingClient();
    const { env, log, timers } = buildSmartAC({ putAway: true, client });
    try {
      assert.strictEqual(env.platform.accessories.length, 3);
      const taps = await assertSealed(env.platform.accessories, client, 'SmartAC');
      for (let i = 0; i < 5; i++) await timers.tick();
      assert.deepStrictEqual(client.__calls, [], `시간이 흐른 뒤 통신이 나갔다 — ${client.__calls.join(',')}`);
      assert.ok(taps >= 4, `누른 특성이 ${taps}개뿐이다`);
      assert.ok(!log.lines.some(([, l]) => l.indexOf(PUT_AWAY_SEAL_EMPTY) !== -1), '봉인 0건 경고가 나왔다');
      const main = env.platform.accessories[0];
      const hc = main.getService(S.HeaterCooler);
      assert.deepStrictEqual(
        [hc.getCharacteristic(C.Active).value, hc.getCharacteristic(C.CurrentTemperature).value, hc.getCharacteristic(C.CoolingThresholdTemperature).value],
        [1, 27, 23], '캐시의 마지막 상태가 configure 도중 덮였다');
    } finally { timers.restore(); }
  });

  await t('★SmartAC putAway — 캐시에 저장되는 값도 마지막 상태다(탭 뒤 직렬화 왕복)', async () => {
    const client = countingClient();
    const { env, timers } = buildSmartAC({ putAway: true, client });
    try {
      const main = env.platform.accessories[0];
      const act = main.getService(S.HeaterCooler).getCharacteristic(C.Active);
      await act.handleSetRequest(0, undefined);
      await flush();
      const back = hap.Accessory.deserialize(hap.Accessory.serialize(main));
      assert.strictEqual(back.getService(S.HeaterCooler).getCharacteristic(C.Active).value, 1);
    } finally { timers.restore(); }
  });

  await t('★SmartAC putAway + 플랫폼 거부 클라이언트 — 폴 없이 시간을 돌려도 호출 0', async () => {
    const client = makePutAwayClient();
    const { env, timers } = buildSmartAC({ putAway: true, client });
    try {
      for (const { ch } of charsOf(env.platform.accessories)) {
        if (ch.props.perms.includes('pw') && ch.value !== null && otherValue(ch) !== undefined) await ch.handleSetRequest(otherValue(ch), undefined);
      }
      for (let i = 0; i < 10; i++) await timers.tick();
      await flush();
      assert.deepStrictEqual(client.__calls, []);
    } finally { timers.restore(); }
  });

  /* ── Laundry ──────────────────────────────────────────────────── */
  function buildLaundry({ putAway, client }) {
    const env = mkEnv();
    const main = env.api.platformAccessory('세탁기', hap.uuid.generate('W-1'));
    main.context.device = { deviceId: 'W-1', label: '세탁기' };
    env.platform.accessories.push(main);
    const timers = installFakeTimers();
    const l = new Laundry({ log: mkLog(), api: env.api, platform: env.platform, deviceKind: 'washer', smartthings: client });
    l.configure(main, { deviceType: 'washer', deviceLabel: '세탁기', putAway, splitCompartments: true, enableNotificationSensor: true, sensorPollInterval: 10 }, '9.9.9');
    return { env, l, timers };
  }

  await t('[대조군] 세탁기는 putAway 가 아니면 옛 리스너가 붙어 있다(봉인할 대상이 실재한다)', async () => {
    const { l, timers } = buildLaundry({ putAway: false, client: countingClient() });
    try {
      const n = charsOf(l._ownedAccessories).reduce((s, { ch }) => s + ch.listenerCount('get') + ch.listenerCount('set'), 0);
      assert.ok(n > 0, '리스너가 0 이다 — 이 시험은 무의미하다');
    } finally { timers.restore(); }
  });

  await t('★★세탁기 putAway (세탁조 분리 + 종료알림) — 액세서리 4개 전부 봉인', async () => {
    const client = countingClient();
    const { l, timers } = buildLaundry({ putAway: true, client });
    try {
      assert.strictEqual(l._ownedAccessories.length, 4);
      await assertSealed(l._ownedAccessories, client, 'Laundry');
      for (let i = 0; i < 10; i++) await timers.tick();
      assert.deepStrictEqual(client.__calls, []);
    } finally { timers.restore(); }
  });

  /* ── LegacyAC (구형 에어컨 — 새 방식 onGet) ─────────────────────── */
  function buildLegacy({ putAway }) {
    const env = mkEnv();
    const acc = env.api.platformAccessory('구형', hap.uuid.generate('L-1'));
    acc.addService(S.HeaterCooler, '구형').getCharacteristic(C.Active).updateValue(1);
    const log = mkLog();
    const timers = installFakeTimers();
    const logic = new LegacyAC({ log, api: env.api, accessory: acc, packageRoot: REPO,
      config: { name: '구형', ip: `10.78.0.${Math.floor(Math.random() * 250) + 1}`, token: 'x'.repeat(10), putAway } });
    const calls = [];
    const proto = Object.getPrototypeOf(logic.client);
    const restore = [];
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === 'constructor' || typeof proto[k] !== 'function') continue;
      const orig = logic.client[k];
      logic.client[k] = function (...a) { calls.push(k); return Promise.reject(new Error('시험 — 통신 차단')); };
      restore.push(() => { delete logic.client[k]; void orig; });
    }
    return { acc, logic, calls, timers, restore: () => { restore.forEach((f) => f()); timers.restore(); } };
  }

  await t('[대조군] 구형 에어컨은 putAway 가 아니면 탭이 클라이언트를 부른다', async () => {
    const b = buildLegacy({ putAway: false });
    try {
      const act = b.acc.getService(S.HeaterCooler).getCharacteristic(C.Active);
      await act.handleSetRequest(0, undefined).catch(() => {});
      for (let i = 0; i < 3; i++) await b.timers.tick();
      assert.ok(b.calls.length > 0, '클라이언트 호출 0 — 이 시험은 무의미하다');
    } finally { if (b.logic.shutdown) b.logic.shutdown(); b.restore(); }
  });

  await t('★구형 에어컨 putAway — 봉인, 읽기=마지막 값, 탭=통신 0', async () => {
    const b = buildLegacy({ putAway: true });
    try {
      assert.strictEqual(b.logic._initialized, true);
      await assertSealed([b.acc], { __calls: b.calls }, 'LegacyAC');
      for (let i = 0; i < 5; i++) await b.timers.tick();
      assert.deepStrictEqual(b.calls, []);
    } finally { b.restore(); }
  });

  console.log(`\n총 ${total}건 · 실패 ${failed}건`);
  process.exit(failed ? 1 : 0);
})();
