# farm-service ↔ AquaMobil contract parity audit — 2026-08-16

**Agent:** `contract-parity-enforcer` · **Mode:** CATCHER (read-only) · **Lane:** cross
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** CONDITIONAL
**Findings surviving verification:** 6 (CRITICAL 0 · HIGH 1 · MEDIUM 5 · LOW 0) · 4 refuted

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** use the `PARITY-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Scope

Read CLAUDE.md (root \+ web/, web/apps/aquamobil/, apps/farm-service/ nested),
.claude/shared/output-format.md, .claude/shared/tier-claim-syntax.md,
.claude/knowledge/layer-2-defect-catalog.md. Contract surfaces: codegen.ts,
infrastructure/apollo-router/codegen-schema.generated.json, tools/scripts/emit-subgraph-sdl.ts,
apps/farm-service/schema.graphql (spot-read), and the farm-service GraphQL type surface (130
@ObjectType files enumerated; read storage/dto/warehouse-summary.response.ts,
farm-stock/dto/farm-stock-inventory.dto.ts, feeding-protocol/dto/meal-execution.results.ts,
feeding-protocol/entities/feeding-day-plan.entity.ts, task/entities/task.entity.ts,
task/resolvers/task.resolver.ts, task/services/task.service.ts). Client side: all 6 files in
web/apps/aquamobil/src/graphql, src/generated/graphql.ts, src/services/authenticated-fetch.ts,
src/pwa/operation-registry.ts, src/types/index.ts, src/utils/farm-realtime-invalidation.ts (+ its
spec), hooks useTanks/useWarehouseSummary/useStockEventsSummary/useDailyOpsStats, pages
RecordFeedingPage/TaskDetailPage/StorageHubPage. Gates:
.github/workflows/{graphql-codegen-validate,apollo-supergraph-validate,ci-affected}.yml,
scripts/ci/validate-graphql-operations.mjs \+ graphql-fe-drift.baseline.json,
scripts/ci/check-graphql-contract-drift.mjs, eslint.config.mjs override 12,
tools/eslint-rules/rules/no-bare-graphql-query-string.ts,
tests/invariants/{farm-graphql-fe-be-parity,farm-graphql-enum-parity,dead-contract-fe-operations}.spec.ts.
Cross-check: apps/gateway-api/src/websocket/farm.gateway.ts,
docs/architecture/ADR-farm-api-contract-posture.md, docs/api/openapi/.

## Executive summary

The document-to-schema axis is genuinely well gated: scripts/ci/validate-graphql-operations.mjs
validates every backtick GraphQL document under web/apps against the freshly composed supergraph and
its drift baseline is currently ZERO; the aquamobil codegen output is complete (67 operations in
src/graphql, 67 generated result types) and diffed in CI. Codegen is NOT stale.

The failure is on the axes nothing checks. (1) Both GraphQL CI workflows are path-filtered on
filename suffix, and ~30 farm-service files that define @ObjectTypes use suffixes that match no
trigger — including meal-execution.results.ts, which types the offline-queued recordMealFeeding
reply, and warehouse-summary.response.ts. A backend-only PR touching them skips both gates. (2)
aquamobil is exempted from no-bare-graphql-query-string on a written premise that is false:
graphqlRequest has a second overload accepting a bare DocumentNode with a hand-pinned result type,
used at ~68 of ~90 call sites, and 55 of its 122 documents live outside the codegen glob. (3) The
41-name farm WebSocket event vocabulary is hand-mirrored as 30 names on mobile with no gate; unknown
events are a silent no-op by design. (4) Task.checklistItems is an untyped JSON scalar whose
required client fields are optional server-side and normalised only on write.

## Findings (by severity)

### HIGH

### PARITY-LOW-010

**Title:** Mobile-shaped response DTOs expose domain enums as GraphQL `String!`, and the client
silently narrows them back to closed TS unions with no runtime validation

**Severity:** HIGH (filed as LOW, raised by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PARITY-LOW-010` by `contract-parity-enforcer` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- /home/user/aquaculture_platform/apps/farm-service/src/storage/dto/warehouse-summary.response.ts:30-32
  — `@Field() itemType!: string`; :61-62 `@Field() movementType!: string`; :93-95
  `@Field() coverageStatus!: string`
- /home/user/aquaculture_platform/web/apps/aquamobil/src/types/index.ts:691 —
  ; :707
  `movementType: StockMovementType`

  ```text
  coverageStatus: 'critical' | 'warning' | 'ok'`; :698 `itemType: StorageItemType
  ```

- /home/user/aquaculture_platform/web/apps/aquamobil/src/types/index.ts:664 —
  `StockEvent.type: 'CULL' | 'HARVEST' | 'TRANSFER' | 'MORTALITY'` against the generated
  `type: string` (generated/graphql.ts:817)
- /home/user/aquaculture_platform/web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx:215-216 —
  filters on `c.coverageStatus !== 'ok'`, a comparison the schema cannot guarantee is exhaustive

**Rule violated:**

layer-2-defect-catalog 'Enum / string mismatch'; CLAUDE.md 'Missing field → add the @Column \+ DTO
field' (fix the contract, not the consumer)

**Proposed fix direction:**

Declare these three as registerEnumType GraphQL enums on the response DTO so the SDL carries the
vocabulary and codegen emits the union; the client then imports it rather than re-asserting one.
Same treatment for the stockEventsSummary `type` field. This also removes the need for any future
entry in the enum-parity registry for these fields.

**Affected surface (ripple set):**

```text
/home/user/aquaculture_platform/apps/farm-service/src/storage/dto/warehouse-summary.response.ts
```

```text
/home/user/aquaculture_platform/apps/farm-service/src/storage/storage.resolver.ts
```

- `/home/user/aquaculture_platform/web/apps/aquamobil/src/types/index.ts`

  ```text
  /home/user/aquaculture_platform/web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx
  ```

**Expected closer:**

farm-service domain expert WRITER mode

**Verifier note:**

Real, and materially UNDER-severity — this is a live client crash, not a missing-validation nit.
Line numbers are slightly off but the substance holds: warehouse-summary.response.ts:32
`itemType!: string`, :54 `movementType!: string`, :95 `coverageStatus!: string` (claim said 61-62
and 93-95); apps/farm-service/schema.graphql:2277-2284 confirms `movementType: String!` on the wire.
The FE narrows them at web/apps/aquamobil/src/types/index.ts:698 `itemType: StorageItemType`, :707
, and :664
StockEvent.type, with StockMovementType = 'IN'|'OUT'|'WASTE' and StorageItemType =
'FEED'|'CHEMICAL'|'CONSUMABLE'|'HEALTHCARE' at :579-580. What the claimer stopped short of: the wire
values do NOT match the narrowed unions today. stock-movement.entity.ts:14-21 defines MovementType
with LOWERCASE values (IN='in', OUT='out', TRANSFER='transfer', WASTE='waste',
ADJUSTMENT='adjustment', RETURN='return'), stored in a plain varchar column (:43-44) and written as
MovementType.OUT/.IN/.TRANSFER/.ADJUSTMENT by feeding-ledger.service.ts:253,
meal-execution.service.ts:562,595, transfer-stock.handler.ts:167,
approve-inventory-count.handler.ts:83, receive-delivery.handler.ts:107.
get-warehouse-summary.handler.ts:305-322 reads them with getMany() and passes
`movementType: m.movementType` straight through; because the DTO field is String (not the registered
MovementType enum) GraphQL performs NO `value->key` mapping, so the client receives
'in'/'out'/'transfer'. StorageHubPage.tsx:74-98 keys MOVEMENT_TYPE_CONFIG on UPPERCASE
'IN'/'OUT'/'WASTE' and :158-159 does
with no
fallback — undefined lookup, TypeError during render, for EVERY recent movement. StorageHubPage is a
live lazy route (App.tsx:84-85, 262, 423), so the warehouse hub's activity feed blows up as soon as
any stock movement exists. Same lowercase mismatch on itemType (handler:212,241,270 emit
'feed'/'chemical'/'consumable' against a 'FEED'|... union) — type lie only, since LowStockRow never
reads it. The other two cited fields are the benign ones: coverageStatus is computed as literal
'critical'/'warning'/'ok' in the handler (:118-124) so it genuinely matches, and stockEventsSummary
type is deliberately uppercased by get-stock-events-summary.handler.ts:72-85 with only a
`default: operationType.toUpperCase()` escape that could leak an out-of-union value into a
non-crashing `type === 'TRANSFER'` count. The one FE test touching this field
(`pwa/**tests**/offline-queue.spec.ts:386`) mocks 'OUT' uppercase, which is exactly why the mismatch
shipped. Filed as LOW; the movementType half is a shipped runtime crash of the same casing class the
repo already logged as FARM-CRITICAL-165, so HIGH.

```text
movementType: StockMovementType`, :691 `coverageStatus: 'critical'|'warning'|'ok'
```

```text
const config = MOVEMENT_TYPE_CONFIG[movement.movementType]; const Icon = config.icon;
```

### MEDIUM

### PARITY-MEDIUM-001

**Title:** Both GraphQL contract CI gates are path-filtered by filename suffix and miss ~30
farm-service files that define @ObjectType schema surface (incl. the offline-feeding reply type)

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 3
**State:** OPEN
**Raised as:** `PARITY-HIGH-001` by `contract-parity-enforcer` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- /home/user/aquaculture_platform/.github/workflows/apollo-supergraph-validate.yml:40-48 — PR
  triggers are only
  ''

  ```text
  *.resolver.ts','*.entity.ts','*.model.ts','*.dto.ts','*.input.ts','*.type.ts','*.args.ts','*.object.ts','*.enum.ts
  ```

- /home/user/aquaculture_platform/.github/workflows/graphql-codegen-validate.yml:50-58 — identical
  suffix list; the codegen freshness diff never runs otherwise
- /home/user/aquaculture_platform/apps/farm-service/src/feeding-protocol/dto/meal-execution.results.ts:28
  — @ObjectType('MealFeedingResult') — return type of recordMealFeeding, the OFFLINE-QUEUED feeding
  mutation; '.results.ts' matches no trigger
- /home/user/aquaculture_platform/apps/farm-service/src/storage/dto/warehouse-summary.response.ts:102
  — @ObjectType WarehouseSummaryResponse, served by storage.resolver.ts:346; '.response.ts' matches
  no trigger
- /home/user/aquaculture_platform/.github/workflows/ci-affected.yml:724-764 — the unconditional
  pre-flight job runs neither build-supergraph.mjs nor validate-graphql-operations.mjs

**Rule violated:**

CLAUDE.md Architectural Approach Tier-3 'make it detectable' — a detection gate that a legal PR
shape can skip is not a gate. ADR-farm-api-contract-posture.md:28 'Frontend codegen and gateway
composition must fail on schema drift.'

**Proposed fix direction:**

Stop keying schema-surface detection on filename convention. Either (a) trigger both workflows on
'`apps/**/*.ts`' and let Nx affected keep the cost down, or (b) make the trigger derivable: have
emit-subgraph-sdl.ts write the set of source files it actually imported into the registry artifact,
and generate the workflow path list from it so the filter cannot drift from the real schema surface.
Tier-2 (automatic) beats extending the hand-maintained suffix list, which is the same defect one
level up.

**Affected surface (ripple set):**

```text
/home/user/aquaculture_platform/.github/workflows/apollo-supergraph-validate.yml
```

- `/home/user/aquaculture_platform/.github/workflows/graphql-codegen-validate.yml`

  ```text
  /home/user/aquaculture_platform/scripts/graphql/generate-registry-artifacts.mjs
  ```

- `/home/user/aquaculture_platform/tools/scripts/emit-subgraph-sdl.ts`
- `/home/user/aquaculture_platform/apps/farm-service/src/**/dto/*.response.ts`

  ```text
  /home/user/aquaculture_platform/apps/farm-service/src/feeding-protocol/dto/*.results.ts
  ```

**Expected closer:**

infra-expert WRITER mode (workflow triggers) with contract-parity-enforcer review; the
registry-derived variant needs data-expert on generate-registry-artifacts.mjs

**Verifier note:**

Factually confirmed. apollo-supergraph-validate.yml:11-59 and graphql-codegen-validate.yml:20-66
both path-filter on the same 9 filename suffixes
(`*.resolver/entity/model/dto/input/type/args/object/enum.ts`) plus libs/backend-common and web/**.
I enumerated farm-service files carrying @ObjectType that match NO trigger suffix: 34 files,
including apps/farm-service/src/feeding-protocol/dto/meal-execution.results.ts:28
(@ObjectType('MealFeedingResult')) and
apps/farm-service/src/storage/dto/warehouse-summary.response.ts:102, plus the whole `*.response.ts`
family (storage, site, equipment, batch, feed, department, system, supplier). The ci-affected.yml
pre-flight job (line ~724+) runs only scripts/graphql/validate-registry.mjs,
generate-registry-artifacts.mjs and check-graphql-contract-drift.mjs — I read the latter
(scripts/ci/check-graphql-contract-drift.mjs): it is a hardcoded string-scan of
SettingsPage/settings.operations/two storage pages plus a REPORT-ONLY raw-gql walk (gated behind
GRAPHQL_RAW_STRING_GATE=error, unset). It never composes the supergraph and never runs codegen. grep
across all 49 workflows confirms build-supergraph.mjs / emit-subgraph-sdl /
validate-graphql-operations.mjs appear ONLY in those two path-filtered workflows — ci-full.yml and
deploy-digitalocean.yml contain zero references. So a backend-only PR editing just a `*.response.ts`
is a legal shape that skips composition validation, FE-operation validation and codegen freshness.
Severity corrected to MEDIUM, not HIGH: this is a latent detection hole with no demonstrated live
defect; the affected files are plain response DTOs (not @key federation entities, so composition
breakage from them is unlikely), and the realistic escape is a stale generated client type, not a
router outage. The ADR is also miscited — the file is
docs/architecture/ADR-farm-api-contract-posture.md, not docs/adr/.

### PARITY-MEDIUM-005

**Title:** Pages re-declare hand-written mirrors of an already-generated query type, and the mirrors
disagree with the schema on nullability (`meals`)

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PARITY-MEDIUM-005` by `contract-parity-enforcer` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- /home/user/aquaculture_platform/web/apps/aquamobil/src/generated/graphql.ts:660 —
  FeedingDayPlansQuery types `meals: Array<{…}> | null`
- /home/user/aquaculture_platform/apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts:216-217
  — `@Field(() => [FeedingMeal], { nullable: true }) meals?: FeedingMeal[]`
- /home/user/aquaculture_platform/web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx:60-82 —
  local
  (widened from FeedingDayPlanStatus); header calls itself 'feedingDayPlans tipli sorgusunun aynası'

  ```text
  FeedingDayPlanSlice` declares `meals: DayPlanMeal[]` (non-nullable) and `status: string
  ```

- /home/user/aquaculture_platform/web/apps/aquamobil/src/hooks/useDailyOpsStats.ts:16-17 — a SECOND
  mirror, `interface FeedingDayPlanSlice { meals: DayPlanMealSlice[] }`, of the same query
- /home/user/aquaculture_platform/web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx:210 and
  useDailyOpsStats.ts:93 — both consumers write `?? []`, the defensive guard that exists only
  because the mirror lies about nullability

**Rule violated:**

CLAUDE.md 'No workarounds, patches, defensive ?.'; layer-2-defect-catalog 'Duplication / DRY'

**Proposed fix direction:**

Delete both mirrors and consume `FeedingDayPlansQuery['feedingDayPlans'][number]` from the generated
module (the TypedDocumentNode is already declared at operations.ts:91). The nullable `meals` then
propagates into the consumers as a type obligation instead of a `?? []` that hides it.

**Affected surface (ripple set):**

```text
/home/user/aquaculture_platform/web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx
```

```text
/home/user/aquaculture_platform/web/apps/aquamobil/src/hooks/useDailyOpsStats.ts
```

- `/home/user/aquaculture_platform/web/apps/aquamobil/src/generated/graphql.ts`

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Holds. web/apps/aquamobil/src/generated/graphql.ts:660 types FeedingDayPlansQuery.meals as
`Array<{...}> | null` and status as the `FeedingDayPlanStatus` union (graphql.ts:109-114);
apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts:216-217 is
`@Field(() => [FeedingMeal], { nullable: true })`. RecordFeedingPage.tsx:60-82 does re-declare
, and
useDailyOpsStats.ts:17 is a second independent mirror of the same query. Both bypass the generated
type by calling the explicit-result overload of graphqlRequest (RecordFeedingPage.tsx:159,
useDailyOpsStats.ts:49) even though GET_FEEDING_DAY_PLANS is a real TypedDocumentNode
(operations.ts:91) — the exact overload whose own docblock (authenticated-fetch.ts:290-302) reserves
it for hand-authored view types or documents not in the codegen pluck set. No invariant covers this
(farm-graphql-enum-parity.spec.ts excludes aquamobil), so a selection-set change would leave both
mirrors silently stale. Two corrections to the claim, which is why I would not raise it: (a) the
`?? []` at RecordFeedingPage.tsx:210 is `selectedPlan?.meals ?? []` and is required because
`Array.find` can return undefined, not because the mirror lies about nullability — only
useDailyOpsStats.ts:93 is the guard the claim describes; (b) there is no live runtime defect,
because meal-execution.resolver.ts:107 does `plan.meals = mealsByPlan.get(plan.id) ?? []` on every
plan, so meals is never actually null, and the local MealStatus union matches FeedingMealStatus
value-for-value. Real DRY/type-erosion defect a maintainer will hit; MEDIUM is the right size.

```text
FeedingDayPlanSlice` with `meals: DayPlanMeal[]` (non-null) and `status: string
```

### PARITY-MEDIUM-006

**Title:** apps/farm-service/schema.graphql is a committed 12k-line SDL snapshot with no freshness
gate, yet two invariant specs and the MCP client assert against it

**Severity:** MEDIUM
**Layer:** 3
**State:** OPEN
**Raised as:** `PARITY-MEDIUM-006` by `contract-parity-enforcer` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- /home/user/aquaculture_platform/tools/scripts/emit-subgraph-sdl.ts:103-110 — the snapshot is
  rewritten only as a side effect of an SDL emit run
- /home/user/aquaculture_platform/.github/workflows/graphql-codegen-validate.yml:119-138 — the git
  diff --exit-code steps cover only web/apps/aquamobil/src/generated and
  web/shared-ui/src/generated; no workflow in .github/workflows references
  apps/farm-service/schema.graphql
  — a contract spec reads the snapshot as its schema authority

  ```text
  /home/user/aquaculture_platform/apps/farm-service/src/weather/**tests**/legacy-weather-settings.contract.spec.ts:32
  ```

- /home/user/aquaculture_platform/tests/invariants/farm-environment-deployment-contract.spec.ts:603
  — a second invariant reads it
- /home/user/aquaculture_platform/docs/architecture/ADR-farm-api-contract-posture.md:27 — declares
  the snapshot the committed SDL of record

**Rule violated:**

ADR-farm-api-contract-posture.md ('SDL is generated from code-first resolver metadata and
committed'); CLAUDE.md Tier-3 make-it-detectable

**Proposed fix direction:**

Add apps/farm-service/schema.graphql to the git diff --exit-code assertion in
graphql-codegen-validate.yml (the compose step already regenerates it), so a stale snapshot fails
RED. That is one line and makes the two specs that trust it honest; alternatively drop the snapshot
and repoint those specs at dist/graphql/subgraphs/farm.graphql so there is only one SDL copy.

**Affected surface (ripple set):**

- `/home/user/aquaculture_platform/.github/workflows/graphql-codegen-validate.yml`
- `/home/user/aquaculture_platform/apps/farm-service/schema.graphql`

  ```text
  /home/user/aquaculture_platform/apps/farm-service/src/weather/**tests**/legacy-weather-settings.contract.spec.ts
  ```

  ```text
  /home/user/aquaculture_platform/tests/invariants/farm-environment-deployment-contract.spec.ts
  ```

- `/home/user/aquaculture_platform/mcp/farm-management/src`

**Expected closer:**

contract-parity-enforcer-owned; infra-expert WRITER mode for the workflow edit

**Verifier note:**

Holds. tools/scripts/emit-subgraph-sdl.ts:106-109 writes apps/farm-service/schema.graphql only as a
side effect of an SDL emit run (`if (existsSync(committedSnapshotPath)) writeFileSync(...)`), and
scripts/apollo-router/build-supergraph.mjs:54-69 does spawn that emitter per subgraph, so CI
regenerates the snapshot. But I grepped every `git diff/git status` assertion across
.github/workflows: graphql-codegen-validate.yml:102/120/133 covers only
infrastructure/apollo-router/codegen-schema.generated.json, web/apps/aquamobil/src/generated and
web/shared-ui/src/generated; ci-affected.yml:758 covers only the three registry artifacts. Nothing
asserts the farm snapshot, so a stale copy never fails RED. Meanwhile two specs treat it as schema
authority —
makes NEGATIVE assertions (`expect(schema).not.toMatch(/WeatherSettings/)`) that a stale snapshot
would pass falsely, and tests/invariants/farm-environment-deployment-contract.spec.ts:601-615 makes
a positive `expect(schema).toContain('activeSites: [SiteResponse!]!')`.
docs/architecture/ADR-farm-api-contract-posture.md:27 does declare the snapshot the committed SDL of
record. codegen.ts:16 also names it as the fallback schema source when the composed supergraph is
absent. scripts/v11-upgrade/check-codegen.sh references these snapshots but is an unwired one-off
migration script (its SCHEMA_FILES list describes a codegen.ts `schema` array that no longer
exists), so it is not a gate. Genuine Tier-3 detection hole; the one-line fix the claim proposes is
correct since compose already regenerates the file.

```text
apps/farm-service/src/weather/**tests**/legacy-weather-settings.contract.spec.ts:32-39
```

### PARITY-MEDIUM-007

**Title:** codegen maps the JSON scalar to `Record<string, unknown>`, which cannot express the
array-valued JSON fields the schema actually serves, forcing every JSON consumer onto the hand-typed
path

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PARITY-MEDIUM-007` by `contract-parity-enforcer` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- /home/user/aquaculture_platform/codegen.ts:63-65 and :93-96 —
  `scalars: { DateTime: 'string', JSON: 'Record<string, unknown>' }` in both outputs
- /home/user/aquaculture_platform/web/apps/aquamobil/src/generated/graphql.ts:724 — GetMyTasksQuery
  emits

  ```text
  checklistItems: Record<string, unknown> | null, notes: Record<string, unknown> | null
  ```

- /home/user/aquaculture_platform/apps/farm-service/src/task/entities/task.entity.ts:222,226 — the
  runtime values are `TaskChecklistItem[]` and `TaskNote[]`, i.e. arrays
- /home/user/aquaculture_platform/web/apps/aquamobil/src/hooks/useMyTasks.ts:67 — the hook
  consequently pins `{ myTasks: Task[] }` by hand rather than using the generated type

**Rule violated:**

layer-2-defect-catalog 'Type-system erosion' and 'Enum / string mismatch'; CLAUDE.md 'Interface/type
mismatch → fix the interface or implementation'

**Proposed fix direction:**

Map JSON to `unknown` in codegen.ts so consumers are forced to narrow at the boundary instead of
silently inheriting a wrong object type — and prefer eliminating the JSON scalars entirely on
modelled payloads (see PARITY-HIGH-004). A scalar mapping that is wrong for the repo's actual JSON
values is worse than no mapping, because it type-checks.

**Affected surface (ripple set):**

- `/home/user/aquaculture_platform/codegen.ts`
- `/home/user/aquaculture_platform/web/apps/aquamobil/src/generated/graphql.ts`
- `/home/user/aquaculture_platform/web/shared-ui/src/generated/graphql-types.ts`
- `/home/user/aquaculture_platform/web/apps/aquamobil/src/hooks/useMyTasks.ts`

**Expected closer:**

contract-parity-enforcer-owned; frontend-expert WRITER mode for downstream narrowing

**Verifier note:**

Holds. codegen.ts:62-65 and :92-96 both set
`scalars: { DateTime: 'string', JSON: 'Record<string, unknown>' }`. generated/graphql.ts:724 emits
(and :729
the same for GetTodaysTasksQuery), while apps/farm-service/src/task/entities/task.entity.ts:220-226
declares
over `jsonb default []` — arrays. I confirmed with tsc --strict that an array is NOT assignable to
`Record<string, unknown>` (TS2322, 'Index signature for type string is missing'), so the generated
type is structurally wrong for the values the resolver serves and offers no `.map`. That is why
useMyTasks.ts:67 pins `graphqlRequest<{ myTasks: Task[] }>` by hand against the hand-written Task in
types/index.ts:490-492, dropping the operation off the generated contract. Real type-system erosion
with a concrete consequence (the generated type is unusable for these fields); MEDIUM is right. It
is partly downstream of the JSON-scalar decision filed as PARITY-HIGH-004, but the mapping choice
itself is a separate, independently fixable defect.

```text
checklistItems: Record<string, unknown> | null, notes: Record<string, unknown> | null
```

```text
@Field(() => GraphQLJSON) checklistItems!: TaskChecklistItem[]` and `notes!: TaskNote[]
```

### PARITY-MEDIUM-009

**Title:** aquamobil hand-duplicates GraphQL enums that already exist in its own generated module,
and the enum-parity invariant excludes aquamobil on a stated premise that only holds for src/graphql

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PARITY-MEDIUM-009` by `contract-parity-enforcer` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- /home/user/aquaculture_platform/web/apps/aquamobil/src/types/index.ts:459-461 — hand-written
  TaskCategory / TaskPriority / TaskStatus unions
- /home/user/aquaculture_platform/web/apps/aquamobil/src/generated/graphql.ts:325-336,355-367 — the
  identical enums already generated from the supergraph
- /home/user/aquaculture_platform/web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx:42,96 —
  a second hand-written `MealStatus` union driving `MEAL_BADGE: Record<MealStatus, string>`,
  duplicating generated FeedingMealStatus (graphql.ts:117-124)
- /home/user/aquaculture_platform/tests/invariants/farm-graphql-enum-parity.spec.ts:5-6,38-39 —
  scope is apps/farm-service/src/regulatory ↔ web/modules/farm-module/src only, justified by 'it is
  not yet codegen-backed like aquamobil'
- /home/user/aquaculture_platform/tests/invariants/farm-graphql-enum-parity.spec.ts:10-14 — records
  the prior production failure this class caused (FARM-CRITICAL-165, wrong enum casing killed two
  report flows)

**Rule violated:**

layer-2-defect-catalog 'Enum / string mismatch' \+ 'Duplication / DRY'; CLAUDE.md Tier-1
make-it-impossible

**Proposed fix direction:**

Re-export the generated enum unions from web/apps/aquamobil/src/types instead of re-declaring them,
and delete the RecordFeedingPage MealStatus copy. The values match today, so this is a pure
deduplication with no behaviour change — and it removes the only reason aquamobil would ever need an
entry in the enum-parity registry.

**Affected surface (ripple set):**

- `/home/user/aquaculture_platform/web/apps/aquamobil/src/types/index.ts`

  ```text
  /home/user/aquaculture_platform/web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx
  ```

- `/home/user/aquaculture_platform/web/apps/aquamobil/src/generated/graphql.ts`

  ```text
  /home/user/aquaculture_platform/tests/invariants/farm-graphql-enum-parity.spec.ts
  ```

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Every cited line checks out. web/apps/aquamobil/src/types/index.ts:459-461 hand-declares
TaskCategory/TaskPriority/TaskStatus; web/apps/aquamobil/src/generated/graphql.ts:324-336
(TaskCategory), :353-357 (TaskPriority), :359-365 (TaskStatus) already emit the identical value sets
from the composed supergraph, and codegen.ts declares web/apps/aquamobil/src/generated/graphql.ts as
the aquamobil client-contract SSoT. web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx:42
declares a second hand-written
that exactly
duplicates generated FeedingMealStatus (graphql.ts:118-124), consumed by MEAL_BADGE at :96.
tests/invariants/farm-graphql-enum-parity.spec.ts:5-6 does justify its scope with 'it is not yet
codegen-backed like aquamobil' and :38-39 pins BE/FE to apps/farm-service/src/regulatory and
web/modules/farm-module/src only; :10-14 records FARM-CRITICAL-165. I looked for a guard the claimer
missed and found none: no invariant under tests/invariants covers web/apps/aquamobil/src/types
(shared-contracts-no-enum-drift.spec.ts only bans enums in libs/shared-contracts). The drift is also
genuinely undetectable at compile time — useMyTasks.ts:69 calls `graphqlRequest<{` myTasks: Task[]
`}>(GET_MY_TASKS`), an explicit generic that overrides the TypedDocumentNode result type, so the
generated and hand-written unions never meet the type checker. types/index.ts:11-12 already
re-exports Role from '../generated/graphql', proving the proposed fix is the file's own established
pattern. Today's impact is latent, not live: values match and the consumers degrade softly
(PRIORITY_BADGE is guarded by `badge &&` at DailyOpsHubPage.tsx:94; MEAL_BADGE feeds clsx which
tolerates undefined). But drift would silently break filter logic (useMyTasks.ts:34-43 compares
t.status against 'COMPLETED'/'CANCELLED'/'OVERDUE'; RecordFeedingPage isMealOpen compares
'SCHEDULED'/'PARTIALLY_FED'). MEDIUM as filed is right.

```text
type MealStatus = 'SCHEDULED'|'FED'|'PARTIALLY_FED'|'SKIPPED'|'MISSED'|'CANCELLED'
```

## Refuted by adversarial verification

These did **not** survive independent re-checking. They are recorded so the same
claim is not re-raised next cycle.

### ~~PARITY-HIGH-002~~

**Title:** aquamobil is exempted from no-bare-graphql-query-string on a factually false premise; ~68
call sites pin hand-written result types and 55 of 122 documents sit outside the codegen glob

**Raised as:** HIGH · **Result:** REFUTED

The sub-facts are true but the risk framing is refuted by a gate the claimer missed. Confirmed:
eslint.config.mjs:520-544 exempts web/apps/aquamobil/** and its comment does overclaim —
authenticated-fetch.ts:312-315 really is a second overload `graphqlRequest<TResult>(document`:
DocumentNode, variables?: `Record<string`, `unknown>`), so 'ONLY TypedDocumentNode / compile error /
tier-1 impossible' is inaccurate. Confirmed codegen.ts:47 documents glob is only
`web/apps/aquamobil/src/graphql/**/*.ts`. BUT: (a) the exempted rule is registered at 'warn', not
'error' (eslint.config.mjs:545) — the exemption suppresses a warning, not a blocking gate; (b) the
documents cited as unprotected ARE schema-validated. scripts/ci/validate-graphql-operations.mjs
scans SCAN_ROOTS = ['web/modules','web/apps','web/shell','web/shared-ui','mcp'] with OP_RE over
every template literal and runs graphql.validate() against the freshly composed supergraph, with
tests/invariants/graphql-fe-drift-baseline-no-grow.spec.ts locking BASELINE_CEILING = 0. That covers
operation-registry.ts:31-267 raw template strings and useTanks.ts FARM_STOCK_INVENTORY_QUERY
verbatim, and apollo-supergraph-validate.yml runs it on every `web/**/*.ts` change. The
authenticated-fetch.ts doc comment (lines 296-302) already states exactly this. Residual real gap:
hand-written TS result interfaces are not machine-checked against the schema shape — a
documentation/typing weakness, LOW, not a HIGH contract hole.

### ~~PARITY-HIGH-003~~

**Title:** farm realtime WebSocket event vocabulary is a 41-vs-30 hand-mirrored contract typed as
bare `string`, with no parity gate and a spec that asserts unknown events are a silent no-op

**Raised as:** HIGH · **Result:** REFUTED

Counts are right, interpretation is not. farm.gateway.ts:195-201 does take eventName: string, with
41 emitFarmEvent literal call sites, and farm-realtime-invalidation.ts:19-49 is a 30-member union. I
diffed the two sets mechanically. The 11 gateway events absent from the client are exactly:
siteCreated, siteUpdated, siteDeleted, siteContactsChanged, departmentCreated/Updated/Deleted,
systemCreated/Updated/Deleted, supplierApprovedSitesChanged — i.e. precisely the
site/department/system/supplier management events the file comment (lines 12-14) declares
intentionally out of scope for a field-worker app. Zero farm-operational
(count/feeding/tank/equipment/meal) events are missing, so the '41-vs-30' framing describes
deliberate scope, not drift. The 'silent no-op' the spec pins (spec:49-56) is not a production path:
useFarmRealtimeSync.ts:71-72 registers socket.on ONLY for
Object.keys(FARM_REALTIME_INVALIDATION_SEGMENTS), so an unmapped event never reaches the
invalidator. Also 'typed as bare string' overstates: the public gateway API is 41 individually named
`broadcast*` methods; the string is a private helper parameter. Remaining truth: no mechanical
parity test (the two spec cases at lines 68-95 assert hardcoded subsets). That is a maintenance
drift risk if a future count-affecting event is added — LOW/MEDIUM at most, and no current defect.
Corrected to LOW.

### ~~PARITY-HIGH-004~~

**Title:** Task.checklistItems / Task.notes ship as untyped JSON scalars; the client's required
`id`/`isCompleted` are optional server-side and are normalised only on WRITE, so a legacy item sends
setChecklistItem an undefined itemId

**Raised as:** HIGH · **Result:** REFUTED

The crash mechanism does not exist. The cited failure — 'a legacy row yields itemId undefined and
task.service.ts:626-629 throws NotFoundException' — cannot occur as described:
apps/farm-service/src/task/dto/update-task.dto.ts:56-60 declares SetChecklistItemInput.itemId as a
NON-NULL @Field() with @IsNotEmpty() @IsString(), so an undefined itemId is rejected by GraphQL
variable coercion before the resolver (task.resolver.ts:241) is ever entered; the service
NotFoundException is unreachable on this path. Even then, TaskDetailPage.tsx:145-155 wraps the call
in try/catch and shows 'Failed to update checklist item' — a user-visible error, not a crash or
null-deref. The premise that id-less rows exist is also unsupported: task.service.ts:180 (create)
and :253 (update) both route through normaliseChecklistItems, and normaliseChecklistItem (:57-67)
assigns id: raw.id ?? randomUUID() to every item, and setChecklistItem (:621-624) re-normalises and
PERSISTS the whole array before the find — so the write paths already repair legacy shapes; the
entity comment at task.entity.ts:30-38 documents the legacy shape as the `completed` field, not a
missing id. Confirmed true but lesser: task.entity.ts:220-226 does expose checklistItems/notes as
GraphQLJSON, and web/apps/aquamobil/src/types/index.ts:463-468 declares id/isCompleted required — a
genuine typed-contract weakness (client gets no generated field types, hence the shape-guessing at
TaskDetailPage.tsx:233-239). That is a LOW/MEDIUM design smell, not a HIGH production defect; HIGH
is inflated.

### ~~PARITY-MEDIUM-008~~

**Title:** A codegen output was deleted and a client field-selection reduced, each justified by a
tracked finding ID (S1-ORPHAN, S1-ORPHAN-LEAVE-TYPE) that exists nowhere in the repo

**Raised as:** MEDIUM · **Result:** REFUTED

Refuted on its own central evidence bullet. The claim states the two IDs have 'no entry in
docs/reviews/orphan-findings.md'. They do — the claimer grepped only for the literal string
'S1-ORPHAN' and missed the canonical entries. docs/reviews/orphan-findings.md:4446 is
'ORPHAN-MEDIUM-111 — hr-module GraphQL fragments drift from the live schema (codegen-blocking)',
which names the exact drift codegen.ts:35-46 cites (Payroll.earnings/deductions,
PerformanceGoal.keyResults/milestones without subfields), records that the removed
shared-ui/graphql-operations.ts block was dead and never emitted, gives the architectural fix
direction, and closes 'Status: OPEN (2026-06-14; owner: frontend-expert → hr-module; tracked
follow-up)'. docs/reviews/orphan-findings.md:4465 is 'ORPHAN-LOW-107 — AquaMobil leave-balance rows
show a generic Leave label', which is precisely the operations.ts:214-220 gap, with 'Status: OPEN
(2026-06-14; owner: frontend-expert; tracked follow-up)'. So the governance control the claim says
'does not exist' does exist, with an owner and a fix direction, in the file the repo designates for
orphan findings (orphan-findings.md header: 'Purpose: problems spotted... NOT part of the current
plan. Append-only'; many neighbouring entries record 'Registry: orphan-findings.md only' as the
normal state, so absence from findings.jsonl is not a violation). The claim's framing that '342
farm-module operations have no result-type contract at all' as a consequence of the deletion is also
wrong: ORPHAN-MEDIUM-111 documents that the shell/module operations output NEVER produced a
committed file, so the deletion removed a dead block and changed nothing. What actually remains is a
cosmetic label mismatch — the two source comments use a shorthand ('S1-ORPHAN',
'S1-ORPHAN-LEAVE-TYPE') instead of the canonical ORPHAN-MEDIUM-111 / ORPHAN-LOW-107 IDs — which is a
comment-hygiene nit, not a MEDIUM traceability failure.

## Inventory — what exists / what is missing

| Status          | Area                                                                        | Note                                                                                                                                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Task checklist / notes field contract                                       | Both are GraphQLJSON scalars; the SDL carries no field contract for the item shape, so the client hand-writes ChecklistItem/TaskNote and shape-guesses at runtime. Server-side the fields are optional and repaired only on write.                                                                  |
| **MISSING**     | aquamobil ↔ farm-service root-field parity invariant                        | farm-graphql-fe-be-parity.spec.ts is hardcoded to web/modules/farm-module/src. aquamobil's only coverage is the path-filtered apollo workflow; there is no always-on PR invariant for the mobile client's root fields.                                                                              |
| **MISSING**     | farm-module generated GraphQL types / TypedDocumentNodes                    | 342 operations across 45 files with zero generated artifacts. The shell/module operations codegen output was removed from codegen.ts because of unrelated hr-module fragment drift, leaving all 8 remotes hand-typed.                                                                               |
| **MISSING**     | tests/invariants/contract-parity.spec.ts (this agent's primary deliverable) | No such file exists. The four axes are covered by four unrelated mechanisms with different trigger conditions (two path-filtered workflows, two jest invariants scoped to farm-module), which is why the suffix hole in PARITY-HIGH-001 has no backstop.                                            |
| **PARTIAL**     | Ad-hoc GraphQL contract drift script (check-graphql-contract-drift.mjs)     | Runs unconditionally in ci-affected pre-flight, but is a hand-maintained list of hardcoded string assertions about specific files (SettingsPage, two aquamobil storage pages) — not a general parity mechanism, and it grows only by manual edit.                                                   |
| **PARTIAL**     | Codegen freshness gate (git diff on generated dirs)                         | Composes the supergraph and diffs both generated directories, failing RED on a stale checkout. Weakened by a filename-suffix path filter that a legal backend-only PR can slip past (PARITY-HIGH-001).                                                                                              |
| **PARTIAL**     | GraphQL enum casing parity invariant                                        | Covers only apps/farm-service/src/regulatory ↔ web/modules/farm-module/src. aquamobil hand-duplicates TaskStatus/TaskCategory/TaskPriority/MealStatus and is excluded on a premise that holds only for its src/graphql documents.                                                                   |
| **PARTIAL**     | aquamobil GraphQL documents OUTSIDE src/graphql                             | 55 operations across 15 files (hooks, storage/water-quality pages, pwa/operation-registry.ts, sw-replay.ts, useAuth.tsx). Their document text IS validated against the composed supergraph, but none get a generated result type — every consumer hand-writes the shape.                            |
| **PARTIAL**     | aquamobil result-type contract (graphqlRequest overloads)                   | ~68 call sites use the bare-DocumentNode overload with a hand-pinned TResult; ~22 use the inferring TypedDocumentNode overload. The hand-pinned majority is unchecked against the schema.                                                                                                           |
| **PARTIAL**     | farm realtime WebSocket event-name contract                                 | 41 gateway broadcast names vs a 30-name mobile union; the 11 omitted are today exactly the site/department/system/supplier set the mobile comment declares intentional, so there is no live drift — but emitFarmEvent types eventName as bare `string` and no gate holds the two lists together.    |
| **PARTIAL**     | farm-service committed SDL snapshot (apps/farm-service/schema.graphql)      | Regenerated as a side effect of emit-subgraph-sdl and appears current (contains the FARM-HIGH-057 task lifecycle changes), but no workflow diffs it, while two specs and the MCP client treat it as schema authority.                                                                               |
| **PARTIAL**     | web/shared-ui generated GraphQL artifacts                                   | graphql-types.ts exists and is CI-diffed, but it is a schema-types-only output (no documents block) — zero TypedDocumentNode constants, so it types nothing at a call site.                                                                                                                         |
| **IMPLEMENTED** | FE dead-contract ratchet                                                    | Enforces that every defined FE GraphQL operation has at least one call site, with a monotonic-shrink baseline that cannot be padded. Complements the parity gates from the opposite direction.                                                                                                      |
| **IMPLEMENTED** | FE-operation ↔ supergraph document validation gate                          | validate-graphql-operations.mjs mirrors the gateway's runtime graphql.validate() over every backtick document under web/apps, web/modules, web/shell, web/shared-ui and mcp, against a freshly composed supergraph. Its burn-down baseline is currently ZERO — no known document drift ships today. |
| **IMPLEMENTED** | aquamobil GraphQL documents inside src/graphql (codegen-plucked)            | 67 operations across 6 files, each annotated TypedDocumentNode; the generated module carries exactly 67 matching result types, so codegen is NOT stale. This is the only Tier-1/2 slice of the mobile contract.                                                                                     |
| **IMPLEMENTED** | farm-module ↔ farm-service root-field parity invariant                      | Runs every PR as a jest invariant; asserts every farm-module document's ROOT field resolves to a farm-service resolver or an allowlisted federation field. Field selections and result types are out of its reach.                                                                                  |
| **IMPLEMENTED** | farm-service REST surface \+ OpenAPI coverage                               | ADR-farm-api-contract-posture restricts REST to health/metrics/upload/webhook paths with docs/api/openapi/farm-service.yaml as the contract. aquamobil consumes ZERO REST — every call goes to /graphql — so the REST↔hand-written-client-type drift axis does not exist for this consumer pair.    |

## Verdict

CONDITIONAL

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/contract-parity-enforcer.md`
- Rule SSoT: `CLAUDE.md`
