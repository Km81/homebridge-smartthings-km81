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

SmartThings의 보안 정책상 **Redirect URI는 `https` 프로토콜이어야 하며, 별도 포트를 적을 수 없습니다** (즉 기본 443 포트만 허용). 따라서 외부에서 `https://<나의도메인>` 으로 접속할 수 있는 환경을 만들고, 이를 내부 Homebridge의 `http://<homebridge_ip>:8999` 로 전달해주는 **리버스 프록시(Reverse Proxy)** 설정이 필수입니다.

### 1단계: 리버스 프록시 설정 (HTTPS → 내부 8999)

가장 먼저 외부에서 접속 가능한 `https` 주소를 준비해야 합니다. **Synology NAS의 리버스 프록시**, **UGreen NAS**, **Nginx Proxy Manager(NPM)**, **Caddy** 등 어떤 도구든 사용 가능합니다.

#### 리버스 프록시 개념

| 구분 | 주소 | 비고 |
|---|---|---|
| 외부 주소 (SmartThings 등록용) | `https://<나의도메인>` | **포트 없음** (443 고정) |
| 내부 주소 (플러그인이 듣는 곳) | `http://<homebridge_ip>:8999` | 포트 `8999` 고정 |

> ⚠️ Redirect URI에 `https://myhome.com:9001` 처럼 **포트를 붙이면 SmartThings가 거부**합니다. 반드시 `https://myhome.com` 형태로, 외부에서 443 포트로 접속 가능해야 합니다.

#### 설정 예시 (Nginx Proxy Manager 기준)

1. NPM 관리 UI → **Proxy Hosts** → **Add Proxy Host**
2. **Details** 탭:
   - Domain Names: `myhome.example.com` (본인 도메인)
   - Scheme: `http`
   - Forward Hostname / IP: Homebridge 머신의 내부 IP (예: `192.168.1.10`)
   - Forward Port: `8999`
   - Block Common Exploits: ✅
   - Websockets Support: ✅ (선택)
3. **SSL** 탭:
   - SSL Certificate: `Request a new SSL Certificate (Let's Encrypt)` 선택
   - Force SSL: ✅
   - HTTP/2 Support: ✅
   - 본인 이메일 입력 후 약관 동의 → **Save**

#### 설정 예시 (Synology NAS 기준)

1. 제어판 → 로그인 포털 → 고급 → 리버스 프록시 → **생성**
2. 소스: 프로토콜 `HTTPS`, 호스트 `myhome.example.com`, 포트 `443`
3. 대상: 프로토콜 `HTTP`, 호스트 `<homebridge_ip>`, 포트 `8999`

#### 사전 체크

- 라우터에서 외부 443 포트가 NAS의 443 포트로 포워딩되어 있어야 함
- DDNS가 현재 공인 IP를 가리키고 있어야 함
- SSL 인증서가 만료되지 않았어야 함 (Let's Encrypt 자동 갱신 권장)

### 2단계: SmartThings OAuth 앱 생성 (CLI 방식)

#### 2-1. SmartThings CLI 설치

```bash
npm install -g @smartthings/cli
```

#### 2-2. 개인용 액세스 토큰(PAT) 발급

1. https://account.smartthings.com/tokens 접속
2. **Generate new token** 클릭
3. 모든 권한(scope) 체크 → 생성
4. 표시되는 토큰 값을 복사 (페이지를 떠나면 다시 못 봅니다)

#### 2-3. CLI 인증

```bash
# "YOUR_PAT_TOKEN" 부분을 위에서 복사한 토큰으로 교체
export SMARTTHINGS_TOKEN="YOUR_PAT_TOKEN"
```

#### 2-4. OAuth-In SmartApp 생성

```bash
smartthings apps:create
```

대화형 프롬프트에 다음과 같이 입력:

| 항목 | 입력값 |
|---|---|
| What kind of app | `OAuth-In App` |
| Display Name | `Homebridge SmartThings KM81` (자유) |
| Description | `Homebridge SmartThings KM81` (자유) |
| Icon Image URL | (엔터로 넘김) |
| Target URL | (엔터로 넘김) |
| Select Scopes | 스페이스바로 다음 3개 모두 선택 후 엔터:<br>`r:devices:*`<br>`w:devices:*`<br>`x:devices:*` |
| Add or edit Redirect URIs | `Add Redirect URI` 선택 |
| Redirect URI | **`https://myhome.example.com`** (1단계의 외부 주소, **포트 없이**) |
| Add or edit Redirect URIs | `Finish editing Redirect URIs` 선택 |
| Choose an action | `Finish and create OAuth-In SmartApp` 선택 |

생성 완료 후 출력되는 **`OAuth Client Id`** 와 **`OAuth Client Secret`** 을 반드시 즉시 복사해 저장하세요. 다시 볼 수 없습니다.

### 3단계: Homebridge 설정에 입력

Homebridge UI 또는 `config.json`의 플러그인 블록에 다음을 입력:

- `clientId`: 위에서 발급받은 OAuth Client Id
- `clientSecret`: 위에서 발급받은 OAuth Client Secret
- `redirectUri`: **2-4에서 입력한 것과 정확히 동일한 값** (예: `https://myhome.example.com`)

Homebridge 재시작.

### 4단계: 권한 허용

1. Homebridge 로그에 인증 URL이 표시됩니다 (예시):
   ```
   인증 URL: https://api.smartthings.com/oauth/authorize?client_id=...&scope=...&redirect_uri=https%3A%2F%2Fmyhome.example.com
   ```
2. 해당 URL을 브라우저로 열어 SmartThings 로그인 → 위치 선택 → **인증** 클릭
3. 자동으로 `https://myhome.example.com/?code=...` 로 리다이렉트 → 리버스 프록시 통해 내부 8999 포트로 전달 → 플러그인이 토큰을 발급받아 `smartthings_km81_token.json`에 저장
4. 로그에 `최초 토큰 발급 완료!` 메시지 확인
5. Homebridge를 한 번 더 재시작하면 장치가 추가됩니다.

> Webhook lifecycle CONFIRMATION 요청(SmartThings가 처음 앱 등록할 때 보내는 핸드셰이크)도 같은 8999 포트의 서버가 자동 처리합니다.

---

## 설정 예시 (config.json)

```jsonc
{
  "platform": "SmartThingsKM81",
  "name": "SmartThings KM81",

  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "redirectUri": "https://myhome.example.com",

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
- 각 센서는 별도 액세서리로 노출됩니다 (HomeKit 이름 정책상 `-` 와 `()` 같은 특수문자를 쓰지 않습니다).
  예: `세탁기 종료알림 접촉`, `세탁기 운전중 모션`

### HomeKit 자동화 예시

| 시나리오 | 트리거 | 동작 |
| --- | --- | --- |
| 세탁 완료 시 거실 조명 깜빡임 | "세탁기 종료알림 접촉"이 열리면 | 거실 조명 On → 1분 후 Off |
| 건조기 운전 중 환풍기 켜기 | "건조기 운전중 점유"이 점유 감지되면 | 환풍기 On |
| 건조 완료 시 알림 | "건조기 종료알림 모션"에서 동작 감지되면 | 알림 전송 |

> HomeKit은 ContactSensor의 *열림* 이벤트를 강력한 푸시 트리거로 사용할 수 있어, "운전 종료 즉시 폰 알림"이 필요한 경우 `contact` + `onCompletion` 조합을 권장합니다.

---

## 구형 에어컨 (legacyAc) 참고

- 인증서 경로(`certPath`/`keyPath`)를 비워두면 패키지에 포함된 `cert/cert.pem`을 사용합니다.
- `swingModeType`은 모델에 따라 `comfort`(무풍) 또는 `wind`(상하 바람) 중 선택.
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
