# Runbook — ARIA T2 boundary

**Alerts:** `AriaT2BoundaryBreached` (critical), `AriaT2BoundaryProbeSilent` (warning) · **Rule:**
`infrastructure/monitoring/droplet/rules/80-aria-t2-boundary.yml` · **Decision:** ADR-0023
(`docs/recommendations/architectural-arbiter/2026-10-02-adr-0023-signature-namespace-registry.md`)

**Meaning.** ARIA's runner (T2, the `gharunner` account) must never sign or approve as the operator.
`aria-t2-probe.timer` (`scripts/aria/runner-habitat/systemd/`) runs `aria-kernel habitat t2-probe`
as `gharunner` every hour. It checks that the account is not root, cannot open
`/root/.ssh/aria-operator-signing`, has no sudo, is not in the docker group and cannot reach the
docker socket, that the runner `.env` holds no personal access token, and that no key it holds or
the kernel registered for it (`kg_signers`) is enrolled in `.github/manifests/aria-operator-signers`
on main.

**Anchor freshness and read (ARIA-HIGH-281).** Before each probe, the unit's
root `ExecStartPre` fetches `main` into `refs/remotes/origin/main` of
`/var/lib/aria/code` over anonymous https. It runs no hook
(`core.hooksPath=/dev/null`) and no credential helper (an empty
`credential.helper` resets them all), so root runs nothing the checkout or a
token store selects. It never checks out, so the code the ARIA units run
changes only by the operator's refresh below. `gharunner` then reads the
allowed-signers file at that commit through the kernel's root-owned trust rule
(`_root_owned_trusted` in `aria-kernel/aria_kernel/main_anchor.py`): git is
told the checkout is safe only when root alone can change the configuration
git acts on there, the question git's own ownership guard asks. On the droplet
the checkout is a linked worktree, so that covers
`/var/lib/aria/code` and its `.git` gitfile, the gitdir
`/var/aqua-saas/.git/worktrees/code`, the common dir `/var/aqua-saas/.git`
with its `config` and `config.worktree`, and every ancestor. Each must be
root-owned with no group/other write bit; an ancestor may be sticky instead.

## AriaT2BoundaryBreached

1. Read the reasons: `aria_t2_boundary_violation{reason=...}` in Prometheus, or run the probe by
   hand: `sudo -u gharunner /var/lib/aria/code/scripts/aria/aria-t2-probe.sh` (exit 3 = breached;
   the JSON names each violation and never prints a secret).
2. Stop ARIA from acting while the boundary is open (`aria-kernel control pause`), and treat every
   operator request, MCP approval and enrolment signed since the last held probe as suspect.
3. Close the reason at its source: remove `gharunner` from the `docker` group or sudoers, restore
   `/root` to mode 700, remove the token from `/home/gharunner/actions-runner/.env` and revoke it,
   or remove the runner key through a signed enrolment (`aria-kernel feedback enrol`, ADR-0023).
   `runner_key_registry_unavailable` means the probe could not read the
   runner's store. `allowed_signers_unavailable` means it could not read the
   allowed-signers file on `origin/main` from `/var/lib/aria/code`: either
   `refs/remotes/origin/main` is missing there, or a path the trust rule above
   covers is no longer root-only, so git refuses the checkout (`namei -l` and
   `stat -c '%U %a %n'` name the path). Restore root ownership and mode, never
   widen it to `gharunner`; then re-run the probe.
4. Re-run the probe; the alert resolves when `aria_t2_boundary_held` is 1.

## AriaT2BoundaryProbeSilent

The probe has not published a verdict for two hours, so the boundary is unmeasured.

1. `systemctl status aria-t2-probe.timer aria-t2-probe.service` and
   `journalctl -u aria-t2-probe.service --since -3h`.
2. Not installed: `sudo scripts/aria/provision_runner.sh` (apply mode) installs and enables it with
   the rest of the runner habitat; `--dry-run` reports it. `/var/lib/aria/code` must hold a checkout
   that has the probe verb.
3. Failing before it writes: the journal names the error; fix it and run the service once by hand.
   A failing `ExecStartPre` is the root fetch of `main`: a GitHub outage or a
   DNS failure clears on the next hourly run. The fetch is anonymous https: the
   unit resets every credential helper, so the operator's `gh` token is never
   used. If the repository becomes private (ARIA-HIGH-272) it fails every hour
   until root holds a read-only deploy key for it; that credential is an
   operator decision. A run whose probe returned no verdict (exit other than 0
   or 3) publishes nothing, so the last verdict ages and this alert fires; no
   run is published as `held` without a probe.

## One-time host act after the ARIA-HIGH-281 fix merges

The checkout last moved on 2026-10-03, so refresh it before the timer runs;
otherwise the probe judges an anchor with a kernel older than the fix. As
root:

```bash
# no repository hook runs as root (core.hooksPath=.husky is relative to the checkout)
git -c core.hooksPath=/dev/null -C /var/lib/aria/code fetch origin main
git -c core.hooksPath=/dev/null -C /var/lib/aria/code checkout --detach origin/main
# installs the unit, reloads systemd, enables the timer
/var/lib/aria/code/scripts/aria/provision_runner.sh
systemctl start aria-t2-probe.service
journalctl -u aria-t2-probe.service -n 20
```

ARIA-HIGH-281 closes only on a journal line from this host showing
`"held": true` with `allowed_signers_commit` equal to `origin/main`'s tip.
