# Billing, revenue and admin duplicates — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `billing-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | apps/billing-service, admin-api billing surfaces, Stripe webhook, plan enforcement |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

The platform cannot collect money from customers, and a customer who stops paying keeps full
access.

## Blockers

- **B1. Stripe and the local ledger are disconnected.**
  - Nothing ever writes `stripeInvoiceId` (`invoice.entity.ts:226`). When Stripe charges a
    subscription, `payment_intent.succeeded` finds no owning invoice and is still acked as success
    (`stripe-webhook.service.ts:115-121,182-187`). Meanwhile the scheduler raises parallel local
    invoices nobody pays (`billing-scheduler.service.ts:245-411`).
  - Stripe bills the plan price id (`stripe-subscription-provisioner.service.ts:74-98`), but local
    `basePrice` is the sum of the module items (`billing-admin-nats.handler.ts:239-249`). The two
    amounts differ.
  - A local TRIAL (`:662`) is created in Stripe with no trial
    (`stripe-client.factory.ts:174-188`), so Stripe charges on day 0.
  - Nothing collects a payment method anywhere: no SetupIntent, Checkout or Stripe.js in `apps/`
    or `web/`.
- **B2. Non-payment never revokes access.**
  - The gateway only blocks `auth.tenants.status=SUSPENDED` (`tenant-context.middleware.ts:284`).
    Nothing in billing ever leads to that suspension.
  - PAST_DUE, CANCELLED and EXPIRED writes (`stripe-webhook.service.ts:499,562`;
    `billing-scheduler.service.ts:85,156`) emit no `TenantSubscriptionChanged`, and that
    projection carries no status anyway (`tenant-subscription-projection.handler.ts:110`).
  - PAST_DUE has no way out and no escalation: the webhook handles neither `invoice.paid` nor
    `customer.subscription.updated` (controller `:34-40`).
  - `InvoiceOverdue` has no producer, and every notification billing handler only logs
    (`billing-event.handler.ts:95-128`). No dunning email is ever sent.
- **B3. Production defaults to mock billing.**
  - `docker-compose.droplet.yml:1367` sets `BILLING_PROVIDER:-mock`. Nothing rejects mock or
    `sk_test_` when `NODE_ENV=production` (`stripe-client.factory.ts:370-398`).
  - The mock's refund returns `succeeded` without moving any money
    (`mock-billing.provider.ts:133-148`).
- **B4. Invoices are not legally compliant.**
  - Auto-invoices carry no tax (`billing-scheduler.service.ts:394`), and the billing address is
    filled with the tenantId (`:346`).
  - Invoice numbers are random, not sequential, and two copies of the generator have drifted apart
    (`billing-scheduler.service.ts:470-477`; `create-invoice.handler.ts:179-188`).
  - KDV is hard-coded at 18%, but the statutory rate is 20%
    (`metered-billing.service.ts:580-586`). Stripe Tax is not used.

## Major

- **Webhook events can be lost.**
  - The dedup row is committed before the handler runs (controller `:258`). If the process crashes
    mid-handler, Stripe's retry hits the unique key, gets a 200 "duplicate", and the event is
    gone.
  - Rows marked `handler-error` are never replayed: nothing reads that table. There is no
    event-ordering guard.
- **Events can still be dropped** in the webhook and scheduler paths: they publish without the
  outbox and swallow errors (`stripe-webhook.service.ts:303,434,588`;
  `billing-scheduler.service.ts:94,167,401`).
- **A paid tier with no Stripe price id is provisioned silently and never billed**; it only logs a
  WARN (provisioner `:75-80`).
- **Duplicate Stripe subscriptions on late retries.** The Stripe call happens before the receipt
  check (`billing-admin-nats.handler.ts:209` vs `:218`) and passes no existing customer. Stripe
  forgets idempotency keys after 24 h, so a provisioning retry after that creates a second
  customer and subscription.
- **Plan features are not enforced.**
  - `hasTenantFeature`/`tenantHasFeature` have no production callers. The `maxApiRequests` and
    `maxStorageGb` limits are not enforced.
  - Count quotas are skipped when the token has no `planLevel` (`create-site.handler.ts:58`). A
    downgrade does not check current usage against the new limits
    (`change-subscription-plan.handler.ts:159-205`).
- **Metered usage does nothing:** nothing calls `recordUsage` and nothing calls
  `reportMeterEvent`.

## Minor

- Webhook signature parsing keeps only the last `v1` signature (controller `:464-471`), which
  breaks during a secret rotation.
- The `BILLING_ADMIN`/`FINANCE_MANAGER` roles do not exist in RBAC (`billing.resolver.ts:38-80`).
- A partial refund re-opens the invoice's amount due (`refund-payment.handler.ts:161`).

## Registry

| ID | Result | Note |
| --- | ------ | ---- |
| BILLING-CRITICAL-001 (RESOLVED) | Should be reopened | Fixed in command handlers only; the webhook and scheduler paths still publish without the outbox |
| BILLING-HIGH-002 | CONFIRMED | `reserve()` has no caller outside tests |
| BILLING-HIGH-014 | PARTIAL | Raw INSERT still there (`:677`), but provisioning now has receipt-based idempotency |
| BILLING-MEDIUM-005 | CONFIRMED | Gross is not rounded (`billing-cycle-terms.ts:133`) |
| BILLING-MEDIUM-016 | CONFIRMED | `invoice.entity.ts:193` |
| BILLING-MEDIUM-002/003 | Not verified | Test fixtures |
| ADMIN-CRITICAL-087 | CONFIRMED | Admin `announcements`/`support\_tickets`/`ticket\_comments`/`message\_threads` (`support.entity.ts:36-359`) duplicate the auth tables; `AnnouncementService` writes only the admin copy and never forwards it; the controllers are mounted |
| ADMIN-MEDIUM-120 | CONFIRMED | `external/invoice.entity.ts:46-56` |
| ADMIN-HIGH-089 | CONFIRMED | `analytics.service.ts:294` |
| ADMIN-HIGH-099 | CONFIRMED | `reports.service.ts:845-847` |
| ADMIN-HIGH-126 | CONFIRMED, partly mitigated | By the `unavailable` flag |
| ADMIN-HIGH-088 | STALE | No `@EventPattern` remains |
| ADMIN-HIGH-086 | PARTIAL | About 130 un-piped `@Param` values |
| MT-HIGH-002 | Partly STALE | Count quotas are now enforced; feature gates are not |

## Orchestrator verification

- Verified in the working tree: `BILLING_PROVIDER: ${BILLING_PROVIDER:-mock}` and
  `STRIPE_BILLING_ENABLED` default false in `docker-compose.droplet.yml` (the compose comment
  calls mock the deliberate demo-droplet default); no SetupIntent, Checkout session, `loadStripe`
  or `@stripe/stripe-js` reference exists in `apps/` or `web/`.

## Not verified

- Stripe dashboard settings (subscribed webhook events, retry/dunning), whether
  `billing.plans.stripe_price_ids` is populated, the droplet's real `.env`, and runtime tests.

## Registry entries

This review appended 15 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| BILLING-CRITICAL-035 | CRITICAL | Stripe and the local ledger are disconnected: nothing writes invoice.stripeInvoiceId so payment\_intent.succeeded finds no invoice and is still acked, the scheduler raises parallel local invoices nobody pays, Stripe bills the plan price while local basePrice sums module items, and a local TRIAL is created in Stripe without a trial so it charges on day 0 |
| BILLING-CRITICAL-036 | CRITICAL | Nothing collects a payment method anywhere: there is no SetupIntent, Checkout session or Stripe.js flow in apps/ or web/, so a Stripe subscription cannot be charged |
| BILLING-CRITICAL-037 | CRITICAL | Non-payment never revokes access: the gateway only blocks tenants with status SUSPENDED and nothing in billing leads to that suspension, PAST\_DUE/CANCELLED/EXPIRED writes emit no TenantSubscriptionChanged, PAST\_DUE has no exit (the webhook handles neither invoice.paid nor customer.subscription.updated), InvoiceOverdue has no producer and no dunning email is ever sent |
| BILLING-CRITICAL-038 | CRITICAL | Production defaults to mock billing: docker-compose.droplet.yml sets BILLING\_PROVIDER to mock and nothing rejects mock or sk\_test\_ keys when NODE\_ENV is production, and the mock refund returns succeeded without moving money |
| BILLING-HIGH-039 | HIGH | Auto-invoices carry no tax and fill the billing address with the tenantId, and the metered-billing KDV rate is hard-coded at 18% where the statutory rate is 20%, with Stripe Tax unused |
| BILLING-HIGH-040 | HIGH | Invoice numbers are random rather than sequential and two copies of the number generator have drifted apart |
| BILLING-HIGH-041 | HIGH | Stripe webhook events can be lost: the dedup row is committed before the handler runs so a crash mid-handler turns Stripe's retry into a 200 duplicate, rows marked handler-error are never replayed because nothing reads that table, and there is no event-ordering guard |
| BILLING-HIGH-042 | HIGH | Billing webhook and scheduler paths still publish events without the transactional outbox and swallow errors, a residual of BILLING-CRITICAL-001 that was fixed in command handlers only |
| BILLING-HIGH-043 | HIGH | A paid tier with no Stripe price id is provisioned silently and never billed: the provisioner only logs a warning |
| BILLING-HIGH-045 | HIGH | Plan features are not enforced: hasTenantFeature/tenantHasFeature have no production callers, maxApiRequests and maxStorageGb are never enforced, count quotas are skipped when the token has no planLevel, and a downgrade does not check current usage against the new limits |
| BILLING-HIGH-046 | HIGH | Metered usage does nothing: no code calls recordUsage and no code calls reportMeterEvent, so usage-based revenue is never recorded or reported to Stripe |
| BILLING-MEDIUM-044 | MEDIUM | Late provisioning retries can create duplicate Stripe customers and subscriptions: the Stripe call runs before the receipt check and passes no existing customer, and Stripe forgets idempotency keys after 24 hours |
| BILLING-MEDIUM-047 | MEDIUM | Webhook signature parsing keeps only the last v1 signature, which breaks verification during a Stripe signing-secret rotation |
| BILLING-MEDIUM-048 | MEDIUM | The BILLING\_ADMIN and FINANCE\_MANAGER roles used by the billing resolver do not exist in the RBAC model, so those authorizations cannot be granted as designed |
| BILLING-MEDIUM-049 | MEDIUM | A partial refund re-opens the invoice amount due |
