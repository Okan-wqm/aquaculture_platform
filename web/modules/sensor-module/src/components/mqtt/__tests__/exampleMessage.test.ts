/**
 * The example message the credential panel shows names each channel's number
 * where the ingestion reads it: a dotted path nests, an indexed segment is an
 * array item — a device built from a flat example would store nothing.
 */
import { describe, expect, it } from 'vitest';

import { exampleMessage } from '../SensorMqttCredentialsPanel';

describe('exampleMessage', () => {
  it('keeps plain keys flat', () => {
    expect(exampleMessage(['ph', 'temperature'])).toEqual({ ph: 0, temperature: 0 });
  });

  it('nests dotted paths and fills indexed items', () => {
    expect(exampleMessage(['sensors.mid', 'sensors.top', 'values[1]', 'probes[0].ph'])).toEqual({
      sensors: { mid: 0, top: 0 },
      values: [undefined, 0],
      probes: [{ ph: 0 }],
    });
  });
});
