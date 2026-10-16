"""run_tool runs an adapter with its declared input and returns the run it recorded.

ARIA-MEDIUM-516 (G002 N2), part of ARIA-HIGH-045. Two defects of one chokepoint:

* Only the cycle's tools phase merged a manifest's ``default_input`` into the
  payload (cycle.py ``_phase_tools``). Every other caller of ``run_tool`` -- the
  spine refresh, ``aria-kernel tool run``, the gateway scheduler -- ran the
  adapter without its declared roots, and tenant-scoping and security-boundary
  exit 1 in ``requireScanRoots`` on every such run. ``run_tool`` now owns the
  merge: ``{**default_input, **input_payload}``, caller keys win.
* ``run_tool`` returned the envelope it built BEFORE ``record_run`` validated a
  copy of it and downgraded the copy's status (``scope_violation``,
  ``evidence_error``, ``integrity_failed``). Callers judged a run by a status
  the store never held: ``tool run`` exited 0 and the refresh counted the run
  fresh. ``record_run`` now returns the row it appended, and ``run_tool``
  returns that row as ``envelope``.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _helpers.git_fixtures import commit_files, make_local_git_repo  # noqa: E402
from test_enterprise_cycle import (  # noqa: E402
    FAKE_RUNNER,
    fake_tool_argv,
    register_active_for_test,
    register_tool,
    self_output_tool,
    shadow_tool,
    tool_output,
)

from aria_kernel import cycle as cycle_mod  # noqa: E402
from aria_kernel.cli import main as cli_main  # noqa: E402
from aria_kernel.gateway import scheduler  # noqa: E402
from aria_kernel.runtime_artifacts import resolve_artifact_payload  # noqa: E402
from aria_kernel.tool_runner import run_tool  # noqa: E402

DECLARED_INPUT = {"roots": ["src"], "mode": "declared"}


def _roots_requiring_tool() -> dict:
    """A SHADOW tool that exits 1 without ``roots``, like adapter-fs.ts."""
    tool = shadow_tool()
    tool["tool_id"] = "roots-requiring-tool"
    tool["default_input"] = dict(DECLARED_INPUT)
    tool["runner"]["argv"] = ["python3", FAKE_RUNNER.as_posix(), "--require-input-key", "roots"]
    return tool


def _runs_rows(tools: Path) -> list[dict]:
    return [json.loads(line) for line in (tools / "runs.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]


def _adapter_stdin(row: dict, tools: Path) -> dict:
    """The payload the adapter echoed, read from the run's own artifact."""
    artifact = resolve_artifact_payload(row["artifact_ref"], base_dir=tools)
    stdout = artifact["payload"]["stdout"]
    return json.loads(stdout)["observations"][0]["details"]


class _Workspace(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.workspace = make_local_git_repo(root, name="work", initial_commit=False)
        commit_files(self.workspace, {"src/app.ts": "export const app = 1;\n"})
        self.tools = root / "tools"
        self.tools.mkdir()


class DeclaredInputTests(_Workspace):
    def test_run_tool_merges_declared_default_input_caller_wins(self) -> None:
        register_tool(_roots_requiring_tool(), base_dir=self.tools)
        result = run_tool(
            "roots-requiring-tool",
            {"cycle_id": "cyc-default-input", "mode": "caller"},
            "cyc-default-input",
            workspace_root=self.workspace,
            base_dir=self.tools,
        )
        envelope = result["envelope"]
        self.assertEqual(envelope["status"], "ok", envelope["runner"]["stderr_sample"])
        received = _adapter_stdin(envelope, self.tools)
        self.assertEqual(received["roots"], ["src"], "the declared roots reach the adapter")
        self.assertEqual(received["mode"], "caller", "a caller key wins over the declared default")
        self.assertEqual(received["cycle_id"], "cyc-default-input")

    def test_phase_tools_hands_run_tool_only_cycle_keys_and_the_adapter_sees_the_same_bytes(self) -> None:
        # run_tool is the one owner of the merge, so the tools phase hands it
        # the cycle's own keys only; the adapter still receives exactly
        # {**default_input, cycle keys, repo_snapshot}, and the recorded
        # input_hash is the hash of those bytes (unchanged by the move).
        register_tool(_roots_requiring_tool(), base_dir=self.tools)
        context = cycle_mod.build_phase_context(
            cycle_id="cyc-phase-tools", workspace_root=self.workspace, base_dir=self.tools,
        )
        handed: list[dict] = []
        real_run_tool = cycle_mod.run_tool

        def recording_run_tool(tool_id, input_payload, *args, **kwargs):
            handed.append(dict(input_payload))
            return real_run_tool(tool_id, input_payload, *args, **kwargs)

        with patch.object(cycle_mod, "run_tool", side_effect=recording_run_tool):
            cycle_mod._phase_tools(context)
        self.assertEqual([set(payload) for payload in handed], [{"cycle_id", "pressure_summary"}])
        row = next(r for r in _runs_rows(self.tools) if r["tool_id"] == "roots-requiring-tool")
        self.assertEqual(row["status"], "ok", row["runner"]["stderr_sample"])
        received = _adapter_stdin(row, self.tools)
        self.assertEqual(
            {key: value for key, value in received.items() if key != "repo_snapshot"},
            {**DECLARED_INPUT, "cycle_id": "cyc-phase-tools", "pressure_summary": {}},
        )
        canonical = json.dumps(received, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.assertEqual(row["input_hash"], "sha256:" + hashlib.sha256(canonical).hexdigest())


class DeclaredSnapshotTests(_Workspace):
    """A manifest's default_input is adapter input, never the run's snapshot.

    run_tool judges evidence against the snapshot it is handed or builds; a
    `repo_snapshot` declared in default_input must not stand in for it, or a
    registered manifest could list files the workspace does not hold as
    "in the snapshot" and pass the evidence check (the cycle's merge, the
    only one before ARIA-MEDIUM-516, let it through).
    """

    def _forged_snapshot_tool(self) -> dict:
        tool = shadow_tool()
        tool["tool_id"] = "forged-snapshot-tool"
        tool["default_input"] = {"repo_snapshot": {
            "schema_version": 1, "snapshot_mode": "working_tree", "repo_state_id": "repo-state:forged",
            "snapshot_hash": "sha256:forged", "allowed_paths": ["src/app.ts", "src/ghost.ts"],
        }}
        tool["runner"]["argv"] = fake_tool_argv(tool_output(
            findings=[], read_paths=["src/ghost.ts"], evidence_sources=["src/ghost.ts"],
        ))
        return tool

    def _assert_judged_against_the_real_tree(self, row: dict) -> None:
        self.assertNotEqual(row["repo_snapshot"]["repo_state_id"], "repo-state:forged")
        self.assertEqual(row["status"], "evidence_error")
        codes = {error["code"] for error in row["evidence_validation"]["errors"]}
        self.assertIn("read_path_outside_snapshot", codes)

    def test_run_tool_ignores_a_declared_repo_snapshot(self) -> None:
        register_tool(self._forged_snapshot_tool(), base_dir=self.tools)
        result = run_tool("forged-snapshot-tool", {}, "cyc-forged", workspace_root=self.workspace, base_dir=self.tools)
        self._assert_judged_against_the_real_tree(result["envelope"])

    def test_the_tools_phase_ignores_a_declared_repo_snapshot(self) -> None:
        register_tool(self._forged_snapshot_tool(), base_dir=self.tools)
        context = cycle_mod.build_phase_context(
            cycle_id="cyc-forged-phase", workspace_root=self.workspace, base_dir=self.tools,
        )
        cycle_mod._phase_tools(context)
        rows = [row for row in _runs_rows(self.tools) if row["tool_id"] == "forged-snapshot-tool"]
        self.assertEqual(len(rows), 1)
        self._assert_judged_against_the_real_tree(rows[0])


class RecordedRowTests(_Workspace):
    def test_run_tool_envelope_is_the_recorded_row(self) -> None:
        # Evidence that names the store's own ledger: the runner sees exit 0
        # and a parseable output ("ok"), record_run downgrades the persisted
        # copy to evidence_error.
        register_tool(self_output_tool(), base_dir=self.tools)
        result = run_tool("self-output-tool", {}, "cyc-recorded", workspace_root=self.workspace, base_dir=self.tools)
        rows = _runs_rows(self.tools)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "evidence_error")
        self.assertEqual(result["envelope"]["status"], "evidence_error")
        self.assertEqual(result["envelope"], rows[0], "the returned envelope is the stored row")
        decision = result["health_decision"]
        self.assertEqual(decision["tool_id"], "self-output-tool")
        # Plan 024 §B-7: the health decision's keys stay merged at the top.
        self.assertEqual({key: result[key] for key in decision}, decision)

    def test_tool_run_cli_exits_by_the_recorded_status(self) -> None:
        register_tool(self_output_tool(), base_dir=self.tools)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli_main([
                "tool", "run", "--tool-id", "self-output-tool", "--cycle-id", "cyc-cli",
                "--workspace-root", str(self.workspace), "--tools-dir", str(self.tools),
            ])
        self.assertEqual(json.loads(out.getvalue())["envelope"]["status"], "evidence_error")
        self.assertEqual(code, 1)



class GatewaySchedulerTests(_Workspace):
    """The scheduler's `adapter_run:<tool>` action: run_tool(tool_id, {}, ...)."""

    def _run_action(self, tool_id: str) -> dict:
        return scheduler.run_action(f"adapter_run:{tool_id}", base_dir=self.tools, workspace_root=self.workspace)

    def test_scheduled_adapter_run_gets_the_declared_roots(self) -> None:
        register_active_for_test({**_roots_requiring_tool(), "status": "ACTIVE"}, base_dir=self.tools)
        result = self._run_action("roots-requiring-tool")
        self.assertEqual(result["detail"]["envelope_status"], "ok")
        self.assertEqual(result["status"], "ran")

    def test_scheduled_adapter_run_is_judged_by_the_recorded_status(self) -> None:
        register_active_for_test({**self_output_tool(), "status": "ACTIVE"}, base_dir=self.tools)
        result = self._run_action("self-output-tool")
        self.assertEqual(result["detail"]["envelope_status"], "evidence_error")
        self.assertEqual(result["status"], "failed")


if __name__ == "__main__":
    unittest.main()
