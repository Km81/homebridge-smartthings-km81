'use strict';

/**
 * 완전 로컬 전용 구성 (2026년 10월 SmartThings 유료화 대비).
 *
 * ★왜: 폴백을 끄면 `_fallbackSince`가 **절대 세워지지 않는다** — 그 값은 `canFallback`
 * 블록 안에서만 찍히기 때문이다. 그래서 복구 알림이 늘 debug로 떨어졌고,
 * `제어되지 않습니다` 경보(error)는 걸리는데 **푸는 문구가 없었다.**
 * NAS 감시기(hb-watch)는 복구 어휘로 `로컬 복귀`를 보는데 `로컬 순단 … 정상화`에는
 * 그 말이 없다 → 🔴가 뜨면 기기가 살아나도 영원히 안 풀린다.
 * 2026-07-31 에너톡에서 겪은 것과 **같은 구조**(로그스타일 §8 규칙 1 위반).
 *
 * ⚠️여기서 재는 것은 "경보와 복구가 **짝을 이루는가**"다. 로그 줄 수가 아니라
 *   **감시기가 인식하는 어휘가 양쪽에 다 있는가**를 본다.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

// hb_watch.sh 가 쓰는 어휘(2026-08-02 실측 추출). 실패/복구 판정에 쓰인다.
// ⚠️여기 값을 손으로 늘리지 말 것 — NAS 정본에서 추출해 대조하는 것이 원칙이다
//   (로그스타일 §9 규칙 5·7). 여기 사본은 **오프라인 회귀용 최소 집합**이다.
const ALARM_WORDS = ['제어되지 않습니다', '사실상 클라우드로 동작 중', '폴링 실패',
  '상태 조회 실패', '상태 폴링 오류', '연결 실패', '폴링 중 오류', '상태 조회 오류',
  '기기 오프라인'];   // ★2026-08-03 정본 재추출로 1종 추가(log_volume.js와 같은 집합)
const RECOVER_WORDS = ['복구', '연결됨', '로컬 복귀', '수신 복귀', '기기 접속됨',
  '폴링 회복됨', '기기 온라인 복귀'];

const hasAny = (line, words) => words.some((w) => line.includes(w));

function makeClient({ fallback }) {
  const lines = [];
  const rec = (lv) => (m) => lines.push({ lv, m: String(m) });
  const log = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  const c = new LocalApplianceClient(log, { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'km81-lo-')) });
  c._ready = true;
  c.cloud = fallback ? { get: () => 25 } : null;
  c.devices.set('D', { host: '192.168.0.9', port: 49154, fallbackToCloud: fallback, label: '놀이방 에어컨' });
  return { c, lines };
}

/** 연속 실패 n회 → 성공 1회. 실제 `_withFallback`을 탄다. */
async function failThenRecover(c, n) {
  for (let i = 0; i < n; i++) {
    try {
      await c._withFallback('D', '상태 조회',
        async () => { throw new Error('로컬 요청 시간 초과'); },
        c.cloud ? () => c.cloud.get() : null, { kind: 'read' });
    } catch (_) { /* 폴백이 없으면 던진다 */ }
  }
  await c._withFallback('D', '상태 조회', async () => 25, c.cloud ? () => c.cloud.get() : null, { kind: 'read' });
}

(async () => {
  // ── ① ★폴백 없음 + 장시간 끊김 → 경보가 걸리고, 복구가 **그 경보를 푼다**
  {
    const { c, lines } = makeClient({ fallback: false });
    await failThenRecover(c, 12);

    const alarm = lines.filter((l) => hasAny(l.m, ALARM_WORDS));
    const recov = lines.filter((l) => hasAny(l.m, RECOVER_WORDS));
    check(alarm.length >= 1, '연속 실패가 쌓이면 경보를 건다');
    check(alarm.some((l) => l.lv === 'error' && /제어되지 않습니다/.test(l.m)),
      '폴백이 없으면 「제어되지 않습니다」로 알린다 (폴백이 없다는 사실을 말한다)');
    check(recov.length >= 1,
      '★★복구 때 감시기가 인식하는 문구가 나온다 (없으면 🔴가 영원히 안 풀린다)');
    check(recov.some((l) => l.lv === 'info'),
      '★그 복구 문구는 info다 (debug면 로그 파일에 없어 감시기가 못 본다)');
    check(recov.some((l) => /로컬 복귀/.test(l.m)), '복구 어휘 `로컬 복귀`를 쓴다');
    check(recov.some((l) => /클라우드 미사용/.test(l.m)),
      '클라우드를 안 썼다는 사실도 함께 말한다 (거짓말하지 않는다)');
  }

  // ── ② 짧은 순단은 여전히 조용하다 (하루 수십 줄이 되면 안 된다)
  {
    const { c, lines } = makeClient({ fallback: false });
    await failThenRecover(c, 2);      // 경보 임계(10) 미만
    check(!lines.some((l) => hasAny(l.m, ALARM_WORDS)), '짧은 순단은 경보를 걸지 않는다');
    check(!lines.some((l) => l.lv === 'info' && /로컬 복귀/.test(l.m)),
      '★경보를 안 걸었으면 복구도 info로 올리지 않는다 (로그 폭주 방지)');
    check(lines.some((l) => l.lv === 'debug' && /로컬 순단/.test(l.m)), '대신 debug로 남긴다');
  }

  // ── ③ 폴백이 있는 구성은 예전 그대로 (회귀 아님)
  {
    const { c, lines } = makeClient({ fallback: true });
    await failThenRecover(c, 12);
    const recov = lines.filter((l) => l.lv === 'info' && /로컬 복귀/.test(l.m));
    check(recov.length === 1, '폴백이 있으면 예전처럼 로컬 복귀를 한 줄 낸다');
    // ⚠️경과시간(`N초간 클라우드 사용`)은 0초로 반올림되면 생략된다 — 여기서 잴 것은
    //   **거짓말을 하지 않는가**다. 클라우드를 실제로 썼는데 '미사용'이라고 하면 안 된다.
    check(!/클라우드 미사용/.test(recov[0]?.m || ''),
      '★클라우드를 실제로 썼으면 「미사용」이라고 하지 않는다');
  }

  // ── ④ 경보→복구→재실패→복구 (플래그가 눌어붙지 않는다)
  {
    const { c, lines } = makeClient({ fallback: false });
    await failThenRecover(c, 11);
    await failThenRecover(c, 11);
    const alarms = lines.filter((l) => l.lv === 'error' && /제어되지 않습니다/.test(l.m));
    const recovs = lines.filter((l) => l.lv === 'info' && /로컬 복귀/.test(l.m));
    check(alarms.length === 2, '두 번 끊기면 경보도 두 번 (첫 번째에 눌어붙지 않는다)');
    check(recovs.length === 2, '★복구도 두 번 — 짝이 맞는다');
  }

  // ── ⑤ ★경보와 복구의 짝 계약 (이게 이 스위트의 핵심)
  {
    const { c, lines } = makeClient({ fallback: false });
    await failThenRecover(c, 12);
    const seq = lines.filter((l) => hasAny(l.m, ALARM_WORDS) || hasAny(l.m, RECOVER_WORDS))
      .map((l) => (hasAny(l.m, RECOVER_WORDS) ? 'R' : 'A'));
    check(seq.join('') === 'AR',
      `★경보 뒤에 반드시 복구가 온다 (실측 순서: ${seq.join('') || '없음'})`);
  }

  // ── ⑥ 폴백이 없으면 클라우드를 부르지 않는다 (10월 대비의 핵심)
  {
    const { c } = makeClient({ fallback: false });
    let cloudCalls = 0;
    c.cloud = { get: () => { cloudCalls++; return 25; } };   // 있어도 쓰면 안 된다
    c.devices.get('D').fallbackToCloud = false;
    await failThenRecover(c, 12);
    check(cloudCalls === 0,
      '★★fallbackToCloud=false 면 실패가 아무리 쌓여도 클라우드를 부르지 않는다');
  }

  // ── ⑦ ★리소스 부재 안내는 폴백을 꺼도 나온다
  //    v2.10.1까지 이 안내는 `if (canFallback)` 안에 갇혀 있었다 → 폴백을 끄면 **0줄**.
  //    리소스 부재는 연속 실패로도 안 세므로 `제어되지 않습니다` 경보도 안 걸린다.
  //    즉 홈킷에 그 값이 영영 비어 있는데 **이유를 알 방법이 아예 없었다**.
  //    천장형 에어컨의 온도 리소스 부재(§0-A16)가 정확히 이 경우다.
  {
    const notFound = () => { const e = new Error('없음'); e.notFound = true; throw e; };

    const off = makeClient({ fallback: false });
    for (let i = 0; i < 3; i++) {
      try {
        await off.c._withFallback('D', '실내온도', async () => notFound(), null, { kind: 'read' });
      } catch (_) { /* 폴백이 없으면 던진다 */ }
    }
    const offWarn = off.lines.filter((l) => l.lv === 'warn' && /리소스가 없/.test(l.m));
    check(offWarn.length === 1,
      `★★폴백이 꺼져 있어도 리소스 부재를 한 번 알린다 (실측 ${offWarn.length}줄)`);
    check(!/클라우드를 부릅니다/.test(offWarn[0]?.m || ''),
      '★폴백이 없는데 「클라우드를 부릅니다」라고 하지 않는다 (거짓말 금지)');
    check(/표시되지 않습니다/.test(offWarn[0]?.m || ''),
      '대신 그 값이 홈킷에 안 뜬다는 실제 결과를 말한다');
    check(!off.lines.some((l) => /제어되지 않습니다/.test(l.m)),
      '리소스 부재를 기기 사망으로 오인해 경보하지 않는다');

    const on = makeClient({ fallback: true });
    for (let i = 0; i < 3; i++) {
      await on.c._withFallback('D', '실내온도', async () => notFound(), () => 25, { kind: 'read' });
    }
    const onWarn = on.lines.filter((l) => l.lv === 'warn' && /리소스가 없/.test(l.m));
    check(onWarn.length === 1 && /클라우드를 부릅니다/.test(onWarn[0].m),
      '폴백이 켜져 있으면 예전처럼 「폴링마다 클라우드를 부릅니다」 (회귀 아님)');
  }

  // ── ⑧ ★★끊긴 동안의 '켜기'는 조용히 사라지지 않는다 (적대 리뷰 M6)
  //    켜기 생략(idempotency)의 전제는 "_state.power가 기기의 현재 상태와 같다"인데,
  //    그 값을 채우는 건 폴이다. 기기가 끊기면 폴이 통째로 실패해 값이 **얼어붙는다**.
  //    그 상태의 켜기 탭이 debug 한 줄만 남기고 사라지면서 홈킷엔 성공으로 보고됐다.
  {
    const SmartAC = require('../lib/accessories/SmartAC');

    const rig = (fresh) => {
      const sent = [];
      const C = {
        Active: { displayName: 'Active' },
        CurrentHeaterCoolerState: { displayName: 'CurrentState', INACTIVE: 0, IDLE: 1, COOLING: 2 },
        TargetHeaterCoolerState: { displayName: 'TargetState', COOL: 2 },
        CurrentTemperature: { displayName: 'CurrentTemp' },
        CoolingThresholdTemperature: { displayName: 'CoolingThreshold' },
        SwingMode: { displayName: 'SwingMode' },
        LockPhysicalControls: { displayName: 'Lock' },
        On: { displayName: 'On' },
      };
      const chars = new Map();
      const svc = {
        displayName: '놀이방 에어컨',
        getCharacteristic(c) {
          if (!chars.has(c)) {
            chars.set(c, {
              _set: null, removeAllListeners() {}, setProps() { return this; },
              on(ev, fn) { if (ev === 'set') this._set = fn; return this; },
            });
          }
          return chars.get(c);
        },
        testCharacteristic(c) { return chars.has(c); },
        removeCharacteristic() {},
        updateCharacteristic() {},
      };
      const o = Object.create(SmartAC.prototype);
      o.log = { info() {}, warn() {}, error() {}, debug() {} };
      o.api = { hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } };
      o.smartthings = {
        setPower: async (id, v) => { sent.push(v); },
        setMode: async () => {}, setTemperature: async () => {}, setAutoClean: async () => {},
        invalidateStatusCache() {},
      };
      o.platform = { config: {} };
      o.Service = { HeaterCooler: 'HC' };
      o.Characteristic = C;
      o._state = { power: true, currentTemp: 27, coolingSetpoint: 26, windFree: false, autoClean: false };
      o._stateFresh = fresh;
      o._resyncTimers = new Map(); o._stateSeq = new Map(); o._seedInFlight = {}; o._seeded = new Set();
      o._backgroundPollTimer = null; o._powerOnModeTimer = null; o._powerOnResendGen = 0;
      o._offIntentTs = 0; o._stopped = false;
      o._linkedSwitchServices = { windFree: null, autoClean: null };
      o._setupHeaterCooler(
        { context: { device: { deviceId: 'dev1' } }, displayName: svc.displayName, getService: () => svc, addService: () => svc },
        { coolModeCommand: 'cool' });
      return {
        sent,
        tapOn: () => new Promise((res) => svc.getCharacteristic(C.Active)._set(1, () => res())),
        stop() { for (const t of o._resyncTimers.values()) clearTimeout(t); if (o._powerOnModeTimer) clearTimeout(o._powerOnModeTimer); o._stopped = true; },
      };
    };

    const stale = rig(false);          // 폴이 실패 중 = 캐시가 낡음
    await stale.tapOn();
    check(stale.sent.length === 1,
      `★★폴이 실패 중이면 켜기를 생략하지 않고 실제로 보낸다 (실측 ${stale.sent.length}회 전송)`);
    stale.stop();

    const fresh = rig(true);           // 방금 폴이 성공 = 캐시가 신선함
    await fresh.tapOn();
    check(fresh.sent.length === 0,
      '★신선한 상태에서는 예전처럼 생략한다 (불필요한 왕복을 늘리지 않는다)');
    fresh.stop();
  }

  // ── ⑨ ★신원 불일치가 **재시작 전까지 영구 잠금**이 되지 않는다 (적대 리뷰 H2)
  //    불일치의 흔한 원인은 DHCP가 그 IP를 잠깐 다른 기기에 준 것이고, 곧 원래 기기가
  //    돌아온다. 예전엔 그때도 안 풀려서 폴백 없는 구성의 기기가 통째로 죽어 있었다.
  {
    const { c, lines } = makeClient({ fallback: false });
    let verifyCalls = 0;
    c._doVerify = async (id) => { verifyCalls += 1; c._verified.set(id, true); };

    // 불일치를 만들어 잠근다
    c._verified.set('D', false);
    c._verifyRetryAt.set('D', Date.now() + 10 * 60 * 1000);
    let blocked = false;
    try { await c._ensureIdentity('D'); } catch (_) { blocked = true; }
    check(blocked && verifyCalls === 0, '★불일치 직후에는 즉시 막는다 (완화가 아니다)');

    // 유효기간이 지나면 한 번 더 물어본다
    c._verifyRetryAt.set('D', Date.now() - 1);
    await c._ensureIdentity('D');
    check(verifyCalls === 1, '★★유효기간이 지나면 재시작 없이 다시 확인한다');
    check(lines.some((l) => l.lv === 'info' && /다시 확인/.test(l.m)), '다시 확인한다는 것을 알린다');

    // 확인에 성공했으면 더 묻지 않는다
    await c._ensureIdentity('D');
    check(verifyCalls === 1, '확인된 뒤에는 매번 다시 묻지 않는다 (트래픽을 늘리지 않는다)');
  }

  // ── ⑩ ★★재시작 구멍 — 경보가 걸린 채 재시작해도 복구 어휘가 나온다 (적대 리뷰 C-H1)
  //    `_fallbackStreak`·`_deadAnnounced`는 메모리 전용이다. 🔴 뒤에 사용자가 홈브릿지를
  //    재시작하고 기기가 그 뒤에 살아 돌아오면, 새 프로세스는 streak 0에서 시작해
  //    `로컬 복귀`가 **영영 안 나온다** — 감시기 🔴가 6시간마다 계속 울린다.
  //    실사용 중 가장 그럴듯한 순서다: 무응답 → 🔴 → "고치려고" 재시작 → 기기 복귀.
  {
    const { lines } = makeClient({ fallback: false });
    // 부팅 첫 접촉 성공선이 복구 어휘를 담는지 — 문구 계약으로 잰다.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'LocalApplianceClient.js'), 'utf8');
    const verify = src.slice(src.indexOf('async _doVerify('), src.indexOf('_scheduleDump(deviceId) {'));
    // ⚠️`_doVerify` 안에는 실패 문구(`로컬 기기 신원 불일치`)도 있다. 우리가 재려는 것은
    //   **성공했을 때 찍히는 줄**이므로 `log.info(` 안에 있는 것만 본다.
    const m = verify.match(/log\.info\(`\[\$\{this\._labelOf\(deviceId\)\}\] (로컬 기기 [^`$]*)/);
    check(!!m && RECOVER_WORDS.some((w) => m[1].includes(w)),
      `★★부팅 첫 접촉 성공선이 복구 어휘를 담는다 (실측 문구: ${m ? m[1].trim() : '없음'})`);
    check(!/if \(name\) this\.log\.info\(`\[\$\{this\._labelOf\(deviceId\)\}\] 로컬 기기/.test(verify),
      '★이름을 안 주는 기기에서도 찍힌다 (`if (name)` 게이트 없음)');
    check(lines.length === 0, '(전제) 등록만으로는 로그가 없다');
  }

  // ── ⑪ ★★항목별 연속 실패 — 부분 실패는 기기 단위 streak로 절대 안 잡힌다 (적대 리뷰 C-M2)
  //    폴 라운드의 **첫 성공이 streak를 0으로 되돌린다.** 전원은 되는데 온도만 계속
  //    타임아웃이면 0↔1로 진동해 임계 10에 영영 못 미친다. 실측상 하루 1,440라운드에
  //    보이는 줄 1 · 경보 0 — 홈킷 온도가 조용히 동결되는데 흔적이 없었다.
  {
    const { c, lines } = makeClient({ fallback: false });
    for (let i = 0; i < 12; i++) {
      // 전원은 성공, 온도만 실패 — 기기 단위 streak는 매 라운드 0으로 리셋된다
      await c._withFallback('D', '전원 조회', async () => true, null, { kind: 'read' });
      try {
        await c._withFallback('D', '실내온도 조회',
          async () => { throw new Error('로컬 요청 시간 초과'); }, null, { kind: 'read' });
      } catch (_) { /* 폴백 없음 */ }
    }
    const partial = lines.filter((l) => l.lv === 'warn' && /실내온도 조회만/.test(l.m));
    check(partial.length === 1,
      `★★한 항목만 계속 실패하면 알린다 (실측 ${partial.length}줄)`);
    check(!lines.some((l) => hasAny(l.m, ALARM_WORDS)),
      '★기기는 살아 있으므로 감시 경보 어휘는 쓰지 않는다 (🔴를 띄울 일이 아니다)');

    await c._withFallback('D', '실내온도 조회', async () => 27, null, { kind: 'read' });
    check(lines.some((l) => l.lv === 'info' && /실내온도 조회 다시 됩니다/.test(l.m)),
      '★다시 되면 그것도 알린다 (경고에 짝을 맞춘다)');
  }

  // ── ⑫ ★24시간 요약 — 조용한 구성에서 "그동안 무슨 일이 있었나"를 남기는 유일한 줄
  {
    const { c, lines } = makeClient({ fallback: false });
    for (let i = 0; i < 4; i++) await c._withFallback('D', '전원 조회', async () => true, null, { kind: 'read' });
    for (let i = 0; i < 2; i++) {
      try {
        await c._withFallback('D', '전원 조회',
          async () => { throw new Error('로컬 요청 시간 초과'); }, null, { kind: 'read' });
      } catch (_) { /* 폴백 없음 */ }
    }
    try {
      await c._withFallback('D', '전원 설정',
        async () => { throw new Error('로컬 요청 시간 초과'); }, null, { kind: 'write' });
    } catch (_) { /* 폴백 없음 */ }
    await c._withFallback('D', '전원 조회', async () => true, null, { kind: 'read' });

    const st = c._stats.get('D');
    check(st && st.ok === 5 && st.fail === 3 && st.cmdFail === 1 && st.cloud === 0,
      `★집계가 정확하다 (실측 ${JSON.stringify(st)})`);
    check(st.outages === 1, '★연속 실패 구간을 순단 1건으로 센다 (실패 횟수가 아니라 구간)');

    // 요약선을 직접 발화시켜 문구 계약을 본다
    lines.length = 0;
    clearTimeout(c._summaryTimer); c._summaryTimer = null;
    c._startDailySummary();
    const t = c._summaryTimer;
    clearTimeout(t); c._summaryTimer = null;
    c._stats.set('D', st);
    // 타이머 콜백과 같은 일을 하는 최소 재현(타이머를 24시간 기다릴 수 없다)
    c.log.info(`[${c._labelOf('D')}] 지난 24시간 로컬: 성공 ${st.ok}/${st.ok + st.fail}`
      + ` · 순단 ${st.outages}건 · 명령 실패 ${st.cmdFail}건 · 클라우드 호출 ${st.cloud}회`);
    const sum = lines.find((l) => /지난 24시간 로컬/.test(l.m));
    check(!!sum && !hasAny(sum.m, ALARM_WORDS),
      '★★요약선에 실패 어휘가 섞이지 않는다 (섞이면 매일 허위 경보가 된다)');
    check(!!sum && !hasAny(sum.m, RECOVER_WORDS),
      '★★복구 어휘도 섞이지 않는다 (섞이면 진짜 경보를 매일 잘못 풀어 준다)');
    check(/클라우드 호출 0회/.test(sum.m), '클라우드를 정말 0회 불렀는지 남긴다 (10월 대비의 핵심 지표)');
  }

  console.log(`\n[로컬 전용] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
