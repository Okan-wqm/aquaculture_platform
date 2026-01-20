import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VfdRegisterMapping, VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdParameterCategory, VfdDataType, ByteOrder } from '../entities/vfd.enums';
import {
  VFD_BRAND_REGISTERS,
  getVfdRegisterMappings,
  getCriticalParameters,
  getParametersByCategory,
  getWritableParameters,
} from '../brand-configs';

/**
 * VFD Register Mapping Service
 * Manages brand-specific register mappings and provides access to parameter definitions
 */
@Injectable()
export class VfdRegisterMappingService {
  private readonly logger = new Logger(VfdRegisterMappingService.name);

  constructor(
    @InjectRepository(VfdRegisterMapping)
    private readonly registerMappingRepository: Repository<VfdRegisterMapping>
  ) {}

  /**
   * Get all register mappings for a brand
   */
  async getMappingsForBrand(brand: VfdBrand, modelSeries?: string): Promise<VfdRegisterMapping[]> {
    // First, try to get from database (for custom mappings)
    const customMappings = await this.registerMappingRepository.find({
      where: {
        brand,
        ...(modelSeries && { modelSeries }),
        isActive: true,
      },
      order: { displayOrder: 'ASC' },
    });

    if (customMappings.length > 0) {
      return customMappings;
    }

    // Fall back to built-in mappings
    const builtInMappings = getVfdRegisterMappings(brand);
    return this.convertToEntities(builtInMappings);
  }

  /**
   * Get critical parameters for real-time monitoring
   */
  async getCriticalMappings(brand: VfdBrand): Promise<VfdRegisterMapping[]> {
    const criticalInputs = getCriticalParameters(brand);
    return this.convertToEntities(criticalInputs);
  }

  /**
   * Get parameters by category
   */
  async getMappingsByCategory(
    brand: VfdBrand,
    category: VfdParameterCategory
  ): Promise<VfdRegisterMapping[]> {
    const categoryInputs = getParametersByCategory(brand, category);
    return this.convertToEntities(categoryInputs);
  }

  /**
   * Get writable parameters (for control operations)
   */
  async getWritableMappings(brand: VfdBrand): Promise<VfdRegisterMapping[]> {
    const writableInputs = getWritableParameters(brand);
    return this.convertToEntities(writableInputs);
  }

  /**
   * Get status word mapping for a brand
   */
  async getStatusWordMapping(brand: VfdBrand): Promise<VfdRegisterMapping | null> {
    const mappings = await this.getMappingsForBrand(brand);
    return mappings.find(m => m.parameterName === 'status_word' || m.parameterName === 'status_word_1') || null;
  }

  /**
   * Get control word mapping for a brand
   */
  async getControlWordMapping(brand: VfdBrand): Promise<VfdRegisterMapping | null> {
    const mappings = await this.getMappingsForBrand(brand);
    return mappings.find(m => m.parameterName === 'control_word' || m.parameterName === 'control_word_1') || null;
  }

  /**
   * Get speed reference mapping for a brand
   */
  async getSpeedReferenceMapping(brand: VfdBrand): Promise<VfdRegisterMapping | null> {
    const mappings = await this.getMappingsForBrand(brand);
    return mappings.find(m =>
      m.parameterName === 'speed_reference' ||
      m.parameterName === 'frequency_reference' ||
      m.parameterName === 'frequency_command' ||
      m.parameterName === 'speed_setpoint_main'
    ) || null;
  }

  /**
   * Create a custom register mapping
   */
  async createCustomMapping(input: VfdRegisterMappingInput): Promise<VfdRegisterMapping> {
    const mapping = this.registerMappingRepository.create({
      brand: input.brand,
      modelSeries: input.modelSeries,
      parameterName: input.parameterName,
      displayName: input.displayName,
      description: input.description,
      category: input.category,
      registerAddress: input.registerAddress,
      registerCount: input.registerCount || 1,
      functionCode: input.functionCode || 3,
      dataType: input.dataType || VfdDataType.UINT16,
      scalingFactor: input.scalingFactor || 1,
      offset: input.offset || 0,
      unit: input.unit,
      byteOrder: input.byteOrder || ByteOrder.BIG,
      wordOrder: input.wordOrder || ByteOrder.BIG,
      isBitField: input.isBitField || false,
      bitDefinitions: input.bitDefinitions,
      isReadable: input.isReadable ?? true,
      isWritable: input.isWritable || false,
      recommendedPollIntervalMs: input.recommendedPollIntervalMs || 500,
      displayOrder: input.displayOrder || 0,
      isCritical: input.isCritical || false,
      minValue: input.minValue,
      maxValue: input.maxValue,
      isActive: true,
    });

    return this.registerMappingRepository.save(mapping);
  }

  /**
   * Update a custom register mapping
   */
  async updateCustomMapping(
    id: string,
    input: Partial<VfdRegisterMappingInput>
  ): Promise<VfdRegisterMapping> {
    const mapping = await this.registerMappingRepository.findOne({ where: { id } });
    if (!mapping) {
      throw new Error(`Register mapping with ID ${id} not found`);
    }

    Object.assign(mapping, input);
    return this.registerMappingRepository.save(mapping);
  }

  /**
   * Delete a custom register mapping
   */
  async deleteCustomMapping(id: string): Promise<boolean> {
    const result = await this.registerMappingRepository.delete(id);
    return (result.affected || 0) > 0;
  }

  /**
   * Seed database with built-in mappings for a brand
   */
  async seedBrandMappings(brand: VfdBrand): Promise<number> {
    const builtInMappings = VFD_BRAND_REGISTERS[brand];
    if (!builtInMappings || builtInMappings.length === 0) {
      return 0;
    }

    let count = 0;
    for (const input of builtInMappings) {
      const existing = await this.registerMappingRepository.findOne({
        where: {
          brand: input.brand,
          parameterName: input.parameterName,
          modelSeries: input.modelSeries || undefined,
        },
      });

      if (!existing) {
        await this.createCustomMapping(input);
        count++;
      }
    }

    this.logger.log(`Seeded ${count} register mappings for brand ${brand}`);
    return count;
  }

  /**
   * Get all supported brands with their parameter counts
   */
  async getBrandsSummary(): Promise<Array<{
    brand: VfdBrand;
    totalParameters: number;
    criticalParameters: number;
    writableParameters: number;
    categories: VfdParameterCategory[];
  }>> {
    const result = [];

    for (const brand of Object.values(VfdBrand)) {
      const mappings = VFD_BRAND_REGISTERS[brand] || [];
      const categories = [...new Set(mappings.map(m => m.category))];

      result.push({
        brand,
        totalParameters: mappings.length,
        criticalParameters: mappings.filter(m => m.isCritical).length,
        writableParameters: mappings.filter(m => m.isWritable).length,
        categories,
      });
    }

    return result;
  }

  /**
   * Validate register address for a brand
   */
  async validateRegisterAddress(
    brand: VfdBrand,
    address: number,
    isWrite: boolean = false
  ): Promise<{
    valid: boolean;
    mapping?: VfdRegisterMapping;
    error?: string;
  }> {
    const mappings = await this.getMappingsForBrand(brand);
    const mapping = mappings.find(m => m.registerAddress === address);

    if (!mapping) {
      return {
        valid: false,
        error: `Register address ${address} not found for brand ${brand}`,
      };
    }

    if (isWrite && !mapping.isWritable) {
      return {
        valid: false,
        mapping,
        error: `Register at address ${address} is not writable`,
      };
    }

    return {
      valid: true,
      mapping,
    };
  }

  /**
   * Convert VfdRegisterMappingInput array to VfdRegisterMapping entities
   */
  private convertToEntities(inputs: VfdRegisterMappingInput[]): VfdRegisterMapping[] {
    return inputs.map(input => {
      const mapping = new VfdRegisterMapping();
      mapping.id = `builtin_${input.brand}_${input.parameterName}`;
      mapping.brand = input.brand;
      mapping.modelSeries = input.modelSeries || null;
      mapping.parameterName = input.parameterName;
      mapping.displayName = input.displayName;
      mapping.description = input.description || null;
      mapping.category = input.category;
      mapping.registerAddress = input.registerAddress;
      mapping.registerCount = input.registerCount || 1;
      mapping.functionCode = input.functionCode || 3;
      mapping.dataType = input.dataType || VfdDataType.UINT16;
      mapping.scalingFactor = input.scalingFactor || 1;
      mapping.offset = input.offset || 0;
      mapping.unit = input.unit || null;
      mapping.byteOrder = input.byteOrder || ByteOrder.BIG;
      mapping.wordOrder = input.wordOrder || ByteOrder.BIG;
      mapping.isBitField = input.isBitField || false;
      mapping.bitDefinitions = input.bitDefinitions || null;
      mapping.isReadable = input.isReadable ?? true;
      mapping.isWritable = input.isWritable || false;
      mapping.recommendedPollIntervalMs = input.recommendedPollIntervalMs || 500;
      mapping.displayOrder = input.displayOrder || 0;
      mapping.isActive = true;
      mapping.isCritical = input.isCritical || false;
      mapping.minValue = input.minValue ?? null;
      mapping.maxValue = input.maxValue ?? null;
      return mapping;
    });
  }
}
