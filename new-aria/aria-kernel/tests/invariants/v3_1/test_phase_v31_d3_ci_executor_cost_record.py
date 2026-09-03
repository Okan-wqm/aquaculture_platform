"""Plan ARIA-V3.1-D3 — ci_executor per-LLM-call cost attribution
invariants.

Closes the V3.1-D2 follow-up architectural seam: after the V3.1-D2
sentinel + factory wires landed, the actual per-LLM-call
record_cost_attribution invocation site was tracked as
F-015-V31-D3 OPEN. V3.1-D3 closes the loop by wiring
`_record_claude_cli_usage` into `invoke_claude_cli` after a
successful Codex CLI subprocess, gated on the V3.1-D2 frozen
mock-mode sentinel.

Invariants:

* I-V31-D3-01 — `_record_claude_cli_usage` helper exists in
  ci_executor + parses wrapper for `usage.input_tokens`,
  `usage.output_tokens`, `record_cost_attribution`, `model`.
* I-V31-D3-02 — invoke_claude_cli signature accepts request_envelope
  + tools_dir optional kwargs (V8 backward-compat preserved with
  None defaults).
* I-V31-D3-03 — invoke_claude_cli main() callsite passes both
  kwargs (real-path wire).
* I-V31-D3-04 — record gate uses `_MOCK_MODE_AT_ENTRY is False`
  (NOT `_is_mock_mode()` direct read; the frozen sentinel is the
  V3.1-D2 anchor for ai-safety HIGH-007).
* I-V31-D3-05 — `_record_claude_cli_usage` reads `signer_key_fp`
  from `ARIA_CYCLE_SIGNER_KEY_FP` env var with `SHA256:no-key`
  sentinel default (V3.1-D-1 schema compliance).
* I-V31-D3-06 — behavioral: JSONL without usage block → no
  record_cost_attribution call (silent skip; preserves V8 callers
  whose Codex CLI version emits no usage).
* I-V31-D3-07 — behavioral: well-formed Codex JSONL triggers
  record_cost_attribution with the threaded cycle_id +
  pressure_source_type.
"""
from __future__ import annotations

import importlib
import inspect
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def _load_ci_executor():
    """Import the tools/aria-poc/ci_executor module (not on the
    standard PYTHONPATH; resolves via repo-relative sys.path push)."""
    repo = Path(__file__).resolve().parents[4]
    tools_dir = repo / "tools" / "aria-poc"
    if str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))
    return importlib.import_module("ci_executor")


class CiExecutorCostRecorderTests(unittest.TestCase):
    """Plan ARIA-V3.1-D3 — _record_claude_cli_usage helper + signature."""

    def test_i_v31_d3_01_record_helper_exists_with_correct_signature(self) -> None:
        ci_executor = _load_ci_executor()
        self.assertTrue(
            hasattr(ci_executor, "_record_claude_cli_usage"),
            "ci_executor missing _record_claude_cli_usage helper",
        )
        sig = inspect.signature(ci_executor._record_claude_cli_usage)
        for kw in (
            "raw_stdout", "request_envelope", "tools_dir", "role",
            "request_id",
        ):
            self.assertIn(kw, sig.parameters,
                          f"helper missing required kwarg {kw!r}")

    def test_i_v31_d3_01_helper_parses_canonical_wrapper_fields(self) -> None:
        """Plan ARIA-V3.1-D3-01 — source-substring assertion: the
        helper reads `usage.input_tokens`, `usage.output_tokens`,
        `record_cost_attribution`, `model` from the Codex CLI wrapper."""
        ci_executor = _load_ci_executor()
        src = inspect.getsource(ci_executor._record_claude_cli_usage)
        for token in (
            "input_tokens", "output_tokens",
            "record_cost_attribution", "model",
        ):
            self.assertIn(token, src,
                          f"_record_claude_cli_usage missing {token!r} field")
        # Threads cycle_id + pressure_source_type from request_envelope.
        self.assertIn("cycle_id", src)
        self.assertIn("pressure_source_type", src)


class InvokeClaudeCodeSignatureTests(unittest.TestCase):
    """Plan ARIA-V3.1-D3-02 + 03 — invoke_claude_cli signature +
    main() callsite passes the new kwargs."""

    def test_i_v31_d3_02_signature_accepts_optional_kwargs(self) -> None:
        ci_executor = _load_ci_executor()
        sig = inspect.signature(ci_executor.invoke_claude_cli)
        for kw in ("request_envelope", "tools_dir"):
            self.assertIn(kw, sig.parameters,
                          f"invoke_claude_cli missing {kw!r} kwarg")
            # Default None preserves V8 backward-compat.
            self.assertIs(sig.parameters[kw].default, None)

    def test_i_v31_d3_03_main_callsite_threads_request_envelope_and_tools_dir(self) -> None:
        ci_executor = _load_ci_executor()
        main_src = inspect.getsource(ci_executor.main)
        self.assertIn("request_envelope=request_envelope", main_src,
                      "main() does not thread request_envelope to invoke_claude_cli")
        self.assertIn("tools_dir=tools_dir", main_src,
                      "main() does not thread tools_dir to invoke_claude_cli")


class FrozenSentinelGateTests(unittest.TestCase):
    """Plan ARIA-V3.1-D3-04 — record gate uses frozen sentinel."""

    def test_i_v31_d3_04_gate_uses_mock_mode_at_entry(self) -> None:
        """Plan ARIA-V3.1-D3-04 — invoke_claude_cli source contains
        the frozen-sentinel gate `_MOCK_MODE_AT_ENTRY is False` (NOT
        a direct `_is_mock_mode()` call). Closes ai-safety HIGH-007
        race window between mint + record."""
        ci_executor = _load_ci_executor()
        src = inspect.getsource(ci_executor.invoke_claude_cli)
        self.assertIn("_MOCK_MODE_AT_ENTRY is False", src,
                      "invoke_claude_cli does not gate on the V3.1-D2 "
                      "frozen sentinel — race window open")
        # Sanity: the V3.1-D2 sentinel + main() capture remain in place.
        self.assertTrue(hasattr(ci_executor, "_MOCK_MODE_AT_ENTRY"))


class SignerKeyFpEnvTests(unittest.TestCase):
    """Plan ARIA-V3.1-D3-05 — signer_key_fp env var threading."""

    def test_i_v31_d3_05_signer_key_fp_from_env(self) -> None:
        ci_executor = _load_ci_executor()
        src = inspect.getsource(ci_executor._record_claude_cli_usage)
        self.assertIn("ARIA_CYCLE_SIGNER_KEY_FP", src,
                      "_record_claude_cli_usage missing signer_key_fp env read")
        # Sentinel default for non-autonomous cycles.
        self.assertIn("SHA256:no-key", src)


class CostRecordBehavioralTests(unittest.TestCase):
    """Plan ARIA-V3.1-D3-06 + 07 — wrapper parse behavior."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31d3-")).resolve()
        self.base = self.tmp / "aria-tools"
        # Snapshot env so test mutations don't leak.
        self._saved_signer = os.environ.get("ARIA_CYCLE_SIGNER_KEY_FP")

    def tearDown(self) -> None:
        if self._saved_signer is None:
            os.environ.pop("ARIA_CYCLE_SIGNER_KEY_FP", None)
        else:
            os.environ["ARIA_CYCLE_SIGNER_KEY_FP"] = self._saved_signer
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_i_v31_d3_06_wrapper_without_usage_skips_record(self) -> None:
        """Plan ARIA-V3.1-D3-06 — wrapper missing the `usage` nested
        block (legacy Codex CLI versions OR malformed output) does
        NOT call record_cost_attribution. Silent skip preserves V8
        backward-compat."""
        ci_executor = _load_ci_executor()
        with patch(
            "aria_kernel.budget.record_cost_attribution",
        ) as record_mock:
            ci_executor._record_claude_cli_usage(
                raw_stdout='{"type":"message","text":"ok"}',
                request_envelope={"cycle_id": "cyc-1", "role": "primary_plan"},
                tools_dir=self.base,
                role="primary_plan",
                request_id="req-test-1",
            )
        record_mock.assert_not_called()

    def test_i_v31_d3_07_well_formed_wrapper_threads_envelope_fields(self) -> None:
        """Plan ARIA-V3.1-D3-07 — Codex JSONL with `usage` block + valid
        cycle_id + pressure_source_type → record_cost_attribution
        called with the threaded fields."""
        import json as _json
        ci_executor = _load_ci_executor()
        os.environ["ARIA_CYCLE_SIGNER_KEY_FP"] = "SHA256:test-fp-123"
        events = [
            {"type": "message", "text": "...", "model": "gpt-5.3-codex"},
            {"type": "turn_completed", "usage": {"input_tokens": 1500, "output_tokens": 750}},
        ]
        captured: dict[str, object] = {}
        def _capture(**kwargs):
            captured.update(kwargs)
            return {"schema_version": 1}
        with patch(
            "aria_kernel.budget.record_cost_attribution",
            side_effect=_capture,
        ):
            ci_executor._record_claude_cli_usage(
                raw_stdout="\n".join(_json.dumps(event) for event in events),
                request_envelope={
                    "cycle_id": "cyc-real-001",
                    "convergence_id": "plan-real-001",
                    "pressure_source_type": "operator_feedback",
                    "role": "primary_plan",
                },
                tools_dir=self.base,
                role="primary_plan",
                request_id="req-real-1",
            )
        self.assertEqual(captured["cycle_id"], "cyc-real-001")
        self.assertEqual(captured["plan_id"], "plan-real-001")
        self.assertEqual(captured["agent_role"], "primary_plan")
        self.assertEqual(captured["model"], "gpt-5.3-codex")
        self.assertEqual(captured["input_tokens"], 1500)
        self.assertEqual(captured["output_tokens"], 750)
        self.assertEqual(captured["estimated_usd"], 0.0)
        self.assertEqual(captured["pressure_source_type"], "operator_feedback")
        self.assertEqual(captured["signer_key_fp"], "SHA256:test-fp-123")


if __name__ == "__main__":
    unittest.main()
