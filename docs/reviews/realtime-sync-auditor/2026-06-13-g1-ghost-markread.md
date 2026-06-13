# G1 — ghost socket markRead path produced fake read receipts (2026-06-13)

## MSG-HIGH-002 — gateway socket `markRead` broadcast read receipts without persisting

**Severity:** HIGH · **Layer:** gateway realtime · **Owner:** realtime-sync-auditor
**Cycle:** 2026-06-10-round3 (Wave 2 / read-path SSoT; operator 3-agent + lead first-hand CONFIRMED)

### Observation
`messaging.gateway.ts` had a third, rogue read-receipt path: a synchronous
`@SubscribeMessage('markRead') handleMarkRead` that broadcast a `readReceipt`
to `channel:{tenant}:{channelId}` and returned `{ success: true }` — with NO
persistence (no `mark-read.handler`, no `channel_members.lastReadAt`, no
`message_receipts`, no outbox, no NATS). It emitted on the SAME event name +
room as the REAL receipt, so a client could not distinguish a persisted read
from a fabricated one. Three competing paths existed for one concept: the
persistent GraphQL `MarkMessagesRead` (unused by any client — M2), this
persist-less socket path (unused + lies), and the genuine outbox→NATS→bridge
`MessageRead` broadcast.

### Fix (Tier-1 — physically remove the wrong path)
Deleted `handleMarkRead` + the now-unused `MarkReadPayload` interface. The
single read-receipt SSoT is the persistent path: `MarkMessagesRead` →
`mark-read.handler` (lastReadAt + receipts + outbox `MessageRead`, one
transaction) → NATS → `messaging-nats-bridge` `case 'MessageRead'` →
`broadcastReadReceipt`. The on-screen `readReceipt` event now always carries a
persisted truth. No client emitted the socket `markRead` (M2), so removal has
no caller to break; the UI mark-as-read trigger (Wave 6 / M2) wires to the
GraphQL mutation, never a socket emit.

### Verification
No spec referenced `handleMarkRead`; no straggler refs remain; eslint clean
(`MarkReadPayload` removed with its only consumer). The real receipt broadcast
(`messaging-nats-bridge` `case 'MessageRead'`) is untouched.

### Tier
Tier-1: the rogue path is gone — it can no longer emit a fake receipt. Pairs
with M2 (wire the UI to `MarkMessagesRead`) and the dead-contract CI invariant
(every defined mutation needs ≥1 call site) tracked under Wave 2/6.
