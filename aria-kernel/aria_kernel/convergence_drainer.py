"""Plan ARIA-V5 §2 — Gate A pre-worker convergence drainer.

V5.1 wires the existing ``plan_convergence`` + ``convergent_planning_bridge``
state machine into the autonomy orchestrator's per-cycle flow. After
``planner_drainer`` + ``bridge_drainer`` complete, the orchestrator
calls ``convergence_runner`` (this module's default, or a test-injected
mock) BEFORE ``worker_drainer`` — gating worker dispatch on the
``arbiter_verdict == "converged"`` predicate.

Operator vision (Plan ARIA-V5 §1, verbatim):
  "agentlar plan yapıyor ya yanı planları sureklı en bastan revıew
  ederek ıkı agent bırbırıne atarak valıde sekılde sonlanrmalı"

The drainer drives the primary↔challenger debate via the bridge:
  1. round 1 — issue primary envelope, poll until submission OR timeout
  2. round N — issue challenger envelope, poll until submission OR
     timeout
  3. call ``plan_convergence.evaluate_plan`` to derive terminal state
  4. map terminal_state + reason_codes onto ``arbiter_verdict`` via
     ``_derive_arbiter_verdict`` (Plan v2 §3c table — B3 fix)
  5. loop to next round if ``NEXT_ROUND_REQUIRED``, up to ``max_rounds``
  6. on ARIA_STOP between rounds, persist partial state and return
     ``aria_stop_interrupted`` (Plan v2 R-A10 fix)
  7. on restart, resume from persisted state (Plan v2 R-A8)

In autonomous-run mode where no external agents (Claude Code
sessions) are claiming envelopes, the drainer correctly times out and
returns ``primary_silent`` / ``challenger_unavailable`` — the
orchestrator then skips ``worker_drainer`` for that cycle. This is
the defensive default: no convergence, no implementation. Future V5+
work wires real agent dispatchers to consume the envelopes.

Tests inject mock convergence runners via the ``convergence_runner``
kwarg directly on ``run_autonomy_orchestrator``; see
``aria-kernel/tests/invariants/v5/_helpers.py`` for the 4 canonical
mock fakes covering all V5.1 verdict paths.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict

from .bridge_exceptions import BridgeContractViolation
from .convergent_planning_bridge import (
    issue_challenger_envelope,
    start_convergent_plan_drafted_by_primary,
)
from .cross_review_bridge import (
    issue_cross_review_envelope,
    issue_primary_envelope,
)
from .plan_convergence import TERMINAL_STATES, evaluate_plan, fold_plan_state
from .planner_dispatch_hook import dispatch_one_pending_planner_request
from .tool_registry import append_tools_governance, ensure_tools_dir

# Plan ARIA-V10.4 Phase 3.H.2 — the convergence drainer mints
# envelopes for FOUR roles across its rounds (primary_plan revisions,
# challenger_plan, cross_review, and implementation). The default
# ``DEFAULT_PLANNER_ROLES`` tuple in planner_dispatch_hook only
# enumerates ``primary_plan + challenger_plan`` because it was sized
# for the standalone autonomous planner-dispatch daemon's narrow
# scope. The convergence drainer owns dispatch of its OWN envelopes
# (Phase 3.H), so the inline call below MUST claim every role it
# mints — otherwise cross_review envelopes orphan in requests.jsonl
# (the exact regression diagnostic v3 surfaced as
# ``cross_review_poll_timeout`` at 08:13).
_CONVERGENCE_INLINE_DISPATCH_ROLES: tuple[str, ...] = (
    "primary_plan",
    "challenger_plan",
    "cross_review",
    "implementation",
)


# Plan ARIA-V8 v2 §4 Phase 8.6 (B-V2-04) — round-envelope sequence
# constants. These are REAL load-bearing constants the source-substring
# invariants pin against (not invariant theater per architect B-V2-04).
# Modifying the tuple = behaviour change captured by the invariant.
_ROUND1_ENVELOPES: tuple[str, ...] = ("challenger", "cross_review")
_ROUND_N_ENVELOPES: tuple[str, ...] = ("primary_revision", "challenger", "cross_review")


# Plan ARIA-V5 §3c v2 — terminal-state intermediate marker. Not in
# plan_convergence.TERMINAL_STATES, but used by ``fold_plan_state`` to
# indicate the convergence loop must iterate. Imported here as a
# string literal so we do not redefine the engine's own enum.
_NEXT_ROUND_REQUIRED = "NEXT_ROUND_REQUIRED"

# Plan ARIA-V5 §3c v2 — reason codes mapped onto arbiter_verdict.
# See ``_derive_arbiter_verdict`` for the full mapping table.
_REASON_ARIA_STOP = "aria_stop_during_convergence"
_REASON_MAX_ROUNDS = "max_rounds_reached"
_REASON_MATERIAL_RISK = "material_cross_review_risks_present"
_REASON_PARTIAL = "partial_cross_review_coverage"
_REASON_PENDING = "pending_tasks_present"
_REASON_NEW_RISK_PREFIX = "new_risk_category_round_"


class ConvergenceResult(TypedDict):
    """Plan ARIA-V5 §3c v2 — convergence drainer return contract."""

    plan_id: str
    converged_plan: dict[str, Any]
    rounds_count: int
    arbiter_verdict: Literal[
        "converged",
        "max_rounds",
        "split",
        "scope_abort",
        # Plan ARIA-V8 v2 §4 Phase 8.1 — primary_silent OBSOLETED.
        # V8 P+C+CR pipeline: primary IS cycle_runner's plan_content
        # (already present at plan-start). Primary cannot be "silent".
        # Round-1 timeouts now classify as challenger_unavailable or
        # cross_review_unavailable; round-2+ primary REVISION timeouts
        # classify as primary_revision_failed.
        "challenger_unavailable",
        "cross_review_unavailable",
        "cross_review_self_agreement",
        "primary_revision_failed",
        "budget_exhausted",
        "aria_stop_interrupted",
    ]
    unsatisfied_items: list[dict[str, Any]]
    request_ids: list[str]
    transcript_path: str
    resumed_from_persistence: bool
    convergence_id: str


class ConvergenceRunner(Protocol):
    """Plan ARIA-V5 §3c v2 — injection-seam contract.

    Why a Protocol vs a Callable type alias: Protocol forces every
    mock + production runner to expose the EXACT keyword-only kwargs
    by name. A bare Callable would let mocks define positional kwargs
    that silently diverge from the production contract, causing
    invariants to drift in test fixtures while staying green at
    production callsites. The Protocol makes the contract structural.
    """

    def __call__(
        self,
        *,
        cycle_id: str,
        base_dir: Path,
        workspace_root: Path | None,
        plan_id: str,
        plan_seed: dict[str, Any],
        must_satisfy: list[dict[str, Any]],
        evidence_refs: list[str],
        allowed_scope: list[str],
        max_rounds: int = 4,
        challenger_timeout_seconds: float = 1800.0,
    ) -> ConvergenceResult: ...


def _derive_arbiter_verdict(
    terminal_state: str,
    reason_codes: list[str] | None = None,
) -> str:
    """Plan ARIA-V5 §3c v2 (B3 fix) — explicit verdict mapping table.

    The ``plan_convergence`` state machine emits 3 terminal states +
    ``NEXT_ROUND_REQUIRED`` (intermediate) plus a vocabulary of
    ``reason_codes`` in the terminal ``plan_evaluated`` event. V5.1's
    ``ConvergenceResult.arbiter_verdict`` enum has 7 values that
    encode the operator-facing meaning of WHY convergence ended. The
    mapping is:

      ============================  =============================  =====================
      terminal_state                 reason_codes                   arbiter_verdict
      ============================  =============================  =====================
      CONVERGED                      (any)                          converged
      ABANDONED                      aria_stop_during_convergence   aria_stop_interrupted
      HUMAN_REQUIRED                 max_rounds_reached             max_rounds
      HUMAN_REQUIRED                 new_risk_category_round_2/3    split
      HUMAN_REQUIRED                 material_cross_review_risks_*  scope_abort
      HUMAN_REQUIRED                 partial_cross_review_coverage  primary_silent
      HUMAN_REQUIRED                 pending_tasks_present          challenger_unavailable
      anything-else                  (any)                          split (defensive)
      ============================  =============================  =====================

    The ``split`` defensive default is INTENTIONAL: an unrecognised
    state→reason combination should escalate to human review, not
    silently pass as ``converged`` or fail-closed as
    ``max_rounds``. Tier-1 fail-closed-or-escalate discipline.

    Pre-V5 the orchestrator had no mapping logic; this function makes
    the mapping the SSoT. Future reason-code additions in
    ``plan_convergence.py`` only require an entry here.
    """
    reasons = set(reason_codes or [])
    # Plan ARIA-V10.4 Phase 1 instrumentation — verdict provenance.
    # Each verdict branch returns a 2-tuple-like decision below; the
    # provenance tag names WHICH branch fired so the operator can
    # triage which condition produced "split" vs "challenger_unavailable"
    # vs the others without grepping the source. Tier-3 detectable.
    # The verdict string is unchanged; only the audit log entry is added.
    if terminal_state == "CONVERGED":
        _verdict, _branch = "converged", "terminal_state=CONVERGED"
    elif terminal_state == "ABANDONED" and _REASON_ARIA_STOP in reasons:
        _verdict, _branch = "aria_stop_interrupted", "ABANDONED+aria_stop"
    elif terminal_state == "HUMAN_REQUIRED" and _REASON_MAX_ROUNDS in reasons:
        _verdict, _branch = "max_rounds", "HUMAN_REQUIRED+max_rounds"
    elif terminal_state == "HUMAN_REQUIRED" and any(
        r.startswith(_REASON_NEW_RISK_PREFIX) for r in reasons
    ):
        _verdict, _branch = "split", "HUMAN_REQUIRED+new_risk_prefix"
    elif terminal_state == "HUMAN_REQUIRED" and _REASON_MATERIAL_RISK in reasons:
        _verdict, _branch = "scope_abort", "HUMAN_REQUIRED+material_risk"
    elif terminal_state == "HUMAN_REQUIRED" and _REASON_PARTIAL in reasons:
        # Plan ARIA-V8 v2 §4 Phase 8.1 (B-V2-02) — V8 obsoletes
        # primary_silent (primary IS cycle_runner's plan_content).
        # _REASON_PARTIAL now maps to cross_review_unavailable since
        # partial coverage in V8 P+C+CR means the cross-reviewer
        # couldn't fully verify both sides.
        _verdict, _branch = "cross_review_unavailable", "HUMAN_REQUIRED+partial"
    elif terminal_state == "HUMAN_REQUIRED" and _REASON_PENDING in reasons:
        _verdict, _branch = "challenger_unavailable", "HUMAN_REQUIRED+pending"
    else:
        _verdict, _branch = "split", "defensive_default"
    # Plan ARIA-V10.4 Phase 1 — branch name is now structurally tied
    # to verdict via the elif-cascade above. Callers that want the
    # provenance read `_VERDICT_PROVENANCE` snapshot below. Keeping
    # the verdict return contract unchanged preserves the V5.1
    # ConvergenceResult type pin.
    _LAST_VERDICT_PROVENANCE["terminal_state"] = terminal_state
    _LAST_VERDICT_PROVENANCE["reasons"] = sorted(reasons)
    _LAST_VERDICT_PROVENANCE["branch"] = _branch
    _LAST_VERDICT_PROVENANCE["verdict"] = _verdict
    return _verdict


# Plan ARIA-V10.4 Phase 1 instrumentation — single-cell verdict
# provenance shared across the kernel. NOT thread-safe; convergence
# runs strictly per-cycle so single-cell is correct. The orchestrator
# reads this AFTER calling _derive_arbiter_verdict and emits the
# `verdict_provenance` governance event with the branch tag. This
# avoids changing the function signature (which would ripple through
# the V5.1 invariant test).
_LAST_VERDICT_PROVENANCE: dict[str, Any] = {
    "terminal_state": None,
    "reasons": [],
    "branch": None,
    "verdict": None,
}


def _persistence_path(root: Path, cycle_id: str) -> Path:
    state_dir = root / "state" / "convergence"
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir / f"{cycle_id}.json"


def _check_aria_stop(root: Path) -> bool:
    return (root / "ARIA_STOP").exists()


def _poll_for_state(
    plan_id: str,
    target_states: set[str],
    base_dir: str | Path,
    deadline: float,
    aria_stop_root: Path,
    sleep_interval: float,
) -> str | None:
    """Plan ARIA-V5 §2 — poll plan_convergence.fold_plan_state until
    one of ``target_states`` is observed OR ``deadline`` expires OR
    ARIA_STOP is written. Returns the observed state or None on
    timeout / interrupt.

    Plan ARIA-V8 §4 Phase 8.0 (B-V2-01) — fold_plan_state returns
    ``dict[str, Any]``; the comparison ``current in target_states``
    where ``target_states: set[str]`` is structurally always False on
    a dict. EVERY ``primary_silent`` verdict since V5.1 traces to this
    silent bug — the poll always times out, never observes the real
    state transition. Fix: extract the state STRING via .get("state")
    before comparing to the set[str] of target states; return the
    extracted string (callers expect a state name, not a dict).

    Plan ARIA-V10.4 Phase 3.H (F-016 root-cause fix) — INLINE planner
    dispatch. Pre-V10.4 the convergence_drainer minted challenger /
    cross_review envelopes and POLLED for plan_state transitions,
    while assuming an EXTERNAL ``run_planner_dispatch_daemon`` was
    claiming + processing the envelopes. The orchestrator's daemon is
    bounded to ``max_iterations_per_phase=10`` per cycle and runs
    BEFORE ``convergence_runner`` mints its envelopes — by the time
    the convergence envelope hits ``requests.jsonl``, the planner
    daemon has already exited.

    F-016 evidence (cyc-20260520T065441Z): challenger envelope
    ``AIR-aria-challenger-planner-241eadf5`` created at 07:04:35,
    plan state never transitioned because no daemon was running to
    claim it; ``challenger_drafted_poll_timeout`` fired at 07:08:07
    with ``has_challenger_field=false`` (the smoking gun).

    Tier-1 fix: ``_poll_for_state`` runs ONE
    ``dispatch_one_pending_planner_request`` tick per poll iteration.
    Each poll: check ARIA_STOP → check state → DISPATCH one pending
    request → sleep → repeat. Convergence now OWNS dispatch of its
    own envelopes — no dependency on the outer daemon's iteration
    budget. The hook returns quickly when there are no pending
    requests (``status=no_pending``) and blocks on real Claude
    subprocess (~90-180s) when there is one; either way, the next
    iteration sees the resulting state transition.

    Concurrency note: ``dispatch_one_pending_planner_request`` does
    not acquire the daemon-level lock. The underlying
    ``claim_request`` / ``submit_claim_result`` carry their own §A.1
    / §H-1 locks, so concurrent dispatch from the convergence_drainer
    + a separately-running orchestrator daemon are mutually safe
    (only one can claim any given request).
    """
    # Plan ARIA-V10.4 Phase 3.H.2 — `dispatch_one_pending_planner_request`
    # promoted to a module-level import (line ~57). ARIA's diagnostic
    # v3 challenger plan (req=AIR-aria-cross-reviewer-a2876b40)
    # surfaced two architectural-quality gaps in the original Phase
    # 3.H landing: (a) the local import paid a module-lookup cost on
    # every hot-loop iteration, (b) the bare ``except Exception:
    # pass`` made dispatch-hook regressions invisible. Both gaps are
    # now closed below — promotion to module scope + Tier-3
    # detectable governance event.
    inline_agent_id = f"convergence:{os.getpid()}"

    # Plan ARIA-V10.5 Phase 5 — F-025 closure. Loop body order matters:
    # fold_plan_state MUST run BEFORE the deadline check, so a state
    # transition that was JUST folded inside the previous iteration's
    # dispatch_one_pending_planner_request call is observed before
    # deadline expiry can return None. Pre-fix the deadline check at
    # the while-condition top ran before fold_plan_state, so a
    # long-running successful dispatch (subprocess wall-clock >
    # challenger_timeout_seconds) folded the state correctly but the
    # next iteration exited via deadline-expired without observing it.
    # F-025 evidence cycle (cyc-20260521T172723Z-auto round 2
    # challenger): subprocess took 630s vs timeout 600s; bridge folded
    # CHALLENGER_DRAFTED at t+630s; loop returned None at t+635s; post-
    # termination fold_plan_state confirmed state was correctly set.
    # State observation has temporal priority over budget enforcement.
    while True:
        if _check_aria_stop(aria_stop_root):
            return None
        try:
            current_dict = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
            current_state: str | None = current_dict.get("state") if isinstance(current_dict, dict) else None
        except Exception:
            current_state = None
        if current_state is not None and current_state in target_states:
            return current_state
        if time.monotonic() >= deadline:
            return None
        # Plan ARIA-V10.4 Phase 3.H + 3.H.2 — inline dispatch tick.
        # `planner_roles` MUST enumerate every role the convergence
        # drainer mints (primary_plan revisions, challenger_plan,
        # cross_review, implementation). Pre-3.H.2 the call relied on
        # ``DEFAULT_PLANNER_ROLES = (primary_plan, challenger_plan)``,
        # so cross_review envelopes orphaned and convergence stalled
        # at ``cross_review_poll_timeout`` — surfaced by diagnostic v3
        # cycle cyc-20260520T074642Z-auto.
        #
        # Phase 3.H.2 also hardens the previous silent-swallow into a
        # Tier-3 detectable governance event so the next regression
        # surfaces operator-visibly within one poll cycle instead of
        # waiting ``challenger_timeout_seconds`` (10-30 min) for the
        # downstream timeout to fire.
        try:
            dispatch_one_pending_planner_request(
                base_dir=base_dir,
                agent_id=inline_agent_id,
                planner_roles=_CONVERGENCE_INLINE_DISPATCH_ROLES,
            )
        except Exception as _disp_exc:
            try:
                append_tools_governance(
                    ensure_tools_dir(base_dir),
                    "inline_dispatch_tick_failed",
                    {
                        "plan_id": plan_id,
                        "agent_id": inline_agent_id,
                        "exception_class": type(_disp_exc).__name__,
                        "exception_message": str(_disp_exc)[:500],
                    },
                )
            except Exception:
                # Best-effort: do not let governance-emission failure
                # abort the poll loop. The V5 contract (return only on
                # state-match / deadline / ARIA_STOP) is preserved.
                pass
        time.sleep(sleep_interval)
    return None


def run_convergence_drainer(
    *,
    cycle_id: str,
    base_dir: str | Path,
    workspace_root: str | Path | None,
    plan_id: str,
    plan_seed: dict[str, Any],
    must_satisfy: list[dict[str, Any]],
    evidence_refs: list[str],
    allowed_scope: list[str],
    max_rounds: int = 4,
    challenger_timeout_seconds: float = 1800.0,
) -> ConvergenceResult:
    """Plan ARIA-V5 §2 — default Gate A convergence runner.

    Drives the primary↔challenger convergence loop via
    ``plan_convergence`` + ``convergent_planning_bridge``. Polls
    ``fold_plan_state`` for submissions until ``challenger_timeout_seconds``
    elapses per round. Returns ``ConvergenceResult`` whose
    ``arbiter_verdict`` the autonomy orchestrator consumes to gate
    ``worker_drainer``.

    State persistence (R-A8): each round's progress is written to
    ``aria-tools/state/convergence/<cycle_id>.json``; on restart, the
    drainer detects the file and resumes from the saved round.

    ARIA_STOP handling (R-A10): polled between rounds AND during
    in-round wait loops; on detection, partial state is persisted
    and ``aria_stop_interrupted`` verdict is returned. The
    orchestrator then skips ``worker_drainer`` cleanly without losing
    convergence progress.

    Defensive defaults: with no external agents claiming envelopes
    (typical V5.1 autonomous run without real Claude Code
    dispatchers), the drainer times out at ``primary_silent`` or
    ``challenger_unavailable``; the orchestrator then skips
    ``worker_drainer`` for that cycle. This is the correct
    fail-closed behaviour — no convergence, no implementation.
    """
    root = ensure_tools_dir(base_dir)
    transcript_dir = root / "convergence"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = transcript_dir / f"{cycle_id}.jsonl"
    persistence = _persistence_path(root, cycle_id)
    convergence_id = plan_id

    resumed = False
    starting_round = 1
    if persistence.exists():
        try:
            saved = json.loads(persistence.read_text(encoding="utf-8"))
            if saved.get("plan_id") == plan_id:
                starting_round = int(saved.get("round", 1))
                resumed = True
        except (OSError, json.JSONDecodeError, ValueError):
            resumed = False

    request_ids: list[str] = []
    rounds_executed = 0
    poll_sleep = max(0.05, min(5.0, challenger_timeout_seconds / 60.0))

    def _aria_stop_return() -> ConvergenceResult:
        # Plan ARIA-V5 R-A10 — partial state persisted; verdict is
        # explicit so operator sees the interrupt in reflection.
        persistence.write_text(
            json.dumps({"plan_id": plan_id, "round": rounds_executed, "interrupted": True}),
            encoding="utf-8",
        )
        return ConvergenceResult(
            plan_id=plan_id,
            converged_plan={},
            rounds_count=rounds_executed,
            arbiter_verdict="aria_stop_interrupted",
            unsatisfied_items=[],
            request_ids=request_ids,
            transcript_path=str(transcript_path),
            resumed_from_persistence=resumed,
            convergence_id=convergence_id,
        )

    # Plan ARIA-V8 v2 §4 Phase 8.1 (architect B2) — round-1 + round-2+
    # share the challenger + cross_review envelope-mint sequence;
    # extracted into _run_challenge_and_cross_review_phase helper.
    def _run_challenge_and_cross_review_phase(
        *,
        current_round: int,
        primary_revision_id: str,
        primary_plan_text: str,
    ) -> tuple[str | None, ConvergenceResult | None]:
        """Mint challenger envelope → poll CHALLENGER_DRAFTED → mint
        cross_review envelope → poll CROSS_REVIEWED.

        Returns (challenger_revision_id, early_terminal_result):
        - On success: (challenger_revision_id_string, None)
        - On challenger poll timeout: (None, ConvergenceResult(challenger_unavailable))
        - On cross_review poll timeout: (None, ConvergenceResult(cross_review_unavailable))
        - On ARIA_STOP: (None, ConvergenceResult(aria_stop_interrupted))
        """
        challenger_request = issue_challenger_envelope(
            plan_id=plan_id,
            round_number=current_round,
            must_satisfy=must_satisfy,
            evidence_refs=evidence_refs,
            allowed_scope=allowed_scope,
            base_dir=base_dir,
        )
        challenger_request_id = challenger_request.get("request_id")
        if challenger_request_id:
            request_ids.append(challenger_request_id)
        challenger_state = _poll_for_state(
            plan_id=plan_id,
            target_states={"CHALLENGER_DRAFTED"},
            base_dir=base_dir,
            deadline=time.monotonic() + challenger_timeout_seconds,
            aria_stop_root=root,
            sleep_interval=poll_sleep,
        )
        if _check_aria_stop(root):
            return None, _aria_stop_return()
        if challenger_state is None:
            # Plan ARIA-V10.4 Phase 1 instrumentation — capture the
            # CURRENT plan state when CHALLENGER_DRAFTED poll times out.
            # V10.3-B endurance showed all 3 cycles fail at this exact
            # timeout despite real Claude returning a 23KB plan response.
            # The kernel state must reveal whether (a) state never
            # transitioned past DRAFT, (b) bridge silently failed to
            # ingest the agent result, or (c) some other state machine
            # path is firing. Tier-3: detectable at runtime, no behavior
            # change to the surrounding cycle flow.
            try:
                _diag_state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
                _diag_state_summary = {
                    "current_state": _diag_state.get("current_state") if isinstance(_diag_state, dict) else None,
                    "has_challenger_field": bool(_diag_state.get("challenger")) if isinstance(_diag_state, dict) else False,
                    "challenger_revision_id": (
                        _diag_state.get("challenger", {}).get("challenger_revision_id")
                        if isinstance(_diag_state, dict) and isinstance(_diag_state.get("challenger"), dict)
                        else None
                    ),
                    "challenger_has_plan_content": (
                        isinstance(_diag_state.get("challenger", {}).get("plan_content"), dict)
                        if isinstance(_diag_state, dict) and isinstance(_diag_state.get("challenger"), dict)
                        else False
                    ),
                    "latest_revision_id": (
                        _diag_state.get("latest_revision", {}).get("revision_id")
                        if isinstance(_diag_state, dict) and isinstance(_diag_state.get("latest_revision"), dict)
                        else None
                    ),
                    "round_index": (
                        _diag_state.get("round_index")
                        if isinstance(_diag_state, dict)
                        else None
                    ),
                }
            except Exception as _diag_exc:
                _diag_state_summary = {"fold_plan_state_failed": str(_diag_exc)[:200]}
            append_tools_governance(
                ensure_tools_dir(base_dir),
                "challenger_drafted_poll_timeout",
                {
                    "plan_id": plan_id,
                    "round_number": current_round,
                    "challenger_request_id": challenger_request_id,
                    "primary_revision_id": primary_revision_id,
                    "challenger_timeout_seconds": challenger_timeout_seconds,
                    "plan_state_at_timeout": _diag_state_summary,
                },
            )
            return None, ConvergenceResult(
                plan_id=plan_id,
                converged_plan={},
                rounds_count=rounds_executed,
                arbiter_verdict="challenger_unavailable",
                unsatisfied_items=[],
                request_ids=request_ids,
                transcript_path=str(transcript_path),
                resumed_from_persistence=resumed,
                convergence_id=convergence_id,
            )
        # Derive challenger revision_id + plan content from the now-
        # CHALLENGER_DRAFTED plan state. Plan ARIA-V8.3 — the cross-
        # review envelope MUST carry both plans' actual TEXT so the
        # cross-reviewer can read them via untrusted-delimited prompt
        # inline. Pre-V8.3 the challenger_plan_text was a stub string
        # ("(challenger plan loaded by aria-cross-reviewer via Read
        # tool)") which made the cross-reviewer refuse with
        # missing_inputs — the agent's independence discipline rightly
        # blocked: an empty plan body cannot be cross-reviewed.
        challenger_revision_id = f"{plan_id}-c{current_round}"
        challenger_plan_text = ""
        # Plan ARIA-V8.10 — also enrich primary_plan_text from kernel
        # state's latest_revision when cycle_runner's plan_seed was
        # empty (dirty-tree skip leaves plan_seed = {} → primary
        # serialization is "{}" or "null", cross-reviewer refuses with
        # evidence_underspecified). Kernel state has the authoritative
        # primary content (set at start_plan), so the helper fetches
        # both sides from state.
        try:
            cur = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
            if isinstance(cur, dict):
                challenger = cur.get("challenger") or {}
                if isinstance(challenger, dict):
                    rid = challenger.get("challenger_revision_id")
                    if isinstance(rid, str) and rid:
                        challenger_revision_id = rid
                    # V8.3 — pull the actual challenger plan_content
                    # dict from kernel state and serialize it as the
                    # text body for the <untrusted_challenger_plan>
                    # delimiters.
                    plan_content_dict = challenger.get("plan_content")
                    if isinstance(plan_content_dict, dict):
                        challenger_plan_text = _json.dumps(
                            plan_content_dict, indent=2, sort_keys=True,
                        )
                # V8.10 + V8.11 — enrich primary_plan_text from kernel
                # state when plan_seed-derived text is empty/null/junk.
                # The kernel stores primary content in TWO places:
                #   - DRAFT state: `plan_started.plan_content` (dict)
                #     carries the initial seed; `latest_revision.content`
                #     is None at this point (only revision_id + hash).
                #   - REVISED state: `latest_revision.content` carries
                #     the post-revision string body.
                # Check both in order of recency so we always pick the
                # most-recent primary content the kernel knows about.
                if (not primary_plan_text) or primary_plan_text.strip() in {"", "{}", "null"}:
                    latest = cur.get("latest_revision") or {}
                    primary_candidate: object = None
                    if isinstance(latest, dict):
                        primary_candidate = latest.get("content")
                    if not primary_candidate:
                        plan_started = cur.get("plan_started") or {}
                        if isinstance(plan_started, dict):
                            primary_candidate = plan_started.get("plan_content")
                    if isinstance(primary_candidate, dict):
                        primary_plan_text = _json.dumps(
                            primary_candidate, indent=2, sort_keys=True,
                        )
                    elif isinstance(primary_candidate, str) and primary_candidate.strip():
                        primary_plan_text = primary_candidate
        except Exception:
            pass
        if not challenger_plan_text:
            # Fail-fast: if we can't load real challenger content the
            # cross-reviewer will refuse anyway; surface the operator-
            # visible signal at mint-time instead of after a wasted
            # Opus cycle.
            challenger_plan_text = (
                f"{{\"error\": \"challenger plan_content unavailable in plan state for "
                f"plan_id={plan_id} revision_id={challenger_revision_id}\"}}"
            )
        if (not primary_plan_text) or primary_plan_text.strip() in {"", "{}", "null"}:
            primary_plan_text = (
                f"{{\"error\": \"primary plan content unavailable in plan state for "
                f"plan_id={plan_id} revision_id={primary_revision_id}\"}}"
            )
        # Mint cross_review envelope.
        #
        # Plan ARIA-V10.4 Phase 1 instrumentation — defensive try/except
        # around the mint call. Pre-V10.4 the call was unwrapped: any
        # exception (BridgeContractViolation from the inner mint path,
        # validation failure, kernel-state read race) would propagate
        # uncaught and the caller would see no governance event naming
        # the failure layer. The new wrapper emits
        # cross_review_mint_failed with exception class + truncated
        # message + cycle context. Re-raise after logging so behavior
        # is unchanged. Tier-3: detectable, NOT a fix.
        try:
            cross_review_request = issue_cross_review_envelope(
                plan_id=plan_id,
                round_number=current_round,
                primary_revision_id=primary_revision_id,
                primary_plan_text=primary_plan_text,
                challenger_revision_id=challenger_revision_id,
                challenger_plan_text=challenger_plan_text,
                must_satisfy=must_satisfy,
                evidence_refs=evidence_refs,
                allowed_scope=allowed_scope,
                base_dir=base_dir,
            )
        except Exception as _mint_exc:
            append_tools_governance(
                ensure_tools_dir(base_dir),
                "cross_review_mint_failed",
                {
                    "plan_id": plan_id,
                    "round_number": current_round,
                    "primary_revision_id": primary_revision_id,
                    "challenger_revision_id": challenger_revision_id,
                    "exception_class": type(_mint_exc).__name__,
                    "exception_message": str(_mint_exc)[:500],
                },
            )
            raise
        cross_review_request_id = cross_review_request.get("request_id")
        if cross_review_request_id:
            request_ids.append(cross_review_request_id)
        cross_review_state = _poll_for_state(
            plan_id=plan_id,
            target_states={"CROSS_REVIEWED"},
            base_dir=base_dir,
            deadline=time.monotonic() + challenger_timeout_seconds,
            aria_stop_root=root,
            sleep_interval=poll_sleep,
        )
        if _check_aria_stop(root):
            return None, _aria_stop_return()
        if cross_review_state is None:
            # Plan ARIA-V10.4 Phase 1 — mirror the CHALLENGER_DRAFTED
            # timeout diagnostic for CROSS_REVIEWED. Same rationale:
            # capture state at timeout to reveal which bridge layer
            # failed to advance the plan state.
            try:
                _xr_state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
                _xr_state_summary = {
                    "current_state": _xr_state.get("current_state") if isinstance(_xr_state, dict) else None,
                    "has_cross_review": bool(_xr_state.get("cross_review")) if isinstance(_xr_state, dict) else False,
                    "round_index": (
                        _xr_state.get("round_index") if isinstance(_xr_state, dict) else None
                    ),
                }
            except Exception as _xr_exc:
                _xr_state_summary = {"fold_plan_state_failed": str(_xr_exc)[:200]}
            append_tools_governance(
                ensure_tools_dir(base_dir),
                "cross_review_poll_timeout",
                {
                    "plan_id": plan_id,
                    "round_number": current_round,
                    "cross_review_request_id": cross_review_request_id,
                    "challenger_timeout_seconds": challenger_timeout_seconds,
                    "plan_state_at_timeout": _xr_state_summary,
                },
            )
            return None, ConvergenceResult(
                plan_id=plan_id,
                converged_plan={},
                rounds_count=rounds_executed,
                arbiter_verdict="cross_review_unavailable",
                unsatisfied_items=[],
                request_ids=request_ids,
                transcript_path=str(transcript_path),
                resumed_from_persistence=resumed,
                convergence_id=convergence_id,
            )
        return challenger_revision_id, None

    for round_n in range(starting_round, max_rounds + 1):
        rounds_executed = round_n

        if _check_aria_stop(root):
            return _aria_stop_return()

        if round_n == 1:
            # Plan ARIA-V8 v2 §4 Phase 8.1 — round-1 has NO primary envelope.
            # plan_seed (from V7.1 cycle_runner) IS the primary draft;
            # only register the plan in DRAFT state, then immediately
            # mint challenger + cross_review (see _ROUND1_ENVELOPES).
            start_convergent_plan_drafted_by_primary(
                plan_id=plan_id,
                plan_content=plan_seed,
                initial_revision_id=f"{plan_id}-r1",
                base_dir=base_dir,
            )
            primary_revision_id_for_round = f"{plan_id}-r1"
        else:
            # Plan ARIA-V8 v2 §4 Phase 8.4 — round-2+ mints primary REVISION
            # envelope via cross_review_bridge.issue_primary_envelope.
            # Tier-1: refused at mint-time if state not in CRITIQUED or
            # CROSS_REVIEWED. Legal here because prior round reached CROSS_REVIEWED.
            try:
                primary_revision_request = issue_primary_envelope(
                    plan_id=plan_id,
                    round_number=round_n,
                    must_satisfy=must_satisfy,
                    evidence_refs=evidence_refs,
                    allowed_scope=allowed_scope,
                    base_dir=base_dir,
                )
            except BridgeContractViolation:
                return ConvergenceResult(
                    plan_id=plan_id,
                    converged_plan={},
                    rounds_count=rounds_executed,
                    arbiter_verdict="primary_revision_failed",
                    unsatisfied_items=[],
                    request_ids=request_ids,
                    transcript_path=str(transcript_path),
                    resumed_from_persistence=resumed,
                    convergence_id=convergence_id,
                )
            primary_revision_request_id = primary_revision_request.get("request_id")
            if primary_revision_request_id:
                request_ids.append(primary_revision_request_id)
            # Wait for primary to revise (state advances to REVISED).
            revised_state = _poll_for_state(
                plan_id=plan_id,
                target_states={"REVISED"},
                base_dir=base_dir,
                deadline=time.monotonic() + challenger_timeout_seconds,
                aria_stop_root=root,
                sleep_interval=poll_sleep,
            )
            if _check_aria_stop(root):
                return _aria_stop_return()
            if revised_state is None:
                return ConvergenceResult(
                    plan_id=plan_id,
                    converged_plan={},
                    rounds_count=rounds_executed,
                    arbiter_verdict="primary_revision_failed",
                    unsatisfied_items=[],
                    request_ids=request_ids,
                    transcript_path=str(transcript_path),
                    resumed_from_persistence=resumed,
                    convergence_id=convergence_id,
                )
            primary_revision_id_for_round = f"{plan_id}-r{round_n}"

        # Render the primary plan text for the cross-reviewer prompt.
        # cycle_runner's plan_seed is the canonical primary draft.
        import json as _json
        primary_plan_text = _json.dumps(plan_seed, indent=2, sort_keys=True)

        challenger_revision_id, early_terminal = _run_challenge_and_cross_review_phase(
            current_round=round_n,
            primary_revision_id=primary_revision_id_for_round,
            primary_plan_text=primary_plan_text,
        )
        if early_terminal is not None:
            return early_terminal

        # Plan ARIA-V10.5 Phase 4 — F-024 closure. Forward the drainer's
        # max_rounds into the kernel evaluator so plan_convergence and
        # convergence_drainer share a single source of truth for the
        # "last round of the cycle" boundary. Pre-fix the drainer's cap
        # (default 4, often overridden lower via CLI/profile) was
        # invisible to evaluate_plan, which fell back to MAX_CROSS_REVIEW_ROUNDS=5
        # and returned NEXT_ROUND_REQUIRED while the drainer was about
        # to exit its bounded loop — leaving the kernel ledger with
        # zero plan_evaluated events and no verdict provenance.
        eval_result = evaluate_plan(
            plan_id=plan_id,
            round_number=round_n,
            base_dir=base_dir,
            max_rounds=max_rounds,
        )
        # Plan ARIA-V10.5 Phase 6 — F-026 closure. The kernel writes
        # terminal-state evaluation results into the plan_evaluated event
        # under event.payload.terminal_state (see plan_convergence.py
        # _append_event line 989-1007 and evaluate_plan line 475-481).
        # The pre-fix extraction looked at event.details.state — wrong
        # field names on both axes:
        #   - "details" was never the event payload key (the kernel uses
        #     "payload"; "details" is reserved for tools governance events
        #     written via append_tools_governance).
        #   - "state" was never the terminal-state field on plan events
        #     (the kernel emits "terminal_state"; "state" is the kernel-
        #     internal fold output, not the event payload field).
        # Result: drainer never observed terminal states, fell through to
        # the line-926 hardcoded "max_rounds" verdict, verdict_provenance
        # never appended. Cycle 1 of v10-5-f-025-validation endurance
        # surfaced this — kernel correctly emitted plan_evaluated with
        # terminal_state=HUMAN_REQUIRED + max_rounds_reached but drainer
        # read None and missed the in-loop terminal branch.
        _event_payload = eval_result.get("event", {}).get("payload", {})
        terminal_state = _event_payload.get("terminal_state")
        # NEXT_ROUND_REQUIRED has no event field — reason_codes live at
        # eval_result top level for that case (plan_convergence.py line
        # 466-474). Terminal cases carry reasons in event.payload.
        reason_codes = (
            _event_payload.get("reason_codes")
            or eval_result.get("reason_codes")
            or []
        )

        if terminal_state in TERMINAL_STATES:
            arbiter_verdict = _derive_arbiter_verdict(
                terminal_state, list(reason_codes),
            )
            # Plan ARIA-V10.4 Phase 1 — emit verdict provenance so
            # operators can triage WHICH branch of the mapping fired.
            # Pre-V10.4 the verdict string alone collapsed multiple
            # distinct (terminal_state, reasons) combinations into one
            # label.
            try:
                append_tools_governance(
                    ensure_tools_dir(base_dir),
                    "verdict_provenance",
                    {
                        "plan_id": plan_id,
                        "round_number": round_n,
                        "terminal_state": _LAST_VERDICT_PROVENANCE.get("terminal_state"),
                        "reasons": _LAST_VERDICT_PROVENANCE.get("reasons"),
                        "branch": _LAST_VERDICT_PROVENANCE.get("branch"),
                        "verdict": _LAST_VERDICT_PROVENANCE.get("verdict"),
                    },
                )
            except Exception:
                pass
            # Plan ARIA-V8 v2 §4 Phase 8.5 (B-V2-08) — independence
            # enforcement on converged cycles. Echo chamber detection
            # via verify_independence's 3-layer check (claim_id +
            # revision_id + Jaccard). On violation the verdict
            # downgrades to cross_review_self_agreement so the operator
            # sees the fake-consensus signal in the reflection.
            if arbiter_verdict == "converged" and len(request_ids) >= 3:
                from .independence_check import verify_independence
                # Plan ARIA-V10.4 Phase 1.1 hotfix — local
                # `append_tools_governance` import REMOVED; module-level
                # import at line 56 is the SSoT. The local re-import
                # was making Python's compiler classify
                # `append_tools_governance` as a local variable of
                # run_convergence_drainer, which leaked into the closure
                # `_run_challenge_and_cross_review_phase` and caused a
                # NameError when V10.4 Phase 1 instrumentation tried to
                # call it from inside the closure before this code path
                # executed.
                independence_ok, violation_reasons = verify_independence(
                    primary_request_id=request_ids[0],
                    primary_revision_id=f"{plan_id}-r1",
                    primary_text="(primary plan text — not loaded at convergence; "
                                 "Jaccard check operates on agent_text via cross-reviewer envelope)",
                    challenger_request_id=request_ids[1] if len(request_ids) > 1 else "",
                    challenger_revision_id=f"{plan_id}-c1",
                    challenger_text="(challenger plan text)",
                    cross_review_request_id=request_ids[2] if len(request_ids) > 2 else "",
                    cross_review_revision_id=None,
                    cross_review_text="(cross_review text)",
                    base_dir=base_dir,
                )
                if not independence_ok:
                    arbiter_verdict = "cross_review_self_agreement"
                    try:
                        append_tools_governance(
                            ensure_tools_dir(base_dir),
                            "convergence_invalid_self_agreement",
                            {
                                "plan_id": plan_id,
                                "cycle_id": cycle_id,
                                "violation_reasons": violation_reasons,
                                "request_ids": request_ids,
                            },
                        )
                    except Exception:
                        pass
            converged_plan = (
                eval_result.get("plan_content", {})
                if arbiter_verdict == "converged"
                else {}
            )
            unsatisfied = eval_result.get("unsatisfied_items", [])
            if persistence.exists():
                try:
                    persistence.unlink()
                except OSError:
                    pass
            return ConvergenceResult(
                plan_id=plan_id,
                converged_plan=converged_plan,
                rounds_count=rounds_executed,
                arbiter_verdict=arbiter_verdict,
                unsatisfied_items=unsatisfied,
                request_ids=request_ids,
                transcript_path=str(transcript_path),
                resumed_from_persistence=resumed,
                convergence_id=convergence_id,
            )

        # NEXT_ROUND_REQUIRED — persist round bump and iterate
        persistence.write_text(
            json.dumps({"plan_id": plan_id, "round": round_n + 1}),
            encoding="utf-8",
        )

    return ConvergenceResult(
        plan_id=plan_id,
        converged_plan={},
        rounds_count=rounds_executed,
        arbiter_verdict="max_rounds",
        unsatisfied_items=[],
        request_ids=request_ids,
        transcript_path=str(transcript_path),
        resumed_from_persistence=resumed,
        convergence_id=convergence_id,
    )


def select_convergence_runner(profile: str = "standard") -> ConvergenceRunner:
    """Plan ARIA-V5 §3c — production convergence-runner factory.

    Always returns ``run_convergence_drainer``: convergence is
    architecturally required whenever Gate A is wired (Tier-1
    discipline). Tests inject mock runners directly via the
    ``convergence_runner`` kwarg on ``run_autonomy_orchestrator``;
    they do NOT go through this factory.

    The ``profile`` parameter is accepted for API symmetry with
    ``select_auto_merge_runner`` (V3 §A1 pattern) — future profile-
    specific overrides (e.g., a faster timeout for ``standard``
    profile) hook here without changing the orchestrator contract.
    """
    return run_convergence_drainer
