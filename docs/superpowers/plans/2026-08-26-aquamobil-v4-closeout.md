# AquaMobil V4 Safe Integration Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that every accepted behavior from `feature/aquamobil-v4-redesign` is safely present
on protected `main`, every rejected history object has reproducible evidence, every authority and
security gate is green, and any later approved source PR/branch action has a fresh observed receipt
while recoverable provenance remains protected.

**Architecture:** The protected bootstrap owns immutable schemas and source history. Sixteen slice
records and five closure records feed one generated 33-row non-merge ledger; two content-addressed
merge-resolution records complete the exact 35-object source range. A tooling PR installs one
cross-system workflow, an exact tooling-main dispatch feeds the report PR, and an exact report-main
dispatch feeds a protected signed provenance archive. Source PR closure and source deletion remain
separately approved actions. Any run with at least one approval uses a persistent two-phase journal
and ends in a fresh-clone receipt PR even when an action fails or remains ambiguous; the
neither-approved state creates neither journal nor receipt.

**Tech Stack:** Node.js 22, npm 10, Git, GitHub CLI/API, GitHub Actions, Nx, Jest, Vitest,
Playwright, TypeScript, TypeORM/PostgreSQL, NATS/JetStream mTLS, GraphQL codegen, Docker, Trivy,
nginx

**Spec:** `docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md`

## Global Constraints

- Start only after all 16 implementation slices and all five fixed closure records have been
  reconciled through protected `main`. An open, stacked, or implementation-only branch is not a
  closeout input.
- Immutable anchors are source tip `542c8e0bb7ff3afbeee0496f277f8926526cc41a`, merge base
  `8d8d54365ada11d45b43374af76e9814c5958ff0`, and refreshed planning main
  `4002868c535a2d8676aad6eadd5f4bbd57d4625b`. At refresh time the source is 219 commits behind and
  35 ahead.
- The source-only range is exactly 35 Git commits: 33 non-merge ledger rows plus merge commits
  `d6cc9d889b26a2566fe0211868e8faf7f2b34b23` and `1cae13834df31b4f5f982785e27b68d717d3de0b`. A
  33-only completion claim fails.
- Treat the source branch as read-only provenance. Never merge, rebase, cherry-pick, revert, or add
  an `ours` or empty ancestry marker from it.
- A changed remote source tip is new scope. Stop before reporting supersession, tagging, closing a
  PR, or deleting a branch.
- `.github/manifests/postgres-image.json` remains the only PostgreSQL digest authority.
  `infrastructure/ci/image-digests.json`, created by Delivery Task 1, is a closed resolver manifest:
  PostgreSQL points to that existing manifest at `/image`, and only Redis, nginx, MinIO, NATS, and
  Mosquitto carry inline pins. Closeout consumes it through the I1-owned
  `scripts/ci/resolve-ci-image.mjs`; no copied PostgreSQL digest or workflow-specific image manifest
  is allowed.
- Generated GraphQL, NATS, service-catalog, storage-route, CSP, migration-manifest, and format-scope
  outputs are fresh only when their owning generators leave no diff.
- High or critical findings on an affected production runtime or release-build path block closeout.
  No audit fixer, aggregate-count waiver, `ignore-unfixed`, or manually asserted reachability is
  accepted.
- Only `tools/aquamobil-v4/generate-closeout-report.mjs` may write
  `docs/superpowers/evidence/aquamobil-v4/final-verification.md`.
- Preserve every exact uppercase `Closes:` trailer through protected merges. Commit-preserving
  merges retain the closing commit; squash merges contain every reviewed trailer exactly once.
  Post-merge reconciliation must prove each closing SHA is main-reachable.
- The honest status is **semantically superseded**, not Git-merged. The source tip must remain a
  non-ancestor of `main`.
- The signed archive tag and active tag-ruleset proof are mandatory before asking for either remote
  action approval. If archive creation, signature verification, ruleset proof, or fresh-clone
  recovery fails, retain the source branch and PR #1107.
- Closing PR #1107 and deleting `feature/aquamobil-v4-redesign` are distinct destructive actions.
  Run only the target or targets named in a new explicit approval issued after archive merge.
- An approved-action run uses the one coordinator-owned persistent journal below the Git common
  directory. Every remote command, including source-branch ruleset installation, receives a durable
  intent and pre-observation before execution, then a durable result and post-observation before any
  other fallible operation. Restart always resumes and reconciles that hash chain; it never infers
  an action from final state alone or discards a successful, failed, or ambiguous attempt.
- Branch deletion never uses `--force` or `--force-with-lease`. After explicit delete approval, an
  exact-ref repository ruleset with no bypass actors must be active and effective: branch creation
  and update are restricted, deletion is not restricted, and the source tip is revalidated after the
  freeze. The ruleset remains active after successful deletion to prevent recreation; removing or
  weakening it requires separate future authorization.
- Immediately before every closeout tooling, report, archive, or receipt merge, invoke Order 0's
  generic protected-PR verifier with the exact PR/head/kind plus `--verify-base-advance` and
  `--require-latest-merge-queue-candidate`. It must make the current no-overlap or
  normal-main-merge-and-rereview decision and bind required workflows to the latest synthetic
  candidate; an earlier approval, stale base, or PR-head-only run blocks merge.
- Retain `/var/aqua-saas/.worktrees/aquamobil-v4-coordinator` from Order 0, keep it clean and
  detached at the exact fetched `origin/main`, and use its absolute Order 0
  orchestration/evidence-tool paths for local coordination. `/var/aqua-saas` is only the Git common
  directory through `git -C`; never run repository tools or npm from that dirty/user-owned checkout.
  A tool newly authored by a branch under review runs from that clean branch worktree until it
  merges. Checked-out CI scripts, workflows, and package commands remain repository-local and
  portable; their exact head, workflow, and tool blobs provide the attestation because hosted
  runners do not have the persistent local coordinator.
- Every closeout `.mjs` later executed from the persistent coordinator imports only `node:`
  built-ins; its unit tests reject bare-package or `node_modules` resolution. Fresh branch worktrees
  still run their lock-hashed installs for tests, builds, audits, and npm-backed repository
  commands.
- Every task that commits has `tools/quality/format-scope.json` as a conditional generated `Modify`
  path. First stage every task-owned create/modify/delete path, then run the exact block below
  immediately before each `git commit`; an earlier generator call in a task is only a preview and
  does not replace this post-stage run:

  ```bash
  npm run quality:format-scope:generate
  git add -- tools/quality/format-scope.json
  npm run quality:format-scope:check
  git diff --cached --check
  ```

---

### Task 1: Freeze terminal implementation and closure inputs

**Files:**

- Create: `docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json`
- Modify: `tools/aquamobil-v4/verify-ledger.mjs`
- Modify: `tools/aquamobil-v4/verify-ledger.spec.mjs`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: the protected bootstrap schemas, 16 append-only slice preflights, 16 immutable slice
  merge records, five immutable closure records, and the generated central ledger.
- Produces: schema-versioned `CloseoutInputs` and strict 35-object terminal modes.

```ts
interface CloseoutInputs {
  readonly schemaVersion: 3;
  readonly repository: 'Okan-wqm/aquaculture_platform';
  readonly originalSourceRef: 'origin/feature/aquamobil-v4-redesign';
  readonly provenanceRef:
    | null
    | 'refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly expectedSourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly observedSourceCommit: string;
  readonly behaviorMainCommit: string;
  readonly collectedAt: string;
}
```

- [ ] **Step 1: Create and enter the exact closeout worktree**

```bash
repo_root=/var/aqua-saas
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
closeout_worktree="$repo_root/.worktrees/aquamobil-v4-closeout"
test "$repo_root" = "/var/aqua-saas"
test -d "$COORDINATOR_WORKTREE"
test ! -e "$closeout_worktree"
git -C "$repo_root" fetch --prune origin \
  +refs/heads/main:refs/remotes/origin/main \
  +refs/heads/feature/aquamobil-v4-redesign:refs/remotes/origin/feature/aquamobil-v4-redesign
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C "$repo_root" rev-parse origin/main)"
git -C "$repo_root" worktree add "$closeout_worktree" \
  -b chore/aquamobil-v4-integration-closeout origin/main
cd "$closeout_worktree"
test "$(pwd -P)" = "/var/aqua-saas/.worktrees/aquamobil-v4-closeout"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
```

Expected: every command through Task 4 runs in the clean fixed worktree at fetched protected main;
neither dependency tree is copied or symlinked from another checkout.

- [ ] **Step 2: Write failing terminal-state and boundary tests**

Add fixtures proving these modes fail closed:

- `--require-slice-terminal --allow-exclusions-pending` accepts only the three exact non-merge
  exclusions as pending and requires every expected implementation boundary and closure record;
- `--require-terminal` accepts no planned or pending row or merge-resolution record;
- the source-history file contains exactly 35 unique full SHAs in Git order, the ledger exactly 33
  non-merge rows, and merge-resolutions exactly the two known merge SHAs;
- every `implementationBoundaries` list exactly matches the ordered IDs in `slice-branches.json`;
- every boundary's preflight base is an ancestor of its latest reviewed base, its canonical
  base-advance audit proves either zero owned/shared-authority overlap or an exact normal-main-merge
  resolution with post-merge gates and distinct re-review, its required workflows attest the exact
  latest merge-queue candidate/base/tool blobs, and that tested candidate tree equals the resulting
  main tree;
- every PR/run attestation is repository-bound, successful, immutable, and main-reachable;
- every closure file has its pinned owner-slice set and exact live finding-ID set; and
- a source SHA can never be used as a resulting-main SHA.

```bash
node --test tools/aquamobil-v4/verify-ledger.spec.mjs
```

Expected: FAIL on the first unsupported terminal assertion.

- [ ] **Step 3: Implement strict 35-object and main-ancestry verification**

`verify-ledger.mjs` resolves every durable source/base/result SHA with `git cat-file -e`, verifies
result ancestry with `git merge-base --is-ancestor`, and checks the exact implementation-boundary
and closure inventories. A merge-queue candidate may be ephemeral after merge, so its attested
workflow artifact stores both candidate commit and tree OIDs; verification recomputes
`resultingMainCommit^{tree}` and requires equality with both recorded tree fields. A normal
main-into-branch merge may likewise disappear after a squash, so its ordered parents, tree, and
GitHub commit-response digest are stored and revalidated through the repository API. It also
recomputes every canonical base-advance changed-path digest and validates the exclusive `no-overlap`
or `merged-main-and-rereviewed` state, rejects an untested later base/head or candidate/result tree
mismatch, and distinguishes the 33 non-merge dispositions from the two merge resolutions. Add this
capture contract:

```text
--write-closeout-inputs docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json
--repository Okan-wqm/aquaculture_platform
--source-ref origin/feature/aquamobil-v4-redesign
--expected-source 542c8e0bb7ff3afbeee0496f277f8926526cc41a
--main-ref origin/main
```

Capture resolves refs itself, validates the source before writing, sets `provenanceRef` to null, and
records the protected main that already contains all accepted behavior as `behaviorMainCommit`. It
does not call that SHA the later tooling, report, archive, or receipt main SHA.

```bash
node --test tools/aquamobil-v4/verify-ledger.spec.mjs
npm run aquamobil:v4:provenance:check -- \
  --require-slice-terminal \
  --allow-exclusions-pending \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2 \
  --verify-main-ancestors origin/main
```

Expected: PASS only after every slice boundary and all five closure reconciliations are on main.

- [ ] **Step 4: Generate inputs without transcription and commit them**

```bash
test "$(git rev-parse origin/feature/aquamobil-v4-redesign)" = \
  "542c8e0bb7ff3afbeee0496f277f8926526cc41a"
test "$(git merge-base origin/main origin/feature/aquamobil-v4-redesign)" = \
  "8d8d54365ada11d45b43374af76e9814c5958ff0"
node tools/aquamobil-v4/verify-ledger.mjs \
  --write-closeout-inputs docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json \
  --repository Okan-wqm/aquaculture_platform \
  --source-ref origin/feature/aquamobil-v4-redesign \
  --expected-source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --main-ref origin/main
git add -- \
  docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json \
  tools/aquamobil-v4/verify-ledger.mjs \
  tools/aquamobil-v4/verify-ledger.spec.mjs
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): freeze v4 closeout inputs" \
  -m "Bind closeout to the unchanged source anchor and the protected main containing every reconciled implementation and finding closure."
git push --set-upstream origin chore/aquamobil-v4-integration-closeout
```

---

### Task 2: Make all five exclusions reproducible

**Files:**

- Create: `tools/aquamobil-v4/verify-exclusions.mjs`
- Create: `tools/aquamobil-v4/verify-exclusions.spec.mjs`
- Create: `docs/superpowers/evidence/aquamobil-v4/exclusions.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/execution-ledger.json` only through
  `reconcile-ledger.mjs --write`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: immutable source Git objects, protected-main verification runs, and bootstrap schemas.
- Produces: three non-merge exclusion records plus two deterministic merge-resolution records,
  yielding `35 = 33 + 2` terminal objects.

```ts
interface ExclusionRecord {
  readonly sourceCommit: string;
  readonly reason: 'documentation-reflow' | 'format-only' | 'independent-invariant-maintenance';
  readonly changedPaths: readonly string[];
  readonly sourceObjectDigestSha256: string;
  readonly normalizedBlobPairs: readonly {
    readonly path: string;
    readonly parentBlob: string;
    readonly sourceBlob: string;
    readonly parentNormalizedSha256: string;
    readonly sourceNormalizedSha256: string;
  }[];
  readonly currentMainVerification: readonly GitHubWorkflowRunAttestation[];
}
```

- [ ] **Step 1: Write failing real-Git exclusion tests**

Pin these exact non-merge scopes:

```ts
const expectedExcludedPaths = {
  '2425e769841cd18fb7be030a1c61922a3717a52c': [
    'docs/architecture/feeding-system.md',
    'docs/illustrator/farm-modulu-sema-anlatim.md',
    'docs/illustrator/farm-modulu-sema-gorsel.md',
  ],
  '542c8e0bb7ff3afbeee0496f277f8926526cc41a': ['tests/invariants/farm-tank-count-ssot.spec.ts'],
} as const;
```

For `ccaead92dd6ff84987cd4235d68cc7cb1d8ab4ae`, derive its exact 123 TS/TSX paths from Git, format
parent and child blobs with the repository's locked Prettier, and require equal normalized SHA-256
values for every pair. Never use `git diff -w` as semantic evidence.

Pin the two merge records to these content-addressed Git objects:

| Merge                                      | Ordered parents                                                                        | Result tree                                | Result blobs in orphan-review, format-scope order                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `d6cc9d889b26a2566fe0211868e8faf7f2b34b23` | `b4b2f653cb7fc0cfb7328890fa8abb8f3e83c4d0`, `8d8d54365ada11d45b43374af76e9814c5958ff0` | `8d22e50aa070d0c36e9b82aff29247151e42b897` | `279ec1dba8ee557ee6a86eb03d97349a39ec0d7c`, `a23838b45be7ea883a4e226c5ff75dc8b3a7a8f3` |
| `1cae13834df31b4f5f982785e27b68d717d3de0b` | `bcac0a73e55e7a7687b23674d7f526f1408239c5`, `1acda8a012aff0f492c9af13ea111f91da56ad44` | `a13ce39d6ee34af1e609efa9febacf4891998265` | `f35863b4ff8152e78973ddcdf8b5899c32bc44b8`, `8e42aa04a69f5893c68325e8faeb598f017808a2` |

Both resolution-path lists are exactly `docs/reviews/orphan-findings.md` and
`tools/quality/format-scope.json`. Reject a hash of rendered remerge-diff output.

```bash
node --test tools/aquamobil-v4/verify-exclusions.spec.mjs
```

Expected: FAIL because the read-only verifier is absent.

- [ ] **Step 2: Generate and reconcile exact exclusions**

Use `git diff-tree`, `git cat-file`, `git show SHA:path`, `commit^{tree}`, locked Prettier, and
typed GitHub run capture. Reject an unexpected path, missing blob, parser failure, normalized
mismatch, foreign run, short SHA, changed source tip, or source object outside the frozen range.
`sourceObjectDigestSha256` hashes canonical JSON containing the ordered path plus parent/source blob
OID pairs with UTF-8 encoding and one trailing newline. Rendered diff, textconv, terminal color, and
remerge-diff text are never digest authority.

```json
"aquamobil:v4:exclusions:check": "node tools/aquamobil-v4/verify-exclusions.mjs --check docs/superpowers/evidence/aquamobil-v4/exclusions.json --check-merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json"
```

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin \
  +refs/heads/main:refs/remotes/origin/main \
  +refs/heads/feature/aquamobil-v4-redesign:refs/remotes/origin/feature/aquamobil-v4-redesign
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd /var/aqua-saas/.worktrees/aquamobil-v4-closeout
node tools/aquamobil-v4/verify-exclusions.mjs \
  --write docs/superpowers/evidence/aquamobil-v4/exclusions.json \
  --write-merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --apply-exclusions docs/superpowers/evidence/aquamobil-v4/exclusions.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --main-ref origin/main \
  --write docs/superpowers/evidence/aquamobil-v4/execution-ledger.json
npm run aquamobil:v4:exclusions:check
npm run aquamobil:v4:provenance:check -- \
  --require-terminal \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2 \
  --verify-main-ancestors origin/main
```

- [ ] **Step 3: Recheck documentation and invariant outcomes reproducibly**

```bash
npm install --save-dev --save-exact --ignore-scripts markdownlint-cli@0.45.0
npm exec -- markdownlint \
  docs/architecture/feeding-system.md \
  docs/illustrator/farm-modulu-sema-anlatim.md \
  docs/illustrator/farm-modulu-sema-gorsel.md
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/farm-tank-count-ssot.spec.ts
npm run aquamobil:v4:exclusions:check
```

Expected: the locked linter, current-main tank-count authority, and all five exclusions pass.

- [ ] **Step 4: Commit and push the exclusion reconciliation**

```bash
git add -- \
  tools/aquamobil-v4/verify-exclusions.mjs \
  tools/aquamobil-v4/verify-exclusions.spec.mjs \
  docs/superpowers/evidence/aquamobil-v4/exclusions.json \
  docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  package.json package-lock.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "test(aquamobil): make v4 exclusions reproducible" \
  -m "Prove three non-merge exclusions and two merge resolutions from immutable Git objects before the 35-object ledger becomes terminal."
git push origin chore/aquamobil-v4-integration-closeout
```

---

### Task 3: Prove duplicate authorities and unsafe compatibility paths are absent

**Files:**

- Create: `tests/invariants/aquamobil-v4-authority-closeout.spec.ts`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: final authorities introduced by I1, V0 through V6, UI convergence, and F0 through F5.
- Produces: one structural sentinel; it owns no second business inventory.

- [ ] **Step 1: Write the failing authority-manifest test**

Require these exact specs to exist and be selected by the invariant project:

```ts
const requiredAuthoritySpecs = [
  'tests/invariants/mobile-asset-serving.spec.ts',
  'tests/invariants/mobile-csp-headers.spec.ts',
  'tests/invariants/mobile-object-storage-boundary.spec.ts',
  'tests/invariants/aquamobil-build-generation.spec.ts',
  'tests/invariants/aquamobil-generated-input-authority.spec.ts',
  'tests/invariants/aquamobil-vfd-actuation-offline-boundary.spec.ts',
  'tests/invariants/ci-image-digests.spec.ts',
  'tests/invariants/farm-stock-mutation-central-only.spec.ts',
  'tests/invariants/postgres-image-uniformity.spec.ts',
  'tests/invariants/sensor-parameter-catalog-ssot.spec.ts',
  'tests/invariants/upcaster-chain.spec.ts',
] as const;
```

Also require one standalone AquaMobil test script and lock root; one positive offline-mutation
whitelist from `OperationType`; generated NATS grants only between sentinels in
`infrastructure/nats/services.yaml`; public routes only from
`infrastructure/storage/public-object-routes.json`; and tenant entities without hard-coded schemas.
Reject Konsta, its patch script, `theme-init.js`, handwritten `CreateWaterQualityInput`,
`pwa/actuation-commands.ts`, a restored `sensor_readings` table, a second feed-stock writer, or a
second server actuation-root list. The image pair is structural, not a second digest inventory: the
CI resolver invariant proves the closed external-pointer/inline schema and sole portable CLI, while
the existing PostgreSQL uniformity invariant remains owner of the referenced PostgreSQL image value
and consumers.

```bash
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-v4-authority-closeout.spec.ts
```

Expected: FAIL because the sentinel is absent.

- [ ] **Step 2: Add the structural sentinel and run all authority proofs**

The sentinel imports the actuation roots from the sensor-service contract through the existing
boundary test and inspects migration/entity ASTs. It never copies mutation names, table names, or
generated route contents into a second hand-maintained list.

```bash
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath \
  tests/invariants/aquamobil-v4-authority-closeout.spec.ts \
  tests/invariants/mobile-asset-serving.spec.ts \
  tests/invariants/mobile-csp-headers.spec.ts \
  tests/invariants/mobile-object-storage-boundary.spec.ts \
  tests/invariants/aquamobil-build-generation.spec.ts \
  tests/invariants/aquamobil-generated-input-authority.spec.ts \
  tests/invariants/aquamobil-vfd-actuation-offline-boundary.spec.ts \
  tests/invariants/farm-stock-mutation-central-only.spec.ts \
  tests/invariants/sensor-parameter-catalog-ssot.spec.ts \
  tests/invariants/upcaster-chain.spec.ts
npm --prefix web/apps/aquamobil run test:invariant
npm run storage:public-routes:check
```

Expected: one authority for UI, GraphQL inputs, offline mutation policy, stock writes, actuation,
NATS grants, storage routes, tenant routing, and event history.

- [ ] **Step 3: Commit and push the sentinel**

```bash
git add -- \
  tests/invariants/aquamobil-v4-authority-closeout.spec.ts
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "test(aquamobil): lock v4 integration authorities" \
  -m "Keep mobile, feeding, event, storage, and VFD boundaries singular after semantic supersession."
git push origin chore/aquamobil-v4-integration-closeout
```

---

### Task 4: Merge one reproducible cross-system closeout gate

**Files:**

- Create: `scripts/ci/aquamobil-v4-closeout.sh`
- Create: `.github/workflows/aquamobil-v4-closeout.yml`
- Create: `tests/invariants/aquamobil-v4-closeout-workflow.spec.ts`
- Create: `tools/aquamobil-v4/normalize-closeout-artifact.mjs`
- Create: `tools/aquamobil-v4/normalize-closeout-artifact.spec.mjs`
- Create: `tools/aquamobil-v4/capture-closeout-run.mjs`
- Create: `tools/aquamobil-v4/capture-closeout-run.spec.mjs`
- Modify: `.github/workflows/ci-affected.yml`
- Modify: `.github/workflows/ci-full.yml`
- Modify: `.github/manifests/main-required-status-checks.json`
- Modify: `tests/invariants/aquamobil-build-generation.spec.ts`
- Modify: `infrastructure/ci/image-digests.json` only for a separately reviewed digest rotation;
  otherwise consume it byte-for-byte
- Modify: `tools/quality/format-scope.json`

No-change runtime inputs: `scripts/ci/aquamobil-delivery-smoke.sh`,
`scripts/nats/messaging-acl-smoke-harness.sh`, and `scripts/nats/feeding-acl-smoke-harness.sh`.
Their owning implementation plans must already make them invoke the portable I1-owned resolver
`node scripts/ci/resolve-ci-image.mjs --manifest infrastructure/ci/image-digests.json --image <closed-key>`;
closeout verifies and runs them without taking ownership.

**Interfaces:**

- Consumes: exact digest pins, clean installs, PostgreSQL/Redis, Docker, generated authorities,
  terminal provenance, and all detailed-plan tests.
- Produces: a reusable required workflow, five redacted normalized artifacts under the already
  ignored `artifacts/` tree, and an exact-main dispatch/capture client. It does not write the
  report.

- [ ] **Step 1: Write workflow and artifact-boundary tests first**

Require `workflow_call` and `workflow_dispatch` inputs `expectedHead` and `requestId`; read-only
permissions; Node 22; pinned Python 3.12 and `pyyaml==6.0.2`; local pinned Rust setup; 90-minute
timeout; `fetch-depth: 0`; `persist-credentials: false`; no `continue-on-error`; and an
`if: always()` upload restricted to these non-hidden ignored paths:

```text
artifacts/aquamobil-v4-closeout/normalized/result.json
artifacts/aquamobil-v4-closeout/normalized/audit-root.json
artifacts/aquamobil-v4-closeout/normalized/audit-aquamobil.json
artifacts/aquamobil-v4-closeout/normalized/dependency-reachability.json
artifacts/aquamobil-v4-closeout/normalized/trivy-aquamobil.json
```

Reject `.artifacts`, broad directory uploads, globs, raw logs, credentials, cookies, headers,
tokens, URL query values, environment dumps, and absolute checkout paths. Require `ci-affected` to
join the called job to `merge-gate` when closeout-owned paths change, `ci-full` to join it to
`build-status`, and the required-status manifest to keep those existing aggregate contexts. Also
require both normal and `--ignore-scripts` standalone install/build matrices, full 40-hex build ID,
byte-identical output manifests, byte-identical real-production Vite/Rollup module manifests from
the audit-only Order 0 plugin, unchanged root/standalone lockfiles, and resolver-only access to
every CI fixture image. Tests reject a direct image literal in the workflow or harnesses, another
resolver manifest, or a PostgreSQL digest copied out of `.github/manifests/postgres-image.json`.
They also pin a receipt-file-conditional remote-state check: it is skipped only while the exact
receipt path is absent, uses the exact post-action live-reference path, accepts complete,
partial-failure, and ambiguous action outcomes only through the closed receipt schema, and queries
the effective rules for `feature/aquamobil-v4-redesign`. When delete approval is true, the effective
set must still restrict creation and update while omitting deletion restriction; the committed
administrative capture must prove the exact ruleset ID/configuration and empty bypass-actor set. The
GitHub token is exposed only to that single non-upload step. Both callers must grant the called job
the same exact two read permissions; write permissions, an administrative secret, or a broader
inherited token fail invariants.

```bash
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-v4-closeout-workflow.spec.ts
node --test tools/aquamobil-v4/normalize-closeout-artifact.spec.mjs \
  tools/aquamobil-v4/capture-closeout-run.spec.mjs
```

Expected: FAIL because the workflow and tools are absent.

- [ ] **Step 2: Install the pinned least-privilege workflow**

Use these exact action revisions:

```yaml
permissions:
  contents: read
  pull-requests: read

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    with:
      fetch-depth: 0
      persist-credentials: false
  - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
    with:
      node-version: '22'
      cache: npm
  - uses: actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1
    with:
      python-version: '3.12'
  - run: python3 -m pip install --quiet 'pyyaml==6.0.2'
  - uses: ./.github/actions/setup-rust-workspace
  - name: Verify post-action receipt against current remote state
    if: ${{ hashFiles('docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json') != '' }}
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      node tools/aquamobil-v4/capture-provenance-archive.mjs \
        --check-action-receipt docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
        --live-references docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
        --provenance-evidence docs/superpowers/evidence/aquamobil-v4/provenance-archive.json \
        --repository Okan-wqm/aquaculture_platform \
        --observe-remote
  - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
    if: always()
    with:
      name: aquamobil-v4-closeout-evidence
      path: |
        artifacts/aquamobil-v4-closeout/normalized/result.json
        artifacts/aquamobil-v4-closeout/normalized/audit-root.json
        artifacts/aquamobil-v4-closeout/normalized/audit-aquamobil.json
        artifacts/aquamobil-v4-closeout/normalized/dependency-reachability.json
        artifacts/aquamobil-v4-closeout/normalized/trivy-aquamobil.json
      if-no-files-found: error
```

The conditional is bootstrap-safe because no receipt can exist before Task 7 merges the capture
tool. Once the exact receipt path exists, a missing tool/live-reference/archive input, unavailable
API, recreated or moved source ref, reopened explicitly closed PR, invalid outcome transition,
approval/request disagreement, successful-action mismatch, missing branch-freeze proof, or other
matrix mismatch fails the required workflow. The read-only effective-branch-rules endpoint proves
that creation/update restrictions still apply even when the source branch is absent; the receipt's
administrative installation response and digest prove the exact ruleset ID and empty bypass list.
The later coordinator check repeats the full administrative ruleset query before journal cleanup.
`GH_TOKEN` is step-scoped, never written to an artifact, and the workflow has only `contents: read`
plus `pull-requests: read`.

The workflow fetches main explicitly before ledger checks:

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
provenance_ref="$(jq -r '.provenanceRef // empty' \
  docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json)"
if test -z "$provenance_ref"; then
  git fetch origin \
    +refs/heads/feature/aquamobil-v4-redesign:refs/remotes/origin/feature/aquamobil-v4-redesign
  test "$(git rev-parse origin/feature/aquamobil-v4-redesign)" = \
    "542c8e0bb7ff3afbeee0496f277f8926526cc41a"
else
  test "$provenance_ref" = \
    "refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a"
  git fetch origin \
    refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a:refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
  test "$(git rev-parse refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a^{commit})" = \
    "542c8e0bb7ff3afbeee0496f277f8926526cc41a"
fi
```

For a dispatch, checkout and `git rev-parse HEAD` must equal the required `expectedHead` input and
the normalized result must carry the required `requestId`. Called PR runs use their actual checked
out SHA and cannot be reused as exact-main report evidence.

The closed resolver manifest must contain exactly this object:

```json
{
  "schemaVersion": 1,
  "images": {
    "postgres": {
      "source": "external-manifest",
      "path": ".github/manifests/postgres-image.json",
      "jsonPointer": "/image"
    },
    "redis": {
      "source": "inline",
      "image": "redis:7.2.7-alpine@sha256:ddd16a9b1575a774c7e62956be8daa1de5b32cfb5c25b7a216aefed8e0919f9b"
    },
    "nginx": {
      "source": "inline",
      "image": "nginx:1.27.5-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10"
    },
    "minio": {
      "source": "inline",
      "image": "quay.io/minio/minio:RELEASE.2025-04-03T14-56-28Z@sha256:a640662d97632f7b94e9dee8cbb7da5c20db24879725cb4fac36f1e220cd528a"
    },
    "nats": {
      "source": "inline",
      "image": "nats:2.10.24-alpine@sha256:fd981e2ab99000964bd15286054e61fcc445732fd907db039f260fc0b824b314"
    },
    "mosquittoFixture": {
      "source": "inline",
      "image": "eclipse-mosquitto:2.0.22@sha256:212f89e1eaeb2c322d6441b64396e3346026674db8fa9c27beac293405c32b3c"
    }
  }
}
```

On every call, `resolve-ci-image.mjs` validates the entire closed schema and accepts only the
literal manifest path above plus one of the six exact image keys. The PostgreSQL key is the only
external entry and may resolve only the repo-contained `.github/manifests/postgres-image.json`
`/image` pointer; the other five must remain inline. Unknown fields/keys, cycles, escaping paths,
other JSON pointers, environment/manifest overrides, mutable tags, and non-64-lowercase-hex digests
fail. The CLI writes exactly the resolved digest plus one newline to stdout. Workflow services,
delivery smoke, and NATS/Mosquitto harnesses invoke this repo-local CLI; they never parse or copy a
digest.

Build local image `aquamobil-v4-closeout`, then run
`aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25` on exactly that tag with
`severity: HIGH,CRITICAL`, `ignore-unfixed: false`, JSON output, and `exit-code: 1`. An
`if: always()` normalization step sanitizes the raw JSON before the allowlisted upload. A detected
vulnerability still fails the job; normalization is not a waiver.

- [ ] **Step 3: Implement frontend, deployment, and image commands**

`aquamobil-v4-closeout.sh` uses `set -Eeuo pipefail` and an EXIT trap that always writes normalized
`result.json`. It records full HEAD, request ID, workflow path/event, command digest, UTC start/end,
raw exit code, classified result, and final trap status without command output.

```bash
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
export AQUAMOBIL_BUILD_ID="$v4_build_id"
mkdir -p artifacts/aquamobil-v4-closeout/raw
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
npm --prefix web/apps/aquamobil ci --no-audit
export AQUAMOBIL_AUDIT_MODULE_MANIFEST=artifacts/aquamobil-v4-closeout/raw/aquamobil-normal-vite-rollup-modules.json
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run test:invariant
npm --prefix web/apps/aquamobil run lint -- --no-cache
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil run fonts:check
npm --prefix web/apps/aquamobil run build
test -s artifacts/aquamobil-v4-closeout/raw/aquamobil-normal-vite-rollup-modules.json
find web/apps/aquamobil/dist -type f -print0 | sort -z | xargs -0 sha256sum \
  > artifacts/aquamobil-v4-closeout/raw/aquamobil-normal-install-build.sha256
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
export AQUAMOBIL_AUDIT_MODULE_MANIFEST=artifacts/aquamobil-v4-closeout/raw/aquamobil-ignore-scripts-vite-rollup-modules.json
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run test:invariant
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil run build
test -s artifacts/aquamobil-v4-closeout/raw/aquamobil-ignore-scripts-vite-rollup-modules.json
find web/apps/aquamobil/dist -type f -print0 | sort -z | xargs -0 sha256sum \
  > artifacts/aquamobil-v4-closeout/raw/aquamobil-ignore-scripts-build.sha256
cmp \
  artifacts/aquamobil-v4-closeout/raw/aquamobil-normal-install-build.sha256 \
  artifacts/aquamobil-v4-closeout/raw/aquamobil-ignore-scripts-build.sha256
cmp \
  artifacts/aquamobil-v4-closeout/raw/aquamobil-normal-vite-rollup-modules.json \
  artifacts/aquamobil-v4-closeout/raw/aquamobil-ignore-scripts-vite-rollup-modules.json
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
npm --prefix e2e ci --ignore-scripts --no-audit
npm --prefix e2e exec -- playwright install --with-deps chromium
npm --prefix e2e run test:mobile
npm --prefix e2e run test:mobile-pwa
npm --prefix e2e run test:mobile-edge
bash scripts/ci/aquamobil-delivery-smoke.sh
npm run csp:check
npm run gates:required-status-checks
docker build \
  --file infrastructure/docker/Dockerfile.aquamobil \
  --build-arg AQUAMOBIL_BUILD_ID="$AQUAMOBIL_BUILD_ID" \
  --tag aquamobil-v4-closeout .
```

- [ ] **Step 4: Implement backend, database, and event commands**

```bash
npx nx test event-contracts --runInBand --skip-nx-cache
npx nx test farm-service --runInBand --skip-nx-cache
npx nx run farm-service:test:integration --skip-nx-cache
npx nx run farm-service:e2e --skip-nx-cache
npx nx test sensor-service --runInBand --skip-nx-cache
npx nx test gateway-api --runInBand --skip-nx-cache
npx nx test invariants --runInBand --skip-nx-cache
npm run gates:migration-sql
npm run test:schema-invariants
npm run type-check
```

- [ ] **Step 5: Implement generated-interface and NATS freshness commands**

```bash
npm run schema:generate
npm run apollo-router:compose
npm run codegen
npm run codegen:check
npm run graphql:generate-registry-artifacts
npm run graphql:validate-registry
npm run gates:graphql-contracts
npm run service-catalog:check
npm run storage:public-routes:check
python3 scripts/nats/generate-nats-conf.py
npm run quality:format-scope:check
git diff --exit-code
npx jest --config e2e/jest.config.ts --runInBand --runTestsByPath \
  e2e/tests/integration/nats-invariants.spec.ts \
  e2e/tests/integration/nats-subject-contract.spec.ts
node --test \
  scripts/nats/messaging-acl-smoke.test.mjs \
  scripts/nats/feeding-acl-smoke.test.mjs
npm run smoke:nats-messaging-acl
npm run smoke:nats-feeding-acl
```

The existing messaging ACL harness remains messaging-only. The feeding ACL harness owns the
F2/F3/F4/F5/V6 certificate-CN grants. Both resolve `nats` through the fixed CLI, while delivery
smoke resolves `nginx`, `minio`, and `mosquittoFixture`; PostgreSQL/Redis workflow services use the
same interface. Closeout runs both static/unit and live harnesses and adds no third permission or
digest inventory.

- [ ] **Step 6: Implement deterministic supply-chain and terminal checks**

Capture audits even when npm returns an advisory exit code, then invoke the exact Order 0 mapper:

```bash
mkdir -p artifacts/aquamobil-v4-closeout/raw artifacts/aquamobil-v4-closeout/normalized
set +e
npm audit --json > artifacts/aquamobil-v4-closeout/raw/audit-root-full.json
audit_root_full_status=$?
npm audit --omit=dev --json > artifacts/aquamobil-v4-closeout/raw/audit-root-runtime.json
audit_root_runtime_status=$?
npm --prefix web/apps/aquamobil audit --json \
  > artifacts/aquamobil-v4-closeout/raw/audit-aquamobil-full.json
audit_aquamobil_full_status=$?
npm --prefix web/apps/aquamobil audit --omit=dev --json \
  > artifacts/aquamobil-v4-closeout/raw/audit-aquamobil-runtime.json
audit_aquamobil_runtime_status=$?
set -e
node tools/aquamobil-v4/normalize-closeout-artifact.mjs \
  --kind npm-audit-set \
  --root-full artifacts/aquamobil-v4-closeout/raw/audit-root-full.json \
  --root-runtime artifacts/aquamobil-v4-closeout/raw/audit-root-runtime.json \
  --aquamobil-full artifacts/aquamobil-v4-closeout/raw/audit-aquamobil-full.json \
  --aquamobil-runtime artifacts/aquamobil-v4-closeout/raw/audit-aquamobil-runtime.json \
  --exit-statuses "$audit_root_full_status,$audit_root_runtime_status,$audit_aquamobil_full_status,$audit_aquamobil_runtime_status" \
  --write-root artifacts/aquamobil-v4-closeout/normalized/audit-root.json \
  --write-aquamobil artifacts/aquamobil-v4-closeout/normalized/audit-aquamobil.json
node scripts/ci/audit-source-map.mjs \
  --capture-explain-set \
  --root-audit-full artifacts/aquamobil-v4-closeout/raw/audit-root-full.json \
  --root-audit-runtime artifacts/aquamobil-v4-closeout/raw/audit-root-runtime.json \
  --aquamobil-audit-full artifacts/aquamobil-v4-closeout/raw/audit-aquamobil-full.json \
  --aquamobil-audit-runtime artifacts/aquamobil-v4-closeout/raw/audit-aquamobil-runtime.json \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json artifacts/aquamobil-v4-closeout/raw/audit-set.json \
  --write-explain-set-json artifacts/aquamobil-v4-closeout/raw/npm-explain-set.json
node scripts/ci/audit-source-map.mjs \
  --audit-set-json artifacts/aquamobil-v4-closeout/raw/audit-set.json \
  --explain-set-json artifacts/aquamobil-v4-closeout/raw/npm-explain-set.json \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest artifacts/aquamobil-v4-closeout/raw/aquamobil-normal-vite-rollup-modules.json \
  --output-json artifacts/aquamobil-v4-closeout/normalized/dependency-reachability.json \
  --output-markdown artifacts/aquamobil-v4-closeout/raw/dependency-reachability.md
npm run aquamobil:v4:exclusions:check
npm run aquamobil:v4:provenance:check -- \
  --require-terminal \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2 \
  --verify-main-ancestors origin/main
npm run findings:verify
npm run format:check
git diff --check
```

Root and AquaMobil full/runtime audits are normalized separately. The mapper derives complete
root-to-package chains by invoking locked npm as `npm [--prefix <install>] explain <package> --json`
for each sorted high/critical package (never the invalid bare `npm explain --json`), production-lock
runtime class from both lock authorities, release-build class including direct `esbuild`, and
AquaMobil browser reachability from the deterministic real-production Vite/Rollup module manifest.
The direct esbuild appearance-IIFE graph is release-build evidence only and never substitutes for
the full browser bundle manifest. Any failed/missing explanation or reachable high/critical result
blocks the script; no `npm audit fix` is run.

- [ ] **Step 7: Make local tests and the no-cache runner green**

```bash
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-v4-closeout-workflow.spec.ts
node --test tools/aquamobil-v4/normalize-closeout-artifact.spec.mjs \
  tools/aquamobil-v4/capture-closeout-run.spec.mjs
bash scripts/ci/aquamobil-v4-closeout.sh
```

Expected: only the five redacted normalized upload files are publishable; raw files remain ignored
and ephemeral.

- [ ] **Step 8: Implement exact dispatch-and-capture semantics**

`capture-closeout-run.mjs --dispatch-and-wait` snapshots existing run IDs, generates a UUID request
ID, verifies `main` equals the expected full SHA, dispatches
`.github/workflows/aquamobil-v4-closeout.yml` on `main`, and requires exactly one new
`workflow_dispatch` run whose head, request ID, run attempt, workflow blob, conclusion, artifact ID,
artifact name, and server digest match. It downloads only the named artifact and validates all five
normalized files. Foreign repositories, PR heads, stale attempts, ambiguous runs, expired artifacts,
secret-like fields, URL queries, and absolute paths fail closed.

```bash
node --test tools/aquamobil-v4/capture-closeout-run.spec.mjs
```

- [ ] **Step 9: Commit, open, review, and merge the tooling PR**

```bash
git add -- \
  scripts/ci/aquamobil-v4-closeout.sh \
  .github/workflows/aquamobil-v4-closeout.yml \
  tests/invariants/aquamobil-v4-closeout-workflow.spec.ts \
  tools/aquamobil-v4/normalize-closeout-artifact.mjs \
  tools/aquamobil-v4/normalize-closeout-artifact.spec.mjs \
  tools/aquamobil-v4/capture-closeout-run.mjs \
  tools/aquamobil-v4/capture-closeout-run.spec.mjs \
  .github/workflows/ci-affected.yml \
  .github/workflows/ci-full.yml \
  .github/manifests/main-required-status-checks.json \
  tests/invariants/aquamobil-build-generation.spec.ts \
  infrastructure/ci/image-digests.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): add v4 cross-system closeout gate" \
  -m "Replay delivery, package, tenant, event, migration, NATS, generated-contract, image, and build-tool gates on an exact protected-main candidate."
git push origin chore/aquamobil-v4-integration-closeout
tooling_pr_url="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --head chore/aquamobil-v4-integration-closeout \
  --title "chore(aquamobil): add v4 cross-system closeout gate" \
  --body "Installs the required closeout workflow and reproducible 35-object verifiers; it does not claim semantic supersession.")"
tooling_pr_number="$(gh pr view "$tooling_pr_url" --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$tooling_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$tooling_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision,baseRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main")'
node "/var/aqua-saas/.worktrees/aquamobil-v4-coordinator/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$tooling_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind closeout-tooling \
  --expected-head chore/aquamobil-v4-integration-closeout \
  --verify-base-advance \
  --require-latest-merge-queue-candidate
```

After the authorized protected merge:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mapfile -t tooling_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform \
  --state merged --base main --head chore/aquamobil-v4-integration-closeout \
  --json number,title \
  --jq '.[] | select(.title == "chore(aquamobil): add v4 cross-system closeout gate") | .number')
test "${#tooling_pr_numbers[@]}" -eq 1
TOOLING_PR_NUMBER="${tooling_pr_numbers[0]}"
[[ "$TOOLING_PR_NUMBER" =~ ^[0-9]+$ ]]
TOOLING_MAIN_SHA="$(gh pr view "$TOOLING_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$TOOLING_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$TOOLING_MAIN_SHA" origin/main
git -C /var/aqua-saas cat-file -e "$TOOLING_MAIN_SHA:.github/workflows/aquamobil-v4-closeout.yml"
cd "$COORDINATOR_WORKTREE"
test "/var/aqua-saas/.worktrees/aquamobil-v4-closeout" != "/var/aqua-saas"
test -z "$(git -C /var/aqua-saas/.worktrees/aquamobil-v4-closeout status --porcelain)"
git -C /var/aqua-saas/.worktrees/aquamobil-v4-closeout switch --detach origin/main
git -C /var/aqua-saas merge-base --is-ancestor \
  "$(git -C /var/aqua-saas/.worktrees/aquamobil-v4-closeout rev-parse HEAD)" origin/main
git -C /var/aqua-saas worktree remove /var/aqua-saas/.worktrees/aquamobil-v4-closeout
test ! -e /var/aqua-saas/.worktrees/aquamobil-v4-closeout
```

---

### Task 5: Capture tooling-main and generate the sole supersession report

**Files:**

- Create: `tools/aquamobil-v4/generate-closeout-report.mjs`
- Create: `tools/aquamobil-v4/generate-closeout-report.spec.mjs`
- Create: `tools/aquamobil-v4/capture-live-references.mjs`
- Create: `tools/aquamobil-v4/capture-live-references.spec.mjs`
- Create: `docs/superpowers/evidence/aquamobil-v4/closeout-run-tooling-main.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/live-references.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/final-verification.md` only through the generator
- Modify: `package.json`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: exact tooling-main dispatch, terminal 35-object provenance, exclusions, closure records,
  and normalized live GitHub/Git state.
- Produces: deterministic Markdown. No manual edit to the report is accepted.

```ts
interface LiveReferences {
  readonly schemaVersion: 2;
  readonly repository: 'Okan-wqm/aquaculture_platform';
  readonly sourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly sourcePullRequest: {
    readonly number: 1107;
    readonly state: 'OPEN' | 'CLOSED';
    readonly isDraft: false;
    readonly headRefName: 'feature/aquamobil-v4-redesign';
    readonly headRefOid: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
    readonly baseRefName: 'main';
    readonly mergeStateStatus: string;
    readonly url: string;
  };
  readonly explicitPrCloseApproved: boolean;
  readonly explicitBranchDeleteApproved: boolean;
  readonly openPullRequests: readonly {
    readonly number: number;
    readonly state: 'OPEN';
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly url: string;
  }[];
  readonly coordinatorWorktree: {
    readonly head: string;
    readonly branch: null;
    readonly clean: true;
    readonly disposition: 'retained-intentionally' | 'cleanup-after-receipt-main';
  };
  readonly worktrees: readonly { readonly head: string; readonly branch: string | null }[];
  readonly sourceContainingRefs: readonly string[];
}
```

- [ ] **Step 1: Create and enter the exact report worktree**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mapfile -t tooling_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform \
  --state merged --base main --head chore/aquamobil-v4-integration-closeout \
  --json number,title \
  --jq '.[] | select(.title == "chore(aquamobil): add v4 cross-system closeout gate") | .number')
test "${#tooling_pr_numbers[@]}" -eq 1
TOOLING_PR_NUMBER="${tooling_pr_numbers[0]}"
TOOLING_MAIN_SHA="$(gh pr view "$TOOLING_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,mergeCommit \
  --jq 'select(.state == "MERGED" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-integration-closeout") | .mergeCommit.oid')"
[[ "$TOOLING_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$TOOLING_MAIN_SHA" origin/main
git -C /var/aqua-saas cat-file -e "$TOOLING_MAIN_SHA:.github/workflows/aquamobil-v4-closeout.yml"
report_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-report
test ! -e "$report_worktree"
git -C /var/aqua-saas worktree add "$report_worktree" \
  -b chore/aquamobil-v4-semantic-supersession origin/main
cd "$report_worktree"
test "$(git rev-parse HEAD)" = "$TOOLING_MAIN_SHA"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
```

- [ ] **Step 2: Dispatch exact tooling-main and commit normalized run evidence**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd /var/aqua-saas/.worktrees/aquamobil-v4-report
TOOLING_MAIN_SHA="$(git rev-parse HEAD)"
[[ "$TOOLING_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$TOOLING_MAIN_SHA" origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-closeout-run.mjs" \
  --dispatch-and-wait \
  --repository Okan-wqm/aquaculture_platform \
  --workflow .github/workflows/aquamobil-v4-closeout.yml \
  --ref main \
  --expected-head "$TOOLING_MAIN_SHA" \
  --artifact-name aquamobil-v4-closeout-evidence \
  --write docs/superpowers/evidence/aquamobil-v4/closeout-run-tooling-main.json
```

Expected: the committed JSON is a typed successful workflow-run attestation plus normalized command
digests, not a local result file or PR run.

- [ ] **Step 3: Write the failing deterministic report and live-reference tests**

Require these exact sections:

```ts
const requiredSections = [
  'Anchors and observed refs',
  '35-source-object disposition summary',
  '33 non-merge source dispositions',
  'Two merge-resolution dispositions',
  'Implementation boundaries and finding closures',
  'Generated artifact evidence',
  'Security and dependency reachability',
  'Migration and tenant isolation evidence',
  'Frontend delivery and PWA generation evidence',
  'Open pull requests and worktrees',
  'Approved source actions and observed state',
  'Protected provenance archive',
  'Semantic supersession statement',
] as const;
```

The source-action section is always present. Without a receipt it renders both approvals false, no
requested or successful actions, PR `OPEN`, and the exact present source tip from initial live
references. With a receipt it renders both approval booleans, receipt state, ordered requested
actions, every attempt outcome, the successful-action subset, separate control-plane steps, the
branch-freeze disposition, and the exact observed PR/head state. Unit fixtures cover all four
approval rows plus complete, partial-failure, and ambiguous executions and reject every cross-file
mismatch.

Require this literal sentence:

```text
The source branch is semantically superseded; its tip is intentionally not a Git ancestor of main.
```

Before a post-action receipt exists, also require
`Coordinator retained intentionally; clean/detached at <full-main-sha>.` After any approved remote
action, the receipt render instead requires:

```text
Coordinator captured clean/detached at <full-main-sha>; removal is permitted only after receipt-main verification.
```

The generator derives the SHA and disposition from typed live-reference evidence; neither sentence
is a manual status assertion.

Reject `fully merged`, `100% Git-merged`, any 33-only total, or `safe to delete` without the exact
archive and explicit-approval state.

```bash
cd /var/aqua-saas/.worktrees/aquamobil-v4-report
node --test tools/aquamobil-v4/generate-closeout-report.spec.mjs \
  tools/aquamobil-v4/capture-live-references.spec.mjs
```

Expected: FAIL because both tools are absent.

- [ ] **Step 4: Capture live references and render deterministically**

`capture-live-references.mjs` invokes typed `gh pr view`, `gh pr list`,
`git worktree list --porcelain`, and `git for-each-ref --contains`. It sorts output, stores no local
path, and rejects a changed source, foreign URL, duplicate ref, another open PR consuming the
source, or an active source-branch worktree. For the initial capture it requires PR #1107 to be
OPEN, non-draft, head `feature/aquamobil-v4-redesign` at the immutable source SHA, and base `main`.
It records `mergeStateStatus` as observed remote state but never treats that unstable field as a
fixed gate. The literal `--coordinator-worktree` input is validated as the exact clean detached
Order 0 path at fetched `origin/main`, but the local path is not serialized. Before a post-action
receipt its disposition is `retained-intentionally`; the post-action capture alone may use
`cleanup-after-receipt-main`. Only a post-action capture may select the cleanup disposition; when
both approval booleans are false, no receipt exists and the coordinator remains retained. Initial
captures require both explicit-action fields to be false. A post-action capture requires both
booleans explicitly, validates the same four-row matrix as `SourceActionReceipt`, and cannot infer
approval from a closed PR or missing ref.

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd /var/aqua-saas/.worktrees/aquamobil-v4-report
node tools/aquamobil-v4/capture-live-references.mjs \
  --repository Okan-wqm/aquaculture_platform \
  --coordinator-worktree /var/aqua-saas/.worktrees/aquamobil-v4-coordinator \
  --coordinator-disposition retained-intentionally \
  --write docs/superpowers/evidence/aquamobil-v4/live-references.json \
  --source-ref origin/feature/aquamobil-v4-redesign \
  --expected-source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source-pr 1107 \
  --explicit-pr-close-approved false \
  --explicit-branch-delete-approved false \
  --expected-pr-state OPEN \
  --expected-pr-draft false \
  --expected-pr-head feature/aquamobil-v4-redesign \
  --expected-pr-base main \
  --expected-pr-head-sha 542c8e0bb7ff3afbeee0496f277f8926526cc41a
```

Add the only report commands:

```json
"aquamobil:v4:closeout:render": "node tools/aquamobil-v4/generate-closeout-report.mjs --write",
"aquamobil:v4:closeout:check": "node tools/aquamobil-v4/generate-closeout-report.mjs --check"
```

Rows follow frozen Git order. Full SHAs, repository-bound HTTPS evidence URLs, all implementation
boundaries, closure maps, three non-merge exclusions, and two merge-resolution object IDs are
mandatory. An excluded row renders generated artifacts as `not applicable` with its machine-derived
reason; an empty link or invented artifact is invalid. When `source-action-receipt.json` is absent,
default inputs use `live-references.json`. When that receipt exists, both render and check fail
unless they use `live-references-post-action.json` and the receipt together. Receipt presence while
both approvals are false, a post-action live reference without a receipt, unequal approval booleans
between those two inputs, a requested/attempted/ successful/observed state mismatch, or delete
approval without the typed branch-freeze disposition fails closed. This deterministic auto-selection
keeps the later receipt-main workflow fresh.

```bash
npm run aquamobil:v4:closeout:render
npm run aquamobil:v4:closeout:check
node --test tools/aquamobil-v4/generate-closeout-report.spec.mjs \
  tools/aquamobil-v4/capture-live-references.spec.mjs
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --require-terminal \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2 \
  --verify-main-ancestors origin/main
```

- [ ] **Step 5: Commit, push, review, and prepare the report PR**

```bash
cd /var/aqua-saas/.worktrees/aquamobil-v4-report
git add -- \
  tools/aquamobil-v4/generate-closeout-report.mjs \
  tools/aquamobil-v4/generate-closeout-report.spec.mjs \
  tools/aquamobil-v4/capture-live-references.mjs \
  tools/aquamobil-v4/capture-live-references.spec.mjs \
  docs/superpowers/evidence/aquamobil-v4/closeout-run-tooling-main.json \
  docs/superpowers/evidence/aquamobil-v4/live-references.json \
  docs/superpowers/evidence/aquamobil-v4/final-verification.md \
  package.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): record v4 semantic supersession" \
  -m "Join all 35 source objects to protected-main behavior, exclusions, merge resolutions, closure evidence, and the exact tooling-main run without inventing ancestry."
git push --set-upstream origin chore/aquamobil-v4-semantic-supersession
report_pr_url="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --head chore/aquamobil-v4-semantic-supersession \
  --title "chore(aquamobil): record v4 semantic supersession" \
  --body "Generates the sole 35-object semantic-supersession report from exact tooling-main evidence; it does not delete provenance.")"
report_pr_number="$(gh pr view "$report_pr_url" --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$report_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$report_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision,baseRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main")'
```

---

### Task 6: Merge and verify the report on protected main

**Files:**

- No repository files are changed outside the reviewed report PR.

**Interfaces:**

- Consumes: independently reviewed report PR and required checks.
- Produces: the exact report-main SHA used by archive capture.

- [ ] **Step 1: Complete two-stage review and protected checks**

Use `superpowers:requesting-code-review`. Specification review checks all 35 objects, exact boundary
inventories, closure records, and report sections. Quality/security review checks fail-closed GitHub
capture, audit reachability, digest authority, workflow permissions, and absence of destructive
jobs.

```bash
mapfile -t report_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform \
  --state open --base main --head chore/aquamobil-v4-semantic-supersession \
  --json number,title \
  --jq '.[] | select(.title == "chore(aquamobil): record v4 semantic supersession") | .number')
test "${#report_pr_numbers[@]}" -eq 1
REPORT_PR_NUMBER="${report_pr_numbers[0]}"
[[ "$REPORT_PR_NUMBER" =~ ^[0-9]+$ ]]
gh pr checks "$REPORT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$REPORT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision,baseRefName,headRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-semantic-supersession")'
node "/var/aqua-saas/.worktrees/aquamobil-v4-coordinator/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$REPORT_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind closeout-report \
  --expected-head chore/aquamobil-v4-semantic-supersession \
  --verify-base-advance \
  --require-latest-merge-queue-candidate
```

- [ ] **Step 2: Verify the authorized report merge and honest non-ancestry**

After the normal protected merge occurs:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mapfile -t report_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform \
  --state merged --base main --head chore/aquamobil-v4-semantic-supersession \
  --json number,title \
  --jq '.[] | select(.title == "chore(aquamobil): record v4 semantic supersession") | .number')
test "${#report_pr_numbers[@]}" -eq 1
REPORT_PR_NUMBER="${report_pr_numbers[0]}"
REPORT_MAIN_SHA="$(gh pr view "$REPORT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$REPORT_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$REPORT_MAIN_SHA" origin/main
set +e
git -C /var/aqua-saas merge-base --is-ancestor \
  542c8e0bb7ff3afbeee0496f277f8926526cc41a origin/main
source_ancestry_status=$?
set -e
test "$source_ancestry_status" -eq 1
cd "$COORDINATOR_WORKTREE"
test "/var/aqua-saas/.worktrees/aquamobil-v4-report" != "/var/aqua-saas"
test -z "$(git -C /var/aqua-saas/.worktrees/aquamobil-v4-report status --porcelain)"
git -C /var/aqua-saas/.worktrees/aquamobil-v4-report switch --detach origin/main
git -C /var/aqua-saas merge-base --is-ancestor \
  "$(git -C /var/aqua-saas/.worktrees/aquamobil-v4-report rev-parse HEAD)" origin/main
git -C /var/aqua-saas worktree remove /var/aqua-saas/.worktrees/aquamobil-v4-report
test ! -e /var/aqua-saas/.worktrees/aquamobil-v4-report
```

Expected: report merge is main-reachable and source tip is honestly not main-reachable. Nothing is
deleted or closed.

---

### Task 7: Archive provenance, request approval, and commit a post-action receipt

**Files:**

- Create: `tools/aquamobil-v4/capture-provenance-archive.mjs`
- Create: `tools/aquamobil-v4/capture-provenance-archive.spec.mjs`
- Create: `docs/superpowers/evidence/aquamobil-v4/closeout-run-report-main.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/provenance-archive.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/live-references.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/final-verification.md` only through the generator
- Create after at least one approved remote action:
  `docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json`
- Create after at least one approved remote action:
  `docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json`
- Modify: `package.json`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: exact report-main run, active GitHub tag ruleset, configured signing identity, explicit
  user approval, and a fresh clone.
- Produces: protected signed tag
  `archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a`, archive PR, and—only
  after at least one approved remote action—a protected-main receipt PR.

```ts
type RequestedSourceAction = 'close-source-pr' | 'delete-source-branch';
type SourceActionOutcome = 'succeeded' | 'failed' | 'ambiguous' | 'not-attempted';

interface DurableJournalRecordReference {
  readonly sequence: number;
  readonly kind: 'header' | 'intent' | 'result' | 'observation' | 'decision';
  readonly previousRecordSha256: string | null;
  readonly recordSha256: string;
  readonly writtenAt: string;
}

type SourceActionAttempt =
  | {
      readonly action: RequestedSourceAction;
      readonly target:
        | 'Okan-wqm/aquaculture_platform#1107'
        | 'refs/heads/feature/aquamobil-v4-redesign';
      readonly outcome: 'succeeded' | 'failed' | 'ambiguous';
      readonly intent: DurableJournalRecordReference;
      readonly result: DurableJournalRecordReference | null;
      readonly observation: DurableJournalRecordReference;
      readonly exitStatus: number | null;
      readonly completedAt: string | null;
      readonly commandOutputSha256: string | null;
      readonly notAttemptedReason: null;
    }
  | {
      readonly action: RequestedSourceAction;
      readonly target:
        | 'Okan-wqm/aquaculture_platform#1107'
        | 'refs/heads/feature/aquamobil-v4-redesign';
      readonly outcome: 'not-attempted';
      readonly intent: null;
      readonly result: null;
      readonly observation: DurableJournalRecordReference;
      readonly exitStatus: null;
      readonly completedAt: null;
      readonly commandOutputSha256: null;
      readonly notAttemptedReason: 'prior-action-not-succeeded' | 'source-branch-freeze-not-proven';
    };

interface SourceActionControlStep {
  readonly control: 'install-source-branch-freeze';
  readonly outcome: 'succeeded' | 'failed' | 'ambiguous';
  readonly intent: DurableJournalRecordReference;
  readonly result: DurableJournalRecordReference | null;
  readonly observation: DurableJournalRecordReference;
}

type SourceBranchFreezeEvidence =
  | {
      readonly state: 'active-proven';
      readonly rulesetId: number;
      readonly name: 'AquaMobil v4 source ref freeze 542c8e0';
      readonly target: 'branch';
      readonly enforcement: 'active';
      readonly sourceRef: 'refs/heads/feature/aquamobil-v4-redesign';
      readonly bypassActors: readonly [];
      readonly rules: readonly ['creation', 'update'];
      readonly deletionRestricted: false;
      readonly installResponseSha256: string;
      readonly rulesetConfigurationSha256: string;
      readonly effectiveRulesResponseSha256: string;
      readonly postFreezeSourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
      readonly recreationPrevention: 'creation-and-update-restricted';
      readonly disposition:
        | 'retained-active-prevent-recreation'
        | 'retained-active-pending-approved-delete-reconciliation';
    }
  | {
      readonly state: 'not-proven';
      readonly rulesetId: number | null;
      readonly installResponseSha256: string | null;
      readonly rulesetConfigurationSha256: string | null;
      readonly effectiveRulesResponseSha256: string | null;
      readonly recreationPrevention: 'not-proven';
      readonly disposition: 'source-retained-delete-not-attempted';
    };

interface ReceiptCaptureToolAttestation {
  readonly coordinatorMainCommit: string;
  readonly executablePath: 'tools/aquamobil-v4/capture-provenance-archive.mjs';
  readonly executableBlobSha: string;
}

interface SourceActionReceipt {
  readonly schemaVersion: 2;
  readonly repository: 'Okan-wqm/aquaculture_platform';
  readonly sourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly receiptState: 'complete' | 'partial-failure' | 'ambiguous';
  readonly approvals: {
    readonly closeSourcePullRequest: boolean;
    readonly deleteSourceBranch: boolean;
  };
  readonly requestedActions: readonly RequestedSourceAction[];
  readonly actionAttempts: readonly SourceActionAttempt[];
  readonly successfulActions: readonly RequestedSourceAction[];
  readonly controlPlaneSteps: readonly SourceActionControlStep[];
  readonly sourceBranchFreeze: SourceBranchFreezeEvidence | null;
  readonly observed: {
    readonly sourcePullRequest: {
      readonly number: 1107;
      readonly state: 'OPEN' | 'CLOSED';
      readonly headRefName: 'feature/aquamobil-v4-redesign';
      readonly headRefOid: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
      readonly baseRefName: 'main';
    };
    readonly sourceHead:
      | {
          readonly state: 'PRESENT';
          readonly ref: 'refs/heads/feature/aquamobil-v4-redesign';
          readonly commit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
        }
      | {
          readonly state: 'ABSENT';
          readonly ref: 'refs/heads/feature/aquamobil-v4-redesign';
          readonly commit: null;
        };
  };
  readonly provenanceRef: 'refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly provenanceArchiveEvidenceSha256: string;
  readonly freshClone: {
    readonly tagObject: string;
    readonly archiveCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
    readonly signatureVerified: true;
  };
  readonly journal: {
    readonly journalId: 'source-542c8e0bb7ff3afbeee0496f277f8926526cc41a-pr-1107';
    readonly recordCount: number;
    readonly headRecordSha256: string;
    readonly durability: 'atomic-rename-fsync-file-and-directory';
  };
  readonly observedPullRequestApiSha256: string;
  readonly observedSourceRefApiSha256: string;
  readonly captureTool: ReceiptCaptureToolAttestation;
}
```

`capture-provenance-archive.mjs` validates the whole closed v2 schema and owns one persistent
journal directory resolved from the coordinator's exact Git common directory:
`/var/aqua-saas/.git/aquamobil-v4-source-actions/source-542c8e0bb7ff3afbeee0496f277f8926526cc41a-pr-1107`.
The path is never serialized. Its `records/` entries are canonical JSON with a monotonically
increasing sequence and SHA-256 predecessor chain. Each record uses exclusive scratch-file creation,
file `fsync`, atomic rename, and parent-directory `fsync`; logs are regular files in the same
mode-0700 directory. A partial tail, sequence gap, hash mismatch, symlink, changed owner or mode,
second journal, changed approvals, or changed repository/source/PR identity fails closed.

For each actually attempted source action and the branch-ruleset control step, the tool first
captures the exact remote pre-state and durably appends an intent. Only then may the command run. An
action blocked by a prior outcome receives a durable `decision` observation with no intent or result
and is typed `not-attempted`. Immediately when the command returns, before a fetch, API call, second
action, receipt generation, or other fallible operation, `--record-action-result` durably stores its
raw exit status and output digest. A separate post-observation is then durably appended. If the
process stops between intent, command, result, or observation, the next invocation must use
`--resume-action-journal`; it refuses every new action while an open intent exists and reconciles
exact authenticated PR/ref/ruleset state to one of `succeeded`, `failed`, or `ambiguous`. It never
retries an ambiguous action automatically.

`requestedActions` is exactly the approved close/delete subset in close-then-delete order;
`successfulActions` is exactly the attempts with outcome `succeeded`. Control-plane operations never
appear in either array and live only in `controlPlaneSteps`. A recorded zero exit plus matching
post-state is success; a recorded nonzero exit plus unchanged exact pre-state is failure; a missing
result, contradictory exit/state pair, recreated/moved ref, duplicate/mismatched ruleset, or state
transition that cannot be attributed to the recorded command is ambiguous. After the first failed or
ambiguous requested action, later requested actions are `not-attempted`; the receipt still proceeds.
`receiptState` is `complete` only when every requested action succeeded, `ambiguous` when any action
or control step is ambiguous, and otherwise `partial-failure`.

Delete approval additionally requires the exact repository ruleset named above. Its normalized
installation response must prove target `branch`, enforcement `active`, the one exact included ref,
no excludes, no bypass actors, sorted rules exactly `creation` and `update`, and no deletion rule.
The tool then queries both the exact ruleset and the effective rules for the branch—even when the
ref is absent—and re-resolves the source tip as `542c8e0bb7ff3afbeee0496f277f8926526cc41a` after the
freeze. Only then may normal `git push origin --delete feature/aquamobil-v4-redesign` run. Force and
lease-force options are forbidden. If installation/effective-rule/tip proof fails, deletion is
`not-attempted`, the source is retained, and the protected receipt records the failed or ambiguous
control step. A proven ruleset remains active: after successful deletion its disposition is
`retained-active-prevent-recreation`; otherwise it is
`retained-active-pending-approved-delete-reconciliation`. Removing or weakening it is outside this
approval and requires a separate future authorization.

The exact outcome matrix is:

| Close approved | Delete approved | Required journal and receipt behavior                                                                                                                                              |
| -------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `false`        | `false`         | No journal, action, control step, or receipt; source remains exact and coordinator is retained clean/detached                                                                      |
| `true`         | `false`         | Close attempt is recorded; success requires `CLOSED`/exact present source, while failed or ambiguous close still produces a typed receipt                                          |
| `false`        | `true`          | Freeze control precedes delete; success requires absent source and active recreate prevention, while freeze/delete failure or ambiguity retains evidence in a typed receipt        |
| `true`         | `true`          | Close precedes freeze/delete; complete requires both successes, while close success plus delete failure/ambiguity is a valid partial/ambiguous receipt with the exact source state |

Unit fixtures cut the process after every durable intent, remote-command return, result append, and
post-observation append, then resume from the same directory and prove the outcome is reconciled
once without replay. They cover close success/delete failure, nonzero unchanged-state failure,
missing result ambiguity, API timeout after a state change, a source-tip move immediately before
freeze, a tip move between freeze proof and delete intent, freeze installation/effective-query
failures, duplicate or bypassed rulesets, update/creation rejection, normal deletion allowance,
recreation rejection after deletion, receipt-main validation failure, cleanup refusal, and a
successful resume. Tests also prove the control-plane installation never appears in
requested/successful source actions, force/lease-force arguments are rejected, and successful
deletion leaves the exact ruleset ACTIVE.

The same validator's `--observe-remote` mode is the required-workflow check prewired in Task 4. It
accepts no caller-supplied state override: it reads approvals, attempts, successful actions,
control-plane evidence, and expected states from the receipt; re-fetches PR #1107, the exact source
ref, signed archive, and effective branch rules; joins the exact post-action live-reference and
provenance-evidence digests; and applies the matrix again.

- [ ] **Step 1: Create the archive worktree and capture exact report-main**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mapfile -t report_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform \
  --state merged --base main --head chore/aquamobil-v4-semantic-supersession \
  --json number,title \
  --jq '.[] | select(.title == "chore(aquamobil): record v4 semantic supersession") | .number')
test "${#report_pr_numbers[@]}" -eq 1
REPORT_PR_NUMBER="${report_pr_numbers[0]}"
REPORT_MAIN_SHA="$(gh pr view "$REPORT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,mergeCommit \
  --jq 'select(.state == "MERGED" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-semantic-supersession") | .mergeCommit.oid')"
[[ "$REPORT_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$REPORT_MAIN_SHA" origin/main
archive_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-archive
test ! -e "$archive_worktree"
git -C /var/aqua-saas worktree add "$archive_worktree" \
  -b chore/aquamobil-v4-provenance-archive origin/main
cd "$archive_worktree"
test "$(git rev-parse HEAD)" = "$REPORT_MAIN_SHA"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-closeout-run.mjs" \
  --dispatch-and-wait \
  --repository Okan-wqm/aquaculture_platform \
  --workflow .github/workflows/aquamobil-v4-closeout.yml \
  --ref main \
  --expected-head "$REPORT_MAIN_SHA" \
  --artifact-name aquamobil-v4-closeout-evidence \
  --write docs/superpowers/evidence/aquamobil-v4/closeout-run-report-main.json
```

- [ ] **Step 2: Test and prove the active tag-protection ruleset before tagging**

`capture-provenance-archive.mjs` normalizes `gh api` responses and accepts only repository
`Okan-wqm/aquaculture_platform`, exact source commit, signed annotated tag, and active ruleset name
`AquaMobil v4 provenance tags`. The ruleset target must be tags, include
`refs/tags/archive/aquamobil-v4-redesign-*`, and prevent update, non-fast-forward movement, and
deletion without a bypass used by this operation. It records ruleset ID, API digest, tag-object SHA,
commit SHA, signature status, signer fingerprint, and remote ref.

```bash
cd /var/aqua-saas/.worktrees/aquamobil-v4-archive
node --test tools/aquamobil-v4/capture-provenance-archive.spec.mjs
node tools/aquamobil-v4/capture-provenance-archive.mjs \
  --repository Okan-wqm/aquaculture_platform \
  --ruleset-name "AquaMobil v4 provenance tags" \
  --tag refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --assert-ruleset-before-tag
```

Expected: PASS before creating a tag. If the ruleset is absent, inactive, bypassed, or too broad to
prove the exact protection, stop and retain source branch and PR #1107.

- [ ] **Step 3: Create, verify, push, and fresh-clone the signed archive**

```bash
cd /var/aqua-saas/.worktrees/aquamobil-v4-archive
git tag -s archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  -m "Archive AquaMobil v4 redesign source provenance at immutable tip 542c8e0bb7ff3afbeee0496f277f8926526cc41a"
git verify-tag archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
git push origin refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
test "$(git ls-remote origin refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a^{} | cut -f1)" = \
  "542c8e0bb7ff3afbeee0496f277f8926526cc41a"
archive_clone_root="$(mktemp -d /tmp/aquamobil-v4-archive.XXXXXXXX)"
test -n "$archive_clone_root"
[[ "$archive_clone_root" == /tmp/aquamobil-v4-archive.* ]]
test -d "$archive_clone_root"
gh repo clone Okan-wqm/aquaculture_platform "$archive_clone_root/repository" -- \
  --filter=blob:none --no-checkout
git -C "$archive_clone_root/repository" fetch origin \
  refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a:refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
git -C "$archive_clone_root/repository" verify-tag archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
git -C "$archive_clone_root/repository" cat-file -e \
  542c8e0bb7ff3afbeee0496f277f8926526cc41a^{commit}
test -n "$archive_clone_root"
[[ "$archive_clone_root" == /tmp/aquamobil-v4-archive.* ]]
test "$archive_clone_root" != /var/aqua-saas
rm -rf -- "$archive_clone_root"
test ! -e "$archive_clone_root"
```

Any failure retains the source. The next step creates its own fresh clone so it never depends on a
shell variable or scratch path from this command block.

- [ ] **Step 4: Commit the archive and exact report-main evidence through review**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd /var/aqua-saas/.worktrees/aquamobil-v4-archive
archive_evidence_clone_root="$(mktemp -d /tmp/aquamobil-v4-archive-evidence.XXXXXXXX)"
test -n "$archive_evidence_clone_root"
[[ "$archive_evidence_clone_root" == /tmp/aquamobil-v4-archive-evidence.* ]]
gh repo clone Okan-wqm/aquaculture_platform "$archive_evidence_clone_root/repository" -- \
  --filter=blob:none --no-checkout
git -C "$archive_evidence_clone_root/repository" fetch origin \
  refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a:refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
git -C "$archive_evidence_clone_root/repository" verify-tag archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
git -C "$archive_evidence_clone_root/repository" cat-file -e \
  542c8e0bb7ff3afbeee0496f277f8926526cc41a^{commit}
node tools/aquamobil-v4/capture-provenance-archive.mjs \
  --repository Okan-wqm/aquaculture_platform \
  --ruleset-name "AquaMobil v4 provenance tags" \
  --tag refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --fresh-clone "$archive_evidence_clone_root/repository" \
  --write docs/superpowers/evidence/aquamobil-v4/provenance-archive.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --set-provenance-ref refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --closeout-inputs docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-live-references.mjs" \
  --repository Okan-wqm/aquaculture_platform \
  --coordinator-worktree "$COORDINATOR_WORKTREE" \
  --coordinator-disposition retained-intentionally \
  --write docs/superpowers/evidence/aquamobil-v4/live-references.json \
  --source-ref origin/feature/aquamobil-v4-redesign \
  --expected-source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source-pr 1107 \
  --explicit-pr-close-approved false \
  --explicit-branch-delete-approved false \
  --expected-pr-state OPEN \
  --expected-pr-draft false \
  --expected-pr-head feature/aquamobil-v4-redesign \
  --expected-pr-base main \
  --expected-pr-head-sha 542c8e0bb7ff3afbeee0496f277f8926526cc41a
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --write
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --check
test -n "$archive_evidence_clone_root"
[[ "$archive_evidence_clone_root" == /tmp/aquamobil-v4-archive-evidence.* ]]
test "$archive_evidence_clone_root" != /var/aqua-saas
rm -rf -- "$archive_evidence_clone_root"
test ! -e "$archive_evidence_clone_root"
git add -- \
  tools/aquamobil-v4/capture-provenance-archive.mjs \
  tools/aquamobil-v4/capture-provenance-archive.spec.mjs \
  docs/superpowers/evidence/aquamobil-v4/closeout-run-report-main.json \
  docs/superpowers/evidence/aquamobil-v4/provenance-archive.json \
  docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json \
  docs/superpowers/evidence/aquamobil-v4/live-references.json \
  docs/superpowers/evidence/aquamobil-v4/final-verification.md \
  package.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): protect v4 source provenance" \
  -m "Bind the exact report-main run and signed protected archive before any source deletion is considered."
git push --set-upstream origin chore/aquamobil-v4-provenance-archive
archive_pr_url="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --head chore/aquamobil-v4-provenance-archive \
  --title "chore(aquamobil): protect v4 source provenance" \
  --body "Records the exact report-main run, signed source tag, active tag ruleset, and fresh-clone recovery proof. No source is deleted.")"
archive_pr_number="$(gh pr view "$archive_pr_url" --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$archive_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$archive_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED")'
node "/var/aqua-saas/.worktrees/aquamobil-v4-coordinator/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$archive_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind closeout-archive \
  --expected-head chore/aquamobil-v4-provenance-archive \
  --verify-base-advance \
  --require-latest-merge-queue-candidate
```

After the authorized archive merge, fetch exact main, prove the merge and protected tag again, then
remove the worktree and the validated scratch clone:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mapfile -t archive_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform \
  --state merged --base main --head chore/aquamobil-v4-provenance-archive \
  --json number,title \
  --jq '.[] | select(.title == "chore(aquamobil): protect v4 source provenance") | .number')
test "${#archive_pr_numbers[@]}" -eq 1
ARCHIVE_PR_NUMBER="${archive_pr_numbers[0]}"
ARCHIVE_MAIN_SHA="$(gh pr view "$ARCHIVE_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$ARCHIVE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$ARCHIVE_MAIN_SHA" origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-archive
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --repository Okan-wqm/aquaculture_platform \
  --ruleset-name "AquaMobil v4 provenance tags" \
  --tag refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --assert-remote-protected
cd "$COORDINATOR_WORKTREE"
test "/var/aqua-saas/.worktrees/aquamobil-v4-archive" != "/var/aqua-saas"
test -z "$(git -C /var/aqua-saas/.worktrees/aquamobil-v4-archive status --porcelain)"
git -C /var/aqua-saas/.worktrees/aquamobil-v4-archive switch --detach origin/main
git -C /var/aqua-saas merge-base --is-ancestor \
  "$(git -C /var/aqua-saas/.worktrees/aquamobil-v4-archive rev-parse HEAD)" origin/main
git -C /var/aqua-saas worktree remove /var/aqua-saas/.worktrees/aquamobil-v4-archive
test ! -e /var/aqua-saas/.worktrees/aquamobil-v4-archive
```

- [ ] **Step 5: Present exact destructive targets and wait for new approval**

Present the protected-main report, archive tag and ruleset proof, exact source branch
`feature/aquamobil-v4-redesign`, and PR #1107. Ask separately whether to close PR #1107 and whether
to delete the remote branch. Do not reuse prior cleanup approval. Record the two answers separately
as `APPROVED_CLOSE_SOURCE_PR` and `APPROVED_DELETE_SOURCE_BRANCH`; each value is exactly `true` or
`false`. Warn that GitHub may change the PR state as a side effect of deleting its head even when no
explicit PR-close command was approved; that observed server state is not retroactive permission.
Also state that delete approval authorizes installation of the exact source-ref freeze required to
make the deletion race-safe. That ruleset prevents update and recreation, does not prevent normal
deletion, has no bypass actors, and remains active after successful deletion; its later removal is
not part of either approval.

- [ ] **Step 6: Reassert action safety after approval and perform only named actions**

Every invocation begins at this step. The neither-approved branch is selected before journal
creation and proves that the canonical journal path does not exist. An approved-action invocation
creates or resumes exactly one persistent journal; a resumed invocation reconciles any open intent
before it is allowed to schedule another action.

```bash
set -euo pipefail
: "${APPROVED_CLOSE_SOURCE_PR:?re-enter the explicit PR-close approval boolean}"
: "${APPROVED_DELETE_SOURCE_BRANCH:?re-enter the explicit branch-deletion approval boolean}"
[[ "$APPROVED_CLOSE_SOURCE_PR" =~ ^(true|false)$ ]]
[[ "$APPROVED_DELETE_SOURCE_BRANCH" =~ ^(true|false)$ ]]
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch --prune origin \
  +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$GIT_COMMON_DIR" = /var/aqua-saas/.git
ACTION_JOURNAL_DIR="$GIT_COMMON_DIR/aquamobil-v4-source-actions/source-542c8e0bb7ff3afbeee0496f277f8926526cc41a-pr-1107"
test "$ACTION_JOURNAL_DIR" = \
  /var/aqua-saas/.git/aquamobil-v4-source-actions/source-542c8e0bb7ff3afbeee0496f277f8926526cc41a-pr-1107
if test "$APPROVED_CLOSE_SOURCE_PR" = false && \
  test "$APPROVED_DELETE_SOURCE_BRANCH" = false; then
  test ! -e "$ACTION_JOURNAL_DIR"
  retained_coordinator_head="$(git -C "$COORDINATOR_WORKTREE" \
    show HEAD:docs/superpowers/evidence/aquamobil-v4/live-references.json | \
    jq -er 'select(.explicitPrCloseApproved == false and .explicitBranchDeleteApproved == false and .coordinatorWorktree.disposition == "retained-intentionally") | .coordinatorWorktree.head')"
  [[ "$retained_coordinator_head" =~ ^[0-9a-f]{40}$ ]]
  git -C "$COORDINATOR_WORKTREE" cat-file -e "$retained_coordinator_head^{commit}"
  git -C "$COORDINATOR_WORKTREE" switch --detach "$retained_coordinator_head"
  test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
  test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
  test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
    "$retained_coordinator_head"
  printf 'No remote action approved; no receipt; coordinator retained at %s.\n' \
    "$retained_coordinator_head"
  exit 0
fi
if test -e "$ACTION_JOURNAL_DIR"; then
  test -d "$ACTION_JOURNAL_DIR"
  test ! -L "$ACTION_JOURNAL_DIR"
  test "$(stat -c '%a' "$ACTION_JOURNAL_DIR")" = 700
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
    --resume-action-journal "$ACTION_JOURNAL_DIR" \
    --repository Okan-wqm/aquaculture_platform \
    --source-pr 1107 \
    --source-ref refs/heads/feature/aquamobil-v4-redesign \
    --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
    --approved-close-source-pr "$APPROVED_CLOSE_SOURCE_PR" \
    --approved-delete-source-branch "$APPROVED_DELETE_SOURCE_BRANCH" \
    --observe-remote
else
  git -C /var/aqua-saas fetch origin \
    +refs/heads/feature/aquamobil-v4-redesign:refs/remotes/origin/feature/aquamobil-v4-redesign
  test "$(git -C /var/aqua-saas rev-parse origin/feature/aquamobil-v4-redesign)" = \
    542c8e0bb7ff3afbeee0496f277f8926526cc41a
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-live-references.mjs" \
    --repository Okan-wqm/aquaculture_platform \
    --coordinator-worktree "$COORDINATOR_WORKTREE" \
    --coordinator-disposition retained-intentionally \
    --source-ref origin/feature/aquamobil-v4-redesign \
    --expected-source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
    --source-pr 1107 \
    --explicit-pr-close-approved false \
    --explicit-branch-delete-approved false \
    --expected-pr-state OPEN \
    --expected-pr-draft false \
    --expected-pr-head feature/aquamobil-v4-redesign \
    --expected-pr-base main \
    --expected-pr-head-sha 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
    --assert-source-action-safe
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
    --repository Okan-wqm/aquaculture_platform \
    --ruleset-name "AquaMobil v4 provenance tags" \
    --tag refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
    --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
    --assert-remote-protected
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
    --create-action-journal "$ACTION_JOURNAL_DIR" \
    --repository Okan-wqm/aquaculture_platform \
    --source-pr 1107 \
    --source-ref refs/heads/feature/aquamobil-v4-redesign \
    --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
    --approved-close-source-pr "$APPROVED_CLOSE_SOURCE_PR" \
    --approved-delete-source-branch "$APPROVED_DELETE_SOURCE_BRANCH" \
    --observe-remote
fi
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --execute-approved-source-actions "$ACTION_JOURNAL_DIR" \
  --repository Okan-wqm/aquaculture_platform \
  --source-pr 1107 \
  --source-ref refs/heads/feature/aquamobil-v4-redesign \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --approved-close-source-pr "$APPROVED_CLOSE_SOURCE_PR" \
  --approved-delete-source-branch "$APPROVED_DELETE_SOURCE_BRANCH" \
  --source-freeze-ruleset-name "AquaMobil v4 source ref freeze 542c8e0"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --finalize-action-journal "$ACTION_JOURNAL_DIR" \
  --repository Okan-wqm/aquaculture_platform \
  --observe-remote
test -d "$ACTION_JOURNAL_DIR"
test ! -L "$ACTION_JOURNAL_DIR"
test "$(stat -c '%a' "$ACTION_JOURNAL_DIR")" = 700
```

The executor uses argument arrays, never a shell. Behind close approval it durably writes intent
plus the authenticated OPEN/exact-head pre-observation, runs exactly
`gh pr close 1107 --repo Okan-wqm/aquaculture_platform` with the pinned semantic-supersession
comment, durably writes result, then observes the PR. Behind delete approval—and only after any
earlier requested close succeeded—it records a separate control-plane intent, installs the exact
active repository ruleset, records the API result, proves its exact/effective normalized state and
empty bypass list, and re-resolves the source at the exact tip. It then records the delete intent,
runs only normal `git push origin --delete feature/aquamobil-v4-redesign`, records the result
immediately, and observes both ref and ruleset. It never passes a force or lease-force option.

A nonzero action exit is a durably recorded `failed` outcome, not a reason to omit the receipt. An
unattributable state, interruption gap, or contradictory command/state result becomes `ambiguous`;
the executor never retries it. A failed/ambiguous close makes approved deletion `not-attempted`; a
failed/ambiguous freeze makes deletion `not-attempted`. All coherent terminal outcomes return to the
receipt path. Only journal-integrity, durability, identity, or authentication failure stops here,
with the persistent records retained for the next exact resume. In the neither-approved case, the
coordinator is restored to the exact clean/detached head already serialized by the protected report,
so retaining it does not make that report stale; any future coordination begins with the canonical
refresh again.

- [ ] **Step 7: Create a fresh-clone post-action receipt branch**

Run this step if and only if at least one remote action was explicitly approved, regardless of
whether its terminal outcome was succeeded, failed, or ambiguous. Re-establish both uppercase
booleans from that same explicit approval; do not default either value. Resume and finalize the
persistent journal before generating the immutable receipt. The receipt derives requested actions,
attempts, successful actions, control-plane steps, and observed states from that journal and fresh
authenticated observations; approval alone never predicts final PR/ref state.

```bash
: "${APPROVED_DELETE_SOURCE_BRANCH:?re-enter the explicit branch-deletion approval boolean}"
: "${APPROVED_CLOSE_SOURCE_PR:?re-enter the explicit PR-close approval boolean}"
[[ "$APPROVED_DELETE_SOURCE_BRANCH" =~ ^(true|false)$ ]]
[[ "$APPROVED_CLOSE_SOURCE_PR" =~ ^(true|false)$ ]]
test "$APPROVED_DELETE_SOURCE_BRANCH" = true || \
  test "$APPROVED_CLOSE_SOURCE_PR" = true
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch --prune origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$GIT_COMMON_DIR" = /var/aqua-saas/.git
ACTION_JOURNAL_DIR="$GIT_COMMON_DIR/aquamobil-v4-source-actions/source-542c8e0bb7ff3afbeee0496f277f8926526cc41a-pr-1107"
test -d "$ACTION_JOURNAL_DIR"
test ! -L "$ACTION_JOURNAL_DIR"
test "$(stat -c '%a' "$ACTION_JOURNAL_DIR")" = 700
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --resume-action-journal "$ACTION_JOURNAL_DIR" \
  --repository Okan-wqm/aquaculture_platform \
  --source-pr 1107 \
  --source-ref refs/heads/feature/aquamobil-v4-redesign \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --approved-close-source-pr "$APPROVED_CLOSE_SOURCE_PR" \
  --approved-delete-source-branch "$APPROVED_DELETE_SOURCE_BRANCH" \
  --observe-remote
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --finalize-action-journal "$ACTION_JOURNAL_DIR" \
  --repository Okan-wqm/aquaculture_platform \
  --observe-remote
receipt_clone_root="$(mktemp -d /tmp/aquamobil-v4-receipt.XXXXXXXX)"
test -n "$receipt_clone_root"
[[ "$receipt_clone_root" == /tmp/aquamobil-v4-receipt.* ]]
test -d "$receipt_clone_root"
gh repo clone Okan-wqm/aquaculture_platform "$receipt_clone_root/repository" -- \
  --filter=blob:none --no-checkout
git -C "$receipt_clone_root/repository" fetch origin \
  refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a:refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
git -C "$receipt_clone_root/repository" verify-tag archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a
git -C "$receipt_clone_root/repository" cat-file -e \
  542c8e0bb7ff3afbeee0496f277f8926526cc41a^{commit}
receipt_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-action-receipt
test ! -e "$receipt_worktree"
git -C /var/aqua-saas worktree add "$receipt_worktree" \
  -b chore/aquamobil-v4-source-action-receipt origin/main
cd "$receipt_worktree"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --repository Okan-wqm/aquaculture_platform \
  --ruleset-name "AquaMobil v4 provenance tags" \
  --tag refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --provenance-evidence docs/superpowers/evidence/aquamobil-v4/provenance-archive.json \
  --fresh-clone "$receipt_clone_root/repository" \
  --action-journal "$ACTION_JOURNAL_DIR" \
  --source-pr 1107 \
  --approved-delete-source-branch "$APPROVED_DELETE_SOURCE_BRANCH" \
  --approved-close-source-pr "$APPROVED_CLOSE_SOURCE_PR" \
  --observe-remote \
  --write-action-receipt docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-live-references.mjs" \
  --repository Okan-wqm/aquaculture_platform \
  --coordinator-worktree "$COORDINATOR_WORKTREE" \
  --coordinator-disposition cleanup-after-receipt-main \
  --provenance-ref refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source-pr 1107 \
  --expected-pr-draft false \
  --expected-pr-head feature/aquamobil-v4-redesign \
  --expected-pr-base main \
  --expected-pr-head-sha 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --explicit-pr-close-approved "$APPROVED_CLOSE_SOURCE_PR" \
  --explicit-branch-delete-approved "$APPROVED_DELETE_SOURCE_BRANCH" \
  --action-receipt docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
  --observe-remote \
  --write docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --source-ref refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --require-terminal \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2 \
  --verify-main-ancestors origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --write \
  --live-references docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --action-receipt docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --check \
  --live-references docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --action-receipt docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json
test -n "$receipt_clone_root"
[[ "$receipt_clone_root" == /tmp/aquamobil-v4-receipt.* ]]
test "$receipt_clone_root" != /var/aqua-saas
rm -rf -- "$receipt_clone_root"
test ! -e "$receipt_clone_root"
test -d "$ACTION_JOURNAL_DIR"
test ! -L "$ACTION_JOURNAL_DIR"
```

Do not remove or truncate the journal here. It remains the coordinator-owned recovery authority
until the receipt commit is on protected main, the exact receipt-main workflow has succeeded, and
the final local administrative/effective-rules reconciliation in Step 8 has passed.

- [ ] **Step 8: Review, merge, and verify the receipt on main**

```bash
: "${APPROVED_CLOSE_SOURCE_PR:?re-enter the explicit PR-close approval boolean}"
: "${APPROVED_DELETE_SOURCE_BRANCH:?re-enter the explicit branch-deletion approval boolean}"
[[ "$APPROVED_CLOSE_SOURCE_PR" =~ ^(true|false)$ ]]
[[ "$APPROVED_DELETE_SOURCE_BRANCH" =~ ^(true|false)$ ]]
test "$APPROVED_CLOSE_SOURCE_PR" = true || \
  test "$APPROVED_DELETE_SOURCE_BRANCH" = true
cd /var/aqua-saas/.worktrees/aquamobil-v4-action-receipt
git add -- \
  docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
  docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  docs/superpowers/evidence/aquamobil-v4/final-verification.md
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): record v4 source action receipt" \
  -m "Bind requested source actions, every terminal attempt and control outcome, observed PR/head state, and fresh-clone archive recovery proof."
git push --set-upstream origin chore/aquamobil-v4-source-action-receipt
receipt_pr_url="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --head chore/aquamobil-v4-source-action-receipt \
  --title "chore(aquamobil): record v4 source action receipt" \
  --body "Records approvals, requested and attempted source actions, terminal outcomes, separate control-plane evidence, observed remote state, and fresh-clone recovery proof.")"
receipt_pr_number="$(gh pr view "$receipt_pr_url" --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$receipt_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$receipt_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED")'
node "/var/aqua-saas/.worktrees/aquamobil-v4-coordinator/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$receipt_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind closeout-receipt \
  --expected-head chore/aquamobil-v4-source-action-receipt \
  --verify-base-advance \
  --require-latest-merge-queue-candidate
```

After the authorized receipt merge:

```bash
: "${APPROVED_CLOSE_SOURCE_PR:?re-enter the explicit PR-close approval boolean}"
: "${APPROVED_DELETE_SOURCE_BRANCH:?re-enter the explicit branch-deletion approval boolean}"
[[ "$APPROVED_CLOSE_SOURCE_PR" =~ ^(true|false)$ ]]
[[ "$APPROVED_DELETE_SOURCE_BRANCH" =~ ^(true|false)$ ]]
test "$APPROVED_CLOSE_SOURCE_PR" = true || \
  test "$APPROVED_DELETE_SOURCE_BRANCH" = true
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
receipt_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-action-receipt
test -d "$COORDINATOR_WORKTREE"
test -d "$receipt_worktree"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mapfile -t receipt_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform \
  --state merged --base main --head chore/aquamobil-v4-source-action-receipt \
  --json number,title \
  --jq '.[] | select(.title == "chore(aquamobil): record v4 source action receipt") | .number')
test "${#receipt_pr_numbers[@]}" -eq 1
RECEIPT_PR_NUMBER="${receipt_pr_numbers[0]}"
RECEIPT_MAIN_SHA="$(gh pr view "$RECEIPT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$RECEIPT_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$RECEIPT_MAIN_SHA" origin/main
cd "$receipt_worktree"
mkdir -p artifacts/aquamobil-v4-closeout
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-closeout-run.mjs" \
  --dispatch-and-wait \
  --repository Okan-wqm/aquaculture_platform \
  --workflow .github/workflows/aquamobil-v4-closeout.yml \
  --ref main \
  --expected-head "$RECEIPT_MAIN_SHA" \
  --artifact-name aquamobil-v4-closeout-evidence \
  --write artifacts/aquamobil-v4-closeout/receipt-main-run.json
jq -e --arg head "$RECEIPT_MAIN_SHA" \
  '.kind == "github-workflow-run" and .conclusion == "success" and .event == "workflow_dispatch" and .headSha == $head' \
  artifacts/aquamobil-v4-closeout/receipt-main-run.json
RECEIPT_MAIN_RUN_ID="$(jq -er '.runId | select(type == "number")' \
  artifacts/aquamobil-v4-closeout/receipt-main-run.json)"
RECEIPT_MAIN_RUN_URL="$(jq -er '.url | select(type == "string")' \
  artifacts/aquamobil-v4-closeout/receipt-main-run.json)"
test "$RECEIPT_MAIN_RUN_URL" = \
  "https://github.com/Okan-wqm/aquaculture_platform/actions/runs/$RECEIPT_MAIN_RUN_ID"
gh run view "$RECEIPT_MAIN_RUN_ID" --repo Okan-wqm/aquaculture_platform \
  --json conclusion,event,headSha,url \
  --jq 'select(.conclusion == "success" and .event == "workflow_dispatch")'
printf 'Receipt-main workflow evidence: %s\n' "$RECEIPT_MAIN_RUN_URL"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --repository Okan-wqm/aquaculture_platform \
  --ruleset-name "AquaMobil v4 provenance tags" \
  --tag refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --assert-remote-protected
GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$GIT_COMMON_DIR" = /var/aqua-saas/.git
ACTION_JOURNAL_DIR="$GIT_COMMON_DIR/aquamobil-v4-source-actions/source-542c8e0bb7ff3afbeee0496f277f8926526cc41a-pr-1107"
test -d "$ACTION_JOURNAL_DIR"
test ! -L "$ACTION_JOURNAL_DIR"
test "$(stat -c '%a' "$ACTION_JOURNAL_DIR")" = 700
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --check-action-receipt-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
  --live-references-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --provenance-evidence-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/provenance-archive.json \
  --action-journal "$ACTION_JOURNAL_DIR" \
  --repository Okan-wqm/aquaculture_platform \
  --approved-close-source-pr "$APPROVED_CLOSE_SOURCE_PR" \
  --approved-delete-source-branch "$APPROVED_DELETE_SOURCE_BRANCH" \
  --observe-remote \
  --require-administrative-source-freeze-proof
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --cleanup-action-journal "$ACTION_JOURNAL_DIR" \
  --repository Okan-wqm/aquaculture_platform \
  --receipt-ref origin/main:docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
  --receipt-main "$RECEIPT_MAIN_SHA" \
  --receipt-main-run artifacts/aquamobil-v4-closeout/receipt-main-run.json \
  --retain-source-freeze-ruleset
test ! -e "$ACTION_JOURNAL_DIR"
test "$receipt_worktree" != "/var/aqua-saas"
test -z "$(git -C "$receipt_worktree" status --porcelain)"
git -C "$receipt_worktree" switch --detach origin/main
git -C /var/aqua-saas merge-base --is-ancestor \
  "$(git -C "$receipt_worktree" rev-parse HEAD)" origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cleanup_cwd="$(mktemp -d /tmp/aquamobil-v4-worktree-cleanup.XXXXXXXX)"
test -d "$cleanup_cwd"
[[ "$cleanup_cwd" == /tmp/aquamobil-v4-worktree-cleanup.* ]]
cd "$cleanup_cwd"
git -C /var/aqua-saas worktree remove "$receipt_worktree"
test ! -e "$receipt_worktree"
git -C /var/aqua-saas worktree remove "$COORDINATOR_WORKTREE"
test ! -e "$COORDINATOR_WORKTREE"
cd /tmp
rmdir "$cleanup_cwd"
test ! -e "$cleanup_cwd"
```

Expected: protected main contains the complete, partial-failure, or ambiguous post-action receipt
and an exact receipt-main closeout dispatch is successful and externally reportable by its captured
URL. The receipt records both approvals, the exact requested/attempted/successful action sets,
separate control-plane evidence, current PR/ref state, and any retained active source-freeze
disposition; the signed protected archive resolves the exact 35-object history from a fresh clone.
Only after the main-ref receipt, workflow, journal hash chain, remote state, and full
administrative/effective ruleset proof agree is the persistent journal removed, while the
source-freeze ruleset remains ACTIVE, and then the receipt/coordinator worktrees are removed from a
validated scratch cwd. If both approvals were false, Steps 7 and 8 never ran, no journal or receipt
existed, the source remained at the exact tip, and the clean detached coordinator remained retained.
