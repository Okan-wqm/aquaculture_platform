# Implementation Plan: Tier 1 Validated Fixes

## Context
Generated: 2026-04-09
Base Commit: 11db8622
Source Reports: 6 (1 context-manager compaction + 4 Tier-1 expert validations + 1 orchestrator unified)
Total Packages: 7
CRITICAL: 0 | HIGH: 2 | MEDIUM: 5 | LOW: 0

## Source Reports
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md (primary finding source)
- docs/reviews/security-reviewer/2026-04-09-tenant-trust-chain-validation.md
- docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md
- docs/reviews/infra-expert/2026-04-09-nginx-websocket-validation.md
- docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Package Index

### Tier 1 -- Parallelizable (no prerequisites)
- [ ] 01-mqtt-device-event-schema-routing -- MQTT handler writes DeviceEvent to wrong schema [HIGH] [security-sensitive]
- [ ] 02-event-store-tenant-auth -- event-store-service header-only tenant ID on 20 endpoints [HIGH] [security-sensitive]
- [ ] 03-allowed-base-domains-fail-closed -- ALLOWED_BASE_DOMAINS fail-open return true (1-line fix) [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 05-nginx-socketio-config-sync -- nginx configs missing /socket.io/ location block [MEDIUM] [parallelizable]
- [ ] 07-hr-handlers-post-commit-refetch -- 17 HR handlers post-commit re-fetch on different connection [MEDIUM] [parallelizable]

### Tier 2 -- Depends on Tier 1
- [ ] 04-strip-tenant-header-priority-reorder -- x-tenant-id header not stripped + wrong priority order [MEDIUM] [security-sensitive] (after 03)
- [ ] 06-mqtt-io-config-tenant-scoping -- MQTT DeviceIoConfig query without tenant scope [MEDIUM] (after 01)

## Recommended Execution Order

For serial execution, the recommended order respects topological sort with security-sensitive packages first:

1. **03-allowed-base-domains-fail-closed** -- trivial 1-line fix, quick win, unblocks 04
2. **01-mqtt-device-event-schema-routing** -- HIGH severity, unblocks 06
3. **02-event-store-tenant-auth** -- HIGH severity, independent
4. **04-strip-tenant-header-priority-reorder** -- depends on 03
5. **05-nginx-socketio-config-sync** -- independent, MEDIUM
6. **06-mqtt-io-config-tenant-scoping** -- depends on 01
7. **07-hr-handlers-post-commit-refetch** -- independent, MEDIUM, largest package

## Findings Not Packaged (deferred to future plan)

The following findings from the source reports are NOT included in this plan because they are systemic patterns requiring broader architectural work or are lower priority:

- **Systemic A: Platform-level `withTenantContext()` for non-HTTP paths** -- requires new abstraction in libs/backend-common. Packages 01 and 06 apply targeted fixes; the systemic abstraction is a separate initiative.
- **Systemic B: Type safety erosion** (90 `as any`, 51 `as unknown as`, 3 `@ts-ignore`) -- escalated MEDIUM->HIGH by context-manager. Too large for a single plan (144 occurrences across 30+ files). Requires dedicated plan with file-by-file packages.
- **Orchestrator MEDIUMs (MEDIUM-001 through MEDIUM-020)** -- 20 findings covering event contracts, auth hardening, database naming, CI config. Separate plan recommended.
- **LOW findings (16 total)** -- deferred.

## Dependency Graph
See: docs/plans/2026-04-09-tier1-fixes/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-09-tier1-fixes/verification-log.md (append-only)

## Progress Summary
Completed: 0 / 7 packages
Last Updated: 2026-04-09
