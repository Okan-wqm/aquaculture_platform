# Implementation Plan: MEDIUM Findings Remediation (85 Findings, 11 Agents)

## Context
Generated: 2026-04-09
Base Commit: 11db862242bac680eeaaa7c85738082ff312e084
Source Reports: see Source Reports section below
Total Packages: 15
CRITICAL: 0 | HIGH: 0 | MEDIUM: 85 | LOW: 0

## Source Reports
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md (primary finding source for all 85 MEDIUM findings)
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md (systemic pattern context)
- docs/reviews/edge-expert/2026-04-05-targeted-security-audit.md (EDGE-MEDIUM detail)
- docs/reviews/farm-expert/2026-04-04-full-codebase-audit.md (FARM-MEDIUM detail)
- docs/reviews/admin-expert/2026-04-04-full-codebase-audit.md (ADMIN-MEDIUM detail)
- docs/reviews/sensor-expert/2026-04-05-s2-high-findings.md (SENSOR-MEDIUM detail)
- docs/reviews/platform-services/2026-04-05-s2-high-findings.md (PLAT-MEDIUM detail)
- docs/reviews/data-expert/2026-04-05-s2-high-findings.md (DATA-MEDIUM detail)
- docs/reviews/database-reviewer/2026-04-04-full-platform-audit.md (DB-MEDIUM detail)

## Prior Plan Reference
- docs/plans/2026-04-09-full-remediation/plan.md -- covers orchestrator MEDIUM-001 through MEDIUM-020 (20 findings). NO overlap with this plan's 85 findings (different ID namespaces).
- docs/plans/2026-04-09-tier1-fixes/plan.md -- covers HIGH + validated MEDIUM from tier1 compaction. NO overlap.

## Package Index

### Sprint 3 -- Security-Sensitive MEDIUM (execute first within sprint)
- [ ] 01-frontend-token-polling-stale -- Visibilitychange refresh, TanStack refetch, per-domain staleTime, offline dedup, socket reconnect, CORS [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 03-edge-resilience-safety -- Rate limiter panic, unbounded interner, zeroize, tokio Mutex, MQTT cancel-safety, backup auth, watchdog, SCADA CSP [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 07-farm-domain-integrity -- Code gen TX, maxDensity, negative transfer, pessimistic lock, DataLoader, PII, cull date, pond index [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 08-admin-security-hardening -- Impersonation IP, explorer audit, meta-audit, session MFA, read-only TX, typed events [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 09-platform-monetary-config-resilience -- Decimal math, Stripe ConfigService, DLQ RBAC, Retry-After, meq/L, Redis cache, projection cursor, await eventBus [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 12-sensor-tenant-scoping-safety -- Cache tenant scope, console.warn, system sentinel, table qualification, VFD risk tier [MEDIUM] [security-sensitive] [parallelizable]

### Sprint 3 -- Domain MEDIUM (parallelizable with security batch)
- [ ] 02-frontend-a11y-contrast -- gray-400 contrast ratio WCAG AA [MEDIUM] [parallelizable]
- [ ] 04-hr-monetary-types-events -- Payroll monetary as string, training BaseEvent, Number() removal [MEDIUM] [parallelizable]
- [ ] 05-hr-scheduling-leave-safety -- Leave overlap constraint, shift tz, state machine, STCW BST, schema validation [MEDIUM] [parallelizable]
- [ ] 06-hr-frontend-a11y -- Form labels htmlFor [MEDIUM] [parallelizable]
- [ ] 11-data-layer-query-performance -- Composite indexes, continuous aggregates, keyset pagination, lateral join [MEDIUM] [parallelizable]
- [ ] 13-messaging-storage-redis-resilience -- Outbox routing, Redis circuit breaker, legal hold cache, stream export, consent TTL, presence cleanup, drop_chunks [MEDIUM] [parallelizable]
- [ ] 14-messaging-ai-embedding-safety -- HNSW/GIN tenant index, isAiGenerated, per-item embedding rollback, atomic token budget, cost-per-tool [MEDIUM] [parallelizable]
- [ ] 15-database-schema-hygiene -- Naming, redundant indexes, nationalId validation, JSONB flatten, hypertable, partial indexes [MEDIUM] [parallelizable]

### Sprint 3-4 -- Event Contracts (soft dep on existing plan)
- [ ] 10-data-layer-event-contracts -- Missing aggregateId, version bumps, upcasters, flat StorageQuotaExceeded, timestamp type [MEDIUM] (soft dep on existing plan package 08)

## Recommended Execution Order (Serial)

For single-executor serial execution, security-sensitive packages first, then by estimated complexity:

| # | Package | Findings | Est. Diff Lines | Rationale |
|---|---------|----------|-----------------|-----------|
| 1 | 08-admin-security-hardening | 6 | ~200 | Security-sensitive, admin service isolated |
| 2 | 12-sensor-tenant-scoping-safety | 5 | ~150 | Security-sensitive, life-safety VFD fix |
| 3 | 01-frontend-token-polling-stale | 6 | ~250 | Security-sensitive, auth/token handling |
| 4 | 09-platform-monetary-config-resilience | 9 | ~400 | Security-sensitive, crosses multiple services |
| 5 | 03-edge-resilience-safety | 8 | ~350 | Security-sensitive, Rust crate (all-or-nothing build) |
| 6 | 07-farm-domain-integrity | 8 | ~400 | Security-sensitive (PII), life-safety (density) |
| 7 | 02-frontend-a11y-contrast | 1 | ~30 | Quick win, accessibility |
| 8 | 06-hr-frontend-a11y | 1 | ~80 | Quick win, accessibility |
| 9 | 04-hr-monetary-types-events | 4 | ~200 | Event contract change, breaking |
| 10 | 05-hr-scheduling-leave-safety | 5 | ~300 | DB migration + entity changes |
| 11 | 11-data-layer-query-performance | 8 | ~350 | Index additions, query rewrites |
| 12 | 13-messaging-storage-redis-resilience | 7 | ~400 | Infrastructure resilience |
| 13 | 14-messaging-ai-embedding-safety | 6 | ~300 | AI subsystem integrity |
| 14 | 15-database-schema-hygiene | 8 | ~450 | Migration-heavy, coordinate with payroll changes |
| 15 | 10-data-layer-event-contracts | 5 | ~250 | Wait for existing plan pkg 08 |

## Finding Coverage Matrix

| Finding ID | Source Agent | Package | Status |
|------------|-------------|---------|--------|
| FE-MEDIUM-013 | frontend-expert | 01 | PENDING |
| FE-MEDIUM-024 | frontend-expert | 02 | PENDING |
| FE-MEDIUM-025 | frontend-expert | 01 | PENDING |
| FE-MEDIUM-026 | frontend-expert | 01 | PENDING |
| FE-MEDIUM-030 | frontend-expert | 01 | PENDING |
| FE-MEDIUM-032 | frontend-expert | 01 | PENDING |
| FE-MEDIUM-037 | frontend-expert | 01 | PENDING |
| EDGE-MEDIUM-001 | edge-expert | 03 | PENDING |
| EDGE-MEDIUM-002 | edge-expert | 03 | PENDING |
| EDGE-MEDIUM-003 | edge-expert | 03 | PENDING |
| EDGE-MEDIUM-004 | edge-expert | 03 | PENDING |
| EDGE-MEDIUM-005 | edge-expert | 03 | PENDING |
| EDGE-MEDIUM-006 | edge-expert | 03 | PENDING |
| EDGE-MEDIUM-007 | edge-expert | 03 | PENDING |
| EDGE-MEDIUM-008 | edge-expert | 03 | PENDING |
| HR-MEDIUM-001 | hr-expert | 04 | PENDING |
| HR-MEDIUM-002 | hr-expert | 05 | PENDING |
| HR-MEDIUM-003 | hr-expert | 05 | PENDING |
| HR-MEDIUM-004 | hr-expert | 05 | PENDING |
| HR-MEDIUM-005 | hr-expert | 05 | PENDING |
| HR-MEDIUM-006 | hr-expert | 05 | PENDING |
| HR-MEDIUM-007 | hr-expert | 04 | PENDING |
| HR-MEDIUM-008 | hr-expert | 06 | PENDING |
| HR-MEDIUM-009 | hr-expert | 04 | PENDING |
| HR-MEDIUM-010 | hr-expert | 04 | PENDING |
| FARM-MEDIUM-001 | farm-expert | 07 | PENDING |
| FARM-MEDIUM-002 | farm-expert | 07 | PENDING |
| FARM-MEDIUM-003 | farm-expert | 07 | PENDING |
| FARM-MEDIUM-004 | farm-expert | 07 | PENDING |
| FARM-MEDIUM-005 | farm-expert | 07 | PENDING |
| FARM-MEDIUM-006 | farm-expert | 07 | PENDING |
| FARM-MEDIUM-007 | farm-expert | 07 | PENDING |
| FARM-MEDIUM-008 | farm-expert | 07 | PENDING |
| ADMIN-MEDIUM-001 | admin-expert | 08 | PENDING |
| ADMIN-MEDIUM-002 | admin-expert | 08 | PENDING |
| ADMIN-MEDIUM-003 | admin-expert | 08 | PENDING |
| ADMIN-MEDIUM-004 | admin-expert | 08 | PENDING |
| ADMIN-MEDIUM-005 | admin-expert | 08 | PENDING |
| ADMIN-MEDIUM-006 | admin-expert | 08 | PENDING |
| PLAT-MEDIUM-001 | platform-services | 09 | PENDING |
| PLAT-MEDIUM-002 | platform-services | 09 | PENDING |
| PLAT-MEDIUM-003 | platform-services | 09 | PENDING |
| PLAT-MEDIUM-004 | platform-services | 09 | PENDING |
| PLAT-MEDIUM-005 | platform-services | 09 | PENDING |
| PLAT-MEDIUM-006 | platform-services | 09 | PENDING |
| PLAT-MEDIUM-007 | platform-services | 09 | PENDING |
| PLAT-MEDIUM-008 | platform-services | 09 | PENDING |
| PLAT-MEDIUM-009 | platform-services | 09 | PENDING |
| DATA-MEDIUM-006 | data-expert | 10 | PENDING |
| DATA-MEDIUM-007 | data-expert | 10 | PENDING |
| DATA-MEDIUM-008 | data-expert | 10 | PENDING |
| DATA-MEDIUM-009 | data-expert | 10 | PENDING |
| DATA-MEDIUM-011 | data-expert | 10 | PENDING |
| DATA-MEDIUM-013 | data-expert | 11 | PENDING |
| DATA-MEDIUM-015 | data-expert | 11 | PENDING |
| DATA-MEDIUM-017 | data-expert | 11 | PENDING |
| DATA-MEDIUM-018 | data-expert | 11 | PENDING |
| DATA-MEDIUM-021 | data-expert | 11 | PENDING |
| DATA-MEDIUM-022 | data-expert | 11 | PENDING |
| DATA-MEDIUM-023 | data-expert | 11 | PENDING |
| DATA-MEDIUM-024 | data-expert | 11 | PENDING |
| SENSOR-MEDIUM-001 | sensor-expert | 12 | PENDING |
| SENSOR-MEDIUM-002 | sensor-expert | 12 | PENDING |
| SENSOR-MEDIUM-003 | sensor-expert | 12 | PENDING |
| SENSOR-MEDIUM-004 | sensor-expert | 12 | PENDING |
| SENSOR-MEDIUM-005 | sensor-expert | 12 | PENDING |
| MSG-MEDIUM-008 | messaging-expert | 13 | PENDING |
| MSG-MEDIUM-012 | messaging-expert | 14 | PENDING |
| MSG-MEDIUM-013 | messaging-expert | 14 | PENDING |
| MSG-MEDIUM-017 | messaging-expert | 13 | PENDING |
| MSG-MEDIUM-023 | messaging-expert | 13 | PENDING |
| MSG-MEDIUM-028 | messaging-expert | 13 | PENDING |
| MSG-MEDIUM-037 | messaging-expert | 13 | PENDING |
| MSG-MEDIUM-038 | messaging-expert | 14 | PENDING |
| MSG-MEDIUM-041 | messaging-expert | 14 | PENDING |
| MSG-MEDIUM-043 | messaging-expert | 13 | PENDING |
| MSG-MEDIUM-045 | messaging-expert | 13 | PENDING |
| MSG-MEDIUM-049 | messaging-expert | 14 | PENDING |
| MSG-MEDIUM-050 | messaging-expert | 14 | PENDING |
| DB-MEDIUM-001 | database-reviewer | 15 | PENDING |
| DB-MEDIUM-002 | database-reviewer | 15 | PENDING |
| DB-MEDIUM-003 | database-reviewer | 15 | PENDING |
| DB-MEDIUM-004 | database-reviewer | 15 | PENDING |
| DB-MEDIUM-005 | database-reviewer | 15 | PENDING |
| DB-MEDIUM-006 | database-reviewer | 15 | PENDING |
| DB-MEDIUM-007 | database-reviewer | 15 | PENDING |
| DB-MEDIUM-008 | database-reviewer | 15 | PENDING |

## Overlap Check with Existing Plans

### docs/plans/2026-04-09-full-remediation/plan.md
The full-remediation plan covers orchestrator findings MEDIUM-001 through MEDIUM-020 (different ID namespace). NO finding ID overlap with this plan's 85 findings. File-level overlaps:
- `libs/event-contracts/src/tenant-events.ts` -- full-remediation pkg 08 + this plan pkg 10 (soft dep annotated)
- Entity naming strategy -- full-remediation pkg 13 + this plan pkg 15 (soft dep annotated)

### docs/plans/2026-04-09-tier1-fixes/plan.md
Tier1 plan covers HIGH findings + 5 validated MEDIUMs (SEC-HIGH-*, AUTH-HIGH-*, INFRA-HIGH-*). NO overlap with this plan.

## Dispatch Summary

| Package | Dispatch: test-runner | Dispatch: security-reviewer |
|---------|----------------------|---------------------------|
| 01 | no | no |
| 02 | no | no |
| 03 | no | yes |
| 04 | yes | no |
| 05 | no | no |
| 06 | no | no |
| 07 | no | no |
| 08 | no | yes |
| 09 | yes | no |
| 10 | yes | no |
| 11 | no | no |
| 12 | no | yes |
| 13 | no | no |
| 14 | no | no |
| 15 | no | no |

## Dependency Graph
See: docs/plans/2026-04-09-medium-fixes/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-09-medium-fixes/verification-log.md (append-only)

## Progress Summary
Completed: 0 / 15 packages
Last Updated: 2026-04-09
