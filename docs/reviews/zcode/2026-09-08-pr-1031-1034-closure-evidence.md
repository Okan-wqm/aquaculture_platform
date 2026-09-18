# What PRs #1031 and #1034 still hold that main does not — 2026-09-08

PR [#1031](https://github.com/Okan-wqm/aquaculture_platform/pull/1031) is a 313-file, 49-commit
draft carrying the nine-wave feeding-v2 post-merge audit programme. Its content was landed on `main`
by re-derivation rather than by merging the branch, so the question "is anything still only in the
PR?" cannot be answered by reading either history. It was answered by comparing the two trees.

## Method

Not "I remember porting it". For each of the 313 paths the PR touches, does the path exist on
`main`? 26 do not. Each of those 26 was then chased by NAME rather than by path, because the
re-derivation renumbered migrations and moved files to better homes.

## Result: 25 of 26 are on main, most of them improved

### Migrations — renumbered, not missing

Fifteen migrations the PR carries are on `main` under `main`'s own numbering:

| PR number                                                     | main number            |
| ------------------------------------------------------------- | ---------------------- |
| `1806800000000-BackfillFeedingRecordBatchLocationAttribution` | same                   |
| `1806900000000-EnforceSingleLiveAssignmentPerUnit`            | same                   |
| `1807000000000-AddDayPlanGrowthReconciliation`                | same                   |
| `1807100000000-AddDayPlanLiveResolution`                      | same                   |
| `1807200000000-CreateFeedingClockInfrastructure`              | same                   |
| `1807300000000-MakeSiteTimezoneInheritable`                   | same                   |
| `1807400000000-AddForecastPoolScope`                          | same                   |
| `1807500000000-AddFeedingMealReadiness`                       | same                   |
| `1807600000000-AlignFeedingMealMethodEnum`                    | same                   |
| `1807700000000-CapDayPlanRecalcLog`                           | same                   |
| `1807800000000-RestoreStorageInventoryCanonicalKey`           | same                   |
| `1807900000000-CompleteFeedInventoryLedgerBackfill`           | same                   |
| `1808000000000-AddStockMovementLotReceivedDate`               | `1809900000000`        |
| `1808100000000-AddAssignmentManualBandPin`                    | `1810000000000`        |
| `1808200000000-WidenMealWindowSweepIndex`                     | `1810100000000`        |
| `config:1805500000000-RestoreConfigSchemaOwnerBoundary`       | `config:1807400000000` |

### Services and gates — present, some relocated

- `FeedAllocationService` → `apps/farm-service/src/storage/services/feed-allocation.service.ts`,
  with its unit spec and a real-Postgres e2e spec. Moved into the **storage** domain, which is where
  stock allocation belongs.
- `FeedingClockService`, the `tenant_localization` entity, its projection listener and the
  auth-service DTO: all present.
- Eight of the eight invariant gates the PR names are on `main`. `raw-sql-entity-backed` lives at
  `apps/farm-service/src/feeding-protocol/__tests__/` rather than `tests/invariants/`, which is
  correct for a farm-scoped gate.

### `p0-fixes-verification` — main's copy is better than the PR's

The PR carries `src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts`. `main` has
`src/__tests__/p0-fixes-verification.spec.ts`, and its docblock explains the move:

> Until 2026-09-04 this file was `src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts`, a name no
> Jest config matched (the unit lane ignores `src/__tests__/e2e/`, the e2e config matches `test/**`),
> so none of it had run in CI (INFRA-MEDIUM-158).

So the PR's version had **never executed**. `main` moved it into the lane that runs it and dropped
the two blocks `tests/invariants` already owns repo-wide (the `@Headers('x-tenant-id')` ban and the
frozen `@nestjs/cqrs` importer set) rather than keeping them as copies.

### `tenant-schema-routing.architecture.spec.ts` — deliberately deleted

Recorded in the root `CLAUDE.md`: it was a weaker copy of
`tests/invariants/entity-schema-declaration.spec.ts`.

### Dead-letter — a different, better shape

The PR carried a per-service `event_dlq` table for farm, alert and notification, plus a
`DeadLetterModule.forRoot({schema, source})` in `libs/backend-common`. `main` landed instead:

- `platform/libs/event-bus/src/interfaces/dead-letter-sink.ts` — the `IDeadLetterSink` interface and
  a `LoggingDeadLetterSink` default;
- `platform/libs/event-bus/src/nats/dlq-envelope.ts` and `interfaces/handler-outcome.ts` (the PR's
  `message-disposition.ts`), with the ack/nak/term sites in `nats-event-bus.ts`;
- `NotificationLogDeadLetterSink`, which writes a `NotificationLog` row with status `DEAD_LETTER` —
  the row the admin panel's dead-letter query and the health dashboard already read — PII-redacted.

Reusing a row the product already surfaces beats a table nothing queries, so the notification
migration is superseded rather than missing.

## The one thing that is genuinely not on main: PLAT-MEDIUM-912

`apps/alert-engine/.../CreateAlertEventDlq.ts` did not land and nothing replaced it.

Checking what that costs produced a more precise answer than "alert dead-letters are lost", and the
first version of this note was going to say exactly that. It would have been wrong.

`NatsEventBus` binds `LoggingDeadLetterSink` when a service binds none
(`nats-event-bus.ts:218`), so a dead-letter is **never silent** anywhere:

- a structured `event_bus_dead_letter` line carrying `eventId`, `tenantId`, `disposition`, `reason`,
  `deliveryCount` and `maxDeliver`;
- `deliveryMetrics.observeDeadLetter(eventType, retryExhausted)` — a Prometheus counter;
- `msg.term()` raising the NATS `MSG_TERMINATED` advisory an operator can alert on.

What farm-service and alert-engine lack is a **durable, queryable** record. Only notification-service
binds a sink; recovering a terminated message in the other two means log scraping.

The part that is actually wrong today is a comment. Beside `msg.term()`:

```text
// PLAT-HIGH-902: `term`, not `ack`. The envelope is durably stored,
// so redelivery must stop — but spelling that as an ack is the very
// conflation of success and failure this finding closes.
```

"The envelope is durably stored" is true only for a service that bound a sink, and it is stated
unconditionally. Either bind a durable sink in both services or narrow the comment to what the
wiring guarantees — a comment that states a guarantee the wiring does not provide is worse than no
comment, because the next reader stops looking.

Owner `platform-kernel-expert`, due 2026-10-20.

### Closed on the comment, not on the wiring

The finding offers two resolutions and names which one is the live defect: _"Either bind a durable
sink in both services or narrow the comment to what the wiring guarantees; the comment is the part
that is wrong today."_ The comment is narrowed. It now says the message is RECORDED, and that how
durable that record is depends on whether the service bound a sink — with both cases spelled out and
farm-service and alert-engine named as the two that have not.

Binding durable sinks in those two is a larger change with a design question attached (a dedicated
`event_dlq` table per service, as PR #1031 proposed, or reuse of a row each service already
surfaces, as notification-service does). It is not folded in here, and the comment no longer claims
it has been.

## Verdict on #1031

PR #1031 can be closed. Its content is on `main`, and where the two differ `main` is the better of
the two in every case checked. The single residue is registered as PLAT-MEDIUM-912 with the
evidence above.

---

## PR #1034 — the same question, a different answer shape

PR [#1034](https://github.com/Okan-wqm/aquaculture_platform/pull/1034) closes APA-106 (CRITICAL),
APA-283 (CRITICAL) and APA-297.

### Scope, and a trap in measuring it

Compared against `main` naively, #1034 shows **383 changed files and ~150 not on main** — which would
suggest almost nothing landed. That number is wrong, and it is wrong in a way worth writing down: the
PR is **stacked on `claude/admin-panel-e2e-audit-9b80i5`** (PR #1021), not on `main`, so
`merge-base(main, head)` reaches back before #1021 and the diff carries all of #1021's work too.

Measured against its own declared base, #1034 is **55 files**, of which **15 are not on `main`**. They
cluster into exactly two groups.

### Group A — the impersonation subsystem (13 files): deliberately retired

`main` carries `apps/admin-api-service/src/migrations/1808800000000-RetireImpersonationAndDebugTools.ts`
and the architectural-arbiter recommendation
`docs/recommendations/architectural-arbiter/2026-09-05-adr-0007-cross-tenant-authority-delete-impersonation.md`.

The impersonation and debug-tools subsystem was **deleted platform-wide on an arbiter decision**,
taken after this PR was written. So `impersonation.service.ts`, `impersonation.controller.ts`,
`debug-tools.service.ts`, `feature-flag-debug.service.ts`, `ImpersonationPage.tsx`,
`DebugToolsPage.tsx`, their specs and `admin-impersonation-summary-contract.spec.ts` are not missing
from `main` — restoring them would be a regression against a deliberate decision.

That moots **APA-297** entirely. The finding was "every stat card on the impersonation page is wrong,
and the headline number is wrong in the reassuring direction". There is no impersonation page.

### Group B — the two gates: one landed under a better name, one went with the subsystem

`tests/invariants/admin-api-pagination-canonical.spec.ts` is on `main` as
`tests/invariants/admin-pagination-ssot.spec.ts`, and it is **larger** than the version #1034 carried.
Its rule (d) is APA-283's completeness half, and the docblock reproduces the PR's own reasoning:

> A bare `{ items, total }` has none of those, so it slips … `items` exactly like the canonical
> envelope, so it reads as correct at …

It also carries rules (a), (b) and (c), a transport-boundary fail-closed case and a NestJS-bridge
delegation case that #1034's version did not have.

### The findings themselves

- **APA-283** — `PaginationResultV1` is imported by **33** admin-api files; the gate above holds the
  rule. Closed.
- **APA-106** — `DiscountCodePage` on `main` reads `setDiscountCodes(codesResult.data)`. The
  `Array.isArray(codesResult) ? codesResult : []` guard whose only possible outcome was `[]` is gone,
  and `tests/invariants/admin-panel-paginated-consumer.spec.ts` — the gate #1034 wrote and repaired —
  is present. Closed.
- **APA-297** — moot, see Group A.

### Verdict on #1034

PR #1034 can be closed. Its two live findings are closed on `main` with the gates that hold them, and
its third addresses a subsystem the platform has since deleted.

### What closing these two PRs does not do

Neither closure touches the registry. The 14 findings #1031's own 2026-07-28 closure audit left open
(`FARM-HIGH-248`, `FARM-MEDIUM-288/258/268/254/247/256`, `FARM-LOW-263/270/277`, …) live in
`docs/reviews/_registry/findings.jsonl` and keep their state. A pull request is a delivery vehicle;
closing it says the code arrived, not that the work is done.
