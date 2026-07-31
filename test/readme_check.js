'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// README ↔ 코드 기계 대조기
//
// ★왜 만들었나
//   README를 코드 확인 없이 "기억으로" 쓴 탓에 OAuth 스코프 개수·리디렉션 형식이
//   틀린 채 배포된 적이 있다. 그리고 v2.4.5 감사에서 또 드러났다 —
//   설정 화면에는 `장치 이름`이라고 쓰여 있는데 README는 `기기 이름`이라고 불렀고,
//   초심자는 화면에서 그 항목을 못 찾는다.
//
//   문서가 코드보다 먼저 낡는 것은 막을 수 없다. 대신 **낡으면 테스트가 깨지게** 한다.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const SCHEMA = require('../config.schema.json');
const { COOL_MODE_COMMANDS } = require('../lib/shared');

// 소스 전체를 한 덩어리로 (로그 문구 존재 확인용)
const SRC = ['index.js', 'lib/accessories/Laundry.js', 'lib/accessories/LegacyAC.js',
  'lib/accessories/SmartAC.js', 'lib/api/LegacyACClient.js', 'lib/api/LegacyLaundryClient.js',
  'lib/api/LocalApplianceClient.js', 'lib/api/SmartThingsClient.js', 'lib/auth/OAuthServer.js',
  'lib/local/bridge.py', 'lib/mqtt/MqttBridge.js', 'lib/mqtt/attach.js']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

const fail = [];
const check = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) fail.push(msg); };

console.log('README ↔ 코드 대조\n');

// ── ① README가 인용한 로그 문구가 실제로 코드에 있는가 ────────────────────────
// 표 안의 백틱 인용구 중 한글이 들어간 것을 로그 문구 후보로 본다.
// ★백틱을 정규식으로 짝지으면 한 줄에 인용구가 둘 있을 때 **그 사이의 평범한 문장**까지
//   인용구로 잡는다(실제로 오탐이 났다). 코드펜스를 먼저 걷어내고 백틱으로 쪼개
//   홀수 번째 조각만 취하면 정확히 인용구만 남는다.
const noFence = README.replace(/```[\s\S]*?```/g, '\n');
const quoted = noFence.split('`').filter((_, i) => i % 2 === 1)
  .filter((q) => !q.includes('\n') && q.length >= 6 && q.length <= 80)
  .filter((q) => /[가-힣]/.test(q))
  // 설정 항목 이름은 ②에서 따로 확인하므로 제외
  .filter((q) => !/^\[?[가-힣A-Za-z ]*\]?\s*(장치|기기|전송|종료 알림|세탁조|로컬 실패|인증 토큰|에어컨 IP)/.test(q))
  // 표 구분자(|)가 섞여 들어온 것은 인용구가 아니라 마크다운 파편이다
  .filter((q) => !q.includes('|'));

// ★로그 문구에는 변수가 끼어 있다 — `[${this.label}] 포트 ${p}를 …` 같은 식이라
//   글자 그대로 비교하면 전부 "없음"이 된다. 그렇다고 비교를 포기하면 검사가 무의미하다.
//   그래서 **숫자·변수·따옴표를 뺀 한글 토막**들이 소스에 전부 있는지로 판정한다.
//   이러면 `기기 이름`을 `장치 이름`으로 잘못 쓴 것 같은 진짜 드리프트는 잡히고,
//   변수 자리 때문에 생기는 오탐은 사라진다.
const tokensOf = (s) => (s
  .replace(/\$\{[^}]*\}/g, ' ')
  .replace(/[0-9'"`\[\]()—→·…]/g, ' ')
  .match(/[가-힣]{3,}/g) || []);
const srcTokens = new Set(tokensOf(SRC));
const missingLogs = quoted.filter((q) => {
  const ts = tokensOf(q);
  return ts.length > 0 && !ts.every((t) => srcTokens.has(t));
});
check(missingLogs.length === 0,
  `README가 인용한 로그 문구가 모두 코드에 존재 (없는 것 ${missingLogs.length}건)`);
missingLogs.forEach((q) => console.log(`       ↳ 코드에 없음: "${q}"`));

// ── ② README가 언급한 설정 항목 이름이 실제 화면 문구와 같은가 ────────────────
const titles = new Set();
const collect = (props) => {
  for (const k of Object.keys(props || {})) {
    if (props[k].title) titles.add(props[k].title);
    if (props[k].properties) collect(props[k].properties);
  }
};
collect(SCHEMA.schema.properties);
collect(SCHEMA.schema.properties.devices.items.properties);
// 접두 태그([구형 AC] 등)를 뗀 형태로도 찾을 수 있게 한다
const bare = new Set([...titles].map((t) => t.replace(/^\[[^\]]+\]\s*/, '')));

// README가 "설정 항목"으로 부르는 것들 (백틱 + 한글, 그리고 화면 문구처럼 생긴 것)
const FIELD_MENTIONS = [
  '장치 종류', '전송 경로', '기기 IP', '기기 토큰', '장치 이름',
  '종료 알림 센서 활성화', '세탁조를 따로 표시', '로컬 실패 시 클라우드 사용',
  '장치 인덱스 (읽기)', '장치 인덱스 (쓰기)',
  // MQTT 절 (2026-07-30 신설 — README가 화면 문구와 다르면 초심자가 그 항목을 못 찾는다)
  'MQTT 브리지 사용', '브로커 주소', '브로커 포트', '사용자 이름', '비밀번호',
  '기본 토픽', 'HA 자동 검색 접두어', '재발행 주기(초)',
];
const mentioned = FIELD_MENTIONS.filter((f) => README.includes(f));
const bogus = mentioned.filter((f) => !bare.has(f) && ![...bare].some((b) => b.startsWith(f)));
check(bogus.length === 0,
  `README가 부르는 설정 항목 이름이 화면 문구와 일치 (어긋남 ${bogus.length}건)`);
bogus.forEach((f) => console.log(`       ↳ 화면에 그런 항목 없음: "${f}"`));

// 실제로 한 번 틀렸던 이름들 — 되돌아오지 못하게 못 박는다.
const FORBIDDEN = {
  '`기기 이름`': '화면 문구는 `장치 이름`입니다',
  '`기기 ID`': '화면 문구는 `SmartThings deviceId`입니다',
  '`종료 알림 센서 사용`': '화면 문구는 `종료 알림 센서 활성화`입니다',
  '`장치 번호`': '그런 항목은 없습니다 — `장치 인덱스 (읽기)/(쓰기)`',
};
const used = Object.keys(FORBIDDEN).filter((f) => README.includes(f));
check(used.length === 0, `과거에 틀렸던 항목 이름을 다시 쓰지 않음 (발견 ${used.length}건)`);
used.forEach((f) => console.log(`       ↳ ${f} → ${FORBIDDEN[f]}`));

// ── ③ 숫자·상수 ──────────────────────────────────────────────────────────────
const OAuthServer = fs.readFileSync(path.join(ROOT, 'lib/auth/OAuthServer.js'), 'utf8');
// SCOPE는 공백으로 이어 붙인 문자열 하나다 (배열이 아니다).
const scopeLine = (OAuthServer.match(/SCOPE\s*=\s*['"`]([^'"`]*)['"`]/) || [])[1] || '';
const scopeCount = (scopeLine.match(/[rwx]:devices/g) || []).length;
const readmeScopes = (README.match(/[rwx]:devices:\*/g) || []).length;
check(scopeCount > 0 && readmeScopes === scopeCount,
  `OAuth 권한 개수 일치 (코드 ${scopeCount}개 / README ${readmeScopes}개)`);

const oauthPort = (OAuthServer.match(/(?:PORT|port)\s*=\s*(\d{4})/) || [])[1];
check(!!oauthPort && README.includes(oauthPort), `인증 서버 포트 일치 (코드 ${oauthPort})`);

check(SRC.includes('8888') && README.includes('8888'), '구형 프로토콜 포트 8888 언급');
check(README.includes('8889'), '토큰 콜백 수신 포트 8889 언급');

// ── ④ 기기 종류가 전부 문서화돼 있는가 ────────────────────────────────────────
const KO = {
  legacyAc: '구형 에어컨', smartAc: '신형 에어컨', systemAc: '시스템 에어컨',
  washer: '세탁기', dryer: '건조기',
};
const types = SCHEMA.schema.properties.devices.items.properties.deviceType.oneOf.map((o) => o.enum[0]);
const undocumented = types.filter((t) => !README.includes(KO[t] || t));
check(undocumented.length === 0, `기기 종류 ${types.length}종이 모두 README에 설명됨 (누락 ${undocumented.length})`);

// ── ⑤ 냉방 모드 선택지를 README가 언급했다면 코드와 같아야 한다 ────────────────
// 두 개 이상 나열했다면 목록을 적은 것이므로 전부 있어야 한다(하나만 예시로 든 건 허용).
const modeMentions = COOL_MODE_COMMANDS.filter((m) => new RegExp(`\`${m}\``).test(README));
check(modeMentions.length < 2 || modeMentions.length === COOL_MODE_COMMANDS.length,
  `냉방 모드 목록을 적었다면 전부 적어야 한다 (README ${modeMentions.length}/${COOL_MODE_COMMANDS.length})`);

// ── ⑥ 죽은 링크(문서 내 앵커) ────────────────────────────────────────────────
const anchors = new Set([...README.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) =>
  '#' + m[1].trim().toLowerCase()
    .replace(/[^\w가-힣 -]/g, '')
    .replace(/ /g, '-')));
const links = [...README.matchAll(/\]\((#[^)]+)\)/g)].map((m) => m[1].toLowerCase());
const dead = links.filter((l) => !anchors.has(l));
check(dead.length === 0, `문서 내 링크가 모두 존재하는 절을 가리킴 (깨진 링크 ${dead.length})`);
dead.forEach((l) => console.log(`       ↳ 깨진 링크: ${l}`));

console.log(fail.length ? `\n❌ ${fail.length}건 실패` : '\n✅ 전부 통과');
process.exit(fail.length ? 1 : 0);
