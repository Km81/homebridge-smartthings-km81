# homebridge-smartthings-km81

삼성 가전 3종 — **구형 에어컨**(로컬 TLS), **신형 에어컨**·**세탁기/건조기**(SmartThings 클라우드) — 을 하나의 Homebridge 플랫폼으로 통합하는 플러그인입니다.

기존에 나뉘어 있던 세 플러그인을 대체합니다.

| 대체 대상 | 역할 |
| --- | --- |
| `homebridge-samsung-ac` | 구형 에어컨 (TLSv1 직접 통신) |
| `homebridge-smartthings-ac-km81` | 신형 에어컨 (SmartThings API) |
| `homebridge-smartthings-washer` | 세탁기 / 건조기 (SmartThings API) |

---

## 목차

1. [특징](#특징)
2. [설치](#설치)
3. [기기 종류](#기기-종류)
4. [빠른 시작](#빠른-시작)
5. [신형 에어컨·세탁기·건조기 — SmartThings OAuth 설정](#신형-에어컨세탁기건조기--smartthings-oauth-설정)
6. [구형 에어컨 — 설정](#구형-에어컨--설정)
7. [세탁기 / 건조기 종료 알림](#세탁기--건조기-종료-알림)
8. [전체 설정 예시](#전체-설정-예시)
9. [동작·안정성 참고](#동작안정성-참고)
10. [기존 플러그인에서 이전](#기존-플러그인에서-이전)
11. [보안 주의](#보안-주의)

---

## 특징

- **하나의 플랫폼**에서 구형 에어컨 + 신형 에어컨 + 세탁기 + 건조기를 함께 관리
- SmartThings 기기는 **OAuth 토큰 하나**(`smartthings_km81_token.json`)를 공유 — 자동 갱신
- 구형 에어컨은 로컬 TLSv1(`SECLEVEL=0`) 직접 통신 — 클라우드 없이 동작, Homebridge 2.0 호환
- 구형 에어컨의 HomeKit '냉방' 버튼이 보낼 실제 모드(냉방/제습/청정 등)를 드롭다운으로 선택, 무풍·자동건조를 스윙·잠금 토글에 매핑
- 세탁기/건조기 종료 시 iOS 푸시 **1회**를 보내는 모션 센서(선택)
- 구형 에어컨의 느린 펌웨어를 위한 전원 안정화·명령 직렬화·상태 파일 브릿지 내장

---

## 설치

```shell
npm install -g homebridge-smartthings-km81
```

또는 Homebridge UI의 플러그인 탭에서 `homebridge-smartthings-km81`을 검색해 설치합니다. 설정은 UI의 설정 화면에서 하는 것을 권장합니다(아래 예시는 `config.json`을 직접 편집하는 경우의 참고용).

---

## 기기 종류

`devices` 배열의 각 항목에 `deviceType`을 지정합니다. UI는 선택한 타입에 필요한 필드만 표시합니다.

| `deviceType` | 대상 | 통신 방식 |
| --- | --- | --- |
| `legacyAc` | 구형 삼성 에어컨 | 로컬 TLSv1 (포트 8888) |
| `smartAc` | 신형 삼성 에어컨 | SmartThings 클라우드 |
| `washer` | 세탁기 | SmartThings 클라우드 |
| `dryer` | 건조기 | SmartThings 클라우드 |

> `smartAc` · `washer` · `dryer` 중 하나라도 있으면 SmartThings OAuth 설정(`clientId` / `clientSecret` / `redirectUri`)이 필요합니다. 구형 에어컨(`legacyAc`)만 쓴다면 OAuth 설정은 필요 없습니다.

---

## 빠른 시작

- **구형 에어컨만** 쓸 경우 → [구형 에어컨 설정](#구형-에어컨--설정)으로 바로 이동(OAuth 불필요).
- **신형 에어컨·세탁기·건조기**가 있으면 → 먼저 [SmartThings OAuth 설정](#신형-에어컨세탁기건조기--smartthings-oauth-설정)을 1회 완료한 뒤, 각 기기를 `devices`에 추가합니다.

---

## 신형 에어컨·세탁기·건조기 — SmartThings OAuth 설정

SmartThings는 리다이렉트 주소로 **포트 없는 `https`(443)** 만 허용합니다. 따라서 외부 `https://<도메인>` 요청을 내부 Homebridge(포트 **8999**)로 넘겨주는 **리버스 프록시**가 필요합니다. 이 설정은 최초 1회만 하면 됩니다.

### 1단계 · 리버스 프록시 (HTTPS 443 → 내부 8999)

| 구분 | 주소 | 비고 |
| --- | --- | --- |
| 외부 (SmartThings 등록용) | `https://<도메인>` | 포트 없음(443 고정) |
| 내부 (플러그인 수신) | `http://<homebridge_ip>:8999` | 포트 8999 고정 |

> ⚠️ 리다이렉트 주소에 포트를 붙이면(`https://<도메인>:9001`) SmartThings가 거부합니다. 외부에서 443으로 접속 가능한 `https://<도메인>` 형태여야 합니다.

Nginx Proxy Manager · Synology/UGREEN NAS 내장 리버스 프록시 · Caddy 등 무엇이든 됩니다. 예:

<details>
<summary><b>Nginx Proxy Manager</b></summary>

1. **Proxy Hosts → Add Proxy Host**
2. **Details**: Domain `<도메인>` / Scheme `http` / Forward IP `<homebridge_ip>` / Forward Port `8999` / Block Common Exploits ✅
3. **SSL**: `Request a new SSL Certificate (Let's Encrypt)` / Force SSL ✅ / HTTP/2 ✅ → Save
</details>

<details>
<summary><b>Synology NAS</b></summary>

1. 제어판 → 로그인 포털 → 고급 → 리버스 프록시 → **생성**
2. 소스: `HTTPS` / `<도메인>` / 포트 `443`
3. 대상: `HTTP` / `<homebridge_ip>` / 포트 `8999`
</details>

사전 확인: 라우터의 외부 443 → NAS 443 포워딩, DDNS가 현재 공인 IP를 가리킴, SSL 인증서 유효(Let's Encrypt 자동 갱신 권장).

### 2단계 · OAuth-In SmartApp 생성

SmartThings CLI로 앱을 만듭니다.

```bash
npm install -g @smartthings/cli

# https://account.smartthings.com/tokens 에서 PAT(개인 액세스 토큰)를 발급받아 아래에 넣습니다.
export SMARTTHINGS_TOKEN="<발급받은_PAT>"

smartthings apps:create
```

대화형 프롬프트 입력값:

| 항목 | 입력 |
| --- | --- |
| What kind of app | `OAuth-In App` |
| Display Name / Description | 자유(예: `Homebridge SmartThings`) |
| Icon Image URL / Target URL | (엔터로 건너뜀) |
| Select Scopes | 스페이스바로 `r:devices:*`, `w:devices:*`, `x:devices:*` 선택 후 엔터 |
| Redirect URIs | `Add Redirect URI` → **`https://<도메인>`** (1단계 외부 주소, 포트 없이) → `Finish editing` |
| Choose an action | `Finish and create OAuth-In SmartApp` |

생성 직후 출력되는 **`OAuth Client Id`** 와 **`OAuth Client Secret`** 을 즉시 복사해 둡니다(다시 볼 수 없습니다).

### 3단계 · Homebridge에 입력 후 인증

플랫폼 설정(또는 `config.json`)에 아래를 넣고 Homebridge를 재시작합니다.

- `clientId` — 발급받은 OAuth Client Id
- `clientSecret` — 발급받은 OAuth Client Secret
- `redirectUri` — 2단계에서 넣은 값과 **정확히 동일**(`https://<도메인>`)

재시작하면 로그에 인증 URL이 출력됩니다.

1. 로그의 인증 URL을 브라우저로 열기 → SmartThings 로그인 → 위치 선택 → **인증**
2. `https://<도메인>/?code=...` 로 리다이렉트 → 리버스 프록시가 내부 8999로 전달 → 토큰이 `smartthings_km81_token.json`에 저장
3. 로그에 토큰 발급 완료 메시지 확인 후 Homebridge를 한 번 더 재시작하면 기기가 추가됩니다.

> SmartThings가 앱 등록 시 보내는 webhook 핸드셰이크(CONFIRMATION)도 같은 8999 포트가 자동 처리합니다.

---

## 구형 에어컨 — 설정

구형 에어컨은 클라우드가 아니라 **집 안 네트워크에서 기기와 직접(로컬 TLS)** 통신합니다. 이를 위해 에어컨의 **기기 인증 토큰**이 한 번 필요합니다.

### 토큰 추출 (1회)

에어컨은 최초 Wi-Fi 연결 시 삼성 클라우드(`api.smartthings.com`)로 자신의 토큰을 담아 접속합니다. 그 접속을 **내 컴퓨터로 유도**해 토큰을 확인합니다.

> 준비물: Python 3 + OpenSSL이 있는 컴퓨터(NAS/라즈베리파이/맥 등), 공유기 관리자 접근 권한, 에어컨을 Wi-Fi 설정 모드로 다시 연결할 준비.

**① 임시 서버 스크립트** — 아래를 `fake_server.py`로 저장합니다.

```python
#!/usr/bin/env python3
import ssl, socket, os, threading

LISTEN_IP, HTTPS_PORT = '0.0.0.0', 443
CERT_FILE, KEY_FILE = 'temp_server_cert.pem', 'temp_server_key.pem'

def ensure_cert():
    if not (os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE)):
        os.system(f'openssl req -new -newkey rsa:2048 -days 365 -nodes -x509 '
                  f'-keyout {KEY_FILE} -out {CERT_FILE} -subj "/CN=api.smartthings.com"')

def handle(conn, addr):
    print(f">>> 연결 수립: {addr}")
    try:
        while True:
            data = conn.recv(8192)
            if not data:
                break
            text = data.decode('utf-8', errors='ignore')
            for line in text.splitlines():
                if 'authorization' in line.lower():
                    print("\n**** 토큰 발견 ****")
                    print("추출된 토큰:", line.split(' ')[-1])
                    print("이 값을 Homebridge의 구형 에어컨 '토큰' 필드에 입력하세요.\n")
            conn.sendall(b'HTTP/1.1 200 OK\r\n\r\n')
    except Exception as e:
        print("오류:", e)
    finally:
        conn.close()

def main():
    ensure_cert()
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((LISTEN_IP, HTTPS_PORT)); s.listen(5)
        print(f"가짜 클라우드 서버 시작(포트 {HTTPS_PORT}). 에어컨을 Wi-Fi 설정 모드로 연결하세요.")
        while True:
            conn, addr = s.accept()
            tls_conn = ctx.wrap_socket(conn, server_side=True)  # TLS 핸드셰이크
            threading.Thread(target=handle, args=(tls_conn, addr)).start()

if __name__ == '__main__':
    try:
        main()
    except PermissionError:
        print("443 포트는 root 권한이 필요합니다: sudo python3 fake_server.py")
    except KeyboardInterrupt:
        print("종료")
    finally:
        for f in (CERT_FILE, KEY_FILE):
            if os.path.exists(f):
                os.remove(f)
```

**② DNS 유도** — 공유기 관리자에서 정적 DNS(호스트 매핑)를 추가합니다.

- 호스트: `api.smartthings.com`
- IP: `fake_server.py`를 실행할 컴퓨터의 내부 IP

**③ 추출 실행**

```bash
sudo python3 fake_server.py
```

에어컨을 **Wi-Fi 설정 모드**로 바꾸고 SmartThings 앱에서 네트워크 연결을 진행하면, 터미널에 `추출된 토큰: ...` 이 출력됩니다. 이 값을 구형 에어컨의 **토큰** 필드에 입력합니다.

**④ DNS 원복 (필수)** — 추출이 끝나면 ②에서 추가한 정적 DNS 규칙을 **반드시 삭제**하세요. 남겨두면 인터넷 사용에 문제가 생기고 에어컨이 계속 가짜 서버로 접속합니다.

> 🔒 이 토큰은 집 안 네트워크에서 기기를 제어하는 값입니다. 공개된 곳(코드 저장소·이슈·스크린샷)에 올리지 마세요.

### HomeKit 모드 매핑

구형 에어컨은 HomeKit에 **'냉방(Cool)' 단일 모드**만 노출하고, 그 버튼이 실제로 보낼 명령을 아래 필드로 정합니다(난방·자동 버튼은 노출하지 않습니다).

| 필드 | 설명 | 기본값 |
| --- | --- | --- |
| `hkCoolMode` | '냉방' 버튼이 보낼 실제 모드 | `"Cool"` |
| `legacySwingBinding` | 스윙 토글에 매핑할 기능 | `"comfort"` |
| `legacyLockBinding` | 잠금 토글에 매핑할 기능 | `"autoClean"` |

- `hkCoolMode`: `Cool`(냉방) · `CoolClean`(냉방청정) · `Dry`(제습) · `DryClean`(제습청정)
- `legacySwingBinding`: `comfort`(무풍) · `wind`(상하 바람) · `none`(토글 숨김)
- `legacyLockBinding`: `autoClean`(자동건조) · `none`(토글 숨김)

### 구형 에어컨 필드

| 필드 | 설명 | 기본값 |
| --- | --- | --- |
| `name` | HomeKit 표시 이름 | — |
| `ip` | 에어컨의 로컬 IP | — |
| `token` | 위에서 추출한 기기 토큰 | — |
| `pollingInterval` | 상태 폴링 주기(초). `0`이면 폴링 끔 | `10` |
| `timeout` | 요청 타임아웃(ms) | `5000` |
| `hkCoolMode` / `legacySwingBinding` / `legacyLockBinding` | 위 [모드 매핑](#homekit-모드-매핑) 참조 | — |
| `legacyOnGuardMs` / `legacyOnGuardStrategy` | 전원 ON 안정화([아래](#구형-에어컨-전원-안정화)) | `2000` / `drop` |
| `resendModeOnPowerOn` / `resendAutoCleanOnPowerOn` / `powerOnResendStepMs` | 전원 ON 후 모드·자동건조 재적용([아래](#구형-에어컨-전원-안정화)) | `false` / `false` / `2000` |
| `deviceIndex` / `setDeviceIndex` | 한 본체에 여러 `Devices[N]`가 있는 모델에서 읽기/쓰기 인덱스 | `0` |
| `certPath` / `keyPath` | 클라이언트 인증서 경로(비우면 내장 `cert/cert.pem` 사용) | 내장 |
| `stateDumpFile` | 상태를 JSON 파일로 덤프(외부 연동용, [아래](#상태-파일-브릿지-statedumpfile)) | 끔 |

---

## 세탁기 / 건조기 종료 알림

세탁·건조가 끝나는 순간 **iOS 푸시 1회**를 받기 위한 가상 **모션 센서**를 별도 액세서리로 노출합니다(HomeKit 자동화 트리거로도 사용 가능).

| 필드 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `enableNotificationSensor` | boolean | `false` | 종료 알림 모션 센서 활성화 |
| `sensorName` | string | `"{기기명} 종료알림"` | 모션 센서 표시 이름 |
| `sensorPollInterval` | integer | `30` (최소 5) | 종료 감지용 폴링 주기(초) |

**동작** — 운전이 `active` → `inactive`로 바뀌는 순간 모션을 감지시키고 약 10초 뒤 자동 해제합니다. iOS는 모션이 `false→true`로 바뀔 때만 알림을 보내므로 **종료 시 정확히 1회**만 도착합니다(접촉/점유 센서는 양방향이라 2회 발송됨).

**설정 방법**

1. 세탁기/건조기에 `enableNotificationSensor: true` (+ 선택 `sensorName`)
2. Homebridge 재시작 → 모션 센서 액세서리 생성
3. iOS 홈 앱 → 해당 모션 센서 → **"센서 활동 알림" 켜기**
4. 운전 종료 시 푸시 도착

---

## 전체 설정 예시

> 아래 값은 모두 예시 자리표시자입니다. 실제 토큰·도메인·IP로 바꿔 넣으세요.

```jsonc
{
  "platform": "SmartThingsKM81",
  "name": "SmartThings KM81",

  // SmartThings 기기(smartAc/washer/dryer)가 있을 때만 필요
  "clientId": "<OAUTH_CLIENT_ID>",
  "clientSecret": "<OAUTH_CLIENT_SECRET>",
  "redirectUri": "https://<도메인>",

  "temperatureMin": 18,
  "temperatureMax": 30,

  "devices": [
    {
      "deviceType": "legacyAc",
      "name": "거실 에어컨",
      "ip": "<에어컨_IP>",
      "token": "<에어컨_토큰>",
      "pollingInterval": 10,
      "hkCoolMode": "DryClean",
      "legacySwingBinding": "comfort",
      "legacyLockBinding": "autoClean",
      "resendModeOnPowerOn": true,
      "resendAutoCleanOnPowerOn": true,
      "powerOnResendStepMs": 4000,
      "legacyOnGuardMs": 4000
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
      "enableNotificationSensor": true,
      "sensorName": "세탁기 종료알림"
    },
    {
      "deviceType": "dryer",
      "deviceLabel": "건조기",
      "enableNotificationSensor": true,
      "sensorName": "건조기 종료알림"
    }
  ]
}
```

---

## 동작·안정성 참고

구형 에어컨 펌웨어는 오래돼 응답이 느리고 한 번에 하나의 연결만 처리합니다. 아래 동작들은 그 특성에 대응하기 위한 것으로, 대부분 자동으로 작동합니다.

### 구형 에어컨 전원 안정화

전원을 켠 직후 짧은 시간 안에 여러 명령(모드/온도/스윙)이 몰리면 구형 펌웨어가 일부를 놓칩니다. 이를 두 가지로 다룹니다.

**① 보호 윈도우** — 전원 ON 직후 다른 명령을 잠시 가로챕니다.

| 필드 | 기본값 | 의미 |
| --- | --- | --- |
| `legacyOnGuardMs` | `2000` | ON 직후 보호 시간(ms). `0`이면 끔 |
| `legacyOnGuardStrategy` | `"drop"` | `drop` = 보호 중 명령 무시 / `queue` = 보호 종료 후 마지막 값 1회 전송 |

- 손으로 전원만 켜고 온도·스윙은 따로 조작 → `drop`(기본)이 안전.
- Siri/자동화로 "켜고 26도" 같은 일괄 동작을 쓴다면 → `queue`.

**② 켠 뒤 설정 재적용(선택)** — 전원 ON 이후 원하는 모드와 자동건조를 순차로 다시 보냅니다. 켤 때마다 항상 원하는 상태(예: 제습청정 + 자동건조)로 시작하게 합니다.

| 필드 | 기본값 | 의미 |
| --- | --- | --- |
| `resendModeOnPowerOn` | `false` | 전원 ON 후 `hkCoolMode`를 재전송 |
| `resendAutoCleanOnPowerOn` | `false` | 이어서 자동건조 ON을 재전송 |
| `powerOnResendStepMs` | `2000` | 각 단계 사이 간격(ms). 반응이 느린 기기는 `4000` 권장 |

### 끄기 자동화 보호

HomeKit의 "끄기" 자동화/장면은 전원 끄기와 함께 저장된 모드·온도·스윙 값을 같이 보냅니다. 이 뒤따르는 값들이 방금 끈 기기를 되켜지 않도록, 끈 직후 짧은 창 동안 형제 명령을 억제합니다. 끄기 명령이 네트워크 오류로 실패하면 잠시 뒤 1회 다시 시도합니다. (구형·신형 에어컨 모두 적용, 자동 동작)

### 명령 신뢰성

- 같은 기기(구형 에어컨)를 보는 액세서리들이 연결을 공유하고 모든 요청을 순서대로 처리해 동시 접속 충돌을 막습니다.
- 상태 조회는 짧은 시간 내 결과를 공유해 기기 부하를 줄이고, 명령을 보낸 직후에는 항상 실제 상태를 다시 읽습니다.
- 일시적 네트워크 오류는 조회를 자동 재시도합니다(제어 명령은 중복 실행을 피하기 위해 안전한 경우에만 재시도).

### 상태 파일 브릿지 (`stateDumpFile`)

구형 에어컨 상태를 JSON 파일로 계속 기록해, 다른 시스템(예: 홈 오토메이션 대시보드)이 기기를 직접 폴링하지 않고 이 파일만 읽게 할 수 있습니다. 경로를 지정하면 켜지고, 비우면 아무 파일도 쓰지 않습니다.

---

## 기존 플러그인에서 이전

1. `config.json`에서 기존 3개 플러그인의 platform 블록을 제거합니다.
2. 본 플러그인(`SmartThingsKM81`) 블록을 추가하고 `devices`에 항목별 `deviceType`을 지정합니다.
3. 기존 토큰 파일(`smartthings_ac_token.json` 등)은 사용하지 않습니다 — 본 플러그인이 새 OAuth 흐름으로 `smartthings_km81_token.json`을 발급합니다.
4. Homebridge 재시작 → (SmartThings 기기가 있으면) 인증 URL 접속 → 권한 허용 → 재시작.

구버전에서 넘어올 때, 더 이상 쓰지 않는 옛 필드(예: `hkCoolModes[]` 배열, `sensorTypes`/`triggerMode` 등)는 설정에 남아 있어도 무시됩니다.

---

## 보안 주의

- 구형 에어컨의 **기기 토큰**과 SmartThings **Client Id/Secret**은 비밀 값입니다. 저장소·이슈·스크린샷·로그 공유 시 노출되지 않도록 주의하세요.
- 구형 에어컨 통신은 호환성을 위해 구식 TLSv1을 사용합니다 — 신뢰할 수 있는 홈 네트워크 안에서만 사용하세요.

---

## 라이선스

MIT
