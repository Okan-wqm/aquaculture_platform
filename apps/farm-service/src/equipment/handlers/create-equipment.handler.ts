/**
 * Create Equipment Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ConflictException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { CreateEquipmentCommand } from '../commands/create-equipment.command';
import { Equipment, EquipmentStatus } from '../entities/equipment.entity';
import { EquipmentType, EquipmentCategory } from '../entities/equipment-type.entity';
import { EquipmentSystem } from '../entities/equipment-system.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';

@CommandHandler(CreateEquipmentCommand)
export class CreateEquipmentHandler implements ICommandHandler<CreateEquipmentCommand> {
  private readonly logger = new Logger(CreateEquipmentHandler.name);

  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
    @InjectRepository(EquipmentSystem)
    private readonly equipmentSystemRepository: Repository<EquipmentSystem>,
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(command: CreateEquipmentCommand): Promise<Equipment> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating equipment "${input.name}" for tenant ${tenantId}`);

    // Verify department exists and belongs to tenant
    const department = await this.departmentRepository.findOne({
      where: { id: input.departmentId, tenantId },
    });
    if (!department) {
      throw new NotFoundException(`Department with ID "${input.departmentId}" not found`);
    }

    // Verify all systems exist and belong to tenant (required - at least one)
    if (!input.systemIds || input.systemIds.length === 0) {
      throw new BadRequestException('At least one system must be specified');
    }

    const systems = await this.systemRepository.find({
      where: { id: In(input.systemIds), tenantId },
    });

    if (systems.length !== input.systemIds.length) {
      const foundIds = systems.map(s => s.id);
      const missingIds = input.systemIds.filter(id => !foundIds.includes(id));
      throw new NotFoundException(`Systems not found: ${missingIds.join(', ')}`);
    }

    // Validate all systems
    for (const system of systems) {
      if (system.isDeleted) {
        throw new BadRequestException(`System with ID "${system.id}" is deleted`);
      }
      // Systems can be from the same site but different departments (shared equipment like generators)
      if (system.siteId !== department.siteId) {
        throw new BadRequestException(
          `System "${system.name}" (${system.id}) does not belong to the same site as Department "${department.name}"`
        );
      }
    }

    // Verify equipment type exists
    const equipmentType = await this.equipmentTypeRepository.findOne({
      where: { id: input.equipmentTypeId },
    });
    if (!equipmentType) {
      throw new NotFoundException(`Equipment type with ID "${input.equipmentTypeId}" not found`);
    }

    // Validate specifications against schema if provided
    if (input.specifications && equipmentType.specificationSchema) {
      this.validateSpecifications(input.specifications, equipmentType.specificationSchema);
    }

    // Determine if this is a tank based on equipment type category
    const isTank = equipmentType.category === EquipmentCategory.TANK;

    // Calculate volume for tanks
    let volume: number | undefined;
    if (isTank && input.specifications) {
      const specs = input.specifications as {
        tankType?: string;
        dimensions?: { diameter?: number; length?: number; width?: number; depth?: number };
        volume?: number;
      };
      volume = specs.volume || this.calculateTankVolume(specs.tankType, specs.dimensions);
    }

    const normalizedCode = input.code.toUpperCase();

    // Check for duplicate code within tenant
    const existingByCode = await this.equipmentRepository.findOne({
      where: { tenantId, code: normalizedCode },
    });
    if (existingByCode) {
      throw new ConflictException(`Equipment with code "${normalizedCode}" already exists`);
    }

    // Check for duplicate serial number if provided
    if (input.serialNumber) {
      const existingBySerial = await this.equipmentRepository.findOne({
        where: { tenantId, serialNumber: input.serialNumber },
      });
      if (existingBySerial) {
        throw new ConflictException(`Equipment with serial number "${input.serialNumber}" already exists`);
      }
    }

    // Verify parent equipment exists if provided
    let parentEquipment: Equipment | null = null;
    if (input.parentEquipmentId) {
      parentEquipment = await this.equipmentRepository.findOne({
        where: { id: input.parentEquipmentId, tenantId },
        relations: ['equipmentSystems'],
      });
      if (!parentEquipment) {
        throw new NotFoundException(`Parent equipment with ID "${input.parentEquipmentId}" not found`);
      }
    }

    // Create equipment entity - aligned with Equipment entity
    const equipment = this.equipmentRepository.create({
      tenantId,
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
      currency: input.currency ?? 'TRY',
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
      isTank,
      volume,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedEquipment = await this.equipmentRepository.save(equipment);

    // Create equipment-system relationships (many-to-many)
    const equipmentSystems = input.systemIds.map((systemId, index) =>
      this.equipmentSystemRepository.create({
        tenantId,
        equipmentId: savedEquipment.id,
        systemId,
        isPrimary: index === 0, // First system is primary by default
        criticalityLevel: 3, // Default criticality
        createdBy: userId,
      })
    );

    await this.equipmentSystemRepository.save(equipmentSystems);

    // Update parent's subEquipmentCount if parent was specified
    if (parentEquipment) {
      await this.equipmentRepository.increment(
        { id: parentEquipment.id },
        'subEquipmentCount',
        1
      );
      this.logger.log(`Incremented subEquipmentCount for parent equipment ${parentEquipment.id}`);
    }

    this.logger.log(`Equipment "${savedEquipment.name}" created with ID ${savedEquipment.id}, linked to ${systems.length} system(s)`);

    // TODO: Publish EquipmentCreated event

    // Return equipment with systems
    savedEquipment.equipmentSystems = equipmentSystems;
    return savedEquipment;
  }

  private validateSpecifications(specs: Record<string, unknown>, schema: { fields: Array<{ name: string; required?: boolean; type: string }> }): void {
    for (const field of schema.fields) {
      if (field.required && (specs[field.name] === undefined || specs[field.name] === null)) {
        throw new BadRequestException(`Required specification field "${field.name}" is missing`);
      }
    }
  }

  /**
   * Calculate tank volume based on tank type and dimensions
   */
  private calculateTankVolume(
    tankType?: string,
    dimensions?: { diameter?: number; length?: number; width?: number; depth?: number },
  ): number | undefined {
    if (!dimensions?.depth) return undefined;

    const depth = dimensions.depth;

    switch (tankType) {
      case 'circular':
      case 'oval':
        if (!dimensions.diameter) return undefined;
        return Math.PI * Math.pow(dimensions.diameter / 2, 2) * depth;

      case 'rectangular':
      case 'square':
      case 'raceway':
      case 'd_end':
        if (!dimensions.length || !dimensions.width) return undefined;
        return dimensions.length * dimensions.width * depth;

      default:
        return undefined;
    }
  }
}
