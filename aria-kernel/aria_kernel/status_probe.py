"""The native status probe — a three-valued observation and its liveness bound.

WHY. On 2026-09-12 (trial eleven, host load ~7) the managed Anthropic probe
`claude auth status --json` stalled to its 20 s cap and the fleet admission
read the row exactly like an auth refusal — not eligible, next vendor — so a
converging plan's primary planner ran on openai/gpt-6-astra while two
dispatches earlier the same probe had answered `available`. A probe that did
not answer is not an auth fact (operator decision 2026-09-12: read-only
roles fail over across vendors for AUTH reasons only; opus is a leaf for its
roles). The defect class is the one `ledger.STATE_LOCK_LIVENESS_SECONDS`
and `evidence_probe.GitProbeSession` remove elsewhere: a liveness guard used
as a performance budget, and an undecided observation laundered into a
decision.

WHAT.
* `StatusDecision` — every observation names which of three things the
  probe established, BY CONSTRUCTION: AVAILABLE (the vendor confirmed the
  managed session or credential), UNAVAILABLE (the vendor or the ledger
  SAID no: auth refused, logged out, an API-key login, quota exhausted or
  cooled, the CLI absent, the credential not configured, a read-only
  runtime for a writer) or UNDECIDED (no answer: a stall, a transport
  error, an elapsed deadline, an unreadable answer — a non-zero exit that
  came WITH a readable document is the vendor's answer and is decided by
  the document, `tools/aria-poc/status_answers.py`).
  `_RuntimeStatusObservation` requires the field and refuses a row whose
  strings contradict it, so no reader has to compare reason strings to
  learn whether the vendor was actually heard.
* The liveness bound — an UNDECIDED probe is retried (`STATUS_PROBE_ATTEMPTS`
  attempts, `STATUS_PROBE_BACKOFF_SECONDS` between them, every attempt
  capped by the policy's `recheck_timeout_seconds`, which keeps its meaning
  as the per-attempt cap) on ONE clock per admission (`AdmissionClock`)
  before the fleet moves on. The `ProbeRecord` — attempts made, each
  undecided reason, backoff slept — travels with the observation onto the
  candidate row, so a reader can tell a stalled probe from a refused login.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Protocol

# ONE attempt of ONE probe is capped by the policy's `recheck_timeout_seconds`
# (20 s). A probe is tried this many times inside one admission before the
# admission reports it could not be decided. One stall on a loaded host is
# the observed failure shape (trial eleven: the same probe answered two
# dispatches earlier); a CLI that stalls three times in a row inside one
# admission is the host's state, and the admission says so by name
# (`provider_undecided`) rather than guessing a vendor verdict.
STATUS_PROBE_ATTEMPTS: int = 3

# The pause before attempt 2 and before attempt 3. Short: the retry exists
# for a transient stall (scheduler contention, a swapped-out CLI paging back
# in — the second attempt runs against the page cache the first one warmed),
# not for an outage that minutes of waiting would heal.
STATUS_PROBE_BACKOFF_SECONDS: tuple[float, ...] = (2.0, 5.0)

# The reason an observation carries when the admission's clock ran out
# before this provider could be asked (or asked again). Undecided: nothing
# was heard, and the row says why nothing was.
STATUS_DEADLINE_ELAPSED_REASON = "status_deadline_elapsed"


class StatusDecision(Enum):
    """What ONE status probe established about a provider, and nothing more."""

    AVAILABLE = "available"
    """Decided: the vendor confirmed the managed session / credential."""

    UNAVAILABLE = "unavailable"
    """Decided: the vendor or the ledger said no. This — and only this —
    is what lets the fleet ladder move on to the next vendor."""

    UNDECIDED = "undecided"
    """Nothing was established: a stall, a transport error, an elapsed
    deadline, an unreadable answer (a non-zero exit WITH a readable
    document is decided by the document). Retried within the
    liveness bound; never a reason to fail over."""


@dataclass(frozen=True)
class _RuntimeStatusObservation:
    """One provider's status as the runtime's probe reported it.

    `decision` is required by keyword at every construction site: the site
    that saw the vendor's answer (or did not) is the one that knows which of
    the three it was, and `__post_init__` refuses the contradictions a
    string could otherwise smuggle past a reader (an `available` auth row
    marked undecided; an `unavailable` auth row marked available).
    """

    auth_observation: str
    quota_observation: str = "unknown"
    reason: str = "status_unavailable"
    command: tuple[str, ...] = ()
    exit_code: int | None = None
    control_status: str = "unknown"
    control_reason: str = "native_runtime_control_binding_unavailable"
    auth_method: str = "unknown"
    credential_source: str = "unknown"
    """Which boundary supplied the credential ('managed_session', 'file', 'env'). Never a value."""
    decision: StatusDecision = field(kw_only=True)

    def __post_init__(self) -> None:
        if self.auth_observation not in ("available", "unavailable", "unknown"):
            raise ValueError(f"runtime_status_auth_observation_unknown_spelling:{self.auth_observation!r}")
        if self.decision is StatusDecision.AVAILABLE and self.auth_observation != "available":
            raise ValueError(f"runtime_status_decision_contradicts_auth:{self.auth_observation}:{self.reason}")
        if self.auth_observation == "unavailable" and self.decision is not StatusDecision.UNAVAILABLE:
            raise ValueError(f"runtime_status_auth_unavailable_not_decided:{self.decision.value}:{self.reason}")
        if self.auth_observation == "available" and self.decision is StatusDecision.UNDECIDED:
            raise ValueError(f"runtime_status_auth_available_marked_undecided:{self.reason}")


class _StatusProbe(Protocol):
    def __call__(self, provider: Any, timeout_seconds: float) -> _RuntimeStatusObservation: ...


def status_probe_liveness_seconds(attempt_cap_seconds: float) -> float:
    """The worst case ONE provider can cost an admission: every attempt at
    its cap plus every backoff. Derived here so it cannot drift from the
    attempt count and pauses above."""
    return STATUS_PROBE_ATTEMPTS * float(attempt_cap_seconds) + sum(STATUS_PROBE_BACKOFF_SECONDS)


@dataclass
class AdmissionClock:
    """The one wall clock of ONE native admission across the whole fleet.

    `attempt_cap_seconds` is the policy's `recheck_timeout_seconds`;
    `liveness_seconds` is the admission's whole bound (the fleet derives it:
    `native_admission.native_admission_budget_seconds`). Every attempt is asked
    for at most the cap and never past what remains; every backoff is
    clipped to what remains; once the clock is out no further attempt is
    spawned and the observation says `status_deadline_elapsed`. A test with
    a stalled fake probe passes its own `monotonic`/`sleep` instead of
    patching module clocks.
    """

    attempt_cap_seconds: float
    liveness_seconds: float
    attempts: int = STATUS_PROBE_ATTEMPTS
    backoff_seconds: tuple[float, ...] = STATUS_PROBE_BACKOFF_SECONDS
    monotonic: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    started_at: float = field(init=False)

    def __post_init__(self) -> None:
        if self.attempts < 1:
            raise ValueError(f"admission_clock_attempts_below_one:{self.attempts}")
        if self.attempt_cap_seconds <= 0 or self.liveness_seconds <= 0:
            raise ValueError("admission_clock_bounds_must_be_positive")
        self.started_at = self.monotonic()

    def remaining_seconds(self) -> float:
        return self.liveness_seconds - (self.monotonic() - self.started_at)


@dataclass(frozen=True)
class ProbeRecord:
    """How an observation was reached — the evidence next to the verdict.

    `attempts` is how many times the probe was asked (0 when the row was
    decided without a probe: a cooled provider, an absent CLI);
    `undecided_reasons` is every answer-less attempt's reason in order —
    ALL of them, on every path: a provider decided on retry shows the stall
    it survived, and one that never answered shows each of its attempts,
    the last one included, so `len(undecided_reasons)` is the number of
    attempts that established nothing whichever bound ended the retry;
    `backoff_seconds` is the pause actually slept between attempts.
    """

    attempts: int
    undecided_reasons: tuple[str, ...]
    backoff_seconds: float

    @classmethod
    def unprobed(cls) -> "ProbeRecord":
        return cls(attempts=0, undecided_reasons=(), backoff_seconds=0.0)

    def as_row(self) -> dict[str, Any]:
        return {"attempts": self.attempts, "undecided_reasons": list(self.undecided_reasons),
                "backoff_seconds": self.backoff_seconds}


def observe_until_decided(
    provider: Any, observe_status: _StatusProbe, clock: AdmissionClock,
) -> tuple[_RuntimeStatusObservation, ProbeRecord]:
    """Probe one provider to a DECISION, or report honestly that none came.

    Each attempt is offered `min(attempt cap, clock remaining)`; a decided
    observation (available OR unavailable — a refusal is an answer) ends
    the retry at once. Only an UNDECIDED observation is retried, after the
    matching backoff (clipped to the clock). When the attempts are spent
    the LAST undecided observation is returned — its reason names the
    final stall — and when the clock is spent before an attempt can start,
    the observation is `status_deadline_elapsed` with the attempts so far.
    On both paths the record lists EVERY undecided attempt's reason (the
    final one included), so a reader reconstructs the history the same
    way whichever bound ended the retry.
    """
    attempts = 0
    undecided: list[str] = []
    slept = 0.0
    command: tuple[str, ...] = ()
    while True:
        remaining = clock.remaining_seconds()
        if remaining <= 0.0:
            return (
                _RuntimeStatusObservation(
                    "unknown", reason=STATUS_DEADLINE_ELAPSED_REASON, command=command,
                    decision=StatusDecision.UNDECIDED,
                ),
                ProbeRecord(attempts, tuple(undecided), slept),
            )
        attempts += 1
        observed = observe_status(provider, min(clock.attempt_cap_seconds, remaining))
        if observed.decision is not StatusDecision.UNDECIDED:
            # A decision: the record beside it says how many times the
            # vendor was asked and what each answer-less attempt reported.
            return observed, ProbeRecord(attempts, tuple(undecided), slept)
        undecided.append(observed.reason)
        command = observed.command
        if attempts >= clock.attempts:
            # The last attempt's own undecided answer, with itself on the
            # record: three attempts are three reasons, never two.
            return observed, ProbeRecord(attempts, tuple(undecided), slept)
        pause = clock.backoff_seconds[min(attempts - 1, len(clock.backoff_seconds) - 1)] if clock.backoff_seconds else 0.0
        pause = min(pause, max(0.0, clock.remaining_seconds()))
        if pause > 0.0:
            clock.sleep(pause)
            slept += pause


__all__ = [
    "STATUS_DEADLINE_ELAPSED_REASON",
    "STATUS_PROBE_ATTEMPTS",
    "STATUS_PROBE_BACKOFF_SECONDS",
    "AdmissionClock",
    "ProbeRecord",
    "StatusDecision",
    "_RuntimeStatusObservation",
    "observe_until_decided",
    "status_probe_liveness_seconds",
]
