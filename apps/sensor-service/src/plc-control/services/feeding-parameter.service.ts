import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import {
  FeedingParameter,
  ParameterStatus,
  FeedingScheduleEntry,
  ThresholdConfig,
  VfdSettings,
} from '../entities/feeding-parameter.entity';
import { PlcConnection } from '../entities/plc-connection.entity';
import {
  CreateFeedingParameterDto,
  UpdateFeedingParameterDto,
  FeedingParameterFilterDto,
  ParameterSendResultDto,
} from '../dto';
import { PlcPaginationDto } from '../dto/plc-connection.dto';

/**
 * Result interface for paginated feeding parameters
 */
export interface PaginatedFeedingParameters {
  items: FeedingParameter[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Feeding Parameter Service
 * Handles CRUD operations for PLC feeding parameters with tenant isolation
 */
@Injectable()
export class FeedingParameterService {
  private readonly logger = new Logger(FeedingParameterService.name);

  constructor(
    @InjectRepository(FeedingParameter)
    private readonly feedingParameterRepository: Repository<FeedingParameter>,
    @InjectRepository(PlcConnection)
    private readonly plcConnectionRepository: Repository<PlcConnection>,
  ) {}

  /**
   * Create a new feeding parameter set
   */
  async create(
    input: CreateFeedingParameterDto,
    tenantId: string,
    userId?: string,
  ): Promise<FeedingParameter> {
    this.logger.log(`Creating feeding parameter: ${input.name} for tenant ${tenantId}`);

    // Verify PLC connection exists and belongs to tenant
    const plcConnection = await this.plcConnectionRepository.findOne({
      where: { id: input.plcConnectionId, tenantId },
    });

    if (!plcConnection) {
      throw new NotFoundException(
        `PLC connection with ID ${input.plcConnectionId} not found`,
      );
    }

    // Validate schedule
    this.validateSchedule(input.schedule as FeedingScheduleEntry[]);

    // Validate thresholds
    this.validateThresholds(input.thresholds as ThresholdConfig);

    // Validate VFD settings
    this.validateVfdSettings(input.vfdSettings as VfdSettings);

    const parameter = this.feedingParameterRepository.create({
      ...input,
      tenantId,
      status: ParameterStatus.DRAFT,
      createdBy: userId,
    });

    // Calculate checksum for data integrity
    parameter.checksum = this.calculateChecksum(parameter);

    const savedParameter = await this.feedingParameterRepository.save(parameter);
    this.logger.log(`Feeding parameter created with ID: ${savedParameter.id}`);

    return savedParameter;
  }

  /**
   * Find a feeding parameter by ID with tenant isolation
   */
  async findById(id: string, tenantId: string): Promise<FeedingParameter> {
    const parameter = await this.feedingParameterRepository.findOne({
      where: { id, tenantId },
      relations: ['plcConnection'],
    });

    if (!parameter) {
      throw new NotFoundException(`Feeding parameter with ID ${id} not found`);
    }

    return parameter;
  }

  /**
   * Find all feeding parameters with filtering and pagination
   */
  async findAll(
    tenantId: string,
    filter?: FeedingParameterFilterDto,
    pagination?: PlcPaginationDto,
  ): Promise<PaginatedFeedingParameters> {
    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.feedingParameterRepository
      .createQueryBuilder('fp')
      .leftJoinAndSelect('fp.plcConnection', 'plc')
      .where('fp.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter?.plcConnectionId) {
      queryBuilder.andWhere('fp.plcConnectionId = :plcConnectionId', {
        plcConnectionId: filter.plcConnectionId,
      });
    }

    if (filter?.tankId) {
      queryBuilder.andWhere('fp.tankId = :tankId', { tankId: filter.tankId });
    }

    if (filter?.status) {
      queryBuilder.andWhere('fp.status = :status', { status: filter.status });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(fp.name ILIKE :search OR fp.description ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    // Apply sorting
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';
    queryBuilder.orderBy(`fp.${sortBy}`, sortOrder);

    // Get total count and items
    const [items, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update a feeding parameter
   */
  async update(
    id: string,
    tenantId: string,
    input: UpdateFeedingParameterDto,
  ): Promise<FeedingParameter> {
    const parameter = await this.findById(id, tenantId);

    // Cannot update parameters that are already sent to PLC
    if (
      parameter.status === ParameterStatus.SENT ||
      parameter.status === ParameterStatus.ACTIVE
    ) {
      throw new ConflictException(
        'Cannot update parameters that have been sent to or are active on PLC. Create a new version instead.',
      );
    }

    // Validate schedule if being updated
    if (input.schedule) {
      this.validateSchedule(input.schedule as FeedingScheduleEntry[]);
    }

    // Validate thresholds if being updated
    if (input.thresholds) {
      this.validateThresholds(input.thresholds as ThresholdConfig);
    }

    // Validate VFD settings if being updated
    if (input.vfdSettings) {
      this.validateVfdSettings(input.vfdSettings as VfdSettings);
    }

    // Update fields
    Object.assign(parameter, input);
    parameter.updatedAt = new Date();

    // Recalculate checksum
    parameter.checksum = this.calculateChecksum(parameter);

    const updatedParameter = await this.feedingParameterRepository.save(parameter);
    this.logger.log(`Feeding parameter ${id} updated`);

    return updatedParameter;
  }

  /**
   * Delete a feeding parameter
   */
  async delete(id: string, tenantId: string): Promise<boolean> {
    const parameter = await this.findById(id, tenantId);

    // Cannot delete active parameters
    if (parameter.status === ParameterStatus.ACTIVE) {
      throw new BadRequestException(
        'Cannot delete active parameters. Please supersede them first.',
      );
    }

    await this.feedingParameterRepository.remove(parameter);
    this.logger.log(`Feeding parameter ${id} deleted`);

    return true;
  }

  /**
   * Send parameters to PLC
   * Note: Actual OPC UA write would be implemented here
   */
  async sendToPlc(
    id: string,
    tenantId: string,
  ): Promise<ParameterSendResultDto> {
    const parameter = await this.findById(id, tenantId);

    if (parameter.status !== ParameterStatus.DRAFT && parameter.status !== ParameterStatus.ERROR) {
      throw new BadRequestException(
        'Only DRAFT or ERROR parameters can be sent to PLC',
      );
    }

    this.logger.log(`Sending parameter ${id} to PLC ${parameter.plcConnectionId}`);

    try {
      // Update status to PENDING
      parameter.status = ParameterStatus.PENDING;
      await this.feedingParameterRepository.save(parameter);

      // TODO: Implement actual OPC UA write
      // In production, this would:
      // 1. Connect to PLC via OPC UA
      // 2. Write parameter data to designated node
      // 3. Wait for acknowledgment

      // Simulate sending
      await this.simulateSendToPlc(parameter);

      // Update status to SENT
      parameter.status = ParameterStatus.SENT;
      parameter.sentAt = new Date();
      await this.feedingParameterRepository.save(parameter);

      return {
        success: true,
        checksum: parameter.checksum,
        sentAt: parameter.sentAt,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Update status to ERROR
      parameter.status = ParameterStatus.ERROR;
      parameter.errorMessage = errorMessage;
      await this.feedingParameterRepository.save(parameter);

      return {
        success: false,
        error: errorMessage,
        sentAt: new Date(),
      };
    }
  }

  /**
   * Activate a parameter set (mark as currently used by PLC)
   */
  async activate(id: string, tenantId: string): Promise<FeedingParameter> {
    const parameter = await this.findById(id, tenantId);

    if (parameter.status !== ParameterStatus.SENT && parameter.status !== ParameterStatus.ACKNOWLEDGED) {
      throw new BadRequestException(
        'Only SENT or ACKNOWLEDGED parameters can be activated',
      );
    }

    // Supersede any currently active parameters for same PLC connection
    await this.feedingParameterRepository.update(
      {
        tenantId,
        plcConnectionId: parameter.plcConnectionId,
        status: ParameterStatus.ACTIVE,
      },
      {
        status: ParameterStatus.SUPERSEDED,
      },
    );

    // Activate this parameter
    parameter.status = ParameterStatus.ACTIVE;
    parameter.activatedAt = new Date();

    return this.feedingParameterRepository.save(parameter);
  }

  /**
   * Get active parameter for a PLC connection
   */
  async findActiveForConnection(
    plcConnectionId: string,
    tenantId: string,
  ): Promise<FeedingParameter | null> {
    return this.feedingParameterRepository.findOne({
      where: {
        plcConnectionId,
        tenantId,
        status: ParameterStatus.ACTIVE,
      },
      relations: ['plcConnection'],
    });
  }

  /**
   * Get parameter history for a PLC connection
   */
  async findHistoryForConnection(
    plcConnectionId: string,
    tenantId: string,
    limit: number = 10,
  ): Promise<FeedingParameter[]> {
    return this.feedingParameterRepository.find({
      where: {
        plcConnectionId,
        tenantId,
      },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Clone a parameter set (for creating new versions)
   */
  async clone(
    id: string,
    tenantId: string,
    newName?: string,
    userId?: string,
  ): Promise<FeedingParameter> {
    const original = await this.findById(id, tenantId);

    const clone = this.feedingParameterRepository.create({
      tenantId,
      plcConnectionId: original.plcConnectionId,
      tankId: original.tankId,
      name: newName || `${original.name} (Copy)`,
      description: original.description,
      version: this.incrementVersion(original.version),
      biomassKg: original.biomassKg,
      fcr: original.fcr,
      targetDailyFeedKg: original.targetDailyFeedKg,
      schedule: original.schedule,
      thresholds: original.thresholds,
      vfdSettings: original.vfdSettings,
      status: ParameterStatus.DRAFT,
      createdBy: userId,
    });

    clone.checksum = this.calculateChecksum(clone);

    return this.feedingParameterRepository.save(clone);
  }

  /**
   * Validate feeding schedule
   */
  private validateSchedule(schedule: FeedingScheduleEntry[]): void {
    if (!schedule || schedule.length === 0) {
      throw new BadRequestException('At least one feeding schedule entry is required');
    }

    const times = new Set<string>();
    for (const entry of schedule) {
      // Validate time format
      if (!/^\d{2}:\d{2}$/.test(entry.time)) {
        throw new BadRequestException(
          `Invalid time format: ${entry.time}. Use HH:mm format.`,
        );
      }

      // Check for duplicate times
      if (times.has(entry.time)) {
        throw new BadRequestException(
          `Duplicate feeding time: ${entry.time}`,
        );
      }
      times.add(entry.time);

      // Validate amount
      if (entry.amountKg <= 0) {
        throw new BadRequestException(
          'Feeding amount must be greater than 0',
        );
      }
    }
  }

  /**
   * Validate threshold configuration
   */
  private validateThresholds(thresholds: ThresholdConfig): void {
    if (thresholds.oxygenCritical >= thresholds.oxygenMin) {
      throw new BadRequestException(
        'Oxygen critical threshold must be less than oxygen minimum',
      );
    }

    if (thresholds.tempCritical <= thresholds.tempMax) {
      throw new BadRequestException(
        'Temperature critical threshold must be greater than temperature maximum',
      );
    }

    if (thresholds.phMin !== undefined && thresholds.phMax !== undefined) {
      if (thresholds.phMin >= thresholds.phMax) {
        throw new BadRequestException(
          'pH minimum must be less than pH maximum',
        );
      }
    }
  }

  /**
   * Validate VFD settings
   */
  private validateVfdSettings(vfdSettings: VfdSettings): void {
    if (vfdSettings.blowerMinSpeed >= vfdSettings.blowerMaxSpeed) {
      throw new BadRequestException(
        'Blower minimum speed must be less than maximum speed',
      );
    }

    if (vfdSettings.doserMinSpeed >= vfdSettings.doserMaxSpeed) {
      throw new BadRequestException(
        'Doser minimum speed must be less than maximum speed',
      );
    }
  }

  /**
   * Calculate checksum for parameter data integrity
   */
  private calculateChecksum(parameter: FeedingParameter): string {
    const data = JSON.stringify({
      biomassKg: parameter.biomassKg,
      fcr: parameter.fcr,
      targetDailyFeedKg: parameter.targetDailyFeedKg,
      schedule: parameter.schedule,
      thresholds: parameter.thresholds,
      vfdSettings: parameter.vfdSettings,
    });

    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Increment version string
   */
  private incrementVersion(version: string): string {
    const parts = version.split('.');
    const minor = parseInt(parts[1] || '0', 10) + 1;
    return `${parts[0]}.${minor}`;
  }

  /**
   * Simulate sending parameters to PLC (placeholder for actual OPC UA implementation)
   */
  private async simulateSendToPlc(_parameter: FeedingParameter): Promise<void> {
    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 200));

    // In production, this would:
    // 1. Serialize parameter data
    // 2. Connect to PLC via OPC UA
    // 3. Write to designated parameter node
    // 4. Verify write success
  }
}
