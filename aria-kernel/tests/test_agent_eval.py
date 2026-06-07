"""Plan 020 Phase 6 — agent eval harness tests.

What this suite pins (≥12 tests):
- Fixture schema validation (9 required fields, verdict_class enum, regex
  on fixture_id, list shape on expected_evidence_refs).
- add_fixture idempotent on identical content; rejects content drift.
- run_agent_eval mock_mode=True writes runs.jsonl + emits
  agent_eval_run_mock_only governance event.
- mock_mode=False without real_response_envelope raises GovernanceError.
- mock_mode=False with envelope writes runs.jsonl + emits
  agent_eval_run_real governance event.
- Pass criteria: verdict_class match + evidence_refs SUPERSET.
- aggregate_eval_metrics 6-key shape (pass_rate / mean_rounds /
  mean_tokens / FP / FN / consistency).
- aggregate window_days filters out stale runs.
- count_eval_runs_by_mode segregates streams.
- Plan 016 metrics include the 2 new counters; total expected = 11.
- Frozen profile blocks add_fixture + run_agent_eval (agent_evals
  surface).
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_eval import (
    EVAL_RUN_SCHEMA,
    REQUIRED_FIXTURE_FIELDS,
    VERDICT_CLASSES,
    add_fixture,
    aggregate_eval_metrics,
    count_eval_runs_by_mode,
    list_eval_runs,
    list_fixtures,
    run_agent_eval,
)
from aria_kernel.plan_016_metrics import compute_plan_016_metrics
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding


def _seed() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-eval-"))
    tools = tmp / "aria-tools"
    ensure_tools_binding(tools, workspace_root=tmp)
    return tools


def _sample_fixture(fid: str = "F999_TEST", verdict: str = "ACCEPTED",
                    evidence: tuple[str, ...] = ("docs/x.md:1",)) -> dict:
    return {
        "fixture_id": fid,
        "target_agent": "aria-evidence-judge",
        "role": "evidence_judgment",
        "pinned_commit_sha": "deadbeefcafe1234",
        "input_envelope": {"claim_summary": "test"},
        "expected_verdict_class": verdict,
        "expected_evidence_refs": list(evidence),
        "max_rounds": 3,
        "max_tokens": 8000,
    }


class FixtureValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_required_fields_locked(self) -> None:
        self.assertEqual(set(REQUIRED_FIXTURE_FIELDS), {
            "fixture_id", "target_agent", "role", "pinned_commit_sha",
            "input_envelope", "expected_verdict_class",
            "expected_evidence_refs", "max_rounds", "max_tokens",
        })

    def test_verdict_classes_locked(self) -> None:
        for cls in ("ACCEPTED", "REJECTED", "ESCALATE_HUMAN",
                    "WITHDRAWN_AS_FALSE_POSITIVE", "TIGHTENED",
                    "JUDGMENT_DISAGREEMENT", "PASS", "FAIL"):
            self.assertIn(cls, VERDICT_CLASSES, msg=cls)

    def test_missing_required_field_rejected(self) -> None:
        bad = _sample_fixture()
        del bad["max_rounds"]
        with self.assertRaises(GovernanceError) as cm:
            add_fixture(fixture=bad, base_dir=self.tools)
        self.assertIn("missing required fields", str(cm.exception))

    def test_invalid_verdict_class_rejected(self) -> None:
        bad = _sample_fixture(verdict="WRONG")
        with self.assertRaises(GovernanceError) as cm:
            add_fixture(fixture=bad, base_dir=self.tools)
        self.assertIn("expected_verdict_class", str(cm.exception))

    def test_invalid_fixture_id_rejected(self) -> None:
        bad = _sample_fixture(fid="lower-case-not-allowed")
        with self.assertRaises(GovernanceError):
            add_fixture(fixture=bad, base_dir=self.tools)


class AddFixtureIdempotenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_identical_re_add_returns_existing(self) -> None:
        fixture = _sample_fixture()
        first = add_fixture(fixture=fixture, base_dir=self.tools)
        second = add_fixture(fixture=fixture, base_dir=self.tools)
        self.assertEqual(first["fixture_hash"], second["fixture_hash"])

    def test_content_drift_rejected(self) -> None:
        add_fixture(fixture=_sample_fixture(), base_dir=self.tools)
        drifted = _sample_fixture(verdict="REJECTED")  # same id, different content
        with self.assertRaises(GovernanceError) as cm:
            add_fixture(fixture=drifted, base_dir=self.tools)
        self.assertIn("different content hash", str(cm.exception))

    def test_list_fixtures_returns_added(self) -> None:
        add_fixture(fixture=_sample_fixture("F1_A"), base_dir=self.tools)
        add_fixture(fixture=_sample_fixture("F2_B"), base_dir=self.tools)
        rows = list_fixtures(base_dir=self.tools)
        self.assertEqual({r["fixture_id"] for r in rows}, {"F1_A", "F2_B"})


class RunAgentEvalMockModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()
        add_fixture(fixture=_sample_fixture(), base_dir=self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_mock_run_passes_against_matching_fixture(self) -> None:
        run = run_agent_eval(
            fixture_id="F999_TEST", base_dir=self.tools, mock_mode=True,
        )
        self.assertTrue(run["passed"])
        self.assertTrue(run["mock_mode"])
        self.assertEqual(run["$schema"], EVAL_RUN_SCHEMA)

    def test_mock_run_emits_mock_only_governance_event(self) -> None:
        run_agent_eval(fixture_id="F999_TEST", base_dir=self.tools, mock_mode=True)
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("agent_eval_run_mock_only", kinds)
        self.assertNotIn("agent_eval_run_real", kinds)

    def test_run_persists_to_runs_jsonl(self) -> None:
        run_agent_eval(fixture_id="F999_TEST", base_dir=self.tools, mock_mode=True)
        runs_path = self.tools / "agent-evals" / "runs.jsonl"
        self.assertTrue(runs_path.exists())
        rows = [json.loads(line) for line in runs_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(rows), 1)


class RunAgentEvalRealModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()
        add_fixture(fixture=_sample_fixture(), base_dir=self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_real_mode_without_envelope_raises(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            run_agent_eval(
                fixture_id="F999_TEST", base_dir=self.tools, mock_mode=False, allow_legacy_envelope_feed=True, operator_approval_ref="test:plan-023-a8-legacy",
            )
        self.assertIn("real_response_envelope", str(cm.exception))

    def test_real_mode_with_matching_envelope_passes(self) -> None:
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["docs/x.md:1"],
            "rounds_used": 2, "tokens_used": 1500,
        }
        run = run_agent_eval(
            fixture_id="F999_TEST", base_dir=self.tools, mock_mode=False, allow_legacy_envelope_feed=True, operator_approval_ref="test:plan-023-a8-legacy",
            real_response_envelope=envelope,
        )
        self.assertTrue(run["passed"])
        self.assertFalse(run["mock_mode"])

    def test_real_mode_emits_real_governance_event(self) -> None:
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["docs/x.md:1"],
            "rounds_used": 1, "tokens_used": 500,
        }
        run_agent_eval(
            fixture_id="F999_TEST", base_dir=self.tools, mock_mode=False, allow_legacy_envelope_feed=True, operator_approval_ref="test:plan-023-a8-legacy",
            real_response_envelope=envelope,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("agent_eval_run_real", kinds)


class PassCriteriaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()
        add_fixture(fixture=_sample_fixture(evidence=("a.md:1", "b.md:2")), base_dir=self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_verdict_mismatch_fails(self) -> None:
        envelope = {
            "verdict_class": "REJECTED",  # fixture expects ACCEPTED
            "evidence_refs": ["a.md:1", "b.md:2"],
            "rounds_used": 1, "tokens_used": 100,
        }
        run = run_agent_eval(
            fixture_id="F999_TEST", base_dir=self.tools, mock_mode=False, allow_legacy_envelope_feed=True, operator_approval_ref="test:plan-023-a8-legacy",
            real_response_envelope=envelope,
        )
        self.assertFalse(run["passed"])
        self.assertFalse(run["verdict_match"])

    def test_evidence_subset_required(self) -> None:
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["a.md:1"],  # missing b.md:2
            "rounds_used": 1, "tokens_used": 100,
        }
        run = run_agent_eval(
            fixture_id="F999_TEST", base_dir=self.tools, mock_mode=False, allow_legacy_envelope_feed=True, operator_approval_ref="test:plan-023-a8-legacy",
            real_response_envelope=envelope,
        )
        self.assertFalse(run["passed"])
        self.assertFalse(run["evidence_match"])
        self.assertEqual(run["missing_evidence_refs"], ["b.md:2"])


class AggregateMetricsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()
        add_fixture(fixture=_sample_fixture("F1"), base_dir=self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_aggregate_returns_six_key_shape(self) -> None:
        for _ in range(3):
            run_agent_eval(fixture_id="F1", base_dir=self.tools, mock_mode=True)
        agg = aggregate_eval_metrics(
            target_agent="aria-evidence-judge",
            base_dir=self.tools, window_days=30, mock_mode=True,
        )
        for key in ("pass_rate", "mean_rounds", "mean_tokens",
                    "false_positive_rate", "false_negative_rate",
                    "consistency_score"):
            self.assertIn(key, agg)
        self.assertEqual(agg["run_count"], 3)
        self.assertEqual(agg["pass_count"], 3)
        self.assertEqual(agg["pass_rate"], 1.0)

    def test_empty_window_returns_zero_runs(self) -> None:
        agg = aggregate_eval_metrics(
            target_agent="aria-evidence-judge",
            base_dir=self.tools, window_days=30,
        )
        self.assertEqual(agg["run_count"], 0)
        self.assertEqual(agg["consistency_score"], 1.0)


class ModeSegregationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()
        add_fixture(fixture=_sample_fixture("F1"), base_dir=self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_count_runs_by_mode(self) -> None:
        for _ in range(2):
            run_agent_eval(fixture_id="F1", base_dir=self.tools, mock_mode=True)
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["docs/x.md:1"],
            "rounds_used": 1, "tokens_used": 100,
        }
        run_agent_eval(
            fixture_id="F1", base_dir=self.tools, mock_mode=False,
            real_response_envelope=envelope,
            allow_legacy_envelope_feed=True,
            operator_approval_ref="test:plan-023-a8-legacy",
        )
        counts = count_eval_runs_by_mode(base_dir=self.tools)
        self.assertEqual(counts["aria_agent_eval_mock_only_total"], 2)
        self.assertEqual(counts["aria_agent_eval_real_total"], 1)


class Plan016MetricsExtensionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_metrics_include_eval_counters(self) -> None:
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertIn("aria_agent_eval_mock_only_total", metrics)
        self.assertIn("aria_agent_eval_real_total", metrics)
        # Plan 016 baseline 9 + Plan 020 Phase 6 (+2) + Phase 9 (+1) +
        # Phase 13 (+1) = 13 — Plan 020 final counter set.
        self.assertEqual(len(metrics), 13)


class FrozenProfileBlocksEvalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_add_fixture(self) -> None:
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            add_fixture(fixture=_sample_fixture(), base_dir=self.tools)
        self.assertIn("agent_evals", str(cm.exception))
        self.assertIn("frozen", str(cm.exception))

    def test_frozen_blocks_run(self) -> None:
        # First add fixture under standard, then freeze.
        add_fixture(fixture=_sample_fixture(), base_dir=self.tools)
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            run_agent_eval(fixture_id="F999_TEST", base_dir=self.tools)


if __name__ == "__main__":
    unittest.main()
