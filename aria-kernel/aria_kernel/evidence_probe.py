"""One bounded, retried git probe for the evidence classifier.

WHAT lives here: the bounds a `git show` / `git cat-file` / `git rev-parse`
evidence probe runs under, the retry that separates "git stalled once" from
"git is not answering", and the once-per-decision baseline resolution that
separates "this workspace cannot read the baseline commit" from "the tree
was read and disagrees".

WHY it is its own module: `evidence_trust.classify_evidence_ref` is called
once per ref, and the ONE decision it serves (a submission with 44 refs, a
cycle-side evidence gate) has one wall clock and one baseline. A bound and
a cache that belong to the decision cannot live inside a per-ref function;
they live on a ``GitProbeSession`` the caller creates once and threads
through every classification.

WHY the bounds are liveness guards and not budgets (the class
`ledger.STATE_LOCK_LIVENESS_SECONDS` names): a probe reads one object from
the local store — milliseconds on a quiet host, seconds on a saturated one.
The pre-push host of 2026-09-12 (load 6-20 on 4 CPUs) pushed one `git show`
past a 5 s bound, and that single stall re-dispatched a whole paid agent run
once the acceptance seam re-labelled it. A stall is retried with backoff
here, so the honest terminal grade `verification_unavailable` is reached
only after git failed to answer several times inside one decision's clock.
"""
from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path


# ONE attempt of ONE probe. A git that has not answered a single object read
# in 30 s is not slow, it is not answering (a hung filesystem, a stopped
# process, a fork storm): the attempt ends and the session retries. Sized so
# a saturated-but-alive host (seconds per read) never reaches it.
GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS: float = 30.0

# A probe is tried this many times before the session reports it could not
# run. One stall on a loaded host is the observed failure shape; a git that
# stalls three times in a row inside one decision is the host's fault and
# the grade says so.
GIT_PROBE_ATTEMPTS: int = 3

# The pause before attempt 2 and before attempt 3. Short: the retry exists
# for a transient stall (a scheduler hiccup, a page-cache miss under
# pressure), not for an outage a minute of waiting would heal.
GIT_PROBE_BACKOFF_SECONDS: tuple[float, ...] = (1.0, 2.0)

# How long ONE probe can take before the session reports it could not run:
# every attempt at its bound plus every backoff. The number a caller that
# runs a single probe outside any decision — the executor's pre-claim git
# gate — prices into its own worst case; derived here so it cannot drift
# from the attempt count and bounds above.
GIT_PROBE_WORST_CASE_SECONDS: float = (
    GIT_PROBE_ATTEMPTS * GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS
    + sum(GIT_PROBE_BACKOFF_SECONDS)
)

# The probe wall clock of ONE acceptance decision across ALL its refs.
#
# WHY it exists: the per-attempt bound and the retry bound one REF; a
# submission carries many (44 in the 2026-08-09 incident, plus every match
# of every glob). A git that stalls on each of them would otherwise cost
# refs x attempts x attempt-bound before the decision is reached. Once this
# clock runs out no further probe is spawned: every remaining ref grades
# `verification_unavailable` at once, and the decision is delivered.
#
# WHY this size: a saturated-but-alive host answers one read in seconds; a
# few hundred reads at that rate is minutes. Three hundred seconds is the
# same magnitude the state store grants ONE tree-bound git call
# (`state_store.GIT_TIMEOUT_SECONDS`), spent here on a whole decision. It is
# also what the executor's submit wall clock is derived from — see
# `tools/aria-poc/ci_executor.SUBMIT_RESULT_TIMEOUT_SECONDS`.
EVIDENCE_VERIFICATION_LIVENESS_SECONDS: float = 300.0

# Why a probe could not run. Closed vocabulary, on the outcome and on the
# baseline resolution, so a reader of a rejection can tell a stall from a
# workspace that never had the commit.
PROBE_TIMEOUT = "timeout"
PROBE_SPAWN_FAILED = "spawn_failed"
PROBE_LIVENESS_BOUND_EXHAUSTED = "liveness_bound_exhausted"
BASELINE_UNREACHABLE = "baseline_unreachable"


@dataclass(frozen=True)
class ProbeOutcome:
    """What ONE probe (after its retries) came back with.

    ``answered`` is the tri-state pivot: True means git ran to completion
    and ``returncode``/``stdout``/``stderr`` are its verdict — including a
    non-zero exit, which IS an answer; False means no attempt completed and
    ``unavailable_reason`` says why.
    """

    answered: bool
    returncode: int | None
    stdout: bytes
    stderr: str
    unavailable_reason: str | None
    attempts: int


@dataclass(frozen=True)
class BaselineResolution:
    """The commit one decision verifies against, resolved once.

    ``commit_sha`` is the full object id when the workspace can read the
    commit. ``unavailable_reason`` is ``BASELINE_UNREACHABLE`` when git
    answered that it cannot (the object is not in this store, or this is
    not a repository) and a probe reason when git did not answer at all.
    Either way nothing about any ref can be compared, and the grade is
    `verification_unavailable`, never `worktree_candidate`.
    """

    requested: str
    commit_sha: str | None
    unavailable_reason: str | None
    detail: str

    @property
    def readable(self) -> bool:
        return self.commit_sha is not None


@dataclass
class GitProbeSession:
    """The probe clock and baseline cache of ONE acceptance decision.

    Construct one per decision (one submission, one cycle gate) and pass it
    to every ``classify_evidence_ref`` of that decision. The defaults are
    the production bounds; a test with a stalled fake git passes smaller
    ones instead of patching module constants.
    """

    attempt_timeout_seconds: float = GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS
    attempts: int = GIT_PROBE_ATTEMPTS
    backoff_seconds: tuple[float, ...] = GIT_PROBE_BACKOFF_SECONDS
    liveness_seconds: float = EVIDENCE_VERIFICATION_LIVENESS_SECONDS
    started_at: float = field(default_factory=time.monotonic)
    # Diagnostics for the decision's reasons and for tests: how many single
    # attempts did not answer, and how many probes were refused because the
    # decision's clock had already run out.
    stalled_attempts: int = 0
    probes_refused_after_bound: int = 0
    _baselines: dict[tuple[str, str], BaselineResolution] = field(
        default_factory=dict, repr=False,
    )

    def remaining_seconds(self) -> float:
        return self.liveness_seconds - (time.monotonic() - self.started_at)

    def run(self, argv: list[str], *, cwd: Path) -> ProbeOutcome:
        """Run one git probe to an answer, or report why none came.

        Each attempt waits at most ``attempt_timeout_seconds`` and never
        past the session's remaining clock; between attempts the session
        pauses for the matching backoff (also clipped to the clock). A
        completed attempt — any exit code — is the answer and ends the
        retry: only a stall (`TimeoutExpired`) or a spawn failure
        (`OSError`, e.g. `EAGAIN` under a fork storm) is retried.
        """
        attempts_made = 0
        last_reason: str | None = None
        for attempt_index in range(self.attempts):
            remaining = self.remaining_seconds()
            if remaining <= 0.0:
                self.probes_refused_after_bound += 1
                return ProbeOutcome(
                    answered=False,
                    returncode=None,
                    stdout=b"",
                    stderr="",
                    unavailable_reason=PROBE_LIVENESS_BOUND_EXHAUSTED,
                    attempts=attempts_made,
                )
            attempts_made += 1
            try:
                proc = subprocess.run(
                    argv,
                    cwd=cwd,
                    capture_output=True,
                    check=False,
                    timeout=min(self.attempt_timeout_seconds, remaining),
                )
            except subprocess.TimeoutExpired:
                self.stalled_attempts += 1
                last_reason = PROBE_TIMEOUT
            except OSError:
                self.stalled_attempts += 1
                last_reason = PROBE_SPAWN_FAILED
            else:
                stderr_text = proc.stderr.decode("utf-8", errors="replace")
                return ProbeOutcome(
                    answered=True,
                    returncode=proc.returncode,
                    stdout=proc.stdout,
                    stderr=stderr_text,
                    unavailable_reason=None,
                    attempts=attempts_made,
                )
            if attempt_index + 1 < self.attempts:
                pause = (
                    self.backoff_seconds[attempt_index]
                    if attempt_index < len(self.backoff_seconds)
                    else (self.backoff_seconds[-1] if self.backoff_seconds else 0.0)
                )
                pause = min(pause, max(0.0, self.remaining_seconds()))
                if pause > 0.0:
                    time.sleep(pause)
        return ProbeOutcome(
            answered=False,
            returncode=None,
            stdout=b"",
            stderr="",
            unavailable_reason=last_reason,
            attempts=attempts_made,
        )

    def resolve_baseline(self, root: Path, target_sha: str) -> BaselineResolution:
        """Resolve ``target_sha`` to a commit this workspace can read — once.

        `git rev-parse --verify <target>^{commit}` answers three different
        things and they are kept apart: the full id (readable), a non-zero
        exit (git READ the store and the commit is not there, or there is
        no repository here — unreachable, the workspace's gap), or no
        answer (a stall, the host's gap). Cached per (workspace, target) so
        a decision with N refs resolves its one baseline one time. A
        readable resolution is cached under the resolved id as well: a
        decision that resolves `HEAD` and then verifies every ref against
        the id it got back asks git once, not twice.
        """
        requested = target_sha.strip()
        key = (str(root), requested)
        cached = self._baselines.get(key)
        if cached is not None:
            return cached
        outcome = self.run(
            ["git", "rev-parse", "--verify", f"{requested}^{{commit}}"],
            cwd=root,
        )
        if not outcome.answered:
            resolution = BaselineResolution(
                requested=requested,
                commit_sha=None,
                unavailable_reason=outcome.unavailable_reason,
                detail=f"git rev-parse did not answer: {outcome.unavailable_reason}",
            )
        else:
            value = outcome.stdout.decode("utf-8", errors="replace").strip()
            if outcome.returncode == 0 and value:
                resolution = BaselineResolution(
                    requested=requested,
                    commit_sha=value,
                    unavailable_reason=None,
                    detail="",
                )
            else:
                resolution = BaselineResolution(
                    requested=requested,
                    commit_sha=None,
                    unavailable_reason=BASELINE_UNREACHABLE,
                    detail=outcome.stderr.strip().splitlines()[0] if outcome.stderr.strip() else (
                        f"git rev-parse exited {outcome.returncode}"
                    ),
                )
        self._baselines[key] = resolution
        if resolution.commit_sha is not None:
            self._baselines.setdefault(
                (str(root), resolution.commit_sha),
                BaselineResolution(
                    requested=resolution.commit_sha,
                    commit_sha=resolution.commit_sha,
                    unavailable_reason=None,
                    detail="",
                ),
            )
        return resolution


__all__ = [
    "BASELINE_UNREACHABLE",
    "BaselineResolution",
    "EVIDENCE_VERIFICATION_LIVENESS_SECONDS",
    "GIT_PROBE_ATTEMPTS",
    "GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS",
    "GIT_PROBE_BACKOFF_SECONDS",
    "GIT_PROBE_WORST_CASE_SECONDS",
    "GitProbeSession",
    "PROBE_LIVENESS_BOUND_EXHAUSTED",
    "PROBE_SPAWN_FAILED",
    "PROBE_TIMEOUT",
    "ProbeOutcome",
]
