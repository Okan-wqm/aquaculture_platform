# ADR-043 — Support-conversation boundary: threads vs tickets are two products, not one

- **Status:** Accepted
- **Date:** 2026-07-13
- **Owner:** platform operator (Okan) + auth-service owners
- **Tracking:** `docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-388` (DB-IDENT-MEDIUM-001)
- **Relates to:** ADR-013 (messaging isolation — tenant-internal messaging is a THIRD, unrelated surface), 2026-07-11 database E2E audit remediation Faz 8-A7

## Context

auth-service carries two persistence families that both model SuperAdmin ↔
TenantAdmin conversations, which the database audit flagged as a possible
double-model (DB-IDENT-MEDIUM-001):

1. **Support message threads** — `auth.message_threads` + `auth.messages`
   (`MessageThread`, `Message` in
   `apps/auth-service/src/modules/messaging/entities/message-thread.entity.ts:42`
   and `.../message.entity.ts:78`; GraphQL types `SupportMessageThread` /
   `SupportMessage`, renamed to avoid Apollo Federation collision with
   messaging-service).
2. **Support tickets** — `auth.support_tickets` + `auth.ticket_comments`
   (`SupportTicket`, `TicketComment` in
   `apps/auth-service/src/modules/support/entities/support-ticket.entity.ts:71`
   and `.../ticket-comment.entity.ts:52`).

Both are live and FE-reachable from the tenant-admin remote:
`MY_THREADS_QUERY` (`web/modules/tenant-admin/src/graphql/communication-queries.ts:15`
→ `mySupportThreads`, resolver
`apps/auth-service/src/modules/messaging/resolvers/messaging.resolver.ts:32`)
and `MY_TICKETS_QUERY` (`communication-queries.ts:150` → `myTickets`,
resolver `apps/auth-service/src/modules/support/resolvers/support.resolver.ts:35`),
both invoked through `web/modules/tenant-admin/src/lib/api.ts:741` and `:818`.

A surface-level read ("two tables of admin↔tenant messages") suggests
consolidation. A structural read of the entities shows they encode different
lifecycles:

| Concern | Thread (`message_threads`) | Ticket (`support_tickets`) |
|---|---|---|
| State machine | `open → closed → archived` (`ThreadStatus`, message-thread.entity.ts:20) | `open → in_progress → waiting_customer → resolved → closed` (`TicketStatus`, support-ticket.entity.ts:36) |
| SLA | none | response + resolution deadlines, breach predicates (`slaResponseDeadline`/`slaResolutionDeadline`, support-ticket.entity.ts:135-141; `isResponseSLABreached()`/`isResolutionSLABreached()`, :192-204) |
| Triage metadata | none | `category`, `priority`, `assignedTo`, `firstResponseAt` (support-ticket.entity.ts:102-121, :145) |
| Outcome record | none | `satisfactionRating`, `satisfactionComment`, `resolvedAt` (support-ticket.entity.ts:147-158) |
| External identity | UUID only | human-readable `ticketNumber` `TKT-YYYY-NNNNNN` minted `@BeforeInsert` (support-ticket.entity.ts:180-187) |
| Read tracking | per-side unread counters (`unreadCountAdmin`/`unreadCountTenant`, message-thread.entity.ts:84-90) | none (comments are ticket history, not chat) |

## Decision

**Declare the boundary; do NOT consolidate.**

1. **Ticket = SLA-tracked formal issue lifecycle.** A tenant reports a
   problem or request that must be triaged, assigned, answered within a
   deadline, resolved, and rated. The ticket row is the record of that
   obligation; `ticket_comments` is its append-only case history.
2. **Thread = free-form operational chat.** A lightweight, subject-scoped
   back-and-forth between platform staff and a tenant admin (announcements,
   clarifications, onboarding help) with read/unread semantics and no
   completion obligation.
3. **Routing rule:** anything that carries an obligation to respond or
   resolve (bug, billing dispute, feature request, incident) belongs in a
   ticket; conversational contact with no completion semantics belongs in a
   thread. A thread that turns into an obligation gets a new ticket; the
   thread is not retrofitted.
4. Both families stay in the `auth` schema (platform-level, cross-tenant by
   design per D14 — SuperAdmin reads across tenants; every row is
   tenant-keyed with `tenantId` FK → `auth.tenants` ON DELETE CASCADE).

### Denormalised counters — reconciliation expectation

`messageCount` / `unreadCountAdmin` / `unreadCountTenant` on threads and
`commentCount` on tickets are display-optimisation denormals, NOT sources of
truth. The child-row count (`COUNT(*)` over `auth.messages` /
`auth.ticket_comments`) is the SSoT.

- Writers keep them consistent transactionally-adjacent via atomic
  `repository.increment()` — never read-modify-write
  (`apps/auth-service/src/modules/messaging/services/messaging.service.ts:262-266`
  for `messageCount`, `:279-293` for the unread counters;
  `apps/auth-service/src/modules/support/services/support.service.ts:284-289`
  for `commentCount`). Creation seeds them at 1 because the initial
  message/description is persisted as the first child row
  (`messaging.service.ts:203-205`, `support.service.ts:226`).
- Because increments run as separate statements after the child-row save,
  a crash between the two writes can under-count by one. Accepted: the
  counters gate nothing (no billing, no quota, no auth decision — list-view
  badges only), and any drift self-heals on recomputation. If a counter is
  ever promoted to a gating input, that promotion MUST move the increment
  into the same transaction as the child insert and add a reconciliation
  job; doing so is a contract change against this ADR.

## Consolidation explicitly rejected

Merging the two families (e.g. tickets as a "typed thread" or threads as
"SLA-less tickets") was considered and rejected:

1. **Different lifecycle semantics.** The ticket state machine, SLA
   deadlines, assignment, satisfaction capture, and `ticketNumber` identity
   have no counterpart on threads; a merged table is a union type with half
   its columns null per row and both state machines entangled in one
   `status` enum — strictly worse than two honest models.
2. **Live frontend usage of both.** Tenant-admin ships both surfaces today
   (`MY_THREADS_QUERY` + `MY_TICKETS_QUERY` and their mutation families).
   Consolidation would be a breaking GraphQL contract change across
   auth-service and the tenant-admin remote for zero data-integrity gain —
   the audit found no case where the same conversation is double-written
   into both families.
3. **No shared write path.** The modules
   (`apps/auth-service/src/modules/messaging/` vs `.../modules/support/`)
   share no service or repository; there is no split-brain writer to
   converge, which is what distinguishes this from genuine double-models
   the same audit did collapse (ADR-042 `shared.user_permissions`, A5
   pricing fork).

Non-goal: this ADR does not touch tenant-internal user↔user messaging
(messaging-service, ADR-013) or the AI conversation surface (ADR-044).
Those are separate bounded contexts; the federation-facing type renames
(`SupportMessageThread`, `SupportMessage`) exist precisely to keep them
apart.

## Consequences

### Positive

- The audit finding is answered with a documented boundary instead of a
  risky consolidation; future readers have the routing rule and the
  counter-reconciliation contract in one place.
- Federation naming (`Support*` prefix) plus this ADR make the three
  conversation surfaces (support thread, support ticket, tenant messaging)
  individually discoverable and non-overlapping.

### Negative / accepted risk

- Two GraphQL surfaces for "contact the platform" remain; the tenant-admin
  UI is responsible for presenting the routing rule (ticket for issues,
  thread for chat) so users do not file obligations into chat.
- The one-statement-gap counter drift window described above remains, by
  the documented display-only contract.
