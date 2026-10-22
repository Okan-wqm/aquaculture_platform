# Debt-plan truth table — generated bullet breaks docs-check (2026-10-22)

The reconcile lane appends a bullet to the `Resolved Evidence` section of the debt plan's
`finding-truth-table.md` for every CRITICAL it resolves. When the section ends in a paragraph
rather than a bullet (a hand-written note), the generated bullet follows it with no blank line,
which markdownlint rejects (MD032) in `docs-check`.

---

## PROC-MEDIUM-060 — The reconcile lane writes a list with no blank line after a paragraph

- **Evidence:** `tools/gates/debt-plan-truth.ts` (`appendToResolvedEvidence`) joined the new bullet
  with a single newline. The automation PR "record closures reachable from main" failed
  `docs-check` (`finding-truth-table.md:1155 MD032`), could not merge, and so the closures it
  records stayed unrecorded: `finding-registry-closure-drift` failed on every push to main, and
  `build-status` with it, so no deploy ran.
- **Fix:** the entry continues the list when the section ends in one and starts its own list after
  a blank line when it ends in a paragraph. A spec pins both cases and idempotency.
