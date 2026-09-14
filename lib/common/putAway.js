'use strict';

/**
 * putAway.js — 「임시 연결해제」 공통 판정 (v2.15.0, 2026-09-14)
 *
 * 왜 있는가: 계절용 기기(에어컨·선풍기)를 전원까지 뽑아 두면 플러그인이 계속 두드리다
 *   실패하고, 그 실패 로그를 NAS 감시기(hb_watch)가 경보로 올린다. 감시기 쪽
 *   무시 목록으로 막으면 **전량 검사가 깨진다**(예외 목록이 곧 사각) — 그래서 원천에서 끊는다.
 *
 * ⛔이것은 availability 가 아니다 — 「기기가 죽었다」는 판정이 아니라 **사람이 선언한 제외**다.
 * ⛔액세서리는 지우지 않는다 — 홈킷 방 배치·장면이 사라진다(안 C 기각).
 * ⚠️★로그는 단답형이다(Km81 님 지시). 서술형으로 되돌리지 말 것 —
 *   「재시작해야 적용된다」 같은 설명은 README 와 HANDOFF 에만 둔다.
 * ⚠️문구를 고칠 때는 test/put_away.js 의 감시 어휘 목록을 반드시 함께 볼 것
 *   (감시기가 읽는 27종이 한 조각이라도 섞이면 **감시에서 빼려던 기능이 감시를 깨운다**).
 * ★키 이름은 xiaomi 플러그인과 같은 `putAway` — 설정 어휘를 두 벌로 만들지 않는다.
 */

// ⚠️엄격히 true 만 참으로 본다 — 문자열 'true' 나 1 은 거짓이다(fail-safe).
//   설정이 이상하면 「연결해제」가 아니라 **「평소대로 감시」 쪽으로 넘어져야** 한다.
function isPutAway(configDevice) {
  return !!configDevice && configDevice.putAway === true;
}

const PUT_AWAY_MESSAGE = '임시 연결해제 — 통신 안 함';

module.exports = { isPutAway, PUT_AWAY_MESSAGE };
