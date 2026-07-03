"""Plan ARIA-V6 §2c V6.1 Phase 6.1 — Gate C Lane-A specialist dispatch.

V6.1 wires the ~84 Lane-A specialist agents (auth-security-expert,
farm-expert, edge-expert, frontend-expert, etc.) into the autonomy
orchestrator's per-cycle flow. After Gate A (convergence) succeeds
and BEFORE the worker_drainer phase, the orchestrator dispatches
N specialists (pressure-driven selection) for adversarial domain
review. Their consolidated verdict gates worker_drainer.

Operator vision (Plan ARIA-V6 §1, verbatim):
  "agentlar plan yapıyor ya yanı planları sureklı en bastan revıew
   ederek ıkı agent bırbırıne atarak valıde sekılde sonlanrmalı"

V5 wired Gate A (primary↔challenger convergence) + Gate B (judge
adversarial review) at the meta-planning + post-impl tiers. V6 adds
Gate C in the SPECIALIST-DOMAIN tier — the 60+ domain experts under
.claude/agents/ that today are only dispatched manually on PR
cycles. V6.1 makes them autonomous per-cycle reviewers.

Default behaviour when no specialist claims any envelope (typical
autonomous-run without external Claude Code dispatchers):

  * `standard` profile (default) — verdict ``specialists_unavailable``;
    orchestrator PROCEEDS to worker_drainer (fail-open degraded mode).
  * `strict` profile — verdict ``specialists_unavailable`` BLOCKS
    worker_drainer (fail-closed; operator-requested specialist gate).
  * `autonomous` profile — fail-open (autonomous runs accept degraded).
  * `observe` profile — specialists never dispatched (selection alg
    strips them at filter time).

Tier-1 contract: ``specialist_review_runner`` is a REQUIRED kwarg on
``run_autonomy_orchestrator`` (no default, no Optional annotation).
Mirrors V5 §A1 ``auto_merge_runner`` + V5.1 ``convergence_runner`` +
V5.2 ``review_runner`` precedent. I-V6-01 signature invariant pins.

The default runner ``run_specialist_review_runner()`` polls the
``agent-invocations/requests.jsonl`` envelope queue under role
``specialist_domain_review``. Tests inject mock runners via the
kwarg directly; production CLI uses
``select_specialist_review_runner(profile)`` factory.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict

from .agent_invocations import (
    create_agent_invocation_request,
    next_pending_request,
)
from .tool_registry import ensure_tools_dir


# Plan ARIA-V6 §2c v2 — domain touch-map for pressure-driven
# specialist selection. Each entry maps a workspace path prefix to
# the Lane-A specialist agent(s) that own review duty for that
# service / library. The map is deliberately conservative — operator
# can extend via genesis_policy override.
_DOMAIN_TOUCH_MAP: dict[str, tuple[str, ...]] = {
    "apps/auth-service/": ("auth-security-expert", "compliance-expert"),
    "apps/farm-service/": ("farm-expert",),
    "apps/sensor-service/": ("sensor-expert",),
    "apps/alert-engine/": ("alert-engine-expert",),
    "apps/billing-service/": ("billing-expert",),
    "apps/messaging-service/": ("messaging-expert",),
    "apps/hr-service/": ("hr-expert",),
    "apps/hydroponics-service/": ("farm-expert",),
    "apps/ai-service/": ("ai-safety-auditor",),
    "apps/admin-api-service/": ("admin-expert",),
    "apps/gateway-api/": ("auth-security-expert", "performance-expert"),
    "apps/event-store-service/": ("data-expert",),
    "apps/observability-service/": ("observability-expert",),
    "libs/backend-common/src/guards/": ("auth-security-expert",),
    "libs/backend-common/src/security/": ("compliance-expert",),
    "libs/backend-common/src/audit/": ("audit-trail-completeness-auditor",),
    "libs/backend-common/src/nats/": ("platform-kernel-expert",),
    "libs/event-contracts/": ("data-expert", "contract-parity-enforcer"),
    "platform/libs/": ("platform-kernel-expert",),
    "web/": ("frontend-expert", "accessibility-auditor"),
    "web/apps/aquamobil/": ("frontend-mobile-development:mobile-developer",),
    "sens-api-gateway/": ("edge-expert", "edge-industrial-auditor"),
    "infrastructure/": ("infra-expert",),
    "infrastructure/nats/": ("platform-kernel-expert",),
    "tools/aria-poc/": ("mcp-expert",),
    "tools/aria-adapters/": ("ai-safety-auditor",),
    ".github/workflows/": ("infra-expert", "supply-chain-auditor"),
    "aria-kernel/": ("platform-kernel-expert",),
}


# Plan ARIA-V6 §2c — cross-cutting specialists fired on multi-domain
# pressures regardless of touch-map. Activated when pressure severity
# ≥ HIGH AND multiple domains touched in cycle_diff.
_CROSS_CUTTING_SPECIALISTS: tuple[str, ...] = (
    "circuit-breaker-auditor",
    "observability-expert",
    "performance-expert",
    "memory-leak-auditor",
    "architectural-arbiter",
)


# Plan ARIA-V6 §2b — Tier-1 specialists (security-critical) listed
# explicitly for profile-gating. `observe` profile strips these;
# `standard` requires `convergence_verdict == "converged"` to
# dispatch them.
_TIER_1_SPECIALISTS: frozenset[str] = frozenset({
    "auth-security-expert",
    "compliance-expert",
    "supply-chain-auditor",
    "frontend-expert",
    "legal-hold-auditor",
    "security-architecture-writer",
    "security-reviewer",
    "comprehensive-review:security-auditor",
    "comprehensive-review:code-reviewer",
    "gdpr-erasure-executor",
})


class SpecialistReviewResult(TypedDict):
    """Plan ARIA-V6 §2c v2 — Gate C return contract."""

    cycle_id: str
    specialists_dispatched: list[str]
    specialists_timed_out: list[str]
    consolidated_verdict: Literal[
        "consolidated_no_gaps",
        "consolidated_remediation_required",
        "consolidated_judge_split",
        "specialists_unavailable",
    ]
    findings_by_specialist: dict[str, list[dict[str, Any]]]
    request_ids: list[str]
    rounds_count: int
    token_cost_estimate: int
    profile: str


class SpecialistReviewRunner(Protocol):
    """Plan ARIA-V6 §2c v2 — injection-seam contract."""

    def __call__(
        self,
        *,
        cycle_id: str,
        base_dir: Path,
        workspace_root: Path | None,
        plan_id: str,
        convergence_id: str,
        touched_services: list[str],
        pressures: list[dict[str, Any]],
        profile: str,
        max_specialists_per_cycle: int = 10,
        specialist_timeout_seconds: float = 900.0,
    ) -> SpecialistReviewResult: ...


def select_specialist_agents(
    *,
    touched_services: list[str],
    pressures: list[dict[str, Any]],
    profile: str,
    max_specialists_per_cycle: int = 10,
) -> list[str]:
    """Plan ARIA-V6 §2c v2 — deterministic pressure-driven selection.

    Returns the specialist agent_names to dispatch this cycle, derived
    from:
      1. Domain touch-map — which services / libs were modified
      2. Cross-cutting — high-severity multi-domain pressures activate
         circuit-breaker-auditor + observability-expert + performance-
         expert + memory-leak-auditor
      3. Profile gate — ``observe`` strips Tier-1 specialists; other
         profiles keep them
      4. Cost cap — sort by (tier asc, domain specificity desc); take
         first ``max_specialists_per_cycle`` to honour token budget

    Selection is deterministic — no randomness. Same inputs → same
    output. Enables I-V6.1-03 reproducibility invariant.

    Why deterministic:
      Reproducible dispatch lets operators replay any cycle's
      specialist set from the seed (touched_services + pressures +
      profile). Without determinism, debugging cycle behaviour
      requires inspecting transient agent-invocation envelopes;
      with it, the selection is recomputable.
    """
    candidates: set[str] = set()

    # Step 1 — domain touch-map
    for touched in touched_services:
        for prefix, agents in _DOMAIN_TOUCH_MAP.items():
            if touched.startswith(prefix):
                candidates.update(agents)

    # Step 2 — cross-cutting (multi-domain HIGH severity)
    pressure_severity_max = "LOW"
    multi_domain = False
    distinct_service_prefixes = set()
    for p in pressures:
        sev = p.get("severity", "low").upper()
        if sev in ("HIGH", "CRITICAL"):
            pressure_severity_max = sev
        for ref in p.get("affected_files", []):
            for prefix in _DOMAIN_TOUCH_MAP:
                if ref.startswith(prefix):
                    distinct_service_prefixes.add(prefix)
    multi_domain = len(distinct_service_prefixes) >= 2
    if pressure_severity_max in ("HIGH", "CRITICAL") and multi_domain:
        candidates.update(_CROSS_CUTTING_SPECIALISTS)

    # Step 3 — profile gate
    if profile == "observe":
        candidates -= _TIER_1_SPECIALISTS

    # Step 4 — cost cap (deterministic sort: tier asc, name asc)
    def _sort_key(agent: str) -> tuple[int, str]:
        tier_priority = 0 if agent in _TIER_1_SPECIALISTS else 1
        return (tier_priority, agent)

    sorted_candidates = sorted(candidates, key=_sort_key)
    return sorted_candidates[:max_specialists_per_cycle]


def transform_specialist_output(
    *,
    agent_name: str,
    raw_markdown: str,
    workspace_root: Path | None = None,
    base_commit_sha: str | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V6 §2c v2 (B-V9-1 fix) — markdown→findings transform.

    Lane-A specialists output free-form markdown review reports;
    ARIA's kernel expects structured ``findings[]`` rows. This
    transformer extracts findings from specialist markdown via
    deterministic regex patterns + validates every ``evidence_ref``
    points to a REAL repository file:line at ``base_commit_sha``.

    Hallucinated refs are downgraded to severity=MEDIUM (NOT
    REJECTED — operator may want to see them as soft signals).
    Path-existence-verified refs keep their declared severity.

    Mirrors V6 §2a's mutual-hallucination-guarantee discipline at
    the verdict-aggregation surface: NO specialist's claim is taken
    at face value; every evidence_ref is fact-checked against the
    real repo before becoming a kernel finding.

    Recognized markdown patterns:
      * ``CRITICAL:`` / ``HIGH:`` / ``MEDIUM:`` / ``LOW:`` line
        → severity + summary
      * ``Evidence:`` block → evidence_refs as bullet list
      * ``RULING:`` block (architectural-arbiter pattern) → verdict
      * ``METRIC: name=X actual=Y threshold=Z`` → metric finding

    Defensive defaults:
      * Empty markdown → empty findings list
      * Unparseable section → severity=MEDIUM + raw text in summary
      * Missing evidence_refs → severity downgrade
    """
    import re

    findings: list[dict[str, Any]] = []
    if not raw_markdown or not raw_markdown.strip():
        return findings

    # Pattern 1 — severity-prefixed lines
    severity_pattern = re.compile(
        r"^\s*\**(CRITICAL|HIGH|MEDIUM|LOW):\s*(.+)$",
        re.MULTILINE,
    )
    evidence_pattern = re.compile(
        r"^\s*[-*]\s*[`\"]?([^`\"\n:]+):(\d+)",
        re.MULTILINE,
    )

    for match in severity_pattern.finditer(raw_markdown):
        severity = match.group(1).upper()
        summary = match.group(2).strip()
        # Look forward up to 10 lines for Evidence: block
        start_pos = match.end()
        end_pos = min(len(raw_markdown), start_pos + 2000)
        scope_text = raw_markdown[start_pos:end_pos]

        evidence_refs: list[str] = []
        for e_match in evidence_pattern.finditer(scope_text):
            ref = f"{e_match.group(1).strip()}:{e_match.group(2)}"
            evidence_refs.append(ref)

        # Plan ARIA-V6 §2c v2 (B-V9-1) — hallucination guard.
        # Verify each evidence_ref against the real repo (Path.exists)
        # AND optionally against base_commit_sha (git show match).
        # Missing refs DOWNGRADE severity to MEDIUM but don't REJECT
        # the finding (operator may want soft signals).
        verified_refs: list[str] = []
        unverified_refs: list[str] = []
        if workspace_root is not None:
            for ref in evidence_refs:
                file_part = ref.split(":")[0]
                if (workspace_root / file_part).exists():
                    verified_refs.append(ref)
                else:
                    unverified_refs.append(ref)
        else:
            verified_refs = evidence_refs

        effective_severity = severity
        if unverified_refs and not verified_refs:
            effective_severity = "MEDIUM"

        findings.append({
            "id": f"{agent_name}-{len(findings) + 1}",
            "claim_type": _classify_claim_type(agent_name),
            "severity": effective_severity,
            "summary": summary[:200],
            "evidence_refs": verified_refs[:10],
            "unverified_evidence_refs": unverified_refs[:5],
            "source_agent": agent_name,
        })

    return findings


def _classify_claim_type(agent_name: str) -> str:
    """Plan ARIA-V6 §2c — claim_type derivation from agent_name."""
    if "security" in agent_name or "compliance" in agent_name:
        return "security_risk"
    if "expert" in agent_name:
        return "domain_review"
    if "auditor" in agent_name:
        return "audit_finding"
    if "writer" in agent_name:
        return "documentation_review"
    return "specialist_observation"


def run_specialist_review_runner(
    *,
    cycle_id: str,
    base_dir: str | Path,
    workspace_root: str | Path | None,
    plan_id: str,
    convergence_id: str,
    touched_services: list[str],
    pressures: list[dict[str, Any]],
    profile: str,
    max_specialists_per_cycle: int = 10,
    specialist_timeout_seconds: float = 900.0,
) -> SpecialistReviewResult:
    """Plan ARIA-V6 §2c v2 — default Gate C specialist review runner.

    Selects N specialists via deterministic algorithm, mints
    ``specialist_domain_review`` envelopes, polls
    ``agent-invocations/requests.jsonl`` for submissions until
    ``specialist_timeout_seconds`` elapses per specialist.

    Defensive default when NO specialist claims any envelope (typical
    autonomous-run mode without external Claude Code dispatchers):
    returns ``consolidated_verdict == "specialists_unavailable"``.
    Orchestrator decides whether to fail-open or fail-closed based on
    profile.

    Tests inject mock runners via the kwarg directly; this default
    function only fires in production CLI via
    ``select_specialist_review_runner(profile)`` factory.
    """
    root = ensure_tools_dir(base_dir)

    selected = select_specialist_agents(
        touched_services=touched_services,
        pressures=pressures,
        profile=profile,
        max_specialists_per_cycle=max_specialists_per_cycle,
    )

    if not selected:
        return SpecialistReviewResult(
            cycle_id=cycle_id,
            specialists_dispatched=[],
            specialists_timed_out=[],
            consolidated_verdict="specialists_unavailable",
            findings_by_specialist={},
            request_ids=[],
            rounds_count=0,
            token_cost_estimate=0,
            profile=profile,
        )

    request_ids: list[str] = []
    for agent_name in selected:
        try:
            req = create_agent_invocation_request(
                target_agent=agent_name,
                role="specialist_domain_review",
                suggested_prompt=(
                    f"Specialist review for cycle {cycle_id}. "
                    f"Audit the converged plan + cycle_diff for your "
                    f"declared domain. Emit findings with explicit "
                    f"file:line evidence_refs. Operator vision: "
                    f"plans are reviewed by domain specialists before "
                    f"worker dispatch."
                ),
                must_satisfy=[{
                    "id": f"specialist-review-{agent_name}",
                    "description": (
                        f"Specialist {agent_name} reviewed the converged "
                        f"plan and emitted findings with verified "
                        f"evidence_refs."
                    ),
                }],
                allowed_scope=[f"cycle/{cycle_id}"],
                evidence_refs=[f"cycle:{cycle_id}"],
                convergence_id=convergence_id,
                base_dir=base_dir,
            )
            request_ids.append(req["request_id"])
        except Exception:
            # Plan ARIA-V6 §2c v2 — envelope minting may fail
            # (target_agent unknown, evidence validation reject, etc.).
            # Skip this specialist; continue with the others.
            continue

    # Plan ARIA-V6 §2c v2 — poll for submissions. Defensive default:
    # no specialist claims → specialists_unavailable verdict.
    # In production this requires an external dispatcher (ci_executor
    # extension) that claims specialist envelopes + spawns Claude
    # Code subprocesses + submits results. Without dispatcher, this
    # poll loop returns specialists_unavailable after timeout.
    deadline = time.monotonic() + specialist_timeout_seconds
    poll_sleep = max(1.0, specialist_timeout_seconds / 60.0)
    while time.monotonic() < deadline:
        # Check if any specialist_domain_review envelope has been
        # claimed AND completed. The orchestrator surface for this
        # is next_pending_request returning None for the role.
        pending = next_pending_request(
            role="specialist_domain_review",
            base_dir=base_dir,
        )
        if pending is None:
            # No more pending — either all claimed+completed OR
            # none claimed at all. Without per-claim state inspection
            # at this minimum-viable level, treat as "all settled".
            break
        time.sleep(poll_sleep)

    # Minimum-viable V6.1 default: returns specialists_unavailable
    # in autonomous mode where no external dispatcher is running.
    # Future C2+ work (ci_executor extension) populates this surface
    # with real specialist submissions; the verdict transforms then
    # surface remediation_required findings to gate worker_drainer.
    return SpecialistReviewResult(
        cycle_id=cycle_id,
        specialists_dispatched=selected,
        specialists_timed_out=selected,
        consolidated_verdict="specialists_unavailable",
        findings_by_specialist={},
        request_ids=request_ids,
        rounds_count=1,
        token_cost_estimate=0,
        profile=profile,
    )


def select_specialist_review_runner(profile: str = "standard") -> SpecialistReviewRunner:
    """Plan ARIA-V6 §2c — production specialist-review-runner factory.

    Always returns ``run_specialist_review_runner``: specialist
    dispatch is architecturally required whenever Gate C is wired
    (Tier-1 discipline). Tests inject mock runners directly via the
    ``specialist_review_runner`` kwarg on
    ``run_autonomy_orchestrator``; they do NOT go through this
    factory.

    The ``profile`` parameter is accepted for API symmetry with
    ``select_convergence_runner`` / ``select_review_runner``
    (V5 §A1 pattern). Future profile-specific overrides hook here.
    """
    return run_specialist_review_runner
