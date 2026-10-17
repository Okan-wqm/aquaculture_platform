"""ARIA-HIGH-527 — a tree the agent can write, read by the host without following a link.

WHY this module exists
----------------------
The implementer's sandbox binds the replica of its private git dir writable
(``git_containment``: the replica AT the private git dir, its ref dirs AT the
common ones), and after the spawn the kernel publishes it from the host as
the executor's uid. That publication walked the replica with link-following
calls (``iterdir``, ``is_dir``, ``is_file``, ``read_text``, ``unlink``), and
every entry it read can be a link or a FIFO the agent planted — measured from
inside the real sandbox: ``objects`` and ``refs`` themselves, a fan-out dir,
``objects/pack``, ``refs/heads``, one object or ref file, ``HEAD``. So a
fan-out linked at a directory had its object-named files read and UNLINKED,
``objects/pack`` linked at the shared pack dir had every shared pack unpacked
and DELETED (the repository corrupt), ``refs/heads`` linked anywhere had every
file under the target deleted, a link to a valid object was renamed INTO the
shared store, a binary ``HEAD`` raised out of the publication and a FIFO
``HEAD`` blocked it forever — anywhere the executor's uid can write.

WHAT this module does
---------------------
``UntrustedTree`` is the one way the host reaches such a tree. Every directory
on the way to an entry is lstat'ed and opened from the tree's root with
``O_NOFOLLOW | O_DIRECTORY``; every file is lstat'ed, opened with
``O_NOFOLLOW`` (and ``O_NONBLOCK``: a FIFO is never waited on) and checked
regular on the open descriptor; every unlink and rename is made relative to
such a directory descriptor. No path the host acts on resolves through a
link, whatever the tree holds or comes to hold, and an entry that is a link,
a FIFO, a socket or a device — or a regular file where a directory is
walked — is refused by name (``UntrustedEntryRefused``), never followed,
opened or unlinked. ``regular_files`` walks a subtree whole, so a caller can
refuse before it touches anything. Paths are posix strings relative to the
root.
"""
from __future__ import annotations

import os
import stat
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

_NO_FOLLOW_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_NO_FOLLOW_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
_ENTRY_KINDS: dict[int, str] = {
    stat.S_IFLNK: "symlink", stat.S_IFIFO: "fifo", stat.S_IFSOCK: "socket", stat.S_IFCHR: "character_device",
    stat.S_IFBLK: "block_device", stat.S_IFREG: "regular_file", stat.S_IFDIR: "directory",
}


class UntrustedEntryRefused(Exception):
    """An entry the host will not follow, open or unlink: a link, or anything
    but the directory or regular file expected there. ``kind`` names what it
    is (``symlink``, ``fifo``, ``socket``, ``character_device``,
    ``block_device``, or ``regular_file``/``directory`` where the other was
    expected); ``relative`` is its path in the tree."""

    def __init__(self, relative: str, mode: int) -> None:
        self.relative = relative
        self.kind = _ENTRY_KINDS.get(stat.S_IFMT(mode), "unknown")
        super().__init__(f"{self.kind}:{relative}")


class UntrustedTree:
    """A directory tree another party can write, read without following a link."""

    def __init__(self, root_fd: int) -> None:
        self._root_fd = root_fd

    @staticmethod
    @contextmanager
    def opened(root: Path) -> Iterator[UntrustedTree]:
        """The tree at ``root`` (its parent path is the host's own and is
        resolved as given; ``root`` itself is opened without following a link)."""
        fd = os.open(root, _NO_FOLLOW_DIRECTORY_FLAGS)
        try:
            yield UntrustedTree(fd)
        finally:
            os.close(fd)

    @staticmethod
    def _mode(parent_fd: int, name: str) -> int:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False).st_mode

    @classmethod
    def _open_directory(cls, parent_fd: int, name: str, relative: str) -> int:
        mode = cls._mode(parent_fd, name)
        if not stat.S_ISDIR(mode):
            raise UntrustedEntryRefused(relative, mode)
        # A link swapped in after the lstat is ELOOP here, never its target.
        return os.open(name, _NO_FOLLOW_DIRECTORY_FLAGS, dir_fd=parent_fd)

    @contextmanager
    def _directory(self, parts: Sequence[str]) -> Iterator[int]:
        """A descriptor of the directory ``parts`` below the root, reached
        one component at a time without following a link."""
        fd = os.dup(self._root_fd)
        try:
            for depth, part in enumerate(parts):
                child = self._open_directory(fd, part, "/".join(parts[: depth + 1]))
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    @staticmethod
    def _entries(directory_fd: int) -> list[tuple[str, int]]:
        with os.scandir(directory_fd) as entries:
            return sorted(((entry.name, entry.stat(follow_symlinks=False).st_mode) for entry in entries), reverse=True)

    def regular_files(self, relative: str) -> tuple[str, ...]:
        """Every regular file at or under ``relative``, sorted; ``()`` when it
        is absent. Walked with lstat, depth-first with one open descriptor
        per level, never through a link: the first entry that is neither a
        directory nor a regular file — the walk's root or anything below
        it, or a component on the way to it — is refused by name."""
        *parents, name = relative.split("/")
        try:
            with self._directory(parents) as parent_fd:
                mode = self._mode(parent_fd, name)
                if stat.S_ISREG(mode):
                    return (relative,)
                top = self._open_directory(parent_fd, name, relative)
        except FileNotFoundError:
            return ()
        found: list[str] = []
        frames: list[tuple[int, str, list[tuple[str, int]]]] = [(top, relative, [])]
        try:
            frames[0] = (top, relative, self._entries(top))
            while frames:
                fd, at, pending = frames[-1]
                if not pending:
                    frames.pop()
                    os.close(fd)
                    continue
                child_name, child_mode = pending.pop()
                path = f"{at}/{child_name}"
                if stat.S_ISREG(child_mode):
                    found.append(path)
                elif stat.S_ISDIR(child_mode):
                    child = self._open_directory(fd, child_name, path)
                    frames.append((child, path, []))
                    frames[-1] = (child, path, self._entries(child))
                else:
                    raise UntrustedEntryRefused(path, child_mode)
        finally:
            for fd, _at, _pending in frames:
                os.close(fd)
        return tuple(sorted(found))

    @contextmanager
    def open_file(self, relative: str) -> Iterator[BinaryIO]:
        """The regular file ``relative``, open for reading."""
        *parents, name = relative.split("/")
        with self._directory(parents) as parent_fd:
            mode = self._mode(parent_fd, name)
            if not stat.S_ISREG(mode):
                raise UntrustedEntryRefused(relative, mode)
            fd = os.open(name, _NO_FOLLOW_FILE_FLAGS, dir_fd=parent_fd)
        with os.fdopen(fd, "rb") as handle:
            mode = os.fstat(handle.fileno()).st_mode
            if not stat.S_ISREG(mode):
                raise UntrustedEntryRefused(relative, mode)
            yield handle

    def read(self, relative: str, limit: int = -1) -> bytes:
        """At most ``limit`` bytes (all of them when negative) of the regular file ``relative``."""
        with self.open_file(relative) as handle:
            return handle.read(limit)

    def unlink(self, relative: str) -> None:
        """Unlink the entry ``relative`` itself, in a directory reached
        without following a link."""
        *parents, name = relative.split("/")
        with self._directory(parents) as parent_fd:
            os.unlink(name, dir_fd=parent_fd)

    def move_out(self, relative: str, target: Path) -> bool:
        """Rename the regular file ``relative`` to ``target`` outside the tree
        (same filesystem, atomic) — unless ``target`` exists, in which case
        ``relative`` is unlinked and nothing is overwritten. True when
        ``target`` gained the file."""
        *parents, name = relative.split("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        with self._directory(parents) as parent_fd:
            mode = self._mode(parent_fd, name)
            if not stat.S_ISREG(mode):
                raise UntrustedEntryRefused(relative, mode)
            if target.exists():
                os.unlink(name, dir_fd=parent_fd)
                return False
            os.replace(name, target, src_dir_fd=parent_fd)
            return True


__all__ = ["UntrustedEntryRefused", "UntrustedTree"]
