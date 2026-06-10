/**
 * Create SubEquipment Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, ConflictException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { SubEquipmentCreatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, DeepPartial, FindManyOptions, FindOptionsWhere, UpdateResult } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Tank } from '../../tank/entities/tank.entity';
import { CreateSubEquipmentCommand } from '../commands/create-sub-equipment.command';
import { Equipment, EquipmentStatus } from '../entities/equipment.entity';
import { SubEquipmentType } from '../entities/sub-equipment-type.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';

import { subEquipmentAuditSnapshot } from './equipment-audit.util';

type CountUpdateRepository<T> = {
  count: (options?: FindManyOptions<T>) => Promise<number>;
  update: (criteria: FindOptionsWhere<T>, partialEntity: DeepPartial<T>) => Promise<UpdateResult>;
};

@CommandHandler(CreateSubEquipmentCommand)
export class CreateSubEquipmentHandler implements ICommandHandler<CreateSubEquipmentCommand, SubEquipment> {
  private readonly logger = new Logger(CreateSubEquipmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: CreateSubEquipmentCommand): Promise<SubEquipment> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating sub-equipment "${input.name}" for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const subEquipmentRepository = tenantManagerRepo(queryRunner.manager, SubEquipment, tenantId);
      const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);
      const tankRepository = tenantManagerRepo(queryRunner.manager, Tank, tenantId);

      const parentEquipment = await equipmentRepository.findOne({
        where: { id: input.parentEquipmentId, isDeleted: false, tenantId },
        relations: ['equipmentType'],
      });
      if (!parentEquipment) {
        const tankParent = await tankRepository.findOne({ where: { id: input.parentEquipmentId, tenantId } });
        if (tankParent) {
          throw new BadRequestException(
            'Sub-equipment parent cannot be a canonical tank-like row until ownerType support is implemented',
          );
        }
        throw new NotFoundException(`Parent equipment with ID "${input.parentEquipmentId}" not found`);
      }
      if (!parentEquipment.isActive) {
        throw new BadRequestException(`Parent equipment with ID "${input.parentEquipmentId}" is inactive`);
      }

      const subEquipmentType = await queryRunner.manager.findOne(SubEquipmentType, {
        where: { id: input.subEquipmentTypeId },
      });
      if (!subEquipmentType) {
        throw new NotFoundException(`Sub-equipment type with ID "${input.subEquipmentTypeId}" not found`);
      }

      if (subEquipmentType.compatibleEquipmentTypes?.length) {
        const parentTypeCode = parentEquipment.equipmentType?.code;
        if (parentTypeCode && !subEquipmentType.compatibleEquipmentTypes.includes(parentTypeCode)) {
          throw new BadRequestException(
            `Sub-equipment type "${subEquipmentType.name}" is not compatible with parent equipment type "${parentEquipment.equipmentType?.name}"`,
          );
        }
      }

      if (input.specifications && subEquipmentType.specificationSchema) {
        this.validateSpecifications(input.specifications, subEquipmentType.specificationSchema);
      }

      const normalizedCode = input.code.toUpperCase();
      const existingByCode = await subEquipmentRepository.findOne({
        where: { parentEquipmentId: input.parentEquipmentId, code: normalizedCode, tenantId },
      });
      if (existingByCode) {
        throw new ConflictException(
          `Sub-equipment with code "${normalizedCode}" already exists for this parent equipment`,
        );
      }

      if (input.serialNumber) {
        const existingBySerial = await subEquipmentRepository.findOne({
          where: { serialNumber: input.serialNumber, tenantId },
        });
        if (existingBySerial) {
          throw new ConflictException(`Sub-equipment with serial number "${input.serialNumber}" already exists`);
        }
      }

      const subEquipment = subEquipmentRepository.create({
        parentEquipmentId: input.parentEquipmentId,
        subEquipmentTypeId: input.subEquipmentTypeId,
        name: input.name,
        code: normalizedCode,
        description: input.description,
        manufacturer: input.manufacturer,
        model: input.model,
        serialNumber: input.serialNumber,
        status: input.status ?? EquipmentStatus.OPERATIONAL,
        specifications: input.specifications,
        installationDate: input.installationDate,
        notes: input.notes,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const saved = await subEquipmentRepository.save(subEquipment);
      await this.recomputeParentSubEquipmentCount(equipmentRepository, subEquipmentRepository, input.parentEquipmentId);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'SubEquipment',
        entityId: saved.id,
        action: AuditAction.CREATE,
        userId,
        changes: { after: subEquipmentAuditSnapshot(saved) },
        metadata: { source: 'SITES_SETUP_SUB_EQUIPMENT' },
        entityVersion: saved.version,
        summary: `Created sub-equipment ${saved.code}`,
      });

      const event: SubEquipmentCreatedEvent = {
        ...createBaseEvent<SubEquipmentCreatedEvent>('SubEquipmentCreated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'SubEquipment',
          userId,
        }),
        subEquipmentId: saved.id,
        parentEquipmentId: saved.parentEquipmentId,
        name: saved.name,
        code: saved.code,
        status: saved.status,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, { aggregateId: saved.id });

      const reloaded = await subEquipmentRepository.findOne({
        where: { id: saved.id, tenantId },
        relations: ['subEquipmentType', 'parentEquipment'],
      });
      if (!reloaded) {
        throw new InternalServerErrorException(
          `Sub-equipment ${saved.id} vanished between save and reload`,
        );
      }
      return reloaded;
    });
  }

  private async recomputeParentSubEquipmentCount(
    equipmentRepository: CountUpdateRepository<Equipment>,
    subEquipmentRepository: CountUpdateRepository<SubEquipment>,
    parentEquipmentId: string,
  ): Promise<void> {
    const [childEquipmentCount, subEquipmentCount] = await Promise.all([
      equipmentRepository.count({ where: { parentEquipmentId, isDeleted: false } }),
      subEquipmentRepository.count({ where: { parentEquipmentId, isActive: true } }),
    ]);
    await equipmentRepository.update(
      { id: parentEquipmentId },
      { subEquipmentCount: childEquipmentCount + subEquipmentCount },
    );
  }

  private validateSpecifications(
    specs: Record<string, unknown>,
    schema: { fields?: Array<{ name: string; required?: boolean; type: string }> },
  ): void {
    if (!schema.fields) return;
    for (const field of schema.fields) {
      if (field.required && (specs[field.name] === undefined || specs[field.name] === null)) {
        throw new BadRequestException(`Required specification field "${field.name}" is missing`);
      }
    }
  }
}
