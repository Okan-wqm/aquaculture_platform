# Aquaculture Platform - Deployment Guide

## Quick Reference

| Environment | Command | Description |
|-------------|---------|-------------|
| Local Dev | `npm run infra:up && npm run dev:backend` | Infra in Docker, services local |
| Docker Dev | `docker-compose -f docker-compose.dev.yml up -d` | Everything in Docker |
| Production | Push to `main` branch | GitHub Actions auto-deploy |

---

## 1. Local Development (Recommended - Fastest)

### Prerequisites
- Node.js 20+
- Docker Desktop
- npm installed

### Start Development

```bash
# Step 1: Start infrastructure only (Docker)
npm run infra:up

# This starts:
# - PostgreSQL (TimescaleDB) on port 5432
# - Redis on port 6379
# - NATS on port 4222
# - MinIO on port 9000
# - Adminer on port 8080
# - MailHog on port 8025

# Step 2: Wait for containers to be healthy (~10 seconds)
docker-compose -f docker-compose.infra.yml ps

# Step 3: Start backend services locally (fast hot-reload)
npm run dev:backend

# Step 4: (Optional) Start frontend in another terminal
npm run dev:web
```

### One-Command Start
```bash
npm run dev:fast    # Starts infra + backend
```

### Stop Development
```bash
npm run infra:down  # Stops Docker containers
# Ctrl+C to stop NX processes
```

---

## 2. Docker Development (Isolated)

Use when you need full isolation or testing Docker builds.

```bash
# Option A: Pre-built artifacts (faster, requires local build first)
npm run build:all
docker-compose -f docker-compose.dev.yml up -d

# Option B: Full Docker build (slow, ~30-60 min first time)
docker-compose up -d
```

### Stop Docker Development
```bash
docker-compose down
# or
docker-compose -f docker-compose.dev.yml down
```

---

## 3. Production Deployment (Digital Ocean)

Production deploys are controlled by ADR-033. The supported path is the
`Deploy to DigitalOcean` GitHub Actions workflow, which calls
`scripts/deploy/droplet-up.sh` on the droplet.

### Host Node.js requirement

The production host must provide Node.js `22.x` as the root-owned,
single-linked regular executable `/usr/bin/node` with mode `0755` and a
non-writable parent chain. `scripts/deploy/production-host-control-plane.sh`
opens that path, re-reads the metadata through the open descriptor, and
refuses to publish a source or run a child when the owner, mode, link count,
or major version differs — so a host whose Node is replaced between resolution
and use fails closed instead of executing the replacement. GitHub Actions'
`setup-node` executable is a build-only authority and is never transported to
the droplet.

The control plane is the authority for that check. Wiring it in front of
`droplet-up.sh` and `post-deploy-verify.sh` in the deploy lane is tracked as
`INFRA-HIGH-152`; until that lands, those two scripts still resolve `node`
from `PATH`.

### Automatic Deployment via GitHub Actions

1. **Push to main branch or dispatch the workflow**
   ```bash
   git push origin main
   ```

2. **GitHub Actions automatically:**
   - Runs gates and selected tests.
   - Builds SHA-tagged Docker images, including `db-migrate` for every
     backend-capable deploy.
   - Pushes images to GitHub Container Registry.
   - SSHs to the Digital Ocean droplet.
   - Captures a release-wide rollback manifest.
   - Pulls exact SHA-tagged images.
   - Runs `aqua-db-migrate` as the only production schema writer.
   - Restarts affected services only after migrations pass.
   - Checks critical health and required boot signals.

3. **Monitor deployment:**
   - Go to: https://github.com/Okan-wqm/aquaculture_platform/actions
   - Check "Deploy to DigitalOcean" workflow

### Manual Recovery (On Server)

Manual raw compose deploys are not supported in production because they bypass
rollback capture, migration ordering, critical health checks, boot-signal
assertions, and release ledger writes.

Use server access only for diagnosis or a controlled rerun of the deploy script:

```bash
ssh root@your-droplet-ip
cd /var/lib/aqua/deploy/checkout

# Diagnose current state
docker compose -f docker-compose.droplet.yml ps
docker logs aqua-db-migrate --tail=300
docker logs aqua-gateway --tail=300

# Controlled rerun, the same way the workflow does it. The workflow normally
# sets these.
export DEPLOY_SHA=<git-sha>
export DEPLOY_SERVICES=all
cd /var/aqua-saas && git fetch --force --prune origin
git show "${DEPLOY_SHA}:scripts/deploy/deploy-paths.sh" > /var/lib/aqua/deploy/deploy-paths.sh
source /var/lib/aqua/deploy/deploy-paths.sh
materialize_deploy_checkout "${DEPLOY_SHA}"
cd "${DEPLOY_CHECKOUT_DIR}"
bash scripts/deploy/droplet-up.sh
```

`/var/aqua-saas` is a bare repository (`core.bare=true`) shared with
engineering and agent sessions. Use it only for its git objects. Files sitting
in that directory are not kept up to date by git, so never run or source a
script from there.

### Deploy checkout layout

All deploy state lives under `/var/lib/aqua/deploy`, defined once in
`scripts/deploy/deploy-paths.sh`:

| Path                              | Owner    | Contents                                                                                                                                                                     |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout/`                       | deploy   | git worktree pinned (detached) to the deploy SHA; every deploy script runs from here                                                                                         |
| `checkout/.env`, `checkout/certs` | operator | symlinks to the persistent secrets in `/var/aqua-saas/.env` and `/var/aqua-saas/certs`                                                                                       |
| `checkout/node_modules`           | deploy   | symlink to `deps/<key>/node_modules`                                                                                                                                         |
| `deps/<key>/`                     | deploy   | Node dependencies installed by `npm ci --ignore-scripts --omit=dev` from the deploy SHA's `package-lock.json`; `<key>` is the sha256 of the install recipe plus the lockfile |
| `deps/history.json`, `deps/.lock` | deploy   | retention order (current and previous key) and the flock that serializes installs                                                                                            |
| `releases/<release-id>/`          | deploy   | per-release state: capacity snapshot, rollback manifest, image digests                                                                                                       |

The deploy TS gates (`check-service-health.ts`, `assert-service-signals.ts`)
import `js-yaml` and resolve it only from `deps/<key>`. `droplet-up.sh` runs
`provision_deploy_dependencies` after the capacity gate and before any state
change. With an unchanged lockfile it reuses the existing tree, otherwise it
runs one `npm ci` (about 35 s, about 1.2 GiB). The new tree is built in
`deps/.staging-*`, verified, renamed into place, and only then linked.
`droplet-up.sh` runs it again before the main health gate and before the
rollback's health gate. When the tree is intact that second run is a sub-second
reuse; when it was damaged in the meantime it reinstalls instead of letting the
gate die with `ERR_MODULE_NOT_FOUND`.

The key is the sha256 of the install recipe, the npm major version, the project
`.npmrc` and the lockfile. These are read once, and the same bytes are what gets
installed. npm runs with a deploy-owned cache and config and a minimal
environment, so deploy secrets such as `GHCR_TOKEN` never reach it.

Retention keeps the current key and the previous one, so a rollback redeploy of
the previous SHA does not need the network. The key the checkout is linked to
is never pruned. `post-deploy-verify.sh` runs `verify_deploy_dependencies`
under a shared lock that it holds through its health gate. That step checks the
tree and never installs.

The checkout never links to `/var/aqua-saas/node_modules`. That tree belongs to
interactive sessions, and on 2026-10-10 one of them emptied it during a deploy
(INFRA-HIGH-218). `tests/invariants/deploy-owned-dependencies.spec.ts` fails
the build if the deploy links to it again.

If provisioning fails, the deploy records `deploy_dependencies_unavailable`.
When this happens before rollout, nothing has changed; read the npm output in
the job log, and if the cause was a registry outage, re-run the job.
`provision_deploy_dependencies` exits 75 when it times out waiting for the
lock, which means another deploy is installing.

`deps/` holds only regenerable content. Do not delete the key that
`checkout/node_modules` points to while a deploy or post-deploy verify can be
running. Any other key directory can be deleted, and the next deploy that needs
it reinstalls it. Never point another tree's `node_modules` at `deps/`: running
`npm ci` through such a link empties the deploy's tree, which is the same
mechanism as the incident.

Set `ALLOW_JETSTREAM_PURGE=true` only during an explicit maintenance window.
The deploy script refuses implicit JetStream deletion.

---

## 4. Environment Variables

### Required for Backend Services
```env
DATABASE_URL=postgres://user:pass@localhost:5432/aquaculture
REDIS_URL=redis://:password@localhost:6379
NATS_URL=nats://localhost:4222
JWT_SECRET=your-secret-key
```

### MinIO (Object Storage)
```env
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
```

### Production Secrets (GitHub)
Set these in GitHub Repository Settings > Secrets:
- `DROPLET_HOST` - Digital Ocean IP
- `DROPLET_USER` - SSH user (usually `root`)
- `DROPLET_SSH_KEY` - Private SSH key
- `SLACK_WEBHOOK_URL` - (Optional) Slack notifications

---

## 5. Docker Compose Files

| File | Use Case |
|------|----------|
| `docker-compose.yml` | Full development (builds everything) |
| `docker-compose.dev.yml` | Uses pre-built artifacts (faster) |
| `docker-compose.infra.yml` | Infrastructure only (DB, Redis, etc.) |
| `docker-compose.droplet.yml` | DigitalOcean production runtime, driven by the deploy workflow |
| `docker-compose.prod.yml` | Legacy production compose file; do not use for droplet deploys |
| `docker-compose.watch.yml` | Hot-reload development |

---

## 6. Ports Reference

| Service | Port | URL |
|---------|------|-----|
| Gateway API | 3000 | http://localhost:3000/graphql |
| PostgreSQL | 5432 | - |
| Redis | 6379 | - |
| NATS | 4222 | - |
| NATS Monitor | 8222 | http://localhost:8222 |
| MinIO API | 9000 | http://localhost:9000 |
| MinIO Console | 9001 | http://localhost:9001 |
| Adminer | 8080 | http://localhost:8080 |
| MailHog | 8025 | http://localhost:8025 |
| Shell (Frontend) | 4200 | http://localhost:4200 |

---

## 7. Troubleshooting

### Container name conflict
```bash
docker-compose down --remove-orphans
docker-compose -f docker-compose.infra.yml up -d
```

### Port already in use
```bash
# Find process using port
netstat -ano | findstr :3000
# Kill process
taskkill /PID <pid> /F
```

### Database connection error
```bash
# Check if PostgreSQL is running
docker-compose -f docker-compose.infra.yml ps postgres
# Check logs
docker logs aqua-postgres
```

### Clear everything and start fresh
```bash
docker-compose down -v --remove-orphans
docker system prune -f
npm run infra:up
```

---

## 8. Build Times Reference

| Method | Time | When to Use |
|--------|------|-------------|
| `npm run dev:fast` | ~30 sec | Daily development |
| `docker-compose.dev.yml` | ~2-5 min | Isolated testing |
| `docker-compose.yml` | ~30-60 min | Clean Docker build |
| GitHub Actions | ~15 min | Production deploy |

---

## 9. Edge Device - SCADA Display Deployment

Edge device'lara SCADA proses diyagrami deploy etmek icin [SCADA Edge Deploy Guide](./SCADA_EDGE_DEPLOY.md) dokumantasyonuna bakiniz.

```bash
# Edge device'da display kurulumu
sudo ./sens-api-gateway/scripts/setup-display.sh install

# Agent'i scada-display feature ile derle
cargo build --release --features scada-display
```

---

## 10. CI/CD Pipeline

### Workflow Overview
```
Push to main
    ↓
CI - Affected (lint, test) ~11 sec
    ↓
Security Scans (Trivy, Snyk) ~30 sec
    ↓
Build & Test ~5-10 min
    ↓
Build Docker Images (parallel matrix) ~10 min
    ↓
Push to GHCR
    ↓
Deploy to DigitalOcean ~2 min
    ↓
Health Check + Notification
```

### Key Features
- **Parallel builds**: 9 backend + 7 frontend built simultaneously
- **Registry cache**: Images cached in GitHub Container Registry
- **Pre-built artifacts**: Docker uses compiled JS, not source
- **Zero-downtime**: Rolling updates on production
- **Auto-cancel**: New push cancels old deployment
