# Implementation Plan: Critical Fixes (45 CRITICAL findings across 11 domains)

## Context
Generated: 2026-04-09
Base Commit: 11db862242bac680eeaaa7c85738082ff312e084
Source Reports: User-provided 45 CRITICAL finding list from full platform audit (11 domain agents)
Total Packages: 23
CRITICAL: 45 findings across 23 packages
Severity Breakdown: CRITICAL: 45 | HIGH: 0 | MEDIUM: 0 | LOW: 0

## Source Reports
- User-provided finding list 2026-04-09 (authoritative, 45 CRITICAL findings from 11 agents)
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md (background context)
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md (prior cycle context)

## Prior Plan Reference
- docs/plans/2026-04-09-tier1-fixes/plan.md (7 packages, HIGH/MEDIUM, no overlap with this plan)
- docs/plans/2026-04-09-full-remediation/plan.md (23 packages, HIGH/MEDIUM/LOW, no overlap with this plan)

## Package Index

### Sprint 0 -- Hotfix (LIFE-SAFETY + Active Exploits)
- [ ] 01-edge-shutdown-safe-state -- Actuators left in last position on shutdown (LIFE-SAFETY) [CRITICAL] [parallelizable]
- [ ] 02-hr-rotation-certification-validation -- No certification check before hazardous rotation assignment (LIFE-SAFETY) [CRITICAL] [parallelizable]
- [ ] 03-sensor-provisioning-timing-safe -- Non-timing-safe token comparison, 4th audit unfixed (active exploit) [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 04-sensor-channel-tenant-isolation -- DELETE missing tenantId, cross-tenant channel destruction [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 05-fe-integrity-guard-bypass -- SRI integrity guard bypassable via 3 vectors [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 06-fe-query-key-tenant-prefix -- Cross-tenant cache leak in 3 query hooks [CRITICAL] [security-sensitive] [parallelizable]

### Sprint 1 -- Remaining CRITICALs (security-sensitive first)
- [ ] 07-edge-rust-hardening -- Clippy warn-not-deny, OOM DoS, QoS loss, LoRa panics [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 08-hr-pii-exposure -- Raw PII in NATS events, medical data in GraphQL schema [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 09-hr-payroll-decimal-precision -- Float rounding in payroll, hardcoded 160h divisor [CRITICAL] [parallelizable]
- [ ] 10-hr-leave-approval-race -- Concurrent leave approval race condition [CRITICAL] [parallelizable]
- [ ] 11-admin-impersonation-security -- Fire-and-forget audit, no MFA step-up, no TTL [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 12-admin-db-explorer-readonly -- DB Explorer uses write role, no read-only enforcement [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 13-admin-audit-immutability -- Audit purge ignores legal holds, no DB-level immutability [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 14-billing-decimal-audit -- JS float billing math, insufficient precision, no audit trail [CRITICAL] [parallelizable]
- [ ] 15-event-store-immutability-checkpoint -- Non-atomic projection checkpoint, no immutability triggers [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 16-webhook-ssrf-defense -- Webhook dispatcher has no SSRF protection [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 17-event-contracts-union-fix -- AnyPlatformEvent missing SecurityEvent [CRITICAL] [parallelizable]
- [ ] 18-outbox-entity-poller-fix -- BIGINT PK collision, missing fields, no row locking [CRITICAL] [parallelizable]
- [ ] 19-compliance-partition-legalhold -- Unpartitioned audit log, LegalHold missing legalMatterId [CRITICAL] [parallelizable]
- [ ] 20-gdpr-race-cascade -- GDPR anonymize TOCTOU race, missing AgentConversation cascade [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 21-ai-ssrf-jailbreak-defense -- AI SSRF via DNS rebinding, no jailbreak filter [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 22-db-pii-encryption -- nationalId/bankDetails stored plain text [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 23-db-precision-partition-pk -- float8 for compliance thresholds, audit PK missing partition key [CRITICAL] [parallelizable]

## Finding Coverage Matrix

| Finding ID | Source Agent | Package | Sprint |
|------------|-------------|---------|--------|
| EDGE-CRITICAL-004 | edge-expert | 01 | 0 |
| HR-CRITICAL-007 | hr-expert | 02 | 0 |
| SENSOR-CRITICAL-001 | sensor-expert | 03 | 0 |
| SENSOR-CRITICAL-002 | sensor-expert | 04 | 0 |
| FE-CRITICAL-001 | frontend-expert | 05 | 0 |
| FE-CRITICAL-002 | frontend-expert | 05 | 0 |
| FE-CRITICAL-003 | frontend-expert | 05 | 0 |
| FE-CRITICAL-014 | frontend-expert | 06 | 0 |
| FE-CRITICAL-015 | frontend-expert | 06 | 0 |
| FE-CRITICAL-016 | frontend-expert | 06 | 0 |
| EDGE-CRITICAL-001 | edge-expert | 07 | 1 |
| EDGE-CRITICAL-002 | edge-expert | 07 | 1 |
| EDGE-CRITICAL-003 | edge-expert | 07 | 1 |
| EDGE-CRITICAL-005 | edge-expert | 07 | 1 |
| HR-CRITICAL-001 | hr-expert | 08 | 1 |
| HR-CRITICAL-002 | hr-expert | 08 | 1 |
| HR-CRITICAL-003 | hr-expert | 08 | 1 |
| HR-CRITICAL-004 | hr-expert | 09 | 1 |
| HR-CRITICAL-005 | hr-expert | 09 | 1 |
| HR-CRITICAL-006 | hr-expert | 10 | 1 |
| ADMIN-CRITICAL-001 | admin-expert | 11 | 1 |
| ADMIN-CRITICAL-002 | admin-expert | 11 | 1 |
| ADMIN-CRITICAL-003 | admin-expert | 11 | 1 |
| ADMIN-CRITICAL-004 | admin-expert | 12 | 1 |
| ADMIN-CRITICAL-005 | admin-expert | 12 | 1 |
| ADMIN-CRITICAL-006 | admin-expert | 13 | 1 |
| ADMIN-CRITICAL-007 | admin-expert | 13 | 1 |
| PLAT-CRITICAL-001 | platform-services | 14 | 1 |
| PLAT-CRITICAL-002 | platform-services | 14 | 1 |
| PLAT-CRITICAL-003 | platform-services | 14 | 1 |
| PLAT-CRITICAL-004 | platform-services | 15 | 1 |
| PLAT-CRITICAL-005 | platform-services | 15 | 1 |
| PLAT-CRITICAL-006 | platform-services | 16 | 1 |
| DATA-CRITICAL-001 | data-expert | 17 | 1 |
| MSG-CRITICAL-001 | messaging-expert | 18 | 1 |
| MSG-CRITICAL-002 | messaging-expert | 18 | 1 |
| MSG-CRITICAL-003 | messaging-expert | 18 | 1 |
| MSG-CRITICAL-009 | messaging-expert | 19 | 1 |
| MSG-CRITICAL-018 | messaging-expert | 19 | 1 |
| MSG-CRITICAL-019 | messaging-expert | 20 | 1 |
| MSG-CRITICAL-024 | messaging-expert | 20 | 1 |
| MSG-CRITICAL-029 | messaging-expert | 21 | 1 |
| MSG-CRITICAL-030 | messaging-expert | 21 | 1 |
| DB-CRITICAL-001 | database-reviewer | 22 | 1 |
| DB-CRITICAL-002 | database-reviewer | 23 | 1 |
| DB-CRITICAL-003 | database-reviewer | 23 | 1 |

## Dependency Graph
See: docs/plans/2026-04-09-critical-fixes/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-09-critical-fixes/verification-log.md (append-only)

## Execution Notes

### Topological ordering
All 23 packages have zero hard prerequisites -- the DAG is flat. This means maximum parallelism is available: a team of 6 can execute all Sprint 0 packages simultaneously, then all Sprint 1 packages simultaneously.

### Soft dependencies (executor awareness, not blocking)
- Packages 08 + 22: both touch `employee.entity.ts` (GraphQL types vs encryption transformer). No field overlap; execute in any order.
- Packages 19 + 23: both touch `compliance-audit-log.entity.ts` (partitioning vs PK fix). Coordinate migration scripts if executed in same sprint.
- Packages 16 + 21: both implement SSRF defense. Execute 16 first and reference its pattern in 21 for consistency.

### Breaking changes requiring data-expert review
- Package 08: HR event contracts remove PII fields (BREAKING CHANGE)
- Package 18: Outbox PK changes from BIGINT to UUID (BREAKING CHANGE)

### Security-sensitive packages requiring security-reviewer gate
Packages: 03, 04, 05, 06, 07, 08, 11, 12, 13, 15, 16, 20, 21, 22 (14 of 23 packages)

### Packages requiring test-runner full regression
Packages: 08 (touches event-contracts shared lib), 17 (touches event-contracts shared lib)

## Sprint Summary

| Sprint | Packages | Findings | Theme |
|--------|----------|----------|-------|
| 0 (hotfix) | 6 | 10 | LIFE-SAFETY (01, 02) + active exploits (03, 04) + security bypass (05, 06) |
| 1 | 17 | 35 | Edge hardening, PII/GDPR, admin security, billing integrity, event store, outbox, AI safety |

## Progress Summary
Completed: 0 / 23 packages
Last Updated: 2026-04-09
