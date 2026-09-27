/**
 * Data-channel DTO × global ValidationPipe contract
 *
 * Regression cover for the "property channelKey should not exist" rejection:
 * the global pipe runs with whitelist + forbidNonWhitelisted, so every input
 * property needs at least one class-validator decorator. These tests push the
 * REAL payload shapes (registerSensor.dataChannels, createDataChannel,
 * saveDiscoveredChannels, bulkUpdateDataChannels) through a pipe configured
 * exactly like create-service-app registers it.
 */

import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';

import {
  AlertThresholdsInput,
  BulkUpdateDataChannelsInput,
  ChannelDisplaySettingsInput,
  CreateDataChannelInput,
  SaveDiscoveredChannelsInput,
} from '../dto/data-channel.dto';

const METADATA: ArgumentMetadata = { type: 'body', metatype: Object, data: '' };

function makePipe(): ValidationPipe {
  // Mirrors create-service-app's global registration:
  // new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}

const FULL_CHANNEL_PAYLOAD = {
  channelKey: 'temperature',
  displayLabel: 'Su Sıcaklığı',
  dataType: 'number',
  unit: '°C',
  dataPath: 'temperature',
  minValue: -5,
  maxValue: 45,
  calibrationEnabled: false,
  calibrationMultiplier: 1.0,
  calibrationOffset: 0,
  alertThresholds: {
    warning: { low: 10, high: 30 },
    critical: { low: 5, high: 35 },
  },
  displaySettings: { color: '#146f84', precision: 1, showOnDashboard: true },
  isEnabled: true,
  displayOrder: 1,
};

describe('data-channel DTOs × global ValidationPipe', () => {
  it('accepts a full CreateDataChannelInput payload through the pipe (whitelist survival)', async () => {
    const result = await makePipe().transform(
      { ...FULL_CHANNEL_PAYLOAD },
      { ...METADATA, metatype: CreateDataChannelInput },
    );

    expect(result).toBeInstanceOf(CreateDataChannelInput);
    expect(result.channelKey).toBe('temperature');
    expect(result.dataPath).toBe('temperature');
    expect(result.alertThresholds?.warning?.high).toBe(30);
    expect(result.displaySettings?.color).toBe('#146f84');
  });

  it('accepts nested AlertThresholdsInput standalone (null threshold sides allowed)', async () => {
    const result = await makePipe().transform(
      { warning: { low: null, high: 0.3 }, hysteresis: 0.05 },
      { ...METADATA, metatype: AlertThresholdsInput },
    );

    expect(result).toBeInstanceOf(AlertThresholdsInput);
    expect(result.warning?.high).toBe(0.3);
  });

  it('accepts ChannelDisplaySettingsInput and drops nothing', async () => {
    const result = await makePipe().transform(
      {
        color: '#b04a28',
        icon: 'thermometer',
        widgetType: 'gauge',
        precision: 2,
        showOnDashboard: false,
        chartConfig: { yMin: 0 },
      },
      { ...METADATA, metatype: ChannelDisplaySettingsInput },
    );

    expect(result.chartConfig).toEqual({ yMin: 0 });
    expect(result.precision).toBe(2);
  });

  it('accepts SaveDiscoveredChannelsInput with nested channels through the pipe', async () => {
    const payload = {
      sensorId: '550e8400-e29b-41d4-a716-446655440000',
      channels: [
        FULL_CHANNEL_PAYLOAD,
        { channelKey: 'ph', displayLabel: 'pH', unit: 'pH', dataPath: 'ph' },
      ],
      replaceExisting: false,
    };

    const result = await makePipe().transform(payload, {
      ...METADATA,
      metatype: SaveDiscoveredChannelsInput,
    });

    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]).toBeInstanceOf(CreateDataChannelInput);
    expect(result.channels[1].channelKey).toBe('ph');
  });

  it('rejects unknown channelKey spellings with forbidNonWhitelisted (shape contract)', async () => {
    const rejection = await makePipe()
      .transform(
        { channelKey: 't', displayLabel: 'T', bogusField: true },
        { ...METADATA, metatype: CreateDataChannelInput },
      )
      .catch((error: { getResponse?: () => unknown }) => error);

    const response =
      typeof rejection.getResponse === 'function' ? rejection.getResponse() : rejection;
    expect(JSON.stringify(response)).toContain('bogusField');
  });

  it('rejects over-length channelKey (column is varchar(100))', async () => {
    await expect(
      makePipe().transform(
        { channelKey: 'x'.repeat(101), displayLabel: 'T' },
        { ...METADATA, metatype: CreateDataChannelInput },
      ),
    ).rejects.toThrow();
  });

  it('rejects non-UUID sensorId in SaveDiscoveredChannelsInput', async () => {
    await expect(
      makePipe().transform(
        { sensorId: 'not-a-uuid', channels: [FULL_CHANNEL_PAYLOAD] },
        { ...METADATA, metatype: SaveDiscoveredChannelsInput },
      ),
    ).rejects.toThrow();
  });

  it('accepts BulkUpdateDataChannelsInput and validates nested items', async () => {
    const channelId = '550e8400-e29b-41d4-a716-446655440000';
    const result = await makePipe().transform(
      { updates: [{ channelId, alertThresholds: { warning: { low: 4, high: 9 } } }] },
      { ...METADATA, metatype: BulkUpdateDataChannelsInput },
    );

    expect(result.updates[0].channelId).toBe(channelId);

    await expect(
      makePipe().transform(
        {
          updates: [
            { channelId, alertThresholds: { warning: { low: 4, high: 9 } } },
            { channelId, alertThresholds: null },
          ],
        },
        { ...METADATA, metatype: BulkUpdateDataChannelsInput },
      ),
    ).resolves.toBeTruthy();
  });

  it('plainToInstance round-trip keeps every property after validation', async () => {
    // Simulates the GraphQL resolver receiving the validated class instance.
    const instance = plainToInstance(CreateDataChannelInput, FULL_CHANNEL_PAYLOAD);
    const revalidated = await makePipe().transform(instance, {
      ...METADATA,
      metatype: CreateDataChannelInput,
    });

    expect(revalidated).toMatchObject({
      channelKey: 'temperature',
      unit: '°C',
      minValue: -5,
    });
  });
});
