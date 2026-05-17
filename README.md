# homebridge-smartthings-km81

Samsung 가전 3종(구형 에어컨 / 신형 에어컨 / 세탁기·건조기)을 **하나의 Homebridge 플러그인**으로 통합한 플랫폼입니다.

기존에 분리되어 있던 다음 3개 플러그인을 통합·대체합니다.

- `homebridge-samsung-ac` (구형 에어컨, TLSv1 직접 통신)
- `homebridge-smartthings-ac-km81` (신형 에어컨, SmartThings API)
- `homebridge-smartthings-washer` (세탁기/건조기, SmartThings API)

---

## 주요 기능

- 한 플러그인, **하나의 SmartThings OAuth 토큰**(`smartthings_km81_token.json`)으로 신형 AC + 세탁기 + 건조기를 모두 관리
- 구형 에어컨은 TLSv1 / `SECLEVEL=0` 직접 통신을 그대로 유지 (Homebridge 2.0 호환)
- 신형 에어컨 무풍/자동건조 매핑, 별도 스위치 노출 등 기존 기능 보존
- 세탁기/건조기 Valve 서비스(Active/InUse/RemainingDuration)는 그대로
- **NEW**: 세탁기/건조기 알림 센서 (HomeKit 자동화 트리거용 가상 센서)

---

## 설치

```shell
npm install -g homebridge-smartthings-km81
```

Homebridge UI 플러그인 탭에서 검색해 설치할 수도 있습니다.

---

## 장치 종류 (deviceType)

`devices` 배열의 각 항목에 `deviceType`을 지정합니다. UI에서 선택한 타입에 따라 해당 필드만 표시됩니다.

| deviceType | 설명 | 통신 방식 |
| --- | --- | --- |
| `legacyAc` | 구형 Samsung 에어컨 | 로컬 TLSv1 (8888 포트) |
| `smartAc`  | 신형 Samsung 에어컨 | SmartThings Cloud |
| `washer`   | 세탁기              | SmartThings Cloud |
| `dryer`    | 건조기              | SmartThings Cloud |

> SmartThings 기반 장치(`smartAc` / `washer` / `dryer`)가 하나라도 있으면 `clientId`, `clientSecret`, `redirectUri`가 필요합니다.

---

## SmartThings OAuth 인증 절차

1. [SmartThings Developer Workspace](https://smartthings.developer.samsung.com/workspace)에서 `Automation for the SmartThings App` 프로젝트 생성.
2. Scope에 다음 3개 모두 체크:
   - `r:devices:*`
   - `w:devices:*`
   - `x:devices:*`
3. `Redirect URI`는 반드시 **HTTPS**. 내부적으로 플러그인은 `8999` 포트에서 콜백을 수신하므로 리버스 프록시로 HTTPS → `http://homebridge:8999`로 전달하세요.
4. 발급받은 `Client ID` / `Client Secret`을 플러그인 설정에 입력하고 Homebridge 재시작.
5. 첫 실행 시 로그에 인증 URL이 표시됩니다. 브라우저로 접속해 권한 허용 → 자동으로 토큰이 저장됩니다(`smartthings_km81_token.json`).
6. Homebridge를 한 번 더 재시작하면 장치가 추가됩니다.

> Webhook lifecycle CONFIRMATION 요청도 같은 서버가 자동 처리합니다.

---

## 설정 예시 (config.json)

```jsonc
{
  "platform": "SmartThingsKM81",
  "name": "SmartThings KM81",

  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "redirectUri": "https://myhome.example.com:9001/oauth/callback",

  "temperatureMin": 18,
  "temperatureMax": 30,
  "temperatureStep": 1,

  "devices": [
    {
      "deviceType": "legacyAc",
      "name": "거실 에어컨",
      "ip": "192.168.1.50",
      "token": "LEGACY_TOKEN",
      "swingModeType": "comfort",
      "pollingInterval": 60
    },
    {
      "deviceType": "smartAc",
      "deviceLabel": "안방 에어컨",
      "coolModeCommand": "dry",
      "swingBinding": "windFree",
      "lockBinding": "autoClean",
      "exposeWindFreeSwitch": true,
      "exposeAutoCleanSwitch": true
    },
    {
      "deviceType": "washer",
      "deviceLabel": "세탁기",
      "model": "WF24B9600",
      "enableNotificationSensor": true,
      "sensorTypes": ["contact", "motion"],
      "triggerMode": ["onCompletion", "duringRun"],
      "sensorPollInterval": 30
    },
    {
      "deviceType": "dryer",
      "deviceLabel": "건조기",
      "model": "DV90B6800",
      "enableNotificationSensor": true,
      "sensorTypes": ["occupancy"],
      "triggerMode": ["onCompletion"]
    }
  ]
}
```

---

## 세탁기/건조기 알림 센서

세탁/건조 완료 알림이나 운전 상태 자동화를 HomeKit으로 직접 구성할 수 있도록, **가상 센서**를 별도 액세서리로 노출합니다.

### 옵션

- `enableNotificationSensor` (boolean) — 활성화 여부
- `sensorTypes` (배열, 다중 선택)
  - `contact` — `ContactSensor` (열림/닫힘)
  - `motion` — `MotionSensor` (동작 감지)
  - `occupancy` — `OccupancySensor` (점유 감지)
- `triggerMode` (배열, 다중 선택)
  - `onCompletion` — 운전이 끝나는 순간 **약 10초간 활성** 후 자동으로 해제 (펀스)
  - `duringRun` — 운전 중에는 계속 활성, 정지 시 비활성
- `sensorPollInterval` (정수, 기본 30초, 최소 5초)

### 동작

- `onCompletion`: 직전 상태가 `active`였다가 `inactive`로 바뀌는 순간 센서를 트리거
  - Contact → `open`, Motion → `detected`, Occupancy → `occupied`
  - 약 10초 후 자동 해제
- `duringRun`: 운전 중에는 활성, 정지 시 비활성
- 각 센서는 별도 액세서리로 노출됩니다.
  예: `세탁기 - 종료 알림 (접촉)`, `세탁기 - 운전 중 (모션)`

### HomeKit 자동화 예시

| 시나리오 | 트리거 | 동작 |
| --- | --- | --- |
| 세탁 완료 시 거실 조명 깜빡임 | "세탁기 - 종료 알림 (접촉)"이 열리면 | 거실 조명 On → 1분 후 Off |
| 건조기 운전 중 환풍기 켜기 | "건조기 - 운전 중 (점유)"이 점유 감지되면 | 환풍기 On |
| 건조 완료 시 알림 | "건조기 - 종료 알림 (모션)"에서 동작 감지되면 | 알림 전송 |

> HomeKit은 ContactSensor의 *열림* 이벤트를 강력한 푸시 트리거로 사용할 수 있어, "운전 종료 즉시 폰 알림"이 필요한 경우 `contact` + `onCompletion` 조합을 권장합니다.

---

## 구형 에어컨 (legacyAc) 참고

- 인증서 경로(`certPath`/`keyPath`)를 비워두면 패키지에 포함된 `cert/cert.pem`을 사용합니다.
- `swingModeType`은 모델에 따라 `comfort`(무풍/쿠적) 또는 `wind`(상하 스윈) 중 선택.
- TLSv1 / `DEFAULT@SECLEVEL=0`은 구형 펌웨어 호환을 위해 의도적으로 사용합니다.

---

## 마이그레이션 가이드

기존 3개 플러그인을 사용 중이라면, 본 플러그인 설치 후:

1. 기존 플러그인의 platform 블록을 `config.json`에서 제거합니다.
2. 본 플러그인(`SmartThingsKM81`) 블록을 추가하고 `devices` 배열에 항목별 `deviceType`을 명시합니다.
3. 기존 토큰 파일(`smartthings_ac_token.json`, `smartthings_washer_token.json`)이 있더라도 사용하지 않습니다. 본 플러그인은 새 OAuth 흐름으로 `smartthings_km81_token.json`을 새로 발급합니다.
4. Homebridge 재시작 → 인증 URL 접속 → 권한 허용 → 재시작.

---

## 라이선스

MIT © Km81
