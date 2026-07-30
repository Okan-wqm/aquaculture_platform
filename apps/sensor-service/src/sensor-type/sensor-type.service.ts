import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, QueryFailedError, EntityManager } from 'typeorm';

/** System tenant ID for built-in sensor type definitions */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

import { SensorDataChannel, ChannelDataType, DiscoverySource } from '../database/entities/sensor-data-channel.entity';
import { IndustryTemplate } from '../database/entities/industry-template.entity';
import { SensorTypeDefinition } from '../database/entities/sensor-type-definition.entity';

import { CreateSensorTypeInput } from './dto/create-sensor-type.dto';
import { UpdateSensorTypeInput } from './dto/update-sensor-type.dto';

/**
 * Channel definition from defaultChannels JSONB
 */
interface ChannelDefinition {
  channelKey: string;
  displayLabel: string;
  description?: string;
  dataType?: ChannelDataType;
  unit?: string;
  unitSymbol?: string;
  physicalMin?: number;
  physicalMax?: number;
  operationalMin?: number;
  operationalMax?: number;
  displayOrder?: number;
}

/**
 * Template sensor type definition from sensorTypes JSONB
 */
interface TemplateSensorType {
  typeKey: string;
  displayName: string;
  description?: string;
  icon?: string;
  category?: string;
  industry?: string;
  defaultChannels?: ChannelDefinition[];
  metadata?: Record<string, unknown>;
}

/**
 * SensorTypeService
 * Manages sensor type definitions and industry template operations.
 */
@Injectable()
export class SensorTypeService {
  private readonly logger = new Logger(SensorTypeService.name);

  constructor(
    @InjectRepository(SensorTypeDefinition)
    private readonly sensorTypeRepo: Repository<SensorTypeDefinition>,
    @InjectRepository(IndustryTemplate)
    private readonly templateRepo: Repository<IndustryTemplate>,
    @InjectRepository(SensorDataChannel)
    private readonly channelRepo: Repository<SensorDataChannel>,
  ) {}

  /**
   * Get all sensor types for a tenant (tenant-specific + system types)
   * Ordered by displayName ASC
   */
  async getSensorTypes(tenantId: string): Promise<SensorTypeDefinition[]> {
    return this.sensorTypeRepo.find({
      where: [
        { tenantId },
        { isSystem: true },
      ],
      order: { displayName: 'ASC' },
    });
  }

  /**
   * Create a custom sensor type for a tenant
   * System types cannot be created through this method
   */
  async createSensorType(
    tenantId: string,
    input: CreateSensorTypeInput,
  ): Promise<SensorTypeDefinition> {
    // Check for system type collision
    const systemConflict = await this.sensorTypeRepo.findOne({
      where: { typeKey: input.typeKey, isSystem: true },
    });
    if (systemConflict) {
      throw new ConflictException(`Type key "${input.typeKey}" conflicts with a system type`);
    }

    // Check for duplicate typeKey within this tenant
    const existing = await this.sensorTypeRepo.findOne({
      where: { tenantId, typeKey: input.typeKey },
    });

    if (existing) {
      throw new ConflictException(
        `Sensor type with key "${input.typeKey}" already exists for this tenant`,
      );
    }

    const sensorType = this.sensorTypeRepo.create({
      tenantId,
      typeKey: input.typeKey,
      displayName: input.displayName,
      description: input.description,
      icon: input.icon,
      category: input.category,
      industry: input.industry,
      defaultChannels: input.defaultChannels ?? [],
      metadata: input.metadata ?? {},
      isSystem: false,
    });

    this.logger.log(
      `Creating sensor type "${input.typeKey}" for tenant ${tenantId}`,
    );

    return this.sensorTypeRepo.save(sensorType);
  }

  /**
   * Update an existing sensor type
   * System types cannot be updated
   */
  async updateSensorType(
    tenantId: string,
    id: string,
    input: UpdateSensorTypeInput,
  ): Promise<SensorTypeDefinition> {
    const sensorType = await this.sensorTypeRepo.findOne({
      where: { id, tenantId },
    });

    if (!sensorType) {
      throw new NotFoundException(`Sensor type with ID "${id}" not found`);
    }

    if (sensorType.isSystem) {
      throw new BadRequestException('System sensor types cannot be modified');
    }

    if (input.displayName !== undefined) sensorType.displayName = input.displayName;
    if (input.description !== undefined) sensorType.description = input.description;
    if (input.icon !== undefined) sensorType.icon = input.icon;
    if (input.category !== undefined) sensorType.category = input.category;
    if (input.industry !== undefined) sensorType.industry = input.industry;
    if (input.defaultChannels !== undefined) sensorType.defaultChannels = input.defaultChannels;
    if (input.metadata !== undefined) sensorType.metadata = input.metadata;

    return this.sensorTypeRepo.save(sensorType);
  }

  /**
   * Delete a sensor type
   * System types cannot be deleted
   */
  async deleteSensorType(tenantId: string, id: string): Promise<boolean> {
    const sensorType = await this.sensorTypeRepo.findOne({
      where: { id, tenantId },
    });

    if (!sensorType) {
      throw new NotFoundException(`Sensor type with ID "${id}" not found`);
    }

    if (sensorType.isSystem) {
      throw new BadRequestException('System sensor types cannot be deleted');
    }

    await this.sensorTypeRepo.remove(sensorType);

    this.logger.log(
      `Deleted sensor type "${sensorType.typeKey}" for tenant ${tenantId}`,
    );

    return true;
  }

  /**
   * Get all active industry templates
   * Ordered by displayName ASC
   */
  async getTemplates(): Promise<IndustryTemplate[]> {
    return this.templateRepo.find({
      where: { isActive: true },
      order: { displayName: 'ASC' },
    });
  }

  /**
   * Apply an industry template for a tenant
   * Creates sensor type definitions from the template.
   * Skips types that already exist for the tenant (by typeKey).
   */
  async applyTemplate(
    tenantId: string,
    templateKey: string,
  ): Promise<SensorTypeDefinition[]> {
    const template = await this.templateRepo.findOne({
      where: { templateKey, isActive: true },
    });

    if (!template) {
      throw new NotFoundException(
        `Industry template with key "${templateKey}" not found or inactive`,
      );
    }

    const sensorTypeDefs = template.sensorTypes as TemplateSensorType[];

    if (!Array.isArray(sensorTypeDefs) || sensorTypeDefs.length === 0) {
      this.logger.warn(
        `Template "${templateKey}" has no sensor type definitions`,
      );
      return [];
    }

    // Find existing type keys for this tenant to skip duplicates
    const typeKeys = sensorTypeDefs.map((st) => st.typeKey);
    const existingTypes = await this.sensorTypeRepo.find({
      where: { tenantId, typeKey: In(typeKeys) },
    });
    const existingKeys = new Set(existingTypes.map((t) => t.typeKey));

    const created: SensorTypeDefinition[] = [];

    for (const typeDef of sensorTypeDefs) {
      if (existingKeys.has(typeDef.typeKey)) {
        this.logger.debug(
          `Skipping type "${typeDef.typeKey}" — already exists for tenant ${tenantId}`,
        );
        continue;
      }

      try {
        const sensorType = this.sensorTypeRepo.create({
          tenantId,
          typeKey: typeDef.typeKey,
          displayName: typeDef.displayName,
          description: typeDef.description,
          icon: typeDef.icon,
          category: typeDef.category,
          industry: typeDef.industry,
          defaultChannels: typeDef.defaultChannels ?? [],
          metadata: typeDef.metadata ?? {},
          isSystem: false,
        });

        const saved = await this.sensorTypeRepo.save(sensorType);
        created.push(saved);
      } catch (error) {
        // Handle race condition: concurrent applyTemplate calls may cause unique constraint violation
        if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === '23505') {
          this.logger.debug(
            `Skipping type "${typeDef.typeKey}" — created concurrently for tenant ${tenantId}`,
          );
          continue;
        }
        throw error;
      }
    }

    this.logger.log(
      `Applied template "${templateKey}" for tenant ${tenantId}: created ${created.length} types, skipped ${existingKeys.size} existing`,
    );

    return created;
  }

  /**
   * Create sensor data channels from a type definition's defaultChannels
   * Used when a sensor is assigned a type definition — populates its channels
   */
  async createChannelsFromTypeDefinition(
    sensorId: string,
    tenantId: string,
    typeDefinitionId: string,
    // SENSOR-MEDIUM-071: when registration passes its transaction manager, the
    // type-def lookup + channel writes join that transaction, so a bootstrap
    // failure rolls back the sensor row too (no channel-less orphan). Omitted by
    // standalone callers, which keep using the injected (auto-commit) repos.
    manager?: EntityManager,
  ): Promise<SensorDataChannel[]> {
    // withRepository binds the injected repository to the caller's transaction
    // (not getRepository — that would bypass the tenant-aware repo, banned by lint).
    const typeRepo = manager ? manager.withRepository(this.sensorTypeRepo) : this.sensorTypeRepo;
    const channelRepo = manager ? manager.withRepository(this.channelRepo) : this.channelRepo;

    const typeDef = await typeRepo.findOne({
      where: [
        { id: typeDefinitionId, tenantId },
        { id: typeDefinitionId, isSystem: true, tenantId: SYSTEM_TENANT_ID },
      ],
    });

    if (!typeDef) {
      throw new NotFoundException(
        `Sensor type definition with ID "${typeDefinitionId}" not found`,
      );
    }

    const channelDefs = typeDef.defaultChannels as ChannelDefinition[];

    if (!Array.isArray(channelDefs) || channelDefs.length === 0) {
      this.logger.debug(
        `Type definition "${typeDef.typeKey}" has no default channels`,
      );
      return [];
    }

    // Check for existing channels to avoid duplicates
    const existingChannels = await channelRepo.find({
      where: { sensorId, tenantId },
    });
    const existingKeys = new Set(existingChannels.map((c) => c.channelKey));

    const channels: SensorDataChannel[] = [];

    for (const chDef of channelDefs) {
      if (existingKeys.has(chDef.channelKey)) {
        this.logger.debug(
          `Skipping channel "${chDef.channelKey}" — already exists for sensor ${sensorId}`,
        );
        continue;
      }

      const channel = channelRepo.create({
        sensorId,
        tenantId,
        channelKey: chDef.channelKey,
        displayLabel: chDef.displayLabel,
        description: chDef.description,
        dataType: chDef.dataType ?? ChannelDataType.NUMBER,
        unit: chDef.unit,
        unitSymbol: chDef.unitSymbol,
        physicalMin: chDef.physicalMin,
        physicalMax: chDef.physicalMax,
        operationalMin: chDef.operationalMin,
        operationalMax: chDef.operationalMax,
        displayOrder: chDef.displayOrder ?? 0,
        discoverySource: DiscoverySource.TEMPLATE,
        discoveredAt: new Date(),
        isEnabled: true,
        calibrationEnabled: false,
        calibrationMultiplier: 1.0,
        calibrationOffset: 0.0,
      });

      channels.push(channel);
    }

    const created = channels.length > 0 ? await channelRepo.save(channels) : [];

    this.logger.log(
      `Created ${created.length} channels for sensor ${sensorId} from type "${typeDef.typeKey}"`,
    );

    return created;
  }
}
