# AquaMobil V4 Product Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild AquaMobil's V1–V5 field, messaging, reporting, warehouse, and tablet product
surfaces on current `main` with truthful query states, generated request contracts, and one shared
semantic component vocabulary.

**Architecture:** V1 introduces the only query-state algebra and the phone navigation shell. V2 then
establishes the shared farm-summary, generated-client, queued-document, and `TankCard` authorities.
Only after V2 reconciliation do V3 and V4 begin in parallel from fresh worktrees and preflights; V5
composes their read models into a non-actuating tablet board after both are merged. Existing hooks,
tenant query keys, offline replay, and server contracts remain authoritative; this plan adds no
parallel store, request mirror, transport, or write path.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, React Router 6, TanStack Query 5, Vitest, Testing
Library, GraphQL Code Generator, Tailwind CSS, Nx, npm 10

**Spec:** `docs/superpowers/specs/2026-08-26-aquamobil-v4-safe-integration-design.md`

## Global Constraints

- Start V1 only after I1 and V0 from
  `docs/superpowers/plans/2026-08-26-aquamobil-v4-delivery-appearance.md`, the V0 finding-close PR,
  and all three program reconciliations are merged. This plan consumes V0's semantic tokens,
  appearance bindings, canonical Vitest scripts, and primitives; it does not implement nginx,
  appearance, service-worker generation coordination, final Konsta removal, or the package
  convergence gate.
- After V1 reconciliation, the coordinator creates only V2's worktree and preflight from that exact
  main. V2 owns the shared farm-summary, queued-document, generated-client, and `TankCard`
  prerequisites. Only after V2 implementation and reconciliation are merged may the coordinator
  create fresh V3 and V4 worktrees and preflights from that exact main; those two slices may then
  proceed in parallel. V5 starts only after the V3 and V4 implementation and reconciliation PRs are
  merged; V2 is already an ancestor by construction.
- Final UI convergence and the PWA generation handshake return to
  `docs/superpowers/plans/2026-08-26-aquamobil-v4-delivery-appearance.md` after V5.
- F3–F5 and every VFD query, command, drive route, drive pane, and actuation exclusion belong to
  `docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md`. No task here introduces a
  drive operation or actuator control.
- Treat `27fd9e5be` through `f102bc831` as read-only behavioral evidence. Do not cherry-pick,
  transplant, merge, or apply source-branch patches. Reimplement each behavior after reviewing the
  current-main files and main-only commits that touch them.
- Each slice runs only in the linked worktree created by `tools/aquamobil-v4/worktree.mjs` from a
  forced, freshly fetched `origin/main`. Skip every detailed-task branch-creation command: this plan
  verifies the coordinator-created branch and preflight instead. Before each task, fetch with
  `git fetch origin +refs/heads/main:refs/remotes/origin/main`, then inspect
  `git log --oneline HEAD..origin/main --` followed by that task's exact owned paths. Current-main
  security, query-key, offline, and transport behavior wins.
- `/var/aqua-saas/.worktrees/aquamobil-v4-coordinator` is the only executable source for every Order
  0 lifecycle, capture, audit, and ledger tool. Before each coordination action, fetch the exact
  `origin/main` ref through `git -C /var/aqua-saas`, prove the coordinator clean, switch it detached
  to `origin/main`, and prove coordinator HEAD equals that fetched ref. Run the coordinator-absolute
  executable with the active implementation, closure, or reconciliation worktree as the current
  directory. Never execute a mixed local tool copy or run repository tools from the dirty user-owned
  `/var/aqua-saas` checkout.
- A fresh implementation or finding-closure worktree installs its own root and standalone
  dependencies from the two exact lockfiles; it never symlinks `node_modules` from the dirty
  checkout. Hash both locks before `npm ci --ignore-scripts --no-audit`, recheck both hashes and the
  Git diff afterward, and reuse that install only while both lockfiles remain unchanged.
- An implementation branch may create and stage only its own append-only
  `docs/superpowers/evidence/aquamobil-v4/slices/<SliceId>/preflight.json`. It never edits
  `execution-ledger.json`, a slice `merge.json`, a closure record, or another slice's evidence. The
  program reconciler alone writes those central artifacts after protected merge.
- `Loadable<T>` and `DataState<T>` are the only ordinary loading/error/ready state machine. A page
  may add domain states such as camera refusal or offline-only submission, but it may not create
  another query-result union or turn an error into empty data.
- A failed query must say that data is unavailable. It must never render `0`, “none due,” “no
  units,” “nothing stocked,” or another clean state unless the query reached the ready arm and
  returned that value.
- Preserve `createTenantQueryKey`, the existing auth boundary, current message transport/cache keys,
  the positive offline `OperationType` whitelist, foreground and closed-client replay, and
  `invalidateSyncedOperationQueries`.
- GraphQL documents live under `web/apps/aquamobil/src/graphql/`; request/result types come from
  `web/apps/aquamobil/src/generated/graphql.ts`. Regenerate that file with the root codegen command.
  Do not hand-edit generated output or reintroduce any handwritten replica of a GraphQL input.
- The queued-mutation SSoT test edited in Task 5 is classification proof for the existing runtime.
  No task here changes service-worker generation, replay implementation, cache retirement, install
  behavior, or any other PWA runtime concern.
- Replaced structure consumes V0 primitives from `web/apps/aquamobil/src/components/ui/`, and no
  task creates a compatibility wrapper. The pre-existing Konsta form leaves measured by V0's ratchet
  remain untouched where this plan does not own their removal; the delivery/appearance convergence
  plan removes them atomically.
- Keep farm capacity semantics exact: `capacityUsedPercent` is advisory display data,
  `batchMetrics.isOverCapacity` is the backend consent decision, and container-level
  `currentQuantity`/`currentBiomass` are farm totals.
- The AquaMobil whole-source ESLint baseline is not assumed green. Run ESLint on every touched
  TypeScript/TSX file, plus standalone typecheck, focused tests, canonical tests, and production
  build.
- V1, V2, V3, V4, and V5 each use one reviewed product-slice PR. The final task in each slice runs
  the production-dependency checkpoint below before requesting review; intermediate commits may be
  pushed to that slice branch only. A high or critical advisory reachable from a dependency path
  affected by the slice blocks its PR. Aggregate audit counts and a non-zero audit status alone are
  not reachability classifications.
- Every task that commits has `tools/quality/format-scope.json` as a conditional generated `Modify`
  path. First stage every task-owned create/modify/delete path, then run the exact block below
  immediately before each `git commit`; an earlier generator call in a task is only a preview and
  does not replace this post-stage run. Push immediately after each commit. Never bypass hooks or
  signatures.

  ```bash
  npm run quality:format-scope:generate
  git add -- tools/quality/format-scope.json
  npm run quality:format-scope:check
  git diff --cached --check
  ```

- Exactly one implementation commit per slice resolves that slice's exact title to one registered
  uppercase finding ID and carries it in one `Closes:` trailer: the final commits in Tasks 4, 8, 10,
  13, and 16. Earlier commits must not claim the same finding; if an earlier commit must use `fix`
  or `security`, allocate a distinct finding instead. The prospective-PR capture must observe each
  expected trailer exactly once, whether commits are preserved or the reviewed squash body is used.
  Registry state changes only in Task 18 after all five protected slice reconciliations are
  main-reachable.

## Production Dependency Checkpoint

Order 0 owns the mapper and capture interfaces. The coordinator first follows program Task 2 to
capture the slice's full/runtime root and standalone audits, JSON `npm explain` graphs, bundle
reachability, overlap decisions, and proof hashes in its append-only `preflight.json`. Run this
exact final block in Tasks 4, 8, 10, 13, and 16 with the task's uppercase `v4_product_slice`; Task
17 repeats it with `v4_product_slice=product-final` and checks all five preflights. The local files
are a preview of the required PR workflow artifact; they are never a substitute for the
repository-bound artifact ID/name/digest captured later in `implementationBoundaries[]`.

The protected Order 0 Vite plugin treats `AQUAMOBIL_AUDIT_MODULE_MANIFEST` as a
repository-root-relative path below ignored `artifacts/`, regardless of the `npm --prefix` child
working directory, and emits the real production Rollup `chunk.modules` manifest during
`generateBundle`; its invariant rejects any missing producer or escaped output path.

```bash
v4_product_slice=V1
v4_audit_dir="artifacts/aquamobil-v4/$v4_product_slice/dependency-final"
test "$(pwd -P)" = "$(git rev-parse --show-toplevel)"
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
refresh_product_coordinator() {
  test -d "$COORDINATOR_WORKTREE"
  git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
  test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
  git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
  test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
  test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
    "$(git -C /var/aqua-saas rev-parse origin/main)"
}
refresh_product_coordinator
case "$v4_product_slice" in
  V1|V2|V3|V4|V5)
    v4_preflight="docs/superpowers/evidence/aquamobil-v4/slices/$v4_product_slice/preflight.json"
    test -f "$v4_preflight"
    ;;
  product-final)
    v4_preflight=''
    ;;
  *)
    exit 2
    ;;
esac
mkdir -p "$v4_audit_dir"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
v4_preflight_build_id="$(git rev-parse HEAD)"
[[ "$v4_preflight_build_id" =~ ^[0-9a-f]{40}$ ]]
export AQUAMOBIL_BUILD_ID="$v4_preflight_build_id"
export AQUAMOBIL_AUDIT_MODULE_MANIFEST="$v4_audit_dir/aquamobil-vite-rollup-modules.json"
npm --prefix web/apps/aquamobil run build
test -s "$v4_audit_dir/aquamobil-vite-rollup-modules.json"
set +e
npm audit --json > "$v4_audit_dir/audit-root-full.json"
v4_root_full_status=$?
npm audit --omit=dev --json > "$v4_audit_dir/audit-root-runtime.json"
v4_root_runtime_status=$?
npm --prefix web/apps/aquamobil audit --json > "$v4_audit_dir/audit-mobile-full.json"
v4_mobile_full_status=$?
npm --prefix web/apps/aquamobil audit --omit=dev --json > "$v4_audit_dir/audit-mobile-runtime.json"
v4_mobile_runtime_status=$?
set -e
printf '%s\n' \
  "$v4_root_full_status" \
  "$v4_root_runtime_status" \
  "$v4_mobile_full_status" \
  "$v4_mobile_runtime_status" \
  > "$v4_audit_dir/audit-exit-statuses.txt"
refresh_product_coordinator
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --capture-explain-set \
  --root-audit-full "$v4_audit_dir/audit-root-full.json" \
  --root-audit-runtime "$v4_audit_dir/audit-root-runtime.json" \
  --aquamobil-audit-full "$v4_audit_dir/audit-mobile-full.json" \
  --aquamobil-audit-runtime "$v4_audit_dir/audit-mobile-runtime.json" \
  --root-install . \
  --aquamobil-install web/apps/aquamobil \
  --write-audit-set-json "$v4_audit_dir/audit-set.json" \
  --write-explain-set-json "$v4_audit_dir/npm-explain-set.json"
refresh_product_coordinator
node "$COORDINATOR_WORKTREE/scripts/ci/audit-source-map.mjs" \
  --audit-set-json "$v4_audit_dir/audit-set.json" \
  --explain-set-json "$v4_audit_dir/npm-explain-set.json" \
  --root-package-lock package-lock.json \
  --aquamobil-package-lock web/apps/aquamobil/package-lock.json \
  --aquamobil-bundle-manifest "$v4_audit_dir/aquamobil-vite-rollup-modules.json" \
  --output-json "$v4_audit_dir/dependency-reachability.json" \
  --output-markdown "$v4_audit_dir/dependency-reachability.md"
jq -e 'type == "array" and all(.[]; .reachability == "not-reachable")' \
  "$v4_audit_dir/dependency-reachability.json"
if test -n "$v4_preflight"; then
  refresh_product_coordinator
  node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
    --slice "$v4_product_slice" \
    --check "$v4_preflight" \
    --main-ref origin/main
else
  for v4_owner_slice in V1 V2 V3 V4 V5; do
    refresh_product_coordinator
    node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
      --slice "$v4_owner_slice" \
      --check "docs/superpowers/evidence/aquamobil-v4/slices/$v4_owner_slice/preflight.json" \
      --main-ref origin/main
  done
fi
test -z "$(git diff --name-only origin/main...HEAD -- \
  package.json package-lock.json \
  web/apps/aquamobil/package.json web/apps/aquamobil/package-lock.json)"
```

The required PR workflow uploads the whole fixed artifact directory as
`aquamobil-v4-<SliceId>-dependency-evidence`; the program capture binds its server-reported digest
to that slice's implementation boundary. Missing JSON, status, chain, proof hash, bundle
classification, upload, or digest blocks review. An unclassified or affected-and-reachable
high/critical runtime or release-build path also blocks review even when an audit status matches the
baseline. Do not edit the preflight after its first commit, attach transient local files as
evidence, write any conclusion into the central ledger, run an audit fixer, or mutate either
lockfile.

## Source Behavior Map

| Slice | Behavioral sources                                                                                                                  | Reimplementation boundary                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| V1    | `1f05d0b91`, `160330eaf`, `3fa34505b`, `2b71d59f3`, selected corrections from `e398704d1` and `18bf1b3e3`                           | Shared query-state contract, shell/navigation, scan, units, error propagation   |
| V2    | `f2590b3a1`, `33a89eefd`, `700458279`, `e398704d1`, `18bf1b3e3`, `96c082aff`; verified generated-contract behavior from `2f5ef21eb` | Home, unit detail, fast logging, farm summary, water-quality correctness        |
| V3    | `c16cd9a95`, `2a7a749f8`                                                                                                            | Messaging components/pages and reusable information cards; no transport changes |
| V4    | `602fa8776`, `bcac0a73e`, `9a2768092`, `b25cd4d65`                                                                                  | Reports, regulated review, storage truthfulness, remaining page conversions     |
| V5    | `f102bc831`                                                                                                                         | Two-dimensional tablet shell and read-only board composition                    |

## Owned File Map

### V1

- Create `web/apps/aquamobil/src/utils/loadable.ts` and
  `web/apps/aquamobil/src/utils/__tests__/loadable.spec.ts` as the query-state algebra and unit
  proof.
- Create `web/apps/aquamobil/src/components/ui/DataState.tsx` and
  `web/apps/aquamobil/src/components/ui/__tests__/DataState.spec.tsx` as the sole ordinary
  query-state renderer.
- Create `web/apps/aquamobil/src/components/AppHeader.tsx`,
  `web/apps/aquamobil/src/components/AccountAvatar.tsx`, and their component tests as shared
  phone/tablet chrome.
- Create `web/apps/aquamobil/src/pages/scan/ScanPage.tsx`,
  `web/apps/aquamobil/src/pages/scan/__tests__/resolveScannedUnit.spec.ts`, and
  `web/apps/aquamobil/src/pages/scan/__tests__/ScanPage.route.spec.tsx`.
- Create `web/apps/aquamobil/src/pages/units/UnitsPage.tsx` and
  `web/apps/aquamobil/src/pages/units/__tests__/UnitsPage.outage.spec.tsx`.
- Create `web/apps/aquamobil/src/__tests__/query-error-surface.invariant.spec.ts` and
  `web/apps/aquamobil/src/__tests__/route-reachability.invariant.spec.ts`.
- Modify `web/apps/aquamobil/src/App.tsx`, `web/apps/aquamobil/src/layouts/MobileLayout.tsx`,
  `web/apps/aquamobil/src/components/ui/index.ts`, `web/apps/aquamobil/src/hooks/index.ts`,
  `web/apps/aquamobil/src/hooks/useAiConsent.ts`,
  `web/apps/aquamobil/src/hooks/useDailyOpsStats.ts`,
  `web/apps/aquamobil/src/hooks/useSentimentTrends.ts`,
  `web/apps/aquamobil/src/hooks/useStockEventsSummary.ts`,
  `web/apps/aquamobil/src/hooks/useTanks.ts`, `web/apps/aquamobil/src/hooks/useUnreadCount.ts`, and
  `web/apps/aquamobil/src/types/index.ts`.

### V2

- Create `web/apps/aquamobil/src/graphql/water-quality.operations.ts` and
  `web/apps/aquamobil/src/graphql/queued-mutation-documents.ts`, regenerate
  `web/apps/aquamobil/src/generated/graphql.ts`, and create
  `tests/invariants/aquamobil-generated-input-authority.spec.ts`.
- Modify `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`,
  `web/apps/aquamobil/src/types/index.ts`, `web/apps/aquamobil/src/pwa/operation-registry.ts`, and
  its registry/SSoT tests to make generated GraphQL inputs and `src/graphql/` documents
  authoritative.
- Create `web/apps/aquamobil/src/graphql/farm-stock.operations.ts`, regenerate the client, and
  create `web/apps/aquamobil/src/utils/farm-summary.ts`,
  `web/apps/aquamobil/src/utils/unit-display.ts`, plus their unit specs.
- Create `web/apps/aquamobil/src/components/log-sheet/LogSheet.tsx`,
  `web/apps/aquamobil/src/components/log-sheet/index.ts`, and
  `web/apps/aquamobil/src/components/log-sheet/__tests__/submitBlocker.spec.ts`.
- Modify `web/apps/aquamobil/src/pages/HomePage.tsx`,
  `web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx`,
  `web/apps/aquamobil/src/pages/units/UnitsPage.tsx`,
  `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`,
  `web/apps/aquamobil/src/hooks/useTanks.ts`, and `web/apps/aquamobil/src/types/index.ts`; add
  focused outage and semantic tests beside those pages.

### V3

- Modify all 21 files under `web/apps/aquamobil/src/components/messaging/` named explicitly in Task
  9, plus the shared alert/reading/AI/card files named in Task 10.
- Modify `web/apps/aquamobil/src/pages/messaging/AiChatPage.tsx`, `ChannelListPage.tsx`,
  `ChannelSettingsPage.tsx`, `ChatRoomPage.tsx`, `MediaViewerPage.tsx`, and `NewChatPage.tsx`
  without changing their hooks, query keys, GraphQL operations, or offline binary lane.
- Add focused semantic and outage specs under
  `web/apps/aquamobil/src/components/messaging/__tests__/` and
  `web/apps/aquamobil/src/pages/messaging/__tests__/`.

### V4

- Create `web/apps/aquamobil/src/pages/reports/ReportsPage.tsx`,
  `web/apps/aquamobil/src/hooks/useReportDeadlines.ts`,
  `web/apps/aquamobil/src/utils/report-deadline-display.ts`, and focused tests.
- Modify `web/apps/aquamobil/src/pages/reports/ReportReviewPage.tsx`; delete `ReportsDuePage.tsx`
  and its test only in the same commit that activates `ReportsPage` at `/reports`.
- Create `web/apps/aquamobil/src/graphql/storage.operations.ts`, regenerate the client, and modify
  `web/apps/aquamobil/src/hooks/useWarehouseSummary.ts` plus the four storage pages so generated
  documents/types and recoverable-network-only cache fallback are authoritative; add storage outage
  coverage.
- Modify `web/apps/aquamobil/src/hooks/useStaffSummary.ts` and convert the remaining existing
  hub/page files named in Task 13 to V0 primitives and V1 `DataState` where query-backed.

### V5

- Create `web/apps/aquamobil/src/hooks/useViewport.ts`,
  `web/apps/aquamobil/src/layouts/AppShell.tsx`, `web/apps/aquamobil/src/layouts/TabletLayout.tsx`,
  and layout/breakpoint tests.
- Create the `web/apps/aquamobil/src/pages/tablet/` board routes, region, selection hook, panes, and
  tests named in Tasks 15 and 16.
- Create `web/apps/aquamobil/src/components/unit/UnitConfiguration.tsx`, `UnitVitals.tsx`, and
  `index.ts`.
- Extract `web/apps/aquamobil/src/components/messaging/ChatThread.tsx` from the existing chat room
  without changing message behavior.
- Modify `web/apps/aquamobil/src/App.tsx`, `src/components/AppHeader.tsx`,
  `src/components/messaging/index.ts`, `src/hooks/index.ts`, `src/layouts/index.ts`,
  `src/pages/index.ts`, `src/utils/messaging-helpers.ts`, the phone reports/chat/unit pages, and
  only the breakpoint section of `tailwind.config.js`.

---

### Task 0: Allocate one registered finding for each product slice

**Files:**

- Create: `docs/superpowers/evidence/aquamobil-v4/slices/V1/preflight.json` through the program
  capture tool
- Create: `docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: the locked registry allocator and the five exact slice boundaries below.
- Produces: five unique uppercase IDs and complete OPEN review headings used by every later product
  commit; it creates no parallel product requirements document.

- [ ] **Step 1: Verify the coordinator-created V1 worktree and allocate the exact titles under the
      registry lock**

<!-- markdownlint-disable MD010 -->

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
v4_preflight='docs/superpowers/evidence/aquamobil-v4/slices/V1/preflight.json'
test "$(git branch --show-current)" = 'feat/aquamobil-v1-shell'
test -f "$v4_preflight"
test "$(git rev-parse HEAD)" = "$(jq -r '.baseMainCommit' "$v4_preflight")"
git merge-base --is-ancestor "$(jq -r '.baseMainCommit' "$v4_preflight")" origin/main
git show origin/main:docs/superpowers/evidence/aquamobil-v4/closures/v0-high-findings.json >/dev/null
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice V1 \
  --check "$v4_preflight" \
  --main-ref origin/main
npm run findings:verify

allocate_product_finding() {
  local finding_title="$1"
  local evidence_path="$2"
  local review_file='docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md'
  local existing_count
  existing_count="$(jq -r --arg title "$finding_title" 'select(.title == $title) | .id' docs/reviews/_registry/findings.jsonl | wc -l)"
  if test "$existing_count" -eq 1; then
    jq -e --arg title "$finding_title" --arg review "$review_file" \
      'select(.title == $title and .review_file == $review)' \
      docs/reviews/_registry/findings.jsonl >/dev/null
    return 0
  fi
  test "$existing_count" -eq 0
  npm run findings:add -- MOB <(
    node - "$finding_title" "$evidence_path" "$review_file" <<'NODE'
const [title, evidence, reviewFile] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify({
    severity: 'HIGH',
    state: 'OPEN',
    title,
    layer: 1,
    evidence: [evidence],
    rule_violated: 'AquaMobil V4 truthful product-surface contract',
    owner_agent: 'codex',
    raised_in_cycle: '2026-08-26-aquamobil-v4-product-surfaces',
    review_file: reviewFile,
    created_at: new Date().toISOString(),
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes: 'Allocated by the approved product-surfaces implementation plan.',
  })}\n`,
);
NODE
  )
}

while IFS=$'\t' read -r finding_title evidence_path; do
  allocate_product_finding "$finding_title" "$evidence_path"
done <<'FINDINGS'
AquaMobil product reads can render failure as valid field state	web/apps/aquamobil/src/utils/loadable.ts
AquaMobil queued writes have duplicate handwritten GraphQL input authority	tests/invariants/aquamobil-generated-input-authority.spec.ts
AquaMobil messaging surfaces lack one semantic state vocabulary	web/apps/aquamobil/src/components/messaging/index.ts
AquaMobil report and warehouse surfaces can erase outage semantics	web/apps/aquamobil/src/pages/reports/ReportsPage.tsx
AquaMobil tablet board lacks one read-only composition boundary	web/apps/aquamobil/src/layouts/AppShell.tsx
FINDINGS
```

<!-- markdownlint-enable MD010 -->

Expected: each exact title resolves to one row owned by the one review file; an existing title under
another review blocks execution.

- [ ] **Step 2: Create complete headings and commit traceability only**

Use `apply_patch` to create one complete `## UPPERCASE-ID` heading per row, each with the exact
title, `OPEN` state, evidence, root cause, and acceptance boundary. Then run:

```bash
for finding_title in \
  'AquaMobil product reads can render failure as valid field state' \
  'AquaMobil queued writes have duplicate handwritten GraphQL input authority' \
  'AquaMobil messaging surfaces lack one semantic state vocabulary' \
  'AquaMobil report and warehouse surfaces can erase outage semantics' \
  'AquaMobil tablet board lacks one read-only composition boundary'; do
  mapfile -t finding_ids < <(
    jq -r --arg title "$finding_title" 'select(.title == $title) | .id' \
      docs/reviews/_registry/findings.jsonl
  )
  test "${#finding_ids[@]}" -eq 1
  [[ "${finding_ids[0]}" =~ ^[A-Z][A-Z0-9-]*-HIGH-[0-9]{3}$ ]]
  test "$(rg -c "^## ${finding_ids[0]}$" docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md)" -eq 1
done
npm run findings:verify
npm run quality:format-scope:generate
git add -- \
  docs/superpowers/evidence/aquamobil-v4/slices/V1/preflight.json \
  docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md \
  docs/reviews/_registry/findings.jsonl \
  tools/quality/format-scope.json
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(review): register AquaMobil product findings"
git push --set-upstream origin feat/aquamobil-v1-shell
```

---

### Task 1: V1 — Make query state impossible to misread

**Files:**

- Create: `web/apps/aquamobil/src/utils/loadable.ts`
- Create: `web/apps/aquamobil/src/utils/__tests__/loadable.spec.ts`
- Create: `web/apps/aquamobil/src/components/ui/DataState.tsx`
- Create: `web/apps/aquamobil/src/components/ui/__tests__/DataState.spec.tsx`
- Modify: `web/apps/aquamobil/src/components/ui/index.ts`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: V0 `Button`, `EmptyState`, and `Skeleton` primitives.
- Produces:

```ts
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error; retry: () => void }
  | { status: 'ready'; data: T };

export interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch?: () => unknown;
}

export function toLoadable<T>(query: QueryLike<T>): Loadable<T>;

export interface DataStateProps<T> {
  value: Loadable<T>;
  label: string;
  skeleton?: 'text' | 'row' | 'tile';
  skeletonCount?: number;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}

export function DataState<T>(props: DataStateProps<T>): ReactElement;
```

- [ ] **Step 1: Write the failing `toLoadable` tests**

Create tests that pin error precedence over stale data, error normalization, loading when data is
absent, ready data preservation, and retry delegation:

```ts
it('reports an error before stale data', () => {
  const value = toLoadable({
    data: ['stale'],
    isLoading: false,
    isError: true,
    error: new Error('network down'),
    refetch: vi.fn(),
  });
  expect(value.status).toBe('error');
});

it('returns ready only for a successful value', () => {
  const readyData = [{ name: 'Loaded unit' }];
  expect(toLoadable({ data: readyData, isLoading: false, isError: false })).toEqual({
    status: 'ready',
    data: readyData,
  });
});
```

- [ ] **Step 2: Write the failing `DataState` tests**

Render all three arms and prove the ready render function never executes during loading or error.
Also prove an empty array renders `empty` only from the ready arm and that retry calls the query's
`refetch`:

```tsx
const renderReady = vi.fn(() => <div>real rows</div>);
render(
  <DataState value={{ status: 'error', error: new Error('down'), retry }} label="units">
    {renderReady}
  </DataState>,
);
expect(screen.getByText('Could not load units')).toBeInTheDocument();
expect(screen.getByText('This data is unavailable right now. Try again.')).toBeInTheDocument();
expect(screen.queryByText(/queued|saved to device/i)).not.toBeInTheDocument();
expect(renderReady).not.toHaveBeenCalled();
```

- [ ] **Step 3: Run the focused tests and observe the intended RED state**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/utils/__tests__/loadable.spec.ts \
  src/components/ui/__tests__/DataState.spec.tsx
```

Expected: FAIL because `@/utils/loadable` and `DataState` do not exist. Test setup, V0 primitive
imports, and jsdom must initialize successfully before implementation begins.

- [ ] **Step 4: Implement the minimal discriminated union**

Use error-first ordering so a query retaining stale data after a failed refetch cannot reach the
ready arm:

```ts
export function toLoadable<T>(query: QueryLike<T>): Loadable<T> {
  if (query.isError) {
    return {
      status: 'error',
      error: query.error instanceof Error ? query.error : new Error('Request failed'),
      retry: () => {
        void query.refetch?.();
      },
    };
  }
  if (query.isLoading || query.data === undefined) return { status: 'loading' };
  return { status: 'ready', data: query.data };
}
```

Implement `DataState` with one branch per union member. Its generic error description is exactly
“This data is unavailable right now. Try again.” It makes no persistence or queue claim because many
consumers are read-only; write surfaces such as `WaterQualityRecordPage` and `LogSheet` own their
domain-specific device-persistence copy. The default empty predicate returns true only for an empty
array.

- [ ] **Step 5: Export the component and verify GREEN**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/utils/__tests__/loadable.spec.ts \
  src/components/ui/__tests__/DataState.spec.tsx
npm --prefix web/apps/aquamobil exec -- eslint \
  src/utils/loadable.ts \
  src/utils/__tests__/loadable.spec.ts \
  src/components/ui/DataState.tsx \
  src/components/ui/__tests__/DataState.spec.tsx \
  src/components/ui/index.ts
```

Expected: PASS; the error tests show no ready content and the retry test calls `refetch` once.

- [ ] **Step 6: Regenerate scope metadata, commit, and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/utils/loadable.ts \
  web/apps/aquamobil/src/utils/__tests__/loadable.spec.ts \
  web/apps/aquamobil/src/components/ui/DataState.tsx \
  web/apps/aquamobil/src/components/ui/__tests__/DataState.spec.tsx \
  web/apps/aquamobil/src/components/ui/index.ts \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): add truthful query state authority" \
  -m "Make loading, failure, and ready data mutually exclusive before page migrations begin."
git push
```

---

### Task 2: V1 — Propagate hook failures instead of manufacturing zeroes

**Files:**

- Create: `web/apps/aquamobil/src/__tests__/query-error-surface.invariant.spec.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/query-error-propagation.spec.tsx`
- Modify: `web/apps/aquamobil/src/hooks/useAiConsent.ts`
- Modify: `web/apps/aquamobil/src/hooks/useDailyOpsStats.ts`
- Modify: `web/apps/aquamobil/src/hooks/useSentimentTrends.ts`
- Modify: `web/apps/aquamobil/src/hooks/useStockEventsSummary.ts`
- Modify: `web/apps/aquamobil/src/hooks/useUnreadCount.ts`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: existing hook data values, loading flags, tenant-aware keys, and TanStack query results.
- Produces these additive result fields without renaming current fields:

```ts
interface UseAiConsentReturn {
  isAiEnabled: boolean;
  hasConsented: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  toggleConsent: () => Promise<void>;
  isLoading: boolean;
}

interface UseDailyOpsStatsResult {
  stats: DailyOpsStats;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

interface UseSentimentTrendsResult {
  latest: LatestSentiment | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

interface UseStockEventsSummaryResult {
  summary: StockEventsSummary;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

interface UseUnreadCountReturn {
  unreadCount: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}
```

- [ ] **Step 1: Write hook tests for rejected queries**

Mock each hook's query collaborator as rejected and assert its returned error field is true even
when its existing numeric/boolean fallback remains present for compatibility. Require the original
error and a `refetch` that calls every existing constituent query once:

```ts
expect(result.current).toMatchObject({ unreadCount: 0, isError: true });
expect(result.current).toMatchObject({ hasConsented: false, isError: true });
```

For aggregators, reject exactly one constituent query and require the aggregate `isError` to become
true.

- [ ] **Step 2: Write the source invariant**

The invariant enumerates the five named hook files, verifies every public result carries `isError`,
`error`, and `refetch`, and rejects a return object that exports fallback data without exporting the
corresponding error state and retry path. The file list is explicit so an executor can review every
exception.

- [ ] **Step 3: Run tests and observe RED**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/query-error-propagation.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/query-error-surface.invariant.spec.ts
```

Expected: FAIL because the current hook return types omit `isError` and the aggregate hooks discard
constituent query failures.

- [ ] **Step 4: Add only error propagation**

Return the underlying query error directly. For multi-query hooks use boolean OR across the named
sources:

```ts
return {
  summary,
  isLoading: tanksQuery.isLoading || eventsQuery.isLoading,
  isError: tanksQuery.isError || eventsQuery.isError,
  error: tanksQuery.error ?? eventsQuery.error ?? null,
  refetch: async () => {
    await Promise.all([tanksQuery.refetch(), eventsQuery.refetch()]);
  },
};
```

Normalize non-`Error` failures at the hook boundary and wrap TanStack refetch results so the public
retry resolves `void`. Do not introduce a new query, change a query key, clear cached data, or alter
offline fallback behavior in this task.

- [ ] **Step 5: Verify GREEN, typecheck, commit, and push**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/query-error-propagation.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/query-error-surface.invariant.spec.ts
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/__tests__/query-error-surface.invariant.spec.ts \
  src/hooks/__tests__/query-error-propagation.spec.tsx \
  src/hooks/useAiConsent.ts \
  src/hooks/useDailyOpsStats.ts \
  src/hooks/useSentimentTrends.ts \
  src/hooks/useStockEventsSummary.ts \
  src/hooks/useUnreadCount.ts
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/__tests__/query-error-surface.invariant.spec.ts \
  web/apps/aquamobil/src/hooks/__tests__/query-error-propagation.spec.tsx \
  web/apps/aquamobil/src/hooks/useAiConsent.ts \
  web/apps/aquamobil/src/hooks/useDailyOpsStats.ts \
  web/apps/aquamobil/src/hooks/useSentimentTrends.ts \
  web/apps/aquamobil/src/hooks/useStockEventsSummary.ts \
  web/apps/aquamobil/src/hooks/useUnreadCount.ts \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): propagate query failures through shared hooks" \
  -m "Let each consumer distinguish an unavailable count from an observed zero."
git push
```

---

### Task 3: V1 — Install the phone header, dock, and route contract

**Files:**

- Create: `web/apps/aquamobil/src/components/AccountAvatar.tsx`
- Create: `web/apps/aquamobil/src/components/__tests__/AccountAvatar.spec.tsx`
- Create: `web/apps/aquamobil/src/components/AppHeader.tsx`
- Create: `web/apps/aquamobil/src/components/__tests__/AppHeader.spec.tsx`
- Create: `web/apps/aquamobil/src/layouts/__tests__/MobileLayout.navigation.spec.tsx`
- Create: `web/apps/aquamobil/src/__tests__/route-reachability.invariant.spec.ts`
- Modify: `web/apps/aquamobil/src/App.tsx`
- Modify: `web/apps/aquamobil/src/layouts/MobileLayout.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: V0 `IconButton`, current `useFeatureAccess().canReach`, `useOfflineQueue`,
  `useFarmRealtimeSync`, and `useUnreadCount`.
- Produces:

```ts
export function AccountAvatar(): ReactElement;

export interface AppHeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  actions?: ReactNode;
  showAvatar?: boolean;
}

export function AppHeader(props: AppHeaderProps): ReactElement;
```

- [ ] **Step 1: Write the header and avatar tests**

Assert that initials use the first and last name words, the avatar navigates to `/account`, `onBack`
replaces the brand mark with one accessible Back button, `actions` render before the avatar, and
`showAvatar={false}` removes the account control.

- [ ] **Step 2: Write the dock and route tests**

Render `MobileLayout` with representative permissions and require Today, Units, Scan, Reports, and
Chat. Assert Account and Operations are absent from the dock, Account remains reachable through the
header, the still-regulated-only V1 Reports destination disappears when `canReach('reports')` is
false, and Scan disappears when no logging feature is reachable. Task 11 removes the V1 Reports gate
in the same commit that adds the baseline farm summary.

The route invariant parses `App.tsx` and requires one route each for `/units`, `/scan`, `/reports`,
`/reports/:draftId`, `/messages`, and `/account`, while retaining the existing guarded record
routes.

- [ ] **Step 3: Run focused tests and observe RED**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/__tests__/AccountAvatar.spec.tsx \
  src/components/__tests__/AppHeader.spec.tsx \
  src/layouts/__tests__/MobileLayout.navigation.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/route-reachability.invariant.spec.ts
```

Expected: FAIL because the shared header/account components and `/units`/`/scan` routes do not exist
and the current dock still exposes Home, Operations, Tasks, Messages, and Account.

- [ ] **Step 4: Implement shared header chrome**

Keep initials in `AccountAvatar.tsx` so V5's tablet shell does not create a second rule. `AppHeader`
renders `AccountAvatar` rather than duplicating its button:

```tsx
<div className="flex items-center gap-2 shrink-0">
  {actions}
  {showAvatar && <AccountAvatar />}
</div>
```

- [ ] **Step 5: Implement the dock and lazy routes**

Use this destination model:

```ts
const allTabs: readonly TabItem[] = [
  {
    id: 'today',
    label: 'Today',
    path: '/',
    childPaths: ['/tasks', '/alerts', '/notifications', '/operations'],
  },
  { id: 'units', label: 'Units', path: '/units', childPaths: ['/tank'] },
  { id: 'reports', label: 'Reports', path: '/reports', features: ['reports'] },
  { id: 'chat', label: 'Chat', path: '/messages' },
];
```

The raised center Scan control routes to `/scan`. It is present only when at least one of
`mortality`, `cull`, `harvest`, `feeding`, `transfer`, or `waterQuality` passes `canReach`. Preserve
the offline, degraded-live, syncing, critical-alert, and unread/pending indicators. An unread query
error renders an accessible unknown-state marker; it does not render a trusted zero.

Lazy-load `UnitsPage` and `ScanPage`. Keep `/reports` temporarily bound to the existing
`ReportsDuePage`; Task 11 replaces that component atomically.

- [ ] **Step 6: Verify GREEN and the current guarded routes**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/__tests__/AccountAvatar.spec.tsx \
  src/components/__tests__/AppHeader.spec.tsx \
  src/layouts/__tests__/MobileLayout.navigation.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/route-reachability.invariant.spec.ts
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/components/AccountAvatar.tsx \
  src/components/__tests__/AccountAvatar.spec.tsx \
  src/components/AppHeader.tsx \
  src/components/__tests__/AppHeader.spec.tsx \
  src/layouts/MobileLayout.tsx \
  src/layouts/__tests__/MobileLayout.navigation.spec.tsx \
  src/App.tsx \
  src/__tests__/route-reachability.invariant.spec.ts
```

Expected: PASS; direct protected routes retain `FeatureRoute`/`MultiFeatureRoute`, and permission
filtering does not leave an empty dock column.

- [ ] **Step 7: Commit and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/components/AccountAvatar.tsx \
  web/apps/aquamobil/src/components/__tests__/AccountAvatar.spec.tsx \
  web/apps/aquamobil/src/components/AppHeader.tsx \
  web/apps/aquamobil/src/components/__tests__/AppHeader.spec.tsx \
  web/apps/aquamobil/src/layouts/MobileLayout.tsx \
  web/apps/aquamobil/src/layouts/__tests__/MobileLayout.navigation.spec.tsx \
  web/apps/aquamobil/src/App.tsx \
  web/apps/aquamobil/src/__tests__/route-reachability.invariant.spec.ts \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): add field-first phone navigation" \
  -m "Make units and scanning first-class destinations while preserving every guarded workflow."
git push
```

---

### Task 4: V1 — Add truthful unit list and scan-to-unit navigation

**Files:**

- Create: `web/apps/aquamobil/src/pages/scan/ScanPage.tsx`
- Create: `web/apps/aquamobil/src/pages/scan/__tests__/resolveScannedUnit.spec.ts`
- Create: `web/apps/aquamobil/src/pages/scan/__tests__/ScanPage.route.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/units/UnitsPage.tsx`
- Create: `web/apps/aquamobil/src/pages/units/__tests__/UnitsPage.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useTanks.status.spec.ts`
- Modify: `web/apps/aquamobil/src/hooks/useTanks.ts`
- Modify: `web/apps/aquamobil/src/types/index.ts`
- Modify: `web/apps/aquamobil/src/hooks/index.ts`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: `DataState`, `toLoadable`, `AppHeader`, V0 list/card/button primitives,
  `useTanks(): UseQueryResult<Tank[], Error>`, and `/tank/:tankId`.
- Produces:

```ts
export const UNIT_TAG_PATH_PREFIX = '/mobile/unit/';

export type ScanResolution =
  | { kind: 'matched'; tank: Tank }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' }
  | { kind: 'invalid'; reason: 'blank' | 'unsupported-url' };

export function resolveScannedUnit(
  raw: string,
  tanks: readonly Tank[],
  expectedOrigin: string,
): ScanResolution;
export function narrowTankStatus(raw: string | null | undefined): Tank['status'];

export type TankStatus =
  | 'ACTIVE'
  | 'PREPARING'
  | 'CLEANING'
  | 'MAINTENANCE'
  | 'HARVESTING'
  | 'FALLOW'
  | 'QUARANTINE'
  | 'INACTIVE';
```

- [ ] **Step 1: Test scanner resolution as a pure function**

Cover blank input, id, case-insensitive code, name, and the one supported same-origin URL shape.
Build identifiers from fixtures and the accepted origin from `window.location.origin`; never
manufacture a domain id. Query/fragment suffixes are allowed only after the canonical
`/mobile/unit/` path. A foreign origin, a same-origin foreign path, malformed percent encoding, a
decoded identifier containing path syntax, and any plain value containing URL/path syntax are
`invalid`. A missing identifier is `unknown`. Two tanks matching the same normalized code or name
are `ambiguous`, even if array order differs:

```ts
const scannedUnit = tank();
const expectedOrigin = window.location.origin;
expect(
  resolveScannedUnit(
    `${expectedOrigin}${UNIT_TAG_PATH_PREFIX}${encodeURIComponent(scannedUnit.id)}?src=rail#tag`,
    [scannedUnit],
    expectedOrigin,
  ),
).toEqual({ kind: 'matched', tank: scannedUnit });
expect(resolveScannedUnit(scannedUnit.code.toLowerCase(), [scannedUnit], expectedOrigin)).toEqual({
  kind: 'matched',
  tank: scannedUnit,
});

const sameCode = tank({ code: scannedUnit.code });
expect(resolveScannedUnit(scannedUnit.code, [scannedUnit, sameCode], expectedOrigin)).toEqual({
  kind: 'ambiguous',
});

const foreign = new URL(
  `${UNIT_TAG_PATH_PREFIX}${encodeURIComponent(scannedUnit.id)}`,
  'https://foreign.invalid',
);
expect(resolveScannedUnit(foreign.href, [scannedUnit], expectedOrigin)).toEqual({
  kind: 'invalid',
  reason: 'unsupported-url',
});
expect(
  resolveScannedUnit(
    `${expectedOrigin}/mobile/messages/${encodeURIComponent(scannedUnit.id)}`,
    [scannedUnit],
    expectedOrigin,
  ),
).toEqual({ kind: 'invalid', reason: 'unsupported-url' });
```

- [ ] **Step 2: Test route behavior and query failure**

Mock a ready tank query and scan that fixture's own id; require navigation to
`/tank/${scannedUnit.id}`. An unknown identifier renders “Tag not recognised.” An ambiguous
code/name renders “Tag matches more than one unit,” and a foreign-origin or foreign-path URL renders
“Unsupported unit tag”; none of those branches navigates. Mock a failed tank query and require
“Could not load units,” with no scanner-domain error and no navigation. Also assert camera tracks
stop on unmount, successful detection, and Cancel.

- [ ] **Step 3: Test the Units page's three query states**

Loading renders rows in loading form; error renders retry and no “No units”; ready-empty renders “No
units”; ready-data groups by opaque `siteId` and navigates to the selected tank. The ready fixture
containing the fail-closed `INACTIVE` status visibly renders “Inactive.” Do not invent site names.

- [ ] **Step 4: Test all backend tank statuses and unknown wire input**

```ts
expect(narrowTankStatus('cleaning')).toBe('CLEANING');
expect(narrowTankStatus('FALLOW')).toBe('FALLOW');
expect(narrowTankStatus(null)).toBe('INACTIVE');
expect(narrowTankStatus(undefined)).toBe('INACTIVE');
expect(narrowTankStatus('   ')).toBe('INACTIVE');
expect(narrowTankStatus('new-server-value')).toBe('INACTIVE');
expect(logger.warn).toHaveBeenCalledWith('[useTanks] unknown container status from the wire', {
  status: 'new-server-value',
});
```

Assert a warning for each null, undefined, blank, and unknown value, preserving the received
`status` value in the log payload. Missing status is unknown wire data; it is never inferred to mean
active.

- [ ] **Step 5: Run the tests and observe RED**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/scan/__tests__/resolveScannedUnit.spec.ts \
  src/pages/scan/__tests__/ScanPage.route.spec.tsx \
  src/pages/units/__tests__/UnitsPage.outage.spec.tsx \
  src/hooks/__tests__/useTanks.status.spec.ts
```

Expected: FAIL because both pages and `narrowTankStatus` are absent, and the current `Tank` union
omits `CLEANING` and `FALLOW`.

- [ ] **Step 6: Implement runtime narrowing without a wire cast**

```ts
const TANK_STATUSES: readonly Tank['status'][] = [
  'ACTIVE',
  'PREPARING',
  'CLEANING',
  'MAINTENANCE',
  'HARVESTING',
  'FALLOW',
  'QUARANTINE',
  'INACTIVE',
];

function isTankStatus(value: string): value is Tank['status'] {
  return TANK_STATUSES.some((candidate) => candidate === value);
}

export function narrowTankStatus(raw: string | null | undefined): Tank['status'] {
  const normalized = raw?.trim().toUpperCase();
  if (normalized && isTankStatus(normalized)) return normalized;
  logger.warn('[useTanks] unknown container status from the wire', { status: raw });
  return 'INACTIVE';
}
```

- [ ] **Step 7: Implement scanner and list through `DataState`**

`ScanPage` converts the query once and gives ready tanks to a child camera component:

```tsx
const units = toLoadable(useTanks());
return (
  <DataState value={units} label="units" skeleton="tile" skeletonCount={1}>
    {(tanks) => <ScanExperience tanks={tanks} onClose={() => navigate(-1)} />}
  </DataState>
);
```

Implement `resolveScannedUnit` without a final-segment shortcut. A bare value may contain no `/`,
`?`, or `#`. An absolute tag URL must have `url.origin === expectedOrigin` and a pathname matching
exactly `/^\/mobile\/unit\/([^/]+)$/`; decode the one captured identifier segment, then reject
decode failures or a decoded `/`, `?`, or `#`. Match the normalized identifier against each tank's
id, code, or name, then return `matched` only for exactly one tank. Zero matches are `unknown`;
multiple matching tanks are `ambiguous`. Do not use `.find()` or let array order choose a unit.

The camera component passes `window.location.origin` to that resolver and has only camera-domain
states: idle, scanning, matched, unknown, ambiguous, unsupported, and denied. It navigates only from
`matched`, and it never substitutes `[]` for an unavailable tank query. `UnitsPage` likewise wraps
`toLoadable(useTanks())` once and derives groups only inside the ready render function.

- [ ] **Step 8: Verify the complete V1 slice**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/utils/__tests__/loadable.spec.ts \
  src/components/ui/__tests__/DataState.spec.tsx \
  src/hooks/__tests__/query-error-propagation.spec.tsx \
  src/layouts/__tests__/MobileLayout.navigation.spec.tsx \
  src/pages/scan/__tests__/resolveScannedUnit.spec.ts \
  src/pages/scan/__tests__/ScanPage.route.spec.tsx \
  src/pages/units/__tests__/UnitsPage.outage.spec.tsx \
  src/hooks/__tests__/useTanks.status.spec.ts
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/query-error-surface.invariant.spec.ts \
  src/__tests__/route-reachability.invariant.spec.ts
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm --prefix web/apps/aquamobil exec -- eslint \
  src/pages/scan/ScanPage.tsx \
  src/pages/scan/__tests__/resolveScannedUnit.spec.ts \
  src/pages/scan/__tests__/ScanPage.route.spec.tsx \
  src/pages/units/UnitsPage.tsx \
  src/pages/units/__tests__/UnitsPage.outage.spec.tsx \
  src/hooks/useTanks.ts \
  src/hooks/__tests__/useTanks.status.spec.ts \
  src/hooks/index.ts \
  src/types/index.ts
```

Expected: PASS. A valid same-origin tag reaches its unit; foreign, ambiguous, and unknown tags
remain visible without navigation; a query outage is not a scanner miss; missing/unknown wire status
is logged and displayed as inactive; and all eight known server statuses render safely.

- [ ] **Step 9: Classify production dependencies for the V1 PR**

Run the complete Production Dependency Checkpoint with `v4_product_slice=V1`. Require its fixed
directory to be uploaded by the V1 PR workflow and captured by the program as repository-bound
boundary evidence. Stop the PR for any missing proof, unclassified path, or affected-and-reachable
high/critical path; do not mutate dependencies, the immutable preflight, or the central ledger
during this classification.

- [ ] **Step 10: Commit the finished V1 slice and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/pages/scan/ScanPage.tsx \
  web/apps/aquamobil/src/pages/scan/__tests__/resolveScannedUnit.spec.ts \
  web/apps/aquamobil/src/pages/scan/__tests__/ScanPage.route.spec.tsx \
  web/apps/aquamobil/src/pages/units/UnitsPage.tsx \
  web/apps/aquamobil/src/pages/units/__tests__/UnitsPage.outage.spec.tsx \
  web/apps/aquamobil/src/hooks/useTanks.ts \
  web/apps/aquamobil/src/hooks/__tests__/useTanks.status.spec.ts \
  web/apps/aquamobil/src/hooks/index.ts \
  web/apps/aquamobil/src/types/index.ts \
  tools/quality/format-scope.json
slice_finding_id="$(jq -sre --arg title 'AquaMobil product reads can render failure as valid field state' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$slice_finding_id" =~ ^[A-Z][A-Z0-9-]*-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): add truthful scan and unit destinations" \
  -m "Resolve field tags only against a successfully loaded inventory and cover every server tank status." \
  -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md#$slice_finding_id"
npx nx affected --target=lint --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=test --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=build --base=origin/main --head=HEAD --skip-nx-cache
git push
```

---

### Task 5: V2 — Make generated GraphQL inputs the only request authority

**Files:**

- Create: `web/apps/aquamobil/src/graphql/water-quality.operations.ts`
- Create: `web/apps/aquamobil/src/graphql/queued-mutation-documents.ts`
- Create:
  `web/apps/aquamobil/src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx`
- Create:
  `web/apps/aquamobil/src/pages/mortality/__tests__/RecordMortalityPage.generated-contract.spec.tsx`
- Create: `tests/invariants/aquamobil-generated-input-authority.spec.ts`
- Create: `docs/superpowers/evidence/aquamobil-v4/slices/V2/preflight.json` through the program
  capture tool
- Modify: `web/apps/aquamobil/src/generated/graphql.ts` through `npm run codegen`
- Modify: `web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`
- Modify: `web/apps/aquamobil/src/types/index.ts`
- Modify: `web/apps/aquamobil/src/pwa/operation-registry.ts`
- Modify: `web/apps/aquamobil/src/pwa/__tests__/operation-registry.spec.ts`
- Modify: `web/apps/aquamobil/src/pwa/__tests__/queued-mutation-ssot.spec.ts`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: the composed supergraph selected by root `codegen.ts`, `graphqlRequest`,
  `useOfflineQueue.addToQueue`, `QueuedStatusBadge`, the current dependency-free replay registry,
  and every existing positive queue operation.
- Produces generated `EquipmentListQuery`, `EquipmentParametersQuery`,
  `CreateWaterQualityMeasurementMutation`, their variable types/documents, all GraphQL inputs
  referenced by queued operations, `WaterQualityMeasurementSource`, and this compiler-owned input
  from the composed schema. The current codegen scalar mapping makes every `ID` input a `string`:

```ts
export type CreateWaterQualityInput = {
  batchId?: string | null;
  clientCommandId?: string | null;
  clientCreatedAt?: string | null;
  deviceId?: string | null;
  dynamicParameters: Record<string, unknown>;
  equipmentId: string;
  idempotencyKey?: string | null;
  measuredAt: string;
  measuredBy?: string | null;
  notes?: string | null;
  operationType?: string | null;
  payloadHash?: string | null;
  pondId?: string | null;
  relatedSensorReadingId?: string | null;
  schemaVersion?: string | null;
  siteId?: string | null;
  source: WaterQualityMeasurementSource;
  tankId?: string | null;
  weatherConditions?: string | null;
};
```

- [ ] **Step 0: Verify the coordinator-created V2 worktree from the reconciled V1 result**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
v4_preflight='docs/superpowers/evidence/aquamobil-v4/slices/V2/preflight.json'
test "$(git branch --show-current)" = 'feat/aquamobil-v2-field-workflows'
test -f "$v4_preflight"
test "$(git rev-parse HEAD)" = "$(jq -r '.baseMainCommit' "$v4_preflight")"
git merge-base --is-ancestor "$(jq -r '.baseMainCommit' "$v4_preflight")" origin/main
git show origin/main:docs/superpowers/evidence/aquamobil-v4/slices/V1/merge.json |
  jq -e '.slice == "V1" and [.implementationBoundaries[].boundaryId] == ["shell"]'
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice V2 \
  --check "$v4_preflight" \
  --main-ref origin/main
```

Expected: `origin/main` contains the protected V1 resulting SHA and product-finding registration;
otherwise stop before creating V2 behavior.

- [ ] **Step 1: Write the failing queue-status component tests**

Exercise four outcomes against the real page submit handler, generating the mock operation id at
test runtime rather than hard-coding an id:

```tsx
it('labels an offline write as saved to the device, not recorded', async () => {
  const queuedResult = {
    status: 'queued',
    id: crypto.randomUUID(),
  } satisfies AddToQueueResult;
  queueState.isOnline = false;
  queueState.addToQueue.mockResolvedValue(queuedResult);
  renderPage();
  await submitValidDynamicMeasurement();
  expect(await screen.findByText('Saved to device')).toBeInTheDocument();
  expect(screen.getByText(/not recorded until it reaches the server/i)).toBeInTheDocument();
  expect(screen.queryByText(/measurement recorded/i)).not.toBeInTheDocument();
  expect(screen.getByTestId(`queued-status-${queuedResult.id}`)).toBeInTheDocument();
});
```

The second test makes an online mutation succeed and requires “Measurement recorded.” The third
throws a recoverable network error, requires a queue attempt, and requires the device-saved state.
The fourth returns `{ status: 'duplicate', id }` and requires the existing “Already recorded”
deduplication message without a second success claim.

- [ ] **Step 2: Write the failing generated-authority and queued-document invariants**

`aquamobil-generated-input-authority.spec.ts` parses every non-generated TypeScript/TSX file under
`web/apps/aquamobil/src/` with the TypeScript compiler API. It loads the complete generated GraphQL
input-name/property set, rejects any local interface or structural object-literal alias that
redeclares one of those inputs outside the generated file, and then requires each public
compatibility name in `src/types/index.ts` to resolve through a type-only import from
`../generated/graphql`:

```ts
const PUBLIC_ALIAS_TO_GENERATED_INPUT = {
  MortalityInput: 'RecordMortalityInput',
  CullInput: 'RecordCullInput',
  HarvestInput: 'CreateHarvestRecordInput',
  LiceCountInput: 'RecordLiceCountInput',
  WelfareAssessmentInput: 'RecordWelfareAssessmentInput',
  EscapeIncidentInput: 'RecordEscapeIncidentInput',
  FeedingInput: 'RecordDailyFeedingInput',
  RecordMealFeedingPayload: 'RecordMealFeedingInput',
  ClockInInput: 'ClockInInput',
  ClockOutInput: 'ClockOutInput',
  GeoLocation: 'GeoLocationInput',
  CreateLeaveRequestInput: 'CreateLeaveRequestInput',
  ChecklistItemSetInput: 'SetChecklistItemInput',
  TransferInput: 'TransferBatchInput',
  CreateWaterQualityInput: 'CreateWaterQualityInput',
  StockMovementInput: 'RecordStockMovementInput',
  StockTransferInput: 'TransferStockInput',
  AcknowledgeAlertInputPayload: 'AcknowledgeAlertInput',
} as const;
```

The invariant has no parity waiver: each alias must be either the generated input itself or the
shared `QueueDomainInput<GeneratedInput>` projection that removes only the six fields stamped by
`offline-queue.ts`. HR inputs, including the nested `GeoLocationInput`, are GraphQL inputs and
receive the same generated treatment; they are not exceptions. `MessagingOfflinePayload` is a
composition of generated send/edit/read inputs plus operation-level ids, not a replica of one
GraphQL input. `UploadAndSendMessageOfflinePayload` is the sole structurally handwritten queue-only
payload because it references the binary store for the presign → PUT → send replay; prove that exact
exception by asserting `uploadAndSendMessage` is absent from `OPERATION_MUTATIONS`, present in
`SW_REPLAY_SKIP_TYPES`, and carries `blobId`. This queue-only name does not correspond to a schema
input, so the invariant recognizes it by its binary-lane structure rather than a string waiver list.
A newly introduced page-local or hook-local GraphQL input mirror must fail this repository scan even
if `src/types/index.ts` remains clean.

Rewrite `queued-mutation-ssot.spec.ts` around the new direction of ownership: every value used by
`OPERATION_MUTATIONS` must be an exported source string from
`src/graphql/queued-mutation-documents.ts`, `operation-registry.ts` may contain no mutation
template, and every queued operation/root is present exactly once in that source file. For every
dual-path root, codegen must emit one `Queued...Document` from that same source string and the
online page must import that generated document; a second online mutation text is forbidden. Add
`createWaterQualityMeasurement` to this single-source dual-path set. Update
`operation-registry.spec.ts` to prove all positive `OperationType` values except the binary lane
still resolve to a non-empty imported source and retain their existing variable shaping.

Add a mortality component test that proves the reason control contains only values accepted by
generated `MortalityReason`; specifically, the current client-only `AMMONIA`, `STARVATION`, and
`GENETIC` values are absent rather than sent to a backend enum that rejects them.

- [ ] **Step 3: Run the RED tests before adding documents**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx \
  src/pages/mortality/__tests__/RecordMortalityPage.generated-contract.spec.tsx \
  src/pwa/__tests__/operation-registry.spec.ts \
  src/pwa/__tests__/queued-mutation-ssot.spec.ts
npm exec -- jest --config tests/invariants/jest.config.ts \
  --selectProjects layer-1 --runInBand --runTestsByPath \
  tests/invariants/aquamobil-generated-input-authority.spec.ts
```

Expected: the water-quality page test FAILS because the current offline branch presents a successful
recording; the authority invariant FAILS on the handwritten GraphQL request interfaces; the
mortality test FAILS on client-only enum values; and the queue SSoT test FAILS because mutation
documents still live inside `operation-registry.ts`.

- [ ] **Step 4: Add online water-quality documents and lift every replay document**

```ts
export const EQUIPMENT_LIST_QUERY = gql`
  query EquipmentList($filter: EquipmentFilterInput) {
    equipmentList(filter: $filter) {
      items {
        id
        name
        code
        equipmentType {
          category
          name
        }
      }
    }
  }
`;

export const EQUIPMENT_PARAMS_QUERY = gql`
  query EquipmentParameters($equipmentId: ID!) {
    equipmentParameters(equipmentId: $equipmentId) {
      parameterConfig {
        id
        code
        name
        unit
        dataType
        precision
        group
        optimalMin
        optimalMax
        warningMin
        warningMax
        criticalMin
        criticalMax
        enumValues
        displayOrder
        isRequired
        chartColor
      }
    }
  }
`;
```

In `queued-mutation-documents.ts`, export dependency-free `/* GraphQL */` template strings for every
current `OPERATION_MUTATIONS` value: mortality, cull, harvest, legacy daily feeding, meal feeding,
clock in/out, create/submit leave, complete/start task, checklist set, batch transfer, water
quality, stock movement/transfer, lice, welfare, escape, alert acknowledgement, and
send/edit/delete/mark-read messaging. Preserve every current root field, variable shape, and
selection set; rename each GraphQL operation to one unique `Queued...` name. Codegen plucks that
sole source into the generated `Queued...Document` used by online callers, while foreground and
closed-client replay import the exact raw source string. For example:

```ts
export const QUEUED_RECORD_MORTALITY = /* GraphQL */ `
  mutation QueuedRecordMortality($input: RecordMortalityInput!) {
    recordMortality(input: $input) {
      id
      currentQuantity
      totalMortality
    }
  }
`;
```

Import those strings into `operation-registry.ts` and map the existing keys to them. Update its
module comment so it truthfully permits this dependency-free source-string import rather than
claiming all non-type imports are forbidden. Keep `buildOperationVariables`,
`getLeaveSubmitFollowUp`, and `SW_REPLAY_SKIP_TYPES` in the replay registry; only document ownership
moves. The GraphQL source module has no runtime import, so both foreground and service-worker
bundles still consume plain strings and no second replay registry appears.

- [ ] **Step 5: Regenerate, never hand-edit, the AquaMobil client**

```bash
npm run apollo-router:compose
npm run codegen
npm run codegen:check
```

Expected: the composed supergraph is fresh and `web/apps/aquamobil/src/generated/graphql.ts`
contains the input above, every input named in `PUBLIC_ALIAS_TO_GENERATED_INPUT`, the two online
water-quality query documents, and one typed `Queued...Document` per dependency-free mutation
source. If validation fails, fix the source document or composed schema; do not edit generated
TypeScript. If composition refreshes an unrelated committed registry artifact, stop and send that
overlap to its owning plan rather than staging it here.

- [ ] **Step 6: Replace every handwritten GraphQL request shape with generated aliases**

Import the two query documents from `@/graphql/water-quality.operations`. Import
`EquipmentListQuery`, `EquipmentParametersQuery`, `QueuedCreateWaterQualityMeasurementDocument`,
`QueuedCreateWaterQualityMeasurementMutation`, their variable types, and `CreateWaterQualityInput`
from `@/generated/graphql`; the online mutation calls the generated queued document and does not
define another operation. Delete the handwritten equipment result/configuration shapes as well as
the handwritten water-quality input. Build the payload only with fields accepted by the generated
type:

```ts
const input: CreateWaterQualityInput = {
  equipmentId: selectedEquipmentId,
  measuredAt: new Date().toISOString(),
  source: 'MANUAL',
  idempotencyKey: crypto.randomUUID(),
  dynamicParameters: Object.fromEntries(Object.entries(values)),
  ...(notes.trim() ? { notes: notes.trim() } : {}),
  ...(weatherConditions?.trim() ? { weatherConditions: weatherConditions.trim() } : {}),
};
```

Delete every handwritten interface named in `PUBLIC_ALIAS_TO_GENERATED_INPUT`, plus the handwritten
request enum replicas. Import each schema type under a `Generated...` name and preserve the existing
public import surface only as aliases. The queue owns its envelope, so callers receive one
projection and cannot pre-stamp identity fields:

```ts
type QueueEnvelopeField =
  | 'clientCommandId'
  | 'clientCreatedAt'
  | 'deviceId'
  | 'operationType'
  | 'payloadHash'
  | 'schemaVersion';

type QueueDomainInput<T> = Omit<T, QueueEnvelopeField>;

export type MortalityInput = QueueDomainInput<GeneratedRecordMortalityInput>;
export type CullInput = QueueDomainInput<GeneratedRecordCullInput>;
export type HarvestInput = QueueDomainInput<GeneratedCreateHarvestRecordInput>;
export type LiceCountInput = QueueDomainInput<GeneratedRecordLiceCountInput>;
export type WelfareAssessmentInput = QueueDomainInput<GeneratedRecordWelfareAssessmentInput>;
export type EscapeIncidentInput = QueueDomainInput<GeneratedRecordEscapeIncidentInput>;
export type FeedingInput = QueueDomainInput<GeneratedRecordDailyFeedingInput>;
export type RecordMealFeedingPayload = QueueDomainInput<GeneratedRecordMealFeedingInput>;
export type ClockInInput = QueueDomainInput<GeneratedClockInInput>;
export type ClockOutInput = QueueDomainInput<GeneratedClockOutInput>;
export type GeoLocation = GeneratedGeoLocationInput;
export type CreateLeaveRequestInput = QueueDomainInput<GeneratedCreateLeaveRequestInput>;
export type ChecklistItemSetInput = QueueDomainInput<GeneratedSetChecklistItemInput>;
export type TransferInput = QueueDomainInput<GeneratedTransferBatchInput>;
export type CreateWaterQualityInput = QueueDomainInput<GeneratedCreateWaterQualityInput>;
export type StockMovementInput = QueueDomainInput<GeneratedRecordStockMovementInput>;
export type StockTransferInput = QueueDomainInput<GeneratedTransferStockInput>;
export type AcknowledgeAlertInputPayload = QueueDomainInput<GeneratedAcknowledgeAlertInput>;

export interface MobileCommandEnvelope {
  clientCommandId?: string | null;
  clientCreatedAt?: string | null;
  deviceId?: string | null;
  operationType?: OperationType | null;
  payloadHash?: string | null;
  schemaVersion?: string | null;
}
```

Re-export `MortalityReason`, `CullReason`, `QualityClass`, `EscapeIncidentCause`, `ClockMethod`,
`MovementType` (under the existing `StockMovementType` name), `StorageItemType`, and
`WaterQualityMeasurementSource` (under the existing `MeasurementSource` name) from generated types.
Remove `AMMONIA`, `STARVATION`, and `GENETIC` from `MORTALITY_REASONS`; these values are absent from
the composed `MortalityReason` enum. Do not cast them through the compiler. Keep
`MessagingOfflinePayload` as an operation-variable composition over generated messaging inputs, and
keep only the proven binary-store payload as a structural local interface.

Update `OperationPayload` to union the generated projections and intersect the result with
`MobileCommandEnvelope` exactly once. Run typecheck before changing any caller. If a caller fails,
correct the value to the generated contract in that caller; do not widen an alias, add a duplicate
shape, or weaken codegen.

- [ ] **Step 7: Make server acknowledgement and device persistence visibly different**

Online success sets the recorded state only after the mutation resolves. Offline and
recoverable-network paths inspect the `AddToQueueResult` discriminator, retain its returned queue
id, and render `QueuedStatusBadge` with “Saved to device” and “This measurement is not recorded
until it reaches the server.” A duplicate renders the existing deduplication wording. A
non-recoverable GraphQL error stays on the form and is not queued.

- [ ] **Step 8: Verify generated freshness and GREEN tests**

```bash
npm run apollo-router:compose
npm run codegen:check
npm --prefix web/apps/aquamobil test -- \
  src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx \
  src/pages/mortality/__tests__/RecordMortalityPage.generated-contract.spec.tsx \
  src/pwa/__tests__/operation-registry.spec.ts \
  src/pwa/__tests__/queued-mutation-ssot.spec.ts
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/pwa/__tests__/sw-build-artifact.invariant.spec.ts
npm exec -- jest --config tests/invariants/jest.config.ts \
  --selectProjects layer-1 --runInBand --runTestsByPath \
  tests/invariants/aquamobil-generated-input-authority.spec.ts
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/graphql/queued-mutation-documents.ts \
  src/graphql/water-quality.operations.ts \
  src/pages/mortality/RecordMortalityPage.tsx \
  src/pages/mortality/__tests__/RecordMortalityPage.generated-contract.spec.tsx \
  src/pages/water-quality/WaterQualityRecordPage.tsx \
  src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx \
  src/types/index.ts \
  src/pwa/operation-registry.ts \
  src/pwa/__tests__/operation-registry.spec.ts \
  src/pwa/__tests__/queued-mutation-ssot.spec.ts
npm exec -- eslint tests/invariants/aquamobil-generated-input-authority.spec.ts
! rg -n 'mutation\s+[A-Za-z]' web/apps/aquamobil/src/pwa/operation-registry.ts
! rg -n 'export\s+interface\s+(MortalityInput|CullInput|HarvestInput|LiceCountInput|WelfareAssessmentInput|EscapeIncidentInput|FeedingInput|RecordMealFeedingPayload|ClockInInput|ClockOutInput|GeoLocation|CreateLeaveRequestInput|ChecklistItemSetInput|TransferInput|CreateWaterQualityInput|StockMovementInput|StockTransferInput|AcknowledgeAlertInputPayload)' \
  web/apps/aquamobil/src/types/index.ts
```

Expected: PASS; both negated searches print nothing, codegen is fresh, the service-worker build and
online page consume two representations generated from one mutation source, every GraphQL input is
compiler-owned, and water-quality's online and queued outcomes remain visibly distinct.

- [ ] **Step 9: Commit the generated contract as one boundary and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/graphql/queued-mutation-documents.ts \
  web/apps/aquamobil/src/graphql/water-quality.operations.ts \
  web/apps/aquamobil/src/generated/graphql.ts \
  web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx \
  web/apps/aquamobil/src/pages/mortality/__tests__/RecordMortalityPage.generated-contract.spec.tsx \
  web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx \
  web/apps/aquamobil/src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx \
  web/apps/aquamobil/src/types/index.ts \
  web/apps/aquamobil/src/pwa/operation-registry.ts \
  web/apps/aquamobil/src/pwa/__tests__/operation-registry.spec.ts \
  web/apps/aquamobil/src/pwa/__tests__/queued-mutation-ssot.spec.ts \
  tests/invariants/aquamobil-generated-input-authority.spec.ts \
  docs/superpowers/evidence/aquamobil-v4/slices/V2/preflight.json \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "refactor(aquamobil): generate queued request contracts" \
  -m "Make GraphQL input drift a compile-time failure and distinguish queued persistence from server acknowledgement."
git push
```

---

### Task 6: V2 — Establish one unit and farm display vocabulary

**Files:**

- Create: `web/apps/aquamobil/src/graphql/farm-stock.operations.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useTanks.stock-projection.spec.ts`
- Create: `web/apps/aquamobil/src/utils/unit-display.ts`
- Create: `web/apps/aquamobil/src/utils/__tests__/unit-display.spec.ts`
- Create: `web/apps/aquamobil/src/utils/farm-summary.ts`
- Create: `web/apps/aquamobil/src/utils/__tests__/farm-summary.spec.ts`
- Create: `web/apps/aquamobil/src/components/cards/__tests__/TankCard.capacity.spec.tsx`
- Modify: `web/apps/aquamobil/src/generated/graphql.ts` through `npm run codegen`
- Modify: `web/apps/aquamobil/src/hooks/useTanks.ts`
- Modify: `web/apps/aquamobil/src/hooks/__tests__/useTanks-pagination.spec.ts`
- Modify: `web/apps/aquamobil/src/types/index.ts`
- Modify: `web/apps/aquamobil/src/components/cards/TankCard.tsx`
- Modify: `web/apps/aquamobil/src/components/ui/__tests__/CapacityMeter.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/transfer/__tests__/RecordTransferPage.spec.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: the V1-complete eight-member `Tank['status']`, generated `FarmStockInventoryQuery`,
  backend `hasActiveBatch`/`isOverCapacity`, the existing tenant-scoped cache, and V0
  `CapacityMeter`.
- Produces:

```ts
export interface Tank {
  id: string;
  name: string;
  code: string;
  volume: number;
  status: TankStatus;
  currentQuantity: number;
  currentBiomass: number;
  maxBiomass: number | null;
  hasActiveBatch: boolean;
  siteId: string | null;
  batchMetrics: BatchMetrics | null;
}

export type UnitStatusTone = 'ok' | 'warn' | 'crit';
export interface UnitStatusMeta {
  label: string;
  tone: UnitStatusTone;
}
export interface UnitGroup {
  siteId: string;
  label: string;
  units: Tank[];
}
export function unitStatusMeta(status: Tank['status']): UnitStatusMeta;
export function groupUnitsBySite(units: Tank[]): UnitGroup[];
export function fixedOrNone(value: number | null | undefined, digits: number): string;
export function compactCount(count: number): string;

export const WATCH_AT = 70;
export interface FarmSummary {
  stockedCount: number;
  totalCount: number;
  fish: number;
  biomassKg: number;
  avgWeightG: number;
  atWatch: number;
  atLimit: number;
  densest: Tank[];
}
export function farmSummary(tanks: readonly Tank[]): FarmSummary;
```

- [ ] **Step 1: Write failing inventory-validation and display tests**

In `useTanks.stock-projection.spec.ts`, exercise `fetchAllTanks` through mocked GraphQL responses
and fixture-generated opaque ids. Require container totals even when the primary batch has a smaller
quantity. Require an active-batch container with `currentQuantity: null` or `currentBiomassKg: null`
to reject with “Invalid active stock projection,” never return zero and never fall back to cached
data. Require `hasActiveBatch: false` with nullable totals to normalize both totals to zero, and
preserve that generated boolean on `Tank` rather than re-inferring stock state from a primary-batch
projection. Require `maxBiomassKg: null` to remain null.

Update the pagination fixtures to include `hasActiveBatch: false`. Require all eight statuses to
have a word and tone. Require nullable metrics to format as `—`, site groups to preserve first-seen
order, and compact counts to format `950`, `18.2K`, and `1.3M`. `TankCard.capacity.spec.tsx` and the
transfer-page test require a null maximum biomass to render `—`, not `0`, “0 kg,” or a derived
percentage; the Tank Detail implementation must use the same helper and is exercised again by Task
8's detail tests.

- [ ] **Step 2: Write failing farm-summary tests**

Use a mixed-batch fixture where container totals differ from primary-batch totals:

```ts
const result = farmSummary([
  tank({ currentQuantity: 100_000, currentBiomass: 300_000, primaryPieces: 60_000 }),
  tank({ currentQuantity: 5_000, currentBiomass: 10_000, primaryPieces: 5_000 }),
]);
expect(result.fish).toBe(105_000);
expect(result.biomassKg).toBe(310_000);
expect(result.avgWeightG).toBeCloseTo((310_000 * 1000) / 105_000);
```

Also prove `atWatch` uses `capacityUsedPercent >= 70`, `atLimit` uses only
`isOverCapacity === true`, null percentages sort last without rendering zero, and at most five
densest units are returned.

- [ ] **Step 3: Pin corrected meter semantics**

The `CapacityMeter` test requires advisory labels such as “Watch 70%” and “Density 90%”; it rejects
“Consent limit 90%.” A separate assertion proves the component does not derive consent from its
local percentage.

- [ ] **Step 4: Run tests and observe RED**

```bash
npm run apollo-router:compose
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useTanks.stock-projection.spec.ts \
  src/hooks/__tests__/useTanks-pagination.spec.ts \
  src/utils/__tests__/unit-display.spec.ts \
  src/utils/__tests__/farm-summary.spec.ts \
  src/components/cards/__tests__/TankCard.capacity.spec.tsx \
  src/pages/transfer/__tests__/RecordTransferPage.spec.tsx \
  src/components/ui/__tests__/CapacityMeter.spec.tsx
```

Expected: FAIL because unit/farm utilities and `Tank.currentQuantity` do not exist, the query does
not select `hasActiveBatch`, active null totals currently become zero, and null capacity is
displayed as a zero-like value.

- [ ] **Step 5: Generate and validate the inventory projection before ready state**

Move `FARM_STOCK_INVENTORY_QUERY` to `src/graphql/farm-stock.operations.ts`, add `hasActiveBatch`
beside the nullable total/capacity fields, then run:

```bash
npm run apollo-router:compose
npm run codegen
npm run codegen:check
```

Import the generated document, result, and variable types into `useTanks.ts`; delete its handwritten
`FarmStockInventoryResult`. In the inventory mapper, implement this fail-closed boundary:

```ts
const { hasActiveBatch, currentQuantity, currentBiomassKg } = item.container;
let validatedQuantity = 0;
let validatedBiomassKg = 0;
if (hasActiveBatch) {
  if (currentQuantity === null || currentBiomassKg === null) {
    throw new Error(`Invalid active stock projection for container ${item.container.containerId}`);
  }
  validatedQuantity = currentQuantity;
  validatedBiomassKg = currentBiomassKg;
}
```

The guarded branch narrows active totals to numbers before constructing `Tank`; do not add non-null
assertions or `?? 0` to that branch. Assign `maxBiomass: item.container.maxBiomassKg` unchanged. A
projection/GraphQL validation error bypasses the offline-cache fallback. Only a recoverable network
failure may use the existing tenant-scoped cache, and cached tanks must pass the same runtime
guarantees (`currentQuantity`/`currentBiomass` finite numbers, `maxBiomass` finite-or-null, known
status) before becoming ready data. Do not create a second cache or mirror.

Implement `unitStatusMeta` with an exhaustive `Record<Tank['status'], UnitStatusMeta>`; do not add a
fallback after V1's runtime narrowing. Use `fixedOrNone` in `TankCard`, Tank Detail, and the
transfer destination display so null maximum biomass is always `—` and never participates in
percentage arithmetic.

Implement `farmSummary` only over validated ready `Tank[]` supplied by callers. It never accepts raw
GraphQL items, nullable active totals, or cached data that failed the hook guard:

```ts
export function farmSummary(tanks: readonly Tank[]): FarmSummary {
  const stocked = tanks.filter((tank) => tank.hasActiveBatch);
  const fish = stocked.reduce((sum, tank) => sum + tank.currentQuantity, 0);
  const biomassKg = stocked.reduce((sum, tank) => sum + tank.currentBiomass, 0);
  return {
    stockedCount: stocked.length,
    totalCount: tanks.length,
    fish,
    biomassKg,
    avgWeightG: fish > 0 ? (biomassKg * 1000) / fish : 0,
    atWatch: stocked.filter((tank) => (tank.batchMetrics?.capacityUsedPercent ?? 0) >= WATCH_AT)
      .length,
    atLimit: stocked.filter((tank) => tank.batchMetrics?.isOverCapacity === true).length,
    densest: stocked
      .slice()
      .sort((a, b) => capacityOf(b) - capacityOf(a))
      .slice(0, 5),
  };
}
```

- [ ] **Step 6: Verify GREEN, commit, and push**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useTanks.stock-projection.spec.ts \
  src/hooks/__tests__/useTanks-pagination.spec.ts \
  src/utils/__tests__/unit-display.spec.ts \
  src/utils/__tests__/farm-summary.spec.ts \
  src/components/cards/__tests__/TankCard.capacity.spec.tsx \
  src/pages/transfer/__tests__/RecordTransferPage.spec.tsx \
  src/components/ui/__tests__/CapacityMeter.spec.tsx \
  src/hooks/__tests__/useTanks.status.spec.ts
npm run codegen:check
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/graphql/farm-stock.operations.ts \
  src/hooks/__tests__/useTanks.stock-projection.spec.ts \
  src/hooks/__tests__/useTanks-pagination.spec.ts \
  src/utils/unit-display.ts \
  src/utils/__tests__/unit-display.spec.ts \
  src/utils/farm-summary.ts \
  src/utils/__tests__/farm-summary.spec.ts \
  src/hooks/useTanks.ts \
  src/types/index.ts \
  src/components/cards/TankCard.tsx \
  src/components/cards/__tests__/TankCard.capacity.spec.tsx \
  src/components/ui/__tests__/CapacityMeter.spec.tsx \
  src/pages/tank/TankDetailPage.tsx \
  src/pages/transfer/RecordTransferPage.tsx \
  src/pages/transfer/__tests__/RecordTransferPage.spec.tsx
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/graphql/farm-stock.operations.ts \
  web/apps/aquamobil/src/generated/graphql.ts \
  web/apps/aquamobil/src/hooks/__tests__/useTanks.stock-projection.spec.ts \
  web/apps/aquamobil/src/hooks/__tests__/useTanks-pagination.spec.ts \
  web/apps/aquamobil/src/utils/unit-display.ts \
  web/apps/aquamobil/src/utils/__tests__/unit-display.spec.ts \
  web/apps/aquamobil/src/utils/farm-summary.ts \
  web/apps/aquamobil/src/utils/__tests__/farm-summary.spec.ts \
  web/apps/aquamobil/src/hooks/useTanks.ts \
  web/apps/aquamobil/src/types/index.ts \
  web/apps/aquamobil/src/components/cards/TankCard.tsx \
  web/apps/aquamobil/src/components/cards/__tests__/TankCard.capacity.spec.tsx \
  web/apps/aquamobil/src/components/ui/__tests__/CapacityMeter.spec.tsx \
  web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx \
  web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx \
  web/apps/aquamobil/src/pages/transfer/__tests__/RecordTransferPage.spec.tsx \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): centralize unit and farm display semantics" \
  -m "Use container totals and backend consent evidence consistently across every product surface."
git push
```

---

### Task 7: V2 — Add the in-context mortality, cull, and transfer sheet

**Files:**

- Create: `web/apps/aquamobil/src/components/log-sheet/LogSheet.tsx`
- Create: `web/apps/aquamobil/src/components/log-sheet/index.ts`
- Create: `web/apps/aquamobil/src/components/log-sheet/__tests__/submitBlocker.spec.ts`
- Create: `web/apps/aquamobil/src/components/log-sheet/__tests__/LogSheet.outage.spec.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: V0 `Sheet`, `TypeTile`, `NumPad`, `HoldToConfirm`, V1 `DataState`, V2's validated
  `Tank.currentQuantity`, Task 5's generated `MortalityInput`/`CullInput`/`TransferInput` aliases,
  `QueuedStatusBadge`, `useFeatureAccess().canReach`, and `useOfflineQueue.addToQueue`.
- Produces:

```ts
export type LogSheetType = 'mortality' | 'cull' | 'transfer';

export interface SubmitGateInput {
  type: LogSheetType;
  tank: Tank | undefined;
  qty: string;
  destTankId: string;
  reason: string;
  integer: boolean;
}

export function submitBlocker(input: SubmitGateInput): string | null;

export interface LogSheetProps {
  open: boolean;
  onClose: () => void;
  initialTankId?: string;
  initialType?: LogSheetType;
}

export function LogSheet(props: LogSheetProps): ReactElement | null;
```

- [ ] **Step 1: Write the pure submit-gate tests**

Pin every irreversible-entry condition: unit required, stocked batch required, positive number,
integer fish, mortality/cull reason, transfer destination, destination differs from source, and
count no greater than the validated `tank.currentQuantity` for every stocked unit. A stocked unit
with a zero total rejects every positive entry; zero is not a reason to skip the comparison.

```ts
expect(gate({ qty: '924001', tank: tank({ currentQuantity: 92400 }) })).toBe(
  'Only 92,400 fish in this unit',
);
expect(gate({ qty: '92400', tank: tank({ currentQuantity: 92400 }) })).toBeNull();
expect(gate({ qty: '1', tank: stockedTank({ currentQuantity: 0 }) })).toBe(
  'Only 0 fish in this unit',
);
```

- [ ] **Step 2: Write sheet query and permission tests**

Require a tank-query failure to render “Could not load units,” not “No stocked units.” Require each
type tile to follow `canReach`; with no reachable types render a role explanation. Prove the sheet
never renders a water-quality type, feeding type, or harvest type.

- [ ] **Step 3: Write enqueue and receipt tests**

For each of the three types, assert the exact existing operation and payload shape:

```ts
const { tank: source, batch } = stockedTankFixture({ currentQuantity: 100 });
expect(addToQueue).toHaveBeenCalledWith('recordMortality', {
  batchId: batch.id,
  tankId: source.id,
  quantity: 10,
  reason: 'DISEASE',
  observedAt: expect.any(String),
});
```

Equivalent assertions use `recordCull`/`culledAt` and
`recordTransfer`/`sourceTankId`/`destinationTankId`/`transferredAt`, always taking opaque
identifiers from their fixtures. A fresh queue result says “Saved to device” and renders
`QueuedStatusBadge` for the returned operation id. A duplicate result says “Already recorded.”
Neither branch derives “sent” or “recorded on the server” from `isOnline`.

- [ ] **Step 4: Run tests and observe RED**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/log-sheet/__tests__/submitBlocker.spec.ts \
  src/components/log-sheet/__tests__/LogSheet.outage.spec.tsx
```

Expected: FAIL because the log sheet does not exist.

- [ ] **Step 5: Implement the minimal three-type sheet**

Use one exhaustive metadata record:

```ts
const TYPE_META: Record<LogSheetType, TypeMeta> = {
  mortality: { feature: 'mortality', operation: 'recordMortality', integer: true },
  cull: { feature: 'cull', operation: 'recordCull', integer: true },
  transfer: { feature: 'transfer', operation: 'recordTransfer', integer: true },
};
```

After parsing and integer validation, compare `quantity > tank.currentQuantity` unconditionally. Do
not guard that comparison with `tank.currentQuantity > 0`; Task 6 guarantees a validated number and
a stocked zero-total unit cannot truthfully accept a positive mortality, cull, or transfer count.

Convert `useTanks()` through `toLoadable()` once. Reset form state only when the sheet opens or its
initial context changes. Call the existing queue API and branch exhaustively on
`AddToQueueResult.status`; `QueuedStatusBadge` remains the only sync-state renderer. Do not add
GraphQL documents, direct fetches, queue types, or another mutation registry. Water quality remains
on its equipment-aware generated form; feeding and harvest remain on their full workflows.

- [ ] **Step 6: Verify GREEN, commit, and push**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/log-sheet/__tests__/submitBlocker.spec.ts \
  src/components/log-sheet/__tests__/LogSheet.outage.spec.tsx \
  src/pwa/__tests__/queued-mutation-ssot.spec.ts
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/components/log-sheet/LogSheet.tsx \
  src/components/log-sheet/index.ts \
  src/components/log-sheet/__tests__/submitBlocker.spec.ts \
  src/components/log-sheet/__tests__/LogSheet.outage.spec.tsx
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/components/log-sheet/LogSheet.tsx \
  web/apps/aquamobil/src/components/log-sheet/index.ts \
  web/apps/aquamobil/src/components/log-sheet/__tests__/submitBlocker.spec.ts \
  web/apps/aquamobil/src/components/log-sheet/__tests__/LogSheet.outage.spec.tsx \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): add in-context field logging sheet" \
  -m "Reuse the existing offline command path for fast entries while keeping complex workflows on their full forms."
git push
```

---

### Task 8: V2 — Rebuild Home, unit detail, units, and water-quality surfaces

**Files:**

- Create: `web/apps/aquamobil/src/pages/__tests__/HomePage.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tank/__tests__/TankDetailPage.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tank/__tests__/TankDetailPage.capacity.spec.tsx`
- Create:
  `web/apps/aquamobil/src/pages/water-quality/__tests__/WaterQualityRecordPage.outage.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/HomePage.tsx`
- Modify: `web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/units/UnitsPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: Tasks 1–7, V0 semantic primitives, existing alert/task/live-reading hooks, and current
  feature access.
- Produces no new server or queue interface. It exposes `LogSheet` entry points from Home, Units,
  and Tank Detail.

- [ ] **Step 1: Write outage-first page tests**

For each page, reject its primary query and assert unavailable copy plus retry. On Home, reject
inventory, alert, and task reads independently so a failed source cannot zero only its own section
or hide valid siblings. Explicitly reject these false claims:

```tsx
expect(screen.queryByText(/0 fish/i)).not.toBeInTheDocument();
expect(screen.queryByText(/capacity ok/i)).not.toBeInTheDocument();
expect(screen.queryByText(/unit not found/i)).not.toBeInTheDocument();
expect(screen.queryByText(/no parameters configured/i)).not.toBeInTheDocument();
```

Then supply successful empty data and require the corresponding genuine empty/not-found state. The
same user-visible copy cannot represent both outcomes.

- [ ] **Step 2: Write capacity and entry-point tests**

Require Tank Detail and Units to use `unitStatusMeta`, show nullable density/capacity as `—`, show
advisory watch/density labels, and mark backend `isOverCapacity` as the consent condition even below
a local percentage. Require Home and Tank Detail fast actions to open `LogSheet` with the intended
unit/type. Feeding, harvest, and water quality actions navigate to their full pages.

- [ ] **Step 3: Run page tests and observe RED**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/__tests__/HomePage.outage.spec.tsx \
  src/pages/tank/__tests__/TankDetailPage.outage.spec.tsx \
  src/pages/tank/__tests__/TankDetailPage.capacity.spec.tsx \
  src/pages/units/__tests__/UnitsPage.outage.spec.tsx \
  src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx \
  src/pages/water-quality/__tests__/WaterQualityRecordPage.outage.spec.tsx
```

Expected: FAIL on the current fallback zeroes, page-local status mappings, missing log sheet entry
points, and water parameter/equipment error states.

- [ ] **Step 4: Rebuild Home around ready data**

Call `farmSummary` only inside `DataState`'s ready render. Keep alarms/tasks ahead of informational
summary rows. A query failure gets its own card and cannot feed KPI values. Fast actions use typed
state:

```ts
const [logContext, setLogContext] = useState<{
  tankId?: string;
  type?: LogSheetType;
} | null>(null);
```

- [ ] **Step 5: Rebuild unit list/detail from shared helpers**

Delete page-local status maps and grouping/formatting copies. Tank Detail derives the selected tank
only after a ready inventory result; ready data without the route id renders “Unit not found,” while
error renders the shared unavailable state. Use `currentQuantity` and `currentBiomass` for totals.

- [ ] **Step 6: Move both WQ queries through the shared state renderer**

Equipment list and selected equipment parameter queries each pass through `toLoadable`/`DataState`.
A successful empty parameter list says no parameters are configured; a parameter query failure says
parameters could not be loaded. Preserve the generated documents and input from Task 5.

- [ ] **Step 7: Verify the complete V2 slice**

```bash
npm run apollo-router:compose
npm run codegen:check
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useTanks.stock-projection.spec.ts \
  src/utils/__tests__/farm-summary.spec.ts \
  src/utils/__tests__/unit-display.spec.ts \
  src/components/log-sheet/__tests__/submitBlocker.spec.ts \
  src/components/log-sheet/__tests__/LogSheet.outage.spec.tsx \
  src/pages/__tests__/HomePage.outage.spec.tsx \
  src/pages/tank/__tests__/TankDetailPage.outage.spec.tsx \
  src/pages/tank/__tests__/TankDetailPage.capacity.spec.tsx \
  src/pages/units/__tests__/UnitsPage.outage.spec.tsx \
  src/pages/water-quality/__tests__/WaterQualityRecordPage.queue-status.spec.tsx \
  src/pages/water-quality/__tests__/WaterQualityRecordPage.outage.spec.tsx \
  src/pwa/__tests__/queued-mutation-ssot.spec.ts
npm exec -- jest --config tests/invariants/jest.config.ts \
  --selectProjects layer-1 --runInBand --runTestsByPath \
  tests/invariants/aquamobil-generated-input-authority.spec.ts
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm --prefix web/apps/aquamobil exec -- eslint \
  src/pages/HomePage.tsx \
  src/pages/__tests__/HomePage.outage.spec.tsx \
  src/pages/tank/TankDetailPage.tsx \
  src/pages/tank/__tests__/TankDetailPage.outage.spec.tsx \
  src/pages/tank/__tests__/TankDetailPage.capacity.spec.tsx \
  src/pages/units/UnitsPage.tsx \
  src/pages/water-quality/WaterQualityRecordPage.tsx \
  src/pages/water-quality/__tests__/WaterQualityRecordPage.outage.spec.tsx
```

Expected: PASS with generated artifacts fresh and no false all-clear on any failed query.

- [ ] **Step 8: Classify production dependencies for the V2 PR**

Run the complete Production Dependency Checkpoint with `v4_product_slice=V2`. Require its fixed
directory to be uploaded by the V2 PR workflow and captured by the program as repository-bound
boundary evidence. Any missing proof, unclassified path, or affected-and-reachable high/critical
path blocks the V2 PR; do not edit the immutable preflight or central ledger.

- [ ] **Step 9: Commit the page integration and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/pages/HomePage.tsx \
  web/apps/aquamobil/src/pages/__tests__/HomePage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx \
  web/apps/aquamobil/src/pages/tank/__tests__/TankDetailPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/tank/__tests__/TankDetailPage.capacity.spec.tsx \
  web/apps/aquamobil/src/pages/units/UnitsPage.tsx \
  web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx \
  web/apps/aquamobil/src/pages/water-quality/__tests__/WaterQualityRecordPage.outage.spec.tsx \
  tools/quality/format-scope.json
slice_finding_id="$(jq -sre --arg title 'AquaMobil queued writes have duplicate handwritten GraphQL input authority' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$slice_finding_id" =~ ^[A-Z][A-Z0-9-]*-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): rebuild core field workflows" \
  -m "Prioritize real farm state and in-context entry without turning outages into clean summaries." \
  -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md#$slice_finding_id"
npx nx affected --target=lint --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=test --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=build --base=origin/main --head=HEAD --skip-nx-cache
git push
```

---

### Task 9: V3 — Move the messaging component vocabulary onto V0 primitives

**Files:**

- Create: `web/apps/aquamobil/src/components/messaging/__tests__/semantic-components.spec.tsx`
- Create: `docs/superpowers/evidence/aquamobil-v4/slices/V3/preflight.json` through the program
  capture tool
- Modify: `web/apps/aquamobil/src/components/messaging/AiActionCard.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/AiTypingIndicator.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/AttachmentPicker.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/ChannelAvatar.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/ChannelListItem.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/ConfirmDialog.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/EmptyChat.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/ForwardModal.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/ImagePreview.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/MemberRow.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/MentionPicker.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/MessageBubble.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/MessageDateSeparator.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/MessageInput.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/ReadReceipt.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/SentimentBadge.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/SystemMessage.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/TypingIndicator.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/UnreadBadge.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/VoicePlayer.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/VoiceRecorder.tsx`
- Modify: `web/apps/aquamobil/src/components/messaging/index.ts`
- Modify: `web/apps/aquamobil/src/components/messaging/__tests__/AttachmentPicker.spec.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: V0 `Button`, `Card`, `Chip`, `EmptyState`, `IconButton`, `ListRow`, `Sheet`, `Skeleton`,
  `StatusDot`, and semantic token classes.
- Preserves every current exported messaging prop and callback contract, including
  `ChannelListItem.onPress(channelId)`, `MessageInput.onSend`, attachment retry/removal, recording
  cancellation, forwarding, edit/delete confirmation, delivery receipts, and `MessageBubble`
  interaction callbacks.
- Produces no messaging hook, query, cache key, socket listener, GraphQL document, offline blob
  path, or alternate component library.

- [ ] **Step 0: Verify the coordinator-created V3 worktree from reconciled V2**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
v4_preflight='docs/superpowers/evidence/aquamobil-v4/slices/V3/preflight.json'
test "$(git branch --show-current)" = 'feat/aquamobil-v3-messaging-surfaces'
test -f "$v4_preflight"
test "$(git rev-parse HEAD)" = "$(jq -r '.baseMainCommit' "$v4_preflight")"
git merge-base --is-ancestor "$(jq -r '.baseMainCommit' "$v4_preflight")" origin/main
git show origin/main:docs/superpowers/evidence/aquamobil-v4/slices/V2/merge.json |
  jq -e '.slice == "V2" and [.implementationBoundaries[].boundaryId] == ["field-workflows"]'
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice V3 \
  --check "$v4_preflight" \
  --main-ref origin/main
```

Expected: the coordinator created V3 only after V2 reconciliation, so its immutable preflight and
branch HEAD bind the same creation-time V2-reconciled main base, which remains an ancestor of
current `origin/main`. Later zero-overlap advances proceed only through the prospective-PR and
latest merge-queue checks. Otherwise stop before editing messaging presentation.

- [ ] **Step 1: Audit current-main behavior before touching presentation**

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
git log --oneline HEAD..origin/main -- web/apps/aquamobil/src/components/messaging
git diff --stat origin/main...origin/feature/aquamobil-v4-redesign -- web/apps/aquamobil/src/components/messaging
rg -n "use(Query|Mutation)|queryKey|graphqlRequest|socket|addToQueue|cacheUserData" \
  web/apps/aquamobil/src/components/messaging
```

Require the V3 preflight to contain the overlap and authority decision. If current main has changed
a callback, accessibility fix, or media behavior, retain it and use the source commits only to
recover the semantic presentation intent; do not edit the central ledger.

- [ ] **Step 2: Write the shared semantic behavior test first**

In `semantic-components.spec.tsx`, render the public components with typed local builders that
supply their own opaque ids and prove:

```ts
it('names sent, delivered, and read states without relying on colour', () => {
  /* ReadReceipt */
});
it('renders sentiment and AI-advisory meaning as visible text', () => {
  /* badges and card */
});
it('caps a large unread count at 99+ and exposes the full count accessibly', () => {
  /* badge */
});
it('passes the selected channel id through the full-size channel row', () => {
  /* list row */
});
it('keeps destructive confirmation and attachment removal keyboard reachable', () => {
  /* dialogs */
});
```

Keep `AttachmentPicker.spec.tsx` assertions for file acceptance, rejection, preview removal, and
retry. Add an assertion that every icon-only action has an accessible name.

- [ ] **Step 3: Run the tests and observe RED**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/messaging/__tests__/semantic-components.spec.tsx \
  src/components/messaging/__tests__/AttachmentPicker.spec.tsx
```

Expected: FAIL because the current components still communicate several receipt, sentiment, and
selection states through legacy colour/size styling and do not consistently use the V0 interaction
contracts.

- [ ] **Step 4: Perform the minimal component-only GREEN migration**

Use the smallest V0 primitive that matches each existing role:

- action surfaces use `Button` or `IconButton` and retain their existing callback parameters;
- channel/member rows use `ListRow` or the same button semantics with `min-h-touch`;
- confirmations and forwarding use `Sheet`/`Card` without changing dismissal or mutation timing;
- unread, receipt, online, AI, and sentiment states pair `Chip`/`StatusDot` tone with visible or
  accessible words;
- attachment, image, voice, and message components retain current MIME validation, object-URL
  cleanup, playback, recording, optimistic status, and retry behavior;
- `MessageBubble` retains the current sender/recipient split, reply/edit/delete/forward actions,
  attachment rendering, and receipt semantics. Do not move it into a second message renderer.

Do not edit any hook or transport file in this task. Export the same public names from
`components/messaging/index.ts`.

- [ ] **Step 5: Verify V3 component behavior and affected lint**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/messaging/__tests__/semantic-components.spec.tsx \
  src/components/messaging/__tests__/AttachmentPicker.spec.tsx
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/components/messaging/*.tsx \
  src/components/messaging/__tests__/semantic-components.spec.tsx \
  src/components/messaging/__tests__/AttachmentPicker.spec.tsx \
  src/components/messaging/index.ts
```

Expected: PASS; all existing interaction callbacks still fire, semantic meaning is readable without
colour, and no data boundary changed.

- [ ] **Step 6: Commit the component vocabulary and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/components/messaging/AiActionCard.tsx \
  web/apps/aquamobil/src/components/messaging/AiTypingIndicator.tsx \
  web/apps/aquamobil/src/components/messaging/AttachmentPicker.tsx \
  web/apps/aquamobil/src/components/messaging/ChannelAvatar.tsx \
  web/apps/aquamobil/src/components/messaging/ChannelListItem.tsx \
  web/apps/aquamobil/src/components/messaging/ConfirmDialog.tsx \
  web/apps/aquamobil/src/components/messaging/EmptyChat.tsx \
  web/apps/aquamobil/src/components/messaging/ForwardModal.tsx \
  web/apps/aquamobil/src/components/messaging/ImagePreview.tsx \
  web/apps/aquamobil/src/components/messaging/MemberRow.tsx \
  web/apps/aquamobil/src/components/messaging/MentionPicker.tsx \
  web/apps/aquamobil/src/components/messaging/MessageBubble.tsx \
  web/apps/aquamobil/src/components/messaging/MessageDateSeparator.tsx \
  web/apps/aquamobil/src/components/messaging/MessageInput.tsx \
  web/apps/aquamobil/src/components/messaging/ReadReceipt.tsx \
  web/apps/aquamobil/src/components/messaging/SentimentBadge.tsx \
  web/apps/aquamobil/src/components/messaging/SystemMessage.tsx \
  web/apps/aquamobil/src/components/messaging/TypingIndicator.tsx \
  web/apps/aquamobil/src/components/messaging/UnreadBadge.tsx \
  web/apps/aquamobil/src/components/messaging/VoicePlayer.tsx \
  web/apps/aquamobil/src/components/messaging/VoiceRecorder.tsx \
  web/apps/aquamobil/src/components/messaging/index.ts \
  web/apps/aquamobil/src/components/messaging/__tests__/semantic-components.spec.tsx \
  web/apps/aquamobil/src/components/messaging/__tests__/AttachmentPicker.spec.tsx \
  docs/superpowers/evidence/aquamobil-v4/slices/V3/preflight.json \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): converge messaging components on shared primitives" \
  -m "Preserve message behavior while making status, touch, and accessibility semantics explicit."
git push
```

---

### Task 10: V3 — Rebuild messaging pages and reusable information cards truthfully

**Files:**

- Create: `web/apps/aquamobil/src/components/__tests__/information-state-semantics.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx`
- Modify: `web/apps/aquamobil/src/components/AlertsBell.tsx`
- Modify: `web/apps/aquamobil/src/components/CriticalAlertBanner.tsx`
- Modify: `web/apps/aquamobil/src/components/DataFreshness.tsx`
- Modify: `web/apps/aquamobil/src/components/LiveReadingsCard.tsx`
- Modify: `web/apps/aquamobil/src/components/NotificationBell.tsx`
- Modify: `web/apps/aquamobil/src/components/QueuedStatusBadge.tsx`
- Modify: `web/apps/aquamobil/src/components/__tests__/DataFreshness.spec.tsx`
- Modify: `web/apps/aquamobil/src/components/ai/AiInsightsCard.tsx`
- Modify: `web/apps/aquamobil/src/components/ai/FeedingAdviceCard.tsx`
- Modify: `web/apps/aquamobil/src/components/ai/GrowthPredictionCard.tsx`
- Modify: `web/apps/aquamobil/src/components/ai/TankRiskBadge.tsx`
- Modify: `web/apps/aquamobil/src/components/cards/TankCard.tsx`
- Modify: `web/apps/aquamobil/src/components/cards/TaskCard.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/AiChatPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/ChannelSettingsPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/NewChatPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/__tests__/ChatRoomPage-attachment-retry.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/__tests__/MediaViewerPage.spec.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes the current `useChannels`, `useChannelDetail`, `useMessages`, `useMessageSocket`,
  `useAiChat`, presence, read-cursor, media, and offline-upload contracts unchanged.
- Adapts their existing `error: Error | null` returns into V1 `Loadable<T>` at the page boundary:

```ts
const channelsView = toLoadable<Channel[]>({
  data: channels,
  isLoading,
  isError: error !== null,
  error: error ?? undefined,
  refetch,
});
```

- Produces semantic card/page markup only. It does not create another channel array, message cache,
  socket subscription, optimistic write lane, or message renderer. `ChatThread` extraction remains a
  V5 task.

- [ ] **Step 1: Lock the current message data boundaries without advancing V3's immutable base**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
git show origin/main:docs/superpowers/evidence/aquamobil-v4/slices/V2/merge.json |
  jq -e '.slice == "V2" and [.implementationBoundaries[].boundaryId] == ["field-workflows"]'
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
git log --oneline HEAD..origin/main -- \
  web/apps/aquamobil/src/pages/messaging \
  web/apps/aquamobil/src/components/AlertsBell.tsx \
  web/apps/aquamobil/src/components/CriticalAlertBanner.tsx \
  web/apps/aquamobil/src/components/DataFreshness.tsx \
  web/apps/aquamobil/src/components/LiveReadingsCard.tsx \
  web/apps/aquamobil/src/components/NotificationBell.tsx \
  web/apps/aquamobil/src/components/QueuedStatusBadge.tsx \
  web/apps/aquamobil/src/components/ai \
  web/apps/aquamobil/src/components/cards
git diff --stat origin/main...origin/feature/aquamobil-v4-redesign -- \
  web/apps/aquamobil/src/pages/messaging \
  web/apps/aquamobil/src/components
```

The branch already descends from reconciled V2; do not merge a later sibling result into the
implementation branch or rewrite its immutable preflight. Record overlaps there, then list and
preserve the exact query keys, `useMessageSocket` ownership, optimistic mutation callbacks,
notification-reference resolution, per-user IndexedDB namespaces, offline binary lane, object-URL
cleanup, and attachment retry behavior.

- [ ] **Step 2: Write RED outage tests for the channel list and chat room**

`ChannelListPage.outage.spec.tsx` drives `useChannels` through loading, error, successful empty, and
successful non-empty states. The error case must render “conversations unavailable” with retry and
must not render “No conversations yet.”

`ChatRoomPage.outage.spec.tsx` drives channel detail and message history independently. It proves a
failed channel lookup does not become an unnamed channel and failed message history does not become
“No messages yet.” It also proves cached messages are hidden when the associated query reports an
error.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx
```

Expected: FAIL because the current pages derive rows from default empty arrays and do not route each
ordinary query through `DataState`.

- [ ] **Step 3: Write RED information-card semantics**

In `information-state-semantics.spec.tsx`, prove that alert, notification, freshness, queued-write,
live-reading, AI insight, feeding advice, growth prediction, risk, tank, and task cards pair every
warning/critical/advisory tone with words, preserve action labels, and never describe model output
as a command. For each query-owning live-reading/AI card, reject the query and require unavailable
copy rather than a missing card; a successful ready-null advisory may remain absent.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/__tests__/information-state-semantics.spec.tsx \
  src/components/__tests__/DataFreshness.spec.tsx
```

Expected: FAIL on the legacy visual structure and colour-only state assertions.

- [ ] **Step 4: Implement truthful page state with no transport edits**

- `ChannelListPage` converts the one existing channel hook result to `Loadable<Channel[]>`;
  filtering, sorting, virtual rows, notification-reference routing, refresh, and pagination occur
  only in the ready arm.
- `ChatRoomPage` independently converts channel detail and message history to `Loadable`; it retains
  the existing composer, optimistic send, pagination, read cursor, receipts, attachment/voice
  behavior, edit/delete/forward paths, and socket ownership.
- `ChannelSettingsPage`, `MediaViewerPage`, and `AiChatPage` use `DataState` for their ordinary
  query results and keep mutation failures distinct from query failures.
- `NewChatPage` retains membership/creation validation and uses semantic controls without changing
  its generated request or navigation target.
- A successful empty list may render a domain empty message. A failed query may render only
  unavailable/retry content for that query.

- [ ] **Step 5: Migrate reusable cards without changing their data contracts**

Replace legacy palettes and one-off containers with V0 primitives. Any card that calls an ordinary
query hook converts that result to `Loadable` and renders it through `DataState`; do not keep an
`isError || !data` branch that makes query failure indistinguishable from ready-null. Keep
`DataFreshness` timestamps and stale thresholds, `QueuedStatusBadge` device/server distinction,
alarm persistence, AI consent/advisory copy, task/tank navigation, nullable live readings, and all
existing prop types. Do not synthesize a reading, count, freshness claim, or recommendation when its
prop is absent.

- [ ] **Step 6: Run focused V3 tests and affected lint**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/messaging/__tests__/semantic-components.spec.tsx \
  src/components/messaging/__tests__/AttachmentPicker.spec.tsx \
  src/components/__tests__/information-state-semantics.spec.tsx \
  src/components/__tests__/DataFreshness.spec.tsx \
  src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage-attachment-retry.spec.tsx \
  src/pages/messaging/__tests__/MediaViewerPage.spec.tsx
npm --prefix web/apps/aquamobil exec -- eslint \
  src/components/AlertsBell.tsx \
  src/components/CriticalAlertBanner.tsx \
  src/components/DataFreshness.tsx \
  src/components/LiveReadingsCard.tsx \
  src/components/NotificationBell.tsx \
  src/components/QueuedStatusBadge.tsx \
  src/components/__tests__/information-state-semantics.spec.tsx \
  src/components/__tests__/DataFreshness.spec.tsx \
  src/components/ai/*.tsx \
  src/components/cards/*.tsx \
  src/pages/messaging/*.tsx \
  src/pages/messaging/__tests__/*.spec.tsx
```

Expected: PASS with the current transport/cache behavior intact and explicit failure copy on both
list and detail screens.

- [ ] **Step 7: Verify the complete V3 slice**

```bash
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/query-error-surface.invariant.spec.ts \
  src/__tests__/route-reachability.invariant.spec.ts \
  src/__tests__/design-token.invariant.spec.ts \
  src/__tests__/field-ergonomics.invariant.spec.ts
```

Expected: PASS. No query failure is presented as an empty conversation, and no message/offline
regression is introduced.

- [ ] **Step 8: Classify production dependencies for the V3 PR**

Run the complete Production Dependency Checkpoint with `v4_product_slice=V3`. Require its fixed
directory to be uploaded by the V3 PR workflow and captured by the program as repository-bound
boundary evidence. Stop for any missing proof, unclassified path, or affected-and-reachable
high/critical path; do not edit the immutable preflight or central ledger.

- [ ] **Step 9: Commit the V3 page/card slice and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/components/AlertsBell.tsx \
  web/apps/aquamobil/src/components/CriticalAlertBanner.tsx \
  web/apps/aquamobil/src/components/DataFreshness.tsx \
  web/apps/aquamobil/src/components/LiveReadingsCard.tsx \
  web/apps/aquamobil/src/components/NotificationBell.tsx \
  web/apps/aquamobil/src/components/QueuedStatusBadge.tsx \
  web/apps/aquamobil/src/components/__tests__/information-state-semantics.spec.tsx \
  web/apps/aquamobil/src/components/__tests__/DataFreshness.spec.tsx \
  web/apps/aquamobil/src/components/ai/AiInsightsCard.tsx \
  web/apps/aquamobil/src/components/ai/FeedingAdviceCard.tsx \
  web/apps/aquamobil/src/components/ai/GrowthPredictionCard.tsx \
  web/apps/aquamobil/src/components/ai/TankRiskBadge.tsx \
  web/apps/aquamobil/src/components/cards/TankCard.tsx \
  web/apps/aquamobil/src/components/cards/TaskCard.tsx \
  web/apps/aquamobil/src/pages/messaging/AiChatPage.tsx \
  web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx \
  web/apps/aquamobil/src/pages/messaging/ChannelSettingsPage.tsx \
  web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx \
  web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx \
  web/apps/aquamobil/src/pages/messaging/NewChatPage.tsx \
  web/apps/aquamobil/src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/messaging/__tests__/ChatRoomPage-attachment-retry.spec.tsx \
  web/apps/aquamobil/src/pages/messaging/__tests__/MediaViewerPage.spec.tsx \
  tools/quality/format-scope.json
slice_finding_id="$(jq -sre --arg title 'AquaMobil messaging surfaces lack one semantic state vocabulary' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$slice_finding_id" =~ ^[A-Z][A-Z0-9-]*-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): rebuild messaging and information surfaces" \
  -m "Converge the pages on semantic primitives while preserving transport and truthful failures." \
  -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md#$slice_finding_id"
npx nx affected --target=lint --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=test --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=build --base=origin/main --head=HEAD --skip-nx-cache
git push
```

---

### Task 11: V4 — Unite farm summary and regulatory work at `/reports`

**Files:**

- Create: `web/apps/aquamobil/src/hooks/useReportDeadlines.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useReportDeadlines.spec.tsx`
- Create: `web/apps/aquamobil/src/utils/report-deadline-display.ts`
- Create: `web/apps/aquamobil/src/utils/__tests__/report-deadline-display.spec.ts`
- Create: `web/apps/aquamobil/src/pages/reports/ReportsPage.tsx`
- Create: `web/apps/aquamobil/src/pages/reports/__tests__/ReportsPage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/reports/__tests__/ReportsPage.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/reports/__tests__/ReportReviewPage.outage.spec.tsx`
- Create: `docs/superpowers/evidence/aquamobil-v4/slices/V4/preflight.json` through the program
  capture tool
- Modify: `web/apps/aquamobil/src/pages/reports/ReportReviewPage.tsx`
- Modify: `web/apps/aquamobil/src/App.tsx`
- Modify: `web/apps/aquamobil/src/layouts/MobileLayout.tsx`
- Delete: `web/apps/aquamobil/src/pages/reports/ReportsDuePage.tsx`
- Delete: `web/apps/aquamobil/src/pages/reports/__tests__/ReportsDuePage.spec.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes the existing `MOBILE_REPORT_DEADLINES`, `MOBILE_REPORT_DRAFTS`, and approval documents,
  generated types, `graphqlRequest`, `createTenantQueryKey`, `useTanks`, V2 `farmSummary`,
  `useNetworkStatus`, and `useFeatureAccess`.
- Produces:

```ts
export type ReportDeadline = MobileReportDeadlinesQuery['reportDeadlines'][number];

export function useReportDeadlines(): UseQueryResult<ReportDeadline[], Error>;

export type DeadlineTone = 'crit' | 'warn' | 'neutral';
export interface DeadlineLabel {
  text: string;
  tone: DeadlineTone;
}
export function reportTypeLabel(row: ReportDeadline): string;
export function periodLabel(row: ReportDeadline): string;
export function dueLabel(row: ReportDeadline): DeadlineLabel;
```

- The hook owns one tenant-aware `reportDeadlines` query, ordered overdue-first then by earliest
  non-null due date. It is enabled only when authenticated, tenant-scoped, online, and
  `canReach('reports')` is true.
- The phone Reports page consumes that hook and `useTanks`; the later tablet Reports page reuses
  both. Neither page owns a duplicate query or report-label table.

- [ ] **Step 0: Verify the coordinator-created V4 worktree from reconciled V2**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
v4_preflight='docs/superpowers/evidence/aquamobil-v4/slices/V4/preflight.json'
test "$(git branch --show-current)" = 'feat/aquamobil-v4-report-surfaces'
test -f "$v4_preflight"
test "$(git rev-parse HEAD)" = "$(jq -r '.baseMainCommit' "$v4_preflight")"
git merge-base --is-ancestor "$(jq -r '.baseMainCommit' "$v4_preflight")" origin/main
git show origin/main:docs/superpowers/evidence/aquamobil-v4/slices/V2/merge.json |
  jq -e '.slice == "V2" and [.implementationBoundaries[].boundaryId] == ["field-workflows"]'
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice V4 \
  --check "$v4_preflight" \
  --main-ref origin/main
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
```

Expected: the coordinator created V4 only after V2 reconciliation, so its immutable preflight and
branch HEAD bind the same creation-time V2-reconciled main base, which remains an ancestor of
current `origin/main`. Later zero-overlap advances proceed only through the prospective-PR and
latest merge-queue checks. Otherwise stop before changing report routes or regenerating the client.

- [ ] **Step 1: Audit the active report contract and route overlap**

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
git log --oneline HEAD..origin/main -- \
  web/apps/aquamobil/src/App.tsx \
  web/apps/aquamobil/src/layouts/MobileLayout.tsx \
  web/apps/aquamobil/src/pages/reports \
  web/apps/aquamobil/src/graphql/operations.ts \
  web/apps/aquamobil/src/generated/graphql.ts
rg -n "MOBILE_REPORT_(DEADLINES|DRAFTS)|reportDeadlines|reportDrafts" \
  web/apps/aquamobil/src/graphql/operations.ts \
  web/apps/aquamobil/src/generated/graphql.ts \
  web/apps/aquamobil/src/pages/reports
```

Record overlap. Preserve current authorization, approval mutation, invalidations, generated fields,
and online-only filing rule. This task moves the existing document into a shared hook; it does not
add a report query or change the server contract.

- [ ] **Step 2: Write RED hook and display-contract tests**

`useReportDeadlines.spec.tsx` proves all four enablement gates, tenant-key construction, one fetch
for an enabled render, error propagation, retry, and overdue/soonest ordering. Use a typed local
`reportDeadlineFixture()` whose return type is `ReportDeadline`, rather than an untyped hand-shaped
wire object.

`report-deadline-display.spec.ts` proves known labels, raw-enum fallback, weekly/monthly/year
periods, overdue text, near-due text, scheduled text, and unscheduled text. Every non-neutral tone
must travel with a visible urgency word.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useReportDeadlines.spec.tsx \
  src/utils/__tests__/report-deadline-display.spec.ts
```

Expected: FAIL because the hook and shared display vocabulary do not exist.

- [ ] **Step 3: Implement the shared query and display vocabulary**

Use the existing generated operation and keep the query raw:

```ts
export function useReportDeadlines(): UseQueryResult<ReportDeadline[], Error> {
  const { tenantId, isAuthenticated } = useAuth();
  const isOnline = useNetworkStatus();
  const { canReach } = useFeatureAccess();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'reportDeadlines'),
    queryFn: async () => {
      const result = await graphqlRequest<MobileReportDeadlinesQuery>(MOBILE_REPORT_DEADLINES, {});
      return byUrgency(result.reportDeadlines);
    },
    enabled: isAuthenticated && Boolean(tenantId) && isOnline && canReach('reports'),
    staleTime: 60_000,
  });
}
```

Keep the sort helper private and keep display fallback honest: an unknown `reportType` renders its
raw value rather than a generic label.

- [ ] **Step 4: Write RED phone Reports tests**

`ReportsPage.spec.tsx` proves:

- a module user reaches `/reports`, sees the farm summary, and gets no regulatory section or
  deadline fetch;
- a manager sees the regulatory queue in urgency order;
- offline mode retains a ready farm summary, says submissions require a connection, and does not
  fetch deadlines;
- the backend `batchMetrics.isOverCapacity` decides the consent warning while `capacityUsedPercent`
  only orders/advises;
- nullable density/capacity renders as unavailable, never numeric zero.

`ReportsPage.outage.spec.tsx` proves independently that a failed tank query says farm summary
unavailable and cannot render “Nothing stocked,” while a failed deadline query says deadlines
unavailable and cannot render “No reports due.”

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/reports/__tests__/ReportsPage.spec.tsx \
  src/pages/reports/__tests__/ReportsPage.outage.spec.tsx
```

Expected: FAIL because `ReportsPage` does not exist and `/reports` still renders the regulated-only
screen.

- [ ] **Step 5: Build the two-section phone destination through `DataState`**

The farm section uses `toLoadable(useTanks())`; `farmSummary(tanks)` is called only inside its ready
arm. A ready empty tenant and a ready tenant with no stocked batches get distinct truthful messages.

The regulatory section checks offline before rendering query state, because the disabled query must
not become an endless loading skeleton. Online, it uses `toLoadable(useReportDeadlines())`. Only its
ready empty arm may say “No reports due.” A module user gets the farm section without an
unauthorized empty regulatory column.

Keep the explicit sentence that trend charts are absent because the mobile client has no history
query. Do not derive a series from snapshot inventory, weekly counts, or a prediction.

- [ ] **Step 6: Write RED regulated-review outage coverage**

`ReportReviewPage.outage.spec.tsx` proves that loading renders skeletons, query failure renders
unavailable/retry, successful absence renders “Draft not found,” and a successful matching draft
renders the review. It must also prove that stale draft data is not rendered while `isError` is
true. Its offline case proves the disabled query renders the explicit reconnect-to-review state
before `DataState`, performs no deadline/draft request, renders no skeleton, and does not expose a
cached draft as current review data.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/reports/__tests__/ReportReviewPage.outage.spec.tsx
```

Expected: FAIL because the current page branches around the query result and may render nothing or
retain draft content outside the query-state authority.

- [ ] **Step 7: Put all review content inside the ready arm**

Check `isOnline` before converting `draftsQuery`; the offline arm says reconnect to review and
submit, mounts neither `DataState` nor draft content, and cannot become a loading skeleton merely
because the query is disabled. Online, convert `draftsQuery` with `toLoadable`. Use
`isEmpty={(rows) => !rows.some((row) => row.id === draftId)}` and find/render the draft inside the
`DataState` child function. Keep the assembled payload read-only, field provenance, blocking
validation, online-only approval, and the two existing tenant-aware invalidations. Mutation
pending/error/success remains domain state and must not be folded into query state.

- [ ] **Step 8: Activate the route and delete the displaced page atomically**

Change the lazy import and `/reports` element from `ReportsDuePage` to `ReportsPage`. Remove the
`FeatureRoute feature="reports"` wrapper from only `/reports`, and remove `features: ['reports']`
from only the Reports dock item, because the farm summary is baseline field data. Keep
`/reports/:draftId` behind its current `FeatureRoute`; the regulatory section and review remain
manager-only. Delete `ReportsDuePage.tsx` and its test in this same commit so there is one Reports
destination, not two competing implementations.

- [ ] **Step 9: Verify Reports GREEN and generated freshness**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useReportDeadlines.spec.tsx \
  src/utils/__tests__/report-deadline-display.spec.ts \
  src/pages/reports/__tests__/ReportsPage.spec.tsx \
  src/pages/reports/__tests__/ReportsPage.outage.spec.tsx \
  src/pages/reports/__tests__/ReportReviewPage.outage.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/route-reachability.invariant.spec.ts \
  src/__tests__/query-error-surface.invariant.spec.ts
npm run apollo-router:compose
npm run codegen:check
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/hooks/useReportDeadlines.ts \
  src/hooks/__tests__/useReportDeadlines.spec.tsx \
  src/utils/report-deadline-display.ts \
  src/utils/__tests__/report-deadline-display.spec.ts \
  src/pages/reports/ReportsPage.tsx \
  src/pages/reports/ReportReviewPage.tsx \
  src/pages/reports/__tests__/ReportsPage.spec.tsx \
  src/pages/reports/__tests__/ReportsPage.outage.spec.tsx \
  src/pages/reports/__tests__/ReportReviewPage.outage.spec.tsx \
  src/App.tsx \
  src/layouts/MobileLayout.tsx
```

Expected: PASS with a single deadline query authority, truthful independent outages, and unchanged
generated artifacts.

- [ ] **Step 10: Commit Reports and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/hooks/useReportDeadlines.ts \
  web/apps/aquamobil/src/hooks/__tests__/useReportDeadlines.spec.tsx \
  web/apps/aquamobil/src/utils/report-deadline-display.ts \
  web/apps/aquamobil/src/utils/__tests__/report-deadline-display.spec.ts \
  web/apps/aquamobil/src/pages/reports/ReportsPage.tsx \
  web/apps/aquamobil/src/pages/reports/ReportReviewPage.tsx \
  web/apps/aquamobil/src/pages/reports/__tests__/ReportsPage.spec.tsx \
  web/apps/aquamobil/src/pages/reports/__tests__/ReportsPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/reports/__tests__/ReportReviewPage.outage.spec.tsx \
  web/apps/aquamobil/src/App.tsx \
  web/apps/aquamobil/src/layouts/MobileLayout.tsx \
  docs/superpowers/evidence/aquamobil-v4/slices/V4/preflight.json \
  tools/quality/format-scope.json
git add -u -- \
  web/apps/aquamobil/src/pages/reports/ReportsDuePage.tsx \
  web/apps/aquamobil/src/pages/reports/__tests__/ReportsDuePage.spec.tsx
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): unite farm and regulatory reports" \
  -m "Share one deadline query and keep snapshot, outage, and filing states explicit."
git push
```

---

### Task 12: V4 — Preserve outage semantics across warehouse reads

**Files:**

- Create: `web/apps/aquamobil/src/graphql/storage.operations.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useWarehouseSummary.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/storage/__tests__/StorageHubPage.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/storage/__tests__/StockMovementPage.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/storage/__tests__/StockTransferPage.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/storage/__tests__/StockViewPage.outage.spec.tsx`
- Modify: `web/apps/aquamobil/src/generated/graphql.ts` through `npm run codegen`
- Modify: `web/apps/aquamobil/src/hooks/useWarehouseSummary.ts`
- Modify: `web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/storage/StockViewPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx`
- Modify: `web/apps/aquamobil/src/pwa/__tests__/queued-mutation-ssot.spec.ts`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes the existing generated `GET_WAREHOUSE_SUMMARY`, V2's single-source queued mutation
  documents, tenant query keys, tenant-isolated IndexedDB fallback, storage mutation/queue paths,
  and `WarehouseSummary` domain type unchanged. Task 12 moves only the page-local storage
  item/location/stock queries to one generated query module; online stock mutations import the
  `Queued...Document` already generated from V2's sole replay source. It does not create a second
  mutation text, read model, or replay registry.
- Replaces the zero-filled hook view with its raw query contract:

```ts
export function useWarehouseSummary(): UseQueryResult<WarehouseSummary, Error>;
```

- A recoverable network failure with a runtime-valid tenant cache remains a successful ready result.
  A GraphQL/contract failure never falls back to cache; a network failure with no valid cache
  remains the error arm. No consumer receives `DEFAULT_SUMMARY`, and no page owns another warehouse
  summary object.

- [ ] **Step 1: Audit warehouse keys, fallbacks, and write lanes**

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
git log --oneline HEAD..origin/main -- \
  web/apps/aquamobil/src/hooks/useWarehouseSummary.ts \
  web/apps/aquamobil/src/pages/storage \
  web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx
rg -n "queryKey|cache(Data|UserData)|getCached|addToQueue|invalidateQueries|graphqlRequest" \
  web/apps/aquamobil/src/hooks/useWarehouseSummary.ts \
  web/apps/aquamobil/src/pages/storage \
  web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx
```

Record overlap and preserve every current tenant key, cache namespace/TTL, recoverable-network
classification, queue operation, replay payload, and post-write invalidation.

- [ ] **Step 2: Write RED tests for the raw summary contract**

`useWarehouseSummary.spec.tsx` proves successful network data, recoverable-network cached fallback
success, cache-miss error, GraphQL-error rejection even when cache exists, malformed-cache
rejection, tenant gating, and retry. It also proves the exported result has no zero-valued summary
when the query failed.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useWarehouseSummary.spec.tsx
```

Expected: FAIL because the hook currently discards `isError` and substitutes `DEFAULT_SUMMARY`.

- [ ] **Step 3: Return the authoritative query object**

Keep the current `useQuery<WarehouseSummary>` configuration and generated summary document, but
return the query directly. Delete `WarehouseSummaryResponse` and use `GetWarehouseSummaryQuery`;
delete `DEFAULT_SUMMARY`. Consult the existing tenant cache only when
`isRecoverableNetworkError(error)` is true, and accept it only after a runtime guard proves the
required numeric arrays/fields. Update `StorageHubPage` and only the warehouse card in
`OperationsHubPage` to consume `toLoadable(useWarehouseSummary())` so the signature change stays
compiling before Task 13 finishes the operations page.

- [ ] **Step 4: Write RED page-level outage tests**

Drive each ordinary storage query through loading, failed, ready-empty, and ready-data states:

- `StorageHubPage`: failure says the summary and movement history are unavailable, exposes retry,
  and never renders clean zero KPI values or “No recent movements.”
- `StockMovementPage`: failed items or locations prevent submission and name the missing
  prerequisite; a ready empty list remains an ordinary empty state.
- `StockTransferPage`: source/destination and stock failures remain distinct, and no failed list
  becomes an empty selector.
- `StockViewPage`: location failure and stock failure render independently; pull-to-refresh still
  calls the existing refetch.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/storage/__tests__/StorageHubPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockMovementPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockTransferPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockViewPage.outage.spec.tsx
```

Expected: FAIL because the current pages destructure query data into empty arrays and present failed
prerequisites as empty warehouse facts.

- [ ] **Step 5: Establish one generated storage-query module and reuse V2's mutation documents**

Move the duplicated `StorageInventoryItems` and `StorageLocations` queries plus `StockAtLocation`
from the three page files to `src/graphql/storage.operations.ts`. Give each query one unique name
and export its generated `TypedDocumentNode`. Delete the page-local `RecordStockMovement` and
`TransferStock` mutation texts; do not copy them into this module. Run:

```bash
npm run apollo-router:compose
npm run codegen
npm run codegen:check
```

Import generated row/result/variable types in the pages and delete `StorageInventoryItem`,
`StorageLocation`, `StockItem`, and manual mutation-result shapes that duplicate selections. A
transformed `StorageItem` display model may remain only as a derived ready-data type. Online
movement imports `QueuedRecordStockMovementDocument`; online transfer imports
`QueuedTransferStockDocument`; both are generated from the exact V2 strings already mapped by
`OPERATION_MUTATIONS`. Extend `queued-mutation-ssot.spec.ts` to require those exact page imports and
to fail if either root has a second operation definition anywhere under `src/graphql/`. Do not copy
either mutation back into a page, storage module, or replay registry.

- [ ] **Step 6: Implement one `DataState` per independent warehouse query**

Pass each existing `UseQueryResult` through `toLoadable`. Derive selectors, totals, movement rows,
and submission eligibility only inside ready arms. If a form depends on both items and locations,
render two explicit prerequisite states and mount the form only after both are ready; do not combine
them into a new status union. Replace the storage pages' legacy presentation with V0
primitives/semantic tokens at the same time, without changing the form contracts. Preserve mutation
errors separately from read failures and retain the existing online/recoverable-offline queue
behavior.

The Operations hub warehouse tile renders metrics only in the ready arm. An error tile says
“Warehouse unavailable” and retries; it never displays three zeroes.

- [ ] **Step 7: Verify the complete warehouse slice**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useWarehouseSummary.spec.tsx \
  src/pages/storage/__tests__/StorageHubPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockMovementPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockTransferPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockViewPage.outage.spec.tsx \
  src/pwa/__tests__/queued-mutation-ssot.spec.ts
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/query-error-surface.invariant.spec.ts
npm run codegen:check
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/graphql/storage.operations.ts \
  src/hooks/useWarehouseSummary.ts \
  src/hooks/__tests__/useWarehouseSummary.spec.tsx \
  src/pages/storage/StorageHubPage.tsx \
  src/pages/storage/StockMovementPage.tsx \
  src/pages/storage/StockTransferPage.tsx \
  src/pages/storage/StockViewPage.tsx \
  src/pages/storage/__tests__/StorageHubPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockMovementPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockTransferPage.outage.spec.tsx \
  src/pages/storage/__tests__/StockViewPage.outage.spec.tsx \
  src/pages/operations/OperationsHubPage.tsx \
  src/pwa/__tests__/queued-mutation-ssot.spec.ts
! rg -n 'from .graphql-tag.|\bgql\x60|interface (StorageInventoryItem|StorageLocation|StockItem)' \
  web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx \
  web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx \
  web/apps/aquamobil/src/pages/storage/StockViewPage.tsx
```

Expected: PASS. The negated search prints nothing, valid cached data remains available only for
recoverable network failures, cache-miss/contract failures are visible, generated documents are
fresh, and writes retain their existing single online/offline paths.

- [ ] **Step 8: Commit warehouse truthfulness and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/graphql/storage.operations.ts \
  web/apps/aquamobil/src/generated/graphql.ts \
  web/apps/aquamobil/src/hooks/useWarehouseSummary.ts \
  web/apps/aquamobil/src/hooks/__tests__/useWarehouseSummary.spec.tsx \
  web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx \
  web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx \
  web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx \
  web/apps/aquamobil/src/pages/storage/StockViewPage.tsx \
  web/apps/aquamobil/src/pages/storage/__tests__/StorageHubPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/storage/__tests__/StockMovementPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/storage/__tests__/StockTransferPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/storage/__tests__/StockViewPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx \
  web/apps/aquamobil/src/pwa/__tests__/queued-mutation-ssot.spec.ts \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): preserve warehouse outage semantics" \
  -m "Keep cached inventory useful without manufacturing clean zeroes when every read fails."
git push
```

---

### Task 13: V4 — Convert the remaining product pages without creating local state machines

**Files:**

- Create: `web/apps/aquamobil/src/__tests__/remaining-page-semantics.invariant.spec.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useStaffSummary.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/operations/__tests__/aggregate-hubs.outage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/__tests__/query-backed-pages.outage.spec.tsx`
- Modify: `web/apps/aquamobil/src/hooks/useStaffSummary.ts`
- Modify: `web/apps/aquamobil/src/components/hub/ActivityList.tsx`
- Modify: `web/apps/aquamobil/src/components/hub/HubHeader.tsx`
- Modify: `web/apps/aquamobil/src/components/hub/KpiStrip.tsx`
- Modify: `web/apps/aquamobil/src/components/hub/QuickActionGrid.tsx`
- Modify: `web/apps/aquamobil/src/components/hub/index.ts`
- Modify: `web/apps/aquamobil/src/pages/LoginPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/NotFoundPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/__tests__/NotFoundPage.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/_shared/__tests__/RecordEntityPage.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/account/AccountPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/account/__tests__/AccountPage.role-badge.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/alerts/AlertsPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx`
- Modify: `web/apps/aquamobil/src/pages/escape/EscapeIncidentPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/escape/__tests__/EscapeIncidentPage.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/lice/LiceCountPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/lice/__tests__/LiceCountPage.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/notifications/NotificationsPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/operations/DailyOpsHubPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/operations/StaffHubPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/operations/StockEventsHubPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/schedule/MySchedulePage.tsx`
- Modify: `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/tasks/MyTasksPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/welfare/WelfareScorePage.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes V0 primitives, V1 `Loadable`/`DataState`, Task 2 hook error fields, Task 12's raw
  warehouse query, current auth/permission/offline/mutation contracts, and the existing shared
  `RecordEntityPage` form contract.
- Makes the staff aggregate truthful:

```ts
export interface UseStaffSummaryResult {
  summary: StaffSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useStaffSummary(): UseStaffSummaryResult;
```

- `useStaffSummary` combines the existing attendance, leave-balance, and two schedule query results
  only when all are ready. It propagates any constituent failure and owns no cache or duplicate
  query.
- This task does not perform the global Konsta removal, activate the new appearance preference,
  change service-worker behavior, or declare global zero-count bans. Existing Konsta form leaves in
  `RecordEntityPage` and `LeaveRequestPage` remain measured by V0's ratchet for the
  delivery/appearance convergence plan.

- [ ] **Step 1: Audit overlap and classify every state before editing**

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
git log --oneline HEAD..origin/main -- \
  web/apps/aquamobil/src/components/hub \
  web/apps/aquamobil/src/hooks/useStaffSummary.ts \
  web/apps/aquamobil/src/pages/LoginPage.tsx \
  web/apps/aquamobil/src/pages/NotFoundPage.tsx \
  web/apps/aquamobil/src/pages/_shared \
  web/apps/aquamobil/src/pages/account \
  web/apps/aquamobil/src/pages/alerts \
  web/apps/aquamobil/src/pages/attendance \
  web/apps/aquamobil/src/pages/escape \
  web/apps/aquamobil/src/pages/leave \
  web/apps/aquamobil/src/pages/lice \
  web/apps/aquamobil/src/pages/notifications \
  web/apps/aquamobil/src/pages/operations \
  web/apps/aquamobil/src/pages/schedule \
  web/apps/aquamobil/src/pages/sync \
  web/apps/aquamobil/src/pages/tasks \
  web/apps/aquamobil/src/pages/welfare
```

Record overlap. For each page, list ordinary reads, domain/mutation state, queue writes,
feature/role gates, navigation targets, and current tests. Only ordinary reads go through
`DataState`; camera, form, mutation, biometric, queue, and auth states keep their domain-specific
handling.

- [ ] **Step 2: Write the scoped presentation invariant and observe RED**

`remaining-page-semantics.invariant.spec.ts` contains an explicit array of every component/page path
above. It reads those files and rejects `text-[10px]`, `text-[11px]`, legacy gray/ocean palette
utilities, and newly introduced local query-status unions. A second explicit list of query-backed
pages requires a `DataState` import. It is scoped to V4 ownership, deliberately leaves V0's measured
Konsta count unchanged, and does not alter the later whole-source convergence bans.

```bash
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/remaining-page-semantics.invariant.spec.ts
```

Expected: FAIL because the owned files still use legacy utilities and several query-backed pages
branch on loading/error/default data themselves.

- [ ] **Step 3: Write RED aggregate-hub outage tests**

`useStaffSummary.spec.tsx` rejects each of attendance, leave balance, current schedule, and next
schedule in turn; each rejection must set `isError`, retain no summary, expose the original error,
and make `refetch` call all four current queries.

`aggregate-hubs.outage.spec.tsx` drives each source independently:

- `DailyOpsHubPage` does not turn failed daily statistics or task reads into completed/zero work;
- `StockEventsHubPage` does not turn a failed summary into zero batches/events/transfers;
- `StaffHubPage` does not turn an attendance/leave/schedule failure into off-duty, zero leave, or no
  next shift;
- `OperationsHubPage` shows each available card while a failed sibling card says unavailable,
  proving failures are not merged into one page-wide empty state.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useStaffSummary.spec.tsx \
  src/pages/operations/__tests__/aggregate-hubs.outage.spec.tsx
```

Expected: FAIL because `useStaffSummary` swallows constituent failures and current aggregate
consumers calculate display zeroes from absent summaries.

- [ ] **Step 4: Propagate staff aggregate errors and use independent ready arms**

In `useStaffSummary`, retain all four existing raw hooks and compute:

```ts
const isLoading = sources.some((query) => query.isLoading);
const failed = sources.find((query) => query.isError);
const ready = sources.every((query) => query.data !== undefined);
```

Return `summary: ready && !failed ? buildStaffSummary(...) : undefined`, an `Error` normalized from
the first failed source, and a `refetch` that awaits all four existing refetch functions. Do not add
a fifth query, context, or store.

In every aggregate hub, adapt each hook independently. Derive numbers and rows only inside that
source's `DataState` ready arm. Keep permission-filtered action grids and offline notices unchanged.

- [ ] **Step 5: Write RED page-level outage cases**

`query-backed-pages.outage.spec.tsx` uses table-driven render helpers for these exact contracts:

- alerts: failed history is unavailable, never “No alerts”;
- attendance: today's record, recent records, and monthly summary fail independently and never
  render an off-shift/empty-history/zero-hours claim from failure;
- leave: balances and requests fail independently and never render zero balance/no requests from
  failure;
- notifications: list failure is unavailable, and count failure is not zero unread;
- schedule: failure is unavailable, not an empty week;
- tasks: list failure is unavailable, not “No tasks”; task-detail failure is unavailable while
  successful absence is “Task not found.”

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/__tests__/query-backed-pages.outage.spec.tsx
```

Expected: FAIL on the default arrays, default numeric values, and local query branches in the
current pages.

- [ ] **Step 6: Convert query-backed pages to the single state authority**

- Adapt existing raw TanStack results directly with `toLoadable`.
- Adapt hooks that expose `{ data, loading, error, refetch }` by constructing one `QueryLike` object
  at the page boundary.
- Keep independent sources in independent `DataState` components so one failed section does not hide
  valid siblings.
- In `TaskDetailPage`, adapt its existing fetch state into `Loadable<Task>` and render the task only
  in the ready child; keep action mutation state separate.
- Use `isEmpty` only for successful collections/null results. Never map `isError` to an empty array
  or numeric value.

- [ ] **Step 7: Convert presentation-only pages and the shared record shell**

Move the owned page chrome and non-Konsta controls in Login, Not Found, Account, RecordEntity,
Escape, Leave Request, Lice Count, Sync Status, and Welfare Score to V0 primitives and semantic
tokens while preserving their current auth, role, biometric, geolocation, queue, mutation,
validation, and navigation behavior. Leave the existing Konsta form leaves in `RecordEntityPage` and
`LeaveRequestPage` for the atomic convergence owner, and do not add another wrapper around them.
`AccountPage` must render notification-count failure as unavailable rather than zero.
`RecordEntityPage` keeps its generic field/configuration/callback API so mortality, cull, and
harvest callers do not fork it.

Use the shared hub primitives consistently with these contracts:

```ts
export interface ActivityItem {
  id: string;
  icon: LucideIcon;
  tone?: RowTone;
  title: string;
  subtitle?: string;
  timestamp: string;
}

export interface ActivityListProps {
  title: string;
  items: ActivityItem[];
  emptyMessage: string;
  isLoading?: boolean;
  maxItems?: number;
}

export interface HubHeaderProps {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  onBack?: () => void;
  children?: ReactNode;
}

export interface KpiItem {
  label: string;
  value: string | number;
  ariaLabel?: string;
  valueColor?: string;
  isLoading?: boolean;
}

export interface QuickAction {
  feature: MobileFeature;
  path: string;
  icon: LucideIcon;
  label: string;
  tone?: RowTone;
}
```

Remove the old free-form `gradient`, `iconColor`, and `iconBg` fields rather than translating them
into another class-string API. Update every caller in this task in the same commit. `valueColor` may
contain only a V0 semantic text token; the scoped invariant rejects legacy palettes.

- [ ] **Step 8: Run focused page tests and lint**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useStaffSummary.spec.tsx \
  src/pages/operations/__tests__/aggregate-hubs.outage.spec.tsx \
  src/pages/__tests__/query-backed-pages.outage.spec.tsx \
  src/pages/__tests__/NotFoundPage.spec.tsx \
  src/pages/_shared/__tests__/RecordEntityPage.spec.tsx \
  src/pages/account/__tests__/AccountPage.role-badge.spec.tsx \
  src/pages/escape/__tests__/EscapeIncidentPage.spec.tsx \
  src/pages/lice/__tests__/LiceCountPage.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/remaining-page-semantics.invariant.spec.ts
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/__tests__/remaining-page-semantics.invariant.spec.ts \
  src/hooks/useStaffSummary.ts \
  src/hooks/__tests__/useStaffSummary.spec.tsx \
  src/components/hub/*.tsx \
  src/components/hub/index.ts \
  src/pages/LoginPage.tsx \
  src/pages/NotFoundPage.tsx \
  src/pages/__tests__/NotFoundPage.spec.tsx \
  src/pages/_shared/RecordEntityPage.tsx \
  src/pages/_shared/__tests__/RecordEntityPage.spec.tsx \
  src/pages/account/AccountPage.tsx \
  src/pages/account/__tests__/AccountPage.role-badge.spec.tsx \
  src/pages/alerts/AlertsPage.tsx \
  src/pages/attendance/AttendancePage.tsx \
  src/pages/escape/EscapeIncidentPage.tsx \
  src/pages/escape/__tests__/EscapeIncidentPage.spec.tsx \
  src/pages/leave/*.tsx \
  src/pages/lice/LiceCountPage.tsx \
  src/pages/lice/__tests__/LiceCountPage.spec.tsx \
  src/pages/notifications/NotificationsPage.tsx \
  src/pages/operations/*.tsx \
  src/pages/schedule/MySchedulePage.tsx \
  src/pages/sync/SyncStatusPage.tsx \
  src/pages/tasks/*.tsx \
  src/pages/welfare/WelfareScorePage.tsx \
  src/pages/operations/__tests__/aggregate-hubs.outage.spec.tsx \
  src/pages/__tests__/query-backed-pages.outage.spec.tsx
```

Expected: PASS with all task-owned ordinary reads governed by `DataState` and all
mutation/offline/auth behavior preserved.

- [ ] **Step 9: Verify the complete V4 slice**

```bash
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm run apollo-router:compose
npm run codegen:check
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/query-error-surface.invariant.spec.ts \
  src/__tests__/route-reachability.invariant.spec.ts \
  src/__tests__/design-token.invariant.spec.ts \
  src/__tests__/field-ergonomics.invariant.spec.ts \
  src/__tests__/remaining-page-semantics.invariant.spec.ts
```

Expected: PASS. V4 has no clean-state claims from failed reads and introduces no generated-contract
drift.

- [ ] **Step 10: Classify production dependencies for the V4 PR**

Run the complete Production Dependency Checkpoint with `v4_product_slice=V4`. Require its fixed
directory to be uploaded by the V4 PR workflow and captured by the program as repository-bound
boundary evidence. Stop for any missing proof, unclassified path, or affected-and-reachable
high/critical path; do not edit the immutable preflight or central ledger.

- [ ] **Step 11: Commit the remaining V4 conversion and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/__tests__/remaining-page-semantics.invariant.spec.ts \
  web/apps/aquamobil/src/hooks/useStaffSummary.ts \
  web/apps/aquamobil/src/hooks/__tests__/useStaffSummary.spec.tsx \
  web/apps/aquamobil/src/components/hub/ActivityList.tsx \
  web/apps/aquamobil/src/components/hub/HubHeader.tsx \
  web/apps/aquamobil/src/components/hub/KpiStrip.tsx \
  web/apps/aquamobil/src/components/hub/QuickActionGrid.tsx \
  web/apps/aquamobil/src/components/hub/index.ts \
  web/apps/aquamobil/src/pages/LoginPage.tsx \
  web/apps/aquamobil/src/pages/NotFoundPage.tsx \
  web/apps/aquamobil/src/pages/__tests__/NotFoundPage.spec.tsx \
  web/apps/aquamobil/src/pages/__tests__/query-backed-pages.outage.spec.tsx \
  web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx \
  web/apps/aquamobil/src/pages/_shared/__tests__/RecordEntityPage.spec.tsx \
  web/apps/aquamobil/src/pages/account/AccountPage.tsx \
  web/apps/aquamobil/src/pages/account/__tests__/AccountPage.role-badge.spec.tsx \
  web/apps/aquamobil/src/pages/alerts/AlertsPage.tsx \
  web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx \
  web/apps/aquamobil/src/pages/escape/EscapeIncidentPage.tsx \
  web/apps/aquamobil/src/pages/escape/__tests__/EscapeIncidentPage.spec.tsx \
  web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx \
  web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx \
  web/apps/aquamobil/src/pages/lice/LiceCountPage.tsx \
  web/apps/aquamobil/src/pages/lice/__tests__/LiceCountPage.spec.tsx \
  web/apps/aquamobil/src/pages/notifications/NotificationsPage.tsx \
  web/apps/aquamobil/src/pages/operations/DailyOpsHubPage.tsx \
  web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx \
  web/apps/aquamobil/src/pages/operations/StaffHubPage.tsx \
  web/apps/aquamobil/src/pages/operations/StockEventsHubPage.tsx \
  web/apps/aquamobil/src/pages/operations/__tests__/aggregate-hubs.outage.spec.tsx \
  web/apps/aquamobil/src/pages/schedule/MySchedulePage.tsx \
  web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx \
  web/apps/aquamobil/src/pages/tasks/MyTasksPage.tsx \
  web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx \
  web/apps/aquamobil/src/pages/welfare/WelfareScorePage.tsx \
  tools/quality/format-scope.json
slice_finding_id="$(jq -sre --arg title 'AquaMobil report and warehouse surfaces can erase outage semantics' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$slice_finding_id" =~ ^[A-Z][A-Z0-9-]*-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): migrate remaining product pages" \
  -m "Converge page presentation and make every ordinary read distinguish unavailable from empty." \
  -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md#$slice_finding_id"
npx nx affected --target=lint --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=test --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=build --base=origin/main --head=HEAD --skip-nx-cache
git push
```

---

### Task 14: V5 — Add one live viewport seam and the dormant tablet shell

**Files:**

- Create: `web/apps/aquamobil/src/hooks/useViewport.ts`
- Create: `web/apps/aquamobil/src/hooks/__tests__/useViewport.spec.tsx`
- Create: `web/apps/aquamobil/src/layouts/AppShell.tsx`
- Create: `web/apps/aquamobil/src/layouts/TabletLayout.tsx`
- Create: `web/apps/aquamobil/src/layouts/__tests__/AppShell.spec.tsx`
- Create: `web/apps/aquamobil/src/layouts/__tests__/TabletLayout.spec.tsx`
- Create: `web/apps/aquamobil/src/layouts/__tests__/board-breakpoint.spec.ts`
- Create: `docs/superpowers/evidence/aquamobil-v4/slices/V5/preflight.json` through the program
  capture tool
- Modify: `web/apps/aquamobil/src/components/AppHeader.tsx`
- Modify: `web/apps/aquamobil/src/components/__tests__/AppHeader.spec.tsx`
- Modify: `web/apps/aquamobil/src/hooks/index.ts`
- Modify: `web/apps/aquamobil/src/layouts/index.ts`
- Modify: `web/apps/aquamobil/tailwind.config.js`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes the phone `MobileLayout`, V1 `AccountAvatar`/`AppHeader`/`DataState`, current alerts,
  tanks, offline queue, feature access, and V0 segmented/chip/status primitives.
- Produces:

```ts
export const BOARD_MEDIA_QUERY = '(min-width: 900px) and (min-height: 600px)';
export const BOARD_WIDE_MEDIA_QUERY = '(min-width: 1280px) and (min-height: 600px)';
export function useMediaQuery(query: string): boolean;
export function useIsBoardViewport(): boolean;

export const BOARD_PATH = '/board';
export const BOARD_TO_PHONE_PATH = {
  '/board': '/',
  '/board/reports': '/reports',
  '/board/chat': '/messages',
} as const;
export function phonePathForBoardPath(pathname: string): string | null;
export function AppShell({ children }: { children: ReactNode }): ReactElement;
export function TabletLayout({ children }: { children: ReactNode }): ReactElement;
```

- `AppShell` is the only component permitted to select phone versus board layout. It mounts one
  tree, never both hidden with CSS.
- This task exports the seam but deliberately leaves `App.tsx` on `MobileLayout`; Task 16 activates
  `AppShell` in the same commit that adds all board routes. Therefore this intermediate commit is
  deployable and cannot redirect a tablet to a missing route.

- [ ] **Step 0: Verify the coordinator-created V5 worktree from reconciled V3 and V4**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
v4_preflight='docs/superpowers/evidence/aquamobil-v4/slices/V5/preflight.json'
test "$(git branch --show-current)" = 'feat/aquamobil-v5-tablet-board'
test -f "$v4_preflight"
test "$(git rev-parse HEAD)" = "$(jq -r '.baseMainCommit' "$v4_preflight")"
git merge-base --is-ancestor "$(jq -r '.baseMainCommit' "$v4_preflight")" origin/main
for v4_predecessor in V3 V4; do
  git show "origin/main:docs/superpowers/evidence/aquamobil-v4/slices/$v4_predecessor/merge.json" |
    jq -e --arg slice "$v4_predecessor" '.slice == $slice and (.implementationBoundaries | length == 1)'
done
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-slice-audit.mjs" \
  --slice V5 \
  --check "$v4_preflight" \
  --main-ref origin/main
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
```

Expected: `origin/main` contains the protected implementation and reconciliation records for V3 and
V4, with V2 main-reachable through both. The V5 preflight and branch HEAD bind the same immutable
creation-time base, which remains an ancestor of current `origin/main`; later zero-overlap advances
proceed only through the prospective-PR and latest merge-queue checks. Otherwise stop before adding
the responsive seam.

- [ ] **Step 1: Audit the shell, hook, and Tailwind overlap**

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
git log --oneline HEAD..origin/main -- \
  web/apps/aquamobil/src/App.tsx \
  web/apps/aquamobil/src/components/AppHeader.tsx \
  web/apps/aquamobil/src/hooks/index.ts \
  web/apps/aquamobil/src/layouts \
  web/apps/aquamobil/tailwind.config.js
git diff --stat origin/main...origin/feature/aquamobil-v4-redesign -- \
  web/apps/aquamobil/src/hooks/useViewport.ts \
  web/apps/aquamobil/src/layouts \
  web/apps/aquamobil/tailwind.config.js
```

Record overlap. Preserve V0 semantic theme configuration and every phone breakpoint. Only add the
two board media queries.

- [ ] **Step 2: Write the board-breakpoint and subscription tests first**

`board-breakpoint.spec.ts` imports `BOARD_MEDIA_QUERY`/`BOARD_WIDE_MEDIA_QUERY`, reads
`tailwind.config.js`, and proves the JS and Tailwind literals match exactly. It also proves a
`932 × 430` landscape phone is below the board query, a viewport satisfying both minimum dimensions
is a board, and only a viewport satisfying the wider width enters `board-wide`.

`useViewport.spec.tsx` supplies a controllable `matchMedia` implementation and proves initial
snapshot, one `change` subscription, resize/rotation update, cleanup, and no-DOM fallback to phone.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/layouts/__tests__/board-breakpoint.spec.ts \
  src/hooks/__tests__/useViewport.spec.tsx
```

Expected: FAIL because the media-query constants, hook, and Tailwind screens are absent.

- [ ] **Step 3: Implement the single external-store hook**

Use `useSyncExternalStore`; do not add component state, a resize listener, or an orientation
listener:

```ts
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!canMatchMedia()) return () => undefined;
      const media = window.matchMedia(query);
      media.addEventListener('change', onStoreChange);
      return () => media.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => canMatchMedia() && window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
```

Add `board` and `board-wide` entries to only the Tailwind `screens` section using the exact raw
media strings above.

- [ ] **Step 4: Write RED `AppShell` and tablet-header truth tests**

`AppShell.spec.tsx` proves:

- a board viewport at `/` replaces to `/board`;
- a phone viewport maps `/board` to `/`, `/board/reports` to `/reports`, and `/board/chat` to
  `/messages`, each with replacement;
- an ordinary phone route mounts only `MobileLayout`;
- an ordinary board route mounts only `TabletLayout`;
- changing the match swaps one shell for the other without mounting duplicate children.

`TabletLayout.spec.tsx` proves the Board/Reports/Chat switcher, account control, queue state, and
scope readout. It drives tank and alert failures and requires “Unit list unavailable” and “Alarms
unavailable”; neither failure may render “No units” or “No alarms.”

```bash
npm --prefix web/apps/aquamobil test -- \
  src/layouts/__tests__/AppShell.spec.tsx \
  src/layouts/__tests__/TabletLayout.spec.tsx
```

Expected: FAIL because neither layout seam exists.

- [ ] **Step 5: Implement the dormant shell without new data authorities**

`AppShell` reads `useIsBoardViewport()` and `useLocation()` once, performs route correction with
`<Navigate replace>`, and otherwise returns exactly one layout. `phonePathForBoardPath` is a total
lookup over the three board routes above; do not collapse Reports or Chat deep links to Today.

`TabletLayout`:

- uses `toLoadable(useTanks())` for its read-only site/unit scope line;
- uses the current `useAlerts` error channel before any count so failure cannot become “No alarms”;
- reads the existing offline queue for offline/sync/pending status;
- shows Board, Reports, and Chat route options without adding feature gates that differ from the
  phone;
- reuses `AccountAvatar` and `CriticalAlertBanner`;
- contains no scan, log, acknowledge, task-completion, feeder, drive, or actuator control;
- uses a single cleaned-up wall-clock interval and makes no server claim from the clock.

Extend `AppHeader` only for shared tablet chrome actually needed by this layout; preserve the V1
prop contract and phone tests.

- [ ] **Step 6: Verify the shell primitives while production remains on the phone shell**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/hooks/__tests__/useViewport.spec.tsx \
  src/layouts/__tests__/board-breakpoint.spec.ts \
  src/layouts/__tests__/AppShell.spec.tsx \
  src/layouts/__tests__/TabletLayout.spec.tsx \
  src/layouts/__tests__/MobileLayout.navigation.spec.tsx \
  src/components/__tests__/AppHeader.spec.tsx
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/hooks/useViewport.ts \
  src/hooks/__tests__/useViewport.spec.tsx \
  src/hooks/index.ts \
  src/layouts/AppShell.tsx \
  src/layouts/TabletLayout.tsx \
  src/layouts/index.ts \
  src/layouts/__tests__/AppShell.spec.tsx \
  src/layouts/__tests__/TabletLayout.spec.tsx \
  src/layouts/__tests__/board-breakpoint.spec.ts \
  src/components/AppHeader.tsx \
  src/components/__tests__/AppHeader.spec.tsx
```

Expected: PASS. `App.tsx` still mounts `MobileLayout`, while direct tests prove the exported shell
seam is live and truthful.

- [ ] **Step 7: Commit the dormant shell seam and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/hooks/useViewport.ts \
  web/apps/aquamobil/src/hooks/__tests__/useViewport.spec.tsx \
  web/apps/aquamobil/src/hooks/index.ts \
  web/apps/aquamobil/src/layouts/AppShell.tsx \
  web/apps/aquamobil/src/layouts/TabletLayout.tsx \
  web/apps/aquamobil/src/layouts/index.ts \
  web/apps/aquamobil/src/layouts/__tests__/AppShell.spec.tsx \
  web/apps/aquamobil/src/layouts/__tests__/TabletLayout.spec.tsx \
  web/apps/aquamobil/src/layouts/__tests__/board-breakpoint.spec.ts \
  web/apps/aquamobil/src/components/AppHeader.tsx \
  web/apps/aquamobil/src/components/__tests__/AppHeader.spec.tsx \
  web/apps/aquamobil/tailwind.config.js \
  docs/superpowers/evidence/aquamobil-v4/slices/V5/preflight.json \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): add the responsive shell seam" \
  -m "Choose one live layout from a two-dimensional viewport contract without activating missing board routes."
git push
```

---

### Task 15: V5 — Build the read-only board, unit panes, and URL selection

**Files:**

- Create: `web/apps/aquamobil/src/components/unit/UnitConfiguration.tsx`
- Create: `web/apps/aquamobil/src/components/unit/UnitVitals.tsx`
- Create: `web/apps/aquamobil/src/components/unit/index.ts`
- Create: `web/apps/aquamobil/src/components/unit/__tests__/UnitConfiguration.spec.tsx`
- Create: `web/apps/aquamobil/src/components/unit/__tests__/UnitVitals.spec.tsx`
- Create: `web/apps/aquamobil/src/utils/attention-tone.ts`
- Create: `web/apps/aquamobil/src/utils/__tests__/attention-tone.spec.ts`
- Create: `web/apps/aquamobil/src/pages/tablet/BoardRegion.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/useSelectedUnit.ts`
- Create: `web/apps/aquamobil/src/pages/tablet/BoardPage.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/panes/AttentionPane.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/panes/UnitGridPane.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/panes/UnitInspectorPane.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/__tests__/BoardPage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/__tests__/useSelectedUnit.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/panes/__tests__/AttentionPane.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/panes/__tests__/UnitGridPane.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/panes/__tests__/UnitInspectorPane.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/HomePage.tsx`
- Modify: `web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/units/UnitsPage.tsx`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes current `useAlerts`, `useMyTasks('today')`, and `useTanks` hooks; V1 query authority; V2
  unit/farm helpers; V3 cards; V0 primitives; and React Router search parameters.
- Produces:

```ts
export interface BoardRegionProps {
  label: string;
  icon: LucideIcon;
  action?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}

export const SELECTED_UNIT_PARAM = 'unit';
export interface BoardSelection {
  selectedUnitId: string | null;
  selectUnit: (unitId: string | null) => void;
}
export function useSelectedUnit(): BoardSelection;

export interface AttentionPaneProps {
  onSelectUnit?: (unitId: string) => void;
}

export function UnitConfiguration({ tank }: { tank: Tank }): ReactElement;
export function UnitVitals({ tank }: { tank: Tank }): ReactElement;
```

- The URL query parameter is the only board selection store. The unit grid and inspector read the
  same hook; there is no context, atom, Zustand store, mirrored component state, or navigation to
  unit detail on selection.
- This task still does not activate `/board`; Task 16 activates all board routes together.

- [ ] **Step 1: Audit shared phone logic and board ownership**

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
git log --oneline HEAD..origin/main -- \
  web/apps/aquamobil/src/pages/HomePage.tsx \
  web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx \
  web/apps/aquamobil/src/pages/units/UnitsPage.tsx \
  web/apps/aquamobil/src/hooks/useAlerts.ts \
  web/apps/aquamobil/src/hooks/useMyTasks.ts \
  web/apps/aquamobil/src/hooks/useTanks.ts
git diff --stat origin/main...origin/feature/aquamobil-v4-redesign -- \
  web/apps/aquamobil/src/components/unit \
  web/apps/aquamobil/src/pages/tablet \
  web/apps/aquamobil/src/utils/attention-tone.ts
```

Record overlap. Identify the current phone's unit configuration, vitals, alert severity tone, and
task priority tone. Extract those rules; do not copy them and let phone/board versions drift.

- [ ] **Step 2: Write RED shared unit/tone tests**

`UnitVitals.spec.tsx` proves container `currentQuantity` and `currentBiomass`, nullable
density/capacity, average weight, and backend over-capacity wording. `UnitConfiguration.spec.tsx`
proves physical/configuration values without converting null to zero. `attention-tone.spec.ts`
exhaustively covers generated `AlertSeverity` and every `TaskPriority`.

```ts
export function alertSeverityTone(severity: AlertSeverity): RowTone;
export function taskPriorityTone(priority: TaskPriority): RowTone;
```

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/unit/__tests__/UnitConfiguration.spec.tsx \
  src/components/unit/__tests__/UnitVitals.spec.tsx \
  src/utils/__tests__/attention-tone.spec.ts
```

Expected: FAIL because the unit sections and shared attention-tone maps do not exist.

- [ ] **Step 3: Extract once and reuse on phone surfaces**

Move the matching unit-detail blocks into `UnitVitals` and `UnitConfiguration`; render those
components from `TankDetailPage` and later from the inspector. Move alert/task tone maps into
exhaustive `Record` values in `attention-tone.ts`; render through the helpers from `HomePage` and
later from `AttentionPane`. `UnitsPage` continues using Task 6 `unitStatusMeta`, grouping, and
container totals. This is a refactor: do not change query keys, page actions, logging, capacity
consent, or AI advisory behavior.

- [ ] **Step 4: Write RED URL-selection and region tests**

`useSelectedUnit.spec.tsx` proves initial read, selection, toggle/clear, preservation of unrelated
search parameters, and `{ replace: true }` history behavior.

`BoardPage.spec.tsx` proves the three labelled regions “Alarms and tasks,” “Units,” and “Selected
unit,” independently scrolling bodies, a read-only footer, and no fourth drive/feeder region.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/tablet/__tests__/useSelectedUnit.spec.tsx \
  src/pages/tablet/__tests__/BoardPage.spec.tsx
```

Expected: FAIL because the URL seam, region, and board page are absent.

- [ ] **Step 5: Implement the region, selection hook, and three-column composition**

`BoardRegion` is a labelled `Card` landmark with one heading and an independently scrolling body.
`useSelectedUnit` updates only `SELECTED_UNIT_PARAM` through
`setSearchParams(previous => next, { replace: true })`.

`BoardPage` owns only the grid:

```tsx
<BoardRegion label="Alarms and tasks" icon={AlertTriangle}>
  <AttentionPane onSelectUnit={selectUnit} />
</BoardRegion>
<BoardRegion label="Units" icon={LayoutGrid}>
  <UnitGridPane />
</BoardRegion>
<BoardRegion label="Selected unit" icon={Fish}>
  <UnitInspectorPane />
</BoardRegion>
```

Use fixed side tracks and an elastic center at `board`, widening only at `board-wide`. Do not put a
drive, feeder, trends, or data-entry panel in the open space.

- [ ] **Step 6: Write RED pane truthfulness and read-only tests**

`AttentionPane.spec.tsx` independently drives alert, task, and unit failures. It proves:

- failed alerts do not say “No open alarms” or show `0 open`;
- failed tasks do not say “Nothing scheduled” or show `0 open`;
- a loaded alert whose `pondId` matches a ready unit may select it;
- an unmatched alert or unavailable unit list remains readable but is not a guessed link;
- there is no acknowledge, start, complete, or data-entry action.

`UnitGridPane.spec.tsx` proves loading/error/ready-empty/ready rows, site grouping, all eight status
words, container totals, nullable values, selected pressed state, and URL-based toggle.

`UnitInspectorPane.spec.tsx` proves no-selection, failed inventory, successful missing selection,
and successful selected unit are distinct. It also proves the pane reuses `UnitVitals`,
`LiveReadingsCard`, advisory cards, and `UnitConfiguration`, with no log or actuation action.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/tablet/panes/__tests__/AttentionPane.spec.tsx \
  src/pages/tablet/panes/__tests__/UnitGridPane.spec.tsx \
  src/pages/tablet/panes/__tests__/UnitInspectorPane.spec.tsx
```

Expected: FAIL because the panes do not exist.

- [ ] **Step 7: Implement pane reads through the shared authority**

- Adapt alerts and tasks to `Loadable` using their current error/refetch channels; count labels
  render only from ready data.
- Read units only to resolve an alert's real `pondId`; a failed unit query does not hide the alarm
  and cannot make it selectable.
- `UnitGridPane` calls `toLoadable(useTanks())`, groups only in the ready arm, and writes only the
  URL selection.
- `UnitInspectorPane` checks “unit not in this list” only inside the ready arm; query failure stays
  unavailable.
- Compose the same unit and advisory components used by the phone. The board never acknowledges,
  logs, starts/completes, queues, or actuates.

- [ ] **Step 8: Verify board/pane GREEN and affected phone parity**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/unit/__tests__/UnitConfiguration.spec.tsx \
  src/components/unit/__tests__/UnitVitals.spec.tsx \
  src/utils/__tests__/attention-tone.spec.ts \
  src/pages/tablet/__tests__/useSelectedUnit.spec.tsx \
  src/pages/tablet/__tests__/BoardPage.spec.tsx \
  src/pages/tablet/panes/__tests__/AttentionPane.spec.tsx \
  src/pages/tablet/panes/__tests__/UnitGridPane.spec.tsx \
  src/pages/tablet/panes/__tests__/UnitInspectorPane.spec.tsx \
  src/pages/__tests__/HomePage.outage.spec.tsx \
  src/pages/tank/__tests__/TankDetailPage.outage.spec.tsx \
  src/pages/tank/__tests__/TankDetailPage.capacity.spec.tsx \
  src/pages/units/__tests__/UnitsPage.outage.spec.tsx
npm --prefix web/apps/aquamobil run typecheck
npm --prefix web/apps/aquamobil exec -- eslint \
  src/components/unit/*.tsx \
  src/components/unit/index.ts \
  src/components/unit/__tests__/*.spec.tsx \
  src/utils/attention-tone.ts \
  src/utils/__tests__/attention-tone.spec.ts \
  src/pages/tablet/BoardRegion.tsx \
  src/pages/tablet/useSelectedUnit.ts \
  src/pages/tablet/BoardPage.tsx \
  src/pages/tablet/__tests__/BoardPage.spec.tsx \
  src/pages/tablet/__tests__/useSelectedUnit.spec.tsx \
  src/pages/tablet/panes/*.tsx \
  src/pages/tablet/panes/__tests__/*.spec.tsx \
  src/pages/HomePage.tsx \
  src/pages/tank/TankDetailPage.tsx \
  src/pages/units/UnitsPage.tsx
```

Expected: PASS. Phone and board use one unit/tone vocabulary, URL selection is the only selection
state, and the board has no farm-record or actuator write.

- [ ] **Step 9: Commit the board data composition and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/components/unit/UnitConfiguration.tsx \
  web/apps/aquamobil/src/components/unit/UnitVitals.tsx \
  web/apps/aquamobil/src/components/unit/index.ts \
  web/apps/aquamobil/src/components/unit/__tests__/UnitConfiguration.spec.tsx \
  web/apps/aquamobil/src/components/unit/__tests__/UnitVitals.spec.tsx \
  web/apps/aquamobil/src/utils/attention-tone.ts \
  web/apps/aquamobil/src/utils/__tests__/attention-tone.spec.ts \
  web/apps/aquamobil/src/pages/tablet/BoardRegion.tsx \
  web/apps/aquamobil/src/pages/tablet/useSelectedUnit.ts \
  web/apps/aquamobil/src/pages/tablet/BoardPage.tsx \
  web/apps/aquamobil/src/pages/tablet/__tests__/BoardPage.spec.tsx \
  web/apps/aquamobil/src/pages/tablet/__tests__/useSelectedUnit.spec.tsx \
  web/apps/aquamobil/src/pages/tablet/panes/AttentionPane.tsx \
  web/apps/aquamobil/src/pages/tablet/panes/UnitGridPane.tsx \
  web/apps/aquamobil/src/pages/tablet/panes/UnitInspectorPane.tsx \
  web/apps/aquamobil/src/pages/tablet/panes/__tests__/AttentionPane.spec.tsx \
  web/apps/aquamobil/src/pages/tablet/panes/__tests__/UnitGridPane.spec.tsx \
  web/apps/aquamobil/src/pages/tablet/panes/__tests__/UnitInspectorPane.spec.tsx \
  web/apps/aquamobil/src/pages/HomePage.tsx \
  web/apps/aquamobil/src/pages/tank/TankDetailPage.tsx \
  web/apps/aquamobil/src/pages/units/UnitsPage.tsx \
  tools/quality/format-scope.json
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): compose the read-only unit board" \
  -m "Reuse phone read models in three truthful panes with URL-owned selection and no actuation."
git push
```

---

### Task 16: V5 — Reuse chat/report authorities and activate every board route atomically

**Files:**

- Create: `web/apps/aquamobil/src/components/messaging/ChatThread.tsx`
- Create: `web/apps/aquamobil/src/components/messaging/__tests__/ChatThread.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/ChatBoardPage.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/ReportsBoardPage.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/__tests__/ChatBoardPage.spec.tsx`
- Create: `web/apps/aquamobil/src/pages/tablet/__tests__/ReportsBoardPage.spec.tsx`
- Create: `web/apps/aquamobil/src/utils/__tests__/messaging-helpers.spec.ts`
- Modify: `web/apps/aquamobil/src/components/messaging/index.ts`
- Modify: `web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/messaging/__tests__/ChatRoomPage-attachment-retry.spec.tsx`
- Modify: `web/apps/aquamobil/src/utils/messaging-helpers.ts`
- Modify: `web/apps/aquamobil/src/App.tsx`
- Modify: `web/apps/aquamobil/src/__tests__/route-reachability.invariant.spec.ts`
- Modify: `web/apps/aquamobil/src/layouts/__tests__/AppShell.spec.tsx`
- Modify: `web/apps/aquamobil/src/pages/index.ts`
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes the V3 message hooks/components and their current query/socket/offline behavior; V4
  `useReportDeadlines`, `farmSummary`, and report display utilities; V5 `BoardRegion`, `AppShell`,
  and `TabletLayout`.
- Produces:

```ts
export interface ChatThreadProps {
  channelId: string;
}
export function ChatThread({ channelId }: ChatThreadProps): ReactElement;

export const SELECTED_CHANNEL_PARAM = 'channel';
interface ChannelSelection {
  selectedChannelId: string | null;
  selectChannel: (channelId: string | null) => void;
}

export function ChatBoardPage(): ReactElement;
export function ReportsBoardPage(): ReactElement;
```

- `ChatThread` is the only full message-history/composer renderer. Phone and board provide different
  chrome around the same component.
- The board channel parameter is its only channel-selection store. `useChannels` remains the only
  channel-list data boundary; `useMessages` and current messaging cache keys remain the only
  message-history authority.
- Reports board data comes directly from the same `useTanks`, `farmSummary`, `useReportDeadlines`,
  and display helpers as the phone. It creates no tablet report query, summary object cache, or
  label table.

- [ ] **Step 1: Audit the extraction boundary and current-main transport changes**

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
git log --oneline HEAD..origin/main -- \
  web/apps/aquamobil/src/App.tsx \
  web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx \
  web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx \
  web/apps/aquamobil/src/components/messaging \
  web/apps/aquamobil/src/hooks/useChannels.ts \
  web/apps/aquamobil/src/hooks/useChannelDetail.ts \
  web/apps/aquamobil/src/hooks/useMessages.ts \
  web/apps/aquamobil/src/hooks/useMessageSocket.ts \
  web/apps/aquamobil/src/pages/reports/ReportsPage.tsx
rg -n "messagesQueryKey|createTenantQueryKey|useMessageSocket|useMessages|useSendMessage|useMediaUpload|read" \
  web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx \
  web/apps/aquamobil/src/hooks/useMessages.ts \
  web/apps/aquamobil/src/hooks/useMessageSocket.ts \
  web/apps/aquamobil/src/hooks/useSendMessage.ts
```

Record overlap. Write down the exact current
send/edit/delete/forward/receipt/read-cursor/media/voice behavior before moving code. Current main
wins wherever it differs from the behavioral source.

- [ ] **Step 2: Write RED shared helper and `ChatThread` parity tests**

`messaging-helpers.spec.ts` proves one display-name rule for direct/group/AI channels and one
direct-member presence rule. Add:

```ts
export function getChannelDisplayName(channel: ChannelLike, currentUserId?: string): string;
export function isOtherMemberOnline(channel: ChannelLike, currentUserId?: string): boolean;
```

Use structural `ChannelLike` input fields so helpers accept both list/detail generated shapes
without casting.

`ChatThread.spec.tsx` moves the behavior assertions currently tied to the page body: initial/message
errors, optimistic send, pagination, read cursor, typing, reply, edit/delete/forward, attachment
retry, voice, and cleanup. `ChatRoomPage` tests retain header/back/settings integration assertions.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/utils/__tests__/messaging-helpers.spec.ts \
  src/components/messaging/__tests__/ChatThread.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage-attachment-retry.spec.tsx
```

Expected: FAIL because the shared channel helpers and `ChatThread` export do not exist.

- [ ] **Step 3: Extract the current thread without rewriting it**

Move the message-history/composer subtree and its associated hooks/state/callbacks from
`ChatRoomPage` to `ChatThread`. Keep the current query keys, socket listener ownership, optimistic
updates, read-cursor deduplication, pagination direction, attachment/voice lanes, object-URL
cleanup, and mutation error handling byte-for-behavior. `ChatRoomPage` retains the route parameter,
header, channel detail, back/settings navigation, and renders:

```tsx
<DataState value={channelView} label="the conversation" skeleton="row">
  {(channel) => (
    <>
      <ChatHeader channel={channel} />
      <ChatThread key={channel.id} channelId={channel.id} />
    </>
  )}
</DataState>
```

Export `ChatThread` through the messaging barrel. Move phone-list display name/presence logic into
`messaging-helpers.ts`; do not create a second copy for the board.

- [ ] **Step 4: Write RED two-pane Chat board tests**

`ChatBoardPage.spec.tsx` proves:

- conversations render from `useChannels` with the same sorting, search, unread, direct-name, and
  presence semantics as the phone;
- list failure is unavailable, not “No conversations”;
- selecting a row writes only `?channel=` with replacement and does not leave `/board/chat`;
- no selection renders “No conversation open”;
- channel-detail failure and message-history failure are separately visible;
- a selected ready channel renders the shared `ChatThread`, and changing selection remounts its
  per-channel UI state;
- new-chat and channel-settings destinations remain reachable under the current permission contract.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/tablet/__tests__/ChatBoardPage.spec.tsx
```

Expected: FAIL because the board Chat page does not exist.

- [ ] **Step 5: Implement board Chat directly over existing authorities**

Use a private `useSelectedChannel` in `ChatBoardPage` with the same URL/update semantics as
`useSelectedUnit`. The left region calls `useChannels` once and performs filtering/sorting only
within `DataState`'s ready arm. It renders the shared `ChannelListItem`; it does not copy the hook's
accumulated array into component state. The right region adapts `useChannelDetail` through
`DataState` and mounts `ChatThread` only for a ready channel.

Keep the composer: messaging from the cabin is coordination, not a farm record. Do not add farm
logging, report submission, acknowledgement, feeder, drive, or actuator actions.

- [ ] **Step 6: Write RED board Reports tests**

`ReportsBoardPage.spec.tsx` proves:

- a module user gets one full-width farm-summary region and no regulatory query;
- a manager gets farm summary and regulatory submissions side by side;
- tank and deadline failures are independently unavailable and cannot become “Nothing stocked” or
  “No reports due”;
- offline mode explains that submissions need a connection and never fetches deadlines;
- capacity consent uses `isOverCapacity`, nullable metrics remain unknown, and urgency text uses the
  V4 helper;
- no period selector or chart is rendered because there is no time-series query.

```bash
npm --prefix web/apps/aquamobil test -- \
  src/pages/tablet/__tests__/ReportsBoardPage.spec.tsx
```

Expected: FAIL because the board Reports page does not exist.

- [ ] **Step 7: Compose board Reports without a second read model**

Use `toLoadable(useTanks())` and call `farmSummary` only in the ready arm. Use
`toLoadable(useReportDeadlines())` only for an online manager. Reuse `reportTypeLabel`,
`periodLabel`, `dueLabel`, and `fixedOrNone`. State in the footer that figures are a current
snapshot and that no history query exists; do not draw inferred trends.

- [ ] **Step 8: Write the route-activation RED tests**

Extend `route-reachability.invariant.spec.ts` to require lazy protected routes `/board`,
`/board/reports`, and `/board/chat` in addition to every phone route. Extend `AppShell.spec.tsx`
integration coverage to prove board viewports reach those components and phone correction is
semantic: `/board` → `/`, `/board/reports` → `/reports`, and `/board/chat` → `/messages`, all with
replacement and no intermediate Today render.

```bash
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/route-reachability.invariant.spec.ts
npm --prefix web/apps/aquamobil test -- \
  src/layouts/__tests__/AppShell.spec.tsx
```

Expected: FAIL because `App.tsx` still mounts `MobileLayout` and has no board route elements.

- [ ] **Step 9: Activate one shell and all board routes in one change**

Lazy-load `BoardPage`, `ReportsBoardPage`, and `ChatBoardPage`. Replace the single protected
`MobileLayout` wrapper with `AppShell` without moving auth, permissions, error boundary, Suspense,
offline provider, query client, or service-worker navigation ownership. Add:

```tsx
<Route path="/board" element={<BoardPage />} />
<Route path="/board/reports" element={<ReportsBoardPage />} />
<Route path="/board/chat" element={<ChatBoardPage />} />
```

Export the board pages from `pages/index.ts`. The routes are watching/coordination surfaces and
introduce no `FeatureRoute` that differs from their phone counterpart; sections inside Reports keep
the V4 role gate. Below the board breakpoint, `AppShell` uses `BOARD_TO_PHONE_PATH` so Board lands
on Today, Reports remains Reports, and Chat remains Messages. At a board viewport, only `/`
redirects; phone deep links and regulated review remain usable inside tablet chrome.

- [ ] **Step 10: Verify the complete V5 slice**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/components/messaging/__tests__/ChatThread.spec.tsx \
  src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage-attachment-retry.spec.tsx \
  src/pages/tablet/__tests__/BoardPage.spec.tsx \
  src/pages/tablet/__tests__/ChatBoardPage.spec.tsx \
  src/pages/tablet/__tests__/ReportsBoardPage.spec.tsx \
  src/pages/tablet/panes/__tests__/AttentionPane.spec.tsx \
  src/pages/tablet/panes/__tests__/UnitGridPane.spec.tsx \
  src/pages/tablet/panes/__tests__/UnitInspectorPane.spec.tsx \
  src/layouts/__tests__/board-breakpoint.spec.ts \
  src/layouts/__tests__/AppShell.spec.tsx \
  src/layouts/__tests__/TabletLayout.spec.tsx \
  src/layouts/__tests__/MobileLayout.navigation.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/route-reachability.invariant.spec.ts \
  src/__tests__/query-error-surface.invariant.spec.ts
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
npm run apollo-router:compose
npm run codegen:check
npm --prefix web/apps/aquamobil exec -- eslint \
  src/App.tsx \
  src/__tests__/route-reachability.invariant.spec.ts \
  src/layouts/__tests__/AppShell.spec.tsx \
  src/components/messaging/ChatThread.tsx \
  src/components/messaging/index.ts \
  src/components/messaging/__tests__/ChatThread.spec.tsx \
  src/pages/messaging/ChannelListPage.tsx \
  src/pages/messaging/ChatRoomPage.tsx \
  src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChatRoomPage-attachment-retry.spec.tsx \
  src/pages/tablet/ChatBoardPage.tsx \
  src/pages/tablet/ReportsBoardPage.tsx \
  src/pages/tablet/__tests__/ChatBoardPage.spec.tsx \
  src/pages/tablet/__tests__/ReportsBoardPage.spec.tsx \
  src/utils/messaging-helpers.ts \
  src/utils/__tests__/messaging-helpers.spec.ts \
  src/pages/index.ts
```

Expected: PASS. Board and phone routes are both reachable at their intended viewport, shrinking
preserves the semantic Reports/Chat destination, chat uses one renderer/data boundary, Reports uses
one query/summary vocabulary, and every board query failure remains unavailable.

- [ ] **Step 11: Classify production dependencies for the V5 PR**

Run the complete Production Dependency Checkpoint with `v4_product_slice=V5`. Require its fixed
directory to be uploaded by the V5 PR workflow and captured by the program as repository-bound
boundary evidence. Stop for any missing proof, unclassified path, or affected-and-reachable
high/critical path; do not edit the immutable preflight or central ledger.

- [ ] **Step 12: Commit route activation and push**

```bash
npm run quality:format-scope:generate
git add -- \
  web/apps/aquamobil/src/components/messaging/ChatThread.tsx \
  web/apps/aquamobil/src/components/messaging/index.ts \
  web/apps/aquamobil/src/components/messaging/__tests__/ChatThread.spec.tsx \
  web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx \
  web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx \
  web/apps/aquamobil/src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/messaging/__tests__/ChatRoomPage.outage.spec.tsx \
  web/apps/aquamobil/src/pages/messaging/__tests__/ChatRoomPage-attachment-retry.spec.tsx \
  web/apps/aquamobil/src/pages/tablet/ChatBoardPage.tsx \
  web/apps/aquamobil/src/pages/tablet/ReportsBoardPage.tsx \
  web/apps/aquamobil/src/pages/tablet/__tests__/ChatBoardPage.spec.tsx \
  web/apps/aquamobil/src/pages/tablet/__tests__/ReportsBoardPage.spec.tsx \
  web/apps/aquamobil/src/utils/messaging-helpers.ts \
  web/apps/aquamobil/src/utils/__tests__/messaging-helpers.spec.ts \
  web/apps/aquamobil/src/App.tsx \
  web/apps/aquamobil/src/__tests__/route-reachability.invariant.spec.ts \
  web/apps/aquamobil/src/layouts/__tests__/AppShell.spec.tsx \
  web/apps/aquamobil/src/pages/index.ts \
  tools/quality/format-scope.json
slice_finding_id="$(jq -sre --arg title 'AquaMobil tablet board lacks one read-only composition boundary' '[.[] | select(.title == $title) | .id] | if length == 1 then .[0] else error("expected one finding") end' docs/reviews/_registry/findings.jsonl)"
[[ "$slice_finding_id" =~ ^[A-Z][A-Z0-9-]*-HIGH-[0-9]{3}$ ]]
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "feat(aquamobil): activate the tablet product board" \
  -m "Compose shared unit, report, and chat authorities behind one two-dimensional shell seam." \
  -m "Closes: docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md#$slice_finding_id"
npx nx affected --target=lint --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=test --base=origin/main --head=HEAD --skip-nx-cache
npx nx affected --target=build --base=origin/main --head=HEAD --skip-nx-cache
git push
```

---

### Task 17: Verify V1–V5 before product finding closure

**Files:** None. This task makes no code, configuration, generated-artifact, or documentation edit
and creates no commit.

**Interfaces:**

- Consumes: protected `origin/main` after all V1–V5 implementation and reconciliation PRs, their
  immutable records, generated artifacts, canonical AquaMobil commands, and the exclusion boundaries
  for delivery/appearance and VFD/V6 work.
- Produces: read-only final verification evidence consumed by Task 18. It creates no branch content,
  release claim, appearance/PWA change, VFD surface, or convergence decision.

- [ ] **Step 1: Enter exact reconciled product main and refresh overlap checks one final time**

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
for v4_owner_slice in V1 V2 V3 V4 V5; do
  git show "origin/main:docs/superpowers/evidence/aquamobil-v4/slices/$v4_owner_slice/merge.json" |
    jq -e --arg slice "$v4_owner_slice" \
      '.slice == $slice and (.implementationBoundaries | length == 1)'
done
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/verify-ledger.mjs" \
  --source-history docs/superpowers/evidence/aquamobil-v4/source-commits.json \
  --ledger docs/superpowers/evidence/aquamobil-v4/execution-ledger.json \
  --merge-resolutions docs/superpowers/evidence/aquamobil-v4/merge-resolutions.json \
  --verify-main-ancestors origin/main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git status --short
```

Expected: all five immutable records and their source-owner dispositions verify on exact protected
main, and the coordinator remains clean. A missing record, nonancestor boundary, unresolved overlap,
or stale coordinator blocks final verification.

- [ ] **Step 2: Prove generated and request-contract integrity**

```bash
npm run apollo-router:compose
npm run codegen:check
npm run graphql:validate-registry
npm run gates:graphql-contracts
npm exec -- jest --config tests/invariants/jest.config.ts \
  --selectProjects layer-1 --runInBand --runTestsByPath \
  tests/invariants/aquamobil-generated-input-authority.spec.ts
! rg -n 'mutation\s+[A-Za-z]' web/apps/aquamobil/src/pwa/operation-registry.ts
! rg -n 'export\s+interface\s+(MortalityInput|CullInput|HarvestInput|LiceCountInput|WelfareAssessmentInput|EscapeIncidentInput|FeedingInput|RecordMealFeedingPayload|ClockInInput|ClockOutInput|GeoLocation|CreateLeaveRequestInput|ChecklistItemSetInput|TransferInput|CreateWaterQualityInput|StockMovementInput|StockTransferInput|AcknowledgeAlertInputPayload)' \
  web/apps/aquamobil/src/types/index.ts
```

Expected: all commands PASS and both negated searches print nothing. Generated aliases remain the
only GraphQL input authority, replay mutation source lives under `src/graphql/`, and the positive
queue registry still has one entry per operation.

- [ ] **Step 3: Prove product-surface truthfulness and reachability**

```bash
npm --prefix web/apps/aquamobil test -- \
  src/layouts/__tests__/board-breakpoint.spec.ts \
  src/layouts/__tests__/AppShell.spec.tsx \
  src/hooks/__tests__/useTanks.stock-projection.spec.ts \
  src/pages/scan/__tests__/resolveScannedUnit.spec.ts \
  src/pages/scan/__tests__/ScanPage.route.spec.tsx \
  src/pages/reports/__tests__/ReportsPage.outage.spec.tsx \
  src/pages/storage/__tests__/StorageHubPage.outage.spec.tsx \
  src/pages/messaging/__tests__/ChannelListPage.outage.spec.tsx \
  src/pages/tablet/__tests__/BoardPage.spec.tsx \
  src/pages/tablet/__tests__/ChatBoardPage.spec.tsx \
  src/pages/tablet/__tests__/ReportsBoardPage.spec.tsx
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/query-error-surface.invariant.spec.ts \
  src/__tests__/route-reachability.invariant.spec.ts \
  src/__tests__/remaining-page-semantics.invariant.spec.ts
! rg -n "useVfd|VfdDrive|DrivePane|driveCommand|startDrive|stopDrive|VFD_" \
  web/apps/aquamobil/src/pages/tablet
```

Expected: all tests PASS; active-stock projection gaps fail closed, scanner ambiguity/foreign URLs
cannot navigate, phone shrink preserves Reports/Chat destinations, and the negated final search
prints nothing, proving there is no drive query, command, route, pane, control, or operation in the
product-board slice.

- [ ] **Step 4: Run canonical package verification**

```bash
npm --prefix web/apps/aquamobil test
npm --prefix web/apps/aquamobil run typecheck
v4_build_id="$(git rev-parse HEAD)"
[[ "$v4_build_id" =~ ^[0-9a-f]{40}$ ]]
AQUAMOBIL_BUILD_ID="$v4_build_id" npm --prefix web/apps/aquamobil run build
product_base="$(jq -r '.baseMainCommit' \
  docs/superpowers/evidence/aquamobil-v4/slices/V1/preflight.json)"
[[ "$product_base" =~ ^[0-9a-f]{40}$ ]]
git merge-base --is-ancestor "$product_base" HEAD
npx nx affected --target=lint --base="$product_base" --head=HEAD --skip-nx-cache
npx nx affected --target=test --base="$product_base" --head=HEAD --skip-nx-cache
npx nx affected --target=build --base="$product_base" --head=HEAD --skip-nx-cache
npm --prefix web/apps/aquamobil run test:invariant -- \
  src/__tests__/design-token.invariant.spec.ts \
  src/__tests__/field-ergonomics.invariant.spec.ts \
  src/__tests__/query-error-surface.invariant.spec.ts \
  src/__tests__/route-reachability.invariant.spec.ts
git status --short
```

Expected: canonical tests, standalone typecheck, production build, all Nx projects affected since
the immutable V1 creation base, and focused invariants PASS. The worktree contains no unstaged
generated output or uncommitted implementation files.

- [ ] **Step 5: Repeat the product-wide production dependency classification**

Run the complete Production Dependency Checkpoint with `v4_product_slice=product-final`. Compare its
root and standalone statuses, source maps, and exact `npm explain` paths with the V1–V5 records.
Require the final repository workflow to upload the fixed directory and let the program capture its
server artifact ID/name/digest as closure verification input. No worker writes an artifact URL or
classification into the central ledger. A newly affected, unclassified, or affected-and-reachable
high/critical path blocks handoff; do not run an audit fixer or alter dependency state.

- [ ] **Step 6: Hand verified slice evidence to the closure task**

Give the five merged product slices and their verification evidence to Task 18 and the owner of
`docs/superpowers/plans/2026-08-26-aquamobil-v4-safe-integration-program.md`; do not edit that
program plan from this no-edit task. The following ownership boundaries remain unchanged:

- final theme activation, global Konsta/legacy-utility bans, PWA generation handshake, and release
  convergence continue in `docs/superpowers/plans/2026-08-26-aquamobil-v4-delivery-appearance.md`;
- F3–F5, all VFD schema/runtime work, and V6 mobile/tablet drive surfaces continue only in
  `docs/superpowers/plans/2026-08-26-aquamobil-v4-vfd-feeding-loop.md`;
- do not cherry-pick or otherwise transplant the source branch during either handoff.

---

### Task 18: Close V1–V5 findings through a separate protected PR

**Files:**

- Create: `docs/evidence/aquamobil-v4-product/finding-closure-map.json`
- Modify: `docs/reviews/_registry/findings.jsonl`
- Modify: `docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md`
- Create: five `docs/compliance/evidence/<UPPERCASE-ID>.md` entries, one per allocated product HIGH
  finding ID
- Modify: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: five protected, merged slice PRs and their V1–V5 reconciliation records; Task 17
  verification; and the exact IDs allocated in Task 0.
- Produces: a five-entry ID-to-main-SHA closure map, five HIGH attestations, RESOLVED
  registry/review state, and immutable inputs for the program's product-closure reconciliation. It
  hand-edits neither `execution-ledger.json` nor any slice `merge.json`, and closes no delivery,
  feeding, or VFD finding.

- [ ] **Step 1: Create a coordinator-owned closure worktree from fully reconciled product main**

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
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" create-finding-closure \
  --closure product-high-findings \
  --main-ref origin/main
PRODUCT_CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure product-high-findings)"
PRODUCT_CLOSURE_BRANCH="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-branch --closure product-high-findings)"
test "$PRODUCT_CLOSURE_WORKTREE" = \
  '/var/aqua-saas/.worktrees/aquamobil-v4-product-findings-close'
test "$PRODUCT_CLOSURE_BRANCH" = 'chore/aquamobil-v4-product-findings-close'
cd "$PRODUCT_CLOSURE_WORKTREE"
test "$(git branch --show-current)" = "$PRODUCT_CLOSURE_BRANCH"
test -z "$(git status --porcelain)"
ROOT_LOCK_SHA256="$(sha256sum package-lock.json | cut -d' ' -f1)"
AQUAMOBIL_LOCK_SHA256="$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)"
npm ci --ignore-scripts --no-audit
npm --prefix web/apps/aquamobil ci --ignore-scripts --no-audit
test "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$ROOT_LOCK_SHA256"
test "$(sha256sum web/apps/aquamobil/package-lock.json | cut -d' ' -f1)" = \
  "$AQUAMOBIL_LOCK_SHA256"
git diff --exit-code -- package-lock.json web/apps/aquamobil/package-lock.json
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
npm run findings:verify
```

`create-finding-closure` rejects the request unless all V1–V5 implementation and reconciliation
records are protected-main-reachable and each immutable `merge.json` contains its one plan-pinned
`implementationBoundaries[]` entry. Each boundary must carry a protected HTTPS PR URL and full
resulting main SHA whose GitHub attestation names this repository, merged state, matching head/base,
and a distinct approving reviewer. Missing reconciliation, foreign evidence, or branch-head-only
evidence blocks closure.

- [ ] **Step 2: Generate the five-entry closure map from immutable boundary evidence**

Use only the Order 0 capture authority. It reads the `product-high-findings` title/owner pins from
`slice-branches.json`, walks each owner's immutable `implementationBoundaries[]` PR/resulting-main
attestations, resolves preserved or squash-body trailers through GitHub API and Git, and rejects a
missing, duplicate, foreign, or nonancestor candidate:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --capture-finding-closures product-high-findings \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main \
  --write docs/evidence/aquamobil-v4-product/finding-closure-map.json
jq -e 'length == 5 and all(to_entries[]; (.key | test("^[A-Z][A-Z0-9-]*-HIGH-[0-9]{3}$")) and (.value | test("^[0-9a-f]{40}$")))' \
  docs/evidence/aquamobil-v4-product/finding-closure-map.json
```

The map stores the actual main-reachable implementation commits, never a slice reconciliation SHA or
the later closure-PR merge SHA. `closingCommitsByFinding` is absent from every slice `merge.json`;
only the later append-only program closure record stores that derived field.

- [ ] **Step 3: Close registry rows, update the review, and attest every HIGH finding**

```bash
jq -r 'to_entries[] | [.key, .value] | @tsv' \
  docs/evidence/aquamobil-v4-product/finding-closure-map.json |
  while IFS=$'\t' read -r finding_id closing_sha; do
    npm run findings:close -- "$finding_id" "$closing_sha"
  done
npm run findings:verify
```

Use `apply_patch` to mark exactly the five review headings `RESOLVED`, add their full closing SHAs
and merged PR URLs. Create one repository-template attestation under `docs/compliance/evidence/` per
uppercase ID, with the filename exactly `<UPPERCASE-ID>.md`. Each attestation names the actual full
SHA, protected PR, authenticated author, distinct reviewer, slice-specific tests, and ongoing
invariant; template values, short SHAs, self-review, and copied evidence across slices fail. Task
17's run is supplied to the later program-owned closure reconciliation, never appended manually to
the generated ledger.

- [ ] **Step 4: Push, merge, and verify the product closure**

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
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
npx ts-node --project tools/gates/tsconfig.json tools/gates/compliance-attestation-coverage.ts
npm run quality:format-scope:generate
mapfile -t product_attestation_files < <(
  jq -r 'keys[] | "docs/compliance/evidence/\(.).md"' \
    docs/evidence/aquamobil-v4-product/finding-closure-map.json
)
test "${#product_attestation_files[@]}" -eq 5
for product_attestation_file in "${product_attestation_files[@]}"; do
  test -f "$product_attestation_file"
done
git add -- \
  docs/evidence/aquamobil-v4-product/finding-closure-map.json \
  docs/reviews/_registry/findings.jsonl \
  docs/reviews/codex/2026-08-26-aquamobil-v4-product-surfaces.md \
  "${product_attestation_files[@]}" \
  tools/quality/format-scope.json
git diff --cached --check
npm run quality:format-scope:generate
git add -- tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --cached --check
git commit -m "chore(review): close AquaMobil product findings"
git push --set-upstream origin "$PRODUCT_CLOSURE_BRANCH"
```

Open the protected closure PR and obtain a distinct approval. Before merge, prove its current
checks, state, base, head, and exact non-duplicating trailer set:

```bash
COORDINATOR_WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-coordinator
test -d "$COORDINATOR_WORKTREE"
git -C /var/aqua-saas fetch origin +refs/heads/main:refs/remotes/origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" status --porcelain)"
git -C "$COORDINATOR_WORKTREE" switch --detach origin/main
test -z "$(git -C "$COORDINATOR_WORKTREE" branch --show-current)"
test "$(git -C "$COORDINATOR_WORKTREE" rev-parse HEAD)" = \
  "$(git -C /var/aqua-saas rev-parse origin/main)"
PRODUCT_CLOSURE_WORKTREE="$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure product-high-findings)"
cd "$PRODUCT_CLOSURE_WORKTREE"
product_closure_pr_number="$(gh pr view --repo Okan-wqm/aquaculture_platform \
  --json number --jq '.number')"
gh pr checks "$product_closure_pr_number" \
  --repo Okan-wqm/aquaculture_platform --watch --fail-fast
gh pr view "$product_closure_pr_number" --repo Okan-wqm/aquaculture_platform \
  --json state,reviewDecision,baseRefName,headRefName \
  --jq 'select(.state == "OPEN" and .reviewDecision == "APPROVED" and .baseRefName == "main" and .headRefName == "chore/aquamobil-v4-product-findings-close")'
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/capture-github-evidence.mjs" \
  --verify-prospective-closure-pr "$product_closure_pr_number" \
  --repository Okan-wqm/aquaculture_platform \
  --verify-base-advance \
  --require-latest-merge-queue-candidate \
  --forbid-duplicate-closing-trailers
```

Merge without bypass. Fetch `origin/main` and re-run the registry, attestation, ledger, five-map,
and main-ancestor checks against files read from `origin/main`. Then remove only the clean linked
worktree through the coordinator:

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
node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" cleanup \
  --closure product-high-findings \
  --repository Okan-wqm/aquaculture_platform \
  --main-ref origin/main
test ! -e "$(node "$COORDINATOR_WORKTREE/tools/aquamobil-v4/worktree.mjs" \
  print-path --closure product-high-findings)"
```

Only after cleanup, run the integration program's serialized product-closure reconciliation. That
fresh branch creates only
`docs/superpowers/evidence/aquamobil-v4/closures/product-high-findings.json` and regenerates the
central ledger from immutable slice/closure inputs; it records the protected closure PR attestation,
resulting main commit, five `closingCommitsByFinding` entries, and Task 17 workflow attestation. UI
convergence cannot start until this reconciliation PR is reviewed, merged, and an `origin/main`
ancestor.
