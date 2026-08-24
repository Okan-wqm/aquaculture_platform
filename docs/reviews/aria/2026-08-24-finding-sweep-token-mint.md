# ARIA review — 2026-08-24: finding-state-sweep token mint crash (stale key + stale signature)

Triggered by the Scheduled Workflow Watchdog incident issue #1005: the daily
`finding-state-sweep.yml` lane failed at the `Mint GitHub App installation
token` step (run
`Okan-wqm/aquaculture_platform/actions/runs/32702963665`, 2026-08-24T07:46Z)
and kept the lane red, which in turn kept the hourly scheduled-workflow
watchdog red.

## Measured facts

- Run 32702963665 died with
  `TypeError: mint_installation_token() missing 2 required keyword-only arguments: 'cycle_id' and 'workspace_root'`
  — the workflow's inline mint call predated the V9.0-C keyword-only
  signature of `aria_kernel/gh_token_factory.py::mint_installation_token`.
- Even with the signature fixed, the call read `lease.token`, an attribute
  the frozen `InstallationTokenLease` dataclass never had (it carries
  `token_file`); the token string must be read from that file.
- The lane runs on `ubuntu-latest`, but both credentialed lanes
  (`finding-state-sweep.yml`, `aria-readiness-claim.yml`) pointed
  `ARIA_GH_APP_PRIVATE_KEY_PATH` at the operator runbook's path, which only
  exists on the self-hosted box — on a hosted runner the mint would fail
  closed as `private key unreadable`.
- Operator-side verification additionally surfaced a stale PEM at
  `/root/.config/aria/gh-app-private-key.pem` (mtime 2026-05-19, from a
  predecessor app) whose JWT GitHub rejects with HTTP 401. The key that
  matches App 4688779 is the 2026-08-23 copy under the runner user's config;
  the root copy has been replaced with it.
- With the correct key, the exact workflow snippet mints a Mode A `ghs_`
  installation token locally (`fallback_active=False`).

## ARIA-MEDIUM-018 — the sweep lane's App-token mint crashes and both hosted lanes reference an unreadable key path

The mint step can never succeed on any runner: the call signature is stale,
the returned attribute does not exist, and the key path secret points at a
file that does not exist on `ubuntu-latest`. The lane therefore falls out of
its contract of opening its sweep PR without human intervention and holds
the scheduled-workflow watchdog permanently red.

## Fix

`fix/finding-sweep-token-mint` — both lanes materialize the PEM content from
the new `ARIA_GH_APP_PRIVATE_KEY` repository secret into an ephemeral 0600
file under `RUNNER_TEMP`; the sweep mint passes
`cycle_id='finding-state-sweep-r<run_id>'` and `workspace_root='.'` and reads
the token from `lease.token_file`. The orphaned
`ARIA_GH_APP_PRIVATE_KEY_PATH` manifest entry is replaced by the content
secret and the `ARIA_GH_APP_*` entries flip to `provisioned: true`.
