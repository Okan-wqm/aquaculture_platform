# Finding: ai-privacy.service.ts had four-layer naming drift (audit theater)

**Agent:** messaging-expert (this finding raised by ultrathink E2E audit)
**Date:** 2026-04-14
**Severity:** CRITICAL-MSG-006
**Status:** RESOLVED in commit `<TBD-after-commit>` (will be filled in)

## Summary

`apps/messaging-service/src/ai/services/ai-privacy.service.ts` used hand-
written raw SQL with FOUR independent layers of drift between the SQL it
emitted and the actual database shape. Unit tests asserted on the broken
SQL strings (`expect.stringContaining('tenant_settings')`), so coverage
was green while runtime was permanently broken in every environment that
hit the DB fallback path. This is the canonical "audit theater" anti-pattern
forbidden by CLAUDE.md.

E2E suite (`apps/messaging-service/test/ai-chat.e2e-spec.ts`) made it
visible — production-shaped DB returned `relation "tenant_settings"
does not exist`.

## The four drift layers

| Layer | Raw SQL emitted | Actual database |
|---|---|---|
| Table name | `tenant_settings` | `tenant_ai_settings` |
| Column name | `aiAnalysisEnabled` | `aiEnabled` |
| Table name | `user_preferences` | `user_ai_consents` |
| Column name | `aiAnalysisConsent` | `consented` |

Plus: missing schema qualification (queries used unqualified table names;
post-P7 entity decoration the working query path queries `messaging.X`
directly via TypeORM, so even the cache-miss fallback was structurally
incompatible with the surrounding code).

Plus: `DELETE FROM "embeddings_metadata" WHERE "tenantId" = $1 AND
"userId" = $2` — the `embeddings_metadata` entity has neither
`tenantId` nor `userId` columns (it's a platform-wide model registry —
`embeddings-metadata.entity.ts` declares `id, modelName, modelVersion,
dimension, distanceMetric, createdAt, isActive`). The query was always
nonsense and was wrapped in `.catch(() => {})` to swallow the
permanent failure. The defensive-`?.`-suppresses-crash anti-pattern
explicitly forbidden by CLAUDE.md "Architectural Approach" rules.

## Root cause

Service was written against a hypothetical schema (`tenant_settings` /
`user_preferences` named the way an external observer might guess) but
never reconciled with the actual entity definitions when those entities
were created. Unit tests mocked `dataSource.query` and asserted SQL
strings instead of behavior, so the test mocks matched the broken SQL
verbatim and CI stayed green forever.

## Fix (Tier-1 Make-Impossible)

Refactored to use TypeORM repositories on the canonical entities
`TenantAiSetting` and `UserAiConsent`. Repositories derive table +
column + schema from entity metadata; SQL the service emits CANNOT
drift from the entity decorations.

Concrete changes:

- **Replace raw SQL with repository calls:**
  `tenantAiSettings.findOne({ where: { tenantId } })` instead of
  `dataSource.query('SELECT ... FROM tenant_settings ...')`. Same for
  user consent. Same for upserts (`repo.upsert(...)`).
- **Drop fictional interface fields:** Returns `boolean` directly from
  `isTenantAiEnabled` / `hasUserConsented`. Old return types
  `TenantAiSettings.aiAnalysisEnabled` / `UserAiConsent.aiAnalysisConsent`
  are gone — they were a layer of drift that obscured the real entity
  field names.
- **Rename methods to match meaning:** `getTenantAiSettings` →
  `isTenantAiEnabled` (boolean primitive). `getUserAiConsent` →
  `hasUserConsented`. `updateTenantAiSetting` → `setTenantAiEnabled`.
  `updateUserAiConsent` → `setUserAiConsent`. New names self-document.
- **Embedding sweep keeps raw SQL** but: schema-qualified to
  `"messaging"."messages"` / `"messaging"."channels"` (post-P7 entity
  decoration requires explicit qualification); wrapped in
  `BypassRlsService.withBypass()` for auditable cross-tenant write;
  removed dead `embeddings_metadata` DELETE; failure logged loud
  (NOT swallowed) but does not roll back the consent change.
- **Test rewrite:** Mocks repositories via `getRepositoryToken(Entity)`,
  asserts behavior (cache hit/miss, deny-by-default on missing row,
  fail-closed on DB outage, sweep wrapped in BypassRls). NO raw-SQL
  string assertions.

## Hierarchy classification

- **Tier-1 Make-Impossible:** entity metadata is the single source of
  truth for table + column + schema. Repository pattern makes drift
  structurally impossible.
- **Tier-3 Detectable** (test layer): repositories mocked at the
  TypeORM API surface; if a future change accidentally returns to
  raw SQL, the test mock won't match.

## Files changed

- `apps/messaging-service/src/ai/services/ai-privacy.service.ts` — full rewrite (~270 lines → repository pattern)
- `apps/messaging-service/src/ai/services/__tests__/ai-privacy.service.spec.ts` — full rewrite (behavior tests, no SQL string mocks)
- `apps/messaging-service/src/ai/ai.module.ts` — added `TenantAiSetting`, `UserAiConsent` to TypeOrmModule.forFeature
- `apps/messaging-service/src/ai/resolvers/ai.resolver.ts` — updated 3 call sites to new method names + simplified return shape

## Related findings

- CRITICAL-MSG-001 (SourceSchemaWriteGuardService vs P7 entity decoration) —
  separate finding, also surfaced by the same E2E run; not addressed here
  (different code path). Tracked at
  `docs/reviews/messaging-expert/2026-04-14-tenant-isolation-violation-e2e.md`.
- ADR-011 (Schema Ownership Model) — repository pattern derives schema
  from entity decoration, so this fix consumes ADR-011 correctly.
- ADR-015 (NATS Cert-Is-Identity SSoT) — same architectural approach
  (single source of truth + drift-impossible by construction); inspired
  the tier-1 framing of this fix.

## Closes

This finding is closed by the commit that lands the refactor. CI E2E
must show `relation "tenant_settings" does not exist` GONE on next run.
