"""CONTRACTS.md passages that restate a kernel vocabulary mirror that vocabulary.

WHY one module: each of these passages is a prose copy of a closed set the
kernel owns (the learning hook order, the claim types, the feedback kinds and
sources, the covered workspace ledgers, the snapshot modes). The copies had
drifted — 11 of 18 hooks, 10 of 11 claim types, 3 of 5 sources, a missing
ledger, a mode the code refuses — because nothing compared a passage with its
owner. Each test parses one passage and compares it with the owning symbol,
so a change to either side that is not mirrored on the other fails here.
"""
from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TEXT = (REPO / "docs" / "aria" / "CONTRACTS.md").read_text(encoding="utf-8")


def _section(heading: str) -> str:
    start = TEXT.index(heading)
    end = TEXT.find("\n## ", start + len(heading))
    return TEXT[start:] if end == -1 else TEXT[start:end]


def _backticked(fragment: str) -> set[str]:
    return set(re.findall(r"`([a-z_]+)`", fragment))


class LearningPassMirrorsHookOrder(unittest.TestCase):
    """ARIA-HIGH-499 — §0.2 lists LEARNING_HOOK_ORDER, in order, and names the split."""

    def test_hooks_are_the_order(self) -> None:
        from aria_kernel.learning import LEARNING_HOOK_ORDER, PRE_CYCLE_LEARNING_HOOKS

        section = _section("## 0.2 — Phase-2A Learning Pass Contract")
        hooks = re.findall(r"^\d+\. `([a-z_]+)`", section, re.M)
        self.assertEqual(hooks, list(LEARNING_HOOK_ORDER))
        self.assertEqual(LEARNING_HOOK_ORDER[: len(PRE_CYCLE_LEARNING_HOOKS)], PRE_CYCLE_LEARNING_HOOKS)
        split = re.search(r"hooks 1[–-](\d+) \(`learning\.py::PRE_CYCLE_LEARNING_HOOKS`\)", section, re.I)
        self.assertIsNotNone(split)
        self.assertEqual(int(split.group(1)), len(PRE_CYCLE_LEARNING_HOOKS))


class ClaimTypeAllowlistMirrorsCLAIM_TYPES(unittest.TestCase):
    """ARIA-HIGH-499 — the claim_type enum and table are finding.CLAIM_TYPES.

    The table pins min_severity only: its "Min evidence count" column is prose
    (e.g. "baseline + comparison artifact"), deliberately not a number.
    """

    def test_table_rows_carry_the_kernel_severity_floor(self) -> None:
        from aria_kernel.finding import CLAIM_TYPES

        section = _section("## 6 — Finding & Recommendation Schema")
        rows = dict(re.findall(r"^\| `([a-z_]+)`\s*\|[^|]*\|\s*([A-Z]+)\s*\|", section, re.M))
        self.assertEqual(rows, {name: spec["min_severity"] for name, spec in CLAIM_TYPES.items()})

    def test_json_enum_is_the_kernel_set(self) -> None:
        from aria_kernel.finding import CLAIM_TYPES

        section = _section("## 6 — Finding & Recommendation Schema")
        enum = re.search(r'"claim_type": (.+?),\n  "claim_summary"', section, re.S)
        self.assertIsNotNone(enum)
        self.assertEqual(set(re.findall(r'"([a-z_]+)"', enum.group(1))), set(CLAIM_TYPES))


class FeedbackVocabularyMirrorsFeedbackSets(unittest.TestCase):
    """ARIA-HIGH-499 — §8.5's kind and source lists are the feedback.py sets."""

    def _allowed(self, field: str) -> set[str]:
        section = _section("## 8.5 — Feedback Event Schema")
        match = re.search(rf"Allowed `{field}` values: (.+?)\.\n", section, re.S)
        self.assertIsNotNone(match, field)
        return _backticked(match.group(1))

    def test_sources(self) -> None:
        from aria_kernel.feedback import FEEDBACK_SOURCES

        self.assertEqual(self._allowed("source"), set(FEEDBACK_SOURCES))

    def test_kinds(self) -> None:
        from aria_kernel.feedback import FEEDBACK_KINDS

        self.assertEqual(self._allowed("kind"), set(FEEDBACK_KINDS))


class WorkspaceCoveredLedgersMirrorWorkspacePaths(unittest.TestCase):
    """ARIA-HIGH-499 — §0.1's covered workspace ledgers are workspace_paths().ledgers."""

    def test_workspace_ledgers(self) -> None:
        from aria_kernel.workspace import workspace_paths

        section = _section("## 0.1 — Snowball v9 Root Contract")
        listed = re.search(r"^- Workspace: (.+?)\.\n", section, re.M | re.S)
        self.assertIsNotNone(listed)
        with tempfile.TemporaryDirectory() as tmp:
            ledgers = workspace_paths(Path(tmp), workspace_base=Path(tmp) / "ws").ledgers
        self.assertEqual(_backticked(listed.group(1)), set(ledgers))


class SnapshotModesMirrorSNAPSHOT_MODES(unittest.TestCase):
    """ARIA-HIGH-499 — the snapshot mode enum is snapshot.SNAPSHOT_MODES, alias included."""

    def test_snapshot_modes(self) -> None:
        from aria_kernel.snapshot import SNAPSHOT_MODES

        match = re.search(r"Snapshot mode enum is `\{([^}]*)\}`", TEXT)
        self.assertIsNotNone(match)
        self.assertEqual({mode.strip() for mode in match.group(1).split(",")}, set(SNAPSHOT_MODES))


class ActorKindsMirrorACTOR_KINDS(unittest.TestCase):
    """ARIA-MEDIUM-029 — §0.1's actor-kind list is execution_spine.ACTOR_KINDS."""

    def test_actor_kinds(self) -> None:
        from aria_kernel.execution_spine import ACTOR_KINDS

        section = _section("## 0.1 — Snowball v9 Root Contract")
        match = re.search(r"Actor kinds: (.+?)\.\n", section)
        self.assertIsNotNone(match, "the actor-kind sentence is missing from §0.1")
        self.assertEqual(_backticked(match.group(1)), set(ACTOR_KINDS))
        self.assertNotIn("human", _backticked(match.group(1)))


class RuntimeCountersPassageNamesTheMarkerOwner(unittest.TestCase):
    """ARIA-HIGH-499 — §12.5 says the counters are derived and names what derives them."""

    def test_counters_passage(self) -> None:
        from aria_kernel import runtime_artifacts

        section = _section("## 12.5 — Runtime v2 Ledger Promotion Contract")
        for symbol in ("_SUPPRESSED_MARKER_KEYS", "_TRUNCATED_MARKER_KEYS"):
            self.assertTrue(symbol in section, f"§12.5 does not name {symbol}")
        self.assertFalse(
            "hard-coded zero counters are smoke evidence only" in section,
            "§12.5 still calls the derived counters hard-coded zeros",
        )
        self.assertTrue(runtime_artifacts._SUPPRESSED_MARKER_KEYS)
        self.assertTrue(runtime_artifacts._TRUNCATED_MARKER_KEYS)


if __name__ == "__main__":
    unittest.main()
