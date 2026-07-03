"""Credit/refusal fallback — BEHAVIORAL proof + executor wiring pins.

The fable→opus fallback policy is extracted into
``claude_runtime.run_with_model_fallback`` so it is unit-testable WITHOUT a
full lease/dispatch environment. These tests drive it with a scripted fake
``run`` and assert the actual control flow: fable + credit → one opus@xhigh
retry, fable + refusal → one opus@original-effort retry, a signal on the opus
result escalates (single-retry budget), opus-primary never falls back, a
clean run passes through. The two executors are pinned (source) to route
through the helper so the behaviour can never be re-inlined and drift.

Detection (extract_credit_exhaustion) is unit-tested separately in
test_claude_runtime_contract.CreditExhaustionDetectionTests.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

from claude_runtime import ClaudeRunResult, run_with_model_fallback  # noqa: E402

_CI = (_POC / "ci_executor.py").read_text(encoding="utf-8")
_WORKER = (_POC / "worker_executor.py").read_text(encoding="utf-8")


def _result(*, credit=None, refusal=None, tag="") -> ClaudeRunResult:
    return ClaudeRunResult(
        returncode=0 if credit is None else 1,
        stdout=tag,
        stderr="",
        final_message=tag,
        usage={} if credit is None else None,
        events=(),
        refusal=refusal,
        credit_exhaustion=credit,
    )


class _ScriptedRun:
    """Returns the i-th scripted result on the i-th call, recording (model, effort)."""

    def __init__(self, *results: ClaudeRunResult) -> None:
        self._results = list(results)
        self.calls: list[tuple[str, str]] = []

    def __call__(self, model: str, effort: str) -> ClaudeRunResult:
        self.calls.append((model, effort))
        return self._results[len(self.calls) - 1]


class RunWithModelFallbackBehavior(unittest.TestCase):
    def test_fable_credit_exhaustion_retries_on_opus_xhigh(self) -> None:
        credit = {"matched_marker": "credit balance", "returncode": 1}
        run = _ScriptedRun(_result(credit=credit, tag="fable"), _result(tag="opus"))
        seen: list[dict] = []
        out = run_with_model_fallback(
            run=run, model="fable", effort="high", on_credit=seen.append,
        )
        self.assertEqual(run.calls, [("fable", "high"), ("opus", "xhigh")])
        self.assertEqual(out.final_message, "opus")
        self.assertEqual(seen, [credit])  # hook fired exactly once with the marker

    def test_fable_refusal_retries_on_opus_at_original_effort(self) -> None:
        refusal = {"category": "cyber"}
        run = _ScriptedRun(_result(refusal=refusal, tag="fable"), _result(tag="opus"))
        seen_r: list[dict] = []
        seen_c: list[dict] = []
        out = run_with_model_fallback(
            run=run, model="fable", effort="xhigh",
            on_credit=seen_c.append, on_refusal=seen_r.append,
        )
        self.assertEqual(run.calls, [("fable", "xhigh"), ("opus", "xhigh")])
        self.assertEqual(out.final_message, "opus")
        self.assertEqual(seen_r, [refusal])
        self.assertEqual(seen_c, [])

    def test_single_retry_budget_credit_then_opus_refuses_does_not_re_retry(self) -> None:
        # fable credit-fails → opus retry → opus REFUSES: must NOT retry a
        # third time; return the opus result so the caller escalates.
        run = _ScriptedRun(
            _result(credit={"matched_marker": "quota exceeded"}, tag="fable"),
            _result(refusal={"category": "cyber"}, tag="opus-refused"),
        )
        seen_r: list[dict] = []
        out = run_with_model_fallback(
            run=run, model="fable", effort="high", on_refusal=seen_r.append,
        )
        self.assertEqual(len(run.calls), 2)  # exactly one retry, never a third call
        self.assertEqual(out.final_message, "opus-refused")
        self.assertEqual(seen_r, [])  # refusal hook never fired (credit path returned first)

    def test_opus_primary_never_falls_back(self) -> None:
        run = _ScriptedRun(_result(credit={"matched_marker": "credit balance"}, tag="opus"))
        seen: list[dict] = []
        out = run_with_model_fallback(
            run=run, model="opus", effort="medium", on_credit=seen.append,
        )
        self.assertEqual(run.calls, [("opus", "medium")])  # one call, no fallback
        self.assertEqual(out.final_message, "opus")
        self.assertEqual(seen, [])

    def test_clean_fable_run_passes_through(self) -> None:
        run = _ScriptedRun(_result(tag="fable-clean"))
        out = run_with_model_fallback(run=run, model="fable", effort="high")
        self.assertEqual(run.calls, [("fable", "high")])
        self.assertEqual(out.final_message, "fable-clean")

    def test_credit_takes_precedence_over_refusal(self) -> None:
        # A result carrying BOTH signals resolves to the credit path (opus@xhigh).
        run = _ScriptedRun(
            _result(credit={"matched_marker": "billing"}, refusal={"category": "x"}, tag="fable"),
            _result(tag="opus"),
        )
        seen_c: list[dict] = []
        seen_r: list[dict] = []
        run_with_model_fallback(
            run=run, model="fable", effort="high",
            on_credit=seen_c.append, on_refusal=seen_r.append,
        )
        self.assertEqual(run.calls[1], ("opus", "xhigh"))
        self.assertEqual(len(seen_c), 1)
        self.assertEqual(seen_r, [])


class ExecutorWiringPins(unittest.TestCase):
    """Both executors MUST route through the helper (no re-inlined drift)."""

    def test_ci_executor_uses_helper_with_both_hooks(self) -> None:
        self.assertIn("run_with_model_fallback(", _CI)
        self.assertIn("on_credit=_on_credit", _CI)
        self.assertIn("on_refusal=_on_refusal", _CI)
        self.assertIn('"model_credit_fallback_attempted"', _CI)

    def test_worker_executor_uses_helper_with_both_hooks(self) -> None:
        self.assertIn("run_with_model_fallback(", _WORKER)
        self.assertIn("on_credit=_on_credit", _WORKER)
        self.assertIn("model_credit_fallback assignment=", _WORKER)

    def test_xhigh_and_single_retry_live_in_the_helper_ssot(self) -> None:
        # The "ultra" effort + single-retry semantics are owned by the helper,
        # not duplicated in the executors.
        helper_src = (_POC / "claude_runtime.py").read_text(encoding="utf-8")
        self.assertIn('return run("opus", "xhigh")', helper_src)
        self.assertIn('return run("opus", effort)', helper_src)
        self.assertNotIn("_fell_back_to_opus", _CI)
        self.assertNotIn("_fell_back_to_opus", _WORKER)


if __name__ == "__main__":
    unittest.main()
