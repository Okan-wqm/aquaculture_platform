/**
 * Create Equipment Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { EquipmentCreatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, FindOneOptions, In } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Department } from '../../department/entities/department.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { System } from '../../system/entities/system.entity';
import { CreateEquipmentCommand } from '../commands/create-equipment.command';
import { EquipmentSystem } from '../entities/equipment-system.entity';
import { EquipmentType } from '../entities/equipment-type.entity';
import { Equipment, EquipmentStatus } from '../entities/equipment.entity';
import { TankEquipmentAdapterService } from '../services/tank-equipment-adapter.service';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';

import { equipmentAuditSnapshot } from './equipment-audit.util';

type ScopedReadRepository<T> = {
  findOne: (options: FindOneOptions<T>) => Promise<T | null>;
};

@CommandHandler(CreateEquipmentCommand)
export class CreateEquipmentHandler implements ICommandHandler<CreateEquipmentCommand, Equipment> {
  private readonly logger = new Logger(CreateEquipmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly tankEquipmentAdapter: TankEquipmentAdapterService,
    private readonly financeSettings: FinanceSettingsService,
  ) {}

  async execute(command: CreateEquipmentCommand): Promise<Equipment> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating equipment "${input.name}" for tenant ${tenantId}`);

    const equipmentType = await this.dataSource.manager.findOne(EquipmentType, {
      where: { id: input.equipmentTypeId },
    });
    if (!equipmentType) {
      throw new NotFoundException(`Equipment type with ID "${input.equipmentTypeId}" not found`);
    }

    if (input.specifications && equipmentType.specificationSchema) {
      this.validateSpecifications(input.specifications, equipmentType.specificationSchema);
    }

    if (this.tankEquipmentAdapter.isTankLike(equipmentType)) {
      return this.tankEquipmentAdapter.createFromEquipment(tenantId, userId, input, equipmentType);
    }

    // Currency SSoT (FARM-HIGH-151): equipment.purchasePrice books under
    // the tenant default currency from finance_settings, never a
    // hardcoded literal.
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

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

      const department = await departmentRepository.findOne({
        where: { id: input.departmentId, tenantId },
      });
      if (!department) {
        throw new NotFoundException(`Department with ID "${input.departmentId}" not found`);
      }
      if (department.isDeleted) {
        throw new BadRequestException(`Department with ID "${input.departmentId}" is deleted`);
      }

      if (!input.systemIds || input.systemIds.length === 0) {
        throw new BadRequestException('At least one system must be specified');
      }
      const systems = await systemRepository.find({ where: { id: In(input.systemIds), tenantId } });
      if (systems.length !== input.systemIds.length) {
        const foundIds = systems.map((system) => system.id);
        const missingIds = input.systemIds.filter((id) => !foundIds.includes(id));
        throw new NotFoundException(`Systems not found: ${missingIds.join(', ')}`);
      }
      for (const system of systems) {
        if (system.isDeleted) {
          throw new BadRequestException(`System with ID "${system.id}" is deleted`);
        }
        if (system.siteId !== department.siteId) {
          throw new BadRequestException(
            `System "${system.name}" (${system.id}) does not belong to the same site as Department "${department.name}"`,
          );
        }
      }

      if (input.supplierId) {
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

      if (input.parentEquipmentId) {
        await this.assertValidParentEquipment(
          equipmentRepository,
          departmentRepository,
          input.parentEquipmentId,
          input.departmentId,
          department.siteId ?? undefined,
          tenantId,
        );
      }

      const normalizedCode = input.code.toUpperCase();
      const existingByCode = await equipmentRepository.findOne({
        where: { code: normalizedCode, tenantId },
      });
      if (existingByCode) {
        throw new ConflictException(`Equipment with code "${normalizedCode}" already exists`);
      }

      if (input.serialNumber) {
        const existingBySerial = await equipmentRepository.findOne({
          where: { serialNumber: input.serialNumber, tenantId },
        });
        if (existingBySerial) {
          throw new ConflictException(
            `Equipment with serial number "${input.serialNumber}" already exists`,
          );
        }
      }

      const equipment = equipmentRepository.create({
        departmentId: input.departmentId,
        parentEquipmentId: input.parentEquipmentId,
        equipmentTypeId: input.equipmentTypeId,
        name: input.name,
        code: normalizedCode,
        description: input.description,
        manufacturer: input.manufacturer,
        model: input.model,
        serialNumber: input.serialNumber,
        purchaseDate: input.purchaseDate,
        installationDate: input.installationDate,
        warrantyEndDate: input.warrantyEndDate,
        purchasePrice: input.purchasePrice,
        currency: input.currency ?? defaultCurrency,
        status: input.status ?? EquipmentStatus.OPERATIONAL,
        location: input.location,
        specifications: input.specifications,
        maintenanceSchedule: input.maintenanceSchedule,
        supplierId: input.supplierId,
        subEquipmentCount: 0,
        operatingHours: input.operatingHours,
        notes: input.notes,
        isActive: true,
        isVisibleInSensor: input.isVisibleInSensor ?? false,
        temperatureSensorId: input.temperatureSensorId,
        isTank: false,
        createdBy: userId,
        updatedBy: userId,
      });

      const persistedEquipment = await equipmentRepository.save(equipment);
      const equipmentSystems = input.systemIds.map((systemId, index) =>
        equipmentSystemRepository.create({
          equipmentId: persistedEquipment.id,
          systemId,
          isPrimary: index === 0,
          criticalityLevel: 3,
          createdBy: userId,
        }),
      );
      const persistedEquipmentSystems = await equipmentSystemRepository.saveMany(equipmentSystems);

      if (input.parentEquipmentId) {
        const childCount = await equipmentRepository.count({
          where: { parentEquipmentId: input.parentEquipmentId, isDeleted: false },
        });
        await equipmentRepository.update(
          { id: input.parentEquipmentId },
          { subEquipmentCount: childCount },
        );
      }

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Equipment',
        entityId: persistedEquipment.id,
        action: AuditAction.CREATE,
        userId,
        changes: { after: equipmentAuditSnapshot(persistedEquipment) },
        metadata: { source: 'SITES_SETUP_EQUIPMENT' },
        entityVersion: persistedEquipment.version,
        summary: `Created equipment ${persistedEquipment.code}`,
      });

      const event: EquipmentCreatedEvent = {
        ...createBaseEvent<EquipmentCreatedEvent>('EquipmentCreated', tenantId, {
          aggregateId: persistedEquipment.id,
          aggregateType: 'Equipment',
          userId,
        }),
        equipmentId: persistedEquipment.id,
        siteId: department.siteId ?? undefined,
        systemId: systems[0]?.id,
        departmentId: persistedEquipment.departmentId,
        name: persistedEquipment.name,
        code: persistedEquipment.code,
        typeId: persistedEquipment.equipmentTypeId,
        category: equipmentType.category,
        status: persistedEquipment.status,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: persistedEquipment.id,
      });

      persistedEquipment.equipmentSystems = persistedEquipmentSystems;
      this.logger.log(
        `Equipment "${persistedEquipment.name}" created with ID ${persistedEquipment.id}`,
      );
      return persistedEquipment;
    });
  }

  private async assertValidParentEquipment(
    equipmentRepository: ScopedReadRepository<Equipment>,
    departmentRepository: ScopedReadRepository<Department>,
    parentEquipmentId: string,
    childDepartmentId: string,
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
    if (parent.departmentId && parent.departmentId !== childDepartmentId && childSiteId) {
      const parentDepartment = await departmentRepository.findOne({
        where: { id: parent.departmentId, tenantId },
      });
      if (parentDepartment?.siteId !== childSiteId) {
        throw new BadRequestException('Parent equipment must belong to the same site');
      }
    }
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
