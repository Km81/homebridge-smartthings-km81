'use strict';
/**
 * audit_cloud-oauth.js — SmartAC 클라우드 / OAuth 차원 표적 감사
 *
 * 검증 대상 가설
 *  A. refreshToken() 재시도 루프 × refresh 토큰 회전 — 일시 타임아웃이 유효 토큰을 태우는가
 *  B. 401 → 단일비행 refresh (동시 401 폭주 시 refresh 1회) + 재인증 래치
 *  C. v1.8.28 off 재시도 의도 가드 — 커스텀 axios config(_deviceId/_sentAt)가 실제로
 *     err.config까지 살아남는가(설치된 axios 1.18에서 실측). 살아남지 못하면 가드는 사문
 *  D. axios-retry retryCondition — 단독 switch:off만 재시도, 그 외 command POST는 차단
 *  E. v2.1.0/2.1.1 신규 코드(_fmtCommand/_fmtCommands/registerDeviceLabel/_labelOf) — 커버리지 0 구간
 *  F. sendCommand 성공/실패 경로의 부수효과(캐시 무효화 2회, 1500ms 지연분) 보존
 *  G. 끄기 장면(off-scene) 억제가 "실제 SmartThingsClient"를 통과할 때도 성립하는가
 *  H. OAuthServer — state CSRF 검증, 실패 시 state 미소진(재시도 가능), webhook SSRF 화이트리스트
 *
 * 시간 축 축소: 없음(실타이머 그대로). 단 A의 3회 소진 케이스는 백오프 2s+4s가 실제로 흘러
 * ~6s, D의 off 재시도 케이스는 axios-retry 백오프 1+2+4s로 ~7s가 소요된다. 그 외는 즉시.
 * lib/ 소스는 일절 수정하지 않는다(읽기 전용 검증).
 */

const path = require('path');
const os = require('os');
const http = require('http');
const realFsp = require('fs').promises;

let checks = 0, fails = 0;
const failedNames = [];
function assert(cond, name) {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) { fails++; failedNames.push(name); }
}
function mkLog() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const j = (a) => a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  return {
    lines,
    info: (...a) => lines.info.push(j(a)),
    warn: (...a) => lines.warn.push(j(a)),
    error: (...a) => lines.error.push(j(a)),
    debug: (...a) => lines.debug.push(j(a)),
  };
}
const count = (arr, s) => arr.filter(l => l.includes(s)).length;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const axios = require('axios');
const STC = require('../lib/api/SmartThingsClient.js');

// ── 공용: 실제 생성자를 통과한 클라이언트(인터셉터+axios-retry 전부 실물) ──
function mkClient(log, { adapter, tokenPath }) {
  const api = { user: { persistPath: () => tokenPath } };
  const cfg = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://127.0.0.1:18999/cb' };
  const c = new STC(log, api, cfg);
  c.tokens = { access_token: 'a'.repeat(24), refresh_token: 'r'.repeat(24) };
  if (adapter) c.client.defaults.adapter = adapter;
  return c;
}
function mkAxiosError(config, status, data) {
  const e = new Error(status ? `Request failed with status code ${status}` : 'ECONNABORTED');
  e.isAxiosError = true;
  e.config = config;
  if (status) e.response = { status, data: data || { error: { code: 'ConstraintViolationError', message: 'bad' } }, config, headers: {} };
  else e.code = 'ECONNABORTED';
  return e;
}

(async () => {

// ═══════════════════════════════════════════════════════════════════
console.log('\n[A] refreshToken() — 회전하는 refresh 토큰 × 재시도 루프');
// ═══════════════════════════════════════════════════════════════════
{
  const origPost = axios.post;
  const tmp = path.join(os.tmpdir(), `stc-audit-${Date.now()}`);
  await realFsp.mkdir(tmp, { recursive: true });

  // A1. 정상 갱신 — refresh_token 미회전(응답 누락) 시 기존 값 보존
  {
    const log = mkLog();
    const c = mkClient(log, { tokenPath: tmp });
    axios.post = async () => ({ data: { access_token: 'NEW'.repeat(8) } });
    const at = await c.refreshToken();
    assert(at === 'NEW'.repeat(8), 'A1 갱신 성공 — 새 access_token 반환');
    assert(c.tokens.refresh_token === 'r'.repeat(24), 'A1 응답에 refresh_token 없으면 기존 값 보존');
  }

  // A2. 400 invalid_grant — 재시도 없이 즉시 _fatalAuth
  {
    const log = mkLog();
    const c = mkClient(log, { tokenPath: tmp });
    let n = 0;
    axios.post = async () => { n++; throw mkAxiosError({}, 400, { error: 'invalid_grant', error_description: 'expired' }); };
    let err;
    try { await c.refreshToken(); } catch (e) { err = e; }
    assert(n === 1, 'A2 400은 재시도하지 않음 (POST 1회)');
    assert(err && err._fatalAuth === true, 'A2 _fatalAuth 표시');
    assert(count(log.lines.error, 'refresh 토큰 무효') === 1, 'A2 무효 토큰 error 로그');
    assert(!log.lines.error.join('|').includes('r'.repeat(24)), 'A2 로그에 refresh 토큰 평문 미노출');
  }

  // A3. ★ 회전 서버 + 첫 시도 타임아웃 — 같은(이미 소진된) refresh 토큰으로 재시도
  //     서버는 attempt1을 성공 처리하고 토큰을 회전시켰으나 응답이 클라이언트 타임아웃.
  //     attempt2는 소진된 토큰을 보내므로 400 invalid_grant → _fatalAuth.
  {
    const log = mkLog();
    const c = mkClient(log, { tokenPath: tmp });
    const sentBodies = [];
    let serverRotated = false;
    axios.post = async (url, body) => {
      sentBodies.push(body.get('refresh_token'));
      if (!serverRotated) {           // attempt1: 서버는 처리·회전했지만 응답이 유실됨
        serverRotated = true;
        throw mkAxiosError({}, undefined);   // ECONNABORTED (timeout)
      }
      throw mkAxiosError({}, 400, { error: 'invalid_grant' }); // attempt2: 소진된 토큰
    };
    const t0 = Date.now();
    let err;
    try { await c.refreshToken(); } catch (e) { err = e; }
    const dt = Date.now() - t0;
    assert(sentBodies.length === 2, 'A3 타임아웃 후 재시도 발생 (POST 2회)');
    assert(sentBodies[0] === sentBodies[1], 'A3 ★ 재시도가 "같은" refresh 토큰을 재사용 (회전 무시)');
    assert(err && err._fatalAuth === true, 'A3 ★ 결과: _fatalAuth — 재인증 필요로 확정됨');
    assert(dt >= 1900, `A3 백오프 2s 실제 경과 (${dt}ms)`);
  }

  // A4. A3의 하류 파급 — 인터셉터가 _fatalAuth를 받으면 토큰 파일 삭제 + tokens=null
  {
    const log = mkLog();
    const tokenFile = path.join(tmp, 'smartthings_km81_token.json');
    await realFsp.writeFile(tokenFile, JSON.stringify({ access_token: 'a'.repeat(24), refresh_token: 'r'.repeat(24) }));
    const c = mkClient(log, { tokenPath: tmp });
    let cbCalled = 0;
    c.setReauthCallback(() => { cbCalled++; });
    const fatal = new Error('invalid_grant'); fatal._fatalAuth = true;
    await c._triggerReauth().catch(() => {});
    let exists = true;
    try { await realFsp.access(tokenFile); } catch { exists = false; }
    assert(exists === false, 'A4 ★ _fatalAuth 경로에서 토큰 파일이 실제로 삭제됨');
    assert(c.tokens === null, 'A4 메모리 토큰도 제거');
    assert(cbCalled === 1, 'A4 재인증 콜백 1회 호출');
    await c._triggerReauth();
    assert(cbCalled === 1, 'A4 래치 — 두 번째 _triggerReauth는 무시');
    // 새 인증 성공 시 래치 해제
    axios.post = async () => ({ data: { access_token: 'z'.repeat(24), refresh_token: 'q'.repeat(24) } });
    await c.getInitialTokens('code123');
    assert(c._reauthTriggered === false, 'A4 getInitialTokens 성공 시 래치 리셋');
  }

  // A5. ★ A3의 통합 경로 — 401 → refresh(회전 소진) → 토큰 파일 실제 삭제까지
  {
    const log = mkLog();
    const tokenFile = path.join(tmp, 'smartthings_km81_token.json');
    await realFsp.writeFile(tokenFile, JSON.stringify({ access_token: 'a'.repeat(24), refresh_token: 'r'.repeat(24) }));
    const c = mkClient(log, { tokenPath: tmp, adapter: async (cfg) => { throw mkAxiosError(cfg, 401); } });
    let reauthed = 0;
    c.setReauthCallback(() => { reauthed++; });
    let serverRotated = false;
    axios.post = async () => {
      if (!serverRotated) { serverRotated = true; throw mkAxiosError({}, undefined); } // 회전 성공했으나 응답 유실
      throw mkAxiosError({}, 400, { error: 'invalid_grant' });
    };
    try { await c.getStatus('DEV1'); } catch (_) {}
    await sleep(50);
    let exists = true;
    try { await realFsp.access(tokenFile); } catch { exists = false; }
    assert(exists === false, 'A5 ★★ 일시 타임아웃 1회 → 토큰 파일 삭제 (전 기기 무인 복구 불가)');
    assert(reauthed === 1, 'A5 재인증 흐름 트리거됨 (사용자 브라우저 개입 필요)');
    assert(count(log.lines.error, '재인증이 필요합니다') >= 1, 'A5 재인증 요구 error 로그');
  }

  axios.post = origPost;
  await realFsp.rm(tmp, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n[B] 401 → 단일비행 refresh + 무토큰 급속거부');
// ═══════════════════════════════════════════════════════════════════
{
  const origPost = axios.post;
  const log = mkLog();
  const tmp = path.join(os.tmpdir(), `stc-audit-b-${Date.now()}`);
  await realFsp.mkdir(tmp, { recursive: true });

  let unauthorizedUntilRefresh = true;
  const adapter = async (config) => {
    if (unauthorizedUntilRefresh) throw mkAxiosError(config, 401);
    return { data: { components: { main: { switch: { switch: { value: 'on' } } } } }, status: 200, config, headers: {} };
  };
  const c = mkClient(log, { adapter, tokenPath: tmp });

  let refreshCalls = 0;
  axios.post = async () => {
    refreshCalls++;
    await sleep(50);                       // 동시 401들이 겹치도록
    unauthorizedUntilRefresh = false;
    return { data: { access_token: 'N'.repeat(24), refresh_token: 'R'.repeat(24) } };
  };

  const results = await Promise.allSettled([
    c.getStatus('dev-a'), c.getStatus('dev-b'), c.getStatus('dev-c'),
  ]);
  assert(refreshCalls === 1, `B1 동시 401 3건 → refresh 단 1회 (실측 ${refreshCalls})`);
  assert(results.every(r => r.status === 'fulfilled'), 'B1 세 요청 모두 갱신 후 성공');
  assert(c.refreshPromise === null, 'B1 refreshPromise 정리됨');
  assert(c.statusPromises.size === 0, 'B1 statusPromises 누수 없음');

  // B2. 토큰 없음 → 요청 인터셉터 급속 거부(네트워크 미접촉)
  let adapterHits = 0;
  c.client.defaults.adapter = async (cfg) => { adapterHits++; return { data: {}, status: 200, config: cfg, headers: {} }; };
  c.tokens = null;
  c.cache.clear();
  let e2;
  try { await c.getStatus('dev-a'); } catch (e) { e2 = e; }
  assert(adapterHits === 0, 'B2 토큰 없으면 어댑터 미도달 (unauth 폭주 차단)');
  assert(!!e2, 'B2 호출자에게 실패 전파');

  axios.post = origPost;
  await realFsp.rm(tmp, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n[C] off 재시도 의도 가드 — 커스텀 config가 err.config까지 생존하는가');
// ═══════════════════════════════════════════════════════════════════
{
  const log = mkLog();
  const tmp = path.join(os.tmpdir(), `stc-audit-c-${Date.now()}`);
  await realFsp.mkdir(tmp, { recursive: true });
  const seen = [];
  const adapter = async (config) => { seen.push(config); throw mkAxiosError(config, 400); }; // 400=재시도 대상 아님
  const c = mkClient(log, { adapter, tokenPath: tmp });

  let caught;
  try { await c.setPower('DEV1', false); } catch (e) { caught = e; }
  const cfg = caught?.config;
  assert(seen.length === 1, 'C1 400은 axios-retry가 재시도하지 않음');
  assert(cfg && cfg._deviceId === 'DEV1', 'C1 ★ _deviceId가 err.config까지 생존 (axios 1.18 mergeConfig)');
  assert(cfg && typeof cfg._sentAt === 'number', 'C1 ★ _sentAt이 err.config까지 생존');
  assert(STC._isIdempotentOffCommand(cfg) === true, 'C2 실제 전송 config에서 단독 switch:off로 판정');
  assert(typeof cfg.data === 'string' && cfg.data.includes('"command":"off"'), 'C2 config.data는 직렬화 문자열');

  // C3. 비-off 명령은 멱등 판정 false + _lastNonOffCmdTs 기록
  try { await c.setMode('DEV1', 'cool'); } catch (_) {}
  const cfgMode = seen[1];
  assert(STC._isIdempotentOffCommand(cfgMode) === false, 'C3 setMode는 멱등-off 아님');
  assert(c._lastNonOffCmdTs.get('DEV1') > 0, 'C3 비-off 명령 시각 기록됨');
  assert(c._lastNonOffCmdTs.has('DEV1') && !('DEV2' in Object.fromEntries(c._lastNonOffCmdTs)), 'C3 기기별 분리');

  // C4. ★ 가드 비교식의 경계: lastNonOff > sentAt (strict). 동일 ms에 ON이 오면 취소되지 않는다
  const offCfg = { _deviceId: 'DEVX', _sentAt: 1000, data: JSON.stringify({ commands: [{ component: 'main', capability: 'switch', command: 'off' }] }) };
  const evalGuard = (lastNonOff) => lastNonOff > offCfg._sentAt;
  assert(evalGuard(1001) === true, 'C4 ON이 1ms 뒤 → off 재시도 취소됨(정상)');
  assert(evalGuard(1000) === false, 'C4 ★ ON이 "같은 ms"면 취소되지 않음 — off 재시도가 ON을 뒤집음');
  assert(evalGuard(999) === false, 'C4 ON이 off보다 먼저면 취소 안 함(정상)');

  await realFsp.rm(tmp, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n[D] axios-retry retryCondition — off만 재시도 (실백오프 ~7s)');
// ═══════════════════════════════════════════════════════════════════
{
  const log = mkLog();
  const tmp = path.join(os.tmpdir(), `stc-audit-d-${Date.now()}`);
  await realFsp.mkdir(tmp, { recursive: true });

  // D1. 비-off command POST + 500 → 재시도 금지 (1회만)
  {
    let n = 0;
    const c = mkClient(log, { tokenPath: tmp, adapter: async (cfg) => { n++; throw mkAxiosError(cfg, 500); } });
    try { await c.setMode('DEV1', 'cool'); } catch (_) {}
    assert(n === 1, `D1 setMode+500 → 재시도 없음 (POST ${n}회)`);
  }
  // D2. 단독 switch:off + 500 → 재시도 3회 허용 (총 4회)
  {
    let n = 0;
    const c = mkClient(log, { tokenPath: tmp, adapter: async (cfg) => { n++; throw mkAxiosError(cfg, 500); } });
    const t0 = Date.now();
    try { await c.setPower('DEV1', false); } catch (_) {}
    const dt = Date.now() - t0;
    assert(n === 4, `D2 ★ off+500 → 3회 재시도 (총 POST ${n}회)`);
    assert(dt >= 6000, `D2 백오프 1+2+4s 실경과 (${dt}ms)`);
  }
  // D3. off 발사 후 같은 기기로 ON이 나가면 재시도 취소 (v1.8.28 가드 실동작)
  {
    let n = 0;
    let cRef;
    const c = mkClient(log, { tokenPath: tmp, adapter: async (cfg) => {
      n++;
      if (n === 1) { cRef._lastNonOffCmdTs.set('DEV1', Date.now() + 5); } // off 이후 ON이 나간 상황
      throw mkAxiosError(cfg, 500);
    } });
    cRef = c;
    const warnsBefore = c.log.lines.warn.length;
    try { await c.setPower('DEV1', false); } catch (_) {}
    assert(n === 1, `D3 ★ 이후 비-off 명령 감지 → off 재시도 취소 (POST ${n}회)`);
    assert(count(log.lines.warn, 'switch:off 재시도 취소') >= 1, 'D3 취소 warn 로그');
  }
  await realFsp.rm(tmp, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n[E] v2.1.0/2.1.1 신규 코드 — _fmtCommand / 라벨 (기존 커버리지 0)');
// ═══════════════════════════════════════════════════════════════════
{
  const F = (c) => STC._fmtCommand(c);
  assert(F({ capability: 'switch', command: 'off' }) === '전원 → 꺼짐', 'E1 switch:off');
  assert(F({ capability: 'switch', command: 'on' }) === '전원 → 켜짐', 'E1 switch:on');
  assert(F({ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['cool'] }) === '모드 → 냉방', 'E1 mode cool');
  assert(F({ capability: 'airConditionerMode', arguments: ['coolClean'] }) === '모드 → 냉방청정', 'E1 mode coolClean');
  assert(F({ capability: 'thermostatCoolingSetpoint', arguments: [24] }) === '설정온도 → 24°C', 'E1 setpoint');
  assert(F({ capability: 'custom.airConditionerOptionalMode', arguments: ['windFree'] }) === '무풍 → 켜짐', 'E1 windFree on');
  assert(F({ capability: 'custom.airConditionerOptionalMode', arguments: ['off'] }) === '무풍 → 꺼짐', 'E1 windFree off');
  assert(F({ capability: 'custom.autoCleaningMode', arguments: ['on'] }) === '자동건조 → 켜짐', 'E1 autoClean on');
  assert(F({ capability: 'unknown.cap', command: 'doIt', arguments: ['x', 'y'] }) === 'unknown.cap.doIt(x, y)', 'E1 미지 명령 폴백');
  assert(STC._fmtCommands([{ capability: 'switch', command: 'off' }, { capability: 'thermostatCoolingSetpoint', arguments: [26] }]) === '전원 → 꺼짐, 설정온도 → 26°C', 'E2 복수 명령 결합');

  // E3. 알 수 없는 모드 인자 — MODE_KO 미등록 시 원문 노출 (정보 손실 없음)
  assert(F({ capability: 'airConditionerMode', arguments: ['sleep'] }) === '모드 → sleep', 'E3 미등록 모드는 원문');
  // E4. arguments 누락 시 undefined 문자열이 새는지
  assert(F({ capability: 'thermostatCoolingSetpoint' }) === '설정온도 → undefined°C', 'E4 ★ arguments 누락 시 "undefined°C" 출력(방어 없음)');

  // E5. 라벨 등록/폴백
  const log = mkLog();
  const o = Object.create(STC.prototype);
  o._deviceLabels = new Map();
  o.registerDeviceLabel('uuid-1', '승준 에어컨');
  assert(o._labelOf('uuid-1') === '승준 에어컨', 'E5 라벨 조회');
  assert(o._labelOf('uuid-none') === 'uuid-none', 'E5 미등록은 UUID 폴백');
  o.registerDeviceLabel('uuid-2', '');
  assert(o._labelOf('uuid-2') === 'uuid-2', 'E5 빈 라벨은 등록 거부');
  o.registerDeviceLabel(null, 'x');
  assert(o._deviceLabels.size === 1, 'E5 null deviceId 등록 거부');
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n[F] sendCommand 부수효과 — 캐시 무효화·라벨 로그·실패 경로');
// ═══════════════════════════════════════════════════════════════════
{
  const log = mkLog();
  const tmp = path.join(os.tmpdir(), `stc-audit-f-${Date.now()}`);
  await realFsp.mkdir(tmp, { recursive: true });
  const c = mkClient(log, { tokenPath: tmp, adapter: async (cfg) => ({ data: {}, status: 200, config: cfg, headers: {} }) });
  c.registerDeviceLabel('DEV1', '승준 에어컨');

  const invalidated = [];
  const origInv = c.invalidateStatusCache.bind(c);
  c.invalidateStatusCache = (id) => { invalidated.push([id, Date.now()]); origInv(id); };

  await c.setPower('DEV1', false);
  assert(count(log.lines.info, '[승준 에어컨] 전송: 전원 → 꺼짐') === 1, 'F1 ★ 성공 로그가 라벨+한국어 명령');
  assert(!log.lines.info.join('|').includes('DEV1'), 'F1 성공 로그에 UUID 미노출');
  assert(invalidated.length === 1, 'F2 전송 직전 캐시 무효화 1회');
  await sleep(1700);
  assert(invalidated.length === 2, 'F2 ★ 1500ms 뒤 2차 무효화 발화');

  // F3. 실패 경로 — 라벨+명령+상태코드. v2.1.3: 에러 body는 warn으로 기본 레벨에 보임(감사 제안 ② 반영).
  const log2 = mkLog();
  const c2 = mkClient(log2, { tokenPath: tmp, adapter: async (cfg) => { throw mkAxiosError(cfg, 422, { error: { code: 'ConstraintViolationError', message: 'device offline' } }); } });
  c2.registerDeviceLabel('DEV1', '승준 에어컨');
  let ferr;
  try { await c2.setTemperature('DEV1', 24); } catch (e) { ferr = e; }
  assert(!!ferr, 'F3 실패는 호출자에게 전파');
  assert(count(log2.lines.error, '[승준 에어컨] 전송 실패: 설정온도 → 24°C') === 1, 'F3 실패 로그 형식');
  assert(count(log2.lines.error, 'ConstraintViolationError') === 0, 'F3 ★ 에러 body가 error 레벨에 없음(요약 줄은 간결 유지)');
  assert(count(log2.lines.warn, 'ConstraintViolationError') === 1, 'F3 ★ 에러 body가 warn으로 기본 레벨에 보임 — v2.1.3 재승격');
  assert(count(log2.lines.warn, '[전송 실패 상세] 승준 에어컨') === 1, 'F3 warn 상세 줄에 기기 라벨 표기');

  await realFsp.rm(tmp, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n[G] 끄기 장면 억제 — 실 SmartThingsClient를 통과하는 경로');
// ═══════════════════════════════════════════════════════════════════
{
  const SmartAC = require('../lib/accessories/SmartAC.js');
  const { OFF_SCENE_SUPPRESS_MS } = require('../lib/shared.js');
  const log = mkLog();
  const tmp = path.join(os.tmpdir(), `stc-audit-g-${Date.now()}`);
  await realFsp.mkdir(tmp, { recursive: true });

  const posted = [];
  const c = mkClient(log, {
    tokenPath: tmp,
    adapter: async (cfg) => {
      if (/\/commands/.test(cfg.url)) posted.push(JSON.parse(cfg.data).commands[0]);
      return { data: /\/commands/.test(cfg.url) ? {} : { components: { main: {} } }, status: 200, config: cfg, headers: {} };
    },
  });

  // 최소 HAP 스텁
  const C = {
    Active: { displayName: 'Active' },
    CurrentHeaterCoolerState: { displayName: 'CHCS', COOLING: 2, INACTIVE: 0 },
    TargetHeaterCoolerState: { displayName: 'THCS', COOL: 2 },
    CurrentTemperature: { displayName: 'CT' },
    CoolingThresholdTemperature: { displayName: 'CTT' },
    SwingMode: { displayName: 'Swing' },
    LockPhysicalControls: { displayName: 'Lock' },
    Manufacturer: {}, Model: {}, SerialNumber: {}, FirmwareRevision: {}, On: {},
  };
  const handlers = new Map();
  const mkChar = (ch) => ({
    removeAllListeners() { return this; },
    setProps() { return this; },
    on(evt, fn) { handlers.set(`${ch.displayName}:${evt}`, fn); return this; },
  });
  const service = {
    displayName: '승준 에어컨',
    getCharacteristic: (ch) => mkChar(ch),
    setCharacteristic() { return this; },
    testCharacteristic: () => true,
    updateCharacteristic() { return this; },
  };
  const accessory = {
    displayName: '승준 에어컨',
    context: { device: { deviceId: 'DEV1', label: '승준 에어컨' } },
    getService: () => service,
    addService: () => service,
  };
  const ac = Object.create(SmartAC.prototype);
  ac.log = log;
  ac.api = { hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } };
  ac.smartthings = c;
  ac.platform = { config: {}, registerShutdown: () => {}, accessories: [] };
  ac.Service = { AccessoryInformation: {}, HeaterCooler: {}, Switch: {} };
  ac.Characteristic = C;
  ac.UUIDGen = { generate: (s) => s };
  ac._setupOptionalSwitches = () => {};
  ac._setupBackgroundPolling = () => {};
  ac.configure(accessory, { deviceLabel: '승준 에어컨' }, '2.1.1');

  const call = (name, evt, v) => new Promise((res, rej) => {
    const fn = handlers.get(`${name}:${evt}`);
    if (!fn) return rej(new Error(`no handler ${name}:${evt}`));
    if (evt === 'set') fn(v, (e) => (e ? rej(e) : res()));
    else fn((e, val) => (e ? rej(e) : res(val)));
  });

  ac._state.power = true;
  await call('Active', 'set', 0);                         // 끄기 의도
  assert(posted.length === 1 && posted[0].command === 'off', 'G1 OFF 전송됨');
  assert(count(log.lines.info, '전송: 전원 → 꺼짐') === 1, 'G1 ★ v2.1.1 라벨 로그가 실제 OFF 경로에서 발화');

  // 장면 형제 write가 0.3s 뒤 도착
  await sleep(300);
  await call('THCS', 'set', C.TargetHeaterCoolerState.COOL);
  await call('Swing', 'set', 1);
  await call('Lock', 'set', 1);
  await call('CTT', 'set', 26);
  await sleep(600);                                       // 온도 디바운스 400ms 통과
  assert(posted.length === 1, `G2 ★ 끄기 창 내 형제 write 4종 전부 억제 (전송 ${posted.length}건)`);

  // 창 만료 후에는 정상 통과
  await sleep(OFF_SCENE_SUPPRESS_MS);
  await call('THCS', 'set', C.TargetHeaterCoolerState.COOL);
  assert(posted.length === 2 && posted[1].capability === 'airConditionerMode', 'G3 창 만료 후 setMode 정상 통과');

  // ON 의도는 마커를 즉시 해제
  ac._state.power = false;
  posted.length = 0;
  await call('Active', 'set', 0);
  assert(ac._offIntentTs > 0, 'G4 OFF 후 마커 설정');
  await call('Active', 'set', 1);
  assert(ac._offIntentTs === 0, 'G4 ON 의도가 마커 즉시 해제');
  await call('THCS', 'set', C.TargetHeaterCoolerState.COOL);
  assert(posted.some(p => p.capability === 'airConditionerMode'), 'G4 켜기 장면의 setMode는 억제되지 않음');

  ac._stopped = true;
  await realFsp.rm(tmp, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n[H] OAuthServer — state CSRF / 소진 시점 / webhook SSRF');
// ═══════════════════════════════════════════════════════════════════
{
  const https = require('https');
  const origGet = https.get;
  const outbound = [];
  https.get = (url, opts, cb) => {
    outbound.push(String(url));
    const req = { on: () => req, destroy: () => {} };
    setImmediate(() => cb && cb({ statusCode: 200, resume: () => {} }));
    return req;
  };

  const OAuthServer = require('../lib/auth/OAuthServer.js');
  const PORT = 18999;
  const log = mkLog();
  let exchangeMode = 'fail';
  const stFake = {
    getInitialTokens: async () => { if (exchangeMode === 'fail') throw new Error('일시 네트워크 오류'); },
  };
  const srv = new OAuthServer({ log, smartthings: stFake, config: { clientId: 'cid', redirectUri: `http://127.0.0.1:${PORT}/cb` } });
  srv.port = PORT;
  let authedCbs = 0;
  srv.start(async () => { authedCbs++; });
  await sleep(300);

  const req = (method, p, body) => new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (resp) => {
      let d = ''; resp.on('data', ch => d += ch); resp.on('end', () => res({ status: resp.statusCode, body: d }));
    });
    r.on('error', () => res({ status: 0, body: '' }));
    if (body) r.write(body);
    r.end();
  });

  const state = srv._state;
  assert(typeof state === 'string' && state.length === 32, 'H1 1회성 state 발급 (128bit hex)');

  let r = await req('GET', '/cb?code=abc');
  assert(r.status === 400 && count(log.lines.warn, 'state 불일치') === 1, 'H2 state 없는 콜백 거부');
  r = await req('GET', '/cb?code=abc&state=deadbeef');
  assert(r.status === 400, 'H2 ★ 외부 주입 code(잘못된 state) 거부');
  r = await req('GET', '/cb?state=' + state);
  assert(r.status === 400 && r.body.includes('인증 코드를 찾을 수 없'), 'H2 code 누락 거부');

  // H3. 교환 실패 시 state를 태우지 않아야 재시도 가능
  r = await req('GET', `/cb?code=abc&state=${state}`);
  assert(r.status === 500, 'H3 토큰 교환 실패 → 500');
  assert(srv._state === state, 'H3 ★ 실패 시 state 미소진 (같은 인증 URL로 재시도 가능)');
  assert(authedCbs === 0, 'H3 실패 시 onAuthenticated 미호출');

  exchangeMode = 'ok';
  r = await req('GET', `/cb?code=abc&state=${state}`);
  assert(r.status === 200 && r.body.includes('인증 성공'), 'H4 재시도 성공 → 200');
  await sleep(100);
  assert(srv._state === null, 'H4 성공 후 state 소진');
  assert(authedCbs === 1, 'H4 onAuthenticated 1회');

  // H5. webhook SSRF — 서버가 stop()된 뒤라 새 인스턴스로 검증
  const log2 = mkLog();
  const srv2 = new OAuthServer({ log: log2, smartthings: stFake, config: { clientId: 'c', redirectUri: `http://127.0.0.1:${PORT + 1}/cb` } });
  srv2.port = PORT + 1;
  srv2.start(() => {});
  await sleep(300);
  const post = (body) => new Promise((res) => {
    const r2 = http.request({ host: '127.0.0.1', port: PORT + 1, path: '/', method: 'POST' }, (resp) => {
      let d = ''; resp.on('data', ch => d += ch); resp.on('end', () => res({ status: resp.statusCode, body: d }));
    });
    r2.on('error', () => res({ status: 0, body: '' }));
    r2.write(body); r2.end();
  });
  outbound.length = 0;
  let pr = await post(JSON.stringify({ lifecycle: 'CONFIRMATION', confirmationData: { confirmationUrl: 'http://192.168.1.11:9090/admin' } }));
  assert(pr.status === 400 && outbound.length === 0, 'H5 ★ 내부망 URL 거부 — 아웃바운드 0');
  pr = await post(JSON.stringify({ lifecycle: 'CONFIRMATION', confirmationData: { confirmationUrl: 'https://evil.com/x?api.smartthings.com' } }));
  assert(pr.status === 400 && outbound.length === 0, 'H5 쿼리 위장 URL 거부');
  pr = await post(JSON.stringify({ lifecycle: 'CONFIRMATION', confirmationData: { confirmationUrl: 'https://api.smartthings.com/confirm/xyz' } }));
  await sleep(50);
  assert(pr.status === 200 && outbound.length === 1, 'H5 정상 SmartThings URL은 통과');
  pr = await post('not-json');
  assert(pr.status === 400, 'H6 비-JSON POST는 400 (크래시 없음)');

  // H7. 인증 서버가 무인증 POST를 열어두는지 (표면 기록)
  assert(outbound.length === 1, 'H7 화이트리스트 밖 요청은 프록시되지 않음');

  srv2.stop();
  https.get = origGet;
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n[I] ★ OFF 재시도 백오프 중 사용자 ON 탭 — 멱등 스킵과 의도 가드의 층간 구멍');
// ═══════════════════════════════════════════════════════════════════
{
  const SmartAC = require('../lib/accessories/SmartAC.js');
  const log = mkLog();
  const tmp = path.join(os.tmpdir(), `stc-audit-i-${Date.now()}`);
  await realFsp.mkdir(tmp, { recursive: true });

  const posted = [];
  let offAttempts = 0;
  const c = mkClient(log, {
    tokenPath: tmp,
    adapter: async (cfg) => {
      if (!/\/commands/.test(cfg.url)) return { data: { components: { main: {} } }, status: 200, config: cfg, headers: {} };
      const cmd = JSON.parse(cfg.data).commands[0];
      posted.push(cmd);
      if (cmd.command === 'off') {
        offAttempts++;
        if (offAttempts === 1) throw mkAxiosError(cfg, 500);   // 1차 실패 → axios-retry 백오프 1s
        return { data: {}, status: 200, config: cfg, headers: {} }; // 2차 성공
      }
      return { data: {}, status: 200, config: cfg, headers: {} };
    },
  });

  const C = {
    Active: { displayName: 'Active' }, CurrentHeaterCoolerState: { displayName: 'CHCS', COOLING: 2, INACTIVE: 0 },
    TargetHeaterCoolerState: { displayName: 'THCS', COOL: 2 }, CurrentTemperature: { displayName: 'CT' },
    CoolingThresholdTemperature: { displayName: 'CTT' }, SwingMode: { displayName: 'Swing' },
    LockPhysicalControls: { displayName: 'Lock' }, Manufacturer: {}, Model: {}, SerialNumber: {}, FirmwareRevision: {}, On: {},
  };
  const handlers = new Map();
  const hapPushes = [];
  const service = {
    displayName: '승준 에어컨',
    getCharacteristic: (ch) => ({ removeAllListeners() { return this; }, setProps() { return this; },
      on(evt, fn) { handlers.set(`${ch.displayName}:${evt}`, fn); return this; } }),
    setCharacteristic() { return this; }, testCharacteristic: () => true,
    updateCharacteristic(ch, v) { hapPushes.push([ch.displayName, v]); return this; },
  };
  const accessory = { displayName: '승준 에어컨', context: { device: { deviceId: 'DEV1', label: '승준 에어컨' } },
    getService: () => service, addService: () => service };
  const ac = Object.create(SmartAC.prototype);
  ac.log = log;
  ac.api = { hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } };
  ac.smartthings = c;
  ac.platform = { config: {}, registerShutdown: () => {}, accessories: [] };
  ac.Service = { AccessoryInformation: {}, HeaterCooler: {}, Switch: {} };
  ac.Characteristic = C; ac.UUIDGen = { generate: (s) => s };
  ac._setupOptionalSwitches = () => {}; ac._setupBackgroundPolling = () => {};
  ac.configure(accessory, { deviceLabel: '승준 에어컨' }, '2.1.1');

  const call = (name, evt, v) => new Promise((res, rej) => {
    const fn = handlers.get(`${name}:${evt}`);
    if (evt === 'set') fn(v, (e) => (e ? rej(e) : res()));
    else fn((e, val) => (e ? rej(e) : res(val)));
  });

  ac._state.power = true;                       // 기기는 켜져 있음 (폴링이 채운 실측)
  const offPromise = call('Active', 'set', 0).catch(() => {});   // 심야 자동화 OFF — 1차 500

  await sleep(300);                             // axios-retry 백오프(1s) 진행 중
  assert(ac._state.power === true, 'I1 OFF 전송 미완료 — _state.power는 아직 true');

  let onTapErr = null;
  await call('Active', 'set', 1).catch(e => { onTapErr = e; });   // 사용자가 ON 탭
  assert(onTapErr === null, 'I2 ON 탭은 HomeKit에 성공으로 응답됨');
  assert(ac._offIntentTs === 0, 'I2 ON 의도가 끄기 마커를 해제 (액세서리 계층 재시도는 취소)');
  // ── v2.1.2 수정 후 기대 동작으로 갱신 ──
  // (원판 I3~I5는 v2.1.1의 결함 동작을 문서화한 단언이었다: ON 삼킴·가드 미발동·ON 역전.
  //  v2.1.2 = ①_powerInFlight 가드로 OFF in-flight 중 ON이 멱등 생략되지 않고 전송되며
  //  ②재시도 발사 시점 인터셉터가 백오프 중 도착한 반대 명령을 보고 off 재시도를 취소한다.)
  const onPosted = posted.filter(p => p.command === 'on').length;
  assert(onPosted === 1, `I3 ★★ ON 명령이 클라우드로 전송됨 — _powerInFlight 가드가 멱등 스킵을 우회 (on ${onPosted}건)`);
  assert(c._lastNonOffCmdTs.get('DEV1') !== undefined, 'I4 ★★ _lastNonOffCmdTs 갱신됨 — off 재시도 취소 가드가 무장됨');

  await offPromise;
  await sleep(200);
  assert(offAttempts === 1, `I5 ★★ 백오프 중이던 OFF 재시도가 발사 직전 취소됨 (off 시도 ${offAttempts}회 — 재발사 없음)`);
  assert(ac._state.power === true, 'I5 ★★ 최종 상태 = 켜짐 — 사용자의 ON 탭이 살아남음');
  const lastActivePush = [...hapPushes].reverse().find(p => p[0] === 'Active');
  assert(!lastActivePush || lastActivePush[1] === 1, 'I6 HomeKit에 꺼짐이 푸시되지 않음(마지막 Active 푸시 없음 또는 1)');

  ac._stopped = true;
  await realFsp.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(60)}\n총 ${checks}개 체크 / 실패 ${fails}개`);
if (fails) console.log('실패 목록:\n - ' + failedNames.join('\n - '));
process.exit(fails ? 1 : 0);

})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
