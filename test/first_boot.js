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

  console.log(`\n  총 ${pass + fail.length}건 / 실패 ${fail.length}\n`);
  process.exit(fail.length ? 1 : 0);
})();
