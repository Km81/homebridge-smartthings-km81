'use strict';

/**
 * 콜드 부팅의 첫 읽기 — 지난 부팅의 마지막 값으로 즉답한다.
 *
 * ★왜: `_state`가 비어 있으면 홈킷 read 6발이 전부 기기까지 간다. 로컬 경로는 기기당
 * DTLS 핸드셰이크를 **순차로** 하느라 두 번째 기기는 6초가 걸리고, 그동안 특성 6개가
 * stall하며 홈브릿지 `slow to respond`(임계 3초)가 재시작마다 6줄씩 났다(2026-08-03 실측).
 *
 * ⚠️여기서 재는 것은 "빨라졌는가"가 아니라 **"거짓말을 최소로 하면서 즉답하는가"**다.
 *   시드는 **추정**이므로 ①신선하다고 표시하면 안 되고 ②기기가 보고했다고 기록하면 안 된다.
 */

const path = require('path');
const SmartAC = require('../lib/accessories/SmartAC');

let pass = 0;
const fails = [];
const check = (cond, label) => { if (cond) pass++; else fails.push(label); };

const LAST = { power: true, currentTemp: 27, coolingSetpoint: 25, windFree: false, autoClean: false };

/** 실제 configure()를 태우는 최소 rig. 기기 호출은 전부 센다. */
function rig({ remembered, cloudPower = false } = {}) {
  const calls = [];
  const logs = [];
  const persisted = [];
  const rec = (lv) => (...a) => logs.push({ lv, m: a.join(' ') });

  const C = {
    Manufacturer: {}, Model: {}, SerialNumber: {}, FirmwareRevision: {},
    Active: { displayName: 'Active' },
    CurrentHeaterCoolerState: { displayName: 'CurrentState', INACTIVE: 0, IDLE: 1, COOLING: 2 },
    TargetHeaterCoolerState: { displayName: 'TargetState', COOL: 2 },
    CurrentTemperature: { displayName: 'CurrentTemp' },
    CoolingThresholdTemperature: { displayName: 'CoolingThreshold' },
    SwingMode: { displayName: 'SwingMode' },
    LockPhysicalControls: { displayName: 'Lock' },
    On: { displayName: 'On' },
  };

  const mkService = (name) => {
    const chars = new Map();
    return {
      displayName: name,
      setCharacteristic() { return this; },
      getCharacteristic(c) {
        if (!chars.has(c)) {
          chars.set(c, {
            _get: null, _set: null,
            removeAllListeners() {}, setProps() { return this; },
            on(ev, fn) { if (ev === 'get') this._get = fn; else if (ev === 'set') this._set = fn; return this; },
          });
        }
        return chars.get(c);
      },
      testCharacteristic(c) { return chars.has(c); },
      removeCharacteristic() {},
      updateCharacteristic() {},
      _chars: chars,
    };
  };

  const info = mkService('AccessoryInformation');
  const main = mkService('승준 에어컨');
  const accessory = {
    displayName: '승준 에어컨',
    context: { device: { deviceId: 'dev1' }, ...(remembered ? { km81LastState: remembered } : {}) },
    getService: (s) => (s === 'AI' ? info : main),
    addService: () => main,
  };

  const count = (name, v) => { calls.push(name); return v; };
  const st = {
    getPower: async () => count('getPower', cloudPower),
    getCurrentTemperature: async () => count('getCurrentTemperature', 31),
    getCoolingSetpoint: async () => count('getCoolingSetpoint', 18),
    getWindFree: async () => count('getWindFree', true),
    getAutoClean: async () => count('getAutoClean', true),
    getSupportedModes: async () => count('getSupportedModes', ['Cool']),
    setPower: async () => count('setPower'),
    setMode: async () => count('setMode'),
    setTemperature: async () => count('setTemperature'),
    setWindFree: async () => count('setWindFree'),
    setAutoClean: async () => count('setAutoClean'),
    invalidateStatusCache: () => {},
  };

  const api = {
    hap: {
      Service: { AccessoryInformation: 'AI', HeaterCooler: 'HC', Switch: 'SW' },
      Characteristic: C,
      uuid: { generate: (s) => 'uuid-' + s },
      HapStatusError: class extends Error {},
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    },
    updatePlatformAccessories: (list) => persisted.push(list),
  };

  const o = new SmartAC({
    log: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
    api,
    smartthings: st,
    platform: { config: {}, registerShutdown: (fn) => { o._shutdownFn = fn; } },
  });
  // 폴링은 이 시험의 대상이 아니다 — 타이머가 뜨면 프로세스가 안 죽는다.
  o.configure(accessory, { coolModeCommand: 'cool', pollingInterval: 0 }, '0.0.0');

  return {
    o, C, main, accessory, calls, logs, persisted,
    get: (char) => new Promise((res, rej) => {
      main.getCharacteristic(char)._get((e, v) => (e ? rej(e) : res(v)));
    }),
    set: (char, v) => new Promise((res) => { main.getCharacteristic(char)._set(v, () => res()); }),
    stop() { o._stopped = true; if (o._backgroundPollTimer) clearTimeout(o._backgroundPollTimer); },
  };
}

(async () => {
  // ── ① ★★지난 부팅 값이 있으면 기기에 묻지 않고 즉답한다
  {
    const r = rig({ remembered: LAST });
    const power = await r.get(r.C.Active);
    const temp = await r.get(r.C.CurrentTemperature);
    const sp = await r.get(r.C.CoolingThresholdTemperature);
    check(r.calls.length === 0,
      `★★콜드 리드가 기기까지 가지 않는다 (실측 호출 ${r.calls.length}회)`);
    check(power === 1 && temp === 27 && sp === 25, '지난 부팅의 값을 그대로 답한다');
    r.stop();
  }

  // ── ② 대조군 — 기억이 없으면 종전대로 기기에 묻는다
  {
    const r = rig({});
    await r.get(r.C.Active);
    check(r.calls.includes('getPower'), '기억이 없으면 기기에 묻는다 (종전 동작)');
    r.stop();
  }

  // ── ③ ★시드는 "신선한 값"이 아니다 — 켜기 생략에 쓰이면 안 된다
  //    시드가 `power: true`인데 그것을 믿고 켜기를 생략하면, 홈브릿지가 꺼져 있는 동안
  //    리모컨으로 끈 에어컨이 **켜기 탭을 먹고도 꺼진 채** 남는다(홈킷엔 성공 보고).
  {
    const r = rig({ remembered: LAST });
    check(r.o._stateFresh === false, '★시드로 시작하면 신선하지 않다고 표시한다');
    await r.set(r.C.Active, 1);
    check(r.calls.includes('setPower'),
      '★★시드가 켜짐이어도 켜기 명령을 실제로 보낸다 (조용히 삼키지 않는다)');
    r.stop();
  }

  // ── ④ ★시드를 "기기가 보고했다"고 기록하지 않는다
  //    `_seeded`에 넣으면, 폴이 계속 실패해도 다음 read가 기기에 다시 묻지 않는다.
  {
    const r = rig({ remembered: LAST });
    check(!r.o._seeded.has('power') && !r.o._seeded.has('currentTemp'),
      '★시드는 _seeded에 들어가지 않는다 (추정이지 관측이 아니다)');
    r.stop();
  }

  // ── ⑤ 폴이 실제 값을 받으면 그 값으로 갈아탄다 (옛 값에 눌어붙지 않는다)
  {
    const r = rig({ remembered: LAST });
    r.o._state.currentTemp = 31;            // 폴이 갱신했다고 가정
    r.o._stateFresh = true;
    r.o._rememberState();
    check(r.accessory.context.km81LastState.currentTemp === 31,
      '★새 값이 다음 부팅용 기억에 반영된다');
    check(r.persisted.length === 1, '홈브릿지에 저장을 알린다');
    r.stop();
  }

  // ── ⑥ ⚠️저장이 폴링마다 일어나면 안 된다 (실내온도는 1분에도 여러 번 흔들린다)
  {
    const r = rig({ remembered: LAST });
    for (let i = 0; i < 20; i++) { r.o._state.currentTemp = 20 + i; r.o._rememberState(); }
    check(r.persisted.length === 1,
      `★최소 간격을 지킨다 (20회 변화에 저장 ${r.persisted.length}회)`);
    check(r.accessory.context.km81LastState.currentTemp === 39,
      '그래도 기억 자체는 최신이다 (디스크 반영만 미룬다)');
    r.stop();
  }

  // ── ⑦ 종료 직전에는 간격을 무시하고 한 번 남긴다
  {
    const r = rig({ remembered: LAST });
    r.o._state.currentTemp = 33;
    r.o._rememberState();                    // 1회차 저장
    r.o._state.currentTemp = 34;
    r.o._rememberState();                    // 간격에 막힌다
    check(r.persisted.length === 1, '(전제) 간격에 막혀 있다');
    r.o._shutdownFn();
    check(r.persisted.length === 2, '★종료 시에는 마지막 값을 반드시 남긴다');
    check(r.accessory.context.km81LastState.currentTemp === 34, '남긴 것이 마지막 값이다');
  }

  // ── ⑧ 기억이 깨져 있어도 죽지 않는다
  {
    for (const bad of ['문자열', 42, [], { power: null, currentTemp: undefined }]) {
      const r = rig({ remembered: bad });
      check(r.o._state.power === undefined || typeof r.o._state.power === 'boolean',
        `깨진 기억(${JSON.stringify(bad)})에도 안전하다`);
      r.stop();
    }
  }

  console.log(`\n[콜드 리드 즉답] 통과 ${pass} / 실패 ${fails.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('스위트 실행 오류:', e); process.exit(1); });
