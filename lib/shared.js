'use strict';

/**
 * SmartAC(클라우드)와 LegacyAC(로컬)가 공유하는 상수 — 단일 소스 (v1.8.28).
 *
 * 왜 분리했나: OFF_SCENE_SUPPRESS_MS는 두 클래스가 반드시 같은 값을 써야 하는데
 * (끄기 장면의 형제 write 억제 창 — 한쪽만 바꾸면 그 기기만 밤새 켜지는 실피해로 직결),
 * v1.8.26에서 2500→4000 상향 때 실제로 두 파일을 동시 수정해야 했다. 값 변경은 여기 한 곳에서만.
 */
const path = require('path');

module.exports = {
  // 끄기 장면 형제 write 억제 창. 실측: 장면 write는 off 후 ~1.2s 내 도착(온도는 400ms 디바운스
  // 추가), 4000ms = 홈허브 지연 꼬리 마진. ON 의도가 마커를 즉시 해제하므로 "끄고 바로 켜기"에는
  // 영향 없음.
  OFF_SCENE_SUPPRESS_MS: 4000,

  // 패키지에 동봉된 인증서(구형 8888 클라이언트 인증서 겸 DTLS용 CA). 같은 파일을
  // 여러 곳에서 제각각 계산하고 있었다(v2.4.5 감사) — 값 자체는 같았지만, 기본값이
  // 없는 호출자가 `fs.readFileSync(undefined)`로 즉사하는 계급이 생겼다.
  DEFAULT_CERT_PATH: path.join(__dirname, '..', 'cert', 'cert.pem'),

  // 연결 계열(=기기에 못 닿음) 오류 판별. 층마다 정규식이 조금씩 달라
  // 같은 오류가 계층별로 다르게 분류되던 것을 세탁기 경로에서만이라도 한 곳으로 모은다.
  // ⚠️구형 에어컨의 재시도 조건(LegacyACClient._requestWithRetry)은 통신 동작에
  //    직접 영향을 주므로 **의도적으로 건드리지 않는다** — 이 상수는 세탁기 계열 전용.
  // 홈킷 '냉방' 버튼이 신형 에어컨에 실제로 보낼 수 있는 모드 — **단일 정의**.
  //
  // ★목록의 근거: 신형 AC가 스스로 보고하는 `supportedAcModes`가 이 넷이다(실측).
  //   청정 계열(coolClean·dryClean)은 **구형 2in1 전용**이라 여기에 넣으면
  //   "기기에 없는 걸 고르게" 만든다 — 사용자가 직접 지적해 확정된 결정이다.
  //
  // ★v2.4.5 감사 S-1: 설정 화면은 이 넷을 제시하는데 코드(SmartAC)는 엉뚱하게
  //   `cool/coolClean/dry/dryClean`만 허용하고 있었다. 그래서 "송풍"이나 "AI 쾌적"을
  //   고르면 **경고 한 줄 없이 냉방으로 바뀌었다.** 목록이 두 곳에 있으면 또 어긋난다.
  //   → 여기 하나만 두고, config.schema.json과 코드가 같이 참조한다.
  //     (test/schema_ui.js가 셋의 일치를 매번 확인한다.)
  COOL_MODE_COMMANDS: ['cool', 'dry', 'fan', 'aIComfort'],

  // 구형 에어컨(8888)이 받는 모드. 실기기 2대가 스스로 보고한 목록과 같다
  // (2026-07-30 상태 덤프: Mode.supportedModes = Cool·Dry·Wind·CoolClean·DryClean·Auto).
  // ⚠️모델마다 다를 수 있어, 기기가 목록을 알려주면 LegacyAC가 그것으로 다시 확인한다.
  // 신형과 달리 여기 값은 **기기가 쓰는 문자열 그대로**다(대소문자 포함).
  LEGACY_COOL_MODES: ['Cool', 'CoolClean', 'Dry', 'DryClean', 'Wind', 'Auto'],

  CONNECTION_ERROR_RE:
    /timeout|시간 초과|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|ENOTFOUND|EPIPE|소켓/i,
};
