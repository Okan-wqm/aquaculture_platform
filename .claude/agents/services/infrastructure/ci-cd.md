---
name: ci-cd
description: Knowledge base for CI/CD - GitHub Actions workflows for build, test, Docker image publishing, and deployment to DigitalOcean
---

# CI/CD Knowledge Base

## Overview

The platform uses GitHub Actions for all CI/CD automation. The primary deployment target is a DigitalOcean droplet via `deploy-digitalocean.yml`. Kubernetes/Helm workflows (`cd-staging.yml`, `cd-production.yml`) exist for future K8s deployment. All Docker images are published to GHCR (GitHub Container Registry).

## Directory Structure

```
.github/workflows/
  ci-affected.yml              # CI for PRs/pushes: lint, type-check, test, build (affected)
  ci-full.yml                  # Full CI run (all services)
  deploy-digitalocean.yml      # MAIN DEPLOY: build + push to GHCR + deploy to droplet
  deploy.yml                   # Generic deploy workflow (placeholder)
  cd-staging.yml               # K8s staging deploy
  cd-production.yml            # K8s production deploy
  infra-terraform-plan.yml     # Terraform plan on PR
  infra-terraform-apply.yml    # Terraform apply on merge
  edge-agent-release.yml       # Rust edge agent release (sens-api-gateway)
  security-trivy.yml           # Container security scanning
  security-snyk.yml            # Dependency vulnerability scanning
  dependency-review.yml        # PR dependency review
  db-migration-check.yml       # Database migration validation
  performance-benchmark.yml    # Performance regression testing

sens-api-gateway/.github/workflows/
  ci.yml                       # Rust CI for edge agent (cargo test, clippy, fmt)
  release.yml                  # Edge agent cross-compilation + GitHub release
```

## Key Files & Configurations

### deploy-digitalocean.yml (PRIMARY WORKFLOW)

Triggers:
- `push` to `main` branch (ignoring `.md`, `docs/**`, `.vscode/**`, `.claude/**`)
- `workflow_dispatch` with optional `services` input

**Concurrency**: `group: deploy-{ref}` with `cancel-in-progress: true` - cancels in-flight deploys for same branch.

**Jobs chain**:

```
prepare → build → build-backend-images  → deploy
                → build-frontend-images →
```

**1. prepare job**:
- Detects changed files (`git diff --name-only`)
- Sets `image_prefix` (lowercase GHCR path): `ghcr.io/okan-wqm/aquaculture_platform`
- Sets `has_backend_changes` / `has_frontend_changes` flags
- If `libs/` changed → rebuild everything (monorepo shared libs affect all services)

**2. build job** (60 min timeout):
- Node.js 22 + npm cache
- NX cache: `path: .nx/cache`, key: `nx-deploy-{os}-{lockfile-hash}-{sha}`
- **Critical step**: installs Linux platform binaries (lockfile is Windows-generated):
  ```bash
  # Installs for each esbuild version found:
  @esbuild/linux-x64
  @rollup/rollup-linux-x64-gnu
  @swc/core-linux-x64-gnu
  @nx/nx-linux-x64-gnu  # CRITICAL: without this NX hangs on Linux
  ```
- Backend build: `npx nx run-many -t build --parallel=3 --projects=gateway-api,auth-service,...`
- Frontend build: `npx nx run-many -t build --parallel=3 --projects=shared-ui,shell,dashboard,...`
- `NODE_OPTIONS: '--max-old-space-size=4096'`
- `NX_DAEMON: 'false'`, `NX_NO_CLOUD: 'true'`
- Uploads artifacts: `backend-dist` (dist/) and `frontend-dist` (web/*/dist/)

**3. build-backend-images job** (20 min timeout, matrix):
```yaml
matrix:
  service: [gateway-api, auth-service, farm-service, sensor-service, admin-api-service,
            alert-engine, billing-service, hr-service, hydroponics-service, notification-service]
```
- Downloads `backend-dist` artifact
- Docker Buildx + GHCR login (GITHUB_TOKEN)
- Builds with `Dockerfile.backend.simple`, `SERVICE_NAME` build-arg
- Pushes tags: `{sha}` AND `latest`
- Registry cache: `type=registry,ref={image}:buildcache,mode=max`
- `max-parallel: 4`, `fail-fast: false`

**4. build-frontend-images job** (matrix):
```yaml
matrix:
  include:
    - { module: shell,            dockerfile: Dockerfile.shell,               module_path: web/shell }
    - { module: dashboard,        dockerfile: Dockerfile.microfrontend.simple, module_path: web/modules/dashboard }
    - { module: farm-module,      dockerfile: Dockerfile.microfrontend.simple, module_path: web/modules/farm-module }
    - { module: sensor-module,    ... }
    - { module: admin-panel,      ... }
    - { module: tenant-admin,     ... }
    - { module: hr-module,        ... }
    - { module: hydroponics-module, ... }
    - { module: aquamobil,        dockerfile: Dockerfile.aquamobil, module_path: web/apps/aquamobil }
```
- Downloads `frontend-dist` into `web/` (restores web/*/dist/ structure)

**5. deploy job**:
```yaml
if: |
  always() &&
  needs.build.result == 'success' &&
  (needs.build-backend-images.result == 'success' || ...skipped) &&
  (needs.build-frontend-images.result == 'success' || ...skipped) &&
  (... at least one succeeded)
environment: production
```
- SSH into droplet via `appleboy/ssh-action`
- On droplet:
  ```bash
  cd /var/aqua-saas
  git pull origin main
  docker login ghcr.io
  docker compose -f docker-compose.droplet.yml pull
  docker compose -f docker-compose.droplet.yml up -d --no-build --remove-orphans
  sleep 30
  # health check + cleanup + status
  docker image prune -f --filter "until=24h"
  ```

**Required Secrets** (GitHub repo secrets):
- `DROPLET_HOST` - Droplet IP/hostname
- `DROPLET_USER` - SSH user
- `DROPLET_SSH_KEY` - Private SSH key
- `GHCR_TOKEN` - Token for docker login on droplet (GITHUB_TOKEN insufficient for droplet-side pulls)

### ci-affected.yml

Triggers: `push` to `main/develop`, `pull_request` to `main/develop`

Jobs:
1. `detect-changes`: Uses `dorny/paths-filter@v2` to detect changes in `apps/`, `libs/`, `web/`, `docs/`
2. `lint-and-test`: Runs only if apps/libs/web changed:
   - `npm run lint` (all)
   - `npm run type-check`
   - `npm run test`
   - `npm run build`
3. `docs-check`: Runs `markdownlint` if docs changed

### edge-agent-release.yml

For the `sens-api-gateway` Rust project (edge agent). Triggers on version tags `v*.*.*`.

Cross-compiles for multiple targets and creates GitHub Release with binaries.

### Terraform Workflows

**infra-terraform-plan.yml**: On PR to `main`:
1. `terraform init`
2. `terraform validate`
3. `terraform plan -no-color`
4. Posts plan output as PR comment

**infra-terraform-apply.yml**: On push to `main` (with path filter for `infrastructure/terraform/**`):
1. `terraform init`
2. `terraform apply -auto-approve`

### Security Workflows

**security-trivy.yml**: Scans Docker images for CVEs after build.

**security-snyk.yml**: Scans npm dependencies for vulnerabilities.

**dependency-review.yml**: Reviews new dependencies on PRs (license, known vulnerabilities).

## Dependencies / Integrations

- **GHCR**: All images pushed to `ghcr.io/okan-wqm/aquaculture_platform/{service}`
- **DigitalOcean Droplet**: Deploy target; SSH access via secrets
- **NX monorepo**: Build tool; `npx nx run-many` orchestrates builds
- **Docker Buildx**: Required for registry cache and multi-platform builds
- **GitHub Environments**: `production` environment configured for deploy job (may have protection rules)

## Known Gotchas

1. **Windows lockfile → Linux CI** - The repo lockfile is generated on Windows, lacking Linux platform binaries. The build job manually installs `@esbuild/linux-x64`, `@rollup/rollup-linux-x64-gnu`, `@swc/core-linux-x64-gnu`, `@nx/nx-linux-x64-gnu`. This step is fragile - if version numbers change, the install may fail.

2. **NX Daemon must be disabled in CI** - `NX_DAEMON: 'false'` prevents the NX background daemon from hanging the runner.

3. **GHCR path must be lowercase** - GitHub repository names are case-sensitive but Docker registry requires lowercase. The `prepare` job converts: `echo "image_prefix=ghcr.io/${REPO,,}"`.

4. **Frontend artifacts extraction path** - `upload-artifact` strips the common ancestor from paths. Frontend files at `web/shell/dist/` are uploaded stripped, then `download-artifact` extracts to `web/` to restore the original structure. If paths change, this breaks.

5. **`--no-build` in deploy** - The droplet pull command uses `--no-build` because images are pre-built and pushed to GHCR. The droplet only pulls and runs.

6. **deploy job `if` condition complexity** - The deploy runs if build succeeded AND at least one image build succeeded (not skipped). This handles the case where no backend/frontend changed - only one matrix group runs.

7. **30-second sleep before health check** - The deploy script waits 30s after `up -d` before health checking. This is a simple approximation; for critical systems, use a proper retry loop.

8. **`concurrency: cancel-in-progress: true`** - If two pushes happen quickly, the second will cancel the first. Ensure the dropped deployment doesn't leave the droplet in a half-deployed state (usually safe since `up -d` is idempotent).

9. **`workflow_dispatch` services input** - The `services` input exists but the deploy script on the droplet runs `docker compose pull/up` for all services regardless. Selective service deployment is not yet implemented.
