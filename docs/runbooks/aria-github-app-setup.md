<!-- ARIA-CURRENT-STATE-NOTICE: Operator runbook, kept to the code it names.
Live ARIA runtime authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# Runbook — ARIA GitHub App

**Owner:** ARIA operator
**Related:** ARIA-HIGH-206, ARIA-HIGH-208, ARIA-HIGH-213 (plan 036, step 3 and step 5)

## Why

Every credential ARIA uses to write to GitHub is an installation token of one GitHub App, minted
per use by `aria-kernel/aria_kernel/gh_token_factory.py` (`mint_installation_token`, Mode A). It
merges ARIA's PRs, and it is the author of every PR ARIA opens. A PR opened with the job token
leaves its workflows in `action_required`, so the merge chain never starts. The lanes therefore set
`ARIA_REQUIRE_MODE_A=true`: without the App, the mint refuses by name instead of falling back to a
PAT or the job token (Mode B).

## 1. App permissions

GitHub → Settings → Developer settings → GitHub Apps → the ARIA App → Permissions & events.
Webhook off. Repository permissions, exactly:

| Permission      | Access         | Used for                                                         |
| --------------- | -------------- | ---------------------------------------------------------------- |
| Contents        | Read and write | pushing ARIA branches, squash merges                             |
| Pull requests   | Read and write | opening and merging ARIA PRs                                     |
| Administration  | Read-only      | branch-protection proof, self-hosted runner roster preflight     |
| Metadata        | Read-only      | required by every App                                            |
| Checks          | Read-only      | required-checks gate in the merge lane                           |
| Commit statuses | Read-only      | required-checks gate in the merge lane                           |
| Issues          | Read-only      | watchdog merge freeze (`watchdog_freeze`) read by the merge lane |
| Actions         | Read-only      | rollback bundle artifact downloaded by the merge lane's verifier |
| Everything else | No access      |                                                                  |

The token sets are named in the factory: `DEFAULT_INSTALLATION_TOKEN_PERMISSIONS` (contents,
pull requests, administration), `MERGE_LANE_INSTALLATION_TOKEN_PERMISSIONS` (default plus checks,
statuses, issues, actions) and `RUNNER_STATUS_PERMISSIONS` (administration only). A mint that asks
for a permission the installation has not granted fails with HTTP 422.

## 2. Accept the permissions on the installation

Changing an App's permissions does not change its installation. As the repository owner: GitHub →
Settings → Applications → Installed GitHub Apps → the ARIA App → Configure, then review and accept
the requested permissions. The installation must cover `Okan-wqm/aquaculture_platform`. Until the
request is accepted, the merge lane's mint fails with HTTP 422.

## 3. Repository secrets

Repository → Settings → Secrets and variables → Actions → Repository secrets:

| Secret                        | Value                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| `ARIA_GH_APP_ID`              | the App ID (App settings page)                                       |
| `ARIA_GH_APP_INSTALLATION_ID` | the number in `https://github.com/settings/installations/<id>`       |
| `ARIA_GH_APP_PRIVATE_KEY`     | the full PEM, `-----BEGIN` and `-----END` lines included, not a path |

```bash
gh secret set ARIA_GH_APP_ID --body '<app-id>'
gh secret set ARIA_GH_APP_INSTALLATION_ID --body '<installation-id>'
gh secret set ARIA_GH_APP_PRIVATE_KEY < aria-app.private-key.pem
```

Each consuming step writes the PEM into a 0600 file under `$RUNNER_TEMP`, outside the workspace,
and points `ARIA_GH_APP_PRIVATE_KEY_PATH` at it. `.github/provisioned-secrets.json` lists every
workflow that reads the three secrets.

## 4. Where the App is used

- `aria-readiness-claim.yml` — mints a token for the branch-protection proof in the readiness
  claim.
- `aria-merge-runner.yml` — mints the merge token with `MERGE_LANE_INSTALLATION_TOKEN_PERMISSIONS`
  and revokes it on exit. Runs after `aria-readiness-claim`, after a green `CI - Affected` run of a
  pull request, and hourly.
- `aria-auto-cycle.yml` and `aria-agent-executor.yml` — the delivering steps hand the App to the
  delivery hold (`delivery_credentials`), which mints a token for each push and `gh pr create`
  and revokes it after. The executor opens implementation PRs, the cycle opens self-revert PRs.
- Every self-hosted lane's `runner-preflight` job (`.github/actions/require-self-hosted-runner`)
  mints an administration-read token to read the runner roster.

## 5. `ARIA_REQUIRE_MODE_A`

Each step above sets `ARIA_REQUIRE_MODE_A: 'true'`. With it, a missing
`ARIA_GH_APP_INSTALLATION_ID` fails the mint with
`ARIA_REQUIRE_MODE_A=true but ARIA_GH_APP_INSTALLATION_ID is unset; Mode B fallback FORBIDDEN`.
Do not remove it to get a run green: the fallback token is the job token or a PAT, and a PR it
opens never reaches the merge chain. Fix the App, its installation or the secrets instead.

## 6. Branch protection on `main` (O1b)

The merge gate's proofs expect this shape. Classic protection on `main`:

- the 4 required checks `sens-enterprise-summary`, `merge-gate`, `aria-merge-authority` and
  `build-status`, each pinned to the GitHub Actions app (SSoT:
  `.github/manifests/main-required-status-checks.json`);
- signed commits required;
- pull request required with 0 approvals and Code Owners review required;
- conversation resolution required;
- `enforce_admins` on;
- force pushes and deletions blocked.

In addition, at least one active ruleset targets `main` with `bypass_actors: []` (an empty list,
not absent or `null`), and a ruleset on `main` requires a **merge queue** with the **squash** merge
method (ARIA-HIGH-221, operator decision 2026-09-26). The kernel reads the queue from
`rules/branches/main` (a `merge_queue` rule with `merge_method: SQUASH`); the preflight and every
readiness claim refuse a `main` without one (`merge_queue_required`,
`branch_protection_merge_queue_method_must_be_squash`).

"Require branches to be up to date" (`strict`) is not what makes a merge safe here: an ARIA PR's
evidence is bound to its head, and updating the branch would move that head. The queue tests the
change on top of current `main` in a merge group instead, and both workflows that produce the
required checks run on `merge_group`. The kernel neither requires nor refuses `strict`; it records
it (`strict_up_to_date_required`). The manifest above still pins `strict: true`, as its own gate
(`tools/gates/required-status-checks.ts`) and `postgres-dr-bootstrap-candidate.yml` check; that pin
is outside the merge lane.

The merge lane's `gh pr merge --squash --match-head-commit` therefore usually **enqueues** the PR.
The lane records `enqueued`. On its next run it settles the entry: into `merged` when the queue
merged the PR at that head, or into `dequeued` when the queue removed it or the PR closed or moved.
A dequeued PR is a candidate again once its head holds a claim.

## 7. Verify

```bash
gh api repos/Okan-wqm/aquaculture_platform/branches/main/protection
gh api repos/Okan-wqm/aquaculture_platform/rules/branches/main
gh workflow run aria-merge-runner.yml
```

The merge-runner run must pass "Run the merge lane" without an HTTP 422 or a Mode A refusal. With
no PR holding a readiness claim it merges nothing and still succeeds. The rules listing must show a
`merge_queue` rule with `"merge_method": "SQUASH"`.
