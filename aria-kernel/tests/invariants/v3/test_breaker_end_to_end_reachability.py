"""ORPHAN-CRITICAL-420 — the failure breaker is REACHABLE end to end.

What this proves
================
Every other breaker test exercises one link: the arithmetic, the fail-closed
evidence handling, the profile scope, or the producer callsite. All of them
passed while the chain as a whole could not fire, because a chain is not the
sum of its links.

This test runs the REAL chain with only the data sources faked:

    perimeter refusal  ->  cycle.py observation point
      ->  real record_failure  ->  real failures.jsonl
      ->  real evaluate_breaker (sliding window + threshold)
      ->  real _cycle_preflight  ->  cycle refused on `standard`

`list_proposals` and `open_pr_for_action` are patched because they are the
INPUTS to the mechanism, not the mechanism. record_failure, the ledger, the
window count, the verdict and the preflight are all genuine.

Why the threshold is read rather than hardcoded
-----------------------------------------------
An earlier analysis concluded the breaker could never trip: `threshold_24h` is
3, the nightly fires once per 24h, so "at most one row per window, 1 < 3,
forever". That held for the once-per-cycle subprocess_timeout producer it was
derived from. It does NOT hold for the producer actually wired: the
pr_lifecycle phase iterates every approved_for_apply proposal and records one
failure per perimeter-refused proposal, so a single cycle can write N rows.

Reading the live threshold keeps that conclusion honest -- if a future policy
raises it, this test still generates enough refusals to prove the chain closes,
instead of silently passing against a stale constant.
"""
from __future__ import annotations

import tempfile
import unittest
import unittest.mock
from pathlib import Path

from aria_kernel import cycle as cycle_mod
from aria_kernel.autonomy_orchestrator import _cycle_preflight
from aria_kernel.circuit_breaker import evaluate_breaker
from aria_kernel.pr_manager import PERIMETER_REFUSED_PREFIX
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class BreakerEndToEndReachabilityTests(unittest.TestCase):

    def test_refused_proposals_trip_the_breaker_and_halt_the_next_cycle(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-420-e2e-") as tmp:
            base = Path(tmp) / "aria-tools"
            ensure_tools_dir(base)

            # The shipped threshold, whatever it currently is.
            threshold = evaluate_breaker(base).threshold_24h
            self.assertGreater(threshold, 0)

            # Baseline: nothing has failed, so a standard cycle may proceed.
            self.assertEqual(
                _cycle_preflight(base_dir=base, profile_snapshot="standard"),
                ("ok", None),
            )

            proposals = [
                {"proposal_id": f"PROP-{i}", "status": "approved_for_apply"}
                for i in range(threshold)
            ]
            refusal = GovernanceError(
                f"{PERIMETER_REFUSED_PREFIX}: secret_scan_diff_clean:"
                " staged diff carries a credential-shaped token"
            )

            with unittest.mock.patch(
                "aria_kernel.proposal.list_proposals", return_value=proposals,
            ), unittest.mock.patch(
                "aria_kernel.pr_manager.open_pr_for_action", side_effect=refusal,
            ):
                out = cycle_mod._run_pr_lifecycle_phase(
                    workspace_root=Path(tmp), base_dir=base,
                )

            # Every proposal was refused and reported as such.
            self.assertEqual(out["status"], "fail")
            self.assertEqual(out["fail"], threshold)
            self.assertTrue(all(not p["passed"] for p in out["proposals"]))
            # ...and none of them silently lost its breaker row.
            self.assertFalse(
                any("breaker_record_error" in p for p in out["proposals"]),
                "a breaker write failed; the chain is not being exercised",
            )

            # The ledger reached the threshold through the REAL window count.
            verdict = evaluate_breaker(base)
            self.assertEqual(verdict.sliding_count, threshold)
            self.assertEqual(verdict.state, "tripped")
            self.assertEqual(verdict.reason, "threshold_exceeded")

            # And the reader now halts the profile the scheduled lane runs.
            self.assertEqual(
                _cycle_preflight(base_dir=base, profile_snapshot="standard"),
                ("blocked", "failure_breaker_tripped"),
            )

    def test_one_refusal_short_of_the_threshold_does_not_halt(self) -> None:
        """The control must stop a burst, not punish a single rejection."""
        with tempfile.TemporaryDirectory(prefix="aria-420-e2e-under-") as tmp:
            base = Path(tmp) / "aria-tools"
            ensure_tools_dir(base)
            threshold = evaluate_breaker(base).threshold_24h
            proposals = [
                {"proposal_id": f"PROP-{i}", "status": "approved_for_apply"}
                for i in range(threshold - 1)
            ]
            with unittest.mock.patch(
                "aria_kernel.proposal.list_proposals", return_value=proposals,
            ), unittest.mock.patch(
                "aria_kernel.pr_manager.open_pr_for_action",
                side_effect=GovernanceError(f"{PERIMETER_REFUSED_PREFIX}: x:y"),
            ):
                cycle_mod._run_pr_lifecycle_phase(
                    workspace_root=Path(tmp), base_dir=base,
                )
            verdict = evaluate_breaker(base)
            self.assertEqual(verdict.sliding_count, threshold - 1)
            self.assertEqual(verdict.state, "ok")
            self.assertEqual(
                _cycle_preflight(base_dir=base, profile_snapshot="standard"),
                ("ok", None),
            )


if __name__ == "__main__":
    unittest.main()
