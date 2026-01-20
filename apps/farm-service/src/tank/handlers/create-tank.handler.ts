/**
 * Create Tank Command Handler
 * @module Tank/Handlers
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConflictException,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { CreateTankCommand } from '../commands/create-tank.command';
import { Tank, TankType } from '../entities/tank.entity';
import { Department } from '../../department/entities/department.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { CodeGeneratorService } from '../../database/services/code-generator.service';

@CommandHandler(CreateTankCommand)
export class CreateTankHandler
  implements ICommandHandler<CreateTankCommand, Tank>
{
  private readonly logger = new Logger(CreateTankHandler.name);

  constructor(
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    private readonly auditLogService: AuditLogService,
    private readonly codeGeneratorService: CodeGeneratorService,
  ) {}

  async execute(command: CreateTankCommand): Promise<Tank> {
    const { tenantId, userId, input } = command;

    this.logger.log(
      `Creating tank: ${input.name} for tenant: ${tenantId}`,
    );

    // Validate department exists
    const department = await this.departmentRepository.findOne({
      where: { id: input.departmentId, tenantId },
    });

    if (!department) {
      throw new NotFoundException(
        `Department with id "${input.departmentId}" not found`,
      );
    }

    // Validate dimensions based on tank type
    this.validateDimensions(input.tankType, input);

    // Generate unique code
    const code = await this.codeGeneratorService.generateTankCode(tenantId);

    // Create entity
    const tank = this.tankRepository.create({
      tenantId,
      name: input.name,
      code,
      description: input.description,
      departmentId: input.departmentId,
      systemId: input.systemId,
      tankType: input.tankType,
      material: input.material,
      waterType: input.waterType,
      diameter: input.diameter,
      length: input.length,
      width: input.width,
      depth: input.depth,
      waterDepth: input.waterDepth,
      freeboard: input.freeboard,
      volume: 0, // Will be calculated in BeforeInsert
      maxBiomass: input.maxBiomass,
      currentBiomass: 0,
      maxDensity: input.maxDensity || 30,
      waterFlow: input.waterFlow as Tank['waterFlow'],
      aeration: input.aeration as Tank['aeration'],
      location: input.location as Tank['location'],
      status: input.status,
      installationDate: input.installationDate
        ? new Date(input.installationDate)
        : undefined,
      notes: input.notes,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    // Volume is calculated in BeforeInsert hook
    // but we can verify it here
    tank.calculateVolume();

    if (tank.volume <= 0) {
      throw new BadRequestException(
        'Invalid dimensions: calculated volume must be greater than 0',
      );
    }

    // Validate maxBiomass against maxDensity
    const maxByDensity = tank.volume * (input.maxDensity || 30);
    if (input.maxBiomass > maxByDensity) {
      this.logger.warn(
        `maxBiomass (${input.maxBiomass}kg) exceeds density limit (${maxByDensity.toFixed(2)}kg at ${input.maxDensity || 30}kg/m³)`,
      );
    }

    // Save
    const saved = await this.tankRepository.save(tank);

    // Audit log
    await this.auditLogService.log({
      tenantId,
      entityType: 'Tank',
      entityId: saved.id,
      action: AuditAction.CREATE,
      userId,
      changes: {
        after: {
          name: saved.name,
          code: saved.code,
          tankType: saved.tankType,
          volume: saved.volume,
          maxBiomass: saved.maxBiomass,
          departmentId: saved.departmentId,
        },
      },
    });

    this.logger.log(
      `Tank created: ${saved.id} - ${saved.code} (${saved.volume.toFixed(2)}m³)`,
    );

    return saved;
  }

  /**
   * Validates dimensions based on tank type
   */
  private validateDimensions(
    tankType: TankType,
    input: { diameter?: number; length?: number; width?: number; depth: number },
  ): void {
    if (!input.depth || input.depth <= 0) {
      throw new BadRequestException('Depth is required and must be > 0');
    }

    switch (tankType) {
      case TankType.CIRCULAR:
      case TankType.OVAL:
        if (!input.diameter || input.diameter <= 0) {
          throw new BadRequestException(
            `Diameter is required for ${tankType} tanks and must be > 0`,
          );
        }
        break;

      case TankType.RECTANGULAR:
      case TankType.SQUARE:
      case TankType.RACEWAY:
      case TankType.D_END:
        if (!input.length || input.length <= 0) {
          throw new BadRequestException(
            `Length is required for ${tankType} tanks and must be > 0`,
          );
        }
        if (!input.width || input.width <= 0) {
          throw new BadRequestException(
            `Width is required for ${tankType} tanks and must be > 0`,
          );
        }
        break;

      case TankType.OTHER:
        // For OTHER type, at least one dimension set should be provided
        const hasCircular = input.diameter && input.diameter > 0;
        const hasRectangular =
          input.length && input.length > 0 && input.width && input.width > 0;

        if (!hasCircular && !hasRectangular) {
          throw new BadRequestException(
            'For OTHER tank type, provide either diameter OR (length and width)',
          );
        }
        break;
    }
  }
}
