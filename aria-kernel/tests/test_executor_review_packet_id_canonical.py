"""Plan 023 v3 §A-9 — executor review packet_id canonical (read-time).

Pre-Plan-023 executor.get_executor_packet used:

    if row.get("packet_id") == packet_id or row.get("ledger_hash") == packet_id:

The dual-key OR-equality let either field serve as identity; future
drift (where rows are written under ledger_hash but looked up via
packet_id, or vice versa) could silently mask review-blocker misses.

Plan 023 v3 §A-9 fix: read-time canonicalization via the new
_canonical_packet_id(row) helper. Single-key match against the
canonical id replaces the inline alias accommodation. Append-only
discipline preserved — legacy rows on disk are read through the
helper without mutation; new writes carry packet_id.

Tests:
1. Lookup by canonical packet_id → match.
2. Legacy row with only ledger_hash → match via fallback.
3. Row without either field → no match (None canonical id).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.executor import _canonical_packet_id, get_executor_packet
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


class CanonicalPacketIdHelperTests(unittest.TestCase):
    def test_canonical_returns_packet_id_when_present(self) -> None:
        row = {"packet_id": "pkt-001", "ledger_hash": "sha256:abc"}
        self.assertEqual(_canonical_packet_id(row), "pkt-001")

    def test_falls_back_to_ledger_hash_when_packet_id_missing(self) -> None:
        row = {"ledger_hash": "sha256:legacy"}
        self.assertEqual(_canonical_packet_id(row), "sha256:legacy")

    def test_returns_none_when_neither_present(self) -> None:
        row = {"other_field": "x"}
        self.assertIsNone(_canonical_packet_id(row))

    def test_empty_string_packet_id_falls_back_to_ledger(self) -> None:
        row = {"packet_id": "", "ledger_hash": "sha256:legacy"}
        self.assertEqual(_canonical_packet_id(row), "sha256:legacy")


class GetExecutorPacketLookupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a9-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_packet(self, **fields) -> None:
        packets_path = self.tools / "executor" / "packets.jsonl"
        packets_path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            packets_path,
            fields,
            expected_surface="executor_packets",
        )

    def test_canonical_lookup_finds_packet_by_packet_id(self) -> None:
        self._seed_packet(packet_id="pkt-100", payload="x")
        result = get_executor_packet(packet_id="pkt-100", base_dir=self.tools)
        self.assertEqual(result["packet_id"], "pkt-100")

    def test_canonical_helper_directly_handles_legacy_shape(self) -> None:
        """Plan 023 v3 §A-9 — the canonical helper resolves a legacy-
        shape row (ledger_hash only, no packet_id) in isolation. The
        live ledger module rewrites ledger_hash with a chain hash, so
        this scenario is exercised at the helper level rather than via
        the writer."""
        legacy_row = {"ledger_hash": "sha256:legacy-id", "payload": "x"}
        self.assertEqual(_canonical_packet_id(legacy_row), "sha256:legacy-id")

    def test_lookup_with_unknown_id_raises(self) -> None:
        self._seed_packet(packet_id="pkt-200")
        with self.assertRaises(GovernanceError):
            get_executor_packet(packet_id="does-not-exist", base_dir=self.tools)


if __name__ == "__main__":
    unittest.main()
