# Marine Data Explorer — Canonical Rebuild and Execution Plan

Date: 2026-07-19
Status: IN EXECUTION
Baseline: `origin/main@bdaf00bf6`
Owner: farm-service / marine-explorer, gateway-api, farm-module, platform, infrastructure

## 0. Authority and supersession

This document is the design-of-record for the Marine Data Explorer rebuild. It supersedes the
plan that exists only on branch `claude/marine-data-explorer-arch-15y8qq` and treats the current
`/api/marine`, `marine-data`, Sentinel overlay, browser statistics, and PNG-decoding paths as
legacy code to remove during the controlled cutover. Existing code is reusable only when it passes
the contracts and acceptance gates in this plan; it is not the architecture baseline.

The implementation starts from current `main`. There is no public `v1`/`v2` split and no legacy
delegation layer. The canonical route is `/api/marine-explorer`. Web, gateway, and farm-service
move together through an expand/deploy/contract release sequence, after which `/api/marine` and
its old imports are deleted.

Every implementation commit must reference a canonical finding in `docs/reviews/_registry`.
Plan work-item IDs below are execution coordinates, not substitutes for finding IDs.

Canonical finding map:

- event/control contracts: `CONTRACT-HIGH-003`
- tenant state/usage/retention: `FARM-HIGH-242`
- credential cipher and lease: `SEC-CRITICAL-055`
- Redis/droplet capacity: `INFRA-HIGH-099` (related open evidence: `INFRA-HIGH-079`)
- feature/error/streaming platform path: `PLAT-HIGH-902`
- governed Rust workload: `RUST-HIGH-002`
- scientific/frontend authority: `FE-HIGH-064`

## 1. Product contract

Marine Data Explorer is an exploration and environmental-context product. It does not issue
alerts, automate farm actions, make compliance decisions, or present model output as an in-situ
measurement.

Binding product decisions:

1. A user may see marine data only for sites assigned to that user.
2. Each site has one manager-approved current marine area revision. The editor accepts a polygon
   or radius and the server stores a canonical GeoJSON polygon plus its hash and approval record.
3. Provider credentials are tenant-owned BYOC credentials for both Copernicus Data Space
   Ecosystem/Sentinel Hub (CDSE) and Copernicus Marine (CMEMS).
4. Initial Sentinel layers are Natural Color and NDWI. NDWI is displayed as a qualitative index,
   not as a water-quality measurement. Quantitative Sentinel chlorophyll/turbidity claims are
   removed.
5. Initial CMEMS variables are temperature, salinity, model oxygen, model chlorophyll, and
   currents. `ANALYSIS`, `FORECAST`, `REANALYSIS`, and `HINDCAST` are explicit timeline roles and
   are never silently merged; Sentinel scenes use the separate `OBSERVATION` role.
6. Initial user workflows are map exploration, point sample, AOI statistics, and time series.
7. Provider provenance, model resolution, timestamp, depth, units, no-data state, substitution,
   and attribution are visible in the UI and returned by the API.

## 2. Verified baseline and binding corrections

| ID     | Verified problem                                                                                                 | Binding resolution                                                                                                                                                    | Release gate                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| MDE-01 | `marine.analysis.requested` does not fit the event subject contract                                              | Farm transaction/outbox emits `MarineAnalysisRequested`; derived subject is `events.{tenantId}.MarineAnalysisRequested`                                               | Event contract, registry, fixture, JSON Schema, ACL, and JetStream integration are green                 |
| MDE-02 | New tenant tables were absent from `MODULE_SCHEMAS`                                                              | All four tables omit `schema:` and land with migration, manifest, farm `MODULE_SCHEMAS.tables`, fanout, RLS, and parity tests in one package                          | Strict-ownership boot and two-tenant PostgreSQL isolation pass                                           |
| MDE-03 | Production has one constrained Redis instance, not separate security/session instances                           | Marine adds no Redis dependency in the first release: MinIO stores immutable artifacts, PostgreSQL stores state/idempotency/usage, OAuth uses a bounded process cache | No Marine Redis key or connection exists; capacity evidence is recorded before any later cache proposal  |
| MDE-04 | The existing encrypted-column transformer is a single-key primitive and does not provide a real rotation keyring | A platform credential-cipher/keyring prerequisite provides active-key writes, current/previous reads, AAD, hard typed failures, startup validation, and re-encryption | Missing/invalid keys stop boot; AAD substitution and key rotation tests pass                             |
| MDE-05 | SRI generation and CI checks already exist                                                                       | Marine does not reimplement SRI. Production manifest wiring is handled only under its own tracked infrastructure finding                                              | Existing SRI gates stay green; no Marine-owned asset-retention work is added                             |
| MDE-06 | The platform does not use `application/problem+json`                                                             | Public and internal APIs use `application/json` and one shared `{ success: false, error: { code, message, ... } }` contract                                           | Gateway/farm error conformance tests pass                                                                |
| MDE-07 | Credential reply subjects need a broker-enforced scoped inbox                                                    | A dedicated worker RPC connection uses `_INBOXMARINEANALYSIS.<nuid>`; the event/JetStream connection keeps the default inbox                                          | Exact-CN ACL and cross-CN negative tests pass                                                            |
| MDE-08 | Provider usage accounting omitted worker and Statistical calls                                                   | Reserve before every CDSE Catalog/Process/Statistical, CMEMS WMTS, or CMEMS Toolbox call; finalize the same operation after the call                                  | Retry and crash tests prove one idempotent operation lineage                                             |
| MDE-09 | Retention can conflict with legal hold                                                                           | Every PostgreSQL and MinIO purge first calls `LegalHoldService.assertNoHold(tenantId, 'tenant')`; lookup failure aborts deletion                                      | Held tenant and hold-service failure tests prove zero deletion                                           |
| MDE-10 | `admin.feature_toggles` exists but has no Marine runtime path                                                    | Seed `marine_explorer` disabled; admin remains SSoT; signed internal evaluation is cached briefly and fails closed                                                    | API/job creation/worker execution are server-gated; browser receives only authenticated capability state |
| MDE-11 | Current gateway tile proxy buffers `arrayBuffer()` and cannot propagate disconnect correctly                     | Implement end-to-end streaming, backpressure, byte/header limits, and client-disconnect abort propagation                                                             | Disconnect and slow-reader integration tests prove upstream abort and bounded memory                     |
| MDE-12 | `sensor-ingestion` is inactive and its MQTT path is not a production Rust precedent                              | Marine worker is treated as the first production Rust workload; only repository tooling patterns are reused                                                           | Supply-chain, health, restart, load/soak, image provenance, and deploy gates pass before activation      |
| MDE-13 | The 8 GiB droplet is already under memory/swap pressure (`INFRA-HIGH-079`)                                       | Worker stays inactive until a production-size soak proves the declared budget; otherwise an operator approves a 16 GiB resize or the feature remains disabled         | Capacity gate in section 11 passes                                                                       |
| MDE-14 | Sentinel `instanceId` belongs only to the legacy WMTS path                                                       | Do not migrate it. Migrate client ID/secret, remove UI/GraphQL exposure after zero-use proof, then drop the column in the contract phase                              | No new credential, lease, event, or request contains `instanceId`                                        |
| MDE-15 | Currents need vector semantics, not scalar color decoding                                                        | Store raw `uo`/`vo`; derive speed and flow-to bearing server-side; official vector PNG is display-only                                                                | Scientific fixtures and PNG non-decoding invariant pass                                                  |

`strictOwnership` fails boot when an undeclared source-schema table exists; it must not be
described as automatically deleting the table. Stale comments that claim automatic deletion are
corrected under their own traceable change.

## 3. Target architecture

```text
Authenticated browser
  └─ /api/marine-explorer
       └─ gateway-api: signed identity + streaming + abort/backpressure
            └─ /api/internal/marine-explorer
                 └─ farm-service (authoritative control plane)
                      ├─ site authorization + approved AOI revision
                      ├─ credential metadata + explicit credential cipher
                      ├─ job/snapshot state + usage ledger (PostgreSQL)
                      ├─ Sentinel adapter (Catalog/Process/Statistical)
                      ├─ immutable artifacts/manifests (MinIO)
                      └─ transaction/outbox
                           └─ events.{tenantId}.MarineAnalysisRequested (CMEMS jobs only)
                                └─ marine-analysis-worker (Rust, concurrency=1)
                                     ├─ renewable fenced execution/credential/usage RPC
                                     ├─ exact-object presigned GET/PUT leases (no MinIO key)
                                     ├─ pinned official Copernicus Marine Toolbox CLI
                                     ├─ bounded Zarr read/derive pipeline
                                     └─ content-addressed MinIO artifacts
```

Farm-service is the state and authorization authority. The Rust worker has no farm database
connection. The browser has no provider URL, token, client secret, CMEMS password, evalscript, or
MinIO credential.

Execution ownership is deliberately split: farm-service owns all CDSE/Sentinel HTTP execution and
the bounded CMEMS WMTS HTTP calls used for display/legend artifacts, while the Rust worker owns
only CMEMS Toolbox execution. Farm reserves and finalizes its WMTS calls directly in the same
usage ledger. The worker receives the resolved WMTS display selection for provenance/manifest
correlation but has no WMTS operation authority. A worker lease can therefore never carry a CDSE
credential or CDSE operation. Phase 4 introduces a separately named, farm-owned durable CDSE
dispatch contract before Sentinel execution is activated; CDSE jobs never publish the worker-owned
`MarineAnalysisRequested` event.

## 4. Domain and persistence design

Exactly four new farm-owned, tenant-scoped tables are introduced. Their entities omit `schema:`;
all four names are registered in `MODULE_SCHEMAS['farm'].tables` in the same implementation
package.

### 4.1 `site_marine_areas`

- Immutable revisions with `siteId`, canonical RFC 7946 Polygon/MultiPolygon JSON, bbox, area,
  source shape (`POLYGON`/`RADIUS`), canonicalization version, SHA-256 hash, revision, status,
  approved-by, and approved-at.
- One partial unique current-approved revision per `(tenantId, siteId)`.
- Radius input is converted to a bounded polygon server-side before approval.
- Site existence and the caller's assigned-site scope are checked through the authoritative site
  authorization service for every read and write.

### 4.2 `marine_provider_credentials`

- Provider is `CDSE` or `CMEMS`; every write creates a monotonically increasing credential
  generation. Only one generation per provider is active.
- Persistence fields contain cipher envelope, key ID, generation, status, validation timestamps,
  redacted label, and audit metadata. They do not expose plaintext ORM domain properties.
- `instanceId` is absent.
- Decryption occurs only in the credential-lease responder after authoritative job validation.

### 4.3 `marine_analysis_jobs`

- Job kinds: `SNAPSHOT`, `AOI_STATS`, and `TIME_SERIES`. Point sampling reads an existing completed
  snapshot and does not invoke a provider.
- Stores site, immutable AOI revision snapshot/hash, provider, catalog revision, dataset/version,
  variable/recipe, explicit observation/analysis/forecast/reanalysis/hindcast role, time/depth
  request, canonical request hash, credential generation, creator, execution ID, state, attempts,
  cancellation, expiry, and the immutable result manifest key/hash.
- State machine: `QUEUED -> CLAIMED -> RUNNING -> SUCCEEDED|FAILED|CANCELLED|EXPIRED`; each
  transition is compare-and-set and auditable.
- Unique `(tenantId, idempotencyKey)` prevents duplicate requests.
- A completed `SNAPSHOT` job is the snapshot resource. `/snapshots/:id` and
  `/analysis-jobs/:id` are two projections of the same authoritative row; there is deliberately no
  fifth `marine_snapshots` table and no duplicate lifecycle source.
- Derived jobs reference a completed snapshot job through `sourceSnapshotJobId`.

### 4.4 `marine_usage_operations`

- One row per external call attempt lineage, including CMEMS WMTS display requests:
  job/execution, provider, operation type, idempotency
  key, state, attempt count, reservation/finalization times, upstream request ID, HTTP/tool status,
  processing units where supplied, bytes in/out, duration, and redacted failure code.
- Unique `(tenantId, idempotencyKey)`. `RESERVED` is written before the provider call and the same
  row becomes `SUCCEEDED`, `FAILED`, or `CANCELLED`.
- A successful finalization requires Toolbox exit `0` or an HTTP `2xx` status; `NOT_AVAILABLE`, a
  non-zero tool exit, and a non-`2xx` HTTP status cannot produce a contradictory successful row.
- A reconciler resolves abandoned reservations from authoritative job state without replaying an
  unbounded provider call.

### 4.5 Migration invariants

- First migration slot: `1806800000000-CreateMarineExplorerFoundation`.
- Schema-unqualified DDL, migration manifest registration, bounded lock/statement timeouts,
  tenant-bearing indexes/uniques, forced RLS, postconditions, and forward-only destructive-data
  policy.
- Tenant fanout parity proves both new and existing tenant schemas; no table appears in `public`.
- Credential records are not migrated until the platform keyring and the production
  `SENTINEL_HUB_ENCRYPTION_KEY` versus `ENCRYPTION_KEY` wiring mismatch are resolved.

## 5. Eventing and worker control plane

### 5.1 Durable request event

For a CMEMS job, the request handler writes the job and outbox event in one tenant transaction using
`createBaseEvent()` and the platform outbox. The contract is
`MarineAnalysisRequestedEvent`, subject `events.{tenantId}.MarineAnalysisRequested`, version 1.
This is a worker-dispatch event, so its provider is the constant `CMEMS`; a CDSE job is rejected at
this boundary and uses the separate farm-owned execution lane introduced in Phase 4.

The event contains only identifiers and immutable fingerprints needed to claim work:
`analysisJobId`, `executionId`, `siteId`, `marineAreaId`, `provider`, `jobKind`,
`requestFingerprint`, `credentialGeneration`, and `requestedAt`. It contains no credential,
provider token, AOI body, or general nested payload. The worker obtains the full canonical job
specification through the authoritative execution-lease RPC.

The new contract has a strict JSON Schema and golden fixture. No fabricated v1-to-v2 upcaster is
created for an event that has never shipped. An upcaster is mandatory when the first real breaking
wire change is introduced.

### 5.2 JetStream consumer

- Use the existing `AQUACULTURE_EVENTS` stream, whose `events.>` subject already includes the new
  event. Do not create or update a stream for Marine.
- Durable name `marine-analysis-worker-v1`; filter
  `events.*.MarineAnalysisRequested`; `DeliverPolicy=All`, explicit ack,
  `max_ack_pending=1`.
- An infrastructure-owned activation step provisions and verifies that durable using an operator
  identity before the worker deployment is enabled. The worker binds with the direct
  consumer-from-stream lookup; it cannot create, update, delete, list, or repair consumers and
  cannot query or mutate stream configuration.
- Startup/readiness uses only
  `$JS.API.CONSUMER.INFO.AQUACULTURE_EVENTS.marine-analysis-worker-v1` and fails closed if the
  durable is missing or its filter, delivery, ack, or pending-limit configuration differs. Pulls
  publish only to
  `$JS.API.CONSUMER.MSG.NEXT.AQUACULTURE_EVENTS.marine-analysis-worker-v1`; acknowledgements,
  negative acknowledgements, and progress acknowledgements publish only to
  `$JS.ACK.AQUACULTURE_EVENTS.marine-analysis-worker-v1.>`.
- Validate strict payload schema, subject tenant token equals payload `tenantId`, and subject suffix
  equals `eventType` before work starts.
- Poison contract: audit/metric then terminal delivery. Transient control-plane/provider/storage
  failure: bounded negative-ack backoff. Long Toolbox execution sends progress acknowledgements.
  Ack only after farm-service persists the terminal state and manifest hash.

### 5.3 Scoped RPC

Worker RPC uses a second NATS connection with custom prefix
`_INBOXMARINEANALYSIS.<nuid>`. Its JetStream connection retains default `_INBOX` behavior. Farm
responders use the platform request/reply wire contract, not a Nest transport envelope.

Authoritative request subjects:

- `request.farm.marineExecutionLease`
- `request.farm.marineExecutionRenew`
- `request.farm.marineCredentialLease`
- `request.farm.marineUsageReserve`
- `request.farm.marineUsageFinalize`
- `request.farm.marineArtifactLease`
- `request.farm.marineExecutionFinalize`

The initial execution lease binds job ID, execution ID, nonce, request fingerprint, immutable
`requestedAt`, a stable positive `leaseVersion` fencing epoch, `issuedAt`, and a maximum-60-second
expiry to the immutable job specification. `issuedAt < expiresAt` is validated on both TypeScript
and Rust boundaries. The specification carries the selected temporal partition boundary plus the
provider coverage observed at selection time; the requested range must remain inside that coverage.
Farm resolves the chosen CMEMS catalog-v2 entry before issuing the worker lease and carries it as one
closed `selectionProvenance` value rather than a set of independent top-level
catalog fields. That value binds the catalog version/hash and entry ID to the exact product,
dataset version part, raw variables with units, spatial/depth selection, no-data rule, processing
derivation, style/legend locks, attribution lock, and the checksum-pinned Toolbox artifact.
Required nullable fields must be present as explicit `null`; TypeScript and Rust
reject omitted fields, provider mismatches, open objects, and internally inconsistent selections.
Every Marine event/control instant uses canonical UTC millisecond wire form
`YYYY-MM-DDTHH:mm:ss.sssZ`, so TypeScript and Rust compare identical precision.
`ANALYSIS` ends at or before the `requestedAt` boundary, `FORECAST` starts strictly after it, and
the other roles carry an explicit null boundary. The specification rejects inverted time ranges;
depth bounds are both absent or both present with minimum not greater than maximum. Its canonical
GeoJSON is a bounded, closed 2D Polygon/MultiPolygon rather than an opaque string. `SNAPSHOT` has no
`sourceSnapshotJobId`, while `AOI_STATS` and `TIME_SERIES` require one. Worker specifications use
one of the four CMEMS model roles; farm-owned CDSE specifications use `OBSERVATION` outside this
RPC boundary. The execution deadline is after issuance and no more than ten minutes later.
The worker renews at most every 20 seconds, and the scheduled renewal instant must be strictly
before lease expiry. Farm extends the lease only when job, execution, lease ID, and fencing epoch
are still current. The reply is a closed `CONTINUE` decision with a new `issuedAt` and
maximum-60-second expiry or a closed `STOP` decision with one of
`CANCEL_REQUESTED`, `FEATURE_DISABLED`,
`CREDENTIAL_REVOKED`, `LEASE_FENCED`, or `DEADLINE_EXCEEDED`. Missing, invalid, late, or
unreachable renewal stops provider work and artifact uploads. A takeover increments the fencing
epoch; renewal itself does not, so concurrent usage accounting cannot invalidate an active claim.
`DELETE` marks cancellation in farm state; the renewal loop terminates the Toolbox with a bounded
TERM/grace/KILL sequence and finalizes the execution as non-retryable `CANCELLED`.

Credential, usage, artifact, and execution-finalize requests carry the current execution lease ID
and fencing epoch. The credential request binds the constant `CMEMS` provider, nonce, and expected
credential generation; the reply generation must equal that request value. The only worker
credential kind is `CMEMS_USERNAME_PASSWORD`, and worker usage operations are CMEMS-only.
Credential and artifact lease replies carry `issuedAt`; their expiry is strictly later and no more
than 60 seconds after
issuance. Farm validates job status,
provider, execution, credential generation, non-revocation, and current lease before returning
`{leaseId, issuedAt, kind, value, expiresAt, generation}`. Plaintext exists only in bounded process memory,
is passed to the Toolbox through its environment rather than command arguments, and is never
logged or persisted. Audit stores metadata and hashes only.

The worker has no static MinIO credential. For a read, it asks for a source snapshot artifact by
authorized snapshot ID, artifact kind, and content hash. For a write, it supplies artifact kind,
media type, exact byte length, content hash, and nonce; it never supplies an object key or prefix.
Farm derives the exact content-addressed key, reserves bounded object count and cumulative bytes,
and returns a maximum-60-second presigned GET or conditional single PUT for that one object. The
signed URL is secret material carried only on the scoped inbox. PUT leases sign content type,
length, checksum, and no-overwrite headers; GET leases require no caller-provided headers. The
manifest uploads last, and farm verifies exact key, hash, size, and manifest membership before
success. The 256 MiB output cap keeps multipart authority out of the first release.

Before invoking any Marine RPC handler, the farm responder verifies that the broker reply subject
starts with `_INBOXMARINEANALYSIS.` and contains one concrete NUID token. A request carrying the
default `_INBOX.` or any other reply subject is rejected before job lookup or credential decrypt.
This application-boundary check is mandatory because farm-service legitimately retains broad
default-inbox publish permission for unrelated platform RPC replies.

`authenticatedIdentity` carried in a message header is not an authentication source. Authorization
comes from exact NATS cert-CN ACL plus authoritative job state.

Responder failures cross the wire only as a bounded allowlisted error code and a generic sanitized
message. Raw caught exception text, provider bodies, signed URLs, and secret values never enter a
reply or worker log; Rust error display is code-only.

### 5.4 NATS source of truth

- Canonical worker service/CN: `marine_analysis_worker`.
- `infrastructure/nats/services.yaml` is the only ACL source; generated `nats.conf` changes in the
  same package.
- Worker consumes the durable stream through JetStream API permissions; it does not receive a Core
  subscribe grant for `events.*.MarineAnalysisRequested`.
- Worker JetStream publish ACL contains only the exact durable INFO, MSG.NEXT, and ACK grants in
  section 5.2; it has no broad `$JS.API.>`, runtime CREATE/UPDATE/DELETE/LIST, stream-admin, or
  other-consumer access. Its subscribe ACL contains only `_INBOX.>` for JetStream delivery plus
  `_INBOXMARINEANALYSIS.>` for farm control-plane replies.
- Scoped-inbox schema validation becomes a generic explicit-prefix rule, and invariants prove only
  the `marine_analysis_worker` service identity can subscribe and only `farm_service` can publish
  the Marine reply prefix. Cert-CN ACLs isolate services, not connections or replicas sharing one
  certificate. The deployment therefore remains one worker replica; any scale-out requires
  per-replica certificate identities and correspondingly exact reply-prefix ACLs before activation.
- Static ACL invariants prove the declared subject ownership in Phase 0. Before activation, the
  Phase-3 real-broker acceptance suite must prove exact INFO/MSG.NEXT/delivery/ACK success, then
  prove consumer create/delete/list, stream administration, Core event subscribe, another durable,
  and another stream are denied for CN `marine_analysis_worker`.

## 6. Credential cipher prerequisite

The existing `createEncryptedColumnTransformer()` is not used as a pretend keyring. A platform
credential-cipher component is added under backend-common with this contract:

- Bootstrap from a secret-file key map plus explicit active key ID; no keys in repository files.
- AES-256-GCM envelope records format version and key ID.
- Writes use only the active key; reads accept the configured current/previous set.
- AAD binds tenant ID, table, row ID, provider, field purpose, and credential generation.
- Unknown key ID, authentication failure, malformed envelope, missing active key, duplicate key ID,
  or weak key is a typed hard failure. Callers cannot receive marker strings or `null` as if decrypt
  succeeded.
- Rotation command re-encrypts under lock with compare-and-set generation and records audited
  counts without secret values.
- Unit, integration, startup, redaction, and migration tests cover write/read/rotate/remove-old-key
  and AAD substitution.

No provider credential table or legacy credential migration becomes active before this gate passes.

## 7. Provider and scientific contracts

### 7.1 Server-owned catalog

One versioned registry in farm-service owns provider, product/dataset version, variable, units,
scalar/vector/raster kind, explicit `OBSERVATION`/`ANALYSIS`/`FORECAST`/`REANALYSIS`/`HINDCAST`
role, depth semantics, no-data value, recipe/evalscript hash, legend, and attribution. Provider
availability may change; the catalog never silently substitutes a product or variable.
Availability checks are usage-ledger operations.

The worker execution lease contains the fully resolved immutable CMEMS catalog selection so the
worker does not infer missing provenance. There is no independently authored second catalog
authority: both TypeScript and Rust validators consume a deterministic, CI-gated derivative of the
sole farm v2 catalog. The farm-owned CDSE runner resolves that v2 registry directly. Both
result-manifest paths copy their resolved selection, record provider-observed coordinates and
request IDs, and persist both the attribution lock ID and the final credit/citation text plus the
exact resolved template-variable map (`YEAR` or `ACCESSED_ON`) after all required variables have
been resolved.

Each operational CMEMS analysis/forecast pair declares a closed temporal selection policy even
when both entries use the same upstream dataset. The immutable job creation timestamp is the UTC
partition boundary: `ANALYSIS` accepts acquisition times at or before that boundary and `FORECAST`
accepts times strictly after it. The chosen boundary, provider coverage observed at selection time,
role, and dataset version are persisted in the job and manifest. A time outside the selected role's
partition is rejected; the server never falls through to its sibling role. Multiyear products use
their declared `REANALYSIS` or `HINDCAST` role and never substitute for an operational entry.

No browser evalscript exists. There is one server-owned Sentinel evalscript registry and its recipe
hash is part of every snapshot key and manifest.

### 7.2 Sentinel/CDSE

- Catalog discovers source scenes; Process produces Natural Color/NDWI visualization artifacts;
  Statistical produces supported NDWI AOI statistics and time series.
- Natural Color is map-only display imagery. It has no numeric point, AOI-statistics, or time-series
  capability, and no synthetic scalar is derived from its RGB bands.
- Each NDWI snapshot stores two distinct artifacts from one hash-pinned server recipe: a display
  image and a no-data-aware one-band `FLOAT32` analytic raster. Point samples read only the
  analytic raster; AOI statistics and time series use the matching Statistical recipe/output.
  Neither path decodes the display PNG.
- OAuth client-credential tokens are cached in a size-1-per-credential-generation bounded memory
  cache, expire before provider expiry, and are never persisted.
- Natural Color exposes imagery, not scalar statistics.
- Provider Process/Statistical responses and request IDs are recorded in the usage ledger; raw
  secrets and bearer tokens are excluded.

### 7.3 CMEMS

- A checksum-pinned official Copernicus Marine Toolbox CLI is invoked by Rust without a shell.
  There is no Python application runtime.
- Subset output is Zarr. Rust reads bounded chunks using the pinned compatible Zarr library and
  calculates point samples, AOI statistics, and time series from raw arrays.
- Dataset ID, dataset version/part, variables, time/depth coordinates, selection method, Toolbox
  version/checksum, and derivation version are recorded in the manifest.
- Analysis and forecast are separate catalog entries with non-overlapping temporal selectors even
  when they represent the same variable. Reanalysis and hindcast remain separate model roles.

### 7.4 Currents

- Catalog kind is a discriminated vector.
- Display may use the official `sea_water_velocity` style
  `vectorStyle:solidAndVector`, captured as a pinned immutable PNG artifact.
- The authoritative numeric snapshot stores raw eastward `uo` and northward `vo` in m/s.
- Server derivations are `speed = sqrt(u^2 + v^2)` and flow-to bearing
  `atan2(u, v)` normalized clockwise from north.
- Point and time-series responses return `u`, `v`, `speed`, and `bearing`. AOI vector summaries
  operate on components and circular direction; they never average degree values arithmetically.

PNG is a display artifact only. No value, statistic, legend class, or scientific decision is
decoded from PNG pixels, and a static invariant blocks reintroduction.

## 8. Snapshot and artifact contract

Canonical snapshot fingerprint includes tenant, site, approved AOI revision/hash, provider,
catalog revision, product/dataset version, variable/recipe, explicit data role, temporal partition
boundary, acquisition time, depth, spatial resolution, processing version, and credential
generation where provenance requires it.

MinIO object prefix:

```text
marine/{tenantId}/{siteId}/{analysisJobId}/{contentSha256}/...
```

Objects are written with no-overwrite semantics. The final manifest lists every artifact hash,
media type, byte count, source request IDs, units, coordinate/depth/time axes, no-data rules,
derivations, Toolbox/evalscript version, attribution lock ID, resolved credit/citation strings,
exact attribution template-variable values, and retention class. Farm-service verifies the
manifest hash before transitioning the job to `SUCCEEDED`.

Worker storage access is capability-based: farm-service derives every object key and issues one
short-lived exact-object lease. There is no worker-wide bucket policy or access key. A read lease
must resolve through the authorized source snapshot manifest; a write lease must resolve through
the active job, lease ID, fencing epoch, artifact-kind filename map, hash, and reserved byte budget.
Cross-job, cross-site, traversal, overwrite, expired URL, and replay attempts are rejected.

Retention enumerates authoritative PostgreSQL rows first, checks tenant legal hold, deletes MinIO
objects by exact stored keys, confirms deletion, and then updates/deletes database state. Legal-hold
lookup failure stops the purge. No marine/site/job legal-hold scope is invented; the existing
`tenant` scope is used.

## 9. Canonical HTTP API

All endpoints are authenticated, tenant-bound by the signed gateway assertion, feature-gated
server-side, and use `application/json` error envelopes. Site/area/catalog/job/snapshot endpoints
also enforce assigned-site scope. Tenant-wide provider-credential endpoints instead require the
explicit `marine-provider-credentials:manage` tenant permission and tenant-admin role policy;
having access to any site never grants credential administration.

### Site and credential settings

- `GET /api/marine-explorer/sites/:siteId/area`
- `PUT /api/marine-explorer/sites/:siteId/area`
- `GET /api/marine-explorer/provider-credentials`
- `PUT /api/marine-explorer/provider-credentials/:provider`
- `POST /api/marine-explorer/provider-credentials/:provider/validate`
- `DELETE /api/marine-explorer/provider-credentials/:provider`

Credential reads return metadata only. Writes never echo a secret.

### Explorer and analysis

- `GET /api/marine-explorer/catalog?siteId=`
- `POST /api/marine-explorer/availability`
- `POST /api/marine-explorer/snapshots` — returns `202` and the job/snapshot ID
- `GET /api/marine-explorer/snapshots/:id`
- `GET /api/marine-explorer/snapshots/:id/tiles/:z/:x/:y.png`
- `GET /api/marine-explorer/snapshots/:id/legend`
- `POST /api/marine-explorer/point-samples` — requires a completed snapshot ID and a catalog layer
  with numeric point capability; Natural Color is rejected as unsupported
- `POST /api/marine-explorer/analysis-jobs`
- `GET /api/marine-explorer/analysis-jobs/:id`
- `GET /api/marine-explorer/analysis-jobs/:id/result`
- `DELETE /api/marine-explorer/analysis-jobs/:id`

Internal farm paths are `/api/internal/marine-explorer/...`. Controllers call an application
service, which calls CommandBus/QueryBus, handlers, and repositories/provider ports. Controllers do
not call repositories or providers directly.

Streaming responses propagate cancellation:

```text
browser disconnect -> gateway AbortSignal -> farm AbortSignal -> MinIO/provider stream abort
```

Allowlisted response headers, maximum content length, per-route timeout, backpressure, and partial
response behavior are contract-tested. Gateway does not call `arrayBuffer()` for tiles/artifacts.

## 10. Frontend contract

- Canonical route: `/sites/marine` inside farm-module.
- Authenticated bootstrap exposes `marineExplorer.enabled`; UI hiding is not authorization.
- Tenant/site/snapshot/catalog revision are present in every TanStack Query key.
- UI provides site/AOI picker, scalar/vector layer picker, analysis/forecast timeline, depth,
  immutable layer rendering, point inspector, AOI statistics, time series, current-vector legend,
  provenance, no-data/substitution state, and attribution.
- Client performs no evalscript construction, scientific aggregation, unit conversion whose result
  is authoritative, PNG decoding, or provider authentication.
- Accessibility, keyboard navigation, localization, URL state, and stale-result cancellation are
  acceptance requirements.

## 11. Feature rollout and capacity

`admin.feature_toggles` remains the SSoT. Seed key `marine_explorer` as disabled with an explicit
tenant allowlist. Admin-api exposes a signed internal evaluation/snapshot contract. Farm and
gateway cache the signed result briefly; missing, expired, invalid, or unreachable evaluation means
disabled. Worker rechecks authoritative job eligibility before a provider call. The browser sees
only the evaluated capability attached to authenticated bootstrap data.

There is no Marine Redis allocation in this release.

The worker and Toolbox share one cgroup and start with concurrency 1. Initial hard safety caps are
250 km² AOI bbox, 1,000,000 selected cells, 366 time steps, 256 MiB result, 1 GiB scratch, and a
10-minute execution deadline. Raising a cap requires new soak evidence and a capacity change.

Production activation requires a production-size staging soak at the maximum accepted request and:

- no OOM event or unexpected restart;
- worker peak RSS within its declared cgroup limit;
- host p95 `MemAvailable >= 2 GiB` during the soak;
- host p95 CPU below 70% and provider work unable to starve API health checks;
- scratch/object-store free-space margin at least twice the request cap plus 20%;
- declared compose memory limits plus the Marine reservation reconciled with physical memory;
- recovery/redelivery test after worker kill and Toolbox timeout.

The current 8 GiB host and its existing overcommitted limits do not satisfy this gate by assumption.
If measured rebudgeting cannot satisfy it, an operator-approved 16 GiB resize is required; without
one, `marine_explorer` stays disabled and the worker remains inactive.

## 12. Execution phases

Each package is independently reviewable and green. A later phase cannot activate behavior whose
earlier stop-line is incomplete.

### Phase 0 — traceability and dormant contracts

1. Register the verified findings with owners/deadlines.
2. Add the CMEMS-only `MarineAnalysisRequested` worker event plus scoped execution claim/renew, credential, usage,
   exact-object artifact, and finalization contracts with fencing, strict schemas, golden fixtures,
   TypeScript/Rust semantic parity tests, and platform event registry entry.
3. Add `marine_analysis_worker` to `services.yaml`, exact pre-provisioned-durable JetStream grants,
   generic scoped-inbox validation, generated NATS config, and positive/negative ACL invariants.
4. Add an inactive Rust/Nx/Cargo worker transport skeleton and reusable validated custom-inbox
   support. Service catalog status is inactive/non-deployable; no compose service or consumer loop
   is enabled.
5. Pin official dataset/product/variable/style identifiers and Toolbox version/checksum in a
   reviewed catalog manifest before provider execution code.

Gate: contracts and ACLs are proven, the worker performs no provider call, and no production
workload/consumer is activated; the new broker identity remains unused by a runtime deployment.

### Phase 1 — platform prerequisites

1. Implement and validate the platform credential cipher/keyring.
2. Fix production secret wiring, then prove existing Sentinel credential decrypt/re-encrypt.
3. Add the shared JSON error envelope and gateway/farm conformance tests.
4. Add signed internal feature-toggle evaluation, disabled seed, short fail-closed caches, and
   authenticated capability projection.
5. Implement the generic gateway/farm streaming and abort chain with byte/header limits.

Gate: credential, feature, error, and streaming stop-lines pass before Marine persistence or
provider execution is activated.

### Phase 2 — farm domain foundation

1. Land all four entities, migration `1806800000000`, migration manifest, `MODULE_SCHEMAS`, forced
   RLS, tenant fanout, and PostgreSQL isolation in one package.
2. Implement approved AOI revision CQRS and manager-only settings API.
3. Implement credential generation/revoke/validate CQRS using explicit cipher operations and seed
   the `marine-provider-credentials:manage` tenant permission for the tenant-admin policy only.
4. Migrate supported Sentinel client ID/secret into the new credential model; do not migrate
   `instanceId`.
5. Implement job state/idempotency, usage reserve/finalize, CMEMS-only outbox request, scoped claim/renew/
   credential/artifact/finalize responders, cancellation state, fencing takeover, bounded artifact
   reservations, and reconciliation. Every responder rejects a non-Marine reply prefix before
   handler execution and emits only typed sanitized errors.

Gate: two-tenant/site negative tests, strict-ownership boot, atomic job/outbox, lease revocation,
and duplicate request tests pass.

### Phase 3 — inactive worker executor

1. Add the infrastructure-owned durable provisioning/verification step, implement worker
   INFO-only liveness plus durable pull consumption, and validate strict subject/payload matching.
2. Claim and renew fenced execution/credential leases; run cancellation heartbeat concurrently;
   reserve/finalize every CMEMS call.
3. Invoke the pinned Toolbox without a shell, enforce timeout/cancel/resource caps, read Zarr,
   derive values, and use only exact-object presigned leases for content-addressed MinIO objects.
4. Finalize farm state and ack only after manifest verification.
5. Add real-broker least-privilege negative tests, crash, redelivery, poison, nonce replay,
   lease-expiry/takeover fencing, cancel TERM/grace/KILL, secret/URL redaction, bounded scratch,
   no-overwrite, and cross-job/object-lease tests.

Gate: worker remains deployment-inactive but completes the full pipeline in integration.

### Phase 4 — provider and snapshot core

1. Activate the farm-owned resolver and availability path from the reviewed v2 catalog lock; do
   not introduce another catalog authority.
2. Add a separately named strict CDSE dispatch event and farm-owned durable consumer; it is never
   consumed by or authorized to the Rust worker.
3. Implement Sentinel Catalog/Process/Statistical adapters and bounded OAuth cache.
4. Implement CMEMS analysis/forecast/reanalysis/hindcast subset recipes for the approved
   variables and enforce the catalog's temporal partitions.
5. Implement snapshots, manifest verification, tile/legend reads, point samples, AOI stats, time
   series, and current-vector derivations.
6. Add golden scientific fixtures for units, time/depth selection, no-data, AOI mask, scalar stats,
   vector components/bearing, and provider error classification.

Gate: every outbound call has a finalized ledger row; one snapshot supplies map, point, stats, and
time-series provenance; PNG non-decoding invariant is green.

### Phase 5 — canonical API and frontend

1. Implement farm internal CQRS routes and canonical gateway routes.
2. Build `/sites/marine` and Site-settings AOI/credential surfaces against the new API.
3. Implement server-driven catalog, timeline/depth, scalar/vector rendering, inspection, stats,
   series, provenance, and cancellation.
4. Run assigned-site/tenant/credential-RBAC/security API E2E, HTTP cancel-to-worker termination
   propagation, browser accessibility, and stale-request tests.

Gate: browser has no provider/secret/evalscript path and all scientific results are server-owned.

### Phase 6 — deploy, canary, cutover, and deletion

1. Add signed/SBOM-attested worker image, health/restart rules, cert mounts, same-cgroup Toolbox,
   resource limits, immutable image matrix, and deploy verification as one production package.
2. Pass section 11 capacity/load/soak gates.
3. Enable `marine_explorer` for an explicit tenant allowlist and observe provider, job, memory,
   latency, cancellation, and ledger invariants.
4. Perform the coordinated web/gateway/farm cutover.
5. Delete the old `/api/marine` route, `apps/farm-service/src/marine-data`, old browser service/hook,
   authenticated tile layer, MapView Marine overlays, duplicated evalscripts, client statistics, and
   PNG value-decoding code after zero-import proof.
6. Remove `instanceId` UI/GraphQL usage, prove zero reads, then drop its column through
   expand-contract migration.
7. Enable additional tenants only after canary acceptance. Rollback is feature-toggle disablement,
   not restoration of the legacy architecture.

Gate: old paths have zero imports/routes, canary evidence is stored, legal-hold retention tests are
green, and production worker health/capacity evidence passes.

## 13. Verification matrix

| Boundary        | Required proof                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event contract  | TypeScript compile, strict AJV fixture tests, Rust golden parity, subject/payload tenant match                                                                |
| NATS security   | Generated config parity, exact durable-only CN ACL, scoped inbox exclusivity, positive INFO/pull/ack, negative admin/lateral access, real delivery/redelivery |
| Tenant data     | Entity metadata, migration postcondition, `MODULE_SCHEMAS` parity, forced RLS, two-tenant PostgreSQL E2E                                                      |
| Site access     | Assigned-site positive/negative tests at settings, catalog, job, snapshot, tile, sample, result, and cancel boundaries                                        |
| Credential RBAC | Tenant-admin plus `marine-provider-credentials:manage`; assigned-site access alone denied; metadata-only reads and secret redaction                           |
| Credentials     | Startup/key rotation/AAD/lease/revoke/nonce/fencing/redaction tests; no plaintext persistence/log/artifact scan                                               |
| Usage           | Reserve-before-call, same-id finalize, provider request ID/bytes/PU/status, retry/crash reconciliation                                                        |
| Science         | Pinned product/variable fixtures, units/depth/time/no-data, AOI mask, NDWI semantics, u/v/speed/bearing golden values                                         |
| Storage         | Exact-object GET/PUT leases, no static worker key, no-overwrite, manifest/hash verification, abort cleanup, hold-safe purge                                   |
| HTTP            | Shared JSON errors, max bytes/headers, streaming backpressure, disconnect abort, auth/tenant/site failures                                                    |
| Frontend        | Capability gate, tenant query keys, no client stats/evalscript/PNG decode, a11y/i18n, provenance and caveat visibility                                        |
| Operations      | Inactive-before-gates invariant, SBOM/provenance, health/restart, max-size soak, OOM/redelivery/cancel drills                                                 |

Every package runs targeted tests first, then `nx affected --target=test`,
`nx affected --target=lint`, relevant TypeScript/Rust checks, migration/invariant tests, and secret
scans. A package with a red gate does not advance the phase.

## 14. Definition of done

The rebuild is complete only when:

1. `/api/marine-explorer` and `/sites/marine` are the only Marine Explorer surfaces.
2. Old `/api/marine` and all client-side science/PNG-decoding paths are deleted.
3. Every result is reproducible from an immutable job/snapshot manifest and pinned recipe/tool
   versions.
4. Every provider call has a reserve/finalize usage record.
5. Credentials are BYOC, key-rotatable, lease-scoped, and absent from logs/events/jobs/artifacts.
6. Assigned-site and tenant isolation pass through browser, gateway, farm, NATS, worker, database,
   and object storage.
7. Legal hold stops both row and object retention deletion.
8. Observation, analysis, forecast, reanalysis, hindcast, and model semantics are explicit in API
   and UI.
9. The worker passes production-size capacity/soak and supply-chain gates before activation.
10. Feature disablement blocks new API jobs and worker execution fail-closed without reactivating
    legacy code.

## 15. Official external contracts

Phase-0 Toolbox authority verified on 2026-07-19: upstream release `v2.4.1`, published
2026-05-11; Linux baseline asset `copernicusmarine_linux-glibc-2.35.cli`, size 154,166,192 bytes,
GitHub release digest
`sha256:e65f72db9fc7075f91fc9bd90368246248aa39a599a8a79eb4d06a5705b15864`.
The worker build must verify all four coordinates (release, asset name, size, digest) before making
the binary executable. A later upstream release does not change this pin automatically.

- CDSE Sentinel Hub authentication:
  <https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/Authentication.html>
- CDSE Sentinel Hub Catalog examples:
  <https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Catalog/Examples.html>
- CDSE Sentinel Hub Process API:
  <https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Process.html>
- CDSE Sentinel Hub Statistical API:
  <https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Statistical.html>
- Copernicus Marine Toolbox introduction and supported programmatic access:
  <https://help.marine.copernicus.eu/en/articles/7949409-copernicus-marine-toolbox-introduction>
- Official Copernicus Marine Toolbox repository/releases:
  <https://github.com/mercator-ocean/copernicus-marine-toolbox>
- Toolbox subset CLI and spatial/time/depth/variable selection:
  <https://help.marine.copernicus.eu/en/articles/7972861-copernicus-marine-toolbox-cli-subset>
- Copernicus Marine ARCO geoseries/time-series services:
  <https://help.marine.copernicus.eu/en/articles/7969584-copernicus-marine-toolbox-services>
- Zarr format characteristics:
  <https://help.marine.copernicus.eu/en/articles/10401542-introduction-to-the-zarr-format>
- CMEMS WMTS vector rendering:
  <https://help.marine.copernicus.eu/en/articles/6478168-how-to-use-wmts-to-visualize-data>
- Current/wave/wind direction convention:
  <https://help.marine.copernicus.eu/en/articles/5046685-which-is-the-direction-conventions-of-currents-wave-and-wind-for-copernicus-marine-products>

Provider identifiers and checksums are copied into the versioned catalog manifest only after
verification against these official contracts and the live Copernicus catalogs.
