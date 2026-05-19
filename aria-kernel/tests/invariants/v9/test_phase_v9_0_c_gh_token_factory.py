"""Plan ARIA-V9.0-C — gh_token_factory signing key + scoped-token
factory invariants.

Closes security-reviewer CRIT-001 (GH_TOKEN exfil scope), CRIT-004
(commit signature kernel verification).

Tier-1 (make impossible) — kernel always routes through
``mint_installation_token`` + ``mint_signing_key``; aria-implementer
NEVER reads ``$GH_TOKEN`` directly.

Tier-3 (detect) — operator-PAT fallback emits governance event so
audit captures shim activations.
"""
from __future__ import annotations

import inspect
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import _helpers  # noqa: F401

from aria_kernel import gh_token_factory as _tf


class TestV9SigningKeyFactory(unittest.TestCase):

    def test_i_v9_token_factory_signing_key_frozen(self):
        """SigningKey is frozen (immutable cycle binding)."""
        with tempfile.TemporaryDirectory() as workspace:
            if shutil.which("ssh-keygen") is None:
                self.skipTest("ssh-keygen not on PATH")
            key = _tf.mint_signing_key(cycle_id="test-cycle-001", workspace_root=workspace)
            with self.assertRaises((AttributeError, Exception)):
                key.cycle_id = "evil"  # type: ignore[misc]
            with self.assertRaises((AttributeError, Exception)):
                key.fingerprint = "SHA256:evil"  # type: ignore[misc]

    def test_i_v9_token_factory_mint_signing_key_files(self):
        """mint_signing_key writes private + public key files with
        correct permissions."""
        with tempfile.TemporaryDirectory() as workspace:
            if shutil.which("ssh-keygen") is None:
                self.skipTest("ssh-keygen not on PATH")
            key = _tf.mint_signing_key(cycle_id="test-cycle-002", workspace_root=workspace)
            self.assertTrue(key.private_key_path.exists())
            self.assertTrue(key.public_key_path.exists())
            # Private key MUST be mode 0600 (defense-in-depth)
            mode = key.private_key_path.stat().st_mode & 0o777
            self.assertEqual(
                mode, 0o600,
                f"private key mode={oct(mode)} expected=0o600",
            )

    def test_i_v9_token_factory_fingerprint_format(self):
        """fingerprint MUST start with 'SHA256:' (canonical ssh-keygen
        format)."""
        with tempfile.TemporaryDirectory() as workspace:
            if shutil.which("ssh-keygen") is None:
                self.skipTest("ssh-keygen not on PATH")
            key = _tf.mint_signing_key(cycle_id="test-cycle-003", workspace_root=workspace)
            self.assertTrue(
                key.fingerprint.startswith("SHA256:"),
                f"fingerprint format drifted: {key.fingerprint!r}",
            )

    def test_i_v9_token_factory_mint_signing_key_idempotent(self):
        """Re-minting the SAME cycle_id without overwrite=True returns
        the SAME fingerprint."""
        with tempfile.TemporaryDirectory() as workspace:
            if shutil.which("ssh-keygen") is None:
                self.skipTest("ssh-keygen not on PATH")
            k1 = _tf.mint_signing_key(cycle_id="test-cycle-004", workspace_root=workspace)
            k2 = _tf.mint_signing_key(cycle_id="test-cycle-004", workspace_root=workspace)
            self.assertEqual(k1.fingerprint, k2.fingerprint)

    def test_i_v9_token_factory_mint_signing_key_overwrite(self):
        """overwrite=True regenerates the key → different fingerprint."""
        with tempfile.TemporaryDirectory() as workspace:
            if shutil.which("ssh-keygen") is None:
                self.skipTest("ssh-keygen not on PATH")
            k1 = _tf.mint_signing_key(cycle_id="test-cycle-005", workspace_root=workspace)
            k2 = _tf.mint_signing_key(cycle_id="test-cycle-005", workspace_root=workspace, overwrite=True)
            self.assertNotEqual(
                k1.fingerprint, k2.fingerprint,
                "overwrite=True MUST yield a fresh keypair",
            )

    def test_i_v9_token_factory_validate_cycle_id_format(self):
        """_validate_cycle_id rejects malformed inputs."""
        for bad in (
            "",
            "short",  # < 6 chars
            "x" * 65,  # > 64 chars
            "with space",
            "with/slash",
            "with.dot",
            "with$dollar",
        ):
            with self.assertRaises(ValueError, msg=f"cycle_id={bad!r} should reject"):
                _tf._validate_cycle_id(bad)

    def test_i_v9_token_factory_validate_cycle_id_accepts(self):
        """Canonical cycle_id formats accepted."""
        for good in (
            "abc123",
            "cycle-2026-05-18-001",
            "T143056Z_cycle1",
        ):
            _tf._validate_cycle_id(good)  # MUST NOT raise


class TestV9InstallationTokenFactory(unittest.TestCase):

    def test_i_v9_token_factory_installation_lease_frozen(self):
        """InstallationTokenLease is frozen."""
        with tempfile.TemporaryDirectory() as workspace:
            with mock.patch.dict(os.environ, {"GH_TOKEN": "ghp_test_token_for_fallback"}):
                # V10.3-B prereq — Mode B tests MUST scrub the Mode A
                # enforcement gate so the test exercises the fallback
                # branch (not the new ARIA_REQUIRE_MODE_A hard-fail).
                # Operator's /root/.config/gh/environment.sh exports
                # ARIA_REQUIRE_MODE_A=true; that leaks into test env
                # unless explicitly popped.
                os.environ.pop("ARIA_GH_APP_INSTALLATION_ID", None)
                os.environ.pop("ARIA_REQUIRE_MODE_A", None)
                lease = _tf.mint_installation_token(
                    cycle_id="lease-test-001",
                    workspace_root=workspace,
                )
                with self.assertRaises((AttributeError, Exception)):
                    lease.fallback_active = False  # type: ignore[misc]

    def test_i_v9_token_factory_fallback_mode_when_no_app(self):
        """Mode B — without ARIA_GH_APP_INSTALLATION_ID, the lease
        falls back to operator PAT with fallback_active=True."""
        with tempfile.TemporaryDirectory() as workspace:
            with mock.patch.dict(os.environ, {"GH_TOKEN": "ghp_test_fallback"}):
                os.environ.pop("ARIA_GH_APP_INSTALLATION_ID", None)
                os.environ.pop("ARIA_REQUIRE_MODE_A", None)
                lease = _tf.mint_installation_token(
                    cycle_id="fallback-001",
                    workspace_root=workspace,
                )
                self.assertTrue(
                    lease.fallback_active,
                    "fallback_active MUST be True when no GH App configured",
                )
                self.assertIsNone(lease.gh_app_installation_id)
                self.assertEqual(lease.cycle_id, "fallback-001")
                self.assertTrue(lease.token_file.exists())
                # Token file mode 0600
                mode = lease.token_file.stat().st_mode & 0o777
                self.assertEqual(mode, 0o600)

    def test_i_v9_token_factory_fallback_writes_pat_content(self):
        """Fallback mode writes the PAT verbatim to the lease file."""
        with tempfile.TemporaryDirectory() as workspace:
            sentinel = "ghp_sentinel_value_for_verification"
            with mock.patch.dict(os.environ, {"GH_TOKEN": sentinel}):
                os.environ.pop("ARIA_GH_APP_INSTALLATION_ID", None)
                os.environ.pop("ARIA_REQUIRE_MODE_A", None)
                lease = _tf.mint_installation_token(
                    cycle_id="fallback-002",
                    workspace_root=workspace,
                )
                self.assertEqual(lease.token_file.read_text(), sentinel)

    def test_i_v9_token_factory_no_token_no_app_raises(self):
        """Neither GH App nor PAT → mint MUST raise RuntimeError.

        Scrubs ARIA_REQUIRE_MODE_A so the assertion exercises the
        actual "no token AND no app" branch (not the Mode A gate).
        """
        with tempfile.TemporaryDirectory() as workspace:
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("GH_TOKEN", None)
                os.environ.pop("GITHUB_TOKEN", None)
                os.environ.pop("ARIA_GH_APP_INSTALLATION_ID", None)
                os.environ.pop("ARIA_REQUIRE_MODE_A", None)
                with self.assertRaises(RuntimeError) as ctx:
                    _tf.mint_installation_token(
                        cycle_id="should-fail-001",
                        workspace_root=workspace,
                    )
                self.assertIn(
                    "No GH App installation AND no operator PAT",
                    str(ctx.exception),
                    "RuntimeError MUST come from the no-credentials branch, "
                    "not the Mode A enforcement gate",
                )

    def test_i_v9_token_factory_revoke_cleans_file(self):
        """revoke_installation_token deletes the token file."""
        with tempfile.TemporaryDirectory() as workspace:
            with mock.patch.dict(os.environ, {"GH_TOKEN": "ghp_revoke_test"}):
                os.environ.pop("ARIA_GH_APP_INSTALLATION_ID", None)
                os.environ.pop("ARIA_REQUIRE_MODE_A", None)
                lease = _tf.mint_installation_token(
                    cycle_id="revoke-test-001",
                    workspace_root=workspace,
                )
                self.assertTrue(lease.token_file.exists())
                _tf.revoke_installation_token(lease=lease)
                self.assertFalse(lease.token_file.exists())

    def test_i_v9_token_factory_require_mode_a_blocks_fallback(self):
        """Plan ARIA-V10.3-B prereq — ARIA_REQUIRE_MODE_A=true MUST
        hard-fail when ARIA_GH_APP_INSTALLATION_ID is unset.

        Positive coverage for the SEC-CRIT-003 gate at
        gh_token_factory.py line ~436. Without this test the gate
        could regress silently — the previous V9.0-C tests only
        cover the Mode B happy path.
        """
        with tempfile.TemporaryDirectory() as workspace:
            with mock.patch.dict(os.environ, {
                "GH_TOKEN": "ghp_should_be_refused",
                "ARIA_REQUIRE_MODE_A": "true",
            }):
                os.environ.pop("ARIA_GH_APP_INSTALLATION_ID", None)
                with self.assertRaises(RuntimeError) as ctx:
                    _tf.mint_installation_token(
                        cycle_id="mode-a-required-001",
                        workspace_root=workspace,
                    )
                msg = str(ctx.exception)
                self.assertIn(
                    "ARIA_REQUIRE_MODE_A=true",
                    msg,
                    "error MUST identify the Mode A enforcement gate",
                )
                self.assertIn(
                    "Mode B fallback FORBIDDEN",
                    msg,
                    "error MUST name what is forbidden",
                )


class TestV9TokenFactoryPublicApi(unittest.TestCase):

    def test_i_v9_token_factory_all_exports(self):
        """__all__ MUST contain the 7 canonical symbols.

        Plan ARIA-V9.0-C baseline pinned 5 symbols
        (SigningKey, InstallationTokenLease, mint_signing_key,
        mint_installation_token, revoke_installation_token).

        Plan ARIA-V3.1-P-6 (closes 6-validator audit C-11 R-V31-4)
        extends the surface by 2 — revoke_signing_key (per-cycle
        keypair cleanup) + prune_stale_signing_keys (orchestrator
        startup orphan reaper). The V3.1-P-extended contract is the
        new SSoT.
        """
        self.assertEqual(
            set(_tf.__all__),
            {
                "SigningKey",
                "InstallationTokenLease",
                "mint_signing_key",
                "mint_installation_token",
                "prune_stale_signing_keys",
                "revoke_installation_token",
                "revoke_signing_key",
            },
            "gh_token_factory.__all__ drifted",
        )


if __name__ == "__main__":
    unittest.main()
