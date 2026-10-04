"""ARIA-HIGH-342 — hold the aria/state writer lease around a fixture publish.

`state publish` refuses without the current writer lease's capability token,
exactly as it does on every lane; a fixture that drives the verb takes the
lease against its own bare remote first, the way the restore action does in a
workflow, and presents the token the way the publish step does — through
``$ARIA_STATE_WRITER_LEASE_TOKEN``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from aria_kernel.state_writer_lease import (
    WRITER_LEASE_TOKEN_ENV,
    HeldWriterLease,
    acquire_writer_lease,
    release_writer_lease,
)


@contextmanager
def holding_writer_lease(repo_root: str | Path, *, ttl_minutes: int = 60) -> Iterator[HeldWriterLease]:
    held = acquire_writer_lease(repo_root, ttl_minutes=ttl_minutes)
    previous = os.environ.get(WRITER_LEASE_TOKEN_ENV)
    os.environ[WRITER_LEASE_TOKEN_ENV] = held.token
    try:
        yield held
    finally:
        if previous is None:
            os.environ.pop(WRITER_LEASE_TOKEN_ENV, None)
        else:
            os.environ[WRITER_LEASE_TOKEN_ENV] = previous
        release_writer_lease(repo_root, token=held.token)


def leased_publish(store, **kwargs):
    """`publish_with_contention_replay` as a lane runs it: the lease taken
    against the fixture's own remote, its token presented, the lease given
    back afterwards whatever happened."""
    from aria_kernel.state_store import publish_with_contention_replay

    with holding_writer_lease(store.repo_root) as held:
        return publish_with_contention_replay(store, writer_lease_token=held.token, **kwargs)
