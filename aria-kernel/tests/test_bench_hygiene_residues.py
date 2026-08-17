"""ORPHAN-696 — the bench's residual seams, closed and pinned.

  * E18-b: a mid-run ENOSPC on a governed APPEND names itself as an
    environment failure instead of dying as an anonymous phase crash
  * hand-written matrix evidence: the CLI flag is GONE; refs derive
    from the validation-runs ledger (only `ok` rows qualify)
  * (measured verdict, no code) retention cannot reach validation logs —
    they live on their own declared artifact surface outside the
    runtime-artifact index retention prunes
"""
from __future__ import annotations

import errno
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class EnospcClassificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_enospc_append_names_the_environment(self) -> None:
        full_disk = OSError(errno.ENOSPC, "No space left on device")
        with patch("aria_kernel.ledger._append_jsonl_unlocked", side_effect=full_disk):
            with self.assertRaisesRegex(GovernanceError, "environment_failure:disk_full"):
                append_declared_jsonl(
                    self.tools / "governance.jsonl",
                    {"schema_version": 1, "kind": "test"},
                    expected_surface="tools_governance",
                )

    def test_other_oserrors_still_surface_as_themselves(self) -> None:
        perm = OSError(errno.EACCES, "Permission denied")
        with patch("aria_kernel.ledger._append_jsonl_unlocked", side_effect=perm):
            with self.assertRaises(OSError) as ctx:
                append_declared_jsonl(
                    self.tools / "governance.jsonl",
                    {"schema_version": 1, "kind": "test"},
                    expected_surface="tools_governance",
                )
        self.assertEqual(ctx.exception.errno, errno.EACCES)

    def test_disk_full_is_a_reportable_blocked_reason(self) -> None:
        from aria_kernel.report import _BLOCKED_REASON_KINDS

        self.assertIn("environment_failure_disk_full", _BLOCKED_REASON_KINDS)


class HandEvidenceRemovalTests(unittest.TestCase):
    def test_cli_no_longer_accepts_hand_written_refs(self) -> None:
        from aria_kernel import cli as cli_module
        import inspect

        source = inspect.getsource(cli_module)
        self.assertNotIn("validation-run-ref-json", source)
        self.assertNotIn("validation_run_ref_json", source)
        # and the ledger IS the ref source in the dispatch
        self.assertIn("list_validation_runs_for_change", source)


class RetentionCannotReachValidationLogsTests(unittest.TestCase):
    def test_validation_logs_live_outside_the_retention_index(self) -> None:
        # Measured verdict for E21-a residue 2: retention_apply prunes ONLY
        # runtime-artifact-index rows; validation logs are a separate
        # declared artifact surface. Pin the separation so a future refactor
        # cannot silently put gate evidence under the pruner.
        from aria_kernel.state_manifest import iter_surfaces

        surfaces = {s.name: s for s in iter_surfaces()}
        logs = surfaces["validation_run_logs"]
        index = surfaces["runtime_artifact_index"]
        self.assertNotEqual(
            Path(logs.path_pattern).parts[0], Path(index.path_pattern).parts[0],
        )


if __name__ == "__main__":
    unittest.main()
