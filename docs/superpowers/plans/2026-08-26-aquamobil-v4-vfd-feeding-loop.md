# AquaMobil V4 VFD and Feeding Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reimplement F3 VFD binding and attestation, F4 feeder calibration and mass evidence, F5
feeding-loop completion, and V6 direct AquaMobil VFD operations on current `main`, with every
actuation path fail-closed and every tenant write transactionally durable.

**Architecture:** Farm service remains the authority for equipment, feeder assignments, calibration,
stock, and ration state. Sensor service remains the authority for VFD devices, binding attestations,
telemetry ingestion, and command execution. Versioned NATS events cross the service boundary through
tenant-scoped outboxes and validated consumers. AquaMobil consumes only the composed GraphQL
contract and sends VFD commands directly while offline replay remains limited to its positive
non-actuation registry.

**Tech Stack:** Node.js 22, npm 10, Nx, TypeScript, NestJS, TypeORM, PostgreSQL with tenant RLS,
NATS JetStream with mTLS certificate identity, GraphQL Federation, React 19, Vite, Vitest, Jest,
Docker

**Spec:** `docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md`

---

## Non-Negotiable Execution Contract

- Use `origin/feature/aquamobil-v4-redesign` only as read-only provenance. `git show` is permitted;
  merging, rebasing, cherry-picking, source-file transplanting, or creating ancestry markers is not.
- F3 starts only after the feeding-foundation finding-close PR and its separate closure
  reconciliation are protected-main-reachable. F4 starts only after F3 implementation and slice
  reconciliation are protected-main-reachable. F5 starts only after F4 implementation and slice
  reconciliation are protected-main-reachable. V6 starts only after both the UI finding-close
  reconciliation and F5 slice reconciliation are protected-main-reachable. The coordinator proves
  each exact predecessor reconciliation commit before it creates the dependent worktree.
- The program pins exactly one implementation boundary, branch, and fresh worktree for each slice:
  F3 `vfd-attestation` on `feat/feeding-f3-vfd-attestation` in
  `/var/aqua-saas/.worktrees/aquamobil-v4-f3`; F4 `calibration-physics` on
  `feat/feeding-f4-calibration-physics` in `/var/aqua-saas/.worktrees/aquamobil-v4-f4`; F5
  `loop-completion` on `feat/feeding-f5-loop-completion` in
  `/var/aqua-saas/.worktrees/aquamobil-v4-f5`; and V6 `vfd-operations` on
  `feat/aquamobil-v6-vfd-operations` in `/var/aqua-saas/.worktrees/aquamobil-v4-v6`. Tasks within a
  slice are ordered commits on that one branch. Delayed contract/enforcement tasks pause that same
  branch at an exact pushed commit until the named deployment evidence is green; they never create
  another implementation branch or worktree.
- Each implementation branch creates only its own append-only
  `docs/superpowers/evidence/aquamobil-v4/slices/<SliceId>/preflight.json`, staged in that slice's
  first commit and never rewritten. Implementation branches never write a slice `merge.json`, a
  closure record, `execution-ledger.json`, `merge-resolutions.json`, or another slice's evidence.
  After protected merge, only the program's fresh serialized reconciliation branch captures the
  slice merge and regenerates the central ledger.
- Order 0's clean detached coordinator persists at
  `/var/aqua-saas/.worktrees/aquamobil-v4-coordinator`. Refresh it to the exact forced `origin/main`
  ref before every lifecycle, capture, audit, reconcile, or ledger-verification action. Those local
  actions always invoke the coordinator-absolute executable. Committed checkout-local CI and runtime
  scripts remain portable; in particular the I1-owned `scripts/ci/resolve-ci-image.mjs` and the VFD
  NATS harness invoke their repository-local copies.
- Every fresh implementation or finding-closure worktree hashes both lockfiles, runs root and
  standalone AquaMobil `npm ci --ignore-scripts --no-audit`, proves both hashes and their Git diff
  unchanged, and never links either dependency tree from another checkout. Any normal-script
  compatibility matrix runs later as a separate verification phase; it is not the fresh-worktree
  bootstrap.
- Read root `CLAUDE.md` before every task and read the nested `CLAUDE.md` for every edited subtree.
  Re-read both after review changes.
- Existing migrations are immutable. Generate every new migration on its delivery branch. Do not
  reserve or guess a timestamp or class identifier in advance.
- Tenant entities omit `schema:`. All tenant reads and writes use `runInTenantTransaction` or
  `runInTenantRead` and repositories obtained from the supplied manager. New tables receive the
  canonical tenant RLS policy. An outbox message is inserted with its state change in the same
  database transaction.
- NATS authorization remains certificate-CN-only. Do not add token, username, header, or payload
  identity as an authorization source.
- All VFD commands, including emergency stop, require authentication, tenant isolation, current
  authoritative binding attestation, and an actuable resolution before an edge write. An attested
  feeder with zero unit assignments is not actuable. Unknown, inactive, pending, expired, and
  unbound equipment fail closed.
- F4 never recreates or reads the retired `sensor_readings` store. Mass evidence is derived from the
  current `sensor_metrics` ingestion path and uses its own event vocabulary and farm projection.
  Water-quality parameter vocabulary is not extended with mass.
- Event versions describe real wire shapes. Old messages remain accepted through tested upcasters;
  new producers emit the current version. Consumers upcast before current-schema validation.
- GraphQL documents are generated from the composed schema. Do not keep handwritten frontend mirrors
  for input, response, or actuation-root inventories.
- V6 contains display queries and direct nonqueue command calls only. It does not add a VFD command
  to the offline operation registry, queue, replay worker, or persistence schema.
- Every implementation task begins with a test observed failing for the intended missing behavior,
  then the smallest production change that makes it pass. Setup, import, fixture, and unrelated
  baseline failures do not count as red evidence.
- Run every non-RED fenced Bash block from the repository root with `set -euo pipefail` in effect
  and stop at its first nonzero command. Run commands in deliberate RED blocks separately so every
  named test records its own intended product-behavior failure.
- Each commit is reviewed, committed through normal hooks, and pushed immediately. Do not force
  push, disable hooks, bypass signatures, or run an audit auto-fix. Every Task 0 through Task 22
  commit and the Task 24 finding-close commit follows the canonical staged-union protocol below;
  `tools/quality/format-scope.json` is generated task output in each of those 24 commits.
- The 22 exact allocation titles below each have one and only one final uppercase `Closes:`
  candidate: the corresponding Task 1 through Task 22 commit. No earlier/later task, squash body,
  finding-close commit, or duplicate commit may claim the same title or ID.

### Read-only provenance map

| Concern                         | Behavior reference       | Use in this plan                                                                     |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| F3 binding and attestation      | `1401860c7`              | Review intent, then reimplement against current F2 contracts                         |
| F4 calibration and physics      | `05479fd83`              | Review physical rules while replacing its retired mass-storage assumption            |
| F5 loop and V6 surface          | `66fd87865`              | Review behavior while rebuilding on current stock, schema, PWA, and auth authorities |
| F5 architecture narrative       | `b4b2f653c`              | Treat as a question list only; write docs from passing current behavior              |
| F2 generated NATS authority     | `8fad0357a`              | Confirm the prerequisite generator and certificate-only identity pattern             |
| F0 and F1 prerequisite behavior | `826690623`, `0aabe5a5e` | Confirm weighing, equipment, and assignment contracts already merged                 |
| Storage-ledger authority        | `550a72311`              | Preserve `StockMovementService.recordMovement` as the fail-closed feed-stock writer  |

The archaeology anchors remain `origin/main@4002868c535a2d8676aad6eadd5f4bbd57d4625b`,
`origin/feature/aquamobil-v4-redesign@542c8e0bb7ff3afbeee0496f277f8926526cc41a`, and merge base
`8d8d54365ada11d45b43374af76e9814c5958ff0`; at planning refresh the source is 219 commits behind and
35 commits ahead. Before each slice, record current `origin/main` separately; the anchors do not
authorize stale code or migrations.

## Exact Executor Allocation Process

For every task below, use this sequence exactly. F3, F4, F5, and V6 are sequential because they
overlap schemas, generated contracts, and shared state.

1. The coordinator verifies the task gate, current `origin/main`, merged predecessor SHA, clean
   isolated worktree, active expected branch, root instructions, nested instructions, and absence of
   unrelated staged changes.
2. The coordinator assigns exactly one fresh implementation executor to the task. The executor reads
   this plan and the approved spec, uses source commits only through read-only `git show`, writes
   the named red test first, and returns the red command/output plus green command/output.
3. After implementation stops, the coordinator assigns one fresh specification reviewer. That
   reviewer checks only conformance, fail-closed behavior, tenant safety, generated authorities, and
   the named task scope. The implementation executor addresses every accepted finding.
4. The coordinator then assigns a different fresh code-quality reviewer. That reviewer checks
   transaction boundaries, error handling, migration reversibility, event compatibility, test
   strength, and maintainability. The implementation executor addresses every accepted finding.
5. The coordinator runs the task verification commands, inspects the scoped diff and staged file
   list, commits only the task paths, and pushes the commit immediately to the slice's one branch.
6. The implementation workflow retains commit, push, test, reviewer, and explicit-deferral evidence
   in its repository-owned PR artifact. It does not write central evidence. A delayed contract task
   pauses in the same canonical worktree until deployment, remediation, reader, and generated-client
   evidence for the exact pushed predecessor commit exists.

The coordinator never allocates two tasks from this plan concurrently. A reviewer never doubles as
the implementation executor for the task being reviewed.

Immediately before every implementation commit, the coordinator also runs the repository-wide
affected gates required by the root instructions, in addition to that task's focused green block:

```bash
npx nx affected --target=test
npx nx affected --target=lint
npx nx affected --target=build
npm run type-check
```

A failure returns to the same task's red/green and review cycle; it is not waived as unrelated
without a separately proven baseline comparison and coordinator approval.

## Canonical Per-Commit Staged-Union Protocol

Every commit-owning task below instantiates this protocol in its commit block. The index must be
empty first. The task's literal scoped `git add -- ...` stages all and only its mapped create,
modify, delete, and regenerate paths; a named deletion is staged by that same scoped command. The
block snapshots that task-owned staged set, then runs `npm run quality:format-scope:generate` only
after the new and deleted paths are present in the index. It stages
`tools/quality/format-scope.json`, runs `npm run quality:format-scope:check`, and compares the final
staged set byte-for-byte with the sorted union of the captured task-owned set and that one generated
manifest. Only after the union comparison and `git diff --cached --check` pass may the block resolve
its finding, commit through normal hooks, and push.

The task file map and its literal first `git add` remain the task-owned source of truth. The only
path added after that snapshot is `tools/quality/format-scope.json`; an unrelated pre-staged path,
an unstaged mapped path, an extra generator output, or a no-op/stale manifest blocks the commit.

## Canonical Coordinator and Slice Preflight

Run the following checkpoint exactly once before the first task in each slice. Set `VFD_SLICE` to
one row's literal and do not change the values derived by the `case`. The program tool rejects a
stale base, reused branch/path, dirty tree, or missing predecessor reconciliation.

| `VFD_SLICE` | Boundary ID           | Branch                                | Worktree                                    | Exact predecessor reconciliation artifacts                           |
| ----------- | --------------------- | ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `F3`        | `vfd-attestation`     | `feat/feeding-f3-vfd-attestation`     | `/var/aqua-saas/.worktrees/aquamobil-v4-f3` | `closures/feeding-foundation-high-findings.json`                     |
| `F4`        | `calibration-physics` | `feat/feeding-f4-calibration-physics` | `/var/aqua-saas/.worktrees/aquamobil-v4-f4` | `slices/F3/merge.json`                                               |
| `F5`        | `loop-completion`     | `feat/feeding-f5-loop-completion`     | `/var/aqua-saas/.worktrees/aquamobil-v4-f5` | `slices/F4/merge.json`                                               |
| `V6`        | `vfd-operations`      | `feat/aquamobil-v6-vfd-operations`    | `/var/aqua-saas/.worktrees/aquamobil-v4-v6` | `slices/F5/merge.json`, `closures/ui-convergence-high-findings.json` |

```bash
set -euo pipefail
: "${VFD_SLICE:?set VFD_SLICE to F3, F4, F5, or V6 from the table above}"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
case "$VFD_SLICE" in
  F3)
    VFD_BOUNDARY_ID=vfd-attestation
    VFD_EXPECTED_BRANCH=feat/feeding-f3-vfd-attestation
    VFD_EXPECTED_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-f3
    VFD_PREDECESSOR_ARTIFACTS=(
      docs/superpowers/evidence/aquamobil-v4/closures/feeding-foundation-high-findings.json
    )
    ;;
  F4)
    VFD_BOUNDARY_ID=calibration-physics
    VFD_EXPECTED_BRANCH=feat/feeding-f4-calibration-physics
    VFD_EXPECTED_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-f4
    VFD_PREDECESSOR_ARTIFACTS=(
      docs/superpowers/evidence/aquamobil-v4/slices/F3/merge.json
    )
    ;;
  F5)
    VFD_BOUNDARY_ID=loop-completion
    VFD_EXPECTED_BRANCH=feat/feeding-f5-loop-completion
    VFD_EXPECTED_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-f5
    VFD_PREDECESSOR_ARTIFACTS=(
      docs/superpowers/evidence/aquamobil-v4/slices/F4/merge.json
    )
    ;;
  V6)
    VFD_BOUNDARY_ID=vfd-operations
    VFD_EXPECTED_BRANCH=feat/aquamobil-v6-vfd-operations
    VFD_EXPECTED_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-v6
    VFD_PREDECESSOR_ARTIFACTS=(
      docs/superpowers/evidence/aquamobil-v4/slices/F5/merge.json
      docs/superpowers/evidence/aquamobil-v4/closures/ui-convergence-high-findings.json
    )
    ;;
  *) exit 2 ;;
esac

refresh_vfd_coordinator() {
  test -d "$COORDINATOR_WORKTREE"
  git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
  test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
  git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
  test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
  test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
    "$(git -C /var/aqua-saas rev-parse origin/main)"
}

refresh_vfd_coordinator
VFD_PREDECESSOR_RECONCILIATION_SHAS=()
for predecessor_artifact in "${VFD_PREDECESSOR_ARTIFACTS[@]}"; do
  mapfile -t predecessor_reconciliation_candidates < <(
    git -C /var/aqua-saas log --diff-filter=A --format='%H' origin/main -- \
      "$predecessor_artifact"
  )
  test "${#predecessor_reconciliation_candidates[@]}" -eq 1
  predecessor_reconciliation_sha="${predecessor_reconciliation_candidates[0]}"
  [[ "$predecessor_reconciliation_sha" =~ ^[0-9a-f]{40}$ ]]
  git -C /var/aqua-saas merge-base --is-ancestor \
    "$predecessor_reconciliation_sha" origin/main
  git -C /var/aqua-saas cat-file -e \
    "$predecessor_reconciliation_sha:$predecessor_artifact"
  VFD_PREDECESSOR_RECONCILIATION_SHAS+=("$predecessor_reconciliation_sha")
  printf 'predecessor-reconciliation=%s artifact=%s\n' \
    "$predecessor_reconciliation_sha" "$predecessor_artifact"
done

cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
  --slice "$VFD_SLICE" \
  --boundary "$VFD_BOUNDARY_ID" \
  --main-ref origin/main
refresh_vfd_coordinator
cd "$COORDINATOR_WORKTREE"
VFD_ACTIVE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$VFD_SLICE" --boundary "$VFD_BOUNDARY_ID")"
VFD_ACTIVE_BRANCH="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-branch --slice "$VFD_SLICE" --boundary "$VFD_BOUNDARY_ID")"
test "$VFD_ACTIVE_WORKTREE" = "$VFD_EXPECTED_WORKTREE"
test "$VFD_ACTIVE_BRANCH" = "$VFD_EXPECTED_BRANCH"
cd "$VFD_ACTIVE_WORKTREE"
test "$(git branch --show-current)" = "$VFD_EXPECTED_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
for predecessor_reconciliation_sha in "${VFD_PREDECESSOR_RECONCILIATION_SHAS[@]}"; do
  git merge-base --is-ancestor "$predecessor_reconciliation_sha" HEAD
done

ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json

npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/ci-image-digests.spec.ts
NATS_IMAGE="$(node scripts/ci/resolve-ci-image.mjs \
  --manifest infrastructure/ci/image-digests.json \
  --image nats)"
[[ "$NATS_IMAGE" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]]

VFD_PREFLIGHT_DIR="artifacts/aquamobil-v4/$VFD_SLICE"
mkdir -p "$VFD_PREFLIGHT_DIR"
vfd_preflight_build_id="$(git rev-parse HEAD)"
[[ "$vfd_preflight_build_id" =~ ^[0-9a-f]{40}$ ]]
export AQUAMOBIL_BUILD_ID="$vfd_preflight_build_id"
export AQUAMOBIL_AUDIT_MODULE_MANIFEST="$VFD_PREFLIGHT_DIR/aquamobil-vite-rollup-modules.json"
npm --prefix web/apps/aquamobil run build
test -s "$VFD_PREFLIGHT_DIR/aquamobil-vite-rollup-modules.json"
set +e
npm audit --json > "$VFD_PREFLIGHT_DIR/audit-root-full.json"
vfd_root_full_status=$?
npm audit --omit=dev --json > "$VFD_PREFLIGHT_DIR/audit-root-runtime.json"
vfd_root_runtime_status=$?
npm --prefix web/apps/aquamobil audit --json > "$VFD_PREFLIGHT_DIR/audit-mobile-full.json"
vfd_mobile_full_status=$?
npm --prefix web/apps/aquamobil audit --omit=dev --json \
  > "$VFD_PREFLIGHT_DIR/audit-mobile-runtime.json"
vfd_mobile_runtime_status=$?
set -e
printf '%s\n' \
  "$vfd_root_full_status" \
  "$vfd_root_runtime_status" \
  "$vfd_mobile_full_status" \
  "$vfd_mobile_runtime_status" \
  > "$VFD_PREFLIGHT_DIR/audit-exit-statuses.txt"

refresh_vfd_coordinator
cd "$VFD_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --capture-explain-set \
  --root-audit-full "$VFD_PREFLIGHT_DIR/audit-root-full.json" \
  --root-audit-runtime "$VFD_PREFLIGHT_DIR/audit-root-runtime.json" \
  --aquamobil-audit-full "$VFD_PREFLIGHT_DIR/audit-mobile-full.json" \
  --aquamobil-audit-runtime "$VFD_PREFLIGHT_DIR/audit-mobile-runtime.json" \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json "$VFD_PREFLIGHT_DIR/audit-set.json" \
  --write-explain-set-json "$VFD_PREFLIGHT_DIR/npm-explain-set.json"
refresh_vfd_coordinator
cd "$VFD_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --audit-set-json "$VFD_PREFLIGHT_DIR/audit-set.json" \
  --explain-set-json "$VFD_PREFLIGHT_DIR/npm-explain-set.json" \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest "$VFD_PREFLIGHT_DIR/aquamobil-vite-rollup-modules.json" \
  --output-json "$VFD_PREFLIGHT_DIR/dependency-reachability.json" \
  --output-markdown "$VFD_PREFLIGHT_DIR/dependency-reachability.md"
refresh_vfd_coordinator
cd "$VFD_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice "$VFD_SLICE" \
  --main-ref origin/main \
  --source-ref origin/feature/aquamobil-v4-redesign \
  --artifact-root "$VFD_PREFLIGHT_DIR" \
  --write "docs/superpowers/evidence/aquamobil-v4/slices/$VFD_SLICE/preflight.json"
refresh_vfd_coordinator
cd "$VFD_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice "$VFD_SLICE" \
  --check "docs/superpowers/evidence/aquamobil-v4/slices/$VFD_SLICE/preflight.json" \
  --main-ref origin/main
refresh_vfd_coordinator
cd "$VFD_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
test -z "$(git diff --name-only | rg '^docs/superpowers/evidence/aquamobil-v4/' | \
  rg -v "^docs/superpowers/evidence/aquamobil-v4/slices/$VFD_SLICE/preflight\\.json$")"
```

The first commit of F3, F4, F5, or V6 stages its own captured preflight. Every later task checks
that file byte-for-byte with the coordinator capture tool and leaves it unchanged. The audit mapper
accepts only the canonical four-audit set and package-keyed explain set from both lock authorities.
Browser reachability comes only from the real production Vite/Rollup module manifest emitted by the
AquaMobil build; no standalone executable-tool graph is whole-application bundle evidence.

### Task 0: Allocate registry-backed implementation findings

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Create: `docs/superpowers/evidence/aquamobil-v4/slices/F3/preflight.json` through the program
  capture tool

**Interfaces:**

This one-time F3 bootstrap consumes the coordinator-created canonical worktree and allocates exactly
one registry-backed finding per implementation commit. Exact titles are the lookup authority used in
every commit block below; numeric IDs come only from the locked allocator. Re-running the allocation
reuses an exact title only when its domain-prefixed HIGH ID and complete OPEN allocation contract
match this section's inventory. It never predicts a sequence. Its commit is F3's first commit and
therefore stages the append-only F3 preflight with the registry surface.

- [ ] Verify the coordinator-created F3 branch and allocate missing titles atomically:

<!-- markdownlint-disable MD010 -->

```bash
set -euo pipefail
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
test "$(git branch --show-current)" = feat/feeding-f3-vfd-attestation
test "$(git rev-parse --show-toplevel)" = /var/aqua-saas/.worktrees/aquamobil-v4-f3
test "$(git rev-parse HEAD)" = \
  "$(jq -r '.baseMainCommit' docs/superpowers/evidence/aquamobil-v4/slices/F3/preflight.json)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice F3 \
  --check docs/superpowers/evidence/aquamobil-v4/slices/F3/preflight.json \
  --main-ref origin/main
npm run findings:verify

allocate_vfd_feeding_finding() {
  local finding_domain="$1"
  local finding_title="$2"
  local evidence_path="$3"
  local review_file='docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md'
  local finding_owner
  local existing_count
  case "$finding_domain" in
    SENSOR) finding_owner='sensor-expert' ;;
    FARM) finding_owner='farm-expert' ;;
    MOB) finding_owner='frontend-expert' ;;
    *) return 1 ;;
  esac
  existing_count="$(jq -r --arg title "$finding_title" 'select(.title == $title) | .id' docs/reviews/_registry/findings.jsonl | wc -l)"
  if test "$existing_count" -eq 1; then
    jq -e \
      --arg domain "$finding_domain" \
      --arg title "$finding_title" \
      --arg evidence "$evidence_path" \
      --arg review "$review_file" \
      --arg owner "$finding_owner" \
      'select(
        (.id | test("^" + $domain + "-HIGH-[0-9]{3}$")) and
        .severity == "HIGH" and
        .state == "OPEN" and
        .title == $title and
        .layer == 1 and
        .evidence == [$evidence] and
        .rule_violated == "AquaMobil V4 VFD and feeding-loop release contract" and
        .owner_agent == $owner and
        .raised_in_cycle == "2026-08-26-aquamobil-v4-vfd-feeding-loop" and
        .review_file == $review and
        (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")) and
        .closed_at == null and
        .closing_commits == [] and
        .deadline == null and
        .owner_user == null and
        .override_of == null and
        .notes == "Allocated by the approved F3-F4-F5-V6 implementation plan."
      )' docs/reviews/_registry/findings.jsonl >/dev/null
    return 0
  fi
  test "$existing_count" -eq 0
  npm run findings:add -- "$finding_domain" <(
    node - "$finding_title" "$evidence_path" "$review_file" "$finding_owner" <<'NODE'
const [title, evidence, reviewFile, ownerAgent] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify({
    severity: 'HIGH',
    state: 'OPEN',
    title,
    layer: 1,
    evidence: [evidence],
    rule_violated: 'AquaMobil V4 VFD and feeding-loop release contract',
    owner_agent: ownerAgent,
    raised_in_cycle: '2026-08-26-aquamobil-v4-vfd-feeding-loop',
    review_file: reviewFile,
    created_at: new Date().toISOString(),
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes: 'Allocated by the approved F3-F4-F5-V6 implementation plan.',
  })}\n`,
);
NODE
  )
}

VFD_FINDING_INVENTORY="$(cat <<'FINDINGS'
SENSOR	AquaMobil V4 VFD loop: expand tenant-owned drive bindings	apps/sensor-service/src/vfd/entities/vfd-drive-binding.entity.ts
SENSOR	AquaMobil V4 VFD loop: make drive attestation tenant durable	apps/sensor-service/src/vfd/services/vfd-drive-binding.service.ts
SENSOR	AquaMobil V4 VFD loop: close the farm-to-sensor attestation circuit	apps/farm-service/src/events/listeners/vfd-drive-binding-attestation.listener.ts
SENSOR	AquaMobil V4 VFD loop: gate every command on authoritative attestation	apps/sensor-service/src/vfd/services/vfd-command.service.ts
SENSOR	AquaMobil V4 VFD loop: contract retired drive-binding columns	apps/sensor-service/src/database/migrations
FARM	AquaMobil V4 feeding physics: version feeder calibration events	libs/event-contracts/src/farm-events.ts
SENSOR	AquaMobil V4 feeding physics: define durable mass observations	libs/event-contracts/src/sensor-events.ts
FARM	AquaMobil V4 feeding physics: expand canonical feeder calibration	apps/farm-service/src/equipment/entities/feeder-capability.entity.ts
FARM	AquaMobil V4 feeding physics: remediate legacy calibration identity	apps/farm-service/src/equipment/handlers/resolve-legacy-feeder-calibration.handler.ts
FARM	AquaMobil V4 feeding physics: publish and project silo mass evidence	apps/sensor-service/src/ingestion/sensor-metric-writer.service.ts
FARM	AquaMobil V4 feeding physics: derive commissioned feeder directives	apps/farm-service/src/feeding-protocol/services/feeder-dose-directive.service.ts
FARM	AquaMobil V4 feeding physics: migrate the generated setup client	web/modules/farm-module/src/hooks/useFeederCalibration.ts
FARM	AquaMobil V4 feeding physics: enforce canonical calibration identity	apps/farm-service/src/database/migrations
FARM	AquaMobil V4 feeding physics: contract retired calibration surfaces	apps/farm-service/src/equipment/equipment.resolver.ts
FARM	AquaMobil V4 feeding loop: persist day-plan ration basis	apps/farm-service/src/feeding-protocol/services/ration-basis.ts
FARM	AquaMobil V4 feeding loop: unify transition and recalculation authority	apps/farm-service/src/feeding-protocol/services/feed-transition.service.ts
FARM	AquaMobil V4 feeding loop: make stock mutation inseparable from repricing	apps/farm-service/src/batch/services/tank-batch.service.ts
FARM	AquaMobil V4 feeding loop: couple measurements rates and feed use	apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts
FARM	AquaMobil V4 feeding loop: enforce durable ration-basis authority	apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts
SENSOR	AquaMobil V4 mobile VFD: prove actuation cannot enter offline replay	tests/invariants/aquamobil-vfd-actuation-offline-boundary.spec.ts
MOB	AquaMobil V4 mobile VFD: add generated direct drive operations	web/apps/aquamobil/src/hooks/useVfdCommand.ts
MOB	AquaMobil V4 mobile VFD: add safe drive control surfaces	web/apps/aquamobil/src/pages/drives/DriveDetailPage.tsx
FINDINGS
)"
while IFS=$'\t' read -r finding_domain finding_title evidence_path; do
  allocate_vfd_feeding_finding "$finding_domain" "$finding_title" "$evidence_path"
done <<<"$VFD_FINDING_INVENTORY"
mapfile -t expected_vfd_feeding_titles < <(
  printf '%s\n' "$VFD_FINDING_INVENTORY" | cut -f2 | LC_ALL=C sort
)
mapfile -t allocated_vfd_feeding_titles < <(
  jq -r 'select(.raised_in_cycle == "2026-08-26-aquamobil-v4-vfd-feeding-loop") | .title' \
    docs/reviews/_registry/findings.jsonl | LC_ALL=C sort
)
test "${#expected_vfd_feeding_titles[@]}" -eq 22
test "${#allocated_vfd_feeding_titles[@]}" -eq 22
diff -u \
  <(printf '%s\n' "${expected_vfd_feeding_titles[@]}") \
  <(printf '%s\n' "${allocated_vfd_feeding_titles[@]}")
```

<!-- markdownlint-enable MD010 -->

Expected: the allocator emits or reuses exactly the 22 inventoried titles as unique `SENSOR-HIGH`,
`FARM-HIGH`, or `MOB-HIGH` IDs without predicting a numeric suffix.

- [ ] Create and verify the review document, then commit and push only the allocation:

Use `apply_patch` to create the review file with one `##` heading per emitted ID, the exact matching
title, `OPEN` state, and registry evidence path. Then run:

```bash
mapfile -t allocated_vfd_feeding_ids < <(
  jq -r 'select(.raised_in_cycle == "2026-08-26-aquamobil-v4-vfd-feeding-loop") | .id' \
    docs/reviews/_registry/findings.jsonl
)
test "${#allocated_vfd_feeding_ids[@]}" -eq 22
for finding_id in "${allocated_vfd_feeding_ids[@]}"; do
  test "$(rg -c "^## ${finding_id}$" docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md)" -eq 1
done
npm run findings:verify
npx nx test invariants --runInBand --testPathPatterns='finding-registry-integrity.spec.ts'
git add -- \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md \
  docs/superpowers/evidence/aquamobil-v4/slices/F3/preflight.json
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
git commit -m "$(printf '%s\n\n%s' \
  'chore(review): register VFD feeding-loop findings' \
  'Implementation commits need allocator-backed review findings before the first production change.')"
git push -u origin HEAD
```

This registry-only commit allocates traceability and closes no finding. Every later commit resolves
its ID by exact title, validates one match, includes a WHY body, and emits its review-file trailer.

## Migration Generation Procedure

Each migration-owning task below supplies its exact service-local TypeORM generation command. Run
only the command in that owning task. Immediately afterward, its exact suffix resolver reads
untracked migration output with `git ls-files --others --exclude-standard`, requires exactly one
match, and prints the concrete generated path before the executor edits or stages it. A zero- or
multi-match state stops the task; never choose a file manually or predeclare a timestamp.

Record the actual class identifier from that file in the task evidence. Farm migrations are added to
`apps/farm-service/src/database/migrations/manifest.ts` in dependency order. Sensor migrations are
discovered by the existing data-source glob. Expand migrations carry
`@ExpandContract({ phase: 'expand' })`; each delayed contract or enforce migration imports its
immediate predecessor class and passes that class's `.name` as the decorator's single string
`dependsOn` value. Multi-stage chains are transitive through those immediate predecessors. Migration
tests discover exactly one added file by suffix and fail with an explicit count if the count is not
one.

---

## F3 — VFD Binding and Authoritative Attestation

### Task 1: Expand tenant-owned VFD binding storage

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `apps/sensor-service/src/vfd/entities/vfd-drive-binding.entity.ts`
- Create: `apps/sensor-service/src/vfd/entities/vfd-drive-binding-unit.entity.ts`
- Modify: `apps/sensor-service/src/vfd/entities/index.ts`
- Modify: `apps/sensor-service/src/vfd/vfd.module.ts`
- Modify: `libs/backend-common/src/database/schema-manager.service.ts`
- Generated output contract: exactly one newly added
  `apps/sensor-service/src/database/migrations/[0-9]+-ExpandVfdDriveBindings.ts`, resolved and
  count-checked with its sole exported class by Task 1 Step 3 before editing or staging
- Create:
  `apps/sensor-service/src/database/migrations/__tests__/expand-vfd-drive-bindings.migration.spec.ts`
- Create:
  `apps/sensor-service/src/__tests__/integration/vfd-drive-binding-tenant-isolation.postgres.spec.ts`

**Interfaces:**

```ts
type VfdDriveBindingState = 'pending' | 'attested' | 'unknown_equipment' | 'inactive_equipment';
```

`VfdDriveBinding` uses `vfdDeviceId` as its primary key and stores `tenantId`, `drivenEquipmentId`,
state, optional equipment category/code/name/site, `requestedAt`, `attestedAt`, `createdAt`,
`updatedAt`, and optional `boundBy`. `VfdDriveBindingUnit` uses `vfdDeviceId + unitId` as its
primary key and stores `tenantId`, `unitType`, `unitCode`, and `doseSharePercent` as `numeric(6,3)`
through the existing decimal transformer. Both entities omit `schema:`.

The database enforces the four-state vocabulary, `(state = 'pending') = (attested_at IS NULL)`,
nonpending rows with a non-null `attested_at`, `0 < dose_share_percent <= 100`, the unit-to-binding
foreign key, the binding-to-device foreign key, tenant RLS, and tenant-consistent joins. Backfill
every non-null legacy `vfd_devices.pump_id` as `pending`; never infer a binding from `tank_id`.
Preflight must prove one unambiguous target per legacy device. Postflight must prove per-schema
source/target count parity and zero conflicting bindings. An insert conflict is an error, not a
silently skipped row.

For the rolling expand window, install an `AFTER INSERT OR UPDATE OF pump_id` compatibility trigger
named `trg_vfd_devices_legacy_pump_binding`. A non-null legacy pump ID inserts the same
tenant/device /equipment tuple as `pending` with a refresh-due `requested_at`; an equal existing
binding is idempotent and a different existing binding aborts the legacy write. A null pump ID does
not unbind, and `tank_id` never participates. Task 5 removes the trigger and its function
immediately before dropping the columns.

- [ ] **Step 1: Write and run the red schema tests**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='expand-vfd-drive-bindings|vfd-drive-binding-tenant-isolation'
```

Expected RED: the entity metadata, generated migration, pending-only backfill, check constraints,
rolling legacy-write trigger, RLS policy, and cross-tenant denial do not exist. The failure must
identify those missing invariants.

- [ ] **Step 2: Add the minimal entity metadata and registrations**

Create both entities with the exact keys, numeric transformer, foreign keys, indexes, and
tenant-entity `schema:` omission described above. Register them through the existing entity barrel,
VFD module, and tenant-schema manager. Do not add a second device or assignment store. Run the
focused entity metadata assertion again and confirm it passes while the migration assertions remain
red.

- [ ] **Step 3: Generate and implement the expand migration**

```bash
(cd apps/sensor-service && npx typeorm-ts-node-commonjs migration:generate src/database/migrations/ExpandVfdDriveBindings -d src/database/data-source.ts)
mapfile -t vfd_expand_generated_files < <(git ls-files --others --exclude-standard apps/sensor-service/src/database/migrations | rg '/[0-9]+-ExpandVfdDriveBindings\.ts$')
test "${#vfd_expand_generated_files[@]}" -eq 1
mapfile -t vfd_expand_generated_classes < <(rg -o 'export class [A-Za-z0-9_]+' "${vfd_expand_generated_files[0]}")
test "${#vfd_expand_generated_classes[@]}" -eq 1
vfd_expand_generated_class="${vfd_expand_generated_classes[0]##* }"
printf 'migration=%s class=%s\n' "${vfd_expand_generated_files[0]}" "$vfd_expand_generated_class"
```

Inspect exactly the printed file and replace unsafe guesses with explicit schema-qualified DDL,
preflight queries, deterministic backfill, constraints, indexes, RLS application, postflight counts,
the fail-closed rolling compatibility trigger, and a reversible `down` path. Use
`applyTenantRlsToSchema(queryRunner, { includeTables: [...] })` or prove the canonical schema sync
invokes the same policy for both tables.

- [ ] **Step 4: Run green verification**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='expand-vfd-drive-bindings|vfd-drive-binding-tenant-isolation'
npm run gates:migration-sql
npx prettier --check apps/sensor-service/src/vfd/entities apps/sensor-service/src/vfd/vfd.module.ts libs/backend-common/src/database/schema-manager.service.ts
git diff --check
```

Expected GREEN: migration up/down, parity, conflict rejection, constraints, and two-tenant denial
pass against PostgreSQL. An old-format insert creates exactly one pending binding, an old-format
conflicting update aborts, and a tank-only write creates none.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
mapfile -t vfd_expand_generated_files < <(git ls-files --others --exclude-standard apps/sensor-service/src/database/migrations | rg '/[0-9]+-ExpandVfdDriveBindings\.ts$')
test "${#vfd_expand_generated_files[@]}" -eq 1
git add -- "${vfd_expand_generated_files[0]}" \
  apps/sensor-service/src/vfd/entities/vfd-drive-binding.entity.ts \
  apps/sensor-service/src/vfd/entities/vfd-drive-binding-unit.entity.ts \
  apps/sensor-service/src/vfd/entities/index.ts \
  apps/sensor-service/src/vfd/vfd.module.ts \
  libs/backend-common/src/database/schema-manager.service.ts \
  apps/sensor-service/src/database/migrations/__tests__/expand-vfd-drive-bindings.migration.spec.ts \
  apps/sensor-service/src/__tests__/integration/vfd-drive-binding-tenant-isolation.postgres.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task1_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 VFD loop: expand tenant-owned drive bindings' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task1_finding_ids[@]}" -eq 1
[[ "${task1_finding_ids[0]}" =~ ^SENSOR-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(sensor): expand tenant VFD drive bindings' \
  'Tenant-owned bindings must exist before attestation can become an authoritative command prerequisite.' \
  "${task1_finding_ids[0]}")"
git push origin HEAD
```

### Task 2: Make VFD attestation tenant-durable

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `apps/sensor-service/src/vfd/services/vfd-drive-binding.service.ts`
- Create: `apps/sensor-service/src/vfd/services/__tests__/vfd-drive-binding.service.spec.ts`
- Modify: `apps/sensor-service/src/vfd/vfd.module.ts`

**Interfaces:**

```ts
interface DrivenUnit {
  unitId: string;
  unitType: 'tank' | 'pond' | 'cage';
  unitCode: string;
  doseSharePercent: number;
}

type DrivenUnitResolution =
  | { kind: 'unbound' }
  | {
      kind: 'unattested';
      drivenEquipmentId: string;
      state: 'pending' | 'unknown_equipment' | 'inactive_equipment';
    }
  | { kind: 'expired'; drivenEquipmentId: string; attestedAt: Date }
  | { kind: 'not_a_feeder'; drivenEquipmentId: string; equipmentCategory: string }
  | { kind: 'feeder_without_unit'; drivenEquipmentId: string }
  | { kind: 'feeder_ambiguous'; drivenEquipmentId: string; units: DrivenUnit[] }
  | { kind: 'feeder_unit'; drivenEquipmentId: string; unit: DrivenUnit };

interface VfdDriveBindingService {
  bind(
    vfdDeviceId: string,
    tenantId: string,
    drivenEquipmentId: string,
    boundBy?: string,
  ): Promise<VfdDriveBinding>;
  unbind(vfdDeviceId: string, tenantId: string): Promise<boolean>;
  findBinding(vfdDeviceId: string, tenantId: string): Promise<VfdDriveBinding | null>;
  findUnits(vfdDeviceId: string, tenantId: string): Promise<VfdDriveBindingUnit[]>;
  resolveDrivenUnit(vfdDeviceId: string, tenantId: string): Promise<DrivenUnitResolution>;
  assertActuable(vfdDeviceId: string, tenantId: string): Promise<void>;
  applyAttestation(input: ApplyVfdAttestationInput): Promise<void>;
  revokeForEquipment(tenantId: string, drivenEquipmentId: string): Promise<number>;
  applyUnitFeederSet(input: ApplyUnitFeederSetInput): Promise<void>;
}
```

Equipment category `feeding`, a one-hour refresh interval, a 24-hour maximum attestation age, and a
one-minute request minimum interval are named constants. `bind` inserts or resets a row to `pending`
and enqueues `VfdDriveBindingAttestationRequested` through the outbox in the same tenant
transaction. A due refresh changes `requestedAt` and enqueues one request atomically. Applying an
attestation locks and rechecks the current binding, replaces the served-unit set atomically only
when `drivenEquipmentId` still matches, and leaves the rebound drive unchanged when an older reply
arrives. `assertActuable` rejects unbound, pending, unknown, inactive, expired, and
`feeder_without_unit`; an attested non-feeder, a feeder with one unit, and a feeder with multiple
positive-share units remain actuable.

- [ ] **Step 1: Write and run the red service tests**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='vfd-drive-binding.service.spec.ts'
```

Expected RED: tenant-pinned binding, atomic request outbox, refresh throttling, expiry, stale-reply
rejection, revocation, atomic unit replacement, and the zero-assignment feeder refusal are absent.

- [ ] **Step 2: Implement the minimal service**

Use `runInTenantTransaction` for every mutation, `runInTenantRead` for lookup-only calls, and
`tenantManagerRepo` from the transaction manager. Do not accept a repository tied to the global
manager. `resolveDrivenUnit` is mutation-capable because it may refresh attestation: use one tenant
transaction, lock the binding row before the due/minimum-interval decision, and enqueue the refresh
request on that same manager. Build both request and state writes inside the same callback. Preserve
multiple served units; ambiguity is an honest resolution, not data loss.

- [ ] **Step 3: Run green verification**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='vfd-drive-binding.service.spec.ts'
npx nx test sensor-service --runInBand --testPathPatterns='vfd-drive-binding'
npx prettier --check apps/sensor-service/src/vfd/services/vfd-drive-binding.service.ts apps/sensor-service/src/vfd/services/__tests__/vfd-drive-binding.service.spec.ts apps/sensor-service/src/vfd/vfd.module.ts
git diff --check
```

Expected GREEN: every resolution and timing edge is deterministic, a delayed reply for the prior
equipment cannot overwrite a rebound drive or its units, an outbox failure rolls back the binding
change, and an attested feeder with no assignments cannot pass `assertActuable`.

- [ ] **Step 4: Review, commit, and push this boundary**

```bash
git add -- apps/sensor-service/src/vfd/services/vfd-drive-binding.service.ts apps/sensor-service/src/vfd/services/__tests__/vfd-drive-binding.service.spec.ts apps/sensor-service/src/vfd/vfd.module.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task2_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 VFD loop: make drive attestation tenant durable' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task2_finding_ids[@]}" -eq 1
[[ "${task2_finding_ids[0]}" =~ ^SENSOR-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(sensor): make VFD attestation tenant durable' \
  'Binding mutations and resolution must share the tenant transaction that owns the binding rows.' \
  "${task2_finding_ids[0]}")"
git push origin HEAD
```

### Task 3: Complete the farm-to-sensor attestation loop

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `apps/farm-service/src/events/listeners/vfd-drive-binding-attestation.listener.ts`
- Create:
  `apps/farm-service/src/events/listeners/__tests__/vfd-drive-binding-attestation.listener.spec.ts`
- Modify: `apps/farm-service/src/events/listeners/index.ts`
- Modify: `apps/farm-service/src/events/event-listeners.module.ts`
- Create: `apps/sensor-service/src/vfd/services/vfd-drive-binding.listener.ts`
- Create: `apps/sensor-service/src/vfd/services/__tests__/vfd-drive-binding.listener.spec.ts`
- Modify: `apps/sensor-service/src/vfd/vfd.module.ts`

**Interfaces:**

```ts
export const UNIT_FEEDER_ASSIGNMENTS_CHANGED_CURRENT_VERSION = 1;
export const VFD_DRIVE_BINDING_ATTESTED_CURRENT_VERSION = 1;
export const VFD_DRIVE_BINDING_ATTESTATION_REQUESTED_CURRENT_VERSION = 1;

interface UnitFeederShareEntry {
  readonly assignmentId: string;
  readonly feederEquipmentId: string;
  readonly feederCode: string;
  readonly doseSharePercent: number;
}

interface UnitFeederAssignmentsChangedEvent extends BaseEvent {
  readonly eventType: 'UnitFeederAssignmentsChanged';
  readonly userId?: string;
  readonly unitId: string;
  readonly unitType: 'tank' | 'pond' | 'cage';
  readonly unitCode: string;
  readonly siteId: string;
  readonly feeders: UnitFeederShareEntry[];
  readonly endedAssignmentIds: string[];
}

interface DrivenEquipmentUnitEntry {
  readonly unitId: string;
  readonly unitType: 'tank' | 'pond' | 'cage';
  readonly unitCode: string;
  readonly doseSharePercent: number;
}

interface VfdDriveBindingAttestedEvent extends BaseEvent {
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

interface VfdDriveBindingAttestationRequestedEvent extends BaseEvent {
  readonly eventType: 'VfdDriveBindingAttestationRequested';
  readonly vfdDeviceId: string;
  readonly drivenEquipmentId: string;
}
```

These three F2 discriminators are new version 1 contracts. Producers pass `version: 1`, consumers
validate only version 1, and no upcaster is added because there is no older deployed wire shape. The
F2 current-version constants, validators, and deliberate no-upcaster invariant remain the single
contract authority.

The farm listener validates the request, enters the event tenant transaction, reads Equipment,
equipment type, active feeder assignments, and site through manager-bound repositories, and enqueues
the complete attestation response through the farm outbox in that same transaction. It returns
explicit unknown and inactive outcomes. It never publishes the response directly.

The sensor listener subscribes to `VfdDriveBindingAttested`, the existing `EquipmentDeleted`, and
`UnitFeederAssignmentsChanged`. It validates the matching runtime event schema, tenant UUID, entity
UUIDs, and timestamp; invalid timestamps are rejected without substituting the current time. It
applies an attestation, immediate deletion revocation, or the complete unit-feeder set through
`VfdDriveBindingService`. Storage errors are rethrown so JetStream can redeliver.

- [ ] **Step 1: Write and run the red listener tests**

```bash
npx nx test farm-service --runInBand --testPathPatterns='vfd-drive-binding-attestation.listener.spec.ts'
npx nx test sensor-service --runInBand --testPathPatterns='vfd-drive-binding.listener.spec.ts'
```

Expected RED: no authoritative farm response exists, invalid metadata is not rejected, and sensor
state does not follow attestations, revocations, or full assignment replacement.

- [ ] **Step 2: Implement the minimal listeners and registrations**

Use the current F2 validators and `createBaseEvent` rather than local mirrors. Preserve the event
tenant from the validated envelope. Query active assignments as a complete snapshot, including an
empty list, because an empty list must revoke feeder actuation eligibility.

- [ ] **Step 3: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='vfd-drive-binding-attestation.listener.spec.ts'
npx nx test sensor-service --runInBand --testPathPatterns='vfd-drive-binding.listener.spec.ts'
npx nx test event-contracts --runInBand
npx prettier --check apps/farm-service/src/events/listeners apps/sensor-service/src/vfd/services
git diff --check
```

Expected GREEN: unknown, inactive, equipment-deleted revocation, feeder-with-units,
feeder-with-zero-units, retry, invalid event, and tenant-isolation cases pass; a response outbox
failure rolls back farm-side handling.

- [ ] **Step 4: Review, commit, and push this boundary**

```bash
git add -- apps/farm-service/src/events/listeners/vfd-drive-binding-attestation.listener.ts apps/farm-service/src/events/listeners/__tests__/vfd-drive-binding-attestation.listener.spec.ts apps/farm-service/src/events/listeners/index.ts apps/farm-service/src/events/event-listeners.module.ts apps/sensor-service/src/vfd/services/vfd-drive-binding.listener.ts apps/sensor-service/src/vfd/services/__tests__/vfd-drive-binding.listener.spec.ts apps/sensor-service/src/vfd/vfd.module.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task3_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 VFD loop: close the farm-to-sensor attestation circuit' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task3_finding_ids[@]}" -eq 1
[[ "${task3_finding_ids[0]}" =~ ^SENSOR-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): attest VFD equipment identity' \
  'Sensor command authority needs farm-owned equipment and assignment facts conveyed through a durable event circuit.' \
  "${task3_finding_ids[0]}")"
git push origin HEAD
```

### Task 4: Gate every VFD command and add the binding API

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Modify: `apps/sensor-service/src/vfd/services/vfd-command.service.ts`
- Modify: `apps/sensor-service/src/vfd/services/__tests__/vfd-command.service.spec.ts`
- Modify: `apps/sensor-service/src/vfd/services/__tests__/vfd-command.audit.spec.ts`
- Modify: `apps/sensor-service/src/vfd/resolvers/vfd-device.resolver.ts`
- Modify: `apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts`
- Modify: `apps/sensor-service/src/vfd/dto/vfd-command.dto.ts`
- Modify: `apps/sensor-service/src/vfd/dto/register-vfd.dto.ts`
- Modify: `apps/sensor-service/src/vfd/dto/update-vfd.dto.ts`
- Create: `apps/sensor-service/src/vfd/dto/vfd-drive-binding.dto.ts`
- Modify: `apps/sensor-service/src/vfd/dto/vfd-filter.dto.ts`
- Modify: `apps/sensor-service/src/vfd/dto/index.ts`
- Modify: `apps/sensor-service/src/vfd/services/vfd-device.service.ts`
- Modify: `apps/sensor-service/src/vfd/entities/vfd-device.entity.ts`
- Modify: `web/modules/sensor-module/src/components/vfd/steps/VfdBasicInfoStep.tsx`
- Create: `web/modules/sensor-module/src/graphql/vfd-device.operations.ts`
- Create: `web/modules/sensor-module/src/generated/vfd-device.graphql.ts` through codegen
- Modify: `codegen.ts`
- Modify: `web/modules/sensor-module/src/hooks/useVfdRegistration.ts`
- Create:
  `web/modules/sensor-module/src/hooks/__tests__/useVfdRegistration.generated-contract.spec.ts`
- Modify: `web/modules/sensor-module/src/types/vfd.types.ts`
- Modify: `apps/sensor-service/src/vfd/resolvers/__tests__/vfd-command.resolver.spec.ts`
- Modify: `apps/sensor-service/src/vfd/resolvers/__tests__/vfd-device.resolver.spec.ts`
- Modify: `e2e/tests/modules/sensor/vfd-device.spec.ts`
- Regenerate: `web/shared-ui/src/generated/graphql-types.ts`

**Interfaces:**

```ts
type VfdCommandRefusalCode =
  | 'unbound'
  | 'unattested'
  | 'attestation_expired'
  | 'unknown_equipment'
  | 'inactive_equipment'
  | 'feeder_without_unit'
  | 'device_inactive';
```

Extend the command execution result and GraphQL response with nullable `refusalCode`. Add
`bindVfdDrivenEquipment` and `unbindVfdDrivenEquipment`; expose `driveBinding` and `drivenUnit`. Add
`vfdDevicesByUnit(unitId: ID!): [VfdDevice!]!` as the canonical tank/pond/cage lookup. Registration
accepts optional `drivenEquipmentId`. The legacy `pumpId` and `tankId` input fields remain
deprecated for the rolling client window but never write or mutate authoritative binding state. A
request that supplies a legacy field without `drivenEquipmentId` creates an unbound, non-actuable
drive and returns the normal binding state; it never infers equipment from a unit. Task 5 removes
those deprecated fields after deployment evidence. The derived compatibility `tankId` is non-null
only when an attested feeder resolves to exactly one unit. `vfdDevicesByUnit`, `vfdDevicesByTank`,
and tank filtering join binding-unit rows; the compatibility tank roots include only binding units
whose `unitType` is `tank`.

Move every GraphQL operation used by `useVfdRegistration` from inline strings to
`vfd-device.operations.ts`. Add one disjoint codegen output for that file and consume its generated
typed documents, result types, and variable types through the shared authenticated GraphQL client.
`vfd.types.ts` may retain presentation and protocol-configuration types, but GraphQL input/result
declarations become aliases of generated types or are removed. The generated-contract test rejects
an inline `query`/`mutation` string in the hook and rejects handwritten `RegisterVfdInput`,
`UpdateVfdInput`, or registration-result interfaces.

Every generic and shorthand command calls `assertActuable` before any edge write and inside the
existing command audit `try` boundary. Emergency stop keeps its broad authenticated-user role
policy, but the global authentication guard, tenant guard, and attestation check still run. An
anonymous request must be rejected by the composed resolver path. A refusal is audited without an
edge write and is distinct from a transport failure.

- [ ] **Step 1: Write and run the red command/API tests**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='vfd-command.service.spec.ts|vfd-command.audit.spec.ts|vfd-device.resolver'
npm --prefix web/modules/sensor-module test -- src/hooks/__tests__/useVfdRegistration.generated-contract.spec.ts
npx jest --config e2e/jest.config.ts --runInBand --runTestsByPath e2e/tests/modules/sensor/vfd-device.spec.ts
```

Expected RED: at least one generic or shorthand path reaches the edge without attestation, an
anonymous emergency request is not proven rejected through the composed guard chain, and binding
queries still depend on legacy fields.

- [ ] **Step 2: Implement minimal fail-closed command gating**

Put the single binding-service assertion in the shared execution path before transport dispatch. Map
typed domain refusals to `refusalCode` while retaining the audit record. Do not catch a refusal
outside the audit boundary. Prove all command aliases converge on this path.

- [ ] **Step 3: Implement the additive binding API and current sensor-module client**

Use binding mutations as the only writer. Derive compatibility fields from the binding tables.
Update registration to send `drivenEquipmentId` and remove legacy binding-field readers from
production code. Keep the deprecated input and entity metadata only for rolling-schema
compatibility, but stop reading or writing `pumpId` and `tankId`; expose the compatibility `tankId`
only through resolver mapping. Move the hook's operations to the named operation file, add its
disjoint codegen target, regenerate it from the composed schema, and replace every wire-shape
declaration in the migrated hook with generated types.

- [ ] **Step 4: Run green verification**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='vfd-command|vfd-device.resolver|vfd-drive-binding'
npx nx test sensor-service --runInBand
npx nx test gateway-api --runInBand
npm --prefix web/modules/sensor-module test -- src/hooks/__tests__/useVfdRegistration.generated-contract.spec.ts
npx nx test sensor-module
npx jest --config e2e/jest.config.ts --runInBand --runTestsByPath e2e/tests/modules/sensor/vfd-device.spec.ts
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
git diff --check
```

Expected GREEN: all command forms refuse before transport for unbound, pending, expired, unknown,
inactive, and assigned-feeder-empty states; authenticated allowed states reach transport; anonymous
emergency requests fail; GraphQL and generated clients compile without a handwritten mirror.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
git add -- \
  apps/sensor-service/src/vfd/services/vfd-command.service.ts \
  apps/sensor-service/src/vfd/services/__tests__/vfd-command.service.spec.ts \
  apps/sensor-service/src/vfd/services/__tests__/vfd-command.audit.spec.ts \
  apps/sensor-service/src/vfd/resolvers/vfd-device.resolver.ts \
  apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts \
  apps/sensor-service/src/vfd/dto/vfd-command.dto.ts \
  apps/sensor-service/src/vfd/dto/register-vfd.dto.ts \
  apps/sensor-service/src/vfd/dto/update-vfd.dto.ts \
  apps/sensor-service/src/vfd/dto/vfd-drive-binding.dto.ts \
  apps/sensor-service/src/vfd/dto/vfd-filter.dto.ts \
  apps/sensor-service/src/vfd/dto/index.ts \
  apps/sensor-service/src/vfd/services/vfd-device.service.ts \
  apps/sensor-service/src/vfd/entities/vfd-device.entity.ts \
  apps/sensor-service/src/vfd/resolvers/__tests__/vfd-command.resolver.spec.ts \
  apps/sensor-service/src/vfd/resolvers/__tests__/vfd-device.resolver.spec.ts \
  web/modules/sensor-module/src/components/vfd/steps/VfdBasicInfoStep.tsx \
  web/modules/sensor-module/src/graphql/vfd-device.operations.ts \
  web/modules/sensor-module/src/generated/vfd-device.graphql.ts \
  codegen.ts \
  web/modules/sensor-module/src/hooks/useVfdRegistration.ts \
  web/modules/sensor-module/src/hooks/__tests__/useVfdRegistration.generated-contract.spec.ts \
  web/modules/sensor-module/src/types/vfd.types.ts \
  e2e/tests/modules/sensor/vfd-device.spec.ts \
  web/shared-ui/src/generated/graphql-types.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task4_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 VFD loop: gate every command on authoritative attestation' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task4_finding_ids[@]}" -eq 1
[[ "${task4_finding_ids[0]}" =~ ^SENSOR-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(sensor): gate every VFD command on attestation' \
  'Edge writes must be impossible unless authentication, tenant ownership, and a current actuable attestation all succeed.' \
  "${task4_finding_ids[0]}")"
git push origin HEAD
```

The expected generated contract files in this boundary are
`web/shared-ui/src/generated/graphql-types.ts` and
`web/modules/sensor-module/src/generated/vfd-device.graphql.ts`. If generation changes another
tracked path, stop and amend this file map before staging; never absorb an unreviewed artifact
through a broad add.

### Task 5: Contract legacy VFD binding surfaces after deployment evidence

**Gate:** Keep the one F3 branch and worktree open after Task 4. Its exact pushed Task 4 commit is
deployed through the repository workflow to the required staged fleet; every legacy `pump_id` row
has a binding with recorded parity; pending legacy rows are proven non-actuable; logs and repository
search prove no production reader or writer uses `pump_id` or `tank_id`; current sensor-module and
composed GraphQL clients use the binding API. Pause in the same worktree if any evidence is missing.
Do not merge, reconcile, or create a second branch before this task completes.

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Generated output contract: exactly one newly added
  `apps/sensor-service/src/database/migrations/[0-9]+-ContractLegacyVfdBindingColumns.ts`, resolved
  and count-checked with its sole exported class by Task 5 Step 2 before editing or staging
- Create:
  `apps/sensor-service/src/database/migrations/__tests__/contract-legacy-vfd-binding-columns.migration.spec.ts`
- Modify: `apps/sensor-service/src/vfd/dto/register-vfd.dto.ts`
- Modify: `apps/sensor-service/src/vfd/dto/update-vfd.dto.ts`
- Modify: `apps/sensor-service/src/vfd/entities/vfd-device.entity.ts`
- Modify: `apps/sensor-service/src/vfd/resolvers/__tests__/vfd-device.resolver.spec.ts`
- Modify: `e2e/tests/modules/sensor/vfd-device.spec.ts`
- Regenerate: `web/shared-ui/src/generated/graphql-types.ts`
- Regenerate: `web/modules/sensor-module/src/generated/vfd-device.graphql.ts`

**Interfaces:**

This migration is a contract-phase `ExpandContract` node. It imports the class exported by the one
tracked `ExpandVfdDriveBindings` migration and sets the decorator's string value to
`dependsOn: ExpandVfdDriveBindings.name`. The migration test discovers both files by suffix, parses
their exported class names, and asserts that exact metadata value; it fails when either suffix
resolves to zero or multiple files.

The public contract removes `RegisterVfdInput.pumpId`, `RegisterVfdInput.tankId`,
`UpdateVfdInput.tankId`, and the retired `VfdDevice.pumpId` output. Derived `VfdDevice.tankId`, the
tank filter, and `vfdDevicesByTank` remain backed only by binding-unit rows. Entity metadata removes
both physical columns while retaining derived `tankId` as a non-column GraphQL field.

The `up` migration repeats preflight parity and conflict checks, depends on the actual Task 1 expand
class, removes `trg_vfd_devices_legacy_pump_binding` plus its function, and drops only
`vfd_devices.pump_id` and `vfd_devices.tank_id`. The `down` migration recreates both nullable
columns, restores `pump_id` from the binding table, leaves `tank_id` null because multi-unit truth
cannot be collapsed honestly, and reinstalls the compatibility trigger for a rolled-back writer.

- [ ] **Step 1: Verify the exact staged predecessor on the canonical F3 branch and run red contract
      tests**

Use `apply_patch` to create the named migration test and strengthen the resolver/e2e assertions
before changing production metadata. The migration test must fail explicitly on a zero contract
suffix count; the API tests must fail while the deprecated input/output fields remain.

```bash
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test "$(git branch --show-current)" = feat/feeding-f3-vfd-attestation
test "$(git rev-parse --show-toplevel)" = /var/aqua-saas/.worktrees/aquamobil-v4-f3
F3_RUNTIME_CANDIDATE_SHA="$(git rev-parse HEAD)"
[[ "$F3_RUNTIME_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git ls-remote --heads origin refs/heads/feat/feeding-f3-vfd-attestation | awk '{print $1}')" = \
  "$F3_RUNTIME_CANDIDATE_SHA"
test -z "$(git status --porcelain)"
npx nx test sensor-service --runInBand --testPathPatterns='contract-legacy-vfd-binding-columns.migration.spec.ts|vfd-device.resolver'
npx jest --config e2e/jest.config.ts --runInBand --runTestsByPath e2e/tests/modules/sensor/vfd-device.spec.ts
```

Expected RED: the retired schema fields and entity columns still exist, and no contract migration
proves their safe removal.

- [ ] **Step 2: Remove retired metadata, then generate the contract migration**

Remove the three input fields, retired pump output, and the two `@Column` mappings. Keep derived
`tankId` as a resolver-backed GraphQL field. Then run:

```bash
(cd apps/sensor-service && npx typeorm-ts-node-commonjs migration:generate src/database/migrations/ContractLegacyVfdBindingColumns -d src/database/data-source.ts)
mapfile -t vfd_contract_generated_files < <(git ls-files --others --exclude-standard apps/sensor-service/src/database/migrations | rg '/[0-9]+-ContractLegacyVfdBindingColumns\.ts$')
test "${#vfd_contract_generated_files[@]}" -eq 1
mapfile -t vfd_contract_generated_classes < <(rg -o 'export class [A-Za-z0-9_]+' "${vfd_contract_generated_files[0]}")
test "${#vfd_contract_generated_classes[@]}" -eq 1
vfd_contract_generated_class="${vfd_contract_generated_classes[0]##* }"
printf 'migration=%s class=%s\n' "${vfd_contract_generated_files[0]}" "$vfd_contract_generated_class"
mapfile -t vfd_expand_files < <(git ls-files 'apps/sensor-service/src/database/migrations/*-ExpandVfdDriveBindings.ts')
test "${#vfd_expand_files[@]}" -eq 1
vfd_expand_class="$(rg -o 'export class [A-Za-z0-9_]+' "${vfd_expand_files[0]}" | awk '{print $3}')"
test -n "$vfd_expand_class"
printf '%s\n' "$vfd_expand_class"
```

Expected: the generated suffix, its sole exported class, and the exact expand predecessor are
printed without a predicted timestamp.

- [ ] **Step 3: Implement the minimal migration and regenerate consumers**

Import the class printed in Step 2 and use its `.name` as the single string `dependsOn` value. Make
the test resolve and compare that value mechanically rather than copying a class-name string into
its fixture. Refuse to run if parity, conflict, or nullability checks disagree with the deployment
report. Drop the compatibility trigger/function before their source column and restore both in
`down`. Regenerate the composed schema, shared schema types, and dedicated sensor VFD client.

- [ ] **Step 4: Run green verification**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='contract-legacy-vfd-binding-columns.migration.spec.ts|vfd-drive-binding|vfd-device.resolver'
npx nx test sensor-module
npx jest --config e2e/jest.config.ts --runInBand --runTestsByPath e2e/tests/modules/sensor/vfd-device.spec.ts
npm run gates:migration-sql
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
git diff --check
```

Expected GREEN: up/down passes on backfilled and empty schemas, unsafe legacy states abort, retired
public fields are absent, no runtime reader references either dropped column, generated clients
compile, and derived `tankId` compatibility remains.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
mapfile -t vfd_contract_generated_files < <(git ls-files --others --exclude-standard apps/sensor-service/src/database/migrations | rg '/[0-9]+-ContractLegacyVfdBindingColumns\.ts$')
test "${#vfd_contract_generated_files[@]}" -eq 1
git add -- "${vfd_contract_generated_files[0]}" \
  apps/sensor-service/src/database/migrations/__tests__/contract-legacy-vfd-binding-columns.migration.spec.ts \
  apps/sensor-service/src/vfd/dto/register-vfd.dto.ts \
  apps/sensor-service/src/vfd/dto/update-vfd.dto.ts \
  apps/sensor-service/src/vfd/entities/vfd-device.entity.ts \
  apps/sensor-service/src/vfd/resolvers/__tests__/vfd-device.resolver.spec.ts \
  e2e/tests/modules/sensor/vfd-device.spec.ts \
  web/shared-ui/src/generated/graphql-types.ts \
  web/modules/sensor-module/src/generated/vfd-device.graphql.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task5_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 VFD loop: contract retired drive-binding columns' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task5_finding_ids[@]}" -eq 1
[[ "${task5_finding_ids[0]}" =~ ^SENSOR-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nBREAKING CHANGE: %s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(sensor): contract legacy VFD unit columns' \
  'The retired device columns must disappear only after the binding backfill and reader migration have been proven in deployment.' \
  'Remove the retired VFD binding input/output fields and the vfd_devices pump_id and tank_id storage columns.' \
  "${task5_finding_ids[0]}")"
git push origin HEAD
```

Task 5 is the final commit in the one F3 implementation boundary. Rerun the four-audit,
audit/explain-set, production Vite/Rollup manifest, mapper, immutable-preflight check, and direct
ledger-verifier sequence from **Canonical Coordinator and Slice Preflight** into
`artifacts/aquamobil-v4/F3/dependency-final`; do not rewrite the preflight. Verify the one protected
F3 PR through the coordinator, merge it, and let only the program's fresh F3 reconciliation branch
capture `vfd-attestation` and regenerate the ledger. F4 cannot start until that reconciliation's
exact protected-main commit is proven by its slice-entry checkpoint.

---

## F4 — Feeder Physical Model and Mass Projection

### Task 6: Version feeder-calibration events and upcast at the gateway

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `docs/superpowers/evidence/aquamobil-v4/slices/F4/preflight.json` through the program
  capture tool
- Modify: `libs/event-contracts/src/farm-events.ts`
- Modify: `libs/event-contracts/src/schemas/farm-events.schema.ts`
- Create: `libs/event-contracts/src/upcasters/feeder-calibrations-saved-v1-to-v2.upcaster.ts`
- Modify: `libs/event-contracts/src/upcasters/index.ts`
- Modify: `libs/event-contracts/src/upcasters/__tests__/upcasters.spec.ts`
- Create: `libs/event-contracts/src/schemas/__tests__/farm-events.schema.spec.ts`
- Modify: `apps/gateway-api/src/websocket/farm-nats-bridge.service.ts`
- Create: `apps/gateway-api/src/websocket/__tests__/farm-nats-bridge.service.spec.ts`
- Modify: `apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts`
- Create: `apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.event-version.spec.ts`

**Interfaces:**

```ts
interface FeederCalibrationsSavedV1Event extends BaseEvent {
  eventType: 'FeederCalibrationsSaved';
  version: 1;
  equipmentId: string;
  calibrationCount: number;
  feedSizeMm: number[];
  changedBy: string;
}

interface FeederCalibrationsSavedEvent extends BaseEvent {
  eventType: 'FeederCalibrationsSaved';
  version: 2;
  equipmentId: string;
  calibrationCount: number;
  identityKind: 'feed_id' | 'legacy_feed_size';
  feedIds: string[];
  legacyFeedSizeMm: number[];
  dosingMode?: 'discrete' | 'continuous';
  dispenseControl?: 'time_based' | 'weight_based';
  changedBy: string;
}
```

The v1-to-v2 upcaster first validates the old shape, removes `feedSizeMm`, sets `version: 2`, sets
`identityKind: 'legacy_feed_size'`, copies the legacy sizes, uses an empty `feedIds`, and leaves the
two machine fields absent. The existing legacy-size producer remains explicitly v1 in this task.
Task 8 adds a distinct canonical v2 producer after canonical feed identity is stored while keeping
the legacy producer at v1 until Task 14 removes its public mutation. This avoids claiming a feed-ID
wire shape before a producer can supply one.

The gateway creates the default upcaster registry, derives the tenant from the NATS subject as it
does today, upcasts the event, then validates and broadcasts the current shape. It never validates
v1 as if it were v2 and never trusts a payload tenant over the subject tenant.

- [ ] **Step 1: Verify the coordinator-created F4 boundary, then write and run red contract and
      gateway tests**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
test "$(git branch --show-current)" = feat/feeding-f4-calibration-physics
test "$(git rev-parse --show-toplevel)" = /var/aqua-saas/.worktrees/aquamobil-v4-f4
test "$(git rev-parse HEAD)" = \
  "$(jq -r '.baseMainCommit' docs/superpowers/evidence/aquamobil-v4/slices/F4/preflight.json)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice F4 \
  --check docs/superpowers/evidence/aquamobil-v4/slices/F4/preflight.json \
  --main-ref origin/main
npx nx test event-contracts --runInBand --testPathPatterns='upcasters.spec.ts|farm-events.schema.spec.ts'
npx nx test gateway-api --runInBand --testPathPatterns='farm-nats-bridge.service.spec.ts'
```

Expected RED: the v1 fixture cannot become the exact v2 shape, invalid v1 data is not rejected at
the old boundary, and the gateway broadcasts raw legacy payloads.

- [ ] **Step 2: Implement the minimal versioned contract and upcast chain**

Keep distinct TypeScript interfaces and schemas for the two real wire versions. Register only the
honest `1 -> 2` edge. Preserve base-event identity and timestamps. Pin the current producer's
version-1 fixture and pass the version override to `createBaseEvent` explicitly, so an unplanned
producer flip fails this task's tests.

- [ ] **Step 3: Run green verification**

```bash
npx nx test event-contracts --runInBand
npx nx test gateway-api --runInBand --testPathPatterns='farm-nats-bridge.service.spec.ts'
npx nx test farm-service --runInBand --testPathPatterns='save-feeder-calibrations.event-version.spec.ts'
npx prettier --check libs/event-contracts/src apps/gateway-api/src/websocket/farm-nats-bridge.service.ts apps/gateway-api/src/websocket/__tests__/farm-nats-bridge.service.spec.ts
git diff --check
```

Expected GREEN: v1 acceptance, malformed-v1 rejection, exact v2 output, native-v2 pass-through,
unsupported-version rejection, and subject-tenant preservation all pass.

- [ ] **Step 4: Review, commit, and push this boundary**

```bash
git add -- \
  docs/superpowers/evidence/aquamobil-v4/slices/F4/preflight.json \
  libs/event-contracts/src/farm-events.ts \
  libs/event-contracts/src/schemas/farm-events.schema.ts \
  libs/event-contracts/src/schemas/__tests__/farm-events.schema.spec.ts \
  libs/event-contracts/src/upcasters/feeder-calibrations-saved-v1-to-v2.upcaster.ts \
  libs/event-contracts/src/upcasters/index.ts \
  libs/event-contracts/src/upcasters/__tests__/upcasters.spec.ts \
  apps/gateway-api/src/websocket/farm-nats-bridge.service.ts \
  apps/gateway-api/src/websocket/__tests__/farm-nats-bridge.service.spec.ts \
  apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts \
  apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.event-version.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task6_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: version feeder calibration events' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task6_finding_ids[@]}" -eq 1
[[ "${task6_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nBREAKING CHANGE: %s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(events): version feeder calibration events' \
  'Versioned calibration events must preserve old-message readability while making feeder identity and physics explicit.' \
  'Advance feeder calibration events to version 2 while retaining version 1 through the tested upcaster.' \
  "${task6_finding_ids[0]}")"
git push -u origin HEAD
```

### Task 7: Add a distinct mass-event vocabulary and NATS route

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `libs/event-contracts/src/sensor-mass-parameters.ts`
- Create: `libs/event-contracts/src/__tests__/sensor-mass-parameters.spec.ts`
- Modify: `libs/event-contracts/src/sensor-events.ts`
- Modify: `libs/event-contracts/src/schemas/sensor-events.schema.ts`
- Modify: `libs/event-contracts/src/schemas/__tests__/sensor-events.schema.spec.ts`
- Modify: `libs/event-contracts/src/index.ts`
- Modify: `apps/sensor-service/src/database/entities/sensor.entity.ts`
- Generated output contract: exactly one newly added
  `apps/sensor-service/src/database/migrations/[0-9]+-AddSensorMassType.ts`, resolved and
  count-checked with its sole exported class by Task 7 Step 2 before editing or staging
- Create:
  `apps/sensor-service/src/database/migrations/__tests__/add-sensor-mass-type.migration.spec.ts`
- Modify: `tests/invariants/upcaster-chain.spec.ts`
- Read: `infrastructure/ci/image-digests.json`
- Read: `scripts/ci/resolve-ci-image.mjs`
- Modify: `tests/invariants/nats-config-ssot.spec.ts`
- Modify: `infrastructure/nats/services.yaml`
- Regenerate: `infrastructure/docker/nats/nats.conf`
- Regenerate: `infrastructure/helm/aquaculture/files/nats-service-identities.yaml`
- Modify: `e2e/tests/integration/nats-invariants.spec.ts`
- Modify: `e2e/tests/integration/nats-subject-contract.spec.ts`
- Modify: `scripts/nats/feeding-acl-smoke.mjs`
- Modify: `scripts/nats/feeding-acl-smoke.test.mjs`
- Modify: `scripts/nats/feeding-acl-smoke-harness.sh`
- Regenerate: `web/shared-ui/src/generated/graphql-types.ts`

**Interfaces:**

```ts
export const SENSOR_MASS_PARAMETERS = ['massKg'] as const;
export const SENSOR_MASS_OBSERVED_CURRENT_VERSION = 1;

interface SensorMassObservedEvent extends BaseEvent {
  eventType: 'SensorMassObserved';
  version: 1;
  sensorId: string;
  channelId: string;
  massKg: number;
  observedAt: string;
  qualityCode: number;
  equipmentId?: string;
  farmId?: string;
}
```

`SensorMassObserved` is new on the execution baseline, begins at version 1, and has no older wire
shape to upcast. Before editing, an anchored source-and-history scan must still prove that fact. The
version-chain invariant rejects versions 0 and 2 and proves no upcaster names this event; a baseline
or history hit pauses the task for a real version-history decision.

`SensorMetricIngested.qualityCode` and `SensorMassObserved.qualityCode` share the current persisted
OPC-UA DA vocabulary: integer `0..127` or `192..255`, with reserved `128..191` rejected. Update the
existing ingest validator and its tests from the retired `0..3` subset so Rust-sidecar good values
such as 192 can reach `sensor_metrics`. Do not reinterpret `0..3` as a different enum; those values
remain valid OPC-UA bad codes. The mass event carries the exact persisted code and its own validator
enforces the same bands.

`massParameterForChannelKey` maps `mass`, `mass_kg`, `silo_mass`, and `silo_mass_kg` to `massKg` and
returns no value for water-quality channels. Do not edit
`libs/event-contracts/src/sensor-reading-parameters.ts`; do not add mass to `SensorReading` or
`SensorReadings`.

Add `SensorType.MASS = 'mass'` with a fresh nontransactional enum migration. The migration sets
`transaction = false`, adds the PostgreSQL enum value safely, and documents the irreversible enum
addition in `down` without pretending PostgreSQL can remove it safely.

Allow sensor-service to publish `events.*.SensorMassObserved`. Allow farm-service to consume it
through its existing JetStream pull pattern only; add no core-subscribe grant. Regenerate both NATS
outputs from `services.yaml`. Extend the F2 feeding ACL harness instead of creating a second live
broker fixture. Its broker image comes only from the `nats` key in
`infrastructure/ci/image-digests.json`; a missing key, a value without an `@sha256:` suffix, a
fallback tag, an environment or CLI override, or a copied NATS image literal aborts before Docker
starts.

The live matrix uses the real ephemeral client certificates whose CNs are `sensor_service`,
`farm_service`, and an unrelated `billing_service`. It proves all of the following on fresh
connections: the sensor certificate publishes `events.<tenant>.SensorMassObserved` and completes a
`flush()`; the farm certificate creates the named pull consumer and receives those exact bytes; the
farm certificate has no core subscription to the mass subject and cannot publish it; the sensor
certificate cannot core-subscribe to it; the billing certificate can neither publish nor
core-subscribe; and the existing unregistered-CN connection denial remains green. A denied
publish/subscribe passes only after a bounded status loop observes the broker permission violation
for the attempted subject. A timeout, a generic disconnect, an empty pull, or an allowed unrelated
operation fails the harness.

- [ ] **Step 1: Write and run red vocabulary, schema, migration, and ACL tests**

```bash
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
if git grep -n 'SensorMassObserved' origin/main -- libs/event-contracts/src apps infrastructure/nats; then
  exit 1
fi
if git log origin/main --format='%H %s' -S'SensorMassObserved' -- libs/event-contracts/src apps infrastructure/nats | rg .; then
  exit 1
fi
npx nx test event-contracts --runInBand --testPathPatterns='sensor-mass-parameters|sensor-events.schema'
npx nx test sensor-service --runInBand --testPathPatterns='add-sensor-mass-type.migration.spec.ts'
npx nx test invariants --runInBand --testPathPatterns='upcaster-chain.spec.ts'
npx nx test invariants --runInBand --testPathPatterns='nats-config-ssot.spec.ts'
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath tests/invariants/ci-image-digests.spec.ts
npx jest --config e2e/jest.config.ts --runInBand --runTestsByPath e2e/tests/integration/nats-invariants.spec.ts e2e/tests/integration/nats-subject-contract.spec.ts
node --test scripts/nats/feeding-acl-smoke.test.mjs
```

Expected RED before implementation: the separate vocabulary, v1 validator, OPC-UA ingest-validator
parity, enum value, publisher grant, pull-consumer grant, and live mass-route matrix are absent.

- [ ] **Step 2: Implement the minimal event contract and enum migration**

Register `SensorMassObserved` in the current event union and schema registry. Require finite numeric
mass, UUID identifiers, an integer quality code in either valid OPC-UA band, and an ISO timestamp at
the schema boundary. Apply the same band predicate to `SensorMetricIngested`; do not reintroduce a
second source-quality scale or remap a code after validation. Generate `AddSensorMassType`, discover
its actual file, and implement the nontransactional enum addition.

```bash
(cd apps/sensor-service && npx typeorm-ts-node-commonjs migration:generate src/database/migrations/AddSensorMassType -d src/database/data-source.ts)
mapfile -t sensor_mass_generated_files < <(git ls-files --others --exclude-standard apps/sensor-service/src/database/migrations | rg '/[0-9]+-AddSensorMassType\.ts$')
test "${#sensor_mass_generated_files[@]}" -eq 1
mapfile -t sensor_mass_generated_classes < <(rg -o 'export class [A-Za-z0-9_]+' "${sensor_mass_generated_files[0]}")
test "${#sensor_mass_generated_classes[@]}" -eq 1
sensor_mass_generated_class="${sensor_mass_generated_classes[0]##* }"
printf 'migration=%s class=%s\n' "${sensor_mass_generated_files[0]}" "$sensor_mass_generated_class"
```

- [ ] **Step 3: Update the NATS authority and regenerate outputs**

Edit only `infrastructure/nats/services.yaml`, run the generator, and inspect both generated diffs.
The sensor certificate publishes the exact wildcard subject; the farm certificate receives it only
through the durable consumer configuration. Extend `feeding-acl-smoke.mjs`, its unit test, and its
harness with the exact matrix above. Reuse its F2 CA, cert generation, broker lifecycle, and cleanup
trap. The harness resolves the immutable broker only through its repository-local I1-owned resolver
and fixed manifest/key CLI; this portable resolver invocation is deliberately exempt from the
coordinator mixed-copy rule. It accepts no image environment or CLI override.

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/ci-image-digests.spec.ts
NATS_IMAGE="$(node scripts/ci/resolve-ci-image.mjs \
  --manifest infrastructure/ci/image-digests.json \
  --image nats)"
[[ "$NATS_IMAGE" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]]
```

- [ ] **Step 4: Run green verification**

```bash
npx nx test event-contracts --runInBand
npx nx test sensor-service --runInBand --testPathPatterns='add-sensor-mass-type.migration.spec.ts'
npx nx test invariants --runInBand --testPathPatterns='upcaster-chain.spec.ts|nats-config-ssot.spec.ts'
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath tests/invariants/ci-image-digests.spec.ts
! rg -n 'SensorMassObserved' libs/event-contracts/src/upcasters
nats_docker_before="$(sha256sum infrastructure/docker/nats/nats.conf)"
nats_helm_before="$(sha256sum infrastructure/helm/aquaculture/files/nats-service-identities.yaml)"
python3 scripts/nats/generate-nats-conf.py
test "$nats_docker_before" = "$(sha256sum infrastructure/docker/nats/nats.conf)"
test "$nats_helm_before" = "$(sha256sum infrastructure/helm/aquaculture/files/nats-service-identities.yaml)"
npx jest --config e2e/jest.config.ts --runInBand --runTestsByPath e2e/tests/integration/nats-invariants.spec.ts e2e/tests/integration/nats-subject-contract.spec.ts
node --test scripts/nats/feeding-acl-smoke.test.mjs
npm run smoke:nats-feeding-acl:static
npm run smoke:nats-feeding-acl
npm run gates:migration-sql
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
git diff --check
```

Expected GREEN: ingest and mass-event quality-band acceptance/rejection, aliases, enum migration,
static generated ACL, immutable NATS-image resolution, and live sensor-publish/farm-pull/unrelated
certificate-identity denial cases pass.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
mapfile -t sensor_mass_generated_files < <(git ls-files --others --exclude-standard apps/sensor-service/src/database/migrations | rg '/[0-9]+-AddSensorMassType\.ts$')
test "${#sensor_mass_generated_files[@]}" -eq 1
git add -- "${sensor_mass_generated_files[0]}" \
  libs/event-contracts/src/sensor-mass-parameters.ts \
  libs/event-contracts/src/__tests__/sensor-mass-parameters.spec.ts \
  libs/event-contracts/src/sensor-events.ts \
  libs/event-contracts/src/schemas/sensor-events.schema.ts \
  libs/event-contracts/src/schemas/__tests__/sensor-events.schema.spec.ts \
  libs/event-contracts/src/index.ts \
  apps/sensor-service/src/database/entities/sensor.entity.ts \
  apps/sensor-service/src/database/migrations/__tests__/add-sensor-mass-type.migration.spec.ts \
  tests/invariants/upcaster-chain.spec.ts \
  tests/invariants/nats-config-ssot.spec.ts \
  infrastructure/nats/services.yaml \
  infrastructure/docker/nats/nats.conf \
  infrastructure/helm/aquaculture/files/nats-service-identities.yaml \
  e2e/tests/integration/nats-invariants.spec.ts \
  e2e/tests/integration/nats-subject-contract.spec.ts \
  scripts/nats/feeding-acl-smoke.mjs \
  scripts/nats/feeding-acl-smoke.test.mjs \
  scripts/nats/feeding-acl-smoke-harness.sh \
  web/shared-ui/src/generated/graphql-types.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task7_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: define durable mass observations' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task7_finding_ids[@]}" -eq 1
[[ "${task7_finding_ids[0]}" =~ ^SENSOR-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(sensor): define durable mass observations' \
  'Mass evidence needs a versioned metric-derived contract that preserves the raw quality code across the service boundary.' \
  "${task7_finding_ids[0]}")"
git push origin HEAD
```

### Task 8: Expand calibration storage and expose an additive setup API

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `apps/farm-service/src/equipment/entities/feeder-capability.entity.ts`
- Create: `apps/farm-service/src/equipment/entities/feeder-silo-mass-latest.entity.ts`
- Modify: `apps/farm-service/src/equipment/entities/feeder-calibration.entity.ts`
- Modify: `libs/backend-common/src/database/schema-manager.service.ts`
- Generated output contract: exactly one newly added
  `apps/farm-service/src/database/migrations/[0-9]+-ExpandFeederCalibrationPhysics.ts`, resolved and
  count-checked with its sole exported class by Task 8 Step 3 before editing, manifest registration,
  or staging
- Create:
  `apps/farm-service/src/database/migrations/__tests__/expand-feeder-calibration-physics.migration.spec.ts`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Create: `apps/farm-service/src/equipment/dto/feeder-setup.input.ts`
- Create: `apps/farm-service/src/equipment/dto/feeder-setup.response.ts`
- Create: `apps/farm-service/src/equipment/commands/save-feeder-setup.command.ts`
- Create: `apps/farm-service/src/equipment/handlers/save-feeder-setup.handler.ts`
- Modify: `apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts`
- Modify: `apps/farm-service/src/equipment/handlers/list-feeder-calibrations.handler.ts`
- Modify: `apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.event-version.spec.ts`
- Create: `apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.legacy-compat.spec.ts`
- Modify: `apps/farm-service/src/equipment/equipment.resolver.ts`
- Modify: `apps/farm-service/src/equipment/equipment.module.ts`
- Modify: `apps/farm-service/src/common/authz/permission-matrix.ts`
- Regenerate: `apps/farm-service/schema.graphql`
- Regenerate: `web/shared-ui/src/generated/graphql-types.ts`
- Create: `apps/farm-service/src/equipment/__tests__/save-feeder-setup.handler.spec.ts`
- Modify: `apps/farm-service/src/equipment/__tests__/list-feeder-calibrations.handler.spec.ts`
- Create: `apps/farm-service/src/equipment/__tests__/equipment.resolver.spec.ts`
- Modify: `apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts`

**Interfaces:**

```ts
class DiscreteFeederCalibrationItemInput {
  feedId: string;
  gramsPerDispensing: number;
  notes?: string;
}

class ContinuousFeederCalibrationItemInput {
  feedId: string;
  gramsPerMinute: number;
  referenceSpeedHz: number;
  notes?: string;
}

class DiscreteFeederSetupInput {
  siloCapacityKg?: number;
  calibrations: DiscreteFeederCalibrationItemInput[];
}

class ContinuousFeederSetupInput {
  siloCapacityKg?: number;
  minSpeedHz: number;
  maxSpeedHz: number;
  calibrations: ContinuousFeederCalibrationItemInput[];
}

class FeederDispenseControlInput {
  mode: 'time_based' | 'weight_based';
  weightSensorId?: string;
}

class SaveFeederSetupInput {
  equipmentId: string;
  dispense: FeederDispenseControlInput;
  discrete?: DiscreteFeederSetupInput;
  continuous?: ContinuousFeederSetupInput;
  notes?: string;
}

class FeederCapabilityResponse {
  equipmentId: string;
  dosingMode: 'discrete' | 'continuous';
  siloCapacityKg?: number;
  minSpeedHz?: number;
  maxSpeedHz?: number;
  dispenseControl: 'time_based' | 'weight_based';
  weightSensorId?: string;
  notes?: string;
}

class FeederSetupCalibrationResponse {
  id: string;
  equipmentId: string;
  feedId: string;
  dosingMode: 'discrete' | 'continuous';
  gramsPerDispensing?: number;
  gramsPerMinute?: number;
  referenceSpeedHz?: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

class FeederSetupResponse {
  readiness: 'unconfigured' | 'ready' | 'requires_remediation';
  capability?: FeederCapabilityResponse;
  calibrations: FeederSetupCalibrationResponse[];
}

interface FeederCapability {
  tenantId: string;
  equipmentId: string;
  dosingMode: 'discrete' | 'continuous';
  siloCapacityKg?: number;
  minSpeedHz?: number;
  maxSpeedHz?: number;
  dispenseControl: 'time_based' | 'weight_based';
  weightSensorId?: string;
  notes?: string;
  createdBy?: string;
  updatedBy?: string;
}
```

Exactly one of `discrete` and `continuous` is supplied. Weight-based control requires
`weightSensorId`; time-based control rejects it. Continuous setup requires a positive ordered speed
band and positive calibration values. Every feed ID must name a live tenant feed.

`FeederCapability` is authoritative for machine-wide dosing mode, silo capacity, continuous speed
band, dispense control, and mass-sensor soft reference. Its key is `(tenant_id, equipment_id)` and
its equipment FK remains tenant-local. A database check makes continuous mode equivalent to a
non-null ordered min/max band and discrete mode equivalent to both values being null. A second check
makes weight-based control equivalent to a non-null UUID `weight_sensor_id`.

Calibration remains authoritative only for feed-specific physics. Its `dosing_mode`, `min_speed_hz`,
and `max_speed_hz` copies are constraint carriers, not independent settings: a composite FK pins
`(tenant_id, equipment_id, dosing_mode)` to capability, another pins the continuous band copies with
`ON UPDATE CASCADE`, and local checks enforce discrete versus continuous field XOR plus reference
speed inside the pinned band. Raw SQL therefore cannot store a discrete calibration for a continuous
machine or a divergent band. Farm service must not create a cross-service FK to sensor-service. The
save API validates UUID shape and control-mode consistency; Task 11 refuses weight control unless
the soft-referenced sensor has fresh projected mass evidence.

The expand migration creates capability and latest-mass tables; adds nullable `feed_id`,
`dosing_mode`, continuous-rate, reference-speed, and constraint-carrier band columns to calibration;
makes `feed_size_mm`, `grams_per_dispensing`, and row-level `silo_capacity_kg` nullable so canonical
continuous or capability-owned rows do not invent legacy values. It preserves `feed_size_mm`,
`feed_size_label`, and row-level `silo_capacity_kg` for rollout readers, while
`grams_per_dispensing` remains the canonical discrete-rate field. The legacy response type remains
unchanged. The additive setup response returns only canonical calibration rows and reports
`requires_remediation` when unresolved legacy rows exist; it never fabricates a canonical identity.
The migration backfills `feed_id` only for an exact single live pellet-size match. It copies silo
capacity to the capability row only when all non-null legacy values agree. It emits per-tenant
unresolved counts for no match, ambiguous match, conflicting capacity, and absent capability. It
never chooses an arbitrary aggregate or collapses conflicting values.

Add `feederSetup(equipmentId)` and `saveFeederSetup(input)` while retaining `feederCalibrations` and
`saveFeederCalibrations` until Task 14. The legacy handler remains an explicit version 1 producer
throughout the client rollout, but it may not create new unresolved debt. Both save handlers lock
and inspect the complete existing calibration set first; if any row is unresolved, they reject
without deleting or rewriting it because only Task 9's same-row remediation command may resolve
migration debt. Before deleting or writing a row, the legacy handler resolves every legacy
`feedSizeMm` to exactly one live tenant feed and requires one consistent silo capacity across the
complete input. It creates or updates only a discrete, time-based capability and writes feed ID,
discrete mode, canonical grams per dispensing, and the legacy mirror fields on the same calibration
rows. It rejects a missing or ambiguous feed match and refuses to overwrite continuous or
weight-based capability rather than guessing a downgrade. Its outbox message remains the exact v1
shape.

The new canonical handler writes capability, calibration rows, audit record, and a version 2
`FeederCalibrationsSaved` outbox message in one tenant transaction. It calls `createBaseEvent` with
explicit version 2, uses `identityKind: 'feed_id'`, supplies the canonical feed IDs, and emits an
empty legacy-size list. During the rolling reader window, a canonical discrete save mirrors the
referenced live feed's pellet size and the capability silo capacity into the nullable legacy
columns. A continuous row leaves those legacy columns null. The legacy list handler returns only
rows with a complete non-null legacy response shape; it never exposes a nullable value through an
old non-null GraphQL field and never represents continuous physics as discrete.

- [ ] **Step 1: Write and run red migration and API tests**

```bash
npx nx test farm-service --runInBand --testPathPatterns='expand-feeder-calibration-physics|save-feeder-setup|save-feeder-calibrations.event-version|save-feeder-calibrations.legacy-compat|list-feeder-calibrations'
npx nx run farm-service:e2e --testPathPatterns='site-tenant-isolation.postgres.spec.ts'
```

Expected RED: new entity metadata, honest backfill classification, XOR input validation, feed-ID
validation, additive query, atomic audit/outbox, and tenant isolation do not exist.

- [ ] **Step 2: Add the additive entity metadata and registrations**

Create `FeederCapability` and `FeederSiloMassLatest`, expand `FeederCalibration` with nullable
canonical fields and constraint carriers, register the entities, and update the tenant schema
manager. Keep every legacy field intact. Re-run the entity metadata assertions and confirm they pass
while the migration and API assertions remain red.

- [ ] **Step 3: Generate and implement the expand migration**

```bash
(cd apps/farm-service && npx typeorm-ts-node-commonjs migration:generate src/database/migrations/ExpandFeederCalibrationPhysics -d src/database/data-source.ts)
mapfile -t feeder_expand_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-ExpandFeederCalibrationPhysics\.ts$')
test "${#feeder_expand_generated_files[@]}" -eq 1
mapfile -t feeder_expand_generated_classes < <(rg -o 'export class [A-Za-z0-9_]+' "${feeder_expand_generated_files[0]}")
test "${#feeder_expand_generated_classes[@]}" -eq 1
feeder_expand_generated_class="${feeder_expand_generated_classes[0]##* }"
printf 'migration=%s class=%s\n' "${feeder_expand_generated_files[0]}" "$feeder_expand_generated_class"
```

Add the class exported by exactly the printed file to the manifest. Implement table creation,
nullable expansion, conservative backfill, unresolved report, canonical RLS, postflight counts, and
reversible `down` behavior. Do not delete or rewrite a legacy row.

- [ ] **Step 4: Implement the minimal additive API**

Use manager-bound repositories inside a single tenant transaction. Save one canonical capability row
per feeder and one calibration per tenant/equipment/feed identity. The new handler enqueues only the
native v2 event. Make the legacy handler validate and construct its full canonical replacement set
before deleting prior rows, then dual-write those exact rows and enqueue only v1. Keep the legacy
query compatible during the rollout by filtering to complete legacy-shaped rows; do not route
canonical input through the legacy DTO.

- [ ] **Step 5: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='expand-feeder-calibration-physics|feeder-calibration|save-feeder-setup'
npx nx run farm-service:test:integration
npx nx run farm-service:e2e
npm run gates:migration-sql
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
git diff --check
```

Expected GREEN: unambiguous rows backfill, ambiguous and conflicting rows remain reported, invalid
XOR and sensor combinations fail, unresolved legacy rows report `requires_remediation`, accepted
legacy saves create only canonical discrete rows while still emitting version 1, ambiguous legacy
saves and either save against existing unresolved rows change nothing, the canonical v2 event rolls
back with the save on outbox failure, the legacy query returns complete discrete rows but no
continuous row, and two tenants cannot see or mutate each other's setup.

- [ ] **Step 6: Review, commit, and push this boundary**

```bash
mapfile -t feeder_expand_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-ExpandFeederCalibrationPhysics\.ts$')
test "${#feeder_expand_generated_files[@]}" -eq 1
git add -- "${feeder_expand_generated_files[0]}" \
  apps/farm-service/src/equipment/entities/feeder-capability.entity.ts \
  apps/farm-service/src/equipment/entities/feeder-silo-mass-latest.entity.ts \
  apps/farm-service/src/equipment/entities/feeder-calibration.entity.ts \
  libs/backend-common/src/database/schema-manager.service.ts \
  apps/farm-service/src/database/migrations/__tests__/expand-feeder-calibration-physics.migration.spec.ts \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/src/equipment/dto/feeder-setup.input.ts \
  apps/farm-service/src/equipment/dto/feeder-setup.response.ts \
  apps/farm-service/src/equipment/commands/save-feeder-setup.command.ts \
  apps/farm-service/src/equipment/handlers/save-feeder-setup.handler.ts \
  apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts \
  apps/farm-service/src/equipment/handlers/list-feeder-calibrations.handler.ts \
  apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.event-version.spec.ts \
  apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.legacy-compat.spec.ts \
  apps/farm-service/src/equipment/equipment.resolver.ts \
  apps/farm-service/src/equipment/equipment.module.ts \
  apps/farm-service/src/common/authz/permission-matrix.ts \
  apps/farm-service/schema.graphql \
  web/shared-ui/src/generated/graphql-types.ts \
  apps/farm-service/src/equipment/__tests__/save-feeder-setup.handler.spec.ts \
  apps/farm-service/src/equipment/__tests__/list-feeder-calibrations.handler.spec.ts \
  apps/farm-service/src/equipment/__tests__/equipment.resolver.spec.ts \
  apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task8_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: expand canonical feeder calibration' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task8_finding_ids[@]}" -eq 1
[[ "${task8_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): expand feeder calibration physics' \
  'Canonical feeder calibration must store the physical parameters required to derive a safe dose.' \
  "${task8_finding_ids[0]}")"
git push origin HEAD
```

### Task 9: Add tenant-scoped legacy calibration remediation

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `apps/farm-service/src/equipment/commands/resolve-legacy-feeder-calibration.command.ts`
- Create: `apps/farm-service/src/equipment/handlers/resolve-legacy-feeder-calibration.handler.ts`
- Create: `apps/farm-service/src/equipment/queries/list-unresolved-feeder-calibrations.query.ts`
- Create: `apps/farm-service/src/equipment/handlers/list-unresolved-feeder-calibrations.handler.ts`
- Create: `apps/farm-service/src/equipment/dto/legacy-feeder-calibration-remediation.input.ts`
- Create: `apps/farm-service/src/equipment/dto/legacy-feeder-calibration-remediation.response.ts`
- Modify: `apps/farm-service/src/equipment/equipment.resolver.ts`
- Modify: `apps/farm-service/src/equipment/equipment.module.ts`
- Modify: `apps/farm-service/src/common/authz/permission-matrix.ts`
- Regenerate: `apps/farm-service/schema.graphql`
- Regenerate: `web/shared-ui/src/generated/graphql-types.ts`
- Create:
  `apps/farm-service/src/equipment/__tests__/resolve-legacy-feeder-calibration.handler.spec.ts`
- Create:
  `apps/farm-service/src/equipment/__tests__/list-unresolved-feeder-calibrations.handler.spec.ts`

**Interfaces:**

```ts
class ResolveLegacyFeederCalibrationInput {
  calibrationId: string;
  feedId: string;
  siloCapacityKg?: number;
  dispense: FeederDispenseControlInput;
}

type LegacyCalibrationIssueReason =
  | 'feed_match_none'
  | 'feed_match_ambiguous'
  | 'capacity_conflict'
  | 'capability_missing';

class LegacyFeederCalibrationIssueResponse {
  calibrationId: string;
  equipmentId: string;
  feedSizeMm?: number;
  feedSizeLabel?: string;
  issueReasons: LegacyCalibrationIssueReason[];
  candidateFeedIds: string[];
  candidateCount: number;
}
```

Expose `unresolvedFeederCalibrations(equipmentId?: ID): [LegacyFeederCalibrationIssueResponse!]!`
and
`resolveLegacyFeederCalibration(input: ResolveLegacyFeederCalibrationInput!): FeederSetupResponse!`.
They are F4-rollout-only operator surfaces owned by the tracked expand-to-contract rollout, not a
second permanent calibration API.

The unresolved query returns only the current tenant's calibration ID, equipment ID, legacy
identity, issue reasons, candidate feed IDs, and candidate count. Resolution verifies the owning
tenant row and live feed, treats the legacy row as discrete, checks canonical capability
consistency, and mutates that same calibration row. It does not delete and recreate the row.
Resolution, audit, and native v2 outbox message are one transaction.

- [ ] **Step 1: Write and run red remediation tests**

```bash
npx nx test farm-service --runInBand --testPathPatterns='resolve-legacy-feeder-calibration|list-unresolved-feeder-calibrations'
```

Expected RED: unresolved rows cannot be enumerated honestly, cross-tenant IDs are not proven
inaccessible, and there is no atomic same-row repair.

- [ ] **Step 2: Implement the minimal query and command path**

Derive issues from current rows and live feed candidates, not from cached migration output. Use
tenant transaction helpers and manager-bound repositories. Reject a feed belonging to another
tenant, conflicting capability input, and a row that is already canonically resolved.

- [ ] **Step 3: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='legacy-feeder-calibration|feeder-calibration'
npx nx run farm-service:test:integration
npx nx run farm-service:e2e
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
git diff --check
```

Expected GREEN: all four issue reasons, candidate reporting, same-row repair, audit/outbox rollback,
idempotent reread, and cross-tenant denial pass.

- [ ] **Step 4: Review, commit, and push this boundary**

```bash
git add -- \
  apps/farm-service/src/equipment/commands/resolve-legacy-feeder-calibration.command.ts \
  apps/farm-service/src/equipment/handlers/resolve-legacy-feeder-calibration.handler.ts \
  apps/farm-service/src/equipment/queries/list-unresolved-feeder-calibrations.query.ts \
  apps/farm-service/src/equipment/handlers/list-unresolved-feeder-calibrations.handler.ts \
  apps/farm-service/src/equipment/dto/legacy-feeder-calibration-remediation.input.ts \
  apps/farm-service/src/equipment/dto/legacy-feeder-calibration-remediation.response.ts \
  apps/farm-service/src/equipment/equipment.resolver.ts \
  apps/farm-service/src/equipment/equipment.module.ts \
  apps/farm-service/src/common/authz/permission-matrix.ts \
  apps/farm-service/schema.graphql \
  web/shared-ui/src/generated/graphql-types.ts \
  apps/farm-service/src/equipment/__tests__/resolve-legacy-feeder-calibration.handler.spec.ts \
  apps/farm-service/src/equipment/__tests__/list-unresolved-feeder-calibrations.handler.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task9_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: remediate legacy calibration identity' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task9_finding_ids[@]}" -eq 1
[[ "${task9_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): add calibration remediation workflow' \
  'Legacy calibration rows need an explicit operator-owned resolution path before identity can be enforced.' \
  "${task9_finding_ids[0]}")"
git push origin HEAD
```

### Task 10: Publish mass evidence from current ingestion and project it in farm

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Modify: `apps/sensor-service/src/database/entities/sensor-metric.entity.ts`
- Create: `apps/sensor-service/src/ingestion/sensor-mass-event.factory.ts`
- Create: `apps/sensor-service/src/ingestion/__tests__/sensor-mass-event.factory.spec.ts`
- Modify: `apps/sensor-service/src/ingestion/sensor-metric-writer.service.ts`
- Modify: `apps/sensor-service/src/ingestion/__tests__/sensor-metric-writer.service.spec.ts`
- Modify: `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts`
- Modify: `apps/sensor-service/src/ingestion/__tests__/nats-ingestion-consumer.service.spec.ts`
- Modify: `apps/sensor-service/src/ingestion/data-ingestion.service.ts`
- Modify: `apps/sensor-service/src/ingestion/mqtt-listener.service.ts`
- Modify: `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts`
- Modify: `apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts`
- Modify: `apps/sensor-service/src/ingestion/ingestion.module.ts`
- Create: `apps/farm-service/src/events/listeners/sensor-mass-projection.listener.ts`
- Create: `apps/farm-service/src/events/listeners/__tests__/sensor-mass-projection.listener.spec.ts`
- Modify: `apps/farm-service/src/events/listeners/index.ts`
- Modify: `apps/farm-service/src/events/event-listeners.module.ts`
- Create: `apps/farm-service/src/__tests__/e2e/feeder-silo-mass-tenant-isolation.postgres.spec.ts`

**Interfaces:**

```ts
interface SensorMetricInput {
  // existing persisted fields remain unchanged
  measurementKind?: 'mass_kg';
}
```

`measurementKind` is transient ingestion metadata, not a new `sensor_metrics` column. The NATS,
MQTT, data-ingestion, and direct sensor-ingestion paths derive it from existing `SensorDataChannel`
metadata through `massParameterForChannelKey`; they do not infer mass from an arbitrary numeric
value.

`SensorMetricWriterService.writeImmediate` groups inputs by tenant and enters one
`runInTenantTransaction` callback per tenant. `writeManaged` requires the caller's active manager.
Both use the single current `sensor_metrics` writer. After inserting the metric, the writer asks
`sensor-mass-event.factory.ts` for an event and inserts it through `OutboxPublisher` on the same
manager. The factory uses normal `createBaseEvent` identity. Retry dedupe uses
`OutboxPublisher.enqueue(event, manager, { idempotencyKey })`, where the canonical key is derived
from tenant, sensor, channel, and the persisted metric `time` and is protected by the existing
outbox unique index. The event's `observedAt` is that same `time.toISOString()` value. Before a
mass-eligible conflict update, the writer locks and compares the existing metric at that same
observation key. An identical replay leaves metric and outbox truth unchanged; a replay that changes
mass, quality, equipment, or farm identity rejects the tenant transaction instead of letting the
metric diverge from the already immutable outbox payload. Non-mass metrics retain the existing
conflict-update behavior. There is no event-ID override and no direct event bus publish.

Only a metric for which `qualityCategoryOf(input.qualityCode) === QualityCategory.GOOD`, with finite
`0 <= massKg <= 1_000_000` and the `mass_kg` tag, produces `SensorMassObserved`. Preserve the
persisted OPC-UA `0..255` quality code in the event. Telemetry still persists when it is not
eligible evidence. Buffered writes inherit the same writer path; no separate buffer publisher is
added.

The farm projection uses `FeederSiloMassLatest` with tenant and sensor ID as the composite primary
key, plus `massKg` and `measuredAt`. Its pull consumer validates the v1 schema, tenant and entity
UUIDs, finite range, valid `observedAt`, and a maximum five-minute future skew. It performs a
newest-wins upsert in a tenant transaction and rethrows persistence errors for redelivery. An older
event never overwrites newer evidence.

- [ ] **Step 1: Write and run red writer/factory/projection tests**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='sensor-mass-event.factory|sensor-metric-writer|nats-ingestion-consumer|mqtt-listener'
npx nx test farm-service --runInBand --testPathPatterns='sensor-mass-projection.listener.spec.ts'
npx nx run farm-service:e2e --testPathPatterns='feeder-silo-mass-tenant-isolation.postgres.spec.ts'
```

Expected RED: current channel metadata cannot create the separate event, metric/outbox rollback is
not atomic, and farm has no newest-wins tenant projection. A test must explicitly prove that no
retired reading table is queried or written.

- [ ] **Step 2: Implement the minimal mass-event factory and single-writer hook**

Keep event eligibility pure in the factory. Preserve the existing non-mass metric insert semantics
and add the outbox insert after the metric insert on the same manager. Test immediate, managed,
buffered, NATS, MQTT, and direct paths, including identical duplicate evidence, altered same-key
evidence, bad quality, nonfinite values, out-of-range values, and unrelated channels.

- [ ] **Step 3: Implement the minimal farm projection listener**

Register the listener through the existing JetStream pull framework. Use a conditional upsert on
`measured_at`; equal timestamps are idempotent. Do not acknowledge malformed or failed-storage
events as successful.

- [ ] **Step 4: Run green verification**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='sensor-mass|sensor-metric-writer|nats-ingestion-consumer|mqtt-listener'
npx nx test farm-service --runInBand --testPathPatterns='sensor-mass-projection'
npx nx run farm-service:e2e --testPathPatterns='feeder-silo-mass-tenant-isolation.postgres.spec.ts'
npx nx test event-contracts --runInBand
! rg -n 'sensor_readings|SensorReadings' apps/sensor-service/src/ingestion apps/farm-service/src/events/listeners/sensor-mass-projection.listener.ts
git diff --check
```

Expected GREEN: the tests and explicit negative repository search pass. Metric persistence and
outbox insertion commit or roll back together, the canonical idempotency key makes an identical
retry a unique no-op without changing event identity, an altered same-key replay fails, and farm
retains only the newest tenant-owned mass.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
git add -- \
  apps/sensor-service/src/database/entities/sensor-metric.entity.ts \
  apps/sensor-service/src/ingestion/sensor-mass-event.factory.ts \
  apps/sensor-service/src/ingestion/__tests__/sensor-mass-event.factory.spec.ts \
  apps/sensor-service/src/ingestion/sensor-metric-writer.service.ts \
  apps/sensor-service/src/ingestion/__tests__/sensor-metric-writer.service.spec.ts \
  apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts \
  apps/sensor-service/src/ingestion/__tests__/nats-ingestion-consumer.service.spec.ts \
  apps/sensor-service/src/ingestion/data-ingestion.service.ts \
  apps/sensor-service/src/ingestion/mqtt-listener.service.ts \
  apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts \
  apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts \
  apps/sensor-service/src/ingestion/ingestion.module.ts \
  apps/farm-service/src/events/listeners/sensor-mass-projection.listener.ts \
  apps/farm-service/src/events/listeners/__tests__/sensor-mass-projection.listener.spec.ts \
  apps/farm-service/src/events/listeners/index.ts \
  apps/farm-service/src/events/event-listeners.module.ts \
  apps/farm-service/src/__tests__/e2e/feeder-silo-mass-tenant-isolation.postgres.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task10_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: publish and project silo mass evidence' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task10_finding_ids[@]}" -eq 1
[[ "${task10_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): project current silo mass evidence' \
  'Feeding decisions need durable tenant-scoped mass evidence sourced from the current metric ingestion path.' \
  "${task10_finding_ids[0]}")"
git push origin HEAD
```

### Task 11: Derive feeder directives from commissioned physics

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `apps/farm-service/src/feeding-protocol/services/feeder-dose-directive.service.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feeder-dose-directive.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts`
- Create: `apps/farm-service/src/__tests__/e2e/feeder-calibration-physics.postgres.spec.ts`

**Interfaces:**

```ts
type FeederDoseRefusalReason =
  | 'not_commissioned'
  | 'no_calibration_for_feed'
  | 'run_window_unreachable'
  | 'weight_source_silent'
  | 'non_positive_dose';

interface FeederDoseOptions {
  preferredRunMinutes?: number;
  now?: Date;
}

interface FeederDoseDirectiveBase {
  feederEquipmentId: string;
  feederName: string;
  feederCode: string;
  feedId: string;
  requestedGrams: number;
}

interface ContinuousRunDirective extends FeederDoseDirectiveBase {
  kind: 'continuous_run';
  dispenseControl: 'time_based' | 'weight_based';
  speedHz: number;
  runSeconds: number;
  gramsPerMinuteAtSpeed: number;
  deliveredGrams: number;
}

interface DiscreteShotDirective extends FeederDoseDirectiveBase {
  kind: 'discrete_shots';
  dispenseControl: 'time_based' | 'weight_based';
  dispensings: number;
  gramsPerDispensing: number;
  deliveredGrams: number;
}

interface FeederDoseRefusal extends FeederDoseDirectiveBase {
  kind: 'refused';
  reason: FeederDoseRefusalReason;
  detail: string;
  reachableRunMinutes?: { min: number; max: number };
}

type FeederDoseDirective = ContinuousRunDirective | DiscreteShotDirective | FeederDoseRefusal;

interface ContinuousFlowCalibration {
  gramsPerMinute: number;
  referenceSpeedHz: number;
  minSpeedHz: number;
  maxSpeedHz: number;
}

interface ContinuousRunSolution {
  kind: 'reachable';
  speedHz: number;
  runSeconds: number;
  gramsPerMinuteAtSpeed: number;
  deliveredGrams: number;
}

interface ContinuousRunUnreachable {
  kind: 'unreachable';
  reachableRunMinutes: { min: number; max: number };
}

interface DiscreteShotSolution {
  dispensings: number;
  gramsPerDispensing: number;
  deliveredGrams: number;
}

function continuousFlowGramsPerMinute(
  calibration: ContinuousFlowCalibration,
  speedHz: number,
): number;
function solveContinuousRun(
  calibration: ContinuousFlowCalibration,
  doseGrams: number,
  preferredRunMinutes?: number,
): ContinuousRunSolution | ContinuousRunUnreachable;
function solveDiscreteShots(gramsPerDispensing: number, doseGrams: number): DiscreteShotSolution;

class FeederDoseDirectiveService {
  planUnitDoseForBand(
    tenantId: string,
    unitId: string,
    band: Pick<ProtocolBand, 'feedId'>,
    totalKg: number,
    options?: FeederDoseOptions,
  ): Promise<FeederDoseDirective[]>;
  planFeederDose(
    tenantId: string,
    feederEquipmentId: string,
    feedId: string,
    doseKg: number,
    options?: FeederDoseOptions,
  ): Promise<FeederDoseDirective>;
}

class FeederDoseSplitService {
  getActiveFeedersWithManager(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
  ): Promise<FeederDoseShare[]>;
  splitDailyDoseWithManager(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    totalKg: number,
  ): Promise<FeederDoseAllocation[]>;
}
```

Every planning failure is a typed `FeederDoseRefusal`, not a success-shaped directive. Reads use one
`runInTenantRead` scope and manager-bound repositories. `planUnitDoseForBand` passes that scope's
`EntityManager` to the F1b authority
`FeederDoseSplitService.getActiveFeedersWithManager(manager, tenantId, unitId)`, then allocates the
exact configured percentages and the band's feed. It never calls the convenience method that opens
another tenant read, and it never duplicates assignment SQL. Incomplete or invalid assignment truth
is refused rather than guessed. Any refusal makes the returned set non-executable as a whole; this
service does not partially actuate it.

For continuous feeders, `flowAtSpeed = gramsPerMinute * speedHz / referenceSpeedHz` through the
origin. Both reference and calibration speed must be inside the commissioned min/max band. Without a
preferred duration the solver uses the measured reference speed. With `preferredRunMinutes`, it
solves the required speed and returns `run_window_unreachable` plus reachable min/max durations when
that speed is outside the band. Commanded speed is quantized to 0.01 Hz, duration to positive whole
seconds, and delivered grams are recomputed after both quantizations. It never clamps or
extrapolates outside the band.

For discrete feeders, every positive dose uses `Math.ceil(requestedGrams / gramsPerDispensing)`. The
directive reports the actual delivered grams, so a positive dose never becomes zero shots.
Weight-based control requires a latest mass reading no older than 30 minutes at `options.now`;
missing or stale evidence refuses with `weight_source_silent`. This service creates directives only
and never invokes VFD or edge transport.

The pure solvers throw `RangeError` for nonfinite or nonpositive dose/calibration values and for an
invalid speed band. `unreachable` is reserved for valid physics whose requested duration requires a
speed outside the commissioned band; the service maps input failures to the named refusal union.

- [ ] **Step 1: Write and run red pure-physics and PostgreSQL tests**

```bash
npx nx test farm-service --runInBand --testPathPatterns='feeder-dose-directive.spec.ts'
npx nx run farm-service:e2e --testPathPatterns='feeder-calibration-physics.postgres.spec.ts'
```

Expected RED: calibration-backed directives, proportional flow, ceiling shots, quantized delivery,
stale-weight refusal, assignment allocation, and cross-tenant isolation are absent.

- [ ] **Step 2: Implement pure solvers, then tenant-backed planning**

Keep numeric solvers free of repositories and clocks. Inject `now` through options for deterministic
tests. The service queries capability, matching feed calibration, latest mass, and assignments in
one tenant read. Pass that read manager to `getActiveFeedersWithManager`; a test must fail if the
directive service invokes nested `runInTenantRead`, calls the convenience reader, or issues its own
assignment query. Return a typed refusal for every non-ready allocation and require callers to
reject the whole set when any member is refused.

- [ ] **Step 3: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='feeder-dose-directive'
npx nx run farm-service:e2e --testPathPatterns='feeder-calibration-physics.postgres.spec.ts'
npx nx run farm-service:test:integration
npx nx test farm-service --runInBand
git diff --check
```

Expected GREEN: boundary speeds, invalid bands, tiny positive doses, unreachable windows, stale and
fresh mass, one/multiple feeder shares, no calibration, no commissioning, and two-tenant cases pass;
transport mocks remain untouched.

- [ ] **Step 4: Review, commit, and push this boundary**

```bash
git add -- apps/farm-service/src/feeding-protocol/services/feeder-dose-directive.service.ts apps/farm-service/src/feeding-protocol/__tests__/feeder-dose-directive.spec.ts apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts apps/farm-service/src/__tests__/e2e/feeder-calibration-physics.postgres.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task11_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: derive commissioned feeder directives' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task11_finding_ids[@]}" -eq 1
[[ "${task11_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): derive feeder actuation physics' \
  'Commissioned feeder directives must be derived atomically from authoritative assignment and calibration state.' \
  "${task11_finding_ids[0]}")"
git push origin HEAD
```

### Task 12: Migrate the farm calibration client to generated contracts

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `web/modules/farm-module/src/graphql/feeder-calibration.operations.ts`
- Modify: `web/modules/farm-module/src/graphql/index.ts`
- Create: `web/modules/farm-module/src/generated/feeder-calibration.graphql.ts` through codegen
- Modify: `codegen.ts`
- Modify: `web/modules/farm-module/src/hooks/useFeederCalibration.ts`
- Modify: `web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts`
- Create: `web/modules/farm-module/src/hooks/__tests__/useFeederCalibration.spec.tsx`
- Create: `web/modules/farm-module/src/hooks/__tests__/useFarmRealtimeStream.feeder-setup.spec.ts`
- Modify: `web/modules/farm-module/src/pages/setup/components/FeederCalibrationSection.tsx`
- Create:
  `web/modules/farm-module/src/pages/setup/components/__tests__/FeederCalibrationSection.spec.tsx`
- Modify: `web/modules/farm-module/src/pages/setup/tabs/EquipmentTab.tsx`

**Interfaces:**

`feeder-calibration.operations.ts` is the sole operation-document source. The existing
`useFeederCalibration.ts` exports query and save hooks typed from the dedicated generated output.
The existing `FeederCalibrationSection` consumes those hooks. The existing
`useFarmRealtimeStream.ts` maps `feederCalibrationsSaved` to the canonical `feederSetup` query key
for the event equipment ID. No second hook, component, event interface, or query-key authority is
created.

`codegen.ts` adds a disjoint output for only the feeder-calibration documents. Operations query
`feederSetup`, list live feeds and eligible mass sensors, and call `saveFeederSetup` with the exact
XOR setup input. The hook and section import generated document nodes and generated types only. The
shared realtime hook consumes the upcast v2 websocket payload and invalidates the setup query by
equipment ID; it does not define a second event interface inline.

The UI uses feed IDs, makes discrete versus continuous explicit, shows continuous speed band,
selects time- or weight-based control, requires a weight sensor when needed, and displays silo
capacity. It cannot submit both calibration modes or an uncommissioned row.

- [ ] **Step 1: Write and run the red hook/component tests**

```bash
npm --prefix web/modules/farm-module test -- src/hooks/__tests__/useFeederCalibration.spec.tsx src/hooks/__tests__/useFarmRealtimeStream.feeder-setup.spec.ts src/pages/setup/components/__tests__/FeederCalibrationSection.spec.tsx
```

Expected RED: the generated operation surface, disjoint codegen target, and client behavior do not
exist.

- [ ] **Step 2: Add operations and generate the client**

```bash
npm run schema:generate
npm run apollo-router:compose
npm run codegen
```

Inspect the generated file and remove any handwritten duplicate from the hook or component. Do not
edit generated output manually.

- [ ] **Step 3: Implement the minimal hook, realtime invalidation, and section**

Render loading, load failure, empty setup, validation errors, save progress, and save failure.
Preserve unsaved input when a save fails. Use generated enum/input names and map form state at one
explicit boundary.

- [ ] **Step 4: Run green verification**

```bash
npm --prefix web/modules/farm-module test -- src/hooks/__tests__/useFeederCalibration.spec.tsx src/hooks/__tests__/useFarmRealtimeStream.feeder-setup.spec.ts src/pages/setup/components/__tests__/FeederCalibrationSection.spec.tsx
npx nx test farm-module
npm run codegen
npm run codegen:check
npx nx lint farm-module
npx nx build farm-module
git diff --check
```

Expected GREEN: discrete and continuous saves, weight-sensor rule, v2 invalidation, failures, and
generated-contract drift tests pass.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
git add -- codegen.ts web/modules/farm-module/src/graphql/feeder-calibration.operations.ts web/modules/farm-module/src/graphql/index.ts web/modules/farm-module/src/generated/feeder-calibration.graphql.ts web/modules/farm-module/src/hooks/useFeederCalibration.ts web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts web/modules/farm-module/src/hooks/__tests__/useFeederCalibration.spec.tsx web/modules/farm-module/src/hooks/__tests__/useFarmRealtimeStream.feeder-setup.spec.ts web/modules/farm-module/src/pages/setup/components/FeederCalibrationSection.tsx web/modules/farm-module/src/pages/setup/components/__tests__/FeederCalibrationSection.spec.tsx web/modules/farm-module/src/pages/setup/tabs/EquipmentTab.tsx
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task12_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: migrate the generated setup client' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task12_finding_ids[@]}" -eq 1
[[ "${task12_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm-web): migrate feeder setup client' \
  'The setup surface must consume the composed canonical calibration contract before legacy fields can be removed.' \
  "${task12_finding_ids[0]}")"
git push origin HEAD
```

### Task 13: Enforce canonical calibration identity after zero-issue evidence

**Gate:** Keep the one F4 branch and worktree open after Task 12. Its exact pushed Task 12 commit,
which contains the Task 8 runtime and Task 9 remediation API, is deployed through the repository
workflow to the required staged fleet. The unresolved query returns zero rows for every tenant on
two consecutive runs separated by a normal ingestion interval. Capability, feed, sensor, and
calibration parity reports are attached to that workflow evidence. Pause in the same worktree on any
nonzero or unclassified row; do not merge, reconcile, or create another branch.

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Generated output contract: exactly one newly added
  `apps/farm-service/src/database/migrations/[0-9]+-EnforceFeederCalibrationPhysics.ts`, resolved
  and count-checked with its sole exported class by Task 13 Step 2 before editing, manifest
  registration, or staging
- Create:
  `apps/farm-service/src/database/migrations/__tests__/enforce-feeder-calibration-physics.migration.spec.ts`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Modify: `apps/farm-service/src/equipment/entities/feeder-calibration.entity.ts`

**Interfaces:**

This is a contract-phase migration node importing the class exported by the one tracked
`ExpandFeederCalibrationPhysics` migration and setting
`dependsOn: ExpandFeederCalibrationPhysics.name`. Its preflight interface is zero unresolved rows
per tenant; its postcondition is the canonical FK, XOR, positive-value, weight-control, and
uniqueness constraint set. The test resolves the dependency class, decorator string, and migration
manifest order by suffix.

The migration repeats the zero-issue query inside each tenant schema, then enforces non-null
`feed_id` and `dosing_mode`, tenant-valid foreign keys, discrete/continuous XOR checks, positive
numeric checks, weight-control sensor checks, one canonical capability per feeder, and uniqueness
for tenant/equipment/feed. Legacy columns remain for the final client rollout. The contract marker
uses the actual Task 8 expand class's `.name`. Entity metadata makes only `feedId` and `dosingMode`
unconditionally required; mode-specific physics and constraint-carrier fields retain the nullability
required by their database XOR.

- [ ] **Step 1: Verify the exact staged predecessor on the canonical F4 branch and run the red
      migration test**

Use `apply_patch` to create the named migration test before changing entity metadata. Make it
discover both suffixes and fail explicitly when the enforce suffix count is zero.

```bash
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test "$(git branch --show-current)" = feat/feeding-f4-calibration-physics
test "$(git rev-parse --show-toplevel)" = /var/aqua-saas/.worktrees/aquamobil-v4-f4
F4_RUNTIME_CANDIDATE_SHA="$(git rev-parse HEAD)"
[[ "$F4_RUNTIME_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git ls-remote --heads origin refs/heads/feat/feeding-f4-calibration-physics | awk '{print $1}')" = \
  "$F4_RUNTIME_CANDIDATE_SHA"
test -z "$(git status --porcelain)"
npx nx test farm-service --runInBand --testPathPatterns='enforce-feeder-calibration-physics.migration.spec.ts'
```

Expected RED: no enforce migration exists, canonical identity metadata remains transitional, and the
required constraints cannot be proven.

- [ ] **Step 2: Change canonical metadata, then generate the migration**

Make `feedId` and `dosingMode` non-null in entity metadata before invoking TypeORM. Keep conditional
fields nullable. Then run:

```bash
(cd apps/farm-service && npx typeorm-ts-node-commonjs migration:generate src/database/migrations/EnforceFeederCalibrationPhysics -d src/database/data-source.ts)
mapfile -t feeder_enforce_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-EnforceFeederCalibrationPhysics\.ts$')
test "${#feeder_enforce_generated_files[@]}" -eq 1
mapfile -t feeder_enforce_generated_classes < <(rg -o 'export class [A-Za-z0-9_]+' "${feeder_enforce_generated_files[0]}")
test "${#feeder_enforce_generated_classes[@]}" -eq 1
feeder_enforce_generated_class="${feeder_enforce_generated_classes[0]##* }"
printf 'migration=%s class=%s\n' "${feeder_enforce_generated_files[0]}" "$feeder_enforce_generated_class"
mapfile -t feeder_expand_files < <(git ls-files 'apps/farm-service/src/database/migrations/*-ExpandFeederCalibrationPhysics.ts')
test "${#feeder_expand_files[@]}" -eq 1
feeder_expand_class="$(rg -o 'export class [A-Za-z0-9_]+' "${feeder_expand_files[0]}" | awk '{print $3}')"
test -n "$feeder_expand_class"
printf '%s\n' "$feeder_expand_class"
```

Expected: exactly one generated suffix and one exported class are printed; the predecessor suffix
also resolves exactly once.

- [ ] **Step 3: Implement the minimal enforce migration and manifest entry**

Import the class printed in Step 2 and use its `.name` as the single string `dependsOn` value. Make
the test discover and compare the metadata rather than storing a copied class-name string. Name
every constraint deterministically, make preflight failure actionable by tenant and issue reason,
and provide a tested `down` that relaxes only these enforcement constraints.

- [ ] **Step 4: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='enforce-feeder-calibration-physics|feeder-calibration'
npx nx run farm-service:e2e
npm run gates:migration-sql
npm run schema:generate
npm run apollo-router:compose
git diff --check
```

Expected GREEN: canonical fixtures migrate, every unresolved class aborts before DDL, constraints
reject invalid direct SQL, down/up rehearsal passes, and the manifest is complete.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
mapfile -t feeder_enforce_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-EnforceFeederCalibrationPhysics\.ts$')
test "${#feeder_enforce_generated_files[@]}" -eq 1
git add -- "${feeder_enforce_generated_files[0]}" \
  apps/farm-service/src/database/migrations/__tests__/enforce-feeder-calibration-physics.migration.spec.ts \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/src/equipment/entities/feeder-calibration.entity.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task13_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: enforce canonical calibration identity' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task13_finding_ids[@]}" -eq 1
[[ "${task13_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): enforce feeder calibration integrity' \
  'Canonical calibration identity can become mandatory only after remediation proves every live row is resolvable.' \
  "${task13_finding_ids[0]}")"
git push origin HEAD
```

Push and deploy the exact Task 13 commit through the same F4 workflow before Task 14. It remains an
ordered internal F4 gate, not a second protected boundary.

### Task 14: Contract the legacy calibration API and columns

**Gate:** The exact pushed Task 13 commit on the same F4 branch is deployed; farm-module and every
other generated client are deployed on both `feederSetup` and `saveFeederSetup`; websocket consumers
accept v2; repository search and runtime telemetry show no caller of `feederCalibrations` or
`saveFeederCalibrations`, and the Task 9 remediation ledger is closed with no caller of its
operator-only query or mutation. No reader uses `feed_size_mm`, `feed_size_label`, or row-level
`silo_capacity_kg`. The v1 validator and upcaster remain tested. Pause if any legacy caller or
reader remains.

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Modify: `apps/farm-service/src/equipment/equipment.resolver.ts`
- Modify: `apps/farm-service/src/equipment/equipment.module.ts`
- Modify: `apps/farm-service/src/common/authz/permission-matrix.ts`
- Modify: `apps/farm-service/src/equipment/__tests__/equipment.resolver.spec.ts`
- Modify: `apps/farm-service/src/equipment/entities/feeder-calibration.entity.ts`
- Delete: `apps/farm-service/src/equipment/dto/feeder-calibration.input.ts`
- Delete: `apps/farm-service/src/equipment/dto/feeder-calibration.response.ts`
- Delete: `apps/farm-service/src/equipment/commands/save-feeder-calibrations.command.ts`
- Delete: `apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts`
- Delete: `apps/farm-service/src/equipment/queries/list-feeder-calibrations.query.ts`
- Delete: `apps/farm-service/src/equipment/handlers/list-feeder-calibrations.handler.ts`
- Delete: `apps/farm-service/src/equipment/__tests__/list-feeder-calibrations.handler.spec.ts`
- Delete: `apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.event-version.spec.ts`
- Delete: `apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.legacy-compat.spec.ts`
- Delete: `apps/farm-service/src/equipment/commands/resolve-legacy-feeder-calibration.command.ts`
- Delete: `apps/farm-service/src/equipment/handlers/resolve-legacy-feeder-calibration.handler.ts`
- Delete: `apps/farm-service/src/equipment/queries/list-unresolved-feeder-calibrations.query.ts`
- Delete: `apps/farm-service/src/equipment/handlers/list-unresolved-feeder-calibrations.handler.ts`
- Delete: `apps/farm-service/src/equipment/dto/legacy-feeder-calibration-remediation.input.ts`
- Delete: `apps/farm-service/src/equipment/dto/legacy-feeder-calibration-remediation.response.ts`
- Delete:
  `apps/farm-service/src/equipment/__tests__/resolve-legacy-feeder-calibration.handler.spec.ts`
- Delete:
  `apps/farm-service/src/equipment/__tests__/list-unresolved-feeder-calibrations.handler.spec.ts`
- Modify: `apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts`
- Generated output contract: exactly one newly added
  `apps/farm-service/src/database/migrations/[0-9]+-ContractLegacyFeederCalibrationColumns.ts`,
  resolved and count-checked with its sole exported class by Task 14 Step 2 before editing, manifest
  registration, or staging
- Create:
  `apps/farm-service/src/database/migrations/__tests__/contract-legacy-feeder-calibration-columns.migration.spec.ts`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Regenerate: `apps/farm-service/schema.graphql`
- Regenerate: `web/shared-ui/src/generated/graphql-types.ts`
- Regenerate: `web/modules/farm-module/src/generated/feeder-calibration.graphql.ts`

**Interfaces:**

The composed GraphQL contract removes `Query.feederCalibrations`, `Mutation.saveFeederCalibrations`,
`FeederCalibrationResponse`, and `SaveFeederCalibrationsInput`. Because its zero-issue gate has been
satisfied, it also removes `Query.unresolvedFeederCalibrations`,
`Mutation.resolveLegacyFeederCalibration`, and their operator-only input and response types. It
retains `Query.feederSetup`, `Mutation.saveFeederSetup`, `FeederSetupResponse`,
`FeederSetupCalibrationResponse`, and `SaveFeederSetupInput` exactly as introduced in Task 8. Their
canonical `feedId` and `dosingMode` fields are already non-null; the contract phase does not
redefine their nullability. The database contract drops only `feed_size_mm`, `feed_size_label`, and
row-level `silo_capacity_kg`; nullable-by-mode `grams_per_dispensing` remains canonical discrete
physics.

Delete the unreachable legacy and remediation DTOs, commands, queries, handlers, tests, module
registrations, resolver methods, and permission entries. Update the tenant-isolation suite to
exercise only the canonical setup command. Keep the version 1 event schema validator and v1-to-v2
upcaster permanently, with their event-contract tests unchanged. The migration is a contract-phase
node importing the immediate `EnforceFeederCalibrationPhysics` predecessor and setting
`dependsOn: EnforceFeederCalibrationPhysics.name`. That predecessor already depends on
`ExpandFeederCalibrationPhysics.name`, so the decorator chain is transitive and each node has the
one string dependency supported by `ExpandContract`.

The migration test resolves Task 8's expand class and Task 13's enforce class by suffix to prove the
complete expand-to-enforce-to-contract chain and manifest order. The migration's `down` recreates
nullable legacy columns, derives size only from the referenced live feed when available, copies
capacity from capability, and leaves a noncanonical label null rather than inventing history.
Rolling back storage does not reintroduce the removed GraphQL API.

- [ ] **Step 1: Verify the exact enforcement predecessor on the canonical F4 branch and run red
      API/migration tests**

Use `apply_patch` to strengthen the resolver, module-registration, and e2e assertions and create the
named migration test before changing production metadata. The migration test discovers the expand
and enforce files but must fail explicitly because the contract suffix does not exist yet.

```bash
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test "$(git branch --show-current)" = feat/feeding-f4-calibration-physics
test "$(git rev-parse --show-toplevel)" = /var/aqua-saas/.worktrees/aquamobil-v4-f4
F4_ENFORCEMENT_CANDIDATE_SHA="$(git rev-parse HEAD)"
[[ "$F4_ENFORCEMENT_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git ls-remote --heads origin refs/heads/feat/feeding-f4-calibration-physics | awk '{print $1}')" = \
  "$F4_ENFORCEMENT_CANDIDATE_SHA"
test -z "$(git status --porcelain)"
npx nx test farm-service --runInBand --testPathPatterns='contract-legacy-feeder-calibration-columns|equipment.resolver|feeder-calibration'
npx nx run farm-service:e2e --testPathPatterns='site-tenant-isolation.postgres.spec.ts'
```

Expected RED: both legacy GraphQL operations, the completed remediation operations, their handler
registrations, and the legacy entity columns still exist, and no contract migration proves their
safe removal.

- [ ] **Step 2: Remove legacy metadata, then generate the contract migration**

Remove the legacy and remediation resolver methods and permission entries, delete their unreachable
implementation files and module registrations, update e2e imports and cases to the canonical setup
command, and remove only `feedSizeMm`, `feedSizeLabel`, and row-level `siloCapacityKg` from entity
metadata. Do not change the Task 8 canonical DTOs or historical event contracts. Then run:

```bash
(cd apps/farm-service && npx typeorm-ts-node-commonjs migration:generate src/database/migrations/ContractLegacyFeederCalibrationColumns -d src/database/data-source.ts)
mapfile -t feeder_contract_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-ContractLegacyFeederCalibrationColumns\.ts$')
test "${#feeder_contract_generated_files[@]}" -eq 1
mapfile -t feeder_contract_generated_classes < <(rg -o 'export class [A-Za-z0-9_]+' "${feeder_contract_generated_files[0]}")
test "${#feeder_contract_generated_classes[@]}" -eq 1
feeder_contract_generated_class="${feeder_contract_generated_classes[0]##* }"
printf 'migration=%s class=%s\n' "${feeder_contract_generated_files[0]}" "$feeder_contract_generated_class"
mapfile -t feeder_expand_files < <(git ls-files 'apps/farm-service/src/database/migrations/*-ExpandFeederCalibrationPhysics.ts')
mapfile -t feeder_enforce_files < <(git ls-files 'apps/farm-service/src/database/migrations/*-EnforceFeederCalibrationPhysics.ts')
test "${#feeder_expand_files[@]}" -eq 1
test "${#feeder_enforce_files[@]}" -eq 1
feeder_expand_class="$(rg -o 'export class [A-Za-z0-9_]+' "${feeder_expand_files[0]}" | awk '{print $3}')"
feeder_enforce_class="$(rg -o 'export class [A-Za-z0-9_]+' "${feeder_enforce_files[0]}" | awk '{print $3}')"
test -n "$feeder_expand_class"
test -n "$feeder_enforce_class"
printf '%s\n' "$feeder_expand_class" "$feeder_enforce_class"
```

Expected: the new suffix and each predecessor resolve exactly once, and the generated class is
printed without a predicted timestamp.

- [ ] **Step 3: Implement the minimal database contract and regenerate consumers**

Implement guarded up/down DDL and import the two predecessor class symbols printed in Step 2. Use
only the enforce class's `.name` as this migration's string `dependsOn`; use the expand class to
assert the transitive predecessor metadata and manifest order. Regenerate the schema and clients.
Confirm generated output contains only the canonical setup query and mutation. Do not remove
historical event validators or the upcaster.

- [ ] **Step 4: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='feeder-setup|equipment.resolver|contract-legacy-feeder-calibration-columns'
npx nx run farm-service:e2e --testPathPatterns='site-tenant-isolation.postgres.spec.ts'
npx nx test event-contracts --runInBand
npm run gates:migration-sql
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
npx nx build farm-module
git diff --check
```

Expected GREEN: only `feederSetup` and `saveFeederSetup` are exposed, no legacy handler is
registered or reachable, no zero-purpose remediation resolver remains, canonical storage survives
up/down rehearsal, current clients compile, and v1 events still validate and upcast exactly to v2.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
mapfile -t feeder_contract_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-ContractLegacyFeederCalibrationColumns\.ts$')
test "${#feeder_contract_generated_files[@]}" -eq 1
git add -- "${feeder_contract_generated_files[0]}" \
  apps/farm-service/src/equipment/equipment.resolver.ts \
  apps/farm-service/src/equipment/equipment.module.ts \
  apps/farm-service/src/common/authz/permission-matrix.ts \
  apps/farm-service/src/equipment/__tests__/equipment.resolver.spec.ts \
  apps/farm-service/src/equipment/entities/feeder-calibration.entity.ts \
  apps/farm-service/src/equipment/dto/feeder-calibration.input.ts \
  apps/farm-service/src/equipment/dto/feeder-calibration.response.ts \
  apps/farm-service/src/equipment/commands/save-feeder-calibrations.command.ts \
  apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts \
  apps/farm-service/src/equipment/queries/list-feeder-calibrations.query.ts \
  apps/farm-service/src/equipment/handlers/list-feeder-calibrations.handler.ts \
  apps/farm-service/src/equipment/__tests__/list-feeder-calibrations.handler.spec.ts \
  apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.event-version.spec.ts \
  apps/farm-service/src/equipment/__tests__/save-feeder-calibrations.legacy-compat.spec.ts \
  apps/farm-service/src/equipment/commands/resolve-legacy-feeder-calibration.command.ts \
  apps/farm-service/src/equipment/handlers/resolve-legacy-feeder-calibration.handler.ts \
  apps/farm-service/src/equipment/queries/list-unresolved-feeder-calibrations.query.ts \
  apps/farm-service/src/equipment/handlers/list-unresolved-feeder-calibrations.handler.ts \
  apps/farm-service/src/equipment/dto/legacy-feeder-calibration-remediation.input.ts \
  apps/farm-service/src/equipment/dto/legacy-feeder-calibration-remediation.response.ts \
  apps/farm-service/src/equipment/__tests__/resolve-legacy-feeder-calibration.handler.spec.ts \
  apps/farm-service/src/equipment/__tests__/list-unresolved-feeder-calibrations.handler.spec.ts \
  apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts \
  apps/farm-service/src/database/migrations/__tests__/contract-legacy-feeder-calibration-columns.migration.spec.ts \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/schema.graphql \
  web/shared-ui/src/generated/graphql-types.ts \
  web/modules/farm-module/src/generated/feeder-calibration.graphql.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task14_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding physics: contract retired calibration surfaces' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task14_finding_ids[@]}" -eq 1
[[ "${task14_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nBREAKING CHANGE: %s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): contract legacy feeder calibration identity' \
  'Retired calibration surfaces must be removed after generated consumers and enforced canonical identity are deployed.' \
  'Remove the legacy and remediation calibration APIs, their handlers, and the retired storage columns.' \
  "${task14_finding_ids[0]}")"
git push origin HEAD
```

Task 14 is the final commit in the one F4 implementation boundary. Rerun the four-audit,
audit/explain-set, production Vite/Rollup manifest, mapper, immutable-preflight check, and direct
ledger-verifier sequence from **Canonical Coordinator and Slice Preflight** into
`artifacts/aquamobil-v4/F4/dependency-final`; do not rewrite the preflight. Verify the one protected
F4 PR through the coordinator, merge it, and let only the program's fresh F4 reconciliation branch
capture `calibration-physics` and regenerate the ledger. F5 cannot start until that reconciliation's
exact protected-main commit is proven by its slice-entry checkpoint.

---

## F5 — Feeding-Loop Completion

### Task 15: Persist a branded day-plan ration basis

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `docs/superpowers/evidence/aquamobil-v4/slices/F5/preflight.json` through the program
  capture tool
- Create: `apps/farm-service/src/feeding-protocol/services/ration-basis.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/ration-basis.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/meal-plan-generator.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/meal-plan-generator.service.spec.ts`
- Generated output contract: exactly one newly added
  `apps/farm-service/src/database/migrations/[0-9]+-ExpandDayPlanRationBasis.ts`, resolved and
  count-checked with its sole exported class by Task 15 Step 3 before editing, manifest
  registration, or staging
- Create:
  `apps/farm-service/src/database/migrations/__tests__/expand-day-plan-ration-basis.migration.spec.ts`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`

**Interfaces:**

```ts
type RationBasisKg = number & { readonly __brand: 'RationBasisKg' };

function initialRationBasisKg(startOfDayBiomassKg: number): RationBasisKg;
function shiftRationBasisKg(basis: RationBasisKg, stockBiomassDeltaKg: number): RationBasisKg;
function measuredRationBasisKg(measuredBiomassKg: number): RationBasisKg;
function dayPlanRationBasisKg(plan: FeedingDayPlan): RationBasisKg;
function dailyRationKg(basis: RationBasisKg, effectiveRatePercent: number): number;
```

`initialRationBasisKg` and `measuredRationBasisKg` reject negative or nonfinite values.
`shiftRationBasisKg` requires a finite signed delta and returns
`round3(Math.max(0, basis + stockBiomassDeltaKg))`. `dailyRationKg` rejects a negative or nonfinite
rate and returns a three-decimal kilogram value. It accepts the brand, never an unclassified live
biomass number.

Add nullable `numeric(12,3)` `rationBasisKg` through the existing decimal transformer in the expand
migration, then backfill each existing row from its exact `snapshot.biomassKg`. Preflight rejects a
missing, nonnumeric, negative, or nonfinite snapshot basis; postflight proves row-count parity and
no nulls in each tenant schema. The entity is transitionally nullable for rollback compatibility.
Every new computed and persisted plan writes `initialRationBasisKg(stock.biomassKg)`, and
`plannedTotalKg` is computed through `dailyRationKg`.

- [ ] **Step 1: Verify the coordinator-created F5 boundary, then write and run red nominal-math and
      migration tests**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
test "$(git branch --show-current)" = feat/feeding-f5-loop-completion
test "$(git rev-parse --show-toplevel)" = /var/aqua-saas/.worktrees/aquamobil-v4-f5
test "$(git rev-parse HEAD)" = \
  "$(jq -r '.baseMainCommit' docs/superpowers/evidence/aquamobil-v4/slices/F5/preflight.json)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice F5 \
  --check docs/superpowers/evidence/aquamobil-v4/slices/F5/preflight.json \
  --main-ref origin/main
npx nx test farm-service --runInBand --testPathPatterns='ration-basis.spec.ts|meal-plan-generator.service.spec.ts|expand-day-plan-ration-basis.migration.spec.ts'
```

Expected RED: a bare live biomass can still price a day, new plans do not persist a basis, and old
plans have no guarded snapshot backfill.

- [ ] **Step 2: Add the transitional entity field and pure branded math**

Add nullable `numeric(12,3)` entity metadata, then implement the five exact functions above with the
named rejection, clamping, and rounding rules. Re-run `ration-basis.spec.ts` and confirm the pure
cases pass while migration and plan-generation assertions remain red.

- [ ] **Step 3: Generate and implement the expand migration**

```bash
(cd apps/farm-service && npx typeorm-ts-node-commonjs migration:generate src/database/migrations/ExpandDayPlanRationBasis -d src/database/data-source.ts)
mapfile -t ration_expand_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-ExpandDayPlanRationBasis\.ts$')
test "${#ration_expand_generated_files[@]}" -eq 1
mapfile -t ration_expand_generated_classes < <(rg -o 'export class [A-Za-z0-9_]+' "${ration_expand_generated_files[0]}")
test "${#ration_expand_generated_classes[@]}" -eq 1
ration_expand_generated_class="${ration_expand_generated_classes[0]##* }"
printf 'migration=%s class=%s\n' "${ration_expand_generated_files[0]}" "$ration_expand_generated_class"
```

Implement per-schema preflight, nullable add, exact JSON snapshot backfill, postflight, RLS
preservation, reversible drop, expand marker, and manifest registration using the actual generated
class.

- [ ] **Step 4: Implement the minimal generation writes**

Keep `snapshot.biomassKg` as historical generation evidence and persist the equal initial basis
beside it. Do not replace the stock reader or transition behavior in this task.

- [ ] **Step 5: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='ration-basis|meal-plan-generator|expand-day-plan-ration-basis'
npx nx run farm-service:e2e
npm run gates:migration-sql
git diff --check
```

Expected GREEN: brand constructors, initial pricing, fasting plans, idempotent plan insert, exact
backfill, unsafe snapshot rejection, and down/up rehearsal pass.

- [ ] **Step 6: Review, commit, and push this boundary**

```bash
mapfile -t ration_expand_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-ExpandDayPlanRationBasis\.ts$')
test "${#ration_expand_generated_files[@]}" -eq 1
git add -- "${ration_expand_generated_files[0]}" \
  docs/superpowers/evidence/aquamobil-v4/slices/F5/preflight.json \
  apps/farm-service/src/feeding-protocol/services/ration-basis.ts \
  apps/farm-service/src/feeding-protocol/__tests__/ration-basis.spec.ts \
  apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts \
  apps/farm-service/src/feeding-protocol/services/meal-plan-generator.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/meal-plan-generator.service.spec.ts \
  apps/farm-service/src/database/migrations/__tests__/expand-day-plan-ration-basis.migration.spec.ts \
  apps/farm-service/src/database/migrations/manifest.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task15_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding loop: persist day-plan ration basis' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task15_finding_ids[@]}" -eq 1
[[ "${task15_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): persist day-plan ration basis' \
  'Day plans need a durable ration basis so later stock and measurement changes can be recalculated deterministically.' \
  "${task15_finding_ids[0]}")"
git push -u origin HEAD
```

### Task 16: Unify transition decisions and ration recalculation

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `apps/farm-service/src/batch/services/unit-ration-recalculator.port.ts`
- Create: `apps/farm-service/src/feeding-protocol/services/feed-transition.service.ts`
- Create: `apps/farm-service/src/feeding-protocol/__tests__/feed-transition-one-mechanism.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/day-plan-recalc.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/meal-plan-generator.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/meal-plan-generator.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/day-plan-admin.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/day-plan-admin.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts`
- Modify: `apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts`

**Interfaces:**

```ts
type StockChangeReason =
  | 'allocation'
  | 'mortality'
  | 'cull'
  | 'transfer'
  | 'harvest'
  | 'harvest_reversal'
  | 'count_reconcile';

type RecalcTrigger =
  | {
      kind: 'stock_change';
      reason: StockChangeReason;
      stockBiomassDeltaKg: number;
    }
  | {
      kind: 'measurement';
      reason: 'weighing';
      measuredBiomassKg: number;
    }
  | {
      kind: 'rate_only';
      reason: 'temperature';
      newTemperatureC: number;
    }
  | {
      kind: 'rate_only';
      reason:
        | 'grading'
        | 'protocol_change'
        | 'assignment_change'
        | 'unplanned_feed'
        | 'meal_growth'
        | 'pour_correction'
        | 'manual_regenerate';
    };

interface UnitRationRecalculator {
  recalcAfterStockChange(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    reason: StockChangeReason,
    stockBiomassDeltaKg: number,
  ): Promise<void>;
}

interface BandTransitionState {
  currentBandIndex?: number;
  currentFeedId?: string;
}

interface BandStateChange {
  fromBandIndex?: number;
  fromFeedId?: string;
  toBandIndex: number;
  toFeedId: string;
  toFeedCode: string;
  feedChanged: boolean;
}

interface BandDecision {
  band: ProtocolBand;
  index: number;
  stateChange: BandStateChange | null;
}

class FeedTransitionService {
  decide(input: {
    protocol: Pick<FeedingProtocolV2, 'bands' | 'settings'>;
    avgWeightG: BandWeightG;
    state: BandTransitionState;
  }): BandDecision | null;
  apply(
    manager: EntityManager,
    tenantId: string,
    assignment: ProtocolAssignment,
    params: {
      unitId: string;
      unitCode: string;
      avgWeightG: number;
      change: BandStateChange;
      automatic: boolean;
    },
  ): Promise<void>;
}
```

`DayPlanRecalcService.recalcForUnit(manager, tenantId, unitId, trigger)` uses an exhaustive switch:
stock change applies `shiftRationBasisKg`, weighing applies `measuredRationBasisKg`, and every
rate-only reason keeps `dayPlanRationBasisKg(plan)`. It returns and logs the basis used. Live stock
still decides empty-unit cancellation and current average-weight band selection, but never supplies
the ration multiplier. Projected meal or unplanned-feed growth can change live modeled biomass and
band weight while its trigger remains rate-only.

`FeedTransitionService.decide` is pure and shared by generation, dry-run, recalculation, and admin
flows. It reads assignment band memory, applies one hysteresis rule, and holds the current band when
`autoTransition` is false. `apply` is the sole writer of current feed/band state and the sole
enqueuer of `FeedTypeTransitioned`, using the caller manager and farm outbox.

`ComputedDayPlan` carries `bandStateChange`. `persistDayPlan` applies it only after the idempotent
day-plan insert returns a new ID; a conflict, dry-run, or failed transaction cannot advance state or
publish a transition. A band change using the same feed updates state without claiming a feed
transition event.

- [ ] **Step 1: Write and run red trigger and one-mechanism tests**

```bash
npx nx test farm-service --runInBand --testPathPatterns='day-plan-recalc.service.spec.ts|feed-transition-one-mechanism.spec.ts|meal-plan-generator.service.spec.ts|day-plan-admin.service.spec.ts'
```

Expected RED: recalc prices from live biomass, reasons do not carry structural basis semantics,
generation bypasses hysteresis/state publication, and duplicate plan generation can advance a
transition incorrectly.

- [ ] **Step 2: Implement the minimal trigger switch and port**

Make `DayPlanRecalcService` implement `UnitRationRecalculator`. Extend `RecalcLogEntry` with
`weighing` and all named reasons plus `rationBasisKg`. Reject an invalid measurement rather than
turning it into a rate-only pass.

- [ ] **Step 3: Implement the single transition service and converge callers**

Delete the duplicate hysteresis/writer logic from recalculation and admin services. Inject the one
service into generator and recalculator. Lock assignment after day plan and meals in the existing
canonical order. Keep state change plus outbox inside the same transaction.

- [ ] **Step 4: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='day-plan-recalc|feed-transition|meal-plan-generator|day-plan-admin|ration-basis'
npx nx run farm-service:test:integration
npx nx run farm-service:e2e
git diff --check
```

Expected GREEN: stock deltas shift, weighing rebaselines, all rate-only reasons preserve basis,
auto-transition-off holds, hysteresis edges agree in every caller, duplicate insert publishes no
event, and outbox failure rolls back state.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
git add -- \
  apps/farm-service/src/batch/services/unit-ration-recalculator.port.ts \
  apps/farm-service/src/feeding-protocol/services/feed-transition.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/feed-transition-one-mechanism.spec.ts \
  apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/day-plan-recalc.service.spec.ts \
  apps/farm-service/src/feeding-protocol/services/meal-plan-generator.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/meal-plan-generator.service.spec.ts \
  apps/farm-service/src/feeding-protocol/services/day-plan-admin.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/day-plan-admin.service.spec.ts \
  apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts \
  apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task16_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding loop: unify transition and recalculation authority' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task16_finding_ids[@]}" -eq 1
[[ "${task16_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): unify feed transition decisions' \
  'Feed transitions and ration recalculation need one authority so state and derived plans cannot diverge.' \
  "${task16_finding_ids[0]}")"
git push origin HEAD
```

### Task 17: Make stock mutation structurally inseparable from repricing

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Modify: `apps/farm-service/src/batch/services/tank-batch.service.ts`
- Modify: `apps/farm-service/src/batch/__tests__/services/tank-batch.service.spec.ts`
- Create: `apps/farm-service/src/batch/__tests__/support/stock-change-double.ts`
- Modify: `apps/farm-service/src/batch/services/tank-count-reconcile.service.ts`
- Modify: `apps/farm-service/src/batch/__tests__/services/tank-count-reconcile.service.spec.ts`
- Modify: `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts`
- Modify: `apps/farm-service/src/batch/handlers/create-batch.handler.ts`
- Modify: `apps/farm-service/src/batch/handlers/record-mortality.handler.ts`
- Modify: `apps/farm-service/src/batch/handlers/record-cull.handler.ts`
- Modify: `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts`
- Modify: `apps/farm-service/src/batch/__tests__/handlers/allocate-to-tank.handler.spec.ts`
- Modify: `apps/farm-service/src/batch/__tests__/handlers/create-batch.handler.spec.ts`
- Modify: `apps/farm-service/src/batch/__tests__/handlers/record-mortality.handler.spec.ts`
- Modify: `apps/farm-service/src/batch/__tests__/handlers/record-cull.handler.spec.ts`
- Modify: `apps/farm-service/src/batch/__tests__/handlers/transfer-batch.handler.spec.ts`
- Modify: `apps/farm-service/src/batch/services/batch.service.ts`
- Modify: `apps/farm-service/src/batch/batch.module.ts`
- Modify: `apps/farm-service/src/batch/tank-batch.module.ts`
- Modify: `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts`
- Modify: `apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts`
- Modify: `apps/farm-service/src/harvest/handlers/delete-harvest-record.handler.ts`
- Modify: `apps/farm-service/src/harvest/__tests__/handlers/create-harvest-record.handler.spec.ts`
- Modify: `apps/farm-service/src/harvest/__tests__/handlers/update-harvest-record.handler.spec.ts`
- Modify: `apps/farm-service/src/harvest/__tests__/handlers/delete-harvest-record.handler.spec.ts`
- Modify: `apps/farm-service/src/harvest/harvest.module.ts`
- Modify: `tests/invariants/farm-stock-mutation-central-only.spec.ts`

**Interfaces:**

```ts
interface TankBatchDelta {
  batchId: string;
  batchNumber: string;
  quantityDelta: number;
  biomassDelta: number;
  avgWeightG?: number;
  lastMortalityAt?: Date;
}

interface StockChange {
  applyDelta(
    tankId: string,
    delta: TankBatchDelta,
    tankMeta?: { code?: string; name?: string; volumeM3?: number },
  ): Promise<TankBatch>;
}

class TankBatchService {
  applyStockChange<T>(
    manager: EntityManager,
    tenantId: string,
    reason: StockChangeReason,
    work: (stock: StockChange) => Promise<T>,
  ): Promise<T>;
}
```

`applyBatchDelta` becomes private and is reachable only through `applyStockChange`. The scope
accumulates signed biomass deltas per touched unit, writes every delta first, sorts unit IDs, then
calls `recalcAfterStockChange` exactly once per unit on the same manager. A throwing work callback
does not settle partial changes and the caller's tenant transaction rolls everything back.

Route allocation, `CreateBatch.initialLocations`, mortality, cull, both transfer units, harvest,
harvest update differences, harvest delete/reversal, and count reconciliation through the scope.
Grading already delegates real-fish movement to transfer and must not add a second mutation. Reject
per-tank overdraft rather than clamping or silently ignoring it. Persist `batchDetails` even for one
batch and derive all aggregates from it.

Delete dead stock-mutating methods and private writers from
`apps/farm-service/src/batch/services/batch.service.ts` only after repository search proves no
production caller. Cleaner-fish quantity and biomass remain separate and are explicitly allowlisted
by the invariant; they never change production-fish ration basis.

- [ ] **Step 1: Strengthen and run the red invariant and service tests**

```bash
npx nx test invariants --runInBand --testPathPatterns='farm-stock-mutation-central-only.spec.ts'
npx nx test farm-service --runInBand --testPathPatterns='tank-batch.service|tank-count-reconcile|allocate-to-tank|create-batch|record-mortality|record-cull|transfer-batch|harvest-record'
```

Expected RED: real-fish writers exist outside the scope, at least one path can mutate without a
signed basis delta, create-time stocking or reversal omits repricing, and repeated unit touches can
recalculate more than once.

- [ ] **Step 2: Implement the private writer and settlement scope**

Bind the required `UNIT_RATION_RECALCULATOR` token in `tank-batch.module.ts`; absence must fail
module startup. Keep the existing Batch then TankBatch then DayPlan/Meals/Assignment lock order. Use
the test double for handler units rather than weakening the production interface.

- [ ] **Step 3: Route every real-fish writer and remove dead alternatives**

For transfer and harvest update, compute exact signed count and biomass per unit. A reversal uses
`harvest_reversal`; ledger correction uses `count_reconcile`. `CreateBatch.initialLocations` calls
one scope for all initial rows. After routing, use `rg` to prove deleted BatchService mutation
methods have no production caller.

- [ ] **Step 4: Run green verification**

```bash
npx nx test invariants --runInBand --testPathPatterns='farm-stock-mutation-central-only|farm-stock-mutation-ssot|farm-tank-count-ssot'
npx nx test farm-service --runInBand --testPathPatterns='tank-batch|allocate-to-tank|create-batch|record-mortality|record-cull|transfer-batch|harvest-record|race-conditions'
npx nx run farm-service:test:integration
npx nx run farm-service:e2e
git diff --check
```

Expected GREEN: the invariant finds one real-fish TankBatch writer, every production handler enters
the scope, touched units recalc once in sorted order, all deltas share the transaction, overdrafts
fail, and cleaner-fish paths remain separate.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
git add -- \
  apps/farm-service/src/batch/services/tank-batch.service.ts \
  apps/farm-service/src/batch/__tests__/services/tank-batch.service.spec.ts \
  apps/farm-service/src/batch/__tests__/support/stock-change-double.ts \
  apps/farm-service/src/batch/services/tank-count-reconcile.service.ts \
  apps/farm-service/src/batch/__tests__/services/tank-count-reconcile.service.spec.ts \
  apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts \
  apps/farm-service/src/batch/handlers/create-batch.handler.ts \
  apps/farm-service/src/batch/handlers/record-mortality.handler.ts \
  apps/farm-service/src/batch/handlers/record-cull.handler.ts \
  apps/farm-service/src/batch/handlers/transfer-batch.handler.ts \
  apps/farm-service/src/batch/__tests__/handlers/allocate-to-tank.handler.spec.ts \
  apps/farm-service/src/batch/__tests__/handlers/create-batch.handler.spec.ts \
  apps/farm-service/src/batch/__tests__/handlers/record-mortality.handler.spec.ts \
  apps/farm-service/src/batch/__tests__/handlers/record-cull.handler.spec.ts \
  apps/farm-service/src/batch/__tests__/handlers/transfer-batch.handler.spec.ts \
  apps/farm-service/src/batch/services/batch.service.ts \
  apps/farm-service/src/batch/batch.module.ts \
  apps/farm-service/src/batch/tank-batch.module.ts \
  apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts \
  apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts \
  apps/farm-service/src/harvest/handlers/delete-harvest-record.handler.ts \
  apps/farm-service/src/harvest/__tests__/handlers/create-harvest-record.handler.spec.ts \
  apps/farm-service/src/harvest/__tests__/handlers/update-harvest-record.handler.spec.ts \
  apps/farm-service/src/harvest/__tests__/handlers/delete-harvest-record.handler.spec.ts \
  apps/farm-service/src/harvest/harvest.module.ts \
  tests/invariants/farm-stock-mutation-central-only.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task17_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding loop: make stock mutation inseparable from repricing' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task17_finding_ids[@]}" -eq 1
[[ "${task17_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): centralize stock-triggered repricing' \
  'Feed stock mutation and ration repricing must succeed or roll back within the same tenant transaction.' \
  "${task17_finding_ids[0]}")"
git push origin HEAD
```

### Task 18: Couple measurements, rate changes, and feed use without basis drift

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Modify: `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts`
- Modify: `apps/farm-service/src/growth/handlers/update-batch-weight-from-sample.handler.ts`
- Modify: `apps/farm-service/src/growth/__tests__/handlers/record-growth-sample.handler.spec.ts`
- Modify:
  `apps/farm-service/src/growth/__tests__/handlers/update-batch-weight-from-sample.handler.spec.ts`
- Modify: `apps/farm-service/src/growth/growth.module.ts`
- Modify: `apps/farm-service/src/water-quality/water-quality.service.ts`
- Modify: `apps/farm-service/src/water-quality/__tests__/water-quality.service.spec.ts`
- Modify: `apps/farm-service/src/water-quality/water-quality.module.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/meal-execution.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/services/biomass-growth-applier.service.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/biomass-growth-applier.service.spec.ts`
- Modify: `apps/farm-service/src/feeding-protocol/handlers/protocol-assignment.handlers.ts`
- Modify: `apps/farm-service/src/feeding-protocol/__tests__/protocol-assignment.batch-units.spec.ts`
- Modify: `apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts`
- Modify: `apps/farm-service/src/feeding/__tests__/handlers/create-feeding-record.handler.spec.ts`
- Modify: `apps/farm-service/src/feeding/feeding.module.ts`
- Create: `apps/farm-service/src/__tests__/e2e/feeding-loop-ration-basis.postgres.spec.ts`

**Interfaces:**

| Caller class                                                      | Required trigger                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `RecordGrowthSampleHandler`, `UpdateBatchWeightFromSampleHandler` | measurement / `weighing` with measured biomass       |
| `WaterQualityService`                                             | rate-only / `temperature` with validated temperature |
| `MealExecutionService`, `BiomassGrowthApplierService`             | rate-only / `meal_growth` or `pour_correction`       |
| `ProtocolAssignmentHandlers`                                      | rate-only / `protocol_change` or `assignment_change` |
| `CreateFeedingRecordHandler`                                      | rate-only / `unplanned_feed`                         |

Every call uses `DayPlanRecalcService.recalcForUnit(manager, tenantId, unitId, trigger)` on the
manager already holding the authoritative mutation. Feed deduction uses
`StockMovementService.recordMovement(manager, input, context)` and has no alternate return path.

A verified weighing rebaselines with
`{ kind: 'measurement', reason: 'weighing', measuredBiomassKg }` in the same transaction as the
authoritative weight update. Temperature passes `kind: 'rate_only'` and the validated temperature.
Protocol, assignment, grading-without-movement, unplanned feed, meal growth, and pour correction all
pass their named rate-only trigger. FCR-projected per-meal or daily growth never calls
`shiftRationBasisKg` or `measuredRationBasisKg`.

Meal execution and manual feeding continue to call
`apps/farm-service/src/storage/services/stock-movement.service.ts::recordMovement` on the same
manager. That storage ledger is the only feed-stock authority and remains fail-closed for missing
location, lot, or quantity. Do not inspect a storage-presence flag and do not fall back to
`apps/farm-service/src/feeding/entities/feed-inventory.entity.ts`. Feed stock failure rolls back the
record, growth, ration recalc, audit, and outbox writes together.

- [ ] **Step 1: Write and run red coupling tests**

```bash
npx nx test farm-service --runInBand --testPathPatterns='weighing|record-growth-sample|update-batch-weight-from-sample|water-quality.service|meal-execution.service|biomass-growth-applier|protocol-assignment|create-feeding-record'
npx nx run farm-service:e2e --testPathPatterns='feeding-loop-ration-basis.postgres.spec.ts'
```

Expected RED: measurement and rate-only calls are not structurally distinct, projected growth can
inflate a later ration, or a feed path can avoid the canonical storage ledger.

- [ ] **Step 2: Wire measurement and rate-only triggers**

Use the manager already held by each handler. Rebaseline only after a validated authoritative
measurement updates weight. Keep projected growth in its existing live-model field but use
`meal_growth`, `unplanned_feed`, or `pour_correction` without a basis constructor.

- [ ] **Step 3: Prove canonical feed-stock failure and rollback**

Strengthen handler and service tests so a missing ledger location, insufficient lot, or outbox
failure rolls back all feeding-loop state. Repository search must find no production reference from
the V2 feeding path to the legacy feed-inventory entity.

- [ ] **Step 4: Run green verification**

```bash
npx nx test farm-service --runInBand --testPathPatterns='record-growth-sample|update-batch-weight-from-sample|water-quality.service|meal-execution.service|biomass-growth-applier|protocol-assignment|create-feeding-record|ration-basis'
npx nx run farm-service:test:integration
npx nx run farm-service:e2e --testPathPatterns='feeding-loop-ration-basis.postgres.spec.ts'
! rg -n 'FeedInventory|feed_inventory' apps/farm-service/src/feeding-protocol apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts
git diff --check
```

Expected GREEN: the tests pass; the repository search has no production hit in the V2 execution
path; stock, weighing, temperature, assignment, feed, projected growth, and rollback scenarios use
the expected trigger without compounding the basis.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
git add -- \
  apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts \
  apps/farm-service/src/growth/handlers/update-batch-weight-from-sample.handler.ts \
  apps/farm-service/src/growth/__tests__/handlers/record-growth-sample.handler.spec.ts \
  apps/farm-service/src/growth/__tests__/handlers/update-batch-weight-from-sample.handler.spec.ts \
  apps/farm-service/src/growth/growth.module.ts \
  apps/farm-service/src/water-quality/water-quality.service.ts \
  apps/farm-service/src/water-quality/__tests__/water-quality.service.spec.ts \
  apps/farm-service/src/water-quality/water-quality.module.ts \
  apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/meal-execution.service.spec.ts \
  apps/farm-service/src/feeding-protocol/services/biomass-growth-applier.service.ts \
  apps/farm-service/src/feeding-protocol/__tests__/biomass-growth-applier.service.spec.ts \
  apps/farm-service/src/feeding-protocol/handlers/protocol-assignment.handlers.ts \
  apps/farm-service/src/feeding-protocol/__tests__/protocol-assignment.batch-units.spec.ts \
  apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts \
  apps/farm-service/src/feeding/__tests__/handlers/create-feeding-record.handler.spec.ts \
  apps/farm-service/src/feeding/feeding.module.ts \
  apps/farm-service/src/__tests__/e2e/feeding-loop-ration-basis.postgres.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task18_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding loop: couple measurements rates and feed use' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task18_finding_ids[@]}" -eq 1
[[ "${task18_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): couple feeding-loop recalculation' \
  'Biomass, feeding-rate, and feed-use changes must recalculate the same durable day-plan basis atomically.' \
  "${task18_finding_ids[0]}")"
git push origin HEAD
```

### Task 19: Enforce non-null ration basis and document verified authority

**Gate:** Keep the one F5 branch and worktree open after Task 18. Its exact pushed Task 18 commit is
deployed through the repository workflow to the required staged fleet. Every active and historical
day plan has a valid basis; per-tenant null/invalid counts are zero; stock, measurement, rate-only,
transition, and storage rollback evidence from Tasks 16 through 18 is attached to that workflow
evidence. Pause in the same worktree if any plan cannot be classified; do not merge, reconcile, or
create another branch.

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Generated output contract: exactly one newly added
  `apps/farm-service/src/database/migrations/[0-9]+-EnforceDayPlanRationBasis.ts`, resolved and
  count-checked with its sole exported class by Task 19 Step 2 before editing, manifest
  registration, or staging
- Create:
  `apps/farm-service/src/database/migrations/__tests__/enforce-day-plan-ration-basis.migration.spec.ts`
- Modify: `apps/farm-service/src/database/migrations/manifest.ts`
- Modify: `apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts`
- Create: `docs/architecture/feeding-system.md`

**Interfaces:**

The database and entity contract changes `rationBasisKg` from transitional nullable numeric to a
required nonnegative finite numeric. The contract-phase migration imports the one
`ExpandDayPlanRationBasis` class discovered by suffix and sets
`dependsOn: ExpandDayPlanRationBasis.name`. The architecture document names only authorities and
tests present in this task's green tree.

The follow-up migration repeats the per-tenant zero-invalid query and makes `rationBasisKg` non-null
with a nonnegative finite check. It depends on the actual Task 15 expand class. The entity becomes
non-null only in this commit. Update the architecture document from tested current behavior: single
stock writer, signed basis deltas, measurement rebaseline, rate-only projected growth, single
transition mechanism, storage-ledger authority, tenant transaction/outbox boundary, and
calibration-to-directive separation. Do not copy prose from source commit `b4b2f653c`.

- [ ] **Step 1: Verify the exact staged predecessor on the canonical F5 branch and run the red
      migration test**

Use `apply_patch` to create the named migration test before changing entity metadata. Its suffix
resolver must fail explicitly because no enforce migration exists yet.

```bash
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test "$(git branch --show-current)" = feat/feeding-f5-loop-completion
test "$(git rev-parse --show-toplevel)" = /var/aqua-saas/.worktrees/aquamobil-v4-f5
F5_RUNTIME_CANDIDATE_SHA="$(git rev-parse HEAD)"
[[ "$F5_RUNTIME_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git ls-remote --heads origin refs/heads/feat/feeding-f5-loop-completion | awk '{print $1}')" = \
  "$F5_RUNTIME_CANDIDATE_SHA"
test -z "$(git status --porcelain)"
npx nx test farm-service --runInBand --testPathPatterns='enforce-day-plan-ration-basis.migration.spec.ts'
```

Expected RED: entity metadata remains nullable and no migration declares the enforcement,
dependency, preflight, or down/up behavior.

- [ ] **Step 2: Change the entity contract, then generate the migration**

Make `rationBasisKg` a required `numeric(12,3)` entity field before invoking TypeORM. Then run:

```bash
(cd apps/farm-service && npx typeorm-ts-node-commonjs migration:generate src/database/migrations/EnforceDayPlanRationBasis -d src/database/data-source.ts)
mapfile -t ration_enforce_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-EnforceDayPlanRationBasis\.ts$')
test "${#ration_enforce_generated_files[@]}" -eq 1
mapfile -t ration_enforce_generated_classes < <(rg -o 'export class [A-Za-z0-9_]+' "${ration_enforce_generated_files[0]}")
test "${#ration_enforce_generated_classes[@]}" -eq 1
ration_enforce_generated_class="${ration_enforce_generated_classes[0]##* }"
printf 'migration=%s class=%s\n' "${ration_enforce_generated_files[0]}" "$ration_enforce_generated_class"
mapfile -t ration_expand_files < <(git ls-files 'apps/farm-service/src/database/migrations/*-ExpandDayPlanRationBasis.ts')
test "${#ration_expand_files[@]}" -eq 1
ration_expand_class="$(rg -o 'export class [A-Za-z0-9_]+' "${ration_expand_files[0]}" | awk '{print $3}')"
test -n "$ration_expand_class"
printf '%s\n' "$ration_expand_class"
```

Expected: one actual enforce suffix, one exported class, and the one expand predecessor are printed.

- [ ] **Step 3: Implement the minimal enforcement and update docs from evidence**

Import the class printed in Step 2 and use its `.name` as the single string `dependsOn` value. Make
the migration test discover and compare that metadata, and make diagnostics name tenant and row
count. After the full tests pass, edit the architecture document so every authority statement points
to the current implementation file and named verification test.

- [ ] **Step 4: Run green verification**

```bash
npx nx test farm-service --runInBand
npx nx run farm-service:test:integration
npx nx run farm-service:e2e
npx nx test invariants --runInBand --testPathPatterns='farm-stock-mutation-central-only|farm-stock-mutation-ssot|farm-tank-count-ssot'
npm run gates:migration-sql
npx prettier --check apps/farm-service/src/database/migrations apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts docs/architecture/feeding-system.md
git diff --check
```

Expected GREEN: full farm unit/integration/e2e suites, stock invariants, migration lint,
null/invalid preflight, constraint SQL, down/up rehearsal, and documentation references pass.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
mapfile -t ration_enforce_generated_files < <(git ls-files --others --exclude-standard apps/farm-service/src/database/migrations | rg '/[0-9]+-EnforceDayPlanRationBasis\.ts$')
test "${#ration_enforce_generated_files[@]}" -eq 1
git add -- "${ration_enforce_generated_files[0]}" \
  apps/farm-service/src/database/migrations/__tests__/enforce-day-plan-ration-basis.migration.spec.ts \
  apps/farm-service/src/database/migrations/manifest.ts \
  apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts \
  docs/architecture/feeding-system.md
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task19_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 feeding loop: enforce durable ration-basis authority' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task19_finding_ids[@]}" -eq 1
[[ "${task19_finding_ids[0]}" =~ ^FARM-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(farm): enforce day-plan ration basis' \
  'Ration-basis fields can become mandatory only after every live day plan is backfilled and all readers use them.' \
  "${task19_finding_ids[0]}")"
git push origin HEAD
```

Task 19 is the final commit in the one F5 implementation boundary. Rerun the four-audit,
audit/explain-set, production Vite/Rollup manifest, mapper, immutable-preflight check, and direct
ledger-verifier sequence from **Canonical Coordinator and Slice Preflight** into
`artifacts/aquamobil-v4/F5/dependency-final`; do not rewrite the preflight. Verify the one protected
F5 PR through the coordinator, merge it, and let only the program's fresh F5 reconciliation branch
capture `loop-completion` and regenerate the ledger. V6 waits for that exact reconciliation commit
and the independent UI finding-close reconciliation.

---

## V6 — Direct AquaMobil VFD Operations

### V6 start gate

- [ ] Verify I1, V0, V1, V2, V3, V4, V5, UI convergence, F3, F4, F5, and all delayed safety
      migrations are merged and deployed with green ledger entries.
- [ ] Verify the composed schema exposes current binding, refusal, and calibration fields, and
      AquaMobil's generated client is current.
- [ ] Verify the convergence paths exist: `web/apps/aquamobil/src/layouts/TabletLayout.tsx`,
      `web/apps/aquamobil/src/pages/tablet/BoardPage.tsx`, and
      `web/apps/aquamobil/src/pages/units/UnitsPage.tsx`.
- [ ] Verify V0 removed Konsta imports/dependencies and added the canonical AquaMobil `test` script.
- [ ] Run the canonical slice-entry checkpoint with `VFD_SLICE=V6`. It creates the one pinned V6
      branch/worktree only after resolving the exact F5 and UI closure reconciliation commits. Stop
      if any prerequisite is absent; do not copy a package or source file from the provenance branch
      to compensate.

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
test "$(git branch --show-current)" = feat/aquamobil-v6-vfd-operations
test "$(git rev-parse --show-toplevel)" = /var/aqua-saas/.worktrees/aquamobil-v4-v6
test "$(git rev-parse HEAD)" = \
  "$(jq -r '.baseMainCommit' docs/superpowers/evidence/aquamobil-v4/slices/V6/preflight.json)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice V6 \
  --check docs/superpowers/evidence/aquamobil-v4/slices/V6/preflight.json \
  --main-ref origin/main
```

Expected: the named branch tracks the current prerequisite-bearing `origin/main`, and the status
contains no staged, modified, or untracked path.

### Task 20: Establish server-owned actuation roots and the offline boundary invariant

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `docs/superpowers/evidence/aquamobil-v4/slices/V6/preflight.json` through the program
  capture tool
- Create: `apps/sensor-service/src/vfd/contracts/vfd-actuation-roots.ts`
- Modify: `apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts`
- Modify: `apps/sensor-service/src/vfd/resolvers/__tests__/vfd-command.resolver.spec.ts`
- Create: `tests/invariants/aquamobil-vfd-actuation-offline-boundary.spec.ts`

**Interfaces:**

```ts
export const VFD_ACTUATION_ROOTS = {
  send: 'sendVfdCommand',
  start: 'startVfd',
  stop: 'stopVfd',
  frequency: 'setVfdFrequency',
  speed: 'setVfdSpeed',
  reset: 'resetVfdFault',
  emergencyStop: 'emergencyStopVfd',
} as const;
```

Use these constants in the GraphQL mutation decorator names. The invariant reads this server file,
AST-parses sensor resolver methods that call `executeCommand`, and proves those decorated roots
equal the constant values. It parses AquaMobil GraphQL documents to collect mutation roots and
parses the positive `OperationType` plus `operation-registry.ts` keys that are eligible for queue or
replay. The intersection with all seven server actuation roots must be empty.

Do not create `web/apps/aquamobil/src/pwa/actuation-commands.ts` or any frontend actuation list. Do
not add a VFD value to `OperationType`, registry records, offline queue, service-worker replay, or
queued persistence. Generic send and speed are covered by the server-derived proof even though V6
does not render controls for them.

- [ ] **Step 1: Write and run the red invariant**

```bash
npx nx test invariants --runInBand --testPathPatterns='aquamobil-vfd-actuation-offline-boundary.spec.ts'
```

Expected RED: there is no server constant authority and resolver/registry/document coverage cannot
be proven from syntax.

- [ ] **Step 2: Add the constant and converge resolver decorators**

Change only decorator-name literals; command behavior remains the fail-closed F3 shared execution
path. Make the invariant reject computed frontend aliases, omitted resolver commands, and a queued
root even when a UI control is absent.

- [ ] **Step 3: Run green verification**

```bash
npx nx test sensor-service --runInBand --testPathPatterns='vfd-command.resolver|vfd-command.service|vfd-command.audit'
npx nx test invariants --runInBand --testPathPatterns='aquamobil-vfd-actuation-offline-boundary.spec.ts|queued-mutation-ssot|operation-registry'
npx prettier --check apps/sensor-service/src/vfd/contracts/vfd-actuation-roots.ts apps/sensor-service/src/vfd/resolvers tests/invariants/aquamobil-vfd-actuation-offline-boundary.spec.ts
git diff --check
```

Expected GREEN: resolver methods and the server constant are complete and equal, all seven roots are
absent from positive offline eligibility, and F3 authorization/attestation tests still pass.

- [ ] **Step 4: Review, commit, and push this boundary**

```bash
git add -- \
  docs/superpowers/evidence/aquamobil-v4/slices/V6/preflight.json \
  apps/sensor-service/src/vfd/contracts/vfd-actuation-roots.ts \
  apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts \
  apps/sensor-service/src/vfd/resolvers/__tests__/vfd-command.resolver.spec.ts \
  tests/invariants/aquamobil-vfd-actuation-offline-boundary.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task20_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 mobile VFD: prove actuation cannot enter offline replay' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task20_finding_ids[@]}" -eq 1
[[ "${task20_finding_ids[0]}" =~ ^SENSOR-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'test(aquamobil): prove VFD commands never enter replay' \
  'A structural invariant must prevent any VFD actuation root from entering offline persistence or replay.' \
  "${task20_finding_ids[0]}")"
git push -u origin HEAD
```

### Task 21: Add generated VFD operations, direct hooks, and honest mapping

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `web/apps/aquamobil/src/graphql/vfd-operations.ts`
- Regenerate: `web/apps/aquamobil/src/generated/graphql.ts`
- Create: `web/apps/aquamobil/src/hooks/useVfdDrives.ts`
- Create: `web/apps/aquamobil/src/hooks/useVfdCommand.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useVfdDrives.spec.tsx`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useVfdCommand.spec.tsx`
- Modify: `web/apps/aquamobil/src/hooks/index.ts`
- Create: `web/apps/aquamobil/src/utils/vfd-drive.ts`
- Create: `web/apps/aquamobil/src/utils/__tests__/vfd-drive.spec.ts`

**Interfaces:**

- Queries: `vfdDevices`, `vfdStats`, `vfdDevice`, `vfdDevicesByUnit`, and
  `feederSetup(equipmentId)`.
- Direct mutations only: `startVfd`, `stopVfd`, `setVfdFrequency`, `resetVfdFault`, and
  `emergencyStopVfd`.
- Every selection includes device active/connection/fault state, current register values as nullable
  data, drive binding state/age/equipment/unit assignments, and typed command refusal.

The documents compile into `web/apps/aquamobil/src/generated/graphql.ts`; hooks import generated
documents and types. Do not manually edit that file or restate GraphQL response/input interfaces.

The direct-command interface is:

```ts
type VfdCommandRequest =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'set_frequency'; frequencyHz: number }
  | { kind: 'reset_fault' }
  | { kind: 'emergency_stop' };

type VfdCommandOutcome =
  | { kind: 'sent'; acknowledgedAt?: string }
  | {
      kind: 'refused';
      code: 'offline' | 'permission_denied' | VfdCommandRefusalCode;
      message: string;
    }
  | { kind: 'failed'; message: string };
```

`useVfdCommand` imports `graphqlRequest` from
`web/apps/aquamobil/src/services/authenticated-fetch.ts` and network state from
`web/apps/aquamobil/src/hooks/useNetworkStatus.ts`. Offline returns a visible `offline` refusal
without issuing a request. It imports no offline queue, enqueue helper, registry, replay module, or
optimistic persistence. Network and server transport failures return `failed` and are never queued
or automatically retried. F3's generated refusal code produces `refused`, so authorization,
attestation, zero-assignment feeder, and transport failures remain distinct. An exported
`GraphQLError` whose first extension code is `FORBIDDEN` or `UNAUTHENTICATED` maps to
`permission_denied`; other thrown request failures map to `failed` and never claim that nothing may
have reached the edge.

`vfd-drive.ts` maps nullable registers and status without turning absence into numeric zero, healthy
state, unit identity, or connection state. It preserves multi-unit ambiguity and pending, expired,
unknown, inactive, and feeder-without-unit display states.

- [ ] **Step 1: Write and run red hook and mapper tests**

```bash
npm --prefix web/apps/aquamobil test -- src/hooks/__tests__/useVfdDrives.spec.tsx src/hooks/__tests__/useVfdCommand.spec.tsx src/utils/__tests__/vfd-drive.spec.ts
npm run codegen:check
```

Expected RED: operations and generated documents are missing; the direct hook and nullable mapper do
not exist.

- [ ] **Step 2: Add documents and regenerate from the composed schema**

```bash
npm run schema:generate
npm run apollo-router:compose
npm run codegen
```

Inspect generated mutations to ensure tenant and user identity come only from authenticated server
context and no offline envelope is introduced.

- [ ] **Step 3: Implement minimal query, command, and mapper hooks**

Use React Query keys scoped by tenant and drive/unit ID. Disable mutation retry. Validate positive
frequency and rely on generated input types. Clear stale command outcome only on an explicit new
attempt. Keep server refusal text visible.

- [ ] **Step 4: Run green verification**

```bash
npm --prefix web/apps/aquamobil test -- src/hooks/__tests__/useVfdDrives.spec.tsx src/hooks/__tests__/useVfdCommand.spec.tsx src/utils/__tests__/vfd-drive.spec.ts
npm run codegen
npm run codegen:check
npm --prefix web/apps/aquamobil run typecheck
npx nx test invariants --runInBand --testPathPatterns='aquamobil-vfd-actuation-offline-boundary.spec.ts'
git diff --check
```

Expected GREEN: query states, nullable registers, offline refusal with zero requests, typed server
refusal, auth refusal, transport failure with zero enqueue/retry calls, successful direct send, and
generated contract checks pass.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
git add -- web/apps/aquamobil/src/graphql/vfd-operations.ts web/apps/aquamobil/src/generated/graphql.ts web/apps/aquamobil/src/hooks/useVfdDrives.ts web/apps/aquamobil/src/hooks/useVfdCommand.ts web/apps/aquamobil/src/hooks/__tests__/useVfdDrives.spec.tsx web/apps/aquamobil/src/hooks/__tests__/useVfdCommand.spec.tsx web/apps/aquamobil/src/hooks/index.ts web/apps/aquamobil/src/utils/vfd-drive.ts web/apps/aquamobil/src/utils/__tests__/vfd-drive.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task21_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 mobile VFD: add generated direct drive operations' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task21_finding_ids[@]}" -eq 1
[[ "${task21_finding_ids[0]}" =~ ^MOB-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(aquamobil): add direct VFD operations' \
  'Mobile VFD commands must use generated online-only operations with explicit refusal outcomes.' \
  "${task21_finding_ids[0]}")"
git push origin HEAD
```

### Task 22: Add drive routes, unit surfaces, and tablet pane

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `web/apps/aquamobil/src/components/drive/DriveState.tsx`
- Create: `web/apps/aquamobil/src/components/drive/UnitDrivesCard.tsx`
- Create: `web/apps/aquamobil/src/components/drive/index.ts`
- Create: `web/apps/aquamobil/src/components/drive/__tests__/DriveState.spec.tsx`
- Create: `web/apps/aquamobil/src/components/drive/__tests__/UnitDrivesCard.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/drives/DrivesPage.tsx`
- Create: `web/apps/aquamobil/src/pages/drives/DriveDetailPage.tsx`
- Create: `web/apps/aquamobil/src/pages/drives/__tests__/DrivesPage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/drives/__tests__/DriveDetailPage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/panes/DrivesPane.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/panes/__tests__/DrivesPane.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/tablet/BoardPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/tablet/__tests__/BoardPage.spec.tsx`
- Modify: `web/apps/aquamobil/src/layouts/TabletLayout.tsx`
- Modify: `web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/units/UnitsPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/index.ts`
- Modify: `web/apps/aquamobil/src/App.tsx`
- Modify: `web/apps/aquamobil/src/__tests__/route-reachability.invariant.spec.ts`
- Modify: `web/apps/aquamobil/src/__tests__/field-ergonomics.invariant.spec.ts`

**Interfaces:**

The authenticated route contract adds `/drives` and `/drives/:driveId`. `DriveState` receives the
honest mapped display state only. `UnitDrivesCard` receives a unit ID and the generated unit-drive
query state. `DriveDetailPage` delegates every mutation to `useVfdCommand` and renders its
`VfdCommandOutcome`; `DrivesPane`, tank detail, and units page reuse those two authorities without a
second command mapper or role policy.

Add authenticated routes `/drives` and `/drives/:driveId`. Fleet, unit card, detail, and tablet pane
render loading, error, empty, disconnected, fault, inactive, refusal, binding state, attestation
age, feeder-without-unit, multi-unit, and live-data states without invented values. Unit and tank
surfaces link only drives actually returned for that unit.

Start, stop, frequency, and fault reset require `MODULE_MANAGER` or a higher normalized role in the
UI. Emergency stop is offered to every authenticated user. Start, frequency, reset, and emergency
stop require explicit confirmation that names the drive and action. A normal stop remains immediate
and still renders its typed outcome. Below-floor users do not see privileged controls and receive an
explanation; their emergency-stop control remains. A known non-actuable binding disables all
controls with its reason. Because binding and authorization can change after render, the server
remains authoritative and any typed refusal returned by an attempted request stays visible.

The tablet pane uses the same generated query and direct hook; it does not fork command logic. No
control writes to queue storage, advertises later sync, or changes a drive optimistically. Offline
alone leaves an otherwise permitted control pressable so the hook can announce the typed `offline`
refusal; the press performs zero requests and zero queue writes.

- [ ] **Step 1: Write and run red component, page, route, and tablet tests**

```bash
npm --prefix web/apps/aquamobil test -- src/components/drive src/pages/drives src/pages/tablet/panes/__tests__/DrivesPane.spec.tsx src/pages/tablet/__tests__/BoardPage.spec.tsx src/__tests__
```

Expected RED: drive routes and components are absent, role/confirmation rules are unproven, and
tablet/unit convergence has no drive surface.

- [ ] **Step 2: Implement presentational state and unit card first**

Keep display mapping in `vfd-drive.ts`; components receive mapped data and callbacks. Make missing
registers render as unavailable, not zero. Test each binding/refusal state before adding controls.

- [ ] **Step 3: Implement routes, detail confirmations, and shared tablet pane**

Register both routes in the authenticated route tree and page barrel. Reuse hooks across phone,
unit/tank, and tablet surfaces. Use existing convergence primitives and role normalization; add no
Konsta import or new component library.

- [ ] **Step 4: Run green verification**

```bash
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil run build
npx nx test invariants --runInBand --testPathPatterns='aquamobil-vfd-actuation-offline-boundary.spec.ts'
! rg -n "from ['\"]konsta|require\(['\"]konsta" web/apps/aquamobil/src web/apps/aquamobil/package.json
git diff --check
```

Expected GREEN: all AquaMobil tests, route reachability, loading/error/empty/refusal states,
permissions, confirmations, responsive phone/tablet rendering, direct command outcomes, and the
server-derived offline invariant pass. The Konsta search returns no match.

- [ ] **Step 5: Review, commit, and push this boundary**

```bash
git add -- \
  web/apps/aquamobil/src/components/drive/DriveState.tsx \
  web/apps/aquamobil/src/components/drive/UnitDrivesCard.tsx \
  web/apps/aquamobil/src/components/drive/index.ts \
  web/apps/aquamobil/src/components/drive/__tests__/DriveState.spec.tsx \
  web/apps/aquamobil/src/components/drive/__tests__/UnitDrivesCard.spec.tsx \
  web/apps/aquamobil/src/pages/drives/DrivesPage.tsx \
  web/apps/aquamobil/src/pages/drives/DriveDetailPage.tsx \
  web/apps/aquamobil/src/pages/drives/__tests__/DrivesPage.spec.tsx \
  web/apps/aquamobil/src/pages/drives/__tests__/DriveDetailPage.spec.tsx \
  web/apps/aquamobil/src/pages/tablet/panes/DrivesPane.tsx \
  web/apps/aquamobil/src/pages/tablet/panes/__tests__/DrivesPane.spec.tsx \
  web/apps/aquamobil/src/pages/tablet/BoardPage.tsx \
  web/apps/aquamobil/src/pages/tablet/__tests__/BoardPage.spec.tsx \
  web/apps/aquamobil/src/layouts/TabletLayout.tsx \
  web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx \
  web/apps/aquamobil/src/pages/units/UnitsPage.tsx \
  web/apps/aquamobil/src/pages/index.ts \
  web/apps/aquamobil/src/App.tsx \
  web/apps/aquamobil/src/__tests__/route-reachability.invariant.spec.ts \
  web/apps/aquamobil/src/__tests__/field-ergonomics.invariant.spec.ts
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
mapfile -t task22_finding_ids < <(
  jq -r --arg title 'AquaMobil V4 mobile VFD: add safe drive control surfaces' \
    'select(.title == $title) | .id // empty' docs/reviews/_registry/findings.jsonl
)
test "${#task22_finding_ids[@]}" -eq 1
[[ "${task22_finding_ids[0]}" =~ ^MOB-HIGH-[0-9]{3}$ ]]
git commit -m "$(printf '%s\n\n%s\n\nCloses: docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md#%s' \
  'feat(aquamobil): add drive control surfaces' \
  'Operators need fail-closed controls that expose server authority and never imply queued actuation.' \
  "${task22_finding_ids[0]}")"
git push origin HEAD
```

### Task 23: Run the complete server-to-mobile safety verification

**Files:**

- None. This is an evidence and release gate; do not change production files while running it. A
  failure returns to the owning task with a new red test and normal review cycle.

**Interfaces:**

The release-evidence contract accepts only the reviewed F3, F4, F5, and V6 commit sequence. Its
success output is a clean worktree, green current-version validators and real upcaster chains,
rehearsed expand/enforce/contract migrations, generated NATS identity parity, tenant-safe backend
tests, two AquaMobil install matrices, a production build, and no reachable high or critical
production dependency finding. Any missing, stale, ambiguous, or failing item blocks release and
returns to its owning task; this gate does not modify production code or auto-rewrite dependencies.

- [ ] **Step 1: Verify contracts, migrations, NATS, and backend behavior**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/ci-image-digests.spec.ts
NATS_IMAGE="$(node scripts/ci/resolve-ci-image.mjs \
  --manifest infrastructure/ci/image-digests.json \
  --image nats)"
[[ "$NATS_IMAGE" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]]
npx nx test event-contracts --runInBand
npx nx test sensor-service --runInBand
npx nx test farm-service --runInBand
npx nx run farm-service:test:integration
npx nx run farm-service:e2e
npx nx test gateway-api --runInBand
npx nx test invariants --runInBand
npm run gates:migration-sql
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
python3 scripts/nats/generate-nats-conf.py
git diff --exit-code -- infrastructure/docker/nats/nats.conf infrastructure/helm/aquaculture/files/nats-service-identities.yaml
npx jest --config e2e/jest.config.ts --runInBand --runTestsByPath e2e/tests/integration/nats-invariants.spec.ts e2e/tests/integration/nats-subject-contract.spec.ts
npm run smoke:nats-messaging-acl
npm run smoke:nats-feeding-acl
```

Expected: validators and upcasters, tenant PostgreSQL tests, migration rehearsals, event outboxes,
mass projection, calibration physics, stock/ration coupling, command auth/attestation, gateway
upcast, generated schema, and cert-identity ACLs are green.

- [ ] **Step 2: Verify the ignored-script bootstrap matrix, then the separate normal-script matrix**

```bash
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil run build

NORMAL_ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
NORMAL_AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --no-audit
npm --prefix web/apps/aquamobil ci --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$NORMAL_ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$NORMAL_AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil run build
docker build -f infrastructure/docker/Dockerfile.aquamobil -t aquamobil-pr .
npm run type-check
npx nx affected --target=lint
npx nx affected --target=build
```

Expected: the fresh-worktree ignored-script bootstrap and the later normal-script compatibility
matrix each preserve both lock authorities and pass independently. All tests pass, the production
build and Docker image succeed, and repository type checking plus affected lint/build are green.

- [ ] **Step 3: Classify production dependency findings without mutation**

```bash
set -euo pipefail
V6_ACTIVE_WORKTREE="$(git rev-parse --show-toplevel)"
test "$V6_ACTIVE_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-v6
v6_audit_dir=artifacts/aquamobil-v4/V6/dependency-final
mkdir -p "$v6_audit_dir"
v6_build_id="$(git rev-parse HEAD)"
[[ "$v6_build_id" =~ ^[0-9a-f]{40}$ ]]
export AQUAMOBIL_BUILD_ID="$v6_build_id"
export AQUAMOBIL_AUDIT_MODULE_MANIFEST="$v6_audit_dir/aquamobil-vite-rollup-modules.json"
npm --prefix web/apps/aquamobil run build
test -s "$v6_audit_dir/aquamobil-vite-rollup-modules.json"
set +e
npm audit --json > "$v6_audit_dir/audit-root-full.json"
v6_root_full_status=$?
npm audit --omit=dev --json > "$v6_audit_dir/audit-root-runtime.json"
v6_root_runtime_status=$?
npm --prefix web/apps/aquamobil audit --json > "$v6_audit_dir/audit-mobile-full.json"
v6_mobile_full_status=$?
npm --prefix web/apps/aquamobil audit --omit=dev --json \
  > "$v6_audit_dir/audit-mobile-runtime.json"
v6_mobile_runtime_status=$?
set -e
printf '%s\n' \
  "$v6_root_full_status" \
  "$v6_root_runtime_status" \
  "$v6_mobile_full_status" \
  "$v6_mobile_runtime_status" \
  > "$v6_audit_dir/audit-exit-statuses.txt"

COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
refresh_v6_coordinator() {
  git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
  test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
  git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
  test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
  test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
    "$(git -C /var/aqua-saas rev-parse origin/main)"
}
refresh_v6_coordinator
cd "$V6_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --capture-explain-set \
  --root-audit-full "$v6_audit_dir/audit-root-full.json" \
  --root-audit-runtime "$v6_audit_dir/audit-root-runtime.json" \
  --aquamobil-audit-full "$v6_audit_dir/audit-mobile-full.json" \
  --aquamobil-audit-runtime "$v6_audit_dir/audit-mobile-runtime.json" \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json "$v6_audit_dir/audit-set.json" \
  --write-explain-set-json "$v6_audit_dir/npm-explain-set.json"
refresh_v6_coordinator
cd "$V6_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --audit-set-json "$v6_audit_dir/audit-set.json" \
  --explain-set-json "$v6_audit_dir/npm-explain-set.json" \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest "$v6_audit_dir/aquamobil-vite-rollup-modules.json" \
  --output-json "$v6_audit_dir/dependency-reachability.json" \
  --output-markdown "$v6_audit_dir/dependency-reachability.md"
for vfd_owner_slice in F3 F4 F5 V6; do
  refresh_v6_coordinator
  cd "$V6_ACTIVE_WORKTREE"
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
    --slice "$vfd_owner_slice" \
    --check "docs/superpowers/evidence/aquamobil-v4/slices/$vfd_owner_slice/preflight.json" \
    --main-ref origin/main
done
refresh_v6_coordinator
cd "$V6_ACTIVE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
test -s "$v6_audit_dir/dependency-reachability.json"
test -s "$v6_audit_dir/dependency-reachability.md"
```

Upload the complete fixed directory as the repository-owned V6 dependency-evidence artifact; do not
write it into the central ledger from this branch. A reachable high or critical runtime or
release-build finding in the affected production graph blocks release; an aggregate count is not a
reachability argument. Do not run an audit fixer. The canonical mapper uses both locks and the real
Vite/Rollup module manifest; no positional mapper mode or caller-supplied reachability claim is
accepted.

- [ ] **Step 4: Inspect final scope and push the existing reviewed commits**

```bash
git status --short --branch
git diff --check
git diff --exit-code
git diff --cached --exit-code
test -z "$(git status --porcelain)"
git log --oneline --decorate origin/main..HEAD
git push origin HEAD
```

Expected: only reviewed V6 commits are ahead of `origin/main`, the worktree is clean after any
generated no-drift checks, and remote history contains each normally pushed commit.

Task 23 completes the one V6 implementation boundary. Verify the one protected V6 PR with the
coordinator, merge it, and let only the program's fresh V6 reconciliation branch capture
`vfd-operations` and regenerate the ledger. Task 24 cannot create its closure worktree until F3, F4,
F5, and V6 reconciliation artifacts and their exact reconciliation commits are all
protected-main-reachable.

### Task 24: Close all 22 HIGH findings through a separate protected PR

**Files:**

- Regenerate: `tools/quality/format-scope.json` after staging the task-owned paths
- Create: `docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Modify: `docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md`
- Generated output contract: exactly 22 newly created `docs/compliance/evidence/<FINDING-ID>.md`
  files, one for every HIGH row allocated by Task 0 and no other row

**Interfaces:**

- Consumes: the one protected implementation boundary and separate slice reconciliation for each of
  F3, F4, F5, and V6; the successful repository-owned Task 23 workflow run; and the exact 22 titles
  allocated in Task 0.
- Produces: one sorted 22-entry finding-ID-to-main-closing-SHA map, 22 repository-template HIGH
  attestations, RESOLVED registry/review state, and immutable inputs for the program's later closure
  reconciliation. This branch never edits a slice merge record, a closure record, the central
  ledger, or another slice's evidence.

- [ ] **Step 1: Create the one configured closure worktree after all four slice reconciliations**

The protected implementation inventory is exactly:

| Slice | Boundary ID           | Protected implementation branch       |
| ----- | --------------------- | ------------------------------------- |
| F3    | `vfd-attestation`     | `feat/feeding-f3-vfd-attestation`     |
| F4    | `calibration-physics` | `feat/feeding-f4-calibration-physics` |
| F5    | `loop-completion`     | `feat/feeding-f5-loop-completion`     |
| V6    | `vfd-operations`      | `feat/aquamobil-v6-vfd-operations`    |

Each merge record contains exactly its one boundary attestation. The coordinator refuses closure
creation until all four merge records, their creation commits, reviewed PRs, full resulting-main
SHAs, distinct reviewers, required runs, and V6's final Task 23 artifact are valid and
protected-main-reachable.

```bash
set -euo pipefail
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
for vfd_slice in F3 F4 F5 V6; do
  merge_path="docs/superpowers/evidence/aquamobil-v4/slices/$vfd_slice/merge.json"
  mapfile -t reconciliation_candidates < <(
    git -C /var/aqua-saas log --diff-filter=A --format='%H' origin/main -- "$merge_path"
  )
  test "${#reconciliation_candidates[@]}" -eq 1
  reconciliation_sha="${reconciliation_candidates[0]}"
  [[ "$reconciliation_sha" =~ ^[0-9a-f]{40}$ ]]
  git -C /var/aqua-saas merge-base --is-ancestor "$reconciliation_sha" origin/main
  git -C /var/aqua-saas cat-file -e "$reconciliation_sha:$merge_path"
  printf 'slice=%s reconciliation=%s\n' "$vfd_slice" "$reconciliation_sha"
done
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create-finding-closure \
  --closure vfd-feeding-loop-high-findings \
  --main-ref origin/main
VFD_CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure vfd-feeding-loop-high-findings)"
VFD_CLOSURE_BRANCH="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-branch --closure vfd-feeding-loop-high-findings)"
test "$VFD_CLOSURE_WORKTREE" = /var/aqua-saas/.worktrees/aquamobil-v4-vfd-findings-close
test "$VFD_CLOSURE_BRANCH" = chore/aquamobil-v4-vfd-findings-close
cd "$VFD_CLOSURE_WORKTREE"
test "$(git branch --show-current)" = "$VFD_CLOSURE_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test ! -L node_modules
test ! -L web/apps/aquamobil/node_modules
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
npm run findings:verify
```

- [ ] **Step 2: Capture the exact 22-entry implementation-commit map**

Only the coordinator capture authority resolves preserved commit bodies or the reviewed squash body.
It reads the pinned title/owner inventory and the four immutable implementation-boundary
attestations, then rejects a missing, extra, duplicate, foreign, non-main, or closure-merge
candidate.

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
VFD_CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure vfd-feeding-loop-high-findings)"
cd "$VFD_CLOSURE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --capture-finding-closures vfd-feeding-loop-high-findings \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main \
  --write docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json
vfd_review_file=docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md
mapfile -t vfd_closure_finding_ids < <(
  jq -sr '
    [.[] | select(.raised_in_cycle == "2026-08-26-aquamobil-v4-vfd-feeding-loop")]
    | if length == 22 and
         (map(.id) | unique | length) == 22 and
         (map(.title) | unique | length) == 22 and
         all(.[]; .severity == "HIGH")
      then sort_by(.id)[] | .id
      else error("expected 22 unique VFD/feeding HIGH IDs and titles")
      end
  ' docs/reviews/_registry/findings.jsonl
)
test "${#vfd_closure_finding_ids[@]}" -eq 22
jq -e '
  length == 22 and
  all(to_entries[];
    (.key | test("^(SENSOR|FARM|MOB)-HIGH-[0-9]{3}$")) and
    (.value | test("^[0-9a-f]{40}$")))
' docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json
diff -u \
  <(printf '%s\n' "${vfd_closure_finding_ids[@]}" | sort) \
  <(jq -r 'keys[]' docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json | sort)
jq -r 'to_entries[] | [.key, .value] | @tsv' \
  docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json |
  while IFS=$'\t' read -r finding_id closing_sha; do
    git merge-base --is-ancestor "$closing_sha" origin/main
    git show --format='%B' --no-patch "$closing_sha" |
      rg -Fxq "Closes: ${vfd_review_file}#${finding_id}"
    test "$(git log origin/main --format='%B' | \
      rg -Fxc "Closes: ${vfd_review_file}#${finding_id}")" -eq 1
  done
```

- [ ] **Step 3: Close registry rows and author 22 distinct HIGH attestations**

```bash
jq -r 'to_entries[] | [.key, .value] | @tsv' \
  docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json |
  while IFS=$'\t' read -r finding_id closing_sha; do
    npm run findings:close -- "$finding_id" "$closing_sha"
  done
npm run findings:verify
npx nx test invariants --runInBand --testPathPatterns='finding-registry-integrity.spec.ts'
```

Use `apply_patch` to mark exactly those 22 review headings `RESOLVED` and record each full closing
SHA plus its protected implementation PR URL. Create `docs/compliance/evidence/<FINDING-ID>.md` from
the repository template for each mapped ID. Every attestation names the actual full implementation
SHA, protected PR, authenticated author, distinct reviewer, finding-specific production and test
paths, the verification run that exercised that boundary, and an ongoing invariant. Template values,
short SHAs, a closure-merge SHA substituted for the implementation SHA, self-review, reused generic
evidence, or an ID outside the exact map fails this step.

- [ ] **Step 4: Verify, commit, push, and protect only the finding-closure surface**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
mapfile -t vfd_attestation_files < <(
  jq -r 'keys[] | "docs/compliance/evidence/\(.).md"' \
    docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json
)
test "${#vfd_attestation_files[@]}" -eq 22
for vfd_attestation_file in "${vfd_attestation_files[@]}"; do
  test -f "$vfd_attestation_file"
done
npx ts-node --project tools/gates/tsconfig.json tools/gates/compliance-attestation-coverage.ts
git add -- \
  docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md \
  "${vfd_attestation_files[@]}"
mapfile -t vfd_task_owned_staged_paths < <(
  git diff --cached --name-only | LC_ALL=C sort -u
)
test "${#vfd_task_owned_staged_paths[@]}" -gt 0
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
diff -u \
  <(printf '%s\n' "${vfd_task_owned_staged_paths[@]}" tools/quality/format-scope.json | LC_ALL=C sort -u) \
  <(git diff --cached --name-only | LC_ALL=C sort -u)
git diff --cached --check
git commit -m "chore(review): close AquaMobil VFD feeding findings"
git push --set-upstream origin chore/aquamobil-v4-vfd-findings-close
```

Open a protected PR to `main`, require all status checks and a distinct approving reviewer, then run
the coordinator-owned prospective verifier before merge:

```bash
VFD_CLOSURE_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-vfd-findings-close
VFD_CLOSURE_PR_NUMBER="$(gh pr view --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$VFD_CLOSURE_PR_NUMBER" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$VFD_CLOSURE_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision,baseRefName,headRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-vfd-findings-close")'
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$VFD_CLOSURE_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-closure-pr "$VFD_CLOSURE_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --verify-base-advance \
  --require-latest-merge-queue-candidate \
  --forbid-duplicate-closing-trailers
```

Merge without bypass. The closure PR records state and attestations; it never repeats an
implementation trailer or becomes a fixing commit.

- [ ] **Step 5: Verify protected main, clean the closure worktree, and hand off reconciliation**

```bash
set -euo pipefail
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
VFD_CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure vfd-feeding-loop-high-findings)"
mapfile -t vfd_closure_pr_numbers < <(
  gh pr list --repo Okan-wqm/aquaculture_platform --state merged --base main \
    --head chore/aquamobil-v4-vfd-findings-close --json number --jq '.[].number'
)
test "${#vfd_closure_pr_numbers[@]}" -eq 1
VFD_CLOSURE_PR_NUMBER="${vfd_closure_pr_numbers[0]}"
VFD_CLOSURE_MAIN_SHA="$(gh pr view "$VFD_CLOSURE_PR_NUMBER" \
  --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$VFD_CLOSURE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$VFD_CLOSURE_MAIN_SHA" origin/main
cd "$VFD_CLOSURE_WORKTREE"
npm run findings:verify
npx nx test invariants --runInBand --testPathPatterns='finding-registry-integrity.spec.ts'
npx ts-node --project tools/gates/tsconfig.json tools/gates/compliance-attestation-coverage.ts
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
cd "$COORDINATOR_WORKTREE"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --closure vfd-feeding-loop-high-findings \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$VFD_CLOSURE_WORKTREE"
```

Task 24 ends after that cleanup. Only the integration program may create the separate serialized
closure-reconciliation worktree and PR. That program-owned PR creates the one append-only
`docs/superpowers/evidence/aquamobil-v4/closures/vfd-feeding-loop-high-findings.json`, regenerates
the central ledger through its reconciler, and supplies the Task 23 workflow attestation. The
integration closeout cannot start until that reconciliation is independently reviewed, merged,
fetched, and verified through the coordinator-absolute ledger verifier.

---

## Plan Author Forbidden-Vocabulary Scan and Self-Review

- [ ] Run this scan against this plan after every edit:

```bash
python3 - <<'PY'
from pathlib import Path

plan = Path('docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md')
content = plan.read_text()
blocked = [
    ''.join(chr(value) for value in [84, 79, 68, 79]),
    ''.join(chr(value) for value in [84, 66, 68]),
    ''.join(chr(value) for value in [112, 108, 97, 99, 101, 104, 111, 108, 100, 101, 114]),
    ''.join(chr(value) for value in [112, 97, 116, 104, 45, 116, 111]),
    ''.join(chr(value) for value in [60, 112, 97, 116, 116, 101, 114, 110, 62]),
    ''.join(chr(value) for value in [82, 69, 83, 85, 76, 84, 73, 78, 71]),
]
hits = [word for word in blocked if word in content]
if hits:
    raise SystemExit(f'disallowed vocabulary found: {hits}')
print('vocabulary scan: clean')
PY
```

- [ ] Verify the exact title, worker header, structure, paths, and scoped diff:

````bash
python3 - <<'PY'
import re
import shlex
from pathlib import Path

plan = Path('docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md')
content = plan.read_text()
lines = content.splitlines()
expected_title = '# AquaMobil V4 VFD and Feeding Loop Implementation Plan'
expected_header = '> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.'
assert lines[0] == expected_title
header_lines = []
for line in lines[2:]:
    if not line.startswith('> '):
        break
    header_lines.append(line.removeprefix('> '))
assert '> ' + ' '.join(header_lines) == expected_header
assert any(line.startswith('**Goal:**') for line in lines)
assert any(line.startswith('**Architecture:**') for line in lines)
assert any(line.startswith('**Tech Stack:**') for line in lines)
assert any(line.startswith('**Spec:**') for line in lines)
task_numbers = [
    int(line.split(':', 1)[0].removeprefix('### Task '))
    for line in lines
    if line.startswith('### Task ')
]
assert task_numbers == list(range(25))
assert sum(line.startswith('- [ ]') for line in lines) >= 90
task_offsets = [index for index, line in enumerate(lines) if line.startswith('### Task ')]
for position, start in enumerate(task_offsets):
    end = task_offsets[position + 1] if position + 1 < len(task_offsets) else len(lines)
    task_lines = lines[start:end]
    assert '**Interfaces:**' in task_lines, lines[start]

task_matches = list(re.finditer(r'^### Task (\d+):', content, re.MULTILINE))
task_contents = {}
staged_union_protocol_tasks = []
self_review_offset = content.index('\n## Plan Author Forbidden-Vocabulary Scan and Self-Review')
for position, task_match in enumerate(task_matches):
    task_number = int(task_match.group(1))
    task_end = (
        task_matches[position + 1].start()
        if position + 1 < len(task_matches)
        else self_review_offset
    )
    task_contents[task_number] = content[task_match.start():task_end]
    if task_number == 23:
        continue
    task_content = task_contents[task_number]
    files_match = re.search(r'\*\*Files:\*\*([\s\S]*?)\*\*Interfaces:\*\*', task_content)
    assert files_match, f'Task {task_number}: missing file map'
    file_paths = re.findall(
        r'^- (?:Create|Modify|Delete|Regenerate):\s+`([^`]+)`',
        files_match.group(1),
        re.MULTILINE,
    )
    assert len(file_paths) == len(set(file_paths)), f'Task {task_number}: duplicate mapped path'
    logical_task_content = task_content.replace('\\\n', ' ')
    add_commands = re.findall(r'^git add -- (.+)$', logical_task_content, re.MULTILINE)
    assert add_commands, f'Task {task_number}: missing scoped add'
    staged_paths = [
        token
        for command in add_commands
        for token in shlex.split(command)
        if '${' not in token
    ]
    assert len(staged_paths) == len(set(staged_paths)), f'Task {task_number}: duplicate staged path'
    assert sorted(staged_paths) == sorted(file_paths), (
        f'Task {task_number}: file map and staged paths diverge'
    )
    format_scope_path = 'tools/quality/format-scope.json'
    assert file_paths.count(format_scope_path) == 1, (
        f'Task {task_number}: format-scope missing from file map'
    )
    assert task_content.count('git add --') == 2, (
        f'Task {task_number}: expected task-owned and format-scope adds'
    )
    protocol_markers = [
        'mapfile -t vfd_task_owned_staged_paths < <(',
        'npm run quality:format-scope:generate',
        'git add -- tools/quality/format-scope.json',
        'npm run quality:format-scope:check',
        'tools/quality/format-scope.json | LC_ALL=C sort -u',
        'git diff --cached --check',
    ]
    marker_offsets = [task_content.index('git add --')]
    for marker in protocol_markers:
        assert task_content.count(marker) == 1, (
            f'Task {task_number}: staged-union marker count diverges for {marker}'
        )
        marker_offsets.append(task_content.index(marker))
    assert marker_offsets == sorted(marker_offsets), (
        f'Task {task_number}: staged-union protocol order diverges'
    )
    staged_union_protocol_tasks.append(task_number)
    has_generated_migration = 'Generated output contract: exactly one newly added' in files_match.group(1)
    generated_stage = re.search(
        r'git add -- "\$\{[A-Za-z0-9_]+_generated_files\[0\]\}"',
        task_content,
    )
    assert bool(generated_stage) == has_generated_migration, (
        f'Task {task_number}: generated migration staging diverges'
    )
assert staged_union_protocol_tasks == [*range(23), 24]
assert sum(line == 'npm run quality:format-scope:generate' for line in lines) == 24
assert sum(line == 'npm run quality:format-scope:check' for line in lines) == 24
allocation_match = re.search(
    r'''^VFD_FINDING_INVENTORY="\$\(cat <<'FINDINGS'\n([\s\S]*?)\nFINDINGS\n\)"$''',
    task_contents[0],
    re.MULTILINE,
)
assert allocation_match
allocation_rows = [
    row.split('\t')
    for row in allocation_match.group(1).splitlines()
    if row.strip()
]
assert all(len(row) == 3 for row in allocation_rows)
allocation_domains = [row[0] for row in allocation_rows]
allocation_titles = [row[1] for row in allocation_rows]
assert set(allocation_domains) == {'SENSOR', 'FARM', 'MOB'}
assert len(allocation_titles) == 22
assert len(set(allocation_titles)) == 22
candidate_titles = []
review_path = 'docs/reviews/codex/2026-08-26-aquamobil-v4-vfd-feeding-loop.md'
for task_number in range(1, 23):
    task_content = task_contents[task_number]
    title_matches = re.findall(r"jq -r --arg title '([^']+)'", task_content)
    assert len(title_matches) == 1, f'Task {task_number}: expected one owned title lookup'
    candidate_titles.extend(title_matches)
    expected_domain_gate = (
        f'[[ "${{task{task_number}_finding_ids[0]}}" =~ '
        f'^{allocation_domains[task_number - 1]}-HIGH-[0-9]{{3}}$ ]]'
    )
    assert expected_domain_gate in task_content, (
        f'Task {task_number}: missing exact finding-domain gate'
    )
    assert task_content.count(f'Closes: {review_path}#%s') == 1, (
        f'Task {task_number}: expected one final trailer candidate'
    )
assert candidate_titles == allocation_titles
assert sum(
    line.startswith('git commit -m "$(printf') and f'Closes: {review_path}#%s' in line
    for line in lines
) == 22
for slice_id, task_number in [('F3', 0), ('F4', 6), ('F5', 15), ('V6', 20)]:
    preflight_path = f'docs/superpowers/evidence/aquamobil-v4/slices/{slice_id}/preflight.json'
    assert preflight_path in task_contents[task_number]
    assert re.search(rf'git add --[\s\S]*?{re.escape(preflight_path)}', task_contents[task_number])
for forbidden_pattern in [
    r'git fetch origin --' + 'prune',
    r'git switch (?:-c|--create)',
    r'git worktree (?:add|remove)',
    r'feat/feeding-f[345][^\n` ]*(?:contract|enforce)',
    r'closingCommitsBy' + 'Finding',
    r'--audit-' + 'json',
]:
    assert not re.search(forbidden_pattern, content), forbidden_pattern
coord_tool_fragment = 'tools/' + 'aquamobil-v4/'
audit_mapper_fragment = 'scripts/ci/' + 'audit-source-map.mjs'
for line in lines:
    if coord_tool_fragment in line or audit_mapper_fragment in line:
        assert '"$COORDINATOR_WORKTREE/' in line, line
singular_jest_flag = ''.join(chr(value) for value in [45, 45, 116, 101, 115, 116, 80, 97, 116, 104, 80, 97, 116, 116, 101, 114, 110, 61])
assert singular_jest_flag not in content
assert sum(line.startswith('mapfile -t task') and '_finding_ids' in line for line in lines) == 22
assert sum(line.startswith('git commit ') for line in lines) == 24
assert sum(line.startswith('git push ') for line in lines) == 25
print('plan structure: verified')
PY
python3 - <<'PY'
import re
import subprocess
from pathlib import Path

plan = Path('docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md')
blocks = re.findall(r'^```bash\n([\s\S]*?)^```$', plan.read_text(), re.MULTILINE)
assert blocks
for index, block in enumerate(blocks, start=1):
    result = subprocess.run(['bash', '-n'], input=block, text=True, capture_output=True)
    if result.returncode != 0:
        raise SystemExit(f'bash fence {index} failed syntax validation:\n{result.stderr}')
print(f'bash fences: {len(blocks)} verified')
PY
npx prettier --check docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md
git diff --check -- docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md
set +e
git diff --no-index --check /dev/null docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md
plan_no_index_status=$?
set -e
test "$plan_no_index_status" -eq 1
git status --short -- docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md
````

Expected: both Python checks print their success lines, Prettier and diff checks pass, and the
scoped status names only this plan file.
