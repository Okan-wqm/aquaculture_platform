# Marine Data Explorer Rebuild — Architecture Findings

Date: 2026-07-19
Cycle: `2026-07-19-marine-data-explorer-rebuild`
Design-of-record: `docs/plans/2026-07-18-marine-data-explorer/PLAN.md`

This review consolidates the verified gaps that block a safe Marine Data Explorer release. The
linked plan owns sequencing and acceptance. The registry owns lifecycle state.

## CONTRACT-HIGH-003

**Finding:** Marine analysis used a non-canonical NATS subject and had no strict durable event or
broker-scoped worker control-plane contracts.

**Evidence:** `NatsEventBus.deriveSubject()` emits `events.{tenantId}.{eventType}` and the existing
JetStream stream captures `events.>`, while `marine.analysis.requested` fits neither the platform
event naming rule nor the proposed durable path. The old topology also had no scoped reply channel
for credential-bearing request/reply.

**Root cause and required closure:** Treating the provider task as an ad-hoc message bypassed the
event-contract, outbox, registry, schema, and cert-CN ACL authorities. Closure requires the strict,
CMEMS-only `MarineAnalysisRequested` v1 worker event, authoritative worker RPC contracts,
JSON/Rust parity, exact ACLs, generated NATS config, and negative cross-CN tests. CDSE execution
remains farm-owned; Phase 0 keeps both transports dormant.

## FARM-HIGH-242

**Finding:** Marine Explorer lacked one tenant-owned four-table state model, usage reservation
ledger, and legal-hold-safe retention authority.

**Evidence:** The legacy Marine code has no approved-AOI revision, provider-credential generation,
durable job/snapshot, or provider-operation ledger. Farm strict ownership requires every legitimate
tenant table to be declared in `MODULE_SCHEMAS`; undeclared source-schema tables stop boot.

**Root cause and required closure:** Provider calls and browser overlays were built before a farm
domain model existed. Closure requires exactly `site_marine_areas`,
`marine_provider_credentials`, `marine_analysis_jobs`, and `marine_usage_operations` as
schema-less tenant entities, with migration manifest, forced RLS, fanout parity, job/outbox
atomicity, reserve-before-call accounting, and fail-closed tenant legal-hold retention.

## SEC-CRITICAL-055

**Finding:** Marine BYOC credentials cannot safely ship because the platform has no
rotation-aware fail-closed credential cipher or broker-scoped plaintext lease boundary.

**Evidence:** `createEncryptedColumnTransformer()` resolves one key, its envelope version does not
provide a usable multi-key rotation authority, and decrypt failure can be represented as a marker
or nullable value. Existing Sentinel configuration also expects
`SENTINEL_HUB_ENCRYPTION_KEY` while production wiring supplies the generic key path.

**Root cause and required closure:** The plan previously named a Marine keyring that does not exist.
Closure requires a platform credential cipher with active-key write, current/previous-key read,
key-ID envelope, AAD, typed hard failure, startup validation, explicit re-encryption, corrected
secret wiring, and a 60-second job/provider/generation/nonce-bound credential lease. Secret values
must be absent from events, jobs, artifacts, command arguments, and logs.

## INFRA-HIGH-099

**Finding:** Marine workload assumptions exceeded the single shared Redis and the already pressured
8 GiB droplet without a measured resource activation gate.

**Evidence:** Production has one memory-limited Redis and the host-capacity audit is already tracked
as `INFRA-HIGH-079`. Existing declared service limits exceed physical memory before adding a
Toolbox workload.

**Root cause and required closure:** The prior design invented cache and worker capacity without
reconciling the deployed host. Closure adds no Marine Redis dependency, keeps the worker inactive,
sets concurrency/AOI/cell/time/output/scratch limits, and requires production-size load/soak,
restart, OOM, and headroom proof. If safe rebudgeting cannot pass, production activation requires
an operator-approved 16 GiB resize.

## PLAT-HIGH-902

**Finding:** Marine had no server-side feature evaluation path, shared JSON error contract, or
disconnect-safe streaming chain across gateway and farm.

**Evidence:** `admin.feature_toggles` is the persistent SSoT but Marine has no signed internal
evaluation path. Gateway's old Marine proxy buffers the complete response with `arrayBuffer()`.
The platform uses JSON error envelopes and has no `application/problem+json` contract.

**Root cause and required closure:** The legacy route treated proxying as a thin endpoint concern
instead of a cross-service control boundary. Closure requires signed fail-closed feature evaluation,
an authenticated frontend capability projection, shared JSON error conformance, byte/header
limits, backpressure, and browser-to-provider/MinIO abort propagation. SRI stays with its existing
platform gate.

## RUST-HIGH-002

**Finding:** Marine needs the platform's first production-governed Rust analysis worker;
inactive `sensor-ingestion` cannot establish deployment or data-loss precedent.

**Evidence:** The existing sidecar is not active in production and its incomplete ingestion path
does not prove durable delivery, provider execution, or restart semantics. Marine requires an
official Toolbox child process and bounded Zarr computation.

**Root cause and required closure:** Reusing language/tooling was mistaken for reusing an operating
model. Closure proceeds through an inactive service-catalog entry and CMEMS-only transport
skeleton, then durable JetStream claim/ack behavior, checksum-pinned Toolbox invocation without a
shell, bounded scratch/concurrency, MinIO manifest verification, SBOM/provenance, health/restart,
and capacity acceptance before production activation. The worker is never authorized for CDSE
credentials or operations.

## FE-HIGH-064

**Finding:** Legacy Marine UI treated duplicated evalscripts, client-side statistics, and display
PNG pixels as scientific authority and lacked current-vector semantics.

**Evidence:** The old farm-module Marine hook/service/tile layer split provider and interpretation
logic across browser paths. The existing catalog does not model currents, analysis-versus-forecast,
or immutable scientific provenance.

**Root cause and required closure:** The overlay was designed as imagery first and analysis later.
Closure uses one server-owned catalog/evalscript registry and immutable snapshot manifest for map,
point, AOI statistics, and time series. Sentinel is limited to Natural Color and qualitative NDWI.
CMEMS stores raw `uo`/`vo` and derives speed/flow-to bearing server-side. PNG stays display-only,
`instanceId` is not migrated, and the legacy client science paths are deleted at cutover.
