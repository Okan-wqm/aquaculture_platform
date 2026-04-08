# Research: Tenant Onboarding and Offboarding Runbooks

**Topic:** Onboarding saga, trial-to-paid conversion, offboarding suspension / grace / deletion, tenant migration between tiers
**Date:** 2026-04-08
**Agent:** multi-tenant-saas-expert

## Sources

- Microsoft Learn, "Tenant life cycle considerations in multitenant solutions": https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenant-life-cycle — onboarding information, trials, decommissioning.
- Microsoft Learn, "Managing the SaaS subscription lifecycle" — PendingFulfillmentStart, Active, Suspended, Reinstated, Unsubscribed.
- AWS Well-Architected SaaS Lens — operational excellence pillar, onboarding automation.
- Google Cloud Architecture, "Multi-tenant SaaS architecture on GCP" — project-per-tenant / folder-per-tenant tradeoffs.
- Stripe Subscription lifecycle docs — grace period, dunning, cancellation.
- GDPR Art. 17 (erasure) + Art. 20 (portability) alignment.
- ISO 27001 Annex A.8 — data handling on termination.
- Aqua-saas codebase: `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts`, `apps/billing-service/src/billing/billing-scheduler.service.ts` (scheduled plan changes).

## Key Findings

1. **Onboarding is a saga, not a wizard.** The user-facing wizard collects information but the actual provisioning runs as a backend saga: `collect info → create tenant row (PENDING) → create Stripe customer → create Postgres schema → seed reference data → install RLS policies → create tenant admin user → assign modules per plan → create NATS streams → send welcome email → mark ACTIVE`. Wizard completion means "saga queued", not "tenant ready".
2. **Onboarding information contract.** Must capture: legal name, slug, primary contact email, plan tier, modules, payment method, billing address, data residency preference, tax ID (for EU B2B), terms acceptance timestamp (GDPR / SOC2 evidence).
3. **Trials are first-class tenants, not lightweight.** Microsoft Azure guidance: "trials must meet the same data security and performance requirements as full customers." A separate trial-only code path with reduced guards is an anti-pattern that has produced multiple high-profile SaaS breaches.
4. **Trial-to-paid conversion.** Must preserve all trial data, transition `plan: trial → starter/professional/enterprise/custom`, activate billing subscription, and unlock gated modules. Data migration between trial and paid tenants = BAD pattern (trials are real tenants from the start).
5. **Trial expiry grace period.** On trial end: send notification → grace period (typically 7-14 days, read-only) → offboarding saga. Never delete immediately on trial expiry.
6. **Suspension is a distinct state from offboarding.** Suspension is reversible (billing failure, compliance pause, admin action) and preserves all data. Offboarding is the path to deletion.
7. **Offboarding runbook:**
   - **Day 0** — tenant ACTIVE → subscription canceled → transition to `SUSPENDED` (grace, read-only).
   - **Day 30** — transition to `ARCHIVED` (export-only, no login). Auto-generate final export and email signed URL.
   - **Day 90** — transition to `PURGED` after retention window. Legal hold check required.
   - **Post-purge** — emit `TenantPurged` proof-of-erasure certificate, retain hashed tenant ID indefinitely.
8. **Export-before-delete is mandatory.** Per GDPR Art. 20 + Art. 17 alignment, the offboarding saga runs an auto-export BEFORE physical deletion and emails the signed URL (7-day TTL).
9. **Trial-to-paid is a saga with a pivot at Stripe subscription creation.** Pre-pivot compensation rolls back module grants; post-pivot compensation issues refund.
10. **Tenant migration between tiers** (upgrade/downgrade) uses the plan-change saga from the plan-tier research file. Migration between data residency regions is a separate, heavier saga involving replication and validation.
11. **Onboarding idempotency.** Every onboarding saga step is keyed by `(tenant_id, step_name)` so a retried step does not create duplicate Stripe customers or duplicate schemas.
12. **Partial-provisioning visibility.** Tenants stuck in `PROVISIONING_FAILED` are surfaced in the admin dashboard with a `RequiresManualReconciliation` flag and reconciliation tools.
13. **Runbook documentation.** Every lifecycle transition has a written runbook in `docs/runbooks/tenant-lifecycle/` covering normal path, failure modes, manual recovery, and escalation.

## Security Concerns

- **Trial with weaker guards** = multi-tenant breach vector.
- **Onboarding email enumeration** — returning different errors for "email already used" vs "invalid input" allows account enumeration.
- **Silent offboarding without export** = GDPR Art. 20 violation.
- **Offboarding that skips legal hold check** = compliance evidence destruction.
- **Direct deletion without grace period** = accidental data loss (customer regret).
- **Trial-to-paid that migrates data between tenants** opens cross-tenant leak vectors.

## Performance Concerns

- **Synchronous onboarding wizard blocks on schema creation** — should return `202 Accepted + jobId`.
- **Reference-data seeding with `INSERT ... SELECT`** on large reference tables (>10K rows) — use `COPY` for faster provisioning.
- **Grace-period timers** — must be driven by a durable scheduler (Temporal, cron + DB), not in-memory timers.
- **Bulk export during offboarding** — must not pressure the main request DB; use a replica or dedicated connection.

## Architectural Implications for multi-tenant-saas-expert reviews

- Onboarding must be async with explicit saga, idempotency keys, and compensation handlers.
- Trials use the same code path as paid tenants — no "trial-only" guards.
- Offboarding includes auto-export + grace period + legal hold check.
- Suspension is distinct from offboarding and is reversible.
- Plan change (up / down) uses the plan-change saga with pivot at Stripe update.
- Every lifecycle transition has a documented runbook and a reconciliation dashboard.
- Partial-provisioning tenants are visible and reconcilable.

## Domain Rule Additions for multi-tenant-saas-expert

- **Onboarding is an async saga** (`202 Accepted + jobId`). Synchronous wizard = HIGH.
- **Onboarding information contract** — legal name, slug, contact email, plan, modules, payment method, billing address, data residency, tax ID (EU B2B), terms timestamp. Missing any = MEDIUM.
- **Trials use the same code paths and guards as paid tenants.** "Trial-only" guard weakening = CRITICAL.
- **Trial-to-paid is a saga with PIVOT at Stripe subscription creation.** Data migration between trial and paid tenants = CRITICAL (cross-tenant path).
- **Trial expiry grace period** (7-14 days read-only) before offboarding. Immediate deletion on trial expiry = HIGH.
- **Offboarding runbook:**
  - **Day 0** — active → suspended (read-only).
  - **Day 30** — suspended → archived (export-only). Auto-generate export + email signed URL.
  - **Day 90** — archived → purged, pending legal hold check.
- **Export-before-delete is mandatory.** Offboarding saga runs auto-export BEFORE purge, signed URL TTL ≤ 7 days. Missing = CRITICAL (GDPR Art. 20).
- **Legal hold precedence on purge.** Missing check = CRITICAL.
- **Suspension is reversible** and preserves all data. Data deletion on suspend = CRITICAL.
- **Plan change is a saga with PIVOT at Stripe update**, pre-pivot compensations rollback grants, post-pivot compensation issues refund.
- **Onboarding idempotency keys** `(tenant_id, step_name)`. Missing = HIGH.
- **Partial-provisioning dashboard visibility** with `RequiresManualReconciliation` flag. Missing = HIGH.
- **Grace period driven by durable scheduler** (not in-memory timer). In-memory timer = HIGH (lost on restart).
- **Lifecycle runbooks exist** in `docs/runbooks/tenant-lifecycle/` covering normal, failure, recovery. Missing = MEDIUM.
- **Onboarding email enumeration defense** — uniform error responses for email-exists vs invalid-input. Differentiated error = HIGH.
