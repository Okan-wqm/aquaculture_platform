# Farm environmental monitoring — implementation findings

Review cycle: `2026-07-31-farm-environment-monitoring`

Scope: the tenant-facing farm panel, site authorization, environmental
observation persistence, MET Norway/CMEMS/CDSE provider boundaries, credential
ownership, and retirement of the duplicate satellite UI/API paths.

## FARM-HIGH-243

### Assigned-site authorization was missing from farm reads

`MODULE_USER` is a tenant membership role, not permission to enumerate every
physical farm site. The site list/read handlers previously applied the tenant
predicate without resolving the caller's assigned-site scope. Any monitoring
surface built on that list inherited the same object-authorization gap.

The closure must:

- resolve collection scope through `SiteAuthorizationService`;
- return only assigned sites for non-manager users and fail closed on an empty
  or absent assignment;
- apply the same check to environment current/history/forecast/catalog/scenes
  and binary imagery reads;
- preserve tenant-wide access for manager-or-higher roles through the canonical
  role hierarchy.

Verification: handler and resolver authorization tests cover assigned,
unassigned, empty-claim, manager, cross-tenant, and site-not-found cases.

## FARM-HIGH-244

### Environmental data had no canonical site ingestion pipeline

The existing weather cron wrote a limited Open-Meteo projection, while the
marine and satellite paths fetched provider responses on demand. There was no
single record of provider, product/dataset, acquisition or model time, issue
time, quality, selected depth/grid cell, site-location revision, or idempotent
source run. Consequently a tenant panel could render a request result, but it
could not prove what was observed, reproduce a scene selection, distinguish a
model from a sensor, or report ingestion health.

The closure must provide:

- one backend-owned catalog with explicit imagery, indicator, analysis,
  forecast, and observation semantics;
- MET Norway Locationforecast and Frost, regional CMEMS model products, and
  CDSE Sentinel-2 exact-scene acquisition behind fixed allowlisted endpoints;
- append-only weather/marine observations and immutable satellite scene
  provenance keyed by tenant, site, provider, source run, valid time, and
  monitoring-location revision;
- a distributed lease-based scheduler with bounded retries, durable status,
  idempotent inserts, provider calls outside database transactions, and
  forty-five-day retention;
- one site-scoped GraphQL read contract for current, history, seven-day
  forecast, layer availability, and real acquisition dates.

Verification: provider schema/security suites, migration contract tests,
lease/race/revision/idempotency tests, query authorization tests, feature-gate
tests, and TypeScript/lint checks.

## FARM-HIGH-245

### Duplicate satellite surfaces overstated unsupported science

The browser-owned map catalog and arbitrary AOI proxy paths could request
provider data independently of a persisted farm site. They also presented
uncalibrated optical band ratios and unsupported layers using concentration or
diagnostic language. This split the layer contract between frontend and
backend and made visual availability look like a validated in-water
measurement.

The closure must:

- make the backend catalog the only authority for identifiers, units,
  capabilities, provenance labels, and availability;
- bind every imagery request to an authorized `SEA_CAGE` site and a persisted
  catalog scene at the current location revision;
- label Sentinel chlorophyll/algae and turbidity products as dimensionless,
  uncalibrated optical proxies, never as chlorophyll concentration, NTU, or a
  harmful-algal-bloom diagnosis;
- remove the duplicate browser catalog, local AOI store, direct provider URLs,
  and false static layers;
- retain explicit HTTP 410 tombstones for stale arbitrary-AOI clients.

Verification: catalog contract tests, legacy-route 410 tests that assert no
upstream request, exact-scene mismatch tests, and frontend rendering tests for
all availability/quality states.

## FARM-HIGH-246

### Provider credential authority was split and leaked reusable tokens

The farm-local Sentinel settings table and the configuration service both acted
as credential owners. GraphQL exposed access-token and WMTS configuration
shapes that allowed reusable provider credentials to reach browser memory.
Rotation and company-default versus tenant-override behavior could therefore
diverge between runtime paths.

The closure must:

- make config-service the encrypted credential authority for CDSE, with an
  audited company default and legacy tenant overrides admitted only by the
  signed one-shot cutover; CMEMS uses the fixed public discovery/WMTS boundary
  and has no tenant credential surface;
- migrate retained farm-local records through an explicit, provenance-bearing
  cutover and remove them from every runtime read/write path;
- keep OAuth acquisition and caching server-side, keyed by credential
  generation, with bounded provider responses;
- expose only redacted credential metadata and company-scope writes to the
  tenantless `SUPER_ADMIN`; tenant principals cannot read or mutate provider
  credential state;
- remove every GraphQL/raw REST response containing access tokens, client
  secrets, passwords, or WMTS token configuration.

Verification: configuration encryption/company-fallback/create-once-cutover
tests, NATS certificate-identity invariants, token cache/rotation tests,
permission matrix tests, response-shape scans, and legacy credential API
removal tests.

## FARM-HIGH-247

### Tenant erasure could lose fan-out progress or turn a dry run destructive

The environment cutover adds encrypted provider configuration and observation
records to the tenant-erasure roster. During end-to-end verification, the
platform orchestrator was found to keep the request mode only in the outbox
payload, to have no recovery path when a request delivery failed before every
target proof arrived, and to advance every fully proofed operation into tenant
schema deletion. A recovered or rolling-deploy dry run could therefore be
misclassified, while a lost request could remain `IN_PROGRESS` forever.

The closure must:

- persist `dryRun` as non-null operation state and fail deployment on
  conflicting or destructive historical evidence;
- reject proof modes that differ from the durable operation and reject every
  dry-run proof reporting a non-zero erased count;
- complete valid dry runs without a schema-deletion job, tenant `PURGED`
  transition, or final `TenantErased` event;
- guard schema-deletion jobs at the database boundary with an owner-pinned,
  security-definer trigger;
- recover stale incomplete requests through a bounded transactional claim,
  `FOR UPDATE SKIP LOCKED`, generation-specific outbox idempotency, and a
  heartbeat written only after enqueue succeeds;
- use one shared `DRY_RUN_COMPLETED` result state so targets never describe a
  non-destructive simulation as `PURGED`.

Verification: migration conflict/trigger/index tests, orchestrator request
recovery and mode-contamination tests, shared executor fresh/replay dry-run
tests, farm dry-run no-delete tests, and the tenant-erasure SSOT invariant.

## FARM-HIGH-248

### Verification contracts had drifted from fail-closed platform behavior

The final repository-wide gate exposed several stale test and drift contracts:
DDL-authority fixtures no longer modelled the production environment, the RLS
module fixture hid Nest provider visibility, the tenant subdomain test expected
a production fail-open path, the drift harness omitted its eleventh canonical
class, and table-count pins predated the environmental entities. In addition,
an initialized TypeORM data source without an accessible PostgreSQL pool could
silently skip the connection-level RLS guard.

The closure must:

- preserve the production DDL-authority boundary in unit and real-PostgreSQL
  fixtures, with per-test environment restoration;
- model Nest provider visibility accurately and keep RLS bootstrap fail closed
  when connection wrapping cannot be installed;
- align tenant-subdomain, logger, drift-class, compliance-attestation, and
  tenant-table gates with their current SSOT without weakening assertions;
- make migration lint distinguish PostgreSQL routine-level `SET search_path`
  configuration from pooled-session `SET`, while continuing to reject
  standalone and routine-body session mutations;
- keep Error stack precedence while excluding arbitrary enumerable Error
  properties from structured logs;
- update exact entity/table pins only after the new schema inventory is
  independently enumerated.

Verification: focused RLS, tenant-context, structured-logger, drift-harness,
compliance-attestation, tenant-schema, table-consciousness, and real-PostgreSQL
environment-sync suites; migration-lint positive/negative regression tests;
ESLint, forbidden-cast scans, and `git diff --check`.

## FARM-HIGH-249

### Cross-tenant watchdog silently swallowed an invalid PostgreSQL probe

The repository-wide real-PostgreSQL gate showed that `CrossTenantProbe` used
`SELECT DISTINCT ... ORDER BY RANDOM()`. PostgreSQL rejects that statement
because a `DISTINCT` query may order only by selected expressions. The probe's
provider-error boundary then converted that and other catalog/query failures
into an empty result, so a deployed watchdog could report no cross-tenant
violations without examining a single tenant-owned table.

The closure must:

- replace the invalid random ordering with deterministic ordering by the
  selected table and tenant-column identifiers;
- fail closed on tenant-directory, catalog, row-query, identifier, and
  physical-schema mapping errors, including retained non-active tenants;
- mark incomplete scanner coverage critical and never emit a clean
  attestation when `scannerErrors` is non-empty;
- provision isolated, canonical tenant/auth fixtures with distinct schema
  identities and prove that a foreign tenant row produces a CRITICAL finding;
- remove integration-test skips, swallowed setup failures, and test-only fake
  scanners that could pass without exercising the production watchdog;
- align schema-integrity integration coverage with db-migrate-owned DDL while
  proving runtime provisioning remains fail closed and read only.

Verification: the two backend-common real-PostgreSQL integration suites pass
14/14 tests together, the hardened watchdog suite passes 13/13 tests in a
fresh isolated PostgreSQL instance, and focused ESLint, Prettier, and
`git diff --check` pass.

## FARM-HIGH-250

### Farm intelligence discarded provenance and invented missing weather values

The farm MCP adapter still projected the retired weather shape after the
canonical environment cutover. Its GraphQL operation omitted provider,
product, semantic, quality, station, depth, resolution, and location-revision
fields; history flattened away metric-level evidence. The risk helper also
coerced an absent temperature to zero, which could generate a false extreme
cold alert when the provider had supplied no usable temperature at all.

The Sentinel scene path had the same discarded-provenance failure class.
CDSE calculated the site-AOI relationship, a versioned coverage method, and
the AOI sample count, but ingestion persisted only the percentage and a broad
quality label. A tenant therefore could not distinguish exact full coverage,
partial or unresolved coverage, out-of-coverage, and a historical row for
which the method was never recorded.

The closure must:

- query and preserve the full canonical provenance and quality projection for
  every current and historical metric;
- derive CURRENT, STALE, and UNAVAILABLE states and populate convenience fields
  only from CURRENT values;
- retain every historical metric with its own valid time rather than assigning
  one observation-level timestamp to heterogeneous data;
- expose one typed weather-risk adapter that excludes stale/unavailable data,
  never invents a missing temperature, and derives reliability from the exact
  metrics used by the risk evaluation.
- carry Sentinel `coverageStatus`, versioned `coverageMethod`, and
  `coverageSampleCount` without loss from the CDSE candidate through the
  append-only tenant store, GraphQL contract, generated client types, and farm
  panel;
- retain raw scene identity independently from immutable, method-versioned
  coverage assessments so legacy, V3, and later algorithms can coexist without
  mutating or duplicating the acquisition row;
- mark pre-contract scene rows explicitly as `UNKNOWN` / `LEGACY_UNKNOWN`
  instead of reconstructing scientific provenance, while retaining expand
  compatibility for old replicas during a rolling deployment;
- retain coverage-derived quality beside each method-versioned assessment and
  expose quality only from the selected assessment;
- accept a same-method replay only after persisted status, percentage, sample
  count, and quality match exactly; reject divergent same-method assessments
  and roll back the complete provider transaction;
- verify collection, provider, product, dataset, acquisition time, and
  canonicalized cloud cover before accepting a raw-scene identity replay;
  preserve `fetchedAt` as first-seen metadata and raw coverage/quality only as
  rolling legacy projections;
- create legacy assessments through a schema-bound, deferred constraint
  trigger only when the committing transaction has no versioned assessment,
  and arm FORCE RLS plus runtime DML authority in the migration transaction;
- enforce the exact FULL, PARTIAL, and OUT_OF_COVERAGE percentage/sample
  invariants at both the application and PostgreSQL boundaries, and make the
  tenant panel prefer full-AOI scenes while visibly explaining partial,
  unresolved, and legacy coverage.

Verification: the full farm MCP suite passes 9 files and 127 tests; project and
direct ESLint, type-check, build, Prettier, forbidden-pattern, and diff checks
pass. The Sentinel extension adds a forward migration contract plus focused
provider, ingestion, store, read, binary-render, and tenant-panel regression
coverage; farm application/spec TypeScript checks, 105 focused backend tests,
and 11 focused tenant-panel tests pass. A real-PostgreSQL rolling matrix proves
pre-migration backfill, a FORCE-RLS old-replica insert before post-migration
hardening, V3-only new-scene commits, idempotent migration replay without false
legacy rows, legacy→V3 coexistence, numeric canonicalization, exact assessment
replay, divergent raw/assessment rollback, and deadlock-safe forward-only
rollback refusal.

## FARM-HIGH-251

### Query placeholders crossed tenant and session boundaries

Tenant-prefixed, session-epoch query keys isolated cache entries, but the
shared tenant query hook still delegated to TanStack Query's unconditional
`keepPreviousData` placeholder. An observer survives a key change, so the farm
environment page could briefly render the previous tenant's site identity,
coordinates, monitoring radius, and location revision while the next tenant
loaded. A direct tenant-admin audit-log query repeated the same pattern for
audit rows and CSV export and did not gate its request on an authenticated
tenant session.

The closure must:

- extract tenant and session-epoch ownership from canonical query keys and fail
  closed for anonymous, malformed, epoch-less, tenant-changed, or
  session-changed keys;
- retain placeholder data only for domain/filter/page changes inside the same
  authenticated tenant-session generation;
- route the audit-log query through the shared tenant query hook and keep its
  refresh operation on the canonical epoch-less invalidation prefix;
- ensure logout and unresolved auth never dispatch the tenant audit request or
  expose retained rows to rendering or CSV export;
- keep federation-free test mocks faithful to the same boundary-aware
  placeholder contract.

Verification: shared-hook and key-boundary tests cover same-session navigation,
tenant switches, logout, malformed keys, and epoch-only session changes;
tenant-admin hook tests cover request gating and retained audit-row isolation;
focused frontend test, lint, type-check, Prettier, and diff gates pass.

## FARM-HIGH-252

### Site monitoring geometry could drift without a revisioned contract

Farm sites previously stored coordinates as general metadata. Environmental
jobs need a reproducible marine point and area, while Norwegian monitoring is
valid only for sea-cage sites with bounded geometry. Updating a site could
therefore move provider sampling without invalidating observations selected
under the old location.

The closure must:

- validate sea-cage monitoring points and radii in one backend-owned helper;
- increment a location revision only when the effective monitoring geometry
  changes and preserve it on unrelated edits;
- bind sync state, weather/marine rows, scene provenance, and imagery reads to
  that revision;
- expose the same validation constraints in the site form without making the
  browser an authority.

Verification: geometry, create/update handler, revision race, site form, and
PostgreSQL constraint tests cover valid boundaries, invalid land-style sites,
unchanged edits, and moved locations.

## FARM-HIGH-253

### Environment ingestion accepted ambiguous provider values and partial writes

Provider responses contain mixed valid times, units, depths, grids, nulls, and
quality flags. Treating a response as one weather object could combine values
that were not observed together or commit a subset while reporting the source
run successful.

The closure must:

- normalize every metric through a typed provider result with explicit
  semantic, unit, source time, issue time, quality, and provenance;
- reject non-finite or contract-incompatible values before persistence;
- write each accepted provider projection and its sync outcome atomically;
- preserve unavailable metrics as explicit absence rather than zero or a
  fabricated observation.

Verification: provider fixtures, normalization tables, atomic-store tests, and
failure-injection tests prove that malformed and partial responses cannot
become successful monitoring rows.

## FARM-HIGH-254

### Scene rendering was not bound to the persisted acquisition owner tuple

Selecting a scene by a broad date window and then rendering another provider
match breaks provenance: the image shown to a tenant may not be the acquisition
whose time, cloud cover, product, and location revision were stored.

The closure must:

- persist the provider collection and exact scene identifier selected by the
  catalog query;
- require tenant, site, location revision, catalog layer, collection, scene ID,
  and acquisition time to match before rendering;
- render only the admitted fixed-size site area and reject stale or cross-site
  tuples before contacting CDSE;
- return bounded binary responses with truthful acquisition metadata.

Verification: exact-scene, owner-tuple, stale-revision, cross-tenant,
content-type, and response-size tests assert both rejection and zero upstream
calls for invalid requests.

## FARM-HIGH-255

### Environmental GraphQL and binary reads lacked amplification limits

History, forecast, scene, and image operations are substantially more expensive
than ordinary farm reads. Alias repetition, deep fragments, broad cursors, and
parallel renders could multiply database and provider work without crossing a
generic request-count threshold.

The closure must:

- enforce shared fragment-aware GraphQL depth, top-level field, repetition,
  sensitive-mutation, and environment-field limits at gateway and subgraph;
- require bounded date windows, row limits, and deterministic cursors;
- apply tenant-aware rate limits to environment queries and binary rendering;
- keep the limits in shared contracts so the gateway and farm service cannot
  drift.

Verification: alias/fragment adversarial tests, direct-subgraph tests, cursor
contracts, and environment endpoint rate-limit invariants pass.

## FARM-HIGH-256

### Provider egress and payload handling were not fail-closed

Remote URLs, redirects, compression, content types, and response sizes are
security boundaries for a server-side satellite service. A configurable URL or
unbounded decode would turn credentialed provider access into SSRF or memory
pressure.

The closure must:

- use fixed allowlisted HTTPS origins and product identifiers for MET Norway,
  Frost, CMEMS, and CDSE;
- disable unexpected redirects and bind connect/read deadlines to every call;
- cap JSON and binary bytes before parsing or buffering;
- validate provider status, media type, schema, and requested collection before
  any result reaches persistence or the tenant response.

Verification: URL, redirect, timeout, decompression, oversized body, media-type,
and schema-adversarial provider tests pass with no fallback data.

## FARM-HIGH-257

### Environment scheduler state could lie about partial metric outcomes

A site run can succeed for weather while marine or satellite acquisition fails.
One run-level status hid this distinction, caused successful metrics to be
retried, and let a failed metric appear current because another provider had
advanced the site timestamp.

The closure must:

- persist per-provider and per-metric outcomes with attempt, completion,
  freshness, and error class;
- keep the distributed lease and retry cursor independent from observation
  valid time;
- advance success state only for the exact metric set committed;
- derive panel availability and alarms from metric-specific evidence.

Verification: mixed-outcome, retry, lease takeover, idempotency, and freshness
tests prove partial success is visible and cannot overwrite failed state.

## FARM-HIGH-258

### Deployment and monitoring contracts did not prove the environmental runtime

Application code alone did not ensure that production supplied the encryption
key, provider identity, feature gate, NATS certificate, migrations, or alert
rules needed by the monitoring pipeline. Configuration drift could leave a
tenant panel deployed but permanently unavailable.

The closure must:

- declare identical required environment contracts across Compose,
  Helm/Kustomize, staging, production, and deployment scripts;
- keep NATS cert identity and generated ACLs sourced from `services.yaml`;
- install environmental backlog, provider failure, stale metric, and scene
  acquisition alerts with a runbook;
- make deployment invariants reject missing migrations, secrets, mounts,
  service identities, or feature-gate wiring.

Verification: deployment SSoT, NATS, secret-literal, Helm rendering, alert-rule,
and runbook-link invariants pass.

## FARM-HIGH-259

### Tenant erasure topology omitted newly owned environmental records

Adding observation, scene, versioned scene-coverage assessment, sync, and
credential-cutover entities created new tenant-owned leaves. A hand-maintained
deletion order or incomplete foreign-key inventory could erase a parent first,
leave records behind, or falsely attest that the farm target was empty.

The closure must:

- derive the live environment entity and foreign-key topology from database
  ownership rather than a second deletion list;
- include every environment table in dry-run counts, destructive erasure, and
  proof totals;
- fail before deletion on unknown tenant-bearing tables, unmanaged inbound
  dependencies, or topology cycles;
- prove the entity relation metadata and physical tenant column agree with the
  migration DDL, and require affected rows to equal the pre-delete inventory;
- register every topology-owned environmental entity in the runtime TypeORM
  module so schema metadata and read queries cannot silently diverge;
- pseudonymise UUID actor columns with one deterministic, domain-separated
  SHA-256 UUID expression instead of writing an invalid text hash into UUID
  columns.

Verification: entity/FK contract tests and real-PostgreSQL erasure tests cover
the complete live topology, including coverage-assessment → raw-scene → site
child-first deletion, dry run, destructive execution, UUID-compatible audit
pseudonymisation, matched/affected parity, and zero-residue proof.

## FARM-HIGH-260

### Sentinel credential erasure could be authorized by mutable tenant data

The legacy credential cutover and deletion trigger originally derived authority
from rows being erased. A tenant-controlled or partially deleted row could then
change which principal was permitted to remove reusable provider credentials.

The closure must:

- authorize erasure through an owner-pinned security-definer function and the
  canonical operation proof, not mutable tenant payload;
- pin `search_path`, function owner, trigger definition, and allowed operation
  state in migration contracts;
- reject direct deletion and mismatched tenant/operation pairs;
- include a real-PostgreSQL test that exercises the production trigger.

Verification: migration and PostgreSQL authorization tests prove direct,
cross-tenant, stale-operation, and search-path attacks fail closed.

## FARM-HIGH-261

### Cross-tenant environment fan-out lacked canonical retained-tenant identity

Schedulers and secret scrubbers enumerated physical schemas even though schema
names are not tenant authority and inactive tenants can retain data. This could
process an unregistered schema, skip a suspended tenant, or log raw tenant
identifiers while handling an error.

The closure must:

- enumerate active or retained tenant/schema pairs from the committed
  db-migrate ledger according to the job's lifecycle purpose;
- run bounded, rotated, transaction-local work with statement and wall-clock
  limits;
- return per-target outcomes while logging only identifier-free action and
  outcome data;
- fail closed on missing mapping proof instead of inferring ownership from a
  schema name.

Verification: fan-out, retained-lifecycle, timeout, rotation, ledger-mapping,
and structured-log tests pass.

## FARM-HIGH-262

### Tenant-scoped logs and admission errors exposed raw authority identifiers

Farm resolvers and cross-tenant helpers interpolated tenant, user, site, system,
schema, provider, and operation values into logs. Those values are unnecessary
for normal telemetry and can leak authority data or inject untrusted text into
an operator channel.

The closure must:

- emit stable action/outcome records without raw tenant, actor, object, schema,
  token, provider credential, or GraphQL document values;
- retain correlation through the platform trace/audit channels rather than
  duplicating identifiers in application logs;
- keep detailed errors in bounded returned results or audit evidence, not
  concatenated logger messages.

Verification: resolver, fan-out, GraphQL admission, structured logger, and
forbidden-log scans pass.

## FARM-HIGH-263

### Tenant administrators had no usable site-access control surface

Assigned-site authorization protects farm reads only if a tenant administrator
can inspect and change assignments. The platform had mutation fragments but no
tenant-scoped current-assignment query, no farm-owned site authority check, and
no connected tenant panel workflow.

The closure must:

- expose active farm sites from farm authority and current user assignments
  from auth through typed, tenant-scoped contracts;
- return the farm-owned active-site access catalog from one authoritative,
  tenant-pinned database snapshot in stable Site-ID order, with a hard result
  cap that fails closed instead of truncating; client-side offset page walking
  is forbidden because equal-count delete/insert churn can silently omit rows;
- validate every assigned site against the authoritative farm tenant before
  writing auth state;
- provide an accessible tenant-admin modal with explicit loading, error,
  empty, assign, and unassign states;
- invalidate tenant/session-owned query keys after a successful mutation and
  never retain another tenant's site list or assignments.

Verification: farm responder, single-snapshot catalog/cap handler, catalog-churn
regression, auth validator/service/resolver, DTO, tenant UI, query-key boundary,
and integration tests pass.

## FARM-HIGH-264

### Site assignments and access-token claims could disagree across time

An assignment may be revoked or expire after a token is minted. Process-local
claim caches and inconsistent effective-date predicates allowed a refreshed
token or tenant panel to retain a site that auth no longer considered active.

The closure must:

- define effective assignments once, including tenant, active flag, start, and
  expiry semantics;
- use the same canonical reader for assignment queries and JWT claim minting;
- lock the authoritative active user and assignments during token issuance;
- invalidate user tokens durably on assignment changes while preserving the
  earliest assignment expiry in the claim boundary.

Verification: assignment reader, token claim, expiry boundary, concurrent
mutation, and assign/unassign invalidation tests pass.

## FARM-HIGH-265

### Token revocation was optional and gateway enforcement could fail open

Auth and gateway accepted missing Redis-backed revocation providers and could
fall back to process memory in production. A revoked JTI or user-wide epoch was
therefore pod-local, and a request racing middleware and guard checks could
still be accepted.

The closure must:

- require the distributed Redis store in production and expose typed,
  authorization-specific Redis operations;
- compose JTI and user-epoch checks into one fail-closed validity decision in
  auth guard, gateway middleware, and gateway guard;
- enforce the strict `issued-at > invalidation-epoch` boundary;
- make Redis unavailability reject authorization rather than activate a local
  fallback.

Verification: shared security, Redis, auth guard, gateway middleware/guard,
same-second, multi-pod, and outage tests pass.

## FARM-HIGH-266

### User-site assignment migration was unsafe during rolling deployment

Replacing the legacy `(userId, siteId)` uniqueness in one deployment breaks old
pods whose upsert conflict target still names it. A second
`(userId, siteId, tenantId)` uniqueness constraint initially appeared to add
isolation, but `User.id` is already a global primary key, making that constraint
an overlapping duplicate. Tenant ownership instead has to be proven by the
user relationship itself.

The closure must:

- retain the named legacy uniqueness contract as the sole assignment identity;
- add the `(User.id, User.tenantId)` identity and composite
  `(assignment.userId, assignment.tenantId)` ownership foreign key without
  weakening existing rows or adding an overlapping uniqueness constraint;
- fail migration on duplicates or ownership drift instead of deleting data;
- keep entity metadata and source-owned migration DDL in parity and assert that
  no redundant tenant-suffixed uniqueness exists.

Verification: migration up/down, ownership preflight, old-pod conflict-target,
non-duplicate entity metadata, and tenant-isolation tests pass.

## FARM-HIGH-267

### Authentication invalidation was stale, non-durable, and refresh reuse was scan-based

JWT authorization claims were cached per process, invalidations were immediate
Redis side effects without a durable recovery record, and hashed refresh-token
reuse detection scanned a user's token history. Same-second issuance and a
replica crash could preserve access after role, password, tenant, or site
authority was reduced.

The closure must:

- read role, module, resource, user lifecycle, and effective site authority on
  every token mint without process-local authorization caches;
- persist JTI or user-epoch invalidation intent in the auth outbox in the same
  transaction as the authority change, then apply Redis after commit;
- enforce a shared access-token lifetime ceiling and wait for a real clock
  boundary before minting after a same-second invalidation;
- store an indexed refresh token ID, retain a bounded legacy compatibility
  path, and contain reuse once through a compare-and-set marker and deterministic
  idempotency key;
- keep session-manager calls as optional defense-in-depth until a token/refresh
  family session identifier is an enforced authority, rather than claiming a
  disconnected session store provides revocation.

Verification: role/site/password/logout/tenant status invalidation, refresh V2
and legacy parsing, concurrent reuse, rollback/post-commit recovery, lifetime,
same-second issuance, and replica restart tests pass.

## FARM-HIGH-268

### Security recovery events could duplicate or dead-letter permanently

System-routed auth invalidations use a null tenant column, so the ordinary
`(tenantId, idempotencyKey)` index does not deduplicate them. The generic outbox
also dead-lettered every event after a finite retry budget, which can permanently
lose the recovery path for a committed access reduction.

The closure must:

- default-deny system routing and security-recovery delivery capabilities at
  `OutboxModule.forFeature`;
- require a publisher-stamped routing attestation, null tenant column, reserved
  system payload tenant, and auth-owned partial idempotency index;
- enqueue idempotent rows with conflict-safe inserts;
- strip storage metadata before NATS publication and keep valid security
  recovery rows retryable until success while permanently dead-lettering
  malformed routing metadata.

Verification: outbox capability, publisher, tenant-integrity, worker retry,
system idempotency migration, and auth producer tests pass.

## FARM-HIGH-269

### The raw farm authority RPC lacked a single reliable NATS lifecycle

Auth must validate a site against farm ownership, but a standalone request
client and duplicate event-bus providers created separate NATS lifecycles.
Permissions also relied on a caller-forgeable identity header instead of the
certificate identity enforced by the broker.

The closure must:

- expose one typed farm site-validation request/reply contract and a farm-owned
  responder;
- reuse the singleton `NatsEventBus` provider for `EVENT_BUS` and propagate
  durable subscription options through the shared interface;
- grant auth and farm only the exact request, reply inbox, event, and JetStream
  control subjects required by their certificate identities;
- never derive authorization from message headers or payload service names;
- generate runtime NATS configuration from `services.yaml` and pin provider
  identity and ACL parity with invariants.

Verification: request/reply contract, responder, auth validator, event-bus
provider identity, durable subscription, generated ACL, and no-forged-identity
tests pass.

## FARM-HIGH-270

### Durable sync outcomes were outside two runtime schema registries

The durable `environment_metric_sync_outcomes` table had a migration, entity,
writer, and reader, but the recovered final patch omitted it from the farm
tenant-fanout SSoT and from `WeatherModule`'s TypeORM feature registration.
Existing and newly provisioned tenant schemas could therefore lack the table,
while layer-availability reads could fail with missing entity metadata.

The closure must:

- register the table in the farm `MODULE_SCHEMAS.tables` inventory and advance
  the independently pinned farm and total tenant-table counts;
- register `EnvironmentMetricSyncOutcome` in `WeatherModule` so runtime
  metadata is loaded before the availability query executes;
- keep a contract assertion tying the module registration to the retained
  environmental persistence surface;
- pass tenant-fanout entity parity and the full tenant-isolation inventory
  gates.

Verification: the focused weather contract, backend-common tenant-isolation,
tenant-fanout parity, farm-service, and full invariant suites pass.

## FARM-HIGH-271

### Final audit retained tenant identifiers and over-wide test seams

Two completion logs interpolated full or stable tenant identifiers into their
message strings. The credential and imagery unit tests also required unsafe
equivalent double assertions because three constructors exposed whole
framework classes despite consuming only a small method boundary.

The closure must:

- use fixed log messages with non-identifying structured outcome metadata;
- remove tenant UUIDs and stable tenant prefixes from the two completion logs;
- type the injected dependencies to the exact methods each boundary consumes,
  while retaining the real Nest injection tokens;
- construct structural fakes directly and remove every equivalent double
  assertion from the affected tests.

Verification: the config credential, farm erasure/imagery, and shared
credential-client suites pass; focused ESLint, Prettier, forbidden-cast, and
diff checks pass.

## FARM-HIGH-272

### The protected legacy credential row could block tenant erasure

The Sentinel cutover migration protects `sentinel_hub_settings` with a
database trigger that authorizes deletion only for a transaction carrying the
farm erasure GUCs and its operation-specific two-key advisory lock. The custom
farm erasure service acquired only its general idempotency lock. A tenant with
a retained legacy row would therefore make the destructive cascade fail and
roll back instead of producing an erasure proof.

The closure must:

- acquire the exact database-owned Sentinel erasure advisory lock inside the
  tenant-pinned transaction;
- set the target-service, tenant, and operation GUCs with transaction-local
  scope before any destructive table pass;
- perform no special deletion authorization during a dry run;
- retain the trigger's fail-closed behavior for every non-erasure DELETE.

Verification: farm erasure tests prove the exact two-key lock/GUC contract,
successful guarded-row deletion, dry-run non-authorization, rollback behavior,
and the migration trigger contract.

## FARM-HIGH-273

### Erasure ordering trusted incomplete ORM foreign-key metadata

The tenant-erasure cascade discovered tables through TypeORM and ordered them
from `EntityMetadata.foreignKeys`. Environmental migrations owned five
composite foreign keys that the corresponding entities did not describe, and
the previous inbound-count sort was not a complete topological algorithm. A
metadata drift or multi-level dependency could therefore select a parent
before its child and turn a valid erasure into a rolled-back FK failure.

The closure must:

- read the enforced child-to-parent graph from `pg_catalog.pg_constraint`
  inside the already tenant-pinned transaction;
- perform a deterministic child-before-parent Kahn ordering and fail closed
  before the first DELETE if the tenant schema contains a cycle;
- ignore only self/external edges and reject disappearing runtime metadata;
- describe the migration-owned Site and sync-state composite foreign keys in
  TypeORM so drift validation and runtime metadata agree with PostgreSQL;
- prove the retained Sentinel trigger can be reset between real-PostgreSQL
  cases without invoking its protected DELETE path.

Verification: unit coverage pins live-schema ordering, cycle rollback and
zero-delete behavior; entity metadata tests pin every composite join; the real
PostgreSQL Sentinel authorization suite passes all unauthorized, dry-run and
complete-proof cases.

## FARM-HIGH-274

### Direct environment reads had an inert rate limiter and unbounded cursor decode

Farm imported the shared throttler module but never registered its guard, so a
caller reaching the subgraph directly could repeatedly execute the expensive
environment history/catalog/scene queries without enforcement. The scene
cursor also reached `Buffer.from` with no transport-independent size or
alphabet bound; GraphQL DTO validation alone was not a safe service boundary.

The closure must:

- install the shared sliding-window guard as a global farm `APP_GUARD`;
- apply one explicit bounded bucket to every environment read resolver;
- cap the GraphQL cursor at 256 characters and repeat the length/base64url
  alphabet check inside `EnvironmentReadService` before decoding or DB entry;
- retain the existing page-size, date-window, site-access and GraphQL
  operation-complexity limits as independent defenses.

Verification: resolver metadata and AppModule provider contracts pin active
throttling, while the read-service regression proves an oversized cursor is
rejected before the tenant database boundary.

## FARM-HIGH-275

### Revoked site access could survive in an already-issued token

Removing a user's site assignment only deactivated the database row; the
removed `assignedSiteIds` claim remained usable until token expiry. The gateway
made this worse: middleware correctly rejected a user-level invalidation, but
left no authenticated user, after which `AuthGuard` re-verified the same bearer
and checked only its clean JTI. The guard thereby resurrected permission,
password and site-membership revocations. Second-granularity timestamps also
treated tokens minted in the invalidation second as valid.

The closure must:

- revoke the target user's canonical token family only after the site
  unassignment write succeeds, and fail the operation if revocation cannot be
  made durable;
- carry an explicit middleware-to-guard revoked outcome so absence of a user
  cannot be reinterpreted as an unauthenticated verification path;
- enforce the composite JTI/user/issued-at contract on both the middleware
  fast path and the guard's full-verification path, failing closed on store
  errors or malformed claims;
- use one shared inclusive invalidation boundary so tokens issued at or before
  the revocation second are rejected by Redis and in-memory readers alike.

Verification: composed middleware/guard tests prove a clean JTI cannot revive
a user-revoked token; full, fast and store-failure paths return 401; tenant
admin tests prove post-write revocation and no revocation after failed or
missing assignment writes; canonical Redis/fallback tests pin same-second
rejection.

## FARM-HIGH-276

### Scene images were owned by only the tenant/session pair

The blob hook associated its state with tenant and session generation, but not
with site, layer or scene. React renders once before passive-effect cleanup, so
a same-tenant selection change could display the previous blob or error under
the new scene caption for one commit.

The closure must:

- define image ownership as the full immutable tenant, session epoch, site,
  layer and scene request tuple;
- suppress stale image, loading and error state synchronously at render time
  whenever any tuple member changes or the request becomes incomplete;
- preserve request abort and object-URL revocation on every boundary change.

Verification: hook rerender tests capture the first render across layer,
scene, valid/incomplete site, tenant and session switches, including stale
errors, pending requests, transport tuples and object-URL cleanup.

## FARM-HIGH-277

### Active farm documentation still advertised retired browser surfaces

Architecture, illustrator and Sentinel layer documents continued to describe
MapView tiles, point/AOI browser analysis, tenant Sentinel settings and a
legacy weather shape as active paths. Operators could follow those documents
and configure endpoints deliberately removed by the environment SSOT cutover;
the deployment runbook also omitted the durable metric-outcome migration and
its sync-accounting postconditions.

The closure must:

- make the tenant environment panel, backend layer catalog, persisted
  provenance/scenes/outcomes and exact-scene render route the active diagrams;
- identify config-service as the provider-credential authority and tombstone
  every retired Map/tile/point/AOI/settings route;
- add migration `1807200000000` and verify the outcome table plus all sync
  counters in the production rollout postconditions.

Verification: focused documentation formatting and diff checks pass, every
referenced canonical source exists, and the runbook's SQL checks the retained
tenant schemas against the complete migration-owned persistence contract.

## FARM-HIGH-278

### A production-looking administrator password was embedded in documentation

The investor-pitch document contained a concrete `SUPER_ADMIN_PASSWORD` value.
Although the line predated this change, reformatting the document would have
carried the credential-shaped literal into the new patch and kept teaching
operators to place a privileged password in source-controlled documentation.

The closure must:

- replace the literal with an unmistakable secret-manager placeholder;
- keep real administrator credentials out of examples, commits and generated
  deployment configuration;
- treat the historical value as exposed and rotate it outside this repository
  if it was ever used by a live environment.

Verification: the added-diff credential scan reports no concrete administrator
password, and the example now points operators to a non-secret placeholder.

## FARM-HIGH-279

### Exact-scene rendering duplicated the canonical monitoring-area algorithm

Scheduled CDSE discovery used `createSiteMonitoringCircle`, while the render
service privately reimplemented the same spherical circle, bounds and
longitude normalization. Provider discovery and the image shown to a tenant
could therefore drift to different AOIs after either implementation changed.

The closure must:

- use the site-domain monitoring geometry helper for both discovery and
  exact-scene rendering;
- remove the render-local radius, trigonometry and normalization duplicate;
- preserve an explicit tenant-provided polygon as authoritative;
- retain the complete tenant, site, monitoring-revision and persisted-scene
  tuple at the render boundary.

Verification: focused render and ingestion tests prove byte-equivalent
canonical fallback geometry, explicit polygon preservation and complete scene
ownership; farm app/spec type checks, lint and formatting pass.

## FARM-HIGH-280

### Tenant administrators could not manage normal users' site visibility

Auth exposed site assign/unassign mutations, but neither an authoritative read
of a target user's active assignments nor a tenant-admin UI flow. A normal
module user could therefore be denied every farm site with no supported way
for its tenant administrator to grant access. Inferring state only from local
mutation results would also lie after a reload.

The closure must:

- add a tenant-admin-or-higher query that validates the target user's tenant
  membership and returns only active assigned site identifiers;
- intersect that authority with the tenant-bound active farm-site catalog;
- expose assign/unassign controls only for the intended module-user and
  administrator roles, without broadening backend permissions;
- use tenant/session-scoped query keys and invalidate/refetch authoritative
  assignment state after successful, non-optimistic mutations;
- surface loading, confirmation and failure states without claiming a failed
  assignment succeeded.

Verification: backend resolver/service tests pin tenant membership, role gates
and active-only reads; frontend hook/component tests pin reload-authoritative
state, assign/unassign success, failure behavior, cache isolation and UI
permission gates.

## FARM-HIGH-281

### Auth accepted unverified farm site identifiers as access assignments

The site-assignment mutation verified the target user but treated any UUID as
a farm site. The tenant-admin active-site list was only a browser UX filter, so
a direct GraphQL caller could persist a missing, inactive, deleted or
cross-tenant site identifier into the JWT membership source of truth.

The closure must:

- define one strict shared request/reply contract for farm site assignability;
- have farm-service validate tenant and site UUIDs, pin the tenant schema, and
  accept only an active, non-deleted Site belonging to that tenant;
- call that authority from auth-service over the existing mTLS NATS connection
  before every assignment write, failing closed on timeout, transport, remote,
  malformed-response or non-assignable outcomes;
- grant only the auth-service certificate permission to publish the exact
  validation subject and only farm-service permission to subscribe;
- distinguish authority outages from an ordinary non-assignable result for
  operations and support, without exposing cross-tenant site metadata.

Verification: responder/client/service tests prove valid assignment, uniform
non-assignability, malformed and unavailable authority behavior, tenant pinning
and zero writes on every failure; NATS ACL generation and invariants pin the
single caller/responder subject pair.

## FARM-HIGH-282

### Inactive or deleted assigned sites became invisible to administrators

The UI rendered only the active farm-site catalog. When an assigned site later
became inactive or deleted, its auth assignment disappeared from the dialog
even though the effective assignment row—and therefore its identifier in a
new token—remained. The administrator had no supported way to revoke it.

The closure must:

- render the union of authoritative active sites and authoritative active
  assignment identifiers;
- label assignment identifiers absent from the active catalog as unavailable,
  expose no unverified site metadata, and permit only removal;
- never offer assignment for an unavailable identifier;
- preserve tenant/session ownership and authoritative post-write reload rules
  for both normal and stale rows.

Verification: component tests prove stale identifiers are visible and
removable, cannot be newly assigned, reveal only the identifier, and disappear
only after auth confirms the removal.

## FARM-HIGH-283

### Site administration advertised SUPER_ADMIN support but rejected the actor

The resolver and browser gate admitted SUPER_ADMIN, while the service derived
its tenant only from the actor's database row. A real platform administrator
has no stored tenant and was rejected even after the gateway established an
audited effective tenant through the act-as boundary.

The closure must:

- pass the trusted request tenant into site-assignment reads and writes;
- require a tenant administrator's stored tenant to match that effective
  tenant;
- allow SUPER_ADMIN only when the existing tenant guard has established an
  effective act-as tenant, never from a client payload;
- scope target-user, assignment and farm-authority operations to the same
  effective tenant.

Verification: resolver/service tests prove tenant-admin success, cross-tenant
rejection, SUPER_ADMIN act-as success and missing-effective-tenant rejection.

## FARM-HIGH-284

### Site-assignment tenant integrity was application-only and token reads were under-scoped

`auth.user_site_assignments` referenced only `users.id`; its denormalized
tenant could disagree with the user's tenant. Token minting then loaded rows by
user and active flag without also requiring the JWT user's tenant. Corrupt or
manually inserted cross-tenant metadata could therefore enter a membership
claim even though normal mutation paths attempted to scope writes.

The closure must:

- add database-owned composite user-and-tenant referential integrity, failing
  the migration rather than silently rewriting mismatched rows;
- describe that composite relation in TypeORM metadata;
- include tenantId in assignment reactivation, read and token-mint queries;
- emit no site claim for a user without a valid tenant context.

Verification: migration and entity-metadata tests pin the composite key and
cascade action; token/service tests prove mismatched tenant rows cannot enter
claims or assignment operations.

## FARM-HIGH-285

### Site-membership claims could outlive or reappear after revocation

The assignment list used by tenant administration and the one used during JWT
minting implemented expiry independently. A time-limited assignment could
therefore outlive its row in an access token. Membership writes and token reads
also had no shared serialization fence, while the user invalidation marker was
a plain Redis `SET`: concurrent writers could complete out of order and move
the epoch backwards. Finally, the marker expired after 24 hours even though an
operator could configure a longer JWT, allowing a previously rejected token to
become valid again after the marker disappeared.

The closure must:

- use one tenant-scoped effective-assignment reader and one exact `expiresAt >
at` predicate for administration, reactivation and JWT minting;
- fix JWT `iat` before the locked membership read and cap token expiry to the
  earliest time-limited assignment;
- serialize token reads and membership writes on the same user/assignment rows,
  and persist the membership audit in the authorization transaction;
- revoke the affected token family while the write fence is held, with an
  atomic max-only Redis epoch that fails closed on malformed state and cannot
  regress when writers finish out of order;
- keep auth as the sole writer and durable owner of both per-token JTI markers
  and user-family epochs in the existing authorization Redis namespace;
  gateway is a read-only consumer whose typed composite lookup must resolve the
  exact same physical auth keys without hand-built raw keys or a marker
  migration;
- collapse the optional legacy blacklist abstraction that stored a conflicting
  JSON user marker into the canonical per-JTI plus monotonic family primitives;
  logout, password changes, reset and refresh-token reuse cannot become
  conditional no-ops because a provider is absent;
- commit refresh-family containment before returning the generic reuse-denied
  response; throwing that response inside the database transaction must not
  roll the security update back;
- require the distributed blacklist implementation and its injection on every
  production gateway authentication path; an in-memory fallback is admitted
  only in an explicit non-production runtime;
- derive the marker TTL and maximum accepted access-token lifetime from one
  24-hour constant, rejecting invalid or overlong `JWT_EXPIRES_IN` at startup;
- admit new site grants only for the role that consumes them and keep repeated
  effective grants as true no-op operations.

Verification: focused auth, gateway and backend-common tests pin the row-lock
ordering, expiry boundary, earliest-expiry token cap, atomic audit rollback,
max-only epoch behavior, malformed-marker denial, startup lifetime validation,
role eligibility and idempotent concurrency behavior. Redis prefix and gateway
boot-contract tests also prove auth and gateway address the same physical
user-family marker and production cannot select a process-local fallback.

## FARM-HIGH-286

### A site-access confirmation could cross tenant or target-user ownership

The browser isolated query caches by tenant session, but a confirmation dialog
did not own the complete mutation tuple. A tenant/session switch—or a same-
tenant switch from user A to user B—could leave the old confirmation visible
long enough to execute against current component props. Mutation completion
checks protected cache writes but did not prevent the stale API call itself.

The closure must:

- capture effective tenant, session epoch and exact target user when a
  confirmation opens;
- suppress the confirmation synchronously when any owner component changes,
  before an API call can be issued;
- execute mutations with the captured target rather than mutable current props;
- keep success, retry and authoritative-refetch feedback owned by the same
  tuple, never carrying it into another tenant or user.

Verification: component tests prove tenant A to tenant B and same-tenant user A
to user B switches remove the confirmation synchronously, issue zero stale API
calls and show no prior-owner success; normal assign, remove and authoritative
reload paths remain green.

## FARM-HIGH-287

### The raw farm authority RPC lacked a single reliable NATS lifecycle

The event-bus module constructed one `NatsEventBus` for the interface token and
another for the class token used by request/reply, contradicting the
certificate-is-identity one-connection contract. Raw responders also had no
queue group, farm could treat NATS as optional while registering a synchronous
authorization responder, and the ACL invariant scanned only Nest transport
decorators and client `send`/`emit`. A scaled or reconnecting deployment could
therefore duplicate work, fail startup inconsistently, or ship a subject that
the broker silently denied.

The closure must:

- alias the interface token to the single `NatsEventBus` class instance instead
  of constructing a second connection;
- add an explicit queue-group option to the shared request/reply responder and
  bind all farm replicas to the same group;
- make NATS a required farm-service startup dependency for the synchronous
  assignment authority;
- teach the invariant to discover raw `requestTyped` and `respond` subjects and
  load their shared contract constants;
- grant only auth publish and farm subscribe for the exact authority subject,
  regenerating the broker configuration from the NATS registry.

Verification: real Nest-container identity tests prove both DI tokens share one
instance; responder tests pin the queue; farm startup configuration is
fail-closed; generated-config and NATS invariants prove exact caller/responder
coverage and reject every extra principal.
