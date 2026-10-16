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

Remains, owned by INFRA-HIGH-227: the `test` job's `nats:2.10-alpine`, ci-full's `redis:7` and
e2e-messaging's `redis:7-alpine` still pull anonymously from `public.ecr.aws` by floating tag.
INFRA-HIGH-213 assumed ECR Public had "no anonymous rate limit" for this usage. That assumption
is false.

## INFRA-HIGH-227

INFRA-HIGH-225 left the pulls CI needs, and they still go anonymously to `public.ecr.aws` by
floating tag:

- the CI-Affected `test` job's nats service;
- the sensor-ingestion NATS testcontainer (`policy_integration.rs`), run by Rust CI
  `cargo test --workspace`, by the `test` job and by ci-full's `test:all`;
- ci-full `test`'s `redis:7` and e2e-messaging's `redis:7-alpine` services.

PR #1981's own run shows it. Its `test` job died at "Initialize containers" with
`toomanyrequests: Data limit exceeded` on `nats:2.10-alpine` (run 38962444868), and Rust CI's
`cargo test --workspace` failed on the same pull (run 38962444723). ECR Public's anonymous quota
is per source IP, and GitHub-hosted runners share egress IPs, so this moved INFRA-HIGH-213's
Docker Hub failure to another registry instead of removing it.

Fix: a registry the org controls, pinned by digest, pulled with the job's own token.

- `.github/manifests/ci-images.json` records each image once: mirror
  `ghcr.io/okan-wqm/aquaculture_platform/ci/<name>`, tag, and the upstream multi-arch index
  digest (nats `sha256:b83efabe…`, redis:7-alpine `sha256:858f009f…`, redis:7
  `sha256:4fa24486…`; Docker Hub and ECR Public serve the same digests).
- `.github/workflows/ci-image-mirror.yml` runs on every manifest change, on PRs and on main. It
  skips a digest the mirror already holds, otherwise runs `imagetools create` from
  `upstream@digest`, and fails unless the mirror resolves to the manifest digest by digest and by
  tag. No annotation is added, because one would change the digest every consumer pins.
- Consumers pull `<mirror>:<tag>@<digest>`. Services pass `credentials` with `GITHUB_TOKEN` and
  their jobs grant `packages: read`. Jobs that run the NATS testcontainer `docker login ghcr.io`
  first. The Rust test reads the manifest through `include_str!`, so the digest exists once.
- `tests/invariants/ci-image-registry.spec.ts` fails on any workflow image that is not a
  manifest mirror ref, an org-built image or a tracked Docker Hub exception. It also fails on a
  GHCR pull without token credentials and `packages: read`, a Rust testcontainer image literal,
  any `public.ecr.aws/docker/library/` ref, a manifest entry nothing consumes, and a mirror
  workflow that stops copying by digest.

INFRA-HIGH-214 keeps the Docker Hub remainder (timescale/timescaledb-ha, Dockerfile FROM bases,
moby/buildkit). It can move those images through the same manifest and mirror workflow.

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
