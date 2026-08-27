# AquaMobil V4 Feeding Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the F0, F1a, F2, and F1b feeding foundation onto current `main` so measured
biomass is the ration authority, feeder shares are tenant-safe database invariants, event language
and NATS permissions precede production, and the assignment API publishes only validated versioned
events.

**Architecture:** Reimplement the approved behavior in dependency order rather than copying source
commits. F0 keeps `FeedingLedgerService` and the storage ledger as the sole feed-stock mutation
authority while centralizing weight and protocol reads; F1a adds tenant-routed feeder assignment
tables whose committed active total is enforced by PostgreSQL; F2 installs audited version 1 event
contracts, validators, version-history invariants, and generated cert-CN ACLs; F1b exposes
CQRS/GraphQL APIs and publishes through the existing same-transaction outbox. Each retired database
surface uses three independently deployed states: additive storage, application-reader contraction,
and a later physical-column contraction after fleet evidence.

**Tech Stack:** Node.js 20.11+, npm 10+, Nx, NestJS, TypeORM, PostgreSQL, GraphQL/Apollo Federation,
AJV JSON Schema, NATS JetStream with mTLS certificate-CN identity, Jest, and `@aquaculture/testing`
London-style collaborators.

**Spec:** `docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md`

## Global Constraints

- Read root `CLAUDE.md`, `apps/farm-service/CLAUDE.md`, `apps/sensor-service/CLAUDE.md`, and
  `apps/gateway-api/CLAUDE.md` before touching their respective surfaces. Re-read root `CLAUDE.md`
  before every commit.
- Treat `826690623`, `0aabe5a5e`, `1401860c7`, and `8fad0357a` as archaeology only. Do not
  cherry-pick, merge, or copy their migration files wholesale.
- Preserve current-main commit `550a72311`:
  `apps/farm-service/src/feeding/services/feeding-ledger.service.ts` and
  `apps/farm-service/src/storage/services/stock-movement.service.ts` remain the only feed-stock
  mutation path. Never restore `feed_inventory` as a writer.
- Preserve the migration SQL authority from current-main commit `82852e31f`. Generate every
  migration against the current entity graph, review the generated SQL, and register the new class
  in `FARM_MIGRATIONS`.
- Per-tenant farm entities omit `schema:`. Use `runInTenantTransaction`, `runInTenantRead`,
  `tenantManagerRepo`, or `getScopedRepository`; never call `getRepository()` or an unscoped
  `DataSource.transaction()` for tenant data.
- Farm migrations execute against the schema selected by the fan-out runner. SQL must be
  current-schema relative; never pin a tenant migration to literal schema `farm`.
- In each migration `up()`, read `SELECT current_schema() AS schema`, validate the returned name as
  `farm` or `tenant_[0-9a-f]{16}`, and pass that exact runtime value to
  `withDdlSafety(queryRunner, { schema, advisoryLockKeySuffix: schema }, async () => ...)`. This
  preserves the fan-out runner's selected schema while retaining bounded locks and DDL
  serialization.
- New tenant tables receive canonical RLS through `applyTenantRlsToSchema()` and are registered in
  `MODULE_SCHEMAS.farm.tables`, not `infrastructureTables` and never `public`.
- Events are flat, are created with `createBaseEvent()`, validate at every trust boundary, and use
  the same tenant identity as the transaction that enqueues them.
- `infrastructure/nats/services.yaml` is the NATS authorization source. Generate the bounded block
  in `infrastructure/docker/nats/nats.conf`; never hand-edit that block. Certificate CN remains the
  only service identity.
- Every RED step must fail for the asserted missing behavior. A compiler failure naming the exact
  new export introduced by the immediately preceding test is an acceptable first RED signal;
  unrelated syntax/import failures and fixture, database, or infrastructure errors are not. Fix
  those harness errors before writing production behavior.
- Do not use `as any`, double assertions, ignored TypeScript diagnostics, unawaited promises, or
  defensive optional chaining that hides a broken contract.
- Each commit below is a reviewer boundary. Run its focused tests, `git diff --check`, affected
  test/lint, commit with the registered finding trailer when required, and `git push` immediately.
  Never bypass hooks or force-push.
- The source finding numbers are not reusable: their sequences collide with unrelated current
  findings. Task 0 allocates live IDs through the repository registry and every later commit
  resolves its ID by exact registered title.
- The source migration names `AlignSubEquipmentTypeCompatibilityArray`,
  `AddTankBatchWeightProvenance`, `CreateFeederAssignments`, `BindExecutionFeederToEquipment`, and
  `DropBatchProtocolId` identify intent only. Task execution chooses a real monotonic timestamp at
  generation time and never edits an already-merged migration.
- The source daily-execution feeder FK rewrite is not part of the approved F1a contract. Do not
  modify `apps/farm-service/src/feeding/entities/daily-feeding-execution.entity.ts` or null
  unresolved legacy feeder identities in this plan.

For every commit, the allowed staged-file set is exactly the union of that task's declared `Files`
entries (including any execution-resolved migration path) and `tools/quality/format-scope.json` if
and only if the canonical generator changes it after the task-owned files are staged. Never
hand-edit that generated file.

After each task-specific `git add` has staged all task-owned files and immediately before every
`git commit`, run this final pre-commit block in addition to the task's focused tests. An earlier
displayed `git diff --cached --check` is supplemental and does not replace the final post-generator
check below. Where a task prints this complete block inline, run it once rather than duplicating it:

```bash
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
STAGED_FILES="$(git diff --cached --name-only | paste -sd, -)"
test -n "$STAGED_FILES"
npx nx affected --target=test --files="$STAGED_FILES"
npx nx affected --target=lint --files="$STAGED_FILES"
git diff --cached --check
```

Expected: the canonical generated format scope is current, both affected commands exit zero, and the
final staged diff check passes. Documentation-only changes may report no affected projects and still
exit zero.

## Release Train

1. F0 expansion adds provenance and central readers without removing `Batch.protocolId`.
2. Deploy F0 expansion, remove `Batch.protocolId` from application metadata/GraphQL in a second
   release while retaining the physical column, and deploy that reader contraction everywhere.
3. Only after the contracted application fleet is proven, drop the retired batch column in a third
   F0 release whose migration reruns semantic parity immediately before DDL.
4. F1a additive expansion adds a native compatibility array beside the scalar, backfills and
   dual-writes it, and lands the feeder tables/share invariant without an event producer.
5. Deploy that complete additive boundary and prove old/new binary compatibility plus per-tenant
   scalar/array parity.
6. Roll an array-only application boundary everywhere while retaining the physical scalar and
   dual-write trigger; this release issues no DDL.
7. Only after that reader fleet and fresh parity are proven, remove the scalar and trigger in a
   distinct physical-contraction boundary.
8. F2 lands version 1 interfaces, validators, an explicit version-history audit, and generated ACLs
   without a producer.
9. F1b lands read/write APIs, the transactional producer, and the tenant-routed gateway consumer.

## Branch and Protected-PR Boundaries

- Tasks 0–5 run on `feat/feeding-f0-weighing-authority`, created from the then-current
  `origin/main`. That expansion is reviewed, merged, and deployed before Task 6 starts.
- Task 6 runs on `refactor/feeding-f0-batch-protocol-reader-contract`, created from the deployed F0
  expansion. It removes the application/GraphQL surface, retains the physical column, then merges
  and deploys independently.
- Task 7 runs on `refactor/feeding-f0-batch-protocol-column-drop`, created only after the exact Task
  6 protected-main SHA is deployed to every farm-service instance and old binaries are absent.
- Tasks 8, 10, and 11 run on `feat/feeding-f1a-compatibility-and-feeder-model-expand`, created from
  reconciled F0 main. This additive boundary deploys the dual-written compatibility array and the
  new feeder tables/share invariant together, without an event producer.
- Task 9 first runs its application-only steps on `refactor/feeding-f1a-array-reader-contract`,
  created from the deployed additive boundary. It removes scalar fallback/writes while retaining the
  physical scalar and trigger, then merges and deploys independently.
- Task 9 then runs its physical-only steps on
  `refactor/feeding-f1a-legacy-scalar-physical-contract`, created only after the reader-contract SHA
  is deployed everywhere and fresh per-tenant parity is recorded.
- Tasks 12–13 run on `feat/feeding-f2-event-language`, created only after both F1a and I1 slice
  reconciliations are protected-main ancestors.
- Tasks 14–16 run on `feat/feeding-f1b-assignment-api`, created only from merged F2 main.
- Every PR uses protected review and either a merge commit or one squash integration commit. Do not
  use a rebase-only merge because it does not leave one auditable PR boundary for exact affected
  paths. When squashing, copy every exact finding trailer from that slice into the complete squash
  commit body.
- An implementation branch may create or retain only its own append-only
  `docs/superpowers/evidence/aquamobil-v4/slices/<SliceId>/preflight.json`. It never edits
  `execution-ledger.json`, `merge-resolutions.json`, another slice directory, or a `merge.json`.
- After each named implementation boundary merges, the coordinator captures its GitHub PR, full
  protected-main commit, repository workflow runs, and generated artifacts. Once the exact ordered
  boundary set for that slice is complete, a distinct serialized reconciliation branch writes the
  immutable `slices/<SliceId>/merge.json` with `implementationBoundaries` and regenerates
  `execution-ledger.json` only through `reconcile-ledger.mjs --slice <SliceId> --write ...`. Product
  code and finding-closure branches never mutate either generated authority. The later
  finding-closure branch also never writes `docs/superpowers/evidence/aquamobil-v4/closures/`; a
  separate post-merge reconciliation owns that append-only record and its ledger projection.
- `slice-branches.json` pins these exact ordered boundary IDs and the reconciler rejects any
  missing, extra, duplicate, or out-of-order entry:
  - F0: `weighing-authority-expand`, `batch-protocol-reader-contract`,
    `batch-protocol-physical-contract`;
  - F1a: `compatibility-and-feeder-model-expand`, `array-reader-contract`,
    `legacy-scalar-physical-contract`;
  - F2: `event-language-and-acl`;
  - F1b: `assignment-api-and-gateway`.

  A dependent slice starts only after the prior slice's reconciliation PR is protected-main
  reachable and the coordinator-owned ledger verifier passes with protected-main ancestry enabled.

- Order 0's clean detached coordinator persists at
  `/var/aqua-saas/.worktrees/aquamobil-v4-coordinator`. Every lifecycle, capture, audit, reconcile,
  or ledger-verification action starts in a new shell with the complete refresh preamble printed in
  the steps below. Lifecycle commands run from that coordinator; output-writing commands first
  return to the clean active worktree but invoke the coordinator's absolute executable path. A local
  mixed-copy executable is invalid. Every evidence-producing tool binds the coordinator's
  protected-main SHA and executable path/blob into its output, and verification rejects any
  mismatch. Never run repository tooling or npm from the dirty, user-owned `/var/aqua-saas`
  checkout; use it only for explicit `git -C` common-directory and worktree/ref operations.
- Every fresh implementation, verification, or finding-closure worktree installs both lock
  authorities with `npm ci --ignore-scripts --no-audit` before any test, build, audit, explain, or
  npm-backed repository command. Record both pre-install lock hashes, prove them unchanged after
  installation, and never symlink a dependency directory from the original checkout.

- Before requesting each implementation PR review, run the canonical four-audit capture,
  package-keyed explain-set capture, production Vite/Rollup module-manifest build, and reachability
  procedure from Task 17 Steps 8–9. For that pre-merge run, derive the exact path set with
  `git diff --name-only "$(git merge-base HEAD origin/main)" HEAD`; attach the ephemeral reports and
  preserved audit status to the PR, and record every decision in the boundary workflow evidence
  consumed by its immutable merge record. Any unclassified or affected-and-runtime-reachable
  high/critical advisory blocks the PR. Never mutate dependency state during classification.

The feeding plan consumes, but never hand-edits, the program's exact `SliceAudit`,
`ImplementationBoundaryEvidence`, merge-record, and generated-ledger schemas. The verifier requires
one per-owner evidence entry for each approved owner while deriving shared-row terminal state only
from reconciled owner evidence.

---

### Task 0: Establish Execution Baseline, Finding IDs, and Migration Timestamp Procedure

**Files:**

- Create: `docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md`
- Create: `docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.findings.json`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Read: `CLAUDE.md`
- Read: `apps/farm-service/CLAUDE.md`
- Read: `apps/sensor-service/CLAUDE.md`
- Read: `apps/gateway-api/CLAUDE.md`
- Read: `docs/runbooks/migration-authoring.md`
- Read: `docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md`
- Create through the program capture tool:
  `docs/superpowers/evidence/aquamobil-v4/slices/F0/preflight.json`
- Read: `tools/aquamobil-v4/capture-slice-audit.mjs`
- Read: `tools/aquamobil-v4/reconcile-ledger.mjs`
- Read: `tools/aquamobil-v4/verify-ledger.mjs`
- Read: `docs/superpowers/evidence/aquamobil-v4/slice-branches.json`

**Interfaces:**

- Produces one immutable fifteen-entry title/evidence inventory and fifteen registry-backed
  `FARM-HIGH` finding IDs selected later by exact title.
- Produces a deterministic runtime process for each TypeORM migration timestamp; no numeric
  timestamp is fixed in this document.
- Produces the sole F0 implementation-owned preflight record; it never writes a central ledger or
  merge record.

- [ ] **Step 1: Verify the worktree and protected baseline**

Run:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice F0 \
  --boundary weighing-authority-expand \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-f0-weighing-authority-expand
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
git rev-parse HEAD
git merge-base HEAD origin/main
git show -s --format='%H %s' 550a72311
git show -s --format='%H %s' 82852e31f
```

Expected: the path is the isolated AquaMobil integration worktree, the tree has no unowned edits,
the coordinator selected the F0 branch/path pinned by `slice-branches.json` from current
`origin/main`, and both protected commits resolve. F0 and F1a consume no container fixture, so they
may run beside I1 and their immutable preflights record the resolver as absent when I1 has not yet
merged. F2 is the first feeding slice allowed to consume the image authority and therefore has an
additional exact I1 reconciliation predecessor gate below.

- [ ] **Step 2: Prove the source commits will not be integrated directly**

Run:

```bash
git log --oneline --decorate -12
git branch --contains 826690623
git branch --contains 0aabe5a5e
git branch --contains 1401860c7
git branch --contains 8fad0357a
```

Expected: the feature commits are visible as historical objects or on source branches, but none is
an ancestor newly introduced by the active integration branch.

- [ ] **Step 3: Verify the finding registry before allocation**

Run:

```bash
npm run findings:verify
npm run findings:list:all -- --format table | rg 'AquaMobil V4 feeding foundation' || true
```

Expected: registry verification prints `OK`; the title search is either empty or lists a complete
prior allocation. If any one of the exact titles below already exists, reuse its ID and do not
allocate a duplicate.

- [ ] **Step 3a: Capture and verify the sole F0 implementation preflight**

Run the program plan's exact four-audit, canonical explain-set capture for slice F0 into
`artifacts/aquamobil-v4/F0`, preserving all audit exit statuses. Then run:

```bash
F0_ACTIVE_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-f0-weighing-authority-expand
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
cd "$F0_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice F0 \
  --main-ref origin/main \
  --source-ref origin/feature/aquamobil-v4-redesign \
  --artifact-root artifacts/aquamobil-v4/F0 \
  --write docs/superpowers/evidence/aquamobil-v4/slices/F0/preflight.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice F0 \
  --check docs/superpowers/evidence/aquamobil-v4/slices/F0/preflight.json \
  --main-ref origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
test -z "$(git diff --name-only | rg '^docs/superpowers/evidence/aquamobil-v4/' | rg -v '^docs/superpowers/evidence/aquamobil-v4/slices/F0/preflight\.json$')"
```

Expected: the append-only F0 `SliceAudit` names the program-pinned tasks/paths, exact current-main
base, migration state, dependency chains, and rejected source assumptions. No implementation edit
touches the central ledger, merge resolutions, a merge record, or another slice directory. A
bootstrap schema/tool mismatch is an Order 0 blocker fixed by the program plan, never inside F0.

- [ ] **Step 4: Allocate missing findings atomically**

Use `apply_patch` to create the sole machine-readable allocation authority exactly as follows:

```json
{
  "schemaVersion": 1,
  "cycle": "2026-08-26-aquamobil-v4-feeding-foundation",
  "reviewFile": "docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md",
  "findings": [
    {
      "title": "AquaMobil V4 feeding foundation: centralize ration weight and unit protocol reads",
      "evidence": "apps/farm-service/src/feeding-protocol/services/protocol-rate.service.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: move every ration reader to active unit protocol bindings",
      "evidence": "apps/farm-service/src/feeding/services/feed-selector.service.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: reconcile measured and projected biomass through one writer",
      "evidence": "apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: recalculate ration plans atomically after weighing",
      "evidence": "apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: validate growth sample tank projection parity",
      "evidence": "libs/event-contracts/src/schemas/farm-events.schema.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: contract legacy batch protocol identity after reader rollout",
      "evidence": "apps/farm-service/src/batch/entities/batch.entity.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: drop retired batch protocol column after application contraction",
      "evidence": "apps/farm-service/src/database/migrations"
    },
    {
      "title": "AquaMobil V4 feeding foundation: derive exact sub-equipment compatibility from the equipment catalog",
      "evidence": "apps/farm-service/src/equipment/seeds/equipment-types.seed.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: drop retired scalar hardware compatibility after array cutover",
      "evidence": "apps/farm-service/src/database/migrations"
    },
    {
      "title": "AquaMobil V4 feeding foundation: enforce tenant feeder share totals in PostgreSQL",
      "evidence": "apps/farm-service/src/feeding-protocol/entities/feeder-assignment.entity.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: version feeder and VFD event language",
      "evidence": "libs/event-contracts/src/farm-events.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: generate cert-only feeder and VFD publish grants",
      "evidence": "infrastructure/nats/services.yaml"
    },
    {
      "title": "AquaMobil V4 feeding foundation: expose tenant-safe feeder assignment API and producer",
      "evidence": "apps/farm-service/src/feeding-protocol/handlers/feeder-assignment.handlers.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: serve feeder assignments and deterministic dose splits",
      "evidence": "apps/farm-service/src/feeding-protocol/services/feeder-dose-split.service.ts"
    },
    {
      "title": "AquaMobil V4 feeding foundation: authorize GraphQL and subject-routed feeder change consumption",
      "evidence": "apps/gateway-api/src/websocket/farm-nats-bridge.service.ts"
    }
  ]
}
```

Then run these commands from Bash. The helper supplies a current UTC timestamp at execution, and the
registry supplies the numeric suffix while holding the shared worktree lock:

```bash
set -euo pipefail
FEEDING_FINDING_INVENTORY=docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.findings.json
FEEDING_FINDING_CYCLE="$(jq -er '.cycle' "$FEEDING_FINDING_INVENTORY")"
FEEDING_FINDING_REVIEW="$(jq -er '.reviewFile' "$FEEDING_FINDING_INVENTORY")"
jq -e '
  .schemaVersion == 1 and
  .cycle == "2026-08-26-aquamobil-v4-feeding-foundation" and
  .reviewFile == "docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md" and
  (.findings | length == 15) and
  (.findings | map(.title) | unique | length == 15) and
  all(.findings[];
    (.title | type == "string" and startswith("AquaMobil V4 feeding foundation: ")) and
    (.evidence | type == "string" and length > 0))
' "$FEEDING_FINDING_INVENTORY"

allocate_feeding_finding() {
  local finding_title="$1"
  local evidence_path="$2"
  local existing_count
  existing_count="$(jq -r --arg title "$finding_title" 'select(.title == $title) | .id' docs/reviews/_registry/findings.jsonl | wc -l)"
  if test "$existing_count" -eq 1; then
    jq -e \
      --arg title "$finding_title" \
      --arg evidence "$evidence_path" \
      --arg cycle "$FEEDING_FINDING_CYCLE" \
      --arg review "$FEEDING_FINDING_REVIEW" \
      'select(
        (.id | test("^FARM-HIGH-[0-9]{3}$")) and
        .severity == "HIGH" and
        .state == "OPEN" and
        .title == $title and
        .layer == 1 and
        .evidence == [$evidence] and
        .rule_violated == "AquaMobil V4 safe integration feeding release contract" and
        .owner_agent == "claude" and
        .raised_in_cycle == $cycle and
        .review_file == $review and
        (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")) and
        .closed_at == null and
        .closing_commits == [] and
        .deadline == null and
        .owner_user == null and
        .override_of == null and
        .notes == "Allocated by the approved F0-F1a-F2-F1b implementation plan."
      )' docs/reviews/_registry/findings.jsonl >/dev/null
    printf 'Reusing existing finding for: %s\n' "$finding_title"
    return 0
  fi
  test "$existing_count" -eq 0
  npm run findings:add -- FARM <(
    node - "$finding_title" "$evidence_path" "$FEEDING_FINDING_CYCLE" "$FEEDING_FINDING_REVIEW" <<'NODE'
const [title, evidence, cycle, reviewFile] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify({
    severity: 'HIGH',
    state: 'OPEN',
    title,
    layer: 1,
    evidence: [evidence],
    rule_violated: 'AquaMobil V4 safe integration feeding release contract',
    owner_agent: 'claude',
    raised_in_cycle: cycle,
    review_file: reviewFile,
    created_at: new Date().toISOString(),
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes: 'Allocated by the approved F0-F1a-F2-F1b implementation plan.',
  })}\n`,
);
NODE
  )
}

while IFS=$'\t' read -r finding_title evidence_path; do
  allocate_feeding_finding "$finding_title" "$evidence_path"
done < <(jq -r '.findings[] | [.title, .evidence] | @tsv' "$FEEDING_FINDING_INVENTORY")

node --input-type=module - \
  "$FEEDING_FINDING_INVENTORY" \
  docs/reviews/_registry/findings.jsonl <<'NODE'
import fs from 'node:fs';

const [inventoryPath, registryPath] = process.argv.slice(2);
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const rows = fs
  .readFileSync(registryPath, 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((row) => row.raised_in_cycle === inventory.cycle);
if (rows.length !== inventory.findings.length) throw new Error('feeding finding count diverges');
for (const expected of inventory.findings) {
  const matches = rows.filter((row) => row.title === expected.title);
  if (matches.length !== 1) throw new Error(`expected one row: ${expected.title}`);
  const [row] = matches;
  if (
    !/^FARM-HIGH-[0-9]{3}$/.test(row.id) ||
    row.severity !== 'HIGH' ||
    row.state !== 'OPEN' ||
    row.layer !== 1 ||
    JSON.stringify(row.evidence) !== JSON.stringify([expected.evidence]) ||
    row.rule_violated !== 'AquaMobil V4 safe integration feeding release contract' ||
    row.owner_agent !== 'claude' ||
    row.review_file !== inventory.reviewFile ||
    row.closed_at !== null ||
    JSON.stringify(row.closing_commits) !== '[]'
  ) {
    throw new Error(`allocation contract diverges: ${expected.title}`);
  }
}
if (rows.some((row) => !inventory.findings.some((entry) => entry.title === row.title))) {
  throw new Error('feeding cycle contains an unexpected title');
}
NODE
```

Expected: each newly allocated title prints `Added: FARM-HIGH-` followed by a unique registry
sequence. An existing exact title is reused only when its full OPEN allocation contract equals the
single committed inventory; malformed, foreign-domain, closed, or cross-cycle rows fail closed.

- [ ] **Step 5: Record the allocated IDs in the review document**

Run:

```bash
jq -r 'select(.raised_in_cycle == "2026-08-26-aquamobil-v4-feeding-foundation") | [.id, .title, .state] | @tsv' docs/reviews/_registry/findings.jsonl
```

Expected: exactly fifteen unique rows, all severity `HIGH` and state `OPEN`, one for each exact
title from Step 4.

Use `apply_patch` to create `docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md`.
Give it one `##` heading per emitted ID, copy the corresponding exact title beneath the heading, set
state `OPEN`, cite the evidence path recorded in the registry, and state the closure command is the
commit carrying `Closes: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#`
followed by that same emitted ID. Do not type or predict a sequence that the allocator did not emit.

- [ ] **Step 6: Verify registry and review parity**

Run:

```bash
npm run findings:verify
npx nx test invariants --runInBand --testPathPatterns=finding-registry-integrity.spec.ts
jq -r 'select(.raised_in_cycle == "2026-08-26-aquamobil-v4-feeding-foundation") | .id' docs/reviews/_registry/findings.jsonl | while read -r finding_id; do
  test "$(rg -c "^## ${finding_id}$" docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md)" -eq 1
done
jq -e '[select(.raised_in_cycle == "2026-08-26-aquamobil-v4-feeding-foundation")] | length == 15 and all(.severity == "HIGH" and .state == "OPEN")' docs/reviews/_registry/findings.jsonl
```

Expected: registry verification passes, the invariant passes, and every ID resolves to exactly one
review heading.

- [ ] **Step 7: Use this exact migration timestamp procedure at every generation step**

Run immediately before each TypeORM generation, changing only `MIGRATION_NAME`:

```bash
MIGRATION_NAME=AddTankBatchWeightProvenance
LATEST_FARM_MIGRATION_TS="$(rg --files apps/farm-service/src/database/migrations | sed -nE 's#^.*/([0-9]{13})-.*\.ts$#\1#p' | sort -n | tail -1)"
WALL_CLOCK_TS="$(date -u +%s%3N)"
if (( 10#$WALL_CLOCK_TS > 10#$LATEST_FARM_MIGRATION_TS )); then
  FARM_MIGRATION_TS="$WALL_CLOCK_TS"
else
  FARM_MIGRATION_TS="$((10#$LATEST_FARM_MIGRATION_TS + 1))"
fi
FARM_MIGRATION_PATH="apps/farm-service/src/database/migrations/${FARM_MIGRATION_TS}-${MIGRATION_NAME}.ts"
test ! -e "$FARM_MIGRATION_PATH"
(
  cd apps/farm-service
  npx typeorm-ts-node-commonjs migration:generate \
    -d src/database/data-source.ts \
    -t "$FARM_MIGRATION_TS" \
    "src/database/migrations/${MIGRATION_NAME}"
)
test -f "$FARM_MIGRATION_PATH"
test "$(git status --porcelain=v1 --untracked-files=all -- apps/farm-service/src/database/migrations | awk '$1 == "??" { count += 1 } END { print count + 0 }')" -eq 1
GENERATED_DIFF_STATUS=0
git diff --no-index -- /dev/null "$FARM_MIGRATION_PATH" || GENERATED_DIFF_STATUS=$?
test "$GENERATED_DIFF_STATUS" -eq 1
```

Expected: the farm-local CommonJS TypeORM runner creates exactly one new file at
`$FARM_MIGRATION_PATH`; the full generated diff is printed for review; and its timestamp is greater
than every farm migration present at that moment. An empty diff, a second migration file, or any
entity/schema change not named by that task blocks editing the generated migration. Never reuse a
previously exported value after another migration lands.

- [ ] **Step 8: Commit and push the review allocation**

Run:

```bash
git add \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md \
  docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.findings.json \
  docs/superpowers/evidence/aquamobil-v4/slices/F0/preflight.json
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(review): register feeding foundation findings"
git push
```

Expected: hooks pass and the active branch is pushed. This first F0 boundary commit freezes the sole
append-only F0 preflight beside the review allocation; it creates no central or merge evidence and
does not resolve a finding.

---

## F0 — Weighing and Ration Authority

### Task 1: Centralize Band Weight and Unit Protocol Resolution

**Files:**

- Create: `apps/farm-service/src/feeding-protocol/services/unit-protocol-resolver.service.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/unit-protocol-resolver.service.spec.ts`
- Create: `apps/farm-service/src/feeding-protocol/feeding-calculation.module.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/protocol-rate.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/protocol-rate.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/meal-plan-generator.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/meal-plan-generator.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/protocol-feed-forecast.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/protocol-feed-forecast.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/feeding-cron-v2.fcr-sweep.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/feeding-cron-v2.dry-run.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/day-plan-recalc.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/day-plan-admin.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/day-plan-admin.service.spec.ts`
- Modify: `apps/farm-service/src/growth/services/fcr-calculation.service.ts`
- Modify: `apps/farm-service/src/growth/__tests__/services/fcr-calculation.service.spec.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feeding-calculation-module.di.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts`
- Modify: `apps/farm-service/src/growth/growth.module.ts`
- Modify: `apps/farm-service/src/batch/batch.module.ts`
- Modify: `apps/farm-service/src/feeding/feeding.module.ts`
- Modify: `apps/farm-service/src/harvest/harvest.module.ts`
- Modify: `apps/farm-service/src/water-quality/water-quality.module.ts`

**Interfaces:**

```ts
export type BandWeightG = number & { readonly __brand: 'BandWeightG' };

export function tankBandWeightG(unit: {
  avgWeightG: number | string | null | undefined;
  totalQuantity: number | string | null | undefined;
  totalBiomassKg: number | string | null | undefined;
}): BandWeightG;

export function derivedBandWeightG(biomassKg: number, fishCount: number): BandWeightG;

export interface ExpectedFcrInput {
  readonly band: ProtocolBand;
  readonly fcrSource: ProtocolFcrSource;
  readonly avgWeightG: BandWeightG;
  readonly temperatureC: number | null;
  readonly protocolFcrMatrix?: FcrMatrix;
  readonly feedFcrMatrix?: FcrMatrix;
  readonly fcrOverrides?: FcrOverride[];
}

export class ProtocolRateService {
  bandFor(bands: ProtocolBand[], avgWeightG: BandWeightG): ResolvedBand | null;
  resolveExpectedFcr(input: ExpectedFcrInput): ExpectedFcrResult;
}

export type ProtocolSqlExecutor = Pick<EntityManager, 'query'>;

export interface UnitProtocolBinding {
  readonly unitId: string;
  readonly protocolId: string;
  readonly protocolName: string;
  readonly bands: ProtocolBand[];
  readonly temperatureAdjustments?: TemperatureAdjustment[];
  readonly settings: ProtocolSettings;
  readonly overrides?: AssignmentOverrides;
}

export interface ResolvedUnitProtocol {
  readonly unitId: string;
  readonly protocolId: string;
  readonly protocolName: string;
  readonly bandIndex: number;
  readonly feedId: string;
  readonly feedCode: string;
  readonly feedName: string;
  readonly effectiveRatePercent: number;
}

export class UnitProtocolResolverService {
  loadActiveBindings(
    executor: ProtocolSqlExecutor,
    tenantId: string,
    unitIds: readonly string[],
  ): Promise<Map<string, UnitProtocolBinding>>;

  resolveRate(
    binding: UnitProtocolBinding,
    avgWeightG: BandWeightG,
    waterTempC: number | null,
  ): ResolvedUnitProtocol | null;

  resolveForUnit(
    executor: ProtocolSqlExecutor,
    tenantId: string,
    unitId: string,
    avgWeightG: BandWeightG,
    waterTempC: number | null,
  ): Promise<ResolvedUnitProtocol | null>;
}
```

- Consumes current v2 unit protocol assignment tables and current protocol-band settings.
- Produces the only protocol resolution API consumed by the readers in Task 2.

- [ ] **Step 1: Write the RED branded-weight tests**

Add tests proving:

```ts
const fromTank = tankBandWeightG({
  avgWeightG: 125,
  totalQuantity: 1000,
  totalBiomassKg: 125,
});
expect(fromTank).toBe(125);

const derived = derivedBandWeightG(125, 1000);
expect(derived).toBe(125);
expect(derivedBandWeightG(125, 0)).toBe(0);
```

Also add a compile-time fixture in the test that passes only `BandWeightG` into `bandFor()` and
`resolveExpectedFcr()`. Do not suppress diagnostics.

- [ ] **Step 2: Run the branded-weight test and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=protocol-rate.service.spec.ts
```

Expected: FAIL because `BandWeightG`, `tankBandWeightG()`, and `derivedBandWeightG()` are not
exported.

- [ ] **Step 3: Implement the minimal branded boundary**

In `protocol-rate.service.ts`, export `tankBandWeightG()` and `derivedBandWeightG()`. Calculate and
validate a finite non-negative numeric value before applying the brand. Change `bandFor()` and
`ExpectedFcrInput.avgWeightG` to accept `BandWeightG`. Keep brand creation inside those two exported
functions so arbitrary numbers cannot enter band selection without an explicit conversion.

- [ ] **Step 4: Run the branded-weight tests and verify GREEN**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=protocol-rate.service.spec.ts
```

Expected: PASS with zero unsafe casts.

- [ ] **Step 5: Write the RED unit-protocol resolver tests**

Use a typed `ProtocolSqlExecutor` mock. Prove:

```ts
await expect(resolver.loadActiveBindings(executor, tenantId, [unitA, unitB])).resolves.toEqual(
  new Map([[unitA, expect.objectContaining({ unitId: unitA, protocolId })]]),
);

expect(resolver.resolveRate(binding, tankBandWeightG(unit), 12)).toEqual(
  expect.objectContaining({
    unitId: unitA,
    protocolId,
    feedId,
    effectiveRatePercent: 1.25,
  }),
);
```

Cover empty unit arrays without SQL, inactive assignments excluded, tenant ID bound in SQL, numeric
database strings normalized, missing bands returning `null`, and temperature adjustment delegated to
`ProtocolRateService`.

- [ ] **Step 6: Run the resolver test and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=unit-protocol-resolver.service.spec.ts
```

Expected: FAIL because `UnitProtocolResolverService` does not exist.

- [ ] **Step 7: Implement the resolver and sole calculation-provider module**

Create one parameterized query for the requested unit IDs and tenant. Map rows once and call
`ProtocolRateService` for the effective rate. Create `FeedingCalculationModule` with exactly one
provider/export registration each for `ProtocolRateService`, `UnitProtocolResolverService`,
`BiomassGrowthApplierService`, and `DayPlanRecalcService`, plus only the TypeORM/outbox imports
those four providers actually require.

Import/export that focused module from `FeedingProtocolModule`; import it from `GrowthModule`,
`BatchModule`, `FeedingModule`, `HarvestModule`, and `WaterQualityModule`. Remove every direct
registration and export of those four calculation providers from all six consumer modules. Do not
use `forwardRef()` and do not create a second calculation module. `FeedingProtocolModule` may
continue importing `GrowthModule` because the reverse edge now terminates at the focused module
rather than returning to the parent module.

In `feeding-calculation-module.di.spec.ts`, build Nest testing modules for each consumer and inspect
module metadata. Assert the four providers are declared only by `FeedingCalculationModule`, every
consumer imports that module, and Nest resolves the same `ProtocolRateService` token for a
calculation consumer reached through each module. A direct provider in Batch, Feeding, Growth,
Harvest, WaterQuality, or FeedingProtocol must fail the test.

- [ ] **Step 8: Convert every current branded-weight caller**

Use `tankBandWeightG()` or `derivedBandWeightG()` at every current production call to `bandFor()`,
`resolveExpectedFcr()`, or `MealPlanGeneratorService.computeDayPlan()`: meal-plan generation,
forecast simulation, cron generation, day-plan recalculation, day-plan administration, and growth
FCR target resolution. Update each focused test to create the branded value through an exported
constructor; never cast a number to the brand. `MealPlanStock.avgWeightG`, forecast simulation
state, and the relevant FCR resolver row become `BandWeightG`, so the compiler exposes a future
unmigrated caller. No production caller may calculate `biomassKg * 1000 / fishCount` independently
after this step; it calls `derivedBandWeightG()`.

- [ ] **Step 9: Run the F0 protocol unit cluster**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(protocol-rate|unit-protocol-resolver|meal-plan-generator|protocol-feed-forecast|feeding-cron-v2\.(fcr-sweep|dry-run)|day-plan-(recalc|admin)|fcr-calculation|feeding-calculation-module\.di)\.spec\.ts'
```

Expected: PASS; the resolver test proves one SQL round trip for a batch of unit IDs, every
production calculation caller crosses an explicit brand constructor, and Nest has one provider owner
for each calculation service.

- [ ] **Step 10: Commit and push**

Run:

```bash
F0_PROTOCOL_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: centralize ration weight and unit protocol reads") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F0_PROTOCOL_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/feeding-protocol/services/unit-protocol-resolver.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/unit-protocol-resolver.service.spec.ts \
  apps/farm-service/src/feeding-protocol/feeding-calculation.module.ts \
  apps/farm-service/src/feeding-protocol/services/protocol-rate.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/protocol-rate.service.spec.ts \
  apps/farm-service/src/feeding-protocol/services/meal-plan-generator.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/meal-plan-generator.service.spec.ts \
  apps/farm-service/src/feeding-protocol/services/protocol-feed-forecast.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/protocol-feed-forecast.service.spec.ts \
  apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeding-cron-v2.fcr-sweep.spec.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeding-cron-v2.dry-run.spec.ts \
  apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/day-plan-recalc.service.spec.ts \
  apps/farm-service/src/feeding-protocol/services/day-plan-admin.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/day-plan-admin.service.spec.ts \
  apps/farm-service/src/growth/services/fcr-calculation.service.ts \
  apps/farm-service/src/growth/__tests__/services/fcr-calculation.service.spec.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeding-calculation-module.di.spec.ts \
  apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts \
  apps/farm-service/src/growth/growth.module.ts \
  apps/farm-service/src/batch/batch.module.ts \
  apps/farm-service/src/feeding/feeding.module.ts \
  apps/farm-service/src/harvest/harvest.module.ts \
  apps/farm-service/src/water-quality/water-quality.module.ts
git diff --cached --check
npx nx test farm-service --runInBand --testPathPatterns='(protocol-rate|unit-protocol-resolver|meal-plan-generator|protocol-feed-forecast|feeding-cron-v2\.(fcr-sweep|dry-run)|day-plan-(recalc|admin)|fcr-calculation|feeding-calculation-module\.di)\.spec\.ts'
npx nx lint farm-service
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): centralize unit protocol rate resolution\n\nRation readers need one branded weight boundary and one active unit-protocol resolver so plan, forecast, and cron calculations cannot diverge.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F0_PROTOCOL_FINDING_ID")"
git push
```

Expected: focused tests and hooks pass, and the pushed commit carries the allocated finding trailer.

### Task 2: Cut Every Runtime Reader Over to the Unit Protocol Authority

**Files:**

- Modify: `apps/farm-service/src/equipment/dataloaders/feed-selection.dataloader.ts`
- Modify: `apps/farm-service/src/equipment/dataloaders/__tests__/feed-selection.dataloader.spec.ts`
- Modify: `apps/farm-service/src/common/types/graphql-context.types.ts`
- Modify: `apps/farm-service/src/common/graphql-context.factory.ts`
- Create: `apps/farm-service/src/common/__tests__/graphql-context.factory.spec.ts`
- Modify: `apps/farm-service/src/common/graphql-context.module.ts`
- Modify: `apps/farm-service/src/equipment/equipment.resolver.ts`
- Modify: `apps/farm-service/src/equipment/__tests__/equipment.resolver.spec.ts`
- Modify: `apps/farm-service/src/feeding/services/feed-selector.service.ts`
- Create: `apps/farm-service/src/feeding/services/__tests__/feed-selector.service.spec.ts`
- Modify: `apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts`
- Modify:
  `apps/farm-service/src/feeding/services/__tests__/daily-feeding-execution.protocol-rate.spec.ts`
- Modify: `apps/farm-service/src/feeding/services/__tests__/daily-feeding-execution.service.spec.ts`
- Modify: `apps/farm-service/src/feeding/services/growth-simulator.service.ts`
- Create: `apps/farm-service/src/feeding/services/__tests__/growth-simulator.feed-selection.spec.ts`
- Create: `tests/invariants/feeding-ration-authority.spec.ts`

**Interfaces:**

```ts
export interface FeedSelectionKey {
  readonly unitId: string;
  readonly batchId: string;
  readonly avgWeightG: BandWeightG;
  readonly biomassKg: number;
  readonly waterTemperatureC: number | null;
}

export interface FeedSelectionDataLoader
  extends DataLoader<Readonly<FeedSelectionKey>, FeedSelectionRow | null, string> {}

selectFeedForBatchWithManager(
  manager: EntityManager,
  tenantId: string,
  key: Readonly<FeedSelectionKey>,
): Promise<FeedSelectionResult | null>;

selectFeedForBatch(
  tenantId: string,
  key: Readonly<FeedSelectionKey>,
): Promise<FeedSelectionResult | null>;

preloadFeedDataForBatchWithManager(
  manager: EntityManager,
  tenantId: string,
  identity: Readonly<Pick<FeedSelectionKey, 'unitId' | 'batchId'>>,
): Promise<void>;

preloadFeedDataForBatch(
  tenantId: string,
  identity: Readonly<Pick<FeedSelectionKey, 'unitId' | 'batchId'>>,
): Promise<void>;

createFeedSelectionLoader(
  dataSource: DataSource,
  unitProtocolResolver: UnitProtocolResolverService,
): FeedSelectionDataLoader;
```

- Consumes `BandWeightG` and `UnitProtocolResolverService` from Task 1.
- Produces readers with no `Batch.protocolId` fallback while retaining the real
  `batch_feed_assignments` drain path.

- [ ] **Step 1: Write RED immutable DataLoader and call-site tests**

Assert a batch of frozen `FeedSelectionKey` values invokes one `runInTenantRead()` and one
`loadActiveBindings()` with the tenant supplied by `createTenantScopedDataLoader`'s fail-closed
request callback plus the distinct unit IDs. Prove that callback pins one verified tenant for the
loader lifecycle and that tenant identity is never accepted in a load key or caller argument. The
loader uses each immutable `(unitId, batchId)` pair, never stores mutable context in a side map, and
uses a deterministic cache key containing both UUIDs. Two keys with one batch and different units
must not alias; two keys with one unit and different batches must not alias. Keep a separate test
proving an explicit `batch_feed_assignments` row remains usable when no active unit protocol exists.

In `equipment.resolver.spec.ts`, assert both the DataLoader and non-DataLoader paths create the same
frozen key from `equipment.id` plus `tankBatch.primaryBatchId`; the fallback calls
`selectFeedForBatch(tenantId, key)` with no caller-supplied schema name. In the GraphQL context
factory test, assert `DataSource` and the DI-owned `UnitProtocolResolverService` are passed into the
loader factory, that one loader instance is created per request, and that no repository or schema
name is passed to it.

- [ ] **Step 2: Run the DataLoader test and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=feed-selection.dataloader.spec.ts
```

Expected: FAIL because the current loader duplicates protocol SQL and still exposes the legacy batch
fallback.

- [ ] **Step 3: Implement the DataLoader, context-factory, and resolver cutover**

Replace `setContext()` with immutable load keys. Have `GraphQLContextFactory` inject `DataSource`
and the sole `UnitProtocolResolverService`; import `FeedingCalculationModule` in
`GraphQLContextModule`. Inside one tenant-scoped DataLoader batch tick, open exactly one
`runInTenantRead(dataSource, 'farm', tenantId, callback)`, use only its `queryRunner.manager`, batch
all unit lookups, and preserve output order for the original keys. Convert raw tank values through
`tankBandWeightG()` before creating a key. Do not accept a schema name, use a repository captured
outside the pinned read, or keep duplicate band/temperature arithmetic in the loader.

- [ ] **Step 4: Write and run RED `FeedSelectorService` tests**

Test both exact manager-aware and convenience selection/preload signatures, v2 protocol success,
real drain-assignment fallback, tenant predicate propagation, and `null` when neither authority has
a feed. Prove `selectFeedForBatch()` and `preloadFeedDataForBatch()` each open one
`runInTenantRead()` and delegate to their manager-aware counterpart; a caller that already supplies
a manager opens no nested read or transaction. Cache identity must include tenant, unit, and batch,
and no API accepts `schemaName`.

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=feed-selector.service.spec.ts
```

Expected: FAIL because the current service reads `Batch.protocolId`, accepts a schema name, and
lacks an immutable unit/batch key.

- [ ] **Step 5: Implement the minimal `FeedSelectorService` cutover**

Resolve the v2 unit protocol first through the supplied manager and pinned tenant. Use
`batch_feed_assignments` only as the drain compatibility path. Remove all reads of
`Batch.protocolId`, all caller-derived schema interpolation, and every runtime construction of
`FeedingProtocolRateService`/`ProtocolRateService` from this service. Put the preload query only in
`preloadFeedDataForBatchWithManager()` and have the convenience wrapper reuse it inside one tenant
read. Every cache entry is keyed by immutable tenant/unit/batch identity.

- [ ] **Step 6: Write and run RED daily-execution and simulation call-site tests**

Assert daily execution asks `UnitProtocolResolverService` for the active unit binding, uses a
branded average weight, and never selects a protocol through the batch entity.

Assert growth simulation resolves one stable unit/batch identity, calls the new preload signature,
and supplies a fresh immutable branded key for every projected-day selection without passing its
legacy schema variable.

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(daily-feeding-execution\.(protocol-rate|service)|growth-simulator\.feed-selection)\.spec\.ts'
```

Expected: FAIL on the expected resolver/signature calls because the current services follow the
legacy batch field or schema-bearing feed-selection API.

- [ ] **Step 7: Implement the daily-execution cutover**

Thread the immutable unit/batch identity and branded weight through the existing transaction and
call the manager-aware resolver/read path. Remove the runtime `new FeedingProtocolRateService()`. Do
not alter `FeedingLedgerService.recordFeed()` or the ordering that makes storage deduction fail
closed.

Update `GrowthSimulatorService`, the other production `FeedSelectorService` caller, in the same
step. Resolve the unit ID from the simulation's existing tank/equipment lookup, fail closed when a
batch has no unambiguous unit, create every daily key with `tankBandWeightG()`, and call the new
preload/select signatures without `schemaName`. Its focused test must prove the same unit/batch
identity reaches preload and every projected day, a changed projected weight receives a newly
constructed brand, and no caller-owned schema reaches the service.

- [ ] **Step 8: Add the TypeScript-AST ration-authority invariant**

Implement `feeding-ration-authority.spec.ts` with the TypeScript compiler API. Parse production
`.ts` sources and recursively visit property/element access, call/new expressions, decorators, and
string/template literals. Resolve aliased imports to their declarations with the type checker and
recursively expand statically known `providers` array spreads; an unresolved provider spread in an
affected `@Module()` fails closed. The invariant must fail on all of these structural classes:

- `Batch.protocolId`, `batch['protocolId']`, or SQL that selects/filters/joins
  `batches_v2.protocolId` in a production reader;
- `new ProtocolRateService()` or `new FeedingProtocolRateService()` outside unit tests;
- a `providers` array that declares `ProtocolRateService`, `UnitProtocolResolverService`,
  `BiomassGrowthApplierService`, or `DayPlanRecalcService` outside `feeding-calculation.module.ts`,
  including aliased identifiers and spread constants;
- a call to `ProtocolRateService.bandFor()`/`resolveExpectedFcr()` whose weight expression is not
  statically typed `BandWeightG` by the program type checker;
- mutable DataLoader context APIs or a loader key type that omits `unitId` or `batchId`.
- any production invocation of `selectFeedForBatch()` or `preloadFeedDataForBatch()` whose argument
  count/type does not match the immutable-key API, including a schema-name expression;
- a feed-selection cache key that omits tenant, unit, or batch identity.

Allow computed traceability `protocolId` only in the exact traceability response/query files whose
source is `feeding_protocol_assignments`; do not use filename-wide suppression for runtime readers.
Run:

```bash
npx nx test invariants --runInBand --testPathPatterns=feeding-ration-authority.spec.ts
```

Expected: PASS through syntax-aware assertions. Comments, unrelated `protocolId` fields, and
computed traceability DTOs cannot produce false positives, while aliasing or bracket access cannot
evade the invariant.

- [ ] **Step 9: Run reader and storage-authority regression suites**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(graphql-context\.factory|feed-selection\.dataloader|feed-selector|daily-feeding-execution|growth-simulator\.feed-selection|feeding-ledger|stock-movement)'
npx nx test invariants --runInBand --testPathPatterns='(feeding-ration-authority|farm-stock-mutation-(central-only|ssot))\.spec\.ts'
```

Expected: PASS, including fail-closed storage deduction cases.

- [ ] **Step 10: Commit and push the reader cutover**

Run:

```bash
F0_READER_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: move every ration reader to active unit protocol bindings") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F0_READER_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/equipment/dataloaders/feed-selection.dataloader.ts \
  apps/farm-service/src/equipment/dataloaders/__tests__/feed-selection.dataloader.spec.ts \
  apps/farm-service/src/common/types/graphql-context.types.ts \
  apps/farm-service/src/common/graphql-context.factory.ts \
  apps/farm-service/src/common/__tests__/graphql-context.factory.spec.ts \
  apps/farm-service/src/common/graphql-context.module.ts \
  apps/farm-service/src/equipment/equipment.resolver.ts \
  apps/farm-service/src/equipment/__tests__/equipment.resolver.spec.ts \
  apps/farm-service/src/feeding/services/feed-selector.service.ts \
  apps/farm-service/src/feeding/services/__tests__/feed-selector.service.spec.ts \
  apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts \
  apps/farm-service/src/feeding/services/__tests__/daily-feeding-execution.protocol-rate.spec.ts \
  apps/farm-service/src/feeding/services/__tests__/daily-feeding-execution.service.spec.ts \
  apps/farm-service/src/feeding/services/growth-simulator.service.ts \
  apps/farm-service/src/feeding/services/__tests__/growth-simulator.feed-selection.spec.ts \
  tests/invariants/feeding-ration-authority.spec.ts
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): move ration readers to unit protocols\n\nDataLoader, feed selection, and daily execution must consume the same active unit binding while preserving only the real drain-assignment fallback.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F0_READER_FINDING_ID")"
git push
```

Expected: hooks pass and the reader finding is distinct from the resolver finding.

### Task 3: Introduce the Single Biomass Growth Writer and Provenance Expansion

**Files:**

- Modify: `apps/farm-service/src/feeding-protocol/services/biomass-growth-applier.service.ts`
- Create:
  `apps/farm-service/src/feeding-protocol/__tests__/biomass-growth-applier.measurement.spec.ts`
- Create: `apps/farm-service/src/batch/utils/unit-for-batch.util.ts`
- Create: `apps/farm-service/src/batch/__tests__/unit-for-batch.util.spec.ts`
- Modify: `apps/farm-service/src/batch/entities/tank-batch.entity.ts`
- Verify after Task 1 creates it:
  `apps/farm-service/src/feeding-protocol/feeding-calculation.module.ts`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Create at execution: `$F0_PROVENANCE_MIGRATION`, resolved by the monotonic procedure with semantic
  name `AddTankBatchWeightProvenance`
- Create:
  `apps/farm-service/src/database/migrations/__tests__/tank-batch-weight-provenance.migration.spec.ts`
- Create: `apps/farm-service/src/__tests__/e2e/tank-batch-weight-provenance.postgres.spec.ts`

**Interfaces:**

```ts
export type TankWeightProvenance =
  | {
      source: 'fcr_projection';
      at: string;
      basedOnFcr: number;
    }
  | {
      source: 'measurement';
      at: string;
      measurementId: string;
      sampleSize: number;
      confidencePercent: number;
      measuredAvgWeightG: number;
      supersededProjectedAvgWeightG: number;
      projectionErrorPercent: number;
    };

export const SIGNIFICANT_WEIGHT_VARIANCE_PERCENT = 10;

export interface LockedUnit {
  readonly tankBatch: TankBatch;
  readonly batches: Map<string, Batch>;
  readonly details: BatchDetail[];
}

export interface MeasurementProvenance {
  readonly source: 'measurement';
  readonly measurementId: string;
  readonly measuredAt: Date;
  readonly sampleSize: number;
  readonly confidencePercent: number;
}

export interface FcrProjectionProvenance {
  readonly source: 'fcr_projection';
  readonly basedOnFcr: number;
}

export type BiomassWriteProvenance = FcrProjectionProvenance | MeasurementProvenance;

export interface MeasuredReconciliation {
  readonly projectedAvgWeightG: number;
  readonly measuredAvgWeightG: number;
  readonly projectionErrorPercent: number;
  readonly appliedDeltaKg: number;
  readonly fishCount: number;
}

export class BiomassGrowthApplierService {
  lockUnitForGrowth(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
  ): Promise<LockedUnit | null>;

  applyGrowth(
    manager: EntityManager,
    tenantId: string,
    locked: LockedUnit,
    growthKg: number,
    basedOnFcr: number,
  ): Promise<void>;

  reconcileMeasuredWeight(
    manager: EntityManager,
    tenantId: string,
    locked: LockedUnit,
    measuredAvgWeightG: number,
    provenance: MeasurementProvenance,
  ): Promise<MeasuredReconciliation | null>;

  stampBatchWeight(
    batch: Batch,
    aggregate: { biomassKg: number; quantity: number },
    provenance: BiomassWriteProvenance,
  ): void;
}

export function resolveUnitHoldingBatch(
  manager: EntityManager,
  tenantId: string,
  batchId: string,
  explicitUnitId?: string,
): Promise<string | null>;
```

- Consumes the current lock order and transaction manager used by feeding and growth handlers.
- Produces one writer that updates `BatchDetail`, `Batch`, `TankBatch`, and `Tank.currentBiomass`
  together and stamps truthful provenance.

- [ ] **Step 1: Write RED unit-membership tests**

Cover these exact cases:

```ts
await expect(resolveUnitHoldingBatch(manager, tenantId, batchId)).resolves.toBeNull();
await expect(resolveUnitHoldingBatch(manager, tenantId, batchIdWithOneUnit)).resolves.toBe(unitId);
await expect(resolveUnitHoldingBatch(manager, tenantId, batchIdWithTwoUnits)).rejects.toThrow(
  BadRequestException,
);
await expect(
  resolveUnitHoldingBatch(manager, tenantId, batchIdWithOneUnit, differentUnitId),
).rejects.toThrow(BadRequestException);
```

Assert every manager query binds `tenantId`; an explicit unit is accepted only when the batch is
actually present there.

- [ ] **Step 2: Run unit-membership tests and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=unit-for-batch.util.spec.ts
```

Expected: FAIL because the utility does not exist.

- [ ] **Step 3: Implement the minimal membership resolver**

Query active batch locations with the supplied manager and tenant. Return `null` for zero locations,
the unit ID for one, and throw for ambiguity or an explicit mismatch. Never accept explicit identity
without the membership query.

- [ ] **Step 4: Write RED biomass applier interaction tests**

Use typed manager/repository collaborators. Prove the service:

- locks the unit aggregate before reading detail rows;
- distributes a positive FCR delta proportionally and preserves total quantity;
- reconciles measured average weight across all active batch details;
- updates every aggregate using the same manager;
- stamps `fcr_projection` or `measurement` provenance with ISO time;
- computes projection error from the superseded projected weight;
- returns `null` and performs no save when fish count is zero;
- returns `null` without saves for non-finite/non-positive measured weight, rejects non-finite
  growth, and preserves finite negative growth for the existing `correctMealPour` reversal path
  without allowing any detail biomass below zero.

The measurement assertion must include:

```ts
expect(result).toEqual({
  projectedAvgWeightG: 100,
  measuredAvgWeightG: 112,
  projectionErrorPercent: 12,
  appliedDeltaKg: 12,
  fishCount: 1000,
});
expect(tankBatch.weightProvenance).toEqual(
  expect.objectContaining({
    source: 'measurement',
    measurementId,
    measuredAvgWeightG: 112,
    supersededProjectedAvgWeightG: 100,
  }),
);
```

- [ ] **Step 5: Run the biomass test and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=biomass-growth-applier.measurement.spec.ts
```

Expected: FAIL because `BiomassGrowthApplierService` and `weightProvenance` do not exist.

- [ ] **Step 6: Implement the minimal aggregate writer**

Add to `TankBatch`:

```ts
@Column({ type: 'jsonb', nullable: true })
weightProvenance?: TankWeightProvenance;
```

Extend the existing service with one private aggregate/stamp path used by both public write methods.
Preserve current lock order, preserve negative correction support in `applyGrowth()`, use no nested
transaction, round only at established entity boundaries, and save through repositories obtained
from the supplied manager. Verify the focused module created in Task 1 remains the sole
provider/export; neither parent module redeclares it, so Task 3 does not edit a module registration.

- [ ] **Step 7: Run the biomass and existing growth-rollup tests**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(biomass-growth-applier\.measurement|daily-feeding-growth-rollup)\.spec\.ts'
```

Expected: PASS and one provider instance owns biomass writes.

- [ ] **Step 8: Generate the provenance migration with a live monotonic timestamp**

Run:

```bash
MIGRATION_NAME=AddTankBatchWeightProvenance
LATEST_FARM_MIGRATION_TS="$(rg --files apps/farm-service/src/database/migrations | sed -nE 's#^.*/([0-9]{13})-.*\.ts$#\1#p' | sort -n | tail -1)"
WALL_CLOCK_TS="$(date -u +%s%3N)"
if (( 10#$WALL_CLOCK_TS > 10#$LATEST_FARM_MIGRATION_TS )); then FARM_MIGRATION_TS="$WALL_CLOCK_TS"; else FARM_MIGRATION_TS="$((10#$LATEST_FARM_MIGRATION_TS + 1))"; fi
F0_PROVENANCE_MIGRATION="apps/farm-service/src/database/migrations/${FARM_MIGRATION_TS}-${MIGRATION_NAME}.ts"
(
  cd apps/farm-service
  npx typeorm-ts-node-commonjs migration:generate \
    -d src/database/data-source.ts \
    -t "$FARM_MIGRATION_TS" \
    "src/database/migrations/${MIGRATION_NAME}"
)
test -f "$F0_PROVENANCE_MIGRATION"
test "$(git status --porcelain=v1 --untracked-files=all -- apps/farm-service/src/database/migrations | awk '$1 == "??" { count += 1 } END { print count + 0 }')" -eq 1
GENERATED_DIFF_STATUS=0
git diff --no-index -- /dev/null "$F0_PROVENANCE_MIGRATION" || GENERATED_DIFF_STATUS=$?
test "$GENERATED_DIFF_STATUS" -eq 1
```

Expected: the farm-local CommonJS runner creates exactly `$F0_PROVENANCE_MIGRATION`; its printed
generated diff contains only the nullable provenance column. Any other entity/table diff blocks
manual migration hardening until the entity graph is corrected.

- [ ] **Step 9: Make the generated migration replay-safe and tenant-fan-out safe**

Use `apply_patch` on `$F0_PROVENANCE_MIGRATION`. Keep table references current-schema relative. Add
the column as nullable `jsonb`, then add an idempotently guarded check requiring either SQL null or
a JSON object whose `source` is exactly `fcr_projection` or `measurement`; do not let SQL `CHECK`
null semantics admit a scalar/missing source. Implement `postCondition()` using `current_schema()`
plus `information_schema`. Do not synthesize provenance for existing rows. In `down()`, reject
before DDL if any non-null provenance exists; otherwise remove the check and nullable column under
the same schema validation/DDL-safety boundary. Add the class to `FARM_MIGRATIONS` in ascending
timestamp order.

- [ ] **Step 10: Write the migration contract test**

In `tank-batch-weight-provenance.migration.spec.ts`, locate the migration class by semantic
class-name prefix in `FARM_MIGRATIONS`, invoke `up()` on a typed `QueryRunner` mock, and assert the
captured SQL contains:

```text
ADD COLUMN IF NOT EXISTS "weightProvenance" jsonb
CHECK
jsonb_typeof
fcr_projection
measurement
current_schema()
```

Also assert it does not contain `UPDATE "tank_batches"`, `SET search_path =`, or a literal
`ALTER TABLE "farm".` prefix. Invoke `down()` with a typed empty-schema response and assert it
checks for non-null provenance before removing the constraint/column. Add a non-empty response and
prove `down()` throws before issuing destructive DDL.

In `tank-batch-weight-provenance.postgres.spec.ts`, apply `up()` to an isolated tenant schema and
prove valid measurement/FCR JSON is accepted while any other source is rejected. Exercise
`up() → down() → up()` before data exists. Then write valid provenance, call `down()`, and prove it
fails without removing the value, constraint, or column.

- [ ] **Step 11: Run migration and schema invariants**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=tank-batch-weight-provenance.migration.spec.ts
npx nx run farm-service:e2e --runInBand --testPathPatterns=tank-batch-weight-provenance.postgres.spec.ts
npm run gates:migration-sql -- --mode=file "$F0_PROVENANCE_MIGRATION"
npx nx test invariants --runInBand --testPathPatterns='(entity-diff-implies-migration|farm-service-migration-array-completeness|tenant-fanout-entity-parity)\.spec\.ts'
```

Expected: PASS; the linter reports no unsafe SQL, the manifest includes the generated class, and the
rollback contract is reversible only before provenance-bearing writes exist.

- [ ] **Step 12: Commit and push**

Run:

```bash
F0_BIOMASS_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: reconcile measured and projected biomass through one writer") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F0_BIOMASS_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/batch/entities/tank-batch.entity.ts \
  apps/farm-service/src/batch/utils/unit-for-batch.util.ts \
  apps/farm-service/src/batch/__tests__/unit-for-batch.util.spec.ts \
  apps/farm-service/src/feeding-protocol/services/biomass-growth-applier.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/biomass-growth-applier.measurement.spec.ts \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/src/database/migrations/__tests__/tank-batch-weight-provenance.migration.spec.ts \
  apps/farm-service/src/__tests__/e2e/tank-batch-weight-provenance.postgres.spec.ts \
  "$F0_PROVENANCE_MIGRATION"
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): reconcile biomass through one aggregate writer\n\nMeasured samples and FCR projection must update every biomass aggregate under one lock and record truthful provenance without creating a second stock authority.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F0_BIOMASS_FINDING_ID")"
git push
```

Expected: hooks pass and the migration path in the commit is the file generated during this task.

### Task 4: Make Weighing Recalculate the Day Plan in the Same Transaction

**Files:**

- Modify: `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts`
- Modify: `apps/farm-service/src/growth/__tests__/handlers/record-growth-sample.handler.spec.ts`
- Modify: `apps/farm-service/src/growth/growth.module.ts`
- Modify: `apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/day-plan-recalc.service.spec.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/weighing-drives-the-plan.spec.ts`
- Create: `apps/farm-service/src/__tests__/e2e/running-fcr-sweep.postgres.spec.ts`

**Interfaces:**

```ts
export type RecalcReason = RecalcLogEntry['reason'];

recalcForUnit(
  manager: EntityManager,
  tenantId: string,
  unitId: string,
  reason: RecalcReason,
  options?: { newTemperatureC?: number | null },
): Promise<RecalcResult | null>;
```

- Consumes `resolveUnitHoldingBatch()` and `BiomassGrowthApplierService` from Task 3.
- Produces an atomic handler path whose success means measurement, biomass aggregates, processed
  marker, and day plan all committed together.

- [ ] **Step 1: Write the RED handler interaction tests**

Assert this order on the same manager:

```ts
expect(runInTenantTransaction).toHaveBeenCalledWith(
  dataSource,
  'farm',
  tenantId,
  expect.any(Function),
);
expect(resolveUnitHoldingBatch).toHaveBeenCalledWith(manager, tenantId, batchId, tankId);
expect(growthApplier.lockUnitForGrowth).toHaveBeenCalledWith(manager, tenantId, tankId);
expect(growthApplier.reconcileMeasuredWeight).toHaveBeenCalledWith(
  manager,
  tenantId,
  lockedUnit,
  measuredAvgWeightG,
  expect.objectContaining({ source: 'measurement', measurementId }),
);
expect(dayPlanRecalc.recalcForUnit).toHaveBeenCalledWith(
  manager,
  tenantId,
  tankId,
  'growth_sample',
  expect.any(Object),
);
```

Add failure tests for explicit tank mismatch, ambiguous batch location, a resolved unit whose
aggregate cannot be locked, and `reconcileMeasuredWeight()` returning `null`. In each failure,
assert the sample is not marked processed and recalc is not invoked. Add a distinct no-location
case: lock the batch, call `stampBatchWeight()` with measured provenance, mark the sample processed,
omit tank recalc, and emit the event without `tankId`.

Add a separate `updateBatchWeight: false` case that preserves the established opt-out contract: save
the measurement, leave `isProcessed === false`, do not resolve/lock a unit or batch, do not call
`stampBatchWeight()`, `reconcileMeasuredWeight()`, or `recalcForUnit()`, and still enqueue one valid
`GrowthSampleRecorded` event without `tankId`. Assert an outbox failure rolls back the saved
measurement even on this opt-out path.

- [ ] **Step 2: Run handler tests and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=record-growth-sample.handler.spec.ts
```

Expected: FAIL because the handler does not call the new writer/recalc collaboration.

- [ ] **Step 3: Implement the minimal atomic handler path**

Use `runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => ...)` and
derive the sole `EntityManager` as `queryRunner.manager`. After saving the measurement, branch on
the persisted `saved.updateBatchWeight` value. When false, preserve the opt-out behavior above and
skip every biomass/recalc collaboration. When true, resolve and validate unit identity. If a unit
exists, lock its aggregate, prove the locked set contains the sampled batch, reconcile the measured
weight, reject a null reconciliation, mark the sample processed, and call `recalcForUnit()` before
the transaction callback returns. If the batch has no unit, lock the batch row and call
`stampBatchWeight()` using the sample's estimated biomass/population before marking it processed;
there is no unit plan to recalculate. Consume the sole providers from `FeedingCalculationModule`.

- [ ] **Step 4: Write and run the day-plan reason test**

Add a `day-plan-recalc.service.spec.ts` case that persists a recalc log entry with
`reason: 'growth_sample'` and uses the new measured weight for band/ration selection.

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=day-plan-recalc.service.spec.ts
```

Expected before the entity/service change: FAIL because `'growth_sample'` is not admitted by the
reason type or persistence mapping. Expected after the minimal change: PASS.

- [ ] **Step 5: Add the vertical weighing-to-plan test**

In `weighing-drives-the-plan.spec.ts`, use real domain services with mocked repositories/outbox
only. Record a sample that moves average weight across a protocol band and assert the recalculated
day plan uses the new band and rate in the same transaction callback. Record a second sample with
`updateBatchWeight: false` and assert the plan, aggregate, provenance, and processed marker remain
unchanged while the measurement and event commit.

- [ ] **Step 6: Run the F0 vertical tests**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(record-growth-sample\.handler|day-plan-recalc\.service|weighing-drives-the-plan|biomass-growth-applier\.measurement)\.spec\.ts'
```

Expected: PASS; null reconciliation and identity mismatch leave no processed sample.

- [ ] **Step 7: Add the PostgreSQL running-FCR proof**

Create one tenant schema with an active unit protocol, batch details, tank aggregate, feed storage
lot, and day plan. Execute one feeding through `FeedingLedgerService`, run the FCR sweep, then
record a measured sample. Assert feed stock decreases exactly once, projected biomass increases
through `BiomassGrowthApplierService`, measured reconciliation supersedes projected provenance, and
the day plan moves to the measured band. In the same PostgreSQL suite, record an opt-out sample and
prove measurement/event persistence with byte-identical batch/tank/day-plan rows and
`isProcessed = false`. No assertion may read or write `feed_inventory`.

Run:

```bash
npx nx run farm-service:e2e --runInBand --testPathPatterns=running-fcr-sweep.postgres.spec.ts
```

Expected: PASS with the storage ledger and biomass writer as separate single authorities.

- [ ] **Step 8: Commit and push the atomic weighing-to-plan wiring**

Run:

```bash
F0_RECALC_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: recalculate ration plans atomically after weighing") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F0_RECALC_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts \
  apps/farm-service/src/growth/__tests__/handlers/record-growth-sample.handler.spec.ts \
  apps/farm-service/src/growth/growth.module.ts \
  apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts \
  apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/day-plan-recalc.service.spec.ts \
  apps/farm-service/src/feeding-protocol/__tests__/weighing-drives-the-plan.spec.ts \
  apps/farm-service/src/__tests__/e2e/running-fcr-sweep.postgres.spec.ts
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): recalculate ration plans after weighing\n\nA successful measurement must reconcile biomass, mark processing, and refresh the affected unit plan inside one tenant transaction.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F0_RECALC_FINDING_ID")"
git push
```

Expected: hooks pass and the vertical behavior has its own traceable reviewer boundary.

### Task 5: Add Growth Event Contract, Producer, and Stock Projection Parity

**Files:**

- Modify: `libs/event-contracts/src/farm-events.ts`
- Modify: `libs/event-contracts/src/schemas/farm-events.schema.ts`
- Create: `libs/event-contracts/src/schemas/__tests__/growth-sample-recorded.schema.spec.ts`
- Modify: `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts`
- Modify: `apps/farm-service/src/growth/__tests__/handlers/record-growth-sample.handler.spec.ts`
- Modify: `apps/farm-service/src/events/listeners/farm-stock-projection.listener.ts`
- Modify: `apps/farm-service/src/events/listeners/__tests__/farm-stock-projection.listener.spec.ts`

**Interfaces:**

```ts
export interface GrowthSampleRecordedEvent extends BaseEvent {
  readonly eventType: 'GrowthSampleRecorded';
  readonly batchId: string;
  readonly measurementId: string;
  readonly sampleSize: number;
  readonly averageWeightG: number;
  readonly weightCV: number;
  readonly measurementDate: string;
  readonly performance?: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
  readonly tankId?: string;
}
```

- `tankId` is additive and optional; `GrowthSampleRecorded` remains version 1.
- Produces validator/producer/listener parity before any event contains the new field.

- [ ] **Step 1: Write RED schema acceptance and rejection tests**

Build fixtures through `createBaseEvent<GrowthSampleRecordedEvent>()`. Assert:

```ts
expect(validateFarmEvent('GrowthSampleRecorded', validWithoutTank)).toEqual({ valid: true });
expect(validateFarmEvent('GrowthSampleRecorded', validWithTank)).toEqual({ valid: true });
expect(validateFarmEvent('GrowthSampleRecorded', invalidTank).valid).toBe(false);
expect(validateFarmEvent('GrowthSampleRecorded', extraProperty).valid).toBe(false);
```

Also reject non-UUID IDs, non-positive sample size, non-positive weight, malformed ISO date, wrong
event discriminator, and version other than 1 for this event.

- [ ] **Step 2: Run event-contract test and verify RED**

Run:

```bash
npx nx test event-contracts --runInBand --testPathPatterns=growth-sample-recorded.schema.spec.ts
```

Expected: FAIL because the farm schema map does not contain `GrowthSampleRecorded` with `tankId`.

- [ ] **Step 3: Implement the minimal interface and AJV schema**

Add the interface to the farm union and the exact wire schema to `FARM_EVENT_SCHEMAS`. Use
`UUID_SCHEMA`, `OPTIONAL_UUID_SCHEMA`, shared base properties, `additionalProperties: false`, and a
version constraint of 1. Do not add an upcaster for this additive optional field.

- [ ] **Step 4: Run schema tests and verify GREEN**

Run:

```bash
npx nx test event-contracts --runInBand --testPathPatterns=growth-sample-recorded.schema.spec.ts
```

Expected: PASS for both legacy and tank-aware payloads.

- [ ] **Step 5: Write RED producer and stock-listener tests**

In the handler test, capture the event enqueued with the same manager and assert
`validateFarmEvent('GrowthSampleRecorded', event).valid` is true, `event.version === 1`, and
`event.tenantId`/`event.tankId` equal the transaction tenant/resolved unit. Spy on the production
validator boundary and prove it runs before `outboxPublisher.enqueue()`. Force an invalid result and
assert zero enqueue plus transaction rejection, including the `updateBatchWeight: false` path.

In the projection-listener test, create the event with `createBaseEvent()`, assert it is accepted as
the eighth refresh type, and assert `FarmStockProjectionService.refreshContainers()` receives the
transaction manager, event tenant, and one-element tank array. Deliver structurally invalid,
semantic-invalid, version 0, version 2, invalid-tenant, and absent-tank cases; every invalid event
must be rejected by `validateFarmEvent()` before tenant transaction creation with zero refresh.
Deliver the valid event twice and prove both idempotent recomputations complete without creating a
second stock mutation authority.

- [ ] **Step 6: Run producer/listener tests and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(record-growth-sample\.handler|farm-stock-projection\.listener)\.spec\.ts'
```

Expected: FAIL because the producer does not emit resolved tank identity and the listener does not
include this event type.

- [ ] **Step 7: Implement producer/listener parity**

Build the event through:

```ts
const event: GrowthSampleRecordedEvent = {
  ...createBaseEvent<GrowthSampleRecordedEvent>('GrowthSampleRecorded', tenantId, {
    aggregateId: saved.id,
    aggregateType: 'GrowthMeasurement',
    userId,
  }),
  batchId: saved.batchId,
  measurementId: saved.id,
  sampleSize: saved.sampleSize,
  averageWeightG: saved.averageWeight,
  weightCV: saved.weightCV,
  measurementDate: toEventIso(saved.measurementDate),
  ...(saved.performance ? { performance: saved.performance } : {}),
  ...(resolvedUnitId ? { tankId: resolvedUnitId } : {}),
};
```

Enqueue through the established outbox using the handler transaction manager. Add
`GrowthSampleRecorded` to the stock listener’s supported set; keep its existing tenant UUID guard,
`runInTenantTransaction()` boundary, idempotent snapshot recomputation, and retry-on-failure
behavior.

Immediately before enqueue, call `validateFarmEvent('GrowthSampleRecorded', event)`. If invalid,
throw a fail-closed internal contract error without logging IDs or the payload; let it escape the
tenant transaction so measurement, processed marker, biomass, plan, and outbox all roll back. At the
listener trust boundary, when `event.eventType === 'GrowthSampleRecorded'`, run the same real
validator before reading `tenantId` or extracting containers. Log only a bounded reason code for
rejection and return without opening a transaction. Do not narrow the event through an assertion
before validation.

- [ ] **Step 8: Run event and stock projection suites**

Run:

```bash
npx nx test event-contracts --runInBand --testPathPatterns=growth-sample-recorded.schema.spec.ts
npx nx test farm-service --runInBand --testPathPatterns='(record-growth-sample\.handler|farm-stock-projection\.listener|weighing-drives-the-plan)\.spec\.ts'
```

Expected: PASS with contract, validator, producer, and listener field parity; invalid producer state
rolls back and invalid consumer input performs no tenant-scoped work.

- [ ] **Step 9: Commit and push**

Run:

```bash
F0_GROWTH_EVENT_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: validate growth sample tank projection parity") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F0_GROWTH_EVENT_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  libs/event-contracts/src/farm-events.ts \
  libs/event-contracts/src/schemas/farm-events.schema.ts \
  libs/event-contracts/src/schemas/__tests__/growth-sample-recorded.schema.spec.ts \
  apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts \
  apps/farm-service/src/growth/__tests__/handlers/record-growth-sample.handler.spec.ts \
  apps/farm-service/src/events/listeners/farm-stock-projection.listener.ts \
  apps/farm-service/src/events/listeners/__tests__/farm-stock-projection.listener.spec.ts
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(events): project growth samples by validated tank\n\nThe growth event must carry the resolved unit identity through a strict v1 schema so stock refreshes the same aggregate that weighing changed.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F0_GROWTH_EVENT_FINDING_ID")"
git push
```

Expected: hooks pass and no source-branch event object is copied inline.

- [ ] **Step 10: Merge and deploy the F0 expansion before contraction**

Run the F0-focused portions of Task 17 Steps 3–9 against the exact expansion-branch base and `HEAD`,
including production dependency classification. Push any evidence-only commit, open a protected PR
from `feat/feeding-f0-weighing-authority` to `main`, require review and all checks, and merge it
using the strategy defined in the branch-boundary section. Have the coordinator capture the
immutable `weighing-authority-expand` boundary inputs for the later F0 merge record, without writing
`merge.json` or the central ledger yet, then deploy that exact main SHA to every farm-service
instance.

After capture and deployment, remove only the clean coordinator-pinned implementation worktree:

```bash
SLICE_ID=F0
BOUNDARY_ID=weighing-authority-expand
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
test "$BOUNDARY_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-f0-weighing-authority-expand
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --slice "$SLICE_ID" \
  --boundary "$BOUNDARY_ID" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$BOUNDARY_WORKTREE"
```

Expected: the expansion PR and coordinator-captured boundary SHA are `origin/main`-reachable,
deployment reports the same full SHA on every instance, unit-protocol readers and generated clients
are live, and the legacy column still exists. Do not begin Task 6 on the expansion branch.

### Task 6: Contract the `Batch.protocolId` Application Surface While Retaining Storage

**Hard release gate:** Begin this task only after the F0 expansion commits from Tasks 1–5 are
deployed to every farm-service instance and every current generated client is proven able to build
without selecting `Batch.protocolId`. This task contracts application metadata and GraphQL only; the
physical database column must remain present throughout its merge and deployment.

**Files:**

- Modify: `apps/farm-service/src/batch/entities/batch.entity.ts`
- Modify: `apps/farm-service/src/batch/entities/batch.types.ts`
- Modify: `apps/farm-service/schema.graphql`
- Modify: `web/shared-ui/src/generated/graphql-types.ts`
- Create: `apps/farm-service/src/batch/__tests__/batch-protocol-id-retired.architecture.spec.ts`
- Create: `apps/farm-service/src/__tests__/e2e/batch-protocol-id-app-contraction.postgres.spec.ts`
- Create: `docs/evidence/aquamobil-v4-feeding/f0-reader-cutover.md`

**Interfaces:**

- Consumes the deployed unit-protocol reader authority from Tasks 1–2.
- Removes the retired entity/type/GraphQL application surface while deliberately retaining the
  physical `batches_v2.protocolId` column for old-binary rollback safety.
- Produces a deployed application fleet and semantic-parity evidence consumed by Task 7; it issues
  no DDL and never edits `FARM_MIGRATIONS`.

- [ ] **Step 0: Create the clean F0 contraction release branch**

Run only after the Task 5 expansion merge, coordinator capture, and deployment are complete:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice F0 \
  --boundary batch-protocol-reader-contract \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-f0-batch-protocol-reader-contract
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
: "${F0_EXPANSION_MAIN_SHA:?export the full main SHA emitted by coordinator capture}"
printf '%s\n' "$F0_EXPANSION_MAIN_SHA" | rg -q '^[0-9a-f]{40}$'
git merge-base --is-ancestor "$F0_EXPANSION_MAIN_SHA" origin/main
```

Expected: the clean branch contains the coordinator-captured expansion boundary, and every running
farm-service reports that deployed SHA before an application-surface edit. If `origin/main` advanced
after that deployment, redeploy the new branch base and repeat the reader/client proof; do not
contract against a different running commit.

- [ ] **Step 1: Capture deployed reader and client evidence**

Create the evidence directory, then record the deployed farm-service image/commit, rollout
completion time, and successful GraphQL client build in
`docs/evidence/aquamobil-v4-feeding/f0-reader-cutover.md`:

```bash
mkdir -p docs/evidence/aquamobil-v4-feeding
```

Include command output from the syntax-aware invariant and generated-client build:

```bash
npx nx test invariants --runInBand --testPathPatterns=feeding-ration-authority.spec.ts
npm run codegen:check
```

Expected: the AST invariant proves no runtime read of the retired batch field. Computed traceability
DTO `protocolId` fields are allowed only when their source is the active unit assignment and must be
named explicitly in the evidence document.

- [ ] **Step 2: Prove semantic parity for every retained legacy value**

Run against a production snapshot or pre-production clone using a read-only database role:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;
DO $contract$
DECLARE
  tenant_schema text;
  parity record;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name = 'farm'
       OR schema_name ~ '^tenant_[0-9a-f]{16}$'
    ORDER BY schema_name
  LOOP
    EXECUTE format(
      $query$
      WITH location_candidates AS (
        SELECT tb."tenantId",
               tb."tankId" AS unit_id,
               tb."primaryBatchId"::text AS batch_id
        FROM %1$I.tank_batches tb
        JOIN %1$I.tanks t
          ON t."tenantId" = tb."tenantId"
         AND t.id = tb."tankId"
         AND t."isActive" = true
        WHERE tb."primaryBatchId" IS NOT NULL

        UNION

        SELECT tb."tenantId",
               tb."tankId" AS unit_id,
               detail.item ->> 'batchId' AS batch_id
        FROM %1$I.tank_batches tb
        JOIN %1$I.tanks t
          ON t."tenantId" = tb."tenantId"
         AND t.id = tb."tankId"
         AND t."isActive" = true
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(tb."batchDetails") = 'array' THEN tb."batchDetails"
            ELSE '[]'::jsonb
          END
        ) AS detail(item)
        WHERE detail.item ? 'batchId'
      ),
      legacy AS (
        SELECT b.id,
               b."tenantId",
               b."protocolId",
               count(DISTINCT lc.unit_id) AS location_count,
               min(lc.unit_id::text) AS unit_id
        FROM %1$I.batches_v2 b
        LEFT JOIN location_candidates lc
          ON lc."tenantId" = b."tenantId"
         AND lc.batch_id = b.id::text
        WHERE b."protocolId" IS NOT NULL
        GROUP BY b.id, b."tenantId", b."protocolId"
      ),
      checked AS (
        SELECT l.id,
               l."protocolId",
               l.location_count,
               count(pa.id) AS active_assignment_count,
               count(p.id) AS active_binding_count,
               count(p.id) FILTER (WHERE p.id = l."protocolId") AS matching_binding_count
        FROM legacy l
        LEFT JOIN %1$I.feeding_protocol_assignments pa
          ON l.location_count = 1
         AND pa."tenantId" = l."tenantId"
         AND pa."unitId"::text = l.unit_id
         AND pa.status = 'active'
        LEFT JOIN %1$I.feeding_protocols_v2 p
          ON p."tenantId" = pa."tenantId"
         AND p.id = pa."protocolId"
         AND p.status = 'active'
         AND p."isDeleted" = false
        GROUP BY l.id, l."protocolId", l.location_count
      )
      SELECT count(*) AS legacy_non_null,
             count(*) FILTER (
               WHERE location_count = 1
                 AND active_assignment_count = 1
                 AND active_binding_count = 1
                 AND matching_binding_count = 1
             ) AS matched,
             count(*) FILTER (WHERE location_count = 0) AS missing_location,
             count(*) FILTER (WHERE location_count > 1) AS ambiguous_location,
             count(*) FILTER (
               WHERE location_count = 1 AND active_assignment_count = 0
             ) AS missing_assignment,
             count(*) FILTER (
               WHERE location_count = 1 AND active_assignment_count > 1
             ) AS ambiguous_assignment,
             count(*) FILTER (
               WHERE location_count = 1
                 AND active_assignment_count = 1
                 AND active_binding_count = 0
             ) AS inactive_or_missing_protocol,
             count(*) FILTER (
               WHERE location_count = 1
                 AND active_assignment_count = 1
                 AND active_binding_count = 1
                 AND matching_binding_count = 0
             ) AS protocol_mismatch
      FROM checked
      $query$,
      tenant_schema
    ) INTO parity;

    RAISE NOTICE
      'schema=% legacy_non_null=% matched=% missing_location=% ambiguous_location=% missing_assignment=% ambiguous_assignment=% inactive_or_missing_protocol=% protocol_mismatch=%',
      tenant_schema,
      parity.legacy_non_null,
      parity.matched,
      parity.missing_location,
      parity.ambiguous_location,
      parity.missing_assignment,
      parity.ambiguous_assignment,
      parity.inactive_or_missing_protocol,
      parity.protocol_mismatch;

    IF parity.legacy_non_null <> parity.matched THEN
      RAISE EXCEPTION
        'schema % has % unresolved legacy protocol mappings; contraction blocked',
        tenant_schema,
        parity.legacy_non_null - parity.matched;
    END IF;
  END LOOP;
END
$contract$;
ROLLBACK;
SQL
```

Expected: one count-only notice per source/tenant schema and no exception. The read-only transaction
and `row_security = off` make an under-privileged audit fail instead of silently returning an
RLS-filtered zero count. `legacy_non_null` may be greater than zero, but it must equal `matched`;
every missing location, ambiguous location, missing/ambiguous active assignment, inactive/missing
protocol, and protocol mismatch count must be zero. Record the notices in `f0-reader-cutover.md`.
Any discrepancy blocks contraction and requires an explicit, reviewed correction through the
canonical unit-location/assignment model; never null or rewrite `batches_v2.protocolId` merely to
make this gate pass.

- [ ] **Step 3: Write the RED retirement architecture test**

Assert the `Batch` entity metadata, emitted farm SDL, and production-reader AST contain no legacy
batch protocol property/field. Keep `protocolId` on computed traceability response types when
sourced from the unit assignment. In `batch-protocol-id-app-contraction.postgres.spec.ts`, boot the
contracted entity graph against a schema whose `batches_v2.protocolId` column and non-null sample
value still exist, then prove reads, writes of unrelated batch fields, and startup drift checks
succeed without deleting or rewriting that column.

- [ ] **Step 4: Run the retirement test and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=batch-protocol-id-retired.architecture.spec.ts
```

Expected: FAIL because `Batch.protocolId` still exists during expansion.

- [ ] **Step 5: Remove the entity and public GraphQL field, then regenerate clients**

Use `apply_patch` to remove only the retired `Batch.protocolId` entity/type declaration and its
direct GraphQL exposure. Do not generate a migration and do not edit the manifest. Run:

```bash
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
npx nx run farm-service:e2e --runInBand --testPathPatterns=batch-protocol-id-app-contraction.postgres.spec.ts
```

Expected: farm SDL is regenerated from the modified entity/resolver graph before composition;
composition and code generation pass; generated selections compile without the field; and PostgreSQL
proves the legacy column remains present and untouched.

- [ ] **Step 6: Commit and push the application-only contraction**

Run:

```bash
F0_APP_CONTRACTION_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: contract legacy batch protocol identity after reader rollout") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F0_APP_CONTRACTION_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/batch/entities/batch.entity.ts \
  apps/farm-service/src/batch/entities/batch.types.ts \
  apps/farm-service/src/batch/__tests__/batch-protocol-id-retired.architecture.spec.ts \
  apps/farm-service/src/__tests__/e2e/batch-protocol-id-app-contraction.postgres.spec.ts \
  apps/farm-service/schema.graphql \
  web/shared-ui/src/generated/graphql-types.ts \
  docs/evidence/aquamobil-v4-feeding/f0-reader-cutover.md
git diff --cached --check
if git diff --cached --name-only | rg '^apps/farm-service/src/database/migrations/|^apps/farm-service/src/database/migrations/manifest\.ts$'; then
  exit 1
fi
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'refactor(farm): contract batch protocol readers\n\nApplication metadata and generated clients must stop exposing the retired batch identity while the physical column remains available to every old binary during rollback.\n\nBREAKING CHANGE: Batch.protocolId is removed from the public GraphQL Batch type; the database column is retained until the next deployed release gate.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F0_APP_CONTRACTION_FINDING_ID")"
git push
```

Expected: hooks pass, no migration or manifest path is staged, and the breaking footer describes
only the public/application contraction.

- [ ] **Step 7: Merge and deploy the contracted application before any column DDL**

Run the F0 application-focused Task 17 domain, AST, PostgreSQL-retained-column, generator, affected,
and dependency gates. Open a protected PR from `refactor/feeding-f0-batch-protocol-reader-contract`
to `main`, require review, and merge. Record its protected PR/full main SHA as boundary
`batch-protocol-reader-contract` for the later immutable F0 merge record, without editing central
evidence. Deploy that exact SHA to every farm-service instance, prove no older farm-service image
remains, rerun the retained-column PostgreSQL test against the deployment schema, and attach rollout
evidence.

Then clean the exact implementation worktree:

```bash
SLICE_ID=F0
BOUNDARY_ID=batch-protocol-reader-contract
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
test "$BOUNDARY_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-f0-batch-protocol-reader-contract
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --slice "$SLICE_ID" \
  --boundary "$BOUNDARY_ID" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$BOUNDARY_WORKTREE"
```

Expected: the contracted app is live everywhere, the physical column and all original values are
still present, and Task 7 has not started.

### Task 7: Drop the Physical Batch Protocol Column After Fleet Cutover

**Hard release gate:** Begin only after Task 6's protected-main SHA is deployed on every
farm-service instance, rollback images are known to tolerate the contracted GraphQL surface, and the
semantic-parity audit has zero discrepancy in every tenant schema.

**Files:**

- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Create at execution: `$F0_PROTOCOL_DROP_MIGRATION`, resolved by the monotonic procedure with
  semantic name `RemoveLegacyBatchProtocolId`
- Create:
  `apps/farm-service/src/database/migrations/__tests__/batch-protocol-id-contraction.migration.spec.ts`
- Create: `apps/farm-service/src/__tests__/e2e/batch-protocol-id-contraction.postgres.spec.ts`
- Create: `docs/evidence/aquamobil-v4-feeding/f0-column-drop.md`

**Interfaces:**

- Consumes the deployed Task 6 application contraction and count-only parity output.
- Drops only `current_schema().batches_v2.protocolId`; it changes no entity, GraphQL, or generated
  client because those surfaces were already contracted and deployed.

- [ ] **Step 0: Create the physical-drop branch from the deployed app-contraction main SHA**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice F0 \
  --boundary batch-protocol-physical-contract \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-f0-batch-protocol-physical-contract
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
: "${F0_APP_CONTRACTION_MAIN_SHA:?export the full main SHA emitted by coordinator capture}"
printf '%s\n' "$F0_APP_CONTRACTION_MAIN_SHA" | rg -q '^[0-9a-f]{40}$'
git merge-base --is-ancestor "$F0_APP_CONTRACTION_MAIN_SHA" origin/main
```

Expected: `origin/main` is the exact deployed `batch-protocol-reader-contract` boundary captured by
the coordinator; otherwise redeploy/reprove before continuing.

- [ ] **Step 1: Reattest fleet and data immediately before generation**

Create `f0-column-drop.md` with the full deployed SHA, image digests for every replica, rollout
completion time, retained-column query output, and a fresh execution of the read-only semantic
classification from Task 6 Step 2. Require `legacy_non_null = matched` and zero missing/ambiguous
location, missing/ambiguous assignment, inactive/missing protocol, and protocol mismatch in every
schema. Record the database snapshot identifier and command exit status. Any mismatch or old image
blocks this task; do not mutate legacy values.

- [ ] **Step 2: Generate and inspect the exact physical drop**

Run:

```bash
MIGRATION_NAME=RemoveLegacyBatchProtocolId
LATEST_FARM_MIGRATION_TS="$(rg --files apps/farm-service/src/database/migrations | sed -nE 's#^.*/([0-9]{13})-.*\.ts$#\1#p' | sort -n | tail -1)"
WALL_CLOCK_TS="$(date -u +%s%3N)"
if (( 10#$WALL_CLOCK_TS > 10#$LATEST_FARM_MIGRATION_TS )); then FARM_MIGRATION_TS="$WALL_CLOCK_TS"; else FARM_MIGRATION_TS="$((10#$LATEST_FARM_MIGRATION_TS + 1))"; fi
F0_PROTOCOL_DROP_MIGRATION="apps/farm-service/src/database/migrations/${FARM_MIGRATION_TS}-${MIGRATION_NAME}.ts"
(
  cd apps/farm-service
  npx typeorm-ts-node-commonjs migration:generate \
    -d src/database/data-source.ts \
    -t "$FARM_MIGRATION_TS" \
    "src/database/migrations/${MIGRATION_NAME}"
)
test -f "$F0_PROTOCOL_DROP_MIGRATION"
test "$(git status --porcelain=v1 --untracked-files=all -- apps/farm-service/src/database/migrations | awk '$1 == "??" { count += 1 } END { print count + 0 }')" -eq 1
GENERATED_DIFF_STATUS=0
git diff --no-index -- /dev/null "$F0_PROTOCOL_DROP_MIGRATION" || GENERATED_DIFF_STATUS=$?
test "$GENERATED_DIFF_STATUS" -eq 1
```

Expected: the complete generated diff drops only `batches_v2.protocolId`. Any additional table,
column, index, constraint, or enum diff blocks migration editing.

- [ ] **Step 3: Add in-migration semantic parity and fail-closed rollback**

Add the exact migration-lint destructive marker referencing `f0-column-drop.md`. Before
`DROP COLUMN`, have `up()` derive candidates from active `tank_batches` primary/batch-detail
membership, require one distinct active unit per non-null batch protocol, join exactly one active
tenant-matching protocol assignment and one active/non-deleted matching v2 protocol, and throw when
any classification count differs from zero. Run that classification inside `current_schema()` and
`withDdlSafety()` immediately before DDL; never update/null the legacy column. Add a post-condition
proving the column is absent.

Because committed physical deletion cannot reconstruct null/non-null row history, `down()` throws a
forward-only error referencing the evidence before issuing DDL. Register the generated class in
`FARM_MIGRATIONS` in timestamp order.

- [ ] **Step 4: Prove destructive behavior and time-of-check safety**

The structural test asserts semantic classification precedes the one intended drop, current schema
is runtime-derived, no legacy value is written, the destructive evidence marker is exact, and
`down()` rejects before SQL. The PostgreSQL suite covers zero legacy values, exact non-null parity,
missing/two locations, missing/two assignments, inactive/deleted protocol, and mismatch. Only the
first two drop the column. Every rejection leaves the column, values, locations, and assignments
unchanged.

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=batch-protocol-id-contraction.migration.spec.ts
npx nx run farm-service:e2e --runInBand --testPathPatterns=batch-protocol-id-contraction.postgres.spec.ts
npm run gates:migration-sql -- --mode=file "$F0_PROTOCOL_DROP_MIGRATION"
npx nx test invariants --runInBand --testPathPatterns='(entity-diff-implies-migration|farm-service-migration-array-completeness)\.spec\.ts'
```

Expected: PASS; the migration reruns parity inside the destructive transaction and cannot silently
manufacture a successful count.

- [ ] **Step 5: Commit and push the physical drop**

```bash
F0_COLUMN_DROP_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: drop retired batch protocol column after application contraction") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F0_COLUMN_DROP_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/src/database/migrations/__tests__/batch-protocol-id-contraction.migration.spec.ts \
  apps/farm-service/src/__tests__/e2e/batch-protocol-id-contraction.postgres.spec.ts \
  docs/evidence/aquamobil-v4-feeding/f0-column-drop.md \
  "$F0_PROTOCOL_DROP_MIGRATION"
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'refactor(farm): drop retired batch protocol column\n\nThe application contraction is deployed everywhere and the migration rechecks every non-null legacy mapping before removing the physical second authority.\n\nBREAKING CHANGE: The retired batches_v2.protocolId database column is removed.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F0_COLUMN_DROP_FINDING_ID")"
git push
```

Expected: hooks pass and only migration/evidence paths are staged.

- [ ] **Step 6: Merge and deploy the physical drop**

Run Task 17's F0 migration/PostgreSQL/invariant/dependency gates, merge the protected PR from
`refactor/feeding-f0-batch-protocol-column-drop`, and capture it as
`batch-protocol-physical-contract`. Deploy the physical boundary and verify the column is absent in
every tenant schema, then clean the exact implementation worktree:

```bash
SLICE_ID=F0
BOUNDARY_ID=batch-protocol-physical-contract
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
test "$BOUNDARY_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-f0-batch-protocol-physical-contract
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --slice "$SLICE_ID" \
  --boundary "$BOUNDARY_ID" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$BOUNDARY_WORKTREE"
```

After all three exact F0 boundary attestations exist, create the distinct serialized F0
reconciliation branch, write `slices/F0/merge.json`, regenerate the central ledger only with
`reconcile-ledger.mjs --slice F0 --write`, and merge that reconciliation PR. F1a cannot begin before
the reconciliation main SHA is reachable and provenance verification passes.

Expected: three ordered F0 main SHAs—expansion, application contraction, and column drop—are
protected-main ancestors with distinct deployment evidence.

---

## F1a — Feeder Model, Database Share Invariant, and Hardware Compatibility

### Task 8: Expand Hardware Compatibility to a Dual-Written Native Array

**F1a execution order:** Execute Task 8, then Tasks 10–11 on the same additive branch, merge/deploy
that complete boundary, and only then return to Task 9 for its reader and physical contractions.
This order is authoritative; the task numbers remain stable for cross-plan references.

**Files:**

- Create through the program capture tool:
  `docs/superpowers/evidence/aquamobil-v4/slices/F1a/preflight.json`
- Modify: `apps/farm-service/src/equipment/entities/sub-equipment-type.entity.ts`
- Create: `apps/farm-service/src/equipment/utils/sub-equipment-compatibility.util.ts`
- Create: `apps/farm-service/src/equipment/__tests__/sub-equipment-compatibility.util.spec.ts`
- Modify: `apps/farm-service/src/equipment/seeds/equipment-types.seed.ts`
- Create: `apps/farm-service/src/equipment/__tests__/equipment-types.seed.spec.ts`
- Modify: `apps/farm-service/src/database/services/farm-seed.service.ts`
- Modify: `apps/farm-service/src/equipment/handlers/get-sub-equipment-types.handler.ts`
- Create: `apps/farm-service/src/equipment/__tests__/get-sub-equipment-types.handler.spec.ts`
- Modify: `apps/farm-service/src/equipment/handlers/create-sub-equipment.handler.ts`
- Create: `apps/farm-service/src/equipment/__tests__/create-sub-equipment.handler.spec.ts`
- Modify: `apps/farm-service/src/equipment/dto/sub-equipment.response.ts`
- Create: `apps/farm-service/src/equipment/__tests__/sub-equipment.response.spec.ts`
- Modify: `apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts`
- Create: `apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.handler.spec.ts`
- Modify: `web/modules/farm-module/src/pages/setup/tabs/EquipmentTab.tsx`
- Create:
  `web/modules/farm-module/src/pages/setup/tabs/__tests__/EquipmentTab.feeder-selection.spec.tsx`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Create at execution: `$F1A_COMPAT_EXPANSION_MIGRATION`, resolved by the monotonic procedure with
  semantic name `ExpandSubEquipmentCompatibilityArray`
- Create:
  `apps/farm-service/src/database/migrations/__tests__/sub-equipment-compatibility-expand.migration.spec.ts`
- Create: `apps/farm-service/src/__tests__/e2e/sub-equipment-compatibility-expand.postgres.spec.ts`
- Create: `docs/evidence/aquamobil-v4-feeding/f1a-compatibility-reader-cutover.md`

**Interfaces:**

```ts
export interface SubEquipmentTypeDeclaration {
  readonly name: string;
  readonly code: string;
  readonly description: string;
  readonly specificationSchema: Record<string, unknown>;
}

export interface SubEquipmentTypeSeed extends SubEquipmentTypeDeclaration {
  readonly compatibleEquipmentTypeCodes: readonly string[];
  readonly sortOrder: number;
}

export function buildSubEquipmentTypeSeed(
  equipmentTypes: readonly EquipmentTypeSeed[],
  declarations: readonly SubEquipmentTypeDeclaration[],
): SubEquipmentTypeSeed[];

export function readCompatibilityCodes(row: {
  readonly compatibleEquipmentTypeCodes?: readonly string[] | null;
  readonly compatibleEquipmentTypesLegacy?: string | null;
}): readonly string[];
```

- The existing physical scalar remains `compatibleEquipmentTypes`; the additive physical array is
  `compatibleEquipmentTypeCodes text[]`.
- New readers use only the array after migration. During the rolling window, new writers set both
  representations and a schema-local trigger keeps old-binary scalar writes coherent.
- `EQUIPMENT_TYPES_SEED[].allowedSubEquipmentTypes` remains the only hand-authored compatibility
  direction; GraphQL continues exposing `compatibleEquipmentTypes` through explicit DTO mapping.

- [ ] **Step 0: Create the F1a additive worktree and capture its sole preflight**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice F1a \
  --boundary compatibility-and-feeder-model-expand \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-f1a-compatibility-and-feeder-model-expand
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
```

Expected: all three ordered F0 boundaries are protected-main ancestors, the immutable F0
`implementationBoundaries` array matches the pinned ID set, and the serialized F0 reconciliation is
on main. Run the program plan's exact preflight audit/explain capture for F1a, then write/check only
`slices/F1a/preflight.json` with `capture-slice-audit.mjs`; no central or foreign-slice evidence
path may change.

- [ ] **Step 1: Write RED catalog and compatibility-boundary tests**

Prove the inverse builder maps `hopper` only to `auto-feeder`, deterministically sorts codes, and
rejects duplicate declarations, unknown references, unreachable declarations, empty/comma-bearing
codes, and duplicate equipment codes. Distinguish top-level dosing equipment from sub-equipment code
`feed-drop-point` and preserve referenced row identity during the rename.

For `readCompatibilityCodes()`, prefer a present array (including empty array), parse/trim the
legacy scalar only when the array is null during migration, reject divergent duplicate/empty codes,
and return a frozen sorted copy. No application reader may perform its own comma split.

- [ ] **Step 2: Add the expansion entity shape and exact reader/writer tests**

Map both physical columns during the rolling window:

```ts
@Column({ name: 'compatibleEquipmentTypes', type: 'text' })
compatibleEquipmentTypesLegacy!: string;

@Column('text', { name: 'compatibleEquipmentTypeCodes', array: true, nullable: true })
compatibleEquipmentTypeCodes?: string[];
```

Write RED tests proving `GetSubEquipmentTypesHandler` binds `[code]::text[]` and queries
`compatibleEquipmentTypeCodes @> :codes`, so `feed` cannot match `auto-feeder`.
`CreateSubEquipmentHandler` and response mapping must call `readCompatibilityCodes()`; seeded writes
must persist the same deterministic codes to the new array and comma-joined legacy scalar.
Calibration and setup-UI selection must use normalized `EquipmentType.category === FEEDING`, never a
code prefix.

Run the RED cluster, implement the minimal catalog/helper/readers/dual writers, then rerun:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(equipment-types\.seed|sub-equipment-compatibility\.util|get-sub-equipment-types\.handler|create-sub-equipment\.handler|sub-equipment\.response|save-feeder-calibrations\.handler)\.spec\.ts'
npm --prefix web/modules/farm-module run test -- src/pages/setup/tabs/__tests__/EquipmentTab.feeder-selection.spec.tsx
```

Expected: GREEN with exact category/array semantics; the scalar exists only as an isolated rolling
compatibility write target.

- [ ] **Step 3: Generate and inspect the additive migration**

```bash
MIGRATION_NAME=ExpandSubEquipmentCompatibilityArray
LATEST_FARM_MIGRATION_TS="$(rg --files apps/farm-service/src/database/migrations | sed -nE 's#^.*/([0-9]{13})-.*\.ts$#\1#p' | sort -n | tail -1)"
WALL_CLOCK_TS="$(date -u +%s%3N)"
if (( 10#$WALL_CLOCK_TS > 10#$LATEST_FARM_MIGRATION_TS )); then FARM_MIGRATION_TS="$WALL_CLOCK_TS"; else FARM_MIGRATION_TS="$((10#$LATEST_FARM_MIGRATION_TS + 1))"; fi
F1A_COMPAT_EXPANSION_MIGRATION="apps/farm-service/src/database/migrations/${FARM_MIGRATION_TS}-${MIGRATION_NAME}.ts"
(
  cd apps/farm-service
  npx typeorm-ts-node-commonjs migration:generate \
    -d src/database/data-source.ts \
    -t "$FARM_MIGRATION_TS" \
    "src/database/migrations/${MIGRATION_NAME}"
)
test -f "$F1A_COMPAT_EXPANSION_MIGRATION"
test "$(git status --porcelain=v1 --untracked-files=all -- apps/farm-service/src/database/migrations | awk '$1 == "??" { count += 1 } END { print count + 0 }')" -eq 1
GENERATED_DIFF_STATUS=0
git diff --no-index -- /dev/null "$F1A_COMPAT_EXPANSION_MIGRATION" || GENERATED_DIFF_STATUS=$?
test "$GENERATED_DIFF_STATUS" -eq 1
```

Expected: the generated diff only adds nullable `compatibleEquipmentTypeCodes text[]`; it does not
alter or drop `compatibleEquipmentTypes`.

- [ ] **Step 4: Harden expansion, dual write, backfill, and post-condition**

Inside the selected tenant schema, validate every scalar token is trimmed, non-empty, comma-free,
and present in `equipment_types.code`. Install a schema-pinned trigger/function named
`trg_sub_equipment_types_compatibility_dual_write` before backfill. It must:

1. derive the array from an old-binary scalar-only insert/update;
2. derive the scalar from a new-binary array-only write;
3. canonicalize sorted distinct codes in both columns; and
4. throw if a statement supplies two non-equivalent representations.

Backfill the array from the scalar in bounded primary-key order, prove source/target row counts and
per-row set equality, then set the new array `NOT NULL`. Preserve the scalar and trigger. Handle the
`feeder` to `feed-drop-point` seed identity only after proving a unique source/target/reference set;
never delete or null references. Add a post-condition for both columns, array element type, NOT
NULL, trigger/function, and zero parity mismatches. `down()` rejects if any row cannot be
represented exactly by the original scalar or if the identity rename is ambiguous; otherwise remove
only the new array/trigger and restore the same row IDs. Register the migration.

- [ ] **Step 5: Prove old/new binaries stay coherent in PostgreSQL**

The migration unit test asserts add-before-backfill-before-NOT-NULL ordering, trigger semantics,
current-schema DDL, parity post-condition, and guarded rollback. The PostgreSQL suite must run:

- an old-format scalar insert/update and observe the array;
- a new-format array insert/update and observe the scalar;
- equal dual writes and divergent dual writes;
- null/empty, unknown, duplicate, comma-bearing, and identity-conflict fixtures;
- reversible `up() → down() → up()` before new-only values exist.

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(sub-equipment-compatibility-expand\.migration|equipment-types\.seed|sub-equipment-compatibility\.util|get-sub-equipment-types\.handler|create-sub-equipment\.handler|save-feeder-calibrations\.handler)\.spec\.ts'
npx nx run farm-service:e2e --runInBand --testPathPatterns=sub-equipment-compatibility-expand.postgres.spec.ts
npm run gates:migration-sql -- --mode=file "$F1A_COMPAT_EXPANSION_MIGRATION"
```

Expected: both binary shapes remain coherent and no in-place column type rewrite occurs.

- [ ] **Step 6: Commit and push the hardware portion of the additive boundary**

```bash
F1A_COMPAT_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: derive exact sub-equipment compatibility from the equipment catalog") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F1A_COMPAT_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  docs/superpowers/evidence/aquamobil-v4/slices/F1a/preflight.json \
  apps/farm-service/src/equipment/entities/sub-equipment-type.entity.ts \
  apps/farm-service/src/equipment/utils/sub-equipment-compatibility.util.ts \
  apps/farm-service/src/equipment/__tests__/sub-equipment-compatibility.util.spec.ts \
  apps/farm-service/src/equipment/seeds/equipment-types.seed.ts \
  apps/farm-service/src/equipment/__tests__/equipment-types.seed.spec.ts \
  apps/farm-service/src/equipment/handlers/get-sub-equipment-types.handler.ts \
  apps/farm-service/src/equipment/__tests__/get-sub-equipment-types.handler.spec.ts \
  apps/farm-service/src/equipment/handlers/create-sub-equipment.handler.ts \
  apps/farm-service/src/equipment/__tests__/create-sub-equipment.handler.spec.ts \
  apps/farm-service/src/equipment/dto/sub-equipment.response.ts \
  apps/farm-service/src/equipment/__tests__/sub-equipment.response.spec.ts \
  apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts \
  apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.handler.spec.ts \
  apps/farm-service/src/database/services/farm-seed.service.ts \
  web/modules/farm-module/src/pages/setup/tabs/EquipmentTab.tsx \
  web/modules/farm-module/src/pages/setup/tabs/__tests__/EquipmentTab.feeder-selection.spec.tsx \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/src/database/migrations/__tests__/sub-equipment-compatibility-expand.migration.spec.ts \
  apps/farm-service/src/__tests__/e2e/sub-equipment-compatibility-expand.postgres.spec.ts \
  docs/evidence/aquamobil-v4-feeding/f1a-compatibility-reader-cutover.md \
  "$F1A_COMPAT_EXPANSION_MIGRATION"
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): expand exact hardware compatibility\n\nA native compatibility array must be added beside the scalar and kept coherent across mixed binaries before readers can cut over safely.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F1A_COMPAT_FINDING_ID")"
git push
```

Do not open or merge the additive PR yet. Continue on the same clean branch with Tasks 10–11 so the
single `compatibility-and-feeder-model-expand` boundary contains the dual-written array plus the
additive feeder tables/share invariant and no event producer. The hardware change remains a separate
reviewer commit inside that PR.

### Task 9: Contract Hardware Compatibility Through App-Then-Physical Releases

**Hard release gate:** execute this task only after the complete Tasks 8, 10, and 11 additive PR is
merged and deployed on every farm-service instance. Each tenant must report equal normalized
scalar/array sets and zero dual-write errors. The application contraction and physical contraction
are distinct protected PRs and deployments.

**Files:**

- Modify: `apps/farm-service/src/equipment/entities/sub-equipment-type.entity.ts`
- Modify: `apps/farm-service/src/equipment/utils/sub-equipment-compatibility.util.ts`
- Modify: `apps/farm-service/src/equipment/__tests__/sub-equipment-compatibility.util.spec.ts`
- Modify: `apps/farm-service/src/database/services/farm-seed.service.ts`
- Create:
  `apps/farm-service/src/__tests__/e2e/sub-equipment-compatibility-app-contraction.postgres.spec.ts`
- Create: `docs/evidence/aquamobil-v4-feeding/f1a-compatibility-array-reader-contract.md`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Create at execution: `$F1A_COMPAT_CONTRACTION_MIGRATION`, resolved by the monotonic procedure with
  semantic name `ContractSubEquipmentCompatibilityScalar`
- Create:
  `apps/farm-service/src/database/migrations/__tests__/sub-equipment-compatibility-contract.migration.spec.ts`
- Create:
  `apps/farm-service/src/__tests__/e2e/sub-equipment-compatibility-contract.postgres.spec.ts`
- Create: `docs/evidence/aquamobil-v4-feeding/f1a-compatibility-scalar-drop.md`

**Interfaces:**

- The `array-reader-contract` boundary removes the legacy entity property, helper fallback, and dual
  application write while deliberately retaining the physical scalar and database dual-write
  trigger. Its deployed binary reads/writes only the array and tolerates both columns.
- The final state retains `compatibleEquipmentTypeCodes text[] NOT NULL` as the only persistence
  field.
- The later `legacy-scalar-physical-contract` boundary removes the dual-write trigger/function and
  old physical scalar only after the reader-contract fleet and a final in-transaction parity check.

- [ ] **Step 0: Enter the coordinator-created array-reader contraction boundary**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice F1a \
  --boundary array-reader-contract \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-f1a-array-reader-contract
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
: "${F1A_EXPANSION_MAIN_SHA:?export the full main SHA emitted by coordinator capture}"
printf '%s\n' "$F1A_EXPANSION_MAIN_SHA" | rg -q '^[0-9a-f]{40}$'
git merge-base --is-ancestor "$F1A_EXPANSION_MAIN_SHA" origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
```

The coordinator creates `refactor/feeding-f1a-array-reader-contract` at the freshly fetched
protected-main tip only after validating the deployed additive boundary. The implementation branch
reuses the immutable F1a preflight already on main and changes no slice or central evidence.

- [ ] **Step 1: Capture fleet/parity evidence and write RED app-contraction tests**

Record full deployed SHA, replica image digests, rollout completion, and per-schema counts in
`f1a-compatibility-array-reader-contract.md`. Normalize the scalar with trimmed comma splitting and
compare sorted distinct values to the array; require equal row counts and zero mismatches/unknown
codes. Write tests that remove the legacy property/fallback/dual write from the entity, helper, and
seeder while public DTO output remains `compatibleEquipmentTypes` mapped from the array. The
PostgreSQL test boots that contracted entity graph against both physical columns and the live
trigger, then proves array-only inserts/updates, unrelated reads/writes, and startup drift checks
preserve the scalar through the trigger.

- [ ] **Step 2: Remove only application legacy access, commit, merge, and deploy**

After the RED tests fail, remove only the legacy property/fallback/write. Do not generate a
migration, edit `FARM_MIGRATIONS`, or drop/disable the trigger. Run the focused unit and retained
column PostgreSQL tests, then commit the exact app-only paths without the physical-drop finding
trailer. Merge the protected PR, have the coordinator capture it as `array-reader-contract`, and
deploy that exact application SHA everywhere before continuing.

```bash
npx nx test farm-service --runInBand --testPathPatterns='(sub-equipment-compatibility\.util|sub-equipment\.response)\.spec\.ts'
npx nx run farm-service:e2e --runInBand --testPathPatterns=sub-equipment-compatibility-app-contraction.postgres.spec.ts
git add \
  apps/farm-service/src/equipment/entities/sub-equipment-type.entity.ts \
  apps/farm-service/src/equipment/utils/sub-equipment-compatibility.util.ts \
  apps/farm-service/src/equipment/__tests__/sub-equipment-compatibility.util.spec.ts \
  apps/farm-service/src/database/services/farm-seed.service.ts \
  apps/farm-service/src/__tests__/e2e/sub-equipment-compatibility-app-contraction.postgres.spec.ts \
  docs/evidence/aquamobil-v4-feeding/f1a-compatibility-array-reader-contract.md
test -z "$(git diff --cached --name-only | rg '^apps/farm-service/src/database/migrations')"
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "refactor(farm): contract hardware compatibility readers"
git push
```

Expected: every running binary reads/writes only `compatibleEquipmentTypeCodes`; the legacy scalar,
trigger/function, and values remain present and coherent. Rollback to the additive binary is still
possible. No migration path appears in the PR.

After coordinator capture and deployment, clean the exact reader-contract worktree:

```bash
SLICE_ID=F1a
BOUNDARY_ID=array-reader-contract
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
test "$BOUNDARY_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-f1a-array-reader-contract
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --slice "$SLICE_ID" \
  --boundary "$BOUNDARY_ID" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$BOUNDARY_WORKTREE"
```

- [ ] **Step 3: Enter the physical-only boundary and reattest the complete fleet**

Create the exact physical boundary from fresh protected main:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice F1a \
  --boundary legacy-scalar-physical-contract \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-f1a-legacy-scalar-physical-contract
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
: "${F1A_READER_CONTRACTION_MAIN_SHA:?export the full main SHA emitted by coordinator capture}"
printf '%s\n' "$F1A_READER_CONTRACTION_MAIN_SHA" | rg -q '^[0-9a-f]{40}$'
git merge-base --is-ancestor "$F1A_READER_CONTRACTION_MAIN_SHA" origin/main
```

Record that SHA, every live image digest, zero old instances, fresh per-schema row/set parity,
catalog membership, trigger health, and array `NOT NULL` evidence in
`f1a-compatibility-scalar-drop.md`. Any discrepancy blocks generation.

- [ ] **Step 4: Generate and inspect the exact physical drop**

Remove no additional application field. Generate:

```bash
MIGRATION_NAME=ContractSubEquipmentCompatibilityScalar
LATEST_FARM_MIGRATION_TS="$(rg --files apps/farm-service/src/database/migrations | sed -nE 's#^.*/([0-9]{13})-.*\.ts$#\1#p' | sort -n | tail -1)"
WALL_CLOCK_TS="$(date -u +%s%3N)"
if (( 10#$WALL_CLOCK_TS > 10#$LATEST_FARM_MIGRATION_TS )); then FARM_MIGRATION_TS="$WALL_CLOCK_TS"; else FARM_MIGRATION_TS="$((10#$LATEST_FARM_MIGRATION_TS + 1))"; fi
F1A_COMPAT_CONTRACTION_MIGRATION="apps/farm-service/src/database/migrations/${FARM_MIGRATION_TS}-${MIGRATION_NAME}.ts"
(
  cd apps/farm-service
  npx typeorm-ts-node-commonjs migration:generate \
    -d src/database/data-source.ts \
    -t "$FARM_MIGRATION_TS" \
    "src/database/migrations/${MIGRATION_NAME}"
)
test -f "$F1A_COMPAT_CONTRACTION_MIGRATION"
test "$(git status --porcelain=v1 --untracked-files=all -- apps/farm-service/src/database/migrations | awk '$1 == "??" { count += 1 } END { print count + 0 }')" -eq 1
GENERATED_DIFF_STATUS=0
git diff --no-index -- /dev/null "$F1A_COMPAT_CONTRACTION_MIGRATION" || GENERATED_DIFF_STATUS=$?
test "$GENERATED_DIFF_STATUS" -eq 1
```

Expected: the exact generated diff only drops `compatibleEquipmentTypes`; it leaves the array and
all unrelated schema objects unchanged.

- [ ] **Step 5: Harden and test the destructive contraction**

Inside `current_schema()` and `withDdlSafety()`, rerun scalar/array normalization parity, catalog
membership, row-count, and array NOT NULL checks. Throw before DDL on any mismatch. Then drop the
dual-write trigger, its schema-local function, and the scalar column in that order. Add the exact
destructive evidence marker and a post-condition proving the scalar/trigger/function are absent and
the array remains `text[] NOT NULL`. `down()` throws before DDL because scalar formatting and
mixed-binary history cannot be reconstructed truthfully. Register the migration.

Run unit/PostgreSQL cases for exact parity, divergent set/order/whitespace, unknown codes, old
binary write racing the drop, and down rejection. Only normalized parity may drop; every failure
must leave both columns and trigger intact.

```bash
npx nx test farm-service --runInBand --testPathPatterns='(sub-equipment-compatibility-contract\.migration|sub-equipment-compatibility\.util|sub-equipment\.response)\.spec\.ts'
npx nx run farm-service:e2e --runInBand --testPathPatterns=sub-equipment-compatibility-contract.postgres.spec.ts
npm run gates:migration-sql -- --mode=file "$F1A_COMPAT_CONTRACTION_MIGRATION"
```

- [ ] **Step 6: Commit, merge, deploy, and reconcile the physical contraction**

```bash
F1A_COMPAT_DROP_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: drop retired scalar hardware compatibility after array cutover") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F1A_COMPAT_DROP_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/src/database/migrations/__tests__/sub-equipment-compatibility-contract.migration.spec.ts \
  apps/farm-service/src/__tests__/e2e/sub-equipment-compatibility-contract.postgres.spec.ts \
  docs/evidence/aquamobil-v4-feeding/f1a-compatibility-scalar-drop.md \
  "$F1A_COMPAT_CONTRACTION_MIGRATION"
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'refactor(farm): drop scalar hardware compatibility\n\nThe array-reader fleet and per-tenant parity are proven, so the old scalar and rolling dual-write trigger can be removed without an in-place type rewrite.\n\nBREAKING CHANGE: The retired sub_equipment_types.compatibleEquipmentTypes scalar column is removed.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F1A_COMPAT_DROP_FINDING_ID")"
git push
```

Merge the independently reviewed protected PR and have the coordinator capture it as
`legacy-scalar-physical-contract`. Deploy it and prove the scalar/trigger are absent while exact
array reads remain green. Then clean the exact physical-contract worktree:

```bash
SLICE_ID=F1a
BOUNDARY_ID=legacy-scalar-physical-contract
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
test "$BOUNDARY_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-f1a-legacy-scalar-physical-contract
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --slice "$SLICE_ID" \
  --boundary "$BOUNDARY_ID" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$BOUNDARY_WORKTREE"
```

With all three exact F1a boundary IDs now captured, create a distinct serialized reconciliation
branch; write immutable `slices/F1a/merge.json` with the ordered `implementationBoundaries` array
and regenerate the central ledger only through `reconcile-ledger.mjs --slice F1a --write`. Merge
that reconciliation PR before F2 begins.

### Task 10: Add Tenant-Routed Feeder Assignment Entities and Database Share Enforcement

**Files:**

- Create: `apps/farm-service/src/feeding-protocol/entities/feeder-assignment.entity.ts`
- Create: `apps/farm-service/src/feeding-protocol/entities/feeder-assignment-unit-total.entity.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.entities.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts`
- Modify: `libs/backend-common/src/database/schema-manager.service.ts`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Create at execution: `$F1A_ASSIGNMENT_MIGRATION`, resolved by the monotonic procedure with
  semantic name `CreateTenantFeederAssignmentInvariant`
- Create:
  `apps/farm-service/src/database/migrations/__tests__/feeder-assignment-invariant.migration.spec.ts`

**Interfaces:**

```ts
export enum FeederAssignmentStatus {
  ACTIVE = 'active',
  ENDED = 'ended',
}

@Entity('feeder_assignments')
export class FeederAssignment {
  id!: string;
  tenantId!: string;
  unitId!: string;
  unitType!: FeedingUnitType;
  unitName!: string;
  unitCode!: string;
  siteId!: string;
  feederEquipmentId!: string;
  feederName!: string;
  feederCode!: string;
  doseSharePercent!: number;
  status!: FeederAssignmentStatus;
  effectiveFrom!: Date;
  endedAt?: Date;
  createdAt!: Date;
  createdBy?: string;
  updatedAt!: Date;
  updatedBy?: string;
  version!: number;
}

@Entity('feeder_assignment_unit_totals')
export class FeederAssignmentUnitTotal {
  tenantId!: string;
  unitId!: string;
  activeSharePercentTotal!: number;
  updatedAt!: Date;
}
```

- Both are per-tenant entities and therefore omit `schema:`.
- `doseSharePercent` and `activeSharePercentTotal` use `numeric(6,3)` with `DecimalTransformer`.
- The same active feeder equipment may safely serve multiple units in one tenant. Uniqueness is
  scoped to `(tenantId, unitId, feederEquipmentId)`; no index or validation may impose a tenant-wide
  one-feeder/one-unit restriction.
- Produces the persistence contract required by F1b; F1a does not publish assignment events.

- [ ] **Step 0: Continue the same F1a additive branch after Task 8**

```bash
F1A_ACTIVE_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-f1a-compatibility-and-feeder-model-expand
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
cd "$F1A_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice F1a \
  --check docs/superpowers/evidence/aquamobil-v4/slices/F1a/preflight.json \
  --main-ref origin/main
test -z "$(git status --porcelain --untracked-files=no)"
```

Expected: this is the same coordinator-created F1a implementation branch containing Task 8's
reviewer commit and its unchanged preflight; neither a new slice branch nor central evidence is
created.

- [ ] **Step 1: Write RED entity metadata tests**

Use TypeORM metadata to assert:

- table names are `feeder_assignments` and `feeder_assignment_unit_totals`;
- neither entity declares a schema;
- `(tenantId, unitId)` is the totals composite primary key;
- active assignment indexes are tenant-scoped;
- the only active-identity unique index is `(tenantId, unitId, feederEquipmentId)` and two fixture
  rows using one feeder with different units are admitted by metadata-level index predicates;
- both numeric fields use scale 3 and the decimal transformer;
- the assignment status enum serializes `active` and `ended`.

- [ ] **Step 2: Run entity tests and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=feeder-assignment.entities.spec.ts
```

Expected: FAIL because the entities do not exist.

- [ ] **Step 3: Implement minimal entities and registrations**

Declare the exact columns and indexes. Keep `feederEquipmentId` as the UUID column; the generated
migration adds its `equipment(id)` FK with `RESTRICT`. Do not add a unit FK because unit identity
spans current Equipment and legacy Tank representations. Register both entities in
`FeedingProtocolModule` and add both table names to `MODULE_SCHEMAS.farm.tables`.

- [ ] **Step 4: Generate the feeder-assignment migration**

Run:

```bash
MIGRATION_NAME=CreateTenantFeederAssignmentInvariant
LATEST_FARM_MIGRATION_TS="$(rg --files apps/farm-service/src/database/migrations | sed -nE 's#^.*/([0-9]{13})-.*\.ts$#\1#p' | sort -n | tail -1)"
WALL_CLOCK_TS="$(date -u +%s%3N)"
if (( 10#$WALL_CLOCK_TS > 10#$LATEST_FARM_MIGRATION_TS )); then FARM_MIGRATION_TS="$WALL_CLOCK_TS"; else FARM_MIGRATION_TS="$((10#$LATEST_FARM_MIGRATION_TS + 1))"; fi
F1A_ASSIGNMENT_MIGRATION="apps/farm-service/src/database/migrations/${FARM_MIGRATION_TS}-${MIGRATION_NAME}.ts"
(
  cd apps/farm-service
  npx typeorm-ts-node-commonjs migration:generate \
    -d src/database/data-source.ts \
    -t "$FARM_MIGRATION_TS" \
    "src/database/migrations/${MIGRATION_NAME}"
)
test -f "$F1A_ASSIGNMENT_MIGRATION"
test "$(git status --porcelain=v1 --untracked-files=all -- apps/farm-service/src/database/migrations | awk '$1 == "??" { count += 1 } END { print count + 0 }')" -eq 1
GENERATED_DIFF_STATUS=0
git diff --no-index -- /dev/null "$F1A_ASSIGNMENT_MIGRATION" || GENERATED_DIFF_STATUS=$?
test "$GENERATED_DIFF_STATUS" -eq 1
```

Expected: the farm-local CommonJS runner's complete diff contains only the two new tables, indexes,
enum types, and feeder-equipment FK. No unrelated schema diff is accepted.

- [ ] **Step 5: Write the RED migration contract test before editing generated SQL**

Assert the migration must provide all of these database-level rules:

```text
doseSharePercent > 0 AND doseSharePercent <= 100
status = active exactly when endedAt IS NULL
activeSharePercentTotal = 0 OR activeSharePercentTotal = 100
DEFERRABLE INITIALLY DEFERRED
FORCE ROW LEVEL SECURITY
ON DELETE RESTRICT ON UPDATE RESTRICT
```

Also assert it creates a totals row before summing active assignments, locks affected totals rows in
sorted `(tenantId, unitId)` order, recomputes both OLD and NEW keys for moves, pins each trigger
function to its creator schema, and has a post-condition for tables, RLS, trigger deferrability, and
check constraints.

- [ ] **Step 6: Run migration contract test and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=feeder-assignment-invariant.migration.spec.ts
```

Expected: FAIL because generated TypeORM SQL cannot express the commit-time cross-row invariant or
canonical RLS.

- [ ] **Step 7: Implement the database invariant in the generated migration**

Use current-schema-relative DDL and idempotent guards. The trigger path must:

1. Collect distinct OLD and NEW `(tenantId, unitId)` keys into sorted order.
2. Insert missing totals anchor rows with total zero.
3. Lock each anchor row `FOR UPDATE` in sorted order.
4. Recompute the active sum from `feeder_assignments` for each key.
5. Update `feeder_assignment_unit_totals`.
6. Let a `DEFERRABLE` constraint trigger configured to fire at transaction commit reject any total
   except exactly zero or 100.

Create a partial unique index only for active `(tenantId, unitId, feederEquipmentId)` identity and
non-unique tenant/unit, tenant/feeder, tenant/site lookup indexes. Explicitly reject a generated
unique index on `(tenantId, feederEquipmentId)`, because a physical feeder can safely serve multiple
units and F3 must preserve that ambiguity. Use:

```ts
applyTenantRlsToSchema(queryRunner, {
  includeTables: ['feeder_assignments', 'feeder_assignment_unit_totals'],
  tenantIdColumns: ['tenantId'],
});
```

Add `postCondition()` using `current_schema()`.

Implement `down()` under the same current-schema validation and DDL-safety boundary. It must reject
before DDL if either new table contains a row; on empty tables it drops the commit-time constraint
triggers, schema-pinned functions, policies, indexes, FK, tables, and owned enums in dependency
order, then proves both tables are absent. Register the migration in `FARM_MIGRATIONS`.

- [ ] **Step 8: Run migration, schema, and RLS static gates**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(feeder-assignment\.entities|feeder-assignment-invariant\.migration)\.spec\.ts'
npm run gates:migration-sql -- --mode=file "$F1A_ASSIGNMENT_MIGRATION"
npx nx test invariants --runInBand --testPathPatterns='(entity-schema-declaration|entity-diff-implies-migration|tenant-fanout-entity-parity|farm-service-migration-array-completeness|farm-service-tenant-isolation|rls-predicate-canonical)\.spec\.ts'
```

In the migration contract test, also invoke `down()` for empty-table and populated-table responses:
the empty case must remove objects in dependency order, and the populated case must throw before its
first destructive statement.

Expected: PASS; no entity declares a literal schema, both tables are in the farm tenant manifest,
and rollback cannot silently discard assignment history.

- [ ] **Step 9: Commit and push**

Run:

```bash
F1A_DB_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: enforce tenant feeder share totals in PostgreSQL") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F1A_DB_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/feeding-protocol/entities/feeder-assignment.entity.ts \
  apps/farm-service/src/feeding-protocol/entities/feeder-assignment-unit-total.entity.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.entities.spec.ts \
  apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts \
  libs/backend-common/src/database/schema-manager.service.ts \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/src/database/migrations/__tests__/feeder-assignment-invariant.migration.spec.ts \
  "$F1A_ASSIGNMENT_MIGRATION"
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): enforce feeder shares in PostgreSQL\n\nApplication checks cannot serialize concurrent assignment writers, so tenant-routed tables use a locked totals anchor and a transaction-commit zero-or-100 invariant.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F1A_DB_FINDING_ID")"
git push
```

Expected: hooks pass and F1a still contains no `UnitFeederAssignmentsChanged` producer.

### Task 11: Prove Share Invariant Concurrency and Tenant Isolation in PostgreSQL

**Files:**

- Create: `apps/farm-service/src/__tests__/e2e/feeder-assignment-share-sum.postgres.spec.ts`
- Modify: `apps/farm-service/src/__tests__/e2e/helpers/tenant-schema-harness.ts` only if it lacks a
  typed helper needed to create two isolated tenant schemas

**Interfaces:**

- Consumes the migration and entities from Task 10.
- Produces database evidence that raw SQL and concurrent writers cannot bypass the invariant or RLS.

- [ ] **Step 1: Write commit-time database acceptance tests**

Using two actual `tenant_` schemas created by `tenant-schema-harness.ts`, apply the migration under
each selected schema. Test independent transactions for:

```text
60 + 40 active shares commit
empty active set commits as zero
60 alone fails when the transaction commits
100 + 1 fails when the transaction commits
ended assignments remain queryable and do not count
duplicate active feeder identity fails
the same feeder equipment may be active for unit A and unit B when each unit independently totals 100
```

Execute raw SQL through `QueryRunner` so the test does not depend on application validation. On a
third empty isolated schema, run `up() → down() → up()` and prove object parity after the second
`up()`. On a populated schema, call `down()` and prove it rejects while retaining every row,
trigger, policy, and table.

- [ ] **Step 2: Run the initial PostgreSQL acceptance suite**

Run:

```bash
npx nx run farm-service:e2e --runInBand --testPathPatterns=feeder-assignment-share-sum.postgres.spec.ts
```

Expected: PASS against the completed Task 10 migration. This task adds real-database acceptance
evidence rather than production behavior; any failure must be traced to the DDL, RLS, harness, or
test expectation and fixed at its owning Task 10 boundary before concurrency cases are added.

- [ ] **Step 3: Add the concurrent writer case**

Open two database connections to the same tenant/unit. Have both begin, insert an active 100-percent
assignment, synchronize after insert, then race commits. Assert exactly one commits and the other
rejects; query the final total and assert 100 with one active assignment.

- [ ] **Step 4: Add cross-tenant and RLS cases**

Set the canonical tenant GUC for tenant A and assert tenant B rows are invisible and immutable even
when raw SQL supplies tenant B’s UUID. Switch both schema and GUC to tenant B and prove its
independent assignment can commit. Assert both tables have RLS enabled and forced.

- [ ] **Step 5: Add trigger-search-path and inverse-move deadlock cases**

Set a hostile search path before DML and prove the function still mutates only its creator schema.
Concurrently move assignments from unit A to B and B to A; assert deterministic completion or
invariant rejection, never a deadlock timeout.

- [ ] **Step 6: Run the complete PostgreSQL proof**

Run:

```bash
npx nx run farm-service:e2e --runInBand --testPathPatterns=feeder-assignment-share-sum.postgres.spec.ts
npx nx test invariants --runInBand --testPathPatterns='(farm-service-tenant-isolation|tenant-fanout-entity-parity)\.spec\.ts'
```

Expected: PASS with exactly one winner in the same-unit 100-plus-100 race, one feeder safely bound
to two independently valid units, and no row visible across tenants.

- [ ] **Step 7: Commit and push the PostgreSQL proof**

Run:

```bash
git add \
  apps/farm-service/src/__tests__/e2e/feeder-assignment-share-sum.postgres.spec.ts \
  apps/farm-service/src/__tests__/e2e/helpers/tenant-schema-harness.ts
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "test(farm): prove feeder share isolation under concurrency"
git push
```

Expected: hooks pass. This test commit adds evidence and does not claim a second resolution of the
Task 10 finding.

- [ ] **Step 8: Merge and deploy the complete F1a additive boundary**

Run the F1a-focused Task 17 domain, PostgreSQL, invariant, generated-artifact, affected, and
production dependency gates. Open one protected PR from the coordinator-pinned F1a additive branch
to `main`, require review and all checks, and merge it. The coordinator captures the PR, full main
SHA, workflow runs, and generated hardware/feeder migration artifacts as
`compatibility-and-feeder-model-expand`; neither the implementation branch nor this boundary writes
`merge.json` or the central ledger. Deploy that exact SHA everywhere, exercise both old/new
compatibility write shapes, and record per-tenant scalar/array parity before Task 9 starts.

After capture and deployment, clean the coordinator-pinned additive worktree:

```bash
SLICE_ID=F1a
BOUNDARY_ID=compatibility-and-feeder-model-expand
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
test "$BOUNDARY_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-f1a-compatibility-and-feeder-model-expand
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --slice "$SLICE_ID" \
  --boundary "$BOUNDARY_ID" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$BOUNDARY_WORKTREE"
```

Expected: the additive boundary is reachable from `origin/main`, both hardware and feeder-share
migrations are deployed, scalar/array parity is exact, and no F2 event producer is present. F1a is
not reconciled yet because its reader and physical contraction IDs are still absent.

---

## F2 — Versioned Event Language and Generated NATS Authority

### Task 12: Define and Audit V1 Feeder/VFD Event Contracts Before Production

**Files:**

- Create through the program capture tool:
  `docs/superpowers/evidence/aquamobil-v4/slices/F2/preflight.json`
- Modify: `libs/event-contracts/src/farm-events.ts`
- Modify: `libs/event-contracts/src/sensor-events.ts`
- Modify: `libs/event-contracts/src/schemas/farm-events.schema.ts`
- Modify: `libs/event-contracts/src/schemas/sensor-events.schema.ts`
- Modify: `libs/event-contracts/src/schemas/validator.ts`
- Create: `libs/event-contracts/src/schemas/feeder-event-semantics.ts`
- Create: `libs/event-contracts/src/schemas/__tests__/feeder-vfd-events.schema.spec.ts`
- Modify: `tests/invariants/upcaster-chain.spec.ts`
- Create: `docs/evidence/aquamobil-v4-feeding/f2-event-version-history.md`

**Interfaces:**

```ts
export const UNIT_FEEDER_ASSIGNMENTS_CHANGED_CURRENT_VERSION = 1;
export const VFD_DRIVE_BINDING_ATTESTED_CURRENT_VERSION = 1;
export const VFD_DRIVE_BINDING_ATTESTATION_REQUESTED_CURRENT_VERSION = 1;

export interface UnitFeederShareEntry {
  readonly assignmentId: string;
  readonly feederEquipmentId: string;
  readonly feederCode: string;
  readonly doseSharePercent: number;
}

export interface UnitFeederAssignmentsChangedEvent extends BaseEvent {
  readonly eventType: 'UnitFeederAssignmentsChanged';
  readonly userId?: string;
  readonly unitId: string;
  readonly unitType: 'tank' | 'pond' | 'cage';
  readonly unitCode: string;
  readonly siteId: string;
  readonly feeders: UnitFeederShareEntry[];
  readonly endedAssignmentIds: string[];
}

export interface DrivenEquipmentUnitEntry {
  readonly unitId: string;
  readonly unitType: 'tank' | 'pond' | 'cage';
  readonly unitCode: string;
  readonly doseSharePercent: number;
}

export interface VfdDriveBindingAttestedEvent extends BaseEvent {
  readonly eventType: 'VfdDriveBindingAttested';
  readonly vfdDeviceId: string;
  readonly drivenEquipmentId: string;
  readonly outcome: 'attested' | 'unknown_equipment' | 'inactive_equipment';
  readonly equipmentCategory?: string;
  readonly equipmentCode?: string;
  readonly equipmentName?: string;
  readonly siteId?: string;
  readonly servedUnits: DrivenEquipmentUnitEntry[];
}

export interface VfdDriveBindingAttestationRequestedEvent extends BaseEvent {
  readonly eventType: 'VfdDriveBindingAttestationRequested';
  readonly vfdDeviceId: string;
  readonly drivenEquipmentId: string;
}
```

- The three event discriminators do not exist on anchored `main`; each therefore begins honestly at
  version 1.
- No version-only or identity upcaster is created. A future upcaster is allowed only after a real
  deployed wire-shape change.
- F2 exports contracts and validators but activates no producer.

- [ ] **Step 0: Create F2 after reconciled F1a and I1 main and capture its preflight**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
git -C "$COORDINATOR_WORKTREE" show \
  origin/main:docs/superpowers/evidence/aquamobil-v4/slices/I1/merge.json |
  jq -e '.slice == "I1" and [.implementationBoundaries[].boundaryId] == ["asset-storage-and-tls-boundary"]'
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice F2 \
  --boundary event-language-and-acl \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-f2
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
```

Run the program plan's exact preflight audit/explain capture, then write/check only
`slices/F2/preflight.json`. Expected: the branch starts after both the serialized F1a and I1 slice
reconciliations, all earlier feeding owner evidence and I1's closed image authority verify, no F1b
producer exists, and no central/foreign-slice evidence changes.

- [ ] **Step 1: Audit anchored history before assigning an event version**

Run against the current protected baseline before editing contracts:

```bash
git fetch origin main
ANCHORED_MAIN_SHA="$(git rev-parse origin/main)"
for event_type in \
  UnitFeederAssignmentsChanged \
  VfdDriveBindingAttested \
  VfdDriveBindingAttestationRequested
do
  if git grep -n "$event_type" origin/main -- libs/event-contracts/src apps infrastructure/nats; then
    exit 1
  fi
  if git log origin/main --format='%H %s' -S"$event_type" -- libs/event-contracts/src apps infrastructure/nats | rg .; then
    exit 1
  fi
done
```

Expected: all six absence checks exit cleanly, proving none of the event types has an anchored
contract, producer, consumer, ACL, or prior `origin/main` history. A hit blocks implementation until
the real deployed version history is reconstructed.

Create the evidence directory if necessary, then use `apply_patch` to create
`docs/evidence/aquamobil-v4-feeding/f2-event-version-history.md` with `$ANCHORED_MAIN_SHA`, UTC
audit time, the exact commands and exit statuses, one row per event type, and the conclusion
`initialVersion=1, currentVersion=1, upcasterRequired=false`. Do not claim source-branch-only
commits are deployed history.

- [ ] **Step 2: Write RED contract, semantic, and version-history tests**

Create version 1 fixtures through `createBaseEvent()` with `version: 1`. Assert all three valid
shapes pass their respective validator and reject versions 0 and 2. For
`UnitFeederAssignmentsChanged`, accept an empty feeder list as the hand-fed state; require every
non-empty list of at most 12 feeders to sum to 100000 integer thousandths. Reject:

- more than 12 feeders;
- a share `<= 0` or `> 100`;
- more than three fractional digits;
- duplicate assignment or feeder equipment IDs;
- non-zero feeder arrays whose integer-thousandth sum is not 100000;
- duplicate ended assignment IDs;
- malformed UUIDs, over-length codes, and unknown properties.

For attested events, cap `servedUnits` at 24, validate all UUIDs and bounded text, reject duplicate
unit IDs, and constrain each served-unit share to `(0, 100]` with three-decimal precision. Do not
sum shares across units: each value is that feeder's share of a different unit. An attested
equipment row may truthfully serve zero units; unknown/inactive outcomes require `servedUnits` to be
empty. For requests, accept only the two IDs plus base fields.

Extend `tests/invariants/upcaster-chain.spec.ts` with a table containing the three
discriminator/constant pairs. Assert every current-version declaration is exactly 1, every schema
admits only version 1, the audit evidence names the anchored SHA and all three types, and no file
under `libs/event-contracts/src/upcasters` declares any of those event types. This test records why
the lack of an upcaster is intentional rather than an omitted chain.

- [ ] **Step 3: Run contract and version-history tests and verify RED**

Run:

```bash
npx nx test event-contracts --runInBand --testPathPatterns=feeder-vfd-events.schema.spec.ts
npx nx test invariants --runInBand --testPathPatterns=upcaster-chain.spec.ts
```

Expected: FAIL on missing event interfaces/version constants/schema registrations, not on
evidence-file parsing or fixture setup.

- [ ] **Step 4: Implement version 1 interfaces and strict AJV schemas**

Add the farm events to `FarmEvent`, the request event to the sensor union, and set every
current-version constant to 1. Verify the existing `export * from './farm-events'` and
`export * from './sensor-events'` barrel lines expose them from `index.ts`; do not edit the barrel
when those lines are already present. In the wire schemas, override base `version` with integer enum
`[1]`, use UUID and text-cap constants, set `uniqueItems` where scalar arrays allow it, and set
`additionalProperties: false` at every object level.

Implement semantic checks in `feeder-event-semantics.ts` using integer thousandths and
`Set<string>`. Call them from `validateFarmEvent()`/`validateSensorEvent()` after AJV succeeds so
trust-boundary callers receive one fail-closed result.

- [ ] **Step 5: Run contract tests and verify GREEN**

Run:

```bash
npx nx test event-contracts --runInBand --testPathPatterns=feeder-vfd-events.schema.spec.ts
```

Expected: PASS for all valid version 1 fixtures; version 0, version 2, structural-invalid, and
semantic-invalid payloads fail closed.

- [ ] **Step 6: Prove the deliberate absence of new upcasters**

Run:

```bash
if rg -n 'UnitFeederAssignmentsChanged|VfdDriveBindingAttested|VfdDriveBindingAttestationRequested' libs/event-contracts/src/upcasters; then
  exit 1
fi
git diff --exit-code -- libs/event-contracts/src/upcasters
npx nx test invariants --runInBand --testPathPatterns=upcaster-chain.spec.ts
```

Expected: the scan and diff are empty and the invariant PASSes because all three events are audited
initial-version-1 contracts. Do not add a version-only factory, identity transform, registry entry,
or misleading replay fixture.

- [ ] **Step 7: Run the full contract cluster**

Run:

```bash
npx nx test event-contracts --runInBand --testPathPatterns=feeder-vfd-events.schema.spec.ts
npx nx test invariants --runInBand --testPathPatterns=upcaster-chain.spec.ts
npm run type-check
```

Expected: PASS; all three validators admit only the audited version 1 language and existing
unrelated upcaster chains remain gap-free.

- [ ] **Step 8: Commit and push contracts before ACL or producer**

Run:

```bash
F2_EVENT_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: version feeder and VFD event language") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F2_EVENT_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  docs/superpowers/evidence/aquamobil-v4/slices/F2/preflight.json \
  libs/event-contracts/src/farm-events.ts \
  libs/event-contracts/src/sensor-events.ts \
  libs/event-contracts/src/schemas/farm-events.schema.ts \
  libs/event-contracts/src/schemas/sensor-events.schema.ts \
  libs/event-contracts/src/schemas/validator.ts \
  libs/event-contracts/src/schemas/feeder-event-semantics.ts \
  libs/event-contracts/src/schemas/__tests__/feeder-vfd-events.schema.spec.ts \
  tests/invariants/upcaster-chain.spec.ts \
  docs/evidence/aquamobil-v4-feeding/f2-event-version-history.md
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(events): establish feeder and VFD version 1 language\n\nAnchored-history evidence proves these event types are new, so strict version 1 validators land without fabricated identity upcasters before any producer is activated.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F2_EVENT_FINDING_ID")"
git push
```

Expected: hooks pass. No app producer, listener, or new upcaster is included in this commit.

### Task 13: Add Generated Cert-CN Publish Grants and Prove Static/Live ACLs

**Files:**

- Read: `infrastructure/ci/image-digests.json`
- Read: `scripts/ci/resolve-ci-image.mjs`
- Read: `tests/invariants/ci-image-digests.spec.ts`
- Modify: `infrastructure/nats/services.yaml`
- Modify generated block: `infrastructure/docker/nats/nats.conf`
- Verify unchanged unless generator reports an identity-roster change:
  `infrastructure/helm/aquaculture/files/nats-service-identities.yaml`
- Modify: `e2e/tests/integration/nats-invariants.spec.ts`
- Modify: `e2e/tests/integration/nats-subject-contract.spec.ts`
- Modify: `tests/invariants/nats-config-ssot.spec.ts`
- Create: `scripts/nats/feeding-acl-smoke.mjs`
- Create: `scripts/nats/feeding-acl-smoke.test.mjs`
- Create: `scripts/nats/feeding-acl-smoke-harness.sh`
- Modify: `package.json`

**Interfaces:**

```yaml
farm_service:
  publish:
    - events.*.UnitFeederAssignmentsChanged
    - events.*.VfdDriveBindingAttested

sensor_service:
  publish:
    - events.*.VfdDriveBindingAttestationRequested
```

- Consumes the exact event discriminators from Task 12.
- Consumes I1's sole container-fixture authority at `infrastructure/ci/image-digests.json`; its
  inline `images.nats.image` value is the reviewed
  `nats:2.10.24-alpine@sha256:fd981e2ab99000964bd15286054e61fcc445732fd907db039f260fc0b824b314`. The
  portable committed harness invokes exactly
  `node scripts/ci/resolve-ci-image.mjs --manifest infrastructure/ci/image-digests.json --image nats`
  from the repository root and uses its stdout. It never parses the manifest itself, repeats the
  reference, supplies a fallback tag, accepts an image override, or creates a second digest
  manifest. PostgreSQL remains an external pointer to its pre-existing manifest; this task never
  duplicates that authority.
- Produces publish authorization for cert CN `farm_service` and `sensor_service`; it adds no
  username, password, token, or shared service identity.

- [ ] **Step 1: Write RED SSoT and subject tests**

Assert `services.yaml` grants only the listed service/event pairs, the generated config mirrors
them, unauthorized service CNs lack those grants, and no CONNECT-frame user/password property
appears. Unit-test a live probe matrix with these exact expectations:

```ts
const publishMatrix = [
  ['farm_service', 'UnitFeederAssignmentsChanged', 'allow'],
  ['farm_service', 'VfdDriveBindingAttested', 'allow'],
  ['farm_service', 'VfdDriveBindingAttestationRequested', 'deny'],
  ['sensor_service', 'VfdDriveBindingAttestationRequested', 'allow'],
  ['sensor_service', 'UnitFeederAssignmentsChanged', 'deny'],
  ['sensor_service', 'VfdDriveBindingAttested', 'deny'],
  ['gateway_service', 'UnitFeederAssignmentsChanged', 'deny'],
  ['gateway_service', 'VfdDriveBindingAttested', 'deny'],
  ['gateway_service', 'VfdDriveBindingAttestationRequested', 'deny'],
] as const;
```

The probe must treat a positive publish as success only after `flush()`. A negative publish succeeds
only after a bounded connection-status loop observes the server permission violation naming the
attempted subject; timeout, disconnect without that error, or an allowed publish all fail the test.
`feeding-acl-smoke.test.mjs` must also parse the harness source and prove it invokes the exact
repo-local resolver command above, rejects a missing/non-digest stdout value, and contains no direct
manifest JSON access, `nats:` literal, mutable image argument, fallback, or second manifest path.
The existing resolver/invariant tests must also prove that every invocation validates the complete
schema, stdout is exactly the resolved image plus one newline, and another manifest path, an
environment override, or an unknown image key fails closed.

- [ ] **Step 2: Run static NATS tests and verify RED**

Run:

```bash
npx nx test invariants --runInBand --testPathPatterns=nats-config-ssot.spec.ts
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath tests/invariants/ci-image-digests.spec.ts
npx jest --config e2e/jest.config.ts --runInBand --testPathPatterns='(nats-invariants|nats-subject-contract)\.spec\.ts'
node --test scripts/nats/feeding-acl-smoke.test.mjs
```

Expected: FAIL because the three event publish grants are absent from `services.yaml` and generated
config.

- [ ] **Step 3: Edit the SSoT and generate the bounded configuration**

Use `apply_patch` only on `infrastructure/nats/services.yaml`, then run:

```bash
./scripts/nats/generate-nats-conf.py
git diff -- infrastructure/nats/services.yaml infrastructure/docker/nats/nats.conf infrastructure/helm/aquaculture/files/nats-service-identities.yaml
```

Expected: the YAML and generated authorization block add exactly three publish subjects. The Helm
identity roster has no diff because no CN was added.

Add these exact root scripts so static CI and the repository-managed live broker are distinct:

```json
"smoke:nats-feeding-acl:static": "node scripts/nats/feeding-acl-smoke.mjs --mode static",
"smoke:nats-feeding-acl:external": "node scripts/nats/feeding-acl-smoke.mjs --mode live",
"smoke:nats-feeding-acl": "bash scripts/nats/feeding-acl-smoke-harness.sh"
```

- [ ] **Step 4: Run static authorization gates**

Run:

```bash
npx nx test invariants --runInBand --testPathPatterns=nats-config-ssot.spec.ts
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath tests/invariants/ci-image-digests.spec.ts
npx jest --config e2e/jest.config.ts --runInBand --testPathPatterns='(nats-invariants|nats-subject-contract)\.spec\.ts'
npm run smoke:nats-messaging-acl:static
npm run smoke:nats-feeding-acl:static
```

Expected: PASS; generated-file parity and cert-only identity checks are green.

- [ ] **Step 5: Run live positive and negative ACL probes**

`feeding-acl-smoke-harness.sh` must generate one ephemeral CA/server certificate plus client
certificates whose CNs are exactly `farm_service`, `sensor_service`, `gateway_service`, and
`unregistered_feeding_probe`; invoke the exact repo-local resolver command pinned above, require its
stdout to carry the `@sha256:` suffix, start that exact immutable reference with the generated
authorization config, and clean up through a trap. It runs every matrix row through a fresh client
connection so a permission error cannot contaminate the next assertion. The unregistered CN must
fail the TLS/mapped-identity connection itself. No environment variable or CLI argument may replace
the manifest value.

Run:

```bash
npm run smoke:nats-feeding-acl
```

Expected: `farm_service` can publish assignment-changed and attested subjects, `sensor_service` can
publish attestation-requested, every crossed service/event combination is denied by the live broker,
`gateway_service` cannot publish any of the three, and the unregistered certificate CN cannot
connect. A static matcher is not accepted as live evidence.

- [ ] **Step 6: Commit and push generated ACL parity**

Run:

```bash
F2_NATS_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: generate cert-only feeder and VFD publish grants") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F2_NATS_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  infrastructure/nats/services.yaml \
  infrastructure/docker/nats/nats.conf \
  e2e/tests/integration/nats-invariants.spec.ts \
  e2e/tests/integration/nats-subject-contract.spec.ts \
  tests/invariants/nats-config-ssot.spec.ts \
  scripts/nats/feeding-acl-smoke.mjs \
  scripts/nats/feeding-acl-smoke.test.mjs \
  scripts/nats/feeding-acl-smoke-harness.sh \
  package.json
if ! git diff --quiet -- infrastructure/helm/aquaculture/files/nats-service-identities.yaml; then
  git add infrastructure/helm/aquaculture/files/nats-service-identities.yaml
fi
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(nats): authorize feeder and VFD event publishing\n\nGenerated service grants bind each new event subject to its intended certificate CN and keep unauthorized service identities denied.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F2_NATS_FINDING_ID")"
git push
```

Expected: hooks pass, the generated block is reproducible by rerunning the generator with an empty
diff, and I1's image-digest invariant proves the live harness consumes the sole manifest without an
inline duplicate.

- [ ] **Step 7: Merge the independently reviewed F2 slice**

Run the F2-focused Task 17 contract, version-history, upcaster-absence, generated NATS, static/live
ACL, affected, and production dependency gates. Open a protected PR from
`feat/feeding-f2-event-language` to `main`, require review and all checks, and merge it. Have the
coordinator capture it as `event-language-and-acl`, then clean its exact worktree:

```bash
SLICE_ID=F2
BOUNDARY_ID=event-language-and-acl
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
test "$BOUNDARY_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-f2
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --slice "$SLICE_ID" \
  --boundary "$BOUNDARY_ID" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$BOUNDARY_WORKTREE"
```

Because that is F2's complete pinned boundary set, use a distinct serialized reconciliation branch
to write immutable `slices/F2/merge.json` and regenerate the central ledger only through
`reconcile-ledger.mjs --slice F2 --write`; merge that reconciliation PR before F1b starts.

Expected: the F2 implementation and reconciliation main SHAs are reachable from `origin/main`, its
one-item `implementationBoundaries` array has the exact pinned ID and repository evidence, all three
event contracts remain version 1 with no new upcaster, and no assignment producer is present.

---

## F1b — Assignment API, Producer, and Tenant-Safe Consumer

### Task 14: Add Feeder Assignment DTOs, Read Query, and Exact Dose Splitting

**Files:**

- Create through the program capture tool:
  `docs/superpowers/evidence/aquamobil-v4/slices/F1b/preflight.json`
- Create: `apps/farm-service/src/feeding-protocol/dto/feeder-assignment.inputs.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.inputs.spec.ts`
- Create: `apps/farm-service/src/feeding-protocol/commands/feeder-assignment.commands.ts`
- Create: `apps/farm-service/src/feeding-protocol/queries/feeder-assignment.queries.ts`
- Create:
  `apps/farm-service/src/feeding-protocol/query-handlers/feeder-assignment.query-handlers.ts`
- Create:
  `apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.query-handlers.spec.ts`
- Create: `apps/farm-service/src/feeding-protocol/services/feeder-dose-split.service.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feeder-dose-split.spec.ts`
- Create: `apps/farm-service/src/feeding-protocol/utils/unit-type.util.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/unit-type.util.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/handlers/protocol-assignment.handlers.ts`
- Modify: `apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts`

**Interfaces:**

```ts
export const MAX_FEEDERS_PER_UNIT = 12;

@InputType()
export class UnitFeederShareInput {
  @Field(() => ID)
  feederEquipmentId!: string;

  @Field(() => Float)
  doseSharePercent!: number;
}

@InputType()
export class SetUnitFeedersInput {
  @Field(() => ID)
  unitId!: string;

  @Field(() => [UnitFeederShareInput])
  feeders!: UnitFeederShareInput[];

  @Field(() => GraphQLISODateTime, { nullable: true })
  effectiveFrom?: Date;
}

export class SetUnitFeedersCommand {
  constructor(
    public readonly input: SetUnitFeedersInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export class GetUnitFeederAssignmentsQuery {
  constructor(
    public readonly unitId: string,
    public readonly tenantId: string,
    public readonly includeEnded = false,
  ) {}
}

export interface FeederDoseShare {
  readonly feederEquipmentId: string;
  readonly feederName: string;
  readonly feederCode: string;
  readonly doseSharePercent: number;
}

export interface FeederDoseAllocation extends FeederDoseShare {
  readonly kg: number;
}

export function splitDoseByShare(
  shares: readonly FeederDoseShare[],
  totalKg: number,
): FeederDoseAllocation[];

export class FeederDoseSplitService {
  getActiveFeedersWithManager(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
  ): Promise<FeederDoseShare[]>;
  getActiveFeeders(tenantId: string, unitId: string): Promise<FeederDoseShare[]>;
  splitDailyDoseWithManager(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    totalKg: number,
  ): Promise<FeederDoseAllocation[]>;
  splitDailyDose(
    tenantId: string,
    unitId: string,
    totalKg: number,
  ): Promise<FeederDoseAllocation[]>;
}

export type UnitTypeSource =
  | { readonly kind: 'legacy_tank' }
  | { readonly kind: 'equipment'; readonly equipmentTypeId: string };

export function resolveUnitType(
  manager: EntityManager,
  source: UnitTypeSource,
): Promise<FeedingUnitType>;
```

- Consumes F1a entities and PostgreSQL invariant.
- Produces tenant-scoped read and arithmetic services; this task does not enqueue events.

- [ ] **Step 0: Create F1b from reconciled F2 main and capture its preflight**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice F1b \
  --boundary assignment-api-and-gateway \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-f1b
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
```

Run the program plan's exact preflight audit/explain capture, then write/check only
`slices/F1b/preflight.json`. Expected: the branch starts after the serialized F2 reconciliation;
F0/F1a/F2 owner evidence verifies; the version 1 validator plus generated cert-CN grants exist; and
no central or foreign-slice evidence changes.

- [ ] **Step 1: Write RED DTO validation tests**

Use `class-validator` against transformed inputs and inspect Nest GraphQL metadata. Accept zero
feeders or at most 12 unique-shaped nested entries. Reject invalid UUIDs, 13 entries, shares below
`0.001`, above `100`, more than three fractional digits, non-number values, and non-Date
`effectiveFrom` after transformation. Assert both classes carry `@InputType()`, every property has
the exact `@Field()` type/nullability shown above, and nested transformation points to
`UnitFeederShareInput`.

- [ ] **Step 2: Run DTO tests and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=feeder-assignment.inputs.spec.ts
```

Expected: FAIL because the input classes do not exist.

- [ ] **Step 3: Implement the minimal validated DTO and CQRS messages**

Create the utility directory before applying file patches:

```bash
mkdir -p apps/farm-service/src/feeding-protocol/utils
```

Use the explicit GraphQL decorators above together with `@IsUUID()`,
`@IsNumber({ maxDecimalPlaces: 3 })`, `@Min(0.001)`, `@Max(100)`, `@ArrayMaxSize(12)`, nested
transformation/validation, and a transformed optional Date. Keep aggregate share validation in the
command handler and database.

- [ ] **Step 4: Write RED largest-remainder tests**

Prove:

```ts
expect(splitDoseByShare(threeEqualShares, 10).map(({ kg }) => kg)).toEqual([3.334, 3.333, 3.333]);
expect(sumKg(splitDoseByShare(weightedShares, 7.123))).toBe(7.123);
expect(splitDoseByShare([], 7.123)).toEqual([]);
expect(() => splitDoseByShare(weightedShares, Number.NaN)).toThrow(BadRequestException);
expect(() => splitDoseByShare(weightedShares, -0.001)).toThrow(BadRequestException);
```

Use deterministic tie-breaking: larger fractional remainder, then larger percentage, then
lexicographically smaller feeder equipment ID.

- [ ] **Step 5: Run dose tests and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=feeder-dose-split.spec.ts
```

Expected: FAIL because the split service does not exist.

- [ ] **Step 6: Implement integer-gram largest remainder and one manager-aware read authority**

Convert `totalKg` to integer grams, reject non-finite/negative input, allocate floors, distribute
remaining grams in deterministic order, and return three-decimal kg. Put the sole repository/query
implementation in `getActiveFeedersWithManager(manager, tenantId, unitId)`, using
`tenantManagerRepo(manager, FeederAssignment, tenantId)` with predicates for tenant, unit, and
active status. `splitDailyDoseWithManager()` must call that canonical read and then
`splitDoseByShare()`.

The convenience methods contain no repository or SQL logic: `getActiveFeeders()` opens
`runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => ...)` and calls
`getActiveFeedersWithManager(queryRunner.manager, ...)`; `splitDailyDose()` opens one read boundary
and calls `splitDailyDoseWithManager(queryRunner.manager, ...)`. Tests must prove a caller supplying
an existing manager performs exactly one assignment query and never creates a nested
`runInTenantRead`/`QueryRunner`. This is the transaction-snapshot API consumed by F4.

- [ ] **Step 7: Write RED query-handler and unit-type tests**

Assert the query handler enters `runInTenantRead`, uses `queryRunner.manager` with the tenant
manager repository, filters active status unless `includeEnded` is true, and sorts
deterministically. Seed one feeder equipment ID under two units and prove each unit-scoped
query/dose split returns only its own row; the read service must not reject safe multi-unit bindings
or collapse them by feeder ID.

Assert `resolveUnitType()` maps an explicit `{ kind: 'legacy_tank' }` source to TANK without an
equipment-type query; maps active TANK/POND/CAGE equipment types; and rejects a missing/inactive
type or any non-unit category such as FEEDING. It must never turn an absent/unknown equipment type
into TANK. Update `protocol-assignment.handlers.ts` to derive the discriminated source from
`TankLookupResult.isFromTanksTable` and consume the shared utility so mapping has one
implementation.

- [ ] **Step 8: Run query and utility tests, then implement minimal handlers**

Run before implementation:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(feeder-assignment\.query-handlers|unit-type\.util)\.spec\.ts'
```

Expected: FAIL because the query handler and shared utility do not exist.

After implementation, run the same command and expect PASS. Register the query handler and dose
service in `FeedingProtocolModule`.

- [ ] **Step 9: Run the complete read-side cluster**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(feeder-assignment\.inputs|feeder-dose-split|feeder-assignment\.query-handlers|unit-type\.util|protocol-assignment)\.spec\.ts'
```

Expected: PASS; tenant reads never use a global repository, an existing transaction can reuse the
manager-aware dose path without a nested transaction, and unknown equipment identity fails closed.

- [ ] **Step 10: Commit and push the read/dose API foundation**

Run:

```bash
F1B_READ_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: serve feeder assignments and deterministic dose splits") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F1B_READ_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  docs/superpowers/evidence/aquamobil-v4/slices/F1b/preflight.json \
  apps/farm-service/src/feeding-protocol/dto/feeder-assignment.inputs.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.inputs.spec.ts \
  apps/farm-service/src/feeding-protocol/commands/feeder-assignment.commands.ts \
  apps/farm-service/src/feeding-protocol/queries/feeder-assignment.queries.ts \
  apps/farm-service/src/feeding-protocol/query-handlers/feeder-assignment.query-handlers.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.query-handlers.spec.ts \
  apps/farm-service/src/feeding-protocol/services/feeder-dose-split.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeder-dose-split.spec.ts \
  apps/farm-service/src/feeding-protocol/utils/unit-type.util.ts \
  apps/farm-service/src/feeding-protocol/__tests__/unit-type.util.spec.ts \
  apps/farm-service/src/feeding-protocol/handlers/protocol-assignment.handlers.ts \
  apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): serve feeder assignments and exact dose splits\n\nTenant-scoped assignment reads and integer-gram largest remainder give every caller one deterministic answer for how a unit dose is distributed.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F1B_READ_FINDING_ID")"
git push
```

Expected: hooks pass; this read-side commit contains no assignment event producer.

### Task 15: Implement Atomic Set-Diff Assignment and Validated Outbox Production

**Files:**

- Create: `apps/farm-service/src/feeding-protocol/handlers/feeder-assignment.handlers.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/set-unit-feeders.handler.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts`
- Create: `apps/farm-service/src/__tests__/e2e/feeder-assignment-api.postgres.spec.ts`

**Interfaces:**

```ts
export class SetUnitFeedersHandler
  implements ICommandHandler<SetUnitFeedersCommand, FeederAssignment[]>
{
  execute(command: SetUnitFeedersCommand): Promise<FeederAssignment[]>;
}
```

- Consumes F1a’s totals anchor/constraint and F2’s audited version 1 event contract, validator, and
  publish ACL.
- Produces one same-manager transaction containing assignment history, active set, and
  `UnitFeederAssignmentsChanged` outbox row.

- [ ] **Step 1: Write RED aggregate-validation tests**

Assert integer-thousandth validation accepts `33.333 + 33.333 + 33.334`, accepts an empty set,
rejects duplicate equipment IDs, rejects 99.999/100.001, and performs no transaction call on invalid
input.

- [ ] **Step 2: Write RED London interaction tests for the set diff**

With typed collaborators, prove the handler:

1. calls `runInTenantTransaction(dataSource, 'farm', tenantId, callback)`;
2. creates/locks `FeederAssignmentUnitTotal` before reading active rows;
3. resolves unit and site through `findTankOrEquipmentWithManager()` and
   `resolveSiteIdFromDepartment()`;
4. resolves unit type through the shared `resolveUnitType()`;
5. loads every requested feeder as active, non-deleted `Equipment` with
   `EquipmentType.category === FEEDING`;
6. leaves unchanged rows untouched;
7. marks removed/share-changed rows `ENDED` with `endedAt` and audit user;
8. inserts a new generation for new/share-changed rows;
9. reads the final active set;
10. creates a version 1 event, validates it in production, and enqueues it with the same manager
    only after validation succeeds;
11. allows the same feeder equipment to remain actively assigned to a different unit in the same
    tenant, because the invariant is unit-scoped; and
12. rolls all writes back when validator acceptance or outbox enqueue fails.

- [ ] **Step 3: Run handler tests and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns=set-unit-feeders.handler.spec.ts
```

Expected: FAIL because the handler does not exist.

- [ ] **Step 4: Implement tenant transaction, lock, and set diff**

Use `runInTenantTransaction(dataSource, 'farm', tenantId, async (queryRunner) => ...)`, pass
`queryRunner.manager` to `tenantManagerRepo()`, and preserve one sorted assignment order. Upsert the
totals anchor, acquire its pessimistic write lock, then read current active assignments. Reject
missing/site-less units and missing/inactive/non-`FEEDING` equipment. Preserve history and never
delete assignment rows. Avoid structured-log string concatenation; log fields through the
repository’s structured logger convention or omit the success log.

Duplicate rejection is limited to repeated feeder IDs in the submitted set and an already-active row
for the same `(tenantId, unitId, feederEquipmentId)` generation. Do not query for or reject an
active assignment of that feeder under another unit. The database uniqueness boundary remains
`(tenantId, unitId, feederEquipmentId)` for active rows; no tenant-wide feeder uniqueness rule is
permitted.

- [ ] **Step 5: Build and validate the version 1 event through the established outbox**

Construct:

```ts
const event: UnitFeederAssignmentsChangedEvent = {
  ...createBaseEvent<UnitFeederAssignmentsChangedEvent>('UnitFeederAssignmentsChanged', tenantId, {
    aggregateId: input.unitId,
    aggregateType: 'FeederAssignment',
    userId,
    version: UNIT_FEEDER_ASSIGNMENTS_CHANGED_CURRENT_VERSION,
  }),
  userId,
  unitId: input.unitId,
  unitType,
  unitCode,
  siteId,
  feeders: activeRows.map((row) => ({
    assignmentId: row.id,
    feederEquipmentId: row.feederEquipmentId,
    feederCode: row.feederCode,
    doseSharePercent: row.doseSharePercent,
  })),
  endedAssignmentIds,
};
```

In production, call `validateFarmEvent('UnitFeederAssignmentsChanged', event)` before the outbox
boundary. If it returns invalid, throw a fail-closed internal contract error without logging the
payload and before calling `outboxPublisher.enqueue()`. The exception must escape the
`runInTenantTransaction()` callback so all assignment/history writes roll back. Only an accepted
event may reach `outboxPublisher.enqueue(event, manager, { aggregateId: input.unitId })`.

In the London test, assert call order `validateFarmEvent` then `outboxPublisher.enqueue`, and force
the validator to return invalid to prove zero enqueue, zero committed writes, and a rejected
command. Also pass the constructed happy-path event through the real validator so test doubles
cannot mask contract/schema drift.

- [ ] **Step 6: Run handler tests and verify GREEN**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(set-unit-feeders\.handler|feeder-dose-split|feeder-assignment\.query-handlers)\.spec\.ts'
```

Expected: PASS; the event is version-1-valid, an invalid production validation outcome rolls the
transaction back before enqueue, and the same manager reaches every write collaborator.

- [ ] **Step 7: Write PostgreSQL API transaction acceptance tests**

In `feeder-assignment-api.postgres.spec.ts`, prove a 60/40 set persists, a changed 70/30 set ends
old generations and inserts new ones, an empty set commits zero, a non-100 raw mutation fails, a
cross-tenant unit/feeder ID is rejected, and one outbox row carries the exact tenant and
version-1-valid payload. Race two valid replacement commands for one unit and assert serialization
leaves one coherent active generation totaling 100. Include a validator-rejection injection at the
transaction boundary and assert neither assignment generations nor an outbox row commit.

Create two units in one tenant and assign the same active feeder equipment to both. Assert both rows
commit, each unit independently totals 100, each unit-scoped query returns only its own assignment,
and replacing one unit’s set neither ends nor rewrites the other unit’s row. Also inspect the live
unique indexes and fail if any active uniqueness constraint is keyed only by tenant and feeder.

- [ ] **Step 8: Run PostgreSQL API tests and verify behavior**

Run:

```bash
npx nx run farm-service:e2e --runInBand --testPathPatterns=feeder-assignment-api.postgres.spec.ts
```

Expected: PASS; no event exists when the transaction fails and concurrent replacements cannot
interleave generations.

- [ ] **Step 9: Commit the complete F1b domain feature and push**

Run:

```bash
F1B_API_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: expose tenant-safe feeder assignment API and producer") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F1B_API_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/feeding-protocol/handlers/feeder-assignment.handlers.ts \
  apps/farm-service/src/feeding-protocol/__tests__/set-unit-feeders.handler.spec.ts \
  apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts \
  apps/farm-service/src/__tests__/e2e/feeder-assignment-api.postgres.spec.ts
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): assign unit feeders through the outbox\n\nA set-based tenant transaction must serialize on the database totals anchor, preserve assignment history, and publish only the final validated version 1 generation.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F1B_API_FINDING_ID")"
git push
```

Expected: hooks pass; F2 commits are ancestors of this producer commit.

### Task 16: Expose GraphQL Operations and Route the Event by Subject Tenant

**Files:**

- Read: `CLAUDE.md`
- Read: `apps/gateway-api/CLAUDE.md`
- Create: `apps/farm-service/src/feeding-protocol/dto/feeder-assignment.graphql.ts`
- Create: `apps/farm-service/src/feeding-protocol/resolvers/feeder-assignment.resolver.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.graphql.spec.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.resolver.spec.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.sdl.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts`
- Modify: `apps/farm-service/src/common/authz/permission-matrix.ts`
- Modify: `apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts`
- Modify generated SDL: `apps/farm-service/schema.graphql`
- Modify generated types: `web/shared-ui/src/generated/graphql-types.ts`
- Modify: `apps/gateway-api/src/websocket/farm-nats-bridge.service.ts`
- Modify: `apps/gateway-api/src/websocket/farm.gateway.ts`
- Create: `apps/gateway-api/src/websocket/__tests__/farm-nats-bridge.unit-feeder.spec.ts`

**Interfaces:**

```ts
@ObjectType('FeederAssignment')
export class FeederAssignmentType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  unitId!: string;

  @Field(() => FeedingUnitType)
  unitType!: FeedingUnitType;

  @Field(() => String)
  unitName!: string;

  @Field(() => String)
  unitCode!: string;

  @Field(() => ID)
  siteId!: string;

  @Field(() => ID)
  feederEquipmentId!: string;

  @Field(() => String)
  feederName!: string;

  @Field(() => String)
  feederCode!: string;

  @Field(() => Float)
  doseSharePercent!: number;

  @Field(() => FeederAssignmentStatus)
  status!: FeederAssignmentStatus;

  @Field(() => GraphQLISODateTime)
  effectiveFrom!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  endedAt?: Date;
}

@ObjectType('FeederDoseAllocation')
export class FeederDoseAllocationType {
  @Field(() => ID)
  feederEquipmentId!: string;

  @Field(() => String)
  feederName!: string;

  @Field(() => String)
  feederCode!: string;

  @Field(() => Float)
  doseSharePercent!: number;

  @Field(() => Float)
  kg!: number;
}

export function toFeederAssignmentType(row: FeederAssignment): FeederAssignmentType;
export function toFeederDoseAllocationType(
  row: FeederDoseAllocation,
): FeederDoseAllocationType;

@UseGuards(GqlAuthGuard)
@Resolver()
export class FeederAssignmentResolver {
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeederAssignmentType], { name: 'unitFeederAssignments' })
  unitFeederAssignments(
    @CurrentTenant() tenantId: string,
    @Args('unitId', { type: () => ID }) unitId: string,
    @Args('includeEnded', { type: () => Boolean, nullable: true, defaultValue: false })
    includeEnded: boolean,
  ): Promise<FeederAssignmentType[]>;

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeederDoseAllocationType], { name: 'unitFeederDoseSplit' })
  unitFeederDoseSplit(
    @CurrentTenant() tenantId: string,
    @Args('unitId', { type: () => ID }) unitId: string,
    @Args('totalKg', { type: () => Float }) totalKg: number,
  ): Promise<FeederDoseAllocationType[]>;

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [FeederAssignmentType], { name: 'setUnitFeeders' })
  setUnitFeeders(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input', { type: () => SetUnitFeedersInput }) input: SetUnitFeedersInput,
  ): Promise<FeederAssignmentType[]>;
}

broadcastUnitFeederAssignmentsChanged(
  tenantId: string,
  payload: Record<string, unknown>,
): void;
```

- Read roles: `TENANT_ADMIN`, `MODULE_MANAGER`, `MODULE_USER`.
- Mutation roles: `TENANT_ADMIN`, `MODULE_MANAGER`.
- Resolvers return dedicated GraphQL objects through the two mapping functions. They never return
  TypeORM entities, spread entities, or expose `tenantId`, audit-user fields, optimistic-lock
  fields, or other persistence-only columns.
- The gateway’s room key comes from the UUID-validated tenant token in
  `events.{tenantId}.UnitFeederAssignmentsChanged`, and the validated payload tenant must equal it
  before any broadcast. A mismatch is dropped, never rerouted under either identity.

- [ ] **Step 1: Write RED GraphQL metadata, mapper, delegation, and authorization tests**

In `feeder-assignment.graphql.spec.ts`, inspect Nest GraphQL metadata and assert both output classes
carry the exact `@ObjectType()` name and every field has the scalar/enum/nullability shown above.
Assert `endedAt` alone is nullable. Feed an entity carrying tenant/audit/version properties through
`toFeederAssignmentType()` and prove the mapped object has exactly the declared public keys. Do the
same for dose allocation; neither mapper may use an entity spread.

In `feeder-assignment.resolver.spec.ts`, inspect the exact `@Query()`, `@Mutation()`, `@Args()`,
`@CurrentTenant()`, and `@CurrentUser('sub')` metadata. Assert the two queries delegate exact
tenant/unit arguments, the mutation forwards tenant and user, every returned row is mapped, and
roles match the matrix above. Add exact operation entries `unitFeederAssignments`,
`unitFeederDoseSplit`, and `setUnitFeeders` to the permission-matrix expectations.

- [ ] **Step 2: Run resolver/authz tests and verify RED**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(feeder-assignment\.graphql|feeder-assignment\.resolver|permission-matrix)\.spec\.ts'
```

Expected: FAIL because the GraphQL objects, mappers, resolver, and matrix entries do not exist.

- [ ] **Step 3: Implement explicit GraphQL objects, mapping, resolver, and module registration**

Register `FeedingUnitType` and `FeederAssignmentStatus` with stable GraphQL enum names if they are
not already registered. Implement every explicit decorator shown in the interface. Apply
`GqlAuthGuard` at the resolver, use exact role decorators, delegate through `CommandBus`/`QueryBus`,
and call `FeederDoseSplitService` for the dose query. Map each domain result through the dedicated
mapper. Do not access a repository from the resolver and do not annotate the TypeORM entity as a
GraphQL object.

- [ ] **Step 4: Generate SDL, then write and run an exact SDL contract test**

Run `npm run schema:generate`, then write `feeder-assignment.sdl.spec.ts` using GraphQL
`buildSchema()` over `apps/farm-service/schema.graphql`. Assert:

- `unitFeederAssignments(unitId: ID!, includeEnded: Boolean = false): [FeederAssignment!]!`;
- `unitFeederDoseSplit(unitId: ID!, totalKg: Float!): [FeederDoseAllocation!]!`;
- `setUnitFeeders(input: SetUnitFeedersInput!): [FeederAssignment!]!`;
- `SetUnitFeedersInput.unitId` and every nested feeder ID are `ID!`, shares are `Float!`, and
  `effectiveFrom` is the only nullable input field;
- every output field and nullability matches the code-first classes; and
- `tenantId`, `createdBy`, `updatedBy`, `createdAt`, `updatedAt`, and `version` are absent from
  `FeederAssignment`.

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(feeder-assignment\.graphql|feeder-assignment\.resolver|feeder-assignment\.sdl|permission-matrix)\.spec\.ts'
```

Expected: PASS only when generated SDL and code-first metadata agree exactly.

- [ ] **Step 5: Re-read gateway rules, then write RED gateway consumer tests**

Before changing gateway code, read root `CLAUDE.md` and `apps/gateway-api/CLAUDE.md` in full. The
gateway owns no farm entity, schema, or migration; this task changes only its NATS bridge, existing
Socket.IO gateway, and unit test.

Use a typed NATS connection/subscription fake and mocked `FarmGateway`. Prove:

- the bridge subscribes to `events.*.UnitFeederAssignmentsChanged`;
- valid version 1 input is validated and broadcast unchanged;
- version 0 and version 2 inputs are dropped because no deployed prior or later wire version exists;
- invalid schema/share payload is dropped;
- a malformed subject tenant is dropped;
- when the subject tenant and payload tenant are different valid UUIDs, the event is dropped with
  zero broadcast and one bounded warning carrying reason code `tenant_mismatch` but neither raw
  payload nor tenant UUID;
- an event-type mismatch between subject and payload is dropped.

- [ ] **Step 6: Run gateway consumer test and verify RED**

Run:

```bash
npx nx test gateway-api --runInBand --testPathPatterns=farm-nats-bridge.unit-feeder.spec.ts
```

Expected: FAIL because the subscription, version-1 validation path, switch branch, and gateway
broadcast method do not exist.

- [ ] **Step 7: Implement validated tenant-routed consumption**

Add the subject to `FARM_SUBJECTS`. After JSON parse, validate against the subject-selected version
1 schema, narrow the validated event, and compare `event.tenantId` with the already UUID-validated
subject tenant. On mismatch, emit the bounded `tenant_mismatch` warning and continue without
dispatch; do not expose either tenant ID or the event body in that log. Dispatch only an exact match
and do not invent an upcast step. Add the switch branch and
`FarmGateway.broadcastUnitFeederAssignmentsChanged()`, which calls the existing tenant-room emitter
with event name `unitFeederAssignmentsChanged`.

- [ ] **Step 8: Run resolver and consumer suites**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(feeder-assignment\.graphql|feeder-assignment\.resolver|feeder-assignment\.sdl|permission-matrix)\.spec\.ts'
npx nx test gateway-api --runInBand --testPathPatterns=farm-nats-bridge.unit-feeder.spec.ts
```

Expected: PASS; the mismatch test proves an internally inconsistent event cannot enter any Socket.IO
room and leaves an operator-visible, non-sensitive rejection signal.

- [ ] **Step 9: Regenerate and verify GraphQL artifacts**

Run:

```bash
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
git diff -- apps/farm-service/schema.graphql web/shared-ui/src/generated/graphql-types.ts
```

Expected: SDL is regenerated before composition; SDL and generated types contain the three
operations and feeder assignment/dose types, and composition has no field conflict. Do not commit
`dist/graphql/supergraph.graphql`.

- [ ] **Step 10: Run farm and gateway type/build gates**

Run:

```bash
npx nx test farm-service --runInBand --testPathPatterns='(feeder-assignment|permission-matrix)'
npx nx test gateway-api --runInBand --testPathPatterns=farm-nats-bridge.unit-feeder.spec.ts
npx nx build shared-ui
npx nx build farm-service
npx tsc --noEmit -p apps/gateway-api/tsconfig.app.json
npx nx build gateway-api
```

Expected: PASS with no resolver access outside CQRS/service boundaries, no gateway-owned entity or
migration, and both the gateway compiler and Nx build proving its nested rules were honored.

- [ ] **Step 11: Commit and push GraphQL/consumer integration**

Run:

```bash
F1B_PUBLIC_FINDING_ID="$(jq -r 'select(.title == "AquaMobil V4 feeding foundation: authorize GraphQL and subject-routed feeder change consumption") | .id' docs/reviews/_registry/findings.jsonl)"
[[ "$F1B_PUBLIC_FINDING_ID" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git add \
  apps/farm-service/src/feeding-protocol/dto/feeder-assignment.graphql.ts \
  apps/farm-service/src/feeding-protocol/resolvers/feeder-assignment.resolver.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.graphql.spec.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.resolver.spec.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feeder-assignment.sdl.spec.ts \
  apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts \
  apps/farm-service/src/common/authz/permission-matrix.ts \
  apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts \
  apps/farm-service/schema.graphql \
  web/shared-ui/src/generated/graphql-types.ts \
  apps/gateway-api/src/websocket/farm-nats-bridge.service.ts \
  apps/gateway-api/src/websocket/farm.gateway.ts \
  apps/gateway-api/src/websocket/__tests__/farm-nats-bridge.unit-feeder.spec.ts
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "$(printf 'feat(farm): authorize feeder API and realtime routing\n\nGraphQL role boundaries, strict version 1 validation, and subject-derived gateway routing keep assignment changes inside the authenticated tenant without a fabricated upcast path.\n\nCloses: docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md#%s' "$F1B_PUBLIC_FINDING_ID")"
git push
```

Expected: hooks pass and the public API/consumer finding is distinct from the transactional producer
finding.

- [ ] **Step 12: Merge the independently reviewed F1b slice**

Run the F1b-focused Task 17 domain, PostgreSQL, validator, GraphQL generation/composition,
subject/payload tenant-routing, affected, and production dependency gates. Open a protected PR from
`feat/feeding-f1b-assignment-api` to `main`, require review and all checks, and merge it. Have the
coordinator capture it as `assignment-api-and-gateway`, then clean its exact worktree:

```bash
SLICE_ID=F1b
BOUNDARY_ID=assignment-api-and-gateway
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
test "$BOUNDARY_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-f1b
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --slice "$SLICE_ID" \
  --boundary "$BOUNDARY_ID" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$BOUNDARY_WORKTREE"
```

Because this completes F1b's pinned boundary set, use a distinct serialized reconciliation branch to
write immutable `slices/F1b/merge.json` and regenerate the central ledger only through
`reconcile-ledger.mjs --slice F1b --write`; merge that reconciliation PR before Task 17.

Expected: the F1b main SHA is reachable from `origin/main`, all eight protected feeding boundaries
have immutable merge-record and generated per-owner ledger evidence, and only now may Task 17 create
its post-merge verification branch.

### Task 17: Verify Eight Protected Feeding Boundaries and Close Fifteen HIGH Findings

**Files:**

- Verify: all files changed by Tasks 0–16
- Verify: `docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.findings.json`
- Verify generated: `docs/superpowers/evidence/aquamobil-v4/execution-ledger.json`
- Verify: `docs/superpowers/evidence/aquamobil-v4/slices/F0/merge.json`
- Verify: `docs/superpowers/evidence/aquamobil-v4/slices/F1a/merge.json`
- Verify: `docs/superpowers/evidence/aquamobil-v4/slices/F2/merge.json`
- Verify: `docs/superpowers/evidence/aquamobil-v4/slices/F1b/merge.json`
- Create: `docs/evidence/aquamobil-v4-feeding/foundation-verification.md`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-reachability.json`
- Create: `docs/evidence/aquamobil-v4-feeding/finding-closure-map.json`
- Create: `docs/evidence/aquamobil-v4-feeding/finding-closure-attestations.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/affected-paths.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/production-paths.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/audit-root-full.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/audit-root-runtime.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/audit-aquamobil-full.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/audit-aquamobil-runtime.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/audit-exit-statuses.txt`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/audit-set.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/npm-explain-set.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/aquamobil-vite-rollup-modules.json`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/dependency-reachability.md`
- Create: `docs/evidence/aquamobil-v4-feeding/dependency-audit/SHA256SUMS`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Modify generated: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes eight independently protected and merged boundaries, in order: F0 expansion, F0
  application contraction, F0 physical contraction, F1a additive compatibility/feeder model, F1a
  array-reader contraction, F1a legacy-scalar physical contraction, F2 event/ACL, and F1b assignment
  API.
- Starts verification only from a clean branch based on the `origin/main` commit that contains all
  eight protected PR-boundary SHAs in the four immutable slice merge records and matching generated
  per-owner ledger evidence.
- Produces a protected verification PR with database, generated-artifact, NATS, dependency, and
  repository-gate evidence plus the canonical generated format-scope authority, followed by a
  protected registry-only closure PR.
- Commits all four raw dependency-audit outputs and statuses, the canonical audit/explain sets, the
  production Vite/Rollup module manifest, exact affected/production path arrays, mapper output, and
  a hash manifest; ephemeral CI attachments are supplemental rather than the sole audit record.
- Resolves each finding with the unique full 40-character commit SHA whose `origin/main` commit body
  contains that finding's exact `Closes:` trailer, plus a machine-checked HIGH-severity closure
  attestation.

- [ ] **Step 1: Start a clean post-merge branch and validate eight per-owner boundaries**

Fetch the protected branch only after F0, F1a, F2, and F1b have each passed review and merged. Read
the full main SHAs from each immutable `slices/<SliceId>/merge.json`; do not ask an operator to type
them. The validator requires the exact boundary-ID tuple pinned above, verifies each complete GitHub
PR/workflow/artifact attestation, proves the same ordered array appears in generated
`ownerEvidence[SliceId]` for every approved-owner row, and rejects any short, non-main, duplicate,
missing, extra, or out-of-order boundary. It reads but never writes generated central evidence.

Run:

```bash
VERIFICATION_NAME=feeding-foundation
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create-verification \
  --verification "$VERIFICATION_NAME" \
  --main-ref origin/main
VERIFICATION_BRANCH="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-branch --verification "$VERIFICATION_NAME")"
VERIFICATION_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --verification "$VERIFICATION_NAME")"
test "$VERIFICATION_BRANCH" = chore/aquamobil-v4-feeding-foundation-verification
test "$VERIFICATION_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-feeding-foundation-verification
cd "$VERIFICATION_WORKTREE"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = \
  "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
TESTED_MAIN_SHA="$(git rev-parse HEAD)"
export TESTED_MAIN_SHA
boundary_sha() {
  jq -er --arg boundary_id "$2" \
    '.implementationBoundaries | map(select(.boundaryId == $boundary_id)) | select(length == 1) | .[0][("result" + "ingMainCommit")]' \
    "$1"
}
F0_MERGE=docs/superpowers/evidence/aquamobil-v4/slices/F0/merge.json
F1A_MERGE=docs/superpowers/evidence/aquamobil-v4/slices/F1a/merge.json
F2_MERGE=docs/superpowers/evidence/aquamobil-v4/slices/F2/merge.json
F1B_MERGE=docs/superpowers/evidence/aquamobil-v4/slices/F1b/merge.json
F0_EXPANSION_MAIN_SHA="$(boundary_sha "$F0_MERGE" weighing-authority-expand)"
F0_APP_CONTRACTION_MAIN_SHA="$(boundary_sha "$F0_MERGE" batch-protocol-reader-contract)"
F0_COLUMN_CONTRACTION_MAIN_SHA="$(boundary_sha "$F0_MERGE" batch-protocol-physical-contract)"
F1A_EXPANSION_MAIN_SHA="$(boundary_sha "$F1A_MERGE" compatibility-and-feeder-model-expand)"
F1A_READER_CONTRACTION_MAIN_SHA="$(boundary_sha "$F1A_MERGE" array-reader-contract)"
F1A_PHYSICAL_CONTRACTION_MAIN_SHA="$(boundary_sha "$F1A_MERGE" legacy-scalar-physical-contract)"
F2_MAIN_SHA="$(boundary_sha "$F2_MERGE" event-language-and-acl)"
F1B_MAIN_SHA="$(boundary_sha "$F1B_MERGE" assignment-api-and-gateway)"
FEEDING_GATE_DIR="$(mktemp -d)"
export FEEDING_GATE_DIR \
  F0_EXPANSION_MAIN_SHA \
  F0_APP_CONTRACTION_MAIN_SHA \
  F0_COLUMN_CONTRACTION_MAIN_SHA \
  F1A_EXPANSION_MAIN_SHA \
  F1A_READER_CONTRACTION_MAIN_SHA \
  F1A_PHYSICAL_CONTRACTION_MAIN_SHA \
  F2_MAIN_SHA \
  F1B_MAIN_SHA
node --input-type=module - \
  docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  "$F0_MERGE" "$F1A_MERGE" "$F2_MERGE" "$F1B_MERGE" <<'NODE'
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [ledgerPath, ...mergePaths] = process.argv.slice(2);
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const mainResultKey = ['result', 'ingMainCommit'].join('');
const repository = 'Okan-wqm/aquaculture_platform';
const expectedBySlice = new Map([
  [
    'F0',
    [
      'weighing-authority-expand',
      'batch-protocol-reader-contract',
      'batch-protocol-physical-contract',
    ],
  ],
  [
    'F1a',
    [
      'compatibility-and-feeder-model-expand',
      'array-reader-contract',
      'legacy-scalar-physical-contract',
    ],
  ],
  ['F2', ['event-language-and-acl']],
  ['F1b', ['assignment-api-and-gateway']],
]);
const mergeBySlice = new Map();
for (const mergePath of mergePaths) {
  const record = JSON.parse(fs.readFileSync(mergePath, 'utf8'));
  if (mergeBySlice.has(record.slice)) throw new Error(`duplicate merge record for ${record.slice}`);
  mergeBySlice.set(record.slice, record);
}
const isAncestor = (older, newer) =>
  spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
const fullSha = (value) => /^[0-9a-f]{40}$/.test(value ?? '');
const stable = (value) => JSON.stringify(value);
const orderedBoundaries = [];

if (mergeBySlice.size !== expectedBySlice.size) throw new Error('merge record set differs');
for (const [slice, expectedIds] of expectedBySlice) {
  const record = mergeBySlice.get(slice);
  if (!record) throw new Error(`missing merge record for ${slice}`);
  const boundaries = record.implementationBoundaries;
  if (!Array.isArray(boundaries) || boundaries.length === 0) {
    throw new Error(`${slice} has no implementation boundary evidence`);
  }
  const ids = boundaries.map((boundary) => boundary.boundaryId);
  if (stable(ids) !== stable(expectedIds)) {
    throw new Error(`${slice} boundary IDs are missing, extra, duplicate, or out of order`);
  }
  for (const boundary of boundaries) {
    const sha = boundary[mainResultKey];
    const pullRequest = boundary.pullRequest;
    if (!fullSha(sha) || !isAncestor(sha, 'origin/main')) {
      throw new Error(`${slice}/${boundary.boundaryId} is not a full protected-main SHA`);
    }
    if (
      pullRequest?.kind !== 'github-pull-request' ||
      pullRequest.repository !== repository ||
      pullRequest.state !== 'MERGED' ||
      pullRequest.baseRefName !== 'main' ||
      pullRequest[mainResultKey] !== sha ||
      !/^https:\/\//.test(pullRequest.url ?? '')
    ) {
      throw new Error(`${slice}/${boundary.boundaryId} lacks exact protected-PR evidence`);
    }
    if (
      !Array.isArray(boundary.workflowRuns) ||
      boundary.workflowRuns.length === 0 ||
      boundary.workflowRuns.some(
        (run) =>
          run.kind !== 'github-workflow-run' ||
          run.repository !== repository ||
          run.conclusion !== 'success' ||
          !fullSha(run.headSha) ||
          !/^https:\/\//.test(run.url ?? ''),
      )
    ) {
      throw new Error(`${slice}/${boundary.boundaryId} lacks successful workflow evidence`);
    }
    if (!Array.isArray(boundary.generatedArtifacts) || boundary.generatedArtifacts.length === 0) {
      throw new Error(`${slice}/${boundary.boundaryId} lacks generated-artifact evidence`);
    }
    orderedBoundaries.push([slice, boundary.boundaryId, sha]);
  }
  const ownedRows = ledger.rows.filter((row) => row.approvedOwners.includes(slice));
  if (ownedRows.length === 0) throw new Error(`ledger has no rows approved for ${slice}`);
  for (const row of ownedRows) {
    const ownerEvidence = row.ownerEvidence?.[slice];
    if (!ownerEvidence) throw new Error(`${row.sourceCommit} lacks owner evidence for ${slice}`);
    if (ownerEvidence.slice !== slice || ownerEvidence.mergePath !== mergePaths.find((path) => path.endsWith(`/slices/${slice}/merge.json`))) {
      throw new Error(`${row.sourceCommit} points ${slice} at the wrong immutable merge record`);
    }
    if (stable(ownerEvidence.implementationBoundaries) !== stable(boundaries)) {
      throw new Error(`${row.sourceCommit} has stale generated boundary evidence for ${slice}`);
    }
  }
}
for (let index = 1; index < orderedBoundaries.length; index += 1) {
  if (!isAncestor(orderedBoundaries[index - 1][2], orderedBoundaries[index][2])) {
    throw new Error(
      `${orderedBoundaries[index - 1][0]}/${orderedBoundaries[index - 1][1]} is not an ancestor of ${orderedBoundaries[index][0]}/${orderedBoundaries[index][1]}`,
    );
  }
}
NODE
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
cd "$VERIFICATION_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
for source_prefix in 826690623 0aabe5a5e 1401860c7 8fad0357a; do
  source_sha="$(git rev-parse "${source_prefix}^{commit}")"
  if git merge-base --is-ancestor "$source_sha" origin/main; then
    exit 1
  fi
done
```

Expected: the provenance verifier passes, and the eight full PR-boundary SHAs form the F0 expansion
→ F0 application contraction → F0 physical contraction → F1a additive expansion → F1a reader
contraction → F1a physical contraction → F2 → F1b ancestry chain on `origin/main`. The new
verification branch is clean at that protected tip. Every assertion reads an immutable merge record
and its generated `ownerEvidence`; a shared row's global status is irrelevant while another approved
owner remains incomplete. Do not use or merge the source feature commits `826690623`, `0aabe5a5e`,
`1401860c7`, or `8fad0357a`; the execution ledger continues to prove their dispositions rather than
Git ancestry.

- [ ] **Step 2: Pair all fifteen HIGH findings with exact `origin/main` commit bodies**

Use a parser, not line-oriented search output, so each registry finding is paired with exactly one
commit body and its full SHA. The boundary checks require every closing commit to be after the
preceding protected boundary and reachable by the exact boundary that owns it. This distinguishes
the application and physical batch contractions and the F1a additive, reader-contract, and
physical-contract integrations.

Run:

```bash
F0_BASE_SHA="$(git rev-parse "${F0_EXPANSION_MAIN_SHA}^1")"
export F0_BASE_SHA
mkdir -p docs/evidence/aquamobil-v4-feeding
ACTIVE_VERIFICATION_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
cd "$ACTIVE_VERIFICATION_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --capture-finding-closures feeding-foundation-high-findings \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main \
  --write docs/evidence/aquamobil-v4-feeding/finding-closure-map.json
node --input-type=module - \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.findings.json \
  "$FEEDING_GATE_DIR/independent-trailer-map.json" <<'NODE'
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const [registryPath, inventoryPath, outputPath] = process.argv.slice(2);
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
if (
  inventory.schemaVersion !== 1 ||
  inventory.cycle !== '2026-08-26-aquamobil-v4-feeding-foundation' ||
  inventory.reviewFile !==
    'docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md' ||
  !Array.isArray(inventory.findings) ||
  inventory.findings.length !== 15
) {
  throw new Error('feeding finding inventory contract diverges');
}
const inventoryByTitle = new Map(
  inventory.findings.map((entry) => [entry.title, entry.evidence]),
);
if (inventoryByTitle.size !== inventory.findings.length) {
  throw new Error('feeding finding inventory contains a duplicate title');
}
const cycle = inventory.cycle;
const expected = new Map([
  ['AquaMobil V4 feeding foundation: centralize ration weight and unit protocol reads', 'F0 expansion'],
  ['AquaMobil V4 feeding foundation: move every ration reader to active unit protocol bindings', 'F0 expansion'],
  ['AquaMobil V4 feeding foundation: reconcile measured and projected biomass through one writer', 'F0 expansion'],
  ['AquaMobil V4 feeding foundation: recalculate ration plans atomically after weighing', 'F0 expansion'],
  ['AquaMobil V4 feeding foundation: validate growth sample tank projection parity', 'F0 expansion'],
  ['AquaMobil V4 feeding foundation: contract legacy batch protocol identity after reader rollout', 'F0 application contraction'],
  ['AquaMobil V4 feeding foundation: drop retired batch protocol column after application contraction', 'F0 physical contraction'],
  ['AquaMobil V4 feeding foundation: derive exact sub-equipment compatibility from the equipment catalog', 'F1a additive expansion'],
  ['AquaMobil V4 feeding foundation: drop retired scalar hardware compatibility after array cutover', 'F1a physical contraction'],
  ['AquaMobil V4 feeding foundation: enforce tenant feeder share totals in PostgreSQL', 'F1a additive expansion'],
  ['AquaMobil V4 feeding foundation: version feeder and VFD event language', 'F2 event and ACL'],
  ['AquaMobil V4 feeding foundation: generate cert-only feeder and VFD publish grants', 'F2 event and ACL'],
  ['AquaMobil V4 feeding foundation: expose tenant-safe feeder assignment API and producer', 'F1b assignment API'],
  ['AquaMobil V4 feeding foundation: serve feeder assignments and deterministic dose splits', 'F1b assignment API'],
  ['AquaMobil V4 feeding foundation: authorize GraphQL and subject-routed feeder change consumption', 'F1b assignment API'],
]);
if (
  expected.size !== inventoryByTitle.size ||
  [...expected.keys()].some((title) => !inventoryByTitle.has(title))
) {
  throw new Error('phase ownership and finding inventory title sets diverge');
}
const phaseShas = new Map([
  ['F0 expansion', process.env.F0_EXPANSION_MAIN_SHA],
  ['F0 application contraction', process.env.F0_APP_CONTRACTION_MAIN_SHA],
  ['F0 physical contraction', process.env.F0_COLUMN_CONTRACTION_MAIN_SHA],
  ['F1a additive expansion', process.env.F1A_EXPANSION_MAIN_SHA],
  ['F1a reader contraction', process.env.F1A_READER_CONTRACTION_MAIN_SHA],
  ['F1a physical contraction', process.env.F1A_PHYSICAL_CONTRACTION_MAIN_SHA],
  ['F2 event and ACL', process.env.F2_MAIN_SHA],
  ['F1b assignment API', process.env.F1B_MAIN_SHA],
]);
const precedingPhase = new Map([
  ['F0 expansion', 'F0 base'],
  ['F0 application contraction', 'F0 expansion'],
  ['F0 physical contraction', 'F0 application contraction'],
  ['F1a additive expansion', 'F0 physical contraction'],
  ['F1a reader contraction', 'F1a additive expansion'],
  ['F1a physical contraction', 'F1a reader contraction'],
  ['F2 event and ACL', 'F1a physical contraction'],
  ['F1b assignment API', 'F2 event and ACL'],
]);
phaseShas.set('F0 base', process.env.F0_BASE_SHA);
const rows = fs
  .readFileSync(registryPath, 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line))
  .filter((row) => row.raised_in_cycle === cycle);
if (rows.length !== expected.size) throw new Error(`expected ${expected.size} cycle rows`);
for (const title of expected.keys()) {
  const matches = rows.filter((row) => row.title === title);
  if (matches.length !== 1) {
    throw new Error(`registry must contain exactly one row titled: ${title}`);
  }
  const [row] = matches;
  if (
    !/^FARM-HIGH-[0-9]{3}$/.test(row.id) ||
    row.severity !== 'HIGH' ||
    row.state !== 'OPEN' ||
    row.layer !== 1 ||
    JSON.stringify(row.evidence) !== JSON.stringify([inventoryByTitle.get(title)]) ||
    row.rule_violated !== 'AquaMobil V4 safe integration feeding release contract' ||
    row.owner_agent !== 'claude' ||
    row.review_file !== inventory.reviewFile ||
    row.closed_at !== null ||
    JSON.stringify(row.closing_commits) !== '[]'
  ) {
    throw new Error(`pre-closure allocation contract diverges: ${title}`);
  }
}
if (rows.some((row) => !expected.has(row.title))) {
  throw new Error('registry cycle contains an unexpected title');
}

const rawLog = execFileSync(
  'git',
  ['log', 'origin/main', '--format=@@AQUAMOBIL_COMMIT@@%H%n%B'],
  { encoding: 'utf8' },
);
const commits = rawLog
  .split('@@AQUAMOBIL_COMMIT@@')
  .slice(1)
  .map((block) => {
    const [sha, ...bodyLines] = block.replace(/^\n/, '').split(/\r?\n/);
    return { sha, lines: bodyLines };
  });
const isAncestor = (older, newer) =>
  spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
const trailerMap = {};
const trailerPrefix = `Closes: docs/reviews/claude/${cycle}.md#`;
const expectedTrailers = new Set(rows.map((row) => `${trailerPrefix}${row.id}`));
const observedTrailers = commits.flatMap((commit) =>
  commit.lines.filter((line) => line.startsWith(trailerPrefix)),
);
if (
  observedTrailers.length !== expectedTrailers.size ||
  observedTrailers.some((line) => !expectedTrailers.has(line))
) {
  throw new Error('origin/main cycle trailers differ from the fifteen registered findings');
}

for (const row of rows) {
  const trailer = `${trailerPrefix}${row.id}`;
  const occurrences = commits.flatMap((commit) =>
    commit.lines.filter((line) => line === trailer).map(() => ({ sha: commit.sha })),
  );
  if (occurrences.length !== 1) {
    throw new Error(`${row.id} has ${occurrences.length} exact origin/main trailer occurrences`);
  }
  const [{ sha }] = occurrences;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${row.id} resolved to a short SHA`);
  const phase = expected.get(row.title);
  const phaseSha = phaseShas.get(phase);
  if (!isAncestor(sha, phaseSha)) {
    throw new Error(`${row.id} closing commit is not reachable by ${phase}`);
  }
  const prior = precedingPhase.get(phase);
  if (prior && isAncestor(sha, phaseShas.get(prior))) {
    throw new Error(`${row.id} closing commit predates its ${phase} slice`);
  }
  trailerMap[row.id] = sha;
}
fs.writeFileSync(outputPath, `${JSON.stringify(trailerMap, null, 2)}\n`);
NODE
cmp \
  "$FEEDING_GATE_DIR/independent-trailer-map.json" \
  docs/evidence/aquamobil-v4-feeding/finding-closure-map.json
test "$(jq 'length' docs/evidence/aquamobil-v4-feeding/finding-closure-map.json)" -eq 15
```

Expected: every expected title occurs exactly once in the registry, every exact trailer occurs in
exactly one `origin/main` commit body, the bootstrap-owned capture and independent parser agree on
fifteen full SHAs, and each closer falls inside its immutable-boundary-backed phase. A protected
squash is acceptable only when its complete commit body retains every exact trailer for that slice.

- [ ] **Step 3: Run focused domain suites**

Run:

```bash
npx nx test event-contracts --runInBand
npx nx test farm-service --runInBand
npx nx test gateway-api --runInBand
npx nx test invariants --runInBand --testPathPatterns=feeding-ration-authority.spec.ts
npx nx test farm-service --runInBand --testPathPatterns=feeder-assignment.sdl.spec.ts
npm --prefix web/modules/farm-module run test -- src/pages/setup/tabs/__tests__/EquipmentTab.feeder-selection.spec.tsx
```

Expected: all suites PASS.

- [ ] **Step 4: Run PostgreSQL and migration acceptance**

Run:

```bash
npm run infra:up
npx nx run farm-service:e2e --runInBand --testPathPatterns='(tank-batch-weight-provenance|batch-protocol-id-app-contraction|batch-protocol-id-contraction|sub-equipment-compatibility-expand|sub-equipment-compatibility-app-contraction|sub-equipment-compatibility-contract|feeder-assignment-share-sum|feeder-assignment-api|running-fcr-sweep)\.postgres\.spec\.ts'
npm run test:bootstrap
npm run test:tenant-clone
npm run test:schema-invariants
npm run gates:migration-sql
```

Expected: all commands PASS; bootstrap, tenant clone, and fan-out apply every newly generated
migration.

- [ ] **Step 5: Run invariant cluster**

Run:

```bash
npx nx test invariants --runInBand --testPathPatterns='(entity-schema-declaration|entity-diff-implies-migration|tenant-fanout-entity-parity|farm-service-migration-array-completeness|farm-service-tenant-isolation|farm-stock-mutation-central-only|farm-stock-mutation-ssot|feeding-ration-authority|upcaster-chain|nats-config-ssot|rls-predicate-canonical)\.spec\.ts'
```

Expected: every listed invariant PASS.

- [ ] **Step 6: Prove every generator is clean before writing evidence**

Run:

```bash
test -z "$(git status --porcelain)"
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
./scripts/nats/generate-nats-conf.py
git diff --exit-code
test -z "$(git status --porcelain)"
npm run smoke:nats-messaging-acl:static
npm run smoke:nats-messaging-acl:external
npm run smoke:nats-feeding-acl:static
npm run smoke:nats-feeding-acl
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath \
  tests/invariants/ci-image-digests.spec.ts
```

Expected: GraphQL SDL generation precedes composition and client code generation; every generator
leaves the entire worktree clean, not merely a hand-selected path list; and all generic/feeding
static and live ACL probes PASS with cert-CN authentication. The dedicated feeding harness must
start its ephemeral broker and prove the exact feeder/VFD allow/deny matrix plus rejection of an
unregistered certificate CN.

- [ ] **Step 7: Run repository-wide gates over the full eight-boundary range**

Run:

```bash
F0_BASE_SHA="$(git rev-parse "${F0_EXPANSION_MAIN_SHA}^1")"
export F0_BASE_SHA
npx nx affected --target=test --base="$F0_BASE_SHA" --head="$F1B_MAIN_SHA"
npx nx affected --target=lint --base="$F0_BASE_SHA" --head="$F1B_MAIN_SHA"
npx nx affected --target=build --base="$F0_BASE_SHA" --head="$F1B_MAIN_SHA"
npm run type-check
npx tsc --noEmit -p apps/gateway-api/tsconfig.app.json
npx nx build gateway-api
npm run format:check
git diff --check
```

Expected: all commands PASS across the complete eight-boundary F0-through-F1b interval, the
gateway-specific compiler/build gates required by its nested `CLAUDE.md` are green, and no
formatting write is needed. Using `HEAD` versus `origin/main` here would select an empty range on
the clean verification branch, so the ledger-backed phase boundary is mandatory.

- [ ] **Step 8: Capture durable audit inputs from all eight protected boundaries**

First derive the changed paths from each protected boundary against its first parent. Preserve
exact, sorted JSON arrays for the complete list and for production roots; test files and
documentation are not production paths, while migrations, generated schemas, runtime configuration,
NATS harnesses, package manifests, and lockfiles are.

Run:

```bash
{
  git diff --name-only "${F0_EXPANSION_MAIN_SHA}^1" "$F0_EXPANSION_MAIN_SHA"
  git diff --name-only "${F0_APP_CONTRACTION_MAIN_SHA}^1" "$F0_APP_CONTRACTION_MAIN_SHA"
  git diff --name-only "${F0_COLUMN_CONTRACTION_MAIN_SHA}^1" "$F0_COLUMN_CONTRACTION_MAIN_SHA"
  git diff --name-only "${F1A_EXPANSION_MAIN_SHA}^1" "$F1A_EXPANSION_MAIN_SHA"
  git diff --name-only "${F1A_READER_CONTRACTION_MAIN_SHA}^1" "$F1A_READER_CONTRACTION_MAIN_SHA"
  git diff --name-only "${F1A_PHYSICAL_CONTRACTION_MAIN_SHA}^1" "$F1A_PHYSICAL_CONTRACTION_MAIN_SHA"
  git diff --name-only "${F2_MAIN_SHA}^1" "$F2_MAIN_SHA"
  git diff --name-only "${F1B_MAIN_SHA}^1" "$F1B_MAIN_SHA"
} | LC_ALL=C sort -u > "$FEEDING_GATE_DIR/feeding-affected-paths.txt"
node --input-type=module - \
  "$FEEDING_GATE_DIR/feeding-affected-paths.txt" \
  "$FEEDING_GATE_DIR/affected-paths.json" \
  "$FEEDING_GATE_DIR/production-paths.json" <<'NODE'
import fs from 'node:fs';

const [inputPath, affectedOutputPath, productionOutputPath] = process.argv.slice(2);
const roots = /^(apps\/(farm-service|gateway-api)|libs\/(event-contracts|backend-common)|platform\/libs|infrastructure\/(docker\/nats|helm|nats)|scripts\/nats|web\/(shared-ui|modules\/farm-module)|package(-lock)?\.json)/;
const nonProduction = /(^|\/)(__tests__|tests?|fixtures?|mocks?)(\/|$)|\.(spec|test)\.[^/]+$/;
const paths = fs.readFileSync(inputPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const productionPaths = paths.filter((path) => roots.test(path) && !nonProduction.test(path));
if (productionPaths.length === 0) throw new Error('feeding production path set is empty');
fs.writeFileSync(affectedOutputPath, `${JSON.stringify(paths, null, 2)}\n`);
fs.writeFileSync(productionOutputPath, `${JSON.stringify(productionPaths, null, 2)}\n`);
NODE
FEEDING_BUNDLE_MANIFEST=artifacts/aquamobil-v4-feeding/dependency-audit/aquamobil-vite-rollup-modules.json
export FEEDING_BUNDLE_MANIFEST
mkdir -p "$(dirname "$FEEDING_BUNDLE_MANIFEST")"
export AQUAMOBIL_BUILD_ID="$TESTED_MAIN_SHA"
export AQUAMOBIL_AUDIT_MODULE_MANIFEST="$FEEDING_BUNDLE_MANIFEST"
npm --prefix web/apps/aquamobil run build
test -s "$FEEDING_BUNDLE_MANIFEST"
unset AQUAMOBIL_AUDIT_MODULE_MANIFEST
set +e
npm audit --json > "$FEEDING_GATE_DIR/audit-root-full.json"
root_full_status="$?"
npm audit --omit=dev --json > "$FEEDING_GATE_DIR/audit-root-runtime.json"
root_runtime_status="$?"
npm --prefix web/apps/aquamobil audit --json > "$FEEDING_GATE_DIR/audit-aquamobil-full.json"
aquamobil_full_status="$?"
npm --prefix web/apps/aquamobil audit --omit=dev --json > "$FEEDING_GATE_DIR/audit-aquamobil-runtime.json"
aquamobil_runtime_status="$?"
set -e
printf '%s\n' \
  "$root_full_status" \
  "$root_runtime_status" \
  "$aquamobil_full_status" \
  "$aquamobil_runtime_status" \
  > "$FEEDING_GATE_DIR/audit-exit-statuses.txt"
node --input-type=module - \
  "$FEEDING_GATE_DIR/audit-root-full.json" \
  "$FEEDING_GATE_DIR/audit-root-runtime.json" \
  "$FEEDING_GATE_DIR/audit-aquamobil-full.json" \
  "$FEEDING_GATE_DIR/audit-aquamobil-runtime.json" <<'NODE'
import fs from 'node:fs';

for (const auditPath of process.argv.slice(2)) {
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  if (audit.error) {
    throw new Error(`${auditPath}: npm audit operational failure: ${audit.error.summary ?? 'unknown'}`);
  }
  if (!audit.metadata || !audit.metadata.vulnerabilities || !audit.vulnerabilities) {
    throw new Error(`${auditPath}: npm audit JSON is missing vulnerability metadata`);
  }
}
NODE
ACTIVE_VERIFICATION_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
cd "$ACTIVE_VERIFICATION_WORKTREE"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --capture-explain-set \
  --root-audit-full "$FEEDING_GATE_DIR/audit-root-full.json" \
  --root-audit-runtime "$FEEDING_GATE_DIR/audit-root-runtime.json" \
  --aquamobil-audit-full "$FEEDING_GATE_DIR/audit-aquamobil-full.json" \
  --aquamobil-audit-runtime "$FEEDING_GATE_DIR/audit-aquamobil-runtime.json" \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json "$FEEDING_GATE_DIR/audit-set.json" \
  --write-explain-set-json "$FEEDING_GATE_DIR/npm-explain-set.json"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --audit-set-json "$FEEDING_GATE_DIR/audit-set.json" \
  --explain-set-json "$FEEDING_GATE_DIR/npm-explain-set.json" \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest "$FEEDING_BUNDLE_MANIFEST" \
  --output-json "$FEEDING_GATE_DIR/dependency-reachability.json" \
  --output-markdown "$FEEDING_GATE_DIR/dependency-reachability.md"
```

Expected: all four raw audit documents and their ordered exit statuses are retained even when
`npm audit` uses a nonzero advisory exit. The canonical capture mode safely invokes locked npm for
every high/critical package in each installation and emits the sole audit/explain sets. The mapper
emits complete chains for both locks, distinguishes runtime from release-build tools such as direct
`esbuild`, and treats a package as browser-reachable only when the real production Vite/Rollup
module manifest resolves it to an emitted chunk. An operational audit failure, invalid explain,
unclassified advisory, missing chain, or reachable high/critical production classification is a hard
failure. Do not run `npm audit fix`, change a dependency, or dismiss an aggregate advisory count in
this task. Keep every raw capture for Step 9; ignored artifacts and the scratch directory are not
release evidence by themselves.

- [ ] **Step 9: Materialize and machine-check release evidence**

Use `apply_patch` to create the observed evidence files below, except for the closure map already
written by the bootstrap-owned capture command in Step 2; never insert assumed values:

- `docs/evidence/aquamobil-v4-feeding/foundation-verification.md` records the tested
  `TESTED_MAIN_SHA`, all eight protected PR-boundary SHAs, UTC execution time, database/NATS
  environment identifier, exact commands and exit statuses from Steps 2–8, per-tenant
  migration/backfill counts, semantic batch/protocol mapping parity, the one-winner concurrency
  assertion, generator-clean status, and all four ordered audit exit statuses.
- `docs/evidence/aquamobil-v4-feeding/dependency-reachability.json` follows the interface below, as
  a byte-identical copy of the deterministic program mapper's package-name-sorted output for every
  high/critical package from the canonical four-audit set.
- `docs/evidence/aquamobil-v4-feeding/finding-closure-map.json` is the exact fifteen-entry object
  produced and independently verified in Step 2. Do not hand-edit it; it retains the full SHAs
  selected with Git `%H` output.
- `docs/evidence/aquamobil-v4-feeding/finding-closure-attestations.json` contains exactly one
  attestation per map entry using the second interface below and only observed values.
- `docs/evidence/aquamobil-v4-feeding/dependency-audit/` contains byte-identical copies of the four
  raw audits, ordered exit statuses, canonical audit/explain sets, production Vite/Rollup module
  manifest, mapper Markdown, and affected/production path arrays. These repository files, not
  ignored artifacts or the scratch directory, are the audit authority.

```ts
type FeedingDependencyReachabilityEvidence = readonly {
  readonly packageName: string;
  readonly installedVersion: string;
  readonly severity: 'high' | 'critical';
  readonly dependencyChain: readonly string[];
  readonly graph:
    | 'root-runtime'
    | 'root-release-build'
    | 'aquamobil-runtime'
    | 'aquamobil-release-build';
  readonly reachability: 'reachable' | 'not-reachable';
  readonly proofKind:
    | 'npm-explain-json'
    | 'package-lock-production-path'
    | 'vite-rollup-module-manifest';
  readonly proofSha256: string;
}[];

interface FeedingFindingClosureAttestation {
  readonly findingId: string;
  readonly title: string;
  readonly severity: 'HIGH';
  readonly owner: 'F0' | 'F1a' | 'F2' | 'F1b';
  readonly boundary: string;
  readonly boundaryMainCommit: string;
  readonly closingCommit: string;
  readonly closingCommitBodySha256: string;
  readonly protectedPullRequestUrl: string;
  readonly protectedPullRequestCommit: string;
  readonly ownerBoundaryEvidenceSha256: string;
  readonly reviewSectionSha256: string;
  readonly verificationEvidenceSha256: string;
  readonly attestedAtUtc: string;
}
```

For every attestation, hash bytes exactly as the verifier below does: Git `%B` output for the
closing body, the complete review section beginning at its unique `## ID` heading, canonical JSON
for `{ owner, boundary, url, commit }`, and the committed `foundation-verification.md` bytes. The
protected PR URL/commit must come from the matching `implementationBoundaries` item in the owner's
immutable slice merge record, never from branch archaeology or a manually supplied URL.

Then run this fail-closed parity check:

```bash
EVIDENCE_DIR=docs/evidence/aquamobil-v4-feeding
export EVIDENCE_DIR
cmp "$FEEDING_GATE_DIR/affected-paths.json" "$EVIDENCE_DIR/dependency-audit/affected-paths.json"
cmp "$FEEDING_GATE_DIR/production-paths.json" "$EVIDENCE_DIR/dependency-audit/production-paths.json"
cmp "$FEEDING_GATE_DIR/audit-root-full.json" "$EVIDENCE_DIR/dependency-audit/audit-root-full.json"
cmp "$FEEDING_GATE_DIR/audit-root-runtime.json" "$EVIDENCE_DIR/dependency-audit/audit-root-runtime.json"
cmp "$FEEDING_GATE_DIR/audit-aquamobil-full.json" "$EVIDENCE_DIR/dependency-audit/audit-aquamobil-full.json"
cmp "$FEEDING_GATE_DIR/audit-aquamobil-runtime.json" "$EVIDENCE_DIR/dependency-audit/audit-aquamobil-runtime.json"
cmp "$FEEDING_GATE_DIR/audit-exit-statuses.txt" "$EVIDENCE_DIR/dependency-audit/audit-exit-statuses.txt"
cmp "$FEEDING_GATE_DIR/audit-set.json" "$EVIDENCE_DIR/dependency-audit/audit-set.json"
cmp "$FEEDING_GATE_DIR/npm-explain-set.json" "$EVIDENCE_DIR/dependency-audit/npm-explain-set.json"
cmp "$FEEDING_BUNDLE_MANIFEST" "$EVIDENCE_DIR/dependency-audit/aquamobil-vite-rollup-modules.json"
cmp "$FEEDING_GATE_DIR/dependency-reachability.md" "$EVIDENCE_DIR/dependency-audit/dependency-reachability.md"
cmp "$FEEDING_GATE_DIR/dependency-reachability.json" "$EVIDENCE_DIR/dependency-reachability.json"
node --input-type=module - \
  docs/evidence/aquamobil-v4-feeding/dependency-reachability.json <<'NODE'
import fs from 'node:fs';

const [evidencePath] = process.argv.slice(2);
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
if (!Array.isArray(evidence)) throw new Error('dependency evidence must be an array');
const packageNames = evidence.map((row) => row.packageName);
if (JSON.stringify(packageNames) !== JSON.stringify([...packageNames].sort())) {
  throw new Error('dependency evidence is not package-name sorted');
}
const exactKeys = [
  'dependencyChain',
  'graph',
  'installedVersion',
  'packageName',
  'proofKind',
  'proofSha256',
  'reachability',
  'severity',
];
for (const row of evidence) {
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(exactKeys)) {
    throw new Error(`${row.packageName} fields differ from the program evidence contract`);
  }
  if (
    typeof row.packageName !== 'string' ||
    row.packageName.trim().length === 0 ||
    typeof row.installedVersion !== 'string' ||
    row.installedVersion.trim().length === 0
  ) {
    throw new Error('dependency identity is absent');
  }
  if (
    !Array.isArray(row.dependencyChain) ||
    row.dependencyChain.length === 0 ||
    row.dependencyChain.some(
      (entry) => typeof entry !== 'string' || entry.trim().length === 0,
    )
  ) {
    throw new Error(`dependency chain is absent at ${row.packageName}`);
  }
  if (!['high', 'critical'].includes(row.severity)) {
    throw new Error(`invalid severity at ${row.packageName}`);
  }
  if (
    ![
      'root-runtime',
      'root-release-build',
      'aquamobil-runtime',
      'aquamobil-release-build',
    ].includes(row.graph)
  ) {
    throw new Error(`invalid graph at ${row.packageName}`);
  }
  if (!['reachable', 'not-reachable'].includes(row.reachability)) {
    throw new Error(`invalid reachability at ${row.packageName}`);
  }
  if (
    ![
      'npm-explain-json',
      'package-lock-production-path',
      'vite-rollup-module-manifest',
    ].includes(row.proofKind)
  ) {
    throw new Error(`invalid proof kind at ${row.packageName}`);
  }
  if (!/^[0-9a-f]{64}$/.test(row.proofSha256)) {
    throw new Error(`invalid proof digest at ${row.packageName}`);
  }
  if (row.reachability === 'reachable') {
    throw new Error(`release-blocking reachable advisory: ${row.packageName}`);
  }
}
NODE
node --input-type=module - \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/claude/2026-08-26-aquamobil-v4-feeding-foundation.md \
  "$F0_MERGE" "$F1A_MERGE" "$F2_MERGE" "$F1B_MERGE" \
  "$EVIDENCE_DIR/finding-closure-map.json" \
  "$EVIDENCE_DIR/finding-closure-attestations.json" \
  "$EVIDENCE_DIR/foundation-verification.md" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const [
  registryPath,
  reviewPath,
  f0MergePath,
  f1aMergePath,
  f2MergePath,
  f1bMergePath,
  mapPath,
  attestationsPath,
  verificationPath,
] = process.argv.slice(2);
const cycle = '2026-08-26-aquamobil-v4-feeding-foundation';
const mainResultKey = ['result', 'ingMainCommit'].join('');
const mergeRecords = new Map(
  [f0MergePath, f1aMergePath, f2MergePath, f1bMergePath].map((mergePath) => {
    const record = JSON.parse(fs.readFileSync(mergePath, 'utf8'));
    return [record.slice, record];
  }),
);
const boundaries = new Map([
  ['AquaMobil V4 feeding foundation: centralize ration weight and unit protocol reads', ['F0', 'F0 expansion', 'weighing-authority-expand']],
  ['AquaMobil V4 feeding foundation: move every ration reader to active unit protocol bindings', ['F0', 'F0 expansion', 'weighing-authority-expand']],
  ['AquaMobil V4 feeding foundation: reconcile measured and projected biomass through one writer', ['F0', 'F0 expansion', 'weighing-authority-expand']],
  ['AquaMobil V4 feeding foundation: recalculate ration plans atomically after weighing', ['F0', 'F0 expansion', 'weighing-authority-expand']],
  ['AquaMobil V4 feeding foundation: validate growth sample tank projection parity', ['F0', 'F0 expansion', 'weighing-authority-expand']],
  ['AquaMobil V4 feeding foundation: contract legacy batch protocol identity after reader rollout', ['F0', 'F0 application contraction', 'batch-protocol-reader-contract']],
  ['AquaMobil V4 feeding foundation: drop retired batch protocol column after application contraction', ['F0', 'F0 physical contraction', 'batch-protocol-physical-contract']],
  ['AquaMobil V4 feeding foundation: derive exact sub-equipment compatibility from the equipment catalog', ['F1a', 'F1a additive expansion', 'compatibility-and-feeder-model-expand']],
  ['AquaMobil V4 feeding foundation: drop retired scalar hardware compatibility after array cutover', ['F1a', 'F1a physical contraction', 'legacy-scalar-physical-contract']],
  ['AquaMobil V4 feeding foundation: enforce tenant feeder share totals in PostgreSQL', ['F1a', 'F1a additive expansion', 'compatibility-and-feeder-model-expand']],
  ['AquaMobil V4 feeding foundation: version feeder and VFD event language', ['F2', 'F2 event and ACL', 'event-language-and-acl']],
  ['AquaMobil V4 feeding foundation: generate cert-only feeder and VFD publish grants', ['F2', 'F2 event and ACL', 'event-language-and-acl']],
  ['AquaMobil V4 feeding foundation: expose tenant-safe feeder assignment API and producer', ['F1b', 'F1b assignment API', 'assignment-api-and-gateway']],
  ['AquaMobil V4 feeding foundation: serve feeder assignments and deterministic dose splits', ['F1b', 'F1b assignment API', 'assignment-api-and-gateway']],
  ['AquaMobil V4 feeding foundation: authorize GraphQL and subject-routed feeder change consumption', ['F1b', 'F1b assignment API', 'assignment-api-and-gateway']],
]);
const rows = fs
  .readFileSync(registryPath, 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line))
  .filter((row) => row.raised_in_cycle === cycle);
const review = fs.readFileSync(reviewPath, 'utf8');
const closureMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const attestations = JSON.parse(fs.readFileSync(attestationsPath, 'utf8'));
const verificationBytes = fs.readFileSync(verificationPath);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isAncestor = (older, newer) =>
  spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
const exactKeys = [
  'attestedAtUtc',
  'boundary',
  'boundaryMainCommit',
  'closingCommit',
  'closingCommitBodySha256',
  'findingId',
  'owner',
  'ownerBoundaryEvidenceSha256',
  'protectedPullRequestCommit',
  'protectedPullRequestUrl',
  'reviewSectionSha256',
  'severity',
  'title',
  'verificationEvidenceSha256',
];
if (rows.length !== 15 || boundaries.size !== 15) throw new Error('expected fifteen findings');
if (Object.keys(closureMap).length !== 15 || attestations.length !== 15) {
  throw new Error('closure map and attestation count must both be fifteen');
}
const orderedIds = attestations.map((row) => row.findingId);
if (JSON.stringify(orderedIds) !== JSON.stringify([...orderedIds].sort())) {
  throw new Error('attestations must be sorted by finding ID');
}
for (const registryRow of rows) {
  if (registryRow.severity !== 'HIGH' || registryRow.state !== 'OPEN') {
    throw new Error(`${registryRow.id} is not an open HIGH finding`);
  }
  if ((registryRow.closing_commits ?? []).length !== 0) {
    throw new Error(`${registryRow.id} already has a closing commit`);
  }
  const matches = attestations.filter((row) => row.findingId === registryRow.id);
  if (matches.length !== 1) throw new Error(`${registryRow.id} lacks one attestation`);
  const attestation = matches[0];
  if (JSON.stringify(Object.keys(attestation).sort()) !== JSON.stringify(exactKeys)) {
    throw new Error(`${registryRow.id} attestation fields differ from the contract`);
  }
  const [owner, boundary, boundaryId] = boundaries.get(registryRow.title) ?? [];
  const boundaryMatches = (mergeRecords.get(owner)?.implementationBoundaries ?? []).filter(
    (item) => item.boundaryId === boundaryId,
  );
  if (boundaryMatches.length !== 1) {
    throw new Error(`${registryRow.id} lacks one immutable implementation boundary`);
  }
  const [boundaryEvidence] = boundaryMatches;
  const boundaryMainCommit = boundaryEvidence[mainResultKey];
  const link = boundaryEvidence.pullRequest;
  if (
    attestation.title !== registryRow.title ||
    attestation.severity !== 'HIGH' ||
    attestation.owner !== owner ||
    attestation.boundary !== boundary ||
    attestation.boundaryMainCommit !== boundaryMainCommit
  ) {
    throw new Error(`${registryRow.id} attests the wrong title, owner, or boundary`);
  }
  if (attestation.closingCommit !== closureMap[registryRow.id]) {
    throw new Error(`${registryRow.id} closing map and attestation differ`);
  }
  if (!/^[0-9a-f]{40}$/.test(attestation.closingCommit)) {
    throw new Error(`${registryRow.id} closing commit is not full length`);
  }
  if (
    !isAncestor(attestation.closingCommit, boundaryMainCommit) ||
    !isAncestor(attestation.closingCommit, 'origin/main')
  ) {
    throw new Error(`${registryRow.id} closing commit is outside its protected boundary`);
  }
  const commitBody = execFileSync(
    'git',
    ['show', '-s', '--format=%B', attestation.closingCommit],
    { encoding: 'utf8' },
  );
  const trailer = `Closes: docs/reviews/claude/${cycle}.md#${registryRow.id}`;
  if (commitBody.split(/\r?\n/).filter((line) => line === trailer).length !== 1) {
    throw new Error(`${registryRow.id} does not have exactly one exact closing trailer`);
  }
  if (attestation.closingCommitBodySha256 !== sha256(commitBody)) {
    throw new Error(`${registryRow.id} commit-body digest differs`);
  }
  const heading = `## ${registryRow.id}\n`;
  if (review.split(heading).length !== 2) {
    throw new Error(`${registryRow.id} review heading is not unique`);
  }
  const sectionStart = review.indexOf(heading);
  const nextHeading = review.indexOf('\n## ', sectionStart + heading.length);
  const section = review.slice(sectionStart, nextHeading === -1 ? review.length : nextHeading + 1);
  if (attestation.reviewSectionSha256 !== sha256(section)) {
    throw new Error(`${registryRow.id} review-section digest differs`);
  }
  if (attestation.verificationEvidenceSha256 !== sha256(verificationBytes)) {
    throw new Error(`${registryRow.id} verification-evidence digest differs`);
  }
  if (
    link?.kind !== 'github-pull-request' ||
    link.state !== 'MERGED' ||
    link.baseRefName !== 'main' ||
    link[mainResultKey] !== boundaryMainCommit ||
    !/^https:\/\//.test(link.url ?? '')
  ) {
    throw new Error(`${registryRow.id} lacks exact protected-PR boundary evidence`);
  }
  if (
    attestation.protectedPullRequestUrl !== link.url ||
    attestation.protectedPullRequestCommit !== boundaryMainCommit
  ) {
    throw new Error(`${registryRow.id} protected PR evidence differs`);
  }
  const ownerBoundaryEvidence = JSON.stringify({
    owner,
    boundary,
    url: link.url,
    commit: boundaryMainCommit,
  });
  if (attestation.ownerBoundaryEvidenceSha256 !== sha256(ownerBoundaryEvidence)) {
    throw new Error(`${registryRow.id} owner-boundary evidence digest differs`);
  }
  if (
    typeof attestation.attestedAtUtc !== 'string' ||
    Number.isNaN(Date.parse(attestation.attestedAtUtc)) ||
    !attestation.attestedAtUtc.endsWith('Z')
  ) {
    throw new Error(`${registryRow.id} attestation time is not UTC`);
  }
}
NODE
jq -e 'length == 15 and all(to_entries[]; (.key | test("^FARM-HIGH-[0-9]{3}$")) and (.value | test("^[0-9a-f]{40}$")))' \
  docs/evidence/aquamobil-v4-feeding/finding-closure-map.json
(
  cd "$EVIDENCE_DIR"
  {
    printf '%s\n' \
      dependency-audit/affected-paths.json \
      dependency-audit/aquamobil-vite-rollup-modules.json \
      dependency-audit/audit-aquamobil-full.json \
      dependency-audit/audit-aquamobil-runtime.json \
      dependency-audit/audit-exit-statuses.txt \
      dependency-audit/audit-root-full.json \
      dependency-audit/audit-root-runtime.json \
      dependency-audit/audit-set.json \
      dependency-audit/dependency-reachability.md \
      dependency-audit/npm-explain-set.json \
      dependency-audit/production-paths.json \
      dependency-reachability.json \
      finding-closure-attestations.json \
      finding-closure-map.json \
      foundation-verification.md
  } | LC_ALL=C sort | xargs sha256sum
) > "$FEEDING_GATE_DIR/SHA256SUMS"
```

Use `apply_patch` once more to create
`docs/evidence/aquamobil-v4-feeding/dependency-audit/SHA256SUMS` with the exact scratch manifest,
then run:

```bash
cmp "$FEEDING_GATE_DIR/SHA256SUMS" "$EVIDENCE_DIR/dependency-audit/SHA256SUMS"
(cd "$EVIDENCE_DIR" && sha256sum -c dependency-audit/SHA256SUMS)
npm run findings:verify
git diff --check
```

Expected: evidence exactly matches the captured files, every high/critical package is classified, no
reachable high/critical production advisory remains, all fifteen closing SHAs are full, every HIGH
finding has an exact boundary/commit/review/evidence attestation, the durable hash manifest
verifies, and no credential, connection string, certificate content, raw event payload, tenant UUID,
or tenant PII appears in committed evidence.

- [ ] **Step 10: Commit, push, and merge the verification evidence through a protected PR**

Run:

```bash
git add \
  docs/evidence/aquamobil-v4-feeding/foundation-verification.md \
  docs/evidence/aquamobil-v4-feeding/dependency-reachability.json \
  docs/evidence/aquamobil-v4-feeding/finding-closure-map.json \
  docs/evidence/aquamobil-v4-feeding/finding-closure-attestations.json \
  docs/evidence/aquamobil-v4-feeding/dependency-audit
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
STAGED_FILES="$(git diff --cached --name-only | paste -sd, -)"
test -n "$STAGED_FILES"
npx nx affected --target=test --files="$STAGED_FILES"
npx nx affected --target=lint --files="$STAGED_FILES"
test -z "$(git diff --cached --name-only | rg -v '^(docs/evidence/aquamobil-v4-feeding/|tools/quality/format-scope\.json$)')"
(cd "$EVIDENCE_DIR" && sha256sum -c dependency-audit/SHA256SUMS)
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "test(farm): record feeding foundation release evidence"
git push --set-upstream origin "$VERIFICATION_BRANCH"
VERIFICATION_PR_URL="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --head "$VERIFICATION_BRANCH" \
  --title "test(farm): record feeding foundation release evidence" \
  --body "Verify the protected F0/F1a/F2/F1b boundaries, dependency reachability, and exact finding trailers before the registry-only closure.")"
verification_pr_number="$(gh pr view "$VERIFICATION_PR_URL" \
  --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$verification_pr_number" \
  --repo Okan-wqm/aquaculture_platform --watch --fail-fast
test "$(gh pr view "$verification_pr_number" \
  --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision,baseRefName,headRefName \
  --jq '[.state, .reviewDecision, .baseRefName, .headRefName] | @tsv')" = \
  $'OPEN\tAPPROVED\tmain\tchore/aquamobil-v4-feeding-foundation-verification'
ACTIVE_VERIFICATION_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$ACTIVE_VERIFICATION_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$verification_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind auxiliary-verification \
  --expected-head "$VERIFICATION_BRANCH" \
  --verify-base-advance \
  --require-latest-merge-queue-candidate
```

Only after the exact auxiliary-verification prospective gate passes may the approved PR merge
without bypassing protection. Any base advance that overlaps the evidence authority blocks merge;
merge current `origin/main` normally into the branch, rerun the complete evidence/audit/hash suite,
obtain a distinct approval, and rerun the latest-candidate gate. CI may attach a duplicate evidence
bundle for convenience, but the reviewed commit must contain all four raw audit documents and
statuses, the canonical audit/explain sets, production Vite/Rollup module manifest, exact path
arrays, mapper outputs, reachability decisions, closure attestations, and verified hash manifest.
Record the full main SHA reported for that merged PR as `VERIFICATION_MAIN_SHA`; do not infer it
from a local short log.

Expected: the pushed branch contains only the declared evidence tree plus the exact generator-owned
`tools/quality/format-scope.json`, the format-scope check and every durable hash verification pass,
the protected PR is merged, and both recorded values identify that exact reviewed evidence change.

- [ ] **Step 11: Close findings on a registry-only protected branch**

Fetch the merged verification PR, validate its evidence, and create a distinct clean closure branch
before editing the registry. The four immutable merge records, their generated ledger projection,
and the verification evidence tree are read-only inputs on this branch. Run:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
: "${VERIFICATION_PR_URL:?export the merged protected verification PR URL}"
: "${VERIFICATION_MAIN_SHA:?export the merged verification main SHA}"
case "$VERIFICATION_PR_URL" in
  https://*) ;;
  *) exit 1 ;;
esac
printf '%s\n' "$VERIFICATION_MAIN_SHA" | rg -q '^[0-9a-f]{40}$'
git -C /var/aqua-saas merge-base --is-ancestor "$VERIFICATION_MAIN_SHA" origin/main
set +e
git -C /var/aqua-saas diff --quiet \
  "$VERIFICATION_MAIN_SHA^" "$VERIFICATION_MAIN_SHA" -- \
  docs/evidence/aquamobil-v4-feeding
verification_evidence_diff_status=$?
set -e
test "$verification_evidence_diff_status" -eq 1
VERIFICATION_NAME=feeding-foundation
cd "$COORDINATOR_WORKTREE"
VERIFICATION_BRANCH="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-branch --verification "$VERIFICATION_NAME")"
VERIFICATION_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --verification "$VERIFICATION_NAME")"
test "$VERIFICATION_BRANCH" = chore/aquamobil-v4-feeding-foundation-verification
test "$VERIFICATION_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-feeding-foundation-verification
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --verification "$VERIFICATION_NAME" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$VERIFICATION_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create-finding-closure \
  --closure feeding-foundation-high-findings \
  --main-ref origin/main
CLOSURE_BRANCH="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-branch \
  --closure feeding-foundation-high-findings)"
CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-path \
  --closure feeding-foundation-high-findings)"
test "$CLOSURE_BRANCH" = chore/aquamobil-v4-feeding-findings-close
test "$CLOSURE_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-feeding-findings-close
cd "$CLOSURE_WORKTREE"
test "$(git branch --show-current)" = "$CLOSURE_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$ROOT_LOCK_SHA256" = "$(sha256sum package-lock.json | cut -d' ' -f1)"
test "$AQUAMOBIL_LOCK_SHA256" = \
  "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
(cd docs/evidence/aquamobil-v4-feeding && sha256sum -c dependency-audit/SHA256SUMS)
git diff --exit-code \
  "$VERIFICATION_MAIN_SHA" HEAD -- \
  docs/evidence/aquamobil-v4-feeding \
  docs/superpowers/evidence/aquamobil-v4
test -z "$(git status --porcelain)"
```

Before editing, rerun Step 9's complete closure-attestation verifier against the committed files. It
must still prove all fifteen rows are open HIGH findings and every protected boundary, commit body,
review section, immutable boundary evidence, and evidence digest agrees. Then use the committed
parser output, not another first-match log search, to close every finding. Do not invoke the
reconciler and do not edit any file under `docs/superpowers/evidence/aquamobil-v4/` or
`docs/evidence/aquamobil-v4-feeding/`.

Run:

```bash
jq -r 'to_entries[] | [.key, .value] | @tsv' \
  docs/evidence/aquamobil-v4-feeding/finding-closure-map.json |
  while IFS=$'\t' read -r finding_id closing_sha; do
    printf '%s\n' "$closing_sha" | rg -q '^[0-9a-f]{40}$'
    git merge-base --is-ancestor "$closing_sha" origin/main
    npm run findings:close -- "$finding_id" "$closing_sha"
  done
npm run findings:verify
jq -s -e --slurpfile closers \
  docs/evidence/aquamobil-v4-feeding/finding-closure-map.json \
  '[.[] | select(.raised_in_cycle == "2026-08-26-aquamobil-v4-feeding-foundation")] as $rows | ($rows | length) == 15 and all($rows[]; .severity == "HIGH" and .state == "RESOLVED" and (.id as $id | .closing_commits == [$closers[0][$id]]))' \
  docs/reviews/_registry/findings.jsonl
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
git diff --exit-code -- \
  docs/evidence/aquamobil-v4-feeding \
  docs/superpowers/evidence/aquamobil-v4
git add docs/reviews/_registry/findings.jsonl
test "$(git diff --cached --name-only)" = docs/reviews/_registry/findings.jsonl
test -z "$(git diff --name-only | rg '^docs/(evidence/aquamobil-v4-feeding|superpowers/evidence/aquamobil-v4)/')"
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(review): close feeding foundation findings"
git push --set-upstream origin "$CLOSURE_BRANCH"
```

Expected: exactly fifteen HIGH registry rows transition to `RESOLVED`, every row has exactly one
attested full-SHA closer, only `docs/reviews/_registry/findings.jsonl` is staged, all generated and
immutable evidence remains byte-identical to the branch base, and the closure branch is pushed
immediately. Open a protected PR from `$CLOSURE_BRANCH` to `main`, require review and all checks,
then run the bootstrap-owned prospective closure verifier before merging without bypassing
protection:

```bash
CLOSURE_PR_NUMBER="$(gh pr view --json number --jq '.number')"
gh pr checks "$CLOSURE_PR_NUMBER" --watch --fail-fast
gh pr view "$CLOSURE_PR_NUMBER" --json state,reviewDecision,baseRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main")'
ACTIVE_CLOSURE_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
cd "$ACTIVE_CLOSURE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-closure-pr "$CLOSURE_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --verify-base-advance \
  --require-latest-merge-queue-candidate \
  --forbid-duplicate-closing-trailers
```

- [ ] **Step 12: Verify the merged closure from `origin/main`**

Run only after the closure PR is merged:

```bash
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
git show origin/main:docs/reviews/_registry/findings.jsonl | jq -r 'select(.raised_in_cycle == "2026-08-26-aquamobil-v4-feeding-foundation") | [.id, .state, (.closing_commits | join(","))] | @tsv'
git show origin/main:docs/reviews/_registry/findings.jsonl |
  jq -s -e --slurpfile closers \
    docs/evidence/aquamobil-v4-feeding/finding-closure-map.json \
    '[.[] | select(.raised_in_cycle == "2026-08-26-aquamobil-v4-feeding-foundation")] as $rows | ($rows | length) == 15 and all($rows[]; .severity == "HIGH" and .state == "RESOLVED" and (.id as $id | .closing_commits == [$closers[0][$id]]) and (.closing_commits[0] | test("^[0-9a-f]{40}$")))'
git diff --exit-code \
  "$VERIFICATION_MAIN_SHA" origin/main -- \
  docs/evidence/aquamobil-v4-feeding \
  docs/superpowers/evidence/aquamobil-v4
(cd docs/evidence/aquamobil-v4-feeding && sha256sum -c dependency-audit/SHA256SUMS)
jq -e 'length == 15 and all(.[]; .severity == "HIGH" and (.closingCommit | test("^[0-9a-f]{40}$")) and (.boundaryMainCommit | test("^[0-9a-f]{40}$")) and (.closingCommitBodySha256 | test("^[0-9a-f]{64}$")) and (.reviewSectionSha256 | test("^[0-9a-f]{64}$")) and (.verificationEvidenceSha256 | test("^[0-9a-f]{64}$")))' \
  docs/evidence/aquamobil-v4-feeding/finding-closure-attestations.json
npm run findings:verify
MERGED_CLOSURE_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
cd "$MERGED_CLOSURE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
cd "$COORDINATOR_WORKTREE"
CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-path \
  --closure feeding-foundation-high-findings)"
test "$CLOSURE_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-feeding-findings-close
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --closure feeding-foundation-high-findings \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$CLOSURE_WORKTREE"
```

Expected: exactly fifteen HIGH rows are visible from `origin/main`, every row is `RESOLVED` with
exactly its attested full closing SHA, the evidence tree is byte-identical to the reviewed
verification PR, its hash manifest verifies, and the four immutable merge records plus generated
ledger are unchanged by closure. This does not run the ledger's program-wide terminal check because
F3–F5, V6, and other AquaMobil V4 slices remain owned by their respective plans.

Only after this unchanged-authority check passes, the coordinator runs the program plan's separate
serialized reconciliation for closure `feeding-foundation-high-findings`. That reconciliation PR
alone writes immutable
`docs/superpowers/evidence/aquamobil-v4/closures/feeding-foundation-high-findings.json` and
regenerates `execution-ledger.json` with
`reconcile-ledger.mjs --closure feeding-foundation-high-findings --write`. F3 cannot begin until
that protected reconciliation is merged and provenance verification passes.

## Completion Criteria

- F0 uses one branded band-weight boundary and one active unit-protocol resolver across plan,
  forecast, cron, DataLoader, feed selection, and daily execution.
- Measured and FCR-projected growth update every biomass aggregate through
  `BiomassGrowthApplierService`; storage deduction remains owned by the current-main ledger.
- `GrowthSampleRecorded.tankId` is optional v1-compatible and has contract, validator, producer, and
  stock-listener parity.
- `Batch.protocolId` survives expansion, leaves application readers in a separately deployed
  contraction, and is physically dropped only after fleet proof in a third protected F0 release.
- Hardware compatibility reaches native `text[]` through additive dual-write/backfill, deployed
  array readers, fleet/parity proof, and a distinct scalar-drop release; no in-place type rewrite
  occurs.
- PostgreSQL enforces active feeder totals of exactly zero or 100 under raw, concurrent, and
  cross-tenant writes with canonical forced RLS while allowing one feeder to serve multiple units
  through unit-scoped uniqueness.
- All three feeder/VFD events begin at audited version 1, reject every other version and invalid
  trust-boundary payload, have no fabricated upcaster, and gain generated cert-CN publish
  permissions before production.
- F1b uses CQRS, tenant read/transaction helpers, a locked totals anchor, preserved assignment
  generations, deterministic gram allocation, and same-manager outbox production.
- Explicit GraphQL decorators/mappers, SDL nullability tests, authorization, schema composition,
  generated clients, subject-derived gateway routing, gateway compile/build, static/live NATS ACLs,
  migration fan-out, and affected test/lint/build gates are green.
- All eight protected boundaries have immutable merge evidence and generated per-owner ledger
  projections; the post-merge audit commits and hashes four raw audits and statuses, canonical
  audit/explain sets, exact path arrays, the production Vite/Rollup module manifest, and mapper
  output while classifying every high/critical production path; and all fifteen HIGH findings close
  through exact full-SHA trailers and machine-checked closure attestations on `origin/main`.
