'use strict';

// MQTT 브리지 — 로컬로 소유한 삼성 가전을 Home Assistant에 중계한다 (v2.6.0)
//
// ── 왜 이 계층인가 ────────────────────────────────────────────────────────────
// 기기와의 세션은 홈브릿지가 단독 소유해야 한다(DTLS는 기기당 1세션, 구형 8888도
// 동시 연결에 약하다). 그래서 HA는 기기에 직접 붙지 않고 이 브리지가 내보내는
// MQTT만 본다.
//
// ★상태 발행(병합): 한 기기의 상태는 여러 소스에서 부분적으로 온다 —
//   제어값(전원·온도·무풍…)은 HomeKit 특성 미러로, 모니터링값(전력·습도·필터·진행률…)은
//   로컬 클라이언트 주기 조회로. 이 둘을 slug별 상태 객체 하나에 병합해 `.../state`에
//   retain 발행한다(부분 갱신 → 전체 재발행, 변화 없으면 생략).
//
// ★명령: HomeKit 특성 setValue 경유(전원·온도·무풍·자동청소) → 끄기 억제창·직렬화·
//   켜기 후속 체인 재사용. 조명은 재점등 위험이 없어 클라이언트 직접(setLight).
//
// ★availability: 브리지 단일 토픽(LWT). 세탁기 전원 꺼짐은 unavailable이 아니라 상태값.
//
// ★entity_id: HA(2026.7.4) 실측상 payload의 object_id가 무시되고 device 이름 기반으로
//   로마자화된다(climate.seungjun_eeokeon 등). object_id를 넣지 않는다 — 넣어도 효과 없고,
//   HA가 향후 미지원 키를 페이로드째 거부하면 엔티티가 증발할 위험이 있다(적대 감사).
//   결정적이되 로마자인 실측 entity_id를 문서(§7-2)에 기록해 자동화가 참조한다.

const DEFAULT_BASE = 'km81/appliance';
const DEFAULT_DISCOVERY_PREFIX = 'homeassistant';
const DEFAULT_REPUBLISH_SEC = 60;
const MIN_REPUBLISH_SEC = 15;
const ONLINE = 'online';
const OFFLINE = 'offline';

const LAUNDRY_DETAIL_SENSORS = [
  ['kids_lock', '어린이 잠금', 'mdi:account-lock'],
  ['dry_level', '건조 강도', 'mdi:tumble-dryer'],
  ['alarm_code', '기기 알람', 'mdi:alert-circle-outline'],
  ['course', '코스', 'mdi:format-list-numbered'],
];

const LAUNDRY_STATE_TEXT = {
  running: '운전 중',
  paused: '일시정지',
  finished: '대기 중',
  unknown: '확인 중',
};

class MqttBridge {
  constructor(log, cfg = {}, version = '') {
    this.log = log;
    this.version = version;
    this.base = MqttBridge._sanitizeTopicBase(cfg.baseTopic, DEFAULT_BASE, log, '기본 토픽');
    this.discoveryPrefix = MqttBridge._sanitizeTopicBase(cfg.discoveryPrefix, DEFAULT_DISCOVERY_PREFIX, log, 'HA 검색 접두어');
    this.availabilityTopic = `${this.base}/bridge/availability`;

    const sec = Number(cfg.republishInterval);
    this.republishSec = Number.isFinite(sec) && sec > 0 ? Math.max(sec, MIN_REPUBLISH_SEC) : DEFAULT_REPUBLISH_SEC;

    this._cfg = cfg;
    this._client = null;
    this._connected = false;
    this._stopped = false;
    this._republishTimer = null;
    // slug → { kind, label, registered, stateObj:{}, lastPayload, discovery:[{topic,body}] }
    this._entries = new Map();
    this._retractMode = false;   // true 면 discovery 를 빈 페이로드로 발행(회수)
    this._pendingRetract = [];   // 연결 전에 들어온 회수 요청
    this._pendingRetractTopics = [];   // 연결 전에 들어온 엔티티 단위 회수
    this._subs = new Map();
    this._warnedNoLib = false;
    this._connectLogged = false;
  }

  get enabled() {
    return this._cfg && this._cfg.enabled === true;
  }

  static _sanitizeTopicBase(raw, fallback, log, what) {
    const orig = String(raw == null ? '' : raw);
    if (!orig) return fallback.replace(/\/+$/, '');
    const cleaned = orig.replace(/[^A-Za-z0-9_/-]+/g, '').replace(/\/+$/, '').replace(/^\/+/, '');
    if (cleaned !== orig.replace(/\/+$/, '').replace(/^\/+/, '') && log && log.warn) {
      log.warn(`MQTT ${what}에 사용할 수 없는 문자가 있어 정리했습니다: "${orig}" → "${cleaned || fallback}"`);
    }
    return cleaned || fallback.replace(/\/+$/, '');
  }

  // ── 연결 ────────────────────────────────────────────────────────────────
  start() {
    if (!this.enabled || this._stopped) return;
    if (this._client) return;   // 재진입 방어(현재 호출처는 1곳이나 안전망)
    const host = (this._cfg.host || '').trim();
    if (!host) {
      this.log.error('MQTT 브리지를 켰지만 브로커 주소(host)가 비어 있어 시작하지 않습니다.');
      return;
    }

    let mqtt;
    try {
      mqtt = require('mqtt');
    } catch (e) {
      if (!this._warnedNoLib) {
        this._warnedNoLib = true;
        this.log.error('MQTT 라이브러리를 불러오지 못해 브리지를 끕니다 — 홈킷 동작은 영향 없습니다. '
          + '플러그인을 다시 설치하면 해결됩니다.');
      }
      return;
    }

    const port = Number(this._cfg.port) || 1883;
    const url = `mqtt://${host}:${port}`;
    const opts = {
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      clean: true,
      clientId: `homebridge-km81-${Math.random().toString(16).slice(2, 10)}`,
      will: { topic: this.availabilityTopic, payload: OFFLINE, qos: 1, retain: true },
    };
    if (this._cfg.username) opts.username = this._cfg.username;
    if (this._cfg.password) opts.password = this._cfg.password;

    try {
      this._client = mqtt.connect(url, opts);
    } catch (e) {
      this.log.error(`MQTT 연결을 시작할 수 없습니다: ${e.message}`);
      return;
    }

    this._client.on('connect', () => {
      this._connected = true;
      if (!this._connectLogged) {
        this._connectLogged = true;
        this.log.info(`MQTT 브리지 연결됨 — ${host}:${port} (토픽 ${this.base}/…)`);
      } else {
        this.log.debug?.('MQTT 재연결됨');
      }
      this._publish(this.availabilityTopic, ONLINE, { retain: true, qos: 1 });
      // ★회수를 재발행보다 **먼저** 한다 — 순서가 반대면 방금 지운 것이 다시 살아난다.
      if (this._pendingRetractTopics.length) {
        for (const t of this._pendingRetractTopics.splice(0)) {
          this._publish(t, '', { retain: true, qos: 1 });
        }
      }
      if (this._pendingRetract.length) {
        const queued = this._pendingRetract.splice(0);
        for (const r of queued) this.retractDevice(r);
      }
      this._republishDiscovery();
      this._republishState();
      this._resubscribeAll();
    });

    this._client.on('reconnect', () => this.log.debug?.('MQTT 재연결 시도'));
    this._client.on('close', () => { this._connected = false; });
    this._client.on('error', (e) => this.log.debug?.(`MQTT 오류: ${e && e.message}`));
    this._client.on('message', (topic, buf, packet) => this._onMessage(topic, buf, packet));

    if (this._republishTimer) clearInterval(this._republishTimer);
    this._republishTimer = setInterval(() => this._republishState(), this.republishSec * 1000);

    // ★첫 연결이 끝내 안 되면 한 번만 알린다(적대 감사 관측성 지적). 이전엔 error·reconnect가
    //   전부 debug라, 브로커 주소를 잘못 넣어도 기본 로그에서 **완전 무음**이었다 — 오설정을
    //   알 방법이 없었다. 문구는 hb-watch 경보 어휘('연결 실패'·'무응답' 등)를 피해 기기 장애
    //   오탐을 막는다. 1회만 찍어 로그 폭주도 없다.
    const warnTimer = setTimeout(() => {
      if (!this._connected && !this._stopped) {
        this.log.warn(`MQTT 브로커에 아직 접속하지 못했습니다 — 주소·계정을 확인해 주세요(${host}:${port}). `
          + '계속 재시도하며, 붙는 즉시 중계가 시작됩니다. 홈킷 동작에는 영향이 없습니다.');
      }
    }, 60000);
    if (warnTimer.unref) warnTimer.unref();
  }

  stop() {
    this._stopped = true;
    if (this._republishTimer) { clearInterval(this._republishTimer); this._republishTimer = null; }
    const client = this._client;
    this._client = null;
    this._connected = false;
    if (!client) return;
    try {
      // 정상 종료 OFFLINE을 드레인 후 닫는다(force end는 flush 전 폐기 위험). 콜백이 안 와도
      // 3초 뒤 강제 종료해 매달리지 않게 한다(비정상 종료면 LWT가 OFFLINE을 대신 발행).
      client.publish(this.availabilityTopic, OFFLINE, { retain: true, qos: 1 }, () => {
        try { client.end(false); } catch (e) {}
      });
      const t = setTimeout(() => { try { client.end(true); } catch (e) {} }, 3000);
      if (t.unref) t.unref();
    } catch (e) {
      this.log.debug?.(`MQTT 종료 오류: ${e && e.message}`);
      try { client.end(true); } catch (e2) {}
    }
  }

  // ── 내부 유틸 ───────────────────────────────────────────────────────────
  _publish(topic, payload, opts = {}) {
    if (!this._client || !this._connected) return false;
    try {
      this._client.publish(topic, payload, { qos: 0, retain: false, ...opts });
      return true;
    } catch (e) {
      this.log.debug?.(`MQTT 발행 실패(${topic}): ${e && e.message}`);
      return false;
    }
  }

  _subscribe(topic, handler) {
    this._subs.set(topic, handler);
    if (!this._client || !this._connected) return;
    try { this._client.subscribe(topic, { qos: 1 }); }
    catch (e) { this.log.debug?.(`MQTT 구독 실패(${topic}): ${e && e.message}`); }
  }

  _resubscribeAll() {
    if (!this._client || !this._connected) return;
    for (const topic of this._subs.keys()) {
      try { this._client.subscribe(topic, { qos: 1 }); }
      catch (e) { this.log.debug?.(`MQTT 재구독 실패(${topic}): ${e && e.message}`); }
    }
  }

  _onMessage(topic, buf, packet) {
    const handler = this._subs.get(topic);
    if (!handler) return;
    // retain된 명령은 무시(재연결마다 재전달돼 기기가 저절로 조작되는 사고 방지).
    if (packet && packet.retain) { this.log.debug?.(`MQTT retain된 명령 무시(${topic})`); return; }
    const value = buf ? buf.toString().trim() : '';
    if (value === '') { this.log.debug?.(`MQTT 빈 명령 무시(${topic})`); return; }
    Promise.resolve()
      .then(() => handler(value))
      .catch(e => this.log.warn(`MQTT 명령 처리 실패(${topic}): ${e && e.message}`));
  }

  _republishDiscovery() {
    if (!this._connected) return;
    for (const entry of this._entries.values()) {
      for (const d of entry.discovery) this._publish(d.topic, d.body, { retain: true, qos: 1 });
    }
  }

  _republishState() {
    if (!this._connected) return;
    for (const [slug, entry] of this._entries) {
      if (entry.lastPayload == null) continue;
      this._publish(`${this.base}/${slug}/state`, entry.lastPayload, { retain: true });
    }
  }

  _deviceInfo(slug, label, model) {
    return {
      identifiers: [`km81_${slug}`],
      name: label,
      manufacturer: 'Samsung',
      model: model || '로컬 제어(홈브릿지 경유)',
      sw_version: this.version || undefined,
    };
  }

  /**
   * ★★2026-08-05 — `value_template` 에 **기본값을 자동으로 붙인다**.
   *
   * 왜: `_mergeAndPublish` 는 값이 사라지면 **키를 지운다**(v2.13.x — 옛 값이 HA 에
   *   영구 고착되는 것을 막으려고 일부러 그렇게 만들었다). 그런데 discovery 템플릿이
   *   `{{ value_json.X }}` 라, 키가 없으면 Jinja 가 **UndefinedError** 를 낸다.
   *   → HA 로그에 템플릿 경고가 **하루 1,653건** 쌓였다(HA 방 실측: alarm_code 1,005 ·
   *     remote_control·kids_lock·dry_level 각 149 · course 42 · 그 외 각 3~13).
   * ★설계가 틀린 게 아니라 **양쪽 계약을 안 맞춘 것**이다 — 키를 지우기로 했으면
   *   읽는 쪽에도 "없을 수 있다"를 알려야 한다.
   * ⚠️호출부가 13곳이라 하나씩 고치면 반드시 빠뜨린다. **여기 한 곳에서** 처리한다.
   * ⚠️★기본값은 **`'None'`** 이다 — `'unknown'` 이 아니다(2026-08-05 정정).
   *   Home Assistant 가 "값 없음"으로 알아듣는 문자열은 `PAYLOAD_NONE = "None"` 하나뿐이고,
   *   sensor·binary_sensor·climate 가 **전부** 그 값을 받으면 상태를 unknown 으로 만든다.
   *   ⛔`'unknown'` 을 쓰면 텍스트 센서에서만 통하고 나머지는 오히려 나빠진다 — 숫자 센서는
   *     변환에 실패해 **경고가 ERROR 로 승격**되고(에너지 통계까지 오염된다), binary_sensor 는
   *     payload_on/off 어느 쪽도 아니라 경고가 그대로 남는다. 실측으로 확인한 회귀다.
   *   빈 문자열은 "상태 갱신 건너뜀"이라 **옛 값이 남는다** — 그것도 답이 아니다.
   */
  static _withTemplateDefault(tpl) {
    if (typeof tpl !== 'string' || !tpl) return tpl;
    if (/\|\s*default\s*\(/.test(tpl)) return tpl;              // 이미 있으면 두 번 붙이지 않는다
    const m = tpl.match(/^\{\{\s*(value_json\.[A-Za-z0-9_]+)\s*\}\}$/);
    if (!m) return tpl;                                          // 복잡한 템플릿은 손대지 않는다
    return `{{ ${m[1]} | default('None') }}`;
  }

  _publishDiscovery(component, slug, objectId, payload) {
    const topic = `${this.discoveryPrefix}/${component}/km81_${slug}/${objectId}/config`;
    // ⚠️`value_template` 만 감싸면 climate 의 `*_state_template` 3종이 정의상 빠진다.
    //   이름이 `_template` 로 끝나는 **모든 필드**를 대상으로 한다(2026-08-05 적대 리뷰).
    let withDefault = payload;
    for (const k of Object.keys(payload)) {
      if (!/_template$/.test(k) || typeof payload[k] !== 'string') continue;
      const fixed = MqttBridge._withTemplateDefault(payload[k]);
      if (fixed !== payload[k]) {
        if (withDefault === payload) withDefault = { ...payload };
        withDefault[k] = fixed;
      }
    }
    // ★retract 모드에선 **빈 페이로드**를 retain 발행한다 — HA 는 이걸 "이 엔티티를 내려라"로
    //   읽는다. 목록을 따로 두지 않고 register 경로를 그대로 되돌려 쓰므로, 센서를 추가하면
    //   회수 목록도 자동으로 따라온다(목록 이원화로 지워지지 않는 유령이 생기는 것을 막는다).
    const body = this._retractMode ? '' : JSON.stringify(withDefault);
    const entry = this._entries.get(slug);
    if (entry && !this._retractMode) entry.discovery.push({ topic, body });
    this._publish(topic, body, { retain: true, qos: 1 });
  }

  // ★`last_seen` — 기기와 **마지막으로 실제 통신에 성공한 시각**.
  //
  //   왜 필요한가: 브리지 availability 는 브리지 생사만 알려 준다. 그래서 HA 는 "값이 안 바뀐
  //   것"과 "기기가 죽은 것"을 구분할 수 없다(실제로 11.6시간 같은 값이 있었다).
  //   ⛔기기별 availability 로 푸는 방법은 쓰지 않는다 — 그러면 **"전원을 끈 것"과 "죽은 것"이
  //     섞인다**(요청서 §4-2 계약). 실측상 에어컨은 꺼도 DTLS 가 살아 있고 세탁기·정수기는 끄면
  //     네트워크에서 사라져 **기기마다 의미가 달라진다** — 예외를 두는 순간 다음 사고 자리다.
  //   대신 사실만 내보내고 **판정 임계는 HA 가 정한다**(폴 주기가 기기별·티어별로 다르다).
  _registerLastSeen(slug, dev, avail, stateTopic) {
    this._publishDiscovery('sensor', slug, 'last_seen', {
      name: '마지막 수신', unique_id: `km81_${slug}_last_seen`, device: dev,
      availability_topic: avail, state_topic: stateTopic,
      value_template: '{{ value_json.last_seen }}',
      device_class: 'timestamp', entity_category: 'diagnostic', icon: 'mdi:lan-connect',
    });
  }

  _ensureEntry(slug, kind, label) {
    if (!this._entries.has(slug)) {
      this._entries.set(slug, { kind, label, registered: false, stateObj: {}, lastPayload: null, discovery: [] });
    }
    return this._entries.get(slug);
  }

  // 상태 부분 갱신 → 병합 → 변화 있으면 발행. null 값은 키를 지운다(센서 값 소실 반영).
  _mergeAndPublish(slug, partial) {
    const entry = this._entries.get(slug);
    if (!entry) return;
    for (const [k, v] of Object.entries(partial)) {
      if (v === null || v === undefined) delete entry.stateObj[k];
      else entry.stateObj[k] = v;
    }
    let body;
    try { body = JSON.stringify(entry.stateObj); }
    catch (e) { this.log.debug?.(`상태 직렬화 실패(${slug}): ${e && e.message}`); return; }
    if (body === entry.lastPayload) return;
    entry.lastPayload = body;
    this._publish(`${this.base}/${slug}/state`, body, { retain: true });
  }

  // ── 승준 에어컨(신형 DTLS) ───────────────────────────────────────────────
  registerSmartAc({ slug, label, model, minTemp, maxTemp, tempStep, setChar,
                    hasWindFree, hasAutoClean, hasLight, hasSound, hasMonitor, hasLastSeen }) {
    const entry = this._ensureEntry(slug, 'smartAc', label);
    if (entry.registered) return;
    entry.registered = true;

    const stateTopic = `${this.base}/${slug}/state`;
    const cmd = k => `${this.base}/${slug}/set/${k}`;
    const dev = this._deviceInfo(slug, label, model);
    const avail = this.availabilityTopic;

    this._publishDiscovery('climate', slug, 'climate', {
      name: null,
      unique_id: `km81_${slug}_climate`,
      device: dev,
      availability_topic: avail,
      modes: ['off', 'cool'],
      mode_state_topic: stateTopic,
      mode_state_template: '{{ value_json.mode }}',
      mode_command_topic: cmd('mode'),
      current_temperature_topic: stateTopic,
      current_temperature_template: '{{ value_json.current_temp }}',
      temperature_state_topic: stateTopic,
      temperature_state_template: '{{ value_json.target_temp }}',
      temperature_command_topic: cmd('temperature'),
      temperature_unit: 'C',
      min_temp: Number.isFinite(minTemp) ? minTemp : 18,
      max_temp: Number.isFinite(maxTemp) ? maxTemp : 30,
      // 홈킷과 같은 단계를 쓴다 — 시스템 에어컨은 0.5℃라 1로 고정하면 HA 화면만 어긋난다.
      temp_step: Number.isFinite(tempStep) && tempStep > 0 ? tempStep : 1,
      icon: 'mdi:air-conditioner',
    });

    const mkSwitch = (key, name, icon) => this._publishDiscovery('switch', slug, key, {
      name,
      unique_id: `km81_${slug}_${key}`,
      device: dev,
      availability_topic: avail,
      state_topic: stateTopic,
      value_template: `{{ value_json.${key} }}`,
      command_topic: cmd(key),
      payload_on: 'ON',
      payload_off: 'OFF',
      icon,
    });
    // 대상 특성/리소스가 있을 때만 노출(없으면 유령 컨트롤).
    // ⚠️없을 땐 **회수**까지 해야 한다 — 지난 부팅에 만들어진 스위치가 남으면 눌러도 아무 일도
    //   안 일어난다(명령 구독이 없다). 능력은 구성 변경으로 바뀔 수 있다.
    const gateSwitch = (on, key, name, icon) => {
      if (on) mkSwitch(key, name, icon);
      else this._retractDiscovery('switch', slug, key);
    };
    gateSwitch(hasWindFree, 'windfree', '무풍', 'mdi:weather-dust');
    gateSwitch(hasAutoClean, 'autoclean', '자동건조', 'mdi:fan-auto');
    gateSwitch(hasLight, 'light', '디스플레이 조명', 'mdi:television-ambient-light');
    gateSwitch(hasSound, 'sound', '효과음', 'mdi:volume-high');

    // 모니터링 센서 (로컬 조회로 채워짐, §3-5 실측 키)
    // ★이 값들을 채우는 폴러는 **로컬 경로가 있을 때만** 돈다(attach.js). 클라우드 전송
    //   구성에서 등록만 하면 HA 에 영영 unknown 인 센서 13개가 남는다 — 세탁기 유령 5종과
    //   같은 부류다(2026-08-05 적대 리뷰). 없으면 등록하지 않고, 있던 것은 회수한다.
    const mkSensor = (key, name, opts = {}) => (hasMonitor
      ? this._publishDiscovery('sensor', slug, key, {
      name,
      unique_id: `km81_${slug}_${key}`,
      device: dev,
      availability_topic: avail,
      state_topic: stateTopic,
      value_template: `{{ value_json.${key} }}`,
      ...opts,
    })
      : this._retractDiscovery('sensor', slug, key));
    mkSensor('power_w', '순시 전력', { unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement', icon: 'mdi:flash' });
    mkSensor('energy_kwh', '누적 전력량', { unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', icon: 'mdi:lightning-bolt' });
    mkSensor('humidity', '습도', { unit_of_measurement: '%', device_class: 'humidity', state_class: 'measurement', icon: 'mdi:water-percent' });
    mkSensor('filter_percent', '필터 사용률', { unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:air-filter' });
    // ★기기 실제 운전 모드(2026-08-04) — 홈킷 climate은 '냉방/끔'뿐이라 제습·송풍을 표현하지
    //   못한다. `coolModeCommand`가 dry면 홈킷 '냉방'이 실제로는 제습이다. 표시 전용 센서로
    //   실모드를 그대로 노출한다(제어는 기존 climate 경로 유지 — 안전 로직 우회 금지).
    mkSensor('mode_actual', '운전 모드', { icon: 'mdi:tune-variant' });
    // ★2026-08-04 — 기기가 보고하는데 **아무 데도 안 가던** 값들. 홈킷에 자리가 없다고
    //   버릴 이유는 없다 — HA 는 담을 수 있고, 나중에 무엇에 쓸지는 그때 정하면 된다.
    mkSensor('wind_strength', '바람세기', { icon: 'mdi:weather-windy' });
    mkSensor('convenient_mode', '편의 모드', { icon: 'mdi:leaf' });          // Off/Quiet/Nano(무풍)/NanoSleep
    mkSensor('autoclean_progress', '자동건조 진행률', { unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:progress-clock' });
    mkSensor('selfcheck_status', '자가진단', { icon: 'mdi:stethoscope', entity_category: 'diagnostic' });
    mkSensor('alarm_code', '기기 알람', { icon: 'mdi:alert-circle-outline', entity_category: 'diagnostic' });
    // ⚠️단위를 안 붙인다 — 기기가 주는 `elapsedTime` 이 분인지 초인지 **미검증**이다
    //   (실측값이 "0" 하나뿐이라 판별 불가). 확인 전까지 거짓 단위를 붙이지 않는다(리뷰 M-3).
    mkSensor('night_elapsed', '열대야쾌면 경과(단위 미확인)', { state_class: 'measurement', icon: 'mdi:sleep', entity_category: 'diagnostic' });
    // ⚠️`last_seen` 도 폴러가 채운다 — 폴러가 없으면 **영영 안 채워지는 유령**이다.
    //   ⛔클라우드 폴백이 켜진 구성에서도 내보내지 않는다(적대 리뷰 F5) — 폴백 성공은
    //     `lastOk` 를 안 올려서 **살아 있는 기기를 죽었다고** 보고하게 된다.
    if (hasLastSeen) this._registerLastSeen(slug, dev, avail, stateTopic);
    else this._retractDiscovery('sensor', slug, 'last_seen');
    // ★`alarm_ok`·`autoclean_running` 은 그동안 **발행만 되고 discovery 가 없어** HA 에
    //   엔티티 자체가 안 생기고 있었다(2026-08-05 적대 리뷰 — 구김방지와 같은 부류).
    for (const [key, name, icon, extra] of [
      ['night_mode', '열대야쾌면', 'mdi:weather-night', {}],
      ['autoclean_running', '자동건조 가동', 'mdi:fan-auto', {}],
      ['alarm_ok', '알람 정상', 'mdi:check-circle-outline', { entity_category: 'diagnostic' }],
    ]) {
      if (!hasMonitor) { this._retractDiscovery('binary_sensor', slug, key); continue; }
      this._publishDiscovery('binary_sensor', slug, key, {
        name, unique_id: `km81_${slug}_${key}`, device: dev, availability_topic: avail,
        state_topic: stateTopic, value_template: `{{ value_json.${key} }}`,
        payload_on: 'ON', payload_off: 'OFF', icon, ...extra,
      });
    }

    // ── 명령 구독 ──
    // ⚠️회수 중에는 구독하지 않는다 — 내리는 기기의 set 토픽을 붙잡고, `setChar` 가 null 이라
    //   그 토픽에 뭐라도 오면 `setChar is not a function` 경고만 남는다(적대 리뷰).
    if (this._retractMode) return;
    this._subscribe(cmd('mode'), async (v) => {
      const s = String(v).toLowerCase();
      if (s === 'off') { await setChar('power', false); return; }
      if (['cool', 'on', 'heat', 'auto', 'dry', 'fan_only', 'heat_cool'].includes(s)) { await setChar('power', true); return; }
      this.log.debug?.(`MQTT 알 수 없는 mode 무시(${slug}): ${v}`);
    });
    this._subscribe(cmd('temperature'), async (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`온도 값이 숫자가 아닙니다: ${v}`);
      await setChar('temperature', n);
    });
    if (hasWindFree) this._subscribe(cmd('windfree'), async (v) => setChar('windfree', String(v).toUpperCase() === 'ON'));
    if (hasAutoClean) this._subscribe(cmd('autoclean'), async (v) => setChar('autoclean', String(v).toUpperCase() === 'ON'));
    if (hasLight) this._subscribe(cmd('light'), async (v) => setChar('light', String(v).toUpperCase() === 'ON'));
    if (hasSound) this._subscribe(cmd('sound'), async (v) => setChar('sound', String(v).toUpperCase() === 'ON'));
  }

  // 제어값(HomeKit 미러) — 부분 갱신
  publishSmartAcState(slug, s = {}) {
    if (!this._entries.has(slug)) return;
    const partial = {
      mode: s.power ? 'cool' : 'off',
      current_temp: Number.isFinite(s.currentTemp) ? s.currentTemp : null,
      target_temp: Number.isFinite(s.coolingSetpoint) ? s.coolingSetpoint : null,
      windfree: s.windFree ? 'ON' : 'OFF',
      autoclean: s.autoClean ? 'ON' : 'OFF',
    };
    if (s.light !== undefined) partial.light = s.light ? 'ON' : 'OFF';
    this._mergeAndPublish(slug, partial);
  }

  // 모니터링값(로컬 조회) — ★인자에 담겨 온 키만 갱신한다. 예전엔 없는 키도 null로 넣어
  //   조명만 낙관 반영해도 전력·습도·필터 4종이 상태에서 삭제됐다(적대 감사 MEDIUM-1).
  //   'key' in s 로 존재하는 키만 partial에 넣는다. 값이 비유효면 그 키만 null(=삭제).
  publishSmartAcSensors(slug, s = {}) {
    if (!this._entries.has(slug)) return;
    const partial = {};
    if ('last_seen' in s && s.last_seen !== undefined) partial.last_seen = s.last_seen || null;
    if ('power_w' in s) partial.power_w = Number.isFinite(s.power_w) ? s.power_w : null;
    if ('cumulative_kwh' in s) partial.energy_kwh = Number.isFinite(s.cumulative_kwh) ? s.cumulative_kwh : null;
    if ('humidity' in s) partial.humidity = Number.isFinite(s.humidity) ? s.humidity : null;
    if ('filter_percent' in s) partial.filter_percent = Number.isFinite(s.filter_percent) ? s.filter_percent : null;
    if ('light' in s && s.light !== undefined) partial.light = s.light === null ? null : (s.light ? 'ON' : 'OFF');
    if ('sound' in s && s.sound !== undefined) partial.sound = s.sound === null ? null : (s.sound ? 'ON' : 'OFF');
    if ('mode_actual' in s && s.mode_actual !== undefined) partial.mode_actual = s.mode_actual || null;
    // 2026-08-04 신규 — undefined 는 '이번 회차엔 안 읽음'이라 건드리지 않는다(기존 값 보존).
    if (s.wind_strength !== undefined) partial.wind_strength = s.wind_strength || null;
    if (s.convenient_mode !== undefined) partial.convenient_mode = s.convenient_mode || null;
    if (s.autoclean_progress !== undefined) {
      partial.autoclean_progress = Number.isFinite(s.autoclean_progress) ? s.autoclean_progress : null;
    }
    if (s.autoclean_running !== undefined) partial.autoclean_running = s.autoclean_running === null ? null : (s.autoclean_running ? 'ON' : 'OFF');
    if (s.selfcheck_status !== undefined) partial.selfcheck_status = s.selfcheck_status || null;
    if (s.alarm_code !== undefined) partial.alarm_code = s.alarm_code || null;
    if (s.alarm_ok !== undefined) partial.alarm_ok = s.alarm_ok === null ? null : (s.alarm_ok ? 'ON' : 'OFF');
    if (s.night_mode !== undefined) partial.night_mode = s.night_mode === null ? null : (s.night_mode ? 'ON' : 'OFF');
    if (s.night_elapsed !== undefined) {
      partial.night_elapsed = Number.isFinite(s.night_elapsed) ? s.night_elapsed : null;
    }
    if (Object.keys(partial).length) this._mergeAndPublish(slug, partial);
  }

  // ── 세탁기·건조기 ────────────────────────────────────────────────────────
  registerLaundry({ slug, label, model, kind, hasEnergy, hasProgress, hasDetail, hasLastSeen }) {
    const entry = this._ensureEntry(slug, kind, label);
    if (entry.registered) return;
    entry.registered = true;

    const stateTopic = `${this.base}/${slug}/state`;
    const dev = this._deviceInfo(slug, label, model);
    const avail = this.availabilityTopic;
    const icon = kind === 'dryer' ? 'mdi:tumble-dryer' : 'mdi:washing-machine';

    this._publishDiscovery('binary_sensor', slug, 'running', {
      name: '가동 중', unique_id: `km81_${slug}_running`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: '{{ value_json.running }}',
      payload_on: 'ON', payload_off: 'OFF', device_class: 'running', icon,
    });
    this._publishDiscovery('sensor', slug, 'status', {
      name: '동작 상태', unique_id: `km81_${slug}_status`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: '{{ value_json.status }}', icon,
    });
    this._publishDiscovery('sensor', slug, 'remaining', {
      name: '남은 시간', unique_id: `km81_${slug}_remaining`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: '{{ value_json.remaining_min }}',
      unit_of_measurement: 'min', icon: 'mdi:timer-sand',
    });
    // 진행률·에너지는 기기가 줄 때만(건조기 O, 세탁기 8888 X — 실측).
    // ⚠️hasDetail 과 같은 이유로 **없으면 회수**한다 — local→클라우드로 바뀐 기기의
    //   진행률·전력 엔티티가 마지막 값에 얼어붙은 채 남는다(적대 리뷰: 회수를 hasDetail 에만 넣었다).
    if (!hasProgress) this._retractDiscovery('sensor', slug, 'progress');
    if (!hasEnergy) { this._retractDiscovery('sensor', slug, 'power_w'); this._retractDiscovery('sensor', slug, 'energy_kwh'); }
    if (hasProgress) this._publishDiscovery('sensor', slug, 'progress', {
      name: '진행률', unique_id: `km81_${slug}_progress`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: '{{ value_json.progress }}',
      unit_of_measurement: '%', icon: 'mdi:progress-clock',
    });
    // ★순시 전력(2026-08-04) — 로컬 클라이언트가 이미 `getEnergy()`로 함께 읽어 오던 값인데
    //   누적만 발행하고 버리고 있었다(적대 감사 지적). 기기 추가 조회는 0회다.
    if (hasEnergy) this._publishDiscovery('sensor', slug, 'power_w', {
      name: '순시 전력', unique_id: `km81_${slug}_power_w`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: '{{ value_json.power_w }}',
      unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement', icon: 'mdi:flash',
    });
    if (hasEnergy) this._publishDiscovery('sensor', slug, 'energy_kwh', {
      name: '누적 전력량', unique_id: `km81_${slug}_energy_kwh`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: '{{ value_json.energy_kwh }}',
      unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', icon: 'mdi:lightning-bolt',
    });

    // ★2026-08-04 — 기기가 보고하는데 안 나가던 값들.
    //   ⚠️`remote_control` 이 특히 중요하다: false 면 **HA 명령을 기기가 안 받는다.**
    //     그 사실이 어디에도 안 나와서, 안 들으면 원인을 짐작할 수가 없었다.
    // ⚠️세탁기(8888)도 발행한다 — 다만 **출처가 다르다**(로컬 DTLS 생사가 아니라 8888 경로의
    //   응답 여부). 임계를 정할 때 이 차이를 알아야 하므로 전달 문서에 명시했다.
    // ⛔클라우드 폴백이 켜진 구성에서는 내보내지 않는다(적대 리뷰 F3) — 클라우드는 기기가
    //   오프라인이어도 캐시 상태로 응답하므로 **죽은 기기의 last_seen 이 영원히 신선**해진다.
    if (hasLastSeen) this._registerLastSeen(slug, dev, avail, stateTopic);
    else this._retractDiscovery('sensor', slug, 'last_seen');
    // 상세값(원격제어·어린이잠금·건조강도·구김방지·알람·코스)은 **로컬 폴 경로가 있는 기기만**
    // 발행한다. 8888 세탁기는 이 값을 읽을 경로가 없어, 등록만 하면 HA 에 영영 값이 안 채워지는
    // 엔티티가 남는다(빈 페이로드를 발행해 이미 만들어진 것도 회수한다).
    if (hasDetail) {
      this._publishDiscovery('binary_sensor', slug, 'remote_control', {
        name: '원격제어 허용', unique_id: `km81_${slug}_remote_control`, device: dev, availability_topic: avail,
        state_topic: stateTopic, value_template: '{{ value_json.remote_control }}',
        payload_on: 'ON', payload_off: 'OFF', icon: 'mdi:remote', entity_category: 'diagnostic',
      });
      this._publishDiscovery('binary_sensor', slug, 'alarm_ok', {
        name: '알람 정상', unique_id: `km81_${slug}_alarm_ok`, device: dev, availability_topic: avail,
        state_topic: stateTopic, value_template: '{{ value_json.alarm_ok }}',
        payload_on: 'ON', payload_off: 'OFF', icon: 'mdi:check-circle-outline',
        entity_category: 'diagnostic',
      });
      this._publishDiscovery('binary_sensor', slug, 'wrinkle_prevent', {
        name: '구김방지', unique_id: `km81_${slug}_wrinkle_prevent`, device: dev, availability_topic: avail,
        state_topic: stateTopic, value_template: '{{ value_json.wrinkle_prevent }}',
        payload_on: 'ON', payload_off: 'OFF', icon: 'mdi:tshirt-crew',
      });
      for (const [key, name, icon] of LAUNDRY_DETAIL_SENSORS) {
        this._publishDiscovery('sensor', slug, key, {
          name, unique_id: `km81_${slug}_${key}`, device: dev, availability_topic: avail,
          state_topic: stateTopic, value_template: `{{ value_json.${key} }}`,
          icon, ...(key === 'alarm_code' ? { entity_category: 'diagnostic' } : {}),
        });
      }
    } else {
      this._retractDiscovery('binary_sensor', slug, 'remote_control');
      this._retractDiscovery('binary_sensor', slug, 'alarm_ok');
      this._retractDiscovery('binary_sensor', slug, 'wrinkle_prevent');
      for (const [key] of LAUNDRY_DETAIL_SENSORS) this._retractDiscovery('sensor', slug, key);
    }
  }

  // 설정에서 중계를 끈 기기의 retained discovery·state 를 회수한다.
  // ⚠️이게 없으면 HA 엔티티가 **마지막 값에 얼어붙은 채** 남아, 관찰 기간 내내 거짓 값을 보게
  //   된다(정수기 필터 43%가 영영 43%). 껐다는 사실 자체가 HA 에 전달되지 않는다.
  retractDevice({ slug, kind, label, model }) {
    if (!slug) return false;
    // ⚠️회수는 **부팅 중**에 불린다 — 그때 브로커 연결이 아직이면 그냥 사라진다.
    //   등록(discovery)이 연결 시 재발행되는 것과 같은 취급을 해야 한다.
    if (!this._connected) {
      if (!this._pendingRetract.some((r) => r.slug === slug)) {
        this._pendingRetract.push({ slug, kind, label, model });
      }
      return true;
    }
    const prev = this._retractMode;
    this._retractMode = true;
    try {
      const had = this._entries.get(slug);
      if (had) had.registered = false;
      if (kind === 'waterPurifier') this.registerWaterPurifier({ slug, label, model });
      else if (kind === 'washer' || kind === 'dryer') {
        this.registerLaundry({ slug, label, model, kind, hasEnergy: true, hasProgress: true, hasDetail: true, hasLastSeen: true });
      } else if (kind === 'smartAc' || kind === 'legacyAc') {
        this.registerSmartAc({
          slug, label, model, minTemp: 16, maxTemp: 30, tempStep: 0.5, setChar: null,
          hasWindFree: true, hasAutoClean: true, hasLight: true, hasSound: true, hasMonitor: true, hasLastSeen: true,
        });
      } else return false;
      this._publish(`${this.base}/${slug}/state`, '', { retain: true, qos: 1 });
      if (!had) this._entries.delete(slug);
      else { had.registered = false; had.stateObj = {}; had.lastPayload = null; had.discovery = []; }
      return true;
    } catch (e) {
      this.log.debug?.(`MQTT 회수 실패(${slug}): ${e && e.message}`);
      return false;
    } finally { this._retractMode = prev; }
  }

  // ⚠️연결 전이면 `_publish` 가 조용히 버린다 — `retractDevice` 에는 큐를 만들어 놓고
  //   **엔티티 단위 회수에는 안 옮겼다**(적대 리뷰). 그 부팅에서도, 이후 재연결에서도 영영
  //   회수되지 않아 유령이 남는다. 같은 취급을 한다.
  _retractDiscovery(component, slug, objectId) {
    const topic = `${this.discoveryPrefix}/${component}/km81_${slug}/${objectId}/config`;
    if (!this._connected) {
      if (!this._pendingRetractTopics.includes(topic)) this._pendingRetractTopics.push(topic);
      return;
    }
    this._publish(topic, '', { retain: true, qos: 1 });
  }

  // ── 정수기 (2026-08-04) ──────────────────────────────────────────────────
  //
  // ★홈킷 액세서리가 **없다**. 홈 앱에 넣을 값어치가 있는 건 잠금 정도인데 사용자가
  //   불필요하다고 판단했고, 필터·출수량 같은 계량값은 홈킷이 담는 그릇이 아니다.
  //   그래도 기기는 로컬로 많은 걸 알려 주므로, **HA 로만 흘린다.**
  registerWaterPurifier({ slug, label, model }) {
    const entry = this._ensureEntry(slug, 'waterPurifier', label);
    if (entry.registered) return;
    entry.registered = true;

    const stateTopic = `${this.base}/${slug}/state`;
    const dev = this._deviceInfo(slug, label, model);
    const avail = this.availabilityTopic;

    const mkSensor = (key, name, opts = {}) => this._publishDiscovery('sensor', slug, key, {
      name, unique_id: `km81_${slug}_${key}`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: `{{ value_json.${key} }}`, ...opts,
    });
    const mkBinary = (key, name, opts = {}) => this._publishDiscovery('binary_sensor', slug, key, {
      name, unique_id: `km81_${slug}_${key}`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: `{{ value_json.${key} }}`,
      payload_on: 'ON', payload_off: 'OFF', ...opts,
    });

    this._registerLastSeen(slug, dev, avail, stateTopic);
    mkSensor('filter_remain', '필터 잔여량', { unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:water-percent' });
    mkSensor('filter_status', '필터 상태', { icon: 'mdi:air-filter', entity_category: 'diagnostic' });
    mkSensor('status', '상태', { icon: 'mdi:water-boiler' });
    mkBinary('pouring', '출수 중', { icon: 'mdi:cup-water' });
    mkSensor('hot_temp', '온수 온도', { unit_of_measurement: '°C', device_class: 'temperature', state_class: 'measurement', icon: 'mdi:thermometer' });
    mkSensor('capacity_ml', '출수량 설정', { unit_of_measurement: 'mL', icon: 'mdi:cup' });
    mkBinary('lock_hot', '온수 잠금', { icon: 'mdi:lock' });
    mkBinary('lock_cold', '냉수 잠금', { icon: 'mdi:lock' });
    mkBinary('lock_buzz', '소리 잠금', { icon: 'mdi:volume-off', entity_category: 'diagnostic' });
    mkSensor('sterilize_last', '마지막 살균', { device_class: 'timestamp', icon: 'mdi:shield-check' });
    mkSensor('sterilize_next', '다음 살균', { device_class: 'timestamp', icon: 'mdi:shield-sync' });
    mkBinary('sterilize_running', '살균 중', { icon: 'mdi:shield-refresh' });
    mkSensor('filter_door', '필터 도어', { icon: 'mdi:door', entity_category: 'diagnostic' });
    mkSensor('selfcheck_status', '자가진단', { icon: 'mdi:stethoscope', entity_category: 'diagnostic' });
    mkBinary('favorite_enabled', '나만의 출수량', { icon: 'mdi:cup-outline' });
    mkSensor('favorite_ml', '나만의 출수량 값', { unit_of_measurement: 'mL', icon: 'mdi:cup' });
  }

  publishWaterPurifierState(slug, s = {}) {
    if (!this._entries.has(slug)) return;
    const partial = {};
    const num = (k, v) => { if (v !== undefined) partial[k] = Number.isFinite(v) ? v : null; };
    const str = (k, v) => { if (v !== undefined) partial[k] = v || null; };
    const bin = (k, v) => { if (v !== undefined) partial[k] = v === null ? null : (v ? 'ON' : 'OFF'); };

    str('last_seen', s.last_seen);
    num('filter_remain', s.filter_remain);
    str('filter_status', s.filter_status);
    str('status', s.status);
    bin('pouring', s.pouring);
    num('hot_temp', s.hot_temp);
    num('capacity_ml', s.capacity_ml);
    bin('lock_hot', s.lock_hot);
    bin('lock_cold', s.lock_cold);
    bin('lock_buzz', s.lock_buzz);
    // ⚠️기기 시각은 UTC 다 — HA 의 timestamp 는 오프셋을 요구하므로 `Z` 를 붙여 준다.
    //   붙이지 않으면 HA 가 로컬시각으로 읽어 **9시간 어긋난다**(실측: 앱과 +9h 차이).
    const utc = (v) => (typeof v === 'string' && v && !/[Zz+]/.test(v) ? `${v}Z` : v);
    str('sterilize_last', s.sterilize_last === undefined ? undefined : utc(s.sterilize_last));
    str('sterilize_next', s.sterilize_next === undefined ? undefined : utc(s.sterilize_next));
    bin('sterilize_running', s.sterilize_running);
    str('filter_door', s.filter_door);
    str('selfcheck_status', s.selfcheck_status);
    bin('favorite_enabled', s.favorite_enabled);
    num('favorite_ml', s.favorite_ml);

    if (Object.keys(partial).length) this._mergeAndPublish(slug, partial);
  }

  // 세탁/건조 상태 — 읽기 전용. 제어값이 없어 항상 전체 병합이지만 형식 통일 위해 merge 사용.
  publishLaundryState(slug, s = {}) {
    if (!this._entries.has(slug)) return;
    const partial = {};

    // ★★`state` 가 실제로 온 경우에만 상태 3종을 쓴다(2026-08-04).
    //   예전엔 무조건 `String(s.state || 'unknown')` 이라, **상태를 안 담은 부분 갱신**이
    //   들어오면 가동 중인 건조기를 `알 수 없음`·`running OFF`·`남은시간 0` 으로 덮어썼다.
    //   느린 티어(30분 주기: 원격제어·어린이잠금·건조강도)를 붙이는 순간 터질 자리였다.
    //   ⚠️부분 갱신을 받는 함수는 **"안 온 값"과 "빈 값"을 반드시 구분해야 한다.**
    if (s.last_seen !== undefined) partial.last_seen = s.last_seen || null;
    if (s.state !== undefined) {
      const st = String(s.state || 'unknown').toLowerCase();
      partial.running = st === 'running' ? 'ON' : 'OFF';
      partial.status = LAUNDRY_STATE_TEXT[st] || LAUNDRY_STATE_TEXT.unknown;
    }
    if (s.remainingMin !== undefined) {
      // ⚠️`null`(성공·빈 값)을 `Number()` 에 넣으면 **0** 이 된다 — 공급자가 애써 걸러 낸
      //   "없음과 0은 다르다"를 소비자가 여기서 되돌린다(적대 리뷰 F2). 빈 값은 지운다.
      if (s.remainingMin === null) partial.remaining_min = null;
      else {
        let remain = Number(s.remainingMin);
        if (!Number.isFinite(remain)) remain = 0;
        partial.remaining_min = Math.max(0, Math.min(Math.round(remain), 1440));   // 0~24h 방어
      }
    }
    if (s.progress !== undefined) partial.progress = Number.isFinite(s.progress) ? s.progress : null;
    if (s.cumulative_kwh !== undefined) partial.energy_kwh = Number.isFinite(s.cumulative_kwh) ? s.cumulative_kwh : null;
    if (s.power_w !== undefined) partial.power_w = Number.isFinite(s.power_w) ? s.power_w : null;
    // 2026-08-04 신규 — 느린 티어가 보내는 값들
    if (s.remote_control !== undefined) partial.remote_control = s.remote_control === null ? null : (s.remote_control ? 'ON' : 'OFF');
    if (s.kids_lock !== undefined) partial.kids_lock = s.kids_lock || null;
    if (s.dry_level !== undefined) partial.dry_level = s.dry_level || null;
    if (s.wrinkle_prevent !== undefined) partial.wrinkle_prevent = s.wrinkle_prevent === null ? null : (s.wrinkle_prevent ? 'ON' : 'OFF');
    if (s.alarm_code !== undefined) partial.alarm_code = s.alarm_code || null;
    if (s.alarm_ok !== undefined) partial.alarm_ok = s.alarm_ok === null ? null : (s.alarm_ok ? 'ON' : 'OFF');
    if (s.course !== undefined) partial.course = s.course || null;

    if (Object.keys(partial).length) this._mergeAndPublish(slug, partial);
  }
}

module.exports = MqttBridge;
module.exports.LAUNDRY_STATE_TEXT = LAUNDRY_STATE_TEXT;
