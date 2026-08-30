# ADR-0004 — Money wire-representation is a platform-wide Shared-Kernel scalar, not a per-domain choice

**Status:** accepted
**Date:** 2026-07-11
**Arbiter finding:** ARCH-HIGH-001 (finance E2E hardening cycle)
**Aligns:** `DATA-MEDIUM-009` (finance review — re-parented to platform, billing-expert primary) ↔ `PLAT-LOW-001` (billing-owned TODO in `apps/billing-service/src/billing/entities/invoice.entity.ts:39-42`, promoted LOW→HIGH by the billing-expert 2026-04-28 core-platform review).

## Context

`DATA-MEDIUM-009` flagged that finance money is persisted via `DecimalTransformer` (returns a JS `number`) and transported over GraphQL as `@Field(() => Float)`, inconsistent with the string-decimal money fields in `@platform/event-contracts`. During the finance-hardening effort the question arose: may finance migrate its money fields to a string/Decimal GraphQL scalar as a **finance-only** change now?

Investigated blast radius:

- **No custom Decimal/Money GraphQL scalar exists** anywhere (`libs/backend-common/src/graphql/` is absent). A finance-only fix would have to create the shared primitive itself — the exact file (`libs/backend-common/src/graphql/decimal.scalar.ts`) billing-expert's review already claims as its deliverable.
- Money `@Field(() => Float)` is the uniform wire contract platform-wide: billing ~34 fields, farm-finance ~11, hr-finance ~20, plus wider non-finance money floats.
- The shared FE consumer `formatCurrency(value: number)` (`web/shared-ui/src/utils/format.ts:41`) has ~115 call sites across ~25 files. A finance-only string scalar would make finance money serialize as a string while every other domain stays Float — the shared formatter cannot accept both without forking or widening its signature (touching all call sites), which is by definition not finance-only.
- The DB layer is a separate axis and already heterogeneous (billing `@MoneyColumn`→Decimal vs finance `DecimalTransformer`→number); it does not need resolving to fix the wire.

## Decision

The GraphQL money serialization type is a single **Published Language** implemented as a **Shared-Kernel** GraphQL scalar at `libs/backend-common/src/graphql/decimal.scalar.ts`, **co-owned by billing-expert (money-domain primary) + data-expert (shared-infra owner)**. Finance, farm, and hr are **Conformist** consumers and never define a domain-local money wire type.

- Finance keeps `@Field(() => Float)` until the platform scalar migration lands.
- This cycle finance ships **only** the internal Decimal.js exact-aggregation fix (accumulate in Decimal over already-exact `SUM(numeric(15,2))`, round on output; HALF_EVEN per the platform `Money` VO). This is uncontested and in-domain.
- The scalar migration is a **breaking GraphQL contract change** executed with an additive/coexistence window (parallel field or `.v2` → consumer migration across all money DTOs and the shared `formatCurrency` → Float removal), owned by billing-expert + data-expert under `DATA-MEDIUM-009` / `PLAT-LOW-001`, deadline 2026-09-30.

## Consequences

- Finance carries lossy Float on the wire for one more release window; at-rest and in-computation precision is secured now by the internal Decimal.js aggregation over exact `numeric` SUMs.
- The finance-hardening owner cannot fix the money wire representation inside this cycle — that authority moves to the billing-expert + data-expert pair.
- Any change to `decimal.scalar.ts` or `formatCurrency`'s signature now requires joint billing-expert + data-expert sign-off; the migration must sequence a breaking change across ~65 money fields and ~115 formatter call sites.

## Supersedes / aligns

Supersedes: none. Aligns/consolidates `DATA-MEDIUM-009` (re-parented to platform) and `PLAT-LOW-001` (remains the tracking finding).
