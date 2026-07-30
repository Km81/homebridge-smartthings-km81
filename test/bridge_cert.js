'use strict';
/**
 * bridge_cert.js — 파이썬 브릿지 인증서 발급 계약의 실행기 (v2.6.7 신설)
 *
 * 본체는 test/bridge_cert.py. 여기서는 파이썬을 찾아 실행하고, 없으면 **건너뛰되
 * 조용히 넘어가지 않는다** — 계약이 안 돌았다는 사실 자체가 출력에 남아야 한다.
 * (파이썬·cryptography는 로컬 제어를 쓰는 사용자에게만 필요한 선택 의존성이라
 *  CI/개발기에 없을 수 있다.)
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'bridge_cert.py');

const probe = (bin) => {
  const r = spawnSync(bin, ['-c', 'import cryptography'], { stdio: 'ignore' });
  return r.status === 0;
};

const bin = ['python3', 'python', 'py'].find(probe);

if (!bin) {
  console.log('\n[로컬 브릿지 인증서 발급 계약]');
  console.log('  — 건너뜀: cryptography가 있는 파이썬을 찾지 못했습니다.');
  console.log('    (이 계약은 첫 설치 경로만 검증합니다. 확인하려면:'
    + ' pip install cryptography 후 다시 실행)');
  process.exit(0);
}

// 윈도우 콘솔은 기본이 cp949라 한글 로그에서 파이썬이 죽는다(실행환경 문제).
// 홈브릿지가 도는 리눅스는 UTF-8이므로, 여기서만 맞춰 준다.
const r = spawnSync(bin, [SCRIPT], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
});
process.exit(r.status === null ? 1 : r.status);
