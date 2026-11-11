"""A-5：Agent 端发布签名清单自验（release_verify）单测。

Ed25519 正例向量用 node crypto（OpenSSL）离线生成——保证纯 Python 参考实现
与真实签名器互认，而不是自己签自己验的闭环。
"""

from __future__ import annotations

import base64
import copy
import json
import unittest
from unittest import mock

from khc import release_verify
from khc.release_verify import (
    RELEASE_PUBKEY_B64,
    _ed25519_verify,
    canonical_json,
    verify_release_manifest,
)
from khc.upgrade import UpgradeService
from khc.util import BadRequest, Paths

from .support import (
    TEST_RELEASE_PUBKEY_B64,
    make_paths,
    sign_release_manifest,
)

# node crypto（OpenSSL Ed25519）离线生成的向量：pubkey 由 seed 推导。
VEC_PUB = "fzIayp9ekeenMKML620ojrEYn9kNPfLQXoUx1k0C4aI="
VEC_SIG_EMPTY = "U5niUzr2uIrc8Q+0UiZ49FEROthCiOFPPHj6zrqg2Cm31kq5kMEMYSdBBLFZiW7SpqoW3VJMsco+8SCCuCKiCQ=="
VEC_SIG_ABC = "oK4DtQWNsO1J+Wh/EC7V6O0fEWMmIEqvRdFI33dL+4ubTsZNV1GVONwkoFr2di1ldro6NderxkvAEn6D2JVMDQ=="

# node 侧 canonical() 对固定 payload 的输出（sign-agent-release.mjs 同一算法）。
NODE_CANONICAL = (
    '{"generatedAt":1730000000,"releases":[{"sha256":"'
    + "a" * 64
    + '","url":"https://panel.example/agent/khc-agent-0.1.12.tar.gz","version":"0.1.12"}],"version":1}'
)

URL = "https://panel.example/agent/khc-agent-0.1.12.tar.gz"
SHA = "a" * 64


def _manifest(entries=None) -> dict:
    return json.loads(sign_release_manifest(entries or [("0.1.12", URL, SHA)]))


class Ed25519Test(unittest.TestCase):
    """纯 Python 实现与 OpenSSL 互认 + 负例。"""

    def test_verifies_openssl_vectors(self) -> None:
        pub = base64.b64decode(VEC_PUB)
        self.assertTrue(_ed25519_verify(pub, base64.b64decode(VEC_SIG_EMPTY), b""))
        self.assertTrue(_ed25519_verify(pub, base64.b64decode(VEC_SIG_ABC), b"abc"))

    def test_rejects_tampered(self) -> None:
        pub = base64.b64decode(VEC_PUB)
        sig = bytearray(base64.b64decode(VEC_SIG_ABC))
        sig[0] ^= 0x01
        self.assertFalse(_ed25519_verify(pub, bytes(sig), b"abc"))
        self.assertFalse(_ed25519_verify(pub, base64.b64decode(VEC_SIG_ABC), b"abd"))
        self.assertFalse(_ed25519_verify(pub, base64.b64decode(VEC_SIG_ABC), b""))
        # 错误长度的公钥/签名
        self.assertFalse(_ed25519_verify(b"\x00" * 31, bytes(sig), b"abc"))
        self.assertFalse(_ed25519_verify(pub, bytes(sig) + b"x", b"abc"))
        # 非曲线点
        self.assertFalse(_ed25519_verify(b"\x01" * 32, bytes(sig), b"abc"))

    def test_builtin_pubkey_shape(self) -> None:
        """内置生产公钥必须是 32 字节合法编码（len 校验，防拷贝粘贴错位）。"""

        self.assertEqual(len(base64.b64decode(RELEASE_PUBKEY_B64)), 32)


class CanonicalJsonTest(unittest.TestCase):
    def test_matches_node_output(self) -> None:
        payload = {
            "releases": [{"sha256": SHA, "url": URL, "version": "0.1.12"}],
            "version": 1,
            "generatedAt": 1730000000,
        }
        self.assertEqual(canonical_json(payload), NODE_CANONICAL)

    def test_key_order_insensitive_and_nested(self) -> None:
        self.assertEqual(canonical_json({"b": 1, "a": {"d": [3, 2], "c": None}}), '{"a":{"c":null,"d":[3,2]},"b":1}')


class VerifyManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.object(release_verify, "RELEASE_PUBKEY_B64", TEST_RELEASE_PUBKEY_B64)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_accepts_signed_manifest(self) -> None:
        verify_release_manifest(_manifest(), URL, SHA)  # 不抛即通过

    def test_accepts_raw_json_string(self) -> None:
        verify_release_manifest(sign_release_manifest([("0.1.12", URL, SHA)]), URL, SHA)

    def test_rejects_tampered_payload(self) -> None:
        manifest = _manifest()
        manifest["payload"]["releases"][0]["sha256"] = "b" * 64
        with self.assertRaises(BadRequest) as caught:
            verify_release_manifest(manifest, URL, "b" * 64)
        self.assertEqual(caught.exception.code, "release_signature_invalid")

    def test_rejects_wrong_key_signature(self) -> None:
        # 内置公钥换掉后，同一清单验签失败（跨钥签名）
        with mock.patch.object(release_verify, "RELEASE_PUBKEY_B64", "A" * 43 + "="):
            with self.assertRaises(BadRequest) as caught:
                verify_release_manifest(_manifest(), URL, SHA)
            self.assertIn(caught.exception.code, ("release_signature_invalid", "release_manifest_invalid"))

    def test_rejects_package_not_in_manifest(self) -> None:
        with self.assertRaises(BadRequest) as caught:
            verify_release_manifest(_manifest(), "https://evil.example/selfbuilt.tar.gz", SHA)
        self.assertEqual(caught.exception.code, "release_not_in_manifest")

    def test_rejects_missing_or_malformed_manifest(self) -> None:
        for bad in (None, "not-json", {}, {"payload": {}}, {"payload": {"version": 2, "releases": []}, "signature": "x"}):
            with self.subTest(bad=bad):
                with self.assertRaises(BadRequest) as caught:
                    verify_release_manifest(bad, URL, SHA)
                self.assertEqual(caught.exception.code, "release_manifest_invalid")

    def test_rejects_non_b64_signature(self) -> None:
        manifest = _manifest()
        manifest["signature"] = "!!not base64!!"
        with self.assertRaises(BadRequest) as caught:
            verify_release_manifest(manifest, URL, SHA)
        self.assertEqual(caught.exception.code, "release_manifest_invalid")


class UpgradeValidateRequestTest(unittest.TestCase):
    """validate_request 的 fail-closed 行为：缺清单拒绝、自建包拒绝、正常升级通过。"""

    def setUp(self) -> None:
        self.paths: Paths = make_paths(profile="user")
        self.service = UpgradeService(self.paths, current_version="0.1.11", install_dir="/tmp/khc-agent")
        patcher = mock.patch.object(release_verify, "RELEASE_PUBKEY_B64", TEST_RELEASE_PUBKEY_B64)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _body(self, **overrides: object) -> dict:
        payload = {"packageUrl": URL, "sha256": SHA, "reinstall": False}
        payload.update(overrides)
        return payload

    def test_missing_manifest_rejected(self) -> None:
        with self.assertRaises(BadRequest) as caught:
            self.service.validate_request(self._body())
        self.assertEqual(caught.exception.code, "release_manifest_missing")

    def test_selfbuilt_package_rejected(self) -> None:
        manifest = _manifest()  # 只包含正式包 URL
        body = self._body(
            packageUrl="https://downloads.example.com/khc-agent/khc-agent-9.9.9-selfbuilt.tar.gz",
            manifest=json.dumps(manifest),
        )
        with self.assertRaises(BadRequest) as caught:
            self.service.validate_request(body)
        self.assertEqual(caught.exception.code, "release_not_in_manifest")

    def test_valid_manifest_passes(self) -> None:
        body = self._body(manifest=sign_release_manifest([("0.1.12", URL, SHA)]))
        request = self.service.validate_request(body)
        self.assertEqual(request.package_url, URL)
        self.assertEqual(request.sha256, SHA)
        self.assertFalse(request.reinstall)

    def test_forged_manifest_rejected(self) -> None:
        manifest = _manifest()
        manifest["payload"]["releases"].append(
            {"version": "9.9.9", "url": "https://evil.example/x.tar.gz", "sha256": "c" * 64}
        )
        body = self._body(packageUrl="https://evil.example/x.tar.gz", sha256="c" * 64, manifest=json.dumps(manifest))
        with self.assertRaises(BadRequest) as caught:
            self.service.validate_request(body)
        self.assertEqual(caught.exception.code, "release_signature_invalid")


if __name__ == "__main__":
    unittest.main()
