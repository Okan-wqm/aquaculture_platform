"""GSEC-HIGH-001 (ARIA-HIGH-342) — the writer lease fence is part of the push.

A lease checked by a read before the publish leaves a window: between the
check and the push another writer can take an expired lease and restore, and
the first writer's push then lands on top of a turn that is no longer its own.
So the publish orchestrator (``state_store.publish_with_contention_replay``)
does not check the lease and then push; it builds a FENCE and pushes it with
the state commit in one ``git push --atomic``:

  * the fence is a fast-forward child of the lease tip this writer just read,
    carrying the same lease id and secret digest with a fresh heartbeat;
  * a takeover moves the lease tip, so the fence is no longer a fast-forward
    and the server rejects the WHOLE push — the state commit included;
  * a lease with less than a leased publish arc left is renewed by CAS first,
    so a publish never starts on a lease that could expire under it.

Any contention under a lease — a rejected fence, a moved state tip — is
refused as ``state_writer_lease_lost`` and never replayed: replay is the
reconciliation of two interleaved writers, and under a lease there are not
supposed to be two. The refusal re-reads the lease to say which it was.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Callable

from .autonomous_host_lease import RemoteCasLease
from .state_store import StateStoreError, _read_commit_ref
from .state_writer_lease import (
    LEASED_PUBLISH_SECONDS,
    StateWriterLeaseLost,
    WriterLeaseView,
    _iso,
    _push_record,
    _state_tip,
    _utc_now,
    lease_commit,
    read_writer_lease,
    resolve_writer_lease_token,
    view_record,
    writer_lease_branch,
)

if TYPE_CHECKING:
    from .state_store import StateStore


@dataclass(frozen=True)
class WriterFence:
    """The lease commit a leased publish pushes atomically with its state."""

    commit: str
    lease_branch: str
    parent_tip: str
    lease_id: str
    epoch: int
    token: str = field(repr=False)

    def refspec(self) -> str:
        return f"{self.commit}:refs/heads/{self.lease_branch}"


def _renew(store: "StateStore", view: WriterLeaseView, *, now: datetime) -> WriterLeaseView:
    """Extend the lease by CAS before a publish that could outlive it."""
    assert view.lease is not None
    stamp = now
    extend = max(view.ttl_minutes * 60, LEASED_PUBLISH_SECONDS)
    renewed = RemoteCasLease(**{
        **asdict(view.lease),
        "heartbeat_at": _iso(stamp),
        "expires_at": _iso(stamp + timedelta(seconds=extend)),
    })
    pushed = _push_record(
        store.repo_root,
        remote=store.remote,
        branch=writer_lease_branch(store.branch),
        parent=view.tip,
        record=view_record(view, renewed),
        message=f"chore(aria-state-lease): renew epoch {renewed.epoch} until {renewed.expires_at}",
    )
    if not pushed:
        after = read_writer_lease(store.repo_root, remote=store.remote, state_branch=store.branch)
        if after.tip == view.tip:
            # ARIA-HIGH-350 — nobody moved the lease: the server refused the
            # write itself (permission, ruleset, transport), in git's words.
            raise StateStoreError(
                "state_publish_write_denied: the lease renewal push was refused while "
                f"{writer_lease_branch(store.branch)} did not move; git said: "
                f"{pushed.detail or '<nothing>'}"
            )
        raise StateWriterLeaseLost(
            f"the renewal of lease {view.lease.lease_id} was rejected: another writer moved "
            f"{writer_lease_branch(store.branch)}"
        )
    return read_writer_lease(store.repo_root, remote=store.remote, state_branch=store.branch)


def prepare_writer_fence(
    store: "StateStore",
    *,
    token: str | None = None,
    now: Callable[[], datetime] = _utc_now,
) -> WriterFence:
    """Verify the capability, the base and the time left; build the fence."""
    presented = resolve_writer_lease_token(token)
    view = read_writer_lease(store.repo_root, remote=store.remote, state_branch=store.branch)
    if not view.held_by_token(presented):
        current = view.lease
        raise StateWriterLeaseLost(
            "the presented capability does not hold the current writer lease "
            f"{current.lease_id if current else 'none'} by {current.owner if current else '-'} "
            f"(epoch {current.epoch if current else '-'}, released={view.released}): it was "
            "taken over or released since it was acquired, or it was never this lease's"
        )
    base = _read_commit_ref(store.root, "HEAD")
    tip = _state_tip(store.repo_root, remote=store.remote, state_branch=store.branch)
    if tip != "absent" and tip != base:
        raise StateWriterLeaseLost(
            f"aria/state is at {tip} but this store is on {base}: the branch moved under "
            f"lease {view.lease.lease_id if view.lease else '-'}, or the store was checked "
            "out before the lease was taken"
        )
    if view.seconds_left(now=now()) < LEASED_PUBLISH_SECONDS:
        view = _renew(store, view, now=now())
        if not view.held_by_token(presented):
            raise StateWriterLeaseLost("the renewed lease no longer carries this writer's capability")
    assert view.lease is not None and view.tip is not None
    stamp = _iso(now())
    heartbeat = RemoteCasLease(**{**asdict(view.lease), "heartbeat_at": stamp, "head_sha": base or "absent"})
    commit = lease_commit(
        store.repo_root,
        parent=view.tip,
        record=view_record(view, heartbeat),
        message=f"chore(aria-state-lease): fence epoch {heartbeat.epoch} for a publish on {base}",
    )
    return WriterFence(
        commit=commit,
        lease_branch=writer_lease_branch(store.branch),
        parent_tip=view.tip,
        lease_id=view.lease.lease_id,
        epoch=view.lease.epoch,
        token=presented,
    )


def lease_lost(store: "StateStore", fence: WriterFence, cause: BaseException) -> StateWriterLeaseLost:
    """Name what the contention under a lease was, from a fresh read."""
    try:
        view = read_writer_lease(store.repo_root, remote=store.remote, state_branch=store.branch)
    except StateStoreError as exc:
        return StateWriterLeaseLost(
            f"the publish under lease {fence.lease_id} was rejected ({cause}) and the lease "
            f"could not be re-read ({exc})"
        )
    if not view.held_by_token(fence.token):
        current = view.lease
        return StateWriterLeaseLost(
            f"lease {fence.lease_id} (epoch {fence.epoch}) was taken over: the current lease is "
            f"{current.lease_id if current else 'none'} by {current.owner if current else '-'} "
            f"(epoch {current.epoch if current else '-'}, released={view.released}); "
            "the atomic push was rejected whole"
        )
    return StateWriterLeaseLost(
        f"aria/state moved under the held lease {fence.lease_id} ({cause}): a writer without "
        "the lease published, or this store was checked out before the lease was taken"
    )


__all__ = ["WriterFence", "lease_lost", "prepare_writer_fence"]
