'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 로그 볼륨 계측기 (v2.4.5 재감사용)
//
// ★왜 만들었나
//   2026-07-29 적대 리뷰 6에이전트가 "세탁기 로그가 몇 분마다 반복된다"는 것을 못 잡았다.
//   소스만 읽으면 억제 로직이 **있다**는 건 보이지만, 그래서 **하루에 몇 줄이 나오는지**는
//   안 보이기 때문이다. (나 역시 90초만 관측하고 '조용하다'고 잘못 결론냈다 — 억제 주기가
//   10회째마다라 실제 주기는 ~3.5분이었다.)
//
//   이 파일은 실제 코드 경로를 **시간을 압축해** 돌려서 "24시간에 사용자에게 보이는 줄 수"를
//   숫자로 뽑는다. 앞으로 로그 관련 판단은 감(感)이 아니라 이 숫자로 한다.
//
// 사용: node test/log_volume.js          (표만)
//       node test/log_volume.js -v       (실제 문구까지)
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('assert');
const { LegacyACClient } = require('../lib/api/LegacyACClient');
const LegacyLaundryClient = require('../lib/api/LegacyLaundryClient');

const VERBOSE = process.argv.includes('-v');

// ── 수집 로거 ────────────────────────────────────────────────────────────────
function mkLog() {
  const lines = [];
  const push = (lv) => (m) => lines.push([lv, String(m)]);
  return {
    lines,
    info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'),
    // 사용자 눈에 보이는 것만 (홈브릿지 기본은 debug 미표시)
    visible: () => lines.filter(([lv]) => lv !== 'debug'),
  };
}

// ── 8888 전송 모킹: _rawRequest만 갈아끼워 그 위 로직은 전부 진짜를 쓴다 ────────
const CERT = require('path').join(__dirname, '..', 'cert', 'cert.pem');
let ipSeq = 0;
function mkLaundry(log, respond, opts = {}) {
  const ip = `10.0.0.${++ipSeq}`;               // getShared 캐시 오염 방지
  const c = new LegacyLaundryClient(log, {
    ip, token: 'x'.repeat(10), timeout: 10, certPath: CERT, ...opts,
  });
  c.transport._rawRequest = async () => respond();
  return c;
}

const ERR = (m) => () => { throw new Error(m); };
const UNREACH = ERR('TLS 소켓 오류: connect EHOSTUNREACH 10.0.0.1:8888');
const dev = (o) => ({ Devices: [{ Operation: o }] });

// 재시도 대기(1s·2s)를 즉시 실행으로 — 시간 압축.
// ★타이머 페이즈(setTimeout 0)조차 폴당 ~30ms가 붙어 하루치(8640폴)가 4분 넘게 걸린다.
//   마이크로태스크로 바꾸면 같은 코드 경로를 그대로 밟으면서 수 초로 끝난다.
const _sleep = global.setTimeout;
const _clear = global.clearTimeout;
function fastTimers(on) {
  if (on) {
    global.setTimeout = (fn) => { Promise.resolve().then(fn); return { unref() {}, ref() {} }; };
    global.clearTimeout = () => {};
  } else {
    global.setTimeout = _sleep;
    global.clearTimeout = _clear;
  }
}

// ── 시나리오 ────────────────────────────────────────────────────────────────
const SCENARIOS = [];
const scenario = (name, polls, hours, fn) => SCENARIOS.push({ name, polls, hours, fn });

scenario('세탁기 — 하루 종일 전원 꺼짐 (가장 흔한 상태)', 8640, 24, async (log) => {
  const c = mkLaundry(log, UNREACH);
  for (let i = 0; i < 8640; i++) await c.getStatus().catch(() => {});
});

scenario('세탁기 — 운전 중 순단 3회 (거짓 종료 알림 방지 구간)', 60, 0.17, async (log) => {
  let mode = 'run';
  const c = mkLaundry(log, () => {
    if (mode === 'down') return UNREACH();
    return dev({ state: 'Run', power: 'On', progress: 'Wash', remainingTime: '00:40:00' });
  });
  for (let i = 0; i < 60; i++) {
    mode = (i >= 20 && i < 23) ? 'down' : 'run';   // 3폴만 끊김
    await c.getStatus().catch(() => {});
  }
});

scenario('세탁기 — 1사이클 (꺼짐→켬→운전→종료→끔)', 380, 1.05, async (log) => {
  let phase = 'off';
  const c = mkLaundry(log, () => {
    if (phase === 'off') return UNREACH();
    if (phase === 'ready') return dev({ state: 'Ready', power: 'On', progress: 'None' });
    if (phase === 'run') return dev({ state: 'Run', power: 'On', progress: 'Wash', remainingTime: '00:40:00' });
    return dev({ state: 'Ready', power: 'On', progress: 'Finish' });
  });
  const seq = [['off', 30], ['ready', 20], ['run', 240], ['fin', 30], ['off', 60]];
  for (const [p, n] of seq) { phase = p; for (let i = 0; i < n; i++) await c.getStatus().catch(() => {}); }
});

scenario('세탁기 — 토큰 무효(진짜 장애). 폴백 없음', 360, 1, async (log) => {
  const c = mkLaundry(log, ERR('인증 실패 (status 401)'), { fallbackToCloud: false });
  for (let i = 0; i < 360; i++) await c.getStatus().catch(() => {});
});

scenario('구형 에어컨 — 30분 무응답 (여기는 경보가 나와야 정상)', 180, 0.5, async (log) => {
  const t = LegacyACClient.getShared(`10.9.9.${++ipSeq}`, 'x'.repeat(10), log, { timeout: 10 });
  t._rawRequest = UNREACH;
  for (let i = 0; i < 180; i++) await t.getDeviceStatus().catch(() => {});
});

// ─── 액세서리 계층까지 포함한 전 계층 시나리오 ──────────────────────────────────
//
// ★v2.4.5 감사가 잡아낸 이 계측기 자신의 결함: 위 시나리오들은 `client.getStatus()`를
//   직접 부르므로 **Laundry 액세서리가 그 예외를 어떻게 로그하는지**를 못 본다.
//   실제로 "운전 중 순단 = 0줄"은 클라이언트 계층에서만 참이었고, 액세서리 계층이
//   `상태 폴링 오류` warn을 찍고 있었다(그리고 그 문구는 hb-watch 경보에 걸린다).
//   아래는 진짜 배선(Laundry ← LegacyLaundryClient ← 전송)으로 폴을 돌린다.
const Laundry = require('../lib/accessories/Laundry');
const { installFakeTimers, mkHarness } = require('./_hap_stub');

const FULL = [];
const fullScenario = (name, polls, hours, build) => FULL.push({ name, polls, hours, build });

/** Laundry를 진짜 클라이언트에 물려 polls회 폴을 돌리고 로그를 돌려준다. */
async function runStack({ configDevice, respond, polls }) {
  const timers = installFakeTimers();
  const log = mkLog();
  const h = mkHarness();
  const acc = h.mkAccessory('세탁기', 'uuid:main');
  acc.context.device = { deviceId: 'W1', label: '세탁기' };
  h.platform.accessories.push(acc);

  const ip = `10.7.0.${++ipSeq}`;
  const client = new LegacyLaundryClient(log, { ip, token: 'x'.repeat(10), timeout: 10, certPath: CERT });
  let n = 0;
  client.transport._rawRequest = async () => { n++; return respond(n); };

  const l = new Laundry({
    log, api: h.api, platform: h.platform, deviceKind: 'washer', smartthings: client,
  });
  l.configure(acc, configDevice, '9.9.9');

  for (let i = 0; i < polls; i++) { client.transport._statusCache = null; await timers.tick(); }
  timers.restore();
  return log;
}

fullScenario('★전계층 — 세탁기 하루 종일 꺼짐 (합침)', 300, 24,
  () => ({ configDevice: { enableNotificationSensor: true, sensorPollInterval: 10 }, respond: UNREACH }));

fullScenario('★전계층 — 운전 중 3폴 순단 (hb-watch 오탐 검사)', 40, 0.11,
  () => ({
    configDevice: { enableNotificationSensor: true, sensorPollInterval: 10 },
    respond: (n) => ((n > 10 && n <= 13) ? UNREACH()
      : dev({ state: 'Run', power: 'On', progress: 'Wash', remainingTime: '00:40:00' })),
  }));

fullScenario('★전계층 — 세탁조 분리 + 꺼짐 (보조 구획 warn 폭탄 검사)', 300, 24,
  () => ({
    configDevice: { enableNotificationSensor: true, sensorPollInterval: 10, splitCompartments: true },
    // 처음엔 두 조가 보이다가(대기) 전원이 꺼진다.
    respond: (n) => (n <= 2
      ? { Devices: [{ Operation: { state: 'Ready', power: 'On', progress: 'None' } },
        { Operation: { state: 'Ready', power: 'On', progress: 'None' } }] }
      : UNREACH()),
  }));

// ── 실행 ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('로그 볼륨 계측 — 실제 코드 경로, 시간 압축\n');
  fastTimers(true);
  const rows = [];
  for (const s of SCENARIOS) {
    const log = mkLog();
    await s.fn(log);
    const vis = log.visible();
    const by = { info: 0, warn: 0, error: 0 };
    vis.forEach(([lv]) => { by[lv] = (by[lv] || 0) + 1; });
    const uniq = new Map();
    vis.forEach(([lv, m]) => {
      const k = m.replace(/\d+/g, '#');
      uniq.set(k, (uniq.get(k) || 0) + 1);
    });
    rows.push({
      name: s.name, polls: s.polls, hours: s.hours,
      visible: vis.length, debug: log.lines.length - vis.length, by, uniq,
      perDay: s.hours ? (vis.length / s.hours) * 24 : vis.length,
    });
  }
  fastTimers(false);

  // 전 계층 시나리오 (자체 가짜 타이머를 쓰므로 fastTimers 밖에서 돌린다)
  for (const s of FULL) {
    const log = await runStack({ ...s.build(), polls: s.polls });
    const vis = log.visible();
    const by = { info: 0, warn: 0, error: 0 };
    vis.forEach(([lv]) => { by[lv] = (by[lv] || 0) + 1; });
    const uniq = new Map();
    vis.forEach(([, m]) => {
      const k = m.replace(/\d+/g, '#');
      uniq.set(k, (uniq.get(k) || 0) + 1);
    });
    rows.push({
      name: s.name, polls: s.polls, hours: s.hours,
      visible: vis.length, debug: log.lines.length - vis.length, by, uniq,
      perDay: s.hours ? (vis.length / s.hours) * 24 : vis.length,
    });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);
  console.log(pad('시나리오', 48), rpad('폴', 6), rpad('보임', 6), rpad('debug', 7), rpad('환산/일', 9));
  console.log('─'.repeat(80));
  for (const r of rows) {
    console.log(pad(r.name, 48), rpad(r.polls, 6), rpad(r.visible, 6), rpad(r.debug, 7),
      rpad(Math.round(r.perDay), 9));
  }

  console.log('\n※ "보임" = 홈브릿지 기본 로그레벨에서 사용자가 보는 줄 수 (info+warn+error)');

  for (const r of rows) {
    console.log(`\n■ ${r.name}`);
    if (!r.uniq.size) { console.log('   (사용자 로그 없음)'); continue; }
    for (const [k, n] of [...r.uniq].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${rpad(n, 5)}회  ${k.slice(0, 90)}`);
    }
  }

  if (VERBOSE) {
    console.log('\n=== 전체 문구 ===');
    // 재실행 없이 보여주려면 저장이 필요 — 요약으로 충분하므로 생략 안내
    console.log('(요약의 "회" 컬럼이 반복 횟수입니다. 숫자는 #로 접었습니다.)');
  }

  // ── 회귀 방지 계약 ────────────────────────────────────────────────────────
  console.log('\n=== 계약 검사 ===');
  const fail = [];
  const check = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) fail.push(msg); };

  const off = rows[0];
  check(off.visible <= 2, `꺼진 세탁기 하루치 사용자 로그 ≤2줄 (실측 ${off.visible}줄)`);
  const brief = rows[1];
  check(brief.visible === 0, `운전 중 3폴 순단은 사용자 로그 0줄 (실측 ${brief.visible}줄)`);
  const cyc = rows[2];
  check(cyc.visible <= 4, `1사이클 사용자 로그 ≤4줄 (실측 ${cyc.visible}줄)`);
  const auth = rows[3];
  check(auth.by.error === 1, `토큰 무효는 error 1줄로 래치 (실측 ${auth.by.error}줄)`);
  const ac = rows[4];
  check(ac.visible > 5, `구형 에어컨 무응답은 계속 경보해야 한다 (실측 ${ac.visible}줄)`);
  check(ac.visible < 40, `단 30분에 40줄 미만으로 억제 (실측 ${ac.visible}줄)`);

  // ★전 계층 계약 — 클라이언트만 재던 시절엔 아래 항목들이 계측 자체가 불가능했다.
  console.log('\n=== 전 계층 계약 (액세서리 포함) ===');
  // NAS hb-watch 감시기가 텔레그램 경보를 내는 문구. 정상 동작에서 나오면 오탐이다.
  // ★★2026-08-03 — 정본(`/volume1/.Script/hb_watch/hb_watch.sh`)에서 **추출해 대조**한 9종으로
  //   교체했다(적대 리뷰 C-M3). 예전 목록은 `무응답`·`최종 요청 실패`를 **잘못 포함**하고
  //   `폴링 중 오류`·`상태 조회 오류`·`사실상 클라우드로 동작 중`·`제어되지 않습니다`·
  //   `기기 오프라인`을 **누락**해, 이 계측기와 `local_only.js`의 사본이 서로 달랐다.
  //   ⚠️어휘를 손으로 늘리지 말 것 — 바꿔야 하면 정본에서 다시 추출해 맞춘다(로그스타일 §9 규칙 5).
  const ALARM = /폴링 실패|상태 조회 실패|상태 폴링 오류|연결 실패|폴링 중 오류|상태 조회 오류|사실상 클라우드로 동작 중|제어되지 않습니다|기기 오프라인/;
  const alarmsIn = (r) => [...r.uniq.entries()].filter(([m]) => ALARM.test(m));

  const fOff = rows[5];
  // ★임계 3→4 (2026-08-05): 부팅 첫 폴 성공에 `기기 접속됨` 접촉선 **1줄**을 추가했다.
  //   왜 늘렸나 — 실패 스트릭은 메모리에만 있어서, 🔴가 걸린 뒤 홈브릿지가 재시작되면
  //   복구 문구가 영영 안 나오고 감시기 경보가 6시간마다 계속 울린다(재시작 구멍).
  //   DTLS 경로에서 이미 같은 결정을 했고(`로컬 기기 접속됨`), 그 미전파를 메운 것이다.
  //   ⚠️임계를 올릴 땐 반드시 이유를 남긴다 — 근거 없이 올리면 다음번 진짜 폭주를 놓친다.
  check(fOff.visible <= 4, `[전계층] 꺼진 세탁기 하루 사용자 로그 ≤4줄 (실측 ${fOff.visible}줄)`);
  // ★2026-07-30 실측에서 배운 것: "하루 1줄"은 **재시작이 없을 때**의 값이다.
  //   재시작하면 꺼짐 래치(`_offlineNotified`)가 초기화되므로 새 프로세스가 1줄을 다시 낸다.
  //   그날 배포로 4번 재시작했더니 총 5줄(사이클 종료 1 + 재시작 4)이 나왔고, 순간
  //   "억제가 뚫렸나" 하고 놀랐다 — 계약이 이 사실을 안 적어 둬서 생긴 혼란이다.
  //   재시작 1회당 정확히 1줄인지(2줄이면 억제가 깨진 것) 여기서 고정한다.
  {
    const perBoot = [];
    for (let boot = 0; boot < 3; boot++) {
      const log = await runStack({
        configDevice: { enableNotificationSensor: true, sensorPollInterval: 10 },
        respond: UNREACH, polls: 40,
      });
      perBoot.push(log.visible().filter(([, m]) => /전원 꺼짐/.test(m)).length);
    }
    check(perBoot.every((n) => n === 1),
      `[전계층] 재시작 1회당 '전원 꺼짐' 정확히 1줄 (부팅 3회 실측 ${perBoot.join(',')})`);
  }
  check(alarmsIn(fOff).length === 0, `[전계층] 꺼진 세탁기에서 hb-watch 경보 문구 0건 (실측 ${alarmsIn(fOff).length}건)`);

  const fBrief = rows[6];
  check(alarmsIn(fBrief).length === 0,
    `[전계층] 운전 중 순단에서 hb-watch 경보 문구 0건 (실측 ${alarmsIn(fBrief).length}건`
    + (alarmsIn(fBrief).length ? `: ${alarmsIn(fBrief)[0][0].slice(0, 60)}` : '') + ')');

  const fSplit = rows[7];
  check(fSplit.visible <= 6, `[전계층] 세탁조 분리 + 꺼짐 하루 사용자 로그 ≤6줄 (실측 ${fSplit.visible}줄)`);   // 위와 같은 이유(+1줄)
  check(alarmsIn(fSplit).length === 0, `[전계층] 분리 모드 꺼짐에서 경보 문구 0건 (실측 ${alarmsIn(fSplit).length}건)`);

  console.log(fail.length ? `\n❌ ${fail.length}건 실패` : '\n✅ 전부 통과');
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
