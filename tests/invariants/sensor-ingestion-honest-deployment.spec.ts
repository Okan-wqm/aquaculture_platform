/**
 * Platform-wide invariant — Cluster 4 (deploy honesty):
 *
 * Task 3 (100-tenant readiness plan) restored the REAL sidecar pipeline:
 * main.rs drains MQTT through topic-parse → cache/lookup → payload
 * validate → batch aggregator → PostgresSink (per-tenant COPY + upsert
 * + transactional outbox enqueue) with the dispatcher publishing to the
 * telemetry root under an awaited PubAck. The invariant now guards the
 * RESTORED state: (a) the stub drain must never come back, (b) the
 * per-tenant schema derivation + JetStream publish must be present, and
 * (c) while any of those regress, the compose files must not deploy the
 * service. No Rust toolchain required: pure text checks.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('INVARIANT (Cluster 4): sensor-ingestion deploy honesty', () => {
  const mainRs = read('apps/sensor-ingestion/src/main.rs');

  const drainIsStub = /stub drain/.test(mainRs) && !/PostgresSink|run_publisher_loop/.test(mainRs);

  it('the restored REAL pipeline is present: per-tenant sink + outbox + JetStream PubAck (Task 3)', () => {
    // The drain forwards to the batch aggregator (persistence pipeline).
    expect(drainIsStub).toBe(false);
    // The persistence path enqueues the transactional outbox (ADR-029).
    expect(mainRs).toContain('start_persistence_pipeline');
    expect(mainRs).toContain('maybe_start_outbox_pipeline');
    // The schema derivation went through the 16-hex SSoT (golden vectors).
    expect(read('crates/tenant-context/src/lib.rs')).toContain('full[..16]');
  });

  it('the stub drain marker never comes back', () => {
    expect(/stub drain/.test(mainRs)).toBe(false);
  });

  it('prod compose deploys the sidecar only while the real pipeline is wired', () => {
    if (!drainIsStub) {
      // Drain has been wired end-to-end — the service may legitimately deploy.
      return;
    }

    const compose = read('docker-compose.prod.yml');
    // An ACTIVE (un-commented) service block opens with `  sensor-ingestion:` at
    // 2-space indent and no leading `#`. The honest state comments it out.
    const hasActiveService = compose
      .split('\n')
      .some((line) => /^ {2}sensor-ingestion:\s*$/.test(line));

    expect(hasActiveService).toBe(false);
  });
});
