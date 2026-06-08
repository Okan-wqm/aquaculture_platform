<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 017: Operationalization + Traceability

## Summary

Plan 016 v3.1 shipped the bound-agent execution platform structurally (19 commits, 443 tests, end-to-end CLI surface). The 2026-05-07 operator review found the platform structurally complete but operationally unproven — the live snowball aria-tools state held only Faz 0 + Faz A artefacts, every Faz C/D/E/F runtime directory was empty, three architectural debts were unrecorded, and four process gaps remained. Plan 017 closes those gaps in a controlled, traceable sequence: every gate fire emits a hash-chained governance event, every phase has a hard acceptance gate, and every architectural shortfall lands as a DEBT record with owner + due-date instead of as a silent concession.

## Key Changes

### Process debt closure (Phase 1)

- Husky `commit-msg` Closes-trailer regex extends to recognise `Closes: aria-findings/F-NNN` and `Closes: aria-debts/DEBT-YYYY-MM-DD-NNN`. Existing UH-/ORPHAN-/registry findings continue to validate unchanged.
- Husky `pre-push` adds a banned-phrase scan over `aria-findings/`, `aria-debts/`, and `aria-tools/reports/`. `docs/aria/reviews/**` enters EXEMPT_PATHS so review documents may quote the banned phrase list.

### Architectural debt records (Phase 2)

Three debts identified by the Plan 016 operator review move from prose to ledger rows under `aria-debts/`:

- **DEBT-2026-05-07-002** (MEDIUM, ≤90d) — four impact-graph sources (event_contract, graphql_api, db_entity, frontend_module) currently emit `status: unknown` stubs in `aria_kernel/recursive_impact.py:294-305`. Permanent fix: replace each stub with a real producer/consumer mapping.
- **DEBT-2026-05-07-003** (MEDIUM, ≤90d) — nine adapter rows in `aria-tools/registry.json` share `tools/aria-poc/shadow_runner.py` as their runner argv. Permanent fix: per-adapter Python parser + registry runner.argv switch.
- **DEBT-2026-05-07-004** (HIGH, ≤60d) — `aria_kernel/pr_manager.py:101-107` runs `subprocess.run gh api` calls with zero test coverage. Phase 3 closes this debt with a mock gh API integration test.

### Operationalization (Phases 3-5)

- **PR pipeline integration test**: `aria_kernel/apply_engine.py:50-79` `gate_apply_action` gains an optional `diff_text` kwarg routed through `suppression_scanner.scan_unified_diff_text`. `aria_kernel/pr_manager.py` rejects PR creation when `base != "snowball"`. New test `aria-kernel/tests/test_pr_manager_e2e.py` walks the full open_pr_for_action flow under a mock gh API factory in `aria-kernel/tests/_gh_mock.py`.
- **Live e2e walkthrough**: F-001 (the sole snowball finding) seeds two judge request envelopes — evidence_judgment + adversarial_judgment. The operator picks them up via Claude Code subagent invocations, submits responses, runs `aria-kernel consensus run`. Acceptance: `aria-tools/agent-invocations/{requests,claims,results}.jsonl` carry ≥2 rows each, `aria-tools/governance.jsonl` carries `agent_claim_created`, `agent_result_accepted`, `agent_consensus_computed` events, and the dashboard's nine Plan 016 counters shift from zero.
- **First real adapter + impact source**: `tools/aria-poc/banned_phrase_adapter.py` wraps the existing `tools/gates/banned-phrase.ts` Node CLI as an ARIA adapter, partially closing DEBT-2026-05-07-003. `aria_kernel/recursive_impact.py` replaces the `_event_contract_source` stub with a real mapping over `libs/event-contracts/src/**/*.ts`, partially closing DEBT-2026-05-07-002.

### Traceability hardening (Phase 6)

- **Review record CLI**: new `aria_kernel/review_record.py` module + `aria-kernel review {record,list}` sub-command. Each record persists to `aria-tools/reviews.jsonl` (append-only, hash-chained) and emits a `review_recorded` governance event so operator audits cannot drift silently.
- **Gate Activity in daily report**: `aria_kernel/reflection.py` `_write_daily_report` adds a Gate Activity section that aggregates governance event counts by kind for the cycle window.
- **Gate Activity in dashboard**: `aria_kernel/plan_016_metrics.py` `render_dashboard_markdown` adds a Gate Activity (24h) section so the operator sees gate-fire frequency next to the nine Plan 016 counters.

## Acceptance

- Husky commit-msg + pre-push gates accept ARIA artefact references and reject malformed ones. Unit tests cover both directions.
- `aria-debts/_index.json` carries four records: the original DEBT-2026-05-07-001 plus DEBT-2026-05-07-002, -003, -004. Three new `debt_emitted` governance events appear on the chain.
- `aria-kernel/tests/test_pr_manager_e2e.py` passes with ≥5 cases. The full kernel regression count rises by ≥22 over the 443 baseline.
- `aria-tools/agent-invocations/{requests,claims,results}.jsonl` each carry ≥2 rows after Phase 4. The dashboard reflects the metric movement.
- `tools/aria-poc/banned_phrase_adapter.py` runs in SHADOW and emits at least one observation when invoked over a non-empty diff. The recursive impact graph emits at least one `known` entry from the event_contract source.
- `aria-kernel review record` + `aria-kernel review list` round-trip a synthetic record. Daily report 2026-05-07 (regenerated against the Phase 6 reflection.py writer) shows the Gate Activity section. Dashboard.md shows the Gate Activity (24h) counters.
- Two of three new DEBT records show `status: IN_PROGRESS`; DEBT-2026-05-07-004 shows `status: RESOLVED` after Phase 3 lands.
- The closing operator review at `docs/aria/reviews/2026-05-08-plan-017-implementation-review.md` confirms each phase against the live ledger.
- Origin/snowball matches local at the end of Phase 7. No force push, no main push.

## Assumptions

- The husky hook extension preserves the existing UH-/ORPHAN-/registry behaviour. Trailer routing keeps `aria-findings/F-NNN` and `aria-debts/DEBT-YYYY-MM-DD-NNN` distinct from the registry-routed prefixes.
- The Phase 4 walkthrough is operator-supervised. Claude Code sub-agent invocations stay deterministic relative to the request envelope. Real LLM cost is bounded by the existing budget gate; no new cost ceiling is introduced.
- Mock gh API tests rely on `unittest.mock.patch('subprocess.run', ...)`. Real gh CLI usage stays out of the test suite; integration smoke testing happens manually during Phase 4.
- Plan 017 is the operationalisation arc for Plan 016. It does not modify SPEC.md, IDENTITY.md, CONTRACTS.md, or ROADMAP.md. Future spec drift lands in a separate plan document.
