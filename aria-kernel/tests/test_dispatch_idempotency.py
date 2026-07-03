"""ORPHAN-332 — a (re)dispatched planner request must start from a clean slate.

Live-diagnosed 2026-07-03 (cycle 28659464267): the cross-reviewer's FIRST
dispatch produced a valid cross_review, but a poll timeout (300s, short under
the credit→opus fallback) requeued it. On re-dispatch opus read the prior
attempt's envelope still on disk and — following the repo's "don't overwrite
existing work" discipline — refused to regenerate, emitting a meta-response
("the expected output file already exists on disk") whose top-level cross_review
was absent → plan_content_invalid:...:absent_or_not_object → requeue loop →
agent_human_required. invoke_claude_cli now clears the stale output + transcript
before every dispatch so each attempt writes a fresh, schema-valid envelope.
"""
from __future__ import annotations

import importlib.util
import inspect
import tempfile
import unittest
from pathlib import Path

_CI = Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "ci_executor.py"


def _load_ci_executor():
    spec = importlib.util.spec_from_file_location("aria_ci_executor_under_test", _CI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ClearStaleDispatchArtifacts(unittest.TestCase):
    def setUp(self) -> None:
        self.ci = _load_ci_executor()

    def test_clears_stale_output_and_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "round-1-cross_review-AIR-x.md"
            tr = out.with_suffix(".transcript.jsonl")
            out.write_text('{"status":"submitted","stale":true}', encoding="utf-8")
            tr.write_text('{"prior":"run"}\n', encoding="utf-8")
            self.assertTrue(out.exists() and tr.exists())
            self.ci._clear_stale_dispatch_artifacts(out, tr)
            self.assertFalse(out.exists(), "stale output must be removed")
            self.assertFalse(tr.exists(), "stale transcript must be removed")

    def test_missing_artifacts_are_a_noop(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "absent.md"
            tr = out.with_suffix(".transcript.jsonl")
            # Must not raise on a fresh (first) dispatch where nothing exists yet.
            self.ci._clear_stale_dispatch_artifacts(out, tr)
            self.assertFalse(out.exists())

    def test_invoke_claude_cli_clears_before_dispatch(self) -> None:
        # Source pin: the clear MUST happen before the agent subprocess runs
        # (before run_claude_exec), else opus reads the stale file first.
        src = inspect.getsource(self.ci.invoke_claude_cli)
        self.assertIn("_clear_stale_dispatch_artifacts(", src)
        clear_at = src.index("_clear_stale_dispatch_artifacts(")
        run_at = src.index("run_claude_exec(")
        self.assertLess(clear_at, run_at, "must clear stale output BEFORE dispatching the agent")


if __name__ == "__main__":
    unittest.main()
