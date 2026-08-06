#!/usr/bin/env node
/**
 * Data-Flow Integrity Watchdog — T1 probe runner (W-B slice 1).
 *
 * Read-only, credential-free probes over surfaces the platform already
 * exposes (design: plan tranquil-sniffing-pancake §F5; taxonomy K-A/K-B).
 * Emits one JSON evidence document on stdout (the post-deploy-verify
 * convention) and probe_* metrics in Prometheus textfile format to
 * --textfile <path> for the node_exporter textfile collector.
 *
 * Exit codes: 0 all green · 1 probe infrastructure error · 3 at least one
 * CRITICAL finding (callers may ingest a runtime signal / dispatch a cycle).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : []))
    .filter(Boolean),
);
const HOST = args.host ?? 'https://app.suderra.com';
const results = [];

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
      ms: Date.now() - started,
    });
  } catch (e) {
    results.push({
      id,
      target_auditor,
      ok: false,
      critical: false,
      detail: `probe-error: ${String(e).slice(0, 160)}`,
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
// only trustworthy fields are State.Running + Health.
await probe('container_state_truth', 'job-queue-auditor', async () => {
  const out = execFileSync('docker', ['ps', '-q'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  let deadListed = 0;
  for (const id of out) {
    const st = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', id], {
      encoding: 'utf8',
    }).trim();
    if (st !== 'true') deadListed += 1;
  }
  return {
    ok: deadListed === 0,
    critical: deadListed > 0,
    detail: `listed=${out.length} not-running-but-listed=${deadListed}`,
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

const criticals = results.filter((r) => r.critical);
if (args.textfile) {
  const lines = ['# TYPE probe_ok gauge', '# TYPE probe_duration_ms gauge'];
  for (const r of results) {
    const l = `probe_id="${r.id}",target_auditor="${r.target_auditor}"`;
    lines.push(`probe_ok{${l}} ${r.ok ? 1 : 0}`);
    lines.push(`probe_duration_ms{${l}} ${r.ms}`);
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
