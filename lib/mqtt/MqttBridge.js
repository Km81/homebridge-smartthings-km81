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

  _publishDiscovery(component, slug, objectId, payload) {
    const topic = `${this.discoveryPrefix}/${component}/km81_${slug}/${objectId}/config`;
    const body = JSON.stringify(payload);
    const entry = this._entries.get(slug);
    if (entry) entry.discovery.push({ topic, body });
    this._publish(topic, body, { retain: true, qos: 1 });
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
  registerSmartAc({ slug, label, model, minTemp, maxTemp, setChar,
                    hasWindFree, hasAutoClean, hasLight }) {
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
      temp_step: 1,
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
    if (hasWindFree) mkSwitch('windfree', '무풍', 'mdi:weather-dust');
    if (hasAutoClean) mkSwitch('autoclean', '자동건조', 'mdi:fan-auto');
    if (hasLight) mkSwitch('light', '디스플레이 조명', 'mdi:television-ambient-light');

    // 모니터링 센서 (로컬 조회로 채워짐, §3-5 실측 키)
    const mkSensor = (key, name, opts = {}) => this._publishDiscovery('sensor', slug, key, {
      name,
      unique_id: `km81_${slug}_${key}`,
      device: dev,
      availability_topic: avail,
      state_topic: stateTopic,
      value_template: `{{ value_json.${key} }}`,
      ...opts,
    });
    mkSensor('power_w', '순시 전력', { unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement', icon: 'mdi:flash' });
    mkSensor('energy_kwh', '누적 전력량', { unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', icon: 'mdi:lightning-bolt' });
    mkSensor('humidity', '습도', { unit_of_measurement: '%', device_class: 'humidity', state_class: 'measurement', icon: 'mdi:water-percent' });
    mkSensor('filter_percent', '필터 사용률', { unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:air-filter' });

    // ── 명령 구독 ──
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
    if ('power_w' in s) partial.power_w = Number.isFinite(s.power_w) ? s.power_w : null;
    if ('cumulative_kwh' in s) partial.energy_kwh = Number.isFinite(s.cumulative_kwh) ? s.cumulative_kwh : null;
    if ('humidity' in s) partial.humidity = Number.isFinite(s.humidity) ? s.humidity : null;
    if ('filter_percent' in s) partial.filter_percent = Number.isFinite(s.filter_percent) ? s.filter_percent : null;
    if ('light' in s && s.light !== undefined) partial.light = s.light ? 'ON' : 'OFF';
    if (Object.keys(partial).length) this._mergeAndPublish(slug, partial);
  }

  // ── 세탁기·건조기 ────────────────────────────────────────────────────────
  registerLaundry({ slug, label, model, kind, hasEnergy, hasProgress }) {
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
    if (hasProgress) this._publishDiscovery('sensor', slug, 'progress', {
      name: '진행률', unique_id: `km81_${slug}_progress`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: '{{ value_json.progress }}',
      unit_of_measurement: '%', icon: 'mdi:progress-clock',
    });
    if (hasEnergy) this._publishDiscovery('sensor', slug, 'energy_kwh', {
      name: '누적 전력량', unique_id: `km81_${slug}_energy_kwh`, device: dev, availability_topic: avail,
      state_topic: stateTopic, value_template: '{{ value_json.energy_kwh }}',
      unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', icon: 'mdi:lightning-bolt',
    });
  }

  // 세탁/건조 상태 — 읽기 전용. 제어값이 없어 항상 전체 병합이지만 형식 통일 위해 merge 사용.
  publishLaundryState(slug, s = {}) {
    if (!this._entries.has(slug)) return;
    const st = String(s.state || 'unknown').toLowerCase();
    let remain = Number(s.remainingMin);
    if (!Number.isFinite(remain)) remain = 0;
    remain = Math.max(0, Math.min(Math.round(remain), 1440));   // 0~24h 방어(raw는 상한 없음)
    const partial = {
      running: st === 'running' ? 'ON' : 'OFF',
      status: LAUNDRY_STATE_TEXT[st] || LAUNDRY_STATE_TEXT.unknown,
      remaining_min: remain,
    };
    if (s.progress !== undefined) partial.progress = Number.isFinite(s.progress) ? s.progress : null;
    if (s.cumulative_kwh !== undefined) partial.energy_kwh = Number.isFinite(s.cumulative_kwh) ? s.cumulative_kwh : null;
    this._mergeAndPublish(slug, partial);
  }
}

module.exports = MqttBridge;
module.exports.LAUNDRY_STATE_TEXT = LAUNDRY_STATE_TEXT;
