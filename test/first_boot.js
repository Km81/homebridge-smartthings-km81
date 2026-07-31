'use strict';
/**
 * first_boot.js — 첫 부팅(의존성 설치 중) 계약 (v2.6.10 신설)
 *
 * 왜 별도 파일인가: 여기서는 `LocalApplianceClient`를 **모듈 캐시에 스텁으로 주입**한 뒤
 * index.js를 불러온다. 같은 프로세스에서 진짜 클라이언트를 쓰는 다른 스위트와 섞이면
 * 서로를 오염시킨다.
 *
 * 무엇을 지키나:
 *   v2.6.7이 "설치 중이면 조기 return"을 넣었는데, 그 return은 `_didFinishLaunching`을
 *   통째로 빠져나가 **토큰 로드 → 기기 바인딩 → stale 정리 → 클라우드 keepalive**를 전부
 *   건너뛰었다. pip은 최대 180초인데 기동 예산은 20초라 **성공하는 첫 설치도 반드시** 그
 *   분기를 지난다 → 모든 신규 사용자의 첫 부팅에서 SmartThings 기기가 하나도 안 붙었다.
 *   (홈 앱에는 캐시 액세서리가 보이는데 리스너가 없어 조작이 조용히 사라진다.)
 *   정작 그 바로 위 주석이 "기동 예산을 두는 이유 = 그 무성 유실을 막으려고"라고 적고 있었다.
 */
const assert = require('assert');

let pass = 0;
const fail = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.log(`  ✗ ${name}\n      ${e.message}`); }
};

// ── LocalApplianceClient를 스텁으로 갈아끼운다(index.js가 require 하기 전에) ──
const target = require.resolve('../lib/api/LocalApplianceClient.js');
let made = null;
class StubLocalClient {
  constructor(log, opts) { this.log = log; this.opts = opts; made = this; }
  isInstalling() { return true; }                       // 설치 진행 중
  start() { return Promise.reject(new Error('기동 대기 20초 초과')); }
  stop() {}
  registerDevice() {}
}
require.cache[target] = {
  id: target, filename: target, loaded: true, children: [], paths: [],
  exports: StubLocalClient,
};

let Platform = null;
require('../index.js')({
  hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => s } },
  registerPlatform: (_p, _n, cls) => { Platform = cls; },
});

const mkSelf = (overrides = {}) => {
  const seen = { bind: false, cleanup: false, keepalive: false, init: false };
  const lines = { info: [], warn: [], error: [] };
  const self = {
    log: {
      info: (m) => lines.info.push(String(m)),
      warn: (m) => lines.warn.push(String(m)),
      error: (m) => lines.error.push(String(m)),
      debug: () => {},
    },
    api: { user: { storagePath: () => '/tmp/km81' } },
    config: {},
    accessories: [],
    mqtt: { enabled: false },
    devices: [{
      deviceType: 'smartAc', deviceId: 'dev-1', deviceLabel: '신형 에어컨',
      transport: 'local', local: { host: '10.0.0.9', fallbackToCloud: true },
    }],
    smartthings: { init: async () => { seen.init = true; return true; } },
    registerShutdown: () => {},
    _resolveLocalDeviceIds: async () => true,   // v2.7.0 — 이 시나리오의 관심사가 아니다
    _bindByConfiguredIds: () => { seen.bind = true; return []; },
    _cleanupStaleAccessories: () => { seen.cleanup = true; },
    _startCloudKeepalive: () => { seen.keepalive = true; },
    ...overrides,
  };
  return { self, seen, lines };
};

(async () => {
  console.log('\n[첫 부팅 — 의존성 설치 중]');

  await t('★설치가 진행 중이어도 기기 바인딩을 계속한다 (첫 부팅에 아무것도 안 붙던 결함)', async () => {
    const { self, seen } = mkSelf();
    await Platform.prototype._didFinishLaunching.call(self);
    assert.ok(seen.init, 'OAuth 토큰 로드를 건너뛰었다 — 클라우드 폴백까지 죽는다');
    assert.ok(seen.bind, '기기 바인딩을 건너뛰었다 — 홈킷 조작이 조용히 사라진다');
  });

  await t('★설치가 진행 중이어도 클라우드 keepalive와 stale 정리를 건너뛰지 않는다', async () => {
    const { self, seen } = mkSelf();
    await Platform.prototype._didFinishLaunching.call(self);
    assert.ok(seen.keepalive, 'keepalive 미등록 — 폴백 토큰이 만료된다');
    assert.ok(seen.cleanup, 'stale 정리를 건너뛰었다');
  });

  await t('설치 중이라는 사실을 알리되, 재시작 없이 전환된다고 정확히 말한다', async () => {
    const { self, lines } = mkSelf();
    await Platform.prototype._didFinishLaunching.call(self);
    assert.ok(lines.info.some((l) => /설치가 진행 중/.test(l)), '설치 중 안내가 없다');
    assert.ok(!lines.error.some((l) => /기동 지연\/실패/.test(l)),
      '설치 중인데 실패로 보고했다 — 신규 사용자가 가짜 실패를 본다');
  });

  await t('설치가 아닌 진짜 실패는 실패로 보고한다 (대조군)', async () => {
    const { self, lines } = mkSelf();
    const orig = StubLocalClient.prototype.isInstalling;
    StubLocalClient.prototype.isInstalling = () => false;
    try {
      await Platform.prototype._didFinishLaunching.call(self);
      assert.ok(lines.error.some((l) => /기동 지연\/실패/.test(l)), '실패를 알리지 않는다');
    } finally { StubLocalClient.prototype.isInstalling = orig; }
  });

  // ★v2.6.13 — OAuth 항목 없이도 '완전 로컬' 구성은 동작한다.
  // deviceId를 직접 적고 transport=local이며 폴백까지 끈 기기는 클라우드를 한 번도 쓰지 않는다.
  // 그런데도 "clientId, clientSecret, redirectUri가 필요합니다"를 error로 찍고 있었다 —
  // 사실이 아닌 문구였다(실측: OAuth 항목을 전부 비워도 기기는 로컬 경로에 등록된다).
  console.log('\n[OAuth 항목 없이 — 완전 로컬 구성]');

  function ACC(n, u) {
    this.displayName = n; this.UUID = u; this.services = []; this.context = {};
    const ch = {
      onGet: () => ch, onSet: () => ch, setProps: () => ch, updateValue: () => ch,
      on: () => ch, removeAllListeners: () => ch, value: null,
    };
    const svc = {
      setCharacteristic: () => svc, getCharacteristic: () => ch, testCharacteristic: () => true,
      updateCharacteristic: () => svc, addOptionalCharacteristic: () => svc, subtype: null,
    };
    this.getService = () => svc; this.addService = () => svc; this.removeService = () => {};
  }

  const mkPlatform = (devices) => {
    const L = { info: [], warn: [], error: [] };
    const log = {
      info: (...a) => L.info.push(a.join(' ')), warn: (...a) => L.warn.push(a.join(' ')),
      error: (...a) => L.error.push(a.join(' ')), debug: () => {},
    };
    const api = {
      hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => 'uuid-' + s } },
      on: () => {}, once: () => {}, platformAccessory: ACC,
      registerPlatformAccessories: () => {}, unregisterPlatformAccessories: () => {},
      updatePlatformAccessories: () => {},
      user: { storagePath: () => require('os').tmpdir() },
    };
    // OAuth 3종을 통째로 비운 config
    return { p: new Platform(log, { platform: 'x', name: 'x', devices }, api), L };
  };

  const LOCAL_ONLY = [{
    deviceType: 'smartAc', deviceLabel: '신형 에어컨',
    deviceId: '11111111-2222-3333-4444-555555555555',
    transport: 'local', local: { host: '10.0.0.9', fallbackToCloud: false },
  }];

  await t('★완전 로컬 구성에서는 OAuth 항목을 요구하지 않는다', () => {
    const { L } = mkPlatform(LOCAL_ONLY);
    assert.ok(!L.error.some((l) => /clientId/.test(l)),
      '필요 없는 OAuth 항목을 필요하다고 오류로 찍었다');
    assert.ok(L.info.some((l) => /로컬 전용으로 동작합니다/.test(l)), '로컬 전용 안내가 없다');
  });

  await t('폴백이 켜져 있으면 여전히 OAuth 항목을 요구한다 (대조군)', () => {
    const withFallback = [{ ...LOCAL_ONLY[0], local: { host: '10.0.0.9', fallbackToCloud: true } }];
    const { L } = mkPlatform(withFallback);
    assert.ok(L.error.some((l) => /clientId/.test(l)), '클라우드를 쓰는데 요구하지 않았다');
  });

  // ⚠️v2.7.0에서 뒤집힌 계약: 'deviceId 없음 = 클라우드 필요'는 더 이상 참이 아니다.
  //   로컬 기기는 부팅 때 기기에게 직접 물어 deviceId를 얻는다. 대조군을 실제로 남는
  //   조건으로 바꾼다 — 기기 IP가 없으면 물어볼 곳이 없다.
  await t('기기 IP가 없으면 여전히 OAuth 항목을 요구한다 (대조군)', () => {
    const noHost = [{ deviceType: 'smartAc', deviceLabel: '신형 에어컨',
      transport: 'local', local: { fallbackToCloud: false } }];
    const { L } = mkPlatform(noHost);
    assert.ok(L.error.some((l) => /clientId/.test(l)), '물어볼 IP가 없는데 요구하지 않았다');
  });

  await t('전송 경로가 클라우드면 여전히 OAuth 항목을 요구한다 (대조군)', () => {
    const cloud = [{ deviceType: 'smartAc', deviceLabel: '신형 에어컨', deviceId: 'x' }];
    const { L } = mkPlatform(cloud);
    assert.ok(L.error.some((l) => /clientId/.test(l)), '클라우드 전송인데 요구하지 않았다');
  });

  // ★★v2.7.0 — deviceId 없이 IP만 적어도 기기에게 물어 알아낸다.
  console.log('\n[deviceId 로컬 자동 확인]');

  const IP_ONLY = () => [{
    deviceType: 'smartAc', deviceLabel: '신형 에어컨',
    transport: 'local', local: { host: '10.0.0.9', fallbackToCloud: false },
  }];
  const DI = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // _resolveLocalDeviceIds만 떼어 검증한다(바인딩은 위 시나리오가 이미 덮는다).
  const runResolve = async ({ probe, cached }) => {
    const L = { info: [], warn: [] };
    const self = {
      log: { info: (m) => L.info.push(String(m)), warn: (m) => L.warn.push(String(m)),
        error: (m) => L.warn.push(String(m)), debug: () => {} },
      localClient: {
        readDiscovered: () => cached || null,
        writeDiscovered: (h, r) => { L.wrote = { h, ...r }; },
        probeIdentity: probe,
      },
      // ★내부 헬퍼는 **진짜 구현**을 붙인다 — 스텁으로 대체하면 계약이 빈 껍데기가 된다.
      _probeOne: Platform.prototype._probeOne,
      _scheduleLocalIdRetry: () => { L.retryScheduled = true; },
      registerShutdown: () => {},
      _bindSmartThingsDevice: () => {},
      _cleanupStaleAccessories: () => {},
    };
    const devs = IP_ONLY();
    const ok = await Platform.prototype._resolveLocalDeviceIds.call(self, devs);
    return { ok, devs, L };
  };

  await t('★IP만 적어도 기기에게 물어 deviceId를 채운다', async () => {
    const r = await runResolve({ probe: async () => ({ deviceId: DI, name: 'Samsung Window A/C' }) });
    assert.strictEqual(r.devs[0].deviceId, DI, 'deviceId가 채워지지 않았다');
    assert.strictEqual(r.ok, true);
    assert.ok(r.L.info.some((l) => /기기에서 확인했습니다/.test(l)), '확인 사실을 알리지 않는다');
  });

  await t('★한 번 알아낸 값은 디스크에 남긴다 (다음 부팅에 기기가 꺼져 있어도 되게)', async () => {
    const r = await runResolve({ probe: async () => ({ deviceId: DI, name: 'AC' }) });
    assert.ok(r.L.wrote && r.L.wrote.deviceId === DI, '캐시에 쓰지 않았다');
    assert.strictEqual(r.L.wrote.h, '10.0.0.9', '캐시 키가 IP가 아니다');
  });

  await t('캐시가 있으면 기기에 묻지 않는다', async () => {
    let asked = false;
    const r = await runResolve({
      probe: async () => { asked = true; return { deviceId: DI }; },
      cached: { deviceId: DI, name: 'AC' },
    });
    assert.strictEqual(asked, false, '캐시가 있는데 또 물었다');
    assert.strictEqual(r.devs[0].deviceId, DI);
  });

  await t('★조회 실패 시 false를 돌려 stale 정리를 막는다 (액세서리 보존)', async () => {
    const r = await runResolve({ probe: async () => { throw new Error('무응답'); } });
    assert.strictEqual(r.ok, false, 'true를 돌려주면 캐시 액세서리가 삭제된다');
    assert.strictEqual(r.devs[0].deviceId, undefined);
    assert.ok(r.L.warn.some((l) => /아직 확인하지 못했습니다/.test(l)), '실패를 알리지 않는다');
  });

  // ★★v2.7.2 — 첫 설치는 pip이 수 분이라 이 시점에 브릿지가 아직 안 떠 있다.
  // 재시도가 없으면 IP만 적은 기기가 첫 부팅에 한 대도 안 붙는다(v2.7.1까지의 상태).
  await t('★조회에 실패하면 재시도를 예약한다 (첫 부팅에 0대 붙던 결함)', async () => {
    const r = await runResolve({ probe: async () => { throw new Error('로컬 브릿지 미준비'); } });
    assert.strictEqual(r.L.retryScheduled, true, '재시도를 예약하지 않아 영영 안 붙는다');
  });

  await t('원인이 브릿지면 기기·IP를 지목하지 않는다', async () => {
    const r = await runResolve({ probe: async () => { throw new Error('로컬 브릿지 미준비'); } });
    assert.ok(r.L.warn.some((l) => /브릿지가 준비되면 자동으로 다시 시도/.test(l)),
      '브릿지 문제인데 기기·IP를 확인하라고 한다');
  });

  await t('원인이 기기면 기기·IP를 지목한다 (대조군)', async () => {
    const r = await runResolve({ probe: async () => { throw new Error('로컬 요청 시간 초과'); } });
    assert.ok(r.L.warn.some((l) => /기기 전원과 IP를 확인하세요/.test(l)));
  });

  await t('★기기가 알려준 이름을 라벨로 쓴다 (비우면 홈킷 이름이 UUID가 된다)', async () => {
    const r = await runResolve({ probe: async () => ({ deviceId: DI, name: 'Samsung Window A/C' }) });
    // 라벨을 비운 구성에서만 채운다
    const L2 = { info: [], warn: [] };
    const devs = [{ deviceType: 'smartAc', transport: 'local',
      local: { host: '10.0.0.9', fallbackToCloud: false } }];
    const self2 = {
      log: { info: (m) => L2.info.push(String(m)), warn: () => {}, error: () => {}, debug: () => {} },
      localClient: { readDiscovered: () => null, writeDiscovered: () => {},
        probeIdentity: async () => ({ deviceId: DI, name: 'Samsung Window A/C' }) },
      _probeOne: Platform.prototype._probeOne,
      _scheduleLocalIdRetry: () => {}, registerShutdown: () => {},
      _bindSmartThingsDevice: () => {}, _cleanupStaleAccessories: () => {},
    };
    await Platform.prototype._resolveLocalDeviceIds.call(self2, devs);
    assert.strictEqual(devs[0].deviceLabel, 'Samsung Window A/C', '이름을 받아 놓고 버렸다');
    assert.ok(r.devs[0].deviceId === DI);
  });

  await t('IP만 적은 완전 로컬 구성도 OAuth 항목을 요구하지 않는다', () => {
    const { L } = mkPlatform(IP_ONLY());
    assert.ok(!L.error.some((l) => /clientId/.test(l)),
      'deviceId는 기기에서 얻는데 OAuth를 요구했다');
  });

  await t('8888 토큰 기기(세탁기)는 deviceId가 없으면 여전히 요구한다 (조회 경로 없음)', () => {
    const washer = [{ deviceType: 'washer', deviceLabel: '세탁기', transport: 'local',
      local: { host: '10.0.0.8', token: 'x', fallbackToCloud: false } }];
    const { L } = mkPlatform(washer);
    assert.ok(L.error.some((l) => /clientId/.test(l)), '8888 기기는 di를 못 읽는데 요구하지 않았다');
  });

  // ⛔★v2.7.1 — 정리 억제 신호가 서로를 덮어쓰면 사용자 액세서리가 영구 삭제된다.
  // v2.7.0은 클라우드 조회 결과를 stDiscoverySucceeded에 그대로 대입해 localIdOk를 삼켰다.
  // 로컬 기기가 응답 없는 부팅 + 다른 기기의 클라우드 조회 성공이 겹치면 정리가 돌아
  // 자동화·방 배치·종료 알림 센서가 함께 사라진다.
  console.log('\n[stale 정리 억제 — 두 신호 독립성]');

  const runLaunch = async ({ localIdOk, cloudOk, hasCloud = true }) => {
    const L = { warn: [], info: [] };
    let cleaned = false;
    const self = {
      log: { info: (m) => L.info.push(String(m)), warn: (m) => L.warn.push(String(m)),
        error: () => {}, debug: () => {} },
      api: { user: { storagePath: () => require('os').tmpdir() } },
      config: {}, accessories: [], mqtt: { enabled: false },
      devices: [
        { deviceType: 'smartAc', deviceLabel: 'IP만', transport: 'local',
          local: { host: '10.0.0.9', fallbackToCloud: false } },
        { deviceType: 'dryer', deviceLabel: '클라우드 기기' },
      ],
      smartthings: hasCloud ? { init: async () => true } : null,
      registerShutdown: () => {},
      _resolveLocalDeviceIds: async () => localIdOk,
      _bindByConfiguredIds: () => [{ deviceType: 'dryer', deviceLabel: '클라우드 기기' }],
      _discoverAndBindSmartThings: async () => cloudOk,
      _cleanupStaleAccessories: () => { cleaned = true; },
      _startCloudKeepalive: () => {},
    };
    await Platform.prototype._didFinishLaunching.call(self);
    return { cleaned, L };
  };

  await t('★로컬 조회가 실패하면 클라우드 조회가 성공해도 정리하지 않는다', async () => {
    const r = await runLaunch({ localIdOk: false, cloudOk: true });
    assert.strictEqual(r.cleaned, false,
      '액세서리를 삭제했다 — 사용자 자동화·방 배치가 영구 소실된다');
    assert.ok(r.L.warn.some((l) => /로컬 기기의 deviceId를 확인하지 못해/.test(l)),
      '억제 사유가 로컬 조회 실패임을 알리지 않는다');
  });

  await t('클라우드 조회가 실패하면 로컬이 성공해도 정리하지 않는다 (대조군)', async () => {
    const r = await runLaunch({ localIdOk: true, cloudOk: false });
    assert.strictEqual(r.cleaned, false);
    assert.ok(r.L.warn.some((l) => /SmartThings 장치 검색이 실패/.test(l)));
  });

  await t('둘 다 성공하면 정리한다 (대조군 — 억제를 너무 넓히지 않았는지)', async () => {
    const r = await runLaunch({ localIdOk: true, cloudOk: true });
    assert.strictEqual(r.cleaned, true, '정상 상황인데 정리를 건너뛰면 고아 액세서리가 쌓인다');
  });

  // ★v2.7.1 — pip 재설치가 실제로 파일을 바꾸는가
  console.log('\n[pip 재설치 — --upgrade]');

  await t('★pip 인자에 --upgrade가 있다 (없으면 재설치가 무동작인데 성공으로 기록된다)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'api', 'LocalApplianceClient.js'), 'utf8');
    const m = src.match(/'-m',\s*'pip',\s*'install',([\s\S]{0,80}?)this\.libDir/);
    assert.ok(m, 'pip 호출부를 찾지 못했다');
    assert.ok(/--upgrade/.test(m[1]),
      "--upgrade가 없다 — 파일이 이미 있으면 pip이 건너뛰고 exit 0을 주는데 우리는 성공으로 판정한다");
  });

  // ⛔★v2.7.3 — 재시도 타이머 **본문**을 실제로 돌린다.
  // v2.7.2의 계약은 `_scheduleLocalIdRetry`를 스텁으로 대체해서, 타이머 안쪽 코드가
  // 한 번도 실행된 적이 없었다. 그 안에 v2.7.1이 막은 것과 같은 급의 결함 2개가 들어 있었다.
  // "요구사항을 테스트에 적는 것과, 그 계약을 우회하는 새 상태에 테스트를 붙이는 것은 다른 일."
  console.log('\n[재시도 타이머 본문]');

  const runRetry = async ({ cloudOk, probes, lateFill = null }) => {
    const L = { info: [], warn: [], error: [] };
    let cleaned = 0;
    const bound = [];
    const devs = [
      { deviceType: 'smartAc', deviceLabel: 'A', transport: 'local', local: { host: '10.0.0.1' } },
    ];
    const self = {
      log: { info: (m) => L.info.push(String(m)), warn: (m) => L.warn.push(String(m)),
        error: (m) => L.error.push(String(m)), debug: () => {} },
      _cloudOk: cloudOk,
      _stopped: false,
      smartthings: null,
      localClient: { readDiscovered: () => null, writeDiscovered: () => {}, probeIdentity: probes },
      _probeOne: Platform.prototype._probeOne,
      _scheduleLocalIdRetry: Platform.prototype._scheduleLocalIdRetry,   // ★진짜 구현
      registerShutdown: () => {},
      _bindSmartThingsDevice: (d) => bound.push(d.deviceId),
      _cleanupStaleAccessories: () => { cleaned++; },
    };
    if (lateFill) devs[0].deviceId = lateFill;   // 예산 초과 뒤 늦게 채워진 상황
    const real = global.setTimeout;
    global.setTimeout = (fn) => { const h = real(fn, 0); if (h.unref) h.unref(); return h; };
    try {
      self._scheduleLocalIdRetry(devs, 1);
      await new Promise((r) => real(r, 60));
    } finally { global.setTimeout = real; }
    return { L, cleaned, bound, devs };
  };

  await t('★재시도 정리도 클라우드 신호를 본다 (부팅에서 막은 삭제를 30초 뒤 대신 하지 않는다)', async () => {
    const r = await runRetry({ cloudOk: false, probes: async () => ({ deviceId: 'x-1', name: 'A' }) });
    assert.strictEqual(r.cleaned, 0,
      '클라우드가 아직 죽었는데 정리했다 — v2.7.1이 막은 삭제가 다른 문으로 열린다');
    assert.ok(r.L.warn.some((l) => /계속 건너뜁니다/.test(l)), '억제 사실을 알리지 않는다');
  });

  await t('클라우드가 살아 있으면 재시도 뒤 정리한다 (대조군)', async () => {
    const r = await runRetry({ cloudOk: true, probes: async () => ({ deviceId: 'x-2', name: 'A' }) });
    assert.strictEqual(r.cleaned, 1, '정상 상황인데 정리를 영영 안 하면 고아가 쌓인다');
  });

  await t('★예산을 넘겨 늦게 채워진 deviceId도 바인딩한다 (영영 안 붙던 결함)', async () => {
    const r = await runRetry({
      cloudOk: true,
      probes: async () => { throw new Error('부르면 안 된다'); },
      lateFill: 'late-id',
    });
    assert.deepStrictEqual(r.bound, ['late-id'],
      '늦게 성공한 프로브가 재시도를 무장해제해 그 기기가 영영 안 붙는다');
  });

  await t('같은 기기를 두 번 붙이지 않는다', async () => {
    const r = await runRetry({ cloudOk: true, probes: async () => ({ deviceId: 'x-3', name: 'A' }) });
    assert.strictEqual(r.bound.length, 1, `중복 바인딩 ${r.bound.length}회`);
  });

  // ★v2.7.4 — 로그 정확성과 조용한 삭제
  console.log('\n[v2.7.4 — 로그 정확성 · 중복 IP]');

  await t('★두 항목이 같은 기기를 가리키면 알리고 정리를 억제한다 (조용한 삭제 방지)', async () => {
    const L = { info: [], warn: [], error: [] };
    const devs = [
      { deviceType: 'smartAc', deviceLabel: '거실', transport: 'local', local: { host: '10.0.0.1' } },
      { deviceType: 'smartAc', deviceLabel: '침실', transport: 'local', local: { host: '10.0.0.1' } },
    ];
    const self = {
      log: { info: (m) => L.info.push(String(m)), warn: (m) => L.warn.push(String(m)),
        error: (m) => L.error.push(String(m)), debug: () => {} },
      localClient: { readDiscovered: () => null, writeDiscovered: () => {},
        probeIdentity: async () => ({ deviceId: 'same-di', name: 'AC' }) },
      _probeOne: Platform.prototype._probeOne,
      _scheduleLocalIdRetry: () => {}, registerShutdown: () => {},
      _bindSmartThingsDevice: () => {}, _cleanupStaleAccessories: () => {},
    };
    const okRet = await Platform.prototype._resolveLocalDeviceIds.call(self, devs);
    assert.strictEqual(okRet, false, 'true를 돌려주면 액세서리 하나가 조용히 삭제된다');
    assert.ok(L.error.some((l) => /같은 기기.*가리킵니다/.test(l)), '중복을 알리지 않는다');
  });

  await t('★이름을 라벨로 채울 때 같은 문자열이 두 번 나오지 않는다', async () => {
    const L = [];
    const devs = [{ deviceType: 'smartAc', transport: 'local', local: { host: '10.0.0.9' } }];
    const self = {
      log: { info: (m) => L.push(String(m)), warn: () => {}, error: () => {}, debug: () => {} },
      localClient: { readDiscovered: () => null, writeDiscovered: () => {},
        probeIdentity: async () => ({ deviceId: 'x', name: 'Samsung AC' }) },
    };
    await Platform.prototype._probeOne.call(self, devs[0]);
    const line = L.find((l) => /확인했습니다/.test(l));
    assert.ok(line, '확인 로그가 없다');
    assert.strictEqual((line.match(/Samsung AC/g) || []).length, 1,
      `이름이 두 번 나온다: ${line}`);
  });

  await t('★조회 실패가 반복돼도 사용자 로그는 1줄만 (재시도 12회 × 13줄 방지)', async () => {
    const L = { warn: [], debug: [] };
    const d = { deviceType: 'smartAc', transport: 'local', local: { host: '10.0.0.9' } };
    const self = {
      log: { info: () => {}, warn: (m) => L.warn.push(String(m)),
        error: () => {}, debug: (m) => L.debug.push(String(m)) },
      localClient: { readDiscovered: () => null, writeDiscovered: () => {},
        probeIdentity: async () => { throw new Error('로컬 브릿지 미준비'); } },
    };
    for (let i = 0; i < 5; i++) {
      await Platform.prototype._probeOne.call(self, d).catch(() => {});
    }
    assert.strictEqual(L.warn.length, 1, `warn ${L.warn.length}줄 — 반복 억제가 없다`);
    assert.strictEqual(L.debug.length, 4, `이후는 debug여야 한다 (실측 ${L.debug.length})`);
  });

  await t('★라벨이 없으면 기기 종류가 아니라 IP로 부른다', async () => {
    const L = [];
    const d = { deviceType: 'smartAc', transport: 'local', local: { host: '10.0.0.9' } };
    const self = {
      log: { info: () => {}, warn: (m) => L.push(String(m)), error: () => {}, debug: () => {} },
      localClient: { readDiscovered: () => null, writeDiscovered: () => {},
        probeIdentity: async () => { throw new Error('무응답'); } },
    };
    await Platform.prototype._probeOne.call(self, d).catch(() => {});
    assert.ok(L[0] && L[0].includes('[10.0.0.9]'), `IP가 아니라 '${L[0]}'`);
  });

  console.log(`\n  총 ${pass + fail.length}건 / 실패 ${fail.length}\n`);
  process.exit(fail.length ? 1 : 0);
})();
