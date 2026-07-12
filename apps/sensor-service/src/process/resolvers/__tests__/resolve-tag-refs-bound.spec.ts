import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';

import { UnifiedTagResolver } from '../unified-tag.resolver';
import { UnifiedTagService } from '../../services/unified-tag.service';
import { TagResolutionService } from '../../services/tag-resolution.service';

/**
 * SENSOR-MEDIUM-018 — resolveTagRefs must bound its input array.
 *
 * The refs feed a single `IN (...)` lookup, so an unbounded list is a cheap
 * amplification vector. The resolver caps the list at MAX_TAG_REFS_PER_QUERY
 * (1000) and rejects anything larger before touching the resolution service.
 */

const TENANT = 'tenant-uuid-1';

describe('resolveTagRefs input bound (SENSOR-MEDIUM-018)', () => {
  let resolver: UnifiedTagResolver;
  let resolve: jest.Mock;

  beforeEach(async () => {
    resolve = jest.fn().mockResolvedValue({ resolved: [], unresolved: [] });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UnifiedTagResolver,
        { provide: UnifiedTagService, useValue: {} },
        { provide: TagResolutionService, useValue: { resolve } },
      ],
    }).compile();
    resolver = module.get(UnifiedTagResolver);
  });

  it('rejects a refs array over the cap without hitting the resolution service', async () => {
    const refs = Array.from({ length: 1001 }, (_, i) => `DEV-AABB1122/tag${i}`);
    await expect(resolver.resolveTagRefs(refs, TENANT)).rejects.toThrow(BadRequestException);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('passes a refs array at the cap through to the resolution service', async () => {
    const refs = Array.from({ length: 1000 }, (_, i) => `DEV-AABB1122/tag${i}`);
    await resolver.resolveTagRefs(refs, TENANT);
    expect(resolve).toHaveBeenCalledWith(TENANT, refs);
  });
});
