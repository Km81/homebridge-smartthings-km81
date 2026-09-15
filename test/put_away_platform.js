'use strict';
/**
 * put_away_platform.js — 「임시 연결해제」 플랫폼 계층 회귀 (v2.16.1, 2026-09-15 신설)
 *
 * 왜 따로 있나: 2.16.0 은 액세서리 계층만 막았고, 플랫폼(index.js)에는 putAway 검사가 두 곳뿐이었다.
 *   적대 리뷰가 찾은 누수 —
 *     ①deviceId 없는 로컬 기기에 **기동 신원 조회(DTLS)** 를 보냈다(`_resolveLocalDeviceIds→_probeOne`)
 *     ②로컬 브릿지·8888 클라이언트에 **등록**했다(`로컬 경로 등록` 로그 + 일일 요약 타이머)
 *     ③putAway 정수기·에어컨 때문에 **파이썬 브릿지를 띄웠다**
 *   ★여기서는 LocalApplianceClient 를 **모듈 캐시에 스텁으로 주입**한다(first_boot.js 와 같은 방식) —
 *   다른 스위트와 섞이면 서로를 오염시키므로 파일을 나눴다.
 *
 * ⚠️대조군을 반드시 함께 잰다 — 「0회」는 아무것도 안 돌아도 참이다.
 */
const assert = require('assert');

let total = 0, failed = 0;
const t = async (name, fn) => {
  total++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message}`); }
};

// ── LocalApplianceClient 스텁(index.js 가 require 하기 전에) ──
const target = require.resolve('../lib/api/LocalApplianceClient.js');
let made = 0;
class StubLocalClient {
  constructor() { made += 1; }
  isInstalling() { return false; }
  start() { return Promise.resolve(); }
  stop() {}
  registerDevice() {}
}
require.cache[target] = { id: target, filename: target, loaded: true, children: [], paths: [], exports: StubLocalClient };

let Platform = null;
require('../index.js')({
  hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => s } },
  registerPlatform: (_p, _n, cls) => { Platform = cls; },
});
const P = Platform.prototype;
const { PUT_AWAY_MESSAGE } = require('../lib/common/putAway');

function mkLog() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    debug: () => {},
  };
}

(async () => {
  console.log('put_away_platform — 임시 연결해제 플랫폼 계층 회귀 (st)');

  /* ── ① _clientFor — 보낼 수단을 주지 않는다 ─────────────────────── */
  const mkClientSelf = () => {
    const seen = { register: 0 };
    return {
      seen,
      self: {
        log: mkLog(),
        smartthings: { name: 'cloud' },
        localClient: { registerDevice: () => { seen.register += 1; } },
        _legacyLaundryClients: new Map(),
      },
    };
  };

  await t('★로컬 에어컨이 putAway 면 브릿지에 등록하지 않고 거부 클라이언트를 받는다', async () => {
    const { self, seen } = mkClientSelf();
    const c = P._clientFor.call(self, { deviceType: 'smartAc', transport: 'local', local: { host: '10.0.0.9' }, putAway: true }, 'AC1');
    assert.strictEqual(seen.register, 0, '로컬 브릿지에 등록했다 — 일일 요약 타이머가 돈다');
    assert.ok(Array.isArray(c.__calls), '거부 클라이언트가 아니다');
    await assert.rejects(c.setPower('AC1', true));
  });
  await t('★8888 세탁기가 putAway 면 클라이언트를 만들지 않는다(로컬 경로 등록 로그 0)', async () => {
    const { self } = mkClientSelf();
    P._clientFor.call(self, { deviceType: 'washer', transport: 'local', local: { host: '10.0.0.8', token: 'x'.repeat(10) }, putAway: true }, 'W1');
    assert.strictEqual(self._legacyLaundryClients.size, 0);
    assert.strictEqual(self.log.lines.info.length, 0, `로그가 나왔다: ${self.log.lines.info.join(' | ')}`);
  });
  await t('★클라우드 기기도 putAway 면 클라우드 클라이언트를 주지 않는다', async () => {
    const { self } = mkClientSelf();
    const c = P._clientFor.call(self, { deviceType: 'dryer', putAway: true }, 'D1');
    assert.notStrictEqual(c, self.smartthings);
  });
  await t('[대조군] putAway 가 아니면 로컬 브릿지에 등록한다', async () => {
    const { self, seen } = mkClientSelf();
    const c = P._clientFor.call(self, { deviceType: 'smartAc', transport: 'local', local: { host: '10.0.0.9' } }, 'AC1');
    assert.strictEqual(seen.register, 1, '대조군이 등록하지 않았다 — 이 시험은 무의미하다');
    assert.strictEqual(c, self.localClient);
  });

  /* ── ② _resolveLocalDeviceIds — 기기에게 묻지 않는다 ───────────────── */
  const mkResolveSelf = ({ discovered = {}, accessories = [], localClient = true } = {}) => {
    const seen = { probe: 0, retry: 0 };
    const self = {
      log: mkLog(),
      accessories,
      smartthings: null,
      localClient: localClient ? {
        readDiscovered: (host) => discovered[host] || null,
        probeIdentity: async () => { seen.probe += 1; throw new Error('기기 무응답'); },
        writeDiscovered: () => {},
      } : null,
      _putAwayIdFromRecords: P._putAwayIdFromRecords,
      _probeOne: P._probeOne,
      _scheduleLocalIdRetry: () => { seen.retry += 1; },
    };
    return { self, seen };
  };
  const paDev = (extra = {}) => ({ deviceType: 'smartAc', deviceLabel: '에어컨', transport: 'local', local: { host: '10.0.0.9' }, putAway: true, ...extra });

  await t('★putAway + discovered 캐시 → 캐시로 정하고 기기에 묻지 않는다', async () => {
    const { self, seen } = mkResolveSelf({ discovered: { '10.0.0.9': { deviceId: 'AC1', name: 'x' } } });
    const d = paDev();
    const ok = await P._resolveLocalDeviceIds.call(self, [d]);
    assert.strictEqual(seen.probe, 0, `신원 조회가 ${seen.probe}회 나갔다`);
    assert.strictEqual(d.deviceId, 'AC1');
    assert.strictEqual(ok, true);
  });
  await t('★putAway + 캐시 액세서리(같은 IP) → 액세서리로 정한다', async () => {
    const acc = { context: { device: { deviceId: 'AC2', label: '에어컨' }, configDevice: { local: { host: '10.0.0.9' } } } };
    const { self, seen } = mkResolveSelf({ accessories: [acc] });
    const d = paDev();
    const ok = await P._resolveLocalDeviceIds.call(self, [d]);
    assert.strictEqual(seen.probe, 0);
    assert.strictEqual(d.deviceId, 'AC2');
    assert.strictEqual(ok, true);
  });
  await t('⛔putAway + 기록 없음 → 묻지도 재시도하지도 않고, 정리 억제(false)를 돌려준다', async () => {
    const { self, seen } = mkResolveSelf();
    const d = paDev();
    const ok = await P._resolveLocalDeviceIds.call(self, [d]);
    assert.strictEqual(seen.probe, 0, '기기에 물었다');
    assert.strictEqual(seen.retry, 0, '재시도를 예약했다 — 12회 동안 물으려 한다');
    assert.strictEqual(ok, false, 'true 를 돌려주면 그 기기의 액세서리가 stale 로 지워질 수 있다');
    assert.ok(self.log.lines.info.some((l) => l.indexOf(PUT_AWAY_MESSAGE) !== -1), '안내 줄이 없다');
    assert.strictEqual(self.log.lines.warn.length + self.log.lines.error.length, 0, '경고·오류를 냈다');
  });
  await t('⛔브릿지가 없어도(전부 연결해제) 기록 없는 putAway 는 정리 억제를 돌려준다', async () => {
    const { self } = mkResolveSelf({ localClient: false });
    assert.strictEqual(await P._resolveLocalDeviceIds.call(self, [paDev()]), false);
  });
  await t('[대조군] putAway 가 아니면 실제로 기기에 묻는다', async () => {
    const { self, seen } = mkResolveSelf();
    await P._resolveLocalDeviceIds.call(self, [paDev({ putAway: false })]);
    assert.ok(seen.probe >= 1, '대조군이 묻지 않았다 — 이 시험은 무의미하다');
  });

  /* ── ③ _didFinishLaunching — putAway 때문에 브릿지를 띄우지 않는다 ─────────── */
  const mkBootSelf = (devices) => ({
    log: mkLog(),
    api: { user: { storagePath: () => '/tmp/km81' } },
    config: {},
    accessories: [],
    mqtt: { enabled: false },
    devices,
    smartthings: { init: async () => true },
    registerShutdown: () => {},
    _setupWaterPurifier: async () => {},
    _resolveLocalDeviceIds: async () => true,
    _bindByConfiguredIds: () => [],
    _cleanupStaleAccessories: () => {},
    _startCloudKeepalive: () => {},
  });
  await t('★로컬 기기가 전부 putAway 면 파이썬 브릿지를 띄우지 않는다(정수기 포함)', async () => {
    made = 0;
    await P._didFinishLaunching.call(mkBootSelf([
      { deviceType: 'smartAc', deviceId: 'AC1', deviceLabel: 'a', transport: 'local', local: { host: '10.0.0.9' }, putAway: true },
      { deviceType: 'waterPurifier', deviceLabel: 'p', local: { host: '10.0.0.7' }, putAway: true },
    ]));
    assert.strictEqual(made, 0, '브릿지 클라이언트를 만들었다');
  });
  await t('[대조군] putAway 가 아닌 로컬 기기가 하나라도 있으면 브릿지를 띄운다', async () => {
    made = 0;
    await P._didFinishLaunching.call(mkBootSelf([
      { deviceType: 'smartAc', deviceId: 'AC1', deviceLabel: 'a', transport: 'local', local: { host: '10.0.0.9' }, putAway: true },
      { deviceType: 'smartAc', deviceId: 'AC2', deviceLabel: 'b', transport: 'local', local: { host: '10.0.0.10' } },
    ]));
    assert.strictEqual(made, 1, '대조군이 브릿지를 안 띄웠다 — 이 시험은 무의미하다');
  });

  /* ── ④ _attachMqtt — 회수는 안 하고 토픽 이름은 지킨다 ─────────────── */
  await t('★putAway 는 회수하지 않고 slug 를 예약해, 같은 종류 다른 기기가 이름을 못 가져간다', async () => {
    let retracted = 0;
    const self = {
      log: mkLog(), mqtt: { enabled: true, base: 'km81' },
      _mqttSlug: P._mqttSlug, _retractMqtt: () => { retracted += 1; },
    };
    P._attachMqtt.call(self, { displayName: 'A', context: { device: { deviceId: 'AAA111' } } },
      { deviceType: 'smartAc', deviceLabel: 'A', putAway: true }, {});
    assert.strictEqual(retracted, 0, '회수했다 — HA 엔티티가 사라진다');
    assert.ok(self._usedSlugs && self._usedSlugs.has('smartac'), 'slug 를 예약하지 않았다');
    const other = P._mqttSlug.call(self, { deviceType: 'smartAc', deviceLabel: 'B' }, 'BBB222');
    assert.notStrictEqual(other, 'smartac', '다른 기기가 putAway 기기의 토픽을 가져갔다 — HA 엔티티가 두 벌이 된다');
    assert.strictEqual(self.log.lines.info.filter((l) => /중계 시작/.test(l)).length, 0, '중계를 시작했다');
  });

  /* ── ⑤ keepalive — 계정 토큰은 계속 살린다(의도) ─────────────────── */
  await t('★전부 putAway 여도 토큰 keepalive 는 건다 (봄에 풀 때 재인증 요구 방지)', async () => {
    const stops = [];
    const self = {
      log: mkLog(), smartthings: { _refreshTokenSingleFlight: async () => {} },
      devices: [{ deviceType: 'smartAc', transport: 'local', local: { host: '10.0.0.9' }, putAway: true }],
      registerShutdown: (fn) => stops.push(fn),
    };
    P._startCloudKeepalive.call(self);
    stops.forEach((fn) => fn());
    assert.ok(self.log.lines.info.some((l) => /keepalive 활성/.test(l)), 'keepalive 를 걸지 않았다');
  });

  console.log(`\n총 ${total}건 · 실패 ${failed}건`);
  process.exit(failed ? 1 : 0);
})();
