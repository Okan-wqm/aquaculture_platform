"""ARIA-HIGH-037 — a cycle that raises after its started row is still sealed.

2026-09-03 04:10, run 33714052828, the first producer cycle after #1397:
the in-phase deadline interrupt (PhaseDeadlineExceeded) escaped a
``propagate`` phase, run_enterprise_cycle never reached its terminal-row
branch, and cycles.jsonl kept ``started`` with no terminal event. The
integrity verifier then refused the whole state
(``cycle has started event without terminal event``), the lane quarantined
66 MB of evidence and published nothing — a deadline meant to make the
night publishable made it unpublishable instead.

The lifecycle discipline now lives at the API boundary: whatever escapes
run_enterprise_cycle, an OPEN started row is sealed with a ``failed``
terminal row and a governance row naming the exception, and the exception
still propagates. A raise BEFORE the started row leaves no orphan terminal.
"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import cycle as cycle_module
from aria_kernel.cycle import PhaseDeadlineExceeded, run_enterprise_cycle
from aria_kernel.integrity import _verify_cycle_lifecycle, verify_integrity
from aria_kernel.ledger import read_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class SealOnRaiseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.workspace = Path(self.tmp.name) / "workspace"
        (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
        (self.workspace / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        (self.workspace / "nx.json").write_text('{"affected":{}}\n', encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.workspace, check=True)
        subprocess.run(["git", "-c", "user.email=aria@example.test", "-c", "user.name=ARIA Test", "add", "."], cwd=self.workspace, check=True)
        subprocess.run(["git", "-c", "user.email=aria@example.test", "-c", "user.name=ARIA Test", "commit", "-q", "-m", "initial"], cwd=self.workspace, check=True)
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def _cycle_events(self, cycle_id: str) -> list[str]:
        path = self.tools_dir / "cycles.jsonl"
        if not path.exists():
            return []
        return [str(row.get("event")) for row in read_jsonl(path) if row.get("cycle_id") == cycle_id]

    def _governance_reasons(self) -> list[str]:
        path = self.tools_dir / "governance.jsonl"
        if not path.exists():
            return []
        return [str(row.get("kind") or "") for row in read_jsonl(path)]

    def _raise_in_stage(self, target_stage: str, exc: BaseException):
        original = cycle_module._run_phase_stage

        def _stage(stage, context, **kwargs):
            if stage == target_stage:
                raise exc
            return original(stage, context, **kwargs)

        return mock.patch.object(cycle_module, "_run_phase_stage", side_effect=_stage)

    def test_deadline_escaping_a_propagate_stage_seals_the_cycle(self) -> None:
        with self._raise_in_stage("tools", PhaseDeadlineExceeded("interrupting to seal the cycle")):
            with self.assertRaises(PhaseDeadlineExceeded):
                run_enterprise_cycle(workspace_root=self.workspace, cycle_id="cyc-deadline", base_dir=self.tools_dir)
        self.assertEqual(self._cycle_events("cyc-deadline"), ["started", "failed"])
        lifecycle = _verify_cycle_lifecycle(self.tools_dir)
        self.assertTrue(lifecycle["valid"], lifecycle)
        self.assertEqual(verify_integrity(tools_dir=self.tools_dir)["status"], "ok")
        self.assertIn("cycle_raised_before_seal", self._governance_reasons())

    def test_any_exception_after_the_started_row_seals_the_cycle(self) -> None:
        with self._raise_in_stage("discovery", RuntimeError("discovery exploded")):
            with self.assertRaises(RuntimeError):
                run_enterprise_cycle(workspace_root=self.workspace, cycle_id="cyc-boom", base_dir=self.tools_dir)
        self.assertEqual(self._cycle_events("cyc-boom"), ["started", "failed"])
        self.assertTrue(_verify_cycle_lifecycle(self.tools_dir)["valid"])

    def test_a_raise_before_the_started_row_leaves_no_orphan_terminal(self) -> None:
        with self.assertRaises(GovernanceError):
            run_enterprise_cycle(workspace_root=self.workspace, cycle_id="cyc-early", base_dir=self.tools_dir, mode="no-such-mode")
        self.assertEqual(self._cycle_events("cyc-early"), [])

    def test_seal_is_idempotent_against_an_already_sealed_cycle(self) -> None:
        # A cycle that failed through the normal path already carries its
        # terminal row; re-entering the seal must not append a second one.
        with self._raise_in_stage("tools", PhaseDeadlineExceeded("first")):
            with self.assertRaises(PhaseDeadlineExceeded):
                run_enterprise_cycle(workspace_root=self.workspace, cycle_id="cyc-twice", base_dir=self.tools_dir)
        cycle_module._seal_open_cycle_after_raise(
            base_dir=self.tools_dir, workspace_root=self.workspace, cycle_id="cyc-twice", exc=RuntimeError("again"),
        )
        self.assertEqual(self._cycle_events("cyc-twice"), ["started", "failed"])


if __name__ == "__main__":
    unittest.main()
