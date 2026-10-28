"""ARIA-LOW-741 (package F3.1) — the ONE reader of a change's per-path churn lives in ``change_paths``.

WHAT BASE DOES TODAY. ``change_paths`` owns the argv and the parse of a change's
path set (``name_status_args`` / ``parse_name_status_z``, ARIA-CRITICAL-214) and
nothing in the kernel or the executor counts a change's added and deleted lines
(``git grep numstat`` over ``aria-kernel/aria_kernel`` and ``tools/aria-poc`` is
empty). ``name_status_args`` takes no ``churn`` switch, ``parse_change_z`` and
``ChangeChurn`` do not exist.

WHAT THIS PINS. One git call (``diff --raw --numstat -z --no-renames --no-ext-diff``)
carries both facts, and ONE parser reads it:

* ``name_status_args(base, head, churn=True)`` is that argv, the plain spelling is
  byte-for-byte unchanged (the risk classifier and the self-revert read the cheap
  one: numstat costs ~20x on a 4k-path change);
* ``parse_change_z(output)`` returns the same ``(status, path)`` entries
  ``parse_name_status_z`` returns for the same change, plus a ``ChangeChurn``
  whose entries are ``(path, added, deleted)`` (``None``/``None`` for a binary
  file); records are classified by their first character, never by position, a tab
  or a leading ``:`` in a path survives, and every record it cannot place is
  refused by name (``change_paths_output_malformed``), never skipped.

THE ORACLE is the CHURN fixture below, whose per-path counts were checked once
with real git while the F3.1 specification was written (and are re-run here, not
read back from the code under test).

NEW API. Every test below that needs ``ChangeChurn`` / ``parse_change_z`` / the
``churn`` switch reaches them through ``_api()``, so base is red by assertion
("does not exist"), not by ``ImportError``/``TypeError``. Two tests pin the CHEAP
spelling and are paired with the new one, so they too fail at base for the defect's
reason (the combined spelling is absent).
"""
from __future__ import annotations

import dataclasses
import inspect
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import change_paths
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit

# (path, status, added, deleted) — sorted by path; None/None is a binary file.
CHURN = (
    ("a.txt", "M", 2, 1),
    ("bin.dat", "A", None, None),
    ("empty.txt", "A", 0, 0),
    ("gone.txt", "D", 0, 2),
    ("keep.sh", "M", 0, 0),
    ("moved name.txt", "A", 3, 0),
    ("new.txt", "A", 2, 0),
    ("old name.txt", "D", 0, 3),
    ("tab\tname.txt", "M", 1, 0),
)
CHURN_ENTRIES = tuple((status, path) for path, status, _a, _d in CHURN)
CHURN_COUNTS = tuple((path, added, deleted) for path, _s, added, deleted in CHURN)

_PLAIN = ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff"]
_CHURN = ["diff", "--raw", "--numstat", "-z", "--no-renames", "--no-ext-diff"]
_SHA_A, _SHA_B = "1" * 7, "2" * 7


def _api():
    """The new surface of ``change_paths`` — absent at base, which is an assertion, not an import error."""
    missing = [name for name in ("ChangeChurn", "parse_change_z") if not hasattr(change_paths, name)]
    if missing:
        raise AssertionError(f"F3.1: aria_kernel.change_paths has no {' / '.join(missing)} (the numstat owner does not exist)")
    if "churn" not in inspect.signature(change_paths.name_status_args).parameters:
        raise AssertionError("F3.1: change_paths.name_status_args has no `churn` switch (the combined read does not exist)")
    return change_paths


def _raw(status: str, path: str) -> str:
    return f":100644 100644 {_SHA_A} {_SHA_B} {status}\0{path}\0"


def _num(path: str, added: object, deleted: object) -> str:
    return f"{added}\t{deleted}\t{path}\0"


CHURN_BASE_FILES = {
    "a.txt": "1\n2\n3\n", "gone.txt": "x\ny\n", "old name.txt": "r1\nr2\nr3\n",
    "keep.sh": "#!/bin/sh\n", "tab\tname.txt": "t\n",
}


def apply_churn_edits(repo: Path) -> None:
    """Edit ``repo`` from the CHURN base to the CHURN tip and stage it all (the caller commits).

    Nine paths: a modified file, a deleted one, a rename (as a deletion AND an addition under
    ``--no-renames``), a mode-only change, an empty file, a binary one, a new one, and a path holding a tab.
    """
    (repo / "a.txt").write_text("1\nB\n3\n4\n", encoding="utf-8")
    _git(["rm", "-q", "gone.txt"], cwd=repo)
    _git(["mv", "old name.txt", "moved name.txt"], cwd=repo)
    (repo / "keep.sh").chmod(0o755)
    (repo / "new.txt").write_text("n1\nn2\n", encoding="utf-8")
    (repo / "bin.dat").write_bytes(bytes([0, 1, 2]))
    (repo / "empty.txt").write_text("", encoding="utf-8")
    (repo / "tab\tname.txt").write_text("t\nu\n", encoding="utf-8")
    _git(["add", "-A"], cwd=repo)


class _ChurnRepo(unittest.TestCase):
    """The CHURN fixture: a real repository, built once, whose base and tip differ in nine paths."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(prefix="aria-f31-churn-")
        cls.repo = make_repo_with_initial_commit(Path(cls._tmp.name), dict(CHURN_BASE_FILES))
        cls.base = _git(["rev-parse", "HEAD"], cwd=cls.repo).stdout.strip()
        apply_churn_edits(cls.repo)
        _git(["commit", "-q", "-m", "the change"], cwd=cls.repo)
        cls.tip = _git(["rev-parse", "HEAD"], cwd=cls.repo).stdout.strip()
        # The repository's own rename detection must not decide what the readers see.
        _git(["config", "diff.renames", "copies"], cwd=cls.repo)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def run_git(self, argv: list[str]) -> str:
        return subprocess.run(["git", *argv], cwd=self.repo, capture_output=True, text=True, check=True).stdout


class TheCombinedReadCountsEveryPathTests(_ChurnRepo):
    def test_the_combined_read_agrees_with_the_plain_read_and_counts_every_path(self) -> None:
        cp = _api()
        combined = self.run_git(cp.name_status_args(self.base, self.tip, churn=True))
        plain = self.run_git(cp.name_status_args(self.base, self.tip))
        entries, churn = cp.parse_change_z(combined)
        # Parity with the one path reader: the same (status, path) set for the same change.
        self.assertEqual(sorted(entries), sorted(cp.parse_name_status_z(plain)))
        # The independent oracle: nine paths, the rename as a deletion AND an addition, the tab path verbatim.
        self.assertEqual(sorted(entries), sorted(CHURN_ENTRIES))
        self.assertEqual(sorted(churn.entries), sorted(CHURN_COUNTS))
        self.assertEqual(sorted(churn.paths), sorted(path for path, *_rest in CHURN_COUNTS))

    def test_a_binary_file_is_unmeasured_not_zero_and_an_empty_file_is_zero(self) -> None:
        cp = _api()
        _entries, churn = cp.parse_change_z(self.run_git(cp.name_status_args(self.base, self.tip, churn=True)))
        counts = {path: (added, deleted) for path, added, deleted in churn.entries}
        self.assertEqual(counts["bin.dat"], (None, None))
        self.assertEqual(counts["empty.txt"], (0, 0))
        # A mode-only change is a path of the change with zero lines.
        self.assertEqual(counts["keep.sh"], (0, 0))

    def test_churn_is_a_frozen_value(self) -> None:
        cp = _api()
        churn = cp.ChangeChurn(entries=(("a.txt", 1, 2),))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            churn.entries = ()  # type: ignore[misc]
        self.assertEqual(churn, cp.ChangeChurn(entries=(("a.txt", 1, 2),)))


class RecordsAreClassifiedByTheirFirstCharacterTests(unittest.TestCase):
    """Section order is git's business, not the parser's: ``:`` opens a raw header, anything else is numstat."""

    def _expected(self) -> tuple[list[tuple[str, str]], list[tuple[str, int | None, int | None]]]:
        return [("A", "b.txt"), ("M", "a.txt")], [("a.txt", 1, 2), ("b.txt", None, None)]

    def _check(self, output: str) -> None:
        cp = _api()
        entries, churn = cp.parse_change_z(output)
        want_entries, want_churn = self._expected()
        self.assertEqual(sorted(entries), sorted(want_entries))
        self.assertEqual(sorted(churn.entries), sorted(want_churn))

    def test_git_order_raw_section_then_numstat_section(self) -> None:
        self._check(_raw("M", "a.txt") + _raw("A", "b.txt") + _num("a.txt", 1, 2) + _num("b.txt", "-", "-"))

    def test_swapped_sections_numstat_first(self) -> None:
        self._check(_num("a.txt", 1, 2) + _num("b.txt", "-", "-") + _raw("M", "a.txt") + _raw("A", "b.txt"))

    def test_interleaved_records(self) -> None:
        self._check(_raw("M", "a.txt") + _num("b.txt", "-", "-") + _raw("A", "b.txt") + _num("a.txt", 1, 2))

    def test_a_path_that_starts_with_a_colon_or_holds_a_tab_survives_verbatim(self) -> None:
        cp = _api()
        output = (_raw("A", ":odd.txt") + _raw("M", "t\tab.txt")
                  + _num(":odd.txt", 3, 0) + _num("t\tab.txt", 1, 1))
        entries, churn = cp.parse_change_z(output)
        self.assertEqual(sorted(entries), [("A", ":odd.txt"), ("M", "t\tab.txt")])
        self.assertEqual(sorted(churn.entries), [(":odd.txt", 3, 0), ("t\tab.txt", 1, 1)])


class WhatTheParserCannotPlaceIsRefusedByNameTests(unittest.TestCase):
    def test_every_malformed_stream_is_refused_and_the_control_is_not(self) -> None:
        cp = _api()
        # The control: the smallest well-formed stream parses.
        entries, churn = cp.parse_change_z(_raw("M", "p") + _num("p", 1, 2))
        self.assertEqual((list(entries), list(churn.entries)), ([("M", "p")], [("p", 1, 2)]))
        refused = {
            "a rename status the argv never asks for": _raw("R", "p") + _num("p", 1, 2),
            "an unknown status letter": _raw("Z", "p") + _num("p", 1, 2),
            "a numstat record with no path": _raw("M", "p") + "1\t2\0",
            "non-numeric counts": _raw("M", "p") + "x\ty\tp\0",
            "a negative count": _raw("M", "p") + _num("p", -1, 2),
            "a raw path with no numstat record": _raw("M", "p") + _raw("M", "q") + _num("p", 1, 2),
            "a numstat path absent from the raw section": _raw("M", "p") + _num("p", 1, 2) + _num("q", 1, 2),
            "the same path twice in the raw section": _raw("M", "p") + _raw("M", "p") + _num("p", 1, 2),
            "the same path twice in the numstat section": _raw("M", "p") + _num("p", 1, 2) + _num("p", 3, 4),
            "a raw header with no path field (odd field count)": _num("p", 1, 2) + f":100644 100644 {_SHA_A} {_SHA_B} M\0",
        }
        for name, output in refused.items():
            with self.subTest(malformed=name):
                with self.assertRaises(GovernanceError) as raised:
                    cp.parse_change_z(output)
                self.assertTrue(str(raised.exception).startswith("change_paths_output_malformed"), str(raised.exception))


class TheTwoSpellingsOfTheArgvTests(unittest.TestCase):
    BASE, HEAD = "a" * 40, "b" * 40

    def test_the_plain_spelling_is_unchanged_and_the_churn_spelling_is_raw_plus_numstat(self) -> None:
        cp = _api()
        # The cheap argv the risk classifier and the self-revert read: byte for byte.
        self.assertEqual(cp.name_status_args(self.BASE, self.HEAD), [*_PLAIN, self.BASE, self.HEAD, "--"])
        self.assertEqual(cp.name_status_args(self.BASE, self.HEAD, churn=False), [*_PLAIN, self.BASE, self.HEAD, "--"])
        # The one combined read: --raw AND --numstat in one stream (--name-status --numstat prints no counts).
        self.assertEqual(cp.name_status_args(self.BASE, self.HEAD, churn=True), [*_CHURN, self.BASE, self.HEAD, "--"])

    def test_a_revision_that_could_be_an_option_is_refused_in_both_spellings(self) -> None:
        cp = _api()
        for churn in (False, True):
            for base, head in (("--output=x", self.HEAD), (self.BASE, "-p"), ("", self.HEAD)):
                with self.subTest(churn=churn, base=base, head=head):
                    with self.assertRaisesRegex(GovernanceError, "^change_paths_revision_invalid"):
                        cp.name_status_args(base, head, churn=churn)

    def test_the_risk_reader_still_asks_for_the_cheap_spelling(self) -> None:
        cp = _api()
        done = subprocess.CompletedProcess(args=[], returncode=0, stdout="M\0a.txt\0", stderr="")
        with mock.patch.object(change_paths.subprocess, "run", return_value=done) as run:
            change = cp.read_change_paths(Path("."), self.BASE, self.HEAD)
        argv = run.call_args.args[0]
        plain = cp.name_status_args(self.BASE, self.HEAD)
        self.assertEqual(argv[-len(plain):], plain)
        self.assertNotIn("--numstat", argv)
        self.assertNotIn("--raw", argv)
        self.assertEqual(change.entries, (("M", "a.txt"),))
        # ... and the combined read is a different argv: the readers could not have shared one by accident.
        self.assertNotEqual(cp.name_status_args(self.BASE, self.HEAD, churn=True), plain)


if __name__ == "__main__":
    unittest.main()
