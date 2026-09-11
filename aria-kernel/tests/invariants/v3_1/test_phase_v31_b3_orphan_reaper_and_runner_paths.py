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
from contextlib import ExitStack
from pathlib import Path
from typing import Any
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


class SignerReadyCallbackTests(unittest.TestCase):
    """The runner lends public provenance without transferring key ownership."""

    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="v31b3-signer-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.workspace = self.root
        self.events: list[str] = []
        self.owned: set[str] = set()
        self.key: Any = None

    def _run(
        self,
        *,
        real_key: bool = False,
        failure_at: str | None = None,
        failure: BaseException | None = None,
        runner: Any = None,
        **kwargs: Any,
    ) -> Any:
        from aria_kernel import gh_token_factory
        from aria_kernel.cycle_phases.implementer import AutonomousV9ImplementationRunner

        self.events.clear()
        cycle_id = "cyc-callback"
        private_path = self.workspace / "aria-debts/keys" / cycle_id
        public_path = private_path.with_suffix(".pub")
        token_path = private_path.with_suffix(".token")
        key = gh_token_factory.SigningKey(
            cycle_id=cycle_id, private_key_path=private_path,
            public_key_path=public_path, fingerprint="SHA256:fixture-callback-key",
        )
        lease = gh_token_factory.InstallationTokenLease(
            cycle_id=cycle_id, token_file=token_path, ttl_seconds=300,
            gh_app_installation_id=None, fallback_active=True,
            minted_at_utc="2026-09-10T00:00:00Z",
        )
        real_mint = gh_token_factory.mint_signing_key
        real_revoke = gh_token_factory.revoke_signing_key

        def enter(phase: str) -> None:
            self.events.append(phase)
            if phase == failure_at:
                assert failure is not None
                raise failure

        def mint_key(*, cycle_id: str, workspace_root: Path) -> Any:
            self.assertEqual((cycle_id, workspace_root), ("cyc-callback", self.workspace))
            enter("mint_key")
            if real_key:
                self.key = real_mint(cycle_id=cycle_id, workspace_root=workspace_root)
            else:
                private_path.parent.mkdir(parents=True, exist_ok=True)
                private_path.write_text("fixture-only-private-placeholder", encoding="utf-8")
                public_path.write_text("fixture-only-public-placeholder", encoding="utf-8")
                self.key = key
            self.owned.add("key")
            return self.key

        def mint_token(*, cycle_id: str, workspace_root: Path) -> Any:
            self.assertEqual((cycle_id, workspace_root), ("cyc-callback", self.workspace))
            enter("mint_token")
            token_path.write_text("fixture-only-invalid-token", encoding="utf-8")
            self.owned.add("token")
            return lease

        def stage(**stage_kwargs: Any) -> dict[str, str]:
            enter("stage")
            return dict(AutonomousRunnerDispatchPathTests.STAGED)

        def envelope(**envelope_kwargs: Any) -> dict[str, str]:
            enter("envelope")
            return {"request_id": "AIR-callback-001"}

        def revoke_key(*, cycle_id: str, workspace_root: Path) -> dict[str, list]:
            self.assertEqual((cycle_id, workspace_root), ("cyc-callback", self.workspace))
            enter("revoke_key")
            if real_key:
                real_revoke(cycle_id=cycle_id, workspace_root=workspace_root)
            else:
                private_path.unlink()
                public_path.unlink()
            self.owned.remove("key")
            return {"removed": [], "missing": []}

        def revoke_token(*, lease: Any) -> None:
            self.assertEqual(lease.token_file, token_path)
            enter("revoke_token")
            token_path.unlink(missing_ok=True)
            self.owned.remove("token")

        # Keep the runner real; delivery/staging are separate owners. The
        # acquisition/revocation doubles expose actual fixture-file lifetime.
        with ExitStack() as stack:
            for target, operation in (
                ("aria_kernel.gh_token_factory.mint_signing_key", mint_key),
                ("aria_kernel.gh_token_factory.mint_installation_token", mint_token),
                ("aria_kernel.apply_engine.stage_converged_plan_for_pr", stage),
                ("aria_kernel.cross_review_bridge.issue_implementation_envelope", envelope),
                ("aria_kernel.gh_token_factory.revoke_signing_key", revoke_key),
                ("aria_kernel.gh_token_factory.revoke_installation_token", revoke_token),
            ):
                stack.enter_context(patch(target, side_effect=operation))
            stack.enter_context(patch("aria_kernel.tool_registry.append_tools_governance", return_value={}))
            selected = AutonomousV9ImplementationRunner() if runner is None else runner
            return selected.run(
                cycle_id=cycle_id, plan_id="plan-callback", workspace_root=self.workspace,
                base_dir=self.root / "aria-tools", cross_review_summary={"verdict": "agreed"},
                profile="autonomous", **kwargs,
            )

    def _assert_released(self) -> None:
        self.assertEqual(self.owned, set())
        for suffix in ("", ".pub", ".token"):
            self.assertFalse((self.workspace / "aria-debts/keys" / f"cyc-callback{suffix}").exists())

    def test_callback_receives_only_public_fields_while_real_key_is_owned(self) -> None:
        from dataclasses import asdict
        from tests._helpers.git_fixtures import make_repo_with_initial_commit

        self.workspace = make_repo_with_initial_commit(
            self.root, name="checkout", files={"fixture.txt": "signer owner fixture\n"},
        )
        report = {"original": "preserved"}
        received: list[dict] = []

        def complete(**public: Any) -> dict[str, Any]:
            self.events.append("callback")
            self.assertEqual(self.owned, {"key"})
            self.assertTrue(self.key.private_key_path.is_file())
            self.assertTrue(self.key.public_key_path.is_file())
            received.append(public)
            return {"status": "completed", "attempted": 1}

        result = self._run(real_key=True, on_signer_ready=complete, observation_completion_report=report)
        self.assertEqual(received, [{"signer_cycle_id": "cyc-callback", "signer_key_fp": self.key.fingerprint}])
        self.assertEqual(report, {"original": "preserved", "status": "completed", "attempted": 1})
        self.assertEqual(self.events, ["mint_key", "callback", "mint_token", "stage", "envelope", "revoke_key", "revoke_token"])
        self.assertEqual(asdict(result), {
            "terminal_state": "IMPLEMENTATION_DISPATCHED", "pr_url": None,
            "rejection_class": None, "specialist_review_signal": "review_converged_plan",
        })
        self._assert_released()

    def test_noop_leaves_optional_callback_report_and_credentials_untouched(self) -> None:
        from aria_kernel.cycle_phases.implementer import NoOpV9ImplementationRunner

        report = {"status": "not_started"}

        def forbidden(**public: Any) -> dict[str, Any]:
            self.fail("NoOp must not invoke the observation callback")

        result = self._run(runner=NoOpV9ImplementationRunner(), on_signer_ready=forbidden,
                           observation_completion_report=report)
        self.assertEqual(result.rejection_class, "no_op_v9_runner")
        self.assertEqual(result.specialist_review_signal, "review_converged_plan")
        self.assertEqual(report, {"status": "not_started"})
        self.assertEqual(self.events, [])
        self._assert_released()

    def test_invalid_callback_report_pair_is_rejected_before_acquisition(self) -> None:
        for case, kwargs in (
            ("missing_report", {"on_signer_ready": lambda **public: {}}),
            ("missing_callback", {"observation_completion_report": {}}),
            ("non_dictionary_report", {"on_signer_ready": lambda **public: {}, "observation_completion_report": []}),
            ("non_callable", {"on_signer_ready": 42, "observation_completion_report": {}}),
        ):
            with self.subTest(case=case):
                with self.assertRaises((TypeError, ValueError)):
                    self._run(**kwargs)
                self.assertEqual(self.events, [], "invalid callback contracts must not acquire credentials")
                self._assert_released()

    def test_dictionary_subclass_is_rejected_before_acquisition(self) -> None:
        class UnwritableReport(dict):
            def update(self, *args: Any, **kwargs: Any) -> None:
                raise OSError("fixture report cannot retain callback errors")

        report = UnwritableReport(status="not_started")
        with self.assertRaises(TypeError):
            self._run(on_signer_ready=lambda **public: {"status": "completed"},
                      observation_completion_report=report)
        self.assertEqual(report, {"status": "not_started"})
        self.assertEqual(self.events, [])
        self._assert_released()

    def test_noop_rejects_report_without_callback(self) -> None:
        from aria_kernel.cycle_phases.implementer import NoOpV9ImplementationRunner

        report = {"status": "not_started"}
        with self.assertRaises(ValueError):
            self._run(runner=NoOpV9ImplementationRunner(), observation_completion_report=report)
        self.assertEqual(report, {"status": "not_started"})
        self.assertEqual(self.events, [])
        self._assert_released()

    def test_callback_errors_remain_public_without_blocking_dispatch_or_cleanup(self) -> None:
        sentinel = "private-fixture-diagnostic-903"
        for error_type in (RuntimeError, OSError):
            with self.subTest(error_type=error_type.__name__):
                report = {"original": "preserved"}

                def fail_callback(**public: Any) -> dict[str, Any]:
                    self.events.append("callback")
                    raise error_type(sentinel)

                result = self._run(on_signer_ready=fail_callback, observation_completion_report=report)
                self.assertEqual(result.terminal_state, "IMPLEMENTATION_DISPATCHED")
                self.assertEqual(report, {"original": "preserved", "status": "callback_error", "error_class": error_type.__name__})
                self.assertNotIn(sentinel, json.dumps(report))
                self.assertEqual(self.events, ["mint_key", "callback", "mint_token", "stage", "envelope", "revoke_key", "revoke_token"])
                self._assert_released()

    def test_callback_error_report_survives_later_token_failure(self) -> None:
        report: dict[str, Any] = {}

        def fail_callback(**public: Any) -> dict[str, Any]:
            self.events.append("callback")
            raise OSError("fixture callback audit unavailable")

        with self.assertRaisesRegex(RuntimeError, "fixture token unavailable"):
            self._run(on_signer_ready=fail_callback, observation_completion_report=report,
                      failure_at="mint_token", failure=RuntimeError("fixture token unavailable"))
        self.assertEqual(report, {"status": "callback_error", "error_class": "OSError"})
        self.assertEqual(self.events, ["mint_key", "callback", "mint_token", "revoke_key"])
        self._assert_released()

    def test_pipeline_failure_releases_only_acquired_resources(self) -> None:
        from aria_kernel.bridge_exceptions import BridgeContractViolation
        from aria_kernel.tool_registry import GovernanceError

        for phase, error, refusal, expected_events in (
            ("mint_token", RuntimeError("fixture token failure"), None,
             ["mint_key", "callback", "mint_token", "revoke_key"]),
            ("stage", GovernanceError("fixture staging refusal"), "staging_governance_error",
             ["mint_key", "callback", "mint_token", "stage", "revoke_key", "revoke_token"]),
            ("envelope", GovernanceError("fixture envelope refusal"), "envelope_governance_error",
             ["mint_key", "callback", "mint_token", "stage", "envelope", "revoke_key", "revoke_token"]),
            ("envelope", BridgeContractViolation("fixture envelope violation"), None,
             ["mint_key", "callback", "mint_token", "stage", "envelope", "revoke_key", "revoke_token"]),
        ):
            with self.subTest(phase=phase, error_type=type(error).__name__):
                report: dict[str, Any] = {}

                def complete(**public: Any) -> dict[str, Any]:
                    self.events.append("callback")
                    return {"status": "completed"}

                kwargs = dict(on_signer_ready=complete, observation_completion_report=report,
                              failure_at=phase, failure=error)
                if refusal is None:
                    with self.assertRaises(type(error)):
                        self._run(**kwargs)
                else:
                    result = self._run(**kwargs)
                    self.assertEqual(result.terminal_state, "IMPLEMENTATION_REQUEST_REFUSED")
                    self.assertEqual(result.rejection_class, refusal)
                self.assertEqual(report, {"status": "completed"})
                self.assertEqual(self.events, expected_events)
                self._assert_released()

    def test_callback_keyboard_interrupt_unwinds_key_cleanup(self) -> None:
        report = {"status": "not_started"}

        def interrupted(**public: Any) -> dict[str, Any]:
            self.events.append("callback")
            raise KeyboardInterrupt("fixture cancellation")

        with self.assertRaises(KeyboardInterrupt):
            self._run(on_signer_ready=interrupted, observation_completion_report=report)
        self.assertEqual(report, {"status": "not_started"})
        self.assertEqual(self.events, ["mint_key", "callback", "revoke_key"])
        self._assert_released()

    def test_envelope_keyboard_interrupt_unwinds_both_resources(self) -> None:
        report: dict[str, Any] = {}
        with self.assertRaises(KeyboardInterrupt):
            self._run(on_signer_ready=lambda **public: {"status": "completed"},
                      observation_completion_report=report, failure_at="envelope",
                      failure=KeyboardInterrupt("fixture cancellation"))
        self.assertEqual(report, {"status": "completed"})
        self.assertEqual(self.events, ["mint_key", "mint_token", "stage", "envelope", "revoke_key", "revoke_token"])
        self._assert_released()


if __name__ == "__main__":
    unittest.main()
