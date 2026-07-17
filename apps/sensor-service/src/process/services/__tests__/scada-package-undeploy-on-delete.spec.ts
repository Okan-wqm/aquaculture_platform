import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';

import { validateCommandEnvelope, validateUndeployScadaPackageParams } from '@platform/sensor-contracts/validators';

import { ScadaPackage, ScadaPackageStatus } from '../../entities/scada-package.entity';
import { ScadaDeployStatus } from '../../entities/scada-deploy-log.entity';
import { Process } from '../../entities/process.entity';
import { ScadaPackageService } from '../scada-package.service';
import { ScadaDeployLogService } from '../scada-deploy-log.service';
import { MqttClientService } from '../../../shared-mqtt/mqtt-client.service';
import { EdgeDeviceService } from '../../../edge-device/edge-device.service';

/**
 * WF-011 — undeploy-on-delete.
 *
 * deleteScadaPackage was a pure DB archive: every device the package was
 * deployed to kept rendering, alarming and actuating from a package the
 * tenant believed deleted. Delete now fans a best-effort
 * `undeploy_scada_package` command out to the devices the deploy logs name
 * (latest row per device decides), records UNDEPLOY_SENT rows, and archives
 * REGARDLESS of device reachability — with honest per-device results.
 */

const TENANT = 'tenant-uuid-1';
const PKG_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function pkgRow(status: ScadaPackageStatus = ScadaPackageStatus.PUBLISHED): Partial<ScadaPackage> {
  return {
    id: PKG_ID,
    tenantId: TENANT,
    name: 'HMI',
    status,
    version: 3,
    packageData: { meta: { schemaVersion: 2 }, screens: [] },
  };
}

function deployLog(deviceId: string, status: ScadaDeployStatus, sentAt: string): {
  deviceId: string;
  status: ScadaDeployStatus;
  sentAt: Date;
} {
  return { deviceId, status, sentAt: new Date(sentAt) };
}

describe('deleteScadaPackage — undeploy on delete (WF-011)', () => {
  let service: ScadaPackageService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let publish: jest.Mock;
  let getByPackage: jest.Mock;
  let createLog: jest.Mock;
  let findByIdOrFail: jest.Mock;

  const DEVICES: Record<string, { id: string; deviceCode: string; isOnline: boolean }> = {
    'dev-1': { id: 'dev-1', deviceCode: 'EDGE-01', isOnline: true },
    'dev-2': { id: 'dev-2', deviceCode: 'EDGE-02', isOnline: true },
    'dev-offline': { id: 'dev-offline', deviceCode: 'EDGE-03', isOnline: false },
  };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(pkgRow()),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    publish = jest.fn().mockResolvedValue(undefined);
    getByPackage = jest.fn().mockResolvedValue([]);
    createLog = jest.fn().mockResolvedValue({});
    findByIdOrFail = jest.fn().mockImplementation((id: string) => {
      const device = DEVICES[id];
      if (!device) return Promise.reject(new Error('not found'));
      return Promise.resolve(device);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScadaPackageService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
        { provide: MqttClientService, useValue: { isConnectedToBroker: () => true, publish } },
        { provide: EdgeDeviceService, useValue: { findByIdOrFail } },
        { provide: ScadaDeployLogService, useValue: { getByPackage, createLog } },
      ],
    }).compile();
    service = module.get(ScadaPackageService);
  });

  it('sends a contract-valid undeploy envelope to every device with a live deploy', async () => {
    getByPackage.mockResolvedValue([
      deployLog('dev-1', ScadaDeployStatus.SUCCESS, '2026-07-10T10:00:00Z'),
      deployLog('dev-2', ScadaDeployStatus.SENT, '2026-07-09T10:00:00Z'),
    ]);

    const result = await service.deleteScadaPackage(PKG_ID, TENANT, 'user-1');

    expect(result.archived).toBe(true);
    expect(result.undeploy).toHaveLength(2);
    expect(result.undeploy.every((r) => r.sent)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);

    for (const [topic, payload] of publish.mock.calls as Array<[string, Record<string, unknown>]>) {
      expect(topic).toMatch(new RegExp(`^tenants/${TENANT}/devices/dev-(1|2)/commands$`));
      expect(payload.command).toBe('undeploy_scada_package');
      expect(validateCommandEnvelope(payload)).toBe(true);
      expect(validateUndeployScadaPackageParams(payload.params)).toBe(true);
      expect((payload.params as { packageId: string }).packageId).toBe(PKG_ID);
    }

    // UNDEPLOY_SENT rows carry their OWN commandId per device.
    expect(createLog).toHaveBeenCalledTimes(2);
    const commandIds = createLog.mock.calls.map(
      ([params]: [{ commandId: string; status: ScadaDeployStatus }]) => params.commandId,
    );
    expect(new Set(commandIds).size).toBe(2);
    for (const [params] of createLog.mock.calls as Array<[{ status: ScadaDeployStatus }]>) {
      expect(params.status).toBe(ScadaDeployStatus.UNDEPLOY_SENT);
    }

    // Archive happened.
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ScadaPackageStatus.ARCHIVED }),
    );
  });

  it('skips devices whose LATEST row says nothing is running there', async () => {
    getByPackage.mockResolvedValue([
      // dev-1: latest is FAILED (earlier SUCCESS is history) → skip
      deployLog('dev-1', ScadaDeployStatus.FAILED, '2026-07-10T10:00:00Z'),
      deployLog('dev-1', ScadaDeployStatus.SUCCESS, '2026-07-01T10:00:00Z'),
      // dev-2: already undeployed → skip
      deployLog('dev-2', ScadaDeployStatus.UNDEPLOYED, '2026-07-10T10:00:00Z'),
    ]);

    const result = await service.deleteScadaPackage(PKG_ID, TENANT);

    expect(result.undeploy).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalled(); // archive still happens
  });

  it('an offline device gets no publish but the archive proceeds with an honest note', async () => {
    getByPackage.mockResolvedValue([
      deployLog('dev-offline', ScadaDeployStatus.SUCCESS, '2026-07-10T10:00:00Z'),
    ]);

    const result = await service.deleteScadaPackage(PKG_ID, TENANT);

    expect(publish).not.toHaveBeenCalled();
    expect(result.archived).toBe(true);
    expect(result.undeploy).toEqual([
      { deviceId: 'dev-offline', sent: false, message: expect.stringContaining('çevrimdışı') },
    ]);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ScadaPackageStatus.ARCHIVED }),
    );
  });

  it('a publish failure on device A never stops device B or the archive', async () => {
    getByPackage.mockResolvedValue([
      deployLog('dev-1', ScadaDeployStatus.SUCCESS, '2026-07-10T10:00:00Z'),
      deployLog('dev-2', ScadaDeployStatus.SUCCESS, '2026-07-09T10:00:00Z'),
    ]);
    publish.mockRejectedValueOnce(new Error('broker hiccup'));

    const result = await service.deleteScadaPackage(PKG_ID, TENANT);

    expect(publish).toHaveBeenCalledTimes(2);
    const [a, b] = result.undeploy;
    expect(a!.sent).toBe(false);
    expect(a!.message).toContain('broker hiccup');
    expect(b!.sent).toBe(true);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ScadaPackageStatus.ARCHIVED }),
    );
  });

  it('re-deleting an ARCHIVED package is an idempotent no-op (no re-sweep)', async () => {
    repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.ARCHIVED));

    const result = await service.deleteScadaPackage(PKG_ID, TENANT);

    expect(result).toEqual({ archived: true, undeploy: [] });
    expect(getByPackage).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('degrades to archive-only when the optional deps are absent', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScadaPackageService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    const bare = module.get(ScadaPackageService);

    const result = await bare.deleteScadaPackage(PKG_ID, TENANT);

    expect(result).toEqual({ archived: true, undeploy: [] });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ScadaPackageStatus.ARCHIVED }),
    );
  });
});
