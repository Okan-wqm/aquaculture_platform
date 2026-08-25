import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildCanonicalStreamRoutes,
  requiredFileStoreBytes,
} from '../../platform/libs/event-bus/src/nats/stream-route.registry';

describe('JetStream file-store capacity envelope', () => {
  it('keeps max_file_store at least 1.25x the sum of every canonical stream max_bytes', () => {
    const config = readFileSync(
      join(process.cwd(), 'infrastructure/docker/nats/nats.conf'),
      'utf8',
    );
    const match = config.match(/max_file_store:\s*(\d+)GB/);
    if (match === null) throw new Error('nats.conf max_file_store must use an explicit GB value');
    const configuredBytes = Number(match[1]) * 1024 * 1024 * 1024;
    const routes = buildCanonicalStreamRoutes({
      eventsStreamName: 'AQUACULTURE_EVENTS',
      telemetryEventsPerSecond: 2_000,
      telemetryStoredEventP99Bytes: 1_024,
    });

    expect(configuredBytes).toBeGreaterThanOrEqual(requiredFileStoreBytes(routes));
  });
});
