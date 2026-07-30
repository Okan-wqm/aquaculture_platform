import { Injectable, Inject, OnModuleInit, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ModuleRef } from '@nestjs/core';
import { Repository, EntityManager, DeepPartial, QueryDeepPartialEntity } from 'typeorm';
import { forEachTenantSchema } from '@aquaculture/backend-common/database';

import { SensorProtocol, ProtocolCategory } from '../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ProtocolCapabilities } from '../adapters/base-protocol.adapter';
import { PROTOCOL_ADAPTERS } from '../adapters/protocol-adapters.registry';
import {
  ProtocolImplementationStatus,
  getProtocolImplementationStatus,
} from '../adapters/protocol-implementation-status';

export interface ProtocolInfo {
  code: string;
  displayName: string;
  description?: string;
  category: ProtocolCategory;
  subcategory?: string;
  connectionType: string;
  capabilities: ProtocolCapabilities;
  implementationStatus: ProtocolImplementationStatus;
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
  private adapterMap: Map<string, BaseProtocolAdapter<unknown>> = new Map();
  private adapters: BaseProtocolAdapter<unknown>[] = [];

  constructor(
    @InjectRepository(SensorProtocol)
    private protocolRepository: Repository<SensorProtocol>,
    private moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    // Get all adapter instances from ModuleRef
    for (const AdapterClass of PROTOCOL_ADAPTERS) {
      try {
        const adapter = this.moduleRef.get(AdapterClass, { strict: false });
        if (adapter) {
          this.adapters.push(adapter);
          this.adapterMap.set(adapter.protocolCode, adapter);
        }
      } catch (error) {
        this.logger.warn(`Failed to get adapter ${AdapterClass.name}: ${error}`);
      }
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
   * Sync protocol definitions to database.
   *
   * SENSOR-MEDIUM-069: `sensor_protocols` is per-tenant cloned reference data.
   * This sync previously wrote only the default (`sensor` source) schema, so
   * every tenant copy froze at provision time: a protocol adapter added in a
   * later release never reached an existing tenant, and registerSensor's
   * `getProtocolDetails` — which reads the TENANT copy — returned null, so the
   * sensor persisted with a NULL protocol_id and testSensorConnection failed
   * with "No protocol configured". The code-defined catalog is now fanned out to
   * the source schema AND every provisioned tenant schema, so a new protocol is
   * available to the oldest tenants too. Per-tenant work is bounded, error-
   * isolated, and non-fatal (in-memory adapters keep working regardless).
   */
  private async syncProtocolsToDatabase(): Promise<void> {
    // 1. Canonical source schema (`sensor`) via the default connection manager.
    for (const adapter of this.adapters) {
      await this.upsertProtocol(this.protocolRepository.manager, adapter);
    }

    // 2. Fan the catalog out to every provisioned tenant schema.
    const results = await forEachTenantSchema(
      this.protocolRepository.manager.connection,
      async ({ queryRunner }) => {
        for (const adapter of this.adapters) {
          await this.upsertProtocol(queryRunner.manager, adapter);
        }
      },
      { searchPathSuffix: 'sensor, public', logger: this.logger },
    );

    const notOk = results.filter((r) => r.outcome !== 'ok');
    if (notOk.length > 0) {
      this.logger.warn(
        `Protocol sync reached ${results.length - notOk.length}/${results.length} tenant schema(s); ` +
          `unsynced: ${notOk.map((r) => r.schema).join(', ')}`,
      );
    }
  }

  /**
   * Upsert one adapter's definition into whichever schema `manager` is bound to
   * (the source `sensor` schema, or a tenant schema via forEachTenantSchema's
   * search_path-pinned QueryRunner).
   */
  private async upsertProtocol(
    manager: EntityManager,
    adapter: BaseProtocolAdapter<unknown>,
  ): Promise<void> {
    const protocolData = {
      code: adapter.protocolCode,
      name: adapter.displayName,
      category: adapter.category,
      subcategory: adapter.subcategory,
      connectionType: adapter.connectionType,
      description: adapter.description,
      configurationSchema: adapter.getConfigurationSchema(),
      defaultConfiguration: adapter.getDefaultConfiguration(),
      // Unsupported (stub) protocols are persisted inactive so no product
      // surface offers them (SENSOR-CRITICAL-008).
      isActive:
        getProtocolImplementationStatus(adapter.protocolCode) !==
        ProtocolImplementationStatus.UNSUPPORTED,
    };

    const existing = await manager.findOne(SensorProtocol, {
      where: { code: adapter.protocolCode },
    });

    if (existing) {
      await manager.update(
        SensorProtocol,
        existing.id,
        protocolData as QueryDeepPartialEntity<SensorProtocol>,
      );
    } else {
      await manager.save(manager.create(SensorProtocol, protocolData as DeepPartial<SensorProtocol>));
    }
  }

  /**
   * Get adapter by protocol code
   */
  getAdapter(protocolCode: string): BaseProtocolAdapter<unknown> | undefined {
    return this.adapterMap.get(protocolCode);
  }

  /**
   * Get all registered protocol codes
   */
  getProtocolCodes(): string[] {
    return Array.from(this.adapterMap.keys());
  }

  /**
   * Get all selectable protocols.
   *
   * UNSUPPORTED protocols (stub adapters with no real cloud or edge I/O) are
   * excluded so they can never be chosen in the registration wizard
   * (SENSOR-CRITICAL-008). CLOUD_REAL and EDGE_DELEGATED protocols are
   * returned, each carrying its implementationStatus so the UI can badge
   * edge-only protocols honestly.
   */
  getAllProtocols(): ProtocolInfo[] {
    return this.adapters
      .map((adapter) => ({
        code: adapter.protocolCode,
        displayName: adapter.displayName,
        description: adapter.description,
        category: adapter.category,
        subcategory: adapter.subcategory,
        connectionType: adapter.connectionType,
        capabilities: adapter.getCapabilities(),
        implementationStatus: getProtocolImplementationStatus(adapter.protocolCode),
      }))
      .filter((p) => p.implementationStatus !== ProtocolImplementationStatus.UNSUPPORTED);
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
