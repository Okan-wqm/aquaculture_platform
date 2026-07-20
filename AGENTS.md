# AGENTS.md

Bootstrap guidance for coding agents (WARP, Codex, and other AGENTS.md-aware tools) working in
this repository. **Claude Code reads `CLAUDE.md`, not this file — `CLAUDE.md` is the single
source of truth for all engineering rules, architecture, and conventions.** This file is the
tool-agnostic setup/run reference; read `CLAUDE.md` before making any change.

## Mandatory agent bootstrap
- Before any code, config, test, documentation, or commit change, read the root `CLAUDE.md`.
- Treat `CLAUDE.md` as the single source of truth for Codex, WARP, and every other
  AGENTS.md-aware coding agent. If this file conflicts with `CLAUDE.md`, follow `CLAUDE.md`.
- When editing under a directory that has its own nested `CLAUDE.md`, read that file too. Nested
  guidance adds to the root rules and does not override them.
- Apply the same engineering rules from `CLAUDE.md`: root-cause-only fixes, entity `schema:`
  discipline, NATS cert-only identity, test/lint expectations, commit format, and push policy.

## Quick context
- Nx monorepo (Node ≥20.11, npm ≥10): NestJS microservices in `apps/`, React microfrontends in
  `web/`, platform libs in `platform/libs/`, shared libs in `libs/`, a Rust edge gateway in
  `sens-api-gateway/`.
- Infrastructure-as-code + local stacks live under `infrastructure/` (its `docker`, `helm`,
  `kubernetes`, `terraform`, `nats`, `monitoring`, `nginx` subdirs). Eventing is NATS (mTLS,
  cert-is-identity — no Kafka); datastores are PostgreSQL/TimescaleDB, Redis, MinIO. Production
  deploys to a DigitalOcean droplet (`docs/DEPLOY.md`), not a cloud-managed cluster.

## Setup
- `npm install` — install dependencies.
- `npm run graph` — inspect the Nx project graph (`npm run affected:graph` for affected only).

## Run & develop
- `npm run dev` (all) · `npm run dev:backend` (backend set) · `npm run dev:web` (shell + microfrontends).
- Single project: `nx serve gateway-api` / `nx serve shell`.
- Local infra only: `npm run infra:up`.

## Build / test / lint
- Build: `npm run build` (affected) · `npm run build:all` · `npm run build:web`.
- Test: `npm run test` (affected) · `npm run test:all` · `nx test <project> [--coverage|--watch]`.
- Lint & format: `npm run lint` (affected) · `npm run lint:all`; `npm run format` / `npm run format:check`; `npm run type-check`.

## Repo map
- `apps/`: 18 entries — 15 NestJS runtime services + the Rust `sensor-ingestion` sidecar + the
  inactive Rust `marine-analysis-worker` spine + the `db-migrate` CLI. See the service/schema
  table in `CLAUDE.md` for responsibilities.
- `web/`: Module-Federation microfrontends — `web/shell` (host), `web/shared-ui` (design system),
  `web/modules/*` (federated remotes), `web/apps/aquamobil` (standalone offline-first PWA).
- `platform/libs/`: `@platform/cqrs`, `@platform/event-bus` (NATS), `@platform/outbox`.
  `libs/`: `backend-common`, `event-contracts`, testing helpers.
- `infrastructure/`: Docker/Helm/Kubernetes/Terraform assets, NATS config, monitoring, nginx.

## Notes for agents
- Read `CLAUDE.md` FIRST — it carries the non-negotiable rules (entity `schema:` discipline,
  NATS cert-only identity, root-cause-only fixes, commit format + finding traceability). Some
  directories also carry a nested `CLAUDE.md` with domain-specific rules, loaded when you edit there.
- Never commit `.env`/secrets. `git push` after each commit on the active branch; no force push,
  no `--no-verify`/`--no-gpg-sign`.
- Check per-service `apps/<service>/README.md` for service-specific env vars and ports.
