# Development Runtime Health Gate Findings

Scope: the first full development rollout from CI-Affected, run
[`33729628228`](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33729628228),
and its SHA-pinned DigitalOcean deployment.

## SENSOR-HIGH-103

`sensor-service` passed static CI but crashed during Nest bootstrap because
`IngestionModule` exported `SensorMetricWriterService` directly even though the provider belongs to
the imported `SensorMetricWriterModule`. Nest requires a module to export its own provider or an
imported module, so the invalid re-export made the image unusable at runtime.

Resolution: `IngestionModule` consumes the writer through its owning module and no longer declares
the foreign provider in its export metadata. A fast invariant prevents the invalid module metadata
from returning.

## ADMIN-HIGH-007

`admin-api-service` crashed while Nest instantiated `PlatformAdminGuard` for
`ImpersonationController`. The controller-scoped module did not provide the guard's non-global
`SecurityEventService` dependency. The guard also typed the canonical `TOKEN_BLACKLIST` injection
as an incompatible read adapter, so resolving the raw global provider would have produced a second
runtime contract failure.

Resolution: `ImpersonationModule` provides the non-global event publisher in the controller's DI
context. `PlatformAdminGuard` now injects the canonical `ITokenBlacklist` contract and narrows it to
the shared revocation verifier's read-only shape at the call boundary. Guard behavior tests cover
both revoked and admitted tokens, and a wiring invariant pins the feature-module dependency.

## DEPLOY-MEDIUM-009

The failed deployment's diagnostic path classified running infrastructure containers with no
Docker healthcheck as unhealthy, then called `docker logs` without a deadline. Under Docker load,
log reads for Prometheus, Alertmanager, and node-exporter blocked for tens of minutes and prevented
the workflow from reporting the already-known health failure.

Resolution: diagnostics distinguish container running state from explicit health, skip stable
running containers without healthchecks, and bound every selected log read with a 30-second timeout
plus a five-second kill grace. The deployment invariant pins both behaviors.

## DEPLOY-HIGH-010

The corrected full development build in run
[`33764504697`](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33764504697)
selected and successfully ran the new `db-migrate` image, but left
`tenant-schema-provisioner` stopped on the previous image. The catalog models the provisioner as a
distinct compose service whose `imageName` is `db-migrate`; the selective rollout incorrectly
assumed image-selection names and compose-restart names were identical. The stopped provisioner
could not claim the queued legacy-tenant reconciliation, so downstream farm and sensor health
checks remained fail-closed. The deployment failed and correctly skipped digest promotion and the
development baseline update.

Resolution: the service catalog now derives every active compose consumer whose image name differs
from its compose name and emits that mapping into both generated deploy artifacts. Selective
rollout, full-scope rollback capture, rollback retagging, and service recreation consume the same
mapping. Deploying `db-migrate` therefore recreates `tenant-schema-provisioner` with the immutable
SHA image, while frontend-only rollouts leave it untouched. Executable invariants pin the catalog
mapping, restart order, image-reference resolution, and generated-artifact parity.

## SENSOR-HIGH-104

The same failed development deployment exposed a second sensor bootstrap failure after the Nest
module wiring was corrected. `sensor-service`, running as the DML-only `sensor_service` database
role, attempted `ALTER MATERIALIZED VIEW` against tenant continuous aggregates owned by
`admin_schema_owner`. This made production runtime a competing DDL authority and caused the new
image to crash even though its static CI checks had passed.

Resolution: the canonical continuous-aggregate SQL now has one shared definition. The
non-transactional `db-migrate` phase creates or reconciles every existing tenant's rollups, assigns
them to the passwordless `sensor_aggregate_owner` LOGIN role required by TimescaleDB background
workers, and grants the runtime role read access before services start. The ordinary
`sensor_schema_owner` remains NOLOGIN and the aggregate owner receives no password or elevated
cluster capability. The tenant schema provisioner runs the same authority path for both new and
reconciled tenants.
Production sensor bootstrap is now a read-only, fail-closed check for all expected views, their
owner, and actual query access; only non-authoritative local development retains runtime creation.
Unit and wiring contract tests cover DDL failure cleanup, unsafe schemas, ownership drift, missing
views, both provisioner paths, and the release migration sweep.

## DEPLOY-HIGH-011

The next full development deployment in run
[`33816640913`](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33816640913)
verified all 28 immutable image digests and started the updated tenant schema provisioner. The
provisioner reached the queued legacy-tenant reconciliation, but its lease-fenced evidence update
used the same untyped parameter as both a `VARCHAR` assignment and a text comparison. PostgreSQL
rejected the statement with `inconsistent types deduced for parameter $2`, so the job remained
non-terminal and the farm runtime continued to reject the unverified tenant ledger.

Resolution: terminality is computed once by the worker and passed as the existing typed boolean
parameter that both lease and completion fields consume. A real PostgreSQL integration test
claims a failing reconciliation job and verifies that the production worker persists `FAILED`,
the error message, and `completed_at` through the same query path.

## DEPLOY-HIGH-012

The recovery deployment in run
[`33827285364`](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33827285364)
correctly waited for the previous provisioner's lease, committed the reconciliation job, and
allowed `farm-service` to become healthy. The farm container emitted both required structured boot
signals, but fourteen fail-closed bootstrap retries made its deploy-window log stream larger than
Node's default child-process buffer. `spawnSync` returned an `ENOBUFS` error with no successful exit
status; the signal reader silently converted that invocation failure into an empty log and reported
both real signals as missing, forcing an unnecessary rollback.

Resolution: the signal reader uses an explicit 32 MiB bounded buffer for the five-minute evidence
window, parses both child output streams for Docker/Compose compatibility, and treats child-process
or non-zero Docker failures as invocation errors instead of synthetic missing-signal evidence. The
affected-development invariant pins the buffer and fail-closed error handling so verbose recovery
logs cannot silently erase deployment evidence again.

## DEPLOY-HIGH-013

The same run's final health round reported `farm-service` as `health=n/a state=running` while the
container was in a fourteen-restart bootstrap loop. `docker compose ps --format json` temporarily
omitted the health status between restarts, and the health gate inferred from that empty field that
the image declared no healthcheck. It therefore accepted momentary process liveness even though
Docker still had a configured healthcheck and the application had not completed bootstrap.

Resolution: each polling round now batches an authoritative `docker inspect` for the Compose
containers and records both the image's healthcheck declaration and Docker's current health state.
Only a container that Docker proves has no healthcheck may fall back to running-state liveness; a
declared check with an empty or starting status remains unsatisfied. Inspect failures and malformed
results fail the gate as invocation errors rather than weakening it.

## DEPLOY-HIGH-014

Attempt 2 of run
[`33827285364`](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33827285364)
passed immutable digest resolution, container health, structured boot signals, and every critical
`/health/ready` probe. The final release-ledger SQL gate nevertheless failed before public smoke
because `:'migration_required'` appeared inside a dollar-quoted `DO` body. `psql` does not perform
client-variable interpolation inside that body, so PostgreSQL received the colon token literally
and rejected it with a syntax error.

Resolution: the verifier now transfers `migration_required` into PostgreSQL session state with
`set_config`, alongside the existing release ID and Git SHA values, and reads it into a typed
PL/pgSQL boolean before evaluating the ledger. The invariant forbids the quoted-body substitution
form and pins the typed session boundary.

## DEPLOY-HIGH-015

The scheduled `Deploy Capacity Maintenance` run
[`33836033913`](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33836033913)
failed before its capacity gate ran. Its SSH script fetched the persistent `/var/aqua-saas` Git
repository and then invoked `git checkout -f` in that directory. The droplet intentionally keeps
that repository bare, so Git rejected the operation with `fatal: this operation must be run in a
work tree`; no capacity report or safe image GC executed.

Resolution: capacity maintenance now reads the canonical checkout materializer directly from the
selected commit with `git show`, pins the deploy-owned worktree to that exact SHA, and runs the
capacity command there. The persistent source repository remains an object/ref store only. The
isolated-checkout invariant covers this third SSH consumer and forbids direct `git checkout` from
returning to the maintenance workflow.
