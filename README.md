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
- **NEW (v1.1.0)**: 구형 에어컨 HomeKit↔모드 매핑 (전원 ON 시 자동 적용, CoolClean/DryClean 등 지원)
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
      "pollingInterval": 60,
      "hkCoolEnabled": true,
      "hkCoolModes": ["DryClean"],
      "hkCoolOptions": ["Comode_Nano"],
      "hkHeatEnabled": false,
      "hkAutoEnabled": false,
      "powerOnHkMode": "cool"
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
  - `onCompletion` — 운전이 끝나는 순간 **약 10초간 활성** 후 자동으로 해제 (펄스)
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

## 구형 에어컨 (legacyAc) 토큰 추출 가이드

`legacyAc` 장치를 사용하려면 에어컨의 **고유 인증 토큰**이 필요합니다. 토큰은 **DNS 스푸핑(Spoofing)** 기법으로, 에어컨이 삼성 클라우드(`api.smartthings.com`)와 통신하는 내용을 중간에서 가로채어 추출합니다.

> ⚠️ 사전 준비물
> - Homebridge가 설치된 컴퓨터(NAS / 라즈베리파이 / Mac 등) — Python 3 + OpenSSL 필요
> - 공유기 관리자 페이지 접근 권한 (정적 DNS 설정 변경용)
> - 에어컨을 Wi-Fi 설정 모드로 다시 연결할 준비

### 1단계: 가짜 서버 스크립트 준비

아래 Python 코드를 `fake_server.py` 라는 이름으로 컴퓨터에 저장합니다.

```python
#!/usr/bin/env python3
import ssl
import socket
import os
import threading

LISTEN_IP = '0.0.0.0'
HTTPS_PORT = 443
CERT_FILE = 'temp_server_cert.pem'
KEY_FILE = 'temp_server_key.pem'

def generate_self_signed_cert(cert_file, key_file):
    if not (os.path.exists(cert_file) and os.path.exists(key_file)):
        print(f"임시 서버 인증서 '{cert_file}' 및 '{key_file}' 생성 중...")
        subj = "/CN=api.smartthings.com"
        os.system(f'openssl req -new -newkey rsa:2048 -days 365 -nodes -x509 -keyout {key_file} -out {cert_file} -subj "{subj}"')
    print("임시 서버 인증서 준비 완료.")

def handle_client(conn, addr):
    print(f"\n>>> [연결 수립] From: {addr}")
    try:
        while True:
            data = conn.recv(8192)
            if not data:
                break
            decoded_data = data.decode('utf-8', errors='ignore')
            print("\n" + "="*20 + " 데이터 수신 " + "="*20)
            print(decoded_data)
            for line in decoded_data.splitlines():
                if 'authorization' in line.lower():
                    print("\n" + "*"*20 + " 토큰 발견 " + "*"*20)
                    token = line.split(' ')[-1]
                    print(f"추출된 토큰: {token}")
                    print("*"*56)
                    print("이 토큰을 복사하여 Homebridge 설정에 사용하세요.")
            conn.sendall(b'HTTP/1.1 200 OK\r\n\r\n')
    except Exception as e:
        print(f"[오류] 클라이언트 처리 중 오류: {e}")
    finally:
        print(f"<<< [연결 종료] From: {addr}")
        conn.close()

def main():
    generate_self_signed_cert(CERT_FILE, KEY_FILE)
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((LISTEN_IP, HTTPS_PORT))
        sock.listen(5)
        print("\n" + "="*50)
        print(f"가짜 삼성 클라우드 서버가 시작되었습니다. (포트: {HTTPS_PORT})")
        print("이제 에어컨을 Wi-Fi 설정 모드로 변경하고, SmartThings 앱으로 연결을 시도하세요.")
        print("="*50)
        while True:
            conn, addr = sock.accept()
            threading.Thread(target=handle_client, args=(conn, addr)).start()

if __name__ == '__main__':
    try:
        main()
    except PermissionError:
        print("\n[오류] 443 포트를 사용하려면 root 권한이 필요합니다. 'sudo python3 fake_server.py'로 실행해주세요.")
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
    finally:
        if os.path.exists(CERT_FILE): os.remove(CERT_FILE)
        if os.path.exists(KEY_FILE): os.remove(KEY_FILE)
```

### 2단계: DNS 스푸핑 설정 (가장 중요)

1. `fake_server.py`를 실행할 컴퓨터의 **내부 IP 주소**를 확인합니다 (예: `192.168.1.10`).
2. 공유기 관리자 페이지(보통 `192.168.0.1` 또는 `192.168.1.1`)에 접속.
3. **'정적 DNS'**, **'DNS 호스트 이름'** 같은 메뉴 찾기 (공유기마다 명칭이 다름).
4. 아래 항목으로 정적 DNS 규칙 추가:
   - **호스트 이름**: `api.smartthings.com`
   - **IP 주소**: 위 1번에서 확인한 컴퓨터 IP (예: `192.168.1.10`)

이렇게 하면 에어컨이 `api.smartthings.com`을 우리 컴퓨터로 인식합니다.

### 3단계: 토큰 추출 실행

1. 터미널에서 root 권한으로 가짜 서버 실행 (443 포트 필요):
   ```bash
   sudo python3 fake_server.py
   ```
2. 에어컨을 **Wi-Fi 설정 모드**로 변경 → **SmartThings 앱**에서 네트워크 연결 절차 진행.
3. 에어컨이 Wi-Fi에 연결되면 우리 PC의 가짜 서버로 접속을 시도. 터미널에 다음과 같이 출력됩니다:
   ```
   ******************** 토큰 발견 ********************
   추출된 토큰: 8G7s7VTGGG
   ********************************************************
   ```
4. 이 토큰을 Homebridge UI에서 `legacyAc` 장치의 **인증 토큰** 필드에 입력합니다.

### 4단계: DNS 설정 원복 (필수)

토큰을 얻었으면 **반드시 2단계에서 추가한 정적 DNS 규칙을 삭제**해야 합니다. 그렇지 않으면 인터넷 사용에 문제가 생기거나 에어컨이 계속 가짜 서버로 접속하게 됩니다.

> 🔒 보안 경고: 이 통신은 오래된 TLSv1을 사용하므로 신뢰할 수 있는 로컬 네트워크에서만 사용하세요.

---

## HomeKit ↔ 구형 AC 모드 매핑 (legacyAc, v1.1.0+)

구형 삼성 에어컨은 단순 `Cool`/`Dry`/`Auto`/`Wind` 외에도 `CoolClean`(냉방청정), `DryClean`(제습청정) 같은 복합 모드를 지원합니다. HomeKit의 **냉방(Cool) / 난방(Heat) / 자동(Auto)** 버튼을 각각 어떤 실제 AC 모드로 매핑할지 자유롭게 지정할 수 있습니다.

### 설정 필드 (`legacyAc` 장치 단위)

| 필드 | 설명 | 기본값 |
|---|---|---|
| `hkCoolEnabled` | HomeKit '냉방' 표시 여부 | `true` |
| `hkCoolModes` | '냉방' 누를 때 보낼 AC modes (배열) | `["Cool"]` |
| `hkCoolOptions` | '냉방' 누를 때 함께 보낼 options | `[]` |
| `hkHeatEnabled` | HomeKit '난방' 표시 여부 | `false` |
| `hkHeatModes` | '난방' 누를 때 보낼 AC modes | `[]` |
| `hkHeatOptions` | '난방' 누를 때 함께 보낼 options | `[]` |
| `hkAutoEnabled` | HomeKit '자동' 표시 여부 | `false` |
| `hkAutoModes` | '자동' 누를 때 보낼 AC modes | `[]` |
| `hkAutoOptions` | '자동' 누를 때 함께 보낼 options | `[]` |
| `powerOnHkMode` | 전원 ON 시 자동 적용할 HomeKit 모드 | `"none"` |

### 사용 가능한 명령 문자열

`modes` 배열에 넣을 수 있는 값 (모델에 따라 일부 미지원):

| 문자열 | 의미 |
|---|---|
| `Cool` | 냉방 |
| `Dry` | 제습 |
| `Wind` | 송풍 / 공기청정 |
| `Auto` | 자동 (스마트 쾌적) |
| `CoolClean` | 냉방청정 |
| `DryClean` | 제습청정 |

`options` 배열에 넣을 수 있는 값:

| 문자열 | 의미 |
|---|---|
| `Comode_Nano` | 무풍 켜기 |
| `Comode_Off` | 무풍 끄기 |
| `Autoclean_On` | 자동건조 켜기 |
| `Autoclean_Off` | 자동건조 끄기 |

> `options`는 플래그라서 매번 명령을 보내야 켜지거나 꺼집니다. `Comode_Nano`를 hkCoolOptions에 넣어두면 HomeKit 냉방 버튼을 누를 때마다 무풍이 같이 켜집니다.

### 동작 방식

- HomeKit에서 모드 버튼을 누르면 해당 매핑의 `modes`(있으면) → `options`(있으면) 순서로 두 번 PUT 요청 전송.
- `enabled: false`인 모드는 HomeKit `validValues`에서 제외되어 버튼 자체가 안 보임.
- `powerOnHkMode`가 `cool`/`heat`/`auto` 중 하나면, 전원 ON 시 자동으로 해당 매핑 적용. `none`이면 그냥 전원만 켜고 직전 모드 유지.

### 설정 예시

**예시 A — 전원 ON 시 항상 "제습청정 + 무풍"으로 시작, HomeKit은 냉방만 노출**

```jsonc
{
  "deviceType": "legacyAc",
  "name": "거실 에어컨",
  "ip": "192.168.1.50",
  "token": "YOUR_TOKEN",

  "hkCoolEnabled": true,
  "hkCoolModes":   ["DryClean"],
  "hkCoolOptions": ["Comode_Nano"],

  "hkHeatEnabled": false,
  "hkAutoEnabled": false,

  "powerOnHkMode": "cool"
}
```

**예시 B — HomeKit 3개 버튼을 각각 다른 청정 모드로**

```jsonc
{
  "deviceType": "legacyAc",
  "name": "안방 에어컨",
  "ip": "192.168.1.51",
  "token": "YOUR_TOKEN",

  "hkCoolEnabled": true,
  "hkCoolModes":   ["CoolClean"],

  "hkHeatEnabled": true,
  "hkHeatModes":   ["DryClean"],

  "hkAutoEnabled": true,
  "hkAutoModes":   ["Auto"],

  "powerOnHkMode": "cool"
}
```

> 💡 HomeKit이 'Heat'를 난방으로 표시하지만, 실제로는 사용자가 원하는 어떤 모드든 매핑할 수 있습니다 (이름표일 뿐).

---

## 구형 에어컨 (legacyAc) 참고

- 인증서 경로(`certPath`/`keyPath`)를 비워두면 패키지에 포함된 `cert/cert.pem`을 사용합니다.
- `swingModeType`은 모델에 따라 `comfort`(무풍) 또는 `wind`(상하 바람) 중 선택.
- TLSv1 / `DEFAULT@SECLEVEL=0`은 구형 펌웨어 호환을 위해 의도적으로 사용합니다.
- `deviceIndex` / `setDeviceIndex`: 하나의 에어컨 본체에 여러 `Devices[N]` 엔트리가 있는 모델(예: 스탠드+벽걸이 결합)에서 어떤 인덱스를 읽고/쓸지 지정합니다. 기본값 `0`.

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
