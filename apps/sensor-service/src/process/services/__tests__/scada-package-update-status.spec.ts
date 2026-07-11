import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ScadaPackage, ScadaPackageStatus } from '../../entities/scada-package.entity';
import { Process } from '../../entities/process.entity';
import { ScadaPackageService } from '../scada-package.service';
import { UpdateScadaPackageInput } from '../../dto/scada-package.dto';

/**
 * SENSOR-MEDIUM-017 — `updateScadaPackage` must never change a package's status.
 *
 * Package lifecycle (DRAFT -> PUBLISHED -> ARCHIVED) is server-owned: DRAFT on
 * create, PUBLISHED via the deploy path, ARCHIVED via delete. A client update
 * must not be able to forge PUBLISHED (deploy-state fakery) or un-archive a
 * deleted package back to DRAFT. `status` was removed from the update input;
 * this pins that even an injected `status` on the input object is ignored.
 */

const TENANT = 'tenant-uuid-1';

describe('ScadaPackageService — updateScadaPackage status immutability', () => {
  let service: ScadaPackageService;
  let repo: { findOne: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScadaPackageService,
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
      ],
    }).compile();

    service = module.get(ScadaPackageService);
  });

  it('ignores an injected status on the update input and preserves the stored status', async () => {
    repo.findOne.mockResolvedValue({
      id: 'pkg-1',
      tenantId: TENANT,
      name: 'Old name',
      status: ScadaPackageStatus.DRAFT,
      version: 3,
    });

    // A caller that smuggles `status` onto the input object (the field no longer
    // exists on the DTO, but the object is still structurally assignable to it).
    const malicious: UpdateScadaPackageInput & { status: ScadaPackageStatus } = {
      name: 'New name',
      status: ScadaPackageStatus.PUBLISHED,
    };

    const saved = await service.updateScadaPackage('pkg-1', malicious, TENANT, 'user-1');

    expect(saved.name).toBe('New name');
    expect(saved.status).toBe(ScadaPackageStatus.DRAFT); // NOT PUBLISHED
    const persisted = repo.save.mock.calls[0][0] as ScadaPackage;
    expect(persisted.status).toBe(ScadaPackageStatus.DRAFT);
  });

  it('leaves an ARCHIVED package archived on update (no un-delete)', async () => {
    repo.findOne.mockResolvedValue({
      id: 'pkg-2',
      tenantId: TENANT,
      name: 'Deleted pkg',
      status: ScadaPackageStatus.ARCHIVED,
      version: 5,
    });

    const malicious: UpdateScadaPackageInput & { status: ScadaPackageStatus } = {
      description: 'trying to revive',
      status: ScadaPackageStatus.DRAFT,
    };

    const saved = await service.updateScadaPackage('pkg-2', malicious, TENANT, 'user-1');

    expect(saved.status).toBe(ScadaPackageStatus.ARCHIVED); // still archived
  });
});
