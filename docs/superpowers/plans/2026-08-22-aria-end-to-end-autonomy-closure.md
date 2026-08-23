# ARIA End-to-End Autonomy Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close ARIA's existing runtime, learning, pre-merge, observation, readiness, and
staged-autonomy loops with target-SHA-bound live evidence, without adding the separate ARIA Work
Protocol/Superpowers feature set.

**Architecture:** `origin/main` is the executable authority and `origin/aria/state` is the
append-only external runtime-evidence carrier; neither may substitute for the other. The work
proceeds from truthful status and executor stability through the learning funnel and seven pre-merge
checks, then proves whole-repository observation and opens autonomy only through the existing
risk/readiness/unlock authorities.

**Tech Stack:** Python 3 (`aria-kernel`, `unittest`/pytest), TypeScript/Node 20 (`ts-node`, Jest/Nx
invariants), GitHub Actions, GitHub App installation tokens, append-only hash-chained JSONL ledgers,
Git worktrees.

**Specs:** `docs/aria/CURRENT_STATE.md`, `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md`,
`docs/aria/MISSION_SPEC.md`, `docs/aria/policy/autonomy-unlock.json`

## Verified Baseline and Closure Boundary

This baseline was re-derived on 2026-08-22 from executable code at
`origin/main@d18391e905c88ee2c91b93dd572b0a77577ddd42` and runtime evidence at
`origin/aria/state@dfe95cebc49b6b16df363baba57d2f579ab100ed`:

- The two refs have merge-base `6a4c311`; the state ref is not a code branch and must never be used
  as an implementation base.
- Of 60 recorded cycles, 20 are complete and 10 failed; the most recent recorded cycle failed.
- The learning state contains 26,317 raw findings, but no promoted finding, fixture run, adapter
  calibration report, or enterprise-readiness claim.
- There are 698 agent requests and 176 agent results. The latest 26-job drain produced one success
  and 25 mostly unclassified `claude_cli_exit_1` failures.
- The pre-merge perimeter is invoked by merge authority, but all seven required checks currently
  route through `_not_implemented(...)`, so autonomous merge is correctly fail-closed.
- Producer wiring for readiness, promotion, and executor draining exists in code. Older statements
  that these paths are wholly decorative are stale; live success evidence is still absent.
- `orphan-findings.md` contains 666 unique ORPHAN headings; 561 of those IDs are absent from the
  central structured registry. ORPHAN 775-792 are all absent and are the explicit closure scope
  here. Task 1 imports that scoped set, records the wider historical migration as unresolved debt,
  and never claims global parity.
- The targeted baseline suites passed 47 Python tests and 29 git-aware TypeScript invariant tests.
  That is `code_proven` evidence only.

ARIA is closed only when it can autonomously plan, implement, open a PR, test, risk-gate, merge,
prepare rollback evidence, and record incident state within its approved risk profile. Production
deployment, production migration, secret rotation, and production feature-flag changes remain
human-authorized actions.

## Global Constraints

- Start execution in an isolated worktree created from the current `origin/main`. The measured
  baseline remains pinned at `d18391e905c88ee2c91b93dd572b0a77577ddd42`; before Task 1, verify every
  newer main commit is its descendant and does not overlap Task 1's authority paths. Record that
  check and the actual branch-base SHA in the SDD ledger.
- After each merged task/PR, fetch and create the next isolated worktree from the new `origin/main`
  descendant; never stack a live-proof task on an unmerged feature branch.
- Each task is its own reviewable PR unless its steps explicitly name a coupled task range. A
  scheduled/live checkpoint begins only after its producer PR is reachable from `origin/main`.
- Treat `origin/aria/state@dfe95cebc49b6b16df363baba57d2f579ab100ed` only as live-ledger input. It
  is not descended from the code target and contains no executable ARIA authority.
- Preserve the existing dirty `/var/aqua-saas` checkout and its untracked files. Do not implement
  from that checkout.
- Use London-school TDD for every code task: failing test, observed failure, minimum architectural
  implementation, deliberate direction check, neighbour suite, affected test/lint.
- No placeholder pass, bypass, compatibility shim, direct-main write, PAT path, force push, hook
  bypass, production deployment, production migration, secret rotation, or production feature-flag
  change.
- A local or CI test proves `code_proven`; only a scheduled/live row bound to the expected commit
  proves `live_proven`.
- Every capability declares the exact code/policy/workflow authority paths that invalidate its
  proof. A live row may project from its own reachable event SHA to a later evaluation SHA only when
  the canonical hash of that capability authority set is unchanged; otherwise the originating live
  checkpoint must be rerun before proceeding.
- After every merged PR, run `autonomy status --evidence` at the new main tip and record which
  capability hashes changed. Before crossing the next execution gate, rerun every invalidated
  checkpoint; a later unrelated green capability cannot cover it.
- Finding lifecycle is `OPEN -> IN-PROGRESS -> RESOLVED`. A finding is never registered RESOLVED at
  birth and is closed only after the fixing commit is reachable from `origin/main`.
- Push after every commit on the active feature branch. Every fix commit carries the governed
  `Closes:` trailer required by `CLAUDE.md`.
- Use `feat/aria-autonomy-closure-task-<NN>` branches so pre-PR pushes do not also match the
  repository's `feature/*` push workflows. Finish local TDD and Superpowers review before opening
  each PR; after PR creation, do not push or manually rerun a workflow unless a concrete failed
  check/review finding requires a new head. A new head legitimately creates a new check set, but
  runtime/state producers must remain idempotent and may never append duplicate success rows for the
  same stable identity.
- Every implementation PR must pass the current protected-main contract—`sens-enterprise-summary`,
  `merge-gate`, `aria-merge-authority`, and `build-status`—and receive the required eligible human
  approval before a human-authorized squash merge. Never use an admin bypass. The implementation
  ceremony is distinct from ARIA's later, operator-ceiling-controlled runtime merge evidence.
- Before a task without an already named finding writes its first failing test, allocate and claim a
  structured finding for the measured gap. Set `ARIA_TASK_FINDING_REF` to its exact
  `docs/reviews/...#ID` reference; commit snippets without a literal known finding must append
  `-m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"`.
- Any additional governed finding discovered during Tasks 2-19 must be added to
  `docs/aria/policy/autonomy-closure-findings.json` through a dedicated reviewed policy-only PR
  before implementation resumes. The entry names its owner task and required closure predicate; this
  prevents late failures from falling outside Task 20's derived set.
- For entries in that closure policy, fixing tasks establish code/live evidence and a reachable
  `Closes:` commit but do not invoke `finding-registry close`; Task 20 PR B performs the single
  batched structured closure after every predicate is independently green. Unrelated product
  findings keep their normal lifecycle.
- The separate ARIA-native Superpowers Work Protocol design is not implemented by this plan. Its
  planning starts only after Task 20's closure verdict is green.

## Execution Gates

| Gate                   | Tasks | Exit condition before the next gate                                                                                                      |
| ---------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Truth and authority    |   1-3 | Scoped finding authority is machine-owned; evidence status is read-only/target-bound; server merge cannot stale an unchanged stamp       |
| Runtime and learning   |   4-7 | Three classified drains pass live; one real finding traverses the full learning funnel without duplicate promotion                       |
| Merge safety           |  8-12 | The immutable snapshot is complete and all seven concrete checks fail closed under mutation                                              |
| Whole-repo observation | 13-17 | Every behavioral file is meaningfully observed; scheduler-selected product slice merges with a verified witness                          |
| Mode A and readiness   |    18 | App-only mutation, signed readiness v3, branch-protection v4, remote CAS, and disposable restore are live-proven                         |
| Staged autonomy        |    19 | Real outcome counters advance in order, at least one L1 authority merge maps pre-merge proof to merged main, and freeze paths are proven |
| Closure                |    20 | Three-PR reachability ceremony ends with the two-SHA closure verdict green                                                               |

---

### Task 1: Reconcile the narrative and structured finding authorities

**Files:**

- Create: `docs/superpowers/plans/2026-08-22-aria-end-to-end-autonomy-closure.md`
- Modify: `tools/gates/finding-registry.ts`
- Modify: `tools/gates/finding-registry-store.spec.ts`
- Modify: `tests/invariants/three-store-invariants.spec.ts`
- Create: `docs/aria/policy/autonomy-closure-findings.json`
- Create: `docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md`
- Modify: `.github/CODEOWNERS`
- Modify: `docs/plans/2026-07-26-aria-software-team-program/PLAN.md`
- Modify: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md`
- Modify: `docs/plans/2026-08-02-aria-full-autonomy-program/PROGRESS.md`
- Modify: `docs/aria/MISSION_SPEC.md`
- Modify: `docs/aria/CURRENT_STATE.md` through `aria-authority-hash.ts --write` only
- Modify: `docs/reviews/_registry/findings.jsonl` through `tools/gates/finding-registry.ts` only
- Read: `docs/reviews/orphan-findings.md`

**Interfaces:**

- Consumes: orphan headings and the existing append-only registry CLI.
- Produces: a governed `import-narrative` path and registry rows for ORPHAN 775-792.
- Produces: CODEOWNERS-protected `aria/autonomy-closure-findings/v1`, the only source for Task 20's
  closure finding set.

- [ ] **Step 1: Write the failing scoped-authority test**

Do not assert global narrative-to-registry parity: the current narrative has 666 unique ORPHAN
headings and 561 are absent from the structured registry. Importing only the newest 18 could never
make that assertion green, while importing all historical prose is a separate governance migration
outside this closure.

Instead, pin the explicit closure scope and require every scoped ID to exist both at its narrative
anchor and in the registry:

```ts
it('registers every finding in the ARIA closure policy', () => {
  const policy = loadAutonomyClosureFindings();
  const narrative = readFileSync(resolve(REPO_ROOT, 'docs/reviews/orphan-findings.md'), 'utf8');
  const registryIds = new Set(loadRegistryRows().map((row) => row.id));
  for (const entry of policy.entries) {
    expect(registryIds.has(entry.finding_id)).toBe(true);
    if (entry.narrative_anchor) {
      expect(narrative).toContain(`## ${entry.finding_id} `);
    }
  }
});
```

The policy schema requires unique `task_id` and `finding_id`, `owner_task`, `required_predicate`,
`closure_mode`, review anchor, optional ordered historical-fix SHA list plus closing-SHA rule, and
regression-test refs. Its envelope is `$schema: "aria/autonomy-closure-findings/v1"`,
`schema_version: 1`, `policy_id: "aria-end-to-end-autonomy-closure"`, and `entries`. The closed
`closure_mode` vocabulary is `historical_main`, `task_commit`, or `task_commit_and_live`; the closed
`closing_sha_rule` vocabulary is `last_historical_fix` or `task_commit`. It must include every ID
from 775 through 792 exactly once plus every new finding allocated for Tasks 2-20A. Removal,
weakening, or reassignment is a reviewed policy migration, never a runtime input or caller-supplied
list.

- [ ] **Step 2: Run the test and capture the exact missing set**

Run:

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/three-store-invariants.spec.ts
```

Expected: FAIL because the closure policy and its 18 structured registry rows do not exist.
Separately record the 561-item global narrative debt as out-of-scope; do not label it resolved.

- [ ] **Step 3: Write the failing governed narrative-import tests**

The existing `add-explicit` path consults narrative headings as claimed sequences and therefore
correctly refuses these IDs as duplicates. Add `node:test` cases for a new narrow command:

```text
finding-registry import-narrative <stub.json>
```

It passes only when the exact ID occurs exactly once in `orphan-findings.md`, is absent from the
registry and sibling registries, the stub severity matches the ID/heading, and its
`review_file`/evidence anchor resolves to that heading. It refuses an unrelated claimed sequence,
ambiguous heading, changed severity, missing heading, or already-imported row.

Every import is born `OPEN`; the prose's historical RESOLVED label is copied into evidence/notes,
not asserted as current structured state. This preserves the rule that structured closure needs a
main-reachable commit carrying the matching `Closes:` trailer.

- [ ] **Step 4: Implement and use the governed historical import**

Use `finding-registry.ts import-narrative` for these exact IDs and severities, all initially `OPEN`,
with `review_file=docs/reviews/orphan-findings.md` and evidence pointing at their heading:

```text
HIGH: 775, 777, 778, 779, 780, 781, 782, 784, 786, 787, 788, 790, 791
CRITICAL: 776
MEDIUM: 783, 785, 789, 792
```

Create each import stub outside the repository, invoke:

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/finding-registry.ts import-narrative /absolute/path/to/stub.json
```

Do not hand-edit hashes and do not copy prose status `RESOLVED` into a birth state.

- [ ] **Step 5: Pin historical provenance and allocate every future task finding**

Populate `autonomy-closure-findings.json` with an explicit row for each 775-792 finding. For rows
already fixed on main, store the measured historical fix SHA(s), closing SHA selection, and exact
regression-test refs. Seed from this verified mapping; any mismatch is red, not a reason to guess
another commit:

| Finding | Main-reachable historical fix / owner                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 775     | `84404283f64ef15487fac8e7a7d7aa683feeae94` + Task 1 traceability trailer                                                                                 |
| 776     | `a16977a968d72a0957b271e3609ff398b6d9c85b`                                                                                                               |
| 777     | Feature provenance `b2e8ea6241d7b5f6ef5bd212c43cf9f95a4a4585`; main integration `d7fa539ea03a52ff2cf5e21a9253d4d7cb84f311` + Task 1 traceability trailer |
| 778     | Feature provenance `260620fbbcf289c75135b635d970f2134256164c`; main integration `d7fa539ea03a52ff2cf5e21a9253d4d7cb84f311` + Task 1 traceability trailer |
| 779     | `620683fc9a089790b18bc96b91e0f180fb2c7b63`                                                                                                               |
| 780     | `960b8902b9ec11d5c97dd022c52e38928628f257`, `b048624cd76054efb4fa7c7a8e67d2ea3b7f76d9`, `2d9f672d74f559c7163a2e649000cbaa79b259fb` (last is closing SHA) |
| 781     | `a7f375ec18e81e3ebf3a71d078e7d4b5332cb886`                                                                                                               |
| 782     | `2e9a6929e6a14717aa1725d9511ae0267b3d288c`                                                                                                               |
| 783     | `7a49ebfca19fb175d95cfebac8e9ba8fd19fcacb`                                                                                                               |
| 784     | `f19264a48ccb67d989c3db01982904497bb5cf52`                                                                                                               |
| 785     | `16f8ba624729a3d427a3d5ff59f784e4cee4dbca`                                                                                                               |
| 786     | `61632372ef765d1dbb0b9cd46673eb98fa2d0815`                                                                                                               |
| 787     | `bd605b5cba516d44e5f879a90ade8adbe6d7b26c`                                                                                                               |
| 788     | `b19fee8b4fd7ee84caa530aa06b76784557ef044`                                                                                                               |
| 789     | Task 18 code + operator/live checkpoint                                                                                                                  |
| 790     | `8daedd72ff6c83460b0631a513e5c1585dac75e4`                                                                                                               |
| 791     | `80f92eb6f15520b505bdf6f3b4e6c486784b094b`                                                                                                               |
| 792     | Task 3 server-merge-safe authority fix                                                                                                                   |

The matching-trailer fixes include 776, 779-788, 790, and 791. Task 3 owns new closure for 792 and
Task 18 owns the operator/live closure for 789. ORPHAN 775, 777, and 778 were renumbered after their
historical fixes and have no matching new-ID trailer, so this Task 1 provenance commit must cite
their historical fix SHA/regression tests and carry their exact `Closes:` trailers; Task 20 may then
close them against this reachable traceability commit. Do not misassign 788 to Task 18.

Before this PR is finalized, allocate one structured finding in the new `ARIA` domain from
`docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md` for every task without a named
existing finding. Use the registry's domain-wide allocator rather than hard-coding numeric suffixes,
and use these exact rows as the audit/registry source values:

| Task | Severity | Title                                                                | Required predicate                                      |
| ---- | -------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| 2    | HIGH     | Target-bound autonomy evidence status is absent                      | `autonomy_evidence_status_code_proven`                  |
| 4    | HIGH     | Executor failures collapse into unclassified process exits           | `executor_failure_contract_code_proven`                 |
| 5    | HIGH     | Repeated executor environment failures requeue the same work         | `three_classified_live_drains`                          |
| 6    | HIGH     | The learning funnel has no end-to-end evidence join                  | `learning_funnel_code_proven`                           |
| 8    | HIGH     | Pre-merge checks lack an immutable evidence snapshot                 | `pre_merge_snapshot_code_proven`                        |
| 9    | HIGH     | Branch tips and overlapping file claims are not locked atomically    | `branch_and_file_claim_checks_code_proven`              |
| 10   | CRITICAL | Operator feedback is accepted without cryptographic verification     | `operator_feedback_signature_code_proven`               |
| 11   | HIGH     | Merge authority does not bind reconciled budget and plan content     | `budget_and_content_checks_code_proven`                 |
| 12   | CRITICAL | Seven declared pre-merge controls still resolve to placeholders      | `seven_pre_merge_checks_live_proven`                    |
| 13   | HIGH     | ARIA cannot meaningfully observe Rust runtime safety                 | `rust_observation_shadow_proven`                        |
| 14   | HIGH     | ARIA cannot meaningfully observe migration safety                    | `migration_observation_shadow_proven`                   |
| 15   | HIGH     | ARIA cannot meaningfully observe infrastructure policy               | `infrastructure_observation_shadow_proven`              |
| 16   | HIGH     | ARIA cannot meaningfully observe workflow and shell safety           | `workflow_shell_observation_shadow_proven`              |
| 17   | HIGH     | Whole-repository observation and vertical-slice proof are incomplete | `whole_repo_observation_and_vertical_slice_live_proven` |
| 19   | CRITICAL | Autonomy stages can advance without reconciled real outcomes         | `staged_autonomy_ladder_live_proven`                    |
| 20A  | HIGH     | ARIA has no derived two-SHA autonomy closure verifier                | `closure_verifier_code_proven`                          |

Use owner `platform-autonomy`; the audit headings, registry `review_file`, and policy review anchors
must resolve to the same returned IDs. Tasks 2, 4, 6, 8-11, 13-16, and 20A use `task_commit`; Tasks
5, 12, 17, and 19 use `task_commit_and_live`. Tasks 3, 7, and 18 instead reference their listed
ORPHAN entries. Protect the policy and audit file with CODEOWNERS and add an invariant that the
manifest set is a subset of the registry, has no placeholder IDs, and cannot be narrowed without a
reviewed policy change.

- [ ] **Step 6: Mark earlier ARIA programs historical/superseded**

Add a short, non-destructive status banner to the 2026-07-26 plan and the 2026-08-02 plan/progress
documents. Preserve their measurements and checklists as history; state that they are no longer
executable current authority and point to this closure plan plus `docs/aria/CURRENT_STATE.md`. Do
not mark their unfinished checkboxes complete.

Reconcile `MISSION_SPEC.md` M-6.1 with the already-accepted enterprise target and executable owners.
Replace the stale categorical “No self-merge, ever” wording with the exact live boundary: no
direct/unreviewed self-merge; only `merge_pr_if_ready` may execute a runtime merge, only after an
operator has granted the required profile/stage ceiling, and L3 still requires the existing two-role
human policy approval. ARIA may lower/freeze authority but may not grant or raise its own merge
authority. This implementation program's PRs remain human-approved squash merges under protected
`main`; they do not count as ARIA autonomous-merge evidence.

- [ ] **Step 7: Verify the registry, policy, and three-store invariants**

Stage the new/changed files under the ARIA authority roots before invoking the hash writer; its
tracked-only digest correctly refuses an untracked authority file. Then generate and verify the
single `CURRENT_STATE.md` pin:

```bash
git add docs/aria/policy/autonomy-closure-findings.json docs/aria/MISSION_SPEC.md
npm run aria:authority-hash -- --write
git add docs/aria/CURRENT_STATE.md
npm run aria:authority-hash -- --check
npm run aria:docs:ssot
```

Do not type or copy the digest from test output. The writer is the only producer; the check and
documentation invariant are consumers of that same normalized authority surface.

Run:

```bash
npm run findings:verify
npm run gates:finding-registry:test
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/three-store-invariants.spec.ts
```

Expected: all PASS; the registry hash chain remains valid, the exact closure set is complete, and no
test claims global narrative parity.

- [ ] **Step 8: Commit and push**

```bash
git add tools/gates/finding-registry.ts tools/gates/finding-registry-store.spec.ts \
  tests/invariants/three-store-invariants.spec.ts \
  docs/superpowers/plans/2026-08-22-aria-end-to-end-autonomy-closure.md \
  docs/aria/policy/autonomy-closure-findings.json \
  docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md \
  docs/reviews/_registry/findings.jsonl .github/CODEOWNERS \
  docs/plans/2026-07-26-aria-software-team-program/PLAN.md \
  docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md \
  docs/plans/2026-08-02-aria-full-autonomy-program/PROGRESS.md \
  docs/aria/MISSION_SPEC.md docs/aria/CURRENT_STATE.md
git commit -m "test(aria): bind orphan narrative findings to the registry

Import the scoped 775-792 history, pin historical fix provenance, and bind
every closure task to the CODEOWNERS-reviewed finding set.

Closes: docs/reviews/claude/2026-08-20-aria-authority-chain-audit.md#ORPHAN-HIGH-766
Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-775
Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-777
Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-778"
git push
```

### Task 2: Add the derived autonomy evidence status surface — controller-reviewed correction

This executable correction supersedes the conflicting extracted Task 2 text
retained below for audit history.

**Exact files:**

- Create: `aria-kernel/aria_kernel/autonomy_evidence.py`
- Create: `aria-kernel/tests/test_autonomy_evidence_status.py`
- Modify: `aria-kernel/aria_kernel/autonomy_state.py`
- Modify: `aria-kernel/aria_kernel/cli.py`
- Modify: `aria-kernel/aria_kernel/file_lock.py`
- Modify: `aria-kernel/aria_kernel/ledger.py`
- Modify: `aria-kernel/aria_kernel/state_manifest.py`
- Modify: `aria-kernel/aria_kernel/state_snapshot.py`
- Modify: `aria-kernel/aria_kernel/state_store.py`
- Modify: `aria-kernel/tests/test_autonomy_state_reducer.py`
- Modify: `aria-kernel/tests/test_cli_autonomy_subcommand.py`
- Modify: `aria-kernel/tests/test_file_lock_and_claim_idempotency.py`
- Modify: `aria-kernel/tests/test_publish_contention.py`
- Modify: `aria-kernel/tests/test_state_manifest_transaction.py`
- Modify: `aria-kernel/tests/test_state_snapshot.py`
- Modify: `aria-kernel/tests/test_state_store.py`
- Modify: `docs/aria/policy/autonomy-closure-findings.json`
- Modify: `tests/invariants/three-store-invariants.spec.ts`
- Modify: `docs/aria/BEHAVIOUR.md`
- Modify: `tests/invariants/aria-doc-runtime-ssot.spec.ts`
- Modify: this executable plan
- Generate: `docs/aria/CURRENT_STATE.md` only through the authority writer
- Generate if changed: `tools/quality/format-scope.json` only through its
  canonical generator
- Write execution evidence: ignored task-local `task-2-report.md` and
  `progress.md`

Task 2 is an ordered-TDD, read-only projection over exactly seven immutable
`CapabilitySpec` entries. Each entry owns literal producer, authorizing-consumer,
authority, count-surface, native schema/upcaster, terminal, identity/hash, and
authoritative-SHA contracts. Common authority includes the evidence module,
lock and strict-ledger primitives, manifest/snapshot/state-store admission,
tool registry/binding, workspace identity, and closure finding policy. Exact
literal producer roles include every current direct writer even when a writer
is also an authorizing consumer. Generic validation rows and source presence
are never proof. The roster regression is source-derived: an AST scanner
classifies direct ledger readers/writers, imported aliases, path helpers, and
one-level wrappers across the authority modules, then requires each discovered
role to be represented by the literal capability contract or an explicit
observational-only entry with a durable rationale. A hand-maintained expected
roster alone is not sufficient coverage. The scanner walks nested synchronous
and asynchronous function scopes across every existing literal Python authority
path as well as the complete kernel source tree. `tool_health.py` is literal
cycle-runtime authority and a producer because its `append_jsonl()` wrapper can
write `cycles.jsonl`; it is not an observational exception.

Each admitted `EvidenceRef` also carries its producer-native `proof_kind`,
`schema_id`, and `schema_version`; the surface name alone is never a contract
discriminator. This extends the superseded extracted dataclass shape below and
prevents schema generations sharing one ledger from being treated as the same
proof.

Proof rows are admissible only when producer-native validation succeeds, their
full event SHA is equal to or a positively proven ancestor of the evaluated
target, and exact target-tree authority path/blob hashes match. Missing paths
bind as `MISSING`; present paths bind the exact Git mode, object type, object
ID, literal path, and blob bytes. Non-regular authority entries, tree/blob read
failures, missing history, and shallow-history
false ancestry are named unavailable states, not absence or non-ancestry.
Before any public derivation, the evaluated target must contain the exact
executing `autonomy_evidence.py` bytes, the current checked-out capability
authority hash must match the target hash, and the union of evaluator authority
paths must be clean including ignored matches. Every Git read preserves ambient
environment while setting `GIT_OPTIONAL_LOCKS=0`.

Evidence admission composes `ensure_tools_dir_readonly()`,
`open_state_store()`, `tools_root()`, `canonical_identity()`, strict immutable
HEAD-blob ledger reads, and its own canonical immutable-snapshot verifier; it
must never call the mutable-worktree `verify_state_store()` path. Before and
after reads it requires a same-common-dir registered worktree, detached
full-SHA HEAD, matching host and published bindings, HEAD equal to tracking and
live remote tips, and exact host-artifact-classified porcelain cleanliness
including ignored paths. The live-tip probe accepts exactly one strict
`<full-sha>\trefs/heads/aria/state` record; an empty, wrong-ref, duplicate,
malformed, or zero-SHA response is unavailable. It then reads `snapshot.json`
from that admitted HEAD, requires the exact `build_snapshot()`
top-level/projection contract, enumerates the complete immutable commit tree,
and streams every claimed surface from its Git blob. Every ledger, including
ledgers not used for capability counts, has
its hash, size, strict chain, row count, and tail hash recomputed from that same
stream; every other surface has hash and size recomputed. Missing claims for
declared non-excluded paths, non-regular claimed paths, excluded claims, and
noncanonical glob paths fail closed. Every proof row and count is parsed from
the admitted state commit rather than mutable worktree bytes. Unavailable
stores expose unavailable counts; absent optional ledgers expose healthy zero;
corrupt committed ledgers raise. The evidence path performs no bootstrap,
fetch, checkout, repair, clean, append, or publish.

The immutable commit-tree contract is an exact allowlist, not only a scan for
known surface patterns. It admits `snapshot.json`, the unchanged regular
`GENESIS` entry from the commit's single parent, optional exact regular-empty
`tools/.gitkeep`, `findings/.gitkeep`, and `workspace/.gitkeep` bootstrap
markers, claimed regular blobs, and only their required tree ancestors. Every
existing declared-root component, including both `workspace` and
`workspace/<repository-identity>`, must be a `040000 tree`; any other blob,
symlink, gitlink, tree, pre-staged entry, merge parent, or unknown path fails
closed. `publish_state()` applies this same canonical verifier to the
just-created immutable commit, captures its exact object ID, rechecks that HEAD
still names it after verification, pushes that object ID rather than symbolic
HEAD. A nonzero push is an ambiguous outcome: a bounded strict remote probe
plus a fetch into an always-cleaned unique ephemeral ref and ancestry proof
reconciles success when the remote tip is the exact commit or a descendant
containing it. A contained descendant is adopted only by a clean, exact
fast-forward of the owned state-worktree HEAD, integrity-index rebuild, and
exact tracking update. Replay is reachable only through a typed contention
carrying the verified winner, loser, and pre-commit base. It re-fetches and
revalidates the winner before replay; if the loser has since become contained,
it adopts that commit without duplicate replay. Only the owned commit may be
rolled back, using an expected-old HEAD compare-and-swap that preserves the
index. Missing, malformed, unavailable, disappearing, tracking-rewound,
unrelated, or ancestry-unverifiable remote history fails closed with the commit
recoverable. Replay failure restores the preserved local ledger and index when
possible and otherwise leaves recoverable staging. Remote tracking refs advance
by compare-and-swap and never rewind.
Surface bytes that disappear between the two cleanliness scans remain dirty.

The unchanged regular `GENESIS` contract is positive: both the state commit and
its single parent must contain the same regular blob. Two consecutive trees
that both omit `GENESIS` are invalid rather than vacuously equal.

Repository identity derivation on this hostile read path is independently
bounded and strict-UTF-8 while retaining the workspace identity precedence:
canonical remote URL, then root commit, then canonical-root basename. It does
not call the workspace helper's unbounded subprocess path, and malformed Git
output becomes a named unavailable state.

All hostile-input reads are explicit resource contracts, not unbounded parser
calls. Evaluator, authority, and policy blobs have per-blob and per-capability
caps; snapshot JSON, commit-tree bytes/entries, each surface blob, total
snapshot input, each evidence ledger, and aggregate evidence input are capped.
Git processes have bounded stdout/stderr and wall-clock lifetimes. JSON nesting,
ledger line length, evidence-ledger rows, and all-snapshot-ledger rows are
bounded before or during streaming, with distinct named fail-closed outcomes
for size, line, row, tree, aggregate, timeout, and unavailable cases. Proof
candidates retain at most 128 distinct target SHAs per capability and 256
globally. They retain one witness per producer-native contract while preserving
only the selected witness candidate's exact admissible same-SHA
`proof_cardinality`; admissible ancestor candidates never inflate the selected
SHA's count. Evidence refs therefore stay
bounded even when a valid ledger contains many duplicate-SHA rows, and the
Mode-A predicate can still require cardinality exactly one.

The manifest owner supplies the single component-aware path matcher used by
manifest resolution, snapshot production, and immutable verification. Its
declared grammar, normalized-path and component-depth limits, deterministic
exact-before-glob ownership, and ambiguity rejection are invariants. The
snapshot producer anchors each supplied root with one build-lifetime directory
descriptor, performs component-wise no-follow discovery under that anchor with
an aggregate work cap, opens final regular files through the same anchored
directory chain, and rechecks the root path's device/inode before return. It uses
the same bounded streaming ledger/hash limits as the verifier and rejects
non-regular matches, symlink ancestry, ownership collisions, corrupt chains,
races, claim-count excess, and byte/work budget excess instead of silently
omitting them. Every snapshot the producer returns therefore satisfies the same
exact typed contract the immutable verifier admits.

Production-shaped RED established that a normal restored state worktree holds
host-only `repo_identity.json`, a reproducible integrity index, and lock
sidecars despite a valid snapshot. Task 2 therefore minimally modifies the
existing state-store owner and adjacent lock helper: admission classifies only
validated exact untracked host derivatives, refuses every ignored path and
every declared/unknown lock, acquires exact manifest/index/state-group
sidecars non-blockingly through worktree removal, and repeats status to narrow
the classification-to-removal race. It never mutates the Git common exclude
file. Ignored user state is preserved by refusal, while ignored declared drift
is also rejected by snapshot verification. Host identity and reproducible
integrity-index bytes are validated exactly; allowed-path content/inode/mode
fingerprints must survive the second status scan, and acquired sidecar locks
remain held through removal. This narrows but does not claim to eliminate a
writer that ignores the repository's locking protocol.

The target-tree policy must be the exact
`aria/autonomy-closure-findings/v1` object, cover the complete 34-finding
closure scope once each, contain only the exact envelope and entry keys/types,
use governed task/severity/status enums, and bind full fixing SHAs plus
regression and immutable-target refs. Every regression and immutable-target ref
must be a canonical relative path that resolves in the target tree to an exact
`100644` or `100755` blob. Each immutable target must contain its finding's
heading token at a line start, either exact `## FINDING_ID` or
`## FINDING_ID ...`; substrings and longer ID prefixes do not match. Malformed
UTF-8, missing headings, non-object JSON, incomplete scope, duplicates, and
extra keys all fail closed. Only the target-tree `ORPHAN-MEDIUM-789` entry may
declare the exact
`enterprise_readiness` / `mode_a_signed_readiness_live_proven` /
`github_app_mode_a_unconfigured` operator prerequisite. Registry OPEN/CLOSED
state is irrelevant; malformed/unreadable policy fails closed; `ARIA-HIGH-001`
cannot self-block. The existing readiness-v2 structural contract remains
auditable/countable but cannot clear the signed Mode-A operator prerequisite;
Task 18 owns the v3-only live contract and post-merge SHA binding. Overall state
is derived internally with active operator
prerequisites first, then the lowest capability state.

Extract `fold_autonomy_state_rows()` without changing legacy JSON behavior.
Add `autonomy status --evidence [--target-sha FULL_SHA]`, reject target without
evidence, and resolve the repository with Git top-level discovery. Update only
the dated authority notice in `BEHAVIOUR.md`; update `CURRENT_STATE.md` only via
the authority writer. Run the controller addendum's focused/adjacent/full Nx,
registry, invariant, docs, format, authority, and diff gates. Write
`task-2-report.md`, make exactly one signed local Task 2 commit with the governed
ARIA-HIGH-001 trailer, and do not push, merge, open a PR, or close the registry
row during the task.

The final affected-test gate has two non-Task-2 failures. The expected
controller-owned `CURRENT_STATE.md` authority pin remains stale until the
canonical writer runs. Independently, the PostgreSQL DR bootstrap invariant
requires all three executable classes while this host's restrictive checkout
umask materializes
`infrastructure/scripts/provider-console-bootstrap-postgres-walg.sh` as
`0700`. Task 2 changes neither that script nor its invariant: the index, Task 2
HEAD, and base `f6a6d2c1395b88d964f9133753f01b41c0f58967` all carry the same
`100755` blob `6a91cc801d170af1e86893a5cc25de77d01947c1`, and an isolated no-cache run in a
clean disposable worktree at that base reproduces the exact expected-73,
received-64 failure. Do not chmod or expand Task 2 to alter that unrelated
surface; record both failures explicitly alongside the green Task 2 gates.

#### Third controlled-freeze correction

Controller review reopened Task 2 for eight concrete defects in the existing
owners. (A) Replay derives its base from the admitted state-worktree HEAD, not a
host-worktree snapshot. (B) Every remote-tip consumer shares the strict
single-record parser above. (C) accepted descendant reconciliation leaves HEAD,
tracking, snapshot, and regenerated integrity index coherent. (D) an observed
remote rewind behind local tracking is a named history mismatch, never a
tracking rewind. (E) rollback uses expected-old HEAD compare-and-swap and does
not reset the index. (F) every fetch uses a unique ephemeral ref that is removed
on success and failure while replay failures preserve recoverable local bytes or
staging. (G) policy refs and heading tokens obey the exact target-tree rules
above. (H) contention carries winner/loser/base identity, revalidates the live
winner, and adopts a now-contained loser without replay.

The correction remains inside `state_store.py`, `autonomy_evidence.py`, and
their existing tests; it creates no new module or subsystem. RED coverage must
exercise malformed/duplicate/wrong remote listings, rollback and tracking
races, accepted-descendant coherence, remote rewinds, cleanup/recovery paths,
loser adoption, and policy path/blob/heading false positives before the focused,
owner, adjacent, and repository gates are rerun.

#### Fourth controlled-freeze correction

Final controller review reopens the third correction only for stronger
existing-owner concurrency and recovery contracts. Snapshot construction and
publication bind one exact base commit: the orchestrator captures HEAD once,
the snapshot reader verifies that exact object before and after its immutable
read, and `publish_state()` verifies the same base again before any index or
worktree mutation. A symbolic-HEAD or tracking-ref approximation is not an
acceptable base proof.

Before replay can reset the worktree, every declared ledger/index recovery
source is validated against its canonical snapshot claim and copied through an
anchored no-follow descriptor chain into an exclusive `0600` staging file.
Declared size, streamed size, digest, per-surface cap, partial-write handling,
and file-plus-directory durability are all verified before the first reset.
Symlinks, FIFOs, path escapes, source replacement, truncated/oversize input,
hash mismatch, or failure to establish durable staging refuse without a reset.
The state-store recovery cap may be larger than the public snapshot cap, but is
still explicit and bounded through the existing snapshot streaming helper.

Failure restoration is an atomic compare-and-swap-like replacement, not a
direct copy over the destination. It traverses the destination through
no-follow directory descriptors, rejects symlink/non-regular destinations,
revalidates the staged source, creates an exclusive same-directory `0600`
ephemeral restore file, fsyncs it, rechecks destination identity, performs a dirfd
rename, fsyncs the parent directory, and securely verifies the restored bytes.
Restored manifest entries and explicit integrity-index groups must match exact
declared size/hash claims before staging is removed. Any restoration or replay
verification failure retains named recovery staging, while every ephemeral
restore file and every successful/fail-before-reset staging directory is
cleaned exactly.

Replay success is also content proof. A fresh exact remote tip must first pass
the canonical immutable single-parent snapshot verifier. The completed tree is
rebuilt as a canonical snapshot, every preserved logical suffix is proved by
row count, content digest, and winner-tail boundary, and derived indexes are
verified. A zero-row replay is valid only when the winner already ends with the
exact staged suffix; a validly rechained mutation of the winner prefix cannot
pass. This supersedes the third-correction shorthand about late loser adoption:
a two-parent commit containing divergent winner and loser histories is invalid
state and must fail `state_publish_outcome_unknown` with zero reset/replay and
the exact loser tree recoverable. The immutable verifier is never weakened or
skipped for a tip considered for adoption.

The final hostile-input correction also routes target-policy refs through the
shared manifest path normalizer and treats only CR/LF as heading line
boundaries; NUL, surrogate, Unicode line-separator, component-depth, byte-length,
and longer-prefix heading lookalikes remain fail-closed. Final artifact tests
must assert exact HEAD/tracking/remote equality, immediate snapshot and index
coherence, transient-ref cleanup on success and failure, index preservation
across rollback CAS, zero reset/replay for invalid remote commits, and atomic
recovery cleanup before the full owner, contention, neighbor, type-check,
registry, invariant, format-scope, authority-pin, and diff gates are rerun.

#### Fifth and final controlled-freeze correction

The fourth-correction statement that the remaining work stays only inside
`state_store.py`, `autonomy_evidence.py`, and their existing tests is
superseded. Production-shaped failure injection exposed shared existing-owner
defects at the state publication, executor-result, fixture-reader, and outage
recovery boundaries. This correction is still Task 2 hardening: it introduces
no mutable dashboard, capability ledger, or product API and does not implement
the target-SHA producer contracts reserved for Tasks 3, 6, and 19. Passing
these code gates is `code_proven` only; scheduled execution evidence remains
required before any `live_proven` state.

Result submission becomes one recoverable operation. Before any terminal
result, the claims ledger records a durable `result_submission_prepared`
journal carrying a stable operation identity, canonical input bindings, and
portable content-addressed response/transcript references. Existing downstream
side effects are append-once under that identity and the terminal result is
last. Claim release, heartbeat, lease-expiry reaping, and external-outage
reaping mutate lifecycle state only inside a claims-plus-results transaction
and recheck the locked history; a prepared or terminal submission therefore
cannot be requeued, released, or revived. Recovery verifies every journal-bound
sealed artifact again before continuing, and terminal idempotency accepts only
the same input binding. Successfully parsed output uses the canonical envelope
binding; malformed output additionally binds its raw digest so two unreadable
payloads cannot collide.

Submission input is read once through a bounded, stable, no-follow descriptor
and then sealed into the existing state package with file and parent-directory
durability. The same rule applies to transcripts. Symlink leaves, replaced
files, oversized or unstable input, absent sealed artifacts, and nonportable
references fail closed. Authority is checked before a new operation creates a
sealed artifact. On journal recovery, exact journal-declared sealed bytes are
verified and reused before consulting a caller-controlled raw path. A missing
raw response or transcript cannot strand a fully sealed operation; a fresh
operation still requires raw input, and a missing/corrupt seal with no raw
recovery source fails closed. Exact token, path, workspace, context, prompt,
transcript, and content bindings continue to reject drift. Abrupt subprocess
death is injected after each durable boundary and after both seals but before
the first side effect; retry from a fresh process must either resume the same
operation exactly once or reject without ledger or untracked-artifact drift.
The journal uses the existing claims ledger and the sealed package uses the
existing state store; neither is a new durable surface.

Contention replay no longer adds producer-foreign top-level keys. Replayed
rows are stored in one exact, versioned transport envelope whose nested
producer row is unchanged and whose transaction/event identity and payload
digest are validated. The outer ledger chain is verified over the exact stored
bytes first; shared logical readers then unwrap the envelope and expose the
producer-native row together with the current outer chain fields. Only replay
internals may consume raw transport rows. Nested, malformed, wrong-surface,
wrong-digest, or producer-chain-bearing envelopes fail closed. Independent
identical producer rows remain distinct, while retrying the same replay
transaction is idempotent even when an ordinary producer has appended after
the completed replay sequence. An exact transaction/event/payload sequence may
occur once anywhere in the winner suffix; partial, reordered, conflicting, or
ambiguous replay identity refuses before any append. All strict custom readers,
including fixture and autonomy-evidence streaming readers, use the same
verified unwrap contract so replayed rows retain their producer schema.

Recovery packages also survive death between staged-manifest durability and
atomic replacement. Before exact package admission, the recovery owner performs
one bounded cleanup of only canonical orphan manifest-staging names while
holding the common Git-dir lifecycle/recovery serialization. Every candidate
must be a no-follow regular `0600` file within the explicit size and count caps;
invalid names, modes, types, symlinks, or excess candidates fail closed before
any unlink. Candidate identities are collected and then all revalidated before
the unlink phase begins, so a later hostile candidate cannot cause partial
cleanup of an earlier valid one. Valid candidates are removed as one set and
the directory is fsynced. Recovery tombstones, replay publication, worktree
cleanup, and artifact publication use the same common-dir lifecycle lock so
cleanup cannot race a publisher or consumer. Recovery-package internals remain
beneath the existing common-dir surface and are not a new ledger.

Fixture evidence reads retain exact producer schemas, stable descriptors, and
explicit file, line, row, nesting, and aggregate bounds. Native fixture-run
schema identity is not rewritten to a generic evidence schema. Snapshot hashing
and hostile-input consumers share the existing bounded streaming primitive,
and every direct ledger reader/writer or one-level wrapper remains classified by
the source-derived `(surface, role)` roster without a roles-by-surfaces
Cartesian approximation. Executor capability authority includes
`agent_surface.py`, `genesis_lifecycle.py`, `context_budget_gate.py`,
`runtime_profile.py`, `agent_contract.py`, `agent_compliance.py`,
`implementation_safety.py`, `agent_genesis.py`, `evidence_trust.py`,
`canonical_path.py`, `tool_health.py`, `ledger_refs.py`, and
`planner_dispatch_hook.py` in addition to the existing executor paths. The
genesis lifecycle is an authorizing result consumer; scheduler/reaper reads
remain explicitly observational. Enterprise readiness treats
`readiness_proofs.py` as an authorizing claim consumer, and pre-merge treats
`merge_authority.py` as a real decision producer. Behavioral target-tree
mutations must change the relevant authority hash. Contentious replay transport
itself is common evidence authority because it can change every replayed
capability row.

RED/GREEN coverage for this freeze includes result-boundary process death,
inverse lifecycle race orders, raw malformed-input binding, missing sealed
artifacts, replay through a real fixture ledger, malformed transport envelopes,
identical-row replay identity, orphan manifest temporaries, outage reaper versus
prepared/accepted submissions, and behavioral authority mutations. After those
focused tests pass, rerun the complete submission/lifecycle, state-store/replay,
fixture/evidence, manifest/snapshot, invariant, compile, registry, format,
authority, documentation, and diff gates. Run the authority writer only after
all manual source and plan bytes are frozen.

#### Sixth and final controlled-freeze correction

The fifth-correction replay shorthand is superseded at the transport and
activation boundaries. Replay transport v2 preserves the producer's exact
current and previous event identities, binds each envelope to one canonical
concrete surface path, and keeps the outer storage chain private from logical
consumers. The producer event ID is recomputed from the nested producer payload
and producer predecessor before admission. V1 transport cannot prove that
identity and is rejected. Retry deduplication is by stable producer identity,
supports one exact common prefix plus a unique tail, reports deduplicated counts
separately, and refuses ambiguous, reordered, cross-shard, aliased-path, or
divergent dual-chain input before any surface is written.

Every snapshot producer and immutable Git reader passes the canonical concrete
claim path into transport verification; a valid August envelope under a
September glob path is invalid even when the synthetic Git or recovery filename
cannot resolve a declared surface by itself. Recovery staging retains the
manifest's exact size, SHA-256, and logical surface instance. After remote
verification and before any reset, each staged blob is re-read through the
bounded no-follow descriptor path and compared with those claims. Ledger bytes
admitted for replay are the same attested byte string that is parsed and held
for replay. Before that materialization, the combined winner-plus-loser raw
bytes are charged at a conservative 16x parser/list/dict expansion factor against
a 256 MiB admission budget; an oversized but otherwise valid replay refuses
before reset. A server-confirmed accepted-loser path performs no replay and
therefore streams the same size/SHA attestation without retaining or charging
parser materialization. Final summary/pattern reads recheck instance, size, and SHA-256 on
the same streamed bytes, so a validly rechained staging replacement cannot be
replayed or self-validate against its own mutation.

The five native-chain knowledge-graph ledgers are a deliberate activation
boundary. A nonempty outer-hashless or mixed ledger makes
`enterprise_readiness` and `autonomy_unlock` machine-visible
`operator_blocked` with
`legacy_kg_canonical_migration_required`. The generic ledger-hash backfill is
forbidden for these files: adding outer fields changes the knowledge-graph row
hash input and breaks the historical `prev_row_hash` chain. Clearing the
blocker requires a separately authorized KG-aware canonical maintenance
migration that verifies the source and recomputes both the native and outer
chains. Task 2 neither performs nor infers that migration. The current
`origin/aria/state` snapshot has none of these five ledgers, so the blocker is
absent there; this is not live execution proof and does not permit a
`live_proven` claim.

All direct logical consumers unwrap verified v2 transport while preserving
their existing malformed-row tolerance where that behavior is diagnostic.
Knowledge-graph writers hold one transaction across native-tail read and outer
append; divergent winner and loser KG suffixes require semantic migration and
fail closed. Claim lifecycle folds and the outage reaper share the complete
producer-native event-time vocabulary, including `occurred_at`, `ts`,
`prepared_at`, `claimed_at`, `released_at`, and `at`, so a newer outage or
requeue cannot be sorted behind an older claim.

These corrections remain Task 2 `code_proven` hardening. They add no product
API, mutable dashboard, deployment authority, generic KG migration, or live
activation evidence. Full Task 2 owner, replay, snapshot, lifecycle, evidence,
compile, invariant, registry, format, authority, documentation, and diff gates
must be rerun on the frozen bytes before the signed follow-up commit.

#### Seventh and final controlled-freeze correction

The reverse governance reader must not infer “no replay transport” merely
because its requested tail limit was reached before an older envelope. Returned
row materialization remains capped by the caller's limit, but the reader walks
the physical ancestry to BOF looking for a transport claim. If one exists
anywhere, the complete stored chain is verified and unwrapped through the
canonical streaming ledger verifier before any producer payload is returned.
Malformed rows that still carry the reserved transport prefix or the complete
reserved-key claim also enter that strict path instead of being silently
skipped. The verifier reads a no-follow stable descriptor in 64 KiB chunks,
uses nonblocking open plus post-open regular-file validation to reject FIFO
swaps, caps rows at 1,000,000 and each line at 1 MiB, and retains only a
caller-limit deque. Reverse discovery applies the same line budget to both
completed rows and its cross-chunk carry before parsing. This deliberately
trades bounded I/O for bounded memory on that discovery path: in the absence
of durable replay-ancestry metadata, stopping early cannot prove that an older
envelope is absent.

The TDD regression creates an authentic replay envelope, appends more native
governance rows than the reverse-reader limit, mutates the newest row without
updating its chain hash, and requires a fail-closed
`governance_replay_transport_corrupt` result. Existing newest-first,
kind-filter, and bounded-memory behaviors remain covered. This is still Task 2
`code_proven` hardening and does not create live evidence or begin Task 3.

---

#### Superseded extracted Task 2 text (retained for audit)

**Files:**

- Create: `aria-kernel/aria_kernel/autonomy_evidence.py`
- Modify: `aria-kernel/aria_kernel/cli.py`
- Modify: `aria-kernel/aria_kernel/autonomy_state.py`
- Create: `aria-kernel/tests/test_autonomy_evidence_status.py`
- Modify: `docs/aria/BEHAVIOUR.md`

**Interfaces:**

- Consumes: declared state-manifest ledgers, target Git SHA, registry blockers, and existing
  `AutonomyStateReducer` output.
- Produces: `derive_autonomy_evidence_status(...) -> AutonomyEvidenceStatus` and
  `aria-kernel autonomy status --evidence [--target-sha <sha>]` JSON.

- [ ] **Step 1: Write failing dataclass and precedence tests**

Pin the public types and state precedence:

```python
def test_live_proof_requires_target_sha_bound_runtime_evidence(self) -> None:
    status = derive_autonomy_evidence_status(
        base_dir=self.tools,
        repo_root=self.repo,
        target_sha="a" * 40,
    )
    self.assertEqual(status.capabilities["finding_funnel"].state, "declared")

def test_operator_blocker_has_precedence_over_code_proof(self) -> None:
    status = _derive_with(
        code_proof=True,
        live_proof=False,
        operator_blockers=("github_app_mode_a_unconfigured",),
    )
    self.assertEqual(status.overall_state, "operator_blocked")
```

Required state vocabulary:

```python
EvidenceState = Literal[
    "declared", "code_proven", "live_proven", "operator_blocked"
]
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_autonomy_evidence_status.py
```

Expected: FAIL because `aria_kernel.autonomy_evidence` does not exist.

- [ ] **Step 3: Implement the immutable evidence view**

Implement these exact shapes:

```python
@dataclass(frozen=True, slots=True)
class EvidenceRef:
    surface: str
    row_id: str
    row_hash: str
    evidence_target_sha: str | None
    evaluated_target_sha: str
    capability_authority_hash: str
    state_commit: str

@dataclass(frozen=True, slots=True)
class CapabilityEvidence:
    state: EvidenceState
    counts: dict[str, int]
    blockers: tuple[str, ...]
    evidence_refs: tuple[EvidenceRef, ...]

@dataclass(frozen=True, slots=True)
class AutonomyEvidenceStatus:
    target_sha: str
    derived_at: str
    overall_state: EvidenceState
    blockers: tuple[str, ...]
    capabilities: dict[str, CapabilityEvidence]

    def to_dict(self) -> dict[str, Any]: ...

def derive_autonomy_evidence_status(
    *,
    base_dir: str | Path,
    repo_root: str | Path,
    target_sha: str | None = None,
) -> AutonomyEvidenceStatus: ...
```

Expose exactly these capability keys:

```text
cycle_runtime
executor
finding_funnel
fixture_calibration
pre_merge_perimeter
enterprise_readiness
autonomy_unlock
```

Define `CAPABILITY_AUTHORITY_PATHS` as an immutable mapping in the same module. It must use exact
repository paths (a missing future path hashes as an explicit `MISSING` member, so adding it
invalidates prior proof), with these ownership groups:

```text
cycle_runtime:
  cycle.py, autonomy_orchestrator.py, autonomy_state.py, state_manifest.py,
  .github/workflows/aria-auto-cycle.yml
executor:
  agent_invocations.py, circuit_breaker.py, state_manifest.py,
  tools/aria-poc/{dispatch_failure,claude_runtime,ci_executor,ci_executor_drain,worker_executor}.py,
  .github/workflows/aria-agent-executor.yml
finding_funnel:
  feedback_store.py, finding_promotion.py, funnel_health.py, state_manifest.py,
  .github/workflows/{aria-auto-cycle,aria-agent-executor}.yml
fixture_calibration:
  fixture_runner.py, judge_calibration.py, adapter_calibration.py, readiness.py,
  tool_registry.py, state_manifest.py,
  .github/workflows/{aria-auto-cycle,aria-agent-executor}.yml
pre_merge_perimeter:
  pre_merge_evidence.py, implementation_safety.py, merge_authority.py,
  plan_convergence.py, file_claims.py, operator_feedback_signature.py,
  expert_review_gate.py, plan_coverage.py, budget.py, cost_budget.py,
  state_manifest.py, .github/workflows/aria-merge-authority.yml
enterprise_readiness:
  gh_token_factory.py, readiness_schema.py, readiness_proofs.py,
  enterprise_readiness.py, state_snapshot.py, state_store.py,
  rollback_bundle.py, state_manifest.py, .github/CODEOWNERS,
  .github/actions/mint-aria-app-token/action.yml,
  .github/workflows/{aria-auto-cycle,aria-agent-executor,aria-agent-eval,aria-readiness-claim}.yml
autonomy_unlock:
  acceptance_reconciler.py, autonomy_unlock.py, autonomy_ladder.py,
  runtime_profile.py, merge_authority.py, rollback_bundle.py, state_manifest.py,
  docs/aria/policy/autonomy-unlock.json, .github/workflows/aria-auto-cycle.yml
```

Every bare Python filename above is under `aria-kernel/aria_kernel/`. Expand the brace notation into
literal normalized paths in code; brace/glob matching itself is not part of the authority. Include
`autonomy_evidence.py` and the closure-finding policy as common meta-authorities in every canonical
hash. A test must fail when a capability producer/consumer added later is absent from this mapping.

Require `base_dir` to be the tools root produced and bound by the repository's normal
restore/state-sync path. Use `ensure_tools_dir_readonly()` plus
`load_declared_jsonl(..., expected_surface=<exact-name>, verify=True)` for concrete surfaces;
enumerate wildcard artifacts through the manifest matcher rather than passing a glob to
`resolve_surface_path`. A raw checkout of `origin/aria/state`, an absent tools binding/identity, or
a repository mismatch is unavailable evidence and must fail/return a named blocker—it is never an
all-zero healthy store. Within a valid bound store, an absent optional declared ledger counts as
zero; a corrupt chain raises integrity failure.

Refactor `autonomy_state.py` around one pure row-folding function so the evidence path can read/fold
without calling the current `autonomy_state_path()` bootstrap writer. Preserve legacy
`AutonomyStateReducer.derive_current()` behavior for the old CLI, and add a tested read-only path
for evidence mode. Respect each producer's own payload schema/upcaster; do not assume one universal
ledger schema version.

`code_proven` requires a successful test/CI proof row explicitly bound to its evidence SHA; local
source presence alone remains `declared`. Every capability owns an exact, tested list of
invalidating code/policy/workflow paths. `live_proven` requires its terminal runtime row to carry
the authoritative event SHA (`target_sha`, `git_head_sha_at_cycle`, or the owner's named
equivalent). At evaluation, accept that row only when the event SHA equals or is an ancestor of the
requested target and the canonical capability-authority hash is identical at both Git trees. An
unrelated documentation/registry descendant may therefore preserve a proof; a relevant
implementation, policy, workflow, missing path, non-ancestor, or unknown hash makes it stale and
lowers the state until the checkpoint reruns. Never use “latest row” or ancestry alone.

`operator_blocked` requires a named operator-only prerequisite such as Mode-A GitHub App
configuration. Derive `overall_state` from capabilities with deterministic precedence: any operator
blocker, then the lowest evidence state; never accept an aggregate state from the caller. Tests must
cover exact-SHA proof, unchanged-authority descendant, unrelated-doc descendant, relevant-file
invalidation, non-ancestor, and an authority set whose membership changes.

- [ ] **Step 4: Add backward-compatible CLI evidence arguments**

Add `--evidence` plus optional `--target-sha` to the existing `autonomy status` parser. Reject
`--target-sha` without `--evidence`; when omitted in evidence mode, resolve the checked repository
HEAD through Git and validate it as a reachable full SHA. Preserve the current output when both are
absent:

```python
if args.command == "autonomy" and args.autonomy_command == "status":
    if args.evidence:
        status = derive_autonomy_evidence_status(
            base_dir=args.tools_dir,
            repo_root=Path.cwd(),
            target_sha=args.target_sha,
        )
        print(json.dumps(status.to_dict(), indent=2, sort_keys=True))
        return 0
    state = AutonomyStateReducer.derive_current(args.tools_dir)
    print(json.dumps(state.to_dict(), indent=2, sort_keys=True))
    return 0
```

- [ ] **Step 5: Mark BEHAVIOUR as a dated measurement, not current state**

Add a short authority notice linking current machine truth to:

```text
aria-kernel autonomy status --evidence
docs/aria/CURRENT_STATE.md
```

Do not rewrite historical measurements or generate a second mutable status document.

- [ ] **Step 6: Run targeted and CLI tests**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_autonomy_evidence_status.py \
  aria-kernel/tests/test_cli_autonomy_subcommand.py
```

Expected: PASS, including unchanged legacy status output.

- [ ] **Step 7: Commit and push**

```bash
git add aria-kernel/aria_kernel/autonomy_evidence.py \
  aria-kernel/aria_kernel/autonomy_state.py \
  aria-kernel/aria_kernel/cli.py \
  aria-kernel/tests/test_autonomy_evidence_status.py \
  docs/aria/BEHAVIOUR.md
git commit -m "feat(aria): derive target-bound autonomy evidence status" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 3: Make the authority stamp invariant server-merge safe

**Files:**

- Modify: `tools/gates/aria-authority-hash.ts`
- Modify: `tests/invariants/aria-doc-runtime-ssot.spec.ts`
- Create: `tools/gates/aria-authority-hash.spec.ts`

**Interfaces:**

- Consumes: normalized authority-tree content at the checked Git tree.
- Produces: content-hash freshness independent of the server merge commit's calendar day; `Date`
  remains descriptive metadata.

- [ ] **Step 1: Write the next-UTC-day merge regression test**

Create an isolated Git repository in the test, stamp an authority tree on day D, create an
unchanged-tree merge commit on day D+1, and assert:

```ts
expect(recordedAriaAuthorityHash(repo)).toBe(ariaAuthorityHash(repo));
expect(checkAriaAuthorityHash(repo).valid).toBe(true);
```

Add the direction test: change an authority file without re-stamping and expect `valid=false` with
`authority_hash_stale`.

- [ ] **Step 2: Run the targeted test and observe the date-coupling failure**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/aria-authority-hash.spec.ts
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/aria-doc-runtime-ssot.spec.ts
```

Expected: FAIL because the invariant compares the descriptive date with the newest authority commit
date.

- [ ] **Step 3: Separate content validity from descriptive date**

Export a pure checker:

```ts
export interface AriaAuthorityHashVerdict {
  readonly valid: boolean;
  readonly declared: string | null;
  readonly computed: string;
  readonly reason: 'current' | 'authority_hash_stale';
}

export function checkAriaAuthorityHash(
  repoRoot: string = ariaRepoRoot(),
): AriaAuthorityHashVerdict { ... }
```

`--check` must consume this function. Keep hash/date normalization and the same-write `--write`
behavior, but remove commit-time freshness as an authorization predicate. The invariant still
requires a valid ISO date and exact content hash.

- [ ] **Step 4: Pin the existing PR merge-result verification**

The existing `aria-merge-authority` workflow already checks out the PR test tree and runs
`npm run aria:docs:ssot`. Add a static/isolated-repository regression proving the checkout under
test is the GitHub merge-result SHA, not merely the PR head, and that `.gitattributes` merge
behavior producing a stale `CURRENT_STATE` pin fails. No workflow edit is expected. If this measured
premise is false, stop Task 3, open a governed finding, apply `superpowers:systematic-debugging`,
and revise the reviewed file list before expanding scope; do not add a duplicate required check ad
hoc.

- [ ] **Step 5: Run authority and documentation invariants**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/aria-authority-hash.spec.ts
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/aria-doc-runtime-ssot.spec.ts
npm run aria:docs:ssot
npm run aria:authority-hash -- --check
```

Expected: next-day unchanged merge PASS; unstamped content FAIL; repository authority pin PASS.

- [ ] **Step 6: Commit and push**

```bash
git add tools/gates/aria-authority-hash.ts \
  tools/gates/aria-authority-hash.spec.ts \
  tests/invariants/aria-doc-runtime-ssot.spec.ts
git commit -m "fix(aria): bind authority freshness to content not merge date

Server-side merges do not run local hooks and may land on a later UTC day.
Validate the merge-result authority tree by content while retaining the date
as descriptive metadata.

Closes: docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-792"
git push
```

- [ ] **Step 7: Defer structured closure until reachability is true**

After merge, verify the fixing SHA is an ancestor of `origin/main`. Do not run
`finding-registry close` on the feature branch. Task 20 PR B must execute:

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/finding-registry.ts close ORPHAN-MEDIUM-792 <main-reachable-task-3-sha>
```

The Task 3 `Closes:` trailer alone is traceability; it does not mutate registry state.

---

### Task 4: Introduce the typed executor failure contract

**Files:**

- Create: `tools/aria-poc/dispatch_failure.py`
- Modify: `tools/aria-poc/claude_runtime.py`
- Modify: `tools/aria-poc/ci_executor.py`
- Modify: `tools/aria-poc/worker_executor.py`
- Create: `aria-kernel/tests/test_executor_failure_classification.py`

**Interfaces:**

- Consumes: existing Claude exceptions, result markers, exit codes, role/model/provider identity.
- Produces: `DispatchFailure`, `DispatchRoute`, extended `ClaudeRunResult`, and a sanitized
  per-child `aria/dispatch-result/v1` summary.

- [ ] **Step 1: Write failing classification tests**

Cover every closed value:

```python
DispatchFailureClass = Literal[
    "cli_unavailable", "auth_unavailable", "auth_failed",
    "usage_unavailable", "credit_exhausted",
    "provider_redirect_unavailable", "policy_violation", "timeout",
    "response_schema_rejected", "process_exit", "unknown",
]
```

Tests must assert that auth/credit/CLI failures are non-retryable, timeout is retryable within the
existing bounded policy, model refusal is not a build failure, and no detail contains raw stderr or
token-like strings.

- [ ] **Step 2: Run the classification suite**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_executor_failure_classification.py
```

Expected: FAIL because the typed contract does not exist.

- [ ] **Step 3: Implement the contract and classifier**

```python
@dataclass(frozen=True, slots=True)
class DispatchFailure:
    failure_class: DispatchFailureClass
    retryable: bool
    detail_code: str
    phase: Literal["preflight", "spawn", "runtime", "submit", "drain"]
    exit_code: int | None = None

def classify_dispatch_failure(
    *,
    exception: BaseException | None = None,
    result: ClaudeRunResult | None = None,
    phase: str,
) -> DispatchFailure | None: ...

@dataclass(frozen=True, slots=True)
class DispatchRoute:
    provider: str
    model: str
    role: str
    target_agent: str

def resolve_dispatch_route(
    *, request: Mapping[str, Any], repo_root: str | Path,
) -> DispatchRoute: ...
```

Resolve the route before claim from the trusted request's `target_agent`/role using the existing
`agent_runtime_profile.resolve_claude_model(...)` and
`claude_runtime.provider_redirect_disclosure(...)` owners; default Anthropic routing must remain
byte-identical. The child must use this same route, and a mismatch between predicted and executed
route is a classified contract failure. Extend `ClaudeRunResult` with defaulted `failure_class`,
`retryable`, and `failure_detail_code`. Preserve construction compatibility for all current tests
and callers.

- [ ] **Step 4: Write one sanitized child summary on every terminal path**

Use this exact wire shape:

```json
{
  "$schema": "aria/dispatch-result/v1",
  "schema_version": 1,
  "request_id": "AIR-...",
  "role": "implementation",
  "target_agent": "aria-implementer",
  "provider": "anthropic",
  "model": "resolved-model",
  "outcome": "succeeded|failed|refused",
  "failure_class": null,
  "retryable": false,
  "failure_detail_code": null,
  "exit_code": 0
}
```

Write it under `RUNNER_TEMP` and publish only its path as `dispatch_summary_path` through
`GITHUB_OUTPUT`. Never write raw prompt, stdout, stderr, auth material, or provider token to this
summary.

- [ ] **Step 5: Apply the same mapping to CI and worker executors**

Both executors must call the shared classifier. Provider/model fallback remains owned by
`claude_runtime`; executor code records the final exhausted outcome only once.

- [ ] **Step 6: Run runtime and executor neighbours**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_executor_failure_classification.py \
  aria-kernel/tests/test_claude_runtime_contract.py \
  aria-kernel/tests/test_ci_executor.py \
  aria-kernel/tests/test_ci_executor_live_path_smoke.py \
  aria-kernel/tests/test_drain_refusal_is_not_a_build_failure.py
```

- [ ] **Step 7: Commit and push**

```bash
git add tools/aria-poc/dispatch_failure.py \
  tools/aria-poc/claude_runtime.py tools/aria-poc/ci_executor.py \
  tools/aria-poc/worker_executor.py \
  aria-kernel/tests/test_executor_failure_classification.py
git commit -m "feat(aria): classify executor failures at the runtime boundary" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 5: Aggregate failures and stop executor requeue storms

**Files:**

- Modify: `tools/aria-poc/ci_executor_drain.py`
- Modify: `aria-kernel/aria_kernel/circuit_breaker.py`
- Modify: `aria-kernel/aria_kernel/agent_invocations.py`
- Modify: `aria-kernel/aria_kernel/autonomy_evidence.py`
- Create: `aria-kernel/tests/test_executor_drain_breaker.py`
- Modify: `aria-kernel/tests/test_executor_drain_mode.py`
- Modify: `aria-kernel/tests/test_autonomy_evidence_status.py`

**Interfaces:**

- Consumes: `aria/dispatch-result/v1` summaries from Task 4.
- Produces: schema-v2 `executor_drain_completed.details`, an immediate per-run keyed circuit, and
  persistent breaker evidence for repeated environment failures.

- [ ] **Step 1: Write failing aggregate and breaker tests**

Pin these behaviors:

```python
def test_non_retryable_provider_failure_opens_same_run_circuit(): ...
def test_open_circuit_skips_same_provider_model_without_claiming(): ...
def test_refusal_never_counts_as_breaker_failure(): ...
def test_governance_event_contains_failure_counts_and_details(): ...
def test_provider_model_role_breakdown_reconciles_to_attempted(): ...
def test_repeated_environment_failures_trip_persistent_breaker(): ...
```

- [ ] **Step 2: Run the drain suites**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_executor_drain_mode.py \
  aria-kernel/tests/test_executor_drain_breaker.py
```

Expected: FAIL because drain only counts child exit codes.

- [ ] **Step 3: Add the immediate keyed circuit**

Use key `(provider, model, failure_class)`. The first non-retryable environment failure opens that
key for the remainder of the drain. For every `next-pending` candidate, call Task 4's deterministic
`resolve_dispatch_route(...)` before invoking the child. If its provider/model matches an open key,
add its request ID to a drain-local `circuit_excluded_request_ids` set and query `next-pending`
again with `attempted ∪ circuit_excluded_request_ids` through the existing `--exclude` API. Do not
claim, release, or mark the excluded request attempted; it remains pending for a later healthy
drain. Assert the child summary's executed route equals the predicted route.

Map persistent safety failures as follows:

```text
timeout -> existing subprocess_timeout
cli/auth/usage/credit/provider failures -> executor_environment_failure
next-pending read/JSON failure -> executor_selection_failure
response-schema/task refusal -> no global breaker event
```

Treat policy violations and model refusals as request-scoped terminal outcomes, not provider
outages. `process_exit`/`unknown` stay visible and follow only the existing bounded per-request
retry rule; they cannot open a provider-wide circuit until a concrete environment class is
established.

Add the two new closed `FAILURE_KINDS` values to `circuit_breaker.py`; old rows remain readable.

- [ ] **Step 4: Extend the governance payload without deleting fields**

`executor_drain_completed.details` becomes:

```python
{
    "schema_version": 2,
    "attempted": attempted_count,
    "succeeded": succeeded,
    "failed": failed,
    "stop_reason": stop_reason,
    "failure_counts": dict(sorted(failure_counts.items())),
    "by_provider_model_role": deterministic_breakdown,
    "failure_details": sanitized_details,
    "circuit_breakers": sorted(open_circuits),
    "breaker_state": evaluate_breaker(tools_dir).state,
}
```

Retain the existing top-level attempted/succeeded/failed/stop reason fields consumed by current
state tooling. Each breakdown bucket contains attempted/succeeded/failed counts and failure-class
counts; never infer provider/model/role from stderr.

Propagate the trusted request's immutable target SHA through `agent_invocations.py` into every
accepted producer-native terminal result and the joined `executor_drain_completed` row. Update the
`executor` contract in `autonomy_evidence.py` and its exact contract tests so a terminal row with a
missing, caller-substituted, PR-head-only, or mismatched target SHA remains historical/countable but
cannot become `live_proven` for the evaluated target.

- [ ] **Step 5: Run breaker, drain, and workflow contract tests**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_executor_drain_mode.py \
  aria-kernel/tests/test_executor_drain_breaker.py \
  aria-kernel/tests/test_breaker_producer_scheduled_lane.py \
  aria-kernel/tests/test_drain_refusal_is_not_a_build_failure.py \
  aria-kernel/tests/test_executor_workflow_sandbox_contract.py \
  aria-kernel/tests/test_autonomy_evidence_status.py
```

- [ ] **Step 6: Commit, push, and wait for merge**

```bash
git add tools/aria-poc/ci_executor_drain.py \
  aria-kernel/aria_kernel/agent_invocations.py \
  aria-kernel/aria_kernel/autonomy_evidence.py \
  aria-kernel/aria_kernel/circuit_breaker.py \
  aria-kernel/tests/test_executor_drain_breaker.py \
  aria-kernel/tests/test_executor_drain_mode.py \
  aria-kernel/tests/test_autonomy_evidence_status.py
git commit -m "feat(aria): stop classified executor failure storms" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

- [ ] **Step 7: Pass the three-drain live reliability checkpoint**

After the Task 5 PR reaches `origin/main`, run three scheduled drains containing at least one real
pending request each. Fetch their state rows through the production state-sync path. All three must
have:

```text
unknown failure count = 0
claim/requeue storm count = 0
every terminal summary joined to exactly one request_id
provider/model/role totals = attempted total
no credential or raw stderr in summary/governance/state artifacts
```

An empty drain is observable but does not count toward the three. A non-retryable outage may open a
circuit and leave unclaimed work pending, but repeated claims/releases for that key fail the
checkpoint. Do not start Task 6 until the three evidence rows are target-SHA-bound and remotely
readable; otherwise open a governed finding and use `superpowers:systematic-debugging`.

---

### Task 6: Make the learning funnel measurable end to end

**Files:**

- Modify: `aria-kernel/aria_kernel/funnel_health.py`
- Modify: `aria-kernel/aria_kernel/autonomy_evidence.py`
- Modify: `aria-kernel/aria_kernel/feedback_store.py`
- Modify: `aria-kernel/aria_kernel/finding_promotion.py`
- Modify: `aria-kernel/aria_kernel/fixture_runner.py`
- Modify: `aria-kernel/aria_kernel/judge_calibration.py`
- Modify: `aria-kernel/aria_kernel/adapter_calibration.py`
- Modify: `aria-kernel/aria_kernel/readiness.py`
- Modify: `aria-kernel/aria_kernel/tool_registry.py`
- Create: `aria-kernel/tests/test_promotion_funnel_e2e.py`
- Modify: `aria-kernel/tests/test_funnel_self_diagnosis.py`
- Modify: `aria-kernel/tests/test_autonomy_evidence_status.py`

**Interfaces:**

- Consumes: raw findings, agent requests/results, feedback consensus, promoted findings, fixture
  runs, judge calibration, adapter calibration, and registry status.
- Produces: `derive_learning_funnel_health(...) -> LearningFunnelHealth` and named stall reasons
  used by Task 2's status.

- [ ] **Step 1: Write the failing full-funnel and stall tests**

The stage order is fixed:

```python
LEARNING_FUNNEL_STAGES = (
    "raw", "judge_request", "consensus", "promoted", "fixture_pass",
    "judge_calibrated", "adapter_calibrated", "adapter_active",
)
```

Test one real-schema fixture flowing from a raw finding through anchor consensus, idempotent finding
promotion, fixture pass, calibration report, and ACTIVE eligibility. Add negative cases for missing
fingerprint, two-judge non-anchor consensus, stale fixture hash, and upstream count >= 10 with
downstream zero.

- [ ] **Step 2: Run the funnel tests**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_promotion_funnel_e2e.py \
  aria-kernel/tests/test_funnel_self_diagnosis.py
```

Expected: FAIL because current funnel health covers the plan/merge funnel, not the learning stages.

- [ ] **Step 3: Implement the derived health type**

```python
@dataclass(frozen=True, slots=True)
class LearningFunnelHealth:
    counts: dict[str, int]
    stalled_at: str | None
    blockers: tuple[str, ...]
    evidence_refs: tuple[str, ...]

def derive_learning_funnel_health(
    *, base_dir: str | Path, target_sha: str,
) -> LearningFunnelHealth: ...
```

Join by request IDs, run IDs, finding fingerprint, tool ID/version, fixture manifest hash,
calibration report ID, and target SHA. The six production writers listed above must stamp those
identities from their input envelope rather than infer them from the latest row. Legacy rows are
read through a display-only upcaster with `target_sha=None`; they contribute to historical counts
but cannot advance `code_proven` to `live_proven`. Do not rewrite old state rows.

For `adapter_calibrated -> adapter_active`, require the same tool ID/version, fixture pass,
calibration report, precision window, target SHA, and the exact `readiness.adapter_active_readiness`
verdict consumed by the governed transition. Extend the ACTIVE transition evidence written by
`tool_registry.transition_tool(...)` with immutable `readiness_verdict_ref/hash`,
`calibration_report_ref/hash`, fixture-run refs, tool version, and target SHA. ACTIVE refuses
missing/stale/mismatched evidence; non-ACTIVE lifecycle transitions retain backward-compatible
construction. Legacy ACTIVE rows remain auditable but cannot prove this plan's `live_proven` join. A
row lacking any required join key cannot advance a later stage. When a stage has at least 10 rows
and its immediate successor has zero, emit `learning_funnel_stalled:<upstream>-><downstream>`.

- [ ] **Step 4: Reuse the existing producers rather than duplicate them**

The E2E test must call the production functions:

```text
feedback_store / judge consensus
finding_promotion.promote_consensus_findings
fixture_runner.refresh_fixture_suite
judge_calibration.compute_judge_calibration
adapter_calibration.generate_adapter_calibration_report
readiness.adapter_active_readiness
```

Do not add a second promotion, fixture, or calibration writer.

- [ ] **Step 5: Connect funnel health to evidence status**

`finding_funnel` and `fixture_calibration` must report named stage counts and refuse `live_proven`
while any downstream terminal count is zero or stale.

Extend the producer-native status contracts at the same time: a terminal promotion must carry the
trusted finding-envelope target SHA, and a terminal fixture-suite row must carry the exact target
SHA propagated through its governed run envelope. Pin both contracts in
`test_autonomy_evidence_status.py`. Missing, legacy, inferred-latest, PR-head-only, or mismatched
values remain audit/count evidence only and never satisfy the target-bound live predicate. Task 7
only executes these contracts in the scheduled lane; it does not invent or repair their schema.

- [ ] **Step 6: Run the learning neighbour suite**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_promotion_funnel_e2e.py \
  aria-kernel/tests/test_finding_promotion.py \
  aria-kernel/tests/test_promotion_self_heal.py \
  aria-kernel/tests/test_fixture_runner_path_escape.py \
  aria-kernel/tests/test_judge_calibration.py \
  aria-kernel/tests/test_jj1_anchor_consensus.py \
  aria-kernel/tests/test_jj2_humanless_promotion.py \
  aria-kernel/tests/test_auto_promotion_caller.py \
  aria-kernel/tests/test_tool_lifecycle_matrix.py \
  aria-kernel/tests/test_autonomy_evidence_status.py
```

- [ ] **Step 7: Commit and push**

```bash
git add aria-kernel/aria_kernel/funnel_health.py \
  aria-kernel/aria_kernel/autonomy_evidence.py \
  aria-kernel/aria_kernel/feedback_store.py \
  aria-kernel/aria_kernel/finding_promotion.py \
  aria-kernel/aria_kernel/fixture_runner.py \
  aria-kernel/aria_kernel/judge_calibration.py \
  aria-kernel/aria_kernel/adapter_calibration.py \
  aria-kernel/aria_kernel/readiness.py \
  aria-kernel/aria_kernel/tool_registry.py \
  aria-kernel/tests/test_promotion_funnel_e2e.py \
  aria-kernel/tests/test_funnel_self_diagnosis.py \
  aria-kernel/tests/test_autonomy_evidence_status.py
git commit -m "feat(aria): expose the complete learning evidence funnel" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 7: Prove the scheduled learning path with live evidence

**Files:**

- Create: `aria-kernel/tests/test_learning_funnel_scheduled_path.py`
- Modify: `.github/workflows/aria-auto-cycle.yml`
- Modify: `.github/workflows/aria-agent-executor.yml`
- Modify: `docs/aria/CURRENT_STATE.md`

**Interfaces:**

- Exercises: the production scheduled-cycle and executor entry points already repaired for ORPHAN
  779-787.
- Produces: target-SHA-bound scheduled rows proving that the funnel measured in Task 6 advances
  without synthetic evidence.

- [ ] **Step 1: Write the failing scheduled-path contract test**

Build the test around the real workflow commands and production functions. It must prove this order
without replacing any producer:

```text
cycle creates judge requests
executor records anchor and non-anchor results
cycle promotes consensus
fixture refresh records a real repository fixture result
judge calibration records judged_judges > 0
adapter calibration records a report
promotion replay is idempotent
```

The test must also assert that workflow launch failure, skipped, and blocked paths write a phase
result, and that calibration runs before the ACTIVE-readiness consumer.

- [ ] **Step 2: Run the test and observe the wiring failure**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_learning_funnel_scheduled_path.py
```

Expected: FAIL at the first production workflow/cycle boundary that does not expose the required
evidence join; a fixture-only in-process pass is not sufficient.

- [ ] **Step 3: Make only the minimum scheduled-lane wiring correction**

Preserve the existing fixes for fixture layout, workflow-launch failure rows, distinct anchor
models, calibration ordering, blocked/skipped telemetry, cross-night sampling, mint/drain TTL, and
HMAC re-verification. Change workflow arguments or phase ordering only where the failing contract
identifies a real disconnect.

Every phase row must carry `cycle_id`, `run_id`, `target_sha`, and the producer's native result ID.
Never generate a successful row in the workflow merely because a command exited zero.

- [ ] **Step 4: Run the scheduled and learning neighbour suites**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_learning_funnel_scheduled_path.py \
  aria-kernel/tests/test_cycle_phase_pipeline.py \
  aria-kernel/tests/test_auto_promotion_caller.py \
  aria-kernel/tests/test_calibration_recommendation_phase.py \
  aria-kernel/tests/invariants/v7/test_phase_v7_6_calibration_reporter.py \
  aria-kernel/tests/test_judge_calibration.py
```

- [ ] **Step 5: Commit, push, and wait for the commit to reach `origin/main`**

```bash
git add .github/workflows/aria-auto-cycle.yml \
  .github/workflows/aria-agent-executor.yml \
  aria-kernel/tests/test_learning_funnel_scheduled_path.py
git commit -m "fix(aria): bind scheduled cycles to learning evidence

Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-779"
git push
```

Record the exact main-reachable fixing SHA for each ORPHAN 779-787 in the Task 1 policy. Task 20
closes them individually; do not close the group from this branch merely because the aggregate test
passes.

- [ ] **Step 6: Pass the external live checkpoint after merge**

This is an operator/runtime checkpoint, not part of the code commit. Do not proceed to Task 8 until
the Task 7 PR is merged and the following run is complete.

From a clean clone of the merged target:

```bash
gh workflow run aria-auto-cycle.yml --ref main
gh run list --workflow aria-auto-cycle.yml --branch main --limit 1
aria-kernel autonomy status --evidence --target-sha "$(git rev-parse origin/main)"
```

Accept only ledger rows fetched from the state ref through the repository's normal state-sync path.
The trial is green when at least one finding reaches all eight Task 6 stages, `judged_judges > 0`,
an adapter-calibration report exists, and replay does not add a duplicate promoted finding.

If any stage remains zero, keep `finding_funnel` or `fixture_calibration` below `live_proven`,
record the named `learning_funnel_stalled:<from>-><to>` reason as a governed finding, and use
`superpowers:systematic-debugging` before changing code.

- [ ] **Step 7: Record the verified live boundary**

From a new worktree at the merged code SHA, update `docs/aria/CURRENT_STATE.md` with the exact
merged SHA, run URL/ID, state row hashes, stage counts, and remaining blocker. Re-stamp and verify
the authority surface, then use a separate documentation-only PR:

```bash
npm run aria:authority-hash -- --write
npm run aria:authority-hash -- --check
git add docs/aria/CURRENT_STATE.md
git commit -m "chore(aria): record the live learning-funnel boundary"
git push
```

Do not start Task 8 until this documentation PR is merged and the next worktree is based on the
resulting `origin/main`. If authority stamping changes another declared file, stage that exact
generated file too and rerun the hash check; never use `git add -A`.

---

### Task 8: Build an immutable pre-merge evidence snapshot

**Files:**

- Create: `aria-kernel/aria_kernel/pre_merge_evidence.py`
- Create: `aria-kernel/tests/test_pre_merge_evidence.py`
- Modify: `aria-kernel/aria_kernel/implementation_safety.py`
- Modify: `aria-kernel/aria_kernel/merge_authority.py`
- Modify: `aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py`

**Interfaces:**

- Produces: `build_pre_merge_evidence(...) -> PreMergeEvidence`.
- Extends: `HardFailContext.pre_merge: PreMergeEvidence | None`.
- Consumes: fresh GitHub PR data and verified, state-manifest-declared ledgers only.

- [ ] **Step 1: Write failing construction and freshness tests**

Tests must reject direct dataclass construction, a PR-head change between two reads, an undeclared
ledger path, an invalid ledger chain, and evidence whose `change_id` or target SHA differs from the
convergence envelope. Because Tasks 9-12 have not yet shipped their producers, the builder must
represent each unavailable section as an immutable `MissingEvidence(reason, checked_sources)` value;
it must never fabricate a passing section.

Pin the nested immutable shape:

```python
@dataclass(frozen=True, slots=True)
class PreMergeEvidence:
    change_id: str
    expected_head_sha: str
    observed_at: str
    branch_tip: BranchTipEvidence
    file_claims: EvidenceSlot[FileClaimEvidence]
    operator_feedback: EvidenceSlot[FeedbackSignatureEvidence]
    budget: EvidenceSlot[BudgetEvidence]
    plan_binding: EvidenceSlot[PlanBindingEvidence]
    consensus: EvidenceSlot[ConsensusEvidence]
    coverage: EvidenceSlot[CoverageEvidence]
    evidence_digest: str
```

`EvidenceSlot[T]` is `VerifiedEvidence[T] | MissingEvidence`; callers cannot provide a boolean pass.
`PreMergeEvidence.assert_complete()` is introduced but is expected to fail through Task 11. Task 12
makes all seven sections mandatory and proves the first successful call.

- [ ] **Step 2: Run the focused tests**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_pre_merge_evidence.py \
  aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py
```

Expected: FAIL because no typed snapshot exists and `HardFailContext` currently carries only
diff/envelope/base inputs.

- [ ] **Step 3: Implement the single evidence builder**

`build_pre_merge_evidence(...)` must:

1. Fetch the PR head and changed files through the injected GitHub adapter.
2. Load each ledger through state-manifest ownership and verified hash-chain readers.
3. Join rows already available by the existing triple-gate `change_id`, PR number, head SHA, plan
   revision, and request ID; record a named missing slot for producers that land in Tasks 9-12.
4. Re-fetch the PR head immediately before returning.
5. Canonicalize the snapshot and store its SHA-256 digest.

Use a module-private construction token or equivalent factory guard so tests and callers cannot
forge a valid snapshot by instantiating fields directly.

- [ ] **Step 4: Wire the builder at the final merge boundary**

In `merge_authority.py`, build the snapshot only after the existing live-PR refresh and immediately
before `run_hard_fail_checks(..., gate=GATE_PRE_MERGE)`. Pass the current triple-gate `change_id`;
do not change the public merge command or create a second change identity.

- [ ] **Step 5: Prove fail-closed behavior**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_pre_merge_evidence.py \
  aria-kernel/tests/test_merge_authority_invariants.py \
  aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py
```

All missing, stale, unreadable, malformed, and digest-mismatched evidence must raise
`GovernanceError` before the GitHub adapter's merge method is called. Task 8's all-green merge case
remains red with `pre_merge_evidence_incomplete`; the first all-green perimeter case belongs to
Task 12.

- [ ] **Step 6: Commit and push**

```bash
git add aria-kernel/aria_kernel/pre_merge_evidence.py \
  aria-kernel/aria_kernel/implementation_safety.py \
  aria-kernel/aria_kernel/merge_authority.py \
  aria-kernel/tests/test_pre_merge_evidence.py \
  aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py
git commit -m "feat(aria): build immutable pre-merge evidence" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 9: Implement branch-tip locking and per-file mutual exclusion

**Files:**

- Create: `aria-kernel/aria_kernel/file_claims.py`
- Modify: `aria-kernel/aria_kernel/plan_convergence.py`
- Modify: `aria-kernel/aria_kernel/worker_dispatch_hook.py`
- Modify: `aria-kernel/aria_kernel/cycle_phases/implementer.py`
- Modify: `aria-kernel/aria_kernel/pre_merge_evidence.py`
- Modify: `aria-kernel/aria_kernel/implementation_safety.py`
- Modify: `aria-kernel/aria_kernel/state_manifest.py`
- Modify: `aria-kernel/tests/invariants/v9/test_phase_v9_0_d_implementation_safety.py`
- Modify: `aria-kernel/tests/test_state_manifest_transaction.py`
- Create: `aria-kernel/tests/test_file_claim_atomic_acquire.py`
- Create: `aria-kernel/tests/test_pre_merge_file_claims.py`

**Interfaces:**

- Produces: `acquire_file_claims(...) -> FileClaimLease` before `implementation_requested` is
  emitted.
- Produces: `release_file_claims(...)` and `expire_file_claims(...)` through the same governed
  lifecycle.
- Persists: `implementation/file-claims.jsonl`, an append-fsync ledger in the existing `planning`
  lock group and `agent_claim` profile surface.
- Implements: `branch_tip_lock_and_recheck`.
- Implements: `per_file_mutual_exclusion`.

- [ ] **Step 1: Write the four failing branch-tip cases**

Cover: all SHAs equal; evaluation SHA differs; first live read differs; and the second immediate
live read differs. The only passing predicate is:

```text
expected evaluation SHA == first live PR SHA == second live PR SHA
```

- [ ] **Step 2: Write failing atomic-acquisition and file-claim cases**

Pin the durable lease row before implementation:

```text
file_claim_id, event(acquired|head_bound|released|expired), change_id,
request_id, normalized_paths, allowed_scope_hash, owner_agent, acquired_at,
expires_at, base_sha, plan_revision_hash, expected_head_sha?, release_reason?
```

The paths come from the deterministic coverage witness/affected-surface authority, never from an
agent-supplied free-text scope. Acquisition records the immutable plan/base SHA; the implementation
PR head does not exist yet. Under the repository's existing `state_transaction(...)` lock,
acquisition must read every active lease and append the complete new lease set as one transaction.
Test exact-file overlap, ancestor/descendant directory overlap, normalized `..`/separator/symlink
tricks, expired/released claims, a missing claim, duplicate current claims, and an idempotent retry
for the same `(change_id, request_id, allowed_scope_hash)`.

Add a two-process race test in which two different requests try to acquire an overlapping path.
Exactly one transaction may win; the loser must fail before an `implementation_requested` row or
worker dispatch exists.

- [ ] **Step 3: Run and observe placeholder failures**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/invariants/v9/test_phase_v9_0_d_implementation_safety.py \
  aria-kernel/tests/test_file_claim_atomic_acquire.py \
  aria-kernel/tests/test_state_manifest_transaction.py \
  aria-kernel/tests/test_pre_merge_file_claims.py
```

Expected: FAIL because there is no atomic pre-dispatch file lease and both pre-merge checks still
call `_not_implemented(...)`.

- [ ] **Step 4: Acquire the lease at the only pre-dispatch seam**

In `plan_convergence.request_implementation()`, derive the canonical path set and acquire it before
appending `implementation_requested`. Use `ledger.state_transaction(...)` and the
state-manifest-declared file-claim ledger so conflict detection plus acquisition is atomic across
processes. If the transaction loses a race, emit no implementation request and call no dispatch
hook. An idempotent retry for the same request returns its original active lease instead of
appending a duplicate.

When `plan_convergence.record_implementation_outcome(...)` accepts the PR result, use one ordered
`state_transaction` over convergence plus file-claim ledgers to append `head_bound` with
`base_branch_sha` and `branch_tip_sha`; reject a base SHA different from the acquired lease. This is
the first moment `expected_head_sha` may exist. Test crash/replay, mismatched base, a second head
bind, and outcome without an active lease.

Release the lease after merge/reject/cancel, dispatch failure, or abandoned request—not at the
nonterminal implementation outcome that pre-merge still needs. A scheduled TTL sweep records an
`expired` transition; it never deletes history. Reuse the repository's existing path normalization
and overlap predicate everywhere so acquisition and pre-merge cannot disagree. This is a governed
ownership ledger, not an independent in-memory mutex or hand-maintained dashboard.

- [ ] **Step 5: Implement the pre-merge predicates from authoritative data**

For every normalized changed path, require exactly one still-active, head-bound lease belonging to
the current `change_id` and request, with matching `allowed_scope_hash`, plan/base SHA, and zero
overlapping live lease from another request. Require
`lease.expected_head_sha == first live PR SHA == second live PR SHA`; missing head binding or a
base/envelope mismatch is red. The pre-merge builder re-reads the lease ledger after the second
PR-head read. Branch-tip lock passes only under the Step 1 triple-SHA equality.

Return the existing `HardFailResult` type used by implementation-safety verifiers, with evidence row
hashes in details and no raw untrusted ledger text.

- [ ] **Step 6: Run concurrency and merge-neighbour tests**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_file_claim_atomic_acquire.py \
  aria-kernel/tests/test_pre_merge_file_claims.py \
  aria-kernel/tests/test_file_lock_and_claim_idempotency.py \
  aria-kernel/tests/test_assignment_state_as_claims_ssot.py \
  aria-kernel/tests/test_agent_claim_lifecycle_leak.py \
  aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py
```

- [ ] **Step 7: Commit and push**

```bash
git add aria-kernel/aria_kernel/file_claims.py \
  aria-kernel/aria_kernel/plan_convergence.py \
  aria-kernel/aria_kernel/worker_dispatch_hook.py \
  aria-kernel/aria_kernel/cycle_phases/implementer.py \
  aria-kernel/aria_kernel/pre_merge_evidence.py \
  aria-kernel/aria_kernel/implementation_safety.py \
  aria-kernel/aria_kernel/state_manifest.py \
  aria-kernel/tests/invariants/v9/test_phase_v9_0_d_implementation_safety.py \
  aria-kernel/tests/test_state_manifest_transaction.py \
  aria-kernel/tests/test_file_claim_atomic_acquire.py \
  aria-kernel/tests/test_pre_merge_file_claims.py
git commit -m "feat(aria): enforce branch and file claim locks" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 10: Cryptographically verify operator feedback used by a plan

**Files:**

- Create: `aria-config/operator-feedback-allowed-signers`
- Create: `aria-kernel/aria_kernel/operator_feedback_signature.py`
- Create: `aria-kernel/tests/test_operator_feedback_signature.py`
- Modify: `aria-kernel/aria_kernel/plan_synthesizer.py`
- Modify: `aria-kernel/aria_kernel/implementation_safety.py`
- Modify: `aria-kernel/aria_kernel/pre_merge_evidence.py`
- Modify: `aria-kernel/tests/invariants/v7/test_phase_v7_1_plan_synthesizer.py`
- Modify: `.github/CODEOWNERS`
- Create: `docs/aria/runbooks/operator-feedback-signing.md`

**Interfaces:**

- Produces: `verify_operator_feedback_signature(...) -> VerifiedFeedbackSignature`.
- Implements: `operator_feedback_signature` in the pre-merge perimeter.
- Uses: `aria-config/operator-feedback-allowed-signers` at the trusted plan-base SHA, keyed by
  `signature_kid`; no signing secret enters the repository.

- [ ] **Step 1: Write failing canonicalization and cryptographic tests**

Cover a valid signature, content tampering, plan-base-SHA tampering, change/revision tampering,
expiry, unknown or revoked `signature_kid`, an allowed-signers file modified only by the
implementation PR, missing verifier executable, missing allowed-signers file, malformed signature,
and feedback not consumed by the converged plan.

Canonical signed bytes are deterministic JSON of the governed feedback payload, excluding only
`signature`, `ledger_hash`, and hash-chain metadata. The governed payload must include `change_id`,
`plan_base_sha`, candidate/revision identity, feedback body hash, signer identity, `signature_kid`,
issued time, and `expires_at`. The SSH signature namespace is exactly `aria-operator-feedback`.

- [ ] **Step 2: Expose the current false-positive verifier**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_operator_feedback_signature.py \
  aria-kernel/tests/invariants/v7/test_phase_v7_1_plan_synthesizer.py
```

Expected: FAIL because `_verify_operator_feedback_signature` currently checks field presence rather
than a cryptographic signature.

- [ ] **Step 3: Implement one shared OpenSSH verifier**

Follow the fail-closed `ssh-keygen -Y verify` invocation pattern already used by
`state_snapshot.py`. Load the allowed-signers bytes from the trusted base-branch object named by
`plan_base_sha`, not from the unmerged PR worktree. Map `signature_kid` to exactly one active
identity, feed canonical bytes over stdin, and sanitize subprocess errors.

The plan synthesizer and pre-merge check must call this same verifier. Remove the field-presence
verifier after all callers migrate.

- [ ] **Step 4: Bind verification to actual use**

At synthesis, record the hashes of feedback rows that influenced a revision. At pre-merge, verify
every referenced row against the envelope's `change_id`, `plan_base_sha`, and selected revision. Do
not compare the feedback's base SHA directly to the implementation PR head: the convergence envelope
must prove the base-to-head relationship, while the signature proves which base/candidate the
operator reviewed. Feedback present in the ledger but not used by the plan is not a merge
prerequisite.

Protect `aria-config/operator-feedback-allowed-signers` with a dedicated CODEOWNERS entry.
Rotation/revocation occurs only through a reviewed main-branch PR: a new `signature_kid` is added
before use, a revoked ID is explicitly marked and rejected for feedback issued after its revocation
time, and history remains verifiable at the recorded trusted base SHA. Document signing, expiry,
dual-key rotation, emergency revocation, and recovery in the runbook.

- [ ] **Step 5: Run the security and plan suites**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_operator_feedback_signature.py \
  aria-kernel/tests/invariants/v7/test_phase_v7_1_plan_synthesizer.py \
  aria-kernel/tests/test_plan_convergence.py \
  aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py
```

- [ ] **Step 6: Commit and push**

```bash
git add aria-config/operator-feedback-allowed-signers \
  aria-kernel/aria_kernel/operator_feedback_signature.py \
  aria-kernel/aria_kernel/plan_synthesizer.py \
  aria-kernel/aria_kernel/implementation_safety.py \
  aria-kernel/aria_kernel/pre_merge_evidence.py \
  aria-kernel/tests/test_operator_feedback_signature.py \
  aria-kernel/tests/invariants/v7/test_phase_v7_1_plan_synthesizer.py \
  .github/CODEOWNERS docs/aria/runbooks/operator-feedback-signing.md
git commit -m "feat(aria): verify signed operator feedback" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 11: Enforce budget reconciliation and converged-plan content binding

**Files:**

- Modify: `aria-kernel/aria_kernel/pre_merge_evidence.py`
- Modify: `aria-kernel/aria_kernel/implementation_safety.py`
- Modify: `aria-kernel/aria_kernel/budget.py`
- Modify: `aria-kernel/aria_kernel/cost_budget.py`
- Create: `aria-kernel/tests/test_pre_merge_budget_and_content.py`
- Modify: `aria-kernel/tests/test_plan_convergence.py`

**Interfaces:**

- Implements: `cycle_and_turn_budget_cap`.
- Implements: `content_hash_recheck`.

- [ ] **Step 1: Write failing budget evidence tests**

Test a reconciled reservation within limits plus failures for unresolved reservation, actual cycle
cost above the policy cap, implementer turns above the policy-owned maximum, missing cost row, wrong
request ID, and a budget-policy hash that changed after reservation.

Read the implementer-turn limit from its existing policy authority; do not duplicate the current
value in implementation code.

- [ ] **Step 2: Write failing plan-binding tests**

Test the passing identity and each independent mismatch:

```text
converged revision content hash
== implementation request plan hash
== convergence envelope plan hash
== recomputed canonical plan-content hash
```

Also reject a correct hash bound to the wrong `change_id`, target branch head, revision, or coverage
target.

- [ ] **Step 3: Run and observe placeholder failures**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_pre_merge_budget_and_content.py \
  aria-kernel/tests/test_plan_convergence.py
```

- [ ] **Step 4: Implement budget reconciliation through existing owners**

Use `budget.py` and `cost_budget.py` readers to prove reservation, usage, and reconciliation belong
to the same cycle/request. No open reservation may survive the check. Reject unreadable or duplicate
authoritative rows.

- [ ] **Step 5: Recompute the production plan hash**

Reuse the canonical content loader and hash function in `plan_convergence.py`; do not serialize the
plan differently in implementation safety. Capture the four compared hashes and their ledger row
hashes in `PlanBindingEvidence`.

- [ ] **Step 6: Run neighbour suites**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_pre_merge_budget_and_content.py \
  aria-kernel/tests/test_context_budget_gate.py \
  aria-kernel/tests/test_cycle_wall_clock_budget.py \
  aria-kernel/tests/test_plan_convergence.py \
  aria-kernel/tests/test_claim_envelope_binding.py
```

- [ ] **Step 7: Commit and push**

```bash
git add aria-kernel/aria_kernel/pre_merge_evidence.py \
  aria-kernel/aria_kernel/implementation_safety.py \
  aria-kernel/aria_kernel/budget.py \
  aria-kernel/aria_kernel/cost_budget.py \
  aria-kernel/tests/test_pre_merge_budget_and_content.py \
  aria-kernel/tests/test_plan_convergence.py
git commit -m "feat(aria): bind merge to budget and plan content" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 12: Verify expert consensus and deterministic plan coverage

**Files:**

- Modify: `aria-kernel/aria_kernel/pre_merge_evidence.py`
- Modify: `aria-kernel/aria_kernel/implementation_safety.py`
- Modify: `aria-kernel/aria_kernel/expert_review_gate.py`
- Modify: `aria-kernel/aria_kernel/plan_coverage.py`
- Create: `aria-kernel/tests/test_pre_merge_consensus_and_coverage.py`
- Modify: `aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py`
- Modify: `aria-kernel/tests/invariants/v9/test_phase_v9_0_d_implementation_safety.py`

**Interfaces:**

- Implements: `expert_consensus_evidence_verified`.
- Implements: `plan_coverage_witness_verified`.
- Completes: all seven pre-merge hard-fail checks.

- [ ] **Step 1: Write failing consensus cases**

Require the existing `enforce_expert_consensus_gate(...)` verdict for the same `change_id`, plan
revision, base/head SHA, and reviewer set. Test missing, stale, duplicate-reviewer, non-anchor-only,
mutated-verdict, and ledger-chain failures.

- [ ] **Step 2: Write failing coverage-witness cases**

Require the latest deterministic coverage witness for the exact plan content hash and target SHA.
Test uncovered affected surface, stale target, changed waiver decision, unadjudicated waiver,
duplicate latest rows, and malformed evidence.

- [ ] **Step 3: Run and observe the final two placeholder failures**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_pre_merge_consensus_and_coverage.py \
  aria-kernel/tests/test_expert_review_gate.py \
  aria-kernel/tests/test_plan_coverage_gate.py
```

- [ ] **Step 4: Delegate to existing gate owners**

The implementation-safety checks must validate snapshot freshness and then call the existing
expert-consensus and plan-coverage authorities. Store reviewer verdict IDs, witness ID, target SHA,
waiver-adjudication hashes, and source ledger hashes in the typed snapshot. Do not implement a
lighter duplicate of either policy.

- [ ] **Step 5: Prove the registered perimeter has no placeholder callable**

Add a structural invariant over `HARD_FAIL_CHECKS`: every one of the seven pre-merge check names
must resolve to its concrete verifier, none may resolve to `_not_implemented`, and the registered
callable set must equal the policy-owned expected set. Delete the helper only if no non-perimeter
caller uses it; a repository-wide text search is informational, not the proof.

Add one all-green test that reaches `adapter.merge_pr`, then parameterize mutations of each of the
seven evidence sections and assert every mutation blocks before merge. This is also the first test
that calls `PreMergeEvidence.assert_complete()` successfully; Tasks 8-11 deliberately retained named
`MissingEvidence` slots.

The required GitHub status remains `aria-merge-authority`; do not create seven separately bypassable
required checks.

- [ ] **Step 6: Run the complete pre-merge suite**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/invariants/v9/test_phase_v9_0_d_implementation_safety.py \
  aria-kernel/tests/test_pre_merge_evidence.py \
  aria-kernel/tests/test_pre_merge_file_claims.py \
  aria-kernel/tests/test_operator_feedback_signature.py \
  aria-kernel/tests/test_pre_merge_budget_and_content.py \
  aria-kernel/tests/test_pre_merge_consensus_and_coverage.py \
  aria-kernel/tests/test_merge_authority_invariants.py \
  aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py
```

Expected: tests PASS, the registered seven-callable invariant is exact, and every evidence mutation
stops before `adapter.merge_pr`.

- [ ] **Step 7: Commit and push**

```bash
git add aria-kernel/aria_kernel/pre_merge_evidence.py \
  aria-kernel/aria_kernel/implementation_safety.py \
  aria-kernel/aria_kernel/expert_review_gate.py \
  aria-kernel/aria_kernel/plan_coverage.py \
  aria-kernel/tests/test_pre_merge_consensus_and_coverage.py \
  aria-kernel/tests/test_merge_authority_pre_merge_perimeter.py \
  aria-kernel/tests/invariants/v9/test_phase_v9_0_d_implementation_safety.py
git commit -m "feat(aria): close the pre-merge safety perimeter" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 13: Add meaningful Rust runtime-safety observation

**Files:**

- Create: `tools/aria-adapters/rust-runtime-safety-adapter.ts`
- Create: `tools/aria-adapters/rust-runtime-safety-adapter.test.ts`
- Create: `tools/aria-adapters/rust-runtime-safety-adapter.tool.json`
- Create: `tools/aria-adapters/fixtures/rust-runtime-safety-adapter/cases/real-repo-baseline.json`
- Create:
  `tools/aria-adapters/fixtures/rust-runtime-safety-adapter/cases/semantic-runtime-safety.json`
- Create:
  `tools/aria-adapters/fixtures/rust-runtime-safety-adapter/workspaces/semantic-runtime-safety/Cargo.toml`
- Create:
  `tools/aria-adapters/fixtures/rust-runtime-safety-adapter/workspaces/semantic-runtime-safety/src/lib.rs`
- Modify: `tools/aria-adapters/project.json`

**Interfaces:**

- Reads: Rust crates under `sens-api-gateway`, `apps/sensor-ingestion`, `crates`, and
  `sensorprotocols`, plus their `Cargo.toml`/`Cargo.lock` files.
- Emits: `detached_task`, `uncancellable_long_lived_loop`, `unsafe_without_safety_contract`, and
  `unbounded_external_io` claims with file/line evidence.

- [ ] **Step 1: Write failing semantic-fixture tests**

The fixture must contain paired safe/unsafe examples for:

- a discarded `tokio::spawn` handle versus a joined/stored handle;
- a long-lived async loop with no shutdown/select path versus a cancellation-aware loop;
- an `unsafe` block without a local `SAFETY:` contract versus a documented block;
- external NATS/HTTP I/O without a timeout/error boundary versus bounded I/O.

Assert stable fingerprints and prove comments/string literals containing the same tokens do not
create findings.

- [ ] **Step 2: Run and observe the missing adapter**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/aria-adapters/rust-runtime-safety-adapter.test.ts
```

- [ ] **Step 3: Implement a syntax-aware bounded scanner**

Use `cargo metadata --no-deps --format-version 1` to resolve workspace/crate boundaries. Build a
balanced-token scanner that removes comments and literals while preserving line offsets; findings
may not be based on a repository-wide regular expression alone. Every claim must cite the syntactic
construct and the bounded control-flow evidence that made it unsafe.

Refuse path escapes, cap bytes/files/cost units, sanitize subprocess errors, and return the standard
adapter output fields: `observations`, `findings`, `read_paths`, and `evidence_sources`.

- [ ] **Step 4: Register at `DRAFT`, then collect real sandbox evidence**

Adapter tools use `DRAFT -> SANDBOX -> SHADOW -> ACTIVE`; `REAL_SANDBOX` belongs to the separate
genesis-agent lifecycle and must not be added as an adapter status. Register the manifest at
`DRAFT`, run its production subprocess runner against the clean repository, then use the existing
governed transition command to reach `SANDBOX` and `SHADOW` with the fixture and real-run evidence
IDs.

Do not promote to ACTIVE in this task.

- [ ] **Step 5: Run fixture, portfolio, and observation tests**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/aria-adapters/rust-runtime-safety-adapter.test.ts
npx nx test aria-adapters
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_tool_lifecycle_matrix.py \
  aria-kernel/tests/test_observation_coverage.py
```

- [ ] **Step 6: Commit and push**

```bash
git add tools/aria-adapters/rust-runtime-safety-adapter.ts \
  tools/aria-adapters/rust-runtime-safety-adapter.test.ts \
  tools/aria-adapters/rust-runtime-safety-adapter.tool.json \
  tools/aria-adapters/fixtures/rust-runtime-safety-adapter \
  tools/aria-adapters/project.json
git commit -m "feat(aria): observe Rust runtime safety boundaries" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 14: Add SQL and TypeORM migration-safety observation

**Files:**

- Create: `tools/aria-adapters/sql-migration-safety-adapter.ts`
- Create: `tools/aria-adapters/sql-migration-safety-adapter.test.ts`
- Create: `tools/aria-adapters/sql-migration-safety-adapter.tool.json`
- Create: `tools/aria-adapters/fixtures/sql-migration-safety-adapter/cases/real-repo-baseline.json`
- Create:
  `tools/aria-adapters/fixtures/sql-migration-safety-adapter/cases/semantic-expand-contract.json`
- Create:
  `tools/aria-adapters/fixtures/sql-migration-safety-adapter/workspaces/semantic-expand-contract/apps/example/src/database/migrations/1900000000000-Change.ts`
- Modify: `tools/gates/migration-sql-lint.ts`
- Modify: `tools/aria-adapters/project.json`

**Interfaces:**

- Reads: tracked `.sql` files and TypeORM migration classes under `apps`, `database`, `scripts`,
  `tools`, and `infrastructure`.
- Emits: the existing migration-lint/expand-contract violation vocabulary as adapter findings.

- [ ] **Step 1: Write failing semantic-fixture cases**

Cover schema-unqualified DDL, a one-step populated-table `ADD COLUMN ... NOT NULL`, unsafe
destructive `DROP TYPE`, a tenant-scoped table without the canonical RLS path, and their
repository-approved safe forms. RLS applicability must come from existing schema and exclude-table
authorities, not from a new list in the adapter.

- [ ] **Step 2: Extract the existing gate as a reusable pure owner**

First write a failing compatibility test that the CLI output from
`tools/gates/migration-sql-lint.ts` and its new exported `inspectMigrationSource(...)` return
identical violations for the same input. Refactor without changing current gate behavior.

Reuse `expand-contract-ast.ts`, the schema registry, canonical RLS helper/exclusion authorities, and
orphan-type reclamation authority. The adapter is an observation wrapper around those owners, not
another SQL-policy implementation.

- [ ] **Step 3: Implement bounded discovery and evidence projection**

Resolve SQL literals inside TypeORM `up()`/`down()` methods and standalone SQL files. Each finding
carries rule ID, migration direction, schema/relation/type where known, source range, canonical
remediation, target SHA, and stable fingerprint.

Treat parse failure as an observation error, never as a clean result.

- [ ] **Step 4: Register through DRAFT, real SANDBOX, and SHADOW**

Run both semantic fixtures and the clean repository. Record the exact gate version and
schema-authority hashes in `evidence_sources`; transition through the existing tool lifecycle.
ACTIVE remains blocked until Task 17 calibration.

- [ ] **Step 5: Run the migration and adapter suites**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/aria-adapters/sql-migration-safety-adapter.test.ts
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/migration-sql-lint.spec.ts
npx nx test aria-adapters
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/no-unguarded-drop-type-in-migration.spec.ts \
  tests/invariants/rls-predicate-canonical.spec.ts
```

- [ ] **Step 6: Commit and push**

```bash
git add tools/aria-adapters/sql-migration-safety-adapter.ts \
  tools/aria-adapters/sql-migration-safety-adapter.test.ts \
  tools/aria-adapters/sql-migration-safety-adapter.tool.json \
  tools/aria-adapters/fixtures/sql-migration-safety-adapter \
  tools/gates/migration-sql-lint.ts tools/aria-adapters/project.json
git commit -m "feat(aria): observe governed migration safety" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 15: Add infrastructure-policy observation

**Files:**

- Create: `tools/aria-adapters/infrastructure-policy-adapter.ts`
- Create: `tools/aria-adapters/infrastructure-policy-adapter.test.ts`
- Create: `tools/aria-adapters/infrastructure-policy-adapter.tool.json`
- Create: `tools/aria-adapters/fixtures/infrastructure-policy-adapter/cases/real-repo-baseline.json`
- Create:
  `tools/aria-adapters/fixtures/infrastructure-policy-adapter/cases/semantic-infrastructure-policy.json`
- Create:
  `tools/aria-adapters/fixtures/infrastructure-policy-adapter/workspaces/semantic-infrastructure-policy/deployment.yaml`
- Create:
  `tools/aria-adapters/fixtures/infrastructure-policy-adapter/workspaces/semantic-infrastructure-policy/main.tf`
- Create:
  `tools/aria-adapters/fixtures/infrastructure-policy-adapter/workspaces/semantic-infrastructure-policy/Dockerfile`
- Modify: `tools/aria-adapters/project.json`

**Interfaces:**

- Reads: Dockerfiles, Compose, Helm/Kubernetes YAML, Terraform HCL, NATS/nginx configuration, and
  deployment manifests under `infrastructure`, `infra`, `deploy`, `mcp`, `nginx`, and relevant
  repository-root files.
- Emits: high-confidence `floating_artifact`, `privileged_runtime`, `literal_secret`,
  `nats_password_identity`, and `missing_runtime_guard` claims.

- [ ] **Step 1: Write failing parser and policy fixtures**

Use paired examples for mutable image/action/tool references, root/privileged containers, secret
literals, NATS username/password configuration, and missing resource/health constraints. Include
multi-document YAML, anchors, quoted lookalikes, Terraform nested blocks, Docker multi-stage builds,
and nginx/NATS comments.

- [ ] **Step 2: Run and observe the missing adapter**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/aria-adapters/infrastructure-policy-adapter.test.ts
```

- [ ] **Step 3: Implement format-specific readers**

Use the repository's installed `js-yaml` parser for YAML, Docker instruction tokenization for
Dockerfiles, and a balanced-block lexer for the bounded HCL claims. Reuse existing image-pin, NATS
identity, secret-pattern, deploy-SSoT, and health/resource invariant constants where they already
own policy.

Do not report a missing resource/health field where the existing deployment authority explicitly
supplies it in another composed manifest; include that composition evidence in the observation.

- [ ] **Step 4: Register through DRAFT, real SANDBOX, and SHADOW**

The real-repository baseline must enumerate every read path and fail if a declared file was silently
skipped after a parse error. ACTIVE remains blocked pending calibrated precision and Task 17
coverage.

- [ ] **Step 5: Run neighbour invariants**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/aria-adapters/infrastructure-policy-adapter.test.ts
npx nx test aria-adapters
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/nats-config-ssot.spec.ts \
  tests/invariants/postgres-image-uniformity.spec.ts \
  tests/invariants/deploy-ssot-contract.spec.ts \
  tests/invariants/helm-dependency-single-path.spec.ts
```

- [ ] **Step 6: Commit and push**

```bash
git add tools/aria-adapters/infrastructure-policy-adapter.ts \
  tools/aria-adapters/infrastructure-policy-adapter.test.ts \
  tools/aria-adapters/infrastructure-policy-adapter.tool.json \
  tools/aria-adapters/fixtures/infrastructure-policy-adapter \
  tools/aria-adapters/project.json
git commit -m "feat(aria): observe infrastructure policy boundaries" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 16: Add workflow and shell safety observation

**Files:**

- Create: `tools/aria-adapters/workflow-shell-safety-adapter.ts`
- Create: `tools/aria-adapters/workflow-shell-safety-adapter.test.ts`
- Create: `tools/aria-adapters/workflow-shell-safety-adapter.tool.json`
- Create: `tools/aria-adapters/fixtures/workflow-shell-safety-adapter/cases/real-repo-baseline.json`
- Create:
  `tools/aria-adapters/fixtures/workflow-shell-safety-adapter/cases/semantic-command-safety.json`
- Create:
  `tools/aria-adapters/fixtures/workflow-shell-safety-adapter/workspaces/semantic-command-safety/.github/workflows/unsafe.yml`
- Create:
  `tools/aria-adapters/fixtures/workflow-shell-safety-adapter/workspaces/semantic-command-safety/scripts/unsafe.sh`
- Modify: `tools/aria-adapters/project.json`

**Interfaces:**

- Reads: `.github/workflows/*.{yml,yaml}`, tracked shell scripts, and executable hook/script files
  under `.husky`, `scripts`, `tools`, `infra`, `infrastructure`, `platform`, `libs`, and Rust
  service roots.
- Emits: `unpinned_action`, `untrusted_workflow_interpolation`, `overbroad_write_token`,
  `pipe_to_shell`, `governance_bypass_command`, and `missing_strict_shell_mode` claims.

- [ ] **Step 1: Write failing workflow and shell fixtures**

Cover full-SHA versus tag action pins, pull-request-controlled interpolation in `run:`,
least-privilege versus broad `permissions`, `curl|bash` including whitespace variants, executable
scripts with/without `set -euo pipefail`, and forbidden `git push --force`, `--no-verify`, or
`--no-gpg-sign` commands. Prove quoted documentation and test fixture strings are not mistaken for
executable commands.

- [ ] **Step 2: Run and observe the missing adapter**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/aria-adapters/workflow-shell-safety-adapter.test.ts
```

- [ ] **Step 3: Reuse workflow and command authorities**

Parse workflow YAML with `js-yaml`; call the current `gha-sha-pin.ts`, workflow-contract registry,
injection checks, and governed banned-command definitions. Tokenize shell commands with the
installed `shell-quote` package plus heredoc/comment handling. Do not create another action-pin rule
or banned-command list.

`missing_strict_shell_mode` applies only to executable Bash scripts that perform mutations or
pipelines; POSIX `sh`, sourced fragments, generated fixtures, and one-line probes require an
explicit reason in the observation instead of an automatic finding.

- [ ] **Step 4: Register through DRAFT, real SANDBOX, and SHADOW**

Run the production adapter against a clean clone and store the workflow registry hash, action-pin
owner version, and command-policy hash. Keep the adapter SHADOW until Task 17.

- [ ] **Step 5: Run workflow contract neighbours**

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/aria-adapters/workflow-shell-safety-adapter.test.ts
npx nx test aria-adapters
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/aria-workflow-sha-pin.spec.ts \
  tests/invariants/aria-workflow-input-injection.spec.ts \
  tests/invariants/workflow-secret-provisioning.spec.ts
```

- [ ] **Step 6: Commit and push**

```bash
git add tools/aria-adapters/workflow-shell-safety-adapter.ts \
  tools/aria-adapters/workflow-shell-safety-adapter.test.ts \
  tools/aria-adapters/workflow-shell-safety-adapter.tool.json \
  tools/aria-adapters/fixtures/workflow-shell-safety-adapter \
  tools/aria-adapters/project.json
git commit -m "feat(aria): observe workflow and shell safety" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

---

### Task 17: Prove meaningful whole-repository observation and a vertical slice

**Files:**

- Modify: `aria-kernel/aria_kernel/observation_coverage.py`
- Modify: `aria-kernel/aria_kernel/twin.py`
- Modify: `aria-kernel/aria_kernel/recursive_impact.py`
- Modify: `aria-kernel/aria_kernel/mission_scheduler.py`
- Create: `aria-kernel/aria_kernel/vertical_slice_evidence.py`
- Modify: `aria-kernel/tests/test_observation_coverage.py`
- Modify: `aria-kernel/tests/test_twin_map.py`
- Modify: `aria-kernel/tests/test_twin_cycle_wiring.py`
- Create: `aria-kernel/tests/test_vertical_slice_evidence.py`
- Modify: `tools/aria-adapters/test-gap-adapter.ts`
- Modify: `tools/aria-adapters/test-gap-adapter.tool.json`
- Modify: `tools/aria-adapters/bundle-budget-adapter.ts`
- Modify: `tools/aria-adapters/bundle-budget-adapter.tool.json`
- Modify: `tools/aria-adapters/doc-staleness-adapter.tool.json`
- Modify: `aria-config/observation_map.json`
- Create after live selection: `docs/superpowers/plans/2026-08-22-aria-reference-vertical-slice.md`

**Interfaces:**

- Tightens: `evaluate_observation_coverage(...)` so partial behavioral coverage is not green.
- Produces: `select_reference_vertical_slice(...) -> VerticalSliceSelection`.
- Produces: `build_vertical_slice_evidence(...) -> VerticalSliceEvidence` and
  `verify_vertical_slice_evidence(...) -> VerticalSliceVerdict`.
- Joins: observation map, twin map, recursive impact, mission risk, implementation evidence, tests,
  event contracts, and target SHA.

- [ ] **Step 1: Write the failing meaningful-coverage tests**

Change the acceptance predicate to:

```text
every tracked behavior-bearing file is matched by an adapter that actually
reads its type, or the exact path matches a reviewed non-behavioral exemption
with a non-empty reason; unreadable and partial are not green
```

Add tests proving one observed file cannot green an otherwise partial root, a broad root exemption
cannot hide code, an expired exemption fails, and generated/vendor/binary asset path exemptions
leave the coverage denominator rather than count as observation.

- [ ] **Step 2: Close the measured language/surface gaps**

Use the derived map, not a handwritten root claim. The expected owned mapping is:

| Surface                                                                | Observing owner                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| NestJS/TypeScript and React/MFE JS/TS/JSX/TSX                          | existing semantic adapters plus expanded `test-gap-adapter` |
| Python kernel/runtime                                                  | `kernel-dead-wire` and `agent-harness-security`             |
| Rust/Cargo                                                             | Task 13 adapter plus expanded test-gap adjacency            |
| SQL/TypeORM migrations                                                 | Task 14 adapter                                             |
| Docker/Compose/Helm/Kubernetes/Terraform/NATS/nginx/root deploy config | Task 15 adapter                                             |
| GitHub workflows and executable shell                                  | Task 16 adapter                                             |
| CSS/HTML/SVG/web manifests and shipped image sizes                     | expanded `bundle-budget-adapter`                            |
| Agent/review Markdown outside `docs`                                   | expanded `doc-staleness-adapter`                            |
| Test fixtures for supported languages                                  | expanded `test-gap-adapter`, recorded as fixture evidence   |

Only generated maps, compiler output, third-party/vendor material, archived snapshots, and
non-executable binary fixtures may enter `intentionally_unowned_paths`. Pin its only accepted record
shape:

```json
{
  "glob": "exact/bounded/pattern",
  "reason": "why this is non-behavioral",
  "owner": "reviewing team or identity",
  "review_expires_at": "RFC3339 timestamp",
  "provenance_sha256": "sha256 of the reviewed source set"
}
```

Reject repository-root/directory-wide globs and any exemption whose expansion includes executable or
behavior-bearing source suffixes. The authority must expand the glob at `target_sha`, hash the exact
match set, and reject an empty, changed, expired, or unowned exemption.

- [ ] **Step 3: Run the real repository coverage gate**

```bash
PYTHONPATH=aria-kernel python3 - <<'PY'
from aria_kernel.observation_coverage import evaluate_observation_coverage
verdict = evaluate_observation_coverage('.')
print(verdict.as_dict())
raise SystemExit(0 if verdict.verdict == 'green' and verdict.observed_ratio == 1.0 else 1)
PY
```

Expected: PASS with no `unknown`, `partial`, or `unobserved` behavioral file. Commit the
machine-derived map summary; do not commit a mutable second dashboard.

- [ ] **Step 4: Write failing deterministic vertical-slice selection tests**

Among eligible service-hardening missions with equal operator priority, select highest proven risk,
then lowest aggregate D1-D6 evidence score, then existing deterministic age/ID keys. Missing
dimension evidence ranks below a measured score and is named in the decision. A capability gap that
blocks observation still outranks product work under the current scheduler rules.

- [ ] **Step 5: Build and verify one target-SHA-bound slice witness**

Build nodes through `twin_context_for_files(...)` plus the production recursive-impact result;
callers may not supply an already-passing node list. `VerticalSliceEvidence` must bind the selection
ID, mission/finding ID, base/head SHA, plan hash, PR number, merged SHA, adapter run IDs, and these
required edge kinds:

```text
ui_to_contract
contract_to_handler
handler_to_repository_or_schema
repository_or_schema_to_event_or_outbox
event_or_outbox_to_consumer
implementation_to_unit_test
implementation_to_integration_test
implementation_to_e2e_test
```

Reject a caller-selected service, a missing/ambiguous edge, stale twin/impact SHA, missing test
class, adapter blindness, a changed plan, or a different PR head. Every edge cites source/target
node IDs and the authoritative evidence row that established it. The reference slice is L1,
L2-supervised, or L3 according to the existing risk classifier; this task does not lower its risk.

- [ ] **Step 6: Calibrate adapters through the existing lifecycle**

For Tasks 13-16 and changed existing adapters, run real fixtures and SHADOW evaluation, generate
calibration reports, adjudicate false positives through the existing panel, and promote only
adapters satisfying the existing precision, zero-critical-false-positive, valid-evidence-chain, and
approval gates. Direct manifest edits to ACTIVE are forbidden.

- [ ] **Step 7: Run the whole observation/twin suite**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_observation_coverage.py \
  aria-kernel/tests/test_twin_map.py \
  aria-kernel/tests/test_twin_cycle_wiring.py \
  aria-kernel/tests/test_vertical_slice_evidence.py \
  aria-kernel/tests/test_adapter_portfolio.py \
  aria-kernel/tests/test_registry_adapter_sync_m6.py
npx nx test aria-adapters
npx nx lint aria-adapters
```

- [ ] **Step 8: Commit, push, review, and merge the observation/selection machinery**

Tasks 13-16 must already be separate merged PRs. Keep this change in its own worktree/PR; it must
not include an invented product slice.

```bash
git add aria-kernel/aria_kernel/observation_coverage.py \
  aria-kernel/aria_kernel/twin.py \
  aria-kernel/aria_kernel/recursive_impact.py \
  aria-kernel/aria_kernel/mission_scheduler.py \
  aria-kernel/aria_kernel/vertical_slice_evidence.py \
  aria-kernel/tests/test_observation_coverage.py \
  aria-kernel/tests/test_twin_map.py \
  aria-kernel/tests/test_twin_cycle_wiring.py \
  aria-kernel/tests/test_vertical_slice_evidence.py \
  tools/aria-adapters/test-gap-adapter.ts \
  tools/aria-adapters/test-gap-adapter.tool.json \
  tools/aria-adapters/bundle-budget-adapter.ts \
  tools/aria-adapters/bundle-budget-adapter.tool.json \
  tools/aria-adapters/doc-staleness-adapter.tool.json \
  aria-config/observation_map.json
git commit -m "feat(aria): enforce whole-repo slice evidence" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

Do not continue until this commit is reachable from `origin/main` and the real repository coverage
verdict remains green in a clean clone.

- [ ] **Step 9: Let the merged scheduler select the reference mission**

Run the production selector against the fresh main/state tips. Persist `VerticalSliceSelection`
before any product edit. If the winner is a capability gap, close that gap through the relevant
earlier task and rerun; never skip it to obtain a convenient product mission. Once a product mission
wins, freeze its selection ID, finding ID, risk lane, target SHA, evidence-score inputs, and
tie-break trace.

- [ ] **Step 10: Write and review the selection-bound child plan**

Use `superpowers:writing-plans` to create
`docs/superpowers/plans/2026-08-22-aria-reference-vertical-slice.md`. It must name the selected
mission/finding and exact product files, tests, contract/schema/event edges, rollback path, risk
lane, approvals, seven-check evidence, matching `Closes:` trailer, and small TDD commits. Run
`superpowers:requesting-code-review` on that plan before touching product code. If selection
changes, invalidate and regenerate the child plan; do not silently edit its target identity.

- [ ] **Step 11: Execute the product slice as an external live checkpoint**

Execute the reviewed child plan in a new worktree and separate PR using
`superpowers:subagent-driven-development` (same session) or `superpowers:executing-plans` (separate
session). Before the human merge, run all seven checks through an explicitly named
`non_authorizing_pre_merge_evaluation` and bind the result to the PR head. This proves witness/check
compatibility but does not pretend the human merge called ARIA's merge authority. Stop at supervised
merge for L2 and require the existing two-role approval for L3.

After merge, record the PR URL, merged SHA, witness digest, adapter run IDs, affected Nx projects,
unit/integration/e2e results, and non-authorizing evaluation digest. Close the scheduler-selected
product finding only against that reachable merge, then rebuild and verify the witness plus resolved
finding state from remote facts. Rollback/incident and a genuinely authority-executed seven-check
merge are proven later by Task 18 readiness plus Task 19's L1 autonomous outcomes. A kernel-only
self-change, a manually chosen service, an unmerged PR, or a witness created solely from fixture
data is not a valid reference slice.

---

### Task 18: Establish Mode A, signed readiness, and a real rollback proof

**Files:**

- Create: `.github/actions/mint-aria-app-token/action.yml`
- Modify: `.github/workflows/aria-auto-cycle.yml`
- Modify: `.github/workflows/aria-agent-executor.yml`
- Modify: `.github/workflows/aria-agent-eval.yml`
- Modify: `.github/workflows/aria-readiness-claim.yml`
- Modify: `aria-kernel/aria_kernel/gh_token_factory.py`
- Create: `aria-kernel/aria_kernel/readiness_schema.py`
- Modify: `aria-kernel/aria_kernel/readiness_proofs.py`
- Modify: `aria-kernel/aria_kernel/enterprise_readiness.py`
- Modify: `aria-kernel/aria_kernel/autonomy_evidence.py`
- Modify: `aria-kernel/aria_kernel/rollback_bundle.py`
- Modify: `aria-kernel/aria_kernel/state_manifest.py`
- Create: `aria-kernel/tests/test_workflow_mode_a_transport.py`
- Create: `aria-kernel/tests/test_readiness_schema_upcast.py`
- Create: `aria-kernel/tests/test_signed_readiness_snapshot.py`
- Modify: `aria-kernel/tests/invariants/v9/test_phase_v9_0_c_gh_token_factory.py`
- Modify: `aria-kernel/tests/test_readiness_claim_lane.py`
- Modify: `aria-kernel/tests/test_readiness_proofs.py`
- Modify: `aria-kernel/tests/test_enterprise_readiness_and_genesis_lifecycle.py`
- Modify: `aria-kernel/tests/test_branch_protection_proof.py`
- Modify: `aria-kernel/tests/test_autonomy_evidence_status.py`
- Modify: `docs/runbooks/aria-github-app-setup.md`
- Modify: `docs/aria/runbooks/autonomy-unlock.md`

**Interfaces:**

- Extends: `mint_installation_token(...)` with exact repository/permission scope and measured
  expiry.
- Upgrades: readiness claims to `aria/enterprise-readiness-claim/v3` and branch-protection proofs to
  `aria/branch-protection-proof/v4`.
- Upcasts: legacy readiness v2 and branch-proof v3 into audit-only views that can never satisfy a
  new live claim.
- Replaces: the status evaluator's v2 live contract with a v3-only producer-native contract bound
  to a verified post-merge `resulting_main_sha`.
- Adds: a ledger-bound `state_snapshot_proof` and cryptographically verified CODEOWNERS evidence.
- Replaces: assertion-only rollback simulation with a disposable restore rehearsal.

- [ ] **Step 1: Write failing Mode-A transport invariants**

Across all four state-writing workflows, assert:

- `GITHUB_TOKEN` is used only for read/CI-evidence calls;
- no state push, PR mutation, or workflow dispatch uses `${{ github.token }}`;
- no `ARIA_GH_TOKEN`, operator PAT, or fallback expression can become a mutation credential;
- `ARIA_REQUIRE_MODE_A=true` is set before every governed mutation;
- the private-key secret is materialized under `$RUNNER_TEMP` with mode `0600`, is never logged or
  uploaded, and only its path reaches Python;
- installation tokens are minted with the exact repository and per-step permission set, masked
  immediately, and revoked in `always()` cleanup.

- [ ] **Step 2: Correct the token lease contract**

GitHub installation tokens expire one hour after creation; the current `ttl_seconds=300` field is
local metadata, not the provider's expiry. Parse the API's `expires_at`, returned permissions, and
repository selection into `InstallationTokenLease`, reject any broader/different result, and record
the measured values in token proof. Bound effective use by minting immediately before each mutation
and revoking in `finally`/`always()`. See
[GitHub's installation-token endpoint](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

Accept explicit `permissions` and repository identity in the factory. `InstallationTokenLease`
records installation ID, repository ID/full name, exact returned permissions, provider `expires_at`,
minted time, lease-file digest, and revocation result. Keep `ARIA_DRY_RUN` as a non-authoritative
sentinel for tests, but delete the operator-PAT fallback for every action-authority profile. A
missing App configuration must fail before a write.

- [ ] **Step 3: Implement the common local token action and migrate writers**

The local action must:

1. Materialize `ARIA_GH_APP_PRIVATE_KEY_PEM` in `$RUNNER_TEMP` without echoing it.
2. Mint through `gh_token_factory.py`, not an unpinned third-party action.
3. Write the token into a `0600` lease file and expose only the lease-file path; the raw token must
   never enter `$GITHUB_OUTPUT`, an artifact, cache, argument list, or persisted ledger.
4. Support an explicit cleanup mode called from an `if: always()` step to revoke the token and
   remove both token/private-key files.

The consuming process reads the lease file internally and keeps the credential in process memory
only. State publication must continue through the existing `state_store.publish_state`
remote-CAS/fast-forward path; only its Git authentication transport changes. A rejection, stale
expected tip, or non-fast-forward remains fail-closed. Use `contents:write` only for `aria/state`
publication, `pull_requests:write`/`contents:write` only for implementation PR operations, and
`actions:write` only for the executor's next-cycle dispatch. The GitHub App is the only allowed
writer actor for `aria/state`; each workflow's ambient `GITHUB_TOKEN` remains read-only and may only
restore/read state and CI evidence.

Implement and statically pin this migration matrix; every mutation row has its own mint immediately
before the consumer and `if: always()` revoke/delete immediately after it:

| Workflow / current step                                                | App permission input                 | Lease-path consumer                                     | Mutation transport                                                                              | Read-only token kept separate                                    |
| ---------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `aria-auto-cycle` / `Run the nightly cycle under the resolved profile` | `contents:write,pull_requests:write` | `ARIA_GH_APP_TOKEN_FILE` read only by the cycle process | process-local `GH_TOKEN` for governed PR create/update/merge adapters                           | `${{ github.token }}` only for preflight/check reads and restore |
| `aria-auto-cycle` / `Publish ARIA state...`                            | `contents:write`                     | state-publish shell reads lease file                    | process-local Git `http.extraheader` passed to `state_store.publish_state`; never a step output | restore action keeps ambient read token                          |
| `aria-agent-executor` / `Run CI executor`                              | `contents:write,pull_requests:write` | executor process reads lease file                       | process-local `GH_TOKEN` for governed implementation-PR operations                              | pending/check reads and restore use ambient read token           |
| `aria-agent-executor` / `Publish ARIA state...`                        | `contents:write`                     | state-publish shell reads lease file                    | same remote-CAS Git extraheader path                                                            | restore uses ambient read token                                  |
| `aria-agent-executor` / `Chain the next cycle...`                      | `actions:write`                      | chain step reads a distinct lease file                  | process-local `GH_TOKEN` only for `gh workflow run`                                             | cadence/run-history reads use ambient read token before mint     |
| `aria-agent-eval` / `Publish ARIA state...`                            | `contents:write`                     | state-publish shell reads lease file                    | same remote-CAS Git extraheader path                                                            | restore uses ambient read token                                  |
| `aria-readiness-claim` / `Publish ARIA state...`                       | `contents:write`                     | state-publish shell reads lease file                    | same remote-CAS Git extraheader path                                                            | PR/run/artifact reads and restore use ambient read token         |

The static invariant must locate every named step, exact permission input, lease-path env, consumer
command, and following cleanup step. It must reject a cleanup before the consumer, reuse of the
contents/PR lease for Actions dispatch, a token/header output, a missing `always()` cleanup, or any
mutation fallback to ambient/PAT credentials.

- [ ] **Step 4: Define schema upcasts before writing v3/v4 evidence**

Keep old v2 readiness claims and v3 branch proofs byte-for-byte immutable. `readiness_schema.py` may
project them into a display/audit view with explicit `legacy_missing_fields` and
`eligible_for_live_readiness=False`; it must never synthesize the new signature, App, CODEOWNERS,
rollback, or continuity proofs. The first v3/v4 claim cites the final legacy row plus the
operator-approved transition ref. Test unknown versions, lossy fields, legacy display, attempted
legacy promotion, and v3/v4 round-trip canonicalization.

Update `autonomy_evidence.py` in the same change: remove readiness v2 from the live evidence
contract and accept only terminal readiness v3 rows carrying the verified
`resulting_main_sha`. The producer obtains that SHA from the post-merge main fact, not from the PR
head or tree equality. `mode_a_signed_readiness_live_proven` requires exactly one admitted v3 live
readiness ref whose signed-snapshot predicate, App-authenticated state-CAS predicate, and full
readiness verifier all pass for that resulting main SHA. A valid v2 row remains visible in counts
and audit refs but leaves the operator prerequisite blocked.

Pin the coexistence boundary explicitly in `test_autonomy_evidence_status.py`: a v2-only ref on the
shared readiness surface cannot clear the blocker; v2 plus exactly one qualifying v3 ref may clear
it; two qualifying v3 refs fail the exact-one predicate. Match refs by proof kind, schema ID, and
schema version, never by surface alone.

- [ ] **Step 5: Write failing signed-readiness and CODEOWNERS tests**

Require readiness v3 to include:

```text
workflow/CI artifact proofs
fresh remote CAS
rollback + retention proof
zero open/expired/consumed waiver discrepancy
branch protection with exact checks and zero bypass actors
CODEOWNERS content hash + require_code_owner_reviews=true
DLP proof
measured GitHub App token proof
signed state snapshot proof
```

Mutation cases independently alter snapshot bytes, signature, public key, manifest root, predecessor
link, CODEOWNERS bytes, review setting, head SHA, and proof ledger ref.

- [ ] **Step 6: Produce and verify the signed state proof**

Use `state_snapshot.build_snapshot`, `sign_snapshot`, and `verify_snapshot_signature`; do not create
a second snapshot format. Mint an ephemeral per-cycle Ed25519 key, record its public fingerprint in
the governance trail, sign the full declared state snapshot under namespace `aria-state-snapshot`,
store only the manifest/signature/public key in a state-manifest-declared artifact path, and delete
the private key in `finally`.

The first live signed anchor requires an operator approval ref naming the existing unsigned-state
transition. Every later readiness proof must link to the previous signed `snapshot_id` and
`manifest_root`, report no lost required surface, and bind `parent_commit` to the claim's head SHA.

- [ ] **Step 7: Strengthen branch protection and rollback evidence**

Branch proof v4 must fetch `.github/CODEOWNERS` at the exact head SHA, record its SHA-256, and
require GitHub's code-owner-review setting in addition to the existing exact status checks, signed
commits, conversation resolution, force/delete denial, ruleset ID, and empty bypass set.

Replace `record_rollback_simulation({status: "passed"})` as a public assertion path. The producer
must clone the pre-merge `git bundle` into a disposable directory, check out the recorded target
commit, verify the tree hash and clean status, run the bundle's verification command, and then
record command/result/digest evidence. Delete the isolated clone after recording. A failed rehearsal
records failure and blocks readiness; it never writes a passed row.

- [ ] **Step 8: Prove auth transport, CAS, and readiness fail closed**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_workflow_mode_a_transport.py \
  aria-kernel/tests/test_readiness_schema_upcast.py \
  aria-kernel/tests/test_signed_readiness_snapshot.py \
  aria-kernel/tests/invariants/v9/test_phase_v9_0_c_gh_token_factory.py \
  aria-kernel/tests/test_readiness_claim_lane.py \
  aria-kernel/tests/test_readiness_proofs.py \
  aria-kernel/tests/test_branch_protection_proof.py \
  aria-kernel/tests/test_enterprise_readiness_and_genesis_lifecycle.py \
  aria-kernel/tests/test_state_snapshot.py \
  aria-kernel/tests/test_auto_merge.py \
  aria-kernel/tests/test_autonomy_evidence_status.py
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/aria-workflow-sha-pin.spec.ts \
  tests/invariants/aria-workflow-input-injection.spec.ts
```

Tests must also prove no token/private key survives a success, failure, cancellation cleanup path,
artifact scan, or persisted state row; a broader returned permission/repository is rejected; and
remote CAS rejection/non-fast-forward still blocks publication without retrying as a force push.

- [ ] **Step 9: Commit and push the code/runbook change, but keep the PR unmerged**

```bash
git add .github/actions/mint-aria-app-token/action.yml \
  .github/workflows/aria-auto-cycle.yml \
  .github/workflows/aria-agent-executor.yml \
  .github/workflows/aria-agent-eval.yml \
  .github/workflows/aria-readiness-claim.yml \
  aria-kernel/aria_kernel/gh_token_factory.py \
  aria-kernel/aria_kernel/readiness_schema.py \
  aria-kernel/aria_kernel/readiness_proofs.py \
  aria-kernel/aria_kernel/enterprise_readiness.py \
  aria-kernel/aria_kernel/autonomy_evidence.py \
  aria-kernel/aria_kernel/rollback_bundle.py \
  aria-kernel/aria_kernel/state_manifest.py \
  aria-kernel/tests/test_workflow_mode_a_transport.py \
  aria-kernel/tests/test_readiness_schema_upcast.py \
  aria-kernel/tests/test_signed_readiness_snapshot.py \
  aria-kernel/tests/invariants/v9/test_phase_v9_0_c_gh_token_factory.py \
  aria-kernel/tests/test_readiness_claim_lane.py \
  aria-kernel/tests/test_readiness_proofs.py \
  aria-kernel/tests/test_enterprise_readiness_and_genesis_lifecycle.py \
  aria-kernel/tests/test_branch_protection_proof.py \
  aria-kernel/tests/test_autonomy_evidence_status.py \
  docs/runbooks/aria-github-app-setup.md \
  docs/aria/runbooks/autonomy-unlock.md
git commit -m "feat(aria): require signed Mode A readiness" \
  -m "Closes: docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-789"
git push
```

- [ ] **Step 10: Complete the pre-merge operator checkpoint without storing secrets in Git**

Before this PR merges, the operator creates/installs the repository-scoped GitHub App, grants only
the permissions enumerated by the four workflow contracts, configures branch/ruleset restrictions
for the App identity, and creates the three Actions secrets (`ARIA_GH_APP_ID`,
`ARIA_GH_APP_INSTALLATION_ID`, `ARIA_GH_APP_PRIVATE_KEY_PEM`). Run the PR-safe no-write lease probe
and permission/repository assertions from the feature ref. Secret creation and App installation are
external human actions; the PR remains unmerged and status remains `operator_blocked` until they are
present. Therefore a missing configuration cannot land on `main` and stop the still-working legacy
workflows.

- [ ] **Step 11: Merge, then pass the post-merge live checkpoint**

After code review and the pre-merge configuration probe, merge Task 18. Verify with a dedicated
low-risk readiness canary PR and the live readiness workflow; this canary does not count as an
autonomous merge before Task 19 opens the relevant stage. After the canary merges, obtain the
verified PR-head-to-resulting-main mapping and accept only one v3 readiness claim whose
`resulting_main_sha` is that exact reachable main commit, with a successful App-authenticated state
CAS, every v3/v4 proof valid, no waiver/bypass, a valid signed snapshot, and a successful disposable
rollback restore. A squash merge is not proven by PR-head ancestry or tree equality. Confirm the
App actor—and no PAT or ambient token—authored the remote state publication. Task 20 closes
ORPHAN-HIGH-788 against its existing reachable fix `b19fee8b4fd7ee84caa530aa06b76784557ef044`; close
ORPHAN-MEDIUM-789 only against the main-reachable Task 18/operator-live closure commit recorded by
the Task 1 policy.

---

### Task 19: Bind staged autonomy counters to real outcomes and automatic freeze

**Files:**

- Create: `aria-kernel/aria_kernel/acceptance_reconciler.py`
- Create: `aria-kernel/tests/test_acceptance_reconciler.py`
- Create: `aria-kernel/tests/test_acceptance_reconcile_cursor.py`
- Create: `aria-kernel/tests/test_autonomy_stage_progression.py`
- Create: `aria-kernel/tests/test_autonomy_freeze_conditions.py`
- Modify: `aria-kernel/aria_kernel/autonomy_evidence.py`
- Modify: `aria-kernel/tests/test_autonomy_evidence_status.py`
- Modify: `aria-kernel/aria_kernel/auto_merge.py`
- Modify: `aria-kernel/aria_kernel/autonomy_unlock.py`
- Modify: `aria-kernel/aria_kernel/autonomy_ladder.py`
- Modify: `aria-kernel/aria_kernel/runtime_profile.py`
- Modify: `aria-kernel/aria_kernel/state_manifest.py`
- Modify: `aria-kernel/tests/test_state_manifest_transaction.py`
- Modify: `aria-kernel/aria_kernel/merge_authority.py`
- Modify: `aria-kernel/aria_kernel/rollback_bundle.py`
- Modify: `.github/workflows/aria-auto-cycle.yml`
- Modify: `docs/aria/policy/autonomy-unlock.json`
- Modify: `docs/aria/runbooks/autonomy-unlock.md`

**Interfaces:**

- Produces: `reconcile_acceptance_outcomes(...) -> AcceptanceReconciliationReport`.
- Persists: append-only `enterprise/acceptance-reconcile-cursor.jsonl` in the existing
  `enterprise_policy` lock group.
- Produces:
  `freeze_profile(reason, evidence_ref, set_by="safety-interlock") -> RuntimeProfileState`.
- Adds: an operator-owned `autonomy_stage` field to the existing runtime-profile control plane; no
  second master switch.
- Restricts: acceptance events to verified burn-in, merge, approval, or rollback outcome producers.
- Produces: the first live pre-merge-perimeter proof as a producer-native post-merge decision row
  bound by a verified PR-head-to-`resulting_main_sha` fact, plus target-bound unlock verdict rows.

- [ ] **Step 1: Write failing provenance, cursor, and idempotency tests**

The generic writer must no longer be able to mint a success from caller-supplied `event_type` alone.
Each counted row must cite a verified source row and stable outcome identity. Test duplicate
reconciliation, wrong SHA, open PR, failed merge, unfinalized incident, missing readiness claim,
wrong risk lane, wrong supervision mode, reused human actor, assertion-only rollback rows, paginated
GitHub results, equal merge timestamps, stale ETag, API failure, and crashes before/after each
durable append.

Required outcome mapping:

```text
accepted clean observe cycle                  -> observe_success
merged L1 PR under autonomous merge authority -> l1_autonomous_success
human-merged L2 PR with full ARIA evidence     -> l2_supervised_success
ARIA-merged L2 PR after L2 entry                -> l2_autonomous_success
merged L3 PR with two distinct approval roles   -> l3_approval_success
successful disposable restore for distinct SHA -> rollback_success
```

- [ ] **Step 2: Encode the immutable stage order in the existing policy**

Add a `stage_order` and derived entry requirements without changing any numeric threshold:

```text
observe_burn_in
l1_autonomous
l2_supervised
l2_autonomous
l3_two_stage
closed
```

An exactly-30-attempt burn-in with at least 20 valid cycles proves the burn-in gate. L1 entry
separately requires 30 real `observe_success` events; valid burn-in cycles may count once, but a
20-29-valid report requires additional accepted observe cycles. No failed/invalid attempt is
relabeled.

Then require, in order: 30 L1 autonomous merges, 30 L2 supervised merges, 10 L2 autonomous merges,
five L3 merges with two distinct human approval roles, and three successful rollback rehearsals. A
later counter can never satisfy an earlier stage.

- [ ] **Step 3: Store stage in the one runtime-profile control plane**

Extend `runtime-profile.json` and its history rows with `autonomy_stage`, evidence verdict hash, and
operator approval ref. Only an operator may advance a stage; ARIA may hold, lower, or freeze it.
Profile mapping remains:

```text
observe_burn_in -> observe
l1_autonomous   -> autonomous
l2_supervised   -> strict (ARIA opens/tests; a human merges)
l2_autonomous   -> autonomous
l3_two_stage    -> autonomous plus policy_approval verification
```

Entering a stage requires the prior stage's exact threshold verdict. Do not add six new profile
names or a parallel activation file.

- [ ] **Step 4: Implement the production acceptance reconciler**

Join GitHub merged-PR facts, risk decisions, readiness claims, merge-authority results, finalized
incident rows, rollback bundle/rehearsal rows, policy approvals, runtime stage, and target SHA. Make
rows idempotent by `(event_type, pr_number, merged_sha)` or
`(rollback_success, rollback_simulation_id)`.

Call the reconciler after a successful autonomous merge and from the scheduled cycle for
human-supervised merges that occurred since the last cursor. A GitHub API read failure yields an
explicit reconciliation failure; it never means no new merges.

At the successful merge boundary, `auto_merge.py` must write the producer-native terminal decision
only after verifying the GitHub merge fact maps the reviewed PR head to the exact
`resulting_main_sha`. Extend `autonomy_evidence.py` with that authoritative-SHA contract. Add a real
Git regression proving a squash PR head is not an ancestor of the resulting main commit: the PR
head must be rejected as `proof_non_ancestor`, while the verified resulting-main SHA is accepted.
Never substitute tree equality. This Task 19 contract—not Task 12 and not Task 20—turns the current
empty pre-merge live contract into evidence.

Declare `enterprise/acceptance-reconcile-cursor.jsonl` in `state_manifest.py` as an append-fsync
ledger in the same `enterprise_policy` lock group as `enterprise/acceptance-events.jsonl`. Each
cursor row carries:

```text
repo, last_merged_at, last_pr_number, source_etag, updated_at,
last_event_row_hash
```

Use the ordered `(merged_at, pr_number)` checkpoint and paginate until exhausted. Inside one
`state_transaction` over both ledgers, verify chains, skip already-present stable outcome IDs,
append missing acceptance rows, then append the cursor row last. The filesystem primitive is
lock-atomic but not crash-rollback-atomic, so correctness must not depend on rollback: a crash
before the cursor can replay and skip durable event IDs; the cursor never advances ahead of its
durable events. A replay returns the same counts and appends neither duplicate success nor a cursor
with a regressed checkpoint.

- [ ] **Step 5: Implement a monotonic automatic freeze path**

Immediately lower the existing runtime profile to `frozen` when any of these is observed:

- a critical policy violation;
- declared-ledger integrity or signed-snapshot continuity failure;
- a previously valid readiness family becomes invalid/unreadable;
- rollback rehearsal or real rollback failure;
- a merge outcome whose SHA/actor/evidence contradicts its acceptance row.

`freeze_profile(...)` is the only non-operator control-plane transition: it may move any
profile/stage to `frozen`, may never hold/raise/thaw authority, requires a named reason plus
verified evidence ref, and writes runtime-profile state/history through the existing control-plane
bypass with `set_by="safety-interlock"`. Thaw/advance continues to require a new operator approval
ref. A near-threshold count, transient executor failure, or ordinary rejected PR is not a freeze
trigger.

Record the freeze reason when diagnostic surfaces remain writable. If runtime-profile state itself
is unreadable or the freeze write fails, the workflow exits nonzero, emits a CI annotation/stderr
diagnostic without inventing a durable success row, and every subsequent action gate resolves the
effective profile as `frozen`. Add the safety diagnostic to the existing explicit diagnostic
allowlist; do not widen the frozen write surface.

The producer-native `enterprise_autonomy_unlock_events` terminal row must carry the complete
verified target/resulting-main SHA (as applicable to the accepted outcome family). Update the
`autonomy_unlock` status contract and exact tests so an assertion-only, legacy, PR-head-only, or
mismatched row remains countable but cannot unlock `live_proven` status. Task 20 consumes this
verdict; it may not synthesize a replacement row or authoritative SHA.

- [ ] **Step 6: Run progression, continuity, and freeze tests**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_acceptance_reconciler.py \
  aria-kernel/tests/test_acceptance_reconcile_cursor.py \
  aria-kernel/tests/test_state_manifest_transaction.py \
  aria-kernel/tests/test_autonomy_stage_progression.py \
  aria-kernel/tests/test_autonomy_freeze_conditions.py \
  aria-kernel/tests/test_autonomy_unlock_continuity.py \
  aria-kernel/tests/test_burn_in_ladder_bridge.py \
  aria-kernel/tests/test_cycle_burn_in_mode.py \
  aria-kernel/tests/test_nightly_profile_authority_contract.py \
  aria-kernel/tests/test_watchdog_freeze.py \
  aria-kernel/tests/test_auto_merge.py \
  aria-kernel/tests/test_autonomy_evidence_status.py
```

- [ ] **Step 7: Commit and push**

```bash
git add aria-kernel/aria_kernel/acceptance_reconciler.py \
  aria-kernel/aria_kernel/auto_merge.py \
  aria-kernel/aria_kernel/autonomy_evidence.py \
  aria-kernel/aria_kernel/autonomy_unlock.py \
  aria-kernel/aria_kernel/autonomy_ladder.py \
  aria-kernel/aria_kernel/runtime_profile.py \
  aria-kernel/aria_kernel/state_manifest.py \
  aria-kernel/aria_kernel/merge_authority.py \
  aria-kernel/aria_kernel/rollback_bundle.py \
  aria-kernel/tests/test_acceptance_reconciler.py \
  aria-kernel/tests/test_acceptance_reconcile_cursor.py \
  aria-kernel/tests/test_state_manifest_transaction.py \
  aria-kernel/tests/test_autonomy_stage_progression.py \
  aria-kernel/tests/test_autonomy_freeze_conditions.py \
  aria-kernel/tests/test_autonomy_evidence_status.py \
  .github/workflows/aria-auto-cycle.yml \
  docs/aria/policy/autonomy-unlock.json \
  docs/aria/runbooks/autonomy-unlock.md
git commit -m "feat(aria): bind autonomy stages to real outcomes" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

- [ ] **Step 8: Run the live ladder without manufacturing rows**

Advance only through the authoritative producers and operator stage transitions:

1. Complete the 30-attempt/20-valid burn-in and reach 30 consecutive real observe successes with no
   gap above 72 hours.
2. Accumulate 30 successful L1 autonomous merges.
3. Accumulate 30 successful L2 supervised merges.
4. Accumulate 10 successful L2 autonomous merges.
5. Accumulate five successful L3 PRs, each with `risk_owner` and `exception_owner` approvals from
   different people.
6. Accumulate three successful disposable restore rehearsals or real rollback outcomes for distinct
   merged SHAs.
7. Keep critical violations at zero and all readiness/integrity checks current.

Never append directly to `enterprise/acceptance-events.jsonl`; the source refs and reconciliation
cursor must explain every count.

For every L1/L2 autonomous count, retain the seven-check `PreMergeEvidence` digest bound to the PR
head/merge-result SHA plus the GitHub merge fact that maps that PR/head to the resulting
`origin/main` merge SHA. Pre-merge checks do not run on the post-merge SHA itself. Designate at
least one L1 outcome as Task 20's canonical real-authority perimeter proof and verify both sides of
this association.

- [ ] **Step 9: Verify the final live stage and freeze behavior**

For every stage, archive the exact unlock verdict row, runtime-profile history row, PR/run URLs,
merged SHA, incident row, and rollback evidence. Before the next stage, deliberately mutate each
freeze input in an isolated test state store and prove the profile returns to `frozen`; do not
inject a critical violation into the live acceptance ledger.

---

### Task 20: Issue the ARIA closure verdict and reconcile all authorities

**Files:**

- Create: `aria-kernel/aria_kernel/autonomy_closure.py`
- Modify: `aria-kernel/aria_kernel/cli.py`
- Create: `aria-kernel/tests/test_autonomy_closure.py`
- Create: `docs/aria/ARIA_AUTONOMY_CLOSURE_EVIDENCE.md`
- Modify: `docs/aria/CURRENT_STATE.md`
- Modify: `docs/aria/BEHAVIOUR.md`
- Read: `docs/aria/policy/autonomy-closure-findings.json`
- Modify: `docs/reviews/_registry/findings.jsonl` through `finding-registry.ts` only
- Modify: `tests/invariants/three-store-invariants.spec.ts`

**Interfaces:**

- Consumes: `aria-kernel autonomy status --evidence`, the policy and structured-registry blobs from
  the explicit evidence-target Git tree, remote Git reachability, signed readiness/acceptance
  ledgers, and test outputs.
- Produces:
  `derive_autonomy_closure_verdict(report_commit_sha, evidence_target_sha, ...) -> AutonomyClosureVerdict`.
- Adds:
  `aria-kernel autonomy closure verify --report-commit-sha <final-main-sha> --evidence-target-sha <runtime-evidence-sha>`;
  JSON output and a nonzero exit when any closure predicate is false.
- Adds: `aria-kernel autonomy closure preclose --evidence-target-sha <sha> --output <json>`;
  verifies every policy predicate except registry RESOLVED/report presence and emits the only
  eligible ID/closing-SHA batch.
- Adds: `aria-kernel autonomy closure render --evidence-target-sha <sha> --output <path>`;
  deterministic Markdown projection only after all non-report predicates are green.
- Produces: one immutable closure report Git-bound to the final `origin/main` history; it is a
  report, not a new runtime authority.

Task 20 is intentionally three sequential PRs because a finding cannot be closed against an unmerged
SHA: (A) closure verifier, (B) post-merge registry reconciliation, and (C) the final report. Create
each from the newly fetched `origin/main`; never stack all three on one branch.

- [ ] **Step 1: Write the failing closure-verdict and CLI tests (PR A)**

Add a test that refuses closure unless:

- every required Task 2 capability is `live_proven`;
- no capability is `operator_blocked`;
- all seven pre-merge checks passed for a PR head/merge-result SHA that a verified GitHub merge fact
  maps to a reachable resulting `origin/main` merge SHA;
- the learning funnel reached ACTIVE eligibility without duplicate promotion;
- meaningful observation ratio is 1.0 after exact-path exemptions;
- one product vertical slice merged with a valid witness and its selected finding resolved by that
  reachable merge;
- readiness v3, signed snapshot, rollback, incident, Mode A, and final ladder evidence bind the same
  reachable main history;
- every entry in the Task 1 `autonomy-closure-findings.json` authority is RESOLVED through a
  reachable matching fix commit and its required predicate is live/code proven at the declared
  level.

Also reject a report digest mismatch, an unreachable evidence target, a final target that is not the
requested `origin/main` commit, a report whose evidence target is not its ancestor, a non-report
code change between the evidence target and report commit, a state proof that is no longer an
ancestor of the verified state chain, and an unknown capability/schema version.

Policy and registry are one immutable code-tree snapshot: tests must prove that both
`docs/aria/policy/autonomy-closure-findings.json` and `docs/reviews/_registry/findings.jsonl` are
read from `evidence_target_sha`, never from the checkout or report commit. Reject a broken registry
hash chain at that snapshot, a policy entry absent from that snapshot's registry, any
policy/registry change between evidence target and report commit, and any attempt to make a verdict
pass by mutating a later branch or the local working tree.

Avoid a self-referential commit SHA in the Markdown file. The report stores `evidence_target_sha`,
`state_evidence_tip`, exact row IDs/hashes, and `report_payload_sha256`; compute that digest over
the canonical report payload with the digest field itself excluded. At verification, both SHAs are
explicit and the CLI must require `--evidence-target-sha` to equal the report payload. Task
2/runtime predicates evaluate only that evidence SHA. The separate `report_commit_sha` must equal
the requested final `origin/main`, contain the report blob, descend from the evidence target, and
differ only by the three closure-report/current-state/history-pointer documents. It never becomes a
substitute runtime-evidence target and the report is never edited after merge.

Add a regression that creates a docs-only PR C merge after a fully live-proven evidence SHA:
verification must stay green when passed the two correct SHAs, fail if the final report SHA is used
as the evidence target, and fail if any code/policy path changed between them.

- [ ] **Step 2: Run the red tests, then implement the derived verifier (PR A)**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_autonomy_closure.py
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/three-store-invariants.spec.ts
```

Expected: FAIL because there is no closure model/subcommand and the three-store invariant does not
yet validate the report projection.

Implement `AutonomyClosureVerdict` as an immutable collection of named predicate results and
evidence refs. It must load both the closure-finding policy blob and the structured-registry JSONL
blob with an explicit Git-object read equivalent to `git show <evidence_target_sha>:<path>`,
validate the policy schema/hash/CODEOWNERS protection and the registry's complete hash chain at that
same snapshot, then call the Task 2 evidence derivation and existing Git/state/readiness
authorities. Registry helpers must accept parsed snapshot content or an explicit tree/blob source;
they must not silently reopen the working-tree path. The report commit is consulted only for
ancestry, allowed-diff, and report-blob/digest checks. The verifier must not accept a finding-ID
list from the CLI/caller, copy policy, trust caller booleans, append a ledger, or update a
dashboard. The CLI serializes the same model and exits `0` only when `verdict == "closed"`.

- [ ] **Step 3: Verify, commit, push, review, and merge the verifier (PR A)**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
  aria-kernel/tests/test_autonomy_closure.py \
  aria-kernel/tests/test_autonomy_evidence_status.py
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/three-store-invariants.spec.ts
git add aria-kernel/aria_kernel/autonomy_closure.py \
  aria-kernel/aria_kernel/cli.py \
  aria-kernel/tests/test_autonomy_closure.py \
  tests/invariants/three-store-invariants.spec.ts
git commit -m "feat(aria): derive the autonomy closure verdict" \
  -m "Closes: ${ARIA_TASK_FINDING_REF:?set the governed finding reference}"
git push
```

Review and merge PR A, fetch `origin/main`, and include PR A's governed finding in PR B using its
now-reachable fix SHA.

- [ ] **Step 4: Prove every fix is on `origin/main` before closing findings (PR B)**

For every entry in the Task 1 closure-finding policy, resolve its fixing commit according to
`closure_mode` and run:

```bash
git merge-base --is-ancestor <fix-sha> origin/main
aria-kernel autonomy closure preclose \
  --evidence-target-sha "$(git rev-parse origin/main)" \
  --output /absolute/disposable/path/aria-closure-preclose.json
```

The preclose command must load both policy and registry from the supplied evidence-target tree and
fail the whole batch if that snapshot has a broken registry chain, a missing governed ID, or a
missing required code/live predicate, regression ref, historical fix, reachability check, or
matching trailer. It may tolerate OPEN state only because registry resolution is the explicitly
excluded preclose predicate; it never mutates the registry or consults a later/local registry. Run
the repository's actual closure command only for the exact ordered ID/SHA pairs in its output:

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/finding-registry.ts close <finding-id> <main-reachable-fix-sha>
```

`close` verifies reachability and the exact matching `Closes:` trailer, updates `closing_commits`,
and re-stitches the structured registry hash chain. There is no `transition` subcommand and no
direct JSONL edit. After the full batch:

```bash
npm run findings:verify
git add docs/reviews/_registry/findings.jsonl
git commit -m "chore(aria): reconcile autonomy closure findings"
git push
```

Review and merge PR B. Leave genuinely external or unsuccessful items OPEN; the closure test must
remain red instead of rewriting history or pointing an ID at the aggregate report commit.

- [ ] **Step 5: Requalify invalidated capabilities, then generate the report (PR C)**

From a fresh worktree at the newly fetched PR-B `origin/main`, restore state through the production
state-sync path and derive evidence status at that evaluation SHA. For every capability whose Task 2
authority hash changed or whose freshness/continuity window expired, rerun its originating live
checkpoint (Task 5 drains, Task 7 funnel, Task 17 witness if its authority changed, Task 18
readiness/restore, or Task 19 outcome/freeze qualification). Do not manufacture rows for an
unchanged capability and do not change code/policy during qualification; any required fix returns to
its owner task and invalidates this PR-C attempt.

When every capability projects to `live_proven`, freeze the current PR-B `origin/main` as
`evidence_target_sha`. Require all cited rows to be remotely readable, signed where required, and
explicit about their own event SHAs plus matching capability-authority hashes. Re-run the closure
verifier in report-generation mode only to render source values; it is still expected to refuse
`closed` until the report exists.

Generate and review `ARIA_AUTONOMY_CLOSURE_EVIDENCE.md`; do not type counts from memory:

```bash
aria-kernel autonomy closure render \
  --evidence-target-sha "$(git rev-parse origin/main)" \
  --output docs/aria/ARIA_AUTONOMY_CLOSURE_EVIDENCE.md
```

The renderer must refuse if any non-report predicate is red. The canonical payload records:

```text
evidence target SHA, state evidence tip, and report payload digest
cycle/executor/funnel counts
seven-check perimeter proof PR
adapter calibration and observation verdict
vertical-slice witness
Mode-A/readiness/signed-snapshot proof IDs
stage-by-stage acceptance counts and PR sets
rollback/incident evidence
remaining human-owned production boundaries
```

`BEHAVIOUR.md` remains a dated historical snapshot and gains only a pointer to the derived
current-state command/report. `CURRENT_STATE.md` becomes the concise current boundary and marks
older implementation plans historical, not executable authority.

Re-stamp the edited authority surface before verification:

```bash
npm run aria:authority-hash -- --write
```

- [ ] **Step 6: Run targeted and repository-wide verification (PR C)**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider aria-kernel/tests
npx nx test aria-adapters
npx jest --config tests/invariants/jest.config.ts --runInBand \
  tests/invariants/three-store-invariants.spec.ts
npm run findings:verify
npm run format:check
npm run type-check
npx nx affected --target=test --base=origin/main~1 --head=HEAD
npx nx affected --target=lint --base=origin/main~1 --head=HEAD
npx ts-node --project tools/gates/tsconfig.json tools/gates/aria-authority-hash.ts --check
```

Record command, exit code, log artifact hash, and tested SHA. A passing targeted suite cannot
replace the affected checks.

- [ ] **Step 7: Verify from a clean clone and a scheduled dry run (PR C)**

Create a disposable clone at the proposed closure SHA, restore the state branch through the
production action/CLI path, run integrity verification, derive evidence status, run the scheduled
workflow contract without mutation credentials, and prove it fails at the expected dry-run mutation
boundary rather than silently substituting a PAT or local state.

Re-read the Step 5 qualification rows from the remote state ref and verify they remain
event-SHA-bound, authority-hash-valid, signed where required, and reflected by
`autonomy status --evidence`; do not manufacture a second run merely to refresh the report.

- [ ] **Step 8: Commit, push, review, and merge the closure record (PR C)**

```bash
git add docs/aria/ARIA_AUTONOMY_CLOSURE_EVIDENCE.md \
  docs/aria/CURRENT_STATE.md docs/aria/BEHAVIOUR.md
git commit -m "chore(aria): record end-to-end autonomy closure"
git push
```

Use `superpowers:requesting-code-review`, resolve review findings through
`superpowers:receiving-code-review`, and run `superpowers:verification-before-completion` before
merge. PR C is documentation-only by construction; if code or policy changes, invalidate the
generated evidence target and return to the responsible task.

- [ ] **Step 9: Declare closure or name the exact blocker**

After server-side merge, fetch the new tip and run:

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/aria-authority-hash.ts --check
aria-kernel autonomy closure verify \
  --report-commit-sha "$(git rev-parse origin/main)" \
  --evidence-target-sha <evidence-target-sha-recorded-in-report>
```

Closure is green only when the post-merge command reports every required capability `live_proven`,
the report blob/digest and evidence ancestry are valid, the final SHA is reachable, the policy and
hash-valid structured registry loaded from the recorded evidence-target tree agree that all exact
closure findings are resolved, those two authority paths are unchanged through the report commit,
and no operator blocker remains. Otherwise publish the exact failed predicate and evidence ref, keep
this plan open, and continue from that task; do not use “mostly autonomous” as a terminal state.

Only after this verdict is green may a separate Superpowers plan be written for ARIA-native Work
Protocol features such as brainstorming, plan execution, subagent dispatch, systematic debugging,
verification-before-completion, and reusable skill/plugin packaging. That successor must not reopen
or redefine this closure evidence.
