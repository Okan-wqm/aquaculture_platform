<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 026 — Rust/edge into the drift net (D2)

> **Status:** Phase A implemented (Rust enum drift detector). Agent-layer Rust tier-vocab wiring tracked as ARIA-026-D1.
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`
> **Closes:** ARIA-023-D2 (Rust/edge outside ARIA's audit net).

## Summary

ARIA's continuous-mode mechanical drift scan (`tools/aria-poc/poc.py`) was
TypeScript/SQL/GraphQL-only: every value-set detector keyed on `.ts/.tsx`
(`detect_ts_enums`, `detect_ts_union_types`, `detect_ts_const_arrays`,
`detect_zod_enums`) plus SQL + GraphQL. Rust files were counted in the
fingerprint histogram (`LANGUAGE_BY_EXT['.rs']`) but **nothing acted on them** —
~210k LOC across `sens-api-gateway/` + 9 workspace `crates/` (event contracts,
protocol codecs, PLC/SCADA, audit chains) sat outside the drift net, exactly
where field-failure cost is highest. The Rust↔TS event-contract boundary (ADR-025
sidecar) could drift undetected.

## Phase 026a — Rust enum drift detector (tier-3 "make it detectable") ✅

- New `detect_rust_enums(repo_root, fates)` in `poc.py` emits the same
  `{name, values, ref, kind, surface}` shape as the TS detectors, so Rust enums
  join the existing **cross-language drift comparison** (`find_drifts`) — a Rust
  enum that mirrors a TS/GraphQL/SQL value-set now surfaces as a drift candidate.
- Variant extraction is brace-matched (unit / tuple / struct / discriminant
  variants all reduce to the leading identifier; depth tracked on `()[]{}`, not
  `<>`, so a discriminant `<<` shift can't miscount and generics stay balanced),
  and strips `#[...]` variant attributes. Wired into `main`'s value-set list.
- `surface_of_path` gained an `edge_source` branch for `sens-api-gateway/` +
  `crates/` + `.rs` (previously `"unknown"`, which hid the edge surface from
  triage).
- Verified on the real repo: **414 `.rs` files → 352 Rust enums** detected
  (e.g. `TokenKind` 94 variants, `AuditAction` 37, `Opcode` 32, MQTT v5 protocol
  enums) — the edge layer is now in the net.
- Tests: `tools/aria-poc/test_poc.py` (all variant kinds, generics, `/tests/`
  skip, `edge_source` surface).

## Deferred — ARIA-026-D1 (owner: edge+aria, due 2026-09-25)

The LLM agent layer is still TS/SQL-centric: `root-cause-auditor`'s tier
vocabulary (branded type, CHECK/UNIQUE constraint, exhaustive `switch (x: never)`,
ESLint rule) names no Rust mechanism (newtype, exhaustive `match`,
`#[non_exhaustive]`, clippy `deny` wall), and `.claude/knowledge/layer-1-rust.md`
(which already exists, rich) is cited only by the PR-cycle `edge-expert`, never
by any ARIA-loop agent or the kernel. Wiring `layer-1-rust.md` into the ARIA
evidence path + extending the tier vocabulary with Rust make-impossible
mechanisms is the next phase; the mechanical drift detector (this plan) is the
foundation it builds on.

## Acceptance

- `detect_rust_enums` extracts variant names from unit/tuple/struct/discriminant
  enums, skips `/tests/`/`/fuzz/`/`/benches/`/`/target/`, and labels them
  `edge_source`.
- Rust enums participate in the cross-language drift comparison via the `main`
  value-set list.
- `tools/aria-poc/test_poc.py` passes (the PoC stays stdlib-only).

## Assumptions

- Inline `#[cfg(test)] mod tests` enums in non-`/tests/` files are not skipped
  (path-based skip only) — acceptable: enum *definitions* rarely live inside an
  inline test module, and a stray test enum is a benign extra drift candidate,
  not a missed one.
- The PoC remains dependency-light (stdlib regex + brace matching, no syn/rust
  parser) so it keeps running before the full toolchain is healthy.
