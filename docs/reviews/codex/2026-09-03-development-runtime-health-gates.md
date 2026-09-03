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
