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


# ---------- 세션 관리 ----------
def session_for(host, port, cert, key, local_port=None):
    k = "%s:%d" % (host, port)
    with _registry_lock:
        lock = _session_locks.setdefault(k, threading.Lock())
    with lock:
        s = _sessions.get(k)
        if s is not None:
            return s, lock
        s = DtlsCoapSession(host, port, cert_path=cert, key_path=key,
                            local_port=local_port)
        s.connect()
        s.start_reader()
        _sessions[k] = s
        log("로컬 세션 연결됨 %s" % k)
        return s, lock


def drop_session(host, port):
    k = "%s:%d" % (host, port)
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
    host, port = req["host"], int(req["port"])
    path = req["path"]
    attempts = 2  # 세션이 끊겼으면 1회 재연결 후 재시도
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
            return {"id": rid, "ok": True, "code": code, "data": data}
        except Exception as e:
            last = e
            drop_session(host, port)
            if i + 1 < attempts:
                continue
    return {"id": rid, "ok": False, "error": "%s: %s" % (type(last).__name__, last)}


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
