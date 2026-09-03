"""Plan 024 v3 §H-0 — cross-platform exclusive file lock context manager.

Plan 024 §H-1 + §H-2 need atomic compare-and-swap around the
claims.jsonl read-state→check→append sequence and the results.jsonl
existing-result lookup→append sequence. The pre-existing kernel had
no OS-level file lock helper (executor.py:713-735 carries a JSONL
append-only "logical lock" pattern but two readers race against the
single writer). Without an exclusive lock, two concurrent workers
can both pass the state check and both write a claim row — the
"who actually owns the lease" answer becomes append-order rather
than mutual-exclusion.

This module exposes ``with_exclusive_lock(path, *, timeout_seconds)``
as a context manager that:
* On POSIX, uses ``fcntl.flock(fd, LOCK_EX | LOCK_NB)`` against a
  side-car ``<path>.lock`` file. Non-blocking acquisition with a
  caller-side ``time.monotonic`` deadline so we never block longer
  than ``timeout_seconds`` (default 5s).
* On Windows, uses ``os.O_CREAT | O_EXCL`` atomic side-car create
  via ``open(<path>.lock, O_CREAT|O_EXCL|O_RDWR)``. ``FileExistsError``
  on the create indicates another process holds the lock; the
  caller-side deadline polls until success or timeout.

Both branches release by closing the fd (POSIX flock auto-release
on close) and removing the side-car file. Caller-side timeout is
enforced via ``time.monotonic`` rather than ``signal.alarm`` so the
helper composes cleanly inside thread-pooled callers (alarms are
process-global and break ThreadPoolExecutor).

Lock semantics are the same from the caller's perspective regardless
of platform; the implementation picks at import time via
``sys.platform``. Acquisition timeout raises ``TimeoutError`` so
operators can distinguish lock contention from other failure modes.
"""
from __future__ import annotations

import contextlib
from dataclasses import dataclass
import os
import stat
import sys
import time
from pathlib import Path
from typing import Iterator


_DEFAULT_TIMEOUT_SECONDS: float = 5.0
_POLL_INTERVAL_SECONDS: float = 0.05


@dataclass(frozen=True, slots=True)
class ExclusiveLockHandle:
    """Identity of the exact regular sidecar inode carrying the lock."""

    path: Path
    fd: int
    device: int
    inode: int
    mode: int

    def matches_path(self) -> bool:
        try:
            current = os.stat(self.path, follow_symlinks=False)
        except OSError:
            return False
        return (
            stat.S_ISREG(current.st_mode)
            and (current.st_dev, current.st_ino, current.st_mode)
            == (self.device, self.inode, self.mode)
        )


def _locked_handle(lock_path: Path, fd: int) -> ExclusiveLockHandle:
    opened = os.fstat(fd)
    if not stat.S_ISREG(opened.st_mode):
        raise OSError(f"exclusive_lock_sidecar_not_regular: {lock_path}")
    handle = ExclusiveLockHandle(
        path=lock_path,
        fd=fd,
        device=opened.st_dev,
        inode=opened.st_ino,
        mode=opened.st_mode,
    )
    if not handle.matches_path():
        raise OSError(f"exclusive_lock_sidecar_changed: {lock_path}")
    return handle


def lock_sidecar_path(path: Path | str) -> Path:
    """Return the one canonical sidecar used for an exclusive target lock."""
    target = Path(path)
    return target.with_suffix(target.suffix + ".lock")


@contextlib.contextmanager
def with_exclusive_lock(
    path: Path | str,
    *,
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    require_existing: bool = False,
) -> Iterator[ExclusiveLockHandle]:
    """Acquire an OS-level exclusive lock on ``path`` for the duration
    of the ``with`` block.

    Blocks up to ``timeout_seconds`` waiting for acquisition; raises
    ``TimeoutError`` on timeout. The lock is held against a side-car
    file ``<path>.lock`` (created if absent) so the target file
    itself is not opened in a way that conflicts with append writers.

    The context manager ensures the lock is released on every exit
    path (normal + exception). On POSIX the lock auto-releases when
    the side-car fd closes; on Windows we explicitly close the fd
    and unlink the side-car.
    """
    target = Path(path)
    if not require_existing:
        target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = lock_sidecar_path(target)

    if sys.platform.startswith("win"):
        if require_existing:
            raise OSError("exclusive_existing_sidecar_lock_unsupported")
        # Windows: O_CREAT | O_EXCL atomic side-car creation. The
        # exclusive create fails with FileExistsError when another
        # process already holds the lock; we poll with a deadline.
        deadline = time.monotonic() + timeout_seconds
        fd: int | None = None
        while True:
            try:
                fd = os.open(
                    str(lock_path),
                    os.O_CREAT | os.O_EXCL | os.O_RDWR
                    | getattr(os, "O_CLOEXEC", 0),
                )
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"with_exclusive_lock_timeout: {target}"
                    )
                time.sleep(_POLL_INTERVAL_SECONDS)
        try:
            handle = _locked_handle(lock_path, fd)
            yield handle
        finally:
            try:
                os.close(fd)
            finally:
                try:
                    if "handle" in locals() and handle.matches_path():
                        lock_path.unlink()
                except FileNotFoundError:
                    pass
    else:
        # POSIX: fcntl.flock LOCK_EX with non-blocking + caller-side
        # deadline. The side-car file persists; only the lock state
        # is process-scoped via the fd.
        import fcntl
        nofollow = getattr(os, "O_NOFOLLOW", None)
        if nofollow is None:
            raise OSError("exclusive_lock_nofollow_unavailable")
        fd = os.open(
            str(lock_path),
            (0 if require_existing else os.O_CREAT)
            | os.O_RDWR
            | nofollow
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NONBLOCK", 0),
            0o644,
        )
        deadline = time.monotonic() + timeout_seconds
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"with_exclusive_lock_timeout: {target}"
                        )
                    time.sleep(_POLL_INTERVAL_SECONDS)
            handle = _locked_handle(lock_path, fd)
            yield handle
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


__all__ = [
    "ExclusiveLockHandle",
    "lock_sidecar_path",
    "with_exclusive_lock",
]
