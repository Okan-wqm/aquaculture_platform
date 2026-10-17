/**
 * EdgeDeviceService.findAll — the `inService` filter behind edgeDevices.
 *
 * Decommissioning keeps a device's row (lifecycleState DECOMMISSIONED), and
 * REVOKED is terminal too. A list of the fleet in service — the console's
 * command palette, the live-site count — must leave both out, by the entity's
 * own terminal-state rule: a client listing the terminal states itself would
 * drift the day a state is added. Absent, the list is unfiltered as before
 * (the Devices pages show decommissioned devices); an explicit lifecycleState
 * still narrows, and a terminal one is out of service by definition, so the
 * two together admit nothing.
 */
import { ConfigService } from '@nestjs/config';
import { collaborator } from '@aquaculture/testing';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { type DataSource, In, type Repository } from 'typeorm';

import { DeviceDirectoryService } from '../device-directory.service';
import { EdgeDeviceService } from '../edge-device.service';
import { InstallerScriptService } from '../installer-script.service';
import { DeviceIoConfig } from '../entities/device-io-config.entity';
import {
  DeviceLifecycleState,
  EdgeDevice,
  IN_SERVICE_STATES,
  isTerminalLifecycleState,
} from '../entities/edge-device.entity';
import { LoRaDevice } from '../entities/lora-device.entity';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('EdgeDeviceService.findAll — inService', () => {
  let findAndCount: jest.Mock;
  let service: EdgeDeviceService;

  beforeEach(() => {
    findAndCount = jest.fn().mockResolvedValue([[], 0]);
    // findAll reads the device repository's findAndCount and nothing else; any
    // other member it reaches for names itself.
    service = new EdgeDeviceService(
      collaborator<Repository<EdgeDevice>>({ findAndCount }, 'EdgeDeviceRepository'),
      collaborator<Repository<DeviceIoConfig>>({}, 'DeviceIoConfigRepository'),
      collaborator<Repository<LoRaDevice>>({}, 'LoRaDeviceRepository'),
      collaborator<DataSource>({}, 'DataSource'),
      createScheduledJobTestExecutor().executor,
      null,
      collaborator<InstallerScriptService>({}, 'InstallerScriptService'),
      collaborator<ConfigService>({ get: jest.fn() }, 'ConfigService'),
      collaborator<DeviceDirectoryService>({}, 'DeviceDirectoryService'),
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  function whereOfCall(): Record<string, unknown> {
    return findAndCount.mock.calls[0][0].where;
  }

  it('lists every lifecycle state but the terminal ones', () => {
    for (const state of Object.values(DeviceLifecycleState)) {
      expect(IN_SERVICE_STATES.includes(state)).toBe(!isTerminalLifecycleState(state));
    }
    expect(IN_SERVICE_STATES).not.toContain(DeviceLifecycleState.DECOMMISSIONED);
    expect(IN_SERVICE_STATES).not.toContain(DeviceLifecycleState.REVOKED);
  });

  it('admits only the in-service states when asked', async () => {
    await service.findAll(TENANT_ID, { inService: true, isOnline: true, page: 1, limit: 100 });

    expect(whereOfCall()).toEqual({
      tenantId: TENANT_ID,
      isOnline: true,
      lifecycleState: In([...IN_SERVICE_STATES]),
    });
  });

  it('leaves the lifecycle filter off when not asked', async () => {
    await service.findAll(TENANT_ID, { page: 1, limit: 20 });

    expect(whereOfCall()).toEqual({ tenantId: TENANT_ID });
  });

  it('keeps an explicit in-service lifecycle state as the filter', async () => {
    await service.findAll(TENANT_ID, {
      inService: true,
      lifecycleState: DeviceLifecycleState.MAINTENANCE,
    });

    expect(whereOfCall()).toEqual({
      tenantId: TENANT_ID,
      lifecycleState: DeviceLifecycleState.MAINTENANCE,
    });
  });

  it('answers a terminal lifecycle state asked in service with an empty page, without a query', async () => {
    const result = await service.findAll(TENANT_ID, {
      inService: true,
      lifecycleState: DeviceLifecycleState.DECOMMISSIONED,
      page: 1,
      limit: 20,
    });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(findAndCount).not.toHaveBeenCalled();
  });
});
