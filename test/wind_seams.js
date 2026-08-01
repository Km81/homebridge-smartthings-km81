'use strict';

/**
 * 바람방향 **접합부** 회귀 (v2.10.1).
 *
 * ★왜 따로 있나: `test/wind_direction.js`는 `_setWindDirection`·`_resolveSwingDirection`을
 * **고립 단위**로만 쟀다. 그래서 적대 리뷰가 찾은 결함 8건 중 **하나도 못 잡았다** —
 * 전부 접합부(폴 라운드, 무풍과의 공유, MQTT 중계, 클라우드 클라이언트)에 있었다.
 *
 * 여기서는 **여러 부품이 만나는 지점**을 밟는다.
 */

const assert = require('assert');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

const SmartAC = require('../lib/accessories/SmartAC');

/** 홈킷 특성 스텁 — 마지막으로 밀어 넣은 값을 기억한다. */
function mkService(name, chars) {
  const values = {};
  const svc = {
    displayName: name,
    testCharacteristic: (c) => chars.includes(c),
    updateCharacteristic: (c, v) => { values[c] = v; return svc; },
    getCharacteristic: () => ({ setValue: () => {}, onGet: () => ({ onSet: () => {} }) }),
    value: (c) => values[c],
    touched: (c) => Object.prototype.hasOwnProperty.call(values, c),
  };
  return svc;
}

/** SmartAC 인스턴스를 프로토타입으로 만든다(무거운 configure 없이 접합부만 밟기 위해). */
function mkLogic({ binding, supported = ['Fix', 'Left_And_Right'], current = 'Fix' }) {
  const C = { SwingMode: 'SwingMode', On: 'On' };
  const lines = [];
  const sent = [];
  const o = Object.create(SmartAC.prototype);
  o.Characteristic = C;
  o.log = { warn: (m) => lines.push(`warn|${m}`), info: () => {}, debug: () => {} };
  o._label = '기기';
  o._state = {};
  o._offIntentTs = 0;
  o._swingBinding = binding;
  o._resyncTimers = new Map();
  o._stateSeq = new Map();
  o._warnedWindDir = false;
  o._warnedNoRotate = false;
  o._mainService = mkService('main', [C.SwingMode]);
  o._linkedSwitchServices = { windFree: null, autoClean: null };
  o._scheduleResync = (key, read, push) => { o._resyncCalls = (o._resyncCalls || 0) + 1; };
  o.smartthings = {
    getSupportedWindDirections: async () => supported,
    getWindDirection: async () => current,
    setWindDirection: async (_id, m) => { sent.push(m); },
    getWindFree: async () => false,
    setWindFree: async () => {},
  };
  return { o, C, lines, sent };
}

(async () => {
  // ── ① ★미지원 방향 차단은 **매번** 해야 한다 (적대 리뷰 M3)
  //    v2.10.0은 경고 플래그가 검사 자체를 감싸고 있어 **두 번째부터 그냥 나갔다.**
  //    그때 테스트는 '로그 줄 수'만 봐서 이 결함을 가렸다.
  {
    const { o, sent, lines } = mkLogic({ binding: 'Up_And_Low' });
    await o._setWindDirection('D', 'Up_And_Low');
    o._state.windDirection = undefined;              // 멱등 생략을 피해 두 번째 시도
    await o._setWindDirection('D', 'Up_And_Low');
    check(sent.length === 0,
      '★지원하지 않는 방향은 **두 번째 시도에서도** 나가지 않는다 (경고 1회와 차단은 별개다)');
    check(lines.filter((l) => /지원하지 않습니다/.test(l)).length === 1, '경고는 한 번만 낸다');
  }

  // ── ② ★차단했으면 홈킷 토글을 되돌린다 (적대 리뷰 M4)
  {
    const { o } = mkLogic({ binding: 'Up_And_Low' });
    await o._setWindDirection('D', 'Up_And_Low');
    check((o._resyncCalls || 0) > 0,
      '★아무것도 안 보냈으면 표시를 실제 상태로 되돌린다 (안 그러면 켜짐으로 영구 잔류)');
  }

  // ── ③ ★무풍이 방향 스윙 표시를 덮지 않는다 (적대 리뷰 M2)
  {
    const { o, C } = mkLogic({ binding: 'Left_And_Right' });
    o._state.windFree = undefined;
    await o._setWindFree('D', true, null);
    check(!o._mainService.touched(C.SwingMode),
      '★스윙이 바람방향에 묶였으면 무풍 setter가 SwingMode를 건드리지 않는다');
  }
  {
    // 대조군 — 무풍 바인딩이면 예전처럼 밀어야 한다
    const { o, C } = mkLogic({ binding: 'windFree' });
    o._state.windFree = undefined;
    await o._setWindFree('D', true, null);
    check(o._mainService.value(C.SwingMode) === 1,
      '무풍 바인딩에서는 예전 그대로 SwingMode를 민다 (회귀 아님)');
  }

  // ── ④ ★스윙 회전 불가 경고와 미지원 방향 경고는 서로를 침묵시키지 않는다 (L4)
  {
    const { o, lines } = mkLogic({ binding: 'rotate', supported: ['Fix'] });
    await o._resolveSwingDirection('D');                 // 회전 불가 경고
    o._state.windDirection = undefined;
    await o._setWindDirection('D', 'All');                // 미지원 방향 경고
    check(lines.filter((l) => /회전할 수 있는/.test(l)).length === 1, '회전 불가를 알린다');
    check(lines.filter((l) => /지원하지 않습니다/.test(l)).length === 1,
      '★미지원 방향도 따로 알린다 (플래그를 공유하면 하나가 다른 하나를 삼킨다)');
  }

  // ── ⑤ ★클라우드 클라이언트에는 바람방향 메서드가 없다 (적대 리뷰 H3)
  {
    const cloudSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'api', 'SmartThingsClient.js'), 'utf8');
    const hasAny = /getWindDirection|setWindDirection|getSupportedWindDirections/.test(cloudSrc);
    const acSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'accessories', 'SmartAC.js'), 'utf8');
    check(!hasAny, '클라우드 클라이언트에는 바람방향 메서드가 없다 (사실 확인)');
    check(/typeof this\.smartthings\?\.getWindDirection === 'function'/.test(acSrc),
      '★그래서 액세서리가 **클라이언트 능력**으로 판정한다 (설정만 믿으면 TypeError로 폴이 죽는다)');
    check(/스윙 토글을 만들지 않습니다/.test(acSrc), '못 쓰면 토글을 만들지 않고 이유를 알린다');
  }

  // ── ⑥ ★폴 라운드가 바람방향 실패 하나로 죽지 않는다 (적대 리뷰 H2)
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'accessories', 'SmartAC.js'), 'utf8');
    const seg = src.slice(src.indexOf('let windDir;'), src.indexOf('const autoClean = await'));
    check(/try\s*\{[\s\S]*getWindDirection[\s\S]*\}\s*catch/.test(seg),
      '★폴의 바람방향 조회는 try/catch로 감싼다 (표시용 보조값이 전원·온도를 데려가면 안 된다)');

    const client = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'api', 'LocalApplianceClient.js'), 'utf8');
    check(!/_noCloudWind/.test(client),
      '★항상 던지는 폴백 스텁을 두지 않는다 (그건 매 폴마다 실행되는 클라우드 호출로 취급된다)');
  }

  // ── ⑦ ★HA 무풍 스위치가 바람방향을 조작하지 않는다 (적대 리뷰 H1)
  {
    const attach = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'mqtt', 'attach.js'), 'utf8');
    check(/swingIsDirection/.test(attach),
      '★MQTT가 스윙 바인딩을 보고 무풍 폴백 여부를 정한다');
    check(/!swingIsDirection && has\(main, C\.SwingMode\)/.test(attach),
      '★방향에 묶였으면 메인 SwingMode를 무풍 대용으로 쓰지 않는다');
  }

  // ── ⑧ 기기가 목록을 안 알려줘도 매 폴마다 묻지 않는다 (적대 리뷰 M5)
  {
    let asked = 0;
    const o = Object.create(SmartAC.prototype);
    o.log = { warn: () => {}, info: () => {}, debug: () => {} };
    o._label = '기기';
    o._coolModeWarned = false;
    o.smartthings = { getSupportedModes: async () => { asked++; return []; } };
    await o._warnUnsupportedCoolMode('D', 'auto');
    await o._warnUnsupportedCoolMode('D', 'auto');
    await o._warnUnsupportedCoolMode('D', 'auto');
    check(asked === 1,
      '★목록을 안 알려주는 기기에도 한 번만 물어본다 (영원히 매 폴 조회하던 것)');
  }

  console.log(`\n[바람방향 접합부] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
