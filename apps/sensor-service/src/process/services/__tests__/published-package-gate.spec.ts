import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { ScadaPackage, ScadaPackageStatus } from '../../entities/scada-package.entity';
import { ScadaDeployStatus } from '../../entities/scada-deploy-log.entity';
import { Process } from '../../entities/process.entity';
import { ScadaPackageService } from '../scada-package.service';
import { ScadaDeployLogService } from '../scada-deploy-log.service';
import {
  SCADA_PACKAGE_PUBLISHED,
} from '../../../scada-runtime/services/scada-activation.events';

/**
 * M4/M5 — the PUBLISHED gate + deploy-less publish.
 *
 * `publishedScadaPackage` serves the operator runtime and must only ever
 * return the PUBLISHED representation (the resolver maps everything else to
 * FORBIDDEN 'Package is not published'). `publishScadaPackage` flips a
 * package through the SAME shared transition the deploy/ack paths use —
 * refusing ARCHIVED — without touching MQTT, artifacts, or signing.
 * `publishedAt` is DERIVED from the latest shipped deploy-log row (no schema
 * migration).
 */

const TENANT = 'tenant-uuid-1';

function pkgRow(status: ScadaPackageStatus): Partial<ScadaPackage> {
  return {
    id: 'pkg-1',
    tenantId: TENANT,
    name: 'HMI',
    status,
    version: 4,
    packageData: { meta: { schemaVersion: 2 }, screens: [] },
  };
}

function deployLog(
  status: ScadaDeployStatus,
  when: string,
): { status: ScadaDeployStatus; sentAt: Date; updatedAt: Date } {
  const ts = new Date(when);
  return { status, sentAt: ts, updatedAt: ts };
}

describe('published package gate (M4) + publish mutation (M5)', () => {
  let service: ScadaPackageService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let emit: jest.Mock;
  let getByPackage: jest.Mock;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    emit = jest.fn();
    getByPackage = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScadaPackageService,
        { provide: EventEmitter2, useValue: { emit } },
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
        { provide: ScadaDeployLogService, useValue: { getByPackage, createLog: jest.fn() } },
      ],
    }).compile();
    service = module.get(ScadaPackageService);
  });

  describe('getPublishedScadaPackage (M4)', () => {
    it('returns the package when it is PUBLISHED', async () => {
      repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.PUBLISHED));
      const pkg = await service.getPublishedScadaPackage('pkg-1', TENANT);
      expect(pkg).not.toBeNull();
      expect(pkg!.status).toBe(ScadaPackageStatus.PUBLISHED);
    });

    it('returns null for a DRAFT package (builder-only state)', async () => {
      repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.DRAFT));
      expect(await service.getPublishedScadaPackage('pkg-1', TENANT)).toBeNull();
    });

    it('returns null for an ARCHIVED package', async () => {
      repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.ARCHIVED));
      expect(await service.getPublishedScadaPackage('pkg-1', TENANT)).toBeNull();
    });

    it('returns null for an unknown package (gate leaks nothing)', async () => {
      repo.findOne.mockResolvedValue(null);
      expect(await service.getPublishedScadaPackage('nope', TENANT)).toBeNull();
    });
  });

  describe('derivePublishedAt (M4)', () => {
    it('derives from the latest SHIPPED deploy-log row (updatedAt preferred)', async () => {
      getByPackage.mockResolvedValue([
        deployLog(ScadaDeployStatus.UNDEPLOY_SENT, '2026-08-01T00:00:00Z'),
        deployLog(ScadaDeployStatus.SUCCESS, '2026-07-01T00:00:00Z'),
      ]);
      const at = await service.derivePublishedAt('pkg-1', TENANT);
      expect(at).toEqual(new Date('2026-07-01T00:00:00Z'));
    });

    it('skips failed / rolled-back rows and falls back to sentAt when updatedAt is absent', async () => {
      getByPackage.mockResolvedValue([
        { status: ScadaDeployStatus.FAILED, sentAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z') },
        { status: ScadaDeployStatus.ROLLED_BACK, sentAt: new Date('2026-07-15T00:00:00Z'), updatedAt: new Date('2026-07-15T00:00:00Z') },
        { status: ScadaDeployStatus.SENT, sentAt: new Date('2026-07-01T00:00:00Z') },
      ]);
      const at = await service.derivePublishedAt('pkg-1', TENANT);
      expect(at).toEqual(new Date('2026-07-01T00:00:00Z'));
    });

    it('returns null when the package never shipped (no deploy history)', async () => {
      getByPackage.mockResolvedValue([]);
      expect(await service.derivePublishedAt('pkg-1', TENANT)).toBeNull();
    });

    it('returns null when the deploy-log service is unavailable or fails', async () => {
      getByPackage.mockRejectedValue(new Error('db down'));
      expect(await service.derivePublishedAt('pkg-1', TENANT)).toBeNull();
    });
  });

  describe('publishScadaPackage (M5)', () => {
    it('flips a DRAFT package to PUBLISHED via the shared transition and emits the lifecycle event', async () => {
      repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.DRAFT));

      const result = await service.publishScadaPackage('pkg-1', TENANT, 'user-1');

      expect(result).toEqual({ success: true, message: 'Package published', version: 4 });
      const saved = repo.save.mock.calls[0][0] as ScadaPackage;
      expect(saved.status).toBe(ScadaPackageStatus.PUBLISHED);
      expect(emit).toHaveBeenCalledWith(
        SCADA_PACKAGE_PUBLISHED,
        { tenantId: TENANT, packageId: 'pkg-1' },
      );
    });

    it('refuses to publish an ARCHIVED package', async () => {
      repo.findOne.mockResolvedValue(pkgRow(ScadaPackageStatus.ARCHIVED));
      await expect(service.publishScadaPackage('pkg-1', TENANT, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws NotFound for an unknown package (tenant-scoped lookup)', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.publishScadaPackage('nope', TENANT, 'user-1')).rejects.toThrow(
        /not found/i,
      );
    });
  });
});
