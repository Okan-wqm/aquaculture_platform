"""Plan 026R §F.3 — canonical AutonomyState dataclass + reducer.

Pre-§F.3 the autonomous daemons each had their own counters
(``planner_dispatch_daemon`` claims_dispatched,
``worker_scheduler_daemon`` assignments_dispatched, etc.) but no
single state surface that a CLI or external observer could
query for "what is ARIA's current state?". §F.3 introduces a
single canonical dataclass with a reducer that derives the
current state from the ``autonomy_state.jsonl`` ledger written
by §F.1 ``run_autonomy_orchestrator``.

State derivation is reducer-only (latest-row-wins for scalar
fields, sum-fold for counters). Each §F.1 transition appends a
single row; the reducer reads the ledger and returns the
canonical ``AutonomyState`` so manual operator CLI commands
(``aria-kernel autonomy status``) route through the same SSoT
as F.1.

Verify-on-read discipline (§F.4): this module reads the
autonomy state ledger via ``load_jsonl(..., verify=True)`` so
chain-mismatch or canonical drift surfaces as
``LedgerIntegrityError`` rather than a stale-state read.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import ensure_tools_dir, utc_now


__all__ = [
    "AutonomyState",
    "AutonomyStateAccumulator",
    "AutonomyStateReducer",
    "autonomy_state_path",
    "fold_autonomy_state_rows",
]


# Phase transitions emitted by §F.1.
AUTONOMY_PHASES: tuple[str, ...] = (
    "cycle_started",
    "cycle_completed",
    "planner_dispatch_drained",
    "bridge_drained",
    "convergent_plan_completed",
    # Plan ARIA-V5 §2 V5.1 Gate A — pre-worker primary↔challenger
    # convergence phases. ``convergence_started`` fires when the
    # drainer issues the primary envelope; ``..._round_completed`` per
    # round; ``..._resolved`` on terminal verdict; ``..._blocked``
    # when verdict != "converged" and worker_drainer is therefore
    # skipped. All four are discoverability-only — the reducer
    # accepts any phase string (autonomy_state.py:146 docstring).
    "convergence_started",
    "convergence_round_completed",
    "convergence_resolved",
    "convergence_blocked",
    "worker_dispatch_drained",
    "validation_completed",
    "pr_lifecycle_completed",
    "auto_merge_completed",
    # Plan ARIA-V5 §2 V5.2 Gate B — post-implementation adversarial
    # review phases. ``review_started`` fires when review_runner is
    # invoked; ``..._round_completed`` per judge round;
    # ``..._resolved`` on terminal verdict; ``..._blocked_merge`` when
    # verdict != "no_gaps" and auto_merge_runner is therefore skipped.
    "review_started",
    "review_round_completed",
    "review_resolved",
    "review_blocked_merge",
    # Plan ARIA-V6 §2c V6.1 Phase 6.1 — Gate C Lane-A specialist
    # dispatch phases. Fired between convergence_resolved and
    # worker_dispatch_drained: specialist_review_started when N
    # specialists are minted; _round_completed per polling pass;
    # _resolved on terminal verdict (consolidated_no_gaps /
    # consolidated_remediation_required / consolidated_judge_split /
    # specialists_unavailable); _blocked when verdict requires
    # remediation and worker_drainer skipped.
    "specialist_review_started",
    "specialist_review_round_completed",
    "specialist_review_resolved",
    "specialist_review_blocked",
    # Plan ARIA-V7 §2i v2 Phase 7.1 — cycle_runner plan synthesis
    # phases. ``cycle_runner_synthesized_plan`` fires when the
    # plan_synthesizer produced a valid plan_content from real
    # workspace deltas; ``cycle_runner_no_pressure`` fires when
    # discovery found nothing and the orchestrator routes directly
    # to reflection (Gate A + downstream phases skipped). The
    # constant is a discoverability hint; the reducer accepts any
    # phase string.
    "cycle_runner_synthesized_plan",
    "cycle_runner_no_pressure",
    # Plan ARIA-V7 §2g v2 Phase 7.2 — orchestrator try/except
    # envelope around convergence_runner. ``convergence_invalid_plan``
    # fires when plan_convergence._validate_plan_content (or any
    # downstream surface) raises GovernanceError. The crash is
    # converted to a verdict + governance event for operator
    # forensics; cycle continues to reflection without crashing the
    # autonomy loop (closes ORPHAN-HIGH-079 for malformed-payload
    # edge cases beyond V7.1's empty-skip).
    "convergence_invalid_plan",
    # Plan ARIA-V7 §2h v2 Phase 7.4 — skill_genesis_drainer phases.
    # ``skill_genesis_drainer_started`` fires when the drainer scans
    # the requests.jsonl ledger; ``_resolved`` on terminal verdict
    # (dispatched_clean / dispatched_mixed / drainer_disabled /
    # token_budget_exceeded / authoring_error_present / no_requests).
    # ``_round_completed`` fires per request dispatched;
    # ``_blocked`` fires when verdict requires operator review.
    "skill_genesis_drainer_started",
    "skill_genesis_drainer_round_completed",
    "skill_genesis_drainer_resolved",
    "skill_genesis_drainer_blocked",
    # Plan ARIA-V7 §3 Phase 7.6 — calibration_reporter phase fires
    # AFTER auto_merge_runner and BEFORE reflection. Invokes
    # generate_adapter_calibration_report for every SHADOW/ACTIVE
    # adapter; persists precision_history to the calibration ledger.
    # Without this V6.4 compute_auto_promote_token can NEVER fire
    # (V6.4 was a latent dead loop pre-V7).
    "calibration_reporter_completed",
    # Plan ARIA-V7 §3 Phase 7.7 — cycle watchdog deadline phase.
    # Fires when a cycle exceeds cycle_deadline_seconds; orchestrator
    # writes ARIA_STOP to halt the autonomy loop cleanly. No silent
    # hang (closes V7.8 verification gate H-1 flakiness).
    "cycle_deadline_exceeded",
    "next_cycle_queued",
    "aria_stop",
    "profile_frozen",
    "max_cycles_reached",
    "max_iterations_reached",
)


@dataclass(frozen=True, slots=True)
class AutonomyState:
    """Plan 026R §F.3 — canonical autonomy snapshot.

    Reducer-derived, immutable. Fields:

    * ``last_cycle_id`` — most recent cycle_id observed
    * ``last_phase`` — name of the last transition phase
    * ``last_phase_status`` — ``ok|failed|degraded|noop``
    * ``last_recorded_at`` — ISO 8601 UTC of last transition
    * ``cycles_completed`` — count of ``cycle_completed`` rows
    * ``planner_claims_dispatched`` — sum of planner dispatch deltas
    * ``worker_assignments_dispatched`` — sum of worker dispatch deltas
    * ``auto_merges_completed`` — count of ``auto_merge_completed`` rows
    * ``pending_bridge_count`` — last reported pending bridge count
    * ``human_required_count`` — last reported human-required count
    * ``aria_stop_active`` — True if ``aria_stop`` was the last phase
      since the most recent ``cycle_started``
    * ``profile`` — last observed runtime profile name
    """

    last_cycle_id: str | None = None
    last_phase: str | None = None
    last_phase_status: str | None = None
    last_recorded_at: str | None = None
    cycles_completed: int = 0
    planner_claims_dispatched: int = 0
    worker_assignments_dispatched: int = 0
    auto_merges_completed: int = 0
    pending_bridge_count: int = 0
    human_required_count: int = 0
    aria_stop_active: bool = False
    profile: str | None = None
    transition_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "last_cycle_id": self.last_cycle_id,
            "last_phase": self.last_phase,
            "last_phase_status": self.last_phase_status,
            "last_recorded_at": self.last_recorded_at,
            "cycles_completed": self.cycles_completed,
            "planner_claims_dispatched": self.planner_claims_dispatched,
            "worker_assignments_dispatched":
                self.worker_assignments_dispatched,
            "auto_merges_completed": self.auto_merges_completed,
            "pending_bridge_count": self.pending_bridge_count,
            "human_required_count": self.human_required_count,
            "aria_stop_active": self.aria_stop_active,
            "profile": self.profile,
            "transition_count": self.transition_count,
        }


def autonomy_state_path(base_dir: str | Path | None) -> Path:
    """Canonical autonomy state ledger path."""
    root = ensure_tools_dir(base_dir)
    return root / "autonomy_state.jsonl"


def fold_autonomy_state_rows(
    rows: Iterable[Mapping[str, Any]],
) -> AutonomyState:
    """Purely fold verified rows into the legacy autonomy-state view."""
    accumulator = AutonomyStateAccumulator()
    for row in rows:
        accumulator.consume(row)
    return accumulator.snapshot()


@dataclass(slots=True)
class AutonomyStateAccumulator:
    """Incremental form of the canonical autonomy-state reducer."""

    cycles_completed: int = 0
    planner_total: int = 0
    worker_total: int = 0
    auto_merges_total: int = 0
    last_cycle_id: str | None = None
    last_phase: str | None = None
    last_status: str | None = None
    last_recorded: str | None = None
    last_pending_bridge: int = 0
    last_human_required: int = 0
    last_profile: str | None = None
    last_cycle_started_idx: int | None = None
    last_aria_stop_idx: int | None = None
    transition_count: int = 0

    def consume(self, row: Mapping[str, Any]) -> None:
        idx = self.transition_count
        phase = str(row.get("phase") or "")
        status = str(row.get("status") or "")
        if phase == "cycle_completed":
            self.cycles_completed += 1
        if phase == "cycle_started":
            self.last_cycle_started_idx = idx
        if phase == "aria_stop":
            self.last_aria_stop_idx = idx
        self.planner_total += int(row.get("planner_claims_delta") or 0)
        self.worker_total += int(row.get("worker_assignments_delta") or 0)
        self.auto_merges_total += int(row.get("auto_merges_delta") or 0)
        cycle_id = row.get("cycle_id")
        if cycle_id:
            self.last_cycle_id = str(cycle_id)
        self.last_phase = phase
        self.last_status = status
        recorded = row.get("recorded_at")
        if isinstance(recorded, str):
            self.last_recorded = recorded
        pending = row.get("pending_bridge_count")
        if isinstance(pending, int):
            self.last_pending_bridge = pending
        human_req = row.get("human_required_count")
        if isinstance(human_req, int):
            self.last_human_required = human_req
        profile = row.get("profile")
        if isinstance(profile, str):
            self.last_profile = profile
        self.transition_count += 1

    def snapshot(self) -> AutonomyState:
        aria_stop_active = (
            self.last_aria_stop_idx is not None
            and (
                self.last_cycle_started_idx is None
                or self.last_aria_stop_idx > self.last_cycle_started_idx
            )
        )
        return AutonomyState(
            last_cycle_id=self.last_cycle_id,
            last_phase=self.last_phase,
            last_phase_status=self.last_status,
            last_recorded_at=self.last_recorded,
            cycles_completed=self.cycles_completed,
            planner_claims_dispatched=self.planner_total,
            worker_assignments_dispatched=self.worker_total,
            auto_merges_completed=self.auto_merges_total,
            pending_bridge_count=self.last_pending_bridge,
            human_required_count=self.last_human_required,
            aria_stop_active=aria_stop_active,
            profile=self.last_profile,
            transition_count=self.transition_count,
        )


class AutonomyStateReducer:
    """Plan 026R §F.3 — append-only reducer over autonomy_state.jsonl.

    ``transition(...)`` appends a single row; ``derive_current(...)``
    reads the ledger via verify-on-read and folds rows into a
    canonical ``AutonomyState``.
    """

    @staticmethod
    def transition(
        base_dir: str | Path | None,
        *,
        cycle_id: str | None,
        phase: str,
        status: str = "ok",
        planner_claims_delta: int = 0,
        worker_assignments_delta: int = 0,
        auto_merges_delta: int = 0,
        pending_bridge_count: int | None = None,
        human_required_count: int | None = None,
        profile: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append a single transition row to autonomy_state.jsonl.

        Schema version 1. ``phase`` SHOULD be a member of
        ``AUTONOMY_PHASES`` but is not strictly enforced — a future
        autonomy phase added by §F.1 must continue to flow through
        this reducer even before AUTONOMY_PHASES is extended (the
        constant is a discoverability hint for human readers, not
        a closed enum).
        """
        path = autonomy_state_path(base_dir)
        row: dict[str, Any] = {
            "schema_version": 1,
            "cycle_id": cycle_id,
            "phase": phase,
            "status": status,
            "planner_claims_delta": int(planner_claims_delta),
            "worker_assignments_delta": int(worker_assignments_delta),
            "auto_merges_delta": int(auto_merges_delta),
            "pending_bridge_count": pending_bridge_count,
            "human_required_count": human_required_count,
            "profile": profile,
            "details": details or {},
            "recorded_at": utc_now(),
        }
        return append_declared_jsonl(
            path,
            row,
            expected_surface="autonomy_state",
        )

    @staticmethod
    def derive_current(
        base_dir: str | Path | None,
    ) -> AutonomyState:
        """Plan 026R §F.3 + §F.4 verify-on-read.

        Folds the autonomy_state ledger into a canonical
        ``AutonomyState`` snapshot. ARIA_STOP detection: True iff
        the most recent ``aria_stop`` row appears AFTER the most
        recent ``cycle_started`` row (or no ``cycle_started`` exists).
        """
        path = autonomy_state_path(base_dir)
        rows = load_declared_jsonl(
            path,
            expected_surface="autonomy_state",
            verify=True,
        )
        return fold_autonomy_state_rows(rows)
