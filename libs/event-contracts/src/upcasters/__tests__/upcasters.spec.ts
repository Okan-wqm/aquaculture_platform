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
