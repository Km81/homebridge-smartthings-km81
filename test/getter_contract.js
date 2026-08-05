'use strict';

// getter 반환 계약 회귀 (2026-08-05 신설)
//
// 계약:
//   조회 실패(통신 오류)  → undefined  = "못 읽었다"   → 소비자는 손대지 않는다
//   조회 성공 + 값 없음   → null       = "값이 없다"   → 소비자는 키를 지운다
//
// ⚠️왜 회귀가 필요한가: 이 규칙을 주석으로 세 번 적었고 세 번 다 다음 날 어겼다.
//   21개 getter 중 15개가 실패와 빈 값을 똑같이 null 로 돌려주고 있었고(적대 리뷰),
//   증상은 매번 같았다 — **값이 사라져도 HA 센서가 옛 값에 영구 고착.**
//   ⛔주석은 안 지켜진다. 이 파일이 계약이다.

const path = require('path');
const LocalApplianceClient = require('../lib/api/LocalApplianceClient');

let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${msg}${detail ? ' (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ❌ ${msg}${detail ? ' (' + detail + ')' : ''}`); }
};

const mkLog = () => ({ info() {}, warn() {}, error() {}, debug() {} });

// 대상 getter 전수 — **소스에서** 뽑는다(손으로 적으면 새로 만든 것을 빠뜨린다).
// `_get`(리소스 조회)을 실제로 쓰는 getter만 본다 — 홈킷 특성 캐시를 읽는 getter는
// 계약이 다르고, 이 스텁으로는 잴 수 없다.
const SRC = require('fs').readFileSync(
  path.join(__dirname, '..', 'lib', 'api', 'LocalApplianceClient.js'), 'utf8');
const GETTERS = [];
{
  const re = /^  async (get[A-Za-z0-9]+)\(/gm;
  let m;
  while ((m = re.exec(SRC))) {
    const start = m.index;
    const next = SRC.indexOf('\n  async ', start + 1);
    const body = SRC.slice(start, next === -1 ? SRC.length : next);
    if (/this\._get\(/.test(body)) GETTERS.push(m[1]);
  }
}
// ★계약이 적용되는 범위 = **MQTT(attach.js)가 실제로 소비하는 것**.
//   홈킷 경로 getter는 특성 캐시를 읽어 계약이 다르고, 이 스텁으로는 잴 수 없다.
const ATTACH = require('fs').readFileSync(
  path.join(__dirname, '..', 'lib', 'mqtt', 'attach.js'), 'utf8');
const USED = new Set();
{
  const re = /client\.(get[A-Za-z0-9]+)\s*\(/g;
  let m;
  while ((m = re.exec(ATTACH))) USED.add(m[1]);
}
// `getStatus` 는 제외 — 부분 필드가 아니라 컴포넌트 트리를 통째로 돌려주고, 실패는 **예외로**
// 알린다(폴러의 catch 가 받아 연속 실패를 센다). 계약이 다르므로 같은 잣대로 재면 안 된다.
const SCOPED = GETTERS.filter((g) => USED.has(g) && g !== 'getStatus');

console.log(`\n[getter 반환 계약] 대상 ${GETTERS.length}종`);
if (GETTERS.length < 15) {
  console.log(`  ❌ 추출이 너무 적다(${GETTERS.length}) — 판정 무효`);
  process.exit(1);
}

function mkClient(getImpl) {
  const c = Object.create(LocalApplianceClient.prototype);
  c.log = mkLog();
  c._get = getImpl;
  c._post = async () => ({});
  c._labelOf = () => 'test';
  c._stat = () => ({ ok: 0, fail: 0 });
  return c;
}

(async () => {
  // ① 통신 실패 → 전부 undefined 여야 한다
  const failing = mkClient(async () => { throw new Error('timeout'); });
  const badFail = [];
  for (const g of SCOPED) {
    let r;
    try { r = await failing[g]('dev'); } catch (e) { r = `throw:${e.message}`; }
    if (r !== undefined) badFail.push(`${g}→${JSON.stringify(r)}`);
  }
  ok(badFail.length === 0,
    '★조회 실패는 전부 undefined (옛 값을 지우지 않는다)',
    badFail.length ? badFail.slice(0, 5).join(' · ') : `${SCOPED.length}종`);

  // ② 조회 성공·빈 응답 → undefined 가 아니어야 한다(null 이거나 빈 값을 담은 객체)
  const empty = mkClient(async () => ({}));
  const badEmpty = [];
  for (const g of SCOPED) {
    let r;
    try { r = await empty[g]('dev'); } catch (e) { continue; }   // 빈 응답에 throw 하면 ①이 잡는다
    if (r === undefined) badEmpty.push(g);
  }
  ok(badEmpty.length === 0,
    '★조회 성공·빈 값은 undefined 가 아니다 (실패와 구분된다)',
    badEmpty.length ? badEmpty.join(' · ') : `${SCOPED.length}종`);

  // ③ 두 경우가 실제로 구별 가능한가 — 계약의 핵심
  const same = [];
  for (const g of SCOPED) {
    let a, b;
    try { a = await failing[g]('dev'); } catch (e) { a = 'throw'; }
    try { b = await empty[g]('dev'); } catch (e) { b = 'throw'; }
    if (a === b && a === undefined) same.push(g);
  }
  ok(same.length === 0,
    '★실패와 빈 값이 같은 값으로 뭉개지지 않는다',
    same.length ? same.join(' · ') : '전부 구별됨');

  // ── ④ `lastOk`(= HA 의 `last_seen`)는 **조회가 성공한 모든 경로**에서 갱신돼야 한다 ──
  //
  // ⚠️실사고: `_withFallback` 안에만 넣었더니 **에어컨 경로가 통째로 빠졌다**(에어컨 getter 는
  //   `_get` 을 직접 부른다). 배포 후 브로커 실측에서 에어컨 `last_seen` 만 비어 있는 것으로
  //   드러났다 — 테스트가 없었으면 "넣었다"고 믿은 채 지나갔다.
  {
    const c = Object.create(LocalApplianceClient.prototype);
    c.log = mkLog();
    c._stats = new Map();
    c._cache = new Map();
    c._dev = () => ({ host: '1.2.3.4', port: 0, localPort: 0 });
    c._serialize = (id, fn) => fn();
    c._ensureIdentity = async () => {};
    c._learnPort = () => {};
    c._rpc = async () => ({ ok: true, code: 69, data: { x: 1 }, port: 49152 });   // 69 = CoAP 2.05

    const before = c._stat('dev').lastOk;
    await c._get('dev', ['a', 'vs', '0']);
    const after = c._stat('dev').lastOk;
    ok(before === 0 && after > 0,
      '★`_get` 성공이 lastOk 를 갱신한다 (에어컨 계열 getter 가 타는 경로)',
      `${before} → ${after}`);

    // 실패는 갱신하지 않는다 — 마지막 성공 시각이 남아야 경과가 커진다.
    c._rpc = async () => { throw new Error('timeout'); };
    const keep = c._stat('dev').lastOk;
    try { await c._get('dev', ['b', 'vs', '0']); } catch (e) {}
    ok(c._stat('dev').lastOk === keep,
      '★조회 실패는 lastOk 를 건드리지 않는다 (경과가 커져야 HA 가 사망을 안다)');
  }

  console.log(`\n${fail === 0 ? '✅ 전부 통과' : `❌ 실패 ${fail}건`} (통과 ${pass})`);
  process.exit(fail === 0 ? 0 : 1);
})();
