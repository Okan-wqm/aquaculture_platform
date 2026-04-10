# Data Expert Review
**Date:** 2026-04-10
**Scope:** Full-repo audit for `libs/event-contracts/**`, `database/migrations/**`, `apps/*/src/**/entities/*.entity.ts`, tenant schema/data scripts, and adjacent data-flow-critical shared code
**Decision:** **BLOCK**

## Summary
| Severity | Count |
|---|---:|
| CRITICAL | 2 |
| HIGH | 2 |
| MEDIUM | 0 |
| LOW | 0 |

## Findings

### CRITICAL-001
PII and secret-bearing reset URLs are published on the immutable event bus without any implemented crypto-shred or indirection path.

Evidence:
- [`/var/aqua-saas/libs/event-contracts/src/auth-events.ts:31-52`](/var/aqua-saas/libs/event-contracts/src/auth-events.ts#L31-L52)
- [`/var/aqua-saas/libs/event-contracts/src/notification-events.ts:6-23`](/var/aqua-saas/libs/event-contracts/src/notification-events.ts#L6-L23)
- [`/var/aqua-saas/libs/event-contracts/src/base-event.ts:103-115`](/var/aqua-saas/libs/event-contracts/src/base-event.ts#L103-L115)

Why this is a blocker:
- `PasswordResetRequestedEvent` carries `email` and `actionUrl`, and the comment says `actionUrl` contains the full reset link.
- `UserInvitedEvent` carries `email`, `firstName`, `lastName`, `tenantName`, and `actionUrl` with embedded tokens.
- `BaseEvent` exposes `cryptoShredKeyId`, but I found no producer call sites in the repo that set it.
- These payloads are immutable once published, so the event store becomes a permanent PII/token archive.

Remediation:
- Remove secret-bearing URLs and raw PII from event payloads.
- Emit opaque references or lookup keys, then resolve the sensitive data in a purpose-built store at delivery time.
- If PII must stay on the bus, make `cryptoShredKeyId` mandatory for those event types and enforce it at producer boundaries.

Cross-domain dependencies:
- `auth-security-expert`
- `security-reviewer`
- `notification-service` owners

### HIGH-002
Security events violate the flat-event contract by embedding a nested `details` bag, and they collapse all subtypes behind a generic `SecurityEvent` discriminator.

Evidence:
- [`/var/aqua-saas/libs/event-contracts/src/security/security-events.ts:28-36`](/var/aqua-saas/libs/event-contracts/src/security/security-events.ts#L28-L36)
- [`/var/aqua-saas/libs/event-contracts/src/security/security-events.ts:43-50`](/var/aqua-saas/libs/event-contracts/src/security/security-events.ts#L43-L50)
- [`/var/aqua-saas/libs/event-contracts/src/security/security-events.ts:57-63`](/var/aqua-saas/libs/event-contracts/src/security/security-events.ts#L57-L63)
- [`/var/aqua-saas/libs/event-contracts/src/security/security-events.ts:168-174`](/var/aqua-saas/libs/event-contracts/src/security/security-events.ts#L168-L174)

Why this is high risk:
- `BaseEvent` explicitly says events must stay flat.
- `details: Record<string, unknown>` is a nested wrapper object, so downstream schemas cannot rely on a stable top-level shape.
- The `eventType` is always `SecurityEvent`, which forces consumers to inspect a second discriminator and weakens routing/validation guarantees.

Remediation:
- Flatten each security event into explicit top-level fields, or split the subtypes into separate event contracts with strict schemas.
- If some telemetry remains dynamic, move it out of the event contract entirely and keep only opaque references on the bus.

Cross-domain dependencies:
- `security-reviewer`
- `auth-security-expert`
- `platform-kernel-expert`

### HIGH-003
Tenant identity is modeled inconsistently across entity classes: several entities rely on implicit TypeORM defaults for `tenant_id` and `config-service` explicitly uses a non-UUID `global` sentinel.

Evidence:
- [`/var/aqua-saas/apps/alert-engine/src/audit/entities/audit-entry.entity.ts:25-26`](/var/aqua-saas/apps/alert-engine/src/audit/entities/audit-entry.entity.ts#L25-L26)
- [`/var/aqua-saas/apps/billing-service/src/billing/entities/invoice.entity.ts:109-111`](/var/aqua-saas/apps/billing-service/src/billing/entities/invoice.entity.ts#L109-L111)
- [`/var/aqua-saas/apps/billing-service/src/billing/entities/payment.entity.ts:92-94`](/var/aqua-saas/apps/billing-service/src/billing/entities/payment.entity.ts#L92-L94)
- [`/var/aqua-saas/apps/billing-service/src/billing/entities/subscription.entity.ts:101-103`](/var/aqua-saas/apps/billing-service/src/billing/entities/subscription.entity.ts#L101-L103)
- [`/var/aqua-saas/apps/notification-service/src/notification/entities/notification-log.entity.ts:51-52`](/var/aqua-saas/apps/notification-service/src/notification/entities/notification-log.entity.ts#L51-L52)
- [`/var/aqua-saas/apps/alert-engine/src/database/entities/alert-incident.entity.ts:94-97`](/var/aqua-saas/apps/alert-engine/src/database/entities/alert-incident.entity.ts#L94-L97)
- [`/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts:62-65`](/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts#L62-L65)
- [`/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts:190-192`](/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts#L190-L192)
- [`/var/aqua-saas/apps/config-service/src/configuration/query-handlers/get-configuration.handler.ts:30-48`](/var/aqua-saas/apps/config-service/src/configuration/query-handlers/get-configuration.handler.ts#L30-L48)

Why this is high risk:
- `@Column({ name: 'tenant_id' })` with no explicit type defaults to varchar in TypeORM.
- That diverges from the platform-wide UUID tenant model and makes RLS, cross-service joins, and migration convergence harder to reason about.
- `config-service` is even more explicit: it treats `tenantId === 'global'` as a first-class code path, which cannot satisfy a UUID-only contract.

Remediation:
- Make `tenant_id` explicit `uuid` in every tenant-scoped entity.
- For system-wide configuration, use a reserved system tenant UUID or split the data into a separate table instead of a string sentinel.
- Add a schema audit/migration to converge existing drift before more tenant-scoped tables are introduced.

Cross-domain dependencies:
- `database-reviewer`
- `platform-kernel-expert`
- `config-service` owners

### CRITICAL-004
Migration code uses session-scoped `SET search_path TO farm, public`, which can contaminate pooled connections and point later statements at the wrong schema.

Evidence:
- [`/var/aqua-saas/apps/farm-service/src/database/migrations/1769000000000-AddRegulatorySettings.ts:24-29`](/var/aqua-saas/apps/farm-service/src/database/migrations/1769000000000-AddRegulatorySettings.ts#L24-L29)
- [`/var/aqua-saas/apps/farm-service/src/database/migrations/1769000000000-AddRegulatorySettings.ts:141-146`](/var/aqua-saas/apps/farm-service/src/database/migrations/1769000000000-AddRegulatorySettings.ts#L141-L146)
- [`/var/aqua-saas/apps/farm-service/src/database/migrations/add-system-hierarchy.sql:9-10`](/var/aqua-saas/apps/farm-service/src/database/migrations/add-system-hierarchy.sql#L9-L10)

Why this is a blocker:
- `SET search_path` is connection-scoped, not transaction-local.
- In TypeORM-style pooled migration runners, that can leak into later queries on the same connection and target the wrong schema.
- The SQL script also relies on the same pattern, so the contamination risk is repeated in more than one migration surface.

Remediation:
- Replace session-scoped `SET search_path` with `SET LOCAL search_path` inside an explicit transaction.
- Better: fully schema-qualify every identifier and avoid mutating connection state at all.

Cross-domain dependencies:
- `infra-expert`
- `platform-kernel-expert`
- `farm-service` owners
