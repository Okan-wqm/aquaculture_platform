"""E17-d — per-spawn context usage ledger tests.

What this suite pins:
- record_context_usage lands a DECLARED row (ledger_hash envelope) on
  knowledge-graph/context-usage.jsonl with the four API usage fields.
- Absent usage fields record as None — an old CLI that omits cache_*
  stays distinguishable from a genuine zero.
- usage=None is a STRUCTURAL skip (explicit branch, nothing written,
  skip dict returned) — never an exception swallow.
- The ledger path resolves to the declared `context_usage` surface via
  surface_for_relative_path, and the writer's literal stays visible to
  the tests/test_ledger_roster_invariant.py static sweep (same regex).
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.state_manifest import surface_for_relative_path
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.usage_ledger import record_context_usage
from tests.test_ledger_roster_invariant import _sweep_candidates

_FULL_USAGE = {
    "input_tokens": 1200,
    "output_tokens": 340,
    "cache_creation_input_tokens": 51000,
    "cache_read_input_tokens": 87000,
}


def _seed_tools() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-usage-ledger-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    return tools


class RecordContextUsageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.addCleanup(shutil.rmtree, self.tools.parent, ignore_errors=True)
        self.ledger = self.tools / "knowledge-graph" / "context-usage.jsonl"

    def _record(self, usage: dict | None) -> dict:
        return record_context_usage(
            request_id="req-e17d-1",
            role="evidence_judgment",
            target_agent="aria-evidence-judge",
            model="opus",
            usage=usage,
            base_dir=self.tools,
        )

    def test_happy_path_lands_declared_row_with_ledger_hash(self) -> None:
        stored = self._record(dict(_FULL_USAGE))
        self.assertTrue(self.ledger.exists())
        rows = [
            json.loads(line)
            for line in self.ledger.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        # Declared-append envelope: the row is hash-chained like every
        # governed ledger, not a bare json.dumps append.
        self.assertTrue(row.get("ledger_hash"))
        self.assertEqual(stored.get("ledger_hash"), row["ledger_hash"])
        self.assertEqual(row["schema_version"], 1)
        self.assertEqual(row["request_id"], "req-e17d-1")
        self.assertEqual(row["role"], "evidence_judgment")
        self.assertEqual(row["target_agent"], "aria-evidence-judge")
        self.assertEqual(row["model"], "opus")
        self.assertEqual(row["input_tokens"], 1200)
        self.assertEqual(row["output_tokens"], 340)
        self.assertEqual(row["cache_creation_input_tokens"], 51000)
        self.assertEqual(row["cache_read_input_tokens"], 87000)
        self.assertTrue(row.get("recorded_at"))

    def test_absent_usage_fields_record_as_none(self) -> None:
        # A CLI that reports only input/output must not fabricate cache
        # zeros — None keeps "not reported" distinguishable from "zero".
        self._record({"input_tokens": 10, "output_tokens": 2})
        row = json.loads(self.ledger.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(row["input_tokens"], 10)
        self.assertIsNone(row["cache_creation_input_tokens"])
        self.assertIsNone(row["cache_read_input_tokens"])

    def test_non_numeric_usage_field_records_as_none(self) -> None:
        self._record({"input_tokens": "lots", "output_tokens": True})
        row = json.loads(self.ledger.read_text(encoding="utf-8").splitlines()[0])
        self.assertIsNone(row["input_tokens"])
        # bool subclasses int; True must not become 1 token.
        self.assertIsNone(row["output_tokens"])

    def test_none_usage_is_structural_skip_and_writes_nothing(self) -> None:
        skip = self._record(None)
        self.assertEqual(skip["recorded"], False)
        self.assertEqual(skip["skip_reason"], "usage_none")
        self.assertEqual(skip["request_id"], "req-e17d-1")
        self.assertEqual(skip["role"], "evidence_judgment")
        self.assertEqual(skip["target_agent"], "aria-evidence-judge")
        self.assertFalse(self.ledger.exists())


class ContextUsageSurfaceTests(unittest.TestCase):
    def test_relative_path_resolves_to_context_usage_surface(self) -> None:
        surface = surface_for_relative_path("knowledge-graph/context-usage.jsonl")
        self.assertIsNotNone(surface)
        self.assertEqual(surface.name, "context_usage")
        self.assertEqual(surface.state_class, "ledger")
        self.assertEqual(surface.lock_group, "knowledge")
        self.assertEqual(surface.durability, "append_fsync")
        self.assertFalse(surface.write_driving)
        self.assertEqual(surface.observe_class, "observation")

    def test_writer_literal_stays_visible_to_roster_sweep(self) -> None:
        # Deliberate-break guard: if the writer's path literal is refactored
        # behind a constant, the roster invariant's static sweep (the ACTUAL
        # sweep, imported — not a copy that could drift) goes blind to this
        # ledger and a future rename could silently unroster it.
        candidates = _sweep_candidates()
        self.assertIn("knowledge-graph/context-usage.jsonl", candidates)
        self.assertIn(
            "usage_ledger.py",
            candidates["knowledge-graph/context-usage.jsonl"],
        )


if __name__ == "__main__":
    unittest.main()
