# Production went down on a deploy of `main`, and stayed down for lack of a lineage

Date: 2026-09-19
Reviewer: claude
Scope: `docker-compose.droplet.yml`, `scripts/deploy/**`, `platform/libs/event-bus/**`,
`scripts/nats/**`, `apps/gateway-api`, `apps/farm-service`, `apps/auth-service`

## How this surfaced

At 20:36Z on 2026-09-18 a deploy of `main` (`1e6e99f7e0`, image tag `1e6e99f7e07f…`)
recreated the stack on the droplet. Eleven services entered a crash loop, the gateway
never composed, and login answered 502 — then `Unknown type "LoginInput"` — until
08:52Z the next morning, with human intervention at every step. Every finding below was
read from the host while it was down; none is a hypothesis.

## DEPLOY-HIGH-018 — the CORS lines the services require live only as an uncommitted edit on the host

- `configureCors` (`libs/backend-common/src/bootstrap/create-service-app.ts:357`) hard-fails in
  production without `CORS_ORIGINS`. The committed `docker-compose.droplet.yml` at `1e6e99f7e0`
  passes no `CORS_ORIGINS` to `auth-service` or ten other services; the 28 lines that do were an
  **uncommitted working-tree edit** in `/var/lib/aqua/deploy/checkout` (`git status`:
  `M docker-compose.droplet.yml`). A clean release checkout discarded them; the containers were
  created without the variable (`docker inspect`: no `CORS_ORIGINS` among 43 env entries) and
  restarted 143–262 times each: `Bootstrap failed: CORS_ORIGINS must be set in production`.
- Rule: what production needs to boot is in the repository, gated by the same CI as the code
  that needs it; the host carries secrets, never configuration.
- Remedy: commit the `CORS_ORIGINS` / `WS_CORS_ORIGINS` service entries (or a shared anchor) to
  the compose file; add an invariant that every `serviceVisibility: public` service's compose
  block sets it.

## DEPLOY-HIGH-019 — `main` shipped a gateway and a farm-service that cannot boot

- `gateway-api:1e6e99f7e0`: `Nest can't resolve dependencies of the TenantConnectionLimiter (?)`;
  `farm-service:1e6e99f7e0`: `Nest can't resolve dependencies of the DayPlanRecalcService
(OutboxPublisher, ?) … ProtocolResolutionService`. Both crash-looped; both were rolled to the
  previous image generation (`fazai-2`) by hand and are still there. The commit CI passed:
  no test boots the Nest module graph of either service.
- Rule: a service image that cannot construct its module graph never reaches `main`; the
  boot is a test.
- Remedy: fix the two providers; add a per-service "module graph constructs" test (Nest
  `Test.createTestingModule` over the app module with infrastructure stubbed) to the affected
  lane so a DI break is red before merge.

## DEPLOY-HIGH-022 — the event bus and the NATS ACL generator derive different inbox prefixes

- `platform/libs/event-bus/src/nats/nats-event-bus.ts` sets
  `clientId = NATS_CLIENT_ID ?? 'aquaculture-<service>'` and passes it to
  `buildNatsConnectionOptions`, whose reply-inbox prefix is
  `_INBOX${clientId.toUpperCase()}.` → `_INBOXAQUACULTURE_ADMIN_API_SERVICE.…`; the generated
  ACL (`scripts/nats/generate-nats-conf.py`) allows `_INBOXADMIN_API_SERVICE.>` (from
  `SERVICE_NAME`). NATS: `Subscription Violation - User "CN=admin_api_service", Subject
"_INBOXAQUACULTURE_ADMIN_API_SERVICE..…"`. admin-api treats NATS as required in production
  and aborted; the other services log the same violation and continue (sensor, auth:
  `Failed to publish event UserLoggedIn`). The generated file — `BEGIN GENERATED — DO NOT EDIT
BY HAND` — was hand-edited by two sessions on the host during the outage (duplicated lines,
  a `_INBOX.>` added to publish but not subscribe for admin-api). Restored with
  `NATS_CLIENT_ID=admin-api-service` (compose overlay on the host) plus two hand-added ACL
  entries — neither is in the repository.
- Rule: one derivation of a subject, owned by one place, consumed by both the client and the
  ACL; a generated file is regenerated, never edited.
- Remedy: the generator reads the same `clientId` rule (or the event bus uses `SERVICE_NAME`);
  compose passes `NATS_CLIENT_ID` explicitly; a test composes the ACL against every service's
  actual inbox prefix.

## DEPLOY-HIGH-020 — the production database was migrated by local image tags

- `docker ps -a` on the host: `db-migrate` runs from `local-zai-1`, `local-msg-fix-2`,
  `local-msg-fix-3`, `local-credential-fence` (43–47 h before the outage). The schema is ahead
  of every image `main` can build: the previous production image
  (`admin-api-service:rollback-e0ed5043bd…`) fails `SchemaDriftValidator` with 18 violations
  (`admin.plan_definitions` moved to `billing`, audit columns added), so **no rollback exists**
  — the deploy tool's own rule (ORPHAN-HIGH-381) refuses it, correctly.
- Rule: the production schema moves only by a release the deploy control plane made from
  `main`; a migration container is built from a commit, never from a working tree.
- Remedy: the control plane refuses `db-migrate` images whose tag is not a `main` SHA it
  released; the host's compose project rejects `local-*` tags; a nightly check compares the
  schema's migration ids with `main`'s migration files.

## DEPLOY-HIGH-021 — the deploy passed a health gate that did not exist and never rolled back

- The 20:32Z release wrote `rollback-images.tsv` for 23 services and **excluded** gateway,
  farm and admin-api ("a rollback point must be a PROVEN-GOOD image" — they were already
  unhealthy from the 19:50Z release). The workflow's post-deploy health gate
  (`deploy-digitalocean.yml`, ARCH-CI-007 "rollback on failed health check") did not roll
  anything back: eleven services crash-looped for twelve hours. The gateway's liveness stayed
  200 with readiness 503 (INFRA-HIGH-175's shape), so nothing counted as unhealthy.
- Rule: a deploy that leaves a service crash-looping or a gateway unready past a bounded
  window fails, and failing means the previous generation is back before a human is paged.
- Remedy: the health gate reads readiness and restart counts for the deployed services over a
  window (not liveness at one instant) and calls `rollback_and_record` on failure; a service
  excluded from the rollback manifest blocks the deploy instead of silently narrowing it.

## DEPLOY-HIGH-023 — the auth user-fence compares a microsecond timestamp to a millisecond one

- `apps/auth-service/src/modules/authentication/services/token.service.ts:216-233` re-reads
  the user under lock with `updatedAt = user.updatedAt` as part of the predicate; `login`
  saves `lastLoginAt` first (`authentication.service.ts:768`), which sets `updatedAt` at
  microsecond precision (`timestamptz(6)`; all 4 users carry sub-millisecond values), while
  the in-memory `Date` holds milliseconds. The predicate never matches:
  `ForbiddenException('User credentials changed during token issuance')` on every login.
  `auth.migrations` already carries `AddUserCredentialVersion1808500000000` — the key the
  fence should use.
- Rule: a fence compares versions, not clocks; a timestamp never carries identity.
- Remedy: predicate on `credentialVersion` (and role / tenant / isActive), drop `updatedAt`;
  a test logs in after a `lastLoginAt` save and mints.

## What was done on the host (and is not in the repository)

- `docker compose … up -d --no-deps` of eleven services with the uncommitted CORS lines;
  gateway and farm on `fazai-2`; admin-api on `1e6e…` with
  `/root/aria-lab/admin-api-natsid.yml` (`NATS_CLIENT_ID=admin-api-service`); two entries
  added to the generated NATS ACL and the server reloaded; the gateway restarted to compose.
  Every one of these is a hand act a deploy of `main` will undo.
