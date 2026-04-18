# P10 Audit: Messaging Handlers After RLS Activation

**Date:** 2026-04-14
**Plan reference:** `/root/.claude/plans/polished-brewing-knuth.md` Phase 10
**Status:** Audit complete; code changes deferred to per-service follow-up commits

## Audit scope

Every production data-access callsite in `apps/messaging-service/src/`
that performs raw SQL (`dataSource.query` / `queryRunner.query`) or uses
TypeORM repositories. Goal: verify each callsite operates correctly
once P4 RLS policies (1782400000000-EnableRowLevelSecurity) are active.

## Risk model

After P4 + P5:
- All `messaging.*` tables have `tenant_isolation_policy` with FORCE RLS
- `RlsConnectionBootstrap` injects `app.current_tenant` from
  AsyncLocalStorage on every connection checkout
- Predicate: `bypass_guc='on' OR tenantId=NULLIF(current_tenant,'')::uuid`
- **Default deny:** unset GUC → no rows visible

This means any code path that:
- Runs OUTSIDE an HTTP request (no ALS context), AND
- Does NOT explicitly wrap in `BypassRlsService.withBypass()`

…will silently observe an EMPTY result set for tenant-scoped tables.

## Critical findings

### F1 — embedding.service.ts (CROSS-TENANT WORKER) — CRITICAL

`apps/messaging-service/src/ai/services/embedding.service.ts:66` runs
`@Cron('*/5 * * * *')` to process unembedded messages **across all
tenants**. The query at line 98:

```typescript
const messages = await this.dataSource.query(
  `SELECT m."id", m."tenantId", ... FROM "messages" m WHERE m."embedding" IS NULL ...`
);
```

After RLS activation: `app.current_tenant` is unset in cron context →
RLS returns empty set → embedding pipeline silently does no work.
Same defect at line 181 (write-back).

**Fix:** Wrap the cron handler body in `BypassRlsService.withBypass({
reason: 'cross-tenant embedding pipeline' })`. The service already
fetches `tenantId` per row (it understands cross-tenant semantics);
bypass just makes the read possible.

**Severity:** CRITICAL — silently breaks AI feature for all tenants.
**Owner:** ai/embedding maintainer.
**Deadline:** Before P4 migration is auto-run in production
(currently P4 is auto-run on next deploy via app.module.ts migrations[]).

### F2 — knowledge-extraction.service.ts (CROSS-TENANT WORKER) — CRITICAL

`apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:106`
runs `@Cron('0 * * * *')` to extract knowledge from messages
across all tenants (line 177-181 reads from `messages` raw).

Same failure mode + fix as F1.

**Severity:** CRITICAL.
**Owner:** ai/knowledge maintainer.
**Deadline:** Before P4 lands in production.

### F3 — ai-privacy.service.ts — needs review

`apps/messaging-service/src/ai/services/ai-privacy.service.ts` lines 92,
121, 142, 168, 202, 221: multiple raw queries. Service handles per-user
privacy operations; if invoked from HTTP context, ALS will have tenant
→ RLS works. If invoked from cron/job → needs bypass.

**Action:** Confirm invocation context for each method; wrap with
bypass where cron/job-invoked, leave HTTP-invoked methods alone.

**Severity:** HIGH (depends on actual call sites).
**Owner:** ai/privacy maintainer.

### F4 — sentiment-analysis.service.ts — needs review

`apps/messaging-service/src/ai/services/sentiment-analysis.service.ts:153`
queries `recentAnalyses` for trend detection. Likely cross-tenant
analytics (read-only). If so → bypass needed.

**Severity:** MEDIUM — degrades AI feature; not data leak.

### F5 — knowledge-extraction.service.ts:370 (schema enumeration)

```typescript
const rows = await this.dataSource.query(
  `SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^tenant_'`
);
```

Reads `information_schema.schemata` to enumerate per-tenant schemas.
This pattern PRE-DATES the convergence to single-schema and will
become obsolete once messaging fully migrates. Not a security risk
(catalog reads are unrestricted) but is dead code post-migration.

**Severity:** LOW (cleanup).
**Owner:** ai/knowledge maintainer.

## Findings that DO NOT need bypass

### gdpr.service.ts — SAFE under RLS

`apps/messaging-service/src/gdpr/gdpr.service.ts` queries are invoked
from per-user HTTP requests. ALS context is populated with the user's
tenantId. RLS policy permits exactly the user's tenant rows. Behavior
under RLS:
- `SELECT ... FROM channel_members WHERE userId = $1` — joined
  filter `tenantId = current_tenant` automatically applied by RLS;
  user can only see THEIR tenant's memberships, which is correct.
- Same for `message_receipts`, `message_reactions` queries.

GDPR is intentionally per-tenant (each user belongs to one tenant).
RLS strengthens, not weakens, the export semantics.

**No change needed.**

### compliance/services/* — SAFE under RLS

`compliance-audit.service.ts`, `data-export.service.ts`,
`legal-hold.service.ts`, `retention-policy.service.ts` all operate
per-tenant from HTTP context. Same SAFE category as gdpr.

**No change needed.**

### messaging-push.service.ts (notification dispatcher)

If invoked from message-create HTTP path → SAFE (ALS has tenantId).
If invoked from cron or queue worker → needs review (likely
cross-tenant; needs bypass).

**Action:** Check invocation context; tag in follow-up if needed.

## Outbox worker (special case)

`apps/messaging-service/src/outbox/messaging-outbox.entity.ts` is
already excluded from RLS via P4 migration's `excludeTables:
['messaging_outbox']`. Worker reads can proceed without bypass.

Note: `messaging_outbox.tenantId` column EXISTS (inherited from
OutboxEntityBase) — the worker uses it for downstream event routing,
not for RLS. Excluding the outbox from RLS is a deliberate
architectural choice consistent with farm/sensor/etc.

## Summary table

| Service | File | Finding | Severity | Action |
|---|---|---|---|---|
| AI Embedding | embedding.service.ts | Cross-tenant cron, no bypass | CRITICAL | Wrap cron body |
| AI Knowledge | knowledge-extraction.service.ts | Cross-tenant cron, no bypass | CRITICAL | Wrap cron body |
| AI Privacy | ai-privacy.service.ts | Mixed invocation context | HIGH | Audit per-method |
| AI Sentiment | sentiment-analysis.service.ts | Cross-tenant analytics | MEDIUM | Wrap reads |
| AI Knowledge | knowledge-extraction.service.ts:370 | Obsolete tenant-schema enumeration | LOW | Cleanup post-P9 |
| GDPR | gdpr.service.ts | HTTP-invoked, ALS populated | SAFE | None |
| Compliance | compliance/services/* | HTTP-invoked, ALS populated | SAFE | None |
| Messaging Push | messaging-push.service.ts | Needs invocation context check | TBD | Audit |
| Outbox | messaging-outbox.* | Excluded from RLS | SAFE | None |

## Recommended deploy order (revised)

P4 migration auto-runs on next deploy via app.module.ts. With the F1/F2
findings, this would silently disable embedding + knowledge-extraction
in production until they're fixed. To prevent that:

1. Land BypassRls wraps for F1/F2 BEFORE P4 reaches production
2. OR temporarily revert P4 migration registration in app.module.ts
   until F1/F2 fixes are merged
3. OR set `SCHEMA_DRIFT_FATAL=false` AND accept temporary AI feature
   regression while F1/F2 land

Recommendation: option 1. Two small per-service PRs:
- "fix(messaging-ai): wrap embedding cron in BypassRls"
- "fix(messaging-ai): wrap knowledge-extraction cron in BypassRls"

These can ship in parallel with this messaging-isolation series.

## Tracking

Open findings:
- **CRITICAL-MSG-002** — embedding worker bypass missing (this audit)
- **CRITICAL-MSG-003** — knowledge-extraction worker bypass missing
- **HIGH-MSG-004** — ai-privacy invocation-context audit
- **MEDIUM-MSG-005** — sentiment-analysis bypass review

To be opened in `docs/reviews/messaging-expert/` per project finding
convention.
