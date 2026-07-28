#!/usr/bin/env python3
"""로컬 DTLS-CoAP 브릿지 — 홈브릿지 플러그인이 자식 프로세스로 띄운다.

왜 파이썬인가: 삼성 신형 가전(TizenRT/DAWIT)은 CoAP over DTLS(UDP)로 말하는데
Node에는 DTLS가 없다. 유일한 후보 @nodertc/dtls는 ClientHello 단계에서 기기가
alert 40으로 끊는다(2026-07-28 실측). 검증된 smartthings-local(파이썬)을 쓰되
별도 컨테이너 없이 홈브릿지 컨테이너 안 파이썬으로 돌린다.

프로토콜: stdin/stdout JSON Lines
  요청  {"id":1,"op":"get","host":"192.168.1.78","port":49154,"path":["power","vs","0"]}
        {"id":2,"op":"post",...,"payload":{...}}
        {"id":3,"op":"ping"}
  응답  {"id":1,"ok":true,"code":69,"data":{...}} | {"id":1,"ok":false,"error":"..."}

기기당 DTLS 세션은 1개만 유지한다(펌웨어 제약). 세션이 끊기면 다음 요청에서 재연결.
"""
import json
import os
import re
import ssl
import socket
import sys
import threading

sys.path.insert(0, os.environ.get("KM81_LOCAL_LIB", "/homebridge/.km81-local/lib"))

import cbor2  # noqa: E402
from smartthings_local.protocol.dtls_session import DtlsCoapSession  # noqa: E402

SAMSUNG_GATEWAY = ("connect-v2.samsungiotcloud.com", 443)

# 기기가 DTLS-CoAP를 여는 포트 범위. 기기·펌웨어마다 달라(승준 에어컨 49154, 건조기 49155)
# 사용자가 포트를 몰라도 되도록 자동 탐지한다. 자주 쓰이는 순서로 시도.
PROBE_PORTS = [49154, 49155, 49153, 49152, 49156, 49157, 49158, 49159, 49160]
_resolved_ports = {}   # host → port

_out_lock = threading.Lock()
_sessions = {}
_session_locks = {}
_registry_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def log(msg):
    emit({"event": "log", "message": msg})


# ---------- 인증서 발급 ----------
def fetch_gateway_uuid():
    """삼성 클라우드 게이트웨이 TLS 인증서 subject의 OU에서 UUID를 뽑는다.
    이 UUID는 기기 공장 ACL이 전체 권한을 부여하는 신원이다."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection(SAMSUNG_GATEWAY, timeout=15) as raw:
        with ctx.wrap_socket(raw, server_hostname=SAMSUNG_GATEWAY[0]) as tls:
            der = tls.getpeercert(binary_form=True)
    from cryptography import x509
    cert = x509.load_der_x509_certificate(der)
    m = re.search(r"uuid:([0-9a-fA-F-]{36})", cert.subject.rfc4514_string())
    if not m:
        raise RuntimeError("게이트웨이 인증서에서 UUID를 찾지 못했습니다")
    return m.group(1)


def mint_cert(ca_pem_path, out_chain, out_key):
    """플러그인 동봉 AC14K_M CA로 클라이언트 리프 인증서를 발급한다."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    raw = open(ca_pem_path, "rb").read()
    ca_key = serialization.load_pem_private_key(raw, password=None)
    ca_certs = [x509.load_pem_x509_certificate(b"-----BEGIN CERTIFICATE-----" + p)
                for p in raw.split(b"-----BEGIN CERTIFICATE-----")[1:]]
    ca_cert = next((c for c in ca_certs
                    if "AC14K_M" in c.subject.rfc4514_string()), ca_certs[0])

    uuid = fetch_gateway_uuid()
    log("게이트웨이 UUID 확보 — 클라이언트 인증서 발급")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "uuid:%s" % uuid),
        x509.NameAttribute(NameOID.COMMON_NAME, "urn:uuid:%s" % uuid),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Samsung Electronics"),
        x509.NameAttribute(NameOID.COUNTRY_NAME, "KR"),
    ])
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)
    leaf = (x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(ca_cert.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(x509.SubjectAlternativeName([
                x509.UniformResourceIdentifier("urn:uuid:%s" % uuid),
                x509.UniformResourceIdentifier("uri:uuid:%s" % uuid),
                x509.UniformResourceIdentifier("uuid:%s" % uuid),
                x509.DNSName(uuid),
            ]), critical=False)
            .add_extension(x509.KeyUsage(
                digital_signature=True, key_encipherment=True, content_commitment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=False,
                crl_sign=False, encipher_only=False, decipher_only=False), critical=False)
            .add_extension(x509.ExtendedKeyUsage([
                x509.ObjectIdentifier("1.3.6.1.5.5.7.3.2"),
                x509.ObjectIdentifier("1.3.6.1.5.5.7.3.1")]), critical=False)
            # 기기 신뢰 체계와 맞추기 위해 SHA-1 서명 (2026-07-28 실측으로 수락 확인)
            .sign(ca_key, hashes.SHA1()))

    os.makedirs(os.path.dirname(out_chain), exist_ok=True)
    with open(out_chain, "wb") as f:
        f.write(leaf.public_bytes(serialization.Encoding.PEM))
        for c in ca_certs:
            f.write(c.public_bytes(serialization.Encoding.PEM))
    with open(out_key, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM,
                                  serialization.PrivateFormat.TraditionalOpenSSL,
                                  serialization.NoEncryption()))
    os.chmod(out_key, 0o600)
    os.chmod(out_chain, 0o600)
    log("클라이언트 인증서 발급됨")


# ---------- 포트 자동 탐지 ----------
def _dtls_hello():
    """최소 DTLS 1.2 ClientHello. 포트가 살아 있으면 HelloVerifyRequest가 돌아온다."""
    import struct
    body = b"\xfe\xfd" + os.urandom(32) + b"\x00\x00"
    suites = [0xC02B, 0xC023, 0xC0AE]
    body += struct.pack(">H", len(suites) * 2) + b"".join(struct.pack(">H", s) for s in suites)
    body += b"\x01\x00"
    ext = (b"\x00\x0a" + struct.pack(">H", 4) + b"\x00\x02\x00\x17"
           + b"\x00\x0b" + struct.pack(">H", 2) + b"\x01\x00"
           + b"\x00\x0d" + struct.pack(">H", 4) + b"\x00\x02\x04\x03")
    body += struct.pack(">H", len(ext)) + ext
    hs = (b"\x01" + struct.pack(">I", len(body))[1:] + b"\x00\x00" + b"\x00\x00\x00"
          + struct.pack(">I", len(body))[1:] + body)
    return b"\x16\xfe\xfd\x00\x00\x00\x00\x00\x00\x00\x00" + struct.pack(">H", len(hs)) + hs


def resolve_port(host, hint=None):
    """DTLS 응답이 오는 포트를 찾는다. 임의 송신 포트를 쓰므로 고정 포트 바인딩과 충돌하지 않는다."""
    cached = _resolved_ports.get(host)
    if cached:
        return cached
    # 이미 이 기기와 세션이 있으면 그 포트가 정답이다. 단일 세션 기기라서 탐지 패킷 자체가
    # 진행 중인 핸드셰이크를 방해할 수 있으므로, 세션이 있으면 절대 다시 훑지 않는다
    # (실측: 세션 수립 중이던 건조기가 탐지에 무응답 → 불필요한 클라우드 폴백 1회 발생).
    for key in list(_sessions.keys()):
        if key.startswith(host + ":"):
            port = int(key.rsplit(":", 1)[1])
            _resolved_ports[host] = port
            return port
    order = ([hint] if hint else []) + [p for p in PROBE_PORTS if p != hint]
    pkt = _dtls_hello()
    for _attempt in range(2):   # 기기가 바쁘면 한 번 놓칠 수 있어 1회 재시도
        for port in order:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(2.0)
            try:
                s.sendto(pkt, (host, port))
                data, _ = s.recvfrom(2048)
                if data and data[0] == 0x16:
                    _resolved_ports[host] = port
                    log("포트 자동 탐지: %s → %d" % (host, port))
                    return port
            except Exception:
                pass
            finally:
                s.close()
    raise ConnectionError("%s 에서 DTLS 포트를 찾지 못했습니다 (49152~49160 무응답)" % host)


# ---------- 세션 관리 ----------
def auto_local_port(host):
    """기기별로 항상 같은 송신 포트를 쓴다.

    홈브릿지를 재시작하면 기기에 유령 DTLS 세션이 5~15분 남는데, 새 임의 포트로 붙으면
    기기가 '다른 피어'로 보고 무시한다. 같은 5-tuple로 재접속하면 RFC 6347 §4.2.8에 따라
    기기가 '재부팅한 피어'로 처리해 옛 세션을 버린다. 사용자가 포트를 고르지 않아도 되도록
    IP 마지막 옥텟에서 결정적으로 만든다(기기 포트 범위 49152~49160과 겹치지 않는 49200+).
    """
    try:
        last = int(host.rsplit(".", 1)[1])
    except (ValueError, IndexError):
        last = abs(hash(host)) % 250
    return 49200 + (last % 250)


def session_for(host, port, cert, key, local_port=None):
    k = "%s:%d" % (host, port)
    with _registry_lock:
        lock = _session_locks.setdefault(k, threading.Lock())
    with lock:
        s = _sessions.get(k)
        if s is not None:
            return s, lock
        lp = local_port or auto_local_port(host)
        try:
            s = DtlsCoapSession(host, port, cert_path=cert, key_path=key, local_port=lp)
            s.connect()
        except OSError as e:
            # 그 포트를 다른 프로세스가 이미 쓰고 있으면 임의 포트로 물러선다
            # (유령 세션 이점은 잃지만 연결 자체는 살린다).
            log("고정 송신 포트 %d 사용 불가(%s) — 임의 포트로 연결" % (lp, e))
            s = DtlsCoapSession(host, port, cert_path=cert, key_path=key)
            s.connect()
        s.start_reader()
        _sessions[k] = s
        log("로컬 세션 연결됨 %s" % k)
        return s, lock


def drop_session(host, port):
    # v2.2.1 — 반드시 세션 락 안에서 교체한다. 락 없이 닫으면 다른 스레드가 방금 만든
    # 세션을 지우거나, 사용 중인 세션을 닫아 그 스레드가 죽는다(감사 LOW-1).
    k = "%s:%d" % (host, port)
    # ★v2.3.3 — 학습한 포트 캐시도 함께 버린다(3차 감사 H1).
    # 이전엔 _resolved_ports에 쓰기만 있고 지우는 경로가 없어, resolve_port가 낡은 포트를
    # 무조건 최우선 반환했다. 그 결과 JS가 "연속 실패 3회 → 포트 재탐지"를 시도해도
    # 프로브 루프에 영영 도달하지 못했다 — **처음부터 동작한 적 없는 수정**이었다.
    # 세션이 끊겼다는 건 그 포트에 대한 신뢰가 깨졌다는 뜻이므로 여기서 버리는 게 맞다.
    _resolved_ports.pop(host, None)
    with _registry_lock:
        lock = _session_locks.setdefault(k, threading.Lock())
    with lock:
        s = _sessions.pop(k, None)
    if s is not None:
        try:
            s.close()
        except Exception:
            pass
        log("로컬 세션 해제 %s" % k)


def handle(req, cert, key):
    op = req.get("op")
    rid = req.get("id")
    if op == "ping":
        return {"id": rid, "ok": True, "data": {"sessions": list(_sessions)}}
    host = req["host"]
    # port가 없거나 0이면 자동 탐지한다(사용자가 포트를 몰라도 되게).
    raw_port = req.get("port")
    try:
        port = int(raw_port) if raw_port else 0
    except (TypeError, ValueError):
        port = 0
    if not port:
        try:
            port = resolve_port(host)
        except Exception as e:
            return {"id": rid, "ok": False, "error": str(e)}
    path = req["path"]
    # v2.2.1 — ★쓰기는 절대 재시도하지 않는다(감사 HIGH-2).
    # 재시도가 늦게 성공하면 그 사이 도착한 OFF보다 뒤에 착탄해, 꺼진 에어컨에 모드 명령이
    # 들어가 재점등한다(실측된 현상). 클라우드 경로도 같은 이유로 비멱등 POST 재시도를 금지한다.
    # 읽기만 세션 끊김 대비 1회 재연결한다.
    attempts = 1 if op == "post" else 2
    last = None
    for i in range(attempts):
        try:
            s, lock = session_for(host, port, cert, key, req.get("localPort"))
            with lock:
                if op == "get":
                    code, body = s.get(path)
                elif op == "post":
                    code, body = s.post(path, cbor2.dumps(req.get("payload") or {}))
                else:
                    return {"id": rid, "ok": False, "error": "알 수 없는 op: %s" % op}
            data = cbor2.loads(body) if body else None
            # v2.2.1 — ★CoAP 응답코드를 반드시 판정한다(감사 HIGH-1).
            # 라이브러리는 4.xx/5.xx를 예외가 아니라 반환값으로 준다. 이걸 성공으로 넘기면
            # 기기가 거부한 '끄기'가 성공으로 보고돼 재시도·폴백이 전부 무력화된다.
            if not (64 <= code <= 95):   # 2.00~2.31 이외는 실패
                return {"id": rid, "ok": False, "code": code,
                        "error": "CoAP %d.%02d 응답" % (code >> 5, code & 31)}
            return {"id": rid, "ok": True, "code": code, "data": data, "port": port}
        except Exception as e:
            last = e
            drop_session(host, port)
            if i + 1 < attempts:
                continue
    # ★v2.3.3 — 쓰기 실패는 "이미 기기로 나갔을 수 있음"으로 표시한다(3차 감사 H2).
    # JS가 오류 '문자열'로 결과 불명을 추측하던 것을 대체한다 — 여기 오류는 파이썬이 만든
    # 영어 메시지라 한국어 정규식에 걸리지 않았고, 그래서 "비멱등 명령은 불명 시 재전송 금지"
    # 보호가 정작 가장 흔한 실패에서 작동하지 않았다.
    return {"id": rid, "ok": False, "sent": op == "post",
            "error": "%s: %s" % (type(last).__name__, last)}


def main():
    cert = os.environ.get("KM81_LOCAL_CERT", "/homebridge/.km81-local/certs/fullchain.pem")
    key = os.environ.get("KM81_LOCAL_KEY", "/homebridge/.km81-local/certs/leaf.key")
    ca = os.environ.get("KM81_LOCAL_CA", "")

    if not (os.path.exists(cert) and os.path.exists(key)):
        if not ca or not os.path.exists(ca):
            emit({"event": "ready", "ok": False,
                  "error": "인증서가 없고 CA 경로(KM81_LOCAL_CA)도 유효하지 않습니다"})
            return
        try:
            mint_cert(ca, cert, key)
        except Exception as e:
            emit({"event": "ready", "ok": False, "error": "인증서 발급 실패: %s" % e})
            return

    emit({"event": "ready", "ok": True})

    pool = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"ok": False, "error": "요청 파싱 실패: %s" % e})
            continue
        t = threading.Thread(target=lambda r=req: emit(handle(r, cert, key)), daemon=True)
        t.start()
        pool = [x for x in pool if x.is_alive()][-32:] + [t]


if __name__ == "__main__":
    main()
