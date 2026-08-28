"""ORPHAN-HIGH-781 — the anchor distinct-model guarantee must count the
model the DISPATCHER resolved, not a string the judged agent wrote about
itself.

Three precedents already established the doctrine this test pins: judge
identity (`details.agent_subagent_type`, force-stamped), judgment group id
and finding fingerprint (mint-first, envelope fallback). The model gets
the same treatment: ci_executor force-stamps `details.agent_dispatch_model`
from the runtime profile it resolved at invocation, and judgment_bridge
prefers that stamp over the judge's own `verdict.model` self-report.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.judgment_bridge import record_judge_verdict_from_response
from aria_kernel.tool_registry import ensure_tools_dir

_REPO = Path(__file__).resolve().parents[2]
_POC = _REPO / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

from ci_executor import _build_envelope_from_claude_output  # noqa: E402


def _stream_json_with_envelope(payload: dict) -> str:
    final = "```json\n" + json.dumps(payload) + "\n```"
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "judging"}]}}) + "\n" + \
        json.dumps({"type": "result", "result": final, "subtype": "success"})


def _request() -> dict:
    return {
        "tool_id": "tool-a",
        "run_id": "run-1",
        "finding_id": "F-1",
        "judgment_group_id": "judge:tool-a:fp1",
    }


class ExecutorStampTests(unittest.TestCase):
    def test_dispatch_model_is_force_stamped_over_agent_echo(self) -> None:
        # The agent echoes BOTH a details field and a verdict.model
        # self-report; neither may survive over the dispatch record.
        stdout = _stream_json_with_envelope(
            {
                "status": "submitted",
                "details": {
                    "agent_dispatch_model": "claude-opus-5",
                    "verdict": {"verdict": "true_positive", "model": "claude-opus-5"},
                },
            }
        )
        envelope = _build_envelope_from_claude_output(
            raw_stdout=stdout,
            request_id="req-1",
            claim_id="claim-1",
            agent_id="ci-executor:gha-1",
            role="evidence_judgment",
            subagent_type="aria-adversarial-judge",
            must_satisfy=[],
            dispatch_model="glm-5.3",
        )
        self.assertEqual(envelope["details"]["agent_dispatch_model"], "glm-5.3")
        # The self-report stays in the payload as data, unchanged.
        self.assertEqual(envelope["details"]["verdict"]["model"], "claude-opus-5")

    def test_absent_dispatch_model_leaves_no_stale_stamp(self) -> None:
        stdout = _stream_json_with_envelope(
            {"status": "submitted", "details": {"verdict": {"verdict": "true_positive"}}}
        )
        envelope = _build_envelope_from_claude_output(
            raw_stdout=stdout,
            request_id="req-1",
            claim_id="claim-1",
            agent_id="ci-executor:gha-1",
            role="evidence_judgment",
            subagent_type="aria-evidence-judge",
            must_satisfy=[],
            dispatch_model=None,
        )
        self.assertNotIn("agent_dispatch_model", envelope["details"])


class BridgePrecedenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-781-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    def _feedback_rows(self) -> list[dict]:
        path = self.tools / "operator-feedback.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def test_stamped_dispatch_model_outranks_the_self_report(self) -> None:
        response = {
            "role": "evidence_judgment",
            "details": {
                "agent_subagent_type": "aria-evidence-judge",
                "agent_dispatch_model": "opus",
                "verdict": {"verdict": "true_positive", "model": "glm-5.3", "rationale": "seen"},
            },
        }
        row = record_judge_verdict_from_response(request=_request(), response=response, base_dir=self.tools)
        self.assertIsNotNone(row)
        self.assertEqual(row["model"], "opus")
        recorded = self._feedback_rows()[-1]
        self.assertEqual(recorded["model"], "opus")

    def test_self_report_survives_only_as_legacy_fallback(self) -> None:
        response = {
            "role": "evidence_judgment",
            "details": {
                "agent_subagent_type": "aria-evidence-judge",
                "verdict": {"verdict": "true_positive", "model": "claude-opus-5", "rationale": "seen"},
            },
        }
        row = record_judge_verdict_from_response(request=_request(), response=response, base_dir=self.tools)
        self.assertIsNotNone(row)
        self.assertEqual(row["model"], "claude-opus-5")


if __name__ == "__main__":
    unittest.main()
