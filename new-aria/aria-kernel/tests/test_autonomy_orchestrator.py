"""Plan 026R §F.1 LOAD-BEARING — autonomy orchestrator state machine.

8 tests:

* Full chain happy path → cycles_completed=N + all phases recorded.
* ARIA_STOP exits clean with reason=aria_stop, no cycle ran.
* Frozen profile exits clean with reason=profile_frozen.
* max_cycles cap honored.
* Single-instance daemon lock contention returns
  exits_clean=False + reason=daemon_already_running.
* Cycle runner failure → cycle_completed status=failed transition
  + orchestrator still advances to next cycle.
* Idempotent re-run: per-cycle results are additive.
* Reducer state after run reflects every transition counter.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from unittest.mock import patch

from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
from aria_kernel.autonomy_state import (
    AutonomyStateReducer,
    autonomy_state_path,
)
from aria_kernel.file_lock import with_exclusive_lock
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import fold_plan_state
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir
from tests.test_implementation_lifecycle_continuity import (
    drive_plan_to_implementation_requested,
    seed_reviewer_agent,
)


def _fake_cycle_runner(
    *, workspace_root, cycle_id, base_dir, defer_reflection=False,
):
    # Plan ARIA-V3.3 §2b — mocks must mirror the real cycle_runner
    # contract; the orchestrator passes ``defer_reflection=True`` so
    # the kwarg has to be accepted by every cycle_runner injection
    # seam.
    return {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "status": "completed",
    }


def _failing_cycle_runner(
    *, workspace_root, cycle_id, base_dir, defer_reflection=False,
):
    raise RuntimeError("simulated cycle failure")


def _fake_convergence_runner(**kwargs):
    """Plan ARIA-V5 §4 V5.1 — happy-path mock convergence runner.

    Returns ``arbiter_verdict="converged"`` on round 1 so the cycle
    proceeds through worker_drainer + auto_merge_runner unimpeded.
    Accepts ``**kwargs`` permissively (V3 §A2 pattern) so future
    ConvergenceRunner Protocol kwargs do not break this fixture.
    """
    return {
        "plan_id": kwargs.get("plan_id", f"plan-{kwargs.get('cycle_id', 'test')}"),
        "converged_plan": {"plan_id": kwargs.get("plan_id"), "must_satisfy": []},
        "rounds_count": 1,
        "arbiter_verdict": "converged",
        "unsatisfied_items": [],
        "request_ids": [],
        "transcript_path": f"convergence/{kwargs.get('cycle_id', 'test')}.jsonl",
        "resumed_from_persistence": False,
        "convergence_id": kwargs.get("plan_id", "plan-test"),
    }


def _fake_review_runner(**kwargs):
    """Plan ARIA-V5 §4 V5.2 — happy-path mock review runner.

    Returns ``review_verdict="no_gaps"`` on round 1 so the cycle
    proceeds through auto_merge_runner unimpeded. Accepts ``**kwargs``
    permissively so future ReviewRunner Protocol kwargs do not break
    this fixture.
    """
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "impl_artifacts_ref": kwargs.get("impl_artifacts_ref", f"cycle:{kwargs.get('cycle_id', 'test')}"),
        "review_verdict": "no_gaps",
        "rounds_count": 1,
        "gaps_found": [],
        "request_ids": [],
        "convergence_id": kwargs.get("convergence_id", kwargs.get("plan_id", "plan-test")),
    }


def _fake_specialist_review_runner(**kwargs):
    """Plan ARIA-V6 §2c V6.1 — happy-path mock specialist review runner.

    Returns ``consolidated_verdict="consolidated_no_gaps"`` so cycle
    proceeds through worker_drainer. R-A9 compat pattern from V5 §A1.
    """
    return {
        "cycle_id": kwargs.get("cycle_id", "cycle-test"),
        "specialists_dispatched": ["auth-security-expert", "farm-expert"],
        "specialists_timed_out": [],
        "consolidated_verdict": "consolidated_no_gaps",
        "findings_by_specialist": {},
        "request_ids": [],
        "rounds_count": 1,
        "token_cost_estimate": 0,
        "profile": kwargs.get("profile", "standard"),
    }


def _fake_plan_synthesizer(**kwargs):
    """Plan ARIA-V7 §2i v2 V7.1 — happy-path mock plan_synthesizer."""
    cycle_id = kwargs.get("cycle_id", "cycle-test")
    return {
        "schema_version": 1,
        "title": f"Fake cycle {cycle_id}",
        "summary": "Fake plan_content for R-A9 fixture compat",
        "affected_surfaces": ["fixture/path.py"],
        "key_changes": [{
            "id": "fixture-change-1",
            "description": "fixture cluster",
            "paths": ["fixture/path.py"],
        }],
        "validation_commands": [{
            "cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0,
        }],
        "evidence_refs": ["fixture/path.py:1:fixture line"],
    }


def _fake_skill_genesis_drainer(**kwargs):
    """Plan ARIA-V7 §2h v2 V7.4 — happy-path mock skill_genesis_drainer.

    Returns ``aggregate_verdict="no_requests"`` (no convergent requests
    to dispatch) so the cycle proceeds through Gate A unimpeded.
    R-A9 compat pattern from V5/V6/V7.1 §A1.
    """
    return {
        "cycle_id": kwargs.get("cycle_id", "cycle-test"),
        "requests_scanned": 0,
        "requests_dispatched": 0,
        "requests_skipped_corpus_missing": 0,
        "requests_skipped_evidence_insufficient": 0,
        "requests_skipped_already_terminal": 0,
        "requests_skipped_token_budget": 0,
        "requests_skipped_non_convergent": 0,
        "authoring_results": [],
        "tokens_spent_this_cycle": 0,
        "aggregate_verdict": "no_requests",
    }


def _fake_planner_drainer(*, base_dir, workspace_root, max_iterations):
    return {
        "iterations": 1,
        "claims_dispatched": 2,
        "exits_clean": True,
        "exit_reason": "max_iterations",
    }


def _fake_worker_drainer(**kwargs):
    """Plan ARIA-V3 §A2 — accept arbitrary kwargs so the orchestrator
    can pass through new dependencies (e.g. ``github_adapter``)
    without breaking this fixture.
    """
    return {
        "iterations": 1,
        "assignments_dispatched": 3,
        "retries_attempted": 0,
        "merges_completed": 1,
        "exits_clean": True,
        "exit_reason": "max_iterations",
    }


def _fake_bridge_drainer(*, base_dir, max_iterations):
    return {
        "status": "ok",
        "iterations": 0,
        "pending_after": 0,
    }


class _FakeAutoMergeRunner:
    """Plan ARIA-V3 §A1 migration — orchestrator now requires an
    auto_merge_runner. The existing fake_worker_drainer accumulates
    merges_completed=1 per cycle for backward-compat with the
    pre-V3 happy-path test; this fake runner adds zero so the
    historical assertion (auto_merges_completed=2 across 2 cycles)
    is preserved exactly.
    """

    profile = "standard"

    def __call__(self, *, base_dir, workspace_root):
        return {
            "schema_version": 1,
            "status": "skipped",
            "reason": "fake_runner_for_orchestrator_tests",
            "merges_completed": 0,
            "candidates_evaluated": 0,
            "profile": self.profile,
        }


_fake_auto_merge_runner = _FakeAutoMergeRunner()


class _FakeGitHubAdapter:
    """Plan ARIA-V3 §A2 — required github_adapter test fixture.

    The orchestrator now requires a GitHubAdapter Protocol instance.
    These tests inject fake worker_drainer + fake invoke_worker that
    do not touch GitHub, so a placeholder that satisfies attribute
    lookups is sufficient. Real adapter selection lives in
    aria_kernel.github_adapters.select_github_adapter and is
    exercised by tests/invariants/v3/test_phase_a1_a2_required_injection.py.
    """


_fake_github_adapter = _FakeGitHubAdapter()


class AutonomyOrchestratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-f1-"))
        self.base = self.tmp / "aria-tools"
        set_profile(
            "standard", operator_approval_ref="f1-t", base_dir=self.base,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, **overrides: Any) -> dict[str, Any]:
        kwargs: dict[str, Any] = dict(
            base_dir=self.base,
            workspace_root=str(self.tmp),
            max_cycles=1,
            max_iterations_per_phase=3,
            cycle_runner=_fake_cycle_runner,
            planner_drainer=_fake_planner_drainer,
            worker_drainer=_fake_worker_drainer,
            bridge_drainer=_fake_bridge_drainer,
            # Plan ARIA-V3 §A1 — auto_merge_runner is REQUIRED.
            auto_merge_runner=_fake_auto_merge_runner,
            # Plan ARIA-V3 §A2 — github_adapter is REQUIRED.
            github_adapter=_fake_github_adapter,
            # Plan ARIA-V5 §3c v2 — convergence_runner is REQUIRED
            # (V5.1 Tier-1, no default). Happy-path fake returns
            # arbiter_verdict="converged" so existing V3-era tests
            # see worker_drainer + auto_merge_runner fire normally.
            convergence_runner=_fake_convergence_runner,
            # Plan ARIA-V5 §3d v2 — review_runner is REQUIRED (V5.2
            # Tier-1, no default). Happy-path fake returns
            # review_verdict="no_gaps" so auto_merge_runner still
            # fires per existing V3-era test expectations.
            review_runner=_fake_review_runner,
            # Plan ARIA-V6 §2c v2 — specialist_review_runner is
            # REQUIRED (V6.1 Tier-1, no default). Happy-path fake
            # returns consolidated_no_gaps so cycle proceeds through
            # worker_drainer.
            specialist_review_runner=_fake_specialist_review_runner,
            # Plan ARIA-V7 §2i v2 — plan_synthesizer is REQUIRED
            # (V7.1 Tier-1, no default). Happy-path fake returns a
            # structurally-valid plan_content so the cycle proceeds
            # through Gate A unimpeded.
            plan_synthesizer=_fake_plan_synthesizer,
            # Plan ARIA-V7 §2h v2 — skill_genesis_drainer is REQUIRED
            # (V7.4 Tier-1, no default). Happy-path fake returns
            # aggregate_verdict="no_requests" so cycle proceeds.
            skill_genesis_drainer=_fake_skill_genesis_drainer,
            # Plan ARIA-V3.1-E — `profile` is REQUIRED (no default).
            # Tests default to "standard" so preflight is skipped +
            # the action-permission set permits agent_claim +
            # change_committed + change_validated (pr_open is strict-
            # only — V3-era tests don't exercise PR open).
            profile="standard",
        )
        kwargs.update(overrides)
        return run_autonomy_orchestrator(**kwargs)

    def test_full_chain_happy_path(self) -> None:
        result = self._run(max_cycles=2)
        self.assertEqual(result["exit_reason"], "max_cycles")
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["cycles_completed"], 2)
        self.assertEqual(result["planner_claims_dispatched"], 4)
        self.assertEqual(result["worker_assignments_dispatched"], 6)
        self.assertEqual(result["auto_merges_completed"], 2)
        # Inspect autonomy_state.jsonl for transition coverage.
        rows = load_jsonl(autonomy_state_path(self.base))
        phases = {row["phase"] for row in rows}
        self.assertIn("cycle_started", phases)
        self.assertIn("cycle_completed", phases)
        self.assertIn("planner_dispatch_drained", phases)
        self.assertIn("bridge_drained", phases)
        self.assertIn("worker_dispatch_drained", phases)
        self.assertIn("max_cycles_reached", phases)

    def test_aria_stop_exits_before_cycle_starts(self) -> None:
        ensure_tools_dir(self.base)
        (self.base / "ARIA_STOP").write_text("stop", encoding="utf-8")
        result = self._run(max_cycles=5)
        self.assertEqual(result["exit_reason"], "aria_stop")
        self.assertEqual(result["cycles_completed"], 0)
        rows = load_jsonl(autonomy_state_path(self.base))
        # Only aria_stop transition was recorded.
        self.assertTrue(any(r["phase"] == "aria_stop" for r in rows))
        self.assertFalse(
            any(r["phase"] == "cycle_started" for r in rows),
        )

    def test_frozen_profile_blocks_orchestrator(self) -> None:
        set_profile(
            "frozen",
            operator_approval_ref="ops-approved",
            base_dir=self.base,
        )
        # Plan ARIA-V3.1-E — profile kwarg is the SSoT; the CLI
        # surface routes through set_profile() so kwarg == persisted
        # in production. Match the persisted "frozen" via the
        # operator-intent kwarg so the test exercises the frozen-
        # profile_frozen exit path under the V3.1-E contract.
        result = self._run(max_cycles=3, profile="frozen")
        self.assertEqual(result["exit_reason"], "profile_frozen")
        self.assertEqual(result["cycles_completed"], 0)

    def test_max_cycles_cap_honored(self) -> None:
        result = self._run(max_cycles=1)
        self.assertEqual(result["cycles_completed"], 1)
        result2 = self._run(max_cycles=4)
        # Each invocation is independent (no cross-call state).
        self.assertEqual(result2["cycles_completed"], 4)

    def test_single_instance_lock_contended(self) -> None:
        ensure_tools_dir(self.base)
        daemon_lock = (
            self.base / "daemons" / "autonomy.pid.lock"
        )
        daemon_lock.parent.mkdir(parents=True, exist_ok=True)
        # Hold the lock to simulate a concurrent orchestrator.
        with with_exclusive_lock(daemon_lock):
            result = self._run()
        self.assertEqual(
            result["exit_reason"], "daemon_already_running",
        )
        self.assertFalse(result["exits_clean"])

    def test_cycle_runner_failure_records_failed_transition(self) -> None:
        result = self._run(cycle_runner=_failing_cycle_runner)
        self.assertEqual(result["cycles_completed"], 0)
        rows = load_jsonl(autonomy_state_path(self.base))
        cycle_completed_rows = [
            r for r in rows if r["phase"] == "cycle_completed"
        ]
        self.assertEqual(len(cycle_completed_rows), 1)
        self.assertEqual(cycle_completed_rows[0]["status"], "failed")
        self.assertEqual(result["exit_reason"], "cycle_failed")
        self.assertFalse(result["exits_clean"])
        # Fail-closed: planner/bridge/worker drains do not run after a failed cycle.
        self.assertFalse(
            any(r["phase"] == "worker_dispatch_drained" for r in rows),
        )

    def test_idempotent_re_run_accumulates_state(self) -> None:
        self._run(max_cycles=1)
        first_state = AutonomyStateReducer.derive_current(self.base)
        self._run(max_cycles=1)
        second_state = AutonomyStateReducer.derive_current(self.base)
        self.assertEqual(
            second_state.cycles_completed,
            first_state.cycles_completed + 1,
        )
        self.assertEqual(
            second_state.planner_claims_dispatched,
            first_state.planner_claims_dispatched + 2,
        )

    def test_reducer_state_matches_run_counters(self) -> None:
        result = self._run(max_cycles=3)
        state = AutonomyStateReducer.derive_current(self.base)
        self.assertEqual(
            state.cycles_completed, result["cycles_completed"],
        )
        self.assertEqual(
            state.planner_claims_dispatched,
            result["planner_claims_dispatched"],
        )
        self.assertEqual(
            state.worker_assignments_dispatched,
            result["worker_assignments_dispatched"],
        )


    # ------------------------------------------------------------------
    # ORPHAN-HIGH-455 — the specialist gate, at the CALLSITE.
    #
    # ORPHAN-HIGH-423 extracted `specialist_verdict_blocks_cycle` so the
    # policy could be tested on its own, and the test that claimed to cover
    # the orchestrator's use of it patched the function and then called the
    # thing it had just patched, asserting the wrapper recorded the call.
    # The orchestrator was never imported. So the policy was pinned, the
    # delegation was not, and an adversarial audit demonstrated that
    # reverting `autonomy_orchestrator.py` wholesale left all 2805 tests
    # green.
    #
    # These drive the real orchestrator through the real callsite. Each was
    # confirmed to fail against `git show bdaf00bf:...autonomy_orchestrator.py`.
    # ------------------------------------------------------------------

    def _specialist_runner_returning(self, verdict: str):
        def _runner(**kwargs):
            row = _fake_specialist_review_runner(**kwargs)
            row["consolidated_verdict"] = verdict
            return row
        return _runner

    def test_specialist_unavailable_blocks_the_cycle_in_standard(self) -> None:
        """The ORPHAN-HIGH-423 fix, observed where it takes effect.

        Pre-fix only `strict` blocked, so `standard` and `autonomous` — the
        write-capable profiles — proceeded on an unreviewed domain.
        """
        result = self._run(
            max_cycles=1,
            profile="standard",
            specialist_review_runner=self._specialist_runner_returning(
                "specialists_unavailable",
            ),
        )
        self.assertEqual(result["worker_assignments_dispatched"], 0)
        self.assertEqual(result["auto_merges_completed"], 0)
        phases = {row["phase"] for row in load_jsonl(autonomy_state_path(self.base))}
        self.assertIn("specialist_review_blocked", phases)

    def test_unrecognised_specialist_verdict_blocks_too(self) -> None:
        """ORPHAN-HIGH-443's allowlist, also at the callsite.

        A verdict this build has never heard of must not read as a clean
        review. The seam is genuinely untyped: `specialist_review_runner` is
        an injected kwarg and the orchestrator reads the verdict with
        `dict.get()`, which is exactly what this injects.

        Run under `standard`, not `autonomous`: the autonomous profile's
        preflight demands a GitHub App installation, a signing-key directory
        and a `gh` binary, none of which exist in a test environment, so it
        raises before ever reaching the specialist gate. `standard` is
        write-capable — the property under test — and
        `specialist_verdict_blocks_cycle` applies the identical rule to both.
        """
        for verdict in ("", "consolidated_no_gap", "CONSOLIDATED_NO_GAPS"):
            with self.subTest(verdict=verdict):
                # A fresh base per verdict, so one iteration's ledger cannot
                # satisfy the next one's assertion. Not `self.setUp()`:
                # tearDown runs once, and re-entering setUp would leak every
                # temp directory but the last.
                tmp = Path(tempfile.mkdtemp(prefix="aria-f1-verdict-"))
                self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
                self.tmp, self.base = tmp, tmp / "aria-tools"
                set_profile(
                    "standard", operator_approval_ref="f1-t", base_dir=self.base,
                )
                result = self._run(
                    max_cycles=1,
                    profile="standard",
                    specialist_review_runner=self._specialist_runner_returning(verdict),
                )
                self.assertEqual(
                    result["worker_assignments_dispatched"],
                    0,
                    msg=f"verdict {verdict!r} let the cycle reach worker_drainer",
                )

    def test_a_clean_specialist_verdict_still_lets_the_cycle_through(self) -> None:
        """Guards the guard: if the block fired unconditionally, the two
        tests above would pass for the wrong reason."""
        result = self._run(max_cycles=1, profile="standard")
        self.assertGreater(result["worker_assignments_dispatched"], 0)
        phases = {row["phase"] for row in load_jsonl(autonomy_state_path(self.base))}
        self.assertNotIn("specialist_review_blocked", phases)


class BoundedCycleSummaryCarriesWhatThePublisherReads(unittest.TestCase):
    """ORPHAN-HIGH-456 — the summary literal is closed, so it is a contract.

    `_bounded_cycle_summary` names its keys explicitly and therefore DELETES
    every key it does not name. Two consumers in `runtime_artifacts` read
    keys that could not survive it, so both were unreachable in production
    while their tests passed against the raw cycle dict — a shape production
    never emits. That is the same defect as a control with no caller, one
    layer down.
    """

    def test_the_lifecycle_snapshot_survives_the_summary(self) -> None:
        from aria_kernel.autonomy_orchestrator import _bounded_cycle_summary

        summary = _bounded_cycle_summary({
            "cycle_id": "c1",
            "status": "completed",
            "incomplete_lifecycle_count": 0,
            "cycle_lifecycle": {
                "valid": False,
                "incomplete_count": 0,
                "incomplete_cycles": [],
                "lifecycle_read_error": "cycles.jsonl unreadable",
            },
        })
        lifecycle = summary.get("cycle_lifecycle")
        self.assertIsInstance(lifecycle, dict)
        assert isinstance(lifecycle, dict)  # narrowing
        self.assertIs(lifecycle["valid"], False)
        self.assertEqual(lifecycle["lifecycle_read_error"], "cycles.jsonl unreadable")

    def test_the_unreadable_warning_can_actually_fire(self) -> None:
        """End-to-end: the publisher's own condition, on a real summary.

        This is the distinction ORPHAN-HIGH-424's commit message sold as the
        feature — "zero incomplete cycles" versus "the ledger could not be
        read" — and it was unreachable.
        """
        from aria_kernel.autonomy_orchestrator import _bounded_cycle_summary

        summary = _bounded_cycle_summary({
            "cycle_id": "c1",
            "status": "completed",
            "incomplete_lifecycle_count": 0,
            "cycle_lifecycle": {"valid": False, "incomplete_count": 0},
        })
        lifecycle = summary.get("cycle_lifecycle")
        self.assertTrue(
            isinstance(lifecycle, dict)
            and lifecycle.get("valid") is False
            and not summary["incomplete_lifecycle_count"],
            msg="cycle_lifecycle_unreadable still cannot fire on a real summary",
        )

    def test_cycle_level_markers_survive(self) -> None:
        from aria_kernel.autonomy_orchestrator import _bounded_cycle_summary
        from aria_kernel.runtime_artifacts import _marker_total, _SUPPRESSED_MARKER_KEYS

        summary = _bounded_cycle_summary({
            "cycle_id": "c1", "status": "completed", "findings_suppressed": 3,
        })
        self.assertEqual(_marker_total(summary, _SUPPRESSED_MARKER_KEYS), 3)

    def test_the_mirrored_marker_key_list_has_not_drifted(self) -> None:
        """The orchestrator keeps its own copy of the publisher's key names.

        A copy is acceptable here — the modules are deliberately decoupled —
        but only if drift is detectable, which is what this asserts.
        """
        from aria_kernel.autonomy_orchestrator import _CYCLE_MARKER_KEYS
        from aria_kernel.runtime_artifacts import (
            _SUPPRESSED_MARKER_KEYS,
            _TRUNCATED_MARKER_KEYS,
        )

        self.assertEqual(
            set(_CYCLE_MARKER_KEYS),
            set(_SUPPRESSED_MARKER_KEYS) | set(_TRUNCATED_MARKER_KEYS),
        )

    def test_incomplete_cycles_is_capped(self) -> None:
        """Operator evidence, not a data feed: an unbounded list from a
        damaged ledger is how a summary becomes unpublishable."""
        from aria_kernel.autonomy_orchestrator import (
            _MAX_INCOMPLETE_CYCLES_IN_SUMMARY,
            _bounded_cycle_summary,
        )

        summary = _bounded_cycle_summary({
            "cycle_id": "c1",
            "status": "completed",
            "cycle_lifecycle": {
                "valid": False,
                "incomplete_count": 500,
                "incomplete_cycles": [f"c{i}" for i in range(500)],
            },
        })
        lifecycle = summary["cycle_lifecycle"]
        self.assertEqual(
            len(lifecycle["incomplete_cycles"]), _MAX_INCOMPLETE_CYCLES_IN_SUMMARY,
        )
        # The true count is still reported, so the cap cannot hide scale.
        self.assertEqual(lifecycle["incomplete_count"], 500)

class TheStartupReaperCollectsAbandonmentNotLateness(unittest.TestCase):
    """ORPHAN-HIGH-729 — the reap window, exercised through the orchestrator.

    The reaper was written for a topology where minting and draining an
    implementation envelope happened in ONE process, so "still REQUESTED at
    startup" could only mean crash debris. It is two workflow runs now — the
    cycle lane mints, the `workflow_run`-chained executor lane drains — and
    an unbounded reaper in that world rejects the plan the executor is on its
    way to implement, every time the window slips.

    Both tests drive a REAL plan to IMPLEMENTATION_REQUESTED through the
    transition functions and then let the real `record_implementation_rejected`
    decide whether it lands. Only the scanner's reported `last_event_at` is
    substituted, because a clock is the one thing a test cannot honestly wait
    for: patching it is supplying data, patching `_older_than_hours` would be
    replacing the mechanism under test.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-729-"))
        self.base = self.tmp / "aria-tools"
        self.workspace = self.tmp / "workspace"
        seed_reviewer_agent(self.workspace)
        set_profile(
            "standard", operator_approval_ref="orphan-729", base_dir=self.base,
        )
        drive_plan_to_implementation_requested(
            plan_id="plan-729",
            tools=self.base,
            workspace_root=self.workspace,
        )
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REQUESTED",
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_with_orphan_stamps(
        self, *, last_event_at: Any, first_event_at: Any = None,
    ) -> list[dict[str, Any]]:
        orphan = [{
            "plan_id": "plan-729",
            "state": "IMPLEMENTATION_REQUESTED",
            "last_event_at": last_event_at,
            "first_event_at": first_event_at,
        }]
        with patch(
            "aria_kernel.plan_convergence.scan_orphan_implementation_requests",
            return_value=orphan,
        ):
            run_autonomy_orchestrator(
                base_dir=self.base,
                workspace_root=str(self.workspace),
                max_cycles=0,
                max_iterations_per_phase=1,
                cycle_runner=_fake_cycle_runner,
                planner_drainer=_fake_planner_drainer,
                worker_drainer=_fake_worker_drainer,
                bridge_drainer=_fake_bridge_drainer,
                auto_merge_runner=_fake_auto_merge_runner,
                github_adapter=_fake_github_adapter,
                convergence_runner=_fake_convergence_runner,
                review_runner=_fake_review_runner,
                specialist_review_runner=_fake_specialist_review_runner,
                plan_synthesizer=_fake_plan_synthesizer,
                skill_genesis_drainer=_fake_skill_genesis_drainer,
                profile="standard",
            )
        return load_jsonl(ensure_tools_dir(self.base) / "governance.jsonl")

    @staticmethod
    def _hours_ago(hours: float) -> str:
        from datetime import datetime, timedelta, timezone

        return (
            datetime.now(timezone.utc) - timedelta(hours=hours)
        ).isoformat().replace("+00:00", "Z")

    def _run_with_orphan_age(self, hours: float) -> list[dict[str, Any]]:
        return self._run_with_orphan_stamps(last_event_at=self._hours_ago(hours))

    def test_a_one_hour_old_request_survives_startup(self) -> None:
        events = self._run_with_orphan_age(1)
        self.assertNotIn(
            "implementation_orphan_reaped", [row.get("kind") for row in events],
        )
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REQUESTED",
            "the executor's own envelope was rejected before the executor ran",
        )
        summaries = [
            row for row in events
            if row.get("kind") == "implementation_orphans_reaped_summary"
        ]
        self.assertEqual(len(summaries), 1, "sparing must not be silent")
        payload = summaries[0]["details"]
        self.assertEqual(payload["reaped_count"], 0)
        self.assertEqual(payload["spared_recent_count"], 1)
        self.assertEqual(payload["reap_after_hours"], 24)

    def test_a_thirty_hour_old_request_is_reaped_with_its_disclosure_row(self) -> None:
        events = self._run_with_orphan_age(30)
        reaped = [
            row for row in events
            if row.get("kind") == "implementation_orphan_reaped"
        ]
        self.assertEqual(len(reaped), 1)
        payload = reaped[0]["details"]
        self.assertEqual(payload["plan_id"], "plan-729")
        self.assertEqual(payload["prior_state"], "IMPLEMENTATION_REQUESTED")
        self.assertTrue(payload["last_event_at"])
        self.assertEqual(payload["reap_after_hours"], 24)
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REJECTED",
        )

    def test_a_corrupt_newest_stamp_is_dated_from_the_plans_birth(self) -> None:
        """A mangled `recorded_at` used to read as `spared_recent`: the bound
        asked a bool that answers False for "unparseable" and for "young"
        alike. The age now falls back to the plan's first event, so a corrupt
        row cannot buy immunity — and the reap row says which clock it used
        rather than leaving an auditor to infer it."""
        events = self._run_with_orphan_stamps(
            last_event_at="not-a-date", first_event_at=self._hours_ago(30),
        )
        reaped = [
            row for row in events
            if row.get("kind") == "implementation_orphan_reaped"
        ]
        self.assertEqual(len(reaped), 1)
        self.assertEqual(reaped[0]["details"]["age_source"], "first_event_at")
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REJECTED",
        )

    def test_an_undateable_request_reaches_a_human_instead_of_immortality(self) -> None:
        """No readable stamp ANYWHERE in the plan's event stream is a corrupt
        ledger, not a late executor — `_append_event` always stamps, so the
        writer cannot produce this shape.

        Sparing it was the defect: the earlier note claimed
        `resume_candidate_plan_id` would eventually abandon such a plan, and
        it cannot — it `continue`s past `_IMPLEMENTATION_PHASE_STATES`, the
        only states this scanner returns, so nothing in the kernel would ever
        have collected it. A machine with no clock cannot honestly choose
        between "abandoned" and "in flight", so it stops choosing: the plan is
        left intact AND handed to the operator queue, which is a terminal path
        a human can actually walk.
        """
        events = self._run_with_orphan_stamps(
            last_event_at=None, first_event_at=None,
        )
        summaries = [
            row for row in events
            if row.get("kind") == "implementation_orphans_reaped_summary"
        ]
        self.assertEqual(len(summaries), 1)
        payload = summaries[0]["details"]
        self.assertEqual(payload["escalated_undateable_count"], 1)
        self.assertEqual(payload["reaped_count"], 0)
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REQUESTED",
            "an undateable plan must not be destroyed on a guess either",
        )
        from aria_kernel.human_required import list_human_required

        escalations = [
            row for row in list_human_required(base_dir=self.base)
            if row.get("context", {}).get("plan_id") == "plan-729"
        ]
        self.assertEqual(len(escalations), 1, escalations)
        self.assertEqual(escalations[0]["status"], "open")

    def test_the_escalation_does_not_multiply_across_scans(self) -> None:
        """Every startup re-scans, and an operator queue that grows one row
        per night for the same plan is a queue nobody reads. The request_id
        is derived from the plan, so `record_human_required`'s own
        idempotency collapses the repeats."""
        for _ in range(3):
            self._run_with_orphan_stamps(last_event_at=None, first_event_at=None)
        from aria_kernel.human_required import list_human_required

        escalations = [
            row for row in list_human_required(base_dir=self.base)
            if row.get("context", {}).get("plan_id") == "plan-729"
        ]
        self.assertEqual(len(escalations), 1, escalations)


if __name__ == "__main__":
    unittest.main()
