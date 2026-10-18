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

import ast
import errno
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest.mock import patch

from aria_kernel import ledger as ledger_module
from aria_kernel.ledger import StateTransaction, append_declared_jsonl, state_transaction
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_KERNEL_ROOT = Path(__file__).resolve().parents[1]


class EnospcClassificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_enospc_append_names_the_environment(self) -> None:
        full_disk = OSError(errno.ENOSPC, "No space left on device")
        with patch("aria_kernel.ledger._append_jsonl_locked_body", side_effect=full_disk):
            with self.assertRaisesRegex(GovernanceError, "environment_failure:disk_full"):
                append_declared_jsonl(
                    self.tools / "governance.jsonl",
                    {"schema_version": 1, "kind": "test"},
                    expected_surface="tools_governance",
                )

    def test_other_oserrors_still_surface_as_themselves(self) -> None:
        perm = OSError(errno.EACCES, "Permission denied")
        with patch("aria_kernel.ledger._append_jsonl_locked_body", side_effect=perm):
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


class EveryTransactionAppendNamesAFullDisk(unittest.TestCase):
    """ARIA-MEDIUM-111 — the transaction API names a full disk like the module API.

    About thirty governed append sites (notify's outbox, tool_registry,
    agent_invocations, worker_dispatch, ...) append through a
    ``state_transaction`` object, and the ENOSPC translation lived only in
    the module-level wrappers around it: a full disk inside a transaction
    surfaced as a raw ``OSError`` instead of ``environment_failure:disk_full``.
    The fault is injected where a full disk really bites — the write — and
    every append method the transaction exposes is exercised.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.governance = self.tools / "governance.jsonl"
        self.raw = Path(self.tmp.name) / "raw.jsonl"
        self.requests = self.tools / "agent-invocations" / "requests.jsonl"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _appends(self) -> dict[str, tuple[Path, Callable[[StateTransaction], Any]]]:
        row = {"schema_version": 1, "kind": "test"}
        request = {"schema_version": 1, "row_type": "request", "row_id": "request:000001",
                   "request_id": "AIR-000001", "role": "judge"}
        return {
            "append_jsonl": (self.raw, lambda txn: txn.append_jsonl(self.raw, row)),
            "append_declared_jsonl": (self.governance, lambda txn: txn.append_declared_jsonl(
                self.governance, row, expected_surface="tools_governance")),
            "append_declared_jsonl_rows": (self.governance, lambda txn: txn.append_declared_jsonl_rows(
                self.governance, [row, row], expected_surface="tools_governance")),
            "append_segment_rows": (self.requests, lambda txn: txn.append_segment_rows(
                self.tools, [request], expected_surface="agent_invocation_requests", bypass_profile_gate=True)),
        }

    def test_every_append_method_is_exercised(self) -> None:
        methods = {name for name in vars(StateTransaction) if name.startswith("append")}
        self.assertEqual(methods, set(self._appends()), "a new transaction append method needs a case here")

    def test_enospc_at_the_write_names_the_environment(self) -> None:
        full_disk = OSError(errno.ENOSPC, "No space left on device")
        for name, (path, append) in self._appends().items():
            with self.subTest(method=name):
                with patch.object(ledger_module.os, "write", side_effect=full_disk):
                    with self.assertRaisesRegex(GovernanceError, "environment_failure:disk_full"):
                        with state_transaction([path]) as txn:
                            append(txn)

    def test_enospc_taking_the_locks_names_the_environment(self) -> None:
        full_disk = OSError(errno.ENOSPC, "No space left on device")
        with patch.object(ledger_module, "with_exclusive_lock", side_effect=full_disk):
            with self.assertRaisesRegex(GovernanceError, "environment_failure:disk_full"):
                with state_transaction([self.governance]):
                    self.fail("the body ran without its locks")

    def test_other_oserrors_inside_a_transaction_surface_as_themselves(self) -> None:
        denied = OSError(errno.EACCES, "Permission denied")
        for name, (path, append) in self._appends().items():
            with self.subTest(method=name):
                with patch.object(ledger_module.os, "write", side_effect=denied):
                    with self.assertRaises(OSError) as ctx:
                        with state_transaction([path]) as txn:
                            append(txn)
                self.assertEqual(ctx.exception.errno, errno.EACCES)
                self.assertNotIsInstance(ctx.exception, GovernanceError)

    def test_a_transaction_object_exists_only_inside_state_transaction(self) -> None:
        """Every transaction append runs inside the translating scope.

        ``StateTransaction`` is a public dataclass; one constructed anywhere
        but ``ledger.state_transaction`` would hand out the append methods
        without the locks and without the ENOSPC translation.
        """
        sites: list[str] = []
        for root in (_KERNEL_ROOT / "aria_kernel", _KERNEL_ROOT.parent / "tools" / "aria-poc"):
            for path in sorted(root.rglob("*.py")):
                tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
                for function in ast.walk(tree):
                    if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    for node in ast.walk(function):
                        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "StateTransaction":
                            sites.append(f"{path.relative_to(_KERNEL_ROOT.parent).as_posix()}:{function.name}")
        self.assertEqual(sites, ["aria-kernel/aria_kernel/ledger.py:state_transaction"])


class HandEvidenceRemovalTests(unittest.TestCase):
    def test_cli_no_longer_accepts_hand_written_refs(self) -> None:
        from aria_kernel import cli as cli_module
        import inspect

        source = inspect.getsource(cli_module)
        self.assertNotIn("validation-run-ref-json", source)
        self.assertNotIn("validation_run_ref_json", source)
        # and the ledger IS the ref source in the dispatch: the CLI reads
        # refs_for_change (ARIA-HIGH-196), whose one input is the ledger's
        # own per-change listing — narrowed to the committed tip's runs
        # (ARIA-MEDIUM-231), still read from the ledger and nothing else.
        from aria_kernel import validation_runs_ledger

        self.assertIn("refs_for_change(", source)
        self.assertIn(
            "list_validation_runs_at_committed_tip(",
            inspect.getsource(validation_runs_ledger.refs_for_change),
        )
        self.assertIn(
            "list_validation_runs_for_change(",
            inspect.getsource(validation_runs_ledger.list_validation_runs_at_committed_tip),
        )


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
