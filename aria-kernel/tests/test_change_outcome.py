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
                 "changed_files": self.scope_paths}, event="pr_open", base_dir=self.tools,
            )
            merge_row = record_pr_lifecycle(
                {"number": 9901, "head_sha": self.commit_sha},
                event="merged", base_dir=self.tools,
            )
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
                event="pr_open", base_dir=tools,
            )
            record_pr_lifecycle({"number": 9902, "head_sha": commit_sha}, event="merged", base_dir=tools)
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
