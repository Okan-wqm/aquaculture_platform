# AI egress consent boundary — AiEgressGateService (Round-3 Wave 2 slice 1)

## MSG-MEDIUM-001 — scattered, inconsistent AI-egress consent checks centralized into one fail-closed boundary

**Severity:** MEDIUM · **Layer:** messaging AI · **Owner:** messaging-expert
**Cycle:** 2026-06-10-round3 (Wave 2 slice 1; Agent-2 MERGE-AS-IS-fresh)

### Observation
Every AI-egress path re-implemented the `AiPrivacyService.canAnalyzeMessage` dual-consent
check with its own ad-hoc handling — sentiment (`if (!canAnalyze) return`, no error path) and
embedding (inline `.canAnalyzeMessage(...).catch(() => false)`). A scattered gate is a gate you
can forget to add, and the two callers disagreed on the error case (embedding fail-closed on
error, sentiment let the error propagate).

### Fix (port from fix/messaging-enterprise-gates, reimplemented onto current main)
`AiEgressGateService` is the single fail-closed boundary: `assertAllowed` throws
ForbiddenException on denial OR on a consent-check error (uncertainty = denial, uniformly
fail-closed); `isAllowed` is the boolean form for batch filters. sentiment + embedding now route
through it. Registered + exported from AiModule.

### Verification
ai-egress-gate spec (6 cases: allow/deny/error → assert+isAllowed) + the refactored sentiment (5)
and embedding (5) specs green; reconciled with the MSG-HIGH-001 restoration (OutboxPublisher /
createMockDataSource-API fixes preserved). No banned constructs.

### Tier
Tier-1 (make-it-impossible-to-forget): a single SSoT boundary every egress path must call; the
dead-contract / call-site CI invariant (Wave-2 CI slice) will enforce that future egress routes
through it.
