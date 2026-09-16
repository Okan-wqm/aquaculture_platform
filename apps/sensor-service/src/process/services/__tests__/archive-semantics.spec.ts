import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { FindOperator, QueryFailedError } from 'typeorm';

import { ScadaPackage, ScadaPackageStatus } from '../../entities/scada-package.entity';
import { Process } from '../../entities/process.entity';
import { ScadaPackageService } from '../scada-package.service';

/** True when the where-clause value is `Not(ARCHIVED)`. */
function isNotArchived(value: unknown): boolean {
  return (
    value instanceof FindOperator &&
    (value as FindOperator<ScadaPackageStatus>).type === 'not' &&
    (value as FindOperator<ScadaPackageStatus>).value === ScadaPackageStatus.ARCHIVED
  );
}

/**
 * M6 — archive semantics.
 *
 *  (a) deleteScadaPackage also unlinks process_id (the partial unique index
 *      uq_scada_packages_tenant_process would otherwise block re-creating a
 *      package for the same process forever);
 *  (b) the default list EXCLUDES archived packages unless a status filter is
 *      given or includeArchived=true — including the unified editor's
 *      processId-only query (intended behavior change, pinned here);
 *  (c) 23505 unique-violations map to a friendly 'already linked' message;
 *  (d) UpdateScadaPackageInput.processId = null means UNLINK (skip process
 *      validation entirely).
 */

const TENANT = 'tenant-uuid-1';

function row(id: string, status: ScadaPackageStatus, processId?: string | null): Partial<ScadaPackage> {  return {
    id,
    tenantId: TENANT,
    name: `pkg-${id}`,
    status,
    version: 1,
    processId,
    packageData: { meta: { schemaVersion: 2 }, screens: [] },
  };
}

describe('archive semantics (M6)', () => {
  let service: ScadaPackageService;
  let repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; findAndCount: jest.Mock };
  let processRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((e) => e),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    processRepo = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScadaPackageService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: processRepo },
      ],
    }).compile();
    service = module.get(ScadaPackageService);
  });

  describe('(a) delete unlinks the process', () => {
    it('archives AND sets processId = NULL', async () => {
      repo.findOne.mockResolvedValue(row('pkg-1', ScadaPackageStatus.PUBLISHED, 'proc-1'));

      const result = await service.deleteScadaPackage('pkg-1', TENANT, 'user-1');

      expect(result.archived).toBe(true);
      const saved = repo.save.mock.calls[0][0] as ScadaPackage;
      expect(saved.status).toBe(ScadaPackageStatus.ARCHIVED);
      expect(saved.processId).toBeNull();
    });

    it('an already-archived row that still holds a legacy link is unlinked on re-delete', async () => {
      repo.findOne.mockResolvedValue(row('pkg-1', ScadaPackageStatus.ARCHIVED, 'proc-1'));

      const result = await service.deleteScadaPackage('pkg-1', TENANT, 'user-1');

      expect(result).toEqual({ archived: true, undeploy: [] });
      const saved = repo.save.mock.calls[0][0] as ScadaPackage;
      expect(saved.processId).toBeNull();
    });
  });

  describe('(b) default list excludes ARCHIVED', () => {
    it('no filter → status = Not(ARCHIVED)', async () => {
      await service.listScadaPackages(TENANT);
      const [arg] = repo.findAndCount.mock.calls[0];
      expect(isNotArchived(arg.where.status)).toBe(true);
    });

    it('explicit status filter wins (asking for ARCHIVED gets ARCHIVED)', async () => {
      await service.listScadaPackages(TENANT, { status: ScadaPackageStatus.ARCHIVED });
      const [arg] = repo.findAndCount.mock.calls[0];
      expect(arg.where.status).toBe(ScadaPackageStatus.ARCHIVED);
    });

    it('includeArchived=true with no status filter removes the exclusion', async () => {
      await service.listScadaPackages(TENANT, { includeArchived: true });
      const [arg] = repo.findAndCount.mock.calls[0];
      expect(arg.where.status).toBeUndefined();
    });

    it('unified-editor query (processId only, no status) excludes ARCHIVED — regression pin', async () => {
      await service.listScadaPackages(TENANT, { processId: 'proc-1' });
      const [arg] = repo.findAndCount.mock.calls[0];
      expect(arg.where.processId).toBe('proc-1');
      expect(isNotArchived(arg.where.status)).toBe(true);
    });

    it('an archived package is never returned by the default list (end-to-end shape)', async () => {
      const archived = row('pkg-a', ScadaPackageStatus.ARCHIVED, null);
      const live = row('pkg-b', ScadaPackageStatus.PUBLISHED, null);
      // Simulate what the Not() where-clause does: archived rows drop out.
      repo.findAndCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        const kept = isNotArchived(where.status)
          ? [archived, live].filter((p) => p.status !== ScadaPackageStatus.ARCHIVED)
          : [archived, live];
        return [kept, kept.length];
      });

      const result = await service.listScadaPackages(TENANT);
      expect(result.items.map((p) => p.id)).toEqual(['pkg-b']);
      expect(result.total).toBe(1);
    });
  });

  describe('(c) 23505 unique-violation mapping', () => {
    it('create maps a 23505 to the friendly process-link conflict message', async () => {
      processRepo.findOne.mockResolvedValue({ id: 'proc-1', tenantId: TENANT });
      const driverError = Object.assign(new Error('duplicate key value violates unique constraint "uq_scada_packages_tenant_process"'), { code: '23505' });
      repo.save.mockRejectedValue(new QueryFailedError('INSERT …', [], driverError));

      await expect(
        service.createScadaPackage(
          {
            name: 'P',
            packageData: { meta: { schemaVersion: 2 }, screens: [] },
            processId: 'proc-1',
          },
          TENANT,
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createScadaPackage(
          {
            name: 'P',
            packageData: { meta: { schemaVersion: 2 }, screens: [] },
            processId: 'proc-1',
          },
          TENANT,
          'user-1',
        ),
      ).rejects.toThrow(/A package is already linked to this process \(proc-1\)/);
    });

    it('update maps a 23505 the same way; other QueryFailedErrors rethrow untouched', async () => {
      repo.findOne.mockResolvedValue(row('pkg-1', ScadaPackageStatus.DRAFT));
      processRepo.findOne.mockResolvedValue({ id: 'proc-1', tenantId: TENANT });
      const driverError = Object.assign(new Error('duplicate key'), { code: '23505' });
      repo.save.mockRejectedValueOnce(new QueryFailedError('UPDATE …', [], driverError));

      await expect(
        service.updateScadaPackage('pkg-1', { processId: 'proc-1' }, TENANT, 'user-1'),
      ).rejects.toThrow(/A package is already linked to this process \(proc-1\)/);

      const otherDriver = Object.assign(new Error('some other failure'), { code: '42P01' });
      repo.save.mockRejectedValueOnce(new QueryFailedError('UPDATE …', [], otherDriver));
      await expect(
        service.updateScadaPackage('pkg-1', { name: 'x' }, TENANT, 'user-1'),
      ).rejects.toThrow(QueryFailedError);
    });
  });

  describe('(d) processId null semantics', () => {
    it('update with processId = null unlinks WITHOUT touching the process repo', async () => {
      repo.findOne.mockResolvedValue(row('pkg-1', ScadaPackageStatus.DRAFT, 'proc-1'));

      const saved = await service.updateScadaPackage('pkg-1', { processId: null }, TENANT, 'user-1');

      expect(processRepo.findOne).not.toHaveBeenCalled();
      expect(saved.processId).toBeNull();
    });

    it('update with a string processId still validates the process exists', async () => {
      repo.findOne.mockResolvedValue(row('pkg-1', ScadaPackageStatus.DRAFT, null));
      processRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateScadaPackage('pkg-1', { processId: 'proc-404' }, TENANT, 'user-1'),
      ).rejects.toThrow(/not found in current tenant/);
    });
  });
});
