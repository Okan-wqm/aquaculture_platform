import * as net from 'net';

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common';

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
import { OpcUaAdapter } from '../../protocol/adapters/industrial/opcua.adapter';
import { buildOpcUaConfig } from './opcua-config.builder';

export type PaginatedPlcConnections = IStandardPaginatedResult<PlcConnection>;

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
    private readonly opcUaAdapter: OpcUaAdapter,
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
    this.validateAuthConfiguration(
      input.authMode,
      input.username,
      input.password,
      input.clientCertificate,
      input.clientPrivateKey,
    );

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

    // Apply sorting — whitelist allowed columns to prevent SQL injection
    const allowedSortColumns = ['name', 'status', 'endpointUrl', 'createdAt', 'updatedAt', 'lastConnectedAt'];
    const sortBy = allowedSortColumns.includes(pagination?.sortBy || '') ? pagination!.sortBy! : 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';
    queryBuilder.orderBy(`plc.${sortBy}`, sortOrder);

    // Get total count and items
    const [items, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return createStandardPaginatedResult(items, total, page, limit);
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
        input.clientCertificate || connection.clientCertificate,
        input.clientPrivateKey || connection.clientPrivateKey,
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
   * Test connection to PLC using real OPC UA adapter
   */
  async testConnection(
    id: string,
    tenantId: string,
  ): Promise<PlcConnectionTestResultDto> {
    const connection = await this.findById(id, tenantId);
    const startTime = Date.now();

    this.logger.log(`Testing connection to PLC: ${connection.name} (${connection.endpointUrl})`);

    try {
      const config = buildOpcUaConfig(connection);
      const result = await this.opcUaAdapter.testConnection(config as unknown as Record<string, unknown>);
      const latencyMs = Date.now() - startTime;

      if (result.success) {
        await this.updateStatus(id, tenantId, PlcConnectionStatus.ONLINE);

        const serverInfo = result.diagnostics
          ? JSON.stringify(result.diagnostics)
          : `OPC UA Server at ${connection.endpointUrl}`;

        return {
          success: true,
          latencyMs: result.latencyMs || latencyMs,
          serverInfo,
          testedAt: new Date(),
        };
      } else {
        await this.updateStatus(id, tenantId, PlcConnectionStatus.ERROR, result.error);

        return {
          success: false,
          latencyMs: result.latencyMs || latencyMs,
          error: result.error || 'Connection test failed',
          errorCode: 'CONNECTION_FAILED',
          testedAt: new Date(),
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.updateStatus(id, tenantId, PlcConnectionStatus.ERROR, errorMessage);

      return {
        success: false,
        latencyMs: Date.now() - startTime,
        error: errorMessage,
        errorCode: 'CONNECTION_ERROR',
        testedAt: new Date(),
      };
    }
  }

  /**
   * Discover available endpoints on an OPC UA server
   */
  async discoverEndpoints(endpointUrl: string): Promise<{
    endpointUrl: string;
    securityMode: string;
    securityPolicy: string;
    securityLevel: number;
    serverCertificate?: string;
    transportProfileUri?: string;
  }[]> {
    this.logger.log(`Discovering endpoints at: ${endpointUrl}`);
    this.validateEndpointUrl(endpointUrl);

    try {
      return await this.opcUaAdapter.discoverEndpoints(endpointUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Endpoint discovery failed for ${endpointUrl}: ${msg}`);
      throw new BadRequestException(`Failed to discover endpoints: ${msg}`);
    }
  }

  /**
   * Browse OPC UA server address space
   */
  async browseNodes(
    id: string,
    tenantId: string,
    parentNodeId?: string,
  ): Promise<{
    nodeId: string;
    browseName: string;
    displayName: string;
    nodeClass: string;
    dataType?: string;
    hasChildren: boolean;
    description?: string;
    value?: string;
  }[]> {
    const connection = await this.findById(id, tenantId);

    if (connection.status !== PlcConnectionStatus.ONLINE) {
      throw new BadRequestException('PLC connection must be online to browse nodes');
    }

    this.logger.log(`Browsing nodes on ${connection.name}, parent: ${parentNodeId || 'RootFolder'}`);

    const config = buildOpcUaConfig(connection);
    let handle;

    try {
      handle = await this.opcUaAdapter.connect(config as unknown as Record<string, unknown>);
      const results = await this.opcUaAdapter.browseNodes(handle, parentNodeId);
      return results;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Node browsing failed: ${msg}`);
      throw new BadRequestException(`Failed to browse nodes: ${msg}`);
    } finally {
      if (handle) {
        try { await this.opcUaAdapter.disconnect(handle); } catch { /* ignore */ }
      }
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
   * Validate OPC UA endpoint URL.
   * Blocks private/loopback IP addresses to prevent SSRF.
   * Note: only numeric IPs are blocked here; hostname-to-IP resolution
   * would require async DNS lookup and is deferred to network policy.
   */
  private validateEndpointUrl(url: string): void {
    if (!url.startsWith('opc.tcp://')) {
      throw new BadRequestException(
        'Invalid OPC UA endpoint URL. Must start with opc.tcp://',
      );
    }
    const withoutScheme = url.slice('opc.tcp://'.length);
    const hostname = (withoutScheme.split('/')[0] ?? '').split(':')[0] ?? '';
    if (this.isPrivateAddress(hostname)) {
      throw new ForbiddenException('Private network endpoints are not allowed');
    }
  }

  /**
   * Returns true if the host is a private/loopback/link-local address.
   * Covers: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7.
   */
  private isPrivateAddress(host: string): boolean {
    if (host === 'localhost') return true;
    if (net.isIPv4(host)) {
      const parts = host.split('.').map(Number);
      const [p0 = 0, p1 = 0] = parts;
      return (
        p0 === 10 ||
        p0 === 127 ||
        (p0 === 172 && p1 >= 16 && p1 <= 31) ||
        (p0 === 192 && p1 === 168) ||
        (p0 === 169 && p1 === 254)
      );
    }
    if (net.isIPv6(host)) {
      const lower = host.toLowerCase();
      return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd');
    }
    return false;
  }

  /**
   * Validate authentication configuration
   */
  private validateAuthConfiguration(
    authMode?: PlcAuthMode,
    username?: string,
    password?: string,
    clientCertificate?: string,
    clientPrivateKey?: string,
  ): void {
    if (authMode === PlcAuthMode.USERNAME) {
      if (!username || !password) {
        throw new BadRequestException(
          'Username and password are required for Username authentication mode',
        );
      }
    }
    if (authMode === PlcAuthMode.CERTIFICATE) {
      if (!clientCertificate || !clientPrivateKey) {
        throw new BadRequestException(
          'Client certificate and private key are required for Certificate authentication mode',
        );
      }
    }
  }

  // ==================== Advanced OPC UA Operations ====================

  /**
   * Read historical data from OPC UA server (HDA)
   */
  async readHistoricalData(
    id: string,
    tenantId: string,
    nodeId: string,
    startTime: Date,
    endTime: Date,
    maxValues?: number,
  ): Promise<{ timestamp: Date; value: unknown }[]> {
    const connection = await this.findById(id, tenantId);

    if (connection.status !== PlcConnectionStatus.ONLINE) {
      throw new BadRequestException('PLC connection must be online to read historical data');
    }

    this.logger.log(`Reading historical data from ${connection.name}, node: ${nodeId}`);

    const config = buildOpcUaConfig(connection);
    let handle;

    try {
      handle = await this.opcUaAdapter.connect(config as unknown as Record<string, unknown>);
      return await this.opcUaAdapter.readHistoricalData(handle, nodeId, startTime, endTime, maxValues);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Historical data read failed: ${msg}`);
      throw new BadRequestException(`Failed to read historical data: ${msg}`);
    } finally {
      if (handle) {
        try { await this.opcUaAdapter.disconnect(handle); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Call a method on OPC UA server
   */
  async callMethod(
    id: string,
    tenantId: string,
    objectId: string,
    methodId: string,
    inputArguments?: { dataType: string; value: unknown }[],
  ): Promise<{ statusCode: number; outputArguments: unknown[] }> {
    const connection = await this.findById(id, tenantId);

    if (connection.status !== PlcConnectionStatus.ONLINE) {
      throw new BadRequestException('PLC connection must be online to call methods');
    }

    this.logger.log(`Calling method ${methodId} on ${connection.name}`);

    const config = buildOpcUaConfig(connection);
    let handle;

    try {
      handle = await this.opcUaAdapter.connect(config as unknown as Record<string, unknown>);
      return await this.opcUaAdapter.callMethod(handle, objectId, methodId, inputArguments);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Method call failed: ${msg}`);
      throw new BadRequestException(`Failed to call method: ${msg}`);
    } finally {
      if (handle) {
        try { await this.opcUaAdapter.disconnect(handle); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Write a value to an OPC UA node
   */
  async writeNodeValue(
    id: string,
    tenantId: string,
    nodeId: string,
    value: unknown,
    dataType?: string,
  ): Promise<void> {
    const connection = await this.findById(id, tenantId);

    if (connection.status !== PlcConnectionStatus.ONLINE) {
      throw new BadRequestException('PLC connection must be online to write values');
    }

    this.logger.log(`Writing value to node ${nodeId} on ${connection.name}`);

    const config = buildOpcUaConfig(connection);
    let handle;

    try {
      handle = await this.opcUaAdapter.connect(config as unknown as Record<string, unknown>);
      await this.opcUaAdapter.writeData(handle, nodeId, value, dataType);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Write failed: ${msg}`);
      throw new BadRequestException(`Failed to write to node: ${msg}`);
    } finally {
      if (handle) {
        try { await this.opcUaAdapter.disconnect(handle); } catch { /* ignore */ }
      }
    }
  }
}
