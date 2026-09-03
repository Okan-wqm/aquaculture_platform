"""Plan ARIA-V3.1-B3 — orphan reaper orchestrator wire + 3
AutonomousV9ImplementationRunner integration tests.

Closes architectural anchors from V3.1-B2 that need orchestrator-side
invocation + the AutonomousV9ImplementationRunner.run() pipeline
exercise:

* H-12 second half — orchestrator startup hook actually CALLS
  scan_orphan_implementation_requests + reaps each via
  record_implementation_rejected.
* H-11 — integration tests over AutonomousV9ImplementationRunner.run()
  with mocked dependencies (mint_signing_key, mint_installation_token,
  stage_converged_plan_for_pr, issue_implementation_envelope).

Invariants:

* I-V31-B3-01 — orchestrator body invokes scan_orphan_implementation_requests
  at startup (source-substring + behavioral test).
* I-V31-B3-02 — orphan plan_ids transition to IMPLEMENTATION_REJECTED
  with rejection_class="orchestrator_restart_reaped_orphan"
  (behavioral test with patched scanner).
* I-V31-B3-03 — implementation_orphans_reaped_summary governance
  event emitted when ≥1 orphan reaped.
* I-V31-B3-DISPATCH (K6, ORPHAN-CRITICAL-727) — REPLACES the MERGED /
  REJECTED / TIMEOUT path tests. Those three drove a poll loop that no
  longer exists, and they only ever passed because they patched
  ``fold_plan_state`` with a mock: the real function is keyword-only, the
  runner called it POSITIONALLY, and every production invocation raised
  TypeError past the ``except (KeyError, ValueError, GovernanceError)``
  arm. A mock that accepts a call the real callee refuses is not a test of
  the path — it is a test of the mock. The successor pins what the phase
  now does: stage the plan, mint the envelope carrying the staged ids,
  return IMPLEMENTATION_DISPATCHED, and never wait.
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
            # ORPHAN-HIGH-729 — these stamps are now LOAD-BEARING, not
            # decoration. The reap is age-bounded by
            # `ORPHAN_IMPLEMENTATION_REAP_AFTER_HOURS`, so an orphan is only
            # collected once it is provably past the executor's window; a
            # fixture stamped "now" would make this invariant assert the
            # opposite of what it reads as. 2026-05-19 is unambiguously past
            # any window and stays that way, since dates only move forward.
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
            # ORPHAN-HIGH-729 — both were past the window, so nothing was
            # spared. Stating it keeps this from silently becoming a
            # zero-orphan pass if the fixture stamps ever drift into it.
            self.assertEqual(summary_events[0]["details"]["spared_recent_count"], 0)
            self.assertEqual(
                summary_events[0]["details"]["escalated_undateable_count"], 0,
            )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class AutonomousRunnerDispatchPathTests(unittest.TestCase):
    """K6 (ORPHAN-CRITICAL-727) — mint-and-return, with the staged ids.

    The runner's contract in one sentence: it stages the CONVERGED plan for
    PR, mints the implementation envelope carrying {proposal_id, change_id,
    branch}, and returns IMPLEMENTATION_DISPATCHED without waiting for
    anything. The executor lane claims the envelope in a later workflow run.
    """

    STAGED = {
        "proposal_id": "proposal-b3",
        "change_id": "chg-b3",
        "branch": "aria-impl-0123456789abcdef",
        "baseline_ref": "sha256:baseline-b3",
        "base_sha": "abc1234",
    }

    def _run(self, *, stage_side_effect=None):
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
            envelope_mock = MagicMock(return_value={"request_id": "AIR-impl-001"})
            stage_mock = MagicMock(
                return_value=dict(self.STAGED), side_effect=stage_side_effect,
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
                patch("aria_kernel.apply_engine.stage_converged_plan_for_pr", stage_mock),
                patch(
                    "aria_kernel.cross_review_bridge.issue_implementation_envelope",
                    envelope_mock,
                ),
                patch(
                    "aria_kernel.gh_token_factory.revoke_signing_key",
                    return_value={"removed": [], "missing": []},
                ),
                patch(
                    "aria_kernel.gh_token_factory.revoke_installation_token",
                    return_value=None,
                ),
                patch("aria_kernel.tool_registry.append_tools_governance", MagicMock()),
            ]
            for item in patches:
                item.start()
            try:
                result = AutonomousV9ImplementationRunner().run(
                    cycle_id="cyc-test", plan_id="plan-test",
                    workspace_root=tmp, base_dir=tmp / "aria-tools",
                    cross_review_summary={"verdict": "agreed"},
                    profile="autonomous",
                )
            finally:
                for item in patches:
                    item.stop()
            return result, stage_mock, envelope_mock
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_i_v31_b3_dispatch_returns_without_waiting(self) -> None:
        result, stage_mock, envelope_mock = self._run()
        self.assertEqual(result.terminal_state, "IMPLEMENTATION_DISPATCHED")
        self.assertEqual(result.specialist_review_signal, "review_converged_plan")
        self.assertIsNone(result.pr_url)
        self.assertIsNone(result.rejection_class)
        self.assertEqual(stage_mock.call_count, 1)

    def test_i_v31_b3_envelope_carries_the_staged_ids(self) -> None:
        """The whole point of staging: the agent is told which rows to name.

        An envelope without them sends the implementer to `apply gate` and
        `pr create` with ids nobody minted — the refusal that ended every
        CONVERGED plan before ORPHAN-CRITICAL-727.
        """
        _result, _stage, envelope_mock = self._run()
        kwargs = envelope_mock.call_args.kwargs
        self.assertEqual(kwargs["proposal_id"], self.STAGED["proposal_id"])
        self.assertEqual(kwargs["change_id"], self.STAGED["change_id"])
        self.assertEqual(kwargs["branch"], self.STAGED["branch"])
        # ORPHAN-CRITICAL-728 — and the commit staging measured its baseline
        # at, so the agent branches from it rather than from origin/main.
        self.assertEqual(kwargs["base_sha"], self.STAGED["base_sha"])

    def test_i_v31_b3_the_mint_takes_no_plan_content_from_its_caller(self) -> None:
        """The pin that would have caught ORPHAN-CRITICAL-728.

        Every existing pin in this class MOCKS the mint, so a required
        parameter with no producer is invisible to them: the mock accepts
        `must_satisfy=[]` happily while the real function refuses it and every
        CONVERGED plan dies there. A mock cannot testify about a contract, but
        a SIGNATURE can — and the contract that matters is that the mint
        derives plan content from the ledger instead of accepting it.
        """
        from aria_kernel.cross_review_bridge import issue_implementation_envelope

        params = set(
            inspect.signature(issue_implementation_envelope).parameters,
        )
        forbidden = {
            "must_satisfy", "allowed_scope", "evidence_refs",
            "converged_plan", "converged_plan_text",
            "converged_plan_revision_id", "plan_revision_hash",
        }
        self.assertEqual(
            params & forbidden, set(),
            "the implementation envelope must DERIVE plan content from the "
            "plan ledger; a parameter here is a claim a caller can get wrong "
            "and — for must_satisfy/allowed_scope — one no plan schema can "
            "produce at all",
        )
        # Same contract on the staging producer: it folds the plan already.
        from aria_kernel.apply_engine import stage_converged_plan_for_pr

        self.assertNotIn(
            "converged_plan",
            inspect.signature(stage_converged_plan_for_pr).parameters,
        )

    def test_i_v31_b3_staging_refusal_stops_before_the_envelope(self) -> None:
        """A plan that cannot be staged must not be dispatched.

        The envelope mint is the CONVERGED -> IMPLEMENTATION_REQUESTED
        transition and it is not reversible; minting after a staging failure
        would strand the plan in a state whose agent has no ids to use.
        """
        from aria_kernel.tool_registry import GovernanceError

        result, _stage, envelope_mock = self._run(
            stage_side_effect=GovernanceError("stage_requires_converged_plan: x"),
        )
        self.assertEqual(result.terminal_state, "IMPLEMENTATION_REQUEST_REFUSED")
        self.assertEqual(result.rejection_class, "staging_governance_error")
        self.assertEqual(envelope_mock.call_count, 0)

    def test_i_v31_b3_fold_plan_state_is_keyword_only(self) -> None:
        """Why the deleted poll never worked in production.

        ``fold_plan_state`` is keyword-only; the poll called it positionally,
        so every real invocation raised TypeError — which its except arm did
        not catch. Pinning the signature keeps a future author from
        reintroducing the positional call that the mocks used to hide.
        """
        from aria_kernel.plan_convergence import fold_plan_state

        params = inspect.signature(fold_plan_state).parameters
        self.assertEqual(
            [name for name, param in params.items()
             if param.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD],
            [],
        )


if __name__ == "__main__":
    unittest.main()
