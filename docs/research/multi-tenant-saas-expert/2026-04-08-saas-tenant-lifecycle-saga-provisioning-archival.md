# Research: SaaS Tenant Lifecycle Saga — Provisioning, Suspension, Archival, Deletion

**Topic:** End-to-end tenant state machine (PENDING → ACTIVE → SUSPENDED → ARCHIVED → DELETED) with idempotent saga, compensation, GDPR-aligned archival, retention
**Date:** 2026-04-08
**Agent:** multi-tenant-saas-expert

## Sources

- Microsoft Learn, "Managing the SaaS subscription life cycle": https://learn.microsoft.com/en-us/partner-center/marketplace-offers/pc-saas-fulfillment-life-cycle — PendingFulfillmentStart / Active / Suspended / Unsubscribed states.
- Microsoft Learn, "Tenant life cycle considerations in multitenant solutions": https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenant-life-cycle — onboarding data, trials, grace periods, decommissioning.
- AWS Cloud Operations Blog, "Managing the account lifecycle in account-per-tenant SaaS environments": https://aws.amazon.com/blogs/mt/managing-the-account-lifecycle-in-account-per-tenant-saas-environments-on-aws/ — account states, never-reuse rule.
- Martin Fowler, "Saga Pattern" and "Process Manager" references (via microservices.io / Chris Richardson).
- "Modeling Saga as a State Machine" — DZone article referencing Orchestration vs Choreography tradeoffs.
- GDPR Art. 17 (Right to Erasure) and Art. 30 (Records of Processing Activities) — retention alignment.
- Aqua-saas codebase: `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts`, `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts`, `libs/event-contracts/src/tenant-events.ts`.

## Key Findings

1. **Canonical tenant state machine** used across major SaaS platforms: `PENDING → PROVISIONING → ACTIVE → SUSPENDED → ARCHIVED → PURGED` with two terminal error states (`PROVISIONING_FAILED`, `DELETION_FAILED`). PENDING is pre-payment / pre-confirmation; PROVISIONING is an explicit intermediate state so downstream services can reject writes to an incomplete tenant; ACTIVE is the steady state; SUSPENDED blocks user login but preserves data for billing disputes or reactivation; ARCHIVED is read-only and export-only; PURGED is physical deletion after retention window.
2. **Provisioning is a saga, not a transaction.** The steps span multiple services: Stripe customer creation, Postgres schema creation, module seeding, RLS policy installation, admin user creation, NATS stream provisioning, welcome email. No single transaction can span them. Saga pattern is mandatory.
3. **Every saga step must be classified COMPENSABLE, PIVOT, or RETRYABLE.** The PIVOT step is the one whose completion means "past the point of no return" — typically the Stripe subscription creation (money was charged). Pre-pivot failures compensate backward; post-pivot failures retry forward.
4. **Idempotency key per step.** Each step persists `(tenant_id, step_name, status, output)` so a retry of a completed step is a no-op. AWS account-per-tenant guidance: never reuse a tenant ID even after deletion — accounts tagged `ACTIVE|SUSPENDING|SUSPENDED` are never recycled.
5. **Compensation handlers are instance-scoped.** The compensation must undo exactly what THIS saga instance created (matched by saga instance ID), not what is named the same. Two concurrent `tenant-x` sagas must not step on each other.
6. **Suspension is a distinct, reversible state.** Microsoft Marketplace: "Only a suspended subscription can be reinstated." Suspension must freeze data access but preserve data, retain the Postgres schema, and pause all outbound communications.
7. **Archival is a read-only state with export availability.** GDPR Art. 30 RoPA documentation must align with actual retention windows. Data is exportable for a documented grace period (typically 30-90 days), then physically purged.
8. **PURGED is terminal and emits a proof-of-erasure certificate.** Hash-signed, append-only audit event `TenantPurged { tenantIdHash, purgedAt, operatorId, method, schemaDropped, stripeSubscriptionVoided, backupsListed }`.
9. **Grace period before deletion.** Customer subscription end → 30-day grace period with read-only access → Archived → export availability → physical purge after retention (typically 90 days for most data, 7 years for financial).
10. **Legal hold precedence.** Any tenant under `legal_hold = true` cannot be PURGED regardless of retention schedule. Legal hold flag overrides all scheduled deletion.

## Security Concerns

- **Direct state mutation outside the saga orchestrator** is a CRITICAL finding — bypasses compensation and can leave a tenant stuck in a partial state.
- **Failed compensation without alert** is CRITICAL — partial state drifts without a manual reconciliation signal.
- **Silent PURGE without proof-of-erasure audit event** violates SOC2 / GDPR evidence requirements.
- **Reusing a tenant ID after deletion** (AWS guidance) creates audit trail confusion and opens impersonation-class attacks.
- **Synchronous provisioning endpoints** that block the HTTP request on saga completion violate the async-operation pattern and are DoS-prone.
- **Billing compensation that does not verify Stripe void success** leaves orphan subscriptions charging.

## Performance Concerns

- **Synchronous provisioning timeout** — schema creation + seeding + indexing can run to minutes on large tenants. Must be async `202 Accepted + jobId`.
- **Bulk reference-data COPY** — reference data tables > 10K rows must use `COPY`, not `INSERT ... SELECT`, during provisioning.
- **Compensation retry storm** — exponential backoff with jitter, max 6 retries, then `RequiresManualReconciliation` alert.

## Architectural Implications for multi-tenant-saas-expert reviews

- Any code path that mutates `tenant.status` outside the saga orchestrator is a CRITICAL finding.
- Every saga step must have an idempotency key (`tenant_id + step_name`) and an explicit classification.
- The PIVOT step (Stripe subscription creation) must be fencing — pre-pivot = compensate, post-pivot = retry-forward.
- `PROVISIONING_FAILED` and `DELETION_FAILED` must be visible in the admin dashboard with operator-facing reconciliation tools.
- Tenant deletion must check `legal_hold` BEFORE scheduling purge.
- Tenant IDs are never reused.
- Proof-of-erasure certificate is mandatory for PURGED transition.

## Domain Rule Additions for multi-tenant-saas-expert

- **State machine:** `PENDING → PROVISIONING → ACTIVE → SUSPENDED → ARCHIVED → PURGED`, with terminal `PROVISIONING_FAILED` / `DELETION_FAILED`. Transitions outside this order = CRITICAL.
- **Saga orchestrator is the only writer of `tenant.status`.** Direct writes from controllers or handlers = CRITICAL.
- **Every saga step classified** `COMPENSABLE | PIVOT | RETRYABLE` with persisted idempotency key `(tenant_id, step_name)`. Unclassified or missing idempotency key = HIGH.
- **Compensation handler matched by saga instance ID**, not resource name. Misidentified compensation = HIGH.
- **PIVOT step is Stripe subscription creation.** Compensation must void the subscription AND verify the void succeeded before marking saga failed. Missing verification = CRITICAL (orphan billing).
- **Provisioning endpoint is async** (`202 Accepted + jobId`). Synchronous provisioning = HIGH.
- **Tenant row carries `status = PROVISIONING` semantic lock** until the saga reaches a terminal state; other services honor it.
- **Suspension preserves data** — schema not dropped, Redis namespace preserved. Data deletion on suspend = CRITICAL.
- **Archival is read-only + export-enabled.** Any write attempt on archived tenant = HIGH.
- **PURGED requires proof-of-erasure event** (`TenantPurged` — hash-signed, append-only). Missing event = CRITICAL.
- **Legal hold precedence:** `legal_hold = true` blocks PURGE regardless of retention schedule. Missing check = CRITICAL.
- **Tenant IDs never reused** after any non-PENDING state. Reuse = CRITICAL.
- **Compensation failure after retry exhaustion** enqueues `RequiresManualReconciliation` alert visible in admin dashboard. Missing = HIGH.
