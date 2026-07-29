'use strict';

// 홈브릿지(HAP) 최소 흉내 + 결정적 타이머.
//
// ★왜 필요한가: v2.4.5 감사에서 드러난 사실 — 클라이언트 계층만 계측하면
//   "운전 중 순단 = 로그 0줄" 같은 계약이 **실제 시스템에서는 거짓**일 수 있다.
//   예외를 받은 액세서리 계층이 따로 warn을 찍기 때문이다. 그래서 전 계층을 돌려야 한다.

/** setTimeout을 큐로 바꿔 "폴 N회"를 정확히 재현한다(실시간 대기 없음). */
function installFakeTimers() {
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  let seq = 0;
  const queue = new Map();
  global.setTimeout = (fn, ms) => { const id = ++seq; queue.set(id, fn); return { _id: id, unref() {}, ref() {} }; };
  global.clearTimeout = (h) => { if (h && h._id) queue.delete(h._id); };
  return {
    /** 지금 큐에 있는 콜백을 모두 한 번씩 실행한다(= 시간 한 칸 전진). */
    async tick() {
      const now = [...queue.entries()];
      queue.clear();
      for (const [, fn] of now) { try { fn(); } catch (_) { /* 콜백 내부 오류는 코드가 처리 */ } }
      // 콜백이 만든 프라미스 체인이 끝나도록 마이크로태스크를 충분히 비운다.
      for (let i = 0; i < 50; i++) await Promise.resolve();
    },
    pending() { return queue.size; },
    restore() { global.setTimeout = real.setTimeout; global.clearTimeout = real.clearTimeout; },
  };
}

/** HAP 스텁 — 실제 홈브릿지 API 중 이 플러그인이 쓰는 부분만. */
function mkHarness() {
  const mkChar = (name) => ({
    name, value: null, listeners: {},
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; },
    removeAllListeners(ev) { delete this.listeners[ev]; return this; },
    setProps() { return this; },
    updateValue(v) { this.value = v; return this; },
  });
  const mkService = (displayName) => ({
    displayName, _c: {},
    getCharacteristic(k) { return (this._c[k] = this._c[k] || mkChar(k)); },
    setCharacteristic(k, v) { this.getCharacteristic(k).value = v; return this; },
    updateCharacteristic(k, v) { this.getCharacteristic(k).value = v; return this; },
  });
  const mkAccessory = (displayName, uuid) => {
    const a = {
      displayName, UUID: uuid, context: {}, _s: new Map(),
      getService(t) { return this._s.get(t) || null; },
      addService(t, name) { const sv = mkService(name || displayName); this._s.set(t, sv); return sv; },
    };
    a.addService('AccessoryInformation', displayName);
    return a;
  };
  const C = new Proxy({}, { get: (_t, k) => {
    if (k === 'Active') return Object.assign('Active', { ACTIVE: 1, INACTIVE: 0 });
    if (k === 'InUse') return Object.assign('InUse', { IN_USE: 1, NOT_IN_USE: 0 });
    if (k === 'ValveType') return Object.assign('ValveType', { IRRIGATION: 1 });
    return String(k);
  } });
  const Service = new Proxy({}, { get: (_t, k) => String(k) });
  const registered = [];
  const api = {
    hap: { Service, Characteristic: C, uuid: { generate: (s) => 'uuid:' + s }, Perms: {} },
    platformAccessory: function (n, u) { return mkAccessory(n, u); },
    registerPlatformAccessories: (_p, _pl, accs) => registered.push(...accs),
  };
  const platform = {
    accessories: [], activeUUIDs: new Set(), PLUGIN_NAME: 'p', PLATFORM_NAME: 'P',
    registerShutdown: () => {},
  };
  return { api, platform, registered, mkAccessory, Service, C };
}

/** 로그를 레벨별로 모으는 로거. `visible()` = 홈브릿지 기본 레벨에서 보이는 줄. */
function mkLog() {
  const lines = [];
  const push = (lv) => (m) => lines.push([lv, String(m)]);
  return {
    lines,
    info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'),
    visible: () => lines.filter(([lv]) => lv !== 'debug'),
  };
}

module.exports = { installFakeTimers, mkHarness, mkLog };
