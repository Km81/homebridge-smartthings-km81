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
    c._verified.set(DEV, true);   // 신원 확인은 별도 테스트에서 다룬다
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
    c._verified.set(DEV, true);
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
    c._verified.set('A', true); c._verified.set('B', true);
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
    c._verified.set(DEV, true);
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
    c._verified.set(DEV, true);
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
    for (const key of ['devices[].transport', 'devices[].local.host', 'devices[].local.fallbackToCloud']) {
      assert.ok(flat.includes(key), `layout에 ${key}가 없어 UI에 표시되지 않는다`);
    }
  });

  // v2.2.3 — 사용자에게 묻는 건 IP까지다. 포트는 자동(구형 에어컨 UX와 동일).
  await t('포트는 설정 UI에 노출하지 않는다 (자동 탐지/자동 결정)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const flat = JSON.stringify(s.layout);
    assert.ok(!flat.includes('devices[].local.port"'), 'DTLS 포트가 UI에 다시 노출됐다');
    assert.ok(!flat.includes('devices[].local.localPort'), '고정 송신 포트가 UI에 다시 노출됐다');
    const L = s.schema.properties.devices.items.properties.local;
    assert.ok(!(L.required || []).includes('port'), 'port가 필수로 되어 있다');
    assert.ok(L.properties.port && L.properties.localPort, '고급 재정의용 스키마 항목이 사라졌다');
  });

  await t('포트를 비워둬도 등록·요청이 성립한다 (자동 탐지 경로)', async () => {
    const c = mkClient();
    c.registerDevice(DEV, { host: '10.0.0.1', label: '포트없음' });   // port 없음
    const ports = [];
    c._rpc = async (p) => { ports.push(p.port); return { ok: true, code: 69, data: { di: DEV, 'x.com.samsung.da.power': 'On' }, port: 49155 }; };
    assert.strictEqual(await c.getPower(DEV), true);
    assert.strictEqual(ports[0], undefined, '첫 요청은 port 없이 보내야 브릿지가 탐지한다');
    assert.strictEqual(c.devices.get(DEV).port, 49155, '탐지된 포트를 학습하지 않았다');
  });

  await t('브릿지가 포트 자동 탐지와 송신 포트 자동 결정을 갖는다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local', 'bridge.py'), 'utf8');
    assert.ok(/def resolve_port\(/.test(src), '포트 자동 탐지 함수가 없다');
    assert.ok(/def auto_local_port\(/.test(src), '송신 포트 자동 결정 함수가 없다');
    assert.ok(/PROBE_PORTS\s*=\s*\[49154/.test(src), '탐지 포트 범위가 사라졌다');
  });

  await t('UI 조건식에 옵셔널 체이닝을 쓰지 않는다 (평가기 호환)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const bodies = JSON.stringify(s).match(/"functionBody":"[^"]*"/g) || [];
    const bad = bodies.filter(b => b.includes('?.'));
    assert.strictEqual(bad.length, 0, `옵셔널 체이닝 사용 조건식 ${bad.length}건`);
  });

  // ===== 2차 감사 반영 (v2.2.3) =====

  await t('HIGH-B 폴백도 기기 순서 체인 안에서 실행된다 (끄기 뒤 모드 착탄 차단)', async () => {
    const order = [];
    const c = mkClient({
      cloudClient: {
        setMode: async () => { order.push('클라우드모드'); },
        setPower: async () => { order.push('클라우드전원'); },
      },
    });
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = (p) => {
      const isMode = p.path && p.path[0] === 'mode';
      if (isMode) return new Promise((_, rej) => setTimeout(() => rej(new Error('로컬 요청 실패')), 40));
      return new Promise(res => setTimeout(() => { order.push('로컬끄기'); res({ ok: true, code: 68 }); }, 5));
    };
    const modeP = c.setMode(DEV, 'cool');
    const offP = c.setPower(DEV, false);
    await Promise.allSettled([modeP, offP]);
    // 모드(폴백 포함)가 완전히 끝난 뒤에 끄기가 나가야 한다 — 반대면 재점등
    assert.strictEqual(order.join(','), '클라우드모드,로컬끄기', `순서 역전: ${order.join(',')}`);
  });

  await t('HIGH-B 쓰기 타임아웃(결과 불명)이면 모드는 클라우드로 재전송하지 않는다', async () => {
    let cloudCalled = false;
    const c = mkClient({ cloudClient: { setMode: async () => { cloudCalled = true; } } });
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = async () => { throw new Error('로컬 요청 시간 초과'); };
    await assert.rejects(c.setMode(DEV, 'cool'), /시간 초과/);
    assert.strictEqual(cloudCalled, false, '결과 불명인데 클라우드로 또 보냈다(재점등 위험)');
  });

  await t('HIGH-B 전원 끄기는 결과 불명이어도 폴백한다 (유실이 더 나쁨)', async () => {
    let cloudOff = false;
    const c = mkClient({ cloudClient: { setPower: async () => { cloudOff = true; } } });
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = async () => { throw new Error('로컬 요청 시간 초과'); };
    await c.setPower(DEV, false);
    assert.strictEqual(cloudOff, true, '끄기가 유실됐다');
  });

  await t('쓰기 직후 읽기 실패는 클라우드 낡은 값으로 덮지 않는다 (타일 되돌림 방지)', async () => {
    let cloudRead = false;
    const c = mkClient({ cloudClient: { getPower: async () => { cloudRead = true; return false; } } });
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = async (p) => (p.op === 'post' ? { ok: true, code: 68 } : Promise.reject(new Error('읽기 실패')));
    await c.setPower(DEV, true);
    await assert.rejects(c.getPower(DEV), /읽기 실패/);
    assert.strictEqual(cloudRead, false, '방금 쓴 값을 클라우드 낡은 값으로 덮었다');
  });

  await t('연속 실패가 쌓이면 학습한 포트를 버리고 다시 탐지한다', async () => {
    const c = mkClient();
    c.registerDevice(DEV, { ...devInfo, port: 49154, fallbackToCloud: false });
    c._verified.set(DEV, true);
    c._rpc = async () => { throw new Error('무응답'); };
    for (let i = 0; i < 3; i++) await c.getPower(DEV).catch(() => {});
    assert.strictEqual(c.devices.get(DEV).port, undefined, '포트가 무효화되지 않았다');
  });

  await t('기기 신원이 다르면 로컬을 끄고 클라우드로 내려간다 (IP 오타 방어)', async () => {
    let cloudUsed = false;
    const c = mkClient({ cloudClient: { getPower: async () => { cloudUsed = true; return true; } } });
    c.registerDevice(DEV, devInfo);
    c._rpc = async (p) => (p.path[0] === 'oic'
      ? { ok: true, code: 69, data: { di: '00000000-dead-beef-0000-000000000000', n: '엉뚱한 기기' } }
      : { ok: true, code: 69, data: {} });
    assert.strictEqual(await c.getPower(DEV), true);
    assert.strictEqual(cloudUsed, true, '신원 불일치인데 로컬을 계속 썼다');
    assert.strictEqual(c._verified.get(DEV), false);
  });

  // v2.3.2 — 세탁물 액세서리는 밸브(잔여시간)+움직임센서(종료알림) 구성이라
  // machineState 매핑이 종료 알림 시점을 좌우한다.
  await t('켜져 있는데 idle이면 stop으로 단정하지 않는다 (안티주름 조기 종료 방지)', async () => {
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = async (p) => ({
      ok: true, code: 69,
      data: p.path[0] === 'power'
        ? { 'x.com.samsung.da.power': 'On' }
        : { currentMachineState: 'idle', currentJobState: 'WrinklePrevent', remainingTime: '00:20:00' },
    });
    const st = await c.getStatus(DEV);
    const op = st.main.dryerOperatingState;
    assert.strictEqual(op.machineState.value, 'on', 'idle을 stop으로 단정해 종료로 확정된다');
    assert.strictEqual(op.jobState.value, 'wrinklePrevent', 'jobState가 전달되지 않는다');
  });

  await t('일시정지 중에도 잔여 시간을 유지한다 (밸브 카운트다운)', async () => {
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = async (p) => ({
      ok: true, code: 69,
      data: p.path[0] === 'power'
        ? { 'x.com.samsung.da.power': 'On' }
        : { currentMachineState: 'pause', remainingTime: '00:45:00' },
    });
    const op = (await c.getStatus(DEV)).main.dryerOperatingState;
    assert.strictEqual(op.machineState.value, 'pause');
    assert.strictEqual(op.remainingTime.value, 45, '일시정지에서 잔여 시간이 0으로 떨어진다');
  });

  await t('건조기 jobState를 클라우드 표기로 옮긴다 (안티주름 조기 알림 방지)', () => {
    assert.strictEqual(LocalApplianceClient._jobState('Weightsensing'), 'weightSensing');
    assert.strictEqual(LocalApplianceClient._jobState('Finish'), 'finished');
    assert.strictEqual(LocalApplianceClient._jobState('None'), 'none');
    assert.strictEqual(LocalApplianceClient._jobState('Drying'), 'drying');
    assert.strictEqual(LocalApplianceClient._jobState(null), null);
  });

  await t('브릿지 stdin 파손(EPIPE)을 처리한다 (홈브릿지 전체 크래시 방지)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'LocalApplianceClient.js'), 'utf8');
    assert.ok(/_proc\.stdin\.on\('error'/.test(src), 'stdin error 핸들러가 없다');
  });

  await t('HIGH-A 클라우드 검색이 실패해도 로컬 기기는 캐시로 바인딩한다', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/_bindFromCacheOffline\(/.test(src), '오프라인 바인딩 폴백이 없다');
    assert.ok(/_scheduleRediscovery\(/.test(src), '백그라운드 재검색이 없다');
    const fn = src.slice(src.indexOf('_bindFromCacheOffline('), src.indexOf('_scheduleRediscovery(stDevices, attempt'));
    assert.ok(/transport === 'local'/.test(fn), '로컬 기기 대상 필터가 없다');
  });

  await t('index.js가 읽는 플랫폼 설정 키가 스키마에 등재돼 있다', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const used = new Set((src.match(/this\.config\.[a-zA-Z]+/g) || []).map(x => x.split('.').pop()));
    const missing = [...used].filter(k => !s.schema.properties[k] && !['devices', 'platform', 'name'].includes(k));
    assert.deepStrictEqual(missing, [], `스키마에 없는 설정 키: ${missing.join(', ')}`);
  });

  await t('CI가 파이썬 브릿지 문법을 검사한다', () => {
    const y = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8');
    assert.ok(/py_compile\s+lib\/local\/bridge\.py/.test(y), 'CI에 py_compile 단계가 없다');
  });

  // ===== v2.3.0 — deviceId 직접 지정(부팅 시 클라우드 조회 생략) =====
  await t('deviceId가 스키마와 layout 양쪽에 있다 (UI에서 입력 가능)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    assert.ok(s.schema.properties.devices.items.properties.deviceId, 'schema에 deviceId가 없다');
    assert.ok(JSON.stringify(s.layout).includes('devices[].deviceId'), 'layout에 deviceId가 없어 UI에 안 보인다');
  });

  await t('deviceId가 있으면 클라우드 조회를 건너뛴다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/_bindByConfiguredIds\(/.test(src), 'deviceId 직접 바인딩 경로가 없다');
    const fn = src.slice(src.indexOf('_bindByConfiguredIds(stDevices) {'), src.indexOf('// 성공 시 true'));
    assert.ok(/configDevice\.deviceId/.test(fn), 'config의 deviceId를 읽지 않는다');
    assert.ok(/remaining\.push\(configDevice\)/.test(fn), 'deviceId 없는 기기를 조회 대상으로 넘기지 않는다');
    // 조회는 '남은 기기'로만 — 전체를 다시 조회하면 클라우드 생략 효과가 사라진다
    assert.ok(/_discoverAndBindSmartThings\(needDiscovery\)/.test(src),
      '클라우드 조회에 전체 목록을 넘기고 있다(생략 효과 없음)');
  });

  // v2.3.1 — v2.3.0에서 낸 회귀. init()은 토큰을 디스크에서 읽는 단계라, deviceId로 전부
  // 연결됐다고 건너뛰면 클라우드 전송 기기 폴링과 '로컬 실패 시 폴백'이 통째로 죽는다.
  await t('deviceId로 전부 연결돼도 OAuth 토큰 로드(init)는 건너뛰지 않는다', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const block = src.slice(src.indexOf('let hasToken = false;'), src.indexOf('// SmartThings 검색이 실패'));
    assert.ok(/if \(stDevices\.length > 0 && this\.smartthings\)/.test(block),
      'init() 호출 조건이 needDiscovery에 묶여 있다 — 토큰이 로드되지 않아 폴백이 죽는다');
    assert.ok(/hasToken = await this\.smartthings\.init\(\)/.test(block), 'init() 호출이 사라졌다');
    // 바인딩 직후 폴링이 시작되므로 토큰 로드가 먼저여야 한다(첫 폴링 실패 방지)
    assert.ok(src.indexOf('hasToken = await this.smartthings.init()') < src.indexOf('_bindByConfiguredIds(stDevices)'),
      '토큰 로드가 바인딩보다 늦다 — 첫 폴링이 실패한다');
    assert.ok(/else if \(needDiscovery\.length > 0\)/.test(block),
      '토큰이 있을 때 조회 대상이 없어도 getDevices를 부르고 있다(클라우드 생략 효과 상실)');
  });

  await t('검색 성공 시 deviceId를 로그로 안내한다 (config에 옮겨 적을 수 있게)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/deviceId=\$\{found\.deviceId\}/.test(src), 'deviceId 안내 로그가 없다');
  });

  // ===== 3차 감사 반영 (v2.3.3) =====

  await t('H3 체인 실행 중 도착한 새 외부 호출은 큐를 건너뛰지 않는다', async () => {
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    const order = [];
    let n = 0;
    c._rpc = (p) => {
      const id = ++n;
      order.push(`시작${id}`);
      const delay = id === 1 ? 80 : 5;
      return new Promise(res => setTimeout(() => { order.push(`끝${id}`); res({ ok: true, code: 68 }); }, delay));
    };
    const first = c._post(DEV, ['mode', 'vs', '0'], { m: 1 });
    // 첫 요청이 RPC를 기다리는 '도중'에 새 외부 호출이 들어온다 — 예전엔 이게 재진입으로
    // 오인돼 병렬 실행됐고, 끄기 뒤 모드 착탄(재점등) 경로가 열렸다.
    await new Promise(r => setTimeout(r, 30));
    const second = c._post(DEV, ['power', 'vs', '0'], { p: 0 });
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ['시작1', '끝1', '시작2', '끝2'],
      `직렬화 우회 발생: ${order.join(',')}`);
  });

  await t('H3 체인 내부에서 파생된 호출은 여전히 즉시 실행된다 (교착 없음)', async () => {
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = async (p) => ({
      ok: true, code: 69,
      data: p.path[0] === 'power' ? { 'x.com.samsung.da.power': 'On' }
        : { currentMachineState: 'active', remainingTime: '00:30:00' },
    });
    // getStatus는 _withFallback(체인) 안에서 _get을 2번 병렬로 부른다 — 교착되면 타임아웃
    const st = await Promise.race([
      c.getStatus(DEV),
      new Promise((_, rej) => setTimeout(() => rej(new Error('교착')), 2000)),
    ]);
    assert.strictEqual(st.main.dryerOperatingState.machineState.value, 'run');
  });

  await t('H2 브릿지가 sent 플래그를 주면 결과 불명으로 판정한다 (영어 오류도 포착)', async () => {
    let cloudCalled = false;
    const c = mkClient({ cloudClient: { setMode: async () => { cloudCalled = true; } } });
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = async () => { const e = new Error('TimeoutError: request timed out'); e.sent = true; throw e; };
    await assert.rejects(c.setMode(DEV, 'cool'));
    assert.strictEqual(cloudCalled, false, '결과 불명인데 클라우드로 재전송했다(재점등 위험)');
  });

  await t('H2 브릿지 실패 응답에 sent 플래그가 실린다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local', 'bridge.py'), 'utf8');
    assert.ok(/"sent":\s*op == "post"/.test(src), 'bridge.py가 sent 플래그를 돌려주지 않는다');
  });

  await t('H4 신원 확인 단계 실패는 폴백을 막지 않는다 (명령 미전송이라 안전)', async () => {
    let cloudCalled = false;
    const c = mkClient({ cloudClient: { setMode: async () => { cloudCalled = true; return 'cloud'; } } });
    c.registerDevice(DEV, devInfo);   // _verified 미설정 → 신원 확인부터 수행
    c._rpc = async (p) => {
      if (p.path[0] === 'oic') { const e = new Error('로컬 요청 시간 초과'); e.sent = false; throw e; }
      return { ok: true, code: 68 };
    };
    const r = await c.setMode(DEV, 'cool');
    assert.strictEqual(cloudCalled, true, '명령을 보내지도 않았는데 폴백을 막아 무성 유실이 된다');
    assert.strictEqual(r, 'cloud');
  });

  await t('H1 세션 해제 시 학습 포트 캐시도 버린다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local', 'bridge.py'), 'utf8');
    const fn = src.slice(src.indexOf('def drop_session'), src.indexOf('def handle'));
    assert.ok(/_resolved_ports\.pop\(host, None\)/.test(fn),
      '포트 캐시를 지우지 않아 재탐지가 영원히 도달하지 못한다');
  });

  await t('★세탁물 jobState를 Laundry가 실제로 읽는 키로 내보낸다', async () => {
    const laundry = fs.readFileSync(path.join(__dirname, '..', 'lib', 'accessories', 'Laundry.js'), 'utf8');
    const usesDryerJob = /op\.dryerJobState\?\.value/.test(laundry);
    assert.ok(usesDryerJob, 'Laundry가 읽는 키가 바뀌었다 — 이 테스트를 갱신할 것');
    const c = mkClient();
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    c._rpc = async (p) => ({
      ok: true, code: 69,
      data: p.path[0] === 'power' ? { 'x.com.samsung.da.power': 'On' }
        : { currentMachineState: 'idle', currentJobState: 'WrinklePrevent', remainingTime: '00:20:00' },
    });
    const op = (await c.getStatus(DEV)).main.dryerOperatingState;
    assert.strictEqual(op.dryerJobState.value, 'wrinklePrevent',
      'Laundry가 읽는 dryerJobState가 비어 있어 조기 종료 알림이 그대로 난다');
  });

  // ===== v2.3.3 설정 UI 정리 =====
  await t('타이밍 설정은 초 단위 항목만 UI에 노출한다 (ms는 호환용으로 숨김)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const flat = JSON.stringify(s.layout);
    for (const k of ['powerOnResendStepSec', 'legacyOnGuardSec', 'timeoutSec', 'cacheDurationSec']) {
      assert.ok(flat.includes(`devices[].${k}`), `${k}가 UI에 없다`);
    }
    for (const k of ['powerOnResendStepMs', 'legacyOnGuardMs', 'timeout', 'cacheDuration']) {
      assert.ok(!flat.includes(`devices[].${k}"`), `${k}가 아직 UI에 노출된다`);
      assert.ok(s.schema.properties.devices.items.properties[k], `${k} 스키마가 사라져 기존 설정이 깨진다`);
    }
  });

  await t('슬라이더로 그려지는 필드가 없다 (정수+min+max 조합 제거)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const P = s.schema.properties.devices.items.properties;
    const sliders = Object.entries(P)
      .filter(([, v]) => (v.type === 'integer' || v.type === 'number')
        && v.minimum !== undefined && v.maximum !== undefined)
      .map(([k]) => k);
    assert.deepStrictEqual(sliders, [], `슬라이더 렌더링 필드: ${sliders.join(', ')}`);
  });

  await t('전송 경로 선택지가 간결하다', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const titles = s.schema.properties.devices.items.properties.transport.oneOf.map(o => o.title);
    assert.deepStrictEqual(titles, ['클라우드', '로컬'], `선택지 라벨: ${titles.join(' / ')}`);
  });

  await t('초 설정이 내부 ms 키로 환산된다 (구형 로직 무변경 유지)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/SEC_TO_MS_KEYS/.test(src) && /normalizeTimingConfig/.test(src), '초→ms 환산 경로가 없다');
    // 액세서리 파일은 여전히 ms 키만 읽어야 한다(구형 통신 경로 무변경 원칙)
    const legacy = fs.readFileSync(path.join(__dirname, '..', 'lib', 'accessories', 'LegacyAC.js'), 'utf8');
    assert.ok(!/Sec\b/.test(legacy.match(/this\.timeout[^\n]*/)?.[0] || ''), 'LegacyAC가 초 키를 직접 읽는다');
  });

  await t('신형 AC 모드 목록이 기기 실제 지원값과 일치한다', () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const modes = s.schema.properties.devices.items.properties.coolModeCommand.oneOf.flatMap(o => o.enum);
    // 신형 AC가 실제로 보고하는 supportedAcModes(aIComfort·cool·dry·fan)만 노출해야 한다.
    // 청정 계열은 구형 2in1 전용이라 목록에 두면 '없는 걸 고르게' 만든다(사용자 지적).
    assert.deepStrictEqual(modes.sort(), ['aIComfort','cool','dry','fan'].sort(),
      '신형 AC 모드 목록이 기기 실제 지원값과 다르다: '+modes.join(','));
  });

  await t('드롭다운 렌더 소스(layout titleMap)가 schema oneOf와 값·라벨 모두 일치한다', () => {
    // v2.3.4 실사고: UI 드롭다운은 schema oneOf가 아니라 layout의 titleMap을 그린다.
    // oneOf만 고치면 화면에는 옛 목록이 그대로 나온다(개인정보 보호 창으로 캐시 배제 확인).
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const P = s.schema.properties.devices.items.properties;
    const maps = [];
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (n.titleMap && n.key && n.key.startsWith('devices[].')) maps.push(n);
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
    };
    walk(s.layout);
    assert.ok(maps.length >= 8, `titleMap이 ${maps.length}개뿐 — layout 구조 변경 의심`);
    for (const m of maps) {
      const f = P[m.key.split('.').pop()];
      if (!f || !f.oneOf) continue;
      const lv = m.titleMap.map(t => t.value).sort().join(',');
      const sv = f.oneOf.flatMap(o => o.enum).sort().join(',');
      assert.strictEqual(lv, sv, `${m.key} 값 불일치: layout(${lv}) != schema(${sv})`);
      const ln = m.titleMap.map(t => t.name).sort().join('|');
      const sn = f.oneOf.map(o => o.title).sort().join('|');
      assert.strictEqual(ln, sn, `${m.key} 라벨 불일치: layout(${ln}) != schema(${sn})`);
    }
  });

  // ===== v2.3.6 로그 최적화 (사용자 지적) =====
  await t('브릿지 로그의 IP가 기기 라벨로 치환된다 ([로컬]→[건조기])', () => {
    const lines = [];
    const c = new LocalApplianceClient(
      { info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]),
        error: (m) => lines.push(['error', m]), debug: (m) => lines.push(['debug', m]) }, {});
    c.registerDevice(DEV, { host: '10.0.0.1', port: 49154, label: '건조기' });
    lines.length = 0;
    c._relayBridgeLog({ event: 'log', message: '로컬 세션 연결됨 10.0.0.1:49154', level: 'debug' });
    assert.strictEqual(lines.length, 1);
    const [lvl, msg] = lines[0];
    assert.strictEqual(lvl, 'debug', '레벨이 반영되지 않았다: ' + lvl);
    assert.ok(msg.startsWith('[건조기]'), 'IP가 라벨로 치환되지 않았다: ' + msg);
    assert.ok(!msg.includes('10.0.0.1'), 'IP가 남아 있다: ' + msg);
    assert.ok(msg.includes('49154'), '포트는 남아야 한다: ' + msg);
  });

  await t('모르는 IP의 브릿지 로그는 [로컬] 태그와 info로 유지된다 (하위 호환)', () => {
    const lines = [];
    const c = new LocalApplianceClient(
      { info: (m) => lines.push(['info', m]), warn: () => {}, error: () => {}, debug: (m) => lines.push(['debug', m]) }, {});
    c._relayBridgeLog({ event: 'log', message: '알 수 없는 사건 10.9.9.9' });   // level 없음
    assert.strictEqual(lines[0][0], 'info', 'level 없는 옛 메시지는 info여야 한다');
    assert.ok(lines[0][1].startsWith('[로컬]'), lines[0][1]);
  });

  await t('로컬 폴백 뒤 성공하면 복귀 로그가 나온다', async () => {
    const infos = [];
    const c = new LocalApplianceClient(
      { info: (m) => infos.push(m), warn: () => {}, error: () => {}, debug: () => {} },
      { cloudClient: { getPower: async () => true } });
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    let fail = true;
    c._rpc = async () => { if (fail) throw new Error('로컬 요청 시간 초과'); return { ok: true, code: 69, data: {} }; };
    // v2.4.5 — 읽기는 **첫 연결 실패에 바로 클라우드로 넘어가지 않는다**(READ_FALLBACK_AFTER).
    // 재시작 직후 첫 접촉이 늦는 것 하나로 매번 클라우드를 부르던 것을 없애기 위한 것이라,
    // 첫 실패는 폴백 없이 그대로 올라온다.
    await assert.rejects(c.getPower(DEV), /시간 초과/, '첫 실패는 유예해야 한다');
    await c.getPower(DEV);                       // 두 번째 실패 → 클라우드 폴백
    assert.strictEqual(infos.filter(m => /로컬 복귀/.test(m)).length, 0, '아직 복귀하면 안 된다');
    fail = false;
    await c.getPower(DEV);                       // 성공 → 복귀 알림
    const rec = infos.filter(m => /로컬 복귀/.test(m));
    assert.strictEqual(rec.length, 1, '복귀 로그가 없거나 중복이다: ' + JSON.stringify(infos));
    assert.ok(/2회 실패 후 정상화/.test(rec[0]), rec[0]);
  });

  await t('★폴백을 껐을 때의 로컬 사망 경고가 사실과 맞는다 (유일한 신호이므로)', async () => {
    // v2.4.5부터 읽기 실패는 debug로 내려간다. 폴백까지 꺼 두면 이 error 한 줄이
    // 사용자가 받는 **유일한** 신호다 — 그런데 문구가 늘 "클라우드로 동작 중"이었다.
    const errs = [];
    const c = new LocalApplianceClient(
      { info: () => {}, warn: () => {}, error: (m) => errs.push(String(m)), debug: () => {} },
      { cloudClient: { getPower: async () => true } });
    c.registerDevice(DEV, { ...devInfo, fallbackToCloud: false });
    c._verified.set(DEV, true);
    c._rpc = async () => { throw new Error('로컬 요청 시간 초과'); };
    for (let i = 0; i < 12; i++) await c.getPower(DEV).catch(() => {});
    const dead = errs.filter((m) => /연속 실패했고 클라우드 폴백도 꺼져 있습니다/.test(m));
    assert.strictEqual(dead.length, 1, '폴백이 꺼진 상태의 경고가 없거나 중복이다: ' + JSON.stringify(errs));
    assert.ok(!errs.some((m) => /클라우드로 동작 중/.test(m)),
      '폴백이 꺼져 있는데 "클라우드로 동작 중"이라고 말했다: ' + JSON.stringify(errs));
  });

  await t('복귀 로그는 한 번만 나온다 (연속 성공 시 반복 금지)', async () => {
    const infos = [];
    const c = new LocalApplianceClient(
      { info: (m) => infos.push(m), warn: () => {}, error: () => {}, debug: () => {} },
      { cloudClient: { getPower: async () => true } });
    c.registerDevice(DEV, devInfo);
    c._verified.set(DEV, true);
    let fail = true;
    c._rpc = async () => { if (fail) throw new Error('로컬 요청 시간 초과'); return { ok: true, code: 69, data: {} }; };
    // v2.4.5 — 첫 연결 실패는 유예되어 그대로 올라온다(폴백 없음). 두 번째부터 폴백.
    await assert.rejects(c.getPower(DEV), /시간 초과/);
    await c.getPower(DEV);
    fail = false;
    await c.getPower(DEV); await c.getPower(DEV); await c.getPower(DEV);
    assert.strictEqual(infos.filter(m => /로컬 복귀/.test(m)).length, 1,
      '복귀 로그가 반복됐다: ' + JSON.stringify(infos.filter(m => /로컬 복귀/.test(m))));
  });

  await t('브릿지가 동일 메시지 폭주를 억제한다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local', 'bridge.py'), 'utf8');
    assert.ok(/_LOG_DEDUPE_SEC/.test(src) && /def log\(msg, level=/.test(src),
      'bridge.py의 로그 억제/레벨 인자가 사라졌다');
    // 정상 동작인 세션 로그는 debug로 내려가 있어야 한다
    assert.ok(/로컬 세션 연결됨 %s" % k, "debug"/.test(src), '세션 연결 로그가 info로 되돌아갔다');
    assert.ok(/로컬 세션 해제 %s" % k, "debug"/.test(src), '세션 해제 로그가 info로 되돌아갔다');
  });

  await t('클라우드 계층이 UUID 대신 기기 이름으로 찍는다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'SmartThingsClient.js'), 'utf8');
    const seg = src.slice(src.indexOf('_statusFailStreaks.set(deviceId, streak)'));
    const head = seg.slice(0, 900);
    assert.ok(!/\[\$\{deviceId\}\] 상태 조회/.test(head),
      '상태 조회 실패/복구 로그가 아직 UUID를 쓴다 — hb-watch 오탐 재발');
    assert.ok(/_labelOf\(deviceId\)/.test(head), '_labelOf로 라벨을 쓰지 않는다');
    assert.ok(/원인 불명/.test(head), '빈 오류 메시지 대체 문구가 없다');
  });

  // ===== v2.4.0 2-in-1 세탁조 분리/합침 =====
  const Laundry = require('../lib/accessories/Laundry');

  // 최소 홈브릿지 하네스 — 액세서리/서비스/특성을 흉내 낸다.
  function mkHarness() {
    const chars = {};
    const mkChar = (name) => {
      const c = {
        name, value: null, listeners: {},
        on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; },
        removeAllListeners(ev) { delete this.listeners[ev]; return this; },
        setProps() { return this; },
        updateValue(v) { this.value = v; return this; },
      };
      return c;
    };
    const mkService = (displayName) => ({
      displayName, _c: {},
      getCharacteristic(k) { return (this._c[k] = this._c[k] || mkChar(k)); },
      setCharacteristic(k, v) { this.getCharacteristic(k).value = v; return this; },
      updateCharacteristic(k, v) { this.getCharacteristic(k).value = v; return this; },
    });
    const mkAccessory = (displayName, uuid) => {
      const a = {
        displayName, UUID: uuid, context: {}, _s: new Map(),
        getService(t) { return this._s.get(t) || null; },
        addService(t, name) { const sv = mkService(name || displayName); this._s.set(t, sv); return sv; },
      };
      // 실제 홈브릿지 액세서리는 AccessoryInformation을 항상 갖고 있다.
      a.addService('AccessoryInformation', displayName);
      return a;
    };
    const C = new Proxy({}, { get: (_t, k) => {
      if (k === 'Active') return Object.assign('Active', { ACTIVE: 1, INACTIVE: 0 });
      if (k === 'InUse') return Object.assign('InUse', { IN_USE: 1, NOT_IN_USE: 0 });
      if (k === 'ValveType') return Object.assign('ValveType', { IRRIGATION: 1 });
      return String(k);
    } });
    const Service = new Proxy({}, { get: (_t, k) => String(k) });
    const registered = [];
    const api = {
      hap: { Service, Characteristic: C, uuid: { generate: (s2) => 'uuid:' + s2 }, Perms: {} },
      platformAccessory: function (n, u) { return mkAccessory(n, u); },
      registerPlatformAccessories: (_p, _pl, accs) => registered.push(...accs),
    };
    const platform = {
      accessories: [], activeUUIDs: new Set(), PLUGIN_NAME: 'p', PLATFORM_NAME: 'P',
      registerShutdown: () => {},
    };
    return { api, platform, registered, mkAccessory, Service, C };
  }

  const mkComp = (machine, remainMin) => ({
    washerOperatingState: {
      machineState: { value: machine },
      // 'pause'인데 jobState를 'none'으로 주면 분류기가 FINISHED로 먼저 판정한다(실수 방지).
      washerJobState: { value: (machine === 'run' || machine === 'pause') ? 'wash' : 'none' },
      remainingTime: { value: remainMin },
    },
  });

  async function runLaundry(configDevice, statusComponents) {
    const h = mkHarness();
    const acc = h.mkAccessory('세탁기', 'uuid:main');
    acc.context.device = { deviceId: 'W1', label: '세탁기' };
    h.platform.accessories.push(acc);
    const logs = [];
    const l = new Laundry({
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
      api: h.api, platform: h.platform, deviceKind: 'washer',
      smartthings: { invalidateStatusCache() {}, getStatus: async () => statusComponents },
    });
    l.configure(acc, configDevice, '9.9.9');
    await new Promise(r => setTimeout(r, 30));   // 첫 poll 완료 대기
    return { l, h, acc, logs };
  }

  await t('분리 OFF(기본) — 유닛 1개, 둘 중 하나만 돌아도 가동 중', async () => {
    const { l } = await runLaundry(
      { enableNotificationSensor: false },
      { main: mkComp('stop', 0), sub: mkComp('run', 40) });
    assert.strictEqual(l.units.length, 1, '합침인데 유닛이 ' + l.units.length + '개');
    assert.strictEqual(l.units[0].key, 'combined');
    assert.strictEqual(l.units[0].state.active, true, 'sub가 도는데 가동 중이 아니다');
    assert.strictEqual(l.units[0].state.duration, 40 * 60, '잔여시간이 두 조의 최대값이 아니다');
  });

  await t('분리 ON — 유닛 2개, 각 조가 자기 상태만 본다', async () => {
    const { l, h } = await runLaundry(
      { enableNotificationSensor: false, splitCompartments: true },
      { main: mkComp('stop', 0), sub: mkComp('run', 40) });
    assert.strictEqual(l.units.length, 2, '분리인데 유닛이 ' + l.units.length + '개');
    const [m, sub] = l.units;
    assert.strictEqual(m.key, 'main');
    assert.strictEqual(sub.key, 'sub');
    assert.strictEqual(m.state.active, false, '메인은 멈춰 있어야 한다');
    assert.strictEqual(sub.state.active, true, '보조는 돌아야 한다');
    assert.strictEqual(sub.state.duration, 40 * 60);
    // 보조는 새 액세서리로 등록되고 activeUUIDs에 들어가야(정리 대상에서 제외) 한다
    assert.ok(h.registered.some(a => a.UUID === 'uuid:W1:compartment:sub'), '보조 액세서리 미등록');
    assert.ok(h.platform.activeUUIDs.has('uuid:W1:compartment:sub'), 'activeUUIDs 누락 — 재시작 시 지워진다');
  });

  await t('분리 ON — 이름을 지정하면 그 이름을 쓴다', async () => {
    const { l, acc } = await runLaundry(
      { enableNotificationSensor: false, splitCompartments: true,
        mainCompartmentName: '애드워시', subCompartmentName: '콤팩트워시' },
      { main: mkComp('run', 10), sub: mkComp('stop', 0) });
    assert.strictEqual(l.units[0].label, '애드워시');
    assert.strictEqual(l.units[1].label, '콤팩트워시');
    assert.strictEqual(acc.displayName, '애드워시', '메인 액세서리 이름이 안 바뀌었다');
  });

  await t('분리 ON — 종료 알림 센서가 조마다 따로 생긴다 (UUID 충돌 없음)', async () => {
    const { h } = await runLaundry(
      { enableNotificationSensor: true, splitCompartments: true },
      { main: mkComp('run', 10), sub: mkComp('run', 20) });
    const ids = h.registered.map(a => a.UUID);
    assert.ok(ids.includes('uuid:W1:notif:onCompletion:motion'), '메인 센서 없음');
    assert.ok(ids.includes('uuid:W1:notif:onCompletion:motion:sub'), '보조 센서 없음');
    assert.strictEqual(new Set(ids).size, ids.length, '액세서리 UUID가 중복됐다');
  });

  await t('분리 ON인데 보조 구획이 없으면 경고한다 (2-in-1 아님)', async () => {
    const { logs } = await runLaundry(
      { enableNotificationSensor: false, splitCompartments: true },
      { main: mkComp('run', 10) });
    assert.ok(logs.some(m => /보조 구획이 응답에 없습니다/.test(m)),
      '경고가 없다: ' + JSON.stringify(logs));
  });

  await t('설정 UI에 분리 옵션이 노출된다 (layout 등록 확인)', () => {
    const sc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const P2 = sc.schema.properties.devices.items.properties;
    for (const k of ['splitCompartments', 'mainCompartmentName', 'subCompartmentName']) {
      assert.ok(P2[k], 'schema에 ' + k + ' 없음');
    }
    assert.strictEqual(P2.splitCompartments.default, false, '기본값은 합침이어야 한다');
    const flat = JSON.stringify(sc.layout);
    for (const k of ['splitCompartments', 'mainCompartmentName', 'subCompartmentName']) {
      assert.ok(flat.includes('devices[].' + k), k + '가 layout에 없다 — UI에 안 그려진다');
    }
  });

  // ===== 적대 감사 지적 구멍 보강 =====
  // runLaundry는 첫 폴만 돌린다. 상태를 바꿔 가며 여러 폴을 재현하려면 직접 제어가 필요하다.
  async function runSeq(configDevice, sequence) {
    const h = mkHarness();
    const acc = h.mkAccessory('세탁기', 'uuid:main');
    acc.context.device = { deviceId: 'W1', label: '세탁기' };
    h.platform.accessories.push(acc);
    const logs = [];
    let idx = 0;
    const l = new Laundry({
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
      api: h.api, platform: h.platform, deviceKind: 'washer',
      smartthings: {
        invalidateStatusCache() {},
        getStatus: async () => sequence[Math.min(idx, sequence.length - 1)],
      },
    });
    // 폴 간격을 최소로 낮춰 시퀀스를 빠르게 진행시킨다.
    l.configure(acc, { ...configDevice, sensorPollInterval: 5 }, '9.9.9');
    // 폴 간격 하한이 5초라 그보다 길게 기다려야 다음 폴이 돈다.
    const step = async () => { idx++; await new Promise(r => setTimeout(r, 5300)); };
    await new Promise(r => setTimeout(r, 40));
    return { l, h, acc, logs, step };
  }

  await t('★종료 펄스가 RUNNING→FINISHED에서 정확히 1회만 발사된다', async () => {
    const { l, h, step } = await runSeq(
      { enableNotificationSensor: true },
      [{ main: mkComp('run', 30), sub: mkComp('stop', 0) },
        { main: mkComp('stop', 0), sub: mkComp('stop', 0) },
        { main: mkComp('stop', 0), sub: mkComp('stop', 0) }]);
    const sensorAcc = h.registered.find(a => a.UUID === 'uuid:W1:notif:onCompletion:motion');
    assert.ok(sensorAcc, '센서 액세서리가 없다');
    let fired = 0;
    const svc = sensorAcc._s.get('MotionSensor');
    const orig = svc.updateCharacteristic.bind(svc);
    svc.updateCharacteristic = (k, v) => { if (k === 'MotionDetected' && v === true) fired++; return orig(k, v); };
    await step();               // RUNNING → FINISHED
    assert.strictEqual(fired, 1, '전환 시 펄스가 ' + fired + '회');
    await step();               // FINISHED 유지
    assert.strictEqual(fired, 1, 'FINISHED 유지 중에 또 발사됐다: ' + fired);
    assert.strictEqual(l.units[0].state.active, false);
  });

  await t('★분리 모드에서 한쪽만 끝나면 그 조의 센서만 발사된다 (교차 오발사 없음)', async () => {
    const { h, step } = await runSeq(
      { enableNotificationSensor: true, splitCompartments: true },
      [{ main: mkComp('run', 30), sub: mkComp('run', 20) },
        { main: mkComp('stop', 0), sub: mkComp('run', 20) }]);
    const count = {};
    for (const key of ['uuid:W1:notif:onCompletion:motion', 'uuid:W1:notif:onCompletion:motion:sub']) {
      const a = h.registered.find(x => x.UUID === key);
      const svc = a._s.get('MotionSensor');
      const orig = svc.updateCharacteristic.bind(svc);
      count[key] = 0;
      svc.updateCharacteristic = (k, v) => { if (k === 'MotionDetected' && v === true) count[key]++; return orig(k, v); };
    }
    await step();               // 메인만 종료
    assert.strictEqual(count['uuid:W1:notif:onCompletion:motion'], 1, '메인 센서가 안 울렸다');
    assert.strictEqual(count['uuid:W1:notif:onCompletion:motion:sub'], 0, '보조 센서가 잘못 울렸다');
  });

  await t('★합침 모드는 보조 액세서리 UUID를 activeUUIDs에 넣지 않는다 (분리 해제 시 정리됨)', async () => {
    const { h } = await runLaundry(
      { enableNotificationSensor: true },
      { main: mkComp('stop', 0), sub: mkComp('stop', 0) });
    assert.ok(!h.platform.activeUUIDs.has('uuid:W1:compartment:sub'),
      '합침인데 보조 밸브 UUID가 살아 있다 — 분리를 꺼도 안 지워진다');
    assert.ok(!h.platform.activeUUIDs.has('uuid:W1:notif:onCompletion:motion:sub'),
      '합침인데 보조 센서 UUID가 살아 있다');
    // 메인/합침 센서 UUID는 유지되어야 재페어링이 없다
    assert.ok(h.platform.activeUUIDs.has('uuid:W1:notif:onCompletion:motion'), '메인 센서 UUID가 빠졌다');
  });

  await t('★HomeKit이 실제로 읽는 getter가 유닛별로 올바른 값을 준다 (클로저 교차 없음)', async () => {
    const { l, acc, h } = await runLaundry(
      { enableNotificationSensor: false, splitCompartments: true },
      { main: mkComp('stop', 0), sub: mkComp('run', 25) });
    const read = (a) => new Promise((res, rej) => {
      const ch = a._s.get('Valve').getCharacteristic('Active');
      ch.listeners.get[0]((err, v) => err ? rej(err) : res(v));
    });
    const subAcc = h.registered.find(x => x.UUID === 'uuid:W1:compartment:sub');
    assert.strictEqual(await read(acc), 0, '메인 getter가 ACTIVE를 반환했다(멈춰 있는데)');
    assert.strictEqual(await read(subAcc), 1, '보조 getter가 INACTIVE를 반환했다(도는 중인데)');
    assert.strictEqual(l.units[0].state.state !== l.units[1].state.state, true, '두 유닛 상태가 같다');
  });

  await t('★분리 모드는 hca.main을 보조로 오인하지 않는다 (감사 H-1)', async () => {
    const { l, logs } = await runLaundry(
      { enableNotificationSensor: false, splitCompartments: true },
      { main: mkComp('run', 10), 'hca.main': mkComp('run', 10) });   // sub 없음, hca.main만
    assert.ok(logs.some(m => /보조 구획이 응답에 없습니다/.test(m)),
      'hca.main을 sub로 오인해 경고가 억제됐다');
    assert.notStrictEqual(l.units[1].state.active, true, 'hca.main을 보조 세탁조로 읽었다');
  });

  await t('합침 모드는 hca.main을 보조로 계속 인정한다 (하위 호환)', async () => {
    const { l } = await runLaundry(
      { enableNotificationSensor: false },
      { main: mkComp('stop', 0), 'hca.main': mkComp('run', 15) });
    assert.strictEqual(l.units[0].state.active, true, 'hca.main 폴백이 깨졌다');
  });

  await t('★일시정지 상태로 시작해도 잔여시간이 0으로 고착되지 않는다 (감사 M-2)', async () => {
    const { l } = await runLaundry(
      { enableNotificationSensor: false },
      { main: mkComp('pause', 18), sub: mkComp('stop', 0) });
    assert.strictEqual(l.units[0].state.state, 'PAUSED', '상태가 PAUSED가 아니다: ' + l.units[0].state.state);
    assert.strictEqual(l.units[0].state.duration, 18 * 60, '잔여시간이 시드되지 않았다: ' + l.units[0].state.duration);
  });

  // ===== 세탁기 8888(구형 토큰) 경로 =====
  const LegacyLaundryClient = require('../lib/api/LegacyLaundryClient');

  // 실기기 응답을 픽스처로 고정한다(2026-07-29 실측). 형태가 바뀌면 여기서 걸린다.
  const REAL_RESPONSE = {
    Devices: [
      { Operation: { state: 'Ready', power: 'Off', progress: 'None', progressPercentage: 1, remainingTime: '00:52:00' },
        Washer: { waterTemperature: 'Cold', rinseCycles: 2 } },
      { Operation: { state: 'Ready', power: 'On', progress: 'None', progressPercentage: 1, remainingTime: '01:09:00' },
        Washer: { waterTemperature: '40', rinseCycles: 3, spinLevel: 'High' } },
    ],
  };

  const mkLaundryClient = (response) => {
    const c = Object.create(LegacyLaundryClient.prototype);
    c.log = silentLog;
    c.transport = { getDeviceStatus: async () => response, _statusCache: { json: '{}', ts: 1 } };
    return c;
  };

  await t('8888 응답이 Laundry가 읽는 컴포넌트 형태로 변환된다', async () => {
    const comps = await mkLaundryClient(REAL_RESPONSE).getStatus();
    assert.deepStrictEqual(Object.keys(comps).sort(), ['main', 'sub']);
    // Laundry의 pickOperatingState가 찾는 키가 실제로 있어야 한다(v2.3.2 죽은 코드 사고 방지)
    for (const k of ['main', 'sub']) {
      assert.ok(comps[k].washerOperatingState, k + '에 washerOperatingState 없음');
      assert.ok(comps[k].dryerOperatingState, k + '에 dryerOperatingState 없음');
      assert.ok('machineState' in comps[k].washerOperatingState, 'machineState 없음');
      assert.ok('washerJobState' in comps[k].washerOperatingState, 'washerJobState 없음');
      // ★잔여시간은 운전 중일 때만 넣는다(감사 D-1). 대기 상태에선 키가 없는 게 정상 —
      //   0을 넣으면 소비자가 '정보 없음'으로 접어 직전 값을 매 폴 재푸시한다.
      assert.ok(!('remainingTime' in comps[k].washerOperatingState),
        '대기 상태인데 remainingTime이 들어 있다');
    }
  });

  await t('★전원이 꺼져 있으면 stop, 켜져 있고 애매하면 on (종료 알림 조기발사 방지)', async () => {
    const comps = await mkLaundryClient(REAL_RESPONSE).getStatus();
    // ★2026-07-30 — main/sub가 배열 순서가 아니라 **기능**으로 정해진다.
    //   이 픽스처의 Devices[1]이 `spinLevel`을 가진 큰 조(애드워시)이므로 그쪽이 main이다.
    //   (실기기·SmartThings 앱 교차 확인. 초기 가정 "0=애드워시"는 틀렸다.)
    //   테스트 의도는 그대로다 — Off는 stop, On+Ready는 'on'.
    assert.strictEqual(comps.sub.washerOperatingState.machineState.value, 'stop',
      '전원 Off인데 stop이 아니다');
    // 전원 On + state=Ready는 'stop'으로 단정하면 안 된다 — jobState 판정이 살아 있어야 한다
    assert.strictEqual(comps.main.washerOperatingState.machineState.value, 'on',
      '전원 On인데 stop으로 단정했다 — 안티주름 단계에서 종료 알림이 조기 발사된다');
  });

  await t('운전/일시정지는 run/pause로 매핑되고 잔여시간이 살아난다', async () => {
    const comps = await mkLaundryClient({ Devices: [
      { Operation: { state: 'Run', power: 'On', progress: 'Wash', remainingTime: '00:45:00' } },
      { Operation: { state: 'Pause', power: 'On', progress: 'Rinse', remainingTime: '00:20:00' } },
    ] }).getStatus();
    assert.strictEqual(comps.main.washerOperatingState.machineState.value, 'run');
    assert.strictEqual(comps.sub.washerOperatingState.machineState.value, 'pause');
    assert.strictEqual(comps.main.washerOperatingState.remainingTime.value, 45);
    assert.strictEqual(comps.sub.washerOperatingState.remainingTime.value, 20, '일시정지에서 잔여시간이 죽었다');
  });

  await t('★운전 중이 아니면 잔여시간 키를 아예 빼서 정보 없음으로 준다 (감사 D-1)', async () => {
    const comps = await mkLaundryClient(REAL_RESPONSE).getStatus();
    assert.strictEqual(comps.main.washerOperatingState.remainingTime, undefined);
    assert.strictEqual(comps.sub.washerOperatingState.remainingTime, undefined);
  });

  await t('단일조 기기(Devices 1개)는 sub 없이 main만 준다', async () => {
    const comps = await mkLaundryClient({ Devices: [
      { Operation: { state: 'Run', power: 'On', progress: 'Wash', remainingTime: '00:30:00' } },
    ] }).getStatus();
    assert.deepStrictEqual(Object.keys(comps), ['main']);
  });

  await t('Devices가 비었으면 조용히 성공하지 않고 오류를 낸다', async () => {
    await assert.rejects(mkLaundryClient({ Devices: [] }).getStatus(), /Devices/);
    await assert.rejects(mkLaundryClient({}).getStatus(), /Devices/);
  });

  await t('★Operation이 없으면 꺼짐으로 위조하지 않는다 (감사 F2 — 조기 종료알림 방지)', async () => {
    const comps = await mkLaundryClient({ Devices: [{}] }).getStatus();
    assert.strictEqual(comps.main.washerOperatingState, undefined,
      '정보가 없는데 운전 상태를 지어냈다 — stop이면 즉시 종료로 확정된다');
    // Laundry가 UNKNOWN으로 읽어 직전 상태를 보존해야 한다
    const { l } = await runLaundry({ enableNotificationSensor: false }, comps);
    assert.strictEqual(l.units[0].state.state, 'UNKNOWN');
  });

  await t('전원 표기 대소문자가 달라도 인식한다', async () => {
    const comps = await mkLaundryClient({ Devices: [
      { Operation: { state: 'run', power: 'ON', progress: 'Wash', remainingTime: '00:10:00' } },
    ] }).getStatus();
    assert.strictEqual(comps.main.washerOperatingState.machineState.value, 'run');
  });

  await t('invalidateStatusCache가 전송 캐시를 실제로 비운다', async () => {
    const c = mkLaundryClient(REAL_RESPONSE);
    assert.ok(c.transport._statusCache, '사전 조건 불성립');
    c.invalidateStatusCache();
    assert.strictEqual(c.transport._statusCache, null, '캐시가 안 비워졌다 — 폴링이 낡은 값을 받는다');
  });

  await t('★8888 경로 결과가 Laundry 분류를 통과한다 (소비 지점 도달 확인)', async () => {
    const comps = await mkLaundryClient({ Devices: [
      { Operation: { state: 'Run', power: 'On', progress: 'Wash', remainingTime: '00:40:00' } },
      { Operation: { state: 'Ready', power: 'Off', progress: 'None', remainingTime: '00:00:00' } },
    ] }).getStatus();
    const { l } = await runLaundry({ enableNotificationSensor: false, splitCompartments: true }, comps);
    assert.strictEqual(l.units[0].state.active, true, '운전 중인 조가 가동으로 안 잡혔다');
    assert.strictEqual(l.units[0].state.duration, 40 * 60, '잔여시간이 초로 환산되지 않았다');
    assert.strictEqual(l.units[1].state.active, false);
  });

  await t('설정 UI에 세탁기 로컬(토큰) 항목이 노출된다', () => {
    const sc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    assert.ok(sc.schema.properties.devices.items.properties.local.properties.token, 'local.token 스키마 없음');
    const nodes = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.key) nodes.push(n);
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
    };
    walk(sc.layout);
    const run = (key, dev) => {
      const nd = nodes.find(x => x.key === key);
      assert.ok(nd, key + ' layout 없음');
      const fb = nd.condition && nd.condition.functionBody;
      return fb ? !!new Function('model', 'arrayIndices', fb)({ devices: [dev] }, [0]) : true;
    };
    // 세탁기 + 로컬에서만 토큰 칸이 보여야 한다
    assert.strictEqual(run('devices[].local.token', { deviceType: 'washer', transport: 'local' }), true);
    assert.strictEqual(run('devices[].local.token', { deviceType: 'washer', transport: 'cloud' }), false);
    assert.strictEqual(run('devices[].local.token', { deviceType: 'dryer', transport: 'local' }), false,
      '건조기(DTLS)에 토큰 칸이 보인다');
    // 전송 경로가 세탁기에 되살아났는지
    assert.strictEqual(run('devices[].transport', { deviceType: 'washer' }), true, '세탁기에 전송 경로가 없다');
  });

  // ===== 8888 기기 무응답 처리 (감사 D1/D2 — 세탁기는 꺼지면 사라지는 게 정상) =====
  const mkOfflineClient = (opts = {}) => {
    const c = Object.create(LegacyLaundryClient.prototype);
    const logs = [];
    c.log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]), debug: () => {} };
    c.label = '세탁기';
    c._offlineStreak = 0;
    c._offlineNotified = false;
    c._fallbackNotified = false;
    c._lastRunning = false;
    c._lastCount = opts.lastCount || 1;
    c.cloud = opts.cloud || null;
    c.deviceId = opts.deviceId || null;
    c.fallbackToCloud = opts.fallbackToCloud !== false;
    c.transport = { getDeviceStatus: async () => { throw new Error(opts.err || '요청 시간 초과'); },
      _statusCache: null };
    c._logs = logs;
    return c;
  };

  // ══ v2.4.5 적대 감사 회귀 (전부 "재현 → 수정 → 통과"를 실제로 밟은 항목) ══

  // 응답을 마음대로 바꿔 가며 폴을 돌릴 수 있는 클라이언트.
  const mkSeqClient = (opts = {}) => {
    const c = Object.create(LegacyLaundryClient.prototype);
    const logs = [];
    c.log = { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]), debug: () => {} };
    c.label = '세탁기';
    c._offlineStreak = 0; c._offlineNotified = false; c._fallbackNotified = false;
    c._lastRunning = false; c._lastCount = 1;
    c.cloud = opts.cloud || null;
    c.deviceId = opts.deviceId || null;
    c.fallbackToCloud = opts.fallbackToCloud !== false;
    c._next = opts.first;
    c.transport = { _statusCache: null, getDeviceStatus: async () => c._next() };
    c._logs = logs;
    return c;
  };
  const UNREACH = () => { throw new Error('TLS 소켓 오류: connect EHOSTUNREACH 1.2.3.4:8888'); };
  const OPS = (...ops) => () => ({ Devices: ops.map(o => (o ? { Operation: o } : {})) });

  await t('★403 쿨다운은 클라우드로 폴백하지 않는다 (사이클 종료마다 새던 호출)', async () => {
    // 2026-07-30 실사이클 실측: 종료 직후 기기가 403을 한 번 낸다(직전 요청 처리 중).
    // HANDOFF §0-A3에 "403은 정상 쿨다운"이라고 적혀 있었는데 코드는 401과 같이 다뤘다.
    let cloudCalls = 0;
    const c = mkSeqClient({
      first: () => { const e = new Error('기기가 직전 요청을 처리 중입니다 (status 403) — 잠시 후 자동 재시도'); e.cooldown = true; throw e; },
      cloud: { getStatus: async () => { cloudCalls++; return {}; } }, deviceId: 'W1',
    });
    await c.getStatus().then(
      () => assert.fail('403인데 상태를 지어냈다'),
      (e) => assert.strictEqual(e._transient, true, '403에 _transient가 없어 액세서리가 오류로 로그한다'));
    assert.strictEqual(cloudCalls, 0, '★403 쿨다운으로 클라우드를 호출했다 — 세탁할 때마다 1회씩 나간다');
  });

  await t('★403은 토큰 무효(401)와 다르게 분류된다 (전송 계층)', async () => {
    const { LegacyACClient } = require('../lib/api/LegacyACClient');
    const logs = [];
    const log = { info: m => logs.push(['info', String(m)]), warn: m => logs.push(['warn', String(m)]),
      error: m => logs.push(['error', String(m)]), debug: () => {} };
    const mk = (status) => {
      const t2 = new LegacyACClient('10.77.0.' + status, 'x'.repeat(10), log, { timeout: 10 });
      t2._rawRequest = async () => {
        if (status === 401) throw new Error('인증 실패 (status 401): 토큰을 다시 추출해야 할 수 있습니다.');
        const e = new Error('기기가 직전 요청을 처리 중입니다 (status 403) — 잠시 후 자동 재시도');
        e.cooldown = true; throw e;
      };
      return t2;
    };
    await mk(403).getDeviceStatus().catch(() => {});
    assert.strictEqual(logs.filter(([lv]) => lv !== 'debug').length, 0,
      '403 쿨다운이 사용자 로그로 샜다: ' + JSON.stringify(logs));
    logs.length = 0;
    await mk(401).getDeviceStatus().catch(() => {});
    assert.ok(logs.some(([lv, m]) => lv === 'error' && /토큰을 다시 추출/.test(m)),
      '401은 여전히 사람이 볼 error여야 한다 (진짜 조치가 필요하다)');
  });

  await t('★실기기 실측 페이로드 — 애드워시를 main으로 잡고 낡은 잔여시간을 버린다', async () => {
    // 2026-07-30 12:14 실기기(WR20M9970KV) 응답 그대로. SmartThings 앱 교차 확인:
    // 콤팩트워시=대기 중, 애드워시=탈수 중. ★기기는 콤팩트워시를 Devices[0]로 준다 —
    // 초기 가정(0=애드워시)이 틀렸고, 그래서 위치가 아니라 기능으로 판별하게 바꿨다.
    const REAL = { Devices: [
      { Operation: { kidsLock: 'Ready', power: 'Off', progress: 'None', progressPercentage: 1,
        remainingTime: '00:52:00', state: 'Ready',
        supportedProgress: ['None', 'Wash', 'Rinse', 'Spin', 'Finish'] },
      Washer: { rinseCycles: '2', waterTemperature: 'Cold' } },
      { Operation: { kidsLock: 'Ready', power: 'On', progress: 'Rinse', progressPercentage: 74,
        remainingTime: '00:12:00', state: 'Run',
        supportedProgress: ['None', 'Weightsensing', 'Wash', 'Rinse', 'Spin', 'Finish'] },
      Washer: { dryLevel: 'None', rinseCycles: '3', spinLevel: 'High' } },
    ] };
    const c = mkSeqClient({ first: () => REAL });
    const r = await c.getStatus();
    assert.strictEqual(r.main.washerOperatingState.machineState.value, 'run',
      '애드워시(큰 조)가 main으로 오지 않았다 — 분리 표시에서 이름표가 뒤바뀐다');
    assert.strictEqual(r.main.washerOperatingState.washerJobState.value, 'rinsing',
      'Rinse 매핑 실패');
    assert.strictEqual(r.main.washerOperatingState.remainingTime.value, 12, '남은 시간 12분이 아니다');
    assert.strictEqual(r.sub.washerOperatingState.machineState.value, 'stop', '콤팩트워시가 대기가 아니다');
    assert.ok(r.sub.washerOperatingState.remainingTime === undefined,
      '★꺼진 조가 들고 있던 낡은 52분을 그대로 내보냈다 — 홈킷에 52분이 뜬다');
    assert.strictEqual(c._lastRunning, true);
  });

  await t('★세탁조 판별이 애매하면 원래 순서를 유지한다 (근거 없이 뒤집지 않기)', async () => {
    const FLAT = { Devices: [
      { Operation: { power: 'On', state: 'Run', progress: 'Wash' }, Washer: { rinseCycles: '1' } },
      { Operation: { power: 'Off', state: 'Ready', progress: 'None' }, Washer: { rinseCycles: '2' } },
    ] };
    const c = mkSeqClient({ first: () => FLAT });
    const r = await c.getStatus();
    assert.strictEqual(r.main.washerOperatingState.machineState.value, 'run', '순서가 바뀌었다');
  });

  await t('★기기가 알려준 supportedProgress 전 값이 매핑표에 있다 (실측 6종)', () => {
    const LegacyLaundry = require('../lib/api/LegacyLaundryClient');
    const seen = ['None', 'Weightsensing', 'Wash', 'Rinse', 'Spin', 'Finish'];
    const unmapped = seen.filter(v => v !== 'None'
      && LegacyLaundry._progressToJobState(v) === null);
    assert.strictEqual(unmapped.length, 0,
      '매핑 없는 진행 단계: ' + unmapped.join(', ') + ' — 그 단계에서 상태 표시가 무너진다');
  });

  await t('F-2 안티주름 단계도 "운전 중"으로 세어 순단을 종료로 단정하지 않는다', async () => {
    // machineState는 'on'으로 떨어지지만 jobState가 wrinklePrevent면 실제로는 돌고 있다.
    // 이걸 운전 중으로 세지 않으면 순단 1폴에 즉시 꺼짐 합성 → 거짓 종료 알림.
    const c = mkSeqClient({ first: OPS({ state: 'Ready', power: 'On', progress: 'WrinklePrevent' }) });
    await c.getStatus();
    assert.strictEqual(c._lastRunning, true, '안티주름을 운전 중으로 세지 않는다');
    c._next = UNREACH;
    await assert.rejects(c.getStatus(), /EHOSTUNREACH/, '순단 1폴에 꺼짐으로 단정했다');
  });

  await t('F-3 클라우드 폴백으로 알아낸 "운전 중"도 기억한다', async () => {
    const cloudRun = { main: { washerOperatingState: { machineState: { value: 'run' } } } };
    const c = mkSeqClient({
      first: () => { throw new Error('응답 처리 실패: 알 수 없는 형식'); },
      cloud: { getStatus: async () => cloudRun }, deviceId: 'W1',
    });
    await c.getStatus();
    assert.strictEqual(c._lastRunning, true, '폴백 결과의 운전 상태를 버렸다');
    c._next = UNREACH;
    await assert.rejects(c.getStatus(), /EHOSTUNREACH/, '폴백 뒤 순단 1폴에 꺼짐으로 단정했다');
  });

  await t('F-6 power 키가 없을 뿐인데 꺼짐으로 판정하지 않는다', async () => {
    const c = mkSeqClient({ first: OPS({ state: 'Run', progress: 'Wash', remainingTime: '00:30:00' }) });
    const r = await c.getStatus();
    assert.strictEqual(r.main.washerOperatingState.machineState.value, 'run',
      'power 누락을 전원 꺼짐으로 오해했다 — 운전 중 거짓 종료 알림으로 이어진다');
  });

  await t('F-7 연결 계열이 아닌 실패는 오프라인 스트릭을 갉아먹지 않는다', async () => {
    const c = mkSeqClient({
      first: OPS({ state: 'Run', power: 'On', progress: 'Wash' }), fallbackToCloud: false,
    });
    await c.getStatus();
    assert.strictEqual(c._lastRunning, true);
    c._next = () => { throw new Error('응답 처리 실패: 알 수 없는 형식'); };
    for (let i = 0; i < 4; i++) await c.getStatus().catch(() => {});
    assert.strictEqual(c._offlineStreak, 0, '비연결 실패가 스트릭을 올렸다 — 방어벽 5회가 1회로 줄어든다');
    c._next = UNREACH;
    await assert.rejects(c.getStatus(), /EHOSTUNREACH/, '연결 실패 1회에 꺼짐으로 단정했다');
  });

  await t('F-4 꺼짐 합성은 마지막으로 본 구획 수만큼 만든다 (분리 모드 보조 구획)', async () => {
    const c = mkSeqClient({
      first: OPS({ state: 'Ready', power: 'On', progress: 'None' },
        { state: 'Ready', power: 'On', progress: 'None' }),
    });
    const on = await c.getStatus();
    assert.ok(on.sub, '2조 응답을 못 읽었다');
    c._next = UNREACH;
    const off = await c.getStatus();
    assert.ok(off.main && off.sub,
      '보조 구획이 사라져 분리 모드에서 11폴마다 강제전환 warn이 무한 반복된다');
    assert.strictEqual(off.sub.washerOperatingState.machineState.value, 'stop');
  });

  await t('F-1 한 번 본 구획이 사라지면 없애지 않고 "정보 없음"으로 채운다', async () => {
    const c = mkSeqClient({
      first: OPS({ state: 'Run', power: 'On', progress: 'Wash' },
        { state: 'Ready', power: 'On', progress: 'None' }),
    });
    await c.getStatus();
    c._next = OPS({ state: 'Ready', power: 'On', progress: 'None' });   // 1개만 오는 부분 응답
    const r = await c.getStatus();
    assert.ok(r.sub, '사라진 구획을 그냥 없앴다 — 남은 구획만으로 종료가 확정돼 거짓 알림이 나간다');
    assert.ok(!r.sub.washerOperatingState, '사라진 구획은 운전 상태를 지어내면 안 된다(UNKNOWN이어야 carry가 산다)');
  });

  await t('F-5 꺼진 기기가 타임아웃형으로 실패해도 전송 계층이 조용하다', async () => {
    const { LegacyACClient } = require('../lib/api/LegacyACClient');
    const logs = [];
    const log = { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]), debug: () => {} };
    const t2 = new LegacyACClient('10.88.0.1', 'x'.repeat(10), log, { timeout: 10, offlineIsNormal: true });
    t2._rawRequest = async () => { throw new Error('요청 시간 초과 (8000ms)'); };
    for (let i = 0; i < 12; i++) { t2._statusCache = null; await t2.getDeviceStatus().catch(() => {}); }
    const visible = logs.filter(([lv]) => lv !== 'debug');
    assert.strictEqual(visible.length, 0,
      '꺼진 기기의 타임아웃이 사용자 로그로 샜다(hb-watch 오탐): ' + JSON.stringify(visible.slice(0, 3)));
  });

  await t('L-F2 순단 예외에는 _transient가 붙어 액세서리가 경보 문구를 안 낸다', async () => {
    const c = mkSeqClient({ first: OPS({ state: 'Run', power: 'On', progress: 'Wash' }) });
    await c.getStatus();
    c._next = UNREACH;
    await c.getStatus().then(
      () => assert.fail('순단인데 꺼짐으로 단정했다'),
      (e) => assert.strictEqual(e._transient, true,
        '_transient가 없으면 Laundry가 "상태 폴링 오류" warn을 찍고 hb-watch가 텔레그램 경보를 낸다'));
  });

  await t('L-F8 폴백에서 복구될 때 "전원 켜짐"이라고 거짓말하지 않는다', async () => {
    const cloudComps = { main: { washerOperatingState: { machineState: { value: 'run' } } } };
    const c = mkSeqClient({
      first: () => { throw new Error('인증 실패 (status 401)'); },
      cloud: { getStatus: async () => cloudComps }, deviceId: 'W1',
    });
    await c.getStatus();
    assert.ok(c._logs.some(([lv, m]) => lv === 'warn' && /클라우드로 폴백/.test(m)), '폴백 경고가 없다');
    c._next = OPS({ state: 'Run', power: 'On', progress: 'Wash' });
    await c.getStatus();
    const msgs = c._logs.map(([, m]) => m).join(' | ');
    assert.ok(!/전원 켜짐/.test(msgs), '전원은 내내 켜져 있었는데 "전원 켜짐"이라고 찍었다: ' + msgs);
    assert.ok(/로컬 복귀/.test(msgs), '복귀 알림이 없다: ' + msgs);
  });

  await t('★직전에 돌고 있지 않았으면 첫 무응답에 바로 꺼짐으로 본다 (재시작 시 즉시 반영)', async () => {
    const c = mkOfflineClient();
    const comps = await c.getStatus();   // _lastRunning=false → 즉시 판정
    assert.strictEqual(comps.main.washerOperatingState.machineState.value, 'stop');
    assert.ok(comps.main.washerOperatingState.remainingTime === undefined);
  });

  await t('★운전 중이었으면 순단을 바로 종료로 단정하지 않는다 (거짓 종료알림 방지)', async () => {
    const c = mkOfflineClient();
    c._lastRunning = true;               // 직전 폴에서 운전 중이었다
    for (let i = 0; i < 4; i++) await assert.rejects(c.getStatus(), /시간 초과/);
    const comps = await c.getStatus();   // 5회째에야 꺼짐
    assert.strictEqual(comps.main.washerOperatingState.machineState.value, 'stop');
  });

  await t('★꺼짐 안내는 info이고 hb-watch 경보 문구를 쓰지 않는다 (오탐 방지)', async () => {
    const c = mkOfflineClient();
    await c.getStatus().catch(() => {});
    const msgs = c._logs.filter(([lv]) => lv === 'info').map(([, m]) => m);
    assert.strictEqual(msgs.length, 1, '안내가 없거나 중복이다: ' + JSON.stringify(c._logs));
    // hb-watch가 경보로 잡는 문구( '폴링 실패' / '상태 조회 실패' / '연결 실패' )가 없어야 한다
    assert.ok(!/폴링 실패|상태 조회 실패|연결 실패|오류/.test(msgs[0]),
      'hb-watch 경보 정규식에 걸리는 문구다: ' + msgs[0]);
    // 반복 폴에서 같은 안내가 계속 찍히면 안 된다
    await c.getStatus();
    assert.strictEqual(c._logs.filter(([lv]) => lv === 'info').length, 1, '안내가 반복됐다');
  });

  await t('★연결이 안 되는 것은 클라우드로 폴백하지 않는다 (상태이지 장애가 아니다)', async () => {
    let called = false;
    const c = mkOfflineClient({
      cloud: { getStatus: async () => { called = true; return {}; } }, deviceId: 'W1',
    });
    const r = await c.getStatus();
    assert.strictEqual(called, false, '전원이 꺼진 것뿐인데 클라우드를 호출했다');
    assert.strictEqual(r.main.washerOperatingState.machineState.value, 'stop');
  });

  await t('연결은 되는데 응답이 이상하면 그때는 클라우드를 쓴다', async () => {
    const cloudComps = { main: { washerOperatingState: { machineState: { value: 'run' } } } };
    const c = mkOfflineClient({
      err: '인증 실패 (status 401)',
      cloud: { getStatus: async () => cloudComps }, deviceId: 'W1',
    });
    assert.strictEqual(await c.getStatus(), cloudComps, '진짜 장애인데 폴백하지 않았다');
  });

  await t('폴백을 끄면 클라우드를 쓰지 않는다', async () => {
    let called = false;
    const c = mkOfflineClient({
      cloud: { getStatus: async () => { called = true; return {}; } },
      deviceId: 'W1', fallbackToCloud: false,
    });
    await c.getStatus().catch(() => {});
    assert.strictEqual(called, false, 'fallbackToCloud=false인데 클라우드를 호출했다');
  });

  await t('연결 계열이 아닌 오류는 꺼짐으로 접지 않는다 (폴백도 없으면 그대로 올린다)', async () => {
    const c = mkOfflineClient({ err: '인증 실패 (status 401)', fallbackToCloud: false });
    await assert.rejects(c.getStatus(), /401/);
    await assert.rejects(c.getStatus(), /401/, '토큰 오류를 꺼짐으로 위조했다');
  });

  await t('★복구되면 알린다', async () => {
    const c = mkOfflineClient();
    await c.getStatus().catch(() => {});   // 꺼짐 판정
    c.transport.getDeviceStatus = async () => ({
      Devices: [{ Operation: { state: 'Run', power: 'On', progress: 'Wash', remainingTime: '00:10:00' } }],
    });
    await c.getStatus();
    assert.ok(c._logs.some(([lv, m]) => lv === 'info' && /전원 켜짐/.test(m)), '켜짐 알림이 없다');
  });

  await t('8888 기기는 파이썬 DTLS 브릿지를 띄우지 않는다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/transport === 'local' && !d\?\.local\?\.token/.test(src),
      '8888 기기가 브릿지 기동 조건에서 제외되지 않았다');
  });

  await t('부팅 실패가 홈브릿지 전체를 죽이지 않는다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const seg = src.slice(src.indexOf("didFinishLaunching'"), src.indexOf("didFinishLaunching'") + 260);
    assert.ok(/\.catch\(/.test(seg), 'didFinishLaunching에 catch가 없다 — 미처리 거부로 프로세스가 죽는다');
    assert.ok(/new LegacyLaundryClient[\s\S]{0,600}?catch/.test(src),
      '8888 클라이언트 생성이 try/catch로 감싸이지 않았다 — 인증서 오류가 전 기기를 죽인다');
  });

  await t('세탁기/건조기가 아닌 기기에 토큰이 있어도 8888로 가지 않는다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/deviceType !== 'washer' && configDevice\.deviceType !== 'dryer'/.test(src),
      '토큰만 보고 전송을 가르면 오설정 기기가 통째로 죽는다');
  });

  await t('★클라우드 keepalive가 걸려 있다 (로컬 전환 후 폴백 토큰 부패 방지)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/_startCloudKeepalive\(\)/.test(src), 'keepalive 호출/정의가 없다');
    const at = src.indexOf('_startCloudKeepalive() {');
    assert.ok(at > 0, 'keepalive 메서드 정의가 없다');
    const seg = src.slice(at, at + 2000);
    assert.ok(/refreshToken\(\)/.test(seg), '토큰 갱신을 호출하지 않는다 — 호출이 없으면 401도 없고 갱신도 없다');
    assert.ok(/24 \* 60 \* 60 \* 1000/.test(seg), '하루 주기가 아니다');
    assert.ok(/localDevs/.test(seg), '로컬 사용 여부를 보지 않는다(클라우드 상시 구성엔 불필요)');
    // v2.4.5 — 폴백을 전부 끈 구성에서는 keepalive가 '마지막 남은 클라우드 호출 1회/일'이 된다.
    // "클라우드 0회"를 원하는 사용자를 위해 그때는 아예 걸지 않는다.
    assert.ok(/anyFallback/.test(seg), '폴백을 전부 껐는데도 토큰 갱신을 건다');
    // 갱신은 single-flight를 거쳐야 한다 — 401 인터셉터의 갱신과 겹치면 refresh 토큰이
    // 회전하며 늦게 도착한 쪽이 무효 토큰을 쓰게 된다.
    assert.ok(/_refreshTokenSingleFlight/.test(seg), 'single-flight를 거치지 않아 동시 갱신 충돌 위험');
    assert.ok(!/unlink|_triggerReauth/.test(seg),
      '갱신 실패에 토큰을 파기한다 — 일시 장애로 전 기기 폴백이 죽는다');
    assert.ok(/registerShutdown/.test(seg), 'shutdown에서 타이머를 정리하지 않는다');
  });


  // ===== 꺼져 있는 게 정상인 기기의 로그 (사용자 지적: 세탁기는 에어컨과 달라야 한다) =====
  await t('★세탁기 무응답은 사용자 로그에 남지 않는다 (에어컨은 종전대로)', async () => {
    const { LegacyACClient } = require('../lib/api/LegacyACClient');
    const mk = (label, offlineIsNormal) => {
      const out = [];
      const lg = {
        info: (m) => out.push(['info', m]), warn: (m) => out.push(['warn', m]),
        error: (m) => out.push(['error', m]), debug: (m) => out.push(['debug', m]),
      };
      const c = new LegacyACClient('10.0.0.9', 't', lg, {
        timeout: 20, cert: Buffer.from(''), key: Buffer.from(''), label, offlineIsNormal,
      });
      c._rawRequest = async () => { throw new Error('TLS 소켓 오류: connect EHOSTUNREACH 10.0.0.9:8888'); };
      return { c, out };
    };
    const ALARM = /폴링 실패|상태 조회 실패|연결 실패|무응답 지속|최종 요청 실패/;

    const w = mk('세탁기', true);
    for (let n = 0; n < 12; n++) await w.c.getDeviceStatus().catch(() => {});
    const wVisible = w.out.filter(([lv]) => lv !== 'debug');
    assert.strictEqual(wVisible.length, 0,
      '꺼진 세탁기가 사용자 로그를 남긴다: ' + JSON.stringify(wVisible.slice(0, 3)));
    assert.ok(w.out.length > 0, 'debug로도 안 남으면 진단이 불가능하다');

    const a = mk('거실 에어컨', false);
    for (let n = 0; n < 12; n++) await a.c.getDeviceStatus().catch(() => {});
    const aAlarm = a.out.filter(([lv, m]) => lv !== 'debug' && ALARM.test(m));
    assert.ok(aAlarm.length > 0,
      '에어컨의 무응답 경고까지 사라졌다 — 상시연결 기기는 종전대로 알려야 한다');
  });

  await t('세탁물 어댑터가 offlineIsNormal을 켜서 전송에 넘긴다 (소스 불변식)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'LegacyLaundryClient.js'), 'utf8');
    assert.ok(/offlineIsNormal:\s*true/.test(src), '세탁물 기기에 오프라인 정상 플래그가 없다');
  });


  console.log(`\n총 ${passed + failed}건 / 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
