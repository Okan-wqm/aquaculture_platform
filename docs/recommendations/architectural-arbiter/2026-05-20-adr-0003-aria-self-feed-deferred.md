# ADR-0003 — ARIA Self-Feed Pressure Source (deferred to V10.6)

**Status:** accepted
**Date:** 2026-05-20
**Branch:** snowball
**Resolves:** AISAFETY-CRIT-001 (prompt injection through finding body), AISAFETY-CRIT-003 (recursive amplification loop), AISAFETY-CRIT-004 (pre-positioned auto-apply surface), ARCH-CRIT-001 (V9.4 priority pin one-way door), ARCH-CRIT-004 (READONLY_PATHS conflict)
**Plan reference:** `/root/.claude/plans/immutable-sparking-waterfall.md` §"Out of scope (V10.6+)"
**Tracked finding:** F-AUTO-V10.6-SELF-FEED.json (emitted with this ADR)

## Context

V10.5 v1 plan (overwritten) proposed Phase 2: ARIA Self-Feed — adding `aria_findings_open` as a 6th pressure source in `plan_synthesizer.py`. The synthesizer would parse `aria-findings/F-*.json` bodies and target OPEN findings as next-plan goals. ARIA's P+C+CR pipeline would generate FIX PLANS for ARIA's own findings; operator would review + apply.

The 6-agent adversarial audit identified 6 CRITICAL issues clustered in this single phase. Aggregating them:

### Cluster: Prompt injection through self-feed
- **AISAFETY-CRIT-001:** finding-body fields (`tier_1_architectural_fix.scope`, `affected_subsystems[]`, `structural_root_cause.lesson`) reach `convert_candidate_to_plan_content` → LLM convergence prompt WITHOUT passing through `text_safety.sanitize_untrusted_text`. C-5 closure covered 4 source types; the new 5th source was outside that scope.
- **AISAFETY-CRIT-002:** the upstream `emit_finding` path itself does not sanitize natural-language fields. A `cross_reviewer` agent's `risks[].summary` can carry adversarial text into the finding doc, then back into ARIA's planner via self-feed.

### Cluster: Recursive amplification loop
- **AISAFETY-CRIT-003:** No per-cycle finding-emit cap; no topology cycle-detection. ARIA emits F-AUTO → planner targets it → fix produces new behavior → watchdog emits new F-AUTO with different signature → cap doesn't fire → loop. No bounded mechanism to stop the loop.

### Cluster: Pre-positioned auto-apply surface
- **AISAFETY-CRIT-004:** `fix_category` regex classifier (PROMPT_ONLY/KERNEL) targets the READONLY_PATHS frontier. The classifier exists in V10.5 solely to be the gating predicate for V10.6 auto-apply. Shipping the predicate now creates a Chekhov's-gun architectural commitment.
- **ARCH-CRIT-004:** `.claude/agents/` is in `implementation_safety.READONLY_PATHS` per V8.13 challenger contract. PROMPT_ONLY auto-apply (V10.6) needs ADR + arbiter approval to remove the path; staging the predicate in V10.5 creates a future-PR conflict surface.

### Cluster: V9.4 closed-set invariant violation
- **ARCH-CRIT-001:** `PlanCandidateSource` enum is the v3-Phase-9.4 5-member CLOSED set per `test_phase_v9_0_a_plan_candidate_source.py:20-38`: "Adding a 6th member is a one-way door (governance rows + cost-attribution rows already reference these strings); adding requires an explicit ADR + invariant amendment." The v1 plan disguised this as "+1 line (pinned member-set update)" — a Tier-1 one-way-door decision misclassified as Tier-2 (automatic).
- **ARCH-HIGH-002:** v1 plan also silently demoted `FAILING_CI` from priority slot 1 to slot 2, inverting the V9.4 design rationale ("operator signal > production breakage > all other auto-discovered sources"). Production CI failures would now wait behind ARIA's self-reflection.

## Decision

**V10.5 does NOT ship Phase 2 self-feed. The entire phase is deferred to V10.6.**

Specifically:
1. NO new pressure source enum member in `PlanCandidateSource`
2. NO `scan_aria_findings_open` scanner in `plan_synthesizer.py`
3. NO `fix_category` classifier regex set
4. NO `_normalize_finding_view` runtime patch for schema reconciliation (deferred to V10.6 as F-AUTO-V10.6-SCHEMA-RECONCILIATION)
5. NO modification to `_SOURCE_PRIORITY` table or `rank_candidate_sources` function
6. NO new env var `ARIA_PRESSURE_SOURCE_V10_5_ENABLED`

V10.5 ships ONLY the watchdog (Phase 1 — observer; reads governance + emits sanitized findings; no plan-target generation) + F-023 backoff (Phase 3 — resilience; no plan generation) + V10.4 closure doc + ADRs. The self-feed write-loop is structurally absent.

## V10.6 prerequisites (must hold BEFORE Phase 2 can land in V10.6)

1. **emit_finding sanitizer (V10.5 Phase B)** — already covered by ADR-0002. Findings emitted by V10.5+ must carry sanitized fields.
2. **C-5 sanitizer extension to ARIA_FINDINGS_OPEN source** — `convert_candidate_to_plan_content`'s 5th-source-type branch must run every read field through `text_safety.sanitize_untrusted_text` with appropriate `max_len` per field. Invariant test: 12 adversarial fixtures (4 delimiter + 4 bidi + 4 control-char) confirm no escape to LLM prompt.
3. **Originating-skill self-loop guard** — `scan_aria_findings_open` MUST filter `originating_skill.startswith("aria-watchdog:")` findings if any of the last 3 closed findings carry the same prefix. Topology guard via the ORIGINATING_SKILL_ALLOWLIST from ADR-0002.
4. **Per-24h F-AUTO global cap** — max 5 ARIA-emitted findings per 24h reaching the planner queue. Over-cap → governance event `aria_findings_open_global_cap_exceeded` + suppression.
5. **Cycle-detection invariant** — Tier-3 detect: if the last 3 RESOLVED findings have `originating_skill` starting `aria-watchdog:`, refuse to pick another ARIA_FINDINGS_OPEN candidate this cycle.
6. **Priority slot decision** — recommended slot is BETWEEN `ORPHAN_FINDING` (2) and `F_FINDING` (3) at slot 3 (NOT slot 1). Rationale: failing-CI is production breakage; ARIA self-reflection ranks BELOW it. The v1 plan's slot-1 placement was a hidden strategic decision per ARCH-HIGH-002.
7. **READONLY_PATHS interaction** — V10.6 must decide whether to remove `.claude/agents/` from READONLY_PATHS (requires its own ADR) OR to introduce a bypass for "ARIA-self-emitted PROMPT_ONLY findings." The choice has different threat models; an ADR is the precondition.
8. **Schema reconciliation** — F-AUTO-V10.6-SCHEMA-RECONCILIATION must close before any reader of finding JSON shape lands. Either migrate all `schema:` field uses to `$schema:` OR pin both with explicit precedence + reject docs containing both.

## Consequences

### Positive
- V10.5 ships zero new prompt-injection surfaces
- No recursive write-loop introduced (watchdog is read-only; findings exist but not consumed by planner)
- V9.4 closed-set invariant preserved; FAILING_CI priority unchanged
- READONLY_PATHS frontier unchanged
- 24h budget realistic (Phase 2's ~5h returned to other deliverables — though current plan v2 uses the saved budget for Phase 1 hardening + ADR drafting, not new capability)
- Sanitizer + allowlist landing in V10.5 Phase B (per ADR-0002) is the prerequisite for safe Phase 2 in V10.6

### Negative
- The "ARIA fixes itself" demonstration moves to V10.6. Operator's question "can ARIA self-heal?" remains partially-answered: V10.5 demonstrates partial self-heal at the AGENT-prompt-drift class (cycle 3 challenger independently re-derived F-019 — see V10.4 closure report §5) but does NOT yet demonstrate ARIA-emits-finding → ARIA-targets-finding → operator-approves-fix cycle. That demo is V10.6 scope.
- F-AUTO-V10.6-SELF-FEED tracked finding accumulates the 8 prerequisites above; the V10.6 sprint is heavier than V10.5 was.

### Neutral
- Self-feed is architecturally compatible with the V10.5 watchdog; the watchdog just doesn't produce planner-consumable signals during V10.5.

## Compliance

ADR-0003 is the canonical record for the V10.5 → V10.6 self-feed deferral. The tracked finding `F-AUTO-V10.6-SELF-FEED.json` (emitted in V10.5 Phase E) carries owner (operator Okan) + deadline (2026-06-15) + this ADR as cross-reference. Per CLAUDE.md banned-phrase rules: the deferral is explicit, owner+deadline+finding-ID present, and the architectural reasoning is documented here.

The audit logs that drove this deferral are listed in `aria-findings/F-AUTO-V10.6-SELF-FEED.json` evidence_refs (the 6 agent reports from V10.5 Plan v2 adversarial audit).

## Implementation owners (V10.6)

- Plan reference: V10.6 plan to be drafted as `/root/.claude/plans/v10-6-self-feed-bounded.md` after V10.5 closure
- Implementer: operator (Okan)
- Reviewers: ai-safety-auditor (mandatory pre-merge), architectural-arbiter (PROMPT_ONLY READONLY_PATHS decision), security-reviewer (sanitizer coverage on 5th source type)
- Validation: 12-fixture adversarial sanitizer test + originating_skill self-loop guard invariant + per-24h global cap invariant + 5-source-byte-identical regression snapshot
