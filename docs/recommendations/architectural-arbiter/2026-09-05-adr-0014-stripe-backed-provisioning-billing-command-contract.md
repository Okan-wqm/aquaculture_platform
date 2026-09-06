# ADR-0014 — Stripe-Backed Provisioning, Consumer-Side Metadata Fix, and a Receipted Billing Command Contract

**Status:** accepted
**Date:** 2026-09-05
**Amends:** `docs/adr/016-stripe-sdk-adoption.md`, `docs/adr/007-*` (CQRS usage)
**Depends on:** ADR-0013
**Narrows:** billing-expert#BILL-001 "key rename" to consumer-side only; producer-side rename rejected
**Resolves:** billing-expert#BILL-001 … #BILL-006, #BILL-008, #BILL-022; audit-trail-completeness-auditor#TRAIL-004, #TRAIL-012; data-expert#DATA-012; form-write-auditor#FORM-003
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#BILLING-CRITICAL-003

## Context

`CreateSubscriptionCommand` is dispatched from one non-test site (`billing.resolver.ts:195`); admin provisioning raw-INSERTs into `billing.subscriptions` (`billing-admin-nats.handler.ts:669-693`) omitting the Stripe ids. Cancel (`:373-392`), reactivate and extend-trial are raw `UPDATE`s with no Stripe, outbox, projection, audit or state validation while the corresponding handlers exist unused.

Metadata asymmetry: the producer (`libs/backend-common/src/billing/stripe-api.service.ts:108,134`) writes `internalTenantId`; all five webhook consumers (`stripe-webhook.service.ts:62,207,318,385,470`) read `metadata.tenantId` and warn-and-return. The docblock's promised customer-lookup fallback does not exist. `BillingAdminCommandMeta` (`billing-admin-commands.ts:24-27`) has no `idempotencyKey`, while `BillingTenantProvisioningCommand` one interface away carries `operationId`, `idempotencyKey` and `requestPayloadHash`.

## Decision

1. **Provisioning goes through `CreateSubscriptionHandler`.** FREE is the only tier without a Stripe object; every other tier dispatches `CreateSubscriptionCommand`. `billing.plans` is seeded for every billing cycle. The three raw-SQL blocks are deleted and replaced by `CancelSubscriptionCommand`, a new `ReactivateSubscriptionHandler` and `ExtendSubscriptionTrialHandler`, each `@AuditedOperation`, Stripe-aware and outbox-writing.
2. **Fix the consumers, not the producer.** Every Stripe object this platform has ever created carries `internalTenantId`; renaming the producer would orphan all of them. The five consumers read `internalTenantId` through a shared constant, and the customer-lookup fallback is implemented so the metadata key is an association hint, never the authority (SECREV-CRITICAL-001 preserved). Additive for the producer, bug fix for the consumer; no deprecation window.
3. **Command contract.** `BillingAdminCommandMeta { actorId; idempotencyKey: string; correlationId: string }` — both required. All 30 admin billing commands extend it (`BillingTenantProvisioningCommand` included); the consumer writes a `billing.command_receipts` row before acting and replays on retry. Senders are typed against the contract (no inline anonymous payloads). Class DTOs on every `@Body()` per ADR-0015.

As implemented, three details of (3) were settled during the work and are part of the decision:

- **Where the key comes from.** A key derived from the command's own arguments cannot tell two legitimate repeats apart (two $50 refunds of one $100 payment; cancel → reactivate → cancel), and one minted per send is no key at all. So it is the caller's `Idempotency-Key` header, composed with a per-command operation scope: `${header}:${scope}`. admin-panel's `apiFetch` mints the header ONCE per call, outside its own 502/503/504 retry loop — and a billing NATS timeout maps to 502, so the browser was already re-submitting refunds on its own. admin-api refuses a billing mutation that arrives without the header; provisioning is the sole exception, because it carries a machine-derived key from the workflow run and may execute with no HTTP frame at all.
- **Receipt identity.** `(tenantId, commandType, idempotencyKey)`, not `(operationId, …)`. `operationId` led the original unique index, and the provisioning workflow mints a fresh one per retry, so the key was decorative. `tenantId` is NULL for platform-scoped catalogue commands under `NULLS NOT DISTINCT`; a sentinel UUID would have made the row lie about its owner. The index is partial on `"supersededAt" IS NULL`, so pre-existing duplicate receipts are retired as evidence rather than deleted, and superseding a row is the operator's escape from a receipt left STARTED by a dead process.
- **Where the receipt is written.** `BillingCommandReceiptInterceptor`, bound to all five NATS controllers, so at-most-once is the DEFAULT rather than a line 32 handler methods must each remember. Skipping it costs an explicit decorator: `@NonMutatingBillingCommand()` (quote / validate / generate — a repeat must recompute) or `@OwnsBillingCommandReceipt()` (provisioning, whose receipt commits inside the same SERIALIZABLE transaction as the subscription, which is stronger). A reply with `success: false` is recorded FAILED so a transient refusal can be retried; `success: true` is recorded SUCCEEDED and replayed verbatim — which is safe because the stored summary IS the wire form. `BillingAdminCommandResult` is declared once and extended by every reply, so the field that rule branches on cannot be forgotten.

Gate: `tests/invariants/billing-command-contract-ssot.spec.ts` — (i) every `BILLING_ADMIN_COMMAND_SUBJECTS` member has a contract-typed sender, a consumer `@MessagePattern` and a `services.yaml` grant derived from one declaration; (ii) metadata-key symmetry between `stripe-api.service.ts` writes and webhook reads; (iii) no raw `UPDATE` / `INSERT` against `billing.subscriptions` outside a `@CommandHandler`; (iv) every controller carrying these subjects binds the receipt interceptor, the receipt-skipping decorators match an exact expected set, the meta has no optional escape, every send states a non-empty operation scope, the sender never mints a key, admin-panel keeps the key outside its retry loop, and no runtime code writes `supersededAt`.

## Consequences

- MAJOR bump on `billing-admin-commands.ts` — internal RPC, sender and consumer deploy together; no `.v2` subject or double-publish window.
- Closes the retried-refund double-refund (state-derived Stripe key replaced by the caller-supplied key).
- The losing side: the "non-Stripe admin tenants" option — it produced DRAFT invoices nothing could collect.
