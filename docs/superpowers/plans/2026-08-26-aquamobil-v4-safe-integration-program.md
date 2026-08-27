# AquaMobil v4 Safe Integration Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct every accepted behavior from `feature/aquamobil-v4-redesign` on current
`main`, prove that each concern has one authority, and integrate it through reviewed protected pull
requests without importing the stale branch patch.

**Architecture:** A protected Order 0 bootstrap freezes all 35 source-history objects, installs
repository-bound evidence tooling, and defines the dependency graph before implementation starts.
Each slice commits one append-only preflight record; after its complete plan-pinned protected-PR
boundary set merges, a separate serialized reconciliation PR captures every boundary and regenerates
the 33-row non-merge ledger. Five later finding-close trains each receive a separate append-only
closure record and serialized reconciliation. Closeout alone verifies the two merge-resolution
records and renders the final 35-object semantic-supersession report.

**Tech Stack:** Git worktrees, GitHub CLI/API, Nx, Node.js 22, npm 10, TypeScript, React 19, Vite,
Rollup, Vitest, Playwright, NestJS, TypeORM, PostgreSQL, NATS/JetStream mTLS, Docker, nginx, GitHub
Actions

**Spec:** `docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md`

## Global Constraints

- The refreshed planning main is `origin/main@4002868c535a2d8676aad6eadd5f4bbd57d4625b`. The
  immutable provenance anchors are
  `origin/feature/aquamobil-v4-redesign@542c8e0bb7ff3afbeee0496f277f8926526cc41a` and merge base
  `8d8d54365ada11d45b43374af76e9814c5958ff0`; current divergence is 219 behind and 35 ahead.
- The source range contains exactly 35 commits: 33 non-merge requirements plus merge commits
  `d6cc9d889b26a2566fe0211868e8faf7f2b34b23` and `1cae13834df31b4f5f982785e27b68d717d3de0b`. A
  33-only completion claim is invalid.
- The source branch is read-only provenance. Do not merge, rebase, cherry-pick, revert, or create an
  `ours`/empty ancestry marker from it.
- Order 0 must be reviewed, merged through protected `main`, and proven main-reachable before I1,
  F0, or any implementation slice starts.
- Order 0's clean worktree persists at `/var/aqua-saas/.worktrees/aquamobil-v4-coordinator`. After
  bootstrap merge it stays detached and is refreshed to the exact fetched `origin/main` before every
  coordination action. Never execute repository tools or npm from the dirty/user-owned
  `/var/aqua-saas` checkout; that path is used only as the Git common directory through explicit
  `git -C` worktree/ref operations.
- Before each slice, fetch `main` with an exact refspec and create one linked worktree from that
  protected-main SHA. `baseMainCommit` freezes that creation/preflight instant; it need not remain
  byte-equal to a later main when the independent frontend and feeding trains advance concurrently.
  Never stack on an unreviewed predecessor.
- Before every task, review, and merge, refetch main and require the immutable preflight base to be
  its ancestor. Compare `baseMainCommit..origin/main` against the slice's owned paths plus shared
  authority paths. Zero overlap may proceed only through required workflows on the latest
  merge-queue synthetic candidate. Any overlap stops the PR: never rebase or force-push; normally
  merge current protected main into the implementation branch, re-review the semantic diff, rerun
  affected plus full slice/audit/security gates, and obtain a distinct approval. A later violation
  of an already reconciled slice never mutates its evidence; it requires a program/schema revision
  and new plan-pinned remediation boundary before dependents resume.
- That merge-time stale-base decision applies to every protected program PR, not only product-code
  boundaries. Delivery implementation PRs bind to Task 3 Step 2's exact
  `--verify-prospective-pr --verify-base-advance --require-latest-merge-queue-candidate` protocol.
  Slice reconciliation, auxiliary verification, closure reconciliation, and all closeout PRs use
  Order 0's generic `--verify-prospective-program-pr` mode with those same two required flags;
  finding-close PRs use the specialized closure mode with the same flags. Order 0 itself is the sole
  bootstrap exception because the protected-main tool does not exist yet. A check result for a PR
  head, an earlier synthetic candidate, or a base that advanced after review never authorizes merge.
- Implementation branches create only their own append-only `preflight.json` under the exact fixed
  slice directory listed in `slice-branches.json`. They never edit `execution-ledger.json`, a
  `merge.json`, a closure record, or another slice's evidence.
- `slice-branches.json` pins a non-empty ordered `implementationBoundaryIds` list for every slice.
  F0 and F1a each require three separately reviewed protected boundaries; a final-only attestation
  cannot satisfy either slice.
- Resulting-main SHAs are captured only after merge. A distinct reconciliation branch creates the
  slice's immutable `merge.json` after all expected boundaries exist and regenerates the ledger;
  reconciliation PRs merge serially.
- Finding-close implementation PRs never edit a slice `merge.json` or the central ledger. Their
  distinct post-merge reconciliation creates one of the five fixed append-only closure records and
  alone regenerates derived closure fields in the ledger.
- Feeding Task 17's post-merge verification PR is an auxiliary evidence branch, not a seventeenth
  slice or sixth closure. Order 0 owns its one fixed `verificationWorktrees['feeding-foundation']`
  registry entry and lifecycle. The branch reads the four immutable feeding slice records and the
  generated ledger but never writes central evidence; only its reviewed evidence tree feeds the
  later feeding finding-close PR.
- Finding closure can inspect only already-reconciled slice evidence. The fixed sequences are I1
  implementation merge -> I1 slice reconciliation -> V0; V0 implementation merge -> V0 slice
  reconciliation -> V0 finding-close merge -> V0 closure reconciliation -> V1; and UI-convergence
  implementation merge -> UI-convergence slice reconciliation -> UI finding-close merge -> UI
  closure reconciliation -> V6. Reordering any arrow fails the coordinator.
- `.github/manifests/postgres-image.json` remains the one PostgreSQL image authority. Delivery Task
  1 creates `infrastructure/ci/image-digests.json` only as a closed CI-image resolver manifest: its
  `images.postgres` entry points to that existing file at JSON pointer `/image`, while Redis, nginx,
  MinIO, NATS, and Mosquitto are the five inline digest pins. I1 also creates the sole
  `scripts/ci/resolve-ci-image.mjs` resolver; every harness invokes its fixed manifest/key CLI and
  never copies a resolved digest or creates a competing manifest.
- Read root `CLAUDE.md` before and after every change and each applicable nested `CLAUDE.md` before
  editing its directory.
- Tests fail for the intended missing behavior before implementation. No compatibility shim,
  parallel store, duplicate DTO, handwritten generated artifact, silent fallback, broad assertion,
  or second business writer is permitted.
- Existing migrations are immutable. A timestamp collision on current main blocks the task until a
  revised exact migration path is reviewed.
- Tenant entities omit `schema:`; only `MODULE_SCHEMAS[].infrastructureTables` can justify one. NATS
  identity remains certificate CN only.
- Generated GraphQL, NATS, migration-manifest, service-catalog, storage-route, CSP, and format-scope
  artifacts are regenerated by their one authority with their inputs.
- Every program commit first stages all task-owned paths, then immediately runs
  `quality:format-scope:generate`, stages only `tools/quality/format-scope.json`, runs
  `quality:format-scope:check`, and checks the cached diff before committing.
- Full and runtime-only audits are classified through exact dependency chains. A high/critical
  runtime or release-build path blocks merge; aggregate counts are not reachability evidence.
- Every fix/security commit carries an exact uppercase `Closes:` trailer. Before merge,
  `capture-github-evidence.mjs` proves commit preservation or that the prospective squash body
  contains every exact trailer once. After merge, it proves those trailers occur on main-reachable
  commits. A missing or duplicate trailer blocks reconciliation.
- Public event changes, column drops, and API removals carry `BREAKING CHANGE:`. Every commit is
  pushed immediately; every implementation and reconciliation PR receives independent review.

---

## Dependency Graph and Detailed Plans

```text
Order 0 protected bootstrap
  |
  +-> I1 -> V0 -> V0 finding-close -> V1 -> V2 -> V3/V4 -> V5
  |                                                           |
  |                                                product finding-close
  |                                                           |
  |                                                    UI convergence
  |                                                           |
  |                                                UI finding-close
  |                                                                   |
  +-> F0 -> F1a --(+ I1 reconciliation)--> F2 -> F1b -> feeding verification -> feeding close
                                                                                             |
                                                               F3 -> F4 -> F5 --------------+-> V6
                                                                                             |
                                                                             VFD/V6 close ---+
                                                                                             |
all 16 slice + five closure reconciliation records -----------------------------------------+
                                                                                             |
closeout tooling PR -> exact tooling-main run -> report PR -> exact report-main run
                                                                                             |
protected provenance archive -> explicit remote-action approval -> post-action receipt PR
```

| Plan                    | Owned slices                                                                                | File                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Delivery and appearance | I1, V0, PWA handshake, V0/UI finding-close gates, UI convergence                            | `docs/superpowers/plans/2026-08-26-aquamobil-v4-delivery-appearance.md` |
| Product surfaces        | V1, V2, V3, V4, V5, product finding-close gate                                              | `docs/superpowers/plans/2026-08-26-aquamobil-v4-product-surfaces.md`    |
| Feeding foundation      | F0, F1a, F2, F1b, auxiliary verification, foundation finding-close gate                     | `docs/superpowers/plans/2026-08-26-aquamobil-v4-feeding-foundation.md`  |
| VFD and loop            | F3, F4, F5, V6, VFD/V6 finding-close gate                                                   | `docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md`    |
| Closeout                | 35-object verification, exact-main runs, report, protected archive, approved-action receipt | `docs/superpowers/plans/2026-08-26-aquamobil-v4-closeout.md`            |

## Branches and Topological Gates

Ranks are dependency levels, not a single serial queue.

| Rank | Branch                                                   | Protected-main gate to start                                                        |
| ---: | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
|    0 | `chore/aquamobil-v4-program-bootstrap`                   | immutable refs fetched                                                              |
|   1a | `fix/aquamobil-i1-asset-boundary`                        | Order 0 merged                                                                      |
|   1b | `feat/feeding-f0-weighing-authority`                     | Order 0 merged                                                                      |
|   2a | `feat/aquamobil-v0-appearance-foundation`                | I1 implementation and reconciliation merged                                         |
|   2b | `feat/feeding-f1a-compatibility-and-feeder-model-expand` | F0 implementation and reconciliation merged                                         |
|   3a | `chore/aquamobil-v0-findings-close`                      | V0 implementation and reconciliation merged                                         |
|   3b | `feat/feeding-f2-event-language`                         | F1a and I1 slice reconciliations merged                                             |
|   4a | `feat/aquamobil-v1-shell`                                | V0 finding-close PR and reconciliation merged                                       |
|   4b | `feat/feeding-f1b-assignment-api`                        | F2 reconciliation merged                                                            |
|   5a | `feat/aquamobil-v2-field-workflows`                      | V1 reconciliation; generated input prerequisite green                               |
|   5b | `chore/aquamobil-v4-feeding-foundation-verification`     | F0, F1a, F2, and F1b reconciliations merged                                         |
|   5c | `chore/aquamobil-v4-feeding-findings-close`              | feeding foundation verification PR merged and canonical worktree cleaned            |
|   6a | `feat/aquamobil-v3-messaging-surfaces`                   | V2 reconciliation merged; TankCard authority settled                                |
|   6b | `feat/aquamobil-v4-report-surfaces`                      | V2 reconciliation merged; generated farm-summary and queued-mutation inputs green   |
|   6c | `feat/feeding-f3-vfd-attestation`                        | feeding finding-close PR and closure reconciliation merged                          |
|   7a | `feat/aquamobil-v5-tablet-board`                         | V3/V4 reconciliations merged; V2 remains main-reachable transitively                |
|   7b | `feat/feeding-f4-calibration-physics`                    | F3 reconciliation merged                                                            |
|   8a | `chore/aquamobil-v4-product-findings-close`              | V1 through V5 reconciliations merged                                                |
|   8b | `feat/feeding-f5-loop-completion`                        | F4 reconciliation merged                                                            |
|    9 | `feat/aquamobil-v4-ui-convergence`                       | product finding-close PR and closure reconciliation merged; generation matrix green |
|   10 | `chore/aquamobil-v4-ui-convergence-finding-close`        | UI implementation and reconciliation merged                                         |
|   11 | `feat/aquamobil-v6-vfd-operations`                       | UI finding-close reconciliation and F5 reconciliation merged                        |
|   12 | `chore/aquamobil-v4-vfd-findings-close`                  | F3 through F5 and V6 reconciliations merged                                         |
|   13 | `chore/aquamobil-v4-integration-closeout`                | all 16 slice and all five closure reconciliations merged                            |
|   14 | `chore/aquamobil-v4-semantic-supersession`               | tooling merged; exact tooling-main run captured                                     |
|   15 | `chore/aquamobil-v4-provenance-archive`                  | report merged; exact report-main run captured                                       |
|   16 | `chore/aquamobil-v4-source-action-receipt`               | at least one approved remote action and fresh-clone audit complete                  |

V3 and V4 are the only parallel frontend implementation slices. V2 first resolves the shared
`TankCard.tsx` authority and is reconciled. V3 and V4 then start in separate fresh coordinator
worktrees from that exact protected-main state, so both immutable preflight `baseMainCommit` values
contain the V2 component and generated-input authorities they consume. F0 and F1a may run beside I1
because neither consumes a CI fixture image. F2 is the feeding join: its worktree cannot be created
until both F1a and I1 slice reconciliations are protected-main-reachable. From F2 through F5 the
feeding chain remains sequential internally. Feeding Task 17 starts its auxiliary verification
branch only after F1b reconciliation, merges that evidence through a protected PR, and cleans its
canonical worktree before the separate feeding finding-close branch starts. That auxiliary branch
does not change the fixed 16-slice/five-closure totals. A one-boundary slice reconciles after that
merge; F0 and F1a reconcile only after all three ordered protected boundaries are merged and
deployed as required by their detailed plan.

`slice-branches.json` pins these exact ordered implementation-boundary IDs. Each ID represents one
protected PR/main attestation; the array cannot be collapsed to its final element.

| Slice          | `implementationBoundaryIds`                                                                         | Exact protected branches                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1             | `asset-storage-and-tls-boundary`                                                                    | `fix/aquamobil-i1-asset-boundary`                                                                                                                              |
| V0             | `appearance-foundation`                                                                             | `feat/aquamobil-v0-appearance-foundation`                                                                                                                      |
| V1             | `shell`                                                                                             | `feat/aquamobil-v1-shell`                                                                                                                                      |
| V2             | `field-workflows`                                                                                   | `feat/aquamobil-v2-field-workflows`                                                                                                                            |
| V3             | `messaging-surfaces`                                                                                | `feat/aquamobil-v3-messaging-surfaces`                                                                                                                         |
| V4             | `report-surfaces`                                                                                   | `feat/aquamobil-v4-report-surfaces`                                                                                                                            |
| V5             | `tablet-board`                                                                                      | `feat/aquamobil-v5-tablet-board`                                                                                                                               |
| UI-convergence | `ui-convergence`                                                                                    | `feat/aquamobil-v4-ui-convergence`                                                                                                                             |
| F0             | `weighing-authority-expand`, `batch-protocol-reader-contract`, `batch-protocol-physical-contract`   | `feat/feeding-f0-weighing-authority`, `refactor/feeding-f0-batch-protocol-reader-contract`, `refactor/feeding-f0-batch-protocol-column-drop`                   |
| F1a            | `compatibility-and-feeder-model-expand`, `array-reader-contract`, `legacy-scalar-physical-contract` | `feat/feeding-f1a-compatibility-and-feeder-model-expand`, `refactor/feeding-f1a-array-reader-contract`, `refactor/feeding-f1a-legacy-scalar-physical-contract` |
| F2             | `event-language-and-acl`                                                                            | `feat/feeding-f2-event-language`                                                                                                                               |
| F1b            | `assignment-api-and-gateway`                                                                        | `feat/feeding-f1b-assignment-api`                                                                                                                              |
| F3             | `vfd-attestation`                                                                                   | `feat/feeding-f3-vfd-attestation`                                                                                                                              |
| F4             | `calibration-physics`                                                                               | `feat/feeding-f4-calibration-physics`                                                                                                                          |
| F5             | `loop-completion`                                                                                   | `feat/feeding-f5-loop-completion`                                                                                                                              |
| V6             | `vfd-operations`                                                                                    | `feat/aquamobil-v6-vfd-operations`                                                                                                                             |

The six multi-boundary worktrees are exactly
`/var/aqua-saas/.worktrees/aquamobil-v4-f0-weighing-authority-expand`,
`/var/aqua-saas/.worktrees/aquamobil-v4-f0-batch-protocol-reader-contract`,
`/var/aqua-saas/.worktrees/aquamobil-v4-f0-batch-protocol-physical-contract`,
`/var/aqua-saas/.worktrees/aquamobil-v4-f1a-compatibility-and-feeder-model-expand`,
`/var/aqua-saas/.worktrees/aquamobil-v4-f1a-array-reader-contract`, and
`/var/aqua-saas/.worktrees/aquamobil-v4-f1a-legacy-scalar-physical-contract`.

Five closure definitions are also fixed in `slice-branches.json`. Its literal finding-title arrays
must equal the allocation tables in the named detailed plans; bootstrap tests parse those tables and
reject a missing, extra, reordered, or duplicate title.

| Closure                            | Ordered owners     | Map path                                                                      |                                                 Expected findings |
| ---------------------------------- | ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------: |
| `v0-high-findings`                 | I1, V0             | `docs/evidence/aquamobil-v4-delivery/v0-finding-closure-map.json`             | six allocated HIGH titles plus existing `SEC-MEDIUM-052`, total 7 |
| `ui-convergence-high-findings`     | UI-convergence     | `docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json` |                                 one allocated HIGH title, total 1 |
| `product-high-findings`            | V1, V2, V3, V4, V5 | `docs/evidence/aquamobil-v4-product/finding-closure-map.json`                 |                               five allocated HIGH titles, total 5 |
| `feeding-foundation-high-findings` | F0, F1a, F2, F1b   | `docs/evidence/aquamobil-v4-feeding/finding-closure-map.json`                 |                           fifteen allocated HIGH titles, total 15 |
| `vfd-feeding-loop-high-findings`   | F3, F4, F5, V6     | `docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json`             |                        twenty-two allocated HIGH titles, total 22 |

The same closure definitions pin their finding-close implementation branch and worktree. No detailed
plan may invent a second path or create one with raw Git commands.

| Closure                            | Exact implementation branch                       | Exact implementation worktree                                         |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `v0-high-findings`                 | `chore/aquamobil-v0-findings-close`               | `/var/aqua-saas/.worktrees/aquamobil-v4-v0-findings-close`            |
| `ui-convergence-high-findings`     | `chore/aquamobil-v4-ui-convergence-finding-close` | `/var/aqua-saas/.worktrees/aquamobil-v4-ui-convergence-finding-close` |
| `product-high-findings`            | `chore/aquamobil-v4-product-findings-close`       | `/var/aqua-saas/.worktrees/aquamobil-v4-product-findings-close`       |
| `feeding-foundation-high-findings` | `chore/aquamobil-v4-feeding-findings-close`       | `/var/aqua-saas/.worktrees/aquamobil-v4-feeding-findings-close`       |
| `vfd-feeding-loop-high-findings`   | `chore/aquamobil-v4-vfd-findings-close`           | `/var/aqua-saas/.worktrees/aquamobil-v4-vfd-findings-close`           |

The six allocated V0-closure titles are
`AquaMobil production asset requests can fall through to SPA HTML`,
`AquaMobil edge deployment identity can select the wrong host or certificate`,
`AquaMobil presigned object URLs expose the internal MinIO origin`,
`AquaMobil field surfaces lack one semantic primitive authority`,
`AquaMobil service-worker activation can mix shell generations`, and
`AquaMobil install metadata has duplicate build authorities`. The separate UI closure title is
`AquaMobil legacy appearance and package authorities remain active`.

---

### Task 1: Merge the Order 0 provenance and evidence bootstrap

**Files:**

- Create: `docs/superpowers/evidence/aquamobil-v4/source-commits.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/execution-ledger.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/slice-branches.json`
- Create: `tools/aquamobil-v4/verify-ledger.mjs`
- Create: `tools/aquamobil-v4/verify-ledger.spec.mjs`
- Create: `tools/aquamobil-v4/capture-github-evidence.mjs`
- Create: `tools/aquamobil-v4/capture-github-evidence.spec.mjs`
- Create: `tools/aquamobil-v4/capture-slice-audit.mjs`
- Create: `tools/aquamobil-v4/capture-slice-audit.spec.mjs`
- Create: `tools/aquamobil-v4/reconcile-ledger.mjs`
- Create: `tools/aquamobil-v4/reconcile-ledger.spec.mjs`
- Create: `tools/aquamobil-v4/worktree.mjs`
- Create: `tools/aquamobil-v4/worktree.spec.mjs`
- Create: `web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts`
- Modify: `web/apps/aquamobil/vite.config.ts`
- Create: `tests/invariants/aquamobil-audit-module-manifest.spec.ts`
- Modify: `scripts/ci/audit-source-map.mjs`
- Create: `scripts/ci/audit-source-map.spec.mjs`
- Modify: `package.json`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: immutable source Git objects and repository `Okan-wqm/aquaculture_platform`.
- Produces: the only source-history/evidence schemas, GitHub capture, exact dependency mapper,
  worktree coordinator, deterministic reconciler, and `aquamobil:v4:provenance:check`.

- [ ] **Step 1: Create and enter the exact Order 0 worktree**

```bash
common_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
repo_root="$(dirname "$common_git_dir")"
program_worktree="$repo_root/.worktrees/aquamobil-v4-coordinator"
test "$repo_root" = "/var/aqua-saas"
test ! -e "$program_worktree"
git -C "$repo_root" fetch origin \
  +refs/heads/main:refs/remotes/origin/main \
  +refs/heads/feature/aquamobil-v4-redesign:refs/remotes/origin/feature/aquamobil-v4-redesign
git -C "$repo_root" worktree add "$program_worktree" \
  -b chore/aquamobil-v4-program-bootstrap origin/main
cd "$program_worktree"
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

Expected: all following Order 0 commands run in `/var/aqua-saas/.worktrees/aquamobil-v4-coordinator`
at the fetched protected-main SHA.

- [ ] **Step 2: Write failing typed-evidence tests**

Pin these serialized interfaces:

```ts
type SliceId =
  | 'I1'
  | 'V0'
  | 'V1'
  | 'V2'
  | 'V3'
  | 'V4'
  | 'V5'
  | 'UI-convergence'
  | 'F0'
  | 'F1a'
  | 'F2'
  | 'F1b'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'V6';
type FullSha = string;
type Repository = 'Okan-wqm/aquaculture_platform';

type VerificationWorktreeName = 'feeding-foundation';

interface VerificationWorktreeDefinition {
  readonly branch: 'chore/aquamobil-v4-feeding-foundation-verification';
  readonly worktree: '/var/aqua-saas/.worktrees/aquamobil-v4-feeding-foundation-verification';
}

interface VerificationWorktreeRegistry {
  readonly verificationWorktrees: Readonly<
    Record<VerificationWorktreeName, VerificationWorktreeDefinition>
  >;
}

interface CoordinationToolAttestation {
  readonly coordinatorMainCommit: FullSha;
  readonly executablePath: string;
  readonly executableBlobSha: FullSha;
}

interface GitHubPullRequestAttestation {
  readonly kind: 'github-pull-request';
  readonly repository: Repository;
  readonly number: number;
  readonly url: string;
  readonly state: 'MERGED';
  readonly baseRefName: 'main';
  readonly headRefName: string;
  readonly resultingMainCommit: FullSha;
  readonly mergedAt: string;
  readonly apiResponseSha256: string;
}

interface GitHubWorkflowRunAttestation {
  readonly kind: 'github-workflow-run';
  readonly repository: Repository;
  readonly workflowPath: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly url: string;
  readonly event: 'pull_request' | 'merge_group' | 'push' | 'workflow_dispatch' | 'workflow_call';
  readonly conclusion: 'success';
  readonly headSha: FullSha;
  readonly workflowBlobSha: FullSha;
  readonly artifact: {
    readonly id: number;
    readonly name: string;
    readonly digest: string;
  } | null;
  readonly apiResponseSha256: string;
}

interface DependencyReachabilityEvidence {
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
}

type CiImageAuthorityEvidence =
  | {
      readonly state: 'planned-absence';
      readonly manifestPath: 'infrastructure/ci/image-digests.json';
      readonly manifestBlob: null;
      readonly resolverPath: 'scripts/ci/resolve-ci-image.mjs';
      readonly resolverBlob: null;
      readonly i1ReconciliationCommit: null;
    }
  | {
      readonly state: 'present';
      readonly manifestPath: 'infrastructure/ci/image-digests.json';
      readonly manifestBlob: FullSha;
      readonly resolverPath: 'scripts/ci/resolve-ci-image.mjs';
      readonly resolverBlob: FullSha;
      readonly postgresAuthorityPath: '.github/manifests/postgres-image.json';
      readonly postgresAuthorityBlob: FullSha;
      readonly i1ReconciliationCommit: FullSha | null;
    };

interface SliceAudit {
  readonly schemaVersion: 1;
  readonly slice: SliceId;
  readonly sourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly baseMainCommit: FullSha;
  readonly planPath: string;
  readonly taskNumbers: readonly number[];
  readonly ownedPaths: readonly string[];
  readonly mainOnlyCommits: readonly FullSha[];
  readonly authorityDecisions: readonly {
    readonly authority: string;
    readonly path: string;
    readonly decision: 'retain' | 'replace' | 'remove';
  }[];
  readonly migrationPaths: readonly string[];
  readonly ciImageAuthority: CiImageAuthorityEvidence;
  readonly dependencyEvidence: readonly DependencyReachabilityEvidence[];
  readonly auditMapperTool: CoordinationToolAttestation;
  readonly captureTool: CoordinationToolAttestation;
  readonly rejectedSourceAssumptions: readonly string[];
}

interface GeneratedArtifactEvidence {
  readonly path: string;
  readonly generator: string;
  readonly checkCommand: string;
  readonly resultingCommit: FullSha;
  readonly contentSha256: string;
}

interface BaseAdvanceEvidence {
  readonly preflightBaseMainCommit: FullSha;
  readonly changedPathsSha256: string;
  readonly overlappingPaths: readonly string[];
  readonly resolution: 'no-overlap' | 'merged-main-and-rereviewed';
  readonly mainMergeCommit: FullSha | null;
  readonly mainMergeParents: readonly [FullSha, FullSha] | null;
  readonly mainMergeTree: FullSha | null;
  readonly mainMergeApiResponseSha256: string | null;
  readonly reviewApiResponseSha256: string;
}

interface ImplementationBoundaryEvidence {
  readonly boundaryId: string;
  readonly pullRequest: GitHubPullRequestAttestation;
  readonly reviewedBaseMainCommit: FullSha;
  readonly testedMergeCandidateCommit: FullSha;
  readonly testedMergeCandidateTree: FullSha;
  readonly resultingMainTree: FullSha;
  readonly baseAdvance: BaseAdvanceEvidence;
  readonly resultingMainCommit: FullSha;
  readonly workflowRuns: readonly GitHubWorkflowRunAttestation[];
  readonly generatedArtifacts: readonly GeneratedArtifactEvidence[];
  readonly captureTool: CoordinationToolAttestation;
}

interface SliceMergeEvidence {
  readonly schemaVersion: 1;
  readonly slice: SliceId;
  readonly preflightPath: string;
  readonly implementationBoundaries: readonly [
    ImplementationBoundaryEvidence,
    ...ImplementationBoundaryEvidence[],
  ];
  readonly reconciliationTool: CoordinationToolAttestation;
  readonly rejectedSourceAssumptions: readonly string[];
}

type ClosureName =
  | 'v0-high-findings'
  | 'ui-convergence-high-findings'
  | 'product-high-findings'
  | 'feeding-foundation-high-findings'
  | 'vfd-feeding-loop-high-findings';

interface ClosureEvidence {
  readonly schemaVersion: 1;
  readonly closure: ClosureName;
  readonly ownerSlices: readonly SliceId[];
  readonly closureMapPath: string;
  readonly pullRequest: GitHubPullRequestAttestation;
  readonly resultingMainCommit: FullSha;
  readonly closingCommitsByFinding: Readonly<Record<string, FullSha>>;
  readonly generatedArtifacts: readonly GeneratedArtifactEvidence[];
  readonly verificationRuns: readonly GitHubWorkflowRunAttestation[];
  readonly captureTool: CoordinationToolAttestation;
  readonly reconciliationTool: CoordinationToolAttestation;
}

interface OwnerEvidence {
  readonly slice: SliceId;
  readonly preflightPath: string;
  readonly mergePath: string;
  readonly implementationBoundaries: readonly [
    ImplementationBoundaryEvidence,
    ...ImplementationBoundaryEvidence[],
  ];
  readonly closureEvidencePaths: readonly string[];
  readonly closingCommitsByFinding: Readonly<Record<string, FullSha>>;
  readonly rejectedSourceAssumptions: readonly string[];
}

interface SourceCommitDisposition {
  readonly sourceCommit: FullSha;
  readonly subject: string;
  readonly disposition: 'reimplement' | 'split-reimplement' | 'exclude';
  readonly approvedOwners: readonly SliceId[];
  readonly ownerEvidence: Readonly<Record<SliceId, OwnerEvidence>>;
  readonly status: 'planned' | 'merged' | 'excluded-pending-verification' | 'excluded-verified';
  readonly exclusionEvidence: readonly GitHubWorkflowRunAttestation[];
  readonly excludedArtifactReason:
    | null
    | 'documentation-only'
    | 'format-only'
    | 'independent-invariant-already-on-main';
}

interface MergeResolutionRecord {
  readonly sourceCommit:
    | 'd6cc9d889b26a2566fe0211868e8faf7f2b34b23'
    | '1cae13834df31b4f5f982785e27b68d717d3de0b';
  readonly orderedParents: readonly [FullSha, FullSha];
  readonly resultTree: FullSha;
  readonly resolvedPaths: readonly [
    'docs/reviews/orphan-findings.md',
    'tools/quality/format-scope.json',
  ];
  readonly resultBlobs: Readonly<Record<string, FullSha>>;
  readonly disposition: 'exclude-merge-resolution';
  readonly status: 'planned' | 'excluded-verified';
  readonly currentMainVerification: readonly GitHubWorkflowRunAttestation[];
}

interface AquaMobilV4ExecutionLedger {
  readonly schemaVersion: 3;
  readonly repository: Repository;
  readonly anchors: {
    readonly main: '4002868c535a2d8676aad6eadd5f4bbd57d4625b';
    readonly source: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
    readonly mergeBase: '8d8d54365ada11d45b43374af76e9814c5958ff0';
  };
  readonly rows: readonly SourceCommitDisposition[];
}
```

Tests require full SHAs, exact repository PR/run URLs, successful API state, matching run
attempt/head/workflow blob and server artifact digest. `ownerEvidence` keys must equal
`approvedOwners`; a split row cannot reuse another owner's PR/run. Every non-empty
`implementationBoundaries` tuple must equal the plan-pinned IDs in order. F0 and F1a require three
distinct PR/main/run attestations; using only their last physical-contraction PR fails. Closure
owner sets, paths, title-derived live IDs, trailer commits, and generated artifacts must match the
five pinned definitions. Foreign repositories, branch URLs, failed runs, short SHAs, manual
reachability flags, and non-main results fail closed. Reimplemented rows require
`excludedArtifactReason: null`; each excluded row requires the one exact non-null reason matching
its reproducible exclusion class. `ciImageAuthority.state: 'planned-absence'` is valid only for I1,
F0, or F1a and only when both pinned paths are absent from `baseMainCommit`; F0/F1a additionally
prove no I1 implementation merge is an ancestor of that base. A present/absent split fails. A
`present` record hashes all three exact Git blobs and reruns the closed-schema resolver tests. Only
F0/F1a may temporarily carry `i1ReconciliationCommit: null`; every other non-I1 slice requires a
full main-reachable I1 reconciliation commit, and F2's predecessor proof must name that same commit.
For each boundary, `reviewedBaseMainCommit` is the latest PR/merge-queue base and the preflight base
is its ancestor. Canonical base-advance evidence either has an empty owned/shared-authority overlap
set with `resolution: 'no-overlap'`, or lists every overlap and proves
`resolution: 'merged-main-and-rereviewed'` with the normal main-merge commit plus a distinct updated
review API digest. The two states cannot mix. Every required PR workflow checks out
`testedMergeCandidateCommit`, records that exact base and every executed repository-tool blob, and
has no newer untested candidate. Post-merge capture requires the tested candidate tree to equal
`resultingMainCommit^{tree}`; a stale PR-head-only run fails.

For every post-bootstrap protected PR that is not an implementation boundary or finding-close PR,
`capture-github-evidence.mjs` exposes this generic merge-time interface:

```text
--verify-prospective-program-pr <pull-request-number>
--repository Okan-wqm/aquaculture_platform
--pr-kind <slice-reconciliation|auxiliary-verification|closure-reconciliation|closeout-tooling|closeout-report|closeout-archive|closeout-receipt>
--expected-head <exact-branch>
--verify-base-advance
--require-latest-merge-queue-candidate
```

The mode resolves the current protected-main base, exact head branch/SHA, latest synthetic
merge-queue candidate, approval submitted for that candidate lineage, repository-owned required
workflow artifacts, and candidate/base/tool-blob hashes directly from GitHub. It computes the
canonical changed-path intersection between the branch's pinned creation base and reviewed main.
Zero overlap records `no-overlap`; overlap requires a normal main-into-branch merge, complete rerun,
and a distinct later review and records `merged-main-and-rereviewed`. It derives the allowed path
set from the selected `pr-kind` plus the Order 0 registry and rejects product changes in
evidence-only PRs, a caller-supplied path waiver, a rebased/force-updated lineage, an earlier
candidate, a head-only run, or any base/head/candidate change after the latest approval. The five
detailed-plan finding-close invocations remain on `--verify-prospective-closure-pr`, but that
specialized mode is subject to the identical base-advance and latest-candidate contract.

After Order 0 merges, every local human/agent invocation of an Order 0 coordination, capture, audit,
or reconcile executable resolves its own `import.meta.url`, requires that path to be inside the
clean detached coordinator, hashes its on-disk bytes with Git's blob algorithm, and matches
`HEAD:<repo-relative executable path>`. Each post-bootstrap serialized slice/closure output stores
the resulting `CoordinationToolAttestation`; a capture and reconciler have distinct attestations.
Executing an active branch's copy, a dirty coordinator copy, a file whose blob differs from
coordinator HEAD, or an executable at the dirty root fails tests and runtime validation.
Coordinator-owned local executables import only `node:` built-ins; tests reject bare-package or
`node_modules` resolution so a persistent coordinator cannot silently execute dependencies from an
older main lock. Any future shared repo-local helper requires an explicit schema revision that
attests every imported blob before this restriction may be relaxed.

`capture-slice-audit.spec.mjs` reads the four committed detailed plans and pins both canonical
`Files` item forms: a path on the marker line and Prettier's one-line indented continuation after
`- Create:`, `- Modify:`, `- Delete:`, or `- Regenerate:`. Regression fixtures must include these
exact wrapped paths without relying on line numbers:
`apps/messaging-service/src/message/services/__tests__/s3-storage-object-verifier.service.spec.ts`,
`web/apps/aquamobil/src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx`,
and
`apps/farm-service/src/feeding/services/__tests__/daily-feeding-execution.protocol-rate.spec.ts`.
The test independently tokenizes the Markdown list items, requires exact set equality with the
tool's canonical `ownedPaths`, and fails on an orphan continuation, a second continuation line,
missing or multiple backtick paths, duplicates, or an empty mapped task. A line-oriented parser that
silently omits a wrapped item must therefore fail before implementation.

The sole bootstrap exception is an explicit `--bootstrap-authoring` mode used below before the tool
exists on main. It accepts only the exact Order 0 branch/base and only initial source-history,
planned-ledger, merge-resolution, or ignored bootstrap-audit outputs; it cannot create or validate a
slice, boundary, closure, terminal ledger, or GitHub attestation. It refuses once `origin/main`
contains the tool. Tests pin all those negative cases, and the normal self-attested mode is rerun
from detached coordinator immediately after protected merge. Exact-head GitHub Actions and committed
CI/package scripts invoke checkout-local tools because hosted runners have no persistent local
worktree; their workflow/head/tool-blob attestations provide the equivalent binding.

```bash
node --test \
  tools/aquamobil-v4/verify-ledger.spec.mjs \
  tools/aquamobil-v4/capture-github-evidence.spec.mjs \
  tools/aquamobil-v4/capture-slice-audit.spec.mjs \
  tools/aquamobil-v4/reconcile-ledger.spec.mjs \
  tools/aquamobil-v4/worktree.spec.mjs \
  scripts/ci/audit-source-map.spec.mjs
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-audit-module-manifest.spec.ts
```

Expected: FAIL because the tools/files do not exist and the current audit mapper cannot prove chains
or bundle reachability.

- [ ] **Step 3: Generate all 35 source-history objects from Git**

```bash
node tools/aquamobil-v4/verify-ledger.mjs \
  --bootstrap-authoring \
  --write-source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --write-initial-ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --write-initial-merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --merge-base 8d8d54365ada11d45b43374af76e9814c5958ff0 \
  --source-tip 542c8e0bb7ff3afbeee0496f277f8926526cc41a
test "$(git rev-list --count 8d8d54365ada11d45b43374af76e9814c5958ff0..542c8e0bb7ff3afbeee0496f277f8926526cc41a)" -eq 35
test "$(git rev-list --count --no-merges 8d8d54365ada11d45b43374af76e9814c5958ff0..542c8e0bb7ff3afbeee0496f277f8926526cc41a)" -eq 33
test "$(git rev-list --count --merges 8d8d54365ada11d45b43374af76e9814c5958ff0..542c8e0bb7ff3afbeee0496f277f8926526cc41a)" -eq 2
test "$(git rev-list --reverse --merges 8d8d54365ada11d45b43374af76e9814c5958ff0..542c8e0bb7ff3afbeee0496f277f8926526cc41a | sort | tr '\n' ' ')" = \
  "1cae13834df31b4f5f982785e27b68d717d3de0b d6cc9d889b26a2566fe0211868e8faf7f2b34b23 "
```

For each merge, record ordered parents, `commit^{tree}`, and each resolution path's result blob OID.
These content-addressed Git objects are the deterministic fingerprint; never hash rendered
`--remerge-diff` text. A fixed
`LC_ALL=C git -c color.ui=false --no-pager show --no-ext-diff --no-color --no-renames` invocation
may only verify the exact two path names.

- [ ] **Step 4: Make audit reachability deterministic and machine-derived**

Extend `scripts/ci/audit-source-map.mjs` with this exact interface:

```bash
node /var/aqua-saas/.worktrees/aquamobil-v4-coordinator/scripts/ci/audit-source-map.mjs \
  --bootstrap-authoring \
  --capture-explain-set \
  --root-audit-full artifacts/aquamobil-v4/bootstrap/audit-root-full.json \
  --root-audit-runtime artifacts/aquamobil-v4/bootstrap/audit-root-runtime.json \
  --aquamobil-audit-full artifacts/aquamobil-v4/bootstrap/audit-aquamobil-full.json \
  --aquamobil-audit-runtime artifacts/aquamobil-v4/bootstrap/audit-aquamobil-runtime.json \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json artifacts/aquamobil-v4/bootstrap/audit-set.json \
  --write-explain-set-json artifacts/aquamobil-v4/bootstrap/npm-explain-set.json
node /var/aqua-saas/.worktrees/aquamobil-v4-coordinator/scripts/ci/audit-source-map.mjs \
  --bootstrap-authoring \
  --audit-set-json artifacts/aquamobil-v4/bootstrap/audit-set.json \
  --explain-set-json artifacts/aquamobil-v4/bootstrap/npm-explain-set.json \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest artifacts/aquamobil-v4/bootstrap/aquamobil-vite-rollup-modules.json \
  --output-json artifacts/aquamobil-v4/bootstrap/dependency-reachability.json \
  --output-markdown artifacts/aquamobil-v4/bootstrap/dependency-reachability.md
```

The capture mode parses the four audit documents, sorts the unique high/critical package names per
installation, validates each as data, and invokes locked npm without a shell as
`npm [--prefix <install>] explain <package> --json`. It writes the only canonical four-audit set and
package-keyed explain set. A bare `npm explain --json`, ambiguous `--audit-json`/`--explain-json`,
missing package, non-JSON output, advisory/install disagreement, or nonzero explain status fails
closed.

`audit-module-manifest-plugin.ts` is a no-op unless `AQUAMOBIL_AUDIT_MODULE_MANIFEST` names a
repo-relative path below ignored `artifacts/`. During the real production Vite build's
`generateBundle`, it writes deterministic sorted emitted chunks and their deduplicated
`chunk.modules` IDs. It normalizes real modules to repo-relative POSIX paths, removes only
recognized Vite virtual/query wrappers before classification, and rejects any output carrying an
absolute/out-of-repository path, query, timestamp, URL, or nondeterministic field. The build does
not ship this evidence in `dist`. Tests compare two clean production builds byte-for-byte and prove
that an imported browser dependency appears while an unbundled fixture does not.

Fixed mapper fixtures require complete root-to-package chains, both lock authorities,
production-lock runtime classification, and release-build classification for executable tools
including direct `esbuild`. Direct esbuild remains separately reachable release-build tooling; its
appearance-IIFE graph is never treated as whole-browser evidence. AquaMobil browser reachability is
true only when the package resolves through the real production Vite/Rollup module manifest to an
emitted chunk. Output is sorted and contains no current timestamp, absolute path, URL query, or
manually supplied reachability.

- [ ] **Step 5: Add canonical commands and make Order 0 green**

```json
"aquamobil:v4:provenance:check": "node tools/aquamobil-v4/verify-ledger.mjs --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json",
"aquamobil:v4:ledger:check": "npm run aquamobil:v4:provenance:check",
"aquamobil:v4:ledger:reconcile": "node tools/aquamobil-v4/reconcile-ledger.mjs"
```

The exact value of `slice-branches.json.verificationWorktrees` is:

```json
{
  "feeding-foundation": {
    "branch": "chore/aquamobil-v4-feeding-foundation-verification",
    "worktree": "/var/aqua-saas/.worktrees/aquamobil-v4-feeding-foundation-verification"
  }
}
```

`worktree.mjs` exposes this exact later-runtime CLI. Bootstrap tests exercise every command against
an isolated Git fixture; Order 0 does not create the live verification branch:

```text
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create-verification --verification feeding-foundation --main-ref origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-branch --verification feeding-foundation
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-path --verification feeding-foundation
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" --verify-prospective-program-pr "$verification_pr_number" --repository Okan-wqm/aquaculture_platform --pr-kind auxiliary-verification --expected-head chore/aquamobil-v4-feeding-foundation-verification --verify-base-advance --require-latest-merge-queue-candidate
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup --verification feeding-foundation --repository Okan-wqm/aquaculture_platform --main-ref origin/main
```

`slice-branches.json` stores every literal branch/rank/dependency above, exact detailed-plan task
numbers, each ordered `implementationBoundaryIds` array, its one-to-one protected branch/worktree
mapping, the singleton auxiliary `verificationWorktrees` registry, and all five closure definitions.
Bootstrap fixtures explicitly pin I1 to `/var/aqua-saas/.worktrees/aquamobil-v4-i1`, V0 to
`/var/aqua-saas/.worktrees/aquamobil-v4-v0`, and UI-convergence to
`/var/aqua-saas/.worktrees/aquamobil-v4-ui-convergence`; mismatch fails before branch creation. Each
closure definition contains its fixed JSON path, ordered owner set, map path, exact ordered
finding-title array, exact existing finding-ID array, and total count. Bootstrap tests parse the
detailed plans' allocation tables and reject drift; for the V0 closure they require the six literal
titles above plus `SEC-MEDIUM-052`, while the UI legacy title remains separate. `worktree.mjs` reads
this file and the Git common directory; it rejects an existing path, dirty worktree, stale main,
missing cross-slice predecessor reconciliation, missing prior-boundary main/deployment evidence,
branch reuse, or any path outside `/var/aqua-saas/.worktrees/`. Its plan-pinned predecessor map
makes V2 depend on V1, V3 and V4 depend on V2, V5 depend on V3 and V4 (with V2 implied
transitively), and F2 depend on both F1a and I1 slice reconciliations. A single F2 predecessor,
implementation-only evidence, or an I1 PR without its immutable reconciliation record fails before
worktree creation. `create-verification --verification feeding-foundation` is valid only after the
exact F0, F1a, F2, and F1b slice reconciliation records are protected-main ancestors. It creates
only the configured branch/path at fetched `origin/main`; `print-branch` and `print-path` resolve
the same singleton entry. `cleanup --verification feeding-foundation` resolves exactly one merged
protected PR with that configured head, proves its resulting main commit and committed feeding
verification evidence are main-reachable, requires the worktree clean, then detaches and removes
only that configured path. Every mode is self-bound to the clean detached coordinator executable.
Unknown verification names, extra registry entries or fields, a branch/path reused by a slice or
closure, missing predecessor reconciliation, stale main, an existing branch/path, zero or ambiguous
merged PRs, dirty state, or any path outside `/var/aqua-saas/.worktrees/` fails closed. The
auxiliary lifecycle never creates a slice preflight/merge record or closure record and never invokes
the reconciler or writes `execution-ledger.json`. `create-finding-closure` requires every configured
owner slice reconciliation on exact protected main and creates only the configured branch/path;
generic `print-path`, `print-branch`, and `cleanup` resolve that same entry when passed `--closure`.
Cleanup calls GitHub for exactly one configured merged PR, proves its resulting main commit is
reachable, then requires the exact worktree to be clean before detach/removal. The
`print-active-reconciliation-*` and `print-active-closure-*` queries require exactly one matching
configured worktree and fail on zero, ambiguity, a mismatched branch, or a path outside that root.

```bash
node --test \
  tools/aquamobil-v4/verify-ledger.spec.mjs \
  tools/aquamobil-v4/capture-github-evidence.spec.mjs \
  tools/aquamobil-v4/capture-slice-audit.spec.mjs \
  tools/aquamobil-v4/reconcile-ledger.spec.mjs \
  tools/aquamobil-v4/worktree.spec.mjs \
  scripts/ci/audit-source-map.spec.mjs
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-audit-module-manifest.spec.ts
npm run aquamobil:v4:provenance:check -- --bootstrap-authoring
```

Expected: `35 history objects = 33 non-merge rows + 2 planned merge-resolution records`.

- [ ] **Step 6: Commit, push, review, and merge Order 0**

```bash
npx prettier --check \
  docs/superpowers/evidence/aquamobil-v4 \
  tools/aquamobil-v4 \
  web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts \
  web/apps/aquamobil/vite.config.ts \
  tests/invariants/aquamobil-audit-module-manifest.spec.ts \
  scripts/ci/audit-source-map.mjs \
  scripts/ci/audit-source-map.spec.mjs \
  package.json
git diff --check
git add -- \
  docs/superpowers/evidence/aquamobil-v4 \
  tools/aquamobil-v4 \
  web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts \
  web/apps/aquamobil/vite.config.ts \
  tests/invariants/aquamobil-audit-module-manifest.spec.ts \
  scripts/ci/audit-source-map.mjs \
  scripts/ci/audit-source-map.spec.mjs \
  package.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): establish v4 integration evidence" \
  -m "Freeze all 35 source objects and make ownership, GitHub provenance, dependency reachability, and protected-main reconciliation machine-verifiable before implementation."
git push --set-upstream origin chore/aquamobil-v4-program-bootstrap
bootstrap_pr_url="$(gh pr create \
  --base main \
  --head chore/aquamobil-v4-program-bootstrap \
  --title "chore(aquamobil): establish v4 integration evidence" \
  --body "Freezes the 35-object history and installs the reviewed evidence boundary required before implementation.")"
bootstrap_pr_number="$(gh pr view "$bootstrap_pr_url" --json number --jq '.number')"
gh pr checks "$bootstrap_pr_number" --watch --fail-fast
gh pr view "$bootstrap_pr_number" \
  --json state,reviewDecision,baseRefName,headRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-program-bootstrap")'
```

Merge only through the authorized protected workflow. Then:

```bash
repo_root=/var/aqua-saas
program_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C "$repo_root" fetch origin +refs/heads/main:refs/remotes/origin/main
mapfile -t bootstrap_pr_numbers < <(gh pr list --state merged --base main \
  --head chore/aquamobil-v4-program-bootstrap --json number,title \
  --jq '.[] | select(.title == "chore(aquamobil): establish v4 integration evidence") | .number')
test "${#bootstrap_pr_numbers[@]}" -eq 1
BOOTSTRAP_PR_NUMBER="${bootstrap_pr_numbers[0]}"
bootstrap_main_sha="$(gh pr view "$BOOTSTRAP_PR_NUMBER" --json state,mergedAt,mergeCommit \
  --jq 'select(.state == "MERGED" and .mergedAt != null) | .mergeCommit.oid')"
[[ "$bootstrap_main_sha" =~ ^[0-9a-f]{40}$ ]]
git -C "$repo_root" merge-base --is-ancestor "$bootstrap_main_sha" origin/main
test "$(git -C "$repo_root" show origin/main:docs/superpowers/evidence/aquamobil-v4/source-commits.json | jq 'length')" -eq 35
test -z "$(git -C "$program_worktree" status --porcelain)"
test "$program_worktree" = "/var/aqua-saas/.worktrees/aquamobil-v4-coordinator"
test "$program_worktree" != "$repo_root"
git -C "$program_worktree" switch --detach origin/main
test "$(git -C "$program_worktree" rev-parse HEAD)" = \
  "$(git -C "$repo_root" rev-parse origin/main)"
cd "$program_worktree"
test -z "$(git status --porcelain)"
node "$program_worktree/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2
```

Expected: Order 0 is a protected-main ancestor and the clean detached coordinator remains available
as the only local orchestration tool source until final closeout cleanup. The normal, non-authoring
verifier has re-read the same three committed bootstrap artifacts through its coordinator
self-check; I1 cannot start if that post-merge pass fails.

Every later coordination action begins in a new shell with this complete canonical refresh; no
shortened variant or inherited variable is valid:

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
```

Lifecycle commands run there. Capture, audit, and reconcile commands also use the coordinator's
absolute executable path, but first `cd` to the clean active implementation/reconciliation worktree
so every relative input/output resolves there. The executable self-binds its coordinator main/blob
attestation. Never execute a second copy from the active branch or root checkout.

---

### Task 2: Commit one typed preflight record per implementation slice

**Files:**

- Create: one `preflight.json` in each exact slice directory:
  `docs/superpowers/evidence/aquamobil-v4/slices/I1/`, `V0/`, `V1/`, `V2/`, `V3/`, `V4/`, `V5/`,
  `UI-convergence/`, `F0/`, `F1a/`, `F2/`, `F1b/`, `F3/`, `F4/`, `F5/`, and `V6/`.

**Interfaces:**

- Consumes: Order 0, current main, exact plan/task mapping, migration manifests, dependency graphs,
  and the observed image-digest authority state. I1 records planned absence for its owned outputs.
  F0/F1a may record the same planned absence only when their immutable preflight base predates the
  I1 implementation merge and both I1-owned paths are absent, because neither consumes a CI fixture
  image. If either path is present they require both exact authorities, even while I1 reconciliation
  is pending. F2 and every later slice require the exact I1-owned manifest, resolver, and
  reconciliation from protected main.
- Produces: one append-only `SliceAudit` committed by the slice's first boundary and consumed
  unchanged by every later plan-pinned boundary for that slice.

- [ ] **Step 1: Create and enter the ready boundary worktree**

For I1:

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
node tools/aquamobil-v4/worktree.mjs create \
  --slice I1 \
  --boundary asset-storage-and-tls-boundary \
  --main-ref origin/main
cd /var/aqua-saas/.worktrees/aquamobil-v4-i1
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

For every later boundary, invoke the same tested command with its literal slice and boundary IDs.
First rerun the complete coordinator fetch/clean/detach/HEAD-equality preamble above. The tool then
derives the exact branch/path from `slice-branches.json`, fetches protected main, and verifies all
cross-slice predecessor reconciliations. F2 has the exact two-element predecessor set `[F1a, I1]`;
order, omission, substitution with implementation evidence, or a merely open/merged I1 PR without
reconciliation fails. Within F0/F1a the tool instead verifies the prior boundary's protected merge
and required fleet/deployment evidence; slice reconciliation occurs only after the third boundary.
F0 and F1a therefore receive three fresh worktrees in pinned order. Skip detailed-plan
`git switch --create` lines because the coordinator already created each branch. Every fresh
boundary then repeats the two clean installs and lock-hash/diff assertions shown above; it never
symlinks or copies either `node_modules` tree from the root checkout or another worktree.

- [ ] **Step 2: Capture the preflight evidence**

For I1:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd /var/aqua-saas/.worktrees/aquamobil-v4-i1
test -z "$(git status --porcelain)"
mkdir -p artifacts/aquamobil-v4/I1
i1_preflight_build_id="$(git rev-parse HEAD)"
[[ "$i1_preflight_build_id" =~ ^[0-9a-f]{40}$ ]]
export AQUAMOBIL_BUILD_ID="$i1_preflight_build_id"
export AQUAMOBIL_AUDIT_MODULE_MANIFEST=artifacts/aquamobil-v4/I1/aquamobil-vite-rollup-modules.json
npm --prefix web/apps/aquamobil run build
test -s artifacts/aquamobil-v4/I1/aquamobil-vite-rollup-modules.json
set +e
npm audit --json > artifacts/aquamobil-v4/I1/audit-root-full.json
root_full_status="$?"
npm audit --omit=dev --json > artifacts/aquamobil-v4/I1/audit-root-runtime.json
root_runtime_status="$?"
npm --prefix web/apps/aquamobil audit --json > artifacts/aquamobil-v4/I1/audit-mobile-full.json
mobile_full_status="$?"
npm --prefix web/apps/aquamobil audit --omit=dev --json > artifacts/aquamobil-v4/I1/audit-mobile-runtime.json
mobile_runtime_status="$?"
set -e
printf '%s\n' "$root_full_status" "$root_runtime_status" "$mobile_full_status" "$mobile_runtime_status" \
  > artifacts/aquamobil-v4/I1/audit-exit-statuses.txt
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --capture-explain-set \
  --root-audit-full artifacts/aquamobil-v4/I1/audit-root-full.json \
  --root-audit-runtime artifacts/aquamobil-v4/I1/audit-root-runtime.json \
  --aquamobil-audit-full artifacts/aquamobil-v4/I1/audit-mobile-full.json \
  --aquamobil-audit-runtime artifacts/aquamobil-v4/I1/audit-mobile-runtime.json \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json artifacts/aquamobil-v4/I1/audit-set.json \
  --write-explain-set-json artifacts/aquamobil-v4/I1/npm-explain-set.json
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --audit-set-json artifacts/aquamobil-v4/I1/audit-set.json \
  --explain-set-json artifacts/aquamobil-v4/I1/npm-explain-set.json \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest artifacts/aquamobil-v4/I1/aquamobil-vite-rollup-modules.json \
  --output-json artifacts/aquamobil-v4/I1/dependency-reachability.json \
  --output-markdown artifacts/aquamobil-v4/I1/dependency-reachability.md
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice I1 \
  --main-ref origin/main \
  --source-ref origin/feature/aquamobil-v4-redesign \
  --artifact-root artifacts/aquamobil-v4/I1 \
  --write docs/superpowers/evidence/aquamobil-v4/slices/I1/preflight.json
```

`capture-slice-audit.mjs` parses and canonicalizes the four-audit set, package-keyed
`npm explain <package> --json` set, their named exit statuses, both production lock paths, real
production Vite/Rollup module manifest, and mapper output. It independently reruns the exact mapper
contract from Order 0 and requires byte-identical canonical output before embedding its
deterministic reachability evidence. It never converts an aggregate audit count or caller-supplied
boolean into a reachability decision.

The tool parses exact `Files` lists from the mapped detailed tasks, accepts only the two tested
same-line/one-continuation Markdown forms, proves the parsed set equals the independently tokenized
task list, and rejects an unlisted or omitted path. Every ownership and stale-base intersection
consumes that canonical set rather than caller-supplied paths. It fails on a changed source, a
non-ancestor base, unresolved overlap/authority, migration collision, missing chain/bundle proof, or
reachable high/critical finding. I1 preflight records the current absence of
`infrastructure/ci/image-digests.json` and `scripts/ci/resolve-ci-image.mjs` as planned owned
authorities, while recording `.github/manifests/postgres-image.json` as the retained PostgreSQL
authority; it does not require the planned outputs before I1 implements them. F0/F1a use that same
typed planned-absence state only if `baseMainCommit` predates the I1 implementation merge and both
planned paths are absent. If either path exists, the tool requires both and validates their exact
schema/blobs even if I1 reconciliation is not yet main-reachable; a mixed present/absent state
fails. No other slice may serialize planned absence. The prospective I1 PR and its reconciliation
must prove the closed resolver schema, exact PostgreSQL external path/pointer, five inline pins,
every resolver consumer, invariant/unit tests, and successful workflow evidence before I1 can merge
or become terminal. F2 and all later preflights reject absence and require those exact I1 outputs
and reconciliation on main.

- [ ] **Step 3: Verify and stage only the owner record**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd /var/aqua-saas/.worktrees/aquamobil-v4-i1
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice I1 \
  --check docs/superpowers/evidence/aquamobil-v4/slices/I1/preflight.json \
  --main-ref origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json
git diff --check
```

The first boundary commit stages its own `preflight.json` with its test-first code. Later boundaries
consume that main-reachable file unchanged. A PR invariant rejects `execution-ledger.json`,
`merge-resolutions.json`, any `merge.json`, closure record, another slice directory, or a later
rewrite of the preflight on an implementation branch.

- [ ] **Step 4: Verify each protected boundary merge and clean its exact worktree**

Re-establish `SLICE_ID` and `BOUNDARY_ID` from the two literals in the detailed task; never inherit
them from a previous shell. After the authorized merge:

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
[[ "$SLICE_ID" =~ ^(I1|V0|V1|V2|V3|V4|V5|UI-convergence|F0|F1a|F2|F1b|F3|F4|F5|V6)$ ]]
BOUNDARY_BRANCH="$(node tools/aquamobil-v4/worktree.mjs print-branch \
  --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
BOUNDARY_WORKTREE="$(node tools/aquamobil-v4/worktree.mjs print-path \
  --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
[[ "$BOUNDARY_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-* ]]
test "$BOUNDARY_WORKTREE" != "/var/aqua-saas"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
mapfile -t boundary_pr_numbers < <(gh pr list --state merged --base main \
  --head "$BOUNDARY_BRANCH" --json number --jq '.[].number')
test "${#boundary_pr_numbers[@]}" -eq 1
BOUNDARY_MAIN_SHA="$(gh pr view "${boundary_pr_numbers[0]}" --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$BOUNDARY_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$BOUNDARY_MAIN_SHA" origin/main
test -z "$(git -C "$BOUNDARY_WORKTREE" status --porcelain)"
git -C "$BOUNDARY_WORKTREE" switch --detach origin/main
git -C /var/aqua-saas merge-base --is-ancestor \
  "$(git -C "$BOUNDARY_WORKTREE" rev-parse HEAD)" origin/main
git -C /var/aqua-saas worktree remove "$BOUNDARY_WORKTREE"
test ! -e "$BOUNDARY_WORKTREE"
```

For F0/F1a, this cleanup does not reconcile the slice early. The next boundary coordinator verifies
the protected merge and deployment evidence; `merge.json` is created only after boundary three.

---

### Task 3: Merge slices and reconcile protected-main evidence serially

**Files:**

- Create: one `merge.json` under each of the 16 exact slice directories from Task 2.
- Modify: `docs/superpowers/evidence/aquamobil-v4/execution-ledger.json` only through
  `reconcile-ledger.mjs --write`.

**Interfaces:**

- Consumes: every reviewed boundary PR in the exact order pinned for its slice, the preflight,
  protected-main results, repository-bound successful runs, generated hashes, and exact trailers.
- Produces: immutable `SliceMergeEvidence`; the reconciler derives `OwnerEvidence` and the 33-row
  ledger without modifying the append-only merge record later.

- [ ] **Step 1: Execute the topological graph**

1. Merge I1, including the closed resolver and retained PostgreSQL image SSoT, then create and merge
   I1's slice reconciliation. Only then merge V0 and create and merge V0's slice reconciliation.
2. Merge the V0 finding-close implementation PR only after V0's slice reconciliation; then create
   and merge its closure reconciliation before V1 starts.
3. Merge/reconcile V1, then merge/reconcile V2 alone. Only after V2 reconciliation is
   protected-main-reachable, create separate fresh V3 and V4 coordinator worktrees from that exact
   then-main, capture both preflights there, execute them in parallel, and serialize their
   reconciliations.
4. After V3 and V4 reconciliations are both protected-main-reachable, merge/reconcile V5,
   merge/reconcile the product closure through Task 4, then merge UI convergence and its slice
   reconciliation. Only afterward merge the UI finding-close PR and its separate closure
   reconciliation. V2 is already implied by both gates and must remain main-reachable.
5. Merge all three F0 boundaries in pinned order, then reconcile F0 once. Repeat for all three F1a
   boundaries. Never substitute the last physical-contraction PR for the full tuple. F0/F1a may
   finish before I1 because they consume no fixture image, but they do not authorize F2 alone.
6. Create F2 only after both the F1a and I1 slice reconciliations are main-reachable; its preflight
   must validate the exact I1 resolver and manifest. Merge/reconcile F2 and F1b, create the
   coordinator-registered `feeding-foundation` auxiliary verification worktree, merge its protected
   evidence PR, and clean that exact worktree. Only then create the feeding finding-close branch and
   reconcile the foundation closure through Task 4. The verification PR reads but never writes the
   central ledger or any slice/closure record.
7. Merge/reconcile F3, F4, and F5 in order. Start V6 only after the UI closure reconciliation and F5
   reconciliation are on main; reconcile V6 and finally the VFD/V6 closure.
8. Reconcile the VFD/V6 closure after V6 and before closeout tooling starts.

- [ ] **Step 2: Verify each implementation PR before merge**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
[[ "$SLICE_ID" =~ ^(I1|V0|V1|V2|V3|V4|V5|UI-convergence|F0|F1a|F2|F1b|F3|F4|F5|V6)$ ]]
IMPLEMENTATION_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
cd "$IMPLEMENTATION_WORKTREE"
boundary_id="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --slice "$SLICE_ID" --print-next-boundary)"
test "$boundary_id" = "$BOUNDARY_ID"
implementation_pr_number="$(gh pr view --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$implementation_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$implementation_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision,baseRefName,headRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main")'
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-pr "$implementation_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --slice "$SLICE_ID" \
  --boundary "$boundary_id" \
  --verify-base-advance \
  --require-latest-merge-queue-candidate \
  --require-registry-trailers
```

The tool requires `boundary_id` to be exactly the next plan-pinned ID. Commit-preserving merges
retain each closing commit. Squash merges must put every exact trailer once in the reviewed squash
body. Missing or duplicate trailers block merge. Earlier boundaries of F0/F1a must already be
main-reachable before the next can pass. For I1 it also requires
`infrastructure/ci/image-digests.json` to contain only `schemaVersion` and the closed `images` map,
the PostgreSQL entry to reference exactly `.github/manifests/postgres-image.json#/image`, the other
five entries to be inline digest pins, and every consumer to invoke
`scripts/ci/resolve-ci-image.mjs --manifest infrastructure/ci/image-digests.json --image <closed-key>`.
Unit/invariant tests prove that the resolver validates the entire schema on every call, rejects
another manifest path, environment override, unknown key, cycle, escaping path, or other external
pointer, and prints exactly one resolved digest plus newline. Successful repository-bound runs are
mandatory; preflight absence is never accepted as terminal proof. F2 and every later slice
additionally require main-reachable I1 reconciliation evidence and the exact resolver/manifest
blobs; a planned-absence state or F1a-only predecessor set blocks review. It resolves the current PR
base/head and latest merge-queue candidate through GitHub, proves the preflight base is a main
ancestor, and hashes the canonical `baseMainCommit..reviewedBaseMainCommit` changed-path set. It
intersects that set with all exact `ownedPaths` plus authority paths from the preflight. A first
evaluation with overlap returns `resolution-required` and lists every path; it cannot attest the PR.
A zero-overlap run records `no-overlap`. For overlap, normally merge current protected main into the
branch, never rebase/force, and rerun this complete step only after the semantic diff, affected/full
slice gates, dependency audit, security gates, and a new review submitted after that merge are
green. The tool then validates the recorded normal merge's ordered parents, overlap inventory,
updated review API digest, and records `merged-main-and-rereviewed`; never rewrite the immutable
preflight. Either resolved state still passes only when every required workflow artifact names the
same latest candidate/base and hashes every checkout-local repository tool it executed.

- [ ] **Step 3: Capture the next post-merge record**

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
reconcile_slice="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-next-unreconciled \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$reconcile_slice" =~ ^(I1|V0|V1|V2|V3|V4|V5|UI-convergence|F0|F1a|F2|F1b|F3|F4|F5|V6)$ ]]
node tools/aquamobil-v4/worktree.mjs create-reconciliation \
  --slice "$reconcile_slice" \
  --main-ref origin/main
reconcile_slug="$(printf '%s' "$reconcile_slice" | tr '[:upper:]' '[:lower:]')"
reconcile_worktree="/var/aqua-saas/.worktrees/aquamobil-v4-reconcile-$reconcile_slug"
cd "$reconcile_worktree"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --capture-merged-slice "$reconcile_slice" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main \
  --write "docs/superpowers/evidence/aquamobil-v4/slices/$reconcile_slice/merge.json"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --slice "$reconcile_slice" \
  --main-ref origin/main \
  --write docs/superpowers/evidence/aquamobil-v4/execution-ledger.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
```

The capture calls `gh api` for every plan-pinned boundary's exact PR, workflow run/attempt, workflow
blob, and artifact. It rejects a missing, extra, duplicated, or reordered boundary; a final-only F0
or F1a attestation; foreign/stale/failed evidence; PR-head results; missing generated hashes; owner
reuse; or trailers absent from main. It writes each latest reviewed base, tested merge candidate,
and canonical base-advance digest, then requires the candidate tree to equal the resulting protected
main tree. An untested base advance or a post-test head change blocks reconciliation.

- [ ] **Step 4: Merge and clean the reconciliation worktree**

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
RECONCILE_SLICE="$(node tools/aquamobil-v4/worktree.mjs \
  print-active-reconciliation-slice)"
RECONCILE_WORKTREE="$(node tools/aquamobil-v4/worktree.mjs \
  print-active-reconciliation-path)"
[[ "$RECONCILE_SLICE" =~ ^(I1|V0|V1|V2|V3|V4|V5|UI-convergence|F0|F1a|F2|F1b|F3|F4|F5|V6)$ ]]
[[ "$RECONCILE_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-reconcile-* ]]
cd "$RECONCILE_WORKTREE"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
git add -- \
  "docs/superpowers/evidence/aquamobil-v4/slices/$RECONCILE_SLICE/merge.json" \
  docs/superpowers/evidence/aquamobil-v4/execution-ledger.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): reconcile $RECONCILE_SLICE protected merge" \
  -m "Bind the reviewed implementation to its protected-main commit, repository-owned runs, generated artifacts, and source-owner dispositions before dependent work starts."
git push --set-upstream origin HEAD
reconcile_pr_url="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --title "chore(aquamobil): reconcile $RECONCILE_SLICE protected merge" \
  --body "Serializes immutable protected-main evidence for $RECONCILE_SLICE and changes no product behavior.")"
reconcile_pr_number="$(gh pr view "$reconcile_pr_url" --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$reconcile_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$reconcile_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json reviewDecision --jq 'select(.reviewDecision == "APPROVED")'
RECONCILE_BRANCH="$(git branch --show-current)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$reconcile_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind slice-reconciliation \
  --expected-head "$RECONCILE_BRANCH" \
  --verify-base-advance \
  --require-latest-merge-queue-candidate
```

After the authorized merge:

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
RECONCILE_SLICE="$(node tools/aquamobil-v4/worktree.mjs \
  print-active-reconciliation-slice)"
RECONCILE_WORKTREE="$(node tools/aquamobil-v4/worktree.mjs \
  print-active-reconciliation-path)"
RECONCILE_BRANCH="$(git -C "$RECONCILE_WORKTREE" branch --show-current)"
mapfile -t reconcile_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform --state merged --base main \
  --head "$RECONCILE_BRANCH" --json number,title \
  --jq ".[] | select(.title == \"chore(aquamobil): reconcile $RECONCILE_SLICE protected merge\") | .number")
test "${#reconcile_pr_numbers[@]}" -eq 1
RECONCILE_PR_NUMBER="${reconcile_pr_numbers[0]}"
RECONCILE_MAIN_SHA="$(gh pr view "$RECONCILE_PR_NUMBER" --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$RECONCILE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$RECONCILE_MAIN_SHA" origin/main
cd "$COORDINATOR_WORKTREE"
test "$RECONCILE_WORKTREE" != "/var/aqua-saas"
[[ "$RECONCILE_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-reconcile-* ]]
test -z "$(git -C "$RECONCILE_WORKTREE" status --porcelain)"
git -C "$RECONCILE_WORKTREE" switch --detach origin/main
git -C /var/aqua-saas merge-base --is-ancestor \
  "$(git -C "$RECONCILE_WORKTREE" rev-parse HEAD)" origin/main
git -C /var/aqua-saas worktree remove "$RECONCILE_WORKTREE"
test ! -e "$RECONCILE_WORKTREE"
```

Expected: each complete slice boundary set is reconciled on protected main before dependent work;
parallel implementation never races on the central ledger and `merge.json` remains immutable.

---

### Task 4: Reconcile five append-only finding-closure records

**Files:**

- Create: `docs/superpowers/evidence/aquamobil-v4/closures/v0-high-findings.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/closures/ui-convergence-high-findings.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/closures/product-high-findings.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/closures/feeding-foundation-high-findings.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/closures/vfd-feeding-loop-high-findings.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/execution-ledger.json` only through
  `reconcile-ledger.mjs --write`

**Interfaces:**

- Consumes: the five reviewed detailed-plan finding-close PRs and their exact closure maps.
- Produces: five immutable `ClosureEvidence` files; only serialized reconciliation derives
  `OwnerEvidence.closingCommitsByFinding` and `closureEvidencePaths` in the central ledger.

- [ ] **Step 1: Keep finding-close implementation PRs outside central evidence**

At the start of each detailed finding-close task, assign its exact literal closure name from the
table above to `CLOSURE_NAME` in the same shell, then use only the bootstrap coordinator:

```bash
[[ "$CLOSURE_NAME" =~ ^(v0-high-findings|ui-convergence-high-findings|product-high-findings|feeding-foundation-high-findings|vfd-feeding-loop-high-findings)$ ]]
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node tools/aquamobil-v4/worktree.mjs create-finding-closure \
  --closure "$CLOSURE_NAME" \
  --main-ref origin/main
FINDING_CLOSURE_WORKTREE="$(node tools/aquamobil-v4/worktree.mjs \
  print-path --closure "$CLOSURE_NAME")"
FINDING_CLOSURE_BRANCH="$(node tools/aquamobil-v4/worktree.mjs \
  print-branch --closure "$CLOSURE_NAME")"
[[ "$FINDING_CLOSURE_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-* ]]
test "$(git -C "$FINDING_CLOSURE_WORKTREE" branch --show-current)" = \
  "$FINDING_CLOSURE_BRANCH"
cd "$FINDING_CLOSURE_WORKTREE"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
```

Creation rejects a missing owner reconciliation, a stale local main, an existing path/branch, or an
unconfigured closure. Detailed plans skip their raw `git switch --create`/`git worktree add` lines.

The detailed-plan finding-close branches may update their own closure map, finding registry/review,
and compliance artifacts. A required PR invariant rejects any change to
`docs/superpowers/evidence/aquamobil-v4/execution-ledger.json`, any slice `merge.json`, or any file
under `docs/superpowers/evidence/aquamobil-v4/closures/` on those branches.

Each detailed closure plan runs its applicable exact bootstrap-owned command, never reading a
removed `merge.json.closingCommitsByFinding` field:

```bash
[[ "$CLOSURE_NAME" =~ ^(v0-high-findings|ui-convergence-high-findings|product-high-findings|feeding-foundation-high-findings|vfd-feeding-loop-high-findings)$ ]]
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
FINDING_CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure "$CLOSURE_NAME")"
cd "$FINDING_CLOSURE_WORKTREE"
case "$CLOSURE_NAME" in
  v0-high-findings)
    CLOSURE_MAP_PATH=docs/evidence/aquamobil-v4-delivery/v0-finding-closure-map.json ;;
  ui-convergence-high-findings)
    CLOSURE_MAP_PATH=docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json ;;
  product-high-findings)
    CLOSURE_MAP_PATH=docs/evidence/aquamobil-v4-product/finding-closure-map.json ;;
  feeding-foundation-high-findings)
    CLOSURE_MAP_PATH=docs/evidence/aquamobil-v4-feeding/finding-closure-map.json ;;
  vfd-feeding-loop-high-findings)
    CLOSURE_MAP_PATH=docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json ;;
esac
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --capture-finding-closures "$CLOSURE_NAME" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main \
  --write "$CLOSURE_MAP_PATH"
```

The tool reads the pinned title/owner definitions, walks each owner's `implementationBoundaries`
PR/resulting-main attestations, resolves commit-preserved or squash-body `Closes:` trailers through
GitHub API and Git, and emits the exact finding-ID-to-main-commit map. Missing, extra, duplicate,
foreign, or non-ancestor trailer evidence fails closed. Only the later append-only `ClosureEvidence`
stores `closingCommitsByFinding`.

Before each protected merge:

```bash
[[ "$CLOSURE_NAME" =~ ^(v0-high-findings|ui-convergence-high-findings|product-high-findings|feeding-foundation-high-findings|vfd-feeding-loop-high-findings)$ ]]
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
FINDING_CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure "$CLOSURE_NAME")"
cd "$FINDING_CLOSURE_WORKTREE"
closure_pr_number="$(gh pr view --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$closure_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$closure_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision,baseRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main")'
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-closure-pr "$closure_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --verify-base-advance \
  --require-latest-merge-queue-candidate \
  --forbid-duplicate-closing-trailers
```

The capture verifies that the generated closure map already resolves every expected exact uppercase
trailer once from the implementation-boundary attestations. The registry-state PR must not repeat
those `Closes:` trailers or masquerade its own merge as the fixing commit.

After the authorized finding-close merge, reassign the same exact closure literal in the new shell
and let the coordinator prove the one configured merged PR, its resulting-main ancestry, exact clean
worktree, and safe detach/removal:

```bash
[[ "$CLOSURE_NAME" =~ ^(v0-high-findings|ui-convergence-high-findings|product-high-findings|feeding-foundation-high-findings|vfd-feeding-loop-high-findings)$ ]]
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
node tools/aquamobil-v4/worktree.mjs cleanup \
  --closure "$CLOSURE_NAME" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$(node tools/aquamobil-v4/worktree.mjs \
  print-path --closure "$CLOSURE_NAME")"
```

- [ ] **Step 2: Capture the next closure only after its protected merge**

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
closure_name="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-next-unreconciled-closure \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$closure_name" =~ ^(v0-high-findings|ui-convergence-high-findings|product-high-findings|feeding-foundation-high-findings|vfd-feeding-loop-high-findings)$ ]]
node tools/aquamobil-v4/worktree.mjs create-closure-reconciliation \
  --closure "$closure_name" \
  --main-ref origin/main
closure_worktree="/var/aqua-saas/.worktrees/aquamobil-v4-closure-$closure_name"
cd "$closure_worktree"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --capture-merged-closure "$closure_name" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main \
  --write "docs/superpowers/evidence/aquamobil-v4/closures/$closure_name.json"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --closure "$closure_name" \
  --main-ref origin/main \
  --write docs/superpowers/evidence/aquamobil-v4/execution-ledger.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
```

The reconciler compares exact ordered owner slices, closure-map path, live registry IDs resolved
from the pinned title set, existing ID inventory, total count, trailer SHAs, PR/run attestations,
and artifact hashes. It rejects missing/extra/duplicate finding IDs, a closing SHA not reachable
from main, a closure PR merge SHA substituted for an implementation closing SHA, or a second closure
for the same owner/finding.

- [ ] **Step 3: Merge and clean each serialized closure reconciliation**

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
CLOSURE_NAME="$(node tools/aquamobil-v4/worktree.mjs \
  print-active-closure-name)"
CLOSURE_WORKTREE="$(node tools/aquamobil-v4/worktree.mjs \
  print-active-closure-path)"
[[ "$CLOSURE_NAME" =~ ^(v0-high-findings|ui-convergence-high-findings|product-high-findings|feeding-foundation-high-findings|vfd-feeding-loop-high-findings)$ ]]
[[ "$CLOSURE_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-closure-* ]]
cd "$CLOSURE_WORKTREE"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
git add -- \
  "docs/superpowers/evidence/aquamobil-v4/closures/$CLOSURE_NAME.json" \
  docs/superpowers/evidence/aquamobil-v4/execution-ledger.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): reconcile $CLOSURE_NAME" \
  -m "Bind the reviewed finding-close train to its exact implementation trailers and protected-main evidence without modifying immutable slice records."
git push --set-upstream origin HEAD
closure_reconcile_pr_url="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --title "chore(aquamobil): reconcile $CLOSURE_NAME" \
  --body "Adds one immutable finding-closure record and deterministically regenerates the central ledger.")"
closure_reconcile_pr_number="$(gh pr view "$closure_reconcile_pr_url" --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$closure_reconcile_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$closure_reconcile_pr_number" --repo Okan-wqm/aquaculture_platform --json reviewDecision \
  --jq 'select(.reviewDecision == "APPROVED")'
CLOSURE_BRANCH="$(git branch --show-current)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$closure_reconcile_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind closure-reconciliation \
  --expected-head "$CLOSURE_BRANCH" \
  --verify-base-advance \
  --require-latest-merge-queue-candidate
```

After the authorized merge:

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
CLOSURE_NAME="$(node tools/aquamobil-v4/worktree.mjs \
  print-active-closure-name)"
CLOSURE_WORKTREE="$(node tools/aquamobil-v4/worktree.mjs \
  print-active-closure-path)"
CLOSURE_BRANCH="$(git -C "$CLOSURE_WORKTREE" branch --show-current)"
mapfile -t closure_pr_numbers < <(gh pr list --repo Okan-wqm/aquaculture_platform --state merged --base main \
  --head "$CLOSURE_BRANCH" --json number,title \
  --jq ".[] | select(.title == \"chore(aquamobil): reconcile $CLOSURE_NAME\") | .number")
test "${#closure_pr_numbers[@]}" -eq 1
CLOSURE_PR_NUMBER="${closure_pr_numbers[0]}"
CLOSURE_MAIN_SHA="$(gh pr view "$CLOSURE_PR_NUMBER" --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$CLOSURE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$CLOSURE_MAIN_SHA" origin/main
cd "$COORDINATOR_WORKTREE"
test "$CLOSURE_WORKTREE" != "/var/aqua-saas"
[[ "$CLOSURE_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-closure-* ]]
test -z "$(git -C "$CLOSURE_WORKTREE" status --porcelain)"
git -C "$CLOSURE_WORKTREE" switch --detach origin/main
git -C /var/aqua-saas merge-base --is-ancestor \
  "$(git -C "$CLOSURE_WORKTREE" rev-parse HEAD)" origin/main
git -C /var/aqua-saas worktree remove "$CLOSURE_WORKTREE"
test ! -e "$CLOSURE_WORKTREE"
```

- [ ] **Step 4: Verify exact closure inventories**

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
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
test "$(jq 'length' docs/evidence/aquamobil-v4-delivery/v0-finding-closure-map.json)" -eq 7
test "$(jq 'length' docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json)" -eq 1
test "$(jq 'length' docs/evidence/aquamobil-v4-product/finding-closure-map.json)" -eq 5
test "$(jq 'length' docs/evidence/aquamobil-v4-feeding/finding-closure-map.json)" -eq 15
test "$(jq 'length' docs/evidence/aquamobil-v4-vfd-feeding/finding-closure-map.json)" -eq 22
npm run findings:verify
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --require-closure-terminal \
  --verify-main-ancestors origin/main
```

Expected: all five closure records are immutable and main-reachable, and the central ledger is still
written only by the serialized reconciler.

---

### Task 5: Hand the terminal evidence to the sole closeout authority

**Files:**

- No final report file is created or modified by this program plan.

**Interfaces:**

- Consumes: 16 preflight files, 16 merge files, five closure files, the generated 33-row ledger, two
  planned merge records, and unchanged source anchor.
- Produces: a verified handoff. Only the closeout plan owns
  `docs/superpowers/evidence/aquamobil-v4/final-verification.md`.

- [ ] **Step 1: Verify implementation evidence on protected main**

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
cd "$COORDINATOR_WORKTREE"
test "$(git rev-parse origin/feature/aquamobil-v4-redesign)" = \
  "542c8e0bb7ff3afbeee0496f277f8926526cc41a"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --require-slice-terminal \
  --require-closure-terminal \
  --verify-main-ancestors origin/main
```

Expected: every approved owner has distinct terminal evidence and no PR/run/artifact attestation is
stale, foreign, duplicated, or unreachable.

- [ ] **Step 2: Execute the closeout plan without deleting provenance**

Follow `docs/superpowers/plans/2026-08-26-aquamobil-v4-closeout.md` through deterministic
exclusions/merge resolutions, protected tooling PR, exact tooling-main run, separate report PR,
exact report-main run, and signed ruleset-protected archive. This program creates no competing final
report.

- [ ] **Step 3: Require the terminal 35-object equation**

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

Expected: `35 total = 33 terminal non-merge dispositions + 2 excluded-verified merge resolutions`,
with zero missing, duplicate, unknown, planned, or partially verified object.

- [ ] **Step 4: Ask for destructive approval only after the protected archive**

Present the final report, exact report-main run, protected archive ref/ruleset proof, source SHA,
PR/worktree assertions, and destructive targets. Deletion stays blocked until the user names
`feature/aquamobil-v4-redesign` and PR `#1107` affirmatively. If archive protection, state
assertions, or fresh-clone recoverability fails, retain the source branch.
