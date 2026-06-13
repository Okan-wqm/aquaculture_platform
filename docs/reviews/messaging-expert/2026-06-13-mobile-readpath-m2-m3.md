# Mobile messaging read-path — Wave-6 M2/M3 (read-state SSoT convergence)

**Cycle:** 2026-06-10-round3 (Wave 6)
**Owner agent:** messaging-expert
**Date:** 2026-06-13
**Scope:** `web/apps/aquamobil/**` messaging read-state + reconnect, against the
already-correct server read-state SSoT (`apps/messaging-service/src/message/commands/mark-read.handler.ts`).

## Architectural frame

The read-state single-source-of-truth is already correctly placed server-side:
`mark-read.handler` advances `channel_members.lastReadAt`, writes a
`message_receipts` row, and emits the `MessageRead` outbox event in ONE
transaction; the receipt is broadcast outbox → NATS → messaging bridge →
socket `readReceipt`. The mobile client's only obligations are (a) to TRIGGER
that handler when the user has seen a message, and (b) to converge its caches on
server truth after a connectivity gap. Both obligations were unmet. These are
*convergence-to-an-existing-SSoT* fixes, not new mechanisms.

This complements Wave-6 **G1** (gateway-api `messaging.gateway.ts` ghost
`@SubscribeMessage('markRead')` handler — persisted nothing, broadcast a
fabricated read receipt — deleted so outbox→NATS→bridge `MessageRead` is the
only read-receipt emission source). The mobile client end of that dead socket
path (`useMessageSocket.emitMarkRead`) is removed here as part of MSG-CRITICAL-001.

---

## MSG-CRITICAL-001 — mobile read cursor is never advanced; unread state is permanently stale

**Severity:** CRITICAL
**File:** `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx`,
`web/apps/aquamobil/src/hooks/useMessageSocket.ts`

**Problem:** The mobile app defined the `markMessagesRead` GraphQL mutation
(`graphql/messaging-operations.ts`) and an offline-queue replay branch for it
(`useOfflineQueue.tsx` `MUTATIONS.markMessagesRead` + `markMessagesRead`
`OperationType` + `{ channelId, messageId }` payload), but **no code path ever
invoked it**. `ChatRoomPage` opened a channel, rendered messages, and auto-
scrolled to the bottom without ever telling the server the user had read
anything. The only read-state emission attempt was the socket `emitMarkRead`
→ server `markRead` ghost handler (Wave-6 G1) which persisted nothing.

**Effect:** `channel_members.lastReadAt` never advanced from the mobile client.
The per-channel unread badge (`get-channels.handler.ts` subquery
`messages.createdAt > COALESCE(lastReadAt, '1970-01-01')`) therefore never
cleared on mobile — every channel the user opened still showed its full unread
count, and read receipts were never delivered to senders. A core messaging
guarantee (read state) was non-functional on the mobile surface.

**Fix (Tier-1 — make the wrong path impossible + Tier-2 — correct path is the default):**
- Deleted the dead socket path: `useMessageSocket.emitMarkRead` (0 call sites;
  server handler removed by G1). Read state now flows exclusively through the
  mutation.
- Added `useMarkRead(channelId)` hook: online → `markMessagesRead` mutation +
  `invalidateSyncedOperationQueries(..., ['markMessagesRead'])` (the EXACT key
  set the offline replay uses — both write paths converge on one invalidation
  map); offline → enqueue on the shared offline queue; online-but-network-error
  → fall through to the queue so a transient failure never drops the advance.
- Wired the trigger in `ChatRoomPage`: the read cursor advances to the newest
  *server-persisted* message (optimistic pending/failed sends skipped — they
  have no server row and would 404) when the user has actually SEEN it — list
  scrolled to bottom AND document foreground. A dedup ref fires the mutation
  once per newest-message-id and breaks the invalidate→refetch→effect loop.

**Read-cursor sender semantics (verified against server):** the cursor advances
to the newest message *regardless of sender*. The `get-channels` unread subquery
counts a member's OWN messages after `lastReadAt` too, so the badge only clears
once `lastReadAt` passes the newest message — including the user's own sends.
(The Redis HINCRBY counter excludes the sender, so Redis and DB disagree on
own-message counting — tracked as ORPHAN-MEDIUM-100; advancing past own messages
is correct under both.)

**Test:** `web/apps/aquamobil/src/hooks/__tests__/useMarkRead.spec.ts` — online
mutation + SSoT invalidation, offline enqueue, online-error fall-through,
disabled no-op.

---

## MSG-HIGH-003 — mobile socket reconnect silently drops messages received during the disconnect

**Severity:** HIGH
**File:** `web/apps/aquamobil/src/hooks/useMessageSocket.ts`

**Problem:** On reconnect the `connect` handler only re-emitted `joinChannel`
for previously joined rooms. Socket.IO does not replay events missed while the
socket was down, so any message that arrived during the gap was absent from the
client caches until a full manual refetch. The backend contract for closing
this gap already existed (`message.resolver.ts` `allMessagesSince(since, limit,
syncToken)` → `{ messages, hasMore, syncToken }`) and the FE query string
(`ALL_MESSAGES_SINCE`) was defined — but no client code called it.

**Fix (Tier-2 — converge on server truth automatically on reconnect):**
- Track a per-connection watermark (`lastSyncAtRef`): set on first connect,
  advanced to the newest live `newMessage.createdAt` thereafter.
- Distinguish first connect (no gap — initial queries already loaded state)
  from a reconnect via `hasConnectedRef`.
- On RECONNECT, drain `allMessagesSince(since=watermark)` page-by-page
  (`syncToken` cursor, 100/page so a long offline window can't drop past one
  page), upsert each missed message into its channel cache via the SAME
  `upsertMessageIntoChannelCache` helper the live `newMessage` handler now uses
  (single source of truth for cache shape), then invalidate the channel-list +
  unread-count badges to authoritative server state. An `isReconcilingRef`
  guards against overlapping reconciliations; failures leave the watermark
  unchanged so the next reconnect retries — nothing is permanently lost.

**Test:** `web/apps/aquamobil/src/hooks/__tests__/useMessageSocket-reconnect.spec.ts`
— first connect performs NO delta fetch; reconnect fetches `allMessagesSince`,
upserts the missed message, invalidates badges; empty delta skips invalidation.

---

## Verification

- `nx`/vitest: `useMarkRead.spec.ts` (5) + `useMessageSocket-reconnect.spec.ts`
  (3) green; type-check clean for the three changed files.
- E2E: read-path scenarios (mark-read → outbox → receipt; reconnect → delta)
  exercised under the E2E Messaging suite (chronic-flake stabilisation tracked
  separately as ORPHAN-HIGH-092).
