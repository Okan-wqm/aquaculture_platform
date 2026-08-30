import { Test, TestingModule } from '@nestjs/testing';

import { UnifiedTagService } from '../../process/services/unified-tag.service';
import { ScadaRuntimeGateway } from '../scada-runtime.gateway';
import { DaqStorageService } from '../services/daq-storage.service';
import { TagValueFanoutService, mapQualityCode } from '../services/tag-value-fanout.service';

/**
 * SENSOR-HIGH-046 — the live-data producer.
 *
 * gateway.pushTagValues had zero production callers: operator sockets
 * authenticated, subscribed, and showed null forever. TagValueFanoutService
 * bridges each ingested metric (keyed sensorId/channelId) onto the gateway's
 * tenant-fenced fan-out (keyed by registry fqn) via the UnifiedTag registry's
 * source linkage, with a TTL cache (positive + negative) on the hot path.
 */

const TENANT = 'tenant-uuid-1';

function metric(overrides: Partial<Parameters<TagValueFanoutService['fanoutMetric']>[0]> = {}) {
  return {
    tenantId: TENANT,
    sensorId: 'sensor-1',
    channelId: 'chan-1',
    value: 7.4,
    timestampMs: 1_750_000_000_000,
    qualityCode: 0,
    ...overrides,
  };
}

describe('TagValueFanoutService (SENSOR-HIGH-046)', () => {
  let service: TagValueFanoutService;
  let findFqns: jest.Mock;
  let pushTagValues: jest.Mock;
  let addValues: jest.Mock;

  beforeEach(async () => {
    findFqns = jest.fn();
    pushTagValues = jest.fn();
    addValues = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagValueFanoutService,
        { provide: UnifiedTagService, useValue: { findFqnsBySensorSource: findFqns } },
        { provide: ScadaRuntimeGateway, useValue: { pushTagValues } },
        { provide: DaqStorageService, useValue: { addValues } },
      ],
    }).compile();

    service = module.get(TagValueFanoutService);
  });

  it('pushes the metric to the gateway under every resolved fqn', async () => {
    findFqns.mockResolvedValue(['EDGE-AABB1122/tank1.do']);

    await service.fanoutMetric(metric());

    expect(pushTagValues).toHaveBeenCalledWith(TENANT, [
      {
        tagId: 'EDGE-AABB1122/tank1.do',
        value: 7.4,
        timestamp: 1_750_000_000_000,
        quality: 'good',
      },
    ]);
  });

  it('does not touch the gateway when the sensor has no registry tag', async () => {
    findFqns.mockResolvedValue([]);

    await service.fanoutMetric(metric());

    expect(pushTagValues).not.toHaveBeenCalled();
  });

  it('caches the resolution: repeated metrics hit the registry once per TTL', async () => {
    findFqns.mockResolvedValue(['EDGE-AABB1122/tank1.do']);

    await service.fanoutMetric(metric());
    await service.fanoutMetric(metric({ value: 7.5 }));
    await service.fanoutMetric(metric({ value: 7.6 }));

    expect(findFqns).toHaveBeenCalledTimes(1);
    expect(pushTagValues).toHaveBeenCalledTimes(3);
  });

  it('caches negative resolutions too (unmapped sensors cost one query per TTL)', async () => {
    findFqns.mockResolvedValue([]);

    await service.fanoutMetric(metric());
    await service.fanoutMetric(metric({ value: 7.5 }));

    expect(findFqns).toHaveBeenCalledTimes(1);
    expect(pushTagValues).not.toHaveBeenCalled();
    expect(service.drainStats().unmapped).toBe(2);
  });

  it('never throws: a registry failure is swallowed and logged', async () => {
    findFqns.mockRejectedValue(new Error('db down'));

    await expect(service.fanoutMetric(metric())).resolves.toBeUndefined();
    expect(pushTagValues).not.toHaveBeenCalled();
  });

  it('buffers DAQ history and flushes ONE tenant batch, not per-metric inserts (SENSOR-HIGH-053)', async () => {
    findFqns.mockResolvedValue(['EDGE-AABB1122/tank1.do']);

    await service.fanoutMetric(metric({ value: 7.4 }));
    await service.fanoutMetric(metric({ value: 7.5 }));
    await service.fanoutMetric(metric({ value: 7.6 }));

    // Nothing written yet — history writes coalesce off the ingestion hot path.
    expect(addValues).not.toHaveBeenCalled();

    service.onModuleDestroy(); // drains the buffer

    expect(addValues).toHaveBeenCalledTimes(1); // one batch, one tenant
    const [tenantArg, , rows] = addValues.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { value: number }) => r.value)).toEqual([7.4, 7.5, 7.6]);
  });

  it('maps the IEC 61131-3 subset and legacy OPC-UA ranges to TagQuality', () => {
    expect(mapQualityCode(0)).toBe('good'); // IEC good
    expect(mapQualityCode(1)).toBe('uncertain'); // IEC uncertain
    expect(mapQualityCode(2)).toBe('bad'); // IEC bad
    expect(mapQualityCode(3)).toBe('bad'); // IEC not-connected
    expect(mapQualityCode(192)).toBe('good'); // OPC-UA good
    expect(mapQualityCode(64)).toBe('uncertain'); // OPC-UA uncertain
    expect(mapQualityCode(8)).toBe('bad'); // OPC-UA bad range
  });
});
