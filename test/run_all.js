'use strict';
/**
 * run_all.js — 전 스위트 일괄 실행기 (v2.1.3, `npm test` / CI 진입점)
 *
 * 배경: v2.1.1 감사에서 "릴리스 파이프라인이 문법 검사(node --check)만 수행,
 * 505+체크가 전부 수동 실행 의존"이 최우선 개선 제안으로 나옴. 이 러너를
 * package.json scripts.test + .github/workflows/publish.yml에 연결해
 * 태그 push 시 전 스위트가 통과해야만 npm publish가 진행되게 한다.
 *
 * 순차 실행 이유: sim_* 계열이 실타이머 기반이라 병렬 실행 시 CPU 경합으로
 * 타이밍 단언이 흔들릴 수 있음(CI 러너는 느림). 총 ~6분.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  { file: 'chain_test.js' },
  { file: 'sim_ac_fail.js' },
  { file: 'sim_v1824.js' },
  { file: 'sim_v1829.js' },
  { file: 'sim_recovery_v200.js' },
  { file: 'sim_v212.js' },
  { file: 'audit_log-regression.js' },
  { file: 'audit_legacy-concurrency.js' },
  { file: 'audit_cloud-oauth.js' },
  { file: 'audit_efficiency.js', nodeArgs: ['--expose-gc'] },
  { file: 'audit_robustness.js' },
];

const t0 = Date.now();
let failed = 0;
for (const s of SUITES) {
  const args = [...(s.nodeArgs || []), path.join(__dirname, s.file)];
  const t = Date.now();
  const r = spawnSync(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 8 * 60 * 1000,
  });
  const dur = ((Date.now() - t) / 1000).toFixed(1);
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.file}  (${dur}s)`);
  if (!ok) {
    console.log('  ────── 실패 스위트 출력 꼬리 ──────');
    for (const l of String(r.stdout || '').trim().split('\n').slice(-30)) console.log(`  ${l}`);
    for (const l of String(r.stderr || '').trim().split('\n').slice(-10)) console.log(`  ${l}`);
  }
}
console.log(`\n총 ${SUITES.length}스위트 / 실패 ${failed} / ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed ? 1 : 0);
