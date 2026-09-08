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
