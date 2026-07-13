# ADR-044 — AI conversation content ownership: messaging owns the record, ai-service owns only runner context

- **Status:** Accepted
- **Date:** 2026-07-13
- **Owner:** platform operator (Okan) + messaging-service / ai-service owners
- **Tracking:** `docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-389` (DB-PEOPLE-MEDIUM-004, INC-MSG-1)
- **Relates to:** ADR-006 (flat event contracts), ADR-013 (messaging isolation), 2026-07-11 database E2E audit remediation Faz 8-A9

## Context

AI in-channel conversations are persisted twice:

1. **`messaging.messages`** (per-tenant, partitioned) — the relational
   per-turn record: one row per message with `isAiGenerated`, receipts,
   reactions, embeddings, retention/legal-hold coverage, and the GDPR
   export/erasure machinery of `apps/messaging-service/src/gdpr/gdpr.service.ts`.
2. **`ai.agent_conversations.messages`** (per-tenant) — a single jsonb blob
   per conversation holding the runner's working context
   (`apps/ai-service/src/conversation/conversation.entity.ts:25-31`: role,
   content, toolUse, timestamp), used to rehydrate the agent between turns.

The audit flagged this as a double-model (DB-PEOPLE-MEDIUM-004). Worse, the
GDPR erasure path coupled the two stores in the wrong direction (INC-MSG-1):
messaging's `anonymizeMyData` issued a **direct cross-service SQL UPDATE
against `agent_conversations`** inside its own tenant transaction, wrapped in
a broad `catch {}` that swallowed every failure class (permission denied,
lock timeout, constraint violation — not just "table absent in separate-DB
deployments", which was the comment's stated intent). A cross-service write
violates the service-ownership boundary (only ai-service may touch `ai.*`
tables), and the silent catch meant a real failure of the "shared-DB
shortcut" was invisible while looking like coverage.

## Decision

1. **`messaging.messages` is the OWNER of AI in-channel conversation
   content.** It is the compliance source of record: GDPR Art 20 export, Art
   17 erasure, retention policies, and legal holds operate on it and only
   need to operate on it.
2. **`ai.agent_conversations.messages` is runner working-context ONLY.** It
   is a cache-like projection for agent rehydration: it MAY be truncated,
   summarised, or dropped at any time without notice, and MUST NEVER be used
   as a compliance, audit, or export source. Anything that must survive or
   be exported lives in `messaging.messages` (or a dedicated durable ledger,
   e.g. `ai.conversation_turns` for cost — ORPHAN-MEDIUM-380).
3. **Erasure crosses the boundary by EVENT, never by SQL.** messaging's
   `anonymizeMyData` no longer touches `agent_conversations`. It enqueues a
   contract-conformant `GdprAnonymizeRequested` event on its outbox inside
   the same tenant transaction; ai-service's existing consumer
   (`apps/ai-service/src/conversation/conversation-privacy-event.handler.ts:29`,
   subscribed via `eventBus.subscribeWildcard` in `onModuleInit`) erases its
   own blob (`ConversationService.eraseForUser`,
   `apps/ai-service/src/conversation/conversation.service.ts:146-149` — a
   hard delete, which is strictly stronger than anonymisation and is
   permitted exactly because the blob is disposable working context under
   rule 2).
4. **Event emission fails LOUD.** If the outbox enqueue of the cascade event
   fails, messaging logs an error, increments the
   `messaging_gdpr_cascade_emit_failure_total` metric, and rethrows — the
   surrounding transaction rolls back, so a messaging-side erasure can never
   commit without the ai-side cascade request being durably queued. The
   outbox relay then owns at-least-once delivery; the consumer's delete is
   idempotent.
5. **The emitted events conform exactly to `@platform/event-contracts`.**
   The prior emission shipped off-contract fields (`targetService`,
   `targetEntity`, `anonymizedAt`) and omitted the contract-required
   `requestId` + `fulfilByIso`
   (`libs/event-contracts/src/auth-events.ts:158-167`, JSON schema
   `libs/event-contracts/src/schemas/auth-events.schema.ts:133-142` with
   `additionalProperties: false` — the old payload would fail validation at
   any trust boundary that enforces it). messaging now mints a cascade
   `requestId`, records it in the same-transaction `compliance_audit_log`
   row (making that row the request-of-record for this self-service flow),
   and sets `fulfilByIso` to now + 30 days (GDPR Art 12(3) one-month
   window). `UserDataAnonymized` likewise now carries its required
   `method`/`initiatedBy` fields.

## Consequences

### Positive

- Service boundary restored: only ai-service writes `ai.*`; the erasure
  cascade is observable (outbox row, consumer log, failure metric) instead
  of a silent best-effort SQL branch.
- The double-model question is answered structurally: one durable owner,
  one disposable projection, with the GDPR path exercising exactly that
  hierarchy. Truncating/summarising the runner blob is now a declared-legal
  operation, unblocking context-window management in ai-service.
- Erasure atomicity: cascade-event enqueue shares the erasure transaction,
  so "messaging erased but AI never told" is impossible by construction.

### Negative / accepted risk

- Erasure of the AI blob is eventually consistent (outbox relay latency)
  instead of same-instant in shared-DB deployments. Accepted: at-least-once
  delivery with an idempotent consumer is the platform's standard cascade
  mechanism, and the blob is not a compliance source.
- The cascade `requestId` references a per-tenant `compliance_audit_log`
  row rather than a `shared.gdpr_data_requests` registry row, because the
  messaging self-service flow does not create a canonical registry entry.
  The contract's `requestId` is an opaque correlation UUID for consumers;
  the audit row preserves traceability.

### Explicitly rejected

- **Keeping the direct UPDATE with a narrower catch** (e.g. only
  `undefined_table`): still a cross-service write into another service's
  schema and a second, competing eraser racing the event consumer. Rejected
  regardless of error handling quality.
- **Promoting `agent_conversations` to a co-equal record with two-way
  sync:** doubles every compliance surface (retention, legal hold, export)
  for a store whose only consumer is the runner's context window.
