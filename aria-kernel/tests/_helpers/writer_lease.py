"""ARIA-HIGH-342 — hold the aria/state writer lease around a fixture publish.

`state publish` refuses without the current writer lease, exactly as it does
on every lane; a fixture that drives the verb takes the lease against its own
bare remote first, the way the restore action does in a workflow.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from aria_kernel.state_writer_lease import (
    WRITER_LEASE_ENV,
    HeldWriterLease,
    acquire_writer_lease,
    release_writer_lease,
)


@contextmanager
def holding_writer_lease(repo_root: str | Path, *, ttl_minutes: int = 30) -> Iterator[HeldWriterLease]:
    held = acquire_writer_lease(repo_root, ttl_minutes=ttl_minutes)
    previous = os.environ.get(WRITER_LEASE_ENV)
    os.environ[WRITER_LEASE_ENV] = held.lease_id
    try:
        yield held
    finally:
        if previous is None:
            os.environ.pop(WRITER_LEASE_ENV, None)
        else:
            os.environ[WRITER_LEASE_ENV] = previous
        release_writer_lease(repo_root, lease_id=held.lease_id)
