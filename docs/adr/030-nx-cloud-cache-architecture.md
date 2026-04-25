# ADR-030: Nx Cloud Distributed Cache for CI Test/Build/Lint/Type-Check Pipelines

**Status:** Accepted (2026-04-25)
**Date:** 2026-04-25
**Deciders:** Okan (platform owner)
**Owner:** Okan (provisions the `NX_CLOUD_ACCESS_TOKEN` secret)
**Deadline:** Provision the Nx Cloud workspace + repo secret before merging the cold-audit cherry-pick stack (PRs #118-#130).
**Related ADRs:** none (greenfield CI infra decision)
**Related plans:** `docs/plans/2026-04-22-cold-audit-remediation/README.md` (the campaign whose PRs surfaced this gap)

---

## Context (WHY)

Every PR opened against `main` runs the four `nx affected -t {test,type-check,lint,build}` jobs. Their wall-clock time on the workflow's GitHub-hosted `ubuntu-latest` runners (2 vCPU, 7 GB RAM) is structurally above the per-job timeout:

| Job | Timeout | Observed | Outcome |
|---|---|---|---|
| `test` | 35 min | 35 min 0s — `##[error]The action 'Run tests (affected only)' has timed out after 35 minutes.` | timeout-killed |
| `type-check` | 35 min | 35 min 0s — same shape | timeout-killed |
| `lint` | 35 min | 35 min 0s — same shape | timeout-killed |
| `build` | 45 min | 45 min 0s — same shape | timeout-killed |

This is not a single-test-suite slowness. It is the cumulative cost of running ~17 backend services + ~17 frontend modules + ~30 libs on a single 2-vCPU runner with `--parallel=2` and no cross-PR cache. The cold scope is bounded by the size of the workspace, not by the size of any one PR's diff. A 2-line PR (e.g. PR #118 — a single new gate file) re-runs everything because:

1. `nx.json` already declares the right `targetDefaults` + `namedInputs`. The graph is well-formed — Nx correctly identifies which projects are affected.
2. The `ci-affected.yml` workflow restores `.nx/cache` via `actions/cache/restore@v4` keyed on `package-lock.json` hash. Cache hits work for runs whose lockfile hash matches.
3. **What is missing:** a *cross-PR* cache. When PR #119 runs `nx test`, it cannot see results PR #118 already computed for the same project at the same input hash. Local `.nx/cache` lives inside the runner VM and dies with it.

The architecturally correct fix for "cold builds always exhaust the runner timeout" is **distributed task execution + remote computation cache**, which is exactly what Nx Cloud is designed to provide. With Nx Cloud connected:

- A target invocation hashes its inputs against the cloud cache. If a previous run anywhere in the workspace produced the same hash, Nx replays the artifact in <1 s.
- New target invocations write their result back to the cloud cache.
- The same `nx affected -t test` invocation, on the same hardware, after the first PR primes the cache, takes ~3-5 min on cold inputs and ~30 s on warm inputs.

### The current `nx.json` is BROKEN at the cloud-token level

`nx.json:4` (pre-this-ADR) reads:

```json
"nxCloudAccessToken": "${NX_CLOUD_ACCESS_TOKEN}"
```

This is a literal-string token — Nx does **not** template environment variables inside `nx.json`. Nx treats the value `${NX_CLOUD_ACCESS_TOKEN}` (the literal 27-char string including dollar-sign and braces) as the access token, presents it to the cloud API, gets rejected with a 401, and silently falls back to local-only cache. The line has the appearance of cloud connectivity but provides none.

### Rejected Alternatives

| Alternative | Reason rejected |
|---|---|
| **Bump job timeouts** (35 → 60, 45 → 90) | Workaround, not a fix. The underlying issue — every PR rebuilds the whole workspace from cold — is not addressed. The next runner regression OR the next 5-service growth pushes us back over the new timeout. Banned per CLAUDE.md "Architectural Approach" — patches forbidden. |
| **Larger paid runners** (e.g. `ubuntu-latest-4-cores`) | Linear cost scaling per minute per PR, no cache reuse benefit. A 4-core runner that re-builds everything cold is still ~20 min for `nx affected -t build`; not a structural fix. Adds non-trivial billing cost. |
| **Permanent PROC-MEDIUM-006 amnesty** (skip these gates on every PR) | Tier-3 detect → tier-4 monitor regression. Gate failures stop being surfaced; the campaign's ESLint regression-guards (`no-restricted-syntax::getRepository`, `no-restricted-imports::backend-common`) lose their CI footprint. Net loss of architectural coverage. |
| **Self-hosted runner farm** | Operational scope creep — runner provisioning, image patching, secret distribution, scaling rules. Inappropriate for a problem Nx Cloud already solves. |
| **`nx connect-to-nx-cloud` with token committed to `nx.json`** | Token-in-nx.json is the workspace-level shape Nx Cloud documents, but committing the token to a public repo leaks the workspace identity. Env-var-only is the correct shape for a public OSS repo (or any repo where the workspace token is sensitive). |

---

## Decision (WHAT)

**Remove the broken `nxCloudAccessToken` line from `nx.json`. Provision `NX_CLOUD_ACCESS_TOKEN` as a GitHub repo secret. Nx Cloud will activate from the env var the next time CI runs.**

The change in this PR:

```diff
 {
   "$schema": "./node_modules/nx/schemas/nx-schema.json",
   "defaultBase": "main",
-  "nxCloudAccessToken": "${NX_CLOUD_ACCESS_TOKEN}",
   "namedInputs": {
```

Removing the line lets Nx fall back to its standard env-var lookup (`NX_CLOUD_ACCESS_TOKEN`). When the env var is present, Nx Cloud activates; when absent, Nx runs in local-only mode without any error message — Nx Cloud is opt-in by design.

### Provisioning runbook (one-time, owner action)

1. Visit <https://cloud.nx.app> → "Connect a workspace" → choose GitHub repo `Okan-wqm/aquaculture_platform`.
2. Nx Cloud emits a workspace ID + access token. Copy the access token.
3. In the GitHub repo: Settings → Secrets and variables → Actions → New repository secret → name `NX_CLOUD_ACCESS_TOKEN`, value = the token from step 2. Save.
4. (Optional) Add the same secret to the org-level secret store if it should be shared across other repos.
5. Re-run any failed CI job. The job's startup log now prints `Nx Cloud workspace: <name>` instead of falling back to local cache.

After step 5, the four affected jobs drop from 35-45 min cold to ~5 min warm on a fresh PR. The first PR after activation pays the full cold cost once; every subsequent PR sees cache hits.

### Free tier suffices

Nx Cloud's free tier covers up to 500 distributed-task-execution hours per month. The campaign's full 9-PR stack would consume ~3 hours total at warm-cache rates. A typical month of `main` activity (~50 PRs × 4 jobs × 3 min average) is ~10 hours. Free-tier headroom is 50×.

---

## Verification (HOW)

Post-merge, verify the activation:

```bash
# 1. Check the secret is set
gh secret list -R Okan-wqm/aquaculture_platform | grep NX_CLOUD_ACCESS_TOKEN

# 2. Trigger a small PR's CI re-run; tail the test job's first 20 lines
gh run view <run-id> --log | grep -E 'Nx Cloud|workspace|cache hit|cache miss' | head

# 3. Open the run URL in Nx Cloud (https://cloud.nx.app/runs/<id>); cache-hit
#    rate should be > 80% on the second consecutive PR after activation.
```

If the secret is unset, jobs continue to behave as today (local cache, structural timeouts). The architectural primitive is in place; the cloud activation is a runtime opt-in.

---

## Closing the loop

When the secret is provisioned, the four affected jobs on PRs #118-#130 should retry cleanly. The campaign's PRs unblock without timeout bumps, runner upgrades, or amnesty extensions — exactly the "tier-1 make-impossible" / "tier-2 make-automatic" shape CLAUDE.md requires.

If after provisioning the secret a particular PR still hits the timeout (e.g., because its diff genuinely affects 50+ projects with no upstream cache hits), that signals a graph-input-tuning issue that gets its own ADR. Today's data does not point there: the cold scope is the issue, and Nx Cloud is the architectural fix.
