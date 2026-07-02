import { randomUUID } from 'crypto';

import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import { EdgeDeviceService } from '../../edge-device/edge-device.service';
import { MqttClientService } from '../../shared-mqtt/mqtt-client.service';

import {
  CreateProcessInput,
  UpdateProcessInput,
  ProcessFilterInput,
  ProcessPaginationInput,
} from '../dto/process.dto';
import { ArtifactService } from '../../deploy-artifact/artifact.service';
import { DeployArtifactType } from '../../deploy-artifact/entities/deploy-artifact.entity';
import { Process, ProcessStatus } from '../entities/process.entity';
import { ScadaDeployLogService } from './scada-deploy-log.service';
import { TagResolutionService } from './tag-resolution.service';

@Injectable()
export class ProcessService {
  private readonly logger = new Logger(ProcessService.name);

  constructor(
    @InjectRepository(Process)
    private readonly processRepository: Repository<Process>,
    @Optional()
    @Inject(MqttClientService)
    private readonly mqttClient: MqttClientService | null,
    @Optional()
    @Inject(EdgeDeviceService)
    private readonly edgeDeviceService: EdgeDeviceService | null,
    @Optional()
    @Inject(TagResolutionService)
    private readonly tagResolutionService: TagResolutionService | null,
    @Optional()
    @Inject(ArtifactService)
    private readonly artifactService: ArtifactService | null,
    @Optional()
    @Inject(ScadaDeployLogService)
    private readonly scadaDeployLogService: ScadaDeployLogService | null,
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

    // Generate code from name (slug format) + timestamp suffix for uniqueness
    const slug = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const code = `${slug}-${Date.now().toString(36)}`;

    const process = this.processRepository.create({
      ...input,
      code,
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
    // Monotonic version counter — carried into deploy payloads and artifact
    // snapshots (Faz 3; replaces the hardcoded `version: 1`).
    process.version = (process.version ?? 1) + 1;

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
  ): Promise<IStandardPaginatedResult<Process>> {
    const page = pagination?.page || 1;
    const limit = Math.min(pagination?.limit || 20, 100);
    const offset = (page - 1) * limit;

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

    // Use findAndCount which properly resolves column name mappings
    // (createQueryBuilder.where(object) does NOT resolve name: mappings)
    let whereConditions: FindOptionsWhere<Process> | FindOptionsWhere<Process>[];

    if (filter?.searchTerm) {
      const search = `%${filter.searchTerm}%`;
      whereConditions = [
        { ...where, name: ILike(search) },
        { ...where, description: ILike(search) },
      ];
    } else {
      whereConditions = where;
    }

    const [items, total] = await this.processRepository.findAndCount({
      where: whereConditions,
      order: { updatedAt: 'DESC' },
      skip: offset,
      take: limit,
    });

    return createStandardPaginatedResult(items, total, page, limit);
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

    const dupSlug = newName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const dupCode = `${dupSlug}-${Date.now().toString(36)}`;

    const duplicate = this.processRepository.create({
      name: newName,
      code: dupCode,
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

  /**
   * Deploy a SCADA process to an edge device via MQTT.
   *
   * 1. Process'i DB'den yükle
   * 2. Edge device'ı doğrula (aktif mi, online mı)
   * 3. Node'lardaki sensorMappings → tagMappings dönüşümü
   * 4. MQTT command publish (deploy_process)
   */
  async deployProcessToEdge(
    processId: string,
    deviceId: string,
    tenantId: string,
    userId?: string,
  ): Promise<{ success: boolean; message: string }> {
    // 1. Process'i yükle
    const process = await this.getProcessOrFail(processId, tenantId);

    // 2. Edge device service kontrolü
    if (!this.edgeDeviceService) {
      throw new BadRequestException('Edge device service not available');
    }

    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);

    if (!device.isOnline) {
      return { success: false, message: 'Device is offline — cannot deploy process' };
    }

    // 3. MQTT kontrolü
    if (!this.mqttClient) {
      throw new BadRequestException('MQTT service not available');
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      throw new BadRequestException('Not connected to MQTT broker');
    }

    // 4. sensorMappings → tagMappings dönüşümü
    // Rust ScadaProcess expects tagMappings as Vec<TagMapping> (flat array),
    // where each TagMapping = { tagName, equipmentId, sensorType, unit }
    const tagMappings: Array<{
      tagName: string;
      equipmentId: string;
      sensorType: string;
      unit: string;
    }> = [];

    for (const node of process.nodes) {
      if (node.data?.equipmentId && node.data?.sensorMappings?.length) {
        for (const sm of node.data.sensorMappings) {
          tagMappings.push({
            tagName: sm.channelName || sm.dataPath,
            equipmentId: node.data.equipmentId,
            sensorType: sm.dataType,
            unit: sm.unit || '',
          });
        }
      }
    }

    // 5. Tag SSoT raporu (Faz 1, warn-only): her tag mapping'i
    // `${deviceCode}/${tagName}` olarak unified_tags registry'sine karşı çöz.
    // Çözülemeyenler logla — bloklamaz; Faz 4 bunu deploy gate'ine çevirir.
    if (this.tagResolutionService && tagMappings.length > 0) {
      const refs = tagMappings.map((tm) => `${device.deviceCode}/${tm.tagName}`);
      const resolution = await this.tagResolutionService.resolve(tenantId, refs);
      if (resolution.unresolved.length > 0) {
        this.logger.warn(
          `deploy_process ${processId}: ${resolution.unresolved.length}/${refs.length} tag mapping registry'de çözülemedi: ${JSON.stringify(resolution.unresolved)}`,
        );
      }
    }

    // 6. Content-addressed snapshot (Faz 3) — the exact process graph +
    // resolved tag mappings that ship to the edge. Real version replaces
    // the historical hardcoded `1`.
    const version = process.version ?? 1;
    const deployContent: Record<string, unknown> = {
      processId,
      name: process.name,
      nodes: process.nodes,
      edges: process.edges,
      tagMappings,
      version,
    };

    let artifact = null;
    if (this.artifactService) {
      try {
        artifact = await this.artifactService.snapshot(tenantId, {
          artifactType: DeployArtifactType.PROCESS,
          content: deployContent,
          sourceEntityId: processId,
          sourceEntityVersion: version,
          createdBy: userId,
        });
      } catch (snapshotError) {
        this.logger.error(
          `Failed to snapshot process artifact: ${(snapshotError as Error).message}`,
        );
      }
    }

    // 7. MQTT deploy_process komutu publish (+ deploy log — process deploys
    // previously wrote NO log at all)
    const commandId = randomUUID();
    const topic = `tenants/${tenantId}/devices/${device.id}/commands`;
    const payload = {
      commandId,
      command: 'deploy_process',
      params: deployContent,
      timestamp: new Date().toISOString(),
    };

    if (this.scadaDeployLogService) {
      try {
        await this.scadaDeployLogService.createLog({
          tenantId,
          processId,
          deviceId: device.id,
          commandId,
          version,
          deployedBy: userId,
          artifactId: artifact?.id,
          checksumSha256: artifact?.contentSha256,
        });
      } catch (logError) {
        this.logger.error(
          `Failed to create process deploy log: ${(logError as Error).message}`,
        );
      }
    }

    try {
      await this.mqttClient.publish(topic, payload);
      this.logger.log(
        `Process "${process.name}" v${version} deployed to device ${device.deviceCode} (process: ${processId}, command: ${commandId}, user: ${userId || 'system'})`,
      );
      return { success: true, message: 'Process deployed to edge device successfully' };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to deploy process to ${device.deviceCode}: ${msg}`);
      return { success: false, message: `Failed to deploy process: ${msg}` };
    }
  }
}
