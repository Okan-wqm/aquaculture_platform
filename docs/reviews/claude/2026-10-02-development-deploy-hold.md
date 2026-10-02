# Development deploy has no operator-owned mode — 2026-10-02

Reviewer: claude (ARIA memory program session). Scope: `.github/workflows/ci-affected.yml`,
`.github/workflows/deploy-development.yml`, the production droplet.

## INFRA-HIGH-199

**What.** `deploy-development` rolls every green `main` onto the production droplet with no
operator-owned switch. Its only guards are the build/contract results and a stale-SHA refusal.
`PRODUCTION_DEPLOY_ENABLED=false` gates only `deploy-digitalocean.yml`; the development lane, which
mutates the same host, never reads it.

**Measured (2026-10-02 ~21:15Z).** The droplet runs `34db380f9` (2026-09-21): 37 merged PRs and 282
commits behind `main`, none touching a migration, so INFRA-HIGH-191's db-migrate refusal would not
stop a rollout. Five containers run hand-built images outside the pipeline (`aqua-farm`
`farmsetup-fix-13`, `aqua-farm-module` `farmsetup-fix-9`, `aqua-notification` `farmsetup-fix-1`,
`aqua-shell` / `aqua-tenant-admin` / `aqua-mobile` `local-suderra-login`). The 2026-10-02 19:37Z
run refused only because `main` had moved (`Refusing stale development deploy`); the first green
`main` that stays the tip would replace all of them unreviewed.

**Fix.** A `development-deploy-mode` job resolves the repository variable `DEVELOPMENT_DEPLOY_MODE`:
`auto` deploys; `held-until:<UTC minute>` skips the rollout with a warning; unset, malformed or an
expired hold is a red `main` that names the problem. `development-delivery-status` accepts a valid
hold as a declared state and still requires the rollout in every other mode, so a hold can neither
start by accident nor outlive its date in silence.
