"""The hardened git reads root's checkout as another account, and nothing wider.

The T2 probe runs as ``gharunner`` over the root-owned ``/var/lib/aria/code``.
Git refused it as "dubious ownership" because the hardened environment drops
the system ``safe.directory``, so the probe reported
``allowed_signers_unavailable`` every hour. The exception is now named on the
command line for a checkout the owner holds at every hop git takes from it;
these tests pin both directions: the held checkout is trusted (by git itself,
not only by the predicate), and a tree anyone else could rewrite or redirect
keeps git's refusal.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import main_anchor

NOBODY_UID = 65534


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


def _repo(path: Path) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q", "-b", "main")
    (path / "allowed_signers").write_text("op@aria.test ssh-ed25519 AAAA\n", encoding="utf-8")
    _git(path, "add", "allowed_signers")
    _git(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed")
    _git(path, "update-ref", main_anchor.MAIN_TRACKING_REF, "HEAD")
    return path


class RootHeldCheckoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-anchor-held-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.repo = _repo(self.base / "repo")
        self.me = os.geteuid()
        self.other = self.me + 1

    def held(self, repo: Path, *, owner: int | None = None, reader: int | None = None) -> str | None:
        return main_anchor._root_held_checkout(
            repo, owner_uid=self.me if owner is None else owner, reader_uid=self.other if reader is None else reader,
        )

    def chmod_during(self, path: Path, mode: int) -> None:
        original = path.lstat().st_mode & 0o7777
        path.chmod(mode)
        self.addCleanup(path.chmod, original)

    def test_a_checkout_its_owner_holds_is_named_for_another_reader(self) -> None:
        self.assertEqual(self.held(self.repo), str(self.repo))

    def test_the_owner_reading_its_own_checkout_needs_no_exception(self) -> None:
        self.assertIsNone(self.held(self.repo, reader=self.me))

    def test_a_checkout_another_account_owns_is_not_trusted(self) -> None:
        self.assertIsNone(self.held(self.repo, owner=self.other, reader=self.me + 2))

    def test_a_checkout_or_git_directory_others_can_write_keeps_the_refusal(self) -> None:
        for writable, mode in ((self.repo, 0o777), (self.repo / ".git", 0o777), (self.repo, 0o1777)):
            with self.subTest(path=writable.name, mode=oct(mode)):
                original = writable.stat().st_mode & 0o7777
                writable.chmod(mode)
                try:
                    # A sticky bit excuses a writable PARENT, never the checked node itself.
                    self.assertIsNone(self.held(self.repo))
                finally:
                    writable.chmod(original)

    def test_a_symlinked_path_is_resolved_once_and_the_real_path_is_named(self) -> None:
        link = self.base / "link"
        link.symlink_to(self.repo)
        self.assertEqual(self.held(link), str(self.repo))

    def test_a_symlinked_dot_git_is_refused_not_followed(self) -> None:
        other = _repo(self.base / "other")
        top = self.base / "top"
        top.mkdir()
        (top / ".git").symlink_to(other / ".git")
        self.assertIsNone(self.held(top))

    def test_a_worktree_is_held_only_with_its_git_directory(self) -> None:
        worktree = self.base / "code"
        _git(self.repo, "worktree", "add", "-q", "--detach", str(worktree), "HEAD")
        self.assertTrue((worktree / ".git").is_file())
        self.assertEqual(self.held(worktree), str(worktree))
        self.chmod_during(self.repo / ".git" / "worktrees" / "code", 0o777)
        self.assertIsNone(self.held(worktree))

    def _layout_with_common_outside_the_chain(self) -> tuple[Path, Path, Path]:
        """A worktree whose git directory and common directory sit in separate trees (relative pointers)."""
        top, gitdir, common = self.base / "wt", self.base / "gd", self.base / "common"
        for path in (top, gitdir, common):
            path.mkdir()
        (top / ".git").write_text("gitdir: ../gd\n", encoding="utf-8")
        (gitdir / "commondir").write_text("../common\n", encoding="utf-8")
        return top, gitdir, common

    def test_a_common_directory_outside_the_git_directory_chain_is_checked(self) -> None:
        top, gitdir, common = self._layout_with_common_outside_the_chain()
        self.assertEqual(self.held(top), str(top))
        self.chmod_during(common, 0o777)
        self.assertIsNone(self.held(top))

    def test_pointer_files_others_can_rewrite_are_refused(self) -> None:
        top, gitdir, _ = self._layout_with_common_outside_the_chain()
        for pointer in (top / ".git", gitdir / "commondir"):
            with self.subTest(pointer=pointer.name):
                original = pointer.stat().st_mode & 0o7777
                pointer.chmod(0o666)
                try:
                    self.assertIsNone(self.held(top))
                finally:
                    pointer.chmod(original)

    def test_a_pointer_that_is_not_a_small_regular_file_is_refused_without_blocking(self) -> None:
        top, gitdir, _ = self._layout_with_common_outside_the_chain()
        (gitdir / "commondir").unlink()
        os.mkfifo(gitdir / "commondir", 0o644)
        started = time.monotonic()
        self.assertIsNone(self.held(top))
        self.assertLess(time.monotonic() - started, 5)
        (gitdir / "commondir").unlink()
        (gitdir / "commondir").write_text("../common" + " " * 5000, encoding="utf-8")
        self.assertIsNone(self.held(top))
        (top / ".git").unlink()
        (top / ".git").write_text("not a gitfile\n", encoding="utf-8")
        self.assertIsNone(self.held(top))

    def test_git_runs_in_and_trusts_exactly_the_held_path(self) -> None:
        calls: list[list[str]] = []

        def fake_run(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with mock.patch.object(main_anchor.subprocess, "run", side_effect=fake_run):
            with mock.patch.object(main_anchor, "_root_held_checkout", return_value="/held/real"):
                main_anchor._git("/some/link", "rev-parse", "HEAD")
            with mock.patch.object(main_anchor, "_root_held_checkout", return_value=None):
                main_anchor._git("/some/link", "rev-parse", "HEAD")
        held_argv, plain_argv = calls
        self.assertEqual(held_argv[2:6], ["-c", "safe.directory=/held/real", "-C", "/held/real"])
        self.assertNotIn("-c", plain_argv)
        self.assertEqual(plain_argv[2:4], ["-C", "/some/link"])


class GitHonoursTheNamedExceptionTests(unittest.TestCase):
    """Git itself, as a reader it treats as another account (GIT_TEST_ASSUME_DIFFERENT_OWNER), runs in CI without root."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-anchor-git-")
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.repo, self.sibling = _repo(base / "a"), _repo(base / "b")
        self.link = base / "link"
        self.link.symlink_to(self.repo)
        self.env = {**os.environ, "GIT_TEST_ASSUME_DIFFERENT_OWNER": "1", "GIT_CONFIG_NOSYSTEM": "1"}
        if self._rev_parse(self.repo).returncode == 0:
            self.skipTest("this git does not honour GIT_TEST_ASSUME_DIFFERENT_OWNER")

    def _rev_parse(self, where: Path | str, *trust: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *trust, "-C", str(where), "rev-parse", "HEAD"],
                              capture_output=True, text=True, env=self.env, check=False)

    def test_the_named_real_path_is_trusted_through_a_symlink_and_a_sibling_is_not(self) -> None:
        held = main_anchor._root_held_checkout(self.link, owner_uid=os.geteuid(), reader_uid=os.geteuid() + 1)
        self.assertEqual(held, str(self.repo))
        trust = ("-c", f"safe.directory={held}")
        self.assertIn("dubious ownership", self._rev_parse(self.repo).stderr)
        self.assertEqual(self._rev_parse(held, *trust).returncode, 0)
        self.assertEqual(self._rev_parse(self.link, *trust).returncode, 0)
        self.assertIn("dubious ownership", self._rev_parse(self.sibling, *trust).stderr)


@unittest.skipUnless(os.geteuid() == 0, "needs root to hand a checkout to another account")
class RootHeldCheckoutReadAsAnotherAccountTests(unittest.TestCase):
    """End to end through main_anchor and git: an unprivileged reader over root's checkout."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-anchor-held-e2e-")
        self.addCleanup(self.tmp.cleanup)
        Path(self.tmp.name).chmod(0o755)
        self.repo = _repo(Path(self.tmp.name) / "repo")
        self.tip = _git(self.repo, "rev-parse", "HEAD").strip()

    def _main_tip_as_nobody(self) -> str:
        # main_anchor imports only the standard library, so the reader runs a
        # copy it can read wherever the kernel source itself is checked out.
        module_dir = Path(self.tmp.name) / "module"
        module_dir.mkdir()
        shutil.copy2(Path(main_anchor.__file__), module_dir / "main_anchor.py")
        module_dir.chmod(0o755)
        (module_dir / "main_anchor.py").chmod(0o644)

        def drop_to_nobody() -> None:
            os.setgroups([])
            os.setgid(NOBODY_UID)
            os.setuid(NOBODY_UID)

        code = "import sys, main_anchor; print(main_anchor.main_tip(sys.argv[1]))"
        proc = subprocess.run(
            [sys.executable, "-c", code, str(self.repo)], capture_output=True, text=True, check=True,
            cwd="/", env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/nonexistent",
                          "PYTHONPATH": str(module_dir), "PYTHONDONTWRITEBYTECODE": "1"},
            preexec_fn=drop_to_nobody,
        )
        return proc.stdout.strip()

    def test_an_unprivileged_reader_reads_roots_checkout(self) -> None:
        self.assertEqual(self._main_tip_as_nobody(), self.tip)

    def test_root_keeps_gits_refusal_of_a_checkout_another_account_owns(self) -> None:
        for path in (self.repo, *self.repo.rglob("*")):
            os.lchown(path, NOBODY_UID, NOBODY_UID)
        self.assertIsNone(main_anchor.main_tip(self.repo))


if __name__ == "__main__":
    unittest.main()
