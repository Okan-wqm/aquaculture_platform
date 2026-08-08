# ARIA Wave 1 PR 2.6b — the lane cutover, and the blocker that was not one

Date: 2026-08-04
Branch: `claude/aria-lane-cutover`
Scope: `.github/actions/restore-aria-state/` (new, replaces
`restore-aria-tools-state`), `.github/workflows/aria-{auto-cycle,agent-executor}.yml`,
`workflow_contract_registry.py`, `state_manifest.py`,
`tools/aria-poc/seed_drift_findings.py`, `.gitignore`,
`tests/invariants/aria-single-restore-path.spec.ts`,
`aria-kernel/tests/test_executor_state_publish_gate.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1, PR 2.6b

## The gap

Wave 1's headline deliverable had no production caller. `state_store.py`
implements checkout, snapshot, fast-forward-only publish, contention replay
and verification; its only callers were the operator CLI and `memory_gap`'s
read side. A grep across `.github/workflows/` for `aria/state`, `state_store`
or `ARIA_STATE_STORE` returned nothing. Both scheduled lanes still restored
from and republished the 30-day `aria-tools-state` artifact.

So ORPHAN-CRITICAL-484/488/513 stayed OPEN against a transport that was still
live, `restore_and_replay` had no transport at all, and `state_continuity`'s
third verdict — `unknown`, correct by design until a reference exists outside
the tree — was the only verdict it could ever return.

Machinery written and never called is the defect class this programme exists
to close. This was its largest instance.

## Why it sat there

I carried "the lane cutover is blocked on the self-hosted runner" for a full
session without checking it. The runner blocks the cutover's first REAL RUN.
It never blocked writing the cutover. The work was not deferred by a
dependency; it was untracked — it lived in a parenthetical in PROGRESS.md
("Wave 1 COMPLETE (except the lane cutover)"), which is not a finding, has no
owner and no deadline, and is exactly the shape of debt this repository's
rules forbid.

Registered as ORPHAN-CRITICAL-548, with the correction written into
PROGRESS.md at the entry that made the wrong claim.

## What changed

**The transport.** `checkout_state_store` → run → `publish_state`. The artifact
is demoted to `aria-state-cache-<run_id>`: a forensic copy no code path
restores from. The distinction is the whole point — an artifact that anything
restores from is a second source of truth for one hash-chained ledger, and it
is the one that cannot enforce ancestry, so it would win whenever it was
newer.

**The guarantee moves into the transport.** `publish_state` pushes
fast-forward-only, so a tree that does not descend from the published tip is
rejected by the server. The `restored`/`bootstrap` proof gates stay unchanged
— they answer a different question ("did this job start from real state?")
than the push does ("does this commit descend from the tip?") — but they are
defence in depth now rather than the only thing between a failed restore and
an erased history.

**The silent fresh bootstrap is gone.** A restore that cannot reach a published
tip fails the run. Creating the branch requires `vars.ARIA_STATE_BOOTSTRAP_ACK`
naming the repository: a process that can create the branch when it cannot SEE
it is a process that replaces history with emptiness on a network blip.

**The binding is exported, not described.** The restore action writes
`store_environment()` into `$GITHUB_ENV`, so all three state roots move
together. This is load-bearing rather than tidy: `aria-tools/repo_identity.json`
is TRACKED in the checkout, so `tools_dir()`'s walk-up would find a real, valid
and completely wrong tools root, and the run would succeed while writing every
ledger to a tree that dies with the runner. Every callsite names
`"$ARIA_TOOLS_DIR"` under `set -u`, so an absent binding is a failed step
instead.

**The contract registry moved with the YAML.** `contents: write`,
`network_policy` gains `github_git`, one store-rooted write path replaces two
checkout-relative ones, and the artifact name pattern is pinned to the
run-scoped form — so a future edit back to a fixed name fails the contract
rather than silently restoring the hazard.

## Two defects the YAML-only cutover would have shipped

Both found by reading the round trip rather than the diff.

**A restored store is not yet a usable tools root.** `repo_identity.json` is
what makes one resolvable, and the branch deliberately does not carry it — it
records `bound_repo_root`, an absolute path on the host that wrote it, and the
branch is shared by every runner. So a checkout arrives as covered state with
no identity: `ambiguous_tools_root`. `aria-auto-cycle` had the binding
migration. `aria-agent-executor` never did, so its first restored run would
have died at the lease check. The migration moved INTO the shared action — the
same correction RC-6 made to the restore itself, for the same reason.

_My first fix here was wrong, and PLAN §2.6 had already recorded why._ I
declared `repo_identity.json` as a state surface so it would ride the publish.
The test I wrote passed. It would have passed for the wrong design too, which
is why the replacement asserts the identity is NOT published, alongside the
refusal and the migration that resolves it. A test that only proves the happy
path cannot tell two designs apart.

**The seeder wrote where nothing reads.** `seed_drift_findings.py` wrote to
`<checkout>/aria-findings` while the kernel resolves findings through
`repo_state_root`, which the restore binds at the store. Every night would have
seeded a full pool into a directory nothing looks at — the producer green, the
consumer empty. It imports the kernel's resolver now: one definition, two
callers.

## Two gates that had to be re-aimed

Both pointed at the artifact, and both would have stopped measuring anything.

`tests/invariants/aria-single-restore-path.spec.ts` matched
`actions/artifacts?name=aria-tools-state`. After the cutover nothing in the
repository matches that, so it would have found ZERO implementations and passed
vacuously — a gate that silently measures nothing, which is worse than one that
fails. Re-aimed at `state checkout`, plus two new assertions: no lane
republishes under the retired canonical name, and no lane keeps its own copy of
the binding migration.

`test_executor_state_publish_gate.py` identified the publish by artifact name
and read the restore for `zf.extractall`. It failed loudly, which is the good
outcome, and it now identifies the publish by what it DOES (`state publish`) and
refuses if there is more than one — a renamed step is not the regression; a
second transaction around one ledger is.

`test_workflow_enterprise_preflight.py` hardcoded six step-name literals. Those
now come from the registry constants, because the dangerous failure is not the
`_index_of` that raises — it is a delete-by-name filter that matches nothing,
deletes nothing, and reports the mutation as correctly rejected.

## Verification

- Kernel suite: 3296 tests, green.
- `verify_workflow_contract` green for both lanes against the edited YAML.
- New store tests over real git: the identity is not published, an unbound
  restored root is REFUSED rather than guessed, the migration makes it usable,
  and the genesis (empty) root takes the other branch of the migration chain
  and works too — a fix that only handled a populated root would have failed
  exactly once, on the day it first mattered.
- Mutation-checked: removing the binding from the action, and giving a lane its
  own copy of it, each fail the invariant.
- `findings:verify` chain valid (1353 entries).

## Validation limit — stated plainly

This lands reviewed, contract-verified and locally tested, and **unexercised**.
Both lanes target `[self-hosted, linux, claude]`; no runner is attached, so not
one line of the cutover has executed. **Wave 1 is not complete until a real
nightly runs**, and the first one is the proof — not this document.

Operator preconditions, in order: create the `aria/state` branch ruleset
(block force-push and deletions) BEFORE any bootstrap, then set
`vars.ARIA_STATE_BOOTSTRAP_ACK` to `Okan-wqm/aquaculture_platform` for exactly
one run. See `docs/runbooks/aria-state-branch-bootstrap.md`.

## Findings

- **ORPHAN-CRITICAL-548** — Wave 1's deliverable had no production caller.
  Fixed by the cutover; RESOLVED against `249a5e940`.
- **ORPHAN-CRITICAL-484 / 488 / 513** — the artifact transport all three
  describe is retired. Their ceremony rides the follow-up PR, and not for the
  usual reason: **the squash message for `249a5e940` named only 548 in its
  `Closes:` trailer, so the registry refused the other three.** That refusal is
  correct and worth recording rather than working around — a commit may close
  only the findings it actually names, or the trailer stops being evidence and
  becomes decoration. The recovery is the follow-up commit that finishes their
  closure bookkeeping and names all three.
- **ORPHAN-HIGH-547** — closed against `fdecb3a0a`.

Owner: okan
