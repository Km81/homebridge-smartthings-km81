'use strict';

// 구형 8888(TLS 1.0 + Bearer) 세탁물 가전용 얇은 어댑터.
//
// ★새 클라이언트를 만들지 않는다. 전송은 **기존 `LegacyACClient`를 그대로 재사용**한다 —
//   2026-07-29 실기기 검증에서 세탁기가 구형 에어컨과 **완전히 같은 TLS 옵션**
//   (`DEFAULT@SECLEVEL=0`, min=max=TLSv1)과 **같은 `GET /devices` 응답 형태**를 쓴다는 것을
//   확인했다. 인증서도 같은 패키지 동봉 파일 하나를 공유한다(중복 생성·관리 금지).
//
// 이 파일이 하는 일은 **형태 변환 하나뿐**이다:
//   기기 응답  { Devices: [ {Operation:{...}, Washer:{...}}, ... ] }
//   → Laundry가 읽는 { main: {washerOperatingState:{...}}, sub: {...} }
//
// ★2-in-1은 `Devices[0]`=main, `Devices[1]`=sub로 매핑된다(실측: 두 조의 completionTime이
//   서로 달라 별개 구획임이 확인됨). 단일조 기기는 Devices가 1개라 sub가 없다.
const { LegacyACClient, getCertificate } = require('./LegacyACClient');
const LocalApplianceClient = require('./LocalApplianceClient');
const { DEFAULT_CERT_PATH, CONNECTION_ERROR_RE } = require('../shared');

// 기기의 Operation.state → Laundry가 판정에 쓰는 machineState.
// ⚠️'stop'은 Laundry가 jobState를 보지도 않고 즉시 '종료'로 확정하는 값이다. 그래서
//   **전원이 꺼져 있을 때만** 'stop'을 쓰고, 켜져 있는데 애매하면 'on'으로 넘겨
//   jobState 기반 판정(안티주름 등 후처리 단계)이 살아 있게 한다 — LocalApplianceClient와 같은 원칙.
// ★`power` 키가 **없는** 것과 `power:"Off"`는 다르다(v2.4.5 적대 감사 F-6).
//   예전엔 둘 다 falsy로 묶여 `state:"Run"`인데도 'stop'이 나왔고, 'stop'은 Laundry가
//   jobState를 보지도 않고 즉시 '종료'로 확정하는 값이라 **운전 중 거짓 종료 알림**이 됐다.
//   키가 아예 없으면 "전원 정보 없음"이므로 state 쪽 정보를 살려서 판정한다.
function toMachineState(state, power) {
  const s = String(state || '').toLowerCase();
  const running = s === 'run' || s === 'running' || s === 'active';
  const paused = s === 'pause' || s === 'paused';
  if (power === undefined || power === null) {
    // 전원 정보 없음 — state가 운전 계열이면 켜진 것으로 본다. 그 외는 판정을 미룬다('on').
    return running ? 'run' : paused ? 'pause' : 'on';
  }
  if (String(power).toLowerCase() !== 'on') return 'stop';
  if (running) return 'run';
  if (paused) return 'pause';
  return 'on';
}

/** 이 컴포넌트가 '운전 중'인가 — Laundry의 RUNNING 판정과 **같은 기준**을 쓴다. */
function isRunningComponent(machineState, jobState) {
  if (machineState === 'run' || machineState === 'pause') return true;
  // 안티주름·에어드라이 등 사이클 후 단계: machineState는 idle('on')로 떨어지지만 아직 돈다.
  return POST_CYCLE_JOB_STATES.has(jobState);
}

// 8888 기기의 `Operation.progress` → Laundry가 아는 jobState.
//
// ★★이 매퍼가 따로 있는 이유(적대 감사 F1 — 치명 결함이었다):
//   `LocalApplianceClient._jobState`를 그대로 쓰면 `"None"`이 `'none'`이 되는데,
//   Laundry의 `FINISHED_JOB_STATES`에 `'none'`이 들어 있고 그 검사가 **machineState보다 먼저**
//   평가된다. 즉 기기가 `state:"Run"`이라고 말해도 progress가 "None"이면 **즉시 '종료'로 확정**된다.
//   → 운전 내내 밸브가 꺼져 있고 종료 알림이 영영 안 울리거나, 중간에 "None"이 한 번 스치면
//     그 순간 조기 종료 알림이 나간다.
//   8888의 progress는 DTLS의 `currentJobState`와 값 집합이 다르고, 실측상 대기(Ready) 상태에서도
//   "None"이 나온다 — 즉 "종료"가 아니라 "부가 정보 없음"에 가깝다.
//   그래서 **Laundry가 확실히 아는 값만 통과시키고, 나머지는 null로 접어** machineState 판정에 맡긴다.
// 연결 계열 실패가 이만큼 연속되면 "기기 전원이 꺼졌다"로 해석한다.
// ★값을 크게 잡는 이유: 이 합성이 RUNNING→FINISHED 전환을 만들면 **종료 알림이 발사된다**.
// 운전 중 잠깐의 무선 끊김을 종료로 오인하면 '세탁 끝났다'는 거짓 알림이 가고, 복귀 후
// 다시 RUNNING이 되었다가 진짜 종료 때 두 번째 알림이 간다(전체 감사 R3).
// 한 번의 폴 실패에도 내부 재시도 3회가 붙으므로 5회면 실제로 수 분이다. 진짜 꺼진 기기는
// 계속 꺼져 있으니 늦게 판정해도 손해가 없고, 순단은 그 전에 복구된다.
const OFFLINE_AFTER = 5;

// 사이클 후 단계 — machineState가 idle이어도 '운전 중'으로 봐야 하는 jobState.
// ★`Laundry.js`의 `POST_CYCLE_ACTIVE_JOB_STATES`와 **같은 집합이어야 한다.**
//   한쪽만 늘리면 "Laundry는 운전 중이라는데 이쪽은 아니라고 보는" 어긋남이 생기고,
//   그 어긋남이 v2.4.5 적대 감사 F-2(순단 1폴에 거짓 종료 알림)의 원인이었다.
const POST_CYCLE_JOB_STATES = new Set(['wrinklePrevent', 'wrinkleCare', 'airDry', 'refresh']);

const PROGRESS_MAP = {
  // 진행 단계 (RUNNING 유지)
  weightsensing: 'weightSensing', prewash: 'preWash', wash: 'washing', washing: 'washing',
  rinse: 'rinsing', rinsing: 'rinsing', spin: 'spinning', spinning: 'spinning',
  drying: 'drying', dry: 'drying', cooling: 'cooling',
  // 사이클 후 단계 (machineState가 idle이어도 RUNNING 유지되어야 하는 것들)
  wrinkleprevent: 'wrinklePrevent', wrinklecare: 'wrinkleCare',
  airdry: 'airDry', refresh: 'refresh',
  // 확정 종료
  finish: 'finished', finished: 'finished', end: 'finished', error: 'error',
};

class LegacyLaundryClient {
  /**
   * @param {object} log 홈브릿지 로거
   * @param {object} opts { ip, token, timeout, certPath }
   */
  constructor(log, opts = {}) {
    this.log = log;
    this.ip = opts.ip;
    this.label = opts.label || '세탁기';
    this.timeout = Number.isFinite(opts.timeout) ? opts.timeout : 8000;
    // 로컬이 안 될 때 기댈 곳(선택). 없으면 아래 '꺼짐 합성'으로 처리한다.
    this.cloud = opts.cloudClient || null;
    this.deviceId = opts.deviceId || null;
    this.fallbackToCloud = opts.fallbackToCloud !== false;
    this._offlineStreak = 0;
    // ★래치 2개를 분리한다(v2.4.5 적대 감사 L-F8). 예전엔 하나로 겸했더니,
    //   토큰 이상으로 클라우드 폴백 중이던 세탁기가 복구될 때 `전원 켜짐`이라고 찍혔다 —
    //   전원은 내내 켜져 있었는데도. 사용자가 로그를 오독하게 만드는 거짓말이었다.
    this._offlineNotified = false;    // "전원 꺼짐" 안내를 이미 냈는가
    this._fallbackNotified = false;   // "클라우드로 폴백" 경고를 이미 냈는가
    // 직전 폴에서 운전 중이었는지 — 무응답을 즉시 '꺼짐'으로 볼지 판단하는 데 쓴다.
    this._lastRunning = false;
    // 이 기기가 구획을 몇 개 주는지(1조 or 2-in-1). 꺼짐 합성 때 같은 개수를 만들어야
    // 분리 모드의 보조 구획이 영영 UNKNOWN으로 남지 않는다(적대 감사 F-4).
    this._lastCount = 1;
    const cert = getCertificate(opts.certPath || DEFAULT_CERT_PATH);
    // 같은 IP는 하나의 전송 인스턴스를 공유한다 — 기기가 동시 연결을 못 견디므로
    // 세탁기의 두 구획이 각자 소켓을 열지 않게 한다(구형 에어컨 거실/침실과 같은 이유).
    this.transport = LegacyACClient.getShared(this.ip, opts.token, log, {
      timeout: this.timeout, cert, key: cert, label: this.label, offlineIsNormal: true,
    });
  }

  /** 폴링 호출자가 기기 조회를 강제할 때 쓴다(클라우드 클라이언트와 시그니처 호환). */
  invalidateStatusCache() {
    this.transport._statusCache = null;
  }

  /**
   * Laundry 액세서리가 기대하는 컴포넌트 형태로 돌려준다.
   * @returns {Promise<{main: object, sub?: object}>}
   */
  async getStatus(deviceId) {
    let res;
    try {
      res = await this.transport.getDeviceStatus();
    } catch (e) {
      return this._handleUnreachable(e, deviceId);
    }
    const list = (res && (res.Devices || res.devices)) || [];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('기기가 Devices 목록을 주지 않았습니다');
    }
    if (this._offlineNotified) this.log.info(`[${this.label}] 전원 켜짐 — 로컬 연결됨`);
    else if (this._fallbackNotified) this.log.info(`[${this.label}] 로컬 복귀 — 클라우드 폴백 해제`);
    this._offlineStreak = 0;
    this._offlineNotified = false;
    this._fallbackNotified = false;

    const components = {};
    const NAMES = ['main', 'sub'];
    const n = Math.min(list.length, 2);
    // ★어느 쪽이 '메인'인지 **배열 순서로 정하지 않는다**(2026-07-30 실측으로 정정).
    //   실기기(WR20M9970KV)는 `Devices[0]`=콤팩트워시, `Devices[1]`=애드워시로 왔다 —
    //   애초에 순서를 보장하는 근거가 없었고, 내 초기 가정(0=애드워시)은 틀렸다.
    //   그래서 위치가 아니라 **기능**으로 고른다(아래 _isMainTub). 순서가 바뀌어도 안전하다.
    const ordered = LegacyLaundryClient._orderTubs(list.slice(0, 2));
    ordered.forEach((d, i) => {
      components[NAMES[i]] = LegacyLaundryClient._toComponent(d);
    });
    // ★한 번 2조로 확인된 기기가 갑자기 1조만 보내면, 사라진 구획을 **없애지 말고**
    //   '정보 없음'으로 채운다. 없애 버리면 Laundry가 그 슬롯을 못 보고 남은 구획만으로
    //   '종료'를 확정해 거짓 종료 알림을 낸다(적대 감사 F-1).
    if (n < this._lastCount) {
      for (let i = n; i < this._lastCount; i++) components[NAMES[i]] = { samsungce: {} };
    }
    this._lastCount = Math.max(this._lastCount, n);
    // 운전 중이었는지 기억한다 — 무응답을 '꺼짐'으로 얼마나 빨리 단정할지 정하는 데 쓴다.
    this._lastRunning = LegacyLaundryClient._anyRunning(components);
    return components;
  }

  /**
   * ★큰 세탁조(애드워시)인지 판별 — 기능으로 본다.
   *
   * 근거(2026-07-30 실기기 실측, SmartThings 앱으로 교차 확인):
   *   애드워시(큰 조)  : `spinLevel`·`dryLevel` 보유, `supportedProgress`에 `Weightsensing` 포함
   *   콤팩트워시(작은 조): 헹굼 횟수·수온만 — 탈수 강도 개념이 없다
   * 이 차이는 **상태가 아니라 기기 사양**이라 운전 여부와 무관하게 항상 같다.
   */
  static _isMainTub(dev) {
    const w = (dev && dev.Washer) || {};
    if (w.spinLevel !== undefined || w.supportedSpinLevel !== undefined) return true;
    if (w.dryLevel !== undefined || w.supportedDryLevel !== undefined) return true;
    const sp = (dev && dev.Operation && dev.Operation.supportedProgress) || [];
    return Array.isArray(sp) && sp.some((v) => String(v).toLowerCase() === 'weightsensing');
  }

  /**
   * 큰 조를 앞(main)으로 오게 정렬한다.
   * ⚠️판별이 애매하면(둘 다 해당 또는 둘 다 미해당) **원래 순서를 그대로 둔다** —
   *   근거 없이 뒤집는 것보다 기존 동작을 유지하는 편이 안전하다.
   *   ※합침 모드에서는 순서가 결과에 영향을 주지 않는다(RUNNING 우선·잔여시간 최대값).
   *     이 정렬이 실제로 의미를 갖는 것은 세탁조 분리 표시를 켰을 때의 이름표다.
   */
  static _orderTubs(list) {
    if (!Array.isArray(list) || list.length < 2) return list;
    const flags = list.map((d) => LegacyLaundryClient._isMainTub(d));
    if (flags[0] === flags[1]) return list;          // 애매 → 원래 순서 유지
    return flags[1] ? [list[1], list[0]] : list;     // 큰 조를 앞으로
  }

  /** 컴포넌트 묶음 중 하나라도 운전 중인가 (Laundry의 RUNNING 판정과 같은 기준). */
  static _anyRunning(components) {
    return Object.values(components || {}).some((c) => {
      const st = c && c.washerOperatingState;
      if (!st) return false;
      const ms = st.machineState && st.machineState.value;
      const js = (st.washerJobState && st.washerJobState.value)
        || (st.jobState && st.jobState.value);
      return isRunningComponent(ms, js);
    });
  }

  /**
   * ★기기에 못 닿았을 때 (적대 감사 D1/D2 — 배포 전 필수로 지목된 항목).
   *
   * **세탁기는 전원을 끄면 네트워크에서 사라진다.** 즉 하루의 대부분이 "무응답"이고 그게 정상이다.
   * 이걸 고장으로 다루면 세 가지가 한꺼번에 터진다:
   *   ① 홈킷 타일이 마지막 상태로 **영구 동결**(폴링 예외는 상태를 갱신하지 않으므로)
   *   ② 다음에 전원을 켤 때 동결된 '동작중'→'완료' 전이가 일어나 **몇 시간 뒤 유령 종료 알림**
   *   ③ 실패 문구가 hb-watch의 경보 정규식에 걸려 **매일 밤 오탐 경보**
   * 그래서 연결 계열 실패가 연속되면 '꺼짐'으로 해석해 정상 종료 상태를 만든다.
   */
  async _handleUnreachable(e, deviceId) {
    const msg = (e && e.message) || '';
    // ★403 쿨다운은 "기기가 바쁘다"는 뜻일 뿐이다 — 클라우드로 넘어갈 사건이 아니다.
    //   세탁기는 사이클 종료 직후 반드시 한 번 이걸 낸다(2026-07-30 실사이클 실측).
    //   예전엔 폴백을 태워서 세탁할 때마다 클라우드 호출 1회가 나갔다.
    //   직전 상태를 유지하고 다음 폴을 기다리면 된다 — 대개 10초 뒤 풀린다.
    if (e && e.cooldown) {
      e._transient = true;
      throw e;
    }
    const connish = CONNECTION_ERROR_RE.test(msg);
    // ★스트릭은 **연결 계열 실패만** 센다(적대 감사 F-7). 예전엔 무조건 올려서,
    //   "응답 깨짐 4회 + 연결 실패 1회"만으로 5회 문턱을 넘겨 버렸다. 그러면
    //   "연결 실패가 5회 연속되어야 꺼진 것으로 본다"는 방어벽이 실제로는 1회로 줄어든다.
    if (connish) this._offlineStreak++;
    else this._offlineStreak = 0;

    if (connish) {
      // ★연결이 안 되는 것은 **상태**다 — 폴백할 사건이 아니다.
      //
      // 얼마나 빨리 단정하느냐만 직전 상태에 따라 다르다:
      //  · 직전에 돌고 있지 않았다면(=꺼져 있었거나 방금 부팅했다면) **즉시** 꺼짐으로 본다.
      //    홈브릿지를 재시작했을 때 이미 꺼져 있는 세탁기를 몇십 초씩 '알 수 없음'으로
      //    두지 않기 위해서다.
      //  · 직전에 운전 중이었다면 순간적인 무선 끊김을 '종료'로 오인해 **거짓 종료 알림**을
      //    보낼 수 있으므로 연속 실패를 요구한다.
      if (!this._lastRunning || this._offlineStreak >= OFFLINE_AFTER) {
        if (!this._offlineNotified) {
          this._offlineNotified = true;
          // ⚠️'실패/오류'가 아닌 문구 — 전원을 끈 것은 고장이 아니고, hb-watch 경보에도
          //    걸리면 안 된다.
          this.log.info(`[${this.label}] 전원 꺼짐 — 로컬 응답 없음`);
        }
        this._lastRunning = false;
        // ★구획 수를 마지막으로 본 것과 맞춘다(적대 감사 F-4). main 하나만 만들면
        //   세탁조 분리 모드에서 보조 구획이 영영 '정보 없음'으로 남고, Laundry가
        //   11폴마다 "FINISHED로 강제 전환" warn을 무한 반복한다(밤새 수백 줄).
        //   전원이 꺼졌다는 건 물리적으로 두 조 모두 꺼졌다는 뜻이다.
        const off = {};
        const NAMES = ['main', 'sub'];
        // 최소 1개는 반드시 만든다 — main이 없는 응답은 소비자가 읽다가 죽는다.
        const count = Math.min(Math.max(1, this._lastCount || 1), NAMES.length);
        for (let i = 0; i < count; i++) off[NAMES[i]] = LegacyLaundryClient._offComponent();
        // ★이건 **기기가 준 응답이 아니라 우리가 만든 값**이다. 위층이 이걸 "통신 성공"으로
        //   읽으면 `기기 접속됨` 접촉선과 `last_seen` 이 **닿지도 않은 기기에 대해** 참이라고
        //   말한다(적대 리뷰 F4·F5 — 세탁기 사망 판정이 정의상 불가능해졌다).
        //   열거되지 않게 달아 구획 순회에는 안 걸린다.
        Object.defineProperty(off, '__synthetic', { value: true, enumerable: false });
        return off;
      }
      // 운전 중 잠깐 끊긴 것 — 직전 상태를 유지하게 그대로 올린다.
      // ★`_transient`를 달아 보낸다: 위층(Laundry)이 이걸 '고장'으로 로그하면
      //   hb-watch가 텔레그램 오경보를 낸다(감사 L-F2). 문구로 거르는 건 취약하므로 플래그로.
      e._transient = true;
      throw e;
    }

    // 연결은 되는데 응답이 이상한 경우(토큰 무효 등)는 진짜 문제다.
    // 이때만 클라우드를 대안으로 쓴다(설정이 켜져 있고 쓸 수 있을 때).
    if (this.fallbackToCloud && this.cloud && (deviceId || this.deviceId)) {
      try {
        const r = await this.cloud.getStatus(deviceId || this.deviceId);
        if (!this._fallbackNotified) {
          this._fallbackNotified = true;
          this.log.warn(`[${this.label}] 로컬 응답 이상 — 클라우드로 폴백: ${msg}`);
        }
        // ★폴백으로 알아낸 '운전 중'도 기억해야 한다(적대 감사 F-3). 예전엔 로컬 성공
        //   경로에서만 갱신해서, 폴백을 한 번 타면 그 폴의 운전 사실이 오프라인 판정기에
        //   전달되지 않았다 → 다음 순단 1회에 즉시 꺼짐으로 단정해 거짓 종료 알림.
        this._lastRunning = LegacyLaundryClient._anyRunning(r);
        return r;
      } catch (ce) {
        // 이중 장애(로컬 이상 + 클라우드도 실패)를 흔적 없이 버리지 않는다.
        this.log.debug(`[${this.label}] 클라우드 폴백도 실패: ${(ce && ce.message) || ce}`);
      }
    }
    throw e;
  }

  /** 전원이 꺼진 것으로 간주할 때 쓰는 합성 상태. */
  static _offComponent() {
    const state = {
      machineState: { value: 'stop' },
      washerJobState: { value: null },
      dryerJobState: { value: null },
      jobState: { value: null },
    };
    return { samsungce: {}, washerOperatingState: state, dryerOperatingState: state };
  }

  /** progress 값을 Laundry가 아는 jobState로. 모르는 값·"None"은 null(=판정을 machineState에 맡김). */
  static _progressToJobState(v) {
    if (!v || typeof v !== 'string') return null;
    return PROGRESS_MAP[v.toLowerCase()] || null;
  }

  static _toComponent(dev) {
    const op = dev && dev.Operation;
    // ★상태 정보가 아예 없으면 **'꺼짐'으로 위조하지 않는다**(적대 감사 F2).
    // 'stop'은 Laundry가 jobState를 보지도 않고 즉시 '종료'로 확정하는 값이라,
    // 부팅 직후 같은 빈 응답에서 **종료 알림이 조기 발사**된다. 운전 상태 키를 아예 빼면
    // Laundry가 UNKNOWN으로 보고 직전 상태를 보존한다(빈 응답 보호 로직이 살아난다).
    if (!op || (op.state === undefined && op.power === undefined)) {
      return { samsungce: {} };
    }
    const machineState = toMachineState(op.state, op.power);
    const jobState = LegacyLaundryClient._progressToJobState(op.progress);
    const remainMin = LocalApplianceClient._hhmmssToMinutes(op.remainingTime);
    // 안티주름처럼 machineState는 'on'인데 실제로는 도는 단계에서도 잔여시간을 살려 둔다.
    // ★`_lastRunning` 판정과 **같은 함수**를 쓴다 — 두 판정이 어긋난 것이 F-2의 원인이었다.
    const running = isRunningComponent(machineState, jobState);
    // Laundry는 washerOperatingState / dryerOperatingState 어느 쪽이든 읽는다(pickOperatingState).
    // 세 키를 함께 내보내 액세서리 종류에 상관없이 도달하게 한다 —
    // ★v2.3.2가 키 하나만 내보내 "고쳤는데 한 번도 안 읽힌" 사고를 냈던 지점이다.
    const state = {
      machineState: { value: machineState },
      washerJobState: { value: jobState },
      dryerJobState: { value: jobState },
      jobState: { value: jobState },
    };
    // ★잔여시간은 **있을 때만** 넣는다(적대 감사 D-1). 예전엔 비운전 시 0을 넣었는데,
    // `getComponentDuration`은 0을 "정보 없음(null)"으로 접어 버려 **직전 값이 매 폴 재푸시**됐다.
    // 그러면 홈킷 카운트다운이 끝난 사이클의 값에 얼어붙은 채 남는다. 키를 아예 빼면
    // 소비자가 "정보 없음"으로 정확히 읽고, 종료 시에는 상태(FINISHED)가 0을 만든다.
    if (running && remainMin > 0) state.remainingTime = { value: remainMin };
    return {
      samsungce: {},
      washerOperatingState: state,
      dryerOperatingState: state,
    };
  }
}

module.exports = LegacyLaundryClient;
