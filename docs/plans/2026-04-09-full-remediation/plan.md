# Implementation Plan: Full Platform Remediation

## Context
Generated: 2026-04-09
Base Commit: 11db862242bac680eeaaa7c85738082ff312e084
Source Reports: 6 (1 context-manager compaction + 4 expert validations + 1 orchestrator unified)
Total Packages: 23 (7 from tier1-fixes + 16 new)
CRITICAL: 0 | HIGH: 2 (tier1 packages 01-02) | MEDIUM: 19 | LOW: 2

## Source Reports
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md (primary finding source)
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md (MEDIUM/LOW detail source)
- docs/reviews/security-reviewer/2026-04-09-tenant-trust-chain-validation.md
- docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md
- docs/reviews/infra-expert/2026-04-09-nginx-websocket-validation.md
- docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md

## Prior Plan Reference
- docs/plans/2026-04-09-tier1-fixes/plan.md (packages 01-07 defined there; referenced here for completeness)

## Package Index

### Sprint 1 -- Tier 1 Security + Quick Wins (from tier1-fixes plan)
- [ ] 01-mqtt-device-event-schema-routing -- MQTT handler writes DeviceEvent to wrong schema [HIGH] [security-sensitive]
- [ ] 02-event-store-tenant-auth -- event-store-service header-only tenant ID [HIGH] [security-sensitive]
- [ ] 03-allowed-base-domains-fail-closed -- ALLOWED_BASE_DOMAINS fail-open return true [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 04-strip-tenant-header-priority-reorder -- x-tenant-id header not stripped + wrong priority [MEDIUM] [security-sensitive] (after 03)
- [ ] 05-nginx-socketio-config-sync -- nginx configs missing /socket.io/ location block [MEDIUM] [parallelizable]
- [ ] 06-mqtt-io-config-tenant-scoping -- MQTT DeviceIoConfig query without tenant scope [MEDIUM] (after 01)
- [ ] 07-hr-handlers-post-commit-refetch -- 17 HR handlers post-commit re-fetch [MEDIUM] [parallelizable]

### Sprint 1-2 -- Security Hardening + Trivial MEDIUMs (new packages)
- [ ] 08-event-contract-flat-object -- TenantModulesAssigned/ProvisioningFailed flat-object violations [MEDIUM] [parallelizable]
- [ ] 09-sensor-service-ts-ignore-worker-pool -- 3 @ts-ignore in life-safety worker pool + gateway [MEDIUM] [parallelizable]
- [ ] 10-console-log-to-logger -- 6 console.log in prod, credential vault secret leak vector [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 11-feeding-scheduler-getrepository -- 9 raw getRepository() in feeding-scheduler cron job [MEDIUM] [parallelizable]
- [ ] 12-auth-hardening-token-mfa -- Token cache staleness, bcrypt verify, MFA cross-tenant default [MEDIUM] [security-sensitive] [parallelizable]
- [ ] 14-nginx-csp-wss-only -- CSP allows ws: unencrypted WebSocket [MEDIUM] [security-sensitive] (soft dep on 05)
- [ ] 15-ci-timescaledb-image -- CI uses postgres:16 not timescaledb [MEDIUM] [parallelizable]
- [ ] 16-rust-edge-tracing -- Rust eprintln! to tracing + add Rust CI job [MEDIUM] [parallelizable]

### Sprint 2 -- Type Safety Remediation (Systemic B)
- [ ] 13-database-naming-strategy -- Mixed tenantId/tenant_id + no global SnakeNamingStrategy [MEDIUM]
- [ ] 17-farm-service-as-any -- 34 as any + 24 as unknown as in farm-service [MEDIUM] [parallelizable]
- [ ] 18-sensor-service-as-any -- 29 as any + 54 as unknown as in sensor-service [MEDIUM] [parallelizable]
- [ ] 19-remaining-services-as-any -- 13 as any + 23 as unknown as across 6 remaining services [MEDIUM] [parallelizable]
- [ ] 20-alert-engine-test-as-any -- 52 as any in safety-critical alert-engine tests [MEDIUM] [parallelizable]

### Sprint 2-3 -- Systemic Abstraction
- [ ] 23-systemic-a-tenant-context-non-http -- Platform withTenantContext() for MQTT/cron/events [MEDIUM] [security-sensitive] (after 01, 06, 11)

### Sprint 3 -- LOW Findings
- [ ] 21-tenant-isolation-guard-simplification -- Reduce guard extraction sources + string entity lookup [LOW] [security-sensitive] [parallelizable]
- [ ] 22-low-findings-cleanup -- 14 LOW findings batch cleanup [LOW] [parallelizable]

## Recommended Execution Order (Serial)

For single-executor serial execution respecting topological order with security-first tie-breaking:

| # | Package | Sprint | Rationale |
|---|---------|--------|-----------|
| 1 | 03-allowed-base-domains-fail-closed | 1 | Trivial 1-line fix, unblocks 04 |
| 2 | 01-mqtt-device-event-schema-routing | 1 | HIGH severity, unblocks 06 and 23 |
| 3 | 02-event-store-tenant-auth | 1 | HIGH severity, independent |
| 4 | 04-strip-tenant-header-priority-reorder | 1 | Depends on 03 |
| 5 | 10-console-log-to-logger | 1 | Security-sensitive (credential leak) |
| 6 | 12-auth-hardening-token-mfa | 1 | Security-sensitive (MFA default) |
| 7 | 05-nginx-socketio-config-sync | 1 | Independent MEDIUM |
| 8 | 06-mqtt-io-config-tenant-scoping | 1 | Depends on 01 |
| 9 | 07-hr-handlers-post-commit-refetch | 1 | Independent MEDIUM |
| 10 | 08-event-contract-flat-object | 1-2 | Independent MEDIUM |
| 11 | 09-sensor-service-ts-ignore-worker-pool | 1-2 | Independent MEDIUM |
| 12 | 11-feeding-scheduler-getrepository | 1-2 | Independent MEDIUM, unblocks 23 |
| 13 | 14-nginx-csp-wss-only | 2 | Soft dep on 05 (same files) |
| 14 | 15-ci-timescaledb-image | 2 | Independent MEDIUM |
| 15 | 16-rust-edge-tracing | 2 | Independent MEDIUM |
| 16 | 13-database-naming-strategy | 2 | High-risk architectural change |
| 17 | 17-farm-service-as-any | 2 | Type safety — largest service |
| 18 | 18-sensor-service-as-any | 2 | Type safety — most casts |
| 19 | 19-remaining-services-as-any | 2 | Type safety — remaining services |
| 20 | 20-alert-engine-test-as-any | 2 | Type safety — safety-critical tests |
| 21 | 23-systemic-a-tenant-context-non-http | 2-3 | Depends on 01, 06, 11 |
| 22 | 21-tenant-isolation-guard-simplification | 3 | LOW priority |
| 23 | 22-low-findings-cleanup | 3 | LOW priority, final cleanup |

## Finding Coverage Matrix

| Finding ID | Source Agent | Severity | Package | Status |
|------------|-------------|----------|---------|--------|
| AUTH-HIGH-001 | auth-security-expert | HIGH | 01 | Tier 1 |
| SEC-HIGH-002 | security-reviewer | HIGH | 02 | Tier 1 |
| SEC-HIGH-003 | security-reviewer | MEDIUM | 03 | Tier 1 |
| SEC-HIGH-001 | security-reviewer | MEDIUM | 04 | Tier 1 |
| INFRA-HIGH-001 | infra-expert | MEDIUM | 05 | Tier 1 |
| INFRA-MEDIUM-001 | infra-expert | MEDIUM | 05 | Tier 1 |
| INFRA-MEDIUM-002 | infra-expert | MEDIUM | 05 | Tier 1 |
| AUTH-HIGH-002 | auth-security-expert | MEDIUM | 06 | Tier 1 |
| AUTH-HIGH-003 | auth-security-expert | MEDIUM | 07 | Tier 1 |
| MEDIUM-001 | data-expert | MEDIUM | 08 | New |
| MEDIUM-002 | data-expert | MEDIUM | 08 | New |
| MEDIUM-003 | security-reviewer | MEDIUM | 09 | New |
| MEDIUM-006 | sensor-expert | MEDIUM | 09 | New |
| MEDIUM-005 | security-reviewer | MEDIUM | 10 | New |
| MEDIUM-007 | sensor-expert | MEDIUM | 10 | New |
| MEDIUM-008 | farm-expert | MEDIUM | 11 | New |
| MEDIUM-012 | auth-security-expert | MEDIUM | 12 | New |
| MEDIUM-013 | auth-security-expert | MEDIUM | 12 | New |
| MEDIUM-014 | auth-security-expert | MEDIUM | 12 | New |
| MEDIUM-009 | database-reviewer | MEDIUM | 13 | New |
| MEDIUM-010 | database-reviewer | MEDIUM | 13 | New |
| MEDIUM-018 | frontend-expert | MEDIUM | 14 | New |
| MEDIUM-017 | infra-expert | MEDIUM | 15 | New |
| MEDIUM-019 | edge-expert | MEDIUM | 16 | New |
| MEDIUM-020 | test-runner | MEDIUM | 16 | New |
| MEDIUM-004 | security-reviewer | MEDIUM | 17, 18, 19 | New (split by service) |
| MEDIUM-016 | multi-tenant-saas-expert | MEDIUM | 17, 18, 19 | New (split by service) |
| MEDIUM-011 | platform-services | MEDIUM | 20 | New |
| MEDIUM-015 | multi-tenant-saas-expert | LOW | 21 | New |
| AUTH-HIGH-004 | auth-security-expert | LOW | 21 | New |
| SYSTEMIC-A | context-manager | MEDIUM | 23 | New |
| LOW-001..014 | orchestrator | LOW | 22 | New |

## Systemic Patterns

### Systemic A: Tenant context unavailable in non-HTTP paths
- **Targeted fixes:** Packages 01 (MQTT DeviceEvent), 06 (MQTT IoConfig), 11 (cron scheduler)
- **Platform abstraction:** Package 23 (withTenantContext)
- **Coverage:** All 3 confirmed occurrences + prevention of future recurrence

### Systemic B: Type safety erosion (90 as any, 51 as unknown as, 3 @ts-ignore)
- **@ts-ignore:** Package 09 (3 directives)
- **as any + as unknown as by service:**
  - Package 17: farm-service (34 + 24 = 58 casts)
  - Package 18: sensor-service (29 + 54 = 83 casts)
  - Package 19: remaining services (13 + 23 = 36 casts)
  - Package 20: alert-engine tests (52 casts)
- **Total coverage:** 229 type safety violations across 4 packages

## Dependency Graph
See: docs/plans/2026-04-09-full-remediation/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-09-full-remediation/verification-log.md (append-only)

## Progress Summary
Completed: 0 / 23 packages
Last Updated: 2026-04-09
