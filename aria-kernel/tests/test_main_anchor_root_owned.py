"""ARIA-HIGH-281 — a non-root reader reads ``main`` from a checkout only root can write.

WHY. The hourly T2 probe runs as ``gharunner`` and reads its anchor (the
allowed-signers file on ``main``) from ``/var/lib/aria/code``, a checkout root
owns on purpose so the account under test cannot edit it. git's
dubious-ownership guard refuses every repository the caller does not own, and
``scrubbed_git_env`` drops the system config (``GIT_CONFIG_NOSYSTEM=1``), so
the read answered ``None`` and the probe reported ``allowed_signers_unavailable``
on every run: the hourly measurement never held.

WHAT this pins. ``main_anchor._git`` names the checkout in a command-line
``safe.directory`` exactly when root is the only account that can change what
git will read there (work tree, ``.git`` or gitfile, gitdir, common dir,
``config``, ``config.worktree`` and every ancestor directory), and the caller is
not root. A checkout another account owns or can write stays refused.

The argv tests drive the decision through a stat view of real temp layouts and
run anywhere. The live tests hand a real root-owned checkout to a real non-root
uid through the real git; they need root (to own the checkout and drop to
another uid) and skip, saying so, elsewhere.
"""
from __future__ import annotations

import ast
import contextlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import main_anchor

_CALLER = 1000
_OTHER = 1001
_NOBODY = 65534
_SIGNERS = "signers"


def _copy_anchor_package(lib: Path) -> None:
    """``main_anchor`` and the kernel modules it imports (relatively, transitively)
    as a package under ``lib``: what the non-root reader needs, and nothing of
    the kernel package it cannot be shown to need (ARIA-LOW-518 made the anchor
    read object ids through ``git_object_id``)."""
    package = lib / "anchor_pkg"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    kernel = Path(main_anchor.__file__).parent
    pending, copied = ["main_anchor"], set()
    while pending:
        name = pending.pop()
        if name in copied:
            continue
        copied.add(name)
        source = kernel / f"{name}.py"
        shutil.copyfile(source, package / source.name)
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module:
                pending.append(node.module.split(".")[0])


def _git_cmd(*args: str, cwd: Path) -> str:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(cwd), "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(["git", "-c", "user.email=t@aria.test", "-c", "user.name=t", *args], cwd=cwd, env=env,
                          check=True, capture_output=True, text=True).stdout.strip()


def _make_layouts(root: Path) -> tuple[Path, Path, str]:
    """A clone and a linked worktree of it (the host's /var/lib/aria/code shape), ``origin/main`` set."""
    clone, linked = root / "clone", root / "linked"
    clone.mkdir()
    _git_cmd("init", "-q", "-b", "main", str(clone), cwd=root)
    (clone / _SIGNERS).write_text("op@aria.test ssh-ed25519 AAAA\n", encoding="utf-8")
    _git_cmd("add", _SIGNERS, cwd=clone)
    _git_cmd("commit", "-q", "-m", "anchor", cwd=clone)
    _git_cmd("update-ref", main_anchor.MAIN_TRACKING_REF, "HEAD", cwd=clone)
    _git_cmd("worktree", "add", "-q", "--detach", str(linked), "main", cwd=clone)
    _git_cmd("config", "extensions.worktreeConfig", "true", cwd=clone)
    _git_cmd("config", "--worktree", "aria.test", "1", cwd=linked)
    return clone, linked, _git_cmd("rev-parse", "HEAD", cwd=clone)


def _real(path: Path | str) -> str:
    return os.path.realpath(path)


@contextlib.contextmanager
def _seen_as(*, caller: int = _CALLER, owners: dict[str, int] | None = None, modes: dict[str, int] | None = None):
    """Every path root-owned with no group/other write bit, except ``owners``/``modes``; the caller is ``caller``."""
    real_lstat = os.lstat
    owners, modes = owners or {}, modes or {}

    def lstat(path, *args, **kwargs):
        seen = real_lstat(path, *args, **kwargs)
        key = os.path.normpath(os.fspath(path))
        mode = modes.get(key, seen.st_mode & ~0o022)
        return os.stat_result((mode, seen.st_ino, seen.st_dev, seen.st_nlink, owners.get(key, 0), seen.st_gid,
                               seen.st_size, int(seen.st_atime), int(seen.st_mtime), int(seen.st_ctime)))

    with mock.patch.object(main_anchor.os, "lstat", lstat), \
            mock.patch.object(main_anchor.os, "geteuid", return_value=caller):
        yield


class SafeDirectoryDecisionTests(unittest.TestCase):
    """The argv git receives: a scoped ``safe.directory`` only for a checkout only root can change."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-anchor-owner-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clone, self.linked, self.tip = _make_layouts(self.tmp)
        self.gitdir = Path(_real(self.clone / ".git" / "worktrees" / "linked"))
        self.common = Path(_real(self.clone / ".git"))

    def _flags(self, repo: Path, **seen) -> list[str]:
        done = subprocess.CompletedProcess([], 0, (self.tip + "\n").encode(), b"")
        with _seen_as(**seen), mock.patch.object(main_anchor.subprocess, "run", return_value=done) as run:
            main_anchor.main_tip(repo)
        argv = run.call_args.args[0]
        return [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == "-c"]

    def test_a_checkout_only_root_can_write_is_read_with_a_scoped_safe_directory(self) -> None:
        for repo in (self.clone, self.linked):
            with self.subTest(layout=repo.name):
                self.assertEqual(self._flags(repo), [f"safe.directory={_real(repo)}"])

    def test_a_checkout_another_account_owns_stays_refused(self) -> None:
        for path in (self.linked, self.linked / ".git", self.gitdir, self.gitdir / "commondir", self.common,
                     self.common / "config", self.gitdir / "config.worktree", self.tmp):
            with self.subTest(owner_of=str(path)):
                self.assertEqual(self._flags(self.linked, owners={_real(path): _OTHER}), [])

    def test_a_common_dir_outside_the_gitdir_ancestry_is_judged_itself(self) -> None:
        # The common dir is usually an ancestor of a linked gitdir, so the ancestor walk covers it; a
        # `commondir` naming a directory elsewhere is covered only by the common dir's own check.
        common = self.tmp / "common-elsewhere"
        shutil.copytree(self.common, common, symlinks=True)
        (self.gitdir / "commondir").write_text(f"{common}\n", encoding="utf-8")
        self.assertEqual(self._flags(self.linked), [f"safe.directory={_real(self.linked)}"])
        self.assertEqual(self._flags(self.linked, owners={_real(common): _OTHER}), [])
        for write_bit in (stat.S_IWGRP, stat.S_IWOTH):
            with self.subTest(write_bit=oct(write_bit)):
                self.assertEqual(self._flags(self.linked, modes={_real(common): stat.S_IFDIR | 0o755 | write_bit}), [])

    def test_a_symlinked_checkout_path_is_named_by_its_real_path(self) -> None:
        # git compares safe.directory with the physical directory it changed into; a flag naming the link
        # would neither admit the read nor stay bound to the checkout that was judged if the link moved.
        link = self.tmp / "via-link-to-clone"
        link.symlink_to(self.clone)
        self.assertEqual(self._flags(link), [f"safe.directory={_real(self.clone)}"])

    def test_a_root_owned_path_another_account_can_write_stays_refused(self) -> None:
        for repo, path, kind in ((self.clone, self.clone, stat.S_IFDIR),
                                 (self.clone, self.clone / ".git", stat.S_IFDIR),
                                 (self.clone, self.common / "config", stat.S_IFREG),
                                 (self.linked, self.linked, stat.S_IFDIR),
                                 (self.linked, self.linked / ".git", stat.S_IFREG),
                                 (self.linked, self.gitdir, stat.S_IFDIR),
                                 (self.linked, self.gitdir / "config.worktree", stat.S_IFREG),
                                 (self.linked, self.common, stat.S_IFDIR)):
            for write_bit in (stat.S_IWGRP, stat.S_IWOTH):
                with self.subTest(path=str(path), write_bit=oct(write_bit)):
                    self.assertEqual(self._flags(repo, modes={_real(path): kind | 0o755 | write_bit}), [])

    def test_an_ancestor_only_a_sticky_bit_protects_is_accepted_and_an_open_one_is_not(self) -> None:
        self.assertEqual(self._flags(self.clone, modes={_real(self.tmp): stat.S_IFDIR | 0o777}), [])
        self.assertEqual(self._flags(self.clone, modes={_real(self.tmp): stat.S_IFDIR | stat.S_ISVTX | 0o777}),
                         [f"safe.directory={_real(self.clone)}"])

    def test_a_gitdir_pointer_through_a_symlink_or_not_a_pointer_stays_refused(self) -> None:
        link = self.tmp / "via-link"
        link.symlink_to(self.gitdir)
        elsewhere = self.tmp / "elsewhere" / "sub"
        elsewhere.mkdir(parents=True)
        (self.tmp / "up-link").symlink_to(elsewhere)
        # git resolves `up-link/..` physically (to elsewhere/), a lexical reading lands on the real gitdir.
        dotdot = f"{self.tmp}/up-link/../{self.gitdir.relative_to(_real(self.tmp))}"
        # git strips only CR/LF off a gitfile: `gitdir: <gitdir> ` names the sibling with the trailing space.
        padded = Path(f"{self.gitdir} ")
        padded.mkdir()
        gitfile = self.linked / ".git"
        for text, owners in ((f"gitdir: {link}\n", {}), (f"gitdir: {dotdot}\n", {}), ("not a gitdir pointer\n", {}),
                             (f"gitdir: {padded}\n", {str(padded): _OTHER})):
            gitfile.write_text(text, encoding="utf-8")
            with self.subTest(gitfile=text.rstrip("\n")):
                self.assertEqual(self._flags(self.linked, owners=owners), [])

    def test_a_root_caller_is_never_handed_the_flag(self) -> None:
        self.assertEqual(self._flags(self.clone, caller=0), [])


def _live_tmp_reachable(path: Path) -> bool:
    """Every ancestor root-owned, traversable by any uid, and writable by root alone or sticky."""
    for parent in Path(_real(path)).parents:
        mode = os.lstat(parent)
        if (mode.st_uid != 0 or not mode.st_mode & stat.S_IXOTH
                or (mode.st_mode & 0o022 and not mode.st_mode & stat.S_ISVTX)):
            return False
    return True


@unittest.skipUnless(os.geteuid() == 0, "the live read needs root to own the checkout and to drop to another uid; "
                                        "the argv tests above are the contract everywhere else")
class LiveRootOwnedCheckoutTests(unittest.TestCase):
    """The real git, a real root-owned checkout, read by a real non-root uid."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-anchor-live-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        if not _live_tmp_reachable(self.tmp):
            self.skipTest(f"{tempfile.gettempdir()} is not a root-only, world-traversable path")
        os.chmod(self.tmp, 0o755)
        self.clone, self.linked, self.tip = _make_layouts(self.tmp)
        lib = self.tmp / "lib"
        lib.mkdir()
        _copy_anchor_package(lib)
        subprocess.run(["chmod", "-R", "a+rX,go-w", str(self.tmp)], check=True)
        self.lib = lib

    def _read_as(self, uid: int, repo: Path) -> dict:
        code = ("import json, sys; sys.path.insert(0, sys.argv[1]); from anchor_pkg import main_anchor as m; "
                "tip = m.main_tip(sys.argv[2]); "
                "blob = m.committed_blob(sys.argv[2], commit=tip, path=sys.argv[3]) if tip else None; "
                "print(json.dumps({'tip': tip, 'blob': blob.content.decode() if blob else None}))")
        proc = subprocess.run([sys.executable, "-I", "-c", code, str(self.lib), str(repo), _SIGNERS],
                              user=uid, group=uid, extra_groups=[], cwd=self.tmp, check=True, capture_output=True,
                              env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"}, stdin=subprocess.DEVNULL)
        return json.loads(proc.stdout)

    def test_a_non_root_caller_reads_main_from_a_root_owned_checkout(self) -> None:
        link = self.tmp / "via-link-to-linked"
        link.symlink_to(self.linked)
        for repo in (self.clone, self.linked, link):
            with self.subTest(layout=repo.name):
                self.assertEqual(self._read_as(_NOBODY, repo),
                                 {"tip": self.tip, "blob": (self.clone / _SIGNERS).read_text(encoding="utf-8")})

    def test_a_checkout_a_third_account_owns_or_can_write_stays_refused(self) -> None:
        # The common dir alone owned by a third account: git's own ownership guard does not look there.
        for path in (self.clone / ".git" / "config", self.clone / ".git"):
            os.chown(path, _OTHER, _OTHER)
        self.assertEqual(self._read_as(_NOBODY, self.linked), {"tip": None, "blob": None})
        subprocess.run(["chown", "-R", f"{_OTHER}:{_OTHER}", str(self.clone)], check=True)
        self.assertEqual(self._read_as(_NOBODY, self.clone), {"tip": None, "blob": None})


if __name__ == "__main__":
    unittest.main()
