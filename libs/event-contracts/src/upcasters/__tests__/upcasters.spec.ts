import { EventUpcasterRegistry, createDefaultRegistry } from '../index';
import { sensorReadingUpcaster } from '../sensor-reading.upcaster';
import { alertTriggeredUpcaster } from '../alert-triggered.upcaster';

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
    const event = { eventType: 'SensorReading', version: 2, sensorId: 's1', readingTemperature: 25 };
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

  it('should round-trip through registry', () => {
    const registry = createDefaultRegistry();
    const v1 = {
      eventType: 'SensorReading',
      version: 1,
      sensorId: 's1',
      readings: { temperature: 22, nitrate: 0.5 },
    };

    const result = registry.upcast(v1);

    expect(result['version']).toBe(2);
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

  it('should not re-upcast an event already at version 2', () => {
    const v2 = {
      eventType: 'SensorReading',
      version: 2,
      sensorId: 's1',
      readingTemperature: 25,
    };

    const result = registry.upcast(v2);

    expect(result['version']).toBe(2);
    expect(result['readingTemperature']).toBe(25);
    // Ensure no double-processing artifacts
    expect(result['readings']).toBeUndefined();
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

  it('should handle event with missing version field (defaults to 1)', () => {
    const registry = createDefaultRegistry();
    const event: Record<string, unknown> = {
      eventType: 'SensorReading',
      sensorId: 's1',
      readings: { temperature: 22 },
    };

    const result = registry.upcast(event);

    // Missing version defaults to 1 in the registry, which matches the v1->v2 upcaster
    expect(result['version']).toBe(2);
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
