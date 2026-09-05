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
3. **Command contract.** `BillingAdminCommandMeta { actorId; idempotencyKey: string; correlationId: string }` — both required. All eight admin billing commands extend it; the consumer writes a `command_receipts` row keyed on `(tenantId, idempotencyKey)` before acting and replays on retry. Senders are typed against the contract (no inline anonymous payloads). Class DTOs on every `@Body()` per ADR-0015.

Gate: `tests/invariants/billing-command-contract-ssot.spec.ts` — (i) every `BILLING_ADMIN_COMMAND_SUBJECTS` member has a contract-typed sender, a consumer `@MessagePattern` and a `services.yaml` grant derived from one declaration; (ii) metadata-key symmetry between `stripe-api.service.ts` writes and webhook reads; (iii) no raw `UPDATE` / `INSERT` against `billing.subscriptions` outside a `@CommandHandler`.

## Consequences

- MAJOR bump on `billing-admin-commands.ts` — internal RPC, sender and consumer deploy together; no `.v2` subject or double-publish window.
- Closes the retried-refund double-refund (state-derived Stripe key replaced by the caller-supplied key).
- The losing side: the "non-Stripe admin tenants" option — it produced DRAFT invoices nothing could collect.
