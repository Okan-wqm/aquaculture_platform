/**
 * Edge Device Management E2E Tests
 *
 * Tests edge device registration, lifecycle state machine transitions,
 * maintenance mode, decommission, ping, reboot, I/O config, provisioning keys,
 * device events, and cross-tenant isolation.
 *
 * Resolver: EdgeDeviceResolver (edge-device.resolver.ts)
 *
 * @module Sensor-Service/E2E/EdgeDevice
 */
import { assertDefined } from '../../../helpers/assertions';

import {
  gql,
  TENANT_A,
  TENANT_B,
  uniqueCode,
  uniqueName,
  uniqueSerial,
  runCleanup,
} from './helpers';

// ============================================================================
// GRAPHQL OPERATIONS
// ============================================================================

const REGISTER_EDGE_DEVICE = `
  mutation registerEdgeDevice($input: RegisterEdgeDeviceInput!) {
    registerEdgeDevice(input: $input) {
      id
      tenantId
      deviceCode
      deviceName
      deviceModel
      serialNumber
      description
      lifecycleState
      isOnline
      createdAt
    }
  }
`;

const GET_EDGE_DEVICE = `
  query edgeDevice($id: ID!) {
    edgeDevice(id: $id) {
      id
      tenantId
      deviceCode
      deviceName
      deviceModel
      lifecycleState
      isOnline
      serialNumber
    }
  }
`;

const LIST_EDGE_DEVICES = `
  query edgeDevices($lifecycleState: DeviceLifecycleState, $page: Int, $limit: Int) {
    edgeDevices(lifecycleState: $lifecycleState, page: $page, limit: $limit) {
      items {
        id
        tenantId
        deviceCode
        deviceName
        lifecycleState
        isOnline
      }
      total
      page
      limit
    }
  }
`;

const APPROVE_EDGE_DEVICE = `
  mutation approveEdgeDevice($id: ID!) {
    approveEdgeDevice(id: $id) {
      id
      lifecycleState
      commissionedAt
    }
  }
`;

const SET_MAINTENANCE_MODE = `
  mutation setDeviceMaintenanceMode($id: ID!, $enabled: Boolean!) {
    setDeviceMaintenanceMode(id: $id, enabled: $enabled) {
      id
      lifecycleState
    }
  }
`;

const DECOMMISSION_EDGE_DEVICE = `
  mutation decommissionEdgeDevice($id: ID!, $reason: String!) {
    decommissionEdgeDevice(id: $id, reason: $reason) {
      id
      lifecycleState
    }
  }
`;

const PING_EDGE_DEVICE = `
  mutation pingEdgeDevice($id: ID!) {
    pingEdgeDevice(id: $id) {
      success
      latencyMs
      deviceCode
      timestamp
      error
    }
  }
`;

const REBOOT_EDGE_DEVICE = `
  mutation rebootEdgeDevice($id: ID!, $reason: String) {
    rebootEdgeDevice(id: $id, reason: $reason)
  }
`;

const EDGE_DEVICE_STATS = `
  query edgeDeviceStats {
    edgeDeviceStats {
      total
      online
      offline
      byState {
        state
        count
      }
      byModel {
        model
        count
      }
    }
  }
`;

const ADD_IO_CONFIG = `
  mutation addDeviceIoConfig($deviceId: ID!, $input: AddIoConfigInput!) {
    addDeviceIoConfig(deviceId: $deviceId, input: $input) {
      id
      deviceId
      tagName
      ioType
      dataType
      moduleAddress
      channel
    }
  }
`;

const CREATE_TENANT_PROVISIONING_KEY = `
  mutation createTenantProvisioningKey($input: CreateTenantKeyInput!) {
    createTenantProvisioningKey(input: $input) {
      id
      keyToken
      installerUrl
      installerCommand
      expiresAt
      maxDevices
      autoApprove
    }
  }
`;

const DEVICE_EVENTS = `
  query deviceEvents($deviceId: ID, $page: Int, $limit: Int) {
    deviceEvents(deviceId: $deviceId, page: $page, limit: $limit) {
      items {
        id
        deviceId
        eventType
        severity
        message
        metadata
        createdAt
      }
      total
      page
      limit
    }
  }
`;

// ============================================================================
// TESTS
// ============================================================================

describe('Edge Device Management', () => {
  afterAll(async () => {
    await runCleanup();
  });

  // ------------------------------------------------------------------
  // Test 1: registerEdgeDevice -> edgeDevices -> device in list
  // ------------------------------------------------------------------
  describe('Test 1: Register and list edge device', () => {
    let deviceId: string;
    const deviceCode = uniqueCode('EDGE');

    it('should register an edge device', async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode,
          deviceName: uniqueName('RevPi-Connect4'),
          deviceModel: 'revolution_pi_connect_4',
          serialNumber: uniqueSerial('EDGE'),
          description: 'Production line controller',
          timezone: 'Europe/Istanbul',
        },
      });

      expect(res.errors).toBeUndefined();
      const device = assertDefined(res.data).registerEdgeDevice as Record<string, unknown>;
      expect(device.deviceCode).toBe(deviceCode);
      expect(device.deviceModel).toBe('revolution_pi_connect_4');
      expect(device.lifecycleState).toBe('registered');
      expect(device.tenantId).toBe(TENANT_A.id);
      expect(device.isOnline).toBe(false);

      deviceId = device.id as string;
    });

    it('should appear in device list', async () => {
      const res = await gql(LIST_EDGE_DEVICES, { page: 1, limit: 50 });

      expect(res.errors).toBeUndefined();
      const conn = assertDefined(res.data).edgeDevices as Record<string, unknown>;
      const items = conn.items as Array<Record<string, unknown>>;

      const found = items.find((d) => d.id === deviceId);
      expect(found).toBeDefined();
      expect(assertDefined(found).deviceCode).toBe(deviceCode);
    });

    it('should retrieve by ID', async () => {
      const res = await gql(GET_EDGE_DEVICE, { id: deviceId });

      expect(res.errors).toBeUndefined();
      const device = assertDefined(res.data).edgeDevice as Record<string, unknown>;
      expect(device.id).toBe(deviceId);
      expect(device.tenantId).toBe(TENANT_A.id);
    });
  });

  // ------------------------------------------------------------------
  // Test 2: Lifecycle state machine
  //         REGISTERED -> PROVISIONING -> PENDING_APPROVAL -> ACTIVE
  // ------------------------------------------------------------------
  describe('Test 2: Lifecycle state machine', () => {
    let deviceId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode: uniqueCode('LIFECYCLE'),
          deviceName: uniqueName('LifecycleDevice'),
          deviceModel: 'raspberry_pi_4',
        },
      });
      deviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;
    });

    it('should start in REGISTERED state', async () => {
      const res = await gql(GET_EDGE_DEVICE, { id: deviceId });
      const device = assertDefined(res.data).edgeDevice as Record<string, unknown>;
      expect(device.lifecycleState).toBe('registered');
    });

    it('should filter devices by lifecycle state', async () => {
      const res = await gql(LIST_EDGE_DEVICES, {
        lifecycleState: 'registered',
        page: 1,
        limit: 50,
      });

      expect(res.errors).toBeUndefined();
      const conn = assertDefined(res.data).edgeDevices as Record<string, unknown>;
      const items = conn.items as Array<Record<string, unknown>>;

      for (const d of items) {
        expect(d.lifecycleState).toBe('registered');
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 3: approveEdgeDevice -> ACTIVE
  // ------------------------------------------------------------------
  describe('Test 3: Approve edge device', () => {
    let deviceId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode: uniqueCode('APPROVE'),
          deviceName: uniqueName('ApproveDevice'),
          deviceModel: 'raspberry_pi_5',
        },
      });
      deviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;
    });

    it('should approve device and set ACTIVE', async () => {
      const res = await gql(APPROVE_EDGE_DEVICE, { id: deviceId });

      expect(res.errors).toBeUndefined();
      const device = assertDefined(res.data).approveEdgeDevice as Record<string, unknown>;
      expect(device.lifecycleState).toBe('active');
      expect(device.commissionedAt).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 4: setDeviceMaintenanceMode(true) -> MAINTENANCE
  // ------------------------------------------------------------------
  describe('Test 4: Set maintenance mode', () => {
    let deviceId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode: uniqueCode('MAINT'),
          deviceName: uniqueName('MaintenanceDevice'),
          deviceModel: 'industrial_pc',
        },
      });
      deviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;
      await gql(APPROVE_EDGE_DEVICE, { id: deviceId });
    });

    it('should enter maintenance mode', async () => {
      const res = await gql(SET_MAINTENANCE_MODE, { id: deviceId, enabled: true });

      expect(res.errors).toBeUndefined();
      const device = assertDefined(res.data).setDeviceMaintenanceMode as Record<string, unknown>;
      expect(device.lifecycleState).toBe('maintenance');
    });

    it('should exit maintenance mode back to active', async () => {
      const res = await gql(SET_MAINTENANCE_MODE, { id: deviceId, enabled: false });

      expect(res.errors).toBeUndefined();
      const device = assertDefined(res.data).setDeviceMaintenanceMode as Record<string, unknown>;
      expect(device.lifecycleState).toBe('active');
    });
  });

  // ------------------------------------------------------------------
  // Test 5: decommissionEdgeDevice(reason) -> DECOMMISSIONED
  // ------------------------------------------------------------------
  describe('Test 5: Decommission edge device', () => {
    let deviceId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode: uniqueCode('DECOM'),
          deviceName: uniqueName('DecommDevice'),
          deviceModel: 'raspberry_pi_4',
        },
      });
      deviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;
      await gql(APPROVE_EDGE_DEVICE, { id: deviceId });
    });

    it('should decommission device with reason', async () => {
      const res = await gql(DECOMMISSION_EDGE_DEVICE, {
        id: deviceId,
        reason: 'End of life - hardware failure',
      });

      expect(res.errors).toBeUndefined();
      const device = assertDefined(res.data).decommissionEdgeDevice as Record<string, unknown>;
      expect(device.lifecycleState).toBe('decommissioned');
    });

    it('should verify decommissioned state via query', async () => {
      const res = await gql(GET_EDGE_DEVICE, { id: deviceId });
      const device = assertDefined(res.data).edgeDevice as Record<string, unknown>;
      expect(device.lifecycleState).toBe('decommissioned');
    });
  });

  // ------------------------------------------------------------------
  // Test 6: pingEdgeDevice -> PingResult
  // ------------------------------------------------------------------
  describe('Test 6: Ping edge device', () => {
    let deviceId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode: uniqueCode('PING'),
          deviceName: uniqueName('PingDevice'),
          deviceModel: 'raspberry_pi_4',
        },
      });
      deviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;
    });

    it('should return PingResult with expected fields', async () => {
      const res = await gql(PING_EDGE_DEVICE, { id: deviceId });

      expect(res.errors).toBeUndefined();
      const ping = assertDefined(res.data).pingEdgeDevice as Record<string, unknown>;
      expect(typeof ping.success).toBe('boolean');
      expect(ping.deviceCode).toBeDefined();
      expect(ping.timestamp).toBeDefined();

      // Device is not online so ping may fail, but structure should be correct
      if (!ping.success) {
        expect(ping.error).toBeDefined();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 7: rebootEdgeDevice(reason)
  // ------------------------------------------------------------------
  describe('Test 7: Reboot edge device', () => {
    let deviceId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode: uniqueCode('REBOOT'),
          deviceName: uniqueName('RebootDevice'),
          deviceModel: 'revolution_pi_compact',
        },
      });
      deviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;
    });

    it('should send reboot command', async () => {
      const res = await gql(REBOOT_EDGE_DEVICE, {
        id: deviceId,
        reason: 'Firmware update applied',
      });

      // May fail if device is offline, but should not throw unexpected errors
      expect(res.errors).toBeUndefined();
      // Returns boolean
      expect(typeof assertDefined(res.data).rebootEdgeDevice).toBe('boolean');
    });
  });

  // ------------------------------------------------------------------
  // Test 8: edgeDeviceStats -> total, active, offline
  // ------------------------------------------------------------------
  describe('Test 8: Edge device statistics', () => {
    it('should return device stats with all expected fields', async () => {
      const res = await gql(EDGE_DEVICE_STATS);

      expect(res.errors).toBeUndefined();
      const stats = assertDefined(res.data).edgeDeviceStats as Record<string, unknown>;
      expect(typeof stats.total).toBe('number');
      expect(typeof stats.online).toBe('number');
      expect(typeof stats.offline).toBe('number');

      const byState = stats.byState as Array<Record<string, unknown>>;
      expect(Array.isArray(byState)).toBe(true);
      for (const s of byState) {
        expect(s.state).toBeDefined();
        expect(typeof s.count).toBe('number');
      }

      const byModel = stats.byModel as Array<Record<string, unknown>>;
      expect(Array.isArray(byModel)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Test 9: I/O Config: addDeviceIoConfig -> device io list
  // ------------------------------------------------------------------
  describe('Test 9: I/O configuration', () => {
    let deviceId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode: uniqueCode('IO'),
          deviceName: uniqueName('IoConfigDevice'),
          deviceModel: 'revolution_pi_connect_4',
        },
      });
      deviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;
    });

    it('should add I/O config to device', async () => {
      const res = await gql(ADD_IO_CONFIG, {
        deviceId,
        input: {
          tagName: 'DI_01',
          ioType: 'DI',
          dataType: 'bool',
          moduleAddress: 0,
          channel: 1,
          description: 'Digital Input 1',
        },
      });

      expect(res.errors).toBeUndefined();
      const config = assertDefined(res.data).addDeviceIoConfig as Record<string, unknown>;
      expect(config.tagName).toBe('DI_01');
      expect(config.ioType).toBe('DI');
      expect(config.dataType).toBe('bool');
      expect(config.deviceId).toBe(deviceId);
    });

    it('should add analog I/O config', async () => {
      const res = await gql(ADD_IO_CONFIG, {
        deviceId,
        input: {
          tagName: 'AI_TEMP',
          ioType: 'AI',
          dataType: 'float32',
          moduleAddress: 64,
          channel: 0,
          description: 'Temperature analog input',
          rawMin: 0,
          rawMax: 32767,
          engMin: 0,
          engMax: 100,
          engUnit: 'celsius',
          alarmHH: 90,
          alarmH: 80,
          alarmL: 5,
          alarmLL: 0,
        },
      });

      expect(res.errors).toBeUndefined();
      const config = assertDefined(res.data).addDeviceIoConfig as Record<string, unknown>;
      expect(config.tagName).toBe('AI_TEMP');
      expect(config.ioType).toBe('AI');
      expect(config.dataType).toBe('float32');
    });
  });

  // ------------------------------------------------------------------
  // Test 10: Provisioning key: createTenantProvisioningKey
  // ------------------------------------------------------------------
  describe('Test 10: Tenant provisioning key', () => {
    it('should create a provisioning key', async () => {
      const res = await gql(CREATE_TENANT_PROVISIONING_KEY, {
        input: {
          name: 'Production Line Installer',
          maxDevices: 10,
          autoApprove: false,
          expiresInDays: 30,
        },
      });

      expect(res.errors).toBeUndefined();
      const key = assertDefined(res.data).createTenantProvisioningKey as Record<string, unknown>;
      expect(key.id).toBeDefined();
      expect(key.keyToken).toBeDefined();
      expect(typeof key.keyToken).toBe('string');
      expect((key.keyToken as string).length).toBeGreaterThan(0);
      expect(key.installerUrl).toBeDefined();
      expect(key.installerCommand).toBeDefined();
      expect(key.maxDevices).toBe(10);
      expect(key.autoApprove).toBe(false);
    });

    it('should create unlimited key with auto-approve', async () => {
      const res = await gql(CREATE_TENANT_PROVISIONING_KEY, {
        input: {
          name: 'Auto-approve key',
          autoApprove: true,
        },
      });

      expect(res.errors).toBeUndefined();
      const key = assertDefined(res.data).createTenantProvisioningKey as Record<string, unknown>;
      expect(key.autoApprove).toBe(true);
      expect(key.maxDevices).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Test 11: deviceEvents(deviceId) -> event history
  // ------------------------------------------------------------------
  describe('Test 11: Device events', () => {
    let deviceId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_EDGE_DEVICE, {
        input: {
          deviceCode: uniqueCode('EVENTS'),
          deviceName: uniqueName('EventsDevice'),
          deviceModel: 'raspberry_pi_5',
        },
      });
      deviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;

      // Generate events by performing lifecycle transitions
      await gql(APPROVE_EDGE_DEVICE, { id: deviceId });
      await gql(SET_MAINTENANCE_MODE, { id: deviceId, enabled: true });
      await gql(SET_MAINTENANCE_MODE, { id: deviceId, enabled: false });
    });

    it('should return device events with pagination', async () => {
      const res = await gql(DEVICE_EVENTS, {
        deviceId,
        page: 1,
        limit: 20,
      });

      expect(res.errors).toBeUndefined();
      const conn = assertDefined(res.data).deviceEvents as Record<string, unknown>;
      expect(typeof conn.total).toBe('number');
      expect(conn.page).toBe(1);

      const items = conn.items as Array<Record<string, unknown>>;
      expect(Array.isArray(items)).toBe(true);

      for (const event of items) {
        expect(event.eventType).toBeDefined();
        expect(event.severity).toBeDefined();
        expect(event.message).toBeDefined();
        expect(event.createdAt).toBeDefined();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 12: Cross-tenant isolation
  // ------------------------------------------------------------------
  describe('Test 12: Cross-tenant isolation', () => {
    let tenantADeviceId: string;

    beforeAll(async () => {
      const res = await gql(
        REGISTER_EDGE_DEVICE,
        {
          input: {
            deviceCode: uniqueCode('ISOLATED'),
            deviceName: uniqueName('IsolatedDevice'),
            deviceModel: 'raspberry_pi_4',
          },
        },
        TENANT_A,
      );
      tenantADeviceId = (assertDefined(res.data).registerEdgeDevice as Record<string, unknown>)
        .id as string;
    });

    it('Tenant B should NOT see Tenant A device by ID', async () => {
      const res = await gql(GET_EDGE_DEVICE, { id: tenantADeviceId }, TENANT_B);

      // Should return null
      if (res.data?.edgeDevice) {
        expect(res.data.edgeDevice).toBeNull();
      }
    });

    it('Tenant B device list should NOT include Tenant A devices', async () => {
      const res = await gql(LIST_EDGE_DEVICES, { page: 1, limit: 100 }, TENANT_B);

      expect(res.errors).toBeUndefined();
      const conn = assertDefined(res.data).edgeDevices as Record<string, unknown>;
      const items = conn.items as Array<Record<string, unknown>>;

      for (const d of items) {
        expect(d.tenantId).toBe(TENANT_B.id);
      }
    });

    it('Tenant B should NOT approve Tenant A device', async () => {
      const res = await gql(APPROVE_EDGE_DEVICE, { id: tenantADeviceId }, TENANT_B);

      // Should fail
      expect(res.errors).toBeDefined();
    });

    it('Tenant B should NOT decommission Tenant A device', async () => {
      const res = await gql(
        DECOMMISSION_EDGE_DEVICE,
        { id: tenantADeviceId, reason: 'Tenant B attack' },
        TENANT_B,
      );

      expect(res.errors).toBeDefined();
    });
  });
});
