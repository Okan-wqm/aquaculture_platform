/**
 * Equipment Type Lookup Service
 *
 * Provides utilities for mapping Tank entities to appropriate Equipment Types.
 * Used when converting Tank, Pond, or Cage entities to Equipment format.
 *
 * @module Equipment
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EquipmentType, EquipmentCategory } from '../entities/equipment-type.entity';
import { TankType } from '../../tank/entities/tank.entity';

/**
 * Mapping from TankType enum to equipment type codes
 */
const TANK_TYPE_TO_EQUIPMENT_CODE: Record<TankType, string> = {
  [TankType.CIRCULAR]: 'tank-circular',
  [TankType.RECTANGULAR]: 'tank-rectangular',
  [TankType.RACEWAY]: 'tank-raceway',
  [TankType.D_END]: 'tank-d-end',
  [TankType.OVAL]: 'tank-oval',
  [TankType.SQUARE]: 'tank-square',
  [TankType.OTHER]: 'tank-generic',
};

/**
 * Default equipment type codes for each category when specific type not found
 */
const DEFAULT_EQUIPMENT_CODES: Record<EquipmentCategory, string> = {
  [EquipmentCategory.TANK]: 'tank-generic',
  [EquipmentCategory.POND]: 'pond-generic',
  [EquipmentCategory.CAGE]: 'cage-generic',
  [EquipmentCategory.PUMP]: 'pump-centrifugal',
  [EquipmentCategory.AERATION]: 'blower',
  [EquipmentCategory.FILTRATION]: 'filter-mechanical',
  [EquipmentCategory.HEATING_COOLING]: 'heater',
  [EquipmentCategory.FEEDING]: 'feeder-automatic',
  [EquipmentCategory.MONITORING]: 'sensor-multiparameter',
  [EquipmentCategory.WATER_TREATMENT]: 'uv-sterilizer',
  [EquipmentCategory.HARVESTING]: 'other',
  [EquipmentCategory.TRANSPORT]: 'other',
  [EquipmentCategory.ELECTRICAL]: 'generator',
  [EquipmentCategory.PLUMBING]: 'tank-inlet',
  [EquipmentCategory.SAFETY]: 'other',
  [EquipmentCategory.OTHER]: 'other',
};

export interface EquipmentTypeLookupResult {
  equipmentType: EquipmentType | null;
  code: string;
  found: boolean;
}

@Injectable()
export class EquipmentTypeLookupService {
  private readonly logger = new Logger(EquipmentTypeLookupService.name);

  constructor(
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
  ) {}

  /**
   * Gets the equipment type code for a given TankType
   *
   * @param tankType - The TankType enum value
   * @returns The corresponding equipment type code
   */
  getEquipmentTypeCodeForTankType(tankType: TankType): string {
    return TANK_TYPE_TO_EQUIPMENT_CODE[tankType] || DEFAULT_EQUIPMENT_CODES[EquipmentCategory.TANK];
  }

  /**
   * Finds the EquipmentType entity for a given TankType
   *
   * @param tankType - The TankType enum value
   * @returns EquipmentTypeLookupResult with the found type or fallback
   */
  async findEquipmentTypeForTankType(tankType: TankType): Promise<EquipmentTypeLookupResult> {
    const code = this.getEquipmentTypeCodeForTankType(tankType);
    return this.findEquipmentTypeByCode(code);
  }

  /**
   * Finds an EquipmentType by its code
   *
   * @param code - The equipment type code (e.g., 'tank-circular')
   * @returns EquipmentTypeLookupResult with the found type or null
   */
  async findEquipmentTypeByCode(code: string): Promise<EquipmentTypeLookupResult> {
    const equipmentType = await this.equipmentTypeRepository.findOne({
      where: { code, isActive: true },
    });

    if (equipmentType) {
      return {
        equipmentType,
        code,
        found: true,
      };
    }

    this.logger.warn(`Equipment type with code '${code}' not found`);
    return {
      equipmentType: null,
      code,
      found: false,
    };
  }

  /**
   * Finds the EquipmentType for a given category, with fallback to default
   *
   * @param category - The EquipmentCategory enum value
   * @returns EquipmentTypeLookupResult with the found type or fallback
   */
  async findEquipmentTypeByCategory(category: EquipmentCategory): Promise<EquipmentTypeLookupResult> {
    // First try to find by default code for category
    const defaultCode = DEFAULT_EQUIPMENT_CODES[category];
    const result = await this.findEquipmentTypeByCode(defaultCode);

    if (result.found) {
      return result;
    }

    // Fallback: find any active equipment type in this category
    const fallbackType = await this.equipmentTypeRepository.findOne({
      where: { category, isActive: true },
      order: { sortOrder: 'ASC' },
    });

    if (fallbackType) {
      return {
        equipmentType: fallbackType,
        code: fallbackType.code,
        found: true,
      };
    }

    this.logger.warn(`No equipment type found for category '${category}'`);
    return {
      equipmentType: null,
      code: defaultCode,
      found: false,
    };
  }

  /**
   * Finds the EquipmentType for Pond entities
   * Uses pond-generic as default
   *
   * @returns EquipmentTypeLookupResult
   */
  async findEquipmentTypeForPond(): Promise<EquipmentTypeLookupResult> {
    return this.findEquipmentTypeByCategory(EquipmentCategory.POND);
  }

  /**
   * Finds the EquipmentType for Cage entities
   * Uses cage-generic as default
   *
   * @returns EquipmentTypeLookupResult
   */
  async findEquipmentTypeForCage(): Promise<EquipmentTypeLookupResult> {
    return this.findEquipmentTypeByCategory(EquipmentCategory.CAGE);
  }

  /**
   * Gets all equipment types for a specific category
   *
   * @param category - The EquipmentCategory enum value
   * @returns Array of EquipmentType entities
   */
  async getEquipmentTypesByCategory(category: EquipmentCategory): Promise<EquipmentType[]> {
    return this.equipmentTypeRepository.find({
      where: { category, isActive: true },
      order: { sortOrder: 'ASC' },
    });
  }

  /**
   * Gets all tank-related equipment types
   *
   * @returns Array of EquipmentType entities with TANK category
   */
  async getTankEquipmentTypes(): Promise<EquipmentType[]> {
    return this.getEquipmentTypesByCategory(EquipmentCategory.TANK);
  }

  /**
   * Gets all pond-related equipment types
   *
   * @returns Array of EquipmentType entities with POND category
   */
  async getPondEquipmentTypes(): Promise<EquipmentType[]> {
    return this.getEquipmentTypesByCategory(EquipmentCategory.POND);
  }

  /**
   * Gets all cage-related equipment types
   *
   * @returns Array of EquipmentType entities with CAGE category
   */
  async getCageEquipmentTypes(): Promise<EquipmentType[]> {
    return this.getEquipmentTypesByCategory(EquipmentCategory.CAGE);
  }

  /**
   * Finds an EquipmentType by ID
   *
   * @param id - The equipment type UUID
   * @returns EquipmentType entity or null
   */
  async findEquipmentTypeById(id: string): Promise<EquipmentType | null> {
    return this.equipmentTypeRepository.findOne({
      where: { id, isActive: true },
    });
  }

  /**
   * Ensures the required equipment types exist for tank conversions.
   * This method can be called during initialization to verify the database
   * has the necessary equipment types.
   *
   * @returns Object with status of each required type
   */
  async verifyRequiredEquipmentTypes(): Promise<{
    missing: string[];
    found: string[];
    allPresent: boolean;
  }> {
    const requiredCodes = [
      ...Object.values(TANK_TYPE_TO_EQUIPMENT_CODE),
      'pond-generic',
      'cage-generic',
    ];

    const uniqueCodes = [...new Set(requiredCodes)];
    const found: string[] = [];
    const missing: string[] = [];

    for (const code of uniqueCodes) {
      const exists = await this.equipmentTypeRepository.findOne({
        where: { code },
      });

      if (exists) {
        found.push(code);
      } else {
        missing.push(code);
      }
    }

    if (missing.length > 0) {
      this.logger.warn(
        `Missing equipment types for tank conversion: ${missing.join(', ')}. ` +
        `Run the seed service to create them.`
      );
    }

    return {
      missing,
      found,
      allPresent: missing.length === 0,
    };
  }
}
