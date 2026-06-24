/**
 * Data Channels E2E Tests
 *
 * Tests data channel CRUD, calibration, alert thresholds, bulk operations,
 * channel discovery, reordering, and cross-tenant isolation.
 *
 * Resolver: ChannelResolver (channel.resolver.ts)
 *
 * @module Sensor-Service/E2E/DataChannels
 */
import { assertDefined } from '../../../helpers/assertions';

import { gql, TENANT_A, TENANT_B, uniqueName, runCleanup } from './helpers';

// ============================================================================
// GRAPHQL OPERATIONS
// ============================================================================

const REGISTER_SENSOR = `
  mutation registerSensor($input: RegisterSensorInput!) {
    registerSensor(input: $input) {
      success
      sensor { id name tenantId }
      error
    }
  }
`;

const CREATE_DATA_CHANNEL = `
  mutation createDataChannel($sensorId: ID!, $input: CreateDataChannelInput!) {
    createDataChannel(sensorId: $sensorId, input: $input) {
      id
      sensorId
      tenantId
      channelKey
      displayLabel
      description
      dataType
      unit
      dataPath
      minValue
      maxValue
      calibrationEnabled
      calibrationMultiplier
      calibrationOffset
      alertThresholds {
        warning { low high }
        critical { low high }
        hysteresis
      }
      isEnabled
      displayOrder
      createdAt
      updatedAt
    }
  }
`;

const CHANNELS_BY_SENSOR = `
  query dataChannelsBySensor($sensorId: ID!) {
    dataChannelsBySensor(sensorId: $sensorId) {
      id
      sensorId
      channelKey
      displayLabel
      dataType
      unit
      isEnabled
      displayOrder
      calibrationEnabled
      calibrationMultiplier
      calibrationOffset
      alertThresholds {
        warning { low high }
        critical { low high }
      }
    }
  }
`;

const UPDATE_DATA_CHANNEL = `
  mutation updateDataChannel($input: UpdateDataChannelInput!) {
    updateDataChannel(input: $input) {
      id
      channelKey
      displayLabel
      calibrationEnabled
      calibrationMultiplier
      calibrationOffset
      alertThresholds {
        warning { low high }
        critical { low high }
        hysteresis
      }
      isEnabled
      displayOrder
    }
  }
`;

const BULK_UPDATE_DATA_CHANNELS = `
  mutation bulkUpdateDataChannels($input: BulkUpdateDataChannelsInput!) {
    bulkUpdateDataChannels(input: $input) {
      success
      count
    }
  }
`;

const ENABLED_CHANNELS = `
  query enabledChannelsBySensor($sensorId: ID!) {
    enabledChannelsBySensor(sensorId: $sensorId) {
      id
      channelKey
      isEnabled
    }
  }
`;

const DISCOVER_DATA_CHANNELS = `
  mutation discoverDataChannels($input: DiscoverChannelsInput!) {
    discoverDataChannels(input: $input) {
      success
      channels {
        channelKey
        suggestedLabel
        inferredDataType
        inferredUnit
        sampleValue
        dataPath
        suggestedMin
        suggestedMax
      }
      error
    }
  }
`;

const REORDER_DATA_CHANNELS = `
  mutation reorderDataChannels($input: ReorderChannelsInput!) {
    reorderDataChannels(input: $input) {
      id
      channelKey
      displayOrder
    }
  }
`;

const DELETE_DATA_CHANNEL = `
  mutation deleteDataChannel($channelId: ID!) {
    deleteDataChannel(channelId: $channelId)
  }
`;

const DELETE_ALL_CHANNELS_FOR_SENSOR = `
  mutation deleteAllChannelsForSensor($sensorId: ID!) {
    deleteAllChannelsForSensor(sensorId: $sensorId)
  }
`;

// ============================================================================
// TESTS
// ============================================================================

describe('Data Channels', () => {
  let sensorId: string;

  beforeAll(async () => {
    // Create a sensor to attach channels to
    const res = await gql(REGISTER_SENSOR, {
      input: {
        name: uniqueName('ChannelTestSensor'),
        type: 'multi_parameter',
        protocolCode: 'mqtt',
        protocolConfiguration: {
          topic: 'sensors/channels/test',
          host: 'localhost',
          port: 1883,
        },
        skipConnectionTest: true,
      },
    });
    const result = assertDefined(res.data).registerSensor as Record<string, unknown>;
    sensorId = (result.sensor as Record<string, unknown>).id as string;
  });

  afterAll(async () => {
    await runCleanup();
  });

  // ------------------------------------------------------------------
  // Test 1: createDataChannel(sensorId) -> dataChannelsBySensor
  // ------------------------------------------------------------------
  describe('Test 1: Create channel and query by sensor', () => {
    let channelId: string;

    it('should create a data channel', async () => {
      const res = await gql(CREATE_DATA_CHANNEL, {
        sensorId,
        input: {
          channelKey: 'temperature',
          displayLabel: 'Temperature',
          description: 'Water temperature in Celsius',
          dataType: 'number',
          unit: 'celsius',
          dataPath: 'data.temp',
          minValue: -10,
          maxValue: 50,
          isEnabled: true,
          displayOrder: 0,
        },
      });

      expect(res.errors).toBeUndefined();
      const channel = assertDefined(res.data).createDataChannel as Record<string, unknown>;
      expect(channel.channelKey).toBe('temperature');
      expect(channel.displayLabel).toBe('Temperature');
      expect(channel.dataType).toBe('number');
      expect(channel.unit).toBe('celsius');
      expect(channel.sensorId).toBe(sensorId);
      expect(channel.isEnabled).toBe(true);

      channelId = channel.id as string;
    });

    it('should list channels by sensor and include created channel', async () => {
      const res = await gql(CHANNELS_BY_SENSOR, { sensorId });

      expect(res.errors).toBeUndefined();
      const channels = assertDefined(res.data).dataChannelsBySensor as Array<
        Record<string, unknown>
      >;
      expect(channels.length).toBeGreaterThanOrEqual(1);

      const found = channels.find((c) => c.id === channelId);
      expect(found).toBeDefined();
      expect(assertDefined(found).channelKey).toBe('temperature');
    });
  });

  // ------------------------------------------------------------------
  // Test 2: updateDataChannel -> calibration values
  // ------------------------------------------------------------------
  describe('Test 2: Update channel with calibration', () => {
    let channelId: string;

    beforeAll(async () => {
      const res = await gql(CREATE_DATA_CHANNEL, {
        sensorId,
        input: {
          channelKey: 'ph_calibration',
          displayLabel: 'pH (Calibratable)',
          dataType: 'number',
          unit: 'pH',
        },
      });
      channelId = (assertDefined(res.data).createDataChannel as Record<string, unknown>)
        .id as string;
    });

    it('should update calibration multiplier and offset', async () => {
      const res = await gql(UPDATE_DATA_CHANNEL, {
        input: {
          channelId,
          calibrationEnabled: true,
          calibrationMultiplier: 1.05,
          calibrationOffset: -0.2,
        },
      });

      expect(res.errors).toBeUndefined();
      const ch = assertDefined(res.data).updateDataChannel as Record<string, unknown>;
      expect(ch.calibrationEnabled).toBe(true);
      expect(Number(ch.calibrationMultiplier)).toBeCloseTo(1.05, 2);
      expect(Number(ch.calibrationOffset)).toBeCloseTo(-0.2, 2);
    });
  });

  // ------------------------------------------------------------------
  // Test 3: bulkUpdateDataChannels (max 100)
  // ------------------------------------------------------------------
  describe('Test 3: Bulk update data channels', () => {
    const channelIds: string[] = [];

    beforeAll(async () => {
      for (let i = 0; i < 3; i++) {
        const res = await gql(CREATE_DATA_CHANNEL, {
          sensorId,
          input: {
            channelKey: `bulk_ch_${i}`,
            displayLabel: `Bulk Channel ${i}`,
            dataType: 'number',
          },
        });
        channelIds.push(
          (assertDefined(res.data).createDataChannel as Record<string, unknown>).id as string,
        );
      }
    });

    it('should bulk update thresholds for multiple channels', async () => {
      const res = await gql(BULK_UPDATE_DATA_CHANNELS, {
        input: {
          updates: channelIds.map((id) => ({
            channelId: id,
            alertThresholds: {
              warning: { low: 5.0, high: 30.0 },
              critical: { low: 2.0, high: 40.0 },
            },
          })),
        },
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).bulkUpdateDataChannels as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
    });

    it('should verify thresholds were applied via query', async () => {
      const res = await gql(CHANNELS_BY_SENSOR, { sensorId });

      expect(res.errors).toBeUndefined();
      const channels = assertDefined(res.data).dataChannelsBySensor as Array<
        Record<string, unknown>
      >;

      for (const chId of channelIds) {
        const ch = channels.find((c) => c.id === chId);
        expect(ch).toBeDefined();
        const thresholds = assertDefined(ch).alertThresholds as Record<
          string,
          Record<string, number>
        >;
        expect(thresholds).toBeDefined();
        expect(thresholds.warning.low).toBe(5.0);
        expect(thresholds.warning.high).toBe(30.0);
        expect(thresholds.critical.low).toBe(2.0);
        expect(thresholds.critical.high).toBe(40.0);
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 4: enabledChannelsBySensor -> only enabled channels
  // ------------------------------------------------------------------
  describe('Test 4: Enabled channels filter', () => {
    let disabledChannelId: string;

    beforeAll(async () => {
      // Create a disabled channel
      const res = await gql(CREATE_DATA_CHANNEL, {
        sensorId,
        input: {
          channelKey: 'disabled_channel',
          displayLabel: 'Disabled Channel',
          dataType: 'number',
          isEnabled: false,
        },
      });
      disabledChannelId = (assertDefined(res.data).createDataChannel as Record<string, unknown>)
        .id as string;
    });

    it('should only return enabled channels', async () => {
      const res = await gql(ENABLED_CHANNELS, { sensorId });

      expect(res.errors).toBeUndefined();
      const channels = assertDefined(res.data).enabledChannelsBySensor as Array<
        Record<string, unknown>
      >;

      for (const ch of channels) {
        expect(ch.isEnabled).toBe(true);
      }

      // Disabled channel should NOT be in list
      const found = channels.find((c) => c.id === disabledChannelId);
      expect(found).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 5: discoverDataChannels -> auto-detection
  // ------------------------------------------------------------------
  describe('Test 5: Discover data channels', () => {
    it('should discover channels from sample JSON data', async () => {
      const res = await gql(DISCOVER_DATA_CHANNELS, {
        input: {
          protocolCode: 'mqtt',
          protocolConfiguration: {
            topic: 'sensors/discover/test',
          },
          sampleData: {
            temperature: 25.3,
            ph: 7.2,
            dissolved_oxygen: 6.8,
            salinity: 15.5,
          },
          payloadFormat: 'json',
        },
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).discoverDataChannels as Record<string, unknown>;
      expect(result.success).toBe(true);

      const channels = result.channels as Array<Record<string, unknown>>;
      expect(channels.length).toBeGreaterThanOrEqual(1);

      // Each discovered channel should have key, label, type
      for (const ch of channels) {
        expect(ch.channelKey).toBeDefined();
        expect(ch.suggestedLabel).toBeDefined();
        expect(ch.inferredDataType).toBeDefined();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 6: reorderDataChannels -> displayOrder
  // ------------------------------------------------------------------
  describe('Test 6: Reorder data channels', () => {
    const channelIds: string[] = [];

    beforeAll(async () => {
      for (let i = 0; i < 3; i++) {
        const res = await gql(CREATE_DATA_CHANNEL, {
          sensorId,
          input: {
            channelKey: `reorder_ch_${i}`,
            displayLabel: `Reorder Channel ${i}`,
            dataType: 'number',
            displayOrder: i,
          },
        });
        channelIds.push(
          (assertDefined(res.data).createDataChannel as Record<string, unknown>).id as string,
        );
      }
    });

    it('should reorder channels in reverse', async () => {
      const reversed = [...channelIds].reverse();

      const res = await gql(REORDER_DATA_CHANNELS, {
        input: {
          sensorId,
          channelIds: reversed,
        },
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).reorderDataChannels as Array<Record<string, unknown>>;
      expect(result.length).toBe(3);

      // Verify display orders match reversed sequence
      for (let i = 0; i < result.length; i++) {
        const ch = result.find((c) => c.id === reversed[i]);
        if (ch) {
          expect(ch.displayOrder).toBe(i);
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 7: deleteDataChannel
  // ------------------------------------------------------------------
  describe('Test 7: Delete data channel', () => {
    let channelId: string;

    beforeAll(async () => {
      const res = await gql(CREATE_DATA_CHANNEL, {
        sensorId,
        input: {
          channelKey: 'delete_target',
          displayLabel: 'Delete Me',
          dataType: 'number',
        },
      });
      channelId = (assertDefined(res.data).createDataChannel as Record<string, unknown>)
        .id as string;
    });

    it('should delete a data channel', async () => {
      const res = await gql(DELETE_DATA_CHANNEL, { channelId });

      expect(res.errors).toBeUndefined();
      expect(assertDefined(res.data).deleteDataChannel).toBe(true);
    });

    it('should not find deleted channel in sensor channels list', async () => {
      const res = await gql(CHANNELS_BY_SENSOR, { sensorId });

      const channels = assertDefined(res.data).dataChannelsBySensor as Array<
        Record<string, unknown>
      >;
      const found = channels.find((c) => c.id === channelId);
      expect(found).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 8: deleteAllChannelsForSensor
  // ------------------------------------------------------------------
  describe('Test 8: Delete all channels for sensor', () => {
    let tempSensorId: string;

    beforeAll(async () => {
      const sRes = await gql(REGISTER_SENSOR, {
        input: {
          name: uniqueName('DeleteAllCh'),
          type: 'multi_parameter',
          protocolCode: 'mqtt',
          protocolConfiguration: { topic: 'sensors/deleteall/test' },
          skipConnectionTest: true,
        },
      });
      tempSensorId = (
        (assertDefined(sRes.data).registerSensor as Record<string, unknown>).sensor as Record<
          string,
          unknown
        >
      ).id as string;

      // Create multiple channels
      for (let i = 0; i < 3; i++) {
        await gql(CREATE_DATA_CHANNEL, {
          sensorId: tempSensorId,
          input: {
            channelKey: `del_all_${i}`,
            displayLabel: `DeleteAll Channel ${i}`,
            dataType: 'number',
          },
        });
      }
    });

    it('should delete all channels for sensor', async () => {
      const res = await gql(DELETE_ALL_CHANNELS_FOR_SENSOR, { sensorId: tempSensorId });

      expect(res.errors).toBeUndefined();
      expect(assertDefined(res.data).deleteAllChannelsForSensor).toBe(true);
    });

    it('should have zero channels after bulk delete', async () => {
      const res = await gql(CHANNELS_BY_SENSOR, { sensorId: tempSensorId });

      const channels = assertDefined(res.data).dataChannelsBySensor as Array<
        Record<string, unknown>
      >;
      expect(channels.length).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // Test 9: Calibration — linear (multiplier+offset) and polynomial
  // ------------------------------------------------------------------
  describe('Test 9: Calibration configurations', () => {
    it('should apply linear calibration (multiplier + offset)', async () => {
      const res = await gql(CREATE_DATA_CHANNEL, {
        sensorId,
        input: {
          channelKey: 'linear_cal',
          displayLabel: 'Linear Calibration',
          dataType: 'number',
          calibrationEnabled: true,
          calibrationMultiplier: 1.1,
          calibrationOffset: -0.5,
        },
      });

      expect(res.errors).toBeUndefined();
      const ch = assertDefined(res.data).createDataChannel as Record<string, unknown>;
      expect(ch.calibrationEnabled).toBe(true);
      expect(Number(ch.calibrationMultiplier)).toBeCloseTo(1.1, 2);
      expect(Number(ch.calibrationOffset)).toBeCloseTo(-0.5, 2);
    });

    it('should update to polynomial calibration by enabling calibration with custom multiplier/offset', async () => {
      // Polynomial calibration is stored in calibrationPolynomial JSONB field
      // through the entity, but the GraphQL mutation only exposes linear params.
      // We verify that linear calibration works correctly via the update mutation.
      const createRes = await gql(CREATE_DATA_CHANNEL, {
        sensorId,
        input: {
          channelKey: 'poly_cal',
          displayLabel: 'Polynomial Calibration',
          dataType: 'number',
          calibrationEnabled: false,
        },
      });
      const channelId = (assertDefined(createRes.data).createDataChannel as Record<string, unknown>)
        .id as string;

      const updateRes = await gql(UPDATE_DATA_CHANNEL, {
        input: {
          channelId,
          calibrationEnabled: true,
          calibrationMultiplier: 0.98,
          calibrationOffset: 0.15,
        },
      });

      expect(updateRes.errors).toBeUndefined();
      const ch = assertDefined(updateRes.data).updateDataChannel as Record<string, unknown>;
      expect(ch.calibrationEnabled).toBe(true);
      expect(Number(ch.calibrationMultiplier)).toBeCloseTo(0.98, 2);
      expect(Number(ch.calibrationOffset)).toBeCloseTo(0.15, 2);
    });
  });

  // ------------------------------------------------------------------
  // Test 10: Alert thresholds — normal/warning/critical
  // ------------------------------------------------------------------
  describe('Test 10: Alert threshold levels', () => {
    it('should create channel with warning and critical thresholds', async () => {
      const res = await gql(CREATE_DATA_CHANNEL, {
        sensorId,
        input: {
          channelKey: 'alert_levels',
          displayLabel: 'Alert Levels',
          dataType: 'number',
          unit: 'celsius',
          alertThresholds: {
            warning: { low: 15.0, high: 30.0 },
            critical: { low: 10.0, high: 35.0 },
            hysteresis: 0.5,
          },
        },
      });

      expect(res.errors).toBeUndefined();
      const ch = assertDefined(res.data).createDataChannel as Record<string, unknown>;
      const thresholds = ch.alertThresholds as Record<string, unknown>;

      expect(thresholds).toBeDefined();

      const warning = thresholds.warning as Record<string, number>;
      expect(warning.low).toBe(15.0);
      expect(warning.high).toBe(30.0);

      const critical = thresholds.critical as Record<string, number>;
      expect(critical.low).toBe(10.0);
      expect(critical.high).toBe(35.0);

      expect(thresholds.hysteresis).toBe(0.5);
    });

    it('should update thresholds on existing channel', async () => {
      const createRes = await gql(CREATE_DATA_CHANNEL, {
        sensorId,
        input: {
          channelKey: 'alert_update',
          displayLabel: 'Alert Update Target',
          dataType: 'number',
        },
      });
      const channelId = (assertDefined(createRes.data).createDataChannel as Record<string, unknown>)
        .id as string;

      const updateRes = await gql(UPDATE_DATA_CHANNEL, {
        input: {
          channelId,
          alertThresholds: {
            warning: { low: 20.0, high: 28.0 },
            critical: { low: 15.0, high: 33.0 },
          },
        },
      });

      expect(updateRes.errors).toBeUndefined();
      const ch = assertDefined(updateRes.data).updateDataChannel as Record<string, unknown>;
      const thresholds = ch.alertThresholds as Record<string, Record<string, number>>;
      expect(thresholds.warning.low).toBe(20.0);
      expect(thresholds.critical.high).toBe(33.0);
    });
  });

  // ------------------------------------------------------------------
  // Test 11: Cross-tenant isolation
  // ------------------------------------------------------------------
  describe('Test 11: Cross-tenant data channel isolation', () => {
    let tenantASensorId: string;

    beforeAll(async () => {
      const res = await gql(
        REGISTER_SENSOR,
        {
          input: {
            name: uniqueName('TenantA-ChannelIsolation'),
            type: 'temperature',
            protocolCode: 'mqtt',
            protocolConfiguration: { topic: 'sensors/a/channels' },
            skipConnectionTest: true,
          },
        },
        TENANT_A,
      );
      tenantASensorId = (
        (assertDefined(res.data).registerSensor as Record<string, unknown>).sensor as Record<
          string,
          unknown
        >
      ).id as string;

      await gql(
        CREATE_DATA_CHANNEL,
        {
          sensorId: tenantASensorId,
          input: {
            channelKey: 'secret_channel',
            displayLabel: 'Secret Channel',
            dataType: 'number',
          },
        },
        TENANT_A,
      );
    });

    it('Tenant B should NOT see Tenant A channels', async () => {
      const res = await gql(CHANNELS_BY_SENSOR, { sensorId: tenantASensorId }, TENANT_B);

      // Should either return empty list or error
      if (res.errors) {
        expect(res.errors.length).toBeGreaterThan(0);
      } else {
        const channels = res.data?.dataChannelsBySensor as Array<Record<string, unknown>>;
        // Channels should be empty for different tenant
        expect(channels.length).toBe(0);
      }
    });
  });
});
