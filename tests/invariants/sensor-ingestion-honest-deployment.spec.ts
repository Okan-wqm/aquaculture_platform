/**
 * Platform-wide invariant — Cluster 4 (deploy honesty):
 *
 * The Rust sensor-ingestion sidecar's pipeline modules exist + unit-test green,
 * but `apps/sensor-ingestion/src/main.rs` `drain_mqtt_stream` is still a
 * `tracing::trace!("mqtt msg (stub drain)")` no-op (the Faz-3 orchestrator wiring
 * did not survive the train merge), so the deployed binary would DROP every MQTT
 * message. While the drain is a stub, `docker-compose.prod.yml` must NOT deploy
 * the service as a "co-equal producer" — re-advertising it before it is wired is
 * a false-redundancy claim and is blocked here. No Rust toolchain required: pure
 * text checks on the source + the compose manifest.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('INVARIANT (Cluster 4): sensor-ingestion deploy honesty', () => {
  it('prod compose does not deploy sensor-ingestion while the main.rs drain is a stub', () => {
    const mainRs = read('apps/sensor-ingestion/src/main.rs');

    // The drain is a stub iff it still logs "stub drain" AND has not been wired to
    // the persistence/publish path (PostgresSink / run_publisher_loop).
    const drainIsStub =
      /stub drain/.test(mainRs) && !/PostgresSink|run_publisher_loop/.test(mainRs);

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
