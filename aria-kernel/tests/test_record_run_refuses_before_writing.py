"""SE-1-R2 appellate R4 — a run whose findings cannot be attributed is refused
before anything of it is written.

WHY. SE-1 round 2 made "no project map" a named refusal
(``service_key_map_unavailable``, ``project_manifest_unreadable``) instead of
an empty service dimension. ``feedback_store.record_findings_for_run`` raised
it, but ``tool_health.record_run`` calls that function after it has appended
the run row, the run-by-cycle index and the raw findings. Reviewer probe
evidence p5: the store kept a run whose ``emitted_counts.findings`` was 1 and a
findings ledger with 0 rows, and no health decision — a run recorded as
complete whose findings were never recorded.

WHAT THIS PINS. With a malformed ``project.json`` in the bound workspace, and
separately with a store that declares no workspace, ``record_run`` of a run
that emits a finding raises the named ``GovernanceError`` and leaves
runs.jsonl, the run-by-cycle index, raw-findings.jsonl, findings.jsonl and
the run artifacts byte-identical to their state before the call.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import record_run, register_tool, tool_health
from aria_kernel.feedback_store import findings_path, raw_findings_path
from aria_kernel.runtime_artifacts import by_cycle_runs_path, run_artifacts_root
from aria_kernel.tool_health import runs_path
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding
from tests.test_precision_scoped_to_current_emissions import _finding, _run, _tool_definition


def _snapshot(paths: list[Path], tree: Path) -> dict[str, bytes | None]:
    files = {p.as_posix(): (p.read_bytes() if p.is_file() else None) for p in paths}
    if tree.is_dir():
        files.update({p.as_posix(): p.read_bytes() for p in sorted(tree.rglob("*")) if p.is_file()})
    return files


class ARefusedMintWritesNothingOfTheRun(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name)
        self.workspace = tmp / "repo"
        (self.workspace / "docs").mkdir(parents=True)
        (self.workspace / "docs" / "a.md").write_text("x\n", encoding="utf-8")
        self.tools = tmp / "aria-tools"
        register_tool(_tool_definition(), base_dir=self.tools)
        self.run_envelope = _run("run-1", [_finding("a")])
        self.run_envelope["emitted_findings"] = [_finding("a")]

    def _ledgers(self) -> dict[str, bytes | None]:
        return _snapshot(
            [
                runs_path(self.tools),
                by_cycle_runs_path(self.tools, self.run_envelope["cycle_id"]),
                raw_findings_path(self.tools),
                findings_path(self.tools),
            ],
            run_artifacts_root(self.tools),
        )

    def _assert_refused_without_a_write(self, reason: str) -> None:
        before = self._ledgers()
        with mock.patch.object(tool_health, "can_emit_operator_facing", return_value=True):
            with self.assertRaisesRegex(GovernanceError, reason):
                record_run(self.run_envelope, base_dir=self.tools)
        self.assertEqual(self._ledgers(), before)

    def test_a_malformed_project_json_refuses_the_run_before_any_append(self) -> None:
        broken = self.workspace / "apps" / "broken"
        broken.mkdir(parents=True)
        (broken / "project.json").write_text('{"name": "broken",', encoding="utf-8")
        ensure_tools_binding(self.tools, workspace_root=self.workspace)
        self._assert_refused_without_a_write("project_manifest_unreadable:apps/broken/project.json")

    def test_an_unbound_store_refuses_the_run_before_any_append(self) -> None:
        self._assert_refused_without_a_write("service_key_map_unavailable")

    def test_a_bound_store_records_the_run_and_its_finding(self) -> None:
        # The control: the same run on a store that can attribute is recorded
        # whole, so the refusals above are about the map and nothing else.
        ensure_tools_binding(self.tools, workspace_root=self.workspace)
        with mock.patch.object(tool_health, "can_emit_operator_facing", return_value=True):
            record_run(self.run_envelope, base_dir=self.tools)
        self.assertEqual(len(findings_path(self.tools).read_text(encoding="utf-8").splitlines()), 1)
        self.assertEqual(len(runs_path(self.tools).read_text(encoding="utf-8").splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
