# Mobile read-contract drift — the server omits what the client renders

**Cycle:** 2026-09-05-mobile-graphql-contract (Faz 3, K4 view-type reconciliation)
**Agent:** contract-parity-enforcer
**Method:** deleting the untyped `graphqlRequest(DocumentNode, Record<string, unknown>)`
overload in AquaMobil (MOB-HIGH-019) made every hand-written view type compile
against the generated operation result types. Most mismatches were client-side
mirrors that had drifted; two were the SERVER not declaring what it stores,
sends over the socket, or types in its own entity. Those two are registered here
because the client cannot derive a field the schema does not carry.

## MSG-HIGH-078 — Message.metadata is accepted, stored and pushed over WS, but not readable through GraphQL

**Severity:** HIGH
**Layer:** 2
**State:** OPEN

**Evidence:**

- `apps/messaging-service/src/message/dto/send-message.input.ts:73-76` —
  `SendMessageInput.metadata: JSON` (the client sends `durationSeconds` for voice
  notes and `isAi` for AI attribution).
- `apps/messaging-service/src/message/entities/message.entity.ts` — the `metadata`
  column is `@Column({ type: 'jsonb' })` with NO `@Field`, so `type Message` in
  the supergraph has no `metadata` (`dist/graphql/supergraph.graphql`).
- `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts` — the
  live `WsMessage` envelope DOES carry `metadata: message.metadata`.
- `web/apps/aquamobil/src/pages/messaging/AiChatPage.tsx:84`
  (`msg.metadata?.isAi === true`) and `src/hooks/useAiChat.ts:160` read it from
  every message; `src/types/messaging.ts` declared `metadata` as a required
  field of `Message` while the GraphQL read path (`messages`, `allMessagesSince`,
  `myChannels.lastMessage`) never returns it.

**Impact:** the same message renders differently depending on how it arrived —
live over the socket (metadata present) versus loaded from history or after a
reconnect sync (metadata absent): voice-note duration and AI attribution vanish
on reload. A hand-written client type hid the gap.

**Fix (this cycle):** `@Field(() => GraphQLJSON, { nullable: true })` on the
entity column and `metadata` in the AquaMobil `MessageFields` fragment; the
generated `MessageFieldsFragment` now carries it and the client `Message` view
type is derived from that fragment.

## FARM-HIGH-301 — Task.checklistItems / Task.notes / RecurringTemplate.checklistItems are `JSON` scalars over a typed JSONB shape

**Severity:** HIGH
**Layer:** 2
**State:** OPEN

**Evidence:**

- `apps/farm-service/src/task/entities/task.entity.ts:40-66` — `TaskChecklistItem`
  and `TaskNote` are typed interfaces; `:220-226` exposes both columns as
  `@Field(() => GraphQLJSON)`; `recurring-template.entity.ts:145-147` the same.
- `apps/farm-service/src/task/services/task.service.ts:57-74` —
  `normaliseChecklistItem` defines the canonical shape
  `{ id, text, isCompleted, completedAt?, completedBy? }` and reads the legacy
  `completed` flag, but only on WRITE; a read returns whatever the row holds.
- `apps/farm-service/src/task/resolvers/recurring-template.resolver.ts:109-111,179-181`
  — the template INPUTS are `JSON` too, while `CreateTaskInput.checklistItems`
  is the typed `[TaskChecklistItemInput!]`.
- Clients re-type the shape by hand and normalise on read:
  `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:233-247`,
  `src/components/cards/TaskCard.tsx:36-39` (`Array.isArray` + `as { isCompleted?: boolean }`),
  `web/modules/farm-module/src/pages/tasks/types/task.types.ts:33-45`.
- Codegen types the field as `Record<string, unknown> | null`
  (`web/apps/aquamobil/src/generated/graphql.ts` GetMyTasksQuery), i.e. the
  generated contract says "object", the runtime says "array".

**Impact:** the checklist a field worker ticks on mobile is typed by nobody: a
row written before FARM-HIGH-057 (`completed` instead of `isCompleted`) renders
unticked on read, each client carries its own normaliser, and a server-side
shape change is invisible to `tsc` in both clients. This is the JSON-column
escape hatch the root rules forbid, on the read contract.

**Fix (this cycle):** `TaskChecklistItem` and `TaskNote` become GraphQL object
types; `checklistItems` is served by a field resolver that runs the SAME
normaliser as the write path (so a legacy row reads canonical); the
recurring-template inputs take `[TaskChecklistItemInput!]`; both clients select
sub-fields and drop their normalisers. SDL type change → `BREAKING CHANGE`
footer; both clients adapt in the same commit.
