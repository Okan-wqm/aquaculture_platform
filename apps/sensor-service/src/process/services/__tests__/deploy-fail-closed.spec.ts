import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ScadaPackage, ScadaPackageStatus } from '../../entities/scada-package.entity';
import { Process } from '../../entities/process.entity';
import { ScadaPackageService } from '../scada-package.service';
import { ArtifactService } from '../../../deploy-artifact/artifact.service';
import { MqttClientService } from '../../../shared-mqtt/mqtt-client.service';
import { EdgeDeviceService } from '../../../edge-device/edge-device.service';
import { TagResolutionService } from '../tag-resolution.service';

/**
 * M1 — deploy fail-closed + rollback parity + UNSIGNED marker.
 *
 * A snapshot failure previously only logged and the deploy CONTINUED —
 * shipping an unsnapshotted (unrollbackable) payload. Now the snapshot is
 * mandatory: a missing artifact service or a throwing snapshot ABORTS the
 * deploy before the broker, before the deploy log, before the PUBLISHED
 * flip. Rollback gains the same ARCHIVED guard + tag-gate terms as a fresh
 * deploy, and unsigned results (no signing key configured — platform-wide
 * decision) say so with the UNSIGNED marker.
 */

const TENANT = 'tenant-uuid-1';

function pkgRow(status = ScadaPackageStatus.DRAFT): Partial<ScadaPackage> {
  return {
    id: 'pkg-1',
    tenantId: TENANT,
    name: 'HMI',
    status,
    version: 2,
    packageData: {
      meta: { schemaVersion: 2, packageName: 'HMI' },
      screens: [
        {
          id: 's1',
          name: 'Main',
          screenType: 'dashboard',
          isDefault: true,
          widgets: [{ id: 'w-gauge', widgetType: 'gauge', position: { col: 0, row: 0, w: 2, h: 2 }, config: {} }],
        },
      ],
    },
  };
}

describe('deploy fail-closed + rollback parity (M1)', () => {
  let service: ScadaPackageService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let publish: jest.Mock;
  let snapshot: jest.Mock;

  async function buildService(overrides: { artifact?: object | null } = {}): Promise<void> {
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    publish = jest.fn().mockResolvedValue(undefined);
    snapshot = jest.fn().mockResolvedValue({ id: 'art-1', contentSha256: 'a'.repeat(64) });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScadaPackageService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
        ...(overrides.artifact === null
          ? []
          : [{ provide: ArtifactService, useValue: { snapshot } }]),
        {
          provide: MqttClientService,
          useValue: { isConnectedToBroker: () => true, publish },
        },
        {
          provide: EdgeDeviceService,
          useValue: {
            findByIdOrFail: jest.fn().mockResolvedValue({
              id: 'dev-1',
              deviceCode: 'EDGE-01',
              isOnline: true,
            }),
          },
        },
      ],
    }).compile();
    service = module.get(ScadaPackageService);
  }

  describe('snapshot failure aborts the deploy', () => {
    beforeEach(() => buildService());

    it('a THROWING snapshot aborts before the broker, the deploy log row, and the PUBLISHED flip', async () => {
      repo.findOne.mockResolvedValue(pkgRow());
      snapshot.mockRejectedValue(new Error('disk full'));

      await expect(
        service.deployScadaPackageToEdge('pkg-1', 'dev-1', TENANT, 'user-1'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.deployScadaPackageToEdge('pkg-1', 'dev-1', TENANT, 'user-1'),
      ).rejects.toThrow(/snapshotting the package artifact failed.*disk full/i);

      expect(publish).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled(); // never flips PUBLISHED
    });

    it('the success message carries the UNSIGNED marker when no signing key is configured', async () => {
      repo.findOne.mockResolvedValue(pkgRow());

      const result = await service.deployScadaPackageToEdge('pkg-1', 'dev-1', TENANT, 'user-1');

      expect(result.success).toBe(true);
      expect(result.message).toContain('UNSIGNED');
      expect(snapshot).toHaveBeenCalledTimes(1);
    });
  });

  it('a MISSING artifact service aborts the deploy (fail-closed always)', async () => {
    await buildService({ artifact: null });
    repo.findOne.mockResolvedValue(pkgRow());

    await expect(
      service.deployScadaPackageToEdge('pkg-1', 'dev-1', TENANT, 'user-1'),
    ).rejects.toThrow(/fail-closed without a content-addressed snapshot/);
    expect(publish).not.toHaveBeenCalled();
  });

  describe('rollback parity', () => {
    let resolve: jest.Mock;
    let getById: jest.Mock;

    beforeEach(async () => {
      await buildService();
      resolve = jest.fn().mockResolvedValue({ resolved: [], unresolved: [] });
      getById = jest.fn();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ScadaPackageService,
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
          { provide: getRepositoryToken(ScadaPackage), useValue: repo },
          { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
          { provide: ArtifactService, useValue: { snapshot, getById } },
          { provide: TagResolutionService, useValue: { resolve } },
          {
            // The tag gate reads its mode via ConfigService
            // (config-env-access-ratchet); tests drive it via process.env.
            provide: ConfigService,
            useValue: { get: (key: string) => process.env[key] },
          },
          {
            provide: MqttClientService,
            useValue: { isConnectedToBroker: () => true, publish },
          },
          {
            provide: EdgeDeviceService,
            useValue: {
              findByIdOrFail: jest.fn().mockResolvedValue({
                id: 'dev-1',
                deviceCode: 'EDGE-01',
                isOnline: true,
              }),
            },
          },
        ],
      }).compile();
      service = module.get(ScadaPackageService);
    });

    it('refuses to roll back a package whose source is ARCHIVED', async () => {
      getById.mockResolvedValue({
        id: 'art-1',
        artifactType: 'scada_package',
        contentSha256: 'a'.repeat(64),
        sourceEntityId: 'pkg-1',
        sourceEntityVersion: 2,
        content: pkgRow().packageData,
      });

      repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.ARCHIVED));

      await expect(
        service.rollbackScadaPackageDeploy('art-1', 'dev-1', TENANT, 'user-1'),
      ).rejects.toThrow(/archived.*cannot be deployed/);
      expect(publish).not.toHaveBeenCalled();
    });

    it('enforce-mode tag gate blocks a rollback with unresolved bindings, like a fresh deploy', async () => {
      const originalGate = process.env.SCADA_DEPLOY_TAG_GATE;
      process.env.SCADA_DEPLOY_TAG_GATE = 'enforce';
      try {
        getById.mockResolvedValue({
          id: 'art-1',
          artifactType: 'scada_package',
          contentSha256: 'a'.repeat(64),
          sourceEntityId: 'pkg-1',
          sourceEntityVersion: 2,
          content: {
            meta: { schemaVersion: 2 },
            screens: [
              {
                id: 's1',
                widgets: [{ id: 'w-gauge', widgetType: 'gauge', config: { tagName: 'tank.level' } }],
              },
            ],
          },
        });
        repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.PUBLISHED));
        resolve.mockResolvedValue({
          resolved: [],
          unresolved: [{ ref: 'EDGE-01/tank.level', reason: 'NOT_FOUND' }],
        });

        await expect(
          service.rollbackScadaPackageDeploy('art-1', 'dev-1', TENANT, 'user-1'),
        ).rejects.toThrow(/rollback_scada_package art-1.*deploy blocked/);
        expect(publish).not.toHaveBeenCalled();
      } finally {
        if (originalGate === undefined) delete process.env.SCADA_DEPLOY_TAG_GATE;
        else process.env.SCADA_DEPLOY_TAG_GATE = originalGate;
      }
    });

    it('a successful rollback message carries the UNSIGNED marker when unsigned', async () => {
      getById.mockResolvedValue({
        id: 'art-1',
        artifactType: 'scada_package',
        contentSha256: 'a'.repeat(64),
        sourceEntityId: 'pkg-1',
        sourceEntityVersion: 2,
        content: pkgRow().packageData,
      });
      repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.PUBLISHED));

      const result = await service.rollbackScadaPackageDeploy('art-1', 'dev-1', TENANT, 'user-1');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Rollback to artifact v2 sent');
      expect(result.message).toContain('UNSIGNED');
    });
  });
});
