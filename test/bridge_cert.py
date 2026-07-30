#!/usr/bin/env python3
"""로컬 브릿지 인증서 발급 계약 (v2.6.7).

왜 필요한가 — 이 경로는 **첫 설치에서만** 지나간다. 인증서가 한 번 만들어지면 다시
발급하지 않으므로, 이미 돌아가는 우리 기기로는 무슨 짓을 해도 결함이 안 드러난다.
실제로 v2.6.6까지는 최신 배포판에서 인증서를 아예 못 만들었는데(암호화 라이브러리가
SHA-1 서명을 거부), 우리 NAS는 7/28에 만든 인증서를 재사용하고 있어 멀쩡해 보였다.
새로 설치한 사용자 로그로만 드러난 결함이다 → 여기서 기계로 잡는다.

실기기 확인(2026-07-30, 건조기 192.168.1.62:49155): SHA-1·SHA-256 인증서 **둘 다**
DTLS 핸드셰이크 + CoAP GET 성공. 그래서 SHA-256 폴백은 안전하다.
"""
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# bridge.py는 시작 시 의존성을 즉시 import 한다(없으면 그 자리에서 명확히 죽는 게 맞다).
# 이 테스트는 인증서 발급만 보므로 두 모듈을 껍데기로 채워 넣는다.
sys.modules.setdefault("cbor2", types.ModuleType("cbor2"))
for name in ("smartthings_local", "smartthings_local.protocol",
             "smartthings_local.protocol.dtls_session"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["smartthings_local.protocol.dtls_session"].DtlsCoapSession = object

sys.path.insert(0, os.path.join(ROOT, "lib", "local"))
import bridge  # noqa: E402

CA = os.path.join(ROOT, "cert", "cert.pem")
UUID = "00000000-1111-2222-3333-444444444444"
bridge.fetch_gateway_uuid = lambda: UUID          # 네트워크 없이 발급만 본다

fails = []


def t(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as e:
        fails.append(name)
        print("  ✗ %s\n      %s: %s" % (name, type(e).__name__, e))


def mint(tmp, block_sha1):
    from cryptography.hazmat.primitives import hashes
    from cryptography import x509
    chain = os.path.join(tmp, "fullchain.pem")
    key = os.path.join(tmp, "leaf.key")
    orig = hashes.SHA1
    if block_sha1:
        class _Blocked(orig):
            def __init__(self, *a, **k):
                raise Exception('Hash algorithm "sha1" not supported for signatures')
        hashes.SHA1 = _Blocked
    try:
        bridge.mint_cert(CA, chain, key)
    finally:
        hashes.SHA1 = orig
    leaf = x509.load_pem_x509_certificate(open(chain, "rb").read())
    return leaf, chain, key


def main():
    import tempfile
    print("\n[로컬 브릿지 인증서 발급 계약]")

    with tempfile.TemporaryDirectory() as tmp:
        leaf, chain, key = mint(os.path.join(tmp, "a"), block_sha1=False)

        t("이 환경에서 인증서 발급이 성공한다",
          lambda: None)

        t("리프에 게이트웨이 UUID가 박힌다 (기기가 자기 것으로 인식하는 근거)",
          lambda: _assert(UUID in leaf.subject.rfc4514_string(), "UUID 없음"))

        t("체인 파일에 리프 + CA가 함께 들어간다",
          lambda: _assert(open(chain, "rb").read().count(b"BEGIN CERTIFICATE") >= 2,
                          "CA가 빠졌다"))

        t("개인키는 소유자만 읽을 수 있다",
          lambda: _assert(os.name == "nt" or (os.stat(key).st_mode & 0o077) == 0,
                          "권한이 열려 있다"))

    with tempfile.TemporaryDirectory() as tmp:
        # ★핵심: SHA-1 서명이 막힌 환경(최신 배포판·Pi OS 등)에서도 발급이 끝나야 한다.
        leaf2, _, _ = mint(os.path.join(tmp, "b"), block_sha1=True)

        t("★SHA-1 서명이 막혀도 발급이 실패하지 않는다 (첫 설치가 여기서 멈추던 결함)",
          lambda: _assert(leaf2 is not None, "발급 실패"))

        t("★그때 서명 해시는 SHA-256이다 (실기기 수락 확인된 대체값)",
          lambda: _assert(leaf2.signature_hash_algorithm.name == "sha256",
                          "실제: %s" % leaf2.signature_hash_algorithm.name))

    t("진단 요약에 라이브러리 버전이 담긴다 (로그 한 장으로 원인을 좁히려고)",
      lambda: _assert("cryptography" in bridge.env_summary()
                      and "python" in bridge.env_summary(),
                      bridge.env_summary()))

    print("\n  총 %d건 / 실패 %d\n" % (7, len(fails)))
    return 1 if fails else 0


def _assert(cond, msg):
    if not cond:
        raise AssertionError(msg)


if __name__ == "__main__":
    sys.exit(main())
