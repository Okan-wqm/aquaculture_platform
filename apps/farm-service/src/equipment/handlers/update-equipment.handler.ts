/**
 * Update Equipment Command Handler
 *
 * Handles updates for both Equipment and Tank entities.
 * When an equipment ID is found in the tanks table, the update is delegated
 * to update the Tank entity instead.
 */
import { randomUUID } from 'crypto';

import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
import { ConflictException, NotFoundException, Logger, BadRequestException, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { EquipmentUpdatedEvent } from '@platform/event-contracts';
import { UpdateEquipmentCommand } from '../commands/update-equipment.command';
import { Equipment, EquipmentStatus } from '../entities/equipment.entity';
import { EquipmentSystem } from '../entities/equipment-system.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { Tank, TankType, TankMaterial, TankStatus, WaterType } from '../../tank/entities/tank.entity';

@CommandHandler(UpdateEquipmentCommand)
export class UpdateEquipmentHandler implements ICommandHandler<UpdateEquipmentCommand, Equipment> {
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
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: UpdateEquipmentCommand): Promise<Equipment> {
    const { equipmentId, input, tenantId, userId } = command;

    this.logger.log(`Updating equipment ${equipmentId} for tenant ${tenantId}`);

    // Check if this ID exists in the tanks table first
    const tank = await this.tankRepository.findOne({
      where: { id: equipmentId, tenantId },
    });

    if (tank) {
      // This is a tank - delegate to tank update logic
      this.logger.log(`Equipment ${equipmentId} is a tank, updating Tank entity`);
      return this.updateTank(tank, input, tenantId, userId);
    }

    // Find existing equipment with its systems
    const equipment = await this.equipmentRepository.findOne({
      where: { id: equipmentId, tenantId },
      relations: ['equipmentSystems'],
    });

    if (!equipment) {
      throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
    }

    // Validate departmentId change if provided
    const hasDepartmentId = Object.prototype.hasOwnProperty.call(input, 'departmentId');
    if (hasDepartmentId && input.departmentId) {
      const newDept = await this.departmentRepository.findOne({
        where: { id: input.departmentId, tenantId },
      });
      if (!newDept) {
        throw new NotFoundException(`Department with ID "${input.departmentId}" not found`);
      }
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

      // Get department for validation (use new departmentId if provided, otherwise current)
      const departmentId = (hasDepartmentId && input.departmentId) ? input.departmentId : equipment.departmentId;
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

    // Publish domain event: EquipmentUpdated
    if (this.eventBus) {
      try {
        const event: EquipmentUpdatedEvent = {
          eventId: randomUUID(),
          eventType: 'EquipmentUpdated',
          tenantId,
          timestamp: new Date(),
          equipmentId: updatedEquipment.id,
          name: updatedEquipment.name,
          status: updatedEquipment.status,
          version: 1,
        };
        await this.eventBus.publish(event);
        this.logger.debug(`Published EquipmentUpdatedEvent for equipment ${updatedEquipment.id}`);
      } catch (eventError) {
        this.logger.warn(`Failed to publish EquipmentUpdatedEvent: ${(eventError as Error).message}`);
      }
    }

    return updatedEquipment;
  }

  /**
   * Update Tank entity when accessed via equipment resolver
   * Maps UpdateEquipmentInput fields to Tank fields
   */
  private async updateTank(
    tank: Tank,
    input: UpdateEquipmentCommand['input'],
    tenantId: string,
    userId: string,
  ): Promise<Equipment> {
    // Cannot update dimensions if tank has active batches
    const specs = input.specifications as {
      tankType?: string;
      dimensions?: { diameter?: number; length?: number; width?: number; depth?: number };
      material?: string;
      waterType?: string;
      maxBiomass?: number;
      maxDensity?: number;
      waterDepth?: number;
      freeboard?: number;
      waterFlow?: Record<string, unknown>;
      aeration?: Record<string, unknown>;
      location?: Record<string, unknown>;
    } | undefined;

    const hasDimensionChanges = specs?.dimensions && (
      specs.dimensions.diameter !== undefined ||
      specs.dimensions.length !== undefined ||
      specs.dimensions.width !== undefined ||
      specs.dimensions.depth !== undefined
    );

    if (tank.currentBiomass > 0 && hasDimensionChanges) {
      throw new BadRequestException(
        'Cannot update dimensions while tank has active biomass. Please transfer or harvest first.',
      );
    }

    // Check for duplicate code if changing
    if (input.code) {
      const normalizedCode = input.code.toUpperCase();
      if (normalizedCode !== tank.code) {
        const existingByCode = await this.tankRepository.findOne({
          where: { tenantId, code: normalizedCode, id: Not(tank.id) },
        });
        if (existingByCode) {
          throw new ConflictException(`Tank with code "${normalizedCode}" already exists`);
        }
        tank.code = normalizedCode;
      }
    }

    // Handle systemIds for tank (single FK, not many-to-many)
    const hasSystemIds = Object.prototype.hasOwnProperty.call(input, 'systemIds');
    if (hasSystemIds && input.systemIds) {
      if (input.systemIds.length > 1) {
        throw new BadRequestException('Tank can only be associated with one system');
      }
      if (input.systemIds.length === 1) {
        const system = await this.systemRepository.findOne({
          where: { id: input.systemIds[0], tenantId },
        });
        if (!system) {
          throw new NotFoundException(`System with ID "${input.systemIds[0]}" not found`);
        }
        if (system.isDeleted) {
          throw new BadRequestException(`System with ID "${input.systemIds[0]}" is deleted`);
        }
        // Validate same site as department
        const deptId = input.departmentId ?? tank.departmentId;
        if (deptId) {
          const dept = await this.departmentRepository.findOne({ where: { id: deptId, tenantId } });
          if (dept && system.siteId !== dept.siteId) {
            throw new BadRequestException(
              `System "${system.name}" does not belong to the same site as the department`,
            );
          }
        }
        tank.systemId = system.id;
      } else {
        // Empty array: clear system association
        tank.systemId = undefined;
      }
    }

    // Handle departmentId change
    if (input.departmentId !== undefined && input.departmentId !== tank.departmentId) {
      const newDept = await this.departmentRepository.findOne({
        where: { id: input.departmentId, tenantId },
      });
      if (!newDept) {
        throw new NotFoundException(`Department with ID "${input.departmentId}" not found`);
      }
      tank.departmentId = input.departmentId;
    }

    // Map UpdateEquipmentInput fields to Tank fields
    if (input.name !== undefined) tank.name = input.name;
    if (input.description !== undefined) tank.description = input.description;
    if (input.notes !== undefined) tank.notes = input.notes;
    if (input.installationDate !== undefined) {
      tank.installationDate = input.installationDate;
    }
    if (input.isActive !== undefined) tank.isActive = input.isActive;

    // Map specifications to tank-specific fields
    if (specs) {
      // Tank type
      if (specs.tankType !== undefined) {
        const tankTypeValue = specs.tankType.toLowerCase();
        if (Object.values(TankType).includes(tankTypeValue as TankType)) {
          tank.tankType = tankTypeValue as TankType;
        }
      }

      // Material
      if (specs.material !== undefined) {
        const materialValue = specs.material.toLowerCase();
        if (Object.values(TankMaterial).includes(materialValue as TankMaterial)) {
          tank.material = materialValue as TankMaterial;
        }
      }

      // Water type
      if (specs.waterType !== undefined) {
        const waterTypeValue = specs.waterType.toLowerCase();
        if (Object.values(WaterType).includes(waterTypeValue as WaterType)) {
          tank.waterType = waterTypeValue as WaterType;
        }
      }

      // Dimensions
      if (specs.dimensions) {
        if (specs.dimensions.diameter !== undefined) tank.diameter = specs.dimensions.diameter;
        if (specs.dimensions.length !== undefined) tank.length = specs.dimensions.length;
        if (specs.dimensions.width !== undefined) tank.width = specs.dimensions.width;
        if (specs.dimensions.depth !== undefined) tank.depth = specs.dimensions.depth;
      }

      // Capacity settings
      if (specs.maxBiomass !== undefined) tank.maxBiomass = specs.maxBiomass;
      if (specs.maxDensity !== undefined) tank.maxDensity = specs.maxDensity;
      if (specs.waterDepth !== undefined) tank.waterDepth = specs.waterDepth;
      if (specs.freeboard !== undefined) tank.freeboard = specs.freeboard;

      // JSONB fields
      if (specs.waterFlow !== undefined) {
        tank.waterFlow = specs.waterFlow as unknown as Tank['waterFlow'];
      }
      if (specs.aeration !== undefined) {
        tank.aeration = specs.aeration as unknown as Tank['aeration'];
      }
      if (specs.location !== undefined) {
        tank.location = specs.location as unknown as Tank['location'];
      }
    }

    // Map equipment status to tank status if provided (complete mapping for all 12 values)
    if (input.status !== undefined) {
      const statusMapping: Record<string, TankStatus> = {
        'operational': TankStatus.ACTIVE,
        'active': TankStatus.ACTIVE,
        'preparing': TankStatus.PREPARING,
        'cleaning': TankStatus.CLEANING,
        'maintenance': TankStatus.MAINTENANCE,
        'repair': TankStatus.MAINTENANCE,
        'harvesting': TankStatus.HARVESTING,
        'fallow': TankStatus.FALLOW,
        'standby': TankStatus.FALLOW,
        'quarantine': TankStatus.QUARANTINE,
        'out_of_service': TankStatus.INACTIVE,
        'decommissioned': TankStatus.INACTIVE,
        'inactive': TankStatus.INACTIVE,
      };
      const mappedStatus = statusMapping[input.status.toLowerCase()];
      if (mappedStatus) {
        tank.status = mappedStatus;
        tank.statusChangedAt = new Date();
      }
    }

    // Handle location from equipment input
    if (input.location) {
      const equipmentLocation = input.location as {
        building?: string;
        floor?: string;
        room?: string;
        coordinates?: { x: number; y: number; z?: number };
        notes?: string;
      };
      tank.location = {
        ...tank.location,
        building: equipmentLocation.building ?? tank.location?.building,
        section: equipmentLocation.room ?? tank.location?.section,
        floor: equipmentLocation.floor ?? tank.location?.floor,
        coordinates: equipmentLocation.coordinates ?? tank.location?.coordinates,
        notes: equipmentLocation.notes ?? tank.location?.notes,
      };
    }

    tank.updatedBy = userId;

    // Only recalculate and validate volume if dimensions were actually changed
    if (hasDimensionChanges) {
      tank.calculateVolume();

      if (tank.volume <= 0) {
        throw new BadRequestException(
          'Invalid dimensions: calculated volume must be greater than 0',
        );
      }
    }

    // Save the tank
    const savedTank = await this.tankRepository.save(tank);

    this.logger.log(`Tank ${savedTank.id} updated successfully via equipment resolver`);

    // Convert Tank to Equipment response format
    return this.tankToEquipmentResponse(savedTank);
  }

  /**
   * Convert Tank entity to Equipment response format
   * This allows the equipment resolver to return a consistent response
   */
  private tankToEquipmentResponse(tank: Tank): Equipment {
    const equipment = new Equipment();
    equipment.id = tank.id;
    equipment.tenantId = tank.tenantId;
    equipment.departmentId = tank.departmentId;
    equipment.name = tank.name;
    equipment.code = tank.code;
    equipment.description = tank.description;
    equipment.isActive = tank.isActive;
    equipment.isTank = true;
    equipment.volume = Number(tank.volume);
    equipment.notes = tank.notes;
    equipment.createdAt = tank.createdAt;
    equipment.updatedAt = tank.updatedAt;
    equipment.createdBy = tank.createdBy;
    equipment.updatedBy = tank.updatedBy;

    // Map tank status to equipment status (1:1 mapping, consistent with list handler)
    const statusMapping: Record<TankStatus, EquipmentStatus> = {
      [TankStatus.ACTIVE]: EquipmentStatus.ACTIVE,
      [TankStatus.PREPARING]: EquipmentStatus.PREPARING,
      [TankStatus.CLEANING]: EquipmentStatus.CLEANING,
      [TankStatus.MAINTENANCE]: EquipmentStatus.MAINTENANCE,
      [TankStatus.HARVESTING]: EquipmentStatus.HARVESTING,
      [TankStatus.FALLOW]: EquipmentStatus.FALLOW,
      [TankStatus.QUARANTINE]: EquipmentStatus.QUARANTINE,
      [TankStatus.INACTIVE]: EquipmentStatus.OUT_OF_SERVICE,
    };
    equipment.status = statusMapping[tank.status] ?? EquipmentStatus.OPERATIONAL;

    // Build specifications from tank fields
    equipment.specifications = {
      tankType: tank.tankType,
      material: tank.material,
      waterType: tank.waterType,
      dimensions: {
        diameter: tank.diameter,
        length: tank.length,
        width: tank.width,
        depth: tank.depth,
      },
      volume: tank.volume,
      waterVolume: tank.waterVolume,
      maxBiomass: tank.maxBiomass,
      currentBiomass: tank.currentBiomass,
      maxDensity: tank.maxDensity,
      currentCount: tank.currentCount,
      waterDepth: tank.waterDepth,
      freeboard: tank.freeboard,
      waterFlow: tank.waterFlow,
      aeration: tank.aeration,
    };

    // Map location
    if (tank.location) {
      equipment.location = {
        building: tank.location.building,
        floor: tank.location.floor,
        room: tank.location.section,
        coordinates: tank.location.coordinates,
        notes: tank.location.notes,
      };
    }

    // Populate equipmentSystems from tank's systemId for consistent response
    if (tank.systemId) {
      equipment.equipmentSystems = [{
        id: `${tank.id}-${tank.systemId}`,
        tenantId: tank.tenantId,
        equipmentId: tank.id,
        systemId: tank.systemId,
        isPrimary: true,
        criticalityLevel: 3,
        createdAt: tank.createdAt,
        updatedAt: tank.updatedAt,
        createdBy: tank.createdBy,
      }] as any;
    } else {
      equipment.equipmentSystems = [];
    }

    return equipment;
  }
}
