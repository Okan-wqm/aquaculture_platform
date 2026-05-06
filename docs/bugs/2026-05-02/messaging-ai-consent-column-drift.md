# Messaging AI Consent Column Drift

Date: 2026-05-02

## Problem

Messaging E2E caught `column "consented" of relation "user_ai_consents" does not exist`. The runtime entity and `AiPrivacyService` use the canonical fields `consented` and `consentedAt`, while the original compliance migration created legacy fields `consentGiven` and `givenAt`.

This also affected read-after-write visibility for tenant AI settings and user consent because cache-miss reads and mutations were not explicitly tenant-pinned.

## Enterprise Fix

Added `AlignAiConsentColumns1782700000000` to converge source and tenant schemas without data loss:

- `consentGiven` is renamed to `consented` when present.
- `givenAt` is renamed to `consentedAt` when present.
- canonical columns are added/backfilled/enforced when absent.

`AiPrivacyService` now performs DB reads, upserts, and embedding sweeps through `runInTenantTransaction()` so tenant privacy data is read and written inside the tenant schema.

## Validation

Targeted unit and CI E2E validation must prove:

- AI consent upsert uses canonical columns.
- Tenant AI settings and user consent writes no longer hit `messaging.*`.
- Cache invalidation still occurs after successful writes.
