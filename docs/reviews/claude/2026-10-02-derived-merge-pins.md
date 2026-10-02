# Two committed derived literals serialize every ARIA and registry merge (2026-10-02)

Owner: okan. Deadline: 2026-10-06. Severity: HIGH.

## PROC-HIGH-046

Context: two values that are pure functions of the tracked tree are committed as literals and
gated for equality with a fresh computation. Every PR that moves their input has to rewrite them,
so any two such PRs touch the same lines, and the PR that merges second is stale or conflicting
the moment the first one lands. PR #1713 removed the same shape from the format scope
(PROC-MEDIUM-040); these are the two that remain.

1. **The ARIA authority hash.** `docs/aria/CURRENT_STATE.md:5` records a SHA-256 over every tracked
   file under `docs/aria/`, `aria-kernel/`, `tools/aria-poc/` and the `aria-*` workflows.
   `tests/invariants/aria-doc-runtime-ssot.spec.ts` fails unless the recorded value equals a fresh
   digest; that spec runs in `aria-kernel.yml`, `aria-operational-proof.yml` and the required
   `aria-merge-authority` check, on the GitHub merge-result tree.
2. **The debt-plan mirrors.** `docs/plans/2026-06-18-enterprise-grade-debt-closure/` carries the
   registry tip hash, row count, OPEN / IN-PROGRESS / active-CRITICAL counts and the active
   CRITICAL id list in `manifest.json`, the same scalars in `README.md`, and the tip hash in
   `finding-truth-table.md`. `tests/invariants/enterprise-grade-debt-plan-contract.spec.ts` fails
   unless every one equals the registry, so every `findings:add` is followed by
   `npm run gates:debt-plan:repin`.

Measured on `main @ 8b304425b` (first-parent merges since 2026-09-18, 95 in all):

- 17 of the 17 merges that touched an ARIA authority path rewrote `CURRENT_STATE.md`.
- 78 of the 78 merges that touched `docs/reviews/_registry/findings.jsonl` rewrote the debt-plan
  manifest.
- Across all refs, 53 merge commits since 2026-09-18 record hand-resolved conflicts; all 53 list
  the debt-plan files (PR #1713's own last sync, 277cdf9b5, resolved all three).
- The read-only program audit of 2026-10-02 measured the cost: ARIA PRs take a median 3.7 h from
  open to merge against 0.8 h for the rest (about five PRs a day), and each merge forces an
  aria-kernel rerun of about 115 job-minutes on every open ARIA PR.

What each pin protected, and what it did not:

- The authority hash was meant to make `CURRENT_STATE.md` falsifiable ("a stale hash means the
  document describes a runtime that has since moved"). The pre-commit hook rewrites it on every
  commit that stages an ARIA path and the post-merge hook rewrites it after every local merge, so
  the value certifies that a hook ran, not that anyone read the document. The only event it fails
  on is a merge that combines two authority changes, which is not a documentation defect. The
  document's falsifiable claims are its normative anchors (repository paths and `file.py::symbol`
  owners); a module rename that leaves an anchor dangling is the real "runtime has moved" case.
- `.gitattributes` pins the file `merge=ours` with a driver that keeps the local side. GitHub never
  runs custom drivers, so server-side updates still conflict or go stale, and on a local merge the
  driver silently drops the other side's edits to the document's prose.
- The debt-plan counts and tip hash mirror the registry and protect nothing beyond themselves: the
  same CODEOWNERS entry covers `docs/reviews/_registry/` and `docs/plans/`, so "a registry edit
  without plan review" is not a separate guarantee. The load-bearing part is the active CRITICAL
  set: a new active CRITICAL needs a truth-table row (owner, first sprint, truth bucket), and a
  CRITICAL that leaves the active set leaves the active table. The current check also misses a
  duplicate row (`ORPHAN-CRITICAL-810` appears twice) because it collects rows into a Map.

Evidence:

- `tools/gates/aria-authority-hash.ts:183-206` — `writeAriaAuthorityHash` restamps hash and date.
- `.husky/pre-commit:82-99` — rewrites and stages the pin whenever an ARIA path is staged.
- `.husky/post-merge:25-31` — rewrites and stages it after every merge.
- `.husky/pre-push:21-28` — refuses the push on a stale pin.
- `tests/invariants/aria-doc-runtime-ssot.spec.ts:189-198` — compares the pin with the digest.
- `.gitattributes:12-23` and `tools/gates/git-merge-drivers.json` (`ours`) — keep-local driver.
- `tools/gates/repin-debt-plan.ts` and `package.json` `gates:debt-plan:repin` — the mirror writer.
- `.github/workflows/finding-closure-reconcile.yml:235-244` — the post-merge lane repins too.
- `tests/invariants/enterprise-grade-debt-plan-contract.spec.ts:152-193` — the equality checks.

Rule: a value derived from the tree is computed where it is read, never committed beside its
source; a gate compares the property each consumer needs against the tree (CLAUDE.md
Architectural Approach, tiers 1-2).

Fix direction: drop the recorded hash line and its writers; check that every normative anchor in
`CURRENT_STATE.md` resolves in the tree; keep the authority digest as a value derived on demand
from a commit; remove the `merge=ours` pin. Drop the debt-plan mirrors and the repin step; derive
the registry snapshot in memory and compare the truth table's active rows with the derived active
CRITICAL set (missing, retired, duplicate, invalid bucket); leave the reconcile lane, the one
writer of RESOLVED, as the one writer that retires a resolved CRITICAL's row.
