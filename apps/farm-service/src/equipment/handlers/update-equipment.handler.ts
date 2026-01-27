/**
 * Update Equipment Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
import { ConflictException, NotFoundException, Logger, BadRequestException, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { UpdateEquipmentCommand } from '../commands/update-equipment.command';
import { Equipment } from '../entities/equipment.entity';
import { EquipmentSystem } from '../entities/equipment-system.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';

@CommandHandler(UpdateEquipmentCommand)
export class UpdateEquipmentHandler implements ICommandHandler<UpdateEquipmentCommand> {
  private readonly logger = new Logger(UpdateEquipmentHandler.name);

  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(EquipmentSystem)
    private readonly equipmentSystemRepository: Repository<EquipmentSystem>,
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: UpdateEquipmentCommand): Promise<Equipment> {
    const { equipmentId, input, tenantId, userId } = command;

    this.logger.log(`Updating equipment ${equipmentId} for tenant ${tenantId}`);

    // Find existing equipment with its systems
    const equipment = await this.equipmentRepository.findOne({
      where: { id: equipmentId, tenantId },
      relations: ['equipmentSystems'],
    });

    if (!equipment) {
      throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
    }

    // Validate systemIds change (many-to-many relationship)
    const hasSystemIds = Object.prototype.hasOwnProperty.call(input, 'systemIds');
    let newEquipmentSystems: EquipmentSystem[] | null = null;

    if (hasSystemIds) {
      if (!input.systemIds || input.systemIds.length === 0) {
        throw new BadRequestException('At least one system must be specified');
      }

      // Verify all systems exist and belong to tenant
      const systems = await this.systemRepository.find({
        where: { id: In(input.systemIds), tenantId },
      });

      if (systems.length !== input.systemIds.length) {
        const foundIds = systems.map(s => s.id);
        const missingIds = input.systemIds.filter(id => !foundIds.includes(id));
        throw new NotFoundException(`Systems not found: ${missingIds.join(', ')}`);
      }

      // Get department for validation
      const departmentId = equipment.departmentId;
      let department: Department | null = null;
      if (departmentId) {
        department = await this.departmentRepository.findOne({
          where: { id: departmentId, tenantId },
        });
      }

      // Validate all systems
      for (const system of systems) {
        if (system.isDeleted) {
          throw new BadRequestException(`System with ID "${system.id}" is deleted`);
        }
        // Systems can be from the same site but different departments (shared equipment like generators)
        if (department && system.siteId !== department.siteId) {
          throw new BadRequestException(
            `System "${system.name}" (${system.id}) does not belong to the same site as Department "${department.name}"`
          );
        }
      }

      // Prepare new equipment-system relationships
      newEquipmentSystems = input.systemIds.map((systemId, index) =>
        this.equipmentSystemRepository.create({
          tenantId,
          equipmentId,
          systemId,
          isPrimary: index === 0,
          criticalityLevel: 3,
          createdBy: userId,
        })
      );
    }

    // Validate supplierId change (if provided)
    const hasSupplierId = Object.prototype.hasOwnProperty.call(input, 'supplierId');
    if (hasSupplierId && input.supplierId) {
      const supplier = await this.supplierRepository.findOne({
        where: { id: input.supplierId, tenantId },
      });
      if (!supplier) {
        throw new NotFoundException(`Supplier with ID "${input.supplierId}" not found`);
      }
      if (supplier.isDeleted) {
        throw new BadRequestException(`Supplier with ID "${input.supplierId}" is deleted`);
      }
    }

    // Handle parentEquipmentId changes
    const hasParentEquipmentId = Object.prototype.hasOwnProperty.call(input, 'parentEquipmentId');
    const oldParentEquipmentId = equipment.parentEquipmentId;
    let newParentEquipment: Equipment | null = null;

    if (hasParentEquipmentId) {
      // Prevent circular reference - equipment cannot be its own parent
      if (input.parentEquipmentId === equipmentId) {
        throw new BadRequestException('Equipment cannot be its own parent');
      }

      // If setting a new parent, validate it exists
      if (input.parentEquipmentId) {
        newParentEquipment = await this.equipmentRepository.findOne({
          where: { id: input.parentEquipmentId, tenantId },
        });
        if (!newParentEquipment) {
          throw new NotFoundException(`Parent equipment with ID "${input.parentEquipmentId}" not found`);
        }
        // Prevent circular reference - new parent cannot be a child of this equipment
        if (newParentEquipment.parentEquipmentId === equipmentId) {
          throw new BadRequestException('Cannot set parent: would create circular reference');
        }
      }
    }

    // Check for duplicate code if changing
    if (input.code) {
      const normalizedCode = input.code.toUpperCase();
      if (normalizedCode !== equipment.code) {
        const existingByCode = await this.equipmentRepository.findOne({
          where: { tenantId, code: normalizedCode, id: Not(equipmentId) },
        });
        if (existingByCode) {
          throw new ConflictException(`Equipment with code "${normalizedCode}" already exists`);
        }
      }
    }

    // Check for duplicate serial number if changing
    if (input.serialNumber && input.serialNumber !== equipment.serialNumber) {
      const existingBySerial = await this.equipmentRepository.findOne({
        where: { tenantId, serialNumber: input.serialNumber, id: Not(equipmentId) },
      });
      if (existingBySerial) {
        throw new ConflictException(`Equipment with serial number "${input.serialNumber}" already exists`);
      }
    }

    // Remove systemIds from input (handled via junction table)
    const { systemIds, ...equipmentInput } = input;

    // Update fields
    Object.assign(equipment, {
      ...equipmentInput,
      code: equipmentInput.code ? equipmentInput.code.toUpperCase() : equipment.code,
      updatedBy: userId,
    });

    const updatedEquipment = await this.equipmentRepository.save(equipment);

    // Update subEquipmentCount for parent changes
    if (hasParentEquipmentId && oldParentEquipmentId !== input.parentEquipmentId) {
      // Decrement old parent's count
      if (oldParentEquipmentId) {
        await this.equipmentRepository.decrement(
          { id: oldParentEquipmentId },
          'subEquipmentCount',
          1
        );
        this.logger.log(`Decremented subEquipmentCount for old parent equipment ${oldParentEquipmentId}`);
      }

      // Increment new parent's count
      if (input.parentEquipmentId) {
        await this.equipmentRepository.increment(
          { id: input.parentEquipmentId },
          'subEquipmentCount',
          1
        );
        this.logger.log(`Incremented subEquipmentCount for new parent equipment ${input.parentEquipmentId}`);
      }
    }

    // Update equipment-system relationships if systemIds was provided
    if (newEquipmentSystems) {
      // Remove existing relationships
      await this.equipmentSystemRepository.delete({ equipmentId });

      // Create new relationships
      await this.equipmentSystemRepository.save(newEquipmentSystems);

      // Attach to response
      updatedEquipment.equipmentSystems = newEquipmentSystems;

      this.logger.log(`Equipment ${equipmentId} systems updated: ${input.systemIds?.join(', ')}`);
    }

    this.logger.log(`Equipment ${equipmentId} updated successfully`);

    // Domain event: EquipmentUpdated
    // await this.eventBus?.publish(new EquipmentUpdatedEvent({
    //   tenantId,
    //   equipmentId: updatedEquipment.id,
    //   name: updatedEquipment.name,
    //   code: updatedEquipment.code,
    //   updatedBy: userId,
    // }));

    return updatedEquipment;
  }
}
