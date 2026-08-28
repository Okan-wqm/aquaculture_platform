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
- Modify through allocator: `docs/reviews/_registry/findings.jsonl`
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
jq -r 'select(.title == "Operational Proof does not prove published state continuity" or .title == "Burn-in terminal summaries omit stopped and aborted rows") | [.id, .title] | @tsv' \
  docs/reviews/_registry/findings.jsonl
```

Expected: the common-directory allocator appends `ARIA-HIGH-024` followed by
`ARIA-MEDIUM-025`; registry chain verification exits 0. These values are
derived from exact titles after allocation, never predicted from the branch's
local registry tail.

- [ ] **Step 4: Stamp allocated IDs and delete only the allocator stubs**

Use `apply_patch` to put the derived IDs in both review headings, every plan and
spec reference, and the Task 3/Task 5 future `Closes:` commands. Then delete
only the two stubs with `apply_patch`. Expected tracked scope after deletion:
the review Markdown and registry JSONL; no stub remains.

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
  aria-kernel/aria_kernel/cycle.py \
  aria-kernel/tests/test_snapshot_line_grandfather.py
git diff --cached --check
git commit -m "fix(aria): unify published prefix validation" \
  -m "Publication, store verification, and continuity must apply one historical row-prefix policy or the durable branch cannot verify its own immutable bytes." \
  -m "Closes: docs/reviews/aria/2026-08-23-state-publish-line-cap-regression.md#ARIA-HIGH-017"
git push origin HEAD:fix/kernel-ci-timeouts
```

Expected: hooks and push pass; PR head equals local HEAD.

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

- [ ] **Step 1: Run fresh full local verification**

```bash
npm run aria:compile
npm run aria:test:unit
npm run aria:docs:ssot
npm run invariants:fast
NX_DAEMON=false npx nx affected --target=test --output-style=static
NX_DAEMON=false npx nx affected --target=lint --output-style=static
node tools/quality/quality.mjs format-scope check
git diff --check
git status --short --branch
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
HEAD_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git ls-remote origin refs/heads/fix/kernel-ci-timeouts | awk '{print $1}')"
PR_SHA="$(gh pr view 1332 --json headRefOid --jq .headRefOid)"
test "$HEAD_SHA" = "$REMOTE_SHA"
test "$HEAD_SHA" = "$PR_SHA"
gh pr checks 1332 --required --watch --fail-fast
test "$HEAD_SHA" = "$(git rev-parse HEAD)"
test "$HEAD_SHA" = "$(git ls-remote origin refs/heads/fix/kernel-ci-timeouts | awk '{print $1}')"
test "$HEAD_SHA" = "$(gh pr view 1332 --json headRefOid --jq .headRefOid)"
REQUIRED_CHECKS_JSON="$(gh pr checks 1332 --required --json bucket,state,name)"
test "$(jq 'length' <<<"$REQUIRED_CHECKS_JSON")" -gt 0
test "$(jq '[.[] | select(.bucket != "pass")] | length' \
  <<<"$REQUIRED_CHECKS_JSON")" = 0
```

The equality assertions are gates, not printed diagnostics. The required-check
watch is bound by the before/after PR-head assertions. Any failure is diagnosed
through `superpowers:systematic-debugging`; do not rerun blindly and do not
merge on skipped, cancelled, pending, neutral, or stale-SHA evidence.

- [ ] **Step 4: Dispatch exact-head manual Operational Proof**

```bash
BEFORE_RUN_IDS="$(gh run list --workflow aria-operational-proof.yml \
  --branch fix/kernel-ci-timeouts --event workflow_dispatch --limit 100 \
  --json databaseId --jq 'map(.databaseId)')"
gh workflow run aria-operational-proof.yml --ref fix/kernel-ci-timeouts
RUN_ID=""
for DISCOVERY_ATTEMPT in $(seq 1 60); do
  CANDIDATE_RUNS="$(gh run list --workflow aria-operational-proof.yml \
    --branch fix/kernel-ci-timeouts --commit "$HEAD_SHA" \
    --event workflow_dispatch --limit 100 \
    --json databaseId,headSha,createdAt)"
  RUN_ID="$(jq -r --argjson before "$BEFORE_RUN_IDS" \
    '[.[] | select(.databaseId as $id | ($before | index($id)) == null)] | sort_by(.createdAt) | last | .databaseId // empty' \
    <<<"$CANDIDATE_RUNS")"
  [ -n "$RUN_ID" ] && break
  sleep 5
done
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
RUN_JSON="$(gh run view "$RUN_ID" --json headSha,status,conclusion,attempt)"
test "$(jq -r .headSha <<<"$RUN_JSON")" = "$HEAD_SHA"
test "$(jq -r .status <<<"$RUN_JSON")" = completed
test "$(jq -r .conclusion <<<"$RUN_JSON")" = success
RUN_ATTEMPT="$(jq -r .attempt <<<"$RUN_JSON")"
```

Discovery is bounded to five minutes and excludes every run ID observed before
dispatch, so an older success cannot be selected. The final assertion rejects
every other SHA and every non-success terminal state.

- [ ] **Step 5: Download and verify the accepted proof bundle**

Create a fresh download directory, fetch only artifact
`aria-operational-proof-${HEAD_SHA}`, and run:

```bash
PROOF_DOWNLOAD_DIR="$(mktemp -d)"
gh run download "$RUN_ID" \
  --name "aria-operational-proof-${HEAD_SHA}" \
  --dir "$PROOF_DOWNLOAD_DIR"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:. \
python3 -m aria_kernel.operational_proof verify \
  --proof-root "$PROOF_DOWNLOAD_DIR" \
  --expected-target-sha "$HEAD_SHA" \
  --expected-workflow-run-id "$RUN_ID" \
  --expected-workflow-run-attempt "$RUN_ATTEMPT"
```

The canonical outer verifier, rather than manual inspection, requires every
success, continuity, immutability, DLP, and closed-file condition and rejects a
restored store or scratch tree by name. Inspect the three summaries only as a
human-readable cross-check.

- [ ] **Step 6: Merge #1332 through protected GitHub controls**

Re-read exact PR head and checks immediately before:

```bash
test "$HEAD_SHA" = "$(git rev-parse HEAD)"
test "$HEAD_SHA" = "$(git ls-remote origin refs/heads/fix/kernel-ci-timeouts | awk '{print $1}')"
test "$HEAD_SHA" = "$(gh pr view 1332 --json headRefOid --jq .headRefOid)"
REQUIRED_CHECKS_JSON="$(gh pr checks 1332 --required --json bucket,state,name)"
test "$(jq 'length' <<<"$REQUIRED_CHECKS_JSON")" -gt 0
test "$(jq '[.[] | select(.bucket != "pass")] | length' \
  <<<"$REQUIRED_CHECKS_JSON")" = 0
gh pr merge 1332 --merge --match-head-commit "$HEAD_SHA"
git fetch origin main
git merge-base --is-ancestor "$HEAD_SHA" origin/main
gh pr view 1332 --json state,mergedAt,mergeCommit,url
```

Expected: protected merge succeeds, ancestry command exits 0, PR state is
`MERGED`. Do not request branch deletion: `fix/kernel-ci-timeouts` is checked
out by another linked worktree. Do not delete the isolated worktree until #1333
receives this main.

---

### Task 7: Carry merged main into #1333 and complete the prerequisite chain

**Files:**

- Worktree: `/var/aqua-saas/.worktrees/aquamobil-v4-safe-integration`
- PR: #1333

**Interfaces:**

- Consumes: merged #1332 commit reachable from `origin/main`.
- Produces: #1333 head containing current main through an ordinary merge, with
  no rebase, cherry-pick, transplant, or duplicate source reconstruction.

- [ ] **Step 1: Verify the #1333 worktree and PR head before mutation**

```bash
git status --short --branch
PR_HEAD_BRANCH="$(gh pr view 1333 --json headRefName --jq .headRefName)"
test "$PR_HEAD_BRANCH" = "feat/aquamobil-v4-safe-integration"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git ls-remote origin "refs/heads/$PR_HEAD_BRANCH" | awk '{print $1}')"
PR_SHA="$(gh pr view 1333 --json headRefOid --jq .headRefOid)"
test "$LOCAL_SHA" = "$REMOTE_SHA"
test "$LOCAL_SHA" = "$PR_SHA"
test "$(gh pr view 1333 --json baseRefName --jq .baseRefName)" = "main"
test "$(gh pr view 1333 --json state --jq .state)" = "OPEN"
```

Stop if the worktree is dirty or local, remote, and PR heads differ.

- [ ] **Step 2: Re-prove #1332 ancestry and start a no-commit merge**

```bash
git fetch origin main
PR_1332_MERGE="$(gh pr view 1332 --json mergeCommit --jq .mergeCommit.oid)"
git merge-base --is-ancestor "$PR_1332_MERGE" origin/main
PRE_MERGE_HEAD="$(git rev-parse HEAD)"
MAIN_SHA="$(git rev-parse origin/main)"
git merge --no-ff --no-commit "$MAIN_SHA"
```

Resolve any conflict from source intent and current-main architecture; never
choose whole sides mechanically. Read every nested `CLAUDE.md` for conflicted
paths before editing.

- [ ] **Step 3: Regenerate generated authorities and commit the merge**

Resolve source files first. For expected conflicts in generated authorities,
do not select either stale side: regenerate from the resolved source tree and
verify both authorities before committing.

```bash
npm run quality:format-scope:generate
npm run aria:authority-hash:write
node tools/quality/quality.mjs format-scope check
npm run aria:authority-hash
git diff --check
test -z "$(git diff --name-only --diff-filter=U)"
git add -u
git add tools/quality/format-scope.json docs/aria/CURRENT_STATE.md
git commit
MERGE_HEAD="$(git rev-parse HEAD)"
test "$(git rev-parse HEAD^1)" = "$PRE_MERGE_HEAD"
test "$(git rev-parse HEAD^2)" = "$MAIN_SHA"
test "$(git rev-list --parents -n 1 HEAD | awk '{print NF}')" -eq 3
git merge-base --is-ancestor "$PR_1332_MERGE" "$MERGE_HEAD"
```

The commit must be an ordinary two-parent merge whose second parent is the
exact fetched `origin/main`, and that parent must contain #1332's merge commit.

- [ ] **Step 4: Verify and push #1333's merge head**

```bash
NX_DAEMON=false npx nx affected --target=test --output-style=static
NX_DAEMON=false npx nx affected --target=lint --output-style=static
git diff --check
git status --short --branch
git push origin "HEAD:$PR_HEAD_BRANCH"
```

Require local, remote, and PR head SHA equality after the push.

- [ ] **Step 5: Require exact-head Actions and protected merge for #1333**

Monitor every required check on the exact SHA. Diagnose any failure, apply a
root-cause fix with tests and governed traceability, and repeat exact-head
verification. When all checks are successful:

```bash
HEAD_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git ls-remote origin "refs/heads/$PR_HEAD_BRANCH" | awk '{print $1}')"
PR_SHA="$(gh pr view 1333 --json headRefOid --jq .headRefOid)"
test "$HEAD_SHA" = "$REMOTE_SHA"
test "$HEAD_SHA" = "$PR_SHA"
gh pr checks 1333 --required --watch --fail-fast --interval 10
test "$(gh pr view 1333 --json headRefOid --jq .headRefOid)" = "$HEAD_SHA"
gh pr merge 1333 --merge --match-head-commit "$HEAD_SHA"
git fetch origin main
git merge-base --is-ancestor "$(gh pr view 1333 --json mergeCommit --jq '.mergeCommit.oid')" origin/main
gh pr view 1333 --json state,mergedAt,mergeCommit,url
```

Expected: PR #1333 is `MERGED` and its merge commit is reachable from
`origin/main`. Continue remaining Aquamobil slices only from that verified
baseline.
