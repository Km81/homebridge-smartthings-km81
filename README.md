# homebridge-smartthings-km81

삼성 에어컨·세탁기·건조기를 **HomeKit**에 연결하는 Homebridge 플러그인입니다.

가장 큰 특징은 **로컬 제어**입니다. 대부분의 기기를 SmartThings 클라우드를 거치지 않고 집 안 네트워크에서 직접 제어합니다. 인터넷이 끊겨도 동작하고, 반응이 빠르며, 클라우드 API 사용량에 영향을 받지 않습니다.

---

## 지원 기기

| 기기 | 통신 방식 | 클라우드 |
|---|---|---|
| 삼성 에어컨 (2016~2018년경, 2in1 포함) | 로컬 TCP 8888 | 불필요 |
| 삼성 에어컨 (2023년 이후) | 로컬 CoAP over DTLS | 선택 |
| 삼성 건조기 | 로컬 CoAP over DTLS 또는 클라우드 | 선택 |
| 삼성 세탁기 (2-in-1 포함) | 로컬 TCP 8888 또는 클라우드 | 선택 |

HomeKit에는 이렇게 보입니다.

- **에어컨** — 냉난방기 (전원·온도·모드·무풍·잠금)
- **세탁기·건조기** — 스프링클러 밸브(남은 시간 카운트다운) + 모션 센서(운전 종료 알림)

---

## 설치

Homebridge UI의 플러그인 검색에서 `homebridge-smartthings-km81`을 설치하거나:

```bash
npm install -g homebridge-smartthings-km81
```

설치 후 Homebridge UI의 플러그인 설정 화면에서 기기를 추가합니다. 모든 항목에 한국어 설명이 붙어 있습니다.

---

## 기기별 설정

### 구형 에어컨 (2016~2018년경)

`장치 종류`를 **구형 에어컨**으로 고르고 아래를 채웁니다.

| 항목 | 값 |
|---|---|
| 이름 | HomeKit에 표시할 이름 |
| 에어컨 IP | 공유기에서 고정 IP로 잡아두세요 |
| 인증 토큰 | [토큰 추출](#기기-토큰-추출하기) 참고 |

2in1(실외기 하나에 실내기 둘)은 **같은 IP로 항목을 두 개** 만들고 `장치 번호`만 다르게 두면 됩니다.

### 신형 에어컨·건조기 (2023년 이후)

`장치 종류`를 **신형 에어컨** 또는 **건조기**로 고릅니다.

- `전송 경로`를 **로컬**로 두고 `기기 IP`만 넣으면 됩니다. 포트는 자동으로 찾습니다.
- 토큰은 필요 없습니다. 인증서는 플러그인에 들어 있습니다.
- 로컬이 실패하면 클라우드로 넘어갑니다(끌 수 있습니다).

### 세탁기

`장치 종류`를 **세탁기**로 고릅니다.

- `전송 경로`를 **로컬**로 두고 `기기 IP`와 `기기 토큰`을 넣습니다. 토큰은 [아래](#기기-토큰-추출하기)에서 얻습니다.
- 토큰을 비워두면 클라우드로 동작합니다.
- **2-in-1**(애드워시+콤팩트워시)은 기본적으로 하나로 합쳐 보이고, 둘 중 하나만 돌아도 "가동 중"으로 표시합니다. `세탁조를 따로 표시`를 켜면 각각 별도 액세서리가 됩니다.

### SmartThings 클라우드를 쓸 때

로컬로 붙지 않는 기기, 또는 로컬 실패 시 폴백을 쓰려면 SmartThings OAuth가 필요합니다.

> 모든 기기를 로컬로 쓰고 폴백도 끈다면 이 과정은 **건너뛰어도 됩니다.**

#### 먼저 알아야 할 것 — Redirect URI는 반드시 `https`

SmartThings는 Redirect URI로 **`https://`만 받습니다.** `http://192.168.0.10:8999/callback` 같은 주소는 **등록 자체가 거부됩니다.**

그런데 이 플러그인이 띄우는 인증 서버는 **평문 HTTP, 포트 8999 고정**입니다. 그래서 둘을 이어 줄 것이 필요합니다.

```
SmartThings ──https──▶ 리버스 프록시 ──http──▶ 홈브릿지 :8999
             (인터넷)   (TLS 종료)              (인증 서버)
```

**리버스 프록시**(Nginx Proxy Manager, Caddy, Cloudflare Tunnel 등)로 도메인 하나를 8999로 넘기면 됩니다. 이미 홈브릿지 UI를 외부에서 https로 쓰고 있다면 같은 방식으로 하나 더 만들면 됩니다.

인증은 **한 번만** 하면 되므로, 프록시를 상시 두기 싫다면 인증할 때만 잠깐 열었다 닫아도 됩니다.

#### 절차

1. [SmartThings 개발자 워크스페이스](https://smartthings.developer.samsung.com/workspace/)에서 **New Project → Device Integration → SmartThings Cloud Connector → OAuth-In**을 만듭니다.

2. 권한(Scope)은 **세 개 모두** 선택합니다.
   - `r:devices:*` (상태 읽기)
   - `w:devices:*` (설정 쓰기)
   - `x:devices:*` (명령 실행)
   > 하나라도 빠지면 인증은 되는데 제어가 안 됩니다.

3. **Redirect URI**를 등록합니다. 예: `https://homebridge.example.com/oauth/callback`
   - 경로(`/oauth/callback`)는 원하는 대로 정해도 됩니다. 플러그인은 **경로만 보고** 콜백을 받습니다.
   - 이 주소가 리버스 프록시를 거쳐 **홈브릿지의 8999 포트**에 닿아야 합니다.

4. 발급된 **Client ID**와 **Client Secret**, 그리고 방금 등록한 **Redirect URI**를 플러그인 설정에 그대로 넣습니다. 세 값은 워크스페이스에 등록한 것과 **글자 하나까지 같아야** 합니다.

5. Homebridge를 재시작하면 로그에 이런 안내가 나옵니다.

   ```
   ====================[ 스마트싱스 인증 필요 ]====================
   1. 임시 인증 서버가 포트 8999에서 실행 중입니다.
   2. 아래 URL을 복사하여 웹 브라우저에서 열고 …
   인증 URL: https://api.smartthings.com/oauth/authorize?client_id=…
   ```

6. 그 **인증 URL을 브라우저에서 열고** SmartThings 계정으로 로그인해 권한을 허용합니다. 승인하면 브라우저가 Redirect URI로 이동하고, 플러그인이 토큰을 받아 저장합니다. 이후에는 자동으로 갱신되므로 다시 할 일이 없습니다.

#### 인증이 안 될 때

| 증상 | 원인과 조치 |
|---|---|
| 워크스페이스가 Redirect URI를 거부 | `https`가 아니거나 IP 주소입니다. 도메인 + https로 등록하세요. |
| 승인 후 브라우저가 오류 페이지 | 그 도메인이 홈브릿지 8999에 닿지 않는 것입니다. 프록시 설정을 확인하세요. |
| 로그에 `포트 8999를 사용할 수 없습니다` | 다른 프로세스가 8999를 쓰고 있습니다. |
| 승인은 됐는데 기기 제어가 안 됨 | 권한 세 개를 다 골랐는지 확인하고, 워크스페이스에서 고친 뒤 다시 인증하세요. |
| `redirectUri가 유효한 URL 형식이 아닙니다` | 설정에 넣은 값에 오타가 있거나 `https://`가 빠졌습니다. |

---

## 기기 토큰 추출하기

TCP 8888로 통신하는 기기(구형 에어컨, 세탁기)는 **기기가 발급하는 토큰**이 있어야 합니다. 한 번 받으면 계속 쓸 수 있습니다.

### 원리

기기에 "토큰을 달라"고 요청하면, 기기가 **당신의 컴퓨터로 되전화를 걸어** 토큰을 건네줍니다. 그래서 두 가지가 필요합니다.

- 되전화를 받을 **수신 대기 프로그램** (포트 8889)
- 요청할 때 **어디로 걸어야 하는지 알려 주는 것** — `Host` 헤더

> ⚠️ 가장 흔한 실패 원인이 이 `Host` 헤더입니다. 빠뜨리면 기기가 자기 자신에게 전화를 걸고, 토큰은 영영 오지 않습니다.

### 준비물

- 기기와 **같은 네트워크**에 있는 컴퓨터 (요청과 수신을 **같은 컴퓨터에서** 해야 합니다)
- Python 3
- 플러그인에 들어 있는 인증서 — `node_modules/homebridge-smartthings-km81/cert/cert.pem`

아래 두 스크립트를 그 인증서와 **같은 폴더**에 두고 실행하세요.

### 1단계 — 수신 대기

`listener.py`로 저장하고 실행합니다.

```python
import re, socket, ssl, threading

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.minimum_version = ssl.TLSVersion.TLSv1
ctx.set_ciphers('ALL:@SECLEVEL=0')
ctx.verify_mode = ssl.CERT_NONE
ctx.load_cert_chain('cert.pem')

def handle(sock):
    data = b''
    sock.settimeout(10)
    try:
        while b'}' not in data and len(data) < 65536:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
    except Exception:
        pass
    m = re.search(r'"DeviceToken"\s*:\s*"([^"]+)"', data.decode('utf-8', 'replace'))
    if m:
        print('\n★ 토큰:', m.group(1), '\n')
    sock.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    sock.close()

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('0.0.0.0', 8889))      # bind가 먼저 — 실패하면 여기서 즉시 멈춥니다
srv.listen(5)
print('대기 중 — 0.0.0.0:8889')
while True:
    raw, addr = srv.accept()
    print('연결 수신:', addr[0])
    try:
        conn = ctx.wrap_socket(raw, server_side=True)
    except Exception as e:
        print('TLS 실패:', e)
        continue
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
```

```bash
python3 listener.py
```

`대기 중` 문구가 떠야 합니다. 안 뜨면 8889를 다른 프로그램이 쓰고 있는 것이니 정리하고 다시 실행하세요.

### 2단계 — 기기 준비

**에어컨** — 전원을 **끕니다** (콘센트는 그대로).

**세탁기** — 전원을 켜고, 문을 닫고, 패널의 **스마트 컨트롤(원격 제어) 버튼을 짧게** 눌러 램프를 켭니다.

> ⚠️ 3초 이상 길게 누르면 Wi-Fi 페어링(AP) 모드로 들어가 네트워크에서 빠집니다. 그러면 껐다 켜고 다시 하세요.

### 3단계 — 토큰 요청

`request.py`로 저장하고, IP 두 개를 자기 환경에 맞게 고쳐 **새 터미널에서** 실행합니다.

```python
import ssl
from http.client import HTTPSConnection

DEVICE_IP   = '192.168.1.50'    # 기기 IP
LISTENER_IP = '192.168.1.100'   # 이 스크립트를 실행하는 컴퓨터 IP

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.check_hostname = False                      # 순서 주의: verify_mode보다 먼저
ctx.verify_mode = ssl.CERT_NONE
ctx.minimum_version = ssl.TLSVersion.TLSv1
ctx.maximum_version = ssl.TLSVersion.TLSv1_2    # TLS 1.3을 보내면 기기가 멈춥니다
ctx.set_ciphers('DEFAULT@SECLEVEL=0')
ctx.load_cert_chain('cert.pem')

body = '{}'
conn = HTTPSConnection(DEVICE_IP, 8888, context=ctx, timeout=15)
conn.putrequest('POST', '/devicetoken/request', skip_host=True, skip_accept_encoding=True)
conn.putheader('Host', f'{LISTENER_IP}:8889')    # ★되전화 주소. 빠뜨리면 실패합니다
conn.putheader('Content-Type', 'application/json')
conn.putheader('DeviceToken', 'xxxxxxxxxxx')     # 그대로 두세요 (자리표시자)
conn.putheader('Content-Length', str(len(body)))
conn.endheaders(body.encode())
r = conn.getresponse()
print(r.status, r.reason)
```

```bash
python3 request.py
```

`200 OK`가 나오면 요청이 접수된 것입니다.

### 4단계 — 기기를 켭니다

**에어컨** — 전원을 켭니다.
**세탁기** — 전원을 껐다가 다시 켭니다.

몇 초 안에 수신 대기 창에 토큰이 찍힙니다.

```
연결 수신: 192.168.1.50

★ 토큰: aB3dEf7hIj
```

이 값을 플러그인 설정의 `인증 토큰`(에어컨) 또는 `기기 토큰`(세탁기)에 넣으면 됩니다.

### 잘 안 될 때

| 증상 | 원인과 조치 |
|---|---|
| `403 … previous request` | 직전 요청이 처리 중입니다. **정상**이니 1분 기다렸다 다시 하세요. |
| `200 OK`인데 토큰이 안 옴 | `Host` 헤더의 IP가 **수신 대기 중인 컴퓨터**의 것이 맞는지 확인하고, 4단계(전원 껐다 켜기)를 다시 하세요. |
| 수신 창에 아무 연결도 안 잡힘 | 방화벽이 8889 인바운드를 막는지, 컴퓨터와 기기가 같은 네트워크인지 확인하세요. |
| 연결 자체가 안 됨 | 기기가 켜져 있는지, IP가 맞는지 확인하세요. 세탁기는 전원을 끄면 네트워크에서 사라집니다. |
| `curl`로는 실패함 | 최신 `curl`은 TLS 1.0을 거부합니다. 위 Python 스크립트를 쓰세요. |

---

## 자주 묻는 것

**클라우드 없이 쓸 수 있나요?**
네. 모든 기기를 로컬로 설정하면 SmartThings API를 전혀 쓰지 않습니다. 다만 로컬이 실패했을 때 기댈 곳도 없어집니다.

**로컬과 클라우드를 섞어 쓸 수 있나요?**
네. 기기마다 따로 정합니다. 로컬로 두고 `로컬 실패 시 클라우드 사용`을 켜 두는 조합을 권합니다. 이 경우 플러그인이 하루 한 번 클라우드 토큰을 갱신해, 폴백이 정작 필요한 순간에 만료돼 있지 않도록 유지합니다.

**세탁기를 껐는데 HomeKit에 계속 "동작 중"으로 보입니다.**
세탁기는 전원을 끄면 네트워크에서 사라집니다. 플러그인은 잠시 기다렸다가 "꺼짐"으로 판단해 정리합니다. 몇 분 걸릴 수 있습니다.

**토큰이 만료되나요?**
기기를 초기화하지 않는 한 계속 유효합니다.

**기기 IP가 바뀌면?**
공유기에서 고정 IP(주소 예약)로 잡아두세요. 바뀌면 설정도 고쳐야 합니다.

**세탁기에서 코스나 온도를 바꿀 수 있나요?**
아니요. 기기가 원격 변경을 받지 않습니다. 상태 조회와 종료 알림만 됩니다.

---

## 문제가 생기면

Homebridge 로그를 먼저 보세요. 모든 로그에 `[기기 이름]`이 붙어 있어 어느 기기 문제인지 바로 알 수 있습니다.

더 자세한 내용이 필요하면 Homebridge 설정에서 디버그 모드를 켜세요.

---

## 보안 참고

- 기기 토큰은 `config.json`에 평문으로 저장됩니다. 파일 권한을 확인하세요.
- 로컬 통신은 구형 기기가 요구하는 TLS 1.0을 씁니다. 같은 네트워크 안에서만 오가는 통신입니다.

---

## 라이선스

MIT
