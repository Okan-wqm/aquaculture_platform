# Research: Tenant Lifecycle Saga, Idempotency, and Rollback

**Topic:** Provisioning saga idempotency, compensating transactions, tenant archival, data retention compliance
**Date:** 2026-04-08
**Agent:** admin-expert

## Sources

- [Saga Design Pattern — Microsoft Learn (Azure Architecture Center)](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- [Tenant Life Cycle Considerations in Multitenant Solutions — Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenant-life-cycle)
- [Architectural Considerations for Identity in a Multitenant Solution — Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/identity)
- [Saga Pattern in Microservices: A Mastery Guide — Temporal](https://temporal.io/blog/mastering-saga-patterns-for-distributed-transactions-in-microservices)
- [Microservices Pattern: Saga — microservices.io](https://microservices.io/patterns/data/saga.html)
- [GDPR Article 17 Right to Erasure](https://gdpr-info.eu/art-17-gdpr/)

## Key Findings

### 1. Saga = sequence of local transactions with explicit compensations
Microsoft Learn defines the saga as: each step is a local ACID transaction in one service; if any step fails, the orchestrator invokes compensating transactions in reverse order to undo prior steps. **Compensations are not automatic rollbacks** — they are first-class business operations that must be designed and tested.

### 2. Three transaction categories the platform MUST model explicitly
From Azure Architecture Center:
- **Compensable transaction:** can be undone by a counter-action (e.g., `CREATE SCHEMA` → `DROP SCHEMA`, `CREATE admin user` → `DELETE user`).
- **Pivot transaction:** the point of no return. Once committed, compensation is either impossible or would leak effects (e.g., Stripe subscription creation — voiding is possible but not silent).
- **Retryable transaction:** follows the pivot; must be idempotent and deterministic so retry is safe (e.g., welcome email enqueue, module grant writes).

Every step in `provisioning-saga.service.ts` must be classified into one of these three categories in the code (comment or enum), so reviewers can verify that steps before the pivot have compensations and steps after the pivot are retryable.

### 3. Idempotency is a property of every step, not an afterthought
Both retryable and compensable transactions must be idempotent. The Azure guide and Temporal blog both recommend an **idempotency key** per saga instance, persisted in the saga state store, so a retried step can recognize "I already did this" without re-running side effects. For tenant provisioning:
- Use the tenant UUID as the idempotency key for creation steps.
- Use `(tenant_id, step_name)` as the idempotency key for the per-step dedup row.
- Every step handler must first check the dedup row; if it exists with status `COMPLETED`, return immediately.

### 4. Compensations can fail — plan for it
Microsoft Learn explicitly warns: *"Compensating transactions might not always succeed, which can leave the system in an inconsistent state."* Response patterns:
- Compensations must themselves be retryable with exponential backoff + dead-letter.
- After N compensation failures, the saga must emit a `TenantProvisioningRequiresManualReconciliation` alert.
- A human-review queue (admin UI "stuck sagas") is mandatory, not optional.

### 5. Data anomaly countermeasures
From Azure Architecture Center, the relevant patterns for tenant provisioning:
- **Semantic lock:** mark the tenant row `status = PROVISIONING` so no other service treats it as usable. Keep the lock until the saga reaches a terminal state.
- **Pessimistic view:** order the saga so destructive or visible-to-customer effects come last. Schema creation → data seeding → module assignment → admin user creation → welcome email.
- **Version files / audit log:** persist every step transition in a saga state table for post-hoc debugging.

### 6. Tenant lifecycle states (Microsoft Learn)
Microsoft's recommended state model for tenant lifecycle:
1. **Trial:** subset of features, limits, separate isolation requirements.
2. **Active:** full service.
3. **Deactivated:** temporary pause (billing failure, customer request) — data retained.
4. **Offboarding:** in-progress removal with documented retention period.
5. **Archived:** data retained for regulatory reasons but tenant is unreachable.
6. **Purged:** data destroyed per retention schedule and erasure obligations.

The current platform states (`PENDING → ACTIVE → SUSPENDED → ARCHIVED`) are close but should add a distinct `PURGED` terminal state — archival and purge are not the same for GDPR purposes.

### 7. Data retention compliance (GDPR + SOC2)
- **Article 17 (Right to Erasure)** is not absolute — retention is permitted for legal obligations and defending legal claims. Retention schedule must be documented per data category in the Record of Processing Activities.
- **Offboarding certificate of destruction:** when the platform purges tenant data, the admin operation must generate a signed, immutable record that the purge occurred, what categories were destroyed, and when.
- **Backup obligations:** GDPR applies to backups. If the retention policy says "purge after 30 days," backups older than 30 days that still contain the tenant's PII are a compliance gap.
- **RoPA alignment:** the code's purge timeline must match the documented RoPA; drift between the two is an auditable finding.

### 8. Orchestration over choreography for tenant provisioning
Microsoft's comparison table favors orchestration for complex workflows. Tenant provisioning touches 5+ services (tenant, schema, modules, users, billing, notifications) — too complex for choreography. The existing `provisioning-saga.service.ts` orchestrator model is correct; reviewers should ensure new steps do not introduce choreography fallbacks.

## Security Concerns

- **Partial provisioning leak:** a tenant that reaches schema creation but fails before admin-user creation is a silent data island. If a SUPER_ADMIN later inspects it, they may see empty-but-valid schema and assume it's a live tenant. All partially provisioned tenants must be visibly flagged `PROVISIONING_FAILED`.
- **Compensation re-running a successful step:** if the compensation for step N runs against a state that step N already succeeded in rolling back, it could delete data from a reused resource (e.g., dropping a schema that was later reassigned). Compensations must verify they're undoing the exact version/instance they created, keyed by the saga instance ID.
- **Cross-tenant billing leak during compensation:** if the billing pivot succeeds but a later step fails, the compensation must void the subscription from Stripe. If it doesn't, a non-existent tenant is still being billed, and the next audit will raise it.
- **Retention violation via archival loophole:** marking a tenant `ARCHIVED` and never progressing to `PURGED` keeps PII alive forever. An automated retention scheduler MUST transition `ARCHIVED → PURGED` after the configured window, with audit.
- **Schema collision on retry:** if tenant creation retries after partial failure, the schema may already exist. `CREATE SCHEMA` must be `IF NOT EXISTS`, and the retry path must validate schema ownership by tenant ID (not just name).

## Performance Concerns

- Saga state writes on every step transition can become a bottleneck at tenant-onboarding spikes. Use a dedicated saga state table with a narrow schema and no global indexes beyond the saga ID.
- Synchronous orchestration blocks the HTTP request that triggered provisioning. Provisioning must be kicked off asynchronously (enqueue + return `202 Accepted` with a polling URL), not held in the request lifecycle.
- Purge operations can be heavy (`DROP SCHEMA CASCADE`, cross-service data deletion, backup pruning). Run them in a background job with idempotency and progress reporting, not inline in an admin API call.

## Architectural Implications for admin-expert reviews

When reviewing `provisioning-saga.service.ts`, the tenant controller, or tenant archival code, enforce:
1. Every saga step is classified as `COMPENSABLE | PIVOT | RETRYABLE` in the code itself.
2. Each step has a paired `compensate()` method (compensables only) that is itself idempotent and retry-safe.
3. The saga state table records every transition with the saga instance ID, step name, status, timestamps, and error details.
4. All step handlers check a per-step idempotency key before executing side effects.
5. Compensation failures after N retries enqueue a `RequiresManualReconciliation` alert with enough context for a human to fix.
6. Tenant lifecycle states include an explicit `PURGED` terminal state separate from `ARCHIVED`.
7. Retention policy is configurable per tenant/category and scheduled automatically — no manual "forgot to purge" gap.
8. Purge operations emit a `TenantPurged` audit event carrying a hash-signed payload (immutable evidence).
9. Billing compensation MUST void any subscription created by the pivot, and verify the void succeeded before marking the saga failed.
10. Partial-provisioning states are visible in the admin UI with a "retry saga" and "force compensate" action.
11. The saga orchestrator is the only code path allowed to mutate tenant lifecycle states — no direct updates from controllers.
12. Provisioning is asynchronous: endpoint returns 202 with a job ID, never blocks on the saga.

## Domain Rule Additions for admin-expert

- Every step in `provisioning-saga.service.ts` MUST be classified as COMPENSABLE, PIVOT, or RETRYABLE; unclassified steps are HIGH findings.
- Every compensable step MUST have a paired, idempotent compensation handler verified to undo exactly what the original step created (matched by saga instance ID).
- Saga steps MUST use a persisted per-step idempotency key; retrying a completed step MUST NOT produce side effects.
- Compensation failures MUST be retried with backoff and, after exhaustion, MUST enqueue a `RequiresManualReconciliation` alert visible in the admin dashboard.
- Tenant lifecycle MUST include a `PURGED` terminal state distinct from `ARCHIVED`; transition from `ARCHIVED` to `PURGED` MUST be scheduled automatically based on a documented retention policy.
- Tenant purge operations MUST emit an immutable, hash-signed `TenantPurged` audit event serving as a certificate of destruction for GDPR/SOC2 evidence.
- Partial-provisioning (saga failed) tenants MUST be visibly flagged in the admin UI; reviewers must block PRs that leave these in a silent intermediate state.
- The saga orchestrator MUST be the only code path mutating tenant lifecycle states; direct writes from controllers/services are CRITICAL findings.
- Tenant provisioning endpoints MUST be asynchronous (202 Accepted + job ID), never synchronously waiting for the saga to complete.
- Retention policy configuration (days per data category) MUST match the platform's RoPA documentation; drift is an auditable compliance gap.
