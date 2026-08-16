# AquaMobil offline queue and sync audit — 2026-08-16

**Agent:** `realtime-sync-auditor` · **Mode:** CATCHER (read-only) · **Lane:** mobile
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** BLOCK
**Findings surviving verification:** 11 (CRITICAL 0 · HIGH 2 · MEDIUM 4 · LOW 5)

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** use the `PRODUCT-SYNC-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Scope

Read the full AquaMobil offline/sync stack:
,
,
`services/authenticated-fetch.ts`,
,
`components/QueuedStatusBadge.tsx`, `layouts/MobileLayout.tsx`, and the write/sync surfaces
,
plus `graphql/operations.ts`. On the backend I traced the authoritative sources:
,
farm-service `mobile-command/entities`, `feeding-protocol/services/meal-execution.service.ts`,
,
`mobile-dashboard/{resolver,handlers/get-todays-daily-ops-counts.handler.ts}`, and hr-service
. Repo-wide
greps confirmed which handlers actually consume the command envelope and that `calculateRetryDelay`
has no caller.

```text
web/apps/aquamobil/src/pwa/{offline-queue.ts,sw-replay.ts,operation-registry.ts,messaging-sw.ts}
```

```text
hooks/{useOfflineQueue.tsx,useAuth.tsx,useAlerts.ts,useNotifications.ts,useLatestReadings.ts,useDailyOpsStats.ts,useFarmRealtimeSync.ts,useEditMessage.ts}
```

```text
utils/{last-sync.ts,offline-sync-invalidation.ts,offline-optimistic.ts,tenant-query-keys.ts}
```

```text
pages/{sync/SyncStatusPage,account/AccountPage,_shared/RecordEntityPage,storage/StockMovementPage,storage/StockTransferPage,water-quality/WaterQualityRecordPage}.tsx
```

```text
libs/backend-common/src/mobile-command/{mobile-command-receipt.service.ts,mobile-command-envelope.input.ts}
```

```text
water-quality/{water-quality.resolver.ts,dto,service}`, `storage/{dto,services,handlers}
```

```text
leave/{leave.resolver.ts,handlers/*,leave-state-machine.ts}` \+ `attendance/handlers/*
```

## Executive summary

The offline write path is architecturally strong on identity: every queued op is AES-GCM encrypted,
tenant-partitioned by IndexedDB key, carries a stable `clientCommandId`+`payloadHash` envelope, and
nearly every queued mutation type has a real server-side at-most-once mechanism (farm/hr
command-receipt ledger, or a per-row `idempotencyKey` for storage/water-quality/messaging).
Duplicate-row-on-replay is therefore largely closed, and last-write-wins over a supervisor's edit is
structurally unreachable because every queued op is an append or an absolute idempotent set.

Convergence is where it fails. Logout — including the automatic fail-closed logout fired by
`authenticatedFetch` when a refresh token expires after a long offline shift — calls
`clearAllOperations()` and destroys the entire unsynced queue with no warning and no export.
Exponential backoff is dead code: retries are a fixed 30s loop capped at 5 attempts, after which a
record is permanently undeliverable and the only operator action is delete. The retry classifier is
an English-only substring match blind to farm-service's Turkish domain errors, so a genuine
server-side conflict (a meal finalized while the pour was queued) burns the retry budget and ends as
unrecoverable loss. The `createLeaveRequest → submitLeaveRequest` chain has no at-most-once coverage
on step 2, producing a permanent "Sync Failed" for a write that landed.

## Findings (by severity)

### HIGH

### PRODUCT-SYNC-HIGH-001

**Title:** Logout — including the automatic fail-closed logout — destroys the entire unsynced
offline queue with no warning, export or recovery

**Severity:** HIGH (filed as CRITICAL, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-CRITICAL-001` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/services/authenticated-fetch.ts:168 \-
  `if (!refreshed && authStore.logout) { await authStore.logout(); }` — refresh failure triggers
  logout with no user interaction
- web/apps/aquamobil/src/hooks/useAuth.tsx:195 \- `clearAllOperations(),` inside the awaited
  `clearAllUserData` wipe (called unconditionally at useAuth.tsx:471)
- web/apps/aquamobil/src/pwa/offline-queue.ts:500 \- `clearAllOperations(tenantId?)` with no
  tenantId deletes every `pending_*` key plus the AES session key (line 530-533), making any residue
  undecryptable
- web/apps/aquamobil/src/pages/account/AccountPage.tsx:747 \- logout dialog message is only
  `"Are you sure you want to log out?"`
- web/apps/aquamobil/src/pages/account/AccountPage.tsx:764 \- the clear-queue dialog by contrast
  states `"...unsynced operation(s). Clearing will permanently delete them."`

**Rule violated:**

CLAUDE.md Architectural Approach (Tier-1 make-it-impossible); realtime-sync domain rule: a sync
surface must not claim a write is safely captured and then discard it. Contrast AccountPage's own
Clear-Queue dialog which DOES disclose the loss.

**Proposed fix direction:**

Separate the two concerns the wipe currently conflates: shared-device confidentiality (must clear)
and undelivered field records (must survive). Tier-1: make the queue store non-deletable while it
holds undelivered ops — logout re-keys/seals the queue under a new session key envelope and hands
off custody, rather than calling a destructive clear; the next authenticated session of the SAME
tenant re-opens and drains it, and a different tenant can neither read nor drain it (the tenant
partition already exists in the key namespace). Tier-2: make the correct behaviour the default by
routing every teardown path (manual logout, fail-closed refresh logout, session expiry) through one
`endSession()` that is structurally incapable of deleting undelivered work. Tier-3: block the
fail-closed logout from firing while `getPendingCount() > 0` until a drain attempt with a fresh
interactive re-auth has been offered, and add an invariant spec asserting no code path reaches
`clearAllOperations()` with a non-empty queue.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/services/authenticated-fetch.ts`
- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/pages/account/AccountPage.tsx`
- `web/apps/aquamobil/src/hooks/**tests**/useAuth-logout-wipe.spec.tsx`
- `web/apps/aquamobil/src/pwa/sw-replay.ts`

**Expected closer:**

mobile-app-auditor WRITER mode, with auth-security-expert review on the re-keying/custody model (the
wipe currently satisfies MT-CRITICAL-050 confidentiality and any change must preserve it)

**Verifier note:**

Factually confirmed line-by-line. authenticated-fetch.ts:168 does call `await authStore.logout()`
when refresh fails; syncAuthStore (useAuth.tsx:634/644) wires that to useAuth's logout, which at
line 471 unconditionally awaits clearAllUserData `->` clearAllOperations() at line 195 with NO
tenantId; offline-queue.ts:500-533 confirms the unscoped variant deletes every `pending_*` key,
every queue-version token, all pending blobs, and then nulls _sessionKey \+ deletes
DURABLE_QUEUE_KEY (line 531-532), so residue is unrecoverable. AccountPage.tsx:747 is exactly
`message="Are you sure you want to log out?"` while :764 discloses loss for the Clear-Queue path;
grep shows no pendingCount gate, no drain-before-logout, and no export anywhere on the logout path.
So the claim holds. CRITICAL is inflated for two reasons the auditor did not weigh. (1) The wipe is
not an oversight but a deliberate, invariant-tested security control:
`web/apps/aquamobil/src/hooks/**tests**/useAuth-logout-wipe.spec.tsx` (MT-CRITICAL-050 /
MT-MEDIUM-050) exists specifically to PROVE logout awaits clearAllOperations \+ clearCache before
flipping isAuthenticated, because AquaMobil runs on shared field devices; the real defect is the
missing disclosure/drain-first, not the wipe itself. (2) The 'automatic fail-closed logout' is
narrower than described: runSingleFlightRefresh is only reached from authenticated-fetch.ts:231
`if (response.status === 401 && authStore.refreshAuth)`, i.e. only after an actual HTTP 401 came
back. A device that is offline (the field scenario where the queue matters most) throws out of fetch
long before that branch, so offline token expiry can NOT trigger the wipe. The loss window requires
connectivity plus a server-rejected refresh. Impact is loss of locally queued writes that must be
re-entered — no corruption, no security exposure, no cross-tenant leak. HIGH, not CRITICAL.

### PRODUCT-SYNC-HIGH-002

**Title:** Exponential backoff is dead code; retries are a fixed 30s loop capped at 5, after which a
queued record is permanently undeliverable and can only be deleted

**Severity:** HIGH
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-HIGH-001` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pwa/offline-queue.ts:858 \-
  `export function calculateRetryDelay(retryCount: number): number` — repo-wide grep finds no caller
  anywhere in web/ or apps/
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:515 \- `}, 30_000);` — the only retry scheduler,
  a fixed interval with no per-op delay gate
- web/apps/aquamobil/src/pwa/offline-queue.ts:930 \- `retryableFailed` promotes failed ops back to
  'pending' with no elapsed-time check, so every 30s tick consumes one attempt
- web/apps/aquamobil/src/pwa/offline-queue.ts:956 \-
  `if (op.retryCount >= MAX_RETRY_COUNT) { failed++; continue; }` — terminal, with no reset path in
  any UI
- web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:209 \-
  `Failed syncs auto-retry up to {MAX_RETRY_COUNT} times with backoff` (false) and :164
  `Permanently failed — please remove`

**Rule violated:**

realtime-sync domain rule: backoff/retry discipline must not hide permanent failure behind stale UI;
CLAUDE.md Code Quality (no unreachable/decorative code). The Sync Status page asserts a behaviour
the code does not implement.

**Proposed fix direction:**

Make the retry schedule the queue's own property rather than a caller's timer. Tier-1: store
is
in the future — then `calculateRetryDelay` becomes structurally load-bearing and a fixed-interval
caller cannot burn the budget. Tier-2: a ~2-minute brownout must not be terminal: replace the hard
attempt cap with an age/曝-based escalation (keep retrying with capped backoff, and escalate the op
to an operator-visible 'needs attention' state rather than an undeletable-except-by-discard dead
end). Tier-3: add a spec asserting the drain honours `nextAttemptAt` and that the Sync Status copy
is generated from the actual schedule constants, so the UI text cannot drift from behaviour again.

```text
nextAttemptAt` on the operation and have `syncAllOperations` skip any op whose `nextAttemptAt
```

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- `web/apps/aquamobil/src/pwa/sw-replay.ts`
- `web/apps/aquamobil/src/types (QueuedOperation shape)`
- `web/apps/aquamobil/src/pwa/**tests**/offline-queue.spec.ts`

**Expected closer:**

mobile-app-auditor WRITER mode

**Verifier note:**

Every element verified. calculateRetryDelay is defined at offline-queue.ts:858 and a repo-wide grep
for the identifier returns only that definition plus three hits in
apps/gateway-api/src/proxy/service-proxy.service.ts, which is an unrelated PRIVATE method on a
different class — no caller and no test reference in web/, so it is genuinely dead code.
useOfflineQueue.tsx:515 is the only retry scheduler: a flat `setInterval(..., 30_000)` armed
whenever ,
with no per-operation nextRetryAt / elapsed check (grep for nextRetryAt|retryDelay in aquamobil
returns nothing). offline-queue.ts:930 promotes retryable failed ops back to 'pending' filtered only
on `retryCount < MAX_RETRY_COUNT && isRetryableError(...)` — no time gate — and syncOperation (line
824\) increments retryCount on every failure, so each 30s tick burns one of five attempts.
offline-queue.ts:956 `if (op.retryCount >= MAX_RETRY_COUNT) { failed++; continue; }` is terminal,
and grep confirms `retryCount: 0` appears only in enqueue (line 333) and one spec — there is no
reset affordance anywhere; SyncStatusPage exposes only global syncNow (line 108) and a per-op Trash2
remove (line 179), and syncNow cannot help because the `>=MAX` branch skips before syncOperation.
SyncStatusPage.tsx:209 does assert 'auto-retry up to 5 times with backoff', which the code does not
implement. Practical impact confirms HIGH rather than lower: the interval only ticks while isOnline,
so roughly 2.5 minutes of backend unavailability (5xx or unreachable API with navigator.onLine true)
permanently kills a queued field write, whose only remaining user action is deletion and manual
re-entry.

```text
pendingOperations.some(op => op.status === 'failed' && op.retryCount < MAX_RETRY_COUNT)
```

### MEDIUM

### PRODUCT-SYNC-MEDIUM-003

**Title:** createLeaveRequest → submitLeaveRequest replay chain has no at-most-once coverage on step
2, so a lost response yields a permanent "Sync Failed" for a leave request that IS submitted

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-HIGH-002` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pwa/operation-registry.ts:322 \-
  — the
  follow-up carries no envelope

  ```text
  return { query: OPERATION_MUTATIONS.submitLeaveRequest, variables: { id: createdId } };
  ```

- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:307 \- the follow-up is a second bare
  `authenticatedFetch` whose failure fails the WHOLE op (:317 throws)
- apps/hr-service/src/leave/handlers/submit-leave-request.handler.ts:54 \-
  `LeaveStateMachine.transition(leaveRequest.status, LeaveRequestStatus.PENDING);`
- apps/hr-service/src/leave/leave-state-machine.ts:46 \- the PENDING transition set is
  `{APPROVED, REJECTED, CANCELLED, WITHDRAWN}` — PENDING→PENDING throws BadRequestException on
  replay
- apps/hr-service/src/leave/handlers/create-leave-request.handler.ts:101 \- step 1 replays cleanly
  via the receipt, so every retry re-runs step 2 against an already-PENDING row

**Rule violated:**

realtime-sync domain rule: a sync-status surface must reconcile final backend state after
reconnect/retry. The mobile-command receipt contract (libs/backend-common/mobile-command) is applied
to step 1 only.

**Proposed fix direction:**

Eliminate the client-side two-call chain — it is the root cause, not the retry. Tier-1: expose one
server mutation that creates AND submits atomically under a single `clientCommandId` receipt, so the
queued op is a single at-most-once command and the intermediate DRAFT state is never observable to
the mobile lane. Tier-2 (if the DRAFT step must remain a separate domain concept): make
`submitLeaveRequest` idempotent — a PENDING→PENDING transition must be a no-op returning the current
row, not an exception — and give it its own envelope so the receipt ledger covers it. Tier-3: add a
replay spec that drives create-succeeds/submit-response-lost and asserts convergence to a single
PENDING request with the queue drained.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pwa/operation-registry.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/pwa/sw-replay.ts`
- `apps/hr-service/src/leave/leave.resolver.ts`
- `apps/hr-service/src/leave/handlers/submit-leave-request.handler.ts`
- `apps/hr-service/src/leave/leave-state-machine.ts`
- `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx`

**Expected closer:**

hr domain expert WRITER mode (server side) coordinated with mobile-app-auditor WRITER mode
(registry/chain removal)

**Verifier note:**

The mechanism is real and each cited line checks out. operation-registry.ts:322 returns
with no envelope;
useOfflineQueue.tsx:307-317 issues the follow-up as a second bare authenticatedFetch whose non-ok
status or GraphQL error throws out of the whole executor, failing the entire operation;
apps/hr-service/src/leave/leave.resolver.ts:475 shows submitLeaveRequest takes only `id` and goes
straight to the command bus with NO MobileCommandReceipt wrapper; submit-leave-request.handler.ts:54
calls LeaveStateMachine.transition(status, PENDING) and leave-state-machine.ts:46 confirms PENDING's
allowed target set is {APPROVED, REJECTED, CANCELLED, WITHDRAWN}, so `PENDING->PENDING` throws
BadRequestException('Invalid leave request transition: pending `->` pending...');
create-leave-request.handler.ts replays cleanly via mobileCommandReceipts.begin (replay branch
returns the existing row), so every retry re-runs step 2 against an already-PENDING row. The thrown
message also contains none of isRetryableError's permanentPatterns, so it is misclassified retryable
and burns all five attempts before going terminal. Severity is inflated, though. The backend ends in
the CORRECT state — the leave request IS submitted and pending approval — and duplication is
structurally prevented (step-1 receipt on replay, plus the overlapping-request check in
create-leave-request.handler.ts). Nothing is lost or corrupted; the harm is a misleading permanent
'Sync Failed' row the user must delete, and it requires the narrow window where step 2 commits
server-side but its response is lost in flight. That is a status-fidelity defect, MEDIUM.

```text
{ query: OPERATION_MUTATIONS.submitLeaveRequest, variables: { id: createdId } }
```

### PRODUCT-SYNC-MEDIUM-004

**Title:** A queued write whose target row changed server-side has no reconciliation path, and the
retry classifier is an English-only substring match blind to farm-service's actual (Turkish) error
vocabulary

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-HIGH-003` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pwa/offline-queue.ts:882 \-
  matched against `error.message.toLowerCase()`

  ```text
  permanentPatterns = ['validation','not found','forbidden','unauthorized','duplicate','constraint','invalid input','bad request']
  ```

- apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts:177 \-
  `throw new ConflictException(\`Öğün '${meal.status}' durumunda — yalnız scheduled/partially_fed
  öğün beslenebilir\`)` — a genuine concurrent-change conflict, classified RETRYABLE by the client
- apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts:119 \-
  — a
  genuinely PERMANENT validation error, also classified retryable

  ```text
  throw new BadRequestException('Döküm miktarı 0 < kg <= 10000 aralığında olmalıdır')
  ```

- web/apps/aquamobil/src/pwa/offline-queue.ts:824 \- `syncOperation` catch collapses every failure
  kind into `status:'failed'` \+ `lastError` string; no conflict/validation/transport discrimination
  survives
- web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:178 \- the only per-op action is the `Trash2`
  remove button; there is no edit, re-target, or force-apply affordance

**Rule violated:**

realtime-sync domain rules: sync/job UI must reconcile final backend state after retry; permanent
failure must not hide behind indefinite retry. CLAUDE.md Architectural Approach (no heuristic
string-matching where a typed contract is available).

**Proposed fix direction:**

Move retry classification from prose to contract. Tier-1: have the backend return a machine-readable
outcome class on GraphQL errors (`extensions.code`: TRANSIENT | VALIDATION | CONFLICT | AUTH) and
have the queue branch on that discriminated union — a locale-dependent substring match then becomes
impossible to write. Tier-2: give CONFLICT its own terminal-but-recoverable queue state with a
reconciliation surface (show the operator the server's current row vs the queued payload and offer
re-target/re-apply/discard), so a physically-real feed pour is never resolved by 'please remove'.
Tier-3: an invariant spec asserting every queueable OperationType's backend errors carry an
`extensions.code`, and that the queue has no string-matching classifier.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- `web/apps/aquamobil/src/utils/graphql-response.ts`
- `apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts`
- `apps/farm-service/src/**/dto (error extension surface)`
- `libs/backend-common/src/mobile-command`

**Expected closer:**

mobile-app-auditor WRITER mode with farm domain expert for the error-extension contract

**Verifier note:**

The facts are accurate. offline-queue.ts:882 is the literal English-only permanentPatterns array
matched with `lower.includes(pattern)`; meal-execution.service.ts:177 throws
ConflictException(`Ogun '${meal.status}' durumunda ...`) and :119 throws BadRequestException('Dokum
miktari 0 `<` kg `<=` 10000 araliginda olmalidir'), neither of which contains any pattern, so both
are classified retryable — and recordMealFeeding IS a real queued operation (types/index.ts:349
OperationType union, operation-registry.ts:75, enqueued at RecordFeedingPage.tsx:246), so the
cross-layer link is genuine. syncOperation (offline-queue.ts:824) does collapse every failure into
status 'failed' \+ a truncated lastError string with no typed discrimination, and
SyncStatusPage.tsx:178 offers only the Trash2 remove — no edit, re-target, force-apply, or
refetch-current-server-state affordance. What is inflated is the independent production impact. For
BOTH misclassified cases the terminal outcome is IDENTICAL to what correct classification would
produce: the op ends 'failed' and the user deletes it. The only delta is up to five wasted retry
attempts, and those are side-effect-free because recordMealFeeding is envelope-gated —
meal-execution.service.ts:126-140 replays the stored receipt and outright rejects an envelope-less
command, so no duplicate feeding, no stock double-decrement, no corruption. The remaining genuine
defect — no reconciliation/edit path for a queued write whose target row moved on — is the same
terminal-dead-queue hole already reported as PRODUCT-SYNC-HIGH-001, so it does not independently
support HIGH. MEDIUM.

### PRODUCT-SYNC-MEDIUM-006

**Title:** Daily Ops hub freezes "today" at mount and never sends the clientDate the backend added
specifically to reconcile it — two KPI panels can name different calendar days and neither rolls
over at midnight

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-MEDIUM-002` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useDailyOpsStats.ts:41 \-
  `const todayStr = useMemo(() => { ... }, []);` — empty dep array, so the device-local day is
  frozen for the whole app session (no midnight rollover on a 24/7 shift app)
- web/apps/aquamobil/src/hooks/useDailyOpsStats.ts:75 \-
  `graphqlRequest<{ todaysDailyOpsCounts: ... }>(GET_TODAYS_DAILY_OPS_COUNTS)` — called with NO
  variables, so `$clientDate` is always null
- web/apps/aquamobil/src/graphql/operations.ts:464 \-
  `query GetTodaysDailyOpsCounts($clientDate: String)` with the comment "threads the device-local
  calendar day ... so the dashboard counts and the phone agree on one named 'today'"
- apps/farm-service/src/mobile-dashboard/handlers/get-todays-daily-ops-counts.handler.ts:38 \-
  `const timeZone = process.env.FARM_DASHBOARD_TIME_ZONE ?? 'UTC';` — the fallback day the mobile
  aggregate therefore always uses
- web/apps/aquamobil/src/hooks/useDailyOpsStats.ts:73 \- the aggregate's query key
  `createTenantQueryKey(tenantId, 'dailyOpsCounts', tenantId)` carries no day segment, so the cache
  entry cannot roll over either

**Rule violated:**

realtime-sync domain rule: refresh logic must not update one widget on a different truth model than
the panel it must agree with. FARM-MEDIUM-056 introduced `clientDate` for exactly this and the only
consumer never passes it.

**Proposed fix direction:**

Make the calendar day a single explicit input rather than two implicit ones. Tier-1: derive one
`operationalDay` value in a shared hook, thread it into BOTH the `clientDate` argument and the
day-plan query, and include it in every affected query key — a widget that omits it then cannot
fetch. Tier-2: make the day value reactive (recompute on a midnight timer / visibilitychange) so a
device left open across midnight re-keys and refetches automatically. Tier-3: a spec asserting every
mobile-dashboard aggregate query key contains the day segment.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useDailyOpsStats.ts`
- `web/apps/aquamobil/src/graphql/operations.ts`
- `web/apps/aquamobil/src/pages/operations/DailyOpsHubPage.tsx`
- `web/apps/aquamobil/src/utils/offline-sync-invalidation.ts`
- `apps/farm-service/src/mobile-dashboard/mobile-dashboard.resolver.ts`

**Expected closer:**

chart-widget-auditor for the widget-agreement contract, then mobile-app-auditor WRITER mode

**Verifier note:**

Confirmed line by line. useDailyOpsStats.ts:41-44 computes todayStr in a useMemo with an empty dep
array; :72-78 calls graphqlRequest(GET_TODAYS_DAILY_OPS_COUNTS) with NO second argument, so
$clientDate is always null; :73 keys the aggregate as
createTenantQueryKey(tenantId,'dailyOpsCounts',tenantId) with no day segment.
graphql/operations.ts:463-466 does declare query GetTodaysDailyOpsCounts($clientDate: String) with
the FARM-MEDIUM-056 comment, and mobile-dashboard.resolver.ts:21-24 accepts the nullable arg — a
repo-wide grep shows AquaMobil is the only consumer of todaysDailyOpsCounts and it never passes
clientDate. get-todays-daily-ops-counts.handler.ts:38 then always resolves the day from
FARM_DASHBOARD_TIME_ZONE ?? 'UTC'. The real, permanent defect: mortality/WQ/feeding counts come from
the server-timezone day while the feeding fallback (:96-101, from feedingDayPlans keyed on the
device-local todayStr) uses the device day, so on a UTC+3 site between 00:00 and 03:00 local the two
disagree. One overstatement: todayStr is frozen per MOUNT of the hook (used only in
DailyOpsHubPage.tsx:128 and OperationsHubPage.tsx:136), not 'for the whole app session' — navigating
away and back recomputes it, and the aggregate re-resolves 'today' server-side on each fetch
(staleTime 5min). That trims the midnight-rollover half of the claim but not the clientDate half.
MEDIUM stands.

### PRODUCT-SYNC-MEDIUM-007

**Title:** Offline alarm acknowledgement is optimistic only in memory; the encrypted IndexedDB alarm
snapshot is never updated, so a cold offline reopen resurrects the CRITICAL banner for an
already-acknowledged alarm

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-MEDIUM-003` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useAlerts.ts:86 \-
  `await cacheData(tenantId, offlineCacheKey, rows, ALERTS_CACHE_TTL_MS);` — the durable snapshot is
  written only from a successful network fetch
- web/apps/aquamobil/src/hooks/useAlerts.ts:91 \-
  — offline reads serve that stale snapshot

  ```text
  const cached = await getCachedData<MobileAlert[]>(tenantId, offlineCacheKey); if (cached) return cached;
  ```

- web/apps/aquamobil/src/hooks/useAlerts.ts:107 \- `queryClient.setQueriesData<MobileAlert[]>(...)`
  — the ack flip touches only the in-memory React Query cache, which does not survive an app restart
- web/apps/aquamobil/src/hooks/useAlerts.ts:104 \-
  `await addToQueue('acknowledgeAlert', { alertId, note });` — the ack can stay queued for a whole
  offline shift
- web/apps/aquamobil/src/layouts/MobileLayout.tsx:128 \- `<CriticalAlertBanner />` renders on every
  screen from this data

**Rule violated:**

realtime-sync domain rule: a live surface must reconcile final state after reconnect/reload; a
queue-first write must leave the offline read model consistent with what the operator was shown.

**Proposed fix direction:**

Tier-2: make the optimistic write and the durable snapshot one operation — route every optimistic
mutation of a cached list through a single helper that applies the same transform to the React Query
entry AND the encrypted IndexedDB snapshot, so an offline restart replays the operator's own
acknowledged state. Tier-1 alternative: derive the displayed acknowledgement state as
`serverSnapshot ⊕ pendingQueueOps` at read time, so the offline queue itself is the overlay and no
second copy can drift; the overlay disappears automatically when the op drains.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAlerts.ts`
- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/components/CriticalAlertBanner.tsx`
- `web/apps/aquamobil/src/pages/alerts/AlertsPage.tsx`
- `web/apps/aquamobil/src/hooks/useLatestReadings.ts (same cache-write pattern)`

**Expected closer:**

mobile-app-auditor WRITER mode

**Verifier note:**

Every cited line holds. web/apps/aquamobil/src/hooks/useAlerts.ts:86 writes the durable encrypted
snapshot ONLY inside the success branch of the queryFn
(`await cacheData(tenantId, offlineCacheKey, rows, ALERTS_CACHE_TTL_MS)`, TTL 12h); :91-92 is the
catch-branch `getCachedData` fallback that returns those stale rows; :104
is
the ONLY state the ack mutates, and a repo-wide grep for cacheData/getCachedData
(useLeave/useLatestReadings/useTanks/useWarehouseSummary/useAlerts only) confirms nothing else ever
rewrites the alerts snapshot — so the ack never reaches IndexedDB. main.tsx:32-51 has no
persistQueryClient/PersistQueryClientProvider, so the React Query cache really is memory-only.
MobileLayout.tsx:128 renders `<CriticalAlertBanner` `/>` above every screen, and
CriticalAlertBanner.tsx:20/43 derives visibility purely from useAlerts().criticalUnacknowledged with
no overlay of pending queue ops. Two corrections that do NOT rescue the code. (1) The report's
stated trigger — 'a cold offline reopen' — is actually UNREACHABLE: useAuth.tsx:244-316 restores the
session only via a live `fetch('/graphql')` refresh mutation, and messaging-sw.ts:257-274 forces
GraphQL POSTs straight to the network with no caching (returns Response.error() offline), so a cold
offline start lands on the login screen with tenantId null and the alerts query disabled
(useAlerts.ts:72). (2) A stricter trigger exists that makes the defect MORE reachable than filed,
not less: main.tsx:45 sets `networkMode: 'offlineFirst'`, so the 30s `refetchInterval`
(useAlerts.ts:50/73) still fires while offline; the queryFn then resolves SUCCESSFULLY from the
stale pre-ack snapshot and overwrites the optimistic flip, resurrecting the CRITICAL banner within
~30s of an offline ack with no restart at all. Harm is bounded to false over-alerting plus a
redundant queued ack (server-side idempotent) and it self-heals on reconnect via
invalidateSyncedOperationQueries, so MEDIUM — matching the report's own calibration of
status-fidelity defects — is correct.

```text
await addToQueue('acknowledgeAlert', { alertId, note })`; :107-120 `queryClient.setQueriesData
```

### LOW

### PRODUCT-SYNC-MEDIUM-005

**Title:** The offline-queue READ path silently degrades to an unscoped all-tenant scan when
tenantId is null, contradicting the module's own "tenantId is REQUIRED" isolation contract

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-MEDIUM-001` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:181 \- `getPendingCount(tenantId ?? undefined)` /
  :182 `getPendingOperations(tenantId ?? undefined)` — null tenant becomes "no filter", not "empty"
- web/apps/aquamobil/src/pwa/offline-queue.ts:403 \-
  `const prefix = tenantId ? \${QUEUE_PREFIX}${tenantId}_\ : QUEUE_PREFIX;` — the bare prefix
  matches every tenant's `pending_<tenant>_<id>` key
- web/apps/aquamobil/src/pwa/offline-queue.ts:424 \- `getPendingCount` repeats the same fallback
- web/apps/aquamobil/src/pwa/offline-queue.ts:280 \- the WRITE path by contrast throws:
  `queueOperation: tenantId is required for tenant-isolated queueing`
- web/apps/aquamobil/src/layouts/MobileLayout.tsx:119 \-
  `if (tabId === 'account') return pendingCount + unreadCount;` — the unscoped count is rendered

**Rule violated:**

realtime-sync domain rule: flag any live/polling surface whose scope omits tenant identity.
CLAUDE.md Security (tenant-ID sourcing) and the module's own SECURITY (C11) contract, which the
write path enforces but the read path does not.

**Proposed fix direction:**

Tier-1: make `tenantId` a non-optional parameter on `getPendingOperations`/`getPendingCount` (the
unscoped variant is only ever legitimate for the logout wipe, which should be a separately named
`wipeAllTenants()` on the clear path). The provider then cannot compile a null-tenant read and must
render an explicitly empty queue while no tenant is resolved. This closes the contract hole at the
type level rather than relying on the logout wipe to keep the store coincidentally single-tenant.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/pwa/sw-replay.ts`
- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- `web/apps/aquamobil/src/layouts/MobileLayout.tsx`
- `web/apps/aquamobil/src/pwa/**tests**/offline-queue.spec.ts`

**Expected closer:**

tenant-isolation-auditor for scope review, then mobile-app-auditor WRITER mode

**Verifier note:**

Facts hold exactly. offline-queue.ts:403-405 and :424-426 both fall back to the bare QUEUE_PREFIX
when tenantId is undefined (matching every tenant's `pending_<tenant>_<id>` key), while the write
path at :280-282 throws 'queueOperation: tenantId is required for tenant-isolated queueing'.
useOfflineQueue.tsx:181-182 is the ONLY production caller of the optional-tenant form and passes
`tenantId ?? undefined`, and OfflineProvider is mounted app-wide in main.tsx:110 (outside
ProtectedRoute), so the unscoped read is genuinely reachable on every cold start before auth
restores. MobileLayout.tsx:119 does render pendingCount into the account badge. So the contract
asymmetry is real and the fix direction is sound. Severity is inflated to MEDIUM, though: the
payload key is a device-session AES key, not per-tenant, but there is no reachable state in which
two tenants' operations coexist in the store — useAuth.tsx:194-196 (clearAllUserData) awaits
clearAllOperations() on logout and a wipe failure REJECTS logout (asserted by
`hooks/**tests**/useAuth-logout-wipe.spec.tsx`), and IdentityBoundary remounts the subtree on
identity change. The demonstrable effect is a brief pre-auth unscoped read of the SAME user's own
ops, i.e. a defense-in-depth/type-contract hole with no shown cross-tenant exposure. LOW.

### PRODUCT-SYNC-LOW-008

**Title:** SyncStatus gained an 'unknown' member with a claim of forced exhaustive handling, but the
badge uses non-exhaustive && chains and renders a completely blank confirmation panel

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-LOW-001` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:51 \-

  ```text
  Adding the member forces exhaustive handling at every consumer — a missed branch is a compile error.
  ```

- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:440 \- `if (!operation) return 'unknown';`
- web/apps/aquamobil/src/components/QueuedStatusBadge.tsx:40 \- the icon/title/subtitle blocks are
  `status === 'synced' && ...` chains covering only 4 of the 5 members; 'unknown' renders nothing at
  all
- web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:256 \-
  `<QueuedStatusBadge operationId={queuedOperationId} />` is the entire post-submit screen, so an
  'unknown' status is a blank success page

**Rule violated:**

CLAUDE.md Architectural Approach Tier-1 ("make it impossible") — the stated compile-time guarantee
is not actually enforced by the consumer's control flow.

**Proposed fix direction:**

Tier-1: render the badge from an exhaustive `satisfies Record<SyncStatus, BadgeConfig>` presentation
map (or a switch with a `never` default) so a new SyncStatus member is a compile error at the
consumer, matching the comment's stated guarantee. Give 'unknown' an honest presentation ("status
unavailable — check Sync Status") rather than an empty div.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/components/QueuedStatusBadge.tsx`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx`
- `web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx`
- `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx`

**Expected closer:**

mobile-app-auditor WRITER mode

**Verifier note:**

Every cited line holds. web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:51-53 carries the comment
"Adding the member forces exhaustive handling at every consumer — a missed branch is a compile
error" and defines SyncStatus with 5 members including 'unknown'; line 440 is
`if (!operation) return 'unknown';`. web/apps/aquamobil/src/components/QueuedStatusBadge.tsx (107
lines total) renders icon (lines 39-58), title (lines 71-74) and subtitle (lines 87-90) as
branch, no switch, no `satisfies Record<SyncStatus,…>`, so the 'unknown' case renders an empty flex
column, and the file's own JSDoc (lines 18-22) also lists only 4 states. The badge is the ONLY
consumer of getSyncStatus (grep across src: only QueuedStatusBadge.tsx:25 plus test mocks), so the
claimed compile-time guarantee is enforced nowhere.
web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:250-257 does render
`<QueuedStatusBadge operationId={queuedOperationId} />` as the entire post-submit screen (the only
alternative branch is `wasDuplicate` → AlreadyRecordedNotice). Nothing I found refutes it: no
exhaustiveness test exists (`hooks/**tests**/useOfflineQueue.spec.tsx:117-121` only asserts
getSyncStatus returns 'unknown', it does not test the badge). Severity stays LOW rather than higher
because the blank-render path is hard to actually reach from RecordEntityPage — addToQueue
(useOfflineQueue.tsx:240-246) awaits refreshQueue() before returning the id, so the op is in
pendingOperations ('pending') when the badge mounts, and a real drain writes 'synced' into
syncResults (lines 380-390). The concrete, non-theoretical part of the defect is the false Tier-1
claim in the comment and the missing branch, which is LOW-grade.

```text
status === '…' && …` chains covering only synced/pending/syncing/failed — there is no `unknown
```

### PRODUCT-SYNC-LOW-009

**Title:** Sync Status operation labels claim to be the SSoT for "every OperationType" but are typed
`Record<string,…>` and omit seven types, including the legally time-critical escape-incident op

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-LOW-002` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:11 \-

  ```text
  Every OperationType must have a friendly label ... This map is the SINGLE source of truth
  ```

- web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:16 \-
  , not
  `OperationType`, so omissions never fail the build

  ```text
  const OPERATION_LABELS: Record<string, { label: string; icon: string }>` — `string
  ```

- web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:124 \-
  `OPERATION_LABELS[op.type] || { label: op.type, icon: '📝' }` — falls back to the raw camelCase
  type
- web/apps/aquamobil/src/pwa/operation-registry.ts:216 \- `recordEscapeIncident` (and
  recordMealFeeding, recordLiceCount, recordWelfareAssessment, acknowledgeAlert, setChecklistItem,
  uploadAndSendMessage) have no label entry
- web/apps/aquamobil/src/pwa/offline-queue.ts:936 \- escape incidents are explicitly the priority
  drain lane, so the least-legible row is the most operationally urgent one

**Rule violated:**

CLAUDE.md Architectural Approach Tier-3 (make it detectable) — a declared SSoT with no type binding
to the enum it claims to cover.

**Proposed fix direction:**

Tier-1: type the map `satisfies Record<OperationType, OperationLabel>` exactly as
— adding a
queueable type without a label then becomes a compile error, and the two maps share the same
enforcement pattern.

```text
SYNC_INVALIDATION_SEGMENTS` already does in `utils/offline-sync-invalidation.ts
```

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- `web/apps/aquamobil/src/types (OperationType)`
- `web/apps/aquamobil/src/utils/offline-sync-invalidation.ts`

**Expected closer:**

mobile-app-auditor WRITER mode

**Verifier note:**

Confirmed line by line. web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:11-15 states "Every
OperationType must have a friendly label … This map is the SINGLE source of truth for operation
display names across the sync UI", and line 16 declares
,
with no `satisfies Record<OperationType, …>`, so omissions cannot fail the build. Line 124 is
`const config = OPERATION_LABELS[op.type] || { label: op.type, icon: '📝' };`, falling back to the
raw camelCase type. Counting: OperationType (web/apps/aquamobil/src/types/index.ts:349) has 24
members; the label map has 17; the 7 missing are exactly the ones named — recordMealFeeding,
setChecklistItem, recordLiceCount, recordWelfareAssessment, recordEscapeIncident, acknowledgeAlert,
uploadAndSendMessage. All 7 are genuinely queueable (operation-registry.ts lines 75, 153, 199, 208,
216, 227; uploadAndSendMessage is the binary lane handled in useOfflineQueue.executeGraphQL and
listed in SW_REPLAY_SKIP_TYPES at operation-registry.ts:275). offline-queue.ts:936-943 does
implement the escape-incident priority drain partition, so the least-legible row is the most urgent
one. The comparison pattern also checks out: utils/offline-sync-invalidation.ts:52 closes with
`} satisfies Record<OperationType, readonly (readonly unknown[])[]>;` and its comment at line 9
explains the exhaustiveness intent, so the proposed Tier-1 fix is an existing in-repo pattern.
Impact is a raw camelCase label on one operator-facing list — real but cosmetic, so LOW is correct.

```text
const OPERATION_LABELS: Record<string, { label: string; icon: string }> = {` — keyed by `string
```

### PRODUCT-SYNC-LOW-010

**Title:** The closed-app service-worker drain never updates the last-sync clock or notifies
clients, so "Last synced" understates freshness after a successful background drain

**Severity:** LOW
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-LOW-003` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pwa/sw-replay.ts:226 \-
  `logger.info('[sw-replay] closed-app drain finished', result);` — the only post-drain action; no
  stamp write, no client notification
- web/apps/aquamobil/src/utils/last-sync.ts:14 \- `recordLastSyncAt()` is the shared clock
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:407 \-
  `if (result.success > 0) { recordLastSyncAt(); }` — written only by the foreground lane
- web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:63 \-
  `<DataFreshness timestamp={getLastSyncAt()} />` renders and colours that stamp

**Rule violated:**

realtime-sync domain rule: sync-status UI must reflect the authoritative drain outcome regardless of
which lane performed it.

**Proposed fix direction:**

Tier-2: move the stamp write into the shared drain convergence point (`syncAllOperations`) rather
than the foreground caller, so every lane — foreground, periodic retry, and SW closed-app replay —
updates it by construction. The SW sub-build already imports `offline-queue.ts`, so the clock helper
must be kept DOM-free like the operation registry.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/pwa/sw-replay.ts`
- `web/apps/aquamobil/src/utils/last-sync.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/pages/account/AccountPage.tsx`

**Expected closer:**

mobile-app-auditor WRITER mode

**Verifier note:**

Confirmed. web/apps/aquamobil/src/pwa/sw-replay.ts:222-226: the closed-app lane calls
and
then only `logger.info('[sw-replay] closed-app drain finished', result);` — no recordLastSyncAt(),
no client postMessage (notifyClients at lines 190-196 runs only BEFORE the drain, and in lane 2 it
returned false because there are no window clients). The stamp is written in exactly one place:
useOfflineQueue.tsx:404-409 `if (result.success > 0) { recordLastSyncAt(); }` inside the foreground
syncNow (grep for recordLastSyncAt across src returns only useOfflineQueue.tsx:34/408 plus
utils/last-sync.ts and a test). SyncStatusPage.tsx:62 renders
`<DataFreshness timestamp={getLastSyncAt()} />`, and AccountPage.tsx:417/440/450 formats the same
stamp. On reopen after a closed-app drain the foreground finds an empty queue, so result.success ===
0 and the stamp is never caught up — the UI understates freshness. The lane is reachable:
messaging-sw.ts:176 wires handleBackgroundSyncEvent into the sync event registered at line 327. Two
comments in the code overclaim and are contradicted by this: useOfflineQueue.tsx:404 ("the drain
convergence point owns the global last-synced clock — every successful drain … updates it") and
SyncStatusPage.tsx:58 ("every drain (auto or manual) updates the stamp"), which strengthens rather
than refutes the claim. One caveat on the fix direction, not the defect: last-sync.ts uses
localStorage, which does not exist in a ServiceWorkerGlobalScope, so moving the write into
syncAllOperations needs an SW-safe store (the existing try/catch would swallow the SW failure and
silently keep the bug). Impact is a stale display timestamp only — queue state itself stays
authoritative — so LOW is correct.

```text
syncAllOperations(auth.tenantId, createSwExecutor(auth), { skipTypes: SW_REPLAY_SKIP_TYPES })
```

### PRODUCT-SYNC-LOW-011

**Title:** Optimistic KPI bumps are never reverted when an op is discarded, and the drain-result map
is provider-lifetime state that is never reset across sessions

**Severity:** LOW
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-SYNC-LOW-004` by `realtime-sync-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:245 \-
  `applyOptimisticKpiBump(queryClient, tenantId, type, payload);` on enqueue
- web/apps/aquamobil/src/utils/offline-optimistic.ts:72 \- the bump is an additive `setQueriesData`
  with no recorded inverse
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:458 \- `removeFromQueue` does `removeOperation`
  \+ `refreshQueue` only — no KPI revert and no invalidation, so a discarded record stays counted on
  the Daily Ops cards while offline
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:157 \- `useState<Map<string, SyncStatus>>` is
  never cleared on logout or tenant change, and OfflineProvider is mounted once above the router
  (web/apps/aquamobil/src/main.tsx:110), so the map grows unbounded across sessions

**Rule violated:**

realtime-sync domain rule: optimistic live state must reconcile with final backend truth on every
terminal outcome, not only on success.

**Proposed fix direction:**

Tier-1: derive the optimistic delta from the queue itself instead of imperatively mutating cached
aggregates — a KPI reads `serverCount + pendingOpsOfThisType.length`, so discard/permanent-failure
automatically un-counts with no inverse to remember. Tier-2: reset `syncResults` on tenant/session
change by keying the provider's transient state on `tenantId` so a session boundary cannot carry
drain verdicts forward.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/utils/offline-optimistic.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/hooks/useDailyOpsStats.ts`
- `web/apps/aquamobil/src/hooks/useStockEventsSummary.ts`
- `web/apps/aquamobil/src/main.tsx`

**Expected closer:**

mobile-app-auditor WRITER mode

**Verifier note:**

Half real, half refuted; net LOW. REAL half: useOfflineQueue.tsx:244-246 calls
`applyOptimisticKpiBump(queryClient, tenantId, type, payload)` on every fresh enqueue;
offline-optimistic.ts is 88 lines total and contains only the additive `setQueriesData` bumps at
:72-76 and :80-86 with no inverse/revert export; removeFromQueueHandler
(useOfflineQueue.tsx:456-462) does exactly `removeOperation(tenantId, id)` \+ `refreshQueue()` — no
KPI revert, no invalidation — and it is reachable from the Trash2 button at
SyncStatusPage.tsx:178-184. Since useDailyOpsStats.ts:72-83 keys the aggregate on
createTenantQueryKey(tenantId,'dailyOpsCounts',tenantId) (the same prefix the bump targets) with
staleTime 5min, a discarded record stays counted on the Daily Ops cards. REFUTED half: the claim
that syncResults 'is never cleared on logout or tenant change' because 'OfflineProvider is mounted
once above the router (main.tsx:110)' is wrong on both counts — main.tsx:107-115 nests
OfflineProvider (line 110) INSIDE BrowserRouter and INSIDE `<IdentityBoundary>` (line 109), and
IdentityBoundary.tsx:21-22 keys the subtree on `${tenantId}:${user.id}` (sentinel 'anonymous' when
logged out), so React unmounts and remounts OfflineProvider on every logout/login/tenant switch and
the `useState<Map<string,SyncStatus>>` at useOfflineQueue.tsx:157 is re-initialised to an empty Map.
The map cannot carry drain verdicts across sessions or grow unbounded across them; within one
session it holds one small string entry per drained op with unique UUID keys — no correctness
effect. Remaining defect is an offline-only KPI over-count that self-heals on the next successful
aggregate fetch once online, so LOW stands.

## Inventory — what exists / what is missing

| Status          | Area                                                                     | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Conflict detection when the server row changed (version / etag / merge)  | No queued payload carries an expected version or row timestamp. The receipt ledger only detects a reused clientCommandId with a different payloadHash — it cannot detect that a third party changed the target row. LWW-over-a-supervisor-edit is currently unreachable only because every queued op happens to be an append or an absolute idempotent set; nothing structurally prevents adding an update-style op.                                                                                 |
| **MISSING**     | Conflict reconciliation UI (server changed the row while queued)         | A ConflictException on replay is flattened into a generic 'failed' op with a truncated error string; the only operator action is delete. See PRODUCT-SYNC-HIGH-003.                                                                                                                                                                                                                                                                                                                                  |
| **MISSING**     | Exponential backoff with jitter                                          | `calculateRetryDelay` is fully written (base 2s, 5min cap, 0-25% jitter) but has zero callers repo-wide. The real cadence is a fixed 30s interval. See PRODUCT-SYNC-HIGH-001.                                                                                                                                                                                                                                                                                                                        |
| **MISSING**     | SSE / streaming live surface in AquaMobil                                | No EventSource, text/event-stream or ReadableStream reader exists anywhere in the app — AI chat and all live surfaces are GraphQL request/response plus Socket.IO. The AI-service SSE endpoint has no mobile consumer, so the stale-prior-session-stream risk class does not apply here.                                                                                                                                                                                                             |
| **PARTIAL**     | Closed-app service-worker replay lane                                    | With zero window clients the SW mints a token from the httpOnly refresh cookie and drains the queue itself against the shared operation registry. Blob (upload-and-send) ops are deliberately skipped and wait for the next foreground; the lane also never records the last-sync stamp (PRODUCT-SYNC-LOW-003).                                                                                                                                                                                      |
| **PARTIAL**     | Logout teardown of sync/live state                                       | Thorough on confidentiality: in-flight queries cancelled, IndexedDB queue+cache+AES key+blobs wiped, biometric PII and the last-sync key removed, SW caches purged, auth barrier re-armed, and a failed wipe rejects rather than presenting as a clean logout. Destructive on availability: undelivered field records are deleted with no warning (PRODUCT-SYNC-CRITICAL-001), and the provider's in-memory drain map is not reset.                                                                  |
| **PARTIAL**     | Offline binary/media lane                                                | Blobs are persisted encrypted and tenant-partitioned with a 25MB cap; the presign→PUT→send replay runs foreground-only and the blob is deleted only after a fully successful send. The while-closed gap is a known tracked limitation.                                                                                                                                                                                                                                                               |
| **PARTIAL**     | Queue capacity guard / overflow handling                                 | A hard 200-item cap throws on enqueue with a "sync before adding more" message and a 180 warning threshold constant exists — but the threshold is never surfaced in any UI, and because permanently-failed ops still occupy slots, an exhausted-retry backlog can render the queue unusable for new field records.                                                                                                                                                                                   |
| **PARTIAL**     | Retry cap and permanent-failure state                                    | MAX_RETRY_COUNT=5 with a stale-'syncing' reset and retryable-'failed' promotion exists, but exhaustion is terminal with no recovery path other than deletion, and the retry classifier is an English-only substring match.                                                                                                                                                                                                                                                                           |
| **PARTIAL**     | Server-side at-most-once command receipt ledger                          | farm/hr receipt tables with a unique (tenantId, clientCommandId) index cover mortality, cull, transfer, harvest, feeding, meal feeding, tasks/checklist, welfare, escape, clock-in/out and leave-create. Not covered: the chained submitLeaveRequest (PRODUCT-SYNC-HIGH-002). Water-quality, storage and messaging instead rely on their own per-row idempotencyKey columns, and acknowledgeAlert/lice-count rely on natural idempotency/upsert — three different dedup mechanisms behind one queue. |
| **PARTIAL**     | Sync Status page (queue inspection, manual drain, per-op error)          | Lists every pending op with status icon, retry count, truncated error and a manual Sync Now / delete. Weakened by an incomplete label map, a false "with backoff" claim, and delete as the only remedy for a failed op.                                                                                                                                                                                                                                                                              |
| **PARTIAL**     | Two-phase sync-status badge (no premature success)                       | 'synced' is only asserted from the retained drain map after an op actually left the queue, and a phantom id resolves to 'unknown' rather than a false green — but 'unknown' has no rendered branch, so the confirmation screen goes blank (PRODUCT-SYNC-LOW-001).                                                                                                                                                                                                                                    |
| **IMPLEMENTED** | Auto-sync re-arm on reconnect                                            | A monotonic per-tenant queue version token drives the guard, so a drain-to-N-then-enqueue-back-to-N (unchanged count) still re-triggers sync; going offline resets to a sentinel so the next reconnect always re-arms.                                                                                                                                                                                                                                                                               |
| **IMPLEMENTED** | Background Sync registration (SyncManager)                               | `sync-operations` (plus `sync-messages` for messaging ops) registered at enqueue time, gated on confirmed credentials so an unauthenticated wake cannot inflate retryCount.                                                                                                                                                                                                                                                                                                                          |
| **IMPLEMENTED** | Client-side double-submit dedup                                          | SHA-256 of the raw domain payload (pre-envelope) collapses byte-identical same-type submissions within a 5s window onto the existing op, and the UI shows an honest "Already recorded" screen instead of a second success.                                                                                                                                                                                                                                                                           |
| **IMPLEMENTED** | Cross-context drain mutual exclusion                                     | Both the SW replay and the foreground syncNow hold the same `aquamobil-queue-drain` Web Lock; the SW additionally re-checks for window clients after acquiring it and defers entirely where Web Locks are unavailable.                                                                                                                                                                                                                                                                               |
| **IMPLEMENTED** | Duplicate-row-on-replay protection                                       | Every queued OperationType traced to a server-side dedup mechanism; a replayed queued mutation does not create a second row. This is the strongest part of the design and the explicitly hunted defect was NOT found.                                                                                                                                                                                                                                                                                |
| **IMPLEMENTED** | Durable offline mutation queue (encrypted, tenant-partitioned)           | AES-GCM payload encryption with a non-extractable IndexedDB-persisted key; keys are `pending_<tenantId>_<id>` so cross-tenant replay is structurally blocked on the write path. Dedicated stores for queue/cache/keys/blobs avoid full-store scans.                                                                                                                                                                                                                                                  |
| **IMPLEMENTED** | Idempotency key threaded across online-attempt → offline-fallback        | Pages that try online first and fall back to the queue mint the key ONCE before the try block (stock movement/transfer, water quality) or thread `clientCommandId` explicitly (task actions, sendMessage), so the two paths are one logical command.                                                                                                                                                                                                                                                 |
| **IMPLEMENTED** | Live sensor readings freshness disclosure                                | Each metric carries its own origin timestamp feeding a DataFreshness stamp, and an offline read serves the last-known encrypted snapshot with its honest (visibly old) timestamps rather than an empty card that reads as "no problem".                                                                                                                                                                                                                                                              |
| **IMPLEMENTED** | Notification / unread-count polling cadence convergence                  | Bell list, bell count and message badge share one QueryClient, one 60s cadence with `refetchIntervalInBackground:false`, and one FCM-push invalidation tick, closing the prior 5-minute divergence between surfaces.                                                                                                                                                                                                                                                                                 |
| **IMPLEMENTED** | Post-sync cache invalidation                                             | `SYNC_INVALIDATION_SEGMENTS satisfies Record<OperationType, …>` is exhaustive at compile time — adding a queueable type without an invalidation entry is a build error — and both the online and offline write paths converge on the same awaited helper.                                                                                                                                                                                                                                            |
| **IMPLEMENTED** | Queue ordering (FIFO \+ regulatory priority lane)                        | Operations drain oldest-first by createdAt, with a stable partition that flushes `recordEscapeIncident` ahead of the backlog while preserving relative order elsewhere.                                                                                                                                                                                                                                                                                                                              |
| **IMPLEMENTED** | Real-time farm socket \+ reconnect reconcile \+ degraded-live disclosure | Socket.IO `/farms` namespace auto-joined to the tenant room; a RECONNECT (not first connect) invalidates the whole farm namespace to catch missed events, and MobileLayout renders a distinct "Live updates unavailable — data may lag" strip when HTTP is fine but the channel is down.                                                                                                                                                                                                             |
| **IMPLEMENTED** | Single shared drain contract across lanes                                | Mutation documents and variable shaping live in a React-free `operation-registry.ts` consumed by both the foreground provider and the SW sub-build, so the two lanes cannot drift.                                                                                                                                                                                                                                                                                                                   |

## Verdict

BLOCK

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/realtime-sync-auditor.md`
- Rule SSoT: `CLAUDE.md`
