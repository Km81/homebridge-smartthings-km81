'use strict';

/**
 * put_away.js — 「임시 연결해제(putAway)」 토글 회귀 (v2.15.0, 2026-09-14)
 *
 * 왜 이 회귀가 있나:
 *   이 기능의 목적은 **로그를 안 내는 것**이다. 그런데 로그 문구는 NAS 감시기(hb_watch)의
 *   API 라서, 여기서 실수로 감시 어휘를 한 조각이라도 내보내면
 *   **감시에서 빼려고 만든 기능이 감시를 깨우는** 일이 된다.
 *   ★주석으로 적은 규칙은 안 지켜진다 — 그래서 회귀로 박는다.
 *
 * ⚠️★대조군이 반드시 있어야 한다. "통신이 0건이다"는 **아무것도 실행되지 않아도 참**이 된다.
 *   그래서 putAway 를 끈 같은 액세서리가 **실제로 통신을 시도하는지**를 같이 잰다.
 *   대조군이 실패하면 이 스위트 전체가 무의미하다.
 *
 * 실행: node test/put_away.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { isPutAway, PUT_AWAY_MESSAGE, sealForPutAway } = require('../lib/common/putAway');
const Laundry = require('../lib/accessories/Laundry');
const LegacyLaundryClient = require('../lib/api/LegacyLaundryClient');
const { installFakeTimers, mkHarness } = require('./_hap_stub');

const CERT = path.join(REPO, 'cert', 'cert.pem');

/**
 * ★NAS 감시기 `/volume1/.Script/hb_watch/hb_watch.sh` 가 homebridge.log 에서 찾는 어휘.
 *   2026-09-14 정본에서 그대로 추출했다(🟡 클라우드 / 🔴 폴링 / 복구 / OFFFAIL / 재시작 마커).
 * ⚠️감시기 쪽이 어휘를 늘리면 이 목록도 함께 늘려야 한다 — 어휘는 **두 방의 계약**이고
 *   지금 사본이 두 벌이다(저쪽은 `hb_watch/test/vocab_contract.py` 24케이스).
 *   ★정본은 `hb_watch.sh` 그 자체다(2026-09-14 NAS VM 방 회신 §4).
 */
const WATCH_VOCAB = [
  '폴링 실패', '상태 조회 실패', '상태 폴링 오류', '연결 실패', '폴링 중 오류', '상태 조회 오류',
  '사실상 클라우드로 동작 중', '제어되지 않습니다', '폴링 복구', '상태 조회 복구', '연결됨',
  '로컬 복귀', '수신 복귀', '기기 접속됨', '실시간 조회 복구', '사용량 조회 복구', '폴링 회복됨',
  '첫 폴링 성공', '기기 온라인 복귀', '기기 오프라인',
  '로컬 재탐색', '로컬 복구 확인', '클라우드로 폴백', '보안연결 실패',
  '끄기 재시도 실패', '기기가 켜진 채', '켜진 상태로 남았습니다',
];

function vocabHits(lines) {
  const hits = [];
  for (const line of lines) {
    for (const v of WATCH_VOCAB) if (line.indexOf(v) !== -1) hits.push(`${v} :: ${line}`);
  }
  return hits;
}

function mkLog() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const push = (k) => (...a) => lines[k].push(a.map(String).join(' '));
  return {
    lines,
    all: () => [].concat(lines.info, lines.warn, lines.error),   // debug 는 운영 로그에 안 남는다
    info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'),
  };
}

const SRC = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** 앵커 두 개의 등장 순서를 본다 — 게이트가 통신 시작보다 **앞**에 있어야 한다. */
function gateBefore(rel, gate, comm) {
  const s = SRC(rel);
  const gi = s.indexOf(gate);
  const ci = s.indexOf(comm);
  assert.notStrictEqual(gi, -1, `${rel}: 게이트를 찾지 못했다 — ${gate}`);
  assert.notStrictEqual(ci, -1, `${rel}: 통신 시작 지점을 찾지 못했다 — ${comm}`);
  assert.ok(gi < ci, `${rel}: 게이트가 통신 시작보다 뒤에 있다 (gate=${gi}, comm=${ci})`);
}

/* ------------------------------------------------------------------ */

let total = 0, failed = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}
async function checkAsync(name, fn) {
  total++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

console.log('put_away — 임시 연결해제 토글 회귀 (st)');

/* ── ① 계측기 자체 시험 ───────────────────────────────────────────────
   「어휘 0건」이 참인 이유는 셋이다: ⓐ정말 안 나와서 ⓑ아무것도 안 돌아서 ⓒ탐지기가 고장나서.
   ⓒ를 먼저 배제한다 — 진짜 경보줄을 물려 탐지기가 잡는지 본다. */
check('[계측기] vocabHits 가 진짜 경보줄을 잡는다', () => {
  const hits = vocabHits(['[거실 에어컨] 상태 조회 실패 (3회)']);
  assert.ok(hits.length >= 1, '탐지기가 진짜 경보줄을 놓쳤다 — 이 스위트는 무의미하다');
});
check('[계측기] 무관한 줄은 잡지 않는다', () => {
  assert.strictEqual(vocabHits(['[거실 에어컨] 설정을 읽었습니다']).length, 0);
});

/* ── ② 문구 ─────────────────────────────────────────────────────── */
check('안내 문구에 감시 어휘가 하나도 없다', () => {
  const hits = vocabHits([PUT_AWAY_MESSAGE]);
  assert.deepStrictEqual(hits, [], `감시 어휘가 섞였다: ${hits.join(' | ')}`);
});
check('안내 문구는 단답형이다 (문장부호로 풀어 쓰지 않는다)', () => {
  assert.ok(PUT_AWAY_MESSAGE.length <= 24, `너무 길다(${PUT_AWAY_MESSAGE.length}자) — 서술형 금지`);
  assert.ok(!/[.!?]/.test(PUT_AWAY_MESSAGE), '마침표가 있다 — 서술형으로 되돌아갔다');
});

/* ── ③ fail-safe ─────────────────────────────────────────────────
   설정이 이상하면 「연결해제」가 아니라 「평소대로 감시」 쪽으로 넘어져야 한다. */
check('isPutAway 는 boolean true 만 참으로 본다', () => {
  assert.strictEqual(isPutAway({ putAway: true }), true);
  assert.strictEqual(isPutAway({ putAway: 'true' }), false, '문자열을 참으로 읽었다');
  assert.strictEqual(isPutAway({ putAway: 1 }), false, '숫자를 참으로 읽었다');
  assert.strictEqual(isPutAway({ putAway: false }), false);
  assert.strictEqual(isPutAway({}), false);
  assert.strictEqual(isPutAway(null), false);
  assert.strictEqual(isPutAway(undefined), false);
});

/* ── ④ 구조 회귀 — 게이트가 통신 시작보다 앞에 있는가 (5곳) ───────────── */
check('LegacyAC — 게이트가 startPolling 앞에 있다', () => {
  gateBefore('lib/accessories/LegacyAC.js', 'if (isPutAway(this.config))', 'this.startPolling();');
});
check('LegacyAC — _initialized 를 true 로 남긴다 (액세서리 회수 방지)', () => {
  const s = SRC('lib/accessories/LegacyAC.js');
  const blk = s.slice(s.indexOf('if (isPutAway(this.config))'), s.indexOf('this.startPolling();'));
  assert.ok(blk.indexOf('this._initialized = true;') !== -1, '게이트 안에서 _initialized 를 세우지 않는다');
  assert.ok(blk.indexOf('this._stopped = true;') !== -1, '이중 잠금(_stopped)이 없다');
});
check('SmartAC — 게이트가 _setupBackgroundPolling 앞에 있다', () => {
  gateBefore('lib/accessories/SmartAC.js', 'if (isPutAway(configDevice))', 'this._setupBackgroundPolling(accessory, configDevice);');
});
check('Laundry — 게이트가 _startPolling 앞에 있다', () => {
  gateBefore('lib/accessories/Laundry.js', 'if (isPutAway(configDevice))', 'this._startPolling(accessory, configDevice, this.units);');
});
check('정수기 — 게이트가 로컬 브릿지 사용보다 앞에 있다', () => {
  const s = SRC('index.js');
  const fn = s.slice(s.indexOf('async _setupWaterPurifier(configDevice) {'));
  const gi = fn.indexOf('if (isPutAway(configDevice))');
  const ci = fn.indexOf('this.localClient');
  assert.ok(gi !== -1 && ci !== -1 && gi < ci, `정수기 게이트 위치가 틀렸다 (gate=${gi}, comm=${ci})`);
});

/* ── ⑤ ⛔MQTT 를 회수하지 않는다 ────────────────────────────────────
   회수하면 HA 엔티티가 사라져 자동화가 깨진다. 「중계 안 함」과 「엔티티 삭제」는 다르다. */
check('⛔putAway 게이트가 _retractMqtt 를 부르지 않는다', () => {
  const s = SRC('index.js');
  const start = s.indexOf('_attachMqtt(accessory, configDevice, logic) {');
  const gi = s.indexOf('if (isPutAway(configDevice)) return;', start);
  assert.notStrictEqual(gi, -1, '_attachMqtt 에 putAway 게이트가 없다');
  // ⚠️판정은 **실제 호출**로 좁힌다 — 설명 주석에도 이 이름이 나오므로 문자열만 세면
  //   계측기가 제 주석을 코드로 읽는다(첫 실행에서 실제로 그렇게 틀렸다).
  const blk = s.slice(start, gi);
  assert.strictEqual(blk.indexOf('this._retractMqtt('), -1,
    'putAway 가 회수 경로를 타고 있다 — HA 엔티티가 사라진다');
  // 게이트는 mqttExpose 회수 분기보다 **앞**이어야 한다(두 기능이 섞이면 안 된다).
  const ri = s.indexOf('this._retractMqtt(', start);
  assert.ok(gi < ri, 'putAway 게이트가 회수 분기 뒤에 있다');
});

/* ── ⑥ 설정 화면에 실제로 뜨는가 ───────────────────────────────────── */
check('스키마에 putAway 가 있고 layout 에도 노출된다', () => {
  const j = JSON.parse(SRC('config.schema.json'));
  const p = j.schema.properties.devices.items.properties.putAway;
  assert.ok(p, '스키마에 putAway 가 없다');
  assert.strictEqual(p.type, 'boolean');
  assert.strictEqual(p.default, false);
  assert.strictEqual(p.title, '임시 연결해제');
  const lay = j.layout.find((b) => b && b.key === 'devices');
  assert.ok(lay.items.includes('devices[].putAway'),
    'layout 에 없다 — 스키마만 고치면 화면은 안 바뀐다(실사고)');
});
check('⛔설정 화면 설명에 우리 집 사정이 없다', () => {
  const j = JSON.parse(SRC('config.schema.json'));
  const d = j.schema.properties.devices.items.properties.putAway.description;
  for (const w of ['승준', '민서', '거실', '침실', '겨울', '가을']) {
    assert.strictEqual(d.indexOf(w), -1, `설명에 우리 집 사정이 들어갔다: ${w}`);
  }
});

/* ── ⑧ ★홈킷 타일은 「정상 연결 + 마지막 상태」여야 한다 (v2.4.0 / v2.16.0) ──────────
   Km81 님 지시: 「정상연결로 최종 상태를 가져왔으면 해」.
   그 전에는 선풍기 = 정상 연결 + 기본값, 에어컨 = **응답 없음** 으로 갈렸다.

   ⚠️아래 가짜 특성은 hap-nodejs 2.2.2 를 **직접 실행해 관측한 규칙**을 그대로 모형화한다:
     ① 게터가 없으면 현재 값으로 답한다
     ② 게터가 한 번 던지면 `status` 가 눌러붙어 그 뒤로 계속 거부한다
     ③ 그 `status` 는 대입으로는 안 지워지고 `updateValue()` 로만 지워진다
   ⛔실제 hap 은 이 저장소의 의존 패키지가 아니다 — 그래서 규칙을 모형으로 고정한다.
     모형이 실물과 어긋나면 이 회귀는 거짓 안심이 된다(관측 근거는 HANDOFF 에 적었다). */
function mkChar(value) {
  return {
    value,
    status: null,
    getHandler: null,
    setHandler: null,
    onGet(fn) { this.getHandler = fn; return this; },
    onSet(fn) { this.setHandler = fn; return this; },
    removeOnGet() { this.getHandler = null; return this; },
    removeOnSet() { this.setHandler = null; return this; },
    updateValue(v) { this.value = v; this.status = null; return this; },   // ③
    // hap 의 handleGetRequest 를 모형화
    get_() {
      if (this.getHandler) {
        try { return this.getHandler(); }
        catch (e) { this.status = -70402; throw e; }                        // ②
      }
      if (this.status) throw this.status;                                   // ② 눌러붙음
      return this.value;                                                   // ①
    },
  };
}

function mkAcc(vals) {
  const chars = vals.map(mkChar);
  return { services: [{ characteristics: chars }], chars };
}

check('[모형] 게터가 던지면 「응답 없음」이 된다 — 고치려는 증상 자체', () => {
  const a = mkAcc([1]);
  a.chars[0].onGet(() => { throw new Error('통신 실패'); });
  assert.throws(() => a.chars[0].get_(), /통신 실패/);
  assert.strictEqual(a.chars[0].status, -70402, 'status 가 눌러붙지 않았다 — 모형이 틀렸다');
});

check('★sealForPutAway 뒤에는 마지막 값으로 답한다', () => {
  const a = mkAcc([1, 26, 24]);
  a.chars.forEach((c) => c.onGet(() => { throw new Error('통신 실패'); }));
  try { a.chars[0].get_(); } catch (e) { /* 눌러붙게 만든다 */ }
  const n = sealForPutAway(a);
  assert.strictEqual(n, 3, `봉한 특성 수가 ${n} 이다`);
  assert.deepStrictEqual(a.chars.map((c) => c.get_()), [1, 26, 24],
    '마지막 상태로 답하지 않는다 — 홈 앱에 「응답 없음」이 남는다');
});

check('★sealForPutAway 는 눌러붙은 status 도 지운다', () => {
  const a = mkAcc([1]);
  a.chars[0].onGet(() => { throw new Error('x'); });
  try { a.chars[0].get_(); } catch (e) { /* noop */ }
  assert.strictEqual(a.chars[0].status, -70402);
  sealForPutAway(a);
  assert.strictEqual(a.chars[0].status, null, 'status 가 남아 있다 — 계속 거부된다');
});

check('★쓰기 핸들러도 떼어 낸다 (탭이 통신을 만들지 않는다)', () => {
  const a = mkAcc([0]);
  let sent = 0;
  a.chars[0].onSet(() => { sent += 1; });
  sealForPutAway(a);
  assert.strictEqual(a.chars[0].setHandler, null, 'onSet 이 남아 있다');
  assert.strictEqual(sent, 0);
});

check('⛔값이 없는 특성은 건드리지 않는다 (hap 이 경고를 낸다)', () => {
  const a = mkAcc([null]);
  let touched = 0;
  a.chars[0].updateValue = () => { touched += 1; };
  sealForPutAway(a);
  assert.strictEqual(touched, 0, 'value 가 null 인데 updateValue 를 불렀다');
});

check('⛔한 특성이 실패해도 나머지를 계속 봉한다', () => {
  const a = mkAcc([1, 1]);
  a.chars[0].removeOnGet = () => { throw new Error('깨진 특성'); };
  a.chars[1].onGet(() => { throw new Error('x'); });
  assert.doesNotThrow(() => sealForPutAway(a));
  assert.strictEqual(a.chars[1].getHandler, null, '뒤 특성이 안 봉해졌다');
});

check('⛔액세서리가 없거나 서비스가 없어도 던지지 않는다', () => {
  assert.strictEqual(sealForPutAway(null), 0);
  assert.strictEqual(sealForPutAway({}), 0);
  assert.strictEqual(sealForPutAway({ services: [{}] }), 0);
});

/* ── ⑨ 구조 회귀 — 게이트가 seal 을 부르는가 ──── */
check('LegacyAC.js — 게이트가 sealForPutAway 를 부른다', () => {
  const s = SRC('lib/accessories/LegacyAC.js');
  const g = s.indexOf('isPutAway(');
  const k = s.indexOf('sealForPutAway(', g);
  const c = s.indexOf('this.startPolling();');
  assert.ok(k !== -1, 'seal 호출이 없다 — 타일이 「응답 없음」이 된다');
  assert.ok(g < k && k < c, `위치가 틀렸다 (gate=${g}, seal=${k}, comm=${c})`);
});
check('SmartAC.js — 게이트가 sealForPutAway 를 부른다', () => {
  const s = SRC('lib/accessories/SmartAC.js');
  const g = s.indexOf('isPutAway(');
  const k = s.indexOf('sealForPutAway(', g);
  const c = s.indexOf('this._setupBackgroundPolling(accessory, configDevice);');
  assert.ok(k !== -1, 'seal 호출이 없다 — 타일이 「응답 없음」이 된다');
  assert.ok(g < k && k < c, `위치가 틀렸다 (gate=${g}, seal=${k}, comm=${c})`);
});
check('Laundry.js — 게이트가 sealForPutAway 를 부른다', () => {
  const s = SRC('lib/accessories/Laundry.js');
  const g = s.indexOf('isPutAway(');
  const k = s.indexOf('sealForPutAway(', g);
  const c = s.indexOf('this._startPolling(accessory, configDevice, this.units);');
  assert.ok(k !== -1, 'seal 호출이 없다 — 타일이 「응답 없음」이 된다');
  assert.ok(g < k && k < c, `위치가 틀렸다 (gate=${g}, seal=${k}, comm=${c})`);
});

/* ── ⑦ ★행동 회귀 — 진짜 배선으로 폴을 돌린다 (Laundry 계층) ──────────
   소스를 읽어 판정하지 않는다. 실제로 인스턴스를 만들고 시간을 돌려 **전송 횟수**를 센다. */
async function runLaundry(configDevice, polls) {
  const timers = installFakeTimers();
  const log = mkLog();
  const h = mkHarness();
  const acc = h.mkAccessory('세탁기', 'uuid:pa');
  acc.context.device = { deviceId: 'W1', label: '세탁기' };
  h.platform.accessories.push(acc);

  const ip = `10.77.0.${Math.floor(Math.random() * 250) + 1}`;
  const client = new LegacyLaundryClient(log, { ip, token: 'x'.repeat(10), timeout: 10, certPath: CERT });
  let sent = 0;
  client.transport._rawRequest = async () => {
    sent += 1;
    throw new Error('TLS 소켓 오류: connect EHOSTUNREACH');
  };

  const l = new Laundry({ log, api: h.api, platform: h.platform, deviceKind: 'washer', smartthings: client });
  l.configure(acc, configDevice, '9.9.9');
  for (let i = 0; i < polls; i++) { client.transport._statusCache = null; await timers.tick(); }
  timers.restore();
  return { sent, log };
}

(async () => {
  await checkAsync('putAway 면 40폴을 돌려도 전송이 0회다', async () => {
    const r = await runLaundry({ putAway: true, sensorPollInterval: 10 }, 40);
    assert.strictEqual(r.sent, 0, `전송이 ${r.sent}회 나갔다 — 게이트가 새고 있다`);
  });

  await checkAsync('putAway 면 감시 어휘가 한 줄도 안 나온다', async () => {
    const r = await runLaundry({ putAway: true, sensorPollInterval: 10 }, 40);
    const hits = vocabHits(r.log.all());
    assert.deepStrictEqual(hits, [], `감시 어휘가 나왔다: ${hits.slice(0, 3).join(' | ')}`);
  });

  await checkAsync('putAway 면 기동 로그가 안내 한 줄을 포함한다', async () => {
    const r = await runLaundry({ putAway: true, sensorPollInterval: 10 }, 5);
    assert.ok(r.log.all().some((l) => l.indexOf(PUT_AWAY_MESSAGE) !== -1),
      '안내 문구가 안 나왔다 — 사람이 상태를 알 방법이 없다');
  });

  /* ★대조군 — 이게 실패하면 위의 「0회」는 아무것도 증명하지 않는다. */
  await checkAsync('[대조군] putAway 가 꺼져 있으면 실제로 전송한다', async () => {
    const r = await runLaundry({ sensorPollInterval: 10 }, 40);
    assert.ok(r.sent > 0, '대조군이 0회다 — 하네스가 고장났고 이 스위트는 무의미하다');
  });

  console.log(`\n총 ${total}건 · 실패 ${failed}건`);
  process.exit(failed ? 1 : 0);
})();
