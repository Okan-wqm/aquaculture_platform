# ARIA Wave 1 §2.4 — binding the lane roots to the store, and what that exposed

Date: 2026-08-03
Branch: `claude/aria-w1-store-lanes`
Scope: `workspace.py` (`repo_state_root`), `finding.py`, `debt.py`,
`state_store.py` (`store_environment`, bounded staging), `cli.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1, PR 2.4

## The gap

PR 2.3 built the store. Nothing wrote into it. ARIA's three state roots
were still where they had always been, and two of the three could not
survive a run:

- **workspace** (10 declared surfaces, all of workspace memory) resolved
  under `$HOME/.aria/workspaces/<hash>/` — neither git-tracked nor
  uploaded as an artifact, so it died with the runner. Every run.
- **repo** (6 declared surfaces: `aria-findings/`, `aria-debts/`) sits in
  a directory that is gitignored BY DESIGN — a runtime cycle must not
  dirty the discovery tree — and rode nothing between runs. The visible
  consequence: `_allocate_finding_id` restarted at `F-001` on every
  bootstrap, so a finding ID meant nothing across cycles.

Sixteen of ARIA's declared surfaces were structurally incapable of
persisting, and nothing said so, because every surviving file still
verified. Per-file hash chains cannot see a file that was never there.

## The binding

One resolver per root, and one definition of the pair.

`workspace.repo_state_root()` is the new seam for the repo root; the
`ARIA_WORKSPACE_BASE` seam already existed for the workspace root. Both
`finding.py::_findings_dir` and `debt.py::_debts_dir` resolve through the
former, so the two cannot drift apart the way two hand-copied restore
heredocs did (ORPHAN-CRITICAL-513).

`state_store.store_environment()` is the single definition of the whole
binding. Three roots have to agree, and a lane that got two of them right
would look like it was working while a third of ARIA's memory kept dying.
The subtlety it encapsulates: `workspace_paths` appends the repo hash
itself, so `ARIA_WORKSPACE_BASE` is the PARENT of the per-repo directory
— point it one level deeper and every surface lands somewhere the
snapshot does not look, which reads as total loss on the next continuity
check. `state checkout` emits the mapping so a workflow reads it rather
than restating the path convention.

## What the binding exposed, before it could bite

`gh_token_factory` writes per-cycle ed25519 **private keys** and scoped
installation tokens to `aria-debts/keys/` — immediately beside the
declared `aria-debts/` ledgers. `publish_state` staged with `git add
--all --force`.

So redirecting the repo-state root would have committed credentials to a
branch that gets pushed. The main checkout's `.gitignore` does cover
`aria-debts/keys/`, and it would not have helped twice over: git reads no
`.gitignore` above a worktree's top level, and `--force` overrides ignore
rules regardless.

This was found while implementing the redirection, before the redirection
existed — a near-miss, not an incident.

The fix is not an ignore rule for keys. **The store now stages exactly the
snapshot's own surface paths**, plus the two markers. An undeclared file
cannot be committed because nothing names it, so no new rule is needed
for each future secret. Two properties fall out of that:

- the commit is bound to the attestation **by construction** — the tree
  IS the surface set the manifest walked, not merely consistent with it.
  This is the property the PR 2.3 review recorded as missing (a verifier
  refuted the finding as filed, correctly, because it named the ancestry
  gate; the missing binding was this one);
- `--force` becomes safe again, and stays, because the pathspec is
  bounded. A shared `info/exclude` pattern must not be able to subtract a
  surface the snapshot attests — that would be the branch carrying less
  than its own manifest claims. The danger was never `--force`; it was
  `--force` over the whole tree.

The previous snapshot's paths are included in the pathspec too, because
`build_snapshot` only records files that EXIST — the current snapshot
cannot name what is gone, so without them a removed ledger would linger
in the branch while the manifest stopped mentioning it. Deliberately NOT
the subtree prefixes: `git add --all -- tools` would re-admit every
undeclared file under it, which is the whole thing the list prevents.

`_keys_dir` is deliberately left pointing at the ephemeral checkout.
Per-cycle keys are credentials, not state, and dying with the runner is
their correct lifetime. The bounded staging is the second lock, not the
first.

## Verification

39 tests over real git repositories. The ones that carry this PR:

- a private key and a token placed in the store beside a declared debt
  ledger are NOT committed, while the ledger IS — proving selection
  rather than the subtree being skipped wholesale. The assertion searches
  the commit for the key material, not just the paths, so a key arriving
  under another name would still be caught;
- an undeclared stray file is not committed;
- a vanished surface is still covered by the pathspec, so its deletion is
  expressible;
- finding IDs survive a fresh runner: `F-001`/`F-002` written under the
  store are visible to a brand-new checkout;
- the three roots agree — `workspace_paths` and `store_roots` compute the
  same path from `store_environment`'s values;
- `_keys_dir` is unaffected by the seam.

Mutation-checked: reverting the whole-tree add, the `repo_state_root`
override, or `debt.py`'s use of the shared resolver each makes the suite
fail. Kernel suite and `invariants:fast` green.

## Findings

- **ORPHAN-HIGH-533** — two of three state roots died with the runner.
  CLOSED here.
- **ORPHAN-HIGH-534** — the store staged its whole working tree, so the
  redirection would have pushed private keys. CLOSED here.
- **ORPHAN-CRITICAL-484 / 488 / 513** — still OPEN. The roots now point
  at the store, but no scheduled lane calls it yet: that is the workflow
  cutover, and it needs the `[self-hosted, linux, claude]` runner, which
  has been offline since 2026-07-17.

Owner: okan
