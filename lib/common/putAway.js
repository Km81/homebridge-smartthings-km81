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


/**
 * ★「임시 연결해제」 기기의 홈킷 타일을 **마지막 상태로 정상 표시**시킨다.
 *
 * Km81 님 지시(2026-09-14): *「난 정상연결로 최종 상태를 가져왔으면 해」*.
 * 그 전에는 기기마다 달랐다 — 선풍기는 「정상 연결 + 기본값」, 에어컨은 **「응답 없음」**.
 *
 * 왜 이 방법인가 — hap-nodejs 2.2.2 로 실행해 확인한 것:
 *   ① 게터(`onGet`)를 **등록하지 않으면** HAP 은 그 특성의 **현재 값으로 답한다.**
 *      그 값은 홈브릿지가 `cachedAccessories` 에서 **복원한 마지막 상태**다
 *      (실측: 거실 에어컨의 `Active=0 · 현재온도 26 · 냉방설정 24` 가 디스크에 있었다).
 *      ⇒ ★**우리가 상태를 따로 저장할 필요가 없다.**
 *   ② 게터가 한 번이라도 던지면 특성에 `status` 가 **눌러붙어 그 뒤로 계속 거부**된다.
 *      그것이 에어컨의 「응답 없음」이었다. ⛔`ch.status = null` **대입으로는 안 지워진다** —
 *      **`updateValue(ch.value)` 로만** 지워진다(실측).
 *   ③ `onSet` 이 없으면 쓰기는 **지역 값만 바꾸고 통과**한다(통신 0 · 오류 0).
 *      던지지 않으니 ②의 눌러붙음도 안 생긴다. ⇒ 그래서 게터만 떼면 안 되고 **둘 다** 뗀다.
 *
 * ⛔서비스·특성을 지우지 않는다 — 홈킷 방 배치·장면이 사라진다.
 * ⚠️체크를 풀고 재시작하면 게터가 정상 등록되므로 되돌릴 것이 없다.
 * ⚠️이 함수는 **서비스를 다 만든 뒤에** 불러야 한다 — 먼저 부르면 뗄 것이 없다(회귀가 검사한다).
 */
function sealForPutAway(accessory) {
  if (!accessory || !Array.isArray(accessory.services)) return 0;
  let n = 0;
  for (const svc of accessory.services) {
    const chars = (svc && svc.characteristics) || [];
    for (const ch of chars) {
      try {
        if (typeof ch.removeOnGet === 'function') ch.removeOnGet();
        if (typeof ch.removeOnSet === 'function') ch.removeOnSet();
        // ★눌러붙은 status 를 지운다. 값이 없는 특성은 건드리지 않는다(경고가 난다).
        if (ch.value !== null && ch.value !== undefined && typeof ch.updateValue === 'function') {
          ch.updateValue(ch.value);
        }
        n += 1;
      } catch (e) { /* 한 특성이 실패해도 나머지는 계속 — 표시 문제로 기동을 막지 않는다 */ }
    }
  }
  return n;
}

module.exports = { isPutAway, PUT_AWAY_MESSAGE, sealForPutAway };
