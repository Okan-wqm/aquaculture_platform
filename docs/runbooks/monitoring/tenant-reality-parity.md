# Tenant Reality Parity Alerts — Runbook

Alerts from the `aquaculture.tenant.reality` group in
`infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml`, fed by the
`tenant_reality_parity` probe in `tools/watchdog/probe-runner.mjs`.

**What the probe measures.** For every row in `auth.tenants` it compares the
declared status against physical reality: does `tenant_<first-16-hex-of-uuid>`
exist in `information_schema.schemata`, and does it hold any tables. The schema
name is derived exactly as `getTenantSchemaName()` does
(`libs/backend-common/src/database/tenant-schema.utils.ts:76`).

**Why it exists.** The provisioning saga verifies only its own bookkeeping —
`admin.tenant_schemas` against `platform.tenant_schema_jobs` — and never looks
at the schema those rows describe. Both ledgers can agree with each other while
no schema exists. That combination renders as a fully healthy tenant in the
admin panel, which is why it survived for months and was found by hand
(ORPHAN-HIGH-570, 2026-08-06) rather than by any alarm.

**The metrics carry no tenant identity.** The probe exports counts per finding
class and nothing else — no tenant id, no name, no healthy total. To learn
_which_ tenant is affected you must query the database (below); the scrape
surface deliberately cannot tell you, and cannot be mined for the customer list.

## TenantActiveWithoutPhysicalSchema (critical)

One or more tenants are served as `ACTIVE` while having no usable schema. Every
per-tenant write they make has nowhere to land. This is the customer-visible
half: login succeeds, the panel looks normal, and farm/sensor/HR/messaging data
cannot be stored.

1. Identify the affected rows:

   ```sql
   SELECT t.id, t.name, t.status,
          (s.schema_name IS NOT NULL) AS schema_exists,
          COALESCE((SELECT count(*) FROM information_schema.tables it
                     WHERE it.table_schema = s.schema_name), 0) AS table_count
     FROM auth.tenants t
     LEFT JOIN information_schema.schemata s
            ON s.schema_name = 'tenant_' || left(replace(t.id::text, '-', ''), 16)
    WHERE t.status = 'ACTIVE';
   ```

2. Check whether provisioning is even trying — read `platform.tenant_schema_jobs`
   and `admin.tenant_schemas` for that tenant id. An empty queue with a missing
   schema means nothing is retrying: the tenant stays broken until someone acts.

3. Check the provisioner is alive:
   `docker inspect -f '{{.State.Running}}' aqua-tenant-schema-provisioner`.
   Do not trust the `docker ps` text listing (2026-08-03 outage class).

4. Check `auth.tenant_command_receipts` for the tenant: a receipt written
   without RLS tenant context is the failure mode that stopped all eight
   provisioning steps before they began.

**Do not create the schema by hand as a first move.** Creating a tenant schema
on production is a data-shaping act with migration-ledger and RLS consequences.
Establish _why_ it is missing first; a hand-made schema that the migration
ledger does not know about is a worse state than an absent one.

## TenantProvisioningNeverCompleted (warning)

A tenant has been `PENDING` with no schema for over 30 minutes. Provisioning
started and stopped partway. Same triage as above, steps 2–4. Escalate at once
if anything is about to flip the tenant to `ACTIVE` — that transition converts
this alert into the CRITICAL above without changing anything physical.

## TenantRealityProbeStale (critical)

No `probe_ok{probe_id="tenant_reality_parity"}` series. The two count-based
alerts above go quiet when the probe stops, and quiet is indistinguishable from
all-clear.

1. Run it by hand from the repo root:
   `node tools/watchdog/probe-runner.mjs --repo /var/aqua-saas --textfile <collector-dir>/aqua-probes.prom`.
2. Exit 3 means at least one CRITICAL finding; exit 1 means a probe is
   non-green without being critical.
3. If the probe errors, the detail carries the message — the usual causes are
   the `aqua-postgres` container being absent and the textfile directory not
   being writable.

## Signal hygiene

Sustained firings are filed to the finding registry with
`owner_agent: multi-tenant-saas-expert` and ingested into ARIA with
`aria-kernel runtime signal ingest`; close the ARIA side when the condition
clears.
