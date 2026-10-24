#!/usr/bin/env node
/**
 * Data-Flow Integrity Watchdog — T1 probe runner (W-B slice 1).
 *
 * Read-only, credential-free probes over surfaces the platform already
 * exposes (design: plan tranquil-sniffing-pancake §F5; taxonomy K-A/K-B).
 * The two probes that need root-only facts (container_state_truth,
 * tenant_reality_parity) read them from the root-owned privileged probe
 * through privileged-evidence.mjs; this runner never starts docker or psql
 * (RW-2: the runner account has no docker and no privilege gain, ADR-0023).
 * Emits one JSON evidence document on stdout (the post-deploy-verify
 * convention) and probe_* metrics in Prometheus textfile format to
 * --textfile <path> for the node_exporter textfile collector.
 *
 * Exit codes: 0 all green · 1 probe infrastructure error · 3 at least one
 * CRITICAL finding (callers may ingest a runtime signal / dispatch a cycle).
 */
import { execFileSync } from 'node:child_process';

import { writeFileSync } from 'node:fs';

import {
  measurementOf,
  parsePrivilegedEvidence,
  PRIVILEGED_PROBE_SOCKET,
  PRIVILEGED_PROBE_TIMEOUT_MS,
  readPrivilegedEvidence,
} from './privileged-evidence.mjs';
import { classifyTenantReality } from './tenant-reality.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : []))
    .filter(Boolean),
);
const HOST = args.host ?? 'https://app.suderra.com';
const results = [];

// One connection answers both privileged probes. Asked on first use, inside
// the first probe that needs it, so a refused connection is that probe's
// probe-error (and the second probe's, from the same settled promise), never
// an unhandled rejection.
let privilegedEvidence;
function privileged() {
  privilegedEvidence ??= readPrivilegedEvidence(
    PRIVILEGED_PROBE_SOCKET,
    PRIVILEGED_PROBE_TIMEOUT_MS,
  ).then(parsePrivilegedEvidence);
  return privilegedEvidence;
}

async function probe(id, target_auditor, fn) {
  const started = Date.now();
  try {
    const r = await fn();
    results.push({
      id,
      target_auditor,
      ok: r.ok,
      critical: !r.ok && !!r.critical,
      detail: r.detail,
      counts: r.counts ?? {},
      ms: Date.now() - started,
    });
  } catch (e) {
    results.push({
      id,
      target_auditor,
      ok: false,
      critical: false,
      detail: `probe-error: ${String(e).slice(0, 160)}`,
      counts: {},
      ms: Date.now() - started,
    });
  }
}

// P1 — unauthenticated negative contract through the public edge. Data for an
// anonymous caller is a tenant-isolation breach, not a flake (post-deploy-
// verify.sh:280 classification, run periodically at last).
await probe('graphql_negative_contract', 'tenant-isolation-auditor', async () => {
  const res = await fetch(`${HOST}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query WatchdogCanary { farms { id } }' }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  if (!body) return { ok: false, detail: `unparseable response http=${res.status}` };
  const leaked = Array.isArray(body?.data?.farms) && body.data.farms.length > 0;
  if (leaked)
    return {
      ok: false,
      critical: true,
      detail: 'anonymous farms query returned data — tenant-isolation breach',
    };
  const composed = !JSON.stringify(body).includes('GRAPHQL_VALIDATION_FAILED');
  return {
    ok: composed,
    critical: !composed,
    detail: composed ? 'guarded-read contract holds' : 'farms field missing from supergraph',
  };
});

// P2 — realtime path handshake (realtime-sync-auditor's liveness floor).
await probe('socketio_handshake', 'realtime-sync-auditor', async () => {
  const res = await fetch(`${HOST}/socket.io/?EIO=4&transport=polling`, {
    signal: AbortSignal.timeout(10000),
  });
  const t = await res.text();
  return { ok: res.status === 200 && t.includes('sid'), detail: `http=${res.status}` };
});

// P3 — container truth: docker ps text lies (2026-08-03 outage class); the
// only trustworthy fields are State.Running + Health. Measured by root (the
// privileged probe); judged here.
await probe('container_state_truth', 'job-queue-auditor', async () => {
  const { listed, notRunningButListed } = measurementOf(
    await privileged(),
    'container_state_truth',
  );
  return {
    ok: notRunningButListed === 0,
    critical: notRunningButListed > 0,
    detail: `listed=${listed} not-running-but-listed=${notRunningButListed}`,
  };
});

// P4 — ARIA memory freshness: aria/state must advance within 48h once the
// nightly is live ("never forget" is only real if the branch keeps moving).
await probe('aria_state_freshness', 'job-queue-auditor', async () => {
  const iso = execFileSync('git', ['log', '-1', '--format=%cI', 'origin/aria-state'], {
    encoding: 'utf8',
    cwd: args.repo ?? process.cwd(),
  }).trim();
  const ageH = (Date.now() - new Date(iso).getTime()) / 3.6e6;
  return { ok: ageH < 48, critical: ageH >= 72, detail: `last-commit-age=${ageH.toFixed(1)}h` };
});

// P5 — declared tenant status vs physical reality. The provisioning saga
// verifies only its own bookkeeping (admin.tenant_schemas ×
// platform.tenant_schema_jobs) and never looks at the schema those rows claim
// to describe, so the two ledgers can agree with each other while the schema
// holding every per-tenant table does not exist. That state renders as a
// healthy tenant in the panel — it was found by hand on 2026-08-06
// (ORPHAN-HIGH-570), not by any alarm, because provisioning had no metric at
// all. This probe asks Postgres instead of the ledger.
// The privileged probe owns the statement (one read-only session against
// auth.tenants and information_schema, schema name derived as
// getTenantSchemaName() does); tenant-reality.mjs owns the judgement.
await probe('tenant_reality_parity', 'multi-tenant-saas-expert', async () => {
  const { tenants } = measurementOf(await privileged(), 'tenant_reality_parity');
  return classifyTenantReality(tenants);
});

const criticals = results.filter((r) => r.critical);
if (args.textfile) {
  const lines = [
    '# TYPE probe_ok gauge',
    '# TYPE probe_duration_ms gauge',
    '# TYPE probe_finding_count gauge',
  ];
  for (const r of results) {
    const l = `probe_id="${r.id}",target_auditor="${r.target_auditor}"`;
    lines.push(`probe_ok{${l}} ${r.ok ? 1 : 0}`);
    lines.push(`probe_duration_ms{${l}} ${r.ms}`);
    // Counts of NON-conforming rows only, classified — never totals and never
    // a per-subject label. The textfile is scraped by anything that can reach
    // node_exporter, so it stays identity-free by construction; a healthy
    // total would still disclose the customer count to every such reader.
    for (const [findingClass, count] of Object.entries(r.counts ?? {})) {
      lines.push(`probe_finding_count{${l},class="${findingClass}"} ${count}`);
    }
  }
  writeFileSync(args.textfile, lines.join('\n') + '\n');
}
console.log(
  JSON.stringify(
    { probed_at: new Date().toISOString(), host: HOST, results, critical_count: criticals.length },
    null,
    2,
  ),
);
process.exit(criticals.length > 0 ? 3 : results.every((r) => r.ok) ? 0 : 1);
