---
name: docker
description: Knowledge base for Docker - container definitions, compose files, Dockerfiles, and init scripts for the aquaculture platform
---

# Docker Knowledge Base

## Overview

Docker is used as the primary container runtime for both local development and production deployment. The platform uses Docker Compose for multi-container orchestration with three distinct deployment profiles: infra-only (for NX-serve local dev), full-stack development, and production (DigitalOcean droplet).

## Directory Structure

```
infrastructure/docker/
  Dockerfile.backend           # Full backend build (builds from source inside container)
  Dockerfile.backend.simple    # Pre-built backend (copies dist/ from host) - PREFERRED for CI
  Dockerfile.backend.dev       # Dev-mode backend with hot reload
  Dockerfile.microfrontend.simple  # Pre-built microfrontend (copies web/*/dist/)
  Dockerfile.microfrontend     # Full microfrontend build inside container
  Dockerfile.shell             # Main shell/host app Dockerfile
  Dockerfile.frontend          # Generic frontend build
  Dockerfile.aquamobil         # PWA mobile app
  Dockerfile.prebuilt          # Generic prebuilt image
  init-scripts/
    00-init-schemas.sql        # Creates public schema baseline, extensions (TimescaleDB, uuid-ossp)
    00-trust-auth.sh           # PostgreSQL auth config for dev
    01-init-databases.sql      # Creates databases and shared schemas (farm, sensor, hr, etc.)
    02-migrate-tanks-to-equipment.sql
    03-farm-tables-and-seed.sql
    04-billing-tables.sql
    05-seed-module-pricing.sql
  nginx/
    nginx.conf                 # Production nginx inside backend containers
    nginx.prod.conf            # Production nginx config
    shell.conf                 # Shell/frontend nginx config
    aquamobil.conf             # Mobile app nginx config
    microfrontend.conf         # Generic MFE nginx config
    default.conf.template      # Template for dynamic config
  .env.production.example      # Production env var template
  README.md
  docker-compose.prod.yml      # Production-only docker-compose (used by infrastructure/docker/)

docker-compose.yml             # Full development stack (all services + infra)
docker-compose.infra.yml       # Infrastructure only (postgres, redis, nats, minio + tools)
docker-compose.dev.yml         # Dev variant
docker-compose.prod.yml        # Root-level production (same pattern as infrastructure/docker/)
docker-compose.droplet.yml     # DigitalOcean droplet optimized (2GB RAM droplet)
docker-compose.watch.yml       # Watch mode for hot reload

infrastructure/simulators/
  docker-compose.simulators.yml  # Mosquitto MQTT broker + Node-RED for sensor simulation
  mosquitto/                     # MQTT broker config (passwd, acl.conf, mosquitto.conf)
  nodered/                       # Node-RED flows for sensor/equipment/edge simulation
```

## Key Files & Configurations

### Dockerfile.backend.simple (PRIMARY for CI/CD)

The preferred Dockerfile for CI. Requires pre-built artifacts from the host (`npx nx build <service-name>`).

```dockerfile
FROM node:22-alpine AS base
RUN apk add --no-cache curl dumb-init
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001
ARG SERVICE_NAME
COPY package*.json ./
RUN npm ci --legacy-peer-deps --omit=dev --ignore-scripts --no-audit
COPY --chown=nestjs:nodejs dist/apps/${SERVICE_NAME} ./dist
USER nestjs
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
```

Key points:
- Uses `node:22-alpine`
- Runs as non-root user `nestjs` (uid 1001)
- BuildKit cache mount for npm (`--mount=type=cache,target=/root/.npm`)
- Uses `dumb-init` for proper signal handling (graceful shutdown)
- Healthcheck hits `/health/live` endpoint

### docker-compose.yml (Full Dev Stack)

Infrastructure services:
- **postgres**: `timescale/timescaledb:latest-pg16` - TimescaleDB on port 5432 (dev) / internal only (prod)
- **redis**: `redis:7-alpine` with AOF persistence, password-protected, port 6379
- **nats**: `nats:2.10-alpine` with JetStream (`-js -m 8222`), ports 4222 (client) + 8222 (monitoring)
- **minio**: `minio/minio:latest`, ports 9000 (API) + 9001 (console)

Dev tools:
- **mailhog**: Catches SMTP emails in dev, ports 1025 (SMTP) + 8025 (UI)
- **adminer**: Database UI on port 8081

Backend services all:
- Use `Dockerfile.backend.simple` with `SERVICE_NAME` build arg
- Port mapping: `{local_port}:3000` (all containers listen on 3000 internally)
- Have healthchecks on `/health/live`
- Depend on postgres/redis/nats health
- `restart: unless-stopped`

### docker-compose.infra.yml (Infrastructure Only)

For local NX serve development. Runs only postgres, redis, nats, minio, mailhog, adminer.
Port difference: postgres maps to `5433:5432` (not 5432) to avoid conflicts.

### docker-compose.prod.yml / docker-compose.droplet.yml

Production configuration:
- Images pulled from GHCR: `ghcr.io/okan-wqm/aquaculture_platform/{service}:latest`
- Two networks: `aqua-network` (external, for nginx) + `aqua-internal` (internal bridge, for service-to-service)
- Backend services on `aqua-internal` only (not directly accessible from outside)
- Gateway and nginx on both networks
- Uses `wget` instead of `curl` for healthchecks (Alpine compatibility)
- No init-scripts volume (schema already provisioned)
- nginx service serves as reverse proxy on ports 80/443

### Init Scripts Execution Order

PostgreSQL runs these in alphabetical order on first startup:
1. `00-trust-auth.sh` - Sets trust auth for local dev
2. `00-init-schemas.sql` - Creates extensions (timescaledb, uuid-ossp), base schemas
3. `01-init-databases.sql` - Creates shared schemas: `farm`, `sensor`, `hr`, `billing`, `admin`
4. `02-migrate-tanks-to-equipment.sql`
5. `03-farm-tables-and-seed.sql` - Farm reference data tables and seeds
6. `04-billing-tables.sql` - Billing schema tables
7. `05-seed-module-pricing.sql` - Module pricing seed data

### Environment Variables (Per Service)

All backend services require:
```
DATABASE_HOST / DATABASE_URL
DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME
DATABASE_SYNC=true/false   # Sync TypeORM schema on startup
REDIS_URL=redis://:password@redis:6379
NATS_URL=nats://nats:4222
JWT_SECRET
PORT=3000
NODE_ENV=production|development
```

Service-specific:
- `farm-service`: `DATABASE_SCHEMA=farm`, `ENCRYPTION_KEY`, `FARM_SEED_ENABLED`
- `admin-api-service`: `DATABASE_SCHEMA=admin`
- `gateway-api`: All `*_SERVICE_URL` env vars for federation routing + MinIO config
- `sensor-service`: `MQTT_ENABLED`, `MQTT_BROKER_URL`
- `notification-service`: `SMTP_HOST`, `SMTP_PORT`

### Simulator Stack

`infrastructure/simulators/docker-compose.simulators.yml`:
- Mosquitto MQTT broker (mosquitto image) with ACL and password auth
- Node-RED for flow-based sensor simulation
- Flows: `sensor-simulator.json`, `equipment-simulator.json`, `edge-simulator.json`

## Dependencies / Integrations

- **CI/CD**: `deploy-digitalocean.yml` uses `Dockerfile.backend.simple` and `Dockerfile.microfrontend.simple` after NX builds artifacts
- **Kubernetes**: Helm and K8s manifests use the same GHCR image paths
- **nginx**: nginx container in prod reads `nginx/nginx.conf` (mounted as read-only volume)
- **TimescaleDB**: Required extension created in init scripts; all time-series data relies on it

## Known Gotchas

1. **Init scripts run only on first postgres startup** - If the postgres volume already exists, init scripts are ignored. To re-run, delete the `postgres_data` volume.

2. **`docker-compose.infra.yml` uses port 5433** - Not 5432. Local services connecting via `DATABASE_HOST=localhost` must use port 5433.

3. **Dockerfile.backend.simple requires pre-built artifacts** - You must run `npx nx build <service>` on the host before `docker build`. The full `Dockerfile.backend` builds inside the container but is slower.

4. **Gateway depends on ALL backend services being healthy** - In `docker-compose.yml`, gateway-api's `depends_on` lists every backend service with `condition: service_healthy`. This can cause slow startup.

5. **Windows CI cross-compilation** - The `deploy-digitalocean.yml` workflow manually installs Linux platform binaries (`@esbuild/linux-x64`, `@rollup/rollup-linux-x64-gnu`, `@swc/core-linux-x64-gnu`, `@nx/nx-linux-x64-gnu`) because the lockfile is generated on Windows.

6. **GHCR images must be lowercase** - The CI workflow lowercases the image prefix: `REPO="${{ github.repository }}"` then `ghcr.io/${REPO,,}`.

7. **MinIO bucket auto-created** - `MinioClientService` calls `ensureBucketExists()` on `onModuleInit`. If MinIO is not ready, the service will fail to start.

8. **DATABASE_SYNC in production** - Most services set `DATABASE_SYNC: "true"` in dev. In prod compose files, this is omitted (defaults to false). The farm-service sets it to false in dev because it uses Flyway migrations.
