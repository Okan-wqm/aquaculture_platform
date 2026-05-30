"""Plan 025 §A.3 — finding._refresh_index on_corruption parameter.

Pins the contract of the explicit ``on_corruption`` parameter on
finding._refresh_index. Default ``"advisory"`` preserves the
deadlock-avoidance behaviour (bulk index rebuild must not block on
a sibling-process write-in-flight); ``"strict"`` opt-in for future
critical-replay paths.

Cases (3):
1. advisory default — corrupt finding doc skipped, diagnostic
   emitted, index built from the surviving doc(s).
2. strict opt-in — corrupt finding doc raises GovernanceError
   AFTER the diagnostic sink emit (so operators see the
   corruption row even when the call aborts).
3. invalid mode — raises GovernanceError at function entry,
   never reads any finding doc (verified by patching json.loads
   and asserting it is not called).
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.finding import _refresh_index
from aria_kernel.tool_registry import GovernanceError


# Plan ARIA-V2 §3.4 + CRITICAL-010 — tuple-of-segments form keeps the
# I-40 grep regression net satisfied (no ``Path("aria-tools")``
# literal). Callers compose via ``self.repo.joinpath(*_SINK_PARTS)``
# so the segment is unambiguously a directory NAME, not a cwd-relative
# path resolution.
_SINK_PARTS = ("aria-tools", "diagnostics", "ledger-corruption.jsonl")


def _seed_repo(*, with_corrupt: bool) -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-finding-refresh-"))
    findings = repo / "aria-findings"
    findings.mkdir()
    # Valid finding doc — minimal shape sufficient for index rebuild.
    f001 = {
        "finding_id": "F-001",
        "severity": "MEDIUM",
        "status": "OPEN",
        "claim_type": "wrong_code",
        "claim_summary": "valid",
        "evidence_chain_id": "chain_aaaaaaaaaaaaaaaa",
        "created_at": "2026-05-10T00:00:00Z",
    }
    (findings / "F-001.json").write_text(
        json.dumps(f001), encoding="utf-8"
    )
    if with_corrupt:
        (findings / "F-002.json").write_text(
            "{not-valid-json", encoding="utf-8",
        )
    # tools dir (sink target) — _refresh_index emits to repo / aria-tools.
    (repo / "aria-tools").mkdir()
    return repo


class AdvisoryDefaultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo(with_corrupt=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_advisory_default_skips_corrupt_doc(self) -> None:
        index = _refresh_index(self.repo)  # default on_corruption='advisory'
        self.assertEqual(len(index["findings"]), 1)
        self.assertEqual(index["findings"][0]["finding_id"], "F-001")
        sink = self.repo.joinpath(*_SINK_PARTS)
        self.assertTrue(sink.exists())
        sink_rows = [
            json.loads(line)
            for line in sink.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(sink_rows), 1)
        self.assertEqual(sink_rows[0]["kind"], "ledger_index_rebuild_skip")


class StrictOptInTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo(with_corrupt=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_strict_opt_in_raises_on_corrupt_doc(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            _refresh_index(self.repo, on_corruption="strict")
        self.assertIn("finding_doc_corrupt_strict_mode", str(ctx.exception))
        # Diagnostic still emitted before the raise — the corruption
        # observation must reach the audit sink even when the call
        # aborts.
        sink = self.repo.joinpath(*_SINK_PARTS)
        self.assertTrue(sink.exists())
        sink_rows = [
            json.loads(line)
            for line in sink.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(sink_rows), 1)
        self.assertEqual(sink_rows[0]["kind"], "ledger_index_rebuild_skip")


class InvalidModeEntryTests(unittest.TestCase):
    def setUp(self) -> None:
        # No corrupt doc needed — the entry-validation check must
        # raise before any finding doc is read.
        self.repo = _seed_repo(with_corrupt=False)

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_invalid_mode_raises_at_entry(self) -> None:
        # Patch json.loads to verify it is NEVER called when entry
        # validation rejects the mode. This proves the parameter check
        # is genuinely at function entry, not lazily-checked inside
        # the per-doc loop.
        with mock.patch(
            "aria_kernel.finding.json.loads",
            side_effect=AssertionError("json.loads must not be called"),
        ) as loads_mock:
            with self.assertRaises(GovernanceError) as ctx:
                _refresh_index(self.repo, on_corruption="paranoid")
            self.assertIn(
                "refresh_index_invalid_on_corruption_mode",
                str(ctx.exception),
            )
            self.assertEqual(loads_mock.call_count, 0)


if __name__ == "__main__":
    unittest.main()
