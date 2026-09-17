"""The executor's hold on one claim is handed back on EVERY exit of the body.

WHY: `ci_executor._main` releases its claim at each failure branch by hand —
twenty-odd `_release_claim(...)` sites, each reachable only from the branch
that wrote it. An exit nobody wrote a branch for keeps the lease: on
2026-09-04 the spawn gate's refusal path raised (a `str` where the summary
writer read `.failure_class`) BEFORE any release site, and seven claims
(`ci-executor:gha-33920896040`) stayed CLAIMED with no released/stale row.
`derive_request_state` reaches PENDING from CLAIMED only through an explicit
released/requeued event; after the lease window it derives STALE, which the
queue skips and the claim CAS refuses. Both exits closed, seven requests dead.

WHAT: :class:`HeldClaim` is a context manager the executor registers on its
`ExitStack` the moment a lease exists. When the stack unwinds — a `return`,
an uncaught exception, anything — it asks the kernel whether the request is
STILL held by a live lease (CLAIMED / RUNNING) and, if so, releases it
through the executor's own release transport with a reason that names how
the body exited. A body that already released, submitted (ACCEPTED /
REJECTED), escalated (HUMAN_REQUIRED) or was cancelled leaves nothing held,
so the guard is silent there: the kernel's own ledgers, not per-site
bookkeeping, decide. The explicit release sites keep their precise reasons;
this guard is the floor beneath them, so a new exit path cannot leak.

The reason is harness-class (`executor_uncaught_exit:<how>`): a crash in the
wrapper says nothing about the request, so its requeue budget is untouched.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType

# The derived states in which a live lease still binds the request to this
# executor. Every other state is terminal, released, or escalated already.
HELD_STATES: frozenset[str] = frozenset({"CLAIMED", "RUNNING"})

# Owned by the kernel's release-reason vocabulary (release_reason._PREFIXES /
# agent_invocations.HARNESS_FAULT_RELEASE_REASON_PREFIXES); the suffix names
# the exit: the exception type, or `return_without_release`.
UNCAUGHT_EXIT_RELEASE_PREFIX = "executor_uncaught_exit:"
RETURN_WITHOUT_RELEASE = "return_without_release"

# (request_id, tools_dir) -> the kernel's derived request state, or None when
# the kernel has no such request (nothing can be held). Injected so this module
# owns no kernel import and the unit test can drive every branch directly.
StateReader = Callable[[str, Path], str | None]
NO_SUCH_REQUEST = "no_such_request"
# Keyword transport: tools_dir, repo, claim_id, agent_id, lease_token, reason
# -> whether the kernel accepted the release.
ReleaseTransport = Callable[..., bool]
# The executor's stage logger (`ci_executor._stage`): one line per guard
# release so the run log shows a hand-back the body never wrote itself.
StageLog = Callable[[str], None]


@dataclass
class HeldClaim:
    tools_dir: Path
    repo: Path
    request_id: str
    claim_id: str
    agent_id: str
    lease_token: str
    release: ReleaseTransport
    derive_state: StateReader | None
    log: StageLog
    # What the guard did on exit: `settled:<state>` when nothing was held,
    # `released:<reason>` when the release was accepted, `release_failed:
    # <reason>` when the kernel refused. The two release outcomes are also
    # written through `log` as a `held_claim_released` stage line — the
    # caller's stack has unwound by then, so nobody else could report it
    # (the field alone was read by tests only).
    outcome: str | None = None

    def __enter__(self) -> HeldClaim:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        state = self._state_or_unknown()
        if state is not None and state not in HELD_STATES:
            self.outcome = f"settled:{state}"
            return False
        how = exc_type.__name__ if exc_type is not None else RETURN_WITHOUT_RELEASE
        reason = UNCAUGHT_EXIT_RELEASE_PREFIX + how
        released = self.release(
            tools_dir=self.tools_dir, repo=self.repo, claim_id=self.claim_id,
            agent_id=self.agent_id, lease_token=self.lease_token, reason=reason,
        )
        self.outcome = ("released:" if released else "release_failed:") + reason
        self.log(
            f"held_claim_released request_id={self.request_id} claim_id={self.claim_id} "
            f"state={state or 'unreadable'} outcome={self.outcome}"
        )
        # Never swallow: the exit that reached here is still the caller's to
        # report; the guard only makes sure the lease did not go with it.
        return False

    def _state_or_unknown(self) -> str | None:
        """The kernel's answer; None when it could not be read.

        The reader's own None ("no such request") is a definitive answer and
        settles the guard. An unreadable ledger is not a reason to keep the
        lease: the release transport asks the kernel again, and the kernel
        refuses a release that has nothing to release — loudly, on stderr.
        """
        if self.derive_state is None:
            return None
        try:
            state = self.derive_state(self.request_id, self.tools_dir)
        except Exception:  # noqa: BLE001 — every failure class means "unknown"
            return None
        return NO_SUCH_REQUEST if state is None else state


__all__ = [
    "HELD_STATES",
    "NO_SUCH_REQUEST",
    "RETURN_WITHOUT_RELEASE",
    "UNCAUGHT_EXIT_RELEASE_PREFIX",
    "HeldClaim",
    "ReleaseTransport",
    "StageLog",
    "StateReader",
]
