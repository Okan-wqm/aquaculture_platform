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

import re
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict

from .agent_invocations import accepted_result_for_request
from .bridge_exceptions import BridgeContractViolation
from .convergent_planning_bridge import (
    issue_challenger_envelope,
    start_convergent_plan_drafted_by_primary,
)
from .cross_review_bridge import (
    CROSS_REVIEW_ROLE as CROSS_REVIEW_TARGET_AND_ROLE,
    issue_completeness_critic_envelope,
    issue_cross_review_envelope,
    issue_primary_envelope,
)
from .independence_check import (
    CHALLENGER_ROLE as IND_CHALLENGER_ROLE,
    CROSS_REVIEW_ROLE as IND_CROSS_REVIEW_ROLE,
    PRIMARY_ROLE as IND_PRIMARY_ROLE,
    IndependenceInputError,
    RoundDispatch,
    verify_independence,
)
from .ledger import load_declared_jsonl
from .plan_convergence import (
    TERMINAL_STATES,
    converged_plan_body,
    force_plan_human_required,
    _plan_requires_coverage,
    evaluate_plan,
    fold_plan_state,
    record_coverage,
)
from .plan_coverage import (
    adjudicate_waivers,
    compute_plan_coverage,
    environment_unable_payload,
    parse_critic_adjudication,
)
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

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
        # CL-1 (ORPHAN-725) — the step function's mid-flight verdict:
        # convergence is advancing across cycles; the orchestrator
        # skips implementation this cycle and resumes next cycle.
        "in_progress",
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
    elif terminal_state == "HUMAN_REQUIRED" and any(r.startswith("coverage_") for r in reasons):
        # Plan-coverage gate escalations (coverage_missing /
        # coverage_environment_unable / coverage_gaps_present at
        # max_rounds without the max_rounds reason). "split" = human
        # escalation; the branch tag keeps the provenance distinct so
        # the operator sees WHICH gate fired without grepping.
        _verdict, _branch = "split", "HUMAN_REQUIRED+coverage_gate"
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


def _persistence_path(root: Path, plan_id: str) -> Path:
    # E2/F9 — keyed by PLAN, not cycle: the resume branch already requires
    # plan_id equality, but a cycle-keyed filename meant a new cycle never
    # even opened the file that held the plan it was adopting.
    state_dir = root / "state" / "convergence"
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir / f"{plan_id}.json"


def _check_aria_stop(root: Path) -> bool:
    return (root / "ARIA_STOP").exists()


def _resolve_workspace_head_sha(workspace_root: str | Path | None) -> str | None:
    """The commit SHA the plan's evidence is grounded at (the checkout HEAD).

    Threaded into every planner/challenger/cross-review/critic envelope as
    ``target_sha`` so the evidence-validator can grade an agent's evidence_refs
    as ``repo_verified`` (content matches the git blob at this SHA) instead of
    ``worktree_candidate``. Without it, ``EvidencePolicy.require_repo_verified``
    rejects EVERY real ref and convergence can never complete — the layer-4
    blocker found live 2026-07-03. Returns None when HEAD cannot be resolved
    (detached/shallow/no-git); the validator then keeps its prior behaviour.
    """
    root = Path(workspace_root) if workspace_root else Path.cwd()
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root),
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sha = proc.stdout.strip()
    return sha if proc.returncode == 0 and sha else None


def _structured_revision_content(state: dict[str, Any]) -> dict[str, Any] | None:
    """Latest revision's content as a structured plan dict, or None.

    The kernel treats revision content as opaque hash-chained text; the
    coverage computer needs the structured plan (affected_surfaces +
    coverage.waivers). V8 primaries submit revised plans as JSON — when
    they don't, the coverage phase records environment_unable (fail-closed)
    rather than analyzing nothing and passing.
    """
    for event in reversed(state.get("events", [])):
        if event.get("event_type") == "revision_recorded":
            content = event.get("payload", {}).get("content")
            if isinstance(content, dict):
                return content
            if isinstance(content, str):
                try:
                    parsed = json.loads(content)
                except json.JSONDecodeError:
                    return None
                return parsed if isinstance(parsed, dict) else None
            return None
    return None


def _accepted_output_text(
    *, request_id: str, role: str, base_dir: str | Path
) -> str | None:
    """The text an agent actually produced, or ``None`` if unreadable.

    ORPHAN-CRITICAL-446 — the independence gate compares what the
    primary, the challenger and the cross-reviewer WROTE. Reading that
    text needs the accepted result row, because the row is the only
    evidence the agent delivered at all: ``accepted_result_for_request``
    rejects a claim with no result, a rejection, and a HUMAN_REQUIRED
    escalation, which is exactly the distinction ORPHAN-HIGH-422
    established.

    Every failure returns ``None`` rather than an empty string. The two
    are not interchangeable here: :class:`RoundDispatch` treats ``None``
    as "no text to compare" and the diversity layer fails closed on it,
    whereas an empty string would score as maximally diverse against
    anything and pass.
    """
    if not request_id:
        return None
    try:
        accepted = accepted_result_for_request(
            request_id=request_id, role=role, base_dir=base_dir,
        )
    except Exception:
        return None
    if not accepted:
        return None
    output_path = accepted.get("output_path")
    if not isinstance(output_path, str) or not output_path:
        return None
    from .agent_invocations import resolve_output_artifact_path

    path = resolve_output_artifact_path(ensure_tools_dir(base_dir), output_path)
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return text or None


# CL-1 (ORPHAN-725) — resumable, wait-free convergence.
#
# WHY this body replaced the round loop: convergence used to run as a
# synchronous multi-round loop that polled `fold_plan_state` for the
# states a SEPARATE workflow run produces. The cycle lane mints the
# challenger envelope; the executor lane (workflow_run-chained, or the
# 02:29 cron) drains it later — so every poll structurally lost
# (13/13 `challenger_drafted_poll_timeout` in production, zero plans
# ever CONVERGED), and the round-1 re-entry called `start_plan` on an
# adopted DRAFT plan, wedging it behind `convergence_invalid_plan`
# every following night. WHAT: each cycle now advances the plan's
# kernel state machine by exactly ONE derived step — fold whatever the
# executor already delivered, mint the next envelope, return
# `in_progress` — and convergence completes ACROSS cycles instead of
# inside one. The state machine (plans/events.jsonl) is the resume
# point; no new plan-event vocabulary exists.

# Retry budgeting lives at the REQUEST layer (Y1: two requeues plus
# harness-class releases) and the bridge mints are idempotent per
# (plan, role, round) — a second mint folds to the same request, so a
# drainer-side re-mint budget would be an unreachable double budget.
# The honest rule: a step's envelope is either LIVE (wait), ABSENT
# (mint once), or DEAD (its request-layer budget is spent) — dead
# forces the plan to a TERMINAL HUMAN_REQUIRED via the kernel's own
# event, and the next cycle starts a fresh plan.

_STEP_ROLE_PRIMARY = "primary_plan"
_STEP_ROLE_CHALLENGER = "challenger_plan"
_STEP_ROLE_CROSS_REVIEW = "cross_review"
_STEP_ROLE_CRITIC = "completeness_critique"


def _requests_for_step(
    base_dir: str | Path,
    *,
    convergence_id: str,
    role: str,
    round_number: int,
) -> list[dict[str, Any]]:
    """Every minted request for one (plan, role, round) — the remint budget's
    denominator and the idempotent-mint guard's haystack."""
    root = ensure_tools_dir(base_dir)
    path = root / "agent-invocations" / "requests.jsonl"
    if not path.exists():
        return []
    rows = load_declared_jsonl(path, expected_surface="agent_invocation_requests")
    return [
        row
        for row in rows
        if row.get("convergence_id") == convergence_id
        and row.get("role") == role
        and row.get("round_number") == round_number
    ]


def _live_request_id(
    base_dir: str | Path,
    *,
    convergence_id: str,
    role: str,
    round_number: int,
) -> str | None:
    """A request the executor can still deliver (pending/claimed/requeued)."""
    from .agent_invocations import derive_request_state

    for row in _requests_for_step(
        base_dir, convergence_id=convergence_id, role=role, round_number=round_number,
    ):
        request_id = str(row.get("request_id") or "")
        if not request_id:
            continue
        try:
            state = derive_request_state(request_id=request_id, base_dir=base_dir)
        except Exception:
            continue
        if state in {"PENDING", "CLAIMED", "REQUEUED"}:
            return request_id
    return None


class _EnvelopeDead(Exception):
    """Raised when a step's envelope died at the request layer."""

    def __init__(self, role: str) -> None:
        super().__init__(role)
        self.role = role


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
    coverage_computer: Any | None = None,
    critic_adjudicator: Any | None = None,
    critic_timeout_seconds: float = 900.0,
) -> ConvergenceResult:
    """CL-1 — advance the plan's convergence by ONE derived step, no waiting.

    ``challenger_timeout_seconds`` / ``critic_timeout_seconds`` are
    accepted for the ConvergenceRunner Protocol's stability but no
    longer time anything: there is nothing to wait for, because the
    executor lane delivers envelopes between cycles. The
    ``critic_adjudicator`` seam keeps its test-injection contract —
    when injected, the critic is resolved synchronously exactly as the
    tests expect; production leaves it None and gets the async
    mint-then-fold path.
    """
    _ = challenger_timeout_seconds, critic_timeout_seconds
    root = ensure_tools_dir(base_dir)
    transcript_dir = root / "convergence"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = transcript_dir / f"{cycle_id}.jsonl"
    persistence = _persistence_path(root, plan_id)
    convergence_id = plan_id
    target_sha = _resolve_workspace_head_sha(workspace_root)
    resolved_coverage_computer = coverage_computer or compute_plan_coverage

    request_ids: list[str] = []

    # Coverage gaps carried across cycles ride the persistence JSON —
    # the ONLY thing it still stores (round progress now lives in the
    # kernel state machine itself).
    coverage_carry: list[dict[str, Any]] = []
    resumed = False
    if persistence.exists():
        try:
            saved = json.loads(persistence.read_text(encoding="utf-8"))
            if saved.get("plan_id") == plan_id:
                carried = saved.get("coverage_must_satisfy")
                if isinstance(carried, list):
                    coverage_carry = [item for item in carried if isinstance(item, dict)]
                resumed = True
        except (OSError, json.JSONDecodeError, ValueError):
            resumed = False

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    plan_state = state.get("state")
    current_round = int(state.get("current_round") or 1)
    # Adopted plans derive their obligations from what the plan STARTED
    # with plus carried coverage gaps — not tonight's fresh synthesis,
    # which may describe a different problem entirely.
    if plan_state is not None:
        started = state.get("plan_started") or {}
        started_ms = started.get("must_satisfy") if isinstance(started, dict) else None
        base_ms = started_ms if isinstance(started_ms, list) else must_satisfy
    else:
        base_ms = must_satisfy
    effective_must_satisfy: list[dict[str, Any]] = [*base_ms, *coverage_carry]

    def _result(verdict: str, *, rounds: int, converged: dict[str, Any] | None = None,
                unsatisfied: list[dict[str, Any]] | None = None) -> ConvergenceResult:
        return ConvergenceResult(
            plan_id=plan_id,
            converged_plan=converged or {},
            rounds_count=rounds,
            arbiter_verdict=verdict,  # type: ignore[typeddict-item]
            unsatisfied_items=unsatisfied or [],
            request_ids=request_ids,
            transcript_path=str(transcript_path),
            resumed_from_persistence=resumed,
            convergence_id=convergence_id,
        )

    def _advanced(action: str, request_id: str | None, round_n: int) -> None:
        append_tools_governance(
            root,
            "convergence_step_advanced",
            {
                "plan_id": plan_id,
                "cycle_id": cycle_id,
                "from_state": plan_state,
                "action": action,
                "round_number": round_n,
                "request_id": request_id,
            },
        )

    def _ensure_envelope(role: str, round_n: int, mint: Any) -> str | None:
        """Idempotent envelope guarantee for one step.

        Returns the live request id (existing or freshly minted). Raises
        _EnvelopeDead when a prior request exists but is no longer
        deliverable — its Y1 request-layer budget is already spent, and
        the idempotent bridge mint could only fold back onto it.
        """
        live = _live_request_id(
            base_dir, convergence_id=convergence_id, role=role, round_number=round_n,
        )
        if live:
            return live
        prior = _requests_for_step(
            base_dir, convergence_id=convergence_id, role=role, round_number=round_n,
        )
        if prior:
            raise _EnvelopeDead(role)
        request = mint()
        request_id = request.get("request_id")
        if request_id:
            request_ids.append(str(request_id))
        return str(request_id) if request_id else None

    def _plan_texts_from_state(cur: dict[str, Any]) -> tuple[str, bool, str, str, bool]:
        """(primary_text, primary_real, challenger_revision_id,
        challenger_text, challenger_real) — from kernel state only."""
        import json as _json

        primary_text = ""
        latest = cur.get("latest_revision") or {}
        candidate: object = latest.get("content") if isinstance(latest, dict) else None
        if not candidate:
            plan_started = cur.get("plan_started") or {}
            if isinstance(plan_started, dict):
                candidate = plan_started.get("plan_content")
        if isinstance(candidate, dict):
            primary_text = _json.dumps(candidate, indent=2, sort_keys=True)
        elif isinstance(candidate, str) and candidate.strip():
            primary_text = candidate
        primary_real = bool(primary_text) and primary_text.strip() not in {"", "{}", "null"}

        challenger = cur.get("challenger") or {}
        challenger_revision_id = f"{plan_id}-c{current_round}"
        challenger_text = ""
        if isinstance(challenger, dict):
            rid = challenger.get("challenger_revision_id")
            if isinstance(rid, str) and rid:
                challenger_revision_id = rid
            content = challenger.get("plan_content")
            if isinstance(content, dict):
                challenger_text = _json.dumps(content, indent=2, sort_keys=True)
        challenger_real = bool(challenger_text)
        if not challenger_text:
            challenger_text = (
                f"{{\"error\": \"challenger plan_content unavailable in plan state for "
                f"plan_id={plan_id} revision_id={challenger_revision_id}\"}}"
            )
        if not primary_real:
            primary_text = (
                f"{{\"error\": \"primary plan content unavailable in plan state for "
                f"plan_id={plan_id}\"}}"
            )
        return primary_text, primary_real, challenger_revision_id, challenger_text, challenger_real

    def _store_round_dispatches(round_n: int) -> dict[str, RoundDispatch]:
        """ORPHAN-HIGH-421 faithful rebuild — keyed store lookup per role,
        never positional. Built only at CONVERGED time."""
        cur = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        primary_text, primary_real, challenger_rid, challenger_text, challenger_real = (
            _plan_texts_from_state(cur)
        )
        out: dict[str, RoundDispatch] = {}

        def _latest_request_id(role: str) -> str:
            rows = _requests_for_step(
                base_dir, convergence_id=convergence_id, role=role, round_number=round_n,
            )
            return str(rows[-1].get("request_id") or "") if rows else ""

        def _put(ind_role: str, *, request_id: str, revision_id: str | None,
                 agent_text: str | None) -> None:
            try:
                out[ind_role] = RoundDispatch(
                    role=ind_role,
                    request_id=request_id or None,
                    revision_id=revision_id,
                    agent_text=agent_text,
                )
            except IndependenceInputError as exc:
                append_tools_governance(
                    root,
                    "round_dispatch_record_refused",
                    {"plan_id": plan_id, "cycle_id": cycle_id,
                     "round_number": round_n, "role": ind_role, "reason": str(exc)},
                )

        primary_revision_id = f"{plan_id}-r{round_n}"
        latest = cur.get("latest_revision") or {}
        if isinstance(latest, dict) and isinstance(latest.get("revision_id"), str):
            primary_revision_id = latest["revision_id"] if round_n > 1 else f"{plan_id}-r1"
        _put(
            IND_PRIMARY_ROLE,
            request_id=_latest_request_id(_STEP_ROLE_PRIMARY),
            revision_id=primary_revision_id,
            agent_text=primary_text if primary_real else None,
        )
        _put(
            IND_CHALLENGER_ROLE,
            request_id=_latest_request_id(_STEP_ROLE_CHALLENGER),
            revision_id=challenger_rid,
            agent_text=challenger_text if challenger_real else None,
        )
        cross_review_request_id = _latest_request_id(_STEP_ROLE_CROSS_REVIEW)
        _put(
            IND_CROSS_REVIEW_ROLE,
            request_id=cross_review_request_id,
            revision_id=None,
            # ORPHAN-CRITICAL-446 — the reviewer's REAL accepted output, or
            # None so the gate says self_agreement instead of assuming.
            agent_text=_accepted_output_text(
                request_id=cross_review_request_id,
                role=CROSS_REVIEW_TARGET_AND_ROLE[1],
                base_dir=base_dir,
            ) if cross_review_request_id else None,
        )
        return out

    def _read_critic_result_once(request_id: str) -> dict[str, Any] | None:
        """Single non-blocking pass over the results ledger (the executor
        delivered — or has not yet). None = not delivered / unusable."""
        results_path = root / "agent-invocations" / "results.jsonl"
        rows = (
            load_declared_jsonl(results_path, expected_surface="agent_invocation_results")
            if results_path.exists()
            else []
        )
        for row in reversed(rows):
            if row.get("request_id") != request_id:
                continue
            if row.get("status") == "rejected":
                return None
            output_path = row.get("output_path")
            if not isinstance(output_path, str) or not output_path:
                return None
            from .agent_invocations import resolve_output_artifact_path

            artifact = resolve_output_artifact_path(root, output_path)
            if not artifact.exists():
                return None
            text = artifact.read_text(encoding="utf-8", errors="replace")
            envelope: dict[str, Any] | None = None
            try:
                parsed = json.loads(text)
                envelope = parsed if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                fenced = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
                for block in reversed(fenced):
                    try:
                        candidate = json.loads(block)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(candidate, dict):
                        envelope = candidate
                        break
            return parse_critic_adjudication(envelope)
        return None

    def _coverage_step(round_n: int) -> str | None:
        """Record this round's coverage verdict, minting the critic
        asynchronously when waivers need adjudication.

        Returns None when coverage is now recorded (or not required) and
        evaluation may proceed; returns "waiting" when a critic envelope
        is pending delivery.
        """
        cur = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        if not _plan_requires_coverage(cur):
            return None
        if (cur.get("coverage_by_round") or {}).get(round_n):
            return None  # recorded on an earlier cycle
        challenger = cur.get("challenger") or {}
        latest = cur.get("latest_revision") or {}
        if round_n == 1 and challenger.get("challenger_revision_id"):
            target_revision_id = challenger["challenger_revision_id"]
            target_hash = challenger["content_hash"]
            plan_content: Any = challenger.get("plan_content") or {}
        else:
            target_revision_id = latest.get("revision_id")
            target_hash = latest.get("content_hash")
            plan_content = _structured_revision_content(cur)
        try:
            if isinstance(plan_content, dict) and plan_content.get("affected_surfaces") is not None:
                payload = resolved_coverage_computer(
                    plan_content=plan_content,
                    plan_id=plan_id,
                    round_number=round_n,
                    target_revision_id=target_revision_id,
                    target_plan_content_hash=target_hash,
                    workspace_root=workspace_root or Path.cwd(),
                    base_dir=base_dir,
                )
            else:
                payload = environment_unable_payload(
                    round_number=round_n,
                    target_revision_id=str(target_revision_id),
                    target_plan_content_hash=str(target_hash),
                    manifest_relpath=f"{root.name}/coverage/{plan_id}-r{round_n}.json",
                    manifest_hash="sha256:" + ("0" * 64),
                    computed_at_sha="unknown",
                    witness={"tool": "convergence_drainer", "error": "revision_content_not_structured"},
                )
            if payload.get("verdict") == "covered_with_waivers" and payload.get("waived"):
                if critic_adjudicator is not None:
                    payload = critic_adjudicator(payload, round_n)
                else:
                    manifest_name = Path(str(payload.get("closure_manifest_path"))).name
                    manifest_file = root / "coverage" / manifest_name
                    manifest_text = (
                        manifest_file.read_text(encoding="utf-8", errors="replace")
                        if manifest_file.exists()
                        else "(closure manifest unavailable)"
                    )
                    critic_request_id = _ensure_envelope(
                        _STEP_ROLE_CRITIC,
                        round_n,
                        lambda: issue_completeness_critic_envelope(
                            plan_id=plan_id,
                            round_number=round_n,
                            closure_manifest_text=manifest_text,
                            closure_manifest_hash=str(payload.get("closure_manifest_hash")),
                            waivers=list(payload.get("waived", [])),
                            evidence_refs=[str(payload.get("closure_manifest_path")), *evidence_refs],
                            allowed_scope=allowed_scope,
                            base_dir=base_dir,
                            target_sha=target_sha,
                        ),
                    )
                    adjudication = (
                        _read_critic_result_once(critic_request_id)
                        if critic_request_id
                        else None
                    )
                    if adjudication is None and critic_request_id and _live_request_id(
                        base_dir, convergence_id=convergence_id,
                        role=_STEP_ROLE_CRITIC, round_number=round_n,
                    ):
                        _advanced("await_completeness_critic", critic_request_id, round_n)
                        return "waiting"
                    payload = adjudicate_waivers(
                        payload=payload,
                        adjudication=adjudication,
                        round_number=round_n,
                        critic_request_id=critic_request_id,
                    )
                    append_tools_governance(
                        root,
                        "coverage_waiver_adjudication",
                        {
                            "plan_id": plan_id,
                            "cycle_id": cycle_id,
                            "round_number": round_n,
                            "critic_request_id": critic_request_id,
                            **(payload.get("witness") or {}).get("waiver_adjudication", {}),
                            "verdict_after": payload.get("verdict"),
                        },
                    )
            record_coverage(plan_id=plan_id, coverage=payload, base_dir=base_dir)
            append_tools_governance(
                root,
                "coverage_phase_completed",
                {
                    "plan_id": plan_id,
                    "cycle_id": cycle_id,
                    "round_number": round_n,
                    "verdict": payload.get("verdict"),
                    "uncovered_count": len(payload.get("uncovered", [])),
                    "waived_count": len(payload.get("waived", [])),
                },
            )
            return None
        except GovernanceError as exc:
            append_tools_governance(
                root,
                "coverage_phase_failed",
                {"plan_id": plan_id, "cycle_id": cycle_id,
                 "round_number": round_n, "error": str(exc)},
            )
            return None

    def _terminal_result(cur: dict[str, Any], round_n: int) -> ConvergenceResult:
        terminal_state = cur.get("terminal_state") or cur.get("state")
        # Reasons live in the terminal plan_evaluated event's payload.
        reason_codes: list[str] = []
        for event in reversed(cur.get("events") or []):
            if event.get("event_type") == "plan_evaluated":
                reason_codes = list((event.get("payload") or {}).get("reason_codes") or [])
                break
        arbiter_verdict = _derive_arbiter_verdict(str(terminal_state), reason_codes)
        try:
            append_tools_governance(
                root,
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
        if arbiter_verdict == "converged":
            dispatches = _store_round_dispatches(round_n)
            missing = [
                role
                for role in (IND_PRIMARY_ROLE, IND_CHALLENGER_ROLE, IND_CROSS_REVIEW_ROLE)
                if role not in dispatches
            ]
            if missing:
                independence_ok = False
                violation_reasons = [f"round_dispatch_missing:{role}" for role in missing]
            else:
                independence_ok, violation_reasons = verify_independence(
                    primary=dispatches[IND_PRIMARY_ROLE],
                    challenger=dispatches[IND_CHALLENGER_ROLE],
                    cross_review=dispatches[IND_CROSS_REVIEW_ROLE],
                    base_dir=base_dir,
                )
            if not independence_ok:
                arbiter_verdict = "cross_review_self_agreement"
                try:
                    append_tools_governance(
                        root,
                        "convergence_invalid_self_agreement",
                        {
                            "plan_id": plan_id,
                            "cycle_id": cycle_id,
                            "round_number": round_n,
                            "violation_reasons": violation_reasons,
                            "request_ids": request_ids,
                        },
                    )
                except Exception:
                    pass
        # ORPHAN-CRITICAL-728 — the CONVERGED body comes from the ONE
        # producer that verifies it: `converged_plan_body` returns the
        # recorded body only when its content hash reproduces the
        # CONVERGED revision's hash. The hand-rolled precedence chain
        # this replaces could hand the implementation lane a body no
        # ledger event vouches for (and the pre-CL-1 spelling handed it
        # `{}` on every converged plan, since `evaluate_plan` has never
        # carried a `plan_content` key at all).
        converged_plan: dict[str, Any] = {}
        if arbiter_verdict == "converged":
            converged_plan = converged_plan_body(
                plan_id=plan_id, base_dir=base_dir,
            )["plan_content"]
        if persistence.exists():
            try:
                persistence.unlink()
            except OSError:
                pass
        return _result(arbiter_verdict, rounds=round_n, converged=converged_plan)

    # ------------------------------------------------------------------
    # The step dispatch.
    # ------------------------------------------------------------------
    if _check_aria_stop(root):
        persistence.write_text(
            json.dumps({"plan_id": plan_id, "round": current_round, "interrupted": True}),
            encoding="utf-8",
        )
        return _result("aria_stop_interrupted", rounds=current_round)

    try:
        if plan_state in TERMINAL_STATES or plan_state in {"ABANDONED"}:
            return _terminal_result(state, current_round)

        if plan_state is None:
            start_convergent_plan_drafted_by_primary(
                plan_id=plan_id,
                plan_content=plan_seed,
                initial_revision_id=f"{plan_id}-r1",
                base_dir=base_dir,
            )
            request_id = _ensure_envelope(
                _STEP_ROLE_CHALLENGER,
                1,
                lambda: issue_challenger_envelope(
                    plan_id=plan_id,
                    round_number=1,
                    must_satisfy=effective_must_satisfy,
                    evidence_refs=evidence_refs,
                    allowed_scope=allowed_scope,
                    base_dir=base_dir,
                    target_sha=target_sha,
                ),
            )
            _advanced("plan_started_and_challenger_minted", request_id, 1)
            return _result("in_progress", rounds=1)

        if plan_state == "DRAFT":
            # K1 root kill: an adopted DRAFT plan is NEVER re-started.
            request_id = _ensure_envelope(
                _STEP_ROLE_CHALLENGER,
                current_round,
                lambda: issue_challenger_envelope(
                    plan_id=plan_id,
                    round_number=current_round,
                    must_satisfy=effective_must_satisfy,
                    evidence_refs=evidence_refs,
                    allowed_scope=allowed_scope,
                    base_dir=base_dir,
                    target_sha=target_sha,
                ),
            )
            _advanced("await_challenger", request_id, current_round)
            return _result("in_progress", rounds=current_round)

        if plan_state == "REVISED":
            request_id = _ensure_envelope(
                _STEP_ROLE_CHALLENGER,
                current_round,
                lambda: issue_challenger_envelope(
                    plan_id=plan_id,
                    round_number=current_round,
                    must_satisfy=effective_must_satisfy,
                    evidence_refs=evidence_refs,
                    allowed_scope=allowed_scope,
                    base_dir=base_dir,
                    target_sha=target_sha,
                ),
            )
            _advanced("await_challenger_for_revision", request_id, current_round)
            return _result("in_progress", rounds=current_round)

        if plan_state == "CHALLENGER_DRAFTED":
            primary_plan_text, _pr, challenger_rid, challenger_plan_text, _cr = (
                _plan_texts_from_state(state)
            )
            latest = state.get("latest_revision") or {}
            primary_revision_id = (
                latest.get("revision_id")
                if isinstance(latest, dict) and isinstance(latest.get("revision_id"), str)
                else f"{plan_id}-r{current_round}"
            )
            try:
                request_id = _ensure_envelope(
                    _STEP_ROLE_CROSS_REVIEW,
                    current_round,
                    lambda: issue_cross_review_envelope(
                        plan_id=plan_id,
                        round_number=current_round,
                        primary_revision_id=str(primary_revision_id),
                        primary_plan_text=primary_plan_text,
                        challenger_revision_id=challenger_rid,
                        challenger_plan_text=challenger_plan_text,
                        must_satisfy=effective_must_satisfy,
                        evidence_refs=evidence_refs,
                        allowed_scope=allowed_scope,
                        base_dir=base_dir,
                        target_sha=target_sha,
                    ),
                )
            except Exception as mint_exc:
                if isinstance(mint_exc, _EnvelopeDead):
                    raise
                append_tools_governance(
                    root,
                    "cross_review_mint_failed",
                    {
                        "plan_id": plan_id,
                        "round_number": current_round,
                        "exception_class": type(mint_exc).__name__,
                        "exception_message": str(mint_exc)[:500],
                    },
                )
                raise
            _advanced("await_cross_review", request_id, current_round)
            return _result("in_progress", rounds=current_round)

        if plan_state == "CROSS_REVIEW_REQUESTED":
            # Envelope minted on an earlier cycle; executor owns delivery.
            request_id = _ensure_envelope(
                _STEP_ROLE_CROSS_REVIEW,
                current_round,
                lambda: (_ for _ in ()).throw(
                    GovernanceError("cross_review re-mint requires CHALLENGER_DRAFTED texts")
                ),
            )
            _advanced("await_cross_review", request_id, current_round)
            return _result("in_progress", rounds=current_round)

        if plan_state in {"CROSS_REVIEWED", "CRITIQUED"}:
            waiting = _coverage_step(current_round)
            if waiting == "waiting":
                return _result("in_progress", rounds=current_round)
            eval_result = evaluate_plan(
                plan_id=plan_id,
                round_number=current_round,
                base_dir=base_dir,
                max_rounds=max_rounds,
            )
            event_payload = eval_result.get("event", {}).get("payload", {})
            terminal_state = event_payload.get("terminal_state")
            if terminal_state in TERMINAL_STATES:
                return _terminal_result(
                    fold_plan_state(plan_id=plan_id, base_dir=base_dir), current_round,
                )
            # NEXT_ROUND_REQUIRED — carry coverage gaps forward, mint the
            # primary revision envelope, resume next cycle.
            state_after = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
            coverage_after = (state_after.get("coverage_by_round") or {}).get(current_round) or {}
            coverage_carry = [
                {
                    "id": f"coverage:{node.get('node_id')}",
                    "kind": "coverage_gap",
                    "description": (
                        f"{node.get('node_id')}: {node.get('why')} — widen affected_surfaces "
                        "to address this impact-closure node or add a coverage.waivers entry {node, reason}"
                    ),
                    "source": "plan-coverage-witness",
                }
                for node in coverage_after.get("uncovered", [])
            ]
            persistence.write_text(
                json.dumps({
                    "plan_id": plan_id,
                    "round": current_round + 1,
                    "coverage_must_satisfy": coverage_carry,
                }),
                encoding="utf-8",
            )
            next_round = current_round + 1
            try:
                request_id = _ensure_envelope(
                    _STEP_ROLE_PRIMARY,
                    next_round,
                    lambda: issue_primary_envelope(
                        plan_id=plan_id,
                        round_number=next_round,
                        must_satisfy=[*base_ms, *coverage_carry],
                        evidence_refs=evidence_refs,
                        allowed_scope=allowed_scope,
                        base_dir=base_dir,
                        target_sha=target_sha,
                    ),
                )
            except BridgeContractViolation:
                return _result("primary_revision_failed", rounds=current_round)
            _advanced("await_primary_revision", request_id, next_round)
            return _result("in_progress", rounds=current_round)

        if plan_state == "CRITIQUE_REQUESTED":
            # Legacy V8 critique tasks are answered by the executor lane;
            # nothing to mint here.
            _advanced("await_critique_tasks", None, current_round)
            return _result("in_progress", rounds=current_round)

        # Implementation-phase states are the V9 runner's territory — the
        # convergence step neither waits on nor advances them.
        _advanced("noop_state", None, current_round)
        return _result("in_progress", rounds=current_round)

    except _EnvelopeDead as dead:
        force_plan_human_required(
            plan_id=plan_id,
            round_number=current_round,
            reason_codes=[f"convergence_envelope_dead:{dead.role}"],
            base_dir=base_dir,
        )
        append_tools_governance(
            root,
            "convergence_envelope_dead",
            {
                "plan_id": plan_id,
                "cycle_id": cycle_id,
                "round_number": current_round,
                "role": dead.role,
            },
        )
        return _terminal_result(
            fold_plan_state(plan_id=plan_id, base_dir=base_dir), current_round,
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
