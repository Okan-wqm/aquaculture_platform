"""The loser of a publish race must not lose its rows.

PLAN Wave 1 PR 2.6. `publish_state` is a compare-and-swap: a plain `git push`
to a fast-forward-only branch, so when two lanes publish from the same tip the
server rejects the second. Today that refusal is where the story ends — the
commit is rolled back, the rows stay staged, and the caller is told to "fetch
and rebuild against the new tip" by hand.

Rebuilding is deterministic, so it should not be by hand. The loser's ledgers
are the winner's ledgers plus its own append-only suffix; replaying that suffix
onto the winner's tip reconstructs a state that contains BOTH lanes' work.

THE COMMON PREFIX IS PROVEN, NOT ASSUMED. Every ledger row carries
`ledger_hash` over the whole chain behind it, and the snapshot both lanes
published from records each surface's `row_count` and `tail_ledger_hash`. So
"these two files share the first N rows" is answerable exactly: the row at
index N-1 must carry the base's tail hash in BOTH files. A hash match at that
index implies the entire prefix matches — that is what a hash chain is for.
Anything else is a rewrite wearing an append's clothes, and it is refused.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.contention_replay import (
    ReplayRefusal,
    append_only_suffix,
    replay_append_only_suffixes,
)
from aria_kernel.ledger import read_jsonl, verify_jsonl
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.declared_fixtures import append_declared_fixture

SURFACE = "cycles"
FILENAME = "cycles.jsonl"
SECOND_SURFACE = "memory_beliefs"
SECOND_RELPATH = "memory/beliefs.jsonl"


def _row(index: int) -> dict:
    return {
        "schema_version": 2,
        "cycle_id": f"cycle-{index}",
        "event": "started",
        "recorded_at": f"2026-08-03T00:{index:02d}:00Z",
    }


class _Tree:
    """A real tools root with one declared ledger, written through the real appender.

    `ensure_tools_dir` rather than a bare temp directory: `append_declared_jsonl`
    resolves a path against the declared surface manifest, so a fixture written
    somewhere arbitrary is not the thing production writes.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        ensure_tools_dir(self.root)
        self.path = self.root / FILENAME

    def append(self, index: int) -> dict:
        return append_declared_fixture(self.path, _row(index), expected_surface=SURFACE)

    def rows(self) -> list[dict]:
        return read_jsonl(self.path)

    def tail_hash(self) -> str | None:
        rows = self.rows()
        return str(rows[-1]["ledger_hash"]) if rows else None

    def cycle_ids(self) -> list[str]:
        return [str(r["cycle_id"]) for r in self.rows()]


class SuffixExtractionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tree = _Tree(Path(self._tmp.name) / "tools")

    def test_the_suffix_is_everything_after_the_base(self) -> None:
        for i in range(3):
            self.tree.append(i)
        base_count, base_tail = 3, self.tree.tail_hash()
        for i in range(3, 5):
            self.tree.append(i)

        suffix = append_only_suffix(
            self.tree.rows(), base_row_count=base_count, base_tail_hash=base_tail
        )
        self.assertEqual([r["cycle_id"] for r in suffix], ["cycle-3", "cycle-4"])

    def test_an_empty_base_makes_every_row_suffix(self) -> None:
        for i in range(2):
            self.tree.append(i)
        suffix = append_only_suffix(self.tree.rows(), base_row_count=0, base_tail_hash=None)
        self.assertEqual(len(suffix), 2)

    def test_no_new_rows_is_an_empty_suffix_not_an_error(self) -> None:
        for i in range(2):
            self.tree.append(i)
        suffix = append_only_suffix(
            self.tree.rows(), base_row_count=2, base_tail_hash=self.tree.tail_hash()
        )
        self.assertEqual(suffix, [])

    def test_a_divergent_prefix_is_refused_not_replayed(self) -> None:
        """The check the whole design rests on.

        Two trees that do not share the base prefix are not a race — one of
        them rewrote history. Replaying a suffix onto a different prefix would
        splice unrelated rows into a chain and call the result continuous.
        """
        for i in range(3):
            self.tree.append(i)
        with self.assertRaises(ReplayRefusal) as caught:
            append_only_suffix(
                self.tree.rows(), base_row_count=3, base_tail_hash="sha256:" + "0" * 64
            )
        self.assertIn("prefix", str(caught.exception))

    def test_a_truncated_file_is_refused(self) -> None:
        """Fewer rows than the base means rows were REMOVED, which append-only
        replay has no honest answer for."""
        for i in range(2):
            self.tree.append(i)
        with self.assertRaises(ReplayRefusal):
            append_only_suffix(
                self.tree.rows(), base_row_count=5, base_tail_hash=self.tree.tail_hash()
            )


class ReplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.winner = _Tree(base / "winner")
        self.loser = _Tree(base / "loser")

    def _fork(self, shared: int) -> tuple[int, str | None]:
        """Write `shared` rows into both trees; return the base coordinates."""
        for i in range(shared):
            self.winner.append(i)
            self.loser.append(i)
        return shared, self.winner.tail_hash()

    def test_both_lanes_work_survives_the_race(self) -> None:
        """The property the whole PR exists for."""
        base_count, base_tail = self._fork(2)
        self.winner.append(100)  # the winner published this
        self.loser.append(200)  # the loser had this staged when it was rejected

        result = replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            }
        )
        self.assertEqual(result.replayed_rows, 1)
        self.assertEqual(
            self.winner.cycle_ids(), ["cycle-0", "cycle-1", "cycle-100", "cycle-200"]
        )

    def test_the_replayed_chain_verifies(self) -> None:
        """A replayed row is re-chained, not copied.

        `ledger_hash` covers the chain behind it, so a row appended after a
        different predecessor MUST get a new hash. Copying the old one would
        produce a file that reads as valid to a naive eye and fails the real
        verifier.
        """
        base_count, base_tail = self._fork(2)
        self.winner.append(100)
        self.loser.append(200)
        replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            }
        )
        self.assertTrue(verify_jsonl(self.winner.path)["valid"], verify_jsonl(self.winner.path))

    def test_a_replayed_row_gets_a_new_hash(self) -> None:
        """Stated as its own assertion because it is the subtle half."""
        base_count, base_tail = self._fork(2)
        self.winner.append(100)
        self.loser.append(200)
        loser_hash_before = str(self.loser.rows()[-1]["ledger_hash"])
        replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            }
        )
        replayed = self.winner.rows()[-1]
        self.assertEqual(replayed["cycle_id"], "cycle-200")
        self.assertNotEqual(replayed["ledger_hash"], loser_hash_before)

    def test_a_retry_against_a_stale_base_does_not_double_append(self) -> None:
        """Written expecting a refusal; it duplicated instead, and that was real.

        Replay is not idempotent by construction: after a successful replay the
        winner holds the loser's rows but the LOSER's file is unchanged, so the
        same suffix is extracted again. The base only advances when the lane
        re-snapshots and re-publishes, and a retry between those two points
        appended every row twice. The guard recognises a winner suffix that
        already ends with the loser's entire suffix and does nothing.
        """
        base_count, base_tail = self._fork(2)
        self.winner.append(100)
        self.loser.append(200)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }
        replay_append_only_suffixes(surfaces=spec)
        before = self.winner.cycle_ids()
        replay_append_only_suffixes(surfaces=spec)
        self.assertEqual(self.winner.cycle_ids(), before)

    def test_nothing_to_replay_leaves_the_winner_untouched(self) -> None:
        base_count, base_tail = self._fork(2)
        self.winner.append(100)
        result = replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            }
        )
        self.assertEqual(result.replayed_rows, 0)
        self.assertEqual(self.winner.cycle_ids(), ["cycle-0", "cycle-1", "cycle-100"])

    def test_neither_side_is_exempt_from_the_prefix_proof(self) -> None:
        """A base that matches NEITHER tree is refused.

        Weak on its own — it does not say which check fired — so the isolating
        case below carries the actual claim. Kept because it is the shape an
        operator hits when the base itself is wrong.
        """
        base_count, base_tail = self._fork(2)
        self.loser.append(200)
        with self.assertRaises(ReplayRefusal):
            replay_append_only_suffixes(
                surfaces={
                    SURFACE: {
                        "winner_path": self.winner.path,
                        "loser_path": self.loser.path,
                        "base_row_count": base_count,
                        "base_tail_hash": "sha256:" + "f" * 64,
                    }
                }
            )

    def test_a_winner_that_rewrote_history_is_refused(self) -> None:
        """The winner is checked against the base TOO, and this isolates it.

        Written first as a both-sides-bad case, which passed while the winner
        check was mutated away — the loser's check was doing all the refusing.
        Here the LOSER descends from the base cleanly and only the WINNER does
        not, so the refusal can come from one place.

        Trusting the winner because it won is the tempting mistake: winning the
        push only means arriving first, and says nothing about descent. Without
        this check a lane that rewrote its own history would absorb the loser's
        rows into a chain neither of them shares.
        """
        for i in range(2):
            self.loser.append(i)
        base_count, base_tail = 2, self.loser.tail_hash()
        # The winner's own first two rows are DIFFERENT, so its row at the
        # base's last index carries a different chain hash.
        for i in (7, 8):
            self.winner.append(i)
        self.loser.append(200)

        with self.assertRaises(ReplayRefusal) as caught:
            replay_append_only_suffixes(
                surfaces={
                    SURFACE: {
                        "winner_path": self.winner.path,
                        "loser_path": self.loser.path,
                        "base_row_count": base_count,
                        "base_tail_hash": base_tail,
                    }
                }
            )
        self.assertIn("diverged", str(caught.exception))
        self.assertEqual(self.winner.cycle_ids(), ["cycle-7", "cycle-8"])

    def test_a_refusal_on_one_surface_leaves_every_surface_unwritten(self) -> None:
        """All-or-nothing across surfaces.

        A partial replay would leave the tree in a state neither lane ever
        held, and no snapshot would describe it.
        """
        base_count, base_tail = self._fork(2)
        self.loser.append(200)
        good = {
            "winner_path": self.winner.path,
            "loser_path": self.loser.path,
            "base_row_count": base_count,
            "base_tail_hash": base_tail,
        }
        bad = dict(
            good,
            winner_path=self.winner.root / SECOND_RELPATH,
            loser_path=self.loser.root / SECOND_RELPATH,
            base_tail_hash="sha256:" + "f" * 64,
        )
        with self.assertRaises(ReplayRefusal):
            replay_append_only_suffixes(surfaces={SURFACE: good, SECOND_SURFACE: bad})
        self.assertEqual(self.winner.cycle_ids(), ["cycle-0", "cycle-1"])


if __name__ == "__main__":
    unittest.main()
