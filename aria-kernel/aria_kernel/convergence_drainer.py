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

In autonomous-run mode where no external agents (Codex / Claude Code
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
import time
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict

from .convergent_planning_bridge import (
    issue_challenger_envelope,
    start_convergent_plan_with_envelope,
)
from .plan_convergence import TERMINAL_STATES, evaluate_plan, fold_plan_state
from .tool_registry import ensure_tools_dir


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
        "primary_silent",
        "challenger_unavailable",
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
    if terminal_state == "CONVERGED":
        return "converged"
    if terminal_state == "ABANDONED" and _REASON_ARIA_STOP in reasons:
        return "aria_stop_interrupted"
    if terminal_state == "HUMAN_REQUIRED":
        if _REASON_MAX_ROUNDS in reasons:
            return "max_rounds"
        if any(r.startswith(_REASON_NEW_RISK_PREFIX) for r in reasons):
            return "split"
        if _REASON_MATERIAL_RISK in reasons:
            return "scope_abort"
        if _REASON_PARTIAL in reasons:
            return "primary_silent"
        if _REASON_PENDING in reasons:
            return "challenger_unavailable"
    return "split"


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
    """
    while time.monotonic() < deadline:
        if _check_aria_stop(aria_stop_root):
            return None
        try:
            current_dict = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
            current_state: str | None = current_dict.get("state") if isinstance(current_dict, dict) else None
        except Exception:
            current_state = None
        if current_state is not None and current_state in target_states:
            return current_state
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
    (typical V5.1 autonomous run without real Codex/Claude Code
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

    for round_n in range(starting_round, max_rounds + 1):
        rounds_executed = round_n

        if _check_aria_stop(root):
            return _aria_stop_return()

        if round_n == 1:
            primary_record = start_convergent_plan_with_envelope(
                plan_id=plan_id,
                plan_content=plan_seed,
                initial_revision_id=f"{plan_id}-r1",
                must_satisfy=must_satisfy,
                evidence_refs=evidence_refs,
                allowed_scope=allowed_scope,
                base_dir=base_dir,
            )
            primary_request_id = (
                primary_record.get("primary_request", {}).get("request_id")
            )
            if primary_request_id:
                request_ids.append(primary_request_id)

        primary_state = _poll_for_state(
            plan_id=plan_id,
            target_states={
                "CHALLENGER_DRAFTED", "CROSS_REVIEWED", "REVISED",
            },
            base_dir=base_dir,
            deadline=time.monotonic() + challenger_timeout_seconds,
            aria_stop_root=root,
            sleep_interval=poll_sleep,
        )
        if _check_aria_stop(root):
            return _aria_stop_return()
        if primary_state is None:
            return ConvergenceResult(
                plan_id=plan_id,
                converged_plan={},
                rounds_count=rounds_executed,
                arbiter_verdict="primary_silent",
                unsatisfied_items=[],
                request_ids=request_ids,
                transcript_path=str(transcript_path),
                resumed_from_persistence=resumed,
                convergence_id=convergence_id,
            )

        challenger_request = issue_challenger_envelope(
            plan_id=plan_id,
            round_number=round_n,
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
            target_states={"CROSS_REVIEWED"},
            base_dir=base_dir,
            deadline=time.monotonic() + challenger_timeout_seconds,
            aria_stop_root=root,
            sleep_interval=poll_sleep,
        )
        if _check_aria_stop(root):
            return _aria_stop_return()
        if challenger_state is None:
            return ConvergenceResult(
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

        eval_result = evaluate_plan(
            plan_id=plan_id,
            round_number=round_n,
            base_dir=base_dir,
        )
        terminal_state = (
            eval_result.get("state")
            or eval_result.get("event", {}).get("details", {}).get("state")
        )
        reason_codes = (
            eval_result.get("reason_codes")
            or eval_result.get("event", {}).get("details", {}).get("reason_codes")
            or []
        )

        if terminal_state in TERMINAL_STATES:
            arbiter_verdict = _derive_arbiter_verdict(
                terminal_state, list(reason_codes),
            )
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
