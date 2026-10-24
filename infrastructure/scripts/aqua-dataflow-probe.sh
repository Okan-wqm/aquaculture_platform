#!/bin/bash
# aqua-dataflow-probe — the privileged half of the dataflow-integrity watchdog
# (RW-2). Installed root-owned at /usr/local/sbin/aqua-dataflow-probe and run
# ONLY by the socket-activated unit infrastructure/dataflow-probe/
# aqua-dataflow-probe@.service; install and review steps live in
# docs/runbooks/monitoring/dataflow-integrity.md ("Privileged probe install").
#
# WHY IT EXISTS. Two of the watchdog's T1 probes need facts only root can read
# on this host: the daemon's per-container State.Running (container_state_truth)
# and the tenant rows against the physical schemas in Postgres
# (tenant_reality_parity). The runner account must never reach docker (group
# membership is root by another name) and its unit runs with
# NoNewPrivileges=yes and no supplementary group (ADR-0023,
# scripts/aria/runner-habitat/systemd/actions-runner.identity.conf), so sudo is
# inert for every job. Root therefore measures, and the runner only reads the
# JSON this script prints; tools/watchdog/probe-runner.mjs judges it.
#
# WHAT IT MAY DO, and nothing more:
#   * take no argument at all: anything on the command line is refused before
#     a single command runs, so no caller can steer what root executes;
#   * `docker ps` / `docker inspect` (read-only daemon verbs);
#   * `docker exec` only to run psql in aqua-postgres, every session opened
#     with default_transaction_read_only=on, so the one constant statement
#     below runs in a read-only transaction and a write would be refused by the
#     server, not merely absent from the text;
#   * print one JSON document on stdout (the socket):
#       {"container_state_truth": M, "tenant_reality_parity": M}
#     where M is the measurement or {"error": "<fixed reason>"}. One failed
#     measurement never hides the other; the command's own stderr goes to the
#     journal of the unit instance.
# The environment (PATH included) is the unit's, set by systemd; nothing the
# connecting client sends reaches this process (StandardInput=null).

if [ "$#" -ne 0 ]; then
  printf 'aqua-dataflow-probe: takes no arguments (got %d); it is run only by aqua-dataflow-probe@.service\n' "$#" >&2
  exit 64
fi

set -euo pipefail

# libpq reads PGOPTIONS in the container: every session starts read-only and
# a stalled statement is cancelled by the server (the old runner-side 20 s
# execFileSync timeout, now where the statement runs).
readonly READ_ONLY_SESSION='PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=20s'

# Schema naming SSoT: getTenantSchemaName()
# (libs/backend-common/src/database/tenant-schema.utils.ts:76): 'tenant_' plus
# the first 16 hex characters of the UUID, NOT the whole UUID; the join
# re-derives it in SQL so one round trip answers for every tenant. Only the
# status travels, never a tenant id or name: the runner and the evidence it
# uploads stay identity-free. The judgement (which state pages whom) is
# tools/watchdog/tenant-reality.mjs, tested there.
readonly TENANT_REALITY_SQL="SELECT COALESCE(json_agg(json_build_object(
         'status', t.status,
         'schemaExists', s.schema_name IS NOT NULL,
         'tableCount', COALESCE((SELECT count(*) FROM information_schema.tables it
                                  WHERE it.table_schema = s.schema_name), 0))), '[]'::json)
  FROM auth.tenants t
  LEFT JOIN information_schema.schemata s
         ON s.schema_name = 'tenant_' || left(replace(t.id::text, '-', ''), 16)"

# Container truth: the `docker ps` text lies (2026-08-03 outage class); the
# only trustworthy field is State.Running of each listed container.
container_state_truth() {
  local ids id running
  local listed=0 not_running=0
  ids=$(docker ps -q) || return 1
  for id in $ids; do
    running=$(docker inspect --format '{{.State.Running}}' "$id") || return 1
    listed=$((listed + 1))
    if [ "$running" != true ]; then not_running=$((not_running + 1)); fi
  done
  printf '{"listed":%d,"not_running_but_listed":%d}' "$listed" "$not_running"
}

# The tenant rows as one JSON array (psql -tA prints the aggregate alone).
tenant_rows() {
  docker exec --env "$READ_ONLY_SESSION" aqua-postgres psql -X -q -v ON_ERROR_STOP=1 \
    -U aquaculture -d aquaculture -tA -c "$TENANT_REALITY_SQL"
}

if ! container=$(container_state_truth); then
  container='{"error":"listing or inspecting the containers failed; see the unit journal"}'
fi
if tenants=$(tenant_rows); then
  tenants="{\"tenants\":${tenants}}"
else
  tenants='{"error":"the read-only tenant query failed; see the unit journal"}'
fi
printf '{"container_state_truth":%s,"tenant_reality_parity":%s}\n' "$container" "$tenants"
