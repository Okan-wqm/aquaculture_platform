# ARIA kernel WC — workflow contracts, the registry view, the class-builder origin (2026-10-02)

Context: program plan rev2, Faz 1 item K7 "WC", required by HIGH ruling 6 before F-P2 (delta
registry), F-L0/F-L1 (label intake and rounds) and CB-3 (class builder). Each of those lanes was
planned as kernel-free, yet each depends on a kernel surface that could not serve it. Measured on
`main @ 44983f55d`.

Owner: claude (implementation), okan (review). Deadline 2026-10-16.

## ARIA-HIGH-279 — The kernel cannot see delta rows, its workflow inventory is a hand list, and the class builder has no origin

1. **Three registry readers, none of which sees a delta row.** F-P2 moves a PR's registry write
   out of the hash-chained `docs/reviews/_registry/findings.jsonl` into its own
   `docs/reviews/_registry/deltas/<branch>.jsonl`, folded into the chain later. The kernel read
   the chain directly at three sites, each with its own parser: report ingestion
   (`aria-kernel/aria_kernel/report_ingestion.py:55`, strict), the deadline organ
   (`aria-kernel/aria_kernel/deadlines.py:191`, bare `json.loads`) and the ORPHAN evidence attach
   (`aria-kernel/aria_kernel/plan_synthesizer.py:571`, tolerant). Between a PR's merge and the
   fold, a finding the PR added was never ingested, a finding it resolved stayed OPEN to
   ingestion and to the deadline organ, and evidence it corrected was not attached to the plan.
   Ingestion also cited `findings.jsonl` for every row (`report_ingestion.py:263-264`), including
   a row that is not in that file.
2. **The workflow inventory is a hand list.** `discover_aria_workflows`
   (`aria-kernel/aria_kernel/workflow_contracts.py:85-89`) found `aria-*` workflows plus two named
   ones. `finding-closure-reconcile` is contracted (`workflow_contract_registry.py:798`) and calls
   the enterprise preflight, but the list never learned it, so the generated workflow inventory
   (`docs_ssot runtime-inventory`) and every check that walks discovery skipped it. A new
   workflow that calls the preflight under any other name (the F-P2 fold, the F-L0 intake) would
   be refused by the preflight at run time while the registry test stayed green. All 12
   `aria-*.yml` workflows on main are covered (8 contracted, 4 audited exclusions).
3. **No origin for the class builder.** CB-3 mints one finding per (class_key = tool:rule, Nx
   project) slice so the operator's one signed CP-1 request names exactly one F finding.
   `emit_finding` admits only origins in the closed `ORIGINATING_SKILL_ALLOWLIST`
   (`aria-kernel/aria_kernel/finding.py:105-126`), which had none for it.
4. **A runner verb the kernel admits, rewritten outside the kernel.** The validation lane admits
   `node tools/quality/quality.mjs format-scope check` (`validation.py:68-71`). PR #1713 (F-P1,
   head `2272c9a04`) rewrites that domain and removes `format-scope generate`. It keeps `check`
   with the same argv and keeps it read-only, so the kernel is correct on both sides of #1713;
   nothing would have reported it had the verb gone.

### Fix (fix/aria-workflow-contracts-delta-registry)

- `report_ingestion.read_registry_view` is the one reader. It folds every
  `deltas/*.jsonl` row over the chain: a row for a known id replaces it in place, a new id is
  appended, the later row of one file wins, and every entry names the file holding its effective
  row. A delta row without an id, with a state outside the schema's five, or for an id another
  delta file claims is refused (strict) or recorded as malformed (tolerant), never folded. An
  `override_of` successor is its own finding and leaves the overridden row as it is, as the
  registry README's successor pattern requires. All three sites read through it; ingestion
  cites the row's own file.
- `discover_aria_workflows` derives the second set: a workflow is governed when a `run:` block
  calls `verify_workflow_preflight(`. The hand list is gone and `finding-closure-reconcile` is
  discovered.
- `class_builder:tool_rule` joins the allowlist as an exact origin; prefixes and near spellings
  stay refused.
- A kernel test pins that every admitted quality-runner verb is dispatched by the runner's
  `main()`; it holds on main and on #1713.

### Assumptions about the delta format

F-P2 has not defined it; no branch carries a `deltas/` directory. The view takes the format the
registry already has: a delta line is a registry row in the chain's shape (chain hashes not
required), keyed by `id`, under `docs/reviews/_registry/deltas/*.jsonl` (the path the program
plan names). A transition is a new version of the row, which is what `close` and `reopen` write
in place today; files fold in name order; one file owns an id until the fold. The fold that writes
a file's rows into the chain removes that file in the same commit, because a row left behind would
replay its older state over the chain.

### Observations, not filed

- `aria-kernel/aria_kernel/preflight.py:802` exempts `tools/quality/format-scope.json` from the
  clean-worktree check. #1713 deletes that file, after which the exemption names a path no tool
  writes. It is harmless on both sides of #1713 and belongs with the file's removal.
- `import_finding_file` still cites `findings.jsonl` for rows it reads from an imported file.
