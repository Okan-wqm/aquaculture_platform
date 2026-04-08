# Research: Billing Admin, Stripe Webhook Idempotency & Refund Audit Trail

**Topic:** Stripe webhook signature verification, plan change validation, invoice void/refund audit, subscription-module dependency
**Date:** 2026-04-08
**Agent:** admin-expert

## Sources

- [Receive Stripe events in your webhook endpoint — Stripe Documentation](https://docs.stripe.com/webhooks)
- [Resolve webhook signature verification errors — Stripe Documentation](https://docs.stripe.com/webhooks/signature)
- [Idempotent requests — Stripe API Reference](https://docs.stripe.com/api/idempotent_requests)
- [Advanced error handling — Stripe Documentation](https://docs.stripe.com/error-low-level)
- [Saga Design Pattern — Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- [PCI DSS v4.0 Requirement 10 (Logging)](https://www.pcisecuritystandards.org/document_library/)

## Key Findings

### 1. Stripe signature verification rules (non-negotiable)
- Every webhook delivery includes a `Stripe-Signature` header containing a timestamp and one or more HMAC signatures keyed with the endpoint's webhook signing secret.
- Verification MUST use Stripe's library (`stripe.webhooks.constructEvent`) which validates both signature and timestamp (default tolerance 5 minutes) to prevent replay.
- Verification requires the **raw request body**. Any middleware (like `express.json()`) that parses the body before the webhook handler BREAKS verification. The webhook endpoint must be mounted with `express.raw({ type: 'application/json' })` specifically for this route.
- The signing secret is different per endpoint and per environment; never hardcode, always read from env.
- Verification failures MUST return 400 and NOT process the event. Log at WARN with the failure reason but never log the raw signature or secret.

### 2. Webhook idempotency is mandatory and has a specific implementation shape
Stripe may retry the same event due to network issues, endpoint 5xx, or exceeded ack timeout. The canonical pattern:
1. Verify signature first.
2. Look up `event.id` in a `stripe_webhook_events` table.
3. If the row exists with status `PROCESSED`, return 200 immediately (noop).
4. If the row exists with status `PROCESSING`, return 409 (or 200 with delay) so Stripe retries later.
5. Insert the row with status `PROCESSING` **inside a transaction with the side-effect work**, or use an outbox.
6. Apply side effects.
7. Update the row to `PROCESSED`.
8. Return 200 within 5 seconds — long-running work must be queued.

**Critical:** mark the event as processed BEFORE executing irreversible side effects (sending emails, updating tenant state), or use a transactional outbox so the side effect and the idempotency record are atomic. The platform's existing outbox pattern is the right substrate.

### 3. Idempotency key vs. event ID
These are different things. The Stripe-generated `event.id` is the deduplication key for incoming webhooks. The `Idempotency-Key` header is what the platform sends on OUTGOING Stripe API calls (create subscription, create refund) so that Stripe deduplicates our retries. Both are required:
- Incoming: `event.id`-based dedup.
- Outgoing: platform-generated `Idempotency-Key` (UUID per logical operation, retained for at least 24 hours on Stripe's side).

Admin refund and void operations must set `Idempotency-Key` to prevent double refunds when an admin clicks twice.

### 4. Plan change validation: module dependency graph
A plan change modifies which modules the tenant has access to. The platform must model a dependency graph:
- Module `farm` depends on `core`.
- Module `sensor-analytics` depends on `farm`.
- Module `hr` is independent.

Plan-change validation rules:
- When downgrading, reject if the tenant currently uses a module that the new plan does not include, OR require an explicit "data will be archived" acknowledgment.
- When upgrading, compute the diff and grant only the added modules — never reset existing state.
- Plan change MUST be a saga: create new Stripe subscription item → wait for `customer.subscription.updated` webhook → mutate module grants → notify tenant admin. Each step is idempotent; compensation reverts the Stripe change.
- Pivot transaction: Stripe subscription update. After this commits, subsequent steps must be retryable (not compensatable), because voiding a subscription mid-cycle has customer-visible billing effects.

### 5. Invoice void and refund: audit + dual control + immutability
PCI DSS Requirement 10 and SOC2 CC7.2 both mandate logging of sensitive financial operations. Admin-initiated refunds and invoice voids must:
- Log initiator (SUPER_ADMIN user ID), target (tenant ID, invoice ID, customer ID), amount, currency, reason (required free-text), and timestamp.
- Store the pre-operation and post-operation Stripe state for forensic comparison.
- Be append-only: voided invoices remain visible with a voided flag, never deleted.
- Require dual control above a configurable threshold (e.g., refunds > $10,000 require a second SUPER_ADMIN approval). Below threshold, a single admin can act but a Slack alert is still sent.
- Emit a NATS `BillingRefundIssued` event that downstream services (analytics, notifications) consume.

### 6. Subscription status propagation
Stripe subscription states: `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `incomplete`, etc. These map to tenant module access:
- `active` or `trialing` → modules accessible.
- `past_due` → read-only grace period (configurable length) → eventually `unpaid`.
- `canceled` or `unpaid` → modules revoked.
- `incomplete` → modules NOT yet granted (subscription creation failed to collect payment).

Propagation must be event-driven via webhooks, not polling. Every status transition creates an audit row AND a tenant-facing notification.

### 7. Webhook endpoint operational hardening
- Endpoint is public (Stripe hits it from random IPs); authentication is the signature, not IP allowlisting (IP allowlists are fragile because Stripe's IP set changes).
- HTTPS-only with valid TLS.
- Return 2xx within 5 seconds. Long-running work → enqueue + return.
- Retries up to 3 days at exponential backoff. Beyond 3 days, Stripe stops retrying — you need a reconciliation job that polls Stripe for events the platform never received.
- Monitoring: alert on `webhook_processing_duration_seconds` p99, `webhook_signature_verification_failures_total`, `webhook_event_dedup_hits_total` (high value is normal, high rate of change is suspicious), and `webhook_processing_failures_total`.

### 8. Reconciliation job
Because webhook delivery is not guaranteed (e.g., the platform was down for more than 3 days), a scheduled reconciliation job must:
- Query Stripe for events since the last reconciliation high-water mark.
- Replay any events not already present in the `stripe_webhook_events` table.
- Reconcile subscription status from the Stripe API as the source of truth.

## Security Concerns

- **Signature bypass via body parser:** the most common Stripe integration bug. If the webhook endpoint runs after `express.json()`, the body is already parsed and signature verification fails — but a sloppy developer may "fix" it by re-serializing, which DOES NOT WORK because key order and whitespace don't round-trip. The correct fix is `express.raw()` on that specific route.
- **Webhook secret leakage:** if the webhook secret is logged during a failed verification or appears in a stack trace, rotate it immediately. Verification errors must not include the secret.
- **Replay attack:** without tolerance checking, an attacker with a captured webhook body can replay it indefinitely. `constructEvent` includes tolerance checking; custom verification implementations that skip timestamp validation are CRITICAL findings.
- **Double refund via admin double-click:** if the admin UI POSTs the refund twice and the backend does not use `Idempotency-Key` on the outgoing Stripe call, Stripe creates two refunds. Always set `Idempotency-Key` for refund/void admin operations.
- **Silent plan downgrade leak:** downgrading a plan that includes `farm` to a plan that does not grant `farm` must revoke access. If the grant is not revoked, the tenant continues using a feature they stopped paying for — a revenue leak AND a contractual violation.
- **Unauthorized refund path:** any code path that can call Stripe refund without going through the audited admin billing service is a CRITICAL finding. Refunds must be centralized.
- **PII in webhook logs:** Stripe event payloads contain customer email, name, and (for some events) partial card data. Structured log redaction is mandatory before persistence.
- **Cross-tenant webhook routing:** the webhook endpoint is shared across all tenants; the `customer.id` in the payload must be resolved to a tenant via a tenant mapping table. If the mapping is missing (e.g., tenant was deleted), the event must be parked in a dead-letter queue with alerting, not silently dropped.

## Performance Concerns

- Signature verification is CPU-bound (HMAC SHA-256). At high webhook volume, the verification path dominates latency. Keep webhook handlers lean; enqueue downstream work.
- Idempotency table lookups on every webhook should use the primary key (`event.id`) — a narrow, high-cardinality index. Avoid composite indexes that bloat the B-tree.
- Reconciliation job must not run during peak hours unless it's rate-limited; pulling thousands of events from Stripe in a tight loop will hit rate limits.
- Outgoing refund operations should be serialized per customer (not globally) to avoid Stripe rate limit on a given customer.

## Architectural Implications for admin-expert reviews

When reviewing `billing/*` controllers, services, and webhook endpoints, enforce:
1. Webhook endpoint mounts with `express.raw({ type: 'application/json' })`; the rest of the app may use `express.json()`.
2. `stripe.webhooks.constructEvent` is used for verification; custom signature logic is a CRITICAL finding.
3. A `stripe_webhook_events` table with `event.id` as PK exists, with states `PROCESSING` / `PROCESSED` / `FAILED`.
4. Webhook handler uses the transactional outbox pattern: the side-effect record and the idempotency state transition are atomic.
5. Webhook handler returns 2xx within 5 seconds; long-running work is queued via NATS or the outbox.
6. Outgoing Stripe API calls (create/update/cancel subscription, create refund, void invoice) pass `Idempotency-Key` headers.
7. Plan change is modeled as a saga with an explicit pivot transaction (Stripe subscription update) and compensations for pre-pivot steps.
8. Plan downgrade validates the module dependency graph and either rejects or requires explicit acknowledgment before proceeding.
9. Refund and void operations log initiator, target, amount, reason, pre/post Stripe state; reason is required.
10. Refunds over a configurable threshold require dual SUPER_ADMIN approval.
11. Subscription status transitions from webhooks map to tenant module access changes via the saga orchestrator, not direct writes.
12. A scheduled reconciliation job pulls Stripe events since the last watermark to cover webhook delivery failures.
13. Monitoring alerts exist for signature verification failures, processing latency, and dead-letter events.
14. Webhook payload logging redacts PII (customer email, name) before persistence.

## Domain Rule Additions for admin-expert

- Stripe webhook endpoint MUST use `express.raw({ type: 'application/json' })` and verify via `stripe.webhooks.constructEvent`; custom signature logic is a CRITICAL finding.
- Webhook handler MUST dedupe on `event.id` using a dedicated `stripe_webhook_events` table; first-write-wins via unique constraint.
- Webhook idempotency state transitions and side effects MUST be atomic via the transactional outbox; fire-and-forget side effects are CRITICAL findings.
- Webhook handler MUST return 2xx within 5 seconds; long-running work MUST be queued.
- Outgoing Stripe API calls for refunds, voids, and subscription mutations MUST pass an `Idempotency-Key` header keyed to the logical admin operation.
- Plan changes MUST be modeled as a saga with an explicit pivot transaction (the Stripe subscription update) and compensations for pre-pivot steps.
- Plan downgrade MUST validate the module dependency graph and reject or require acknowledgment before proceeding.
- Refund and void operations MUST log initiator, target, amount, reason (required), pre/post Stripe state; reason cannot be empty.
- Refunds above a configurable threshold MUST require dual SUPER_ADMIN approval and MUST emit a real-time alert on initiation and completion.
- Subscription status transitions from webhooks MUST propagate to tenant module access via the saga orchestrator; direct writes from webhook handlers are CRITICAL findings.
- A scheduled reconciliation job MUST pull Stripe events since the last watermark to cover webhook delivery gaps beyond Stripe's 3-day retry window.
- Stripe event payload logs MUST redact customer PII (email, name, partial card data) before persistence.
- Webhook signature verification failures MUST NOT include the webhook secret in logs or error responses.
- Orphaned webhooks (customer.id with no tenant mapping) MUST be parked in a dead-letter queue with alerting, not silently dropped.
