'use strict';

/**
 * 바람방향 — 스윙 토글에 묶어 쓰기 (v2.9.0).
 *
 * 왜: 구형 에어컨은 스윙 토글을 **무풍 / 상하 바람** 중에서 고를 수 있는데
 * 신형·시스템만 무풍뿐이었다. 실사용자 천장형이 `/wind/direction/vs/0`을
 * `["Up_And_Low","Fix","Left_And_Right","All"]`로 지원한다고 스스로 보고했다.
 *
 * ⚠️SmartThings 클라우드에는 대응 기능이 없다 — 로컬 전용이며, 폴백이 조용히
 *   성공한 척하면 토글이 거짓말을 한다.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

const SUPPORTED = ['Up_And_Low', 'Fix', 'Left_And_Right', 'All'];

function makeClient(current = 'Fix') {
  const lines = [];
  const rec = (lv) => (m) => lines.push(`${lv}|${m}`);
  const log = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  const c = new LocalApplianceClient(log, { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'km81-wd-')) });
  c._ready = true;
  c.cloud = null;
  const DEV = 'aaaaaaaa-1111-2222-3333-444444444444';
  c.devices.set(DEV, { host: '192.168.0.205', port: 49154, fallbackToCloud: false, label: '놀이방 에어컨' });
  const sent = [];
  let state = current;
  const coap = (a, b) => (a << 5) | b;
  c._proc = { stdin: { write: (line) => {
    const req = JSON.parse(line);
    const p = (req.path || []).join('/');
    setImmediate(() => {
      if (p === 'oic/d') return c._onMessage({ id: req.id, ok: true, code: coap(2, 5), data: { di: DEV }, port: 49154 });
      if (p === 'wind/direction/vs/0') {
        if (req.op === 'post') {
          sent.push(req.payload['x.com.samsung.da.modes']);
          state = req.payload['x.com.samsung.da.modes'];
          return c._onMessage({ id: req.id, ok: true, code: coap(2, 4), port: 49154 });
        }
        return c._onMessage({
          id: req.id, ok: true, code: coap(2, 5), port: 49154,
          data: { 'x.com.samsung.da.modes': state, 'x.com.samsung.da.supportedModes': SUPPORTED },
        });
      }
      return c._onMessage({ id: req.id, ok: false, code: coap(4, 4), error: 'CoAP 4.04 응답' });
    });
  } } };
  return { c, DEV, lines, sent, cur: () => state };
}

(async () => {
  // ── ① 읽기
  {
    const { c, DEV } = makeClient('Up_And_Low');
    check(await c.getWindDirection(DEV) === 'Up_And_Low', '기기가 보고한 바람방향을 읽는다');
    const sup = await c.getSupportedWindDirections(DEV);
    check(JSON.stringify(sup) === JSON.stringify(SUPPORTED), '지원 목록을 읽는다');
  }

  // ── ② 쓰기 — 켜면 고른 방향, 끄면 항상 고정
  {
    const { c, DEV, sent } = makeClient('Fix');
    await c.setWindDirection(DEV, 'Up_And_Low');
    await c.setWindDirection(DEV, 'Fix');
    check(sent.length === 2 && sent[0] === 'Up_And_Low' && sent[1] === 'Fix',
      '고른 방향과 고정(Fix)을 그대로 보낸다');
  }

  // ── ③ ★클라우드로는 조용히 성공한 척하지 않는다
  {
    const { c, DEV } = makeClient('Fix');
    c.cloud = { anything: () => true };
    c.devices.get(DEV).fallbackToCloud = true;
    // 로컬을 실패시킨다 (기기가 그 리소스를 갖고 있지 않은 경우)
    c._proc = { stdin: { write: (line) => {
      const req = JSON.parse(line);
      setImmediate(() => {
        if ((req.path || []).join('/') === 'oic/d') {
          return c._onMessage({ id: req.id, ok: true, code: 69, data: { di: DEV }, port: 49154 });
        }
        return c._onMessage({ id: req.id, ok: false, code: 132, error: 'CoAP 4.04 응답' });
      });
    } } };
    let err = null;
    try { await c.setWindDirection(DEV, 'All'); } catch (e) { err = e; }
    check(err !== null, '★실패를 삼키지 않는다 (삼키면 홈킷 토글이 거짓말을 한다)');
    check(/클라우드로 제어할 수 없습니다/.test(err?.message || ''),
      '왜 안 되는지 알려 준다 (클라우드 미지원)');
  }

  // ── ④ 값이 비면 던진다
  {
    const { c, DEV } = makeClient('');
    let threw = false;
    try { await c.getWindDirection(DEV); } catch (_) { threw = true; }
    check(threw, '값이 비면 던진다 (조용히 Fix로 지어내지 않는다)');
  }

  // ── ⑤ 지원 목록 조회는 실패해도 던지지 않는다 (경고 판정용 보조 조회)
  {
    const { c, DEV } = makeClient('Fix');
    c._proc = { stdin: { write: (line) => {
      const req = JSON.parse(line);
      setImmediate(() => c._onMessage({ id: req.id, ok: false, code: 132, error: 'CoAP 4.04 응답' }));
    } } };
    let threw = false;
    let out = null;
    try { out = await c.getSupportedWindDirections(DEV); } catch (_) { threw = true; }
    check(!threw && Array.isArray(out) && out.length === 0,
      '지원 목록을 못 읽으면 빈 배열 (이것 때문에 제어가 막히면 안 된다)');
  }

  // ── ⑥ 설정 화면 계약 — 종류마다 목록이 다르다
  {
    const SmartAC = require("../lib/accessories/SmartAC");
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.schema.json"), "utf8"));
    const props = schema.schema.properties.devices.items.properties;
    const titles = (k) => (props[k].oneOf || []).map((o) => o.title);
    const values = (k) => (props[k].oneOf || []).map((o) => o.enum[0]);

    check(props.swingWindDirection === undefined, "★두 번째 드롭다운은 없다");

    check(JSON.stringify(titles("legacySwingBinding")) === JSON.stringify(["무풍", "회전", "사용 안 함"]),
      `구형: 무풍/회전/사용 안 함 (현재 ${titles("legacySwingBinding").join("/")})`);
    check(JSON.stringify(titles("swingBinding")) === JSON.stringify(["무풍", "회전", "사용 안 함"]),
      `신형: 무풍/회전/사용 안 함 (현재 ${titles("swingBinding").join("/")})`);
    check(JSON.stringify(titles("systemSwingBinding")) === JSON.stringify(["무풍", "상하좌우", "상하 바람", "좌우 바람", "사용 안 함"]),
      `시스템: 무풍/상하좌우/상하 바람/좌우 바람/사용 안 함 (현재 ${titles("systemSwingBinding").join("/")})`);

    check(!values("swingBinding").includes("Up_And_Low"),
      "★신형 목록에는 방향을 직접 넣지 않는다 (회전이 대신 고른다)");
    check(!values("systemSwingBinding").includes("rotate"),
      "★시스템 목록에는 회전이 없다 (방향을 직접 고른다)");

    const sysDirs = values("systemSwingBinding").filter((v) => v !== "windFree" && v !== "none");
    check(sysDirs.every((d) => SUPPORTED.includes(d) && d !== "Fix"),
      "시스템의 방향 값이 전부 기기 규격 안의 값이다 (고정 제외)");
    check(sysDirs.concat(["rotate"]).sort().join() === SmartAC.SWING_DIRECTIONS.slice().sort().join(),
      "★스키마 선택지와 코드 상수가 일치한다 (어긋나면 고른 값이 조용히 무시된다)");
    check(SmartAC.ROTATE_PREFERENCE.every((m) => SUPPORTED.includes(m) && m !== "Fix"),
      "회전 우선순위가 전부 유효한 방향이다");
  }

  // ── ⑦ ★기기가 지원하지 않는 방향을 조용히 보내지 않는다
  //   실측(2026-08-01): 우리 창문형은 ["Fix","Left_And_Right"]만 지원한다 — 기본값
  //   `Up_And_Low`가 **없다.** 천장형은 4종 전부 지원. 즉 이 경로는 실제로 발화한다.
  {
    const SmartAC = require('../lib/accessories/SmartAC');
    const C = { SwingMode: 'SwingMode' };
    const mk = (supported) => {
      const lines = [];
      const sent = [];
      const o = Object.create(SmartAC.prototype);
      o.Characteristic = C;
      o.log = { warn: (m) => lines.push(`warn|${m}`), debug: () => {}, info: () => {} };
      o._label = '승준 에어컨';
      o._state = {};
      o._offIntentTs = 0;
      o._mainService = { testCharacteristic: () => true, updateCharacteristic: () => {} };
      o.smartthings = {
        getSupportedWindDirections: async () => supported,
        setWindDirection: async (_id, m) => { sent.push(m); },
        getWindDirection: async () => 'Fix',
      };
      return { o, lines, sent };
    };

    const a = mk(['Fix', 'Left_And_Right']);
    await a.o._setWindDirection('D', 'Up_And_Low');
    check(a.sent.length === 0, '★지원하지 않는 방향은 기기로 보내지 않는다');
    check(a.lines.some((l) => /지원하지 않습니다/.test(l)), '왜 안 되는지 알린다');
    check(a.lines.some((l) => /Fix, Left_And_Right/.test(l)), '★지원 목록을 함께 보여 준다');
    check(a.lines.some((l) => /승준 에어컨/.test(l)), '어느 기기인지 밝힌다');

    // 같은 경고를 폴마다 반복하지 않는다
    const before = a.lines.length;
    await a.o._setWindDirection('D', 'Up_And_Low');
    check(a.lines.length === before, '그 경고는 한 번만 낸다');

    // 대조군 — 지원하는 값은 그대로 나간다
    const b = mk(['Fix', 'Left_And_Right']);
    await b.o._setWindDirection('D', 'Left_And_Right');
    check(b.sent.length === 1 && b.sent[0] === 'Left_And_Right', '지원하는 방향은 그대로 보낸다');

    // 끄기(Fix)는 지원 여부를 묻지 않고 항상 보낼 수 있어야 한다
    const c2 = mk([]);
    await c2.o._setWindDirection('D', 'Fix');
    check(c2.sent.length === 1 && c2.sent[0] === 'Fix',
      '★끄기(고정)는 지원 목록을 못 읽어도 보낸다 (끄기를 막으면 안 된다)');
  }

  // ── ⑧ ★`회전` — 기기가 지원하는 방향을 스스로 고른다
  //   기기마다 다르기 때문이다(실측: 승준 에어컨은 좌우만, 천장형은 네 방향 전부).
  {
    const SmartAC = require('../lib/accessories/SmartAC');
    const mk = (supported, binding = 'rotate') => {
      const lines = [];
      const o = Object.create(SmartAC.prototype);
      o.log = { warn: (m) => lines.push(`warn|${m}`), info: (m) => lines.push(`info|${m}`), debug: () => {} };
      o._label = '기기';
      o._swingBinding = binding;
      o.smartthings = { getSupportedWindDirections: async () => supported };
      return { o, lines };
    };

    const seungjun = mk(['Fix', 'Left_And_Right']);          // 승준 에어컨 실측
    check(await seungjun.o._resolveSwingDirection('D') === 'Left_And_Right',
      '★좌우만 지원하는 기기는 좌우를 고른다 (승준 에어컨 실측 구성)');
    check(seungjun.lines.some((l) => /스윙 회전 방향 = Left_And_Right/.test(l)),
      '무엇을 골랐는지 로그에 남긴다');

    const cac = mk(['Up_And_Low', 'Fix', 'Left_And_Right', 'All']);   // 천장형 실측
    check(await cac.o._resolveSwingDirection('D') === 'Up_And_Low',
      '네 방향을 다 지원하면 상하를 고른다');

    const odd = mk(['Fix', 'All']);
    check(await odd.o._resolveSwingDirection('D') === 'All',
      '우선순위에 없어도 고정이 아닌 값이 있으면 그것을 쓴다');

    const nothing = mk(['Fix']);
    check(await nothing.o._resolveSwingDirection('D') === null,
      '회전할 수 있는 방향이 없으면 아무것도 보내지 않는다');
    check(nothing.lines.some((l) => /회전할 수 있는 바람방향이 없습니다/.test(l)),
      '그 사실을 알리고 무엇으로 바꾸라고 말해 준다');

    // 방향을 콕 집었으면 기기에 묻지 않는다
    let asked = 0;
    const fixed = mk(['Fix', 'All'], 'Left_And_Right');
    fixed.o.smartthings = { getSupportedWindDirections: async () => { asked++; return []; } };
    check(await fixed.o._resolveSwingDirection('D') === 'Left_And_Right' && asked === 0,
      '★설정에서 방향을 고른 경우엔 기기에 묻지 않는다 (요청을 늘리지 않는다)');

    // 한 번 고르면 다시 묻지 않는다
    let n = 0;
    const cached = mk(['Fix', 'Left_And_Right']);
    cached.o.smartthings = { getSupportedWindDirections: async () => { n++; return ['Fix', 'Left_And_Right']; } };
    await cached.o._resolveSwingDirection('D');
    await cached.o._resolveSwingDirection('D');
    check(n === 1, '고른 방향을 기억한다 (폴마다 다시 묻지 않는다)');
  }

  console.log(`\n[바람방향] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
