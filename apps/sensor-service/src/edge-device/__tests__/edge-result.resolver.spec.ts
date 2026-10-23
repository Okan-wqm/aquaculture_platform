import 'reflect-metadata';

import { collaborator } from '@aquaculture/testing';
import { Role, ROLES_KEY } from '@aquaculture/backend-common/decorators';

import type { EdgeDeviceService } from '../edge-device.service';
import { EdgeDeviceResultResolver } from '../edge-result.resolver';
import type { EdgeResultTelemetryService } from '../edge-result-telemetry.service';
import { EdgeDeviceResult } from '../entities/edge-device-result.entity';
import { EdgeDevice } from '../entities/edge-device.entity';

const TENANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';

function harness(owned: boolean): {
  resolver: EdgeDeviceResultResolver;
  list: jest.Mock;
  latestByKind: jest.Mock;
  count: jest.Mock;
  findById: jest.Mock;
} {
  const rows = [Object.assign(new EdgeDeviceResult(), { seq: 4, kind: 'edge-update' })];
  const list = jest.fn().mockResolvedValue(rows);
  const latestByKind = jest.fn().mockResolvedValue(rows);
  const count = jest.fn().mockResolvedValue(7);
  const findById = jest.fn().mockResolvedValue(owned ? new EdgeDevice() : null);
  return {
    resolver: new EdgeDeviceResultResolver(
      collaborator<EdgeResultTelemetryService>({ list, latestByKind, count }, 'results'),
      collaborator<EdgeDeviceService>({ findById }, 'devices'),
    ),
    list,
    latestByKind,
    count,
    findById,
  };
}

describe('EdgeDeviceResultResolver', () => {
  it.each(['edgeDeviceResults', 'edgeDeviceResultSummary'])(
    '%s needs a tenant admin or module manager',
    (name) => {
      const handler = EdgeDeviceResultResolver.prototype[
        name as keyof EdgeDeviceResultResolver
      ] as object;
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        Role.TENANT_ADMIN,
        Role.MODULE_MANAGER,
      ]);
    },
  );

  it("lists the results of a device of the caller's tenant", async () => {
    const { resolver, list, findById } = harness(true);
    await expect(
      resolver.edgeDeviceResults(TENANT, DEVICE, 'edge-update', 10),
    ).resolves.toHaveLength(1);
    expect(findById).toHaveBeenCalledWith(DEVICE, TENANT);
    expect(list).toHaveBeenCalledWith(TENANT, DEVICE, { kind: 'edge-update', limit: 10 });
  });

  it('answers a device of another tenant like a device that does not exist', async () => {
    const { resolver, list, latestByKind, count } = harness(false);
    await expect(resolver.edgeDeviceResults(TENANT, DEVICE)).resolves.toEqual([]);
    await expect(resolver.edgeDeviceResultSummary(TENANT, DEVICE)).resolves.toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(latestByKind).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('summarizes the newest result per kind and how many are stored', async () => {
    const { resolver } = harness(true);
    const summary = await resolver.edgeDeviceResultSummary(TENANT, DEVICE);
    expect(summary).toMatchObject({ deviceId: DEVICE, stored: 7 });
    expect(summary?.latestByKind).toHaveLength(1);
  });
});
