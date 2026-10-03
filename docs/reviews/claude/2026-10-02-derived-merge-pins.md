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

### Fix (same branch)

- `docs/aria/CURRENT_STATE.md` loses its hash line. `tools/gates/aria-authority-hash.ts` keeps the
  path (the ORPHAN-MEDIUM-792 closure policy names its spec) and now answers two derived questions:
  `ariaAuthorityHash(repo, rev)` digests path, mode and blob id of every authority path in one
  commit's tree, and `checkCurrentState(repo)` requires every path in the normative-anchor section
  to be tracked, every `file.py::symbol` to be a module-level definition, and no SHA-256-shaped
  literal in the document. The docs SSoT invariant and `--check` consume that one verdict;
  `--write` exits 2.
- The pre-commit writer and the post-merge hook are removed; pre-push runs `--check`, which writes
  nothing. `.gitattributes` drops `merge=ours` for the file and the `ours` driver leaves the
  manifest; the merge-driver spec now also refuses a registered driver that no attribute declares.
- `manifest.json`, `README.md` and `finding-truth-table.md` lose the registry tip, counts and the
  active CRITICAL list; `manifest.json` keeps plan identity, roster, waves and sprints, and the
  documents keep their prose. `tools/gates/debt-plan-truth.ts` derives the snapshot in memory
  (`npm run gates:debt-plan` prints it) and checks the truth table against the derived active
  CRITICAL set: missing row, retired row, duplicate row and unknown bucket each fail by id. The
  duplicate `ORPHAN-CRITICAL-810` row the Map-based check let through is removed.
- `repin-debt-plan.ts` and `gates:debt-plan:repin` are deleted. The closure-reconcile lane, the one
  writer of RESOLVED, runs `gates:debt-plan:retire-resolved`, which moves the row of each CRITICAL
  it resolved into `Resolved Evidence` and refuses, writing nothing, on anything needing judgement.
  Its declared write set shrinks to the registry and the truth table.
- Pinned by `tools/gates/aria-authority-hash.spec.ts`, `tools/gates/debt-plan-truth.spec.ts` and
  `tests/invariants/derived-merge-pins.spec.ts`, which replays two concurrent registry + ARIA
  branches on the real files: neither touches a formerly pinned file, both are green as they
  stand, and their GitHub-shaped merge (no custom driver) conflicts only on the registry's own
  tail append, which the `findings-registry` driver resolves.

Not changed: `aria-kernel/aria_kernel/workflow_contract_registry.py:808-810` still allows the
reconcile lane to write `manifest.json` and `README.md` (a ceiling the lane no longer reaches;
the preflight check is a subset test). `preflight.py:800` still lists `CURRENT_STATE.md` among
cycle-written paths, and docstrings in `runtime_profiles.py:14` and `git_containment.py:396`
still mention the authority hash. This change does not edit the kernel; all four are inert.
`autonomy_evidence.py` reads no CURRENT_STATE value: it names
`tools/gates/aria-authority-hash.spec.ts` and `tests/invariants/aria-doc-runtime-ssot.spec.ts` as
ORPHAN-MEDIUM-792 regression refs and checks only that both blobs exist, which they do.
