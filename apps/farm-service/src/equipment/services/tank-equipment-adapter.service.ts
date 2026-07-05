import { BadRequestException, Injectable } from '@nestjs/common';
import { CommandBus } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { CreateTankCommand } from '../../tank/commands/create-tank.command';
import { DeleteTankCommand } from '../../tank/commands/delete-tank.command';
import { UpdateTankCommand } from '../../tank/commands/update-tank.command';
import { CreateTankInput } from '../../tank/dto/create-tank.dto';
import { UpdateTankInput } from '../../tank/dto/update-tank.dto';
import {
  Tank,
  TankContainerKind,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';
import { CreateEquipmentCommand } from '../commands/create-equipment.command';
import { UpdateEquipmentCommand } from '../commands/update-equipment.command';
import { EquipmentSystem } from '../entities/equipment-system.entity';
import { EquipmentCategory, EquipmentType } from '../entities/equipment-type.entity';
import {
  Equipment,
  EquipmentLocation,
  EquipmentStatus,
  TankSpecifications,
} from '../entities/equipment.entity';

type EquipmentSpecs = TankSpecifications & {
  shape?: string;
  tankType?: string;
  material?: string;
  waterType?: string;
  diameter?: number;
  length?: number;
  width?: number;
  depth?: number;
  maxDepth?: number;
  waterDepth?: number;
  freeboard?: number;
  maxBiomass?: number;
  maxDensity?: number;
  surfaceArea?: number;
  volume?: number;
  dimensions?: {
    diameter?: number;
    length?: number;
    width?: number;
    depth?: number;
    waterDepth?: number;
    freeboard?: number;
  };
  waterFlow?: CreateTankInput['waterFlow'];
  aeration?: CreateTankInput['aeration'];
};

@Injectable()
export class TankEquipmentAdapterService {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly dataSource: DataSource,
  ) {}

  isTankLike(equipmentType: EquipmentType): boolean {
    return [EquipmentCategory.TANK, EquipmentCategory.POND, EquipmentCategory.CAGE].includes(
      equipmentType.category,
    );
  }

  async createFromEquipment(
    tenantId: string,
    userId: string,
    input: CreateEquipmentCommand['input'],
    equipmentType: EquipmentType,
  ): Promise<Equipment> {
    const tank = await this.commandBus.execute<CreateTankCommand, Tank>(
      new CreateTankCommand(tenantId, userId, this.toCreateTankInput(input, equipmentType)),
    );
    return this.toEquipmentResponse(tank, equipmentType);
  }

  async updateFromEquipment(
    tank: Tank,
    tenantId: string,
    userId: string,
    input: UpdateEquipmentCommand['input'],
  ): Promise<Equipment> {
    const equipmentType = await this.resolveEquipmentTypeForTank(tank, input.equipmentTypeId);
    const updated = await this.commandBus.execute<UpdateTankCommand, Tank>(
      new UpdateTankCommand(tenantId, userId, this.toUpdateTankInput(tank, input, equipmentType)),
    );
    return this.toEquipmentResponse(updated, equipmentType);
  }

  async deleteFromEquipment(tankId: string, tenantId: string, userId: string): Promise<boolean> {
    return this.commandBus.execute<DeleteTankCommand, boolean>(
      new DeleteTankCommand(tenantId, userId, tankId),
    );
  }

  async resolveEquipmentTypeForTank(
    tank: Pick<Tank, 'equipmentTypeId' | 'equipmentTypeCode' | 'tankType' | 'containerKind'>,
    overrideEquipmentTypeId?: string,
  ): Promise<EquipmentType | undefined> {
    // eslint-disable-next-line no-restricted-syntax -- EquipmentType is a farm source-schema catalog table without tenantId; tenantManagerRepo is only valid for tenant-owned rows.
    const repository = this.dataSource.getRepository(EquipmentType);
    if (overrideEquipmentTypeId || tank.equipmentTypeId) {
      const byId = await repository.findOne({
        where: { id: overrideEquipmentTypeId ?? tank.equipmentTypeId },
      });
      if (byId) return byId;
    }
    if (tank.equipmentTypeCode) {
      const byCode = await repository.findOne({ where: { code: tank.equipmentTypeCode } });
      if (byCode) return byCode;
    }
    return (
      (await repository.findOne({
        where: { code: this.defaultEquipmentTypeCode(tank.containerKind, tank.tankType) },
      })) ?? undefined
    );
  }

  toEquipmentResponse(tank: Tank, equipmentType?: EquipmentType): Equipment {
    const equipment = new Equipment();
    equipment.id = tank.id;
    equipment.tenantId = tank.tenantId;
    equipment.departmentId = tank.departmentId;
    if (equipmentType?.id ?? tank.equipmentTypeId) {
      equipment.equipmentTypeId = equipmentType?.id ?? tank.equipmentTypeId ?? '';
    }
    if (equipmentType) {
      equipment.equipmentType = equipmentType;
    }
    equipment.name = tank.name;
    equipment.code = tank.code;
    equipment.description = tank.description;
    equipment.installationDate = tank.installationDate;
    equipment.status = this.mapTankStatusToEquipmentStatus(tank.status);
    equipment.location = this.mapTankLocationToEquipmentLocation(tank.location);
    equipment.notes = tank.notes;
    equipment.isActive = tank.isActive;
    equipment.isTank = true;
    equipment.isVisibleInSensor = true;
    equipment.temperatureSensorId = tank.temperatureSensorId;
    equipment.volume = Number(tank.volume);
    equipment.currentBiomass = Number(tank.currentBiomass);
    equipment.currentCount = tank.currentCount;
    equipment.isDeleted = false;
    equipment.createdAt = tank.createdAt;
    equipment.updatedAt = tank.updatedAt;
    equipment.createdBy = tank.createdBy;
    equipment.updatedBy = tank.updatedBy;
    equipment.version = tank.version;
    equipment.specifications = {
      tankType: tank.tankType,
      containerKind: tank.containerKind,
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
      currentBiomass: tank.currentBiomass,
      maxDensity: tank.maxDensity,
      currentCount: tank.currentCount,
      waterFlow: tank.waterFlow,
      aeration: tank.aeration,
    };
    equipment.equipmentSystems = tank.systemId
      ? ([
          {
            id: `${tank.id}-${tank.systemId}`,
            tenantId: tank.tenantId,
            equipmentId: tank.id,
            systemId: tank.systemId,
            isPrimary: true,
            criticalityLevel: 3,
            createdAt: tank.createdAt,
            createdBy: tank.createdBy,
          },
        ] as EquipmentSystem[])
      : [];
    return equipment;
  }

  private toCreateTankInput(
    input: CreateEquipmentCommand['input'],
    equipmentType: EquipmentType,
  ): CreateTankInput {
    const specs = (input.specifications || {}) as EquipmentSpecs;
    const systemId = this.resolveSingleSystemId(input.systemIds);
    const tankType = this.resolveTankType(specs, equipmentType);
    return {
      name: input.name,
      description: input.description,
      departmentId: input.departmentId,
      systemId,
      containerKind: this.mapCategoryToContainerKind(equipmentType.category),
      equipmentTypeId: equipmentType.id,
      equipmentTypeCode: equipmentType.code,
      temperatureSensorId: input.temperatureSensorId,
      tankType,
      material: this.mapTankMaterial(specs.material),
      waterType: this.mapWaterType(specs.waterType),
      diameter: specs.diameter ?? specs.dimensions?.diameter,
      length: specs.length ?? specs.dimensions?.length ?? specs.surfaceArea,
      width: specs.width ?? specs.dimensions?.width,
      depth: specs.depth ?? specs.dimensions?.depth ?? specs.maxDepth ?? 1,
      waterDepth: specs.waterDepth ?? specs.dimensions?.waterDepth,
      freeboard: specs.freeboard ?? specs.dimensions?.freeboard,
      volume: specs.volume,
      maxBiomass: specs.maxBiomass ?? 0,
      maxDensity: specs.maxDensity ?? 30,
      waterFlow: specs.waterFlow,
      aeration: specs.aeration,
      location: this.mapEquipmentLocationToTankLocation(input.location),
      status: this.mapEquipmentStatusToTankStatus(input.status),
      installationDate: input.installationDate
        ? new Date(input.installationDate).toISOString()
        : undefined,
      notes: input.notes,
    };
  }

  private toUpdateTankInput(
    tank: Tank,
    input: UpdateEquipmentCommand['input'],
    equipmentType?: EquipmentType,
  ): UpdateTankInput {
    const specs = input.specifications as EquipmentSpecs | undefined;
    return {
      id: tank.id,
      code: input.code,
      name: input.name,
      description: input.description,
      departmentId: input.departmentId,
      systemId: Object.prototype.hasOwnProperty.call(input, 'systemIds')
        ? this.resolveSingleSystemId(input.systemIds)
        : undefined,
      containerKind: equipmentType
        ? this.mapCategoryToContainerKind(equipmentType.category)
        : undefined,
      equipmentTypeId: equipmentType?.id ?? input.equipmentTypeId,
      equipmentTypeCode: equipmentType?.code,
      temperatureSensorId: input.temperatureSensorId,
      tankType: specs ? this.resolveTankType(specs, equipmentType) : undefined,
      material: specs?.material ? this.mapTankMaterial(specs.material) : undefined,
      waterType: specs?.waterType ? this.mapWaterType(specs.waterType) : undefined,
      diameter: specs?.diameter ?? specs?.dimensions?.diameter,
      length: specs?.length ?? specs?.dimensions?.length ?? specs?.surfaceArea,
      width: specs?.width ?? specs?.dimensions?.width,
      depth: specs?.depth ?? specs?.dimensions?.depth ?? specs?.maxDepth,
      waterDepth: specs?.waterDepth ?? specs?.dimensions?.waterDepth,
      freeboard: specs?.freeboard ?? specs?.dimensions?.freeboard,
      volume: specs?.volume,
      maxBiomass: specs?.maxBiomass,
      maxDensity: specs?.maxDensity,
      waterFlow: specs?.waterFlow,
      aeration: specs?.aeration,
      location: input.location
        ? this.mapEquipmentLocationToTankLocation(input.location)
        : undefined,
      status: input.status ? this.mapEquipmentStatusToTankStatus(input.status) : undefined,
      installationDate: input.installationDate
        ? new Date(input.installationDate).toISOString()
        : undefined,
      notes: input.notes,
    };
  }

  private resolveSingleSystemId(systemIds: string[] | undefined): string | undefined {
    if (!systemIds || systemIds.length === 0) return undefined;
    if (systemIds.length > 1) {
      throw new BadRequestException('Tank-like equipment can only be associated with one system');
    }
    return systemIds[0];
  }

  private mapCategoryToContainerKind(category: EquipmentCategory): TankContainerKind {
    if (category === EquipmentCategory.POND) return TankContainerKind.POND;
    if (category === EquipmentCategory.CAGE) return TankContainerKind.CAGE;
    return TankContainerKind.TANK;
  }

  private resolveTankType(specs: EquipmentSpecs, equipmentType?: EquipmentType): TankType {
    const raw = specs.tankType ?? specs.shape;
    if (raw) return this.mapTankType(raw);
    const code = equipmentType?.code ?? '';
    if (code.includes('circular')) return TankType.CIRCULAR;
    if (code.includes('rectangular')) return TankType.RECTANGULAR;
    if (code.includes('raceway')) return TankType.RACEWAY;
    if (code.includes('d-end')) return TankType.D_END;
    if (code.includes('oval')) return TankType.OVAL;
    if (code.includes('square')) return TankType.SQUARE;
    if (specs.diameter ?? specs.dimensions?.diameter) return TankType.CIRCULAR;
    if ((specs.length ?? specs.dimensions?.length) && (specs.width ?? specs.dimensions?.width)) {
      return TankType.RECTANGULAR;
    }
    return TankType.OTHER;
  }

  private mapTankType(value?: string): TankType {
    const mapping: Record<string, TankType> = {
      circular: TankType.CIRCULAR,
      rectangular: TankType.RECTANGULAR,
      raceway: TankType.RACEWAY,
      d_end: TankType.D_END,
      'd-end': TankType.D_END,
      oval: TankType.OVAL,
      square: TankType.SQUARE,
      other: TankType.OTHER,
    };
    return value ? (mapping[value.toLowerCase()] ?? TankType.OTHER) : TankType.OTHER;
  }

  private mapTankMaterial(value?: string): TankMaterial {
    const mapping: Record<string, TankMaterial> = {
      fiberglass: TankMaterial.FIBERGLASS,
      concrete: TankMaterial.CONCRETE,
      hdpe: TankMaterial.HDPE,
      steel: TankMaterial.STEEL,
      stainless_steel: TankMaterial.STAINLESS_STEEL,
      pvc: TankMaterial.PVC,
      liner: TankMaterial.LINER,
      plastic: TankMaterial.OTHER,
      other: TankMaterial.OTHER,
    };
    return value ? (mapping[value.toLowerCase()] ?? TankMaterial.OTHER) : TankMaterial.OTHER;
  }

  private mapWaterType(value?: string): WaterType {
    const mapping: Record<string, WaterType> = {
      freshwater: WaterType.FRESHWATER,
      saltwater: WaterType.SALTWATER,
      brackish: WaterType.BRACKISH,
    };
    return value ? (mapping[value.toLowerCase()] ?? WaterType.FRESHWATER) : WaterType.FRESHWATER;
  }

  private mapEquipmentStatusToTankStatus(status?: EquipmentStatus): TankStatus {
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
    return status ? (mapping[status] ?? TankStatus.PREPARING) : TankStatus.PREPARING;
  }

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

  private mapEquipmentLocationToTankLocation(location?: EquipmentLocation): Tank['location'] {
    if (!location) return undefined;
    return {
      building: location.building,
      floor: location.floor,
      section: location.room ?? location.section,
      coordinates: location.coordinates,
      notes: location.notes,
    };
  }

  private mapTankLocationToEquipmentLocation(
    location?: Tank['location'],
  ): EquipmentLocation | undefined {
    if (!location) return undefined;
    return {
      building: location.building,
      floor: location.floor,
      room: location.section,
      section: location.section,
      coordinates: location.coordinates,
      notes: location.notes,
    };
  }

  private defaultEquipmentTypeCode(
    containerKind: TankContainerKind | undefined,
    tankType: TankType,
  ): string {
    if (containerKind === TankContainerKind.POND) return 'pond-generic';
    if (containerKind === TankContainerKind.CAGE) return 'cage-generic';
    if (tankType === TankType.CIRCULAR) return 'tank-circular';
    if (tankType === TankType.RECTANGULAR || tankType === TankType.SQUARE)
      return 'tank-rectangular';
    if (tankType === TankType.RACEWAY || tankType === TankType.D_END) return 'tank-raceway';
    return 'tank-generic';
  }
}
