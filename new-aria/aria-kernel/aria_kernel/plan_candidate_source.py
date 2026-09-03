"""Plan ARIA-V9.0-A — plan-candidate-source taxonomy (SSoT).

Closes architectural-arbiter CRIT-006 (ad-hoc string drift across
plan_synthesizer / knowledge_graph / budget). Every module that
needs to discuss "which lane this synthesized plan came from" MUST
import :class:`PlanCandidateSource` from this single module.

This is DELIBERATELY distinct from ``aria_kernel/pressure.py``'s
``SOURCE_WEIGHTS`` dict — see ``docs/aria/v3-plan-module-inventory.md``
naming-collision section. Two complementary taxonomies:

* ``pressure.py`` SOURCE_WEIGHTS — *why* a pressure point exists
  (tool quarantined, belief stale, contradiction found, …)
* ``plan_candidate_source.py`` PlanCandidateSource — *which input
  lane* ``plan_synthesizer`` mined this CONVERGED-candidate from
  (git diff vs ORPHAN-* finding vs F-* finding vs failing CI vs
  signed operator feedback)

Tier-1 (make impossible): string equality on enum values cannot
silently desync across modules because the enum is a closed set.

Invariant ``I-V9-PRESSURE-01`` (in
``tests/invariants/v9/test_phase_v9_0_a_plan_candidate_source.py``)
pins both (a) the enum's exact member set and (b) the import
discipline — every consumer in
``{plan_synthesizer, knowledge_graph, budget, auto_merge_runners,
plan_convergence_bridge}`` MUST import from here, never define
shadow strings.
"""
from __future__ import annotations

from enum import Enum


class PlanCandidateSource(str, Enum):
    """Closed taxonomy of plan-candidate input lanes.

    Order of definition reflects v3 Phase 9.4 priority ranking
    (highest priority first) but the enum's *ordering* is NOT
    load-bearing — ranking is computed by
    :func:`plan_synthesizer.rank_candidate_sources` against the
    knowledge-graph effectiveness ledger.
    """

    OPERATOR_FEEDBACK = "operator_feedback"
    """Signed operator-feedback rows from
    ``aria-tools/operator-feedback.jsonl``. Signature verified via
    operator pinned public key; unsigned rows dropped with
    ``unsigned_operator_feedback`` governance event."""

    FAILING_CI = "failing_ci"
    """Failing CI runs on ``main`` queried via
    ``gh run list --branch main --status failure --limit 5``.
    Cached 10-min TTL at ``aria-tools/cache/gh-run-list.json`` to
    stay below GitHub API 5000/hr rate limit."""

    ORPHAN_FINDING = "orphan_finding"
    """OPEN findings scanned from ``docs/reviews/orphan-findings.md``
    headings matching ``^## ORPHAN-(?P<severity>[A-Z]+)-(?P<id>\\d+)``.
    Severity ladder: CRITICAL > HIGH > MEDIUM > LOW."""

    F_FINDING = "f_finding"
    """ARIA-internal F-* findings under ``aria-findings/*.json``.
    Aging scan uses ``Path.stat().st_mtime`` only — JSON body parse
    deferred until candidate is selected (Tier-2 automatic
    bounded-startup-latency, perf-expert PERF-HIGH-006)."""

    GIT_DIFF = "git_diff"
    """V8 baseline source — ``git diff HEAD~1..HEAD --unified=0``
    via V8.14 ``_evidence_refs_from_hunks``. Lowest priority; fires
    as last-resort when no other lane has candidates."""

    GITHUB_ISSUE = "github_issue"
    """Plan 032 Faz 032f — open missions the event gateway minted from
    GitHub issues labelled ``aria`` (``gateway.router`` →
    ``mission.open_mission(source_kind="github_issue")``). Ranked next to
    FAILING_CI: a person filed it, but it is not signed operator feedback.
    One-way door 14."""


__all__ = ("PlanCandidateSource",)
