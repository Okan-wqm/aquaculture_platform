# ADR-033: Deploy, Migration, and Recovery Architecture

**Status:** Accepted (2026-05-19)
**Supersedes:** ADR-016 deploy migration sections, ADR-030 deploy execution details where they conflict
**Depends on:** ADR-011 Schema Ownership Model, ADR-012 Schema Drift Prevention, ADR-031 Platform Bootstrap Atom

## Context

The DigitalOcean deployment failures in May 2026 were not independent bugs.
They were symptoms of the same architectural gaps:

- selective deploys could restart application images without rebuilding the
  `db-migrate` image that must apply their schema;
- source-schema migrations and tenant-schema fan-out did not share one
  canonical ledger contract;
- manual rollback knew about the gateway image but not the whole release set;
- some recovery paths still described raw `docker compose pull && up`, which
  bypasses schema gates, boot-signal assertions, and rollback capture;
- JetStream cleanup could delete state implicitly during a deploy script run;
- `deployed/production` was doing too much: change-detection baseline,
  operator memory, and pseudo release ledger.

The root requirement is stronger than "make this deploy pass". A production
deploy must have one schema writer, one release manifest, one rollback target,
and fail-closed orchestration.

## Decision

### 1. `aqua-db-migrate` is the only production schema writer

Application containers run with `DATABASE_MIGRATIONS_RUN=false` in production.
They may refuse boot when the schema is behind, but they do not advance the
schema ledger. The only production writer is `aqua-db-migrate`, which runs
after the platform bootstrap atom and before long-running services. A
release-wide advisory lock is held across Phase 0, every source schema, and
tenant fan-out so two deploys cannot interleave migration phases.

Services that need E2E bootstrap support keep env-aware TypeORM migration
timing. Test harnesses may set `DATABASE_MIGRATIONS_RUN=true`; production does
not.

### 2. Migration ledger names are canonical

Source schemas use `<schema>.migrations`. Tenant schemas use
`tenant_<id>.migrations_<sourceSchema>`.

This is intentional. A tenant schema hosts multiple source schemas, and every
service can legitimately have `Baseline1800000000000`. A single shared tenant
ledger would make those baseline names collide. Mixed `typeorm_migrations` and
`migrations` names are not allowed in active deploy logic.

### 3. Selective deploys still build and pull `db-migrate`

Any deploy that can contain backend, entity, migration, bootstrap, manifest, or
deploy-script changes must build the `db-migrate` image for the same git SHA.
The droplet script pulls the exact SHA-tagged `db-migrate` image and aborts if
it is unavailable. There is no "best effort" migration pull.

### 4. Rollback is release-wide, not gateway-only

Before a deploy restarts services, the droplet script captures a rollback
manifest of service image IDs. If health or boot-signal gates fail, rollback
uses that manifest for every service that had a prior image. The script does
not pretend a single gateway digest can recover a multi-service release.

The rollback manifest is an operational artifact. The durable release truth is
`platform.release_ledger`, which records git SHA, image digests, expected
migration heads, applied migration heads, tenant schema set, fan-out results,
migration manifest hash, rollback verification state, status, failure phase,
and operator.

### 5. `deployed/production` is a deploy-success baseline

The Git tag remains useful for change detection. It is updated by the workflow
only after the production deploy completes successfully. Operators do not move
it by hand; `platform.release_ledger` remains the durable release truth.

### 6. Staging is explicit

If `vars.STAGING_ENABLED=true`, production promotion requires the
`deployed/staging-<sha>` tag. Production does not read staging
environment-scoped secrets. If `STAGING_ENABLED` is not true, the bypass is
explicitly logged.

### 7. Data purges are maintenance operations

Deploy automation may report JetStream storage pressure, but it must not delete
state implicitly. Purge requires `ALLOW_JETSTREAM_PURGE=true` in a maintenance
window and should be accompanied by an operator note.

### 8. Public routes cannot inherit admin RLS bypass

The admin bypass interceptor skips handlers or controllers marked public. Admin
RLS bypass is only for authenticated admin request paths that have already
passed platform authorization.

## Required Gates

The following gates are part of the deploy architecture, not optional hygiene:

- `gates:schema-drift-registration`
- `gates:signals-manifest`
- `gates:criticality-manifest`
- `gates:type-check-spec`
- `invariants:fast`
- `type-check`

Any new service with a source schema must appear in the migration registry,
criticality manifest, required boot-signal manifest, and schema-version gate.

## Operational Contract

A production deploy sequence is:

1. Build and push SHA-tagged images, including `db-migrate` for every backend
   capable deploy.
2. Capture rollback manifest on the droplet.
3. Pull exact images. Missing image means abort before restart.
4. Run `aqua-db-migrate`.
5. Restart affected long-running services only after migrations succeed.
6. Check critical service health.
7. Sweep critical `/health/ready` endpoints.
8. Assert required boot signals.
9. Verify `platform.release_ledger` expected/applied heads with SQL.
10. Write promoted status to `platform.release_ledger`.
11. Update `deployed/production` after success.

Manual `docker compose pull && docker compose up -d` is not a production
deployment path because it bypasses steps 2, 4, 6, 7, and 8.

## Consequences

Positive:

- A schema-changing selective deploy cannot restart stale app code against an
  unapplied schema.
- Tenant fan-out can no longer skip source changes because of a shared seeded
  ledger collision.
- Rollback has a complete image target for every restarted service.
- The deploy guide now points operators at the workflow/script path instead of
  raw compose commands.

Tradeoffs:

- `db-migrate` builds more often. That cost is intentional because schema state
  is part of every backend-capable release.
- Deploys fail earlier when GHCR, staging configuration, or JetStream storage is
  unhealthy. These were already production risks; the new behavior makes them
  visible before partial rollout.
- `platform.release_ledger` requires follow-through: deploy automation must
  write status rows, and operators must use it for forensic release history
  instead of reconstructing state from Git tags alone.
