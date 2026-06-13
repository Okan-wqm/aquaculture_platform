# Messaging push fan-out — dead handler (Wave 2 slice 1)

**Cycle:** 2026-06-10-round3 (Wave 2, opaque-push slice)
**Owner agent:** messaging-expert
**Date:** 2026-06-13

## How this was found

Wave 2 slice 1 was scoped as "port opaque-push events (`ChannelMessageSent` +
`ChatPushRequested`) from `fix/messaging-enterprise-gates-2026-05-29`". Firsthand
verification of current `main` against the source branch found that **main
already implements opaque-push, and more robustly than the source**:

- `MessageSent` is content-free (no body — same metadata as the source's
  `ChannelMessageSent`).
- `MessagingPushService.handleMessageSent` does the full fan-out: sender skip,
  notification-preference filter, presence skip with @mention override,
  `randomUUID()` opaque `notificationRef` + Redis ref store (resolved post-auth
  via the gateway `resolveNotificationRef` round-trip), atomic `SETNX` dedup,
  and failure-compensating rollback of the dedup + ref keys.
- A unit test already asserts the payload is content-free
  (`should never include message content in push payload`).

Porting the source's design (`notificationRef = eventId`, racy get-then-setex
dedup, a `ChatPushRequested` intermediate event) would be a **regression**.
SUPERSEDED — no port. But the verification surfaced a real defect:

## MSG-HIGH-004 — push fan-out handler is unwired; offline channel-message push is non-functional

**Severity:** HIGH
**Files:** `apps/messaging-service/src/notification/messaging-push.service.ts`,
`apps/messaging-service/src/notification/notification.module.ts`

**Problem:** `MessagingPushService.handleMessageSent` is the owner of
channel-message push fan-out — notification-service's messaging handler
*explicitly defers to it*: it skips channel `MessageSent` with the comment
`"push fan-out is owned by messaging-service"`. But **nothing ever subscribed
`MessagingPushService` to `MessageSent`**: its `onModuleInit` only logged a
misleading `"MessagingPushService initialized — listening for MessageSent
events"` and registered no subscription, and the service comment admits the
method is "Called by the NATS event handler or event-handlers module" — a
handler that did not exist. Repo-wide, `handleMessageSent` was referenced only
by its own 8 unit tests; there were zero `subscribeWildcard` calls in
messaging-service.

**Effect:** When a message is sent, `MessageSent` is emitted to the outbox →
NATS, but no consumer invokes the push fan-out. **Offline users receive NO push
notification for new channel messages.** Online users still get the socket
`newMessage` broadcast (via the gateway bridge) and messages persist, so this is
degradation, not data loss — but the entire mobile/web push-notification feature
for chat is silently inert. The excellent content-free push logic + its
regression test shipped; only the durable subscription was missing. This is the
backend analogue of the Wave-6 M2 dead-trigger (a complete implementation with
no caller).

**Fix (Tier-1/2 — wire the missing durable consumer; no event-contract change):**
`MessagingPushNatsHandler` subscribes to `MessageSent` via `subscribeWildcard`
(the platform's live event-consumer pattern, identical to the notification-service
messaging handler) and delegates to `handleMessageSent`. Registered in
`MessagingNotificationModule`; `EVENT_BUS` comes from the global `EventBusModule`.
The no-op, misleading `onModuleInit` was removed from `MessagingPushService` — the
handler now owns the lifecycle. `MessageSent` is already content-free, so the push
payload stays opaque and the existing content-free guarantee is preserved.

**Test:** `messaging-push-nats.handler.spec.ts` — asserts the durable
subscription, the event type, and delegation to `handleMessageSent`.

## Wave-2 slice-1 outcome

- Opaque-push events/handler from the source branch: **SUPERSEDED** (main is
  better) — no port.
- Genuine gap closed: **MSG-HIGH-004** dead push fan-out handler — wired.
