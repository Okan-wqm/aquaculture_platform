"""F-006 anchor 2 — architectural debt marker / ledger invariant.

Per CONTRACTS.md §6.6 + IDENTITY.md §3.6 Rule 3, every short-term
workaround MUST carry a source-side `aria-debt:DEBT-XXX` marker AND
a corresponding `aria-debts/DEBT-XXX.json` record AND an entry in
`aria-debts/_index.json`. Markers without records, records without
markers, or records without index entries are policy violations the
kernel currently does not enforce at runtime; this invariant test
makes the wrong behavior detectable at test time (tier-3
architectural solution per CLAUDE.md).

Operator-conducted ARIA self-audit (2026-05-10) created the first
real `aria-debt:` marker in the codebase (cycle.py for the
pr_lifecycle placeholder). This test future-proofs the discipline:
any new marker must appear with a tracked debt; any new debt must
appear in the index.
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]
_ARIA_DEBTS_DIR = _REPO_ROOT / "aria-debts"
_ARIA_DEBTS_INDEX = _ARIA_DEBTS_DIR / "_index.json"
_MARKER_RE = re.compile(r"aria-debt:(DEBT-\d{4}-\d{2}-\d{2}-\d{3})")
# Source roots scanned for markers. Tests + fixture data + docs are
# excluded so a debt _example_ in CONTRACTS.md or a regression test
# referencing a marker string does not create a phantom obligation.
_SCAN_ROOTS = (
    _REPO_ROOT / "aria-kernel" / "aria_kernel",
    _REPO_ROOT / "tools" / "aria-poc",
)
_SCAN_GLOBS = ("*.py", "*.ts", "*.tsx", "*.js", "*.json", "*.yaml", "*.yml")


def _collect_source_markers() -> dict[str, list[str]]:
    """Return {debt_id: [file:line, ...]} for every aria-debt: marker
    found in scanned source roots."""
    found: dict[str, list[str]] = {}
    for root in _SCAN_ROOTS:
        if not root.exists():
            continue
        for pattern in _SCAN_GLOBS:
            for path in root.rglob(pattern):
                if "__pycache__" in path.parts or ".egg-info" in path.parts:
                    continue
                try:
                    text = path.read_text(encoding="utf-8")
                except (UnicodeDecodeError, OSError):
                    continue
                for line_no, line in enumerate(text.splitlines(), start=1):
                    for match in _MARKER_RE.finditer(line):
                        debt_id = match.group(1)
                        rel = path.relative_to(_REPO_ROOT).as_posix()
                        found.setdefault(debt_id, []).append(f"{rel}:{line_no}")
    return found


def _load_index_debt_ids() -> set[str]:
    payload = json.loads(_ARIA_DEBTS_INDEX.read_text(encoding="utf-8"))
    return {entry["debt_id"] for entry in payload["debts"]}


def _load_record_debt_ids() -> set[str]:
    return {
        path.stem
        for path in _ARIA_DEBTS_DIR.glob("DEBT-*.json")
        if path.name != "_index.json"
    }


class ArchitecturalDebtMarkerInvariantTests(unittest.TestCase):
    def test_every_source_marker_has_record(self) -> None:
        markers = _collect_source_markers()
        records = _load_record_debt_ids()
        orphans = sorted(set(markers) - records)
        self.assertEqual(
            orphans,
            [],
            "aria-debt markers without aria-debts/DEBT-*.json records "
            f"(orphan markers): {orphans}; sites: "
            f"{ {d: markers[d] for d in orphans} }",
        )

    def test_every_record_appears_in_index(self) -> None:
        records = _load_record_debt_ids()
        indexed = _load_index_debt_ids()
        unindexed = sorted(records - indexed)
        self.assertEqual(
            unindexed,
            [],
            f"DEBT-*.json files not listed in aria-debts/_index.json: {unindexed}",
        )

    def test_index_entries_reference_existing_records(self) -> None:
        records = _load_record_debt_ids()
        indexed = _load_index_debt_ids()
        ghost = sorted(indexed - records)
        self.assertEqual(
            ghost,
            [],
            f"aria-debts/_index.json entries point to missing DEBT files: {ghost}",
        )

    def test_debt_2026_05_10_001_marker_present_at_cycle_placeholder(self) -> None:
        # Direct, narrow assertion for the F-006 anchor 2 closure: the
        # DEBT-2026-05-10-001 marker must sit adjacent to the
        # pr_lifecycle placeholder note in cycle.py. Without this
        # adjacency the audit trail breaks (CONTRACTS §6.6 source-
        # side marker requirement).
        cycle_path = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "cycle.py"
        text = cycle_path.read_text(encoding="utf-8")
        self.assertIn(
            "aria-debt:DEBT-2026-05-10-001",
            text,
            "cycle.py must carry the DEBT-2026-05-10-001 marker adjacent "
            "to the pr_lifecycle placeholder note",
        )
        # Verify proximity to the placeholder note: marker must appear
        # within 12 lines of the 'placeholder governance event' phrase.
        lines = text.splitlines()
        placeholder_line = next(
            (i for i, ln in enumerate(lines) if "placeholder governance event" in ln),
            None,
        )
        marker_line = next(
            (i for i, ln in enumerate(lines) if "aria-debt:DEBT-2026-05-10-001" in ln),
            None,
        )
        self.assertIsNotNone(placeholder_line, "placeholder note line not found in cycle.py")
        self.assertIsNotNone(marker_line, "marker line not found in cycle.py")
        self.assertLessEqual(
            abs(marker_line - placeholder_line),
            12,
            f"marker line {marker_line} too far from placeholder line "
            f"{placeholder_line}",
        )


if __name__ == "__main__":
    unittest.main()
