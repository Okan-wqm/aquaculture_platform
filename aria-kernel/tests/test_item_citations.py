"""ARIA-HIGH-1083 — one reading of what a sampled adapter finding cites.

A sampled finding's item carries its location twice: ``path`` (the file) and
``evidence`` (strings ``path:line``, or the adapter's dicts ``{"path", "line"}``;
19 of 19 adapters emit dicts). Four readers of that one shape answer four
different ways at the branch base:

  * ``tier0._item_refs``                       path, strings, dicts as ``path:line``
  * ``judge_fanout._evidence_refs``            path and STRINGS only: every dict dropped
  * ``judgment_funnel._item_cited_refs``       path and STRINGS only: every dict dropped
  * ``feedback_store._evidence_refs_from_item`` dict paths without lines (a human label's input)

Measured at the base (main tip 6c4ca84a1c, ``aria-kernel`` byte-identical at
the branch base): for ``{"path": P, "evidence": [{"path": P, "line": 120}]}`` the
fan-out reads ``[P]`` and the judge is never handed line 120; for an item with
an empty path and dict-only evidence the funnel's verdict-cache key is the
digest of empty text (``sha256:e3b0c442...b855``) before AND after the cited
file changes, so a cached verdict would hit forever on stale code.

These pins define the ONE owner the finding's close condition names
(``aria_kernel.item_citations``, the formatter ``tier0._item_refs`` already
owns, moved) and prove the readers are callers of it, not copies. The owner is
a NEW module, so every test that needs it loads it through ``_owner()``, which
reports its absence as an assertion failure (the pattern of
``tests/invariants/test_atlas_one_owner._generator``): at the base these tests
are red by assertion, not by ``ImportError``. The pins GREEN at the base on
purpose are marked where they are written: the legacy half of A5 and its
"ignores a file it does not cite" twin, and A6 (tier-0's refusal names).
"""
from __future__ import annotations

import importlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any

from aria_kernel.evidence_trust import cited_blobs_code_hash
from aria_kernel.judge_fanout import _evidence_refs
from aria_kernel.judgment_funnel import _cited_code_hash
from aria_kernel.pressure_evidence import split_citable_refs
from aria_kernel.tier0 import tier0_gate

from tests._helpers.git_fixtures import commit_files, make_local_git_repo

_OWNER = "aria_kernel.item_citations"
P = "apps/farm-service/src/x.service.ts"
EMPTY_TEXT_DIGEST = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def _owner() -> ModuleType:
    if importlib.util.find_spec(_OWNER) is None:
        raise AssertionError(f"J4: {_OWNER} does not exist")
    return importlib.import_module(_OWNER)


def _refs(item: dict[str, Any]) -> list[tuple[str, str]]:
    return _owner().item_cited_refs(item)


def _bare(item: dict[str, Any]) -> list[str]:
    return [ref for _kind, ref in _refs(item)]


# (name, item, exact (kind, ref) list, cited_line): A1, A2 and A3 of the spec.
_TABLE: tuple[tuple[str, dict[str, Any], list[tuple[str, str]], int | None], ...] = (
    (
        "adapter dict with a line",
        {"path": P, "evidence": [{"path": P, "line": 120}]},
        [("path", P), ("evidence", f"{P}:120")],
        120,
    ),
    (
        "adapter dict without a line",
        {"path": P, "evidence": [{"path": P}]},
        [("path", P), ("evidence", P)],
        None,
    ),
    (
        "mixed string and dicts of other files",
        {"path": P, "evidence": ["a/b.ts:3", {"path": "a/c.ts", "line": 7}, {"path": "a/d.ts"}]},
        [("path", P), ("evidence", "a/b.ts:3"), ("evidence", "a/c.ts:7"), ("evidence", "a/d.ts")],
        None,
    ),
    (
        "legacy path with a line, duplicated in evidence",
        {"path": "src/f1.py:1", "evidence": ["src/f1.py:1"]},
        [("path", "src/f1.py:1"), ("evidence", "src/f1.py:1")],
        None,
    ),
    (
        "the first line-bearing evidence of the own path names the line",
        {"path": P, "evidence": [{"path": P, "line": 200}, {"path": P, "line": 120}]},
        [("path", P), ("evidence", f"{P}:200"), ("evidence", f"{P}:120")],
        200,
    ),
    (
        "whitespace is stripped from the path and from a string ref",
        {"path": "  " + P + "  ", "evidence": ["  " + P + ":9  "]},
        [("path", P), ("evidence", f"{P}:9")],
        9,
    ),
    (
        "evidence of another file does not name the own path's line",
        {"path": P, "evidence": [{"path": "a/c.ts", "line": 7}, {"path": P, "line": 33}]},
        [("path", P), ("evidence", "a/c.ts:7"), ("evidence", f"{P}:33")],
        33,
    ),
    (
        "a bare own-path string precedes the dict that carries the line",
        {"path": P, "evidence": [P, {"path": P, "line": 4}]},
        [("path", P), ("evidence", P), ("evidence", f"{P}:4")],
        4,
    ),
    (
        "an item with no path has no line of its own",
        {"path": "", "evidence": [{"path": P, "line": 5}]},
        [("evidence", f"{P}:5")],
        None,
    ),
    (
        "a bool, zero, a negative, a string and a float are not lines",
        {
            "path": P,
            "evidence": [
                {"path": P, "line": True},
                {"path": P, "line": 0},
                {"path": P, "line": -3},
                {"path": P, "line": "7"},
                {"path": P, "line": 7.0},
            ],
        },
        [("path", P)] + [("evidence", P)] * 5,
        None,
    ),
    (
        "junk entries are skipped",
        {"path": "  ", "evidence": ["", "  ", {"path": ""}, {"line": 5}, 7, None, ["x"]]},
        [],
        None,
    ),
    (
        "a string where a list belongs is ignored, not iterated per character",
        {"path": P, "evidence": "x"},
        [("path", P)],
        None,
    ),
    (
        "evidence None",
        {"path": P, "evidence": None},
        [("path", P)],
        None,
    ),
)


class TheOwnerReadsTheShapeOnce(unittest.TestCase):
    """A1, A2, A3 — the table, exact."""

    def test_the_refs_are_exactly_the_typed_pairs_in_order(self) -> None:
        for name, item, expected, _line in _TABLE:
            with self.subTest(name):
                self.assertEqual(_refs(item), expected)

    def test_the_cited_line_is_never_invented(self) -> None:
        owner = _owner()
        for name, item, _refs_expected, expected in _TABLE:
            with self.subTest(name):
                self.assertEqual(owner.cited_line(item), expected)

    def test_a_bool_is_not_a_line_the_one_difference_from_the_tier0_reader(self) -> None:
        # ``isinstance(True, int)`` made ``{"line": True}`` read as line 1 in
        # ``tier0._item_refs``; the owner kills that reading.
        item = {"path": P, "evidence": [{"path": P, "line": True}]}
        self.assertEqual(_refs(item), [("path", P), ("evidence", P)])
        self.assertIsNone(_owner().cited_line(item))

    def test_the_kinds_are_the_two_names_tier0_refuses_by(self) -> None:
        owner = _owner()
        self.assertEqual((owner.CITED_PATH, owner.CITED_EVIDENCE), ("path", "evidence"))

    def test_refs_are_not_deduplicated(self) -> None:
        # The fan-out records the repeat as a ``duplicate_ref`` excerpt entry
        # (tests/test_judge_fanout.py), so the owner keeps both.
        item = {"path": "src/f1.py:1", "evidence": ["src/f1.py:1"]}
        self.assertEqual(_bare(item), ["src/f1.py:1", "src/f1.py:1"])


class EveryReaderIsACallerOfTheOwner(unittest.TestCase):
    """A4 — parity, so a reader cannot keep its own loop."""

    def test_the_fanout_hands_out_the_owners_citable_refs(self) -> None:
        for name, item, _refs_expected, _line in _TABLE:
            with self.subTest(name):
                self.assertEqual(_evidence_refs(item), split_citable_refs(_bare(item))[0])

    def test_the_fanout_reads_the_cited_line_of_an_adapter_item(self) -> None:
        # The finding's own first test, one level down: base reads ``[P]``.
        item = {"path": P, "evidence": [{"path": P, "line": 120}]}
        self.assertEqual(_evidence_refs(item), [P, f"{P}:120"])

    def test_the_bare_path_stays_beside_a_line_bearing_ref_and_uncitable_shapes_stay_out(self) -> None:
        # The pin of tests/test_mint_refuses_uncitable_evidence.py, restated
        # through the owner: the mint-side shape law (ARIA-MEDIUM-385) still
        # lives in ``_evidence_refs``, the reading moved.
        item = {"path": P, "evidence": [f"{P}:3", "src/a.ts:10-20"]}
        self.assertEqual(_bare(item), [P, f"{P}:3", "src/a.ts:10-20"])
        self.assertEqual(_evidence_refs(item), [P, f"{P}:3"])


class TheFunnelsCacheKeyTracksTheFile(unittest.TestCase):
    """A4 (second half) and A5 — the verdict-cache key's code half."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h1083-")
        self.addCleanup(self._tmp.cleanup)
        self.repo = make_local_git_repo(Path(self._tmp.name), name="repo")
        self.sha1 = commit_files(self.repo, {"a.ts": "one\n", "b.ts": "two\n"})
        self.sha2 = commit_files(self.repo, {"a.ts": "ONE CHANGED\n"})

    def test_the_funnel_hashes_the_owners_refs(self) -> None:
        items = (
            {"path": "", "evidence": [{"path": "a.ts", "line": 1}]},
            {"path": "", "evidence": ["a.ts:1", {"path": "b.ts"}]},
            {"path": "", "evidence": [{"path": "a.ts"}, {"path": "absent.ts", "line": 2}]},
            {"path": "a.ts", "evidence": [{"path": "a.ts", "line": 1}]},
            {"path": "b.ts", "evidence": ["a.ts:1"]},
            {"path": "a.ts:1", "evidence": ["a.ts:1"]},
            {"path": "a.ts", "evidence": "not a list"},
            {"path": "  ", "evidence": ["", {"path": ""}, 7, None]},
        )
        for item in items:
            for sha in (self.sha1, self.sha2):
                with self.subTest(item=item, sha=sha[:8]):
                    self.assertEqual(
                        _cited_code_hash(item, self.repo, sha),
                        cited_blobs_code_hash(self.repo, _bare(item), sha),
                    )

    def test_a_dict_only_item_is_keyed_by_the_cited_file(self) -> None:
        item = {"path": "", "evidence": [{"path": "a.ts", "line": 1}]}
        before = _cited_code_hash(item, self.repo, self.sha1)
        after = _cited_code_hash(item, self.repo, self.sha2)
        self.assertNotEqual(before, EMPTY_TEXT_DIGEST)
        self.assertNotEqual(after, EMPTY_TEXT_DIGEST)
        self.assertNotEqual(before, after, "a.ts changed between the two commits")

    def test_a_dict_only_item_ignores_a_file_it_does_not_cite(self) -> None:
        item = {"path": "", "evidence": [{"path": "b.ts", "line": 1}]}
        self.assertEqual(
            _cited_code_hash(item, self.repo, self.sha1),
            _cited_code_hash(item, self.repo, self.sha2),
            "b.ts is identical in both commits",
        )

    def test_a_legacy_item_keeps_its_tracking(self) -> None:
        # GREEN at the base on purpose: the string shape was always read.
        item = {"path": "a.ts", "evidence": ["a.ts:1"]}
        self.assertNotEqual(
            _cited_code_hash(item, self.repo, self.sha1),
            _cited_code_hash(item, self.repo, self.sha2),
        )


class TierZeroKeepsItsRefusalNames(unittest.TestCase):
    """A6 — GREEN at the base on purpose: the kinds survive the move.

    The kind a ref carries chooses the refusal's name, so the owner's
    ``("path", ...)`` / ``("evidence", ...)`` pairs are the contract tier-0
    reads; a dict-evidence item is the shape the adapters emit.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h1083-t0-")
        self.addCleanup(self._tmp.cleanup)
        self.repo = make_local_git_repo(Path(self._tmp.name), name="repo")
        self.sha = commit_files(self.repo, {"src/a.ts": "alpha\nbeta\ngamma\n"})

    def test_an_evidence_dict_whose_path_is_absent_is_an_evidence_refusal(self) -> None:
        item = {"path": "src/a.ts", "evidence": [{"path": "src/nope.ts", "line": 3}]}
        verdict = tier0_gate(item, None, self.repo, self.sha)
        self.assertEqual((verdict["status"], verdict["reason"]), ("reject", "evidence_ref_absent_at_target_sha"))

    def test_an_absent_own_path_is_a_path_refusal(self) -> None:
        item = {"path": "src/nope.ts", "evidence": [{"path": "src/a.ts", "line": 2}]}
        verdict = tier0_gate(item, None, self.repo, self.sha)
        self.assertEqual((verdict["status"], verdict["reason"]), ("reject", "cited_path_absent_at_target_sha"))

    def test_a_dict_evidence_item_that_resolves_passes(self) -> None:
        item = {"path": "src/a.ts", "evidence": [{"path": "src/a.ts", "line": 2}]}
        self.assertEqual(tier0_gate(item, None, self.repo, self.sha)["status"], "pass")

    def test_tier0_reads_the_one_owner_not_a_copy(self) -> None:
        # The retired private reader must be gone: a second spelling of the
        # shape is exactly what the owner exists to end.
        import aria_kernel.tier0 as tier0

        _owner()
        self.assertFalse(hasattr(tier0, "_item_refs"), "tier0._item_refs is retired; the owner reads the shape")

    def test_the_funnel_reads_the_one_owner_not_a_copy(self) -> None:
        import aria_kernel.judgment_funnel as funnel

        _owner()
        self.assertFalse(
            hasattr(funnel, "_item_cited_refs"),
            "judgment_funnel._item_cited_refs is retired; the owner reads the shape",
        )


if __name__ == "__main__":
    unittest.main()
