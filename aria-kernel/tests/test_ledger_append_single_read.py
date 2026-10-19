"""ARIA-LOW-611 — a declared-ledger append reads its file ONCE under the lock.

The append body is the hot path of every declared ledger. It used to read the
whole file three times while holding the lock: once to verify the chain
(strict surfaces), once more to look for a torn tail, and a third time —
parsing every row again — only to take the last row's ``ledger_hash``. On
``governance.jsonl`` (25.9 MB, 29,056 rows on aria/state) that second parse
was about a third of each append's cost. The tail hash is a by-product of
the verification that already ran on the same bytes under the same lock.

These tests drive the real public append verbs on real declared surfaces
(``raw_findings`` is strict, ``findings`` is not) and count what the body
does to the file: text reads of the ledger, and json parses of its rows.
"""

from __future__ import annotations

import errno
import json
import tempfile
import unittest
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from unittest import mock

from aria_kernel import ledger
from aria_kernel.feedback_store import findings_path, raw_findings_path
from aria_kernel.ledger import (
    LedgerIntegrityError,
    append_declared_jsonl_rows,
    load_declared_jsonl,
    verify_jsonl,
)
from aria_kernel.tool_registry import ensure_tools_dir

TORN = '{"finding_id":"torn","ledger_hash":"sha256:0'  # a crash mid-write: no newline, not JSON
SEED_ROWS = 20


def _rows(count: int, prefix: str) -> list[dict]:
    return [{"finding_id": f"{prefix}-{index}", "rule": "r", "path": f"a/{index}.ts"} for index in range(count)]


class _Ledgers(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-append-single-read-")
        self.addCleanup(tmp.cleanup)
        self.tools = ensure_tools_dir(Path(tmp.name) / "aria-tools")
        self.strict = raw_findings_path(self.tools)
        self.loose = findings_path(self.tools)
        append_declared_jsonl_rows(self.strict, _rows(SEED_ROWS, "seed"), expected_surface="raw_findings")
        append_declared_jsonl_rows(self.loose, _rows(SEED_ROWS, "seed"), expected_surface="findings")

    def _measure(self, path: Path, append: Callable[[], object]) -> tuple[int, Counter[str]]:
        """Text reads of ``path`` and json parses of each of its current rows."""
        target = path.resolve()
        lines = {line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}
        reads: list[Path] = []
        parses: Counter[str] = Counter()
        real_read_text = Path.read_text
        real_loads = json.loads

        def read_text(self: Path, *args: object, **kwargs: object) -> str:
            if self.resolve() == target:
                reads.append(self)
            return real_read_text(self, *args, **kwargs)

        def loads(text: object, *args: object, **kwargs: object) -> object:
            if isinstance(text, str) and text.strip() in lines:
                parses[text.strip()] += 1
            return real_loads(text, *args, **kwargs)

        with mock.patch.object(Path, "read_text", read_text), mock.patch.object(ledger.json, "loads", loads):
            append()
        missing = lines - set(parses)
        self.assertFalse(missing and parses, f"{len(missing)} rows never parsed while others were")
        return len(reads), parses


class AnAppendReadsTheLedgerOnce(_Ledgers):
    def test_a_strict_surface_is_read_once_and_each_row_parsed_once(self) -> None:
        reads, parses = self._measure(
            self.strict,
            lambda: append_declared_jsonl_rows(self.strict, _rows(1, "new"), expected_surface="raw_findings"),
        )

        self.assertEqual(reads, 1)
        self.assertEqual(len(parses), SEED_ROWS)
        self.assertEqual(set(parses.values()), {1}, parses.most_common(3))
        self.assertTrue(verify_jsonl(self.strict)["valid"])

    def test_a_non_strict_surface_is_read_once_and_each_row_parsed_once(self) -> None:
        reads, parses = self._measure(
            self.loose,
            lambda: append_declared_jsonl_rows(self.loose, _rows(1, "new"), expected_surface="findings"),
        )

        self.assertEqual(reads, 1)
        self.assertEqual(len(parses), SEED_ROWS)
        self.assertEqual(set(parses.values()), {1}, parses.most_common(3))


class TheOneReadKeepsEveryVerdict(_Ledgers):
    def _assert_healed_and_chained(self, path: Path, surface: str) -> None:
        before = path.read_bytes()
        tail_hash = json.loads(before.decode("utf-8").splitlines()[-1])["ledger_hash"]
        path.write_bytes(before + TORN.encode("utf-8"))

        append_declared_jsonl_rows(path, _rows(1, "after-crash"), expected_surface=surface)

        after = path.read_bytes()
        # The verified prefix is byte-identical; the torn bytes are gone; the
        # new row chains onto the last COMPLETE row.
        self.assertTrue(after.startswith(before))
        self.assertNotIn(TORN.encode("utf-8"), after)
        appended = [json.loads(line) for line in after[len(before):].decode("utf-8").splitlines()]
        self.assertEqual(len(appended), 1)
        self.assertEqual(appended[0]["previous_ledger_hash"], tail_hash)
        self.assertTrue(verify_jsonl(path)["valid"])
        self.assertNotIn("torn_tail_bytes", verify_jsonl(path))

    def test_a_torn_tail_is_healed_on_a_strict_surface(self) -> None:
        self._assert_healed_and_chained(self.strict, "raw_findings")

    def test_a_torn_tail_is_healed_on_a_non_strict_surface(self) -> None:
        self._assert_healed_and_chained(self.loose, "findings")

    def test_a_corrupt_strict_chain_refuses_before_anything_is_healed_or_written(self) -> None:
        lines = self.strict.read_text(encoding="utf-8").splitlines()
        tampered = json.loads(lines[3])
        tampered["finding_id"] = "tampered"
        lines[3] = json.dumps(tampered, sort_keys=True, separators=(",", ":"))
        self.strict.write_text("\n".join(lines) + "\n" + TORN, encoding="utf-8")
        before = self.strict.read_bytes()

        with self.assertRaises(LedgerIntegrityError) as refused:
            append_declared_jsonl_rows(self.strict, _rows(1, "new"), expected_surface="raw_findings")

        self.assertIn("declared_jsonl_refuses_append_to_corrupt_chain", str(refused.exception))
        self.assertIn("reason=ledger_hash_mismatch", str(refused.exception))
        self.assertEqual(self.strict.read_bytes(), before)

    def test_a_malformed_row_on_a_non_strict_surface_still_refuses(self) -> None:
        text = self.loose.read_text(encoding="utf-8")
        self.loose.write_text(text + "not-json\n", encoding="utf-8")
        before = self.loose.read_bytes()

        with self.assertRaises(LedgerIntegrityError) as refused:
            append_declared_jsonl_rows(self.loose, _rows(1, "new"), expected_surface="findings")

        self.assertIn("Invalid JSONL", str(refused.exception))
        self.assertEqual(self.loose.read_bytes(), before)

    def test_an_unreadable_strict_ledger_refuses_as_a_corrupt_chain(self) -> None:
        target = self.strict.resolve()
        real_read_text = Path.read_text

        def failing_read_text(self: Path, *args: object, **kwargs: object) -> str:
            if self.resolve() == target:
                raise OSError(errno.EIO, "Input/output error")
            return real_read_text(self, *args, **kwargs)

        before = self.strict.read_bytes()
        with mock.patch.object(Path, "read_text", failing_read_text), \
                self.assertRaises(LedgerIntegrityError) as refused:
            append_declared_jsonl_rows(self.strict, _rows(1, "new"), expected_surface="raw_findings")

        self.assertIn("declared_jsonl_refuses_append_to_corrupt_chain", str(refused.exception))
        self.assertIn("Input/output error", str(refused.exception))
        self.assertEqual(self.strict.read_bytes(), before)

    def test_the_appended_rows_are_the_rows_a_reader_sees(self) -> None:
        append_declared_jsonl_rows(self.strict, _rows(3, "new"), expected_surface="raw_findings")

        rows = load_declared_jsonl(self.strict, expected_surface="raw_findings")
        self.assertEqual([row["finding_id"] for row in rows[-3:]], ["new-0", "new-1", "new-2"])
        for earlier, later in zip(rows, rows[1:]):
            self.assertEqual(later["previous_ledger_hash"], earlier["ledger_hash"])


if __name__ == "__main__":
    unittest.main()
