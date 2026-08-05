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

// ─────────────────────────────────────────────────────────────────────────────
// ★티어 폴러 (2026-08-04)
//
// 왜: 예전엔 기기당 폴러가 하나뿐이라 **모든 값을 같은 주기로** 읽었다. 그런데 값마다
//   변화 속도가 전혀 다르다 — 진행률은 분 단위로 움직이고, 필터 사용률은 며칠에 1%다.
//   같은 주기로 읽으면 **빠른 값은 답답하고 느린 값은 낭비**다.
//
//   fast : 사람 조작·환경 변화 (기본 60초)
//   slow : 거의 안 변하는 것 — 필터·알람·설정값·자가진단 (기본 30분)
//
// ⚠️`interval` 이 함수면 **매 회차마다 다시 묻는다** → 상태에 따라 주기를 바꿀 수 있다
//   (건조기: 대기 중 60초 / 가동 중 10초). 고정 숫자면 그대로 쓴다.
// ⚠️in-flight 가드 필수 — 기기가 느려지면 조회가 적체돼 **사용자 명령이 뒤로 밀린다**.
function startPoller({ name, log, platform, run, interval, firstDelaySec = 3 }) {
  const state = { stopped: false, busy: false, timer: null };
  const nextSec = () => {
    const v = (typeof interval === 'function') ? interval() : interval;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 60;
  };
  const tick = async () => {
    state.timer = null;
    if (state.stopped) return;
    if (!state.busy) {
      state.busy = true;
      try { await run(); }
      catch (e) { log.debug?.(`[MQTT] ${name} 폴 오류: ${e && e.message}`); }
      finally { state.busy = false; }
    }
    if (state.stopped) return;
    state.timer = setTimeout(tick, nextSec() * SEC);
    state.timer.unref?.();
  };
  state.timer = setTimeout(tick, firstDelaySec * SEC);
  state.timer.unref?.();
  if (platform && typeof platform.registerShutdown === 'function') {
    platform.registerShutdown(() => {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    });
  }
  return state;
}

// 느린 티어 기본값 — 필터·알람·설정값처럼 며칠에 한 번 움직이는 값들.
const SLOW_SEC = 30 * 60;
// 가동 중 목표 주기와 하한. ⚠️사용자가 명시한 주기보다 빠르게 두드리지 않는다.
const BUSY_TARGET_SEC = 10;
const BUSY_MIN_SEC = 10;
// 연속 실패가 이만큼 쌓이면 가동 티어에서 내려온다(죽은 기기를 10초마다 때리지 않는다).
const BUSY_FAIL_GIVEUP = 3;
// 정수기 사망 경보 임계 — 홈킷 기기의 LOCAL_DEAD_AFTER 와 같은 값(60초 폴이면 10분).
const PURIFIER_DEAD_AFTER = 10;

// 기기와 마지막으로 실제 통신에 성공한 시각을 HA 에 넘긴다(ISO 8601, `Z` 포함).
// ⚠️`device_class: timestamp` 는 **오프셋이 있는 시각**을 요구한다 — `toISOString()` 이 `Z` 를
//   붙이므로 안전하다. 붙이지 않으면 HA 가 로컬시각으로 읽어 9시간 어긋난다(정수기에서 겪음).
// 값이 없으면(아직 한 번도 성공 못 함) `null` 을 흘려 HA 에서 unknown 이 되게 한다.
function lastSeenOf(client, deviceId) {
  if (!client || typeof client._stat !== 'function' || !deviceId) return undefined;
  try {
    const ms = client._stat(deviceId).lastOk;
    return ms ? new Date(ms).toISOString() : null;
  } catch (e) { return undefined; }
}

// ★getter 3분기를 소비자 쪽에서 지키는 헬퍼(2026-08-05 적대 리뷰).
//
//   실패(undefined) → undefined 그대로 = 옛 값 유지(못 읽은 것을 지우면 안 된다)
//   빈 값(null)     → null            = 키 삭제(값이 사라졌으면 HA 에서도 지워야 한다)
//   값              → pick(v)
//
// ⚠️이걸 손으로 쓰면 반드시 한쪽을 빠뜨린다 — 실제로 21개 getter 중 15개가 어기고 있었고,
//   증상은 매번 같았다(값이 사라져도 HA 센서가 옛 값에 영구 고착).
function relay(v, pick) {
  if (v === undefined) return undefined;      // 조회 실패 — 손대지 않는다
  if (v === null) return null;                // 조회 성공·빈 값 — 지운다
  const out = pick ? pick(v) : v;
  return out === undefined ? null : out;      // 하위 필드가 없으면 그것도 '빈 값'이다
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
    // 모니터링 센서 13종을 채우는 폴러는 로컬 경로가 있을 때만 돈다(아래 `if (local && deviceId)`).
    hasMonitor: local && !!deviceId,
  });
  emitCtl();

  // ── 모니터링 폴러(로컬 기기만) — 2026-08-04 부터 **두 티어** ──
  if (local && deviceId) {
    // ★사용자가 폴링을 명시적으로 끈 기기(pollingInterval 0/음수)는 모니터링도 안 돈다
    //   (적대 감사 LOW-1: "폴링 끄기" 의도를 어기면 안 된다).
    const raw = configDevice ? configDevice.pollingInterval : undefined;
    const n = Number(raw);
    const disabled = raw != null && raw !== '' && Number.isFinite(n) && n <= 0;

    if (disabled) {
      log.debug?.(`[MQTT] '${accessory.displayName}' 폴링이 꺼져 있어 모니터링 센서를 갱신하지 않습니다.`);
    } else {
      const fastSec = Number.isFinite(n) && n >= 15 ? n : 60;
      // ⚠️설정값이 하한(15초)에 막혀 무시되면 **말해 준다** — 10을 적어 뒀는데 60으로 도는 걸
      //   모르면 "왜 안 따라오지?"로 헤맨다(2026-08-04).
      if (Number.isFinite(n) && n > 0 && n < 15) {
        log.info(`[MQTT] '${accessory.displayName}' 모니터링 주기는 최소 15초입니다 — `
          + `설정 ${n}초 대신 ${fastSec}초로 돕니다(홈킷 상태 폴링은 설정대로 ${n}초).`);
      }

      // fast — 사람 조작·환경 변화
      startPoller({
        name: `${slug} fast`, log, platform, interval: fastSec,
        run: async () => {
          const [energy, humidity, light, sound, mode, wind, conv] = await Promise.all([
            client.getEnergy(deviceId), client.getHumidity(deviceId),
            client.getLight(deviceId), client.getSoundEffect(deviceId),
            typeof client.getMode === 'function' ? client.getMode(deviceId) : Promise.resolve(null),
            typeof client.getWindStrength === 'function' ? client.getWindStrength(deviceId) : Promise.resolve(null),
            typeof client.getConvenientMode === 'function' ? client.getConvenientMode(deviceId) : Promise.resolve(null),
          ]);
          bridge.publishSmartAcSensors(slug, {
            // ⚠️전력·습도는 예전에 `energy ? … : null` 이라 **조회 실패에도 키를 지웠다** —
            //   순단 1회에 HA 전력·습도 이력에 구멍이 났고, energy_kwh 는 total_increasing 이라
            //   장기 통계까지 오염됐다. 실패는 유지, 빈 값만 지운다.
            power_w: relay(energy, (e) => e.power_w),
            cumulative_kwh: relay(energy, (e) => e.cumulative_kwh),
            humidity: relay(humidity),
            light: relay(light),
            sound: relay(sound),
            // 기기 실제 운전 모드(홈킷은 냉방/끔뿐이고 coolModeCommand 때문에 실모드가 다를 수 있다)
            mode_actual: relay(mode),
            // ★아래 둘은 홈킷에 자리가 없어 그동안 **아무 데도 안 가던** 값이다.
            wind_strength: relay(wind, (w) => w.label),
            convenient_mode: relay(conv),
            // ★가장 짧은 주기(fast)에 싣는다 — 기기 생사 판정이 목적이므로 slow 티어 값이
            //   따로 실패해도 '살아 있음'은 fast 가 대표한다.
            last_seen: lastSeenOf(client, deviceId),
          });
        },
      });

      // slow — 며칠에 한 번 움직이는 값. 30분이면 충분하고, 기기를 덜 두드린다.
      startPoller({
        name: `${slug} slow`, log, platform, interval: SLOW_SEC, firstDelaySec: 12,
        run: async () => {
          const [filter, clean, alarm, self, sleep] = await Promise.all([
            client.getFilterUsage(deviceId),
            typeof client.getAutoCleanProgress === 'function' ? client.getAutoCleanProgress(deviceId) : Promise.resolve(null),
            typeof client.getAlarm === 'function' ? client.getAlarm(deviceId) : Promise.resolve(null),
            typeof client.getSelfCheck === 'function' ? client.getSelfCheck(deviceId) : Promise.resolve(null),
            typeof client.getAiSleep === 'function' ? client.getAiSleep(deviceId) : Promise.resolve(null),
          ]);
          bridge.publishSmartAcSensors(slug, {
            filter_percent: relay(filter, (f) => f.percent),
            // ⚠️★"안 온 값(undefined)"과 "빈 값(null)"을 섞으면 안 된다(적대 리뷰 M-1).
            //   `alarm.code` 는 알람이 **해제되면 null** 이 온다 — 그건 성공한 조회의 빈 값이다.
            //   그걸 undefined 로 바꾸면 발행이 건너뛰어 **해제된 알람 코드가 영영 남는다.**
            //   자동건조 진행률도 같다(끝나면 null → 60% 에서 고착).
            //   오늘 `MqttBridge` 에 적은 규칙을 정작 **공급자 쪽이 어기고 있었다.**
            autoclean_progress: relay(clean, (c) => c.progress),
            autoclean_running: relay(clean, (c) => c.running),
            alarm_code: relay(alarm, (a) => a.code || null),
            alarm_ok: relay(alarm, (a) => a.ok),
            selfcheck_status: relay(self, (x) => x.status),
            night_mode: relay(sleep, (x) => x.night_mode),             // 열대야쾌면(빈 값은 null)
            night_elapsed: relay(sleep, (x) => x.elapsed),             // ⚠️단위 미검증 — 원값
          });
        },
      });
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
    // 8888 세탁기는 진행률·에너지·상세값을 읽을 경로가 아예 없다(실측). 등록만 하면
    // HA 에 값이 영영 안 채워지는 엔티티가 남으므로 로컬 폴 경로가 있을 때만 켠다.
    hasProgress: local, hasEnergy: local, hasDetail: local,
  });

  if (local && deviceId) {
    // 로컬 기기(건조기): getStatus(localOnly)로 raw 남은시간·진행률 + getEnergy를 직접 폴.
    // ★Valve 미러(onChange)는 여기서 부착하지 않는다 — 폴러와 이중 발행되면 남은시간이
    //   60(Valve 상한)↔raw로 요동친다(적대 감사 HIGH-2). 로컬은 폴러가 유일 소스.
    // ⚠️in-flight 가드와 종료 처리는 이제 `startPoller` 안에 있다(중복 제거).
    //   기기가 느려지면 조회가 적체돼 `_serialize` 큐에서 **사용자 명령이 뒤로 밀린다**
    //   — 그 보호는 그대로 유지된다.
    // ★가동 중인지 기억한다 — 주기를 여기에 맞춰 바꾼다(적응형).
    //   대기 중에 10초로 두드리는 건 낭비고, 가동 중에 60초는 답답하다.
    let running = false;
    let failStreak = 0;

    const pollLocal = async () => {
      const comps = await client.getStatus(deviceId, { localOnly: true });   // 폴백 없음(MEDIUM-3)
      const op = comps?.main?.dryerOperatingState || comps?.main?.washerOperatingState || {};
      // ⚠️`Number(null) === 0` 이다. 기기가 필드를 **빈 값으로** 주면(있는데 value 가 null)
      //   진행률 0% · 남은시간 0분이라는 **거짓 값**이 나간다 — 가동 중인데 다 끝난 것처럼 보인다.
      //   "없음"과 "0"은 다르다. 숫자로 바꾸기 전에 빈 값을 먼저 걸러 낸다.
      const numOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
      const remainRaw = numOrNull(op.remainingMinRaw?.value);
      const prog = numOrNull(op.progressPercentage?.value);
      const st = laundryStateOf(comps?.main);
      running = st === 'running';
      failStreak = 0;
      let energy = null;
      try { energy = await client.getEnergy(deviceId); } catch (e) {}
      bridge.publishLaundryState(slug, {
        state: st,
        remainingMin: remainRaw,
        progress: prog,
        cumulative_kwh: relay(energy, (e) => e.cumulative_kwh),
        power_w: relay(energy, (e) => e.power_w),   // 같은 응답에 실려 오던 값(추가 조회 0회)
        last_seen: lastSeenOf(client, deviceId),
      });
    };

    const raw = Number(configDevice && configDevice.sensorPollInterval);
    const idleSec = Number.isFinite(raw) && raw >= 10 ? raw : 60;   // 대기 중
    // ⚠️예전 식 `Math.max(10, Math.min(idleSec, 10))` 은 **입력과 무관하게 항상 10** 이었다
    //   (적대 리뷰 M-3 실측: 10/30/60/120/600 → 전부 10). 기기를 아끼려고 주기를 늘린
    //   사용자의 의도가 **가동 중에는 조용히 12배로 무시**됐다.
    //   가동 중에는 빨리 보고 싶지만, 사용자가 명시한 주기보다 빠르게 두드리진 않는다.
    const busySec = Math.max(BUSY_MIN_SEC, Math.min(idleSec, BUSY_TARGET_SEC));
    startPoller({
      name: `${slug} fast`, log, platform, firstDelaySec: 4,
      // ★함수를 주면 매 회차 다시 묻는다 — 상태가 바뀌면 다음 주기부터 따라간다.
      // ⚠️조회가 계속 실패하면 **가동 티어에서 내려온다**(적대 리뷰 M-2).
      //   `running` 은 성공했을 때만 갱신되므로, 가동 중 기기가 죽으면 latch 가 true 로 남아
      //   10초마다 계속 두드린다 — 실측상 죽은 기기 체인 점유 99.4%, 그때 들어온 사용자
      //   명령이 완료까지 69초를 기다렸다. 빠르게 보려다 정작 조작을 막으면 본말전도다.
      interval: () => (running && failStreak < BUSY_FAIL_GIVEUP ? busySec : idleSec),
      run: async () => {
        try { await pollLocal(); }
        catch (e) { failStreak += 1; throw e; }
      },
    });

    // slow — 거의 안 변하는 값. ★`remoteControlEnabled` 가 여기 있는 게 중요하다:
    //   false 면 **HA 에서 보낸 명령을 기기가 안 받는다.** 그동안 이 사실이
    //   아무 데도 안 나가서, 안 들으면 원인을 짐작할 수가 없었다(2026-08-04 실측: false).
    startPoller({
      name: `${slug} slow`, log, platform, interval: SLOW_SEC, firstDelaySec: 15,
      run: async () => {
        const [remote, kids, setting, alarm, course] = await Promise.all([
          typeof client.getRemoteControl === 'function' ? client.getRemoteControl(deviceId) : Promise.resolve(null),
          typeof client.getKidsLock === 'function' ? client.getKidsLock(deviceId) : Promise.resolve(null),
          typeof client.getDryerSetting === 'function' ? client.getDryerSetting(deviceId) : Promise.resolve(null),
          typeof client.getAlarm === 'function' ? client.getAlarm(deviceId) : Promise.resolve(null),
          typeof client.getDryerCourse === 'function' ? client.getDryerCourse(deviceId) : Promise.resolve(null),
        ]);
        bridge.publishLaundryState(slug, {
          remote_control: relay(remote),
          kids_lock: relay(kids),
          dry_level: relay(setting, (x) => x.dryLevel),
          wrinkle_prevent: relay(setting, (x) => x.wrinklePrevent),
          alarm_code: relay(alarm, (a) => a.code || null),
          alarm_ok: relay(alarm, (a) => a.ok),
          course: relay(course, (c) => c.code || null)
        });
      },
    });
  } else {
    // 8888 세탁기(로컬 폴 경로 없음): Valve 특성 미러가 유일 소스(남은시간 60분 상한 감수).
    // ★`last_seen` 은 액세서리 폴 성공 훅에서 받는다 — 출처가 다른 기기와 **의미가 다르다**
    //   (로컬 DTLS 생사가 아니라 8888/클라우드 경로의 응답 여부). 전달 문서에 명시할 것.
    if (logic && typeof logic === 'object') {
      logic._onPollOk = () => {
        try { bridge.publishLaundryState(slug, { last_seen: new Date().toISOString() }); }
        catch (e) { log.debug?.(`[MQTT] last_seen 발행 오류(${slug}): ${e && e.message}`); }
      };
    }
    onChange(valve, C.Active, emitValve, `${slug}:active`);
    onChange(valve, C.InUse, emitValve, `${slug}:inuse`);
    onChange(valve, C.RemainingDuration, emitValve, `${slug}:remain`);
    emitValve();
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 정수기 — ★홈킷 액세서리가 없다. HA(MQTT)로만 흘린다 (2026-08-04)
//
// 왜 홈킷에 안 넣나: 홈킷에 담을 값어치가 있는 건 잠금 정도인데 사용자가 불필요하다고
//   판단했고, 필터 잔여량·출수량 같은 계량값은 홈킷이 담는 그릇이 아니다(부피 특성이
//   아예 없어 `LightSensor` 같은 **거짓 표시**로 우회해야 한다). HA 는 제대로 담는다.
//
// 주기: 전부 느림(기본 60초). 필터는 며칠에 1%, 살균은 3일에 한 번, 설정값은 사람이
//   바꿀 때만 움직인다. ⚠️예외가 `pouring` 인데 출수는 몇 초라 60초로는 거의 놓친다 —
//   사용자 결정으로 **지금은 세지 않는다**(필요해지면 주기를 당기거나 observe 를 본다).
function attachWaterPurifier({ bridge, log, client, deviceId, configDevice, slug, label, platform }) {
  // ⚠️`slug` 는 충돌 시 null 이다(`_mqttSlug` 가 "이 기기는 중계에서 제외합니다"라고 경고한다).
  //   그 가드가 홈킷 경로(`_attachMqtt`)에만 있어, 정수기는 null 을 그대로 흘려
  //   `km81/appliance/null/state` 로 발행하고 있었다 — 경고문이 거짓이 된다(적대 리뷰 M-4).
  if (!bridge || !client || !deviceId || !slug) return false;

  bridge.registerWaterPurifier({ slug, label, model: configDevice && configDevice.model });

  const raw = Number(configDevice && configDevice.sensorPollInterval);
  const sec = Number.isFinite(raw) && raw >= 15 ? raw : 60;

  // ★★기기 사망을 감지한다(적대 리뷰 H-1).
  //   정수기 getter 는 전부 오류를 삼키고 null 을 돌려주므로 `_withFallback` 의 실패 계정
  //   (연속 실패·사망 경보·복구 짝·24시간 요약 집계)을 **하나도 타지 않는다.**
  //   에어컨·건조기는 홈킷 폴이 그 안전망을 타는데 **정수기는 홈킷 경로가 아예 없다** →
  //   연결 후 기기가 죽으면 **로그 0줄·요약선 제외·HA 는 retained 마지막 값으로 영원히 정상**.
  //   "빠져도 사용자가 못 알아챈다"는 사각이 부팅이 아니라 **운영 중 사망**에서 그대로 열려 있었다.
  //   7/31 에너톡·8/3 로컬 전용과 같은 부류의 **세 번째**다.
  // ⚠️경보와 복구는 반드시 **짝**으로 낸다 — 경보만 내면 hb-watch 🔴가 영원히 안 풀린다.
  let deadStreak = 0;
  let deadAnnounced = false;

  startPoller({
    name: `${slug}`, log, platform, interval: sec, firstDelaySec: 6,
    run: async () => {
      const [filter, status, setting, locks, self, fav] = await Promise.all([
        client.getWaterFilter(deviceId),
        client.getWaterPurifierStatus(deviceId),
        client.getWaterPurifierSetting(deviceId),
        client.getWaterPurifierLocks(deviceId),
        typeof client.getSelfCheck === 'function' ? client.getSelfCheck(deviceId) : Promise.resolve(null),
        typeof client.getFavoriteCapacity === 'function' ? client.getFavoriteCapacity(deviceId) : Promise.resolve(null),
      ]);

      // 여섯이 전부 null = 기기가 응답하지 않는다(부분 실패는 정상 — 리소스가 없는 것일 수 있다).
      const alive = !!(filter || status || setting || locks || self || fav);
      // 24시간 요약선에 정수기도 실린다(`total===0` 이면 요약에서 통째로 빠진다).
      if (typeof client._stat === 'function') {
        const st = client._stat(deviceId);
        if (alive) {
          // ⚠️순단을 세지 않으면 24시간 요약선의 "순단 N건"이 정수기에선 **항상 0**으로 찍힌다
          //   (적대 리뷰). 끊겼다가 돌아온 순간에 한 번 센다.
          if (deadStreak > 0) st.outages = (st.outages || 0) + 1;
          st.ok += 1;
          st.lastOk = Date.now();
        } else st.fail += 1;
      }
      if (!alive) {
        deadStreak += 1;
        if (deadStreak === PURIFIER_DEAD_AFTER && !deadAnnounced) {
          deadAnnounced = true;
          log.error(`[${label}] 로컬 경로가 ${deadStreak}회 연속 실패했고 클라우드 폴백도 꺼져 있습니다 `
            + '— 이 기기는 지금 제어되지 않습니다. 기기 전원과 IP를 확인하세요.');
        }
        return;   // 발행하지 않는다 — 옛 값을 새 값인 척 다시 밀지 않는다
      }
      if (deadStreak > 0) {
        const had = deadStreak;
        deadStreak = 0;
        if (deadAnnounced) {
          deadAnnounced = false;
          log.info(`[${label}] 로컬 복귀 — ${had}회 실패 후 정상화 (클라우드 미사용)`);
        } else {
          log.debug?.(`[${label}] 로컬 순단 ${had}회 후 정상화 (클라우드 미사용)`);
        }
      }

      bridge.publishWaterPurifierState(slug, {
        filter_remain: relay(filter, (x) => x.remain_percent),
        filter_status: relay(filter, (x) => x.status),
        status: relay(status, (x) => x.status),
        filter_door: relay(status, (x) => x.filter_door),
        sterilize_last: relay(status, (x) => x.sterilize_last),
        sterilize_next: relay(status, (x) => x.sterilize_next),
        sterilize_running: relay(status, (x) => x.sterilize_running),
        hot_temp: relay(setting, (x) => x.hot_temp),
        capacity_ml: relay(setting, (x) => x.capacity_ml),
        pouring: relay(setting, (x) => x.pouring),
        lock_hot: relay(locks, (x) => x.hot),
        lock_cold: relay(locks, (x) => x.cold),
        lock_buzz: relay(locks, (x) => x.buzz),
        selfcheck_status: relay(self, (x) => x.status),
        favorite_enabled: relay(fav, (x) => x.enabled),      // 앱의 '나만의 출수량' 토글
        favorite_ml: relay(fav, (x) => x.default_ml),
        last_seen: lastSeenOf(client, deviceId),
      });
    },
  });
  return true;
}

module.exports = { attachSmartAc, attachLaundry, attachWaterPurifier, laundryStateOf };
