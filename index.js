'use strict';

const pkg = require('./package.json');
const SmartThingsClient = require('./lib/api/SmartThingsClient');
const OAuthServer = require('./lib/auth/OAuthServer');
const LegacyAC = require('./lib/accessories/LegacyAC');
const SmartAC = require('./lib/accessories/SmartAC');
const Laundry = require('./lib/accessories/Laundry');

const PLATFORM_NAME = 'SmartThingsKM81';
const PLUGIN_NAME = 'homebridge-smartthings-km81';
const PACKAGE_ROOT = __dirname;

const normalizeKorean = s => (s || '').normalize('NFC').trim();

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
    this.shutdownHandlers = [];
    this.legacyLogics = [];
    this.PLUGIN_NAME = PLUGIN_NAME;
    this.PLATFORM_NAME = PLATFORM_NAME;

    if (!api) return;

    this.devices = Array.isArray(this.config.devices) ? this.config.devices : [];

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
      }
    }

    this.log.info(`${PLATFORM_NAME} 플랫폼 초기화 중... (v${pkg.version})`);

    // 디바이스 바인딩은 부팅당 1회만 보장 — OAuth 콜백 경로에서도 같은 액세서리에
    // listener/타이머가 중복 등록되지 않도록 한다.
    this._boundAccessoryIds = new Set();

    this.api.once('didFinishLaunching', () => this._didFinishLaunching());
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
    this.log.info('Homebridge 실행 완료. 장치 검색을 시작합니다.');

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

    let stDiscoverySucceeded = stDevices.length === 0;
    if (stDevices.length > 0 && this.smartthings) {
      const hasToken = await this.smartthings.init();
      if (!hasToken) {
        this.oauthServer.start(async () => {
          const ok = await this._discoverAndBindSmartThings(stDevices);
          if (ok) this._cleanupStaleAccessories();
        });
      } else {
        stDiscoverySucceeded = await this._discoverAndBindSmartThings(stDevices);
      }
    }

    // SmartThings 검색이 실패/빈 결과였다면 stale cleanup을 건너뛴다.
    // — 일시 장애 시 사용자의 알림 센서·자동화·방 배치가 영구 삭제되는 것을 막기 위함.
    if (stDiscoverySucceeded) {
      this._cleanupStaleAccessories();
    } else {
      this.log.warn('SmartThings 장치 검색이 실패하거나 비어 있어, 오래된 액세서리 정리를 건너뜁니다. (자동화 보호)');
    }
  }

  // 성공 시 true, 실패/빈 결과 시 false 반환. 호출자가 cleanup 여부를 결정한다.
  async _discoverAndBindSmartThings(stDevices) {
    try {
      const remoteDevices = await this.smartthings.getDevices();
      if (!remoteDevices || remoteDevices.length === 0) {
        this.log.warn('SmartThings에서 어떤 장치도 찾지 못했습니다. 권한이나 연결을 확인해주세요.');
        return false;
      }
      this.log.info(`총 ${remoteDevices.length}개의 SmartThings 장치를 발견했습니다.`);

      for (const configDevice of stDevices) {
        const targetLabel = normalizeKorean(configDevice.deviceLabel);
        if (!targetLabel) {
          this.log.warn('deviceLabel이 비어있는 SmartThings 장치 설정을 건너뜁니다.');
          continue;
        }
        const found = remoteDevices.find(d => normalizeKorean(d.label) === targetLabel);
        if (!found) {
          this.log.warn(`'${configDevice.deviceLabel}'에 해당하는 장치를 SmartThings에서 찾지 못했습니다.`);
          continue;
        }
        this.log.info(`'${configDevice.deviceLabel}' (${configDevice.deviceType}) 장치를 HomeKit에 추가/갱신합니다.`);
        this._bindSmartThingsDevice(found, configDevice);
      }
      return true;
    } catch (e) {
      this.log.error('SmartThings 장치 검색 중 오류:', e.message);
      return false;
    }
  }

  _setupLegacyAc(configDevice) {
    if (!configDevice.name || !configDevice.ip || !configDevice.token) {
      this.log.error('잘못된 LegacyAC 설정(name, ip, token 확인):', configDevice);
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

    if (configDevice.deviceType === 'smartAc') {
      const ac = new SmartAC({ log: this.log, api: this.api, smartthings: this.smartthings, platform: this });
      ac.configure(accessory, configDevice, pkg.version);
    } else if (configDevice.deviceType === 'washer' || configDevice.deviceType === 'dryer') {
      const laundry = new Laundry({
        log: this.log, api: this.api, smartthings: this.smartthings, platform: this,
        deviceKind: configDevice.deviceType
      });
      laundry.configure(accessory, configDevice, pkg.version);
    } else {
      this.log.warn(`알 수 없는 deviceType: ${configDevice.deviceType}`);
    }
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
