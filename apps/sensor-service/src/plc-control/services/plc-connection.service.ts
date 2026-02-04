import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  PlcConnection,
  PlcConnectionStatus,
  PlcSecurityMode,
  PlcAuthMode,
} from '../entities/plc-connection.entity';
import {
  CreatePlcConnectionDto,
  UpdatePlcConnectionDto,
  PlcConnectionFilterDto,
  PlcPaginationDto,
  PlcConnectionTestResultDto,
} from '../dto';

/**
 * Result interface for paginated PLC connections
 */
export interface PaginatedPlcConnections {
  items: PlcConnection[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Status count result interface
 */
interface StatusCountResult {
  status: string;
  count: string;
}

/**
 * PLC Connection Service
 * Handles CRUD operations for PLC connections with tenant isolation
 */
@Injectable()
export class PlcConnectionService {
  private readonly logger = new Logger(PlcConnectionService.name);

  constructor(
    @InjectRepository(PlcConnection)
    private readonly plcConnectionRepository: Repository<PlcConnection>,
  ) {}

  /**
   * Create a new PLC connection
   */
  async create(
    input: CreatePlcConnectionDto,
    tenantId: string,
  ): Promise<PlcConnection> {
    this.logger.log(`Creating PLC connection: ${input.name} for tenant ${tenantId}`);

    // Validate endpoint URL format
    this.validateEndpointUrl(input.endpointUrl);

    // Validate authentication configuration
    this.validateAuthConfiguration(input.authMode, input.username, input.password);

    const connection = this.plcConnectionRepository.create({
      ...input,
      tenantId,
      status: PlcConnectionStatus.OFFLINE,
      securityMode: input.securityMode || PlcSecurityMode.NONE,
      authMode: input.authMode || PlcAuthMode.ANONYMOUS,
      publishingIntervalMs: input.publishingIntervalMs || 1000,
      samplingIntervalMs: input.samplingIntervalMs || 500,
      sessionTimeoutMs: input.sessionTimeoutMs || 60000,
      isActive: true,
    });

    const savedConnection = await this.plcConnectionRepository.save(connection);
    this.logger.log(`PLC connection created with ID: ${savedConnection.id}`);

    return savedConnection;
  }

  /**
   * Find a PLC connection by ID with tenant isolation
   */
  async findById(id: string, tenantId: string): Promise<PlcConnection> {
    const connection = await this.plcConnectionRepository.findOne({
      where: { id, tenantId },
    });

    if (!connection) {
      throw new NotFoundException(`PLC connection with ID ${id} not found`);
    }

    return connection;
  }

  /**
   * Find all PLC connections with filtering and pagination
   */
  async findAll(
    tenantId: string,
    filter?: PlcConnectionFilterDto,
    pagination?: PlcPaginationDto,
  ): Promise<PaginatedPlcConnections> {
    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.plcConnectionRepository
      .createQueryBuilder('plc')
      .where('plc.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter?.status) {
      queryBuilder.andWhere('plc.status = :status', { status: filter.status });
    }

    if (filter?.siteId) {
      queryBuilder.andWhere('plc.siteId = :siteId', { siteId: filter.siteId });
    }

    if (filter?.tankId) {
      queryBuilder.andWhere('plc.tankId = :tankId', { tankId: filter.tankId });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('plc.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(plc.name ILIKE :search OR plc.description ILIKE :search OR plc.endpointUrl ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    // Apply sorting
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';
    queryBuilder.orderBy(`plc.${sortBy}`, sortOrder);

    // Get total count and items
    const [items, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update a PLC connection
   */
  async update(
    id: string,
    tenantId: string,
    input: UpdatePlcConnectionDto,
  ): Promise<PlcConnection> {
    const connection = await this.findById(id, tenantId);

    // Validate endpoint URL if being updated
    if (input.endpointUrl) {
      this.validateEndpointUrl(input.endpointUrl);
    }

    // Validate authentication configuration if being updated
    if (input.authMode) {
      this.validateAuthConfiguration(
        input.authMode,
        input.username || connection.username,
        input.password || connection.password,
      );
    }

    // Update fields
    Object.assign(connection, input);
    connection.updatedAt = new Date();

    const updatedConnection = await this.plcConnectionRepository.save(connection);
    this.logger.log(`PLC connection ${id} updated`);

    return updatedConnection;
  }

  /**
   * Delete a PLC connection
   */
  async delete(id: string, tenantId: string): Promise<boolean> {
    const connection = await this.findById(id, tenantId);

    // Check if connection is online - prevent deletion of active connections
    if (connection.status === PlcConnectionStatus.ONLINE) {
      throw new BadRequestException(
        'Cannot delete an online PLC connection. Please disconnect first.',
      );
    }

    await this.plcConnectionRepository.remove(connection);
    this.logger.log(`PLC connection ${id} deleted`);

    return true;
  }

  /**
   * Update connection status
   */
  async updateStatus(
    id: string,
    tenantId: string,
    status: PlcConnectionStatus,
    error?: string,
  ): Promise<PlcConnection> {
    const connection = await this.findById(id, tenantId);
    connection.status = status;
    connection.updatedAt = new Date();

    if (status === PlcConnectionStatus.ONLINE) {
      connection.lastConnectedAt = new Date();
      connection.lastError = undefined;
    } else if (status === PlcConnectionStatus.ERROR && error) {
      connection.lastError = error;
    }

    return this.plcConnectionRepository.save(connection);
  }

  /**
   * Activate a PLC connection
   */
  async activate(id: string, tenantId: string): Promise<PlcConnection> {
    const connection = await this.findById(id, tenantId);

    if (connection.isActive) {
      return connection;
    }

    connection.isActive = true;
    connection.updatedAt = new Date();

    return this.plcConnectionRepository.save(connection);
  }

  /**
   * Deactivate a PLC connection
   */
  async deactivate(id: string, tenantId: string): Promise<PlcConnection> {
    const connection = await this.findById(id, tenantId);

    if (!connection.isActive) {
      return connection;
    }

    connection.isActive = false;
    connection.status = PlcConnectionStatus.OFFLINE;
    connection.updatedAt = new Date();

    return this.plcConnectionRepository.save(connection);
  }

  /**
   * Test connection to PLC
   * Note: Actual OPC UA connection testing would be implemented here
   */
  async testConnection(
    id: string,
    tenantId: string,
  ): Promise<PlcConnectionTestResultDto> {
    const connection = await this.findById(id, tenantId);
    const startTime = Date.now();

    this.logger.log(`Testing connection to PLC: ${connection.name} (${connection.endpointUrl})`);

    try {
      // TODO: Implement actual OPC UA connection test
      // For now, return a simulated result
      // In production, this would use node-opcua to connect and verify

      // Simulate connection test
      await this.simulateConnectionTest(connection);

      const latencyMs = Date.now() - startTime;

      // Update connection status on successful test
      await this.updateStatus(id, tenantId, PlcConnectionStatus.ONLINE);

      return {
        success: true,
        latencyMs,
        serverInfo: `OPC UA Server at ${connection.endpointUrl}`,
        testedAt: new Date(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Update connection status on failed test
      await this.updateStatus(id, tenantId, PlcConnectionStatus.ERROR, errorMessage);

      return {
        success: false,
        error: errorMessage,
        errorCode: 'CONNECTION_FAILED',
        testedAt: new Date(),
      };
    }
  }

  /**
   * Get connection count by status
   */
  async getCountByStatus(
    tenantId: string,
  ): Promise<Record<PlcConnectionStatus, number>> {
    const counts = await this.plcConnectionRepository
      .createQueryBuilder('plc')
      .select('plc.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('plc.tenantId = :tenantId', { tenantId })
      .groupBy('plc.status')
      .getRawMany<StatusCountResult>();

    const result: Record<string, number> = {};
    for (const status of Object.values(PlcConnectionStatus)) {
      result[status] = 0;
    }
    for (const row of counts) {
      result[row.status] = parseInt(row.count, 10);
    }

    return result as Record<PlcConnectionStatus, number>;
  }

  /**
   * Get connections by site
   */
  async findBySite(siteId: string, tenantId: string): Promise<PlcConnection[]> {
    return this.plcConnectionRepository.find({
      where: { siteId, tenantId },
      order: { name: 'ASC' },
    });
  }

  /**
   * Get connections by tank
   */
  async findByTank(tankId: string, tenantId: string): Promise<PlcConnection[]> {
    return this.plcConnectionRepository.find({
      where: { tankId, tenantId },
      order: { name: 'ASC' },
    });
  }

  /**
   * Get online connections for a tenant
   */
  async findOnline(tenantId: string): Promise<PlcConnection[]> {
    return this.plcConnectionRepository.find({
      where: {
        tenantId,
        status: PlcConnectionStatus.ONLINE,
        isActive: true,
      },
      order: { name: 'ASC' },
    });
  }

  /**
   * Validate OPC UA endpoint URL
   */
  private validateEndpointUrl(url: string): void {
    if (!url.startsWith('opc.tcp://')) {
      throw new BadRequestException(
        'Invalid OPC UA endpoint URL. Must start with opc.tcp://',
      );
    }
  }

  /**
   * Validate authentication configuration
   */
  private validateAuthConfiguration(
    authMode?: PlcAuthMode,
    username?: string,
    password?: string,
  ): void {
    if (authMode === PlcAuthMode.USERNAME) {
      if (!username || !password) {
        throw new BadRequestException(
          'Username and password are required for Username authentication mode',
        );
      }
    }
  }

  /**
   * Simulate connection test (placeholder for actual OPC UA implementation)
   */
  private async simulateConnectionTest(connection: PlcConnection): Promise<void> {
    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Validate URL is reachable (basic check)
    if (!connection.endpointUrl.includes('://')) {
      throw new Error('Invalid endpoint URL format');
    }

    // In production, this would:
    // 1. Create OPC UA client
    // 2. Connect to endpoint
    // 3. Browse server namespace
    // 4. Disconnect
  }
}
