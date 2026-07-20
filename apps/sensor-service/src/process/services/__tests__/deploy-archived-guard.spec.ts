import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { ScadaPackage, ScadaPackageStatus } from '../../entities/scada-package.entity';
import { Process, ProcessStatus } from '../../entities/process.entity';
import { ScadaPackageService } from '../scada-package.service';
import { ProcessService } from '../process.service';
import { createScadaPackageTestingModule } from './scada-package-service.testing';

/**
 * SENSOR-HIGH-043 — a soft-deleted (ARCHIVED) package/process must not deploy.
 *
 * Delete is a soft-delete (status -> ARCHIVED). Deploy is the moment the
 * artifact starts running physical hardware, so an archived (deleted) package
 * or process reaching a device is a state-machine violation. Every device-push
 * entrypoint must reject it before touching the broker.
 */

const TENANT = 'tenant-uuid-1';

describe('deploy archived guard (SENSOR-HIGH-043)', () => {
  describe('ScadaPackageService', () => {
    let service: ScadaPackageService;
    let repo: { findOne: jest.Mock; save: jest.Mock };

    beforeEach(async () => {
      repo = { findOne: jest.fn(), save: jest.fn() };
      const module: TestingModule = await createScadaPackageTestingModule([
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
      ]);
      service = module.get(ScadaPackageService);
    });

    it('deployScadaPackageToEdge rejects an archived package', async () => {
      repo.findOne.mockResolvedValue({
        id: 'pkg-1',
        tenantId: TENANT,
        status: ScadaPackageStatus.ARCHIVED,
      });
      await expect(
        service.deployScadaPackageToEdge('pkg-1', 'dev-1', TENANT, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('deployScadaWithAutomation rejects an archived package', async () => {
      repo.findOne.mockResolvedValue({
        id: 'pkg-1',
        tenantId: TENANT,
        status: ScadaPackageStatus.ARCHIVED,
        packageData: { meta: {} },
      });
      await expect(
        service.deployScadaWithAutomation('pkg-1', 'dev-1', TENANT, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('ProcessService', () => {
    let service: ProcessService;
    let repo: { findOne: jest.Mock };

    beforeEach(async () => {
      repo = { findOne: jest.fn() };
      const module: TestingModule = await Test.createTestingModule({
        providers: [ProcessService, { provide: getRepositoryToken(Process), useValue: repo }],
      }).compile();
      service = module.get(ProcessService);
    });

    it('deployProcessToEdge rejects an archived process', async () => {
      repo.findOne.mockResolvedValue({
        id: 'proc-1',
        tenantId: TENANT,
        status: ProcessStatus.ARCHIVED,
        nodes: [],
      });
      await expect(
        service.deployProcessToEdge('proc-1', 'dev-1', TENANT, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
