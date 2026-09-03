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
import hashlib
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
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.ledger_refs import ledger_ref_for_row
from aria_kernel.plan_016_metrics import compute_plan_016_metrics
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-eval-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
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


def _bind_real_invocation(
    tools: Path,
    *,
    invocation_id: str = "claim-real-1",
    request_id: str = "AIR-real-1",
    transcript_hash: str = "sha256:" + "a" * 64,
    target_agent: str = "aria-evidence-judge",
    fixture_id: str = "F999_TEST",
    transcript_artifact_ref: str | None = None,
) -> tuple[str, str, dict]:
    request = append_declared_jsonl(
        tools / "agent-invocations" / "requests.jsonl",
        {
            "schema_version": 1,
            "row_id": request_id,
            "row_type": "request",
            "request_id": request_id,
            "target_agent": target_agent,
        },
        expected_surface="agent_invocation_requests",
    )
    context = append_declared_jsonl(
        tools / "agent-invocations" / "contexts.jsonl",
        {
            "schema_version": 1,
            "row_id": f"context:{request_id}",
            "row_type": "context",
            "request_id": request_id,
            "target_agent": target_agent,
            "context_hash": "sha256:" + "b" * 64,
        },
        expected_surface="agent_invocation_contexts",
    )
    prompt = append_declared_jsonl(
        tools / "agent-invocations" / "prompts.jsonl",
        {
            "schema_version": 1,
            "row_id": f"prompt:{request_id}",
            "row_type": "prompt",
            "request_id": request_id,
            "context_hash": context["context_hash"],
            "prompt_hash": "sha256:" + "c" * 64,
            "prompt_text": "test",
        },
        expected_surface="agent_invocation_prompts",
    )
    claim = append_declared_jsonl(
        tools / "agent-invocations" / "claims.jsonl",
        {
            "schema_version": 1,
            "row_id": invocation_id,
            "row_type": "claim",
            "event": "claimed",
            "claim_id": invocation_id,
            "invocation_id": invocation_id,
            "request_id": request_id,
        },
        expected_surface="agent_invocation_claims",
    )
    result = append_declared_jsonl(
        tools / "agent-invocations" / "results.jsonl",
        {
            "schema_version": 1,
            "row_id": f"result-{invocation_id}",
            "row_type": "result",
            "claim_id": invocation_id,
            "invocation_id": invocation_id,
            "request_id": request_id,
            "status": "accepted",
            "transcript_hash": transcript_hash,
        },
        expected_surface="agent_invocation_results",
    )
    transcript = append_declared_jsonl(
        tools / "agent-invocations" / "transcripts.jsonl",
        {
            "schema_version": 1,
            "row_id": f"transcript-{invocation_id}",
            "row_type": "transcript",
            "invocation_id": invocation_id,
            "claim_id": invocation_id,
            "request_id": request_id,
            "target_agent": target_agent,
            "transcript_hash": transcript_hash,
            "fixture_run_id": fixture_id,
            "artifact_ref": transcript_artifact_ref if transcript_artifact_ref is not None else transcript_hash,
        },
        expected_surface="agent_invocation_transcripts",
    )
    operator = append_declared_jsonl(
        tools / "operator-provenance" / "events.jsonl",
        {
            "schema_version": 1,
            "row_id": f"approval-{invocation_id}",
            "row_type": "operator_approval",
            "operator_provenance_ref": f"operator:{invocation_id}",
            "operator": "test-operator",
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        },
        expected_surface="operator_provenance",
    )
    refs = {
        "request_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_requests",
            ledger_path="agent-invocations/requests.jsonl",
            row_id=request_id,
            row_type="request",
            row=request,
        ),
        "claim_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_claims",
            ledger_path="agent-invocations/claims.jsonl",
            row_id=invocation_id,
            row_type="claim",
            row=claim,
        ),
        "context_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_contexts",
            ledger_path="agent-invocations/contexts.jsonl",
            row_id=f"context:{request_id}",
            row_type="context",
            row=context,
        ),
        "prompt_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_prompts",
            ledger_path="agent-invocations/prompts.jsonl",
            row_id=f"prompt:{request_id}",
            row_type="prompt",
            row=prompt,
        ),
        "result_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_results",
            ledger_path="agent-invocations/results.jsonl",
            row_id=f"result-{invocation_id}",
            row_type="result",
            row=result,
        ),
        "fixture_ledger_ref": _fixture_ref(tools, fixture_id),
        "transcript_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_transcripts",
            ledger_path="agent-invocations/transcripts.jsonl",
            row_id=f"transcript-{invocation_id}",
            row_type="transcript",
            row=transcript,
        ),
        "operator_approval_ledger_ref": ledger_ref_for_row(
            surface="operator_provenance",
            ledger_path="operator-provenance/events.jsonl",
            row_id=f"approval-{invocation_id}",
            row_type="operator_approval",
            row=operator,
        ),
    }
    return invocation_id, transcript_hash, refs


def _fixture_ref(tools: Path, fixture_id: str) -> dict:
    rows = load_declared_jsonl(
        tools / "agent-evals" / "fixtures.jsonl",
        expected_surface="agent_eval_fixtures",
    )
    row = next(item for item in rows if item.get("fixture_id") == fixture_id)
    return ledger_ref_for_row(
        surface="agent_eval_fixtures",
        ledger_path="agent-evals/fixtures.jsonl",
        row_id=fixture_id,
        row_type="fixture",
        row=row,
    )


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

    def test_loose_fixture_json_is_not_authority(self) -> None:
        fixtures_dir = self.tools / "agent-evals" / "fixtures"
        fixtures_dir.mkdir(parents=True, exist_ok=True)
        (fixtures_dir / "F1_A.json").write_text(
            json.dumps(_sample_fixture("F1_A"), sort_keys=True),
            encoding="utf-8",
        )
        self.assertEqual(list_fixtures(base_dir=self.tools), [])
        with self.assertRaisesRegex(GovernanceError, "ledger row not found"):
            run_agent_eval(fixture_id="F1_A", base_dir=self.tools, mock_mode=True)


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
        invocation_id, transcript_hash, refs = _bind_real_invocation(self.tools)
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["docs/x.md:1"],
            "rounds_used": 2, "tokens_used": 1500,
        }
        run = run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=False,
            real_response_envelope=envelope,
            invocation_id=invocation_id,
            transcript_hash=transcript_hash,
            **refs,
        )
        self.assertTrue(run["passed"])
        self.assertFalse(run["mock_mode"])

    def test_real_mode_emits_real_governance_event(self) -> None:
        invocation_id, transcript_hash, refs = _bind_real_invocation(self.tools)
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["docs/x.md:1"],
            "rounds_used": 1, "tokens_used": 500,
        }
        run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=False,
            real_response_envelope=envelope,
            invocation_id=invocation_id,
            transcript_hash=transcript_hash,
            **refs,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("agent_eval_run_real", kinds)

    def test_real_mode_rejects_unbound_provenance(self) -> None:
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["docs/x.md:1"],
            "rounds_used": 1,
            "tokens_used": 500,
        }
        with self.assertRaisesRegex(GovernanceError, "real_eval_missing_provenance_refs"):
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope=envelope,
                invocation_id="claim-real-1",
                transcript_hash="sha256:" + "a" * 64,
            )

    def test_real_mode_accepts_claim_result_transcript_binding(self) -> None:
        transcript_hash = "sha256:" + "a" * 64
        invocation_id, transcript_hash, refs = _bind_real_invocation(
            self.tools,
            transcript_hash=transcript_hash,
        )
        run = run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=False,
            real_response_envelope={
                "verdict_class": "ACCEPTED",
                "evidence_refs": ["docs/x.md:1"],
                "rounds_used": 1,
                "tokens_used": 500,
            },
            invocation_id=invocation_id,
            transcript_hash=transcript_hash,
            **refs,
        )
        self.assertEqual(run["provenance_mode"], "real_invocation")

    def test_real_mode_rejects_missing_transcript_artifact_path(self) -> None:
        invocation_id, transcript_hash, refs = _bind_real_invocation(
            self.tools,
            transcript_artifact_ref="missing-transcript.txt",
        )
        with self.assertRaisesRegex(GovernanceError, "transcript_artifact_path_missing"):
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope={
                    "verdict_class": "ACCEPTED",
                    "evidence_refs": ["docs/x.md:1"],
                    "rounds_used": 1,
                    "tokens_used": 500,
                },
                invocation_id=invocation_id,
                transcript_hash=transcript_hash,
                **refs,
            )


class PassCriteriaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()
        add_fixture(fixture=_sample_fixture(evidence=("a.md:1", "b.md:2")), base_dir=self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_verdict_mismatch_fails(self) -> None:
        invocation_id, transcript_hash, refs = _bind_real_invocation(self.tools)
        envelope = {
            "verdict_class": "REJECTED",  # fixture expects ACCEPTED
            "evidence_refs": ["a.md:1", "b.md:2"],
            "rounds_used": 1, "tokens_used": 100,
        }
        run = run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=False,
            real_response_envelope=envelope,
            invocation_id=invocation_id,
            transcript_hash=transcript_hash,
            **refs,
        )
        self.assertFalse(run["passed"])
        self.assertFalse(run["verdict_match"])

    def test_evidence_subset_required(self) -> None:
        invocation_id, transcript_hash, refs = _bind_real_invocation(self.tools)
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["a.md:1"],  # missing b.md:2
            "rounds_used": 1, "tokens_used": 100,
        }
        run = run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=False,
            real_response_envelope=envelope,
            invocation_id=invocation_id,
            transcript_hash=transcript_hash,
            **refs,
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
        invocation_id, transcript_hash, refs = _bind_real_invocation(
            self.tools,
            fixture_id="F1",
        )
        envelope = {
            "verdict_class": "ACCEPTED",
            "evidence_refs": ["docs/x.md:1"],
            "rounds_used": 1, "tokens_used": 100,
        }
        run_agent_eval(
            fixture_id="F1", base_dir=self.tools, mock_mode=False,
            real_response_envelope=envelope,
            invocation_id=invocation_id,
            transcript_hash=transcript_hash,
            **refs,
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
