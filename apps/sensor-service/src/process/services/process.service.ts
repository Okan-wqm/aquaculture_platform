import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';

import {
  CreateProcessInput,
  UpdateProcessInput,
  ProcessFilterInput,
  ProcessPaginationInput,
} from '../dto/process.dto';
import { Process, ProcessStatus } from '../entities/process.entity';

export interface ProcessListResult {
  items: Process[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

@Injectable()
export class ProcessService {
  private readonly logger = new Logger(ProcessService.name);

  constructor(
    @InjectRepository(Process)
    private readonly processRepository: Repository<Process>,
  ) {}

  /**
   * Create a new process
   */
  async createProcess(
    input: CreateProcessInput,
    tenantId: string,
    userId?: string,
  ): Promise<Process> {
    this.logger.log(`Creating process "${input.name}" for tenant ${tenantId}`);

    const process = this.processRepository.create({
      ...input,
      tenantId,
      nodes: input.nodes || [],
      edges: input.edges || [],
      status: input.status || ProcessStatus.DRAFT,
      createdBy: userId,
    });

    const saved = await this.processRepository.save(process);
    this.logger.log(`Process created with ID: ${saved.id}`);

    return saved;
  }

  /**
   * Update an existing process
   */
  async updateProcess(
    input: UpdateProcessInput,
    tenantId: string,
    userId?: string,
  ): Promise<Process> {
    this.logger.log(`Updating process ${input.processId} for tenant ${tenantId}`);

    const process = await this.processRepository.findOne({
      where: { id: input.processId, tenantId },
    });

    if (!process) {
      throw new NotFoundException(`Process ${input.processId} not found`);
    }

    // Update fields
    if (input.name !== undefined) process.name = input.name;
    if (input.description !== undefined) process.description = input.description;
    if (input.status !== undefined) process.status = input.status;
    if (input.nodes !== undefined) process.nodes = input.nodes;
    if (input.edges !== undefined) process.edges = input.edges;
    if (input.siteId !== undefined) process.siteId = input.siteId;
    if (input.departmentId !== undefined) process.departmentId = input.departmentId;
    if (input.metadata !== undefined) process.metadata = input.metadata;
    if (input.isTemplate !== undefined) process.isTemplate = input.isTemplate;
    if (input.templateName !== undefined) process.templateName = input.templateName;

    process.updatedBy = userId;

    const saved = await this.processRepository.save(process);
    this.logger.log(`Process ${saved.id} updated successfully`);

    return saved;
  }

  /**
   * Get a single process by ID
   */
  async getProcess(id: string, tenantId: string): Promise<Process | null> {
    return this.processRepository.findOne({
      where: { id, tenantId },
    });
  }

  /**
   * Get a single process by ID (with validation)
   */
  async getProcessOrFail(id: string, tenantId: string): Promise<Process> {
    const process = await this.getProcess(id, tenantId);
    if (!process) {
      throw new NotFoundException(`Process ${id} not found`);
    }
    return process;
  }

  /**
   * List processes with filtering and pagination
   */
  async listProcesses(
    tenantId: string,
    filter?: ProcessFilterInput,
    pagination?: ProcessPaginationInput,
  ): Promise<ProcessListResult> {
    const offset = pagination?.offset || 0;
    const limit = Math.min(pagination?.limit || 20, 100); // Max 100

    const where: FindOptionsWhere<Process> = { tenantId };

    // Apply filters
    if (filter?.status) {
      where.status = filter.status;
    }
    if (filter?.siteId) {
      where.siteId = filter.siteId;
    }
    if (filter?.departmentId) {
      where.departmentId = filter.departmentId;
    }
    if (filter?.isTemplate !== undefined) {
      where.isTemplate = filter.isTemplate;
    }

    // Build query
    const queryBuilder = this.processRepository.createQueryBuilder('process');
    queryBuilder.where(where);

    // Search term filter
    if (filter?.searchTerm) {
      queryBuilder.andWhere(
        '(process.name ILIKE :search OR process.description ILIKE :search)',
        { search: `%${filter.searchTerm}%` },
      );
    }

    // Order and pagination
    queryBuilder.orderBy('process.updatedAt', 'DESC');
    queryBuilder.skip(offset);
    queryBuilder.take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total,
    };
  }

  /**
   * Get active processes for SCADA view
   */
  async getActiveProcesses(tenantId: string, siteId?: string): Promise<Process[]> {
    const where: FindOptionsWhere<Process> = {
      tenantId,
      status: ProcessStatus.ACTIVE,
      isTemplate: false,
    };

    if (siteId) {
      where.siteId = siteId;
    }

    return this.processRepository.find({
      where,
      order: { name: 'ASC' },
    });
  }

  /**
   * Get process templates
   */
  async getTemplates(tenantId: string): Promise<Process[]> {
    return this.processRepository.find({
      where: { tenantId, isTemplate: true },
      order: { templateName: 'ASC' },
    });
  }

  /**
   * Delete (archive) a process
   */
  async deleteProcess(id: string, tenantId: string): Promise<boolean> {
    this.logger.log(`Deleting process ${id} for tenant ${tenantId}`);

    const process = await this.getProcessOrFail(id, tenantId);

    // Soft delete by setting status to archived
    process.status = ProcessStatus.ARCHIVED;
    await this.processRepository.save(process);

    this.logger.log(`Process ${id} archived successfully`);
    return true;
  }

  /**
   * Hard delete a process (use with caution)
   */
  async hardDeleteProcess(id: string, tenantId: string): Promise<boolean> {
    this.logger.warn(`Hard deleting process ${id} for tenant ${tenantId}`);

    const result = await this.processRepository.delete({ id, tenantId });
    return (result.affected ?? 0) > 0;
  }

  /**
   * Duplicate a process
   */
  async duplicateProcess(
    id: string,
    newName: string,
    tenantId: string,
    userId?: string,
  ): Promise<Process> {
    const source = await this.getProcessOrFail(id, tenantId);

    const duplicate = this.processRepository.create({
      name: newName,
      description: source.description,
      status: ProcessStatus.DRAFT,
      nodes: source.nodes,
      edges: source.edges,
      siteId: source.siteId,
      departmentId: source.departmentId,
      metadata: source.metadata,
      isTemplate: false,
      tenantId,
      createdBy: userId,
    });

    return this.processRepository.save(duplicate);
  }

  /**
   * Create process from template
   */
  async createFromTemplate(
    templateId: string,
    name: string,
    tenantId: string,
    userId?: string,
  ): Promise<Process> {
    const template = await this.getProcessOrFail(templateId, tenantId);

    if (!template.isTemplate) {
      throw new ForbiddenException('Source process is not a template');
    }

    return this.duplicateProcess(templateId, name, tenantId, userId);
  }
}
