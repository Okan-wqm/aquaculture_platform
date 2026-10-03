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
* :func:`_root_held_checkout` lets a reader that is not root read root's
  checkout. Git refuses a repository another account owns, and
  ``GIT_CONFIG_NOSYSTEM`` drops any system ``safe.directory``, so the T2 probe
  (``gharunner``) could not read ``/var/lib/aria/code`` and reported
  ``allowed_signers_unavailable`` every hour. The exception goes on the command
  line only when every hop git takes from the checkout (worktree, git
  directory, common directory, and the pointer files between them) is root's
  with no other writer and sits under directories whose children nobody else
  can replace; git then runs in that same resolved path. Root can already act
  as any reader, so trusting its tree widens nothing; a tree another account
  owns keeps git's refusal, since its config could run code as the reader.

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

_GIT_TIMEOUT_SECONDS = 30
_SHA_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
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


ROOT_UID = 0
_FOREIGN_WRITE = stat.S_IWGRP | stat.S_IWOTH
_POINTER_MAX_BYTES = 4096


def _held_node(info: os.stat_result, owner_uid: int, *, parent: bool) -> bool:
    if info.st_uid not in (ROOT_UID, owner_uid):
        return False
    if not info.st_mode & _FOREIGN_WRITE:
        return True
    # A writable PARENT is safe only with the sticky bit (as /tmp): nobody but
    # the child's owner can then rename the child the walk checks next. The
    # checked node itself is never allowed another writer.
    return parent and stat.S_ISDIR(info.st_mode) and bool(info.st_mode & stat.S_ISVTX)


def _held_path(resolved: Path, owner_uid: int) -> bool:
    """``resolved`` (a real path) is the owner's with no other writer, and no directory above it can have a child replaced."""
    try:
        info = os.stat(resolved)
        if info.st_uid != owner_uid or not _held_node(info, owner_uid, parent=False):
            return False
        return all(_held_node(os.stat(node), owner_uid, parent=True) for node in resolved.parents)
    except OSError:
        return False


def _real(path: Path) -> Path | None:
    try:
        return path.resolve(strict=True)
    except (OSError, RuntimeError):  # RuntimeError: a symlink loop before Python 3.13
        return None


def _read_pointer(path: Path, owner_uid: int) -> str | None:
    """A gitfile's or ``commondir``'s text, read only once its directory chain is held.

    Non-blocking, regular files only, the owner's with no other writer, at
    most 4 KiB: a FIFO, a device or a huge file can neither stall nor exhaust
    the reader, and the 30 s git timeout does not cover this read.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & _FOREIGN_WRITE:
            return None
        data = os.read(fd, _POINTER_MAX_BYTES + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    if len(data) > _POINTER_MAX_BYTES:
        return None
    try:
        return data.decode("utf-8").strip()
    except UnicodeDecodeError:
        return None


def _pointed(base: Path, text: str) -> Path | None:
    target = Path(text)
    return _real(target if target.is_absolute() else base / target)


def _root_held_checkout(repo_root: str | Path, *, owner_uid: int = ROOT_UID,
                        reader_uid: int | None = None) -> str | None:
    """The checkout's real path when ``owner_uid`` holds every hop git takes from it and the reader is someone else.

    Git trusts whatever it finds behind the worktree path ``safe.directory``
    names, so each hop is checked: the worktree, the git directory (``.git``
    itself, or the one a gitfile names), and the common directory a
    ``commondir`` file names, plus the pointer files themselves. The path is
    resolved once; ``_git`` runs in and names exactly that real path, so a
    symlink swapped after this check cannot redirect git. Files inside the git
    directory (config, refs, objects) are not inspected, as git's own
    ownership check does not inspect them: a held directory chain means only
    the owner could have put them there.
    """
    reader = os.geteuid() if reader_uid is None else reader_uid
    if reader == owner_uid:
        return None
    top = _real(Path(repo_root))
    if top is None or not _held_path(top, owner_uid):
        return None
    dotgit = top / ".git"
    try:
        mode = os.lstat(dotgit).st_mode
    except OSError:
        return None
    if stat.S_ISDIR(mode):
        gitdir: Path | None = dotgit
    elif stat.S_ISREG(mode):
        text = _read_pointer(dotgit, owner_uid)
        if text is None or not text.startswith("gitdir:"):
            return None
        gitdir = _pointed(top, text[len("gitdir:"):].strip())
    else:
        return None  # a symlinked .git is refused rather than followed
    if gitdir is None or not _held_path(gitdir, owner_uid):
        return None
    commondir = gitdir / "commondir"
    if os.path.lexists(commondir):
        text = _read_pointer(commondir, owner_uid)
        common = _pointed(gitdir, text) if text else None
        if common is None or not _held_path(common, owner_uid):
            return None
    return str(top)


def _git(repo_root: str | Path, *args: str) -> subprocess.CompletedProcess[bytes] | None:
    git = _git_binary()
    if git is None:
        return None
    held = _root_held_checkout(repo_root)
    where = str(repo_root) if held is None else held
    trust = [] if held is None else ["-c", f"safe.directory={held}"]
    try:
        return subprocess.run(
            [git, "--literal-pathspecs", *trust, "-C", where, *args],
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
    return sha if _SHA_RE.fullmatch(sha) else None


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
    if os.environ.get("GITHUB_REF") == "refs/heads/main" and _SHA_RE.fullmatch(github_sha):
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
    if not isinstance(commit, str) or _SHA_RE.fullmatch(commit) is None:
        return None
    if _declares_alternates(repo_root) is not False:
        return None
    resolved = _git(repo_root, "rev-parse", "--verify", "--quiet", f"{commit}:{path}")
    if resolved is None or resolved.returncode != 0:
        return None
    oid = resolved.stdout.decode("ascii", errors="replace").strip()
    if _SHA_RE.fullmatch(oid) is None:
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
    if _SHA_RE.fullmatch(commit or "") is None:
        return None
    proc = _git(repo_root, "ls-tree", "-r", "-z", "--name-only", "--full-tree", commit, "--", *paths)
    if proc is None or proc.returncode != 0:
        return None
    listed = {entry for entry in proc.stdout.decode("utf-8", errors="replace").split("\0") if entry}
    return {path for path in paths if path in listed}


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
    "resolve_main_anchor",
    "scrubbed_git_env",
    "tracked_files_at",
]
