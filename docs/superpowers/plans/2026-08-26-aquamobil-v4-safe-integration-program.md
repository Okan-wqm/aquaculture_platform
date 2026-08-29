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

- `designMainCommit=4002868c535a2d8676aad6eadd5f4bbd57d4625b` is the immutable design-review
  snapshot. `order0BaseMainCommit` is generated only after PR #1333 merges from the exact fetched
  `origin/main` used to create Order 0; it must descend from both `designMainCommit` and the observed
  #1333 resulting-main commit. The other immutable provenance anchors are
  `sourceCommit=542c8e0bb7ff3afbeee0496f277f8926526cc41a` and
  `mergeBase=8d8d54365ada11d45b43374af76e9814c5958ff0`; design-time divergence is 219
  behind and 35 ahead.
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
  authority paths. Zero overlap may proceed only when all four manifest-pinned required contexts
  succeed for the current ordinary GitHub PR test-merge candidate and their three distinct
  artifacts agree only on canonical `N/B/H/C/T/[B,H]` and its derived
  `canonicalLineageSha256`. Each artifact remains bound to its own distinct
  `(runId, runAttempt, producerCheckRunId, workflowRepository/path/ref/sha/blob, toolBlob)` tuple.
  Any overlap stops the PR: never rebase or force-push; normally merge current protected main into
  the implementation branch, independently review the semantic diff, rerun affected plus full
  slice/audit/security gates, and obtain a new exact-lineage program-local review and operator
  authorization. A later violation of an already reconciled slice never mutates its evidence; it
  requires a program/schema revision and new plan-pinned remediation boundary before dependents
  resume.
- That merge-time stale-base decision applies to every protected program PR, not only product-code
  boundaries. Delivery implementation PRs bind to Task 3 Step 2's exact
  `--verify-prospective-pr --verify-base-advance --require-current-pr-test-merge-candidate`
  protocol.
  Slice reconciliation, feeding auxiliary verification, closure reconciliation,
  closeout-terminal-evidence, and all later closeout PRs use Order 0's generic
  `--verify-prospective-program-pr` mode with those same two required flags. A finding-close entry
  point is a strict alias over that same prospective/spool/postmerge verifier with
  `PROGRAM_PR_KIND=finding-close`; it is not a separate or weaker closure mode. Order 0 itself has
  the only narrowly
  tested `--bootstrap-order0-pr` self-binding exception because the tool does not yet exist on
  protected main. A check result for a PR head, a prior test-merge candidate, or a base that advanced
  after review never authorizes merge.
- GitHub branch protection does not require and this solo-maintainer repository cannot obtain a
  non-author GitHub `APPROVED` review. Every program PR instead has a separate program-local gate:
  an independent agent writes a canonical report bound to the exact current `N/B/H/C/T/[B,H]` and
  check/artifact set. The administrator posts a structured authorization comment whose canonical
  payload contains that full report, report SHA-256, lineage, and check/artifact-set SHA-256. Historical
  marker comments remain append-only; exactly one well-formed authorization payload may match the
  complete current identity, while zero, multiple current matches, or a malformed current collision
  fails. A rerun, changed check ID, or changed run attempt changes the set digest and requires a new
  report/comment. Prospective and post-merge bundles are durably stored beneath the symlink-safe,
  atomic Git common-dir spool `.git/aquamobil-v4-program-evidence/v1/pr-<N>/`, and the tool re-reads
  and canonicalizes the remote comment rather than reconstructing a report from its digest. After
  merge, reconciliation proves stored `T == resultingMain^{tree}`, writes the full post-merge record
  to the spool, posts and verifies a full canonical recovery payload on GitHub, and only then permits
  worktree cleanup. This gate is never represented as branch-protection review state.
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
- Feeding Task 17's post-merge verification PR is a feeding auxiliary evidence branch, not a seventeenth
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
closeout tooling PR -> exact tooling-main run -> closeout-terminal-evidence PR -> exact report-base-main run
                                                                                             |
report PR -> exact report-main run -> protected provenance archive -> explicit remote-action approval
                                                                                             |
closeout-receipt finalizer PR on both action and no-action paths
```

| Plan                    | Owned slices                                                                         | File                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Delivery and appearance | I1, V0, PWA handshake, V0/UI finding-close gates, UI convergence                     | `docs/superpowers/plans/2026-08-26-aquamobil-v4-delivery-appearance.md` |
| Product surfaces        | V1, V2, V3, V4, V5, product finding-close gate                                       | `docs/superpowers/plans/2026-08-26-aquamobil-v4-product-surfaces.md`    |
| Feeding foundation      | F0, F1a, F2, F1b, auxiliary verification, foundation finding-close gate              | `docs/superpowers/plans/2026-08-26-aquamobil-v4-feeding-foundation.md`  |
| VFD and loop            | F3, F4, F5, V6, VFD/V6 finding-close gate                                            | `docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md`    |
| Closeout                | 35-object verification, exact-main runs, report, protected archive, terminal receipt | `docs/superpowers/plans/2026-08-26-aquamobil-v4-closeout.md`            |

## Branches and Topological Gates

Ranks are dependency levels, not a single serial queue.

| Rank | Branch                                                   | Protected-main gate to start                                                         |
| ---: | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
|    0 | `chore/aquamobil-v4-program-bootstrap`                   | immutable refs fetched                                                               |
|   1a | `fix/aquamobil-i1-asset-boundary`                        | Order 0 merged                                                                       |
|   1b | `feat/feeding-f0-weighing-authority`                     | Order 0 merged                                                                       |
|   2a | `feat/aquamobil-v0-appearance-foundation`                | I1 implementation and reconciliation merged                                          |
|   2b | `feat/feeding-f1a-compatibility-and-feeder-model-expand` | F0 implementation and reconciliation merged                                          |
|   3a | `chore/aquamobil-v0-findings-close`                      | V0 implementation and reconciliation merged                                          |
|   3b | `feat/feeding-f2-event-language`                         | F1a and I1 slice reconciliations merged                                              |
|   4a | `feat/aquamobil-v1-shell`                                | V0 finding-close PR and reconciliation merged                                        |
|   4b | `feat/feeding-f1b-assignment-api`                        | F2 reconciliation merged                                                             |
|   5a | `feat/aquamobil-v2-field-workflows`                      | V1 reconciliation; generated input prerequisite green                                |
|   5b | `chore/aquamobil-v4-feeding-foundation-verification`     | F0, F1a, F2, and F1b reconciliations merged                                          |
|   5c | `chore/aquamobil-v4-feeding-findings-close`              | feeding foundation verification PR merged and retained pending reconciliation        |
|   6a | `feat/aquamobil-v3-messaging-surfaces`                   | V2 reconciliation merged; TankCard authority settled                                 |
|   6b | `feat/aquamobil-v4-report-surfaces`                      | V2 reconciliation merged; generated farm-summary and queued-mutation inputs green    |
|   6c | `feat/feeding-f3-vfd-attestation`                        | feeding finding-close PR and closure reconciliation merged                           |
|   7a | `feat/aquamobil-v5-tablet-board`                         | V3/V4 reconciliations merged; V2 remains main-reachable transitively                 |
|   7b | `feat/feeding-f4-calibration-physics`                    | F3 reconciliation merged                                                             |
|   8a | `chore/aquamobil-v4-product-findings-close`              | V1 through V5 reconciliations merged                                                 |
|   8b | `feat/feeding-f5-loop-completion`                        | F4 reconciliation merged                                                             |
|    9 | `feat/aquamobil-v4-ui-convergence`                       | product finding-close PR and closure reconciliation merged; generation matrix green  |
|   10 | `chore/aquamobil-v4-ui-convergence-finding-close`        | UI implementation and reconciliation merged                                          |
|   11 | `feat/aquamobil-v6-vfd-operations`                       | UI finding-close reconciliation and F5 reconciliation merged                         |
|   12 | `chore/aquamobil-v4-vfd-findings-close`                  | F3 through F5 and V6 reconciliations merged                                          |
|   13 | `chore/aquamobil-v4-integration-closeout`                | all 16 slice and all five closure reconciliations merged                             |
|   14 | `chore/aquamobil-v4-terminal-evidence`                   | closeout tooling merged; terminal evidence generated by merged coordinator           |
|   15 | `chore/aquamobil-v4-semantic-supersession`               | terminal evidence merged; exact report-base-main run captured                        |
|   16 | `chore/aquamobil-v4-provenance-archive`                  | report merged; exact report-main run captured                                        |
|   17 | `chore/aquamobil-v4-closeout-receipt`                    | archive merged; explicit action/no-action disposition and fresh-clone audit complete |

V3 and V4 are the only parallel frontend implementation slices. V2 first resolves the shared
`TankCard.tsx` authority and is reconciled. V3 and V4 then start in separate fresh coordinator
worktrees from that exact protected-main state, so both immutable preflight `baseMainCommit` values
contain the V2 component and generated-input authorities they consume. F0 and F1a may run beside I1
because neither consumes a CI fixture image. F2 is the feeding join: its worktree cannot be created
until both F1a and I1 slice reconciliations are protected-main-reachable. From F2 through F5 the
feeding chain remains sequential internally. Feeding Task 17 starts its auxiliary verification
branch only after F1b reconciliation, merges that evidence through a protected PR, and retains its
canonical worktree through the separate feeding finding-close branch. The following closure
reconciliation carries its full generic record before cleanup. That auxiliary branch
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
- Create: `tools/aquamobil-v4/contracts.mjs`
- Create: `tools/aquamobil-v4/contracts.spec.mjs`
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
- Create: `scripts/ci/capture-aquamobil-v4-audit-inputs.mjs`
- Create: `scripts/ci/capture-aquamobil-v4-audit-inputs.spec.mjs`
- Create: `web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts`
- Modify: `web/apps/aquamobil/vite.config.ts`
- Create: `tests/invariants/aquamobil-audit-module-manifest.spec.ts`
- Modify: `scripts/ci/audit-source-map.mjs`
- Create: `scripts/ci/audit-source-map.spec.mjs`
- Modify: `.github/workflows/ci-affected.yml`
- Modify: `.github/workflows/ci-full.yml`
- Modify: `.github/workflows/aria-merge-authority.yml`
- Modify: `docs/aria/CURRENT_STATE.md` through `npm run aria:authority-hash:write`
- Modify: `.github/manifests/main-required-status-checks.json`
- Create: `tests/invariants/aquamobil-v4-required-workflow-evidence.spec.ts`
- Modify: `package.json`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: immutable source Git objects and repository `Okan-wqm/aquaculture_platform`.
- Produces: the only closed source-history/evidence schemas, GitHub capture, exact dependency
  mapper, real-production bundle manifest, worktree coordinator, deterministic reconciler, and
  checkout-local `aquamobil:v4:ci:provenance:check` command. Local post-bootstrap coordination has
  no relative package-script entry point.

- [ ] **Step 0: Prove planning PR #1333 and all seven planning blobs are on fetched main**

Run this gate before creating a branch or worktree. It resolves #1333's head and result dynamically;
no version of this plan hard-codes its own reviewed head:

```bash
set -euo pipefail
repo_root=/var/aqua-saas
design_main=4002868c535a2d8676aad6eadd5f4bbd57d4625b
planning_pr=1333
planning_gate_dir="$(mktemp -d)"
PLANNING_PRIVATE_REF=refs/aquamobil-v4/private/planning-pr-1333-head
test "$PLANNING_PRIVATE_REF" != refs/heads/feature/aquamobil-v4-redesign
test "$PLANNING_PRIVATE_REF" != refs/remotes/origin/feature/aquamobil-v4-redesign
! git -C "$repo_root" show-ref --verify --quiet "$PLANNING_PRIVATE_REF"
git -C "$repo_root" fetch origin \
  +refs/heads/main:refs/remotes/origin/main \
  +refs/heads/feature/aquamobil-v4-redesign:refs/remotes/origin/feature/aquamobil-v4-redesign
gh api "/repos/Okan-wqm/aquaculture_platform/pulls/$planning_pr" \
  > "$planning_gate_dir/planning-pr.json"
jq -e '
  .number == 1333 and .state == "closed" and .merged == true and
  .base.ref == "main" and .head.ref == "feat/aquamobil-v4-safe-integration" and
  .head.repo.full_name == "Okan-wqm/aquaculture_platform" and .merged_at != null
' "$planning_gate_dir/planning-pr.json"
PLANNING_HEAD_COMMIT="$(jq -er '.head.sha | select(test("^[0-9a-f]{40}$"))' \
  "$planning_gate_dir/planning-pr.json")"
PLANNING_MAIN_COMMIT="$(jq -er '.merge_commit_sha | select(test("^[0-9a-f]{40}$"))' \
  "$planning_gate_dir/planning-pr.json")"
PLANNING_API_SHA256="$(jq -Sc '{
  number,
  state,
  merged,
  merged_at,
  merge_commit_sha,
  base: { ref: .base.ref, sha: .base.sha },
  head: { ref: .head.ref, sha: .head.sha, repository: .head.repo.full_name }
}' "$planning_gate_dir/planning-pr.json" | sha256sum | cut -d' ' -f1)"
[[ "$PLANNING_API_SHA256" =~ ^[0-9a-f]{64}$ ]]
git -C "$repo_root" fetch origin \
  "+refs/pull/$planning_pr/head:$PLANNING_PRIVATE_REF"
test "$(git -C "$repo_root" rev-parse "$PLANNING_PRIVATE_REF")" = \
  "$PLANNING_HEAD_COMMIT"
git -C "$repo_root" cat-file -e "$PLANNING_HEAD_COMMIT^{commit}"
git -C "$repo_root" cat-file -e "$PLANNING_MAIN_COMMIT^{commit}"
git -C "$repo_root" merge-base --is-ancestor "$design_main" "$PLANNING_MAIN_COMMIT"
git -C "$repo_root" merge-base --is-ancestor "$PLANNING_MAIN_COMMIT" origin/main
while IFS= read -r planning_path; do
  git -C "$repo_root" cat-file -e "$PLANNING_MAIN_COMMIT:$planning_path"
  test "$(git -C "$repo_root" rev-parse "$PLANNING_MAIN_COMMIT:$planning_path")" = \
    "$(git -C "$repo_root" rev-parse "origin/main:$planning_path")"
done <<'PLANNING_PATHS'
docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md
docs/superpowers/plans/2026-08-26-aquamobil-v4-safe-integration-program.md
docs/superpowers/plans/2026-08-26-aquamobil-v4-delivery-appearance.md
docs/superpowers/plans/2026-08-26-aquamobil-v4-product-surfaces.md
docs/superpowers/plans/2026-08-26-aquamobil-v4-feeding-foundation.md
docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md
docs/superpowers/plans/2026-08-26-aquamobil-v4-closeout.md
PLANNING_PATHS
git -C "$repo_root" update-ref -d "$PLANNING_PRIVATE_REF" "$PLANNING_HEAD_COMMIT"
! git -C "$repo_root" show-ref --verify --quiet "$PLANNING_PRIVATE_REF"
printf 'planning-head=%s planning-main=%s planning-api-sha256=%s\n' \
  "$PLANNING_HEAD_COMMIT" "$PLANNING_MAIN_COMMIT" "$PLANNING_API_SHA256"
```

Expected: #1333 is merged, its API head was fetched explicitly through the exact private ref and
matched byte-for-byte even if the source branch was deleted or the PR was squash-merged, both
dynamically resolved commits are valid Git objects, its result is a fetched-main ancestor, and every
named plan/spec blob at `origin/main` is exactly the blob from that result. The private ref must be
absent before use and is deleted with an old-value guard after dereference; a crash-left ref blocks
the next run until its exact identity is audited and removed, and it can never be confused with the
immutable source/provenance namespaces. Fixtures include a branch-deleted, head-not-main-reachable
squash merge. A later edit to any of the seven files requires a newly reviewed planning boundary;
Order 0 does not silently read a different plan.

- [ ] **Step 1: Attest the source ref, freeze the Order 0 base, and create the worktree**

```bash
set -euo pipefail
repo_root=/var/aqua-saas
program_worktree="$repo_root/.worktrees/aquamobil-v4-coordinator"
design_main=4002868c535a2d8676aad6eadd5f4bbd57d4625b
source_sha=542c8e0bb7ff3afbeee0496f277f8926526cc41a
merge_base=8d8d54365ada11d45b43374af76e9814c5958ff0
source_gate_dir="$(mktemp -d)"
test "$repo_root" = "/var/aqua-saas"
test ! -e "$program_worktree"
! git -C "$repo_root" show-ref --verify --quiet \
  refs/heads/chore/aquamobil-v4-program-bootstrap
git -C "$repo_root" fetch origin \
  +refs/heads/main:refs/remotes/origin/main \
  +refs/heads/feature/aquamobil-v4-redesign:refs/remotes/origin/feature/aquamobil-v4-redesign
PLANNING_MAIN_COMMIT="$(gh api /repos/Okan-wqm/aquaculture_platform/pulls/1333 \
  --jq '.merge_commit_sha')"
[[ "$PLANNING_MAIN_COMMIT" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo_root" rev-parse origin/feature/aquamobil-v4-redesign)" = "$source_sha"
test "$(git -C "$repo_root" ls-remote origin \
  refs/heads/feature/aquamobil-v4-redesign | awk '{print $1}')" = "$source_sha"
gh api /repos/Okan-wqm/aquaculture_platform/pulls/1107 > "$source_gate_dir/source-pr.json"
jq -e --arg source "$source_sha" '
  .number == 1107 and .state == "open" and .merged == false and
  .base.ref == "main" and .head.ref == "feature/aquamobil-v4-redesign" and
  .head.repo.full_name == "Okan-wqm/aquaculture_platform" and .head.sha == $source
' "$source_gate_dir/source-pr.json"
SOURCE_PR_API_SHA256="$(jq -Sc '{
  number,
  state,
  merged,
  base: { ref: .base.ref },
  head: { ref: .head.ref, sha: .head.sha, repository: .head.repo.full_name }
}' "$source_gate_dir/source-pr.json" | sha256sum | cut -d' ' -f1)"
[[ "$SOURCE_PR_API_SHA256" =~ ^[0-9a-f]{64}$ ]]
test "$(git -C "$repo_root" merge-base "$design_main" "$source_sha")" = "$merge_base"
ORDER0_BASE_MAIN_COMMIT="$(git -C "$repo_root" rev-parse origin/main)"
[[ "$ORDER0_BASE_MAIN_COMMIT" =~ ^[0-9a-f]{40}$ ]]
git -C "$repo_root" merge-base --is-ancestor "$design_main" "$ORDER0_BASE_MAIN_COMMIT"
git -C "$repo_root" merge-base --is-ancestor \
  "$PLANNING_MAIN_COMMIT" "$ORDER0_BASE_MAIN_COMMIT"
git -C "$repo_root" worktree add "$program_worktree" \
  -b chore/aquamobil-v4-program-bootstrap "$ORDER0_BASE_MAIN_COMMIT"
cd "$program_worktree"
test "$(git rev-parse HEAD)" = "$ORDER0_BASE_MAIN_COMMIT"
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

Expected: the remote-tracking source ref, live remote source ref, and PR #1107 all name the pinned
source SHA; the design/source merge base is exact; and all following Order 0 commands run in
`/var/aqua-saas/.worktrees/aquamobil-v4-coordinator` at the generated protected-main base descending
from both the design snapshot and #1333.

- [ ] **Step 2: Define the closed schemas with a focused RED/GREEN bite**

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
type FullSha = string & { readonly __fullSha: unique symbol }; // runtime: ^[0-9a-f]{40}$
type Sha256Hex = string & { readonly __sha256: unique symbol }; // runtime: ^[0-9a-f]{64}$
type ArtifactDigest = `sha256:${string}`; // runtime: ^sha256:[0-9a-f]{64}$
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

interface GitBlobAttestation {
  readonly path: string;
  readonly blobSha: FullSha;
}

interface CoordinationToolAttestation {
  readonly coordinatorMainCommit: FullSha;
  readonly coordinatorMainTree: FullSha;
  readonly executable: GitBlobAttestation;
  readonly importedModules: readonly [
    {
      readonly path: 'tools/aquamobil-v4/contracts.mjs';
      readonly blobSha: FullSha;
    },
  ];
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
  readonly apiResponseSha256: Sha256Hex;
}

interface PullRequestCandidateArtifactV1 {
  readonly schemaVersion: 1;
  readonly kind: 'aquamobil-v4-pull-request-test-merge';
  readonly repository: Repository;
  readonly pullRequestNumber: number;
  readonly event: 'pull_request';
  readonly eventRef: `refs/pull/${number}/merge`;
  readonly base: { readonly ref: 'main'; readonly sha: FullSha };
  readonly head: { readonly ref: string; readonly sha: FullSha };
  readonly candidate: {
    readonly sha: FullSha;
    readonly tree: FullSha;
    readonly orderedParents: readonly [FullSha, FullSha];
  };
  readonly checkoutSha: FullSha;
  readonly workflowRunId: number;
  readonly runAttempt: number;
  readonly canonicalLineageSha256: Sha256Hex;
  readonly job: {
    readonly id: 'merge-gate' | 'build-status' | 'aria-merge-authority';
    readonly check_run_id: number;
    readonly workflow_file_path:
      | '.github/workflows/ci-affected.yml'
      | '.github/workflows/ci-full.yml'
      | '.github/workflows/aria-merge-authority.yml';
    readonly workflow_ref: string;
    readonly workflow_sha: FullSha;
    readonly workflow_repository: Repository;
    readonly blob_sha: FullSha;
  };
  readonly coordinationTools: readonly [
    {
      readonly path: 'tools/aquamobil-v4/capture-github-evidence.mjs';
      readonly blobSha: FullSha;
    },
  ];
}

interface GitHubRequiredCheckAttestation {
  readonly context: string;
  readonly appId: 15368;
  readonly checkRunId: number;
  readonly conclusion: 'success';
  readonly apiHeadSha: FullSha;
  readonly workflowRunId: number;
  readonly runAttempt: number;
  readonly producerJobId: 'merge-gate' | 'build-status' | 'aria-merge-authority';
  readonly producerCheckRunId: number;
  readonly apiResponseSha256: Sha256Hex;
}

interface GitHubPullRequestWorkflowRunAttestation {
  readonly kind: 'github-pull-request-test-merge-workflow-run';
  readonly repository: Repository;
  readonly workflowPath: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly producerJobId: 'merge-gate' | 'build-status' | 'aria-merge-authority';
  readonly producerCheckRunId: number;
  readonly url: string;
  readonly event: 'pull_request';
  readonly conclusion: 'success';
  readonly apiHeadSha: FullSha;
  readonly checkedOutCandidateSha: FullSha;
  readonly checkedOutCandidateTree: FullSha;
  readonly workflowBlobSha: FullSha;
  readonly workflowRepository: Repository;
  readonly workflowRef: string;
  readonly workflowSha: FullSha;
  readonly artifact: {
    readonly id: number;
    readonly name: `aquamobil-v4-pr-candidate-${number}-${number}`;
    readonly digest: ArtifactDigest;
    readonly payloadSha256: Sha256Hex;
    readonly payload: PullRequestCandidateArtifactV1;
  };
  readonly apiResponseSha256: Sha256Hex;
}

interface GitHubNonPullRequestWorkflowRunAttestation {
  readonly kind: 'github-non-pull-request-workflow-run';
  readonly repository: Repository;
  readonly workflowPath: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly url: string;
  readonly event: 'push' | 'workflow_dispatch' | 'workflow_call';
  readonly conclusion: 'success';
  readonly apiHeadSha: FullSha;
  readonly workflowBlobSha: FullSha;
  readonly apiResponseSha256: Sha256Hex;
}

type ExhaustiveGitHubListKind =
  | 'check-runs'
  | 'workflow-runs'
  | 'workflow-jobs'
  | 'run-artifacts'
  | 'pull-request-comments'
  | 'pull-requests'
  | 'repository-rulesets'
  | 'matching-tag-refs';

interface ExhaustiveGitHubListAttestation {
  readonly kind: ExhaustiveGitHubListKind;
  readonly requestPath: string;
  readonly pageCount: number;
  readonly itemCount: number;
  readonly endpointTotalCount: number | null;
  readonly linkTraversalSha256: Sha256Hex;
  readonly canonicalCompleteSetSha256: Sha256Hex;
}

interface CloseoutFinalizerObservationBase {
  readonly kind: 'aquamobil-v4-closeout-finalizer-observation';
  readonly liveReferencesBlobSha: FullSha;
  readonly liveReferencesSha256: Sha256Hex;
  readonly observedAt: string;
  readonly sourceRefApiSha256: Sha256Hex;
  readonly sourcePullRequestApiSha256: Sha256Hex;
  readonly pullRequestList: ExhaustiveGitHubListAttestation & {
    readonly kind: 'pull-requests';
  };
}

type CloseoutFinalizerObservationBinding =
  | (CloseoutFinalizerObservationBase & {
      readonly disposition: 'no-action';
      readonly liveReferencesPath: 'docs/superpowers/evidence/aquamobil-v4/live-references.json';
      readonly sourceRef: {
        readonly state: 'PRESENT';
        readonly ref: 'refs/heads/feature/aquamobil-v4-redesign';
        readonly commit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
      };
      readonly sourcePullRequest: {
        readonly number: 1107;
        readonly state: 'OPEN';
        readonly isDraft: false;
        readonly headRefName: 'feature/aquamobil-v4-redesign';
        readonly headRefOid: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
        readonly baseRefName: 'main';
      };
    })
  | (CloseoutFinalizerObservationBase & {
      readonly disposition: 'source-actions';
      readonly liveReferencesPath: 'docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json';
      readonly sourceRef:
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
      readonly sourcePullRequest: {
        readonly number: 1107;
        readonly state: 'OPEN' | 'CLOSED';
        readonly isDraft: false;
        readonly headRefName: 'feature/aquamobil-v4-redesign';
        readonly headRefOid: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
        readonly baseRefName: 'main';
      };
    });

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
  readonly proofSha256: Sha256Hex;
}

type BundleSource =
  | {
      readonly kind: 'committed';
      readonly commit: FullSha;
      readonly tree: FullSha;
    }
  | {
      readonly kind: 'bootstrap-index';
      readonly commit: null;
      readonly baseCommit: FullSha;
      readonly tree: FullSha;
    };

interface AquaMobilBundleModuleManifest {
  readonly schemaVersion: 1;
  readonly kind: 'aquamobil-vite-rollup-module-manifest';
  readonly mode: 'production';
  readonly repository: Repository;
  readonly source: BundleSource;
  readonly generator: {
    readonly config: {
      readonly path: 'web/apps/aquamobil/vite.config.ts';
      readonly blobSha: FullSha;
    };
    readonly plugin: {
      readonly path: 'web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts';
      readonly blobSha: FullSha;
    };
    readonly standaloneLock: {
      readonly path: 'web/apps/aquamobil/package-lock.json';
      readonly blobSha: FullSha;
    };
  };
  readonly chunks: readonly {
    readonly fileName: string;
    readonly isEntry: boolean;
    readonly isDynamicEntry: boolean;
    readonly modules: readonly string[];
  }[];
}

interface BundleGeneratorAttestation {
  readonly manifestPath: string;
  readonly contentSha256: Sha256Hex;
  readonly sourceCommit: FullSha;
  readonly sourceTree: FullSha;
  readonly configBlobSha: FullSha;
  readonly pluginBlobSha: FullSha;
  readonly standaloneLockBlobSha: FullSha;
  readonly captureTool: GitBlobAttestation;
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
  readonly bundleGenerator: BundleGeneratorAttestation;
  readonly auditInputCaptureTool: CoordinationToolAttestation;
  readonly auditMapperTool: CoordinationToolAttestation;
  readonly captureTool: CoordinationToolAttestation;
  readonly rejectedSourceAssumptions: readonly string[];
}

interface GeneratedArtifactEvidence {
  readonly path: string;
  readonly generator: string;
  readonly checkCommand: string;
  readonly resultingCommit: FullSha;
  readonly contentSha256: Sha256Hex;
}

interface BaseAdvanceEvidence {
  readonly preflightBaseMainCommit: FullSha;
  readonly changedPathsSha256: Sha256Hex;
  readonly overlappingPaths: readonly string[];
  readonly resolution: 'no-overlap' | 'merged-main-and-reauthorized';
  readonly mainMergeCommit: FullSha | null;
  readonly mainMergeParents: readonly [FullSha, FullSha] | null;
  readonly mainMergeTree: FullSha | null;
  readonly mainMergeApiResponseSha256: Sha256Hex | null;
}

interface ProgramIndependentReviewInputBase {
  readonly schemaVersion: 1;
  readonly kind: 'aquamobil-v4-independent-agent-review-input';
  readonly repository: Repository;
  readonly pullRequestNumber: number;
  readonly baseCommit: FullSha;
  readonly headCommit: FullSha;
  readonly candidateCommit: FullSha;
  readonly candidateTree: FullSha;
  readonly candidateParents: readonly [FullSha, FullSha];
  readonly requiredChecks: RequiredProgramChecks;
  readonly workflowRuns: RequiredProgramWorkflowRuns;
  readonly checkArtifactSetSha256: Sha256Hex;
  readonly closeoutFinalizerObservation: CloseoutFinalizerObservationBinding | null;
}

type ProgramIndependentReviewInput =
  | (ProgramIndependentReviewInputBase & {
      readonly prKind: 'bootstrap';
      readonly previousGenericProgramPr: null;
    })
  | (ProgramIndependentReviewInputBase & {
      readonly prKind: NonBootstrapProgramPrKind;
      readonly previousGenericProgramPr: PriorGenericProgramPrReference;
    })
  | (ProgramIndependentReviewInputBase & {
      readonly prKind: ProtectedBoundaryKind;
      readonly previousGenericProgramPr?: never;
    });

interface ProgramIndependentReviewReport {
  readonly schemaVersion: 1;
  readonly kind: 'aquamobil-v4-independent-agent-review';
  readonly prKind: ProtectedPrKind;
  readonly repository: Repository;
  readonly pullRequestNumber: number;
  readonly baseCommit: FullSha;
  readonly headCommit: FullSha;
  readonly candidateCommit: FullSha;
  readonly candidateTree: FullSha;
  readonly candidateParents: readonly [FullSha, FullSha];
  readonly checkArtifactSetSha256: Sha256Hex;
  readonly closeoutFinalizerObservation: CloseoutFinalizerObservationBinding | null;
  readonly reviewer: {
    readonly kind: 'independent-agent';
    readonly identity: string;
  };
  readonly verdict: 'approved';
  readonly reviewedPaths: readonly string[];
  readonly findings: readonly [];
}

interface ProgramAuthorizationPayloadBase {
  readonly schemaVersion: 1;
  readonly marker: 'aquamobil-v4-program-authorization:v1';
  readonly operatorDecision: 'authorize-current-program-candidate';
  readonly repository: Repository;
  readonly pullRequestNumber: number;
  readonly baseCommit: FullSha;
  readonly headCommit: FullSha;
  readonly candidateCommit: FullSha;
  readonly candidateTree: FullSha;
  readonly candidateParents: readonly [FullSha, FullSha];
  readonly canonicalReport: ProgramIndependentReviewReport;
  readonly reportSha256: Sha256Hex;
  readonly requiredChecks: RequiredProgramChecks;
  readonly workflowRuns: RequiredProgramWorkflowRuns;
  readonly checkArtifactSetSha256: Sha256Hex;
  readonly baseAdvance: BaseAdvanceEvidence;
  readonly pullRequestApiSha256: Sha256Hex;
  readonly captureTool: CoordinationToolAttestation;
  readonly closeoutFinalizerObservation: CloseoutFinalizerObservationBinding | null;
}

type ProgramAuthorizationPayload =
  | (ProgramAuthorizationPayloadBase & {
      readonly prKind: 'bootstrap';
      readonly previousGenericProgramPr: null;
    })
  | (ProgramAuthorizationPayloadBase & {
      readonly prKind: NonBootstrapProgramPrKind;
      readonly previousGenericProgramPr: PriorGenericProgramPrReference;
    })
  | (ProgramAuthorizationPayloadBase & {
      readonly prKind: ProtectedBoundaryKind;
      readonly previousGenericProgramPr?: never;
    });

interface ProgramAuthorizationCommentAttestation {
  readonly author: 'Okan-wqm';
  readonly authorPermission: 'admin';
  readonly commentId: number;
  readonly commentUrl: string;
  readonly payloadSha256: Sha256Hex;
  readonly envelopeBodySha256: Sha256Hex;
  readonly apiResponseSha256: Sha256Hex;
  readonly collaboratorPermissionApiSha256: Sha256Hex;
}

interface ProgramLocalReviewEvidence {
  readonly kind: 'aquamobil-v4-program-local-review';
  readonly payload: ProgramAuthorizationPayload;
  readonly authorizationComment: ProgramAuthorizationCommentAttestation;
}

type RequiredProgramChecks = readonly [
  GitHubRequiredCheckAttestation & { readonly context: 'merge-gate' },
  GitHubRequiredCheckAttestation & { readonly context: 'sens-enterprise-summary' },
  GitHubRequiredCheckAttestation & { readonly context: 'build-status' },
  GitHubRequiredCheckAttestation & { readonly context: 'aria-merge-authority' },
];

type RequiredProgramWorkflowRuns = readonly [
  GitHubPullRequestWorkflowRunAttestation & { readonly producerJobId: 'merge-gate' },
  GitHubPullRequestWorkflowRunAttestation & { readonly producerJobId: 'build-status' },
  GitHubPullRequestWorkflowRunAttestation & {
    readonly producerJobId: 'aria-merge-authority';
  },
];

interface ProtectedProgramBoundaryEvidence {
  readonly pullRequest: GitHubPullRequestAttestation;
  readonly reviewedBaseMainCommit: FullSha;
  readonly reviewedHeadCommit: FullSha;
  readonly testedMergeCandidateCommit: FullSha;
  readonly testedMergeCandidateTree: FullSha;
  readonly testedMergeCandidateParents: readonly [FullSha, FullSha];
  readonly resultingMainTree: FullSha;
  readonly resultingMainCommit: FullSha;
  readonly baseAdvance: BaseAdvanceEvidence;
  readonly requiredChecks: RequiredProgramChecks;
  readonly workflowRuns: RequiredProgramWorkflowRuns;
  readonly checkArtifactSetSha256: Sha256Hex;
  readonly programLocalReview: ProgramLocalReviewEvidence;
  readonly captureTool: CoordinationToolAttestation;
  readonly durableRecovery: BoundaryProgramPrRecoveryEvidence;
}

interface ImplementationBoundaryEvidence {
  readonly boundaryId: string;
  readonly protectedBoundary: ProtectedProgramBoundaryEvidence;
  readonly generatedArtifacts: readonly GeneratedArtifactEvidence[];
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
  readonly protectedBoundary: ProtectedProgramBoundaryEvidence;
  readonly closingCommitsByFinding: Readonly<Record<string, FullSha>>;
  readonly generatedArtifacts: readonly GeneratedArtifactEvidence[];
  readonly verificationRuns: readonly GitHubNonPullRequestWorkflowRunAttestation[];
  readonly reconciliationTool: CoordinationToolAttestation;
}

type ProgramPrKind =
  | 'bootstrap'
  | 'slice-reconciliation'
  | 'feeding-auxiliary-verification'
  | 'closure-reconciliation'
  | 'closeout-terminal-evidence'
  | 'closeout-tooling'
  | 'closeout-report'
  | 'closeout-archive'
  | 'closeout-receipt';
type NonBootstrapProgramPrKind = Exclude<ProgramPrKind, 'bootstrap'>;

type ProtectedBoundaryKind = 'implementation-boundary' | 'finding-close';
type ProtectedPrKind = ProgramPrKind | ProtectedBoundaryKind;

interface PriorGenericProgramPrReference {
  readonly pullRequestNumber: number;
  readonly path: `docs/superpowers/evidence/aquamobil-v4/program-prs/pr-${number}.json`;
  readonly recordSha256: Sha256Hex;
  readonly resultingMainCommit: FullSha;
  readonly resultingMainTree: FullSha;
}

interface ProgramProspectiveEvidenceBase {
  readonly schemaVersion: 1;
  readonly kind: 'aquamobil-v4-program-pr-prospective';
  readonly repository: Repository;
  readonly pullRequestNumber: number;
  readonly baseCommit: FullSha;
  readonly headCommit: FullSha;
  readonly candidateCommit: FullSha;
  readonly candidateTree: FullSha;
  readonly candidateParents: readonly [FullSha, FullSha];
  readonly baseAdvance: BaseAdvanceEvidence;
  readonly requiredChecks: RequiredProgramChecks;
  readonly workflowRuns: RequiredProgramWorkflowRuns;
  readonly checkArtifactSetSha256: Sha256Hex;
  readonly programLocalReview: ProgramLocalReviewEvidence;
  readonly pullRequestApiSha256: Sha256Hex;
  readonly captureTool: CoordinationToolAttestation;
  readonly closeoutFinalizerObservation: CloseoutFinalizerObservationBinding | null;
}

type BootstrapProgramProspectiveEvidence = ProgramProspectiveEvidenceBase & {
  readonly prKind: 'bootstrap';
  readonly previousGenericProgramPr: null;
};

type ChainedGenericProgramProspectiveEvidence = ProgramProspectiveEvidenceBase & {
  readonly prKind: NonBootstrapProgramPrKind;
  readonly previousGenericProgramPr: PriorGenericProgramPrReference;
};

type GenericProgramProspectiveEvidence =
  | BootstrapProgramProspectiveEvidence
  | ChainedGenericProgramProspectiveEvidence;

type BoundaryProgramProspectiveEvidence = ProgramProspectiveEvidenceBase & {
  readonly prKind: ProtectedBoundaryKind;
  readonly previousGenericProgramPr?: never;
};

type ProgramProspectiveEvidence =
  | GenericProgramProspectiveEvidence
  | BoundaryProgramProspectiveEvidence;

interface ProtectedPrPostmergePayloadBase {
  readonly schemaVersion: 1;
  readonly kind: 'aquamobil-v4-program-pr-postmerge';
  readonly resultingMainCommit: FullSha;
  readonly resultingMainTree: FullSha;
  readonly mergeApiSha256: Sha256Hex;
  readonly reconciliationTool: CoordinationToolAttestation;
  readonly closeoutFinalizerObservation: CloseoutFinalizerObservationBinding | null;
}

type BootstrapProgramPrPostmergePayload = ProtectedPrPostmergePayloadBase & {
  readonly prKind: 'bootstrap';
  readonly prospective: BootstrapProgramProspectiveEvidence;
  readonly previousGenericProgramPr: null;
};

type ChainedGenericProgramPrPostmergePayload = ProtectedPrPostmergePayloadBase & {
  readonly prKind: NonBootstrapProgramPrKind;
  readonly prospective: ChainedGenericProgramProspectiveEvidence;
  readonly previousGenericProgramPr: PriorGenericProgramPrReference;
};

type GenericProgramPrPostmergePayload =
  | BootstrapProgramPrPostmergePayload
  | ChainedGenericProgramPrPostmergePayload;

type BoundaryProgramPrPostmergePayload = ProtectedPrPostmergePayloadBase & {
  readonly prKind: ProtectedBoundaryKind;
  readonly prospective: BoundaryProgramProspectiveEvidence;
  readonly previousGenericProgramPr?: never;
};

type ProtectedPrPostmergePayload =
  | GenericProgramPrPostmergePayload
  | BoundaryProgramPrPostmergePayload;

interface ProgramPostmergeRecoveryCommentAttestation {
  readonly author: 'Okan-wqm';
  readonly authorPermission: 'admin';
  readonly selectionRule: 'lowest-matching-comment-id';
  readonly commentId: number;
  readonly commentUrl: string;
  readonly payloadSha256: Sha256Hex;
  readonly envelopeBodySha256: Sha256Hex;
  readonly apiResponseSha256: Sha256Hex; // canonical single-comment API object, not the mutable list
  readonly collaboratorPermissionApiSha256: Sha256Hex;
}

interface ProtectedPrRecoveryEvidence {
  readonly payload: ProtectedPrPostmergePayload;
  readonly recoveryComment: ProgramPostmergeRecoveryCommentAttestation;
}

interface BoundaryProgramPrRecoveryEvidence {
  readonly payload: BoundaryProgramPrPostmergePayload;
  readonly recoveryComment: ProgramPostmergeRecoveryCommentAttestation;
}

interface ProgramPrEvidence {
  readonly payload: GenericProgramPrPostmergePayload;
  readonly recoveryComment: ProgramPostmergeRecoveryCommentAttestation;
}

interface ProgramEvidenceSpoolManifest {
  readonly schemaVersion: 1;
  readonly phase: 'review' | 'authorization' | 'prospective' | 'postmerge';
  readonly entries: readonly {
    readonly relativePath: string;
    readonly contentSha256: Sha256Hex;
  }[];
  readonly excludes: readonly ['manifest.json', 'spool-attestation.json'];
}

interface ProgramEvidenceSpoolAttestation {
  readonly relativeGenerationDirectory: `aquamobil-v4-program-evidence/v1/pr-${number}/generations/${Sha256Hex}`;
  readonly phaseManifestSha256: Sha256Hex;
  readonly durability: 'nofollow-exclusive-link-no-replace-fsync-file-and-directory';
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
  readonly exclusionEvidence: readonly GitHubNonPullRequestWorkflowRunAttestation[];
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
  readonly currentMainVerification: readonly GitHubNonPullRequestWorkflowRunAttestation[];
}

type SourceHistoryObject =
  | {
      readonly kind: 'commit';
      readonly commit: FullSha;
      readonly orderedParents: readonly [FullSha];
      readonly tree: FullSha;
      readonly subject: string;
    }
  | {
      readonly kind: 'merge';
      readonly commit:
        | 'd6cc9d889b26a2566fe0211868e8faf7f2b34b23'
        | '1cae13834df31b4f5f982785e27b68d717d3de0b';
      readonly orderedParents: readonly [FullSha, FullSha];
      readonly tree: FullSha;
      readonly subject: string;
    };

interface SourceHistoryDocument {
  readonly schemaVersion: 1;
  readonly repository: Repository;
  readonly designMainCommit: '4002868c535a2d8676aad6eadd5f4bbd57d4625b';
  readonly order0BaseMainCommit: FullSha;
  readonly planning: {
    readonly pullRequestNumber: 1333;
    readonly headRefName: 'feat/aquamobil-v4-safe-integration';
    readonly reviewedHeadCommit: FullSha;
    readonly resultingMainCommit: FullSha;
    readonly mergedAt: string;
    readonly normalizedApiSha256: Sha256Hex;
    readonly order0InputBlobs: readonly [
      GitBlobAttestation,
      GitBlobAttestation,
      GitBlobAttestation,
      GitBlobAttestation,
      GitBlobAttestation,
      GitBlobAttestation,
    ];
    readonly closeoutPlanBlob: GitBlobAttestation;
  };
  readonly sourceRef: {
    readonly refName: 'refs/heads/feature/aquamobil-v4-redesign';
    readonly commit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
    readonly pullRequestNumber: 1107;
    readonly pullRequestState: 'OPEN';
    readonly normalizedApiSha256: Sha256Hex;
  };
  readonly mergeBase: '8d8d54365ada11d45b43374af76e9814c5958ff0';
  readonly objects: readonly SourceHistoryObject[]; // exactly 35 in Git reverse order
}

interface AquaMobilV4ExecutionLedger {
  readonly schemaVersion: 4;
  readonly repository: Repository;
  readonly anchors: {
    readonly designMainCommit: '4002868c535a2d8676aad6eadd5f4bbd57d4625b';
    readonly order0BaseMainCommit: FullSha;
    readonly planningMainCommit: FullSha;
    readonly sourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
    readonly mergeBase: '8d8d54365ada11d45b43374af76e9814c5958ff0';
  };
  readonly rows: readonly SourceCommitDisposition[];
}
```

The `closeoutFinalizerObservation` field is non-null if and only if `prKind` is
`closeout-receipt`; every other kind requires literal `null`. For the receipt, review input, report,
authorization payload, prospective evidence, and postmerge payload copy the same canonical binding.
The trusted coordinator recomputes it from the candidate's exact live-reference blob plus fresh
direct source-ref and exhaustive pull-request API observations. Candidate CI validates the bound
blob offline without a token; the prospective, postmerge, finalizer-main, and cleanup verifiers each
perform their own trusted remote reread. Any content/API digest, source state, or PR
state/head/head-SHA/base/draft drift fails before authorization, merge success, or cleanup.

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
For each boundary, `reviewedBaseMainCommit` is the base commit named by the current PR test-merge
candidate and the preflight base is its ancestor. Canonical base-advance evidence either has an
empty owned/shared-authority overlap set with `resolution: 'no-overlap'`, or lists every overlap and
proves `resolution: 'merged-main-and-reauthorized'` with the normal main-merge commit plus distinct
new independent-review-report and administrator-authorization-comment digests. The two states
cannot mix. Every required pull-request workflow checks out `testedMergeCandidateCommit`, records
that exact base and every executed repository-tool blob, and has no newer untested candidate.
Post-merge capture requires the tested candidate tree to equal `resultingMainCommit^{tree}`; a stale
PR-head-only run fails.

Every protected program PR uses the same finite evidence lifecycle. `ProtectedPrKind` selects a
closed branch/path allowlist; `ProgramPrKind` is the generic append-only-chain subset and
`ProtectedBoundaryKind` is the implementation/finding-close subset.
`closeout-terminal-evidence` is distinct from
`feeding-auxiliary-verification` and cannot borrow its registry entry or path authority.
`capture-github-evidence.mjs` exposes this generic prospective interface:

```text
--verify-prospective-program-pr <pull-request-number>
--repository Okan-wqm/aquaculture_platform
--pr-kind <exact-closed-ProtectedPrKind>
--expected-head <exact-branch>
--verify-base-advance
--require-current-pr-test-merge-candidate
--program-pr-generation <absolute-common-dir-generation>
```

The mode resolves the current protected-main base `B`, exact head branch/SHA `H`, and current
ordinary `pull_request` test-merge candidate `C` directly from GitHub. It requires the four
manifest-pinned required contexts and exactly three run/attempt artifacts: the CI-Affected artifact
is shared by `merge-gate` and `sens-enterprise-summary`, and CI Full and ARIA each contribute one.
The three emitted artifacts agree only on canonical `N/B/H/C/T/[B,H]` and derived
`canonicalLineageSha256`; their run, attempt, producer check, workflow
repository/path/ref/SHA/blob, and capture-tool blob tuples must be pairwise distinct. Only after all
four checks and all three run/artifact attestations validate does the prospective verifier sort the
closed set canonically and compute top-level `checkArtifactSetSha256` for the review input, report,
authorization payload, and `ProgramProspectiveEvidence`. Its hash domain is exactly the canonical
JSON projection `{requiredChecks, workflowRuns}` in the tuple order defined by
`RequiredProgramChecks` and `RequiredProgramWorkflowRuns`: the projection retains each primitive
GitHub identity, API-response digest, workflow/blob/tool identity, artifact ID/digest and payload
SHA-256, but excludes `checkArtifactSetSha256`, copied `canonicalLineageSha256` values, and any
aggregate/set-digest field. An emitter or source artifact carrying that whole-set digest fails
schema validation. `merge-gate` is both check and producer for
CI-Affected; `sens-enterprise-summary.checkRunId != merge-gate.producerCheckRunId` while sharing its
run/attempt and `producerJobId: merge-gate`; Full and ARIA each have context check equal to producer
check. It computes the changed-path intersection between the branch's pinned creation base and
reviewed main. Zero overlap records `no-overlap`; overlap requires a normal main-into-branch merge,
complete rerun, and new report/comment. It rejects caller-supplied path waivers, rebased/force-updated
lineage, earlier candidates, head-only runs, or any base/head/candidate/check/artifact change after
authorization. Specialized implementation and finding-close entry points are strict aliases over
this same prospective/spool/post-merge protocol, not weaker evidence formats.

The Git common directory owns durable evidence at
`.git/aquamobil-v4-program-evidence/v1/pr-<N>/`. Each changed candidate/check/artifact set creates an
append-only `generations/<checkArtifactSetSha256>/` child with distinct `review/`, `authorization/`,
`prospective/`, and `postmerge/` phase directories, so a rerun never overwrites a prior
authorization and every immutable `manifest.json` has one phase. The tools resolve the root with
`git rev-parse --path-format=absolute --git-common-dir`; `lstat` every ancestor and leaf, reject
symlinks/non-directories/wrong owner or mode, create the root and PR directory mode `0700`, create
each same-directory scratch file mode `0600` with `open(O_NOFOLLOW|O_CREAT|O_EXCL)`, canonicalize
and write JSON, `fsync` and close it, then call `link(temp, final)` as the atomic no-replace
publication. `EEXIST` fails closed; the tool then `fsync`s the directory, unlinks the scratch file, and
`fsync`s the directory again. It never pre-checks then renames over a final path and never overwrites
a generation. Exact recovery alone may validate and reap a crash-left scratch file whose bytes and
identity match the remote canonical payload. The review manifest hashes `review-input.json` and
`independent-review.json`; the authorization manifest hashes `authorization-payload.json`, its
rendered envelope, and `authorization-comment-attestation.json`; the prospective manifest hashes the
full `prospective.json`; and the postmerge manifest hashes `postmerge-payload.json`, its rendered
envelope, `postmerge-comment-attestation.json`, and exactly one closed kind-specific assembled file:
`program-pr-evidence.json` for generic PRs or `boundary-program-pr-recovery.json` for boundary PRs.
The assembled file is a deterministic byte-verified projection of the separately hashed payload and
comment attestation; both, neither, an extra field, or unequal projection bytes fail. Each manifest
explicitly excludes itself and `spool-attestation.json`; the externally returned
`ProgramEvidenceSpoolAttestation` holds the manifest digest, so neither file hashes itself. The
spool is worktree-independent and survives host restart.
If local files are absent, recovery downloads the canonical authorization or post-merge payload from
GitHub, verifies repository/PR/author/admin permission, canonical payload and envelope digests, then
recreates the same generation and phase files through that exclusive-link protocol. A digest alone
can never regenerate a report or payload.

Authorization marker comments are append-only audit history. The verifier canonicalizes every
remote marker payload and requires exactly one well-formed comment matching the complete current
`N/B/H/C/T/[B,H]/reportSha256/checkArtifactSetSha256`. Zero or multiple current matches fail;
malformed payloads colliding with any current identity fail closed; stale well-formed lineage remains
history and does not count. Because check IDs, artifact IDs, run IDs, and attempts participate in
`checkArtifactSetSha256`, even a rerun against the same `C` requires a fresh report and authorization.
`ProgramIndependentReviewInput`, `ProgramIndependentReviewReport`, `ProgramAuthorizationPayload`,
and `ProgramProspectiveEvidence` carry one exact-equal `prKind`, and that kind must match the current
branch/path registry entry. A report prepared for another kind or allowlist is not reusable. The
independent-agent identity must differ from the PR author and the administrator posting the
authorization; GitHub review state remains irrelevant.

Every GitHub list that participates in existence, latest selection, cardinality, or uniqueness is
collected through one closed exhaustive contract. The client requests `per_page=100`, then parses
and follows RFC 8288 `Link` headers until no `rel="next"` remains; the page size is only an
optimization and never a completeness claim. It canonicalizes the full multipage set, validates
`total_count` when the endpoint supplies it, and rejects a repeated page, looped next link,
cross-page duplicate identity, count mismatch, or response whose advertised next page was not
fetched. Check runs, workflow runs, workflow jobs, run artifacts, PR comments, pull requests,
repository rulesets, matching tag refs, and any future list kind must enter the closed
`ExhaustiveGitHubListKind` union.
The coordinator's `--list-pull-requests-exhaustive` mode emits the canonical full PR array used by
the shell blocks below; `gh pr list` or a default first page is display-only and cannot decide
uniqueness. `gh pr checks --watch` is likewise only a human wait/UX step; the exhaustive coordinator
set is the sole evidence authority. Fixtures put required ARIA check/run/job/artifact evidence, a
second current authorization/postmerge marker, a duplicate matching PR, and the matching
ruleset/tag on later pages; accepting only page one must fail for every list kind. Workflow-run
fixtures separately put the only matching run on a later page and duplicate one run identity across
pages; both pre-dispatch snapshots and post-dispatch exact-one selection must reject incomplete or
duplicated sets.
The authorization payload embeds the complete `ProgramIndependentReviewReport`; the surrounding
comment payload also embeds the full four `RequiredProgramChecks` and three
`RequiredProgramWorkflowRuns`, base-advance proof, pull-request API digest, capture-tool attestation,
and exact prior-generic discriminant/reference, so it is sufficient to reconstruct every pre-merge
fact after local spool loss and artifact expiry. Prospective capture requires byte-exact equality
between those authorization facts and its own fields. The surrounding comment envelope and
`ProgramAuthorizationCommentAttestation` are separate so no comment ID or API digest is
self-referential. Canonical UTF-8 authorization and recovery envelopes are each limited to `60000`
bytes; byte `60001`, truncation, non-canonical whitespace, or an API round-trip body mismatch fails
closed and requires a reviewed schema/external-archive revision before merge.

For every non-bootstrap PR, run this exact parameterized lifecycle from a fresh shell. Set the four
required variables to the current PR's literal values; the closed `ProtectedPrKind` and registry
reject all other values:

```bash
set -euo pipefail
: "${PROGRAM_PR_NUMBER:?set exact open PR number}"
: "${PROGRAM_PR_KIND:?set exact closed ProtectedPrKind}"
: "${PROGRAM_EXPECTED_HEAD:?set exact registered head branch}"
: "${PROGRAM_REVIEWER_OUTPUT:?set independent agent canonical report path}"
[[ "$PROGRAM_PR_NUMBER" =~ ^[0-9]+$ ]]
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas \
  rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PROGRAM_PR_NUMBER"
PROGRAM_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --initialize-program-pr-spool "$PROGRAM_PR_ROOT" \
  --write-independent-review-input \
  --pull-request "$PROGRAM_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind "$PROGRAM_PR_KIND" \
  --expected-head "$PROGRAM_EXPECTED_HEAD" \
  --verify-base-advance \
  --require-current-pr-test-merge-candidate \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --print-program-pr-generation)"
[[ "$PROGRAM_PR_GENERATION" == \
  "$PROGRAM_PR_ROOT"/generations/[0-9a-f][0-9a-f]* ]]
PROGRAM_GENERATION_DIGEST="${PROGRAM_PR_GENERATION##*/}"
[[ "$PROGRAM_GENERATION_DIGEST" =~ ^[0-9a-f]{64}$ ]]
```

Stop for the independent agent, who consumes exactly
`$PROGRAM_PR_GENERATION/review/review-input.json` and writes `$PROGRAM_REVIEWER_OUTPUT`. Then ingest,
authorize, round-trip, and persist the full prospective bundle. Every command selects the immutable
generation explicitly; none may fall back to a PR-root “latest” file:

```bash
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --ingest-independent-review-report "$PROGRAM_REVIEWER_OUTPUT" \
  --program-pr-generation "$PROGRAM_PR_GENERATION"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --write-authorization-comment-envelope \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --program-pr-generation "$PROGRAM_PR_GENERATION"
gh pr comment "$PROGRAM_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --body-file "$PROGRAM_PR_GENERATION/authorization/authorization-comment-envelope.md"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$PROGRAM_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind "$PROGRAM_PR_KIND" \
  --expected-head "$PROGRAM_EXPECTED_HEAD" \
  --verify-base-advance \
  --require-current-pr-test-merge-candidate \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --program-pr-generation "$PROGRAM_PR_GENERATION" \
  --write-prospective-spool
```

The by-kind enforcement requires literal null for every kind except `closeout-receipt`. For that
finalizer, the trusted detached coordinator resolves the candidate disposition and selected
live-reference blob, recomputes all content/API digests, exhaustively rereads the source ref and
PR #1107, and copies one canonical `closeoutFinalizerObservation` through review, report,
authorization, and prospective evidence. False/false requires source PRESENT at the immutable SHA
and PR #1107 OPEN/non-draft with its exact head/ref/SHA/base identity. Required-workflow candidate
emitters remain tokenless and API-free. The prospective check is rerun immediately before merge;
remote or bound-blob drift blocks authorization and merge.

After the protected merge, start another fresh shell, resolve all variables again, and reconcile the
full bundle before cleanup:

```bash
set -euo pipefail
: "${PROGRAM_PR_NUMBER:?re-enter exact merged PR number}"
: "${PROGRAM_PR_KIND:?re-enter exact closed ProtectedPrKind}"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas \
  rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PROGRAM_PR_NUMBER"
PROGRAM_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$PROGRAM_PR_ROOT" \
  --pull-request "$PROGRAM_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind "$PROGRAM_PR_KIND" \
  --from-current-authorization-comment)"
[[ "$PROGRAM_PR_GENERATION" == \
  "$PROGRAM_PR_ROOT"/generations/[0-9a-f][0-9a-f]* ]]
PROGRAM_GENERATION_DIGEST="${PROGRAM_PR_GENERATION##*/}"
[[ "$PROGRAM_GENERATION_DIGEST" =~ ^[0-9a-f]{64}$ ]]
PROGRAM_MAIN_COMMIT="$(gh pr view "$PROGRAM_PR_NUMBER" \
  --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$PROGRAM_MAIN_COMMIT" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$PROGRAM_MAIN_COMMIT" origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --reconcile-program-pr "$PROGRAM_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind "$PROGRAM_PR_KIND" \
  --resulting-main "$PROGRAM_MAIN_COMMIT" \
  --program-pr-generation "$PROGRAM_PR_GENERATION" \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --write-postmerge-spool
PROGRAM_POSTMERGE_COMMENT_ACTION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --write-postmerge-recovery-comment-envelope \
  --select-canonical-postmerge-recovery-comment \
  --pull-request "$PROGRAM_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --program-pr-generation "$PROGRAM_PR_GENERATION" \
  --print-postmerge-comment-action)"
case "$PROGRAM_POSTMERGE_COMMENT_ACTION" in
  post)
    gh pr comment "$PROGRAM_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
      --body-file "$PROGRAM_PR_GENERATION/postmerge/postmerge-comment-envelope.md"
    ;;
  reuse-lowest-id)
    :
    ;;
  *)
    exit 1
    ;;
esac
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --verify-postmerge-recovery-comment \
  --program-pr-generation "$PROGRAM_PR_GENERATION" \
  --recover-spool-from-github-if-missing \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --require-result-tree-equals-candidate-tree
```

The post-merge recovery payload is the complete canonical `ProtectedPrPostmergePayload`; its comment
attestation is stored separately, so the comment never contains its own ID/digest. Boundary payloads
forbid a prior-generic field and map into `ProtectedProgramBoundaryEvidence.durableRecovery`; generic
payloads require the scheduler-defined prior reference (bootstrap alone uses `null`) and form the
tracked `ProgramPrEvidence` chain. Postmerge marker history is append-only, but recovery requires
at least one well-formed comment matching the full payload/current resulting-main identity. The
canonical authority is always the lowest numeric matching comment ID; all higher matching comments
must have byte-identical canonical payload/envelope bytes and remain inert audit copies. A malformed
current marker, a current-lineage different-payload collision, or zero matches fails. Before posting,
the tool enumerates fresh API comments and returns only `post` or `reuse-lowest-id`; a crash after a
successful post therefore reuses the existing lowest ID, while a concurrent byte-identical post
cannot change the selected attestation. `apiResponseSha256` hashes the canonical single-comment API
object for that selected ID, never the mutable comment list. Cleanup tools
require a successful GitHub round trip and byte-identical verified spool. Implementation/finding-close
boundaries persist their `ProtectedProgramBoundaryEvidence` inside the slice/closure reconciliation
record. Generic PRs form a finite append-only chain: before committing a generic PR, the coordinator
materializes the immediately preceding generic PR's full verified `ProgramPrEvidence` as
`docs/superpowers/evidence/aquamobil-v4/program-prs/pr-<N>.json` in the new branch. That predecessor
record cannot yet be main-reachable: the new PR's prospective verifier instead requires its exact
PR number, path, full canonical `ProgramPrEvidence` digest, and resulting-main identity in
`ProgramProspectiveEvidence.previousGenericProgramPr`, resolves the tracked blob from current
candidate `C/T`, and requires byte equality. The bootstrap record alone uses `null`; every later
generic PR names exactly the immediately preceding generic PR selected by the scheduler. The tracked
file is the full portable `ProgramPrEvidence`—payload plus verified recovery-comment attestation—and
never contains a host-local spool path. `GenericProgramPrPostmergePayload` copies that exact prior
reference.
After the new PR merges, `T == resultingMain^{tree}` makes the predecessor record main-reachable. No
following generic PR may start review or authorization until that post-merge proof succeeds.
`closeout-receipt` carries the
archive and therefore every earlier generic record through this rule, but cannot commit its own
post-merge result into itself. Its verified common-dir spool plus full canonical GitHub recovery
comment is the one terminal external anchor, preventing an infinite meta-reconciliation chain.
Receipt/coordinator cleanup requires that remote round trip, spool verification, proof that every
prior generic record is main-reachable, and another trusted exhaustive source/PR reread equal to the
same protected-main finalizer observation. Postmerge construction and recovery-comment verification
perform that reread independently; a race after candidate capture cannot become postmerge success.

Every generic PR except bootstrap runs this coordinator-absolute materialization before its commit.
It selects the scheduler's immediately preceding generic PR, recovers its full record from the
verified remote recovery payload when necessary, and writes the portable full record—not a payload
fragment or local-path reference—into the current candidate:

```bash
set -euo pipefail
: "${PROGRAM_PR_KIND:?set exact non-bootstrap ProgramPrKind}"
: "${PROGRAM_EXPECTED_HEAD:?set exact registered branch}"
PROGRAM_CANDIDATE_WORKTREE="$(git rev-parse --show-toplevel)"
test "$PROGRAM_CANDIDATE_WORKTREE" != /var/aqua-saas
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$PROGRAM_CANDIDATE_WORKTREE"
test "$(git branch --show-current)" = "$PROGRAM_EXPECTED_HEAD"
PREVIOUS_GENERIC_PR_NUMBER="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr \
  --for-pr-kind "$PROGRAM_PR_KIND" \
  --expected-head "$PROGRAM_EXPECTED_HEAD" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas \
  rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
[[ "$PREVIOUS_PROGRAM_PR_ROOT" == \
  /var/aqua-saas/.git/aquamobil-v4-program-evidence/v1/pr-[0-9]* ]]
PREVIOUS_PROGRAM_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$PREVIOUS_PROGRAM_PR_ROOT" \
  --pull-request "$PREVIOUS_GENERIC_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --from-postmerge-recovery-comment)"
[[ "$PREVIOUS_PROGRAM_PR_GENERATION" == "$PREVIOUS_PROGRAM_PR_ROOT"/generations/* ]]
PREVIOUS_PROGRAM_PR_GENERATION_DIGEST="${PREVIOUS_PROGRAM_PR_GENERATION##*/}"
[[ "$PREVIOUS_PROGRAM_PR_GENERATION_DIGEST" =~ ^[0-9a-f]{64}$ ]]
test -d "$PREVIOUS_PROGRAM_PR_GENERATION"
test ! -L "$PREVIOUS_PROGRAM_PR_GENERATION"
PREVIOUS_PROGRAM_PR_PATH="docs/superpowers/evidence/aquamobil-v4/program-prs/pr-$PREVIOUS_GENERIC_PR_NUMBER.json"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --materialize-previous-generic-program-pr \
  --program-pr-generation "$PREVIOUS_PROGRAM_PR_GENERATION" \
  --write "$PREVIOUS_PROGRAM_PR_PATH"
test -f "$PREVIOUS_PROGRAM_PR_PATH"
test ! -L "$PREVIOUS_PROGRAM_PR_PATH"
PREVIOUS_PROGRAM_PR_SHA256="$(sha256sum "$PREVIOUS_PROGRAM_PR_PATH" | cut -d' ' -f1)"
[[ "$PREVIOUS_PROGRAM_PR_SHA256" =~ ^[0-9a-f]{64}$ ]]
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --verify-previous-generic-program-pr-in-candidate \
  --path "$PREVIOUS_PROGRAM_PR_PATH" \
  --record-sha256 "$PREVIOUS_PROGRAM_PR_SHA256"
```

Fixtures execute this block in a new shell with every predecessor variable unset, and also inject a
stale path, PR number, generation, and digest. Only same-shell scheduler resolution, remote recovery,
materialization, regular-file checks, and candidate digest verification pass; prose placeholders or
an inherited `$PREVIOUS_PROGRAM_PR_PATH` never satisfy the contract.

The prospective mode copies that exact prior reference into `ProgramProspectiveEvidence`; boundary
kinds reject the field entirely. The generic post-merge payload copies it unchanged. `G2` therefore
proves the full `G1` record is byte-exact in `G2`'s `C/T`; only `G2`'s merge and
`T == resultingMain^{tree}` make the tracked record main-reachable, and `G3` review input cannot be
created before that proof. The receipt candidate must contain every earlier numeric record reached
by this chain. Its own record remains only in the terminal remote recovery comment and verified
common-dir generation because a commit cannot contain evidence of its own resulting commit/tree.

Cleanup is a distinct, delayed phase. For boundary kinds, the slice or closure reconciliation
containing `ProtectedProgramBoundaryEvidence.durableRecovery` must be merged and main-reachable.
For a generic `G2`, its post-merge remote round trip is not enough: keep `G2`'s worktree, remote
branch, and generation until `G3` merges with `G2`'s full tracked record and proves that record
main-reachable. The `G3` post-merge phase then cleans `G2` and retains `G3`. Bootstrap follows the
same record/branch/generation rule, but its exact Order 0 worktree becomes the clean detached
coordinator and is never removed by generic cleanup; after the first slice reconciliation, only its
merged remote branch and verified generation may be removed. Only the terminal receipt may clean its
own resources immediately after its verified remote round trip, because its full remote payload is
the declared terminal external anchor. Once the applicable main-reachability condition holds, an
operator may authorize deletion of the exact registered worktree where applicable, exact merged
remote program branch, and exact verified generation:

```bash
: "${PROGRAM_PR_NUMBER:?re-enter exact merged PR number}"
: "${PROGRAM_EXPECTED_HEAD:?re-enter exact registered non-main branch}"
: "${PROGRAM_PR_GENERATION:?re-enter exact verified generation}"
: "${APPROVE_PROGRAM_CLEANUP:?type the exact PROGRAM_EXPECTED_HEAD to authorize cleanup}"
test "$APPROVE_PROGRAM_CLEANUP" = "$PROGRAM_EXPECTED_HEAD"
test "$PROGRAM_EXPECTED_HEAD" != main
test "$PROGRAM_EXPECTED_HEAD" != feature/aquamobil-v4-redesign
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --authorize-program-pr-cleanup "$PROGRAM_PR_NUMBER" \
  --program-pr-generation "$PROGRAM_PR_GENERATION" \
  --require-remote-postmerge-roundtrip \
  --require-main-reachable-durable-record \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --allow-terminal-external-anchor-only-for-closeout-receipt
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup-program-pr \
  --pull-request "$PROGRAM_PR_NUMBER" \
  --expected-head "$PROGRAM_EXPECTED_HEAD" \
  --repository Okan-wqm/aquaculture_platform \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --preserve-bootstrap-coordinator-worktree \
  --main-ref origin/main
git -C /var/aqua-saas push origin --delete "$PROGRAM_EXPECTED_HEAD"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --delete-verified-program-pr-generation "$PROGRAM_PR_GENERATION" \
  --pull-request "$PROGRAM_PR_NUMBER" \
  --require-remote-postmerge-roundtrip \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --allow-exact-generation-already-absent
```

When cleaning a previous generic after the current generic merge, all three variables above name
the previous PR/branch/generation, and the authorizer additionally verifies its exact
`program-prs/pr-<N>.json` record in current `origin/main`. The cleanup modes re-resolve and `lstat`
exact registry/common-dir paths and reject `main`, the
immutable source branch, provenance refs, any unmerged/ambiguous PR, a dirty worktree, a mismatched
branch, an unverified spool, or a broader directory. They never delete a PR root or another
generation. `--preserve-bootstrap-coordinator-worktree` is mandatory for this shared block: it
preserves only the exact registered bootstrap worktree after proving it is the clean detached
coordinator and performs normal exact worktree removal for every other kind. The receipt uses the
same remote round trip and exact generation cleanup, but its own full recovery comment remains the
terminal external authority. `--allow-exact-generation-already-absent` is bootstrap-only: it may
return success for an absent exact generation only after re-fetching protected main, proving the
full tracked bootstrap record main-reachable, and round-tripping the matching full remote postmerge
payload. All non-bootstrap absence still fails. This makes the normal first-generic cleanup and I1's
rank-peer recovery cleanup the same idempotent operation even if either performs the deletion first.

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

Write only the closed-schema and bootstrap-generator fixtures first:

```bash
node --test \
  --test-name-pattern='rejects malformed SHA, unknown field, and inconsistent bootstrap identity' \
  tools/aquamobil-v4/contracts.spec.mjs
```

Expected RED: FAIL because `contracts.mjs` does not yet exist. Fixtures cover every discriminator,
exact tuple cardinality, unknown-field rejection, runtime `FullSha`/SHA-256 regular expressions,
`designMainCommit` versus generated `order0BaseMainCommit`, the seven planning blobs, the exact
35-object split, `PullRequestCandidateArtifactV1`'s sole job check authority/non-null fields,
`ProtectedProgramBoundaryEvidence`, mandatory-`protectedBoundary` `ClosureEvidence`, the generic/
boundary prospective and post-merge discriminated unions, full authorization payload, finite
`ProgramPrKind`, bootstrap-only null prior reference, mandatory non-bootstrap prior reference, full
tracked `ProgramPrEvidence`, and manifest self-exclusion.

Implement the smallest `contracts.mjs` validators and canonical JSON serializer needed by those
fixtures. Export schemas; do not add capture, GitHub, worktree, reconciliation, or audit behavior in
this bite. Then rerun the identical command.

Expected GREEN: PASS with malformed and extra-field fixtures rejected and one canonical bootstrap
fixture accepted. Review this bite before continuing.

- [ ] **Step 3: Generate all 35 source-history objects from Git**

Write bootstrap-generation fixtures before the generator:

```bash
node --test \
  --test-name-pattern='generates exact planning, source, and 35-object bootstrap graph' \
  tools/aquamobil-v4/verify-ledger.spec.mjs
```

Expected RED: FAIL because `verify-ledger.mjs` does not exist. The fixture repository contains 33
non-merge commits and the exact two merge commits; it also pins the seven planning blob paths,
normalized PR-response digests, ordered merge parents, merge trees, resolution blobs, and refusal
of an unmerged planning PR, a stale source ref, a wrong merge base, or a caller-supplied Order 0
base.

Implement only `--bootstrap-authoring` generation. It accepts the exact Order 0 branch whose base is
the fetched protected-main descendant proven in Steps 0-1, derives every identity from Git/API input,
writes canonical JSON atomically below the four named bootstrap outputs, and refuses once fetched
`origin/main` contains `tools/aquamobil-v4/verify-ledger.mjs`. It cannot validate or write slice,
boundary, closure, terminal-ledger, review, or GitHub-run evidence.

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
node --test \
  --test-name-pattern='generates exact planning, source, and 35-object bootstrap graph' \
  tools/aquamobil-v4/verify-ledger.spec.mjs
```

Expected GREEN: the focused fixture passes and the generated repository artifacts contain exactly
`35 history objects = 33 non-merge rows + 2 merge-resolution records`. For each merge, record
ordered parents, `commit^{tree}`, and each resolution path's result blob OID. These content-addressed
Git objects are the deterministic fingerprint; never hash rendered `--remerge-diff` text. A fixed
`LC_ALL=C git -c color.ui=false --no-pager show --no-ext-diff --no-color --no-renames` invocation
may only verify the exact two path names.

- [ ] **Step 4: Add the normal verifier and prove coordinator self-binding**

**Files:** `tools/aquamobil-v4/verify-ledger.mjs`,
`tools/aquamobil-v4/verify-ledger.spec.mjs`, and `tools/aquamobil-v4/contracts.mjs`.

```bash
node --test \
  --test-name-pattern='normal verification self-binds to a clean detached coordinator' \
  tools/aquamobil-v4/verify-ledger.spec.mjs
```

Expected RED: FAIL because bootstrap generation has no normal verifier. Fixtures invoke an absolute
executable from a clean detached coordinator, then prove that a relative path, active branch,
different worktree, dirty executable, dirty imported contract, mismatched Git blob, bare-package
import, short SHA, and authoring mode after the tool is on main all fail.

Implement the normal read-only verifier. It resolves `import.meta.url`, requires the executable to
be under `/var/aqua-saas/.worktrees/aquamobil-v4-coordinator`, requires that worktree clean and
detached at fetched `origin/main`, computes Git blob OIDs for itself and its exact
`tools/aquamobil-v4/contracts.mjs` import, and evaluates evidence relative to the caller's active
worktree `cwd`. Coordinator-local executables import only `node:` built-ins plus attested local
modules. Do not add a relative local package command.

```bash
node --test \
  --test-name-pattern='normal verification self-binds to a clean detached coordinator' \
  tools/aquamobil-v4/verify-ledger.spec.mjs
```

Expected GREEN: the clean detached absolute case passes and every negative binding fixture fails
closed. Review this bite before continuing.

- [ ] **Step 5: Parse detailed-plan Markdown without losing wrapped paths**

**Files:** `tools/aquamobil-v4/capture-slice-audit.mjs` and
`tools/aquamobil-v4/capture-slice-audit.spec.mjs`.

```bash
node --test \
  --test-name-pattern='tokenizes exact Files items and wrapped continuation paths' \
  tools/aquamobil-v4/capture-slice-audit.spec.mjs
```

Expected RED: FAIL because the tokenizer does not exist. Fixtures include both same-line and exactly
one Prettier-indented continuation after `- Create:`, `- Modify:`, `- Delete:`, or `- Regenerate:`.
They pin these wrapped paths literally:
`apps/messaging-service/src/message/services/__tests__/s3-storage-object-verifier.service.spec.ts`,
`web/apps/aquamobil/src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx`,
and
`apps/farm-service/src/feeding/services/__tests__/daily-feeding-execution.protocol-rate.spec.ts`.

Implement a Markdown list-item tokenizer, not a line grep. Require one backtick path, one optional
continuation, exact set equality against canonical `ownedPaths`, a non-empty mapping for every task,
and rejection of orphan/second continuations, duplicates, missing/multiple paths, or unknown marker
verbs.

```bash
node --test \
  --test-name-pattern='tokenizes exact Files items and wrapped continuation paths' \
  tools/aquamobil-v4/capture-slice-audit.spec.mjs
```

Expected GREEN: all four committed detailed-plan fixtures map exactly and every malformed fixture is
rejected. Review this bite before continuing.

- [ ] **Step 6: Pin the registry and worktree lifecycle**

**Files:** `docs/superpowers/evidence/aquamobil-v4/slice-branches.json`,
`tools/aquamobil-v4/worktree.mjs`, and `tools/aquamobil-v4/worktree.spec.mjs`.

```bash
node --test \
  --test-name-pattern='registry and worktree lifecycle are exact and fail closed' \
  tools/aquamobil-v4/worktree.spec.mjs
```

Expected RED: FAIL because the registry and lifecycle tool do not exist. Fixtures pin all 16 slice
branches/worktrees, ranks, predecessor reconciliations, ordered implementation-boundary IDs, five
finding-closure definitions, and the singleton feeding verification entry. They reject unknown or
extra registry keys, path/branch reuse, a path outside `/var/aqua-saas/.worktrees/`, dirty/stale
state, and a missing or ambiguous predecessor.

Implement only registry validation plus `create`, `create-verification`, `create-finding-closure`,
`print-path`, `print-branch`, active-record queries, `retain-after-postmerge`, and exact-target
`cleanup-program-pr`. `retain-after-postmerge` verifies the full local/remote post-merge generation
and records that the clean worktree is intentionally awaiting its main-reachable durable record; it
does not detach or delete anything. `cleanup-program-pr` requires the reconciler's exact cleanup
authorization described above; its shared preserve flag keeps only the exact clean detached
bootstrap coordinator and still removes every non-bootstrap target, while omission for bootstrap or
any attempt to classify another worktree as the coordinator fails.
Each creating mode
fetches `main` by exact refspec, starts only at that SHA, and rejects a present local branch/path;
cleanup proves one configured merged PR and main-reachable evidence before removing one clean
configured worktree. Every mode uses the Step 4 self-binding contract. Order 0 tests use isolated Git
fixtures and do not create any live slice, verification, or closure worktree.

```bash
node --test \
  --test-name-pattern='registry and worktree lifecycle are exact and fail closed' \
  tools/aquamobil-v4/worktree.spec.mjs
```

Expected GREEN: the pinned lifecycle succeeds only in the complete fixture and all stale,
ambiguous, reused, and out-of-root cases fail. Review this bite before continuing.

- [ ] **Step 7: Emit and verify the real required-workflow PR candidate artifacts**

**Files:** `tools/aquamobil-v4/capture-github-evidence.mjs`,
`tools/aquamobil-v4/capture-github-evidence.spec.mjs`, `.github/workflows/ci-affected.yml`,
`.github/workflows/ci-full.yml`, `.github/workflows/aria-merge-authority.yml`,
`.github/manifests/main-required-status-checks.json`, and
`tests/invariants/aquamobil-v4-required-workflow-evidence.spec.ts`.

```bash
node --test \
  --test-name-pattern='emits and verifies current PR test-merge candidate artifacts' \
  tools/aquamobil-v4/capture-github-evidence.spec.mjs
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-v4-required-workflow-evidence.spec.ts
```

Expected RED: both commands fail. Fixtures distinguish GitHub API head `H` from Actions checkout
`C`, pin exact `refs/pull/<N>/merge`, `C`'s tree and ordered parents `[B,H]`, run/attempt/check ID,
producer job/check identity, workflow repository/file/ref/SHA/blob, executable blob, artifact name
and ZIP member, and normalized API digests. Negative cases include a head-only checkout, stale
candidate, swapped parent, duplicate or missing artifact, wrong producer job/check, foreign workflow
repository/ref/SHA, context/producer conflation, wrong ZIP member, unknown field, old flag, and non-PR
event. They also reject equal producer tuples across artifacts, unequal canonical lineage digests,
a source payload containing the prospective-only whole-set digest, CI-Affected summary masquerading
as the producer, or Full/ARIA context checks differing from their
producer checks. The emitted payload has one check authority at `job.check_run_id`; a duplicate
top-level `producerCheckRunId`, missing/empty/renamed `job.check_run_id`, `job.workflow_ref`,
`job.workflow_sha`, `job.workflow_repository`, or `job.workflow_file_path`, a hard-coded value, a
fallback to `github.workflow*`, or any mismatch with the trusted coordinator's exhaustive Jobs API
and Git-blob state fails closed. The candidate emitter itself has no token and performs no GitHub
API or network call. The normalized verifier attestation derives its `producerCheckRunId` from that
sole source field. The invariant fails while any required terminal job lacks its matched
emitter/upload pair, exact job permissions, or manifest workflow/tool pins.

Implement checkout-local `--ci-attested --emit-pr-candidate <path>` and the prospective verifier.
The emitter runs only for `pull_request`, requires `GITHUB_SHA == C`, derives `N/B/H` from the event
and Git, and receives `github.job` plus the five exact official `job.*` fields through explicit
arguments. It derives the workflow blob from the checked-out Git object named by
`job.workflow_sha` and `job.workflow_file_path`, then atomically writes exactly
`pull-request-candidate.json` with kind `aquamobil-v4-pull-request-test-merge`; it neither receives
a token nor calls GitHub. The trusted coordinator later exhaustively cross-checks all supplied job
identity fields against the current run-attempt Jobs API, the event, and Git blobs. The verifier
requires exact flag
`--require-current-pr-test-merge-candidate`; any other spelling is an error.

Modify only the three existing required workflows; do not add a workflow. Each producer job has
exact job-level `permissions: { contents: read }`; `actions: read` is forbidden. Both the SHA-pinned
checkout and emitter/upload are guarded by the identical
`if: github.event_name == 'pull_request'`, so existing push/manual lanes remain untouched. Checkout
uses `fetch-depth: 2` and `persist-credentials: false`.
Neither the emitter nor upload receives `GH_TOKEN` or any other token. The producer matrix is closed:

| Workflow                                     | Producer job/context   | Explicit `--job-workflow-file-path`          |
| -------------------------------------------- | ---------------------- | -------------------------------------------- |
| `.github/workflows/ci-affected.yml`          | `merge-gate`           | `.github/workflows/ci-affected.yml`          |
| `.github/workflows/ci-full.yml`              | `build-status`         | `.github/workflows/ci-full.yml`              |
| `.github/workflows/aria-merge-authority.yml` | `aria-merge-authority` | `.github/workflows/aria-merge-authority.yml` |

Every producer uses this exact pinned shape with its literal matrix row values:

```yaml
permissions:
  contents: read
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    if: github.event_name == 'pull_request'
    with:
      ref: ${{ github.sha }}
      fetch-depth: 2
      persist-credentials: false
  - name: Emit AquaMobil v4 PR candidate
    if: github.event_name == 'pull_request'
    env:
      PRODUCER_JOB_ID: ${{ github.job }}
      PRODUCER_CHECK_RUN_ID: ${{ job.check_run_id }}
      PRODUCER_WORKFLOW_FILE_PATH: ${{ job.workflow_file_path }}
      PRODUCER_WORKFLOW_REF: ${{ job.workflow_ref }}
      PRODUCER_WORKFLOW_SHA: ${{ job.workflow_sha }}
      PRODUCER_WORKFLOW_REPOSITORY: ${{ job.workflow_repository }}
    run: |
      node tools/aquamobil-v4/capture-github-evidence.mjs \
        --ci-attested \
        --emit-pr-candidate "$RUNNER_TEMP/pull-request-candidate.json" \
        --job-id "$PRODUCER_JOB_ID" \
        --job-check-run-id "$PRODUCER_CHECK_RUN_ID" \
        --job-workflow-file-path "$PRODUCER_WORKFLOW_FILE_PATH" \
        --job-workflow-ref "$PRODUCER_WORKFLOW_REF" \
        --job-workflow-sha "$PRODUCER_WORKFLOW_SHA" \
        --job-workflow-repository "$PRODUCER_WORKFLOW_REPOSITORY"
  - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
    if: github.event_name == 'pull_request'
    with:
      name: aquamobil-v4-pr-candidate-${{ github.run_id }}-${{ github.run_attempt }}
      path: ${{ runner.temp }}/pull-request-candidate.json
      if-no-files-found: error
      retention-days: 30
```

Each job receives `PRODUCER_WORKFLOW_FILE_PATH` from exact `${{ job.workflow_file_path }}` and the
trusted coordinator requires it to equal the literal table value. The invariant rejects a renamed,
missing, empty, hard-coded, or interpolated replacement for any official `job.*` field; a
`github.workflow*`/repository fallback; inherited permissions or any token; candidate-side API or
network access; a different guard on emitter and upload; shallow depth other than two; or an
unpinned action.

The exact producers are `merge-gate` in `ci-affected.yml`, `build-status` in `ci-full.yml`, and
`aria-merge-authority` in `aria-merge-authority.yml`. The manifest continues to require four
contexts—`merge-gate`, `sens-enterprise-summary`, `build-status`, and `aria-merge-authority`, all app
ID `15368`—but pins those contexts to the three producer jobs, their workflow blobs, the artifact
contract, and `tools/aquamobil-v4/**`. The two CI-Affected contexts deliberately share one artifact;
`merge-gate.checkRunId == producerCheckRunId`, while
`sens-enterprise-summary.checkRunId != producerCheckRunId` and both name the same CI-Affected
run/attempt and `producerJobId: merge-gate`. For Full and ARIA, context check equals producer check.
All other context-to-producer/run aliasing fails.

The prospective verifier exhaustively traverses RFC 8288 `Link` pagination for the current
run-attempt Jobs API before it trusts the emitter identity. It downloads each run-owned ZIP through
GitHub APIs, requires exactly the one
JSON member, validates the server artifact digest plus payload SHA-256, verifies latest successful
exact-context/app check runs on `H`, and requires exactly three distinct run/attempt artifacts that
share only current `N/B/H/C/T/[B,H]` and `canonicalLineageSha256` while retaining three distinct
`(runId, runAttempt, producerCheckRunId, workflow repository/path/ref/SHA/blob, tool blob)` tuples.
Only the prospective collector computes `checkArtifactSetSha256`. Separate push/manual capture uses
`GitHubNonPullRequestWorkflowRunAttestation`; it can never satisfy a PR gate and has no nullable PR
artifact.

For Order 0 only, add `--bootstrap-order0-pr`. It is valid solely on the exact bootstrap branch/base
while fetched main lacks the tool, retains every GitHub/candidate/workflow/blob check, and refuses
all other PR kinds or output types. After Order 0 merges, only the absolute coordinator copy may run
prospective local verification. In either mode, validate a canonical independent-agent JSON review
report bound to exact kind and `N/B/H/C/T/[B,H]/checkArtifactSetSha256`, reviewer identity and
`verdict: approved`, then inspect every structured marker comment. Require exactly one well-formed
current match; its author is `Okan-wqm` with current repository `admin` permission and its canonical
payload repeats the full report plus report SHA-256, all four checks, all three run/artifact
attestations, and the whole-set digest. Stale well-formed comments remain append-only history; zero/
multiple current matches or malformed current collisions fail. This is explicit operator
authorization, not a GitHub review. A report/comment posted before any current identity, kind,
report digest, or required-check/run/artifact fact changed fails. Canonical envelope bytes over
60000 fail before posting.

```bash
node --test \
  --test-name-pattern='emits and verifies current PR test-merge candidate artifacts' \
  tools/aquamobil-v4/capture-github-evidence.spec.mjs
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-v4-required-workflow-evidence.spec.ts
```

Expected GREEN: all candidate and program-local-review fixtures pass, the invariant proves the
four-context/three-artifact topology, and every drift/ambiguity fixture fails closed. Review this
bite before continuing.

- [ ] **Step 8: Reconcile protected merges without losing candidate or review identity**

**Files:** `tools/aquamobil-v4/reconcile-ledger.mjs` and
`tools/aquamobil-v4/reconcile-ledger.spec.mjs`.

```bash
node --test \
  --test-name-pattern='reconciles current candidate tree and preserves review authorization|selects deterministic postmerge recovery comment' \
  tools/aquamobil-v4/reconcile-ledger.spec.mjs
```

Expected RED: FAIL because the reconciler does not exist. Fixtures pin one exact merged PR,
protected-main ancestry, `resultingMainCommit^{tree} == C^{tree}`, expected squash/merge parent
semantics, all four check attestations, the three artifact/API digests, and the independent report,
reviewer, administrator comment ID/URL/body digest, comment-author permission-response digest, and
PR API digest. Fixtures also pin full authorization recovery after deleting the local spool and
expiring source artifacts; separate review/authorization/prospective/postmerge manifests excluding
themselves; exclusive-link publication; the current authorization-comment cardinality rule;
exact-kind equality; boundary/ generic discriminated payloads; and the previous-generic record in
candidate `C/T`. Stale `H`, `B`, or `C`, an edited/deleted comment, a different report digest, a
second current matching authorization comment,
60001-byte envelope, source artifact carrying the set digest, self-hashing manifest, `rename()` over
an immutable final, two writers racing `link(temp,final)`, `EEXIST`, symlink leaf/ancestor,
crash-left temp without exact remote recovery, mismatched generation, missing prior tracked blob,
or cleanup before durable main reachability all fail.

Postmerge fixtures cover `post succeeds -> process crashes before attestation -> retry`: the retry
returns `reuse-lowest-id`, canonicalizes the lowest numeric well-formed matching comment, and
reconstructs byte-identical `ProgramPrEvidence`. Two or more current postmerge comments are accepted
only when their canonical payload/envelope bytes are identical; adding a higher identical ID leaves
the selected attestation and assembled record unchanged. Zero matches, a malformed current marker,
a different-payload current collision, a non-admin author, selecting a higher ID, or hashing the
mutable list response fails.

Implement a deterministic atomic reconciler that consumes prospective evidence rather than
rediscovering a looser boundary. It re-fetches PR, comment, collaborator permission, checks,
artifacts, and main, rejects any identity change, and writes a canonical post-merge record using the
absolute coordinator self-attestation. Its Node-built-in spool writer uses the exact
`open(O_NOFOLLOW|O_CREAT|O_EXCL,0600)` → write/fsync/close → atomic no-replace `link(temp,final)` →
directory fsync → temp unlink → directory fsync sequence. It never checks-then-renames or edits an
immutable preflight, final, generation, or prior record. Recovery alone verifies/reaps exact
crash-left temps from the canonical remote payload.

```bash
node --test \
  --test-name-pattern='reconciles current candidate tree and preserves review authorization|selects deterministic postmerge recovery comment' \
  tools/aquamobil-v4/reconcile-ledger.spec.mjs
```

Expected GREEN: exact-current fixtures reconcile byte-identically and all drift or ambiguity cases
fail. Review this bite before continuing.

- [ ] **Step 9: Make audit reachability deterministic and machine-derived**

**Files:** `scripts/ci/capture-aquamobil-v4-audit-inputs.mjs`,
`scripts/ci/capture-aquamobil-v4-audit-inputs.spec.mjs`, `scripts/ci/audit-source-map.mjs`, and
`scripts/ci/audit-source-map.spec.mjs`.

```bash
node --test scripts/ci/capture-aquamobil-v4-audit-inputs.spec.mjs \
  scripts/ci/audit-source-map.spec.mjs
```

Expected RED: FAIL because the audit-input capture executable and closed mapper behavior do not
exist. Fixtures cover all four audit commands and statuses, high/critical package extraction,
package-keyed `npm explain` execution without a shell, both lock authorities, complete
root-to-package chains, production-lock classification, a synthetic closed bundle manifest, and
direct `esbuild` as release-build tooling only. They reject advisory exit `1` as an operational
failure, operational exit `>1`, malformed JSON, missing status, a bare explain command, install or
advisory mismatch, incomplete chain, unknown manifest fields, and caller-supplied reachability.

Implement the capture executable to spawn, without a shell, exactly:

```text
npm audit --json
npm audit --omit=dev --json
npm --prefix web/apps/aquamobil audit --json
npm --prefix web/apps/aquamobil audit --omit=dev --json
```

For each command, preserve argv, `cwd`, exit status, stdout SHA-256, parsed canonical document, and
whether exit `1` is explained solely by reported advisories; status `>1`, signal termination,
missing output, or an exit/metadata disagreement is fatal. Parse the four documents, sort unique
high/critical package names per installation, and invoke locked npm as
`npm [--prefix <install>] explain <package> --json`, one explicit package per call. Write canonical
audit/explain sets atomically below the requested ignored artifact root.

Extend the mapper to accept only the canonical audit/explain sets, both named lock files, and a
closed `AquaMobilBundleModuleManifest`; derive every reachability classification from those inputs.
Direct `esbuild` remains separately reachable release-build tooling; its appearance-IIFE graph is
never whole-browser evidence. AquaMobil browser reachability is true only when a package resolves
through a real emitted Vite/Rollup chunk.

```bash
node --test scripts/ci/capture-aquamobil-v4-audit-inputs.spec.mjs \
  scripts/ci/audit-source-map.spec.mjs
```

Expected GREEN: canonical audit/explain and mapping fixtures pass byte-for-byte; every missing,
ambiguous, operationally failed, incomplete, or manually asserted input fails. Review this bite
before continuing.

Fixed mapper fixtures require complete root-to-package chains, both lock authorities,
production-lock runtime classification, and release-build classification for executable tools
including direct `esbuild`. Direct esbuild remains separately reachable release-build tooling; its
appearance-IIFE graph is never treated as whole-browser evidence. AquaMobil browser reachability is
true only when the package resolves through the real production Vite/Rollup module manifest to an
emitted chunk. Output is sorted and contains no current timestamp, absolute path, URL query, or
manually supplied reachability.

- [ ] **Step 10: Produce a closed manifest from two real production builds**

**Files:** `tools/aquamobil-v4/contracts.mjs`, `tools/aquamobil-v4/contracts.spec.mjs`,
`web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts`, `web/apps/aquamobil/vite.config.ts`, and
`tests/invariants/aquamobil-audit-module-manifest.spec.ts`.

```bash
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-audit-module-manifest.spec.ts
node --test \
  --test-name-pattern='bootstrap index is exact, isolated, and tree-bound' \
  tools/aquamobil-v4/contracts.spec.mjs
```

Expected RED: both commands FAIL because the producer and bootstrap-index modes do not exist.
The focused contracts fixtures exercise `--populate-and-verify-bootstrap-index` and
`--verify-bootstrap-bundle-manifest`, including a nonexistent temp-index path, exact Task 1 path
population, unchanged real index, final format-scope inclusion, worktree/blob equality, and safe
crash cleanup. They also reject an absent or stale `docs/aria/CURRENT_STATE.md`, generation after
scratch-index verification, and any final pre-commit hook run that newly stages the authority
file. Fixtures pin the exact closed
`AquaMobilBundleModuleManifest` schema, production mode, source commit/tree or bootstrap index/tree,
config/plugin/standalone-lock Git blobs, sorted chunks and module IDs, and the finite normalization
set for Vite virtual prefixes and query suffixes. Unknown fields, dirty or non-production input,
outside-repository paths, absolute paths, URLs, timestamps, unrecognized query wrappers,
nondeterministic order, source/generator blob mismatch, mutation of the real index, an unowned dirty
path, a missing intended Order 0 path, or worktree bytes unequal to the scratch index fail.

Implement a Vite plugin that is a no-op unless `AQUAMOBIL_AUDIT_MODULE_MANIFEST` names a
repo-relative path below ignored `artifacts/`. During the real production build's `generateBundle`,
write deterministic sorted emitted chunks and deduplicated `chunk.modules` IDs. Strip only the
explicitly enumerated Vite virtual/query wrappers before repo-relative POSIX normalization. Bind the
manifest to source commit/tree. Bootstrap uses the exact scratch-index tree described below and
reads the config/plugin/standalone-lock blobs from that tree; committed runs use their checked-out
commit tree. Never emit the evidence into `dist`.

Order 0's plugin and config are necessarily uncommitted here, so a normal dirty-input rejection
cannot bind them to `HEAD`. Do not stage them early. Create a private scratch index from the base
tree, add exactly Task 1's intended Order 0 paths there, verify the real index remains the base tree,
and prove each intended worktree file equals its temp-index blob with no unowned dirt. The
`--populate-and-verify-bootstrap-index` mode has fixture-pinned exact path equality with Task 1's
`Files` list; it cannot accept a caller-supplied path waiver.

Run two real production builds against that same scratch tree:

```bash
set -euo pipefail
npm run aria:authority-hash:write
ORDER0_CURRENT_STATE_SHA256="$(sha256sum docs/aria/CURRENT_STATE.md | cut -d' ' -f1)"
[[ "$ORDER0_CURRENT_STATE_SHA256" =~ ^[0-9a-f]{64}$ ]]
grep -Eq '[0-9a-f]{64}' docs/aria/CURRENT_STATE.md
npm run quality:format-scope:generate
npm run quality:format-scope:check
git diff --check -- tools/quality/format-scope.json
ORDER0_BASE_MAIN_COMMIT="$(jq -er '.order0BaseMainCommit | select(test("^[0-9a-f]{40}$"))' \
  docs/superpowers/evidence/aquamobil-v4/source-commits.json)"
test "$(git rev-parse HEAD)" = "$ORDER0_BASE_MAIN_COMMIT"
REAL_INDEX_PATH="$(git rev-parse --path-format=absolute --git-path index)"
REAL_INDEX_TREE="$(git write-tree)"
test "$REAL_INDEX_TREE" = "$(git rev-parse "$ORDER0_BASE_MAIN_COMMIT^{tree}")"
REAL_INDEX_SHA256="$(sha256sum "$REAL_INDEX_PATH" | cut -d' ' -f1)"
PROGRAM_GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
BOOTSTRAP_INDEX_DIR="$(mktemp -d \
  "$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-order0-index.XXXXXXXX")"
BOOTSTRAP_INDEX_DIR="$(realpath -e -- "$BOOTSTRAP_INDEX_DIR")"
[[ "$BOOTSTRAP_INDEX_DIR" == \
  /var/aqua-saas/.git/aquamobil-v4-order0-index.* ]]
test ! -L "$BOOTSTRAP_INDEX_DIR"
BOOTSTRAP_GIT_INDEX="$BOOTSTRAP_INDEX_DIR/index"
test ! -e "$BOOTSTRAP_GIT_INDEX"
cleanup_bootstrap_index() {
  bootstrap_cleanup_real="$(realpath -e -- "$BOOTSTRAP_INDEX_DIR")"
  test "$bootstrap_cleanup_real" = "$BOOTSTRAP_INDEX_DIR"
  [[ "$bootstrap_cleanup_real" == \
    /var/aqua-saas/.git/aquamobil-v4-order0-index.* ]]
  test ! -L "$bootstrap_cleanup_real"
  if test -e "$BOOTSTRAP_GIT_INDEX"; then
    test ! -L "$BOOTSTRAP_GIT_INDEX"
    rm -f -- "$BOOTSTRAP_GIT_INDEX"
  fi
  rmdir -- "$bootstrap_cleanup_real"
}
trap cleanup_bootstrap_index EXIT
GIT_INDEX_FILE="$BOOTSTRAP_GIT_INDEX" git read-tree "$ORDER0_BASE_MAIN_COMMIT^{tree}"
GIT_INDEX_FILE="$BOOTSTRAP_GIT_INDEX" \
  node tools/aquamobil-v4/contracts.mjs \
  --bootstrap-authoring \
  --populate-and-verify-bootstrap-index \
  --program-plan docs/superpowers/plans/2026-08-26-aquamobil-v4-safe-integration-program.md \
  --task-number 1 \
  --base "$ORDER0_BASE_MAIN_COMMIT"
BOOTSTRAP_INDEX_TREE="$(GIT_INDEX_FILE="$BOOTSTRAP_GIT_INDEX" git write-tree)"
[[ "$BOOTSTRAP_INDEX_TREE" =~ ^[0-9a-f]{40}$ ]]
test "$BOOTSTRAP_INDEX_TREE" != "$REAL_INDEX_TREE"
test "$(git write-tree)" = "$REAL_INDEX_TREE"
test "$(sha256sum "$REAL_INDEX_PATH" | cut -d' ' -f1)" = "$REAL_INDEX_SHA256"
rm -rf artifacts/aquamobil-v4/bootstrap/build-a \
  artifacts/aquamobil-v4/bootstrap/build-b
GIT_INDEX_FILE="$BOOTSTRAP_GIT_INDEX" \
  AQUAMOBIL_BUNDLE_SOURCE_KIND=bootstrap-index \
  AQUAMOBIL_BUNDLE_SOURCE_BASE="$ORDER0_BASE_MAIN_COMMIT" \
  AQUAMOBIL_BUNDLE_SOURCE_TREE="$BOOTSTRAP_INDEX_TREE" \
  AQUAMOBIL_AUDIT_MODULE_MANIFEST=artifacts/aquamobil-v4/bootstrap/build-a/modules.json \
  npm --prefix web/apps/aquamobil run build
GIT_INDEX_FILE="$BOOTSTRAP_GIT_INDEX" \
  AQUAMOBIL_BUNDLE_SOURCE_KIND=bootstrap-index \
  AQUAMOBIL_BUNDLE_SOURCE_BASE="$ORDER0_BASE_MAIN_COMMIT" \
  AQUAMOBIL_BUNDLE_SOURCE_TREE="$BOOTSTRAP_INDEX_TREE" \
  AQUAMOBIL_AUDIT_MODULE_MANIFEST=artifacts/aquamobil-v4/bootstrap/build-b/modules.json \
  npm --prefix web/apps/aquamobil run build
cmp artifacts/aquamobil-v4/bootstrap/build-a/modules.json \
  artifacts/aquamobil-v4/bootstrap/build-b/modules.json
node tools/aquamobil-v4/contracts.mjs \
  --bootstrap-authoring \
  --verify-bootstrap-bundle-manifest \
  --scratch-index "$BOOTSTRAP_GIT_INDEX" \
  --expected-tree "$BOOTSTRAP_INDEX_TREE" \
  --manifest artifacts/aquamobil-v4/bootstrap/build-a/modules.json
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-audit-module-manifest.spec.ts
test "$(git write-tree)" = "$REAL_INDEX_TREE"
test "$(sha256sum "$REAL_INDEX_PATH" | cut -d' ' -f1)" = "$REAL_INDEX_SHA256"
test "$(sha256sum docs/aria/CURRENT_STATE.md | cut -d' ' -f1)" = \
  "$ORDER0_CURRENT_STATE_SHA256"
cleanup_bootstrap_index
trap - EXIT
test ! -e "$BOOTSTRAP_INDEX_DIR"
```

Expected GREEN: both full production builds succeed, their manifests are byte-identical, the
fixture's imported browser dependency appears in an emitted chunk, its unbundled dependency does
not, and all closed-schema negatives pass. Copy the identical manifest to
`artifacts/aquamobil-v4/bootstrap/aquamobil-vite-rollup-modules.json`. Review this bite before
continuing.

Expected GREEN: both focused suites pass, both manifests are byte-identical, the temp index begins
nonexistent under a validated Git common-dir child, includes every and only intended Order 0 tracked
path (including the already-final format scope), and the real index is byte- and tree-identical
before and after. The ignored bundle manifest is evidence about the temp tree and is never added to
that tree. Empty pre-created index files, symlinked temp paths, unowned dirt, missing intended paths,
real-index mutation, manifest/tree drift, and unsafe EXIT cleanup all fail.

- [ ] **Step 11: Capture the bootstrap audit graph and make the complete Order 0 suite green**

```json
"aquamobil:v4:contracts:test": "node --test tools/aquamobil-v4/contracts.spec.mjs tools/aquamobil-v4/verify-ledger.spec.mjs tools/aquamobil-v4/capture-github-evidence.spec.mjs tools/aquamobil-v4/capture-slice-audit.spec.mjs tools/aquamobil-v4/reconcile-ledger.spec.mjs tools/aquamobil-v4/worktree.spec.mjs scripts/ci/capture-aquamobil-v4-audit-inputs.spec.mjs scripts/ci/audit-source-map.spec.mjs",
"aquamobil:v4:ci:provenance:check": "node tools/aquamobil-v4/verify-ledger.mjs --ci-attested --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json"
```

The first command is test-only. The second is checkout-local and refuses to run outside an exact
GitHub Actions event/ref/run/attempt contract; it emits a discriminated PR or non-PR workflow
attestation and never claims to be a valid local coordinator. There is no relative local provenance
or reconcile package command. Human/agent local commands after bootstrap always name the clean
detached coordinator executable by absolute path.

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
PROGRAM_PR_NUMBER="$verification_pr_number"
PROGRAM_PR_KIND=feeding-auxiliary-verification
PROGRAM_EXPECTED_HEAD=chore/aquamobil-v4-feeding-foundation-verification
: "${PROGRAM_REVIEWER_OUTPUT:?set independent agent canonical report output path}"
# Run the exact generation-aware review-input -> report -> authorization -> prospective block above.
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" retain-after-postmerge --verification feeding-foundation --repository Okan-wqm/aquaculture_platform --main-ref origin/main
```

`slice-branches.json` stores every literal branch/rank/dependency above, exact detailed-plan task
numbers, each ordered `implementationBoundaryIds` array, its one-to-one protected branch/worktree
mapping, the singleton auxiliary `verificationWorktrees` registry, and all five closure definitions.
Its closed `programPrWorktrees` registry additionally pins
`closeout-terminal-evidence` to `chore/aquamobil-v4-terminal-evidence` and
`/var/aqua-saas/.worktrees/aquamobil-v4-terminal-evidence`; pins closeout tooling/report/archive/
receipt respectively to the rank 13/15/16/17 branches above and their same-slug absolute worktrees;
and pins every slice/closure reconciliation to the coordinator-derived
`chore/aquamobil-v4-reconcile-<registered-slice-slug>` or
`chore/aquamobil-v4-closure-<registered-closure-name>` branch and matching absolute worktree.
Each entry has a closed path allowlist: the immediately previous generic `program-prs/pr-<N>.json`
plus only that PR kind's named evidence outputs and generated format scope. Bootstrap and
feeding-auxiliary-verification have their separately enumerated allowlists. A PR kind, branch,
worktree, or changed path that crosses entries fails before review input is emitted.
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
the same singleton entry. `retain-after-postmerge --verification feeding-foundation` resolves exactly
one merged protected PR with that configured head, verifies its full remote/spool result, and leaves
the clean worktree in place. The following closure-reconciliation merge must carry that auxiliary
PR's full numeric record before exact `cleanup-program-pr` may remove its worktree, remote branch,
and verified generation. Every mode is self-bound to the clean detached coordinator executable.
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
mkdir -p artifacts/aquamobil-v4/bootstrap
node scripts/ci/capture-aquamobil-v4-audit-inputs.mjs \
  --bootstrap-authoring \
  --output-root artifacts/aquamobil-v4/bootstrap
cp artifacts/aquamobil-v4/bootstrap/build-a/modules.json \
  artifacts/aquamobil-v4/bootstrap/aquamobil-vite-rollup-modules.json
node scripts/ci/audit-source-map.mjs \
  --bootstrap-authoring \
  --audit-set-json artifacts/aquamobil-v4/bootstrap/audit-set.json \
  --explain-set-json artifacts/aquamobil-v4/bootstrap/npm-explain-set.json \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest artifacts/aquamobil-v4/bootstrap/aquamobil-vite-rollup-modules.json \
  --output-json artifacts/aquamobil-v4/bootstrap/dependency-reachability.json \
  --output-markdown artifacts/aquamobil-v4/bootstrap/dependency-reachability.md
npm run aquamobil:v4:contracts:test
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath \
  tests/invariants/aquamobil-audit-module-manifest.spec.ts \
  tests/invariants/aquamobil-v4-required-workflow-evidence.spec.ts
node tools/aquamobil-v4/verify-ledger.mjs \
  --bootstrap-authoring \
  --verify-bootstrap-artifacts \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --audit-input-root artifacts/aquamobil-v4/bootstrap \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2
```

Expected GREEN: all focused tests and both invariants pass; all four audit invocations have a
recorded advisory-valid operational status; every high/critical package has its explicit explain
chain; the two production manifests are byte-identical and closed-schema valid; the mapper derives
all reachability; and bootstrap validation reports
`35 history objects = 33 non-merge rows + 2 planned merge-resolution records`. The ignored capture
root is not staged.

- [ ] **Step 12: Commit, push, independently review, authorize, and merge Order 0**

```bash
set -Eeuo pipefail
ORDER0_VERIFY_WORKTREE=''
cleanup_order0_verify_worktree() {
  if test -z "$ORDER0_VERIFY_WORKTREE"; then
    return 0
  fi
  case "$ORDER0_VERIFY_WORKTREE" in
    /var/aqua-saas/.worktrees/aquamobil-v4-order0-staged.*) ;;
    *) return 1 ;;
  esac
  test "$ORDER0_VERIFY_WORKTREE" != /var/aqua-saas
  test "$ORDER0_VERIFY_WORKTREE" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-safe-integration
  test "$ORDER0_VERIFY_WORKTREE" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-coordinator
  test "$ORDER0_VERIFY_WORKTREE" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-terminal-evidence
  test "$ORDER0_VERIFY_WORKTREE" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-redesign
  if git -C /var/aqua-saas worktree list --porcelain | awk \
    -v target="$ORDER0_VERIFY_WORKTREE" \
    '$1 == "worktree" && $2 == target { found = 1 } END { exit(found ? 0 : 1) }'; then
    git -C /var/aqua-saas worktree remove --force -- "$ORDER0_VERIFY_WORKTREE"
  elif test -e "$ORDER0_VERIFY_WORKTREE"; then
    rmdir -- "$ORDER0_VERIFY_WORKTREE"
  fi
}
trap cleanup_order0_verify_worktree EXIT
npm run aria:authority-hash -- --check
ORDER0_CURRENT_STATE_SHA256="$(sha256sum docs/aria/CURRENT_STATE.md | cut -d' ' -f1)"
[[ "$ORDER0_CURRENT_STATE_SHA256" =~ ^[0-9a-f]{64}$ ]]
npx prettier --check \
  docs/superpowers/evidence/aquamobil-v4 \
  tools/aquamobil-v4 \
  scripts/ci/capture-aquamobil-v4-audit-inputs.mjs \
  scripts/ci/capture-aquamobil-v4-audit-inputs.spec.mjs \
  web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts \
  web/apps/aquamobil/vite.config.ts \
  tests/invariants/aquamobil-audit-module-manifest.spec.ts \
  tests/invariants/aquamobil-v4-required-workflow-evidence.spec.ts \
  scripts/ci/audit-source-map.mjs \
  scripts/ci/audit-source-map.spec.mjs \
  .github/workflows/ci-affected.yml \
  .github/workflows/ci-full.yml \
  .github/workflows/aria-merge-authority.yml \
  .github/manifests/main-required-status-checks.json \
  docs/aria/CURRENT_STATE.md \
  package.json
git diff --check
git add -- \
  docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  docs/superpowers/evidence/aquamobil-v4/slice-branches.json \
  tools/aquamobil-v4/contracts.mjs \
  tools/aquamobil-v4/contracts.spec.mjs \
  tools/aquamobil-v4/verify-ledger.mjs \
  tools/aquamobil-v4/verify-ledger.spec.mjs \
  tools/aquamobil-v4/capture-github-evidence.mjs \
  tools/aquamobil-v4/capture-github-evidence.spec.mjs \
  tools/aquamobil-v4/capture-slice-audit.mjs \
  tools/aquamobil-v4/capture-slice-audit.spec.mjs \
  tools/aquamobil-v4/reconcile-ledger.mjs \
  tools/aquamobil-v4/reconcile-ledger.spec.mjs \
  tools/aquamobil-v4/worktree.mjs \
  tools/aquamobil-v4/worktree.spec.mjs \
  scripts/ci/capture-aquamobil-v4-audit-inputs.mjs \
  scripts/ci/capture-aquamobil-v4-audit-inputs.spec.mjs \
  web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts \
  web/apps/aquamobil/vite.config.ts \
  tests/invariants/aquamobil-audit-module-manifest.spec.ts \
  tests/invariants/aquamobil-v4-required-workflow-evidence.spec.ts \
  scripts/ci/audit-source-map.mjs \
  scripts/ci/audit-source-map.spec.mjs \
  .github/workflows/ci-affected.yml \
  .github/workflows/ci-full.yml \
  .github/workflows/aria-merge-authority.yml \
  .github/manifests/main-required-status-checks.json \
  docs/aria/CURRENT_STATE.md \
  tools/quality/format-scope.json \
  package.json
npm run quality:format-scope:check
test "$(sha256sum docs/aria/CURRENT_STATE.md | cut -d' ' -f1)" = \
  "$ORDER0_CURRENT_STATE_SHA256"
git diff --cached --check
ORDER0_BASE_MAIN_COMMIT="$(jq -er '.order0BaseMainCommit | select(test("^[0-9a-f]{40}$"))' \
  docs/superpowers/evidence/aquamobil-v4/source-commits.json)"
mapfile -d '' -t ORDER0_STAGED_FILES < <(git diff --cached --name-only -z)
test "${#ORDER0_STAGED_FILES[@]}" -gt 0
ORDER0_STAGED_TREE="$(git write-tree)"
[[ "$ORDER0_STAGED_TREE" =~ ^[0-9a-f]{40}$ ]]
ORDER0_MANIFEST_TREE="$(jq -er \
  '.source | select(.kind == "bootstrap-index") | .tree | select(test("^[0-9a-f]{40}$"))' \
  artifacts/aquamobil-v4/bootstrap/aquamobil-vite-rollup-modules.json)"
test "$ORDER0_STAGED_TREE" = "$ORDER0_MANIFEST_TREE"
ORDER0_STAGED_COMMIT="$(printf '%s\n' 'Order 0 staged verification snapshot' | \
  git commit-tree "$ORDER0_STAGED_TREE" -p "$ORDER0_BASE_MAIN_COMMIT")"
[[ "$ORDER0_STAGED_COMMIT" =~ ^[0-9a-f]{40}$ ]]
mapfile -d '' -t ORDER0_SNAPSHOT_FILES < <(
  git diff --name-only -z "$ORDER0_BASE_MAIN_COMMIT" "$ORDER0_STAGED_COMMIT"
)
test "${#ORDER0_STAGED_FILES[@]}" -eq "${#ORDER0_SNAPSHOT_FILES[@]}"
for staged_index in "${!ORDER0_STAGED_FILES[@]}"; do
  test "${ORDER0_STAGED_FILES[$staged_index]}" = \
    "${ORDER0_SNAPSHOT_FILES[$staged_index]}"
done
ORDER0_VERIFY_WORKTREE="$(mktemp -d \
  /var/aqua-saas/.worktrees/aquamobil-v4-order0-staged.XXXXXXXX)"
test -n "$ORDER0_VERIFY_WORKTREE"
[[ "$ORDER0_VERIFY_WORKTREE" == \
  /var/aqua-saas/.worktrees/aquamobil-v4-order0-staged.* ]]
rmdir "$ORDER0_VERIFY_WORKTREE"
git -C /var/aqua-saas worktree add --detach \
  "$ORDER0_VERIFY_WORKTREE" "$ORDER0_STAGED_COMMIT"
test "$(git -C "$ORDER0_VERIFY_WORKTREE" rev-parse HEAD)" = "$ORDER0_STAGED_COMMIT"
ROOT_LOCK_SHA256="$(sha256sum "$ORDER0_VERIFY_WORKTREE/package-lock.json" | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum \
  "$ORDER0_VERIFY_WORKTREE/web/apps/aquamobil/package-lock.json" | cut -d' ' -f1)"
npm --prefix "$ORDER0_VERIFY_WORKTREE" ci --ignore-scripts --no-audit
npm --prefix "$ORDER0_VERIFY_WORKTREE/web/apps/aquamobil" ci --ignore-scripts --no-audit
test "$(sha256sum "$ORDER0_VERIFY_WORKTREE/package-lock.json" | cut -d' ' -f1)" = \
  "$ROOT_LOCK_SHA256"
test "$(sha256sum \
  "$ORDER0_VERIFY_WORKTREE/web/apps/aquamobil/package-lock.json" | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
cd "$ORDER0_VERIFY_WORKTREE"
npx nx affected --target=test \
  --base="$ORDER0_BASE_MAIN_COMMIT" --head="$ORDER0_STAGED_COMMIT" --skip-nx-cache
npx nx affected --target=lint \
  --base="$ORDER0_BASE_MAIN_COMMIT" --head="$ORDER0_STAGED_COMMIT" --skip-nx-cache
test -z "$(git status --porcelain)"
cd /var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas worktree remove "$ORDER0_VERIFY_WORKTREE"
test ! -e "$ORDER0_VERIFY_WORKTREE"
ORDER0_VERIFY_WORKTREE=''
trap - EXIT
test "$(git write-tree)" = "$ORDER0_STAGED_TREE"
git diff --cached --check
ORDER0_PRECOMMIT_TREE="$(git write-tree)"
ORDER0_PRECOMMIT_CURRENT_STATE_BLOB="$(git rev-parse :docs/aria/CURRENT_STATE.md)"
[[ "$ORDER0_PRECOMMIT_CURRENT_STATE_BLOB" =~ ^[0-9a-f]{40}$ ]]
.husky/pre-commit
test "$(git write-tree)" = "$ORDER0_PRECOMMIT_TREE"
test "$(git rev-parse :docs/aria/CURRENT_STATE.md)" = \
  "$ORDER0_PRECOMMIT_CURRENT_STATE_BLOB"
test "$(sha256sum docs/aria/CURRENT_STATE.md | cut -d' ' -f1)" = \
  "$ORDER0_CURRENT_STATE_SHA256"
mapfile -d '' -t ORDER0_POSTHOOK_STAGED_FILES < <(git diff --cached --name-only -z)
test "${#ORDER0_POSTHOOK_STAGED_FILES[@]}" -eq "${#ORDER0_STAGED_FILES[@]}"
for staged_index in "${!ORDER0_STAGED_FILES[@]}"; do
  test "${ORDER0_POSTHOOK_STAGED_FILES[$staged_index]}" = \
    "${ORDER0_STAGED_FILES[$staged_index]}"
done
git commit -m "chore(aquamobil): establish v4 integration evidence" \
  -m "Freeze all 35 source objects and make ownership, GitHub provenance, dependency reachability, and protected-main reconciliation machine-verifiable before implementation."
test "$(git rev-parse 'HEAD^{tree}')" = "$ORDER0_STAGED_TREE"
git push --set-upstream origin chore/aquamobil-v4-program-bootstrap
bootstrap_pr_url="$(gh pr create \
  --base main \
  --head chore/aquamobil-v4-program-bootstrap \
  --title "chore(aquamobil): establish v4 integration evidence" \
  --body "Freezes the 35-object history and installs the reviewed evidence boundary required before implementation.")"
bootstrap_pr_number="$(gh pr view "$bootstrap_pr_url" --json number --jq '.number')"
gh pr checks "$bootstrap_pr_number" --watch --fail-fast
gh pr view "$bootstrap_pr_number" \
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-program-bootstrap" and (.headRefOid | test("^[0-9a-f]{40}$")))'
mkdir -p artifacts/aquamobil-v4/reviews
PROGRAM_GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
ORDER0_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$bootstrap_pr_number"
ORDER0_PR_GENERATION="$(node tools/aquamobil-v4/capture-github-evidence.mjs \
  --bootstrap-order0-pr \
  --initialize-program-pr-spool "$ORDER0_PR_ROOT" \
  --write-independent-review-input \
  --pull-request "$bootstrap_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --expected-head chore/aquamobil-v4-program-bootstrap \
  --verify-base-advance \
  --require-current-pr-test-merge-candidate \
  --print-program-pr-generation)"
[[ "$ORDER0_PR_GENERATION" == "$ORDER0_PR_ROOT"/generations/* ]]
ORDER0_GENERATION_DIGEST="${ORDER0_PR_GENERATION##*/}"
[[ "$ORDER0_GENERATION_DIGEST" =~ ^[0-9a-f]{64}$ ]]
```

Fresh-shell failure-injection fixtures wrap `git`, `npm`, `npx`, `.husky/pre-commit`, and `gh` with
sentinel executables. They fail each of the authority check, authority blob/digest assertion,
formatting check, staged-path comparison, staged-tree/manifest-tree comparison, scratch-worktree
creation, `cd`, Nx test, Nx lint, hook, post-hook path/tree assertion, and committed-tree assertion
in turn. Every injected failure must leave the real index byte/tree unchanged, invoke the
exact-target EXIT cleanup when the scratch worktree exists, and prove that `git commit`,
`git push`, `gh pr create`, review-input publication, and authorization-comment publication were
never reached. Mutating the authority pin or replacing the final checker with the print-only command
is an explicit negative fixture.

Stop here for an independent agent. The reviewer reads the complete staged snapshot and canonical
`$ORDER0_PR_GENERATION/review/review-input.json`, then writes
`artifacts/aquamobil-v4/reviews/order0-independent-review.json` using exactly
`ProgramIndependentReviewReport`. A non-empty finding or non-approved verdict returns to Step 2;
after any commit or base/candidate change, discard the report and recapture. The reviewer must not be
the PR author or the operator granting authorization. That ignored artifacts path is only an
ephemeral reviewer-to-ingest handoff and is never evidence authority; successful ingest publishes
the canonical full report into the immutable generation, and the full remote authorization payload
is the restart-recovery authority.

After reading that report, the `Okan-wqm` administrator explicitly authorizes this exact lineage by
posting the tool-rendered issue comment. Posting this comment and merging remain separate explicit
operator actions:

```bash
PROGRAM_REVIEW_REPORT=artifacts/aquamobil-v4/reviews/order0-independent-review.json
node tools/aquamobil-v4/capture-github-evidence.mjs \
  --bootstrap-order0-pr \
  --ingest-independent-review-report "$PROGRAM_REVIEW_REPORT" \
  --program-pr-generation "$ORDER0_PR_GENERATION"
node tools/aquamobil-v4/capture-github-evidence.mjs \
  --bootstrap-order0-pr \
  --write-authorization-comment-envelope \
  --program-pr-generation "$ORDER0_PR_GENERATION"
gh pr comment "$bootstrap_pr_number" --repo Okan-wqm/aquaculture_platform \
  --body-file "$ORDER0_PR_GENERATION/authorization/authorization-comment-envelope.md"
node tools/aquamobil-v4/capture-github-evidence.mjs \
  --bootstrap-order0-pr \
  --verify-prospective-program-pr "$bootstrap_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind bootstrap \
  --expected-head chore/aquamobil-v4-program-bootstrap \
  --verify-base-advance \
  --require-current-pr-test-merge-candidate \
  --program-pr-generation "$ORDER0_PR_GENERATION" \
  --write-prospective-spool
```

Expected: the verifier proves the current `N/B/H/C/T/[B,H]`, four exact required contexts, three
mandatory artifacts with distinct producer tuples, full independent report, check/artifact-set
SHA-256, and exactly one matching current administrator payload. It rereads
PR/ref/check/artifact/comment/permission state after capture and durably stores the full bundle.
There is intentionally no GitHub review-state predicate. Merge only after a fresh explicit operator
decision and only through the protected workflow. Then:

```bash
repo_root=/var/aqua-saas
program_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C "$repo_root" fetch origin +refs/heads/main:refs/remotes/origin/main
mapfile -t bootstrap_pr_numbers < <(node \
  "$program_worktree/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform \
  --state merged --base main --head chore/aquamobil-v4-program-bootstrap | \
  jq -r '.[] | select(.title == "chore(aquamobil): establish v4 integration evidence") | .number')
test "${#bootstrap_pr_numbers[@]}" -eq 1
BOOTSTRAP_PR_NUMBER="${bootstrap_pr_numbers[0]}"
bootstrap_main_sha="$(gh pr view "$BOOTSTRAP_PR_NUMBER" --json state,mergedAt,mergeCommit \
  --jq 'select(.state == "MERGED" and .mergedAt != null) | .mergeCommit.oid')"
[[ "$bootstrap_main_sha" =~ ^[0-9a-f]{40}$ ]]
git -C "$repo_root" merge-base --is-ancestor "$bootstrap_main_sha" origin/main
test "$(git -C "$repo_root" show origin/main:docs/superpowers/evidence/aquamobil-v4/source-commits.json | jq '.objects | length')" -eq 35
test -z "$(git -C "$program_worktree" status --porcelain)"
test "$program_worktree" = "/var/aqua-saas/.worktrees/aquamobil-v4-coordinator"
test "$program_worktree" != "$repo_root"
git -C "$program_worktree" switch --detach origin/main
test "$(git -C "$program_worktree" rev-parse HEAD)" = \
  "$(git -C "$repo_root" rev-parse origin/main)"
cd "$program_worktree"
test -z "$(git status --porcelain)"
PROGRAM_GIT_COMMON_DIR="$(git -C "$repo_root" \
  rev-parse --path-format=absolute --git-common-dir)"
ORDER0_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$BOOTSTRAP_PR_NUMBER"
ORDER0_PR_GENERATION="$(node \
  "$program_worktree/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$ORDER0_PR_ROOT" \
  --pull-request "$BOOTSTRAP_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind bootstrap \
  --from-current-authorization-comment)"
[[ "$ORDER0_PR_GENERATION" == "$ORDER0_PR_ROOT"/generations/* ]]
ORDER0_GENERATION_DIGEST="${ORDER0_PR_GENERATION##*/}"
[[ "$ORDER0_GENERATION_DIGEST" =~ ^[0-9a-f]{64}$ ]]
node "$program_worktree/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --reconcile-program-pr "$BOOTSTRAP_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind bootstrap \
  --resulting-main "$bootstrap_main_sha" \
  --program-pr-generation "$ORDER0_PR_GENERATION" \
  --write-postmerge-spool
ORDER0_POSTMERGE_COMMENT_ACTION="$(node \
  "$program_worktree/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --write-postmerge-recovery-comment-envelope \
  --select-canonical-postmerge-recovery-comment \
  --pull-request "$BOOTSTRAP_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --program-pr-generation "$ORDER0_PR_GENERATION" \
  --print-postmerge-comment-action)"
case "$ORDER0_POSTMERGE_COMMENT_ACTION" in
  post)
    gh pr comment "$BOOTSTRAP_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
      --body-file "$ORDER0_PR_GENERATION/postmerge/postmerge-comment-envelope.md"
    ;;
  reuse-lowest-id)
    :
    ;;
  *)
    exit 1
    ;;
esac
node "$program_worktree/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --verify-postmerge-recovery-comment \
  --program-pr-generation "$ORDER0_PR_GENERATION" \
  --recover-spool-from-github-if-missing \
  --require-result-tree-equals-candidate-tree
node "$program_worktree/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --require-program-pr-evidence \
  "$ORDER0_PR_GENERATION/postmerge/program-pr-evidence.json" \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2
```

Expected: Order 0 is a protected-main ancestor; its result tree equals the prospectively tested
candidate tree; and the durable `postmerge/program-pr-evidence.json` embeds the full report,
authorization payload and attestation, three workflow artifacts, four checks, and every
permission/comment/PR/API digest. The
full recovery payload round-trips through GitHub and can reconstruct an absent local spool without
digest inversion. The next generic PR materializes this verified record into the append-only
`program-prs/pr-<N>.json` chain; the I1 preflight verifies it remotely but does not stage a premature
chain record. The clean detached
coordinator remains the only local orchestration tool source until final closeout cleanup. I1 cannot
start if this post-merge pass fails.

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

- Consumes: Order 0's verified full `ProgramPrEvidence`, recovered from its exact common-dir
  generation or canonical GitHub post-merge comment, current main, exact plan/task mapping,
  migration manifests, dependency graphs,
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
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create \
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
node "$COORDINATOR_WORKTREE/scripts/ci/capture-aquamobil-v4-audit-inputs.mjs" \
  --output-root artifacts/aquamobil-v4/I1
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --audit-set-json artifacts/aquamobil-v4/I1/audit-set.json \
  --explain-set-json artifacts/aquamobil-v4/I1/npm-explain-set.json \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest artifacts/aquamobil-v4/I1/aquamobil-vite-rollup-modules.json \
  --output-json artifacts/aquamobil-v4/I1/dependency-reachability.json \
  --output-markdown artifacts/aquamobil-v4/I1/dependency-reachability.md
BOOTSTRAP_PR_NUMBER="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-bootstrap-program-pr --repository Okan-wqm/aquaculture_platform --main-ref origin/main)"
[[ "$BOOTSTRAP_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas \
  rev-parse --path-format=absolute --git-common-dir)"
BOOTSTRAP_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$BOOTSTRAP_PR_NUMBER"
BOOTSTRAP_PROGRAM_PR_PATH="docs/superpowers/evidence/aquamobil-v4/program-prs/pr-$BOOTSTRAP_PR_NUMBER.json"
if git -C /var/aqua-saas cat-file -e "origin/main:$BOOTSTRAP_PROGRAM_PR_PATH" 2>/dev/null; then
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
    --check-program-pr-evidence-from-ref \
    "origin/main:$BOOTSTRAP_PROGRAM_PR_PATH" \
    --pull-request "$BOOTSTRAP_PR_NUMBER" \
    --repository Okan-wqm/aquaculture_platform
else
  BOOTSTRAP_PR_GENERATION="$(node \
    "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
    --resolve-program-pr-generation "$BOOTSTRAP_PR_ROOT" \
    --pull-request "$BOOTSTRAP_PR_NUMBER" \
    --repository Okan-wqm/aquaculture_platform \
    --pr-kind bootstrap \
    --from-postmerge-recovery-comment)"
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
    --check-program-pr-evidence \
    "$BOOTSTRAP_PR_GENERATION/postmerge/program-pr-evidence.json"
  git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
  git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
  if git -C /var/aqua-saas cat-file -e \
    "origin/main:$BOOTSTRAP_PROGRAM_PR_PATH" 2>/dev/null; then
    node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
      --check-program-pr-evidence-from-ref \
      "origin/main:$BOOTSTRAP_PROGRAM_PR_PATH" \
      --pull-request "$BOOTSTRAP_PR_NUMBER" \
      --repository Okan-wqm/aquaculture_platform
    node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
      --delete-verified-program-pr-generation "$BOOTSTRAP_PR_GENERATION" \
      --pull-request "$BOOTSTRAP_PR_NUMBER" \
      --require-remote-postmerge-roundtrip \
      --require-main-reachable-durable-record \
      --allow-exact-generation-already-absent
    test ! -e "$BOOTSTRAP_PR_GENERATION"
  fi
fi
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice I1 \
  --main-ref origin/main \
  --source-ref origin/feature/aquamobil-v4-redesign \
  --artifact-root artifacts/aquamobil-v4/I1 \
  --write docs/superpowers/evidence/aquamobil-v4/slices/I1/preflight.json
```

If a rank-peer reconciliation has already made the full bootstrap record main-reachable and cleaned
its generation, I1 verifies that tracked authority directly and never recreates the spool. When the
first check does not see that record, recovery is followed by a second fetch and tracked-record
check. If the record appeared during the check/recovery window, I1 verifies it and immediately
deletes or confirms absent only that exact recovered generation; already-absent succeeds only with
the same remote postmerge round trip and current main-reachable full record. Otherwise the
existing/recovered generation remains covered by the first generic reconciliation's later exact
cleanup. Tests exercise both serial rank-peer orderings plus the interleaving `check absent -> first
generic merge and cleanup -> recover -> refetch present -> exact idempotent cleanup`; they reject a
recreated post-cleanup bootstrap generation, a stale second fetch, or already-absent success without
both durable authorities. A second interleaving fixture pauses normal first-generic cleanup after
authorization, lets I1 delete the exact generation, and then requires the normal shared cleanup's
bootstrap-only already-absent step to complete; non-bootstrap already-absent remains a failure.

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

Every first-boundary commit stages only its own `preflight.json` with test-first code. The first
slice-reconciliation generic PR later materializes the bootstrap record under its numeric PR path;
implementation branches never pre-empt that finite chain. Later boundaries consume their
main-reachable preflight unchanged. A PR invariant rejects `execution-ledger.json`,
`merge-resolutions.json`, any `merge.json`, closure record, another slice directory, or a later
rewrite of the preflight on an implementation branch.

- [ ] **Step 4: Capture each protected boundary post-merge record and retain its exact worktree**

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
BOUNDARY_BRANCH="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-branch \
  --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
BOUNDARY_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-path \
  --slice "$SLICE_ID" --boundary "$BOUNDARY_ID")"
[[ "$BOUNDARY_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-* ]]
test "$BOUNDARY_WORKTREE" != "/var/aqua-saas"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
mapfile -t boundary_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform \
  --state merged --base main --head "$BOUNDARY_BRANCH" | jq -r '.[].number')
test "${#boundary_pr_numbers[@]}" -eq 1
BOUNDARY_MAIN_SHA="$(gh pr view "${boundary_pr_numbers[0]}" --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$BOUNDARY_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$BOUNDARY_MAIN_SHA" origin/main
test -z "$(git -C "$BOUNDARY_WORKTREE" status --porcelain)"
PROGRAM_PR_NUMBER="${boundary_pr_numbers[0]}"
PROGRAM_PR_KIND=implementation-boundary
PROGRAM_EXPECTED_HEAD="$BOUNDARY_BRANCH"
```

With those exact values, execute the complete fresh-shell post-merge/recovery block above. Then mark
the registry entry `postmerge-verified-awaiting-reconciliation`; do not detach, remove the worktree,
delete its remote branch, or remove its verified generation yet. Slice reconciliation must embed the
full boundary recovery record and become main-reachable first. For F0/F1a, the next boundary
coordinator verifies the earlier protected merge and deployment evidence while each prior clean
worktree remains retained; `merge.json` is created only after boundary three.

---

### Task 3: Merge slices and reconcile protected-main evidence serially

**Files:**

- Create: one `merge.json` under each of the 16 exact slice directories from Task 2.
- Create: the scheduler-selected immediately preceding generic full record at
  `docs/superpowers/evidence/aquamobil-v4/program-prs/pr-<PREVIOUS_GENERIC_PR_NUMBER>.json`.
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
   evidence PR, and retain that exact worktree. Only then create the feeding finding-close branch and
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
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and (.headRefOid | test("^[0-9a-f]{40}$")))'
PROGRAM_PR_NUMBER="$implementation_pr_number"
PROGRAM_PR_KIND=implementation-boundary
PROGRAM_EXPECTED_HEAD="$(git branch --show-current)"
: "${PROGRAM_REVIEWER_OUTPUT:?set independent agent canonical report output path}"
```

With those literal values, execute the complete non-bootstrap generation-aware review-input →
independent report → rendered/admin-posted authorization → prospective block above verbatim. The
`implementation-boundary` registry alias additionally binds `SLICE_ID`, `boundary_id`, exact
branch/path allowlist, and required trailers; it cannot accept caller-supplied substitutions.

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
blobs; a planned-absence state or F1a-only predecessor set blocks review. The shared prospective
block resolves current `B/H/C` through GitHub, proves the preflight base is a main
ancestor, and hashes the canonical `baseMainCommit..reviewedBaseMainCommit` changed-path set. It
intersects that set with all exact `ownedPaths` plus authority paths from the preflight. A first
evaluation with overlap returns `resolution-required` and lists every path; it cannot attest the PR.
A zero-overlap run records `no-overlap`. For overlap, normally merge current protected main into the
branch, never rebase/force, and rerun this complete step only after the semantic diff, affected/full
slice gates, dependency audit, security gates, and a new independent report plus administrator
authorization comment after that merge are green. The tool then validates the recorded normal
merge's ordered parents, overlap inventory, new report/comment/API digests, and records
`merged-main-and-reauthorized`; never rewrite the immutable
preflight. Either resolved state still passes only when every required workflow artifact names the
same current candidate/base and hashes every checkout-local repository tool it executed: four
manifest-pinned contexts resolve to exactly the CI-Affected, CI Full, and ARIA run/attempt artifacts,
with the two CI-Affected contexts sharing only their one producer artifact.

- [ ] **Step 3: Capture the next post-merge record**

```bash
set -euo pipefail
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
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create-reconciliation \
  --slice "$reconcile_slice" \
  --main-ref origin/main
reconcile_slug="$(printf '%s' "$reconcile_slice" | tr '[:upper:]' '[:lower:]')"
reconcile_worktree="/var/aqua-saas/.worktrees/aquamobil-v4-reconcile-$reconcile_slug"
cd "$reconcile_worktree"
PROGRAM_PR_KIND=slice-reconciliation
PROGRAM_EXPECTED_HEAD="$(git branch --show-current)"
PREVIOUS_GENERIC_PR_NUMBER="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$PROGRAM_PR_KIND" \
  --expected-head "$PROGRAM_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$PREVIOUS_PROGRAM_PR_ROOT" \
  --pull-request "$PREVIOUS_GENERIC_PR_NUMBER" --repository Okan-wqm/aquaculture_platform \
  --from-postmerge-recovery-comment)"
[[ "$PREVIOUS_PROGRAM_PR_GENERATION" == "$PREVIOUS_PROGRAM_PR_ROOT"/generations/* ]]
[[ "${PREVIOUS_PROGRAM_PR_GENERATION##*/}" =~ ^[0-9a-f]{64}$ ]]
test -d "$PREVIOUS_PROGRAM_PR_GENERATION"
test ! -L "$PREVIOUS_PROGRAM_PR_GENERATION"
PREVIOUS_PROGRAM_PR_PATH="docs/superpowers/evidence/aquamobil-v4/program-prs/pr-$PREVIOUS_GENERIC_PR_NUMBER.json"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --materialize-previous-generic-program-pr \
  --program-pr-generation "$PREVIOUS_PROGRAM_PR_GENERATION" --write "$PREVIOUS_PROGRAM_PR_PATH"
test -f "$PREVIOUS_PROGRAM_PR_PATH"
test ! -L "$PREVIOUS_PROGRAM_PR_PATH"
PREVIOUS_PROGRAM_PR_SHA256="$(sha256sum "$PREVIOUS_PROGRAM_PR_PATH" | cut -d' ' -f1)"
[[ "$PREVIOUS_PROGRAM_PR_SHA256" =~ ^[0-9a-f]{64}$ ]]
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --verify-previous-generic-program-pr-in-candidate --path "$PREVIOUS_PROGRAM_PR_PATH" \
  --record-sha256 "$PREVIOUS_PROGRAM_PR_SHA256"
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

- [ ] **Step 4: Merge, persist recovery, and retain the reconciliation worktree**

```bash
set -euo pipefail
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
RECONCILE_SLICE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-active-reconciliation-slice)"
RECONCILE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-active-reconciliation-path)"
[[ "$RECONCILE_SLICE" =~ ^(I1|V0|V1|V2|V3|V4|V5|UI-convergence|F0|F1a|F2|F1b|F3|F4|F5|V6)$ ]]
[[ "$RECONCILE_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-reconcile-* ]]
cd "$RECONCILE_WORKTREE"
PROGRAM_PR_KIND=slice-reconciliation
PROGRAM_EXPECTED_HEAD="$(git branch --show-current)"
PREVIOUS_GENERIC_PR_NUMBER="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$PROGRAM_PR_KIND" \
  --expected-head "$PROGRAM_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$PREVIOUS_PROGRAM_PR_ROOT" \
  --pull-request "$PREVIOUS_GENERIC_PR_NUMBER" --repository Okan-wqm/aquaculture_platform \
  --from-postmerge-recovery-comment)"
[[ "$PREVIOUS_PROGRAM_PR_GENERATION" == "$PREVIOUS_PROGRAM_PR_ROOT"/generations/* ]]
[[ "${PREVIOUS_PROGRAM_PR_GENERATION##*/}" =~ ^[0-9a-f]{64}$ ]]
test -d "$PREVIOUS_PROGRAM_PR_GENERATION"
test ! -L "$PREVIOUS_PROGRAM_PR_GENERATION"
PREVIOUS_PROGRAM_PR_PATH="docs/superpowers/evidence/aquamobil-v4/program-prs/pr-$PREVIOUS_GENERIC_PR_NUMBER.json"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --materialize-previous-generic-program-pr \
  --program-pr-generation "$PREVIOUS_PROGRAM_PR_GENERATION" --write "$PREVIOUS_PROGRAM_PR_PATH"
test -f "$PREVIOUS_PROGRAM_PR_PATH"
test ! -L "$PREVIOUS_PROGRAM_PR_PATH"
PREVIOUS_PROGRAM_PR_SHA256="$(sha256sum "$PREVIOUS_PROGRAM_PR_PATH" | cut -d' ' -f1)"
[[ "$PREVIOUS_PROGRAM_PR_SHA256" =~ ^[0-9a-f]{64}$ ]]
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --verify-previous-generic-program-pr-in-candidate --path "$PREVIOUS_PROGRAM_PR_PATH" \
  --record-sha256 "$PREVIOUS_PROGRAM_PR_SHA256"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
git add -- \
  "docs/superpowers/evidence/aquamobil-v4/slices/$RECONCILE_SLICE/merge.json" \
  docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  "$PREVIOUS_PROGRAM_PR_PATH"
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
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and (.headRefOid | test("^[0-9a-f]{40}$")))'
RECONCILE_BRANCH="$(git branch --show-current)"
PROGRAM_PR_NUMBER="$reconcile_pr_number"
PROGRAM_PR_KIND=slice-reconciliation
PROGRAM_EXPECTED_HEAD="$RECONCILE_BRANCH"
: "${PROGRAM_REVIEWER_OUTPUT:?set independent agent canonical report output path}"
```

Execute the complete non-bootstrap generation-aware prospective block above. It verifies that the
candidate contains `PREVIOUS_PROGRAM_PR_PATH` and that the prospective prior reference equals its
full-record digest/result identity. Any changed commit, base, candidate, check/run/artifact set,
report, or comment requires a new generation, report, and authorization.

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
RECONCILE_SLICE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-active-reconciliation-slice)"
RECONCILE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-active-reconciliation-path)"
RECONCILE_BRANCH="$(git -C "$RECONCILE_WORKTREE" branch --show-current)"
mapfile -t reconcile_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform \
  --state merged --base main --head "$RECONCILE_BRANCH" | jq -r \
  ".[] | select(.title == \"chore(aquamobil): reconcile $RECONCILE_SLICE protected merge\") | .number")
test "${#reconcile_pr_numbers[@]}" -eq 1
RECONCILE_PR_NUMBER="${reconcile_pr_numbers[0]}"
RECONCILE_MAIN_SHA="$(gh pr view "$RECONCILE_PR_NUMBER" --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$RECONCILE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$RECONCILE_MAIN_SHA" origin/main
PROGRAM_PR_NUMBER="$RECONCILE_PR_NUMBER"
PROGRAM_PR_KIND=slice-reconciliation
PROGRAM_EXPECTED_HEAD="$RECONCILE_BRANCH"
```

Execute the complete fresh-shell post-merge/recovery block, including the exact candidate-tree/
result-tree proof and full remote recovery-comment round trip. Verify that the tracked prior generic
record is now main-reachable at the candidate blob/digest. Run the explicit cleanup block for that
prior generic PR—not for the current reconciliation—and, one at a time, for every retained
implementation boundary named by the now-main-reachable `merge.json`. Retain the current
reconciliation worktree/remote branch/generation until the next generic merge carries its full
record. This is the first point at which the prior-generic and boundary worktrees, remote branches,
and exact verified generations may be removed. Cleanup refuses a missing
`ProtectedProgramBoundaryEvidence.durableRecovery` or a boundary not present in that immutable
record.

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
- Create: the scheduler-selected immediately preceding generic full record at
  `docs/superpowers/evidence/aquamobil-v4/program-prs/pr-<PREVIOUS_GENERIC_PR_NUMBER>.json`.
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
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create-finding-closure \
  --closure "$CLOSURE_NAME" \
  --main-ref origin/main
FINDING_CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure "$CLOSURE_NAME")"
FINDING_CLOSURE_BRANCH="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
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
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and (.headRefOid | test("^[0-9a-f]{40}$")))'
PROGRAM_PR_NUMBER="$closure_pr_number"
PROGRAM_PR_KIND=finding-close
PROGRAM_EXPECTED_HEAD="$(git branch --show-current)"
: "${PROGRAM_REVIEWER_OUTPUT:?set independent agent canonical report output path}"
```

Execute the complete non-bootstrap generation-aware prospective block above. The `finding-close`
registry alias additionally enforces the exact closure-map path and forbids duplicate closing
trailers. This local program gate is separate from branch-protection review state.

The capture verifies that the generated closure map already resolves every expected exact uppercase
trailer once from the implementation-boundary attestations. The registry-state PR must not repeat
those `Closes:` trailers or masquerade its own merge as the fixing commit.

After the authorized finding-close merge, reassign the same exact closure literal in the new shell,
resolve its one configured PR, and persist the full post-merge/recovery bundle. Retain the worktree,
remote branch, and generation until its closure reconciliation is main-reachable:

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
FINDING_CLOSURE_BRANCH="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-branch --closure "$CLOSURE_NAME")"
mapfile -t finding_close_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform \
  --state merged --base main --head "$FINDING_CLOSURE_BRANCH" | jq -r '.[].number')
test "${#finding_close_pr_numbers[@]}" -eq 1
PROGRAM_PR_NUMBER="${finding_close_pr_numbers[0]}"
PROGRAM_PR_KIND=finding-close
PROGRAM_EXPECTED_HEAD="$FINDING_CLOSURE_BRANCH"
```

Execute the complete fresh-shell post-merge/recovery block above, then mark this exact closure
worktree `postmerge-verified-awaiting-reconciliation`. No cleanup is authorized yet.

- [ ] **Step 2: Capture the next closure only after its protected merge**

```bash
set -euo pipefail
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
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create-closure-reconciliation \
  --closure "$closure_name" \
  --main-ref origin/main
closure_worktree="/var/aqua-saas/.worktrees/aquamobil-v4-closure-$closure_name"
cd "$closure_worktree"
PROGRAM_PR_KIND=closure-reconciliation
PROGRAM_EXPECTED_HEAD="$(git branch --show-current)"
PREVIOUS_GENERIC_PR_NUMBER="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$PROGRAM_PR_KIND" \
  --expected-head "$PROGRAM_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$PREVIOUS_PROGRAM_PR_ROOT" \
  --pull-request "$PREVIOUS_GENERIC_PR_NUMBER" --repository Okan-wqm/aquaculture_platform \
  --from-postmerge-recovery-comment)"
[[ "$PREVIOUS_PROGRAM_PR_GENERATION" == "$PREVIOUS_PROGRAM_PR_ROOT"/generations/* ]]
[[ "${PREVIOUS_PROGRAM_PR_GENERATION##*/}" =~ ^[0-9a-f]{64}$ ]]
test -d "$PREVIOUS_PROGRAM_PR_GENERATION"
test ! -L "$PREVIOUS_PROGRAM_PR_GENERATION"
PREVIOUS_PROGRAM_PR_PATH="docs/superpowers/evidence/aquamobil-v4/program-prs/pr-$PREVIOUS_GENERIC_PR_NUMBER.json"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --materialize-previous-generic-program-pr \
  --program-pr-generation "$PREVIOUS_PROGRAM_PR_GENERATION" --write "$PREVIOUS_PROGRAM_PR_PATH"
test -f "$PREVIOUS_PROGRAM_PR_PATH"
test ! -L "$PREVIOUS_PROGRAM_PR_PATH"
PREVIOUS_PROGRAM_PR_SHA256="$(sha256sum "$PREVIOUS_PROGRAM_PR_PATH" | cut -d' ' -f1)"
[[ "$PREVIOUS_PROGRAM_PR_SHA256" =~ ^[0-9a-f]{64}$ ]]
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --verify-previous-generic-program-pr-in-candidate --path "$PREVIOUS_PROGRAM_PR_PATH" \
  --record-sha256 "$PREVIOUS_PROGRAM_PR_SHA256"
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
set -euo pipefail
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$COORDINATOR_WORKTREE"
CLOSURE_NAME="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-active-closure-name)"
CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-active-closure-path)"
[[ "$CLOSURE_NAME" =~ ^(v0-high-findings|ui-convergence-high-findings|product-high-findings|feeding-foundation-high-findings|vfd-feeding-loop-high-findings)$ ]]
[[ "$CLOSURE_WORKTREE" == /var/aqua-saas/.worktrees/aquamobil-v4-closure-* ]]
cd "$CLOSURE_WORKTREE"
PROGRAM_PR_KIND=closure-reconciliation
PROGRAM_EXPECTED_HEAD="$(git branch --show-current)"
PREVIOUS_GENERIC_PR_NUMBER="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$PROGRAM_PR_KIND" \
  --expected-head "$PROGRAM_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$PREVIOUS_PROGRAM_PR_ROOT" \
  --pull-request "$PREVIOUS_GENERIC_PR_NUMBER" --repository Okan-wqm/aquaculture_platform \
  --from-postmerge-recovery-comment)"
[[ "$PREVIOUS_PROGRAM_PR_GENERATION" == "$PREVIOUS_PROGRAM_PR_ROOT"/generations/* ]]
[[ "${PREVIOUS_PROGRAM_PR_GENERATION##*/}" =~ ^[0-9a-f]{64}$ ]]
test -d "$PREVIOUS_PROGRAM_PR_GENERATION"
test ! -L "$PREVIOUS_PROGRAM_PR_GENERATION"
PREVIOUS_PROGRAM_PR_PATH="docs/superpowers/evidence/aquamobil-v4/program-prs/pr-$PREVIOUS_GENERIC_PR_NUMBER.json"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --materialize-previous-generic-program-pr \
  --program-pr-generation "$PREVIOUS_PROGRAM_PR_GENERATION" --write "$PREVIOUS_PROGRAM_PR_PATH"
test -f "$PREVIOUS_PROGRAM_PR_PATH"
test ! -L "$PREVIOUS_PROGRAM_PR_PATH"
PREVIOUS_PROGRAM_PR_SHA256="$(sha256sum "$PREVIOUS_PROGRAM_PR_PATH" | cut -d' ' -f1)"
[[ "$PREVIOUS_PROGRAM_PR_SHA256" =~ ^[0-9a-f]{64}$ ]]
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --verify-previous-generic-program-pr-in-candidate --path "$PREVIOUS_PROGRAM_PR_PATH" \
  --record-sha256 "$PREVIOUS_PROGRAM_PR_SHA256"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
git add -- \
  "docs/superpowers/evidence/aquamobil-v4/closures/$CLOSURE_NAME.json" \
  docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  "$PREVIOUS_PROGRAM_PR_PATH"
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
gh pr view "$closure_reconcile_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and (.headRefOid | test("^[0-9a-f]{40}$")))'
CLOSURE_BRANCH="$(git branch --show-current)"
PROGRAM_PR_NUMBER="$closure_reconcile_pr_number"
PROGRAM_PR_KIND=closure-reconciliation
PROGRAM_EXPECTED_HEAD="$CLOSURE_BRANCH"
: "${PROGRAM_REVIEWER_OUTPUT:?set independent agent canonical report output path}"
```

Execute the complete non-bootstrap generation-aware prospective block above. It verifies the
candidate's exact prior generic full record and preserves the report, comment, permission, checks,
workflow runs/artifacts, and API digests.

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
CLOSURE_NAME="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-active-closure-name)"
CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-active-closure-path)"
CLOSURE_BRANCH="$(git -C "$CLOSURE_WORKTREE" branch --show-current)"
mapfile -t closure_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform \
  --state merged --base main --head "$CLOSURE_BRANCH" | jq -r \
  ".[] | select(.title == \"chore(aquamobil): reconcile $CLOSURE_NAME\") | .number")
test "${#closure_pr_numbers[@]}" -eq 1
CLOSURE_PR_NUMBER="${closure_pr_numbers[0]}"
CLOSURE_MAIN_SHA="$(gh pr view "$CLOSURE_PR_NUMBER" --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$CLOSURE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$CLOSURE_MAIN_SHA" origin/main
PROGRAM_PR_NUMBER="$CLOSURE_PR_NUMBER"
PROGRAM_PR_KIND=closure-reconciliation
PROGRAM_EXPECTED_HEAD="$CLOSURE_BRANCH"
```

Execute the complete fresh-shell post-merge/recovery block. Its tree proof makes the tracked prior
generic record main-reachable. Clean that prior generic; retain this current reconciliation until
the next generic merge. Because the closure record containing the finding-close
`ProtectedProgramBoundaryEvidence.durableRecovery` is now main-reachable, also run the explicit
cleanup block for the retained finding-close worktree/remote branch/generation. Never remove the
current reconciliation in this step.

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
exclusions/merge resolutions, protected tooling PR, exact tooling-main run, the distinct
`closeout-terminal-evidence` PR, exact report-base-main run, separate report PR, exact report-main
run, and signed ruleset-protected archive. This program creates no competing final report.

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
