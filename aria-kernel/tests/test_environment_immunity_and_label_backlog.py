"""E18+E20 (ORPHAN-672) — environment immunity + the visible label backlog.

E18: a 98%-full host turned ledger writes into failures that masqueraded
as test errors and chain corruption (lived 2026-08-13). The kernel had
no disk precondition and its read path reported I/O faults as ledger
invalidity. E20: the seeding corpus grew on every live finding with no
reader — the calibration bottleneck was invisible.
"""
from __future__ import annotations

import errno
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.tool_registry import ensure_tools_dir


class DiskPreconditionTests(unittest.TestCase):
    def _preflight(self, tmp: str, free_gb: float):
        from aria_kernel import preflight

        (Path(tmp) / "node_modules").mkdir(exist_ok=True)
        with mock.patch.object(preflight, "_free_disk_gb", return_value=free_gb):
            with mock.patch.object(preflight, "MIN_FREE_DISK_GB", 5.0):
                return preflight.verify_preflight(
                    workspace_root=tmp, profile="standard"
                )

    def test_low_disk_is_a_named_environment_precondition(self) -> None:
        # Deliberate-break for the original defect: pre-E18 a full disk
        # passed preflight and died downstream as phantom corruption.
        with tempfile.TemporaryDirectory() as tmp:
            verdict = self._preflight(tmp, free_gb=0.4)
        self.assertTrue(
            any(str(r).startswith("disk_low:") for r in verdict.reasons),
            verdict.reasons,
        )
        self.assertIn(
            "environment_preconditions_not_met", list(verdict.failure_classes)
        )

    def test_healthy_disk_adds_no_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            verdict = self._preflight(tmp, free_gb=50.0)
        self.assertFalse(any("disk_low" in str(r) for r in verdict.reasons))

    def test_unprobeable_disk_does_not_fail_preflight(self) -> None:
        # An unmeasurable disk must not block a night — only a MEASURED
        # low disk does.
        with tempfile.TemporaryDirectory() as tmp:
            verdict = self._preflight(tmp, free_gb=None)
        self.assertFalse(any("disk_low" in str(r) for r in verdict.reasons))


class IoErrorClassificationTests(unittest.TestCase):
    def test_verify_jsonl_names_io_error_not_corruption(self) -> None:
        from aria_kernel.ledger import verify_jsonl

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            path.write_text('{"a":1}\n', encoding="utf-8")
            enospc = OSError(errno.ENOSPC, "No space left on device")
            with mock.patch.object(Path, "read_text", side_effect=enospc):
                result = verify_jsonl(path)
        self.assertFalse(result["valid"])
        self.assertEqual(result.get("reason_kind"), "io_error")
        self.assertEqual(result.get("errno"), errno.ENOSPC)

    def test_load_jsonl_verified_message_names_the_environment(self) -> None:
        from aria_kernel.ledger import LedgerIntegrityError, load_jsonl_verified

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            path.write_text('{"a":1}\n', encoding="utf-8")
            enospc = OSError(errno.ENOSPC, "No space left on device")
            with mock.patch.object(Path, "read_text", side_effect=enospc):
                with self.assertRaises(LedgerIntegrityError) as ctx:
                    load_jsonl_verified(path)
        self.assertIn("reason_kind=io_error", str(ctx.exception))


class SeedingBacklogTests(unittest.TestCase):
    def _seed(self, root: Path, tool_id: str, fingerprints: list[str]) -> None:
        from aria_kernel.calibration_bootstrap import record_seeding_finding

        for fp in fingerprints:
            record_seeding_finding(
                tool_id=tool_id,
                finding={
                    "finding_fingerprint": fp,
                    "path": "apps/farm-service/src/x.ts",
                    "message": "m",
                },
                base_dir=root,
            )

    def test_backlog_counts_unlabeled_remainder(self) -> None:
        from aria_kernel.calibration_bootstrap import (
            label_finding,
            list_seeding_backlog,
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self._seed(root, "tool-a", ["fp1", "fp2", "fp3"])
            label_finding(
                tool_id="tool-a",
                finding_fingerprint="fp1",
                label="true_positive",
                severity="HIGH",
                base_dir=root,
            )
            backlog = list_seeding_backlog(base_dir=root)
        self.assertEqual(backlog["tools"]["tool-a"]["seeded"], 3)
        self.assertEqual(backlog["tools"]["tool-a"]["labeled"], 1)
        self.assertEqual(backlog["tools"]["tool-a"]["unlabeled"], 2)
        self.assertEqual(backlog["total_unlabeled"], 2)

    def test_report_section_surfaces_the_backlog_without_samples(self) -> None:
        # Deliberate-break for the original defect: the backlog must show
        # even when the judgment-sample queue is empty — the ledger used
        # to grow with no surface anywhere.
        from aria_kernel.reflection import _render_label_queue_section

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self._seed(root, "tool-b", ["fpA", "fpB"])
            lines = "\n".join(_render_label_queue_section(root))
        self.assertIn("Seeding backlog: 2 unlabeled", lines)
        self.assertIn("tool-b: 2 unlabeled / 2 seeded", lines)

    def test_nothing_waiting_renders_nothing(self) -> None:
        from aria_kernel.reflection import _render_label_queue_section

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self.assertEqual(_render_label_queue_section(root), [])


if __name__ == "__main__":
    unittest.main()
