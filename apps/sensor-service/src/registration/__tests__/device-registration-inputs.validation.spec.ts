/**
 * Device-registration inputs × global ValidationPipe (SENSOR-HIGH-141)
 *
 * The global pipe runs with whitelist + forbidNonWhitelisted, so an input
 * property without a class-validator decorator is rejected as "should not
 * exist". The add-device wizard's children carry alertThresholds and
 * displaySettings, whose nested input classes had no decorators; the sensor
 * edit mutations and every edge-device / IO-config input had none at all.
 * Each payload below is the shape the sensor-module UI sends; GraphQL has
 * already coerced enums to their internal values by the time the pipe runs.
 */

import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';

import { SensorType } from '../../database/entities/sensor.entity';
import { IoDataType, IoType } from '../../edge-device/entities/device-io-config.entity';
import { DeviceModel } from '../../edge-device/entities/edge-device.entity';
import {
  AddIoConfigInput,
  RegisterEdgeDeviceInput,
  UpdateEdgeDeviceInput,
  UpdateIoConfigInput,
} from '../../edge-device/dto/edge-device.dto';
import {
  RegisterParentWithChildrenInput,
  UpdateSensorInfoInput,
  UpdateSensorProtocolInput,
} from '../dto/register-sensor.dto';

const SENSOR_ID = 'f0b8b1a6-df19-42de-ba9a-8523c949ea65';
const SITE_ID = '3a1c9a4e-8d6f-4f8e-9c1a-2b7d5e6f7a8b';

function pipe(): ValidationPipe {
  // Mirrors create-service-app / sensor-service main.ts.
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  });
}

function through(metatype: ArgumentMetadata['metatype'], payload: object): Promise<unknown> {
  return pipe().transform(payload, { type: 'body', metatype, data: '' });
}

describe('device-registration inputs × global ValidationPipe (SENSOR-HIGH-141)', () => {
  it('accepts the wizard payload with child alert thresholds and display settings', async () => {
    await expect(
      through(RegisterParentWithChildrenInput, {
        parent: {
          name: 'WT-CODEX-01',
          protocolCode: 'MQTT',
          protocolConfiguration: { topic: 'sensors/codex-test/water-temp-01', qos: 1 },
          siteId: SITE_ID,
        },
        children: [
          {
            name: 'WT-CODEX-01 - Amonyak',
            type: SensorType.AMMONIA,
            dataPath: 'ammonia',
            unit: 'mg/L',
            minValue: 0,
            maxValue: 1,
            alertThresholds: {
              warning: { low: null, high: 0.3 },
              critical: { low: null, high: 1 },
            },
            displaySettings: {
              showOnDashboard: true,
              widgetType: 'gauge',
              color: '#b04a28',
              sortOrder: 5,
              decimalPlaces: 3,
            },
          },
        ],
        skipConnectionTest: true,
      }),
    ).resolves.toBeInstanceOf(RegisterParentWithChildrenInput);
  });

  it('rejects an unknown nested threshold key instead of silently storing it', async () => {
    await expect(
      through(RegisterParentWithChildrenInput, {
        parent: { name: 'x', protocolCode: 'MQTT', protocolConfiguration: {} },
        children: [
          {
            name: 'x',
            type: SensorType.PH,
            dataPath: 'ph',
            alertThresholds: { warning: { low: 7, high: 8.5, criticalLow: 6 } },
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('accepts the sensor edit mutations (updateSensorProtocol / updateSensorInfo)', async () => {
    await expect(
      through(UpdateSensorProtocolInput, {
        sensorId: SENSOR_ID,
        protocolCode: 'MQTT',
        protocolConfiguration: { topic: 'sensors/codex-test/water-temp-02' },
      }),
    ).resolves.toBeInstanceOf(UpdateSensorProtocolInput);
    await expect(
      through(UpdateSensorInfoInput, {
        sensorId: SENSOR_ID,
        name: 'WT-CODEX-01',
        type: SensorType.MULTI_PARAMETER,
        manufacturer: 'Codex',
        siteId: SITE_ID,
        location: 'Havuz 3',
        metadata: { note: 'kalibrasyon 2026-10' },
      }),
    ).resolves.toBeInstanceOf(UpdateSensorInfoInput);
  });

  it('accepts edge-device registration and update', async () => {
    await expect(
      through(RegisterEdgeDeviceInput, {
        siteId: SITE_ID,
        deviceCode: 'EDGE-POND-01',
        deviceName: 'Havuz ağ geçidi',
        deviceModel: DeviceModel.RASPBERRY_PI_5,
        serialNumber: 'RPI5-0001',
        timezone: 'Europe/Istanbul',
      }),
    ).resolves.toBeInstanceOf(RegisterEdgeDeviceInput);
    await expect(
      through(UpdateEdgeDeviceInput, {
        deviceName: 'Havuz ağ geçidi',
        scanRateMs: 1000,
        config: { mqtt: { qos: 1 } },
        capabilities: { modbus: true },
        tags: ['havuz-3'],
      }),
    ).resolves.toBeInstanceOf(UpdateEdgeDeviceInput);
  });

  it('accepts IO-config create and update', async () => {
    await expect(
      through(AddIoConfigInput, {
        tagName: 'do_probe',
        ioType: IoType.AI,
        dataType: IoDataType.FLOAT32,
        moduleAddress: 1,
        channel: 0,
        rawMin: 4,
        rawMax: 20,
        engMin: 0,
        engMax: 20,
        engUnit: 'mg/L',
        modbusFunction: 3,
        modbusSlaveId: 1,
        modbusRegister: 40001,
        invertValue: false,
        alarmL: 4.5,
        alarmLL: 3,
        deadband: 0.1,
      }),
    ).resolves.toBeInstanceOf(AddIoConfigInput);
    await expect(
      through(UpdateIoConfigInput, { description: 'DO', alarmH: 11, isActive: true }),
    ).resolves.toBeInstanceOf(UpdateIoConfigInput);
  });
});
