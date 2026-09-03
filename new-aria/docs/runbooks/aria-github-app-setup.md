<!-- ARIA-CURRENT-STATE-NOTICE: Historical/compatibility runbook. For live ARIA runtime authority, see docs/aria/CURRENT_STATE.md and executable contracts. Snowball branch-protection instructions below are compatibility material unless reaffirmed there. -->

# Runbook — ARIA GitHub App Setup (V9.0-C precondition)

**Owner:** Operator (Okan)
**Phase:** Plan ARIA-V9 + V10 v3 — V9.0-C precondition (post-code-only scope)
**Status:** OPEN — required BEFORE the autonomous profile's 20-cycle endurance gate (Phase 10.3-B). Optional during V9 5-cycle smoke (Phase 10.3-A); operator-PAT fallback mode acceptable.

## Why this runbook exists

V9 ships ARIA's first WRITER agent (`aria-implementer` with `Edit + Write + Bash` tools, autonomous PR opener). Security-reviewer audit (CRIT-001 / CRIT-002) flagged that the operator's `GH_TOKEN` (per-memory: stored at `/root/.config/gh/environment.sh`, `repo`-full scope) is too broad for an LLM-driven writer:

- Full `repo` scope = push to ANY branch including `main`, modify branch protection, install webhooks, exfiltrate every secret in repo settings
- Plan v3 mitigation: two-token model:
  1. Long-lived operator PAT — preflight ONLY (read branch protection)
  2. Per-cycle scoped installation token via a GitHub App — passed to `aria-implementer` (5-min TTL, scoped to `pull_requests:write + contents:write` on `refs/heads/aria-impl-*` only)

V9.0-C kernel code ships the FACTORY (`aria_kernel/gh_token_factory.py`) with TWO operating modes:

- **Mode A — GH App configured** (production-correct, this runbook's target state)
- **Mode B — operator-PAT fallback** (V9.0-C SHIM; works but emits `installation_token_fallback_active` governance event on every mint)

The V10.3-A 5-cycle smoke runs in Mode B (acceptable — dry-run, no merges). The V10.3-B 20-cycle endurance gate requires Mode A.

## Mode A setup steps (operator-side, ~30 min)

### 1. Create the GitHub App

1. Navigate to https://github.com/settings/apps → "New GitHub App"
2. Name: `aria-implementer-{your-suffix}` (must be globally unique; pick something like `aria-implementer-okan`)
3. Homepage URL: `https://github.com/Okan-wqm/aquaculture_platform`
4. Webhook: **disable** (uncheck "Active") — ARIA polls, no webhook needed
5. Permissions (repository scope):
   - **Pull requests:** Read and write
   - **Contents:** Read and write
   - **Metadata:** Read-only (required by all GitHub Apps)
   - Everything else: **No access**
6. "Where can this app be installed?" — **Only on this account**
7. Click "Create GitHub App"

### 2. Generate + install the app's private key

1. On the new app's settings page, scroll to "Private keys" → "Generate a private key"
2. Save the downloaded `.pem` file to a secure location: `~/.config/aria/gh-app-private-key.pem`
3. `chmod 600 ~/.config/aria/gh-app-private-key.pem`

### 3. Install the app on this repo

1. On the app settings page, click "Install App" in the left sidebar
2. Pick "Only select repositories" → choose `aquaculture_platform`
3. Click Install
4. Note the installation ID from the URL: `https://github.com/settings/installations/<INSTALLATION_ID>`

### 4. Configure environment

Append to `/root/.config/gh/environment.sh` (the file the operator's session already sources):

```bash
# Plan ARIA-V9.0-C GitHub App credentials (runbook docs/runbooks/aria-github-app-setup.md)
export ARIA_GH_APP_ID="<your-app-id-from-app-settings-page>"
export ARIA_GH_APP_INSTALLATION_ID="<installation-id-from-step-3>"
export ARIA_GH_APP_PRIVATE_KEY_PATH="$HOME/.config/aria/gh-app-private-key.pem"

# gh CLI auto-detects these envvars and mints the JWT internally.
# Verify after sourcing:
#   gh api /app/installations/$ARIA_GH_APP_INSTALLATION_ID
# should return the installation record.
```

### 5. Add the required branch protection rules on `snowball`

The V9.0-C preflight (`aria_kernel/preflight.py`) asserts 4 rules on `snowball` before allowing the autonomous profile. Configure via the GitHub UI:

Settings → Branches → Branch protection rules → Add rule (pattern: `snowball`):

- [x] **Require a pull request before merging**
- [x] **Require approvals: 1** (operator review even for ARIA PRs)
- [x] **Require status checks to pass before merging**
- [x] **Require branches to be up to date before merging** ← `required_status_checks.strict = true`
- [x] **Require signed commits** ← `required_signatures.enabled = true`
- [x] **Require linear history**
- [x] **Restrict who can push to matching branches** → add `aria-implementer-okan` (the GitHub App's bot account) AND `Okan-wqm` ← `restrictions.users = [...]` non-empty
- [x] **Do not allow bypassing the above settings** ← `enforce_admins.enabled = true`

### 6. Verify

```bash
# 1. Source the env
source /root/.config/gh/environment.sh

# 2. Test app token mint
gh api -X POST /app/installations/$ARIA_GH_APP_INSTALLATION_ID/access_tokens \
  -f permissions[pull_requests]=write \
  -f permissions[contents]=write

# Should return {"token": "ghs_...", "expires_at": "<5-min-future>"}

# 3. Test preflight
PYTHONPATH=aria-kernel python3 -c "
from aria_kernel.preflight import verify_preflight
v = verify_preflight(profile='autonomous', workspace_root='.')
print('valid =', v.valid)
print('reasons =', v.reasons)
print('gh_app_installation =', v.gh_app_installation)
print('immutable_paths_count =', v.immutable_paths_count)
print('bash_allowlist_count =', v.bash_allowlist_count)
"
```

`valid == True` is the operator-visible signal that the runbook is complete.

## Mode B fallback (no GH App yet)

If you want to run V9 5-cycle smoke before the GH App is set up, no setup is required — `mint_installation_token` falls back to `GH_TOKEN` and `mint_signing_key` works as long as `ssh-keygen` is on PATH.

Caveats in fallback mode:
- Every cycle emits `installation_token_fallback_active` governance event — expected
- Token scope = operator PAT scope (broad); review `aria-implementer`'s diff manually before approving merge
- 20-cycle endurance (10.3-B) under autonomous profile WILL fail preflight in fallback mode — that gate requires Mode A

## Rollback

To revert to Mode B without uninstalling the GH App, comment out the `export ARIA_GH_APP_INSTALLATION_ID=` line in `environment.sh` and re-source. Preflight will fall back without any kernel code change.

## Related invariants

- `aria-kernel/tests/invariants/v9/test_phase_v9_0_c_preflight.py::test_i_v9_preflight_*` — preflight contract pins
- `aria-kernel/tests/invariants/v9/test_phase_v9_0_c_gh_token_factory.py::test_i_v9_token_factory_*` — signing key + token mint contracts
- `aria_kernel/preflight.py::REQUIRED_BRANCH_PROTECTION_FIELDS` — the 4 required rules SSoT

## Audit log

Each operator action on this runbook should land a row in `aria-tools/operator-feedback.jsonl` (V9.0-A `OPERATOR_FEEDBACK` PlanCandidateSource) with signature. Until V9.4 ships the signed-feedback enforcement, operator may simply record completion in `aria-findings/F-015.json` `subfindings` → `F-015-V9-0-C-runbook` status update.
