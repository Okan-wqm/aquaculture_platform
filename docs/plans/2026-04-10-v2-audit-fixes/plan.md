# Implementation Plan: V2 Full Repo Audit Fixes

## Context
Generated: 2026-04-10
Base Commit: ddac7551906c2f587ecf898b9a5df6badd3981f8
Total Packages: 37
CRITICAL: 15 | HIGH: 33 | MEDIUM: 10 | LOW: 0

## Source Reports
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md (primary -- compacted consolidation)
- /var/aqua-saas/docs/reviews/admin-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/auth-security-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/data-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/edge-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/farm-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/hr-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/infra-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/messaging-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/platform-services/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/sensor-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/test-runner/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/mcp-expert/2026-04-10-full-repo-audit.md

## Prior Plan Deduplication
Six prior plans exist under docs/plans/2026-04-09-*/ with 0/101 total packages completed (all verification logs empty). The 2026-04-10 audit represents a fresh re-audit of the same codebase. Finding IDs use different namespaces (04-09 used agent-prefixed IDs like EDGE-CRITICAL-004; 04-10 uses per-agent sequential IDs like CRITICAL-001). No prior packages are marked DONE. This plan is authoritative for the 2026-04-10 audit cycle and supersedes all 2026-04-09 plans for overlapping concerns.

## Package Index

### Sprint 0 -- LIFE-SAFETY + CRITICAL Security (deploy blockers)
- [ ] 01-edge-boot-safe-state -- Apply safe-state before control runtime on edge boot [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 02-jwt-asymmetric-signing -- Migrate platform JWTs from HS256 shared-secret to asymmetric RS256/JWKS [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 03-event-bus-pii-removal -- Remove PII and secret-bearing URLs from immutable event bus payloads [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 04-infra-postgres-per-service-roles -- Switch production PostgreSQL from shared superuser to per-service roles [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 05-infra-nats-per-service-accounts -- Move NATS from shared broker identity to per-service accounts with subject ACLs [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 06-ai-conversation-tenant-isolation -- Enforce tenantId+userId on AI conversation lookups and mutations [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 07-fe-remote-integrity-full-coverage -- Extend shell remote integrity guard to all federation scripts [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 08-fe-offline-cache-tenant-namespace -- Add tenant prefix to all AquaMobil offline cache keys [CRITICAL] [security-sensitive] [parallelizable]
- [ ] 09-hr-audit-log-coverage -- Add @AuditLog() to all HR mutation handlers [CRITICAL] [security-sensitive]
- [ ] 10-hr-outbox-migration -- Replace direct eventBus.publish() with transactional outbox in HR handlers [CRITICAL] (after 09)
- [ ] 11-db-migration-tree-restore -- Restore canonical DDL in empty migration files [CRITICAL] [parallelizable]
- [ ] 12-migration-search-path-fix -- Replace session-scoped SET search_path with SET LOCAL or schema-qualified identifiers [CRITICAL] [parallelizable]
- [ ] 13-sensor-metrics-time-bound -- Add time-range predicate to getLastReadings() hypertable query [CRITICAL] [parallelizable]
- [ ] 14-hydroponics-decimal-math -- Migrate hydroponics nutrient math from native number to Decimal/fixed-point [CRITICAL] [parallelizable]

### Sprint 1 -- HIGH Priority Architectural Fixes
- [ ] 15-gateway-tenant-lookup-registration -- Register TenantLookupService in gateway module [HIGH] [security-sensitive] [parallelizable]
- [ ] 16-security-events-flatten -- Flatten security events to comply with flat-event contract [HIGH] (after 03)
- [ ] 17-tenant-id-uuid-convergence -- Converge tenant_id to explicit UUID type across all entities [HIGH] (after 04)
- [ ] 18-sensor-precision-decimal -- Migrate sensor/VFD threshold and audit columns from float to numeric [HIGH] [parallelizable]
- [ ] 19-messaging-receipt-uniqueness -- Redesign message_receipts to enforce logical uniqueness across partitions [HIGH] [parallelizable]
- [ ] 20-messaging-tenant-id-write-paths -- Thread tenantId into all messaging write paths [HIGH] [security-sensitive] (after 06)
- [ ] 21-farm-batch-close-fixes -- Fix closeBatch OTHER bypass and argument ordering corruption [HIGH] [parallelizable]
- [ ] 22-farm-tank-capacity-enforcement -- Enforce hard capacity limits in allocate-to-tank handler [HIGH] (after 21)
- [ ] 23-fe-csp-remove-unsafe-inline -- Remove unsafe-inline from shell fallback CSP [HIGH] [security-sensitive] [parallelizable]
- [ ] 24-supply-chain-immutable-pins -- Pin base images by digest, actions by SHA, verify external downloads [HIGH] [security-sensitive] [parallelizable]
- [ ] 25-infra-immutable-deploy-tags -- Deploy by immutable image tag, expand Trivy scanning to all images [HIGH] (after 24)
- [ ] 26-mcp-security-hardening -- Fix prompt injection, refresh token acceptance, partial failure masking [HIGH] [security-sensitive] [parallelizable]

### Sprint 2 -- Remaining HIGH
- [ ] 27-platform-kernel-event-bus-hardening -- Fix event bus fail-open startup, handler ack-on-failure, subscription await [HIGH] [parallelizable]
- [ ] 28-admin-schema-delete-audit -- Add confirmation token and audit trail to tenant schema hard delete [HIGH] [security-sensitive] [parallelizable]
- [ ] 29-edge-scada-pwa-self-contained -- Vendor SCADA PWA assets locally, remove CDN dependencies [HIGH] [parallelizable]
- [ ] 30-edge-mqtt-failover-wiring -- Wire FailoverManager into MQTT runtime or fail failover commands explicitly [HIGH] [parallelizable]
- [ ] 31-hr-employee-pii-masking -- Mask employee PII in default detail view, gate full PII behind privileged role [HIGH] [security-sensitive] [parallelizable]
- [ ] 32-tenant-provisioning-lifecycle -- Keep tenant PENDING until provisioning saga completes, rollback on failure [HIGH] [security-sensitive] [parallelizable]
- [ ] 33-ai-quota-fail-closed -- Fail closed when Redis unavailable for AI quota enforcement in production [HIGH] [security-sensitive] [parallelizable]
- [ ] 34-platform-services-audit-security -- Billing audit trail, event-store tenant-safe projections, webhook encryption fail-closed [HIGH] [security-sensitive] [parallelizable]
- [ ] 35-sensor-pagination-installer-fix -- Clamp sensorRawList pagination and fix installer TLS hardcode [HIGH] [parallelizable]

### Sprint 2 -- MEDIUM
- [ ] 36-admin-db-management-fixes -- Fix DB explorer write path, restore targetSchema, clear query history on logout [MEDIUM] [parallelizable]
- [ ] 37-test-infra-ci-hardening -- Fix tenant-admin vitest env, add backend service test suites, npm ci in CI, W3C trace IDs, plan limit enforcement, MCP degraded discovery [MEDIUM] [parallelizable]

## Dependency Graph
See: docs/plans/2026-04-10-v2-audit-fixes/dependency-graph.md

## Verification Log
See: docs/plans/2026-04-10-v2-audit-fixes/verification-log.md (append-only)

## Progress Summary
Completed: 0 / 37 packages
Last Updated: 2026-04-10
