'use strict';

// 액세서리 ↔ MQTT 브리지 연결 (v2.5.0)
//
// ★설계 원칙: **액세서리 코드를 수정하지 않는다.**
//   상태는 HomeKit 특성의 `change` 이벤트를 거울처럼 따라가고(폴링이 갱신하든 사용자가
//   조작하든 한 곳에서 잡힌다), 명령은 같은 특성에 `setValue`로 넣는다.
//   → 기기 추가 조회 0회(기존 폴링에 편승) + 안전 로직(끄기 억제창·직렬화·켜기 후속
//     체인·재동기화) 전부 재사용. 액세서리 내부를 건드리지 않으므로 v2.4.6에서 검증된
//     동작이 그대로 유지된다.
//
// 한계(의도적 미구현): 진행 단계(jobState)·진행률·순시전력·필터 사용시간은 HomeKit
//   특성으로 노출되지 않아 이 방식으로 얻을 수 없다. 넣으려면 액세서리에 훅을 추가해야
//   하므로 플러그인 소유 방과 합의 후 별도 버전에서 다룬다.

// 특성의 change 이벤트에 발행 훅을 건다.
// ★멱등 보장: 같은 특성에 두 번 붙지 않게 마커를 실제로 남긴다. 상위(_boundAccessoryIds)가
//   중복 attach를 막지만, 방어를 한 곳에만 두면 그 가드가 리팩터링될 때 리스너가 특성마다
//   누적된다(HAP maxListeners 경고 + 발행 배수). 여기서도 자체 방어한다(적대 감사 3중 지적).
function onChange(service, characteristic, handler) {
  if (!service || !characteristic) return;
  let char;
  try { char = service.getCharacteristic(characteristic); } catch (e) { return; }
  if (!char) return;
  if (!char.__km81MqttHooked) char.__km81MqttHooked = new Set();
  if (char.__km81MqttHooked.has(handler)) return;
  char.__km81MqttHooked.add(handler);
  char.on('change', handler);
}

function has(service, characteristic) {
  try { return !!service && service.testCharacteristic(characteristic); }
  catch (e) { return false; }
}

function valueOf(service, characteristic, fallback = null) {
  try {
    const v = service.getCharacteristic(characteristic).value;
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

/**
 * 승준 에어컨(신형) 연결.
 * @returns {boolean} 연결 성공 여부
 */
function attachSmartAc({ bridge, api, log, accessory, logic, configDevice, slug }) {
  const C = api.hap.Characteristic;
  const S = api.hap.Service;
  const main = accessory.getService(S.HeaterCooler);
  if (!main) {
    log.warn(`[MQTT] '${accessory.displayName}' 주 서비스를 찾지 못해 중계하지 않습니다.`);
    return false;
  }

  // 무풍·자동건조는 설정에 따라 **별도 액세서리의 스위치**로 노출된다(exposeWindFreeSwitch 등).
  // 스위치가 없으면 주 서비스의 SwingMode / LockPhysicalControls가 같은 값을 들고 있다.
  const linked = logic && logic._linkedSwitchServices ? logic._linkedSwitchServices : {};
  const windSvc = linked.windFree || null;
  const cleanSvc = linked.autoClean || null;

  const windTarget = windSvc
    ? { svc: windSvc, char: C.On, on: true, off: false }
    : (has(main, C.SwingMode) ? { svc: main, char: C.SwingMode, on: 1, off: 0 } : null);
  const cleanTarget = cleanSvc
    ? { svc: cleanSvc, char: C.On, on: true, off: false }
    : (has(main, C.LockPhysicalControls) ? { svc: main, char: C.LockPhysicalControls, on: 1, off: 0 } : null);

  // on 센티넬이 boolean(true)이거나 number(1)이라 느슨한 비교를 쓰던 것을, 타입 무관하게
  // "참 같은 값"으로 명시 판정한다(향후 값 표현이 바뀌어도 조용히 오판하지 않게).
  const isOn = (t) => {
    if (!t) return false;
    const v = valueOf(t.svc, t.char, false);
    return v === true || v === 1 || v === t.on;
  };
  const read = () => ({
    power: valueOf(main, C.Active, 0) === 1,
    currentTemp: valueOf(main, C.CurrentTemperature, null),
    coolingSetpoint: valueOf(main, C.CoolingThresholdTemperature, null),
    windFree: isOn(windTarget),
    autoClean: isOn(cleanTarget),
  });

  // 여러 특성이 한 번에 바뀌면(폴링 1회에 전원+온도 동시 변경) 발행이 여러 번 나간다.
  // 같은 tick으로 모아 1회만 내보낸다 — 브로커·HA 부하와 로그를 줄인다.
  let pending = false;
  const emit = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      try { bridge.publishSmartAcState(slug, read()); }
      catch (e) { log.debug?.(`[MQTT] 상태 발행 오류(${slug}): ${e && e.message}`); }
    });
  };

  onChange(main, C.Active, emit);
  onChange(main, C.CurrentTemperature, emit);
  onChange(main, C.CoolingThresholdTemperature, emit);
  if (windTarget) onChange(windTarget.svc, windTarget.char, emit);
  if (cleanTarget) onChange(cleanTarget.svc, cleanTarget.char, emit);

  // ★명령 통로 — setValue가 액세서리의 'set' 핸들러를 그대로 호출한다.
  //   즉 HA에서의 조작과 홈킷에서의 조작이 문자 그대로 같은 코드를 탄다.
  const setChar = async (kind, value) => {
    switch (kind) {
      case 'power':
        main.getCharacteristic(C.Active).setValue(value ? 1 : 0);
        break;
      case 'temperature': {
        const ch = main.getCharacteristic(C.CoolingThresholdTemperature);
        // 기기 허용 범위를 벗어난 값은 HomeKit이 조용히 잘라내므로 미리 맞춘다.
        const p = ch.props || {};
        let v = value;
        if (Number.isFinite(p.minValue)) v = Math.max(v, p.minValue);
        if (Number.isFinite(p.maxValue)) v = Math.min(v, p.maxValue);
        ch.setValue(v);
        break;
      }
      case 'windfree':
        if (!windTarget) { log.debug?.('[MQTT] 무풍 대상이 없어 무시'); return; }
        windTarget.svc.getCharacteristic(windTarget.char).setValue(value ? windTarget.on : windTarget.off);
        break;
      case 'autoclean':
        if (!cleanTarget) { log.debug?.('[MQTT] 자동건조 대상이 없어 무시'); return; }
        cleanTarget.svc.getCharacteristic(cleanTarget.char).setValue(value ? cleanTarget.on : cleanTarget.off);
        break;
      default:
        log.debug?.(`[MQTT] 알 수 없는 명령: ${kind}`);
    }
  };

  const tempProps = (() => {
    try { return main.getCharacteristic(C.CoolingThresholdTemperature).props || {}; }
    catch (e) { return {}; }
  })();

  bridge.registerSmartAc({
    slug,
    label: accessory.displayName,
    model: configDevice && configDevice.model,
    minTemp: tempProps.minValue,
    maxTemp: tempProps.maxValue,
    setChar,
    // 대상 특성이 있을 때만 스위치를 노출한다(없으면 유령 컨트롤). 승준 기기는 둘 다 있음(실측).
    hasWindFree: !!windTarget,
    hasAutoClean: !!cleanTarget,
  });
  emit();   // 초기값을 즉시 채운다(HA가 붙는 순간 값이 비어 있지 않도록)
  return true;
}

/**
 * 세탁기·건조기 연결 — 읽기 전용.
 * 기기가 코스·시작 같은 원격 명령을 받지 않으므로 명령 토픽을 만들지 않는다.
 */
function attachLaundry({ bridge, api, log, accessory, configDevice, slug, kind }) {
  const C = api.hap.Characteristic;
  const S = api.hap.Service;
  const valve = accessory.getService(S.Valve);
  if (!valve) {
    log.warn(`[MQTT] '${accessory.displayName}' 밸브 서비스를 찾지 못해 중계하지 않습니다.`);
    return false;
  }

  // 액세서리의 3-상태 분류가 이 두 특성에 그대로 담겨 있다.
  //   Active = 사이클이 걸려 있음(운전 ∪ 일시정지) / InUse = 지금 동작 중(운전)
  // ★세탁기 전원이 꺼져 있으면 액세서리가 '대기'로 합성해 준다 — 그것이 상태값이며,
  //   availability(브리지 생존)와는 무관하다.
  const read = () => {
    const active = valueOf(valve, C.Active, 0) === 1;
    const inUse = valueOf(valve, C.InUse, 0) === 1;
    const remainSec = Number(valueOf(valve, C.RemainingDuration, 0)) || 0;
    const state = inUse ? 'running' : (active ? 'paused' : 'finished');
    return { state, remainingMin: Math.round(remainSec / 60) };
  };

  let pending = false;
  const emit = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      try { bridge.publishLaundryState(slug, read()); }
      catch (e) { log.debug?.(`[MQTT] 상태 발행 오류(${slug}): ${e && e.message}`); }
    });
  };

  onChange(valve, C.Active, emit);
  onChange(valve, C.InUse, emit);
  onChange(valve, C.RemainingDuration, emit);

  bridge.registerLaundry({
    slug,
    label: accessory.displayName,
    model: configDevice && configDevice.model,
    kind,
  });
  emit();
  return true;
}

module.exports = { attachSmartAc, attachLaundry };
