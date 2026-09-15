"""B8 (2026-09-12) — the minted installation token carries exactly the
permissions its caller asked for.

`mint_installation_token` used to hard-code one permission object
(pull_requests:write + contents:write + administration:read) for every
caller. The hosted runner preflight (aria_kernel.runner_availability) only
reads the repository's runner roster, and it runs on a GitHub-hosted
runner: a token with write scopes on the repository must never exist there.
The caller names the set; the mint sends it verbatim; these pin the body.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import gh_token_factory as tf


class _Response:
    def __init__(self, payload: dict) -> None:
        self._body = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_: object) -> bool:
        return False


class TheMintSendsTheCallersPermissions(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="aria-token-permissions-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        pem = self.root / "app.pem"
        pem.write_text("-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----\n", encoding="utf-8")
        env = patch.dict(os.environ, {
            "ARIA_GH_APP_INSTALLATION_ID": "12345", "ARIA_GH_APP_ID": "678",
            "ARIA_GH_APP_PRIVATE_KEY_PATH": str(pem), "ARIA_REQUIRE_MODE_A": "true",
        })
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("ARIA_DRY_RUN", None)
        self.posted: list[dict] = []

        def urlopen(request, timeout):  # noqa: ANN001 — urlopen's shape
            self.posted.append({"url": request.full_url, "body": json.loads(request.data.decode("utf-8"))})
            return _Response({"token": "ghs_fixture", "expires_at": "2026-09-12T00:05:00Z"})

        jwt_patch = patch.dict("sys.modules", {"jwt": _FakeJwt()})
        jwt_patch.start()
        self.addCleanup(jwt_patch.stop)
        url_patch = patch("urllib.request.urlopen", urlopen)  # allowlist-external-network: the opener is replaced by the in-process fake above; no request leaves the test
        url_patch.start()
        self.addCleanup(url_patch.stop)

    def _mint(self, **kwargs) -> tf.InstallationTokenLease:
        lease = tf.mint_installation_token(cycle_id="permissions-fixture", workspace_root=self.root, **kwargs)
        self.addCleanup(lambda: lease.token_file.unlink(missing_ok=True))
        return lease

    def test_the_default_is_the_delivery_scope_plus_administration_read(self) -> None:
        lease = self._mint()
        self.assertFalse(lease.fallback_active)
        self.assertEqual(self.posted[0]["url"], "https://api.github.com/app/installations/12345/access_tokens")
        self.assertEqual(self.posted[0]["body"]["permissions"],
                         {"pull_requests": "write", "contents": "write", "administration": "read"})
        self.assertEqual(dict(tf.DEFAULT_INSTALLATION_TOKEN_PERMISSIONS), self.posted[0]["body"]["permissions"])

    def test_the_runner_preflight_scope_is_administration_read_and_nothing_else(self) -> None:
        self._mint(permissions=tf.RUNNER_STATUS_PERMISSIONS)
        body = self.posted[0]["body"]
        self.assertEqual(body["permissions"], {"administration": "read"})
        self.assertNotIn("write", json.dumps(body), "a hosted runner never holds a write scope")

    def test_the_named_sets_are_immutable(self) -> None:
        with self.assertRaises(TypeError):
            tf.RUNNER_STATUS_PERMISSIONS["contents"] = "write"  # type: ignore[index]
        with self.assertRaises(TypeError):
            tf.DEFAULT_INSTALLATION_TOKEN_PERMISSIONS["administration"] = "write"  # type: ignore[index]

    def test_an_empty_or_malformed_permission_set_is_refused_before_any_request(self) -> None:
        for bad in ({}, {"contents": "admin"}, {"": "read"}):
            with self.subTest(permissions=bad):
                with self.assertRaises(ValueError):
                    tf.mint_installation_token(cycle_id="permissions-fixture", workspace_root=self.root, permissions=bad)
        self.assertEqual(self.posted, [])


class _FakeJwt:
    """PyJWT's `encode` surface: the mint signs a JWT it never inspects."""

    @staticmethod
    def encode(payload: dict, key: str, algorithm: str) -> str:
        assert algorithm == "RS256" and key.startswith("-----BEGIN")
        return "header.payload.signature"


if __name__ == "__main__":
    unittest.main()
