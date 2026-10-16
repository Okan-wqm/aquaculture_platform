# Main CI-Affected red for three pre-existing reasons (2026-10-16)

Main `CI - Affected` is red on every push. Three independent breaks keep `build-status` (a
required context) red and the `deployed/development` tag pinned at 323f9f60c (PR #1949, the last
green main run). A fourth, latent defect turned up while diagnosing the test break.

Owner: claude (implementation), okan (review). Deadline 2026-10-23.

## PROC-HIGH-054

`docs-check` lints Markdown lines added between the push base and HEAD. On a push to main the
base is `deployed/development`. That tag has not moved since 323f9f60c, so every main run
bills the same five lines:

- `docs/reviews/zcode/2026-10-10-farm-e2e-campaign.md:95,97,99,102`: MD013, lines of 288, 151,
  123 and 127 characters. Added by 453d442da. PR #1954 merged with docs-check failing on these
  exact lines (job 114401864121).
- `docs/reviews/zcode/2026-10-14-sensor-readings-crash.md:19`: MD040, a bare opening fence.
  Added by 76fce6a95. The lint never ran on PR #1966: its docs-check died pulling unused
  service containers (job 116451216596).

Fix: wrap the four bullets inside the same list item (text unchanged) and tag the fence `text`.
`MARKDOWNLINT_BASE_REF=323f9f60c… node scripts/ci/markdownlint-changed.mjs` now exits 0.
Required contexts with `enforce_admins` (active since 2026-10-15) block the first path. The
second path is closed by INFRA-HIGH-225.

## FARM-HIGH-441

`apps/farm-service/src/__tests__/e2e/feed-allocation.postgres.spec.ts:357` asserted
`String(slice.expiryDate)` contains `YYYY-MM-DD`. That held only while TypeORM leaked the
Postgres `date` text through a field typed `Date | null`. b78dfe891 (PR #1951) added
`DateColumnTransformer` to `StorageInventory.expiryDate` (FARM-CRITICAL-406), so the field now
holds a real `Date`. `String(Date)` is `Sat Feb 13 2027 00:00:00 GMT+0000 …` and can never
match. PR #1951's own test job (114291379459) failed this way 33 s before it merged.

Fix: the spec asserts the declared contract, `instanceof Date` plus the UTC calendar day. The
transformer is correct and stays. Locally, with Testcontainers Postgres, the old spec fails 1 of
10 tests and the fixed spec passes 10 of 10.

## INFRA-HIGH-225

`ci-affected.yml` declared redis+nats service containers on 12 jobs that never reach them:
install, lint, build, schema-validation, pre-flight, infra-image-build-check, security-audit,
sensor-service-gates, sens-api-gateway-rust, sens-enterprise-validation, sens-enterprise-summary
and farm-water-chemistry-e2e. `test` also declared redis, which no step uses: every Redis
client in a spec is mocked, and only `NATS_URL` points at a service. Each declared image is an
anonymous `public.ecr.aws` pull made before the first step. ECR Public limits anonymous pulls per
source IP (500 GB/month and 1 pull/s, neither adjustable), and GitHub-hosted runners share
egress IPs. When the quota runs out, these jobs fail with `toomanyrequests` whatever the change.

Fix: services stay only where a step reaches them (`test` → nats). Pulls per run drop from 26
to 1. `tests/invariants/ci-service-containers-used.spec.ts` fails when any workflow job declares
a service that no job/step `env`, `run` or `with` reaches. A reference is a `localhost` or
`127.0.0.1` URL on the service's published port, a `*PORT` env var holding that port, the
service name used as a host, or `job.services.<id>`.

Remains, owned by INFRA-HIGH-214 (digest-preserving GHCR mirror, operator decision): the `test`
job's `nats:2.10-alpine`, ci-full's `redis:7` and e2e-messaging's `redis:7-alpine` still pull
anonymously from `public.ecr.aws` by floating tag. INFRA-HIGH-213 assumed ECR Public had "no
anonymous rate limit" for this usage. That assumption is false.

## FARM-MEDIUM-442

`DateColumnTransformer.from` turns `'YYYY-MM-DD'` into UTC midnight, and `to` passes a `Date`
through unchanged. TypeORM 0.3 writes a `date` column with local-time getters unless the column
sets `utc: true`, and no column in `apps/` or `libs/` does. On a host west of UTC, a
read-then-write round trip therefore stores the previous day. One example is
`stock-movement.service.ts:365`, which copies the drawn lot's expiry into the ledger. With
typeorm 0.3.31, `TZ=America/New_York` writes `new Date('2027-02-13')` as `2027-02-12`. UTC and
Europe/Istanbul are unaffected.

Latent: CI and the prod containers run in UTC. Tracked, not fixed in this PR. The fix makes
`to` the exact inverse of `from` (serialize with UTC getters), or requires `utc: true` through
`tests/invariants/date-column-transformer.spec.ts`. Either way it adds a round-trip test under
a non-UTC `TZ`.
