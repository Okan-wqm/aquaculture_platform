import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';

import { UnifiedTag, TagStatus } from '../../entities/unified-tag.entity';
import { DeviceIoConfig } from '../../../edge-device/entities/device-io-config.entity';
import { EdgeDevice } from '../../../edge-device/entities/edge-device.entity';
import { Process } from '../../entities/process.entity';
import { UnifiedTagService } from '../unified-tag.service';

/**
 * SENSOR-HIGH-050 — tag lifecycle: retire is reachable, hard delete is DRAFT-only.
 *
 * deleteTag was an unconditional hard delete (contradicting the entity's
 * "row stays for audit" contract) and nothing could ever set RETIRED, so the
 * resolution branch reporting RETIRED bindings was dead code. Because tag
 * references are FQN strings inside JSONB documents (no FK to scan), the
 * structural guarantee is lifecycle-based: anything past DRAFT can only be
 * retired, so a referenced tag can never silently vanish.
 */

const TENANT = 'tenant-uuid-1';

describe('UnifiedTag lifecycle (SENSOR-HIGH-050)', () => {
  let service: UnifiedTagService;
  let repo: { findOne: jest.Mock; remove: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockImplementation((t) => Promise.resolve(t)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UnifiedTagService,
        { provide: getRepositoryToken(UnifiedTag), useValue: repo },
        { provide: getRepositoryToken(DeviceIoConfig), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(EdgeDevice), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    service = module.get(UnifiedTagService);
  });

  it('hard-deletes a DRAFT tag', async () => {
    repo.findOne.mockResolvedValue({
      id: 't1', tenantId: TENANT, fqn: 'DEV-1/a', status: TagStatus.DRAFT,
    });
    await expect(service.deleteTag('t1', TENANT)).resolves.toBe(true);
    expect(repo.remove).toHaveBeenCalled();
  });

  it('refuses to hard-delete an ACTIVE tag (retire instead)', async () => {
    repo.findOne.mockResolvedValue({
      id: 't1', tenantId: TENANT, fqn: 'DEV-1/a', status: TagStatus.ACTIVE,
    });
    await expect(service.deleteTag('t1', TENANT)).rejects.toThrow(ForbiddenException);
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it('refuses to hard-delete a RETIRED tag (audit row stays)', async () => {
    repo.findOne.mockResolvedValue({
      id: 't1', tenantId: TENANT, fqn: 'DEV-1/a', status: TagStatus.RETIRED,
    });
    await expect(service.deleteTag('t1', TENANT)).rejects.toThrow(ForbiddenException);
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it('retireTag sets RETIRED and bumps the revision', async () => {
    repo.findOne.mockResolvedValue({
      id: 't1', tenantId: TENANT, fqn: 'DEV-1/a', status: TagStatus.ACTIVE, revision: 3,
    });
    const tag = await service.retireTag('t1', TENANT);
    expect(tag.status).toBe(TagStatus.RETIRED);
    expect(tag.revision).toBe(4); // binding snapshots must detect the edit
    expect(repo.save).toHaveBeenCalled();
  });

  it('retireTag is idempotent on an already-retired tag', async () => {
    repo.findOne.mockResolvedValue({
      id: 't1', tenantId: TENANT, fqn: 'DEV-1/a', status: TagStatus.RETIRED, revision: 5,
    });
    const tag = await service.retireTag('t1', TENANT);
    expect(tag.status).toBe(TagStatus.RETIRED);
    expect(tag.revision).toBe(5); // no double-bump
    expect(repo.save).not.toHaveBeenCalled();
  });
});
