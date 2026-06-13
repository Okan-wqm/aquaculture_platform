# A4 — Dead-weight removal + structural regrowth gate

**Date:** 2026-06-13
**Agent:** infra-expert (lead-verified)
**Wave:** A4 (S4). Track A — Security / Supply-Chain / Runtime client migrations.
**Branch:** `remediation/dead-weight-2026-06`

---

## INFRA-MEDIUM-036 — Dead weight accreted across the workspace (second Redis client, zero-callsite `moment`, 0-byte web configs, duplicate prod compose, Storybook ghost scripts, vestigial `CqrsModule`) with NO structural gate preventing regrowth

**Problem.** A 2026-06-11 technology sweep surfaced a class of dead weight that
each individually is minor but collectively is maintenance tax + drift surface,
and — the architectural point — **nothing stopped any of it from growing back**:

1. **Two Redis clients.** The platform standardised on `ioredis`, but a SECOND
   client (`redis` / node-redis, `package.json` direct dep) survived, used by
   exactly one file — `apps/gateway-api/src/websocket/adapters/redis-io.adapter.ts`.
   Two clients = two connection-pool models, two failure semantics, two upgrade
   cadences for one capability (Socket.IO pub/sub).
2. **`moment`** in `web/modules/farm-module/package.json` with **zero** code
   callsites — a maintenance-mode, non-tree-shakeable date library shipped to the
   browser bundle for nothing (`date-fns` is already the module's date lib).
3. **Two 0-byte build configs** — `web/shell/module-federation.config.js` and
   `web/modules/dashboard/webpack.config.js` — empty files that read as
   "configured" while configuring nothing.
4. **A duplicate `docker-compose.prod.yml`** at `infrastructure/docker/` that was
   referenced nowhere (the canonical copy is the repo-root one, referenced by
   `ci-affected.yml` + the JWT-rotation tooling) and had silently drifted.
5. **Storybook "ghost" scripts** — `web/shared-ui/package.json` declared
   `"storybook"` / `"build-storybook"` scripts whose `storybook` binary was never
   a dependency. A script that invokes an uninstalled binary is dead the moment
   it is written and rots silently.
6. **A vestigial `CqrsModule.forRoot()`** in `apps/event-store-service/src/app.module.ts`.
   event-store imported `@nestjs/cqrs` ONLY to register the module — firsthand
   verification found NO `CommandBus`/`QueryBus`/`EventBus` injection and NO
   `@CommandHandler`/`@QueryHandler`/`@EventsHandler` anywhere in the service.
   The module registered in-process buses that nothing consumed.

The deeper finding is not the six items — it is the **absence of a structural
gate**. Deleting them once is necessary but not sufficient; per CLAUDE.md's
make-it-impossible-over-document-it hierarchy, the wrong behaviour must become a
red PR, not a future cleanup.

---

## A4 (this PR) — removal + Tier-1 invariant

- **redis → ioredis** (`redis-io.adapter.ts`): rewritten onto the platform's
  single Redis client. `@socket.io/redis-adapter` accepts an ioredis pub/sub pair
  directly (`createAdapter(pubClient, subClient)`; both params untyped, ioredis
  officially supported). `lazyConnect: true` + explicit `connect()` preserves the
  fail-closed boot semantics `main.ts` relies on — a failed connection REJECTS (so
  production hard-fails) rather than only emitting an `error` event. `redis`
  removed from `package.json`; `package-lock.json` regenerated (node-redis demotes
  to an optional peer of the adapter — the accurate dependency model).
- **moment removed** from `web/modules/farm-module/package.json` (zero callsites).
- **0-byte configs** `git rm`'d (module-federation.config.js, webpack.config.js).
- **`infrastructure/docker/docker-compose.prod.yml`** `git rm`'d (referenced
  nowhere; the root copy is canonical).
- **Storybook ghost scripts** removed from `web/shared-ui/package.json`.
- **event-store `CqrsModule.forRoot()` removed** (+ its import). Firsthand-verified
  vestigial — see "Divergence from plan" below.
- **ESLint `no-restricted-imports`** bans on `redis` and `moment` (re-import is a
  lint error pointing at the replacement).
- **`tests/invariants/repo-hygiene-invariants.spec.ts`** — the Tier-1 gate. Five
  clauses, all enforced on every PR via `nx test invariants` (always-on, not
  affected-gated):
  - (a) `redis` + `moment` appear in NO workspace `package.json`.
  - (b) every `package.json` script's leading binary resolves — a system/runtime
    command OR an installed `node_modules/.bin` binary. This is the GENERAL
    solution to Storybook-class rot (an uninstalled-binary script becomes red).
  - (c) no 0-byte JS/TS module under `web/`.
  - (d) exactly one `docker-compose.prod.yml`, at the repo root.
  - (e) `@nestjs/cqrs` importers FROZEN to the documented dirty set
    `{admin-api, billing, config, hr, messaging}` (exact equality — see below).

### Validation
- `nx test invariants` (layer-1 shard) — `repo-hygiene-invariants.spec.ts` 8/8 green.
- `tsc -p apps/gateway-api/tsconfig.app.json` — adapter type-clean (the only tsc
  errors in this worktree are the pre-existing `@nestjs/apollo`-not-installed-in-
  worktree errors in `app.module.ts`, untouched by this PR; `@nestjs/apollo@13.1.0`
  is in `package.json`, so real CI resolves them).
- `tsc -p apps/event-store-service/tsconfig.app.json` — clean after CqrsModule removal.
- `package-lock.json` regenerated from the edited `package.json` (root `redis`
  dep removed; lockfile in sync → `npm ci` passes).

---

## Divergence from plan (firsthand-verified, operator-mandated autonomy)

The plan scoped A4 item 3 as "migrate event-store + farm's single `@nestjs/cqrs`
file to `@platform/cqrs`". Firsthand inspection of current `main` found:

- **farm-service: 0** `@nestjs/cqrs` importers (already clean; the plan's count was
  stale).
- **event-store-service: 1** — and that one usage (`CqrsModule.forRoot()`) is
  **vestigial**: nothing in the service injects a CQRS bus or declares a handler.

Migrating a dead module to a different CQRS library would only RELOCATE dead
weight under a new name — it does not reduce it, which is the opposite of this
wave's intent. The higher-tier architectural fix (Tier-1 eliminate) is **removal**.
event-store now imports neither CQRS library. Recorded here because the commit
diverges from the plan's literal wording while honouring its intent.

---

## NOT done here (separate, owner'd roadmap finding)

The "@nestjs/cqrs is a dead dependency" claim is **REFUTED** — 214 files across
**hr (117), messaging (57), billing (21), admin-api (11), config (8)** import it.
It cannot be removed. A4 freezes the bifurcation (clause (e)) so it cannot SPREAD
and the freeze RATCHETS DOWN as services migrate, but the consolidation of those
214 files onto `@platform/cqrs` is a **program, not a cleanup** — it needs an
owner, a per-service migration plan, and golden-behaviour parity tests. Tracked
as a roadmap item, NOT silently deferred: the invariant's dirty-set allowlist is
the live, self-tightening tracker of remaining debt.
