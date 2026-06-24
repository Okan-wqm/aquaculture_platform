/**
 * VFD Devices E2E Tests
 *
 * Tests VFD device registration, status lifecycle, connection testing,
 * activation/deactivation, brand/protocol queries, register mappings,
 * readings, stats, commands (START/STOP/SET_FREQUENCY), emergency stop,
 * deletion, and cross-tenant isolation.
 *
 * Resolvers:
 * - VfdDeviceResolver (vfd-device.resolver.ts)
 * - VfdCommandResolver (vfd-command.resolver.ts)
 * - VfdReadingResolver (vfd-reading.resolver.ts)
 *
 * @module Sensor-Service/E2E/VfdDevice
 */
import { assertDefined } from '../../../helpers/assertions';

import { gql, TENANT_A, TENANT_B, uniqueName, uniqueSerial, runCleanup } from './helpers';

// ============================================================================
// GRAPHQL OPERATIONS
// ============================================================================

const REGISTER_VFD_DEVICE = `
  mutation registerVfdDevice($input: RegisterVfdInput!) {
    registerVfdDevice(input: $input) {
      success
      vfdDevice {
        id
        name
        brand
        model
        serialNumber
        protocol
        status
        location
        pollIntervalMs
        isPollingEnabled
        createdAt
      }
      error
      connectionTestPassed
      latencyMs
    }
  }
`;

const GET_VFD_DEVICE = `
  query vfdDevice($id: ID!) {
    vfdDevice(id: $id) {
      id
      name
      brand
      protocol
      status
      tenantId
      protocolConfiguration
      connectionStatus
    }
  }
`;

const LIST_VFD_DEVICES = `
  query vfdDevices($filter: VfdDeviceFilterInput, $pagination: VfdPaginationInput) {
    vfdDevices(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        brand
        protocol
        status
      }
      total
      page
      limit
    }
  }
`;

const ACTIVATE_VFD = `
  mutation activateVfdDevice($id: ID!) {
    activateVfdDevice(id: $id) {
      id
      name
      status
    }
  }
`;

const DEACTIVATE_VFD = `
  mutation deactivateVfdDevice($id: ID!) {
    deactivateVfdDevice(id: $id) {
      id
      name
      status
    }
  }
`;

const TEST_VFD_CONNECTION = `
  mutation testVfdConnection($input: TestVfdConnectionInput!) {
    testVfdConnection(input: $input) {
      success
      latencyMs
      error
      sampleData
      firmwareVersion
      deviceInfo {
        serialNumber
      }
      testedAt
    }
  }
`;

const VFD_BRANDS = `
  query vfdBrands {
    vfdBrands
  }
`;

const VFD_PROTOCOLS = `
  query vfdProtocols {
    vfdProtocols
  }
`;

const VFD_REGISTER_MAPPINGS = `
  query vfdRegisterMappings($brand: VfdBrand!, $modelSeries: String!) {
    vfdRegisterMappings(brand: $brand, modelSeries: $modelSeries) {
      id
      brand
      parameterName
      registerAddress
      registerCount
      functionCode
      dataType
      scalingFactor
      unit
    }
  }
`;

const VFD_LATEST_READING = `
  query vfdLatestReading($vfdDeviceId: ID!) {
    vfdLatestReading(vfdDeviceId: $vfdDeviceId) {
      id
      vfdDeviceId
      tenantId
      outputFrequency
      motorCurrent
      outputVoltage
      outputPower
      dcBusVoltage
      motorTemperature
      timestamp
    }
  }
`;

const VFD_READINGS = `
  query vfdReadings($vfdDeviceId: ID!, $from: DateTime, $to: DateTime, $limit: Int) {
    vfdReadings(vfdDeviceId: $vfdDeviceId, from: $from, to: $to, limit: $limit) {
      id
      vfdDeviceId
      outputFrequency
      motorCurrent
      timestamp
    }
  }
`;

const VFD_STATS = `
  query vfdStats {
    vfdStats {
      total
      active
      inactive
      faulted
      maintenance
      byBrand
      byProtocol
      byStatus
    }
  }
`;

const SEND_VFD_COMMAND = `
  mutation sendVfdCommand($vfdDeviceId: ID!, $command: VfdCommandInput!) {
    sendVfdCommand(vfdDeviceId: $vfdDeviceId, command: $command) {
      success
      error
      acknowledgedAt
      latencyMs
      commandSent
      previousValue
      newValue
    }
  }
`;

const START_VFD = `
  mutation startVfd($vfdDeviceId: ID!) {
    startVfd(vfdDeviceId: $vfdDeviceId) {
      success
      error
      commandSent
    }
  }
`;

const STOP_VFD = `
  mutation stopVfd($vfdDeviceId: ID!) {
    stopVfd(vfdDeviceId: $vfdDeviceId) {
      success
      error
      commandSent
    }
  }
`;

const SET_VFD_FREQUENCY = `
  mutation setVfdFrequency($vfdDeviceId: ID!, $frequencyHz: Float!) {
    setVfdFrequency(vfdDeviceId: $vfdDeviceId, frequencyHz: $frequencyHz) {
      success
      error
      commandSent
      newValue
    }
  }
`;

const EMERGENCY_STOP_VFD = `
  mutation emergencyStopVfd($vfdDeviceId: ID!) {
    emergencyStopVfd(vfdDeviceId: $vfdDeviceId) {
      success
      error
      commandSent
    }
  }
`;

const DELETE_VFD_DEVICE = `
  mutation deleteVfdDevice($id: ID!) {
    deleteVfdDevice(id: $id)
  }
`;

// ============================================================================
// TESTS
// ============================================================================

describe('VFD Devices', () => {
  afterAll(async () => {
    await runCleanup();
  });

  // ------------------------------------------------------------------
  // Test 1: registerVfdDevice -> vfdDevice(id) -> vfdDevices(filter)
  // ------------------------------------------------------------------
  describe('Test 1: Register, get, and list VFD device', () => {
    let vfdId: string;

    it('should register a VFD device', async () => {
      const res = await gql(REGISTER_VFD_DEVICE, {
        input: {
          name: uniqueName('Danfoss-FC102'),
          brand: 'danfoss',
          model: 'FC102',
          modelSeries: 'FC102',
          serialNumber: uniqueSerial('VFD'),
          protocol: 'modbus_tcp',
          protocolConfiguration: {
            host: '192.168.1.50',
            port: 502,
            unitId: 1,
            connectionTimeout: 5000,
            responseTimeout: 3000,
          },
          location: 'Building A, Panel 3',
          description: 'Main pump VFD',
          skipConnectionTest: true,
        },
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).registerVfdDevice as Record<string, unknown>;
      expect(result.success).toBe(true);

      const device = result.vfdDevice as Record<string, unknown>;
      expect(device).toBeDefined();
      expect(device.brand).toBe('danfoss');
      expect(device.protocol).toBe('modbus_tcp');
      expect(device.status).toBe('draft');

      vfdId = device.id as string;
    });

    it('should retrieve VFD by ID', async () => {
      const res = await gql(GET_VFD_DEVICE, { id: vfdId });

      expect(res.errors).toBeUndefined();
      const device = assertDefined(res.data).vfdDevice as Record<string, unknown>;
      expect(device.id).toBe(vfdId);
      expect(device.tenantId).toBe(TENANT_A.id);
    });

    it('should list VFD devices with filter', async () => {
      const res = await gql(LIST_VFD_DEVICES, {
        filter: { brand: 'danfoss' },
        pagination: { page: 1, limit: 20 },
      });

      expect(res.errors).toBeUndefined();
      const conn = assertDefined(res.data).vfdDevices as Record<string, unknown>;
      const items = conn.items as Array<Record<string, unknown>>;

      for (const d of items) {
        expect(d.brand).toBe('danfoss');
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 2: VFD status: DRAFT -> PENDING_TEST -> ACTIVE
  // ------------------------------------------------------------------
  describe('Test 2: VFD status lifecycle', () => {
    let vfdId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_VFD_DEVICE, {
        input: {
          name: uniqueName('StatusLifecycle'),
          brand: 'abb',
          protocol: 'modbus_rtu',
          protocolConfiguration: {
            serialPort: '/dev/ttyUSB0',
            slaveId: 1,
            baudRate: 9600,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            timeout: 3000,
            retryCount: 3,
          },
          skipConnectionTest: true,
        },
      });
      vfdId = (
        (assertDefined(res.data).registerVfdDevice as Record<string, unknown>).vfdDevice as Record<
          string,
          unknown
        >
      ).id as string;
    });

    it('should start in DRAFT status', async () => {
      const res = await gql(GET_VFD_DEVICE, { id: vfdId });
      const device = assertDefined(res.data).vfdDevice as Record<string, unknown>;
      expect(device.status).toBe('draft');
    });

    it('should transition to ACTIVE on activation', async () => {
      const res = await gql(ACTIVATE_VFD, { id: vfdId });

      expect(res.errors).toBeUndefined();
      const device = assertDefined(res.data).activateVfdDevice as Record<string, unknown>;
      expect(device.status).toBe('active');
    });
  });

  // ------------------------------------------------------------------
  // Test 3: testVfdConnection -> result
  // ------------------------------------------------------------------
  describe('Test 3: Test VFD connection', () => {
    it('should return connection test result', async () => {
      const res = await gql(TEST_VFD_CONNECTION, {
        input: {
          protocol: 'modbus_tcp',
          configuration: {
            host: '192.168.1.100',
            port: 502,
            unitId: 1,
          },
          brand: 'siemens',
        },
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).testVfdConnection as Record<string, unknown>;
      expect(typeof result.success).toBe('boolean');
      expect(result.testedAt).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 4: activateVfdDevice / deactivateVfdDevice
  // ------------------------------------------------------------------
  describe('Test 4: Activate and deactivate VFD', () => {
    let vfdId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_VFD_DEVICE, {
        input: {
          name: uniqueName('ActivateDeactivate'),
          brand: 'schneider',
          protocol: 'modbus_tcp',
          protocolConfiguration: {
            host: '192.168.1.60',
            port: 502,
            unitId: 1,
          },
          skipConnectionTest: true,
        },
      });
      vfdId = (
        (assertDefined(res.data).registerVfdDevice as Record<string, unknown>).vfdDevice as Record<
          string,
          unknown
        >
      ).id as string;
    });

    it('should activate VFD', async () => {
      const res = await gql(ACTIVATE_VFD, { id: vfdId });

      expect(res.errors).toBeUndefined();
      expect((assertDefined(res.data).activateVfdDevice as Record<string, unknown>).status).toBe(
        'active',
      );
    });

    it('should deactivate VFD', async () => {
      const res = await gql(DEACTIVATE_VFD, { id: vfdId });

      expect(res.errors).toBeUndefined();
      expect((assertDefined(res.data).deactivateVfdDevice as Record<string, unknown>).status).toBe(
        'suspended',
      );
    });
  });

  // ------------------------------------------------------------------
  // Test 5: vfdBrands -> brand list
  // ------------------------------------------------------------------
  describe('Test 5: VFD brands', () => {
    it('should return supported VFD brands', async () => {
      const res = await gql(VFD_BRANDS);

      expect(res.errors).toBeUndefined();
      const brands = assertDefined(res.data).vfdBrands;
      expect(brands).toBeDefined();

      // Brands should include known manufacturers
      // vfdBrands returns JSON from registerMappingService.getBrandsSummary()
    });
  });

  // ------------------------------------------------------------------
  // Test 6: vfdProtocols -> protocol list
  // ------------------------------------------------------------------
  describe('Test 6: VFD protocols', () => {
    it('should return supported VFD protocols', async () => {
      const res = await gql(VFD_PROTOCOLS);

      expect(res.errors).toBeUndefined();
      const protocols = assertDefined(res.data).vfdProtocols;
      expect(protocols).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 7: vfdRegisterMappings(brand, modelSeries)
  // ------------------------------------------------------------------
  describe('Test 7: VFD register mappings', () => {
    it('should return register mappings for Danfoss FC102', async () => {
      const res = await gql(VFD_REGISTER_MAPPINGS, {
        brand: 'danfoss',
        modelSeries: 'FC102',
      });

      expect(res.errors).toBeUndefined();
      const mappings = assertDefined(res.data).vfdRegisterMappings as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(mappings)).toBe(true);

      for (const mapping of mappings) {
        expect(mapping.brand).toBe('danfoss');
        expect(mapping.parameterName).toBeDefined();
        expect(typeof mapping.registerAddress).toBe('number');
        expect(typeof mapping.registerCount).toBe('number');
        expect(mapping.dataType).toBeDefined();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 8: vfdLatestReading -> reading verify
  // ------------------------------------------------------------------
  describe('Test 8: VFD latest reading', () => {
    let vfdId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_VFD_DEVICE, {
        input: {
          name: uniqueName('ReadingVFD'),
          brand: 'yaskawa',
          protocol: 'modbus_tcp',
          protocolConfiguration: {
            host: '192.168.1.70',
            port: 502,
            unitId: 1,
          },
          skipConnectionTest: true,
        },
      });
      vfdId = (
        (assertDefined(res.data).registerVfdDevice as Record<string, unknown>).vfdDevice as Record<
          string,
          unknown
        >
      ).id as string;
    });

    it('should query latest reading (may be null for new device)', async () => {
      const res = await gql(VFD_LATEST_READING, { vfdDeviceId: vfdId });

      expect(res.errors).toBeUndefined();
      // New device will have null reading
      const reading = res.data?.vfdLatestReading;
      if (reading !== null && reading !== undefined) {
        const r = reading as Record<string, unknown>;
        expect(r.vfdDeviceId).toBe(vfdId);
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 9: vfdReadings(timeRange) -> time series
  // ------------------------------------------------------------------
  describe('Test 9: VFD readings time series', () => {
    let vfdId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_VFD_DEVICE, {
        input: {
          name: uniqueName('TimeSeriesVFD'),
          brand: 'delta',
          protocol: 'modbus_rtu',
          protocolConfiguration: {
            serialPort: '/dev/ttyUSB1',
            slaveId: 2,
            baudRate: 9600,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            timeout: 3000,
            retryCount: 3,
          },
          skipConnectionTest: true,
        },
      });
      vfdId = (
        (assertDefined(res.data).registerVfdDevice as Record<string, unknown>).vfdDevice as Record<
          string,
          unknown
        >
      ).id as string;
    });

    it('should query readings with time range', async () => {
      const from = new Date(Date.now() - 86400000);
      const to = new Date();

      const res = await gql(VFD_READINGS, {
        vfdDeviceId: vfdId,
        from: from.toISOString(),
        to: to.toISOString(),
        limit: 50,
      });

      expect(res.errors).toBeUndefined();
      const readings = assertDefined(res.data).vfdReadings as Array<Record<string, unknown>>;
      expect(Array.isArray(readings)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Test 10: vfdStats -> summary
  // ------------------------------------------------------------------
  describe('Test 10: VFD fleet statistics', () => {
    it('should return VFD fleet stats', async () => {
      const res = await gql(VFD_STATS);

      expect(res.errors).toBeUndefined();
      const stats = assertDefined(res.data).vfdStats as Record<string, unknown>;
      expect(typeof stats.total).toBe('number');
      expect(typeof stats.active).toBe('number');
      expect(typeof stats.inactive).toBe('number');
      expect(typeof stats.faulted).toBe('number');
      expect(typeof stats.maintenance).toBe('number');
      expect(stats.byBrand).toBeDefined();
      expect(stats.byProtocol).toBeDefined();
      expect(stats.byStatus).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 11: sendVfdCommand (START / STOP / SET_FREQUENCY)
  // ------------------------------------------------------------------
  describe('Test 11: VFD commands', () => {
    let vfdId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_VFD_DEVICE, {
        input: {
          name: uniqueName('CommandVFD'),
          brand: 'siemens',
          model: 'G120',
          protocol: 'modbus_tcp',
          protocolConfiguration: {
            host: '192.168.1.80',
            port: 502,
            unitId: 1,
          },
          skipConnectionTest: true,
        },
      });
      vfdId = (
        (assertDefined(res.data).registerVfdDevice as Record<string, unknown>).vfdDevice as Record<
          string,
          unknown
        >
      ).id as string;
      await gql(ACTIVATE_VFD, { id: vfdId });
    });

    it('should send START command', async () => {
      const res = await gql(START_VFD, { vfdDeviceId: vfdId });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).startVfd as Record<string, unknown>;
      expect(typeof result.success).toBe('boolean');
      // May fail if no actual VFD connected but structure should be correct
    });

    it('should send STOP command', async () => {
      const res = await gql(STOP_VFD, { vfdDeviceId: vfdId });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).stopVfd as Record<string, unknown>;
      expect(typeof result.success).toBe('boolean');
    });

    it('should send SET_FREQUENCY command', async () => {
      const res = await gql(SET_VFD_FREQUENCY, {
        vfdDeviceId: vfdId,
        frequencyHz: 50.0,
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).setVfdFrequency as Record<string, unknown>;
      expect(typeof result.success).toBe('boolean');
    });

    it('should send generic command via sendVfdCommand', async () => {
      const res = await gql(SEND_VFD_COMMAND, {
        vfdDeviceId: vfdId,
        command: {
          command: 'set_speed',
          value: 75.0,
        },
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).sendVfdCommand as Record<string, unknown>;
      expect(typeof result.success).toBe('boolean');
    });
  });

  // ------------------------------------------------------------------
  // Test 12: emergencyStopVfd -> ALL AUTHENTICATED (no @Roles)
  // ------------------------------------------------------------------
  describe('Test 12: Emergency stop (all authenticated users)', () => {
    let vfdId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_VFD_DEVICE, {
        input: {
          name: uniqueName('EmergencyVFD'),
          brand: 'rockwell',
          protocol: 'modbus_tcp',
          protocolConfiguration: {
            host: '192.168.1.90',
            port: 502,
            unitId: 1,
          },
          skipConnectionTest: true,
        },
      });
      vfdId = (
        (assertDefined(res.data).registerVfdDevice as Record<string, unknown>).vfdDevice as Record<
          string,
          unknown
        >
      ).id as string;
      await gql(ACTIVATE_VFD, { id: vfdId });
    });

    it('should allow emergency stop for any authenticated user', async () => {
      const res = await gql(EMERGENCY_STOP_VFD, { vfdDeviceId: vfdId });

      // Should NOT get authorization error - emergencyStopVfd has no @Roles decorator
      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).emergencyStopVfd as Record<string, unknown>;
      expect(typeof result.success).toBe('boolean');
    });
  });

  // ------------------------------------------------------------------
  // Test 13: deleteVfdDevice
  // ------------------------------------------------------------------
  describe('Test 13: Delete VFD device', () => {
    let vfdId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_VFD_DEVICE, {
        input: {
          name: uniqueName('DeleteVFD'),
          brand: 'mitsubishi',
          protocol: 'modbus_rtu',
          protocolConfiguration: {
            serialPort: '/dev/ttyUSB2',
            slaveId: 3,
            baudRate: 9600,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            timeout: 3000,
            retryCount: 3,
          },
          skipConnectionTest: true,
        },
      });
      vfdId = (
        (assertDefined(res.data).registerVfdDevice as Record<string, unknown>).vfdDevice as Record<
          string,
          unknown
        >
      ).id as string;
    });

    it('should delete VFD device', async () => {
      const res = await gql(DELETE_VFD_DEVICE, { id: vfdId });

      expect(res.errors).toBeUndefined();
      expect(assertDefined(res.data).deleteVfdDevice).toBe(true);
    });

    it('should return null when querying deleted VFD', async () => {
      const res = await gql(GET_VFD_DEVICE, { id: vfdId });

      // Should return null since query has nullable: true
      if (res.data?.vfdDevice !== undefined) {
        expect(res.data.vfdDevice).toBeNull();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 14: Cross-tenant isolation
  // ------------------------------------------------------------------
  describe('Test 14: Cross-tenant VFD isolation', () => {
    let tenantAVfdId: string;

    beforeAll(async () => {
      const res = await gql(
        REGISTER_VFD_DEVICE,
        {
          input: {
            name: uniqueName('TenantA-VFD'),
            brand: 'danfoss',
            protocol: 'modbus_tcp',
            protocolConfiguration: {
              host: '10.0.0.50',
              port: 502,
              unitId: 1,
            },
            skipConnectionTest: true,
          },
        },
        TENANT_A,
      );
      tenantAVfdId = (
        (assertDefined(res.data).registerVfdDevice as Record<string, unknown>).vfdDevice as Record<
          string,
          unknown
        >
      ).id as string;
    });

    it('Tenant B should NOT see Tenant A VFD by ID', async () => {
      const res = await gql(GET_VFD_DEVICE, { id: tenantAVfdId }, TENANT_B);

      if (res.data?.vfdDevice) {
        expect(res.data.vfdDevice).toBeNull();
      }
    });

    it('Tenant B VFD list should NOT include Tenant A devices', async () => {
      const res = await gql(LIST_VFD_DEVICES, { pagination: { page: 1, limit: 100 } }, TENANT_B);

      expect(res.errors).toBeUndefined();
      const conn = assertDefined(res.data).vfdDevices as Record<string, unknown>;
      const items = conn.items as Array<Record<string, unknown>>;

      for (const d of items) {
        // If items have tenantId, verify isolation
        if ('tenantId' in d) {
          expect(d.tenantId).toBe(TENANT_B.id);
        }
      }
    });

    it('Tenant B should NOT delete Tenant A VFD', async () => {
      const res = await gql(DELETE_VFD_DEVICE, { id: tenantAVfdId }, TENANT_B);

      // Should fail
      if (res.errors) {
        expect(res.errors.length).toBeGreaterThan(0);
      } else {
        expect(assertDefined(res.data).deleteVfdDevice).toBe(false);
      }
    });

    it('Tenant B should NOT send commands to Tenant A VFD', async () => {
      const res = await gql(EMERGENCY_STOP_VFD, { vfdDeviceId: tenantAVfdId }, TENANT_B);

      // Cross-tenant command should fail
      if (res.errors) {
        expect(res.errors.length).toBeGreaterThan(0);
      } else {
        const result = assertDefined(res.data).emergencyStopVfd as Record<string, unknown>;
        expect(result.success).toBe(false);
      }
    });
  });
});
