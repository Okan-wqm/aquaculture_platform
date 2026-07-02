import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  TagDataType,
  TagDirection,
  TagIoType,
  TagStatus,
  UnifiedTag,
} from '../entities/unified-tag.entity';
import { TagResolutionService } from '../services/tag-resolution.service';

const TENANT = 'tenant-uuid-1';

const buildTag = (overrides: Partial<UnifiedTag> = {}): UnifiedTag =>
  ({
    id: 'tag-uuid-1',
    tenantId: TENANT,
    fqn: 'EDGE-AABB1122/tank1.do',
    localName: 'tank1.do',
    ioType: TagIoType.AI,
    dataType: TagDataType.FLOAT32,
    direction: TagDirection.INPUT,
    engUnit: 'mg/L',
    source: { type: 'edge_device', edgeDeviceId: 'dev-1', ioConfigId: 'io-1' },
    hierarchy: {},
    status: TagStatus.ACTIVE,
    revision: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as UnifiedTag;

describe('TagResolutionService', () => {
  let service: TagResolutionService;
  let tagRepo: { find: jest.Mock };

  beforeEach(async () => {
    tagRepo = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagResolutionService,
        { provide: getRepositoryToken(UnifiedTag), useValue: tagRepo },
      ],
    }).compile();

    service = module.get(TagResolutionService);
  });

  it('resolves an exact-FQN registry hit into a binding snapshot', async () => {
    const tag = buildTag();
    tagRepo.find.mockResolvedValue([tag]);

    const result = await service.resolve(TENANT, ['EDGE-AABB1122/tank1.do']);

    expect(result.unresolved).toEqual([]);
    expect(result.resolved).toEqual([
      {
        ref: 'EDGE-AABB1122/tank1.do',
        unifiedTagId: tag.id,
        ioType: tag.ioType,
        dataType: tag.dataType,
        direction: tag.direction,
        engUnit: tag.engUnit,
        source: tag.source,
        revision: tag.revision,
      },
    ]);
  });

  it('classifies retired registry tags as RETIRED (no new bindings)', async () => {
    tagRepo.find.mockResolvedValue([buildTag({ status: TagStatus.RETIRED })]);

    const result = await service.resolve(TENANT, ['EDGE-AABB1122/tank1.do']);

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([
      { ref: 'EDGE-AABB1122/tank1.do', reason: 'RETIRED' },
    ]);
  });

  it('classifies grammar violations without querying the registry for them', async () => {
    const result = await service.resolve(TENANT, ['no separator here', 'gpio:17/x']);

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([
      { ref: 'no separator here', reason: 'INVALID_GRAMMAR' },
      { ref: 'gpio:17/x', reason: 'INVALID_GRAMMAR' },
    ]);
    expect(tagRepo.find).not.toHaveBeenCalled();
  });

  it('classifies registry misses as NOT_FOUND', async () => {
    tagRepo.find.mockResolvedValue([]);

    const result = await service.resolve(TENANT, ['EDGE-AABB1122/ghost_tag']);

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([
      { ref: 'EDGE-AABB1122/ghost_tag', reason: 'NOT_FOUND' },
    ]);
  });

  it('mixes resolved and unresolved, deduplicates input, scopes query to tenant', async () => {
    const tag = buildTag();
    tagRepo.find.mockResolvedValue([tag]);

    const result = await service.resolve(TENANT, [
      'EDGE-AABB1122/tank1.do',
      'EDGE-AABB1122/tank1.do',
      'bad ref',
      'EDGE-AABB1122/missing',
    ]);

    expect(result.resolved).toHaveLength(1);
    expect(result.unresolved).toEqual([
      { ref: 'bad ref', reason: 'INVALID_GRAMMAR' },
      { ref: 'EDGE-AABB1122/missing', reason: 'NOT_FOUND' },
    ]);
    expect(tagRepo.find).toHaveBeenCalledTimes(1);
    const where = tagRepo.find.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
  });

  it('returns empty result for empty input without touching the registry', async () => {
    const result = await service.resolve(TENANT, []);
    expect(result).toEqual({ resolved: [], unresolved: [] });
    expect(tagRepo.find).not.toHaveBeenCalled();
  });
});
