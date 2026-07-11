import { Resolver, Query, Mutation, Args, ID, Int } from '@nestjs/graphql';
import { BadRequestException } from '@nestjs/common';
import { Tenant, Roles, Role } from '@aquaculture/backend-common/decorators';

import {
  CreateTagInput,
  UpdateTagInput,
  TagFilterInput,
  UnifiedTagType,
  UnifiedTagListType,
  TagDiscoveryResultType,
  TagResolutionResultType,
} from '../dto/unified-tag.dto';
import { ProcessPaginationInput } from '../dto/process.dto';
import { UnifiedTag } from '../entities/unified-tag.entity';
import { UnifiedTagService } from '../services/unified-tag.service';
import { TagResolutionService } from '../services/tag-resolution.service';

/**
 * Upper bound on the number of TagRefs a single resolveTagRefs query may carry.
 * The refs feed one `IN (...)` lookup, so an unbounded list is a cheap
 * amplification vector; a real screen/package resolves at most a few hundred.
 */
const MAX_TAG_REFS_PER_QUERY = 1000;

@Resolver(() => UnifiedTagType)
export class UnifiedTagResolver {
  constructor(
    private readonly unifiedTagService: UnifiedTagService,
    private readonly tagResolutionService: TagResolutionService,
  ) {}

  // ============================================================================
  // Queries
  // ============================================================================

  @Query(() => UnifiedTagType, { name: 'unifiedTag', nullable: true })
  async getTag(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<UnifiedTagType | null> {
    const tag = await this.unifiedTagService.getTag(id, tenantId);
    if (!tag) return null;
    return this.mapToType(tag);
  }

  @Query(() => UnifiedTagListType, { name: 'unifiedTags' })
  async listTags(
    @Args('filter', { nullable: true }) filter?: TagFilterInput,
    @Args('pagination', { nullable: true }) pagination?: ProcessPaginationInput,
    @Tenant() tenantId: string = '',
  ): Promise<UnifiedTagListType> {
    const result = await this.unifiedTagService.listTags(tenantId, filter, pagination);
    return {
      ...result,
      items: result.items.map((t) => this.mapToType(t)),
    };
  }

  @Query(() => [UnifiedTagType], { name: 'searchTags' })
  async searchTags(
    @Args('query') query: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Tenant() tenantId: string = '',
  ): Promise<UnifiedTagType[]> {
    const tags = await this.unifiedTagService.tagSearch(query, tenantId, limit);
    return tags.map((t) => this.mapToType(t));
  }

  /**
   * Resolve canonical TagRefs (`deviceCode/localName`) against the tag
   * registry by exact FQN. Invalid grammar and unknown refs come back as
   * structured `unresolved` entries — never a silent pass.
   */
  @Query(() => TagResolutionResultType, { name: 'resolveTagRefs' })
  async resolveTagRefs(
    @Args('refs', { type: () => [String] }) refs: string[],
    @Tenant() tenantId: string = '',
  ): Promise<TagResolutionResultType> {
    if (refs.length > MAX_TAG_REFS_PER_QUERY) {
      throw new BadRequestException(
        `resolveTagRefs accepts at most ${MAX_TAG_REFS_PER_QUERY} refs per query (got ${refs.length})`,
      );
    }
    const result = await this.tagResolutionService.resolve(tenantId, refs);
    return {
      resolved: result.resolved.map((binding) => ({
        ref: binding.ref,
        unifiedTagId: binding.unifiedTagId,
        ioType: binding.ioType,
        dataType: binding.dataType,
        direction: binding.direction,
        engUnit: binding.engUnit,
        source: binding.source as Record<string, unknown>,
        revision: binding.revision,
      })),
      unresolved: result.unresolved.map((entry) => ({ ...entry })),
    };
  }

  // ============================================================================
  // Mutations
  // ============================================================================

  @Mutation(() => UnifiedTagType, { name: 'createUnifiedTag' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createTag(
    @Args('input') input: CreateTagInput,
    @Tenant() tenantId: string,
  ): Promise<UnifiedTagType> {
    const tag = await this.unifiedTagService.createTag(input, tenantId);
    return this.mapToType(tag);
  }

  @Mutation(() => UnifiedTagType, { name: 'updateUnifiedTag' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateTag(
    @Args('input') input: UpdateTagInput,
    @Tenant() tenantId: string,
  ): Promise<UnifiedTagType> {
    const tag = await this.unifiedTagService.updateTag(input.id, input, tenantId);
    return this.mapToType(tag);
  }

  @Mutation(() => Boolean, { name: 'deleteUnifiedTag' })
  @Roles(Role.TENANT_ADMIN)
  async deleteTag(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.unifiedTagService.deleteTag(id, tenantId);
  }

  @Mutation(() => TagDiscoveryResultType, { name: 'discoverTags' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async discoverTags(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<TagDiscoveryResultType> {
    try {
      const result = await this.unifiedTagService.discoverTags(deviceId, tenantId);
      return {
        success: true,
        message: `Discovered ${result.discoveredCount} I/O configs, created ${result.createdCount} new tags`,
        discoveredCount: result.discoveredCount,
        createdCount: result.createdCount,
        tags: result.tags.map((t) => this.mapToType(t)),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
        discoveredCount: 0,
        createdCount: 0,
        tags: [],
      };
    }
  }

  @Mutation(() => TagDiscoveryResultType, { name: 'autoBindTags' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async autoBindTags(
    @Args('processId', { type: () => ID }) processId: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<TagDiscoveryResultType> {
    try {
      const result = await this.unifiedTagService.autoBindTags(processId, deviceId, tenantId);
      return {
        success: true,
        message: `Auto-bind complete: ${result.discoveredCount} discovered, ${result.createdCount} created`,
        discoveredCount: result.discoveredCount,
        createdCount: result.createdCount,
        tags: result.tags.map((t) => this.mapToType(t)),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
        discoveredCount: 0,
        createdCount: 0,
        tags: [],
      };
    }
  }

  // ============================================================================
  // Helper
  // ============================================================================

  private mapToType(tag: UnifiedTag): UnifiedTagType {
    return {
      id: tag.id,
      tenantId: tag.tenantId,
      fqn: tag.fqn,
      localName: tag.localName,
      displayName: tag.displayName,
      description: tag.description,
      ioType: tag.ioType,
      dataType: tag.dataType,
      direction: tag.direction,
      engUnit: tag.engUnit,
      engMin: tag.engMin,
      engMax: tag.engMax,
      alarmHH: tag.alarmHH,
      alarmH: tag.alarmH,
      alarmL: tag.alarmL,
      alarmLL: tag.alarmLL,
      deadband: tag.deadband,
      source: tag.source as Record<string, unknown>,
      hierarchy: tag.hierarchy as Record<string, unknown>,
      status: tag.status,
      revision: tag.revision,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
    };
  }
}
