# ARIA Operational Proof Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #1332 prove the exact published `aria/state` lineage through
a read-only Operational Proof, pass every exact-head gate, merge through branch
protection, then carry the resulting `main` into PR #1333 by a normal merge.

**Architecture:** One validated published-prefix extractor feeds publication,
store verification, and continuity. The canonical restore action gains a
default-on binding switch; publisher lanes keep binding, while Operational
Proof selects read-only checkout, verifies exact state, and runs burn-in only
against deterministic scratch roots. Workflow registry contracts, burn-in
evidence validation, and lifecycle diagnostics make every safety property
machine-detectable.

**Tech Stack:** Python 3.12 (`unittest`, `pytest`, ARIA kernel), TypeScript/Jest
Nx invariants, GitHub Actions YAML, Git worktrees, GitHub CLI.

**Spec:**
`docs/superpowers/specs/2026-08-28-aria-operational-proof-continuity-design.md`

## Global Constraints

- Target PR is #1332 (`fix/kernel-ci-timeouts`); implementation stays in
  `/var/aqua-saas/.worktrees/aria-ci-gate-completeness`.
- Never rewrite, compact, rebase, force-push, or publish live `aria/state` from
  Operational Proof.
- Grandfather only the first `N` rows from an exact, validated published
  snapshot; booleans, negatives, missing ledger counts, malformed claims, and
  unknown surfaces fail closed.
- Keep `permissions: contents: read` and checkout
  `persist-credentials: false`; obtain no write token.
- The shared restore action remains the only checkout implementation.
  Publisher lanes retain default binding; Operational Proof passes
  `bind-tools-root: 'false'` and supplies no bootstrap acknowledgement.
- Deterministic writable roots are `.aria-state-store`,
  `.aria-state-store.writers.jsonl`, the action's two checkout-verdict files,
  `$RUNNER_TEMP/aria-operational-proof`,
  `$RUNNER_TEMP/aria-operational-proof-tools`, and
  `$RUNNER_TEMP/aria-operational-proof-workspaces`.
- Burn-in mode never invokes `restore_and_replay`; a moving or damaged state
  reference remains a failed proof.
- A valid burn-in cycle requires `state_continuity.status == "ok"`,
  `reference_kind == "state_branch"`, `blocks_action is False`, and no
  recovery evidence at all.
- Artifact upload uses `if: always()` and uploads only the curated proof root;
  diagnostic preservation never changes a non-zero burn-in exit to success.
- The final proof is accepted only by the canonical Operational Proof verifier:
  it enforces the closed success-file allowlist, exact target SHA, run ID, and
  run attempt,
  initial/final state tip and store HEAD equality, stable writer-attestation
  hash/size, clean source/store trees, absent host identity, and a clean DLP
  scan over every staged artifact.
- Job budget remains exactly 90 minutes. Local pre-push remains unmodified even
  though its complete 5,048-test suite takes about 96 minutes on this host.
- Register findings before fix commits. Every fix commit has its exact
  `Closes:` trailer, no co-author trailer, and is pushed without bypass or
  force.
- After every change run `nx affected --target=test` and
  `nx affected --target=lint`; run the narrower RED/GREEN commands at each TDD
  slice as well.

## File and Responsibility Map

- `docs/reviews/aria/2026-08-28-operational-proof-continuity.md`: evidence and
  anchors for `ARIA-HIGH-024` and `ARIA-MEDIUM-025`.
- `docs/reviews/_registry/findings.jsonl`: governed OPEN finding records.
- `aria-kernel/aria_kernel/state_snapshot.py`: one manifest-validating
  published-prefix extractor beside `validate_snapshot_manifest`.
- `aria-kernel/aria_kernel/state_store.py`: publication and store-verification
  consumers of the validated prefix extractor plus the canonical writer
  attestation path helper.
- `aria-kernel/aria_kernel/cycle.py`: continuity probe consumer and the
  burn-in-specific no-recovery decision.
- `aria-kernel/aria_kernel/burn_in.py`: continuity acceptance evidence and one
  canonical terminal-row predicate.
- `aria-kernel/aria_kernel/cli.py`: route `state compact` to its existing
  handler.
- `aria-kernel/aria_kernel/operational_proof.py`: strict outer proof builder,
  DLP scan, closed artifact allowlist, and downloaded-bundle verifier.
- `.github/actions/restore-aria-state/action.yml`: canonical checkout with
  default-on writer binding and explicit read-only consumer mode.
- `.github/workflows/aria-operational-proof.yml`: exact restore, verification,
  isolated burn-in, postflight, and diagnostic upload sequence.
- `aria-kernel/aria_kernel/workflow_contract_registry.py`: typed workflow
  topology, action-input, mutation-marker, timeout, network, and upload
  contracts.
- `aria-kernel/aria_kernel/workflow_contracts.py`: generic enforcement of the
  registry's permission, step, action, and upload requirements.
- `aria-kernel/aria_kernel/docs_ssot.py`: generated docs read retention from the
  typed upload contract.
- `aria-kernel/tests/test_snapshot_line_grandfather.py`: real-Git prefix tests.
- `aria-kernel/tests/test_cycle_burn_in_mode.py`: no-recovery mode contract.
- `aria-kernel/tests/test_observe_burn_in.py`: real restored-state acceptance,
  continuity evidence, failure evidence, and lifecycle summary.
- `aria-kernel/tests/test_state_compact.py`: scratch-only CLI routing proof.
- `aria-kernel/tests/test_operational_proof.py`: outer manifest, postflight,
  allowlist, DLP, and exact-SHA/run verifier tests.
- `aria-kernel/tests/test_state_writer_attestations.py`: writer path ownership.
- `aria-kernel/tests/test_workflow_enterprise_preflight.py`: generic workflow
  contract RED/GREEN and Operational Proof mutation tests.
- `tests/invariants/aria-single-restore-path.spec.ts`: sole restore
  implementation and read-only-consumer invariant.
- `tests/invariants/aria-doc-runtime-ssot.spec.ts`: exact 90-minute runtime/docs
  pin.
- `tools/quality/format-scope.json`: generated ownership/formatter entries for
  newly tracked Markdown files.

---

### Task 1: Register the two new governed findings

**Files:**

- Create: `docs/reviews/aria/2026-08-28-operational-proof-continuity.md`
- Modify through allocator, ID stamping, and sanctioned branch-suffix rechain:
  `docs/reviews/_registry/findings.jsonl`
- Modify through generator: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: approved design spec and exact failure evidence from run
  `33113524069`.
- Produces: review anchors `#ARIA-HIGH-024` and `#ARIA-MEDIUM-025` used by
  later commit trailers.

- [ ] **Step 1: Write the review evidence file**

Use `apply_patch` to create this exact structure:

```markdown
# ARIA review — 2026-08-28: Operational Proof continuity

Run `33113524069` passed the ARIA suite and then aborted all 30 burn-in cycles
because the proof bootstrapped scratch state instead of restoring the published
`aria/state` reference. Canonical restore also binds the durable tools root by
default, which appends governance and index bytes before a read-only proof can
measure them.

## ARIA-HIGH-024 — Operational Proof does not prove published state continuity

The proof must use the canonical state checkout in read-only mode, require an
exact non-genesis state-branch reference, forbid burn-in recovery, verify the
same remote tip before and after measurement, and preserve failure artifacts
without changing the failing exit status.

Evidence: `.github/workflows/aria-operational-proof.yml`,
`.github/actions/restore-aria-state/action.yml`,
`aria-kernel/aria_kernel/cycle.py`, and GitHub Actions run `33113524069`.

## ARIA-MEDIUM-025 — Burn-in terminal summaries omit stopped and aborted rows

The cycle lifecycle defines completed, failed, stopped, and aborted as terminal,
but the aggregate burn-in summary recognizes only completed and failed. This
misreports valid terminal rows as missing while stopped and aborted cycles must
still remain invalid acceptance evidence.

Evidence: `aria-kernel/aria_kernel/cycle.py` and
`aria-kernel/aria_kernel/burn_in.py`.
```

- [ ] **Step 2: Create allocator stubs without predicting a sequence**

Use `apply_patch` to create
`docs/reviews/_registry/aria-operational-proof-continuity.stub.json`:

```json
{
  "severity": "HIGH",
  "state": "OPEN",
  "title": "Operational Proof does not prove published state continuity",
  "layer": 3,
  "evidence": ["docs/reviews/aria/2026-08-28-operational-proof-continuity.md"],
  "rule_violated": "CLAUDE.md root-cause-only and evidence trust requirements",
  "owner_agent": "platform-autonomy",
  "raised_in_cycle": "2026-08-28-operational-proof-continuity",
  "review_file": "docs/reviews/aria/2026-08-28-operational-proof-continuity.md",
  "created_at": "2026-08-28T09:32:47Z"
}
```

Use `apply_patch` to create
`docs/reviews/_registry/aria-terminal-summary.stub.json`:

```json
{
  "severity": "MEDIUM",
  "state": "OPEN",
  "title": "Burn-in terminal summaries omit stopped and aborted rows",
  "layer": 2,
  "evidence": ["docs/reviews/aria/2026-08-28-operational-proof-continuity.md"],
  "rule_violated": "ARIA cycle lifecycle terminal-status SSoT",
  "owner_agent": "platform-autonomy",
  "raised_in_cycle": "2026-08-28-operational-proof-continuity",
  "review_file": "docs/reviews/aria/2026-08-28-operational-proof-continuity.md",
  "created_at": "2026-08-28T09:32:48Z"
}
```

- [ ] **Step 3: Allocate and verify the exact IDs**

Run:

```bash
npm run findings:add -- ARIA docs/reviews/_registry/aria-operational-proof-continuity.stub.json
npm run findings:add -- ARIA docs/reviews/_registry/aria-terminal-summary.stub.json
npm run findings:verify
HIGH_ID="$(jq -r \
  'select(.title == "Operational Proof does not prove published state continuity") | .id' \
  docs/reviews/_registry/findings.jsonl)"
MEDIUM_ID="$(jq -r \
  'select(.title == "Burn-in terminal summaries omit stopped and aborted rows") | .id' \
  docs/reviews/_registry/findings.jsonl)"
test "$(printf '%s\n' "$HIGH_ID" | wc -l)" -eq 1
test "$(printf '%s\n' "$MEDIUM_ID" | wc -l)" -eq 1
[[ "$HIGH_ID" =~ ^ARIA-HIGH-[0-9]{3}$ ]]
[[ "$MEDIUM_ID" =~ ^ARIA-MEDIUM-[0-9]{3}$ ]]
test "$HIGH_ID" != "$MEDIUM_ID"
printf '%s\n' "$HIGH_ID" "$MEDIUM_ID"
```

Expected: the common-directory allocator appends two distinct schema-valid
IDs and registry chain verification exits 0. The IDs are derived uniquely from
exact titles after allocation, never predicted from the branch's local
registry tail.

- [ ] **Step 4: Stamp allocated IDs, rechain the branch suffix, and delete only
      the allocator stubs**

Use `apply_patch` to put the derived IDs in both review headings, every plan and
spec reference, and the Task 3/Task 5 future `Closes:` commands. In the two
newly allocated registry rows, use `apply_patch` to replace each path-only
`evidence` value with
`docs/reviews/aria/2026-08-28-operational-proof-continuity.md#<that-row's-derived-ID>`.
Do not change allocator semantics and do not append a correction or
supersession row.

Because those two rows are an unmerged branch-only suffix, discover the first
changed row's zero-based index by exact title, prove it is beyond the
byte-identical `origin/main` prefix, and invoke the canonical locked rechain:

```bash
REGISTRY=docs/reviews/_registry/findings.jsonl
git fetch origin +refs/heads/main:refs/remotes/origin/main
MAIN_ENTRY_COUNT="$(git show origin/main:"$REGISTRY" |
  awk 'NF { count += 1 } END { print count + 0 }')"
FIRST_CHANGED_INDEX="$(jq -s -r \
  --arg title "Operational Proof does not prove published state continuity" \
  'to_entries[] | select(.value.title == $title) | .key' "$REGISTRY")"
test "$(printf '%s\n' "$FIRST_CHANGED_INDEX" | wc -l)" -eq 1
test "$FIRST_CHANGED_INDEX" -ge "$MAIN_ENTRY_COUNT"
cmp <(git show origin/main:"$REGISTRY") \
  <(head -n "$MAIN_ENTRY_COUNT" "$REGISTRY")
jq -s -e '
  [.[] | select(
    .title == "Operational Proof does not prove published state continuity" or
    .title == "Burn-in terminal summaries omit stopped and aborted rows")]
  | length == 2 and
    all(.[];
      .evidence == [
        ("docs/reviews/aria/2026-08-28-operational-proof-continuity.md#" + .id)
      ])
' "$REGISTRY" >/dev/null
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/finding-registry.ts rechain-from "$FIRST_CHANGED_INDEX"
npm run findings:verify
```

The rechain command owns the common allocator lock and refuses any mutation to
the fetched canonical prefix. Then delete only the two stubs with
`apply_patch`. Expected tracked scope after deletion: the review Markdown and
registry JSONL; no stub remains.

- [ ] **Step 5: Regenerate format ownership and run traceability tests**

Run:

```bash
npm run quality:format-scope:generate
node tools/quality/quality.mjs format-scope check
npx jest --config tests/invariants/jest.config.ts --runTestsByPath \
  tests/invariants/finding-registry-integrity.spec.ts \
  tests/invariants/finding-evidence-shape.spec.ts \
  tests/invariants/three-store-invariants.spec.ts --runInBand
NX_DAEMON=false npx nx affected --target=test --output-style=static
NX_DAEMON=false npx nx affected --target=lint --output-style=static
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit and push the governed findings**

```bash
git add docs/reviews/aria/2026-08-28-operational-proof-continuity.md \
  docs/reviews/_registry/findings.jsonl tools/quality/format-scope.json \
  docs/superpowers/plans/2026-08-28-aria-operational-proof-continuity.md \
  docs/superpowers/specs/2026-08-28-aria-operational-proof-continuity-design.md
git diff --cached --check
git commit -m "chore(aria): register operational proof findings" \
  -m "The read-only continuity gate and terminal-summary correction need governed anchors before fix commits can resolve them."
git push origin HEAD:fix/kernel-ci-timeouts
```

Expected: hooks and push exit 0; local, remote, and PR head SHAs match.

---

### Task 2: Unify published-prefix validation across all consumers

**Files:**

- Modify: `aria-kernel/aria_kernel/state_snapshot.py:337`
- Modify: `aria-kernel/aria_kernel/state_store.py:1541-1590,4443-4483`
- Modify: `aria-kernel/aria_kernel/cycle.py:922-991`
- Test: `aria-kernel/tests/test_snapshot_line_grandfather.py`

**Interfaces:**

- Produces:
  `published_prefix_row_counts(published: dict[str, Any] | None) -> dict[str, int]`.
- Consumes: existing
  `build_snapshot(..., grandfather_row_counts: dict[str, int] | None)` strict
  prefix API; its signature remains unchanged.

- [ ] **Step 1: Pin the helper contract with failing unit tests**

Add `PublishedPrefixRowCountTests`. Build one complete valid manifest through
the real `state_snapshot.build_snapshot` fixture, then prove:

```text
test_none_has_no_published_prefix_counts
test_exact_declared_fixed_and_glob_ledger_keys_are_extracted
test_non_string_key_is_not_coerced
test_boolean_negative_missing_unknown_and_malformed_counts_are_refused
test_top_level_manifest_drift_is_refused_before_claim_extraction
```

Every malformed case mutates a deep copy of that complete valid manifest and
asserts `SnapshotError("state_snapshot_manifest_invalid:...")`. The glob case
must assert the exact original key
`cost_attribution:cost-attribution/2026-08.jsonl` is returned byte-for-byte;
no test may pass an incomplete surfaces-only object to the extractor.

- [ ] **Step 2: Run the helper tests and confirm RED**

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests:. \
python3 -m unittest -v \
  test_snapshot_line_grandfather.PublishedPrefixRowCountTests
```

Expected: import/attribute failure because the helper does not exist.

- [ ] **Step 3: Implement the one validated extractor**

Add the public function immediately beside `validate_snapshot_manifest` in
`state_snapshot.py` and export it from that module. The complete manifest is
validated before any claim is read, so top-level drift, unknown surfaces,
wrong claim keys, booleans, negatives, and missing counts all retain the
canonical `SnapshotError("state_snapshot_manifest_invalid:...")` refusal
class:

```python
def published_prefix_row_counts(
    published: dict[str, Any] | None,
) -> dict[str, int]:
    if published is None:
        return {}
    validate_snapshot_manifest(published)
    surfaces = published["surfaces"]
    declared = {surface.name: surface for surface in iter_surfaces()}
    counts: dict[str, int] = {}
    for key, claim in surfaces.items():
        surface = declared[surface_key_name(key)]
        if surface.state_class != "ledger":
            continue
        counts[key] = claim["row_count"]
    return counts
```

The validator is the sole claim-shape boundary, the declaration's `state_class`
is the sole ledger discriminator, and the already-validated string key is
preserved exactly. Do not coerce keys or infer ledger status from a suffix.

- [ ] **Step 4: Replace publication's inline extraction and make helper tests GREEN**

Change the `build_publishable_snapshot` call to:

```python
previous_snapshot = previous if isinstance(previous, dict) else None
return build_snapshot(
    snapshot_id=snapshot_id,
    cycle_id=cycle_id,
    lane=lane,
    roots=store_roots(store, repo_hash),
    parent_commit=parent_commit,
    previous=previous_snapshot,
    grandfather_row_counts=published_prefix_row_counts(previous_snapshot),
)
```

Run the helper tests and the two existing publication tests. Expected: PASS.

- [ ] **Step 5: Add verify-store RED tests**

Add:

```python
def test_verify_store_accepts_the_exact_inherited_oversized_prefix(self) -> None:
    store = self._published_store_with_inherited_fat_row()
    verdict = state_store.verify_state_store(store, repo_hash=REPO_HASH)
    self.assertTrue(verdict["valid"], verdict)
    self.assertEqual(verdict["status"], "ok")

def test_verify_store_rejects_an_oversized_row_after_the_published_prefix(self) -> None:
    store = self._published_store_with_inherited_fat_row()
    self._append_fat_row(store)
    with self.assertRaisesRegex(SnapshotError, "line_too_large"):
        state_store.verify_state_store(store, repo_hash=REPO_HASH)
```

Factor `_published_store_with_inherited_fat_row()` from the existing relaxed-cap
fixture; it must publish through the real bare remote.

- [ ] **Step 6: Run verify-store tests and confirm inherited history is RED**

Use the Task 2 targeted command. Expected: the inherited case raises
`snapshot_surface_line_too_large` before the caller is fixed.

- [ ] **Step 7: Pass exact published counts in `verify_state_store`**

Add:

```python
grandfather_row_counts=published_prefix_row_counts(published),
```

to its `build_snapshot` call. Re-run the two tests. Expected: inherited PASS;
new appended oversized row still fails.

- [ ] **Step 8: Add real state-branch continuity RED tests**

Add the exact test names:

```text
test_state_continuity_reports_ok_for_the_exact_inherited_oversized_prefix
test_state_continuity_rejects_an_oversized_row_after_the_published_prefix
test_state_continuity_does_not_grandfather_daily_anchor_counts
```

Use `checkout_state_store(self.repo)` so the store is exactly
`self.repo/.aria-state-store`, use `canonical_identity(self.repo)` for
publication, construct context through `build_phase_context(...)`, and assert
the passing verdict has `status == "ok"`,
`reference_kind == "state_branch"`, and `blocks_action is False`.

- [ ] **Step 9: Resolve the reference before the continuity snapshot**

In `_phase_state_continuity` use this order:

```python
reference, reference_kind = resolve_continuity_reference(
    Path(context.workspace_root)
)
grandfather = (
    published_prefix_row_counts(reference)
    if reference_kind == REFERENCE_STATE_BRANCH
    else {}
)
current = build_snapshot(
    snapshot_id=f"continuity-{context.cycle_id}",
    cycle_id=context.cycle_id,
    lane=context.mode,
    roots=continuity_probe_roots(
        Path(context.workspace_root), Path(context.base_dir)
    ),
    grandfather_row_counts=grandfather,
)
```

Daily anchors and missing references therefore cannot grant an exemption.

- [ ] **Step 10: Run the complete prefix and nearby regression suites**

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests:. \
python3 -m unittest -v test_snapshot_line_grandfather \
  test_state_store.StoreVerification \
  test_memory_gap.ReferenceResolutionTests \
  test_memory_gap.DescentComesFromTheTransport \
  test_memory_gap.ProbeRootsFollowTheStore \
  test_state_snapshot.SnapshotBuildTests
NX_DAEMON=false npx nx affected --target=test --output-style=static
NX_DAEMON=false npx nx affected --target=lint --output-style=static
```

Expected: all pass.

- [ ] **Step 11: Commit and push the complete prefix contract**

```bash
git add aria-kernel/aria_kernel/state_store.py \
  aria-kernel/aria_kernel/state_snapshot.py \
  aria-kernel/aria_kernel/cycle.py \
  aria-kernel/tests/test_snapshot_line_grandfather.py
git diff --cached --check
git commit -m "fix(aria): unify published prefix validation" \
  -m "Publication, store verification, and continuity must apply one historical row-prefix policy or the durable branch cannot verify its own immutable bytes." \
  -m "Closes: docs/reviews/aria/2026-08-23-state-publish-line-cap-regression.md#ARIA-HIGH-017"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git push origin HEAD:fix/kernel-ci-timeouts
```

Expected: hooks pass, the complete helper-owning change leaves no staged,
unstaged, or untracked residue before push, and PR head equals local HEAD.

---

### Task 3: Use one terminal lifecycle predicate in burn-in diagnostics

**Files:**

- Modify: `aria-kernel/aria_kernel/burn_in.py:11,450-465,749-810`
- Modify: `aria-kernel/tests/test_cycle_burn_in_mode.py`
- Test: `aria-kernel/tests/test_observe_burn_in.py`

**Interfaces:**

- Consumes: `cycle.CYCLE_TERMINAL_STATUSES`.
- Produces:
  `_cycle_row_is_terminal(row: dict[str, Any]) -> bool`, shared by both
  burn-in terminal consumers.

- [ ] **Step 1: Write the stopped/aborted RED test**

Add
`ObserveBurnInTests.test_stopped_and_aborted_terminal_rows_are_not_reported_missing`.
Import the existing chain-valid writer exactly as
`from tests._helpers.declared_fixtures import append_declared_fixture`. Use it
with `expected_surface="cycles"` to seed canonical completed, failed, stopped,
and aborted rows; call `_cycle_ledger_summary`; assert:

```python
self.assertEqual(summary["terminal_row_count"], 4)
self.assertEqual(summary["missing_terminal_rows"], [])
for status in ("stopped", "aborted"):
    validity = _cycle_validity(
        {"cycle_id": status, "status": status},
        cycle_ledger_summary=summary,
    )
    self.assertFalse(validity["valid"])
    self.assertIn("cycle_not_completed", validity["reasons"])
    self.assertNotIn("terminal_cycle_row_missing", validity["reasons"])
```

- [ ] **Step 2: Run the exact test and confirm RED**

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests:. \
python3 -m unittest -v \
  test_observe_burn_in.ObserveBurnInTests.test_stopped_and_aborted_terminal_rows_are_not_reported_missing
```

Expected: stopped/aborted appear in `missing_terminal_rows`.

- [ ] **Step 3: Implement and reuse the canonical predicate**

```python
def _cycle_row_is_terminal(row: dict[str, Any]) -> bool:
    status = row.get("status")
    event = row.get("event")
    return (
        status in CYCLE_TERMINAL_STATUSES
        or event in CYCLE_TERMINAL_STATUSES
        or event in {"cycle_completed", "cycle_failed"}
    )
```

Use it in `_cycle_has_terminal_row` and `_cycle_ledger_summary`. Update
`ModeDeclarationTests.test_burn_in_imports_no_cycle_phase_primitive` so
`CYCLE_TERMINAL_STATUSES` is accepted as data, not a phase primitive.

- [ ] **Step 4: Run lifecycle tests and affected Nx gates**

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests:. \
python3 -m unittest -v test_observe_burn_in \
  test_cycle_burn_in_mode test_cycle_status_field_invariant
NX_DAEMON=false npx nx affected --target=test --output-style=static
NX_DAEMON=false npx nx affected --target=lint --output-style=static
```

Expected: all pass; stopped/aborted remain invalid cycles.

- [ ] **Step 5: Commit and push the diagnostic fix**

```bash
FINDING_ID="$(jq -r 'select(.title == "Burn-in terminal summaries omit stopped and aborted rows") | .id' \
  docs/reviews/_registry/findings.jsonl)"
test "$FINDING_ID" = "ARIA-MEDIUM-025"
rg -Fq "## $FINDING_ID — Burn-in terminal summaries omit stopped and aborted rows" \
  docs/reviews/aria/2026-08-28-operational-proof-continuity.md
git add aria-kernel/aria_kernel/burn_in.py \
  aria-kernel/tests/test_observe_burn_in.py \
  aria-kernel/tests/test_cycle_burn_in_mode.py
git diff --cached --check
git commit -m "fix(aria): align burn-in terminal summaries" \
  -m "Burn-in diagnostics must consume the cycle lifecycle terminal SSoT so stopped and aborted rows are observed without becoming valid acceptance cycles." \
  -m "Closes: docs/reviews/aria/2026-08-28-operational-proof-continuity.md#$FINDING_ID"
git push origin HEAD:fix/kernel-ci-timeouts
```

---

### Task 4: Route `state compact` to its existing handler

**Files:**

- Modify: `aria-kernel/aria_kernel/cli.py:477-478`
- Test: `aria-kernel/tests/test_state_compact.py`
- Modify: `docs/reviews/orphan-findings.md#ORPHAN-HIGH-798`

**Interfaces:**

- Consumes:
  `compact_state(*, base_dir, retain_days=7, dry_run=False) -> dict[str, Any]`.
- Produces: reachable `state compact --dry-run`; no live-store invocation.

- [ ] **Step 1: Write the real CLI RED test**

Add `StateCompactTests.test_cli_state_compact_dry_run_reaches_handler`:

```python
def snapshot_tools_tree() -> dict[str, tuple[str, bytes]]:
    snapshot: dict[str, tuple[str, bytes]] = {}
    for path in sorted(self.tools.rglob("*")):
        relative = path.relative_to(self.tools).as_posix()
        if path.is_dir():
            snapshot[relative] = ("directory", b"")
        elif path.is_file():
            snapshot[relative] = ("file", path.read_bytes())
        else:
            self.fail(f"unexpected scratch-tree entry: {relative}")
    return snapshot

before = snapshot_tools_tree()
stdout = io.StringIO()
with redirect_stdout(stdout):
    rc = cli_main(
        [
            "--tools-dir", str(self.tools),
            "state", "compact",
            "--retain-days", "7",
            "--dry-run",
        ]
    )
self.assertEqual(rc, 0)
self.assertTrue(json.loads(stdout.getvalue())["dry_run"])
self.assertEqual(snapshot_tools_tree(), before)
```

Use the ledgers seeded by the real `StateCompactTests.setUp`; do not name a
helper that does not exist. Comparing every directory and file catches added
archives, derivative files, and mutations anywhere under the scratch tools
root rather than checking only a selected ledger subset.

- [ ] **Step 2: Run the test and confirm RED**

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests:. \
python3 -m unittest -v \
  test_state_compact.StateCompactTests.test_cli_state_compact_dry_run_reaches_handler
```

Expected: CLI falls into snapshot verification and reads absent
`args.snapshot`.

- [ ] **Step 3: Add only `compact` to the store-command dispatch set**

```python
if args.state_command in {"checkout", "publish", "verify-store", "compact"}:
    return _handle_state_store_command(args)
```

Do not alter the parser, compactor, retention policy, or live state.

- [ ] **Step 4: Run compaction and affected gates**

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests:. \
python3 -m unittest -v test_state_compact
NX_DAEMON=false npx nx affected --target=test --output-style=static
NX_DAEMON=false npx nx affected --target=lint --output-style=static
```

Expected: all pass; scratch bytes remain unchanged in the CLI dry run.

- [ ] **Step 5: Complete the finding narrative**

Append a closure paragraph under `ORPHAN-HIGH-798` recording that the real
`state compact --dry-run` CLI dispatch now reaches the existing compactor and
that the full scratch tools tree is byte-identical before and after. Preserve
the finding's write-time history; this paragraph closes the remaining dispatch
half rather than rewriting its earlier evidence.

- [ ] **Step 6: Commit and push the routing fix**

```bash
git add aria-kernel/aria_kernel/cli.py aria-kernel/tests/test_state_compact.py \
  docs/reviews/orphan-findings.md
git diff --cached --check
git commit -m "fix(aria): route state compact through its handler" \
  -m "The parser and compactor already exist, but the dispatcher omits the command and makes the governed operator capability unreachable." \
  -m "Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-798"
git push origin HEAD:fix/kernel-ci-timeouts
```

---

### Task 5: Build the read-only exact-state Operational Proof

**Files:**

- Modify: `.github/actions/restore-aria-state/action.yml`
- Modify: `.github/workflows/aria-operational-proof.yml`
- Modify: `aria-kernel/aria_kernel/state_store.py`
- Modify: `aria-kernel/aria_kernel/workflow_contract_registry.py`
- Modify: `aria-kernel/aria_kernel/workflow_contracts.py`
- Modify: `aria-kernel/aria_kernel/docs_ssot.py`
- Create: `aria-kernel/aria_kernel/operational_proof.py`
- Modify: `aria-kernel/aria_kernel/cycle.py:625-685`
- Modify: `aria-kernel/aria_kernel/burn_in.py:95-300,623-715,776-810`
- Test: `aria-kernel/tests/test_workflow_enterprise_preflight.py`
- Test: `aria-kernel/tests/test_cycle_burn_in_mode.py`
- Test: `aria-kernel/tests/test_observe_burn_in.py`
- Test: `aria-kernel/tests/test_operational_proof.py`
- Test: `aria-kernel/tests/test_state_writer_attestations.py`
- Test: `tests/invariants/aria-single-restore-path.spec.ts`
- Verify: `tests/invariants/aria-doc-runtime-ssot.spec.ts`

**Interfaces:**

- Produces action input `bind-tools-root` with exact string values
  `'true' | 'false'`, default `'true'`.
- Replaces the loose workflow registry fields across every entry with the
  typed `WorkflowPermissionRequirement`, `WorkflowStepRequirement`,
  `WorkflowActionRequirement`, and `WorkflowUploadRequirement` contracts.
- Produces per-cycle `state_continuity` evidence in burn-in artifacts.
- Produces one strict `aria/operational-proof-manifest/v1` outer manifest and
  `verify_operational_proof_bundle(...)`, the only acceptance verifier used
  both in the workflow and after download.
- Produces `state_writer_attestation_path(store)` as the one canonical path
  derivation used by the writer and proof reader.
- Consumes canonical `resolve_continuity_reference`,
  `store_is_at_published_tip`, `verify_state_store`, and the Task 2 prefix
  helper.

- [ ] **Step 1: Write generic workflow-contract RED tests**

Add these exact tests to `test_workflow_enterprise_preflight.py`:

```text
test_required_action_contract_enforces_uses_occurrences_and_inputs
test_step_contract_enforces_occurrence_condition_and_run_markers
test_permission_contract_rejects_every_undeclared_scope
test_upload_contract_rejects_extra_or_non_always_uploads
```

Each test must mutate a synthetic job independently and assert a distinct
failure class:

```python
self.assertIn("workflow_required_action", verdict.failure_classes)
self.assertIn("workflow_step_requirement", verdict.failure_classes)
self.assertIn("workflow_permissions", verdict.failure_classes)
self.assertIn("workflow_artifact_upload", verdict.failure_classes)
```

- [ ] **Step 2: Run contract tests and confirm RED**

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests:. \
python3 -m pytest -q aria-kernel/tests/test_workflow_enterprise_preflight.py
```

Expected: the typed fields/enforcement do not exist.

- [ ] **Step 3: Replace every loose workflow contract with typed requirements**

In `workflow_contract_registry.py` add:

```python
@dataclass(frozen=True)
class WorkflowPermissionRequirement:
    values: tuple[tuple[str, str], ...]
    exact: bool = True

@dataclass(frozen=True)
class WorkflowStepRequirement:
    name: str
    occurrences: int = 1
    condition: str | None = None
    required_run_markers: tuple[str, ...] = ()
    forbidden_run_markers: tuple[str, ...] = ()

@dataclass(frozen=True)
class WorkflowActionRequirement:
    step_name: str
    uses: str
    required_inputs: tuple[tuple[str, str], ...] = ()
    forbidden_inputs: tuple[str, ...] = ()
    occurrences: int = 1

@dataclass(frozen=True)
class WorkflowUploadRequirement:
    step_name: str
    uses: str
    artifact_name_pattern: str
    path_patterns: tuple[str, ...]
    condition: str
    if_no_files_found: str
    retention_days: int
    occurrences: int = 1
```

`WorkflowJobContract` owns exactly one `permissions`, one optional `upload`,
and tuples `steps` and `actions`; preserve `step_order` as the explicit graph
edge list. Mechanically migrate every registry entry and update `docs_ssot.py`
to obtain retention from the typed upload without changing the generated
inventory shape. Do not retain parallel legacy permission, upload, step, or
action representations.

In `workflow_contracts.py`, compare permissions exactly when requested;
normalize conditions by collapsing whitespace and removing one `${{ ... }}`
wrapper; exclude comment-only lines from run-marker scans; and reject missing,
duplicated, extra, unpinned, wrongly conditioned, wrongly named, or wrongly
pathed uploads. Emit only the four failure classes pinned by Step 1.

- [ ] **Step 4: Write canonical-action and no-recovery RED tests**

In `aria-single-restore-path.spec.ts`, add:

```text
rejects an invalid bind mode before canonical checkout
keeps writer binding default-on
skips binding and environment export for read-only consumers
models Operational Proof as a read-only canonical-restore consumer
keeps Operational Proof outside the state-carrying publisher set
```

In `ModeExecutionTests`, add:

```python
def test_burn_in_never_attempts_continuity_recovery(self) -> None:
    # Arrange a blocking continuity verdict.
    # Patch restore_and_replay and freeze_autonomous_writes at their owners.
    # Run mode="burn_in".
    restore_and_replay.assert_not_called()
    freeze_autonomous_writes.assert_called_once()
    self.assertEqual(state["status"], "aborted")

def test_standard_cycle_still_attempts_continuity_recovery(self) -> None:
    # Return a resolved RecoveryResult and preserve the existing standard path.
    restore_and_replay.assert_called_once()
```

Run both files. Expected: RED because the action always binds and burn-in still
recovers.

- [ ] **Step 5: Split canonical checkout from optional binding**

Add to `restore-aria-state/action.yml`:

```yaml
bind-tools-root:
  description: Bind and export the restored tools root for writer lanes.
  required: false
  default: 'true'
```

Split the behavior into this exact order:

```text
Validate ARIA restore mode -> accept only literal true or false before checkout
Check out the aria/state store (id: restore) -> canonical checkout and five outputs
Bind restored tools root for writer lanes -> if: ${{ inputs.bind-tools-root == 'true' }}
```

The checkout step must not bind or write `GITHUB_ENV`. The conditional step
invokes `integrity bind-tools-root` and exports the checkout verdict's
environment. Keep all five existing outputs. Publisher workflows use the
default and remain unchanged. Operational Proof later sets the input explicitly
to `'false'`. Prove that invalid input fails before a store, Git worktree
registration, checkout verdict, or writer attestation exists.

- [ ] **Step 6: Make burn-in fail without recovery and require continuity evidence**

At the cycle decision boundary:

```python
recovery_resolved = False
if context.mode != "burn_in":
    recovery = restore_and_replay(
        Path(workspace_root), diagnosed, base_dir=root, cycle_id=cycle_id
    )
    continuity = {**continuity, "recovery": recovery.as_event()}
    context.results["state_continuity"] = continuity
    recovery_resolved = recovery.resolved
if not recovery_resolved:
    freeze_autonomous_writes(...)
    # Keep the existing typed aborted-row path unchanged.
```

In `run_observe_burn_in`, initialize every cycle row with
`"state_continuity": None`. Immediately after every normal
`run_enterprise_cycle` return and before inspecting `state["status"]`, replace
it with this curated object. This captures completed, stopped, aborted, and
failed returns; exceptions before return retain explicit `None`:

```python
continuity = state.get("state_continuity")
cycle_row["state_continuity"] = {
    "status": continuity.get("status"),
    "reference_kind": continuity.get("reference_kind"),
    "blocks_action": continuity.get("blocks_action"),
    "recovery": continuity.get("recovery"),
} if isinstance(continuity, dict) else None
```

Extend `_cycle_validity` with exact reasons:

```python
continuity = row.get("state_continuity")
if not isinstance(continuity, dict):
    reasons.append("state_continuity_evidence_missing")
else:
    if continuity.get("status") != "ok":
        reasons.append("state_continuity_not_ok")
    if continuity.get("reference_kind") != "state_branch":
        reasons.append("state_continuity_not_state_branch")
    if continuity.get("blocks_action") is not False:
        reasons.append("state_continuity_blocks_action")
    if continuity.get("recovery") is not None:
        reasons.append("state_continuity_recovery_forbidden")
```

Update report validation so every row has the key and every
`valid_cycle is True` row re-satisfies the exact predicate. Any recovery
evidence is invalid in burn-in even when it claims resolution. Unknown,
genesis, daily anchor, critical, missing, malformed, and recovery-bearing
evidence must each have a negative test.

- [ ] **Step 7: Give successful burn-in tests a real published-state fixture**

Update `ObserveBurnInTests.setUp` to create a local bare remote, configure the
fixture repo's `origin`, ignore `.aria-state-store` and its writer sibling,
bootstrap the canonical store with the exact repository identity, seed a
chain-valid declared ledger, and publish one snapshot. Do not mock continuity
for acceptance tests. Retain focused mocks only for individual negative
classifications.

Add exact tests:

```text
test_observe_burn_in_runs_against_a_real_restored_state_reference
test_every_returned_cycle_row_records_curated_continuity_before_classification
test_cycle_without_continuity_is_invalid
test_cycle_with_unknown_continuity_is_invalid
test_cycle_with_genesis_continuity_is_invalid
test_cycle_with_daily_anchor_continuity_is_invalid
test_cycle_with_critical_continuity_is_invalid
test_cycle_with_malformed_continuity_is_invalid
test_cycle_with_recovery_evidence_is_invalid
test_failed_report_cannot_claim_valid_continuity_cycles
```

- [ ] **Step 8: Build the canonical writer path and strict outer proof RED/GREEN**

First add `test_writer_attestation_path_is_the_canonical_ignored_sibling` to
`test_state_writer_attestations.py`. Export this helper from `state_store.py`
and make `_attest_state_writer` consume it:

```python
def state_writer_attestation_path(store: StateStore) -> Path:
    return store.root.parent / f"{store.root.name}.writers.jsonl"
```

In `test_operational_proof.py`, use a real generated inner burn-in bundle for
the positive outer test. Each mutation copies that fixture and changes one
fact. Add these exact tests:

```text
test_initial_capture_binds_exact_published_tip_and_writer_measurement
test_initial_capture_rejects_genesis_anchor_or_unreadable_tip
test_capture_rejects_dirty_source_or_store
test_capture_rejects_host_identity_in_restored_tools
test_success_manifest_binds_sha_run_attempt_and_initial_final_state
test_success_verifier_rejects_missing_or_unexpected_file
test_success_verifier_rejects_symlink_or_non_regular_file
test_success_verifier_rejects_file_hash_or_size_drift
test_success_verifier_rejects_target_sha_run_id_or_attempt_mismatch
test_success_verifier_rejects_store_head_or_remote_tip_drift
test_success_verifier_rejects_writer_hash_or_size_drift
test_success_verifier_rejects_dirty_final_source_or_store
test_success_verifier_rejects_initial_or_final_host_identity
test_success_verifier_rejects_nonpassing_inner_bundle
test_final_dlp_reuses_scan_paths_for_secrets_and_rejects_a_secret
test_failed_diagnostic_manifest_never_verifies_as_success
test_local_cli_verifies_the_same_downloaded_bundle
```

Create `operational_proof.py` as the focused owner of state measurement, the
outer manifest, closed-set enumeration, final DLP, strict verification, and
the local CLI. Export these exact interfaces:

```python
@dataclass(frozen=True)
class OperationalProofVerdict:
    valid: bool
    status: str
    target_sha: str
    workflow_run_id: str
    workflow_run_attempt: int
    manifest_hash: str
    files: tuple[str, ...]

def capture_operational_state(
    repo_root: str | Path, *, stage: Literal["initial", "final"],
    target_sha: str, workflow_run_id: str, workflow_run_attempt: int,
) -> dict[str, Any]: ...

def write_operational_proof_manifest(
    proof_root: str | Path, *, target_sha: str,
    workflow_run_id: str, workflow_run_attempt: int,
) -> dict[str, Any]: ...

def scan_operational_proof_for_secrets(
    proof_root: str | Path,
) -> tuple[Path, ...]: ...

def verify_operational_proof_bundle(
    proof_root: str | Path, *, expected_target_sha: str,
    expected_workflow_run_id: str, expected_workflow_run_attempt: int,
) -> OperationalProofVerdict: ...
```

Expose the corresponding `capture-state`, `write-manifest`, `scan-dlp`, and
`verify` CLI subcommands. Every capture/manifest command requires explicit
target SHA, workflow run ID, and workflow run attempt; `verify` names them
`--expected-target-sha`, `--expected-workflow-run-id`, and
`--expected-workflow-run-attempt`.

The capture record uses schema `aria/operational-proof-state/v1`, contains only
`schema_version`, `stage`, `target_sha`, `workflow_run_id`,
`workflow_run_attempt`, `valid`, closed `source`, `state`, and
`writer_attestation` objects, and `failure_classes`. It records no absolute
host paths. The nested schema is exact:

```text
source = {head, clean}
state = {
  branch, reference_kind, snapshot_id, manifest_root,
  verification_valid, verification_status,
  store_head, remote_tip, remote_tip_readable, at_remote_tip,
  clean, host_identity_present
}
writer_attestation = {sha256, size_bytes}
```

Initial capture requires the writer sibling to be an existing readable,
positive-size regular non-symlink. Capture failures still write a closed
diagnostic record and the CLI returns non-zero.

The manifest filename is `operational-proof-manifest.json`, with schema
`aria/operational-proof-manifest/v1`. Its success allowlist is exactly:

```text
workflow-preflight.json
state-store-verification.json
cycles.json
cycle-ledger-summary.json
disallowed-actions.json
manifest-tail-hashes.json
candidate-detection.json
autonomy-burn-in-report.json
evidence-bundle.json
postflight-verification.json
operational-proof-manifest.json
```

Failed diagnostics may additionally contain only
`proof-failure-summary.json`, `failure-report.json`, and
`failures/burnin-observe-YYYYMMDDTHHMMSSZ-NNN.json`; a failed manifest never
satisfies success verification. Enumeration rejects symlinks, non-regular
files, traversal, missing success files, and unexpected paths even if named in
the manifest. The manifest binds target SHA, run ID, run attempt, hash and size
of every other staged file, plus hash references to the initial state,
postflight state, and burn-in report.

The verifier rechecks that closed world; exact SHA/run ID/attempt everywhere;
the inner bundle and passed verdict; both clean, valid state records; live-tip
proof; absent host identity; and equality of initial/final source head, store
head, remote tip, snapshot ID/root, and writer hash/size. It invokes the
canonical DLP scanner on every final regular file including the outer manifest.
It is the sole outer acceptance authority; shell `jq` assertions are
diagnostic.

- [ ] **Step 9: Pin Operational Proof topology before editing YAML**

Add registry constants for:

```text
Persist enterprise workflow preflight
Restore ARIA state from the aria/state branch
Require published ARIA state restore
Verify restored ARIA state reference
Run observe burn-in proof
Verify post-run source and state immutability
Write ARIA operational proof manifest
Scan staged ARIA operational proof for secrets
Verify complete ARIA operational proof
Upload ARIA operational proof
```

Set `first_governed_mutation_step` to the restore step. Require permissions
exactly `(("contents", "read"),)`, the canonical action exactly once with
`bind-tools-root: "false"`, and `bootstrap-ack` absent. Forbid executable
`state publish`, `publish_state(`, `bind-tools-root`, and `GITHUB_ENV` markers
outside the canonical action call. Pin every ordering edge through the final
verifier, `contents: read`,
`job_timeout_minutes=90`, network policy `("github_artifact", "github_git")`,
and exact `always()` conditions on postflight, manifest writing, DLP,
verification, and upload. The upload is exactly once, uses the SHA-pinned
`UPLOAD_ARTIFACT_ACTION`, names `aria-operational-proof-${{ github.sha }}`,
contains only `${{ runner.temp }}/aria-operational-proof/`, has
`if-no-files-found: error`, and retains for 365 days.

Allowed write patterns must cover exactly:

```text
.aria-state-store
.aria-state-store.writers.jsonl
runner-temp/aria-state-checkout.json
runner-temp/aria-state-checkout.json.err
runner-temp/aria-operational-proof
runner-temp/aria-operational-proof-tools
runner-temp/aria-operational-proof-workspaces
```

Use the exact repository-relative and runner-temp spellings already established
by the preflight registry. Do not add `.git` to application write roots: only
the canonical restore's platform-controlled Git/worktree materialization and
runner command-file writes are allowed. Upload patterns contain only
`runner-temp/aria-operational-proof`.

- [ ] **Step 10: Add workflow mutation RED tests**

Add exact tests:

```text
test_operational_proof_restore_before_preflight_is_rejected
test_operational_proof_restore_action_drift_is_rejected
test_operational_proof_store_verification_after_burn_in_is_rejected
test_operational_proof_postflight_after_upload_is_rejected
test_operational_proof_final_dlp_after_upload_is_rejected
test_operational_proof_write_permission_is_rejected
test_operational_proof_scratch_or_store_upload_is_rejected
test_operational_proof_upload_runs_always_and_only_uploads_curated_proof
test_operational_proof_burn_in_preserves_original_failure_status
test_operational_proof_every_post_burn_step_runs_always
```

Update existing synthetic fixtures to carry all new required steps, paths,
network values, and the exact 90-minute job value so each negative test fails
only for its intended mutation.

- [ ] **Step 11: Implement the exact read-only workflow**

Use deterministic paths and call the shared action:

```yaml
- name: Restore ARIA state from the aria/state branch
  id: restore_state
  uses: ./.github/actions/restore-aria-state
  with:
    bind-tools-root: 'false'
```

The require step must accept only `restored == 'true'` with bootstrap absent.
The initial verification calls
`aria_kernel.operational_proof capture-state --stage initial` with
`github.sha`, `github.run_id`, and `github.run_attempt`. That read-only API
composes `open_state_store`, `verify_state_store`,
`resolve_continuity_reference`, `store_is_at_published_tip`,
`canonical_identity`, `tools_root`, and the canonical writer path helper.

It writes the closed state record to `state-store-verification.json`; never
serialize the full snapshot or absolute host paths. Require `source.head` to
equal the target SHA, exact non-genesis `state_branch`, `valid/ok` store
verification, readable/proven live tip, clean source/store, and absent host
identity. Bind snapshot ID/root, state tip, store HEAD, and the ignored writer
sibling's SHA-256/size rather than omitting it from the mutation proof.

- [ ] **Step 12: Preserve failure evidence and its original exit**

The burn-in shell step uses `set -uo pipefail`, captures `BURN_STATUS`, copies
only the bound burn-in output directory into the proof root, verifies a full
bundle when present, and otherwise writes `proof-failure-summary.json`. Exit
selection is exact:

```bash
if [ "$BURN_STATUS" -ne 0 ]; then
  exit "$BURN_STATUS"
fi
exit "$POSTPROCESS_STATUS"
```

The postflight step uses `if: always()` and calls `capture-state --stage final`
to write `postflight-verification.json`. The manifest step then uses
`if: always()` and `write-manifest` to write a passed or failed closed
diagnostic manifest. The next `if: always()` step runs `scan-dlp` over every
final staged regular file, including that manifest. The final `if: always()`
verification step calls `verify` with the exact target SHA, run ID, and run
attempt; the verifier repeats DLP and all outer/inner acceptance checks.

No file-writing step follows final DLP except the platform upload action. A
failed burn-in or postflight can preserve only the bounded failed diagnostics
listed in Step 8 and can never mint a passing verifier result.

The upload step also uses `if: always()` and only:

```yaml
path: ${{ runner.temp }}/aria-operational-proof/
```

- [ ] **Step 13: Run all Operational Proof RED/GREEN and completion gates**

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests:. \
python3 -m unittest -v \
  test_state_writer_attestations \
  test_operational_proof \
  test_workflow_enterprise_preflight \
  test_cycle_burn_in_mode \
  test_observe_burn_in
npx jest --config tests/invariants/jest.config.ts --runTestsByPath \
  tests/invariants/aria-single-restore-path.spec.ts \
  tests/invariants/aria-doc-runtime-ssot.spec.ts --runInBand
npm run aria:compile
npm run aria:test:unit
npm run aria:docs:ssot
npm run invariants:fast
NX_DAEMON=false npx nx affected --target=test --output-style=static
NX_DAEMON=false npx nx affected --target=lint --output-style=static
node tools/quality/quality.mjs format-scope check
git diff --check
```

Expected: all pass. Verify `git diff --check` and inspect the YAML diff for no
credential, publish, bootstrap, state-copy, or scratch-upload path.

- [ ] **Step 14: Commit and push the complete Operational Proof fix**

```bash
FINDING_ID="$(jq -r 'select(.title == "Operational Proof does not prove published state continuity") | .id' \
  docs/reviews/_registry/findings.jsonl)"
test "$FINDING_ID" = "ARIA-HIGH-024"
rg -Fq "## $FINDING_ID — Operational Proof does not prove published state continuity" \
  docs/reviews/aria/2026-08-28-operational-proof-continuity.md
git add .github/actions/restore-aria-state/action.yml \
  .github/workflows/aria-operational-proof.yml \
  aria-kernel/aria_kernel/state_store.py \
  aria-kernel/aria_kernel/workflow_contract_registry.py \
  aria-kernel/aria_kernel/workflow_contracts.py \
  aria-kernel/aria_kernel/docs_ssot.py \
  aria-kernel/aria_kernel/operational_proof.py \
  aria-kernel/aria_kernel/cycle.py aria-kernel/aria_kernel/burn_in.py \
  aria-kernel/tests/test_state_writer_attestations.py \
  aria-kernel/tests/test_workflow_enterprise_preflight.py \
  aria-kernel/tests/test_cycle_burn_in_mode.py \
  aria-kernel/tests/test_observe_burn_in.py \
  aria-kernel/tests/test_operational_proof.py \
  tests/invariants/aria-single-restore-path.spec.ts
git diff --cached --check
git commit -m "fix(aria): prove restored state continuity" \
  -m "Operational acceptance must measure the exact published state without binding, repairing, publishing, or uploading that authority, while preserving every failed proof as failed evidence." \
  -m "Closes: docs/reviews/aria/2026-08-28-operational-proof-continuity.md#$FINDING_ID"
git push origin HEAD:fix/kernel-ci-timeouts
```

Expected: all hooks and push pass; local/remote/PR head match exactly.

---

### Task 6: Independently review and prove PR #1332's exact head

**Files:**

- Review all files changed by Tasks 1-5.
- Correct only findings proven by the review; each correction repeats its
  targeted RED/GREEN and affected gates.

**Interfaces:**

- Consumes: complete #1332 implementation head.
- Produces: exact SHA with local suite, GitHub checks, and manual Operational
  Proof evidence all bound to the same commit.

Run all Task 6 command blocks from the isolated worktree in one Bash session;
`set -euo pipefail` makes every assertion a gate. Any correction or changed
head restarts acceptance from Step 1, and no prior manual proof is reused.

- [ ] **Step 1: Run fresh full local verification**

```bash
set -euo pipefail
PR_NUMBER=1332
REMOTE_BRANCH=fix/kernel-ci-timeouts
BASE_BRANCH=main
WORKFLOW_FILE=aria-operational-proof.yml
test -f aria-kernel/aria_kernel/operational_proof.py
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:. \
  python3 -m aria_kernel.operational_proof --help >/dev/null
test -z "$(git status --porcelain --untracked-files=all)"
PR_JSON="$(gh pr view "$PR_NUMBER" \
  --json state,isDraft,baseRefName,headRefName,headRefOid,autoMergeRequest)"
jq -e --arg base "$BASE_BRANCH" --arg head "$REMOTE_BRANCH" '
  .state == "OPEN" and .isDraft == false and
  .baseRefName == $base and .headRefName == $head and
  .autoMergeRequest == null
' <<<"$PR_JSON" >/dev/null
npm run aria:compile
npm run aria:test:unit
npm run aria:docs:ssot
npm run invariants:fast
NX_DAEMON=false npx nx affected --target=test --output-style=static
NX_DAEMON=false npx nx affected --target=lint --output-style=static
node tools/quality/quality.mjs format-scope check
git diff --check
test -z "$(git status --porcelain --untracked-files=all)"
```

Expected: all pass and worktree is clean.

- [ ] **Step 2: Run two-stage independent code review**

Use `superpowers:requesting-code-review`. First reviewer checks spec compliance,
permissions, immutable state, failure status, and duplicate definitions. Second
reviewer checks code quality, type/signature consistency, test negative
controls, and security boundaries. Apply only verified findings, commit with
their governed trailers, push, and repeat Step 1 after any correction.

- [ ] **Step 3: Bind all GitHub checks to one exact SHA**

```bash
HEAD_SHA="$(git rev-parse --verify 'HEAD^{commit}')"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
assert_exact_head() {
  test "$HEAD_SHA" = "$(git rev-parse --verify 'HEAD^{commit}')"
  test "$HEAD_SHA" = "$(git ls-remote --exit-code --refs origin \
    "refs/heads/$REMOTE_BRANCH" | cut -f1)"
  test "$HEAD_SHA" = "$(gh pr view "$PR_NUMBER" \
    --json headRefOid --jq .headRefOid)"
}
assert_required_checks() {
  npm run gates:required-status-checks:live
  local protection_json checks_json expected_names observed_names
  protection_json="$(gh api \
    "repos/{owner}/{repo}/branches/$BASE_BRANCH/protection")"
  checks_json="$(gh pr checks "$PR_NUMBER" --required \
    --json bucket,state,name)"
  jq -e '
    .enforce_admins.enabled == true and
    .required_status_checks.strict == true and
    (.required_status_checks.checks | length) > 0 and
    all(.required_status_checks.checks[];
      (.context | type == "string") and (.context | length) > 0 and
      (.app_id | type == "number") and .app_id > 0)
  ' <<<"$protection_json" >/dev/null
  jq -e 'length > 0 and
    all(.[]; .bucket == "pass" and .state == "SUCCESS")' \
    <<<"$checks_json" >/dev/null
  expected_names="$(jq -c \
    '[.required_status_checks.checks[].context] | sort' \
    <<<"$protection_json")"
  observed_names="$(jq -c '[.[].name] | sort' <<<"$checks_json")"
  test "$expected_names" = "$observed_names"
}
assert_exact_head
npm run gates:required-status-checks:live
gh pr checks "$PR_NUMBER" --required --watch --fail-fast --interval 10
assert_exact_head
assert_required_checks
assert_exact_head
```

The equality assertions are gates, not printed diagnostics. The required-check
watch is bound by the before/after exact-head assertions. The live protection
gate proves strict/admin enforcement and app IDs; exact set equality plus
`state == "SUCCESS"` rejects empty, renamed, rebound, duplicated, neutral,
skipped, cancelled, pending, or stale evidence. Any failure is diagnosed
through `superpowers:systematic-debugging`; do not rerun blindly.

- [ ] **Step 4: Dispatch exact-head manual Operational Proof**

```bash
BEFORE_RUN_IDS="$(gh run list --workflow "$WORKFLOW_FILE" \
  --branch "$REMOTE_BRANCH" --event workflow_dispatch --limit 1000 \
  --json databaseId --jq 'map(.databaseId)')"
assert_exact_head
DISCOVERY_DEADLINE=$((SECONDS + 300))
PROOF_DEADLINE=$((SECONDS + 6600))
timeout "$((DISCOVERY_DEADLINE - SECONDS))s" \
  gh workflow run "$WORKFLOW_FILE" --ref "$REMOTE_BRANCH"
NEW_CANDIDATES='[]'
while (( SECONDS < DISCOVERY_DEADLINE && SECONDS < PROOF_DEADLINE )); do
  DISCOVERY_REMAINING=$((DISCOVERY_DEADLINE - SECONDS))
  CANDIDATE_RUNS="$(timeout "${DISCOVERY_REMAINING}s" \
    gh run list --workflow "$WORKFLOW_FILE" \
      --branch "$REMOTE_BRANCH" --commit "$HEAD_SHA" \
      --event workflow_dispatch --limit 1000 \
      --json databaseId,attempt,event,headBranch,headSha,createdAt,status,conclusion)"
  NEW_CANDIDATES="$(jq -c --argjson before "$BEFORE_RUN_IDS" \
    --arg branch "$REMOTE_BRANCH" --arg sha "$HEAD_SHA" '
      [.[] |
        select(.databaseId as $id | ($before | index($id)) == null) |
        select(.event == "workflow_dispatch") |
        select(.headBranch == $branch) |
        select(.headSha == $sha)]
    ' <<<"$CANDIDATE_RUNS")"
  CANDIDATE_COUNT="$(jq 'length' <<<"$NEW_CANDIDATES")"
  test "$CANDIDATE_COUNT" -le 1
  test "$CANDIDATE_COUNT" -eq 0 || break
  DISCOVERY_REMAINING=$((DISCOVERY_DEADLINE - SECONDS))
  test "$DISCOVERY_REMAINING" -gt 0
  if (( DISCOVERY_REMAINING < 5 )); then
    sleep "$DISCOVERY_REMAINING"
  else
    sleep 5
  fi
done
jq -e 'length == 1 and .[0].attempt == 1' \
  <<<"$NEW_CANDIDATES" >/dev/null
RUN_ID="$(jq -r '.[0].databaseId' <<<"$NEW_CANDIDATES")"
RUN_ATTEMPT="$(jq -r '.[0].attempt' <<<"$NEW_CANDIDATES")"
RUN_COMPLETED=false
while (( SECONDS < PROOF_DEADLINE )); do
  PROOF_REMAINING=$((PROOF_DEADLINE - SECONDS))
  RUN_JSON="$(timeout "${PROOF_REMAINING}s" gh run view "$RUN_ID" \
    --json databaseId,attempt,event,headBranch,headSha,status,conclusion,workflowName,url)"
  jq -e --argjson run_id "$RUN_ID" --argjson attempt "$RUN_ATTEMPT" \
    --arg branch "$REMOTE_BRANCH" --arg sha "$HEAD_SHA" '
      .databaseId == $run_id and .attempt == $attempt and
      .event == "workflow_dispatch" and .headBranch == $branch and
      .headSha == $sha and
      ((.status == "completed" and (.conclusion | type == "string")) or
       ((.status == "queued" or .status == "in_progress" or
         .status == "requested" or .status == "waiting" or
         .status == "pending") and .conclusion == null))
    ' <<<"$RUN_JSON" >/dev/null
  RUN_STATUS="$(jq -r .status <<<"$RUN_JSON")"
  case "$RUN_STATUS" in
    completed)
      jq -e '.conclusion == "success"' <<<"$RUN_JSON" >/dev/null
      RUN_COMPLETED=true
      break
      ;;
    queued | in_progress | requested | waiting | pending)
      PROOF_REMAINING=$((PROOF_DEADLINE - SECONDS))
      test "$PROOF_REMAINING" -gt 0
      if (( PROOF_REMAINING < 10 )); then
        sleep "$PROOF_REMAINING"
      else
        sleep 10
      fi
      ;;
    *)
      exit 1
      ;;
  esac
done
test "$RUN_COMPLETED" = true
jq -e --argjson run_id "$RUN_ID" --argjson attempt "$RUN_ATTEMPT" \
  --arg branch "$REMOTE_BRANCH" --arg sha "$HEAD_SHA" '
    .databaseId == $run_id and .attempt == $attempt and
    .event == "workflow_dispatch" and .headBranch == $branch and
    .headSha == $sha and .status == "completed" and
    .conclusion == "success"
  ' <<<"$RUN_JSON" >/dev/null
```

`PROOF_DEADLINE` is set exactly once immediately before dispatch and gives
dispatch discovery plus terminal completion 6,600 seconds total. Discovery
retains its stricter five-minute cap within that deadline and excludes every
run ID observed before dispatch. Completion uses bounded API polling rather
than an unbounded watch; every poll rebinds the exact run ID, attempt, branch,
SHA, status, and conclusion. Timeout, unknown status, or any non-success
terminal conclusion fails. Exactly one new exact-SHA run at attempt 1 is
required; an ambiguous concurrent dispatch or later rerun stops acceptance.
Repeat discovery before artifact acceptance and require the sole candidate is
still `RUN_ID`.

- [ ] **Step 5: Download and verify the accepted proof bundle**

Re-run the discovery filter and require its sole candidate is still `RUN_ID`.
Then enumerate the selected run's artifacts, require exactly one canonical,
non-expired, positive-size artifact bound to the exact run/head with a canonical
digest, download by immutable artifact ID, and verify the archive digest:

```bash
CANDIDATE_RUNS="$(gh run list --workflow "$WORKFLOW_FILE" \
  --branch "$REMOTE_BRANCH" --commit "$HEAD_SHA" \
  --event workflow_dispatch --limit 1000 \
  --json databaseId,attempt,event,headBranch,headSha,createdAt,status,conclusion)"
NEW_CANDIDATES="$(jq -c --argjson before "$BEFORE_RUN_IDS" \
  --arg branch "$REMOTE_BRANCH" --arg sha "$HEAD_SHA" '
    [.[] |
      select(.databaseId as $id | ($before | index($id)) == null) |
      select(.event == "workflow_dispatch") |
      select(.headBranch == $branch) |
      select(.headSha == $sha)]
  ' <<<"$CANDIDATE_RUNS")"
jq -e --argjson run_id "$RUN_ID" --argjson attempt "$RUN_ATTEMPT" '
  length == 1 and .[0].databaseId == $run_id and
  .[0].attempt == $attempt
' <<<"$NEW_CANDIDATES" >/dev/null
ARTIFACT_NAME="aria-operational-proof-${HEAD_SHA}"
ARTIFACTS_JSON="$(gh api --paginate --slurp \
  "repos/{owner}/{repo}/actions/runs/$RUN_ID/artifacts?per_page=100" \
  | jq -c '[.[].artifacts[]]')"
MATCHING_ARTIFACTS="$(jq -c --arg name "$ARTIFACT_NAME" \
  --arg sha "$HEAD_SHA" --argjson run_id "$RUN_ID" '
    [.[] | select(
      .name == $name and .expired == false and
      (.size_in_bytes | type == "number") and .size_in_bytes > 0 and
      (.digest | type == "string") and
      (.digest | test("^sha256:[0-9a-f]{64}$")) and
      .workflow_run.id == $run_id and .workflow_run.head_sha == $sha)]
  ' <<<"$ARTIFACTS_JSON")"
jq -e 'length == 1' <<<"$MATCHING_ARTIFACTS" >/dev/null
ARTIFACT_ID="$(jq -r '.[0].id' <<<"$MATCHING_ARTIFACTS")"
EXPECTED_ARCHIVE_DIGEST="$(jq -r '.[0].digest' <<<"$MATCHING_ARTIFACTS")"
PROOF_DOWNLOAD_BASE="$(mktemp -d)"
PROOF_ARCHIVE="$PROOF_DOWNLOAD_BASE/operational-proof.zip"
PROOF_ROOT="$PROOF_DOWNLOAD_BASE/proof"
mkdir "$PROOF_ROOT"
gh api -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/{owner}/{repo}/actions/artifacts/$ARTIFACT_ID/zip" \
  >"$PROOF_ARCHIVE"
ACTUAL_ARCHIVE_DIGEST="sha256:$(sha256sum "$PROOF_ARCHIVE" | cut -d' ' -f1)"
test "$ACTUAL_ARCHIVE_DIGEST" = "$EXPECTED_ARCHIVE_DIGEST"
while IFS= read -r member; do
  case "$member" in
    /* | ../* | */../* | */..) exit 1 ;;
  esac
done < <(unzip -Z1 "$PROOF_ARCHIVE")
unzip -q "$PROOF_ARCHIVE" -d "$PROOF_ROOT"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:. \
python3 -m aria_kernel.operational_proof verify \
  --proof-root "$PROOF_ROOT" \
  --expected-target-sha "$HEAD_SHA" \
  --expected-workflow-run-id "$RUN_ID" \
  --expected-workflow-run-attempt "$RUN_ATTEMPT"
FINAL_RUN_JSON="$(gh run view "$RUN_ID" \
  --json databaseId,attempt,headSha,status,conclusion)"
jq -e --argjson id "$RUN_ID" --argjson attempt "$RUN_ATTEMPT" \
  --arg sha "$HEAD_SHA" '
    .databaseId == $id and .attempt == $attempt and .headSha == $sha and
    .status == "completed" and .conclusion == "success"
  ' <<<"$FINAL_RUN_JSON" >/dev/null
FINAL_ARTIFACT_JSON="$(gh api \
  "repos/{owner}/{repo}/actions/artifacts/$ARTIFACT_ID")"
jq -e --argjson id "$ARTIFACT_ID" --arg digest "$EXPECTED_ARCHIVE_DIGEST" \
  --argjson run_id "$RUN_ID" --arg sha "$HEAD_SHA" '
    .id == $id and .digest == $digest and .expired == false and
    .workflow_run.id == $run_id and .workflow_run.head_sha == $sha
  ' <<<"$FINAL_ARTIFACT_JSON" >/dev/null
```

After verification, re-read run and artifact metadata and require the same run
attempt, success, artifact ID, head SHA, and digest. The canonical outer
verifier, rather than manual inspection, requires every success, continuity,
immutability, DLP, and closed-file condition and rejects a restored store or
scratch tree by name. Inspect the three summaries only as a human-readable
cross-check.

- [ ] **Step 6: Merge #1332 through protected GitHub controls**

Immediately before merge, rerun the Step 4 candidate query and require exactly
the same sole `RUN_ID`, then rerun the complete Step 5 run/artifact metadata,
archive-digest, extraction, canonical verifier, and post-verification metadata
block. Only then run:

```bash
assert_exact_head
assert_required_checks
FINAL_PR_JSON="$(gh pr view "$PR_NUMBER" \
  --json state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,autoMergeRequest)"
jq -e --arg base "$BASE_BRANCH" --arg head "$REMOTE_BRANCH" \
  --arg sha "$HEAD_SHA" '
    .state == "OPEN" and .isDraft == false and
    .baseRefName == $base and .headRefName == $head and
    .headRefOid == $sha and .mergeable == "MERGEABLE" and
    .mergeStateStatus == "CLEAN" and .autoMergeRequest == null
  ' <<<"$FINAL_PR_JSON" >/dev/null
REPOSITORY_JSON="$(gh api repos/{owner}/{repo})"
jq -e '.allow_merge_commit == true and .delete_branch_on_merge == false' \
  <<<"$REPOSITORY_JSON" >/dev/null
gh pr merge "$PR_NUMBER" --merge --match-head-commit "$HEAD_SHA"
POST_MERGE_JSON="$(gh pr view "$PR_NUMBER" \
  --json state,mergedAt,mergeCommit,headRefOid,autoMergeRequest,url)"
if ! jq -e --arg sha "$HEAD_SHA" '
  .state == "MERGED" and .mergedAt != null and
  .mergeCommit.oid != null and .headRefOid == $sha and
  .autoMergeRequest == null
' <<<"$POST_MERGE_JSON" >/dev/null; then
  if jq -e '.autoMergeRequest != null' \
    <<<"$POST_MERGE_JSON" >/dev/null; then
    gh pr merge "$PR_NUMBER" --disable-auto
    test "$(gh pr view "$PR_NUMBER" --json autoMergeRequest \
      --jq '.autoMergeRequest == null')" = true
  fi
  exit 1
fi
MERGE_COMMIT="$(jq -r '.mergeCommit.oid' <<<"$POST_MERGE_JSON")"
git fetch origin +refs/heads/main:refs/remotes/origin/main
git merge-base --is-ancestor "$HEAD_SHA" origin/main
git merge-base --is-ancestor "$MERGE_COMMIT" origin/main
test "$(git ls-remote --exit-code --refs origin \
  "refs/heads/$REMOTE_BRANCH" | cut -f1)" = "$HEAD_SHA"
```

Do not pass `--auto`, `--admin`, or `--delete-branch`. Exit zero without the
immediate `MERGED` predicate is failure; disable any armed auto-merge and stop.
The ancestry and live remote-ref assertions prove both protected-main inclusion
and preservation of the branch checked out by another linked worktree. Do not
delete either worktree before Task 7 consumes this main.

---

### Task 7: Carry merged main into #1333 and complete the prerequisite chain

**Files:**

- Worktree: `/var/aqua-saas/.worktrees/aquamobil-v4-safe-integration`
- PR: #1333

**Interfaces:**

- Consumes: merged #1332 commit reachable from `origin/main`.
- Produces: #1333 head containing current main through an ordinary merge, with
  no rebase, cherry-pick, transplant, or duplicate source reconstruction.

Run all Task 7 blocks from the named #1333 worktree in one Bash session, or
recompute and reassert every variable at the start of a later session.

- [ ] **Step 1: Verify the #1333 worktree and PR head before mutation**

```bash
set -euo pipefail
REPOSITORY=Okan-wqm/aquaculture_platform
WORKTREE=/var/aqua-saas/.worktrees/aquamobil-v4-safe-integration
EXPECTED_1332_BRANCH=fix/kernel-ci-timeouts
EXPECTED_1333_BRANCH=feat/aquamobil-v4-safe-integration
cd "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
test "$(git branch --show-current)" = "$EXPECTED_1333_BRANCH"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
PR_1333_JSON="$(gh api "/repos/$REPOSITORY/pulls/1333")"
jq -e --arg branch "$EXPECTED_1333_BRANCH" --arg repo "$REPOSITORY" '
  .number == 1333 and .state == "open" and .merged == false and
  .base.ref == "main" and .head.ref == $branch and
  .head.repo.full_name == $repo
' <<<"$PR_1333_JSON" >/dev/null
PR_HEAD_BRANCH="$(jq -er '.head.ref' <<<"$PR_1333_JSON")"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git ls-remote --exit-code --refs origin \
  "refs/heads/$PR_HEAD_BRANCH" | cut -f1)"
PR_SHA="$(jq -er '.head.sha | select(test("^[0-9a-f]{40}$"))' \
  <<<"$PR_1333_JSON")"
test "$LOCAL_SHA" = "$REMOTE_SHA"
test "$LOCAL_SHA" = "$PR_SHA"
```

Stop if the worktree is dirty or local, remote, and PR heads differ.

- [ ] **Step 2: Re-prove #1332 ancestry and start a no-commit merge**

```bash
PR_1332_JSON="$(gh api "/repos/$REPOSITORY/pulls/1332")"
jq -e --arg branch "$EXPECTED_1332_BRANCH" --arg repo "$REPOSITORY" '
  .number == 1332 and .state == "closed" and .merged == true and
  .merged_at != null and .base.ref == "main" and .head.ref == $branch and
  .head.repo.full_name == $repo
' <<<"$PR_1332_JSON" >/dev/null
PR_1332_HEAD="$(jq -er \
  '.head.sha | select(test("^[0-9a-f]{40}$"))' <<<"$PR_1332_JSON")"
PR_1332_MERGE="$(jq -er \
  '.merge_commit_sha | select(test("^[0-9a-f]{40}$"))' \
  <<<"$PR_1332_JSON")"
git fetch origin +refs/heads/main:refs/remotes/origin/main
MAIN_SHA="$(git rev-parse origin/main)"
test "$MAIN_SHA" = \
  "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)"
git cat-file -e "$PR_1332_HEAD^{commit}"
git cat-file -e "$PR_1332_MERGE^{commit}"
test "$(git rev-list --parents -n 1 "$PR_1332_MERGE" | awk '{print NF}')" -eq 3
test "$(git rev-parse "$PR_1332_MERGE^2")" = "$PR_1332_HEAD"
git merge-base --is-ancestor "$PR_1332_HEAD" "$PR_1332_MERGE"
git merge-base --is-ancestor "$PR_1332_MERGE" "$MAIN_SHA"
PR_1333_JSON="$(gh api "/repos/$REPOSITORY/pulls/1333")"
jq -e --arg branch "$EXPECTED_1333_BRANCH" --arg repo "$REPOSITORY" '
  .state == "open" and .merged == false and .base.ref == "main" and
  .head.ref == $branch and .head.repo.full_name == $repo
' <<<"$PR_1333_JSON" >/dev/null
test "$(jq -er .head.sha <<<"$PR_1333_JSON")" = "$(git rev-parse HEAD)"
PRE_MERGE_HEAD="$(git rev-parse HEAD)"
test "$PRE_MERGE_HEAD" = "$(git ls-remote --exit-code --refs origin \
  "refs/heads/$PR_HEAD_BRANCH" | cut -f1)"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
! git merge-base --is-ancestor "$MAIN_SHA" "$PRE_MERGE_HEAD"
! git merge-base --is-ancestor "$PRE_MERGE_HEAD" "$MAIN_SHA"
MERGE_STATUS=0
git merge --no-ff --no-commit "$MAIN_SHA" || MERGE_STATUS=$?
test -f "$(git rev-parse --git-path MERGE_HEAD)"
test "$(tr -d '\n' <"$(git rev-parse --git-path MERGE_HEAD)")" = "$MAIN_SHA"
if (( MERGE_STATUS != 0 )); then
  test -n "$(git diff --name-only --diff-filter=U)"
fi
git diff --name-only --diff-filter=U
git diff --name-only --diff-filter=U | while IFS= read -r path; do
  directory="$(dirname "$path")"
  while test "$directory" != "." && test "$directory" != "/"; do
    test ! -f "$directory/CLAUDE.md" || printf '%s\n' "$directory/CLAUDE.md"
    directory="$(dirname "$directory")"
  done
done | sort -u
```

A non-zero merge is acceptable only in that exact merge state with every
unmerged path inventoried. Re-read root `CLAUDE.md`, then walk every conflicted
path toward the root and read each nested `CLAUDE.md` before editing. Resolve
authored files by source intent and current-main architecture; never choose
whole sides mechanically. If any authored conflict lacks sufficient authority,
`git merge --abort` and stop.

- [ ] **Step 3: Regenerate generated authorities and commit the merge**

Resolve source files first. For expected conflicts in generated authorities,
do not select either stale side. Preserve the semantically merged
`CURRENT_STATE.md` body; only its date/hash lines are generated. Stage every
authored resolution and place the format-scope path in stage 0 before either
generator enumerates `git ls-files`:

```bash
git add -A
test -z "$(git diff --name-only --diff-filter=U)"
test -f "$(git rev-parse --git-path MERGE_HEAD)"
npm run quality:format-scope:generate
git add tools/quality/format-scope.json
npm run aria:authority-hash:write
git add docs/aria/CURRENT_STATE.md
node tools/quality/quality.mjs format-scope check
npm run aria:authority-hash -- --check
git diff --check
git diff --cached --check
test -z "$(git diff --name-only --diff-filter=U)"
git commit \
  -m "chore(aquamobil): merge protected main into planning branch" \
  -m "The reviewed integration program must descend from the exact protected-main result containing PR #1332 before Order 0 freezes its provenance base."
MERGE_HEAD="$(git rev-parse HEAD)"
test "$(git rev-parse HEAD^1)" = "$PRE_MERGE_HEAD"
test "$(git rev-parse HEAD^2)" = "$MAIN_SHA"
test "$(git rev-list --parents -n 1 HEAD | awk '{print NF}')" -eq 3
git merge-base --is-ancestor "$PR_1332_MERGE" "$MERGE_HEAD"
git merge-base --is-ancestor "$PR_1332_HEAD" "$MERGE_HEAD"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

The commit must be an ordinary two-parent merge whose second parent is the
exact fetched `origin/main`, and that parent must contain #1332's merge commit.

- [ ] **Step 4: Verify and push #1333's merge head**

```bash
for AFFECTED_BASE in "$PRE_MERGE_HEAD" "$MAIN_SHA"; do
  NX_DAEMON=false npx nx affected --target=test \
    --base="$AFFECTED_BASE" --head="$MERGE_HEAD" --output-style=static
  NX_DAEMON=false npx nx affected --target=lint \
    --base="$AFFECTED_BASE" --head="$MERGE_HEAD" --output-style=static
done
git diff --check
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test "$(git rev-parse HEAD)" = "$MERGE_HEAD"
test "$(git ls-remote --exit-code --refs origin \
  "refs/heads/$PR_HEAD_BRANCH" | cut -f1)" = "$PRE_MERGE_HEAD"
test "$(gh api "/repos/$REPOSITORY/pulls/1333" --jq .head.sha)" = \
  "$PRE_MERGE_HEAD"
git push origin "HEAD:refs/heads/$PR_HEAD_BRANCH"
HEAD_SHA="$(git rev-parse HEAD)"
test "$HEAD_SHA" = "$MERGE_HEAD"
test "$HEAD_SHA" = "$(git ls-remote --exit-code --refs origin \
  "refs/heads/$PR_HEAD_BRANCH" | cut -f1)"
test "$HEAD_SHA" = "$(gh api "/repos/$REPOSITORY/pulls/1333" --jq .head.sha)"
```

Any later root-cause correction is committed and pushed normally, then both
fixed-base affected ranges and every local/remote/API equality gate are rerun
for the new descendant head.

- [ ] **Step 5: Require exact-head Actions and protected merge for #1333**

Monitor every required check on the exact SHA. Diagnose any failure, apply a
root-cause fix with tests and governed traceability, and repeat exact-head
verification. When all checks are successful:

```bash
EXPECTED_REQUIRED="$(jq -c '.required_status_checks.contexts | sort' \
  .github/manifests/main-required-status-checks.json)"
test "$EXPECTED_REQUIRED" = \
  '["aria-merge-authority","build-status","merge-gate","sens-enterprise-summary"]'
npm run gates:required-status-checks:live
gh pr checks 1333 --repo "$REPOSITORY" \
  --required --watch --fail-fast --interval 10
REQUIRED_CHECKS_JSON="$(gh pr checks 1333 --repo "$REPOSITORY" \
  --required --json bucket,state,name)"
test "$(jq -c '[.[].name] | sort' <<<"$REQUIRED_CHECKS_JSON")" = \
  "$EXPECTED_REQUIRED"
jq -e 'length > 0 and
  all(.[]; .bucket == "pass" and .state == "SUCCESS")' \
  <<<"$REQUIRED_CHECKS_JSON" >/dev/null

git fetch origin +refs/heads/main:refs/remotes/origin/main
test "$(git rev-parse origin/main)" = "$MAIN_SHA"
test "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)" = \
  "$MAIN_SHA"
git merge-base --is-ancestor "$PR_1332_MERGE" "$MAIN_SHA"
test "$(git rev-parse HEAD)" = "$HEAD_SHA"
test "$(git ls-remote --exit-code --refs origin \
  "refs/heads/$PR_HEAD_BRANCH" | cut -f1)" = "$HEAD_SHA"
PR_1333_JSON="$(gh api "/repos/$REPOSITORY/pulls/1333")"
jq -e --arg head "$HEAD_SHA" --arg branch "$PR_HEAD_BRANCH" \
  --arg repo "$REPOSITORY" '
    .state == "open" and .merged == false and .base.ref == "main" and
    .head.ref == $branch and .head.sha == $head and
    .head.repo.full_name == $repo
  ' <<<"$PR_1333_JSON" >/dev/null
REQUIRED_CHECKS_JSON="$(gh pr checks 1333 --repo "$REPOSITORY" \
  --required --json bucket,state,name)"
test "$(jq -c '[.[].name] | sort' <<<"$REQUIRED_CHECKS_JSON")" = \
  "$EXPECTED_REQUIRED"
jq -e 'length > 0 and
  all(.[]; .bucket == "pass" and .state == "SUCCESS")' \
  <<<"$REQUIRED_CHECKS_JSON" >/dev/null
test "$(gh api "/repos/$REPOSITORY" --jq .delete_branch_on_merge)" = false
gh pr merge 1333 --repo "$REPOSITORY" --merge \
  --match-head-commit "$HEAD_SHA"
```

The exact expected-name comparison is nonempty and rejects duplicates or extra
required contexts; the live gate binds strict/admin enforcement and GitHub App
IDs. A changed `main` requires a new ordinary merge and fresh checks. Never use
`--admin`, `--auto`, `--delete-branch`, rebase, or squash.

- [ ] **Step 6: Prove the protected result and stop at the program handoff**

```bash
git fetch origin +refs/heads/main:refs/remotes/origin/main
RESULT_MAIN_SHA="$(git rev-parse origin/main)"
test "$RESULT_MAIN_SHA" = \
  "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)"
PR_1333_RESULT="$(gh api "/repos/$REPOSITORY/pulls/1333")"
jq -e --arg head "$HEAD_SHA" --arg branch "$PR_HEAD_BRANCH" \
  --arg repo "$REPOSITORY" '
    .state == "closed" and .merged == true and .merged_at != null and
    .base.ref == "main" and .head.ref == $branch and .head.sha == $head and
    .head.repo.full_name == $repo
  ' <<<"$PR_1333_RESULT" >/dev/null
PR_1333_MERGE="$(jq -er \
  '.merge_commit_sha | select(test("^[0-9a-f]{40}$"))' \
  <<<"$PR_1333_RESULT")"
git cat-file -e "$PR_1333_MERGE^{commit}"
test "$(git rev-list --parents -n 1 "$PR_1333_MERGE" | awk '{print NF}')" -eq 3
test "$(git rev-parse "$PR_1333_MERGE^1")" = "$MAIN_SHA"
test "$(git rev-parse "$PR_1333_MERGE^2")" = "$HEAD_SHA"
git merge-base --is-ancestor "$HEAD_SHA" "$PR_1333_MERGE"
git merge-base --is-ancestor "$PR_1332_MERGE" "$PR_1333_MERGE"
git merge-base --is-ancestor "$PR_1333_MERGE" "$RESULT_MAIN_SHA"
test "$(git ls-remote --exit-code --refs origin \
  "refs/heads/$PR_HEAD_BRANCH" | cut -f1)" = "$HEAD_SHA"
test "$(git branch --show-current)" = "$PR_HEAD_BRANCH"
test "$(git rev-parse HEAD)" = "$HEAD_SHA"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

The protected result must be the ordinary merge of the exact accepted base and
head: parent 1 equals `MAIN_SHA` and parent 2 equals `HEAD_SHA`. If `main`
changes before GitHub accepts the merge, the parent-1 assertion fails closed;
stop and repeat the ordinary main merge plus both affected ranges and the full
fresh required-check gate before another protected merge attempt.

Task 7 stops here. Do not create the coordinator branch/worktree, allocate
Aquamobil evidence, or begin a slice. Hand control to
`docs/superpowers/plans/2026-08-26-aquamobil-v4-safe-integration-program.md`,
Task 1 Step 0. That protected-bootstrap step is the sole next authority; only
after it passes may the program derive Order 0's base and coordinator worktree.
