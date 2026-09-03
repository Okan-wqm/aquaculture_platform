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
them to `sensor_schema_owner`, and grants the runtime role read access before services start. The
tenant schema provisioner runs the same authority path for both new and reconciled tenants.
Production sensor bootstrap is now a read-only, fail-closed check for all expected views, their
owner, and actual query access; only non-authoritative local development retains runtime creation.
Unit and wiring contract tests cover DDL failure cleanup, unsafe schemas, ownership drift, missing
views, both provisioner paths, and the release migration sweep.
