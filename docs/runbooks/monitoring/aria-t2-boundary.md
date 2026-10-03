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

## AriaT2BoundaryBreached

1. Read the reasons: `aria_t2_boundary_violation{reason=...}` in Prometheus, or run the probe by
   hand: `sudo -u gharunner /var/lib/aria/code/scripts/aria/aria-t2-probe.sh` (exit 3 = breached;
   the JSON names each violation and never prints a secret).
2. Stop ARIA from acting while the boundary is open (`aria-kernel control pause`), and treat every
   operator request, MCP approval and enrolment signed since the last held probe as suspect.
3. Close the reason at its source: remove `gharunner` from the `docker` group or sudoers, restore
   `/root` to mode 700, remove the token from `/home/gharunner/actions-runner/.env` and revoke it,
   or remove the runner key through a signed enrolment (`aria-kernel feedback enrol`, ADR-0023).
   `runner_key_registry_unavailable` and `allowed_signers_unavailable` mean the probe could not
   read the runner's store or the root-owned checkout: repair the read, then re-run the probe.
4. Re-run the probe; the alert resolves when `aria_t2_boundary_held` is 1.

## AriaT2BoundaryProbeSilent

The probe has not published a verdict for two hours, so the boundary is unmeasured.

1. `systemctl status aria-t2-probe.timer aria-t2-probe.service` and
   `journalctl -u aria-t2-probe.service --since -3h`.
2. Not installed: `sudo scripts/aria/provision_runner.sh` (apply mode) installs and enables it with
   the rest of the runner habitat; `--dry-run` reports it. `/var/lib/aria/code` must hold a checkout
   that has the probe verb.
3. Failing before it writes: the journal names the error; fix it and run the service once by hand.
