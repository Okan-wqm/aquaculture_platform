# Runbook: Rebuilding the ARIA self-hosted runner

**Owner:** ARIA operator
**Related:** ORPHAN-HIGH-722 (PAT identity), ORPHAN-CRITICAL-591
(managed-login outage), RC-9 (`ensure-sandbox-backend`), Plan PROGRAM D
task HB-1
**Target:** fresh Ubuntu droplet → both ARIA lanes green in **≤ 1 hour**

## Purpose

ARIA's entire runtime habitat is one machine: the self-hosted GitHub
Actions runner that `aria-auto-cycle` (01:13 UTC producer) and
`aria-agent-executor` (drain; `workflow_run` + 02:29 UTC cron) run on.
ARIA's _state_ survives the machine (it lives on the `aria/state`
branch), but the _habitat_ — runner service, sandbox backend, secrets
file, Claude login, policy override — existed only as hand-applied
history until this runbook. This is the from-scratch rebuild procedure.

Companion drift-checker: `scripts/aria/provision_runner.sh --dry-run`
prints ✓/✗ per check and exits 0 only when the machine already matches.
Run it first on a partially-alive machine; on a truly fresh droplet just
follow the steps in order (the script automates steps 1–2 outside
`--dry-run`).

**Never put a secret VALUE in this repo, in a workflow file, or in a
shell history you keep.** This runbook names keys and their sources
only.

## Live-machine facts (the target shape)

| Fact               | Value                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Repository         | `Okan-wqm/aquaculture_platform`                                                             |
| Runner user        | `gharunner`                                                                                 |
| Runner root        | `/home/gharunner/actions-runner`                                                            |
| Runner name        | `suderra-droplet-claude`                                                                    |
| Labels             | `self-hosted`, `linux`, `claude` (both lanes pin `runs-on: [self-hosted, linux, claude]`)   |
| systemd service    | `actions.runner.Okan-wqm-aquaculture_platform.suderra-droplet-claude.service`               |
| Secrets file       | `/home/gharunner/actions-runner/.env` (keys: `ARIA_GH_TOKEN`, `ARIA_OBSERVABILITY_API_KEY`) |
| Claude CLI floor   | `2.1.197` (both lanes' preflight rejects older)                                             |
| Workspace checkout | `/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform`            |

Exactly ONE runner carries this label set. Both lanes share one
persistent workspace serialized by the `aria-selfhosted-workspace`
concurrency group (Z1, ORPHAN-712); registering a second runner with the
same labels reintroduces the workspace races that group exists to
prevent.

## Step 0 — Prerequisites (5 min)

- Fresh Ubuntu 22.04/24.04 x64 droplet, root shell.
- A repo **admin** able to mint a runner registration token
  (Settings → Actions → Runners → New self-hosted runner) and a
  fine-grained PAT (step 3).
- Read access to the production compose env file on the droplet (source
  of the observability key value, step 3).
- The operator's Claude subscription account for the managed login
  (step 4). API keys are NOT a substitute — the lanes hard-fail when
  `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set.
- Egress to `github.com`, `api.github.com`, `api.anthropic.com`.
- Create the service account: `useradd -m -s /bin/bash gharunner`
  (the provision script does this too).

## Step 1 — OS dependencies + sandbox capability (5 min)

```bash
apt-get update
apt-get install -y --no-install-recommends bubblewrap jq git curl python3
```

`bubblewrap` is the sandbox backend every write-capable agent spawn
requires; without a verified backend the kernel refuses the spawn
(fail-closed, ORPHAN-CRITICAL-439). Installing it up front means the
lanes' `ensure-sandbox-backend` action — which probes BEFORE installing —
never needs apt or sudo on the hot path. `jq` is used directly by the
executor lane's queue step.

Capability, not presence (a host with user namespaces disabled carries a
working `bwrap` binary that fails every invocation):

```bash
cat /proc/sys/kernel/unprivileged_userns_clone   # want 1; file absent = kernel default-enabled
cat /proc/sys/user/max_user_namespaces           # want > 0
```

If either knob blocks, persist the fix via `/etc/sysctl.d/` (the
provision script writes `99-aria-userns.conf`). Final authority is the
kernel's own probe — the same accessor the runtime consults:

```bash
PYTHONPATH=aria-kernel python3 -c \
  'from aria_kernel.implementation_safety import sandbox_backend; print(sandbox_backend())'
```

(Python provisioned per-run by `setup-aria-kernel` inside jobs; Node 20
by `actions/setup-node`; repo-local `node_modules` by
`ensure-node-deps`. None of those are host installs.)

## Step 2 — Runner install + registration (10 min)

Official actions-runner tarball flow, as `gharunner`:

```bash
mkdir -p /home/gharunner/actions-runner && cd /home/gharunner/actions-runner
RUNNER_VERSION=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name | ltrimstr("v")')
curl -fsSL -o runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
tar xzf runner.tar.gz && rm runner.tar.gz
chown -R gharunner:gharunner /home/gharunner/actions-runner

# Registration token: Settings → Actions → Runners → New self-hosted runner
# (or: gh api -X POST repos/Okan-wqm/aquaculture_platform/actions/runners/registration-token --jq .token)
# It expires in ~1 hour and is single-purpose — export it, never store it.
sudo -u gharunner env RUNNER_REG_TOKEN="<token>" bash -c \
  'cd /home/gharunner/actions-runner && ./config.sh \
     --url https://github.com/Okan-wqm/aquaculture_platform \
     --token "$RUNNER_REG_TOKEN" \
     --name suderra-droplet-claude \
     --labels claude \
     --unattended'
```

`--labels claude` yields the full set `self-hosted,linux,claude`
(`self-hosted` and `linux` are implicit). Then install as a systemd
service, running as `gharunner`:

```bash
cd /home/gharunner/actions-runner
./svc.sh install gharunner
./svc.sh start
systemctl status actions.runner.Okan-wqm-aquaculture_platform.suderra-droplet-claude.service
```

## Step 3 — Secrets provisioning: the runner `.env` (10 min)

`/home/gharunner/actions-runner/.env` — key=value lines the runner
service loads at start and injects into every job's environment. This is
the machine-local secret channel: values never enter the repo, GitHub
secrets, or workflow files. **Every edit requires a service restart**:

```bash
sudo systemctl restart actions.runner.Okan-wqm-aquaculture_platform.suderra-droplet-claude.service
```

Keep it `chown gharunner: && chmod 600`. Two keys (NAMES only here):

### `ARIA_GH_TOKEN` — ARIA's PR identity (ORPHAN-HIGH-722)

PRs opened with the job token are authored by `github-actions[bot]` and
GitHub parks bot-PR workflows in `action_required`, so ARIA's own PRs
never get CI. The kernel-run steps in both lanes export this PAT as
`GH_TOKEN` when present; a token-less runner degrades to the job-token
fallback rather than failing.

Mint (GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → Generate new token):

- **Repository access:** Only select repositories →
  `Okan-wqm/aquaculture_platform` (this repo ONLY).
- **Permissions:** Contents = Read and write; Pull requests = Read and
  write. **Workflows = NOT granted** — deliberately withheld so
  kernel/workflow-file writes stay operator-gated.
- Expiration per operator policy; rotation = re-mint, replace the line
  in `.env`, restart the service.

### `ARIA_OBSERVABILITY_API_KEY` — production telemetry pull (E24-a)

The watchdog's pull policy (`aria-kernel/aria_kernel/genesis_policy.py`,
`watchdog_pull.api_key_env`) names this variable; only the NAME ever
enters policy or ledgers. The value is the observability-service
`INTERNAL_API_KEY` — supplied to the service as
`OBSERVABILITY_INTERNAL_API_KEY` in the production compose env
(`docker-compose.droplet.yml` requires it). Copy that value from the
droplet's compose env file into the runner `.env` under the ARIA name.
Rotating the observability key means updating both places.

## Step 4 — Claude Code managed-login checklist (10 min)

ARIA's live runtime is Claude Code CLI under a **managed (subscription)
login** on this trusted runner (`docs/aria/CURRENT_STATE.md` §Runtime).
API-key mode is rejected by both lanes' preflight.

1. Install Claude Code so the `gharunner` user can run it; verify the
   floor: `sudo -u gharunner claude --version` ≥ `2.1.197`.
2. Log in interactively AS `gharunner` (`sudo -u gharunner -i claude`,
   then `/login`) with the managed subscription account.
3. Confirm no API-key variables anywhere in the runner environment or
   `.env`: `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
   must all be absent — preflight hard-fails when one is set.
4. Evidence the preflight checks: `/home/gharunner/.claude/.credentials.json`
   (or `config.json`; `CLAUDE_CONFIG_DIR` respected) exists.
5. Live smoke: `sudo -u gharunner claude -p "say OK"` returns OK.
   ORPHAN-CRITICAL-591 is why this step exists: an expired OAuth session
   made five nights of executor runs fail as `claude_cli_exit_1`. The
   failure now names itself (`claude_cli_auth_failure`), but renewal is
   always this manual credential act — sessions expire, so re-run this
   checklist whenever a night reports auth failure.

## Step 5 — State-store bootstrap pointer (2 min)

Nothing to rebuild: ARIA's whole runtime state travels on the
`aria/state` branch and the lanes' `restore-aria-state` action checks it
out per run. Confirm it is reachable:

```bash
git ls-remote --exit-code origin refs/heads/aria/state
```

**Never set `ARIA_STATE_BOOTSTRAP_ACK` on a rebuild.** A machine rebuild
is not a first bootstrap; an armed ack is how accumulated history gets
replaced with emptiness. If the branch is genuinely gone, follow
`docs/runbooks/aria-state-branch-bootstrap.md` — including its
recover-before-bootstrap discipline — and do not improvise past a
refusal (exit 3 is a verdict, not a fault).

## Step 6 — Policy-override restore, BOTH locations (3 min)

The kernel resolves the operator policy override relative to whichever
repo root it runs against (`genesis_policy.py`,
`OVERRIDE_RELPATH = "aria-config/genesis_policy.json"`). Two roots exist
on this machine, so the override lives in two places and they must stay
byte-identical:

1. the operator clone — `<repo>/aria-config/genesis_policy.json`
   (live machine: `/var/aqua-saas/...`) — read by operator- and
   daemon-invoked kernel commands;
2. the runner workspace copy —
   `/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/aria-config/genesis_policy.json`
   — read by anything run against the persistent workspace checkout.

The repo tracks a baseline override (X1 cost caps, PR #1258), which a
checkout restores. Any machine-local delta on top of it (the file is
deployment state — see the `circuit_breaker_policy` docstring) must be
re-applied to BOTH copies after a rebuild; `provision_runner.sh` mirrors
the operator-clone copy into the workspace when the latter is missing.

## Step 7 — Verification (15 min)

1. **Runner online:** Settings → Actions → Runners shows
   `suderra-droplet-claude` Idle with labels `self-hosted, linux,
claude` (or `gh api repos/Okan-wqm/aquaculture_platform/actions/runners`).
2. **Capability probe:** dispatch the diagnostic lane and read its log —
   every host fact this runbook provisioned, reported by the runtime's
   own accessors:

   ```bash
   gh workflow run aria-runner-capability-probe.yml
   ```

   Expect `sandbox_backend=bubblewrap`, the userns knobs readable, and
   sane sudo/apt lines.

3. **One manual cycle:**

   ```bash
   gh workflow run aria-auto-cycle.yml -f mode=cycle
   ```

   A healthy run shows, in order: the CLI preflight passing the
   `2.1.197` floor, `aria/state checked out (restored)` (NOT
   `bootstrap`), `gh identity: machine PAT (ARIA_GH_TOKEN)` in the cycle
   step, and a green `Publish ARIA state to the aria/state branch` step.
   The executor drain follows automatically via `workflow_run`.

4. **Drift gate:** `scripts/aria/provision_runner.sh --dry-run` exits 0.

## References

- Lanes: `.github/workflows/aria-auto-cycle.yml`, `.github/workflows/aria-agent-executor.yml`
- Composite actions: `.github/actions/{setup-aria-kernel,ensure-sandbox-backend,restore-aria-state}`
- Diagnostic: `.github/workflows/aria-runner-capability-probe.yml`
- State store: `docs/runbooks/aria-state-branch-bootstrap.md`
- Runtime authority: `docs/aria/CURRENT_STATE.md` §Runtime
- PAT provenance: `docs/reviews/orphan-findings.md` ORPHAN-HIGH-722
