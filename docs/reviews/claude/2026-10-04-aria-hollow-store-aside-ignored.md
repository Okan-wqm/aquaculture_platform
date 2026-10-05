# ARIA — a set-aside hollow store dirties the next lane's worktree (2026-10-04)

Owner: claude (implementation), okan (review). Deadline 2026-10-11.

## ARIA-HIGH-349

When the state store directory has lost its worktree link, `state_store._set_aside_hollow_store`
(`aria-kernel/aria_kernel/state_store.py:661`) moves it next to itself as
`.aria-state-store.hollow-<stamp>[-n]/`, inside the runner's checkout, and deletes nothing. The
checkout ignores only `.aria-state-store/` and `.aria-state-store.writers.jsonl` (`.gitignore:23`),
so the set-aside shows as untracked.

Every ARIA lane gates on a clean worktree. On 2026-10-04 the observe burn-in of the first live run
(run 37227217146) printed `?? .aria-state-store.hollow-20261004T191433Z/` and refused with
`observe_burn_in_pre_worktree_not_clean: 1 path(s)`, so the L1 ladder got no evidence.

Rule: host-local ARIA runtime material never dirties a lane's clean-worktree gate.

Fix: ignore `.aria-state-store.hollow-*/`, for the same reason the store and its writers
attestation are ignored (ORPHAN-HIGH-793). A test names the aside with the kernel's own function
and asserts `git check-ignore` covers it, suffixed variants included.
