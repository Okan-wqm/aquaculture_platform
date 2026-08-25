import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DiscardPolicy } from '@nats-io/jetstream';

import {
  desiredStreamConfig,
  effectiveStreamReplicas,
  reconcileNatsStreams,
  type ProvisionerStreamApi,
} from '../nats-stream-provisioner';

function streamApi(): jest.Mocked<ProvisionerStreamApi> {
  return {
    info: jest.fn(),
    add: jest.fn(),
    update: jest.fn(),
  };
}

const routes = [
  {
    streamName: 'AQUACULTURE_TELEMETRY',
    roots: ['telemetry'],
    subjects: ['telemetry.>'],
    maxAgeNanos: 90 * 60 * 1_000_000_000,
    maxBytes: 8_847_360_000,
    maxMessages: 8_640_000,
    discard: DiscardPolicy.New,
  },
] as const;

describe('NATS stream provisioner', () => {
  it('fails closed when the connected server does not expose topology info', () => {
    expect(() => effectiveStreamReplicas(undefined, 3)).toThrow(
      'NATS server topology info is unavailable',
    );
    expect(effectiveStreamReplicas({}, 3)).toBe(1);
    expect(effectiveStreamReplicas({ cluster: 'prod' }, 3)).toBe(3);
  });

  it('blocks the successful db-migrate signal until stream reconciliation succeeds', () => {
    const main = readFileSync(resolve(__dirname, '..', 'main.ts'), 'utf8');
    const provision = main.indexOf('await provisionNatsStreams()');
    const completion = main.indexOf("bootInvariantSignalRecord('db_migrate_complete'");

    expect(provision).toBeGreaterThan(0);
    expect(completion).toBeGreaterThan(provision);
  });

  it('creates a missing stream only for the explicit stream-not-found response', async () => {
    const api = streamApi();
    api.info.mockRejectedValue({ status: 404, code: 10059 });
    api.add.mockResolvedValue(undefined);

    await reconcileNatsStreams(api, routes, 1);

    expect(api.add.mock.calls).toEqual([[desiredStreamConfig(routes[0], 1)]]);
    expect(api.update.mock.calls).toHaveLength(0);
  });

  it('updates drifted limits and is a no-op once the desired config is active', async () => {
    const api = streamApi();
    const desired = desiredStreamConfig(routes[0], 3);
    api.info
      .mockResolvedValueOnce({ config: { ...desired, max_bytes: desired.max_bytes - 1 } })
      .mockResolvedValueOnce({ config: desired });
    api.update.mockResolvedValue(undefined);

    await reconcileNatsStreams(api, routes, 3);
    await reconcileNatsStreams(api, routes, 3);

    expect(api.update.mock.calls).toEqual([[routes[0].streamName, desired]]);
    expect(api.add.mock.calls).toHaveLength(0);
  });

  it('fails closed on connectivity and authorization errors', async () => {
    const api = streamApi();
    api.info.mockRejectedValue(new Error('permissions violation'));

    await expect(reconcileNatsStreams(api, routes, 1)).rejects.toThrow('permissions violation');

    expect(api.add.mock.calls).toHaveLength(0);
    expect(api.update.mock.calls).toHaveLength(0);
  });
});
