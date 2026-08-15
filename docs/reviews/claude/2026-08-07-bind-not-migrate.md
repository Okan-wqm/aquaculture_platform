# The tree could not say what it already was — 2026-08-07

## ORPHAN-HIGH-556 — the restore bind is spelled as a migration

### Measured first

The fixture is the real publish-then-restore path, so the tree under
measurement is the one the nightly actually sees.

| on a healthy, published v3 tree | value                                                     |
| ------------------------------- | --------------------------------------------------------- |
| `starting_version` reported     | **0**                                                     |
| chain taken                     | `v1_to_v2` → `v2_to_v3`                                   |
| governance rows added, per bind | **+9**                                                    |
| backup directories created      | `.backups/migration-v0-to-v2-<ts>` — the whole tools tree |

Every night, to re-establish a binding.

## The finding's own headline is wrong, and the truth is worse

`ORPHAN-HIGH-556` says the rewrite permit expires 2026-12-31 and that "on
2027-01-01 every nightly restore starts refusing". Driven directly — the
allowance compares `expires_at > now`, so moving the constant into the past is
exactly equivalent to the clock moving past it — **the bind did not raise.**

Instrumented, the allowance is consulted **zero** times, and the reason is
structural:

| probe                          | identity | manifest match |
| ------------------------------ | -------- | -------------- |
| bound tree (**control**)       | present  | `runs`         |
| restored tree, before the bind | absent   | **NO MATCH**   |
| restored tree, after the bind  | present  | `runs`         |

`_assert_declared_surface` only enforces when `surface_for_path` resolves, and
`_base_matches_root_kind("tools", …)` requires `_has_valid_tools_identity` —
which requires `repo_identity.json`, the one file a restored tree does not have
and the migration has not yet written. For the whole duration of the bind,
every write lands on a path the manifest cannot see.

So the permit `migration.py` carefully passes — `allow_legacy=True`, a reason,
an expiry — **is decoration on this path.** It reads as an audited, time-boxed
authorisation and it is neither.

The deadline was therefore never the hazard. The hazard is that the one moment
ARIA rewrites every covered ledger of its hash-chained memory is precisely the
window in which its own declared-surface guard is blind. `ORPHAN-HIGH-552` made
that rewrite byte-idempotent, so it is correct today, and nothing structural
keeps it that way.

The control row is why this is a finding and not a guess: without it, "NO MATCH"
would be indistinguishable from a wrong probe path. Found-nothing versus
cannot-see is the error this programme keeps paying for, and it is the error the
original finding made.

## Root cause

`repo_identity.json` holds three facts whose scopes differ:

| field                                            | scope                                                      | publishable |
| ------------------------------------------------ | ---------------------------------------------------------- | ----------- |
| `aria_tools_contract_version` / `schema_version` | the **tree**                                               | yes         |
| `bound_canonical_identity` / `bound_repo_hash`   | the **repository** (environment-independent, ARIA-V2 §3.2) | yes         |
| `bound_repo_root`                                | the **host** — an absolute path                            | **no**      |

One unpublishable field made the whole file unpublishable. So the tree's own
contract version died with the runner, `tools_contract_version` read 0, and a
healthy v3 tree looked exactly like a v0 tree needing everything.

Binding and migrating shared one code path **because the tree had no way to
state what it already was.**

## The fix

`tools_contract.json` — a declared tools-root `index` surface carrying the
publishable subset. `STORAGE_POLICY` maps `index` to `carried` and
`publish_state` stages exactly the manifest-attested paths, so declaring it is
both necessary and sufficient for it to travel; `checkout_state_store` is a
plain worktree checkout, so it arrives. `tools_contract_version` reads it first
and falls back to the identity file, so nothing written before the split stops
answering.

**One writer, not five.** `PUBLISHABLE_IDENTITY_FIELDS` + `sync_tools_contract`
are called from every place that writes the identity. Five copies of "which
fields may travel" is five chances for one of them to leak a host path.

`tools_binding.bind_tools_root` is the operation the restore actually wanted:
refuse a store published for another repository, **bind**, and only then migrate
if the bound tree is behind. On the nightly path that is one file and one
governance row — no backup, no rewrite, no ceremony.

**Bind first, then migrate, is not an ordering preference.** A migration is an
operation _on a bound tree_: `migrate_tools_v2_to_v3` refuses outright without
`repo_identity.json`, and the only reason that ever worked was that the v0 path
happened to mint one on the way past. This was found by a test, not by review —
a v2 contract with no host identity now skips the step that used to mint it, and
the delegation raised `tools_v2_to_v3_no_identity`. Binding first makes the
precondition true by construction.

The governance row is written **after** the identity, and that is testable
rather than a matter of comment: `append_tools_governance` calls
`ensure_tools_dir`, which refuses a covered tree with no identity. A row written
first cannot be written at all.

**No `--acknowledge` on the bind.** The restore action passed one on every
nightly run — an acknowledgement with nobody present to make it. The delegated
migration still requires one, where a tree is genuinely about to be rewritten,
and the delegation is recorded (`tools_root_bind_required_migration`) rather
than inferred from the ceremony rows around it.

**A store published for another repository is now refused.** Before the split
there was nothing to check against: the migration rebound whatever tree it was
pointed at to whatever repository it ran in. The published identity turns a
silent adoption into `tools_root_foreign_store`.

### No flag day

A tree whose branch predates the contract surface has no `tools_contract.json`,
takes the migration path exactly once — and that migration writes the file. The
next night is a bind. A genesis store has no contract file for the other reason
and reaches the same place.

## Four more defects, found by the full suite after the targeted tests passed

Worth recording as a group, because all fifteen new tests were green and all
eight mutations were red before any of these surfaced. Targeted tests prove the
thing you built; they do not tell you what you broke.

**A migration is not a bind, and saying so was not enough.** Once the tree
publishes its version, a restored tree already at the target reaches
`migrate_tools_bootstrap` with nothing to migrate — and `already_at_target` is a
success handed back for a root that still has no host identity and still fails
`ensure_tools_dir`. Two independent tests walked into it. It now refuses and
names `bind-tools-root`, because a command that reports healthy and leaves an
unusable tree is a worse trap than the one this finding started with.

**The rollbacks are writers too.** `sync_tools_contract` was wired into every
forward writer and the reverse ones were missed, so `rollback_tools_v3_to_v2`
downgraded the identity to v2 while the published contract went on claiming v3 —
and `tools_contract_version` reads the contract first. One writer is only one
writer if every writer calls it.

**The new surface minted a gate nobody enforces.** `profile_surface` falls back
to the lock group, so declaring the surface silently created a new write surface
called `registry` — a profile gate with no callsite naming it, which is
`ORPHAN-CRITICAL-498`'s shape arriving as a side effect of a manifest line.
`test_plan_020_write_surfaces_extended_to_40` caught it as `41 != 40`, which is
exactly the conversation that invariant exists to force. The surface now declares
`tool_governance` — the gate its writers actually pass through — and the count is
40 again.

**The bind had no frozen guard.** Under `frozen` it would have written
`repo_identity.json` and only then been refused at the governance row, leaving a
partial write. It now guards at the entry point, for the same reason
`migrate_tools_bootstrap` guards at its umbrella.

Two test helpers were pointed at `bind_tools_root` rather than worked around.
Both were using the migration as a bind because it was the only door; one of
them says so in its own first line — _"Bind the store's tools root the way a real
lane must"_.

## An incidental defect, found by the fix and fixed with it

`_guard_tools_lock` admitted a process to write while holding its own lock only
if the operation name appeared in a hardcoded set:

```python
if pid == os.getpid() and operation in {"tools_migration", "tools_rollback"}:
```

`tools_binding` was the next operation anyone added. It took the lock correctly
and then could not write its own governance row. Re-entrancy is a property of
**holding the lock**, not of having been remembered — the pid check is the whole
of the safety question, and the operation name added no protection and one more
thing to get wrong. This is `ORPHAN-HIGH-569`'s shape (a roster that was true
when written) in a lock guard. The test drives it with an operation name
deliberately outside the historical three, so re-adding a roster fails.

## Verification

Every claim mutation-checked; each applied, run, then reverted, with the
baseline confirmed green before and after.

| mutation                                                   | result |
| ---------------------------------------------------------- | ------ |
| undeclare the contract surface                             | red    |
| read only `repo_identity.json` again (the defect)          | red    |
| reinstate the lock operation roster                        | red    |
| leak `bound_repo_root` into the published contract         | red    |
| always delegate to the migration (pre-fix behaviour)       | red    |
| adopt a foreign store instead of refusing                  | red    |
| write the governance row before the identity               | red    |
| point the restore action back at `migrate-tools-bootstrap` | red    |

The last one is the gate that matters most, because **the regression is
invisible at runtime**: a nightly that runs the migration still succeeds. It
just rewrites ARIA's whole memory on the way.

## What this does not do

It does not make the declared-surface guard see an unbound tree. The blind
window still exists — it is now empty on the nightly path, and a genuine
migration still runs inside it. Closing the window itself needs the manifest to
resolve a tools root without a host binding, which is a change to what
`_has_valid_tools_identity` means and would weaken the `ambiguous_tools_root`
refusal that stops a lane writing into an unbound tree. That trade is not worth
making to protect an operation an operator is present for.

`MIGRATION_REWRITE_EXPIRES_AT` is left at 2026-12-31 and is now genuinely
unreached on the nightly path. A migration authored after that date must move it
deliberately, in its own commit — which is the right place for that decision,
and no longer something a nightly depends on.
