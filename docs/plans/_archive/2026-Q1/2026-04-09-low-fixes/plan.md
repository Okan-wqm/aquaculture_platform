# Implementation Plan: LOW Findings Cleanup

## Context
Generated: 2026-04-09
Base Commit: 11db862242bac680eeaaa7c85738082ff312e084
Source Reports: 1 orchestrator unified report
Total Packages: 4
CRITICAL: 0 | HIGH: 0 | MEDIUM: 0 | LOW: 20

## Source Reports
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md (severity confirmation)

## Prior Plan Reference
- docs/plans/2026-04-09-full-remediation/plan.md -- package 22 was a catch-all placeholder for 14 LOWs with generic IDs. This plan SUPERSEDES package 22 with properly decomposed, traceable packages covering all 20 LOW findings with real finding IDs.
- docs/plans/2026-04-09-full-remediation/packages/21-tenant-isolation-guard-simplification.md -- covers MEDIUM-015 and AUTH-HIGH-004 (both downgraded to LOW). NOT re-planned here; remains in the full-remediation plan.

## Package Index

### Sprint 5+ -- Backlog (all parallelizable, no dependencies)
- [ ] 01-farm-admin-code-quality -- Farm + Admin code quality: console.error guard, mock data, farm-shared docs, .js import, getAuthUserId, mixed-language errors [LOW] [parallelizable]
- [ ] 02-sensor-edge-code-quality -- Sensor + Edge code quality: dead formatUUID, channelKey dup check, unused param, #[cold] eprintln [LOW] [parallelizable]
- [ ] 03-platform-graphql-db-naming -- Platform GraphQL Float precision, SECURITY markers, storedAt/createdAt naming, feedingTime VARCHAR [LOW] [parallelizable]
- [ ] 04-data-messaging-infra -- Data infra: upcaster edge tests, bigint-string docs, IF NOT EXISTS ack, bypass RLS docs, no-DEFAULT partition docs [LOW] [parallelizable]

## Finding Coverage Matrix

| Finding ID | Source Agent | Package | Description |
|------------|-------------|---------|-------------|
| FARM-LOW-001 | farm-expert | 01 | console.error DEV-only guard |
| FARM-LOW-002 | farm-expert | 01 | mock data in batch.types.ts |
| FARM-LOW-003 | farm-expert | 01 | farm-shared only 3 files |
| FARM-LOW-004 | farm-expert | 01 | .js extension in TS import |
| ADMIN-LOW-001 | admin-expert | 01 | getAuthUserId returns '' not throw |
| ADMIN-LOW-002 | admin-expert | 01 | mixed language error messages |
| SENSOR-LOW-001 | sensor-expert | 02 | dead code formatUUID |
| SENSOR-LOW-002 | sensor-expert | 02 | createChannels no duplicate channelKey check |
| SENSOR-LOW-003 | sensor-expert | 02 | discoverChannels _tenantId unused |
| EDGE-LOW-001 | edge-expert | 02 | pre-tracing eprintln #[cold] optimization |
| PLAT-LOW-001 | platform-services | 03 | InvoiceLineItem Float GraphQL |
| PLAT-LOW-002 | platform-services | 03 | PlanPricing Float GraphQL |
| PLAT-LOW-003 | platform-services | 03 | missing SECURITY marker comments |
| DB-LOW-001 | database-reviewer | 03 | storedAt vs createdAt naming |
| DB-LOW-002 | database-reviewer | 03 | feedingTime VARCHAR not TIME |
| DATA-LOW-010 | data-expert | 04 | upcaster test edge cases |
| DATA-LOW-014 | data-expert | 04 | outbox bigint typed as string docs |
| DATA-LOW-019 | data-expert | 04 | positive: migrations IF NOT EXISTS |
| DATA-LOW-025 | data-expert | 04 | bypass RLS uses main DataSource |
| MSG-LOW-014 | messaging-expert | 04 | no DEFAULT partition prevention |

## Dependency Graph
See: docs/plans/2026-04-09-low-fixes/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-09-low-fixes/verification-log.md (append-only)

## Progress Summary
Completed: 0 / 4 packages
Last Updated: 2026-04-09
