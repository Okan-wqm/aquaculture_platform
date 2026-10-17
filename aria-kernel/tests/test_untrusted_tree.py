"""ARIA-HIGH-527 — the host reaches a tree the agent can write only without following a link.

`git_containment.publish_quarantine` walks the replica whole before it
touches anything (pinned with planted links in `test_git_containment`); these
pins prove the reader's own guarantee underneath that walk, entry by entry:
a read, an unlink or a move whose path crosses a link — a directory swapped
for a link after the walk, a file that is a link — is refused by name and
acts on nothing outside the tree; a FIFO is refused without being waited on;
a component that is a regular file is refused where a directory is walked.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.untrusted_tree import UntrustedEntryRefused, UntrustedTree


class UntrustedTreeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-527-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tree = self.root / "tree"
        (self.tree / "objects" / "ab").mkdir(parents=True)
        (self.tree / "objects" / "ab" / "cd").write_bytes(b"inside\n")
        self.outside = self.root / "outside"
        self.outside.mkdir()
        (self.outside / "cd").write_bytes(b"sentinel\n")
        (self.outside / "file").write_bytes(b"sentinel file\n")

    def _refused(self, call, *args) -> UntrustedEntryRefused:
        with UntrustedTree.opened(self.tree) as tree, self.assertRaises(UntrustedEntryRefused) as refused:
            call(tree, *args)
        return refused.exception

    def test_a_walk_lists_regular_files_and_refuses_a_link_by_name(self) -> None:
        (self.tree / "objects" / "pack").mkdir()
        (self.tree / "objects" / "pack" / "x.pack").write_bytes(b"p")
        with UntrustedTree.opened(self.tree) as tree:
            self.assertEqual(tree.regular_files("objects"), ("objects/ab/cd", "objects/pack/x.pack"))
            self.assertEqual(tree.regular_files("refs/heads"), (), "an absent subtree is empty")
            self.assertEqual(tree.regular_files("objects/ab/cd"), ("objects/ab/cd",))
        (self.tree / "objects" / "ef").symlink_to(self.outside, target_is_directory=True)
        refused = self._refused(UntrustedTree.regular_files, "objects")
        self.assertEqual((refused.kind, refused.relative), ("symlink", "objects/ef"))

    def test_an_unlink_through_a_directory_swapped_for_a_link_acts_on_nothing_outside(self) -> None:
        # The walk saw `objects/ab` as a directory; it is a link by the time
        # of the unlink (the race the up-front walk alone would not close).
        shutil.rmtree(self.tree / "objects" / "ab")
        (self.tree / "objects" / "ab").symlink_to(self.outside, target_is_directory=True)
        refused = self._refused(UntrustedTree.unlink, "objects/ab/cd")
        self.assertEqual((refused.kind, refused.relative), ("symlink", "objects/ab"))
        self.assertEqual((self.outside / "cd").read_bytes(), b"sentinel\n")

    def test_a_move_of_a_link_or_through_a_link_is_refused_and_the_target_never_gains_it(self) -> None:
        target = self.root / "store" / "ab" / "cd"
        (self.tree / "objects" / "ab" / "cd").unlink()
        (self.tree / "objects" / "ab" / "cd").symlink_to(self.outside / "file")
        refused = self._refused(UntrustedTree.move_out, "objects/ab/cd", target)
        self.assertEqual((refused.kind, refused.relative), ("symlink", "objects/ab/cd"))
        self.assertFalse(target.exists() or target.is_symlink())
        shutil.rmtree(self.tree / "objects" / "ab")
        (self.tree / "objects" / "ab").symlink_to(self.outside, target_is_directory=True)
        refused = self._refused(UntrustedTree.move_out, "objects/ab/cd", target)
        self.assertEqual(refused.relative, "objects/ab")
        self.assertEqual((self.outside / "cd").read_bytes(), b"sentinel\n")
        self.assertFalse(target.exists() or target.is_symlink())

    def test_a_read_of_a_link_or_a_fifo_is_refused_without_opening_it(self) -> None:
        (self.tree / "HEAD").symlink_to(self.outside / "file")
        refused = self._refused(UntrustedTree.read, "HEAD")
        self.assertEqual((refused.kind, refused.relative), ("symlink", "HEAD"))
        (self.tree / "HEAD").unlink()
        os.mkfifo(self.tree / "HEAD")
        refused = self._refused(UntrustedTree.read, "HEAD")
        self.assertEqual((refused.kind, refused.relative), ("fifo", "HEAD"))

    def test_a_regular_file_where_a_directory_is_walked_is_refused(self) -> None:
        (self.tree / "refs").write_bytes(b"not a directory\n")
        refused = self._refused(UntrustedTree.regular_files, "refs/heads")
        self.assertEqual((refused.kind, refused.relative), ("regular_file", "refs"))

    def test_a_move_out_never_overwrites_and_a_plain_file_moves(self) -> None:
        target = self.root / "store" / "ab" / "cd"
        with UntrustedTree.opened(self.tree) as tree:
            self.assertTrue(tree.move_out("objects/ab/cd", target))
        self.assertEqual(target.read_bytes(), b"inside\n")
        (self.tree / "objects" / "ab" / "cd").write_bytes(b"second\n")
        with UntrustedTree.opened(self.tree) as tree:
            self.assertFalse(tree.move_out("objects/ab/cd", target))
        self.assertEqual(target.read_bytes(), b"inside\n", "the store's copy is never overwritten")
        self.assertFalse((self.tree / "objects" / "ab" / "cd").exists(), "the duplicate is dropped")

    def test_the_root_itself_is_opened_without_following_a_link(self) -> None:
        linked = self.root / "linked-tree"
        linked.symlink_to(self.tree, target_is_directory=True)
        with self.assertRaises(OSError):
            with UntrustedTree.opened(linked):
                pass


if __name__ == "__main__":
    unittest.main()
