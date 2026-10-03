# T2 probe — the hardened git could not read root's checkout (2026-10-03)

Context: ADR-0023 T2 boundary probe (`aria-t2-probe.timer`, runbook
`docs/runbooks/monitoring/aria-t2-boundary.md`). The probe runs `aria-kernel habitat t2-probe` as
`gharunner` every hour over the root-owned checkout `/var/lib/aria/code`.

Owner: claude (implementation), okan (review). Deadline 2026-10-17.

## ARIA-HIGH-317 — The T2 boundary probe reported a breach every hour because it could not read the anchor

Evidence, measured on the droplet on 2026-10-03 against `c1d183969`:

- `aria-kernel/aria_kernel/main_anchor.py:74-77` — `scrubbed_git_env()` drops every `GIT_*`
  variable and sets `GIT_CONFIG_NOSYSTEM=1`, so a system-wide `safe.directory` never reaches the
  hardened git.
- `/var/lib/aria/code` (root 755) is a worktree whose git directory is
  `/var/aqua-saas/.git/worktrees/code` (root 755). As `gharunner`,
  `GIT_CONFIG_NOSYSTEM=1 git -C /var/lib/aria/code rev-parse origin/main` fails with
  `fatal: detected dubious ownership in repository at '/var/lib/aria/code'`; with
  `-c safe.directory=/var/lib/aria/code` it prints the commit.
- `aria-kernel/aria_kernel/habitat.py:305-306` — the unread allowed-signers file becomes the
  `allowed_signers_unavailable` violation, so `aria_t2_boundary_held` was 0 and
  `AriaT2BoundaryBreached` (critical) fired on every run. The timer was disabled on 2026-10-03 to
  stop the false page, which left the boundary unmeasured.

Rule: a reader that is not root must be able to read root's checkout through the hardened git, and
the hardened git must not trust any tree a lower account can rewrite (its config could run code as
the reader).

### Fix

`main_anchor._root_held_checkout` names `safe.directory` on the command line (git's protected
`command` scope) only when the reader is not root and every hop git takes from the checkout is
root's with no other writer: the worktree, the git directory (`.git` itself or the one a gitfile
names), the common directory a `commondir` file names, and the two pointer files. Every directory
above them must belong to root and must not let anyone else replace a child (group/world-writable
only with the sticky bit, and only for parents). The checkout path is resolved once and git runs in
(`-C`) and trusts exactly that real path, so a symlink swapped after the check cannot redirect it;
a symlinked `.git` is refused; pointer files are read non-blocking, regular-file-only and bounded to
4 KiB before git's timeout applies. Files inside the git directory (config, refs, objects) are not
inspected — git's own ownership check does not inspect them either; a root-held directory chain
means only root could have put them there. Root as the reader is unchanged (no exception), and a
GitHub-hosted clone is unchanged because the runner owns it, so the walk fails and git's default
applies.

Proof: `aria-kernel/tests/test_main_anchor_root_held_checkout.py` — predicate cases (owner, reader,
writable or sticky checkout, writable git directory, symlinked path resolved once, symlinked `.git`
refused, worktree git directory, a common directory outside the git directory's chain, writable
pointer files, a FIFO or oversized pointer refused without blocking, the `_git` argv); git itself
honouring the named real path through a symlink and refusing a sibling, run without root via
`GIT_TEST_ASSUME_DIFFERENT_OWNER`; and, as root, `main_tip` read by uid/gid 65534 with no
supplementary groups over a root-owned repository (fails on the old code with `'None' != <sha>`).
The first revision of this fix failed 4 of these and hung on the FIFO case (security-reviewer,
GSEC-MEDIUM-001/002, GSEC-LOW-003/004/005).

Not done here: re-enabling `aria-t2-probe.timer` waits for this to merge and
`/var/lib/aria/code` to move to the merge commit.

## ARIA-MEDIUM-320 — The probe's verdict passes through a directory the probed account can write

Raised by the security-reviewer pass over ARIA-HIGH-317 (outside that fix). Evidence on `main`:

- `scripts/aria/runner-habitat/systemd/aria-t2-probe.service:33-36` — `StateDirectory=aria-t2-probe`
  is created for `User=gharunner`; the probe writes `aria_t2_boundary.prom` there and the root
  `ExecStopPost` moves whatever file it finds into node-exporter's textfile directory.
- `scripts/aria/aria-t2-probe.sh:21-22` — the probe writes to the path it is given.

Any `gharunner` process can replace the file between the probe's write and root's move, publishing
`aria_t2_boundary_held 1` for a breached boundary.

Rule: a boundary probe's verdict reaches the monitor through a channel the probed account cannot
write.

Fix direction: let systemd (as root) open the destination and hand the probe only that descriptor
(`StandardOutput=truncate:<root-owned path>` with the probe printing the textfile body), so no
file the probed account owns sits on the path. The residual — same-uid ptrace of the running probe
— is bounded by `kernel.yama.ptrace_scope` (1 on the droplet, 2026-10-03). Not fixed in this
commit; owner claude, deadline 2026-10-31.
