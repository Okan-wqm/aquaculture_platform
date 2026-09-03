"""Plan ARIA-V3.1-D — cost attribution wire invariants.

Closes 6-validator audit findings:

* H-5 (cost ledger forgery): record_cost_attribution row carries
  signer_key_fp from the cycle's ephemeral key + Tier-3 drift
  detection on usage block.
* H-6 (scan_failing_ci token scope): gh_token kwarg + explicit
  env= override so a scoped READ_ACTIONS_ONLY token replaces the
  parent-env operator PAT under profile=autonomous.

Invariants:

* I-V31-D-01 — record_cost_attribution requires signer_key_fp
  starting with `SHA256:` format.
* I-V31-D-03 — usage drift > 50% records drift_flag="usage_block_drift"
  AND emits `usage_block_drift_rejected` governance event; the
  row is still recorded (not rejected).
* I-V31-D-04 — scan_failing_ci accepts gh_token kwarg + uses
  `env=` subprocess argument (not parent-env inherit) when token
  supplied.
"""
from __future__ import annotations

import inspect
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class CostAttributionSignerFpTests(unittest.TestCase):
    """Plan ARIA-V3.1-D-1+5 — signer_key_fp pinning."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31d-")).resolve()
        self.base = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_i_v31_d_01_record_pins_signer_key_fp_format(self) -> None:
        """Plan ARIA-V3.1-D-1 — signer_key_fp MUST start with
        `SHA256:`. None defaults to the `SHA256:no-key` sentinel so
        legacy V8 cycles still pass schema validation."""
        from aria_kernel.budget import record_cost_attribution
        # None → sentinel.
        row = record_cost_attribution(
            cycle_id="cyc-test", plan_id="plan-test",
            agent_role="primary_plan", model="claude-opus-4-7",
            input_tokens=100, output_tokens=200,
            estimated_usd=0.01, base_dir=self.base,
        )
        self.assertTrue(
            row["signer_key_fp"].startswith("SHA256:"),
            f"signer_key_fp does not start with SHA256:; got "
            f"{row['signer_key_fp']!r}",
        )
        self.assertEqual(row["signer_key_fp"], "SHA256:no-key")
        # Explicit fingerprint passes through.
        row2 = record_cost_attribution(
            cycle_id="cyc-test", plan_id="plan-test",
            agent_role="primary_plan", model="claude-opus-4-7",
            input_tokens=100, output_tokens=200,
            estimated_usd=0.01,
            signer_key_fp="SHA256:abc123def456",
            base_dir=self.base,
        )
        self.assertEqual(row2["signer_key_fp"], "SHA256:abc123def456")

    def test_i_v31_d_01_malformed_signer_fp_raises(self) -> None:
        """Non-SHA256: signer_key_fp MUST raise GovernanceError."""
        from aria_kernel.budget import record_cost_attribution
        from aria_kernel.tool_registry import GovernanceError
        with self.assertRaises(GovernanceError) as ctx:
            record_cost_attribution(
                cycle_id="cyc", plan_id="plan",
                agent_role="primary_plan", model="m",
                input_tokens=1, output_tokens=1, estimated_usd=0.0,
                signer_key_fp="invalid-format-no-prefix",
                base_dir=self.base,
            )
        self.assertIn("SHA256:", str(ctx.exception))


class CostAttributionDriftDetectionTests(unittest.TestCase):
    """Plan ARIA-V3.1-D-3 — usage drift detection."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31d-drift-")).resolve()
        self.base = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_i_v31_d_03_drift_over_50pct_flagged(self) -> None:
        """Plan ARIA-V3.1-D-3 — actual input_tokens differing from
        estimated_input_tokens by > 50% sets drift_flag +
        emits governance event. The row is still recorded."""
        from aria_kernel.budget import record_cost_attribution
        row = record_cost_attribution(
            cycle_id="cyc-drift", plan_id="plan-drift",
            agent_role="primary_plan", model="claude-opus-4-7",
            input_tokens=10_000,           # 10x estimate
            output_tokens=200,
            estimated_usd=0.1,
            estimated_input_tokens=1_000,
            signer_key_fp="SHA256:test123",
            base_dir=self.base,
        )
        self.assertEqual(row["drift_flag"], "usage_block_drift")
        # Governance event fired.
        gov = self.base / "governance.jsonl"
        self.assertTrue(gov.exists())
        rows = [
            json.loads(line) for line in
            gov.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        drift_events = [r for r in rows
                        if r.get("kind") == "usage_block_drift_rejected"]
        self.assertEqual(len(drift_events), 1)
        self.assertEqual(
            drift_events[0]["details"]["cycle_id"], "cyc-drift",
        )

    def test_i_v31_d_03_drift_under_50pct_clean(self) -> None:
        """Plan ARIA-V3.1-D-3 — drift within 50% threshold: no flag,
        no governance event."""
        from aria_kernel.budget import record_cost_attribution
        row = record_cost_attribution(
            cycle_id="cyc-no-drift", plan_id="plan-no-drift",
            agent_role="primary_plan", model="claude-opus-4-7",
            input_tokens=1_200,  # 20% over estimate — within threshold
            output_tokens=200,
            estimated_usd=0.05,
            estimated_input_tokens=1_000,
            signer_key_fp="SHA256:test-nodrift",
            base_dir=self.base,
        )
        self.assertIsNone(row["drift_flag"])


class ScanFailingCiTokenScopeTests(unittest.TestCase):
    """Plan ARIA-V3.1-D-4 — scan_failing_ci scoped token + env=."""

    def test_i_v31_d_04_scan_failing_ci_accepts_gh_token_kwarg(self) -> None:
        """Plan ARIA-V3.1-D-4 — scan_failing_ci signature includes
        `gh_token: str | None = None` kwarg."""
        from aria_kernel.plan_synthesizer import scan_failing_ci
        sig = inspect.signature(scan_failing_ci)
        self.assertIn("gh_token", sig.parameters)
        token_param = sig.parameters["gh_token"]
        self.assertIs(token_param.default, None)

    def test_i_v31_d_04_subprocess_env_passes_scoped_token(self) -> None:
        """Plan ARIA-V3.1-D-4 — when gh_token is supplied, the
        subprocess.run call uses env={"GH_TOKEN": gh_token, "PATH":
        ...} (NOT parent-env inherit)."""
        from aria_kernel.plan_synthesizer import scan_failing_ci
        captured_env: dict[str, str | None] = {"value": None}
        def fake_run(*args, **kwargs):
            captured_env["value"] = kwargs.get("env")
            # Simulate gh failure so the scan returns []; we only
            # care about the env kwarg.
            class _Result:
                returncode = 1
                stdout = ""
                stderr = ""
            return _Result()
        tmp = Path(tempfile.mkdtemp(prefix="v31d-env-")).resolve()
        try:
            # shutil is imported inside scan_failing_ci (local import);
            # patch the top-level shutil.which directly.
            with patch("aria_kernel.plan_synthesizer.subprocess.run",
                       side_effect=fake_run):
                with patch("shutil.which", return_value="/usr/bin/gh"):
                    scan_failing_ci(
                        workspace_root=tmp,
                        gh_token="scoped-token-abc123",
                    )
            self.assertIsNotNone(captured_env["value"])
            env = captured_env["value"]
            self.assertEqual(env.get("GH_TOKEN"), "scoped-token-abc123")
            self.assertIn("PATH", env)
            # Critical: the env is a NEW dict, not the parent env.
            # Spot-check that an OPERATOR-only env var is absent.
            self.assertNotIn("ARIA_TOOLS_DIR", env)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
