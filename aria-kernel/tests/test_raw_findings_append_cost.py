"""A run's raw findings cost one chain verification, not one per finding.

Every nightly `aria-auto-cycle` run since 2026-09-21 (runs 179-184) spent its
entire per-cycle budget - 14,959 s on run 184 - and died with
`PhaseDeadlineExceeded`, having printed nothing for four hours.

The tools phase records each adapter run's raw findings one row at a time,
and a declared-ledger append re-verifies the WHOLE hash chain before it
writes: 34,503 row hashes and a full read of the 57.5 MB `raw-findings.jsonl`
the nightly restored from aria/state. Measured on that ledger, 2.39 s per
finding against 53 ms on an empty one. Run 179 was the first run on the
commit that added `lint-rules-adapter`, which emits about 5,575 findings per
run (its commit's own measurement), and doc-staleness adds about 2,679:
roughly 8,250 full-chain verifications, about 5.5 hours, a cycle that cannot
finish inside its budget.

An ACTIVE adapter's emitted findings take the same path twice more - the
findings ledger and the calibration seeding ledger. Neither is a strict
surface, so neither re-hashes its chain, but every append still reads the
whole ledger for its tail hash: they are held to the same rule, one pass of
the append body per ledger per run.

Pinned here: the chain is verified once per run's batch, the batch still
refuses to extend a corrupt chain, and the rows it writes chain exactly as
one-at-a-time appends would.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import ledger
from aria_kernel.calibration_bootstrap import seeding_path
from aria_kernel.feedback_store import (
    append_jsonl_rows,
    feedback_path,
    findings_path,
    raw_findings_path,
    record_findings_for_run,
    record_raw_findings_for_run,
)
from aria_kernel.ledger import (
    LedgerIntegrityError,
    LedgerRowTooLargeError,
    append_declared_jsonl,
    append_declared_jsonl_rows,
    load_declared_jsonl,
    verify_jsonl,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _run(run_id: str = "run-1") -> dict:
    return {"tool_id": "lint-rules-adapter", "run_id": run_id, "cycle_id": "cyc-1", "status": "ok"}


def _findings(count: int, *, prefix: str = "f") -> list[dict]:
    return [
        {"id": f"{prefix}-{index}", "rule": "sonarjs/no-duplicate-string", "path": f"apps/a/{index}.ts",
         "line": index, "evidence": [{"path": f"apps/a/{index}.ts", "line": index}]}
        for index in range(count)
    ]


def _ledgers_appended(body: mock.MagicMock, tools: Path) -> list[str]:
    """Each entry is one pass of the append body: the whole-ledger verify,
    the tail read and the index refresh, paid once per call."""
    root = tools.resolve()
    return sorted(Path(call.args[0]).resolve().relative_to(root).as_posix() for call in body.call_args_list)


class _AllSuppressed(dict):
    def get(self, key: object, default: object = None) -> dict:
        return {"source_type": "human", "verdict": "false_positive"}


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-raw-append-")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        self.path = raw_findings_path(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()


class ARunsFindingsAreOneBatch(_Store):
    def test_the_chain_is_verified_once_per_run_not_once_per_finding(self) -> None:
        record_raw_findings_for_run(_run("run-0"), _findings(5, prefix="seed"), base_dir=self.tools)
        with mock.patch.object(ledger, "verify_jsonl", wraps=ledger.verify_jsonl) as verify, \
                mock.patch.object(ledger, "_append_rows_locked_body", wraps=ledger._append_rows_locked_body) as body:
            record_raw_findings_for_run(_run("run-1"), _findings(40), base_dir=self.tools)
        self.assertEqual(verify.call_count, 1)
        self.assertEqual(_ledgers_appended(body, self.tools), ["raw-findings.jsonl"])
        rows = load_declared_jsonl(self.path, expected_surface="raw_findings")
        self.assertEqual(len(rows), 45)
        self.assertEqual([row["finding_id"] for row in rows[5:]], [f"f-{i}" for i in range(40)])

    def test_the_batch_chains_exactly_as_single_appends_would(self) -> None:
        record_raw_findings_for_run(_run(), _findings(12), base_dir=self.tools)
        self.assertTrue(verify_jsonl(self.path)["valid"])
        rows = load_declared_jsonl(self.path, expected_surface="raw_findings")
        for earlier, later in zip(rows, rows[1:]):
            self.assertEqual(later["previous_ledger_hash"], earlier["ledger_hash"])
        # And a single append afterwards chains onto the batch's tail.
        append_declared_jsonl(self.path, {**rows[-1], "finding_id": "after"}, expected_surface="raw_findings")
        self.assertTrue(verify_jsonl(self.path)["valid"])

    def test_a_batch_refuses_to_extend_a_corrupt_chain_and_writes_nothing(self) -> None:
        record_raw_findings_for_run(_run("run-0"), _findings(3, prefix="seed"), base_dir=self.tools)
        lines = self.path.read_text(encoding="utf-8").splitlines()
        tampered = json.loads(lines[1])
        tampered["finding_id"] = "tampered"
        lines[1] = json.dumps(tampered, sort_keys=True, separators=(",", ":"))
        self.path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        before = self.path.read_bytes()
        with self.assertRaises(LedgerIntegrityError) as refused:
            record_raw_findings_for_run(_run("run-1"), _findings(5), base_dir=self.tools)
        self.assertIn("declared_jsonl_refuses_append_to_corrupt_chain", str(refused.exception))
        self.assertEqual(self.path.read_bytes(), before)

    def test_an_oversized_row_refuses_the_whole_batch_before_any_write(self) -> None:
        before = self.path.read_bytes() if self.path.exists() else b""
        rows = [{"finding_id": "ok"}, {"finding_id": "huge", "blob": "x" * (ledger.LEDGER_ROW_MAX_BYTES + 1)}]
        with self.assertRaises(LedgerRowTooLargeError):
            append_declared_jsonl_rows(self.path, rows, expected_surface="raw_findings")
        self.assertEqual(self.path.read_bytes() if self.path.exists() else b"", before)

    def test_an_empty_batch_writes_nothing(self) -> None:
        self.assertEqual(append_declared_jsonl_rows(self.path, [], expected_surface="raw_findings"), [])
        self.assertFalse(self.path.exists())


class AnActiveAdaptersEmittedFindingsAreOneBatchPerLedger(_Store):
    def test_the_findings_and_seeding_ledgers_are_each_appended_once_per_run(self) -> None:
        record_findings_for_run(_run("run-0"), emitted_findings=_findings(4, prefix="seed"), base_dir=self.tools)
        with mock.patch.object(ledger, "_append_rows_locked_body", wraps=ledger._append_rows_locked_body) as body:
            record_findings_for_run(_run("run-1"), emitted_findings=_findings(30), base_dir=self.tools)
        self.assertEqual(
            _ledgers_appended(body, self.tools),
            ["findings.jsonl", "operator-feedback-seeding/lint-rules-adapter/raw-findings.jsonl"],
        )
        findings = load_declared_jsonl(findings_path(self.tools), expected_surface="findings")
        self.assertEqual([row["finding_id"] for row in findings[4:]], [f"f-{i}" for i in range(30)])
        seeded = load_declared_jsonl(
            seeding_path(self.tools, "lint-rules-adapter"), expected_surface="operator_feedback_seeding",
        )
        self.assertEqual([row["finding"]["id"] for row in seeded[4:]], [f"f-{i}" for i in range(30)])
        self.assertTrue(all(row["finding"]["run_id"] == "run-1" for row in seeded[4:]))

    def test_a_run_whose_findings_are_all_suppressed_seeds_nothing(self) -> None:
        with mock.patch(
            "aria_kernel.feedback_store._confirmed_false_positive_fingerprints",
            return_value=_AllSuppressed(),
        ):
            record_findings_for_run(_run(), emitted_findings=_findings(3), base_dir=self.tools)
        rows = load_declared_jsonl(findings_path(self.tools), expected_surface="findings")
        self.assertEqual({row["status"] for row in rows}, {"suppressed_false_positive"})
        self.assertFalse((self.tools / "operator-feedback-seeding").exists())

    def test_a_signed_or_undeclared_ledger_is_not_batch_written(self) -> None:
        for path in (feedback_path(self.tools), self.tools / "not-a-declared-ledger.jsonl"):
            with self.subTest(path=path.name), self.assertRaises(GovernanceError) as refused:
                append_jsonl_rows(path, [{"finding_id": "x"}])
            self.assertIn("append_jsonl_rows_requires_an_unsigned_declared_surface", str(refused.exception))
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
