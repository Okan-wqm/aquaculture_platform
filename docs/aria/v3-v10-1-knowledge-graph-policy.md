# Plan ARIA-V10.1 — Knowledge Graph Policy

**Branch:** `snowball`
**Phase:** Plan ARIA-V9 + V10 v3 — V10.1 (KG policy doc)
**Status:** RESOLVED — V9.0-F `knowledge_graph.py` ships the kernel mechanics; this file documents schema + integrity semantics + operator-facing rules.

## Why this file exists

V9.0-F landed the kernel-side knowledge-graph module (`aria_kernel/knowledge_graph.py`) with hash-chained JSONL ledgers, signed records, indexed lookup, and an anti-pattern HUMAN_REQUIRED gate. This doc records the **operator-readable policy** layer: what each ledger means, when entries are minted, how operator review interacts with the auto-discovery path.

## Three ledgers (under `aria-tools/knowledge-graph/`)

### 1. `conventions.jsonl`
Auto-discovered patterns the synthesizer + skill-genesis are permitted to consult when ranking pressure sources or detecting recurring architectural decisions.

- **Writer:** `knowledge_graph.record_convention(pattern, signer_key_fp)`
- **Trigger:** post-CONVERGED, the convergent_skill_authoring or the synthesizer pipeline emits the row.
- **Signature:** signed with the cycle's V9.0-C ephemeral ed25519 key fingerprint. The signer_key_fp lands in the row body; the row's `prev_row_hash` chains to the previous row's canonical sha256.
- **Confidence floor:** `lookup_pattern` returns rows only when `confidence >= MIN_PATTERN_CONFIDENCE` (= 0.7). Below threshold the row exists for audit history but does not influence ranking.

### 2. `anti-patterns.jsonl`
Operator-rejected patterns. The synthesizer AVOIDS minting plans that match an anti-pattern entry.

- **Writer:** `knowledge_graph.record_anti_pattern(pattern, reason_class, operator_signature)`
- **HUMAN_REQUIRED:** operator_signature is **mandatory**. Kernel-side auto-write is FORBIDDEN. The operator's signature is verified against a pinned public-key fingerprint (V10.4-scope cryptographic check; V9.0-F ships schema presence verification).
- **reason_class:** closed enum `{tool_design, scope_decision, architecture_class}`.
- **pattern_type:** must equal `"anti_pattern"` (validated at write time).

### 3. `pressure-source-effectiveness.jsonl`
Rolling effectiveness stats per `PlanCandidateSource` value. Powers `rank_pressure_sources()` which is consumed by `plan_synthesizer.rank_candidate_sources` for ordering.

- **Schema per row:**
  ```
  {source_type, cycles_minted, cycles_converged, cycles_merged,
   cycles_rejected, avg_cost_usd, observed_at, prev_row_hash}
  ```
- **Effectiveness:** `cycles_converged / max(1, cycles_minted)` — sorted descending. Source types that consistently produce CONVERGED+MERGED outcomes rise; sources that produce refused/rejected outcomes sink.

## Hash-chain integrity (V9.0-F Tier-1 contract)

Every row across all three ledgers carries `prev_row_hash = sha256(canonical_json(prev_row))`. The first row's `prev_row_hash = GENESIS_PREV_HASH` (`sha256("genesis")`).

`verify_chain_or_quarantine(path)` walks the file row-by-row. On any broken link:

1. File is renamed to `<path>.quarantined.<utc-iso>.<reason>`
2. Function returns `(False, broken_line_number)`
3. Caller emits governance event `knowledge_graph_tampered` so the audit trail surfaces the breakage

`lookup_pattern` + `rank_pressure_sources` BOTH call `verify_chain_or_quarantine` at every read so tampering is caught at the consumption site, not just at boot.

## Provenance (arb HIGH-008)

Every `Pattern` carries:

- `discovered_by_cycle_id` — **mandatory**. The cycle that minted the row.
- `supersedes_pattern_id` — optional. When a new convention replaces an older one (e.g. an anti-pattern downgrades a previously-recorded convention), this field links the lineage.
- `observed_at` — UTC ISO-8601.
- `schema_version` — pinned to `KNOWLEDGE_GRAPH_SCHEMA_VERSION` (currently 1).

## Indexed lookup

`conventions.idx` keyed `{pattern_id → byte_offset}` is rebuilt on every `record_convention()` append (V10.1 contract — V9.0-F ships linear scan; index lands in V10.4 batch with the cost-attribution sharding work).

## Operator workflows

- **Append a new convention** — happens automatically post-CONVERGED via the skill-genesis pipeline.
- **Mark a pattern as anti-pattern** — operator signs an anti-pattern row via the V10.4+ CLI (`aria-kernel knowledge-graph anti-pattern --pattern-id X --reason-class scope_decision --signature <sig>`) — this lands as part of V10.4 cost-attribution batch since both surfaces require the same operator-signature plumbing.
- **Audit chain integrity** — `aria-kernel knowledge-graph verify` runs `verify_chain_or_quarantine` on all three ledgers + reports broken links.

## Cross-references

- `aria-kernel/aria_kernel/knowledge_graph.py` — V9.0-F module
- `aria-kernel/tests/invariants/v9/test_phase_v9_0_f_knowledge_graph.py` — 21 invariants pin the contract
- `aria-kernel/aria_kernel/plan_candidate_source.py` — V9.0-A `PlanCandidateSource` enum (powers `pressure-source-effectiveness.jsonl`)
- `aria-kernel/aria_kernel/skill_genesis_sandbox.py` — V9.0-E sandbox (powers post-convention authoring)
