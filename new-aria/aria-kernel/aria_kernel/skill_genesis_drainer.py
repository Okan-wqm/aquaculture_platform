"""Plan ARIA-V7 §2h v2 Phase 7.4 — skill_genesis_drainer.

V6.2's ``run_convergent_authoring`` exists + is fully tested but
has zero production callers. ``request_skill_genesis(convergent=True,
seed=...)`` mints rows in ``skill-genesis/requests.jsonl`` that no
consumer reads. V7.4 wires the producer-side orchestrator phase that
polls those rows + dispatches each via ``run_convergent_authoring``.

Architecture (Plan ARIA-V7 §2h v2):

  * Drainer is a Tier-1 REQUIRED kwarg on
    ``run_autonomy_orchestrator`` (mirrors V5/V6 §A1 precedent).
  * Drainer phase fires AFTER ``bridge_drained`` and BEFORE the
    convergence_runner invocation (so authoring on cycle N feeds
    cycle N+1's convergence target).
  * Status updates use the derived-state pattern (mirrors
    ``agent_invocations.derive_request_state``): NEW
    ``skill-genesis/request-status.jsonl`` ledger holds append-only
    patch rows; drainer filters by reading latest patch per
    request_id. NO mutation of original requests.jsonl row.
  * Crash inside ``run_convergent_authoring`` → ``_persist_status``
    writes ``status=authoring_error`` BEFORE re-raise (no infinite
    retry loop on deterministic crash).
  * Per-cycle token budget cap: ``tokens_spent_this_cycle`` checked
    against ``policy.skill_genesis_drainer.max_tokens_per_cycle``
    (default 50K) BEFORE each ``run_convergent_authoring`` call.
  * Deterministic order: candidates sorted by ``recorded_at`` ASC
    (replay-stable).

Operator vision principle "yama yok, kor birakma yok" honored:

  * Every cycle produces an explicit ``aggregate_verdict`` (no
    silent skip).
  * Crash → status persisted + re-raised (no swallowed exception).
  * Token cap enforced BEFORE dispatch (no budget surprise).
  * Source-substring invariants pin the literal status helper +
    try/except envelope.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable, Literal, Protocol, TypedDict

from .convergent_skill_authoring import run_convergent_authoring
from .ledger import append_declared_jsonl, load_jsonl
from .strict_jsonl_reader import read_strict_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


__all__ = [
    "SkillGenesisDrainResult",
    "SkillGenesisDrainer",
    "run_skill_genesis_drainer",
    "select_skill_genesis_drainer",
]


# Plan ARIA-V7 §2h v2 — terminal status values that mark a request
# "already terminal" (drainer skips it on subsequent cycles).
_TERMINAL_STATUSES: frozenset[str] = frozenset({
    "authored_validated",
    "authored_max_rounds",
    "authoring_arbiter_split",
    "authoring_insufficient_evidence",
    "sandbox_systematic_failure",
    "evidence_hallucination_detected",
    "evidence_base_drift",
    "mutual_hallucination_check_failed",
    "authoring_error",
})


# Plan ARIA-V7 §2h v2 — token cost estimate per authoring (operator-
# tunable via policy). Used by the budget cap gate BEFORE invocation.
_DEFAULT_ESTIMATED_TOKENS_PER_AUTHORING = 30_000


class SkillGenesisDrainResult(TypedDict):
    """Plan ARIA-V7 §2h v2 — drainer return contract."""

    cycle_id: str
    requests_scanned: int
    requests_dispatched: int
    requests_skipped_corpus_missing: int
    requests_skipped_evidence_insufficient: int
    requests_skipped_already_terminal: int
    requests_skipped_token_budget: int
    requests_skipped_non_convergent: int
    authoring_results: list[dict[str, Any]]
    tokens_spent_this_cycle: int
    aggregate_verdict: Literal[
        "no_requests",
        "dispatched_clean",
        "dispatched_mixed",
        "drainer_disabled",
        "dispatchers_unavailable",
        "token_budget_exceeded",
        "authoring_error_present",
    ]


class SkillGenesisDrainer(Protocol):
    """Plan ARIA-V7 §2h v2 — injection-seam contract."""

    def __call__(
        self,
        *,
        cycle_id: str,
        base_dir: Path,
        workspace_root: Path | None,
        profile: str,
        primary_drafter: Callable[..., dict[str, Any]],
        challenger_drafter: Callable[..., dict[str, Any]],
        evidence_judge: Callable[..., dict[str, Any]],
        adversarial_judge: Callable[..., dict[str, Any]],
        sandbox_runner: Callable[..., dict[str, Any]],
        max_authorings_per_cycle: int = 3,
        max_tokens_per_cycle: int = 50_000,
        estimated_tokens_per_authoring: int = _DEFAULT_ESTIMATED_TOKENS_PER_AUTHORING,
    ) -> SkillGenesisDrainResult: ...


def run_skill_genesis_drainer(
    *,
    cycle_id: str,
    base_dir: str | Path,
    workspace_root: str | Path | None,
    profile: str,
    primary_drafter: Callable[..., dict[str, Any]],
    challenger_drafter: Callable[..., dict[str, Any]],
    evidence_judge: Callable[..., dict[str, Any]],
    adversarial_judge: Callable[..., dict[str, Any]],
    sandbox_runner: Callable[..., dict[str, Any]],
    max_authorings_per_cycle: int = 3,
    max_tokens_per_cycle: int = 50_000,
    estimated_tokens_per_authoring: int = _DEFAULT_ESTIMATED_TOKENS_PER_AUTHORING,
) -> SkillGenesisDrainResult:
    """Plan ARIA-V7 §2h v2 — default Tier-1 drainer.

    Workflow (per cycle):
      1. Read genesis_policy.skill_genesis_drainer.enabled; if False
         → return drainer_disabled (no work).
      2. Read all rows from skill-genesis/requests.jsonl.
      3. Filter: convergent=True AND _latest_status == "requested".
      4. Sort by recorded_at ASC (deterministic, replay-stable).
      5. Cap at max_authorings_per_cycle.
      6. For each candidate:
         a. Token budget gate: tokens_spent_this_cycle + estimate >
            max_tokens_per_cycle → persist status=skipped_token_budget
            + continue.
         b. Corpus sanity check (V7.5 — handled in C5; this
            commit's drainer just dispatches).
         c. try/except around run_convergent_authoring:
            * Exception → persist status=authoring_error + re-raise
              (no infinite retry on deterministic crash).
            * Success → persist status=<authoring_verdict> +
              accumulate result.
      7. Compute aggregate_verdict + return.
    """
    root = ensure_tools_dir(base_dir)
    result: SkillGenesisDrainResult = {
        "cycle_id": cycle_id,
        "requests_scanned": 0,
        "requests_dispatched": 0,
        "requests_skipped_corpus_missing": 0,
        "requests_skipped_evidence_insufficient": 0,
        "requests_skipped_already_terminal": 0,
        "requests_skipped_token_budget": 0,
        "requests_skipped_non_convergent": 0,
        "authoring_results": [],
        "tokens_spent_this_cycle": 0,
        "aggregate_verdict": "no_requests",
    }

    # Policy gate.
    if not _drainer_enabled(base_dir):
        result["aggregate_verdict"] = "drainer_disabled"
        return result

    # Load requests.
    requests_path = root / "skill-genesis" / "requests.jsonl"
    if not requests_path.exists():
        return result
    rows = load_jsonl(requests_path)
    result["requests_scanned"] = len(rows)

    # Filter convergent rows with non-terminal status.
    candidates: list[dict[str, Any]] = []
    for row in rows:
        if not row.get("convergent"):
            result["requests_skipped_non_convergent"] += 1
            continue
        latest = _latest_status(row.get("request_id", ""), base_dir)
        if latest in _TERMINAL_STATUSES:
            result["requests_skipped_already_terminal"] += 1
            continue
        if latest != "requested":
            # Some intermediate status (e.g., skipped_corpus_missing
            # from a prior cycle) — re-check this cycle so operator
            # adding corpus picks it up.
            pass
        candidates.append(row)

    # Deterministic order.
    candidates.sort(key=lambda r: r.get("recorded_at", ""))
    candidates = candidates[:max_authorings_per_cycle]

    # Dispatch.
    authoring_error_present = False
    for req in candidates:
        # Token budget gate (Plan §2h v2 B-V3-3).
        if (result["tokens_spent_this_cycle"]
                + estimated_tokens_per_authoring
                > max_tokens_per_cycle):
            _persist_status(
                req.get("request_id", ""),
                "skipped_token_budget", base_dir,
                reason=(
                    f"tokens_spent_this_cycle={result['tokens_spent_this_cycle']} "
                    f"+ estimate={estimated_tokens_per_authoring} > "
                    f"max_tokens_per_cycle={max_tokens_per_cycle}"
                ),
            )
            result["requests_skipped_token_budget"] += 1
            continue

        request_id = req.get("request_id", "")
        seed = req.get("seed") or {}

        # Plan ARIA-V7 §2h v2 Phase 7.5 — corpus-aware pre-flight
        # with evidence-pack fallback (chicken-and-egg break).
        #
        # Workflow:
        #   1. If corpus is sane (V6.2 B-V2-2 validator passes) →
        #      proceed to standard authoring.
        #   2. Else, fallback: collect_evidence_pack on declared_scope
        #      + claim_types. If >=10 real observations → mark
        #      seed with corpus_proxy="evidence_pack" + proceed.
        #      Operator labels the authored adapter's predictions
        #      post-authoring (corpus chicken-and-egg broken).
        #   3. Else, persist status=skipped_evidence_insufficient +
        #      continue (operator-visible; NO crash, NO silent skip).
        corpus_proxy = None
        corpus_path_str = seed.get("calibration_corpus_path", "")
        if corpus_path_str:
            from .skill_genesis import validate_calibration_corpus_sanity
            sanity = validate_calibration_corpus_sanity(
                corpus_path=corpus_path_str,
            )
            if sanity.get("status") != "ok":
                # Corpus missing or malformed; try evidence-pack fallback.
                from .evidence_collector import (
                    InsufficientEvidenceError,
                    collect_evidence_pack,
                )
                try:
                    collect_evidence_pack(
                        seed_id=seed.get("seed_id", request_id),
                        declared_scope=list(seed.get("declared_scope") or []),
                        claim_types=list(seed.get("claim_types") or []),
                        workspace_root=workspace_root or Path.cwd(),
                        base_dir=base_dir,
                        persist=False,
                    )
                    corpus_proxy = "evidence_pack"
                except (InsufficientEvidenceError, ValueError):
                    _persist_status(
                        request_id, "skipped_evidence_insufficient", base_dir,
                        reason=(
                            f"corpus_status={sanity.get('status')}; "
                            f"evidence_pack collection failed"
                        ),
                    )
                    result["requests_skipped_evidence_insufficient"] += 1
                    continue
        # Plan ARIA-V7 §2h v2 (I-V7.4-08) — crash-catch envelope.
        # Source-substring invariant pins the literal try/except.
        try:
            authoring_result = run_convergent_authoring(
                request_id=request_id,
                seed=seed,
                workspace_root=workspace_root or Path.cwd(),
                base_dir=base_dir,
                primary_drafter=primary_drafter,
                challenger_drafter=challenger_drafter,
                evidence_judge=evidence_judge,
                adversarial_judge=adversarial_judge,
                sandbox_runner=sandbox_runner,
            )
        except Exception as _v7_exc:
            _persist_status(
                request_id, "authoring_error", base_dir,
                reason=f"{type(_v7_exc).__name__}: {str(_v7_exc)[:500]}",
            )
            raise

        _persist_status(
            request_id,
            str(authoring_result.get("authoring_verdict", "unknown")),
            base_dir,
            reason=(f"corpus_proxy={corpus_proxy}" if corpus_proxy else ""),
        )
        if corpus_proxy:
            # Plan ARIA-V7 §3 Phase 7.5 (B-V2-1) — surface
            # corpus_proxy in result so operator sees authoring used
            # evidence-pack-only (no labeled corpus); SHADOW
            # promotion is gated until operator labels output.
            authoring_result["corpus_proxy"] = corpus_proxy
        result["tokens_spent_this_cycle"] += estimated_tokens_per_authoring
        result["authoring_results"].append(authoring_result)
        result["requests_dispatched"] += 1
        if authoring_result.get("authoring_verdict") == "authoring_error":
            authoring_error_present = True

    # Aggregate verdict.
    if result["requests_dispatched"] == 0:
        if (result["requests_skipped_already_terminal"] > 0
                or result["requests_skipped_non_convergent"] > 0):
            result["aggregate_verdict"] = "no_requests"
        elif result["requests_skipped_token_budget"] > 0:
            result["aggregate_verdict"] = "token_budget_exceeded"
        else:
            result["aggregate_verdict"] = "no_requests"
    elif authoring_error_present:
        result["aggregate_verdict"] = "authoring_error_present"
    else:
        verdicts = {
            ar.get("authoring_verdict")
            for ar in result["authoring_results"]
        }
        if len(verdicts) == 1 and "authored_validated" in verdicts:
            result["aggregate_verdict"] = "dispatched_clean"
        else:
            result["aggregate_verdict"] = "dispatched_mixed"

    return result


def select_skill_genesis_drainer(profile: str = "standard") -> SkillGenesisDrainer:
    """Plan ARIA-V7 §2h v2 — production factory.

    Returns the default ``run_skill_genesis_drainer`` regardless of
    profile (V6 §A1 pattern). Profile is consumed INTERNALLY by the
    drainer for policy decisions; this factory is the injection seam.
    """
    return run_skill_genesis_drainer


# ---------------------------------------------------------------------
# Derived-state helpers (Plan ARIA-V7 §2h v2 B-V3-1)
# ---------------------------------------------------------------------


def _persist_status(
    request_id: str,
    status: str,
    base_dir: str | Path | None,
    reason: str = "",
) -> dict[str, Any]:
    """Plan ARIA-V7 §2h v2 — append patch row to request-status.jsonl.

    Status mutation is FORBIDDEN; this function ONLY appends a new
    patch row. Drainer reads latest patch per request_id via
    ``_latest_status``.
    """
    if not request_id:
        raise GovernanceError("persist_status_requires_request_id")
    root = ensure_tools_dir(base_dir)
    path = root / "skill-genesis" / "request-status.jsonl"
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "request_id": request_id,
        "status": status,
        "reason": reason,
    }
    return append_declared_jsonl(path, row, expected_surface="skill_genesis_request_status")


def _latest_status(
    request_id: str,
    base_dir: str | Path | None,
) -> str:
    """Plan ARIA-V7 §2h v2 (I-V7.4-07) — derived-state status reader.

    Reads latest patch row per request_id from
    ``skill-genesis/request-status.jsonl``. Falls back to the
    original ``requests.jsonl`` row's ``status`` field when no patch
    exists (initial status from request_skill_genesis).

    Pinned by I-V7.4-07 source-substring invariant — refactor that
    drops or renames this function silently re-introduces in-place
    status mutation (which the V6 ledger contract forbids).
    """
    if not request_id:
        return ""
    root = ensure_tools_dir(base_dir)
    status_path = root / "skill-genesis" / "request-status.jsonl"
    latest_status = ""
    if status_path.exists():
        for row in read_strict_jsonl(status_path, on_corruption="tolerant"):
            if row.get("request_id") == request_id:
                latest_status = str(row.get("status", ""))
    if latest_status:
        return latest_status
    # Fallback to original requests.jsonl row.status field.
    requests_path = root / "skill-genesis" / "requests.jsonl"
    if not requests_path.exists():
        return ""
    rows = load_jsonl(requests_path)
    for row in rows:
        if row.get("request_id") == request_id:
            return str(row.get("status", "requested"))
    return ""


def _drainer_enabled(base_dir: str | Path | None) -> bool:
    """Plan ARIA-V7 §2h v2 (U-2 resolution) — policy gate.

    Reads ``genesis_policy.skill_genesis_drainer.enabled`` (default
    True if missing — fail-OPEN so existing installs continue to
    drain). Operator opts out by setting enabled=false in the
    aria-config override.
    """
    try:
        from .genesis_policy import skill_genesis_drainer_policy
        policy = skill_genesis_drainer_policy(repo_root=base_dir)
        return bool(policy.get("enabled", True))
    except Exception:
        # Fail-OPEN so missing policy doesn't silently disable the
        # drainer (operator visibility via reflection telemetry
        # surfaces the policy gap).
        return True


# =============================================================================
# Plan ARIA-V10.2 — pattern_signature stability trigger + HUMAN_REQUIRED gate
# =============================================================================
#
# Closes:
#   * arb CRIT-007 — skill genesis trigger uses stable pattern_signature
#     (V9.4 compute_pattern_signature) — false-positive prevented by
#     cardinality guard (MIN_EVIDENCE_REF_CARDINALITY = 5)
#   * ai MED-015 — N>=5 threshold + 2 distinct pressure_source types +
#     distinct cross_reviewer_agent_ids prevent supply-chain collusion
#   * sec CRIT-006 — authored adapter runs under V9.0-E sandbox
#     (execute_in_sandbox); aria-tools/registry.json write
#     routes HUMAN_REQUIRED


# Plan ARIA-V10.2 — N>=5 consecutive CONVERGED cycles + 2 distinct
# pressure_source types + 2 distinct cross_reviewer_agent_ids required
# for skill-genesis trigger (ai MED-015 raised from v1's N=3).
PATTERN_SIGNATURE_TRIGGER_MIN_CYCLES: int = 5
PATTERN_SIGNATURE_TRIGGER_MIN_DISTINCT_SOURCES: int = 2
PATTERN_SIGNATURE_TRIGGER_MIN_DISTINCT_REVIEWERS: int = 2


def check_pattern_signature_stability(
    *,
    pattern_signature: str,
    governance_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Plan ARIA-V10.2 — pattern_signature stability check.

    Walks ``governance_rows`` in reverse-chronological order (caller
    pre-sorts). Returns a dict with:
      * ``stable: bool``
      * ``matching_cycles: list[str]``
      * ``distinct_pressure_source_types: list[str]``
      * ``distinct_cross_reviewer_agent_ids: list[str]``
      * ``reason: str``  (when stable=False)

    Stability fires when ALL three thresholds met:
      * matching_cycles >= PATTERN_SIGNATURE_TRIGGER_MIN_CYCLES (5)
      * distinct_pressure_source_types >= 2
      * distinct_cross_reviewer_agent_ids >= 2

    The thresholds prevent:
      * False positive from a single LLM convergence-by-construction
        (5 cycles minimum)
      * Echo-chamber collusion across cycles with same reviewer
        (distinct reviewers required)
      * Single-source bias (distinct source types required)
    """
    if not isinstance(pattern_signature, str) or not pattern_signature.startswith("sha256:"):
        return {
            "stable": False,
            "reason": "invalid_pattern_signature_format",
            "matching_cycles": [],
            "distinct_pressure_source_types": [],
            "distinct_cross_reviewer_agent_ids": [],
        }

    matching_cycles: list[str] = []
    sources: set[str] = set()
    reviewers: set[str] = set()
    consecutive_break = False

    for row in governance_rows:
        if consecutive_break:
            break
        terminal = row.get("terminal_state")
        if terminal != "CONVERGED":
            # Stop walking on first non-CONVERGED (lookback bounded by
            # consecutive-streak); skill-genesis triggers only on a
            # STREAK of converged cycles, not 5 out of any window.
            consecutive_break = True
            continue
        sig = row.get("pattern_signature")
        if sig != pattern_signature:
            consecutive_break = True
            continue
        cycle_id = row.get("cycle_id")
        if cycle_id:
            matching_cycles.append(str(cycle_id))
        src = row.get("pressure_source_type")
        if src:
            sources.add(str(src))
        rev = row.get("cross_reviewer_agent_id")
        if rev:
            reviewers.add(str(rev))

    n_cycles = len(matching_cycles)
    n_sources = len(sources)
    n_reviewers = len(reviewers)

    if n_cycles < PATTERN_SIGNATURE_TRIGGER_MIN_CYCLES:
        return {
            "stable": False,
            "reason": f"only_{n_cycles}_matching_cycles_need_{PATTERN_SIGNATURE_TRIGGER_MIN_CYCLES}",
            "matching_cycles": matching_cycles,
            "distinct_pressure_source_types": sorted(sources),
            "distinct_cross_reviewer_agent_ids": sorted(reviewers),
        }
    if n_sources < PATTERN_SIGNATURE_TRIGGER_MIN_DISTINCT_SOURCES:
        return {
            "stable": False,
            "reason": f"only_{n_sources}_distinct_pressure_sources_need_{PATTERN_SIGNATURE_TRIGGER_MIN_DISTINCT_SOURCES}",
            "matching_cycles": matching_cycles,
            "distinct_pressure_source_types": sorted(sources),
            "distinct_cross_reviewer_agent_ids": sorted(reviewers),
        }
    if n_reviewers < PATTERN_SIGNATURE_TRIGGER_MIN_DISTINCT_REVIEWERS:
        return {
            "stable": False,
            "reason": f"only_{n_reviewers}_distinct_reviewers_need_{PATTERN_SIGNATURE_TRIGGER_MIN_DISTINCT_REVIEWERS}",
            "matching_cycles": matching_cycles,
            "distinct_pressure_source_types": sorted(sources),
            "distinct_cross_reviewer_agent_ids": sorted(reviewers),
        }
    # Plan ARIA-V3.1-C-4 — OPERATOR_FEEDBACK ∈ distinct sources guard
    # (closes 6-validator audit MEDIUM-011 + ai-safety HIGH-005 on
    # skill-genesis activation). Stability fires only when at least
    # ONE of the recurring cycles was driven by signed operator
    # feedback — the operator is the trust anchor that validates the
    # convergent pattern. Combined with V3.1-A-2 sanitize_untrusted_text
    # + V9.4 signature verification on operator-feedback rows, this
    # raises the adversarial-collusion bar significantly: a malicious
    # planner that fakes 5 CONVERGED cycles with the same
    # pattern_signature still cannot trigger skill genesis without
    # operator feedback signed by the pinned operator key.
    if "operator_feedback" not in sources:
        return {
            "stable": False,
            "reason": "operator_feedback_source_required_for_skill_genesis_stability",
            "matching_cycles": matching_cycles,
            "distinct_pressure_source_types": sorted(sources),
            "distinct_cross_reviewer_agent_ids": sorted(reviewers),
        }
    return {
        "stable": True,
        "matching_cycles": matching_cycles,
        "distinct_pressure_source_types": sorted(sources),
        "distinct_cross_reviewer_agent_ids": sorted(reviewers),
    }
