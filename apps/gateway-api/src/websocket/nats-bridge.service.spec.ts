import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SENSOR_READING_EVENT_SUBJECTS } from './nats-bridge.service';

describe('NatsBridgeService routing and identity invariants', () => {
  it('subscribes to tenant-scoped legacy and telemetry SensorReading subjects', () => {
    expect(SENSOR_READING_EVENT_SUBJECTS).toEqual([
      'events.*.SensorReading',
      'telemetry.*.SensorReading',
    ]);
  });

  it('delegates NATS identity entirely to the canonical connection factory', () => {
    const source = readFileSync(join(__dirname, 'nats-bridge.service.ts'), 'utf8');

    expect(source).not.toMatch(/NATS_AUTH_(TOKEN|USER|PASS)/);
    expect(source).not.toMatch(/connectionOptions\.(token|user|pass)\s*=/);
  });
});
