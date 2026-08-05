# The first restored night

Date: 2026-08-05
Branch: `claude/aria-state-recovery`
Scope: `workspace.py` (`ensure_workspace`), `integrity.py` (`_verify_workspace`),
`memory_gap.py` (`DescentProof`, `store_is_at_published_tip`,
`assess_memory_continuity`)

## The setup

The first live nightly (2026-08-04) was a **bootstrap**: it created every
host-local marker itself. Tonight is the first **restore**. Three controls
behaved correctly through the bootstrap and are wrong on the restore — the same
class this programme keeps finding, and the reason it keeps finding it is that
a gate with no real input proves nothing about the same gate once it has one.

## ORPHAN-CRITICAL-553 — run the night, then be refused permission to keep it

The workspace identity file records this **host's** absolute `repo_root`, so it
correctly does not travel on a branch every runner shares. The workspace
**ledgers** do travel. The ordinary shape of a restored workspace is therefore
_rows present, identity absent_ — and two places treated exactly that shape as
damage:

- `ensure_workspace` raised `workspace_migration_required` whenever content
  existed without an identity;
- `_verify_workspace` bootstrapped only when the identity was absent **and**
  every ledger was empty, so a restored workspace skipped the bootstrap,
  `workspace_contract_version` read a file that was not there, and the verdict
  became `workspace_migration_required`.

Both lanes gate publication on `steps.integrity.outputs.state_valid == 'true'`.
So the night's work happens and is then refused persistence — the same outcome
as last night's `--snapshot-id` defect, reached by a different route.

Measured on a store restored from a published tip carrying real workspace
ledger content: `integrity status: drift` before, `ok` after, ledger rows
intact.

**The fix is to re-derive, not to refuse.** It is safe because the workspace
_path_ already carries the binding — `workspace_paths` keys the directory by
repository hash, so a workspace at `<base>/<hash>` cannot belong to another
repository — and the identity-mismatch branch still refuses a _disagreeing_
identity. What the blanket refusal actually protected against, content this
kernel cannot read, is caught downstream and more precisely by
`_verify_workspace`'s per-ledger `verify_jsonl`, which names the offending
ledger instead of rejecting the whole workspace. The re-derivation is recorded
as `workspace_identity_rederived` so it is auditable rather than silent.

This is the identical shape to the tools root's `ambiguous_tools_root`, which
got a governed migration wired into the restore action. Its sibling got no
repair path at all — one root's fix did not reach the other, which is
ORPHAN-CRITICAL-513's lesson recurring in a new place.

## ORPHAN-HIGH-554 — my own regression, one day old

`_remote_tip` returns `None` for **any** non-zero `git ls-remote`, so it cannot
tell "the remote names a different commit" from "the remote could not be
reached". `store_is_at_published_tip` — which I introduced yesterday in
`9d8b7929` — collapsed both into `proven=False`, which the assessor substitutes
for the chain-linkage half: `chain_broken` → `GAP_CRITICAL` → freeze.

The nightly runs 50–150 minutes and its `ls-remote` is unauthenticated
(`persist-credentials: false`), so one network blip reports memory loss that did
not occur and stops the run.

The code already knew the tip might be unreadable — the refusal it printed said
`tip=<unreadable>` — and mapped it to amnesia anyway. It contradicted this
module's own doctrine, that `unknown` is the honest answer when evidence is
unavailable, three lines below where the docstring states it. Restating a rule
in prose is not encoding it.

`DescentProof` carries `readable` now. All four cases measured:

| case                                 | verdict    | blocks |
| ------------------------------------ | ---------- | ------ |
| healthy, remote readable, at tip     | `ok`       | no     |
| healthy, **remote unreadable**       | `unknown`  | **no** |
| genuinely behind the tip             | `critical` | yes    |
| unreadable **and** real surface loss | `critical` | yes    |

The last row is the one that keeps the fix from being a hole: the tree is
present, so loss is still evidence about it even when the remote is not.

## How these were found

A workflow sweep, run after the store went live, hunting one class: controls
that were correct only because `aria/state` had no published reference. Five
scouts over distinct surfaces, each candidate handed to an adversarial verifier
told to refute it and to default to refuted when uncertain. Seventeen survived.
These are the three that break tonight; the rest are recorded and queued.

That the sweep's first confirmed finding was a defect in the fix I had merged
that morning is the useful part. I verified it myself before acting on it, and
it reproduced.

## Findings

- **ORPHAN-CRITICAL-553** — restored workspace refused and reported as drift.
- **ORPHAN-HIGH-554** — unreadable remote reported as amnesia.

Both fixed here; close ceremonies ride the next PR (PROC-HIGH-001).

Owner: okan
