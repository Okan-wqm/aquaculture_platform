"""ARIA-025-D1 remainder — the operator `judge replay` CLI verb.

The kernel functions (replay_judges_on_goldset, compute_replay_recall)
were production-live only through the cycle phase; the operator verb
ARIA-025-D1 promised never landed. These tests pin the verb end-to-end
through the real cli_main entry point — no mocks — reusing the Plan
025 §C fixture shape from tests/test_judge_replay.py.
"""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cli import main as cli_main
from aria_kernel.feedback_store import append_jsonl, finding_fingerprint, raw_findings_path
from aria_kernel.goldset import promote_goldset_proposal
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir, utc_now

from tests._helpers.rule_contracts import register_contracted_tool


def _run(argv: list[str]) -> tuple[int, str]:
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli_main(argv) or 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, out.getvalue()


def _gi(tools: Path, run: str, finding: str, verdict: str) -> dict:
    adapter_finding = {"id": finding, "rule": "rule-a", "path": f"src/{finding}.py", "message": "m",
                       "severity": "medium", "evidence": [{"path": f"src/{finding}.py", "line": 1}]}
    fingerprint = finding_fingerprint("tool-x", adapter_finding)
    append_jsonl(raw_findings_path(tools), {
        "schema_version": 1, "tool_id": "tool-x", "run_id": run, "finding_id": finding,
        "finding_fingerprint": fingerprint, "status": "raw", "finding": adapter_finding,
    })
    return {
        "run_id": run, "finding_id": finding, "finding_fingerprint": fingerprint,
        "verdict": verdict, "severity": "medium", "source_type": "human",
        "confidence": 0.9, "evidence_refs": [f"src/{finding}.py:1"], "rationale": "gt",
    }


class JudgeReplayVerbTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        set_profile("standard", operator_approval_ref="test-judge-replay-verb", base_dir=self.tools)
        register_contracted_tool(self.tools, "tool-x")
        tp = [_gi(self.tools, "rtp0", "ftp0", "true_positive"),
              _gi(self.tools, "rtp1", "ftp1", "true_positive")]
        fp = [_gi(self.tools, "rfp0", "ffp0", "false_positive")]
        promote_goldset_proposal(tool_id="tool-x", curator="okan", base_dir=self.tools, proposal={
            "status": "ready", "recorded_at": utc_now(), "tool_id": "tool-x",
            "true_positive_count": 2, "known_false_positive_count": 1,
            "true_positive_items": tp, "known_false_positive_items": fp,
        })

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_verb_scoped_to_tool_dispatches_and_reports(self) -> None:
        code, out = _run([
            "--tools-dir", str(self.tools),
            "judge", "replay", "--tool-id", "tool-x",
        ])
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(len(payload["replayed"]), 1)
        first = payload["replayed"][0]
        self.assertEqual(first["tool_id"], "tool-x")
        self.assertEqual(first["status"], "dispatched")
        self.assertEqual(len(first["minted"]), 6)  # 3 gold items x 2 judges
        self.assertIn("replay_recall", payload)

    def test_verb_read_path_is_pure_no_calibration_row(self) -> None:
        """The verb's recall read calls score_judges directly:
        compute_judge_calibration appends an audit row per call, and that
        append belongs to the cycle phase only (Plan 025 §C ownership)."""
        calibration_ledger = self.tools / "calibration" / "judge-calibration.jsonl"
        _run(["--tools-dir", str(self.tools), "judge", "replay", "--tool-id", "tool-x"])
        if calibration_ledger.exists():
            rows = [line for line in calibration_ledger.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(rows, [], "operator verb must not append calibration rows")

    def test_verb_without_tool_id_walks_every_registered_tool(self) -> None:
        code, out = _run(["--tools-dir", str(self.tools), "judge", "replay"])
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        tool_ids = {row.get("tool_id") for row in payload["replayed"]}
        self.assertIn("tool-x", tool_ids)

    def test_verb_tool_without_goldset_is_a_reported_noop(self) -> None:
        code, out = _run([
            "--tools-dir", str(self.tools),
            "judge", "replay", "--tool-id", "tool-without-goldset",
        ])
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        first = payload["replayed"][0]
        self.assertEqual(first["status"], "no_active_goldset")
        self.assertEqual(first["replayed_items"], 0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
