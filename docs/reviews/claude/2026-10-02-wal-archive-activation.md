# Production WAL archiving ran while declared not-activated (2026-10-02)

Context: on 2026-10-02 at 06:20Z the production droplet's root filesystem reached 100%. 65 GB of it
was `pg_wal` in the `aqua-saas_postgres_data` volume: 4,152 WAL segments waiting for an archiver
that had failed every attempt since 2026-09-21. The operator cleared it (`.ready` to `.done` plus
`CHECKPOINT`); growth continued at about 6 GB a day. The operator approved making the runtime
match the declared DR state until plan phase BR-3 ("wal için onay veriyorum").

Owner: claude (implementation), okan (review, production apply).

## INFRA-CRITICAL-195

`.github/manifests/dr-activation.json` declared `production-wal-archive` `not-activated` and said
production ran the bare base image with `archive_mode=off`. `docker-compose.droplet.yml` started
PostgreSQL with `-c archive_mode=on` and the WAL-G `archive_command`. No Spaces bucket, WAL-G
principal or encryption key has ever been provisioned (BR-1), so the archiver had no destination.
PostgreSQL keeps every segment until it is archived, so the disk filled.

The same contradiction kept the container unhealthy. `postgres-walg-healthcheck.sh` passes only
when archiving is on and its newest attempt succeeded, so no runtime in the declared state could be
healthy. The development deploy refuses an unhealthy preserved `aqua-postgres`, which is the open
INFRA-HIGH-191. The freshness lane could not see the problem either: it treated "the image carries
the healthcheck script" as activation, and production has carried that image since 2026-09-21
whether archiving was meant to run or not.

Evidence (read-only, 2026-10-02 ~12:00Z unless dated):

- `docker inspect aqua-postgres`: created 2026-09-21T10:53:01Z from
  `/var/lib/aqua/deploy/checkout/docker-compose.droplet.yml`, image
  `ghcr.io/okan-wqm/aquaculture_platform/postgres:9b44390f9…` (WAL-G v3.0.8, DR contract label
  `04ab2e25…`), health `unhealthy`, FailingStreak 63,030. `WALG_S3_PREFIX` is
  `s3://aqua-walg-backups/postgres/wal-g/0` on fra1.
- `pg_settings`: `archive_mode=on`, `archive_command=/usr/local/bin/walg-archive-command.sh %p %f`,
  `archive_timeout=225`, all with source `command line`, so `ALTER SYSTEM` cannot override them.
- `pg_stat_archiver`: archived 2,151 (last `000000010000000800000067`, 2026-09-21 10:49:32Z,
  stats reset 2026-09-15 22:24Z), failed 50,824, last failed `0000000100000018000000AD`. The
  container log reports `NoSuchBucket` for `postgres/wal-g/0/wal_005/0000000100000018000000AD.lz4`.
- 78 `.ready` files (1.3 GB) five hours after the cleanup; `df /` 66% used, 76 GB free. At ~384
  forced segments a day the disk fills again in roughly twelve days.
- `platform.release_ledger` has no row and `/var/lib/aqua/deploy/releases` no directory between
  03:10Z and 15:24Z on 2026-09-21, so the recreate did not come from `droplet-up.sh`. Who ran it
  is not established.
- deploy-development run 36352814820 (2026-09-27) refused at "Proving preserved migration
  infrastructure is healthy" with the healthcheck's
  `archive settings are unsafe or the newest archive attempt failed`
  (`scripts/deploy/lib/deployment-mode-policy.sh:156-173`).
- `Database WAL Archive Freshness` has failed since at least 2026-09-26 on
  `protected SSH fingerprint did not match exactly one advertised ED25519 host key` (run
  36986327261), before it observes anything.

Rule: A production DR capability runs exactly when `.github/manifests/dr-activation.json`
declares it active. The runtime switch, its health contract and its monitoring lane are
projections of that one declaration, and a test fails when any of them disagrees.

Fix:

- `docker-compose.droplet.yml` starts PostgreSQL with `-c archive_mode=off` and sets the literal
  `WALG_ARCHIVE_ACTIVATION: not-activated`. `archive_command` and `archive_timeout` stay configured,
  so activation changes `archive_mode` and the literal and nothing else. A literal rather than an
  interpolated variable means no `.env` value can start archiving that the manifest did not
  declare.
- `postgres-walg-healthcheck.sh` reads `WALG_ARCHIVE_ACTIVATION`. `active` keeps the full RPO
  contract unchanged. `not-activated` requires a ready server, `archive_mode=off` and pg_wal disk
  headroom, and consults no WAL-G budget, coordinate or credential. Any other value fails closed.
  The DR contract manifest and the backup hash manifest are repinned.
- The freshness lane observes `SHOW archive_mode` inside the container: `on`/`always` is
  `present`, `off` is `absent`, anything else is `indeterminate`. Declared state and observation
  still meet only in `resolve-dr-activation.sh`, which fails on drift in both directions. Its
  drift message no longer tells the operator to declare the capability active, because here the
  right remedy was the opposite.
- `dr-activation.json`: `activationEvidence` is now `archive_mode=on`, and `whyNotActivated`
  describes the WAL-G image running with archiving off for want of BR-1 credentials.
- `tests/invariants/wal-archive-activation.spec.ts` (new) ties all three projections to the
  manifest through `tests/invariants/lib/wal-archive-activation.ts`. It runs the real healthcheck
  against fake PostgreSQL clients in both states and the lane's real SSH payload against a fake
  `docker`, then feeds the observation to the real resolver. 8 of its 14 tests fail on the old
  tree and all pass on the new one. Flipping only the manifest, only `archive_mode`, interpolating
  the literal, or loosening the not-activated check each turns it red.
- `walg-pitr-contract.spec.ts` takes the expected `archive_mode` from the manifest instead of a
  hard-coded `on`; `docs/runbooks/database-restore-drill.md` says the image alone does not archive.

Not done here:

- Production still runs the old container. The change reaches it only through the operator
  procedure below; the development deploy preserves `postgres` by design and will not recreate it.
- INFRA-HIGH-191 stays open until the next development deploy passes its preserved-infrastructure
  check after the apply.
- `DROPLET_SSH_FINGERPRINT` in the `production-backup` environment must be re-pinned by the
  operator before the freshness lane can observe anything.
- Activation itself (BR-1 credentials, BR-3 cutover) is unchanged and remains tracked under the
  plan in `docs/plans/2026-07-30-enterprise-backup-restore-architecture/PLAN.md`.

## Operator procedure: apply on the production droplet

The healthcheck is baked into the PostgreSQL image, so the fix needs both the merged compose file
and the PostgreSQL image built from the merge commit. `PRODUCTION_DEPLOY_ENABLED` is false and the
development deploy never recreates `postgres` (`PRESERVE_DATA_INFRASTRUCTURE=true`), so no
pipeline applies it. Expected downtime is one PostgreSQL restart: about 10-30 s with no crash
recovery. Application containers stay up and reconnect; requests in that window fail.

`MERGE_SHA` below is the merge commit on `main`.

### 1. Pre-checks

```bash
df -h /                                     # >= 15 GB free
docker ps --filter name=aqua-db-migrate --format '{{.Names}} {{.Status}}'   # no running migrate
gh run list --workflow ci-affected.yml --branch main --status in_progress   # no deploy in flight
docker exec aqua-postgres psql -X -qAt -U aquaculture -d aquaculture -c \
  "SELECT pid, now() - xact_start, state, left(query, 60) FROM pg_stat_activity
   WHERE xact_start < now() - interval '1 minute' AND backend_type = 'client backend'"
docker exec aqua-postgres du -sh /var/lib/postgresql/data/pg_wal
```

Do not proceed while a long transaction or a migration is running.

### 2. Merged checkout and image

```bash
cd /var/aqua-saas && git fetch --force --prune origin
git show "${MERGE_SHA}:scripts/deploy/deploy-paths.sh" > /var/lib/aqua/deploy/deploy-paths.sh
source /var/lib/aqua/deploy/deploy-paths.sh && materialize_deploy_checkout "${MERGE_SHA}"
cd /var/lib/aqua/deploy/checkout && git rev-parse HEAD           # must print MERGE_SHA
grep -n 'archive_mode=off\|WALG_ARCHIVE_ACTIVATION: not-activated' docker-compose.droplet.yml
export TAG="${MERGE_SHA}"
docker compose -f docker-compose.droplet.yml config --quiet      # silent on success
export DOCKER_CONFIG="$(mktemp -d /tmp/aqua-docker-config.XXXXXX)"
printf '%s' "${GHCR_READ_TOKEN}" | docker login ghcr.io -u Okan-wqm --password-stdin
docker compose -f docker-compose.droplet.yml pull postgres
docker logout ghcr.io; rm -rf "${DOCKER_CONFIG}"; unset DOCKER_CONFIG
docker image inspect "ghcr.io/okan-wqm/aquaculture_platform/postgres:${MERGE_SHA}" --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "io.aquaculture.postgres.dr-contract-sha256"}}'
sha256sum .github/manifests/postgres-dr-contract.sha256           # must equal the label
```

`GHCR_READ_TOKEN` is a token with `read:packages`; the droplet keeps no registry login (the deploy
uses a throwaway `DOCKER_CONFIG` the same way). `ghcr.io/…/postgres:${MERGE_SHA}` exists only if CI - Affected ran `build-development-images` on
the merge commit; it is skipped when an upstream gate on `main` is red. If the pull says the
manifest is unknown, the signed alternative is `PostgreSQL DR Bootstrap Candidate`
(`workflow_dispatch`, `main_sha=MERGE_SHA`) followed by
`infrastructure/scripts/provider-console-bootstrap-postgres-walg.sh` from the provider console,
which recreates only `postgres` from the attested digest. If `config --quiet` names a missing
`WALG_*`/`SPACES_*` value, export the same value the running container has (`docker inspect`
shows `WALG_BACKUP_EPOCH`, `WALG_S3_PREFIX`, `WALG_S3_ENDPOINT`, `WALG_S3_REGION`); they are inert
while archiving is off.

To stop WAL growth before the new image is available, run step 3 with
`TAG=9b44390f98e16c4de759bfbc4d524e4312d2a81b`. Archiving stops, but the old image's healthcheck
still reports unhealthy, so deploys stay blocked until step 3 is repeated with `MERGE_SHA`.

### 3. Apply

```bash
docker exec aqua-postgres psql -X -qAt -U aquaculture -d aquaculture -c 'CHECKPOINT'
docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build --force-recreate \
  --timeout 120 --wait --wait-timeout 180 postgres
```

`--timeout 120` gives the SIGINT fast shutdown time to finish its checkpoint instead of being
killed at Docker's 10 s default. `--no-deps` limits the change to `postgres`.

### 4. Verify

```bash
docker inspect aqua-postgres --format '{{.Config.Image}} {{.State.Health.Status}}'  # MERGE_SHA healthy
docker exec aqua-postgres psql -X -qAt -U aquaculture -d aquaculture -c \
  "SELECT name || '=' || setting || ' (' || source || ')' FROM pg_settings
   WHERE name IN ('archive_mode', 'archive_command', 'archive_timeout') ORDER BY name"
docker exec aqua-postgres printenv WALG_ARCHIVE_ACTIVATION                          # not-activated
docker exec aqua-postgres /usr/local/bin/postgres-walg-healthcheck.sh && echo healthy
docker exec aqua-postgres psql -X -qAt -U aquaculture -d aquaculture -c 'CHECKPOINT'
docker exec aqua-postgres sh -c \
  'ls /var/lib/postgresql/data/pg_wal/archive_status | grep -c ready; du -sh /var/lib/postgresql/data/pg_wal'
docker ps --filter health=unhealthy --format '{{.Names}}'                          # empty
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.suderra.com/health           # 200
```

With `archive_mode=off`, PostgreSQL recycles segments at checkpoints whatever their `.ready`
state, so the `.ready` count falls to 0 and pg_wal settles near `max_wal_size` (1 GB). Re-check
`du` after 24 hours: it must not grow by gigabytes.

Then:

- re-pin `DROPLET_SSH_FINGERPRINT` in the `production-backup` environment and dispatch
  `Database WAL Archive Freshness`. Expect a green run carrying
  `::warning::PRODUCTION HAS NO production-wal-archive` (`inactive-as-declared`).
- re-run the newest failed `CI - Affected` deploy on `main`. "Proving preserved migration
  infrastructure is healthy" must pass; that closes INFRA-HIGH-191.

### 5. Rollback

- New container fails to start or stays unhealthy: `docker logs --tail 100 aqua-postgres`, then
  recreate with the previous image, `TAG=9b44390f98e16c4de759bfbc4d524e4312d2a81b`, and the step 3
  command. PostgreSQL serves with archiving off and the old healthcheck reports unhealthy, as it
  did before the change. The data volume is untouched in either direction.
- Restoring the pre-change configuration (archiving on) is
  `materialize_deploy_checkout 7166e2f5ef29285510de509da8965e83d648a390` plus the same image and
  command. It brings back the ~6 GB a day of unarchivable WAL, so it is only for diagnosis and needs
  the `.ready` cleanup regime again.
