import { DiscardPolicy } from '@nats-io/jetstream';

import { buildCanonicalStreamRoutes, resolveStreamRoute } from '../stream-route.registry';

describe('canonical JetStream route registry', () => {
  const routes = buildCanonicalStreamRoutes({
    eventsStreamName: 'AQUACULTURE_EVENTS',
    telemetryEventsPerSecond: 2_000,
    telemetryStoredEventP99Bytes: 1_024,
  });

  it.each([
    ['events.t.SensorReading', 'AQUACULTURE_EVENTS'],
    ['commands.t.Rebuild', 'AQUACULTURE_EVENTS'],
    ['queries.t.Status', 'AQUACULTURE_EVENTS'],
    ['telemetry.t.SensorReading', 'AQUACULTURE_TELEMETRY'],
    ['dlq.mqtt', 'AQUACULTURE_DLQ'],
    ['quarantine.mqtt', 'AQUACULTURE_QUARANTINE'],
  ])('routes %s to %s', (subject, stream) => {
    expect(resolveStreamRoute(routes, subject).streamName).toBe(stream);
  });

  it('fails closed for an unknown root', () => {
    expect(() => resolveStreamRoute(routes, 'other.t.Event')).toThrow('Unknown NATS subject root');
  });

  it('uses the measured telemetry sizing formula and DiscardNew', () => {
    const telemetry = resolveStreamRoute(routes, 'telemetry.t.SensorReading');
    expect(telemetry.maxBytes).toBe(Math.ceil(2_000 * 1_024 * 3_600 * 1.2));
    expect(telemetry.maxMessages).toBe(Math.ceil(2_000 * 3_600 * 1.2));
    expect(telemetry.maxAgeNanos).toBe(90 * 60 * 1_000_000_000);
    expect(telemetry.discard).toBe(DiscardPolicy.New);
  });

  it('keeps DLQ for 72 hours and quarantine for 24 hours with non-overlapping subjects', () => {
    const dlq = resolveStreamRoute(routes, 'dlq.mqtt');
    const quarantine = resolveStreamRoute(routes, 'quarantine.mqtt');
    expect(dlq.subjects).toEqual(['dlq.>']);
    expect(dlq.maxAgeNanos).toBe(72 * 60 * 60 * 1_000_000_000);
    expect(quarantine.subjects).toEqual(['quarantine.mqtt']);
    expect(quarantine.maxAgeNanos).toBe(24 * 60 * 60 * 1_000_000_000);
  });
});
