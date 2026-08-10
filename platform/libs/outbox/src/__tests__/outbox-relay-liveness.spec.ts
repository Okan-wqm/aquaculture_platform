/**
 * The outbox already exports queue depth, oldest-pending age and dead-letter
 * counts, and W-A put alarms on all three. Every one of them describes the
 * QUEUE. If the relay process stops, those gauges stop being written and
 * hold their last value — a stalled dispatcher with an empty queue reports
 * zero pending forever and looks perfectly healthy.
 *
 * These tests pin the signal that describes the RELAY instead, and the one
 * property that makes it useful: it is written even when the cycle found
 * nothing and even when the cycle threw, because "idle" and "failing" are
 * both alive, and only "absent" is the thing the queue gauges cannot see.
 */
import * as client from 'prom-client';

import { OutboxMetricsService } from '../outbox-metrics.service';

const METRIC = 'outbox_relay_last_cycle_timestamp_seconds';

describe('outbox relay liveness gauge', () => {
  let metrics: OutboxMetricsService;

  beforeEach(() => {
    client.register.clear();
    metrics = new OutboxMetricsService();
  });

  afterEach(() => {
    client.register.clear();
  });

  async function relayGauge(service: string): Promise<number | undefined> {
    const metric = client.register.getSingleMetric(METRIC) as client.Gauge<string> | undefined;
    const collected = await metric?.get();
    return collected?.values.find((value) => value.labels.service === service)?.value;
  }

  it('publishes nothing before the first cycle', async () => {
    // No series until the relay has actually run once: a value invented at
    // construction time would claim a cycle that never happened.
    await expect(relayGauge('farm_outbox')).resolves.toBeUndefined();
  });

  it('records the moment a cycle completed', async () => {
    const before = Date.now() / 1000;

    metrics.markRelayCycle('farm_outbox');

    const recorded = await relayGauge('farm_outbox');
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(Date.now() / 1000 + 1);
  });

  it('keeps each service on its own series', async () => {
    metrics.markRelayCycle('farm_outbox');
    metrics.markRelayCycle('messaging_outbox');

    await expect(relayGauge('farm_outbox')).resolves.toBeDefined();
    await expect(relayGauge('messaging_outbox')).resolves.toBeDefined();
  });

  it('moves forward on every cycle so staleness is measurable', async () => {
    metrics.markRelayCycle('farm_outbox');
    const first = await relayGauge('farm_outbox');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    metrics.markRelayCycle('farm_outbox');
    const second = await relayGauge('farm_outbox');

    expect(second).toBeGreaterThan(first as number);
  });

  it('does not disturb the queue gauges it sits beside', async () => {
    metrics.setPending('farm_outbox', 7);
    metrics.markRelayCycle('farm_outbox');

    const pending = client.register.getSingleMetric('outbox_pending') as client.Gauge<string>;
    const value = (await pending.get()).values.find((v) => v.labels.service === 'farm_outbox');

    expect(value?.value).toBe(7);
  });
});
