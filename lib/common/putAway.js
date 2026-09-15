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
 * 왜 이 방법인가 — hap-nodejs 2.2.2 `Characteristic.js` 를 실행하고 읽어 확인한 것:
 *   ① 읽기 처리기가 **하나도 없으면**(`onGet` 도, 옛 `on('get')` 리스너도) HAP 은 그 특성의
 *      **현재 값으로 답한다.** 그 값은 홈브릿지가 `cachedAccessories` 에서 **복원한 마지막 상태**다
 *      (실측: 거실 에어컨의 `Active=0 · 현재온도 26 · 냉방설정 24` 가 디스크에 있었다).
 *      ⇒ ★**우리가 상태를 따로 저장할 필요가 없다.**
 *   ② 처리기가 없는 특성은 오류 표식(hap 필드 이름 **`statusCode`**)이 남아 있으면 그것을 던진다.
 *      `updateValue(값)` 이 `statusCode` 를 0 으로 되돌린다 — 그래서 봉한 뒤 한 번 부른다.
 *   ③ ⛔★★**`removeOnGet()`·`removeOnSet()` 은 옛 방식 `char.on('get'/'set')` 리스너를 지우지 않는다.**
 *      hap 은 새 처리기가 없고 옛 리스너가 있으면 **그 리스너를 그대로 부른다**(`:1728`).
 *      2.4.0/2.16.0 은 이것을 몰라 **SmartAC·세탁기·건조기에서 봉인이 아무것도 안 했다** —
 *      탭하면 실제로 `setPower` 가 나갔다(2026-09-15 적대 리뷰 3기 독립 발견 · 실측).
 *      ⇒ 두 방식을 **모두** 뗀다: `removeOnGet/removeOnSet` + `removeAllListeners('get'/'set')`.
 *   ④ 쓰기 처리기가 없으면 쓰기는 **지역 값만 바꾸고 성공**한다 — 통신은 0 이지만
 *      **바뀐 값이 캐시에 저장돼 재시작 뒤 「마지막 상태」가 거짓이 된다**(리뷰 B 직렬화 왕복 실측).
 *      ⇒ 그래서 떼기만 하지 않고, **봉한 순간의 값으로 되돌리는 쓰기 처리기**를 단다.
 *      hap 은 처리기가 끝난 **뒤에** 새 값을 대입하므로 `setImmediate` 로 한 박자 늦게 되돌린다.
 *      (처리기가 던지면 `statusCode` 가 남아 「응답 없음」이 되므로 던지지 않는다.)
 *
 * ⛔「기기 정보」 서비스(AccessoryInformation)는 건드리지 않는다 — hap 이 식별(Identify)을
 *   옛 방식 리스너로 직접 묶어 두었다. 떼면 페어링 화면의 「식별」이 죽는다.
 * ⛔서비스·특성을 지우지 않는다 — 홈킷 방 배치·장면이 사라진다.
 * ⚠️체크를 풀고 재시작하면 처리기가 새로 등록되므로 되돌릴 것이 없다.
 * ⚠️이 함수는 **서비스를 다 만든 뒤에** 불러야 한다 — 먼저 부르면 뗄 것이 없다.
 * ⚠️★**그 기기가 만든 액세서리 전부**를 넘길 것(별도 스위치·보조 세탁조·종료알림 센서·자식 타일).
 *   하나만 넘기면 나머지 타일은 여전히 통신한다 — 배열을 받는 이유다.
 *
 * @param {object|object[]} target 액세서리 하나 또는 배열
 * @returns {number} **실제로 떼어 낸 처리기·리스너 수**. 0 이면 봉인이 아무 일도 안 한 것이다
 *   (훑은 특성 수를 돌려주던 2.4.0/2.16.0 의 반환값은 성공 근거가 못 됐다).
 */
const ACCESSORY_INFORMATION_UUID = '0000003E-0000-1000-8000-0026BB765291';

function sealCharacteristic(ch) {
  let removed = 0;
  if (typeof ch.getHandler === 'function') removed += 1;
  if (typeof ch.setHandler === 'function') removed += 1;
  if (typeof ch.removeOnGet === 'function') ch.removeOnGet();
  if (typeof ch.removeOnSet === 'function') ch.removeOnSet();
  if (typeof ch.removeAllListeners === 'function') {
    for (const ev of ['get', 'set']) {
      const n = typeof ch.listenerCount === 'function' ? ch.listenerCount(ev) : 0;
      if (n > 0) { ch.removeAllListeners(ev); removed += n; }
    }
  }
  // 값이 없는 특성(쓰기 전용 등)은 되돌릴 값도 없다 — updateValue 는 경고를 낸다.
  if (ch.value === null || ch.value === undefined) return removed;
  const sealed = ch.value;
  if (typeof ch.updateValue === 'function') ch.updateValue(sealed);   // ② statusCode → 0
  // 쓰기 권한(pw)이 없는 특성(현재 온도 등)은 홈 앱이 쓰지 못하므로 처리기를 달지 않는다.
  const perms = ch.props && ch.props.perms;
  const writable = !Array.isArray(perms) || perms.includes('pw');
  if (writable && typeof ch.onSet === 'function') {
    ch.onSet(() => {
      // ④ ⚠️탭 시점의 값이 아니라 **봉한 순간의 값**으로 되돌린다 — 연타하면 탭 시점 값은
      //   이미 앞 탭이 바꾼 값이라, 그걸 기준으로 삼으면 거짓 값이 눌러앉는다.
      setImmediate(() => { try { ch.updateValue(sealed); } catch (e) { /* 표시 문제 — 무시 */ } });
    });
  }
  return removed;
}

function sealForPutAway(target) {
  const list = Array.isArray(target) ? target : [target];
  const seen = new Set();
  let removed = 0;
  for (const acc of list) {
    if (!acc || seen.has(acc) || !Array.isArray(acc.services)) continue;
    seen.add(acc);
    for (const svc of acc.services) {
      if (!svc || svc.UUID === ACCESSORY_INFORMATION_UUID) continue;
      for (const ch of (svc.characteristics || [])) {
        try { removed += sealCharacteristic(ch); }
        catch (e) { /* 한 특성이 실패해도 나머지는 계속 — 표시 문제로 기동을 막지 않는다 */ }
      }
    }
  }
  return removed;
}

/**
 * 봉인이 아무것도 떼지 못했을 때 남기는 줄 — ⛔감시 어휘 금지(회귀가 검사한다).
 * 0 이면 「타일을 누르면 명령이 나갈 수 있다」는 뜻이라 조용히 넘기면 안 된다.
 */
const PUT_AWAY_SEAL_EMPTY = '임시 연결해제 — 타일 봉인 0건';

/**
 * ★「임시 연결해제」 기기에 쥐여 주는 **통신 거부 클라이언트**(v2.16.1, 2026-09-15).
 *
 * 왜: 2.16.0 은 통신을 「안 부르는 것」으로만 막았다. 그런데 부르는 곳이 어디 하나라도 남으면
 *   (옛 리스너·명령 뒤 재확인·앞으로 생길 경로) 그대로 기기·클라우드로 나간다 — 실제로
 *   SmartAC 타일 탭이 `setPower` 를 보냈다. 그래서 **보낼 수단 자체를 주지 않는다**.
 *   ⇒ 플랫폼이 이 기기를 로컬 브릿지·8888 클라이언트에 **등록하지도 않는다**
 *   (`로컬 경로 등록` 로그·일일 요약 타이머도 함께 사라진다).
 *
 * 모든 메서드가 「거부된 Promise」를 돌려준다(⚠️거부는 미리 처리 표시 — 아무도 await 하지 않아도
 *   Node 가 「처리되지 않은 거부」로 프로세스를 죽이지 않게). `then` 은 없다(Promise 로 오인 방지).
 * `__calls` 로 불린 메서드 이름을 볼 수 있다 — 회귀가 「0회」를 잰다.
 */
function makePutAwayClient() {
  const calls = [];
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === '__calls') return calls;
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return () => {
        calls.push(String(prop));
        const p = Promise.reject(new Error(PUT_AWAY_MESSAGE));
        p.catch(() => {});
        return p;
      };
    },
  });
}

module.exports = { isPutAway, PUT_AWAY_MESSAGE, PUT_AWAY_SEAL_EMPTY, sealForPutAway, makePutAwayClient };
