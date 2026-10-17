/**
 * EdgeDeviceService.getStats — tenant-wide device counts behind edgeDeviceStats.
 *
 * The stats query groups by (lifecycle_state, device_model) so it can return
 * byState / byModel, which makes each row's total/online/offline a per-group
 * count. The tenant totals are the SUM over the groups; reading them from any
 * one row reports a single group as the whole fleet (the Devices pages read
 * these totals).
 *
 * total/online/offline count every device the tenant ever registered, the
 * decommissioned and revoked ones too (decommissioning keeps the row). The
 * console's "11 of 12 devices online" cell asks about the fleet in service,
 * so inService / onlineInService leave the terminal lifecycle states out —
 * decided by the entity's isTerminalLifecycleState, not by a copy in a client.
 */
import { ConfigService } from '@nestjs/config';
import { collaborator } from '@aquaculture/testing';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { type DataSource, type QueryRunner, type Repository } from 'typeorm';

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: jest.fn(),
}));
import { runInTenantRead } from '@aquaculture/backend-common/database';

import { DeviceDirectoryService } from '../device-directory.service';
import { EdgeDeviceService } from '../edge-device.service';
import { InstallerScriptService } from '../installer-script.service';
import { DeviceIoConfig } from '../entities/device-io-config.entity';
import { DeviceLifecycleState, DeviceModel, EdgeDevice } from '../entities/edge-device.entity';
import { LoRaDevice } from '../entities/lora-device.entity';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

interface StatsRow {
  total: string;
  online: string;
  offline: string;
  lifecycle_state: DeviceLifecycleState;
  device_model: DeviceModel;
  count: string;
}

function group(
  lifecycleState: DeviceLifecycleState,
  deviceModel: DeviceModel,
  online: number,
  offline: number,
): StatsRow {
  const total = online + offline;
  return {
    total: String(total),
    online: String(online),
    offline: String(offline),
    lifecycle_state: lifecycleState,
    device_model: deviceModel,
    count: String(total),
  };
}

function answerStats(rows: StatsRow[]): void {
  jest
    .mocked(runInTenantRead)
    .mockImplementation(async (_ds, _schema, _tenantId, fn) =>
      fn(collaborator<QueryRunner>({ query: jest.fn().mockResolvedValue(rows) }, 'QueryRunner')),
    );
}

function makeService(): EdgeDeviceService {
  // getStats reads through runInTenantRead (mocked above) alone: no repository,
  // installer or directory member is on its path, so any access names itself.
  return new EdgeDeviceService(
    collaborator<Repository<EdgeDevice>>({}, 'EdgeDeviceRepository'),
    collaborator<Repository<DeviceIoConfig>>({}, 'DeviceIoConfigRepository'),
    collaborator<Repository<LoRaDevice>>({}, 'LoRaDeviceRepository'),
    collaborator<DataSource>({}, 'DataSource'),
    createScheduledJobTestExecutor().executor,
    null,
    collaborator<InstallerScriptService>({}, 'InstallerScriptService'),
    collaborator<ConfigService>({ get: jest.fn() }, 'ConfigService'),
    collaborator<DeviceDirectoryService>({}, 'DeviceDirectoryService'),
  );
}

describe('EdgeDeviceService.getStats', () => {
  let service: EdgeDeviceService;

  beforeEach(() => {
    jest.mocked(runInTenantRead).mockReset();
    service = makeService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('sums total, online and offline over every (state, model) group', async () => {
    answerStats([
      group(DeviceLifecycleState.ACTIVE, DeviceModel.RASPBERRY_PI_5, 9, 1),
      group(DeviceLifecycleState.ACTIVE, DeviceModel.INDUSTRIAL_PC, 2, 0),
      group(DeviceLifecycleState.MAINTENANCE, DeviceModel.RASPBERRY_PI_5, 0, 3),
    ]);

    const stats = await service.getStats(TENANT_ID);

    expect(stats.total).toBe(15);
    expect(stats.online).toBe(11);
    expect(stats.offline).toBe(4);
    expect(stats.inService).toBe(15);
    expect(stats.onlineInService).toBe(11);
    expect(stats.byState).toEqual([
      { state: DeviceLifecycleState.ACTIVE, count: 12 },
      { state: DeviceLifecycleState.MAINTENANCE, count: 3 },
    ]);
    expect(stats.byModel).toEqual([
      { model: DeviceModel.RASPBERRY_PI_5, count: 13 },
      { model: DeviceModel.INDUSTRIAL_PC, count: 2 },
    ]);
  });

  it('reports an empty fleet as zeros', async () => {
    answerStats([]);

    await expect(service.getStats(TENANT_ID)).resolves.toEqual({
      total: 0,
      online: 0,
      offline: 0,
      inService: 0,
      onlineInService: 0,
      byState: [],
      byModel: [],
    });
  });

  it('counts the fleet in service apart: decommissioned and revoked devices are out of it', async () => {
    // 12 registered, 1 decommissioned and 2 revoked: the 9 still in service
    // are all online, which the console must show as 9 of 9, not 9 of 12.
    answerStats([
      group(DeviceLifecycleState.ACTIVE, DeviceModel.RASPBERRY_PI_5, 8, 0),
      group(DeviceLifecycleState.MAINTENANCE, DeviceModel.INDUSTRIAL_PC, 1, 0),
      group(DeviceLifecycleState.DECOMMISSIONED, DeviceModel.RASPBERRY_PI_5, 0, 1),
      group(DeviceLifecycleState.REVOKED, DeviceModel.INDUSTRIAL_PC, 0, 2),
    ]);

    const stats = await service.getStats(TENANT_ID);

    expect(stats.total).toBe(12);
    expect(stats.online).toBe(9);
    expect(stats.inService).toBe(9);
    expect(stats.onlineInService).toBe(9);
  });

  it('leaves a terminal device out of the in-service online count even if its row still says online', async () => {
    // A revoked device's is_online flag stays until the stale-offline sweep.
    answerStats([
      group(DeviceLifecycleState.ACTIVE, DeviceModel.RASPBERRY_PI_5, 2, 1),
      group(DeviceLifecycleState.REVOKED, DeviceModel.RASPBERRY_PI_5, 1, 0),
    ]);

    const stats = await service.getStats(TENANT_ID);

    expect(stats.online).toBe(3);
    expect(stats.inService).toBe(3);
    expect(stats.onlineInService).toBe(2);
  });

  it('reads inside the tenant boundary', async () => {
    answerStats([]);

    await service.getStats(TENANT_ID);

    expect(runInTenantRead).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      TENANT_ID,
      expect.any(Function),
    );
  });
});
