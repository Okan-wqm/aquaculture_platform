# AquaMobil v4 Delivery and Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish an honest `/mobile/` deployment boundary, one CSP-safe appearance authority,
generation-safe offline updates, semantic design primitives, and an evidence-backed final removal of
Konsta and the legacy `.dark` contract.

**Architecture:** The droplet edge strips `/mobile/` and proxies to a static inner nginx. Revisioned
shell assets are served only when present; SPA fallback applies only to navigation. A typed
appearance source is bundled as a blocking content-hashed classic IIFE and exposes one versioned
snapshot/subscription API to React. The service worker and clients exchange immutable build IDs so
an old controlled document retains its complete shell generation until it reloads.

**Tech Stack:** nginx, Docker, GitHub Actions, Vite 7, esbuild 0.27.7, TypeScript, React 19, Workbox
7, vite-plugin-pwa, Vitest, Playwright, CSS custom properties, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md`

## Global Constraints

- Consume the program plan's machine-checked Step 0 result: immutable
  `designMainCommit=4002868c535a2d8676aad6eadd5f4bbd57d4625b` is only the design snapshot;
  generated `order0BaseMainCommit` is the fetched post-#1333 protected-main ancestor that contains
  all seven reviewed planning blobs and Order 0. Every delivery preflight base must descend from it.
- Execute I1 and V0 before product slice V1. Execute the UI convergence tasks only after V5.
- Enter I1, V0, and UI convergence only through the exact linked worktree created by
  `tools/aquamobil-v4/worktree.mjs` from a forced, freshly fetched protected `origin/main`. Each
  implementation branch creates and stages only its own append-only `preflight.json`; it never edits
  `execution-ledger.json`, a slice `merge.json`, a closure record, or another slice's evidence. Skip
  every direct branch-creation instruction superseded by the program coordinator.
- Test production authority through `infrastructure/nginx/droplet.conf` and
  `infrastructure/docker/nginx/aquamobil.conf`; `nginx.prod.conf` is not the droplet authority.
- Preserve AquaMobil base `/mobile/`, the handwritten `injectManifest` worker, GraphQL no-cache,
  logout purge, foreground and closed-client replay, and the Firebase messaging worker's deeper
  sub-scope.
- `infrastructure/security/csp.policy.json` remains the CSP input authority. Generated nginx policy
  output is never edited alone.
- No inline appearance script, stable `public/theme-init.js`, script/style-element `unsafe-inline`,
  no-store freshness substitute, duplicate React store, or unconditional old-cache deletion is
  permitted. The V0 CSP has one reviewed exception: `style-src-attr 'unsafe-inline'` for React's
  existing dynamic style attributes and virtualization CSSOM writes; scripts and `<style>` elements
  remain external-only, and convergence may remove this exception only after a measured migration.
- V0 preserves `light | dark | system`, `.dark`, and `standard | glove`. Convergence changes the
  same authority atomically to `night | day | colour | system`, removes `.dark`, and deletes legacy
  storage only after writing the versioned v4 record.
- The current measured V0 ratchets are 1,317 `dark:` variants, 333 legacy palette uses, 1,490 stock
  gray utilities, 86 sub-12px text uses, zero sub-10px uses, and eight files importing Konsta.
  Re-measure against the slice base; a mismatch blocks execution until the plan records the new
  reviewed values.
- A PR whose implementation commits carry `Closes:` trailers must preserve those exact uppercase
  trailers on a main-reachable commit. Use a commit-preserving merge, or configure the squash
  body with every exact trailer and inspect the prospective message before merge. A merge mode that
  drops trailers is blocked because the post-merge registry ceremony cannot truthfully close them.
- Read root `CLAUDE.md` before every task and again before every commit. Before Task 3, also read
  `apps/farm-service/CLAUDE.md`, `apps/gateway-api/CLAUDE.md`, `apps/admin-api-service/CLAUDE.md`,
  and `apps/messaging-service/CLAUDE.md`. Before every AquaMobil task, read both `web/CLAUDE.md` and
  `web/apps/aquamobil/CLAUDE.md`. The standalone package lock and Docker `npm ci --ignore-scripts`
  path are first-class authorities.
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

- A delivery task that modifies `.github/workflows/ci-affected.yml`,
  `.github/workflows/ci-full.yml`, `.github/workflows/aria-merge-authority.yml`, or
  `.github/manifests/main-required-status-checks.json` must preserve Order 0's mandatory terminal-job
  checkout/emitter/upload wiring and manifest path pins. The four required contexts resolve to
  exactly three artifacts: CI-Affected `merge-gate` produces the artifact shared by `merge-gate` and
  `sens-enterprise-summary`; CI Full `build-status` and ARIA `aria-merge-authority` each produce one.
  `.github/workflows/aquamobil-delivery.yml` remains a reusable domain lane, never a fourth candidate
  evidence workflow.

- Vendor Geist and Geist Mono only from Fontsource variable packages `5.3.0`, whose npm integrity
  values are respectively
  `sha512-j0m+vLQuG5XAYoHtGCVu0spvlGreR3EzpECUVzkFmI1mTVnAO38l/NEPDCFgZ177JxzYJCLSmTQibIiYPilGrA==`
  and
  `sha512-vBbuwDEo9AkrqADMXOrlAR3DFcJi4/JxeuU43FoiQERnNwsfXNnvxvReZG02cQKmyk4DZkZdBZX3oTDvy2zBAw==`.
  Commit their OFL-1.1 notices and verify the four selected binary hashes; never download a mutable
  font URL during the application build.

## Mandatory Delivery PR Base-Advance Gate

After the final push and immediately before authorizing each I1, V0, or UI-convergence
implementation merge, set `DELIVERY_SLICE` to its exact literal and run this complete gate from its
active canonical worktree:

```bash
set -euo pipefail
: "${DELIVERY_SLICE:?set DELIVERY_SLICE to I1, V0, or UI-convergence}"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
case "$DELIVERY_SLICE" in
  I1)
    DELIVERY_BOUNDARY=asset-storage-and-tls-boundary
    DELIVERY_BRANCH=fix/aquamobil-i1-asset-boundary
    ;;
  V0)
    DELIVERY_BOUNDARY=appearance-foundation
    DELIVERY_BRANCH=feat/aquamobil-v0-appearance-foundation
    ;;
  UI-convergence)
    DELIVERY_BOUNDARY=ui-convergence
    DELIVERY_BRANCH=feat/aquamobil-v4-ui-convergence
    ;;
  *) exit 2 ;;
esac
ACTIVE_DELIVERY_WORKTREE="$(git rev-parse --show-toplevel)"
delivery_preflight="docs/superpowers/evidence/aquamobil-v4/slices/$DELIVERY_SLICE/preflight.json"
test "$(git branch --show-current)" = "$DELIVERY_BRANCH"
test -f "$delivery_preflight"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
git merge-base --is-ancestor "$(jq -r '.baseMainCommit' "$delivery_preflight")" origin/main
test -d "$COORDINATOR_WORKTREE"
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
cd "$ACTIVE_DELIVERY_WORKTREE"
delivery_pr_number="$(gh pr view --repo Okan-wqm/aquaculture_platform \
  --json number --jq '.number')"
gh pr checks "$delivery_pr_number" \
  --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$delivery_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and (.headRefOid | test("^[0-9a-f]{40}$")))'
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas \
  rev-parse --path-format=absolute --git-common-dir)"
test "$PROGRAM_GIT_COMMON_DIR" = /var/aqua-saas/.git
DELIVERY_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$delivery_pr_number"
DELIVERY_REVIEWER_OUTPUT="artifacts/aquamobil-v4/reviews/pr-$delivery_pr_number.json"
DELIVERY_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --initialize-program-pr-spool "$DELIVERY_PR_ROOT" \
  --write-independent-review-input \
  --pull-request "$delivery_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind implementation-boundary \
  --expected-head "$DELIVERY_BRANCH" \
  --slice "$DELIVERY_SLICE" \
  --boundary "$DELIVERY_BOUNDARY" \
  --verify-base-advance \
  --require-current-pr-test-merge-candidate \
  --print-program-pr-generation)"
[[ "$DELIVERY_PR_GENERATION" == "$DELIVERY_PR_ROOT"/generations/* ]]
DELIVERY_SET_DIGEST="${DELIVERY_PR_GENERATION##*/}"
[[ "$DELIVERY_SET_DIGEST" =~ ^[0-9a-f]{64}$ ]]
```

Stop for an independent agent. It reads exactly
`$DELIVERY_PR_GENERATION/review/review-input.json` and
writes canonical `ProgramIndependentReviewReport` to `$DELIVERY_REVIEWER_OUTPUT`. Resume with:

```bash
test -s "$DELIVERY_REVIEWER_OUTPUT"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --ingest-independent-review-report "$DELIVERY_REVIEWER_OUTPUT" \
  --program-pr-generation "$DELIVERY_PR_GENERATION"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --write-authorization-comment-envelope \
  --program-pr-generation "$DELIVERY_PR_GENERATION"
gh pr comment "$delivery_pr_number" --repo Okan-wqm/aquaculture_platform \
  --body-file "$DELIVERY_PR_GENERATION/authorization/authorization-comment-envelope.md"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-pr "$delivery_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --slice "$DELIVERY_SLICE" \
  --boundary "$DELIVERY_BOUNDARY" \
  --verify-base-advance \
  --require-current-pr-test-merge-candidate \
  --program-pr-generation "$DELIVERY_PR_GENERATION" \
  --write-prospective-spool \
  --require-registry-trailers
```

The coordinator derives the exact `baseMainCommit..reviewedBaseMainCommit` path set and intersects
it with the preflight's owned and shared-authority paths. Zero overlap can pass only when all
four required contexts attest the current ordinary `pull_request` test-merge candidate through
exactly the three mandatory artifacts. The emitters share only `N/B/H/C/T/[B,H]` and
`canonicalLineageSha256`; their producer tuples remain distinct. The prospective verifier computes
top-level `checkArtifactSetSha256` from all four checks and three verified attestations, and the full
report/check/run bodies are embedded in the administrator payload for remote recovery. Historical
comments remain append-only, but exactly one may match the complete current lineage/report/set;
same-candidate reruns require a new report/comment. This is not GitHub review state.
Any overlap blocks merge: normally merge current `origin/main` into the implementation branch,
never rebase or force-push, independently review the complete semantic diff, rerun the slice's
affected/full/audit/security gates, obtain a new report and authorization comment after that merge,
and rerun this gate. Any base/head/candidate/check/report/comment drift blocks merge. The two
finding-close PRs run the identical contract in their prospective-closure blocks below.

Immediately after the protected merge, start a fresh shell and resolve every identity again:

```bash
set -euo pipefail
: "${DELIVERY_BRANCH:?re-enter exact merged delivery branch}"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
mapfile -t DELIVERY_PROGRAM_PRS < <(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --list-pull-requests-exhaustive --repository Okan-wqm/aquaculture_platform \
  --state merged --base main --head "$DELIVERY_BRANCH" | jq -r '.[].number')
test "${#DELIVERY_PROGRAM_PRS[@]}" -eq 1
DELIVERY_PROGRAM_PR_NUMBER="${DELIVERY_PROGRAM_PRS[0]}"
DELIVERY_PROGRAM_MAIN="$(gh pr view "$DELIVERY_PROGRAM_PR_NUMBER" \
  --repo Okan-wqm/aquaculture_platform --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
[[ "$DELIVERY_PROGRAM_MAIN" =~ ^[0-9a-f]{40}$ ]]
PROGRAM_GIT_COMMON_DIR="$(git -C /var/aqua-saas \
  rev-parse --path-format=absolute --git-common-dir)"
DELIVERY_PR_ROOT="$PROGRAM_GIT_COMMON_DIR/aquamobil-v4-program-evidence/v1/pr-$DELIVERY_PROGRAM_PR_NUMBER"
DELIVERY_PR_GENERATION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --resolve-program-pr-generation "$DELIVERY_PR_ROOT" \
  --pull-request "$DELIVERY_PROGRAM_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind implementation-boundary \
  --from-current-authorization-comment)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --reconcile-program-pr "$DELIVERY_PROGRAM_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --pr-kind implementation-boundary \
  --resulting-main "$DELIVERY_PROGRAM_MAIN" \
  --program-pr-generation "$DELIVERY_PR_GENERATION" \
  --write-postmerge-spool
DELIVERY_POSTMERGE_COMMENT_ACTION="$(node \
  "$COORDINATOR_WORKTREE/tools/aquamobil-v4/reconcile-ledger.mjs" \
  --write-postmerge-recovery-comment-envelope \
  --select-canonical-postmerge-recovery-comment \
  --pull-request "$DELIVERY_PROGRAM_PR_NUMBER" \
  --repository Okan-wqm/aquaculture_platform \
  --program-pr-generation "$DELIVERY_PR_GENERATION" \
  --print-postmerge-comment-action)"
case "$DELIVERY_POSTMERGE_COMMENT_ACTION" in
  post)
    gh pr comment "$DELIVERY_PROGRAM_PR_NUMBER" --repo Okan-wqm/aquaculture_platform \
      --body-file "$DELIVERY_PR_GENERATION/postmerge/postmerge-comment-envelope.md"
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
  --program-pr-generation "$DELIVERY_PR_GENERATION" \
  --recover-spool-from-github-if-missing \
  --require-result-tree-equals-candidate-tree
```

The slice reconciliation embeds the full resulting `ProtectedProgramBoundaryEvidence`, including
durable recovery; domain/manual delivery runs remain separate. Retain this boundary worktree,
remote branch, and exact generation until that reconciliation merges and is main-reachable. Only
then run the program plan's exact-target cleanup authorization and remove those three resources.
Post-before-crash retry reuses the lowest numeric byte-identical postmerge comment ID; zero,
malformed/different current collisions, or selecting a higher duplicate fail.

All delivery slice and closure reconciliations are generic `ProgramPrKind` PRs. Before staging each,
run the master plan's exact `--materialize-previous-generic-program-pr` block and add the resulting
numeric `program-prs/pr-<N>.json`; its prospective verifier must prove that full
`ProgramPrEvidence` record byte-exact in
current `C/T`. After merge, write/round-trip the full post-merge recovery payload and prove
`T == resultingMain^{tree}`. That merge cleans the prior generic and any now-durable delivery
boundary, but retains its own generic worktree/remote branch/generation until the following generic
merge. The three source artifacts never contain `checkArtifactSetSha256`; they share only canonical
lineage, with distinct producer tuples, and the prospective verifier computes the set digest later.
Authorization comments embed the full report plus four checks, three workflow-run/artifact
attestations, base-advance/PR-API/capture-tool facts, and the exact prior-reference discriminant;
they accept exactly one current lineage/report/set match and reject malformed collisions,
same-candidate reruns without reauthorization, envelopes over 60000 canonical UTF-8 bytes, or kind/
branch/path mismatch. Git common-dir generation writes use exclusive no-replace links and phase
manifests for review/authorization/prospective/postmerge that exclude themselves; a rename-over-final
or digest-only recovery is forbidden.
The only producers remain the terminal jobs in the three existing required workflows: each has
exact `contents: read` and no `actions: read`, fetch depth two, SHA-pinned checkout/upload, no token,
matching PR-only emitter/upload guards, and receives `github.job` plus exact official
`job.check_run_id/job.workflow_file_path/job.workflow_ref/job.workflow_sha/
job.workflow_repository`. It derives the workflow blob from Git and performs no GitHub API or
network call; only the trusted coordinator exhaustively cross-checks Jobs/API and Git-blob state.
Missing, empty, renamed, hard-coded, or `github.workflow*` fallback fields fail. No fourth evidence
workflow is created. Every GitHub list used by capture/recovery—pull requests, check runs, workflow
runs, workflow jobs, run artifacts, comments, rulesets, tags, and any later list—follows every RFC
8288 `Link` page,
canonicalizes the complete set, validates `total_count` when present, and rejects page loops,
missing pages, or cross-page duplicates; `per_page=100` is only an optimization and a first page is
never authority.

---

### Task 0: Allocate every delivery finding before implementation

**Files:**

- Create through the program capture tool:
  `docs/superpowers/evidence/aquamobil-v4/slices/I1/preflight.json`
- Create: `docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md`
- Create: `docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md`
- Create: `docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: the locked registry allocator and the seven exact implementation boundaries below.
- Produces: seven real, uppercase finding IDs used directly by commit-msg validation; it never uses
  an unregistered narrative heading as a `Closes:` trailer.

- [ ] **Step 1: Enter the coordinator-created I1 worktree and allocate under the registry lock**

<!-- markdownlint-disable MD010 -->

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
I1_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-path \
  --slice I1 --boundary asset-storage-and-tls-boundary)"
test "$I1_WORKTREE" = "/var/aqua-saas/.worktrees/aquamobil-v4-i1"
test "$(pwd -P)" = "$I1_WORKTREE"
test "$(git branch --show-current)" = "fix/aquamobil-i1-asset-boundary"
I1_PREFLIGHT=docs/superpowers/evidence/aquamobil-v4/slices/I1/preflight.json
test -f "$I1_PREFLIGHT"
test "$(git rev-parse HEAD)" = "$(jq -r '.baseMainCommit' "$I1_PREFLIGHT")"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice I1 --check "$I1_PREFLIGHT" --main-ref origin/main
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
npm run findings:verify

allocate_delivery_finding() {
  local finding_domain="$1"
  local finding_title="$2"
  local evidence_path="$3"
  local review_file="$4"
  local existing_count
  existing_count="$(jq -r --arg title "$finding_title" 'select(.title == $title) | .id' docs/reviews/_registry/findings.jsonl | wc -l)"
  if test "$existing_count" -eq 1; then
    jq -e \
      --arg domain "$finding_domain" \
      --arg title "$finding_title" \
      --arg evidence "$evidence_path" \
      --arg review "$review_file" \
      'select(
        (.id | test("^" + $domain + "-HIGH-[0-9]{3}$")) and
        .severity == "HIGH" and
        .state == "OPEN" and
        .title == $title and
        .layer == 1 and
        .evidence == [$evidence] and
        .rule_violated == "AquaMobil V4 delivery and appearance release contract" and
        .owner_agent == "codex" and
        .raised_in_cycle == "2026-08-26-aquamobil-v4-delivery-appearance" and
        .review_file == $review and
        .closed_at == null and
        .closing_commits == [] and
        .deadline == null and
        .owner_user == null and
        .override_of == null
      )' \
      docs/reviews/_registry/findings.jsonl >/dev/null
    return 0
  fi
  test "$existing_count" -eq 0
  npm run findings:add -- "$finding_domain" <(
    node - "$finding_title" "$evidence_path" "$review_file" <<'NODE'
const [title, evidence, reviewFile] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify({
    severity: 'HIGH',
    state: 'OPEN',
    title,
    layer: 1,
    evidence: [evidence],
    rule_violated: 'AquaMobil V4 delivery and appearance release contract',
    owner_agent: 'codex',
    raised_in_cycle: '2026-08-26-aquamobil-v4-delivery-appearance',
    review_file: reviewFile,
    created_at: new Date().toISOString(),
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes: 'Allocated by the approved delivery and appearance implementation plan.',
  })}\n`,
);
NODE
  )
}

while IFS=$'\t' read -r finding_domain finding_title evidence_path review_file; do
  allocate_delivery_finding "$finding_domain" "$finding_title" "$evidence_path" "$review_file"
done <<'FINDINGS'
INFRA	AquaMobil production asset requests can fall through to SPA HTML	tests/invariants/mobile-asset-serving.spec.ts	docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md
INFRA	AquaMobil edge deployment identity can select the wrong host or certificate	tests/invariants/droplet-tls-topology.spec.ts	docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md
INFRA	AquaMobil presigned object URLs expose the internal MinIO origin	tests/invariants/mobile-object-storage-boundary.spec.ts	docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md
MOB	AquaMobil field surfaces lack one semantic primitive authority	web/apps/aquamobil/src/components/ui/index.ts	docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md
MOB	AquaMobil service-worker activation can mix shell generations	web/apps/aquamobil/src/pwa/update-coordinator.ts	docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md
MOB	AquaMobil install metadata has duplicate build authorities	web/apps/aquamobil/vite.config.ts	docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md
MOB	AquaMobil legacy appearance and package authorities remain active	web/apps/aquamobil/src/appearance/runtime.ts	docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md
FINDINGS
```

<!-- markdownlint-enable MD010 -->

Expected: exactly seven unique IDs exist for the exact titles. A reused title is accepted only when
its domain-prefixed HIGH ID, OPEN state, evidence, review file, cycle, ownership, and untouched
closure fields equal the complete allocation contract above.

- [ ] **Step 2: Create exact review headings and commit only traceability**

Use `apply_patch` to create the two infrastructure reviews and the combined delivery review. Each
allocated ID appears once as a complete `## ID` heading with its exact title, `OPEN` state, evidence
path, root-cause statement, and acceptance boundary. Do not lowercase or predict an ID.

```bash
for finding_title in \
  'AquaMobil production asset requests can fall through to SPA HTML' \
  'AquaMobil edge deployment identity can select the wrong host or certificate' \
  'AquaMobil presigned object URLs expose the internal MinIO origin' \
  'AquaMobil field surfaces lack one semantic primitive authority' \
  'AquaMobil service-worker activation can mix shell generations' \
  'AquaMobil install metadata has duplicate build authorities' \
  'AquaMobil legacy appearance and package authorities remain active'; do
  mapfile -t finding_ids < <(
    jq -r --arg title "$finding_title" 'select(.title == $title) | .id' \
      docs/reviews/_registry/findings.jsonl
  )
  test "${#finding_ids[@]}" -eq 1
  test "$(rg -l "^## ${finding_ids[0]}$" \
    docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md \
    docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md \
    docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md | wc -l)" -eq 1
done
npm run findings:verify
npm run quality:format-scope:generate
git add -- \
  docs/superpowers/evidence/aquamobil-v4/slices/I1/preflight.json \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md \
  docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md \
  docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md \
  tools/quality/format-scope.json
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(review): register AquaMobil delivery findings"
git push --set-upstream origin fix/aquamobil-i1-asset-boundary
```

---

### Task 1: I1 — prove the current asset boundary is wrong

**Files:**

- Create: `infrastructure/ci/image-digests.json`
- Create: `scripts/ci/resolve-ci-image.mjs`
- Create: `tests/invariants/ci-image-digests.spec.ts`
- Create: `tests/invariants/mobile-asset-serving.spec.ts`
- Create: `scripts/ci/aquamobil-delivery-smoke.sh`
- Create: `.github/workflows/aquamobil-delivery.yml`
- Modify: `.github/workflows/ci-affected.yml`
- Modify: `.github/workflows/ci-full.yml`
- Modify: `.github/manifests/main-required-status-checks.json`

**Interfaces:**

- Consumes: deployed edge `infrastructure/nginx/droplet.conf`, inner static-server config, existing
  PostgreSQL authority `.github/manifests/postgres-image.json`, and the required `build-status`
  aggregate.
- Produces: `bash scripts/ci/aquamobil-delivery-smoke.sh` and reusable workflow job
  `aquamobil-delivery`, joined to both protected aggregate contexts before I1 may merge; also the
  closed image-authority router and resolver consumed by later object-storage, NATS, and closeout
  harnesses without copying the existing PostgreSQL digest authority.

- [ ] **Step 1: Write the static invariant before changing nginx**

The invariant must parse the actual location blocks and require:

- edge `location ^~ /mobile/` with the existing path-stripping rewrite;
- the same `^~ /mobile/` precedence in `nginx/nginx.conf` and
  `infrastructure/docker/nginx/nginx.prod.conf`, without treating either as the droplet authority;
- inner `location ^~ /assets/`, `^~ /icons/`, and `^~ /fonts/`;
- `try_files $uri =404` for revisioned assets, icons, fonts, manifests, JavaScript, CSS, and
  workers;
- `Service-Worker-Allowed /mobile/` for `messaging-sw.js`, `firebase-messaging-sw.js`, and legacy
  `sw.js`;
- security-header SSoT inclusion in every inner location that adds a header;
- SPA fallback only under the navigation location.

Before materializing the manifest, make `ci-image-digests.spec.ts` require the closed router
`infrastructure/ci/image-digests.json` and sole resolver `scripts/ci/resolve-ci-image.mjs`. It
rejects a missing/extra key, schema drift, a tag without `@sha256:`, an uppercase or non-64-hex
digest, a second hard-coded inline image in a harness, and any mutable image argument in the
delivery, VFD/NATS, or closeout scripts. PostgreSQL must resolve only through the repository's
existing image manifest rather than copying its digest. The router is exactly:

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

The resolver accepts exactly `--manifest infrastructure/ci/image-digests.json --image <closed-key>`,
rejects every other manifest path and environment/CLI image override, validates the complete router
and the one allowed external path/pointer on every call, and writes exactly one resolved pinned
reference plus a newline to stdout. The router and resolver are introduced in I1 before any harness
consumes them. Later plans may change an inline digest—or the existing PostgreSQL manifest—in a
separately reviewed prerequisite PR that records the registry inspection and reruns every consumer;
they must not create another image manifest or resolver.

Run:

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath tests/invariants/ci-image-digests.spec.ts tests/invariants/mobile-asset-serving.spec.ts
```

Expected: FAIL because the image manifest is absent, assets/icons are ordinary prefixes, `/fonts/`
is absent, missing extension assets can reach SPA HTML, and worker scope is `/`.

- [ ] **Step 2: Write the real-container smoke harness**

Use `apply_patch` to create the exact router and resolver above, then rerun
`ci-image-digests.spec.ts` to prove only its missing-authority RED is resolved. The smoke harness
itself is read-only with respect to both image manifests; it must never materialize or repair them.

`scripts/ci/aquamobil-delivery-smoke.sh` must:

1. resolve all six closed keys through
   `node scripts/ci/resolve-ci-image.mjs --manifest infrastructure/ci/image-digests.json --image <key>`,
   then run `ci-image-digests.spec.ts`;
2. create an ephemeral Docker network and cleanup trap;
3. generate an ephemeral self-signed certificate only inside its ephemeral directory;
4. build `infrastructure/docker/Dockerfile.aquamobil` from the repository root;
5. resolve `mosquittoFixture` through the sole resolver, start that exact digest with network alias
   `mosquitto`, and start the application image with DNS name `aquamobil`, because the complete
   droplet config resolves its static MQTT upstream during nginx startup;
6. start the pinned nginx image with the repository's complete `infrastructure/nginx/droplet.conf`,
   its includes, and the ephemeral certificate, obtaining the exact nginx reference through the same
   resolver rather than from a shell default or Compose tag;
7. reach the app only through edge HTTPS `/mobile/`, never directly for assertions;
8. assert existing JS/CSS/worker headers and MIME types, missing JS/CSS/font/manifest/worker 404s,
   `/mobile/units` HTML/200, `/mobile/health` JSON/200, CSP/HSTS, and worker scope `/mobile/`;
9. assert `nginx -t` and startup succeed before the first intended HTTP RED assertion, then print
   response headers and all fixture/container logs on failure;
10. remove only resources carrying the harness's unique label.

The harness must not rewrite or copy the `/mobile/` location into a fixture; the production edge
file is the code under test.

- [ ] **Step 3: Wire a required aggregate lane**

`.github/workflows/aquamobil-delivery.yml` is a pinned-action reusable workflow with read-only
permissions and a 20-minute timeout. `build-status` is owned by `ci-full.yml`, while `merge-gate` is
owned by `ci-affected.yml`; neither aggregate may be described or edited as if it lived in the other
workflow.

Add an `aquamobil_delivery` path-filter output in `ci-affected.yml`, call the reusable workflow as
job `aquamobil-delivery`, add it to `merge-gate.needs`, and require success whenever that output is
true. A path-filtered skip is accepted only when the output is false; failure, cancellation, or a
skip while the output is true fails the aggregate. In `ci-full.yml`, call the same reusable workflow
unconditionally as job `aquamobil-delivery`, add it to `build-status.needs`, and include its result
in the aggregate loop.

While editing those terminal jobs and the required-check manifest, preserve the Order 0 pinned
checkout, PR-candidate emitter, exact-name mandatory upload, workflow/tool path pins, and the shared
CI-Affected artifact mapping. This delivery lane adds no required context and no fourth candidate
artifact.

Use only these required third-party action revisions in the reusable workflow:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
  with:
    fetch-depth: 0
- uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
  with:
    node-version: '22'
    cache: npm
```

Install with `npm ci --ignore-scripts --no-audit --prefer-offline` before static tests and the
container smoke. Do not add a floating Docker action; the hosted runner's Docker CLI executes the
repository script directly.

Update both workflow contracts in `.github/manifests/main-required-status-checks.json`: `merge-gate`
requires `aquamobil-delivery` in `ci-affected.yml`, and `build-status` requires it in `ci-full.yml`.
Do not create a fifth external required context.

- [ ] **Step 4: Observe the container smoke fail for the intended response**

```bash
bash scripts/ci/aquamobil-delivery-smoke.sh
```

Expected: FAIL on a missing revisioned asset returning the SPA document or on an over-broad worker
scope, not on Docker startup or certificate generation.

---

### Task 2: I1 — enforce honest edge and inner nginx behavior

**Files:**

- Create: `infrastructure/nginx/droplet-environments.json`
- Create: `scripts/nginx/render-droplet-config.mjs`
- Create: `tests/invariants/droplet-tls-topology.spec.ts`
- Modify: `infrastructure/nginx/droplet.conf`
- Modify: `infrastructure/docker/nginx/aquamobil.conf`
- Modify: `nginx/nginx.conf`
- Modify: `infrastructure/docker/nginx/nginx.prod.conf`
- Modify: `docker-compose.droplet.yml`
- Modify: `docker-compose.staging.yml`
- Modify: `scripts/ci/aquamobil-delivery-smoke.sh`
- Modify: `scripts/deploy/droplet-up.sh`
- Modify: `tests/invariants/mobile-csp-headers.spec.ts`
- Modify: `tests/invariants/mobile-asset-serving.spec.ts`
- Modify: `.github/workflows/ci-affected.yml`
- Modify: `.github/workflows/ci-full.yml`
- Modify: `.github/workflows/deploy-staging.yml`
- Modify: `.github/manifests/main-required-status-checks.json`
- Modify: `docs/runbooks/staging-environment.md`
- Modify: `docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md`
- Modify: `docs/reviews/_registry/findings.jsonl`

**Interfaces:**

- Consumes: Task 1's RED static/container evidence and current finding allocator.
- Produces: honest extension/worker 404 behavior, `/mobile/` worker ceiling, one exact
  production/staging TLS-host parameterization, and a green required delivery lane consumed by every
  later frontend slice.

- [ ] **Step 1: Resolve the preallocated finding and record RED evidence**

```bash
for i1_finding_title in \
  'AquaMobil production asset requests can fall through to SPA HTML' \
  'AquaMobil edge deployment identity can select the wrong host or certificate'; do
  mapfile -t i1_finding_ids < <(
    jq -r --arg title "$i1_finding_title" \
      'select(.title == $title) | .id' docs/reviews/_registry/findings.jsonl
  )
  test "${#i1_finding_ids[@]}" -eq 1
  [[ "${i1_finding_ids[0]}" =~ ^INFRA-HIGH-[0-9]{3}$ ]]
  test "$(rg -c "^## ${i1_finding_ids[0]}$" \
    docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md)" -eq 1
done
npm run findings:verify
```

Use `apply_patch` to append Task 1's static/container RED output, impact, and root cause under that
existing asset-boundary ID heading, and append the two-droplet TLS topology evidence under the
deployment-identity ID heading. Do not create another registry row or another review authority.

- [ ] **Step 2: Make asset locations exact and precedence-safe**

Implement these inner boundaries:

```nginx
location ^~ /assets/ { try_files $uri =404; }
location ^~ /icons/  { try_files $uri =404; }
location ^~ /fonts/  { try_files $uri =404; }
```

Retain the intended cache policies and re-include the generated security snippet in each location.
Add honest exact/regex locations for manifest and worker assets. Extension requests that do not
exist terminate at `=404`; only extensionless application navigation may reach `/index.html`.

Change the production edge block to `location ^~ /mobile/` while preserving its current rewrite,
upstream, CORS allowlist, and HSTS behavior. Apply the same precedence-only change to the two
non-droplet active outer configs; do not copy the droplet block into them or change their proxy
semantics.

The shared droplet config must also become honestly usable on two separate deployments without
copying production key material to staging or making security depend on the other certificate being
absent. Create `droplet-environments.json` as this exact closed authority:

```json
{
  "production": {
    "host": "app.suderra.com",
    "certificateName": "app.suderra.com"
  },
  "staging": {
    "host": "staging.suderra.com",
    "certificateName": "staging.suderra.com"
  }
}
```

`render-droplet-config.mjs` requires `--deployment production` or `--deployment staging` plus
exactly one of `--check` or `--write`, reads that manifest and the single
`infrastructure/nginx/droplet.conf` source template, and validates the closed host/certificate
values. `--check` renders and validates in memory without filesystem mutation; `--write` publishes
the selected literal config to either `/var/lib/aqua/nginx/runtime/production/droplet.conf` or
`/var/lib/aqua/nginx/runtime/staging/droplet.conf` through a same-directory staging file plus an
atomic rename. It rejects an unknown key, extra manifest field, duplicate host/certificate, raw
environment host, IP address, wildcard, slash, unresolved template token, or output outside that
exact runtime root. `STAGING_DROPLET_HOST`, request Host/SNI, and other environment values are never
configuration inputs. The source template is the only editable route/CSP/upstream authority; the two
runtime outputs are untracked deployment artifacts, not maintained copies.

Each rendered config contains only its selected public identity. In both `stream` and `http`, the
default TLS server uses nginx's native `ssl_reject_handshake on`; it does not need a sentinel
certificate. A separate application server names only the selected host and reads only the
corresponding `app.suderra.com` or `staging.suderra.com` directory beneath `/etc/letsencrypt/live/`.
A closed map over `$ssl_server_name|$host` permits only the selected exact pair and returns 444 for
every mismatch. The selected HTTP origin is the only CORS entry. Port 80's default server always
returns 444; its selected-host server redirects to a renderer-emitted constant HTTPS origin, never
raw `$host`. Move the Docker health endpoint to an unpublished `listen 127.0.0.1:8080` server and
update the Compose health check, so an unknown public Host never receives a health response.

Make the stream upstream first-deploy-safe with pinned nginx 1.27.5's open-source dynamic upstream
support: a shared-memory `zone`, `server mosquitto:1883 resolve`, and Docker resolver `127.0.0.11`.
`nginx -t` and HTTP startup therefore do not require Mosquitto DNS to exist; MQTT positive tests
start the fixture only after that absence has been proved. No raw resolver result selects a public
host or certificate.

Production Compose mounts `/var/lib/aqua/nginx/runtime/production` at the one read-only runtime
target; the staging overlay replaces that source with `/var/lib/aqua/nginx/runtime/staging` at the
same target. Nginx starts with `-c /etc/aqua-nginx/runtime/droplet.conf`. A merge invariant rejects
a staging result that retains the production source mount or either config that mounts the peer
certificate directory. The host Let's Encrypt tree remains read-only because `live/` symlinks
require its `archive/` targets, but a deploy preflight proves only the selected full chain/key are
usable and the peer live directory is absent.

The affected required-workflow/manifest edits preserve Order 0's terminal candidate emitter/upload
and exact four-context/three-artifact pins byte-for-contract; this task changes only their delivery
dependencies. The staging workflow performs render-to-`.next`, selected certificate readability, SAN, expiry, key
parse/match, peer-directory absence, and pinned-image `nginx -t` before atomically publishing the
runtime config and running full Compose. Failure leaves the previously published runtime config and
running nginx untouched. Production owns the same sequence in `scripts/deploy/droplet-up.sh`;
`deploy-digitalocean.yml` remains only its caller. Update `docs/runbooks/staging-environment.md`
with the exact DNS-01 issuance/renewal procedure for cert name `staging.suderra.com`, restrictive
credential-file permissions, SAN/key checks, and an explicit prohibition on copying the production
certificate. Automatic deployment does not issue a new public certificate; a missing local
certificate is an intentional first-deploy blocker.

The runbook's command contract is exact and never prints the token:

```bash
: "${DO_CERTBOT_TOKEN:?DO_CERTBOT_TOKEN must be supplied from the staging operator secret store}"
: "${CERTBOT_ACCOUNT_EMAIL:?CERTBOT_ACCOUNT_EMAIL must be supplied}"
install -d -m 0700 /root/.secrets/certbot
umask 077
printf 'dns_digitalocean_token = %s\n' "$DO_CERTBOT_TOKEN" > /root/.secrets/certbot/digitalocean.ini
unset DO_CERTBOT_TOKEN
certbot certonly --non-interactive --agree-tos --dns-digitalocean \
  --dns-digitalocean-credentials /root/.secrets/certbot/digitalocean.ini \
  --cert-name staging.suderra.com -d staging.suderra.com -m "$CERTBOT_ACCOUNT_EMAIL"
test "$(stat -c '%a' /root/.secrets/certbot/digitalocean.ini)" = 600
openssl x509 -in /etc/letsencrypt/live/staging.suderra.com/fullchain.pem \
  -noout -checkhost staging.suderra.com
certbot renew --dry-run --cert-name staging.suderra.com
```

- [ ] **Step 3: Restrict worker authority**

Every worker response carries:

```nginx
add_header Service-Worker-Allowed "/mobile/";
```

The Firebase worker still registers at its deeper messaging sub-scope. Neither worker may claim the
origin root.

- [ ] **Step 4: Run static and deployed-path evidence**

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath tests/invariants/droplet-tls-topology.spec.ts tests/invariants/mobile-asset-serving.spec.ts tests/invariants/mobile-csp-headers.spec.ts
node scripts/nginx/render-droplet-config.mjs --deployment production --check
node scripts/nginx/render-droplet-config.mjs --deployment staging --check
bash scripts/ci/aquamobil-delivery-smoke.sh
npm run gates:required-status-checks
```

The container harness renders two clean cases from the repository's one source template. The
production case mounts only an ephemeral `app.suderra.com` certificate, and the staging case mounts
only an ephemeral `staging.suderra.com` certificate. In each case it first proves `nginx -t` and
HTTP startup while the Mosquitto DNS name is absent, then starts the exact manifest-pinned Mosquitto
fixture for selected-host MQTT evidence. Exact SNI+Host HTTP and exact-host MQTT pass;
peer/unknown/no-SNI TLS fails, selected SNI plus peer/unknown Host returns 444, and an unknown port
80 Host returns 444. Repeat the cross-environment negatives once with an otherwise valid stale peer
certificate directory injected, proving renderer-selected identity—not certificate absence—is the
runtime authority. The harness never rewrites host, route, certificate, or CSP lines into a test
fixture.

Expected: all pass; missing assets are 404, `/mobile/units` remains HTML/200 on both declared
deployments, and the staging host no longer falls into the default TLS 444 boundary.

- [ ] **Step 5: Verify, commit, and push I1**

```bash
npx prettier --check infrastructure/ci/image-digests.json infrastructure/nginx/droplet-environments.json scripts/ci/resolve-ci-image.mjs scripts/nginx/render-droplet-config.mjs tests/invariants/ci-image-digests.spec.ts tests/invariants/droplet-tls-topology.spec.ts tests/invariants/mobile-asset-serving.spec.ts tests/invariants/mobile-csp-headers.spec.ts .github/workflows/aquamobil-delivery.yml .github/workflows/ci-affected.yml .github/workflows/ci-full.yml .github/workflows/deploy-staging.yml .github/manifests/main-required-status-checks.json
git diff --check
git add infrastructure/ci/image-digests.json infrastructure/nginx/droplet-environments.json infrastructure/nginx/droplet.conf infrastructure/docker/nginx/aquamobil.conf nginx/nginx.conf infrastructure/docker/nginx/nginx.prod.conf docker-compose.droplet.yml docker-compose.staging.yml scripts/ci/resolve-ci-image.mjs scripts/nginx/render-droplet-config.mjs scripts/ci/aquamobil-delivery-smoke.sh scripts/deploy/droplet-up.sh tests/invariants/ci-image-digests.spec.ts tests/invariants/droplet-tls-topology.spec.ts tests/invariants/mobile-asset-serving.spec.ts tests/invariants/mobile-csp-headers.spec.ts .github/workflows/aquamobil-delivery.yml .github/workflows/ci-affected.yml .github/workflows/ci-full.yml .github/workflows/deploy-staging.yml .github/manifests/main-required-status-checks.json docs/runbooks/staging-environment.md docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md docs/reviews/_registry/findings.jsonl
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
i1_finding_id_for_title() {
node - "$1" <<'NODE'
const fs = require('node:fs');
const title = process.argv[2];
const rows = fs
  .readFileSync('docs/reviews/_registry/findings.jsonl', 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse)
  .filter((row) => row.title === title);
if (rows.length !== 1) throw new Error(`expected one finding, got ${rows.length}`);
process.stdout.write(rows[0].id);
NODE
}
i1_asset_finding_id="$(i1_finding_id_for_title 'AquaMobil production asset requests can fall through to SPA HTML')"
i1_tls_finding_id="$(i1_finding_id_for_title 'AquaMobil edge deployment identity can select the wrong host or certificate')"
[[ "$i1_asset_finding_id" =~ ^INFRA-HIGH-[0-9]{3}$ ]]
[[ "$i1_tls_finding_id" =~ ^INFRA-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "security(aquamobil): enforce the mobile asset boundary" -m "Exercise the production edge and inner server together so executable assets, deployment host identity, and certificate selection fail closed." -m "Closes: docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md#$i1_asset_finding_id" -m "Closes: docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md#$i1_tls_finding_id"
git push origin HEAD
```

Expected: hooks pass, both footers resolve to their allocated current findings, and I1 is
reviewed/merged before V0 starts. Do not reuse the source branch's colliding `ORPHAN-HIGH-598`
identifier.

---

### Task 3: I1 — give browsers one signed, same-origin object route

**Files:**

- Create: `infrastructure/storage/public-object-routes.json`
- Create: `scripts/storage/render-public-object-routes.mjs`
- Create: `tests/invariants/mobile-object-storage-boundary.spec.ts`
- Create: `e2e/playwright.aquamobil-edge.config.ts`
- Create: `e2e/tests/mobile-edge/public-object-execution.spec.ts`
- Modify: `e2e/package.json`
- Create: `libs/storage/src/public-storage-endpoint.ts`
- Create: `libs/storage/src/__tests__/public-storage-endpoint.spec.ts`
- Create: `libs/storage/src/__tests__/minio-public-presign.spec.ts`
- Modify: `libs/storage/src/interfaces/storage.interfaces.ts`
- Modify: `libs/storage/src/minio-client.service.ts`
- Modify: `libs/storage/src/index.ts`
- Modify: `apps/farm-service/src/app.module.ts`
- Modify: `apps/gateway-api/src/app.module.ts`
- Modify: `apps/admin-api-service/src/app.module.ts`
- Create: `apps/messaging-service/src/shared/messaging-s3-client.factory.spec.ts`
- Modify: `apps/messaging-service/src/shared/messaging-s3-client.factory.ts`
- Create: `apps/messaging-service/src/shared/messaging-storage.module.ts`
- Modify: `apps/messaging-service/src/message/message.module.ts`
- Modify: `apps/messaging-service/src/compliance/compliance.module.ts`
- Modify: `apps/messaging-service/src/message/services/media.service.ts`
- Modify: `apps/messaging-service/src/message/services/__tests__/media.service.spec.ts`
- Modify: `apps/messaging-service/src/message/services/s3-storage-object-verifier.service.ts`
- Create:
  `apps/messaging-service/src/message/services/__tests__/s3-storage-object-verifier.service.spec.ts`
- Modify: `apps/messaging-service/src/message/services/media-finalization.service.ts`
- Modify: `apps/messaging-service/src/message/services/__tests__/media-finalization.service.spec.ts`
- Modify: `apps/messaging-service/src/message/services/thumbnail.service.ts`
- Create: `apps/messaging-service/src/message/services/__tests__/thumbnail.service.spec.ts`
- Modify: `apps/messaging-service/src/compliance/services/attachment-object-purge.service.ts`
- Modify:
  `apps/messaging-service/src/compliance/services/__tests__/attachment-object-purge.service.spec.ts`
- Modify: `libs/storage/src/__tests__/storage.module.spec.ts`
- Modify: `infrastructure/nginx/droplet.conf` (bounded generated block)
- Modify: `docker-compose.droplet.yml`
- Modify: `docker-compose.staging.yml`
- Modify: `scripts/ci/aquamobil-delivery-smoke.sh`
- Modify: `.github/workflows/aquamobil-delivery.yml`
- Modify: `docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 1's production-edge smoke harness, existing MinIO credentials/buckets, and the
  current `@platform/storage`/messaging S3 factories; public host identity is consumed from Task 2's
  `infrastructure/nginx/droplet-environments.json` authority.
- Produces: one internal client for server operations, one public-origin signer for browser URLs,
  generated object-route locations, and a real signed PUT/GET smoke gate.

```ts
export interface PublicStorageEndpoint {
  readonly origin: string;
  readonly endpoint: string;
  readonly port?: number;
  readonly useSSL: boolean;
}

export function resolvePublicStorageEndpoint(
  rawUrl: string | undefined,
  nodeEnv: string,
): PublicStorageEndpoint;

export interface StorageConfig {
  endpoint: string;
  port?: number;
  useSSL: boolean;
  publicEndpoint: PublicStorageEndpoint;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

export interface MessagingS3 {
  readonly internalClient: S3Client;
  readonly presignClient: S3Client;
  readonly bucket: string;
}

export const MESSAGING_S3 = Symbol('MESSAGING_S3');
```

The public-route manifest is exactly:

```json
{
  "version": 1,
  "maxUploadBytes": 26214400,
  "inlineResponseTypes": [
    "audio/aac",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "video/webm"
  ],
  "environments": {
    "production": {
      "buckets": ["aquaculture", "messaging"]
    },
    "staging": {
      "buckets": ["aquaculture-staging", "messaging-staging"]
    }
  }
}
```

- [ ] **Step 1: Resolve the preallocated object finding and record current evidence**

```bash
mapfile -t object_route_finding_ids < <(
  jq -r --arg title 'AquaMobil presigned object URLs expose the internal MinIO origin' \
    'select(.title == $title) | .id' docs/reviews/_registry/findings.jsonl
)
test "${#object_route_finding_ids[@]}" -eq 1
[[ "${object_route_finding_ids[0]}" =~ ^INFRA-HIGH-[0-9]{3}$ ]]
test "$(rg -c "^## ${object_route_finding_ids[0]}$" \
  docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md)" -eq 1
npm run findings:verify
```

Use `apply_patch` under that existing complete ID heading to record the verified `minio:9000`
browser evidence, signed-query log risk, same-origin stored-content risk, root cause, and the
acceptance cases in Step 6. Do not allocate a second row.

- [ ] **Step 2: Write endpoint, client-role, and deployed-boundary tests first**

`public-storage-endpoint.spec.ts` requires:

- production rejects a missing URL, credentials, query, fragment, non-root path, and non-HTTPS URL;
- production accepts only an absolute root HTTPS origin and returns normalized host/port/protocol;
- non-production has the explicit `http://localhost:9000` development default;
- no code derives the public endpoint from `MINIO_ENDPOINT`.

`minio-public-presign.spec.ts` injects distinct internal/public MinIO client doubles and proves
bucket initialization, stat, upload, delete, and list use only the internal client while
`getPresignedUrl` and `getPresignedUploadUrl` use only the public signer.

The messaging specs prove one exported `MESSAGING_S3` provider instance is shared by the message and
compliance modules. `MediaService` signs with `presignClient`; verifier, finalization, thumbnail,
and attachment purge use `internalClient`; neither role silently substitutes the other. An AST
invariant rejects `new S3Client` and direct `MINIO_*` reads anywhere else under
`apps/messaging-service/src`. The root invariant requires every declared production/staging bucket
to exist in the manifest, a generated host-bound `^~ /bucket/` location, fixed compose bucket, and
matching `MINIO_PUBLIC_URL`. Update `storage.module.spec.ts` so every `StorageConfig` fixture names
its public endpoint explicitly; the required field never becomes optional for test convenience.

```bash
npx nx test storage --runInBand --skip-nx-cache --testPathPatterns='public-storage-endpoint|public-presign'
npx nx test messaging-service --runInBand --skip-nx-cache --testPathPatterns='messaging-s3-client|media.service|s3-storage-object-verifier|media-finalization|thumbnail|attachment-object-purge'
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand --runTestsByPath tests/invariants/mobile-object-storage-boundary.spec.ts
```

Expected: FAIL because the public endpoint, split clients, manifest, generated edge locations, and
compose values do not exist.

- [ ] **Step 3: Separate internal operations from public signing in shared storage**

`resolvePublicStorageEndpoint` parses with `new URL()`, permits only `http:`/`https:`, rejects any
userinfo/path/query/fragment, requires HTTPS in production, and normalizes default ports to
`undefined`. Missing production configuration throws; only non-production resolves the documented
localhost default.

`MinioClientService` constructs `internalClient` from the existing endpoint fields and
`presignClient` from `publicEndpoint`. `onModuleInit()` and every object mutation/read stay on the
internal client. Only the two presign methods use the public client. Never rewrite a signed URL
after generation.

Farm, gateway, and admin module factories call the shared resolver with `MINIO_PUBLIC_URL`; they do
not reimplement URL validation. Production startup fails before listen when that variable is
missing/invalid.

- [ ] **Step 4: Split messaging transport roles at its existing factory**

`createMessagingS3` is the sole messaging-service constructor and configuration reader. It parses
internal `MINIO_ENDPOINT`, obtains the public endpoint from the shared resolver, constructs both
clients with identical region/credentials/path-style settings, and returns the interface above.
Production rejects a missing internal endpoint, credentials, bucket, or public origin instead of
falling back to development defaults.

`MessagingStorageModule` registers that factory once under `MESSAGING_S3` and exports the token to
`MessageModule` and `ComplianceModule`. `MediaService` injects `presignClient`; object verifier,
finalization, thumbnail, and purge inject `internalClient`. Delete every service-local S3
constructor and `MINIO_*` read in the same change, so configuration and client roles have one
runtime authority rather than five equivalent factories.

The production compose values are:

```yaml
farm-service:
  environment:
    MINIO_BUCKET: aquaculture
    MINIO_PUBLIC_URL: https://app.suderra.com
messaging-service:
  environment:
    MINIO_ENDPOINT: http://minio:9000
    MINIO_BUCKET: messaging
    MINIO_PUBLIC_URL: https://app.suderra.com
```

Gateway/admin keep fixed bucket `aquaculture` and receive the same public URL. Staging overrides
these exact values to `aquaculture-staging`, `messaging-staging`, and `https://staging.suderra.com`.

- [ ] **Step 5: Generate the narrow edge route from one manifest**

Add:

```json
"storage:public-routes:render": "node scripts/storage/render-public-object-routes.mjs --write",
"storage:public-routes:check": "node scripts/storage/render-public-object-routes.mjs --check"
```

The renderer requires every route-manifest environment key to resolve exactly once through
`droplet-environments.json`; the route manifest cannot restate an origin. It owns one bounded block
in the nginx source template, after which `render-droplet-config.mjs` produces each deployment's
selected runtime output. It emits exact locations `^~ /aquaculture/`, `^~ /messaging/`,
`^~ /aquaculture-staging/`, and `^~ /messaging-staging/`. Each location starts with a generated
exact-host guard derived from its manifest environment: production prefixes return 404 unless
`$host` is `app.suderra.com`, and staging prefixes return 404 unless `$host` is
`staging.suderra.com`. Thus a bucket prefix declared for one environment never becomes reachable
through the other environment's origin. After that guard, each location has this common policy:

```nginx
client_max_body_size 25m;
limit_except GET PUT HEAD { deny all; }
set $backend_public_objects minio;
proxy_pass http://$backend_public_objects:9000;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header Cookie "";
proxy_hide_header Set-Cookie;
proxy_hide_header Content-Security-Policy;
proxy_hide_header Cache-Control;
proxy_hide_header Content-Type;
proxy_hide_header Content-Disposition;
proxy_request_buffering off;
proxy_buffering off;
add_header Content-Type $public_object_content_type always;
add_header Content-Disposition $public_object_disposition always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header Content-Security-Policy "default-src 'none'; sandbox" always;
add_header Cache-Control "private, no-store" always;
```

No rewrite or `proxy_pass` URI suffix is permitted: path, query, and Host must reach MinIO exactly
as signed. The manifest/generator rejects duplicate, nested, wildcard, non-lowercase, or non-slug
bucket names, an unknown/extra deployment key, a host mismatch with the droplet-environment
authority, and any emitted route without one exact selected-origin guard.

The same generator emits closed `map` values in the `http` context. Only the manifest's exact
`inlineResponseTypes` retain their upstream MIME and receive `Content-Disposition: inline`;
everything else is returned as `application/octet-stream` plus `Content-Disposition: attachment`.
The list is sorted/unique and rejects HTML, XML, SVG, JavaScript, ECMAScript, CSS, or any wildcard.
Upstream `response-content-type`/`response-content-disposition` query overrides cannot bypass these
edge-owned headers. This response policy is deliberately narrower than upload allowlists: it is the
single edge authority deciding what may render inline from the application's origin.

It also emits one `public_object_safe` access-log format containing timestamp, remote address,
request ID, method, declared bucket, status, and byte count only. The format and each generated
location reject `$request`, `$request_uri`, `$uri`, `$args`, `$is_args`, headers, cookies, and
upstream URLs, then override the inherited combined log with that safe format. Presigned query
capabilities and tenant/object keys must never enter nginx logs.

```bash
npm run storage:public-routes:render
npm run storage:public-routes:check
```

- [ ] **Step 6: Extend the real edge smoke with a real MinIO signature**

Extend Task 2's two-case renderer harness; do not create a second proxy fixture. On its uniquely
labelled Docker network it resolves `minio` only with `resolve-ci-image.mjs`, starts that exact
digest, and creates all four route-manifest buckets through the AWS SDK's internal endpoint. The
production case renders only the production runtime identity and mounts only its certificate; the
staging case does the same for staging. Each case signs against the origin resolved from
`droplet-environments.json` and sends requests through that rendered nginx with curl `--resolve` and
matching SNI.

Assert:

- signed PUT, GET, and HEAD succeed for `aquaculture` and `messaging` through
  `https://app.suderra.com`, and for `aquaculture-staging` and `messaging-staging` through
  `https://staging.suderra.com`; every GET returns identical SHA-256 bytes and every HEAD preserves
  the edge-owned response policy;
- changing one query-signature byte or object path returns 403;
- unsigned GET/PUT returns 403;
- POST/DELETE is denied and an over-26,214,400-byte declared body is rejected before upstream;
- in the production case every staging bucket through the production Host, and in the staging case
  every production bucket through the staging Host, returns 404 without reaching MinIO, after that
  case's two same-host positive buckets have passed;
- MinIO receives no Cookie header and cannot set one on the browser;
- object responses carry HSTS, `nosniff`, `DENY`, same-origin resource policy, `private, no-store`,
  and sandbox CSP;
- an internally seeded `application/javascript`, `text/html`, and `image/svg+xml` object is served
  only as attachment/octet-stream;
- a canary object key and SigV4 query value appear in neither the edge nor container logs; the
  redacted object log contains only the declared bucket/method/status/request ID evidence;
- the public URL contains neither `minio`, port 9000, URL userinfo, the secret key, nor a non-HTTPS
  scheme. The standard SigV4 `X-Amz-Credential` query value necessarily contains the non-secret
  access-key ID and credential scope; the test accepts only that protocol-defined occurrence.

Curl proves bytes, signatures, and headers but does not claim browser non-execution. Add a
Playwright config that reaches the same live droplet container with pinned Chromium, self-signed
certificate tolerance, and closed host-resolver rules for only `app.suderra.com` and
`staging.suderra.com`. `public-object-execution.spec.ts` loads the real signed edge URLs and proves
JavaScript/HTML/SVG/polyglot objects cannot execute through classic script, module script, dedicated
`Worker`, `importScripts`, service-worker registration, iframe/embed, or top-level navigation, while
a safe JPEG renders. No Express/nginx test fixture may restate the response policy.

```bash
npm --prefix e2e ci --ignore-scripts --no-audit
npm --prefix e2e exec -- playwright install --with-deps chromium
bash scripts/ci/aquamobil-delivery-smoke.sh
npm --prefix e2e run test:mobile-edge
```

Expected before implementation: FAIL because there is no edge object route. Expected after
implementation: all asset and object assertions pass through the production config.

Update the reusable `aquamobil-delivery` job in this same task to install from
`e2e/package-lock.json`, install pinned Chromium with
`npm --prefix e2e exec -- playwright install --with-deps chromium`, and run `test:mobile-edge`
against the smoke network. Its workflow invariant requires this ordering; the I1 aggregate cannot
become green from curl-only assertions.

- [ ] **Step 7: Run focused, generated, and production-config gates**

```bash
npx nx test storage --runInBand --skip-nx-cache --testPathPatterns='public-storage-endpoint|public-presign'
npx nx test messaging-service --runInBand --skip-nx-cache --testPathPatterns='messaging-s3-client|media.service|s3-storage-object-verifier|media-finalization|thumbnail|attachment-object-purge'
npx nx test farm-service --runInBand --skip-nx-cache --testPathPatterns='incident-media'
npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runInBand --runTestsByPath tests/invariants/mobile-object-storage-boundary.spec.ts tests/invariants/mobile-asset-serving.spec.ts tests/invariants/mobile-csp-headers.spec.ts
npm run storage:public-routes:check
npm run findings:verify
bash scripts/ci/aquamobil-delivery-smoke.sh
npm --prefix e2e run test:mobile-edge
docker compose -f docker-compose.droplet.yml config --quiet
docker compose -f docker-compose.droplet.yml -f docker-compose.staging.yml config --quiet
```

Expected: PASS; internal operations and public signing are separate, both compose graphs resolve,
and the live signature survives the edge unchanged.

- [ ] **Step 8: Commit and push the object-route correction**

```bash
git add infrastructure/storage/public-object-routes.json scripts/storage/render-public-object-routes.mjs tests/invariants/mobile-object-storage-boundary.spec.ts e2e/playwright.aquamobil-edge.config.ts e2e/tests/mobile-edge/public-object-execution.spec.ts e2e/package.json libs/storage/src/public-storage-endpoint.ts libs/storage/src/__tests__/public-storage-endpoint.spec.ts libs/storage/src/__tests__/minio-public-presign.spec.ts libs/storage/src/__tests__/storage.module.spec.ts libs/storage/src/interfaces/storage.interfaces.ts libs/storage/src/minio-client.service.ts libs/storage/src/index.ts apps/farm-service/src/app.module.ts apps/gateway-api/src/app.module.ts apps/admin-api-service/src/app.module.ts apps/messaging-service/src/shared/messaging-s3-client.factory.spec.ts apps/messaging-service/src/shared/messaging-s3-client.factory.ts apps/messaging-service/src/shared/messaging-storage.module.ts apps/messaging-service/src/message/message.module.ts apps/messaging-service/src/compliance/compliance.module.ts apps/messaging-service/src/message/services/media.service.ts apps/messaging-service/src/message/services/__tests__/media.service.spec.ts apps/messaging-service/src/message/services/s3-storage-object-verifier.service.ts apps/messaging-service/src/message/services/__tests__/s3-storage-object-verifier.service.spec.ts apps/messaging-service/src/message/services/media-finalization.service.ts apps/messaging-service/src/message/services/__tests__/media-finalization.service.spec.ts apps/messaging-service/src/message/services/thumbnail.service.ts apps/messaging-service/src/message/services/__tests__/thumbnail.service.spec.ts apps/messaging-service/src/compliance/services/attachment-object-purge.service.ts apps/messaging-service/src/compliance/services/__tests__/attachment-object-purge.service.spec.ts infrastructure/nginx/droplet.conf docker-compose.droplet.yml docker-compose.staging.yml scripts/ci/aquamobil-delivery-smoke.sh .github/workflows/aquamobil-delivery.yml docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md docs/reviews/_registry/findings.jsonl package.json
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
object_route_finding_id="$(node - <<'NODE'
const fs = require('node:fs');
const title = 'AquaMobil presigned object URLs expose the internal MinIO origin';
const rows = fs
  .readFileSync('docs/reviews/_registry/findings.jsonl', 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse)
  .filter((row) => row.title === title);
if (rows.length !== 1) throw new Error(`expected one finding, got ${rows.length}`);
process.stdout.write(rows[0].id);
NODE
)"
[[ "$object_route_finding_id" =~ ^INFRA-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "security(storage): give browsers one signed object origin" -m "Keep object operations on the internal MinIO client while public presigners and the real edge share one HTTPS host, path, query, and bucket authority." -m "Closes: docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md#$object_route_finding_id"
git push
```

Expected: the same I1 boundary contains both reviewed security commits. After its protected PR
merges, retain the I1 worktree, execute the program's serialized I1 reconciliation, and clean that
exact boundary worktree through the coordinator only after the `merge.json` record is
protected-main-reachable. V0 does not start until that reconciliation is a protected-main ancestor
and the delivery workflow is green.

---

### Task 4: V0 — install a canonical standalone test command

**Files:**

- Create through the program capture tool:
  `docs/superpowers/evidence/aquamobil-v4/slices/V0/preflight.json`
- Modify: `web/apps/aquamobil/package.json`
- Modify: `web/apps/aquamobil/package-lock.json`
- Modify: `package-lock.json`
- Modify: `web/apps/aquamobil/vitest.config.ts`
- Create: `web/apps/aquamobil/vitest.invariant.config.ts`
- Create: `web/apps/aquamobil/src/__tests__/vitest-lanes.spec.ts`

**Interfaces:**

- Consumes: current AquaMobil Vitest aliases/setup plus the root-workspace and standalone lock
  authorities.
- Produces: non-overlapping `test` and `test:invariant` package commands used by every later task.

- [ ] **Step 1: Enter the coordinator-created V0 worktree and prove the script is missing**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
V0_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-path \
  --slice V0 --boundary appearance-foundation)"
test "$V0_WORKTREE" = "/var/aqua-saas/.worktrees/aquamobil-v4-v0"
test "$(pwd -P)" = "$V0_WORKTREE"
test "$(git branch --show-current)" = "feat/aquamobil-v0-appearance-foundation"
V0_PREFLIGHT=docs/superpowers/evidence/aquamobil-v4/slices/V0/preflight.json
test -f "$V0_PREFLIGHT"
test "$(git rev-parse HEAD)" = "$(jq -r '.baseMainCommit' "$V0_PREFLIGHT")"
git show origin/main:docs/superpowers/evidence/aquamobil-v4/slices/I1/merge.json |
  jq -e '.slice == "I1" and [.implementationBoundaries[].boundaryId] == ["asset-storage-and-tls-boundary"]'
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice V0 --check "$V0_PREFLIGHT" --main-ref origin/main
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
npm --prefix web/apps/aquamobil test
```

Expected: FAIL with `Missing script: test`.

- [ ] **Step 2: Write the failing lane-partition test**

`vitest-lanes.spec.ts` resolves both configs and requires every discovered `*.spec.ts[x]` file to
belong to exactly one of `ordinary` or `invariant`, where a filename ending `.invariant.spec.ts[x]`
belongs only to `invariant`.

```bash
npm --prefix web/apps/aquamobil exec -- vitest run src/__tests__/vitest-lanes.spec.ts --config vitest.config.ts
```

Expected: FAIL because `vitest.invariant.config.ts` does not exist and the ordinary config does not
exclude invariant filenames.

- [ ] **Step 3: Add the exact scripts, configs, and direct build dependency**

Add:

```json
"test": "vitest run --config vitest.config.ts",
"test:invariant": "vitest run --config vitest.invariant.config.ts"
```

The default config excludes `**/*.invariant.spec.ts` and `**/*.invariant.spec.tsx`; the invariant
config includes only those two suffixes and inherits the same aliases, environment, setup, coverage
exclusions, and worker limits.

Add `esbuild: "0.27.7"` as a direct dev dependency because the appearance build plugin imports its
API. AquaMobil is both a root npm workspace and a standalone Docker package, so update both lock
authorities from the same package declaration and prove both clean installs:

```bash
npm install --package-lock-only --ignore-scripts --workspace @aquaculture/aquamobil --save-dev --save-exact esbuild@0.27.7
npm --prefix web/apps/aquamobil install --package-lock-only --ignore-scripts --save-dev --save-exact esbuild@0.27.7
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
```

- [ ] **Step 4: Run the canonical suites**

```bash
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run test:invariant
```

Expected: existing ordinary and invariant AquaMobil specs pass through their two canonical,
non-overlapping commands.

- [ ] **Step 5: Commit and push the test authority**

```bash
git add web/apps/aquamobil/package.json web/apps/aquamobil/package-lock.json package-lock.json web/apps/aquamobil/vitest.config.ts web/apps/aquamobil/vitest.invariant.config.ts web/apps/aquamobil/src/__tests__/vitest-lanes.spec.ts docs/superpowers/evidence/aquamobil-v4/slices/V0/preflight.json
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "test(aquamobil): install the standalone vitest authority" -m "Give every redesign slice one canonical test command before it adds behavior."
git push -u origin feat/aquamobil-v0-appearance-foundation
```

---

### Task 5: V0 — build one CSP-safe appearance runtime

**Files:**

- Create: `web/apps/aquamobil/src/appearance/contract.ts`
- Create: `web/apps/aquamobil/src/appearance/runtime.ts`
- Create: `web/apps/aquamobil/src/appearance/global.d.ts`
- Create: `web/apps/aquamobil/scripts/appearance-runtime-plugin.ts`
- Create: `web/apps/aquamobil/src/appearance/__tests__/runtime.spec.ts`
- Create: `web/apps/aquamobil/src/appearance/__tests__/build-contract.spec.ts`
- Create: `web/apps/aquamobil/src/hooks/useDensity.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useDarkMode.binding.spec.tsx`
- Modify: `web/apps/aquamobil/src/hooks/useDarkMode.ts`
- Modify: `web/apps/aquamobil/src/hooks/index.ts`
- Modify: `web/apps/aquamobil/index.html`
- Modify: `web/apps/aquamobil/vite.config.ts`
- Modify: `web/apps/aquamobil/tsconfig.json`
- Modify: `web/apps/aquamobil/tsconfig.node.json`
- Modify: `web/apps/aquamobil/src/vite-env.d.ts`
- Create: `web/apps/aquamobil/project.json`
- Create: `tests/invariants/aquamobil-build-generation.spec.ts`
- Modify: `infrastructure/docker/Dockerfile.aquamobil`
- Modify: `scripts/ci/aquamobil-delivery-smoke.sh`
- Modify: `.github/workflows/ci-full.yml`
- Modify: `.github/workflows/ci-affected.yml`
- Modify: `.github/workflows/performance-benchmark.yml`
- Modify: `.github/workflows/deploy-digitalocean.yml`
- Modify: `.github/workflows/deploy-staging.yml`
- Modify: `.github/workflows/aquamobil-delivery.yml`

**Interfaces:**

- Consumes: Task 4's direct esbuild `0.27.7` dependency and `/mobile/` base.
- Produces: `AppearanceRuntimeV0`, content-hashed classic IIFE, typed global, and hook bindings used
  by tokens, product surfaces, the generation handshake, and convergence.

- [ ] **Step 1: Write runtime tests before the runtime**

Pin this V0 contract:

```ts
export const APPEARANCE_API_VERSION = 1 as const;
export type AppearancePreferenceV0 = 'light' | 'dark' | 'system';
export type ResolvedAppearanceV0 = 'light' | 'dark';
export type TouchDensity = 'standard' | 'glove';

export interface AppearanceSnapshotV0 {
  preference: AppearancePreferenceV0;
  theme: ResolvedAppearanceV0;
  density: TouchDensity;
  isDark: boolean;
  themeColor: string;
}

export interface AppearanceRuntimeV0 {
  readonly apiVersion: 1;
  readonly buildId: string;
  getSnapshot(): AppearanceSnapshotV0;
  subscribe(listener: () => void): () => void;
  setPreference(preference: AppearancePreferenceV0): void;
  cyclePreference(): void;
  setDensity(density: TouchDensity): void;
}
```

Tests cover valid/invalid storage, `system` OS changes, cross-tab changes, blocked/unavailable
storage, `.dark`, `data-density`, `theme-color`, stable snapshots, unsubscribe, and one notification
per effective change.

Run:

```bash
npm --prefix web/apps/aquamobil test -- src/appearance/__tests__/runtime.spec.ts
```

Expected: FAIL because the runtime does not exist.

- [ ] **Step 2: Implement the authored authority**

`runtime.ts` installs `window.__AQUAMOBIL_APPEARANCE__` synchronously. It is the only module that
reads/writes appearance storage, calls `matchMedia`, mutates `.dark`/`data-density`, or changes the
theme-color meta element. Storage failures resolve through the documented system preference and do
not throw.

`useDarkMode` and `useDensity` use `useSyncExternalStore` against the global API only. A missing or
API/build-mismatched global throws an explicit boot-contract error; hooks do not create a fallback
store. Every supplied `AQUAMOBIL_BUILD_ID` must match `^[0-9a-f]{40}$`; CI and Docker builds require
it, while local non-CI build/dev may use the literal `local` only when the variable is absent. Add
the required Docker build argument now. `ci-full.yml`, `ci-affected.yml`,
`performance-benchmark.yml`, `deploy-digitalocean.yml`, `deploy-staging.yml`, and the reusable
`aquamobil-delivery.yml` all pass the full checked-out application SHA, and the delivery smoke uses
the full `git rev-parse HEAD`. The plugin writes that same value to `meta[name=aquamobil-build-id]`
and `AppearanceRuntimeV0.buildId`; a mismatch fails the build contract. A CI or deployment path may
never publish `local`, a short SHA, a run number, or a mutable branch label.

Create `web/apps/aquamobil/project.json` as the explicit overlay for the inferred
`@aquaculture/aquamobil` project. Preserve the inferred Vite build target and set its inputs to
exactly `['production', '^production', { "env": "AQUAMOBIL_BUILD_ID" }]` and its outputs to exactly
`['{projectRoot}/dist']`. This prevents Nx from restoring a different generation's `dist` from cache
and removes the inherited `{projectRoot}/build` cache output that conflicts with the repository's
ignored build-directory convention. Authored Vite plugins live under the tracked
`web/apps/aquamobil/scripts/` directory, never under an ignored `build/` directory.
`aquamobil-build-generation.spec.ts` runs `nx show project @aquaculture/aquamobil --json`, requires
the resolved input/output pair, scans all six build-capable workflows plus the Docker argument, and
rejects any CI build whose ID is not the full checked-out SHA. The closeout plan extends the same
invariant when its workflow is added.

Edits to CI Full and CI-Affected preserve their Order 0 terminal candidate checkout/emitter/upload
steps and the manifest's four-context/three-artifact mapping; build-ID propagation neither replaces
nor creates candidate evidence.

- [ ] **Step 3: Write the emitted-asset contract test**

The build test requires:

- no inline script in `dist/index.html`;
- `meta[name=theme-color]` before the appearance script;
- one blocking classic script under `/mobile/assets/appearance-runtime.<content-hash>.js`;
- the referenced file exists and installs API version 1 with the HTML build ID;
- the asset appears in `self.__WB_MANIFEST` with the same revision;
- no `public/theme-init.js` and no stable appearance filename;
- changing the authored runtime changes the emitted filename.

Run:

```bash
npm --prefix web/apps/aquamobil test -- src/appearance/__tests__/build-contract.spec.ts
```

Expected: FAIL because the Vite plugin and HTML marker do not exist.

- [ ] **Step 4: Emit a content-hashed classic IIFE and rewrite matching HTML**

`appearance-runtime-plugin.ts` bundles the typed source with the direct esbuild API as
`format: 'iife'`, computes the content hash from emitted bytes, emits it through Vite, replaces a
single `<!-- aquamobil-appearance-runtime -->` marker, and fails on zero or multiple markers. It
also exposes the exact same bytes in dev middleware.

Move `theme-color` before the marker. Delete the inline script. Keep application modules after the
runtime.

- [ ] **Step 5: Make focused tests and production build green**

```bash
npm --prefix web/apps/aquamobil test -- src/appearance/__tests__/runtime.spec.ts src/appearance/__tests__/build-contract.spec.ts src/hooks/__tests__/useDarkMode.binding.spec.tsx
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath tests/invariants/aquamobil-build-generation.spec.ts
```

Expected: all pass and `dist/index.html` references the single hashed runtime.

---

### Task 6: V0 — render AquaMobil CSP from the platform SSoT

**Files:**

- Modify: `infrastructure/security/csp.policy.json`
- Modify: `scripts/security/render-csp.mjs`
- Modify: `infrastructure/docker/nginx/snippets/security-headers.conf` (generated)
- Modify: `infrastructure/nginx/droplet.conf`
- Modify: `tests/invariants/mobile-csp-headers.spec.ts`
- Modify: `tests/invariants/aquamobil-build-generation.spec.ts`
- Modify: `web/apps/aquamobil/src/appearance/__tests__/build-contract.spec.ts`
- Create: `web/apps/aquamobil/src/__tests__/csp-style-attribute.invariant.spec.ts`
- Create: `web/apps/aquamobil/scripts/firebase-messaging-worker-plugin.ts`
- Create: `web/apps/aquamobil/src/pwa/firebase-messaging-sw.ts`
- Create: `web/apps/aquamobil/src/pwa/__tests__/firebase-worker-build-contract.spec.ts`
- Delete: `web/apps/aquamobil/public/firebase-messaging-sw.js`
- Modify: `web/apps/aquamobil/src/pwa/__tests__/firebase-messaging-sw.source.spec.ts`
- Modify: `web/apps/aquamobil/src/pwa/__tests__/sw-build-artifact.invariant.spec.ts`
- Modify: `web/apps/aquamobil/vite.config.ts`
- Modify: `web/apps/aquamobil/tsconfig.node.json`
- Modify: `web/apps/aquamobil/tsconfig.sw.json`
- Modify: `infrastructure/docker/Dockerfile.aquamobil`
- Modify: `scripts/ci/aquamobil-delivery-smoke.sh`
- Modify: `.github/workflows/deploy-digitalocean.yml`
- Modify: `.github/workflows/deploy-staging.yml`
- Modify: `.github/workflows/aquamobil-delivery.yml`
- Modify: `.github/workflows/ci-full.yml`
- Modify: `.github/workflows/ci-affected.yml`
- Modify: `.github/workflows/performance-benchmark.yml`
- Modify: `apps/gateway-api/src/csp-report/csp-report.controller.ts`
- Modify: `apps/gateway-api/src/csp-report/__tests__/csp-report.controller.spec.ts`
- Modify: `docs/reviews/aquamobil-e2e-audit/2026-06-13-findings.md`
- Create: `e2e/playwright.aquamobil-pwa.config.ts`
- Create: `e2e/tests/mobile-pwa/fixtures/generation-server.mjs`
- Create: `e2e/tests/mobile-pwa/appearance-first-paint.spec.ts`
- Modify: `e2e/package.json`

**Interfaces:**

- Consumes: `infrastructure/security/csp.policy.json`, Task 5's hashed runtime artifact, the
  standalone lock's one Firebase SDK version, and the existing FCM worker behavior tests.
- Produces: generated AquaMobil nginx CSP plus a backend-free production browser harness reused by
  the generation matrix, a self-contained same-origin FCM worker, and one bounded, privacy-safe CSP
  report normalizer for both browser report formats.

- [ ] **Step 1: Extend the failing CSP test**

Require AquaMobil's generated profile to be exactly:

```text
default-src 'self';
script-src 'self';
script-src-elem 'self';
style-src 'self';
style-src-elem 'self';
style-src-attr 'unsafe-inline';
worker-src 'self';
img-src 'self' data: blob:;
media-src 'self' blob:;
connect-src 'self' https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com;
font-src 'self';
manifest-src 'self';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
report-uri /api/csp-report;
report-to csp-endpoint;
```

Require `Reporting-Endpoints: csp-endpoint="/api/csp-report"`. Reject `unsafe-inline` from every
directive except the exact `style-src-attr` line; reject every wildcard, nonce, hash escape hatch,
Google Fonts, jsDelivr, gstatic script origin, and scheme-wide `ws:`/`wss:` source. Same-origin
Socket.IO must work through `'self'`, and a foreign WSS origin must raise `securitypolicyviolation`.
Move the current inline `<style>` block from `index.html` into `src/styles/main.css`; scripts and
style elements remain external-only.

`csp-style-attribute.invariant.spec.ts` records the current React `style={{...}}` and DOM `.style`
consumers that justify the one attribute exception, rejects an inline `<style>` element or inline
script anywhere in the production document path, and fails if the exception is broadened to
`style-src`/`style-src-elem`. The Playwright matrix visits every currently style-attribute-using
route and proves the dynamic layout remains visible under the exact production header.

Extend `csp-report.controller.spec.ts` before implementation. It must fail on the current
fire-and-forget, cast-based behavior and cover both the legacy `application/csp-report` wrapper and
a Reporting API `application/reports+json` array. Pin a maximum of 20 reports, 2,048 characters per
accepted string, finite bounded line/column/status numbers, `type === 'csp-violation'`, and a 64-KiB
edge body ceiling. Unsupported content types, malformed wrappers, oversized batches, nested objects
in scalar fields, and prototype-pollution keys are rejected without publication. Normalize camelCase
Reporting API fields and hyphenated legacy fields without `as` casts.

Before structured logging or NATS publication, strip URL credentials, query strings, and fragments
from document/referrer/source/blocked URLs; reduce `data:`/`blob:` and malformed values to safe
scheme/invalid sentinels; omit script samples; mask the client IP; and bound the user agent. The
controller becomes `async`, awaits all at-most-20 publish attempts, and returns 204 after logging
only sanitized failure counts if an optional publisher is absent or rejects. A publication failure
never logs the rejected raw payload and never becomes an unhandled promise rejection or browser
retry storm.

The FCM source/build tests initially require no `importScripts`, no gstatic URL, no unfinished
dynamic `sha256-` marker, one bundled Firebase version from the standalone lock, and preservation of
the active-user IndexedDB gate, data-only notification path, opaque notification reference
validation, click-origin allowlist, and deeper registration scope.

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand --runTestsByPath tests/invariants/mobile-csp-headers.spec.ts
npx nx test gateway-api --runInBand --skip-nx-cache --testPathPatterns='csp-report.controller'
npm --prefix web/apps/aquamobil test -- src/pwa/__tests__/firebase-messaging-sw.source.spec.ts src/pwa/__tests__/firebase-worker-build-contract.spec.ts
npm --prefix web/apps/aquamobil run test:invariant -- src/pwa/__tests__/sw-build-artifact.invariant.spec.ts
```

Expected: FAIL because the snippet is outside the renderer, required directives/reporting are
missing, and the static worker still imports two remote compat scripts.

- [ ] **Step 2: Add AquaMobil as a renderer target**

Add named profile `aquamobil` to `csp.policy.json` and point a generated nginx-snippet output at it.
The renderer validates directive order, rejects duplicate directives/sources and wildcards, and
renders both CSP and `Reporting-Endpoints`; do not hand-maintain a second policy. Harden the
existing edge report location to POST only, `client_max_body_size 64k`, and the existing API
rate-limit zone. Add a stable `<a id="sec-medium-052"></a>` finding anchor without marking the
finding resolved before merge.

Implement the tested CSP report normalizer in the existing gateway controller rather than creating a
second endpoint or event type. The legacy and Reporting API inputs converge on one validated,
sanitized internal value before the existing `SecurityEventService.publishCspViolation` call. Keep
the endpoint public only because browsers post it automatically; the body/content-type/rate/size
bounds and awaited sanitized failure policy are mandatory compensating controls.

```bash
npm run csp:render
npm run csp:check
```

- [ ] **Step 3: Bundle the existing FCM behavior from the one Firebase dependency**

Move the authored worker into `src/pwa/firebase-messaging-sw.ts`. Use modular `firebase/app` and
`firebase/messaging/sw` imports from the standalone `firebase` dependency; do not add a second SDK,
compat CDN, vendored remote script, or inline worker. The build plugin uses esbuild to emit stable
`dist/firebase-messaging-sw.js`, fails if an asset/public-file collision exists, and verifies that
the bundle contains no HTTP(S) script import.

Keep its query-config parsing, distinct `/mobile/firebase-cloud-messaging-push-scope`, durable
active-user gate, notification behavior, and logout path. The page still registers the stable
generated worker; only its implementation authority moves from public JavaScript to typed source.
Extend `tsconfig.sw.json` to include both authored workers so the canonical `typecheck` command
checks the bundled FCM source with `WebWorker` globals rather than relying on esbuild transpilation.

```bash
npm --prefix web/apps/aquamobil test -- src/pwa/__tests__/firebase-messaging-sw.source.spec.ts src/pwa/__tests__/firebase-worker-build-contract.spec.ts src/hooks/__tests__/useFirebaseMessaging-sw-scope.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- src/pwa/__tests__/sw-build-artifact.invariant.spec.ts
```

Expected: PASS; the emitted FCM worker is self-contained and the only allowed external connections
are the two exact Firebase API origins.

- [ ] **Step 4: Prove runtime execution under production CSP**

Add `test:mobile-pwa` as
`playwright test --config playwright.aquamobil-pwa.config.ts --project=aquamobil-pwa`. The fixture
server serves a production `dist` at `/mobile/` with the rendered nginx CSP, exact MIME types, no
HTML fallback for extension requests, and no backend/database dependency.

The browser spec installs a pre-document observer and proves the first observed `class`,
`data-density`, and theme-color values already match stored preference. Cover light, dark, system
preference changes, blocked storage, cross-tab storage events, and CSP `securitypolicyviolation`. No
assertion waits for React before reading the first observed state.

Extend the reusable delivery workflow and its invariant so the first Playwright invocation is
preceded by the standalone E2E `npm ci` and the exact Chromium install command shown below. The E2E
directory is not a root npm workspace; a root install never substitutes for its lock authority.
Preserve the CI Full and CI-Affected terminal candidate emitter/upload steps unchanged while adding
these dependencies; the reusable delivery workflow remains domain evidence only.

Run the appearance build contract, first-paint browser spec, and delivery smoke:

```bash
npm --prefix web/apps/aquamobil test -- src/appearance/__tests__/build-contract.spec.ts
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm --prefix e2e ci --ignore-scripts --no-audit
npm --prefix e2e exec -- playwright install --with-deps chromium
npm --prefix e2e run test:mobile-pwa -- --grep "appearance first paint"
bash scripts/ci/aquamobil-delivery-smoke.sh
```

Expected: PASS with no page/worker CSP violation and no external script fetch.

- [ ] **Step 5: Commit the appearance/CSP authority**

```bash
git add web/apps/aquamobil/src/appearance web/apps/aquamobil/src/hooks/useDarkMode.ts web/apps/aquamobil/src/hooks/useDensity.ts web/apps/aquamobil/src/hooks/index.ts web/apps/aquamobil/src/hooks/__tests__/useDarkMode.binding.spec.tsx web/apps/aquamobil/index.html web/apps/aquamobil/src/styles/main.css web/apps/aquamobil/src/__tests__/csp-style-attribute.invariant.spec.ts web/apps/aquamobil/src/pwa/firebase-messaging-sw.ts web/apps/aquamobil/src/pwa/__tests__/firebase-messaging-sw.source.spec.ts web/apps/aquamobil/src/pwa/__tests__/firebase-worker-build-contract.spec.ts web/apps/aquamobil/src/pwa/__tests__/sw-build-artifact.invariant.spec.ts web/apps/aquamobil/public/firebase-messaging-sw.js web/apps/aquamobil/vite.config.ts web/apps/aquamobil/project.json web/apps/aquamobil/tsconfig.json web/apps/aquamobil/tsconfig.node.json web/apps/aquamobil/tsconfig.sw.json web/apps/aquamobil/src/vite-env.d.ts web/apps/aquamobil/scripts/appearance-runtime-plugin.ts web/apps/aquamobil/scripts/firebase-messaging-worker-plugin.ts infrastructure/docker/Dockerfile.aquamobil scripts/ci/aquamobil-delivery-smoke.sh .github/workflows/ci-full.yml .github/workflows/ci-affected.yml .github/workflows/performance-benchmark.yml .github/workflows/deploy-digitalocean.yml .github/workflows/deploy-staging.yml .github/workflows/aquamobil-delivery.yml infrastructure/security/csp.policy.json scripts/security/render-csp.mjs infrastructure/docker/nginx/snippets/security-headers.conf infrastructure/nginx/droplet.conf tests/invariants/mobile-csp-headers.spec.ts tests/invariants/aquamobil-build-generation.spec.ts apps/gateway-api/src/csp-report/csp-report.controller.ts apps/gateway-api/src/csp-report/__tests__/csp-report.controller.spec.ts docs/reviews/aquamobil-e2e-audit/2026-06-13-findings.md e2e/playwright.aquamobil-pwa.config.ts e2e/tests/mobile-pwa/fixtures/generation-server.mjs e2e/tests/mobile-pwa/appearance-first-paint.spec.ts e2e/package.json
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "security(aquamobil): compile one strict CSP runtime boundary" -m "Generate pre-paint and messaging-worker behavior from typed same-origin sources, then render the matching observable policy from the platform authority." -m "Closes: docs/reviews/aquamobil-e2e-audit/2026-06-13-findings.md#SEC-MEDIUM-052"
git push
```

---

### Task 7: V0 — add tokens, offline fonts, and primitive semantics

**Files:**

- Create: `web/apps/aquamobil/public/fonts/geist-latin.woff2`
- Create: `web/apps/aquamobil/public/fonts/geist-latin-ext.woff2`
- Create: `web/apps/aquamobil/public/fonts/geist-mono-latin.woff2`
- Create: `web/apps/aquamobil/public/fonts/geist-mono-latin-ext.woff2`
- Create: `web/apps/aquamobil/public/fonts/LICENSE-geist.txt`
- Create: `web/apps/aquamobil/public/fonts/LICENSE-geist-mono.txt`
- Create: `web/apps/aquamobil/public/fonts/PROVENANCE.json`
- Create: `web/apps/aquamobil/scripts/vendor-fonts.mjs`
- Create: `web/apps/aquamobil/src/styles/tokens.css`
- Create: `web/apps/aquamobil/src/__tests__/design-token.invariant.spec.ts`
- Modify: `web/apps/aquamobil/src/__tests__/field-ergonomics.invariant.spec.ts`
- Create: `web/apps/aquamobil/src/components/ui/Button.tsx`
- Create: `web/apps/aquamobil/src/components/ui/CapacityMeter.tsx`
- Create: `web/apps/aquamobil/src/components/ui/Card.tsx`
- Create: `web/apps/aquamobil/src/components/ui/Chip.tsx`
- Create: `web/apps/aquamobil/src/components/ui/EmptyState.tsx`
- Create: `web/apps/aquamobil/src/components/ui/HoldToConfirm.tsx`
- Create: `web/apps/aquamobil/src/components/ui/ListRow.tsx`
- Create: `web/apps/aquamobil/src/components/ui/NumPad.tsx`
- Create: `web/apps/aquamobil/src/components/ui/SegmentedControl.tsx`
- Create: `web/apps/aquamobil/src/components/ui/Sheet.tsx`
- Create: `web/apps/aquamobil/src/components/ui/Skeleton.tsx`
- Create: `web/apps/aquamobil/src/components/ui/SparkBars.tsx`
- Create: `web/apps/aquamobil/src/components/ui/StatTile.tsx`
- Create: `web/apps/aquamobil/src/components/ui/StatusDot.tsx`
- Create: `web/apps/aquamobil/src/components/ui/TypeTile.tsx`
- Create: `web/apps/aquamobil/src/components/ui/__tests__/CapacityMeter.spec.tsx`
- Create: `web/apps/aquamobil/src/components/ui/__tests__/HoldToConfirm.spec.tsx`
- Create: `web/apps/aquamobil/src/components/ui/__tests__/Sheet.spec.tsx`
- Create: `web/apps/aquamobil/src/components/ui/__tests__/StatusDot.spec.tsx`
- Modify: `web/apps/aquamobil/src/components/ui/IconButton.tsx`
- Create: `web/apps/aquamobil/src/components/ui/index.ts`
- Modify: `web/apps/aquamobil/src/styles/main.css`
- Modify: `web/apps/aquamobil/tailwind.config.js`
- Modify: `web/apps/aquamobil/package.json`

**Interfaces:**

- Consumes: `TouchDensity` and semantic CSS tokens from Tasks 4 and 6; existing `IconButton` keeps
  its public props.
- Produces: the only page-level control/surface primitives used by V1 through V5.

```ts
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'default' | 'save';
  block?: boolean;
  children: React.ReactNode;
}

export interface CapacityMeterProps {
  percent: number;
  watchAt?: number;
  limitAt?: number;
  readout?: React.ReactNode;
  segments?: number;
  className?: string;
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 1 | 2;
  elevated?: boolean;
  children: React.ReactNode;
}

export type ChipTone = 'neutral' | 'accent' | 'warn' | 'crit' | 'ok';
export interface ChipProps {
  tone?: ChipTone;
  onClick?: () => void;
  selected?: boolean;
  'aria-label'?: string;
  className?: string;
  children: React.ReactNode;
}

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: 'empty' | 'error';
  className?: string;
}

export interface HoldToConfirmProps {
  onConfirm: () => void;
  durationMs?: number;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}

export type RowTone =
  | 'neutral'
  | 'accent'
  | 'warn'
  | 'crit'
  | 'ok'
  | 'feeding'
  | 'mortality'
  | 'water'
  | 'cull'
  | 'transfer'
  | 'harvest';

export interface ListRowProps {
  leading?: React.ReactNode;
  tone?: RowTone;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  muted?: boolean;
  className?: string;
}

export interface NumPadProps {
  value: string;
  onChange(next: string): void;
  allowDecimal?: boolean;
  maxLength?: number;
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}
export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange(next: T): void;
  label: string;
  className?: string;
}

export interface SheetProps {
  open: boolean;
  onClose(): void;
  title: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export interface SkeletonProps {
  variant?: 'text' | 'row' | 'tile';
  count?: number;
  className?: string;
}

export interface SparkBarsProps {
  values: ReadonlyArray<number | null>;
  slots?: number;
  limit?: { value: number; direction: 'below' | 'above'; label: string };
  label: string;
  className?: string;
}

export interface StatusDotProps {
  tone?: 'neutral' | 'accent' | 'warn' | 'crit' | 'ok';
  label: string;
  pulse?: boolean;
  className?: string;
}

type StatTileBase = {
  label: string;
  value: React.ReactNode;
  unit?: string;
  spark?: React.ReactNode;
  className?: string;
};
export type StatTileProps = StatTileBase &
  ({ state?: 'neutral' | 'ok'; caption?: string } | { state: 'warn' | 'crit'; caption: string });

export type LogType = 'feeding' | 'mortality' | 'water' | 'cull' | 'transfer' | 'harvest';
export interface TypeTileProps {
  type: LogType;
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect(): void;
}
```

- [ ] **Step 1: Write ratchets and primitive behavior tests**

The tests require theme-token parity, density-token parity, all four local font faces, both OFL-1.1
notices, exact provenance, no font CDN, 44px touch floor, accessible sheet focus/escape behavior,
press-and-hold cancellation, a `StatusDot` whose visible label carries the meaning rather than
colour alone, and `CapacityMeter` semantics based on container current biomass/capacity rather than
a first batch. Preserve the existing field-ergonomics invariant as the sole authority, freeze the
reviewed V0 baselines from Global Constraints, and keep its already-green sub-10px count at zero.

Pin these output SHA-256 values:

```json
{
  "geist-latin.woff2": "824f485b5d26e2f2da3c2b236132ece1bc8e4e43373452950bb0e40548b4313f",
  "geist-latin-ext.woff2": "19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1",
  "geist-mono-latin.woff2": "1a189eb997c3e2ece68373e387afaec9e8617424186c4b1ab3cff7c54ba6223b",
  "geist-mono-latin-ext.woff2": "684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc"
}
```

```bash
npm --prefix web/apps/aquamobil run test:invariant -- src/__tests__/design-token.invariant.spec.ts src/__tests__/field-ergonomics.invariant.spec.ts
npm --prefix web/apps/aquamobil test -- src/components/ui/__tests__/CapacityMeter.spec.tsx src/components/ui/__tests__/HoldToConfirm.spec.tsx src/components/ui/__tests__/Sheet.spec.tsx src/components/ui/__tests__/StatusDot.spec.tsx
```

Expected: FAIL because tokens, fonts, and primitives are absent.

- [ ] **Step 2: Implement semantic tokens and primitives**

V0 token selectors use `.dark`/default plus `data-density`; do not expose `colour` yet and do not
paste source-branch final body styles over Konsta pages. Tailwind aliases semantic CSS variables
without deleting legacy palettes until convergence.

Implement `CapacityMeter` by clamping only its visual fill to 0-100 while retaining the honest
numeric readout and `aria-valuenow`; `watchAt` defaults to 70, `limitAt` to 90, and both threshold
labels are rendered in text. `HoldToConfirm` defaults to 700 ms, cancels on pointer-up/leave/cancel
or unmount, and gives keyboard activation parity. `Sheet` traps focus, closes on Escape/backdrop,
locks body scroll, and returns focus to the opener. `StatTile`'s discriminated union makes a
warn/critical caption mandatory.

`vendor-fonts.mjs --vendor` creates its own isolated scratch directory, calls `npm pack` for
`@fontsource-variable/geist@5.3.0` and `@fontsource-variable/geist-mono@5.3.0`, verifies the two npm
integrity strings from Global Constraints, extracts only normal latin/latin-ext WOFF2 files plus
their licenses, renames the four files as listed above, and writes `PROVENANCE.json`. It removes the
scratch tarballs on success/failure. `--check` performs no network access and verifies committed
hashes, license presence, font family metadata, and provenance.

Add:

```json
"fonts:vendor": "node scripts/vendor-fonts.mjs --vendor",
"fonts:check": "node scripts/vendor-fonts.mjs --check"
```

Run the one-time vendor action, then the offline check:

```bash
npm --prefix web/apps/aquamobil run fonts:vendor
npm --prefix web/apps/aquamobil run fonts:check
```

- [ ] **Step 3: Run V0 UI verification**

```bash
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run lint -- --no-cache
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm --prefix web/apps/aquamobil run fonts:check
bash scripts/ci/aquamobil-delivery-smoke.sh
```

Expected: all pass; all four `.woff2` files are present, precached, and served through `/mobile/`
with correct headers.

- [ ] **Step 4: Commit and push V0 visual foundation**

```bash
git add web/apps/aquamobil/public/fonts web/apps/aquamobil/scripts/vendor-fonts.mjs web/apps/aquamobil/package.json web/apps/aquamobil/src/styles web/apps/aquamobil/src/__tests__/design-token.invariant.spec.ts web/apps/aquamobil/src/__tests__/field-ergonomics.invariant.spec.ts web/apps/aquamobil/src/components/ui web/apps/aquamobil/tailwind.config.js
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
semantic_primitive_finding_id="$(jq -sre --arg title 'AquaMobil field surfaces lack one semantic primitive authority' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$semantic_primitive_finding_id" =~ ^MOB-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): establish semantic field primitives" -m "Give later page slices one token and interaction vocabulary while preserving the installed light-dark contract." -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md#$semantic_primitive_finding_id"
git push
```

---

### Task 8: V0 — make shell generations coherent across service-worker updates

**Files:**

- Create: `web/apps/aquamobil/src/pwa/shell-generation.ts`
- Create: `web/apps/aquamobil/src/pwa/client-generation.ts`
- Create: `web/apps/aquamobil/src/pwa/update-coordinator.ts`
- Create: `web/apps/aquamobil/src/pwa/__tests__/shell-generation.spec.ts`
- Create: `web/apps/aquamobil/src/pwa/__tests__/update-coordinator.spec.ts`
- Create: `e2e/tests/mobile-pwa/pwa-generation-update.spec.ts`
- Modify: `web/apps/aquamobil/scripts/appearance-runtime-plugin.ts`
- Modify: `web/apps/aquamobil/src/main.tsx`
- Modify: `web/apps/aquamobil/src/pwa/messaging-sw.ts`
- Modify: `web/apps/aquamobil/src/pwa/__tests__/sw-build-artifact.invariant.spec.ts`
- Modify: `web/apps/aquamobil/vite.config.ts`
- Modify: `web/apps/aquamobil/src/vite-env.d.ts`
- Modify: `infrastructure/docker/Dockerfile.aquamobil`
- Modify: `scripts/ci/aquamobil-delivery-smoke.sh`
- Modify: `.github/workflows/deploy-digitalocean.yml`
- Modify: `.github/workflows/deploy-staging.yml`
- Modify: `.github/workflows/aquamobil-delivery.yml`
- Modify: `e2e/playwright.aquamobil-pwa.config.ts`
- Modify: `e2e/tests/mobile-pwa/fixtures/generation-server.mjs`
- Modify: `e2e/package.json`

**Interfaces:**

- Consumes: `AppearanceRuntimeV0.buildId`, existing handwritten worker replay/logout handlers, and
  one deploy-supplied immutable build ID.
- Produces: `ShellGenerationMessage`, `shellCacheName()`, client coordinator, and a two-generation
  browser harness required before `.dark` can be removed.

- [ ] **Step 1: Define and test one message protocol**

Use a discriminated union shared by worker and client:

```ts
export type ShellGenerationMessage =
  | { type: 'AQUAMOBIL_CLIENT_GENERATION_READY'; buildId: string }
  | { type: 'AQUAMOBIL_REQUEST_CLIENT_GENERATION'; requestId: string }
  | { type: 'AQUAMOBIL_CLIENT_GENERATION'; requestId: string; buildId: string }
  | { type: 'AQUAMOBIL_ACTIVATE_GENERATION'; buildId: string }
  | {
      type: 'AQUAMOBIL_GENERATION_BLOCKED';
      buildId: string;
      reason: 'unknown-client';
      unknownClientCount: number;
    }
  | { type: 'AQUAMOBIL_RELOAD_FOR_GENERATION'; buildId: string }
  | { type: 'LOGOUT' };

export function shellCacheName(buildId: string): string;
```

Tests require validated build IDs, request/response correlation, no activation for the wrong waiting
generation, pre-activation refusal while any controlled client is unknown or does not answer, cache
retention for every generation reported by a controlled client, and retain-all behavior if an
unknown client is nevertheless observed after activation. Every preflight and retirement query must
enumerate `clients.matchAll({ type: 'window', includeUncontrolled: true })`, then parse each client
URL and retain only windows whose URL is inside the exact `new URL(self.registration.scope)`
origin/path boundary. The default query is forbidden because it can omit an old uncontrolled mobile
tab and activate too early; treating unrelated same-origin desktop-shell windows as mobile clients
is equally forbidden because they cannot answer this protocol and would block activation forever.

```bash
npm --prefix web/apps/aquamobil test -- src/pwa/__tests__/shell-generation.spec.ts src/pwa/__tests__/update-coordinator.spec.ts
```

Expected: FAIL because the handshake does not exist.

- [ ] **Step 2: Extend the existing HTML/runtime build ID into client and worker**

Extend Task 5's one immutable build ID per build into:

- the already matching `meta[name=aquamobil-build-id]` and `AppearanceRuntimeV0.buildId`;
- the client coordinator;
- the worker cache suffix and message protocol.

The build fails if any emitted authority carries a different ID. Keep Task 5's required
`AQUAMOBIL_BUILD_ID` Docker argument and `local` rejection; staging and DigitalOcean workflows pass
the full immutable application commit SHA. The delivery workflow uses its checked-out `github.sha`.
`aquamobil-delivery-smoke.sh` passes an explicitly supplied ID or, for a local unpublished smoke,
the full `git rev-parse HEAD`; it never lets the Docker build fall back to `local`.

- [ ] **Step 3: Replace contradictory worker lifecycle behavior**

Remove top-level `skipWaiting()`, `clientsClaim()`, `cleanupOutdatedCaches()`, and
`registerType: 'autoUpdate'`. Use prompt registration without `window.confirm`. Installation must
finish the entire injected manifest into `aquamobil-shell-${buildId}` before the worker waits. A
fully installed waiting worker announces readiness. Before honoring an activation request it queries
all currently controlled clients with a correlated request and durably records their build IDs. If
any client is unknown or misses the bounded response window, it emits
`AQUAMOBIL_GENERATION_BLOCKED`, retains every shell cache, and remains waiting; closing/reviving the
client and retrying is the only way forward. The coordinator explicitly activates only the matching
fully installed build after that preflight, reloads active/visible clients after `controllerchange`,
and marks known background clients for reload when visible.

On activate, claim and query the complete window set with
`clients.matchAll({ type: 'window', includeUncontrolled: true })`, filtered through that exact
registration-scope URL predicate. Retain the current cache and every reported generation. If any
in-scope mobile client is unknown or unresponsive, retain all shell generations. A mobile client
discovered after preflight but before activation blocks deletion and forces the same
retain-all/retry path; an unrelated `https://app.suderra.com/` shell client does not participate.
Delete a generation only after every in-scope mobile window responds and none names it.

Generation selection is explicit for every `FetchEvent` shape. An ordinary subresource uses
`clientId`; if that ID is empty or unknown, only an exact content-hashed URL present in one complete
installed generation may resolve, otherwise return the offline error instead of mixing caches. A
navigation that replaces an existing browsing context uses `replacesClientId` when supported to
select the old generation, serves that complete document, then atomically associates
`resultingClientId` with the same generation after the response. A fresh or unknown navigation
selects the single complete current generation or fails closed when no unambiguous complete
generation exists. Never infer a generation from whichever cache happens to contain the first
matching path.

Keep existing GraphQL pass-through/no-cache, logout purge, sync/replay, notification click, and FCM
scope behavior byte-for-byte covered by their existing tests.

- [ ] **Step 4: Write the browser generation matrix**

The Playwright test pins generation A as `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` and generation B
as `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`, asserts both match the strict 40-hex build-ID
contract and differ, builds both, and proves:

- an active A tab and background A tab survive B installation;
- an unresponsive A client blocks B activation and leaves every generation cache intact until the
  client responds or closes;
- a late A client appearing between preflight and activation blocks deletion and cannot receive a B
  subresource under an A document;
- an unrelated same-origin window outside `/mobile/` is filtered out and cannot block activation,
  while a late `/mobile/` window is never filtered out;
- no A cache is deleted while either tab reports A;
- an offline A reload uses `replacesClientId`/`resultingClientId` to receive A HTML/runtime/style,
  while a fresh unknown navigation receives one complete current generation or an explicit offline
  error;
- an empty/unknown subresource `clientId` resolves only an exact uniquely owned hashed asset and
  otherwise fails closed;
- B activates only through the handshake;
- visible clients reload to B without mixed asset generations;
- A cache retires only after every A client closes or reports B;
- logout purge, GraphQL no-cache, FCM registration, and queued replay remain functional.

```bash
npm --prefix e2e ci --ignore-scripts --no-audit
npm --prefix e2e exec -- playwright install --with-deps chromium
npm --prefix e2e run test:mobile-pwa -- --grep "PWA generation handoff"
```

Expected before implementation: FAIL on unconditional activation/cleanup. Expected after
implementation: PASS for the complete matrix.

- [ ] **Step 5: Run all PWA and production gates**

```bash
npm --prefix web/apps/aquamobil test -- src/pwa
npm --prefix web/apps/aquamobil run test:invariant -- src/pwa/__tests__/sw-build-artifact.invariant.spec.ts
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
bash scripts/ci/aquamobil-delivery-smoke.sh
```

Expected: all existing and new PWA tests pass.

- [ ] **Step 6: Commit the coherent update protocol**

```bash
git add web/apps/aquamobil/src/pwa web/apps/aquamobil/src/main.tsx web/apps/aquamobil/src/vite-env.d.ts web/apps/aquamobil/vite.config.ts web/apps/aquamobil/scripts/appearance-runtime-plugin.ts infrastructure/docker/Dockerfile.aquamobil scripts/ci/aquamobil-delivery-smoke.sh .github/workflows/deploy-digitalocean.yml .github/workflows/deploy-staging.yml .github/workflows/aquamobil-delivery.yml e2e/tests/mobile-pwa/pwa-generation-update.spec.ts e2e/tests/mobile-pwa/fixtures/generation-server.mjs e2e/playwright.aquamobil-pwa.config.ts e2e/package.json
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
shell_generation_finding_id="$(jq -sre --arg title 'AquaMobil service-worker activation can mix shell generations' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$shell_generation_finding_id" =~ ^MOB-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "fix(aquamobil): coordinate complete PWA shell generations" -m "Keep each controlled field client on one installed build until the worker and document can move together, then retire caches only after their last client leaves." -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md#$shell_generation_finding_id"
git push
```

---

### Task 9: V0 — collapse PWA install metadata to one authority

**Files:**

- Modify: `web/apps/aquamobil/vite.config.ts`
- Modify: `web/apps/aquamobil/index.html`
- Delete: `web/apps/aquamobil/public/manifest.webmanifest`
- Delete: `web/apps/aquamobil/public/icons/placeholder.txt`
- Modify: `web/apps/aquamobil/src/pwa/__tests__/sw-build-artifact.invariant.spec.ts`

**Interfaces:**

- Consumes: current main's reviewed 192px/512px PNGs and public-manifest shortcut metadata.
- Produces: VitePWA as the only emitted manifest/install-metadata authority.

- [ ] **Step 1: Write the one-manifest artifact test**

Require exactly one emitted manifest/link, `/mobile/`-prefixed existing 192px and 512px PNG icons,
the existing mortality and harvest shortcuts, a 512px maskable entry, and no maintained public
manifest copy. The existing main-owned 192px and 512px SVGs remain source artwork but are not
declared as install icons.

```bash
npm --prefix web/apps/aquamobil run test:invariant -- src/pwa/__tests__/sw-build-artifact.invariant.spec.ts
```

Expected: FAIL because two source manifests disagree and the Vite-owned copy omits the existing
mortality/harvest shortcuts.

- [ ] **Step 2: Move all install metadata into VitePWA and delete the duplicate**

Retain one generated `manifest.webmanifest`; remove the hardcoded HTML link if the plugin injects
it. Reuse current main's `icon-192x192.png` and `icon-512x512.png`; do not regenerate, rename, or
copy a second logo source.

- [ ] **Step 3: Verify and commit**

```bash
npm --prefix web/apps/aquamobil run test:invariant -- src/pwa/__tests__/sw-build-artifact.invariant.spec.ts
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
bash scripts/ci/aquamobil-delivery-smoke.sh
git add web/apps/aquamobil/vite.config.ts web/apps/aquamobil/index.html web/apps/aquamobil/public/manifest.webmanifest web/apps/aquamobil/public/icons web/apps/aquamobil/src/pwa/__tests__/sw-build-artifact.invariant.spec.ts
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
install_metadata_finding_id="$(jq -sre --arg title 'AquaMobil install metadata has duplicate build authorities' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$install_metadata_finding_id" =~ ^MOB-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "fix(aquamobil): generate one install manifest" -m "Make VitePWA the sole base-aware install metadata owner so shortcuts and icon paths cannot be overwritten by an inert public copy." -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md#$install_metadata_finding_id"
git push
```

---

### Task 10: V0 checkpoint verification and merge

**Files:**

- Create: `docs/evidence/aquamobil-v4-delivery/v0-finding-closure-map.json`
- Read: `web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts`
- Read: `scripts/ci/audit-source-map.mjs`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Modify: `docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md`
- Modify: `docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md`
- Modify: `docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md`
- Modify: `docs/reviews/aquamobil-e2e-audit/2026-06-13-findings.md`
- Create: `docs/compliance/evidence/` entries named by each allocated HIGH finding ID resolved at
  this checkpoint
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: merged I1 evidence and Tasks 4 through 9 on the V0 branch.
- Produces: reviewed V0 PR/main evidence, a machine-checked finding-to-main-SHA closure map, and a
  separate protected closure PR. It does not write the generated central execution ledger; the
  program's serialized V0 slice and V0 finding-closure reconciliation PRs consume these artifacts.
  Product slice V1 starts only after I1/V0 slice reconciliation, finding closure, and closure
  reconciliation are protected-main ancestors.

- [ ] **Step 1: Run focused and affected gates without cache**

```bash
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run test:invariant
npm --prefix web/apps/aquamobil run fonts:check
npm --prefix web/apps/aquamobil run lint -- --no-cache
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm --prefix e2e ci --ignore-scripts --no-audit
npm --prefix e2e exec -- playwright install --with-deps chromium
npm --prefix e2e run test:mobile-pwa
npx nx affected --target=lint --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=test --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=build --base=origin/main --head=HEAD --skip-nx-cache
npm run csp:check
npm run gates:required-status-checks
bash scripts/ci/aquamobil-delivery-smoke.sh
npm --prefix e2e run test:mobile-edge
```

- [ ] **Step 2: Classify affected production advisories**

The generated post-#1333 `order0BaseMainCommit` is already a protected-main predecessor and Order 0
owns both files read above. Its Vite plugin
interprets `AQUAMOBIL_AUDIT_MODULE_MANIFEST` as a repository-root-relative path below ignored
`artifacts/`, independently of the `npm --prefix` child working directory, and writes the real
production Rollup `chunk.modules` manifest during `generateBundle`. The invariant introduced by
Order 0 rejects a missing producer or any path that resolves outside that root.

```bash
V0_AUDIT_DIR=artifacts/aquamobil-v4/V0-final
test "$(pwd -P)" = "$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mkdir -p "$V0_AUDIT_DIR"
v0_audit_build_id="$(git rev-parse HEAD)"
[[ "$v0_audit_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v0_audit_build_id" \
AQUAMOBIL_AUDIT_MODULE_MANIFEST="$V0_AUDIT_DIR/aquamobil-vite-rollup-modules.json" \
  npm --prefix web/apps/aquamobil run build
test -s "$V0_AUDIT_DIR/aquamobil-vite-rollup-modules.json"
set +e
npm audit --json > "$V0_AUDIT_DIR/audit-root-full.json"
root_full_status="$?"
npm audit --omit=dev --json > "$V0_AUDIT_DIR/audit-root-runtime.json"
root_runtime_status="$?"
npm --prefix web/apps/aquamobil audit --json > "$V0_AUDIT_DIR/audit-aquamobil-full.json"
aquamobil_full_status="$?"
npm --prefix web/apps/aquamobil audit --omit=dev --json > "$V0_AUDIT_DIR/audit-aquamobil-runtime.json"
aquamobil_runtime_status="$?"
set -e
printf '%s\n' \
  "$root_full_status" "$root_runtime_status" \
  "$aquamobil_full_status" "$aquamobil_runtime_status" \
  > "$V0_AUDIT_DIR/audit-exit-statuses.txt"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --capture-explain-set \
  --root-audit-full "$V0_AUDIT_DIR/audit-root-full.json" \
  --root-audit-runtime "$V0_AUDIT_DIR/audit-root-runtime.json" \
  --aquamobil-audit-full "$V0_AUDIT_DIR/audit-aquamobil-full.json" \
  --aquamobil-audit-runtime "$V0_AUDIT_DIR/audit-aquamobil-runtime.json" \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json "$V0_AUDIT_DIR/audit-set.json" \
  --write-explain-set-json "$V0_AUDIT_DIR/npm-explain-set.json"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --audit-set-json "$V0_AUDIT_DIR/audit-set.json" \
  --explain-set-json "$V0_AUDIT_DIR/npm-explain-set.json" \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest "$V0_AUDIT_DIR/aquamobil-vite-rollup-modules.json" \
  --output-json "$V0_AUDIT_DIR/dependency-reachability.json" \
  --output-markdown "$V0_AUDIT_DIR/dependency-reachability.md"
jq -e 'type == "array" and all(.[]; .reachability == "not-reachable")' \
  "$V0_AUDIT_DIR/dependency-reachability.json"
```

The full standalone audit is mandatory because direct `esbuild` is executable in the release build
even though it is omitted from the runtime-only graph. The canonical capture derives every
high/critical `npm explain <package> --json` chain without a shell, uses both lock authorities, and
binds browser reachability to the real production Vite/Rollup module manifest. Direct esbuild
remains separately classified as release-build tooling; its appearance-IIFE graph never stands in
for the whole browser build. A reachable high/critical build-time or runtime advisory blocks V0; do
not hide build tools inside an `--omit=dev` aggregate.

- [ ] **Step 3: Request review and merge V0**

Review specifically checks CSP execution, storage failure behavior, worker generation retirement,
Docker standalone resolution, React singleton aliases, and preservation of every old replay lane.
Record the protected I1 and V0 PR URLs and their resulting full main SHAs. Fetch `origin/main` and
prove both resulting SHAs are ancestors; a branch-head SHA or an unmerged PR is not closure
evidence. Before authorizing each merge, inspect its selected merge strategy: either preserve the
implementation commits, or put every exact uppercase `Closes:` line from that PR into the squash
body. Validate the prospective body and then the resulting main-reachable body; missing even one I1
or V0 trailer blocks Step 4. I1's program Task 3 reconciliation is already a protected-main ancestor
because V0 could not start otherwise. Immediately run program Task 3 for V0 and require its slice
`merge.json` reconciliation PR to be a protected-main ancestor before creating the finding-close
worktree.

- [ ] **Step 4: Build the exact post-merge closure map on a fresh branch**

```bash
CLOSURE_NAME=v0-high-findings
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
test "$FINDING_CLOSURE_WORKTREE" = \
  /var/aqua-saas/.worktrees/aquamobil-v4-v0-findings-close
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
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --capture-finding-closures "$CLOSURE_NAME" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main \
  --write docs/evidence/aquamobil-v4-delivery/v0-finding-closure-map.json
```

Resolve exactly one registry ID for each of these titles, without changing case:

- `AquaMobil production asset requests can fall through to SPA HTML`
- `AquaMobil edge deployment identity can select the wrong host or certificate`
- `AquaMobil presigned object URLs expose the internal MinIO origin`
- `AquaMobil field surfaces lack one semantic primitive authority`
- `AquaMobil service-worker activation can mix shell generations`
- `AquaMobil install metadata has duplicate build authorities`

Add the existing `SEC-MEDIUM-052` as the seventh configured row. The coordinator-owned capture
resolves exactly one registry ID for each configured title, walks the reconciled I1/V0
`implementationBoundaries`, and writes the sorted seven-row map from main-reachable exact `Closes:`
trailers. Missing, extra, duplicate, foreign, or non-ancestor evidence blocks closure. Never
substitute branch URLs or prose, and never hand-edit `execution-ledger.json`, a slice `merge.json`,
or a closure evidence record from this finding-close branch.

- [ ] **Step 5: Close the seven findings and author HIGH attestations**

```bash
jq -e 'length == 7 and
  has("SEC-MEDIUM-052") and
  ([keys[] | select(test("^(INFRA|MOB)-HIGH-[0-9]{3}$"))] | length == 6) and
  all(to_entries[]; (.key | test("^((INFRA|MOB)-HIGH-[0-9]{3}|SEC-MEDIUM-052)$")) and (.value | test("^[0-9a-f]{40}$")))' \
  docs/evidence/aquamobil-v4-delivery/v0-finding-closure-map.json
jq -r 'to_entries[] | [.key, .value] | @tsv' \
  docs/evidence/aquamobil-v4-delivery/v0-finding-closure-map.json |
  while IFS=$'\t' read -r finding_id closing_sha; do
    git merge-base --is-ancestor "$closing_sha" origin/main
    git show --format='%B' --no-patch "$closing_sha" | rg -q "^Closes: docs/reviews/.+#${finding_id}$"
    npm run findings:close -- "$finding_id" "$closing_sha"
  done
npm run findings:verify
```

Use `apply_patch` to change each matching review heading to `RESOLVED` and record its exact closing
SHA plus merged PR URL. For each newly allocated HIGH row in the map, create the repository-template
attestation under `docs/compliance/evidence/`, with the filename exactly the uppercase finding ID
plus `.md`. The document carries the actual ID, opened/resolved dates, full closing SHA,
implementation/test/control paths, PR author, and the distinct independent-agent reviewer identity
preserved in that boundary's `programLocalReview`. A filename or value containing template text, a
placeholder identity, a short SHA, or reviewer/author identity reuse fails the checkpoint.
`SEC-MEDIUM-052` does not manufacture a HIGH
attestation.

```bash
npx ts-node --project tools/gates/tsconfig.json tools/gates/compliance-attestation-coverage.ts
npm run quality:format-scope:generate
git add -- \
  docs/evidence/aquamobil-v4-delivery/v0-finding-closure-map.json \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/infra-expert/2026-08-26-aquamobil-delivery-boundary.md \
  docs/reviews/infra-expert/2026-08-26-aquamobil-object-route.md \
  docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md \
  docs/reviews/aquamobil-e2e-audit/2026-06-13-findings.md \
  docs/compliance/evidence \
  tools/quality/format-scope.json
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(review): close AquaMobil I1 and V0 findings"
git push --set-upstream origin chore/aquamobil-v0-findings-close
```

Open a protected PR, obtain the exact independent-agent report and explicit administrator
authorization comment defined by the program plan, then prove its current checks, state, base,
exact head/candidate, three candidate artifacts, and non-duplicating trailer set:

```bash
CLOSURE_NAME=v0-high-findings
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
closure_pr_number="$(gh pr view --repo Okan-wqm/aquaculture_platform \
  --json number --jq '.number')"
gh pr checks "$closure_pr_number" \
  --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$closure_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v0-findings-close" and (.headRefOid | test("^[0-9a-f]{40}$")))'
PROGRAM_PR_NUMBER="$closure_pr_number"
PROGRAM_PR_KIND=finding-close
PROGRAM_EXPECTED_HEAD=chore/aquamobil-v0-findings-close
: "${PROGRAM_REVIEWER_OUTPUT:?set independent agent canonical report output path}"
```

Execute the program plan's exact coordinator-absolute, generation-aware non-bootstrap lifecycle.
The closed finding-close registry adds the closure-map and duplicate-trailer checks.

Merge without bypass. After fetching main, require all seven mapped rows to be `RESOLVED`, every
recorded closing SHA to remain an `origin/main` ancestor, the registry hash chain and attestation
gate to pass, and the exact closure evidence to be present on `origin/main`. Run the program plan's
full post-merge spool/recovery round trip, retain the finding-close worktree/remote branch/generation,
and clean them only after the separate closure reconciliation embeds this boundary and is
main-reachable:

```bash
CLOSURE_NAME=v0-high-findings
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
PROGRAM_PR_KIND=finding-close
PROGRAM_EXPECTED_HEAD=chore/aquamobil-v0-findings-close
```

Finally run program Task 4's serialized `v0-high-findings` closure reconciliation. V1 cannot start
until that reconciliation PR and the I1 and V0 slice reconciliation PRs are protected-main
ancestors.

---

### Task 11: UI convergence — activate v4 appearance and make legacy use impossible

**Files:**

- Create through the program capture tool:
  `docs/superpowers/evidence/aquamobil-v4/slices/UI-convergence/preflight.json`
- Modify: `web/apps/aquamobil/src/appearance/contract.ts`
- Modify: `web/apps/aquamobil/src/appearance/runtime.ts`
- Modify: `web/apps/aquamobil/src/appearance/global.d.ts`
- Modify: `web/apps/aquamobil/src/appearance/__tests__/runtime.spec.ts`
- Create: `web/apps/aquamobil/src/hooks/useTheme.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useTheme.binding.spec.tsx`
- Modify: `web/apps/aquamobil/src/hooks/useDensity.ts`
- Modify: `web/apps/aquamobil/src/hooks/index.ts`
- Delete: `web/apps/aquamobil/src/hooks/useDarkMode.ts`
- Modify: `web/apps/aquamobil/src/styles/tokens.css`
- Modify: `web/apps/aquamobil/src/styles/main.css`
- Modify: `web/apps/aquamobil/src/__tests__/design-token.invariant.spec.ts`
- Modify: `web/apps/aquamobil/src/__tests__/field-ergonomics.invariant.spec.ts`
- Create: `web/apps/aquamobil/src/__tests__/legacy-ui-zero.invariant.spec.ts`
- Modify: `web/apps/aquamobil/src/App.tsx`
- Modify: `web/apps/aquamobil/src/main.tsx`
- Modify: `web/apps/aquamobil/src/pages/account/AccountPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- Modify: `web/apps/aquamobil/tailwind.config.js`

**Interfaces:**

- Consumes: V5-complete semantic surfaces and Task 8's generation-safe update protocol.
- Produces: `AppearanceRuntimeV4` API version 2 and version-4 stored preference, with all legacy
  `.dark`/appearance storage behavior removed atomically.

- [ ] **Step 1: Enter the coordinator-created convergence worktree and turn ratchets into RED bans**

Require zero Konsta imports, zero `dark:` utilities, zero legacy palette utilities, zero stock gray
utilities, zero `.dark` DOM/style contract, and no localStorage access outside
`src/appearance/runtime.ts` for appearance keys.

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
UI_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" print-path \
  --slice UI-convergence --boundary ui-convergence)"
test "$UI_WORKTREE" = "/var/aqua-saas/.worktrees/aquamobil-v4-ui-convergence"
test "$(pwd -P)" = "$UI_WORKTREE"
test "$(git branch --show-current)" = "feat/aquamobil-v4-ui-convergence"
UI_PREFLIGHT=docs/superpowers/evidence/aquamobil-v4/slices/UI-convergence/preflight.json
test -f "$UI_PREFLIGHT"
test "$(git rev-parse HEAD)" = "$(jq -r '.baseMainCommit' "$UI_PREFLIGHT")"
git show origin/main:docs/superpowers/evidence/aquamobil-v4/closures/product-high-findings.json |
  jq -e '.closure == "product-high-findings" and .ownerSlices == ["V1", "V2", "V3", "V4", "V5"]'
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice UI-convergence --check "$UI_PREFLIGHT" --main-ref origin/main
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
npm --prefix web/apps/aquamobil run test:invariant -- src/__tests__/legacy-ui-zero.invariant.spec.ts src/__tests__/design-token.invariant.spec.ts
```

Expected: FAIL on the reviewed remaining counts.

- [ ] **Step 2: Change the one runtime to version 4**

Use this final contract:

```ts
export const APPEARANCE_API_VERSION = 2 as const;
export type ThemePreference = 'night' | 'day' | 'colour' | 'system';
export type ResolvedTheme = 'night' | 'day' | 'colour';
export type TouchDensity = 'standard' | 'glove';

export interface AppearanceRecordV4 {
  version: 4;
  theme: ThemePreference;
  density: TouchDensity;
}

export interface AppearanceSnapshotV4 {
  preference: ThemePreference;
  theme: ResolvedTheme;
  density: TouchDensity;
  isDark: boolean;
  themeColor: string;
}

export interface AppearanceRuntimeV4 {
  readonly apiVersion: 2;
  readonly buildId: string;
  getSnapshot(): AppearanceSnapshotV4;
  subscribe(listener: () => void): () => void;
  setPreference(preference: ThemePreference): void;
  setDensity(density: TouchDensity): void;
}
```

Read only `aquamobil_appearance_v4` after migration. When absent, parse legacy `aquamobil_dark_mode`
and `aquamobil_touch_density`, write the v4 record first, then remove legacy keys. Map
`dark -> night`, `light -> day`, and invalid values to `system`; never infer `colour`. After the v4
write, ignore legacy keys even if removal failed. Apply `data-theme` and `data-density`; remove
`.dark` entirely.

- [ ] **Step 3: Convert every remaining consumer**

The product-surface plan must already have moved every page to semantic primitives. Convert the
remaining shell/account/sync controls, replace any asset-selection boolean with `ResolvedTheme`, and
delete migration-only comments in the same change.

- [ ] **Step 4: Prove V0-to-v4 installed-client behavior through the generation matrix**

```bash
npm --prefix web/apps/aquamobil test -- src/appearance src/hooks/__tests__/useTheme.binding.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- src/__tests__/legacy-ui-zero.invariant.spec.ts
npm --prefix e2e ci --ignore-scripts --no-audit
npm --prefix e2e exec -- playwright install --with-deps chromium
npm --prefix e2e run test:mobile-pwa -- --grep "PWA generation handoff"
```

Expected: an old API-v1 V0 tab stays on its complete cache; after coordinated reload it reads only
the v4 record and no document mixes `.dark` styling with API-v2 runtime state.

---

### Task 12: UI convergence — remove Konsta and regenerate both package authorities

**Files:**

- Modify: `web/apps/aquamobil/package.json`
- Modify: `web/apps/aquamobil/package-lock.json`
- Modify: `package-lock.json`
- Modify: `web/apps/aquamobil/vite.config.ts`
- Read: `web/apps/aquamobil/scripts/audit-module-manifest-plugin.ts`
- Read: `scripts/ci/audit-source-map.mjs`
- Delete: `web/apps/aquamobil/scripts/patch-konsta.cjs`
- Modify: `infrastructure/docker/Dockerfile.aquamobil`
- Modify: `web/apps/aquamobil/src/main.tsx`
- Modify: `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`

**Interfaces:**

- Consumes: Task 11's zero-value UI invariant and semantic primitives used by every converted page.
- Produces: Konsta-free source, package/lock/Vite/Docker parity, and the final package gate consumed
  by V6.

- [ ] **Step 1: Remove source imports before dependency state**

Run the zero invariant repeatedly until all eight baseline import files and every later Konsta
consumer are converted. Only then remove `konsta`, the postinstall hook, Vite optimizeDeps entry,
Rollup comments/overrides, and Docker's inline package patch.

- [ ] **Step 2: Regenerate both lock authorities with the repository toolchain**

```bash
npm install --package-lock-only --ignore-scripts --workspace @aquaculture/aquamobil
npm --prefix web/apps/aquamobil install --package-lock-only --ignore-scripts
```

Expected: the root workspace lock and standalone lock both match the same AquaMobil package
declaration; neither contains `konsta` or the deleted patch hook.

- [ ] **Step 3: Prove both clean install paths in the isolated slice worktree**

```bash
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
PREINSTALL_TRACKED_DIFF_SHA256="$(git diff --binary | sha256sum | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
npm ci --no-audit
npm --prefix web/apps/aquamobil ci --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
test "$(git diff --binary | sha256sum | cut -d' ' -f1)" = \
  "$PREINSTALL_TRACKED_DIFF_SHA256"
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
docker build --file infrastructure/docker/Dockerfile.aquamobil --build-arg AQUAMOBIL_BUILD_ID="$v4_build_id" --tag aquamobil-v4-convergence .
```

Expected: both npm installs and the production Docker build pass without a patch hook.

- [ ] **Step 4: Run final convergence gates**

```bash
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run lint -- --no-cache
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm --prefix web/apps/aquamobil run test:invariant
bash scripts/ci/aquamobil-delivery-smoke.sh
npm --prefix e2e ci --ignore-scripts --no-audit
npm --prefix e2e exec -- playwright install --with-deps chromium
npm --prefix e2e run test:mobile-pwa -- --grep "PWA generation handoff"
```

- [ ] **Step 4a: Reclassify the final root and standalone package state**

```bash
UI_AUDIT_DIR=artifacts/aquamobil-v4/UI-convergence-final
test "$(pwd -P)" = "$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
mkdir -p "$UI_AUDIT_DIR"
ui_audit_build_id="$(git rev-parse HEAD)"
[[ "$ui_audit_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$ui_audit_build_id" \
AQUAMOBIL_AUDIT_MODULE_MANIFEST="$UI_AUDIT_DIR/aquamobil-vite-rollup-modules.json" \
  npm --prefix web/apps/aquamobil run build
test -s "$UI_AUDIT_DIR/aquamobil-vite-rollup-modules.json"
set +e
npm audit --json > "$UI_AUDIT_DIR/audit-root-full.json"
ui_root_full_status="$?"
npm audit --omit=dev --json > "$UI_AUDIT_DIR/audit-root-runtime.json"
ui_root_runtime_status="$?"
npm --prefix web/apps/aquamobil audit --json > "$UI_AUDIT_DIR/audit-aquamobil-full.json"
ui_aquamobil_full_status="$?"
npm --prefix web/apps/aquamobil audit --omit=dev --json > \
  "$UI_AUDIT_DIR/audit-aquamobil-runtime.json"
ui_aquamobil_runtime_status="$?"
set -e
printf '%s\n' \
  "$ui_root_full_status" "$ui_root_runtime_status" \
  "$ui_aquamobil_full_status" "$ui_aquamobil_runtime_status" \
  > "$UI_AUDIT_DIR/audit-exit-statuses.txt"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --capture-explain-set \
  --root-audit-full "$UI_AUDIT_DIR/audit-root-full.json" \
  --root-audit-runtime "$UI_AUDIT_DIR/audit-root-runtime.json" \
  --aquamobil-audit-full "$UI_AUDIT_DIR/audit-aquamobil-full.json" \
  --aquamobil-audit-runtime "$UI_AUDIT_DIR/audit-aquamobil-runtime.json" \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json "$UI_AUDIT_DIR/audit-set.json" \
  --write-explain-set-json "$UI_AUDIT_DIR/npm-explain-set.json"
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --audit-set-json "$UI_AUDIT_DIR/audit-set.json" \
  --explain-set-json "$UI_AUDIT_DIR/npm-explain-set.json" \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest "$UI_AUDIT_DIR/aquamobil-vite-rollup-modules.json" \
  --output-json "$UI_AUDIT_DIR/dependency-reachability.json" \
  --output-markdown "$UI_AUDIT_DIR/dependency-reachability.md"
jq -e 'type == "array" and all(.[]; .reachability == "not-reachable")' \
  "$UI_AUDIT_DIR/dependency-reachability.json"
```

Expected: all gates pass, both install modes leave both lock authorities unchanged, every
high/critical advisory has a complete explain chain and release/runtime/browser classification, no
affected high/critical path is reachable, the legacy UI count is zero, and no shell generation is
mixed. A nonzero raw audit status is preserved as evidence and cannot be replaced by the removed
single runtime-audit shortcut.

- [ ] **Step 5: Commit and push convergence**

```bash
git add web/apps/aquamobil package-lock.json infrastructure/docker/Dockerfile.aquamobil docs/superpowers/evidence/aquamobil-v4/slices/UI-convergence/preflight.json
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
legacy_authority_finding_id="$(jq -sre --arg title 'AquaMobil legacy appearance and package authorities remain active' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$legacy_authority_finding_id" =~ ^MOB-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): converge on the v4 appearance authority" -m "Move installed clients through a generation-safe preference migration, then remove the final legacy styling and package authorities atomically." -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md#$legacy_authority_finding_id"
git push -u origin feat/aquamobil-v4-ui-convergence
```

Expected: review verifies zero bans and package/Docker parity before merge. V6 must not start until
the UI implementation reconciliation, Task 13's separate closure reconciliation, and F5 slice
reconciliation are all protected-main ancestors.

---

### Task 13: Close the UI-convergence finding after protected merge

**Files:**

- Create: `docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Modify: `docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md`
- Create: one entry under `docs/compliance/evidence/` named by the allocated legacy-authority HIGH
  finding ID
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: the protected convergence PR, its resulting full main SHA, and the exact uppercase ID
  allocated in Task 0.
- Produces: one main-reachable closure SHA, HIGH attestation, and review state for the program's
  later `ui-convergence-high-findings` closure reconciliation input; it never marks the finding
  resolved on the implementation branch or hand-edits the central ledger.

- [ ] **Step 1: Merge and reconcile convergence, then create the canonical closure worktree**

After all required checks and distinct review pass, merge `feat/aquamobil-v4-ui-convergence` through
the protected PR. Preserve its implementation commit or copy the exact dynamic uppercase
legacy-authority `Closes:` trailer into the reviewed squash body, and verify that trailer on the
resulting main-reachable commit before continuing.

Run program Task 3's serialized `UI-convergence` slice reconciliation and require its protected
merge to be an `origin/main` ancestor. Then create the finding-close worktree from that exact
then-main:

```bash
CLOSURE_NAME=ui-convergence-high-findings
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
test "$FINDING_CLOSURE_WORKTREE" = \
  /var/aqua-saas/.worktrees/aquamobil-v4-ui-convergence-finding-close
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

- [ ] **Step 2: Resolve the exact trailer and close only its allocated finding**

Resolve exactly one uppercase ID whose title is
`AquaMobil legacy appearance and package authorities remain active`. Require exactly one full
`origin/main` ancestor commit carrying
`Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md#$finding_id` in its
complete body after shell expansion. Generate the one-entry sorted map only through the
coordinator-owned capture. The protected PR URL and resulting SHA already live in the immutable
UI-convergence `merge.json`; the closure branch cannot edit it. Then run:

```bash
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --capture-finding-closures "$CLOSURE_NAME" \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main \
  --write docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json
jq -e 'length == 1 and all(to_entries[]; (.key | test("^[A-Z][A-Z0-9-]*-HIGH-[0-9]{3}$")) and (.value | test("^[0-9a-f]{40}$")))' \
  docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json
finding_id="$(jq -r 'keys[0]' docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json)"
closing_sha="$(jq -r --arg id "$finding_id" '.[$id]' docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json)"
git merge-base --is-ancestor "$closing_sha" origin/main
git show --format='%B' --no-patch "$closing_sha" | rg -q "^Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md#${finding_id}$"
npm run findings:close -- "$finding_id" "$closing_sha"
npm run findings:verify
```

Use `apply_patch` to mark only that review heading `RESOLVED` and create its attestation under
`docs/compliance/evidence/`, named exactly by the uppercase ID. Fill it with the actual full closing
SHA, merged PR, zero-invariant/package/Docker evidence, authenticated author, and a distinct
independent-agent reviewer identity preserved in `programLocalReview`; template values, short SHAs,
and reviewer/author identity reuse fail.

- [ ] **Step 3: Push, merge, and verify the closure PR**

```bash
npx ts-node --project tools/gates/tsconfig.json tools/gates/compliance-attestation-coverage.ts
npm run quality:format-scope:generate
git add -- \
  docs/evidence/aquamobil-v4-delivery/ui-convergence-finding-closure-map.json \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/codex/2026-08-26-aquamobil-v4-delivery-appearance.md \
  docs/compliance/evidence \
  tools/quality/format-scope.json
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(review): close AquaMobil UI convergence finding"
git push --set-upstream origin chore/aquamobil-v4-ui-convergence-finding-close
```

Open the protected closure PR, obtain the exact independent-agent report and explicit administrator
authorization comment defined by the program plan, then prove its current checks, state, base,
exact head/candidate, three candidate artifacts, and non-duplicating trailer set:

```bash
CLOSURE_NAME=ui-convergence-high-findings
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
closure_pr_number="$(gh pr view --repo Okan-wqm/aquaculture_platform \
  --json number --jq '.number')"
gh pr checks "$closure_pr_number" \
  --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$closure_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,baseRefName,headRefName,headRefOid \
  --jq 'select(.state == "OPEN" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-ui-convergence-finding-close" and (.headRefOid | test("^[0-9a-f]{40}$")))'
PROGRAM_PR_NUMBER="$closure_pr_number"
PROGRAM_PR_KIND=finding-close
PROGRAM_EXPECTED_HEAD=chore/aquamobil-v4-ui-convergence-finding-close
: "${PROGRAM_REVIEWER_OUTPUT:?set independent agent canonical report output path}"
```

Execute the program plan's exact coordinator-absolute, generation-aware non-bootstrap lifecycle.
The closed finding-close registry adds the closure-map and duplicate-trailer checks.

Merge without bypass. Fetch `origin/main`, then prove the mapped row is `RESOLVED`, its full closing
SHA is an ancestor, the review and attestation name the same ID/SHA, and the registry chain and
attestation coverage pass. Run the program plan's full post-merge spool/recovery round trip and
retain this boundary until the separate closure reconciliation is main-reachable:

```bash
CLOSURE_NAME=ui-convergence-high-findings
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
PROGRAM_PR_KIND=finding-close
PROGRAM_EXPECTED_HEAD=chore/aquamobil-v4-ui-convergence-finding-close
```

Finally run program Task 4's serialized `ui-convergence-high-findings` closure reconciliation. Only
after that reconciliation is a protected-main ancestor may control pass to V6.
