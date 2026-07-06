/**
 * SENSOR-MEDIUM-004 — the edge device directory gives an O(1) device→tenant
 * route so public/MQTT-auth lookups no longer UNION-ALL scan every tenant
 * schema on each request.
 */
import { DeviceDirectoryService } from '../device-directory.service';
import { MqttAuthService } from '../mqtt-auth.service';

describe('DeviceDirectoryService (SENSOR-MEDIUM-004)', () => {
  it('resolves tenantId by the mapped directory column', async () => {
    const query = jest.fn().mockResolvedValue([{ tenant_id: 'tenant-1' }]);
    const svc = new DeviceDirectoryService({ query, manager: { query } } as never);

    await expect(svc.lookupTenantId('mqtt_client_id', 'edge-x')).resolves.toBe('tenant-1');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"mqtt_client_id" = $1'),
      ['edge-x'],
    );

    await svc.lookupTenantId('id', 'dev-1');
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('"device_id" = $1'), ['dev-1']);
  });

  it('returns null on a directory miss', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new DeviceDirectoryService({ query, manager: { query } } as never);
    await expect(svc.lookupTenantId('device_code', 'nope')).resolves.toBeNull();
  });

  it('upserts through the supplied transactional manager, keyed on device_id', async () => {
    const mgrQuery = jest.fn().mockResolvedValue(undefined);
    const svc = new DeviceDirectoryService({ manager: { query: jest.fn() } } as never);

    await svc.upsert(
      { deviceId: 'd1', deviceCode: 'C1', mqttClientId: 'm1', tenantId: 't1' },
      { query: mgrQuery } as never,
    );
    expect(mgrQuery).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (device_id) DO UPDATE'),
      ['d1', 'C1', 'm1', 't1'],
    );
  });

  it('backfill never throws even when the write fails', async () => {
    const query = jest.fn().mockRejectedValue(new Error('boom'));
    const svc = new DeviceDirectoryService({ query, manager: { query } } as never);
    await expect(
      svc.backfill({ deviceId: 'd', deviceCode: 'c', tenantId: 't' }),
    ).resolves.toBeUndefined();
  });
});

describe('MQTT-auth device resolution is O(1) on a directory hit (SENSOR-MEDIUM-004)', () => {
  const config = { get: (_k: string, fallback?: unknown) => fallback };

  it('issues a single targeted query and never scans information_schema on a hit', async () => {
    const tenantId = '0123456789abcdef0123456789abcdef';
    const query = jest.fn().mockResolvedValue([
      { id: 'dev-1', tenant_id: tenantId, device_code: 'EDGE-1', mqtt_client_id: 'edge-1', mqtt_password_hash: '$7$600000$x$y' },
    ]);
    const directory = {
      lookupTenantId: jest.fn().mockResolvedValue(tenantId),
      backfill: jest.fn(),
      upsert: jest.fn(),
      remove: jest.fn(),
    };
    const service = new MqttAuthService(
      config as never,
      {} as never, // repository — unused on this path
      { query } as never,
      directory as never,
    );

    // verifyDeviceCredentials -> findDeviceAcrossSchemas('mqtt_client_id', ...)
    await service.verifyDeviceCredentials('edge-1', 'irrelevant');

    expect(directory.lookupTenantId).toHaveBeenCalledWith('mqtt_client_id', 'edge-1');
    // The one DB query is the tenant-scoped edge_devices lookup...
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"tenant_0123456789abcdef".edge_devices'),
      ['edge-1'],
    );
    // ...and NOT the cross-schema fan-out.
    for (const call of query.mock.calls) {
      expect(String(call[0])).not.toContain('information_schema.schemata');
    }
  });
});
