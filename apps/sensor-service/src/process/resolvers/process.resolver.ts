import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ProcessService } from '../services/process.service';
import {
  CreateProcessInput,
  UpdateProcessInput,
  ProcessFilterInput,
  ProcessPaginationInput,
  ProcessType,
  ProcessResultType,
  ProcessListType,
  DeleteProcessResultType,
} from '../dto/process.dto';
import { Process } from '../entities/process.entity';
import { Tenant, CurrentUser, CurrentUserPayload } from '@platform/backend-common';

@Resolver(() => ProcessType)
export class ProcessResolver {
  constructor(private processService: ProcessService) {}

  // ============================================================================
  // Queries
  // ============================================================================

  @Query(() => ProcessType, { name: 'process', nullable: true })
  async getProcess(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<ProcessType | null> {
    const process = await this.processService.getProcess(id, tenantId);
    if (!process) return null;
    return this.mapToType(process);
  }

  @Query(() => ProcessListType, { name: 'processes' })
  async listProcesses(
    @Args('filter', { nullable: true }) filter?: ProcessFilterInput,
    @Args('pagination', { nullable: true }) pagination?: ProcessPaginationInput,
    @Tenant() tenantId?: string,
  ): Promise<ProcessListType> {
    const result = await this.processService.listProcesses(tenantId!, filter, pagination);
    return {
      items: result.items.map((p) => this.mapToType(p)),
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      hasMore: result.hasMore,
    };
  }

  @Query(() => [ProcessType], { name: 'activeProcesses' })
  async getActiveProcesses(
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Tenant() tenantId?: string,
  ): Promise<ProcessType[]> {
    const processes = await this.processService.getActiveProcesses(tenantId!, siteId);
    return processes.map((p) => this.mapToType(p));
  }

  @Query(() => [ProcessType], { name: 'processTemplates' })
  async getProcessTemplates(
    @Tenant() tenantId: string,
  ): Promise<ProcessType[]> {
    const templates = await this.processService.getTemplates(tenantId);
    return templates.map((p) => this.mapToType(p));
  }

  // ============================================================================
  // Mutations
  // ============================================================================

  @Mutation(() => ProcessResultType, { name: 'createProcess' })
  async createProcess(
    @Args('input') input: CreateProcessInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProcessResultType> {
    try {
      const process = await this.processService.createProcess(input, tenantId, user.sub);
      return {
        success: true,
        message: 'Process created successfully',
        process: this.mapToType(process),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to create process',
      };
    }
  }

  @Mutation(() => ProcessResultType, { name: 'updateProcess' })
  async updateProcess(
    @Args('input') input: UpdateProcessInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProcessResultType> {
    try {
      const process = await this.processService.updateProcess(input, tenantId, user.sub);
      return {
        success: true,
        message: 'Process updated successfully',
        process: this.mapToType(process),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to update process',
      };
    }
  }

  @Mutation(() => DeleteProcessResultType, { name: 'deleteProcess' })
  async deleteProcess(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DeleteProcessResultType> {
    try {
      const success = await this.processService.deleteProcess(id, tenantId);
      return {
        success,
        message: success ? 'Process archived successfully' : 'Failed to archive process',
        deletedId: success ? id : undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to delete process',
      };
    }
  }

  @Mutation(() => ProcessResultType, { name: 'duplicateProcess' })
  async duplicateProcess(
    @Args('id', { type: () => ID }) id: string,
    @Args('newName') newName: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProcessResultType> {
    try {
      const process = await this.processService.duplicateProcess(id, newName, tenantId, user.sub);
      return {
        success: true,
        message: 'Process duplicated successfully',
        process: this.mapToType(process),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to duplicate process',
      };
    }
  }

  @Mutation(() => ProcessResultType, { name: 'createProcessFromTemplate' })
  async createFromTemplate(
    @Args('templateId', { type: () => ID }) templateId: string,
    @Args('name') name: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProcessResultType> {
    try {
      const process = await this.processService.createFromTemplate(templateId, name, tenantId, user.sub);
      return {
        success: true,
        message: 'Process created from template successfully',
        process: this.mapToType(process),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to create process from template',
      };
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private mapToType(process: Process): ProcessType {
    return {
      id: process.id,
      name: process.name,
      description: process.description,
      status: process.status,
      nodes: process.nodes,
      edges: process.edges,
      tenantId: process.tenantId,
      siteId: process.siteId,
      departmentId: process.departmentId,
      metadata: process.metadata,
      isTemplate: process.isTemplate,
      templateName: process.templateName,
      createdAt: process.createdAt,
      updatedAt: process.updatedAt,
      createdBy: process.createdBy,
      updatedBy: process.updatedBy,
    };
  }
}
