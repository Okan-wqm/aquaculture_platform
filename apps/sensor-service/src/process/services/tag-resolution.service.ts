import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TagRef, isTagRef } from '@platform/sensor-contracts';

import {
  TagDataType,
  TagDirection,
  TagIoType,
  TagSource,
  TagStatus,
  UnifiedTag,
} from '../entities/unified-tag.entity';

/**
 * A tag reference resolved against the tenant's tag registry
 * (`unified_tags`). Deploy pipelines embed this snapshot in the artifact so
 * the edge and the runtime never re-resolve names themselves.
 */
export interface ResolvedTagBinding {
  ref: TagRef;
  unifiedTagId: string;
  ioType: TagIoType;
  dataType: TagDataType;
  direction: TagDirection;
  engUnit?: string;
  source: TagSource;
  /** Registry revision the binding was resolved against. */
  revision: number;
}

export type UnresolvedReason = 'INVALID_GRAMMAR' | 'NOT_FOUND' | 'RETIRED';

export interface UnresolvedTagRef {
  ref: string;
  reason: UnresolvedReason;
}

export interface TagResolutionResult {
  resolved: ResolvedTagBinding[];
  unresolved: UnresolvedTagRef[];
}

/**
 * Resolves canonical TagRefs against the tag registry by EXACT FQN lookup —
 * the registry (`unified_tags`, unique per `tenantId+fqn`) is the single
 * source of truth for tag identity. Free-text/fuzzy matching is deliberately
 * unsupported: an unresolvable ref is a structured result the caller must
 * handle, never a silent pass.
 */
@Injectable()
export class TagResolutionService {
  private readonly logger = new Logger(TagResolutionService.name);

  constructor(
    @InjectRepository(UnifiedTag)
    private readonly tagRepository: Repository<UnifiedTag>,
  ) {}

  async resolve(tenantId: string, rawRefs: readonly string[]): Promise<TagResolutionResult> {
    const unresolved: UnresolvedTagRef[] = [];
    const validRefs: TagRef[] = [];
    const seen = new Set<string>();

    for (const raw of rawRefs) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      if (isTagRef(raw)) {
        validRefs.push(raw);
      } else {
        unresolved.push({ ref: raw, reason: 'INVALID_GRAMMAR' });
      }
    }

    const tags = validRefs.length
      ? await this.tagRepository.find({ where: { tenantId, fqn: In(validRefs) } })
      : [];
    const byFqn = new Map(tags.map((tag) => [tag.fqn, tag]));

    const resolved: ResolvedTagBinding[] = [];
    for (const ref of validRefs) {
      const tag = byFqn.get(ref);
      if (!tag) {
        unresolved.push({ ref, reason: 'NOT_FOUND' });
        continue;
      }
      if (tag.status === TagStatus.RETIRED) {
        unresolved.push({ ref, reason: 'RETIRED' });
        continue;
      }
      resolved.push({
        ref,
        unifiedTagId: tag.id,
        ioType: tag.ioType,
        dataType: tag.dataType,
        direction: tag.direction,
        engUnit: tag.engUnit,
        source: tag.source,
        revision: tag.revision,
      });
    }

    if (unresolved.length > 0) {
      this.logger.warn(
        `Tag resolution: ${resolved.length} resolved, ${unresolved.length} unresolved for tenant ${tenantId}: ${JSON.stringify(unresolved)}`,
      );
    }

    return { resolved, unresolved };
  }
}
