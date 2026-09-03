from __future__ import annotations

import json
from pathlib import Path
from typing import Any


POLICY_KEYS = {
    "schema_version",
    "enable_request_generation",
    "max_requests_per_cycle",
    "materialization_requires_acknowledge",
    "fitness_staleness_threshold_days",
    # Plan ARIA-V3 §B0 + INFRA-CRITICAL-001 — cost caps consumed by
    # ``cost_budget.assert_within_budget`` to gate autonomous spawns.
    "cost_caps_usd",
    # Plan ARIA-V3 §B2 — circuit-breaker failure threshold.
    "circuit_breaker",
    # ORPHAN-MEDIUM-492 — how long a minted agent-invocation request stays
    # claimable before its target_sha no longer describes the tree it would
    # run against. Consumed by agent_invocations.next_pending_request.
    "agent_request_anchor",
    # Plan S4 (ORPHAN-MEDIUM-298) — per-drift-class pressure score
    # multipliers consumed by pressure.run_pressure.
    "drift_class_weights",
    # Plan ARIA-V6 §2e v2 — convergent_skill_authoring loop config
    # (max_authoring_rounds, sandbox_min_fixtures, recall_floor).
    "convergent_authoring",
    # Plan ARIA-V6 §2e v2 — narrow auto-promotion exception under
    # autonomous-profile + precision/FP/clean-cycles thresholds.
    # Default disabled; operator opt-in via override.
    "auto_promote",
    # C8/E11 — the Z3d superiority block was readable by
    # ``superiority_policy`` but NOT mergeable: an operator override
    # carrying it was silently dropped here, so the block was dead
    # configuration twice over (unthreaded repo_root AND unmergeable key).
    "superiority",
    # Plan ARIA-V7 §2h v2 — V7.4 skill_genesis_drainer policy block
    # (enabled + max_authorings_per_cycle + max_tokens_per_cycle +
    # estimated_tokens_per_authoring). Closes V6 CONCERN #19
    # (pre-cycle budget audit via max_tokens_per_cycle cap).
    "skill_genesis_drainer",
    "genesis_lifecycle",
    # E15-c — open-finding count at which one service earns a dedicated
    # ``aria-svc-<service>-auditor`` genesis request. Joins the contract
    # the same way "superiority" did (C8): a key absent from POLICY_KEYS
    # is silently dropped by merge_with_override, so an operator override
    # would be dead configuration. Consumed by
    # service_agent_targeting.propose_service_auditor_requests.
    "service_auditor_threshold",
    # Y2 (ORPHAN-704) — judgment fan-out discipline: per-tool sample size
    # (was a hardcoded 5 in cycle._phase_judgment_pipeline) and the
    # per-role pending ceiling that stops the nightly mint when the
    # executor's drain is behind. Consumed via judgment_pipeline_policy.
    "judgment_pipeline",
    # E25-a (ORPHAN-710) — rhythm discipline: the open-backlog ceiling that
    # pauses work-minting phases (watchdog_sweep, experiment_author) until
    # ARIA finishes what it already opened. Consumed by
    # cycle._backlog_below_cap via rhythm_policy.
    "executor",
    "rhythm",
    # E24-a (ORPHAN-711) — runtime telemetry pull: where the watchdog reads
    # production metrics from, and the thresholds its detectors apply.
    # Consumed by aria_watchdog.run_watchdog_sweep via watchdog_pull_policy.
    "watchdog_pull",
    # Y8 (ORPHAN-709) — genesis panel lane: per-cycle ceiling on new
    # genesis_candidate panel escalations. Consumed by
    # agent_genesis.sweep_candidate_gaps_for_adjudication.
    "genesis_panel",
}

JUDGMENT_PIPELINE_DEFAULTS: dict[str, Any] = {
    "sample_size_per_tool": 5,
    # Second sealed night measured 462 judge envelopes minted against ~9
    # drained per night: 296 died of anchor staleness without ever being
    # read. 32 per role ≈ 3 nights of drain headroom at the measured
    # ~13min/envelope CLI pace.
    "max_pending_per_role": 32,
}


def judgment_pipeline_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Y2 (ORPHAN-704) — typed accessor for the judgment_pipeline block.

    Mirrors circuit_breaker_policy: the accessor existing is what makes the
    block real configuration — a key absent from POLICY_KEYS is silently
    dropped by merge_with_override, and a block nobody reads is dead JSON.
    """
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        raw = json.loads(
            (Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(JUDGMENT_PIPELINE_DEFAULTS)
    raw_block = merged.get("judgment_pipeline")
    if isinstance(raw_block, dict):
        block.update({k: raw_block[k] for k in JUDGMENT_PIPELINE_DEFAULTS if k in raw_block})
    return block


GENESIS_PANEL_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    # 16 parked gaps measured at Y8 time; 4/cycle drains the backlog in
    # four nights while each record costs a 3-envelope panel.
    "max_panel_opens_per_cycle": 4,
}


def genesis_panel_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Y8 (ORPHAN-709) — typed accessor for the genesis_panel block
    (circuit_breaker_policy pattern: the accessor is what makes the block
    real configuration)."""
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        raw = json.loads(
            (Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(GENESIS_PANEL_DEFAULTS)
    raw_block = merged.get("genesis_panel")
    if isinstance(raw_block, dict):
        block.update({k: raw_block[k] for k in GENESIS_PANEL_DEFAULTS if k in raw_block})
    return block


RHYTHM_DEFAULTS: dict[str, Any] = {
    # Calibrated against the live store at E25 time: 2 kernel findings open.
    # 25 leaves an order of magnitude of headroom before the gate first
    # fires — the ceiling exists for the pile-up failure mode, not for
    # steady state.
    "backlog_cap": 25,
    # Plan 032 Faz 032a — the chain's minimum spacing (SI-5 brake) becomes
    # policy: a plan needs at least three executor→cycle turns
    # (challenger → cross_review → evaluate), and at the 6h code default that
    # is a full day per plan against a 3-day anchor. The default stays 6h;
    # the operator override lowers it. `cycle_rhythm.MIN_CYCLE_INTERVAL_HOURS`
    # remains the code-side floor the decider falls back to.
    "min_interval_hours": 6.0,
}


EXECUTOR_DEFAULTS: dict[str, Any] = {
    # Plan 032 Faz 032h — drain parallelism. 1 = today's serial lane. Raise
    # only after the 032d delivery SLO has held (operator decision, one-way
    # door 16); each concurrent request runs in its own git worktree when
    # `worktree_per_request` is on, so two agents never share a checkout.
    "max_concurrent": 1,
    "worktree_per_request": False,
}


def executor_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Plan 032 Faz 032h — typed accessor for the executor block."""
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        raw = json.loads(
            (Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(EXECUTOR_DEFAULTS)
    raw_block = merged.get("executor")
    if isinstance(raw_block, dict):
        block.update({k: raw_block[k] for k in EXECUTOR_DEFAULTS if k in raw_block})
    block["max_concurrent"] = max(1, min(8, int(block["max_concurrent"])))
    block["worktree_per_request"] = bool(block["worktree_per_request"])
    return block


def rhythm_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """E25-a (ORPHAN-710) — typed accessor for the rhythm block
    (circuit_breaker_policy pattern: the accessor is what makes the block
    real configuration)."""
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        raw = json.loads(
            (Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(RHYTHM_DEFAULTS)
    raw_block = merged.get("rhythm")
    if isinstance(raw_block, dict):
        block.update({k: raw_block[k] for k in RHYTHM_DEFAULTS if k in raw_block})
    return block


WATCHDOG_PULL_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    # None → disclosed skip (source_unconfigured). The URL is machine-local
    # (a docker-bridge address on the droplet), so it lives in the operator
    # override, never in a tracked default.
    "observability_base_url": None,
    # The API key itself NEVER enters policy or ledgers — only the NAME of
    # the environment variable the runner exports.
    "api_key_env": "ARIA_OBSERVABILITY_API_KEY",
    "http_5xx_share_threshold": 0.05,
    "http_min_requests": 50,
}


def watchdog_pull_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """E24-a (ORPHAN-711) — typed accessor for the watchdog_pull block
    (circuit_breaker_policy pattern)."""
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        raw = json.loads(
            (Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(WATCHDOG_PULL_DEFAULTS)
    raw_block = merged.get("watchdog_pull")
    if isinstance(raw_block, dict):
        block.update({k: raw_block[k] for k in WATCHDOG_PULL_DEFAULTS if k in raw_block})
    return block


GENESIS_LIFECYCLE_DEFAULTS: dict[str, Any] = {
    "pressure_min_score": 70,
    "min_evidence_refs": 3,
    "existing_capability_coverage_threshold": 0.80,
    # Y8 (ORPHAN-709) — how the REQUEST transition is approved. "panel"
    # (default, operator directive 2026-08-17): a resolved genesis_candidate
    # panel adjudication satisfies the gate; "operator" forces the signed
    # operator-feedback ref everywhere. The OLD key
    # (request_requires_signed_operator_feedback) was doubly dead: the
    # validator hardcoded the check and read no policy — İ2 closes both.
    "request_approval_mode": "panel",
    "real_sandbox_min_fixture_results": 3,
    "real_sandbox_required_lanes": [
        "real_repo_baseline",
        "semantic_regression",
        "scope_violation_guard",
    ],
    "shadow_min_days": 14,
    "shadow_min_clean_cycles": 5,
    "shadow_min_eval_runs": 10,
    "min_precision": 0.95,
    "min_recall": 0.90,
    "max_critical_false_positives": 0,
    "max_noncritical_false_positives_30d": 3,
    "max_result_rejection_rate": 0.05,
    "max_bridge_permanent_failures": 0,
}


def genesis_lifecycle_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        raw = json.loads(
            (Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(GENESIS_LIFECYCLE_DEFAULTS)
    raw_block = merged.get("genesis_lifecycle")
    if isinstance(raw_block, dict):
        for key, default in GENESIS_LIFECYCLE_DEFAULTS.items():
            if key in raw_block:
                block[key] = raw_block[key]
    return block


# ORPHAN-MEDIUM-468 — circuit_breaker was the ONLY nested policy block without
# a typed accessor + defaults dict, and that absence is what made a rename here
# dangerous. merge_with_override is a SHALLOW top-level merge: an operator file
# containing {"circuit_breaker": {...}} REPLACES the default block wholesale, so
# any key the operator omits silently reverts to a hardcoded fallback deep in
# the reading module, with no warning and no validation. Renaming a key under
# that regime would have discarded a deployed override in silence.
#
# The window is now a policy value rather than a constant baked into a name.
# 72h, not 24h: the nightly fires on cron '0 1 * * *', so a 24h window equalled
# the producer cadence exactly and a prior night's failure sat on the boundary —
# whether it still counted depended on where inside each run the failure landed,
# i.e. on scheduler jitter rather than on how many failures there were. A window
# strictly longer than the cadence makes cross-cycle accumulation deterministic:
# three consecutive bad nights trip, and that is a property of the failures, not
# of the clock.
# The nightly producer's cadence (cron '0 1 * * *'). Declared so the failure
# window is DERIVED from it rather than written as a literal in two places.
NIGHTLY_CADENCE_HOURS: int = 24
_DEFAULT_FAILURE_THRESHOLD: int = 3


def minimum_window_hours(threshold: int, cadence_hours: int = NIGHTLY_CADENCE_HOURS) -> int:
    """Smallest failure window that survives the one-per-night bleed.

    ORPHAN-MEDIUM-483 — the first fix for 468 replaced a hardcoded 24 with a
    hardcoded 72 and asserted `window > 24`, i.e. window > CADENCE. Wrong
    relationship, and 72 is exactly the boundary for threshold 3: failures land
    at t=0/24/48, but the breaker is read at the NEXT night's gate (t=72), where
    a 72h window spans [0, 72] and the oldest failure sits precisely on the edge
    — so ±30min of cron jitter flips the verdict. The requirement is
    window > threshold x cadence.

    This lives in genesis_policy, not circuit_breaker, because the value was
    duplicated: CIRCUIT_BREAKER_DEFAULTS carried its own 72 while
    circuit_breaker carried another. circuit_breaker imports genesis_policy, so
    the derivation belongs at this level and is imported upward — one literal,
    not two that can drift.
    """
    threshold = max(1, int(threshold))
    cadence = max(1, int(cadence_hours))
    return threshold * cadence + cadence


CIRCUIT_BREAKER_DEFAULTS: dict[str, Any] = {
    "failure_threshold": _DEFAULT_FAILURE_THRESHOLD,
    "failure_window_hours": minimum_window_hours(_DEFAULT_FAILURE_THRESHOLD),
    "auto_downgrade_to": "strict",
}

# Keys that were renamed, mapped to their replacement. Presence of one of these
# in an operator override is an ERROR, not a silent no-op: the whole reason the
# rename is safe is that a stale key is reported instead of ignored.
CIRCUIT_BREAKER_LEGACY_KEYS: dict[str, str] = {
    "threshold_24h": "failure_threshold",
}


def circuit_breaker_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """ORPHAN-MEDIUM-468 — typed accessor for the circuit_breaker block.

    Mirrors genesis_lifecycle_policy / auto_promote_policy /
    skill_genesis_drainer_policy so circuit_breaker stops being the one block
    read by hand.

    Raises GovernanceError when an override still carries a renamed key.
    Failing loudly is the point: under the shallow merge an operator who wrote
    ``threshold_24h: 10`` and upgraded would otherwise run on the default 3 and
    be told nothing. A deployed aria-config/genesis_policy.json is untracked, so
    the repo cannot migrate it — the only place the operator can learn is here.
    """
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        raw = json.loads(
            (Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(CIRCUIT_BREAKER_DEFAULTS)
    raw_block = merged.get("circuit_breaker")
    if isinstance(raw_block, dict):
        from .tool_registry import GovernanceError

        stale = sorted(k for k in CIRCUIT_BREAKER_LEGACY_KEYS if k in raw_block)
        if stale:
            renames = ", ".join(f"{k} -> {CIRCUIT_BREAKER_LEGACY_KEYS[k]}" for k in stale)
            raise GovernanceError(
                "genesis_policy_renamed_circuit_breaker_key: "
                f"{renames}. The value under the old name is NOT applied — the "
                "policy merge replaces the whole circuit_breaker block, so the "
                "breaker would silently run on defaults. Rename the key in your "
                "genesis_policy.json override."
            )
        for key, _default in CIRCUIT_BREAKER_DEFAULTS.items():
            if key in raw_block:
                block[key] = raw_block[key]
        operator_set_window = "failure_window_hours" in raw_block
    else:
        operator_set_window = False

    # RC-4, and this is the defect the plan did not name. The window in
    # CIRCUIT_BREAKER_DEFAULTS is `minimum_window_hours(3)` — a constant
    # computed at import time for the DEFAULT threshold. The policy merge is
    # shallow, so an operator who raised `failure_threshold` to 10 and wrote no
    # window inherited 96, which is the floor for threshold 3 and far below the
    # 264 their own threshold requires. The breaker then ran on a window too
    # narrow to hold their failures, silently. Deriving from the EFFECTIVE
    # threshold makes raising the threshold raise the window with it, which is
    # the only relationship that was ever intended.
    if not operator_set_window:
        try:
            effective_threshold = int(block.get("failure_threshold", _DEFAULT_FAILURE_THRESHOLD))
        except (TypeError, ValueError):
            effective_threshold = _DEFAULT_FAILURE_THRESHOLD
        block["failure_window_hours"] = minimum_window_hours(effective_threshold)

    _assert_window_above_floor(block)
    return block


def _assert_window_above_floor(block: dict[str, Any]) -> None:
    """RC-4 — refuse a window below the derived floor instead of widening it.

    ``circuit_breaker._breaker_policy`` used to silently raise any below-floor
    value to ``minimum_window_hours(threshold)``. Two costs, and the second is
    the one that matters:

    * the shipped default carried the literal 72 while the code ran on 96, so
      ``genesis_policy_default.json`` documented a number the loader refused to
      honour — the file is now the only place the value is NOT written, because
      it is derived;
    * an operator who wrote 72 was told nothing. Silently correcting someone's
      number teaches them something false about their own system, which is the
      same class as a green test over a dead control: the machine is right and
      the human's model of it is wrong, with nothing to reconcile them.

    Validation lives here rather than in ``circuit_breaker`` so the block has
    exactly one gate, next to the renamed-key refusal that already guards it.
    """
    from .tool_registry import GovernanceError

    try:
        threshold = int(block.get("failure_threshold", _DEFAULT_FAILURE_THRESHOLD))
    except (TypeError, ValueError) as exc:
        raise GovernanceError(
            "genesis_policy_circuit_breaker_failure_threshold_not_an_integer: "
            f"{block.get('failure_threshold')!r}"
        ) from exc

    floor = minimum_window_hours(threshold)
    raw_window = block.get("failure_window_hours", floor)
    try:
        window = int(raw_window)
    except (TypeError, ValueError) as exc:
        raise GovernanceError(
            "genesis_policy_circuit_breaker_failure_window_hours_not_an_integer: "
            f"{raw_window!r}"
        ) from exc

    if window < floor:
        raise GovernanceError(
            "genesis_policy_circuit_breaker_window_below_floor: "
            f"failure_window_hours={window} is narrower than the derived minimum "
            f"{floor} for failure_threshold={threshold} "
            f"(threshold x {NIGHTLY_CADENCE_HOURS}h cadence + {NIGHTLY_CADENCE_HOURS}h). "
            "A narrower window puts the oldest failure on the window edge at the "
            "next gate, so cron jitter decides whether the breaker trips. Remove "
            "the key to take the derived value, or widen it to at least the "
            "minimum above."
        )
    block["failure_window_hours"] = window


SKILL_GENESIS_DRAINER_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "max_authorings_per_cycle": 3,
    "max_tokens_per_cycle": 50_000,
    "estimated_tokens_per_authoring": 30_000,
}


def skill_genesis_drainer_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Plan ARIA-V7 §2h v2 (U-2 resolution) — V7.4 drainer policy accessor.

    Returns the skill_genesis_drainer block with defaults filled in
    for any missing fields. Mirrors V6's ``auto_promote_policy`` pattern.
    """
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        from pathlib import Path as _P
        import json as _json
        raw = _json.loads(
            (_P(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(SKILL_GENESIS_DRAINER_DEFAULTS)
    raw_block = merged.get("skill_genesis_drainer")
    if isinstance(raw_block, dict):
        for key, default in SKILL_GENESIS_DRAINER_DEFAULTS.items():
            if key in raw_block:
                block[key] = raw_block[key]
    return block


AUTO_PROMOTE_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "min_precision": 0.95,
    "min_clean_cycles": 5,
    "profiles": ["autonomous"],
}


# Z3d — EVAL_WINDOW → ACTIVE superiority gate knobs (genesis_superiority).
# `min_duel_matches`: decided duels required before the Bradley-Terry
# component is evaluated at all; below it, the measured eval-window verdict
# alone decides (a thin duel ledger must not block the lane that feeds it).
SUPERIORITY_DEFAULTS: dict[str, Any] = {
    "min_duel_matches": 3,
    "window_days": 30,
}


def superiority_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Resolve the Z3d superiority block with defaults (auto_promote pattern)."""
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        merged = {}
    block = dict(SUPERIORITY_DEFAULTS)
    raw_block = merged.get("superiority")
    if isinstance(raw_block, dict):
        for key in SUPERIORITY_DEFAULTS:
            if key in raw_block:
                block[key] = raw_block[key]
    return block


def auto_promote_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Plan ARIA-V6 §2e v2 — resolve auto_promote settings with defaults.

    Returns the auto_promote block from the merged policy, falling
    back to ``AUTO_PROMOTE_DEFAULTS`` for any missing fields. Always
    returns a dict with the four required keys so callers can do
    ``if policy['enabled']:`` without ``.get`` plumbing.
    """
    if repo_root is not None:
        merged = load_policy(repo_root)
    else:
        # Use default policy when no repo_root supplied — auto_promote
        # block is read from the package-shipped default JSON file.
        from pathlib import Path as _P
        import json as _json
        raw = _json.loads(
            (_P(__file__).resolve().parent / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        merged = raw if isinstance(raw, dict) else {}
    block = dict(AUTO_PROMOTE_DEFAULTS)
    raw_block = merged.get("auto_promote")
    if isinstance(raw_block, dict):
        for key, default in AUTO_PROMOTE_DEFAULTS.items():
            if key in raw_block:
                block[key] = raw_block[key]
    return block

DEFAULT_FILENAME = "genesis_policy_default.json"
OVERRIDE_RELPATH = "aria-config/genesis_policy.json"


def default_policy() -> dict[str, Any]:
    """Return the package-shipped default policy.

    Why: Phase-4.1 needs a deterministic baseline so missing operator override
    does not silently disable genesis hooks. Defaults keep the loop ON.
    """
    path = Path(__file__).resolve().parent / "data" / DEFAULT_FILENAME
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {key: raw[key] for key in POLICY_KEYS if key in raw}


def load_policy(repo_root: str | Path) -> dict[str, Any]:
    """Merge package defaults with optional operator override.

    Layer 1: aria-kernel/aria_kernel/data/genesis_policy_default.json (always present).
    Layer 2: <repo_root>/aria-config/genesis_policy.json (optional operator override).

    Missing override → defaults only (fail-soft, never disables genesis without intent).
    Unknown override keys are ignored (forward-compat).
    """
    defaults = default_policy()
    override_path = Path(repo_root) / OVERRIDE_RELPATH
    if not override_path.exists():
        return defaults
    try:
        raw = json.loads(override_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return defaults
    if not isinstance(raw, dict):
        return defaults
    return merge_with_override(defaults, raw)


def merge_with_override(defaults: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Override-wins merge restricted to known POLICY_KEYS."""
    merged = dict(defaults)
    for key, value in override.items():
        if key in POLICY_KEYS:
            merged[key] = value
    return merged
