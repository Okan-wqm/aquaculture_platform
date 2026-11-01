import { SENSOR_MQTT_IDENTITY_ERROR } from '@aquaculture/shared-contracts';
import { collaborator } from '@aquaculture/testing';
import { BadRequestException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { OutboxPublisher } from '@platform/outbox';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import { Sensor, SensorRegistrationStatus } from '../../database/entities/sensor.entity';
import type { SensorProtocol } from '../../database/entities/sensor-protocol.entity';
import type { SensorMqttIdentityService } from '../../mqtt-identity/sensor-mqtt-identity.service';
import type { ConnectionTesterService } from '../../protocol/services/connection-tester.service';
import type { ProtocolRegistryService } from '../../protocol/services/protocol-registry.service';
import type { ProtocolValidatorService } from '../../protocol/services/protocol-validator.service';
import type { SensorTypeService } from '../../sensor-type/sensor-type.service';
import type { ChannelManagementService } from '../services/channel-management.service';
import type { SensorPlacementService } from '../services/sensor-placement.service';
import { SensorRegistrationService } from '../services/sensor-registration.service';

/**
 * ADR-047 §5, §6: a sensor its data activates (MQTT on the platform broker)
 * is never tested from the cloud or activated by hand; suspending it
 * withdraws its broker credential in the same transaction; reactivating it
 * returns it to DRAFT with no credential and no test; a protocol update leaves
 * its status as its data left it.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
const SENSOR = 'f0b8b1a6-df19-42de-ba9a-8523c949ea65';

function sensorOf(status: SensorRegistrationStatus, code = 'MQTT'): Sensor {
  return Object.assign(new Sensor(), {
    id: SENSOR,
    tenantId: TENANT,
    name: 'Codex probe',
    registrationStatus: status,
    isActive: status === SensorRegistrationStatus.ACTIVE,
    protocol: Object.assign({} as Partial<SensorProtocol>, { code }),
    protocolConfiguration: {},
    connectionStatus: { isConnected: false },
  });
}

function build(sensor: Sensor): {
  service: SensorRegistrationService;
  save: jest.Mock;
  revoke: jest.Mock;
  testConnection: jest.Mock;
  managerSave: jest.Mock;
} {
  // Untyped so they stand in for TypeORM's overloaded save; each echoes the row.
  const save = jest.fn();
  save.mockImplementation((row: Sensor) => Promise.resolve(row));
  const managerSave = jest.fn();
  managerSave.mockImplementation((_entity: unknown, row: Sensor) => Promise.resolve(row));
  const manager = collaborator<EntityManager>({ save: managerSave }, 'EntityManager');
  const transaction = jest.fn();
  transaction.mockImplementation((work: (m: EntityManager) => Promise<unknown>) => work(manager));
  const revoke = jest.fn().mockResolvedValue(undefined);
  const testConnection = jest.fn();
  const service = new SensorRegistrationService(
    collaborator<Repository<Sensor>>(
      { findOne: jest.fn().mockResolvedValue(sensor), save },
      'SensorRepository',
    ),
    collaborator<DataSource>({ transaction }, 'DataSource'),
    collaborator<ProtocolRegistryService>({}, 'ProtocolRegistryService'),
    collaborator<ProtocolValidatorService>(
      { validate: jest.fn().mockReturnValue({ isValid: true, errors: [], warnings: [] }) },
      'ProtocolValidatorService',
    ),
    collaborator<ConnectionTesterService>({ testConnection }, 'ConnectionTesterService'),
    collaborator<EventEmitter2>({ emit: jest.fn() }, 'EventEmitter2'),
    collaborator<ChannelManagementService>({}, 'ChannelManagementService'),
    collaborator<SensorTypeService>({}, 'SensorTypeService'),
    collaborator<OutboxPublisher>({}, 'OutboxPublisher'),
    collaborator<SensorPlacementService>({}, 'SensorPlacementService'),
    collaborator<SensorMqttIdentityService>({ revoke }, 'SensorMqttIdentityService'),
  );
  return { service, save, revoke, testConnection, managerSave };
}

async function refusalCode(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof BadRequestException)) {
    throw new Error(`expected a refusal, got ${String(error)}`);
  }
  return (error.getResponse() as { code?: unknown }).code;
}

describe('the lifecycle of a sensor its data activates (ADR-047)', () => {
  it('is never tested from the cloud, and its status is left alone', async () => {
    const { service, save, testConnection } = build(sensorOf(SensorRegistrationStatus.DRAFT));
    await expect(refusalCode(service.testSensorConnection(SENSOR, TENANT))).resolves.toBe(
      SENSOR_MQTT_IDENTITY_ERROR.ACTIVATED_BY_DATA,
    );
    expect(testConnection).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('is never activated by hand', async () => {
    const { service, save } = build(sensorOf(SensorRegistrationStatus.TEST_FAILED));
    await expect(refusalCode(service.activateSensor(SENSOR, TENANT))).resolves.toBe(
      SENSOR_MQTT_IDENTITY_ERROR.ACTIVATED_BY_DATA,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('loses its broker credential in the transaction that suspends it', async () => {
    const { service, revoke, managerSave } = build(sensorOf(SensorRegistrationStatus.ACTIVE));
    const suspended = await service.suspendSensor(SENSOR, TENANT, 'leaked', 'operator-1');

    expect(suspended.registrationStatus).toBe(SensorRegistrationStatus.SUSPENDED);
    expect(managerSave).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(expect.anything(), TENANT, SENSOR, 'operator-1');
  });

  it('returns to DRAFT on reactivation, with no test and no credential', async () => {
    const { service, testConnection } = build(sensorOf(SensorRegistrationStatus.SUSPENDED));
    const reactivated = await service.reactivateSensor(SENSOR, TENANT);

    expect(reactivated).toMatchObject({
      registrationStatus: SensorRegistrationStatus.DRAFT,
      isActive: false,
    });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('keeps its status through a protocol configuration update', async () => {
    const { service } = build(sensorOf(SensorRegistrationStatus.ACTIVE));
    const result = await service.updateProtocolConfig(
      { sensorId: SENSOR, protocolConfiguration: { payloadFormat: 'json' } },
      TENANT,
    );
    expect(result.sensor?.registrationStatus).toBe(SensorRegistrationStatus.ACTIVE);
  });

  it('still tests a sensor the cloud can reach', async () => {
    const { service, testConnection } = build(
      sensorOf(SensorRegistrationStatus.DRAFT, 'MODBUS_TCP'),
    );
    testConnection.mockResolvedValue({ success: true, latencyMs: 3 });
    await expect(service.testSensorConnection(SENSOR, TENANT)).resolves.toMatchObject({
      success: true,
    });
    expect(testConnection).toHaveBeenCalledTimes(1);
  });
});
