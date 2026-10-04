"""ARIA-HIGH-342 — aria/state has one writer at a time.

THE MEASURED DEFECT (2026-10-04, twice). A long self-hosted job restored the
store and worked for hours; a short lane (``aria-agent-eval`` on its own
concurrency group, an operator-lane publish) moved ``aria/state`` in between;
the long job's final publish lost the fast-forward race, its contention replay
refused (``replay_materialization_budget_exceeded``) and the job exited 3 with
its results nowhere on the branch.

WHY TURNS, AND NOT A BETTER REPLAY. The replay can only carry what has an
append-only suffix. Every ledger row survives it; nothing else does: it
resets the loser onto the winner's tree, so a loser's agent output artifacts,
lock records and any rewritten (compacted) surface are the winner's afterwards
— and before ARIA-HIGH-342 it said ``published: true`` while doing so. Its
in-memory bound is a deliberate OOM guard on a whole-file parse. A writer that
interleaves with another is therefore a writer that can lose work by
construction; the only design under which no lane loses work is the one in
which no two lanes write at once.

THE MECHANISM IS THE EXISTING ONE, GIVEN A REMOTE TRANSPORT.
``autonomous_host_lease.RemoteCasLease`` already carries the compare fields a
cross-host writer lock needs — epoch fence, owner, target ref, head sha,
expiry. Its tools-root file is a trusted witness, not a mutex: it is only seen
after a restore, which is too late for a lock that must be taken BEFORE one.
Here the same record lives on its own branch, ``aria/state-lease``, and every
change is a commit pushed fast-forward-only — the server's compare-and-swap,
exactly as ``publish_state`` uses it on ``aria/state`` (and exactly as the
cold store already uses ``aria/state-cold``). Two writers racing from one
lease tip cannot both push.

THE CONTRACT.
  * A writer acquires the lease before ``state checkout`` and releases it
    after its last ``state publish``; ``state publish`` refuses without it
    (``require_held_writer_lease``). The restore action acquires when a lane
    declares ``writer-lease-ttl-minutes``; the release action gives it back
    in an ``always()`` step.
  * The expiry is the holder's own job bound, so a holder that dies without
    releasing frees the branch when its job could no longer be running.
  * Fencing is by lease id, not by the clock: a holder past its expiry may
    still publish if nobody has taken the lease since, and may not once
    anybody has (the taker's epoch is higher and its lease id differs).
  * A writer that finds the lease held waits up to its bound and then YIELDS
    by name — holder, run id, expiry, how long it waited — before it has
    restored anything, so a yield loses no work. That is the opposite of
    the ORPHAN-713 harm a shared concurrency group causes: GitHub silently
    evicts a pending run; this refuses one out loud.
"""

from __future__ import annotations

import getpass
import json
import os
import socket
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .autonomous_host_lease import RemoteCasLease, build_remote_cas_lease
from .ledger import canonical_json
from .state_store import (
    COMMITTER_EMAIL,
    COMMITTER_NAME,
    STATE_BRANCH,
    StateStoreError,
    StateStoreRefusal,
    _fetch_remote_branch_tip_at,
    _git,
    _git_in_index,
    _MAX_GIT_STDERR_BYTES,
    _probe_remote_tip_at,
    _run_git,
    _run_git_bytes_bounded,
)

WRITER_LEASE_ENV = "ARIA_STATE_WRITER_LEASE_ID"
LEASE_RECORD_PATH = "lease.json"
LEASE_SCHEMA = "aria/state-writer-lease/v1"
# The longest job bound any writer lane declares is the executor's 510 min;
# a day is the ceiling a caller may ask for, so a typo cannot lock the branch
# for a week.
MAX_TTL_MINUTES = 24 * 60
_MAX_LEASE_RECORD_BYTES = 64 * 1024
# A rejected push whose re-read shows the tip unchanged is a transport fault,
# not a lost race; a few of those in a row is an outage, said by name.
_MAX_UNCHANGED_PUSH_FAILURES = 3


class StateWriterLeaseBlocked(StateStoreRefusal):
    """Another writer holds the lease, and the bounded wait ran out."""

    def __init__(self, view: "WriterLeaseView", *, waited_seconds: float) -> None:
        holder = view.lease
        super().__init__(
            "state_writer_lease_held: aria/state is being written by "
            f"{holder.owner if holder else '<unknown>'} (run {view.run_id or '-'}, "
            f"lease {holder.lease_id if holder else '-'}, epoch "
            f"{holder.epoch if holder else '-'}) until "
            f"{holder.expires_at if holder else '-'}; waited {waited_seconds:.0f}s "
            "and yielded before restoring anything"
        )
        self.view = view
        self.waited_seconds = waited_seconds


def writer_lease_branch(state_branch: str = STATE_BRANCH) -> str:
    """The lease branch of a state branch (``aria/state-lease``)."""
    return f"{state_branch}-lease"


def writer_identity(repo_root: str | Path | None = None) -> tuple[str, str | None]:
    """Who is asking, and under which run.

    A GitHub job names its workflow, job, run and attempt — the run id is
    what an operator follows to the holder; a re-run attempt is a different
    holder. Anything else is an operator lane: host, user AND checkout, so two
    root shells on one host (the 2026-10-04 operator lane published from
    /root/aria-8b while a runner worked elsewhere) are two writers, not one.
    """
    run_id = os.environ.get("GITHUB_RUN_ID", "").strip()
    if run_id:
        workflow = os.environ.get("GITHUB_WORKFLOW", "").strip() or "unknown-workflow"
        job = os.environ.get("GITHUB_JOB", "").strip() or "unknown-job"
        attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "").strip() or "1"
        return f"gha:{workflow}:{job}:run={run_id}:attempt={attempt}", run_id
    try:
        user = getpass.getuser()
    except (KeyError, OSError):
        user = "unknown-user"
    checkout = Path(repo_root).resolve().as_posix() if repo_root is not None else os.getcwd()
    return f"local:{socket.gethostname()}:{user}:{checkout}", None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class WriterLeaseView:
    """The lease branch as one read saw it."""

    tip: str | None
    lease: RemoteCasLease | None = None
    run_id: str | None = None
    released: bool = False
    released_by: str | None = None

    def is_held(self, *, now: datetime | None = None) -> bool:
        if self.lease is None or self.released:
            return False
        try:
            expires = datetime.fromisoformat(self.lease.expires_at.replace("Z", "+00:00"))
        except ValueError:
            # An unparseable expiry cannot prove the lease free; it holds.
            return True
        return expires > (now or _utc_now())

    def as_json(self) -> dict[str, Any]:
        return {
            "lease_branch_tip": self.tip,
            **(asdict(self.lease) if self.lease else {}),
            "run_id": self.run_id,
            "released": self.released,
            "released_by": self.released_by,
        }


@dataclass(frozen=True)
class HeldWriterLease:
    lease_id: str
    epoch: int
    owner: str
    run_id: str | None
    expires_at: str
    state_tip: str
    lease_branch: str
    waited_seconds: float = 0.0
    predecessor: dict[str, Any] = field(default_factory=dict)

    def as_json(self) -> dict[str, Any]:
        return {"held": True, **asdict(self)}


def _parse_record(raw: bytes, *, tip: str) -> WriterLeaseView:
    try:
        payload = json.loads(raw.decode("utf-8"))
        if payload.get("schema") != LEASE_SCHEMA:
            raise ValueError("schema")
        lease = RemoteCasLease(
            lease_id=str(payload["lease_id"]),
            epoch=int(payload["epoch"]),
            owner=str(payload["owner"]),
            target_ref=str(payload["target_ref"]),
            head_sha=str(payload["head_sha"]),
            acquired_at=str(payload["acquired_at"]),
            heartbeat_at=str(payload["heartbeat_at"]),
            expires_at=str(payload["expires_at"]),
        )
    except (UnicodeDecodeError, ValueError, KeyError, TypeError) as exc:
        # Fail closed: a lease nobody can read is not a free branch.
        raise StateStoreError(
            f"state_writer_lease_record_invalid: {LEASE_RECORD_PATH} at {tip} "
            "is not a writer lease record"
        ) from exc
    run_id = payload.get("run_id")
    released_by = payload.get("released_by")
    return WriterLeaseView(
        tip=tip,
        lease=lease,
        run_id=str(run_id) if run_id else None,
        released=payload.get("released") is True,
        released_by=str(released_by) if released_by else None,
    )


def read_writer_lease(
    repo_root: str | Path,
    *,
    remote: str = "origin",
    state_branch: str = STATE_BRANCH,
) -> WriterLeaseView:
    """The lease as the REMOTE holds it — never a local copy of it."""
    root = Path(repo_root)
    branch = writer_lease_branch(state_branch)
    probe = _probe_remote_tip_at(root, remote=remote, branch=branch)
    if probe.status == "absent":
        return WriterLeaseView(tip=None)
    if probe.status != "present":
        raise StateStoreError(
            f"state_writer_lease_unreadable: {branch} probe {probe.status} {probe.detail}"
        )
    tip = _fetch_remote_branch_tip_at(
        root, remote=remote, branch=branch, error_prefix="state_writer_lease_fetch_failed",
    )
    raw = _run_git_bytes_bounded(
        root,
        ("cat-file", "blob", f"{tip}:{LEASE_RECORD_PATH}"),
        stdout_limit=_MAX_LEASE_RECORD_BYTES,
        stderr_limit=_MAX_GIT_STDERR_BYTES,
        budget_error="state_writer_lease_record_too_large",
    )
    if raw.returncode != 0:
        raise StateStoreError(
            f"state_writer_lease_record_missing: {branch}@{tip} carries no {LEASE_RECORD_PATH}"
        )
    return _parse_record(raw.stdout, tip=tip)


def _push_record(
    root: Path,
    *,
    remote: str,
    branch: str,
    parent: str | None,
    record: dict[str, Any],
    message: str,
) -> bool:
    """Commit ``record`` on ``parent`` and push it fast-forward-only.

    Built in a scratch index and pushed by exact sha, never forced — the same
    shape as the cold store's union commit. ``False`` is a rejected push:
    the caller re-reads and decides whether it lost a race.
    """
    with tempfile.TemporaryDirectory(prefix="aria-state-lease-") as scratch:
        record_file = Path(scratch) / LEASE_RECORD_PATH
        record_file.write_text(canonical_json(record) + "\n", encoding="utf-8")
        blob = _git(root, "hash-object", "-w", "--no-filters", "--", str(record_file)).strip()
        index = Path(scratch) / "index"
        _git_in_index(root, index, "read-tree", "--empty")
        _git_in_index(
            root, index, "update-index", "--add", "--cacheinfo", f"100644,{blob},{LEASE_RECORD_PATH}",
        )
        tree = _git_in_index(root, index, "write-tree").strip()
    commit = _git(
        root, "-c", f"user.name={COMMITTER_NAME}", "-c", f"user.email={COMMITTER_EMAIL}",
        "-c", "commit.gpgsign=false", "commit-tree", tree, *(("-p", parent) if parent else ()),
        "-m", message,
    ).strip()
    return _run_git(root, ("push", remote, f"{commit}:refs/heads/{branch}")).returncode == 0


def _state_tip(root: Path, *, remote: str, state_branch: str) -> str:
    probe = _probe_remote_tip_at(root, remote=remote, branch=state_branch)
    if probe.status == "present" and probe.sha:
        return probe.sha
    if probe.status == "absent":
        return "absent"
    raise StateStoreError(
        f"state_writer_lease_state_tip_unreadable: {state_branch} probe {probe.status} {probe.detail}"
    )


def _record(lease: RemoteCasLease, *, run_id: str | None, released_by: str | None = None) -> dict[str, Any]:
    return {
        "schema": LEASE_SCHEMA,
        **asdict(lease),
        "run_id": run_id,
        "released": released_by is not None,
        "released_by": released_by,
    }


def acquire_writer_lease(
    repo_root: str | Path,
    *,
    ttl_minutes: int,
    wait_seconds: float = 0,
    poll_seconds: float = 15,
    owner: str | None = None,
    run_id: str | None = None,
    remote: str = "origin",
    state_branch: str = STATE_BRANCH,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], datetime] = _utc_now,
) -> HeldWriterLease:
    """Take the aria/state writer lease, waiting at most ``wait_seconds``.

    Raises ``StateWriterLeaseBlocked`` when another holder still has it after
    the wait. A holder that re-asks (same owner) takes a fresh epoch — a
    re-entered step must not be refused by its own earlier acquisition.
    """
    if not 1 <= int(ttl_minutes) <= MAX_TTL_MINUTES:
        raise StateStoreError(
            f"state_writer_lease_ttl_invalid: {ttl_minutes} (1..{MAX_TTL_MINUTES} minutes)"
        )
    if wait_seconds < 0 or poll_seconds <= 0:
        raise StateStoreError("state_writer_lease_wait_invalid: wait >= 0 and poll > 0")
    root = Path(repo_root)
    derived_owner, derived_run = writer_identity(root)
    holder = owner or derived_owner
    run = run_id if run_id is not None else derived_run
    branch = writer_lease_branch(state_branch)
    started = monotonic()
    unchanged_failures = 0
    while True:
        view = read_writer_lease(root, remote=remote, state_branch=state_branch)
        if view.is_held(now=now()) and view.lease is not None and view.lease.owner != holder:
            waited = monotonic() - started
            if waited >= wait_seconds:
                raise StateWriterLeaseBlocked(view, waited_seconds=waited)
            sleep(min(poll_seconds, max(wait_seconds - waited, 0.001)))
            continue
        lease = build_remote_cas_lease(
            previous=view.lease,
            owner=holder,
            target_ref=f"refs/heads/{state_branch}",
            head_sha=_state_tip(root, remote=remote, state_branch=state_branch),
            ttl_minutes=int(ttl_minutes),
        )
        if _push_record(
            root,
            remote=remote,
            branch=branch,
            parent=view.tip,
            record=_record(lease, run_id=run),
            message=f"chore(aria-state-lease): {holder} epoch {lease.epoch} until {lease.expires_at}",
        ):
            return HeldWriterLease(
                lease_id=lease.lease_id,
                epoch=lease.epoch,
                owner=holder,
                run_id=run,
                expires_at=lease.expires_at,
                state_tip=lease.head_sha,
                lease_branch=branch,
                waited_seconds=monotonic() - started,
                predecessor=view.as_json() if view.lease else {},
            )
        after = read_writer_lease(root, remote=remote, state_branch=state_branch)
        if after.tip == view.tip:
            unchanged_failures += 1
            if unchanged_failures >= _MAX_UNCHANGED_PUSH_FAILURES:
                raise StateStoreError(
                    f"state_writer_lease_push_failed: {branch} did not move and refused "
                    f"{unchanged_failures} pushes; the remote is not accepting writes"
                )


def require_held_writer_lease(
    repo_root: str | Path,
    *,
    lease_id: str | None = None,
    remote: str = "origin",
    state_branch: str = STATE_BRANCH,
) -> WriterLeaseView:
    """Refuse unless ``lease_id`` (default: ``$ARIA_STATE_WRITER_LEASE_ID``)
    is the current, unreleased writer lease on the remote."""
    wanted = (lease_id or os.environ.get(WRITER_LEASE_ENV, "")).strip()
    if not wanted:
        raise StateStoreRefusal(
            "state_writer_lease_required: aria/state has one writer at a time and this "
            f"process holds no writer lease (${WRITER_LEASE_ENV} unset); take it with "
            "`state lease acquire` before `state checkout`, release it after the publish"
        )
    view = read_writer_lease(repo_root, remote=remote, state_branch=state_branch)
    if view.lease is None or view.lease.lease_id != wanted or view.released:
        current = view.lease
        raise StateStoreRefusal(
            f"state_writer_lease_not_held: lease {wanted} is not the current writer lease "
            f"(current: {current.lease_id if current else 'none'} by "
            f"{current.owner if current else '-'}, released={view.released}); "
            "another writer may have published since this one restored"
        )
    return view


def release_writer_lease(
    repo_root: str | Path,
    *,
    lease_id: str,
    remote: str = "origin",
    state_branch: str = STATE_BRANCH,
) -> dict[str, Any]:
    """Give the lease back — compare, then swap.

    Only the CURRENT lease id can be released; a lease another writer has
    since taken is left alone and reported. Releasing a lease id read from
    ``state lease status`` is also how an operator frees the branch from a
    holder that died without releasing — recorded on the lease branch as who
    released it.
    """
    root = Path(repo_root)
    branch = writer_lease_branch(state_branch)
    releaser, _run = writer_identity(root)
    for _attempt in range(_MAX_UNCHANGED_PUSH_FAILURES):
        view = read_writer_lease(root, remote=remote, state_branch=state_branch)
        if view.lease is None or view.lease.lease_id != lease_id:
            return {
                "released": False,
                "reason": "lease_not_current",
                "lease_id": lease_id,
                "current": view.as_json(),
            }
        if view.released:
            return {"released": False, "reason": "already_released", "lease_id": lease_id}
        stamp = _iso(_utc_now())
        released = RemoteCasLease(**{**asdict(view.lease), "heartbeat_at": stamp, "expires_at": stamp})
        if _push_record(
            root,
            remote=remote,
            branch=branch,
            parent=view.tip,
            record=_record(released, run_id=view.run_id, released_by=releaser),
            message=f"chore(aria-state-lease): release epoch {released.epoch} by {releaser}",
        ):
            return {
                "released": True,
                "lease_id": lease_id,
                "epoch": released.epoch,
                "owner": released.owner,
                "released_by": releaser,
            }
    raise StateStoreError(
        f"state_writer_lease_release_failed: {branch} refused {_MAX_UNCHANGED_PUSH_FAILURES} "
        "release pushes; the lease expires at its recorded bound"
    )


__all__ = [
    "LEASE_SCHEMA",
    "MAX_TTL_MINUTES",
    "WRITER_LEASE_ENV",
    "HeldWriterLease",
    "StateWriterLeaseBlocked",
    "WriterLeaseView",
    "acquire_writer_lease",
    "read_writer_lease",
    "release_writer_lease",
    "require_held_writer_lease",
    "writer_identity",
    "writer_lease_branch",
]
