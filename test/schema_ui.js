'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 설정 화면 재현기 (v2.4.5 재감사용)
//
// ★왜 만들었나
//   homebridge-config-ui-x는 **`layout`에 있는 필드만** 그리고, 각 항목의
//   `condition.functionBody`를 평가해 표시 여부를 정한다.
//   그래서 "스키마에 있으니 보이겠지"는 틀린 추론이다 — 이 프로젝트에서 실제로
//   oneOf만 고치고 titleMap을 안 고쳐 드롭다운이 안 바뀐 사고가 있었다.
//
//   이 파일은 그 렌더 규칙을 **그대로 재현해** "이 기기 종류를 고르면 화면에
//   무슨 필드가 뜨는가"를 기계적으로 계산한다. 스크린샷보다 정확하고 회귀로 남는다.
//
// 사용: node test/schema_ui.js            (계약 검사)
//       node test/schema_ui.js --list     (기기 종류별 표시 필드 전체 나열)
// ─────────────────────────────────────────────────────────────────────────────

const schemaFile = require('../config.schema.json');
const { COOL_MODE_COMMANDS } = require('../lib/shared');

const LIST = process.argv.includes('--list');
const SCHEMA = schemaFile.schema;
const LAYOUT = schemaFile.layout;
const DEVPROPS = SCHEMA.properties.devices.items.properties;

// config.schema.json이 선언한 기기 종류
const DEVICE_TYPES = (DEVPROPS.deviceType.oneOf || []).map((o) => o.enum[0]);

// ── layout 순회 ──────────────────────────────────────────────────────────────
// 항목은 문자열("devices[].name") 또는 객체({key, condition, items, titleMap...})
function evalCondition(cond, model) {
  if (!cond) return true;
  const body = typeof cond === 'string' ? `return (${cond});` : cond.functionBody;
  if (!body) return true;
  try {
    // eslint-disable-next-line no-new-func
    return !!new Function('model', 'arrayIndices', body)(model, [0]);
  } catch (e) {
    return { error: e.message };
  }
}

function keyOf(item) {
  const k = typeof item === 'string' ? item : item.key;
  if (!k) return null;
  return String(k).replace(/^devices\[\]\./, '');
}

/** 주어진 기기 설정에서 화면에 그려지는 필드 목록과, 조건 평가 오류를 돌려준다. */
function render(deviceModel) {
  const model = { devices: [deviceModel] };
  const shown = [];
  const errors = [];
  const titleMaps = new Map();

  const walk = (items, inheritedOk) => {
    for (const item of items || []) {
      const cond = typeof item === 'object' ? item.condition : null;
      const ok = evalCondition(cond, model);
      if (ok && ok.error) { errors.push({ key: keyOf(item), error: ok.error }); continue; }
      const visible = inheritedOk && ok;
      if (typeof item === 'object' && item.items) { walk(item.items, visible); continue; }
      const k = keyOf(item);
      if (!k) continue;                               // help 블록 등
      if (typeof item === 'object' && item.titleMap) titleMaps.set(k, item.titleMap);
      if (visible) shown.push(k);
    }
  };

  // 기기 필드는 tabarray 안에만 있다
  const tab = LAYOUT.find((i) => typeof i === 'object' && i.key === 'devices');
  walk(tab ? tab.items : [], true);
  return { shown, errors, titleMaps };
}

// 기기 종류별 대표 모델.
// ★하위 옵션은 상위 토글이 켜져 있어야 화면에 나타난다(예: 세탁조 이름은 '분리'를 켜야 보임).
//   토글을 끈 모델로만 검사하면 "UI에 없는 옵션"이라고 **잘못** 판정한다 — 실제로 한 번 그랬다.
const MODEL = (deviceType) => ({
  deviceType, name: 'x', deviceLabel: 'x', ip: '1.2.3.4', token: 'x'.repeat(10),
  transport: 'local', local: { host: '1.2.3.4' },
  enableNotificationSensor: true, splitCompartments: true,
});

// 의도적으로 화면에 두지 않는 속성 — 이유가 있어야 목록에 넣는다.
const INTENTIONALLY_HIDDEN = {
  timeout: 'UI는 초 단위(timeoutSec)만 보여주고 index.js가 ms로 환산한다',
  cacheDuration: 'UI는 cacheDurationSec만 보여준다',
  legacyOnGuardMs: 'UI는 legacyOnGuardSec만 보여준다',
  powerOnResendStepMs: 'UI는 powerOnResendStepSec만 보여준다',
  certPath: '전문가용 탈출구 — 기본값(동봉 인증서)으로 충분하고 README에 설명',
  keyPath: '전문가용 탈출구 — 위와 동일',
};

// ── 어떤 필드가 '에어컨 전용'인가: 코드에서 실제로 읽는 곳으로 판정 ──────────────
const AC_ONLY = [
  'minTemp', 'maxTemp', 'hkCoolMode', 'legacySwingBinding', 'legacyLockBinding',
  'legacyOnGuardStrategy', 'legacyOnGuardSec', 'resendModeOnPowerOn',
  'resendAutoCleanOnPowerOn', 'resendSwingOffOnPowerOn', 'powerOnResendStepSec',
  'hideSwingToggle', 'hideLockToggle', 'coolModeCommand', 'swingBinding',
  'lockBinding', 'exposeWindFreeSwitch', 'exposeAutoCleanSwitch',
];
const LAUNDRY_TYPES = ['washer', 'dryer'];

// ─────────────────────────────────────────────────────────────────────────────
const results = new Map();
for (const t of DEVICE_TYPES) results.set(t, render(MODEL(t)));

if (LIST) {
  for (const [t, r] of results) {
    console.log(`\n=== ${t} — 화면에 뜨는 필드 ${r.shown.length}개 ===`);
    console.log('  ' + r.shown.join(', '));
    if (r.errors.length) console.log('  ⚠️조건 평가 오류:', JSON.stringify(r.errors));
  }
  console.log('\n=== 어느 기기에서도 안 뜨는 스키마 속성 ===');
  const everShown = new Set([...results.values()].flatMap((r) => r.shown));
  const never = Object.keys(DEVPROPS).filter((k) => !everShown.has(k));
  console.log('  ' + (never.join(', ') || '없음'));
  console.log('\n=== layout에 있는데 스키마에 없는 키 ===');
  const orphan = [...everShown].filter((k) => !DEVPROPS[k]);
  console.log('  ' + (orphan.join(', ') || '없음'));
  process.exit(0);
}

// ── 계약 검사 ────────────────────────────────────────────────────────────────
console.log('설정 화면 재현 — homebridge-config-ui-x 렌더 규칙 그대로\n');
const fail = [];
const check = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) fail.push(msg); };

console.log(`선언된 기기 종류: ${DEVICE_TYPES.join(', ')}\n`);

// ① 조건식이 실행 가능해야 한다 (오타 나면 필드가 통째로 사라진다)
const condErrors = [...results.values()].flatMap((r) => r.errors);
check(condErrors.length === 0, `layout 조건식 실행 오류 0건 (실측 ${condErrors.length}건)`);
condErrors.forEach((e) => console.log(`       ↳ ${e.key}: ${e.error}`));

// ② 세탁기/건조기 화면에 에어컨 전용 필드가 뜨면 안 된다
for (const t of LAUNDRY_TYPES) {
  const r = results.get(t);
  if (!r) continue;
  const leaked = r.shown.filter((k) => AC_ONLY.includes(k));
  check(leaked.length === 0, `${t} 화면에 에어컨 전용 필드 없음 (실측 ${leaked.length}개${leaked.length ? ': ' + leaked.join(', ') : ''})`);
}

// ③ 모든 oneOf(드롭다운)는 **화면에 글자를 낼 수단**을 가져야 한다.
//    layout에 titleMap이 있거나, 없으면 스키마 oneOf의 모든 항목에 title이 있어야 한다.
//    (layout 항목이 문자열이면 스키마 oneOf의 title로 렌더된다 — deviceType이 그 경우다.)
const allTitleMaps = new Map();
for (const r of results.values()) for (const [k, v] of r.titleMaps) allTitleMaps.set(k, v);
const dropdowns = Object.keys(DEVPROPS).filter((k) => Array.isArray(DEVPROPS[k].oneOf));
const noLabel = dropdowns.filter((k) => !allTitleMaps.has(k)
  && !DEVPROPS[k].oneOf.every((o) => o.title));
check(noLabel.length === 0, `드롭다운 ${dropdowns.length}개가 모두 표시 이름 보유 (누락 ${noLabel.length}${noLabel.length ? ': ' + noLabel.join(', ') : ''})`);

// ④ titleMap과 oneOf의 항목 집합이 일치해야 한다
const mismatched = [];
for (const k of dropdowns) {
  const tm = allTitleMaps.get(k);
  if (!tm) continue;
  const a = DEVPROPS[k].oneOf.map((o) => String(o.enum[0])).sort();
  const b = tm.map((o) => String(o.value)).sort();
  if (a.join('|') !== b.join('|')) mismatched.push(`${k}(스키마 ${a.length}개 vs 화면 ${b.length}개)`);
}
check(mismatched.length === 0, `드롭다운 항목 집합 일치 (불일치 ${mismatched.length}${mismatched.length ? ': ' + mismatched.join(', ') : ''})`);

// ⑤ layout에 있는데 스키마에 없는 키 = 저장은 되는데 검증이 없는 유령 필드
//    ★`local.host`처럼 중첩 키가 있으므로 점 경로를 스키마에서 따라가며 판정한다.
const everShown = new Set([...results.values()].flatMap((r) => r.shown));
const resolve = (dotted) => dotted.split('.').reduce(
  (node, part) => (node && node.properties ? node.properties[part] : undefined),
  { properties: DEVPROPS },
);
const orphan = [...everShown].filter((k) => !resolve(k));
check(orphan.length === 0, `layout↔schema 고아 키 없음 (실측 ${orphan.length}${orphan.length ? ': ' + orphan.join(', ') : ''})`);

// ⑥ 어느 화면에도 안 뜨는 스키마 속성 = 사용자가 UI로 켤 수 없는 옵션
//    ★중첩 객체(`local`)는 자식이 하나라도 화면에 뜨면 설정 가능한 것으로 본다.
const shownTop = new Set([...everShown].map((k) => k.split('.')[0]));
const never = Object.keys(DEVPROPS).filter((k) => !shownTop.has(k) && !INTENTIONALLY_HIDDEN[k]);
check(never.length === 0, `UI로 설정 불가능한 스키마 속성 없음 (실측 ${never.length}${never.length ? ': ' + never.join(', ') : ''})`);

// ⑦ 냉방 모드 선택지는 코드(lib/shared.js)와 **글자 하나까지** 같아야 한다.
//    어긋나면 사용자가 고른 모드가 말없이 다른 모드로 바뀐다(감사 S-1의 실제 증상).
const codeList = [...COOL_MODE_COMMANDS].sort().join('|');
const schemaList = (DEVPROPS.coolModeCommand.oneOf || []).map((o) => o.enum[0]).sort().join('|');
const uiList = (allTitleMaps.get('coolModeCommand') || []).map((o) => o.value).sort().join('|');
check(codeList === schemaList, `냉방 모드: 코드 ↔ 스키마 일치 (코드 ${codeList} / 스키마 ${schemaList})`);
check(codeList === uiList, `냉방 모드: 코드 ↔ 화면 titleMap 일치 (화면 ${uiList})`);

console.log(fail.length ? `\n❌ ${fail.length}건 실패` : '\n✅ 전부 통과');
process.exit(fail.length ? 1 : 0);
