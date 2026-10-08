'use strict';
/**
 * dead_reannounce.js — 사망이 계속되는 동안 사망 어휘가 끊기지 않는다 (v2.16.2)
 *
 * 2026-10-02 정수기 실사고: 21:35 `제어되지 않습니다` 1줄 → 브릿지 재시작 6회(예산 소진) →
 * 그 뒤 4일간 하루 1줄 요약 말고는 **0줄**. NAS 감시기(hb_watch)는 사망 기록이 90분 넘게
 * 갱신되지 않으면 살았는지 죽었는지 가를 수 없어 판단을 보류한다 → 첫 알림 뒤 재알림 0건.
 *
 * ★여기서 재는 것은 "문구가 있는가"가 아니라 **간격**이다 — 며칠을 실제 폴러로 돌려
 *   사망 어휘 줄 사이의 최장 공백을 잰다. 감시기의 창(90분)보다 짧아야 한다.
 * ★대조군 포함 — 짧은 순단·폴백 켠 구성·복구 뒤에는 **한 줄도 안 나와야** 한다.
 *   (지속 줄은 그 자체가 감시 어휘라, 잘못 새면 가짜 경보가 된다.)
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const MqttBridge = require('../lib/mqtt/MqttBridge');
const { attachWaterPurifier } = require('../lib/mqtt/attach');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');
const { DEAD_REANNOUNCE_MS, stillDeadLine } = require('../lib/api/deadReannounce');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

// hb_watch 어휘(오프라인 회귀용 사본 — 정본 대조는 NAS `hb_watch/test/vocab_contract.py`)
const EXTRACT = ['폴링 실패', '상태 조회 실패', '상태 폴링 오류', '연결 실패', '폴링 중 오류', '상태 조회 오류',
  '사실상 클라우드로 동작 중', '제어되지 않습니다', '폴링 복구', '상태 조회 복구', '연결됨', '로컬 복귀',
  '수신 복귀', '기기 접속됨', '실시간 조회 복구', '사용량 조회 복구', '폴링 회복됨', '첫 폴링 성공',
  '기기 온라인 복귀', '기기 오프라인'];
const DEAD = '제어되지 않습니다';
const STILL = '아직 응답하지 않습니다';
const WATCH_WINDOW_MS = 90 * 60 * 1000;   // 감시기의 사망 기록 신선도 창
const MIN = 60 * 1000;

// 감시기의 추출을 흉내 낸다: `.*\[라벨\] .*(어휘).*` — 탐욕 매칭이라 **마지막** 어휘가 잡힌다.
const WATCH_RE = new RegExp(`^.*\\[([^\\]]+)\\] .*(${EXTRACT.join('|')}).*$`);
const watchSees = (line) => { const m = WATCH_RE.exec(line); return m ? { dev: m[1], ev: m[2] } : null; };

// ── 가짜 시계 ────────────────────────────────────────────────────────────────
const realNow = Date.now;
let NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
Date.now = () => NOW;
// 폴러가 다음 틱을 거는 긴 타이머만 삼킨다(틱은 시험이 직접 부른다). 짧은 타이머는 그대로 둔다.
const realST = global.setTimeout;
const swallowed = [];
global.setTimeout = (fn, ms, ...a) => {
  if (ms >= 3000) { swallowed.push({ fn, ms }); return { unref() {} }; }
  return realST(fn, ms, ...a);
};

function makeLog() {
  const lines = [];
  const rec = (lv) => (...a) => lines.push({ lv, m: a.join(' '), t: NOW });
  return { lines, log: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') } };
}

function makePurifier() {
  const { lines, log } = makeLog();
  const c = new LocalApplianceClient(log, { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'km81-dr-')) });
  c._ready = true;
  c.cloud = null;
  c.devices.set('WP', { host: '10.0.0.63', port: 49155, label: '정수기', fallbackToCloud: false });
  c._verified.set('WP', true);
  const state = { dead: true, kills: 0 };
  c._proc = { kill() { state.kills += 1; } };   // 브릿지 재시작이 실제로 발화하게 한다
  c._rpc = async () => {
    if (state.dead) { const e = new Error('로컬 요청 시간 초과'); e.sent = false; throw e; }
    return { code: 69, data: { 'x.com.samsung.da.status': 'Ready', 'x.com.samsung.da.filterUsage': '57',
      'x.com.samsung.da.filterStatus': 'normal' } };
  };
  const b = new MqttBridge(log, { enabled: true, host: 'x' });
  b._publish = () => {};
  b._client = {};
  const before = swallowed.length;
  attachWaterPurifier({ bridge: b, log, client: c, deviceId: 'WP',
    configDevice: { sensorPollInterval: 180 }, slug: 'water_purifier', label: '정수기', platform: null });
  const tick = swallowed[before].fn;
  return { c, lines, state, tick };
}

const deadLines = (lines) => lines.filter((l) => l.lv !== 'debug' && l.m.includes(DEAD));
function longestGap(ts, endAt) {
  let g = 0;
  for (let i = 1; i < ts.length; i++) g = Math.max(g, ts[i] - ts[i - 1]);
  if (ts.length) g = Math.max(g, endAt - ts[ts.length - 1]);
  return g;
}

(async () => {
  // ── ① 정수기가 4일 죽어 있다 (3분 폴 — 10/2 사고의 재현)
  {
    const { lines, state, tick } = makePurifier();
    const POLLS = 4 * 24 * 20;
    for (let i = 0; i < POLLS; i++) { NOW += 3 * MIN; await tick(); }
    const dl = deadLines(lines);
    const first = dl.filter((l) => l.lv === 'error');
    const still = dl.filter((l) => l.lv === 'warn' && l.m.includes(STILL));
    const restarts = lines.filter((l) => /로컬 브릿지를 다시 시작합니다/.test(l.m));
    check(first.length === 1, `첫 경보(error)는 한 번뿐이다 (실측 ${first.length})`);
    check(restarts.length === 6 && state.kills === 6, `브릿지 재시작 예산은 그대로 6회다 (실측 ${restarts.length})`);
    const lastRestartAt = restarts.length ? restarts[restarts.length - 1].t : 0;
    const afterBudget = still.filter((l) => l.t > lastRestartAt).length;
    check(afterBudget >= 80, `★재시작 예산을 다 쓴 뒤에도 지속 줄이 계속 나온다 (실측 ${afterBudget}줄 — 옛 코드는 0)`);
    const gap = longestGap(dl.map((l) => l.t), NOW);
    check(gap < WATCH_WINDOW_MS, `★사망 어휘의 최장 공백이 감시 창(90분)보다 짧다 (실측 ${Math.round(gap / MIN)}분)`);
    const loud = lines.filter((l) => l.lv !== 'debug').length;
    check(loud / 4 <= 30, `하루 로그량이 30줄을 넘지 않는다 (실측 하루 ${Math.round(loud / 4)}줄)`);

    // 문구 계약 — 감시기가 이 줄에서 무엇을 집는가
    const seen = still.map((l) => watchSees(l.m));
    check(seen.length > 0 && seen.every((s) => s && s.dev === '정수기' && s.ev === DEAD),
      `★감시기가 지속 줄에서 「정수기 · ${DEAD}」를 집는다 (실측 ${JSON.stringify(seen[0])})`);
    check(still.every((l) => EXTRACT.filter((v) => l.m.includes(v)).length === 1),
      '지속 줄에 다른 감시 어휘가 섞이지 않는다');
    check(still.length > 0 && /연속 실패 \d+회 · \d+분째/.test(still[still.length - 1].m),'지속 줄에 연속 실패 횟수와 경과 시간이 실린다');

    // 복구 → 조용해진다 → 다시 죽으면 새 사건으로 처음부터
    state.dead = false;
    NOW += 3 * MIN; await tick();
    check(lines.filter((l) => l.lv === 'info' && /로컬 복귀/.test(l.m)).length === 1, '복구는 한 번 알린다');
    const n0 = deadLines(lines).length;
    for (let i = 0; i < 60; i++) { NOW += 3 * MIN; await tick(); }
    check(deadLines(lines).length === n0, '★복구 뒤에는 지속 줄이 한 줄도 안 나온다 (3시간)');
    state.dead = true;
    for (let i = 0; i < 9; i++) { NOW += 3 * MIN; await tick(); }
    check(deadLines(lines).length === n0, '다시 죽어도 9회까지는 조용하다 (옛 시각으로 지속 줄이 새지 않는다)');
    NOW += 3 * MIN; await tick();
    const dl2 = deadLines(lines);
    check(dl2.length === n0 + 1 && dl2[dl2.length - 1].lv === 'error', '10회째에 새 경보(error)로 다시 시작한다');
  }

  // ── ② 대조군: 경보에 못 미친 긴 순단 (폴 10분 × 9회 = 90분)
  {
    const { lines, tick } = makePurifier();
    for (let i = 0; i < 9; i++) { NOW += 10 * MIN; await tick(); }
    check(deadLines(lines).length === 0, '★경보를 안 냈으면 시간이 지나도 지속 줄을 내지 않는다');
  }

  // ── ③ 홈킷 기기 경로(`_withFallback`) — 폴백 끔: 20초마다 실패, 5시간
  const runFallback = async (fallback, hours) => {
    const { lines, log } = makeLog();
    const c = new LocalApplianceClient(log, { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'km81-dr-')) });
    c._ready = true;
    c.cloud = fallback ? { get: () => 25 } : null;
    c.devices.set('D', { host: '192.168.0.9', port: 49154, fallbackToCloud: fallback, label: '놀이방 에어컨' });
    const once = async (ok) => {
      try {
        await c._withFallback('D', '상태 조회',
          ok ? async () => 25 : async () => { throw new Error('로컬 요청 시간 초과'); },
          c.cloud ? () => c.cloud.get() : null, { kind: 'read' });
      } catch (_) { /* 폴백이 없으면 던진다 */ }
    };
    for (let i = 0; i < hours * 180; i++) { NOW += 20 * 1000; await once(false); }
    return { lines, once };
  };
  {
    const { lines, once } = await runFallback(false, 5);
    const dl = deadLines(lines);
    const still = dl.filter((l) => l.m.includes(STILL));
    check(dl.filter((l) => l.lv === 'error').length === 1, '폴백 끔: 첫 경보는 한 번');
    check(still.length >= 4 && still.length <= 5, `★폴백 끔: 지속 줄이 한 시간에 한 줄 (5시간에 ${still.length}줄)`);
    check(longestGap(dl.map((l) => l.t), NOW) < WATCH_WINDOW_MS, '폴백 끔: 최장 공백이 감시 창보다 짧다');
    const seen = still.map((l) => watchSees(l.m));
    check(seen.every((s) => s && s.dev === '놀이방 에어컨' && s.ev === DEAD), '폴백 끔: 감시기가 같은 어휘를 집는다');
    NOW += 20 * 1000; await once(true);
    const n0 = deadLines(lines).length;
    for (let i = 0; i < 9; i++) { NOW += 20 * 1000; await once(false); }
    NOW += 2 * DEAD_REANNOUNCE_MS; await once(false);   // 10회째 = 새 경보여야 한다
    const dl2 = deadLines(lines);
    check(dl2.length === n0 + 1 && dl2[dl2.length - 1].lv === 'error',
      '복구 뒤 다시 죽으면 지속 줄이 아니라 새 경보로 시작한다');
  }
  // ── ④ 대조군: 폴백 켬 — 기기는 클라우드로 제어된다. 지속 줄은 없다.
  {
    const { lines } = await runFallback(true, 5);
    check(lines.filter((l) => l.m.includes(STILL)).length === 0, '★폴백 켬: 지속 줄을 내지 않는다');
    check(lines.filter((l) => l.m.includes(DEAD)).length === 0, '폴백 켬: 「제어되지 않습니다」를 말하지 않는다');
  }

  // ── ⑤ 주기와 문구의 정본은 한 곳이다
  {
    check(DEAD_REANNOUNCE_MS <= 60 * MIN && DEAD_REANNOUNCE_MS + 15 * MIN < WATCH_WINDOW_MS,
      '주기 + 감시 주기 한 번(15분)이 감시 창(90분) 안에 든다');
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    check(/stillDeadLine\(/.test(src('lib/mqtt/attach.js')) && /stillDeadLine\(/.test(src('lib/api/LocalApplianceClient.js')),
      '두 경로(정수기 폴러·홈킷 기기)가 같은 문구 함수를 쓴다');
    check(!stillDeadLine('a', 11, 0).includes('분째'), '시작 시각을 모르면 경과 시간을 지어내지 않는다');
  }

  Date.now = realNow;
  global.setTimeout = realST;
  console.log(fails.length === 0 ? `ALL PASS (${pass})` : `${fails.length} FAILURES\n - ${fails.join('\n - ')}`);
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
