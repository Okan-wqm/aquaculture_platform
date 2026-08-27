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
cross-system workflow, terminal evidence then fixes an exact report-base-main dispatch for the
report PR, and an exact report-main
dispatch feeds a protected signed provenance archive. Source PR closure and source deletion remain
separately approved actions. Any run with at least one approval uses a persistent two-phase journal
and adds a fresh-clone actionable receipt even when an action fails or remains ambiguous. Every
approval row, including false/false, creates and protected-merges the same generic
`closeout-receipt` finalizer and completes its postmerge external-anchor recovery; false/false omits
only the destructive journal, actionable receipt, and post-action reference.

**Tech Stack:** Node.js 22, npm 10, Git, GitHub CLI/API, GitHub Actions, Nx, Jest, Vitest,
Playwright, TypeScript, TypeORM/PostgreSQL, NATS/JetStream mTLS, GraphQL codegen, Docker, Trivy,
nginx

**Spec:** `docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md`

## Global Constraints

- Start only after all 16 implementation slices and all five fixed closure records have been
  reconciled through protected `main`. An open, stacked, or implementation-only branch is not a
  closeout input.
- Immutable anchors are source tip `542c8e0bb7ff3afbeee0496f277f8926526cc41a`, merge base
  `8d8d54365ada11d45b43374af76e9814c5958ff0`, and design snapshot
  `designMainCommit=4002868c535a2d8676aad6eadd5f4bbd57d4625b`. Separately consume the program
  plan's generated post-#1333 `order0BaseMainCommit`, which descends from the design snapshot and
  contains all seven machine-checked planning blobs and Order 0. Every closeout main identity must
  descend from that generated anchor. At design refresh the source was 219 commits behind and 35
  ahead.
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
- Branch deletion never uses `--force` or `--force-with-lease`. After either explicit action
  approval, an exact-ref repository ruleset with no bypass actors must be journaled, active, and
  effective before any close/delete intent: branch creation and update are restricted, deletion is
  not restricted, and the source tip is revalidated after the freeze. The ruleset remains active
  after close-only or deletion to prevent mutation/recreation; removing or weakening it requires
  separate future authorization.
- A generic `closeout-receipt` finalizer is mandatory even when neither action is approved. That
  no-action path creates no journal, action receipt, or post-action reference; its protected merge
  and remotely recoverable postmerge proof are still the sole terminal anchor.
- Immediately before every closeout tooling, terminal-evidence, report, archive, or receipt merge,
  invoke Order 0's generic protected-PR verifier with the exact PR/head/kind plus
  `--verify-base-advance` and `--require-current-pr-test-merge-candidate` plus the canonical
  independent-agent report. It must
  make the current no-overlap or normal-main-merge-and-reauthorized decision and bind four exact
  required contexts to three mandatory current `pull_request` candidate artifacts: CI-Affected's
  artifact is shared by `merge-gate` and `sens-enterprise-summary`, while CI Full `build-status` and
  ARIA `aria-merge-authority` each own one. Among append-only marker history, exactly one structured
  authorization issue comment may match the full current lineage/report/set; it must be authored by
  `Okan-wqm` with current admin permission. This program-local gate is separate from GitHub branch-protection
  review state; any base/head/candidate/check/report/comment drift blocks merge.
- Retain `/var/aqua-saas/.worktrees/aquamobil-v4-coordinator` from Order 0, keep it clean and
  detached at the exact fetched `origin/main`, and use its absolute Order 0
  orchestration/evidence-tool paths for local coordination. `/var/aqua-saas` is only the Git common
  directory through `git -C`; never run repository tools or npm from that dirty/user-owned checkout.
  A tool newly authored by the closeout branch may run there only under its unit tests; it may not
  capture or mutate program evidence until the tooling PR merges and the detached coordinator is
  refreshed to that exact protected main. Checkout-local execution is limited to the fail-closed
  GitHub Actions emitter/verification mode, which requires `GITHUB_ACTIONS=true` and binds exact
  event/ref/head/workflow/tool blobs. No relative package command is a valid local coordinator.
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

## Mandatory Closeout Program-PR Protocol

Every closeout PR is a generic `ProgramPrKind`: `closeout-tooling`,
`closeout-terminal-evidence`, `closeout-report`, `closeout-archive`, or `closeout-receipt`. Before
the final commit that establishes or updates each review candidate, set its exact kind/registered
branch and run the master plan's complete
coordinator-absolute `--materialize-previous-generic-program-pr` block. Stage the resulting full
portable `docs/superpowers/evidence/aquamobil-v4/program-prs/pr-<N>.json`; payload fragments,
digests without bodies, or spool paths are forbidden.

After opening each PR, run this exact parameterized prospective lifecycle:

```bash
set -euo pipefail
: "${CLOSEOUT_PR_NUMBER:?set exact open PR number}"
: "${CLOSEOUT_PR_KIND:?set exact closeout ProgramPrKind}"
: "${CLOSEOUT_EXPECTED_HEAD:?set exact registered closeout branch}"
: "${CLOSEOUT_REVIEWER_OUTPUT:?set independent agent canonical report output path}"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas \
  rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
CLOSEOUT_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$CLOSEOUT_PR_NUMBER"
CLOSEOUT_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --initialize-program-pr-spool "$CLOSEOUT_PR_ROOT" \
  --write-independent-review-input \
  --pull-request "$CLOSEOUT_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind "$CLOSEOUT_PR_KIND" \
  --expected-head "$CLOSEOUT_EXPECTED_HEAD" \
  --verify-base-advance \
  --require-current-pr-test-merge-candidate \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --print-program-pr-generation)"
[[ "$CLOSEOUT_PR_GENERATION" == "$CLOSEOUT_PR_ROOT"/generations/* ]]
[[ "${CLOSEOUT_PR_GENERATION##*/}" =~ ^[0-9a-f]{64}$ ]]
```

Pause for the independent agent to read
`$CLOSEOUT_PR_GENERATION/review/review-input.json` and write the closed exact-kind report to
`$CLOSEOUT_REVIEWER_OUTPUT`. That path is an ephemeral ingest handoff, never authority; after ingest,
the immutable generation and full remote authorization payload are the recovery authorities. Resume
with:

```bash
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --ingest-independent-review-report "$CLOSEOUT_REVIEWER_OUTPUT" \
  --program-pr-generation "$CLOSEOUT_PR_GENERATION"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --write-authorization-comment-envelope \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --program-pr-generation "$CLOSEOUT_PR_GENERATION"
gh pr comment "$CLOSEOUT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --body-file "$CLOSEOUT_PR_GENERATION/authorization/authorization-comment-envelope.md"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-program-pr "$CLOSEOUT_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind "$CLOSEOUT_PR_KIND" \
  --expected-head "$CLOSEOUT_EXPECTED_HEAD" \
  --verify-base-advance \
  --require-current-pr-test-merge-candidate \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --program-pr-generation "$CLOSEOUT_PR_GENERATION" \
  --write-prospective-spool
```

For `closeout-receipt`, each enforcement point re-fetches the candidate's selected live-reference
blob, recomputes its Git-blob/content/API digests, exhaustively rereads the source ref and PR #1107,
and requires exact equality with the canonical `closeoutFinalizerObservation` copied through review,
report, authorization, and prospective evidence. False/false additionally requires source PRESENT
at `542c8e0bb7ff3afbeee0496f277f8926526cc41a` and PR #1107 OPEN, non-draft, with the exact
head/ref/SHA/base identity. Every other PR kind requires literal null. The trusted detached
coordinator performs the remote calls; required-workflow candidate emitters remain tokenless and
API-free. Rerun the prospective verifier immediately before protected merge; any observation drift
invalidates the report/comment generation and blocks authorization and merge.

The full authorization payload embeds the exact-kind report, four checks, three verified
workflow-run/artifact bodies, base-advance/PR-API/capture-tool facts, and the mandatory prior-generic
reference and stays at or below 60000 canonical UTF-8 bytes. Exactly one
append-only marker may match current `N/B/H/C/T/[B,H]/report/set`; malformed current collisions and
same-candidate reruns without a new report/comment fail. The three source artifacts share only
canonical lineage and `canonicalLineageSha256`, never prospective-only `checkArtifactSetSha256`, and
have distinct run/attempt/producer-
check/workflow-repository/path/ref/SHA/blob/tool-blob tuples. Only terminal jobs in the three existing
required workflows emit them, with exact `contents: read` and no `actions: read`, no token,
depth-two SHA-pinned checkout/upload, identical PR-only guards, `github.job`, and exact official
`job.check_run_id/job.workflow_file_path/job.workflow_ref/job.workflow_sha/
job.workflow_repository`. They derive workflow blobs from Git and perform no API/network call; the
trusted coordinator exhaustively cross-checks Jobs/API and Git-blob state. Missing, empty, renamed,
hard-coded, or `github.workflow*` fallback fields fail. No fourth evidence workflow is added. Every
GitHub list used by capture/recovery—pull requests, check runs, workflow runs, workflow jobs, run
artifacts, comments, rulesets, tags, and any later list—follows every RFC 8288 `Link` page,
canonicalizes the complete set,
validates `total_count` when present, and rejects page loops, missing pages, or cross-page
duplicates; `per_page=100` is only an optimization and page one is never authority.
`merge-gate` is CI-Affected's producer and equals its context check; the distinct
`sens-enterprise-summary` check shares that run/attempt and names producer job `merge-gate` but does
not equal its producer check. Full `build-status` and ARIA `aria-merge-authority` each equal their
producer check. The emitted job also carries exact `workflow_file_path/workflow_ref/workflow_sha/
workflow_repository/blob_sha`, which the collector cross-checks with Jobs/API and Git blobs;
context check identity is never substituted for producer identity.

The common-dir spool uses append-only digest generations and separate
review/authorization/prospective/postmerge phase manifests that exclude themselves and the external
manifest attestation. Files use
same-directory `O_NOFOLLOW|O_CREAT|O_EXCL` temp write/fsync/close, `link(temp,final)` atomic
no-replace, directory fsync, temp unlink, and another directory fsync; `EEXIST`, symlinks,
pre-check/rename overwrite, and digest-only reconstruction fail.

Immediately after each protected merge, start a new shell, re-resolve all variables, and run:

```bash
set -euo pipefail
: "${CLOSEOUT_PR_NUMBER:?re-enter merged PR number}"
: "${CLOSEOUT_PR_KIND:?re-enter closeout ProgramPrKind}"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas \
  rev-parse --path-format=absolute --git-common-dir)"
CLOSEOUT_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$CLOSEOUT_PR_NUMBER"
CLOSEOUT_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$CLOSEOUT_PR_ROOT" \
  --pull-request "$CLOSEOUT_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind "$CLOSEOUT_PR_KIND" \
  --from-current-authorization-comment)"
CLOSEOUT_RESULTING_MAIN="$(gh pr view "$CLOSEOUT_PR_NUMBER" \
  --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$CLOSEOUT_RESULTING_MAIN" =~ ^[0-9a-f]{40}$ ]]
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --reconcile-program-pr "$CLOSEOUT_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind "$CLOSEOUT_PR_KIND" \
  --resulting-main "$CLOSEOUT_RESULTING_MAIN" \
  --program-pr-generation "$CLOSEOUT_PR_GENERATION" \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --write-postmerge-spool
CLOSEOUT_POSTMERGE_COMMENT_ACTION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --write-postmerge-recovery-comment-envelope \
  --select-canonical-postmerge-recovery-comment \
  --pull-request "$CLOSEOUT_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --program-pr-generation "$CLOSEOUT_PR_GENERATION" \
  --print-postmerge-comment-action)"
case "$CLOSEOUT_POSTMERGE_COMMENT_ACTION" in
  post)
    gh pr comment "$CLOSEOUT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
      --body-file "$CLOSEOUT_PR_GENERATION/postmerge/postmerge-comment-envelope.md"
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
  --program-pr-generation "$CLOSEOUT_PR_GENERATION" \
  --recover-spool-from-github-if-missing \
  --enforce-closeout-finalizer-observation-by-pr-kind \
  --observe-remote \
  --require-result-tree-equals-candidate-tree
```

For the receipt, postmerge reconciliation freshly rereads the source/PR before constructing the
postmerge payload and again before accepting its recovery comment. It requires byte-identical
`closeoutFinalizerObservation` linkage to candidate, prospective, resulting-main tree, and protected
main live-reference/disposition blobs. A race after candidate capture therefore cannot produce a
successful postmerge or cleanup authority.

That merge makes the immediately preceding generic record main-reachable, authorizing exact cleanup
of the predecessor worktree/remote branch/verified generation. Retain the current PR's resources for
its successor. `closeout-receipt` is the single terminal exception: after it proves every earlier
numeric record main-reachable and its own full remote recovery payload round-trips, it may clean its
own resources while that remote payload remains the external anchor. A post-before-crash retry
reuses the lowest numeric byte-identical postmerge comment ID; zero, malformed/different current
collisions, or selecting a higher duplicate fail.

---

### Task 1: Freeze terminal implementation and closure inputs

**Files:**

- Modify: `tools/aquamobil-v4/verify-ledger.mjs`
- Modify: `tools/aquamobil-v4/verify-ledger.spec.mjs`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: the protected bootstrap schemas, 16 append-only slice preflights, 16 immutable slice
  merge records, five immutable closure records, and the generated central ledger.
- Produces: schema-versioned `CloseoutInputs` validation/generation modes and strict 35-object
  terminal modes. Task 5 invokes the merged coordinator copy to create `closeout-inputs.json`; this
  branch does not use its unmerged executable to write evidence.

```ts
type FullSha = string & { readonly __fullSha: unique symbol }; // runtime: ^[0-9a-f]{40}$

interface CloseoutInputs {
  readonly schemaVersion: 3;
  readonly repository: 'Okan-wqm/aquaculture_platform';
  readonly originalSourceRef: 'origin/feature/aquamobil-v4-redesign';
  readonly provenanceRef:
    | null
    | 'refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly expectedSourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly observedSourceCommit: FullSha;
  readonly behaviorMainCommit: FullSha;
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
- every boundary's preflight base is an ancestor of its reviewed candidate base, its canonical
  base-advance audit proves either zero owned/shared-authority overlap or an exact normal-main-merge
  resolution with post-merge gates and a new independent report/administrator authorization
  comment, its four required checks map to exactly three non-null current PR-candidate artifacts
  sharing only `N/B/H/C/T/[B,H]` plus `canonicalLineageSha256` while retaining three distinct
  run/attempt/producer/workflow/tool tuples, and that tested candidate tree equals the resulting main
  tree;
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
and closure inventories. A PR test-merge candidate may be ephemeral after merge, so its attested
workflow artifact stores both candidate commit and tree OIDs; verification recomputes
`resultingMainCommit^{tree}` and requires equality with both recorded tree fields. A normal
main-into-branch merge may likewise disappear after a squash, so its ordered parents, tree, and
GitHub commit-response digest are stored and revalidated through the repository API. It also
recomputes every canonical base-advance changed-path digest and validates the exclusive `no-overlap`
or `merged-main-and-reauthorized` state, rejects an untested later base/head or candidate/result tree
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
does not call that SHA the later tooling, terminal-evidence, report, archive, or receipt main SHA.

```bash
node --test tools/aquamobil-v4/verify-ledger.spec.mjs
```

Expected: fixture tests pass only for the exact 35-object, 16-slice, five-closure, four-check,
three-artifact, review/comment, and post-merge-tree contract. The live terminal invocation is
performed in Task 5, after this executable is protected-main coordinator code.

- [ ] **Step 4: Commit the tested verifier without running it as coordination code**

```bash
git add -- \
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
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: immutable source Git objects, protected-main verification runs, and bootstrap schemas.
- Produces: tested generation/verification behavior for three non-merge exclusion records plus two
  deterministic merge-resolution records. Task 5 invokes the merged coordinator copy to write the
  records and terminal `35 = 33 + 2` ledger; this branch writes none of them.

```ts
interface ExclusionRecord {
  readonly sourceCommit: FullSha;
  readonly reason: 'documentation-reflow' | 'format-only' | 'independent-invariant-maintenance';
  readonly changedPaths: readonly string[];
  readonly sourceObjectDigestSha256: string;
  readonly normalizedBlobPairs: readonly {
    readonly path: string;
    readonly parentBlob: FullSha;
    readonly sourceBlob: FullSha;
    readonly parentNormalizedSha256: string;
    readonly sourceNormalizedSha256: string;
  }[];
  readonly currentMainVerification: readonly GitHubNonPullRequestWorkflowRunAttestation[];
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

```bash
node --test tools/aquamobil-v4/verify-exclusions.spec.mjs
```

Expected GREEN: isolated real-Git fixtures generate the exact three exclusions and two merge
records, verify `35 = 33 + 2`, and reject every changed path/blob/order/normalization/run/schema
negative. There is deliberately no relative exclusions or provenance package command.

- [ ] **Step 3: Recheck documentation and invariant outcomes reproducibly**

```bash
npm install --save-dev --save-exact --ignore-scripts markdownlint-cli@0.45.0
npm exec -- markdownlint \
  docs/architecture/feeding-system.md \
  docs/illustrator/farm-modulu-sema-anlatim.md \
  docs/illustrator/farm-modulu-sema-gorsel.md
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/farm-tank-count-ssot.spec.ts
node --test tools/aquamobil-v4/verify-exclusions.spec.mjs
```

Expected: the locked linter, current-main tank-count authority, and all five exclusions pass.

- [ ] **Step 4: Commit and push the exclusion reconciliation**

```bash
git add -- \
  tools/aquamobil-v4/verify-exclusions.mjs \
  tools/aquamobil-v4/verify-exclusions.spec.mjs \
  package.json \
  package-lock.json
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
- Create: `tools/aquamobil-v4/generate-closeout-report.mjs`
- Create: `tools/aquamobil-v4/generate-closeout-report.spec.mjs`
- Create: `tools/aquamobil-v4/capture-live-references.mjs`
- Create: `tools/aquamobil-v4/capture-live-references.spec.mjs`
- Create: `tools/aquamobil-v4/capture-provenance-archive.mjs`
- Create: `tools/aquamobil-v4/capture-provenance-archive.spec.mjs`
- Modify: `.github/workflows/ci-affected.yml`
- Modify: `.github/workflows/ci-full.yml`
- Modify: `.github/manifests/main-required-status-checks.json`
- Modify: `tests/invariants/aquamobil-build-generation.spec.ts`
- Modify: `infrastructure/ci/image-digests.json` only for a separately reviewed digest rotation;
  otherwise consume it byte-for-byte
- Create: `docs/superpowers/evidence/aquamobil-v4/program-prs/pr-<PREVIOUS_GENERIC_PR_NUMBER>.json`
  with the immediately preceding generic full record
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
  report. `.github/workflows/aquamobil-v4-closeout.yml` is a reusable/manual domain-verification
  lane, not a fourth PR-candidate evidence workflow.
- The two touched required workflows preserve Order 0's exact producer terminal-job permissions,
  PR guard, depth-two pinned checkout/upload, token-free/API-free emitter, and exact official
  `job.*` context contract; CI Full
  and ARIA remain the other two existing producers. The closeout lane's separate `fetch-depth: 0`
  cannot emit or satisfy a required PR candidate artifact.

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
They also pin a disposition-file-conditional remote-state check: it is skipped only while the exact
finalizer path is absent and covers every approval row. False/false uses the freshly regenerated
initial live-reference path and requires the source ref PRESENT at the immutable SHA plus PR #1107
OPEN/non-draft at the exact head/ref/SHA/base identity. An actionable disposition uses the exact
post-action live-reference path, accepts complete, partial-failure, and ambiguous outcomes only
through the closed receipt schema, and queries the effective rules for
`feature/aquamobil-v4-redesign`. When close or delete approval is true, the effective set must still
restrict creation and update while omitting deletion restriction; the committed administrative
capture must prove the exact singleton control step, non-null freeze, ruleset ID/configuration,
post-freeze exact-tip reread, and empty bypass-actor set. A finalizer file also activates a token-free
offline check of the bound fresh live-reference blob on every approval row. The GitHub token is
exposed only to the separate remote-state step, never to the PR candidate emitter or offline
finalizer-observation checker. The receipt candidate cannot modify the merged checker/workflow paths,
and the remote mode verifies their exact protected-base Git blobs before using established exhaustive
collectors. Both callers must grant the called job the same exact two read permissions; write
permissions, an administrative secret, or a broader inherited token fail invariants.

The invariant also requires Task 4's edits to preserve Order 0's terminal checkout,
`pull_request`-only candidate emitter, exact-name mandatory upload, and manifest workflow/tool path
pins in CI-Affected `merge-gate` and CI Full `build-status`. ARIA remains the unchanged third
producer. The manifest still maps four contexts to exactly those three artifacts; the reusable
closeout lane cannot produce or satisfy one.

```bash
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand \
  --runTestsByPath tests/invariants/aquamobil-v4-closeout-workflow.spec.ts
node --test tools/aquamobil-v4/normalize-closeout-artifact.spec.mjs \
  tools/aquamobil-v4/capture-closeout-run.spec.mjs \
  tools/aquamobil-v4/generate-closeout-report.spec.mjs \
  tools/aquamobil-v4/capture-live-references.spec.mjs \
  tools/aquamobil-v4/capture-provenance-archive.spec.mjs
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
  - name: Verify closeout finalizer observation binding
    if: ${{ hashFiles('docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json') != '' }}
    run: |
      node tools/aquamobil-v4/capture-provenance-archive.mjs \
        --ci-attested \
        --check-closeout-finalizer-observation \
        docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
        --initial-live-references docs/superpowers/evidence/aquamobil-v4/live-references.json \
        --post-action-live-references \
        docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json
  - name: Verify finalizer source and PR against current remote state
    if: ${{ hashFiles('docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json') != '' }}
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      node tools/aquamobil-v4/capture-provenance-archive.mjs \
        --ci-attested \
        --check-closeout-finalizer-observation \
        docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
        --initial-live-references docs/superpowers/evidence/aquamobil-v4/live-references.json \
        --post-action-live-references \
        docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
        --action-receipt-if-present \
        docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
        --provenance-evidence docs/superpowers/evidence/aquamobil-v4/provenance-archive.json \
        --repository Okan-wqm/aquaculture_platform \
        --observe-remote \
        --require-exhaustive-source-and-pr-observation \
        --require-trusted-tool-blob-from-protected-base
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

The conditionals are bootstrap-safe because neither finalizer nor action receipt can exist before
Task 7 merges the capture tool. The offline finalizer checker has no token or API access and requires
the disposition, selected live-reference path/blob/digest, and candidate tree to match exactly. Once
the exact disposition exists, a missing tool/live-reference/archive input, unavailable API,
false/false source deletion/movement or PR state/head/base/draft drift, recreated or moved actionable
source ref, reopened explicitly closed PR, invalid outcome transition, approval/request disagreement,
successful-action mismatch, missing/non-singleton branch-freeze proof, or other matrix mismatch fails
the required candidate or finalizer-main workflow. For close or delete approval, the read-only
effective-branch-rules endpoint proves that creation/update restrictions still apply even when the
source branch is absent; the receipt's administrative installation response and digest prove the
exact ruleset ID, exact rules, post-freeze tip, and empty bypass list.
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
Before any other command it fails unless `GITHUB_ACTIONS=true`, the event is the exact caller
`pull_request` or authorized `workflow_dispatch`, checkout HEAD equals the event/`expectedHead`, and
the on-disk script plus every checkout-local coordination executable match the attested Git blobs
at that checkout. This is the Order 0 `--ci-attested` exception, never a local entry point.

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

Use the Order 0 checkout-local CI-attested capture so advisory exits and operational failures remain
distinct, then invoke the exact Order 0 mapper:

```bash
mkdir -p artifacts/aquamobil-v4-closeout/raw artifacts/aquamobil-v4-closeout/normalized
node scripts/ci/capture-aquamobil-v4-audit-inputs.mjs \
  --ci-attested \
  --output-root artifacts/aquamobil-v4-closeout/raw
node tools/aquamobil-v4/normalize-closeout-artifact.mjs \
  --ci-attested \
  --kind npm-audit-set \
  --root-full artifacts/aquamobil-v4-closeout/raw/audit-root-full.json \
  --root-runtime artifacts/aquamobil-v4-closeout/raw/audit-root-runtime.json \
  --aquamobil-full artifacts/aquamobil-v4-closeout/raw/audit-aquamobil-full.json \
  --aquamobil-runtime artifacts/aquamobil-v4-closeout/raw/audit-aquamobil-runtime.json \
  --audit-input-manifest artifacts/aquamobil-v4-closeout/raw/audit-inputs.json \
  --write-root artifacts/aquamobil-v4-closeout/normalized/audit-root.json \
  --write-aquamobil artifacts/aquamobil-v4-closeout/normalized/audit-aquamobil.json
node scripts/ci/audit-source-map.mjs \
  --ci-attested \
  --audit-set-json artifacts/aquamobil-v4-closeout/raw/audit-set.json \
  --explain-set-json artifacts/aquamobil-v4-closeout/raw/npm-explain-set.json \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest artifacts/aquamobil-v4-closeout/raw/aquamobil-normal-vite-rollup-modules.json \
  --output-json artifacts/aquamobil-v4-closeout/normalized/dependency-reachability.json \
  --output-markdown artifacts/aquamobil-v4-closeout/raw/dependency-reachability.md
node tools/aquamobil-v4/verify-exclusions.mjs \
  --ci-attested \
  --check docs/superpowers/evidence/aquamobil-v4/exclusions.json \
  --check-merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json
npm run aquamobil:v4:ci:provenance:check -- \
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
bash -n scripts/ci/aquamobil-v4-closeout.sh
! env -u GITHUB_ACTIONS bash scripts/ci/aquamobil-v4-closeout.sh
```

Expected: only the five redacted normalized upload files are publishable in GitHub Actions; raw
files remain ignored and ephemeral. Syntax validation passes locally and the guarded script refuses
local execution before writing an artifact.

- [ ] **Step 8: Implement exact dispatch, report, live-reference, and archive capture semantics**

`capture-closeout-run.mjs --dispatch-and-wait` captures both its pre-dispatch run-ID snapshot and
post-dispatch selection as `ExhaustiveGitHubListAttestation { kind: 'workflow-runs' }`. Each phase
requests `per_page=100`, follows every RFC 8288 `rel="next"`, normalizes the complete set, validates
`total_count` when supplied, and rejects loops, omitted advertised pages, count mismatches, and
cross-page duplicate run identities. It generates a UUID request ID, verifies `main` equals the
expected full SHA, dispatches `.github/workflows/aquamobil-v4-closeout.yml` on `main`, and requires
the exhaustive post-set minus exhaustive pre-set to contain exactly one new `workflow_dispatch` run
whose head, request ID, run attempt, workflow blob, conclusion, artifact ID, artifact name, and
server digest match. It downloads only the named artifact and validates all five normalized files.
Foreign repositories, PR heads, stale attempts, ambiguous runs, expired artifacts, secret-like
fields, URL queries, and absolute paths fail closed. Every report-base-main, report-main, and
finalizer-main dispatch consumer requires this exhaustive attestation; a raw/default run-list
response is never authority.

```bash
node --test \
  tools/aquamobil-v4/capture-closeout-run.spec.mjs \
  tools/aquamobil-v4/generate-closeout-report.spec.mjs \
  tools/aquamobil-v4/capture-live-references.spec.mjs \
  tools/aquamobil-v4/capture-provenance-archive.spec.mjs
```

The three additional executables implement the closed `LiveReferences`, deterministic report, and
archive/journal/receipt schemas used in Tasks 5-7. Their fixture tests cover initial and post-action
state, signed-tag/ruleset capture, all four action-approval rows, complete/partial/ambiguous attempts,
restart reconciliation, and unknown-field/identity drift. They do not contact live GitHub or write
program evidence on this branch. Terminal-evidence fixtures also start from a clean worktree with a
missing install, missing local `./node_modules/.bin/ts-node`, or a lockfile changed by bootstrap and
require failure before any capture, staging, hook, or GitHub operation.

Dispatch fixtures put the only matching run on a later page and duplicate one run identity across
pages independently in both the pre-dispatch snapshot and post-dispatch selection. The former must
never dispatch from an incomplete baseline; the latter must never select or attest a run. A
structural fixture reads all seven planning/specification documents and rejects stale wording
equivalent to a no-action path having no generic receipt/finalizer or making that finalizer optional;
it requires the always-on `closeout-receipt` protected merge and postmerge anchor while preserving
the absence of destructive artifacts on false/false.

- [ ] **Step 9: Commit, open, review, and merge the tooling PR**

```bash
set -euo pipefail
CLOSEOUT_PR_KIND=closeout-tooling
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-integration-closeout
CLOSEOUT_CANDIDATE_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$CLOSEOUT_CANDIDATE_WORKTREE"
test "$(git branch --show-current)" = "$CLOSEOUT_EXPECTED_HEAD"
PREVIOUS_GENERIC_PR_NUMBER="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$CLOSEOUT_PR_KIND" \
  --expected-head "$CLOSEOUT_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
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
git add -- \
  scripts/ci/aquamobil-v4-closeout.sh \
  .github/workflows/aquamobil-v4-closeout.yml \
  tests/invariants/aquamobil-v4-closeout-workflow.spec.ts \
  tools/aquamobil-v4/normalize-closeout-artifact.mjs \
  tools/aquamobil-v4/normalize-closeout-artifact.spec.mjs \
  tools/aquamobil-v4/capture-closeout-run.mjs \
  tools/aquamobil-v4/capture-closeout-run.spec.mjs \
  tools/aquamobil-v4/generate-closeout-report.mjs \
  tools/aquamobil-v4/generate-closeout-report.spec.mjs \
  tools/aquamobil-v4/capture-live-references.mjs \
  tools/aquamobil-v4/capture-live-references.spec.mjs \
  tools/aquamobil-v4/capture-provenance-archive.mjs \
  tools/aquamobil-v4/capture-provenance-archive.spec.mjs \
  .github/workflows/ci-affected.yml \
  .github/workflows/ci-full.yml \
  .github/manifests/main-required-status-checks.json \
  tests/invariants/aquamobil-build-generation.spec.ts \
  infrastructure/ci/image-digests.json \
  "$PREVIOUS_PROGRAM_PR_PATH"
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
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-integration-closeout" and (.headRefOid | test("^[0-9a-f]{40}$")))'
CLOSEOUT_PR_NUMBER="$tooling_pr_number"
CLOSEOUT_PR_KIND=closeout-tooling
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-integration-closeout
CLOSEOUT_REVIEWER_OUTPUT="artifacts/aquamobil-v4/reviews/pr-$tooling_pr_number.json"
```

Execute the Mandatory Closeout Program-PR Protocol's complete prospective block; it rereads all
identities after capture and requires the candidate's exact preceding generic record.

After the authorized protected merge:

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
mapfile -t tooling_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
  --base main --head chore/aquamobil-v4-integration-closeout | jq -r \
  '.[] | select(.title == "chore(aquamobil): add v4 cross-system closeout gate") | .number')
test "${#tooling_pr_numbers[@]}" -eq 1
TOOLING_PR_NUMBER="${tooling_pr_numbers[0]}"
[[ "$TOOLING_PR_NUMBER" =~ ^[0-9]+$ ]]
TOOLING_RESULT_MAIN_SHA="$(gh pr view "$TOOLING_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$TOOLING_RESULT_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$TOOLING_RESULT_MAIN_SHA" origin/main
git -C /var/aqua-saas cat-file -e \
  "$TOOLING_RESULT_MAIN_SHA:.github/workflows/aquamobil-v4-closeout.yml"
CLOSEOUT_PR_NUMBER="$TOOLING_PR_NUMBER"
CLOSEOUT_PR_KIND=closeout-tooling
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-integration-closeout
```

Execute the Mandatory Closeout post-merge/recovery block and retain tooling's worktree, remote
branch, and verified generation. The following terminal-evidence merge carries the full tooling
record and is the first point that authorizes exact tooling-resource cleanup.

---

### Task 5: Capture report-base-main and generate the sole supersession report

**Files:**

- Consume from merged tooling main: `tools/aquamobil-v4/generate-closeout-report.mjs`
- Consume from merged tooling main: `tools/aquamobil-v4/capture-live-references.mjs`
- Create: `docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/exclusions.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/execution-ledger.json` only through the coordinator
  reconciler
- Create: `docs/superpowers/evidence/aquamobil-v4/closeout-run-report-base-main.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/live-references.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/final-verification.md` only through the generator
- Create once in each terminal-evidence/report candidate:
  `docs/superpowers/evidence/aquamobil-v4/program-prs/pr-<PREVIOUS_GENERIC_PR_NUMBER>.json`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: exact report-base-main dispatch, terminal 35-object provenance, exclusions, closure records,
  and normalized live GitHub/Git state.
- Produces: deterministic Markdown. No manual edit to the report is accepted.

```ts
interface LiveReferences {
  readonly schemaVersion: 2;
  readonly repository: 'Okan-wqm/aquaculture_platform';
  readonly sourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly observedAt: string;
  readonly sourceRef: {
    readonly refName: 'refs/heads/feature/aquamobil-v4-redesign';
    readonly state: 'PRESENT' | 'ABSENT';
    readonly commit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a' | null;
    readonly apiResponseSha256: string;
  };
  readonly sourcePullRequest: {
    readonly number: 1107;
    readonly state: 'OPEN' | 'CLOSED';
    readonly isDraft: false;
    readonly headRefName: 'feature/aquamobil-v4-redesign';
    readonly headRefOid: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
    readonly baseRefName: 'main';
    readonly mergeStateStatus: string;
    readonly url: string;
    readonly apiResponseSha256: string;
  };
  readonly pullRequestList: ExhaustiveGitHubListAttestation & {
    readonly kind: 'pull-requests';
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
    readonly head: FullSha;
    readonly branch: null;
    readonly clean: true;
    readonly disposition: 'retained-intentionally' | 'cleanup-after-receipt-main';
  };
  readonly worktrees: readonly { readonly head: FullSha; readonly branch: string | null }[];
  readonly sourceContainingRefs: readonly string[];
}

type CloseoutDisposition =
  | {
      readonly schemaVersion: 1;
      readonly kind: 'aquamobil-v4-closeout-disposition';
      readonly disposition: 'no-action';
      readonly explicitPrCloseApproved: false;
      readonly explicitBranchDeleteApproved: false;
      readonly actionReceiptPath: null;
      readonly liveReferencesPath: 'docs/superpowers/evidence/aquamobil-v4/live-references.json';
      readonly freshObservation: CloseoutFinalizerObservationBinding & {
        readonly disposition: 'no-action';
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: 'aquamobil-v4-closeout-disposition';
      readonly disposition: 'source-actions';
      readonly approvals:
        | { readonly closeSourcePr: true; readonly deleteSourceBranch: boolean }
        | { readonly closeSourcePr: false; readonly deleteSourceBranch: true };
      readonly actionReceiptPath: 'docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json';
      readonly liveReferencesPath: 'docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json';
      readonly freshObservation: CloseoutFinalizerObservationBinding & {
        readonly disposition: 'source-actions';
      };
    };
```

- [ ] **Step 0: Generate and merge terminal evidence only from the merged coordinator**

```bash
set -euo pipefail
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
TERMINAL_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-terminal-evidence
git -C /var/aqua-saas fetch origin \
  +refs/heads/main:refs/remotes/origin/main \
  +refs/heads/feature/aquamobil-v4-redesign:refs/remotes/origin/feature/aquamobil-v4-redesign
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
test ! -e "$TERMINAL_WORKTREE"
git -C /var/aqua-saas worktree add "$TERMINAL_WORKTREE" \
  -b chore/aquamobil-v4-terminal-evidence origin/main
cd "$TERMINAL_WORKTREE"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
[[ "$ROOT_LOCK_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$AQUAMOBIL_LOCK_SHA256" =~ ^[0-9a-f]{64}$ ]]
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
test -x ./node_modules/.bin/ts-node
test -f tools/gates/tsconfig.json
test -x .husky/pre-commit
test "$(git rev-parse origin/feature/aquamobil-v4-redesign)" = \
  542c8e0bb7ff3afbeee0496f277f8926526cc41a
test "$(git merge-base \
  4002868c535a2d8676aad6eadd5f4bbd57d4625b \
  origin/feature/aquamobil-v4-redesign)" = \
  8d8d54365ada11d45b43374af76e9814c5958ff0
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --write-closeout-inputs docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json \
  --repository Okan-wqm/aquaculture_platform \
  --source-ref origin/feature/aquamobil-v4-redesign \
  --expected-source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --main-ref origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-exclusions.mjs" \
  --write docs/superpowers/evidence/aquamobil-v4/exclusions.json \
  --write-merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --apply-exclusions docs/superpowers/evidence/aquamobil-v4/exclusions.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --main-ref origin/main \
  --write docs/superpowers/evidence/aquamobil-v4/execution-ledger.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-exclusions.mjs" \
  --check docs/superpowers/evidence/aquamobil-v4/exclusions.json \
  --check-merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --require-terminal \
  --require-source-objects 35 \
  --require-nonmerge-rows 33 \
  --require-merge-resolutions 2 \
  --verify-main-ancestors origin/main
CLOSEOUT_PR_KIND=closeout-terminal-evidence
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-terminal-evidence
CLOSEOUT_CANDIDATE_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$CLOSEOUT_CANDIDATE_WORKTREE"
test "$(git branch --show-current)" = "$CLOSEOUT_EXPECTED_HEAD"
PREVIOUS_GENERIC_PR_NUMBER="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$CLOSEOUT_PR_KIND" \
  --expected-head "$CLOSEOUT_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
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
git add -- \
  docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json \
  docs/superpowers/evidence/aquamobil-v4/exclusions.json \
  docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  "$PREVIOUS_PROGRAM_PR_PATH"
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): freeze terminal v4 evidence"
git push --set-upstream origin chore/aquamobil-v4-terminal-evidence
terminal_pr_url="$(gh pr create --repo Okan-wqm/aquaculture_platform --base main \
  --head chore/aquamobil-v4-terminal-evidence \
  --title "chore(aquamobil): freeze terminal v4 evidence" \
  --body "Generates the terminal 35-object ledger and exclusions only with the merged detached coordinator.")"
terminal_pr_number="$(gh pr view "$terminal_pr_url" --json number --jq '.number')"
gh pr checks "$terminal_pr_number" --watch --fail-fast
CLOSEOUT_PR_NUMBER="$terminal_pr_number"
CLOSEOUT_PR_KIND=closeout-terminal-evidence
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-terminal-evidence
CLOSEOUT_REVIEWER_OUTPUT="artifacts/aquamobil-v4/reviews/pr-$terminal_pr_number.json"
```

Execute the Mandatory Closeout prospective block. `closeout-terminal-evidence` has its own exact
branch/path registry entry and cannot borrow feeding auxiliary authority. After the protected merge,
resolve its identities in a new shell:

```bash
set -euo pipefail
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
mapfile -t terminal_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
  --base main --head chore/aquamobil-v4-terminal-evidence | jq -r \
  '.[] | select(.title == "chore(aquamobil): freeze terminal v4 evidence") | .number')
test "${#terminal_pr_numbers[@]}" -eq 1
TERMINAL_PR_NUMBER="${terminal_pr_numbers[0]}"
TERMINAL_MAIN_SHA="$(gh pr view "$TERMINAL_PR_NUMBER" \
  --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$TERMINAL_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$TERMINAL_MAIN_SHA" origin/main
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
CLOSEOUT_PR_NUMBER="$TERMINAL_PR_NUMBER"
CLOSEOUT_PR_KIND=closeout-terminal-evidence
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-terminal-evidence
```

Execute the full post-merge spool/recovery-comment/tree-proof block. It makes the tracked tooling
record main-reachable, so clean the retained tooling resources exactly; retain terminal-evidence's
worktree/remote branch/generation until the report PR merges its full record.

`closeout-inputs.json`, `exclusions.json`, both merge records, and the generated ledger are now
protected-main inputs; no unmerged executable created them.

- [ ] **Step 1: Create and enter the exact report worktree**

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
mapfile -t terminal_evidence_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
  --base main --head chore/aquamobil-v4-terminal-evidence | jq -r \
  '.[] | select(.title == "chore(aquamobil): freeze terminal v4 evidence") | .number')
test "${#terminal_evidence_pr_numbers[@]}" -eq 1
TERMINAL_EVIDENCE_PR_NUMBER="${terminal_evidence_pr_numbers[0]}"
TERMINAL_EVIDENCE_MAIN_SHA="$(gh pr view "$TERMINAL_EVIDENCE_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,mergeCommit \
  --jq 'select(.state == "MERGED" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-terminal-evidence") | .mergeCommit.oid')"
[[ "$TERMINAL_EVIDENCE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
REPORT_BASE_MAIN_SHA="$(git -C /var/aqua-saas rev-parse origin/main)"
[[ "$REPORT_BASE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor \
  "$TERMINAL_EVIDENCE_MAIN_SHA" "$REPORT_BASE_MAIN_SHA"
git -C /var/aqua-saas cat-file -e \
  "$REPORT_BASE_MAIN_SHA:.github/workflows/aquamobil-v4-closeout.yml"
report_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-report
test ! -e "$report_worktree"
git -C /var/aqua-saas worktree add "$report_worktree" \
  -b chore/aquamobil-v4-semantic-supersession "$REPORT_BASE_MAIN_SHA"
cd "$report_worktree"
test "$(git rev-parse HEAD)" = "$REPORT_BASE_MAIN_SHA"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
```

- [ ] **Step 2: Dispatch exact report-base-main and commit normalized run evidence**

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
cd /var/aqua-saas/.worktrees/aquamobil-v4-report
test -z "$(git status --porcelain)"
git merge --ff-only origin/main
REPORT_BASE_MAIN_SHA="$(git rev-parse HEAD)"
[[ "$REPORT_BASE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$REPORT_BASE_MAIN_SHA" = "$(git -C /var/aqua-saas rev-parse origin/main)"
git -C /var/aqua-saas merge-base --is-ancestor \
  "$REPORT_BASE_MAIN_SHA" origin/main
git -C /var/aqua-saas cat-file -e \
  "$REPORT_BASE_MAIN_SHA:.github/workflows/aquamobil-v4-closeout.yml"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-closeout-run.mjs" \
  --dispatch-and-wait \
  --require-exhaustive-workflow-runs \
  --repository Okan-wqm/aquaculture_platform \
  --workflow .github/workflows/aquamobil-v4-closeout.yml \
  --ref main \
  --expected-head "$REPORT_BASE_MAIN_SHA" \
  --artifact-name aquamobil-v4-closeout-evidence \
  --write docs/superpowers/evidence/aquamobil-v4/closeout-run-report-base-main.json
```

Expected: the committed JSON is a typed successful workflow-run attestation plus normalized command
digests, not a local result file or PR run.

- [ ] **Step 3: Reverify the merged deterministic report and live-reference tools**

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
node --test \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.spec.mjs" \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-live-references.spec.mjs"
```

Expected: PASS against the exact merged coordinator tools; this report branch writes no evidence
with an unmerged executable.

- [ ] **Step 4: Capture live references and render deterministically**

`capture-live-references.mjs` invokes typed `gh pr view`, the coordinator's exhaustive
RFC-8288-paginated pull-request list mode,
`git worktree list --porcelain`, and `git for-each-ref --contains`. It sorts output, stores no local
path, and rejects a changed source, foreign URL, duplicate ref, another open PR consuming the
source, or an active source-branch worktree. For the initial capture it requires PR #1107 to be
OPEN, non-draft, head `feature/aquamobil-v4-redesign` at the immutable source SHA, and base `main`.
It records `mergeStateStatus` as observed remote state but never treats that unstable field as a
fixed gate. The literal `--coordinator-worktree` input is validated as the exact clean detached
Order 0 path at fetched `origin/main`, but the local path is not serialized. Before a finalizer
receipt its disposition is `retained-intentionally`; only the receipt-finalizer capture may use
`cleanup-after-receipt-main`. That finalizer capture is either the post-action reference or the
freshly regenerated same-path initial reference for false/false. When both approval booleans are
false, no action receipt or post-action reference exists, but the generic no-action closeout
finalizer still supplies the external terminal anchor and later cleanup authority. Initial
captures require both explicit-action fields to be false. A post-action capture requires both
booleans explicitly, validates the same four-row matrix as `SourceActionReceipt`, and cannot infer
approval from a closed PR or missing ref.

```bash
set -Eeuo pipefail
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd /var/aqua-saas/.worktrees/aquamobil-v4-report
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-live-references.mjs" \
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
  --expected-pr-head-sha 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --observe-remote \
  --require-exhaustive-source-and-pr-observation
```

Fresh-shell failure fixtures inject failure into coordinator refresh, `cd`, remote source/PR
enumeration, live-reference materialization, content digesting, report write/check, and ledger
verification. Each injection must leave commit, push, PR/comment publication, source action,
disposition creation, and merge authorization unreachable; an earlier report or live-reference file
is never accepted as current truth after a failed capture.

The only valid local report entry points are the merged coordinator executable's absolute
`--write` and `--check` invocations below; do not add a branch-relative package alias.

Rows follow frozen Git order. Full SHAs, repository-bound HTTPS evidence URLs, all implementation
boundaries, closure maps, three non-merge exclusions, and two merge-resolution object IDs are
mandatory. An excluded row renders generated artifacts as `not applicable` with its machine-derived
reason; an empty link or invented artifact is invalid. The finalizer always supplies the closed
`closeout-disposition.json`. When `source-action-receipt.json` is absent, the only valid disposition
is no-action and inputs use `live-references.json`; an action receipt or post-action reference must
not exist. When that receipt exists, both render and check fail
unless they use `live-references-post-action.json` and the receipt together. Receipt presence while
both approvals are false, a post-action live reference without a receipt, unequal approval booleans
between those two inputs, a requested/attempted/successful/observed state mismatch, or either close
or delete approval without the singleton control step and non-null typed branch-freeze disposition
fails closed. This deterministic selection
keeps the later finalizer-main workflow fresh for every approval row.

```bash
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --write
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --check
node --test \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.spec.mjs" \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-live-references.spec.mjs"
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
set -Eeuo pipefail
cd /var/aqua-saas/.worktrees/aquamobil-v4-report
CLOSEOUT_PR_KIND=closeout-report
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-semantic-supersession
CLOSEOUT_CANDIDATE_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$CLOSEOUT_CANDIDATE_WORKTREE"
test "$(git branch --show-current)" = "$CLOSEOUT_EXPECTED_HEAD"
PREVIOUS_GENERIC_PR_NUMBER="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$CLOSEOUT_PR_KIND" \
  --expected-head "$CLOSEOUT_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
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
git add -- \
  docs/superpowers/evidence/aquamobil-v4/closeout-run-report-base-main.json \
  docs/superpowers/evidence/aquamobil-v4/live-references.json \
  docs/superpowers/evidence/aquamobil-v4/final-verification.md \
  "$PREVIOUS_PROGRAM_PR_PATH"
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): record v4 semantic supersession" \
  -m "Join all 35 source objects to protected-main behavior, exclusions, merge resolutions, closure evidence, and the exact report-base-main run without inventing ancestry."
git push --set-upstream origin chore/aquamobil-v4-semantic-supersession
report_pr_url="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --head chore/aquamobil-v4-semantic-supersession \
  --title "chore(aquamobil): record v4 semantic supersession" \
  --body "Generates the sole 35-object semantic-supersession report from exact report-base-main evidence; it does not delete provenance.")"
report_pr_number="$(gh pr view "$report_pr_url" --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$report_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$report_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-semantic-supersession" and (.headRefOid | test("^[0-9a-f]{40}$")))'
```

A fresh-shell failure-injection fixture harness targets this exact Step 5
predecessor→stage→commit/push fence. It independently fails the initial `cd`, coordinator fetch or
detach/identity refresh, predecessor selection, generation resolution, materialization, regular-file
or digest verification, declared staging, format-scope generation, format-scope check,
`git diff --cached --check`, and `git commit`. Every injected failure proves `git push`, PR creation,
PR/comment publication, independent-review/administrator authorization, and protected merge are
unreachable; failures before commit also prove no commit occurred. This fence creates no scratch
clone, index, or worktree, so it requires no cleanup trap.

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
mapfile -t report_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state open \
  --base main --head chore/aquamobil-v4-semantic-supersession | jq -r \
  '.[] | select(.title == "chore(aquamobil): record v4 semantic supersession") | .number')
test "${#report_pr_numbers[@]}" -eq 1
REPORT_PR_NUMBER="${report_pr_numbers[0]}"
[[ "$REPORT_PR_NUMBER" =~ ^[0-9]+$ ]]
gh pr checks "$REPORT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$REPORT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-semantic-supersession" and (.headRefOid | test("^[0-9a-f]{40}$")))'
CLOSEOUT_PR_NUMBER="$REPORT_PR_NUMBER"
CLOSEOUT_PR_KIND=closeout-report
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-semantic-supersession
CLOSEOUT_REVIEWER_OUTPUT="artifacts/aquamobil-v4/reviews/pr-$REPORT_PR_NUMBER.json"
```

Execute the complete Mandatory Closeout prospective block for this exact current lineage.

- [ ] **Step 2: Verify the authorized report merge and honest non-ancestry**

After the normal protected merge occurs:

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
mapfile -t report_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
  --base main --head chore/aquamobil-v4-semantic-supersession | jq -r \
  '.[] | select(.title == "chore(aquamobil): record v4 semantic supersession") | .number')
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
CLOSEOUT_PR_NUMBER="$REPORT_PR_NUMBER"
CLOSEOUT_PR_KIND=closeout-report
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-semantic-supersession
```

Execute the complete Mandatory Closeout post-merge block. The report merge makes terminal evidence's
full tracked record main-reachable, authorizing exact cleanup of terminal-evidence resources. Retain
the report worktree/remote branch/generation until the archive PR merges it. Source tip remains
honestly non-main-reachable; nothing is deleted or closed.

---

### Task 7: Archive provenance, request approval, and commit the generic closeout finalizer

**Files:**

- Consume from merged tooling main: `tools/aquamobil-v4/capture-provenance-archive.mjs`
- Create: `docs/superpowers/evidence/aquamobil-v4/closeout-run-report-main.json`
- Create: `docs/superpowers/evidence/aquamobil-v4/provenance-archive.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/live-references.json`
- Modify: `docs/superpowers/evidence/aquamobil-v4/final-verification.md` only through the generator
- Create on every closeout row:
  `docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json`
- Create after at least one approved remote action:
  `docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json`
- Create after at least one approved remote action:
  `docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json`
- Create once in each archive/receipt candidate:
  `docs/superpowers/evidence/aquamobil-v4/program-prs/pr-<PREVIOUS_GENERIC_PR_NUMBER>.json`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: exact report-main run, active GitHub tag ruleset, configured signing identity, explicit
  user approval, and a fresh clone.
- Produces: protected signed tag
  `archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a`, archive PR, and an
  always-required protected-main `closeout-receipt` finalizer PR. The no-action row contains only
  its closed disposition; action rows additionally contain the source-action receipt.

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

type ApprovedSourceActionSet =
  | {
      readonly closeSourcePullRequest: true;
      readonly deleteSourceBranch: boolean;
    }
  | {
      readonly closeSourcePullRequest: false;
      readonly deleteSourceBranch: true;
    };

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
      readonly actionExecution: 'permitted-after-exact-tip-reread';
    }
  | {
      readonly state: 'not-proven';
      readonly rulesetId: number | null;
      readonly installResponseSha256: string | null;
      readonly rulesetConfigurationSha256: string | null;
      readonly effectiveRulesResponseSha256: string | null;
      readonly postFreezeSourceCommit: null;
      readonly recreationPrevention: 'not-proven';
      readonly disposition: 'source-retained-actions-not-attempted';
      readonly actionExecution: 'forbidden';
    };

interface ReceiptCaptureToolAttestation {
  readonly coordinatorMainCommit: FullSha;
  readonly executablePath: 'tools/aquamobil-v4/capture-provenance-archive.mjs';
  readonly executableBlobSha: FullSha;
}

interface SourceActionReceipt {
  readonly schemaVersion: 2;
  readonly repository: 'Okan-wqm/aquaculture_platform';
  readonly sourceCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
  readonly receiptState: 'complete' | 'partial-failure' | 'ambiguous';
  readonly approvals: ApprovedSourceActionSet;
  readonly requestedActions: readonly RequestedSourceAction[];
  readonly actionAttempts: readonly SourceActionAttempt[];
  readonly successfulActions: readonly RequestedSourceAction[];
  readonly controlPlaneSteps: readonly [SourceActionControlStep];
  readonly sourceBranchFreeze: SourceBranchFreezeEvidence;
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
    readonly tagObject: FullSha;
    readonly archiveCommit: '542c8e0bb7ff3afbeee0496f277f8926526cc41a';
    readonly signatureVerified: true;
  };
  readonly journal: {
    readonly journalId: 'source-542c8e0bb7ff3afbeee0496f277f8926526cc41a-pr-1107';
    readonly recordCount: number;
    readonly headRecordSha256: string;
    readonly durability: 'exclusive-link-no-replace-fsync-file-and-directory';
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
increasing sequence and SHA-256 predecessor chain. Each record uses the same no-replace publication
as the program spool: same-directory `open(O_NOFOLLOW|O_CREAT|O_EXCL,0600)`, write/file-`fsync`/close,
atomic `link(temp,final)` with `EEXIST` failure, directory `fsync`, temp unlink, then another directory
`fsync`; ordinary rename never publishes a final. Logs are regular files in the same mode-0700
directory. A partial tail, sequence gap, hash mismatch, symlink, changed owner or mode,
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

`SourceActionReceipt` is forbidden when both approvals are false. Its closed
`ApprovedSourceActionSet` always has at least one true member, its `controlPlaneSteps` value is
exactly the singleton typed freeze step, and `sourceBranchFreeze` is never null or missing.
`requestedActions` is exactly the approved close/delete subset in close-then-delete order;
`successfulActions` is exactly the attempts with outcome `succeeded`. Control-plane operations never
appear in either array and live only in `controlPlaneSteps`. A recorded zero exit plus matching
post-state is success; a recorded nonzero exit plus unchanged exact pre-state is failure; a missing
result, contradictory exit/state pair, recreated/moved ref, duplicate/mismatched ruleset, or state
transition that cannot be attributed to the recorded command is ambiguous. After the first failed or
ambiguous requested action, later requested actions are `not-attempted`; the receipt still proceeds.
`receiptState` is `complete` only when every requested action succeeded, `ambiguous` when any action
or control step is ambiguous, and otherwise `partial-failure`.

Either close or delete approval requires the exact repository ruleset named above **before any
source-action intent**. Its normalized
installation response must prove target `branch`, enforcement `active`, the one exact included ref,
no excludes, no bypass actors, sorted rules exactly `creation` and `update`, and no deletion rule.
The tool then queries both the exact ruleset and the effective rules for the branch—even when the
ref is absent—and re-resolves the source tip as `542c8e0bb7ff3afbeee0496f277f8926526cc41a` after the
freeze. Only then may the approved close run, followed by normal
`git push origin --delete feature/aquamobil-v4-redesign` when deletion was also approved. Force and
lease-force options are forbidden. If installation/effective-rule/tip proof fails, neither close nor
delete intent is written, both requested actions are `not-attempted`, the source is retained, and
the protected receipt records the failed or ambiguous control step. A proven ruleset remains active
after close-only as well as delete: after successful deletion its disposition is
`retained-active-prevent-recreation`; otherwise it is
`retained-active-pending-approved-delete-reconciliation`. Removing or weakening it is outside this
approval and requires a separate future authorization.

Receipt, deterministic-report, required-workflow invariant, finalizer-candidate, prospective,
postmerge, finalizer-main, and cleanup validators all apply this same freeze contract when
`closeSourcePullRequest || deleteSourceBranch`; none keys it only to deletion. A `not-proven`
variant is durable evidence of failure, but its `actionExecution: 'forbidden'` requires both
requested actions to have null intent/result/command output and outcome `not-attempted` with reason
`source-branch-freeze-not-proven`. Any close/delete intent or command after `not-proven` is invalid.

The exact outcome matrix is:

| Close approved | Delete approved | Required journal and finalizer behavior                                                                                                                                                                     |
| -------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `false`        | `false`         | No journal, action, control step, action receipt, or post-action refs; source remains exact and the mandatory finalizer carries a closed no-action disposition                                              |
| `true`         | `false`         | Freeze precedes close and remains active; close success requires `CLOSED`/exact present source, while failed or ambiguous close still produces a typed action receipt plus finalizer                        |
| `false`        | `true`          | Freeze precedes delete; success requires absent source and active recreate prevention, while freeze/delete failure or ambiguity remains captured in the typed receipt plus finalizer                        |
| `true`         | `true`          | Freeze precedes close, which precedes delete; complete requires both actions, while close success plus delete failure/ambiguity is a valid partial/ambiguous receipt with exact source state plus finalizer |

Unit fixtures cut the process after every durable intent, remote-command return, result append, and
post-observation append, then resume from the same directory and prove the outcome is reconciled
once without replay. They cover close success/delete failure, nonzero unchanged-state failure,
missing result ambiguity, API timeout after a state change, a source-tip move immediately before
freeze, a tip move between freeze proof and the close intent (with proof that close never ran), a
tip move between freeze proof and delete intent, freeze installation/effective-query
failures, duplicate or bypassed rulesets, update/creation rejection, normal deletion allowance,
recreation rejection after deletion, a two-writer journal race with one `EEXIST` loser, receipt-main
validation failure, cleanup refusal, and a successful resume. Tests also prove the control-plane installation never appears in
requested/successful source actions, force/lease-force arguments are rejected, and successful
deletion leaves the exact ruleset ACTIVE. The no-action fixture proves the finalizer still runs and
that no journal, action receipt, or post-action reference is created.

Close-only negatives independently reject a null or missing freeze, zero or multiple control-plane
steps, a bypass actor, rules other than the exact sorted `creation`/`update` pair, inactive or
ineffective enforcement, a deletion restriction, a missing post-freeze exact-tip reread, and any
close intent/command after `not-proven`. Each fixture proves no close/delete command, disposition,
commit, push, authorization comment, merge authorization, finalizer-main success, or cleanup is
reachable from the invalid receipt.

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
mapfile -t report_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
  --base main --head chore/aquamobil-v4-semantic-supersession | jq -r \
  '.[] | select(.title == "chore(aquamobil): record v4 semantic supersession") | .number')
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
  --require-exhaustive-workflow-runs \
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
node --test \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.spec.mjs"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
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
set -Eeuo pipefail
archive_evidence_clone_root=''
cleanup_archive_evidence_clone() {
  if test -z "$archive_evidence_clone_root"; then
    return 0
  fi
  case "$archive_evidence_clone_root" in
    /tmp/aquamobil-v4-archive-evidence.*) ;;
    *) return 1 ;;
  esac
  test ! -L "$archive_evidence_clone_root"
  test "$archive_evidence_clone_root" != /var/aqua-saas
  test "$archive_evidence_clone_root" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-redesign
  test "$archive_evidence_clone_root" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-coordinator
  test "$archive_evidence_clone_root" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-archive
  test "$archive_evidence_clone_root" != \
    /var/aqua-saas/.git/aquamobil-v4-program-evidence
  if test -e "$archive_evidence_clone_root"; then
    rm -rf -- "$archive_evidence_clone_root"
  fi
}
trap cleanup_archive_evidence_clone EXIT
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
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
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
archive_evidence_clone_root=''
trap - EXIT
CLOSEOUT_PR_KIND=closeout-archive
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-provenance-archive
CLOSEOUT_CANDIDATE_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$CLOSEOUT_CANDIDATE_WORKTREE"
test "$(git branch --show-current)" = "$CLOSEOUT_EXPECTED_HEAD"
PREVIOUS_GENERIC_PR_NUMBER="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$CLOSEOUT_PR_KIND" \
  --expected-head "$CLOSEOUT_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
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
git add -- \
  docs/superpowers/evidence/aquamobil-v4/closeout-run-report-main.json \
  docs/superpowers/evidence/aquamobil-v4/provenance-archive.json \
  docs/superpowers/evidence/aquamobil-v4/closeout-inputs.json \
  docs/superpowers/evidence/aquamobil-v4/live-references.json \
  docs/superpowers/evidence/aquamobil-v4/final-verification.md \
  "$PREVIOUS_PROGRAM_PR_PATH"
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
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-provenance-archive" and (.headRefOid | test("^[0-9a-f]{40}$")))'
CLOSEOUT_PR_NUMBER="$archive_pr_number"
CLOSEOUT_PR_KIND=closeout-archive
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-provenance-archive
CLOSEOUT_REVIEWER_OUTPUT="artifacts/aquamobil-v4/reviews/pr-$archive_pr_number.json"
```

Fresh-shell failure fixtures inject failure at scratch-clone creation, clone/fetch/tag
verification, archive materialization or digesting, report regeneration, `cd`, predecessor-record
materialization/digest checks, staged path/tree checks, formatting, and the pre-commit hook. Strict
mode must stop before commit, push, PR/comment publication, source action, disposition creation, or
merge authorization. The EXIT trap may remove only the exact
`/tmp/aquamobil-v4-archive-evidence.*` clone root and must never remove the archive worktree,
coordinator, source worktree, repository root, program-evidence generations, or any persistent
program worktree.

Execute the complete Mandatory Closeout prospective block. Archive capture preserves the full report
and authorization/check/run/artifact/API bodies and digests; any lineage drift requires a new
generation, report, and comment.

After the authorized archive merge, fetch exact main and prove the merge and protected tag again:

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
mapfile -t archive_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
  --base main --head chore/aquamobil-v4-provenance-archive | jq -r \
  '.[] | select(.title == "chore(aquamobil): protect v4 source provenance") | .number')
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
CLOSEOUT_PR_NUMBER="$ARCHIVE_PR_NUMBER"
CLOSEOUT_PR_KIND=closeout-archive
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-provenance-archive
```

Execute the complete Mandatory Closeout post-merge block. The archive merge makes the report record
main-reachable, so clean report resources exactly. Retain archive and coordinator resources for the
mandatory generic finalizer on all four approval rows.

- [ ] **Step 5: Present exact destructive targets and wait for new approval**

Present the protected-main report, archive tag and ruleset proof, exact source branch
`feature/aquamobil-v4-redesign`, and PR #1107. Ask separately whether to close PR #1107 and whether
to delete the remote branch. Do not reuse prior cleanup approval. Record the two answers separately
as `APPROVED_CLOSE_SOURCE_PR` and `APPROVED_DELETE_SOURCE_BRANCH`; each value is exactly `true` or
`false`. Warn that GitHub may change the PR state as a side effect of deleting its head even when no
explicit PR-close command was approved; that observed server state is not retroactive permission.
Also state that delete approval authorizes installation of the exact source-ref freeze required to
make the deletion race-safe. Closing the PR also has a mutable-head race, so **either** approval
discloses and authorizes installation of that same persistent no-bypass source-ref freeze before
any close or delete intent. That ruleset prevents update and recreation, does not prevent normal
deletion, has no bypass actors, remains active after close-only as well as delete runs, and cannot be
removed or weakened under either approval.

- [ ] **Step 6: Reassert action safety after approval and perform only named actions**

Every invocation begins at this step. The neither-approved branch is selected before journal
creation, proves that the canonical journal path does not exist, and continues to the mandatory
generic closeout finalizer with a closed no-action disposition. An approved-action invocation
creates or resumes exactly one persistent journal; a resumed invocation reconciles any open intent
before it is allowed to schedule another action. For any action row the journaled freeze is
installed, recorded, reread from the API, proved effective with zero bypass actors, and only then is
the exact source tip reread. No PR-close or branch-delete intent may exist before those proofs.

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
  mapfile -t retained_archive_pr_numbers < <(node \
    "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
    --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
    --base main --head chore/aquamobil-v4-provenance-archive | jq -r \
    '.[] | select(.title == "chore(aquamobil): protect v4 source provenance") | .number')
  test "${#retained_archive_pr_numbers[@]}" -eq 1
  RETAINED_ARCHIVE_PR_NUMBER="${retained_archive_pr_numbers[0]}"
  ARCHIVE_MAIN_SHA="$(gh pr view "$RETAINED_ARCHIVE_PR_NUMBER" \
    --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
    --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
  [[ "$ARCHIVE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
  CURRENT_PROTECTED_MAIN_SHA="$(git -C /var/aqua-saas rev-parse origin/main)"
  [[ "$CURRENT_PROTECTED_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
  test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
    "$CURRENT_PROTECTED_MAIN_SHA"
  git -C /var/aqua-saas merge-base --is-ancestor \
    "$ARCHIVE_MAIN_SHA" "$CURRENT_PROTECTED_MAIN_SHA"
  archived_evidence_coordinator_head="$(git -C "$COORDINATOR_WORKTREE" \
    show HEAD:docs/superpowers/evidence/aquamobil-v4/live-references.json | \
    jq -er 'select(.explicitPrCloseApproved == false and .explicitBranchDeleteApproved == false and .coordinatorWorktree.disposition == "retained-intentionally") | .coordinatorWorktree.head')"
  [[ "$archived_evidence_coordinator_head" =~ ^[0-9a-f]{40}$ ]]
  git -C "$COORDINATOR_WORKTREE" cat-file -e \
    "$archived_evidence_coordinator_head^{commit}"
  git -C /var/aqua-saas merge-base --is-ancestor \
    "$archived_evidence_coordinator_head" "$ARCHIVE_MAIN_SHA"
  test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
  test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
  test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
    "$CURRENT_PROTECTED_MAIN_SHA"
  CLOSEOUT_DISPOSITION=no-action
  printf 'No remote action approved; mandatory closeout finalizer continues at current protected main %s (archive result %s).\n' \
    "$CURRENT_PROTECTED_MAIN_SHA" "$ARCHIVE_MAIN_SHA"
else
  CLOSEOUT_DISPOSITION=source-actions
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
  --install-and-verify-source-freeze "$ACTION_JOURNAL_DIR" \
  --repository Okan-wqm/aquaculture_platform \
  --source-ref refs/heads/feature/aquamobil-v4-redesign \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source-freeze-ruleset-name "AquaMobil v4 source ref freeze 542c8e0" \
  --retain-source-freeze-ruleset \
  --require-empty-bypass-actors \
  --reread-exact-source-tip-before-any-source-action
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
fi
```

The executor uses argument arrays, never a shell. For either approved action it first journals the
control-plane intent, installs the exact active source-ref ruleset, journals the API result, proves
its exact/effective normalized state and empty bypass list, and then rereads the source ref at the
exact tip. Only after that ordered freeze proof may close approval write its close intent and run
exactly `gh pr close 1107 --repo Okan-wqm/aquaculture_platform` with the pinned
semantic-supersession comment. It durably writes the result before observing the PR. Delete approval
then writes its distinct delete intent and runs only normal
`git push origin --delete feature/aquamobil-v4-redesign`, records the result immediately, and
observes both ref and ruleset. When both are approved, the sole order is
freeze → close → delete; when close alone is approved, the freeze remains ACTIVE. It never passes a
force or lease-force option.

A nonzero action exit is a durably recorded `failed` outcome, not a reason to omit the receipt. An
unattributable state, interruption gap, or contradictory command/state result becomes `ambiguous`;
the executor never retries it. A failed/ambiguous close makes approved deletion `not-attempted`; a
failed/ambiguous freeze makes deletion `not-attempted`. All coherent terminal outcomes return to the
receipt path. Only journal-integrity, durability, identity, or authentication failure stops here,
with the persistent records retained for the next exact resume. In the neither-approved case, the
coordinator stays at the freshly fetched exact current protected-main commit after proving the
archive PR result is its ancestor. The older head serialized by the protected report is verified
only as an ancestor of that archive result and is never a retention or switch target; any future
coordination begins with the canonical refresh again.

Fixtures move `feature/aquamobil-v4-redesign` after the freeze precheck but before the last
pre-action tip reread. The executor must journal the mismatch and prove that no close intent, close
command, delete intent, or delete command ran. They also pin all four approval rows and the ordered
freeze → close → delete event sequence; close-only retains the same effective no-bypass freeze.

- [ ] **Step 7: Create the mandatory generic closeout finalizer branch**

Run this step for all four approval rows. Re-establish both uppercase booleans from the explicit
decision; do not default either value. The branch is always the generic `closeout-receipt`
finalizer and always commits closed `closeout-disposition.json`. When an action was approved it also
resumes/finalizes the journal and derives the immutable action receipt and post-action references
from journal plus fresh authenticated observations. When neither was approved it proves the journal
absent, creates no destructive intent, action receipt, or post-action reference file, and records a
closed no-action disposition that binds a newly regenerated same-path initial live-reference file
and archive result. That fresh exhaustive observation occurs immediately before disposition/report
generation and requires the source ref present at the immutable SHA plus PR #1107 OPEN, non-draft,
and at the exact head/ref/SHA/base identity; the archive-era copy is never reused as current truth.
The finalizer's protected merge, postmerge recovery-comment round trip, and tree proof are mandatory
in both cases and are the sole terminal external anchor.

```bash
set -Eeuo pipefail
receipt_clone_root=''
cleanup_receipt_clone() {
  if test -z "$receipt_clone_root"; then
    return 0
  fi
  case "$receipt_clone_root" in
    /tmp/aquamobil-v4-receipt.*) ;;
    *) return 1 ;;
  esac
  test ! -L "$receipt_clone_root"
  test "$receipt_clone_root" != /var/aqua-saas
  test "$receipt_clone_root" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-redesign
  test "$receipt_clone_root" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-coordinator
  test "$receipt_clone_root" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-closeout-receipt
  test "$receipt_clone_root" != \
    /var/aqua-saas/.git/aquamobil-v4-program-evidence
  if test -e "$receipt_clone_root"; then
    rm -rf -- "$receipt_clone_root"
  fi
}
trap cleanup_receipt_clone EXIT
: "${APPROVED_DELETE_SOURCE_BRANCH:?re-enter the explicit branch-deletion approval boolean}"
: "${APPROVED_CLOSE_SOURCE_PR:?re-enter the explicit PR-close approval boolean}"
[[ "$APPROVED_DELETE_SOURCE_BRANCH" =~ ^(true|false)$ ]]
[[ "$APPROVED_CLOSE_SOURCE_PR" =~ ^(true|false)$ ]]
if test "$APPROVED_DELETE_SOURCE_BRANCH" = true || \
  test "$APPROVED_CLOSE_SOURCE_PR" = true; then
  HAS_SOURCE_ACTIONS=true
else
  HAS_SOURCE_ACTIONS=false
fi
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
if test "$HAS_SOURCE_ACTIONS" = true; then
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
else
  test ! -e "$ACTION_JOURNAL_DIR"
fi
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
receipt_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-closeout-receipt
test ! -e "$receipt_worktree"
git -C /var/aqua-saas worktree add "$receipt_worktree" \
  -b chore/aquamobil-v4-closeout-receipt origin/main
cd "$receipt_worktree"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
git diff --exit-code -- package-lock.json
if test "$HAS_SOURCE_ACTIONS" = true; then
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
  --require-exhaustive-source-and-pr-observation \
  --write docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --write-closeout-disposition docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --disposition source-actions \
  --action-receipt docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
  --live-references docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --approved-close-source-pr "$APPROVED_CLOSE_SOURCE_PR" \
  --approved-delete-source-branch "$APPROVED_DELETE_SOURCE_BRANCH" \
  --require-fresh-finalizer-observation \
  --observe-remote \
  --require-exhaustive-source-and-pr-observation
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --write \
  --live-references docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --action-receipt docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
  --closeout-disposition docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --check \
  --live-references docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --action-receipt docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
  --closeout-disposition docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json
else
  test ! -e docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json
  test ! -e docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-live-references.mjs" \
    --repository Okan-wqm/aquaculture_platform \
    --coordinator-worktree "$COORDINATOR_WORKTREE" \
    --coordinator-disposition cleanup-after-receipt-main \
    --write docs/superpowers/evidence/aquamobil-v4/live-references.json \
    --source-ref refs/heads/feature/aquamobil-v4-redesign \
    --expected-source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
    --source-pr 1107 \
    --explicit-pr-close-approved false \
    --explicit-branch-delete-approved false \
    --expected-source-ref-state PRESENT \
    --expected-pr-state OPEN \
    --expected-pr-draft false \
    --expected-pr-head feature/aquamobil-v4-redesign \
    --expected-pr-base main \
    --expected-pr-head-sha 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
    --observe-remote \
    --require-exhaustive-source-and-pr-observation
  NO_ACTION_LIVE_REFERENCES_SHA256="$(sha256sum \
    docs/superpowers/evidence/aquamobil-v4/live-references.json | cut -d' ' -f1)"
  [[ "$NO_ACTION_LIVE_REFERENCES_SHA256" =~ ^[0-9a-f]{64}$ ]]
  NO_ACTION_LIVE_REFERENCES_BLOB_SHA="$(git hash-object -- \
    docs/superpowers/evidence/aquamobil-v4/live-references.json)"
  [[ "$NO_ACTION_LIVE_REFERENCES_BLOB_SHA" =~ ^[0-9a-f]{40}$ ]]
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
    --write-closeout-disposition docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
    --disposition no-action \
    --live-references docs/superpowers/evidence/aquamobil-v4/live-references.json \
    --live-references-sha256 "$NO_ACTION_LIVE_REFERENCES_SHA256" \
    --live-references-blob-sha "$NO_ACTION_LIVE_REFERENCES_BLOB_SHA" \
    --provenance-evidence docs/superpowers/evidence/aquamobil-v4/provenance-archive.json \
    --approved-close-source-pr false --approved-delete-source-branch false \
    --require-fresh-finalizer-observation \
    --observe-remote \
    --require-exhaustive-source-and-pr-observation
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --write \
    --live-references docs/superpowers/evidence/aquamobil-v4/live-references.json \
    --closeout-disposition docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/generate-closeout-report.mjs" --check \
    --live-references docs/superpowers/evidence/aquamobil-v4/live-references.json \
    --closeout-disposition docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json
fi
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
test -n "$receipt_clone_root"
[[ "$receipt_clone_root" == /tmp/aquamobil-v4-receipt.* ]]
test "$receipt_clone_root" != /var/aqua-saas
rm -rf -- "$receipt_clone_root"
test ! -e "$receipt_clone_root"
receipt_clone_root=''
trap - EXIT
if test "$HAS_SOURCE_ACTIONS" = true; then
  test -d "$ACTION_JOURNAL_DIR"
  test ! -L "$ACTION_JOURNAL_DIR"
else
  test ! -e "$ACTION_JOURNAL_DIR"
fi
```

Fresh-shell failure fixtures independently fail approval parsing, journal-absence proof, journal
resume/finalization, scratch-clone creation, clone/fetch/tag verification, persistent receipt
worktree creation, `cd`, install/lock checks, the fresh source-ref or exhaustive PR observation,
live-reference hashing, disposition materialization, report generation/checking, and ledger
verification. Every failure proves no later disposition/report write (when its prerequisite failed),
commit, push, PR/comment publication, merge authorization, finalizer-main success, journal cleanup,
or program-worktree cleanup is reachable. On false/false, a journal, action receipt, post-action
reference, source intent, or source command must remain absent. The EXIT trap may remove only the
exact `/tmp/aquamobil-v4-receipt.*` clone; it must retain the persistent receipt worktree and every
repository, source, coordinator, archive, and program-evidence path for recovery.

When present, do not remove or truncate the journal here. It remains the coordinator-owned recovery
authority until the finalizer commit is on protected main, the exact finalizer-main workflow has
succeeded, and the final local administrative/effective-rules reconciliation in Step 8 has passed.
The no-action row has no journal to retain.

- [ ] **Step 8: Review, merge, and verify the receipt on main**

```bash
set -Eeuo pipefail
: "${APPROVED_CLOSE_SOURCE_PR:?re-enter the explicit PR-close approval boolean}"
: "${APPROVED_DELETE_SOURCE_BRANCH:?re-enter the explicit branch-deletion approval boolean}"
[[ "$APPROVED_CLOSE_SOURCE_PR" =~ ^(true|false)$ ]]
[[ "$APPROVED_DELETE_SOURCE_BRANCH" =~ ^(true|false)$ ]]
if test "$APPROVED_CLOSE_SOURCE_PR" = true || \
  test "$APPROVED_DELETE_SOURCE_BRANCH" = true; then
  HAS_SOURCE_ACTIONS=true
else
  HAS_SOURCE_ACTIONS=false
fi
cd /var/aqua-saas/.worktrees/aquamobil-v4-closeout-receipt
CLOSEOUT_PR_KIND=closeout-receipt
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-closeout-receipt
CLOSEOUT_CANDIDATE_WORKTREE="$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$CLOSEOUT_CANDIDATE_WORKTREE"
test "$(git branch --show-current)" = "$CLOSEOUT_EXPECTED_HEAD"
PREVIOUS_GENERIC_PR_NUMBER="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --print-immediately-previous-generic-program-pr --for-pr-kind "$CLOSEOUT_PR_KIND" \
  --expected-head "$CLOSEOUT_EXPECTED_HEAD" --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main)"
[[ "$PREVIOUS_GENERIC_PR_NUMBER" =~ ^[0-9]+$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
PREVIOUS_PROGRAM_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$PREVIOUS_GENERIC_PR_NUMBER"
PREVIOUS_PROGRAM_PR_GENERATION="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
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
# The candidate already contains every older numeric record made main-reachable by the chain; its
# own result remains the terminal external anchor.
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --check-closeout-finalizer-observation \
    docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --initial-live-references docs/superpowers/evidence/aquamobil-v4/live-references.json \
  --post-action-live-references \
    docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --candidate-worktree "$CLOSEOUT_CANDIDATE_WORKTREE" \
  --repository Okan-wqm/aquaculture_platform \
  --observe-remote \
  --require-exhaustive-source-and-pr-observation
git add -- \
  docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  docs/superpowers/evidence/aquamobil-v4/final-verification.md \
  "$PREVIOUS_PROGRAM_PR_PATH"
if test "$HAS_SOURCE_ACTIONS" = true; then
  git add -- \
    docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json \
    docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json
else
  test ! -e docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json
  test ! -e docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json
  git add -- docs/superpowers/evidence/aquamobil-v4/live-references.json
fi
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(aquamobil): record v4 closeout disposition" \
  -m "Bind the closed action or no-action disposition, observed source state, and fresh-clone archive recovery proof to the terminal external anchor."
git push --set-upstream origin chore/aquamobil-v4-closeout-receipt
receipt_pr_url="$(gh pr create \
  --repo Okan-wqm/aquaculture_platform \
  --base main \
  --head chore/aquamobil-v4-closeout-receipt \
  --title "chore(aquamobil): record v4 closeout disposition" \
  --body "Records the closed action or no-action disposition, any terminal attempts and controls, observed remote state, and fresh-clone recovery proof.")"
receipt_pr_number="$(gh pr view "$receipt_pr_url" --repo Okan-wqm/aquaculture_platform --json number --jq '.number')"
gh pr checks "$receipt_pr_number" --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$receipt_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-closeout-receipt" and (.headRefOid | test("^[0-9a-f]{40}$")))'
CLOSEOUT_PR_NUMBER="$receipt_pr_number"
CLOSEOUT_PR_KIND=closeout-receipt
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-closeout-receipt
CLOSEOUT_REVIEWER_OUTPUT="artifacts/aquamobil-v4/reviews/pr-$receipt_pr_number.json"
```

Fresh-shell failure fixtures independently fail approval parsing, candidate `cd`, predecessor
materialization/digest validation, finalizer-observation binding, staged path/tree checks, formatting,
the pre-commit hook, and the post-hook cached-tree comparison. Each failure must stop before commit,
push, PR creation, authorization-comment publication, merge authorization, source action,
finalizer-main success, or cleanup. A false/false fixture additionally proves that omission of the
freshly regenerated `live-references.json` from the staged candidate fails before commit.

Execute the complete Mandatory Closeout prospective block. It also proves every prior numeric
`ProgramPrEvidence` file is present in the receipt candidate through the finite append-only chain.

After the authorized receipt merge:

```bash
set -euo pipefail
cleanup_cwd=''
cleanup_closeout_scratch_cwd() {
  if test -z "$cleanup_cwd"; then
    return 0
  fi
  case "$cleanup_cwd" in
    /tmp/aquamobil-v4-worktree-cleanup.*) ;;
    *) return 1 ;;
  esac
  test ! -L "$cleanup_cwd"
  test "$cleanup_cwd" != /var/aqua-saas
  test "$cleanup_cwd" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-redesign
  test "$cleanup_cwd" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-coordinator
  test "$cleanup_cwd" != \
    /var/aqua-saas/.worktrees/aquamobil-v4-closeout-receipt
  test "$cleanup_cwd" != \
    /var/aqua-saas/.git/aquamobil-v4-program-evidence
  if test -d "$cleanup_cwd"; then
    if test "$(pwd -P)" = "$cleanup_cwd"; then
      cd /tmp
    fi
    rmdir -- "$cleanup_cwd"
  fi
}
trap cleanup_closeout_scratch_cwd EXIT
: "${APPROVED_CLOSE_SOURCE_PR:?re-enter the explicit PR-close approval boolean}"
: "${APPROVED_DELETE_SOURCE_BRANCH:?re-enter the explicit branch-deletion approval boolean}"
[[ "$APPROVED_CLOSE_SOURCE_PR" =~ ^(true|false)$ ]]
[[ "$APPROVED_DELETE_SOURCE_BRANCH" =~ ^(true|false)$ ]]
if test "$APPROVED_CLOSE_SOURCE_PR" = true || \
  test "$APPROVED_DELETE_SOURCE_BRANCH" = true; then
  HAS_SOURCE_ACTIONS=true
else
  HAS_SOURCE_ACTIONS=false
fi
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
receipt_worktree=/var/aqua-saas/.worktrees/aquamobil-v4-closeout-receipt
test -d "$COORDINATOR_WORKTREE"
test -d "$receipt_worktree"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mapfile -t receipt_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
  --base main --head chore/aquamobil-v4-closeout-receipt | jq -r \
  '.[] | select(.title == "chore(aquamobil): record v4 closeout disposition") | .number')
test "${#receipt_pr_numbers[@]}" -eq 1
RECEIPT_PR_NUMBER="${receipt_pr_numbers[0]}"
RECEIPT_MAIN_SHA="$(gh pr view "$RECEIPT_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$RECEIPT_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /var/aqua-saas merge-base --is-ancestor "$RECEIPT_MAIN_SHA" origin/main
CLOSEOUT_PR_NUMBER="$RECEIPT_PR_NUMBER"
CLOSEOUT_PR_KIND=closeout-receipt
CLOSEOUT_EXPECTED_HEAD=chore/aquamobil-v4-closeout-receipt
```

Execute the complete Mandatory Closeout post-merge spool/recovery-comment/tree-proof block before
any journal or worktree cleanup. Verify the canonical remote payload can recreate a missing local
generation, then run:

```bash
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --check-closeout-finalizer-observation-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --initial-live-references-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/live-references.json \
  --post-action-live-references-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --repository Okan-wqm/aquaculture_platform \
  --observe-remote \
  --require-exhaustive-source-and-pr-observation
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --require-all-prior-generic-program-prs-main-reachable \
  --receipt-main "$RECEIPT_MAIN_SHA" \
  --program-pr-generation "$CLOSEOUT_PR_GENERATION" \
  --repository Okan-wqm/aquaculture_platform
cd "$receipt_worktree"
mkdir -p artifacts/aquamobil-v4-closeout
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-closeout-run.mjs" \
  --dispatch-and-wait \
  --require-exhaustive-workflow-runs \
  --repository Okan-wqm/aquaculture_platform \
  --workflow .github/workflows/aquamobil-v4-closeout.yml \
  --ref main \
  --expected-head "$RECEIPT_MAIN_SHA" \
  --require-closeout-finalizer-observation-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --require-exhaustive-source-and-pr-observation \
  --artifact-name aquamobil-v4-closeout-evidence \
  --write artifacts/aquamobil-v4-closeout/receipt-main-run.json
jq -e --arg head "$RECEIPT_MAIN_SHA" \
  '.kind == "github-workflow-run" and .conclusion == "success" and .event == "workflow_dispatch" and .apiHeadSha == $head' \
  artifacts/aquamobil-v4-closeout/receipt-main-run.json
RECEIPT_MAIN_RUN_ID="$(jq -er '.runId | select(type == "number")' \
  artifacts/aquamobil-v4-closeout/receipt-main-run.json)"
RECEIPT_MAIN_RUN_URL="$(jq -er '.url | select(type == "string")' \
  artifacts/aquamobil-v4-closeout/receipt-main-run.json)"
test "$RECEIPT_MAIN_RUN_URL" = \
  "https://github.com/Okan-wqm/aquaculture_platform/actions/runs/$RECEIPT_MAIN_RUN_ID"
gh run view "$RECEIPT_MAIN_RUN_ID" --repo Okan-wqm/aquaculture_platform \
  --json conclusion,event,headSha,url \
  --jq --arg head "$RECEIPT_MAIN_SHA" \
  'select(.conclusion == "success" and .event == "workflow_dispatch" and .headSha == $head)'
printf 'Receipt-main workflow evidence: %s\n' "$RECEIPT_MAIN_RUN_URL"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --check-closeout-finalizer-observation-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --initial-live-references-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/live-references.json \
  --post-action-live-references-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --repository Okan-wqm/aquaculture_platform \
  --observe-remote \
  --require-exhaustive-source-and-pr-observation
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --repository Okan-wqm/aquaculture_platform \
  --ruleset-name "AquaMobil v4 provenance tags" \
  --tag refs/tags/archive/aquamobil-v4-redesign-542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --source 542c8e0bb7ff3afbeee0496f277f8926526cc41a \
  --assert-remote-protected
GIT_COMMON_DIR="$(git -C /var/aqua-saas rev-parse --path-format=absolute --git-common-dir)"
test "$GIT_COMMON_DIR" = /var/aqua-saas/.git
ACTION_JOURNAL_DIR="$GIT_COMMON_DIR/aquamobil-v4-source-actions/source-542c8e0bb7ff3afbeee0496f277f8926526cc41a-pr-1107"
if test "$HAS_SOURCE_ACTIONS" = true; then
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
  --closeout-disposition-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --require-closeout-finalizer-observation \
  --observe-remote \
  --retain-source-freeze-ruleset
test ! -e "$ACTION_JOURNAL_DIR"
else
  test ! -e "$ACTION_JOURNAL_DIR"
  test ! -e docs/superpowers/evidence/aquamobil-v4/source-action-receipt.json
  test ! -e docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json
  git -C /var/aqua-saas cat-file -e \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json
  test "$(git -C /var/aqua-saas show \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json | \
    jq -r '.disposition')" = no-action
fi
test "$receipt_worktree" != "/var/aqua-saas"
test -z "$(git -C "$receipt_worktree" status --porcelain)"
test "$(git -C "$receipt_worktree" branch --show-current)" = \
  chore/aquamobil-v4-closeout-receipt
RECEIPT_REVIEWED_HEAD="$(gh pr view "$RECEIPT_PR_NUMBER" \
  --repo Okan-wqm/aquaculture_platform --json headRefOid --jq '.headRefOid')"
[[ "$RECEIPT_REVIEWED_HEAD" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$receipt_worktree" rev-parse HEAD)" = "$RECEIPT_REVIEWED_HEAD"
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-provenance-archive.mjs" \
  --check-closeout-finalizer-observation-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --initial-live-references-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/live-references.json \
  --post-action-live-references-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/live-references-post-action.json \
  --repository Okan-wqm/aquaculture_platform \
  --observe-remote \
  --require-exhaustive-source-and-pr-observation
: "${APPROVE_ARCHIVE_PROGRAM_CLEANUP:?type chore/aquamobil-v4-provenance-archive}"
: "${APPROVE_RECEIPT_PROGRAM_CLEANUP:?type chore/aquamobil-v4-closeout-receipt}"
test "$APPROVE_ARCHIVE_PROGRAM_CLEANUP" = chore/aquamobil-v4-provenance-archive
test "$APPROVE_RECEIPT_PROGRAM_CLEANUP" = chore/aquamobil-v4-closeout-receipt
mapfile -t archive_cleanup_pr_numbers < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform --state merged \
  --base main --head chore/aquamobil-v4-provenance-archive | jq -r '.[].number')
test "${#archive_cleanup_pr_numbers[@]}" -eq 1
ARCHIVE_PR_NUMBER="${archive_cleanup_pr_numbers[0]}"
ARCHIVE_PR_ROOT="$GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$ARCHIVE_PR_NUMBER"
ARCHIVE_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$ARCHIVE_PR_ROOT" \
  --pull-request "$ARCHIVE_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind closeout-archive \
  --from-postmerge-recovery-comment)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --authorize-program-pr-cleanup "$ARCHIVE_PR_NUMBER" \
  --program-pr-generation "$ARCHIVE_PR_GENERATION" \
  --require-remote-postmerge-roundtrip \
  --require-closeout-finalizer-observation-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --observe-remote \
  --require-main-reachable-durable-record
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup-program-pr \
  --pull-request "$ARCHIVE_PR_NUMBER" \
  --expected-head chore/aquamobil-v4-provenance-archive \
  --repository Okan-wqm/aquaculture_platform --main-ref origin/main
git -C /var/aqua-saas push origin --delete chore/aquamobil-v4-provenance-archive
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --delete-verified-program-pr-generation "$ARCHIVE_PR_GENERATION" \
  --pull-request "$ARCHIVE_PR_NUMBER" --require-remote-postmerge-roundtrip
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --authorize-program-pr-cleanup "$RECEIPT_PR_NUMBER" \
  --program-pr-generation "$CLOSEOUT_PR_GENERATION" \
  --require-remote-postmerge-roundtrip \
  --require-closeout-finalizer-observation-from-ref \
    origin/main:docs/superpowers/evidence/aquamobil-v4/closeout-disposition.json \
  --observe-remote \
  --allow-terminal-external-anchor-only-for-closeout-receipt
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup-program-pr \
  --pull-request "$RECEIPT_PR_NUMBER" \
  --expected-head chore/aquamobil-v4-closeout-receipt \
  --repository Okan-wqm/aquaculture_platform --main-ref origin/main
git -C /var/aqua-saas push origin --delete chore/aquamobil-v4-closeout-receipt
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --delete-verified-program-pr-generation "$CLOSEOUT_PR_GENERATION" \
  --pull-request "$RECEIPT_PR_NUMBER" --require-remote-postmerge-roundtrip
cleanup_cwd="$(mktemp -d /tmp/aquamobil-v4-worktree-cleanup.XXXXXXXX)"
test -d "$cleanup_cwd"
[[ "$cleanup_cwd" == /tmp/aquamobil-v4-worktree-cleanup.* ]]
cd "$cleanup_cwd"
test ! -e "$receipt_worktree"
git -C /var/aqua-saas worktree remove "$COORDINATOR_WORKTREE"
test ! -e "$COORDINATOR_WORKTREE"
cd /tmp
rmdir "$cleanup_cwd"
test ! -e "$cleanup_cwd"
cleanup_cwd=''
trap - EXIT
```

Postmerge cleanup failure fixtures run in a fresh strict shell and fail approval parsing, canonical
recovery, each current source/PR reread, finalizer-main selection, journal reconciliation, cleanup
authorization, scratch-directory creation, and scratch `cd` independently. No later journal,
generation, remote branch, receipt/archive worktree, or coordinator cleanup may run. The EXIT trap
may remove only the exact empty `/tmp/aquamobil-v4-worktree-cleanup.*` directory; it must never
remove a repository, source/coordinator/program worktree, journal, or evidence generation.

Race fixtures mutate or delete the source ref and independently change PR #1107 state, draft flag,
head name, head SHA, or base at four boundaries: after the archive but before false/false finalizer
capture, after candidate capture but before prospective authorization, after candidate/prospective
proof but before finalizer-main, and after finalizer-main but before cleanup. The first boundary must
prevent live-reference/disposition/report creation and therefore commit/push; the second must fail the
required candidate remote check or trusted prospective verifier and prevent authorization/merge; the
third must fail postmerge/finalizer-main success; the fourth must fail journal, generation, remote
branch, and worktree cleanup. Later-page-only PR/ref observations, omitted advertised pages,
`total_count` mismatch, page loops, and cross-page duplicate identities fail at every trusted reread.
Candidate emitters and the offline candidate checker remain tokenless in all fixtures.

Expected: protected main always contains the closed finalizer disposition and an exact
finalizer-main closeout dispatch is successful and externally reportable by its captured URL. For
an action row, the receipt records both approvals, exact requested/attempted/successful action sets,
separate control-plane evidence, current PR/ref state, and retained active source-freeze disposition;
only after the workflow, journal chain, remote state, and administrative/effective ruleset proof
agree is the journal removed. For the no-action row, neither action receipt nor post-action live
reference nor journal exists, and the disposition binds the unchanged source and freshly
regenerated, exhaustively API-bound initial live references. The signed archive resolves all 35
objects from a fresh clone in either row. Only after
the generic finalizer's externally recoverable postmerge round trip may the finalizer/archive and
coordinator worktrees be removed from a validated scratch cwd; its remote recovery payload is the
sole terminal anchor.
