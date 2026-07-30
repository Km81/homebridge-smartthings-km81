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
const { attachSmartAc, attachLaundry } = require('./lib/mqtt/attach');
const path = require('path');

const PLATFORM_NAME = 'SmartThingsKM81';
const PLUGIN_NAME = 'homebridge-smartthings-km81';
const PACKAGE_ROOT = __dirname;

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

    if (hasSmartThingsDevices) {
      const missing = [];
      if (!this.config.clientId) missing.push('clientId');
      if (!this.config.clientSecret) missing.push('clientSecret');
      if (!this.config.redirectUri) missing.push('redirectUri');
      if (missing.length > 0) {
        this.log.error(`SmartThings 장치를 사용하려면 다음 필드가 필요합니다: ${missing.join(', ')}`);
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

    // 1) Legacy AC 장치 처리 (SmartThings 불필요)
    const legacyDevices = this.devices.filter(d => d?.deviceType === 'legacyAc');
    for (const dev of legacyDevices) {
      this._setupLegacyAc(dev);
    }

    // 2) SmartThings 장치 처리
    const stDevices = this.devices.filter(d =>
      d?.deviceType === 'smartAc' || d?.deviceType === 'washer' || d?.deviceType === 'dryer'
    );

    // 2-a) 로컬 전송(DTLS-CoAP)을 쓰는 기기가 있으면 브릿지를 먼저 띄운다.
    // 실패해도 치명적이지 않다 — 각 기기는 클라우드로 폴백한다.
    // ★8888 토큰 기기는 파이썬 DTLS 브릿지가 필요 없다 — 이걸 빼지 않으면 세탁기 하나 때문에
    // pip 설치(최대 180초)와 기동 대기가 헛돈다(적대 감사 D4).
    const localDevices = stDevices.filter(d => d?.transport === 'local' && !d?.local?.token);
    if (localDevices.length > 0) {
      this.localClient = new LocalApplianceClient(this.log, {
        cloudClient: this.smartthings,
        pythonBin: this.config.localPythonBin || undefined,
        stateDir: this.config.localStateDir || undefined,
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
        this.log.error(`로컬 브릿지 기동 지연/실패 — 준비될 때까지 클라우드로 동작합니다: ${e.message}`);
      }
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

    // v2.3.0 — config에 deviceId가 적힌 기기는 클라우드 조회 없이 바로 붙인다.
    // 모든 기기에 적어두면 부팅에도 SmartThings API를 한 번도 쓰지 않는다(유료화 대비).
    const needDiscovery = this._bindByConfiguredIds(stDevices);

    let stDiscoverySucceeded = needDiscovery.length === 0;
    if (stDevices.length > 0 && this.smartthings) {
      if (!hasToken) {
        this.oauthServer.start(async () => {
          const ok = await this._discoverAndBindSmartThings(needDiscovery);
          if (ok) this._cleanupStaleAccessories();
        });
      } else if (needDiscovery.length > 0) {
        stDiscoverySucceeded = await this._discoverAndBindSmartThings(needDiscovery);
      }
    }

    // SmartThings 검색이 실패/빈 결과였다면 stale cleanup을 건너뛴다.
    // — 일시 장애 시 사용자의 알림 센서·자동화·방 배치가 영구 삭제되는 것을 막기 위함.
    if (stDiscoverySucceeded) {
      this._cleanupStaleAccessories();
    } else {
      this.log.warn('SmartThings 장치 검색이 실패하거나 비어 있어, 오래된 액세서리 정리를 건너뜁니다. (자동화 보호)');
    }

    this._startCloudKeepalive();
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
      this.log.info(`'${label}' (${configDevice.deviceType}) — config의 deviceId로 바로 연결 (클라우드 조회 생략)`);
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
        this._bindFromCacheOffline(stDevices);
        this._scheduleRediscovery(stDevices);
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
        this.log.info(`'${configDevice.deviceLabel}' (${configDevice.deviceType}) HomeKit 추가/갱신`);
        this.log.info(`  ↳ deviceId=${found.deviceId} — config에 적어두면 다음 부팅부터 클라우드 조회를 건너뜁니다`);
        this._bindSmartThingsDevice(found, configDevice);
      }
      return true;
    } catch (e) {
      this.log.error('SmartThings 장치 검색 중 오류:', e.message);
      this._bindFromCacheOffline(stDevices);
      this._scheduleRediscovery(stDevices);
      return false;
    }
  }

  // v2.2.3 — ★클라우드 검색이 실패해도 로컬 기기는 살린다(감사 HIGH-A).
  // 정전 복구나 인터넷 장애 중에 홈브릿지가 재시작되면, LAN으로 멀쩡히 통신 가능한
  // 승준 에어컨·건조기까지 바인딩이 안 돼 홈킷 조작이 조용히 유실됐다(무성 유실 = 최악).
  // 캐시된 액세서리에 지난 부팅의 deviceId가 남아 있으므로 그것으로 붙인다.
  _bindFromCacheOffline(stDevices) {
    const localOnly = stDevices.filter(d => d?.transport === 'local');
    if (localOnly.length === 0) return;
    let bound = 0;
    for (const configDevice of localOnly) {
      const target = normalizeKorean(configDevice.deviceLabel);
      const cached = this.accessories.find(a =>
        normalizeKorean(a.context?.configDevice?.deviceLabel || '') === target && a.context?.device?.deviceId);
      if (!cached) {
        this.log.warn(`[${configDevice.deviceLabel}] 클라우드 검색 실패 + 캐시에도 정보가 없어 이번 부팅에는 바인딩하지 못했습니다.`);
        continue;
      }
      this.log.warn(`[${configDevice.deviceLabel}] 클라우드 검색 실패 — 캐시 정보로 로컬 경로만 살려 바인딩합니다.`);
      this._bindSmartThingsDevice(cached.context.device, configDevice);
      bound += 1;
    }
    if (bound > 0) this.log.info(`오프라인 바인딩 ${bound}개 — 로컬 전송 기기는 정상 동작합니다.`);
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
    this.registerShutdown(() => {
      if (this._rediscoverTimer) clearTimeout(this._rediscoverTimer);
    });
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
    const explicit = norm(configDevice.mqttSlug);
    if (explicit) return explicit;   // 명시 slug는 중복 방지 대상 아님(사용자 책임)
    const base = norm(configDevice.deviceType) || 'device';
    if (!this._usedSlugs) this._usedSlugs = new Set();
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
    try {
      const common = { bridge: this.mqtt, api: this.api, log: this.log, accessory, configDevice, slug, platform: this };
      const ok = configDevice.deviceType === 'smartAc'
        ? attachSmartAc({ ...common, logic })
        : attachLaundry({ ...common, kind: configDevice.deviceType });
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
      this.log.info('모든 로컬 기기가 클라우드 폴백을 끔 — 토큰 keepalive를 걸지 않습니다 (클라우드 호출 0회).');
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
        this.log.warn(`[${configDevice.deviceLabel}] 이 기기는 8888 토큰 방식을 쓰지 않습니다 — 토큰을 무시하고 기존 로컬 경로로 진행합니다.`);
      } else if (!cfg.host) {
        this.log.warn(`[${configDevice.deviceLabel}] 로컬(8888)을 요청했지만 기기 IP가 없어 클라우드로 동작합니다.`);
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
            this.log.info(`[${configDevice.deviceLabel}] 로컬 경로 등록 — ${cfg.host}:8888 (토큰 방식)`);
          } catch (e) {
            this.log.error(`[${configDevice.deviceLabel}] 로컬(8888) 준비 실패 — 클라우드로 동작합니다: ${e.message}`);
            return this.smartthings;
          }
        }
        return this._legacyLaundryClients.get(key);
      }
    }

    // port는 선택이다 — 비워두면 브릿지가 49152~49160을 탐지한다.
    if (!this.localClient || !cfg.host) {
      this.log.warn(`[${configDevice.deviceLabel}] 로컬 전송을 요청했지만 준비되지 않아 클라우드로 동작합니다 (기기 IP 확인).`);
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
    const stale = this.accessories.filter(a => !this.activeUUIDs.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`${stale.length}개의 오래된 액세서리를 제거합니다.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter(a => this.activeUUIDs.has(a.UUID));
    }
  }

  _shutdown() {
    this.log.info('플랫폼 종료 신호 수신, 리소스를 정리합니다.');
    for (const fn of this.shutdownHandlers) {
      try { fn(); } catch (e) { this.log.warn('Shutdown 핸들러 오류:', e.message); }
    }
    if (this.oauthServer) this.oauthServer.stop();
  }
}

module.exports.PLATFORM_NAME = PLATFORM_NAME;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
