'use strict';

const pkg = require('./package.json');
const SmartThingsClient = require('./lib/api/SmartThingsClient');
const LocalApplianceClient = require('./lib/api/LocalApplianceClient');
const OAuthServer = require('./lib/auth/OAuthServer');
const LegacyAC = require('./lib/accessories/LegacyAC');
const SmartAC = require('./lib/accessories/SmartAC');
const Laundry = require('./lib/accessories/Laundry');
const LegacyLaundryClient = require('./lib/api/LegacyLaundryClient');
const MqttBridge = require('./lib/mqtt/MqttBridge');
const { attachSmartAc, attachLaundry, attachWaterPurifier } = require('./lib/mqtt/attach');
const path = require('path');

const PLATFORM_NAME = 'SmartThingsKM81';
const PLUGIN_NAME = 'homebridge-smartthings-km81';
const PACKAGE_ROOT = __dirname;

// 로컬 deviceId 확인 예산·재시도 (v2.7.2).
// 첫 설치는 pip이 최대 180초라 기동 예산(20초) 직후에는 브릿지가 아직 안 떠 있다.
// 그래서 "한 번 실패하면 끝"이 아니라 준비될 때까지 몇 번 더 물어본다.
const LOCAL_ID_BUDGET_MS = 15000;   // 전체 조회 상한 (기기별이 아니라 합계)
const LOCAL_ID_RETRY_MS = 30000;    // 재시도 간격
const LOCAL_ID_RETRY_MAX = 12;      // 최대 6분 — pip 180초 + 인증서 발급을 넉넉히 덮는다
// 정수기 신원 조회 재시도 — 홈킷 기기의 LOCAL_ID_RETRY_MAX 와 같은 값.
// ⚠️정수기는 홈킷 액세서리가 없어 **빠져도 사용자가 못 알아챈다** — 재시도가 더 중요하다.
const PURIFIER_PROBE_MAX = 12;

// 로그에 쓸 기기 이름. deviceLabel이 비어 있어도(deviceId만 적은 구성은 정상 지원된다)
// `[undefined]`가 찍히지 않도록 폴백을 둔다 — 오늘 `undefined GET 오류`와 같은 부류.
const labelOf = (d) => (d && (d.deviceLabel || d.name || d.deviceId || d.deviceType)) || '기기';

// ★"클라우드로 동작합니다"는 **폴백이 실제로 가능할 때만** 참이다.
//   클라우드 자격증명이 없거나 그 기기가 폴백을 껐으면 그 기기는 그냥 제어되지 않는다.
//   같은 부류를 v2.4.6·v2.6.6에서 두 번 고치고도 이 지점들에 전파하지 않아 세 번째로 고친다.
function cloudWord(d, smartthings) {
  const canCloud = !!smartthings && d?.local?.fallbackToCloud !== false;
  return canCloud
    ? '클라우드로 동작합니다'
    : '이 기기는 제어되지 않습니다(클라우드 폴백 없음)';
}
const normalizeKorean = s => (s || '').normalize('NFC').trim();

// v2.3.3 — 사용자에게는 '초'로 묻고, 내부 코드에는 기존 ms 키로 넘긴다.
// 왜 이렇게: 밀리초는 사람이 쓰기 불편하고(4000 vs 4) UI도 슬라이더로 그려졌다. 그렇다고
// 액세서리 코드의 키를 바꾸면 구형 에어컨 로직까지 건드리게 되므로(무변경 원칙),
// **설정을 읽는 진입점에서만** 초 → ms로 환산해 넘긴다. 기존 ms 설정도 그대로 동작한다.
const SEC_TO_MS_KEYS = {
  powerOnResendStepSec: 'powerOnResendStepMs',
  legacyOnGuardSec: 'legacyOnGuardMs',
  timeoutSec: 'timeout',
  cacheDurationSec: 'cacheDuration',
};

function normalizeTimingConfig(device) {
  if (!device || typeof device !== 'object') return device;
  // 시스템 에어컨은 설정 목록에서 따로 고를 수 있게 해 두었지만, 동작은 신형
  // 에어컨과 같다. 온도 리소스 경로가 보드마다 다른 것은 기기에 직접 물어 판별하므로
  // (lib/local/AcTempChannel.js) 종류로 코드를 가를 이유가 없다. 여기서 한 번 바꿔
  // 두면 아래 모든 분기가 예전 그대로 동작한다.
  if (device.deviceType === 'systemAc') {
    device.deviceType = 'smartAc';
    // 고른 종류는 남긴다 — 온도 단계(0.5℃)처럼 종류로만 정하는 것이 있다.
    device.__km81SystemAc = true;
  }
  for (const [secKey, msKey] of Object.entries(SEC_TO_MS_KEYS)) {
    const v = device[secKey];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    device[msKey] = Math.round(n * 1000);   // 초 설정이 있으면 그것이 우선
  }
  return device;
}

let Accessory, Service, Characteristic, UUIDGen;

module.exports = (homebridge) => {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SmartThingsKM81Platform);
};

class SmartThingsKM81Platform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.activeUUIDs = new Set();
    // 구형 8888 세탁물 클라이언트 — IP당 1개 공유(기기가 동시 연결을 못 견딘다).
    this._legacyLaundryClients = new Map();
    this.shutdownHandlers = [];
    this.legacyLogics = [];
    this.PLUGIN_NAME = PLUGIN_NAME;
    this.PLATFORM_NAME = PLATFORM_NAME;

    if (!api) return;

    this.devices = (Array.isArray(this.config.devices) ? this.config.devices : []).map(normalizeTimingConfig);

    const hasSmartThingsDevices = this.devices.some(d =>
      d && (d.deviceType === 'smartAc' || d.deviceType === 'washer' || d.deviceType === 'dryer')
    );

    // ★클라우드가 실제로 필요한 기기가 있을 때만 OAuth 항목을 요구한다(v2.6.13).
    //   deviceId를 직접 적고 transport=local이며 폴백까지 끈 기기는 클라우드를 한 번도 쓰지 않는다.
    //   그런 구성에서도 "필요합니다"를 error로 찍고 있었는데, 사실이 아니었다
    //   (실측: OAuth 항목을 전부 비워도 기기는 로컬 경로에 정상 등록된다).
    //   ★v2.7.0 — deviceId가 없어도 된다: 로컬 기기는 부팅 때 기기에게 직접 물어 알아낸다
    //   (`_resolveLocalDeviceIds`). 그래서 '기기 IP가 있고 폴백을 끈 로컬 기기'는 클라우드가
    //   필요 없다. 8888 토큰 기기(세탁기)는 그 조회 경로가 없으므로 deviceId가 있어야 한다.
    const needsCloud = this.devices.some((d) => {
      if (!d || !['smartAc', 'washer', 'dryer'].includes(d.deviceType)) return false;
      if (d.transport !== 'local' || d.local?.fallbackToCloud !== false) return true;
      if (!d.local?.host) return true;
      return d.local?.token ? !d.deviceId : false;
    });

    if (hasSmartThingsDevices) {
      const missing = [];
      if (!this.config.clientId) missing.push('clientId');
      if (!this.config.clientSecret) missing.push('clientSecret');
      if (!this.config.redirectUri) missing.push('redirectUri');
      if (missing.length > 0 && !needsCloud) {
        this.log.info('SmartThings 연결 없이 로컬 전용으로 동작합니다 (클라우드 호출 0회).');
      } else if (missing.length > 0) {
        this.log.error(`SmartThings 장치를 사용하려면 다음 필드가 필요합니다: ${missing.join(', ')}`);
        this.log.error('※ 모든 SmartThings 기기에 deviceId를 적고 전송 경로를 로컬로 두고 '
          + "'로컬 실패 시 클라우드 사용'을 끄면, 이 항목들 없이 동작합니다.");
      } else {
        try { new URL(this.config.redirectUri); }
        catch (e) {
          this.log.error(`'redirectUri'가 유효한 URL 형식이 아닙니다: ${this.config.redirectUri}`);
        }
        this.smartthings = new SmartThingsClient(this.log, this.api, this.config);
        this.oauthServer = new OAuthServer({ log: this.log, smartthings: this.smartthings, config: this.config });
        // refresh 토큰까지 만료된 상황에서 자동으로 OAuth 흐름을 다시 띄운다.
        this.smartthings.setReauthCallback(() => {
          this.log.warn('OAuth 재인증을 위한 인증 서버를 다시 시작합니다.');
          this.oauthServer.start(async () => {
            // 재인증 성공 후 SmartThings 장치 재바인딩
            const stDevices = this.devices.filter(d =>
              d?.deviceType === 'smartAc' || d?.deviceType === 'washer' || d?.deviceType === 'dryer'
            );
            await this._discoverAndBindSmartThings(stDevices);
          });
        });
      }
    }

    // MQTT 브리지 — HA가 기기에 직접 붙지 않고 이 브리지가 내보내는 상태만 보게 한다.
    // 꺼져 있으면(기본) 아무 것도 하지 않으며, 어떤 실패도 홈킷에 영향을 주지 않는다.
    this.mqtt = new MqttBridge(this.log, this.config.mqtt || {}, pkg.version);
    if (this.mqtt.enabled) this.registerShutdown(() => this.mqtt.stop());

    this.log.info(`${PLATFORM_NAME} 플랫폼 초기화 중... (v${pkg.version})`);

    // 디바이스 바인딩은 부팅당 1회만 보장 — OAuth 콜백 경로에서도 같은 액세서리에
    // listener/타이머가 중복 등록되지 않도록 한다.
    this._boundAccessoryIds = new Set();

    // ★미처리 거부가 되면 Node가 프로세스를 내린다 — 기기 하나의 설정 오류로 홈브릿지 전체가
    // 죽는 것을 막는다(적대 감사 D1/D5).
    this.api.once('didFinishLaunching', () => this._didFinishLaunching()
      .catch(e => this.log.error(`장치 초기화 중 오류: ${e.message}`)));
    this.api.once('shutdown', () => this._shutdown());
  }

  configureAccessory(accessory) {
    this.log.info(`캐시된 액세서리 불러오기: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  registerShutdown(fn) {
    if (typeof fn === 'function') this.shutdownHandlers.push(fn);
  }

  async _didFinishLaunching() {
    this.log.info('장치 검색 시작');

    // 기기 바인딩보다 먼저 붙여 둔다 — 연결이 늦어도 등록분은 연결 시 한꺼번에 올라간다.
    if (this.mqtt.enabled) this.mqtt.start();

    if (this.devices.length === 0) {
      this.log.warn('설정된 장치(devices)가 없습니다.');
      // 설정 비어 있을 때만 cleanup 수행 (의도된 빈 설정)
      this._cleanupStaleAccessories();
      return;
    }

    // ★모르는 기기 종류가 있으면 이번 부팅의 액세서리 정리를 통째로 건너뛴다(v2.8.0).
    //   아래 필터들이 미지의 종류를 조용히 걸러내므로, 그 기기는 "설정에 없는 것"이 되고
    //   캐시에 남아 있던 액세서리가 stale로 판정돼 **경고 한 줄 없이 영구 삭제**된다
    //   (사용자 자동화·방 배치 동반 소실). 오타나, 새 종류를 쓰던 설정을 구버전으로
    //   되돌린 경우에 실제로 일어난다. 종류를 모를 때는 지우지 않는 것이 안전하다.
    const KNOWN_TYPES = ['legacyAc', 'smartAc', 'washer', 'dryer', 'waterPurifier'];
    // 로그에는 **사용자가 고른 이름**을 보여 준다. 정규화된 내부명만 찍으면
    // "시스템 에어컨을 골랐는지"를 로그로 판별할 수 없어 진단이 막힌다(실사례).
    this._shownType = (d) => (d && d.__km81SystemAc ? 'systemAc' : d && d.deviceType);
    const unknownTypes = [...new Set(this.devices
      .filter(d => d && !KNOWN_TYPES.includes(d.deviceType))
      .map(d => String(d.deviceType)))];
    if (unknownTypes.length > 0) {
      this.log.warn(`설정에 모르는 장치 종류가 있습니다: ${unknownTypes.join(', ')} `
        + `— 이 항목은 건너뛰고, 액세서리 정리도 하지 않습니다(삭제 방지). `
        + `플러그인 버전과 설정이 맞는지 확인하세요.`);
    }
    this._unknownTypes = unknownTypes.length > 0;

    // 1) Legacy AC 장치 처리 (SmartThings 불필요)
    const legacyDevices = this.devices.filter(d => d?.deviceType === 'legacyAc');
    for (const dev of legacyDevices) {
      this._setupLegacyAc(dev);
    }

    // 1-b) 정수기 — ★홈킷 액세서리를 만들지 않는다. HA(MQTT)로만 흘린다(2026-08-04).
    //   ⚠️브릿지 기동 뒤에 붙여야 하므로 실제 시작은 아래 2-a 이후에 한다.

    // 2) SmartThings 장치 처리
    const stDevices = this.devices.filter(d =>
      d?.deviceType === 'smartAc' || d?.deviceType === 'washer' || d?.deviceType === 'dryer'
    );

    // 2-a) 로컬 전송(DTLS-CoAP)을 쓰는 기기가 있으면 브릿지를 먼저 띄운다.
    // 실패해도 치명적이지 않다 — 각 기기는 클라우드로 폴백한다.
    // ★8888 토큰 기기는 파이썬 DTLS 브릿지가 필요 없다 — 이걸 빼지 않으면 세탁기 하나 때문에
    // pip 설치(최대 180초)와 기동 대기가 헛돈다(적대 감사 D4).
    // ★정수기도 같은 DTLS 스택을 쓴다 — 브릿지 기동 대상에 포함해야 한다(2026-08-04).
    //   ⚠️단 stDevices 에는 넣지 않는다: 그러면 홈킷 액세서리가 만들어진다.
    const purifiers = this.devices.filter(d => d?.deviceType === 'waterPurifier' && d?.local?.host);
    const localDevices = [
      ...stDevices.filter(d => d?.transport === 'local' && !d?.local?.token),
      ...purifiers,
    ];
    if (localDevices.length > 0) {
      this.localClient = new LocalApplianceClient(this.log, {
        cloudClient: this.smartthings,
        pythonBin: this.config.localPythonBin || undefined,
        stateDir: this.config.localStateDir || undefined,
        // 기본 상태 폴더를 홈브릿지 저장 경로 아래로 잡기 위해 api를 넘긴다(v2.6.7).
        // 도커가 아닌 설치에서 `/homebridge`에 쓰려다 실패하던 것을 없앤다.
        api: this.api,
      });
      this.registerShutdown(() => this.localClient.stop());
      // v2.2.1 — 브릿지 기동이 기기 바인딩을 막지 않게 상한을 둔다(감사 HIGH-3).
      // 여기서 오래 붙들리면 캐시 복원된 액세서리에 HomeKit 리스너가 안 붙어,
      // 홈킷 조작이 "수락된 것처럼 보이지만 아무 일도 안 일어나는" 무성 유실이 된다.
      const LOCAL_START_BUDGET_MS = 20000;
      try {
        await Promise.race([
          this.localClient.start(),
          new Promise((_, rej) => setTimeout(
            () => rej(new Error(`기동 대기 ${LOCAL_START_BUDGET_MS / 1000}초 초과`)), LOCAL_START_BUDGET_MS)),
        ]);
      } catch (e) {
        // ★폴백이 켜져 있는지에 따라 **결과가 정반대**다 — 문구도 갈라야 한다.
        //   v2.4.6에서 `LocalApplianceClient`의 같은 결함을 고쳤는데 이 지점에 전파하지 않아,
        //   실제로 다른 사용자 로그에서 "클라우드로 동작합니다"가 거짓으로 찍혔다
        //   (폴백을 전부 끈 구성이라 기댈 곳이 없었고, 홈킷은 '응답 없음'이 됐다).
        // ★첫 설치 중이면 이건 '실패'가 아니라 '아직 진행 중'이다(v2.6.7).
        //   pip 설치는 최대 180초인데 기동 예산은 20초라, **성공하는 첫 설치도** 반드시 이 분기를
        //   지난다. 예전엔 모든 신규 사용자가 첫 부팅에서 가짜 실패를 보고 재설치·문의를 했다.
        //
        // ⛔★여기서 절대 return 하지 말 것(v2.6.10 — v2.6.7이 넣은 return을 되돌림).
        //   그 return은 _didFinishLaunching을 통째로 빠져나가 **아래 전부**를 건너뛴다:
        //   토큰 로드(init) → 기기 바인딩 → stale 정리 → 클라우드 keepalive.
        //   즉 **첫 설치의 첫 부팅에서 SmartThings 기기가 하나도 안 붙었다.** 위 주석이
        //   기동 예산을 둔 이유로 경고하던 바로 그 '무성 유실'을 스스로 만든 셈이다.
        //   계속 진행하면 기기는 localClient에 등록되고, 준비 전에는 요청마다 클라우드로
        //   폴백하다가 설치가 끝나면 저절로 로컬로 올라선다 — 재시작이 필요 없다.
        //   (Promise.race의 패자는 취소되지 않으므로 start()는 뒤에서 계속 진행된다.)
        const installing = this.localClient.isInstalling && this.localClient.isInstalling();
        const anyFallback = localDevices.some(d => d?.local?.fallbackToCloud !== false);
        if (installing) {
          // ★폴백이 없으면 "그동안 클라우드로 동작"은 거짓이다(v2.7.3).
          //   같은 부류를 v2.4.6·v2.6.6에서 두 번 고치고도 이 분기에만 전파하지 않았다.
          const canCloud = !!this.smartthings && anyFallback;
          this.log.info('로컬 경로 최초 설치가 진행 중입니다 — 몇 분 걸릴 수 있습니다. '
            + (canCloud
              ? '그동안은 클라우드로 동작하고, 설치가 끝나면 저절로 로컬로 전환됩니다.'
              // ⚠️여기서 `제어되지 않습니다`를 쓰면 안 된다(적대 리뷰 C-M1) — NAS 감시기의
              //   **실패 어휘**인데 이 줄엔 `[기기라벨]` 접두가 없고, 심지어 **정상 경로**다
              //   (최초 설치 진행 중). 짝이 되는 복구 문구도 없어 🔴가 안 풀린다.
              //   기기별 진짜 경보는 10회 실패 시점에 라벨을 달고 따로 나간다.
              : '설치가 끝나면 저절로 연결되며, 그때까지 이 기기들은 조작할 수 없습니다.'));
        } else if (anyFallback) {
          this.log.error(`로컬 브릿지 기동 지연/실패 — 준비될 때까지 클라우드로 동작합니다: ${e.message}`);
        } else {
          // ⚠️같은 이유로 어휘를 피한다(C-M1) — 라벨이 없어 감시기가 기기를 특정할 수 없고,
          //   이 줄에는 짝이 되는 복구 문구가 없다(`로컬 브릿지 준비됨`엔 복구 어휘가 없다).
          this.log.error('로컬 브릿지 기동 실패 + 클라우드 폴백도 꺼져 있음 — '
            + `이 기기들은 지금 조작할 수 없습니다(홈 앱에 '응답 없음'). `
            + `설정의 '로컬 실패 시 클라우드 사용'을 켜면 클라우드로 동작합니다: ${e.message}`);
        }
      }
    }

    // 1-b 실행) 정수기 — 브릿지 기동 뒤에 붙인다(홈킷 액세서리 없음, HA 전용).
    //   ⚠️`await` 하지 않는다: 기기가 꺼져 있으면 신원 조회가 수 초 걸리는데, 그동안
    //     아래의 토큰 로드·기기 바인딩이 밀리면 안 된다(무성 유실을 만든 그 부류).
    for (const d of purifiers) {
      this._setupWaterPurifier(d).catch((e) => {
        this.log.warn(`[${d.deviceLabel || '정수기'}] 준비 실패(무해): ${e && e.message}`);
      });
    }

    // ★init()은 '디스크의 토큰을 읽는' 단계이지 API 호출이 아니다. deviceId로 전부 연결됐다고
    // 이걸 건너뛰면 토큰이 메모리에 없어 클라우드 경로가 통째로 죽는다 —
    // 클라우드 전송 기기(세탁기)의 폴링은 물론 **로컬 실패 시 폴백까지** 못 쓴다.
    // (v2.3.0에서 실제로 그렇게 만들었다가 세탁기 '폴링 실패 누적'으로 발견 → v2.3.1에서 수정)
    // 바인딩 직후 폴링이 시작되므로 토큰 로드는 반드시 그 '전에' 끝나야 한다.
    let hasToken = false;
    if (stDevices.length > 0 && this.smartthings) {
      hasToken = await this.smartthings.init();
    }

    // ★v2.7.0 — deviceId가 없는 로컬 기기는 **기기에게 직접 물어본다**.
    //   기기가 oic/d로 자기 di(=SmartThings deviceId)를 알려주므로 클라우드가 필요 없다.
    //   실패하면 그 기기만 건너뛰고, stale 정리를 억제해 캐시 액세서리를 지키다.
    const localIdOk = await this._resolveLocalDeviceIds(stDevices);

    // v2.3.0 — config에 deviceId가 적힌 기기는 클라우드 조회 없이 바로 붙인다.
    // 모든 기기에 적어두면 부팅에도 SmartThings API를 한 번도 쓰지 않는다.
    const needDiscovery = this._bindByConfiguredIds(stDevices);

    // ⛔★정리 억제 신호는 **둘 다** 살아 있어야 한다(v2.7.1).
    //   v2.7.0은 아래 클라우드 조회 결과를 `stDiscoverySucceeded`에 **그대로 대입**해서
    //   `localIdOk`(로컬 deviceId 조회 실패)를 삼켰다. 그러면 로컬 기기가 응답하지 않은
    //   부팅에서 그 액세서리가 stale로 판정돼 **영구 삭제**된다 —
    //   사용자의 자동화·방 배치·종료 알림 센서가 함께 사라진다.
    //   두 신호는 원인이 다르므로 절대 한쪽이 다른 쪽을 덮어쓰면 안 된다.
    let cloudOk = needDiscovery.length === 0;
    this._cloudOk = cloudOk;   // 재시도 타이머가 같은 조건식을 쓰게 한다
    if (stDevices.length > 0 && this.smartthings) {
      if (!hasToken) {
        this.oauthServer.start(async () => {
          const ok = await this._discoverAndBindSmartThings(needDiscovery);
          this._cloudOk = ok;
          if (ok && localIdOk) this._cleanupStaleAccessories();
        });
      } else if (needDiscovery.length > 0) {
        cloudOk = await this._discoverAndBindSmartThings(needDiscovery);
        this._cloudOk = cloudOk;
      }
    }

    // 검색이 실패/빈 결과였다면 stale cleanup을 건너뛴다.
    // — 일시 장애 시 사용자의 알림 센서·자동화·방 배치가 영구 삭제되는 것을 막기 위함.
    if (cloudOk && localIdOk) {
      this._cleanupStaleAccessories();
    } else if (!localIdOk) {
      this.log.warn('일부 로컬 기기의 deviceId를 확인하지 못해, 오래된 액세서리 정리를 건너뜁니다. (자동화 보호)');
    } else {
      this.log.warn('SmartThings 장치 검색이 실패하거나 비어 있어, 오래된 액세서리 정리를 건너뜁니다. (자동화 보호)');
    }

    this._startCloudKeepalive();
  }

  /**
   * deviceId가 없는 로컬 기기의 deviceId를 기기에게서 직접 얻는다 (v2.7.0).
   *
   * 배경: 지금까지 deviceId를 아는 유일한 길이 SmartThings 클라우드 조회였고,
   * 그 때문에 로컬로만 쓰려는 사람도 OAuth(+https 리버스 프록시)를 반드시 거쳐야 했다.
   * 그런데 기기는 `oic/d`로 자기 `di`를 알려준다(2026-07-31 실측) — 그걸 쓴다.
   *
   * ⚠️액세서리 UUID가 deviceId에서 나오므로(`UUIDGen.generate(device.deviceId)`),
   *   조회에 실패한 부팅에서 그 기기를 못 붙이면 stale 정리가 캐시 액세서리를 **삭제**한다
   *   (사용자의 자동화·방 배치·알림 센서가 함께 사라진다). 그래서
   *   ①한 번 성공하면 디스크에 캐시하고 ②실패하면 false를 돌려 정리를 억제한다.
   *
   * @returns {boolean} 모든 대상 기기의 deviceId를 정했으면 true
   */
  async _resolveLocalDeviceIds(stDevices) {
    const need = stDevices.filter(d => d && !d.deviceId
      && d.transport === 'local' && d.local?.host && !d.local?.token);
    if (need.length === 0 || !this.localClient) return true;

    // ★기기마다 20초씩 직렬로 기다리면 안 된다(v2.7.2).
    //   바로 위에서 브릿지 기동에 20초 예산을 둔 이유가 "여기서 오래 붙들리면 무성 유실"인데,
    //   이 단계가 무제한이면 그 보호가 무의미해진다. 실측: 무응답 2대면 +40초, 그동안
    //   **조회가 필요 없는 클라우드 기기까지** 바인딩이 밀렸다.
    //   병렬로 돌리고 전체에 예산을 씌운다.
    const results = await Promise.race([
      Promise.allSettled(need.map((d) => this._probeOne(d))),
      new Promise((resolve) => setTimeout(() => resolve(null), LOCAL_ID_BUDGET_MS)),
    ]);
    if (results === null) {
      this.log.warn(`로컬 deviceId 확인이 ${LOCAL_ID_BUDGET_MS / 1000}초를 넘겨 이번 부팅에서는 넘어갑니다 `
        + '— 기기가 켜져 있고 IP가 맞는지 확인하세요. 다음 재시도는 브릿지가 준비되면 자동으로 합니다.');
    }

    // ★서로 다른 항목이 **같은 deviceId**로 수렴하면 액세서리 하나가 조용히 사라진다(v2.7.4).
    //   두 항목에 같은 IP를 적었거나(오타), DHCP 재배정으로 A의 host가 실제로는 B를 가리키게 된
    //   경우다. 신원 대조(`_doVerify`)는 config deviceId와 기기 di를 비교하는데, 프로브가 채운
    //   deviceId는 정의상 그 기기의 di라 **항상 통과**한다 → 아무도 못 잡았다.
    //   UUID가 같으면 뒤 항목이 앞 것을 덮고, 남은 액세서리는 stale로 판정돼 삭제된다.
    const seen = new Map();
    let duplicated = false;
    for (const d of stDevices) {
      if (!d.deviceId) continue;
      const prev = seen.get(d.deviceId);
      if (prev) {
        duplicated = true;
        this.log.error(`[${labelOf(d)}]와 [${labelOf(prev)}]가 같은 기기를 가리킵니다`
          + ` (deviceId 동일). 기기 IP가 서로 다른지 확인하세요 — 그대로 두면 한 대만 남습니다.`);
      } else seen.set(d.deviceId, d);
    }

    const unresolved = need.filter((d) => !d.deviceId);
    if (unresolved.length === 0) return !duplicated;

    // ★브릿지가 아직 안 떴을 뿐이면 **다시 시도한다**(v2.7.2).
    //   pip 첫 설치는 최대 180초인데 이 함수는 20초 예산 직후 한 번만 불린다 —
    //   즉 **성공하는 첫 설치도** 반드시 미준비 상태로 여기를 지난다. v2.7.1까지는
    //   재시도 경로가 없어 IP만 적은 기기가 첫 부팅에 한 대도 안 붙었고, 로그는
    //   "저절로 전환됩니다"라고 말해 유일한 복구 수단(재시작)까지 막았다.
    this._scheduleLocalIdRetry(unresolved);
    return false;
  }

  /** 기기 한 대의 deviceId를 캐시 또는 기기 질의로 정한다. 이름도 함께 받아 라벨을 채운다. */
  async _probeOne(d) {
    const host = d.local.host;
    // ★라벨이 없으면 기기 종류(`smartAc`)보다 **IP**가 쓸모 있다(v2.7.4).
    //   이 시점엔 아직 이름을 모르는 게 정상이고, 사용자가 찾아갈 단서는 IP뿐이다.
    const label = d.deviceLabel || host;
    const cached = this.localClient.readDiscovered(host);
    if (cached?.deviceId) {
      d.deviceId = cached.deviceId;
      // ★이름도 캐시에서 되살린다 — 라벨을 비우면 홈킷 이름과 전 로그가 36자 UUID가 된다.
      if (!d.deviceLabel && cached.name) d.deviceLabel = cached.name;
      d.__km81LocalId = true;
      this.log.debug?.(`[${label}] deviceId를 캐시에서 읽음 (${host})`);
      return;
    }
    try {
      const found = await this.localClient.probeIdentity(host, d.local.port, d.local.localPort);
      d.deviceId = found.deviceId;
      // ★기기가 알려준 이름을 **쓴다**(v2.7.2). v2.7.0은 로그에만 쓰고 버려서,
      //   문서가 권장하는 '이름 비우기' 구성에서 홈 앱 이름이 UUID가 됐다.
      const adopted = !d.deviceLabel && !!found.name;
      if (adopted) d.deviceLabel = found.name;
      d.__km81LocalId = true;   // 출처 표시 — 로그가 "config의 deviceId"라고 말하지 않게
      this.localClient.writeDiscovered(host, found);
      // ★이름을 라벨로 채운 경우 접두와 꼬리가 같은 문자열이 되어 중복으로 읽혔다(v2.7.4).
      this.log.info(adopted
        ? `[${found.name}] deviceId를 기기에서 확인했습니다 (${host})`
        : `[${label}] deviceId를 기기에서 확인했습니다 — ${found.name || host}`);
      d.__km81ProbeFailed = 0;
    } catch (e) {
      // 원인이 브릿지면 기기·IP를 지목하지 않는다 — 엉뚱한 곳을 보게 만든다.
      const bridgeNotReady = /브릿지|미준비/.test(e.message || '');
      // ★재시도가 최대 12회라 그대로 두면 같은 줄이 13번 나온다(v2.7.4).
      //   첫 회만 사용자에게 알리고 이후는 debug로 — 최종 실패는 재시도 쪽이 error로 맡는다.
      d.__km81ProbeFailed = (d.__km81ProbeFailed || 0) + 1;
      const line = `[${label}] ${host}의 deviceId를 아직 확인하지 못했습니다 — `
        + (bridgeNotReady
          ? `로컬 브릿지가 준비되면 자동으로 다시 시도합니다: ${e.message}`
          : `기기 전원과 IP를 확인하세요: ${e.message}`);
      if (d.__km81ProbeFailed === 1) this.log.warn(line);
      else this.log.debug?.(`${line} (${d.__km81ProbeFailed}회째)`);
      throw e;
    }
  }

  /**
   * 브릿지가 준비되면 남은 기기의 deviceId를 다시 확인하고 바인딩한다.
   * 첫 설치(pip 수 분)에서 이 경로가 없으면 액세서리가 한 대도 안 만들어진다.
   */
  _scheduleLocalIdRetry(pending, attempt = 1) {
    if (this._stopped || attempt > LOCAL_ID_RETRY_MAX) {
      if (attempt > LOCAL_ID_RETRY_MAX) {
        // ★★2026-08-03 — 포기하기 전에 **캐시 액세서리의 deviceId를 3차 소스로 쓴다**
        //   (적대 리뷰 A-M2). 지금까지는 `discovered.json`이 유실된 채 기기가 6.5분 이상
        //   무응답이면(플러그 뽑힘·차단기·계절 보관) 그 기기가 **재시작 전까지 영영**
        //   안 붙었다 — 기기가 나중에 살아나도 아무도 다시 묻지 않는다.
        //   클라우드 검색 실패에는 정확히 이 용도의 `_bindFromCacheOffline`이 있는데,
        //   로컬 프로브 실패에는 대응물이 없었다.
        //   ⚠️신원 대조가 첫 요청에서 어차피 잡으므로, 잘못된 deviceId로 붙어도 안전하다.
        const rescued = [];
        for (const d of pending) {
          if (d.deviceId || d.__km81RetryBound) continue;
          const target = normalizeKorean(d.deviceLabel || '');
          const host = String(d.local?.host || '').trim();
          const cached = this.accessories.find((a) => {
            const cd = a.context?.configDevice;
            if (!a.context?.device?.deviceId) return false;
            if (host && String(cd?.local?.host || '').trim() === host) return true;
            return !!target && normalizeKorean(cd?.deviceLabel || '') === target;
          });
          if (!cached) continue;
          d.deviceId = cached.context.device.deviceId;
          d.__km81LocalId = true;
          d.__km81RetryBound = true;
          if (this.smartthings) this.smartthings.registerDeviceLabel(d.deviceId, labelOf(d));
          this._bindSmartThingsDevice({ deviceId: d.deviceId, label: labelOf(d) }, d);
          rescued.push(labelOf(d));
        }
        if (rescued.length > 0) {
          this.log.warn(`기기에 물어보지 못해 지난 부팅 정보로 연결합니다: ${rescued.join(', ')} `
            + '— 기기가 켜지면 자동으로 정상 동작합니다.');
        }
        const stillLost = pending.filter((d) => !d.deviceId);
        if (stillLost.length > 0) {
          this.log.error(`로컬 deviceId 확인을 ${LOCAL_ID_RETRY_MAX}회 시도했지만 실패했습니다 — `
            + '기기 전원·IP·파이썬 의존성 설치 로그를 확인한 뒤 홈브릿지를 재시작하세요.');
        }
      }
      return;
    }
    const timer = setTimeout(async () => {
      // ⛔★`still`이 비었다고 그냥 돌아가면 안 된다(v2.7.3).
      //   `Promise.race`의 패자는 취소되지 않으므로, 15초 예산을 **넘겨 늦게 성공한** 프로브가
      //   그 사이 `d.deviceId`를 채운다. v2.7.2는 그걸 "할 일 없음"으로 보고 return 해서,
      //   그 기기가 **재시작 전까지 영영 바인딩되지 않았다**(로그는 성공 문구만 남고 error 0줄).
      //   그래서 조회는 남은 것만 하되, **바인딩은 아직 안 붙은 것 전부**를 대상으로 한다.
      const still = pending.filter((d) => !d.deviceId);
      if (still.length > 0) {
        await Promise.allSettled(still.map(async (d) => {
          try { await this._probeOne(d); } catch (_) { /* 다음 회차 */ }
        }));
      }
      // ★★2026-08-03 — 부팅 경로의 **중복 deviceId 검사가 여기 없었다**(적대 리뷰 A-M3).
      //   같은 IP를 두 항목에 적었을 때, 부팅 때 기기가 켜져 있으면 error로 잡히지만
      //   꺼져 있다가 재시도 중 켜지면 둘 다 같은 di를 배워 **같은 UUID에 두 번 바인딩**된다
      //   (뒤가 앞을 덮고, 경고는 0줄). v2.7.3의 "부팅 경로와 같은 조건식" 원칙이
      //   이 검사에는 전파되지 않았다 — 같은 종류의 누락이 이걸로 세 번째다.
      {
        const seenIds = new Map();
        for (const d of pending) {
          if (!d.deviceId) continue;
          const prev = seenIds.get(d.deviceId);
          if (prev) {
            this.log.error(`[${labelOf(d)}]와 [${labelOf(prev)}]가 같은 기기를 가리킵니다`
              + ` (deviceId 동일). 기기 IP가 서로 다른지 확인하세요 — 그대로 두면 한 대만 남습니다.`);
          } else seenIds.set(d.deviceId, d);
        }
      }

      for (const d of pending) {
        if (!d.deviceId || d.__km81RetryBound) continue;
        d.__km81RetryBound = true;
        if (this.smartthings) this.smartthings.registerDeviceLabel(d.deviceId, labelOf(d));
        this.log.info(`[${labelOf(d)}] 준비가 끝나 지금 연결합니다.`);
        this._bindSmartThingsDevice({ deviceId: d.deviceId, label: labelOf(d) }, d);
      }

      const left = pending.filter((x) => !x.deviceId);
      if (left.length === 0) {
        // ⛔★부팅 경로와 **같은 조건식**이어야 한다(v2.7.3).
        //   v2.7.2는 여기서 `cloudOk`를 보지 않아, 부팅에서 올바르게 억제했던 정리를
        //   30초 뒤에 대신 실행했다 — v2.7.1이 릴리스 하나를 써서 막은 그 경로가
        //   다른 문으로 다시 열린 것이다(액세서리 영구 삭제).
        if (this._cloudOk) this._cleanupStaleAccessories();
        else {
          this.log.warn('SmartThings 장치 검색이 아직 성공하지 않아 오래된 액세서리 정리를 '
            + '계속 건너뜁니다. (자동화 보호)');
        }
        return;
      }
      this._scheduleLocalIdRetry(left, attempt + 1);
    }, LOCAL_ID_RETRY_MS);
    if (timer.unref) timer.unref();
    this.registerShutdown(() => clearTimeout(timer));
  }

  // v2.3.0 — config에 deviceId가 있으면 클라우드 조회를 건너뛰고 바로 바인딩한다.
  // 반환값 = 아직 클라우드 조회가 필요한 기기 목록.
  // 왜: 부팅 시 deviceLabel→deviceId 변환이 유일한 클라우드 의존이었다. 이걸 없애면
  // transport=local 기기는 SmartThings API를 한 번도 쓰지 않는다(2026-10 유료화 대비).
  _bindByConfiguredIds(stDevices) {
    const remaining = [];
    for (const configDevice of stDevices) {
      const id = (configDevice.deviceId || '').trim();
      if (!id) { remaining.push(configDevice); continue; }
      const label = configDevice.deviceLabel || id;
      // ★출처를 구분해 말한다(v2.7.4). 기기에게 물어 얻은 deviceId인데 "config의 deviceId"라고
      //   하면, 바로 앞줄의 `deviceId를 기기에서 확인했습니다`와 모순돼 읽는 사람이 헷갈린다.
      this.log.info(`'${label}' (${this._shownType(configDevice)}) — `
        + (configDevice.__km81LocalId
          ? '기기에서 확인한 deviceId로 연결 (클라우드 조회 없음)'
          : 'config의 deviceId로 바로 연결 (클라우드 조회 생략)'));
      if (this.smartthings) this.smartthings.registerDeviceLabel(id, label);
      this._bindSmartThingsDevice({ deviceId: id, label }, configDevice);
    }
    if (remaining.length === 0 && stDevices.length > 0) {
      this.log.info('모든 SmartThings 기기가 config의 deviceId로 연결됨 — 부팅 시 클라우드 조회 없음');
    }
    return remaining;
  }

  // 성공 시 true, 실패/빈 결과 시 false 반환. 호출자가 cleanup 여부를 결정한다.
  async _discoverAndBindSmartThings(stDevices) {
    try {
      const remoteDevices = await this.smartthings.getDevices();
      if (!remoteDevices || remoteDevices.length === 0) {
        this.log.warn('SmartThings에서 어떤 장치도 찾지 못했습니다. 권한이나 연결을 확인해주세요.');
        this._scheduleRediscoveryIfNeeded(this._bindFromCacheOffline(stDevices));
        return false;
      }
      this.log.info(`SmartThings 장치 ${remoteDevices.length}개 발견`);

      for (const configDevice of stDevices) {
        const targetLabel = normalizeKorean(configDevice.deviceLabel);
        if (!targetLabel) {
          this.log.warn('deviceLabel이 비어있는 SmartThings 장치 설정을 건너뜁니다.');
          continue;
        }
        const matches = remoteDevices.filter(d => normalizeKorean(d.label) === targetLabel);
        if (matches.length === 0) {
          this.log.warn(`'${configDevice.deviceLabel}'에 해당하는 장치를 SmartThings에서 찾지 못했습니다.`);
          continue;
        }
        if (matches.length > 1) {
          this.log.warn(`'${configDevice.deviceLabel}' 이름과 일치하는 장치가 ${matches.length}개 발견되었습니다. SmartThings 앱에서 장치 이름을 고유하게 변경해주세요. 첫 번째 장치를 사용합니다.`);
        }
        const found = matches[0];
        this.smartthings.registerDeviceLabel(found.deviceId, configDevice.deviceLabel); // 로그에 UUID 대신 이름 (v2.1.0)
        this.log.info(`'${configDevice.deviceLabel}' (${this._shownType(configDevice)}) HomeKit 추가/갱신`);
        this.log.info(`  ↳ deviceId=${found.deviceId} — config에 적어두면 다음 부팅부터 클라우드 조회를 건너뜁니다`);
        this._bindSmartThingsDevice(found, configDevice);
      }
      return true;
    } catch (e) {
      this.log.error('SmartThings 장치 검색 중 오류:', e.message);
      this._scheduleRediscoveryIfNeeded(this._bindFromCacheOffline(stDevices));
      return false;
    }
  }

  // v2.2.3 — ★클라우드 검색이 실패해도 로컬 기기는 살린다(감사 HIGH-A).
  // 정전 복구나 인터넷 장애 중에 홈브릿지가 재시작되면, LAN으로 멀쩡히 통신 가능한
  // 승준 에어컨·건조기까지 바인딩이 안 돼 홈킷 조작이 조용히 유실됐다(무성 유실 = 최악).
  // 캐시된 액세서리에 지난 부팅의 deviceId가 남아 있으므로 그것으로 붙인다.
  // ★반환값 = **아직 붙지 못한** 기기 목록. 재검색은 이것만 대상으로 한다(아래 참조).
  _bindFromCacheOffline(stDevices) {
    const unbound = [];
    let bound = 0;
    for (const configDevice of stDevices) {
      // 클라우드 전송 기기는 검색 없이는 방법이 없다 — 재검색 대상으로 남긴다.
      if (configDevice?.transport !== 'local') { unbound.push(configDevice); continue; }
      const target = normalizeKorean(configDevice.deviceLabel);
      const cached = this.accessories.find(a =>
        normalizeKorean(a.context?.configDevice?.deviceLabel || '') === target && a.context?.device?.deviceId);
      if (!cached) {
        this.log.warn(`[${labelOf(configDevice)}] 클라우드 검색 실패 + 캐시에도 정보가 없어 이번 부팅에는 바인딩하지 못했습니다.`);
        unbound.push(configDevice);
        continue;
      }
      this.log.warn(`[${labelOf(configDevice)}] 클라우드 검색 실패 — 캐시 정보로 로컬 경로만 살려 바인딩합니다.`);
      this._bindSmartThingsDevice(cached.context.device, configDevice);
      bound += 1;
    }
    if (bound > 0) this.log.info(`오프라인 바인딩 ${bound}개 — 로컬 전송 기기는 정상 동작합니다.`);
    return unbound;
  }

  // ★★2026-08-03 — **재검색은 아직 못 붙은 기기가 있을 때만** 한다.
  //   v2.10.1까지는 붙었든 말든 30초→120초→600초로 **영원히** 재검색했다. 10월에
  //   구독이 끊기면 `GET /v1/devices`가 매번 실패하므로 **하루 144회**가 무한히 나간다.
  //   하필 우리가 권장하는 구성(deviceId를 안 적고 IP만 적는 것)에서 정확히 열린다.
  //   ⚠️바인딩만 클라우드가 필요한 것이고, **런타임 폴백은 이 루프와 무관하다**
  //     (`_withFallback`은 deviceId만 있으면 클라우드를 직접 부른다). 그래서 다 붙었으면
  //     재검색을 멈춰도 잃는 기능이 없다.
  _scheduleRediscoveryIfNeeded(unbound) {
    if (!unbound || unbound.length === 0) {
      this.log.info('모든 기기가 캐시·로컬 정보로 붙었습니다 — 클라우드 재검색을 하지 않습니다.');
      return;
    }
    this._scheduleRediscovery(unbound);
  }

  // 클라우드가 돌아오면 조용히 보정한다. 실패해도 로컬은 이미 붙어 있다.
  _scheduleRediscovery(stDevices, attempt = 0) {
    if (this._rediscoverTimer) clearTimeout(this._rediscoverTimer);
    const delays = [30000, 120000, 600000];
    const delay = delays[Math.min(attempt, delays.length - 1)];
    this.log.info(`SmartThings 재검색을 ${delay / 1000}초 뒤 시도합니다 (${attempt + 1}회째).`);
    this._rediscoverTimer = setTimeout(async () => {
      this._rediscoverTimer = null;
      const ok = await this._discoverAndBindSmartThings(stDevices);
      if (ok) this.log.info('SmartThings 재검색 성공 — 클라우드 경로가 복구되었습니다.');
      else this._scheduleRediscovery(stDevices, attempt + 1);
    }, delay);
    // ★핸들러는 **한 번만** 등록한다(적대 리뷰 A-L2). 예전엔 시도마다 새 클로저를 push해
    //   재검색이 계속 실패하는 동안 하루 144개씩 무한히 쌓였다.
    if (!this._rediscoverShutdownHooked) {
      this._rediscoverShutdownHooked = true;
      this.registerShutdown(() => {
        if (this._rediscoverTimer) clearTimeout(this._rediscoverTimer);
      });
    }
  }

  // ── 정수기 (2026-08-04) ──────────────────────────────────────────────────
  //
  // ★홈킷 액세서리를 만들지 않는다. 그래서 `_bindSmartThingsDevice` 를 타지 않고
  //   여기서 직접 신원 조회 → 로컬 등록 → MQTT 폴러만 붙인다.
  //   ⚠️`KNOWN_TYPES` 에 반드시 들어 있어야 한다 — 빠지면 `_unknownTypes` 가 켜져
  //     **오래된 액세서리 정리가 통째로 멈춘다**(2026-08-03 에 다룬 그 경로).
  async _setupWaterPurifier(configDevice) {
    const label = configDevice.deviceLabel || '정수기';
    const host = configDevice.local && configDevice.local.host;
    if (!host) {
      this.log.warn(`[${label}] 기기 IP가 없어 건너뜁니다 — 정수기는 로컬 전용입니다.`);
      return;
    }
    if (!this.localClient) {
      this.log.warn(`[${label}] 로컬 브릿지가 준비되지 않아 이번 부팅에는 연결하지 못했습니다.`);
      return;
    }
    // ⚠️스키마 설명이 "끄면 HA 로 중계하지 않습니다"라고 약속한다 — 정수기도 지켜야 한다
    //   (적대 리뷰 M-3: 이 검사가 `_attachMqtt` 에만 있어 정수기는 무시하고 있었다).
    if (configDevice.mqttExpose === false) {
      this.log.info(`[${label}] MQTT 중계를 끔(설정) — 이 기기는 어디에도 노출되지 않습니다.`);
      return;
    }
    if (!this.mqtt || !this.mqtt.enabled) {
      // 홈킷에 안 올리므로 MQTT 가 없으면 이 기기는 **아무 데도 안 나간다** — 알려 준다.
      this.log.warn(`[${label}] MQTT가 꺼져 있어 중계하지 않습니다 `
        + '(정수기는 홈킷 액세서리를 만들지 않으므로 MQTT가 유일한 출구입니다).');
      return;
    }

    let deviceId = configDevice.deviceId;
    let name = null;
    if (!deviceId) {
      // ★★신원 조회는 **재시도해야 한다**(2026-08-04 실사고). 첫 시도에서 기기가 응답하지
      //   않으면(절전·전원 꺼짐·부팅 중 mDNS 미준비) 그대로 포기해 **재시작 전까지 영영**
      //   안 붙었다. 홈킷 기기 쪽에는 `_scheduleLocalIdRetry`(12회)가 있는데 여기만 없었다.
      //   ⚠️정수기는 홈킷 액세서리가 없어 **사용자가 빠진 걸 알아챌 방법도 없다** — 더 나쁘다.
      //   30초 → 2분 → 10분으로 늘려 가며 최대 12회(약 1.5시간) 시도한다.
      const DELAYS = [30, 120, 600];
      for (let attempt = 0; attempt < PURIFIER_PROBE_MAX; attempt += 1) {
        if (this._stopped) return;
        try {
          const found = await this.localClient.probeIdentity(host, configDevice.local.port, configDevice.local.localPort);
          deviceId = found.deviceId;
          name = found.name || null;
          if (attempt > 0) this.log.info(`[${label}] ${attempt + 1}회째 시도에 연결됐습니다.`);
          break;
        } catch (e) {
          const last = attempt === PURIFIER_PROBE_MAX - 1;
          const waitSec = DELAYS[Math.min(attempt, DELAYS.length - 1)];
          // 첫 회만 사용자에게 알린다 — 12줄이 쌓이면 로그만 지저분해진다.
          if (attempt === 0) {
            this.log.warn(`[${label}] ${host}가 응답하지 않습니다 — 기기 전원과 IP를 확인하세요. `
              + `${waitSec}초 뒤 다시 시도합니다(최대 ${PURIFIER_PROBE_MAX}회): ${e.message}`);
          } else if (last) {
            this.log.error(`[${label}] ${PURIFIER_PROBE_MAX}회 시도했지만 ${host}에 연결하지 못했습니다 — `
              + '기기 전원·IP를 확인한 뒤 홈브릿지를 재시작하세요.');
          } else {
            this.log.debug?.(`[${label}] 신원 조회 ${attempt + 1}회째 실패 — ${waitSec}초 뒤 재시도: ${e.message}`);
          }
          if (last) return;
          await new Promise((r) => { const t = setTimeout(r, waitSec * 1000); t.unref?.(); });
        }
      }
      if (!deviceId) return;
    }

    this.localClient.registerDevice(deviceId, {
      host,
      port: configDevice.local.port ? Number(configDevice.local.port) : undefined,
      localPort: configDevice.local.localPort ? Number(configDevice.local.localPort) : undefined,
      label,
      kind: 'waterPurifier',
      fallbackToCloud: false,   // 정수기는 클라우드 경로를 아예 두지 않는다
    });
    this.log.info(`[${label}] 로컬 연결${name ? ` — ${name}` : ''} (홈킷 액세서리 없음 · HA로만 중계)`);

    try {
      attachWaterPurifier({
        bridge: this.mqtt, log: this.log, client: this.localClient,
        deviceId, configDevice, slug: this._mqttSlug(configDevice, deviceId),
        label, platform: this,
      });
    } catch (e) {
      this.log.warn(`[${label}] MQTT 중계 준비 실패(무해): ${e.message}`);
    }
  }

  _setupLegacyAc(configDevice) {
    if (!configDevice.name || !configDevice.ip || !configDevice.token) {
      // ⚠️configDevice를 통째로 찍지 않는다 — **token이 평문으로 로그에 남는다**(v2.4.5 감사 S-2).
      //    무엇이 비었는지만 알려주면 진단에는 충분하다.
      const missing = ['name', 'ip', 'token'].filter(k => !configDevice[k]);
      this.log.error(`잘못된 구형 에어컨 설정 — 비어 있는 항목: ${missing.join(', ')}`
        + (configDevice.name ? ` (name=${configDevice.name})` : ''));
      return;
    }
    const uuid = UUIDGen.generate(configDevice.ip + configDevice.name);
    let accessory = this.accessories.find(a => a.UUID === uuid);
    if (accessory) {
      this.log.info(`'${configDevice.name}' (legacyAc) 액세서리 복원.`);
      accessory.context.config = configDevice;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info(`'${configDevice.name}' (legacyAc) 신규 등록.`);
      accessory = new Accessory(configDevice.name, uuid);
      accessory.context.config = configDevice;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }
    this.activeUUIDs.add(uuid);

    const logic = new LegacyAC({
      log: this.log,
      config: configDevice,
      api: this.api,
      accessory,
      packageRoot: PACKAGE_ROOT
    });
    // 인증서 실패 등으로 초기화가 완료되지 못한 logic은 등록하지 않는다.
    // HomeKit에 dead tile이 남지 않도록 미리 등록한 accessory도 정리.
    if (!logic._initialized) {
      this.log.error(`'${configDevice.name}' (legacyAc) 초기화 실패 — 인증서/네트워크 설정을 확인하세요. HomeKit에서 액세서리를 제거합니다.`);
      try {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } catch (e) {
        this.log.warn(`초기화 실패 accessory 제거 오류: ${e.message}`);
      }
      this.accessories = this.accessories.filter(a => a.UUID !== uuid);
      this.activeUUIDs.delete(uuid);
      return;
    }
    this.legacyLogics.push(logic);
    this.registerShutdown(() => logic.shutdown());
  }

  _bindSmartThingsDevice(device, configDevice) {
    const uuid = UUIDGen.generate(device.deviceId);
    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (accessory) {
      this.log.info(`기존 액세서리 갱신: ${device.label}`);
      accessory.context.device = device;
      accessory.context.configDevice = configDevice;
      accessory.displayName = device.label;
    } else {
      this.log.info(`새 액세서리 등록: ${device.label}`);
      accessory = new Accessory(device.label, uuid);
      accessory.context.device = device;
      accessory.context.configDevice = configDevice;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }
    this.activeUUIDs.add(uuid);

    // 같은 액세서리가 이미 configure 되었다면 logic 재인스턴스화/listener 재등록을 건너뛴다.
    // (OAuth 콜백 경로에서도 _bindSmartThingsDevice가 한 부팅 안에 두 번 호출될 수 있음)
    if (this._boundAccessoryIds.has(uuid)) {
      this.log.debug?.(`이미 설정된 액세서리(${device.label}) 중복 바인딩을 건너뜁니다.`);
      return;
    }
    this._boundAccessoryIds.add(uuid);

    // 전송 경로 선택: transport='local'이면 DTLS-CoAP 클라이언트를, 아니면 기존 클라우드를 쓴다.
    // 액세서리 코드는 두 클라이언트의 메서드 시그니처가 같아 아무 변경이 없다.
    const client = this._clientFor(configDevice, device.deviceId);

    if (configDevice.deviceType === 'smartAc') {
      const ac = new SmartAC({ log: this.log, api: this.api, smartthings: client, platform: this });
      ac.configure(accessory, configDevice, pkg.version);
      this._attachMqtt(accessory, configDevice, ac);
    } else if (configDevice.deviceType === 'washer' || configDevice.deviceType === 'dryer') {
      const laundry = new Laundry({
        log: this.log, api: this.api, smartthings: client, platform: this,
        deviceKind: configDevice.deviceType
      });
      laundry.configure(accessory, configDevice, pkg.version);
      this._attachMqtt(accessory, configDevice, laundry);
    } else {
      this.log.warn(`알 수 없는 deviceType: ${configDevice.deviceType}`);
    }
  }

  // HA 중계용 토픽 이름. 설정에 mqttSlug가 있으면 그걸 쓴다(권장 — 배포 config에 명시).
  // 없으면 기기 종류를 쓴다(집에 종류별 1대뿐). ★같은 종류가 둘 이상이고 mqttSlug도 없으면
  // 번호가 아니라 deviceId 조각으로 구분한다 — 번호는 바인딩 순서에 종속돼 부팅마다 A↔B가
  // 뒤바뀌면 HA에 유령 엔티티가 쌓이기 때문(적대 감사). deviceId 조각은 순서·재부팅 무관.
  _mqttSlug(configDevice, deviceId) {
    const norm = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!this._usedSlugs) this._usedSlugs = new Set();
    const explicit = norm(configDevice.mqttSlug);
    if (explicit) {
      // ★명시 slug도 사용 집합에 등록한다. 예전엔 등록을 안 해서, 두 대 중 한 대만
      //   mqttSlug='washer'를 지정하면 나머지 자동 slug도 'washer'가 되어 **두 기기 상태가
      //   한 토픽에 번갈아 발행**됐다(오류 로그 없이 플래핑, 적대 감사 지적).
      if (this._usedSlugs.has(explicit)) {
        this.log.warn(`[MQTT] '${configDevice.deviceLabel}'의 mqttSlug '${explicit}'가 이미 다른 기기에 쓰였습니다 `
          + `— 토픽이 겹쳐 상태가 섞이므로 설정에서 서로 다르게 지정하세요. 이 기기는 중계에서 제외합니다.`);
        return null;
      }
      this._usedSlugs.add(explicit);
      return explicit;
    }
    const base = norm(configDevice.deviceType) || 'device';
    if (!this._usedSlugs.has(base)) { this._usedSlugs.add(base); return base; }
    // 이미 같은 종류가 있었다 → deviceId 앞 6자로 안정적으로 가른다.
    const suffix = norm(deviceId).replace(/_/g, '').slice(0, 6) || 'x';
    let slug = `${base}_${suffix}`;
    let n = 2;
    while (this._usedSlugs.has(slug)) slug = `${base}_${suffix}_${n++}`;
    this._usedSlugs.add(slug);
    this.log.warn(`[MQTT] 같은 종류(${base}) 기기가 여럿입니다 — '${configDevice.deviceLabel}'의 토픽 slug를 '${slug}'로 정했습니다. `
      + `안정적 운용을 위해 config의 mqttSlug를 명시하는 것을 권합니다.`);
    return slug;
  }

  // ★어떤 실패도 홈킷을 막지 않는다 — 중계는 부가 기능이다.
  _attachMqtt(accessory, configDevice, logic) {
    if (!this.mqtt || !this.mqtt.enabled) return;
    if (configDevice.mqttExpose === false) {
      this.log.debug?.(`[MQTT] '${accessory.displayName}' 은 설정에서 중계 제외됨`);
      return;
    }
    // ★세탁조 분리(splitCompartments) + MQTT 조합은 아직 메인 구획만 반영된다(보조는 별
    //   액세서리라 이 중계가 못 본다). 현재는 합침 고정이라 미발현이나, 켜면 조용히 틀린
    //   상태가 나가므로 경고만 남긴다(적대 감사 F2). 합침 모드에선 이 경고가 안 뜬다.
    if (configDevice.splitCompartments === true
        && (configDevice.deviceType === 'washer' || configDevice.deviceType === 'dryer')) {
      this.log.warn(`[MQTT] '${accessory.displayName}'는 세탁조 분리가 켜져 있습니다 — MQTT 중계는 현재 `
        + `메인 구획만 반영합니다(보조 구획 미반영). 합침 모드 사용을 권합니다.`);
    }
    const slug = this._mqttSlug(configDevice, accessory.context?.device?.deviceId);
    if (!slug) return;   // slug 충돌 — 위에서 경고했고, 섞인 상태를 내보내는 것보다 빼는 게 안전
    try {
      const common = { bridge: this.mqtt, api: this.api, log: this.log, accessory, configDevice, slug, platform: this };
      // ★logic을 두 경로에 모두 넘긴다 — 세탁물 쪽에 빼먹으면 client가 null이 되어
      //   로컬 건조기가 8888 세탁기와 같은 취급을 받고 진행률·에너지·raw 남은시간이 통째로
      //   누락된다(2026-07-30 실측으로 발견, 코드 리뷰 4회가 놓친 결함).
      const ok = configDevice.deviceType === 'smartAc'
        ? attachSmartAc({ ...common, logic })
        : attachLaundry({ ...common, logic, kind: configDevice.deviceType });
      if (ok) this.log.info(`[MQTT] '${accessory.displayName}' 중계 시작 — ${this.mqtt.base}/${slug}`);
    } catch (e) {
      // ⚠️문구 주의: NAS hb-watch가 '연결 실패'·'무응답'·'폴링 실패' 등을 텔레그램 경보로 올린다.
      //   중계는 부가 기능이라 홈킷이 멀쩡한데도 기기 장애 경보가 울리면 오탐이다 → 그 단어를 피한다.
      this.log.error(`[MQTT] '${accessory.displayName}' 중계를 붙이지 못했습니다 — 홈킷은 정상 동작합니다: ${e.message}`);
    }
  }

  // ★클라우드 토큰 keepalive (v2.4.2)
  //
  // 왜 필요한가: 전 기기를 로컬로 옮기면 평상시 SmartThings API 호출이 **0회**가 된다.
  // 그런데 이 플러그인의 토큰 갱신은 "401을 받으면 갱신"하는 **반응형**이다(SmartThingsClient의
  // 인터셉터). 호출이 없으면 401도 없고, 갱신도 없다. 그 사이 refresh 토큰은 수명을 다하고,
  // **로컬이 처음 실패해 폴백이 정말 필요해지는 순간** 재인증을 요구받는다 — 안전망이
  // 필요할 때 없는 최악의 형태다.
  // 그래서 하루 한 번 능동적으로 갱신한다. 갱신 때마다 refresh 토큰이 회전하므로 만료되지 않는다.
  //
  // 로컬 기기가 하나도 없으면(=클라우드를 상시 쓰는 구성) 불필요하므로 걸지 않는다.
  _startCloudKeepalive() {
    if (!this.smartthings) return;
    const localDevs = this.devices.filter(d => d && d.transport === 'local');
    if (!localDevs.length) return;
    // ★폴백을 **전부** 꺼 두었으면 토큰을 살려 둘 이유가 없다(v2.4.5 감사 C-3).
    //   이 경우 keepalive가 남으면 그게 하루 하나 남은 유일한 클라우드 호출이 된다 —
    //   "클라우드 0회"를 원하는 구성에서 목표를 못 이루게 하는 마지막 한 건.
    const anyFallback = localDevs.some(d => d.local?.fallbackToCloud !== false);
    if (!anyFallback) {
      // ⚠️여기서 「클라우드 호출 0회」라고 단정하면 **거짓말이 된다**(2026-08-03 적대 리뷰).
      //   OAuth를 남겨 둔 채 폴백만 끈 구성에서는, 이 줄이 찍히는 같은 부팅에서 이미
      //   부팅 시 기기 검색(`GET /v1/devices`)이 나갔을 수 있다. 사실인 것만 말한다 —
      //   **앞으로 주기적인 호출이 없다**는 것.
      this.log.info('모든 로컬 기기가 클라우드 폴백을 끔 — 토큰 keepalive를 걸지 않습니다 (이후 주기적인 클라우드 호출 없음).');
      return;
    }

    const DAY_MS = 24 * 60 * 60 * 1000;
    const FIRST_DELAY_MS = 30 * 60 * 1000;   // 부팅 직후 혼잡을 피해 30분 뒤 첫 실행

    const run = async () => {
      try {
        // ★single-flight 경유 (v2.4.5 감사 C-3). 직접 refreshToken()을 부르면
        //   마침 폴백 중 401 인터셉터가 돌리는 갱신과 겹쳐 refresh POST가 2발 나갈 수 있다.
        //   SmartThings는 refresh 토큰을 회전시키므로 늦게 도착한 쪽이 이미 소진된 토큰을 쓰게 되고,
        //   최악의 경우 토큰 파일 삭제 + 재인증 요구까지 간다.
        await this.smartthings._refreshTokenSingleFlight();
        this.log.info('클라우드 토큰 갱신됨 (폴백 유지용, 하루 1회)');
      } catch (e) {
        // ⚠️여기서 토큰 파일을 지우지 않는다 — 일시 장애로 유효한 토큰을 전소시키면
        //   전 기기의 폴백이 죽는다(v1.8.26에서 같은 이유로 파기 조건을 좁혔다).
        if (e && e._fatalAuth) {
          this.log.error(`클라우드 재인증이 필요합니다 — 로컬은 계속 동작하지만 폴백은 쓸 수 없습니다: ${e.message}`);
        } else {
          this.log.warn(`클라우드 토큰 갱신 실패 — 다음 주기에 다시 시도합니다: ${e.message}`);
        }
      }
    };

    let interval = null;
    const first = setTimeout(() => { interval = setInterval(run, DAY_MS); run(); }, FIRST_DELAY_MS);
    this.registerShutdown(() => { clearTimeout(first); if (interval) clearInterval(interval); });
    this.log.info('클라우드 토큰 keepalive 활성 (하루 1회) — 로컬 실패 시 폴백을 쓸 수 있게 유지합니다.');
  }
  // transport 설정에 따라 이 기기가 쓸 클라이언트를 고른다.
  // 로컬을 요청했는데 브릿지가 못 떴거나 host/port가 없으면 조용히 클라우드로 내린다.
  _clientFor(configDevice, deviceId) {
    if (configDevice.transport !== 'local') return this.smartthings;
    const cfg = configDevice.local || {};

    // ★구형 8888 경로 — 토큰이 있으면 이쪽이다(2026-07-29 세탁기 실기기 검증).
    // 신형(DTLS-CoAP)은 토큰이 없고, 구형 8888은 기기별 토큰이 반드시 필요하다.
    // 그래서 토큰 유무만으로 갈라도 모호하지 않다 — 전송 선택지를 늘리지 않기 위한 설계.
    // 전송 자체는 구형 에어컨과 **같은 LegacyACClient**를 재사용한다(중복 구현·인증서 중복 관리 금지).
    if (cfg.token) {
      // ★기기 종류 가드 — 토큰만 보고 갈랐더니, 실수로 다른 기기에 토큰이 들어가면
      // 그 기기가 DTLS에도 클라우드에도 등록되지 않아 **통째로 죽었다**(적대 감사 D2).
      if (configDevice.deviceType !== 'washer' && configDevice.deviceType !== 'dryer') {
        this.log.warn(`[${labelOf(configDevice)}] 이 기기는 8888 토큰 방식을 쓰지 않습니다 — 토큰을 무시하고 기존 로컬 경로로 진행합니다.`);
      } else if (!cfg.host) {
        this.log.warn(`[${labelOf(configDevice)}] 로컬(8888)을 요청했지만 기기 IP가 없어 ${cloudWord(configDevice, this.smartthings)}. 설정의 '기기 IP'를 채우세요.`);
        return this.smartthings;
      } else {
        const key = `${cfg.host}:8888`;
        if (!this._legacyLaundryClients.has(key)) {
          // ★인증서 읽기는 동기 throw다. 여기서 새어 나가면 `didFinishLaunching`이 거부되어
          // **전 기기 바인딩이 중단**된다(적대 감사 D1/D5 — 세탁기 설정 하나로 플랫폼 전멸).
          // 구형 에어컨은 같은 상황을 try/catch로 막아 두었는데 이 경로만 무방비였다.
          try {
            this._legacyLaundryClients.set(key, new LegacyLaundryClient(this.log, {
              ip: cfg.host,
              token: cfg.token,
              label: configDevice.deviceLabel,
              timeout: configDevice.timeout,
              certPath: configDevice.certPath || path.join(PACKAGE_ROOT, 'cert', 'cert.pem'),
              cloudClient: this.smartthings,
              deviceId,
              fallbackToCloud: cfg.fallbackToCloud !== false,
            }));
            this.log.info(`[${labelOf(configDevice)}] 로컬 경로 등록 — ${cfg.host}:8888 (토큰 방식)`);
          } catch (e) {
            this.log.error(`[${labelOf(configDevice)}] 로컬(8888) 준비 실패 — ${cloudWord(configDevice, this.smartthings)}: ${e.message}`);
            return this.smartthings;
          }
        }
        return this._legacyLaundryClients.get(key);
      }
    }

    // port는 선택이다 — 비워두면 브릿지가 49152~49160을 탐지한다.
    if (!this.localClient || !cfg.host) {
      this.log.warn(`[${labelOf(configDevice)}] 로컬 전송을 요청했지만 준비되지 않아 ${cloudWord(configDevice, this.smartthings)} (기기 IP 확인).`);
      return this.smartthings;
    }
    this.localClient.registerDevice(deviceId, {
      host: cfg.host,
      port: cfg.port ? Number(cfg.port) : undefined,
      localPort: cfg.localPort ? Number(cfg.localPort) : undefined,
      label: configDevice.deviceLabel,
      kind: configDevice.deviceType,
      fallbackToCloud: cfg.fallbackToCloud !== false,
    });
    return this.localClient;
  }

  _cleanupStaleAccessories() {
    // ★모르는 종류가 설정에 있으면 어떤 경로로 불려도 지우지 않는다. 그 기기는 필터에
    //   걸러져 activeUUIDs에 안 들어가므로, 여기서 지우면 곧바로 영구 삭제가 된다.
    //   (호출 지점이 넷이라 개별로 막지 않고 이 한 곳에서 막는다.)
    if (this._unknownTypes) return;

    // ★★2026-08-03 — **config에 아직 이름이 남아 있는 액세서리는 지우지 않는다**(적대 리뷰 H3).
    //   시나리오: DHCP가 기기 A의 IP를 다른 기기에 줬는데 마침 discovered 캐시가 비어 있으면,
    //   프로브가 **그 남의 di**를 A의 deviceId로 배운다. 신원 대조는 "프로브가 채운 deviceId"와
    //   기기 di를 비교하므로 **정의상 통과**한다. UUID가 바뀌니 A의 액세서리는 stale이 되고
    //   여기서 **영구 삭제**된다 — 홈킷 방·장면·자동화 배치가 통째로 날아간다.
    //   삭제는 되돌릴 수 없고 남겨두는 건 되돌릴 수 있다. 그래서 남긴다.
    //   ⚠️설정에서 기기를 **빼거나 이름을 바꾸면** 이름이 사라지므로 종전대로 지워진다.
    //   ★★2026-08-03 2차 — **이름이 아니라 기기 IP(host)로 지킨다**(적대 리뷰 H1-a).
    //     이름으로 지키면 우리가 권장하는 구성(라벨을 비우고 IP만 적기)에서 **정의상 무력**했다.
    //     `_probeOne`이 기기가 알려준 이름을 `deviceLabel`에 **채워 넣기 때문**이다 —
    //     남의 기기가 그 IP에 앉으면 config 라벨 자체가 **그 남의 이름**이 되고, 원래
    //     액세서리의 라벨과는 영영 안 맞는다. 즉 v2.11.0이 막았다고 한 바로 그 시나리오가
    //     그대로 열려 있었다. **host는 프로브가 덮지 않으므로** 그 함정이 없다.
    //     ⚠️이름도 계속 본다 — 로컬이 아닌(클라우드) 기기는 host가 없다.
    const configLabels = new Set(
      (this.devices || []).map(d => normalizeKorean(d?.deviceLabel || '')).filter(Boolean));
    const configHosts = new Set(
      (this.devices || []).map(d => String(d?.local?.host || '').trim()).filter(Boolean));
    const keyOf = (a) => {
      const cd = a.context?.configDevice;
      return {
        label: normalizeKorean(cd?.deviceLabel || ''),
        host: String(cd?.local?.host || '').trim(),
        deviceId: a.context?.device?.deviceId || '',
      };
    };
    // 1차 — 설정이 여전히 가리키는 기기인가(host 우선, 없으면 이름).
    const kept = [];
    const keptDeviceIds = new Set();
    let stale = this.accessories.filter((a) => {
      if (this.activeUUIDs.has(a.UUID)) return false;
      const k = keyOf(a);
      if ((k.host && configHosts.has(k.host)) || (k.label && configLabels.has(k.label))) {
        kept.push(a);
        if (k.deviceId) keptDeviceIds.add(k.deviceId);
        return false;
      }
      return true;
    });
    // 2차 — ★남긴 기기의 **서브 액세서리**(무풍·자동건조 스위치, 종료 알림 센서)도 함께 남긴다
    //   (적대 리뷰 H1-b). 이들은 `context.configDevice`가 없어 1차 판정이 항상 빈 문자열이라,
    //   본체는 살고 **스위치만 영구 삭제**됐다 — 그 스위치에 걸린 자동화·방 배치가 날아간다.
    if (keptDeviceIds.size > 0) {
      stale = stale.filter((a) => {
        const id = a.context?.device?.deviceId;
        if (id && keptDeviceIds.has(id)) { kept.push(a); return false; }
        return true;
      });
    }
    for (const a of kept) {
      this.log.warn(`[${a.displayName}] 설정이 아직 이 기기를 가리키고 있어 ★지우지 않았습니다 — `
        + '기기의 deviceId가 지난 부팅과 달라졌습니다. 기기 IP가 맞는지 확인하세요. '
        + '기기를 정말 교체했다면 설정에서 이 항목을 지웠다가 다시 넣으면 정리됩니다.');
    }

    if (stale.length > 0) {
      this.log.info(`${stale.length}개의 오래된 액세서리를 제거합니다.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter(a => this.activeUUIDs.has(a.UUID));
    }
  }

  _shutdown() {
    this._stopped = true;   // 진행 중인 deviceId 재시도를 더 예약하지 않는다
    this.log.info('플랫폼 종료 신호 수신, 리소스를 정리합니다.');
    for (const fn of this.shutdownHandlers) {
      try { fn(); } catch (e) { this.log.warn('Shutdown 핸들러 오류:', e.message); }
    }
    if (this.oauthServer) this.oauthServer.stop();
  }
}

module.exports.PLATFORM_NAME = PLATFORM_NAME;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
