# 2026-10-13 — ARIA quality audit port: Z.ai findings re-validated on main

**Owner agent:** zcode · **Cycle:** 2026-10-13-aria-quality-audit-port · **Branch:**
`fix/aria-zai-quality-port` (origin/main 99689e46b plus the ARIA repair stack
`fix/aria-pr-lifecycle-plan-ownership`, merged as 6fc1499a6)

## The Z.ai run and why it was taken over

Z.ai's ZCode lane (GLM) ran an "ARIA quality upgrade" audit (run dwfrun-d1c4add5) in the main
checkout at 43f0aa3bf (#1397, 2026-09-03), about 2,570 commits behind origin/main. It produced 219
findings, most with a patch against that snapshot. On 2026-10-13 the operator stopped the run and
handed the work to Claude. A patch written against a two-month-old base cannot be applied to main,
and some findings no longer held there, so every finding was re-validated on main and every fix
re-derived on main instead of replaying the patches.

Wave 1 (this review) decided each of the 219 findings against main 99689e46b with file:line
evidence, implemented the valid ones on `fix/aria-zai-quality-port`, reviewed them in four lenses
and ran the scoped ARIA and jest gates. The repair stack was then merged under the port and the two
were integrated (five conflict resolutions, listed under Integration).

## Outcome

| Disposition                                                          | Z.ai IDs |
| -------------------------------------------------------------------- | -------: |
| Fixed on this branch (53 registered findings, 3 commits without one) |      148 |
| RECORD_STUB: valid, recorded for wave 2                              |       33 |
| ALREADY_FIXED_ON_MAIN                                                |       21 |
| CODE_GONE_ON_MAIN                                                    |        3 |
| INVALID                                                              |       14 |
| Total                                                                |      219 |

The registry rows are ARIA-LOW-449 to ARIA-HIGH-501 (`owner_agent` zcode), one per commit whose type
the trailer gate binds (`fix`, `security`). ARIA-HIGH-448 is not used here: the allocator's
reservation ledger holds it for a row of the repair branch. The one `refactor` and two `test`
commits carry no `Closes:` trailer and have no row; their Z.ai IDs are listed under Commits without
a finding. Each row's evidence cites the fix on this branch as file:line.

A stub is a valid finding (or the remaining part of a fixed one) that wave 1 did not implement.
Stubs are recorded for wave 2 and are not registered here. Code comments added by wave 1 cite
registry IDs, never Z.ai IDs, which do not resolve in this repository.

## Findings

### ARIA-LOW-449 — ledger restates its own bodies and owns no JSON writer or digest

- **Z.ai IDs:** A1-4, A1-7, A1-9
- **Root cause on main:** Private copies restated the kernel JSON-file write, the canonical sha256
  was spelled inline at 20+ sites, five modules kept `_is_sha256_digest` copies, and ledger.py
  itself kept dead helpers (`_rewrite_jsonl_locked`, the `_refresh_adjacent_index` alias) and
  duplicated parse and verify-and-raise bodies.
- **Fix:** `ledger.atomic_write_json`, `ledger.sha256_of_canonical_json` and
  `ledger.is_sha256_digest` are the owners; the dead helpers are deleted and the duplicated bodies
  become `_parse_jsonl_stored_text`, `_verify_file_or_raise` and `_verify_text_or_raise`. Callers
  move in ARIA-MEDIUM-490 and ARIA-LOW-491.
- **Tests:** `test_ledger_verify_strict.py`
- **Not done:** `atomic_write_json` stays ungoverned (declared `rewrite_fsync` surfaces written
  through it skip the profile gate; stub); no prefixed-digest owner (E11-4 stub); `canonical_json`
  has no default= hook (E11-2 stub).

### ARIA-MEDIUM-450 — `autonomy_evidence` keeps test-only twins of the capability fold

- **Z.ai IDs:** A6-2
- **Root cause on main:** `_capability_safe_counts` and `_capability_counts_with_blocker` were
  called only by tests, so the tests pinned a twin of
  `_StreamingEvidenceAccumulator.capability_counts`, the fold `autonomy status` reports.
- **Fix:** Both twins, their import and the unused `_MAX_EVIDENCE_LEDGER_LINE_BYTES` are deleted;
  the tests fold through the streaming accumulator. The repair-stack test
  `test_enterprise_ci_loop.py`, which called the deleted helper, reads the same fold.
- **Tests:** `test_autonomy_evidence_status.py`
- **Not done:** `_evaluate_native_rows`, a test seam over production `_summarize_native_rows`, is
  kept.

### ARIA-MEDIUM-451 — `governance_reader` drops non-object rows that `strict_jsonl_reader` diagnoses

- **Z.ai IDs:** A1-3, A13-6
- **Root cause on main:** Two copies of one decode loop had drifted: `read_governance_rows` skipped
  a non-object row silently although its contract says every corrupt row is diagnosed, and its 1 MiB
  line cap was retyped.
- **Fix:** `strict_jsonl_reader.iter_stored_jsonl_rows` holds the loop once and both readers use it;
  the cap is `ledger.LEDGER_ROW_MAX_BYTES`, pinned for both readers.
- **Tests:** `test_governance_reader.py`, `test_strict_jsonl_reader.py`,
  `test_phase_v12_a_ledger_write_cap.py`
- **Not done:** `ledger._parse_jsonl_stored_text` still keeps legacy non-object rows as stored for
  its kernel-wide callers (documented `ledger.read_jsonl` contract).

### ARIA-MEDIUM-452 — ack ledger mints through two bodies, a private encoder and a wrong field list

- **Z.ai IDs:** A1-1, A1-5, A1-8, A1-10, E1-1
- **Root cause on main:** `mint_operator_ack` and `mint_auto_ack` carried the same body twice,
  signing used a private JSON encoder beside `ledger.canonical_json`, and `ack_row.py` claimed 17
  mandatory fields while the set held 21 and missed `schema_version`.
- **Fix:** One `_mint_ack` body, `canonical_json` signing bytes (golden-pinned), and
  `ACK_ROW_REQUIRED_FIELDS = fields(AckLedgerRow)`; the row is built before the append, so an
  undeclared key leaves no signed token behind.
- **Tests:** `test_phase_a5_ack_ledger.py`
- **Not done:** main's `hmac_keyring.utc_now_stamp` import is kept; Z.ai's `tool_registry.utc_now_z`
  swap was not ported.

### ARIA-MEDIUM-453 — state manifest accepts durability values outside its Literal

- **Z.ai IDs:** A11-3
- **Root cause on main:** `StateSurface` Literal fields were never checked at runtime, and two rows
  declared `fsync`, which `DurabilityPolicy` does not define.
- **Fix:** `_CLOSED_VOCABULARIES` is derived from the Literal aliases, `__post_init__` raises
  `state_surface_<field>_invalid`, and both rows say `append_fsync`.
- **Tests:** `test_state_manifest_transaction.py`
- **Not done:** the dead `index_group` field (A1-2) stays; it is a stub.

### ARIA-MEDIUM-454 — `state_compact` compares naive timestamps with an aware cutoff

- **Z.ai IDs:** A11-6
- **Root cause on main:** `state_compact._parse_ts` returned a naive datetime for a stamp with no
  offset; comparing it with the aware cutoff raised TypeError mid-compaction.
- **Fix:** All five call sites use `tool_registry.parse_utc_stamp` and `_parse_ts` is deleted.
- **Tests:** `test_state_compact.py`
- **Not done:** `_cycle_timestamp` and `_archive_stamp` parse other formats and already return aware
  datetimes; untouched.

### ARIA-MEDIUM-455 — autonomy orchestrator ignores its injected `profile_gate`

- **Z.ai IDs:** A12-3, A12-9
- **Root cause on main:** `run_autonomy_orchestrator` resolved `profile_gate` to a no-op and never
  evaluated it while the real preflight ran inline, so an injected gate changed nothing.
- **Fix:** The preflight moves into `cycle_phases/profile_gate.PreflightProfileGate`, the default
  gate, and the orchestrator evaluates it; one verdict type remains. Empty `TYPE_CHECKING` blocks
  go.
- **Tests:** `test_autonomy_orchestrator.py`, `test_phase_v31_0_cycle_phases_scaffold.py`,
  `test_breaker_profile_independence.py`, `test_perimeter_observe_has_no_breaker_edge.py`
- **Not done:** no `select_profile_gate` factory or profile-name branching; the run-level V9.0-C
  `verify_preflight` stays inline; the lazy `except ImportError: pass` guards were moved unchanged
  from main, not removed.

### ARIA-MEDIUM-456 — `memory_gap` docstring denies the `restore_and_replay` it defines

- **Z.ai IDs:** A5-2
- **Root cause on main:** The module docstring said restore-and-replay is not here while the module
  defines it and `cycle.py` calls it.
- **Fix:** The docstring describes diagnose-then-recover; the freeze docstring names
  `PreflightProfileGate`.
- **Not done:** docstring only; no behaviour change.

### ARIA-LOW-457 — `acquire_lease` documents a same-host-refresh opt-out no caller uses

- **Z.ai IDs:** A10-7
- **Root cause on main:** `allow_same_host_refresh` was documented as set to False by a cron, but no
  caller passed False.
- **Fix:** The parameter is removed: the same host refreshes its own fresh lease, a different host's
  fresh lease is refused; the gateway daemon calls are updated.
- **Not done:** no new test pins the same-host refresh path; `acquire_lease`'s signature changed
  (internal kernel API, both callers updated).

### ARIA-MEDIUM-458 — CLI retypes refusal, verdict, snapshot and lease vocabularies

- **Z.ai IDs:** A2-6
- **Root cause on main:** The CLI retyped choice lists other modules own, `agent_question` claimed
  its refusal reasons mirror `aria/agent-refusal/v1` (they do not), and `--lease-seconds` defaulted
  to a literal 1800.
- **Fix:** Choices are the owner enums (`QUESTION_KINDS`, `RESPONSE_VERDICTS`,
  `REFUSAL_REASON_CLASSES`, `SNAPSHOT_MODES`), the lease default is
  `agent_invocations.DEFAULT_LEASE_SECONDS`, and `agent_question` documents its enum as its own.
- **Tests:** `test_agent_refusal_vocabulary.py`

### ARIA-MEDIUM-459 — `auto_batch_dispatch` re-dispatches pressures the state machine ruled on

- **Z.ai IDs:** 10-A4, A10-6, A10-9
- **Root cause on main:** Re-dispatch was blocked only for a hand-picked state set, so a pressure
  whose assignment was `submit_rejected`, `stale`, `human_required` or `verification_failed` got a
  fresh retry budget.
- **Fix:** `REDISPATCHABLE_ASSIGNMENT_STATES = {cancelled, expired}` names the complement, so a
  state the reducer learns later blocks by default; the reducer docstring matches its fold and the
  dead `_latest_request_states` is deleted.
- **Tests:** `test_auto_batch_redispatch_gate.py`, `test_assignment_state_as_claims_ssot.py`
- **Not done:** the reducer's local `TERMINAL_STATES` is not hoisted.

### ARIA-HIGH-460 — worker timeout outlives its lease; the lease default is defined five times

- **Z.ai IDs:** A10-2, A10-3, A10-5, A10-8, E5-1
- **Root cause on main:** The worker hook gave its child `lease_seconds + 60`, so the lease expired
  before the timeout fired and every hang became a `lease_expired` requeue; `DEFAULT_LEASE_SECONDS`
  was defined in five modules plus one literal.
- **Fix:** `agent_invocations.executor_timeout_seconds` is the one budget for both hooks and
  `DEFAULT_LEASE_SECONDS` has one definition; a vacuous merge patch in the hook test became real
  assertions that no merge runs.
- **Tests:** `test_lease_seconds_single_owner.py`, `test_worker_dispatch_hook.py`,
  `test_y1y3_claim_lifecycle.py`
- **Not done:** the 300 s floor means the budget sits inside the lease only for leases of at least
  420 s (documented in the owner).

### ARIA-MEDIUM-461 — `HUMAN_REQUIRED` records bypass the declared-surface writer and profile gate

- **Z.ai IDs:** A7-2, A7-10
- **Root cause on main:** `human_required` wrote its declared records with raw `write_text`,
  skipping the manifest, the profile gate and the atomic rename; under `frozen` a resolve reached
  disk before the governance append refused.
- **Fix:** `_write_human_required_record` writes the record and its governance row in one
  `state_transaction`; every write site uses it and the resolve is gated at entry.
  `record_provider_restored` asks the items' profile before writing its row.
- **Tests:** `test_human_required.py`, `test_frozen_profile_global_no_write.py`,
  `test_belief_verdict_channel.py`, `test_provider_outage_signal.py`
- **Not done:** `record_human_required` still calls `ensure_tools_dir` at entry, a second wait
  behind a recovery holder (stub); the SLA rename was applied although the fleet judged A7-5 INVALID
  (operator to confirm).

### ARIA-MEDIUM-462 — `agent_surface` omits a kernel-minted target and keeps dead state copies

- **Z.ai IDs:** A2-3, A16-4, A18-6
- **Root cause on main:** The target whitelist lacked `aria-cross-reviewer`, which the kernel mints;
  the dead-state set named `EXPIRED`, which `derive_request_state` never returns; and an unread
  genesis state copy missed `REJECTED`.
- **Fix:** Each is fixed, and `test_agent_surface_ssot` pins the whitelist, both dead-state sets and
  the single genesis vocabulary owner.
- **Tests:** `test_agent_surface_ssot.py`
- **Not done:** `cross_review` is not added to `ROLE_TARGET_PAIRING`; `derive_request_state`'s
  `CANCELLED_BY_OPERATOR` is missing from `DERIVED_REQUEST_STATES` (stub).

### ARIA-MEDIUM-463 — executor keeps a caller-less claim entry and its own mock-flag parser

- **Z.ai IDs:** A9-3, A9-4
- **Root cause on main:** `ci_executor.claim_and_dispatch_one` and the `_parse_bool_env` family had
  no caller, comments still named the dead entry as a gate, and `worker_executor` mapped an unknown
  mock value to False.
- **Fix:** The dead code is deleted, comments name `ci_executor_drain.require_dispatchable_arc`, and
  `worker_executor` calls `claude_runtime.is_mock_mode`.
- **Tests:** `test_mock_bool_normalize.py`, `test_role_hygiene_e14.py`
- **Not done:** docs/aria/BEHAVIOUR.md:140 is a dated measurement and was left as measured.

### ARIA-MEDIUM-464 — `agent_compliance` grades refusals on a field the producer never writes

- **Z.ai IDs:** A2-4, A2-8
- **Root cause on main:** The grader required a string `reason`, which `render_refusal` never
  writes, so every conforming refusal failed; `REQUEST_OPTIONAL_FIELDS` was read only by a test.
- **Fix:** `agent_contract.refusal_envelope_defects` is the inverse of `render_refusal` and the
  grader reports its defects; the unread tuple is deleted.
- **Tests:** `test_agent_contract.py`, `test_agent_compliance.py`
- **Not done:** Z.ai's closed-key request gate was not ported; a third refusal spelling,
  `reason_summary` (implementer safety contract, `ci_executor._agent_refusal_block`), is a stub.

### ARIA-MEDIUM-465 — agent files found by three lookups; `VALID_MODELS` copies the tier order

- **Z.ai IDs:** A2-5, A7-7
- **Root cause on main:** Two private recursive globs and `agent_resolver` disagreed about which
  agents exist, and `VALID_MODELS` was a second literal beside `MODEL_TIER_ORDER`.
- **Fix:** `_AGENT_MD_DIRECTORIES` gains db-audit and edge-docs and both private resolvers delegate
  to `resolve_agent_md_path`; `VALID_MODELS = frozenset(MODEL_TIER_ORDER)`.
- **Tests:** `test_agent_runtime_profile.py`, `test_agent_contract_delivery.py`,
  `test_context_budget_gate.py`, `test_model_tier_protection.py`
- **Not done:** the validator reason code was renamed to `no_md_file_in_agent_resolver_directories`
  (grep found no reader).

### ARIA-MEDIUM-466 — ARIA write-tier agent list kept in python and jest separately

- **Z.ai IDs:** A7-4
- **Root cause on main:** The write-capable agent set existed as `WRITE_TIER_AGENTS` (python) and
  `ARIA_WRITE_TIER` (jest) and had already diverged once.
- **Fix:** The jest spec reads the python set through `execFileSync(python3 ...)` and refuses an
  empty result.
- **Tests:** `agent-frontmatter-schema.spec.ts`
- **Not done:** the spec's pre-existing Prettier debt is untouched.

### ARIA-MEDIUM-467 — recording GitHub reads pass merge gates; profile sets and PR readers copied

- **Z.ai IDs:** A7-6, A8-1, A8-2, A8-6, E4-2, E11-3
- **Root cause on main:** Recording-adapter read stubs returned readable empty shapes, so every
  auto-merge read sub-gate passed under observe, standard and frozen; profile classes and six
  `_first_string` readers were copied per module, and `auto_merge_runners` advertised a merge it
  never does.
- **Fix:** Reads return `readable: False` (`recording_adapter_no_fetch`), `runtime_profile` derives
  the GitHub profile classes from `ACTION_PERMISSIONS`, `risk_policy.first_present_string` is the
  one reader, and the dead poller and banner go.
- **Tests:** `test_pr_payload_field_reader_ssot.py`, `test_phase_a2_required_github_adapter.py`,
  `test_phase_v9_6_auto_merge.py`, `test_codex_plan_safety_contracts.py`, `test_runtime_profile.py`
- **Not done:** inline `pr.get(a) or pr.get(b)` key chains elsewhere (A8-3 stub);
  `evaluate_v9_implementation_merge`'s signature shrank to the five key fields (internal API, tests
  updated).

### ARIA-MEDIUM-468 — genesis lifecycle ignores operator policy; panel approval reports draft=None

- **Z.ai IDs:** A3-2, A3-3, A3-7, A20-10
- **Root cause on main:** The production producer passed no `repo_root`, so the operator's genesis
  policy was ignored and an explicit 0 became 5; the panel approval read keys the draft row never
  has.
- **Fix:** Policy comes from `repo_root` or `bound_workspace_root`, read without the fallback; the
  approval returns `draft['draft_id']`; local re-imports go.
- **Tests:** `test_genesis_transition_producers.py`, `test_duel_identity_and_policy.py`,
  `test_y8_genesis_panel_gate.py`

### ARIA-MEDIUM-469 — adapter import sandbox accepts relative imports and checks allow before deny

- **Z.ai IDs:** A4-10, E2-2
- **Root cause on main:** `verify_adapter_imports` judged only `node.module`, so `from . import x`
  passed, and the allow set was checked before the deny set its comment said fires first.
- **Fix:** Relative imports are refused and the order is exact deny, exact allow, deny root, then
  not-allowlisted. Merged with the repair stack's binding and dynamic-import checks (ARIA-HIGH-414).
- **Tests:** `test_phase_v9_0_e_sandbox.py`
- **Not done:** the import check is still not called by the drainer's materializer (A4-2 stub).

### ARIA-HIGH-470 — skill genesis never runs its evidence-grounded gate

- **Z.ai IDs:** A4-3, A4-6, A4-9, E2-1, E2-4
- **Root cause on main:** `_validate_evidence_grounded` had no caller; corpus sanity used its own
  fixture minimum and a hand parser; the drainer read its flag from the tools store and swallowed
  every exception; `__import__('hashlib')` sat in kernel code.
- **Fix:** The gate runs after CROSS-VERIFY #2, corpus sanity reads through `read_strict_jsonl` with
  the owner constant, the drainer reads the bound workspace without a blanket except, and an AST
  test bans `__import__` calls (the PoC adapter launcher now uses `importlib.import_module`).
- **Tests:** `test_phase_v6_2_convergent_authoring.py`, `test_phase_v7_4_skill_genesis_drainer.py`,
  `test_phase_v7_5_corpus_and_evidence_pack.py`, `test_no_dunder_import_calls.py`
- **Not done:** '#' and '[]' lines in a corpus are now corruption, not skipped, and strict reading
  stops at the first corrupt row; `validate_calibration_corpus_sanity` now requires `base_dir` (only
  caller updated); Z.ai's `test_skill_genesis_declared_surface_map.py` was not ported (A4-7).

### ARIA-MEDIUM-471 — declared-surface JSONL wrappers fall back to raw writes for undeclared paths

- **Z.ai IDs:** A20-3
- **Root cause on main:** Seven module wrappers fell back to raw `append_jsonl`/`load_jsonl` when a
  path matched no declared surface.
- **Fix:** They raise `<module>_append_unknown_surface` / `<module>_load_unknown_surface`.
  `pr_tracking` re-imports `GovernanceError`, which the repair stack had dropped.
- **Tests:** `test_jsonl_wrapper_unknown_surface.py`
- **Not done:** the per-module filename-to-surface tables remain (A20-2/E2-3 stub). This commit
  makes a table miss fail closed; it does not give the tables one owner.

### ARIA-LOW-472 — coverage gaps cite foreign refs; `capability_gap` copies observation paths

- **Z.ai IDs:** A5-7, A5-9
- **Root cause on main:** A coverage gap appended the pressure's whole ref list for every matching
  service, and `capability_gap` restated `observation_coverage` paths three times.
- **Fix:** Only the normalized in-service ref is appended, once, and the paths are imported.
- **Tests:** `test_coverage_gap_genesis.py`, `test_unobserved_surface_gap.py`
- **Not done:** `gap_id` hashing is unchanged.

### ARIA-MEDIUM-473 — pressure keeps a private surface table, a float weight and a laxer reader

- **Z.ai IDs:** A5-3, A5-8, A14-6, E3-3
- **Root cause on main:** `pressure` kept its own filename-to-surface table, a float weight in an
  int table, an unread decay tuple, and an override reader that accepted values the writer refuses.
- **Fix:** Wrappers resolve through `state_manifest.surface_for_path`, weights are ints, the dead
  tuple goes, and `_is_override_weight` is the one rule.
- **Tests:** `test_pressure_surface_routing.py`, `test_pressure_weight_overrides.py`
- **Not done:** Z.ai's other pressure.py hunks were not ported.

### ARIA-MEDIUM-474 — tp/fp counting copied in two calibration views

- **Z.ai IDs:** A3-4, A3-6 (A3-4: partly fixed on main, the rest fixed here)
- **Root cause on main:** The recommendation pass and the Beta-Binomial calibration each counted
  tp/fp, so they could disagree; `calibrated_intelligence.__all__` missed four public names; the
  bootstrap guide called keyword-only functions positionally.
- **Fix:** `calibration_dials.feedback_counts_by_dial` owns the count, `__all__` is complete, and
  the guide uses keywords. Main had fixed the attribution half (ARIA-HIGH-370).
- **Tests:** `test_calibrated_intelligence.py`

### ARIA-LOW-475 — own-PR scan files unfinished merges as green; `__all__` lists miss names

- **Z.ai IDs:** A3-9, A7-9, A8-7, A8-8
- **Root cause on main:** `scan_merged_own_prs` filed every non-red status as green, including
  merges with no or running main runs; `own_pr_ci` and `autonomy_ladder` left imported names out of
  `__all__`.
- **Fix:** Results are red, green or `not_green`; `test_module_export_surfaces` compares `__all__`
  with the AST public names.
- **Tests:** `test_module_export_surfaces.py`, `test_merge_discipline_battery.py`
- **Not done:** no kernel reader consumes merged['green'] beyond cycle.py storing the result (grep).

### ARIA-LOW-476 — evidence collector documents an unused rank and a random resnap

- **Z.ai IDs:** A6-6, A6-10
- **Root cause on main:** `DISCOVERY_METHOD_RANK` had no reader and only `regex` is minted;
  docstrings said the resnap is random while it takes first, middle and last.
- **Fix:** The rank is deleted, `discovered_by` is `Literal['regex']`, and the docstrings say
  deterministic.
- **Tests:** `test_evidence_collector_vocabulary.py`

### ARIA-LOW-477 — burn-in report reads the pressure log twice

- **Z.ai IDs:** A7-8
- **Root cause on main:** `run_observe_burn_in` read the pressure log in two places, which can
  straddle an append.
- **Fix:** It is loaded once and passed to both; the private writer and digest move to the ledger
  owners.
- **Tests:** `test_observe_burn_in.py`

### ARIA-LOW-478 — discovery's MFE allowlist misses messaging-module

- **Z.ai IDs:** A5-6
- **Root cause on main:** A hand-kept remote list lacked messaging-module, and discovery artifacts
  were written non-atomically.
- **Fix:** A direct child of `web/modules` is a leaf; artifacts go through
  `ledger.atomic_write_json`.
- **Tests:** `test_phase3_discovery_mfe.py`

### ARIA-LOW-479 — agent network index publishes a dispatch list that contradicts the whitelist

- **Z.ai IDs:** A2-9
- **Root cause on main:** `dispatchable_agents` (every agent outside `_maintenance`) was read only
  by a test and contradicted `DEFAULT_TARGET_AGENT_WHITELIST` both ways.
- **Fix:** The field is removed and the comment names the dispatch owner.
- **Tests:** `test_phase4_agent_network_invocations.py`
- **Not done:** Z.ai's `target_agent_whitelist` hunk was not ported.

### ARIA-LOW-480 — one malformed agent file aborts the agent satisfaction scan

- **Z.ai IDs:** A6-7, E3-2
- **Root cause on main:** Agent files were read unguarded, so one bad frontmatter failed the whole
  hook; a `.claude/agents.legacy/` skip could never match.
- **Fix:** Each agent is scanned through `batch_containment.guard_item`; an unreadable agent keeps
  its row and is not reported removed.
- **Tests:** `test_agent_satisfaction_scan.py`

### ARIA-LOW-481 — routing table parser turns prose rows and brace globs into prefixes

- **Z.ai IDs:** A2-10
- **Root cause on main:** `load_routing_table` split the whole pattern cell on commas, so prose rows
  and `{a,b}` globs became non-path prefixes.
- **Fix:** Prefixes come only from code spans, brace groups are cut, and a live-table test asserts
  every prefix is a path.
- **Tests:** `test_agent_routing.py`
- **Not done:** prose rows stay instructions to the LLM orchestrator by design.

### ARIA-MEDIUM-482 — `cost_budget` docstring cites removed ledgers and a downgrade it never does

- **Z.ai IDs:** A12-6, E6-2
- **Root cause on main:** The docstring cited removed daily/monthly ledgers, a profile
  auto-downgrade the code does not do, and restart state from removed files.
- **Fix:** The bullets describe derived usage, the spawn-time check, `telemetry_only` under a
  managed subscription and `breaker_state.json`; the private writer goes.
- **Not done:** the caps text and the two budget systems are untouched (A12-5 stub).

### ARIA-LOW-483 — trusted-gap threshold duplicated between writer and reader

- **Z.ai IDs:** A6-8
- **Root cause on main:** `trust_escalation_derive` and `trusted_gap_keys` each grouped sources and
  restated the threshold.
- **Fix:** `TRUSTED_GAP_MIN_SOURCES` and `_gap_source_groups` are shared.
- **Tests:** `test_phase2_remaining.py`
- **Not done:** Z.ai's comment text, which mis-described those rows, was not ported.

### ARIA-LOW-484 — product fitness turns a still-running lane red

- **Z.ai IDs:** A5-5
- **Root cause on main:** An in-progress newest run was recorded as running and then counted as
  failed.
- **Fix:** Running lanes are excluded from the failed list; a completed failure stays red.
- **Tests:** `test_product_fitness_charter.py`

### ARIA-MEDIUM-485 — pedagogy lint allowlist check can never match

- **Z.ai IDs:** A4-8, A17-4
- **Root cause on main:** `lint_agent_file` compared an absolute path with repo-relative keys, so it
  never matched; the allowlist and workflow comments named deleted workflows and a stale count.
- **Fix:** `run_pedagogy_lint` is the single match site; both comments name the live step and carry
  no count.
- **Tests:** `test_phase_v5_3_pedagogy_lint.py`

### ARIA-MEDIUM-486 — drafter banned-phrase list misses two CLAUDE.md phrases

- **Z.ai IDs:** A3-1, A20-4
- **Root cause on main:** `BANNED_PHRASES_DEFAULT` claimed to mirror CLAUDE.md but lacked two
  phrases.
- **Fix:** Both are appended and `test_i_v4_09` asserts equality with the CLAUDE.md section.
- **Tests:** `test_phase_v4_b_narrative_shape.py`

### ARIA-LOW-487 — draft validator docstring describes a section-scoped scan

- **Z.ai IDs:** A3-10
- **Root cause on main:** The `_scan_evidence_refs` docstring said it reads only target sections;
  the regex scans the whole body, which the lane classification relies on.
- **Fix:** The docstring states the whole-body scan and a test pins it.
- **Tests:** `test_draft_validator_refusal.py`
- **Not done:** docstring only; the scan itself is unchanged.

### ARIA-HIGH-488 — AutoActionGate docs claim merge gating through API that does not exist

- **Z.ai IDs:** A7-1
- **Root cause on main:** Docstrings said the gate is consumed by merges via `Gate.permit_merge` and
  `from_policy`; neither exists and merge never reads this gate.
- **Fix:** The docs name the real API and point merge authority at
  `merge_authority.merge_pr_if_ready`; I-V3-17e pins it.
- **Tests:** `test_phase_a4_gate_consolidation.py`
- **Not done:** the merge gate list is not restated here (its owner is the `merge_authority`
  docstring).

### ARIA-LOW-489 — `mint_signing_key` documents a FileExistsError it never raises

- **Z.ai IDs:** A8-9 (A8-9: partly fixed on main, the rest fixed here)
- **Root cause on main:** The docstring promised FileExistsError while the code returns an
  idempotent re-mint without signing config. Main had closed the unsigned-commit hazard; the false
  contract remained.
- **Fix:** The docstring states the real contract; tests pin that a re-mint carries no signing
  config and a second hold is refused.
- **Tests:** `test_phase_v9_0_c_gh_token_factory.py`, `test_implementation_identity_hold.py`
- **Not done:** Z.ai's re-wiring on re-mint was not ported, because it would let a second holder of
  one cycle's identity proceed.

### ARIA-MEDIUM-490 — kernel JSON files written by a dozen private copies; digests spelled inline

- **Z.ai IDs:** A11-4
- **Root cause on main:** About fifteen private writers (shared `.<name>.tmp`, no fsync: the
  ORPHAN-062 race) and ten inline canonical digests restated the ledger's format.
- **Fix:** All call `ledger.atomic_write_json` and `sha256_of_canonical_json` (byte-identical,
  pinned); AST gates forbid a private writer and an inline digest.
- **Tests:** `test_submit_claim_result_envelope_drift.py`, `test_faz_e_modules.py`,
  `test_rewrite_jsonl_safe_mode.py`
- **Not done:** about 40 direct non-atomic `write_text(json.dumps(...))` writes and 18 two-step
  digest sites are outside both gates (E11-2 stub); declared `rewrite_fsync` surfaces written
  through `atomic_write_json` bypass the profile gate (stub); the remaining private UTC helpers
  (E11-1 stub).

### ARIA-LOW-491 — readiness binding fields, incident events and digest checks restated

- **Z.ai IDs:** A3-5, A8-4, A8-5
- **Root cause on main:** The six merge-proof binding fields were tuple literals in four modules,
  `incident_ledger` accepted an event with no producer, and `_is_sha256_digest` had AST-identical
  copies.
- **Fix:** `READINESS_BINDING_FIELDS` and `INCIDENT_EVENTS` own them and `ledger.is_sha256_digest`
  is the one check; tests find one spelling each.
- **Tests:** `test_enterprise_readiness_and_genesis_lifecycle.py`, `test_incident_ledger.py`
- **Not done:** regex restatements of the digest shape (`contention_replay`, `autonomy_evidence`,
  experiment, `operator_request_terms`, preflight, `validation_runs_ledger`) remain (stub); refusal
  strings are unchanged.

### ARIA-HIGH-492 — PoC README overclaims the directory; prior-audit scan skips frontend drifts

- **Z.ai IDs:** A9-2, A9-6, A9-8, A9-10
- **Root cause on main:** The README called the whole directory LLM-free and listed 7 of 11 outputs;
  `scan_prior_audits` received only one drift kind; a helper had no caller.
- **Fix:** Claims are scoped to `poc.py`, every module is listed (including the repair stack's Z.ai
  tool loop), `drift_sides()` owns side selection, and the dead helper goes.
- **Tests:** `test_poc.py`
- **Not done:** Z.ai's DEBT re-dating and agent-count edits were not ported (A20-6 stub).

### ARIA-MEDIUM-493 — `seed_drift_findings` keeps a dead finding writer and an unused --out-dir

- **Z.ai IDs:** A9-5, E5-2
- **Root cause on main:** Findings are minted through the kernel, so the markdown writer, its id
  base and `--out-dir` were a dead second output path.
- **Fix:** They are deleted and the docstrings describe the kernel mint.
- **Tests:** `test_seed_drift_findings.py`, `test_seed_mint_migration.py`
- **Not done:** Z.ai's MintTests were not ported.

### ARIA-LOW-494 — `codex_runtime` docstrings claim a model-fallback integration

- **Z.ai IDs:** A13-3
- **Root cause on main:** Docstrings implied the Claude model fallback handles Codex.
- **Fix:** They say Codex runs on the native-runtime route and the fallback serves Anthropic and
  Z.ai only.
- **Not done:** docstrings only; no code change.

### ARIA-LOW-495 — executor contract proof names fable as the fail-safe model

- **Z.ai IDs:** A9-9
- **Root cause on main:** The proof showed `--model fable` while the resolver defaults are opus/max
  (operator decision 2026-09-12).
- **Fix:** The argv says opus, the prose names `DEFAULT_MODEL`/`DEFAULT_EFFORT`, and a test pins it.
- **Tests:** `test_phase_b1_argv_proven_workflow_hygiene.py`
- **Not done:** an adjacent item the fleet recorded for A9-9 is truncated in its output and is not
  covered here.

### ARIA-LOW-496 — kernel and executor comments cite stale line numbers

- **Z.ai IDs:** A1-6, A6-9, A12-7, E3-1, E6-1
- **Root cause on main:** 52 numeric locators in 32 files pointed at moved code; the `file_lock`
  docstring claimed the POSIX branch removes the side-car.
- **Fix:** Locators become symbols and `test_no_line_number_locators` scans the kernel and the PoC
  with no allowlist.
- **Tests:** `test_no_line_number_locators.py`
- **Not done:** locators whose target could not be identified (historical narratives) were dropped,
  not re-pointed.

### ARIA-HIGH-497 — .gitignore lists env file names instead of denying by default

- **Z.ai IDs:** A13-1
- **Root cause on main:** Only listed env names were ignored, so a backup such as `.env.bak-*` or a
  new stage could be committed.
- **Fix:** Deny by default (`.env`, `.env.*`, `*.env`) with the templates re-included; a spec pins
  both directions with `git check-ignore`.
- **Tests:** `env-files-ignored.spec.ts`

### ARIA-MEDIUM-498 — agent roster docs and the cardinality gate disagree with the lanes

- **Z.ai IDs:** A18-3, A18-4, A18-5, A18-7, A18-8
- **Root cause on main:** README paths, the lane list (no db-audit), the Lane-A count and the
  auxiliary-tool intro disagreed with the lane definitions, and Lane-B names were enumerated twice.
- **Fix:** The docs are corrected, one roster parser in `helpers/orchestrator-roster.ts` serves
  three specs, and `agent-doc-shape` gains derived checks.
- **Tests:** `agent-doc-shape.spec.ts`, `doc-cardinality.spec.ts`, `maintenance-isolation.spec.ts`,
  `orchestrator-routing-coverage.spec.ts`
- **Not done:** root CLAUDE.md:172 still lists the lanes without Lane-D (Tier-4 operator file);
  pre-existing Prettier debt in these specs is untouched.

### ARIA-HIGH-499 — CONTRACTS.md restates kernel vocabularies that have changed

- **Z.ai IDs:** A14-1, A14-3, A14-4, A14-5, A14-7, A14-8, A14-9, A20-7, E7-1
- **Root cause on main:** CONTRACTS restated hook orders, claim types, feedback sources, ledgers,
  snapshot modes and counters that had since changed, and taught a debt `Closes:` form the trailer
  gate rejects.
- **Fix:** Each passage names its owner symbol, JUDGE-DIGEST is regenerated, and parity tests plus a
  trailer test pin them.
- **Tests:** `test_contracts_mirror_code.py`, `test_judge_digest_ssot.py`,
  `commit-msg-validator.spec.ts`
- **Not done:** the CONTRACTS length budget is untouched (A15-8/E7-2 stub).

### ARIA-HIGH-500 — live ARIA docs contradict the code; CLI floor written in four places

- **Z.ai IDs:** A13-2, A14-2, A15-1, A15-2, A15-4, A15-5, A15-6, A15-9, A15-10, A16-3, A16-5, A16-6,
  A16-7, A16-8, A17-1, A17-3, E8-1
- **Root cause on main:** IDENTITY taught a `snowball` base, docs carried agent counts and drifted
  anchors, lane prose copied cron times, and the Claude CLI floor was a literal in four places.
- **Fix:** The docs defer to owners, `.github/manifests/aria-claude-floor.json` owns the floor (read
  by `doctor.claude_cli_version_floor`), and specs derive the live-doc list and pin clock-free
  prose.
- **Tests:** `aria-doc-runtime-ssot.spec.ts`, `test_findings_location_doc_parity.py`,
  `test_doctor.py`, `test_phase_v12_g_mcp.py`, `aria-external-watchdog-contract.spec.ts`
- **Not done:** MISSION.md (A15-3) and the length budgets (A15-8/E7-2) are stubs; BEHAVIOUR.md's
  dated measurement is untouched; the lane composite actions (A17-2/A17-6) are stubs.

### ARIA-HIGH-501 — dated ARIA reports present superseded facts

- **Z.ai IDs:** A16-1, A16-2, A16-9
- **Root cause on main:** The v10.4 closure report cited retired findings and wrong counts; the v3
  one-way-door decisions stated the `snowball` base in the present tense.
- **Fix:** Both keep their history and gain dated corrections and a SUPERSEDED block.
- **Not done:** nothing was written to aria-findings/ or aria/state.

## Commits without a finding

- `refactor(aria-kernel)`: delete caller-less kernel code: `db_snapshot`, a fitness helper, a text
  hash and an import. Z.ai IDs: A5-4, A6-5, A12-8, A19-3.
- `test(aria-kernel)`: add direct unit tests for `batch_containment`, `cycle_diff`,
  `draft_pii_filter`, `evidence_collector` and `phase2_utils`. Z.ai IDs: A19-4.
- `test(aria-kernel)`: move the stray kernel-root test module under tests/ and fix a dead test
  cross-reference. Z.ai IDs: A11-9, A12-10, A19-2, A19-6.

A19-4 was decided `RECORD_STUB`, but the sweep implemented it: its unit tests are the second commit
above, and the `incident_ledger` tests land with ARIA-LOW-491.

## Integration with the repair stack

Five files conflicted. Each resolution keeps both sides: doctor.py imports `json` (wave 1) and `os`
(repair); `human_required.py` imports `published_text` and `state_transaction`;
`skill_genesis_drainer.py` keeps `materialize_drafted_adapter` and the drainer policy reader;
`skill_genesis_sandbox.py` is the union of the repair binding and dynamic-import checks with the
relative-import refusal (ARIA-MEDIUM-469); and `test_phase_v9_0_e_sandbox.py` imports
`os.path as osp`, because ARIA-HIGH-414 refuses the plain form on purpose.

Integration edits outside the conflicts: `pr_tracking.py` re-imports `GovernanceError` (the repair
stack dropped it; wave 1 raises it); `tools/aria-poc/genesis_adapter_launcher.py` uses
`importlib.import_module` (ARIA-HIGH-470 bans `__import__`; same loaded module set under default,
`-S` and `-I`); `test_enterprise_ci_loop.py` reads the production fold (ARIA-MEDIUM-450); and the
PoC README lists the repair stack's new modules (ARIA-HIGH-492).

The integration gate also found defects that the repair stack carried before wave 1 landed: no
truth-table row for ARIA-CRITICAL-446, no review narrative for ARIA-HIGH-441 and ARIA-LOW-447, and
markdownlint debt in its review docs. They are fixed in a separate `chore(reviews)` commit, because
their owner is the repair stack, not this port.

## Z.ai ID dispositions

| Z.ai ID | Disposition           | Evidence or fix topic                                        |
| ------- | --------------------- | ------------------------------------------------------------ |
| A1-1    | ARIA-MEDIUM-452       | one ack mint body, encoder and field set                     |
| A1-2    | RECORD_STUB (wave 2)  | `StateSurface.index_group` is a dead field                   |
| A1-3    | ARIA-MEDIUM-451       | one JSONL decode loop for both readers                       |
| A1-4    | ARIA-LOW-449          | ledger owns JSON writes, digests, digest shape               |
| A1-5    | ARIA-MEDIUM-452       | one ack mint body, encoder and field set                     |
| A1-6    | ARIA-LOW-496          | comments cite symbols, not line numbers                      |
| A1-7    | ARIA-LOW-449          | ledger owns JSON writes, digests, digest shape               |
| A1-8    | ARIA-MEDIUM-452       | one ack mint body, encoder and field set                     |
| A1-9    | ARIA-LOW-449          | ledger owns JSON writes, digests, digest shape               |
| A1-10   | ARIA-MEDIUM-452       | one ack mint body, encoder and field set                     |
| A2-1    | ALREADY_FIXED_ON_MAIN | `maintenance_utility` is dispatchable (ARIA-HIGH-344)        |
| A2-2    | RECORD_STUB (wave 2)  | request mint lets unpaired roles target any agent            |
| A2-3    | ARIA-MEDIUM-462       | cross reviewer whitelisted; dead state copies gone           |
| A2-4    | ARIA-MEDIUM-464       | refusals graded by the producer's own inverse                |
| A2-5    | ARIA-MEDIUM-465       | `agent_resolver` everywhere; `VALID_MODELS` derived          |
| A2-6    | ARIA-MEDIUM-458       | CLI choices bound to their kernel owners                     |
| A2-7    | ALREADY_FIXED_ON_MAIN | `gap_finding` and `gap_closure` removed and pinned           |
| A2-8    | ARIA-MEDIUM-464       | refusals graded by the producer's own inverse                |
| A2-9    | ARIA-LOW-479          | unread `dispatchable_agents` field dropped                   |
| A2-10   | ARIA-LOW-481          | routing prefixes only from code-span globs                   |
| A3-1    | ARIA-MEDIUM-486       | drafter banned phrases equal CLAUDE.md's                     |
| A3-2    | ARIA-MEDIUM-468       | genesis policy from the bound workspace                      |
| A3-3    | ARIA-MEDIUM-468       | genesis policy from the bound workspace                      |
| A3-4    | ARIA-MEDIUM-474       | partly fixed on main; rest fixed here                        |
| A3-5    | ARIA-LOW-491          | binding fields, incident events, digest check once           |
| A3-6    | ARIA-MEDIUM-474       | one tp/fp count per dial                                     |
| A3-7    | ARIA-MEDIUM-468       | genesis policy from the bound workspace                      |
| A3-8    | RECORD_STUB (wave 2)  | `agent_eval` `false_positive_rate` is always 0               |
| A3-9    | ARIA-LOW-475          | merged own PRs: red, green or `not_green`                    |
| A3-10   | ARIA-LOW-487          | target-path scan documented as whole-body                    |
| A4-1    | RECORD_STUB (wave 2)  | phase-2 skill sandbox runs a drafter-supplied path           |
| A4-2    | RECORD_STUB (wave 2)  | adapter import check and signature check not wired           |
| A4-3    | ARIA-HIGH-470         | grounded rule gate runs; corpora read strictly               |
| A4-4    | RECORD_STUB (wave 2)  | `validate_generated_adapter` has no caller                   |
| A4-5    | ALREADY_FIXED_ON_MAIN | `narrative_prompt_validator` caps match its table            |
| A4-6    | ARIA-HIGH-470         | grounded rule gate runs; corpora read strictly               |
| A4-7    | RECORD_STUB (wave 2)  | `skill_genesis` surface table lacks request-status.jsonl     |
| A4-8    | ARIA-MEDIUM-485       | pedagogy allowlist matched once by relative path             |
| A4-9    | ARIA-HIGH-470         | grounded rule gate runs; corpora read strictly               |
| A4-10   | ARIA-MEDIUM-469       | sandbox refuses relative imports; deny first                 |
| A5-1    | ALREADY_FIXED_ON_MAIN | mission.py calls `require_capability_resolution`             |
| A5-2    | ARIA-MEDIUM-456       | `memory_gap` docstring names the live recovery half          |
| A5-3    | ARIA-MEDIUM-473       | pressure resolves surfaces from the manifest                 |
| A5-4    | fixed, no finding     | dead kernel code deleted (refactor commit)                   |
| A5-5    | ARIA-LOW-484          | a running lane is unknown, never red                         |
| A5-6    | ARIA-LOW-478          | MFE rule derived from web/modules layout                     |
| A5-7    | ARIA-LOW-472          | gaps cite only in-service refs                               |
| A5-8    | ARIA-MEDIUM-473       | pressure resolves surfaces from the manifest                 |
| A5-9    | ARIA-LOW-472          | gaps cite only in-service refs                               |
| A5-10   | INVALID               | aria-tools untracked; the patches delete runtime lock files  |
| A6-1    | RECORD_STUB (wave 2)  | readiness v3 predicate needs a contract nobody mints         |
| A6-2    | ARIA-MEDIUM-450       | tests read the production capability fold                    |
| A6-3    | ALREADY_FIXED_ON_MAIN | `EVIDENCE_REF_RE` has no triplet (ARIA-HIGH-195)             |
| A6-4    | ALREADY_FIXED_ON_MAIN | globs verified only when every match resolves at baseline    |
| A6-5    | fixed, no finding     | dead kernel code deleted (refactor commit)                   |
| A6-6    | ARIA-LOW-476          | evidence vocabulary and resnap docs match code               |
| A6-7    | ARIA-LOW-480          | per-agent containment in the satisfaction scan               |
| A6-8    | ARIA-LOW-483          | one trusted-gap threshold and grouping                       |
| A6-9    | ARIA-LOW-496          | comments cite symbols, not line numbers                      |
| A6-10   | ARIA-LOW-476          | evidence vocabulary and resnap docs match code               |
| A7-1    | ARIA-HIGH-488         | AutoActionGate docs scoped to materialization                |
| A7-2    | ARIA-MEDIUM-461       | `HUMAN_REQUIRED` writes are governed and gated               |
| A7-3    | ALREADY_FIXED_ON_MAIN | `set_profile` requires operator approval (ARIA-CRITICAL-216) |
| A7-4    | ARIA-MEDIUM-466       | jest reads the write tier from python                        |
| A7-5    | INVALID               | two SLA tables are two concepts (both renamed anyway)        |
| A7-6    | ARIA-MEDIUM-467       | recording reads fail closed; one PR-field reader             |
| A7-7    | ARIA-MEDIUM-465       | `agent_resolver` everywhere; `VALID_MODELS` derived          |
| A7-8    | ARIA-LOW-477          | burn-in reads the pressure log once                          |
| A7-9    | ARIA-LOW-475          | merged own PRs: red, green or `not_green`                    |
| A7-10   | ARIA-MEDIUM-461       | `HUMAN_REQUIRED` writes are governed and gated               |
| A8-1    | ARIA-MEDIUM-467       | recording reads fail closed; one PR-field reader             |
| A8-2    | ARIA-MEDIUM-467       | recording reads fail closed; one PR-field reader             |
| A8-3    | RECORD_STUB (wave 2)  | PR identity key tuples spread across modules                 |
| A8-4    | ARIA-LOW-491          | binding fields, incident events, digest check once           |
| A8-5    | ARIA-LOW-491          | binding fields, incident events, digest check once           |
| A8-6    | ARIA-MEDIUM-467       | recording reads fail closed; one PR-field reader             |
| A8-7    | ARIA-LOW-475          | merged own PRs: red, green or `not_green`                    |
| A8-8    | ARIA-LOW-475          | merged own PRs: red, green or `not_green`                    |
| A8-9    | ARIA-LOW-489          | partly fixed on main; rest fixed here                        |
| A8-10   | ALREADY_FIXED_ON_MAIN | `_changed_file_path` uses `canonical_path` (one normalizer)  |
| A9-1    | ALREADY_FIXED_ON_MAIN | outbox-adapter `tool_id` matches its file (ARIA-MEDIUM-377)  |
| A9-2    | ARIA-HIGH-492         | PoC README scoped; prior-audit scan complete                 |
| A9-3    | ARIA-MEDIUM-463       | dead executor claim entry and mock parser deleted            |
| A9-4    | ARIA-MEDIUM-463       | dead executor claim entry and mock parser deleted            |
| A9-5    | ARIA-MEDIUM-493       | `seed_drift_findings` dead writer dropped                    |
| A9-6    | ARIA-HIGH-492         | PoC README scoped; prior-audit scan complete                 |
| A9-7    | INVALID               | no tracked pycache/.mimosa under tools/aria-poc              |
| A9-8    | ARIA-HIGH-492         | PoC README scoped; prior-audit scan complete                 |
| A9-9    | ARIA-LOW-495          | contract proof names opus/max defaults                       |
| A9-10   | ARIA-HIGH-492         | PoC README scoped; prior-audit scan complete                 |
| A10-1   | RECORD_STUB (wave 2)  | worker-lane merge path blocked but documented as merging     |
| A10-2   | ARIA-HIGH-460         | worker killed inside its lease; one lease owner              |
| A10-3   | ARIA-HIGH-460         | worker killed inside its lease; one lease owner              |
| A10-5   | ARIA-HIGH-460         | worker killed inside its lease; one lease owner              |
| A10-6   | ARIA-MEDIUM-459       | only cancelled or expired work is re-dispatched              |
| A10-7   | ARIA-LOW-457          | same host always refreshes its own lease                     |
| A10-8   | ARIA-HIGH-460         | worker killed inside its lease; one lease owner              |
| A10-9   | ARIA-MEDIUM-459       | only cancelled or expired work is re-dispatched              |
| A10-10  | INVALID               | no tracked `.pyc/__pycache__`; .gitignore covers them        |
| 10-A4   | ARIA-MEDIUM-459       | only cancelled or expired work is re-dispatched              |
| A11-1   | ALREADY_FIXED_ON_MAIN | dormant waivers renewed to 2026-10-20 (ORPHAN-HIGH-573)      |
| A11-2   | RECORD_STUB (wave 2)  | TS adapter `db_snapshot` check reads an unproduced snapshot  |
| A11-3   | ARIA-MEDIUM-453       | state surfaces refuse out-of-vocabulary values               |
| A11-4   | ARIA-MEDIUM-490       | every JSON write and digest via ledger owners                |
| A11-5   | INVALID               | aria-tools is untracked and ignored; patches hit lock files  |
| A11-6   | ARIA-MEDIUM-454       | compaction parses stamps through the UTC owner               |
| A11-7   | ALREADY_FIXED_ON_MAIN | `tool_registry` `TOOL_STATUSES` trimmed (ORPHAN-MEDIUM-839)  |
| A11-8   | INVALID               | snapshot status passes no --ignored                          |
| A11-9   | fixed, no finding     | stray test module moved (test commit)                        |
| A12-1   | RECORD_STUB (wave 2)  | in-kernel LLM cost never reaches the cost ledger             |
| A12-2   | CODE_GONE_ON_MAIN     | `external_outage_reaper.py` does not exist (ARIA-HIGH-366)   |
| A12-3   | ARIA-MEDIUM-455       | per-cycle preflight runs through the profile gate            |
| A12-4   | RECORD_STUB (wave 2)  | dispatch-rationale telemetry called only by tests            |
| A12-5   | RECORD_STUB (wave 2)  | two USD budget systems with separate caps                    |
| A12-6   | ARIA-MEDIUM-482       | `cost_budget` docstring matches derived usage                |
| A12-7   | ARIA-LOW-496          | comments cite symbols, not line numbers                      |
| A12-8   | fixed, no finding     | dead kernel code deleted (refactor commit)                   |
| A12-9   | ARIA-MEDIUM-455       | per-cycle preflight runs through the profile gate            |
| A12-10  | fixed, no finding     | stray test module moved (test commit)                        |
| A13-1   | ARIA-HIGH-497         | .env variants ignored by default                             |
| A13-2   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A13-3   | ARIA-LOW-494          | `codex_runtime` docstrings corrected                         |
| A13-4   | ALREADY_FIXED_ON_MAIN | every .claude/allowlists yaml has a tracked consumer spec    |
| A13-5   | CODE_GONE_ON_MAIN     | no aria-agent-outputs dump exists or is produced             |
| A13-6   | ARIA-MEDIUM-451       | one JSONL decode loop for both readers                       |
| A13-7   | RECORD_STUB (wave 2)  | ARIA-MIMARI-SEMALARI.md lacks a subordination notice         |
| A13-8   | ALREADY_FIXED_ON_MAIN | patch-konsta.cjs removed (bb495c0ee) and its absence pinned  |
| A14-1   | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| A14-2   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A14-3   | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| A14-4   | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| A14-5   | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| A14-6   | ARIA-MEDIUM-473       | pressure resolves surfaces from the manifest                 |
| A14-7   | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| A14-8   | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| A14-9   | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| A14-10  | INVALID               | no tracked .mimosa/pycache files, on main or 43f0aa3bf       |
| A15-1   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A15-2   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A15-3   | RECORD_STUB (wave 2)  | MISSION.md forbids self-merge; `MISSION_SPEC` defines one    |
| A15-4   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A15-5   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A15-6   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A15-7   | RECORD_STUB (wave 2)  | instruction-framing field list has three owners              |
| A15-8   | RECORD_STUB (wave 2)  | ARIA doc length budgets stated but unenforced                |
| A15-9   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A15-10  | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A16-1   | ARIA-HIGH-501         | dated corrections in two ARIA reports                        |
| A16-2   | ARIA-HIGH-501         | dated corrections in two ARIA reports                        |
| A16-3   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A16-4   | ARIA-MEDIUM-462       | cross reviewer whitelisted; dead state copies gone           |
| A16-5   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A16-6   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A16-7   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A16-8   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A16-9   | ARIA-HIGH-501         | dated corrections in two ARIA reports                        |
| A16-10  | RECORD_STUB (wave 2)  | autonomy matrix rows expired; cite absent classes            |
| A17-1   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A17-2   | RECORD_STUB (wave 2)  | Claude preflight and lease checks duplicated per lane        |
| A17-3   | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| A17-4   | ARIA-MEDIUM-485       | pedagogy allowlist matched once by relative path             |
| A17-5   | ALREADY_FIXED_ON_MAIN | `ARIA_EXECUTOR_PR_VIA_KERNEL` only in tombstones; pinned     |
| A17-6   | RECORD_STUB (wave 2)  | nine x-access-token mint sites across workflows              |
| A17-7   | INVALID               | no tracked .pyc; lanes set PYTHONDONTWRITEBYTECODE           |
| A17-8   | CODE_GONE_ON_MAIN     | aria-kernel-fast/-full workflows gone (INFRA-HIGH-215)       |
| A18-1   | ALREADY_FIXED_ON_MAIN | `KERNEL_STAMPED_DELIVERY_FIELDS` owns the delivery fields    |
| A18-2   | INVALID               | agent-dispatch-gate reads .dispatch-log.jsonl by design      |
| A18-3   | ARIA-MEDIUM-498       | roster docs and gates follow the lanes                       |
| A18-4   | ARIA-MEDIUM-498       | roster docs and gates follow the lanes                       |
| A18-5   | ARIA-MEDIUM-498       | roster docs and gates follow the lanes                       |
| A18-6   | ARIA-MEDIUM-462       | cross reviewer whitelisted; dead state copies gone           |
| A18-7   | ARIA-MEDIUM-498       | roster docs and gates follow the lanes                       |
| A18-8   | ARIA-MEDIUM-498       | roster docs and gates follow the lanes                       |
| A18-9   | RECORD_STUB (wave 2)  | Lane-A prompts keep hand lists of 'active findings'          |
| A19-1   | RECORD_STUB (wave 2)  | autonomy-closure policy cites 17 missing tests               |
| A19-2   | fixed, no finding     | stray test module moved (test commit)                        |
| A19-3   | fixed, no finding     | dead kernel code deleted (refactor commit)                   |
| A19-4   | fixed, no finding     | direct unit tests added (test commit)                        |
| A19-5   | RECORD_STUB (wave 2)  | orchestrator happy-path fakes duplicated in tests            |
| A19-6   | fixed, no finding     | stray test module moved (test commit)                        |
| A19-7   | RECORD_STUB (wave 2)  | dormant `llm_bridge` amplification lane is test-only         |
| A19-8   | INVALID               | `__pycache__` ignored and absent; bytecode writes disabled   |
| A19-9   | INVALID               | .mimosa/ ignored and absent                                  |
| A20-1   | ALREADY_FIXED_ON_MAIN | reachability waivers in date (2026-10-20, 2026-11-20)        |
| A20-2   | RECORD_STUB (wave 2)  | twelve modules keep their own surface tables                 |
| A20-3   | ARIA-MEDIUM-471       | undeclared JSONL paths refused                               |
| A20-4   | ARIA-MEDIUM-486       | drafter banned phrases equal CLAUDE.md's                     |
| A20-5   | RECORD_STUB (wave 2)  | overdue ARIA debts are not surfaced                          |
| A20-6   | RECORD_STUB (wave 2)  | PoC README proto-debts overdue, outside the ledger           |
| A20-7   | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| A20-8   | INVALID               | `__pycache__` ignored; an orphan .pyc is not imported        |
| A20-9   | ALREADY_FIXED_ON_MAIN | `tools_dir` has no CWD shadow root                           |
| A20-10  | ARIA-MEDIUM-468       | genesis policy from the bound workspace                      |
| E1-1    | ARIA-MEDIUM-452       | one ack mint body, encoder and field set                     |
| E2-1    | ARIA-HIGH-470         | grounded rule gate runs; corpora read strictly               |
| E2-2    | ARIA-MEDIUM-469       | sandbox refuses relative imports; deny first                 |
| E2-3    | RECORD_STUB (wave 2)  | five copied `_declared_surface_name` functions (A20-2)       |
| E2-4    | ARIA-HIGH-470         | grounded rule gate runs; corpora read strictly               |
| E3-1    | ARIA-LOW-496          | comments cite symbols, not line numbers                      |
| E3-2    | ARIA-LOW-480          | per-agent containment in the satisfaction scan               |
| E3-3    | ARIA-MEDIUM-473       | pressure resolves surfaces from the manifest                 |
| E4-1    | ALREADY_FIXED_ON_MAIN | `normalize_repo_relpath` is the owner (ARIA-HIGH-186)        |
| E4-2    | ARIA-MEDIUM-467       | recording reads fail closed; one PR-field reader             |
| E5-1    | ARIA-HIGH-460         | worker killed inside its lease; one lease owner              |
| E5-2    | ARIA-MEDIUM-493       | `seed_drift_findings` dead writer dropped                    |
| E5-3    | INVALID               | .mimosa/ ignored; runtime artifacts listed as excluded       |
| E6-1    | ARIA-LOW-496          | comments cite symbols, not line numbers                      |
| E6-2    | ARIA-MEDIUM-482       | `cost_budget` docstring matches derived usage                |
| E7-1    | ARIA-HIGH-499         | CONTRACTS mirrors kernel vocabularies                        |
| E7-2    | RECORD_STUB (wave 2)  | CONTRACTS/IDENTITY over budget (same as A15-8)               |
| E8-1    | ARIA-HIGH-500         | live docs, CLI floor and lane clocks owned once              |
| E10-1   | INVALID               | pycache ignored (.gitignore:82); none tracked                |
| E10-2   | ALREADY_FIXED_ON_MAIN | aria-suite-run.sh keeps the repo path for invariants         |
| E10-3   | ALREADY_FIXED_ON_MAIN | suite selection delegated to aria-import-graph.py            |
| E11-1   | RECORD_STUB (wave 2)  | private UTC-now helpers remain (partial)                     |
| E11-2   | RECORD_STUB (wave 2)  | canonical json.dumps still spelled at many sites (partial)   |
| E11-3   | ARIA-MEDIUM-467       | recording reads fail closed; one PR-field reader             |
| E11-4   | RECORD_STUB (wave 2)  | inline 'sha256:' + hashlib idiom at 129 sites                |
| E12-1   | ALREADY_FIXED_ON_MAIN | `maintenance_utility` dispatchable; arc checked at import    |
