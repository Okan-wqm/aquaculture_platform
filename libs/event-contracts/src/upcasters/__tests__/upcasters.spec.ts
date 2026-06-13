import { EventUpcasterRegistry, createDefaultRegistry } from '../index';
import { sensorReadingUpcaster } from '../sensor-reading.upcaster';
import { alertTriggeredUpcaster } from '../alert-triggered.upcaster';
import { batchHarvestedUpcaster } from '../batch-harvested-v1-to-v2.upcaster';
import { createTimestampUpcaster } from '../timestamp-to-string.upcaster';

describe('EventUpcasterRegistry', () => {
  let registry: EventUpcasterRegistry;

  beforeEach(() => {
    registry = createDefaultRegistry();
  });

  it('should pass through events with no registered upcaster', () => {
    const event = { eventType: 'UnknownEvent', version: 1, tenantId: 'test' };
    expect(registry.upcast(event)).toEqual(event);
  });

  it('should pass through events already at latest version', () => {
    // v3 is the current SensorReading schema (Scope B Phase S1.1
    // added optional federation correlation fields). A v3 event
    // round-trips unchanged through the registry.
    const event = { eventType: 'SensorReading', version: 3, sensorId: 's1', readingTemperature: 25 };
    expect(registry.upcast(event)).toEqual(event);
  });

  it('should pass through events with no eventType', () => {
    const event = { version: 1 };
    expect(registry.upcast(event)).toEqual(event);
  });
});

describe('SensorReading v1→v2 upcaster', () => {
  it('should flatten readings object to flat fields', () => {
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 'sensor-1',
      farmId: 'farm-1',
      pondId: 'pond-1',
      readings: {
        temperature: 25.5,
        ph: 7.2,
        dissolvedOxygen: 8.1,
        salinity: 15.3,
        ammonia: 0.02,
      },
    };

    const v2 = sensorReadingUpcaster.upcast(v1);

    expect(v2['version']).toBe(2);
    expect(v2['readingTemperature']).toBe(25.5);
    expect(v2['readingPh']).toBe(7.2);
    expect(v2['readingDissolvedOxygen']).toBe(8.1);
    expect(v2['readingSalinity']).toBe(15.3);
    expect(v2['readingAmmonia']).toBe(0.02);
    expect(v2['readings']).toBeUndefined();
    // Non-reading fields preserved
    expect(v2['sensorId']).toBe('sensor-1');
    expect(v2['farmId']).toBe('farm-1');
  });

  it('should handle empty readings object', () => {
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 'sensor-1',
      readings: {},
    };

    const v2 = sensorReadingUpcaster.upcast(v1);

    expect(v2['version']).toBe(2);
    expect(v2['readings']).toBeUndefined();
  });

  it('should handle missing readings field', () => {
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 'sensor-1',
    };

    const v2 = sensorReadingUpcaster.upcast(v1);

    expect(v2['version']).toBe(2);
  });

  it('should round-trip through registry to the LATEST version (v3)', () => {
    // Round-trip through the registry walks the full chain
    // (v1→v2→v3 — Scope B Phase S1.1 added v2→v3). A legacy v1
    // event from JetStream lands as v3 after a single
    // registry.upcast() call. The flattening (v1→v2) and the
    // identity bump (v2→v3) are both applied.
    const registry = createDefaultRegistry();
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 's1',
      readings: { temperature: 22, nitrate: 0.5 },
    };

    const result = registry.upcast(v1);

    expect(result['version']).toBe(3);
    expect(result['readingTemperature']).toBe(22);
    expect(result['readingNitrate']).toBe(0.5);
    expect(result['readings']).toBeUndefined();
  });
});

describe('SensorReading upcaster edge cases', () => {
  let registry: EventUpcasterRegistry;

  beforeEach(() => {
    registry = createDefaultRegistry();
  });

  it('should bump v2 → v3 (Scope B Phase S1.1 federation correlation fields)', () => {
    // v2 → v3 is an identity transform on payload — only `version`
    // increments. The new optional fields (tankId, parameter, unit,
    // relatedWaterQualityMeasurementId) are absent on legacy v2
    // events; consumers tolerate their absence.
    const v2 = {
      eventType: 'SensorReading',
      version: 2,
      sensorId: 's1',
      readingTemperature: 25,
    };

    const result = registry.upcast(v2);

    expect(result['version']).toBe(3);
    expect(result['readingTemperature']).toBe(25);
    expect(result['sensorId']).toBe('s1');
    // No double-processing artefacts from the v1→v2 stage
    expect(result['readings']).toBeUndefined();
    // No spurious v3 fields injected
    expect(result['tankId']).toBeUndefined();
    expect(result['parameter']).toBeUndefined();
    expect(result['unit']).toBeUndefined();
    expect(result['relatedWaterQualityMeasurementId']).toBeUndefined();
  });

  it('should not re-upcast an event already at version 3 (latest)', () => {
    const v3 = {
      eventType: 'SensorReading',
      version: 3,
      sensorId: 's1',
      readingTemperature: 25,
      tankId: 'tank-1',
      parameter: 'temperature',
      unit: '°C',
    };

    const result = registry.upcast(v3);

    expect(result).toEqual(v3);
  });

  it('should chain v1 → v2 → v3 in one upcast call', () => {
    // A legacy v1 event from JetStream must reach the latest v3
    // shape after a SINGLE registry.upcast() call — the chained
    // upcaster registry handles the multi-step walk.
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 's-legacy',
      farmId: 'f-legacy',
      readings: { temperature: 18.5, ph: 7.0 },
    };

    const result = registry.upcast(v1);

    expect(result['version']).toBe(3);
    // v1→v2: nested readings flattened
    expect(result['readingTemperature']).toBe(18.5);
    expect(result['readingPh']).toBe(7.0);
    expect(result['readings']).toBeUndefined();
    // v2→v3: identity (no spurious fields)
    expect(result['tankId']).toBeUndefined();
    // Surrounding fields preserved through both steps
    expect(result['sensorId']).toBe('s-legacy');
    expect(result['farmId']).toBe('f-legacy');
  });

  it('preserves the new v3 federation fields when present at v2 reception', () => {
    // Edge case: a v3 producer's payload arrives stamped as
    // `version: 2` (a misconfigured-producer scenario). The v2→v3
    // upcaster bumps the version but DOES NOT strip the v3 fields
    // already populated — additive optional semantics. This test
    // pins the "no-op identity" property of the v2→v3 upcaster
    // beyond the version bump.
    const partial = {
      eventType: 'SensorReading',
      version: 2,
      sensorId: 's1',
      readingTemperature: 25,
      tankId: 'tank-1',
      parameter: 'temperature',
      unit: '°C',
      relatedWaterQualityMeasurementId: 'wq-1',
    };

    const result = registry.upcast(partial);

    expect(result['version']).toBe(3);
    expect(result['tankId']).toBe('tank-1');
    expect(result['parameter']).toBe('temperature');
    expect(result['unit']).toBe('°C');
    expect(result['relatedWaterQualityMeasurementId']).toBe('wq-1');
  });

  it('should handle an unexpected version number higher than target', () => {
    const v99 = {
      eventType: 'SensorReading',
      version: 99,
      sensorId: 's1',
      readingTemperature: 30,
    };

    const result = registry.upcast(v99);

    // Should pass through unchanged — no upcaster matches fromVersion: 99
    expect(result['version']).toBe(99);
    expect(result['readingTemperature']).toBe(30);
  });

  it('should handle v1 event with non-object readings value gracefully', () => {
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 's1',
      readings: 'not-an-object' as unknown,
    };

    const result = sensorReadingUpcaster.upcast(v1 as Record<string, unknown>);

    expect(result['version']).toBe(2);
    // Non-object readings should be treated as missing
    expect(result['readingTemperature']).toBeUndefined();
  });

  it('should handle v1 event with null readings value', () => {
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 's1',
      readings: null,
    };

    const result = sensorReadingUpcaster.upcast(v1 as Record<string, unknown>);

    expect(result['version']).toBe(2);
  });

  it('should preserve extra fields not in READING_FIELD_MAP', () => {
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 's1',
      farmId: 'f1',
      tenantId: 't1',
      correlationId: 'c1',
      readings: { temperature: 20 },
    };

    const result = sensorReadingUpcaster.upcast(v1);

    expect(result['sensorId']).toBe('s1');
    expect(result['farmId']).toBe('f1');
    expect(result['tenantId']).toBe('t1');
    expect(result['correlationId']).toBe('c1');
  });
});

describe('AlertTriggered upcaster edge cases', () => {
  let registry: EventUpcasterRegistry;

  beforeEach(() => {
    registry = createDefaultRegistry();
  });

  it('should not re-upcast an event already at version 2', () => {
    const v2 = {
      eventType: 'AlertTriggered',
      version: 2,
      alertId: 'a1',
      triggerSensorId: 's1',
    };

    const result = registry.upcast(v2);

    expect(result['version']).toBe(2);
    expect(result['triggerSensorId']).toBe('s1');
    expect(result['triggeringData']).toBeUndefined();
  });

  it('should handle an unexpected version number higher than target', () => {
    const v99 = {
      eventType: 'AlertTriggered',
      version: 99,
      alertId: 'a1',
      triggerSensorId: 's1',
    };

    const result = registry.upcast(v99);

    expect(result['version']).toBe(99);
  });

  it('should handle v1 event with non-object triggeringData gracefully', () => {
    const v1 = {
      eventType: 'AlertTriggered',
      version: 1,
      alertId: 'a1',
      triggeringData: 42 as unknown,
    };

    const result = alertTriggeredUpcaster.upcast(v1 as Record<string, unknown>);

    expect(result['version']).toBe(2);
    expect(result['triggerSensorId']).toBeUndefined();
  });

  it('should handle v1 event with null triggeringData', () => {
    const v1 = {
      eventType: 'AlertTriggered',
      version: 1,
      alertId: 'a1',
      triggeringData: null,
    };

    const result = alertTriggeredUpcaster.upcast(v1 as Record<string, unknown>);

    expect(result['version']).toBe(2);
  });
});

describe('EventUpcasterRegistry edge cases', () => {
  it('should handle event with version 0', () => {
    const registry = createDefaultRegistry();
    const event = { eventType: 'SensorReading', version: 0, sensorId: 's1' };

    const result = registry.upcast(event);

    // Version 0 does not match any registered upcaster (fromVersion: 1), so pass-through
    expect(result['version']).toBe(0);
  });

  it('should handle event with negative version', () => {
    const registry = createDefaultRegistry();
    const event = { eventType: 'SensorReading', version: -1, sensorId: 's1' };

    const result = registry.upcast(event);

    expect(result['version']).toBe(-1);
  });

  it('should handle event with missing version field (defaults to 1, walks chain to v3)', () => {
    // Missing `version` defaults to 1 in the registry, which lights
    // up the v1→v2 upcaster; the v2→v3 (Scope B Phase S1.1) then
    // bumps it the rest of the way.
    const registry = createDefaultRegistry();
    const event: Record<string, unknown> = {
      eventType: 'SensorReading',
      sensorId: 's1',
      readings: { temperature: 22 },
    };

    const result = registry.upcast(event);

    expect(result['version']).toBe(3);
    expect(result['readingTemperature']).toBe(22);
  });
});

describe('AlertTriggered v1→v2 upcaster', () => {
  it('should flatten triggeringData object to flat fields', () => {
    const v1 = {
      eventType: 'AlertTriggered',
      version: 1,
      alertId: 'alert-1',
      ruleId: 'rule-1',
      triggeringData: {
        sensorId: 'sensor-1',
        farmId: 'farm-1',
        pondId: 'pond-1',
        parameter: 'temperature',
        value: 35,
        threshold: 30,
      },
    };

    const v2 = alertTriggeredUpcaster.upcast(v1);

    expect(v2['version']).toBe(2);
    expect(v2['triggerSensorId']).toBe('sensor-1');
    expect(v2['triggerFarmId']).toBe('farm-1');
    expect(v2['triggerPondId']).toBe('pond-1');
    expect(v2['triggerParameter']).toBe('temperature');
    expect(v2['triggerValue']).toBe(35);
    expect(v2['triggerThreshold']).toBe(30);
    expect(v2['triggeringData']).toBeUndefined();
  });

  it('should handle missing triggeringData', () => {
    const v1 = {
      eventType: 'AlertTriggered',
      version: 1,
      alertId: 'alert-1',
    };

    const v2 = alertTriggeredUpcaster.upcast(v1);

    expect(v2['version']).toBe(2);
    expect(v2['triggeringData']).toBeUndefined();
  });

  it('should round-trip through registry', () => {
    const registry = createDefaultRegistry();
    const v1 = {
      eventType: 'AlertTriggered',
      version: 1,
      alertId: 'a1',
      triggeringData: { sensorId: 's1', value: 99 },
    };

    const result = registry.upcast(v1);

    expect(result['version']).toBe(2);
    expect(result['triggerSensorId']).toBe('s1');
    expect(result['triggerValue']).toBe(99);
    expect(result['triggeringData']).toBeUndefined();
  });
});

describe('createTimestampUpcaster factory', () => {
  it('returns an upcaster with the requested eventType + version pair', () => {
    const upcaster = createTimestampUpcaster('BatchStatusChanged', 1, 2);
    expect(upcaster.eventType).toBe('BatchStatusChanged');
    expect(upcaster.fromVersion).toBe(1);
    expect(upcaster.toVersion).toBe(2);
  });

  it('normalises Date timestamp → ISO 8601 string and bumps version', () => {
    const upcaster = createTimestampUpcaster('ModuleRemovedFromTenant', 1, 2);
    const v1 = {
      eventType: 'ModuleRemovedFromTenant',
      version: 1,
      tenantId: 't1',
      timestamp: new Date('2026-04-17T12:34:56.000Z'),
    };
    const v2 = upcaster.upcast(v1);
    expect(v2['version']).toBe(2);
    expect(v2['timestamp']).toBe('2026-04-17T12:34:56.000Z');
  });

  it('normalises numeric (epoch ms) timestamp → ISO 8601 string', () => {
    const upcaster = createTimestampUpcaster('SensorCalibrated', 1, 2);
    const epoch = Date.UTC(2026, 3, 17, 12, 34, 56); // month is 0-indexed
    const v1 = {
      eventType: 'SensorCalibrated',
      version: 1,
      sensorId: 's1',
      timestamp: epoch,
    };
    const v2 = upcaster.upcast(v1);
    expect(v2['version']).toBe(2);
    expect(v2['timestamp']).toBe(new Date(epoch).toISOString());
  });

  it('passes through a timestamp already stored as ISO 8601 string', () => {
    const upcaster = createTimestampUpcaster('AlertEscalated', 1, 2);
    const iso = '2026-04-17T08:00:00.000Z';
    const v1 = {
      eventType: 'AlertEscalated',
      version: 1,
      alertId: 'a1',
      timestamp: iso,
    };
    const v2 = upcaster.upcast(v1);
    expect(v2['version']).toBe(2);
    expect(v2['timestamp']).toBe(iso);
  });

  it('preserves non-timestamp fields unchanged', () => {
    const upcaster = createTimestampUpcaster('BatchStatusChanged', 1, 2);
    const v1 = {
      eventType: 'BatchStatusChanged',
      version: 1,
      batchId: 'b-42',
      status: 'HARVESTED',
      tenantId: 'tenant-xyz',
      timestamp: new Date('2026-04-17T00:00:00.000Z'),
    };
    const v2 = upcaster.upcast(v1);
    expect(v2['batchId']).toBe('b-42');
    expect(v2['status']).toBe('HARVESTED');
    expect(v2['tenantId']).toBe('tenant-xyz');
  });
});

describe('BatchHarvested v1→v2 upcaster (arbiter B2 — identity, additive isFinal)', () => {
  it('is an identity upcaster: bumps version only, preserves every field', () => {
    const v1 = {
      eventType: 'BatchHarvested',
      version: 1,
      eventId: 'evt-1',
      tenantId: 'tenant-xyz',
      batchId: 'b-42',
      harvestedQuantity: 1000,
      harvestedAt: '2026-06-12T00:00:00.000Z',
      averageWeight: 0.45,
      totalWeight: 450,
    };

    const v2 = batchHarvestedUpcaster.upcast({ ...v1 });

    expect(v2['version']).toBe(2);
    // No isFinal fabricated — finality is unknown for a v1 event.
    expect(v2['isFinal']).toBeUndefined();
    // Every original field preserved (incl. branded eventId).
    expect(v2['eventId']).toBe('evt-1');
    expect(v2['batchId']).toBe('b-42');
    expect(v2['harvestedQuantity']).toBe(1000);
    expect(v2['tenantId']).toBe('tenant-xyz');
    expect(v2['totalWeight']).toBe(450);
  });

  it('preserves an already-present isFinal (no overwrite)', () => {
    const v2in = {
      eventType: 'BatchHarvested',
      version: 1,
      batchId: 'b-43',
      isFinal: true,
    };
    const out = batchHarvestedUpcaster.upcast(v2in);
    expect(out['version']).toBe(2);
    expect(out['isFinal']).toBe(true);
  });

  it('declares the contiguous 1→2 step the chain invariant requires', () => {
    expect(batchHarvestedUpcaster.eventType).toBe('BatchHarvested');
    expect(batchHarvestedUpcaster.fromVersion).toBe(1);
    expect(batchHarvestedUpcaster.toVersion).toBe(2);
  });

  it('round-trips through the default registry', () => {
    const registry = createDefaultRegistry();
    const out = registry.upcast({
      eventType: 'BatchHarvested',
      version: 1,
      batchId: 'b-44',
      harvestedQuantity: 5,
      harvestedAt: '2026-06-12T00:00:00.000Z',
    });
    expect(out['version']).toBe(2);
    expect(out['batchId']).toBe('b-44');
  });
});
