# An unread badge that could never light up — 2026-09-08

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `a12f2c274`.

Found while assessing what PR #1035 (`APA-248`, generate the admin contracts instead of declaring
them twice) still holds. Its pipeline landed; this is what the unfinished half costs.

## ADMIN-HIGH-110 — the messaging list showed zero unread on every thread

**Severity:** HIGH. **Owner:** admin-expert. **State:** IN-PROGRESS.

### Evidence

`GET /support/messages/threads` returns a **projection**, built at
`messaging.service.ts:154-168`:

```text
{ id, tenantId, tenantName, subject, lastMessage, lastMessageAt, unreadCount, messageCount, isClosed }
```

`unreadCount` is the row's `unreadAdminCount`; `tenantName` is read out of the thread metadata;
`lastMessage` is the newest message's first 100 characters. It is not the `message_threads` row.

The client typed that response as `MessageThread` — which is the **GraphQL** support thread
(`status`, `unreadCountAdmin`, `unreadCountTenant`), the shape `useMessaging` consumes. `apiFetch`
performs no transformation, so `MessagingPage.tsx:87-94` spread the correct payload and then
overwrote it:

```text
...thread,                                   // unreadCount and isClosed arrive here, correct
unreadCount: thread.unreadCountAdmin || 0,   // undefined || 0        -> 0
isClosed: thread.status === 'closed',        // undefined === 'closed' -> false
```

Both correct values were already on the object. The two derived lines destroyed them, and `|| 0` is
what made it silent — no crash, no `undefined` in the DOM, just a badge that renders only when the
count is `> 0` (`MessagingPage.tsx:399-401`) and therefore never rendered.

**Operator effect.** A tenant sends a support message. The thread's unread badge stays at zero.
Nothing on the screen says a reply is owed.

### Root cause, one layer down

The obvious repair — fix the two lines — leaves the reason intact. The reason is that the admin
panel had no contract shape to source from:

`ThreadSummary` was an **interface** (`support.entity.ts:523`). The `@nestjs/swagger` plugin emits
schemas for **classes** only, so this projection never reached `openapi.json`. The frontend
therefore had a generated contract with 217 schemas and no entry for the one endpoint it was
typing, and reached for the nearest same-named type instead.

### Rule violated

A response shape that the generated contract cannot describe is a shape the client will
hand-declare, and a hand-declared shape drifts silently.

### Fix

- **Tier 1 (impossible).** The projection is now `ThreadSummaryDto`, a class; the controller
  declares `Promise<PaginationResultV1<ThreadSummaryDto>>`; and `@ApiExtraModels(ThreadSummaryDto)`
  registers it, because the plugin resolves a response type structurally and stops at the generic —
  it reads the envelope and never reaches the element. The frontend type is
  `ApiSchema<'ThreadSummaryDto'>`, so a backend rename is now a compile error in the page that used
  it rather than a silent zero. The two derived lines are gone: the values arrive correct and are
  used as they arrive.
- **Already enforced.** `admin-openapi-artifact-parity.spec.ts` regenerates both the artifact and the
  frontend client from the module graph and compares the committed bytes, so this DTO cannot go
  stale without failing the PR that changed it.

`@ApiExtraModels` is the first manual swagger annotation in this service — the other 217 schemas come
from the plugin reading return types. It is here because the generic wrapper defeats structural
resolution, and that is documented at the callsite so the next person does not read it as a habit
worth copying.

### Verification

- `nx test admin-api-service` and `nx test admin-panel` (132 tests) green.
- `admin-openapi-artifact-parity.spec.ts` + `admin-route-contract-ci.spec.ts` green — the artifact
  and the client both regenerate to the committed bytes.
- `npm run type-check` across all projects green; the contract-sourced type compiles against every
  existing read site.

## ADMIN-MEDIUM-111 — the same shape, 26 more times

`services/contract.ts` already states the rule: _"Use `ApiSchema<'CreateTenantDto'>` rather than
re-declaring a shape by hand."_ 51 types follow it. 142 are hand-declared, which is mostly correct —
view models, page state, enums, and payloads the backend does not expose.

The actionable subset is the **26** whose name matches a contract schema, of which **16 disagree
with it field-for-field**. Two are as wrong as this one was:

| Type                            | Frontend declares                            | Contract has                                  |
| ------------------------------- | -------------------------------------------- | --------------------------------------------- |
| `database.ts` `SchemaMigration` | `name`, `sql`, `error`                       | `migrationName`, `downScript`, `errorMessage` |
| `tenant.ts` `Tenant`            | `tier`, `limits`, `farmCount`, `sensorCount` | `plan`, `maxUsers`, `subscriptionEndsAt`      |

They are **not** mechanically fixable by aliasing all 26. Each needs the check this one got — which
endpoint actually returns it, and is the contract shape the response shape — and at least one
(`support.ts` `MessageThread`) must stay hand-declared, because it is the GraphQL thread and not a
REST DTO at all.

**No gate ships with this.** A shadowing rule today would need a 26-entry allowlist, which would be
longer than the enforcement it provides and would read as compliance rather than be it. The gate
belongs with the last conversion. Tracked with owner `admin-expert` and deadline **2026-10-06**.

---

## 2026-09-08 (later) — closing ADMIN-MEDIUM-111, and the five defects it was hiding

ADMIN-MEDIUM-111 was raised as "26 hand-declared types, 16 disagree with the contract". Working
through them one at a time — the per-endpoint check the finding said each would need — turned up
**five live defects**, three of them severe enough to register on their own.

### The measurement was wrong, in the flattering direction

The earlier pass reported 22 of 23 candidate aliases compiling cleanly. That number came from an
experiment that inserted `import type { ApiSchema }` after the file's first newline — **inside** the
leading docblock. TypeScript could not resolve `ApiSchema`, every alias became an error type, and
every downstream read of those types type-checked vacuously.

With the import placed correctly: **14 of 23 alias with zero errors, 9 break.** Every one of the
nine was a real disagreement, and each needed its own decision.

### ADMIN-HIGH-112 — the audit severity filter offered three values the column has never held

`AuditSeverity` (`audit.entity.ts:55`) is `info | warning | critical`. The panel declared
`low | medium | high | critical` and its dropdown offered Low, Medium, High, Critical.

- Filtering by **Low, Medium or High returned nothing, always** — an auditor reads that as "no
  high-severity events".
- `getSeverityBadgeVariant` mapped `low/medium/high/critical`, so real `info` and `warning` rows
  both missed the map and fell through `|| 'default'`. **A warning-severity audit entry rendered
  identically to a routine one.** Only `critical` worked, by coincidence of appearing in both
  vocabularies.
- The same type declared `metadata`; the column is `details`, so the drawer's Metadata block never
  rendered.

The panel already had the RIGHT union — `security.ts` declared `AuditSeverity` correctly — and the
audit page imported the wrong one of the two. Both now derive from the contract.

### ADMIN-HIGH-113 — saving a feature-toggle edit has never worked

`FeatureTogglesPage.handleUpdate` PUT a payload containing `scope` and `isExperimental`.
`UpdateFeatureToggleDto` declares neither, and the platform `ValidationPipe` runs
`forbidNonWhitelisted: true` (`create-service-app.ts:467`), so **every save was rejected 400.**

The client could not see it because `settings.ts` typed the call as `Partial<FeatureToggle>` — the
RESPONSE type — and typed create as `Omit<FeatureToggle, 'id' | 'createdAt' | 'updatedAt'>` while a
real `CreateFeatureToggleDto` existed all along. A request typed from a response shape is not a
request contract. Both calls now take their own DTO, and the Scope control is disabled when editing
because scope is fixed at creation.

The same type's `scope` union was also missing `environment`, so an environment-scoped toggle
rendered with the grey fallback badge and its edit form offered no matching option.

### The tenant pages — a Trial badge and a Last Activity that could not draw

Covered in its own commit. `TenantDetailDto` and `TenantListItemDto` were `interface`s, invisible to
the swagger plugin, which is why the panel hand-declared them at all: the same root cause as
ADMIN-HIGH-110. Both are classes now. `lastActivityAt` had been removed backend-side under
DB-ADMIN-HIGH-003 (no column ever backed it) and both pages still rendered it; `isTrialActive` is on
the detail DTO and not the list one, so the list's Trial badge had never drawn.

### Three more, each the same shape

| Type               | Drift                                   | Effect                                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobStatus`        | omitted `paused`                        | `JobQueuePage` declared a THIRD local copy and never imported the shared one; `getStatusBadge`'s `Record<JobStatus, …>` had no `paused` entry, so a paused job rendered as an ordinary queued one                                        |
| `JobQueue`         | `activeCount` vs `runningCount`         | rendered under a label reading "Running" — blank on every queue card                                                                                                                                                                     |
| `AnnouncementType` | extra `'success'`                       | `getTypeIcon` / `getTypeColor` are four-case switches with no default: a `success` announcement would render with no icon and `className={undefined}`                                                                                    |
| `SchemaMigration`  | almost every field renamed              | the page had already papered over it with `migration.name \|\| migration.migrationName` and a THIRD declaration carrying both spellings as optional; the "applied / failed schemas" cell had no counterpart at all and always showed `-` |
| `TicketCategory`   | extra `bug`, and `bug_report` unhandled | exactly inverted: every real bug-report ticket rendered with no icon while the member that can never arrive had one. `account` had no icon either                                                                                        |
| `TicketStatus`     | extra `waiting_internal`                | the status dropdown offered a status `support.entity.ts` cannot store                                                                                                                                                                    |

Every mapper touched is now an exhaustive `Record<Union, …>` rather than a switch or a
`Record<string, …>`, so a member added server-side is a compile error rather than a silent default.

### ADMIN-MEDIUM-114 — the one that is deliberately NOT aliased

`TicketComment` is the inverse defect. `TicketController.getComments` declares no return type, so
the plugin resolved it through the service to the ENTITY and the contract's `TicketComment` requires
`ticket: SupportTicket`. `TicketService.getComments` calls `findAndCount` with no `relations`, so
that property is **never in the response**: the contract OVERSTATES what the endpoint sends.

Aliasing to it would demand a field that does not arrive, so `support.ts` keeps a hand-written
`TicketComment` with the reason written at the declaration. Closing it means an explicit
`TicketCommentDto` on the endpoint — a response-shape change with its own review. Two adjacent items
fold in when it is done: `api/support.ts` declares a fourth inline copy of the shape, and
`TicketsPage.fetchComments` hand-remaps it field by field with `as string` casts.

**CLOSED 2026-09-10 by W9s**, exactly that way. `TicketCommentResponseDto` and
`TicketCommentPageDto` type the endpoint; `SupportTicket.comments` and `TicketComment.ticket` carry
`@ApiHideProperty()`, because no read path loads either and the schema had listed `comments` among
the REQUIRED fields of every ticket; `services/types/support.ts` aliases the contract; and both
adjacent items folded in as predicted — the inline copy in `api/support.ts` and the hand-remapping
in the page are gone. The `TRACKED_SHADOWS` allowlist in
`tests/invariants/admin-panel-contract-shadowing.spec.ts` is empty as a result, which is how that
entry was always meant to leave.

### One thing checked and found NOT to be a defect — **CORRECTED 2026-09-10, it was one**

> **This section was wrong.** It is kept, with the correction below it, because a review that
> quietly deletes its own mistaken clearance teaches nothing. ADMIN-CRITICAL-156 closes the defect
> this section cleared.

The original note read:

> `getComments` returns `PaginationResultV1<TicketComment>`, an envelope, while the client types it
> as a bare array and calls `.map` on the result. That reads like a guaranteed TypeError. It is not:
> `apiFetch` unwraps `envelope.data` before returning.

`apiFetch` has **two** return paths, and that reasoning used the wrong one. Traced end to end
(ADMIN-CRITICAL-156):

1. `ResponseInterceptor.pageEnvelope` (`shared/response.interceptor.ts:133`) sends
   `{success, data: page.items, meta: {...paginationMetadataV1(page), timestamp}}` — so
   `envelope.data` is the array and `envelope.meta` carries the six pagination fields.
2. `apiFetch` tests `isPaginationMetadataV1(envelope.meta) && Array.isArray(envelope.data)` FIRST
   (`http-client.ts:321`). `isPaginationMetadataV1` validates only those six keys and their
   derivation (`pagination-contracts/src/index.ts:204`), so the extra `timestamp` does not fail it.
   Both conditions hold.
3. That branch returns `{data, total, page, limit, totalPages, hasNextPage, hasPreviousPage}` — an
   **object**. The `return envelope.data` the note relied on is the `else`, and it never runs for a
   paginated route.

So `(data || []).map(...)` in `TicketsPage.fetchComments` ran `.map` on an object and threw a
`TypeError`, which the handler's `catch` sent to `console.error`. Every ticket's comment thread
rendered "No comments yet", on every ticket, silently.

The indirect evidence was available at the time and points the same way: every other paginated
admin client declares `PaginatedResult<T>` and reads `.data`, which is only correct **because** that
first branch fires. `TicketComment` was the one client that declared a bare array.

### Verification of the ADMIN-MEDIUM-111 closure

- `tsc -p web/modules/admin-panel` 0 errors at every step, including the alias experiment that
  produced the corrected 14/9 split.
- `nx test admin-api-service` 837 passed / 38 skipped; `nx test admin-panel` green;
  `nx lint admin-panel` green; `npm run type-check` all 41 projects.
- Both contract artifacts regenerated and committed.

---

## ADMIN-HIGH-115 — the same defect one level out: a PAGE re-declaring the type

ADMIN-MEDIUM-111 sourced `services/types` from the contract. That is only half the cure. A page can
declare its own copy and never import the shared one, and **seventeen do**.

This is not hypothetical — it is where two of the six defects above came from. `JobQueuePage`
declared a local `JobStatus` missing `paused`; `DatabaseManagementPage` declared a local
`MigrationHistoryItem` carrying two spellings of every field as optional. Both sat next to a
`services/types` module that already owned the name, and both were fixed by hand in the commit that
closed ADMIN-MEDIUM-111 — with nothing to stop the next one.

### Classification first, because the raw count is misleading

Twenty declarations outside `services/types` share a name with something that module exports. Three
of them **build on** the shared type — `TicketsPage`'s `interface SupportTicket extends
Omit<ApiSupportTicket, 'tenantName' | 'tags'>` and two siblings — which is the intended pattern:
they are chained to the contract, so the ADMIN-MEDIUM-111 conversions reach them. Seventeen are
standalone re-declarations.

Of those seventeen, thirteen differ textually from the shared type. Text is not the test: two of the
thirteen differ only in expression (`AuditSeverity` became `ApiSchema<'AuditLog'>['severity']`, the
same three values) and one only in member order. The ones that matter are where the **values**
differ.

### The live one, on the GDPR compliance surface

`CompliancePage` declares its own `DataRequestStatus`:

```text
page:     pending | in_progress | identity_verification | processing | completed | rejected
contract: pending | in_progress |                                      completed | rejected | expired
```

- **Identity Verification and Processing were offered in the status dropdown.** `statusFilter` is
  sent to the API (line 613 → `apiParams.status`) _and_ applied client-side (line 715), so picking
  either filtered to nothing through both paths. A compliance officer reads an empty list as "there
  are no requests in that state".
- **`expired` — which the API does send — was in neither the dropdown nor `getStatusColor`'s
  cases**, so it could not be filtered for and rendered grey through the `default` branch,
  indistinguishable from `pending`.
- **And `mapDataSubjectRequest` relabelled it:** `status: request.status === 'expired' ? 'rejected'
: request.status`. Those are not the same thing. **Expired** means the statutory response window
  ran out — the platform's own failure. **Rejected** means a reasoned refusal. The page built to
  report GDPR compliance was showing the first as the second.

### What was checked and found NOT to be drift

The same page translated `erasure` ↔ `deletion` on the way in (line 177) and back out (line 138).
That reads like drift and is not: the UI deliberately presented GDPR's own vocabulary against an API
that says `deletion`.

It is removed anyway, for a different reason — a value renamed in and back out again is a second
vocabulary maintained by hand, and it is what made the status drift beside it hard to see. One
vocabulary now, the API's, with "Erasure (Right to be Forgotten)" kept where a presentation choice
belongs: on the label. `objection`, also in the page's type union, is unreachable from the UI and
was dead rather than wrong.

### Two more, both of a contract-derived type

| Site                           | What it was                                                                                                                  | Treatment                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuditTrailPage.AuditSeverity` | value-identical to the shared one                                                                                            | **imported.** Restating a union that agrees today is how one that disagrees tomorrow gets written — which is exactly how `audit.ts` and `security.ts` came to disagree (ADMIN-HIGH-112) |
| `ReportsPage.ReportDefinition` | **not a shadow — a collision.** A UI picker card with `icon: React.ReactNode`, sharing a name with the contract's report row | **renamed `ReportPickerCard`**, the treatment `MessageThread` got: the collision stops existing rather than being allowlisted                                                           |

### The gate's second rule, and why it is scoped

> No declaration outside `services/types` may re-declare a type that module sources from the
> contract.

**Fourteen** page-local declarations still shadow a _hand-written_ shared type. They are not gated:
a fourteen-entry allowlist would be the theatre `admin-panel-contract-shadowing.spec.ts` exists to
avoid, and it is the same argument that kept the first rule from shipping until eight of nine
conversions were done. They stay tracked here.

Where the shared type is **contract-derived**, the local copy is unambiguously wrong — the shared
one is generated from the API and the local one cannot be. That set is now empty, so the rule ships
with **no allowlist at all**.

Verified by negative control: restoring `AuditTrailPage`'s local union to
`low | medium | high | critical` fails the new rule, naming that file.

## ADMIN-MEDIUM-116 — the analytics time-series contract is invisible to codegen

Surfaced while closing PR #1035, which proposed replacing OpenAPI codegen with a
TypeScript-compiler-driven generator. That PR's stated premise —

> Not OpenAPI, though the finding proposed it: admin-api bootstraps no
> `SwaggerModule`

— is false on today's `main`: `apps/admin-api-service/src/openapi/generate-openapi.ts`
calls `SwaggerModule.createDocument`, `openapi` is an Nx target, and both
`openapi.json` and the generated panel client are committed. The route that PR
rejected is the one that landed. But its concrete example is worth keeping,
because re-checking it found something real that nothing tracks.

### What #1035 claimed, and what is actually true now

That PR reported `AnalyticsDashboardPage` declaring `value: number` against a
backend `number | null`, so unmeasured buckets rendered as real zero points on
the trend line. **That mismatch does not exist on `main`.** Both sides declare
`value: number`:

- `apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts:149`
- `web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx:98`

Reporting it as a live bug would have been wrong, so it is recorded here as
checked and refuted rather than repeated.

### What IS live

The two declarations agree **by coincidence, with nothing holding them there** —
and unlike every other case in this document, the gate shipped with
ADMIN-MEDIUM-111 and ADMIN-HIGH-115 cannot help, because there is nothing to
derive from:

```console
$ git show origin/main:apps/admin-api-service/openapi.json | jq '.components.schemas | keys | length'
225
$ ... | jq '.components.schemas | has("TimeSeriesPoint"), has("TimeSeriesData"), has("TimeSeriesResponse")'
false
false
false
```

`TimeSeriesPoint`, `TimeSeriesData` and `TimeSeriesResponse` are declared as
`interface`, and the `@nestjs/swagger` plugin emits schemas for **classes only**.
They sit on a live response path — `analytics.controller.ts:135` returns
`toTimeSeriesResponse(...)` — so the analytics dashboard's entire time-series
contract crosses the wire without ever appearing in `openapi.json`, and the page
has no generated type to source. Hand-declaring it is not a mistake there; it is
the only option the contract leaves.

This is the **fifth** occurrence of the one root cause this whole document keeps
arriving at: ADMIN-HIGH-110 (messaging unread), ADMIN-HIGH-112 (audit severity),
ADMIN-HIGH-113 (feature-toggle DTOs), the tenant detail pair, and now analytics.
Each time the shape was an interface, each time the plugin emitted nothing, and
each time the frontend wrote its own copy and was free to drift.

### Fix for the analytics contract

Convert the three analytics response interfaces to classes with `@ApiProperty`,
regenerate `openapi.json` + the panel client, and point
`AnalyticsDashboardPage` at `ApiSchema<'TimeSeriesResponse'>` — after which the
ADMIN-HIGH-115 gate covers it automatically, because it will then be a
contract-derived type that a page re-declares.

Not done here: this is a backend contract change on a live analytics route, it
needs its own OpenAPI artifact regeneration, and it belongs with the remaining
ADMIN-HIGH-115 conversions rather than inside a PR-closure sweep.

Owner: okan. Deadline: 2026-10-06 (tracked alongside ADMIN-HIGH-115).
