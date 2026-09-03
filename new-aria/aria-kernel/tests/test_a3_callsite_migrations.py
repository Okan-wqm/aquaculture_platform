"""Plan 026R §A.3 — verify the 10 callsites migrate to strict readers.

3 invariants (one test class each):

* Governance.jsonl readers (spine_orchestrator, plan_016_metrics,
  reflection) route through ``governance_reader.read_governance_rows``.
* Runs.jsonl readers (spine_orchestrator, architecture_spine_gate)
  route through ``runs_reader.latest_run_for_tool``.
* Generic-JSONL readers (context_budget_gate, agent_compliance,
  agent_eval) route through ``strict_jsonl_reader.read_strict_jsonl``
  or the manifest-declared ``load_declared_jsonl`` strict reader.
"""
from __future__ import annotations

import unittest
from pathlib import Path


ARIA_KERNEL = Path(__file__).resolve().parent.parent / "aria_kernel"


def _src(name: str) -> str:
    return (ARIA_KERNEL / name).read_text(encoding="utf-8")


class GovernanceMigrationTests(unittest.TestCase):
    def test_governance_readers_use_read_governance_rows(self) -> None:
        # spine_orchestrator.py — latest_orchestrator_refresh
        spine = _src("spine_orchestrator.py")
        self.assertIn("from .governance_reader import read_governance_rows", spine)
        self.assertIn("read_governance_rows(gov, base_dir=root)", spine)

        # plan_016_metrics.py — _latest_unknown_count + kind-counts widget
        metrics = _src("plan_016_metrics.py")
        self.assertIn(
            "from .governance_reader import read_governance_rows", metrics,
        )
        self.assertIn(
            "read_governance_rows(governance, base_dir=tools_root)", metrics,
        )

        # reflection.py — _gate_activity_summary
        reflection = _src("reflection.py")
        self.assertIn("from .governance_reader import read_governance_rows", reflection)
        self.assertIn(
            "read_governance_rows(governance, base_dir=tools_root)", reflection,
        )


class RunsMigrationTests(unittest.TestCase):
    def test_runs_readers_use_runs_reader_latest_run_for_tool(self) -> None:
        spine = _src("spine_orchestrator.py")
        self.assertIn("from .runs_reader import latest_run_for_tool", spine)
        self.assertIn(
            "latest_run_for_tool(runs_path, tool_id=adapter_id)", spine,
        )

        gate = _src("architecture_spine_gate.py")
        self.assertIn("from .runs_reader import latest_run_for_tool", gate)
        self.assertIn(
            'latest_run_for_tool(runs_path, tool_id="security-boundary-adapter")',
            gate,
        )
        self.assertIn(
            'latest_run_for_tool(runs_path, tool_id="agent-harness-security-adapter")',
            gate,
        )


class GenericJsonlMigrationTests(unittest.TestCase):
    def test_generic_jsonl_readers_use_strict_reader(self) -> None:
        expected_readers = {
            "context_budget_gate.py": "load_declared_jsonl(",
            "agent_compliance.py": "read_strict_jsonl(",
            "agent_eval.py": "read_strict_jsonl(",
            # §A.3 forward-fix (reviewer-A.3 finding): list_profile_history
            # in runtime_profile.py was the 11th JSONL ledger reader,
            # missed by the original §A.3 sweep because the wrong-shape
            # file-level allowlist entry hid it.
            "runtime_profile.py": "read_strict_jsonl(",
        }
        for module_name, reader_call in expected_readers.items():
            src = _src(module_name)
            self.assertIn(
                reader_call,
                src,
                f"{module_name} missing strict JSONL reader migration",
            )


class RuntimeProfileHistoryStrictTests(unittest.TestCase):
    """§A.3 forward-fix regression — list_profile_history raises on corrupt
    history row instead of silently dropping it."""

    def test_corrupt_history_row_raises_strict(self) -> None:
        import json
        import tempfile
        from pathlib import Path

        from aria_kernel.runtime_profile import (
            PROFILE_HISTORY_FILENAME,
            list_profile_history,
            set_profile,
        )
        from aria_kernel.tool_registry import GovernanceError

        tmp = Path(tempfile.mkdtemp(prefix="aria-rp-strict-"))
        try:
            base = tmp / "aria-tools"
            # Establish a valid first transition (lays down the history file
            # with the runtime-profile-changed governance event).
            set_profile("observe", operator_approval_ref="ref-1", base_dir=base)
            history_file = base / PROFILE_HISTORY_FILENAME
            # Append a corrupt row.
            with history_file.open("a", encoding="utf-8") as fh:
                fh.write("{not valid json\n")
            with self.assertRaises(GovernanceError) as ctx:
                list_profile_history(base_dir=base)
            self.assertIn(
                "strict_jsonl_row_corrupt", str(ctx.exception),
                str(ctx.exception),
            )
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
