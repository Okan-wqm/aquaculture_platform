"""Plan ARIA-V3.1-B3 — orphan reaper orchestrator wire + 3
AutonomousV9ImplementationRunner integration tests.

Closes architectural anchors from V3.1-B2 that need orchestrator-side
invocation + the AutonomousV9ImplementationRunner.run() pipeline
exercise:

* H-12 second half — orchestrator startup hook actually CALLS
  scan_orphan_implementation_requests + reaps each via
  record_implementation_rejected.
* H-11 — 3 integration tests covering the MERGED, REJECTED, TIMEOUT
  paths through AutonomousV9ImplementationRunner.run() with mocked
  dependencies (mint_signing_key, mint_installation_token,
  issue_implementation_envelope, fold_plan_state).

Invariants:

* I-V31-B3-01 — orchestrator body invokes scan_orphan_implementation_requests
  at startup (source-substring + behavioral test).
* I-V31-B3-02 — orphan plan_ids transition to IMPLEMENTATION_REJECTED
  with rejection_class="orchestrator_restart_reaped_orphan"
  (behavioral test with patched scanner).
* I-V31-B3-03 — implementation_orphans_reaped_summary governance
  event emitted when ≥1 orphan reaped.
* I-V31-B3-MERGED — runner.run() returns terminal_state=IMPLEMENTATION_MERGED
  + signal=review_merged_pr when fold returns MERGED state.
* I-V31-B3-REJECTED — runner.run() returns IMPLEMENTATION_REJECTED
  + signal=review_rejected_pr when fold returns REJECTED state.
* I-V31-B3-TIMEOUT — runner.run() returns IMPLEMENTATION_TIMEOUT
  + signal=review_converged_plan when fold never returns terminal
  before implementer_poll_seconds expires.
"""
from __future__ import annotations

import inspect
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


class OrchestratorOrphanReaperHookTests(unittest.TestCase):
    """Plan ARIA-V3.1-B3-01..03 — orchestrator startup orphan reaper."""

    def test_i_v31_b3_01_orchestrator_invokes_orphan_scanner(self) -> None:
        """Plan ARIA-V3.1-B3-01 — source-substring test: the orchestrator
        body imports + calls scan_orphan_implementation_requests +
        record_implementation_rejected."""
        from aria_kernel import autonomy_orchestrator
        src = inspect.getsource(autonomy_orchestrator.run_autonomy_orchestrator)
        self.assertIn("scan_orphan_implementation_requests", src)
        self.assertIn("record_implementation_rejected", src)
        self.assertIn("orchestrator_restart_reaped_orphan", src)
        self.assertIn("implementation_orphan_reaped", src)

    def test_i_v31_b3_02_orphan_reaping_emits_governance_events(self) -> None:
        """Plan ARIA-V3.1-B3-02 + B3-03 — behavioral: when the scanner
        returns orphans, the orchestrator startup hook fires
        record_implementation_rejected per orphan + emits
        implementation_orphan_reaped + implementation_orphans_reaped_summary.
        """
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
        from aria_kernel.runtime_profile import set_profile
        tmp = Path(tempfile.mkdtemp(prefix="v31b3-")).resolve()
        base = tmp / "aria-tools"
        try:
            set_profile(
                "standard", operator_approval_ref="v31b3-test",
                base_dir=base,
            )
            # Patch the scanner to return 2 synthetic orphans + patch
            # record_implementation_rejected so we don't need to drive
            # the full state machine.
            recorded: list[dict] = []
            def _fake_rejected(*, plan_id, rejection_class, rejected_at,
                               base_dir=None):
                recorded.append({
                    "plan_id": plan_id,
                    "rejection_class": rejection_class,
                })
                return {"event_type": "implementation_rejected"}
            with patch(
                "aria_kernel.plan_convergence.scan_orphan_implementation_requests",
                return_value=[
                    {"plan_id": "orphan-1", "state": "IMPLEMENTATION_REQUESTED",
                     "last_event_at": "2026-05-19T00:00:00Z"},
                    {"plan_id": "orphan-2", "state": "IMPLEMENTATION_IN_FLIGHT",
                     "last_event_at": "2026-05-19T00:01:00Z"},
                ],
            ), patch(
                "aria_kernel.plan_convergence.record_implementation_rejected",
                side_effect=_fake_rejected,
            ):
                run_autonomy_orchestrator(
                    base_dir=base,
                    workspace_root=str(tmp),
                    profile="standard",
                    max_cycles=0,  # Skip cycle loop; only test reaper.
                    auto_merge_runner=lambda **kw: {"status": "skipped"},
                    github_adapter=object(),
                    convergence_runner=lambda **kw: {"arbiter_verdict": "split"},
                    review_runner=lambda **kw: {"review_verdict": "gaps_open"},
                    specialist_review_runner=lambda **kw: {
                        "consolidated_verdict": "specialists_unavailable",
                    },
                    plan_synthesizer=lambda **kw: None,
                    skill_genesis_drainer=lambda **kw: {"aggregate_verdict": "no_requests"},
                    cycle_runner=lambda **kw: {"status": "ok"},
                    planner_drainer=lambda **kw: {"claims_dispatched": 0},
                    worker_drainer=lambda **kw: {"assignments_dispatched": 0},
                    bridge_drainer=lambda **kw: {"status": "ok"},
                )
            # 2 orphans reaped.
            self.assertEqual(len(recorded), 2)
            self.assertEqual(
                {r["rejection_class"] for r in recorded},
                {"orchestrator_restart_reaped_orphan"},
            )
            # Governance events landed.
            gov = base / "governance.jsonl"
            rows = [
                json.loads(line) for line in
                gov.read_text(encoding="utf-8").splitlines() if line.strip()
            ]
            reap_events = [
                r for r in rows if r.get("kind") == "implementation_orphan_reaped"
            ]
            summary_events = [
                r for r in rows
                if r.get("kind") == "implementation_orphans_reaped_summary"
            ]
            self.assertEqual(len(reap_events), 2)
            self.assertEqual(len(summary_events), 1)
            self.assertEqual(summary_events[0]["details"]["reaped_count"], 2)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class AutonomousRunnerMergedPathTests(unittest.TestCase):
    """Plan ARIA-V3.1-B3-MERGED — AutonomousV9ImplementationRunner
    happy path: poll loop sees IMPLEMENTATION_MERGED → terminal +
    review_merged_pr signal."""

    def _run_path(self, fold_state: dict) -> object:
        """Drive AutonomousV9ImplementationRunner.run with mocked
        mint + envelope + fold. Returns the V9ImplementationResult."""
        from aria_kernel.cycle_phases.implementer import (
            AutonomousV9ImplementationRunner,
        )
        from aria_kernel.gh_token_factory import (
            InstallationTokenLease, SigningKey,
        )
        tmp = Path(tempfile.mkdtemp(prefix="v31b3-run-")).resolve()
        try:
            fake_key = SigningKey(
                cycle_id="cyc-test",
                private_key_path=tmp / "key",
                public_key_path=tmp / "key.pub",
                fingerprint="SHA256:test-fp",
            )
            fake_lease = InstallationTokenLease(
                cycle_id="cyc-test",
                token_file=tmp / "key.token",
                ttl_seconds=300,
                gh_app_installation_id=None,
                fallback_active=True,
                minted_at_utc="2026-05-19T00:00:00Z",
            )
            patches = [
                patch(
                    "aria_kernel.gh_token_factory.mint_signing_key",
                    return_value=fake_key,
                ),
                patch(
                    "aria_kernel.gh_token_factory.mint_installation_token",
                    return_value=fake_lease,
                ),
                patch(
                    "aria_kernel.cross_review_bridge.issue_implementation_envelope",
                    return_value={"request_id": "AIR-impl-001"},
                ),
                patch(
                    "aria_kernel.plan_convergence.fold_plan_state",
                    return_value=fold_state,
                ),
                patch(
                    "aria_kernel.gh_token_factory.revoke_signing_key",
                    return_value={"removed": [], "missing": []},
                ),
                patch(
                    "aria_kernel.gh_token_factory.revoke_installation_token",
                    return_value=None,
                ),
            ]
            for p in patches:
                p.start()
            try:
                runner = AutonomousV9ImplementationRunner()
                # Short poll so timeout path runs quickly in tests.
                return runner.run(
                    cycle_id="cyc-test", plan_id="plan-test",
                    workspace_root=tmp, base_dir=tmp / "aria-tools",
                    converged_plan={"plan_id": "plan-test",
                                    "must_satisfy": [],
                                    "evidence_refs": [],
                                    "allowed_scope": []},
                    cross_review_summary={"verdict": "agreed"},
                    profile="autonomous",
                    implementer_poll_seconds=1.0,
                )
            finally:
                for p in patches:
                    p.stop()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_i_v31_b3_merged_path(self) -> None:
        result = self._run_path({"state": "IMPLEMENTATION_MERGED",
                                  "pr_url": "https://example/pr/1"})
        self.assertEqual(result.terminal_state, "IMPLEMENTATION_MERGED")
        self.assertEqual(result.specialist_review_signal, "review_merged_pr")

    def test_i_v31_b3_rejected_path(self) -> None:
        result = self._run_path({"state": "IMPLEMENTATION_REJECTED",
                                  "rejection_class": "validation_failed"})
        self.assertEqual(result.terminal_state, "IMPLEMENTATION_REJECTED")
        self.assertEqual(result.specialist_review_signal, "review_rejected_pr")
        self.assertEqual(result.rejection_class, "validation_failed")

    def test_i_v31_b3_timeout_path(self) -> None:
        """Plan ARIA-V3.1-B3-TIMEOUT — fold never returns terminal;
        poll deadline expires; runner returns IMPLEMENTATION_TIMEOUT."""
        # State that's neither MERGED nor REJECTED; poll deadline of
        # 1s in _run_path means we exit timeout quickly.
        result = self._run_path({"state": "IMPLEMENTATION_IN_FLIGHT"})
        self.assertEqual(result.terminal_state, "IMPLEMENTATION_TIMEOUT")
        self.assertEqual(result.specialist_review_signal, "review_converged_plan")


if __name__ == "__main__":
    unittest.main()
