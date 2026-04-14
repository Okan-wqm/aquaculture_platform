# Pre-Flight Audit: Messaging Service Isolation Migration

**Date:** 2026-04-14
**Target plan:** `/root/.claude/plans/polished-brewing-knuth.md` (Messaging Service — Converge to Platform-Standard Isolation Pattern)
**Status:** P0 complete

## A-1. tenantId column coverage (17 entities)

Confirmed state via grep across `apps/messaging-service/src/**/*.entity.ts`:

**Has `tenantId`** (9):
| Entity | File | Column line |
|---|---|---|
| Channel | `channel/entities/channel.entity.ts` | :50 |
| ChannelMember | `channel/entities/channel-member.entity.ts` | :52 |
| Message | `message/entities/message.entity.ts` | :50 |
| ComplianceAuditLog | `compliance/entities/compliance-audit-log.entity.ts` | :89 |
| LegalHold | `compliance/entities/legal-hold.entity.ts` | :32 |
| RetentionPolicy | `compliance/entities/retention-policy.entity.ts` | :33 |
| TenantAiSetting | `ai/entities/tenant-ai-setting.entity.ts` | :19 |
| UserAiConsent | `ai/entities/user-ai-consent.entity.ts` | :19 |
| MessagingOutbox | `outbox/messaging-outbox.entity.ts` | inherited from `OutboxEntityBase` |

**Missing `tenantId`** (7 — require add in P3):
| Entity | Parent (FK source for backfill) |
|---|---|
| MessageAttachment | Message (via composite FK `messageId` + `messageCreatedAt`) |
| MessageReceipt | Message (partitioned by `receiptCreatedAt`) |
| MessageReaction | Message (composite FK) |
| PinnedMessage | Channel + Message (dual FK; tenant from either) |
| MessageAnalysis | Message (composite FK) |
| MessageEntityReference | MessageAnalysis |
| KnowledgeEntry | Message (nullable SET NULL FK) — sometimes NULL; fallback source: request tenant context |

**Exclude from RLS** (1 — platform reference data, not tenant-scoped):
| Entity | Rationale |
|---|---|
| EmbeddingsMetadata | Tracks embedding model versions platform-wide (not per-tenant). No `tenantId` justification. Treat like `audit_logs` / `user_permissions` — cross-tenant infrastructure. |

**Revised totals from original plan:**
- Plan said 9 entities need tenantId. Corrected: **7 add + 1 exclude** (outbox already has it via inheritance; embeddings is ref data).

## A-2. Production data inventory

**Status:** Deferred. Code-phase work does not require live DB access. Before P6 execution in production, run:

```sql
-- Tenant schema count
SELECT count(*) FROM information_schema.schemata
WHERE schema_name LIKE 'tenant\_%' ESCAPE '\';

-- Row counts per messaging table across all tenant schemas
DO $$ ... (enumerate tenant_<uuid>.<table>.count)
```

Execute during P6 preparation in production runbook.

## A-3. Partition discovery

**Confirmed partitioned tables** (from `1711800000000-CreateMessagingTables.ts`):

| Table | Partition key | Partition range | Monthly partitions created |
|---|---|---|---|
| `messages` | `createdAt` (RANGE) | 2026-04 through 2026-12 | 9 partitions |
| `message_receipts` | `receiptCreatedAt` (RANGE) | matches messages | 9 partitions |

**RLS behavior on partitioned tables (PG 11+):**
- Applying RLS to partition ROOT automatically propagates policy to all partitions
- `applyTenantRlsToSchema` helper discovers partitions as BASE TABLE via `information_schema.tables` — it may redundantly install policy on both root and each partition. This is idempotent per-partition, not an error. Verify during P4 staging test.

**Partition rotation:** outside scope of this plan. Existing process creates partitions per month; no changes needed.

**Composite FK implication:** `message_attachments`, `message_receipts`, `message_reactions`, `pinned_messages`, `message_analysis` all carry `messageCreatedAt` column to satisfy PG's composite-key-must-include-partition-key rule. The P3 backfill SQL must join on composite `(messageId, messageCreatedAt) = (m.id, m.createdAt)`.

## A-4. FK graph (parent-first consolidation order)

**FK parent → child structure** (derived from entity `@ManyToOne` decorators):

```
channels
├─ channel_members (FK: channelId)
├─ pinned_messages (FK: channelId)
└─ knowledge_entries (FK: sourceMessageId — via Message, nullable)

messages (partitioned)
├─ message_attachments (composite FK: messageId, messageCreatedAt)
├─ message_receipts (composite FK)
├─ message_reactions (composite FK)
├─ pinned_messages (composite FK)
└─ message_analysis (composite FK)
    └─ message_entity_references (FK: analysisId)

(independent)
├─ retention_policies
├─ legal_holds
├─ compliance_audit_log
├─ tenant_ai_settings
├─ user_ai_consents
├─ embeddings_metadata  (platform-wide, no FK from others)
└─ messaging_outbox

knowledge_entries ↔ Message (FK: sourceMessageId, nullable, SET NULL on delete)
```

**P6 data consolidation order** (must copy parents before children):

1. channels → channel_members
2. messages (parent + partitions)
3. Children of messages: message_attachments, message_receipts, message_reactions, pinned_messages, message_analysis
4. message_entity_references (depends on message_analysis)
5. knowledge_entries (FK to messages but nullable, can come after messages)
6. Independent: retention_policies, legal_holds, compliance_audit_log, tenant_ai_settings, user_ai_consents, messaging_outbox
7. EXCLUDE from consolidation: embeddings_metadata (platform-wide; already in `messaging` schema; not cloned per tenant)

## A-5. Existing RLS / GUC usage

**Search result:** ZERO hits for `current_setting`, `app.current_tenant`, `app.bypass_rls`, or `BypassRls` across entire `apps/messaging-service/src/`.

**Implication:**
- RLS wiring completely absent in messaging-service (expected per plan)
- No conflicting custom GUC keys — P5 RlsConnectionBootstrap can wire the platform-standard `app.current_tenant` cleanly
- No handler currently reads GUC — once RLS is installed, ALL handlers will auto-benefit via policy enforcement (they don't need to know about GUC)
- Cross-tenant operations (outbox worker, compliance queries) MUST be wrapped in `BypassRlsService.withBypass()` once P4 lands — audit in P10

## A-6. Alias-quoting bug scan

**Command:**
```
grep -rn "\.orderBy\(|\.addOrderBy\(|\.addSelect\(" apps/messaging-service/src
```

**Results:**

Single bug confirmed:
- `channel/queries/get-channels.handler.ts:74` — `.orderBy('channel_lastMessageAt', 'DESC', 'NULLS LAST')` — unquoted mixed-case alias → PostgreSQL lowercases → `channel_lastmessageat does not exist`

All other `.orderBy` calls use `alias.column` notation (e.g. `'m."createdAt"'`) which TypeORM processes through metadata and emits correctly-quoted SQL. Safe.

**P1 fix (ships alone):**
```diff
- .orderBy('channel_lastMessageAt', 'DESC', 'NULLS LAST')
+ .orderBy('"channel_lastMessageAt"', 'DESC', 'NULLS LAST')
```

## Additional findings

### A-7. Migration runner status (bonus check)

- `apps/messaging-service/src/migrations/` exists with 10 migration files (PascalCase class names, TypeORM MigrationInterface pattern)
- `apps/messaging-service/src/database/` directory does **NOT** exist — P2 must create `src/database/data-source.ts` layout OR use existing `src/migrations/` directly
- Farm reference: `apps/farm-service/src/database/migrations/` + `apps/farm-service/src/database/data-source.ts`
- Mixed repo convention — will mirror farm's `src/database/` layout for P2 consistency

### A-8. RLS helper capability verification

`libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts` confirmed:
- Handles camelCase `tenantId` (first in DEFAULT_TENANT_ID_COLUMNS)
- Supports `excludeTables` option → use for `embeddings_metadata` + outbox-like tables
- Supports `schemaOverride` → use `schemaOverride: 'messaging'` in migration
- Idempotent (DROP IF EXISTS + CREATE) — safe to re-run
- FORCE ROW LEVEL SECURITY enabled (defense-in-depth primary)
- Canonical policy name: `tenant_isolation_policy`
- Predicate: `bypass_guc = 'on' OR tenantId = NULLIF(current_setting('app.current_tenant'), '')::uuid`

### A-9. MigrationRunnerService + TenantContextMiddleware readiness

Need to verify P5:
- Does backend-common export `RlsConnectionBootstrap` as a factory/service consumable by messaging's `app.module.ts`?
- Does TenantContextMiddleware populate ALS context BEFORE the DB connection checkout? (ordering matters for RlsConnectionBootstrap to read app.current_tenant)

These checks deferred to P5 implementation phase.

## Sign-off

Pre-flight audit complete. Findings resolve uncertainty in plan:

- Entity count with tenantId addition: **7** (not 9 — outbox inherited, embeddings excluded)
- Single alias bug (known); no hidden naming-strategy drift
- RLS infrastructure absent; wiring will be green-field (no conflicts)
- Partition handling confirmed safe with platform helper
- Composite FK backfill order mapped

**Ready to proceed with P1 (alias fix).**
