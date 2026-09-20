"""Typed-judgment plan Phase 2 — the envelope carries a typed verdict, the
route stamps the confidence source, every judge role is gated.

One property per test:

* a typed verdict block (``primitive: choice``, ``value``, ``evidence:
  [{index, quote}]``) validates and folds: the row's verdict is the value,
  its confidence the top-label probability, its refs the request's own
  strings materialized from the indices, ``evidence_selection: index``;
* a typed quote outside the request's pinned excerpt is refused before
  submit (``judge_verdict.typed:evidence_quote_mismatch``) and in the fold;
* a legacy block folds as before with ``confidence_source: self_reported``
  and ``evidence_selection: ref``;
* ``provider_reported`` stands only when the route stamped it AND the
  stamped model's provider is confidence-native; a spelling the model wrote
  inside its verdict block is never read;
* the executor's envelope builder stamps ``agent_confidence_source``
  unconditionally and removes an agent-written dispatch-model stamp when
  the route names no model (ORPHAN-HIGH-781's absent case stays absent);
* ``run_with_model_fallback`` returns the model that answered — the primary
  or the cross-vendor rung (ARIA-MEDIUM-171);
* the executor's pre-submit gate covers the arbiter (ARIA-MEDIUM-166);
* ``record_operator_feedback`` refuses a confidence source outside the
  vocabulary and one that names a confidence the row does not carry.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.feedback_store import (
    CONFIDENCE_SOURCES,
    EVIDENCE_SELECTIONS,
    load_feedback,
    record_operator_feedback,
)
from aria_kernel.judgment_bridge import (
    record_judge_verdict_from_response,
    stamped_confidence_source,
    typed_verdict_block,
    validate_judge_response,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402
import claude_runtime as cr  # noqa: E402

_EXCERPT = {
    "path": "apps/auth/src/mfa.resolver.ts", "start_line": 120, "end_line": 130,
    "content_hash": "sha256:feedface", "content": "  @Public()\n  async setupMfa(@Args() input: SetupMfaInput) {\n",
}


def _request() -> dict:
    return {
        "request_id": "AIR-judge-1", "tool_id": "tool-a", "run_id": "run-1", "finding_id": "F-1",
        "judgment_group_id": "judge:tool-a:fp1", "finding_fingerprint": "fp1",
        "evidence_refs": ["apps/auth/src/mfa.resolver.ts:128", "docs/adr/046.md"],
        "evidence_excerpts": [_EXCERPT],
        "suggested_prompt": "Judge whether this finding is a true_positive or false_positive.",
    }


def _typed_block(**overrides) -> dict:
    block = {
        "primitive": "choice", "value": "false_positive",
        "probabilities": {"true_positive": 0.2, "false_positive": 0.8}, "confidence": 0.8,
        "evidence": [{"index": 0, "quote": "@Public()"}],
        "rationale": "The endpoint is public by declaration and rate limited two lines below.",
    }
    block.update(overrides)
    return block


def _response(verdict_block: dict, *, details: dict | None = None) -> dict:
    merged = {"agent_subagent_type": "aria-adversarial-judge", "agent_dispatch_model": "glm-5.3",
              "agent_confidence_source": "self_reported", "verdict": verdict_block}
    merged.update(details or {})
    return {"role": "adversarial_judgment", "details": merged}


class ATypedVerdictValidatesAndFolds(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = ensure_tools_dir(Path(tempfile.mkdtemp(prefix="aria-typed-bridge-")) / "aria-tools")

    def test_the_typed_block_is_recognised_and_the_legacy_block_is_not(self) -> None:
        self.assertIsNotNone(typed_verdict_block(_typed_block()))
        self.assertIsNone(typed_verdict_block({"verdict": "true_positive"}))

    def test_a_typed_verdict_validates(self) -> None:
        self.assertEqual(validate_judge_response(request=_request(), response=_response(_typed_block())), [])

    def test_a_typed_verdict_folds_to_a_row_with_materialized_refs(self) -> None:
        row = record_judge_verdict_from_response(request=_request(), response=_response(_typed_block()), base_dir=self.tools)
        self.assertEqual((row["verdict"], row["confidence"]), ("false_positive", 0.8))
        self.assertEqual(row["evidence_refs"], ["apps/auth/src/mfa.resolver.ts:128"])
        self.assertEqual((row["confidence_source"], row["evidence_selection"]), ("self_reported", "index"))
        self.assertEqual((row["judge_id"], row["model"]), ("aria-adversarial-judge", "glm-5.3"))
        stored = load_feedback(base_dir=self.tools)
        self.assertEqual(stored[-1]["evidence_selection"], "index")

    def test_a_quote_outside_the_pinned_excerpt_is_refused_before_submit_and_in_the_fold(self) -> None:
        response = _response(_typed_block(evidence=[{"index": 0, "quote": "rateLimit()"}]))
        self.assertIn("judge_verdict.typed:evidence_quote_mismatch",
                      validate_judge_response(request=_request(), response=response))
        with self.assertRaisesRegex(GovernanceError, "evidence_quote_mismatch"):
            record_judge_verdict_from_response(request=_request(), response=response, base_dir=self.tools)

    def test_a_typed_value_outside_the_verdict_vocabulary_is_refused_by_name(self) -> None:
        response = _response(_typed_block(value="maybe", probabilities=None))
        self.assertIn("judge_verdict.typed:value_not_in_options",
                      validate_judge_response(request=_request(), response=response))

    def test_a_typed_primitive_other_than_choice_is_refused_for_a_binary_judge(self) -> None:
        response = _response(_typed_block(primitive="noul", value=0.7))
        errors = validate_judge_response(request=_request(), response=response)
        self.assertTrue(any(e.startswith("judge_verdict.typed:primitive_mismatch") for e in errors), errors)

    def test_a_legacy_verdict_folds_as_before_with_the_default_source(self) -> None:
        legacy = {"verdict": "true_positive", "confidence": 0.9, "rationale": "seen at mfa.resolver.ts:128",
                  "evidence_refs": ["apps/auth/src/mfa.resolver.ts:128"]}
        row = record_judge_verdict_from_response(
            request=_request(), response=_response(legacy, details={"agent_confidence_source": None}), base_dir=self.tools)
        self.assertEqual((row["verdict"], row["confidence_source"], row["evidence_selection"]),
                         ("true_positive", "self_reported", "ref"))

    def test_a_legacy_row_without_confidence_carries_no_source(self) -> None:
        legacy = {"verdict": "true_positive", "rationale": "seen at mfa.resolver.ts:128"}
        row = record_judge_verdict_from_response(request=_request(), response=_response(legacy), base_dir=self.tools)
        self.assertIsNone(row["confidence"])
        self.assertIsNone(row["confidence_source"])


class TheRouteStampsTheConfidenceSource(unittest.TestCase):
    def test_an_envelope_sealed_before_the_stamp_is_self_reported(self) -> None:
        self.assertEqual(stamped_confidence_source({}), ("self_reported", None))

    def test_a_spelling_outside_the_vocabulary_is_refused(self) -> None:
        source, error = stamped_confidence_source({"agent_confidence_source": "vendor_said_so"})
        self.assertEqual(source, "self_reported")
        self.assertEqual(error, "judge_verdict.confidence_source:invalid:'vendor_said_so'")

    def test_provider_reported_needs_a_confidence_native_provider(self) -> None:
        details = {"agent_confidence_source": "provider_reported", "agent_dispatch_model": "glm-5.3"}
        self.assertEqual(stamped_confidence_source(details), ("self_reported", "judge_verdict.confidence_source:unstamped"))
        response = _response(_typed_block(), details=details)
        self.assertIn("judge_verdict.confidence_source:unstamped",
                      validate_judge_response(request=_request(), response=response))
        with patch("aria_kernel.judgment_bridge.provider_reports_confidence", return_value=True):
            self.assertEqual(stamped_confidence_source(details), ("provider_reported", None))
            self.assertEqual(validate_judge_response(request=_request(), response=response), [])

    def test_a_source_the_model_wrote_inside_its_verdict_is_never_read(self) -> None:
        tools = ensure_tools_dir(Path(tempfile.mkdtemp(prefix="aria-typed-bridge-")) / "aria-tools")
        block = _typed_block(confidence_source="provider_reported")
        row = record_judge_verdict_from_response(request=_request(), response=_response(block), base_dir=tools)
        self.assertEqual(row["confidence_source"], "self_reported")


class TheExecutorStampsWhatTheRouteKnows(unittest.TestCase):
    _AGENT = json.dumps({"status": "submitted", "details": {"agent_dispatch_model": "glm-5.3",
                                                            "verdict": {"verdict": "true_positive"}}})

    def _build(self, **kwargs) -> dict:
        return ci_executor._build_envelope_from_claude_output(
            raw_stdout=self._AGENT, request_id="req-1", claim_id="claim-1", agent_id="ci-executor:gha-1",
            role="evidence_judgment", subagent_type="aria-evidence-judge", must_satisfy=[], **kwargs)

    def test_the_confidence_source_is_stamped_self_reported_by_default(self) -> None:
        self.assertEqual(self._build(dispatch_model="opus")["details"]["agent_confidence_source"], "self_reported")
        self.assertEqual(self._build(dispatch_model="opus", confidence_source="provider_reported")["details"]["agent_confidence_source"],
                         "provider_reported")

    def test_a_named_model_overwrites_the_agents_spelling(self) -> None:
        self.assertEqual(self._build(dispatch_model="opus")["details"]["agent_dispatch_model"], "opus")

    def test_a_route_that_named_nothing_removes_the_agents_spelling(self) -> None:
        # ORPHAN-HIGH-781 pinned "no stale stamp" when the executor holds no
        # model; the agent's own `agent_dispatch_model` must not survive it.
        self.assertNotIn("agent_dispatch_model", self._build(dispatch_model=None)["details"])

    def test_the_pre_submit_gate_covers_the_arbiter(self) -> None:
        envelope = {"request_id": "AIR-arb-1", "details": {"agent_subagent_type": "aria-consensus-arbiter"}}
        errors = ci_executor._pre_submit_validate_envelope(
            envelope, "consensus_arbitration",
            request={"tool_id": "tool-a", "run_id": "run-1", "finding_id": "F-1", "judgment_group_id": "g"})
        self.assertEqual(errors, ["judge_verdict:absent"])


class TheResultNamesTheModelThatAnswered(unittest.TestCase):
    def _result(self, **kwargs) -> cr.ClaudeRunResult:
        base = {"returncode": 0, "stdout": "", "stderr": "", "final_message": "", "usage": None, "events": ()}
        base.update(kwargs)
        return cr.ClaudeRunResult(**base)

    def test_the_primary_rung_is_named(self) -> None:
        result = cr.run_with_model_fallback(run=lambda model, effort: self._result(), model="opus", effort="high",
                                            write_capable=False)
        self.assertEqual(result.model, "opus")

    def test_the_cross_vendor_rung_is_named_after_an_auth_failover(self) -> None:
        calls: list[str] = []

        def run(model: str, effort: str) -> cr.ClaudeRunResult:
            calls.append(model)
            if model == "opus":
                return self._result(auth_failure={"marker": "logged_out", "remedy": "login"})
            return self._result()

        result = cr.run_with_model_fallback(run=run, model="opus", effort="high", write_capable=False)
        self.assertEqual(calls, ["opus", "glm-5.3"])
        self.assertEqual(result.model, "glm-5.3")

    def test_a_runtime_that_named_its_own_model_keeps_it(self) -> None:
        result = cr.run_with_model_fallback(run=lambda model, effort: self._result(model="glm-5.3"),
                                            model="opus", effort="high", write_capable=False)
        self.assertEqual(result.model, "glm-5.3")


class TheFeedbackRowVocabularies(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = ensure_tools_dir(Path(tempfile.mkdtemp(prefix="aria-typed-bridge-")) / "aria-tools")

    def _record(self, **kwargs) -> dict:
        base = dict(tool_id="tool-a", run_id="run-1", finding_id="F-1", verdict="true_positive", severity="medium",
                    note="n", source_type="ai_judge", judge_id="aria-evidence-judge", model="opus", base_dir=self.tools)
        base.update(kwargs)
        return record_operator_feedback(**base)

    def test_the_vocabularies_are_closed(self) -> None:
        self.assertEqual(CONFIDENCE_SOURCES, ("self_reported", "provider_reported"))
        self.assertEqual(EVIDENCE_SELECTIONS, ("ref", "index"))
        with self.assertRaisesRegex(GovernanceError, "unknown confidence_source"):
            self._record(confidence=0.9, confidence_source="vendor_said_so")
        with self.assertRaisesRegex(GovernanceError, "unknown evidence_selection"):
            self._record(evidence_selection="path")

    def test_a_source_needs_a_confidence(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "names a confidence the row does not carry"):
            self._record(confidence=None, confidence_source="self_reported")

    def test_the_fields_are_additive_and_signed(self) -> None:
        from aria_kernel.operator_feedback_signature import verify_operator_feedback_row
        row = self._record(confidence=0.9, confidence_source="self_reported", evidence_selection="index")
        self.assertEqual((row["confidence_source"], row["evidence_selection"]), ("self_reported", "index"))
        stored = [json.loads(line) for line in (self.tools / "operator-feedback.jsonl").read_text().splitlines() if line.strip()]
        self.assertTrue(verify_operator_feedback_row(stored[-1], base_dir=self.tools).valid)


if __name__ == "__main__":
    unittest.main()
