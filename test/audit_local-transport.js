'use strict';

// v2.2.1 — 로컬 전송(DTLS-CoAP) 회귀 스위트.
// 2026-07-28 적대 감사(13 에이전트)에서 생존한 결함들이 다시 들어오지 못하게 고정한다.
//   HIGH-1 CoAP 응답코드 미검사 → 기기가 거부한 '끄기'가 성공으로 보고
//   HIGH-2 쓰기 재시도/병렬 → OFF 뒤에 모드가 착탄해 재점등
//   HIGH-3 브릿지가 ready 전에 죽으면 기기 바인딩이 멈춤
//   MEDIUM-1 pip 설치 타임아웃 부재
//   LOW-1 drop_session 락 부재

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');

let passed = 0;
let failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); });
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const mkClient = (opts = {}) => new LocalApplianceClient(silentLog, opts);
const DEV = 'dev1';
const devInfo = { host: '10.0.0.1', port: 49154, label: '테스트기기' };

(async () => {
  console.log('\n[로컬 전송 회귀 — v2.2.1 감사 반영]');

  // ===== HIGH-1: CoAP 응답코드 판정 =====
  await t('HIGH-1 성공 코드(2.04/2.05)는 통과한다', () => {
    LocalApplianceClient._assertOk({ code: 68 }, '전송');
    LocalApplianceClient._assertOk({ code: 69 }, '조회');
  });

  await t('HIGH-1 4.xx/5.xx는 예외로 승격된다 (거부를 성공으로 넘기지 않음)', () => {
    assert.throws(() => LocalApplianceClient._assertOk({ code: 131 }, '전송'), /4\.03/);
    assert.throws(() => LocalApplianceClient._assertOk({ code: 132 }, '조회'), /4\.04/);
    assert.throws(() => LocalApplianceClient._assertOk({ code: 163 }, '전송'), /5\.03/);
  });

  await t('HIGH-1 기기가 끄기를 거부하면 클라우드 폴백이 실제로 발동한다', async () => {
    const c = mkClient({ cloudClient: { setPower: async () => 'cloud-off' } });
    c.registerDevice(DEV, devInfo);
    c._rpc = async () => ({ ok: true, code: 131 });   // 4.03 Forbidden
    const r = await c.setPower(DEV, false);
    assert.strictEqual(r, 'cloud-off', '폴백이 발동하지 않았다');
  });

  await t('HIGH-1 온도 응답에 값이 없으면 18℃를 지어내지 않고 폴백한다', async () => {
    const c = mkClient({ cloudClient: { getCoolingSetpoint: async () => 26 } });
    c.registerDevice(DEV, devInfo);
    c._rpc = async () => ({ ok: true, code: 69, data: {} });   // 값 없음
    assert.strictEqual(await c.getCoolingSetpoint(DEV), 26);
  });

  // ===== HIGH-2: 순서 보존 =====
  await t('HIGH-2 같은 기기 요청은 도착 순서대로 직렬 실행된다', async () => {
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    const order = [];
    let n = 0;
    c._rpc = (payload) => {
      const id = ++n;
      const delay = id === 1 ? 60 : 5;   // 첫 요청이 느려도 두 번째가 추월하면 안 된다
      order.push(`시작${id}`);
      return new Promise(res => setTimeout(() => { order.push(`끝${id}`); res({ ok: true, code: 68 }); }, delay));
    };
    await Promise.all([
      c._post(DEV, ['mode', 'vs', '0'], { m: 1 }),
      c._post(DEV, ['power', 'vs', '0'], { p: 0 }),
    ]);
    assert.deepStrictEqual(order, ['시작1', '끝1', '시작2', '끝2'],
      `순서 역전: ${order.join(',')}`);
  });

  await t('HIGH-2 앞 요청이 실패해도 뒤 요청이 막히지 않는다', async () => {
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    let n = 0;
    c._rpc = async () => (++n === 1 ? Promise.reject(new Error('첫 요청 실패')) : { ok: true, code: 68 });
    await assert.rejects(c._post(DEV, ['a'], {}));
    const r = await c._post(DEV, ['b'], {});
    assert.strictEqual(r.code, 68);
  });

  await t('HIGH-2 다른 기기끼리는 서로 막지 않는다', async () => {
    const c = mkClient();
    c.registerDevice('A', devInfo);
    c.registerDevice('B', { ...devInfo, host: '10.0.0.2' });
    let released;
    const gate = new Promise(r => { released = r; });
    c._rpc = (p) => (p.host === '10.0.0.1' ? gate.then(() => ({ ok: true, code: 68 })) : Promise.resolve({ ok: true, code: 68 }));
    const slow = c._post('A', ['x'], {});
    const fast = await Promise.race([c._post('B', ['y'], {}), new Promise((_, rej) => setTimeout(() => rej(new Error('B가 A에 막혔다')), 300))]);
    assert.strictEqual(fast.code, 68);
    released();
    await slow;
  });

  await t('HIGH-2 브릿지는 쓰기(post)를 재시도하지 않는다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local', 'bridge.py'), 'utf8');
    assert.ok(/attempts\s*=\s*1\s+if\s+op\s*==\s*["']post["']\s+else\s+2/.test(src),
      'bridge.py에서 post 재시도 금지 규칙이 사라졌다');
  });

  await t('HIGH-1 브릿지가 CoAP 코드를 판정한다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local', 'bridge.py'), 'utf8');
    assert.ok(/64\s*<=\s*code\s*<=\s*95/.test(src), 'bridge.py의 응답코드 판정이 사라졌다');
  });

  await t('LOW-1 drop_session이 락 안에서 세션을 교체한다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local', 'bridge.py'), 'utf8');
    const fn = src.slice(src.indexOf('def drop_session'), src.indexOf('def handle'));
    assert.ok(/with lock:\s*\n\s*s = _sessions\.pop/.test(fn), 'drop_session이 락 없이 세션을 지운다');
  });

  // ===== HIGH-3: ready 대기 봉합 =====
  await t('HIGH-3 브릿지가 준비 전에 죽으면 start()가 즉시 거부된다 (120초 정지 없음)', async () => {
    const c = mkClient({ pythonBin: 'km81-존재하지-않는-실행파일' });
    c._ensureDeps = async () => {};   // 설치 단계는 이 테스트의 관심사가 아니다
    const began = Date.now();
    // spawn 실패(ENOENT)든 ready 전 종료든, 어느 경로로도 즉시 거부되어야 한다.
    await assert.rejects(c.start(), /ENOENT|브릿지/);
    const took = Date.now() - began;
    assert.ok(took < 15000, `거부까지 ${took}ms — 즉시 실패해야 한다`);
    c.stop();
  });

  await t('HIGH-3 준비 안 된 상태의 요청은 즉시 실패해 폴백으로 넘어간다', async () => {
    const c = mkClient({ cloudClient: { getPower: async () => true } });
    c.registerDevice(DEV, devInfo);
    assert.strictEqual(await c.getPower(DEV), true);   // 브릿지 미기동 → 클라우드
  });

  // ===== MEDIUM-1: 설치 스탬프 =====
  await t('MEDIUM-1 설치 완료 스탬프가 있어야 설치를 건너뛴다 (껍데기 폴더 오판 방지)', async () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'km81t-'));
    const c = mkClient({ libDir: tmp });
    fs.mkdirSync(path.join(tmp, 'smartthings_local'));   // 껍데기만 있는 상태
    let tried = false;
    c.pythonBin = 'km81-존재하지-않는-실행파일';
    await c._ensureDeps().catch(() => { tried = true; });
    assert.ok(tried, '껍데기 디렉터리를 설치 완료로 오판했다');
    fs.writeFileSync(path.join(tmp, '.km81-install-ok'), 'x');
    await c._ensureDeps();   // 스탬프가 있으면 조용히 통과
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t('MEDIUM-1 pip 설치에 타임아웃이 걸려 있다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'LocalApplianceClient.js'), 'utf8');
    assert.ok(/PIP_TIMEOUT_MS/.test(src) && /p\.kill\(\)/.test(src), 'pip 타임아웃/kill이 사라졌다');
  });

  // ===== 계약 유지 =====
  await t('세탁물 getStatus는 액세서리가 읽는 형태를 유지한다', async () => {
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    c._rpc = async (p) => ({
      ok: true, code: 69,
      data: p.path[0] === 'power'
        ? { 'x.com.samsung.da.power': 'On' }
        : { currentMachineState: 'active', remainingTime: '01:30:00' },
    });
    const st = await c.getStatus(DEV);
    assert.strictEqual(st.main.dryerOperatingState.machineState.value, 'run');
    assert.strictEqual(st.main.dryerOperatingState.remainingTime.value, 90);
  });

  await t('전원이 꺼져 있으면 가동 중으로 보고하지 않는다', async () => {
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    c._rpc = async (p) => ({
      ok: true, code: 69,
      data: p.path[0] === 'power'
        ? { 'x.com.samsung.da.power': 'Off' }
        : { currentMachineState: 'active', remainingTime: '01:30:00' },
    });
    const st = await c.getStatus(DEV);
    assert.strictEqual(st.main.dryerOperatingState.machineState.value, 'stop');
    assert.strictEqual(st.main.dryerOperatingState.remainingTime.value, 0);
  });

  await t('UI에서 고를 수 있는 모드 값이 전부 로컬 매핑을 갖는다', async () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const choices = s.schema.properties.devices.items.properties.coolModeCommand.oneOf.flatMap(o => o.enum);
    for (const v of choices) {
      const c = mkClient();
      c.registerDevice(DEV, devInfo);
      let sentModes = null;
      c._rpc = async (p) => { sentModes = p.payload && p.payload['x.com.samsung.da.modes']; return { ok: true, code: 68 }; };
      await c.setMode(DEV, v);
      assert.ok(Array.isArray(sentModes) && sentModes.length === 1,
        `coolModeCommand='${v}'가 로컬에서 전송되지 않았다(매핑 누락)`);
    }
  });

  await t('매핑 없는 모드는 조용히 삼키지 않고 클라우드로 넘긴다', async () => {
    const c = mkClient({ cloudClient: { setMode: async () => 'cloud-mode' } });
    c.registerDevice(DEV, devInfo);
    let sent = false;
    c._rpc = async () => { sent = true; return { ok: true, code: 68 }; };
    const r = await c.setMode(DEV, 'heat');
    assert.strictEqual(sent, false, '로컬로 엉뚱한 명령을 보냈다');
    assert.strictEqual(r, 'cloud-mode', '무성 유실 — 폴백이 발동하지 않았다');
  });

  await t('구형 에어컨 경로는 로컬 전송과 무관하다 (무변경 원칙)', () => {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const clientFor = idx.slice(idx.indexOf('_clientFor('), idx.indexOf('_cleanupStaleAccessories'));
    assert.ok(!/legacyAc/.test(clientFor), '_clientFor가 legacyAc를 건드린다');
    const legacy = idx.slice(idx.indexOf("filter(d => d?.deviceType === 'legacyAc')"));
    assert.ok(legacy.length > 0, 'legacyAc 처리 경로가 사라졌다');
  });

  // ===== 설정 UI 노출 (v2.2.2) =====
  // 홈브릿지 UI는 schema가 아니라 layout에 있는 필드만 그린다. 2.2.0/2.2.1에서
  // schema에만 넣어 설정 화면에 아무것도 안 보였다(실사용 발견).
  await t('설정 UI에 전송 경로 필드가 실제로 노출된다 (schema+layout 양쪽)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const props = s.schema.properties.devices.items.properties;
    assert.ok(props.transport, 'schema에 transport가 없다');
    assert.ok(props.local && props.local.properties.host, 'schema에 local.host가 없다');
    const flat = JSON.stringify(s.layout);
    for (const key of ['devices[].transport', 'devices[].local.host', 'devices[].local.port',
      'devices[].local.localPort', 'devices[].local.fallbackToCloud']) {
      assert.ok(flat.includes(key), `layout에 ${key}가 없어 UI에 표시되지 않는다`);
    }
  });

  await t('UI 조건식에 옵셔널 체이닝을 쓰지 않는다 (평가기 호환)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const bodies = JSON.stringify(s).match(/"functionBody":"[^"]*"/g) || [];
    const bad = bodies.filter(b => b.includes('?.'));
    assert.strictEqual(bad.length, 0, `옵셔널 체이닝 사용 조건식 ${bad.length}건`);
  });

  console.log(`\n총 ${passed + failed}건 / 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
