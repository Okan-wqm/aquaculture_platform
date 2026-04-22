# Implementation Plan: HIGH Findings Remediation (120 Findings)

## Context
Generated: 2026-04-09
Base Commit: 11db862242bac680eeaaa7c85738082ff312e084
Source Reports: 11 agent review files + 1 orchestrator unified + 1 context-manager compaction
Total Packages: 29
CRITICAL: 0 | HIGH: 120 | MEDIUM: 0 | LOW: 0

## Source Reports
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md (unified report)
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md (compacted findings)
- docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md (5 HIGH)
- docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md (6 HIGH: 4 farm + 2 cross-domain)
- docs/reviews/edge-expert/2026-04-05-s2-high-findings.md (9 HIGH: 6 confirmed + 3 operational)
- docs/reviews/admin-expert/2026-04-05-s2-high-findings.md (10 HIGH: 7 HIGH + 1 MEDIUM + 2 supplemental)
- docs/reviews/platform-services/2026-04-05-s2-high-findings.md (12 HIGH: 7 service + 5 cross-cutting)
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md (HR 18, Messaging 24, Data 7, DB 7, Frontend 22)
- docs/reviews/data-expert/2026-04-06-nestjs-di-reflect-metadata-docker.md (DATA-HIGH-012)

## Prior Plan Check
- docs/plans/2026-04-09-tier1-fixes/ -- Covers 2 HIGH + 5 MEDIUM. Packages 01-07 NOT duplicated here.
- docs/plans/2026-04-09-full-remediation/ -- Covers MEDIUMs and LOWs. Packages 08-23 NOT duplicated here.
- This plan covers the 120 HIGH findings NOT addressed by those two plans.

## Package Index

### Sprint 2 -- Security-Critical HIGHs (Tier 0, parallelizable)
- [ ] 01-sensor-channel-idor-tenant-scoping -- Channel IDOR: 7 operations with no tenantId [HIGH] [security-sensitive] [parallelizable]
- [ ] 02-sensor-vfd-rate-limit -- VFD commands with no rate limiting, equipment damage risk [HIGH] [security-sensitive] [parallelizable]
- [ ] 03-sensor-mqtt-any-types -- MQTT listener 4x any types, Infinity persistence [HIGH] [parallelizable]
- [ ] 04-sensor-emergency-rollback-deployment-logs -- Self-approval bypass, raw SQL, token disclosure [HIGH] [security-sensitive] [parallelizable]
- [ ] 05-sensor-sql-interpolation -- TimeBucketService and FeedingScheduler SQL interpolation [HIGH] [security-sensitive] [parallelizable]
- [ ] 06-edge-mqtt-tls-command-replay -- Dead verify_hostname config, no command dedup [HIGH] [security-sensitive] [parallelizable]
- [ ] 07-edge-modbus-write-whitelist -- No per-device register address whitelist [HIGH] [security-sensitive] [parallelizable]
- [ ] 08-edge-ffi-unwrap-h2-dep -- FFI bounds assertion, unwrap in prod, cargo-deny CI [HIGH] [parallelizable]
- [ ] 09-edge-scada-cancellation-mqtt-jitter -- SCADA 0.0.0.0 bind, no graceful shutdown, thundering herd [HIGH] [parallelizable]
- [ ] 10-admin-audit-trail-wiring -- 6 admin findings: audit, impersonation, migration identity [HIGH] [security-sensitive] [parallelizable]
- [ ] 12-platform-crypto-salt-gcm-aad -- scrypt salt from key, GCM IV 16->12, no AAD binding [HIGH] [security-sensitive] [parallelizable]
- [ ] 17-hr-gdpr-payroll-audit -- Plan-entry regression, GDPR erasure, salary RBAC, PII, payroll float [HIGH] [security-sensitive] [parallelizable]
- [ ] 20-data-event-contracts-tenant -- tenantId optional, flat-object violations, NATS tenant validation [HIGH] [security-sensitive] [parallelizable]
- [ ] 23-messaging-compliance-audit-gdpr -- Idempotency, audit immutability, legal hold, GDPR partition [HIGH] [security-sensitive] [parallelizable]
- [ ] 25-messaging-embedding-vector-tenant -- SKIP LOCKED, wrong schema, vector search tenantId [HIGH] [security-sensitive] [parallelizable]
- [ ] 26-messaging-tenant-isolation-nats -- synchronize:true, conversation tenant, NATS subjects [HIGH] [security-sensitive] [parallelizable]
- [ ] 27-frontend-module-federation-auth -- strictVersion, logout cleanup, token lifecycle, offline key [HIGH] [security-sensitive] [parallelizable]

### Sprint 2 -- Non-Security HIGHs (Tier 0, parallelizable)
- [ ] 13-platform-billing-integrity -- Payment idempotency, previousPlanTier, invoice immutability [HIGH] [parallelizable]
- [ ] 15-farm-event-publishing-transactions -- 4 handlers: missing TX, duplicate codes, missing event [HIGH] [parallelizable]
- [ ] 21-database-float-timestamp-naming -- tenant_id, timestamptz, numeric, naming, audit columns [HIGH] [parallelizable]

### Sprint 3 -- Remaining HIGHs (Tier 0, parallelizable)
- [ ] 11-admin-remaining-high -- SQL interpolation, monitoring identity, async provisioning [HIGH] [security-sensitive] [parallelizable]
- [ ] 14-platform-remaining-high -- Event-store guard, secrets in getAll, retry jitter, PII, pH bounds [HIGH] [security-sensitive] [parallelizable]
- [ ] 18-hr-state-machine-overtime-conflict -- Accrual O(N^2), state machine, overtime, conflict lock [HIGH] [parallelizable]
- [ ] 19-hr-outbox-repo-i18n -- Cert TX, repo scoping, outbox, floating promise, national ID, i18n [HIGH] [security-sensitive] [parallelizable]
- [ ] 24-messaging-ai-safety-injection -- Instruction hierarchy, PII filter, tool validation, consent [HIGH] [security-sensitive] [parallelizable]
- [ ] 28-frontend-security-a11y -- Push URL, WebSocket token, CSP, fetch bypass, a11y [HIGH] [security-sensitive] [parallelizable]
- [ ] 29-frontend-i18n-date-remaining -- i18n infrastructure, timezone dates, XSS, performance [HIGH] [parallelizable]

### Sprint 3 -- Tier 1 (has prerequisites)
- [ ] 16-farm-outbox-cron-lifecycle -- Water quality outbox, cron tenant context (after 20) [HIGH] [parallelizable]
- [ ] 22-messaging-outbox-idempotency -- Nats-Msg-Id, backoff, dead-letter metrics, message tenantId (after 20, 21) [HIGH] [parallelizable]

## Finding Coverage Matrix

| Domain | Finding IDs | Package(s) | Count |
|--------|------------|------------|-------|
| Sensor | SENSOR-HIGH-001 to 005 | 01, 02, 03, 04, 05 | 5 |
| Edge | EDGE-HIGH-001 to 009 | 06, 07, 08, 09 | 9 |
| Admin | ADMIN-HIGH-001 to 010 | 10, 11 | 10 |
| Platform | PLAT-HIGH-001 to 012 | 12, 13, 14 | 12 |
| Farm | FARM-HIGH-001 to 004, S2-HIGH-003, S2-HIGH-005 | 15, 16 | 6 |
| HR | HR-HIGH-001 to 018 | 17, 18, 19 | 18 |
| Data | DATA-HIGH-002 to 005, 012, 016, 020 | 20 | 7 |
| Database | DB-HIGH-001 to 007 | 21 | 7 |
| Messaging | MSG-HIGH-004 to 052 (24 findings) | 22, 23, 24, 25, 26 | 24 |
| Frontend | FE-HIGH-004 to 036 (22 findings) | 27, 28, 29 | 22 |
| **Total** | | **29 packages** | **120** |

## Recommended Execution Order (Serial)

For single-executor serial execution respecting topological order with security-first tie-breaking:

| # | Package | Sprint | Rationale |
|---|---------|--------|-----------|
| 1 | 01-sensor-channel-idor-tenant-scoping | 2 | IDOR cluster, cross-tenant read/write/delete |
| 2 | 06-edge-mqtt-tls-command-replay | 2 | IEC 62443 safety, command replay |
| 3 | 07-edge-modbus-write-whitelist | 2 | IEC 62443 actuator control |
| 4 | 10-admin-audit-trail-wiring | 2 | 6 audit/identity findings |
| 5 | 12-platform-crypto-salt-gcm-aad | 2 | Cryptographic weakness |
| 6 | 20-data-event-contracts-tenant | 2 | Shared lib, unblocks 16 + 22 |
| 7 | 25-messaging-embedding-vector-tenant | 2 | Cross-tenant vector search |
| 8 | 26-messaging-tenant-isolation-nats | 2 | Cross-tenant messaging |
| 9 | 27-frontend-module-federation-auth | 2 | Auth token lifecycle |
| 10 | 02-sensor-vfd-rate-limit | 2 | Equipment safety |
| 11 | 04-sensor-emergency-rollback-deployment-logs | 2 | Four-eyes principle |
| 12 | 05-sensor-sql-interpolation | 2 | SQL injection |
| 13 | 17-hr-gdpr-payroll-audit | 2 | GDPR + salary RBAC |
| 14 | 23-messaging-compliance-audit-gdpr | 2 | GDPR compliance |
| 15 | 03-sensor-mqtt-any-types | 2 | Data integrity |
| 16 | 08-edge-ffi-unwrap-h2-dep | 2 | Edge reliability |
| 17 | 09-edge-scada-cancellation-mqtt-jitter | 2 | Edge reliability |
| 18 | 13-platform-billing-integrity | 2 | Billing accuracy |
| 19 | 15-farm-event-publishing-transactions | 2 | CQRS compliance |
| 20 | 21-database-float-timestamp-naming | 2 | Schema correctness, unblocks 22 |
| 21 | 16-farm-outbox-cron-lifecycle | 3 | Depends on 20 (event contracts) |
| 22 | 22-messaging-outbox-idempotency | 3 | Depends on 20 + 21 |
| 23 | 11-admin-remaining-high | 3 | Remaining admin |
| 24 | 14-platform-remaining-high | 3 | Remaining platform |
| 25 | 18-hr-state-machine-overtime-conflict | 3 | Business logic |
| 26 | 19-hr-outbox-repo-i18n | 3 | HR reliability + i18n |
| 27 | 24-messaging-ai-safety-injection | 3 | AI safety |
| 28 | 28-frontend-security-a11y | 3 | Security + a11y |
| 29 | 29-frontend-i18n-date-remaining | 3 | i18n + performance |

## Dependency Graph
See: docs/plans/2026-04-09-high-fixes/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-09-high-fixes/verification-log.md (append-only)

## Progress Summary
Completed: 0 / 29 packages
Last Updated: 2026-04-09
