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
  // ── 빠른 계약 검사 먼저 (수 초). 여기서 깨지면 아래 6분을 기다릴 이유가 없다 ──
  // v2.4.5 신설 3종. 이번 감사에서 드러난 세 가지 사각지대를 각각 막는다:
  //   log_volume  — "하루에 로그가 몇 줄 나오는가"를 실제 코드로 계측(액세서리 계층 포함).
  //                 소스만 읽으면 억제 로직의 존재는 보이지만 총량은 안 보인다.
  //   schema_ui   — 설정 화면이 실제로 그리는 필드를 재현. 스키마만 고치고 layout을
  //                 안 고쳐 화면이 안 바뀌던 실사고를 기계로 막는다.
  //   readme_check— 문서가 코드보다 먼저 낡는 건 못 막으니, 낡으면 깨지게 한다.
  { file: 'log_volume.js' },
  { file: 'schema_ui.js' },
  { file: 'readme_check.js' },
  // v2.6.7 — 인증서 발급은 **첫 설치에서만** 지나가는 경로라 우리 기기로는 절대 안 깨진다.
  //          최신 배포판에서 발급이 통째로 실패하던 결함이 사용자 로그로만 드러났다.
  { file: 'bridge_cert.js' },
  // v2.8.0 — 온도 리소스 경로가 보드마다 다르다. 표준을 가진 보드가 예전과 똑같은 요청을
  //          내는지(회귀)와, 제조사 경로의 문자열·형식 규약을 지키는지를 함께 본다.
  { file: 'ac_temp_channel.js' },
  // v2.8.0 — 리소스 부재(4.04)를 통신 실패로 세면 포트 재탐지와 사망 경보가 헛돈다.
  //          ⚠️진짜 전송 실패에서는 그 경보가 그대로 나오는지도 같은 스위트에서 확인한다.
  { file: 'notfound_not_failure.js' },
  // v2.8.2 — 기기 기능 목록 덤프. ★핵심은 가림 처리다 — 사용자가 이 로그를 그대로 보낸다.
  { file: 'resource_dump.js' },
  // v2.6.10 — 첫 부팅(의존성 설치 중) 경로. LocalApplianceClient를 스텁으로 갈아끼우므로
  //           진짜 클라이언트를 쓰는 스위트와 반드시 별도 프로세스여야 한다.
  { file: 'first_boot.js' },
  // v2.5.0 — MQTT 브리지 계약(availability 의미론·setValue 경유 명령·경보 문구 충돌·발행 dedupe)
  { file: 'mqtt_bridge.js' },
  //   keepalive   — v2.4.2~2.4.5의 새 접합부(타이머·게이트·실패 처리)를 가짜 시계로
  //                 여러 날 돌리는 행동 검증. 부품(refresh 기계)은 audit_cloud-oauth가 맡는다.
  { file: 'audit_keepalive.js' },

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
  { file: 'audit_local-transport.js' },
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
    // ★실패한 단언을 먼저 보여준다(v2.6.7). 꼬리 30줄만 찍던 때는 ✗ 줄이 그보다 앞이면
    // 통과 목록만 남아 "무엇이 깨졌는지"를 다시 실행해야 알 수 있었다.
    const out = String(r.stdout || '').trim().split('\n');
    const marks = out.map((l, i) => [l, i]).filter(([l]) => /✗/.test(l));
    if (marks.length) {
      console.log('  ────── 실패한 단언 ──────');
      for (const [, i] of marks) for (const l of out.slice(i, i + 4)) console.log(`  ${l}`);
    }
    console.log('  ────── 실패 스위트 출력 꼬리 ──────');
    for (const l of out.slice(-30)) console.log(`  ${l}`);
    for (const l of String(r.stderr || '').trim().split('\n').slice(-10)) console.log(`  ${l}`);
  }
}
console.log(`\n총 ${SUITES.length}스위트 / 실패 ${failed} / ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed ? 1 : 0);
