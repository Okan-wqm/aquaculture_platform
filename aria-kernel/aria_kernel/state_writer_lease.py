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
    after its last ``state publish``. The restore action acquires when a lane
    declares ``writer-lease-ttl-minutes``; the release action gives it back
    in an ``always()`` step.
  * The lease is a CAPABILITY (GSEC-MEDIUM-001): every acquisition mints a
    256-bit secret that only the acquirer holds; ``lease.json`` stores its
    SHA-256. Publishing, renewing and releasing compare the hash, so knowing
    the public lease id or the holder's name grants nothing.
  * The fence is part of the push (GSEC-HIGH-001, ``state_writer_fence``):
    every publish pushes the state commit and a fast-forward child of the
    observed lease tip in one ``git push --atomic``, so a takeover between
    the check and the push rejects the whole push. Contention under a lease
    is refused by name (``state_writer_lease_lost``) and never replayed.
  * The expiry is the holder's job bound plus the leased publish arc, so a
    holder that dies without releasing frees the branch when its job could
    no longer be running; a publish with less than the arc left renews by
    CAS first.
  * A writer that finds the lease held waits up to its bound and then YIELDS
    by name — holder, run id, expiry, how long it waited — before it has
    restored anything, so a yield loses no work. That is the opposite of
    the ORPHAN-713 harm a shared concurrency group causes: GitHub silently
    evicts a pending run; this refuses one out loud.
"""

from __future__ import annotations

import contextlib
import getpass
import hashlib
import json
import math
import os
import secrets
import socket
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
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
    _MAX_GIT_OUTPUT_BYTES,
    _MAX_GIT_STDERR_BYTES,
    _MAX_REMOTE_OUTPUT_BYTES,
    _RemoteTipProbe,
    _git_in_index,
    _parse_remote_tip_listing,
    _run_git_bytes_bounded,
)
from .state_store_lifecycle_arcs import (
    PUBLISH_PUSH_STEP,
    REMOTE_BRANCH_FETCH_STEP,
    REMOTE_TIP_PROBE_STEP,
    STATE_STORE_PUBLISH_ARC_SECONDS,
    LifecycleGitStep,
    lifecycle_step_active,
    require_step_operation,
)

# The capability a holder presents. It travels as a masked step output into
# the publish, merge and release steps only (GSEC-LOW-002), never through
# $GITHUB_ENV, and is never printed.
WRITER_LEASE_TOKEN_ENV = "ARIA_STATE_WRITER_LEASE_TOKEN"
LEASE_RECORD_PATH = "lease.json"
LEASE_SCHEMA = "aria/state-writer-lease/v2"
# The longest job bound any writer lane declares is the executor's; a day is
# the ceiling a caller may ask for, so a typo cannot lock the branch for a week.
MAX_TTL_MINUTES = 24 * 60
# The worst case of ONE leased publish under the lifecycle lock — the pending
# recovery and the publish attempt, at the git cap — is the store's own
# derived bound (`state_store_lifecycle_arcs.STATE_STORE_PUBLISH_ARC_SECONDS`).
# A leased publish never replays, so this is its whole arc; a lease with less
# than this left is renewed by CAS before the push.
LEASED_PUBLISH_SECONDS: float = STATE_STORE_PUBLISH_ARC_SECONDS
# GSEC-MEDIUM-003 — a lane's TTL is its job timeout PLUS this margin, so a
# publish at the very end of the job still has a whole leased arc left.
PUBLISH_MARGIN_MINUTES: int = math.ceil(LEASED_PUBLISH_SECONDS / 60)
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


class StateWriterLeaseLost(StateStoreRefusal):
    """The lease this writer holds no longer covers its publish."""

    def __init__(self, detail: str) -> None:
        super().__init__(
            f"state_writer_lease_lost: {detail}; nothing was replayed and this "
            "lane's rows stay in its store"
        )


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
    An identity names a holder; it is not a credential — the token is.
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


# The lease's own git transport. It runs through the store's bounded runner
# (`_run_git_bytes_bounded`: output caps, the git timeout, closed stdin) but
# not through `state_store._run_git`, so the lease traffic of a publish is not
# mistaken for the publish's own and the two can be reasoned about apart. The
# remote calls name the lifecycle step they are, as every remote call must
# when a caller already holds the lifecycle lock.
def _lease_git_run(
    root: Path,
    args: tuple[str, ...],
    *,
    step: LifecycleGitStep | None = None,
) -> subprocess.CompletedProcess[str]:
    if step is not None:
        require_step_operation(step, args)
    remote_listing = args[0] == "ls-remote"
    with lifecycle_step_active(step) if step is not None else contextlib.nullcontext():
        raw = _run_git_bytes_bounded(
            root,
            args,
            stdout_limit=_MAX_REMOTE_OUTPUT_BYTES if remote_listing else _MAX_GIT_OUTPUT_BYTES,
            stderr_limit=_MAX_GIT_STDERR_BYTES,
            budget_error="state_writer_lease_git_output_budget_exceeded",
        )
    return subprocess.CompletedProcess(
        raw.args,
        raw.returncode,
        raw.stdout.decode("utf-8", "replace"),
        raw.stderr.decode("utf-8", "replace"),
    )


def _lease_git(root: Path, *args: str) -> str:
    proc = _lease_git_run(root, tuple(args))
    if proc.returncode != 0:
        raise StateStoreError(
            f"state_writer_lease_git_failed: git {args[0]} -> {proc.stderr.strip()[:300]}"
        )
    return proc.stdout


def _probe_tip(root: Path, *, remote: str, branch: str) -> _RemoteTipProbe:
    ref = f"refs/heads/{branch}"
    try:
        proc = _lease_git_run(root, ("ls-remote", "--heads", remote, ref), step=REMOTE_TIP_PROBE_STEP)
    except StateStoreError as exc:
        return _RemoteTipProbe("unavailable", detail=str(exc)[:300])
    if proc.returncode != 0:
        return _RemoteTipProbe("unavailable", detail=proc.stderr.strip()[:300])
    return _parse_remote_tip_listing(proc.stdout, ref=ref)


def _fetch_tip(root: Path, *, remote: str, branch: str) -> str:
    fetched = f"refs/aria/tmp/state-lease-fetch-{os.getpid()}-{secrets.token_hex(8)}"
    try:
        proc = _lease_git_run(
            root,
            ("fetch", "--no-tags", "--refmap=", remote, f"refs/heads/{branch}:{fetched}"),
            step=REMOTE_BRANCH_FETCH_STEP,
        )
        if proc.returncode != 0:
            raise StateStoreError(f"state_writer_lease_fetch_failed: {proc.stderr.strip()[:300]}")
        return _lease_git(root, "rev-parse", "--verify", f"{fetched}^{{commit}}").strip()
    finally:
        _lease_git_run(root, ("update-ref", "-d", fetched))


def token_digest(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


@dataclass(frozen=True)
class WriterLeaseView:
    """The lease branch as one read saw it."""

    tip: str | None
    lease: RemoteCasLease | None = None
    run_id: str | None = None
    ttl_minutes: int = 0
    secret_sha256: str = ""
    released: bool = False
    released_by: str | None = None
    release_reason: str | None = None

    def is_held(self, *, now: datetime | None = None) -> bool:
        if self.lease is None or self.released:
            return False
        expires = _parse_iso(self.lease.expires_at)
        # An unparseable expiry cannot prove the lease free; it holds.
        return True if expires is None else expires > (now or _utc_now())

    def seconds_left(self, *, now: datetime | None = None) -> float:
        expires = _parse_iso(self.lease.expires_at) if self.lease else None
        if expires is None:
            return 0.0
        return (expires - (now or _utc_now())).total_seconds()

    def held_by_token(self, token: str | None) -> bool:
        """The capability check: this record names THIS holder's secret."""
        return bool(
            token
            and self.lease is not None
            and not self.released
            and self.secret_sha256
            and secrets.compare_digest(self.secret_sha256, token_digest(token))
        )

    def as_json(self) -> dict[str, Any]:
        return {
            "lease_branch_tip": self.tip,
            **(asdict(self.lease) if self.lease else {}),
            "run_id": self.run_id,
            "ttl_minutes": self.ttl_minutes,
            "released": self.released,
            "released_by": self.released_by,
            "release_reason": self.release_reason,
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
    token: str = field(repr=False)
    waited_seconds: float = 0.0
    predecessor: dict[str, Any] = field(default_factory=dict)

    def as_json(self) -> dict[str, Any]:
        """Everything but the capability itself."""
        payload = asdict(self)
        payload.pop("token")
        return {"held": True, **payload}


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
        ttl_minutes = int(payload["ttl_minutes"])
        secret_sha256 = str(payload["secret_sha256"])
    except (UnicodeDecodeError, ValueError, KeyError, TypeError) as exc:
        # Fail closed: a lease nobody can read is not a free branch. The
        # audited way out is `state lease repair --reason`.
        raise StateStoreRefusal(
            f"state_writer_lease_record_invalid: {LEASE_RECORD_PATH} at {tip} "
            "is not a writer lease record; `state lease repair --reason` replaces it"
        ) from exc
    def text(key: str) -> str | None:
        value = payload.get(key)
        return str(value) if value else None
    return WriterLeaseView(
        tip=tip,
        lease=lease,
        run_id=text("run_id"),
        ttl_minutes=ttl_minutes,
        secret_sha256=secret_sha256,
        released=payload.get("released") is True,
        released_by=text("released_by"),
        release_reason=text("release_reason"),
    )


def _read_raw(root: Path, *, remote: str, branch: str) -> tuple[str | None, bytes | None]:
    probe = _probe_tip(root, remote=remote, branch=branch)
    if probe.status == "absent":
        return None, None
    if probe.status != "present":
        raise StateStoreError(
            f"state_writer_lease_unreadable: {branch} probe {probe.status} {probe.detail}"
        )
    tip = _fetch_tip(root, remote=remote, branch=branch)
    raw = _run_git_bytes_bounded(
        root,
        ("cat-file", "blob", f"{tip}:{LEASE_RECORD_PATH}"),
        stdout_limit=_MAX_LEASE_RECORD_BYTES,
        stderr_limit=_MAX_GIT_STDERR_BYTES,
        budget_error="state_writer_lease_record_too_large",
    )
    return tip, (raw.stdout if raw.returncode == 0 else None)


def read_writer_lease(
    repo_root: str | Path,
    *,
    remote: str = "origin",
    state_branch: str = STATE_BRANCH,
) -> WriterLeaseView:
    """The lease as the REMOTE holds it — never a local copy of it."""
    branch = writer_lease_branch(state_branch)
    tip, raw = _read_raw(Path(repo_root), remote=remote, branch=branch)
    if tip is None:
        return WriterLeaseView(tip=None)
    if raw is None:
        raise StateStoreRefusal(
            f"state_writer_lease_record_missing: {branch}@{tip} carries no {LEASE_RECORD_PATH}; "
            "`state lease repair --reason` replaces it"
        )
    return _parse_record(raw, tip=tip)


def lease_commit(
    root: Path,
    *,
    parent: str | None,
    record: dict[str, Any],
    message: str,
) -> str:
    """A commit holding ``record`` on ``parent``, built in a scratch index.

    Not pushed: the caller pushes it — alone (acquire, renew, release,
    repair) or atomically with a state commit (the publish fence).
    """
    with tempfile.TemporaryDirectory(prefix="aria-state-lease-") as scratch:
        record_file = Path(scratch) / LEASE_RECORD_PATH
        record_file.write_text(canonical_json(record) + "\n", encoding="utf-8")
        blob = _lease_git(root, "hash-object", "-w", "--no-filters", "--", str(record_file)).strip()
        index = Path(scratch) / "index"
        _git_in_index(root, index, "read-tree", "--empty")
        _git_in_index(
            root, index, "update-index", "--add", "--cacheinfo", f"100644,{blob},{LEASE_RECORD_PATH}",
        )
        tree = _git_in_index(root, index, "write-tree").strip()
    return _lease_git(
        root, "-c", f"user.name={COMMITTER_NAME}", "-c", f"user.email={COMMITTER_EMAIL}",
        "-c", "commit.gpgsign=false", "commit-tree", tree, *(("-p", parent) if parent else ()),
        "-m", message,
    ).strip()


def _push_record(
    root: Path,
    *,
    remote: str,
    branch: str,
    parent: str | None,
    record: dict[str, Any],
    message: str,
) -> bool:
    """Commit ``record`` on ``parent`` and push it fast-forward-only, never
    forced. ``False`` is a rejected push: the caller re-reads and decides."""
    commit = lease_commit(root, parent=parent, record=record, message=message)
    return _lease_git_run(
        root, ("push", remote, f"{commit}:refs/heads/{branch}"), step=PUBLISH_PUSH_STEP,
    ).returncode == 0


def _state_tip(root: Path, *, remote: str, state_branch: str) -> str:
    probe = _probe_tip(root, remote=remote, branch=state_branch)
    if probe.status == "present" and probe.sha:
        return probe.sha
    if probe.status == "absent":
        return "absent"
    raise StateStoreError(
        f"state_writer_lease_state_tip_unreadable: {state_branch} probe {probe.status} {probe.detail}"
    )


def lease_record(
    lease: RemoteCasLease,
    *,
    run_id: str | None,
    ttl_minutes: int,
    secret_sha256: str,
    released_by: str | None = None,
    release_reason: str | None = None,
    repaired: bool = False,
) -> dict[str, Any]:
    return {
        "schema": LEASE_SCHEMA,
        **asdict(lease),
        "run_id": run_id,
        "ttl_minutes": ttl_minutes,
        "secret_sha256": secret_sha256,
        "released": released_by is not None,
        "released_by": released_by,
        "release_reason": release_reason,
        "repaired": repaired,
    }


def view_record(view: WriterLeaseView, lease: RemoteCasLease, **overrides: Any) -> dict[str, Any]:
    """The record ``view`` holds, with ``lease`` swapped in (a renewal or a
    fence: same lease id, same secret, fresh heartbeat)."""
    return lease_record(
        lease,
        run_id=view.run_id,
        ttl_minutes=view.ttl_minutes,
        secret_sha256=view.secret_sha256,
        **overrides,
    )


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
    the wait. ``owner`` is for tests; a lane is always named by
    ``writer_identity`` (the CLI has no flag for it). The returned lease
    carries the fresh capability token; nothing else ever sees it.
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
        token = secrets.token_hex(32)
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
            record=lease_record(
                lease, run_id=run, ttl_minutes=int(ttl_minutes), secret_sha256=token_digest(token),
            ),
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
                token=token,
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


def resolve_writer_lease_token(token: str | None = None) -> str:
    """The capability this process presents, or a named refusal."""
    resolved = (token or os.environ.get(WRITER_LEASE_TOKEN_ENV, "")).strip()
    if not resolved:
        raise StateStoreRefusal(
            "state_writer_lease_required: aria/state has one writer at a time and this "
            f"process holds no writer lease (${WRITER_LEASE_TOKEN_ENV} unset); take it with "
            "`state lease acquire` before `state checkout`, release it after the publish"
        )
    return resolved


def require_held_writer_lease(
    repo_root: str | Path,
    *,
    token: str | None = None,
    remote: str = "origin",
    state_branch: str = STATE_BRANCH,
) -> WriterLeaseView:
    """Refuse unless ``token`` (default: ``$ARIA_STATE_WRITER_LEASE_TOKEN``)
    is the capability of the current, unreleased writer lease."""
    presented = resolve_writer_lease_token(token)
    view = read_writer_lease(repo_root, remote=remote, state_branch=state_branch)
    if not view.held_by_token(presented):
        current = view.lease
        raise StateStoreRefusal(
            "state_writer_lease_not_held: the presented token is not the capability of the "
            f"current writer lease (current: {current.lease_id if current else 'none'} by "
            f"{current.owner if current else '-'}, released={view.released})"
        )
    return view


def _release_once(
    root: Path,
    view: WriterLeaseView,
    *,
    remote: str,
    branch: str,
    released_by: str,
    reason: str,
) -> bool:
    assert view.lease is not None
    stamp = _iso(_utc_now())
    released = RemoteCasLease(**{**asdict(view.lease), "heartbeat_at": stamp, "expires_at": stamp})
    return _push_record(
        root,
        remote=remote,
        branch=branch,
        parent=view.tip,
        record=view_record(view, released, released_by=released_by, release_reason=reason),
        message=f"chore(aria-state-lease): release epoch {released.epoch} by {released_by} ({reason})",
    )


def release_writer_lease(
    repo_root: str | Path,
    *,
    token: str | None = None,
    force_foreign_reason: str | None = None,
    remote: str = "origin",
    state_branch: str = STATE_BRANCH,
) -> dict[str, Any]:
    """Give the lease back — compare, then swap. Idempotent.

    Released when the caller presents the lease's token; or, with no token,
    when the current lease's owner IS this caller's ``writer_identity`` (the
    release step of the run that acquired it, GSEC-LOW-001); or with
    ``force_foreign_reason`` — the audited operator release of a holder that
    died without releasing, recorded on the lease branch with the reason.
    Anything else leaves the lease alone and says why.
    """
    root = Path(repo_root)
    branch = writer_lease_branch(state_branch)
    releaser, _run = writer_identity(root)
    for _attempt in range(_MAX_UNCHANGED_PUSH_FAILURES):
        view = read_writer_lease(root, remote=remote, state_branch=state_branch)
        if view.lease is None:
            return {"released": False, "reason": "no_lease"}
        if view.released:
            return {"released": False, "reason": "already_released", "lease_id": view.lease.lease_id}
        if token is not None:
            if not view.held_by_token(token):
                return {"released": False, "reason": "token_not_current", "current": view.as_json()}
            reason = "holder released"
        elif force_foreign_reason:
            reason = f"force-foreign: {force_foreign_reason}"
        elif view.lease.owner == releaser:
            reason = "holder released by identity"
        else:
            return {"released": False, "reason": "lease_not_held_by_caller", "current": view.as_json()}
        if _release_once(root, view, remote=remote, branch=branch, released_by=releaser, reason=reason):
            return {
                "released": True,
                "lease_id": view.lease.lease_id,
                "epoch": view.lease.epoch,
                "owner": view.lease.owner,
                "released_by": releaser,
                "release_reason": reason,
            }
    raise StateStoreError(
        f"state_writer_lease_release_failed: {branch} refused {_MAX_UNCHANGED_PUSH_FAILURES} "
        "release pushes; the lease expires at its recorded bound"
    )


def repair_writer_lease(
    repo_root: str | Path,
    *,
    reason: str,
    remote: str = "origin",
    state_branch: str = STATE_BRANCH,
) -> dict[str, Any]:
    """Replace a malformed or missing lease record with a released one.

    The recovery path for a record nobody can parse (GSEC-HIGH-002): every
    reader fails closed on it, so without this the branch could only be
    unwedged by hand. The replacement is a fast-forward child of the current
    tip, so the history keeps the broken record; it holds no secret, names
    who repaired it and why, and the next acquisition takes a higher epoch.
    A VALID record is not repaired: a held one is released with
    ``release --force-foreign --reason``, a free one needs nothing.
    """
    if not reason.strip():
        raise StateStoreError("state_writer_lease_repair_reason_required")
    root = Path(repo_root)
    branch = writer_lease_branch(state_branch)
    repairer, _run = writer_identity(root)
    tip, raw = _read_raw(root, remote=remote, branch=branch)
    if tip is None:
        return {"repaired": False, "reason": "no_lease_branch"}
    if raw is not None:
        try:
            view = _parse_record(raw, tip=tip)
        except StateStoreRefusal:
            view = None
        if view is not None:
            if view.is_held():
                raise StateStoreRefusal(
                    "state_writer_lease_repair_refused: the record is valid and held by "
                    f"{view.lease.owner if view.lease else '-'}; release it with "
                    "`state lease release --force-foreign --reason`"
                )
            return {"repaired": False, "reason": "record_valid", "current": view.as_json()}
    stamp = _iso(_utc_now())
    replacement = build_remote_cas_lease(
        previous=None,
        owner=f"repair:{repairer}",
        target_ref=f"refs/heads/{state_branch}",
        head_sha=_state_tip(root, remote=remote, state_branch=state_branch),
        ttl_minutes=1,
    )
    replacement = RemoteCasLease(**{**asdict(replacement), "expires_at": stamp, "heartbeat_at": stamp})
    record = lease_record(
        replacement,
        run_id=None,
        ttl_minutes=1,
        secret_sha256="",
        released_by=repairer,
        release_reason=f"repair: {reason.strip()}",
        repaired=True,
    )
    if not _push_record(
        root, remote=remote, branch=branch, parent=tip, record=record,
        message=f"chore(aria-state-lease): repair by {repairer} ({reason.strip()})",
    ):
        raise StateStoreError(
            f"state_writer_lease_repair_rejected: {branch} moved while repairing; read it again"
        )
    return {"repaired": True, "replaced_tip": tip, "repaired_by": repairer, "reason": reason.strip()}


__all__ = [
    "LEASED_PUBLISH_SECONDS",
    "LEASE_SCHEMA",
    "MAX_TTL_MINUTES",
    "PUBLISH_MARGIN_MINUTES",
    "WRITER_LEASE_TOKEN_ENV",
    "HeldWriterLease",
    "StateWriterLeaseBlocked",
    "StateWriterLeaseLost",
    "WriterLeaseView",
    "acquire_writer_lease",
    "lease_commit",
    "lease_record",
    "read_writer_lease",
    "release_writer_lease",
    "repair_writer_lease",
    "require_held_writer_lease",
    "resolve_writer_lease_token",
    "token_digest",
    "view_record",
    "writer_identity",
    "writer_lease_branch",
]
