'use strict';
/**
 * sim_recovery_v200.js — v2.0.0 실패↔복구 로그 쌍 검증 (smartthings)
 *  A. SmartThingsClient.getStatus: 스트릭 억제(1회 error → debug → 10회 warn) + 복구 info
 *  B. LegacyACClient: 401 래치 해소 시 '인증 복구' info
 *  C. 문턱 >0: 실패 1회 후 복구도 info 발화 (LegacyACClient._failStreak)
 */
const path = require('path');
let checks = 0, fails = 0;
function assert(cond, name) {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) fails++;
}
function mkLog() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  return {
    lines,
    info: (...a) => lines.info.push(a.join(' ')),
    warn: (...a) => lines.warn.push(a.join(' ')),
    error: (...a) => lines.error.push(a.join(' ')),
    debug: (...a) => lines.debug.push(a.join(' ')),
  };
}
const count = (arr, s) => arr.filter((l) => l.includes(s)).length;

(async () => {
  // ═══ A. getStatus 스트릭 + 복구 ═══
  console.log('\n[A] SmartThingsClient.getStatus');
  {
    const STC = require('../lib/api/SmartThingsClient.js');
    const log = mkLog();
    const o = Object.create(STC.prototype);
    o.log = log;
    o.cache = { _m: new Map(), get(k) { return undefined; }, set() {}, delete() {} }; // 캐시 항상 미스
    o.statusPromises = new Map();
    o._statusFailStreaks = new Map();
    let mode = 'fail';
    o.client = { get: async () => { if (mode === 'fail') throw new Error('ETIMEDOUT'); return { data: { components: { main: {} } } }; } };
    // 실패 12회 → error 1 + warn 1(10회째) + debug 10
    for (let i = 0; i < 12; i++) { try { await o.getStatus('dev1'); } catch (_) {} }
    mode = 'ok';
    await o.getStatus('dev1'); // 복구
    await o.getStatus('dev1'); // 연속 성공 — 반복 없음
    assert(count(log.lines.error, '상태 조회 실패') === 1, '첫 실패만 error');
    assert(count(log.lines.warn, '실패 지속 x10') === 1, '10회째 warn 1회');
    assert(count(log.lines.debug, '상태 조회 실패 x') === 10, '나머지 10회는 debug');
    assert(count(log.lines.info, '상태 조회 복구 — 연속 12회') === 1, '복구 info 1회 (스트릭 수 표기)');
    assert(o._statusFailStreaks.size === 0, '복구 후 스트릭 맵 정리');
    // 기기별 독립
    let m2 = 'fail';
    o.client.get = async () => { if (m2 === 'fail') throw new Error('x'); return { data: { components: {} } }; };
    try { await o.getStatus('dev2'); } catch (_) {}
    m2 = 'ok'; await o.getStatus('dev2');
    assert(count(log.lines.info, '[dev2] 상태 조회 복구 — 연속 1회') === 1, '실패 1회 후에도 복구 info (기기별 독립)');
  }

  // ═══ B+C. LegacyACClient — 401 래치 복구 + 문턱 >0 ═══
  console.log('\n[B/C] LegacyACClient');
  {
    const LAC = require('../lib/api/LegacyACClient.js');
    const Cls = LAC.LegacyACClient || LAC;
    const log = mkLog();
    const o = Object.create(Cls.prototype);
    o.log = log; o._failStreak = 0; o._authLatched = false; o._waiting = 0;
    let mode = 'auth';
    o._rawRequest = async () => {
      if (mode === 'auth') throw new Error('인증 실패(401)');
      if (mode === 'net') throw new Error('ECONNREFUSED');
      return { ok: true };
    };
    // 401 x3 → error 1회(래치)
    for (let i = 0; i < 3; i++) { try { await o._requestWithRetry('GET', '/x', null, 1); } catch (_) {} }
    assert(count(log.lines.error, '해소될 때까지') === 1, '401 래치 error 1회');
    mode = 'ok'; await o._requestWithRetry('GET', '/x', null, 1);
    assert(count(log.lines.info, '인증 복구 — 토큰이 다시 유효') === 1, '래치 해소 info 1회');
    assert(o._authLatched === false, '래치 플래그 해제');
    // 네트워크 실패 1회 → error 1 → 복구 info (문턱 >0 검증)
    mode = 'net';
    try { await o._requestWithRetry('GET', '/x', null, 1) } catch (_) {}
    assert(count(log.lines.error, '최종 요청 실패') === 1, '네트워크 실패 error 1회');
    mode = 'ok'; await o._requestWithRetry('GET', '/x', null, 1);
    assert(count(log.lines.info, '기기 응답 복구 — 연속 1회') === 1, '실패 1회 후 복구 info (문턱 >0)');
    // 무실패 연속 성공 — 복구 반복 없음
    await o._requestWithRetry('GET', '/x', null, 1);
    assert(count(log.lines.info, '기기 응답 복구') === 1, '연속 성공 시 복구 로그 반복 없음');
  }

  console.log(`\n총 체크 ${checks}개 / 실패 ${fails}개`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('하네스 오류:', e); process.exit(2); });
