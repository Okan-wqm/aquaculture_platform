"""A fresh tree and a restored tree must stop being the same observation.

PLAN Wave 1 §2.5. `aria-auto-cycle.yml` bootstrapped an empty `aria-tools/`
unconditionally, so a restore that failed and a genuine first run produced the
same starting state — and an empty tree passes `integrity verify`, because an
empty tree is trivially consistent. ARIA would then plan, learn and act on a
state tree that had forgotten everything, with every surviving file still
verifying.

The distinguishing evidence has to come from OUTSIDE the tree being judged,
because a tree that lost its history also lost any record that it had one. Two
such references exist: the `aria/state` branch tip, and the daily anchors
committed into the repository under `aria-tools/reports/daily/`.

THE THIRD OUTCOME IS THE LOAD-BEARING ONE. "No usable reference" is not
"continuous" and it is not "amnesiac" — it is not knowing, and the gate says so
rather than guessing. Guessing continuous re-opens the hole; guessing amnesiac
would degrade every cycle on a repository whose committed anchors predate the
manifest_root field entirely. The same discipline as an empty acceptance ledger
not being a broken chain, and `outcome_status` defaulting to `unknown`.
"""

from __future__ import annotations

import tempfile
import unittest
import unittest.mock
from pathlib import Path

import yaml

from aria_kernel.memory_gap import (
    GAP_CRITICAL,
    GAP_GENESIS,
    GAP_OK,
    GAP_UNKNOWN,
    assess_memory_continuity,
    equivalence_check,
    reference_from_committed_anchors,
    resolve_continuity_reference,
)


def _snapshot(
    snapshot_id: str,
    *,
    surfaces: dict[str, str],
    prev_id: str | None = None,
    prev_root: str | None = None,
    manifest_root: str | None = None,
) -> dict:
    return {
        "$schema": "aria/state-snapshot/v1",
        "schema_version": 1,
        "snapshot_id": snapshot_id,
        "manifest_root": manifest_root or f"root-{snapshot_id}",
        "prev_snapshot_id": prev_id,
        "prev_manifest_root": prev_root,
        "surfaces": {
            name: {"path": f"{name}.jsonl", "sha256": sha, "row_count": 1, "tail_ledger_hash": sha}
            for name, sha in surfaces.items()
        },
    }


class MemoryContinuityTests(unittest.TestCase):
    def test_a_linked_successor_is_continuous(self) -> None:
        previous = _snapshot("s1", surfaces={"cycles": "a", "memory": "b"})
        current = _snapshot(
            "s2",
            surfaces={"cycles": "a2", "memory": "b"},
            prev_id="s1",
            prev_root=previous["manifest_root"],
        )
        verdict = assess_memory_continuity(current=current, reference=previous, reference_kind="state_branch")
        self.assertEqual(verdict.status, GAP_OK, verdict.reasons)

    def test_a_fresh_tree_against_a_real_reference_is_a_critical_gap(self) -> None:
        """The exact shape of the defect: the tree forgot, the reference did not."""
        previous = _snapshot("s1", surfaces={"cycles": "a", "memory": "b"})
        # What a bootstrap-empty tree snapshots to: no surfaces, no ancestry.
        fresh = _snapshot("s2", surfaces={})
        verdict = assess_memory_continuity(current=fresh, reference=previous, reference_kind="state_branch")
        self.assertEqual(verdict.status, GAP_CRITICAL)
        self.assertTrue(
            any("chain" in reason or "lost" in reason for reason in verdict.reasons),
            verdict.reasons,
        )

    def test_a_lost_surface_is_a_critical_gap_even_when_the_chain_links(self) -> None:
        """Every surviving file still verifies; only the tree-level view sees this."""
        previous = _snapshot("s1", surfaces={"cycles": "a", "memory": "b"})
        current = _snapshot(
            "s2",
            surfaces={"cycles": "a"},
            prev_id="s1",
            prev_root=previous["manifest_root"],
        )
        verdict = assess_memory_continuity(current=current, reference=previous, reference_kind="state_branch")
        self.assertEqual(verdict.status, GAP_CRITICAL)
        self.assertIn("memory", verdict.lost_surfaces)

    def test_no_reference_reports_unknown_rather_than_guessing(self) -> None:
        """Not knowing is a third answer, and the gate must be able to give it.

        Guessing "continuous" restores the hole this exists to close. Guessing
        "amnesiac" would degrade every cycle on a repository whose committed
        anchors predate the manifest_root field.
        """
        current = _snapshot("s2", surfaces={"cycles": "a"})
        verdict = assess_memory_continuity(current=current, reference=None, reference_kind=None)
        self.assertEqual(verdict.status, GAP_UNKNOWN)
        self.assertNotEqual(verdict.status, GAP_OK)
        self.assertNotEqual(verdict.status, GAP_CRITICAL)

    def test_an_empty_tree_with_no_reference_is_genesis_not_amnesia(self) -> None:
        """A newborn ARIA must be able to start. It must also be the only thing
        that can: an empty tree is genesis ONLY when nothing remembers otherwise."""
        verdict = assess_memory_continuity(
            current=_snapshot("s1", surfaces={}), reference=None, reference_kind=None
        )
        self.assertEqual(verdict.status, GAP_GENESIS)

    def test_a_non_empty_tree_with_no_reference_is_not_genesis(self) -> None:
        """State exists, so this is not a first run — it is an unverifiable one."""
        verdict = assess_memory_continuity(
            current=_snapshot("s1", surfaces={"cycles": "a"}), reference=None, reference_kind=None
        )
        self.assertEqual(verdict.status, GAP_UNKNOWN)

    def test_an_anchor_reference_still_catches_a_broken_chain(self) -> None:
        """A committed anchor carries `state_manifest_root` and no surface map.

        It can therefore answer "does this tree descend from that one?" and
        cannot answer "did a surface vanish?". The gate must use what the
        reference actually has rather than skipping the check it cannot make.
        """
        anchor = {"snapshot_id": "s1", "manifest_root": "root-1"}
        fresh = _snapshot("s2", surfaces={})
        verdict = assess_memory_continuity(
            current=fresh, reference=anchor, reference_kind="daily_anchor"
        )
        self.assertEqual(verdict.status, GAP_CRITICAL)
        self.assertTrue(any("chain" in reason for reason in verdict.reasons), verdict.reasons)

    def test_a_surfaceless_reference_does_not_claim_surfaces_were_lost(self) -> None:
        """The half it cannot see must not be reported as evidence either way —
        an anchor with no surface map is not proof that no surface was lost."""
        anchor = {"snapshot_id": "s1", "manifest_root": "root-1"}
        linked = _snapshot("s2", surfaces={"cycles": "a"}, prev_id="s1", prev_root="root-1")
        verdict = assess_memory_continuity(
            current=linked, reference=anchor, reference_kind="daily_anchor"
        )
        self.assertEqual(verdict.status, GAP_OK)
        self.assertEqual(verdict.lost_surfaces, ())
        self.assertTrue(
            any("surface_comparison_unavailable" in reason for reason in verdict.notes),
            verdict.notes,
        )

    def test_the_verdict_names_where_its_reference_came_from(self) -> None:
        """An operator must be able to tell which authority refused them."""
        previous = _snapshot("s1", surfaces={"cycles": "a"})
        current = _snapshot("s2", surfaces={}, prev_id="s1", prev_root=previous["manifest_root"])
        verdict = assess_memory_continuity(
            current=current, reference=previous, reference_kind="daily_anchor"
        )
        self.assertEqual(verdict.reference_kind, "daily_anchor")


class CommittedAnchorReferenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.reports = Path(self._tmp.name) / "aria-tools" / "reports" / "daily"
        self.reports.mkdir(parents=True)

    def _anchor(self, date: str, *, snapshot_id: str | None, manifest_root: str | None) -> None:
        # Rendered the way `render_anchor_markdown` renders it: YAML
        # frontmatter between `---` fences, then a markdown body.
        front = yaml.safe_dump(
            {
                "date": date,
                "state_snapshot_id": snapshot_id,
                "state_manifest_root": manifest_root,
            },
            sort_keys=True,
        )
        (self.reports / f"{date}.md").write_text(
            f"---\n{front}---\n\n# ARIA Daily Anchor {date}\n", encoding="utf-8"
        )

    def _prose_only_report(self, date: str) -> None:
        """What `aria-tools/reports/daily/2026-05-08.md` actually is on main.

        The pre-workflow reports were written by hand and carry no
        frontmatter at all. Reading one must produce "no reference", not a
        parse error that takes the cycle down.
        """
        (self.reports / f"{date}.md").write_text(
            f"# ARIA Daily Report {date}\n\nManual reconstruction.\n", encoding="utf-8"
        )

    def test_the_newest_anchor_carrying_a_root_is_the_reference(self) -> None:
        self._anchor("2026-05-07", snapshot_id="s1", manifest_root="root-1")
        self._anchor("2026-05-08", snapshot_id="s2", manifest_root="root-2")
        reference = reference_from_committed_anchors(Path(self._tmp.name))
        self.assertIsNotNone(reference)
        self.assertEqual(reference["manifest_root"], "root-2")

    def test_anchors_predating_the_field_are_not_a_reference(self) -> None:
        """Every anchor this repository has committed so far is one of these.

        Treating a rootless anchor as a reference would compare today's tree
        against `None` and read that as a broken chain — an outage invented out
        of a field that did not exist yet.
        """
        self._anchor("2026-05-08", snapshot_id=None, manifest_root=None)
        self.assertIsNone(reference_from_committed_anchors(Path(self._tmp.name)))

    def test_a_newer_rootless_anchor_does_not_hide_an_older_real_one(self) -> None:
        """Newest-with-a-root, not newest-then-check: the resumed daily lane
        will emit anchors again, and a single malformed one must not blind the
        gate to the last good reference."""
        self._anchor("2026-05-07", snapshot_id="s1", manifest_root="root-1")
        self._anchor("2026-05-09", snapshot_id=None, manifest_root=None)
        reference = reference_from_committed_anchors(Path(self._tmp.name))
        self.assertIsNotNone(reference)
        self.assertEqual(reference["manifest_root"], "root-1")

    def test_a_hand_written_report_without_frontmatter_is_no_reference(self) -> None:
        self._prose_only_report("2026-05-08")
        self.assertIsNone(reference_from_committed_anchors(Path(self._tmp.name)))

    def test_a_malformed_anchor_does_not_crash_the_gate(self) -> None:
        """A gate that raises on a bad input file is a gate that takes the
        cycle down instead of reporting on it."""
        (self.reports / "2026-05-09.md").write_text("---\n: : not yaml : :\n---\n", encoding="utf-8")
        self._anchor("2026-05-07", snapshot_id="s1", manifest_root="root-1")
        reference = reference_from_committed_anchors(Path(self._tmp.name))
        self.assertIsNotNone(reference)
        self.assertEqual(reference["manifest_root"], "root-1")

    def test_no_reports_directory_is_no_reference(self) -> None:
        self.assertIsNone(reference_from_committed_anchors(Path(self._tmp.name) / "nowhere"))


class ReferenceResolutionTests(unittest.TestCase):
    """Which authority answers, and which failures are evidence rather than noise."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = Path(self._tmp.name)
        self.reports = self.repo / "aria-tools" / "reports" / "daily"
        self.reports.mkdir(parents=True)

    def _anchor(self, date: str, manifest_root: str) -> None:
        front = yaml.safe_dump(
            {"date": date, "state_snapshot_id": "s1", "state_manifest_root": manifest_root},
            sort_keys=True,
        )
        (self.reports / f"{date}.md").write_text(f"---\n{front}---\n\n# anchor\n", encoding="utf-8")

    def test_with_no_store_the_anchor_answers(self) -> None:
        """The ordinary state on every lane today, and it must be silent."""
        self._anchor("2026-08-02", "root-1")
        reference, kind = resolve_continuity_reference(self.repo)
        self.assertIsNotNone(reference)
        self.assertEqual(kind, "daily_anchor")

    def test_with_neither_store_nor_anchor_there_is_no_reference(self) -> None:
        reference, kind = resolve_continuity_reference(self.repo)
        self.assertIsNone(reference)
        self.assertIsNone(kind)

    def test_a_damaged_store_raises_instead_of_falling_back_to_the_anchor(self) -> None:
        """The distinction this resolver exists to keep.

        A store that is ABSENT is the ordinary case and falls through in
        silence. A store that is PRESENT and unreadable is evidence about the
        very thing being judged; downgrading it to a weaker authority and
        calling the result an answer is the same fail-soft that let a
        bootstrap-empty tree pass for a restored one.
        """
        from aria_kernel.state_store import STORE_DIRNAME

        self._anchor("2026-08-02", "root-1")
        # Present, and not a worktree of anything.
        (self.repo / STORE_DIRNAME).mkdir()
        with self.assertRaises(Exception) as caught:
            resolve_continuity_reference(self.repo)
        self.assertNotIsInstance(caught.exception, AssertionError)

    def test_the_store_wins_over_an_anchor_when_both_exist(self) -> None:
        """Strength, not convenience: only the store can see a lost surface."""
        import aria_kernel.memory_gap as module
        from aria_kernel.state_store import STORE_DIRNAME

        self._anchor("2026-08-02", "root-anchor")
        (self.repo / STORE_DIRNAME).mkdir()
        published = _snapshot("s9", surfaces={"cycles": "a"}, manifest_root="root-store")
        with unittest.mock.patch.object(
            module, "reference_from_committed_anchors", side_effect=AssertionError("anchor consulted")
        ):
            with unittest.mock.patch(
                "aria_kernel.state_store.open_state_store", return_value=object()
            ), unittest.mock.patch(
                "aria_kernel.state_store.read_published_snapshot", return_value=published
            ):
                reference, kind = resolve_continuity_reference(self.repo)
        self.assertEqual(kind, "state_branch")
        self.assertEqual(reference["manifest_root"], "root-store")


class EquivalenceCheckTests(unittest.TestCase):
    def test_identical_surfaces_are_equivalent(self) -> None:
        a = _snapshot("s1", surfaces={"cycles": "x", "memory": "y"})
        self.assertEqual(equivalence_check(a, a).differences, ())

    def test_a_differing_tail_hash_is_reported_per_surface(self) -> None:
        a = _snapshot("s1", surfaces={"cycles": "x", "memory": "y"})
        b = _snapshot("s1", surfaces={"cycles": "x", "memory": "CHANGED"})
        result = equivalence_check(a, b)
        self.assertFalse(result.equivalent)
        self.assertTrue(any("memory" in d for d in result.differences), result.differences)
        self.assertFalse(any("cycles" in d for d in result.differences), result.differences)

    def test_a_missing_surface_is_a_difference_not_a_skip(self) -> None:
        """A restore that dropped a surface must not read as equivalent because
        the loop only visited what survived."""
        a = _snapshot("s1", surfaces={"cycles": "x", "memory": "y"})
        b = _snapshot("s1", surfaces={"cycles": "x"})
        result = equivalence_check(a, b)
        self.assertFalse(result.equivalent)
        self.assertTrue(any("memory" in d for d in result.differences), result.differences)


if __name__ == "__main__":
    unittest.main()
