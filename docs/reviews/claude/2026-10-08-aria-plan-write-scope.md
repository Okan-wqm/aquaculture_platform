# Two ARIA defects that kept F-015's plan from converging (2026-10-08)

Context: plan `plan-cyc-20261007T081056Z-auto` (aria/state `tools/plans/events.jsonl`), the first
live end-to-end plan, started from operator request OP-F015-20261007-1. It ended `HUMAN_REQUIRED`
at round 2 (`plan_evaluated` ff4520f4: `material_cross_review_risks_present`,
`max_rounds_reached`). Two of the remaining cross-review risks were ARIA's own defects, not the
plan's.

Owner: claude (implementation), okan (review). Deadline 2026-10-15.

## ARIA-HIGH-381

The operator signed: "Keep every change inside hr-module (the contracts in shared-ui and
hr-service are read-only evidence)." The plan's key-change-0 still listed
`apps/hr-service/src/leave/entities/leave-request.entity.ts` as a path, and so did the round
obligation built from it. Both planners narrowed the paths to honour the operator. The
cross-reviewer flagged the narrowing in both rounds (`cross_review_recorded` 45fa00e2, CR-006):
"if the conformance gate reads path-set equality ... the converged body fails".

Root cause: ARIA treated every file a finding cites as a file its plan must write. The chain:

- `finding_grounding._judge_finding` (`finding_grounding.py:492` on main) made every grounded,
  non-readonly evidence path an `affected_surface`.
- The operator branch of `plan_synthesizer.convert_candidate_to_plan_content` copied them into
  `affected_surfaces` (`plan_synthesizer.py:1494`) and into key-change-0's `paths`
  (`plan_synthesizer.py:1576`). The F-finding seed did the same (`finding_seed.py:244`).
- `plan_round_scope.plan_round_contract` minted the obligation "touching only the files listed
  under `paths`" (`must_satisfy.py:142`) over those paths.
- Staging (`apply_engine._intended_files_from_plan`, `apply_engine.py:616`) gave the same set to
  the change ledger. `change_ledger.verify_change_scope` (`change_ledger.py:315`) refuses an
  intended file the diff leaves untouched unless the implementer declares a disposition.

So the reviewer's worry was real: an implementation that honoured the operator would have been
refused unless it argued its way past the gate.

Rule: write scope and evidence scope are distinct sets. A cited file is evidence. Only the
surfaces the plan may change are write scope, and the conformance gate judges the diff against
write scope only.

### 381 fix

New module `aria-kernel/aria_kernel/plan_write_scope.py`. `split_surfaces` partitions a finding's
grounded surfaces once, at admission, on one of three recorded bases:

- `operator_declared`: the request carries a signed `write_roots` list. A surface equal to or under
  a root is write scope; every other cited file is evidence.
- `fix_target_module`: no declared roots, and the drift class has a copy side in
  `DRIFT_COPY_SIDES`. Only `ui_option_drift` has one: the scanner judges the UI's options against
  the wire contract, so the UI is the copy. The surfaces in the copy's project are write scope, and
  a cited file in another project is evidence.
- `undivided`: the finding names no copy side (not a drift, or a class such as `enum_drift`), so
  every cited surface stays writable, as before.
- `fix_target_ungrounded`: the copy side is defined but its file moved. See the review
  corrections below.

How the request carries the boundary, and why both mechanisms exist:

- The request row's signature covers every field
  (`operator_request_signature.subject_signing_bytes`). An optional `write_roots` field is
  therefore signed whenever it is present, and a row without it keeps its exact bytes.
- The recorder (`aria-kernel feedback request --write-root <root>`, repeatable) validates the list.
  It refuses a boundary that leaves no grounded surface to change (`finding_write_scope_empty`)
  before anything is signed. Ingestion refuses a malformed list as `schema_invalid` and carries a
  valid one to admission.
- A row signed before this change cannot gain the field, and the operator's prose is never parsed
  for scope. OP-F015 is such a row, so the derivation is what makes it plannable as the operator
  asked. The field is how a later operator states a boundary the derivation would not choose, such
  as a backend-side fix.

How the split reaches the plan and the gate:

- Admission returns the write set as `affected_surfaces` and records `evidence_surfaces` and
  `write_basis`. The converter therefore writes only write scope into `affected_surfaces` and
  key-change paths. `evidence_refs` still cite every file. The F-finding seed applies the same
  split, and its summary names the read-only files.
- `plan_origin.compute_admission_scope` records `evidence_surfaces` (admission scope v4). The list
  is re-derivable from the started body and refused on every fold if it is widened or narrowed.
  `paths_outside_admission_scope` refuses an evidence surface even under a closure root, so no
  challenger draft or revision can put one back into a body.
- `plan_round_contract` adds the evidence surfaces to the round's read-only `evidence_scope`. The
  planner prompt lists them under "Read-only evidence scope".
- The obligation's `paths`, the implementation `allowed_scope` and the change ledger's intended
  files therefore contain write scope only.

### 381 proof

`aria-kernel/tests/test_plan_write_scope.py` (9 tests) drives the production provider over the
F-015 subject:

- A request signed without a boundary converts to `affected_surfaces == [LeavesPage.tsx]` and
  key-change paths `[[LeavesPage.tsx]]`, with the entity still in `evidence_refs`.
- The started plan's admission scope lists the entity under `evidence_surfaces`, and
  `apps/hr-service` is not a closure root. The round obligation's paths exclude it, the entity is
  in the round's `evidence_scope` and outside every `allowed_scope` entry, and the bound refuses
  it.
- Staged through `_intended_files_from_plan`, the change ledger accepts a diff that touches only
  the page, with no disposition owed. A diff that writes the entity is refused as scope drift.
- Declared `write_roots` override the derivation in either direction. A boundary that covers
  nothing, a glob, or a readonly root is refused before signing. A signed row with a malformed list
  is `schema_invalid`.
- An unattended F plan writes only the copy side. The seeder's side order is pinned to the
  kernel's.

One existing test pinned the defect: in `test_finding_plan_path.py`, the seed test for a drift
subject that still reproduces expected both files as key-change paths. It now expects the page as
the only write surface and the entity as evidence. The fixtures that build pre-v4 admission records
(`test_plan_dependency_evidence_scope.py`, `test_subject_pin_policy.py`) now also drop
`evidence_surfaces`, and the scope record test asserts admission scope v4.

## ARIA-MEDIUM-382

A round-2 cross-reviewer (`cross_review_recorded` 27c24d11, CR-004, material) wrote: "the
repository map lists no spec under web-hr-module ... the runner may be unconfigured". The runner
is configured:

- `web/modules/hr-module/package.json` runs `vitest run` as `test`.
- nx infers that script as the project's `test` target (`nx:run-script`, confirmed with
  `nx show project hr-module`). `project.json` declares no test target.
- Two spec files under the project passed that day.

Root cause: the repository map (`twin`) carried no test fact per project.

- `build_twin_map` and `refresh_twin_map` wrote only `root`, `depends_on`, `dependents` and `layer`
  (`twin.py:107`, `twin.py:206`).
- `twin_context_for_files` passed only those fields on (`twin.py:667`), and
  `_render_repository_map` rendered only the layer and the dependents (`agent_invocations.py:858`).
- The only test data was the per-file `tests` list. `LeavesPage.tsx` has no spec of its own, so the
  prompt said nothing about testing in hr-module, and the reviewer read that silence as "none".

Rule: the map states every project's test targets and spec files. An empty list is rendered in
words, never as a gap.

### 382 fix

- New module `aria-kernel/aria_kernel/twin_test_surface.py` reports, per project:
  - `test_targets`: every target named `test`, `test:*` or `test-*`, resolved the way nx resolves
    targets. `project.json` `targets` come first. Then each `package.json` script nx infers as a
    target, narrowed by `nx.includedScripts` when that is set. A name `project.json` already
    declares is not counted twice. Each target records its source and its command.
  - `spec_files`: every test file of the map, attributed to its project by
    `impact_graph.project_for_path`.
- The full build and every refresh compute the test surface with the same function. The project
  graph cache cannot hide a new spec or a new script, and the incremental-equals-rebuild contract
  holds.
- `TWIN_SCHEMA_VERSION` moves to 2. A v1 map is rebuilt whole (`refresh.reason == "schema_changed"`)
  and never patched.
- The blast-radius section of the prompt now lists each project's test targets with their commands
  and its spec files (count, then up to 10 names). For a project with neither, it says "none". A
  row sealed from a v1 map has no such keys and renders exactly as it was sealed, so replay hashes
  still verify.

### 382 proof

`aria-kernel/tests/test_twin_test_surface.py` (6 tests), on a fixture shaped like hr-module (a
`package.json`-only test target, two specs that test other files, and the page with no spec):

- the inferred target and both specs are on the project;
- the prompt for the page states `test` (`vitest run`, package.json) and the two specs;
- an untested project says "none";
- `nx.includedScripts` narrows the inferred targets;
- a refresh after a new spec and a new script equals a clean rebuild;
- a v1 map is rebuilt whole.

## Review corrections (PR #1859)

An independent review found three MEDIUMs. All three are fixed in this PR.

### MEDIUM-1 (381): the derived rule picked a side for `enum_drift`

`drift_fix_target` always took the first evidence, and `DRIFT_COPY_SIDES` was never read. For a
cross-service `enum_drift` (a TS enum against a SQL enum), the usual fix is a migration on the SQL
side. The derived split made the SQL side evidence, so a plan could only remove values from the TS
enum.

- `DRIFT_COPY_SIDES` (`{"ui_option_drift": "ui"}`) is now the one table of the rule.
  `DRIFT_CLASS_SIDES` records the sides each class carries, in the seeder's writing order. The copy
  position comes from those two tables.
- A class without a copy side, `enum_drift` included, stays `undivided`.
- `test_the_rule_table_is_the_seeder_s_own_side_order` pins both tables against
  `seed_drift_findings.select_candidates` and `drift_evidences`.
  `test_only_a_class_with_a_defined_copy_side_is_split` covers both classes.

### MEDIUM-2 (382): Rust and Python projects rendered "none"

`sens-api-gateway`, the `crates-*` projects, `sensorprotocols-wasm-decoder-template` and
`aria-kernel` rendered "test targets: none". That was a false explicit negative, the same failure
ARIA-MEDIUM-382 is about.

- A project with `Cargo.toml` gets a `cargo test` target. Its specs are the `.rs` files under a
  `tests/` directory plus those holding a `#[cfg(test)]` module. `sens-api-gateway` now reports
  250 spec files.
- A project whose `pyproject.toml`, `setup.cfg` or `tox.ini` names pytest, or that has a
  `pytest.ini` or a `tests/` directory of `test_*.py`, gets a `pytest` target. `aria-kernel` now
  reports 792 `test_*.py` / `*_test.py` files.
- A project with none of the manifests the map reads is `test_surface_modelled: false`. It renders
  "not modelled", never "none" (for example `platform-cqrs`, `libs/sdk`).
- Cost: the spec inventory is one `os.walk` that prunes dependency and build trees before entering
  them. It takes 0.26 s on this repository, so the build and every refresh recompute it.
  `_iter_test_files` (the TESTED_BY input) used four `rglob` passes that walked every
  `node_modules` tree and filtered afterwards. It is now one pruned walk with the same result set
  (2653 files here, 0.08 s), so a non-noop refresh no longer pays for the dependency tree.
- Tests: `test_a_rust_crate_and_a_python_project_report_their_runners` and
  `test_a_project_whose_manifest_is_not_read_says_not_modelled_never_none`.

### MEDIUM-3 (381): a moved copy side was refused before the seed could re-ground it

If `LeavesPage.tsx` was renamed, admission grounded only the contract, which lies outside the copy's
module. Admission refused with `finding_write_scope_empty` before `seed_finding` could relocate the
ref, and `closure_blocker` counted the finding as not closable.

- `split_surfaces` returns `fix_target_ungrounded` when the copy side is defined but no surface
  handed in is it.
- `admit_unattended_finding` is used by the F-finding source and by `closure_blocker`. On that basis
  it admits with an empty write set and leaves the split to the seed. The loop guard checks every
  grounded surface, because the write set is not known yet.
- The seed reads the copy from the detector's current matches (`drift_fix_target(record, refs)`,
  in the seeder's side order), so the renamed file becomes the write surface. Without a detector,
  the cited lines cannot follow a rename, and the seed reports the subject unverifiable
  (`fix_target_ungrounded`) instead of guessing.
- An operator request still refuses by name. Its signed refs cannot follow a moved file, so the
  operator re-signs with `--write-root`.
- Tests: `test_the_unattended_plan_is_re_grounded_on_the_renamed_copy` and
  `test_aria_s_lane_may_close_it_and_an_operator_request_is_refused_by_name`.

Proof: the six new tests above fail on the previous PR tip `7b30f70ea`.
