# Farm Environmental Monitoring

This runbook activates the tenant site panel backed by canonical weather,
marine-model, and satellite-scene data. Tenants configure only their own
`SEA_CAGE` site location, monitoring radius, and optional AOI. Provider
identity, credentials, licensing, and operational approval remain company
responsibilities.

The rollout order is load-bearing:

1. migrations;
2. company CDSE secret in `config-service`;
3. one-shot legacy tenant credential cutover;
4. MET Norway identity and Frost client configuration;
5. rollout gate enablement.

Keep `FARM_ENVIRONMENT_MONITORING_ENABLED=false` through steps 1–4. Missing
configuration also resolves to disabled.

## Data contracts

- MET Locationforecast and Frost provide weather forecast/observation rows.
- CMEMS provides model/analysis values. It is not a farm sensor.
- CDSE provides exact Sentinel-2 scene metadata and imagery. Satellite
  chlorophyll/turbidity layers are dimensionless indicators, not laboratory
  concentrations or HAB determinations.
- Tenant and site identifiers never appear as Prometheus labels. Use
  authenticated traces and structured logs for per-tenant investigation.
- Browser clients never receive or configure provider credentials.

## Pre-flight

- Use farm-service, config-service, and `db-migrate` images from the same
  reviewed release.
- Confirm a current PostgreSQL backup and record the release SHA.
- Provision the dedicated `SENTINEL_HUB_ENCRYPTION_KEY` wherever farm-service
  runs. It must match the key that encrypted existing legacy rows.
- Provision `MET_NORWAY_APPLICATION_NAME`, `MET_NORWAY_CONTACT`, and, when
  Frost is required, `MET_NORWAY_FROST_CLIENT_ID`.
- Confirm config-service uses `CN=config_service`, farm-service uses
  `CN=farm_service`, and both service-identity keyrings are healthy. The
  droplet Compose dependency keeps farm-service stopped until config-service
  is healthy.
- Confirm Redis is healthy before config-service. Credential disclosure and
  mutation use Redis as the cross-replica nonce ledger and fail closed when it
  is unavailable.
- Do not place a credential bundle in a command line, Compose file, ticket,
  log, or this runbook.

## 1. Apply migrations

Run the authoritative one-shot migration container before restarting either
runtime service:

```bash
docker compose -f docker-compose.droplet.yml up \
  --abort-on-container-exit \
  --exit-code-from db-migrate \
  db-migrate
docker compose -f docker-compose.droplet.yml logs --tail=200 db-migrate
```

The farm migration manifest must include the site monitoring contract,
Sentinel credential cutover metadata, and environmental observation
foundation migrations. Do not enable runtime migration execution in
production.

Before continuing, verify that every tenant schema which can still retain data
(active, suspended, migrating, or pending deletion) has both a physical schema
and matching committed provisioner evidence:

```sql
SELECT schema_name, tenant_id, schema_exists, committed_proof
  FROM platform.list_retained_tenant_schema_mappings()
 ORDER BY schema_name;
```

Every returned row must have `schema_exists=true` and
`committed_proof=true`. Provider ingestion enumerates only active tenants;
credential scrubbing and 45-day retention deliberately continue across every
retained lifecycle state. The admin migration also enforces that each tenant
maps to the one derived `tenant_<uuid16>` schema and that no two tenants claim
the same schema name.

If any proof flag is false, keep
`FARM_ENVIRONMENT_MONITORING_ENABLED=false`. Repair the ledger only through an
approved `RECONCILE_EXISTING_SCHEMA` db-migrate job, then repeat this query.
Do not edit `admin.tenant_schemas` or `platform.tenant_schema_jobs` by hand,
guess the full tenant UUID from a truncated schema name, or enable an RLS
bypass.

## 2. Store the company CDSE credential

Authenticate to config-service as the tenantless platform `SUPER_ADMIN` and
use the `setConfiguration` mutation. Tenantless platform administration maps
to the system tenant automatically.

Use this metadata:

- service: `farm-service`
- key: `marine.cdse.credentials`
- environment: `ALL`
- secret flag: `true`
- value: the complete CDSE credential bundle, supplied only through protected
  GraphQL variables

The bundle contains the required client identifier and client secret, with an
optional instance identifier. Do not send those fields through farm-service,
tenant UI, URL parameters, or shell history.

Verify the configuration version and config-service audit event. Secret reads
must remain redacted on public GraphQL surfaces. Farm-service resolves an
existing tenant override first and the system-tenant company default second,
through the signed, allowlisted NATS credential boundary.

## 3. Execute the legacy tenant cutover

Keep the monitoring gate disabled, start config-service, then start
farm-service. `SentinelCredentialCutoverService` runs as a blocking application
bootstrap phase across every retained, ledger-verified tenant schema. The
service does not become ready while a configured legacy credential remains
unverified or duplicated. A failed phase refuses startup; the process
supervisor's normal restart policy retries the same frozen bundle.

For each configured legacy row it:

1. decrypts the complete bundle with `SENTINEL_HUB_ENCRYPTION_KEY`, stores its
   canonical SHA-256 digest, and freezes the legacy credential row inside a
   short tenant transaction;
2. closes that transaction, then writes one tenant override to config-service
   through the exact signed cutover operation;
3. opens a new tenant transaction, re-proves the same bundle digest, records
   config source/version provenance, and atomically clears all legacy
   ciphertext fields and marks the row unconfigured.

The config-service write is create-once and exact-value idempotent. A crash,
timeout, lost reply, config-service denial, or finalization failure therefore
leaves a durable pending row that is safe to retry without holding a database
transaction across NATS. Refusing readiness prevents the release from serving
while a second credential authority still exists; the runtime credential path
remains the centrally managed config-service authority.

Before enabling monitoring, verify:

- farm-service completed bootstrap and reports ready without a cutover refusal;
- config-service audit events exist for every migrated override;
- every cut-over row has `is_configured=false`;
- legacy client, secret, and instance columns are `NULL`;
- cutover timestamp, config version, and source tenant metadata are populated.

Keep the legacy encryption key provisioned until a reviewed contract-release
removes the legacy entity, transformer, and Compose mapping after this proof
has been retained.

## 4. Validate MET Norway configuration

`MET_NORWAY_APPLICATION_NAME` must identify the company application.
`MET_NORWAY_CONTACT` must be a monitored email address or HTTPS contact.
Frost ingestion also requires `MET_NORWAY_FROST_CLIENT_ID`.

The service refuses to call MET Norway with a placeholder identity. Missing or
invalid identity is persisted as `CONFIGURATION_ERROR`; no upstream request is
made. CMEMS public discovery/WMTS access does not require a tenant credential.

## 5. Enable and verify

Set `FARM_ENVIRONMENT_MONITORING_ENABLED=true` and restart farm-service.
Confirm:

```promql
farm_environment_monitoring_enabled{app="farm-service"}
farm_environment_cron_heartbeat_timestamp_seconds{app="farm-service",job="provider_sync"}
farm_environment_cron_last_run_timestamp_seconds{app="farm-service"}
farm_environment_due_backlog{app="farm-service"}
farm_environment_oldest_due_age_seconds{app="farm-service"}
sum by (provider, status) (
  increase(farm_environment_provider_completions_total{app="farm-service"}[30m])
)
```

Within one 15-minute scheduler interval:

- the `provider_sync` heartbeat advances;
- provider completions appear for configured `SEA_CAGE` sites;
- `farm_environment_cron_last_success_timestamp_seconds` advances on a clean
  run;
- each tenant performs one missing-state reconciliation per scheduler sweep;
  side-effect-free four-lease claims then rotate fairly across tenants and the
  bounded four-worker pool drains the due backlog without repeating the
  site-by-provider scan; a fixed sweep cutoff prevents newly scheduled work
  from being reclaimed in the same run while each claim uses a fresh clock for
  its lease expiry; cutoff-eligible work is drained, work that becomes due
  during a long run remains visible for the next sweep, and oldest-due age
  remains below the 30-minute scheduling SLO;
- the tenant environment panel reports provider provenance and honest
  availability states;
- no credential, tenant ID, site ID, schema name, or raw upstream error is
  present in metrics or logs.

Interactive Sentinel rendering has a deliberate timeout hierarchy: each CDSE
request is bounded to 30 seconds, the gateway owns a 210-second aggregate
render deadline, the browser client allows 215 seconds, and Nginx allows 220
seconds. Do not lower an outer deadline below the layer it encloses.

The daily retention heartbeat should advance after 03:00 UTC even while the
monitoring rollout gate is disabled. The Kubernetes and droplet retention
alerts intentionally do not depend on that gate; both also alert on stalled
provider heartbeats, partial/aborted cron runs, repeated provider failures, and
elevated lease-fence discards.

### Credential cutover startup refusal

If farm-service does not become ready and reports a credential cutover
failure, confirm config-service, Redis, NATS mTLS identity, audit persistence,
and `SENTINEL_HUB_ENCRYPTION_KEY`. A prepared row is intentionally immutable;
after the dependency is healthy, restart farm-service so bootstrap retries the
same frozen bundle. Never edit its digest, re-enable the legacy row, overwrite
a tenant config value, or move the credential through a tenant-facing surface.
Compare only metadata (tenant, config version, audit outcome); do not print or
query plaintext secrets.

## Alert triage

### `FarmEnvironmentBacklogSloBreached`

The scheduler is alive but at least one eligible provider lease has remained
due for more than 30 minutes. Compare backlog growth with provider completion
latency and failures. Check CDSE/CMEMS quota responses and saturation first;
then verify all farm-service replicas are healthy and can acquire DB leases.
Do not increase provider concurrency without reviewing the company-account
quota and the render/ingestion shared concurrency boundary.

### `FarmEnvironmentProviderSyncStalled`

Check farm-service health and `/metrics`, then verify the rollout gauge is
`1`. Inspect scheduler startup and database connectivity. Each database claim
leases at most four rows; the scheduler rotates one batch per tenant until a
fair sweep finds no work at or before its fixed cutoff. A missing
start/completion heartbeat for 90 minutes exceeds one derived worst-case lease
budget plus the 15-minute schedule interval.

### `FarmEnvironmentCronFailures`

Inspect `farm_environment_internal_failures_total` by its bounded `phase`
label. `tenant_discovery` points to schema discovery/database access;
`state_reconciliation` to the once-per-tenant missing-state seed;
`backlog_measurement` to due-work SLO reads; `claim` to lease acquisition;
`lease_execution` to ingestion/persistence; `retention` to cleanup.

### `FarmEnvironmentProviderFailuresElevated`

Inspect completion status by provider. For `PARTIAL_FAILURE`, inspect
`farm_environment_provider_scope_outcomes_total` and the metric coverage shown
in the tenant panel to identify the failed product, horizon, or interval. For
`CONFIGURATION_ERROR`, validate the company-owned configuration above. For
`PROVIDER_UNAVAILABLE`, check official upstream status, egress/DNS/TLS, rate
limits, and bounded-response errors.
Never add a tenant credential as a workaround for a company configuration
failure.

CMEMS requests outside a dataset's advertised capability time sequence are
persisted as `NO_DATA`; the service must never clamp them to the first or last
model frame. Capability metadata stays fresh for longer than one derived lease
budget, so a long multi-horizon run does not repeatedly rediscover the same
dataset.

### `FarmEnvironmentLeaseDiscardsElevated`

Lease discards are the correct fence when a lease expires or a site location
revision changes during provider work. Repeated discards indicate excessive
site edits, replica latency, database contention, or execution beyond the
derived lease budget. Do not bypass the fence.

## Rollback

The safe operational rollback is:

1. set `FARM_ENVIRONMENT_MONITORING_ENABLED=false`;
2. restart farm-service;
3. verify the rollout gauge is `0`;
4. confirm provider claims and ingestion writes stop, lifecycle retention still
   runs, and environment read/binary entry points return the stable disabled
   response.

Canonical rows remain in PostgreSQL, are not served while disabled, and keep
their normal 45-day retention lifecycle. Keep the migrations and config-service
credential records in place. Do not restore scrubbed legacy ciphertext or
create a second credential reader.

An application-image rollback across the credential-cutover boundary is not
safe because an older image expects the scrubbed legacy rows. Use the
gate-based rollback on the compatible release. If a database restore is
required for an unrelated incident, stop farm-service and config-service,
follow the database restore runbook, and re-run this sequence from migrations
with the recorded release SHA.
