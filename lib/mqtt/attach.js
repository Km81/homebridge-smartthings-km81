'use strict';

// 액세서리 ↔ MQTT 브리지 연결 (v2.6.0)
//
// ★설계 원칙: **액세서리 코드를 수정하지 않는다.** v2.4.6에서 검증된 동작을 보존한다.
//   - 제어값(전원·온도·무풍·자동청소)은 HomeKit 특성의 `change` 이벤트를 미러하고,
//     명령은 같은 특성에 `setValue`로 넣어 안전 로직(끄기 억제창·직렬화·켜기 후속 체인)을
//     그대로 재사용한다.
//   - 모니터링값(전력·습도·필터·진행률·정확한 남은시간·에너지)은 HomeKit 특성에 없으므로,
//     액세서리가 이미 들고 있는 **로컬 클라이언트 인스턴스**(logic.smartthings)를 통해
//     주기 조회한다. 같은 인스턴스라 조회가 `_serialize` 큐를 공유해 세션 충돌이 없다.
//   - 조명은 재점등 위험이 없어 클라이언트로 직접 제어(setLight).

const SEC = 1000;
const { classifyComponent } = require('../accessories/Laundry');

// 세탁물 운전 상태 — 홈브릿지 정본 판정기(Laundry.classifyComponent)에 위임하고 MQTT
// 어휘로만 옮긴다. v2.6.3까지는 여기서 판정 집합을 따로 정의해서 run+none
// (드럼 정지·문 열기 전) 조합이 홈킷은 '완료'인데 MQTT만 '운전 중'에 영구 고착됐다
// (2026-07-30 건조기 실사이클에서 실측·st 방 규명 — 정본은 종료계열 jobState를 먼저 본다).
const MQTT_STATE = { RUNNING: 'running', PAUSED: 'paused', FINISHED: 'finished', UNKNOWN: 'unknown' };
function laundryStateOf(compsMain) {
  return MQTT_STATE[classifyComponent(compsMain || null)] || 'unknown';
}

function onChange(service, characteristic, handler, key) {
  if (!service || !characteristic) return;
  let char;
  try { char = service.getCharacteristic(characteristic); } catch (e) { return; }
  if (!char) return;
  // 멱등: 같은 (특성,key) 조합에 두 번 붙지 않는다. 문자열 key로 식별(클로저 정체성 무관).
  if (!char.__km81MqttKeys) char.__km81MqttKeys = new Set();
  if (char.__km81MqttKeys.has(key)) return;
  char.__km81MqttKeys.add(key);
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

// 로컬 클라이언트에 모니터링 조회 메서드가 있는지(로컬 전송 기기만 있다).
function isLocalClient(client) {
  return !!client && typeof client.getEnergy === 'function';
}

function attachSmartAc({ bridge, api, log, accessory, logic, configDevice, slug, platform }) {
  const C = api.hap.Characteristic;
  const S = api.hap.Service;
  const main = accessory.getService(S.HeaterCooler);
  if (!main) { log.warn(`[MQTT] '${accessory.displayName}' 주 서비스를 찾지 못해 중계하지 않습니다.`); return false; }

  const linked = logic && logic._linkedSwitchServices ? logic._linkedSwitchServices : {};
  const windSvc = linked.windFree || null;
  const cleanSvc = linked.autoClean || null;
  // ⚠️메인 SwingMode를 무풍 대용으로 쓰는 건 **스윙이 무풍에 묶였을 때만** 옳다.
  //   v2.9.0부터 스윙 토글이 **바람방향**에 묶일 수 있는데, 그걸 모르고 폴백하면
  //   HA의 '무풍' 스위치를 켰을 때 무풍이 아니라 **바람방향 명령**이 나가고,
  //   방향 스윙이 켜져 있으면 HA가 무풍 ON으로 **허위 보고**한다(적대 리뷰 H1).
  const SmartACClass = require('../accessories/SmartAC');
  const swingIsDirection = !!(logic && SmartACClass.SWING_DIRECTIONS
    && SmartACClass.SWING_DIRECTIONS.includes(logic._swingBinding));
  const windTarget = windSvc
    ? { svc: windSvc, char: C.On, on: true, off: false }
    : (!swingIsDirection && has(main, C.SwingMode)
      ? { svc: main, char: C.SwingMode, on: 1, off: 0 } : null);
  if (!windSvc && swingIsDirection) {
    log.debug?.(`[MQTT] '${accessory.displayName}' 스윙이 바람방향에 묶여 있어 무풍은 중계하지 않습니다`
      + ` (무풍을 HA에 노출하려면 설정의 '무풍 스위치 노출'을 켜세요)`);
  }
  const cleanTarget = cleanSvc
    ? { svc: cleanSvc, char: C.On, on: true, off: false }
    : (has(main, C.LockPhysicalControls) ? { svc: main, char: C.LockPhysicalControls, on: 1, off: 0 } : null);

  const client = logic ? logic.smartthings : null;
  const deviceId = accessory.context && accessory.context.device && accessory.context.device.deviceId;
  const local = isLocalClient(client);   // 조명·모니터링은 로컬 기기에서만

  const isOn = (t) => {
    if (!t) return false;
    const v = valueOf(t.svc, t.char, false);
    return v === true || v === 1 || v === t.on;
  };
  const readCtl = () => ({
    power: valueOf(main, C.Active, 0) === 1,
    currentTemp: valueOf(main, C.CurrentTemperature, null),
    coolingSetpoint: valueOf(main, C.CoolingThresholdTemperature, null),
    windFree: isOn(windTarget),
    autoClean: isOn(cleanTarget),
  });

  // 제어값 발행(특성 변화 미러) — tick 합침.
  let pending = false;
  const emitCtl = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      try { bridge.publishSmartAcState(slug, readCtl()); }
      catch (e) { log.debug?.(`[MQTT] 상태 발행 오류(${slug}): ${e && e.message}`); }
    });
  };
  onChange(main, C.Active, emitCtl, `${slug}:active`);
  onChange(main, C.CurrentTemperature, emitCtl, `${slug}:curtemp`);
  onChange(main, C.CoolingThresholdTemperature, emitCtl, `${slug}:settemp`);
  if (windTarget) onChange(windTarget.svc, windTarget.char, emitCtl, `${slug}:wind`);
  if (cleanTarget) onChange(cleanTarget.svc, cleanTarget.char, emitCtl, `${slug}:clean`);

  // 명령 통로.
  const setChar = async (kind, value) => {
    switch (kind) {
      case 'power': main.getCharacteristic(C.Active).setValue(value ? 1 : 0); break;
      case 'temperature': {
        const ch = main.getCharacteristic(C.CoolingThresholdTemperature);
        const p = ch.props || {};
        let v = value;
        if (Number.isFinite(p.minValue)) v = Math.max(v, p.minValue);
        if (Number.isFinite(p.maxValue)) v = Math.min(v, p.maxValue);
        ch.setValue(v);
        break;
      }
      case 'windfree':
        if (!windTarget) { log.debug?.('[MQTT] 무풍 대상 없음'); return; }
        windTarget.svc.getCharacteristic(windTarget.char).setValue(value ? windTarget.on : windTarget.off);
        break;
      case 'autoclean':
        if (!cleanTarget) { log.debug?.('[MQTT] 자동건조 대상 없음'); return; }
        cleanTarget.svc.getCharacteristic(cleanTarget.char).setValue(value ? cleanTarget.on : cleanTarget.off);
        break;
      case 'light':
        // 조명은 HomeKit 특성이 아니라 로컬 클라이언트로 직접(재점등 위험 없음).
        if (!local || typeof client.setLight !== 'function') { log.debug?.('[MQTT] 조명 제어 미지원'); return; }
        await client.setLight(deviceId, !!value);
        // 낙관 반영 후 다음 폴에서 실측 갱신.
        bridge.publishSmartAcSensors(slug, { light: !!value });
        break;
      case 'sound':
        // 효과음(조작 수신음) — mode options의 Volume_* (2026-07-30 왕복 실측). 단독 전송.
        if (!local || typeof client.setSoundEffect !== 'function') { log.debug?.('[MQTT] 효과음 제어 미지원'); return; }
        await client.setSoundEffect(deviceId, !!value);
        bridge.publishSmartAcSensors(slug, { sound: !!value });
        break;
      default: log.debug?.(`[MQTT] 알 수 없는 명령: ${kind}`);
    }
  };

  const tempProps = (() => {
    try { return main.getCharacteristic(C.CoolingThresholdTemperature).props || {}; }
    catch (e) { return {}; }
  })();

  bridge.registerSmartAc({
    slug, label: accessory.displayName, model: configDevice && configDevice.model,
    minTemp: tempProps.minValue, maxTemp: tempProps.maxValue, tempStep: tempProps.minStep, setChar,
    hasWindFree: !!windTarget, hasAutoClean: !!cleanTarget, hasLight: local, hasSound: local,
  });
  emitCtl();

  // ── 모니터링 폴러(로컬 기기만) ──
  if (local && deviceId) {
    const stopped = { v: false };
    let busy = false;   // in-flight 가드 — 저하 시 조회 적체·명령 지연 방지(적대 감사 MEDIUM-2)
    const pollSensors = async () => {
      if (stopped.v || busy) return;
      busy = true;
      try {
        const [energy, humidity, filter, light, sound] = await Promise.all([
          client.getEnergy(deviceId), client.getHumidity(deviceId),
          client.getFilterUsage(deviceId), client.getLight(deviceId),
          client.getSoundEffect(deviceId),
        ]);
        bridge.publishSmartAcSensors(slug, {
          power_w: energy ? energy.power_w : null,
          cumulative_kwh: energy ? energy.cumulative_kwh : null,
          humidity: humidity,
          filter_percent: filter ? filter.percent : null,
          light: (light === true || light === false) ? light : undefined,
          sound: (sound === true || sound === false) ? sound : undefined,
        });
      } catch (e) { log.debug?.(`[MQTT] 승준 모니터링 폴 오류: ${e && e.message}`); }
      finally { busy = false; }
    };
    // ★사용자가 폴링을 명시적으로 끈 기기(pollingInterval 0/음수 — SmartAC의 '비활성' 규약)는
    //   모니터링 폴러도 돌리지 않는다. 예전엔 그 경우에도 60초마다 4개 리소스를 조회해
    //   "폴링 끄기" 의도를 어겼다(적대 감사 LOW-1). 미지정(빈 값)일 때만 기본 60초.
    const raw = configDevice ? configDevice.pollingInterval : undefined;
    const n = Number(raw);
    const disabled = raw != null && raw !== '' && Number.isFinite(n) && n <= 0;
    if (disabled) {
      log.debug?.(`[MQTT] '${accessory.displayName}' 폴링이 꺼져 있어 모니터링 센서를 갱신하지 않습니다.`);
    } else {
      const sec = Number.isFinite(n) && n >= 15 ? n : 60;
      const timer = setInterval(pollSensors, sec * SEC);
      if (timer.unref) timer.unref();
      if (platform && typeof platform.registerShutdown === 'function') platform.registerShutdown(() => { stopped.v = true; clearInterval(timer); });
      setTimeout(pollSensors, 3 * SEC).unref?.();   // 첫 회는 3초 뒤(부팅 혼잡 회피)
    }
  }

  return true;
}

function attachLaundry({ bridge, api, log, accessory, logic, configDevice, slug, kind, platform }) {
  const C = api.hap.Characteristic;
  const S = api.hap.Service;
  const valve = accessory.getService(S.Valve);
  if (!valve) { log.warn(`[MQTT] '${accessory.displayName}' 밸브 서비스를 찾지 못해 중계하지 않습니다.`); return false; }

  const client = logic ? logic.smartthings : null;
  const deviceId = accessory.context && accessory.context.device && accessory.context.device.deviceId;
  const local = isLocalClient(client);   // 건조기(DTLS)=true, 세탁기(8888)=false

  // HomeKit Valve는 남은시간을 60분으로 캡한다 → HA에는 정확한 값을 주기 위해 로컬 getStatus를
  // 직접 폴한다(로컬 기기). 세탁기(8888)는 그 경로가 없어 Valve 특성 미러로 대체(60분 상한 감수).
  const readFromValve = () => {
    const active = valueOf(valve, C.Active, 0) === 1;
    const inUse = valueOf(valve, C.InUse, 0) === 1;
    const remainSec = Number(valueOf(valve, C.RemainingDuration, 0)) || 0;
    return {
      state: inUse ? 'running' : (active ? 'paused' : 'finished'),
      remainingMin: Math.round(remainSec / 60),
    };
  };

  let pending = false;
  const emitValve = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      try { bridge.publishLaundryState(slug, readFromValve()); }
      catch (e) { log.debug?.(`[MQTT] 상태 발행 오류(${slug}): ${e && e.message}`); }
    });
  };

  bridge.registerLaundry({
    slug, label: accessory.displayName, model: configDevice && configDevice.model, kind,
    hasProgress: local, hasEnergy: local,   // 8888 세탁기는 진행률·에너지 미지원(실측)
  });

  if (local && deviceId) {
    // 로컬 기기(건조기): getStatus(localOnly)로 raw 남은시간·진행률 + getEnergy를 직접 폴.
    // ★Valve 미러(onChange)는 여기서 부착하지 않는다 — 폴러와 이중 발행되면 남은시간이
    //   60(Valve 상한)↔raw로 요동친다(적대 감사 HIGH-2). 로컬은 폴러가 유일 소스.
    const stopped = { v: false };
    let busy = false;   // in-flight 가드 — 저하 시 _serialize 큐 적체·명령 지연 방지(HIGH? MEDIUM-2)
    const pollLocal = async () => {
      if (stopped.v || busy) return;
      busy = true;
      try {
        const comps = await client.getStatus(deviceId, { localOnly: true });   // 폴백 없음(MEDIUM-3)
        const op = comps?.main?.dryerOperatingState || comps?.main?.washerOperatingState || {};
        const remainRaw = Number(op.remainingMinRaw?.value);
        const prog = Number(op.progressPercentage?.value);
        let energy = null;
        try { energy = await client.getEnergy(deviceId); } catch (e) {}
        bridge.publishLaundryState(slug, {
          state: laundryStateOf(comps?.main),
          remainingMin: Number.isFinite(remainRaw) ? remainRaw : 0,
          progress: Number.isFinite(prog) ? prog : null,
          cumulative_kwh: energy ? energy.cumulative_kwh : null,
        });
      } catch (e) { log.debug?.(`[MQTT] ${kind} 모니터링 폴 오류: ${e && e.message}`); }
      finally { busy = false; }
    };
    const raw = Number(configDevice && configDevice.sensorPollInterval);
    const sec = Number.isFinite(raw) && raw >= 10 ? raw : 30;
    const timer = setInterval(pollLocal, sec * SEC);
    if (timer.unref) timer.unref();
    if (platform && typeof platform.registerShutdown === 'function') platform.registerShutdown(() => { stopped.v = true; clearInterval(timer); });
    setTimeout(pollLocal, 4 * SEC).unref?.();
  } else {
    // 8888 세탁기(로컬 폴 경로 없음): Valve 특성 미러가 유일 소스(남은시간 60분 상한 감수).
    onChange(valve, C.Active, emitValve, `${slug}:active`);
    onChange(valve, C.InUse, emitValve, `${slug}:inuse`);
    onChange(valve, C.RemainingDuration, emitValve, `${slug}:remain`);
    emitValve();
  }

  return true;
}

module.exports = { attachSmartAc, attachLaundry, laundryStateOf };
