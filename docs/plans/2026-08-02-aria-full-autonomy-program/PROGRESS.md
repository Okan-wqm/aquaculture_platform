# ARIA Full-Autonomy Program — Progress Log

Program plan: [`PLAN.md`](./PLAN.md). Newest entries first.

## 2026-08-02 — Wave R executed

- **#1045 merged to main (`fd963861`)** — the RC closeout (supersedes #1041):
  RC-2 observation/breaker split, RC-4/5 derived breaker window, RC-7/8 test
  honesty, RC-1 tier-3 reachability invariant, plus the full main
  reconciliation (five migration re-timestampings, jest spec-constant merge,
  24 expired dormancy waivers stay drained, registry re-chained to 1324 rows
  tip `444efa9a`, debt-closure repin, format-scope regeneration). Validated:
  `aria:test:unit` 2993 OK, `invariants:fast` green including the newly
  activated specs, `findings:verify` green. Route chosen by the operator:
  fresh single-commit re-land instead of growing the frozen
  `PRE_PHASE6_SHAS` allowlist (the branch's pre-retrace history carried
  trailers the #1024 retrace had invalidated). Closes ORPHAN-CRITICAL-503,
  ORPHAN-MEDIUM-483, ORPHAN-HIGH-499/502/504.
- **#1041 closed** (superseded by #1045; branch preserved for archaeology).
- **#936 closed** (superseded; autonomous mode rebuilds on Mission +
  signed-permit architecture in Waves 8/9). Salvage: `ORPHAN-HIGH-518`
  (aria-debts/keys stageable — `.gitignore` fix in the registering commit;
  no key file was ever actually tracked, the rule is preventive) and
  `ORPHAN-HIGH-519` (FAILING_CI evidence grounding — scheduled into Wave 9).
  Review: `docs/reviews/claude/2026-08-02-aria-wave-r-reconciliation.md`.
- **Program plan of record committed** (this directory; PR #1046), with the
  2026-07-26 program marked SUPERSEDED-BY + stage map.

### Runner sandbox ground truth (RC-9 scope, Wave R item 4)

Verifiable from CI config at `main@fd963861`: both ARIA lanes install
bubblewrap via `apt-get` and hard-verify `implementation_safety.sandbox_backend()`
before any write-capable step (`aria-auto-cycle.yml` — ubuntu-latest;
`aria-agent-executor.yml` — `[self-hosted, linux, claude]`). What CI config
cannot prove: whether `apt-get` succeeds and bwrap actually confines on the
self-hosted executor host (user namespaces, kernel config). **Operator action
item (PLAN.md §7.4):** run the capability probe once on the self-hosted
runner; until then the 2026-07-26 program's S0 caveat (`ORPHAN-CRITICAL-439`)
stays conservatively open for that lane.

### Program metrics (baseline at Wave R close)

| Metric | Value |
| --- | --- |
| Mission loss | n/a (mission layer lands in Wave 2) |
| Unauthorized merges | 0 |
| Registry chain | valid, 1326 entries |
| Open ORPHAN findings feeding the backlog | 104 |
| Waves complete | R (0-11 pending) |
