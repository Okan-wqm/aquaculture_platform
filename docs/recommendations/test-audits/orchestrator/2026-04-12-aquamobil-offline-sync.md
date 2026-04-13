# AquaMobil Offline Sync Remediation Plan

**Date:** 2026-04-12
**Topic:** `2026-04-12-aquamobil-offline-sync`
**Source findings:** `HIGH-001`, `HIGH-002`, `HIGH-003`, `MEDIUM-004`, `MEDIUM-005`, `MEDIUM-006`
**Constraint:** review-only, enterprise-grade remediation guidance, no patch-style shortcuts

## Objective

Bring AquaMobil's mobile offline/reconnect behavior to a state where leave and messaging flows can be trusted as end-to-end business operations, not just UI interactions.

## Non-Negotiable Remediation Rules

1. A business action must have one authoritative offline owner.
2. Domain transitions must use server-issued aggregate IDs, never local queue IDs.
3. UI copy must distinguish `queued`, `syncing`, `confirmed`, and `failed`; it must not label queued work as completed.
4. Service-worker routes and app routes must share one basename-aware contract.
5. Do not repair these issues with longer timeouts, special-case branching on queue IDs, or secondary hidden queues.

## Priority Order

1. Rebuild leave roundtrip semantics.
2. Collapse messaging onto one authoritative offline pipeline.
3. Finish service-worker and client handoff contracts.
4. Align UI truth surfaces with actual sync state.
5. Re-run the orchestrated mobile audit on the same scenarios.

## Workstream 1: Leave Roundtrip Redesign

### Problem

The current mobile leave path queues an invalid create payload, cannot reliably deduplicate repeated submits, and then tries to submit using the offline queue UUID rather than the server's leave-request ID.

### Recommended Target Design

Use one semantic mobile operation for "submit leave request" instead of a client-side `create -> timeout -> submit` chain.

Preferred shape:

- mobile sends one validated leave submission command
- backend resolves employee identity server-side
- backend creates the request and transitions it to the intended submitted state in one authoritative command path
- client receives one server-issued leave request ID and one authoritative resulting status

Acceptable fallback if the domain must preserve draft semantics:

- queue only the draft creation as the first operation
- persist the returned leave request ID from the successful sync result
- enqueue submit as a dependent second operation only after the real domain ID exists
- dependency tracking must live in the queue/orchestration layer, not in a UI timeout

### Required Changes

- Introduce a dedicated mobile leave payload mapper aligned to the real backend contract.
- Remove the current timeout-based `submitRequest(queueId)` pattern.
- Replace employee-only leave dedup with a semantic fingerprint suitable for double-tap suppression.
- Prefer a fingerprint built from employee identity plus leave type plus date window plus half-day semantics, not employee ID alone.
- Move mobile leave submit to the same React Query mutation discipline already used in the desktop HR module.

### Anti-Patterns To Avoid

- Do not increase the timeout and hope the create finishes first.
- Do not special-case "if the ID looks like a UUID from the queue, wait longer."
- Do not keep client-created pseudo IDs for domain submission.

### Acceptance Criteria

- repeated taps within the dedup window do not create duplicate leave submissions
- a mobile leave submit reaches one authoritative server state without a UI-managed two-step chain
- every submitted request has a server-issued leave request ID before any follow-up transition references it

## Workstream 2: Leave Readback Convergence

### Problem

Even after the write path is fixed, mobile leave readback can remain stale because the mutation path does not invalidate or update cached leave queries before returning the user to `/leave`.

### Required Changes

- Convert mobile leave mutations to React Query mutation flows with explicit invalidation of `leaveRequests` and `leaveBalances`.
- Update cached detail or list entries immediately after mutation success.
- On queued offline submit, show a local `pending sync` representation rather than a generic success state.
- Route back to the leave screen only after local state has been updated to reflect either `queued` or `confirmed`.

### Acceptance Criteria

- returning to `My Leaves` immediately after submit shows either a queued item or the confirmed updated state
- mobile leave readback behavior matches desktop HR expectations for cache invalidation and convergence

## Workstream 3: Messaging Offline Plane Consolidation

### Problem

Messaging currently uses a separate `messaging_offline_sends` queue that is not owned by the general offline operation pipeline and is invisible to the sync surfaces the user sees.

### Recommended Target Design

Collapse offline messaging onto the same encrypted operation queue used by the rest of AquaMobil.

Preferred shape:

- offline chat send becomes `queueOperation('sendMessage', payload)`
- the same queue owner is responsible for persistence, retry, replay, and user-visible pending counts
- message idempotency keys remain part of the payload and are replayed unchanged

If a separate messaging queue is kept for a strong architectural reason, it must still satisfy all of the following:

- one explicit replay owner
- one reconnect trigger path
- one sync-status integration
- one pending-count integration
- one failure/removal path visible to the user

If those are not present, the separate queue should not exist.

### Required Changes

- remove the orphaned side queue pattern or explicitly wire it into the authoritative sync layer
- ensure offline chat sends appear in home/account/sync-status pending counts
- ensure queued chat sends surface as pending items in the chat UI
- stop any feature from treating "stored locally" as "delivered to backend"

### AI Chat Specific Rule

- do not start AI-thinking or assistant-response UX until the user message has been durably accepted by the server or deliberately represented as queued-without-response

### Acceptance Criteria

- offline chat sends increase visible pending counts
- reconnect or manual sync replays those sends through one owned path
- pending chat sends become confirmed messages only after server acknowledgment
- the user can inspect and remove failed messaging operations from the same sync surface as other offline work

## Workstream 4: Service Worker and Routing Contract

### Problem

The service worker emits `SYNC_MESSAGES` and `NAVIGATE_TO_CHANNEL`, but the app only listens for `SYNC_COMPLETE`. It also opens `/messages/...` even though AquaMobil is mounted under `/mobile`.

### Required Changes

- implement client-side handlers for `SYNC_MESSAGES` and `NAVIGATE_TO_CHANNEL`
- move notification-target route construction into one shared basename-aware helper
- make service-worker navigation explicitly `/mobile`-aware
- do not rely on relative assumptions or browser scope quirks for notification routing

Recommended implementation direction:

- build notification targets from a single route builder shared between app routing and service-worker code
- use the app base explicitly, or derive the path from service-worker scope in a controlled way

### Acceptance Criteria

- clicking a push notification with an open AquaMobil window routes to the intended channel
- clicking a push notification with no open AquaMobil window opens `/mobile/messages/{channelId}`
- reconnect events trigger the intended client-side sync behavior when a window is already open

## Workstream 5: UI Truthfulness Across Offline States

### Problem

Several mobile surfaces overstate success when the underlying operation is only queued or not yet replayed.

### Required Changes

- replace definitive success copy with stateful copy: `queued`, `syncing`, `synced`, `failed`
- align task actions, leave submit, and messaging send with the same semantic state model
- ensure home and account badges represent all pending work, not just one queue implementation

### Acceptance Criteria

- no mobile surface labels queued work as completed
- every pending write visible to the user is also visible in at least one canonical sync surface

## Workstream 6: Validation Plan

After implementation, re-run the AquaMobil mobile audit under the orchestrator with the same narrow focus.

### Mandatory Validation Scenarios

1. Leave submit while online, then immediate return to `My Leaves`.
2. Leave submit while offline, reconnect, then verify readback state convergence.
3. Double-tap leave submit under degraded network and confirm no duplicate domain writes.
4. Chat send while offline, reconnect, then verify replay and channel readback.
5. Push notification click with an already-open messaging window.
6. Push notification click with no open AquaMobil window.
7. Sync Status, Home, and Account surfaces while messaging and non-messaging operations are both pending.

### Exit Criteria

- no queue UUID is ever used as a domain aggregate ID
- no offline business action lives in a hidden or orphaned queue
- notification navigation is basename-correct
- immediate post-write screens show converged or explicitly queued state, not stale cached state disguised as truth

## Recommended Execution Sequence

1. Fix leave architecture first. It has both hard contract failure and incorrect ID semantics.
2. Consolidate messaging queue ownership second. This removes the current hidden-state problem.
3. Complete service-worker/client routing contracts third. This closes the reconnect and push path.
4. Then normalize UI truth states and re-run the mobile audit.

This order is deliberate: it removes structural causes before cosmetic symptoms, and it avoids shipping another round of patches on top of broken ownership boundaries.
