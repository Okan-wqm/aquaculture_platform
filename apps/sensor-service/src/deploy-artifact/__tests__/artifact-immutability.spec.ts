import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';

import { ArtifactService, deployArtifactCanonicalJsonV1, contentSha256 } from '../artifact.service';
import { DeployArtifact, DeployArtifactType } from '../entities/deploy-artifact.entity';

const TENANT = 'tenant-uuid-1';

describe('ArtifactService — content-addressed immutability', () => {
  let service: ArtifactService;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((dto) => ({ id: 'artifact-1', ...dto })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ArtifactService, { provide: getRepositoryToken(DeployArtifact), useValue: repo }],
    }).compile();

    service = module.get(ArtifactService);
  });

  it('canonical serialization is key-order independent (same content → same sha)', () => {
    const a = { screens: [{ id: 's1', widgets: [] }], meta: { schemaVersion: 2 } };
    const b = { meta: { schemaVersion: 2 }, screens: [{ widgets: [], id: 's1' }] };
    expect(deployArtifactCanonicalJsonV1(a)).toBe(deployArtifactCanonicalJsonV1(b));
    expect(contentSha256(a)).toBe(contentSha256(b));
  });

  it('canonical serialization preserves array order (different order → different sha)', () => {
    const a = { tags: ['x', 'y'] };
    const b = { tags: ['y', 'x'] };
    expect(contentSha256(a)).not.toBe(contentSha256(b));
  });

  it('identical content dedupes to the existing row — no second insert, never an update', async () => {
    const content = { screens: [], meta: { schemaVersion: 2 } };
    const existing = {
      id: 'existing-artifact',
      tenantId: TENANT,
      contentSha256: contentSha256(content),
      content,
    };
    repo.findOne.mockResolvedValue(existing);

    const result = await service.snapshot(TENANT, {
      artifactType: DeployArtifactType.SCADA_PACKAGE,
      content,
    });

    expect(result).toBe(existing);
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('new content inserts a new immutable row with the canonical sha', async () => {
    const content = { screens: [{ id: 's1' }], meta: { schemaVersion: 2 } };

    const result = await service.snapshot(TENANT, {
      artifactType: DeployArtifactType.PROCESS,
      content,
      sourceEntityId: 'proc-1',
      sourceEntityVersion: 4,
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        artifactType: DeployArtifactType.PROCESS,
        contentSha256: contentSha256(content),
        sourceEntityVersion: 4,
      }),
    );
    expect(result.contentSha256).toBe(contentSha256(content));
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('unique-violation race converges on the winner row instead of throwing', async () => {
    const content = { screens: [], meta: {} };
    const winner = { id: 'winner', tenantId: TENANT, contentSha256: contentSha256(content) };
    const driverError = Object.assign(new Error('duplicate'), { code: '23505' });
    repo.save.mockRejectedValue(new QueryFailedError('INSERT', [], driverError));
    repo.findOne
      .mockResolvedValueOnce(null) // pre-insert lookup
      .mockResolvedValueOnce(winner); // post-race lookup

    const result = await service.snapshot(TENANT, {
      artifactType: DeployArtifactType.AUTOMATION_PROGRAM,
      content,
    });

    expect(result).toBe(winner);
  });

  it('getById is tenant-scoped and throws on miss', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.getById(TENANT, 'ghost')).rejects.toThrow('not found');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'ghost', tenantId: TENANT } });
  });
});
