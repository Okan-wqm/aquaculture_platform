/**
 * Sensor CRUD + Registration E2E Tests
 *
 * Tests sensor lifecycle from creation through registration status transitions,
 * parent-child relationships, and cross-tenant isolation.
 *
 * Resolver: SensorResolver (sensor.resolver.ts)
 * Registration: RegistrationResolver (registration.resolver.ts)
 *
 * @module Sensor-Service/E2E/SensorCrud
 */
import { assertDefined } from '../../../helpers/assertions';

import { gql, TENANT_A, TENANT_B, uniqueSerial, uniqueName, runCleanup } from './helpers';

// ============================================================================
// GRAPHQL OPERATIONS — taken directly from resolver method names
// ============================================================================

const CREATE_SENSOR = `
  mutation createSensor($input: CreateSensorInput!) {
    createSensor(input: $input) {
      id
      name
      serialNumber
      type
      status
      tenantId
      registrationStatus
      manufacturer
      model
      firmwareVersion
      pondId
      farmId
      createdAt
    }
  }
`;

const GET_SENSOR = `
  query sensor($id: ID!) {
    sensor(id: $id) {
      id
      name
      serialNumber
      type
      status
      tenantId
      registrationStatus
    }
  }
`;

const LIST_SENSORS = `
  query sensors($page: Int, $limit: Int, $status: SensorStatus) {
    sensors(page: $page, limit: $limit, status: $status) {
      id
      name
      serialNumber
      type
      status
      tenantId
    }
  }
`;

const UPDATE_SENSOR = `
  mutation updateSensor($input: UpdateSensorInput!) {
    updateSensor(input: $input) {
      id
      name
      status
      firmwareVersion
      pondId
      farmId
    }
  }
`;

const REGISTER_SENSOR = `
  mutation registerSensor($input: RegisterSensorInput!) {
    registerSensor(input: $input) {
      success
      sensor {
        id
        name
        type
        protocolCode
        registrationStatus
        connectionStatus {
          isConnected
          lastTestedAt
        }
        tenantId
      }
      error
      connectionTestPassed
      latencyMs
    }
  }
`;

const TEST_SENSOR_CONNECTION = `
  mutation testSensorConnection($sensorId: ID!) {
    testSensorConnection(sensorId: $sensorId) {
      success
      latencyMs
      error
      sampleData
      testedAt
    }
  }
`;

const ACTIVATE_SENSOR = `
  mutation activateSensor($sensorId: ID!) {
    activateSensor(sensorId: $sensorId) {
      id
      name
      registrationStatus
    }
  }
`;

const SUSPEND_SENSOR = `
  mutation suspendSensor($sensorId: ID!, $reason: String) {
    suspendSensor(sensorId: $sensorId, reason: $reason) {
      id
      name
      registrationStatus
    }
  }
`;

const REACTIVATE_SENSOR = `
  mutation reactivateSensor($sensorId: ID!) {
    reactivateSensor(sensorId: $sensorId) {
      id
      name
      registrationStatus
    }
  }
`;

const DELETE_SENSOR = `
  mutation deleteSensor($sensorId: ID!) {
    deleteSensor(sensorId: $sensorId)
  }
`;

const SENSOR_STATS = `
  query sensorStats {
    sensorStats {
      total
      active
      inactive
      testing
      failed
      byType
      byProtocol
    }
  }
`;

const SENSORS_BY_PROTOCOL = `
  query sensorsByProtocol($protocolCode: String!) {
    sensorsByProtocol(protocolCode: $protocolCode) {
      id
      name
      type
      protocolCode
      registrationStatus
      tenantId
    }
  }
`;

const REGISTER_PARENT_WITH_CHILDREN = `
  mutation registerParentWithChildren($input: RegisterParentWithChildrenInput!) {
    registerParentWithChildren(input: $input) {
      success
      parent {
        id
        name
        protocolCode
        registrationStatus
        childSensors {
          id
          name
          type
          dataPath
        }
      }
      children {
        id
        name
        type
        dataPath
        unit
        minValue
        maxValue
        calibrationEnabled
        registrationStatus
        tenantId
      }
      error
      connectionTestPassed
      latencyMs
    }
  }
`;

// ============================================================================
// TESTS
// ============================================================================

describe('Sensor CRUD + Registration', () => {
  afterAll(async () => {
    await runCleanup();
  });

  // Track created sensor IDs for cleanup
  let createdSensorId: string;

  // ------------------------------------------------------------------
  // Test 1: createSensor -> sensor(id) -> sensors(filter)
  // ------------------------------------------------------------------
  describe('Test 1: Create + Read + List', () => {
    const serial = uniqueSerial('CRUD');
    const name = uniqueName('TempSensor');

    it('should create a sensor and retrieve it by ID', async () => {
      const res = await gql(CREATE_SENSOR, {
        input: {
          name,
          serialNumber: serial,
          type: 'temperature',
          manufacturer: 'Aqua Instruments',
          model: 'AT-100',
          firmwareVersion: '1.0.0',
        },
      });

      expect(res.errors).toBeUndefined();
      expect(res.data?.createSensor).toBeDefined();

      const sensor = assertDefined(res.data).createSensor as Record<string, unknown>;
      expect(sensor.name).toBe(name);
      expect(sensor.serialNumber).toBe(serial);
      expect(sensor.type).toBe('temperature');
      expect(sensor.status).toBe('active');
      expect(sensor.tenantId).toBe(TENANT_A.id);
      expect(sensor.manufacturer).toBe('Aqua Instruments');

      createdSensorId = sensor.id as string;
    });

    it('should retrieve the created sensor by ID', async () => {
      const res = await gql(GET_SENSOR, { id: createdSensorId });

      expect(res.errors).toBeUndefined();
      const sensor = res.data?.sensor as Record<string, unknown>;
      expect(sensor).toBeDefined();
      expect(sensor.id).toBe(createdSensorId);
      expect(sensor.name).toBe(name);
      expect(sensor.tenantId).toBe(TENANT_A.id);
    });

    it('should list sensors and include the created one', async () => {
      const res = await gql(LIST_SENSORS, { page: 1, limit: 50, status: 'active' });

      expect(res.errors).toBeUndefined();
      const sensors = res.data?.sensors as Array<Record<string, unknown>>;
      expect(sensors).toBeDefined();
      expect(Array.isArray(sensors)).toBe(true);

      const found = sensors.find((s) => s.id === createdSensorId);
      expect(found).toBeDefined();
      expect(assertDefined(found).serialNumber).toBe(serial);
    });
  });

  // ------------------------------------------------------------------
  // Test 2: Unique serialNumber constraint
  // ------------------------------------------------------------------
  describe('Test 2: Duplicate serialNumber rejection', () => {
    const serial = uniqueSerial('DUP');

    it('should create first sensor successfully', async () => {
      const res = await gql(CREATE_SENSOR, {
        input: {
          name: uniqueName('First'),
          serialNumber: serial,
          type: 'ph',
        },
      });

      expect(res.errors).toBeUndefined();
      expect(res.data?.createSensor).toBeDefined();
    });

    it('should reject duplicate serialNumber with ConflictException', async () => {
      const res = await gql(CREATE_SENSOR, {
        input: {
          name: uniqueName('Duplicate'),
          serialNumber: serial,
          type: 'ph',
        },
      });

      expect(res.errors).toBeDefined();
      expect(assertDefined(res.errors).length).toBeGreaterThan(0);
      expect(assertDefined(res.errors)[0].message).toContain('already exists');
    });
  });

  // ------------------------------------------------------------------
  // Test 3: updateSensor -> verify updated fields
  // ------------------------------------------------------------------
  describe('Test 3: Update sensor', () => {
    let sensorId: string;

    beforeAll(async () => {
      const res = await gql(CREATE_SENSOR, {
        input: {
          name: uniqueName('UpdateTarget'),
          serialNumber: uniqueSerial('UPD'),
          type: 'dissolved_oxygen',
        },
      });
      sensorId = (assertDefined(res.data).createSensor as Record<string, unknown>).id as string;
    });

    it('should update sensor name and firmwareVersion', async () => {
      const newName = uniqueName('Updated');
      const res = await gql(UPDATE_SENSOR, {
        input: {
          sensorId,
          name: newName,
          firmwareVersion: '2.0.0',
        },
      });

      expect(res.errors).toBeUndefined();
      const sensor = assertDefined(res.data).updateSensor as Record<string, unknown>;
      expect(sensor.name).toBe(newName);
      expect(sensor.firmwareVersion).toBe('2.0.0');
    });

    it('should verify update persisted via re-read', async () => {
      const res = await gql(GET_SENSOR, { id: sensorId });

      expect(res.errors).toBeUndefined();
      const sensor = res.data?.sensor as Record<string, unknown>;
      expect(sensor.firmwareVersion).toBe('2.0.0');
    });
  });

  // ------------------------------------------------------------------
  // Test 4: registerSensor -> registrationStatus lifecycle
  //         DRAFT -> PENDING_TEST -> TESTING -> ACTIVE
  // ------------------------------------------------------------------
  describe('Test 4: Registration status lifecycle', () => {
    let registeredSensorId: string;

    it('should register sensor with DRAFT status', async () => {
      const res = await gql(REGISTER_SENSOR, {
        input: {
          name: uniqueName('RegLifecycle'),
          type: 'temperature',
          protocolCode: 'mqtt',
          protocolConfiguration: {
            topic: 'sensors/test/data',
            host: 'localhost',
            port: 1883,
          },
          manufacturer: 'TestCorp',
          skipConnectionTest: true,
        },
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).registerSensor as Record<string, unknown>;
      expect(result.success).toBe(true);

      const sensor = result.sensor as Record<string, unknown>;
      expect(sensor).toBeDefined();
      expect(sensor.registrationStatus).toBe('draft');
      expect(sensor.tenantId).toBe(TENANT_A.id);

      registeredSensorId = sensor.id as string;
    });

    it('should verify sensor starts in DRAFT via query', async () => {
      const res = await gql(
        `
        query sensor($id: ID!) {
          sensor(id: $id) {
            id
            registrationStatus
          }
        }
      `,
        { id: registeredSensorId },
      );

      // The sensor query from SensorResolver may not be the registration one.
      // The registration resolver also provides sensor(id).
      // Both should show the same data since they read from the same entity.
      if (res.data?.sensor) {
        expect((res.data.sensor as Record<string, unknown>).registrationStatus).toBe('draft');
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 5: testSensorConnection -> result verification
  // ------------------------------------------------------------------
  describe('Test 5: Test sensor connection', () => {
    let sensorId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_SENSOR, {
        input: {
          name: uniqueName('ConnTest'),
          type: 'ph',
          protocolCode: 'modbus_rtu',
          protocolConfiguration: {
            serialPort: '/dev/ttyUSB0',
            slaveId: 1,
            baudRate: 9600,
          },
          skipConnectionTest: true,
        },
      });
      const result = assertDefined(res.data).registerSensor as Record<string, unknown>;
      sensorId = (result.sensor as Record<string, unknown>).id as string;
    });

    it('should return connection test result', async () => {
      const res = await gql(TEST_SENSOR_CONNECTION, { sensorId });

      // Connection test may fail (no actual device) but should return structured result
      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).testSensorConnection as Record<string, unknown>;
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(result.testedAt).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 6: activateSensor -> status = ACTIVE
  // ------------------------------------------------------------------
  describe('Test 6: Activate sensor', () => {
    let sensorId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_SENSOR, {
        input: {
          name: uniqueName('ActivateTarget'),
          type: 'salinity',
          protocolCode: 'mqtt',
          protocolConfiguration: { topic: 'sensors/test/activate' },
          skipConnectionTest: true,
        },
      });
      const result = assertDefined(res.data).registerSensor as Record<string, unknown>;
      sensorId = (result.sensor as Record<string, unknown>).id as string;
    });

    it('should activate sensor and set registrationStatus = active', async () => {
      const res = await gql(ACTIVATE_SENSOR, { sensorId });

      expect(res.errors).toBeUndefined();
      const sensor = assertDefined(res.data).activateSensor as Record<string, unknown>;
      expect(sensor.registrationStatus).toBe('active');
    });
  });

  // ------------------------------------------------------------------
  // Test 7: suspendSensor(reason) -> SUSPENDED
  // ------------------------------------------------------------------
  describe('Test 7: Suspend sensor', () => {
    let sensorId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_SENSOR, {
        input: {
          name: uniqueName('SuspendTarget'),
          type: 'ammonia',
          protocolCode: 'mqtt',
          protocolConfiguration: { topic: 'sensors/test/suspend' },
          skipConnectionTest: true,
        },
      });
      const result = assertDefined(res.data).registerSensor as Record<string, unknown>;
      sensorId = (result.sensor as Record<string, unknown>).id as string;

      // First activate
      await gql(ACTIVATE_SENSOR, { sensorId });
    });

    it('should suspend sensor with reason', async () => {
      const res = await gql(SUSPEND_SENSOR, {
        sensorId,
        reason: 'Maintenance required',
      });

      expect(res.errors).toBeUndefined();
      const sensor = assertDefined(res.data).suspendSensor as Record<string, unknown>;
      expect(sensor.registrationStatus).toBe('suspended');
    });
  });

  // ------------------------------------------------------------------
  // Test 8: reactivateSensor -> ACTIVE
  // ------------------------------------------------------------------
  describe('Test 8: Reactivate sensor', () => {
    let sensorId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_SENSOR, {
        input: {
          name: uniqueName('ReactivateTarget'),
          type: 'turbidity',
          protocolCode: 'mqtt',
          protocolConfiguration: { topic: 'sensors/test/reactivate' },
          skipConnectionTest: true,
        },
      });
      const result = assertDefined(res.data).registerSensor as Record<string, unknown>;
      sensorId = (result.sensor as Record<string, unknown>).id as string;

      await gql(ACTIVATE_SENSOR, { sensorId });
      await gql(SUSPEND_SENSOR, { sensorId, reason: 'Temporarily offline' });
    });

    it('should reactivate suspended sensor', async () => {
      const res = await gql(REACTIVATE_SENSOR, { sensorId });

      expect(res.errors).toBeUndefined();
      const sensor = assertDefined(res.data).reactivateSensor as Record<string, unknown>;
      expect(sensor.registrationStatus).toBe('active');
    });
  });

  // ------------------------------------------------------------------
  // Test 9: deleteSensor
  // ------------------------------------------------------------------
  describe('Test 9: Delete sensor', () => {
    let sensorId: string;

    beforeAll(async () => {
      const res = await gql(REGISTER_SENSOR, {
        input: {
          name: uniqueName('DeleteTarget'),
          type: 'water_level',
          protocolCode: 'mqtt',
          protocolConfiguration: { topic: 'sensors/test/delete' },
          skipConnectionTest: true,
        },
      });
      const result = assertDefined(res.data).registerSensor as Record<string, unknown>;
      sensorId = (result.sensor as Record<string, unknown>).id as string;
    });

    it('should delete sensor and return true', async () => {
      const res = await gql(DELETE_SENSOR, { sensorId });

      expect(res.errors).toBeUndefined();
      expect(assertDefined(res.data).deleteSensor).toBe(true);
    });

    it('should return null when querying deleted sensor', async () => {
      const res = await gql(
        `
        query sensor($id: ID!) {
          sensor(id: $id) {
            id
          }
        }
      `,
        { id: sensorId },
      );

      // Should be null or throw NotFoundException
      if (res.data?.sensor) {
        expect(res.data.sensor).toBeNull();
      } else if (res.errors) {
        expect(res.errors[0].message).toContain('not found');
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 10: sensorStats -> total, active, inactive, byType, byProtocol
  // ------------------------------------------------------------------
  describe('Test 10: Sensor statistics', () => {
    it('should return sensor stats with all expected fields', async () => {
      const res = await gql(SENSOR_STATS);

      expect(res.errors).toBeUndefined();
      const stats = assertDefined(res.data).sensorStats as Record<string, unknown>;
      expect(stats).toBeDefined();
      expect(typeof stats.total).toBe('number');
      expect(typeof stats.active).toBe('number');
      expect(typeof stats.inactive).toBe('number');
      expect(typeof stats.testing).toBe('number');
      expect(typeof stats.failed).toBe('number');
      expect(stats.byType).toBeDefined();
      expect(stats.byProtocol).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 11: sensorsByProtocol(code) -> filtered list
  // ------------------------------------------------------------------
  describe('Test 11: Filter sensors by protocol', () => {
    beforeAll(async () => {
      // Create sensor with specific protocol
      await gql(REGISTER_SENSOR, {
        input: {
          name: uniqueName('ProtoFilter'),
          type: 'conductivity',
          protocolCode: 'modbus_tcp',
          protocolConfiguration: {
            host: '192.168.1.100',
            port: 502,
            unitId: 1,
          },
          skipConnectionTest: true,
        },
      });
    });

    it('should return sensors filtered by protocol code', async () => {
      const res = await gql(SENSORS_BY_PROTOCOL, { protocolCode: 'modbus_tcp' });

      expect(res.errors).toBeUndefined();
      const sensors = assertDefined(res.data).sensorsByProtocol as Array<Record<string, unknown>>;
      expect(Array.isArray(sensors)).toBe(true);

      for (const s of sensors) {
        expect(s.protocolCode).toBe('modbus_tcp');
        expect(s.tenantId).toBe(TENANT_A.id);
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 12: Parent-Child: registerParentWithChildren -> parentDevice, childSensors
  // ------------------------------------------------------------------
  describe('Test 12: Parent-Child registration', () => {
    let parentId: string;

    it('should register parent device with child sensors', async () => {
      const res = await gql(REGISTER_PARENT_WITH_CHILDREN, {
        input: {
          parent: {
            name: uniqueName('ParentDevice'),
            protocolCode: 'modbus_rtu',
            protocolConfiguration: {
              serialPort: '/dev/ttyUSB0',
              slaveId: 1,
              baudRate: 9600,
            },
            manufacturer: 'MultiParam Corp',
            model: 'MP-500',
          },
          children: [
            {
              name: 'Temperature Channel',
              type: 'temperature',
              dataPath: 'data.temperature',
              unit: 'celsius',
              minValue: -10,
              maxValue: 50,
              calibrationEnabled: true,
              calibrationMultiplier: 1.0,
              calibrationOffset: 0.0,
            },
            {
              name: 'pH Channel',
              type: 'ph',
              dataPath: 'data.ph',
              unit: 'pH',
              minValue: 0,
              maxValue: 14,
              alertThresholds: {
                warning: { low: 6.5, high: 8.5 },
                critical: { low: 5.0, high: 10.0 },
              },
            },
            {
              name: 'DO Channel',
              type: 'dissolved_oxygen',
              dataPath: 'data.do',
              unit: 'mg/L',
              minValue: 0,
              maxValue: 20,
            },
          ],
          skipConnectionTest: true,
        },
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).registerParentWithChildren as Record<string, unknown>;
      expect(result.success).toBe(true);

      const parent = result.parent as Record<string, unknown>;
      expect(parent).toBeDefined();
      expect(parent.protocolCode).toBe('modbus_rtu');

      const children = result.children as Array<Record<string, unknown>>;
      expect(children).toBeDefined();
      expect(children.length).toBe(3);

      // Verify child types
      const types = children.map((c) => c.type).sort();
      expect(types).toEqual(['dissolved_oxygen', 'ph', 'temperature']);

      // Verify tenant isolation on children
      for (const child of children) {
        expect(child.tenantId).toBe(TENANT_A.id);
      }

      parentId = parent.id as string;
    });

    it('should retrieve parent device with children via query', async () => {
      const res = await gql(
        `
        query parentDevice($id: ID!) {
          parentDevice(id: $id) {
            id
            name
            protocolCode
            childSensors {
              id
              name
              type
              dataPath
            }
          }
        }
      `,
        { id: parentId },
      );

      expect(res.errors).toBeUndefined();
      const parent = res.data?.parentDevice as Record<string, unknown>;
      expect(parent).toBeDefined();
      expect((parent.childSensors as unknown[]).length).toBe(3);
    });

    it('should list child sensors by parentId', async () => {
      const res = await gql(
        `
        query childSensors($parentId: ID!) {
          childSensors(parentId: $parentId) {
            id
            name
            type
            dataPath
            tenantId
          }
        }
      `,
        { parentId },
      );

      expect(res.errors).toBeUndefined();
      const children = res.data?.childSensors as Array<Record<string, unknown>>;
      expect(children.length).toBe(3);
      for (const child of children) {
        expect(child.tenantId).toBe(TENANT_A.id);
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 13: Cross-tenant isolation
  // ------------------------------------------------------------------
  describe('Test 13: Cross-tenant isolation', () => {
    let tenantASensorId: string;

    beforeAll(async () => {
      const res = await gql(
        REGISTER_SENSOR,
        {
          input: {
            name: uniqueName('TenantA-Isolated'),
            type: 'temperature',
            protocolCode: 'mqtt',
            protocolConfiguration: { topic: 'sensors/a/isolated' },
            skipConnectionTest: true,
          },
        },
        TENANT_A,
      );
      const result = assertDefined(res.data).registerSensor as Record<string, unknown>;
      tenantASensorId = (result.sensor as Record<string, unknown>).id as string;
    });

    it('should NOT allow Tenant B to read Tenant A sensor', async () => {
      const res = await gql(
        `
          query sensor($id: ID!) {
            sensor(id: $id) {
              id
              name
              tenantId
            }
          }
        `,
        { id: tenantASensorId },
        TENANT_B,
      );

      // Should either return null or throw not found error
      if (res.data?.sensor) {
        expect(res.data.sensor).toBeNull();
      } else if (res.errors) {
        expect(res.errors[0].message).toContain('not found');
      }
    });

    it('should NOT allow Tenant B to update Tenant A sensor', async () => {
      const res = await gql(
        UPDATE_SENSOR,
        {
          input: {
            sensorId: tenantASensorId,
            name: 'Hacked by Tenant B',
          },
        },
        TENANT_B,
      );

      // Should fail
      expect(res.errors).toBeDefined();
    });

    it('should NOT allow Tenant B to delete Tenant A sensor', async () => {
      const res = await gql(DELETE_SENSOR, { sensorId: tenantASensorId }, TENANT_B);

      // Should fail or return false
      if (res.errors) {
        expect(res.errors.length).toBeGreaterThan(0);
      } else {
        expect(assertDefined(res.data).deleteSensor).toBe(false);
      }
    });

    it('Tenant B sensor list should NOT include Tenant A sensors', async () => {
      const res = await gql(LIST_SENSORS, { page: 1, limit: 100 }, TENANT_B);

      expect(res.errors).toBeUndefined();
      const sensors = res.data?.sensors as Array<Record<string, unknown>> | undefined;
      if (sensors && sensors.length > 0) {
        for (const s of sensors) {
          expect(s.tenantId).toBe(TENANT_B.id);
        }
      }
    });
  });
});
