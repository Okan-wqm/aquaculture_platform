# AquaMobil form write-path audit — 2026-08-16

**Agent:** `form-write-auditor` · **Mode:** CATCHER (read-only) · **Lane:** mobile
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** BLOCK
**Findings surviving verification:** 12 (CRITICAL 1 · HIGH 3 · MEDIUM 6 · LOW 2)

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** use the `PRODUCT-FORM-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Ledger ids

`PRODUCT-FORM-CRITICAL-001` was registered on the Faz 3 branch (PR #1424) as
`MOB-CRITICAL-018` before `main` allocated that sequence to its own water-quality
finding (the same defect, fixed independently by the feeding W0–W8 cycle). The
allocator treats the sequence as the identity, so the branch's row was
re-registered when the branch took main — twice, because main's #1431/#1443
round then allocated sequence 020 to `MOB-HIGH-020` as well. The fix commits
(`ffa4c1025`, `3c45bf790`) still name `MOB-CRITICAL-018` in their `Closes:`
trailers and the first merge commit (`ff643ac84`) names `MOB-CRITICAL-020`.
`MOB-CRITICAL-018` names a live sibling on main and cannot be an alias, so it
closes through the merge ceremony commit's trailer; `MOB-CRITICAL-020` is not a
live ledger id and is recorded as an alias.

| Review id (headings, trailers) | Ledger id (findings.jsonl) |
| ------------------------------ | -------------------------- |
| `MOB-CRITICAL-018`             | `MOB-CRITICAL-021`         |
| `MOB-CRITICAL-020` (1st merge) | `MOB-CRITICAL-021`         |

- **MOB-CRITICAL-020** — recorded in `docs/reviews/_registry/finding-id-aliases.yaml` as an alias of
  `MOB-CRITICAL-021`.

## Scope

Read every create/edit form surface
under
, pages/{cull,mortality,harvest,transfer,feeding,lice,welfare,escape,water-quality,storage/StockMovementPage,storage/StockTransferPage,leave/LeaveRequestPage,attendance/AttendancePage,tasks/TaskDetailPage,reports/ReportReviewPage,alerts},
components/PhotoCaptureField.tsx,
hooks/{useOfflineQueue.tsx,useTaskActions.ts,useAlerts.ts,useSendMessage.ts,useCreateChannel.ts,useChannelActions.ts},
pwa/{offline-queue.ts,operation-registry.ts,sw-replay.ts}, services/authenticated-fetch.ts,
types/index.ts, App.tsx routes. Traced each submitted field through the GraphQL documents into
apps/farm-service (harvest DTO/command/handler/resolver/policy, batch-resolver.dto
RecordCull/RecordMortality/TransferBatch, water-quality create input \+ schema.graphql, fish-health
field-capture inputs \+ lice/welfare/escape services, feeding-protocol meal-execution inputs,
storage record-stock-movement/transfer-stock inputs \+ handler, task update-task.dto),
apps/hr-service (clock-in-out.input \+ clock-in.handler, create-leave-request.input \+ handler \+
calculate-leave-days), apps/alert-engine (AcknowledgeAlertInput \+ alert-rule.service),
libs/backend-common (mobile-command-envelope.input, create-service-app ValidationPipe), and
apps/farm-service/schema.graphql for wire-shape confirmation.

```text
/home/user/aquaculture_platform/web/apps/aquamobil/src`: `pages/_shared/RecordEntityPage.tsx
```

## Executive summary

Twelve real write-path defects, one of which breaks a live capture surface end to end. The mobile
Water Quality form still sends a `parameters: {}` field that farm-service deliberately deleted
from `CreateWaterQualityInput`; GraphQL input-object coercion rejects the unknown field, so every
mobile water-quality measurement fails — and the offline lane still renders a green "Measurement
Recorded!" screen before the op dies in the queue. Offline clock-in/out carry no event timestamp, so
hr-service stamps `new Date()` at replay time and payroll hours drift by the whole offline
window. `createHarvestRecord` advertises ten input fields the handler never reads
(method/productForm are overwritten with hardcoded literals), while the one field the harvest policy
makes mandatory above 10 t / 50 k fish — `harvestPlanId` — has no input surface at all, so large
harvests are structurally unrecordable. Leave `totalDays` is client-computed and server-trusted;
ticking "Half Day" collapses any date range to 0.5 charged days. Task lifecycle swallows server
rejections into a fake "queued" success. The rest are dedup-key, silent-validation, timezone and
unvalidated-DTO-field issues.

## Findings (by severity)

### CRITICAL

### PRODUCT-FORM-CRITICAL-001

**Title:** Mobile Water Quality submits a `parameters` field the backend contract no longer has —
every measurement is rejected, and the offline lane still claims success

**Severity:** CRITICAL
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-FORM-CRITICAL-001` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Registered as:** `MOB-CRITICAL-021` (2026-09-05). `PRODUCT-*` is not a registry
domain, so the finding — together with `PRODUCT-MOBILE-CRITICAL-001`, the same
root cause filed by `mobile-app-auditor` — lives in the registry under `MOB`.
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:212
  \- `parameters: {},` included in every submitted input
- web/apps/aquamobil/src/types/index.ts:571 \- `parameters: WaterQualityParameters;` is REQUIRED in
  the aquamobil mirror type, so TypeScript forces the bad field to be sent
- apps/farm-service/src/water-quality/dto/create-water-quality.input.ts:4-9 \- "The
  legacy `WaterParametersInput` class and its fixed `parameters` field were removed"
- apps/farm-service/schema.graphql:9551-9608 \- `input CreateWaterQualityInput` contains
  equipmentId/dynamicParameters/... and NO `parameters` field
- web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:222-226 \- offline
  path `addToQueue('createWaterQuality', input)` then `setShowSuccess(true)` \+ navigate home

**Rule violated:**

CLAUDE.md Security — `ValidationPipe({ whitelist, forbidNonWhitelisted })` contract;
layer-2-defect-catalog "Architecture / contract drift" \+ "Enum / string mismatch". GraphQL
input-object coercion errors on undefined fields, so the mutation never reaches the resolver.

**Proposed fix direction:**

Delete `parameters` from the aquamobil `CreateWaterQualityInput` mirror so the
single-ingress `dynamicParameters` contract is the only representable shape (Tier-1). Then remove
the hand-written mirror entirely: generate the mobile input types from the farm-service supergraph
through the existing aquamobil codegen gate and promote the inline `gql` water-quality documents
into the codegen pluck set, so a backend field removal becomes a mobile compile error instead of a
runtime 100%-failure. Independently, teach `isRetryableError` in pwa/offline-queue.ts to classify
GraphQL variable-coercion / unknown-field errors as PERMANENT so a contract break fails fast and
loudly on the Sync Status page instead of burning the retry budget behind a success screen.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/types/index.ts`
- `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`
- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/codegen.ts + src/generated/graphql.ts`
- `apps/farm-service/schema.graphql`
- `tests/invariants/farm-graphql-fe-be-parity.spec.ts`

**Expected closer:**

contract-parity-enforcer WRITER for the type/codegen alignment; form-write-auditor re-review after

**Verifier note:**

Confirmed at every cited line. WaterQualityRecordPage.tsx:212 puts `parameters: {}` into the object
sent as `$input: CreateWaterQualityInput!` (mutation at :72 and the identical replay doc at
operation-registry.ts:169).
apps/farm-service/schema.graphql `input CreateWaterQualityInput` contains only envelope fields \+
tankId/pondId/siteId/batchId/measuredAt/source/measuredBy/equipmentId/dynamicParameters/idempotencyKey/relatedSensorReadingId/notes/weatherConditions
— no `parameters`. The DTO header confirms WaterParametersInput was deleted; the only repo hits for
that name are the removal comments. GraphQL variable coercion rejects undefined input fields, so
both the online and the queued path fail; types/index.ts:571 makes the field required so every call
site must send it. No stripping layer exists between the page and the gateway. Complete outage of
the mobile water-quality write path plus a false success on the offline lane sustains CRITICAL.

### HIGH

### PRODUCT-FORM-HIGH-002

**Title:** Offline clock-in/clock-out carry no event timestamp — hr-service stamps server-`now` at
replay, so payroll hours and the attendance date are wrong by the entire offline window

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-HIGH-002` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx:93-96
  \- `addToQueue('clockIn', { method: 'MOBILE', location: loc || undefined })` — no time field, and
  the queue is the ONLY path (online too)
- apps/hr-service/src/attendance/dto/clock-in-out.input.ts:44-69 \- `ClockInInput` exposes
  employeeId/method/location/remarks/workAreaId and no clock-time field
- apps/hr-service/src/attendance/handlers/clock-in.handler.ts:93 \- `const nowUtc = new Date();`
- apps/hr-service/src/attendance/handlers/clock-in.handler.ts:274
  \- `existingRecord.clockIn = nowUtc; // Store in UTC`
- web/apps/aquamobil/src/pwa/offline-queue.ts:126-134 \- the envelope already
  stamps `clientCreatedAt: new Date().toISOString()`, which no handler reads

**Rule violated:**

Agent domain rule: "Flag any field that is rendered but never serialized" / derived values must
survive the roundtrip. layer-2-defect-catalog "Money / time" — naive server-now for an event that
happened elsewhere in time.

**Proposed fix direction:**

Make the operator's tap time part of the command, not an artifact of replay latency: add a
required `occurredAt` to ClockInInput/ClockOutInput (nullable-then-backfill-then-NOT-NULL per the
blue-green migration rule) and have the handler derive both the attendance `date` bucket
and `clockIn/clockOut` from it, clamped by a backdate policy service the way farm-service already
clamps harvest dates. The device clock is untrusted input, so bound it: reject `occurredAt` in the
future and outside a configured backfill window, and record the server receipt time alongside it for
audit. The envelope's `clientCreatedAt` is already on the wire — promoting it to an explicit domain
field (rather than reading the envelope) keeps the desktop caller honest too.

**Affected surface (ripple set):**

- `apps/hr-service/src/attendance/dto/clock-in-out.input.ts`
- `apps/hr-service/src/attendance/handlers/clock-in.handler.ts`
- `apps/hr-service/src/attendance/handlers/clock-out.handler.ts`
- `apps/hr-service/src/attendance/commands/*`
- `apps/hr-service/src/database/migrations/`
- `web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx`
- `web/apps/aquamobil/src/types/index.ts (ClockInInput/ClockOutInput)`

**Expected closer:**

contract-parity-enforcer \+ hr domain WRITER; mobile-app-auditor for the offline-replay semantics

**Verifier note:**

Confirmed. ClockInInput/ClockOutInput (clock-in-out.input.ts:44+) expose
employeeId/method/location/remarks/workAreaId and inherit only the MobileCommandEnvelopeInput fields
— no clock-time field. clock-in.handler.ts:93 computes `const nowUtc = new Date()` and writes it at
:274/:297; lateness at :246-257 is computed from the same server-now. AttendancePage.tsx:93-96 and
:114-117 route both online and offline through addToQueue with no time field. The envelope's
clientCreatedAt (offline-queue.ts attachCommandEnvelope) is persisted only
into `hr_mobile_command_receipts` (mobile-command-receipt.service.ts:73) and is never read as the
attendance timestamp — grep for clientCreatedAt in apps/hr-service/src hits only the receipt entity
and its migration. Offline clock-in therefore records the replay time as the worked time and the
attendance date.

### PRODUCT-FORM-HIGH-004

**Title:** `harvestPlanId` is mandatory for large harvests but has no GraphQL input field — harvests
over 10 t / 50 k fish are unconditionally rejected with no way to comply

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-HIGH-004` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/harvest/services/harvest-policy.service.ts:104-122
  \- `planRequired && !params.harvestPlanId` throws `HarvestPlanRequiredError`
- apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts:222-228
  \- `harvestPlanId: input.harvestPlanId ?? null` is the only source, evaluated on every create
- apps/farm-service/schema.graphql:11310-11385 \- `input CreateHarvestRecordInput` has
  no `harvestPlanId` field
- apps/farm-service/src/harvest/dto/create-harvest-record.input.ts:27-156 \- full DTO,
  no `harvestPlanId` member
- apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts:311 \- the entity
  column `harvestPlanId` is written from that always-undefined value

**Rule violated:**

Agent domain rule: "required entity columns with no form input". CLAUDE.md Architectural Approach —
a policy gate that no caller can satisfy is a broken write path, not a control.

**Proposed fix direction:**

Add `harvestPlanId` to `CreateHarvestRecordInput` (`@IsOptional() @IsUUID()`) so the policy gate is
satisfiable, and surface a plan picker on both the web harvest modal and the aquamobil harvest form
that is REQUIRED once the projected biomass/quantity crosses the configured threshold — the
threshold should come from a query so the UI and `HarvestPolicyService` read one source rather than
two hardcoded copies. Add an integration test that submits a `>10` t harvest through the resolver
and asserts it succeeds with a valid plan and fails with a clear field-path error without one, so
the unsatisfiable state is detectable at build time (Tier-3) on top of the Tier-1 input fix.

**Affected surface (ripple set):**

- `apps/farm-service/src/harvest/dto/create-harvest-record.input.ts`
- `apps/farm-service/schema.graphql`
- `apps/farm-service/src/harvest/services/harvest-policy.service.ts`

  ```text
  apps/farm-service/src/harvest/**tests**/handlers/create-harvest-record.handler.spec.ts
  ```

- `web/modules/farm-module harvest modal`
- `web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx`
- `web/apps/aquamobil/src/types/index.ts (HarvestInput)`

**Expected closer:**

contract-parity-enforcer WRITER \+ workflow-state-auditor review of the plan-status gate

**Verifier note:**

Confirmed and not satisfiable by any caller. harvest-policy.service.ts:104-122 throws
HarvestPlanRequiredError when projectedBiomassKg `>` `10_000` or projectedQuantity `>` `50_000` and
harvestPlanId is falsy; create-harvest-record.handler.ts:222-228 feeds
it `input.harvestPlanId ?? null`. The GraphQL input type in schema.graphql has no harvestPlanId (the
only schema occurrence, :4403, is on the HarvestRecord OUTPUT type) and the DTO has no such member,
so the resolver path (harvest.resolver.ts:363) can never populate it. The only other caller,
batch.controller.ts:601, also omits it. updateHarvestRecord does not map harvestPlanId either, so
there is no after-the-fact repair. Thresholds are env-overridable, which is an operational escape
hatch but not a caller-side way to comply — the gate blocks a legitimate core operation outright.

### PRODUCT-FORM-HIGH-005

**Title:** Leave request `totalDays` is client-computed and server-trusted; the Half Day toggle
collapses any date range to 0.5 charged days

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-HIGH-005` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:50-56
  \-
  —
  no weekend/holiday exclusion, and Half Day overrides the whole range

  ```text
  const diff = Math.ceil((end - start)/86400000)+1; return isHalfDay ? 0.5 : Math.max(0, diff);
  ```

- web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:84-92 \- the payload
  ships `totalDays` alongside the independently-chosen `startDate`/`endDate`
- apps/hr-service/src/leave/dto/create-leave-request.input.ts:36-39
  \- `@Field(() => Float) @IsNumber() @Min(0.5) totalDays!: number` — required, client-supplied, no
  cross-field check
- apps/hr-service/src/leave/handlers/create-leave-request.handler.ts:163-172
  \- use the
  client value directly; :176-182 persists it

  ```text
  availableBalance < totalDays` gate and `leaveBalance.pending += Number(totalDays)
  ```

- apps/hr-service/src/leave/query-handlers/calculate-leave-days.handler.ts:82-124 \- the server's
  own correct calculator (weekends, holidays, per-boundary half-days) exists and is never invoked on
  create

**Rule violated:**

Agent domain rule: "Flag any user-editable field that is trusted from the client even though
server-side derivation should be authoritative." CLAUDE.md Architectural Approach Tier-1 (make it
impossible).

**Proposed fix direction:**

Delete `totalDays` from `CreateLeaveRequestInput` and have `CreateLeaveRequestHandler` derive it
from `startDate`/`endDate`/`isHalfDayStart`/`isHalfDayEnd` through the
existing `CalculateLeaveDaysHandler` inside the same transaction that locks the balance row — one
calculator, one truth, structurally unspoofable. The mobile and web forms then render the
server-calculated preview (a query against the same handler) instead of re-implementing the
arithmetic. While there, replace the mobile boolean `isHalfDay` with the real half-day model the
backend has (`isHalfDayStart`/`isHalfDayEnd`/`halfDayPeriod`), because the current mapping also
leaves `halfDayPeriod` permanently null on every half-day row.

**Affected surface (ripple set):**

- `apps/hr-service/src/leave/dto/create-leave-request.input.ts`

  ```text
  apps/hr-service/src/leave/dto/update-leave-request.input (same totalDays trust)
  ```

- `apps/hr-service/src/leave/handlers/create-leave-request.handler.ts`
- `apps/hr-service/src/leave/handlers/update-leave-request.handler.ts`
- `apps/hr-service/schema.graphql`
- `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx`
- `web/apps/aquamobil/src/types/index.ts (CreateLeaveRequestInput)`
- `web/modules/hr-module leave request form`

**Expected closer:**

hr domain WRITER; contract-parity-enforcer for the DTO removal

**Verifier note:**

Confirmed end to end. LeaveRequestPage.tsx:50-56 computes calendar diff with no weekend/holiday
exclusion and returns a flat 0.5 whenever isHalfDay is set, regardless of range length; :84-92 ships
that totalDays alongside independently chosen startDate/endDate. create-leave-request.input.ts:36-39
requires the client Float with only @Min(0.5). The handler validates only `start<=end` and
minDaysNotice (lines 68-86) — there is no cross-field check — then uses the client value directly
for the balance gate (:163) , the pending accrual (:170) and the persisted row (:182).
calculate-leave-days.handler.ts:82-124 implements the correct weekend/holiday/half-day-boundary
calculation and is never invoked on create. A multi-day absence can be charged 0.5 days of balance.

### MEDIUM

### PRODUCT-FORM-MEDIUM-003

**Title:** `createHarvestRecord` accepts ten input fields no write path consumes;
submitted `method`/`productForm` are silently overwritten with hardcoded literals

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-HIGH-003` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/harvest/dto/create-harvest-record.input.ts:77-139
  \-
  `method`,
  `productForm`,
  `totalRevenue`,
  all
  declared \+ validated (plus `pondId` at :39-42)

  ```text
  harvestCost`, `currency`, `lotNumber`, `mortalityDuringHarvest`, `rejectedQuantity`, `rejectionReason
  ```

- apps/farm-service/src/harvest/commands/create-harvest-record.command.ts:14-34 \- the
  command's `CreateHarvestRecordInput` interface carries NONE of them
- apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts:315
  \- `method: HarvestMethod.NET,` and :319 `productForm: ProductForm.FRESH_WHOLE,` hardcoded onto
  the persisted row
- apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:362-371 \- the DTO instance is passed
  to the command verbatim, so the extra properties exist at runtime and are simply never read
- apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:390-404 \- `updateHarvestRecord` DOES
  map method/productForm/harvestCost/rejectedQuantity, proving the columns are real and only create
  drops them

**Rule violated:**

Agent domain rule: "Flag any create/edit flow where the backend silently drops submitted fields
instead of rejecting them or persisting them." CLAUDE.md Architectural Approach — a field with no
consumer is either wired or removed, never left as decoration.

**Proposed fix direction:**

Close the gap at the type level so it cannot reopen: make `CreateHarvestRecordCommand`'s input type
derive from the DTO (or make the DTO implement the command interface) so any GraphQL field without a
command counterpart is a compile error. Then either thread the genuinely meaningful
fields
(`method`,
`productForm`,
) through
to `HarvestRecord`, or delete them from the create DTO with a `BREAKING CHANGE:` footer — do not
leave a validated-but-ignored surface. `lotNumber`, `totalRevenue` and `currency` are server-derived
(generateCode, `pricePerKg*biomass`, `finance_settings`) and must be removed from the create input
outright so attribution/traceability cannot be spoofed, mirroring the `harvestedBy` removal already
documented at create-harvest-record.input.ts:141-149.

```text
harvestCost`, `mortalityDuringHarvest`, `rejectedQuantity`, `rejectionReason`, `pondId
```

**Affected surface (ripple set):**

- `apps/farm-service/src/harvest/dto/create-harvest-record.input.ts`
- `apps/farm-service/src/harvest/commands/create-harvest-record.command.ts`
- `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts`
- `apps/farm-service/schema.graphql`
- `web/modules/farm-module harvest modal`
- `web/apps/aquamobil/src/types/index.ts (HarvestInput)`

  ```text
  apps/farm-service/src/harvest/dto/**tests**/create-harvest-record.input.spec.ts
  ```

**Expected closer:**

contract-parity-enforcer WRITER

**Verifier note:**

The mechanical facts hold: create-harvest-record.input.ts declares
pondId/method/productForm/totalRevenue/harvestCost/currency/lotNumber/mortalityDuringHarvest/rejectedQuantity/rejectionReason;
the command interface (create-harvest-record.command.ts:14-33) carries none of them (it does carry
harvestPlanId); the handler
hardcodes `method: HarvestMethod.NET` and `productForm: ProductForm.FRESH_WHOLE` and derives
totalRevenue from pricePerKg; the resolver passes the DTO verbatim. Severity is inflated, though: no
shipping client submits method or productForm —
web/modules/farm-module/src/hooks/useBatches.ts:176-189 sends only
batchId/tankId/quantity/avgWeight/totalBiomass/qualityClass/lotNumber/harvestDate/pricePerKg/buyerName/notes,
and aquamobil RecordHarvestPage sends even less. The only field a real form sends and the server
discards is lotNumber, which the handler deliberately regenerates as the traceability SSoT. So today
this is an over-wide API surface with no live user-data corruption, not a HIGH write-path defect.

### PRODUCT-FORM-MEDIUM-006

**Title:** Task lifecycle actions swallow server REJECTIONS into a fake offline "queued" success
that then dies permanently in the queue

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-HIGH-006` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useTaskActions.ts:84-86
  \- `} catch { // Network error despite isOnline — fall through to queue }` catches every error
  class, not just transport (same at :110-112 and :138-140)
- web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:117-133 \- a queued result renders "Complete
  task queued" \+ QueuedStatusBadge, then refetches and shows the task still open with no error
- web/apps/aquamobil/src/pwa/offline-queue.ts:876-893 \- `isRetryableError` classifies
  'forbidden'/'validation'/'bad request' as PERMANENT, so the op is never promoted back to pending
  and sits `failed` forever
- web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx:386 \- the correct
  discriminator `isRecoverableNetworkError(error)` already exists and is used by the storage and
  water-quality forms
- web/apps/aquamobil/src/utils/network-error.ts \- the shared helper the task hook bypasses

**Rule violated:**

layer-2-defect-catalog "Empty / swallowing catch". Agent domain rule: "Flag any mutation that claims
success but does not prove" the write landed.

**Proposed fix direction:**

Make the online-attempt fallback discriminate on error class, not on the mere existence of an
exception: route every `isOnline` attempt through one shared `attemptThenQueue` helper that queues
ONLY when `isRecoverableNetworkError(error)` is true and re-throws otherwise, so a 403 /
state-machine rejection surfaces as a real error banner. Because three separate call sites (task
actions, stock movement, water quality) each hand-roll this decision today, extract it once and make
the raw `try/catch { addToQueue }` shape impossible to re-introduce — the helper becomes the only
exported way a page falls back to the queue. Pair it with an explicit failed-op surface on
TaskDetailPage so a permanently-failed queued action is visible where the operator acted, not only
on the Sync Status page.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useTaskActions.ts`
- `web/apps/aquamobil/src/utils/network-error.ts`
- `web/apps/aquamobil/src/utils/async-action.ts`
- `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx`
- `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx`
- `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`
- `web/apps/aquamobil/src/components/QueuedStatusBadge.tsx`

**Expected closer:**

mobile-app-auditor WRITER

**Verifier note:**

The mechanism is real: useTaskActions.ts:84-86, :110-112 and :138-140 are bare `catch { }` blocks
that swallow every error class (403, validation, business rule) and fall through to addToQueue,
returning wasQueued=true; TaskDetailPage.tsx:117-133 then shows 'Complete task queued';
offline-queue.ts isRetryableError treats forbidden/validation/bad request as permanent; the correct
discriminator isRecoverableNetworkError exists in utils/network-error.ts and is used by the storage
and water-quality pages. Severity is overstated on the 'dies permanently and silently' half: the
returned operationId feeds QueuedStatusBadge, which renders 'Sync Failed' with a retry affordance,
and pages/sync lists permanently-failed operations (isPermanentlyFailed / 'Permanently failed —
please remove') with the stored error. The defect is a mislabeled success plus a misclassified error
surfaced as 'Could not reach server', not an invisible lost write.

### PRODUCT-FORM-MEDIUM-007

**Title:** Shared record shell: a validation failure discovered on the confirm screen is a
completely silent no-op — the Confirm button does nothing and shows nothing

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-MEDIUM-007` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- opens
  with `if (!validate() || !metrics?.batchId) return;` before any state is set

  ```text
  web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:218-219` \- `handleSubmit
  ```

- `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:291` \- the confirm step renders
  only `{errors.general && <ErrorBanner .../>}`; `errors.tank` and `errors.quantity` (the
  keys `validate()` actually populates) have no confirm-screen renderer
- web/apps/aquamobil/src/pages/cull/RecordCullPage.tsx:59-68 \- validate()
  writes `next.tank` / `next.quantity`, never `general`
- web/apps/aquamobil/src/pages/escape/EscapeIncidentPage.tsx:101-114 \- same, plus site/species
  preconditions that can flip after a background `useTanks` refetch while the operator sits on the
  confirm screen

**Rule violated:**

Agent domain rule: LOW/MEDIUM write-path friction that makes a submit unfalsifiable. CLAUDE.md
Working Style — "Report faithfully… never present a partial fix as complete" applied to the UI's own
honesty contract.

**Proposed fix direction:**

Fold the batch/site precondition into the same error channel the confirm screen renders:
have `validate()` be the single gate (including the `metrics?.batchId` check the shell currently
duplicates as a bare early return) and make the shell surface every populated key of `TErrors` on
BOTH steps, or bounce back to the entry step when a non-`general` key is set. Better still, make it
unrepresentable: the confirm step should take a validated payload object produced once at Review
time, so reaching Confirm with an invalid form is not a state the type system permits. Six forms
(cull, mortality, harvest, lice, welfare, escape) inherit this shell, so the fix is one file.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx`
- `web/apps/aquamobil/src/pages/_shared/**tests**/RecordEntityPage.spec.tsx`

  ```text
  web/apps/aquamobil/src/pages/{cull,mortality,harvest,lice,welfare,escape}/*.tsx
  ```

**Expected closer:**

mobile-app-auditor WRITER

**Verifier note:**

Confirmed
at
—
returns before any state is set) and :291 (the confirm branch renders
only `{errors.general && <ErrorBanner .../>}`). The keys validate() actually writes
are `tank`/`quantity` (RecordCullPage.tsx:59-68, EscapeIncidentPage.tsx:101-114), and neither has a
confirm-screen renderer, so the Confirm button is a dead no-op with zero feedback. I checked the
entry step separately: `canReview` on all six pages already
includes `!!metrics?.batchId` (RecordCullPage.tsx:105, RecordHarvestPage.tsx:125,
RecordMortalityPage.tsx:113, WelfareScorePage.tsx:148), so the entry-step Review button is visibly
disabled rather than silently dead — the defect is confirm-step-only, as filed. Reachability is real
rather than theoretical: useTanks.ts:182-184
sets `staleTime: 60_000` and `refetchOnWindowFocus: true`, so a background refetch while the
operator sits on the confirm screen can drop `batchMetrics` (batch closed by someone else) or
lower `metrics.pieces` below the entered quantity (cull `maxQuantity`), flipping validate() to false
with no visible reason. MEDIUM is right — a real defect an operator eventually hits, but it needs
concurrent state change to trigger.

```text
web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:218` (`if (!validate() || !metrics?.batchId) return;
```

### PRODUCT-FORM-MEDIUM-008

**Title:** `idempotencyKey` is minted per submit ATTEMPT, defeating both the server at-most-once
guard and the queue's payload-hash dedup for water quality, stock movement and stock transfer

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-MEDIUM-008` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:211
  \- `idempotencyKey: crypto.randomUUID(),` inside `handleSubmit`
- web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx:360 \- same, inside `handleSubmit`
- web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx:267 \- same, inside `handleSubmit`
- web/apps/aquamobil/src/pwa/offline-queue.ts:116-118 \+ :295
  \- `computePayloadHash(payload)` hashes the payload INCLUDING the random key, so two submissions
  of the identical form never match
- web/apps/aquamobil/src/pwa/offline-queue.ts:196-206 \- the dedup contract claims coverage "for
  EVERY operation type by construction — including stock movements and transfers", which these three
  ops falsify

**Rule violated:**

Agent domain rule: "Flag any mobile draft, offline queue, or retry submit path that can replay stale
payloads" / at-most-once obligations. layer-2-defect-catalog "Concurrency — check-then-insert
TOCTOU".

**Proposed fix direction:**

Bind the idempotency key to the FORM INSTANCE, not the submit call: mint it once when the form
mounts (or when the wizard reaches the confirm step) and keep it in state across every retry,
exactly as `useTaskActions.mintCommandIdentity` already does for the task lifecycle — one action,
one command identity. Then make it structural: have `queueOperation` compute the dedup fingerprint
over the payload with the at-most-once key EXCLUDED (it is an identity token, not content), so a
per-attempt key can never again silently disable the 5-second double-submit window. The comment at
offline-queue.ts:196-206 must stop asserting a guarantee the code does not provide.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`
- `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx`
- `web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx`
- `web/apps/aquamobil/src/pwa/**tests**/offline-queue.spec.ts`

**Expected closer:**

mobile-app-auditor WRITER

**Verifier note:**

All five citations hold. `idempotencyKey: crypto.randomUUID()` is inside handleSubmit at
WaterQualityRecordPage.tsx:211, StockMovementPage.tsx:360 and StockTransferPage.tsx:267 (the latter
even documents it as 'Generate once for this submit attempt').
offline-queue.ts:116-118 `computePayloadHash` hashes the raw payload — which for these three op
types CONTAINS the random key — and :295-305 compares `op._payloadHash` within `DEDUP_WINDOW_MS`, so
two submissions of the identical form can never match; the contract comment at :196-206 explicitly
claims dedup 'is correct for EVERY operation type by construction — including stock movements and
transfers', which these three falsify. The server side of the claim also checks
out: `farm.water_quality_measurements` carries a partial UNIQUE (tenantId, idempotencyKey) index
(entities/water-quality-measurement.entity.ts:186), and stock-movement.service.ts:174-179 plus
transfer-stock.handler.ts:48-53 do an idempotent-hit lookup on the same key — so a per-attempt key
is exactly what disarms them. Scope note that does not refute but sharpens it: the same three
payloads also carry a fresh wall-clock (`measuredAt: new Date().toISOString()`), and the
RecordEntityPage payloads carry `culledAt`/`detectedAt` built per submit, so the payload-hash dedup
window is defeated more broadly than the finding states — the at-most-once half is what is uniquely
broken by the random key. Exposure is the retry-after-error path (first request lands, client shows
an error, operator taps submit again → new key → duplicate row); within one attempt the
same `input` object is reused for the queue fallback, so that path is safe. MEDIUM.

### PRODUCT-FORM-MEDIUM-009

**Title:** Escape incident: `recoveryOngoing` hardcoded false and `causeDetails` never collected,
and the shell refuses to record an escape from a pen with no active batch although the backend
allows it

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-MEDIUM-009` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/escape/EscapeIncidentPage.tsx:134 \- `recoveryOngoing: false,` with
  no UI control anywhere on the page
- web/apps/aquamobil/src/pages/escape/EscapeIncidentPage.tsx:42-43 \- an 'OTHER' cause is
  selectable, yet buildPayload (:125-137) never sets `causeDetails`
- apps/farm-service/src/fish-health/dto/field-capture.inputs.ts:298-307
  \- `causeDetails` and `recoveryOngoing` are first-class validated inputs
- apps/farm-service/src/fish-health/services/escape-incident.service.ts:86-91 \- both are persisted
  straight onto the row, so the columns exist and stay null/false forever from mobile
- `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:219` \+
  web/apps/aquamobil/src/pages/escape/EscapeIncidentPage.tsx:104 \- `!metrics?.batchId` hard-blocks
  submit even though RecordEscapeIncidentInput makes tankId/batchId optional

**Rule violated:**

Agent domain rule: "Flag any field that is rendered but never serialized" and "required entity
columns with no form input". The page's own header states escape reporting is legally immediate,
which raises the bar on capture completeness.

**Proposed fix direction:**

Add the two missing controls to the escape form — a `recoveryOngoing` switch and
a `causeDetails` free-text that becomes required when cause is OTHER/UNKNOWN — so the varsling
assembler is not reading nulls the operator could have supplied. Separately, relax the shared
shell's batch precondition for this one flow: parameterise `RecordEntityPage` with whether a batch
is REQUIRED, because an escape from a pen whose batch record is stale or already closed is exactly
the case that must still be recordable, and the backend already models tankId/batchId as optional.
Route the resulting behaviour change past workflow-state-auditor since it widens what states can
file an incident.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pages/escape/EscapeIncidentPage.tsx`
- `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx`
- `web/apps/aquamobil/src/types/index.ts (EscapeIncidentInput)`
- `web/apps/aquamobil/src/pages/escape/**tests**/EscapeIncidentPage.spec.tsx`
- `apps/farm-service/src/regulatory assembly for rømming varsling`

**Expected closer:**

mobile-app-auditor WRITER; workflow-state-auditor review

**Verifier note:**

The two data-capture halves are confirmed. EscapeIncidentPage.tsx:134
hardcodes `recoveryOngoing: false` with no control on the page, and buildPayload (:116-138) never
sets `causeDetails` even though 'OTHER' is a selectable cause (`ESCAPE_CAUSES`, :42-43) and the web
type declares the field (types/index.ts:202-203). Server-side both are first-class:
field-capture.inputs.ts:298-307 validates `causeDetails`/`recoveryOngoing`, and
escape-incident.service.ts:86-91 persists them onto the row. Impact is slightly worse than the
finding argues: regulatory/assembly/assemblers/escape.assembler.ts:98
tags `/recoveryOngoing` as `fromRecords(...)`, i.e. the varsling draft presents the never-asked
hardcoded `false` as a record-sourced fact, and :178 selects `ei."recoveryOngoing"` straight from
the mobile-written row. Mitigation keeping this at MEDIUM rather than HIGH: the desktop
EscapeReportTab.tsx:194 lets the filer override at varsling time. Partial refutation of the THIRD
sub-claim only: the shell does hard-block a batchless pen (RecordEntityPage.tsx:218
plus `canReview={... !!metrics?.batchId ...}`), but 'the backend allows it' is only half true —
RecordEscapeIncidentInput makes tankId/batchId optional yet `speciesId` is REQUIRED
(field-capture.inputs.ts:~296), and mobile's only source of speciesId is `metrics.speciesId`. So the
proposed 'parameterise the shell with batch-required' fix does not work as written; a batchless
escape needs a species source first. The finding as a whole stands on the two missing fields.

### PRODUCT-FORM-MEDIUM-010

**Title:** Regulatory date keys are built from the UTC calendar day, so a night-shift lice count can
be filed into the wrong ISO reporting week

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-FORM-MEDIUM-010` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/lice/LiceCountPage.tsx:97
  \- `countDate: new Date().toISOString().slice(0, 10)` (UTC day, not the operator's local day)
- apps/farm-service/src/fish-health/services/lice-count.service.ts:38-39
  \- `isoWeekOf(new Date(${countDate}T00:00:00Z))` derives the reportingYear/reportingWeek the
  weekly lakselus assembler aggregates on
- web/apps/aquamobil/src/pages/welfare/WelfareScorePage.tsx:122
  \- `assessedAt: new Date().toISOString().slice(0, 10)` — same pattern
- web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx:101
  \- `harvestDate: new Date().toISOString().split('T')[0]` — same pattern, feeding lot traceability
- apps/farm-service/src/fish-health/services/lice-count.service.ts:56-61 \- the upsert key is
  (tenantId, tankId, countDate), so a shifted day also splits what should be one corrected row into
  two

**Rule violated:**

layer-2-defect-catalog "Money / time — naive Date math across DST/timezones"; agent domain rule on
lost precision/units in the roundtrip.

**Proposed fix direction:**

Stop deriving a calendar day on the client from a UTC instant. Send the full local instant plus the
site's IANA timezone (or send the instant and let the service resolve the site timezone it already
owns), and let the one server-side date-bucketing utility that `isoWeekOf` lives beside compute
countDate / assessedAt / harvestDate. Because the same `toISOString().slice(0,10)` idiom appears on
three independent pages, put the conversion behind a single mobile helper so a new form cannot
re-derive it — and add an invariant test asserting no aquamobil page
calls `toISOString().slice(0,10)`/`.split('T')[0]` for a domain date field.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pages/lice/LiceCountPage.tsx`
- `web/apps/aquamobil/src/pages/welfare/WelfareScorePage.tsx`
- `web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx`
- `apps/farm-service/src/fish-health/services/lice-count.service.ts`
- `apps/farm-service/src/fish-health/services/welfare-assessment.service.ts`
- `apps/farm-service/src/regulatory/assembly/period.util.ts`
- `apps/farm-service/src/fish-health/dto/field-capture.inputs.ts`

**Expected closer:**

contract-parity-enforcer \+ farm domain WRITER

**Verifier note:**

Every citation holds verbatim. web/apps/aquamobil/src/pages/lice/LiceCountPage.tsx:97
is `countDate: new Date().toISOString().slice(0, 10)` inside buildPayload — a UTC calendar day,
never the operator's local day.
apps/farm-service/src/fish-health/services/lice-count.service.ts:38-39
is
and
:66-67 persists reportingYear/reportingWeek from it; the upsert lookup at :59-61
is `where: { tenantId, tankId, countDate }` exactly as filed.
WelfareScorePage.tsx:122 (`assessedAt: new Date().toISOString().slice(0, 10)`) and
RecordHarvestPage.tsx:101 (`harvestDate: new Date().toISOString().split('T')[0]`) repeat the idiom.
I hunted for a guard the claimer missed and found none:
apps/farm-service/src/fish-health/dto/field-capture.inputs.ts:52 and :213 accept
countDate/assessedAt as bare `@IsDateString()` with no timezone parameter and no server
re-derivation, so the client value is taken verbatim; no stripping or normalization layer exists.
The downstream consumers are real regulatory keys —
apps/farm-service/src/regulatory/assembly/assemblers/lakselus.assembler.ts:335-336 aggregates
on `"reportingYear" = $3 AND "reportingWeek" = $4`, and harvestDate feeds period ranges in
slakt.assembler.ts:305 and
biomass.assembler.ts:323-339 (`hr."harvestDate"::date BETWEEN $3 AND $4`), so a UTC-shifted day can
also push a harvest into the wrong monthly report, not just the wrong ISO week. The proposed fix is
feasible because the server already owns the timezone:
apps/farm-service/src/site/entities/site.entity.ts:235
declares `@Column({ length: 50, default: 'UTC' }) timezone!: string`. Two refinements that sharpen
rather than refute: (a) the report's 'splits one corrected row into two' framing understates the
worse direction — because the key is (tenantId, tankId, countDate), a re-count taken just after
local midnight resolves to the PREVIOUS UTC day and silently OVERWRITES the prior day's count via
the `Object.assign(existing, values)` path at lice-count.service.ts:78-80; (b)
the `default: 'UTC'` on site.timezone means a default-configured site sees no site-vs-stored
divergence, which is why this stays MEDIUM rather than higher. Severity confirmed as filed: the
trigger window is narrow (a submission within the UTC-offset band around local midnight) and desktop
correction paths exist, but the defect is real, reachable, and lands in regulatory period keys.

```text
const countDate = input.countDate.slice(0, 10); const { isoYear, isoWeek } = isoWeekOf(new Date(${countDate}T00:00:00Z));
```

### LOW

### PRODUCT-FORM-LOW-011

**Title:** `RecordStockMovementInput.expiryDate` carries no validation decorator and
no `@Type(() => Date)`, unlike its sibling `movementDate`

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-FORM-LOW-011` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/storage/dto/record-stock-movement.input.ts:45-47
  \- `@Field({ nullable: true }) @IsOptional() expiryDate?: Date;` — `@IsOptional()` alone is the
  only class-validator metadata
- apps/farm-service/src/storage/dto/record-stock-movement.input.ts:90-99 \- `movementDate` on the
  same DTO correctly carries `@Type(() => Date) @IsDate() @MaxDate(...)`
- web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx:362
  \- `...(expiryDate ? { expiryDate } : {})` sourced from `<input type="date">` (:679-684), i.e. a
  bare `yyyy-mm-dd` string
- apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts:61
  \- `expiryDate: input.expiryDate,` persisted unchecked
- libs/backend-common/src/bootstrap/create-service-app.ts:458-461 \-
  global `whitelist: true, forbidNonWhitelisted: true, transform: true`, which is what makes a
  decorator-less field a latent stripping hazard

**Rule violated:**

CLAUDE.md Security — "Input validation: ValidationPipe({ whitelist: true, forbidNonWhitelisted:
true, transform: true })". A property whose only metadata is `@IsOptional()` survives the whitelist
but is never actually validated.

**Proposed fix direction:**

Give , plus a
forward-looking `@MinDate`-style guard appropriate to a shelf-life field) so a malformed or past
expiry on a FEED/HEALTHCARE lot is rejected at the boundary rather than persisted into the
traceability record. Then make the class detectable rather than relying on review: add an invariant
spec that walks every `@InputType()` in the repo and fails when a `@Field()` property has no
class-validator constraint beyond `@IsOptional()` — this is the only way the next decorator-less
field is caught at build time.

```text
expiryDate` the same decorator triad its sibling has (`@Type(() => Date) @IsDate()
```

**Affected surface (ripple set):**

- `apps/farm-service/src/storage/dto/record-stock-movement.input.ts`
- `appsps/farm-service/src/storage/handlers/record-stock-movement.handler.ts`
- `tests/invariants/ (new DTO-decorator completeness spec)`
- `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx`

**Expected closer:**

contract-parity-enforcer WRITER

**Verifier note:**

Holds.
is exactly `@Field({ nullable: true }) @IsOptional() expiryDate?: Date;` — @IsOptional() is the only
class-validator metadata, while the sibling at :90-99
carries
. Handler
at handlers/record-stock-movement.handler.ts:61 forwards `expiryDate: input.expiryDate` into
RecordMovementInput, which reaches stock-movement.service.ts:279/697/711 and lands
in `@Column({ type: 'date', nullable: true })` on both stock-movement.entity.ts:98-99 and
storage-inventory.entity.ts:58-59. The global pipe at
libs/backend-common/src/bootstrap/create-service-app.ts:458-461
is `whitelist: true, forbidNonWhitelisted: true, transform: true` as quoted. I looked for a guard
the claimer missed and found none that closes it: the field is `expiryDate: DateTime` in
apps/farm-service/schema.graphql:9108,
and `node_modules/@nestjs/graphql/dist/scalars/iso-date.scalar.js` parseValue is a
bare `return new Date(value)` with no validity check, so a malformed string yields an Invalid Date
object that passes straight through the pipe (no @IsDate to reject it) into the date column. LOW is
the right severity, not higher: the only production writer is StockMovementPage.tsx:679-684,
an `<input type="date">` whose value is always a well-formed yyyy-mm-dd
(:362 `...(expiryDate ? { expiryDate } : {})`), and a malformed value from any other caller fails
loudly at the driver rather than silently corrupting the traceability row. Two secondary framings in
the evidence are wrong but do not sink the claim: @IsOptional() does register property metadata, so
the field is not actually a whitelist-stripping hazard (the report's own Rule-violated text concedes
this), and @Type(() `=>` Date) is redundant here because the DateTime scalar already hands the pipe
a Date instance — the real missing decorator is @IsDate().

```text
/home/user/aquaculture_platform/apps/farm-service/src/storage/dto/record-stock-movement.input.ts:45-47
```

```text
@IsOptional() @Type(() => Date) @IsDate() @MaxDate(() => new Date()) movementDate?: Date;
```

### PRODUCT-FORM-LOW-012

**Title:** Alert acknowledgement: the note field is plumbed end to end but no mobile UI collects it,
and `acknowledgedAt` is stamped at replay time rather than at the operator's tap

**Severity:** LOW
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-FORM-LOW-012` by `form-write-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useAlerts.ts:101-104
  \- `acknowledge(alertId, note?)` forwards `{ alertId, note }` to the queue
- web/apps/aquamobil/src/pages/alerts/AlertsPage.tsx:109 and :122 \- both production call sites
  invoke `acknowledge(alertId)` with no note; only the
  spec (`hooks/**tests**/useAlerts.spec.tsx:139`) ever passes one
- apps/alert-engine/src/alert/dto/create-alert-rule.dto.ts:163-167
  \- `note?: string` with `@MaxLength(500)` is a real input
- apps/alert-engine/src/alert/services/alert-rule.service.ts:277-279
  \- `alert.acknowledgedAt = new Date(); ... alert.acknowledgementNote = note;`

**Rule violated:**

Agent domain rule: "Flag any field that is rendered but never serialized" (inverse case:
serializable capability with no capture surface) and the same replay-time-vs-event-time class as
PRODUCT-FORM-HIGH-002.

**Proposed fix direction:**

Either add the acknowledgement-note input to the mobile alert surface — a one-line "what did you
do?" is the whole operational value of an ack ledger — or drop the parameter
from `useAlerts.acknowledge` so the hook stops advertising a capability the product does not have.
Whichever way, apply the PRODUCT-FORM-HIGH-002 remedy here too: the ack is queue-first and naturally
idempotent, so `acknowledgedAt` should come from the command's own event time, not from whenever the
drain happened to run.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAlerts.ts`
- `web/apps/aquamobil/src/pages/alerts/AlertsPage.tsx`
- `web/apps/aquamobil/src/components/CriticalAlertBanner.tsx`
- `apps/alert-engine/src/alert/dto/create-alert-rule.dto.ts`
- `apps/alert-engine/src/alert/services/alert-rule.service.ts`

**Expected closer:**

mobile-app-auditor WRITER; alert-engine domain review for the timestamp

**Verifier note:**

Both halves confirmed at the cited lines. web/apps/aquamobil/src/hooks/useAlerts.ts:44
declares `acknowledge: (alertId: string, note?: string) => Promise<void>` and :100-104
forwards `await addToQueue('acknowledgeAlert', { alertId, note })`, so the note is genuinely
plumbed. The replay document at web/apps/aquamobil/src/pwa/operation-registry.ts:227-235 sends the
whole `$input: AcknowledgeAlertInput!`, and
apps/alert-engine/src/alert/dto/create-alert-rule.dto.ts:163-167 is
exactly on
AcknowledgeAlertInput, persisted at
apps/alert-engine/src/alert/services/alert-rule.service.ts:279
`alert.acknowledgementNote = note;`. I enumerated every caller rather than trusting the report: a
repo-wide grep for `acknowledge(` across web/apps/aquamobil/src returns only
AlertsPage.tsx:109 (`void acknowledge(ackParam)`, the notification deep-link path) and
AlertsPage.tsx:122 (`await acknowledge(alertId)`, the button handler) — both noteless —
plus `hooks/**tests**/useAlerts.spec.tsx:139`, the only site passing a note. I also checked
components/CriticalAlertBanner.tsx, which the ripple set names: it consumes
only `criticalUnacknowledged`/`refetch` from useAlerts and its 'Acknowledge' control navigates to
/alerts, so it is not a third call site. So the note has no capture UI anywhere in production. The
timestamp half holds too: alert-rule.service.ts:277 is `alert.acknowledgedAt = new Date();` with no
event-time input on the DTO (only alertId, note and the inherited envelope), and a grep for
clientCreatedAt across apps/alert-engine/src hits only a docstring
in `dto/**tests**/acknowledge-alert-envelope-parity.spec.ts:12` — nothing reads it, so a queued ack
is stamped at drain time. LOW is the correct severity and I looked specifically for a reason to
raise it: the response-time metric `timeToAcknowledge` at
apps/alert-engine/src/database/entities/alert-incident.entity.ts:401-402 lives on the
separate `alert_incidents` table, and escalation/acknowledgment-tracker.service.ts:547 stamps its
own record, so the mobile-written `alert_history.acknowledgedAt` has no downstream SLA consumer.
Unlike PRODUCT-FORM-HIGH-002 the drift is audit-cosmetic, not payroll-affecting, and the ack is
idempotent and normally drains within ~1s.

```text
@Field({ nullable: true }) @IsString() @IsOptional() @MaxLength(500) note?: string;
```

## Inventory — what exists / what is missing

| Status          | Area                                                                                                    | Note                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Water Quality measurement (createWaterQualityMeasurement)                                               | BROKEN END TO END. The form ships a `parameters: {}` field the GraphQL input no longer declares, so coercion rejects every submission; the offline branch still renders a green success screen and the queued op then exhausts its retries. Effectively no water-quality capture path from mobile exists today.                                                                                           |
| **PARTIAL**     | Alert acknowledgement (acknowledgeAlert)                                                                | Queue-first with an optimistic local flip; alertId reaches AlertRuleService which sets acknowledged/acknowledgedBy/acknowledgedAt/acknowledgementNote. The note has no capture UI and acknowledgedAt is replay-time.                                                                                                                                                                                      |
| **PARTIAL**     | Attendance clock-in / clock-out                                                                         | Captures method=MOBILE and an optional GPS fix (lat/lon/accuracy), both persisted. No event timestamp is sent, so offline taps are stamped at replay. The DTO's `workAreaId` (which drives the geofence check), `remarks`, and clock-out `breakStartTime`/`breakEndTime` have no mobile input, so the geofence validation is unreachable from this app.                                                   |
| **PARTIAL**     | Escape incident (recordEscapeIncident)                                                                  | Site, tank, batch, species, estimatedCount, cause, avgWeightG, notes and photos are captured and persisted with an outbox event and receipt-based dedup. `causeDetails` and `recoveryOngoing` have no control, and the shared shell blocks recording from a pen without an active batch even though the backend allows it.                                                                                |
| **PARTIAL**     | Incident photo capture (requestIncidentMediaUpload)                                                     | Upload-at-capture works online: presign → PUT → storageKey → mediaKeys on the record. Offline capture is disabled with an honest banner and no blob-replay lane exists for incident media, so a photographed escape recorded offline reaches the server without its evidence.                                                                                                                             |
| **PARTIAL**     | Leave request (createLeaveRequest \+ chained submitLeaveRequest)                                        | Type, dates, half-day toggle and reason are captured; the queue chains create→submit so the UX promise ('requested', not 'drafted') holds. But totalDays is client-derived and server-trusted, halfDayPeriod is never set, and the backend's `contactDuringLeave` has no input.                                                                                                                           |
| **PARTIAL**     | Record Harvest form (createHarvestRecord)                                                               | Collects quantity, avg weight, quality class, price/kg, buyer, notes — all persisted. But ten DTO fields have no write path (PRODUCT-FORM-HIGH-003) and the policy-mandatory `harvestPlanId` has no input at all, so harvests above 10 t / 50 k fish cannot be recorded (PRODUCT-FORM-HIGH-004). The UI computes an 'Estimated Value' that is never sent; totalRevenue is server-derived from pricePerKg. |
| **PARTIAL**     | Stock movement wizard IN/OUT/WASTE (recordStockMovement)                                                | Seven-step wizard captures itemType, item, quantity, location (mapped to from/toLocationId by direction), lotNumber, expiryDate and a WASTE reason; all persist. The DTO's `reference` (supplier invoice) and `movementDate` (FEFO as-of) have no input, and the idempotency key is re-minted per attempt.                                                                                                |
| **PARTIAL**     | Stock transfer wizard (transferStock)                                                                   | Captures itemType, item, from/to location and quantity. The DTO's `lotNumber`, `reference` and `reason` have no input, so a mobile inter-warehouse transfer records no rationale and no lot selection; idempotency key re-minted per attempt.                                                                                                                                                             |
| **PARTIAL**     | Task lifecycle: start / complete / checklist set                                                        | All three carry the mandatory at-most-once envelope, share one clientCommandId across the online attempt and the offline replay, and the checklist SET sends an absolute target so replays converge. Undermined by the blanket catch that turns server rejections into a fake queued success.                                                                                                             |
| **PARTIAL**     | Task note add                                                                                           | Online-only by design and honestly surfaced (input disabled with a WifiOff hint offline, hook throws rather than pretending). It carries no command envelope, so a lost-response retry can duplicate a note.                                                                                                                                                                                              |
| **PARTIAL**     | Two-phase success UX (QueuedStatusBadge / duplicate detection)                                          | Cull/mortality/harvest/transfer/leave/attendance/task correctly show real queue status and an 'Already recorded' notice on a deduped double-tap. Water quality, stock movement, stock transfer and feeding still render an unconditional green checkmark, which is what makes PRODUCT-FORM-CRITICAL-001 invisible to the operator.                                                                        |
| **IMPLEMENTED** | Lice count field capture (recordLiceCount)                                                              | Three lice stages as decimals, fishSampled, optional sea temperature, notes and up to 10 evidence photos all reach LiceCountService, which upserts on (tenant, tank, countDate) and derives ISO year/week. Only caveat is the UTC-day countDate (PRODUCT-FORM-MEDIUM-010).                                                                                                                                |
| **IMPLEMENTED** | Messaging writes (sendMessage / editMessage / deleteMessage / markRead / createChannel / channel admin) | Text sends carry a client idempotencyKey and fall back to the single offline queue; the binary lane persists blobs separately and replays presign→PUT→send with a stable key. Channel create/leave/archive/add-member and notification preference are online-only mutations with cache invalidation.                                                                                                      |
| **IMPLEMENTED** | Offline queue write substrate (tenant isolation, encryption, envelope, replay)                          | Payloads are AES-GCM encrypted with a non-extractable IndexedDB key, keyed `pending_<tenantId>_<id>` so cross-tenant replay is structurally impossible, and the SW closed-app lane drains only the tenant its refresh cookie resolves to under a shared Web Lock. Every op is stamped with clientCommandId/payloadHash/deviceId at enqueue.                                                               |
| **IMPLEMENTED** | Post-write visibility (optimistic KPI bump \+ post-sync invalidation)                                   | A fresh enqueue optimistically bumps the tenant-scoped hub KPI aggregates (deduped submissions do not double-count), and a successful drain invalidates the query keys for exactly the op types the server confirmed, so DB-committed data appears without waiting for staleTime.                                                                                                                         |
| **IMPLEMENTED** | Record Cull form (recordCull)                                                                           | Collects tank, quantity, 7-value cull reason, notes; sends batchId/tankId/quantity/reason/notes/culledAt. Field-for-field match with RecordCullInput. `detail`, `avgWeightG`, `biomassKg` are backend-optional and uncollected.                                                                                                                                                                           |
| **IMPLEMENTED** | Record Feeding / meal pour (recordMealFeeding)                                                          | Meal-centric capture: unit → meal → pourKg → finalize checkbox → method → notes. Every collected field exists on RecordMealFeedingInput and MealExecutionService persists feedingMethod/notes/finalize. The legacy `recordFeeding` op with `feederEquipmentId` remains only as a drain-window replay path.                                                                                                |
| **IMPLEMENTED** | Record Mortality form (recordMortality)                                                                 | Collects tank, quantity (stepper), reason (13-value grid matching the backend enum), notes; sends batchId/tankId/quantity/reason/notes/observedAt. All land on RecordMortalityInput and the envelope is stamped at enqueue. Backend-optional `detail`, `avgWeightG` and `biomassKg` (the D-3 mode-b large-fish path) have no mobile input, so mode-b mortality cannot be recorded from the field.         |
| **IMPLEMENTED** | Record Transfer form (transferBatch)                                                                    | Two-step confirm flow; sends batchId/sourceTankId/destinationTankId/quantity/avgWeightG/transferReason/transferredAt, bound to the TransferInput SSoT type so a re-introduced `biomassKg` is a compile error. Backend `notes` and `skipCapacityCheck` are uncollected (correctly — the override is an admin surface).                                                                                     |
| **IMPLEMENTED** | Regulatory report review \+ submit (approveAndSubmitReportDraft)                                        | Read-and-approve only — no field editing on mobile by design; submission is gated on isOnline, a submittable status, schemaValid and zero blocking fields, and invalidates both drafts and deadlines on success. Corrections flow through the field-capture forms, which matches the backend's single-submission-path model.                                                                              |
| **IMPLEMENTED** | Role/feature gating on write CTAs                                                                       | The harvest CTA is gated on BOTH the 'harvest' mobile feature flag and a `MODULE_MANAGER` role floor, matching the resolver's @Roles \+ @RequiresMobileFeature, so a `MODULE_USER` cannot reach a form whose submission would 403 after the success screen. Covered by an invariant spec.                                                                                                                 |
| **IMPLEMENTED** | Server-derived identity on mobile writes                                                                | tenantId and the acting user are taken from JWT decorators on every mutation the app calls; the harvest DTO explicitly removed a client-supplied `harvestedBy` so attribution spoofing is structurally impossible, and no aquamobil payload carries a tenantId or userId.                                                                                                                                 |
| **IMPLEMENTED** | Transactionality \+ audit/outbox obligations on mobile writes                                           | Harvest, escape, welfare, lice and leave all write inside runInTenantTransaction (or a QueryRunner transaction) with the mobile-command receipt begin/complete pair and, where a domain event exists, an outbox enqueue before commit — so a replayed queued op returns the original row instead of double-filing.                                                                                        |
| **IMPLEMENTED** | Welfare assessment (recordWelfareAssessment)                                                            | Four 0–3 score dials, fishSampled, notes, photos — every field is declared on RecordWelfareAssessmentInput and written by WelfareAssessmentService inside a tenant transaction with a mobile-command receipt for replay dedup.                                                                                                                                                                            |

## Verdict

BLOCK

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/form-write-auditor.md`
- Rule SSoT: `CLAUDE.md`
