"""G-4 — the fourth change-ledger event: did the merged change WORK?

What this suite pins, one property per test:

  * a change with no measurable metric yields ``unknown`` — never
    ``gain_confirmed``;
  * ``regression`` is CONSUMED from the existing
    ``experiment_regression_detected`` event, not detected a second time;
  * ``no_gain`` comes from the finding ledger recording the defect again
    AFTER the merge;
  * ``gain_confirmed`` requires a ledger-backed post-merge reading;
  * an outcome computed from the proposal's own claim is REFUSED;
  * the verdict is reproducible from the ledgers alone (recompute →
    identical digest; re-emit → the same single row);
  * only a MERGED change, and only after the window, is evaluated;
  * a negative verdict folds into ``cycles_rejected`` — the column after
    ``cycles_merged`` — through the effectiveness ledger's one writer;
  * the nightly phase is registered on the cycle table with an existing
    precondition, after the bench that produces its evidence.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.change_ledger import (
    emit_change_committed,
    emit_change_planned,
    emit_change_validated,
)
from aria_kernel.change_outcome import (
    BENEFIT_METRICS,
    LEDGER_EVIDENCE_SOURCES,
    OUTCOME_EVALUATION_NIGHTS,
    MetricReading,
    emit_change_outcome,
    evaluate_change_outcomes,
    list_change_outcomes,
    recompute_change_outcome,
)
from aria_kernel.finding import findings_dir
from aria_kernel.knowledge_graph import rank_pressure_sources
from aria_kernel.tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
)
from tests._helpers.declared_fixtures import append_declared_fixture

_FINDING_ID = "F-901"
_PLAN_ID = "plan-g4"
_PR_NUMBER = 4242


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat()


class OutcomeBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-change-outcome-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        self.now = datetime(2026, 8, 20, 3, 0, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- fixture builders: every row goes through a declared surface ----

    def _chain(self, *, idx: int = 1, finding_id: str = _FINDING_ID) -> str:
        planned = emit_change_planned(
            plan_id=f"{_PLAN_ID}-{idx}",
            finding_id=finding_id,
            intended_affected_files=[f"apps/svc/src/file{idx}.ts"],
            intended_validation_refs=["nx test"],
            architectural_tier=1,
            base_dir=self.tools,
        )
        change_id = str(planned["change_id"])
        emit_change_committed(
            change_id=change_id,
            commit_sha=f"sha{idx:03d}",
            actual_affected_files=[f"apps/svc/src/file{idx}.ts"],
            base_dir=self.tools,
        )
        emit_change_validated(
            change_id=change_id,
            validation_run_refs=[{
                "cmd": "nx test", "exit_code": 0,
                "log_path": "/tmp/log.txt", "ran_at": _iso(self.now),
            }],
            base_dir=self.tools,
            workspace_root=self.repo,
            enforce_validation_matrix=False,
        )
        return change_id

    def _merge(self, change_id: str, *, nights_ago: float, pr_number: int = _PR_NUMBER) -> datetime:
        merged_at = self.now - timedelta(days=nights_ago)
        path = self.tools / "pr-lifecycle.jsonl"
        append_declared_fixture(
            path,
            {
                "schema_version": 1, "recorded_at": _iso(merged_at - timedelta(hours=1)),
                "event": "pr_open", "pr_number": pr_number, "change_id": change_id,
            },
            expected_surface="pr_lifecycle",
        )
        append_declared_fixture(
            path,
            {
                "schema_version": 1, "recorded_at": _iso(merged_at),
                "event": "merged", "pr_number": pr_number, "change_id": None,
            },
            expected_surface="pr_lifecycle",
        )
        return merged_at

    def _cost_row(self, *, plan_idx: int = 1, source_type: str = "orphan_finding") -> None:
        shard = self.tools / "cost-attribution" / "2026-08.jsonl"
        shard.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            shard,
            {
                "schema_version": 1, "recorded_at": _iso(self.now),
                "cycle_id": "cyc-1", "plan_id": f"{_PLAN_ID}-{plan_idx}",
                "agent_role": "planner", "model": "test-model",
                "input_tokens": 1, "output_tokens": 1, "estimated_usd": 0.0,
                "pressure_source_type": source_type, "terminal_state": "converged",
                "signer_key_fp": "SHA256:no-key", "drift_flag": None,
            },
            expected_surface="cost_attribution",
        )

    def _finding_event(self, event: str, *, at: datetime, finding_id: str = _FINDING_ID) -> None:
        events = findings_dir(self.repo) / "finding-events.jsonl"
        events.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            events,
            {
                "schema_version": 1, "event": event,
                "event_id": f"finding:{finding_id}:{event}:{_iso(at)}",
                "finding_id": finding_id, "recorded_at": _iso(at),
            },
            expected_surface="repo_finding_events",
        )

    def _observation(self, change_id: str, *, at: datetime, matched: bool, status: str) -> None:
        path = self.tools / "experiments" / "observations.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            path,
            {
                "schema_version": 1, "recorded_at": _iso(at),
                "experiment_id": "exp-1", "change_id": change_id,
                "validation_run_id": f"vr-{_iso(at)}",
                "matched": matched, "run_status": status,
            },
            expected_surface="experiment_observations",
        )


class VerdictTests(OutcomeBase):
    def test_no_measurable_metric_yields_unknown_never_gain(self) -> None:
        change_id = self._chain()
        self._merge(change_id, nights_ago=5)
        row = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now,
        )
        self.assertEqual(row["verdict"], "unknown")
        self.assertNotEqual(row["verdict"], "gain_confirmed")
        # And nothing is folded into the effectiveness counters: absence
        # of evidence is not evidence of absence.
        self.assertEqual(rank_pressure_sources(workspace_root=self.repo), [])

    def test_regression_consumes_the_existing_detector_event(self) -> None:
        change_id = self._chain()
        merged_at = self._merge(change_id, nights_ago=5)
        self._cost_row()
        # The ONE detector, already in production: experiment_night's
        # regression lane. This module reads its event; it does not
        # re-detect anything.
        append_tools_governance(
            self.tools, "experiment_regression_detected",
            {"finding_id": _FINDING_ID, "experiment_id": "exp-1",
             "recipe_ref": "rec-1", "validation_run_id": "vr-9",
             "original_fix_commit": "sha001"},
        )
        self.assertGreater(datetime.now(timezone.utc), merged_at)
        row = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now,
        )
        self.assertEqual(row["verdict"], "regression")
        signals = {r["metric_id"]: r["signal"] for r in row["readings"]}
        self.assertEqual(signals["finding_recurrence"], "regression")

    def test_no_gain_when_the_finding_reproduces_after_the_merge(self) -> None:
        change_id = self._chain()
        merged_at = self._merge(change_id, nights_ago=5)
        self._finding_event("finding_reproduced", at=merged_at + timedelta(days=1))
        row = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now,
        )
        self.assertEqual(row["verdict"], "no_gain")

    def test_gain_confirmed_requires_a_post_merge_ledger_reading(self) -> None:
        change_id = self._chain()
        merged_at = self._merge(change_id, nights_ago=5)
        self._observation(change_id, at=merged_at + timedelta(days=1),
                          matched=True, status="ok")
        row = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now,
        )
        self.assertEqual(row["verdict"], "gain_confirmed")

    def test_a_red_rerun_alone_is_not_promoted_to_a_verdict(self) -> None:
        # Without the detector's event the night refuses to guess: the
        # re-run metric goes unavailable, so the change reads unknown
        # rather than manufacturing a second regression opinion.
        change_id = self._chain()
        merged_at = self._merge(change_id, nights_ago=5)
        self._observation(change_id, at=merged_at + timedelta(days=1),
                          matched=False, status="failed")
        row = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now,
        )
        self.assertEqual(row["verdict"], "unknown")


class ProposalClaimRefusalTests(OutcomeBase):
    def test_outcome_computed_from_the_proposal_claim_is_refused(self) -> None:
        change_id = self._chain()
        self._merge(change_id, nights_ago=5)

        def _claim_metric(ctx) -> MetricReading:
            # The exact defect this gate exists for: a metric that reads
            # what the change PROMISED (proposals.jsonl is a declared
            # ledger, so "is it a ledger?" alone would not catch it).
            return MetricReading(
                metric_id="declared_benefit_from_proposal", signal="gain",
                evidence_sources=("proposals",),
                evidence_refs=("proposals.jsonl:1",),
                observed={"claimed_benefit": "removes the defect class"},
                reason="the proposal says so",
            )

        with patch.dict(BENEFIT_METRICS, {"declared_benefit_from_proposal": _claim_metric}):
            with self.assertRaises(GovernanceError) as ctx:
                emit_change_outcome(
                    change_id=change_id, repo_root=self.repo,
                    base_dir=self.tools, now=self.now,
                )
        self.assertIn("outcome_from_proposal_claim_refused", str(ctx.exception))
        self.assertNotIn("proposals", LEDGER_EVIDENCE_SOURCES)
        # Refused BEFORE persistence: no row, no counter.
        self.assertEqual(list_change_outcomes(base_dir=self.tools), [])


class ReproducibilityTests(OutcomeBase):
    def test_verdict_is_reproducible_from_the_ledgers_alone(self) -> None:
        change_id = self._chain()
        merged_at = self._merge(change_id, nights_ago=5)
        self._finding_event("finding_reproduced", at=merged_at + timedelta(days=1))
        row = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now,
        )
        again = recompute_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now + timedelta(hours=6),
        )
        self.assertEqual(again["verdict"], row["verdict"])
        self.assertEqual(again["inputs_digest"], row["inputs_digest"])

    def test_re_emitting_the_same_evidence_is_idempotent(self) -> None:
        change_id = self._chain()
        self._merge(change_id, nights_ago=5)
        first = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now,
        )
        second = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now + timedelta(days=1),
        )
        self.assertEqual(first["inputs_digest"], second["inputs_digest"])
        rows = (self.tools / "change-ledger" / "outcome.jsonl").read_text(
            encoding="utf-8").strip().splitlines()
        self.assertEqual(len(rows), 1)


class EligibilityTests(OutcomeBase):
    def test_premature_outcome_is_refused(self) -> None:
        change_id = self._chain()
        self._merge(change_id, nights_ago=1)
        with self.assertRaises(GovernanceError) as ctx:
            emit_change_outcome(
                change_id=change_id, repo_root=self.repo,
                base_dir=self.tools, now=self.now,
            )
        self.assertIn("change_outcome_premature", str(ctx.exception))

    def test_unmerged_chain_is_never_evaluated(self) -> None:
        change_id = self._chain()
        with self.assertRaises(GovernanceError) as ctx:
            emit_change_outcome(
                change_id=change_id, repo_root=self.repo,
                base_dir=self.tools, now=self.now,
            )
        self.assertIn("change_outcome_requires_merged_change", str(ctx.exception))
        payload = evaluate_change_outcomes(
            self.repo, cycle_id="cyc-1", base_dir=self.tools, now=self.now,
        )
        self.assertEqual(payload["evaluated"], 0)
        self.assertEqual(payload["skipped"].get("not_merged"), 1)


class NightlyPhaseTests(OutcomeBase):
    def test_night_evaluates_eligible_chains_and_discloses_skips(self) -> None:
        ready = self._chain(idx=1)
        merged_at = self._merge(ready, nights_ago=OUTCOME_EVALUATION_NIGHTS + 1,
                                pr_number=1)
        self._finding_event("finding_reproduced", at=merged_at + timedelta(days=1))
        self._cost_row(plan_idx=1, source_type="orphan_finding")
        too_fresh = self._chain(idx=2, finding_id="F-902")
        self._merge(too_fresh, nights_ago=1, pr_number=2)

        payload = evaluate_change_outcomes(
            self.repo, cycle_id="cyc-1", base_dir=self.tools, now=self.now,
        )
        self.assertEqual(payload["evaluated"], 1)
        self.assertEqual(payload["verdicts"]["no_gain"], 1)
        self.assertEqual(payload["skipped"].get("window_not_elapsed"), 1)
        self.assertEqual(payload["errors"], [])

    def test_negative_verdict_folds_into_cycles_rejected(self) -> None:
        change_id = self._chain(idx=1)
        merged_at = self._merge(change_id, nights_ago=5)
        self._finding_event("finding_reproduced", at=merged_at + timedelta(days=1))
        self._cost_row(plan_idx=1, source_type="orphan_finding")
        evaluate_change_outcomes(
            self.repo, cycle_id="cyc-1", base_dir=self.tools, now=self.now,
        )
        rows = rank_pressure_sources(workspace_root=self.repo)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source_type"], "orphan_finding")
        self.assertEqual(rows[0]["cycles_rejected"], 1)
        # The merge itself is not re-counted by the outcome pass.
        self.assertEqual(rows[0]["cycles_merged"], 0)

    def test_unresolved_pressure_source_skips_the_aggregate_without_a_default(self) -> None:
        change_id = self._chain(idx=1)
        merged_at = self._merge(change_id, nights_ago=5)
        self._finding_event("finding_reproduced", at=merged_at + timedelta(days=1))
        row = emit_change_outcome(
            change_id=change_id, repo_root=self.repo,
            base_dir=self.tools, now=self.now,
        )
        self.assertEqual(row["verdict"], "no_gain")
        self.assertIsNone(row["pressure_source_type"])
        self.assertEqual(rank_pressure_sources(workspace_root=self.repo), [])


class CycleWiringTests(unittest.TestCase):
    def test_phase_is_registered_after_the_bench_with_a_closed_precondition(self) -> None:
        from aria_kernel.cycle import CYCLE_PHASES, CYCLE_PRECONDITIONS, WRITES_PERMITTED

        names = [phase.name for phase in CYCLE_PHASES]
        self.assertIn("change_outcome_evaluation", names)
        self.assertGreater(
            names.index("change_outcome_evaluation"),
            names.index("experiment_night"),
            "the verdict must read the bench's evidence from the same night",
        )
        phase = next(p for p in CYCLE_PHASES if p.name == "change_outcome_evaluation")
        self.assertIs(phase.precondition, WRITES_PERMITTED)
        self.assertIn(phase.precondition, CYCLE_PRECONDITIONS)
        self.assertEqual(phase.on_error, "record_and_continue")
        self.assertEqual(phase.state_key, "change_outcome_evaluation")

    def test_outcome_ledger_is_a_declared_surface_of_the_change_family(self) -> None:
        from aria_kernel.state_manifest import surface_for_relative_path

        surface = surface_for_relative_path("change-ledger/outcome.jsonl")
        self.assertIsNotNone(surface)
        self.assertEqual(surface.name, "change_outcome")
        self.assertEqual(surface.lock_group, "change_ledger")
        self.assertEqual(surface.observe_class, "observation")


if __name__ == "__main__":
    unittest.main()
