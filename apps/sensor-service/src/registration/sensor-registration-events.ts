import {
  createBaseEvent,
  type SensorRegisteredEvent,
  type SensorRegistrationCompletedEvent,
  type SensorRegistrationStartedEvent,
} from '@platform/event-contracts';

import type { Sensor } from '../database/entities/sensor.entity';

/**
 * The registration lifecycle events (SENSOR-LOW-007), built in one place for
 * every path that ends a stage of it: the registration service, and — for a
 * sensor holding its own broker principal — the first data it sends
 * (ADR-047 §5). Flat contract shape through createBaseEvent.
 */

export function registrationStartedEvent(
  sensor: Sensor,
  protocolCode: string,
): SensorRegistrationStartedEvent {
  return {
    ...createBaseEvent<SensorRegistrationStartedEvent>(
      'SensorRegistrationStarted',
      sensor.tenantId,
      {
        aggregateId: sensor.id,
        aggregateType: 'Sensor',
      },
    ),
    sensorId: sensor.id,
    sensorName: sensor.name,
    protocolCode,
  };
}

export function sensorRegisteredEvent(sensor: Sensor): SensorRegisteredEvent {
  return {
    ...createBaseEvent<SensorRegisteredEvent>('SensorRegistered', sensor.tenantId, {
      aggregateId: sensor.id,
      aggregateType: 'Sensor',
    }),
    sensorId: sensor.id,
    farmId: sensor.farmId ?? undefined,
    pondId: sensor.pondId ?? undefined,
    sensorType: sensor.type,
    manufacturer: sensor.manufacturer,
    model: sensor.model,
  };
}

/**
 * `connectionTestPassed` is true when a cloud-initiated test passed, the
 * operator skipped the test, or — for a sensor holding its own broker
 * principal — data arrived over the issued identity.
 */
export function registrationCompletedEvent(
  sensor: Sensor,
  protocolCode: string,
  connectionTestPassed: boolean,
): SensorRegistrationCompletedEvent {
  return {
    ...createBaseEvent<SensorRegistrationCompletedEvent>(
      'SensorRegistrationCompleted',
      sensor.tenantId,
      { aggregateId: sensor.id, aggregateType: 'Sensor' },
    ),
    sensorId: sensor.id,
    sensorName: sensor.name,
    protocolCode,
    farmId: sensor.farmId ?? undefined,
    pondId: sensor.pondId ?? undefined,
    connectionTestPassed,
  };
}
