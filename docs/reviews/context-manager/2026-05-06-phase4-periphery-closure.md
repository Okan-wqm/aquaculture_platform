# ARIA Phase-4 Periphery Closure (Phase-4.1)

**Cycle:** 2026-05-06-phase4-periphery-closure
**Branch:** snowball
**Reviewer:** context-manager
**Plan reference:** docs/aria/plans Phase-4 v9.4 + Phase-4.1 (`/root/.claude/plans/ben-mplement-ett-m-son-cosmic-pillow.md`)
**Predecessor commit:** `7e1cea08 chore(aria): add phase 4 agent convergence loop`

## Scope

Phase-4 commit `7e1cea08` (1760 satır, 14 dosya) convergence çekirdeğini production-ready ship etti
(203/203 test pass). Ancak operasyonel periphery'de plan v9.4'e karşı **6 missing/stub + 3 plan
deviation** kaldı; bu doğrudan `needs_review` triage tier'ında otonom genesis loop'unun
çalışmamasına neden oluyordu. Bu PR Phase-4.1 olarak gap'i kapatır.

## Findings

### ULTRA-HIGH-079 — Phase-4 periphery: 2 hook stub + 4 missing + 3 plan deviation

**Severity:** HIGH
**State:** RESOLVED (closed by Phase-4.1 commit)
**Layer:** 3

**Evidence (commit `7e1cea08` öncesi):**
- `aria-kernel/aria_kernel/learning.py:103-104` — `_impact_graph_compute` stub: hep
  `{"status": "skipped", "reason": "no_active_dispatch_candidate"}` döner; `plan_downstream_impact`
  modülü hook'tan çağrılmıyor.
- `aria-kernel/aria_kernel/learning.py:108-113` — `_skill_or_agent_genesis` stub: sadece
  actionable gap counting + `request_generation: "operator_mediated"` yazısı; request row
  yazmıyor, genesis_policy gating yok.
- `aria-kernel/aria_kernel/triage.py:35-42` — fitness 7-day staleness routing tier downgrade yok;
  sadece QUARANTINED + CALIBRATE override mevcut.
- `aria-kernel/aria_kernel/agent_invocations.py:108-116` — `list_agent_invocation_requests`
  sadece 3 filter (state, convergence_id, target_agent); plan v9.4: 5 filter (+ request_id, role).
- `aria-kernel/aria_kernel/skill_genesis.py:64-65` — `sandbox_skill` sadece JSON
  `checklist_results` array length≥3 kabul; plan v9.4: `## Fixture: <id>` markdown blocks parse.
- `aria-kernel/aria_kernel/plan_convergence.py:756, 935` — `record_cross_review`
  `review_content_hash` operator-provided; plan v9.4: ARIA file bytes hash compute when
  submitted via CLI.
- `aria-kernel/aria_kernel/plan_convergence.py:819` — `submit_challenger_plan` guard
  `{DRAFT, REVISED}` (plan v9.4: only DRAFT). İmplementer extension: REVISED → submit_challenger
  → CHALLENGER_DRAFTED transition cross-review re-do path enable eder. Plan'a aykırı ama
  doğru extension.
- `aria-config/genesis_policy.json` mevcut değil + reader yok — operator opt-out yolu kapalı.
- `docs/reviews/_registry/findings.jsonl` — Phase-4 commit için ULTRA-HIGH-079 finding ID
  kaydı yoktu; commit message `Closes:` trailer'ı yoktu.

**Rule violated:** Phase-4 v9.4 plan Sprint 4D/4E/4F operasyonel hook + genesis policy
contract; CLAUDE.md Closes-trailer + finding registry traceability mandatory.

**Impact:** Hook stub'ları nedeniyle `needs_review` tier pressure'larında otonom genesis
loop çalışmıyor — operatör manuel `agent-genesis draft` çağırmadıkça capability gap'ler
genişlemeye dönüşmüyor. Fitness staleness olmadan eski fitness data ile auto_fix_safe
karar verilebiliyor (silent risk). Plan deviations operatör beklentisinden farklı API
yüzeyleri sergiliyor.

**Resolution (Phase-4.1):**

1. **Sprint 4.1A — Genesis policy infrastructure** (3 dosya, 1 modül):
   - `aria-kernel/aria_kernel/genesis_policy.py` (NEW) — `load_policy(repo_root)`,
     `default_policy()`, `merge_with_override()` tiered config loader.
   - `aria-kernel/aria_kernel/data/genesis_policy_default.json` (NEW) — package default.
   - `aria-config/genesis_policy.json.template` (NEW) — operator override template.
   - 8 unit test (defaults, override merge, missing file fail-soft, malformed JSON,
     non-object root, unknown key filter, contract).

2. **Sprint 4.1B — _skill_or_agent_genesis hook real impl** (`learning.py:108-113`):
   - genesis_policy.load_policy → enable_request_generation gating
   - Actionable gap dedup against existing agent-genesis + skill-genesis requests
   - max_requests_per_cycle cap
   - `gap_type=agent_gap` → `request_agent_genesis` row in `agent-genesis/requests.jsonl`
   - `gap_type=existing_agent_extension` → audit row in `agent-genesis/extension-decisions.jsonl`
   - `genesis_request_emitted` + `genesis_extension_recorded` governance events
   - `agent_genesis.py` NEW helpers: `request_agent_genesis`, `record_extension_decision`,
     `existing_genesis_request_keys`
   - 5 unit test

3. **Sprint 4.1C — _impact_graph_compute hook real impl** (`learning.py:103-104`):
   - Pending dispatch request scan + linked pressure evidence_refs gather
   - `plan_downstream_impact` reuse (existing module from Phase-4)
   - Cycle-driven re-compute (append-only impact-graphs.jsonl ledger)
   - 5 unit test

4. **Sprint 4.1D — Fitness staleness 7d routing rule** (`triage.py:35-42`):
   - `_is_fitness_stale(row, threshold_days=7)` helper with defensive default
     (missing recorded_at → stale)
   - Tier override: stale + auto_fix_safe → needs_review + reason `agent_fitness_stale`
   - `agent_fitness_stale_downgrade` governance event
   - 9 unit test

5. **Sprint 4.1E — Plan deviation resolutions:**
   - **D1** (submit_challenger {DRAFT, REVISED} formal): test in `test_plan_convergence.py`
     covers REVISED → CHALLENGER_DRAFTED transition. Implementation already correct; this
     formalizes the contract.
   - **D2** (skill sandbox markdown parser): `sandbox_skill` extended with
     `markdown_path` kwarg → `parse_fixture_blocks(markdown)` regex extracts
     `## Fixture: <id>` blocks. JSON `checklist_results` kept backward compat (deprecated).
     CLI `skill-genesis sandbox --markdown-file <path>` (new) | `--checklist-results-file`
     (mutually exclusive group).
   - **D3** (record_cross_review file submission + ARIA hash): CLI `plan record-cross-review
     --review-file <path>` reads file bytes, computes `sha256(file_bytes)` →
     `review_content_hash`. Explicit hash field cross-validates (mismatch → CLI rejects with
     `review_file_content_hash_mismatch` before record_cross_review).
   - 6 unit test

6. **Sprint 4.1F — agent-invocations list 2 filter args** (`agent_invocations.py:108`,
   `cli.py:agent-invocations list`):
   - Added `--request-id`, `--role` filters
   - 6 unit test

7. **Sprint 4.1G — Registry hygiene** (this finding row + review file).

**Verification:**
- Test suite: 203 → **243 tests pass** (+40 yeni Phase-4.1 test, no regression)
- Sprint dependencies (4.1A→B; A,C,D,E,F parallel; G last) korunarak implement edildi
- L1/L2 boundary preserved: no LLM in kernel, no Agent tool calls, no developer-tree mutation
- Stdlib-only (zero new third-party Python dep)

## Out-of-scope (Phase-4.2 backlog)

- Telemetry: 6 yeni Phase-4 metric (`aria_convergence_state_count`, etc.)
- CONTRACTS.md doc symmetry update
- Verification gap closure mechanic (original Phase-4 plan Sprint 4E)
- Architectural-arbiter trigger on persistent blocking gaps

## Notes

Phase-4 + Phase-4.1 birlikte plan v9.4'ü tamamlar. Convergence çekirdeği (Phase-4) +
operasyonel periphery (Phase-4.1) = otonom learning loop'un `needs_review` tier'ında
operatör-bağımsız genesis aktivasyonu. Implementer extension'ı (D1 REVISED kabul) plan
v9.5 patch olarak resmi kayıt altına alındı (test ile lock).
