import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';

import { SensorProtocol, ProtocolCategory } from '../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ProtocolCapabilities } from '../adapters/base-protocol.adapter';

export interface ProtocolInfo {
  code: string;
  displayName: string;
  description?: string;
  category: ProtocolCategory;
  subcategory?: string;
  connectionType: string;
  capabilities: ProtocolCapabilities;
}

export interface ProtocolSummary {
  code: string;
  name: string;
  category: ProtocolCategory;
  subcategory?: string;
}

@Injectable()
export class ProtocolRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ProtocolRegistryService.name);
  private adapterMap: Map<string, BaseProtocolAdapter> = new Map();

  constructor(
    @InjectRepository(SensorProtocol)
    private protocolRepository: Repository<SensorProtocol>,
    @Inject('PROTOCOL_ADAPTERS')
    private adapters: BaseProtocolAdapter[],
  ) {}

  async onModuleInit(): Promise<void> {
    // Register all adapters
    for (const adapter of this.adapters) {
      this.adapterMap.set(adapter.protocolCode, adapter);
    }
    this.logger.log(`Registered ${this.adapterMap.size} protocol adapters`);

    // Sync with database (non-fatal - protocols work from in-memory adapters)
    try {
      await this.syncProtocolsToDatabase();
      this.logger.log('Protocol definitions synced to database');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to sync protocols to database: ${errorMessage}. Protocols will still work from in-memory adapters.`);
    }
  }

  /**
   * Sync protocol definitions to database
   */
  private async syncProtocolsToDatabase(): Promise<void> {
    for (const adapter of this.adapters) {
      const existing = await this.protocolRepository.findOne({
        where: { code: adapter.protocolCode },
      });

      const protocolData = {
        code: adapter.protocolCode,
        name: adapter.displayName,
        category: adapter.category,
        subcategory: adapter.subcategory,
        connectionType: adapter.connectionType,
        description: adapter.description,
        configurationSchema: adapter.getConfigurationSchema(),
        defaultConfiguration: adapter.getDefaultConfiguration(),
        isActive: true,
      };

      if (existing) {
        await this.protocolRepository.update(existing.id, protocolData as DeepPartial<SensorProtocol>);
      } else {
        await this.protocolRepository.save(this.protocolRepository.create(protocolData as DeepPartial<SensorProtocol>));
      }
    }
  }

  /**
   * Get adapter by protocol code
   */
  getAdapter(protocolCode: string): BaseProtocolAdapter | undefined {
    return this.adapterMap.get(protocolCode);
  }

  /**
   * Get all registered protocol codes
   */
  getProtocolCodes(): string[] {
    return Array.from(this.adapterMap.keys());
  }

  /**
   * Get all protocols
   */
  getAllProtocols(): ProtocolInfo[] {
    return this.adapters.map((adapter) => ({
      code: adapter.protocolCode,
      displayName: adapter.displayName,
      description: adapter.description,
      category: adapter.category,
      subcategory: adapter.subcategory,
      connectionType: adapter.connectionType,
      capabilities: adapter.getCapabilities(),
    }));
  }

  /**
   * Get protocols by category
   */
  getProtocolsByCategory(category: ProtocolCategory): ProtocolInfo[] {
    return this.getAllProtocols().filter((p) => p.category === category);
  }

  /**
   * Get protocol summary list (lightweight)
   */
  getProtocolSummaries(): ProtocolSummary[] {
    return this.adapters.map((adapter) => ({
      code: adapter.protocolCode,
      name: adapter.displayName,
      category: adapter.category,
      subcategory: adapter.subcategory,
    }));
  }

  /**
   * Get protocol details including schema from database
   */
  async getProtocolDetails(protocolCode: string): Promise<SensorProtocol | null> {
    return this.protocolRepository.findOne({
      where: { code: protocolCode, isActive: true },
    });
  }

  /**
   * Get protocol details from in-memory adapters (always available)
   */
  getProtocolDetailsFromMemory(protocolCode: string): {
    id: string;
    code: string;
    name: string;
    category: ProtocolCategory;
    subcategory?: string;
    connectionType: string;
    description?: string;
    configurationSchema: object;
    defaultConfiguration: Record<string, unknown>;
    isActive: boolean;
  } | null {
    const adapter = this.getAdapter(protocolCode);
    if (!adapter) {
      return null;
    }
    return {
      id: protocolCode, // Use code as ID for in-memory
      code: adapter.protocolCode,
      name: adapter.displayName,
      category: adapter.category,
      subcategory: adapter.subcategory,
      connectionType: adapter.connectionType,
      description: adapter.description,
      configurationSchema: adapter.getConfigurationSchema(),
      defaultConfiguration: adapter.getDefaultConfiguration(),
      isActive: true,
    };
  }

  /**
   * Get all active protocols from database
   */
  async getActiveProtocols(): Promise<SensorProtocol[]> {
    return this.protocolRepository.find({
      where: { isActive: true },
      order: { category: 'ASC', name: 'ASC' },
    });
  }

  /**
   * Get protocols by category from database
   */
  async getProtocolsByCategoryFromDb(category: ProtocolCategory): Promise<SensorProtocol[]> {
    return this.protocolRepository.find({
      where: { category, isActive: true },
      order: { name: 'ASC' },
    });
  }

  /**
   * Check if protocol exists
   */
  hasProtocol(protocolCode: string): boolean {
    return this.adapterMap.has(protocolCode);
  }

  /**
   * Get configuration schema for protocol
   */
  getConfigurationSchema(protocolCode: string): object | undefined {
    const adapter = this.getAdapter(protocolCode);
    return adapter?.getConfigurationSchema();
  }

  /**
   * Get default configuration for protocol
   */
  getDefaultConfiguration(protocolCode: string): Record<string, unknown> | undefined {
    const adapter = this.getAdapter(protocolCode);
    return adapter?.getDefaultConfiguration();
  }

  /**
   * Get protocol capabilities
   */
  getCapabilities(protocolCode: string): ProtocolCapabilities | undefined {
    const adapter = this.getAdapter(protocolCode);
    return adapter?.getCapabilities();
  }

  /**
   * Get category statistics
   */
  getCategoryStats(): Record<ProtocolCategory, number> {
    const stats = {
      [ProtocolCategory.INDUSTRIAL]: 0,
      [ProtocolCategory.IOT]: 0,
      [ProtocolCategory.SERIAL]: 0,
      [ProtocolCategory.WIRELESS]: 0,
    };

    for (const adapter of this.adapters) {
      stats[adapter.category]++;
    }

    return stats;
  }
}
