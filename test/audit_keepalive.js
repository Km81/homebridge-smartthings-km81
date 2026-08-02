'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// keepalive 접합부 행동 검증 (v2.4.6 사후 보강)
//
// ★왜 이 파일이 따로 있나
//   keepalive의 **부품**(refresh 기계)은 audit_cloud-oauth.js가 오래 검증해 왔다
//   (성공/무효/회전 유실/single-flight 동시성/토큰 없음 급속거부).
//   그러나 v2.4.2~2.4.5에 새로 붙인 **접합부** — 타이머·게이트·실패 처리 — 는
//   소스 문자열 검사(audit_local-transport의 불변식)와 실발화 1회 관측뿐이었다.
//   사용자가 정확히 그 지점을 물었다: "여러 상황과 조건에서 실질적으로 검증한 거지?"
//   이 파일은 실제 `_startCloudKeepalive` 코드를 가짜 시계로 **여러 날** 돌려 행동으로 답한다.
//
// 검증 항목(전부 실제 코드 실행 — 소스 grep 아님):
//   K1  로컬 기기 없음 → 아예 안 걺 (클라우드 상시 구성)
//   K2  전 기기 폴백 OFF → 안 걺 + "클라우드 호출 0회" 안내
//   K3  첫 실행 = 부팅+30분 (그 전 호출 0)
//   K4  이후 24시간마다 — 가짜 시계로 7일 돌려 총 8회
//   K5  일시 실패 → warn 1줄·throw 없음·**다음 날 재시도 계속**
//   K6  최종 실패(_fatalAuth) → error 1줄·타이머 유지(다음 날 또 시도)·재인증 문구
//   K7  ★실패해도 토큰 파일을 지우는 경로에 닿지 않는다 (_triggerReauth·파일 삭제 스파이 0회)
//   K8  ★동시성 — keepalive와 401 인터셉터 갱신이 겹쳐도 refresh POST 1회 (진짜 클라이언트로)
//   K9  shutdown 후에는 아무리 시간이 가도 추가 호출 0
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('assert');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

// index.js에서 플랫폼 클래스를 꺼낸다 — registerPlatform으로 넘어오는 생성자를 가로챈다.
let Platform = null;
require('../index.js')({
  hap: { uuid: { generate: () => 'u' } },
  registerPlatform: (_p, _n, cls) => { Platform = cls; },
});
assert(Platform, '플랫폼 클래스 확보 실패');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── 지연 시간을 아는 가짜 시계 (setTimeout/setInterval 모두) ────────────────────
function mkClock() {
  const timers = [];            // {at, fn, every|null, id}
  let now = 0, seq = 0;
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, every: null, id }); return { _id: id }; },
    setInterval: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, every: ms, id }); return { _id: id }; },
    clearTimeout: (h) => { const i = timers.findIndex(x => x.id === (h && h._id)); if (i >= 0) timers.splice(i, 1); },
    clearInterval(h) { this.clearTimeout(h); },
    /** ms만큼 시간을 전진시키며 도래한 콜백을 순서대로 실행(비동기 완료까지 대기). */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at = now + due.every;
        else timers.splice(timers.indexOf(due), 1);
        await due.fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      now = end;
    },
  };
}

const mkLog = () => {
  const L = { info: [], warn: [], error: [], debug: [] };
  return { L, info: m => L.info.push(String(m)), warn: m => L.warn.push(String(m)),
    error: m => L.error.push(String(m)), debug: m => L.debug.push(String(m)) };
};

/**
 * 가짜 this로 실제 _startCloudKeepalive를 실행한다.
 * ★가짜 시계는 **시나리오가 끝날 때까지** 전역에 걸어 둔다 — 30분 뒤 콜백 안에서
 *   setInterval이 새로 만들어지므로, 등록 직후 원복하면 그 interval이 진짜 타이머로
 *   새어 나가 "하루 1회"가 영영 안 돈다(첫 실행에서 실제로 그렇게 실패했다).
 *   시나리오 끝에 반드시 restore()를 부를 것.
 */
function runKeepalive({ devices, smartthings, clock }) {
  const log = mkLog();
  const shutdowns = [];
  const self = {
    smartthings, devices, log,
    registerShutdown: (fn) => shutdowns.push(fn),
  };
  const real = {
    TO: global.setTimeout, TI: global.setInterval,
    CO: global.clearTimeout, CI: global.clearInterval,
  };
  global.setTimeout = clock.setTimeout.bind(clock);
  global.setInterval = clock.setInterval.bind(clock);
  global.clearTimeout = clock.clearTimeout.bind(clock);
  global.clearInterval = clock.clearInterval.bind(clock);
  Platform.prototype._startCloudKeepalive.call(self);
  return {
    log, shutdowns,
    shutdown: () => shutdowns.forEach(f => f()),
    restore: () => {
      global.setTimeout = real.TO; global.setInterval = real.TI;
      global.clearTimeout = real.CO; global.clearInterval = real.CI;
    },
  };
}

const LOCAL_DEV = { transport: 'local', local: { fallbackToCloud: true } };
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

(async () => {
  console.log('[K] keepalive 접합부 — 실제 코드, 가짜 시계로 여러 날 실행\n');

  // K1 — 로컬 기기 없음
  {
    const clock = mkClock();
    let calls = 0;
    const ka = runKeepalive({ clock, devices: [{ transport: 'cloud' }],
      smartthings: { _refreshTokenSingleFlight: async () => { calls++; } } });
    const { log } = ka;
    await clock.advance(3 * DAY);
    ka.restore();
    t('K1 클라우드 상시 구성 → keepalive 안 걺 (3일 동안 호출 0)', calls === 0 && !log.L.info.some(m => m.includes('keepalive 활성')));
  }

  // K2 — 전 기기 폴백 OFF
  {
    const clock = mkClock();
    let calls = 0;
    const ka = runKeepalive({ clock,
      devices: [{ transport: 'local', local: { fallbackToCloud: false } },
        { transport: 'local', local: { fallbackToCloud: false } }],
      smartthings: { _refreshTokenSingleFlight: async () => { calls++; } } });
    const { log } = ka;
    await clock.advance(3 * DAY);
    ka.restore();
    const note = log.L.info.find(m => m.includes('keepalive를 걸지 않습니다')) || '';
    t('K2 폴백 전부 OFF → keepalive를 걸지 않고 그 사실을 알린다', calls === 0 && !!note);
    // ★★2026-08-03 적대 리뷰 — 안내가 **사실이어야 한다**. OAuth를 남긴 채 폴백만 끈
    //   구성에서는 같은 부팅에 이미 기기 검색(`GET /v1/devices`)이 나갔을 수 있으므로
    //   「클라우드 호출 0회」는 거짓말이 된다. 참인 것(=앞으로 주기 호출 없음)만 말한다.
    t('K2b 안내가 "총 0회"라고 단정하지 않는다 (거짓말 금지)',
      !/호출\s*0회/.test(note) && /주기/.test(note));
  }

  // K3·K4 — 첫 실행 30분, 이후 24시간마다 (7일 = 총 8회)
  {
    const clock = mkClock();
    let calls = 0;
    const ka = runKeepalive({ clock, devices: [LOCAL_DEV],
      smartthings: { _refreshTokenSingleFlight: async () => { calls++; } } });
    const { log } = ka;
    await clock.advance(29 * MIN);
    t('K3a 부팅 29분까지는 호출 0', calls === 0);
    await clock.advance(2 * MIN);
    t('K3b 30분 지점에 첫 갱신 1회', calls === 1, `실측 ${calls}`);
    await clock.advance(7 * DAY);
    t('K4 7일 경과 → 총 8회 (하루 1회 정확)', calls === 8, `실측 ${calls}`);
    t('K4b 성공 로그도 8회 (매회 확인 가능)', log.L.info.filter(m => m.includes('갱신됨')).length === 8);
    ka.restore();
  }

  // K5 — 일시 실패: warn 후 다음 날 재시도 계속, throw가 밖으로 새지 않음
  {
    const clock = mkClock();
    let calls = 0;
    let escaped = false;
    process.once('unhandledRejection', () => { escaped = true; });
    const ka = runKeepalive({ clock, devices: [LOCAL_DEV],
      smartthings: { _refreshTokenSingleFlight: async () => {
        calls++;
        if (calls <= 2) throw new Error('ETIMEDOUT 흉내');   // 첫 이틀 실패
      } } });
    const { log } = ka;
    await clock.advance(30 * MIN + 3 * DAY);
    ka.restore();
    t('K5a 실패해도 주기 유지 — 4회 시도(실패 2 + 성공 2)', calls === 4, `실측 ${calls}`);
    t('K5b 일시 실패는 warn ("다음 주기" 안내)', log.L.warn.filter(m => m.includes('다음 주기')).length === 2);
    t('K5c error 0줄·unhandledRejection 없음', log.L.error.length === 0 && !escaped);
  }

  // K6·K7 — 최종 실패(_fatalAuth): error 1줄/일, 파일 삭제 경로 미접촉, 다음 날 또 시도
  {
    const clock = mkClock();
    let calls = 0, reauthCalled = 0, fileDeleted = 0;
    const ka = runKeepalive({ clock, devices: [LOCAL_DEV],
      smartthings: {
        _refreshTokenSingleFlight: async () => {
          calls++;
          const e = new Error('invalid_grant'); e._fatalAuth = true; throw e;
        },
        _triggerReauth: async () => { reauthCalled++; },
        deleteTokenFile: async () => { fileDeleted++; },
      } });
    const { log } = ka;
    await clock.advance(30 * MIN + 2 * DAY);
    ka.restore();
    t('K6a 최종 실패 → "재인증이 필요합니다" error (하루 1줄 × 3일)', log.L.error.filter(m => m.includes('재인증이 필요합니다')).length === 3, JSON.stringify(log.L.error));
    t('K6b 타이머는 유지 — 매일 다시 시도 (서버 쪽 복구 자동 반영)', calls === 3, `실측 ${calls}`);
    t('K7 ★파일 삭제·재인증 트리거에 닿지 않음 (스파이 0회)', reauthCalled === 0 && fileDeleted === 0);
  }

  // K8 — ★동시성: 진짜 SmartThingsClient로 keepalive + 인터셉터 갱신 충돌 → POST 1회
  {
    const axios = require('axios');
    const SmartThingsClient = require('../lib/api/SmartThingsClient');
    const tmp = path.join(os.tmpdir(), `ka-audit-${process.pid}`);
    await fsp.mkdir(tmp, { recursive: true });
    const log = mkLog();
    const c = new SmartThingsClient(log,
      { user: { persistPath: () => tmp } },
      { clientId: 'x', clientSecret: 'y' });
    c.tokens = { access_token: 'a'.repeat(24), refresh_token: 'r'.repeat(24) };
    const origPost = axios.post;
    let posts = 0;
    axios.post = async () => {
      posts++;
      await new Promise(r => setTimeout(r, 50));   // 겹치는 창을 만든다
      return { data: { access_token: 'N'.repeat(24), refresh_token: 'R'.repeat(24) } };
    };
    try {
      // keepalive의 호출 방식과 401 인터셉터의 호출 방식을 동시에 발사
      const r = await Promise.allSettled([
        c._refreshTokenSingleFlight(),   // ← index.js keepalive가 부르는 바로 그 메서드
        c._refreshTokenSingleFlight(),   // ← 인터셉터(SmartThingsClient.js:153)와 같은 경로
      ]);
      t('K8a keepalive·인터셉터 갱신 충돌 → refresh POST 정확히 1회', posts === 1, `실측 ${posts}`);
      t('K8b 두 호출 모두 성공으로 수렴', r.every(x => x.status === 'fulfilled'));
      t('K8c 회전된 토큰이 저장됨', c.tokens.refresh_token === 'R'.repeat(24));
    } finally {
      axios.post = origPost;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  // K9 — shutdown 후 추가 호출 0
  {
    const clock = mkClock();
    let calls = 0;
    const ka = runKeepalive({ clock, devices: [LOCAL_DEV],
      smartthings: { _refreshTokenSingleFlight: async () => { calls++; } } });
    await clock.advance(30 * MIN + 1 * DAY);   // 2회
    ka.shutdown();
    await clock.advance(10 * DAY);
    ka.restore();
    t('K9 shutdown 후 10일 지나도 추가 호출 0', calls === 2, `실측 ${calls}`);
  }

  console.log(`\n총 ${pass + fail}건 / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
