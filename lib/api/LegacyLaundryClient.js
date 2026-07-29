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

// 기기의 Operation.state → Laundry가 판정에 쓰는 machineState.
// ⚠️'stop'은 Laundry가 jobState를 보지도 않고 즉시 '종료'로 확정하는 값이다. 그래서
//   **전원이 꺼져 있을 때만** 'stop'을 쓰고, 켜져 있는데 애매하면 'on'으로 넘겨
//   jobState 기반 판정(안티주름 등 후처리 단계)이 살아 있게 한다 — LocalApplianceClient와 같은 원칙.
function toMachineState(state, power) {
  const on = String(power || '').toLowerCase() === 'on';
  const s = String(state || '').toLowerCase();
  if (!on) return 'stop';
  if (s === 'run' || s === 'running' || s === 'active') return 'run';
  if (s === 'pause' || s === 'paused') return 'pause';
  return 'on';
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
    this._offlineNotified = false;
    const cert = getCertificate(opts.certPath);
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
    if (this._offlineNotified) {
      this.log.info(`[${this.label}] 로컬 복귀 — 기기가 다시 응답합니다.`);
    }
    this._offlineStreak = 0;
    this._offlineNotified = false;

    const components = {};
    const NAMES = ['main', 'sub'];
    list.slice(0, 2).forEach((d, i) => {
      components[NAMES[i]] = LegacyLaundryClient._toComponent(d);
    });
    return components;
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
    this._offlineStreak++;
    const connish = /timeout|시간 초과|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|소켓/i
      .test(e && (e.message || ''));

    // 클라우드를 쓸 수 있으면 그쪽이 더 정확하다(기기 전원 상태를 그대로 알려 준다).
    if (this.fallbackToCloud && this.cloud && (deviceId || this.deviceId)) {
      try {
        const r = await this.cloud.getStatus(deviceId || this.deviceId);
        if (!this._offlineNotified) {
          this._offlineNotified = true;
          this.log.warn(`[${this.label}] 로컬(8888) 응답 없음 — 클라우드로 폴백: ${e.message}`);
        }
        return r;
      } catch (_) { /* 클라우드도 실패하면 아래 '꺼짐 합성'으로 */ }
    }

    if (connish && this._offlineStreak >= OFFLINE_AFTER) {
      if (!this._offlineNotified) {
        this._offlineNotified = true;
        // ⚠️info + '실패/오류'가 아닌 문구 — hb-watch 경보 정규식에 걸리지 않게 한다.
        //    전원을 끈 것은 고장이 아니다.
        this.log.info(`[${this.label}] 기기가 응답하지 않습니다 — 전원이 꺼진 것으로 보고 '종료'로 처리합니다.`);
      }
      return { main: LegacyLaundryClient._offComponent() };
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
    const postCycle = jobState === 'wrinklePrevent' || jobState === 'wrinkleCare'
      || jobState === 'airDry' || jobState === 'refresh';
    const running = machineState === 'run' || machineState === 'pause' || postCycle;
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
