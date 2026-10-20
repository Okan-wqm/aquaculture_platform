"""ARIA-HIGH-125 — ARIA measures its own precision and recall before it promotes itself.

The gold corpus is built the way production builds it: an operator labels
findings (``record_operator_feedback``, source ``human``), ``propose_goldset``
turns the labels into a ready proposal and a named curator promotes it
(``promote_goldset_proposal``). The adapter's runs and raw findings go through
``record_run``; the replay's ground-truth seed and the judges' replay verdicts
are the rows ``judge_replay`` and the judgment bridge append. Nothing is
mocked between those ledgers and ``role_fitness``; the autonomous lanes are
then driven through their own entry points (``record_pending_promotion``,
``compute_auto_promote_token``, the panel sweep, the genesis superiority
proof), with only the operator's policy switch and readiness verdict stood in.
"""
from __future__ import annotations

import base64
import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel.calibration_dials import GOLDSET_REPLAY_JUDGE_ID
from aria_kernel.feedback_store import finding_fingerprint, record_operator_feedback
from aria_kernel.fitness import generate_fitness_report, list_fitness_reports
from aria_kernel.goldset import load_active_goldset, promote_goldset_proposal, propose_goldset
from aria_kernel.role_fitness import (
    MEASURED,
    UNMEASURED_NO_GOLDSET,
    adapter_fitness_blocker,
    goldset_hash,
    measure_role_fitness,
)
from aria_kernel.tool_health import record_run
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, register_tool

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"
TOOL_ID = "fit-adapter"
JUDGE = "aria-evidence-judge"
SUBJECT = "apps/farm-service/src/pond.ts"


def _finding(index: int) -> dict[str, Any]:
    return {
        "id": f"F-{index}", "rule": "rule-a", "path": SUBJECT, "line": index, "message": f"finding {index}",
        "evidence": [{"path": SUBJECT, "line": index}],
    }


def _adapter(tool_id: str = TOOL_ID, *, precision_min: float = 0.85) -> dict[str, Any]:
    output = {"observations": [], "findings": [], "read_paths": [SUBJECT], "evidence_sources": [SUBJECT]}
    encoded = base64.b64encode(json.dumps(output).encode("utf-8")).decode("ascii")
    return {
        "tool_id": tool_id, "kind": "adapter", "version": "1.0.0", "status": "SHADOW",
        "declared_scope": ["apps/farm-service/src/**/*.ts"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": f"fixtures/{tool_id}", "health_thresholds": {"precision_min": precision_min},
        "allowed_read_globs": ["apps/farm-service/src/**/*.ts"], "forbidden_read_globs": [],
        "claim_types": ["wrong_code"], "owner": "platform",
        "runner": {"type": "subprocess", "argv": ["python3", FAKE_RUNNER.as_posix(), "--output-b64", encoded],
                   "cwd": ".", "timeout_ms": 1000, "stdin_json": True},
        "schema_version": 1,
    }


def _run(run_id: str, findings: list[dict[str, Any]], tool_id: str = TOOL_ID) -> dict[str, Any]:
    return {
        "run_id": run_id, "tool_id": tool_id, "cycle_id": f"cycle-{run_id}", "status": "ok",
        "input_hash": "sha256:input", "output_hash": "sha256:output", "read_paths": [SUBJECT],
        "emitted_observations": [], "emitted_findings": [],
        "evidence_validation": {"valid": True, "evidence_sources": [SUBJECT]}, "operator_feedback_refs": [],
        "duration_ms": 10, "cost_units": 1, "schema_version": 1,
        "runner": {"raw_findings_count": len(findings), "raw_findings_sample": findings[:3]},
        "raw_findings": findings,
    }


class _GoldStore:
    """A tools root with one adapter, its gold corpus and its replay."""

    def __init__(self, root: Path, *, precision_min: float = 0.85) -> None:
        self.tools = ensure_tools_dir(root / "tools")
        register_tool(_adapter(precision_min=precision_min), base_dir=self.tools)

    def label_and_promote_gold(self) -> dict[str, Any]:
        """F-1..F-4 true positives, F-5..F-6 known false positives, by the
        operator; a named curator promotes the ready proposal."""
        record_run(_run("run-0", [_finding(index) for index in range(1, 7)]), base_dir=self.tools)
        for index in range(1, 7):
            record_operator_feedback(
                tool_id=TOOL_ID, run_id="run-0", finding_id=f"F-{index}",
                verdict="true_positive" if index <= 4 else "false_positive", severity="high",
                note="operator label", source_type="human",
                finding_fingerprint=finding_fingerprint(TOOL_ID, _finding(index)), base_dir=self.tools,
            )
        proposal = propose_goldset(
            tool_id=TOOL_ID, target_true_positives=4, target_known_false_positives=2, base_dir=self.tools,
        )
        assert proposal is not None and proposal["status"] == "ready", proposal
        return promote_goldset_proposal(tool_id=TOOL_ID, curator="Okan-wqm", base_dir=self.tools)

    def emit(self, run_id: str, indexes: tuple[int, ...]) -> None:
        record_run(_run(run_id, [_finding(index) for index in indexes]), base_dir=self.tools)

    def replay(self, answers: dict[int, str]) -> None:
        """The replay's ground-truth seed per gold item and the judge's
        replay verdict on it (``judge_replay`` + the judgment bridge)."""
        for index, answer in answers.items():
            group = f"replay:{TOOL_ID}:run-0:F-{index}"
            truth = "true_positive" if index <= 4 else "false_positive"
            record_operator_feedback(
                tool_id=TOOL_ID, run_id="run-0", finding_id=f"F-{index}", verdict=truth, severity="high",
                note="goldset_replay_ground_truth", source_type="human", judge_id=GOLDSET_REPLAY_JUDGE_ID,
                judgment_group_id=group, base_dir=self.tools,
            )
            record_operator_feedback(
                tool_id=TOOL_ID, run_id="run-0", finding_id=f"F-{index}", verdict=answer, severity="high",
                note="replay verdict", source_type="ai_judge", judge_id=JUDGE, confidence=0.9,
                judgment_group_id=group, base_dir=self.tools,
            )


class _Case(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-h125-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


class RoleFitnessIsMeasuredAgainstTheGoldCorpus(_Case):
    def test_the_adapter_and_its_judges_are_scored_against_gold_they_did_not_write(self) -> None:
        store = _GoldStore(self.tmp)
        gold = store.label_and_promote_gold()
        # The version in force (the latest ok run) emits three gold true
        # positives, one known false positive and one unlabelled finding.
        store.emit("run-1", (1, 2, 3, 5, 7))
        store.replay({1: "true_positive", 2: "true_positive", 3: "false_positive", 5: "true_positive",
                      6: "false_positive"})

        fitness = measure_role_fitness(base_dir=store.tools)
        adapter = fitness["adapters"][TOOL_ID]
        self.assertEqual(adapter["status"], MEASURED)
        self.assertEqual(adapter["goldset_hash"], goldset_hash(gold))
        self.assertEqual(adapter["run_id"], "run-1")
        self.assertEqual((adapter["emitted"], adapter["emitted_labelled"], adapter["emitted_true_positives"]), (5, 4, 3))
        self.assertEqual((adapter["precision"], adapter["recall"]), (0.75, 0.75))

        judges = fitness["judges"][TOOL_ID]
        self.assertEqual((judges["status"], judges["goldset_hash"]), (MEASURED, goldset_hash(gold)))
        (judge,) = judges["judges"]
        # Truth TP on 1,2,3 (answered TP, TP, FP) and FP on 5,6 (TP, FP):
        # tp=2, fn=1, fp=1 -> precision 2/3, recall 2/3.
        self.assertEqual((judge["judge_id"], judge["samples"]), (JUDGE, 5))
        self.assertEqual((judge["precision"], judge["recall"]), (0.667, 0.667))
        self.assertIsNotNone(judge["ece"])

    def test_without_a_promoted_goldset_nothing_is_scored(self) -> None:
        store = _GoldStore(self.tmp)
        store.emit("run-1", (1, 2))
        fitness = measure_role_fitness(base_dir=store.tools)
        self.assertEqual(fitness["adapters"][TOOL_ID]["status"], UNMEASURED_NO_GOLDSET)
        self.assertNotIn("precision", fitness["adapters"][TOOL_ID])
        self.assertEqual(fitness["judges"][TOOL_ID], {"status": UNMEASURED_NO_GOLDSET, "judges": []})

    def test_the_nightly_fitness_report_records_the_measurement(self) -> None:
        store = _GoldStore(self.tmp)
        gold = store.label_and_promote_gold()
        store.emit("run-1", (1, 2, 3, 4))
        report = generate_fitness_report(cycle_id="cycle-h125", base_dir=store.tools)
        row = report["role_fitness"]["adapters"][TOOL_ID]
        self.assertEqual((row["status"], row["precision"], row["recall"]), (MEASURED, 1.0, 1.0))
        self.assertEqual(row["goldset_hash"], goldset_hash(gold))
        self.assertEqual(list_fitness_reports(base_dir=store.tools)[-1]["role_fitness"], report["role_fitness"])


class AutonomousPromotionReadsTheMeasurement(_Case):
    def _measured(self, *, precision_min: float, emitted: tuple[int, ...]) -> _GoldStore:
        store = _GoldStore(self.tmp, precision_min=precision_min)
        store.label_and_promote_gold()
        store.emit("run-1", emitted)
        generate_fitness_report(cycle_id="cycle-h125", base_dir=store.tools)
        return store

    def test_the_blocker_names_unmeasured_stale_and_below_threshold(self) -> None:
        store = _GoldStore(self.tmp)
        self.assertEqual(adapter_fitness_blocker(TOOL_ID, base_dir=store.tools), "fitness_unmeasured:no_fitness_report")
        generate_fitness_report(cycle_id="cycle-unmeasured", base_dir=store.tools)
        self.assertEqual(
            adapter_fitness_blocker(TOOL_ID, base_dir=store.tools), f"fitness_unmeasured:{UNMEASURED_NO_GOLDSET}",
        )

        store.label_and_promote_gold()
        store.emit("run-1", (1, 2, 3, 5))  # precision 0.75 against a 0.85 floor
        generate_fitness_report(cycle_id="cycle-measured", base_dir=store.tools)
        self.assertEqual(
            adapter_fitness_blocker(TOOL_ID, base_dir=store.tools), "fitness_below_threshold:precision=0.75<0.85",
        )
        later = datetime.now(timezone.utc) + timedelta(days=30)
        self.assertEqual(adapter_fitness_blocker(TOOL_ID, base_dir=store.tools, now=later), "fitness_stale")

    def test_a_measured_adapter_at_its_floor_passes_and_a_changed_goldset_is_stale(self) -> None:
        store = self._measured(precision_min=0.7, emitted=(1, 2, 3, 5))
        self.assertIsNone(adapter_fitness_blocker(TOOL_ID, base_dir=store.tools))
        # A new curator act replaces the corpus the report measured.
        gold = load_active_goldset(tool_id=TOOL_ID, base_dir=store.tools)
        promote_goldset_proposal(
            tool_id=TOOL_ID, curator="Okan-wqm", base_dir=store.tools,
            proposal={**gold, "status": "ready", "recorded_at": "2026-10-18T00:00:00Z",
                      "true_positive_items": gold["true_positive_items"][:3]},
        )
        self.assertEqual(adapter_fitness_blocker(TOOL_ID, base_dir=store.tools), "fitness_stale")

    def test_the_panel_lane_refuses_to_arm_an_unmeasured_adapter(self) -> None:
        from aria_kernel.promotion_veto import pending_promotion, record_pending_promotion
        from tests.test_jj2_humanless_promotion import _panel_resolved_record

        store = _GoldStore(self.tmp)
        ref = _panel_resolved_record(store.tools, TOOL_ID, "promote-h125")
        with self.assertRaisesRegex(GovernanceError, "panel_promotion_fitness_unmeasured"):
            record_pending_promotion(
                tool_id=TOOL_ID, panel_approval_ref=ref, reason="panel approved",
                readiness={"blocked_by": [], "precision": 1.0}, base_dir=store.tools,
            )
        self.assertIsNone(pending_promotion(tool_id=TOOL_ID, base_dir=store.tools))

    def test_the_panel_lane_arms_a_measured_adapter_and_settle_re_reads_it(self) -> None:
        from aria_kernel.promotion_veto import record_pending_promotion, settle_pending_promotions
        from tests.test_jj2_humanless_promotion import _panel_resolved_record

        store = self._measured(precision_min=0.7, emitted=(1, 2, 3, 5))
        ref = _panel_resolved_record(store.tools, TOOL_ID, "promote-h125")
        with mock.patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            armed = record_pending_promotion(
                tool_id=TOOL_ID, panel_approval_ref=ref, reason="panel approved",
                readiness={"blocked_by": [], "precision": 1.0}, base_dir=store.tools,
            )
            self.assertTrue(armed["armed"])
            # The adapter regresses before the window elapses: its newest
            # measurement no longer clears the floor, and nothing activates.
            store.emit("run-2", (1, 5, 6))
            generate_fitness_report(cycle_id="cycle-regressed", base_dir=store.tools)
            with mock.patch("aria_kernel.readiness.adapter_active_readiness", return_value={
                "active_ready": True, "zero_finding_lane": False, "precision": 1.0,
                "critical_false_positives": 0, "blocked_by": [],
            }):
                settled = settle_pending_promotions(cycle_id="cycle-settle", base_dir=store.tools)
        self.assertEqual(settled["activated"], [])
        self.assertIn("panel_promotion_fitness_below_threshold", settled["refused"][0]["reason"])

    def test_the_auto_promote_token_is_not_minted_without_a_measurement(self) -> None:
        from aria_kernel.adapter_calibration import AutoPromoteIneligibleError, compute_auto_promote_token

        store = _GoldStore(self.tmp)
        enabled = {"enabled": True, "profiles": ["autonomous"], "min_clean_cycles": 1, "min_precision": 0.9}
        clean = [{"precision": 1.0, "critical_false_positives": 0, "recorded_at": "2026-10-18T00:00:00Z"}]
        with mock.patch("aria_kernel.genesis_policy.auto_promote_policy", return_value=enabled), \
             mock.patch("aria_kernel.adapter_calibration._precision_history", return_value=clean):
            with self.assertRaisesRegex(AutoPromoteIneligibleError, "auto_promote_fitness_unmeasured"):
                compute_auto_promote_token(tool_id=TOOL_ID, base_dir=store.tools, profile="autonomous")

    def test_the_panel_is_not_asked_about_an_unmeasured_adapter(self) -> None:
        from aria_kernel.promotion_panel import sweep_promotable_adapters_for_adjudication

        store = _GoldStore(self.tmp)
        ready = {"active_ready": True, "precision": 1.0, "anchor_judged_count": 3, "blocked_by": []}
        with mock.patch("aria_kernel.readiness.adapter_active_readiness", return_value=ready):
            swept = sweep_promotable_adapters_for_adjudication(base_dir=store.tools, cycle_id="cycle-sweep")
        self.assertEqual(swept["opened"], [])
        self.assertEqual(swept["skipped"], [{"tool_id": TOOL_ID, "reason": "fitness_unmeasured:no_fitness_report"}])

    def test_a_judge_measured_below_its_floor_is_not_promoted_by_genesis(self) -> None:
        from aria_kernel.genesis_superiority import compute_eval_window_superiority

        store = _GoldStore(self.tmp)
        store.label_and_promote_gold()
        store.emit("run-1", (1, 2, 3, 4))
        # The judge calls every gold item a true positive: precision 4/6.
        store.replay({index: "true_positive" for index in range(1, 7)})
        generate_fitness_report(cycle_id="cycle-judge", base_dir=store.tools)
        improved = {"verdict": "improved"}
        with mock.patch("aria_kernel.genesis_superiority.compare_eval_windows", return_value=improved):
            proof = compute_eval_window_superiority(entity_id=JUDGE, base_dir=store.tools)
            unmeasured = compute_eval_window_superiority(entity_id="aria-primary-planner", base_dir=store.tools)
        self.assertFalse(proof["passed"])
        self.assertIn("judge_fitness_below_threshold", proof["reasons"][0])
        self.assertEqual(proof["fitness"]["status"], "measured")
        self.assertEqual([row["tool_id"] for row in proof["fitness"]["rows"]], [TOOL_ID])
        # An agent the gold corpus does not measure is said to be so; the
        # window decides it, as the duel ledger's absence does.
        self.assertTrue(unmeasured["passed"], unmeasured["reasons"])
        self.assertEqual(unmeasured["fitness"], {"status": "unmeasured", "rows": []})


class TheTrainingSetIsExportedSigned(_Case):
    """Post-chain plan row 6: the gold corpus and the judges' replay
    verdicts on it leave the kernel signed and named by the corpus."""

    def test_the_export_holds_the_corpus_and_every_replay_answer_under_the_kernel_signature(self) -> None:
        from aria_kernel.training_set import export_training_set, list_training_sets, verify_training_set_row

        store = _GoldStore(self.tmp)
        self.assertIsNone(export_training_set(tool_id=TOOL_ID, cycle_id="c0", base_dir=store.tools))
        gold = store.label_and_promote_gold()
        store.replay({1: "true_positive", 5: "true_positive"})

        row = export_training_set(tool_id=TOOL_ID, cycle_id="c1", base_dir=store.tools)
        self.assertEqual((row["goldset_hash"], row["curator"]), (goldset_hash(gold), "Okan-wqm"))
        self.assertEqual((row["example_count"], row["judged_examples"]), (6, 2))
        by_finding = {example["finding_id"]: example for example in row["examples"]}
        self.assertEqual(by_finding["F-5"]["verdict"], "false_positive")
        self.assertEqual(
            [(answer["judge_id"], answer["verdict"]) for answer in by_finding["F-5"]["judge_verdicts"]],
            [(JUDGE, "true_positive")],
        )
        (stored,) = list_training_sets(base_dir=store.tools)
        self.assertTrue(verify_training_set_row(stored, base_dir=store.tools))
        tampered = {**stored, "examples": [{**stored["examples"][4], "verdict": "true_positive"}, *stored["examples"][1:]]}
        self.assertFalse(verify_training_set_row(tampered, base_dir=store.tools))
        self.assertFalse(verify_training_set_row({**stored, "signer_kid": "no-such-key"}, base_dir=store.tools))

        # Unchanged content is not exported twice; a new answer is.
        self.assertIsNone(export_training_set(tool_id=TOOL_ID, cycle_id="c2", base_dir=store.tools))
        store.replay({2: "false_positive"})
        self.assertEqual(export_training_set(tool_id=TOOL_ID, cycle_id="c3", base_dir=store.tools)["judged_examples"], 3)
        self.assertEqual(len(list_training_sets(base_dir=store.tools)), 2)

    def test_the_nightly_cycle_exports_after_the_fitness_report(self) -> None:
        from aria_kernel import cycle as cycle_mod

        names = [phase.name for phase in cycle_mod.CYCLE_PHASES]
        self.assertLess(names.index("judge_replay"), names.index("fitness_report"))
        self.assertEqual(names.index("training_set_export"), names.index("fitness_report") + 1)
        phase = next(p for p in cycle_mod.CYCLE_PHASES if p.name == "training_set_export")
        self.assertEqual((phase.precondition, phase.on_error), (cycle_mod.WRITES_PERMITTED, "record_and_continue"))

        store = _GoldStore(self.tmp)
        store.label_and_promote_gold()
        context = mock.Mock(cycle_id="cycle-night", base_dir=store.tools)
        self.assertEqual(phase.runner(context)["exported"], [TOOL_ID])


if __name__ == "__main__":
    unittest.main()
