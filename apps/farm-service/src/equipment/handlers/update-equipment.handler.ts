/**
 * Update Equipment Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { EquipmentUpdatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import {
  DataSource,
  DeepPartial,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  In,
  UpdateResult,
} from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Department } from '../../department/entities/department.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { System } from '../../system/entities/system.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { UpdateEquipmentCommand } from '../commands/update-equipment.command';
import { EquipmentSystem } from '../entities/equipment-system.entity';
import { EquipmentCategory, EquipmentType } from '../entities/equipment-type.entity';
import { Equipment } from '../entities/equipment.entity';
import { TankEquipmentAdapterService } from '../services/tank-equipment-adapter.service';

import { equipmentAuditSnapshot } from './equipment-audit.util';

type ScopedEquipmentRepository = {
  findOne: (options: FindOneOptions<Equipment>) => Promise<Equipment | null>;
  count: (options?: FindManyOptions<Equipment>) => Promise<number>;
  update: (
    criteria: FindOptionsWhere<Equipment>,
    partialEntity: DeepPartial<Equipment>,
  ) => Promise<UpdateResult>;
};

@CommandHandler(UpdateEquipmentCommand)
export class UpdateEquipmentHandler implements ICommandHandler<UpdateEquipmentCommand, Equipment> {
  private readonly logger = new Logger(UpdateEquipmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly tankEquipmentAdapter: TankEquipmentAdapterService,
  ) {}

  async execute(command: UpdateEquipmentCommand): Promise<Equipment> {
    const { equipmentId, input, tenantId, userId } = command;

    this.logger.log(`Updating equipment ${equipmentId} for tenant ${tenantId}`);

    const tankRepository = tenantManagerRepo(this.dataSource.manager, Tank, tenantId);
    const tank = await tankRepository.findOne({
      where: { id: equipmentId, tenantId },
    });
    if (tank) {
      return this.tankEquipmentAdapter.updateFromEquipment(tank, tenantId, userId, input);
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);
      const equipmentSystemRepository = tenantManagerRepo(
        queryRunner.manager,
        EquipmentSystem,
        tenantId,
      );
      const departmentRepository = tenantManagerRepo(queryRunner.manager, Department, tenantId);
      const systemRepository = tenantManagerRepo(queryRunner.manager, System, tenantId);
      const supplierRepository = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);

      const equipment = await equipmentRepository.findOne({
        where: { id: equipmentId, isDeleted: false, tenantId },
        relations: ['equipmentSystems'],
      });
      if (!equipment) {
        throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
      }
      const before = equipmentAuditSnapshot(equipment);

      const currentEquipmentType = await queryRunner.manager.findOne(EquipmentType, {
        where: { id: equipment.equipmentTypeId },
      });
      const nextEquipmentType = input.equipmentTypeId
        ? await queryRunner.manager.findOne(EquipmentType, { where: { id: input.equipmentTypeId } })
        : currentEquipmentType;
      if (input.equipmentTypeId && !nextEquipmentType) {
        throw new NotFoundException(`Equipment type with ID "${input.equipmentTypeId}" not found`);
      }
      if (nextEquipmentType && this.isTankLike(nextEquipmentType.category)) {
        throw new BadRequestException(
          'Cannot convert non-tank equipment into tank-like equipment through update; create a canonical tank-like row instead.',
        );
      }

      const hasDepartmentId = Object.prototype.hasOwnProperty.call(input, 'departmentId');
      const departmentId = hasDepartmentId ? input.departmentId : equipment.departmentId;
      let department: Department | null = null;
      if (departmentId) {
        department = await departmentRepository.findOne({ where: { id: departmentId, tenantId } });
        if (!department) {
          throw new NotFoundException(`Department with ID "${departmentId}" not found`);
        }
        if (department.isDeleted) {
          throw new BadRequestException(`Department with ID "${departmentId}" is deleted`);
        }
      }

      const hasSystemIds = Object.prototype.hasOwnProperty.call(input, 'systemIds');
      let newEquipmentSystems: EquipmentSystem[] | null = null;
      if (hasSystemIds) {
        if (!input.systemIds || input.systemIds.length === 0) {
          throw new BadRequestException('At least one system must be specified');
        }
        const systems = await systemRepository.find({
          where: { id: In(input.systemIds), tenantId },
        });
        if (systems.length !== input.systemIds.length) {
          const foundIds = systems.map((system) => system.id);
          const missingIds = input.systemIds.filter((id) => !foundIds.includes(id));
          throw new NotFoundException(`Systems not found: ${missingIds.join(', ')}`);
        }
        for (const system of systems) {
          if (system.isDeleted) {
            throw new BadRequestException(`System with ID "${system.id}" is deleted`);
          }
          if (department && system.siteId !== department.siteId) {
            throw new BadRequestException(
              `System "${system.name}" (${system.id}) does not belong to the same site as Department "${department.name}"`,
            );
          }
        }
        newEquipmentSystems = input.systemIds.map((systemId, index) =>
          equipmentSystemRepository.create({
            equipmentId,
            systemId,
            isPrimary: index === 0,
            criticalityLevel: 3,
            createdBy: userId,
          }),
        );
      }

      if (Object.prototype.hasOwnProperty.call(input, 'supplierId') && input.supplierId) {
        const supplier = await supplierRepository.findOne({
          where: { id: input.supplierId, tenantId },
        });
        if (!supplier) {
          throw new NotFoundException(`Supplier with ID "${input.supplierId}" not found`);
        }
        if (supplier.isDeleted) {
          throw new BadRequestException(`Supplier with ID "${input.supplierId}" is deleted`);
        }
      }

      const hasParentEquipmentId = Object.prototype.hasOwnProperty.call(input, 'parentEquipmentId');
      const oldParentEquipmentId = equipment.parentEquipmentId;
      if (hasParentEquipmentId) {
        if (input.parentEquipmentId === equipmentId) {
          throw new BadRequestException('Equipment cannot be its own parent');
        }
        if (input.parentEquipmentId) {
          await this.assertValidParentEquipment(
            equipmentRepository,
            departmentRepository,
            equipmentId,
            input.parentEquipmentId,
            departmentId,
            department?.siteId ?? undefined,
            tenantId,
          );
        }
      }

      if (input.code) {
        const normalizedCode = input.code.toUpperCase();
        if (normalizedCode !== equipment.code) {
          const duplicate = await equipmentRepository.findOne({
            where: { code: normalizedCode, tenantId },
          });
          if (duplicate && duplicate.id !== equipmentId) {
            throw new ConflictException(`Equipment with code "${normalizedCode}" already exists`);
          }
        }
      }

      if (input.serialNumber && input.serialNumber !== equipment.serialNumber) {
        const duplicate = await equipmentRepository.findOne({
          where: { serialNumber: input.serialNumber, tenantId },
        });
        if (duplicate && duplicate.id !== equipmentId) {
          throw new ConflictException(
            `Equipment with serial number "${input.serialNumber}" already exists`,
          );
        }
      }

      const { systemIds: _systemIds, id: _id, ...equipmentInput } = input;
      Object.assign(equipment, {
        ...equipmentInput,
        code: equipmentInput.code ? equipmentInput.code.toUpperCase() : equipment.code,
        updatedBy: userId,
      });

      const persistedEquipment = await equipmentRepository.save(equipment);

      if (hasParentEquipmentId && oldParentEquipmentId !== input.parentEquipmentId) {
        await this.recomputeSubEquipmentCount(equipmentRepository, oldParentEquipmentId);
        await this.recomputeSubEquipmentCount(equipmentRepository, input.parentEquipmentId);
      }

      if (newEquipmentSystems) {
        await equipmentSystemRepository.delete({ equipmentId });
        persistedEquipment.equipmentSystems =
          await equipmentSystemRepository.saveMany(newEquipmentSystems);
      }

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Equipment',
        entityId: persistedEquipment.id,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before,
          after: equipmentAuditSnapshot(persistedEquipment),
        },
        metadata: { source: 'SITES_SETUP_EQUIPMENT' },
        entityVersion: persistedEquipment.version,
        summary: `Updated equipment ${persistedEquipment.code}`,
      });

      const event: EquipmentUpdatedEvent = {
        ...createBaseEvent<EquipmentUpdatedEvent>('EquipmentUpdated', tenantId, {
          aggregateId: persistedEquipment.id,
          aggregateType: 'Equipment',
          userId,
        }),
        equipmentId: persistedEquipment.id,
        siteId: department?.siteId ?? undefined,
        name: persistedEquipment.name,
        status: persistedEquipment.status,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: persistedEquipment.id,
      });

      this.logger.log(`Equipment ${equipmentId} updated successfully`);
      return persistedEquipment;
    });
  }

  private isTankLike(category: EquipmentCategory): boolean {
    return [EquipmentCategory.TANK, EquipmentCategory.POND, EquipmentCategory.CAGE].includes(
      category,
    );
  }

  private async assertValidParentEquipment(
    equipmentRepository: ScopedEquipmentRepository,
    departmentRepository: {
      findOne: (options: FindOneOptions<Department>) => Promise<Department | null>;
    },
    equipmentId: string,
    parentEquipmentId: string,
    childDepartmentId?: string,
    childSiteId?: string,
    tenantId?: string,
  ): Promise<void> {
    const parent = await equipmentRepository.findOne({
      where: { id: parentEquipmentId, tenantId },
    });
    if (!parent) {
      throw new NotFoundException(`Parent equipment with ID "${parentEquipmentId}" not found`);
    }
    if (!parent.isActive || parent.isDeleted) {
      throw new BadRequestException(
        `Parent equipment with ID "${parentEquipmentId}" is inactive or deleted`,
      );
    }
    if (
      parent.departmentId &&
      childDepartmentId &&
      parent.departmentId !== childDepartmentId &&
      childSiteId
    ) {
      const parentDepartment = await departmentRepository.findOne({
        where: { id: parent.departmentId, tenantId },
      });
      if (parentDepartment?.siteId !== childSiteId) {
        throw new BadRequestException('Parent equipment must belong to the same site');
      }
    }

    let cursor = parent.parentEquipmentId;
    let depth = 0;
    while (cursor && depth < 20) {
      if (cursor === equipmentId) {
        throw new BadRequestException('Cannot set parent: would create circular reference');
      }
      const ancestor = await equipmentRepository.findOne({ where: { id: cursor, tenantId } });
      cursor = ancestor?.parentEquipmentId;
      depth += 1;
    }
    if (depth >= 20) {
      throw new BadRequestException('Equipment hierarchy depth limit exceeded');
    }
  }

  private async recomputeSubEquipmentCount(
    equipmentRepository: ScopedEquipmentRepository,
    equipmentId?: string,
  ): Promise<void> {
    if (!equipmentId) return;
    const childCount = await equipmentRepository.count({
      where: { parentEquipmentId: equipmentId, isDeleted: false },
    });
    await equipmentRepository.update({ id: equipmentId }, { subEquipmentCount: childCount });
  }
}
