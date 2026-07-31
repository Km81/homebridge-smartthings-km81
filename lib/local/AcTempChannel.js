'use strict';

/**
 * 에어컨 온도 리소스 경로 판별.
 *
 * 삼성 에어컨은 보드에 따라 온도를 둘 중 한 방식으로 노출한다.
 *
 *   표준  /temperature/current/0 · /temperature/desired/0
 *         → { range: [16, 30], units: 'C', temperature: 29 }        (숫자)
 *   제조사 /temperatures/vs/0
 *         → { 'x.com.samsung.da.items': [ { …current: '29.0', …desired: '25.0' } ] }  (문자열)
 *
 * 어느 쪽인지는 모델명으로 알 수 없다. 천장형과 일부 벽걸이가 표준 경로를 아예 만들지
 * 않는 반면 창문형·2in1은 갖고 있다. 그래서 첫 조회 때 표준 경로에 물어보고, 그 기기에
 * 없다는 답(CoAP 4.04)이 오면 제조사 경로로 굳힌다.
 *
 * 두 경로가 다 있는 보드에서는 표준이 정답이다. 그런 보드는 제조사 경로에 쓴 값을
 * 무시하므로 섞어 쓰면 안 된다. (실측 2026-08-01 승준 에어컨: 두 경로의 현재 29.0 ·
 * 희망 25.0이 일치, 증분은 표준 range 대비 제조사 min 18 / max 30.)
 */

const STD_CURRENT = ['temperature', 'current', '0'];
const STD_DESIRED = ['temperature', 'desired', '0'];
const VENDOR = ['temperatures', 'vs', '0'];

const ITEMS = 'x.com.samsung.da.items';
const FIELD = {
  id: 'x.com.samsung.da.id',
  current: 'x.com.samsung.da.current',
  desired: 'x.com.samsung.da.desired',
  minimum: 'x.com.samsung.da.minimum',
  maximum: 'x.com.samsung.da.maximum',
  increment: 'x.com.samsung.da.increment',
};

const STANDARD = 'standard';
const VENDORCH = 'vendor';

function firstItem(rep) {
  const items = rep && rep[ITEMS];
  return Array.isArray(items) && items.length ? items[0] : null;
}

function num(v) {
  if (v === null || v === undefined) return null;
  // ⚠️`Number('')`도 `Number(' ')`도 0이다. 공백만 든 값을 0℃로 읽으면 안 된다.
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 기기가 정한 단위에 맞춰 값을 스냅한다. 단위를 모르면 1℃로 본다(기존 동작). */
function snapTo(value, step) {
  const inc = step !== null && step > 0 ? step : 1;
  return Math.round(value / inc) * inc;
}

/**
 * 온도를 문자열로 만든다.
 * 정수는 `"23"` — 실기기에서 동작이 확인된 형식이라 그대로 둔다.
 * 0.5 단위 기기에서만 `"27.5"`처럼 소수를 쓴다(정수로 뭉개면 사용자가 맞춰 둔 값이 바뀐다).
 */
function formatTemp(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// 판별은 **읽는 항목별로** 한다. 한 보드가 두 항목을 같은 방식으로 노출하는 것이 보통이지만,
// 현재온도만 표준으로 두고 희망온도는 제조사 쪽에만 싣는 보드가 보고돼 있다. 기기별로 하나만
// 정하면 그런 보드는 재시작 전까지 같은 실패를 반복한다.
const CURRENT = 'current';
const DESIRED = 'desired';
const SPEC = {
  [CURRENT]: { std: STD_CURRENT, field: FIELD.current, what: '실내온도' },
  [DESIRED]: { std: STD_DESIRED, field: FIELD.desired, what: '희망온도' },
};

class AcTempChannel {
  /** @param client `_get`·`_post`·`log`·`_labelOf`를 제공하는 LocalApplianceClient */
  constructor(client) {
    this.client = client;
    this._channel = new Map();     // `${deviceId}|${which}` → 'standard' | 'vendor'
    this._inflight = new Map();
    this._announced = new Set();   // 제조사 경로 안내를 이미 낸 기기
  }

  /** 판별 결과를 버린다(기기 교체·펌웨어 변경 시 다시 물어보게). */
  forget(deviceId) {
    for (const which of [CURRENT, DESIRED]) this._channel.delete(`${deviceId}|${which}`);
    this._announced.delete(deviceId);
  }

  channelOf(deviceId, which = CURRENT) {
    return this._channel.get(`${deviceId}|${which}`) || null;
  }

  async resolve(deviceId, which = CURRENT) {
    const key = `${deviceId}|${which}`;
    const known = this._channel.get(key);
    if (known) return known;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const run = this._detect(deviceId, which).finally(() => this._inflight.delete(key));
    this._inflight.set(key, run);
    return run;
  }

  async _detect(deviceId, which) {
    const spec = SPEC[which];
    let answeredButEmpty = false;
    try {
      const r = await this.client._get(deviceId, spec.std);
      if (num(r && r.temperature) !== null) return this._remember(deviceId, which, STANDARD);
      // 응답은 왔는데 값이 비어 있다. 표준 경로를 껍데기로만 두고 실제 값은 제조사 쪽에
      // 싣는 보드가 있어, 여기서 단정하지 않고 아래에서 제조사 경로를 확인한다.
      answeredButEmpty = true;
    } catch (e) {
      // ★리소스 부재만 제조사 경로로 넘어가는 근거가 된다. 통신 실패는 그대로 올려
      //   다음 폴에서 다시 판별하게 한다 — 한 번의 순단으로 경로를 잘못 굳히면 안 된다.
      if (!e || e.notFound !== true) throw e;
    }
    const item = firstItem(await this.client._get(deviceId, VENDOR));
    if (!item || num(item[spec.field]) === null) {
      throw new Error(`이 기기에서 ${spec.what} 리소스를 찾지 못했습니다`);
    }
    // ★굳히는 근거는 **'없다'는 확정 답(4.04)뿐**이다.
    //   응답은 했는데 값만 비어 있는 것은 일시 상태일 수 있다. 그걸로 굳히면, 두 경로를 다
    //   가진 보드가 제조사 쪽으로 영구 고정된다 — 그런 보드는 제조사 쓰기를 **무시**하므로
    //   온도 명령이 성공으로 보고되면서 조용히 사라지고, 읽기는 두 경로 값이 같아
    //   어떤 로그로도 드러나지 않는다. 그래서 이 경우는 이번 회차만 제조사로 읽는다.
    if (answeredButEmpty) return VENDORCH;
    return this._remember(deviceId, which, VENDORCH);
  }

  _remember(deviceId, which, channel) {
    this._channel.set(`${deviceId}|${which}`, channel);
    const label = typeof this.client._labelOf === 'function'
      ? this.client._labelOf(deviceId) : deviceId;
    const log = this.client.log;
    if (channel === VENDORCH) {
      // 두 항목이 모두 제조사 경로여도 안내는 기기당 한 줄이면 충분하다.
      if (!this._announced.has(deviceId)) {
        this._announced.add(deviceId);
        log?.info?.(`[${label}] 이 기기에는 표준 온도 리소스가 없어 제조사 경로(/temperatures/vs/0)를 씁니다`);
      }
    } else {
      log?.debug?.(`[${label}] ${SPEC[which].what} 경로 = 표준(/${SPEC[which].std.join('/')})`);
    }
    return channel;
  }

  async _read(deviceId, which) {
    const spec = SPEC[which];
    const channel = await this.resolve(deviceId, which);
    const v = channel === STANDARD
      ? num((await this.client._get(deviceId, spec.std) || {}).temperature)
      : num((firstItem(await this.client._get(deviceId, VENDOR)) || {})[spec.field]);
    if (v === null) throw new Error(`${spec.what} 응답에 값이 없습니다`);
    return v;
  }

  readCurrent(deviceId) { return this._read(deviceId, CURRENT); }
  readDesired(deviceId) { return this._read(deviceId, DESIRED); }

  async writeDesired(deviceId, value) {
    // 숫자가 아닌 것이 들어오면 여기서 막는다. 안 막으면 제조사 경로로 문자열 `"NaN"`이
    // 그대로 나간다(호출부마다 검사가 있지만, 이 계약은 여기서 지키는 것이 맞다).
    const target = Number(value);
    if (!Number.isFinite(target)) throw new Error(`온도 값이 올바르지 않습니다: ${value}`);
    // 쓰기는 **희망온도를 읽는 경로와 같은 쪽**으로 보낸다. 갈라지면 쓴 값이 다음 조회에
    // 안 보이고, 그러면 "이미 그 상태네" 판정에 걸려 명령이 생략된다.
    const channel = await this.resolve(deviceId, DESIRED);
    if (channel === STANDARD) {
      return this.client._post(deviceId, STD_DESIRED, { temperature: target });
    }
    // 제조사 경로는 ①문자열로 ②`id`와 `desired`만 보낸다.
    // 읽은 값을 통째로 되돌려 보내면 기기가 거부한다.
    //
    // ⚠️단위는 기기가 정한다. 천장형은 0.5℃ 단위인 모델이 있어(실사용자 앱 화면에서 27.5℃
    //    확인) 정수로 반올림해 보내면 사용자가 앱에서 맞춰 둔 값이 뭉개진다. 기기가 알려준
    //    increment에 맞춰 스냅한다. 정수면 정수 문자열(실기기 확인 형식), 아니면 소수 한 자리.
    const item = firstItem(await this.client._get(deviceId, VENDOR)) || {};
    const step = num(item[FIELD.increment]);
    const snapped = snapTo(target, step);
    return this.client._post(deviceId, VENDOR, {
      [ITEMS]: [{ [FIELD.id]: '0', [FIELD.desired]: formatTemp(snapped) }],
    });
  }

  /** 기기가 허용하는 희망온도 범위. 알 수 없으면 null을 돌려 호출부 기본값을 쓰게 한다. */
  async readLimits(deviceId) {
    if (await this.resolve(deviceId, DESIRED) === STANDARD) {
      const range = (await this.client._get(deviceId, STD_DESIRED) || {}).range;
      if (!Array.isArray(range) || range.length < 2) return null;
      const [min, max] = [num(range[0]), num(range[1])];
      return min === null || max === null ? null : { min, max };
    }
    const item = firstItem(await this.client._get(deviceId, VENDOR)) || {};
    const min = num(item[FIELD.minimum]);
    const max = num(item[FIELD.maximum]);
    return min === null || max === null ? null : { min, max };
  }
}

AcTempChannel.STANDARD = STANDARD;
AcTempChannel.VENDOR = VENDORCH;
AcTempChannel.CURRENT = CURRENT;
AcTempChannel.DESIRED = DESIRED;
AcTempChannel.PATHS = { STD_CURRENT, STD_DESIRED, VENDOR };
AcTempChannel.FIELD = FIELD;
AcTempChannel.ITEMS = ITEMS;

module.exports = AcTempChannel;
