'use strict';

// MQTT 브리지 검증 (v2.5.0)
//
// 이 스위트가 지키려는 것 — 전부 "틀리면 실제로 아픈" 계약이다.
//  ① 꺼져 있으면 아무 것도 하지 않는다(기본값). 브로커가 없어도 홈킷은 무영향.
//  ② 브로커 연결 전에 등록해도 검색·상태가 유실되지 않는다(연결 시 일괄 재발행).
//  ③ ★availability 토픽은 브리지 하나뿐이다 — 세탁기 전원 꺼짐이 unavailable로
//     새지 않아야 한다(요청서 §4-2 의미론). 꺼짐은 상태값으로만 표현된다.
//  ④ 명령은 HomeKit 특성 setValue로 흘러 액세서리의 안전 로직을 탄다(직접 전송 금지).
//  ⑤ 로그 문구가 NAS hb-watch 경보 정규식과 겹치지 않는다(중계 문제로 기기 장애 오탐 금지).
//  ⑥ 상태가 안 바뀌면 재발행하지 않는다(브로커·HA 부하).

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const MqttBridge = require('../lib/mqtt/MqttBridge');
const { attachSmartAc, attachLaundry } = require('../lib/mqtt/attach');

let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${msg}${detail ? ' (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ❌ ${msg}${detail ? ' (' + detail + ')' : ''}`); }
};

const mkLog = () => {
  const lines = [];
  const rec = lvl => (...a) => lines.push(`${lvl}|${a.join(' ')}`);
  return { lines, info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
};

// ── 가짜 MQTT 클라이언트 ────────────────────────────────────────────────────
// 실제 브로커 없이 발행·구독·연결 시점을 관측한다.
class FakeClient {
  constructor(opts) {
    this.opts = opts;
    this.published = [];
    this.subscribed = [];
    this._handlers = {};
    this.ended = false;
  }
  on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this; }
  emit(ev, ...a) { (this._handlers[ev] || []).forEach(f => f(...a)); }
  publish(topic, payload, opts) { this.published.push({ topic, payload: String(payload), opts: opts || {} }); }
  subscribe(topic) { this.subscribed.push(topic); }
  end() { this.ended = true; }
}

// require('mqtt')를 가짜로 바꿔치기 — 브리지 코드 수정 없이 주입한다.
function withFakeMqtt(fn) {
  const Module = require('module');
  const orig = Module.prototype.require;
  const created = [];
  Module.prototype.require = function (id) {
    if (id === 'mqtt') {
      return { connect: (url, opts) => { const c = new FakeClient(opts); c.url = url; created.push(c); return c; } };
    }
    return orig.apply(this, arguments);
  };
  try { return fn(created); }
  finally { Module.prototype.require = orig; }
}

// ── HAP 최소 모방 ───────────────────────────────────────────────────────────
class Char {
  constructor(name) { this.name = name; this.value = null; this.props = {}; this._h = {}; this.setCalls = []; }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
  setProps(p) { Object.assign(this.props, p); return this; }
  // 실제 HAP과 같게: setValue는 'set' 핸들러를 부르고 값도 갱신하며 'change'를 낸다.
  setValue(v) {
    this.setCalls.push(v);
    (this._h.set || []).forEach(f => f(v, () => {}));
    this.updateValue(v);
    return this;
  }
  updateValue(v) {
    const old = this.value;
    this.value = v;
    if (old !== v) (this._h.change || []).forEach(f => f({ oldValue: old, newValue: v }));
    return this;
  }
}
class Svc {
  constructor(displayName) { this.displayName = displayName; this._c = new Map(); }
  getCharacteristic(k) {
    const key = typeof k === 'string' ? k : (k && k.__name) || String(k);
    if (!this._c.has(key)) this._c.set(key, new Char(key));
    return this._c.get(key);
  }
  testCharacteristic(k) {
    const key = typeof k === 'string' ? k : (k && k.__name) || String(k);
    return this._c.has(key);
  }
  updateCharacteristic(k, v) { this.getCharacteristic(k).updateValue(v); return this; }
}
const C = {
  Active: 'Active', CurrentTemperature: 'CurrentTemperature',
  CoolingThresholdTemperature: 'CoolingThresholdTemperature',
  SwingMode: 'SwingMode', LockPhysicalControls: 'LockPhysicalControls',
  On: 'On', InUse: 'InUse', RemainingDuration: 'RemainingDuration',
};
const S = { HeaterCooler: 'HeaterCooler', Valve: 'Valve', Switch: 'Switch' };
const mkApi = () => ({ hap: { Characteristic: C, Service: S } });
const mkAccessory = (displayName, svcKeys) => {
  const svcs = new Map();
  for (const k of svcKeys) svcs.set(k, new Svc(displayName));
  return { displayName, getService: k => svcs.get(k) || null, _svcs: svcs };
};

const CFG = { enabled: true, host: '192.168.1.11', port: 1883, username: 'u', password: 'p' };

console.log('MQTT 브리지 검증\n');

// ── ① 꺼져 있으면 무해 ──────────────────────────────────────────────────────
console.log('① 기본값(꺼짐) — 아무 것도 하지 않는다');
{
  const log = mkLog();
  const b = new MqttBridge(log, {}, '2.5.0');
  ok(b.enabled === false, 'enabled 기본값 false');
  withFakeMqtt(created => {
    b.start();
    ok(created.length === 0, '꺼진 상태에서 브로커 연결 시도 없음', `연결 ${created.length}회`);
  });
  b.stop();
  ok(log.lines.filter(l => !l.startsWith('debug')).length === 0, '사용자 가시 로그 0줄',
    `${log.lines.filter(l => !l.startsWith('debug')).length}줄`);
}

// ── 켠 상태에서 host 누락 ───────────────────────────────────────────────────
console.log('\n② 켰지만 브로커 주소 없음 — 명확히 알리고 중단');
{
  const log = mkLog();
  const b = new MqttBridge(log, { enabled: true, host: '' }, '2.5.0');
  withFakeMqtt(created => {
    b.start();
    ok(created.length === 0, '연결 시도하지 않음');
  });
  ok(log.lines.some(l => l.startsWith('error')), 'error로 알림');
}

// ── 토픽 정규화 — 와일드카드/공백이 토픽에 박히지 않는다 ─────────────────────
console.log('\n②-b 브로커 토픽에 MQTT 와일드카드·공백이 새지 않는다');
{
  const log = mkLog();
  const b = new MqttBridge(log, { ...CFG, baseTopic: 'km81/#appl appliance+' }, '2.5.0');
  ok(!/[#+\s]/.test(b.base), `base 토픽에 와일드카드·공백 없음`, b.base);
  ok(!/[#+\s]/.test(b.availabilityTopic), 'availability 토픽도 안전', b.availabilityTopic);
}

// ── ③ 연결 전 등록 → 연결 시 일괄 재발행 ──────────────────────────────────
console.log('\n③ 연결 전에 등록해도 유실되지 않는다');
{
  const log = mkLog();
  const b = new MqttBridge(log, CFG, '2.5.0');
  withFakeMqtt(created => {
    b.start();
    const c = created[0];
    ok(!!c, '브로커 연결 시작');
    // 아직 connect 이벤트가 오지 않은 상태에서 등록
    b.registerLaundry({ slug: 'washer', label: '세탁기', kind: 'washer' });
    b.publishLaundryState('washer', { state: 'finished', remainingMin: 0 });
    ok(c.published.length === 0, '연결 전 발행은 나가지 않음', `${c.published.length}건`);

    c.emit('connect');
    const topics = c.published.map(p => p.topic);
    ok(topics.some(t => /binary_sensor\/km81_washer\/running\/config$/.test(t)), '검색(config) 재발행됨');
    ok(topics.some(t => t === 'km81/appliance/washer/state'), '상태 재발행됨');
    const stateMsg = c.published.filter(p => p.topic === 'km81/appliance/washer/state').pop();
    ok(stateMsg && stateMsg.opts.retain === true, '상태는 retain으로 발행');
    b.stop();
  });
}

// ── ④ availability 의미론 ───────────────────────────────────────────────────
console.log('\n④ ★availability는 브리지 하나뿐 — 기기 꺼짐은 상태값이다');
{
  const log = mkLog();
  const b = new MqttBridge(log, CFG, '2.5.0');
  withFakeMqtt(created => {
    b.start();
    const c = created[0];
    ok(c.opts.will && c.opts.will.topic === 'km81/appliance/bridge/availability',
      'LWT가 브리지 availability 토픽을 가리킴');
    ok(c.opts.will.payload === 'offline' && c.opts.will.retain === true, 'LWT는 offline·retain');
    c.emit('connect');
    b.registerLaundry({ slug: 'washer', label: '세탁기', kind: 'washer' });            // 8888: progress/energy 없음
    b.registerLaundry({ slug: 'dryer2', label: '건조기', kind: 'dryer', hasProgress: true, hasEnergy: true, hasDetail: true });
    b.registerSmartAc({ slug: 'seungjun_ac', label: '승준 에어컨', setChar: async () => {}, hasWindFree: true, hasAutoClean: true, hasLight: true, hasSound: true, hasMonitor: true });

    // 모든 검색 payload가 같은 availability_topic 하나만 참조해야 한다.
    // 빈 페이로드는 **회수**(엔티티 내리기)이지 검색 정의가 아니다 — 내용 검사 대상에서 뺀다.
    const cfgs = c.published.filter(p => /\/config$/.test(p.topic) && p.payload !== '')
      .map(p => JSON.parse(p.payload));
    ok(cfgs.length >= 6, `검색 엔티티 ${cfgs.length}개 발행`);
    const avails = new Set(cfgs.map(x => x.availability_topic));
    ok(avails.size === 1 && avails.has('km81/appliance/bridge/availability'),
      '전 엔티티가 브리지 availability 하나만 참조', [...avails].join(','));

    // 기기별 availability 토픽을 만들지 않았는지 — 발행 토픽 전수 확인
    const perDevAvail = c.published.filter(p => /\/availability$/.test(p.topic)
      && p.topic !== 'km81/appliance/bridge/availability');
    ok(perDevAvail.length === 0, '기기별 availability 토픽 없음', `${perDevAvail.length}건`);

    // 세탁기 '꺼짐'은 상태값으로 표현된다
    b.publishLaundryState('washer', { state: 'finished', remainingMin: 0 });
    const st = JSON.parse(c.published.filter(p => p.topic === 'km81/appliance/washer/state').pop().payload);
    ok(st.running === 'OFF' && typeof st.status === 'string' && st.status.length > 0,
      '꺼짐이 상태값(running=OFF)으로 표현됨', JSON.stringify(st));

    // ★object_id 미포함(§7-2 실측): HA(2026.7.4)가 payload object_id를 무시하고 device 이름
    //   기반으로 entity_id를 만든다. 넣어도 효과 없고 HA 업그레이드 시 페이로드 거부 잠복위험 →
    //   넣지 않는다. entity_id는 로마자 실측값을 문서에 기록해 자동화가 참조.
    ok(cfgs.every(x => x.object_id === undefined), 'object_id 미포함(로마자 entity_id 확정)');
    // ★job(진행 단계) 센서는 만들지 않는다(세탁기 8888은 jobState 미지원 — 죽은 엔티티 방지)
    ok(!cfgs.some(x => x.unique_id && x.unique_id.endsWith('_job')), 'job(진행 단계) 센서 미발행');

    // ★§6-3 모니터링 센서 발행 검증(실측 키 기반)
    const uids = cfgs.map(x => x.unique_id);
    ok(uids.includes('km81_seungjun_ac_mode_actual'),
      '기기 실제 운전 모드 센서 발행(홈킷 냉방/끔으로는 제습을 표현 못 함)');
    ok(['power_w', 'energy_kwh', 'humidity', 'filter_percent'].every(k => uids.includes(`km81_seungjun_ac_${k}`)),
      '승준 에어컨 전력·에너지·습도·필터 센서 발행');
    ok(uids.includes('km81_seungjun_ac_light'), '승준 조명 스위치 발행(hasLight)');
    ok(uids.includes('km81_seungjun_ac_sound'), '승준 효과음 스위치 발행(hasSound)');
    // ★건조기(로컬)는 진행률·에너지 센서, 세탁기(8888)는 없어야 한다
    ok(uids.includes('km81_dryer2_power_w'),
      '건조기 순시 전력 센서 발행(로컬 getEnergy가 이미 읽던 값)');
    ok(!uids.includes('km81_washer_power_w'),
      '8888 세탁기는 순시 전력 미발행(getEnergy 자체가 없음)');

    // ★★hasMonitor=false(로컬 폴 경로 없음) — 모니터링 센서를 만들지 않고, 있던 것은 회수한다.
    //   이걸 안 재던 동안 기존 테스트가 **유령 엔티티가 생기는 상태를 '정상'으로 잠그고** 있었다.
    {
      const n0 = c.published.length;
      b.registerSmartAc({ slug: 'cloudac', label: '클라우드 에어컨', setChar: async () => {},
        hasWindFree: false, hasAutoClean: false, hasLight: false, hasSound: false, hasMonitor: false });
      const made = c.published.slice(n0).filter(p => /\/config$/.test(p.topic));
      const alive = made.filter(p => p.payload !== '').map(p => p.topic.split('/').slice(-2)[0]);
      const retracted = made.filter(p => p.payload === '').map(p => p.topic.split('/').slice(-2)[0]);
      ok(alive.length === 1 && alive[0] === 'climate',
        '★폴러 없는 에어컨은 climate 하나만 — 모니터링 센서 유령 없음', alive.join(','));
      ok(['power_w', 'mode_actual', 'alarm_ok', 'night_mode', 'windfree', 'light']
        .every(k => retracted.includes(k)),
        '★없는 센서·스위치는 빈 페이로드로 회수된다', `${retracted.length}종`);
    }
    ok(uids.includes('km81_dryer2_progress') && uids.includes('km81_dryer2_energy_kwh'),
      '건조기 진행률·에너지 센서 발행');
    ok(!uids.includes('km81_washer_progress') && !uids.includes('km81_washer_energy_kwh'),
      '세탁기(8888)는 진행률·에너지 미발행');
    // ★energy 센서는 total_increasing(에너지 대시보드 편입)
    const eng = cfgs.find(x => x.unique_id === 'km81_seungjun_ac_energy_kwh');
    ok(eng && eng.state_class === 'total_increasing' && eng.device_class === 'energy', '누적전력 센서 클래스 정확');

    // ★제어값+모니터링값이 한 state 토픽에 병합 발행되는가
    b.publishSmartAcState('seungjun_ac', { power: true, currentTemp: 26, coolingSetpoint: 24, windFree: false, autoClean: true });
    b.publishSmartAcSensors('seungjun_ac', { power_w: 1200, cumulative_kwh: 114.62, humidity: 65, filter_percent: 3.6, light: true, sound: false, mode_actual: 'Dry' });
    const merged = JSON.parse(c.published.filter(p => p.topic === 'km81/appliance/seungjun_ac/state').pop().payload);
    ok(merged.mode === 'cool' && merged.power_w === 1200 && merged.humidity === 65 && merged.filter_percent === 3.6 && merged.light === 'ON' && merged.sound === 'OFF' && merged.mode_actual === 'Dry',
      '제어값+모니터링값 병합 발행(효과음 포함)', JSON.stringify(merged));

    // ★건조기 남은시간 raw는 60분 상한이 없다(HomeKit Valve 캡 회피)
    b.publishLaundryState('dryer2', { state: 'running', remainingMin: 109, progress: 42, cumulative_kwh: 1222.6, power_w: 1840 });
    const dm = JSON.parse(c.published.filter(p => p.topic === 'km81/appliance/dryer2/state').pop().payload);
    ok(dm.remaining_min === 109 && dm.progress === 42 && dm.energy_kwh === 1222.6 && dm.power_w === 1840,
      '건조기 raw 남은시간(109분)·진행률·에너지·순시전력', JSON.stringify(dm));
    // 순시전력 센서가 에너지 대시보드용 클래스를 갖는지(누적과 혼동 금지)
    const pw = cfgs.find(x => x.unique_id === 'km81_dryer2_power_w');
    ok(pw && pw.device_class === 'power' && pw.state_class === 'measurement' && pw.unit_of_measurement === 'W',
      '건조기 순시전력 센서 클래스 정확');

    // ★★부분 갱신이 가동 상태를 덮으면 안 된다 (2026-08-04, 티어 폴러 도입 중 발견)
    //
    // 느린 티어(30분: 원격제어·어린이잠금·건조강도)는 `state`를 담지 않는다. 그런데
    // `publishLaundryState`가 `String(s.state || 'unknown')`이라, 그 부분 갱신 한 번에
    // **가동 중인 건조기가 `알 수 없음`·`running OFF`·`남은시간 0`으로 덮였다.**
    // ⚠️부분 갱신을 받는 함수는 **"안 온 값"과 "빈 값"을 반드시 구분해야 한다.**
    b.publishLaundryState('dryer2', { remote_control: false, kids_lock: 'Ready', dry_level: 'Normal' });
    const after = JSON.parse(c.published.filter(p => p.topic === 'km81/appliance/dryer2/state').pop().payload);
    ok(after.running === 'ON' && after.status === dm.status && after.remaining_min === 109,
      '★★state 없는 부분 갱신이 가동 상태를 덮지 않는다', JSON.stringify(after));
    ok(after.remote_control === 'OFF' && after.kids_lock === 'Ready' && after.dry_level === 'Normal',
      '★느린 티어 값이 함께 실린다(원격제어·어린이잠금·건조강도)', JSON.stringify(after));

    // ⚠️원격제어 false 는 "HA 명령이 안 먹는다"는 뜻이라 진단 항목으로 노출한다.
    // ★★2026-08-05 — 모든 value_template 에 기본값이 붙어야 한다 (HA 방 실측: 템플릿 경고 1,653건/일)
    //
    // `_mergeAndPublish` 는 값이 사라지면 **키를 지운다**(v2.13.x — 옛 값 고착 방지).
    // 그런데 템플릿이 `{{ value_json.X }}` 면 키가 없을 때 Jinja 가 UndefinedError 를 낸다.
    // ★설계가 틀린 게 아니라 **양쪽 계약을 안 맞춘 것**이다.
    // ⚠️호출부가 13곳이라 하나만 빠져도 그 필드가 매일 경고를 낸다 — 전수로 잰다.
    {
      const noDefault = cfgs.filter((c) => typeof c.value_template === 'string'
        && /^\{\{\s*value_json\.[A-Za-z0-9_]+\s*\}\}$/.test(c.value_template));
      ok(noDefault.length === 0,
        `★★모든 단순 value_template 에 기본값이 붙는다 (없으면 키 부재 시 HA 템플릿 경고)`,
        noDefault.map((c) => c.unique_id).join(', '));
      const sample = cfgs.find((c) => c.unique_id === 'km81_dryer2_alarm_code');
      ok(sample && /\|\s*default\('None'\)/.test(sample.value_template || ''),
        "★기본값은 `'None'` 이다 — HA 의 PAYLOAD_NONE 이라 sensor·binary_sensor·climate 가 "
        + "전부 unknown 으로 읽는다('unknown' 은 숫자 센서에서 ERROR 로 승격된다)",
        sample && sample.value_template);
      // ★climate 전용 템플릿 3종도 반드시 포함되어야 한다(`value_template` 만 감싸면 빠진다).
      const clim = cfgs.find((c) => c.unique_id === 'km81_seungjun_ac_climate');
      const climKeys = clim ? Object.keys(clim).filter((k) => /_template$/.test(k)) : [];
      const climBad = climKeys.filter((k) => !/\|\s*default\(/.test(clim[k]));
      ok(clim && climKeys.length >= 3 && climBad.length === 0,
        '★climate 상태 템플릿에도 기본값이 붙는다', `${climKeys.length}종 중 누락 ${climBad.length}`);
    }

    const rc = cfgs.find(x => x.unique_id === 'km81_dryer2_remote_control');
    ok(rc && rc.entity_category === 'diagnostic' && rc.payload_on === 'ON',
      '원격제어 허용 센서가 진단 항목으로 등록된다');
    b.stop();
  });
}

// ── ⑤ 변화 없으면 재발행 안 함 ──────────────────────────────────────────────
console.log('\n⑤ 같은 상태를 반복 발행하지 않는다');
{
  const log = mkLog();
  const b = new MqttBridge(log, CFG, '2.5.0');
  withFakeMqtt(created => {
    b.start();
    const c = created[0];
    c.emit('connect');
    b.registerLaundry({ slug: 'dryer', label: '건조기', kind: 'dryer' });
    const before = c.published.filter(p => p.topic === 'km81/appliance/dryer/state').length;
    b.publishLaundryState('dryer', { state: 'running', remainingMin: 30 });
    b.publishLaundryState('dryer', { state: 'running', remainingMin: 30 });
    b.publishLaundryState('dryer', { state: 'running', remainingMin: 30 });
    const after = c.published.filter(p => p.topic === 'km81/appliance/dryer/state').length;
    ok(after - before === 1, '같은 값 3회 → 발행 1회', `${after - before}건`);
    b.publishLaundryState('dryer', { state: 'running', remainingMin: 29 });
    const after2 = c.published.filter(p => p.topic === 'km81/appliance/dryer/state').length;
    ok(after2 - after === 1, '값이 바뀌면 발행', `${after2 - after}건`);
    b.stop();
  });
}

// ── ⑥ 명령은 HomeKit 특성으로 흐른다 ───────────────────────────────────────
console.log('\n⑥ ★명령이 HomeKit 특성 setValue를 탄다 (안전 로직 재사용)');
{
  const log = mkLog();
  const api = mkApi();
  const b = new MqttBridge(log, CFG, '2.5.0');
  withFakeMqtt(created => {
    b.start();
    const c = created[0];
    c.emit('connect');

    const acc = mkAccessory('승준 에어컨', [S.HeaterCooler]);
    const main = acc.getService(S.HeaterCooler);
    main.getCharacteristic(C.Active).updateValue(0);
    main.getCharacteristic(C.CurrentTemperature).updateValue(27);
    main.getCharacteristic(C.CoolingThresholdTemperature).setProps({ minValue: 18, maxValue: 30 });
    main.getCharacteristic(C.CoolingThresholdTemperature).updateValue(24);
    main.getCharacteristic(C.SwingMode).updateValue(0);
    main.getCharacteristic(C.LockPhysicalControls).updateValue(0);

    const okAttach = attachSmartAc({
      bridge: b, api, log, accessory: acc, logic: {}, configDevice: {}, slug: 'seungjun_ac',
    });
    ok(okAttach === true, '연결 성공');

    // 구독 토픽 확인
    ok(c.subscribed.includes('km81/appliance/seungjun_ac/set/mode'), '모드 명령 토픽 구독');
    ok(c.subscribed.includes('km81/appliance/seungjun_ac/set/temperature'), '온도 명령 토픽 구독');

    // 켜기 명령 → Active.setValue(1)
    c.emit('message', 'km81/appliance/seungjun_ac/set/mode', Buffer.from('cool'));
    return new Promise(res => setImmediate(() => {
      const calls = main.getCharacteristic(C.Active).setCalls;
      ok(calls.length === 1 && calls[0] === 1, '켜기 → Active setValue(1)', JSON.stringify(calls));

      // 범위를 넘는 온도는 기기 허용 범위로 잘라서 넣는다
      c.emit('message', 'km81/appliance/seungjun_ac/set/temperature', Buffer.from('99'));
      setImmediate(() => {
        const t = main.getCharacteristic(C.CoolingThresholdTemperature).setCalls;
        ok(t.length === 1 && t[0] === 30, '범위 초과 온도를 상한으로 clamp', JSON.stringify(t));

        // 숫자가 아닌 값은 거부(예외) — 기기로 쓰레기가 안 나간다
        c.emit('message', 'km81/appliance/seungjun_ac/set/temperature', Buffer.from('abc'));
        setImmediate(() => {
          const t2 = main.getCharacteristic(C.CoolingThresholdTemperature).setCalls;
          ok(t2.length === 1, '숫자 아닌 온도는 전송하지 않음', `setValue ${t2.length}회`);

          // 스위치가 없으면 주 서비스의 SwingMode/LockPhysicalControls로 대체된다
          c.emit('message', 'km81/appliance/seungjun_ac/set/windfree', Buffer.from('ON'));
          setImmediate(() => {
            ok(main.getCharacteristic(C.SwingMode).setCalls.length === 1,
              '무풍 → SwingMode로 대체 전송');

            // ★retain된 명령은 무시해야 한다 — 재연결마다 옛 명령이 재전달돼 기기가 저절로
            //   켜지는 사고 방지. Active setCalls가 늘지 않아야 한다.
            const activeBefore = main.getCharacteristic(C.Active).setCalls.length;
            c.emit('message', 'km81/appliance/seungjun_ac/set/mode', Buffer.from('cool'), { retain: true });
            // 빈 페이로드도 무시
            c.emit('message', 'km81/appliance/seungjun_ac/set/mode', Buffer.from(''));
            setImmediate(() => {
              ok(main.getCharacteristic(C.Active).setCalls.length === activeBefore,
                'retain·빈 명령은 setValue를 유발하지 않음',
                `추가 ${main.getCharacteristic(C.Active).setCalls.length - activeBefore}회`);
              b.stop();
              res();
            });
          });
        });
      });
    }));
  });
}

// ── ⑦ 세탁물 상태 매핑 ─────────────────────────────────────────────────────
setTimeout(() => {
  console.log('\n⑦ 세탁물 3-상태가 밸브 특성에서 정확히 복원된다');
  {
    const log = mkLog();
    const api = mkApi();
    const b = new MqttBridge(log, CFG, '2.5.0');
    withFakeMqtt(created => {
      b.start();
      const c = created[0];
      c.emit('connect');
      const acc = mkAccessory('세탁기', [S.Valve]);
      const valve = acc.getService(S.Valve);
      valve.getCharacteristic(C.Active).updateValue(0);
      valve.getCharacteristic(C.InUse).updateValue(0);
      valve.getCharacteristic(C.RemainingDuration).updateValue(0);
      attachLaundry({ bridge: b, api, log, accessory: acc, configDevice: {}, slug: 'washer', kind: 'washer' });

      const last = () => JSON.parse(c.published.filter(p => p.topic === 'km81/appliance/washer/state').pop().payload);
      setImmediate(() => {
        ok(last().running === 'OFF', '전원 꺼짐/대기 → running=OFF');

        valve.updateCharacteristic(C.Active, 1);
        valve.updateCharacteristic(C.InUse, 1);
        valve.updateCharacteristic(C.RemainingDuration, 3600);
        setImmediate(() => {
          const s = last();
          ok(s.running === 'ON' && s.remaining_min === 60, '운전 중 → ON·60분', JSON.stringify(s));

          // 일시정지: Active 유지, InUse 해제
          valve.updateCharacteristic(C.InUse, 0);
          setImmediate(() => {
            const p = last();
            ok(p.running === 'OFF' && p.status.includes('일시'), '일시정지 구분됨', JSON.stringify(p));
            b.stop();

            // ── ⑧ 로그 문구가 hb-watch 경보와 겹치지 않는다 ──
            console.log('\n⑧ ★로그 문구가 NAS 감시 경보 정규식과 겹치지 않는다');
            const ALARM = /폴링 실패|상태 조회 실패|상태 폴링 오류|연결 실패|무응답|최종 요청 실패/;
            const files = ['lib/mqtt/MqttBridge.js', 'lib/mqtt/attach.js'];
            let hits = [];
            for (const f of files) {
              const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
              src.split('\n').forEach((line, i) => {
                if (/this\.log\.(info|warn|error)/.test(line) && ALARM.test(line)) hits.push(`${f}:${i + 1}`);
              });
            }
            // index.js의 MQTT 관련 로그도 함께 본다
            const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
            idx.split('\n').forEach((line, i) => {
              if (/\[MQTT\]/.test(line) && /this\.log\.(info|warn|error)/.test(line) && ALARM.test(line)) {
                hits.push(`index.js:${i + 1}`);
              }
            });
            ok(hits.length === 0, '중계 로그에 기기 장애 경보 문구 없음', hits.join(', ') || '0건');

            // ── ⑨ ★index.js가 attach에 logic을 넘기는가 (2026-07-30 실측으로 발견한 결함) ──
            // attachLaundry 호출에서 logic이 빠지면 client=null → 로컬 건조기가 8888 세탁기로
            // 오인되어 진행률·에너지·raw 남은시간이 통째로 사라진다. 코드 리뷰 4회가 놓치고
            // 실기기 배포 후에야 드러났다 — 그래서 정적 검사로 잠근다.
            console.log('\n⑨ ★index.js가 attach에 logic·platform을 전달한다');
            {
              const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
              const mAc = src.match(/attachSmartAc\(\{[^}]*\}\)/);
              const mLa = src.match(/attachLaundry\(\{[^}]*\}\)/);
              const mCommon = src.match(/const common = \{[^}]*\}/);
              ok(!!mAc && /\blogic\b/.test(mAc[0]), 'attachSmartAc 호출에 logic 포함');
              ok(!!mLa && /\blogic\b/.test(mLa[0]), 'attachLaundry 호출에 logic 포함(로컬 건조기 센서 누락 방지)');
              ok(!!mCommon && /\bplatform\b/.test(mCommon[0]), 'common에 platform 포함(폴러 정리용)');

              // ★명시 mqttSlug도 중복 방지 집합에 등록해야 한다 — 안 하면 두 기기가 같은 토픽에
              //   상태를 번갈아 발행한다(적대 감사 Medium).
              ok(/_usedSlugs\.add\(explicit\)/.test(src),
                '명시 mqttSlug를 사용 집합에 등록(토픽 충돌 방지)');
              // ★slug가 null(충돌)이면 중계에서 빠져야 한다
              ok(/if \(!slug\) return;/.test(src), 'slug 충돌 시 중계 제외');

              // ★mqtt는 선택적 의존성이어야 한다 — 설치 실패가 플러그인 전체를 못 뜨게 하면 안 된다
              const pkg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8'));
              ok(!!(pkg.optionalDependencies && pkg.optionalDependencies.mqtt) && !(pkg.dependencies && pkg.dependencies.mqtt),
                'mqtt가 optionalDependencies에 있음(홈킷 보호)');

              // ★브로커에 못 붙으면 1회 warn — 예전엔 기본 로그에서 완전 무음이었다
              const brSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'mqtt', 'MqttBridge.js'), 'utf8');
              ok(/브로커에 아직 접속하지 못했습니다/.test(brSrc), '브로커 미접속 시 warn 알림 존재');
              // 그 문구가 hb-watch 경보 어휘와 겹치지 않아야 한다
              ok(!/(폴링 실패|상태 조회 실패|상태 폴링 오류|연결 실패|무응답|최종 요청 실패)/.test(
                (brSrc.match(/브로커에 아직 접속하지 못했습니다[\s\S]{0,200}/) || [''])[0]),
                '미접속 warn 문구가 기기 장애 경보 어휘를 피함');
            }

            // ── ⑩ ★세탁물 판정은 홈브릿지 정본과 한 벌이다 (2026-07-30 실사고) ──
            // v2.6.3까지 attach.js가 판정을 재정의(RUNNING_JOBS)해서, 건조기가 사이클을
            // 마치고 machineState='run' + jobState='none'을 보고하면 홈킷은 '완료'인데
            // MQTT만 '운전 중'에 영구 고착됐다(13:58 종료 → 7분+ running=ON 실측).
            console.log('\n⑩ ★세탁물 판정 = 정본(Laundry.classifyComponent) 위임');
            {
              const { laundryStateOf } = require('../lib/mqtt/attach');
              const mk = (ms, js) => ({ dryerOperatingState: {
                machineState: { value: ms }, dryerJobState: { value: js } } });
              // 실사고 조합: 드럼은 멈췄지만 문 열기 전
              ok(laundryStateOf(mk('run', 'none')) === 'finished',
                'run+none(사이클 종료 직후) → 완료 — 구 코드는 여기서 영구 운전 중');
              ok(laundryStateOf(mk('run', 'drying')) === 'running', 'run+drying → 운전 중');
              // 정본의 POST_CYCLE 구분: idle machineState에서 살아있는 건 안티주름류뿐
              ok(laundryStateOf(mk('on', 'drying')) === 'finished',
                'on+drying → 완료(정본 — stale pre-cycle jobState 취급, 홈킷과 일치)');
              ok(laundryStateOf(mk('on', 'wrinklePrevent')) === 'running',
                'on+wrinklePrevent(안티주름) → 운전 중');
              ok(laundryStateOf(mk('pause', 'drying')) === 'paused', 'pause → 일시정지');
              ok(laundryStateOf(mk('stop', 'none')) === 'finished', 'stop → 완료');
              ok(laundryStateOf(null) === 'unknown', '컴포넌트 없음 → unknown');
              // 재정의 금지 계약: attach.js에 판정 집합이 다시 생기면 안 된다
              const atSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'mqtt', 'attach.js'), 'utf8');
              ok(!/RUNNING_JOBS/.test(atSrc), 'attach.js에 판정 집합 재정의 없음(정본 단일화)');
              ok(/classifyComponent/.test(atSrc), 'attach.js가 정본 판정기를 사용');
            }

            // ── 마무리 ──
            console.log(`\n${fail === 0 ? '✅ 전부 통과' : '❌ 실패 ' + fail + '건'} (통과 ${pass})`);
            process.exit(fail === 0 ? 0 : 1);
          });
        });
      });
    });
  }
}, 50);

// ── 2026-08-05: 소비자 최종단의 null 의미론 (적대 리뷰 F1·F2) ────────────────
//
// 공급자(getter)에서 "실패=undefined / 빈 값=null" 을 통일했는데, **발행 함수가 null 을
// 'OFF'·0 으로 접으면** 그 계약이 마지막 한 걸음에서 무너진다. 특히 `remote_control` 은
// "OFF = HA 명령이 기기에 안 먹는다"는 진단값이라 빈 값이 **거짓 진단**이 된다.
{
  console.log('\n[소비자 null 의미론]');
  const log = mkLog();
  const b = new MqttBridge(log, CFG, '2.14.7');
  withFakeMqtt(created => {
    b.start();
    const c = created[0];
    c.emit('connect');
    b.registerSmartAc({ slug: 'na', label: '에어컨', setChar: async () => {},
      hasWindFree: true, hasAutoClean: true, hasLight: true, hasSound: true,
      hasMonitor: true, hasLastSeen: true });
    b.registerLaundry({ slug: 'nl', label: '건조기', kind: 'dryer',
      hasProgress: true, hasEnergy: true, hasDetail: true, hasLastSeen: true });

    const stOf = (slug) => JSON.parse(c.published.filter(p => p.topic === `km81/appliance/${slug}/state`).pop().payload);

    // 먼저 값을 채워 둔다(그래야 '지워지는지'를 잴 수 있다).
    b.publishSmartAcSensors('na', { autoclean_running: true, alarm_ok: true, light: true, sound: true });
    b.publishLaundryState('nl', { state: 'running', remainingMin: 50,
      remote_control: true, wrinkle_prevent: true, alarm_ok: true });
    const seeded = { ...stOf('na'), ...stOf('nl') };
    ok(seeded.autoclean_running === 'ON' && seeded.remote_control === 'ON' && seeded.remaining_min === 50,
      '초기값이 실렸다(계측 전제)');

    // 이제 **빈 값(null)** 을 흘린다 — 'OFF'/0 이 아니라 키가 사라져야 한다.
    b.publishSmartAcSensors('na', { autoclean_running: null, alarm_ok: null, light: null, sound: null });
    b.publishLaundryState('nl', { remote_control: null, wrinkle_prevent: null,
      alarm_ok: null, remainingMin: null });
    const a = stOf('na'), l = stOf('nl');
    const bad = [];
    for (const [obj, k] of [[a, 'autoclean_running'], [a, 'alarm_ok'], [a, 'light'], [a, 'sound'],
                            [l, 'remote_control'], [l, 'wrinkle_prevent'], [l, 'alarm_ok']]) {
      if (k in obj) bad.push(`${k}=${obj[k]}`);
    }
    ok(bad.length === 0,
      "★빈 값(null)을 'OFF' 로 접지 않는다 — 키를 지워 HA 가 unknown 으로 읽게 한다",
      bad.join(' · ') || '7종 전부 삭제');
    ok(!('remaining_min' in l),
      '★빈 값 남은시간을 0 으로 만들지 않는다 (Number(null)===0 — "없음과 0은 다르다")',
      'remaining_min' in l ? `실제 ${l.remaining_min}` : '삭제됨');

    // 건조기 alarm_ok discovery — 발행만 되고 엔티티가 없던 것(구김방지와 같은 부류).
    const uids = c.published.filter(p => /\/config$/.test(p.topic) && p.payload !== '')
      .map(p => JSON.parse(p.payload).unique_id);
    ok(uids.includes('km81_nl_alarm_ok'), '★건조기 alarm_ok 도 discovery 가 있다');
  });
}

// ── 2026-08-05: last_seen(마지막 수신) 계약 ──────────────────────────────────
//
// 왜: 브리지 availability 는 브리지 생사만 알려 줘서 HA 가 "값이 안 바뀐 것"과 "기기가 죽은
// 것"을 구분 못 한다(실제로 11.6시간 같은 값이 있었다). 기기별 availability 로 풀면
// **"전원을 끈 것"과 "죽은 것"이 섞이므로**(요청서 §4-2) 사실만 내보내고 임계는 HA 가 정한다.
{
  console.log('\n[last_seen 계약]');
  const log = mkLog();
  const b = new MqttBridge(log, CFG, '2.14.5');
  withFakeMqtt(created => {
    b.start();
    const c = created[0];
    c.emit('connect');
    const cfgOf = (uid) => c.published.filter(p => /\/config$/.test(p.topic) && p.payload !== '')
      .map(p => JSON.parse(p.payload)).find(x => x.unique_id === uid);

    b.registerSmartAc({ slug: 'ac1', label: '에어컨', setChar: async () => {},
      hasWindFree: true, hasAutoClean: true, hasLight: true, hasSound: true,
      hasMonitor: true, hasLastSeen: true });
    b.registerLaundry({ slug: 'w1', label: '세탁기', kind: 'washer', hasDetail: false, hasLastSeen: true });
    b.registerWaterPurifier({ slug: 'wp1', label: '정수기' });

    for (const [slug, who] of [['ac1', '에어컨'], ['w1', '세탁기'], ['wp1', '정수기']]) {
      const d = cfgOf(`km81_${slug}_last_seen`);
      ok(d && d.device_class === 'timestamp' && d.entity_category === 'diagnostic',
        `${who} last_seen 이 timestamp·진단 항목으로 등록된다`, d ? d.device_class : '없음');
    }

    // ★기기별 availability 를 만들지 않았는지 — 이게 이 설계의 핵심 계약이다.
    const perDev = c.published.filter(p => /\/availability$/.test(p.topic)
      && p.topic !== 'km81/appliance/bridge/availability');
    ok(perDev.length === 0, '★기기별 availability 를 만들지 않는다(꺼짐과 사망이 섞인다)',
      `${perDev.length}건`);

    // 값 전달: ISO 8601 + Z (HA timestamp 는 오프셋을 요구한다)
    const iso = '2026-08-05T06:30:00.000Z';
    b.publishSmartAcSensors('ac1', { last_seen: iso });
    b.publishLaundryState('w1', { last_seen: iso });
    b.publishWaterPurifierState('wp1', { last_seen: iso });
    const stOf = (slug) => JSON.parse(c.published.filter(p => p.topic === `km81/appliance/${slug}/state`).pop().payload);
    ok(['ac1', 'w1', 'wp1'].every(x => stOf(x).last_seen === iso),
      'last_seen 이 세 기기 상태에 그대로 실린다(오프셋 보존)');

    // ★실패 회차(undefined)는 **덮지 않는다** — 마지막 성공 시각이 남아야 경과가 커진다.
    b.publishSmartAcSensors('ac1', { power_w: 100 });
    ok(stOf('ac1').last_seen === iso,
      '★조회 실패 회차가 last_seen 을 지우지 않는다(경과가 커져야 HA 가 사망을 안다)',
      stOf('ac1').last_seen);

    // 폴러가 없는 에어컨은 last_seen 도 유령이다 → 등록하지 않고 회수한다.
    const n0 = c.published.length;
    b.registerSmartAc({ slug: 'ac2', label: '클라우드 에어컨', setChar: async () => {},
      hasWindFree: false, hasAutoClean: false, hasLight: false, hasSound: false,
      hasMonitor: false, hasLastSeen: false });
    const ls = c.published.slice(n0).find(p => p.topic.endsWith('/km81_ac2/last_seen/config'));
    ok(ls && ls.payload === '', '★폴러 없으면 last_seen 도 회수된다(채워질 수 없는 값)');

    // ★★클라우드 폴백이 켜진 구성 — 폴러는 돌지만 last_seen 은 **거짓말이 된다**:
    //   세탁물은 클라우드 캐시 응답에도 갱신돼 죽은 기기가 영원히 신선해 보이고,
    //   에어컨은 폴백 성공이 lastOk 를 안 올려 살아 있는 기기를 죽었다고 보고한다.
    const n1 = c.published.length;
    b.registerSmartAc({ slug: 'ac3', label: '폴백 에어컨', setChar: async () => {},
      hasWindFree: true, hasAutoClean: true, hasLight: true, hasSound: true,
      hasMonitor: true, hasLastSeen: false });
    b.registerLaundry({ slug: 'w3', label: '폴백 세탁기', kind: 'washer', hasDetail: false, hasLastSeen: false });
    const fb = ['km81_ac3', 'km81_w3'].map(x =>
      c.published.slice(n1).find(p => p.topic.endsWith(`/${x}/last_seen/config`)));
    ok(fb.every(x => x && x.payload === ''),
      '★★폴백 구성에서는 last_seen 을 등록하지 않고 회수한다(양방향으로 거짓말이 된다)');
    // 폴백 에어컨도 모니터링 센서 자체는 그대로 나온다(폴러가 돌기 때문).
    const ac3 = c.published.slice(n1).filter(p => p.topic.includes('km81_ac3/') && p.payload !== '');
    ok(ac3.length > 5, '폴백 에어컨의 다른 센서는 정상 등록된다', `${ac3.length}종`);
  });
}

// ── 2026-08-05: 중계를 끈 기기 회수 · 세탁기 상세값 게이트 ────────────────────
//
// 왜 이 계약이 필요한가:
//  · 8888 세탁기는 원격제어·건조강도 같은 값을 **읽을 경로가 없다**. discovery 만 나가면
//    HA 에 영영 값이 안 채워지는 유령 엔티티가 남는다(HA 방 실측 5개).
//  · 설정에서 중계를 끄면, 껐다는 사실이 HA 에 전달되지 않아 엔티티가 **마지막 값에
//    얼어붙는다**. 관찰 기간 내내 죽은 기기의 옛 값을 살아 있는 값으로 보게 된다.
{
  console.log('\n[회수·상세값 게이트]');
  const log = mkLog();
  const b = new MqttBridge(log, CFG, '2.14.3');
  withFakeMqtt(created => {
    b.start();
    const c = created[0];
    c.emit('connect');
    const cfgs = (from) => c.published.slice(from).filter(p => /\/config$/.test(p.topic));
    const KEYS = ['remote_control', 'kids_lock', 'dry_level', 'alarm_code', 'course', 'wrinkle_prevent'];

    // (1) 8888 세탁기 — 상세 discovery 는 빈 페이로드(회수)로만 나간다.
    let n = c.published.length;
    b.registerLaundry({ slug: 'washer', label: '세탁기', kind: 'washer',
      hasEnergy: false, hasProgress: false, hasDetail: false });
    const w = cfgs(n);
    const wBad = KEYS.filter(k => {
      const m = w.find(x => x.topic.endsWith(`/${k}/config`));
      return !m || m.payload !== '' || m.opts.retain !== true;
    });
    ok(wBad.length === 0, '세탁기 상세값 6종은 빈 페이로드 retain 으로 회수', wBad.join(',') || '전부 회수');

    // (2) 건조기 — 상세값이 전부 나가고 구김방지도 포함된다(발행만 하고 discovery 가 없던 값).
    n = c.published.length;
    b.registerLaundry({ slug: 'dryer2', label: '건조기', kind: 'dryer',
      hasEnergy: true, hasProgress: true, hasDetail: true });
    const dKeys = cfgs(n).filter(p => p.payload !== '').map(p => p.topic.split('/').slice(-2)[0]);
    const dMiss = KEYS.filter(k => !dKeys.includes(k));
    ok(dMiss.length === 0, '건조기는 상세값 6종 전부 발행(구김방지 포함)', dMiss.join(',') || `${dKeys.length}종`);

    // (3) retractDevice — 정수기 16종 + state 가 전부 빈 페이로드 retain.
    n = c.published.length;
    const done = b.retractDevice({ slug: 'water_purifier', kind: 'waterPurifier', label: '정수기' });
    const rc = cfgs(n);
    ok(done === true && rc.length >= 16 && rc.every(p => p.payload === '' && p.opts.retain === true),
      '정수기 회수 — discovery 16종이 빈 페이로드 retain', `${rc.length}종`);
    const st = c.published.slice(n).find(p => p.topic === 'km81/appliance/water_purifier/state');
    ok(!!st && st.payload === '' && st.opts.retain === true, '정수기 state 토픽도 회수');

    // (4-a) ★연결 **전**에 들어온 회수는 사라지지 않고, 연결 시 재발행보다 먼저 실행된다.
    //   순서가 반대면 방금 지운 엔티티가 그 자리에서 되살아난다.
    {
      const log2 = mkLog();
      const b2 = new MqttBridge(log2, CFG, '2.14.3');
      withFakeMqtt(cr2 => {
        b2.start();
        const c2 = cr2[0];
        b2.registerLaundry({ slug: 'dryer', label: '건조기', kind: 'dryer', hasDetail: true });
        const queued = b2.retractDevice({ slug: 'water_purifier', kind: 'waterPurifier', label: '정수기' });
        ok(queued === true && c2.published.length === 0,
          '연결 전 회수는 대기열로 들어간다(발행 0건)', `발행 ${c2.published.length}건`);
        c2.emit('connect');
        const cfgTopics = c2.published.filter(p => /\/config$/.test(p.topic));
        const wp = cfgTopics.filter(p => p.topic.includes('km81_water_purifier'));
        ok(wp.length >= 16 && wp.every(p => p.payload === ''),
          '연결 시 대기 회수가 실행된다', `${wp.length}종`);
        // ⚠️회수 토픽도 `km81_dryer/` 에 매치되므로 **페이로드가 있는 것(=재발행)** 만 센다.
        const lastRetract = c2.published.reduce((acc, p, i) =>
          (/\/config$/.test(p.topic) && p.payload === '' ? i : acc), -1);
        const firstRepub = c2.published.findIndex(p => /\/config$/.test(p.topic) && p.payload !== '');
        ok(lastRetract >= 0 && firstRepub >= 0 && lastRetract < firstRepub,
          '★모든 회수가 검색 재발행보다 먼저다(반대면 지운 것이 되살아난다)',
          `마지막 회수 ${lastRetract} < 첫 재발행 ${firstRepub}`);
      });
    }

    // (4) 회수 플래그가 새지 않는다 — 다음 등록은 정상 페이로드여야 한다.
    n = c.published.length;
    b.registerWaterPurifier({ slug: 'water_purifier', label: '정수기' });
    const re = cfgs(n);
    ok(re.length >= 16 && re.every(p => p.payload !== ''),
      '회수 뒤 재등록은 정상 페이로드(_retractMode 누수 없음)', `${re.length}종`);
  });
}
