"""ADR-0020 — read a trust anchor from a commit proven on ``main``, through a hardened git.

WHY. The operator-request verifier and the finding grounding both read
committed repository content: the allowed-signers file, and which paths are
tracked. Round 1 read them at ``HEAD`` with whatever git the environment
offered. A process that can steer the checkout or the git environment could
then choose the anchor: move ``HEAD`` to a commit that enrols its own key,
point ``GIT_DIR``/``GIT_OBJECT_DIRECTORY`` at another object store, add an
alternates path, or register a ``refs/replace`` object that git substitutes
silently on every read (security-reviewer GSEC-MEDIUM-003, arbiter ruling ii).

WHAT.
* :func:`scrubbed_git_env` drops every ``GIT_*`` variable the caller's
  environment carries and sets ``GIT_NO_REPLACE_OBJECTS=1``; every git call
  here runs through the absolute path resolved once per call
  (:func:`_git_binary`), never a PATH lookup at exec time.
* :func:`resolve_main_anchor` names the commit the checkout is at and accepts
  it only when it equals or is an ancestor of ``origin/main`` (or of
  ``GITHUB_SHA`` when the job runs on ``refs/heads/main``). A repository that
  declares object alternates is refused outright.
* :func:`committed_blob` reads one file at a named commit with
  ``git cat-file`` and recomputes the blob's object id from the bytes, so a
  rewritten loose object is caught rather than trusted.
* :func:`tracked_files_at` answers "is this a tracked file" from the commit's
  tree (``git ls-tree``), not from the index a process can edit.
* :func:`messages_naming` returns the message of every commit reachable from
  a named commit that mentions a key, case-insensitively: the merge lane
  reads main's history for the request lines a merged operator plan left
  (ARIA-MEDIUM-264).
* a checkout whose directories, pointers and config only root can change is
  read by a non-root caller (the T2 probe as ``gharunner``) through a
  command-line ``safe.directory`` naming exactly that checkout
  (:func:`_root_owned_trusted`); any other owner stays refused.
  :func:`root_only_checkout` answers that question for any caller, so the
  operator's root signer (``operator_request_signature``) asks it too
  (ARIA-LOW-266).

The merge lane's check 12 runs on a fresh GitHub-hosted clone; that is the
backstop for a process that could rewrite ``.git`` wholesale, including
``origin/main`` itself.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .git_object_id import ANY_OBJECT_FORMAT, is_object_id

_GIT_TIMEOUT_SECONDS = 30
MAIN_TRACKING_REF = "refs/remotes/origin/main"

# Closed vocabulary of anchor failures. Every one is a RUNNER fault: the
# checkout, not the request, is what could not be trusted.
ANCHOR_GIT_UNAVAILABLE = "anchor_git_unavailable"
ANCHOR_HEAD_UNRESOLVED = "anchor_head_unresolved"
ANCHOR_MAIN_UNRESOLVED = "anchor_main_unresolved"
ANCHOR_NOT_ON_MAIN = "anchor_not_on_main"
ANCHOR_ALTERNATES_PRESENT = "anchor_alternates_present"
ANCHOR_REASONS: tuple[str, ...] = (
    ANCHOR_GIT_UNAVAILABLE, ANCHOR_HEAD_UNRESOLVED, ANCHOR_MAIN_UNRESOLVED,
    ANCHOR_NOT_ON_MAIN, ANCHOR_ALTERNATES_PRESENT,
)


@dataclass(frozen=True)
class MainAnchor:
    """The commit a reader may trust, or why there is none."""

    commit: str | None
    reason: str | None


@dataclass(frozen=True)
class CommittedBlob:
    content: bytes
    commit: str
    blob_oid: str


def scrubbed_git_env() -> dict[str, str]:
    """The caller's environment minus every ``GIT_*`` steer, replace objects off."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    return env


def _git_binary() -> str | None:
    return shutil.which("git")


_GROUP_OR_OTHER_WRITE = stat.S_IWGRP | stat.S_IWOTH


def _root_only(path: str, file_type: int, *, may_be_absent: bool = False) -> bool:
    """``path`` itself (never followed) is a ``file_type`` root owns that no other account can write."""
    if may_be_absent and not os.path.lexists(path):
        return True
    seen = os.lstat(path)
    return (stat.S_IFMT(seen.st_mode) == file_type and seen.st_uid == 0
            and not seen.st_mode & _GROUP_OR_OTHER_WRITE)


def root_only_dir(path: str) -> bool:
    """A root-only directory no other account can swap out: every ancestor is root's and either
    writable by root alone or sticky (only an entry's owner or root may move it)."""
    if not _root_only(path, stat.S_IFDIR):
        return False
    for parent in Path(path).parents:
        seen = os.lstat(parent)
        if (not stat.S_ISDIR(seen.st_mode) or seen.st_uid != 0
                or (seen.st_mode & _GROUP_OR_OTHER_WRITE and not seen.st_mode & stat.S_ISVTX)):
            return False
    return True


def root_only_tree(top: str | Path) -> bool:
    """``top`` passes :func:`root_only_dir` and so does everything under it.

    Every directory and regular file below is root's with no group/other
    write bit; any other kind of entry (a symlink included) fails, and so
    does a directory the walk cannot read.
    """
    def refuse(error: OSError) -> None:
        raise error

    try:
        resolved = os.path.realpath(top)
        if not root_only_dir(resolved):
            return False
        for directory, subdirectories, files in os.walk(resolved, onerror=refuse, followlinks=False):
            if not all(_root_only(os.path.join(directory, name), stat.S_IFDIR) for name in subdirectories):
                return False
            if not all(_root_only(os.path.join(directory, name), stat.S_IFREG) for name in files):
                return False
    except OSError:
        return False
    return True


def _pointed_dir(pointer: str, *, base: str, prefix: str) -> str | None:
    """The directory a root-only pointer file (gitfile, ``commondir``) names, parsed as git parses
    it, or None: a wrong prefix, or a path git would resolve through a symlink to somewhere other
    than its lexical reading (``link/..``), which the lstat walk over that reading cannot judge.

    git strips only trailing CR and LF off both pointers (``read_gitfile_gently``,
    ``get_common_dir_noenv``); any other trailing whitespace is part of the path it opens."""
    text = Path(pointer).read_text(encoding="utf-8").rstrip("\r\n")
    if not text.startswith(prefix) or len(text) == len(prefix):
        return None
    named = os.path.join(base, text[len(prefix):])
    # git resolves the path physically; a lexical reading differs exactly when a symlink is on the way.
    target = os.path.normpath(named)
    return target if os.path.realpath(named) == target else None


def _root_owned_trusted(repo_root: str | Path) -> str | None:
    """The checkout's real path when it passes :func:`root_only_checkout` and the caller is not root.

    WHY (ARIA-HIGH-281). The hourly T2 probe runs as ``gharunner`` and reads
    its anchor from ``/var/lib/aria/code``, a checkout root owns so the account
    under test cannot edit it. git's dubious-ownership guard refuses every
    repository the caller does not own, and :func:`scrubbed_git_env` drops the
    system config, so that read always failed. The guard asks one question:
    could an account the caller does not trust have planted the configuration
    git would act on? For a repository only root administers the answer is no,
    because root can already act as any caller. Every other owner stays refused.

    WHAT. This answers that same question, and no other, with pure stat
    checks and no git call: the work tree, its ``.git`` (a directory, or a
    gitfile naming the gitdir), the gitdir's ``commondir`` pointer, the common
    dir, ``config`` and ``config.worktree`` are root's with no group/other
    write bit, and so is every ancestor of each directory (or it is sticky).
    git's own guard never looks at the common dir, so this check does. A
    pointer through a symlink is refused. Entries inside those directories
    (refs, objects, ``info/``) are not judged, as git's guard does not judge
    them for a repository the caller owns: who may write them is root's
    choice. A rewritten ``.git`` is the merge lane's check 12 backstop
    (module docstring).
    """
    if os.geteuid() == 0:
        return None
    return root_only_checkout(repo_root)


def root_only_checkout(repo_root: str | Path) -> str | None:
    """The checkout's real path when only root can change what git would act on in it, else None.

    The stat walk :func:`_root_owned_trusted` documents, for any caller: the
    work tree, its ``.git``, the gitdir, ``commondir``, the common dir and
    both config files are root's with no group/other write bit, and so is
    every ancestor of each directory (or it is sticky).
    """
    worktree = os.path.realpath(repo_root)
    try:
        if not root_only_dir(worktree):
            return None
        dot_git = os.path.join(worktree, ".git")
        if stat.S_ISDIR(os.lstat(dot_git).st_mode):
            gitdir: str | None = dot_git
        elif _root_only(dot_git, stat.S_IFREG):
            gitdir = _pointed_dir(dot_git, base=worktree, prefix="gitdir: ")
        else:
            return None
        if gitdir is None or not root_only_dir(gitdir):
            return None
        pointer = os.path.join(gitdir, "commondir")
        if not os.path.lexists(pointer):
            common: str | None = gitdir
        elif _root_only(pointer, stat.S_IFREG):
            common = _pointed_dir(pointer, base=gitdir, prefix="")
        else:
            return None
        if common is None or not root_only_dir(common):
            return None
        configs = (os.path.join(common, "config"), os.path.join(gitdir, "config.worktree"))
        if not all(_root_only(path, stat.S_IFREG, may_be_absent=True) for path in configs):
            return None
    except (OSError, ValueError):
        return None
    return worktree


def _git(repo_root: str | Path, *args: str) -> subprocess.CompletedProcess[bytes] | None:
    """git in ``repo_root`` through the scrubbed environment.

    A checkout whose configuration only root can change, read by a non-root
    caller, is named in a command-line ``safe.directory``
    (:func:`_root_owned_trusted`): the system and repository scopes cannot
    carry that key here, and the caller's global config is the caller's to
    write, so the command line is the one place this module states the trust
    rule itself.
    """
    git = _git_binary()
    if git is None:
        return None
    trusted = _root_owned_trusted(repo_root)
    scope = ("-c", f"safe.directory={trusted}") if trusted is not None else ()
    try:
        return subprocess.run(
            [git, *scope, "--literal-pathspecs", "-C", str(repo_root), *args],
            stdin=subprocess.DEVNULL, capture_output=True, check=False,
            env=scrubbed_git_env(), timeout=_GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def _resolve_commit(repo_root: str | Path, rev: str) -> str | None:
    if not rev or rev.startswith("-"):
        return None
    proc = _git(repo_root, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    if proc is None or proc.returncode != 0:
        return None
    sha = proc.stdout.decode("ascii", errors="replace").strip()
    return sha if is_object_id(sha, formats=ANY_OBJECT_FORMAT) else None


def _declares_alternates(repo_root: str | Path) -> bool | None:
    proc = _git(repo_root, "rev-parse", "--git-common-dir")
    if proc is None or proc.returncode != 0:
        return None
    common = Path(proc.stdout.decode("utf-8", errors="replace").strip())
    if not common.is_absolute():
        common = Path(repo_root) / common
    return (common / "objects" / "info" / "alternates").exists()


def _trusted_tips(repo_root: str | Path) -> list[str]:
    tips: list[str] = []
    main = _resolve_commit(repo_root, MAIN_TRACKING_REF)
    if main is not None:
        tips.append(main)
    # A job on main names its commit; a pull-request job's GITHUB_SHA is a
    # merge commit that is not on main, so it is never a tip.
    github_sha = os.environ.get("GITHUB_SHA", "")
    if os.environ.get("GITHUB_REF") == "refs/heads/main" and is_object_id(github_sha, formats=ANY_OBJECT_FORMAT):
        resolved = _resolve_commit(repo_root, github_sha)
        if resolved is not None and resolved not in tips:
            tips.append(resolved)
    return tips


def main_tip(repo_root: str | Path) -> str | None:
    """The commit ``refs/remotes/origin/main`` names, resolved through the hardened git, or None."""
    return _resolve_commit(repo_root, MAIN_TRACKING_REF)


def resolve_main_anchor(repo_root: str | Path) -> MainAnchor:
    """The checkout's commit, accepted only when it is proven on ``main``."""
    if _git_binary() is None:
        return MainAnchor(None, ANCHOR_GIT_UNAVAILABLE)
    alternates = _declares_alternates(repo_root)
    if alternates is None:
        return MainAnchor(None, ANCHOR_HEAD_UNRESOLVED)
    if alternates:
        return MainAnchor(None, ANCHOR_ALTERNATES_PRESENT)
    head = _resolve_commit(repo_root, "HEAD")
    if head is None:
        return MainAnchor(None, ANCHOR_HEAD_UNRESOLVED)
    tips = _trusted_tips(repo_root)
    if not tips:
        return MainAnchor(None, ANCHOR_MAIN_UNRESOLVED)
    for tip in tips:
        if head == tip:
            return MainAnchor(head, None)
        proc = _git(repo_root, "merge-base", "--is-ancestor", head, tip)
        if proc is not None and proc.returncode == 0:
            return MainAnchor(head, None)
    return MainAnchor(None, ANCHOR_NOT_ON_MAIN)


def _blob_oid(content: bytes, oid_length: int) -> str:
    header = f"blob {len(content)}\0".encode("ascii")
    digest = hashlib.sha256 if oid_length == 64 else hashlib.sha1
    return digest(header + content).hexdigest()


def committed_blob(repo_root: str | Path, *, commit: str, path: str) -> CommittedBlob | None:
    """``path`` as committed at ``commit``, its bytes re-hashed against the object id."""
    if not isinstance(commit, str) or not is_object_id(commit, formats=ANY_OBJECT_FORMAT):
        return None
    if _declares_alternates(repo_root) is not False:
        return None
    resolved = _git(repo_root, "rev-parse", "--verify", "--quiet", f"{commit}:{path}")
    if resolved is None or resolved.returncode != 0:
        return None
    oid = resolved.stdout.decode("ascii", errors="replace").strip()
    if not is_object_id(oid, formats=ANY_OBJECT_FORMAT):
        return None
    blob = _git(repo_root, "cat-file", "blob", oid)
    if blob is None or blob.returncode != 0 or _blob_oid(blob.stdout, len(oid)) != oid:
        return None
    return CommittedBlob(content=blob.stdout, commit=commit, blob_oid=oid)


def tracked_files_at(repo_root: str | Path, *, commit: str, paths: list[str]) -> set[str] | None:
    """The subset of ``paths`` that are files in ``commit``'s tree, or None.

    A directory is listed by its files, so a bare directory is not a file.
    """
    if not paths:
        return set()
    if not is_object_id(commit or "", formats=ANY_OBJECT_FORMAT):
        return None
    proc = _git(repo_root, "ls-tree", "-r", "-z", "--name-only", "--full-tree", commit, "--", *paths)
    if proc is None or proc.returncode != 0:
        return None
    listed = {entry for entry in proc.stdout.decode("utf-8", errors="replace").split("\0") if entry}
    return {path for path in paths if path in listed}


_MESSAGE_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,62}$")


def messages_naming(repo_root: str | Path, *, commit: str, key: str) -> tuple[str, ...] | None:
    """The message of every commit reachable from ``commit`` that mentions ``key``, or None.

    None when nothing can be read: no git, an alternates store, a commit that
    is not a full object id or does not resolve. A caller treats None as "no
    history", never as "no match". ``key`` is a trailer-style token, so it is
    a fixed string to git's grep; the caller parses the lines it needs out of
    each message. ``log.showSignature`` and friends cannot change the output:
    the format is explicit and signatures are switched off.
    """
    if not is_object_id(commit or "", formats=ANY_OBJECT_FORMAT) or _MESSAGE_KEY_RE.fullmatch(key or "") is None:
        return None
    if _declares_alternates(repo_root) is not False or _resolve_commit(repo_root, commit) != commit:
        return None
    proc = _git(repo_root, "log", "--no-show-signature", "--fixed-strings", "--regexp-ignore-case",
                f"--grep={key}", "--format=%B%x00", commit, "--")
    if proc is None or proc.returncode != 0:
        return None
    text = proc.stdout.decode("utf-8", errors="replace")
    return tuple(message for message in text.split("\0") if message.strip())


__all__ = [
    "ANCHOR_ALTERNATES_PRESENT",
    "ANCHOR_GIT_UNAVAILABLE",
    "ANCHOR_HEAD_UNRESOLVED",
    "ANCHOR_MAIN_UNRESOLVED",
    "ANCHOR_NOT_ON_MAIN",
    "ANCHOR_REASONS",
    "MAIN_TRACKING_REF",
    "CommittedBlob",
    "MainAnchor",
    "committed_blob",
    "main_tip",
    "messages_naming",
    "resolve_main_anchor",
    "root_only_checkout",
    "root_only_dir",
    "root_only_tree",
    "scrubbed_git_env",
    "tracked_files_at",
]
