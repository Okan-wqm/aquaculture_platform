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
import os
import sys
import threading
import time
from pathlib import Path
from typing import Iterator


_DEFAULT_TIMEOUT_SECONDS: float = 5.0
_POLL_INTERVAL_SECONDS: float = 0.05
_HELD_LOCKS_GUARD = threading.RLock()
_HELD_LOCKS: dict[tuple[Path, int], int] = {}


def _lock_key(lock_path: Path) -> tuple[Path, int]:
    return lock_path.resolve(strict=False), threading.get_ident()


def _allows_same_thread_reentry(target: Path) -> bool:
    return target.name == "integrity_index.json" or target.suffix == ".jsonl"


def _enter_reentrant(lock_path: Path) -> tuple[Path, int] | None:
    key = _lock_key(lock_path)
    with _HELD_LOCKS_GUARD:
        count = _HELD_LOCKS.get(key)
        if count is None:
            return None
        _HELD_LOCKS[key] = count + 1
        return key


def _mark_acquired(lock_path: Path) -> tuple[Path, int]:
    key = _lock_key(lock_path)
    with _HELD_LOCKS_GUARD:
        _HELD_LOCKS[key] = _HELD_LOCKS.get(key, 0) + 1
    return key


def _leave_reentrant(key: tuple[Path, int]) -> None:
    with _HELD_LOCKS_GUARD:
        count = _HELD_LOCKS.get(key, 0)
        if count <= 1:
            _HELD_LOCKS.pop(key, None)
        else:
            _HELD_LOCKS[key] = count - 1


@contextlib.contextmanager
def with_exclusive_lock(
    path: Path | str,
    *,
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
) -> Iterator[None]:
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
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.with_suffix(target.suffix + ".lock")
    allow_reentry = _allows_same_thread_reentry(target)
    if allow_reentry:
        reentrant_key = _enter_reentrant(lock_path)
        if reentrant_key is not None:
            try:
                yield
            finally:
                _leave_reentrant(reentrant_key)
            return

    if sys.platform.startswith("win"):
        # Windows: O_CREAT | O_EXCL atomic side-car creation. The
        # exclusive create fails with FileExistsError when another
        # process already holds the lock; we poll with a deadline.
        deadline = time.monotonic() + timeout_seconds
        fd: int | None = None
        while True:
            try:
                fd = os.open(
                    str(lock_path),
                    os.O_CREAT | os.O_EXCL | os.O_RDWR,
                )
                held_key = _mark_acquired(lock_path) if allow_reentry else None
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"with_exclusive_lock_timeout: {target}"
                    )
                time.sleep(_POLL_INTERVAL_SECONDS)
        try:
            yield
        finally:
            if held_key is not None:
                _leave_reentrant(held_key)
            try:
                os.close(fd)
            finally:
                try:
                    lock_path.unlink()
                except FileNotFoundError:
                    pass
    else:
        # POSIX: fcntl.flock LOCK_EX with non-blocking + caller-side
        # deadline. The side-car file persists; only the lock state
        # is process-scoped via the fd.
        import fcntl
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)
        deadline = time.monotonic() + timeout_seconds
        held_key: tuple[Path, int] | None = None
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held_key = _mark_acquired(lock_path) if allow_reentry else None
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"with_exclusive_lock_timeout: {target}"
                        )
                    time.sleep(_POLL_INTERVAL_SECONDS)
            try:
                yield
            finally:
                if held_key is not None:
                    _leave_reentrant(held_key)
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


__all__ = [
    "with_exclusive_lock",
]
