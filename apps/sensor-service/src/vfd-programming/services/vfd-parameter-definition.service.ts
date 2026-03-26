import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VfdParameterDefinition } from '../entities/vfd-parameter-definition.entity';
import { VfdBrand, VfdParameterGroup } from '../../vfd/entities/vfd.enums';
import { VfdDeviceService } from '../../vfd/services/vfd-device.service';
import {
  getVfdConfigRegisters,
  getVfdConfigRegistersByGroup,
  VFD_BRAND_CONFIG_REGISTERS,
} from '../../vfd/brand-configs';
import { VfdConfigRegisterInput } from '../../vfd/entities/vfd.types';

/**
 * VFD Parameter Definition Service
 * Manages writable VFD parameter definitions, seeded from brand config files.
 * DB overrides take precedence; falls back to in-memory brand config.
 */
@Injectable()
export class VfdParameterDefinitionService {
  private readonly logger = new Logger(VfdParameterDefinitionService.name);

  constructor(
    @InjectRepository(VfdParameterDefinition)
    private readonly definitionRepository: Repository<VfdParameterDefinition>,
    private readonly vfdDeviceService: VfdDeviceService,
  ) {}

  /**
   * Get all parameter definitions for a device.
   * Resolves device brand, queries DB for overrides, falls back to brand config.
   */
  async getDefinitionsForDevice(
    deviceId: string,
    tenantId: string,
  ): Promise<VfdParameterDefinition[]> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);

    // Try DB definitions first (tenant or global)
    const dbDefinitions = await this.definitionRepository.find({
      where: [
        { brand: device.brand, tenantId },
        { brand: device.brand, tenantId: undefined },
      ],
      order: { displayOrder: 'ASC' },
    });

    if (dbDefinitions.length > 0) {
      return dbDefinitions;
    }

    // Fallback: convert brand config to definition shape
    const configRegisters = getVfdConfigRegisters(device.brand);
    return configRegisters.map((reg) => this.configRegisterToDefinition(reg));
  }

  /**
   * Get definitions filtered by parameter group for a brand.
   */
  async getDefinitionsByGroup(
    brand: VfdBrand,
    group: VfdParameterGroup,
  ): Promise<VfdParameterDefinition[]> {
    const dbDefinitions = await this.definitionRepository.find({
      where: { brand, group },
      order: { displayOrder: 'ASC' },
    });

    if (dbDefinitions.length > 0) {
      return dbDefinitions;
    }

    const configRegisters = getVfdConfigRegistersByGroup(brand, group);
    return configRegisters.map((reg) => this.configRegisterToDefinition(reg));
  }

  /**
   * Find a single parameter definition by brand and parameter name.
   * DB first, then brand config fallback.
   */
  async findByParameterName(
    brand: VfdBrand,
    parameterName: string,
  ): Promise<VfdParameterDefinition | null> {
    // DB lookup
    const dbDef = await this.definitionRepository.findOne({
      where: { brand, parameterName },
    });

    if (dbDef) {
      return dbDef;
    }

    // Brand config fallback
    const configRegisters = getVfdConfigRegisters(brand);
    const match = configRegisters.find(
      (reg) => reg.parameterName === parameterName,
    );

    if (!match) {
      return null;
    }

    return this.configRegisterToDefinition(match);
  }

  /**
   * Seed DB from VFD_BRAND_CONFIG_REGISTERS for a given brand.
   * Uses upsert pattern: checks existing before insert, skips duplicates.
   */
  async seedBrandDefinitions(brand: VfdBrand): Promise<number> {
    const configRegisters = VFD_BRAND_CONFIG_REGISTERS[brand] ?? [];

    if (configRegisters.length === 0) {
      this.logger.warn(`No config registers found for brand ${brand}`);
      return 0;
    }

    let seededCount = 0;

    for (const reg of configRegisters) {
      const existing = await this.definitionRepository.findOne({
        where: {
          brand,
          parameterName: reg.parameterName,
          modelSeries: reg.modelSeries ?? undefined,
        },
      });

      if (existing) {
        continue;
      }

      const definition = this.definitionRepository.create(
        this.configRegisterToPartial(reg),
      );
      await this.definitionRepository.save(definition);
      seededCount++;
    }

    this.logger.log(
      `Seeded ${seededCount} parameter definitions for brand ${brand}`,
    );
    return seededCount;
  }

  /**
   * Convert a VfdConfigRegisterInput to a VfdParameterDefinition entity shape.
   * Used for in-memory fallback when DB has no rows.
   */
  private configRegisterToDefinition(
    reg: VfdConfigRegisterInput,
  ): VfdParameterDefinition {
    const def = new VfdParameterDefinition();
    def.id = `config-${reg.brand}-${reg.parameterName}`;
    def.brand = reg.brand as VfdBrand;
    def.modelSeries = reg.modelSeries;
    def.parameterName = reg.parameterName;
    def.displayName = reg.displayName;
    def.description = reg.description;
    def.category = reg.category ?? 'configuration';
    def.group = reg.group as VfdParameterGroup;
    def.registerAddress = reg.registerAddress;
    def.registerCount = reg.registerCount ?? 1;
    def.functionCode = reg.functionCode ?? 6;
    def.dataType = reg.dataType ?? 'uint16';
    def.scalingFactor = reg.scalingFactor ?? 1;
    def.offset = reg.offset ?? 0;
    def.unit = reg.unit;
    def.byteOrder = reg.byteOrder ?? 'big';
    def.wordOrder = reg.wordOrder ?? 'big';
    def.minValue = reg.minValue;
    def.maxValue = reg.maxValue;
    def.defaultValue = reg.defaultValue;
    def.step = reg.step;
    def.riskLevel = reg.riskLevel as import('../../vfd/entities/vfd.enums').RiskLevel;
    def.requiresMotorStop = reg.requiresMotorStop;
    def.isReadable = reg.isReadable ?? true;
    def.isWritable = reg.isWritable ?? true;
    def.isActive = true;
    def.displayOrder = reg.displayOrder ?? 0;
    def.metadata = reg.metadata;
    def.createdAt = new Date();
    def.updatedAt = new Date();
    return def;
  }

  /**
   * Convert a VfdConfigRegisterInput to a DeepPartial for DB insert.
   */
  private configRegisterToPartial(
    reg: VfdConfigRegisterInput,
  ): Partial<VfdParameterDefinition> {
    return {
      brand: reg.brand as VfdBrand,
      modelSeries: reg.modelSeries,
      parameterName: reg.parameterName,
      displayName: reg.displayName,
      description: reg.description,
      category: reg.category ?? 'configuration',
      group: reg.group as VfdParameterGroup,
      registerAddress: reg.registerAddress,
      registerCount: reg.registerCount ?? 1,
      functionCode: reg.functionCode ?? 6,
      dataType: reg.dataType ?? 'uint16',
      scalingFactor: reg.scalingFactor ?? 1,
      offset: reg.offset ?? 0,
      unit: reg.unit,
      byteOrder: reg.byteOrder ?? 'big',
      wordOrder: reg.wordOrder ?? 'big',
      minValue: reg.minValue,
      maxValue: reg.maxValue,
      defaultValue: reg.defaultValue,
      step: reg.step,
      riskLevel: reg.riskLevel as import('../../vfd/entities/vfd.enums').RiskLevel,
      requiresMotorStop: reg.requiresMotorStop,
      isReadable: reg.isReadable ?? true,
      isWritable: reg.isWritable ?? true,
      isActive: true,
      displayOrder: reg.displayOrder ?? 0,
      metadata: reg.metadata,
    };
  }
}
