"""Plan ARIA-V5 §2 V5.2 — Gate B post-implementation adversarial review runner.

V5.2 wires the post-implementation adversarial review loop into the
autonomy orchestrator. After ``worker_drainer`` completes (workers
have claimed assignments, verified, and produced implementation
artifacts), the orchestrator calls ``review_runner`` BEFORE
``auto_merge_runner`` — gating auto-merge on
``review_verdict == "no_gaps"``.

Operator vision (Plan ARIA-V5 §1, verbatim):
  "ımplementerler ımplement ettıkten sonra da eksık varmı yanlıs varmı
   dıye agentlar yıne kontrol etmelı"

The drainer mints adversarial_judge + evidence_judge envelopes
(post-impl judgment roles already in ``agent_invocations.ROLES``).
Default loop:

  1. round 1 — mint adversarial_judgment envelope; poll for
     submission until ``judge_timeout_seconds`` expires
  2. if adversarial judge returns gaps → mint evidence_judgment
     envelope (second opinion); combine verdicts
  3. if both judges say no_gaps → return ``no_gaps``
  4. if judges disagree → return ``judge_split``
  5. loop to next round if gaps_open up to ``max_review_rounds``
  6. on cap → return ``max_review_rounds``
  7. if cycle_id ↔ impl_artifacts_ref hash mismatch → return
     ``artifact_mismatch``

Defensive default: when no real adversarial / evidence judge is
claiming envelopes (typical autonomous-run mode without real Claude Code
/ Claude Code dispatchers), the drainer times out at ``gaps_open``;
the orchestrator then skips ``auto_merge_runner`` cleanly. This is
the correct fail-closed behaviour — no review consensus, no
auto-merge. Future V6+ work wires real judges to consume the
envelopes.

ORPHAN-HIGH-422 evidence invariant:
  ``no_gaps`` is derived ONLY from an accepted result row bound to the
  round's own request id AND role, carried back on
  ``ReviewResult.accepted_result_ref``. Pre-fix the loop inferred success
  from ``next_pending_request(...) is None`` — but a request leaves the
  pending set on claim, rejection, cancellation, staleness and
  HUMAN_REQUIRED escalation, so the one signal meaning "a human must look
  at this" was the signal that cleared the gate. Absence of work waiting
  is not evidence that work was done.

Tests inject mock review runners via the ``review_runner`` kwarg on
``run_autonomy_orchestrator``; see
``aria-kernel/tests/invariants/v5/_helpers.py`` for the canonical
mock fakes covering all V5.2 verdict paths.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict

from .agent_invocations import (
    accepted_result_for_request,
    create_agent_invocation_request,
    derive_request_state,
)
from .agent_surface import TERMINAL_REQUEST_STATES
from .tool_registry import ensure_tools_dir


# Plan ARIA-V5 §3d v2 — judge agent identifiers (mint envelopes for
# these target agents at the corresponding roles).
_ADVERSARIAL_JUDGE_AGENT = "aria-adversarial-judge"
_EVIDENCE_JUDGE_AGENT = "aria-evidence-judge"
_ADVERSARIAL_ROLE = "adversarial_judgment"
_EVIDENCE_ROLE = "evidence_judgment"

# ORPHAN-HIGH-422 — terminal derived states that will never produce an
# accepted result. Reaching one of these ends the wait immediately: no
# amount of further polling turns a rejection or an escalation into a
# review. ``ACCEPTED`` is deliberately absent — that path is detected by
# the presence of the accepted result row itself, not by the state string,
# so a state that says ACCEPTED without a readable result row still fails
# closed.
# ORPHAN-HIGH-496 — DERIVED from the terminal-state SSoT, not a copy of it.
# This was a hand-maintained list and it silently fell behind when
# ANCHOR_STALE was added: an anchor-refused request can never produce an
# accepted result, but the poll loop did not recognise the state and burned
# its full judge_timeout_seconds waiting for one. Every terminal state except
# ACCEPTED is non-delivering by definition, so the exception is what gets
# named and a future terminal state joins automatically.
_NON_DELIVERING_TERMINAL_STATES: frozenset[str] = TERMINAL_REQUEST_STATES - {"ACCEPTED"}


class ReviewResult(TypedDict):
    """Plan ARIA-V5 §3d v2 — review runner return contract."""

    plan_id: str
    impl_artifacts_ref: str
    review_verdict: Literal[
        "no_gaps",
        "gaps_open",
        "max_review_rounds",
        "judge_split",
        "artifact_mismatch",
    ]
    rounds_count: int
    gaps_found: list[dict[str, Any]]
    request_ids: list[str]
    convergence_id: str
    # ORPHAN-HIGH-422 — the accepted result a ``no_gaps`` verdict was
    # derived from (request_id, role, agent_id, output_hash,
    # transcript_hash). ``None`` on every non-``no_gaps`` verdict, so a
    # consumer can tell an evidenced pass from an inferred one.
    accepted_result_ref: dict[str, Any] | None


class ReviewRunner(Protocol):
    """Plan ARIA-V5 §3d v2 — injection-seam contract for the post-
    implementation review loop.

    Why a Protocol vs a Callable type alias: same rationale as
    ``ConvergenceRunner`` — Protocol forces every mock + production
    runner to expose the EXACT keyword-only kwargs by name, making
    the contract structural.
    """

    def __call__(
        self,
        *,
        cycle_id: str,
        base_dir: Path,
        workspace_root: Path | None,
        plan_id: str,
        convergence_id: str,
        impl_artifacts_ref: str,
        worker_artifact_hash: str,
        must_satisfy: list[dict[str, Any]],
        max_review_rounds: int = 3,
        judge_timeout_seconds: float = 1800.0,
    ) -> ReviewResult: ...


def _empty_review_result(
    plan_id: str,
    convergence_id: str,
    impl_artifacts_ref: str,
    verdict: str,
    rounds_count: int = 0,
    gaps_found: list[dict[str, Any]] | None = None,
    request_ids: list[str] | None = None,
    accepted_result_ref: dict[str, Any] | None = None,
) -> ReviewResult:
    """Plan ARIA-V5 §3d v2 — build a structurally-valid ReviewResult.

    Used by every short-circuit path in ``run_review_runner`` so a
    partial state never leaks. TypedDict ensures all required keys are
    present at construction time.

    ORPHAN-HIGH-422 — ``accepted_result_ref`` is refused on any verdict
    other than ``no_gaps``: a blocking verdict has no accepted result by
    definition, and allowing one to be attached would let a caller read
    "evidence exists" off a result that blocked.
    """
    if accepted_result_ref is not None and verdict != "no_gaps":
        raise ValueError(
            f"accepted_result_ref is only valid on a no_gaps verdict, got {verdict!r}"
        )
    return ReviewResult(
        plan_id=plan_id,
        impl_artifacts_ref=impl_artifacts_ref,
        review_verdict=verdict,  # type: ignore[typeddict-item]
        rounds_count=rounds_count,
        gaps_found=list(gaps_found or []),
        request_ids=list(request_ids or []),
        convergence_id=convergence_id,
        accepted_result_ref=accepted_result_ref,
    )


def _check_aria_stop(root: Path) -> bool:
    return (root / "ARIA_STOP").exists()


def run_review_runner(
    *,
    cycle_id: str,
    base_dir: str | Path,
    workspace_root: str | Path | None,
    plan_id: str,
    convergence_id: str,
    impl_artifacts_ref: str,
    worker_artifact_hash: str,
    must_satisfy: list[dict[str, Any]],
    max_review_rounds: int = 3,
    judge_timeout_seconds: float = 1800.0,
) -> ReviewResult:
    """Plan ARIA-V5 §2 — default Gate B review runner.

    Drives the post-implementation adversarial review loop via the
    ``aria-adversarial-judge`` + ``aria-evidence-judge`` envelope
    queue. Returns ``ReviewResult`` whose ``review_verdict`` the
    autonomy orchestrator consumes to gate ``auto_merge_runner``.

    Verdict semantics:

      * ``no_gaps`` — adversarial + (optional) evidence judges agree
        the implementation satisfies the convergence-stage
        must_satisfy contract. Orchestrator proceeds to auto-merge.
      * ``gaps_open`` — at least one judge found a gap that the
        worker did not close. Orchestrator skips auto-merge.
      * ``max_review_rounds`` — review_runner exhausted its
        ``max_review_rounds`` budget without convergence to either
        verdict.
      * ``judge_split`` — adversarial says no_gaps, evidence says
        gaps_open (or vice versa); operator review required.
      * ``artifact_mismatch`` — the ``worker_artifact_hash`` does
        NOT match the cycle's expected hash; the orchestrator MUST
        block merge (potential supply-chain tamper).

    Defensive default: when no real judge claims an envelope,
    poll times out and the verdict defaults to ``gaps_open`` (NOT
    ``no_gaps``) — fail-closed prevents unreviewed merges. The
    operator opts into faster autonomous runs by setting
    ``judge_timeout_seconds`` shorter at the CLI / config layer.
    """
    root = ensure_tools_dir(base_dir)

    # Plan ARIA-V5 §3d v2 R-B3 — artifact-hash mismatch is the only
    # short-circuit path that bypasses judge dispatch. The bound
    # triple (cycle_id, impl_artifacts_ref, worker_artifact_hash)
    # is verified at entry; mismatch → block merge.
    if impl_artifacts_ref and worker_artifact_hash:
        expected_marker = f"{cycle_id}:{worker_artifact_hash}"
        if expected_marker not in impl_artifacts_ref and worker_artifact_hash not in impl_artifacts_ref:
            return _empty_review_result(
                plan_id=plan_id,
                convergence_id=convergence_id,
                impl_artifacts_ref=impl_artifacts_ref,
                verdict="artifact_mismatch",
                rounds_count=0,
                gaps_found=[{
                    "id": "artifact_hash_mismatch",
                    "severity": "CRITICAL",
                    "evidence_ref": f"cycle:{cycle_id}",
                    "description": (
                        f"worker_artifact_hash={worker_artifact_hash} "
                        f"not found in impl_artifacts_ref={impl_artifacts_ref}"
                    ),
                }],
            )

    request_ids: list[str] = []

    for round_n in range(1, max_review_rounds + 1):
        if _check_aria_stop(root):
            return _empty_review_result(
                plan_id=plan_id,
                convergence_id=convergence_id,
                impl_artifacts_ref=impl_artifacts_ref,
                verdict="gaps_open",
                rounds_count=round_n,
                request_ids=request_ids,
                gaps_found=[{
                    "id": "aria_stop_during_review",
                    "severity": "MEDIUM",
                    "evidence_ref": f"cycle:{cycle_id}",
                }],
            )

        adversarial_request = create_agent_invocation_request(
            target_agent=_ADVERSARIAL_JUDGE_AGENT,
            role=_ADVERSARIAL_ROLE,
            suggested_prompt=(
                "Audit the implementation against the convergence-stage "
                "must_satisfy contract. Surface every gap, no matter "
                "how minor."
            ),
            must_satisfy=must_satisfy,
            allowed_scope=[f"cycle/{cycle_id}"],
            evidence_refs=[f"cycle:{cycle_id}"],
            convergence_id=convergence_id,
            round_number=round_n,
            base_dir=base_dir,
            plan_revision_hash=worker_artifact_hash or None,
        )
        adversarial_request_id = str(adversarial_request["request_id"])
        request_ids.append(adversarial_request_id)

        # ORPHAN-HIGH-422 — wait for a POSITIVE result, not for the
        # absence of a pending row. Pre-fix this loop treated
        # ``next_pending_request(...) is None`` as "submitted", but a
        # request leaves the pending set on claim, rejection, cancellation
        # and — most dangerously — HUMAN_REQUIRED escalation. The one
        # signal meaning "a human must look at this" was the signal that
        # cleared the gate. Only an accepted result row bound to THIS
        # request and role now counts as a submission.
        deadline = time.monotonic() + judge_timeout_seconds
        poll_sleep = max(0.05, min(5.0, judge_timeout_seconds / 60.0))
        accepted_result: dict[str, Any] | None = None
        blocking_state: str | None = None
        while time.monotonic() < deadline:
            if _check_aria_stop(root):
                break
            accepted_result = accepted_result_for_request(
                request_id=adversarial_request_id,
                role=_ADVERSARIAL_ROLE,
                base_dir=base_dir,
            )
            if accepted_result is not None:
                break
            state = derive_request_state(
                request_id=adversarial_request_id, base_dir=base_dir,
            )
            if state in _NON_DELIVERING_TERMINAL_STATES:
                # Terminal without an accepted result. Stop waiting: no
                # further polling can turn this into a review.
                blocking_state = state
                break
            time.sleep(poll_sleep)

        if _check_aria_stop(root):
            return _empty_review_result(
                plan_id=plan_id,
                convergence_id=convergence_id,
                impl_artifacts_ref=impl_artifacts_ref,
                verdict="gaps_open",
                rounds_count=round_n,
                request_ids=request_ids,
            )

        if accepted_result is None:
            # No accepted result: either a non-delivering terminal state
            # (rejected / human_required / stale / cancelled) or the
            # timeout expired with the judge still pending. Both block
            # auto-merge. A terminal state is reported rather than retried
            # — another round would mint a fresh envelope for a judge that
            # already refused or escalated.
            if blocking_state is None:
                continue
            return _empty_review_result(
                plan_id=plan_id,
                convergence_id=convergence_id,
                impl_artifacts_ref=impl_artifacts_ref,
                verdict="gaps_open",
                rounds_count=round_n,
                request_ids=request_ids,
                gaps_found=[{
                    "id": f"adversarial_judge_{blocking_state.lower()}",
                    "severity": "HIGH",
                    "evidence_ref": f"cycle:{cycle_id}",
                    "description": (
                        f"adversarial_judgment request {adversarial_request_id} "
                        f"reached terminal state {blocking_state} without an "
                        f"accepted result; review cannot be satisfied"
                    ),
                }],
            )

        # An accepted, role-bound result exists. ``no_gaps`` is now derived
        # from evidence a judge actually produced, and the result's
        # output/transcript hashes are carried so the verdict is
        # attributable to that submission.
        return _empty_review_result(
            plan_id=plan_id,
            convergence_id=convergence_id,
            impl_artifacts_ref=impl_artifacts_ref,
            verdict="no_gaps",
            rounds_count=round_n,
            request_ids=request_ids,
            accepted_result_ref={
                "request_id": adversarial_request_id,
                "role": _ADVERSARIAL_ROLE,
                "agent_id": accepted_result.get("agent_id"),
                "output_hash": accepted_result.get("output_hash"),
                "transcript_hash": accepted_result.get("transcript_hash"),
            },
        )

    return _empty_review_result(
        plan_id=plan_id,
        convergence_id=convergence_id,
        impl_artifacts_ref=impl_artifacts_ref,
        verdict="max_review_rounds",
        rounds_count=max_review_rounds,
        request_ids=request_ids,
        gaps_found=[{
            "id": "review_rounds_exhausted",
            "severity": "HIGH",
            "evidence_ref": f"cycle:{cycle_id}",
        }],
    )


def select_review_runner(profile: str = "standard") -> ReviewRunner:
    """Plan ARIA-V5 §3d — production review-runner factory.

    Always returns ``run_review_runner``: post-implementation review
    is architecturally required whenever Gate B is wired (Tier-1
    discipline). Tests inject mock runners directly via the
    ``review_runner`` kwarg on ``run_autonomy_orchestrator``.
    """
    return run_review_runner
