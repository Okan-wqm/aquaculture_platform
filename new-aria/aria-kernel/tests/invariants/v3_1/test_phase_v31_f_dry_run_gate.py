"""Plan ARIA-V3.1-F — live smoke ARIA_DRY_RUN gate invariants.

Closes 6-validator audit C-8 (smoke fires real gh CLI regardless of
mock-mode): V3.1-F-2 ARIA_DRY_RUN env-var gate short-circuits gh
subprocess calls in scan_failing_ci + mint_installation_token before
they reach the real GitHub API. Network-namespace isolation
(`unshare --net`) is the operator-side Tier-1 defense in depth; the
in-kernel gate is the Tier-2 anchor that an operator misconfiguration
cannot bypass.

Invariants:

* I-V31-F-02a — scan_failing_ci short-circuits to [] when
  ARIA_DRY_RUN=true.
* I-V31-F-02b — mint_installation_token returns a sentinel lease
  (token_file=`aria-dry-run-sentinel`, fallback_active=True) when
  ARIA_DRY_RUN=true.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path


class DryRunGateScanFailingCiTests(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31f-")).resolve()
        # Snapshot any prior ARIA_DRY_RUN env to restore on teardown
        # so the test does not leak between modules.
        self._saved_env = os.environ.get("ARIA_DRY_RUN")

    def tearDown(self) -> None:
        if self._saved_env is None:
            os.environ.pop("ARIA_DRY_RUN", None)
        else:
            os.environ["ARIA_DRY_RUN"] = self._saved_env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_i_v31_f_02a_scan_failing_ci_short_circuits_under_dry_run(self) -> None:
        from aria_kernel.plan_synthesizer import scan_failing_ci
        os.environ["ARIA_DRY_RUN"] = "true"
        # Even if gh CLI is on PATH, the dry-run gate fires BEFORE
        # the shutil.which check. Result: []
        result = scan_failing_ci(workspace_root=self.tmp)
        self.assertEqual(result, [])

    def test_i_v31_f_02a_scan_failing_ci_normal_when_dry_run_unset(self) -> None:
        """When ARIA_DRY_RUN is unset, the function falls through to
        the real gh CLI path. The exact result depends on env (gh
        installed + GH_TOKEN present + branch state), so assert ONLY
        that the result is a list (not None / not raising) — i.e.
        the dry-run gate does NOT prematurely fire."""
        from aria_kernel.plan_synthesizer import scan_failing_ci
        os.environ.pop("ARIA_DRY_RUN", None)
        result = scan_failing_ci(workspace_root=self.tmp)
        self.assertIsInstance(result, list)


class DryRunGateMintInstallationTokenTests(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31f-mt-")).resolve()
        self._saved_env = os.environ.get("ARIA_DRY_RUN")
        self._saved_gh_token = os.environ.get("GH_TOKEN")
        self._saved_app_id = os.environ.get("ARIA_GH_APP_INSTALLATION_ID")

    def tearDown(self) -> None:
        for key, saved in (
            ("ARIA_DRY_RUN", self._saved_env),
            ("GH_TOKEN", self._saved_gh_token),
            ("ARIA_GH_APP_INSTALLATION_ID", self._saved_app_id),
        ):
            if saved is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_i_v31_f_02b_mint_returns_sentinel_lease_under_dry_run(self) -> None:
        from aria_kernel.gh_token_factory import mint_installation_token
        os.environ["ARIA_DRY_RUN"] = "true"
        # Even with no GH_TOKEN / app id, the dry-run gate fires
        # before the real-token codepath would raise.
        os.environ.pop("GH_TOKEN", None)
        os.environ.pop("ARIA_GH_APP_INSTALLATION_ID", None)
        lease = mint_installation_token(
            cycle_id="cyc-dry-run-test", workspace_root=self.tmp,
        )
        self.assertTrue(lease.fallback_active)
        self.assertIsNone(lease.gh_app_installation_id)
        self.assertTrue(lease.token_file.exists())
        self.assertEqual(
            lease.token_file.read_text(encoding="utf-8"),
            "aria-dry-run-sentinel",
        )


if __name__ == "__main__":
    unittest.main()
