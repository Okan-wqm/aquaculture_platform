# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Quick context
- Nx monorepo (Node 20+) spanning NestJS microservices in `apps/`, React microfrontends in `web/`, shared platform libs in `platform/libs/` plus common utilities in `libs/`.
- Infra-as-code lives in `infra/helm`, `infra/terraform` and Docker assets in `docker/`. Root `docker-compose.yml` and `docker/docker-compose.yml` support local stacks.

## Setup
- Install dependencies: `npm install`
- Verify workspace graph: `nx list`

## Run & develop
- All services dev mode: `npm run dev`
- Backend-only dev set: `npm run dev:backend`
- Web-only dev set: `npm run dev:web`
- Serve a specific project (example): `nx serve gateway-api` or `nx serve shell`

## Build
- Affected projects: `npm run build`
- Entire workspace: `npm run build:all`
- Web bundle set: `npm run build:web`

## Test
- Affected: `npm run test`
- All: `npm run test:all`
- Single project (example): `nx test sensor-service`
- Watch mode per project: `nx test sensor-service --watch`
- Coverage per project: `nx test sensor-service --coverage`

## Lint & format
- Affected lint: `npm run lint`
- All lint: `npm run lint:all`
- Format check / write: `npm run format:check` / `npm run format`
- Type check: `npm run type-check`

## Repo map (high level)
- `apps/`: independent NestJS services (gateway, auth, farm, sensor ingestion, alerting, billing, HR, notifications, config, observability, event-store, admin API). Each app has its own README for service-specific run/config.
- `web/`: React microfrontends with module federation; `shell` hosts modules like `dashboard`, `admin-panel`, `farm-module`, `hr-module`, etc.; `shared-ui` holds design system components.
- `platform/libs/`: platform-level building blocks (CQRS, domain primitives, event bus abstraction, shared DTOs, validation, security, telemetry/observability, Temporal workflows).
- `libs/`: cross-cutting utilities (backend common, event contracts, SDKs, testing helpers, node-components).
- `infra/helm`, `infra/terraform`: deployment and cloud infra modules (EKS, VPC, RDS/Timescale, MSK Kafka, Redis, OpenSearch).
- `docker/` and root `docker-compose.yml`: compose files for local infra and app stacks.

## Useful tooling
- Dependency graph: `npm run graph` (full) or `npm run affected:graph`.
- Nx caching is enabled (see `nx.json`); `build/test/lint/e2e` are cacheable.

## Notes for agents
- Target Node 20.11+ / npm 10+ per root `package.json`.
- When running commands on Windows PowerShell, prefer `npm run ...` wrappers over bare Nx for consistent env.
- Check per-service README in `apps/<service>/README.md` and per-web module README for environment variables and ports when troubleshooting.
