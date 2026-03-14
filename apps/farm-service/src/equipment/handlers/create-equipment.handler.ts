/**
 * Create Equipment Command Handler
 */
import { randomUUID } from 'crypto';

import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ConflictException, NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { EquipmentCreatedEvent } from '@platform/event-contracts';
import { CreateEquipmentCommand } from '../commands/create-equipment.command';
import { Equipment, EquipmentStatus, TankSpecifications } from '../entities/equipment.entity';
import { EquipmentType, EquipmentCategory } from '../entities/equipment-type.entity';
import { EquipmentSystem } from '../entities/equipment-system.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { Tank, TankType, TankMaterial, TankStatus, WaterType } from '../../tank/entities/tank.entity';
import { CodeGeneratorService } from '../../database/services/code-generator.service';

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
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    private readonly codeGeneratorService: CodeGeneratorService,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
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

    // Determine if this is a tank type (TANK, POND, or CAGE) that should be saved to tanks table
    const isTankType = [
      EquipmentCategory.TANK,
      EquipmentCategory.POND,
      EquipmentCategory.CAGE,
    ].includes(equipmentType.category);

    // If it's a tank type, save to tanks table instead
    if (isTankType) {
      return this.createTankFromEquipmentInput(
        tenantId,
        userId,
        input,
        equipmentType,
        department,
        systems,
      );
    }

    // Calculate volume for tanks (legacy - for equipment table)
    let volume: number | undefined;
    const isTank = equipmentType.category === EquipmentCategory.TANK;
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

    // Publish domain event: EquipmentCreated
    if (this.eventBus) {
      try {
        const event: EquipmentCreatedEvent = {
          eventId: randomUUID(),
          eventType: 'EquipmentCreated',
          tenantId,
          timestamp: new Date(),
          equipmentId: savedEquipment.id,
          siteId: department.siteId ?? '',
          systemId: systems[0]?.id,
          departmentId: savedEquipment.departmentId,
          name: savedEquipment.name,
          code: savedEquipment.code,
          typeId: savedEquipment.equipmentTypeId,
          category: equipmentType.category,
          status: savedEquipment.status,
          version: 1,
        };
        await this.eventBus.publish(event);
        this.logger.debug(`Published EquipmentCreatedEvent for equipment ${savedEquipment.id}`);
      } catch (eventError) {
        this.logger.warn(`Failed to publish EquipmentCreatedEvent: ${(eventError as Error).message}`);
      }
    }

    // Return equipment with systems
    savedEquipment.equipmentSystems = equipmentSystems;
    return savedEquipment;
  }

  /**
   * Creates a Tank entity from CreateEquipmentInput when the equipment type
   * category is TANK, POND, or CAGE. Returns an Equipment-like response.
   */
  private async createTankFromEquipmentInput(
    tenantId: string,
    userId: string,
    input: CreateEquipmentCommand['input'],
    equipmentType: EquipmentType,
    department: Department,
    systems: System[],
  ): Promise<Equipment> {
    const specs = (input.specifications || {}) as unknown as TankSpecifications & {
      tankType?: string;
      material?: string;
      waterType?: string;
      diameter?: number;
      length?: number;
      width?: number;
      depth?: number;
      waterDepth?: number;
      freeboard?: number;
      maxBiomass?: number;
      maxDensity?: number;
      volume?: number;
      dimensions?: {
        diameter?: number;
        length?: number;
        width?: number;
        depth?: number;
        waterDepth?: number;
        freeboard?: number;
      };
      waterFlow?: Tank['waterFlow'];
      aeration?: Tank['aeration'];
    };

    // Extract tank-specific fields from specifications
    // Support both flat fields and nested dimensions object
    const tankType = this.mapTankType(specs.tankType || (specs.dimensions?.diameter ? 'circular' : 'rectangular'));
    const material = this.mapTankMaterial(specs.material);
    const waterType = this.mapWaterType(specs.waterType);

    // Get dimensions - support both flat and nested formats
    const diameter = specs.diameter ?? specs.dimensions?.diameter;
    const length = specs.length ?? specs.dimensions?.length;
    const width = specs.width ?? specs.dimensions?.width;
    const depth = specs.depth ?? specs.dimensions?.depth ?? 1; // Default depth of 1m if not specified
    const waterDepth = specs.waterDepth ?? specs.dimensions?.waterDepth;
    const freeboard = specs.freeboard ?? specs.dimensions?.freeboard;

    // Get capacity limits
    const maxBiomass = specs.maxBiomass ?? 0;
    const maxDensity = specs.maxDensity ?? 30; // Default 30 kg/m3

    // Generate tank code
    const tankCode = await this.codeGeneratorService.generateTankCode(tenantId);

    // Check for duplicate tank code (should not happen with generated codes, but safety check)
    const existingTank = await this.tankRepository.findOne({
      where: { tenantId, code: tankCode },
    });
    if (existingTank) {
      throw new ConflictException(`Tank with code "${tankCode}" already exists`);
    }

    // Map equipment status to tank status
    const tankStatus = this.mapEquipmentStatusToTankStatus(input.status);

    // Create Tank entity
    const tank = this.tankRepository.create({
      tenantId,
      name: input.name,
      code: tankCode,
      description: input.description,
      departmentId: input.departmentId,
      systemId: systems.length > 0 ? systems[0]!.id : undefined,
      tankType,
      material,
      waterType,
      diameter,
      length,
      width,
      depth,
      waterDepth,
      freeboard,
      volume: 0, // Will be calculated by BeforeInsert hook
      maxBiomass,
      currentBiomass: 0,
      maxDensity,
      waterFlow: specs.waterFlow,
      aeration: specs.aeration,
      location: input.location as Tank['location'],
      status: tankStatus,
      installationDate: input.installationDate ? new Date(input.installationDate) : undefined,
      notes: input.notes,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    // Calculate volume (also done in BeforeInsert, but we verify here)
    tank.calculateVolume();

    if (tank.volume <= 0 && !specs.volume) {
      this.logger.warn(`Tank volume could not be calculated from dimensions, using provided volume or 0`);
      tank.volume = specs.volume ?? 0;
    }

    // Override with provided volume if specified
    if (specs.volume && specs.volume > 0) {
      tank.volume = specs.volume;
    }

    const savedTank = await this.tankRepository.save(tank);

    this.logger.log(
      `Tank "${savedTank.name}" created with ID ${savedTank.id}, code ${savedTank.code} (${savedTank.volume?.toFixed(2) ?? 0}m3) from equipment input`,
    );

    // Map Tank back to Equipment response format
    return this.mapTankToEquipmentResponse(savedTank, equipmentType, systems);
  }

  /**
   * Maps a Tank entity back to an Equipment-like response
   */
  private mapTankToEquipmentResponse(
    tank: Tank,
    equipmentType: EquipmentType,
    systems: System[],
  ): Equipment {
    const equipment = new Equipment();

    equipment.id = tank.id;
    equipment.tenantId = tank.tenantId;
    equipment.departmentId = tank.departmentId;
    equipment.equipmentTypeId = equipmentType.id;
    equipment.equipmentType = equipmentType;
    equipment.name = tank.name;
    equipment.code = tank.code;
    equipment.description = tank.description;
    equipment.installationDate = tank.installationDate;
    equipment.status = this.mapTankStatusToEquipmentStatus(tank.status);
    equipment.location = tank.location;
    equipment.notes = tank.notes;
    equipment.isActive = tank.isActive;
    equipment.isTank = true;
    equipment.volume = tank.volume;
    equipment.currentBiomass = tank.currentBiomass;
    equipment.currentCount = tank.currentCount;
    equipment.createdAt = tank.createdAt;
    equipment.updatedAt = tank.updatedAt;
    equipment.createdBy = tank.createdBy;
    equipment.updatedBy = tank.updatedBy;
    equipment.version = tank.version;

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
        waterDepth: tank.waterDepth,
        freeboard: tank.freeboard,
      },
      volume: tank.volume,
      waterVolume: tank.waterVolume,
      maxBiomass: tank.maxBiomass,
      maxDensity: tank.maxDensity,
      waterFlow: tank.waterFlow,
      aeration: tank.aeration,
    } as TankSpecifications;

    // Create mock equipment systems for response
    equipment.equipmentSystems = systems.map((system, index) => ({
      id: `${tank.id}-${system.id}`,
      tenantId: tank.tenantId,
      equipmentId: tank.id,
      systemId: system.id,
      isPrimary: index === 0,
      criticalityLevel: 3,
      createdAt: tank.createdAt,
      updatedAt: tank.updatedAt,
      createdBy: tank.createdBy,
    })) as unknown as Equipment['equipmentSystems'];

    return equipment;
  }

  /**
   * Maps string tank type to TankType enum
   */
  private mapTankType(tankType?: string): TankType {
    if (!tankType) return TankType.OTHER;

    const mapping: Record<string, TankType> = {
      circular: TankType.CIRCULAR,
      rectangular: TankType.RECTANGULAR,
      raceway: TankType.RACEWAY,
      d_end: TankType.D_END,
      oval: TankType.OVAL,
      square: TankType.SQUARE,
      other: TankType.OTHER,
    };

    return mapping[tankType.toLowerCase()] ?? TankType.OTHER;
  }

  /**
   * Maps string material to TankMaterial enum
   */
  private mapTankMaterial(material?: string): TankMaterial {
    if (!material) return TankMaterial.OTHER;

    const mapping: Record<string, TankMaterial> = {
      fiberglass: TankMaterial.FIBERGLASS,
      concrete: TankMaterial.CONCRETE,
      hdpe: TankMaterial.HDPE,
      steel: TankMaterial.STEEL,
      stainless_steel: TankMaterial.STAINLESS_STEEL,
      pvc: TankMaterial.PVC,
      liner: TankMaterial.LINER,
      other: TankMaterial.OTHER,
    };

    return mapping[material.toLowerCase()] ?? TankMaterial.OTHER;
  }

  /**
   * Maps string water type to WaterType enum
   */
  private mapWaterType(waterType?: string): WaterType {
    if (!waterType) return WaterType.FRESHWATER;

    const mapping: Record<string, WaterType> = {
      freshwater: WaterType.FRESHWATER,
      saltwater: WaterType.SALTWATER,
      brackish: WaterType.BRACKISH,
    };

    return mapping[waterType.toLowerCase()] ?? WaterType.FRESHWATER;
  }

  /**
   * Maps EquipmentStatus to TankStatus
   */
  private mapEquipmentStatusToTankStatus(status?: EquipmentStatus): TankStatus {
    if (!status) return TankStatus.PREPARING;

    const mapping: Record<EquipmentStatus, TankStatus> = {
      [EquipmentStatus.OPERATIONAL]: TankStatus.ACTIVE,
      [EquipmentStatus.MAINTENANCE]: TankStatus.MAINTENANCE,
      [EquipmentStatus.REPAIR]: TankStatus.MAINTENANCE,
      [EquipmentStatus.OUT_OF_SERVICE]: TankStatus.INACTIVE,
      [EquipmentStatus.DECOMMISSIONED]: TankStatus.INACTIVE,
      [EquipmentStatus.STANDBY]: TankStatus.FALLOW,
      [EquipmentStatus.ACTIVE]: TankStatus.ACTIVE,
      [EquipmentStatus.PREPARING]: TankStatus.PREPARING,
      [EquipmentStatus.CLEANING]: TankStatus.CLEANING,
      [EquipmentStatus.HARVESTING]: TankStatus.HARVESTING,
      [EquipmentStatus.FALLOW]: TankStatus.FALLOW,
      [EquipmentStatus.QUARANTINE]: TankStatus.QUARANTINE,
    };

    return mapping[status] ?? TankStatus.PREPARING;
  }

  /**
   * Maps TankStatus to EquipmentStatus
   */
  private mapTankStatusToEquipmentStatus(status: TankStatus): EquipmentStatus {
    const mapping: Record<TankStatus, EquipmentStatus> = {
      [TankStatus.ACTIVE]: EquipmentStatus.ACTIVE,
      [TankStatus.PREPARING]: EquipmentStatus.PREPARING,
      [TankStatus.CLEANING]: EquipmentStatus.CLEANING,
      [TankStatus.MAINTENANCE]: EquipmentStatus.MAINTENANCE,
      [TankStatus.HARVESTING]: EquipmentStatus.HARVESTING,
      [TankStatus.FALLOW]: EquipmentStatus.FALLOW,
      [TankStatus.QUARANTINE]: EquipmentStatus.QUARANTINE,
      [TankStatus.INACTIVE]: EquipmentStatus.OUT_OF_SERVICE,
    };

    return mapping[status] ?? EquipmentStatus.OPERATIONAL;
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
