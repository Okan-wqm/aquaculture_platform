"""E21-a — one surface, one writer, one schema.

Every test here fails if the corresponding guard is removed:

* the second writer cannot come back — ``validation`` refuses the runs
  path outright, and no longer exposes a duplicate reader;
* ``status`` and ``duration_ms`` are stamped by the writer, so the
  observability dashboard stops reporting ledger rows as failures;
* the dashboard REFUSES a row missing either field instead of silently
  counting it as failed (the pre-E21-a lie) or as ok (the opposite lie);
* a run cannot be recorded against a change or a commit that does not
  exist, so the merge gate's read cannot be satisfied by a placeholder.
"""
from __future__ import annotations

import subprocess
import inspect
import json
import hashlib
import shlex
import ast
import os
import sys
import runpy
from types import SimpleNamespace
from datetime import datetime
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import validation
from aria_kernel.change_ledger import emit_change_committed, emit_change_planned, get_change_chain
from aria_kernel.observability import (
    generate_observability_dashboard,
    record_cycle_metrics,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding, ensure_tools_dir
from aria_kernel.validation import run_validation_commands
from aria_kernel.workspace import canonical_identity
from aria_kernel.validation_runs_ledger import (
    VALIDATION_RUN_SCHEMA,
    classify_validation_run_status,
    derive_validation_run_status,
    list_validation_runs,
    list_validation_runs_for_change,
    record_validation_run,
    validation_run_duration_ms,
    validation_runs_path,
    verify_validation_run,
)
from tests._helpers.declared_fixtures import append_declared_fixture


def _git(root: Path, args: list[str]) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True,
    ).stdout.strip()


class UnifiedValidationRunSurfaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        (self.root / "seed.txt").write_text("seed\n", encoding="utf-8")
        _git(self.root, ["init", "-q"])
        _git(self.root, ["config", "user.email", "aria@example.invalid"])
        _git(self.root, ["config", "user.name", "ARIA"])
        _git(self.root, ["add", "."])
        _git(self.root, ["commit", "-q", "-m", "init"])
        self.commit_sha = _git(self.root, ["rev-parse", "HEAD"])
        self.base = Path(self.tmp.name) / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        planned = emit_change_planned(
            plan_id="plan-e21a",
            finding_id="F-e21a",
            intended_affected_files=["seed.txt"],
            intended_validation_refs=["python3 -m unittest --help"],
            architectural_tier=1,
            base_dir=self.base,
        )
        self.change_id = planned["change_id"]
        emit_change_committed(
            change_id=self.change_id,
            commit_sha=self.commit_sha,
            actual_affected_files=["seed.txt"],
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run(self, command: str = "python3 -m unittest --help") -> dict:
        return run_validation_commands(
            commands=[command],
            workspace_root=self.root,
            change_id=self.change_id,
            commit_sha=self.commit_sha,
            runner_identity="ci-executor:e21a",
            change_author_identity="agent:planner-e21a",
            base_dir=self.base,
            cycle_id="cycle-e21a",
        )

    # ---- one writer -------------------------------------------------

    def test_lane_a_rows_are_readable_by_the_merge_gate(self) -> None:
        """The defect: Lane-A rows carried no change_id, so the gate's
        ``list_validation_runs_for_change`` never saw them."""
        plan = self._run()
        self.assertEqual(plan["status"], "ok")
        rows = list_validation_runs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["commit_sha"], self.commit_sha)
        self.assertEqual(rows[0]["runner_identity"], "ci-executor:e21a")
        self.assertEqual(rows[0]["$schema"], VALIDATION_RUN_SCHEMA)
        # The log the ledger hash-bound is verifiable, not an opaque path.
        verify_validation_run(rows[0]["validation_run_id"], base_dir=self.base)

    def test_validation_module_refuses_to_write_the_runs_surface(self) -> None:
        """Deliberate break: delete the refusal and a second writer with a
        second schema can re-open the surface."""
        runs_file = validation_runs_path(self.base)
        with self.assertRaises(GovernanceError) as ctx:
            validation.append_jsonl(runs_file, {"schema_version": 1})
        self.assertIn("validation_surface_owned_elsewhere", str(ctx.exception))
        with self.assertRaises(GovernanceError):
            validation.load_jsonl(runs_file)

    def test_validation_module_no_longer_exposes_a_duplicate_reader(self) -> None:
        self.assertFalse(hasattr(validation, "list_validation_runs"))

    # ---- status + duration are stamped, never guessed ----------------

    def test_status_is_derived_from_exit_code_and_timeout(self) -> None:
        self.assertEqual(
            derive_validation_run_status(exit_code=0, timed_out=False), "ok",
        )
        self.assertEqual(
            derive_validation_run_status(exit_code=1, timed_out=False), "failed",
        )
        self.assertEqual(
            derive_validation_run_status(exit_code=None, timed_out=True), "timeout",
        )

    def test_failing_command_records_a_failed_row(self) -> None:
        plan = self._run("python3 -m unittest aria_missing_module_e21a")
        self.assertEqual(plan["status"], "failed")
        row = list_validation_runs(base_dir=self.base)[-1]
        self.assertEqual(classify_validation_run_status(row), "failed")
        self.assertNotEqual(row["exit_code"], 0)

    def test_timeout_row_carries_no_exit_code(self) -> None:
        log = Path(self.tmp.name) / "timeout.log"
        log.write_text("killed\n", encoding="utf-8")
        row = record_validation_run(
            change_id=self.change_id,
            cmd="python3 -m unittest --help",
            exit_code=None,
            timed_out=True,
            duration_ms=120_000,
            log_path=str(log),
            commit_sha=self.commit_sha,
            runner_identity="ci-executor:e21a",
            started_at="2026-08-01T00:00:00+00:00",
            completed_at="2026-08-01T00:02:00+00:00",
            base_dir=self.base,
        )
        self.assertEqual(row["status"], "timeout")
        with self.assertRaises(GovernanceError) as ctx:
            record_validation_run(
                change_id=self.change_id,
                cmd="x",
                exit_code=0,
                timed_out=True,
                duration_ms=1,
                log_path=str(log),
                commit_sha=self.commit_sha,
                runner_identity="ci-executor:e21a",
                started_at="2026-08-01T00:00:00+00:00",
                completed_at="2026-08-01T00:02:00+00:00",
                base_dir=self.base,
            )
        self.assertIn("timeout_exit_code_must_be_absent", str(ctx.exception))

    def test_duration_ms_is_required(self) -> None:
        log = Path(self.tmp.name) / "d.log"
        log.write_text("x\n", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            record_validation_run(
                change_id=self.change_id,
                cmd="x",
                exit_code=0,
                duration_ms=-1,
                log_path=str(log),
                commit_sha=self.commit_sha,
                runner_identity="ci-executor:e21a",
                started_at="2026-08-01T00:00:00+00:00",
                completed_at="2026-08-01T00:00:01+00:00",
                base_dir=self.base,
            )
        self.assertIn("duration_ms_required", str(ctx.exception))

    def test_commit_sha_must_be_hex(self) -> None:
        log = Path(self.tmp.name) / "h.log"
        log.write_text("x\n", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            record_validation_run(
                change_id=self.change_id,
                cmd="x",
                exit_code=0,
                duration_ms=1,
                log_path=str(log),
                commit_sha="PLACEHOLDER",
                runner_identity="ci-executor:e21a",
                started_at="2026-08-01T00:00:00+00:00",
                completed_at="2026-08-01T00:00:01+00:00",
                base_dir=self.base,
            )
        self.assertIn("commit_sha_not_hex", str(ctx.exception))

    # ---- the dashboard stops lying -----------------------------------

    def test_dashboard_counts_ledger_rows_as_passing(self) -> None:
        """The live miscount: every ledger-written row was reported as
        failed because it carried no ``status`` key."""
        self._run()
        self._run()
        record_cycle_metrics(
            cycle_id="cycle-e21a",
            phase_durations_ms={"validate": 10},
            artifact_count=1,
            status="ok",
            base_dir=self.base,
        )
        dashboard = generate_observability_dashboard(
            cycle_id="cycle-e21a", base_dir=self.base,
        )
        self.assertEqual(dashboard["validation"]["run_count"], 2)
        self.assertEqual(dashboard["validation"]["failed_count"], 0)
        self.assertEqual(dashboard["validation"]["status_counts"], {"ok": 2})
        self.assertGreater(dashboard["validation"]["total_duration_ms"], 0)

    def test_ledger_written_passing_run_is_not_reported_as_failed(self) -> None:
        """The lead's red-repro, run green.

        Before E21-a: call ``record_validation_run`` with ``exit_code=0``
        (a PASSING run), then ``generate_observability_dashboard``, and
        the dashboard returned ``{'run_count': 1, 'failed_count': 1,
        'total_duration_ms': 0}`` — the row genuinely carried neither
        ``status`` nor ``duration_ms``, so the reader guessed and guessed
        wrong. Same row, same function, asserted the other way round.
        """
        log = Path(self.tmp.name) / "repro.log"
        log.write_text("passing run output\n", encoding="utf-8")
        record_validation_run(
            change_id=self.change_id,
            cmd="python3 -m unittest --help",
            exit_code=0,
            duration_ms=1_234,
            log_path=str(log),
            commit_sha=self.commit_sha,
            runner_identity="ci-executor:e21a",
            started_at="2026-08-01T00:00:00+00:00",
            completed_at="2026-08-01T00:00:01+00:00",
            base_dir=self.base,
        )
        record_cycle_metrics(
            cycle_id="cycle-e21a",
            phase_durations_ms={"validate": 10},
            artifact_count=1,
            status="ok",
            base_dir=self.base,
        )
        dashboard = generate_observability_dashboard(
            cycle_id="cycle-e21a", base_dir=self.base,
        )
        self.assertEqual(
            {
                "run_count": dashboard["validation"]["run_count"],
                "failed_count": dashboard["validation"]["failed_count"],
                "total_duration_ms": dashboard["validation"]["total_duration_ms"],
            },
            {"run_count": 1, "failed_count": 0, "total_duration_ms": 1_234},
        )

    def test_dashboard_refuses_a_row_without_status(self) -> None:
        """Deliberate break: restore the ``status not in ("ok",)``
        expression and this row is silently counted as a failure."""
        self._run()
        append_declared_fixture(
            validation_runs_path(self.base),
            {
                "schema_version": 1,
                "validation_run_id": "vrun-legacy",
                "change_id": self.change_id,
                "cmd": "legacy",
                "exit_code": 0,
                "duration_ms": 5,
                "log_path": "/nowhere.log",
                "log_hash": "sha256:" + "0" * 64,
                "commit_sha": self.commit_sha,
                "runner_identity": "legacy",
            },
            expected_surface="validation_runs",
        )
        record_cycle_metrics(
            cycle_id="cycle-e21a",
            phase_durations_ms={"validate": 10},
            artifact_count=1,
            status="ok",
            base_dir=self.base,
        )
        with self.assertRaises(GovernanceError) as ctx:
            generate_observability_dashboard(
                cycle_id="cycle-e21a", base_dir=self.base,
            )
        self.assertIn("validation_run_status_missing", str(ctx.exception))

    def test_duration_reader_refuses_a_row_without_duration(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validation_run_duration_ms({"validation_run_id": "vrun-x"})
        self.assertIn("validation_run_duration_missing", str(ctx.exception))

    # ---- provenance cannot be fabricated -----------------------------

    def test_unknown_change_id_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_validation_commands(
                commands=["python3 -m unittest --help"],
                workspace_root=self.root,
                change_id="chg_does_not_exist",
                commit_sha=self.commit_sha,
                runner_identity="ci-executor:e21a",
                base_dir=self.base,
            )
        self.assertIn("validation_change_id_unknown", str(ctx.exception))
        self.assertEqual(list_validation_runs(base_dir=self.base), [])

    def test_unresolvable_commit_sha_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_validation_commands(
                commands=["python3 -m unittest --help"],
                workspace_root=self.root,
                change_id=self.change_id,
                commit_sha="0" * 40,
                runner_identity="ci-executor:e21a",
                base_dir=self.base,
            )
        self.assertIn("validation_commit_sha_unresolvable", str(ctx.exception))
        self.assertEqual(list_validation_runs(base_dir=self.base), [])

    def test_a_resolvable_commit_that_is_not_head_is_refused(self) -> None:
        """ORPHAN-CRITICAL-728 — resolving is not provenance.

        The runs execute in `workspace_root` at HEAD. A sha that merely EXISTS
        in the repository names a tree nothing measured, and the merge gate
        joins on these rows: `apply_engine.run_apply_gate` passed the tip of
        the implementation branch while HEAD sat on the base branch, so the
        suite measured the base, passed, and the ledger claimed the branch.
        """
        (self.root / "seed.txt").write_text("second\n", encoding="utf-8")
        _git(self.root, ["add", "."])
        _git(self.root, ["commit", "-q", "-m", "second"])
        new_head = _git(self.root, ["rev-parse", "HEAD"])
        self.assertNotEqual(new_head, self.commit_sha)

        with self.assertRaises(GovernanceError) as ctx:
            run_validation_commands(
                commands=["python3 -m unittest --help"],
                workspace_root=self.root,
                change_id=self.change_id,
                # A real commit in this repository — just not the one the
                # commands are about to run at.
                commit_sha=self.commit_sha,
                runner_identity="ci-executor:e21a",
                base_dir=self.base,
            )
        self.assertIn("validation_commit_sha_is_not_head", str(ctx.exception))
        self.assertEqual(list_validation_runs(base_dir=self.base), [])

    def test_self_attestation_is_refused_on_the_lane_a_path(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_validation_commands(
                commands=["python3 -m unittest --help"],
                workspace_root=self.root,
                change_id=self.change_id,
                commit_sha=self.commit_sha,
                runner_identity="agent:planner-e21a",
                change_author_identity="agent:planner-e21a",
                base_dir=self.base,
            )
        self.assertIn("self_attestation", str(ctx.exception))

    def test_run_logs_land_on_the_declared_surface(self) -> None:
        self._run()
        row = list_validation_runs(base_dir=self.base)[-1]
        log_path = Path(row["log_path"])
        expected_dir = ensure_tools_dir(self.base) / "validation" / "logs"
        self.assertEqual(log_path.parent, expected_dir)
        self.assertTrue(log_path.exists())


class ValidationInputBindingTests(unittest.TestCase):
    """Actual ordinary execution, then optional scoped input provenance."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "checkout"
        self.root.mkdir()
        self.base = Path(self.tmp.name) / "store" / "tools"
        self.contents = {
            "paths.py": (
                "import json\nfrom pathlib import Path\nfrom path_helper import canonical_path\n"
                "def unique_paths(paths):\n"
                "    config = json.loads(Path('path-config.json').read_text())\n"
                "    values = [canonical_path(p) for p in paths]\n"
                "    if not config['case_sensitive']:\n"
                "        values = [p.lower() for p in values]\n"
                "    return sorted(set(values))\n"
            ),
            "path_helper.py": "def canonical_path(value):\n    return value.removeprefix('./')\n",
            "path-config.json": '{"case_sensitive": true}\n',
            "test_paths.py": (
                "import unittest\nfrom paths import unique_paths\n"
                "class PathTests(unittest.TestCase):\n"
                "    def test_normalized_case_sensitive_deduplication(self):\n"
                "        self.assertEqual(unique_paths(['./src/A.py', 'src/a.py', 'src/A.py']),\n"
                "                         ['src/A.py', 'src/a.py'])\n"
            ),
            ".gitignore": "__pycache__/\n",
        }
        for name, content in self.contents.items():
            (self.root / name).write_text(content, encoding="utf-8")
        _git(self.root, ["init", "-q"])
        _git(self.root, ["config", "user.email", "aria@example.invalid"])
        _git(self.root, ["config", "user.name", "ARIA"])
        _git(self.root, ["add", "."])
        _git(self.root, ["commit", "-q", "-m", "ordinary path capability"])
        self.commit_sha = _git(self.root, ["rev-parse", "HEAD"])
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        ensure_tools_binding(self.base, workspace_root=self.root)
        self.selector = "test_paths.PathTests.test_normalized_case_sensitive_deduplication"
        self.command = "python3 -m unittest -v " + self.selector
        planned = emit_change_planned(
            plan_id="plan-scoped-paths", finding_id="F-scoped-paths",
            intended_affected_files=["paths.py", "path_helper.py", "path-config.json"],
            intended_validation_refs=[self.command], architectural_tier=1,
            base_dir=self.base,
        )
        self.change_id = planned["change_id"]
        emit_change_committed(
            change_id=self.change_id, commit_sha=self.commit_sha,
            actual_affected_files=["paths.py", "path_helper.py", "path-config.json"],
            base_dir=self.base,
        )
        self.scope = {"schema_version": 1, "files": {
            "source": ["paths.py"], "test": ["test_paths.py"],
            "config": ["path-config.json"], "dependency": ["path_helper.py"],
        }}

    def _execute(self, *, scoped: bool = True, leaves_working_edit: bool = False) -> dict:
        # Baseline executes the same real test before diagnosing the missing
        # optional capability; the accepted new keyword is forwarded once present.
        kwargs = {}
        if scoped and "input_scope" in inspect.signature(run_validation_commands).parameters:
            kwargs["input_scope"] = self.scope
        plan = run_validation_commands(
            commands=[self.command], workspace_root=self.root,
            change_id=self.change_id, commit_sha=self.commit_sha,
            runner_identity="ci-executor:scoped-paths",
            change_author_identity="agent:scoped-paths-planner",
            base_dir=self.base, cycle_id="cycle-scoped-paths", **kwargs,
        )
        self.assertEqual(plan["status"], "ok")
        row = list_validation_runs_for_change(self.change_id, base_dir=self.base)[-1]
        self.assertEqual(row["exit_code"], 0)
        self.assertFalse(row["timed_out"])
        self.assertEqual(row["commit_sha"], self.commit_sha)
        self.assertEqual(row["cmd"], self.command)
        self.assertEqual(get_change_chain(change_id=self.change_id, base_dir=self.base)["committed"]["commit_sha"], self.commit_sha)
        self.assertIn(row["validation_run_id"], plan["validation_run_ids"])
        self.assertIn(row["ledger_hash"], plan["run_refs"])
        log = Path(row["log_path"]).read_text()
        self.assertIn("test_normalized_case_sensitive_deduplication", log)
        self.assertIn("Ran 1 test", log)
        self.assertIn("\nOK\n", log)
        self.assertEqual(verify_validation_run(row["validation_run_id"], base_dir=self.base), row)
        if leaves_working_edit:
            self.assertNotEqual(_git(self.root, ["status", "--porcelain"]), "")
        else:
            self.assertEqual(_git(self.root, ["status", "--porcelain"]), "")
        self.assertFalse((self.root / "aria-tools").exists())
        return row

    def test_real_unittest_records_scoped_input_provenance(self) -> None:
        row = self._execute()
        self.assertIn("input_binding", row, "executed unittest has no optional input provenance")
        binding = row["input_binding"]
        self.assertEqual(binding["schema_version"], 1)
        self.assertEqual(binding["snapshot_mode"], "working_tree")
        self.assertEqual(binding["base_commit_sha"], self.commit_sha)
        self.assertEqual(binding["repo_identity"], canonical_identity(self.root))
        self.assertEqual(binding["scope_paths"], sorted(p for ps in self.scope["files"].values() for p in ps))
        self.assertEqual(binding["source_stability"], "unchanged")
        self.assertIsNone(binding["snapshot_hash"])
        self.assertIsNone(binding["repo_state_id"])
        for dimension in ("source", "test_selection", "test_content", "config"):
            self.assertTrue(binding[dimension + "_digest"].startswith("sha256:"))
            self.assertEqual(binding["availability"][dimension]["status"], "available")
        self.assertEqual(binding["availability"]["dependency"]["status"], "unknown")
        self.assertEqual(binding["availability"]["runner_environment"]["status"], "unknown")
        self.assertIsNone(binding["runner_environment_digest"])
        ref = row["log_ref"]
        self.assertEqual(ref["source_surface"], "validation_run_logs")
        self.assertEqual(ref["sha256"], row["log_hash"])
        self.assertEqual(ref["produced_by_workflow_run_id"], row["validation_run_id"])
        self.assertEqual(self.base / ref["uri"], Path(row["log_path"]))
        log = Path(row["log_path"]).read_text()
        manifest = json.loads(next(line.removeprefix("input_manifest: ") for line in log.splitlines()
                                   if line.startswith("input_manifest: ")))
        self.assertEqual(manifest["selection"]["selectors"], [self.selector])
        canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        expected_selection = {"schema_version": 1, "argv": shlex.split(self.command), "selectors": [self.selector]}
        self.assertEqual(manifest["selection"], expected_selection)
        self.assertEqual(binding["test_selection_digest"], "sha256:" + hashlib.sha256(canonical(expected_selection)).hexdigest())
        for role, dimension in (("source", "source"), ("test", "test_content"), ("config", "config"), ("dependency", "dependency")):
            expected = {"schema_version": 1, "files": [{
                "path": name, "status": "available", "reason": "explicit_file_observed",
                "size_bytes": len(self.contents[name].encode()),
                "content_hash": "sha256:" + hashlib.sha256(self.contents[name].encode()).hexdigest(),
            } for name in self.scope["files"][role]]}
            self.assertEqual(binding[dimension + "_digest"], "sha256:" + hashlib.sha256(canonical(expected)).hexdigest())
        self.assertLessEqual(datetime.fromisoformat(binding["capture_started_at"]), datetime.fromisoformat(row["started_at"]))
        self.assertLessEqual(datetime.fromisoformat(row["started_at"]), datetime.fromisoformat(binding["capture_completed_at"]))
        self.assertLessEqual(datetime.fromisoformat(binding["capture_completed_at"]), datetime.fromisoformat(row["completed_at"]))
        for when in ("before", "after"):
            self.assertEqual({item["path"] for item in manifest[when]["files"]}, set(binding["scope_paths"]))
            for item in manifest[when]["files"]:
                original = self.contents[item["path"]].encode()
                self.assertEqual(item["size_bytes"], len(original))
                self.assertEqual(item["content_hash"], "sha256:" + hashlib.sha256(original).hexdigest())
                self.assertEqual(item["status"], "available")

    def test_omitted_scope_preserves_legacy_executed_row(self) -> None:
        row = self._execute(scoped=False)
        self.assertNotIn("input_binding", row)
        self.assertNotIn("log_ref", row)

    def test_real_unittest_records_public_child_observation(self) -> None:
        # Missing opt-in support must not be disguised by retrying with v1.
        test_source = self.contents["test_paths.py"].replace(
            "import unittest\n", "import unittest, json, os, struct, sys\n",
        ) + (
            "        self.assertEqual(sys.argv[1:], ['-v', " + repr(self.selector) + "])\n"
            "        print('ENV_CHILD:' + json.dumps({'pid': os.getpid(), 'interpreter': {\n"
            "            'implementation': sys.implementation.name,\n"
            "            'version': list(sys.version_info[:3]),\n"
            "            'cache_tag': sys.implementation.cache_tag,\n"
            "            'byte_order': sys.byteorder, 'pointer_bits': struct.calcsize('P') * 8,\n"
            "            'flags': {name: getattr(sys.flags, name) for name in\n"
            "                      ('utf8_mode', 'dont_write_bytecode', 'hash_randomization')}}}))\n"
        )
        (self.root / "test_paths.py").write_text(test_source)
        self._commit_revision()
        descriptor = {"schema_version": 2, "files": self.scope["files"],
                      "execution_profile": {"kind": "python_unittest_public_v1", "modules": ["path_helper"]}}
        public_values = {"PYTHONHASHSEED": "23", "PYTHONUTF8": str(1 - sys.flags.utf8_mode),
                         "PYTHONDONTWRITEBYTECODE": "1", "LC_ALL": "C", "TZ": "UTC"}
        with patch.dict(os.environ, public_values):
            plan = run_validation_commands(
                commands=[self.command], workspace_root=self.root,
                change_id=self.change_id, commit_sha=self.commit_sha,
                runner_identity="ci-executor:scoped-paths",
                change_author_identity="agent:scoped-paths-planner",
                base_dir=self.base, cycle_id="cycle-scoped-paths", input_scope=descriptor,
            )
        self.assertEqual(plan["status"], "ok")
        rows = list_validation_runs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["exit_code"], row["timed_out"], row["cmd"]), (0, False, self.command))
        self.assertEqual(row["commit_sha"], self.commit_sha)
        self.assertEqual(get_change_chain(change_id=self.change_id, base_dir=self.base)["committed"]["commit_sha"], self.commit_sha)
        self.assertEqual(plan["validation_run_ids"], [row["validation_run_id"]])
        self.assertEqual(plan["run_refs"], [row["ledger_hash"]])
        self.assertEqual(verify_validation_run(row["validation_run_id"], base_dir=self.base), row)
        log_bytes = Path(row["log_path"]).read_bytes()
        log = log_bytes.decode()
        self.assertIn(self.selector, log)
        self.assertIn("Ran 1 test", log)
        self.assertIn("\nOK\n", log)
        self.assertEqual(row["log_hash"], "sha256:" + hashlib.sha256(log_bytes).hexdigest())
        self.assertEqual(row["log_ref"]["sha256"], row["log_hash"])
        self.assertEqual(row["log_ref"]["source_surface"], "validation_run_logs")
        self.assertEqual(row["log_ref"]["produced_by_workflow_run_id"], row["validation_run_id"])
        self.assertEqual(self.base / row["log_ref"]["uri"], Path(row["log_path"]))
        marker = json.loads(next(line.removeprefix("ENV_CHILD:") for line in log.splitlines() if line.startswith("ENV_CHILD:")))
        manifest = self._manifest(row)
        environment = manifest["environment"]
        self.assertEqual(environment["schema_version"], 1)
        self.assertEqual(environment["observation"]["child_pid"], marker["pid"])
        self.assertNotEqual(marker["pid"], os.getpid())
        self.assertEqual(environment["observation"]["phase"], "post_run")
        self.assertNotEqual(marker["interpreter"]["flags"]["utf8_mode"], sys.flags.utf8_mode)
        self.assertEqual(environment["requested_argv"], shlex.split(self.command))
        self.assertEqual(environment["unittest_argv"], ["-v", self.selector])
        spawned = ast.literal_eval(next(line.removeprefix("argv: ") for line in log.splitlines() if line.startswith("argv: ")))
        self.assertEqual(environment["spawned_argv"], spawned)
        self.assertEqual(spawned[0], "python3")
        self.assertNotEqual(spawned, shlex.split(self.command))
        self.assertEqual(manifest["selection"], {"schema_version": 1, "argv": shlex.split(self.command), "selectors": [self.selector]})
        observer = Path(validation.__file__).with_name("_validation_unittest_child.py")
        stable = environment["stable"]
        config_payload = {"schema_version": 1, "files": [{
            "path": "path-config.json", "status": "available", "reason": "explicit_file_observed",
            "size_bytes": len(self.contents["path-config.json"].encode()),
            "content_hash": "sha256:" + hashlib.sha256(self.contents["path-config.json"].encode()).hexdigest(),
        }]}
        config_digest = "sha256:" + hashlib.sha256(json.dumps(
            config_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
        ).encode()).hexdigest()
        self.assertEqual(row["input_binding"]["config_digest"], config_digest)
        expected = {
            "schema_version": 1, "profile_kind": "python_unittest_public_v1",
            "observer_source_hash": "sha256:" + hashlib.sha256(observer.read_bytes()).hexdigest(),
            "interpreter": marker["interpreter"], "observation_phase": "post_run",
            "public_environment": {key: {"status": "available", "value": value} for key, value in public_values.items()},
            "modules": {"path_helper": {
                "presence": "observed_post_run", "origin_kind": "source",
                "origin_file_observation": {"status": "available", "phase": "post_run",
                    "size_bytes": len(self.contents["path_helper.py"].encode()),
                    "content_hash": "sha256:" + hashlib.sha256(self.contents["path_helper.py"].encode()).hexdigest()},
                "executed_content_binding": {"status": "unknown", "reason": "loaded_bytes_not_observed"},
            }},
            "config_digest": config_digest,
            "control_profile": {"status": "unknown", "reason": "bounded_profile_observation_pending"},
            "availability": {"interpreter": "observed_same_child", "effective_environment": "unknown",
                             "installed_dependencies": "unknown", "effective_configuration": "unknown"},
        }
        self.assertEqual(stable, expected)
        canonical = json.dumps(expected, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        self.assertEqual(row["input_binding"]["runner_environment_digest"], "sha256:" + hashlib.sha256(canonical).hexdigest())
        self.assertNotIn(str(self.root), canonical.decode())
        for dimension in ("runner_environment", "dependency", "configuration_closure", "selection_closure"):
            self.assertEqual(row["input_binding"]["availability"][dimension]["status"], "unknown")
        self.assertEqual(_git(self.root, ["status", "--porcelain"]), "")
        self.assertFalse((self.root / "aria-tools").exists())

    def _manifest(self, row: dict) -> dict:
        log = Path(row["log_path"]).read_text()
        return json.loads(next(line.removeprefix("input_manifest: ") for line in log.splitlines()
                               if line.startswith("input_manifest: ")))

    def _environment_run(self, *, scoped=True, timeout_ms=120_000, modules=None):
        descriptor = {"schema_version": 2, "files": self.scope["files"],
                      "execution_profile": {"kind": "python_unittest_public_v1", "modules": ["path_helper"]}}
        if modules is not None:
            descriptor["execution_profile"]["modules"] = modules
        plan = run_validation_commands(
            commands=[self.command], workspace_root=self.root,
            change_id=self.change_id, commit_sha=self.commit_sha,
            runner_identity="ci-executor:scoped-paths", base_dir=self.base,
            input_scope=descriptor if scoped else self.scope, timeout_ms=timeout_ms,
        )
        row = list_validation_runs_for_change(self.change_id, base_dir=self.base)[-1]
        self.assertEqual(verify_validation_run(row["validation_run_id"], base_dir=self.base), row)
        self.assertEqual(plan["run_refs"], [row["ledger_hash"]])
        self.assertEqual(plan["validation_run_ids"], [row["validation_run_id"]])
        self.assertEqual((row["change_id"], row["commit_sha"], row["cmd"]), (self.change_id, self.commit_sha, self.command))
        self.assertEqual(plan["status"], "ok" if row["status"] == "ok" else "failed")
        return row, Path(row["log_path"]).read_text()

    def test_observer_preserves_real_uninstrumented_full_unittest_argv(self):
        source = self.contents["test_paths.py"].replace("import unittest\n", "import unittest, json, os, sys\n")
        source += "        print('ARGV:' + json.dumps({'argv': sys.argv, 'executable_name': os.path.basename(sys.executable)}))\n"
        (self.root / "test_paths.py").write_text(source)
        self._commit_revision()
        observations = []
        for scoped in (False, True):
            row, log = self._environment_run(scoped=scoped)
            self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
            self.assertIn("Ran 1 test", log)
            stdout = log.split("--- stdout ---\n", 1)[1].split("--- stderr ---\n", 1)[0]
            stderr = log.split("--- stderr ---\n", 1)[1].split("input_manifest: ", 1)[0]
            self.assertIn("ARGV:", stdout)
            self.assertNotIn("ARGV:", stderr)
            self.assertIn("Ran 1 test", stderr)
            observations.append(json.loads(next(line[5:] for line in log.splitlines() if line.startswith("ARGV:"))))
        self.assertEqual(observations[1], observations[0])
        self.assertEqual(observations[0]["argv"], [observations[0]["executable_name"] + " -m unittest", "-v", self.selector])

    def test_optional_receipt_setup_errors_preserve_real_command(self):
        for failure in ("pipe", "read_nonblocking", "write_nonblocking", "pipe_bound"):
            with self.subTest(failure=failure):
                owned, closed, hits = [], [], []
                def acquire():
                    if failure == "pipe":
                        hits.append(failure)
                        raise OSError("ordinary optional pipe failure")
                    pair = os.pipe()
                    owned.extend(pair)
                    return pair
                def blocking(fd, value):
                    target = "read_nonblocking" if fd == owned[0] else "write_nonblocking"
                    if failure == target:
                        hits.append(failure)
                        raise OSError("ordinary optional mode failure")
                    return os.set_blocking(fd, value)
                def bound(fd, name):
                    if failure == "pipe_bound":
                        hits.append(failure)
                        raise OSError("ordinary optional bound failure")
                    return os.fpathconf(fd, name)
                def close(fd):
                    closed.append(fd)
                    os.close(fd)
                proxy = SimpleNamespace(environ=os.environ, pipe=acquire, set_blocking=blocking,
                                        fpathconf=bound, close=close, read=os.read)
                with patch.object(validation, "os", proxy):
                    row, log = self._environment_run()
                self.assertEqual(hits, [failure])
                self.assertCountEqual(closed, owned)
                self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
                self.assertIn("Ran 1 test", log)
                self.assertIn("\nOK\n", log)
                env = self._manifest(row)["environment"]
                self.assertEqual(env["spawned_argv"], shlex.split(self.command))
                self.assertEqual(env["observation"]["reason"], "receipt_setup_unavailable")
                self.assertEqual(env["work"]["child_charged_bytes"], env["work"]["child_reserved_bytes"])

    def test_optional_parent_close_errors_preserve_real_failed_outcome(self):
        (self.root / "test_paths.py").write_text(self.contents["test_paths.py"] + "        print('REAL_FAILURE')\n        self.fail('ordinary expected failure')\n")
        self._commit_revision()
        for end in ("read", "write"):
            with self.subTest(end=end):
                owned, closed, hits = [], [], []
                def acquire():
                    pair = os.pipe()
                    owned.extend(pair)
                    return pair
                def close(fd):
                    closed.append(fd)
                    os.close(fd)
                    if fd == owned[0 if end == "read" else 1]:
                        hits.append(end)
                        raise OSError("ordinary close reporting failure")
                proxy = SimpleNamespace(environ=os.environ, pipe=acquire, set_blocking=os.set_blocking,
                                        fpathconf=os.fpathconf, close=close, read=os.read)
                with patch.object(validation, "os", proxy):
                    row, log = self._environment_run()
                self.assertEqual(hits, [end])
                self.assertCountEqual(closed, owned)
                self.assertEqual((row["exit_code"], row["timed_out"]), (1, False))
                self.assertIn("REAL_FAILURE", log)
                self.assertIn("FAILED (failures=1)", log)
                self.assertIn("receipt_" + end + "_close_unavailable", self._manifest(row)["environment"]["diagnostics"])

    def test_optional_child_close_error_preserves_unittest_exit(self):
        # Exact private cleanup seam; no governance rows or test result are altered.
        child = runpy.run_path(str(Path(validation.__file__).with_name("_validation_unittest_child.py")))
        read_fd, write_fd = os.pipe()
        real_close, hits = os.close, []
        def close(fd):
            real_close(fd)
            hits.append(fd)
            raise OSError("ordinary child close reporting failure")
        args = ["observer", str(write_fd), "4096", "1", "4096", "[]", "0.25", "--", "-q", "unused.Test.test_case"]
        old_path = sys.path[:]
        try:
            proxy = SimpleNamespace(**{**vars(os), "close": close})
            with patch.object(sys, "argv", args), patch.dict(child["_main"].__globals__, os=proxy), patch("unittest.main", side_effect=SystemExit(7)):
                with self.assertRaises(SystemExit) as caught:
                    child["_main"]()
            self.assertEqual(caught.exception.code, 7)
            self.assertEqual(hits, [write_fd])
            self.assertEqual(json.loads(os.read(read_fd, 4096))["status"], "available")
        finally:
            sys.path[:] = old_path
            real_close(read_fd)

    def test_observer_identity_read_has_cooperative_deadline(self):
        actual_read = validation._read_scoped_working_file
        observations = []
        def observe(root, relative, **kwargs):
            deadline = kwargs.get("deadline_monotonic")
            observations.append(deadline)
            self.assertIsInstance(deadline, float)
            self.assertLessEqual(deadline - validation.time.monotonic(), 0.250)
            # Ordinary exhaustion before this optional metadata read, not a slow test.
            from aria_kernel import snapshot
            with patch.object(snapshot, "_time", SimpleNamespace(monotonic=lambda: deadline + 0.001)):
                return actual_read(root, relative, **kwargs)
        with patch.object(validation, "_read_scoped_working_file", observe):
            row, log = self._environment_run()
        self.assertEqual(len(observations), 1)
        self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
        self.assertIn("Ran 1 test", log)
        env = self._manifest(row)["environment"]
        self.assertIsNone(env["stable"]["observer_source_hash"])
        self.assertEqual(env["work"]["observer_bytes"], 0)

    def test_cached_import_and_post_run_source_are_distinct(self):
        replacement = "def canonical_path(value):\n    return 'CHANGED_ON_DISK'\n"
        source = self.contents["test_paths.py"] + (
            "        from pathlib import Path\n        import path_helper\n"
            "        Path('path_helper.py').write_text(" + repr(replacement) + ")\n"
            "        self.assertEqual(path_helper.canonical_path('./still-cached'), 'still-cached')\n"
            "        print('CACHED_ORIGINAL_BEHAVIOR')\n"
        )
        (self.root / "test_paths.py").write_text(source)
        self._commit_revision()
        row, log = self._environment_run()
        self.assertEqual(row["exit_code"], 0)
        self.assertIn("CACHED_ORIGINAL_BEHAVIOR", log)
        self.assertEqual(row["input_binding"]["source_stability"], "changed")
        manifest = self._manifest(row)
        expected_before = "sha256:" + hashlib.sha256(self.contents["path_helper.py"].encode()).hexdigest()
        expected_after = "sha256:" + hashlib.sha256(replacement.encode()).hexdigest()
        for phase, expected_hash in (("before", expected_before), ("after", expected_after)):
            self.assertEqual(next(item["content_hash"] for item in manifest[phase]["files"] if item["path"] == "path_helper.py"), expected_hash)
        module = manifest["environment"]["stable"]["modules"]["path_helper"]
        self.assertEqual(module["origin_file_observation"]["content_hash"], "sha256:" + hashlib.sha256(replacement.encode()).hexdigest())
        self.assertEqual(module["executed_content_binding"], {"status": "unknown", "reason": "loaded_bytes_not_observed"})
        self.assertEqual(module["origin_file_observation"]["phase"], "post_run")

    def test_unloaded_module_and_small_receipt_remain_unknown(self):
        (self.root / "ordinary_module_never_loaded.py").write_text("VALUE = 17\n")
        self._commit_revision()
        row, log = self._environment_run(modules=["json", "ordinary_module_never_loaded"])
        self.assertEqual(row["exit_code"], 0)
        missing = self._manifest(row)["environment"]["stable"]["modules"]["ordinary_module_never_loaded"]
        self.assertEqual(missing["reason"], "module_not_present_post_run")
        proxy = SimpleNamespace(environ=os.environ, pipe=os.pipe, set_blocking=os.set_blocking,
                                fpathconf=lambda fd, name: 240, close=os.close, read=os.read)
        with patch.object(validation, "os", proxy):
            row, log = self._environment_run()
        self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
        self.assertIn("Ran 1 test", log)
        env = self._manifest(row)["environment"]
        self.assertEqual(env["observation"]["reason"], "receipt_byte_limit")
        self.assertIsNone(env["stable"]["interpreter"])

    def test_missing_receipt_charges_reserved_reads_and_retains_result(self):
        hits = []
        def unavailable(fd, count):
            hits.append(count)
            raise OSError("ordinary optional read failure")
        proxy = SimpleNamespace(environ=os.environ, pipe=os.pipe, set_blocking=os.set_blocking,
                                fpathconf=os.fpathconf, close=os.close, read=unavailable)
        with patch.object(validation, "os", proxy):
            row, log = self._environment_run()
        self.assertEqual(hits, [4096])
        self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
        self.assertIn("Ran 1 test", log)
        manifest = self._manifest(row)
        work = manifest["environment"]["work"]
        self.assertEqual(work["child_charged_bytes"], 4 * 1024 * 1024)
        self.assertIsNone(work["child_actual_bytes"])
        self.assertLessEqual(sum(manifest[k]["bytes_read"] for k in ("before", "after")) + work["observer_bytes"] + work["child_charged_bytes"], 16 * 1024 * 1024)

    def test_actual_timeout_preserves_output_and_reaps_observer(self):
        source = self.contents["test_paths.py"] + (
            "        import os, threading\n        print('TIMEOUT_CHILD:' + str(os.getpid()), flush=True)\n"
            "        threading.Event().wait(30)\n"
        )
        (self.root / "test_paths.py").write_text(source)
        self._commit_revision()
        row, log = self._environment_run(timeout_ms=1000)
        self.assertEqual((row["exit_code"], row["timed_out"]), (None, True))
        pid = int(next(line.split(":", 1)[1] for line in log.splitlines() if line.startswith("TIMEOUT_CHILD:")))
        with self.assertRaises(ChildProcessError):
            os.waitpid(pid, os.WNOHANG)
        env = self._manifest(row)["environment"]
        self.assertEqual(env["observation"]["reason"], "receipt_unavailable")
        self.assertEqual(env["work"]["child_charged_bytes"], 4 * 1024 * 1024)

    def test_child_reads_respect_total_budget_with_actual_loaded_modules(self):
        modules = ["extra_a", "extra_b", "extra_c"]
        content = "VALUE = 1\n#" + "x" * (1600 * 1024)
        for name in modules:
            (self.root / (name + ".py")).write_text(content)
        padded_paths = ["scope_" + str(n) + ".py" for n in range(6)]
        for name in padded_paths:
            (self.root / name).write_text(content)
        self.scope["files"]["source"].extend(padded_paths)
        source = self.contents["test_paths.py"] + "        import extra_a, extra_b, extra_c\n        self.assertEqual(extra_a.VALUE + extra_b.VALUE + extra_c.VALUE, 3)\n"
        (self.root / "test_paths.py").write_text(source)
        self._commit_revision()
        with patch.dict(os.environ, {"PYTHONDONTWRITEBYTECODE": "1"}):
            row, log = self._environment_run(modules=modules)
        self.assertEqual(row["exit_code"], 0)
        self.assertIn("Ran 1 test", log)
        manifest = self._manifest(row)
        env = manifest["environment"]
        facts = env["stable"]["modules"]
        self.assertEqual(facts["extra_a"]["origin_file_observation"]["content_hash"], "sha256:" + hashlib.sha256(content.encode()).hexdigest())
        self.assertEqual(facts["extra_b"]["origin_file_observation"]["status"], "available")
        self.assertEqual(facts["extra_c"]["origin_file_observation"]["reason"], "input_total_byte_limit")
        work = env["work"]
        self.assertEqual(work["child_actual_bytes"], 2 * len(content.encode()))
        self.assertLessEqual(work["child_content_paths"], 16)
        known_sizes = {name: len((self.root / name).read_bytes()) for group in self.scope["files"].values() for name in group}
        self.assertEqual(len(manifest["before"]["files"]), 10)
        self.assertTrue(all(item["status"] == "available" for item in manifest["before"]["files"]))
        after_available = [item["path"] for item in manifest["after"]["files"] if item["status"] == "available"]
        after_unknown = [item for item in manifest["after"]["files"] if item["status"] == "unknown"]
        self.assertEqual(len(after_available), 6)
        self.assertEqual([item["path"] for item in after_unknown], padded_paths[2:])
        self.assertTrue(all(item["reason"] == "input_total_byte_limit" for item in after_unknown))
        before_bytes = sum(known_sizes.values())
        after_bytes = sum(known_sizes[name] for name in after_available)
        observer_bytes = len(Path(validation.__file__).with_name("_validation_unittest_child.py").read_bytes())
        self.assertEqual((manifest["before"]["bytes_read"], manifest["after"]["bytes_read"], work["observer_bytes"]), (before_bytes, after_bytes, observer_bytes))
        independent_total = before_bytes + after_bytes + observer_bytes + 2 * len(content.encode())
        self.assertLessEqual(independent_total, 16 * 1024 * 1024)
        self.assertGreater(independent_total + len(content.encode()), 16 * 1024 * 1024)
        self.assertEqual(row["input_binding"]["source_stability"], "unknown")

    def test_successful_longer_test_does_not_spend_active_observation_budget(self):
        source = self.contents["test_paths.py"] + (
            "        import time\n        started = time.monotonic()\n        time.sleep(0.35)\n"
            "        elapsed = time.monotonic() - started\n        self.assertGreaterEqual(elapsed, 0.30)\n"
            "        print('REAL_TEST_SECONDS:' + str(elapsed))\n"
        )
        (self.root / "test_paths.py").write_text(source)
        self._commit_revision()
        row, log = self._environment_run()
        self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
        self.assertGreater(float(next(line.split(":", 1)[1] for line in log.splitlines() if line.startswith("REAL_TEST_SECONDS:"))), 0.25)
        env = self._manifest(row)["environment"]
        self.assertEqual(env["stable"]["availability"]["interpreter"], "observed_same_child")
        self.assertIsInstance(env["stable"]["interpreter"], dict)

    def test_post_hash_observer_expiry_retains_reads_without_new_allowance(self):
        from aria_kernel import snapshot
        real_read, real_hash = validation._read_scoped_working_file, snapshot._sha256
        hits = []
        def observe(root, relative, **kwargs):
            deadline = kwargs["deadline_monotonic"]
            now = [deadline - 0.010]
            def digest(data):
                result = real_hash(data)
                hits.append(len(data))
                now[0] = deadline + 0.001
                return result
            with patch.object(snapshot, "_time", SimpleNamespace(monotonic=lambda: now[0])), patch.object(snapshot, "_sha256", digest):
                return real_read(root, relative, **kwargs)
        with patch.object(validation, "_read_scoped_working_file", observe):
            row, log = self._environment_run()
        self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
        self.assertIn("Ran 1 test", log)
        size = len(Path(validation.__file__).with_name("_validation_unittest_child.py").read_bytes())
        self.assertEqual(hits, [size])
        env = self._manifest(row)["environment"]
        self.assertEqual(env["work"]["observer_bytes"], size)
        self.assertIsNone(env["stable"]["observer_source_hash"])
        self.assertEqual(env["work"]["child_budget_ms"], 0)
        self.assertEqual(env["work"]["child_actual_bytes"], 0)
        self.assertEqual(env["observation"]["reason"], "observation_deadline")

    def test_parent_receipt_and_final_manifest_share_active_deadline(self):
        for phase in ("receipt", "manifest"):
            with self.subTest(phase=phase):
                elapsed, hits = [0.0], []
                real_clock = validation.time.monotonic
                real_receipt, real_json = validation._read_unittest_receipt, validation._canonical_input_json
                def receive(*args, **kwargs):
                    receipt = real_receipt(*args, **kwargs)
                    self.assertEqual(receipt["status"], "available")
                    if phase == "receipt":
                        elapsed[0] += 1.0
                        hits.append(phase)
                    return receipt
                def encode(value):
                    data = real_json(value)
                    if phase == "manifest" and isinstance(value, dict) and value.get("profile_kind") and value.get("interpreter") is not None and not hits:
                        elapsed[0] += 1.0
                        hits.append(phase)
                    return data
                with patch.object(validation, "time", SimpleNamespace(monotonic=lambda: real_clock() + elapsed[0])), patch.object(validation, "_read_unittest_receipt", receive), patch.object(validation, "_canonical_input_json", encode):
                    row, log = self._environment_run()
                self.assertEqual(hits, [phase])
                self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
                self.assertIn("Ran 1 test", log)
                env = self._manifest(row)["environment"]
                self.assertIsNone(env["stable"]["interpreter"])
                self.assertEqual(env["observation"]["reason"], "observation_deadline")
                expected_digest = "sha256:" + hashlib.sha256(json.dumps(env["stable"], sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
                self.assertEqual(row["input_binding"]["runner_environment_digest"], expected_digest)

    def _commit_revision(self) -> None:
        _git(self.root, ["add", "."])
        changed = _git(self.root, ["diff", "--cached", "--name-only"]).splitlines()
        planned = emit_change_planned(
            plan_id="plan-revision-" + self.commit_sha, finding_id="F-scoped-paths",
            intended_affected_files=changed, intended_validation_refs=[self.command],
            architectural_tier=1, base_dir=self.base,
        )
        _git(self.root, ["commit", "-q", "-m", "ordinary input revision"])
        self.commit_sha = _git(self.root, ["rev-parse", "HEAD"])
        self.change_id = planned["change_id"]
        emit_change_committed(change_id=self.change_id, commit_sha=self.commit_sha,
                              actual_affected_files=changed, base_dir=self.base)

    def test_later_source_test_and_config_revisions_preserve_original_proof(self) -> None:
        first = self._execute()
        original_log = Path(first["log_path"]).read_bytes()
        original_binding = first["input_binding"]
        for name in ("paths.py", "test_paths.py"):
            with (self.root / name).open("a") as stream:
                stream.write("\n# ordinary revised input\n")
        (self.root / "path-config.json").write_text('{"case_sensitive": true, "revision": 2}\n')
        self._commit_revision()
        later = self._execute()
        self.assertNotEqual(later["input_binding"]["base_commit_sha"], original_binding["base_commit_sha"])
        for dimension in ("source", "test_content", "config"):
            self.assertNotEqual(later["input_binding"][dimension + "_digest"], original_binding[dimension + "_digest"])
        self.assertEqual(later["input_binding"]["source_stability"], "unchanged")
        self.assertEqual(verify_validation_run(first["validation_run_id"], base_dir=self.base), first)
        self.assertEqual(Path(first["log_path"]).read_bytes(), original_log)

    def test_dynamic_unittest_selection_remains_unknown(self) -> None:
        self.command = "python3 -m unittest discover -v"
        row = self._execute()
        self.assertIsNone(row["input_binding"]["test_selection_digest"])
        self.assertEqual(row["input_binding"]["availability"]["test_selection"],
                         {"status": "unknown", "reason": "dynamic_selection_uncaptured"})
        self.assertEqual(row["input_binding"]["availability"]["source"]["status"], "available")

    def test_missing_and_unreadable_optional_inputs_do_not_erase_execution(self) -> None:
        self.scope["files"]["config"].append("optional-config.json")
        real_open = Path.open

        def unavailable(path, *args, **kwargs):
            if path == self.root / "path_helper.py" and args and args[0] == "rb":
                raise OSError("ordinary optional input unavailable")
            return real_open(path, *args, **kwargs)

        with patch.object(Path, "open", unavailable):
            row = self._execute()
        binding = row["input_binding"]
        self.assertEqual(binding["source_stability"], "unknown")
        self.assertEqual(binding["availability"]["source"]["status"], "available")
        self.assertIsNone(binding["config_digest"])
        self.assertIsNone(binding["dependency_digest"])
        for when in ("before", "after"):
            files = {item["path"]: item for item in self._manifest(row)[when]["files"]}
            self.assertEqual(files["optional-config.json"]["reason"], "input_missing")
            self.assertEqual(files["path_helper.py"]["reason"], "input_unreadable")

    def test_capture_byte_limits_apply_before_file_consumption(self) -> None:
        for index in range(9):
            name = f"declared-{index}.txt"
            (self.root / name).write_bytes(b"x" * (2 * 1024 * 1024))
            self.scope["files"]["dependency"].append(name)
        (self.root / "oversized.txt").write_bytes(b"x" * (2 * 1024 * 1024 + 1))
        self.scope["files"]["dependency"].append("oversized.txt")
        self._commit_revision()
        observed_reads = []
        real_open = Path.open

        class CountedRead:
            def __init__(self, path, stream):
                self.path, self.stream = path, stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def fileno(self):
                return self.stream.fileno()
            def read(self, size=-1):
                self_test.assertGreaterEqual(size, 0)
                self_test.assertLessEqual(size, 2 * 1024 * 1024)
                data = self.stream.read(size)
                observed_reads.append((self.path.name, len(data)))
                return data

        self_test = self
        def counted(path, *args, **kwargs):
            stream = real_open(path, *args, **kwargs)
            if path.parent == self.root and args and args[0] == "rb":
                self.assertEqual(kwargs.get("buffering"), 0)
                return CountedRead(path, stream)
            return stream

        with patch.object(Path, "open", counted):
            row = self._execute()
        manifest = self._manifest(row)
        self.assertLessEqual(sum(size for _, size in observed_reads), 16 * 1024 * 1024)
        self.assertNotIn("oversized.txt", [name for name, _ in observed_reads])
        self.assertEqual(sum(size for _, size in observed_reads),
                         manifest["before"]["bytes_read"] + manifest["after"]["bytes_read"])
        self.assertEqual(row["input_binding"]["source_stability"], "unknown")
        reasons = {item.get("reason") for when in ("before", "after") for item in manifest[when]["files"]}
        self.assertIn("input_file_byte_limit", reasons)
        self.assertIn("input_total_byte_limit", reasons)

    def test_actual_command_working_edit_is_observed_as_changed(self) -> None:
        with (self.root / "test_paths.py").open("a") as stream:
            stream.write("        from pathlib import Path\n"
                         "        with Path('path_helper.py').open('a') as output:\n"
                         "            output.write('\\n# ordinary command output\\n')\n")
        self._commit_revision()
        row = self._execute(leaves_working_edit=True)
        self.assertEqual(row["input_binding"]["source_stability"], "changed")
        manifest = self._manifest(row)
        before = next(item for item in manifest["before"]["files"] if item["path"] == "path_helper.py")
        after = next(item for item in manifest["after"]["files"] if item["path"] == "path_helper.py")
        self.assertNotEqual(before["content_hash"], after["content_hash"])
        self.assertEqual(before["content_hash"], "sha256:" + hashlib.sha256(self.contents["path_helper.py"].encode()).hexdigest())
        self.assertEqual(row["status"], "ok")

    def test_scoped_writer_requires_the_declared_log_surface(self) -> None:
        original = self._execute()
        ordinary_log = self.base / "validation" / "logs" / "result.txt"
        ordinary_log.write_text("ordinary direct-writer output\n")
        with self.assertRaisesRegex(GovernanceError, "validation_input_binding_requires_declared_log"):
            record_validation_run(
                change_id=self.change_id, cmd=self.command, exit_code=0,
                duration_ms=1, log_path=ordinary_log, commit_sha=self.commit_sha,
                runner_identity="ci-executor:scoped-paths",
                started_at=original["started_at"], completed_at=original["completed_at"],
                base_dir=self.base, input_binding=original["input_binding"],
            )
        self.assertEqual(list_validation_runs_for_change(self.change_id, base_dir=self.base), [original])

    def test_each_command_observes_its_own_before_and_after_inputs(self) -> None:
        with (self.root / "test_paths.py").open("a") as stream:
            stream.write("        from pathlib import Path\n"
                         "        with Path('path_helper.py').open('a') as output:\n"
                         "            output.write('\\n# normal batch output\\n')\n"
                         "    def test_observes_previous_command_output(self):\n"
                         "        from pathlib import Path\n"
                         "        self.assertIn('# normal batch output', Path('path_helper.py').read_text())\n")
        self._commit_revision()
        second = "python3 -m unittest -v test_paths.PathTests.test_observes_previous_command_output"
        plan = run_validation_commands(
            commands=[self.command, second], workspace_root=self.root,
            change_id=self.change_id, commit_sha=self.commit_sha,
            runner_identity="ci-executor:scoped-paths", base_dir=self.base,
            input_scope=self.scope,
        )
        rows = list_validation_runs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual(len(rows), 2)
        self.assertEqual(plan["validation_run_ids"], [row["validation_run_id"] for row in rows])
        self.assertEqual([row["status"] for row in rows], ["ok", "ok"])
        self.assertEqual([row["input_binding"]["source_stability"] for row in rows], ["changed", "unchanged"])
        first_manifest, second_manifest = [self._manifest(row) for row in rows]
        self.assertNotEqual(first_manifest["before"]["files"], first_manifest["after"]["files"])
        self.assertEqual(first_manifest["after"]["files"], second_manifest["before"]["files"])
        self.assertEqual(second_manifest["before"]["files"], second_manifest["after"]["files"])
        for row in rows:
            self.assertEqual(verify_validation_run(row["validation_run_id"], base_dir=self.base), row)
            self.assertIn("Ran 1 test", Path(row["log_path"]).read_text())
            self.assertEqual(row["input_binding"]["availability"]["base_commit_sha"]["reason"], "workspace_head_at_batch_admission")

    def test_missing_repository_identity_observation_stays_unknown(self) -> None:
        # Ordinary metadata unavailability, after genuine fixture binding/admission.
        with patch("aria_kernel.workspace._git_root_commit_sha", return_value=""):
            row = self._execute()
        self.assertIsNone(row["input_binding"]["repo_identity"])
        self.assertEqual(row["input_binding"]["availability"]["repo_identity"]["status"], "unknown")
        self.assertEqual(row["input_binding"]["source_stability"], "unchanged")

    def test_binding_shape_is_checked_before_ledger_serialization(self) -> None:
        original = self._execute()
        descriptor = dict(original["input_binding"])
        descriptor["availability"] = []
        with self.assertRaisesRegex(GovernanceError, "validation_input_binding_invalid"):
            record_validation_run(
                change_id=self.change_id, cmd=self.command, exit_code=0,
                duration_ms=1, log_path=original["log_path"], commit_sha=self.commit_sha,
                runner_identity="ci-executor:scoped-paths",
                started_at=original["started_at"], completed_at=original["completed_at"],
                base_dir=self.base, input_binding=descriptor,
            )
        self.assertEqual(list_validation_runs_for_change(self.change_id, base_dir=self.base), [original])

    def test_binding_scalar_and_availability_contracts(self) -> None:
        original = self._execute()
        cases = {
            "repository_spelling": {"repo_identity": "not-a-canonical-id"},
            "commit_spelling": {"base_commit_sha": "abcd"},
            "snapshot_spelling": {"repo_state_id": "repo-state:short"},
            "timestamp_spelling": {"capture_started_at": "yesterday"},
            "missing_dimension": {"availability": {key: value for key, value in original["input_binding"]["availability"].items() if key != "source"}},
            "available_null": {"source_digest": None},
            "explicit_paths": {"scope_paths": ["tests/*.py"]},
            "path_count": {"scope_paths": [f"file-{index:03d}.py" for index in range(257)]},
        }
        for name, updates in cases.items():
            with self.subTest(contract=name):
                descriptor = {**original["input_binding"], **updates}
                with self.assertRaisesRegex(GovernanceError, "validation_input_binding_invalid"):
                    record_validation_run(
                        change_id=self.change_id, cmd=self.command, exit_code=0,
                        duration_ms=1, log_path=original["log_path"], commit_sha=self.commit_sha,
                        runner_identity="ci-executor:scoped-paths",
                        started_at=original["started_at"], completed_at=original["completed_at"],
                        base_dir=self.base, input_binding=descriptor,
                    )

    def test_optional_path_resolution_error_preserves_the_real_run(self) -> None:
        real_resolve = Path.resolve
        seen = []
        def unavailable(path, *args, **kwargs):
            if path == self.root / "path_helper.py":
                seen.append(path)
                raise RuntimeError("ordinary path resolution unavailable")
            return real_resolve(path, *args, **kwargs)
        with patch.object(Path, "resolve", unavailable):
            row = self._execute()
        self.assertEqual(len(seen), 2)
        self.assertIsNone(row["input_binding"]["dependency_digest"])
        self.assertEqual(row["input_binding"]["source_stability"], "unknown")


class SpawnEnvironmentTests(unittest.TestCase):
    """ARIA-MEDIUM-066 — the child's environment is built at the spawn seam.

    The runner job carries the durable store's bindings and its credentials;
    the child used to inherit all of it. The probe below is the failure the
    finding names, made executable: a fixture test that, when it can see
    ``ARIA_TOOLS_DIR``, writes fixture state into the store.
    """

    _PROBE_NAMES = (
        "PATH", "HOME", "PYTHONPATH", "ARIA_TOOLS_DIR", "ARIA_WORKSPACE_BASE", "ARIA_REPO_STATE_ROOT",
        "ARIA_STATE_STORE_ROOT", "ARIA_JOB_DEADLINE_EPOCH", "GH_TOKEN", "PROBE_SECRET_TOKEN",
        "GIT_CONFIG_VALUE_0", "GIT_DIR", "PROBE_PLAIN",
    )

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        self.base = Path(self.tmp.name) / "aria-tools"
        # What the finding's leak would land in: a store that must stay empty.
        self.fake_store = Path(self.tmp.name) / "durable-store"
        self.fake_store.mkdir()
        # A module only reachable through the recipe-declared PYTHONPATH.
        self.declared_lib = Path(self.tmp.name) / "declared-lib"
        self.declared_lib.mkdir()
        (self.declared_lib / "declared_helper.py").write_text("DECLARED = 'reached'\n", encoding="utf-8")
        (self.root / "test_env_probe.py").write_text(
            "import json, os, unittest\n"
            "NAMES = " + repr(self._PROBE_NAMES) + "\n"
            "class EnvProbe(unittest.TestCase):\n"
            "    def test_probe(self):\n"
            "        tools = os.environ.get('ARIA_TOOLS_DIR')\n"
            "        if tools:\n"
            "            open(os.path.join(tools, 'fixture-state-landed-here'), 'w').close()\n"
            "        import declared_helper\n"
            "        print('ENV_PROBE:' + json.dumps({\n"
            "            'present': {name: name in os.environ for name in NAMES},\n"
            "            'declared': declared_helper.DECLARED,\n"
            "            'leaked_values': sorted(v for v in os.environ.values() if 'LEAKVALUE' in v)}))\n",
            encoding="utf-8",
        )
        _git(self.root, ["init", "-q"])
        _git(self.root, ["config", "user.email", "aria@example.invalid"])
        _git(self.root, ["config", "user.name", "ARIA"])
        _git(self.root, ["add", "."])
        _git(self.root, ["commit", "-q", "-m", "env probe"])
        self.commit_sha = _git(self.root, ["rev-parse", "HEAD"])
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        self.command = f"PYTHONPATH={self.declared_lib} python3 -m unittest -v test_env_probe"
        planned = emit_change_planned(
            plan_id="plan-spawn-env", finding_id="F-spawn-env", intended_affected_files=["test_env_probe.py"],
            intended_validation_refs=[self.command], architectural_tier=1, base_dir=self.base,
        )
        self.change_id = planned["change_id"]
        emit_change_committed(change_id=self.change_id, commit_sha=self.commit_sha,
                              actual_affected_files=["test_env_probe.py"], base_dir=self.base)

    def test_store_bindings_and_secrets_stay_in_the_runner_and_the_row_names_the_decision(self) -> None:
        runner_env = {
            "ARIA_TOOLS_DIR": str(self.fake_store), "ARIA_WORKSPACE_BASE": str(self.fake_store / "workspace"),
            "ARIA_REPO_STATE_ROOT": str(self.fake_store / "findings"), "ARIA_STATE_STORE_ROOT": str(self.fake_store),
            "ARIA_JOB_DEADLINE_EPOCH": "4102444800",
            "GH_TOKEN": "ghp_LEAKVALUE01", "PROBE_SECRET_TOKEN": "LEAKVALUE02",
            "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic LEAKVALUE03", "GIT_DIR": str(self.root / ".git"),
            "PROBE_PLAIN": "LEAKVALUE04",
        }
        with patch.dict(os.environ, runner_env):
            plan = run_validation_commands(
                commands=[self.command], workspace_root=self.root, change_id=self.change_id,
                commit_sha=self.commit_sha, runner_identity="ci-executor:spawn-env",
                change_author_identity="agent:spawn-env-planner", base_dir=self.base, cycle_id="cycle-spawn-env",
            )
        self.assertEqual(plan["status"], "ok")
        row = list_validation_runs_for_change(self.change_id, base_dir=self.base)[-1]
        self.assertEqual((row["exit_code"], row["timed_out"]), (0, False))
        log = Path(row["log_path"]).read_text(encoding="utf-8")
        probe = json.loads(next(line.removeprefix("ENV_PROBE:") for line in log.splitlines() if line.startswith("ENV_PROBE:")))
        # The store bindings, the job deadline, the credentials and the hook's
        # GIT_DIR never reached the child; the plumbing and the declaration did.
        self.assertEqual(probe["present"], {
            "PATH": True, "HOME": True, "PYTHONPATH": True,
            "ARIA_TOOLS_DIR": False, "ARIA_WORKSPACE_BASE": False, "ARIA_REPO_STATE_ROOT": False,
            "ARIA_STATE_STORE_ROOT": False, "ARIA_JOB_DEADLINE_EPOCH": False, "GH_TOKEN": False,
            "PROBE_SECRET_TOKEN": False, "GIT_CONFIG_VALUE_0": False, "GIT_DIR": False, "PROBE_PLAIN": False,
        })
        self.assertEqual(probe["declared"], "reached")
        self.assertEqual(probe["leaked_values"], [])
        # The finding's failure mode: fixture state landing in the store.
        self.assertEqual(sorted(path.name for path in self.fake_store.iterdir()), [])
        # The row says what the child saw — names only, and it is hash-bound
        # with the rest of the row.
        environment = row["spawn_environment"]
        self.assertEqual(environment["schema_version"], 1)
        self.assertEqual(environment["declared"], ["PYTHONPATH"])
        self.assertEqual(environment["dropped_store_bindings"],
                         ["ARIA_REPO_STATE_ROOT", "ARIA_STATE_STORE_ROOT", "ARIA_TOOLS_DIR", "ARIA_WORKSPACE_BASE"])
        self.assertTrue({"GH_TOKEN", "PROBE_SECRET_TOKEN"} <= set(environment["dropped_secret_shaped"]))
        self.assertTrue({"PATH", "HOME", "PYTHONPATH"} <= set(environment["passed"]))
        self.assertGreaterEqual(environment["dropped_count"], len(runner_env))
        encoded = json.dumps(row)
        self.assertNotIn("LEAKVALUE", encoded)
        self.assertNotIn(str(self.fake_store), encoded)
        self.assertNotIn(str(self.declared_lib), json.dumps(environment))
        self.assertEqual(verify_validation_run(row["validation_run_id"], base_dir=self.base), row)


if __name__ == "__main__":
    unittest.main()
