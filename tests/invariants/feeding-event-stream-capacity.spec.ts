import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AQUACULTURE_EVENT_STREAM_PROFILE_V1,
  FEEDING_EVENT_CAPACITY_CATALOG_V1,
  assertEventCapacityAdmissionV1,
  compileFeedingEventStreamCapacityV1,
} from '../../platform/libs/event-bus/src/nats/event-stream-capacity.catalog';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('feeding event-stream capacity SSOT', () => {
  it('keeps every event envelope numeric, bounded, and below runtime admission', () => {
    expect(Object.keys(FEEDING_EVENT_CAPACITY_CATALOG_V1).length).toBeGreaterThan(0);
    for (const entry of Object.values(FEEDING_EVENT_CAPACITY_CATALOG_V1)) {
      expect(Number.isSafeInteger(entry.plannedEventsPerTenantDay)).toBe(true);
      expect(entry.plannedEventsPerTenantDay).toBeGreaterThan(0);
      expect(entry.estimatedEncodedBytes).toBeGreaterThan(0);
      expect(entry.estimatedEncodedBytes).toBeLessThanOrEqual(entry.maxEncodedBytes);
      expect(entry.maxEncodedBytes).toBeLessThanOrEqual(
        AQUACULTURE_EVENT_STREAM_PROFILE_V1.maxMessageBytes,
      );
    }
  });

  it('projects every catalog entry into its producer ACL without a second subject list', () => {
    const services = readFileSync(resolve(REPO_ROOT, 'infrastructure/nats/services.yaml'), 'utf8');
    for (const [eventType, entry] of Object.entries(FEEDING_EVENT_CAPACITY_CATALOG_V1)) {
      const serviceName = entry.producer.replaceAll('-', '_');
      const serviceStart = services.indexOf(`- name: ${serviceName}`);
      expect(serviceStart).toBeGreaterThanOrEqual(0);
      const nextService = services.indexOf('\n  - name:', serviceStart + 1);
      const serviceBlock = services.slice(
        serviceStart,
        nextService >= 0 ? nextService : services.length,
      );
      expect(serviceBlock).toContain(`'events.*.${eventType}'`);
    }
  });

  it('compiles a deterministic guarded large-tenant ceiling', () => {
    const first = compileFeedingEventStreamCapacityV1();
    const second = compileFeedingEventStreamCapacityV1();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.qualifiedLargeTenantCeiling).toBeGreaterThan(0);
    expect(first.bindingDimension).toBe('messages');
    expect(first.feedingMessageBudget).toBe(
      Math.floor(
        AQUACULTURE_EVENT_STREAM_PROFILE_V1.maxMessages *
          AQUACULTURE_EVENT_STREAM_PROFILE_V1.feedingCapacityShareRatio,
      ),
    );
  });

  it('uses each catalog maximum as a live publisher admission boundary', () => {
    const limit = FEEDING_EVENT_CAPACITY_CATALOG_V1.MealFed.maxEncodedBytes;
    expect(() => assertEventCapacityAdmissionV1('MealFed', limit)).not.toThrow();
    expect(() => assertEventCapacityAdmissionV1('MealFed', limit + 1)).toThrow('admission limit');
    expect(() =>
      assertEventCapacityAdmissionV1(
        'UncataloguedPlatformEvent',
        AQUACULTURE_EVENT_STREAM_PROFILE_V1.maxMessageBytes + 1,
      ),
    ).toThrow('admission limit');
    const bus = readFileSync(
      resolve(REPO_ROOT, 'platform/libs/event-bus/src/nats/nats-event-bus.ts'),
      'utf8',
    );
    expect(bus).toContain(
      "assertEventCapacityAdmissionV1(event.eventType, Buffer.byteLength(payload, 'utf8'))",
    );
  });

  it('pins the runtime file-store headroom to the infrastructure value', () => {
    const config = readFileSync(resolve(REPO_ROOT, 'infrastructure/docker/nats/nats.conf'), 'utf8');
    const match = /max_file_store:\s*(\d+)GB/.exec(config);
    expect(match).not.toBeNull();
    expect(Number(match?.[1]) * 1024 * 1024 * 1024).toBe(
      AQUACULTURE_EVENT_STREAM_PROFILE_V1.infrastructureMaxFileStoreBytes,
    );
    expect(AQUACULTURE_EVENT_STREAM_PROFILE_V1.maxBytes).toBeLessThan(
      AQUACULTURE_EVENT_STREAM_PROFILE_V1.infrastructureMaxFileStoreBytes,
    );
    const maxPayload = /max_payload:\s*(\d+)MB/.exec(config);
    expect(Number(maxPayload?.[1]) * 1024 * 1024).toBe(
      AQUACULTURE_EVENT_STREAM_PROFILE_V1.maxMessageBytes,
    );
  });
});
