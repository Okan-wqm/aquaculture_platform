/**
 * Create Tank Command Handler
 * @module Tank/Handlers
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { assertWithinQuota } from '@aquaculture/backend-common/quota';
import { Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import {
  TankCreatedEvent,
  createBaseEvent,
  resolvePlanLimits,
  tenantPlanFromLevel,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { defaultFarmStockProjectionForDirectHandlerConstruction } from '../../common/services/direct-handler-dependency-defaults';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { CodeGeneratorService } from '../../database/services/code-generator.service';
import { Department } from '../../department/entities/department.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { System } from '../../system/entities/system.entity';
import { CreateTankCommand } from '../commands/create-tank.command';
import { Tank, TankType, TankMaterial, WaterType, TankStatus } from '../entities/tank.entity';

import { tankAuditSnapshot } from './tank-audit.util';
import { BatchAggregateMutationPort } from '../../batch/batch-aggregate-mutation.port';

@CommandHandler(CreateTankCommand)
export class CreateTankHandler implements ICommandHandler<CreateTankCommand, Tank> {
  private readonly logger = new Logger(CreateTankHandler.name);

  constructor(
    private readonly batchMutations: BatchAggregateMutationPort,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly codeGeneratorService: CodeGeneratorService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly farmStockProjection: FarmStockProjectionService = defaultFarmStockProjectionForDirectHandlerConstruction(),
  ) {}

  async execute(command: CreateTankCommand): Promise<Tank> {
    const { tenantId, userId, input, planLevel } = command;

    this.logger.log(`Creating tank: ${input.name} for tenant: ${tenantId}`);

    // WHY: tankType/material/waterType/status lost their GraphQL `defaultValue` (it
    // broke enum coercion). WHAT: apply the same defaults server-side when the client
    // omits them, so optional input keeps its previous behaviour.
    const tankType = input.tankType ?? TankType.CIRCULAR;
    const material = input.material ?? TankMaterial.FIBERGLASS;
    const waterType = input.waterType ?? WaterType.SALTWATER;
    const status = input.status ?? TankStatus.PREPARING;

    return runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const tankRepository = tenantManagerRepo(queryRunner.manager, Tank, tenantId);
        const departmentRepository = tenantManagerRepo(queryRunner.manager, Department, tenantId);
        const systemRepository = tenantManagerRepo(queryRunner.manager, System, tenantId);

        // SSOT-C-13: fail-closed per-plan pond/tank-count quota. Skipped when the
        // caller carries no plan ordinal (platform SUPER_ADMIN). Counted inside the
        // tx so concurrent creates cannot both slip past the limit. This is a count
        // limit on the NUMBER of tanks the plan allows — distinct from per-tank
        // over-capacity stocking, which is legitimately admin-overridable.
        if (planLevel !== undefined) {
          const maxPonds = resolvePlanLimits(tenantPlanFromLevel(planLevel)).maxPonds;
          if (maxPonds !== -1) {
            const currentPonds = await tankRepository.count({ where: { tenantId } });
            assertWithinQuota('ponds', currentPonds, maxPonds);
          }
        }

        const department = await departmentRepository.findOne({
          where: { id: input.departmentId, tenantId },
        });

        if (!department) {
          throw new NotFoundException(`Department with id "${input.departmentId}" not found`);
        }
        if (department.isDeleted) {
          throw new BadRequestException(`Department with id "${input.departmentId}" is deleted`);
        }

        if (input.systemId) {
          const system = await systemRepository.findOne({
            where: { id: input.systemId, tenantId },
          });
          if (!system) {
            throw new NotFoundException(`System with id "${input.systemId}" not found`);
          }
          if (system.isDeleted) {
            throw new BadRequestException(`System with id "${input.systemId}" is deleted`);
          }
          if (system.siteId !== department.siteId) {
            throw new BadRequestException(
              `System "${system.name}" does not belong to the same site as the department`,
            );
          }
        }

        this.validateDimensions(tankType, input);

        const code = await this.codeGeneratorService.generateTankCodeWithManager(
          queryRunner.manager,
          tenantId,
        );

        const tank = tankRepository.create({
          name: input.name,
          code,
          description: input.description,
          departmentId: input.departmentId,
          systemId: input.systemId,
          containerKind: input.containerKind,
          equipmentTypeId: input.equipmentTypeId,
          equipmentTypeCode: input.equipmentTypeCode,
          temperatureSensorId: input.temperatureSensorId,
          regulatoryUnitId: input.regulatoryUnitId,
          tankType,
          material,
          waterType,
          diameter: input.diameter,
          length: input.length,
          width: input.width,
          depth: input.depth,
          waterDepth: input.waterDepth,
          freeboard: input.freeboard,
          volume: input.volume ?? 0,
          maxBiomass: input.maxBiomass,
          currentBiomass: 0,
          maxDensity: input.maxDensity || 30,
          waterFlow: input.waterFlow,
          aeration: input.aeration as Tank['aeration'],
          location: input.location,
          status,
          installationDate: input.installationDate ? new Date(input.installationDate) : undefined,
          notes: input.notes,
          isActive: true,
          createdBy: userId,
          updatedBy: userId,
        });

        tank.calculateVolume();

        if (tank.volume <= 0 && input.volume && input.volume > 0) {
          tank.volume = input.volume;
        }

        if (tank.volume <= 0) {
          throw new BadRequestException(
            'Invalid dimensions: calculated volume must be greater than 0',
          );
        }

        const maxByDensity = tank.volume * (input.maxDensity || 30);
        if (input.maxBiomass > maxByDensity) {
          this.logger.warn(
            `maxBiomass (${input.maxBiomass}kg) exceeds density limit (${maxByDensity.toFixed(2)}kg at ${input.maxDensity || 30}kg/m³)`,
          );
        }

        const saved = await this.batchMutations.commitTankTransition(mutationSession, {
          intent: 'tank_create',
          aggregate: tank,
        });
        await this.farmStockProjection.refreshContainers(queryRunner.manager, tenantId, [saved.id]);

        await this.auditLogService.logWithManager(queryRunner.manager, {
          tenantId,
          entityType: 'Tank',
          entityId: saved.id,
          action: AuditAction.CREATE,
          userId,
          changes: { after: tankAuditSnapshot(saved) },
          metadata: { source: 'SITES_SETUP_TANK' },
          entityVersion: saved.version,
          summary: `Created tank ${saved.code}`,
        });

        const event: TankCreatedEvent = {
          ...createBaseEvent<TankCreatedEvent>('TankCreated', tenantId, {
            aggregateId: saved.id,
            aggregateType: 'Tank',
            userId,
          }),
          tankId: saved.id,
          departmentId: saved.departmentId,
          systemId: saved.systemId,
          name: saved.name,
          code: saved.code,
          tankType: saved.tankType,
          status: saved.status,
          volume: Number(saved.volume),
          maxBiomass: Number(saved.maxBiomass),
        };
        await this.outboxPublisher.enqueue(event, queryRunner.manager, {
          aggregateId: saved.id,
        });

        this.logger.log(`Tank created: ${saved.id} - ${saved.code} (${saved.volume.toFixed(2)}m³)`);

        return saved;
      },
    );
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
          throw new BadRequestException(`Length is required for ${tankType} tanks and must be > 0`);
        }
        if (!input.width || input.width <= 0) {
          throw new BadRequestException(`Width is required for ${tankType} tanks and must be > 0`);
        }
        break;

      case TankType.OTHER: {
        // For OTHER type, at least one dimension set should be provided
        const hasCircular = input.diameter && input.diameter > 0;
        const hasRectangular = input.length && input.length > 0 && input.width && input.width > 0;
        const hasManualVolume =
          'volume' in input && Number((input as { volume?: number }).volume) > 0;

        if (!hasCircular && !hasRectangular && !hasManualVolume) {
          throw new BadRequestException(
            'For OTHER tank type, provide either diameter, (length and width), or manual volume',
          );
        }
        break;
      }
    }
  }
}
