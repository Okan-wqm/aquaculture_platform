/**
 * SENSOR-MEDIUM-004 / SENSOR-CRITICAL-143 — the edge device directory gives an
 * O(1) device→tenant route for public / MQTT-auth lookups, and every read
 * happens inside a tenant-isolation boundary:
 *   - the directory row through runInSourceRead (cross-tenant by design),
 *   - the device row inside the owning tenant's runInTenantRead,
 *   - a miss is a miss: no tenant scan on the unauthenticated path; every
 *     device is published to the directory by saveNewDevice when created.
 * The boundaries themselves are proven on real Postgres in
 * edge-mqtt-auth.rls.postgres.spec.ts; this spec pins the orchestration.
 */
import {
  runInSourceRead,
  runInTenantRead,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';

import { ConfigService } from '@nestjs/config';
import { collaborator, stub } from '@aquaculture/testing';
import type { DataSource, EntityManager } from 'typeorm';

import { DeviceDirectoryService } from '../device-directory.service';
import { EdgeDevice } from '../entities/edge-device.entity';
import { MqttAuthService } from '../mqtt-auth.service';

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    runInSourceRead: jest.fn(),
    runInTenantRead: jest.fn(),
    tenantManagerRepo: jest.fn(),
  };
});

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = { id: 'dev-1', tenantId: TENANT_B, deviceCode: 'EDGE-1', mqttClientId: 'edge-1' };

describe('DeviceDirectoryService (SENSOR-MEDIUM-004 / SENSOR-CRITICAL-143)', () => {
  let directoryQuery: jest.Mock;
  let findOneByTenant: Map<string, unknown>;
  const dataSource = stub<DataSource>({});

  beforeEach(() => {
    jest.clearAllMocks();
    directoryQuery = jest.fn().mockResolvedValue([]);
    findOneByTenant = new Map();
    (runInSourceRead as jest.Mock).mockImplementation((_ds, schema: string, fn) => {
      expect(schema).toBe('sensor');
      return fn({ query: directoryQuery });
    });
    let currentTenant = '';
    (runInTenantRead as jest.Mock).mockImplementation((_ds, _schema, tenantId: string, fn) => {
      currentTenant = tenantId;
      return fn({ manager: {} });
    });
    (tenantManagerRepo as jest.Mock).mockImplementation(() => ({
      findOne: jest.fn(async () => findOneByTenant.get(currentTenant) ?? null),
    }));
  });

  it('resolves tenantId through the sanctioned source-schema read, by the mapped column', async () => {
    directoryQuery.mockResolvedValue([{ tenant_id: TENANT_B }]);
    const svc = new DeviceDirectoryService(dataSource);

    await expect(svc.lookupTenantId('mqtt_client_id', 'edge-1')).resolves.toBe(TENANT_B);
    expect(directoryQuery).toHaveBeenCalledWith(expect.stringContaining('"mqtt_client_id" = $1'), [
      'edge-1',
    ]);
    await svc.lookupTenantId('id', 'dev-1');
    expect(directoryQuery).toHaveBeenLastCalledWith(expect.stringContaining('"device_id" = $1'), [
      'dev-1',
    ]);
  });

  it('on a directory hit reads only the owning tenant', async () => {
    directoryQuery.mockResolvedValue([{ tenant_id: TENANT_B }]);
    findOneByTenant.set(TENANT_B, DEVICE);
    const svc = new DeviceDirectoryService(dataSource);

    await expect(svc.findDevice('mqtt_client_id', 'edge-1')).resolves.toBe(DEVICE);
    expect(runInTenantRead).toHaveBeenCalledTimes(1);
    expect((runInTenantRead as jest.Mock).mock.calls[0]?.[2]).toBe(TENANT_B);
  });

  it('on a directory miss returns null without opening any tenant boundary', async () => {
    findOneByTenant.set(TENANT_A, DEVICE);
    findOneByTenant.set(TENANT_B, DEVICE);
    const svc = new DeviceDirectoryService(dataSource);

    await expect(svc.findDevice('device_code', 'EDGE-1')).resolves.toBeNull();
    expect(runInTenantRead).not.toHaveBeenCalled();
  });

  it('a directory row naming the wrong tenant resolves nothing', async () => {
    directoryQuery.mockResolvedValue([{ tenant_id: TENANT_A }]);
    findOneByTenant.set(TENANT_B, DEVICE);
    const svc = new DeviceDirectoryService(dataSource);

    await expect(svc.findDevice('mqtt_client_id', 'edge-1')).resolves.toBeNull();
    expect((runInTenantRead as jest.Mock).mock.calls.map((call) => call[2])).toEqual([TENANT_A]);
  });

  it('saveNewDevice saves the device and its route through the SAME manager', async () => {
    const device = Object.assign(new EdgeDevice(), { deviceCode: 'C1', mqttClientId: 'm1' });
    const saved = Object.assign(new EdgeDevice(), {
      id: 'd1',
      tenantId: 't1',
      deviceCode: 'C1',
      mqttClientId: 'm1',
    });
    const save = jest.fn().mockResolvedValue(saved);
    const query = jest.fn().mockResolvedValue(undefined);
    const svc = new DeviceDirectoryService(dataSource);

    await expect(svc.saveNewDevice(device, stub<EntityManager>({ save, query }))).resolves.toBe(
      saved,
    );
    expect(save).toHaveBeenCalledWith(device);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (device_id) DO UPDATE'),
      ['d1', 'C1', 'm1', 't1'],
    );
  });

  it('saveNewDevice publishes no route when the device save fails', async () => {
    const save = jest.fn().mockRejectedValue(new Error('23505'));
    const query = jest.fn();
    const svc = new DeviceDirectoryService(dataSource);

    await expect(
      svc.saveNewDevice(new EdgeDevice(), stub<EntityManager>({ save, query })),
    ).rejects.toThrow('23505');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('MQTT-auth negative-result cache bounds unknown-username floods (SENSOR-MEDIUM-004)', () => {
  function service(): { auth: MqttAuthService; findDevice: jest.Mock } {
    const findDevice = jest.fn().mockResolvedValue(null);
    const directory = collaborator<DeviceDirectoryService>(
      { findDevice },
      'DeviceDirectoryService',
    );
    return { auth: new MqttAuthService(new ConfigService({}), directory), findDevice };
  }

  it('resolves a repeated unknown client id once, then serves the negative cache (ACL path)', async () => {
    const { auth, findDevice } = service();
    const topic = 'tenants/abc123/devices/edge-unknown/data';
    await auth.checkTopicAccess('edge-unknown', topic, 1);
    await auth.checkTopicAccess('edge-unknown', topic, 1);
    expect(findDevice).toHaveBeenCalledTimes(1);
  });

  it('also bounds the unauthenticated verifyDeviceCredentials (CONNECT) path', async () => {
    const { auth, findDevice } = service();
    await auth.verifyDeviceCredentials('edge-flooder', 'pw', 'edge-flooder');
    await auth.verifyDeviceCredentials('edge-flooder', 'pw', 'edge-flooder');
    expect(findDevice).toHaveBeenCalledTimes(1);
  });
});
