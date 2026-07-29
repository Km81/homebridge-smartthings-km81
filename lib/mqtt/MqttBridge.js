'use strict';

// MQTT 브리지 — 로컬로 소유한 삼성 가전을 Home Assistant에 중계한다 (v2.5.0)
//
// ── 왜 이 계층인가 ────────────────────────────────────────────────────────────
// 기기와의 세션은 홈브릿지가 단독 소유해야 한다(DTLS는 기기당 1세션, 구형 8888도
// 동시 연결에 약하다). 그래서 HA는 기기에 직접 붙지 않고 이 브리지가 내보내는
// MQTT만 본다.
//
// ★발행: 기기를 **추가로 조회하지 않는다.** 액세서리가 이미 도는 폴링에서 얻은
//   상태를 훅으로 받아 그대로 내보낸다(기기 트래픽 증가 0). 변화 시 발행 +
//   주기적 재발행(retain)으로 HA 재시작에도 즉시 값이 찬다.
//
// ★명령: MQTT 명령을 클라이언트나 파이썬 브릿지에 직접 꽂지 않는다. **HomeKit
//   특성에 setValue**로 흘려보내 액세서리가 이미 가진 안전 로직을 통째로 재사용한다
//   — 끄기 장면 억제창(4초), 기기별 직렬화, 켜기 후속 체인, 재동기화. 꺼진 에어컨에
//   모드가 먼저 도달해 재점등하는 사고(2026-07-24)를 구조적으로 막는 유일한 방법이다.
//
// ★availability: 토픽을 **브리지 하나**만 둔다(LWT). 기기별 availability를 만들지
//   않는 것이 의도다 — 세탁기는 전원을 끄면 네트워크에서 사라지는데, 그건 고장이
//   아니라 '꺼짐'이라는 상태다. 소켓 연결로 availability를 잡으면 하루 대부분
//   `unavailable`로 뜨는 틀린 표현이 된다. 꺼짐은 상태값으로만 표현한다.

const DEFAULT_BASE = 'km81/appliance';
const DEFAULT_DISCOVERY_PREFIX = 'homeassistant';
const DEFAULT_REPUBLISH_SEC = 60;
const MIN_REPUBLISH_SEC = 15;
const ONLINE = 'online';
const OFFLINE = 'offline';

// 세탁물 상태 → HA에 보낼 한국어 표기. 액세서리 내부 STATE 상수와 1:1.
const LAUNDRY_STATE_TEXT = {
  running: '운전 중',
  paused: '일시정지',
  finished: '대기 중',
  unknown: '확인 중',
};

class MqttBridge {
  /**
   * @param {object} log     홈브릿지 로거
   * @param {object} cfg     config.mqtt 블록
   * @param {string} version 플러그인 버전(HA 기기 정보 표시용)
   */
  constructor(log, cfg = {}, version = '') {
    this.log = log;
    this.version = version;
    // ★토픽 정규화 — 사용자가 baseTopic에 MQTT 와일드카드(#·+)나 공백을 넣으면,
    //   그게 PUBLISH 토픽에 박혀 브로커가 클라이언트를 끊거나(스펙 위반) SUBSCRIBE 의미가
    //   바뀌어 엉뚱한 명령을 받는다(적대 감사). 허용 문자만 남기고 나머지는 버린다.
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
    // slug → { kind, label, lastPayload, commands: {topic → handler}, discovery: [{topic, payload}] }
    this._entries = new Map();
    this._subs = new Map();   // 명령 토픽 → 핸들러
    this._warnedNoLib = false;
    this._connectLogged = false;
  }

  get enabled() {
    return this._cfg && this._cfg.enabled === true;
  }

  // 슬래시로 계층은 허용하되 와일드카드(#·+)·공백·제어문자는 제거. 결과가 비면 기본값.
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
    const host = (this._cfg.host || '').trim();
    if (!host) {
      this.log.error('MQTT 브리지를 켰지만 브로커 주소(host)가 비어 있어 시작하지 않습니다.');
      return;
    }

    let mqtt;
    try {
      // 선택적 의존성 — 없으면 브리지만 끄고 홈킷은 정상 동작해야 한다.
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
      // 브로커가 재시작하거나 네트워크가 끊겨도 스스로 붙는다.
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      clean: true,
      clientId: `homebridge-km81-${Math.random().toString(16).slice(2, 10)}`,
      // ★LWT — 브리지가 죽으면 HA가 전 엔티티를 unavailable로 표시한다.
      //   '기기 꺼짐'과는 전혀 다른 의미이며, 그 구분이 이 설계의 핵심이다.
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
      // 재연결 때마다 info를 찍으면 로그가 오염된다 — 첫 연결만 알린다.
      if (!this._connectLogged) {
        this._connectLogged = true;
        this.log.info(`MQTT 브리지 연결됨 — ${host}:${port} (토픽 ${this.base}/…)`);
      } else {
        this.log.debug?.('MQTT 재연결됨');
      }
      this._publish(this.availabilityTopic, ONLINE, { retain: true, qos: 1 });
      // 브로커가 재시작하면 retain이 날아간다 → 재연결 시 검색·상태를 다시 올리고 재구독한다.
      this._republishDiscovery();
      this._republishState();
      this._resubscribeAll();
    });

    this._client.on('reconnect', () => this.log.debug?.('MQTT 재연결 시도'));
    this._client.on('close', () => { this._connected = false; });
    this._client.on('error', (e) => {
      // 브로커가 잠깐 없을 때 error가 연속으로 온다 — warn을 반복하면 로그가 넘친다.
      this.log.debug?.(`MQTT 오류: ${e && e.message}`);
    });
    // ★packet 인자까지 받는다 — retain 플래그를 봐야 명령 재실행 사고를 막는다(아래 _onMessage).
    this._client.on('message', (topic, buf, packet) => this._onMessage(topic, buf, packet));

    if (this._republishTimer) clearInterval(this._republishTimer);
    // ★주기 재발행은 '상태만' — discovery(config)는 연결 때 한 번이면 충분하다(HA가 멱등 처리하나
    //   60초마다 재전송하면 트래픽·로그 잡음. 브로커 재시작으로 retain이 날아가면 connect가 다시 올린다).
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
      // ★정상 종료 OFFLINE을 확실히 전달한다. 예전엔 publish 직후 end(true)로 강제 종료해
      //   패킷이 flush 전에 폐기될 수 있었고(정상 종료라 LWT도 안 뜸), HA가 죽은 브리지를
      //   계속 online으로 표시했다(적대 감사 A/F6). end(false)로 드레인을 기다린 뒤 닫는다.
      client.publish(this.availabilityTopic, OFFLINE, { retain: true, qos: 1 }, () => {
        try { client.end(false); } catch (e) { /* 이미 닫힘 */ }
      });
      // 콜백이 끝내 안 와도(브로커 무응답) 3초 뒤엔 강제로 닫아 매달리지 않게 한다.
      setTimeout(() => { try { client.end(true); } catch (e) {} }, 3000).unref?.();
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
    try {
      this._client.subscribe(topic, { qos: 1 });
    } catch (e) {
      this.log.debug?.(`MQTT 구독 실패(${topic}): ${e && e.message}`);
    }
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
    // ★retain된 명령은 무시한다 — 누군가 set 토픽에 retain 메시지를 남기면, 브로커가
    //   구독·재연결마다 그 옛 명령을 재전달해 물리 기기가 저절로 켜진다(적대 감사 D).
    //   플러그인이 구조적으로 막으려는 "꺼진 기기 재점등"과 같은 부류의 재발화다.
    if (packet && packet.retain) {
      this.log.debug?.(`MQTT retain된 명령 무시(${topic})`);
      return;
    }
    const value = buf ? buf.toString().trim() : '';
    // ★빈 페이로드도 무시 — 빈 문자열이 '켜기'나 온도 0으로 잘못 해석되는 것을 막는다.
    if (value === '') { this.log.debug?.(`MQTT 빈 명령 무시(${topic})`); return; }
    // ★핸들러는 절대 던지면 안 된다 — MQTT 이벤트 루프에서 던지면 홈브릿지가 죽는다.
    Promise.resolve()
      .then(() => handler(value))
      .catch(e => this.log.warn(`MQTT 명령 처리 실패(${topic}): ${e && e.message}`));
  }

  // 검색(discovery) 재발행 — 연결 시에만. 브로커 재시작으로 retain이 날아가거나 등록이
  // 연결보다 먼저 일어난 경우를 복구한다. 주기적으로 부르지 않는다(HA 멱등이나 잡음).
  _republishDiscovery() {
    if (!this._connected) return;
    for (const entry of this._entries.values()) {
      for (const d of entry.discovery) this._publish(d.topic, d.body, { retain: true, qos: 1 });
    }
  }

  // 상태 재발행 — 연결 시 + 주기적. 변화가 없어도 retain 값을 다시 올려 HA가 비지 않게 한다.
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
      this._entries.set(slug, { kind, label, lastPayload: null, discovery: [] });
    }
    return this._entries.get(slug);
  }

  // 상태 JSON을 만들어 발행. 변화가 없으면 조용히 넘긴다(브로커·HA 부하 최소화).
  _publishState(slug, obj) {
    const entry = this._entries.get(slug);
    if (!entry) return;
    let body;
    try { body = JSON.stringify(obj); }
    catch (e) { this.log.debug?.(`상태 직렬화 실패(${slug}): ${e && e.message}`); return; }
    if (body === entry.lastPayload) return;
    entry.lastPayload = body;
    this._publish(`${this.base}/${slug}/state`, body, { retain: true });
  }

  // ── 승준 에어컨(신형 DTLS) ───────────────────────────────────────────────
  //
  // 명령은 전부 HomeKit 특성으로 넘긴다 — 아래 setChar가 그 통로다.
  // service/characteristic은 액세서리가 만들어 둔 실물이라 setValue가 곧 홈킷 조작과 동일하다.
  registerSmartAc({ slug, label, model, minTemp, maxTemp, setChar, hasWindFree, hasAutoClean }) {
    const entry = this._ensureEntry(slug, 'smartAc', label);
    if (entry.registered) return;
    entry.registered = true;

    const stateTopic = `${this.base}/${slug}/state`;
    const cmd = k => `${this.base}/${slug}/set/${k}`;
    const dev = this._deviceInfo(slug, label, model);
    const avail = this.availabilityTopic;

    // ★modes를 off/cool 둘로 둔다 — 이 기기의 실제 조작 모양이 그렇다.
    //   플러그인은 '켜기'를 config의 coolModeCommand(승준=dry)로 보내고, 모드를 따로 읽는
    //   경로가 없다. 있는 것처럼 4가지 모드를 노출하면 HA에 거짓 상태가 뜬다.
    this._publishDiscovery('climate', slug, 'climate', {
      name: null,
      unique_id: `km81_${slug}_climate`,
      object_id: `km81_${slug}`,   // ★entity_id = climate.km81_<slug> 로 고정(한글 로마자화 방지, §7-2)
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
      object_id: `km81_${slug}_${key}`,   // ★entity_id를 ASCII로 결정적 고정(한글 로마자화 방지)
      device: dev,
      availability_topic: avail,
      state_topic: stateTopic,
      value_template: `{{ value_json.${key} }}`,
      command_topic: cmd(key),
      payload_on: 'ON',
      payload_off: 'OFF',
      icon,
    });
    // ★대상 특성이 실제로 있을 때만 스위치를 만든다. 없는데 발행하면 HA에 토글해도
    //   무반응인 '유령 컨트롤'이 뜬다(적대 감사). 승준 기기는 SwingMode/Lock이 있어 둘 다 노출.
    if (hasWindFree) mkSwitch('windfree', '무풍', 'mdi:weather-dust');
    if (hasAutoClean) mkSwitch('autoclean', '자동건조', 'mdi:fan-auto');

    // ── 명령 구독 ──
    // ★mode는 화이트리스트로 판정 — 빈 값은 이미 _onMessage가 거르지만, 알 수 없는 문자열을
    //   '켜기'로 오해하지 않도록 명시적으로 off/on류만 받는다.
    this._subscribe(cmd('mode'), async (v) => {
      const s = String(v).toLowerCase();
      if (s === 'off') { await setChar('power', false); return; }
      if (['cool', 'on', 'heat', 'auto', 'dry', 'fan_only', 'heat_cool'].includes(s)) {
        await setChar('power', true); return;
      }
      this.log.debug?.(`MQTT 알 수 없는 mode 무시(${slug}): ${v}`);
    });
    this._subscribe(cmd('temperature'), async (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`온도 값이 숫자가 아닙니다: ${v}`);
      await setChar('temperature', n);
    });
    if (hasWindFree) this._subscribe(cmd('windfree'), async (v) => setChar('windfree', String(v).toUpperCase() === 'ON'));
    if (hasAutoClean) this._subscribe(cmd('autoclean'), async (v) => setChar('autoclean', String(v).toUpperCase() === 'ON'));
  }

  // 액세서리 폴링/조작 결과를 그대로 받는다(기기 재조회 없음).
  publishSmartAcState(slug, s = {}) {
    if (!this._entries.has(slug)) return;
    this._publishState(slug, {
      mode: s.power ? 'cool' : 'off',
      current_temp: Number.isFinite(s.currentTemp) ? s.currentTemp : null,
      target_temp: Number.isFinite(s.coolingSetpoint) ? s.coolingSetpoint : null,
      windfree: s.windFree ? 'ON' : 'OFF',
      autoclean: s.autoClean ? 'ON' : 'OFF',
    });
  }

  // ── 세탁기·건조기 ────────────────────────────────────────────────────────
  // 읽기 전용이다. 기기가 코스·시작 같은 원격 명령을 받지 않는다(클라우드도 동일).
  registerLaundry({ slug, label, model, kind }) {
    const entry = this._ensureEntry(slug, kind, label);
    if (entry.registered) return;
    entry.registered = true;

    const stateTopic = `${this.base}/${slug}/state`;
    const dev = this._deviceInfo(slug, label, model);
    const avail = this.availabilityTopic;
    const icon = kind === 'dryer' ? 'mdi:tumble-dryer' : 'mdi:washing-machine';

    this._publishDiscovery('binary_sensor', slug, 'running', {
      name: '가동 중',
      unique_id: `km81_${slug}_running`,
      object_id: `km81_${slug}_running`,
      device: dev,
      availability_topic: avail,
      state_topic: stateTopic,
      value_template: '{{ value_json.running }}',
      payload_on: 'ON',
      payload_off: 'OFF',
      device_class: 'running',
      icon,
    });
    this._publishDiscovery('sensor', slug, 'status', {
      name: '동작 상태',
      unique_id: `km81_${slug}_status`,
      object_id: `km81_${slug}_status`,
      device: dev,
      availability_topic: avail,
      state_topic: stateTopic,
      value_template: '{{ value_json.status }}',
      icon,
    });
    this._publishDiscovery('sensor', slug, 'remaining', {
      name: '남은 시간',
      unique_id: `km81_${slug}_remaining`,
      object_id: `km81_${slug}_remaining`,
      device: dev,
      availability_topic: avail,
      state_topic: stateTopic,
      value_template: '{{ value_json.remaining_min }}',
      unit_of_measurement: 'min',
      icon: 'mdi:timer-sand',
    });
    // ★'진행 단계(job)' 센서는 만들지 않는다 — jobState는 HomeKit 특성으로 노출되지 않아
    //   HA 특성 미러 방식으로는 얻을 수 없다(실측: 세탁기 액세서리는 Valve만 노출). 발행하면
    //   값이 영원히 '-'인 죽은 엔티티가 된다. 넣으려면 액세서리에 훅을 추가하는 별도 작업 필요.
  }

  /**
   * @param {string} slug
   * @param {object} s  { state:'running'|'paused'|'finished'|'unknown',
   *                      remainingMin:number, jobState:string|null }
   */
  publishLaundryState(slug, s = {}) {
    if (!this._entries.has(slug)) return;
    const st = String(s.state || 'unknown').toLowerCase();
    // 비정상 잔여시간(음수·거대값·NaN)이 HA 센서에 그대로 뜨지 않게 0~1440분으로 가둔다.
    let remain = Number(s.remainingMin);
    if (!Number.isFinite(remain)) remain = 0;
    remain = Math.max(0, Math.min(Math.round(remain), 1440));
    this._publishState(slug, {
      // ★'전원 꺼짐'은 여기서 상태값으로 표현된다 — availability를 건드리지 않는다.
      running: st === 'running' ? 'ON' : 'OFF',
      status: LAUNDRY_STATE_TEXT[st] || LAUNDRY_STATE_TEXT.unknown,
      remaining_min: remain,
    });
  }
}

module.exports = MqttBridge;
module.exports.LAUNDRY_STATE_TEXT = LAUNDRY_STATE_TEXT;
