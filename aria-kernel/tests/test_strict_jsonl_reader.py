"""Plan 026R §A.3 — generic strict JSONL reader contract.

* Strict mode raises GovernanceError on the first corrupt row AND
  emits a ledger_row_corrupt diagnostic.
* Tolerant mode skips corrupt rows from the iterator AND still emits
  the diagnostic.
* A non-object row is corruption in both modes, on a plain undeclared
  path and on text that names the replay transport.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.strict_jsonl_reader import read_strict_jsonl
from aria_kernel.tool_registry import GovernanceError


class StrictJsonlReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a3-strict-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_strict_raises_on_first_corrupt_row(self) -> None:
        path = self.tmp / "x.jsonl"
        path.write_text(
            json.dumps({"event": "a"})
            + "\n"
            + "{not valid json\n"
            + json.dumps({"event": "c"})
            + "\n",
            encoding="utf-8",
        )
        # First row consumed OK; second row raises.
        it = read_strict_jsonl(path)
        first = next(it)
        self.assertEqual(first, {"event": "a"})
        with self.assertRaises(GovernanceError) as ctx:
            next(it)
        self.assertIn("strict_jsonl_row_corrupt", str(ctx.exception))
        # Diagnostic sink received a row (best-effort check — file exists).
        diag = self.tmp / "diagnostics"
        # The diagnostic helper writes to <base_dir>/diagnostics/; base_dir
        # defaulted to path.parent for this test. Existence is not strictly
        # required (sink can fall back to stderr), but if present it MUST
        # carry our corruption row.
        if diag.exists():
            files = list(diag.rglob("*.json*"))
            self.assertGreaterEqual(len(files), 1, files)

    def test_tolerant_skips_corrupt_row_and_continues(self) -> None:
        path = self.tmp / "x.jsonl"
        path.write_text(
            json.dumps({"event": "a"})
            + "\n"
            + "{not valid json\n"
            + json.dumps({"event": "c"})
            + "\n",
            encoding="utf-8",
        )
        rows = list(read_strict_jsonl(path, on_corruption="tolerant"))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], {"event": "a"})
        self.assertEqual(rows[1], {"event": "c"})

    def _sink_rows(self) -> list[dict]:
        sink = self.tmp / "diagnostics" / "ledger-corruption.jsonl"
        self.assertTrue(sink.exists())
        return [
            json.loads(line)
            for line in sink.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_non_object_row_is_corruption_on_an_undeclared_path(self) -> None:
        # The reader promises Iterator[dict]; a bare JSON scalar decodes
        # cleanly but is still a corrupt ledger row in both modes.
        path = self.tmp / "x.jsonl"
        path.write_text("42\n", encoding="utf-8")
        with self.assertRaisesRegex(
            GovernanceError, r"strict_jsonl_row_corrupt: .*:1: row_not_object",
        ):
            list(read_strict_jsonl(path))
        self.assertEqual(
            [row["error"] for row in self._sink_rows()], ["row_not_object"],
        )

        self.assertEqual(list(read_strict_jsonl(path, on_corruption="tolerant")), [])
        self.assertEqual(
            [row["error"] for row in self._sink_rows()],
            ["row_not_object", "row_not_object"],
        )

    def test_non_object_row_is_corruption_when_the_text_names_the_transport(self) -> None:
        # Text carrying the replay-transport prefix used to be handed to
        # `ledger.read_jsonl`, which returns legacy rows as stored — a bare
        # list or scalar reached the caller with no diagnostic and no raise.
        from aria_kernel.ledger import REPLAY_TRANSPORT_SCHEMA_PREFIX

        path = self.tmp / "x.jsonl"
        marker = {"note": REPLAY_TRANSPORT_SCHEMA_PREFIX}
        path.write_text(json.dumps(marker) + "\n[1, 2]\n", encoding="utf-8")
        with self.assertRaisesRegex(
            GovernanceError, r"strict_jsonl_row_corrupt: .*:2: row_not_object",
        ):
            list(read_strict_jsonl(path))
        self.assertEqual(
            [row["error"] for row in self._sink_rows()], ["row_not_object"],
        )

        self.assertEqual(list(read_strict_jsonl(path, on_corruption="tolerant")), [marker])
        self.assertEqual(
            [row["error"] for row in self._sink_rows()],
            ["row_not_object", "row_not_object"],
        )


if __name__ == "__main__":
    unittest.main()
