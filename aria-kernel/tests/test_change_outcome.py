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
    precondition, after the bench that produces its evidence;
  * ``closure_by_any_author`` (F3.3b): a merged change reads ``gain`` when the
    finding it was made for was closed BY THAT MERGE (the finding store's
    RESOLVED row names the merge sha the merged row recorded), whoever authored
    the closure, and never ``no_gain``/``regression`` (an open finding is
    silence); every metric is partitioned ``reality``/``board`` and the verdict
    folds ``reality`` readings only.
"""
from __future__ import annotations

import ast
import dataclasses
import shutil
import subprocess
import tempfile
import unittest
import hashlib
import json
import os
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
import aria_kernel.change_outcome as outcome_owner

_FINDING_ID = "F-901"
_PLAN_ID = "plan-g4"
_PR_NUMBER = 4242

# F3.3b — two full merge shas (40 hex, letters in both so an upper-cased copy differs).
_M1 = "5e1f0c7a9b3d4e6f8a0b1c2d3e4f5a6b7c8d9e0f"
_M2 = "9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a39281706"
_CLOSER = "aria-kernel:implementation_reconciler"
_CLOSURE_METRIC = "closure_by_any_author"
_READING_KEYS = {"metric_id", "signal", "evidence_sources", "evidence_refs", "observed", "reason"}
# The resolver's closed reason set (SPEC ruling 2), pinned verbatim.
_NOT_IN_STORE = "finding_id_not_in_the_finding_store"
_NO_MERGE_SHA = "merge_sha_unrecorded"
_NOT_RESOLVED = "finding_not_resolved_after_the_merge"
_BY_THIS_MERGE = "finding_resolved_by_this_merge"
_BY_ANOTHER = "finding_resolved_by_another_commit"


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat()


class OutcomeBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-change-outcome-"))
        environment = patch.dict(os.environ, {"ARIA_REPO_STATE_ROOT": str(self.tmp / "repo-state")})
        environment.start()
        self.addCleanup(environment.stop)
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        self.now = datetime(2026, 8, 20, 3, 0, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- fixture builders: every row goes through a declared surface ----

    def _chain(
        self, *, idx: int = 1, finding_id: str = _FINDING_ID, commit_sha: str | None = None,
    ) -> str:
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
            commit_sha=commit_sha or f"sha{idx:03d}",
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

    def _merge(
        self, change_id: str, *, nights_ago: float, pr_number: int = _PR_NUMBER,
        merge_sha: str | None = None,
    ) -> datetime:
        merged_at = self.now - timedelta(days=nights_ago)
        path = self.tools / "pr-lifecycle.jsonl"
        append_declared_fixture(
            path,
            {
                "schema_version": 1, "recorded_at": _iso(merged_at - timedelta(hours=1)),
                "event": "opened", "pr_number": pr_number, "change_id": change_id,
            },
            expected_surface="pr_lifecycle",
        )
        merged_row = {
            "schema_version": 1, "recorded_at": _iso(merged_at),
            "event": "merged", "pr_number": pr_number, "change_id": None, "head_lineage": "delivered",
        }
        if merge_sha is not None:
            # record_merge's shape (F3.3a): the merge GitHub observed, anchored by merged_at.
            merged_row.update(merge_sha=merge_sha, merged_at=_iso(merged_at))
        append_declared_fixture(path, merged_row, expected_surface="pr_lifecycle")
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

    def _finding_event(
        self, event: str, *, at: datetime, finding_id: str = _FINDING_ID, **extra: object,
    ) -> None:
        events = findings_dir(self.repo) / "finding-events.jsonl"
        events.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            events,
            {
                "schema_version": 1, "event": event,
                "event_id": f"finding:{finding_id}:{event}:{_iso(at)}",
                "finding_id": finding_id, "recorded_at": _iso(at), **extra,
            },
            expected_surface="repo_finding_events",
        )

    def _resolution_event(
        self, *, at: datetime, closes_in_commit: str | None, to_status: str = "RESOLVED",
        finding_id: str = _FINDING_ID, actor: str = _CLOSER,
    ) -> str:
        """A ``finding_status_changed`` row in finding_closure's shape; ``None`` omits ``closes_in_commit``."""
        event_id = f"finding:{finding_id}:status:{to_status}:{_iso(at)}"
        row: dict[str, object] = {
            "schema_version": 1, "event": "finding_status_changed", "event_id": event_id,
            "finding_id": finding_id, "from_status": "IN_PROGRESS", "to_status": to_status,
            "reason": "implementation merged; the detector does not reproduce the subject at that commit",
            "actor": actor, "recorded_at": _iso(at),
        }
        if closes_in_commit is not None:
            row["closes_in_commit"] = closes_in_commit
        events = findings_dir(self.repo) / "finding-events.jsonl"
        events.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(events, row, expected_surface="repo_finding_events")
        return event_id

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
        self.assertEqual(rank_pressure_sources(base_dir=self.tools), [])

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

    def test_a_merge_is_credited_only_to_the_change_the_opened_row_bound(self) -> None:
        # merge-delivery-1 (ARIA-HIGH-521) — the PR → change binding has one
        # owner (merge_record.pr_change_binding: the PR's opened rows). A row
        # written before observations were made unable to bind (an observed
        # row copying a change_id from its payload) must not attribute the
        # PR's merge to another change.
        delivered = self._chain(idx=1)
        unrelated = self._chain(idx=2)
        merged_at = self._merge(delivered, nights_ago=3)
        append_declared_fixture(
            self.tools / "pr-lifecycle.jsonl",
            {"schema_version": 1, "recorded_at": _iso(merged_at), "event": "observed",
             "pr_number": _PR_NUMBER, "change_id": unrelated},
            expected_surface="pr_lifecycle",
        )
        self.assertIsNone(outcome_owner._merge_record_for_change(self.tools, unrelated))
        merged = outcome_owner._merge_record_for_change(self.tools, delivered)
        self.assertEqual((merged["event"], merged["pr_number"]), ("merged", _PR_NUMBER))


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
        # The counter is a tools-root surface: it lands in the store next
        # to the outcome row, never in a shadow <repo>/aria-tools (which is
        # where the writer put it, and where this test used to look, until
        # B4 2026-09-12 — green on a path the state branch never carried).
        self.assertFalse((self.repo / "aria-tools").exists())
        rows = rank_pressure_sources(base_dir=self.tools)
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
        self.assertEqual(rank_pressure_sources(base_dir=self.tools), [])


class ClosureBase(OutcomeBase):
    """F3.3b fixtures: a merged chain whose merged row names its merge commit."""

    def _merged_chain(
        self, *, nights_ago: float = 5, merge_sha: str | None = _M1, idx: int = 1,
        pr_number: int = _PR_NUMBER, finding_id: str = _FINDING_ID,
    ) -> tuple[str, datetime]:
        change_id = self._chain(idx=idx, finding_id=finding_id)
        merged_at = self._merge(
            change_id, nights_ago=nights_ago, pr_number=pr_number, merge_sha=merge_sha,
        )
        return change_id, merged_at

    def _recomputed(self, change_id: str) -> dict:
        return recompute_change_outcome(
            change_id=change_id, repo_root=self.repo, base_dir=self.tools, now=self.now,
        )

    def _closure(self, outcome: dict) -> dict:
        reading = next(
            (r for r in outcome["readings"] if r["metric_id"] == _CLOSURE_METRIC), None,
        )
        self.assertIsNotNone(
            reading,
            f"{_CLOSURE_METRIC} is not among the readings {[r['metric_id'] for r in outcome['readings']]}",
        )
        return reading

    def _assert_reading(self, outcome: dict, signal: str, reason: str) -> dict:
        reading = self._closure(outcome)
        self.assertEqual((reading["signal"], reading["reason"]), (signal, reason))
        # Whatever the case: the one reading shape, the finding store as its only source,
        # and a signal that is never no_gain or regression (an open finding is silence).
        self.assertIn(reading["signal"], {"gain", "unavailable"})
        self.assertEqual(reading["evidence_sources"], ["repo_finding_events"])
        self.assertEqual(set(reading), _READING_KEYS)
        return reading


class ClosureByAnyAuthorTests(ClosureBase):
    def test_the_resolver_is_registered_and_admits_no_new_source(self) -> None:
        self.assertIn(_CLOSURE_METRIC, BENEFIT_METRICS)
        # The finding store was already one of the four admissible sources.
        self.assertEqual(LEDGER_EVIDENCE_SOURCES, frozenset({
            "repo_finding_events", "tools_governance",
            "experiment_observations", "validation_runs",
        }))

    def test_the_1906_shape_reads_gain_and_confirms_the_change(self) -> None:
        # Literal values of the snapshot (aria/state 8e39b2eeb): the change's own
        # committed sha is not the merge sha, the closure names the merge sha.
        merged = datetime(2026, 10, 10, 1, 3, 6, tzinfo=timezone.utc)
        merge_sha = "528c63c0d0921af1645f027dc76e4a594431f5c6"
        self.now = merged + timedelta(days=3.5)
        change_id = self._chain(
            finding_id="F-015", commit_sha="1ac2048c2a7adf14f0e62505caeacb68447d68a9",
        )
        self.assertEqual(self._merge(change_id, nights_ago=3.5, merge_sha=merge_sha), merged)
        closure = self._resolution_event(
            at=datetime(2026, 10, 10, 1, 28, 28, tzinfo=timezone.utc),
            closes_in_commit=merge_sha, finding_id="F-015",
        )
        row = emit_change_outcome(
            change_id=change_id, repo_root=self.repo, base_dir=self.tools, now=self.now,
        )
        reading = self._assert_reading(row, "gain", _BY_THIS_MERGE)
        self.assertEqual(reading["evidence_refs"], [closure])
        observed = reading["observed"]
        self.assertEqual(observed["merge_sha"], merge_sha)
        # The counts read 0 or 1 here, so an int or a bool answers the same.
        self.assertEqual(observed["resolved_events_after_merge"], 1)
        self.assertEqual(observed["bound_to_this_merge"], 1)
        self.assertEqual(list(observed["closing_commits"]), [merge_sha])
        self.assertEqual(list(observed["actors"]), [_CLOSER])
        self.assertEqual(row["verdict"], "gain_confirmed")
        # gain_confirmed writes no counter: F4.1 owns the merged counter.
        self.assertEqual(rank_pressure_sources(base_dir=self.tools), [])

    def test_a_closure_is_credited_only_to_the_merge_it_names(self) -> None:
        # The F-013 shape: two change chains on one finding, one closure.
        first, _merged_1 = self._merged_chain(nights_ago=6, merge_sha=_M1, idx=1, pr_number=1)
        second, merged_2 = self._merged_chain(nights_ago=4, merge_sha=_M2, idx=2, pr_number=2)
        # "Any author": the closer is not the reconciler, and the resolver never asks who it was.
        self._resolution_event(
            at=merged_2 + timedelta(minutes=25), closes_in_commit=_M2, actor="operator-lane:claude",
        )
        earlier = self._recomputed(first)
        observed = self._assert_reading(earlier, "unavailable", _BY_ANOTHER)["observed"]
        self.assertEqual(observed["merge_sha"], _M1)
        self.assertEqual(observed["resolved_events_after_merge"], 1)
        self.assertEqual(observed["bound_to_this_merge"], 0)
        self.assertEqual(list(observed["closing_commits"]), [_M2])
        self.assertEqual(list(observed["actors"]), ["operator-lane:claude"])
        self.assertEqual(earlier["verdict"], "unknown")
        later = self._recomputed(second)
        self._assert_reading(later, "gain", _BY_THIS_MERGE)
        self.assertEqual(later["verdict"], "gain_confirmed")

    def test_a_closure_recorded_before_a_later_merge_is_not_after_that_merge(self) -> None:
        change_id, merged_at = self._merged_chain(merge_sha=_M2)
        # An earlier merge (no chain of its own here) closed the finding before this merge.
        self._resolution_event(at=merged_at - timedelta(days=1), closes_in_commit=_M1)
        self._assert_reading(self._recomputed(change_id), "unavailable", _NOT_RESOLVED)

    def test_an_open_finding_is_silence_never_no_gain(self) -> None:
        change_id, merged_at = self._merged_chain()
        # A sibling finding the same merge closed is that finding's closure, not this one's.
        self._resolution_event(
            at=merged_at + timedelta(minutes=25), closes_in_commit=_M1, finding_id="F-902",
        )
        row = self._recomputed(change_id)
        self._assert_reading(row, "unavailable", _NOT_RESOLVED)
        self.assertEqual(row["verdict"], "unknown")
        # A defect recorded again is the recurrence metric's no_gain, not this resolver's.
        self._finding_event("finding_reproduced", at=merged_at + timedelta(days=1))
        row = self._recomputed(change_id)
        self._assert_reading(row, "unavailable", _NOT_RESOLVED)
        signals = {r["metric_id"]: r["signal"] for r in row["readings"]}
        self.assertEqual(signals["finding_recurrence"], "no_gain")
        self.assertEqual(row["verdict"], "no_gain")

    def test_a_closure_at_or_before_the_merge_instant_is_not_after_the_merge(self) -> None:
        change_id, merged_at = self._merged_chain()
        for offset in (timedelta(hours=-1), timedelta(seconds=-1), timedelta(0)):
            self._resolution_event(at=merged_at + offset, closes_in_commit=_M1)
        row = self._recomputed(change_id)
        self._assert_reading(row, "unavailable", _NOT_RESOLVED)
        self.assertEqual(row["verdict"], "unknown")

    def test_a_closure_one_second_after_the_merge_instant_is_after_the_merge(self) -> None:
        change_id, merged_at = self._merged_chain()
        self._resolution_event(at=merged_at + timedelta(seconds=1), closes_in_commit=_M1)
        self._assert_reading(self._recomputed(change_id), "gain", _BY_THIS_MERGE)

    def test_only_a_resolved_transition_counts(self) -> None:
        change_id, merged_at = self._merged_chain()
        for minutes, status in ((10, "IN_PROGRESS"), (20, "SUPPRESSED"), (30, "WITHDRAWN")):
            # A raw row may carry closes_in_commit; the status decides, not the field.
            self._resolution_event(
                at=merged_at + timedelta(minutes=minutes), closes_in_commit=_M1, to_status=status,
            )
        row = self._recomputed(change_id)
        self._assert_reading(row, "unavailable", _NOT_RESOLVED)
        self.assertEqual(row["verdict"], "unknown")

    def test_the_closing_commit_must_equal_the_merge_sha_exactly(self) -> None:
        change_id, merged_at = self._merged_chain()
        # None of these names the merge: no commit, a 7-char prefix, an upper-cased sha.
        for minutes, closes in ((10, None), (20, _M1[:7]), (30, _M1.upper())):
            self._resolution_event(at=merged_at + timedelta(minutes=minutes), closes_in_commit=closes)
        row = self._recomputed(change_id)
        observed = self._assert_reading(row, "unavailable", _BY_ANOTHER)["observed"]
        self.assertEqual(observed["bound_to_this_merge"], 0)
        self.assertEqual(row["verdict"], "unknown")

    def test_a_full_closure_sha_is_not_bound_to_an_abbreviated_merged_row(self) -> None:
        change_id, merged_at = self._merged_chain(merge_sha=_M1[:7])
        self._resolution_event(at=merged_at + timedelta(minutes=25), closes_in_commit=_M1)
        row = self._recomputed(change_id)
        self._assert_reading(row, "unavailable", _BY_ANOTHER)
        self.assertEqual(row["verdict"], "unknown")

    def test_a_merged_row_without_a_merge_sha_never_reads_gain(self) -> None:
        change_id, merged_at = self._merged_chain(merge_sha=None)
        self._resolution_event(at=merged_at + timedelta(minutes=25), closes_in_commit=_M1)
        row = self._recomputed(change_id)
        self._assert_reading(row, "unavailable", _NO_MERGE_SHA)
        self.assertEqual(row["verdict"], "unknown")

    def test_an_empty_merge_sha_never_equals_a_closure_naming_no_commit(self) -> None:
        change_id, merged_at = self._merged_chain(merge_sha="")
        self._resolution_event(at=merged_at + timedelta(minutes=25), closes_in_commit=None)
        row = self._recomputed(change_id)
        self._assert_reading(row, "unavailable", _NO_MERGE_SHA)
        self.assertEqual(row["verdict"], "unknown")

    def test_ids_outside_the_finding_store_are_unavailable_and_touch_no_registry(self) -> None:
        from aria_kernel import report_ingestion

        changes = []
        # (finding id, merge sha): the last one also lacks a merge sha, and the id check comes first.
        for idx, (finding_id, merge_sha) in enumerate(
            (("plan:plan-g4-1", _M1), ("ARIA-HIGH-745", _M1), ("ORPHAN-HIGH-811", None)), start=1,
        ):
            change_id, merged_at = self._merged_chain(
                idx=idx, pr_number=idx, finding_id=finding_id, merge_sha=merge_sha,
            )
            # Even a row that would bind (same sha, after the merge) is not read for such an id.
            self._resolution_event(
                at=merged_at + timedelta(minutes=25), closes_in_commit=_M1, finding_id=finding_id,
            )
            changes.append(change_id)
        with patch("subprocess.run", side_effect=AssertionError("subprocess")) as run, \
                patch.object(report_ingestion, "run_registry_cli", side_effect=AssertionError("registry")) as cli:
            outcomes = [self._recomputed(change_id) for change_id in changes]
        run.assert_not_called()
        cli.assert_not_called()
        for outcome in outcomes:
            self._assert_reading(outcome, "unavailable", _NOT_IN_STORE)
            self.assertEqual(outcome["verdict"], "unknown")

    def test_fix_verified_is_not_read_by_the_closure_resolver(self) -> None:
        change_id, merged_at = self._merged_chain()
        self._finding_event(
            "finding_fix_verified", at=merged_at + timedelta(days=1), commit_sha=_M1,
        )
        row = self._recomputed(change_id)
        # finding_recurrence owns that event: one reader per event type.
        self._assert_reading(row, "unavailable", _NOT_RESOLVED)
        signals = {r["metric_id"]: r["signal"] for r in row["readings"]}
        self.assertEqual(signals["finding_recurrence"], "gain")
        self.assertEqual(row["verdict"], "gain_confirmed")

    def test_closure_gain_never_masks_a_recorded_regression(self) -> None:
        change_id, merged_at = self._merged_chain()
        self._resolution_event(at=merged_at + timedelta(minutes=25), closes_in_commit=_M1)
        append_tools_governance(
            self.tools, "experiment_regression_detected",
            {"finding_id": _FINDING_ID, "experiment_id": "exp-1", "recipe_ref": "rec-1",
             "validation_run_id": "vr-9", "original_fix_commit": "sha001"},
        )
        row = self._recomputed(change_id)
        self._assert_reading(row, "gain", _BY_THIS_MERGE)
        signals = {r["metric_id"]: r["signal"] for r in row["readings"]}
        self.assertEqual(signals["finding_recurrence"], "regression")
        self.assertEqual(row["verdict"], "regression")


class ClosureCapturedReadTests(ClosureBase):
    """The captured (assessment) context reads its own rows, bounded above by ``evaluated_at``."""

    def _require_the_merge_sha_field(self) -> None:
        fields = {f.name: f for f in dataclasses.fields(outcome_owner.EvaluationContext)}
        self.assertTrue("merge_sha" in fields, "EvaluationContext carries no merge_sha (SPEC ruling 5)")
        self.assertIs(fields["merge_sha"].default, dataclasses.MISSING)
        self.assertIs(fields["merge_sha"].default_factory, dataclasses.MISSING)

    def _identity(self, merged_at: datetime, evaluated_at: datetime, merge_sha: str) -> dict:
        return dict(
            change_id="chg-captured", finding_id=_FINDING_ID, plan_id="plan-captured",
            commit_sha="sha001", merged_at=merged_at, evaluated_at=evaluated_at,
            repo_root=self.repo, tools_root=self.tools, merge_sha=merge_sha,
        )

    def _captured(self, rows: list[dict], identity: dict):
        verified = (
            ("experiment_observations", b"[]"),
            ("repo_finding_events", json.dumps(rows).encode("utf-8")),
            ("tools_governance", b"[]"),
        )
        return outcome_owner._AssessmentCapture(
            **identity, _native_sources=(), _verified_sources=verified, _metadata=b"{}",
        )

    def _read(self, ctx) -> dict:
        reading = next(
            (r for r in outcome_owner._metric_readings(ctx) if r.metric_id == _CLOSURE_METRIC), None,
        )
        self.assertIsNotNone(reading, f"{_CLOSURE_METRIC} is not among the metric readings")
        return reading.as_dict()

    @staticmethod
    def _row(at: datetime, closes_in_commit: str = _M1) -> dict:
        return {
            "schema_version": 1, "event": "finding_status_changed",
            "event_id": f"finding:{_FINDING_ID}:status:RESOLVED:{_iso(at)}",
            "finding_id": _FINDING_ID, "from_status": "IN_PROGRESS", "to_status": "RESOLVED",
            "reason": "closed", "actor": _CLOSER, "recorded_at": _iso(at),
            "closes_in_commit": closes_in_commit,
        }

    def test_the_evaluation_context_carries_a_required_merge_sha(self) -> None:
        self._require_the_merge_sha_field()

    def test_a_captured_context_reads_its_captured_rows_not_the_live_file(self) -> None:
        self._require_the_merge_sha_field()
        merged_at = self.now - timedelta(days=5)
        identity = self._identity(merged_at, self.now, _M1)
        bound = self._row(merged_at + timedelta(hours=1))
        # No live finding-events file exists at all: the capture is the source.
        self.assertFalse((findings_dir(self.repo) / "finding-events.jsonl").exists())
        reading = self._read(self._captured([bound], identity))
        self.assertEqual((reading["signal"], reading["reason"]), ("gain", _BY_THIS_MERGE))
        self.assertEqual(reading["evidence_refs"], [bound["event_id"]])
        # The reverse: the live file names the binding, the capture does not.
        self._resolution_event(at=merged_at + timedelta(hours=1), closes_in_commit=_M1)
        reading = self._read(self._captured([], identity))
        self.assertEqual((reading["signal"], reading["reason"]), ("unavailable", _NOT_RESOLVED))

    def test_a_captured_closure_after_the_cutoff_is_excluded_and_the_cutoff_is_inclusive(self) -> None:
        self._require_the_merge_sha_field()
        merged_at = self.now - timedelta(days=5)
        evaluated_at = merged_at + timedelta(days=2)
        identity = self._identity(merged_at, evaluated_at, _M1)
        after = self._read(self._captured([self._row(evaluated_at + timedelta(seconds=1))], identity))
        self.assertEqual((after["signal"], after["reason"]), ("unavailable", _NOT_RESOLVED))
        at_cutoff = self._read(self._captured([self._row(evaluated_at)], identity))
        self.assertEqual((at_cutoff["signal"], at_cutoff["reason"]), ("gain", _BY_THIS_MERGE))

    def test_live_and_captured_contexts_read_the_same_rows_the_same_way(self) -> None:
        self._require_the_merge_sha_field()
        merged_at = self.now - timedelta(days=5)
        identity = self._identity(merged_at, self.now, _M1)
        rows = [self._row(merged_at + timedelta(hours=1), closes_in_commit=_M2),
                self._row(merged_at + timedelta(hours=2))]
        for row in rows:
            self._resolution_event(
                at=datetime.fromisoformat(row["recorded_at"]), closes_in_commit=row["closes_in_commit"],
            )
        live = self._read(outcome_owner.EvaluationContext(**identity))
        self.assertEqual(live, self._read(self._captured(rows, identity)))
        self.assertEqual((live["signal"], live["reason"]), ("gain", _BY_THIS_MERGE))
        self.assertEqual(live["observed"]["resolved_events_after_merge"], 2)
        self.assertEqual(list(live["observed"]["closing_commits"]), sorted({_M1, _M2}))
        self.assertEqual(list(live["observed"]["actors"]), [_CLOSER])

    def test_a_live_context_is_not_bounded_above_by_the_evaluation_instant(self) -> None:
        # The siblings' window: the upper bound belongs to a captured context only.
        self._require_the_merge_sha_field()
        merged_at = self.now - timedelta(days=5)
        evaluated_at = merged_at + timedelta(days=1)
        self._resolution_event(at=evaluated_at + timedelta(days=1), closes_in_commit=_M1)
        reading = self._read(outcome_owner.EvaluationContext(**self._identity(merged_at, evaluated_at, _M1)))
        self.assertEqual((reading["signal"], reading["reason"]), ("gain", _BY_THIS_MERGE))


class MetricPartitionTests(ClosureBase):
    """Every metric is ``reality`` or ``board``; the verdict folds ``reality`` readings only."""

    @staticmethod
    def _probe(signal: str):
        def resolver(ctx) -> MetricReading:
            return MetricReading(
                metric_id="partition_probe", signal=signal,
                evidence_sources=("experiment_observations",), evidence_refs=(),
                observed={}, reason="probe",
            )
        return resolver

    def _partition(self) -> dict:
        partition = getattr(outcome_owner, "METRIC_PARTITION", None)
        self.assertIsNotNone(partition, "change_outcome has no METRIC_PARTITION (SPEC ruling 7)")
        return partition

    def test_the_partition_names_the_three_reality_metrics(self) -> None:
        self.assertEqual(self._partition(), {
            "finding_recurrence": "reality", "experiment_rerun_hold": "reality",
            "closure_by_any_author": "reality",
        })

    def test_an_unpartitioned_metric_or_a_metricless_entry_is_refused_before_any_row(self) -> None:
        change_id, _merged_at = self._merged_chain()
        partition = getattr(outcome_owner, "METRIC_PARTITION", {})
        for metrics, entries, named in (
            ({"partition_probe": self._probe("unavailable")}, {}, "partition_probe"),
            ({}, {"ghost_metric": "reality"}, "ghost_metric"),
        ):
            with patch.dict(BENEFIT_METRICS, metrics), patch.dict(partition, entries):
                with self.assertRaises(GovernanceError) as raised:
                    emit_change_outcome(
                        change_id=change_id, repo_root=self.repo, base_dir=self.tools, now=self.now,
                    )
            self.assertIn("change_outcome_metric_not_partitioned", str(raised.exception))
            self.assertIn(named, str(raised.exception))
            self.assertEqual(list_change_outcomes(base_dir=self.tools), [])
            self.assertEqual(rank_pressure_sources(base_dir=self.tools), [])

    def test_the_partition_check_names_the_new_api_directly(self) -> None:
        check = getattr(outcome_owner, "_assert_every_metric_is_partitioned", None)
        self.assertTrue(callable(check), "_assert_every_metric_is_partitioned is absent (SPEC ruling 7)")
        check(BENEFIT_METRICS)  # the shipped registry is fully partitioned
        with self.assertRaisesRegex(GovernanceError, "change_outcome_metric_not_partitioned"):
            check({**BENEFIT_METRICS, "partition_probe": self._probe("gain")})

    def test_the_signal_check_still_comes_before_the_partition_check(self) -> None:
        self._partition()  # red at the base for the missing partition, not for the order
        ctx = outcome_owner.EvaluationContext(
            change_id="chg-order", finding_id=_FINDING_ID, plan_id="plan-order", commit_sha="sha001",
            merged_at=self.now - timedelta(days=5), evaluated_at=self.now, repo_root=self.repo,
            tools_root=self.tools, merge_sha=_M1,
        )
        with patch.dict(BENEFIT_METRICS, {"partition_probe": self._probe("not_a_signal")}):
            with self.assertRaisesRegex(GovernanceError, "change_outcome_unknown_metric_signal"):
                outcome_owner._metric_readings(ctx)

    def test_a_board_reading_is_recorded_but_never_moves_the_verdict(self) -> None:
        partition = self._partition()
        change_id, merged_at = self._merged_chain()
        self._finding_event("finding_reproduced", at=merged_at + timedelta(days=1))
        with patch.dict(partition, {"partition_probe": "board"}), \
                patch.dict(BENEFIT_METRICS, {"partition_probe": self._probe("regression")}):
            row = self._recomputed(change_id)
        recorded = {r["metric_id"]: r["signal"] for r in row["readings"]}
        self.assertEqual(recorded.get("partition_probe"), "regression")
        self.assertEqual(recorded["finding_recurrence"], "no_gain")
        self.assertEqual(row["verdict"], "no_gain", "a board regression moved the verdict")

    def test_the_fold_ignores_every_board_signal(self) -> None:
        partition = self._partition()
        board = {s: self._probe(s)(None) for s in ("regression", "no_gain", "gain")}
        with patch.dict(partition, {"partition_probe": "board"}):
            for signal, reading in board.items():
                self.assertEqual(outcome_owner.fold_outcome_verdict([reading]), "unknown", signal)
            reality = MetricReading(
                metric_id="finding_recurrence", signal="gain", evidence_sources=("repo_finding_events",),
                evidence_refs=(), observed={}, reason="r",
            )
            self.assertEqual(
                outcome_owner.fold_outcome_verdict([reality, board["regression"]]), "gain_confirmed",
            )

    def test_the_partition_is_not_a_field_of_the_reading(self) -> None:
        self._partition()
        self.assertEqual({f.name for f in dataclasses.fields(MetricReading)}, _READING_KEYS)


class FindingEventsOneReaderTests(unittest.TestCase):
    """SPEC T14: the finding store is read inside change_outcome by ONE helper both resolvers call."""

    class _Calls(ast.NodeVisitor):
        def __init__(self) -> None:
            self.stack: list[str] = []
            self.sites: list[tuple[str, ast.Call]] = []

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        def visit_Call(self, node: ast.Call) -> None:
            self.sites.append((self.stack[-1] if self.stack else "<module>", node))
            self.generic_visit(node)

    @staticmethod
    def _callee(call: ast.Call) -> str:
        func = call.func
        return func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""

    @staticmethod
    def _names_surface(call: ast.Call) -> bool:
        constants = [kw.value for kw in call.keywords if kw.arg == "expected_surface"] + list(call.args)
        return any(isinstance(c, ast.Constant) and c.value == "repo_finding_events" for c in constants)

    def setUp(self) -> None:
        self.tree = ast.parse(Path(outcome_owner.__file__).read_text(encoding="utf-8"))
        calls = self._Calls()
        calls.visit(self.tree)
        self.sites = calls.sites

    def test_the_finding_events_are_read_in_exactly_one_function(self) -> None:
        reads = [(fn, call) for fn, call in self.sites
                 if (self._callee(call) in {"load_declared_jsonl", "_rows"} and self._names_surface(call))
                 or self._callee(call) == "_finding_events_path"]
        self.assertEqual({fn for fn, _call in reads}, {"_finding_event_rows"})
        loads = [call for _fn, call in reads if self._callee(call) == "load_declared_jsonl"]
        self.assertEqual(len(loads), 1)

    def test_both_finding_resolvers_read_through_that_helper(self) -> None:
        functions = {node.name: node for node in ast.walk(self.tree) if isinstance(node, ast.FunctionDef)}
        for name in ("_metric_finding_recurrence", "_metric_closure_by_any_author"):
            self.assertIn(name, functions, f"{name} is absent from change_outcome")
            callees = {self._callee(n) for n in ast.walk(functions[name]) if isinstance(n, ast.Call)}
            self.assertIn("_finding_event_rows", callees, f"{name} does not read through the one helper")


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


class AssessmentHotEvidenceTests(unittest.TestCase):
    """S2-A ordinary producer contracts; retained-prefix replay is not provided.

    These initially stop at the same absent private capture capability. They
    are four future behavioral contracts, not four reproduced baseline bugs.
    """

    def setUp(self) -> None:
        from aria_kernel.auto_merge import record_pr_lifecycle
        from aria_kernel.experiment import register_experiment, register_recipe
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
        from aria_kernel.knowledge_graph import Pattern, record_convention
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding
        from aria_kernel.validation import run_validation_commands

        scratch = tempfile.TemporaryDirectory(prefix="aria-assessment-hot-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.repo = self.root / "source"
        self.repo.mkdir()
        self.tools = self.root / "store" / "tools"
        repo_state = self.root / "store" / "repo"
        repo_state.mkdir(parents=True)
        environment = patch.dict(os.environ, {
            "ARIA_TOOLS_DIR": str(self.tools),
            "ARIA_REPO_STATE_ROOT": str(repo_state),
        })
        environment.start()
        self.addCleanup(environment.stop)
        (self.repo / ".gitignore").write_text(
            "__pycache__/\naria-debts/\n", encoding="utf-8",
        )
        (self.repo / "selection.py").write_text(
            "def selected_paths(paths):\n    return sorted(set(paths))\n",
            encoding="utf-8",
        )
        (self.repo / "test_selection.py").write_text(
            "import unittest\n"
            "from selection import selected_paths\n"
            "class SelectionTests(unittest.TestCase):\n"
            "    def test_sorted_unique_paths(self):\n"
            "        paths = ['src/b.py', 'src/a.py', 'src/b.py']\n"
            "        self.assertEqual(selected_paths(paths), ['src/a.py', 'src/b.py'])\n"
            "        self.assertEqual(paths, ['src/b.py', 'src/a.py', 'src/b.py'])\n"
            "        print('ASSESSMENT_SELECTION_BEHAVIOR_OK')\n",
            encoding="utf-8",
        )
        for args in (
            ["init", "-q"], ["config", "user.name", "ARIA fixture"],
            ["config", "user.email", "aria@example.invalid"],
            ["add", "."], ["commit", "-q", "-m", "selection fixture"],
        ):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)
        self.commit_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, check=True,
            capture_output=True, text=True,
        ).stdout.strip()
        set_profile("standard", operator_approval_ref="fixture:S2-A", base_dir=self.tools)
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        self.command = "python3 -m unittest -v test_selection.SelectionTests.test_sorted_unique_paths"
        self.scope_paths = ["selection.py", "test_selection.py"]
        self.plan_id = "plan-assessment-hot"
        self.finding_id = "F-9901"
        self.planned = emit_change_planned(
            plan_id=self.plan_id, finding_id=self.finding_id,
            intended_affected_files=self.scope_paths,
            intended_validation_refs=[self.command], architectural_tier=1,
            base_dir=self.tools,
        )
        self.change_id = self.planned["change_id"]
        emit_change_committed(
            change_id=self.change_id, commit_sha=self.commit_sha,
            actual_affected_files=self.scope_paths, base_dir=self.tools,
        )
        initial = run_validation_commands(
            commands=[self.command], workspace_root=self.repo,
            change_id=self.change_id, commit_sha=self.commit_sha,
            runner_identity="ci-executor:assessment-hot",
            change_author_identity="agent:assessment-planner", base_dir=self.tools,
        )
        self.assertEqual(initial["status"], "ok")
        self.assertEqual(len(initial["validation_run_ids"]), 1)
        run = self._verified_run(initial["validation_run_ids"][0])
        validated = emit_change_validated(
            change_id=self.change_id,
            validation_run_refs=[{
                "validation_run_id": run["validation_run_id"], "cmd": run["cmd"],
                "exit_code": run["exit_code"], "log_path": run["log_path"],
                "ran_at": run["completed_at"],
            }],
            base_dir=self.tools, workspace_root=self.repo,
        )
        self.assertTrue(validated["validation_matrix_passed"])
        # The normal PR observation owner supplies the original fixture rows;
        # only its clock is controlled. This is no live merge/review simulation.
        merged = datetime.now(timezone.utc) - timedelta(days=4)
        self.merged_at = _iso(merged)
        with patch("aria_kernel.auto_merge.utc_now", return_value=self.merged_at):
            record_pr_lifecycle(
                {"number": 9901, "change_id": self.change_id, "head_sha": self.commit_sha,
                 "changed_files": self.scope_paths}, event="opened", base_dir=self.tools,
            )
            # ARIA-HIGH-390 — the merged row has one writer.
            from aria_kernel.merge_record import MERGED_BY_MERGE_LANE, lifecycle_rows, record_merge

            record_merge(pr={"number": 9901, "head_sha": self.commit_sha}, merged_by=MERGED_BY_MERGE_LANE,
                         base_dir=self.tools, head_lineage="delivered")
            merge_row = lifecycle_rows(self.tools)[-1]
        self.assertIsNone(merge_row["change_id"])
        self.first = emit_change_outcome(
            change_id=self.change_id, repo_root=self.repo, base_dir=self.tools,
        )
        self.assertEqual(self.first["verdict"], "unknown")
        self.outcome_path = self.tools / "change-ledger" / "outcome.jsonl"
        self.first_bytes = self.outcome_path.read_bytes()

        # Existing fixture signing authority, not an orchestrator signing fix.
        signer_cycle = "assessment-hot-fixture"
        signer = mint_signing_key(cycle_id=signer_cycle, workspace_root=self.repo)
        self.addCleanup(revoke_signing_key, cycle_id=signer_cycle, workspace_root=self.repo)
        self.pattern_id = "convention-assessment-hot"
        record_convention(
            Pattern(
                pattern_id=self.pattern_id, pattern_type="convention", confidence=0.5,
                evidence_refs=("selection.py:1", "test_selection.py:3"),
                discovered_by_cycle_id="cycle-assessment-original",
                observed_at=_iso(datetime.now(timezone.utc)), outcome_status="hypothesis",
                plan_id=self.plan_id,
            ),
            workspace_root=self.repo, base_dir=self.tools, signer_key_fp=signer.fingerprint,
        )
        register_recipe(
            recipe_id="recipe-assessment-selection", command=self.command,
            timeout_ms=30_000, deterministic=True, base_dir=self.tools,
            input_scope={"schema_version": 1, "files": {
                "source": ["selection.py"], "test": ["test_selection.py"],
                "config": [".gitignore"], "dependency": [],
            }},
        )
        register_experiment(
            experiment_id="experiment-assessment-selection",
            hypothesis="Selected paths are sorted, unique and leave the input unchanged",
            recipe_ref="recipe-assessment-selection",
            observation_contract={"comparator": "log_contains", "expected": "ASSESSMENT_SELECTION_BEHAVIOR_OK"},
            finding_ref=self.finding_id, base_dir=self.tools,
        )
        self.cutoff = datetime.now(timezone.utc) + timedelta(days=1)

    def _verified_run(self, run_id: str) -> dict:
        from aria_kernel.validation_runs_ledger import verify_validation_run

        run = verify_validation_run(run_id, base_dir=self.tools)
        self.assertEqual(run["change_id"], self.change_id)
        self.assertEqual(run["commit_sha"], self.commit_sha)
        self.assertEqual(run["cmd"], self.command)
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["exit_code"], 0)
        self.assertFalse(run["timed_out"])
        log = Path(run["log_path"]).read_bytes()
        self.assertEqual(run["log_hash"], "sha256:" + hashlib.sha256(log).hexdigest())
        self.assertIn(b"Ran 1 test", log)
        self.assertIn(b"ASSESSMENT_SELECTION_BEHAVIOR_OK", log)
        return run

    def _observe(self) -> dict:
        from aria_kernel.experiment import run_experiment

        observation = run_experiment(
            experiment_id="experiment-assessment-selection", workspace_root=self.repo,
            change_id=self.change_id, commit_sha=self.commit_sha,
            runner_identity="ci-executor:assessment-hot",
            change_author_identity="agent:assessment-planner", base_dir=self.tools,
        )
        run = self._verified_run(observation["validation_run_id"])
        self.assertTrue(observation["matched"])
        self.assertEqual(observation["run_status"], "ok")
        self.assertEqual(run["input_binding"]["scope_paths"],
                         [".gitignore", "selection.py", "test_selection.py"])
        return observation

    def _capture(self):
        capture = getattr(outcome_owner, "_capture_assessment_inputs", None)
        self.assertTrue(callable(capture), "S2-A private hot-evidence capture capability is absent")
        return capture(
            change_id=self.change_id, pattern_id=self.pattern_id,
            repo_root=self.repo, base_dir=self.tools, now=self.cutoff,
        )

    def _record(self, capture, *, cycle_id: str = "cycle-assessment-1") -> dict:
        return outcome_owner._record_change_assessment(
            capture, cycle_id=cycle_id, base_dir=self.tools,
        )

    def test_assessment_append_preserves_first_outcome_readers_and_counters(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.workspace import canonical_identity

        observation = self._observe()
        observation_bytes = (self.tools / "experiments" / "observations.jsonl").read_bytes()
        capture = self._capture()
        with patch.object(outcome_owner, "_record_aggregate", wraps=outcome_owner._record_aggregate) as aggregate:
            row = self._record(capture)
        aggregate.assert_not_called()
        self.assertEqual(row["event"], "change_assessment")
        self.assertEqual(row["$schema"], "aria/change-assessment/v1")
        self.assertEqual(row["schema_version"], 1)
        self.assertEqual(row["verdict"], "gain_confirmed")
        self.assertEqual(row["original_outcome_ref"]["ledger_hash"], self.first["ledger_hash"])
        self.assertIsNone(row["predecessor_assessment_id"])
        self.assertEqual(row["scope_paths"], self.scope_paths)
        stream_bytes = json.dumps(
            [canonical_identity(self.repo), self.pattern_id, self.scope_paths],
            sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")
        self.assertEqual(row["stream_id"], "sha256:" + hashlib.sha256(stream_bytes).hexdigest())
        self.assertEqual(row["evidence_window"], {
            "lower_exclusive": self.first["merged_at"],
            "upper_inclusive": self.cutoff.isoformat(),
        })
        sources = {item["source_surface"]: item for item in row["source_snapshots"]}
        descriptor = sources["experiment_observations"]
        self.assertEqual(descriptor["root_kind"], "tools")
        self.assertEqual(descriptor["relative_path"], "experiments/observations.jsonl")
        self.assertEqual(descriptor["presence"], "present")
        self.assertEqual(descriptor["prefix"], {
            "byte_length": len(observation_bytes), "row_count": 1,
            "sha256": "sha256:" + hashlib.sha256(observation_bytes).hexdigest(),
            "tail_ledger_hash": observation["ledger_hash"],
        })
        self.assertTrue(all(item["retained_prefix_ref"] is None for item in sources.values()))
        self.assertEqual(row["availability"]["evidence"], {"status": "available", "source_tier": "hot"})
        self.assertEqual(row["availability"]["durability"], {
            "status": "unavailable", "reason": "retained_prefix_unavailable",
        })
        self.assertEqual(outcome_owner.find_change_outcome(self.tools, self.change_id), self.first)
        self.assertEqual(list_change_outcomes(base_dir=self.tools), [self.first])
        self.assertTrue(self.outcome_path.read_bytes().startswith(self.first_bytes))
        events = load_declared_jsonl(self.outcome_path, expected_surface="change_outcome")
        self.assertEqual([item["event"] for item in events], ["change_outcome", "change_assessment"])
        self.assertEqual(events, [self.first, row])
        nightly = evaluate_change_outcomes(self.repo, base_dir=self.tools, now=self.cutoff)
        self.assertEqual(nightly["evaluated"], 0)
        self.assertEqual(nightly["outcomes"], [])
        self.assertEqual(nightly["verdicts"], {"regression": 0, "no_gain": 0, "gain_confirmed": 0, "unknown": 0})
        self.assertEqual(rank_pressure_sources(base_dir=self.tools), [])
        # The old public emitter still refuses changed evidence; it never
        # substitutes the assessment for the immutable first outcome.
        before = self.outcome_path.read_bytes()
        with self.assertRaisesRegex(GovernanceError, "change_outcome_content_drift"):
            emit_change_outcome(change_id=self.change_id, repo_root=self.repo,
                                base_dir=self.tools, now=self.cutoff)
        self.assertEqual(self.outcome_path.read_bytes(), before)

    def test_later_native_observation_does_not_change_captured_prefix(self) -> None:
        capture = self._capture()
        original = outcome_owner._compute_change_assessment(capture)
        self.assertEqual(original["verdict"], "unknown")
        observation = self._observe()
        # The later append is inside the same time window: native membership,
        # not a timestamp-only filter, must keep it out of the old capture.
        self.assertLessEqual(datetime.fromisoformat(observation["recorded_at"].replace("Z", "+00:00")), self.cutoff)
        self.assertEqual(outcome_owner._compute_change_assessment(capture), original)
        current = outcome_owner._compute_change_assessment(self._capture())
        self.assertEqual(current["verdict"], "gain_confirmed")
        self.assertNotEqual(current["inputs_digest"], original["inputs_digest"])
        self.assertEqual(self.outcome_path.read_bytes(), self.first_bytes)

    def test_a_merge_no_opened_row_bound_to_the_change_has_no_original_merge(self) -> None:
        # merge-delivery-1 (ARIA-HIGH-521) — the first outcome's merge is the
        # change's only when an opened row of the PR bound it (the one binding
        # owner). In a store whose only PR row naming the change is an
        # observation the pre-fix writer left (it copied the change_id from its
        # payload), the change has no opening, whatever that row names.
        from aria_kernel.merge_record import lifecycle_rows
        from tests._helpers.declared_fixtures import rewrite_declared_fixture

        legacy = [dict(row, event="observed") if row.get("event") == "opened" else row
                  for row in lifecycle_rows(self.tools)]
        self.assertEqual([row["event"] for row in legacy], ["observed", "merged"])
        self.assertEqual(legacy[0]["change_id"], self.change_id)
        rewrite_declared_fixture(self.tools / "pr-lifecycle.jsonl", legacy, expected_surface="pr_lifecycle")
        with self.assertRaisesRegex(GovernanceError, r"^change_assessment_original_merge_unavailable$"):
            self._capture()

    def test_the_captured_closure_reading_binds_the_merge_the_original_outcome_names(self) -> None:
        # F3.3b — the capture constructor takes merge_sha from the folded merged row
        # of the original outcome's merge, not from the change's committed sha.
        from aria_kernel.merge_record import lifecycle_rows
        from tests._helpers.declared_fixtures import rewrite_declared_fixture

        merge_sha = "528c63c0d0921af1645f027dc76e4a594431f5c6"
        self.assertNotEqual(merge_sha, self.commit_sha)
        rows = [dict(row, merge_sha=merge_sha) if row.get("event") == "merged" else row
                for row in lifecycle_rows(self.tools)]
        rewrite_declared_fixture(self.tools / "pr-lifecycle.jsonl", rows, expected_surface="pr_lifecycle")
        closed_at = datetime.fromisoformat(self.merged_at) + timedelta(minutes=25)
        events = findings_dir(self.repo) / "finding-events.jsonl"
        events.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            events,
            {
                "schema_version": 1, "event": "finding_status_changed",
                "event_id": f"finding:{self.finding_id}:status:RESOLVED:{_iso(closed_at)}",
                "finding_id": self.finding_id, "from_status": "IN_PROGRESS", "to_status": "RESOLVED",
                "reason": "closed by the merge", "actor": _CLOSER, "recorded_at": _iso(closed_at),
                "closes_in_commit": merge_sha,
            },
            expected_surface="repo_finding_events",
        )
        assessment = outcome_owner._compute_change_assessment(self._capture())
        reading = next(
            (row for row in assessment["readings"] if row["metric_id"] == _CLOSURE_METRIC), None,
        )
        self.assertIsNotNone(reading, f"{_CLOSURE_METRIC} is not among the assessment readings")
        self.assertEqual((reading["signal"], reading["reason"]), ("gain", _BY_THIS_MERGE))
        self.assertEqual(reading["observed"]["merge_sha"], merge_sha)
        self.assertEqual(assessment["verdict"], "gain_confirmed")

    def test_exact_retry_after_successor_returns_original_assessment_without_append(self) -> None:
        capture = self._capture()
        first = self._record(capture)
        self.assertEqual(first["verdict"], "unknown")
        self._observe()
        second = self._record(self._capture(), cycle_id="cycle-assessment-2")
        self.assertEqual(second["verdict"], "gain_confirmed")
        self.assertEqual(second["predecessor_assessment_id"], first["assessment_id"])
        self.assertNotEqual(second["assessment_id"], first["assessment_id"])
        before = self.outcome_path.read_bytes()
        governance = (self.tools / "governance.jsonl").read_bytes()
        replay = self._record(capture, cycle_id="cycle-assessment-retry")
        self.assertEqual(replay, first)
        self.assertEqual(replay["cycle_id"], "cycle-assessment-1")
        self.assertEqual(self.outcome_path.read_bytes(), before)
        self.assertEqual((self.tools / "governance.jsonl").read_bytes(), governance)

    def test_captured_observations_respect_inclusive_upper_event_time(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        self.cutoff = datetime.now(timezone.utc).replace(microsecond=0)
        after_cutoff = self.cutoff + timedelta(seconds=1)
        with patch("aria_kernel.experiment.utc_now", return_value=_iso(after_cutoff)):
            later = self._observe()
        self.assertEqual(later["recorded_at"], _iso(after_cutoff))
        capture = self._capture()
        before = outcome_owner._compute_change_assessment(capture)
        self.assertEqual(before["verdict"], "unknown")
        reading = next(row for row in before["readings"]
                       if row["metric_id"] == "experiment_rerun_hold")
        self.assertEqual(reading["observed"], {
            "post_merge_green_reruns": 0, "post_merge_other_reruns": 0,
        })
        descriptor = next(row for row in before["source_snapshots"]
                          if row["source_surface"] == "experiment_observations")
        self.assertEqual(descriptor["prefix"]["row_count"], 1)
        self.assertEqual(descriptor["prefix"]["tail_ledger_hash"], later["ledger_hash"])

        with patch("aria_kernel.experiment.utc_now", return_value=_iso(self.cutoff)):
            boundary = self._observe()
        self.assertEqual(boundary["recorded_at"], _iso(self.cutoff))
        self.assertNotEqual(boundary["validation_run_id"], later["validation_run_id"])
        self.assertEqual(outcome_owner._compute_change_assessment(capture), before)
        current = self._record(self._capture())
        self.assertEqual(current["verdict"], "gain_confirmed")
        reading = next(row for row in current["readings"]
                       if row["metric_id"] == "experiment_rerun_hold")
        self.assertEqual(reading["observed"], {
            "post_merge_green_reruns": 1, "post_merge_other_reruns": 0,
        })
        self.assertEqual(reading["evidence_refs"], [boundary["validation_run_id"]])
        self.assertNotIn(later["validation_run_id"], reading["evidence_refs"])
        observations = load_declared_jsonl(
            self.tools / "experiments/observations.jsonl",
            expected_surface="experiment_observations",
        )
        self.assertEqual(observations, [later, boundary])
        self.assertEqual(outcome_owner.find_change_outcome(self.tools, self.change_id), self.first)
        self.assertTrue(self.outcome_path.read_bytes().startswith(self.first_bytes))

    def test_hot_capture_and_append_validate_binding_before_transaction(self) -> None:
        from contextlib import contextmanager
        from aria_kernel import ledger as ledger_owner, state_store as store_owner

        real_transaction = ledger_owner.state_transaction
        real_git = store_owner._git
        active_transactions = 0
        phase = "capture"
        entered_phases = []
        commands = []

        @contextmanager
        def observed_transaction(*args, **kwargs):
            nonlocal active_transactions
            with real_transaction(*args, **kwargs) as transaction:
                active_transactions += 1
                entered_phases.append(phase)
                try:
                    yield transaction
                finally:
                    active_transactions -= 1

        def observed_git(*args, **kwargs):
            self.assertEqual(active_transactions, 0,
                             "binding Git observation must run outside evidence transactions")
            commands.append((phase, tuple(args[1:])))
            return real_git(*args, **kwargs)

        with patch.object(ledger_owner, "state_transaction", new=observed_transaction), \
                patch.object(store_owner, "_git", new=observed_git):
            capture = self._capture()
            phase = "append"
            row = self._record(capture)

        self.assertEqual(active_transactions, 0)
        self.assertEqual(set(entered_phases), {"capture", "append"})
        for expected_phase in ("capture", "append"):
            self.assertTrue(any(
                observed_phase == expected_phase
                and argv == ("rev-parse", "--path-format=absolute", "--git-common-dir")
                for observed_phase, argv in commands
            ), f"the real binding owner must run in {expected_phase}")
        self.assertEqual(row["event"], "change_assessment")
        self.assertEqual(row["verdict"], "unknown")
        self.assertEqual(row["original_outcome_ref"]["ledger_hash"], self.first["ledger_hash"])
        self.assertEqual(ledger_owner.load_declared_jsonl(
            self.outcome_path, expected_surface="change_outcome",
        ), [self.first, row])
        self.assertEqual(outcome_owner.find_change_outcome(self.tools, self.change_id), self.first)

    def test_distinct_stale_capture_requires_recapture_before_append(self) -> None:
        original_capture = self._capture()
        self._observe()
        stale_capture = self._capture()
        first = self._record(original_capture)
        before = self.outcome_path.read_bytes()
        with self.assertRaisesRegex(GovernanceError, "change_assessment_stale_predecessor"):
            self._record(stale_capture, cycle_id="cycle-assessment-stale")
        self.assertEqual(self.outcome_path.read_bytes(), before)
        successor = self._record(self._capture(), cycle_id="cycle-assessment-recaptured")
        self.assertEqual(successor["predecessor_assessment_id"], first["assessment_id"])
        self.assertEqual(successor["verdict"], "gain_confirmed")
        self.assertTrue(self.outcome_path.read_bytes().startswith(before))


class AssessmentAdverseAccountingTests(unittest.TestCase):
    def test_native_reproduction_assessment_preserves_nonzero_pressure_counters(self) -> None:
        from aria_kernel.auto_merge import record_pr_lifecycle
        from aria_kernel.experiment import register_experiment, register_recipe, run_experiment
        from aria_kernel.finding import emit_finding, record_finding_reproduction
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
        from aria_kernel.knowledge_graph import Pattern, record_convention, record_pressure_source_outcome
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding
        from aria_kernel.validation import run_validation_commands
        from aria_kernel.validation_runs_ledger import verify_validation_run

        scratch = tempfile.TemporaryDirectory(prefix="aria-assessment-adverse-")
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name)
        repo = root / "source"
        repo.mkdir()
        # This separate fixture uses the legacy pressure owner's actual root.
        # It does not change the external-root contracts above or repair that
        # owner's open workspace_root/aria-tools limitation.
        tools = repo / "aria-tools"
        repo_state = root / "repo-state"
        repo_state.mkdir()
        environment = patch.dict(os.environ, {
            "ARIA_TOOLS_DIR": str(tools), "ARIA_REPO_STATE_ROOT": str(repo_state),
        })
        environment.start()
        self.addCleanup(environment.stop)
        (repo / ".gitignore").write_text(
            "__pycache__/\naria-tools/\naria-debts/\n", encoding="utf-8",
        )
        (repo / "selection.py").write_text(
            "def selected_paths(paths):\n    return sorted(set(paths))\n", encoding="utf-8",
        )
        (repo / "test_selection.py").write_text(
            "import unittest\n"
            "from selection import selected_paths\n"
            "class SelectionTests(unittest.TestCase):\n"
            "    def test_sorted_unique_paths(self):\n"
            "        self.assertEqual(selected_paths(['src/b.py', 'src/a.py', 'src/b.py']), ['src/a.py', 'src/b.py'])\n"
            "        print('ASSESSMENT_SELECTION_BASELINE_OK')\n"
            "    def test_separator_equivalence(self):\n"
            "        print('ASSESSMENT_SEPARATOR_BEHAVIOR_REACHED')\n"
            "        self.assertEqual(selected_paths(['src\\\\a.py', 'src/a.py']), ['src/a.py'])\n",
            encoding="utf-8",
        )
        for args in (
            ["init", "-q"], ["config", "user.name", "ARIA fixture"],
            ["config", "user.email", "aria@example.invalid"],
            ["add", "."], ["commit", "-q", "-m", "selection behavior fixture"],
        ):
            subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
        commit_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True,
        ).stdout.strip()
        set_profile("standard", operator_approval_ref="fixture:S2-A-adverse", base_dir=tools)
        ensure_tools_binding(tools, workspace_root=repo)
        finding = emit_finding(
            repo_root=repo, base_dir=tools, claim_type="wrong_code", severity="MEDIUM",
            claim_summary="Path selection retains separator variants as distinct entries",
            evidences=[{"ref": "selection.py:2", "summary": "set compares the original path strings"}],
            facts=["selected_paths sorts a set of unchanged input strings without separator normalization"],
            scope_files=["selection.py", "test_selection.py"],
        )
        finding_id = finding["finding_id"]
        self.assertTrue(finding["source_ledger_hash"])
        command = "python3 -m unittest -v test_selection.SelectionTests.test_sorted_unique_paths"
        red_command = "python3 -m unittest -v test_selection.SelectionTests.test_separator_equivalence"
        scope = ["selection.py", "test_selection.py"]
        plan_id = "plan-assessment-adverse"
        planned = emit_change_planned(
            plan_id=plan_id, finding_id=finding_id, intended_affected_files=scope,
            intended_validation_refs=[command], architectural_tier=1, base_dir=tools,
        )
        change_id = planned["change_id"]
        emit_change_committed(
            change_id=change_id, commit_sha=commit_sha, actual_affected_files=scope, base_dir=tools,
        )
        validation = run_validation_commands(
            commands=[command], workspace_root=repo, change_id=change_id, commit_sha=commit_sha,
            runner_identity="ci-executor:assessment-adverse", change_author_identity="agent:assessment-planner",
            base_dir=tools,
        )
        self.assertEqual(validation["status"], "ok")
        self.assertEqual(len(validation["validation_run_ids"]), 1)
        green_run = verify_validation_run(validation["validation_run_ids"][0], base_dir=tools)
        self.assertEqual((green_run["cmd"], green_run["change_id"], green_run["commit_sha"]),
                         (command, change_id, commit_sha))
        self.assertEqual((green_run["status"], green_run["exit_code"], green_run["timed_out"]), ("ok", 0, False))
        green_log = Path(green_run["log_path"]).read_bytes()
        self.assertEqual(green_run["log_hash"], "sha256:" + hashlib.sha256(green_log).hexdigest())
        self.assertIn(b"Ran 1 test", green_log)
        self.assertIn(b"ASSESSMENT_SELECTION_BASELINE_OK", green_log)
        validated = emit_change_validated(
            change_id=change_id, validation_run_refs=[{
                "validation_run_id": green_run["validation_run_id"], "cmd": green_run["cmd"],
                "exit_code": green_run["exit_code"], "log_path": green_run["log_path"],
                "ran_at": green_run["completed_at"],
            }], base_dir=tools, workspace_root=repo,
        )
        self.assertTrue(validated["validation_matrix_passed"])
        merged_at = _iso(datetime.now(timezone.utc) - timedelta(days=4))
        # Native fixture observation and its clock; no live merge or review.
        with patch("aria_kernel.auto_merge.utc_now", return_value=merged_at):
            record_pr_lifecycle(
                {"number": 9902, "change_id": change_id, "head_sha": commit_sha, "changed_files": scope},
                event="opened", base_dir=tools,
            )
            from aria_kernel.merge_record import MERGED_BY_MERGE_LANE, record_merge

            record_merge(pr={"number": 9902, "head_sha": commit_sha}, merged_by=MERGED_BY_MERGE_LANE, base_dir=tools,
                         head_lineage="delivered")
        first = emit_change_outcome(change_id=change_id, repo_root=repo, base_dir=tools)
        self.assertEqual(first["verdict"], "unknown")
        outcome_path = tools / "change-ledger/outcome.jsonl"
        first_bytes = outcome_path.read_bytes()
        signer_cycle = "assessment-adverse-fixture"
        signer = mint_signing_key(cycle_id=signer_cycle, workspace_root=repo)
        self.addCleanup(revoke_signing_key, cycle_id=signer_cycle, workspace_root=repo)
        pattern_id = "convention-assessment-adverse"
        record_convention(
            Pattern(pattern_id=pattern_id, pattern_type="convention", confidence=0.5,
                    evidence_refs=("selection.py:2",), discovered_by_cycle_id="cycle-adverse-original",
                    observed_at=_iso(datetime.now(timezone.utc)), outcome_status="hypothesis", plan_id=plan_id),
            workspace_root=repo, base_dir=tools, signer_key_fp=signer.fingerprint,
        )
        register_recipe(recipe_id="recipe-assessment-separators", command=red_command,
                        timeout_ms=30_000, deterministic=True, base_dir=tools)
        register_experiment(
            experiment_id="experiment-assessment-separators",
            hypothesis="Separator-equivalence behavior still fails its named unittest",
            recipe_ref="recipe-assessment-separators", finding_ref=finding_id,
            observation_contract={"comparator": "exit_code_equals", "expected": 1}, base_dir=tools,
        )
        observation = run_experiment(
            experiment_id="experiment-assessment-separators", workspace_root=repo,
            change_id=change_id, commit_sha=commit_sha, runner_identity="ci-executor:assessment-adverse",
            change_author_identity="agent:assessment-planner", base_dir=tools,
        )
        red_run = verify_validation_run(observation["validation_run_id"], base_dir=tools)
        self.assertEqual((red_run["cmd"], red_run["change_id"], red_run["commit_sha"]),
                         (red_command, change_id, commit_sha))
        self.assertEqual((red_run["status"], red_run["exit_code"], red_run["timed_out"]), ("failed", 1, False))
        red_log = Path(red_run["log_path"]).read_bytes()
        self.assertEqual(red_run["log_hash"], "sha256:" + hashlib.sha256(red_log).hexdigest())
        for marker in (b"Ran 1 test", b"FAIL: test_separator_equivalence", b"FAILED (failures=1)",
                       b"AssertionError", b"ASSESSMENT_SEPARATOR_BEHAVIOR_REACHED"):
            self.assertIn(marker, red_log)
        self.assertTrue(observation["matched"])
        self.assertEqual(observation["run_status"], "failed")
        reproduction = record_finding_reproduction(
            repo, finding_id=finding_id, validation_run_id=red_run["validation_run_id"], base_dir=tools,
        )
        self.assertEqual(reproduction["event"], "finding_reproduced")
        self.assertEqual(reproduction["finding_id"], finding_id)
        self.assertEqual(reproduction["validation_run_id"], red_run["validation_run_id"])
        self.assertEqual(reproduction["observation_ledger_hash"], observation["ledger_hash"])
        self.assertEqual(reproduction["target_sha"], commit_sha)
        finding_rows = load_declared_jsonl(
            findings_dir(repo) / "finding-events.jsonl", expected_surface="repo_finding_events",
        )
        self.assertEqual([item["event"] for item in finding_rows], ["finding_emitted", "finding_reproduced"])
        self.assertEqual(finding_rows[-1], reproduction)
        record_pressure_source_outcome(
            base_dir=tools, source_type="orphan_finding", minted=9, converged=5, merged=3, rejected=2,
            cost_usd=1.25,
        )
        counters = rank_pressure_sources(base_dir=tools)
        self.assertEqual(len(counters), 1)
        expected_counts = {"cycles_minted": 9, "cycles_converged": 5, "cycles_merged": 3, "cycles_rejected": 2}
        self.assertEqual({key: counters[0][key] for key in expected_counts}, expected_counts)
        self.assertEqual(counters[0]["source_type"], "orphan_finding")
        counter_path = tools / "knowledge-graph/pressure-source-effectiveness.jsonl"
        counter_bytes = counter_path.read_bytes()
        governance_path = tools / "governance.jsonl"
        governance_bytes = governance_path.read_bytes()
        capture = outcome_owner._capture_assessment_inputs(
            change_id=change_id, pattern_id=pattern_id, repo_root=repo, base_dir=tools,
            now=datetime.now(timezone.utc) + timedelta(days=1),
        )
        with patch.object(outcome_owner, "_record_aggregate", wraps=outcome_owner._record_aggregate) as aggregate:
            assessment = outcome_owner._record_change_assessment(capture, cycle_id="cycle-assessment-adverse", base_dir=tools)
        aggregate.assert_not_called()
        self.assertEqual(assessment["verdict"], "no_gain")
        reading = next(item for item in assessment["readings"] if item["metric_id"] == "finding_recurrence")
        self.assertEqual(reading["signal"], "no_gain")
        self.assertEqual(reading["observed"], {"regression_events": 0, "reproduced_events": 1, "fix_verified_events": 0})
        self.assertEqual(reading["evidence_refs"], [reproduction["event_id"]])
        self.assertEqual(assessment["original_outcome_ref"]["ledger_hash"], first["ledger_hash"])
        self.assertEqual(assessment["availability"]["durability"], {
            "status": "unavailable", "reason": "retained_prefix_unavailable",
        })
        self.assertTrue(all(item["retained_prefix_ref"] is None for item in assessment["source_snapshots"]))
        self.assertEqual(outcome_owner.find_change_outcome(tools, change_id), first)
        self.assertEqual(list_change_outcomes(base_dir=tools), [first])
        self.assertTrue(outcome_path.read_bytes().startswith(first_bytes))
        self.assertEqual(load_declared_jsonl(outcome_path, expected_surface="change_outcome"), [first, assessment])
        self.assertEqual(counter_path.read_bytes(), counter_bytes)
        self.assertEqual(rank_pressure_sources(base_dir=tools), counters)
        self.assertEqual(governance_path.read_bytes(), governance_bytes)


if __name__ == "__main__":
    unittest.main()
