import { Logger, BadRequestException } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { Tenant, CurrentUser, Roles, Role, CurrentUserPayload } from '@platform/backend-common';

import { PlcConnection, PlcConnectionStatus } from '../entities/plc-connection.entity';
import { FeedingParameter, ParameterStatus } from '../entities/feeding-parameter.entity';
import { PlcAlarm, AlarmSeverity, AlarmSource } from '../entities/plc-alarm.entity';
import { PlcTelemetry } from '../entities/plc-telemetry.entity';

import {
  CreatePlcConnectionDto,
  UpdatePlcConnectionDto,
  PlcConnectionFilterDto,
  PlcPaginationDto,
  PaginatedPlcConnectionsDto,
  PlcConnectionTestResultDto,
  PlcConnectionCountByStatusDto,
  CreateFeedingParameterDto,
  UpdateFeedingParameterDto,
  FeedingParameterFilterDto,
  PaginatedFeedingParametersDto,
  ParameterSendResultDto,
  PlcAlarmFilterDto,
  PaginatedPlcAlarmsDto,
  AcknowledgeAlarmDto,
  BulkAcknowledgeAlarmsDto,
  PlcAlarmStatsDto,
  AlarmCountBySeverityDto,
  AlarmCountBySourceDto,
  PlcTelemetryFilterDto,
  PaginatedPlcTelemetryDto,
  PlcTelemetryStatsDto,
  FeedingStatsDto,
  ActuatorUsageStatsDto,
  LatestTelemetrySummaryDto,
  TelemetryTimeRangeDto,
  DiscoveredEndpointDto,
  NodeBrowseResultDto,
  HistoricalDataPointDto,
  ReadHistoricalDataInputDto,
  CallMethodInputDto,
  MethodCallResultDto,
  WriteNodeInputDto,
} from '../dto';

import {
  PlcConnectionService,
  FeedingParameterService,
  PlcAlarmService,
  PlcTelemetryService,
} from '../services';

/**
 * PLC Control GraphQL Resolver
 *
 * Provides GraphQL API for PLC management operations including:
 * - PLC connection management
 * - Feeding parameter configuration
 * - Alarm monitoring and acknowledgment
 * - Telemetry data access
 *
 * All operations enforce tenant isolation via the @Tenant() decorator.
 */
@Resolver()
export class PlcControlResolver {
  private readonly logger = new Logger(PlcControlResolver.name);

  constructor(
    private readonly plcConnectionService: PlcConnectionService,
    private readonly feedingParameterService: FeedingParameterService,
    private readonly plcAlarmService: PlcAlarmService,
    private readonly plcTelemetryService: PlcTelemetryService,
  ) {}

  // ==================== PLC Connection Queries ====================

  /**
   * Get a single PLC connection by ID
   */
  @Query(() => PlcConnection, { name: 'plcConnection', nullable: true })
  async getPlcConnection(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<PlcConnection | null> {
    try {
      return await this.plcConnectionService.findById(id, tenantId);
    } catch {
      return null;
    }
  }

  /**
   * List all PLC connections with filtering and pagination
   */
  @Query(() => PaginatedPlcConnectionsDto, { name: 'plcConnections' })
  async listPlcConnections(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => PlcConnectionFilterDto, nullable: true })
    filter?: PlcConnectionFilterDto,
    @Args('pagination', { type: () => PlcPaginationDto, nullable: true })
    pagination?: PlcPaginationDto,
  ): Promise<PaginatedPlcConnectionsDto> {
    return this.plcConnectionService.findAll(tenantId, filter, pagination);
  }

  /**
   * Get PLC connections by site
   */
  @Query(() => [PlcConnection], { name: 'plcConnectionsBySite' })
  async getPlcConnectionsBySite(
    @Args('siteId', { type: () => ID }) siteId: string,
    @Tenant() tenantId: string,
  ): Promise<PlcConnection[]> {
    return this.plcConnectionService.findBySite(siteId, tenantId);
  }

  /**
   * Get PLC connection count by status
   */
  @Query(() => PlcConnectionCountByStatusDto, { name: 'plcConnectionCountByStatus' })
  async getPlcConnectionCountByStatus(
    @Tenant() tenantId: string,
  ): Promise<PlcConnectionCountByStatusDto> {
    const counts = await this.plcConnectionService.getCountByStatus(tenantId);
    return {
      online: counts[PlcConnectionStatus.ONLINE] || 0,
      offline: counts[PlcConnectionStatus.OFFLINE] || 0,
      connecting: counts[PlcConnectionStatus.CONNECTING] || 0,
      error: counts[PlcConnectionStatus.ERROR] || 0,
    };
  }

  /**
   * Get online PLC connections
   */
  @Query(() => [PlcConnection], { name: 'onlinePlcConnections' })
  async getOnlinePlcConnections(
    @Tenant() tenantId: string,
  ): Promise<PlcConnection[]> {
    return this.plcConnectionService.findOnline(tenantId);
  }

  // ==================== PLC Connection Mutations ====================

  /**
   * Create a new PLC connection
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => PlcConnection, { name: 'createPlcConnection' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createPlcConnection(
    @Args('input') input: CreatePlcConnectionDto,
    @Tenant() tenantId: string,
  ): Promise<PlcConnection> {
    this.logger.log(`Creating PLC connection: ${input.name}`);
    return this.plcConnectionService.create(input, tenantId);
  }

  /**
   * Update a PLC connection
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => PlcConnection, { name: 'updatePlcConnection' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updatePlcConnection(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdatePlcConnectionDto,
    @Tenant() tenantId: string,
  ): Promise<PlcConnection> {
    return this.plcConnectionService.update(id, tenantId, input);
  }

  /**
   * Delete a PLC connection
   * SECURITY: Requires TENANT_ADMIN role
   */
  @Mutation(() => Boolean, { name: 'deletePlcConnection' })
  @Roles(Role.TENANT_ADMIN)
  async deletePlcConnection(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting PLC connection: ${id}`);
    return this.plcConnectionService.delete(id, tenantId);
  }

  /**
   * Test PLC connection
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => PlcConnectionTestResultDto, { name: 'testPlcConnection' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async testPlcConnection(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<PlcConnectionTestResultDto> {
    this.logger.log(`Testing PLC connection: ${id}`);
    return this.plcConnectionService.testConnection(id, tenantId);
  }

  /**
   * Discover available endpoints on an OPC UA server
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Query(() => [DiscoveredEndpointDto], { name: 'discoverOpcUaEndpoints' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async discoverOpcUaEndpoints(
    @Args('endpointUrl', { type: () => String }) endpointUrl: string,
    @Tenant() tenantId: string,
  ): Promise<DiscoveredEndpointDto[]> {
    this.logger.log(`Discovering OPC UA endpoints at: ${endpointUrl}`);
    return this.plcConnectionService.discoverEndpoints(endpointUrl);
  }

  /**
   * Browse OPC UA server address space
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Query(() => [NodeBrowseResultDto], { name: 'browseOpcUaNodes' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async browseOpcUaNodes(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('parentNodeId', { type: () => String, nullable: true }) parentNodeId: string | undefined,
    @Tenant() tenantId: string,
  ): Promise<NodeBrowseResultDto[]> {
    this.logger.log(`Browsing OPC UA nodes for connection: ${plcConnectionId}`);
    return this.plcConnectionService.browseNodes(plcConnectionId, tenantId, parentNodeId);
  }

  /**
   * Activate a PLC connection
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => PlcConnection, { name: 'activatePlcConnection' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async activatePlcConnection(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<PlcConnection> {
    return this.plcConnectionService.activate(id, tenantId);
  }

  /**
   * Deactivate a PLC connection
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => PlcConnection, { name: 'deactivatePlcConnection' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deactivatePlcConnection(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<PlcConnection> {
    return this.plcConnectionService.deactivate(id, tenantId);
  }

  // ==================== Advanced OPC UA Operations ====================

  /**
   * Read historical data from OPC UA server (HDA)
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Query(() => [HistoricalDataPointDto], { name: 'readOpcUaHistoricalData' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async readOpcUaHistoricalData(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('input') input: ReadHistoricalDataInputDto,
    @Tenant() tenantId: string,
  ): Promise<HistoricalDataPointDto[]> {
    this.logger.log(`Reading historical data for connection: ${plcConnectionId}`);
    const results = await this.plcConnectionService.readHistoricalData(
      plcConnectionId,
      tenantId,
      input.nodeId,
      input.startTime,
      input.endTime,
      input.maxValues,
    );
    return results.map(r => ({
      timestamp: r.timestamp,
      value: r.value !== undefined ? JSON.stringify(r.value) : undefined,
    }));
  }

  /**
   * Call a method on OPC UA server
   * SECURITY: Requires TENANT_ADMIN role
   */
  @Mutation(() => MethodCallResultDto, { name: 'callOpcUaMethod' })
  @Roles(Role.TENANT_ADMIN)
  async callOpcUaMethod(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('input') input: CallMethodInputDto,
    @Tenant() tenantId: string,
  ): Promise<MethodCallResultDto> {
    this.logger.log(`Calling method ${input.methodId} on connection: ${plcConnectionId}`);
    const args = input.inputArguments?.map(a => {
      try {
        return { dataType: a.dataType, value: JSON.parse(a.value) };
      } catch {
        throw new BadRequestException(`Invalid JSON in method argument value: ${a.value.substring(0, 100)}`);
      }
    });
    const result = await this.plcConnectionService.callMethod(
      plcConnectionId,
      tenantId,
      input.objectId,
      input.methodId,
      args,
    );
    return {
      statusCode: result.statusCode,
      outputArguments: result.outputArguments.map(a => JSON.stringify(a)),
    };
  }

  /**
   * Write a value to an OPC UA node
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => Boolean, { name: 'writeOpcUaNode' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async writeOpcUaNode(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('input') input: WriteNodeInputDto,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Writing to node ${input.nodeId} on connection: ${plcConnectionId}`);
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(input.value);
    } catch {
      throw new BadRequestException(`Invalid JSON in write value: ${input.value.substring(0, 100)}`);
    }
    await this.plcConnectionService.writeNodeValue(
      plcConnectionId,
      tenantId,
      input.nodeId,
      parsedValue,
      input.dataType,
    );
    return true;
  }

  // ==================== Feeding Parameter Queries ====================

  /**
   * Get a single feeding parameter by ID
   */
  @Query(() => FeedingParameter, { name: 'feedingParameter', nullable: true })
  async getFeedingParameter(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<FeedingParameter | null> {
    try {
      return await this.feedingParameterService.findById(id, tenantId);
    } catch {
      return null;
    }
  }

  /**
   * List all feeding parameters with filtering and pagination
   */
  @Query(() => PaginatedFeedingParametersDto, { name: 'feedingParameters' })
  async listFeedingParameters(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => FeedingParameterFilterDto, nullable: true })
    filter?: FeedingParameterFilterDto,
    @Args('pagination', { type: () => PlcPaginationDto, nullable: true })
    pagination?: PlcPaginationDto,
  ): Promise<PaginatedFeedingParametersDto> {
    return this.feedingParameterService.findAll(tenantId, filter, pagination);
  }

  /**
   * Get active feeding parameter for a PLC connection
   */
  @Query(() => FeedingParameter, { name: 'activeFeedingParameter', nullable: true })
  async getActiveFeedingParameter(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Tenant() tenantId: string,
  ): Promise<FeedingParameter | null> {
    return this.feedingParameterService.findActiveForConnection(plcConnectionId, tenantId);
  }

  /**
   * Get feeding parameter history for a PLC connection
   */
  @Query(() => [FeedingParameter], { name: 'feedingParameterHistory' })
  async getFeedingParameterHistory(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Tenant() tenantId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 10 }) limit?: number,
  ): Promise<FeedingParameter[]> {
    return this.feedingParameterService.findHistoryForConnection(
      plcConnectionId,
      tenantId,
      limit,
    );
  }

  // ==================== Feeding Parameter Mutations ====================

  /**
   * Create a new feeding parameter set
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => FeedingParameter, { name: 'createFeedingParameter' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createFeedingParameter(
    @Args('input') input: CreateFeedingParameterDto,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<FeedingParameter> {
    this.logger.log(`Creating feeding parameter: ${input.name}`);
    return this.feedingParameterService.create(input, tenantId, userId);
  }

  /**
   * Update a feeding parameter set
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => FeedingParameter, { name: 'updateFeedingParameter' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateFeedingParameter(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateFeedingParameterDto,
    @Tenant() tenantId: string,
  ): Promise<FeedingParameter> {
    return this.feedingParameterService.update(id, tenantId, input);
  }

  /**
   * Delete a feeding parameter set
   * SECURITY: Requires TENANT_ADMIN role
   */
  @Mutation(() => Boolean, { name: 'deleteFeedingParameter' })
  @Roles(Role.TENANT_ADMIN)
  async deleteFeedingParameter(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting feeding parameter: ${id}`);
    return this.feedingParameterService.delete(id, tenantId);
  }

  /**
   * Send feeding parameters to PLC
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => ParameterSendResultDto, { name: 'sendFeedingParameterToPlc' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async sendFeedingParameterToPlc(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<ParameterSendResultDto> {
    this.logger.log(`Sending feeding parameter ${id} to PLC`);
    return this.feedingParameterService.sendToPlc(id, tenantId);
  }

  /**
   * Activate a feeding parameter set
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => FeedingParameter, { name: 'activateFeedingParameter' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async activateFeedingParameter(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<FeedingParameter> {
    this.logger.log(`Activating feeding parameter: ${id}`);
    return this.feedingParameterService.activate(id, tenantId);
  }

  /**
   * Clone a feeding parameter set
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => FeedingParameter, { name: 'cloneFeedingParameter' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async cloneFeedingParameter(
    @Args('id', { type: () => ID }) id: string,
    @Args('newName', { type: () => String, nullable: true }) newName: string | undefined,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<FeedingParameter> {
    this.logger.log(`Cloning feeding parameter: ${id}`);
    return this.feedingParameterService.clone(id, tenantId, newName, userId);
  }

  // ==================== Alarm Queries ====================

  /**
   * Get a single alarm by ID
   */
  @Query(() => PlcAlarm, { name: 'plcAlarm', nullable: true })
  async getPlcAlarm(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<PlcAlarm | null> {
    try {
      return await this.plcAlarmService.findById(id, tenantId);
    } catch {
      return null;
    }
  }

  /**
   * List all alarms with filtering and pagination
   */
  @Query(() => PaginatedPlcAlarmsDto, { name: 'plcAlarms' })
  async listPlcAlarms(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => PlcAlarmFilterDto, nullable: true })
    filter?: PlcAlarmFilterDto,
    @Args('pagination', { type: () => PlcPaginationDto, nullable: true })
    pagination?: PlcPaginationDto,
  ): Promise<PaginatedPlcAlarmsDto> {
    return this.plcAlarmService.findAll(tenantId, filter, pagination);
  }

  /**
   * Get active (uncleared) alarms
   */
  @Query(() => [PlcAlarm], { name: 'activePlcAlarms' })
  async getActivePlcAlarms(
    @Tenant() tenantId: string,
    @Args('plcConnectionId', { type: () => ID, nullable: true }) plcConnectionId?: string,
  ): Promise<PlcAlarm[]> {
    return this.plcAlarmService.findActive(tenantId, plcConnectionId);
  }

  /**
   * Get unacknowledged alarms
   */
  @Query(() => [PlcAlarm], { name: 'unacknowledgedPlcAlarms' })
  async getUnacknowledgedPlcAlarms(
    @Tenant() tenantId: string,
    @Args('plcConnectionId', { type: () => ID, nullable: true }) plcConnectionId?: string,
  ): Promise<PlcAlarm[]> {
    return this.plcAlarmService.findUnacknowledged(tenantId, plcConnectionId);
  }

  /**
   * Get recent alarms
   */
  @Query(() => [PlcAlarm], { name: 'recentPlcAlarms' })
  async getRecentPlcAlarms(
    @Tenant() tenantId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 10 }) limit?: number,
    @Args('plcConnectionId', { type: () => ID, nullable: true }) plcConnectionId?: string,
  ): Promise<PlcAlarm[]> {
    return this.plcAlarmService.findRecent(tenantId, limit, plcConnectionId);
  }

  /**
   * Get alarm statistics
   */
  @Query(() => PlcAlarmStatsDto, { name: 'plcAlarmStats' })
  async getPlcAlarmStats(
    @Tenant() tenantId: string,
    @Args('plcConnectionId', { type: () => ID, nullable: true }) plcConnectionId?: string,
  ): Promise<PlcAlarmStatsDto> {
    return this.plcAlarmService.getStats(tenantId, plcConnectionId);
  }

  /**
   * Get alarm count by severity
   */
  @Query(() => AlarmCountBySeverityDto, { name: 'alarmCountBySeverity' })
  async getAlarmCountBySeverity(
    @Tenant() tenantId: string,
    @Args('plcConnectionId', { type: () => ID, nullable: true }) plcConnectionId?: string,
  ): Promise<AlarmCountBySeverityDto> {
    return this.plcAlarmService.getCountBySeverity(tenantId, plcConnectionId);
  }

  /**
   * Get alarm count by source
   */
  @Query(() => [AlarmCountBySourceDto], { name: 'alarmCountBySource' })
  async getAlarmCountBySource(
    @Tenant() tenantId: string,
    @Args('plcConnectionId', { type: () => ID, nullable: true }) plcConnectionId?: string,
  ): Promise<AlarmCountBySourceDto[]> {
    return this.plcAlarmService.getCountBySource(tenantId, plcConnectionId);
  }

  // ==================== Alarm Mutations ====================

  /**
   * Acknowledge an alarm
   * SECURITY: Requires TENANT_ADMIN, MODULE_MANAGER, or OPERATOR role
   */
  @Mutation(() => PlcAlarm, { name: 'acknowledgePlcAlarm' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async acknowledgePlcAlarm(
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { type: () => AcknowledgeAlarmDto, nullable: true }) input: AcknowledgeAlarmDto | undefined,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<PlcAlarm> {
    this.logger.log(`Acknowledging alarm ${id} by user ${userId}`);
    return this.plcAlarmService.acknowledge(id, tenantId, userId, input?.notes);
  }

  /**
   * Bulk acknowledge alarms
   * SECURITY: Requires TENANT_ADMIN, MODULE_MANAGER, or OPERATOR role
   */
  @Mutation(() => Int, { name: 'bulkAcknowledgePlcAlarms' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async bulkAcknowledgePlcAlarms(
    @Args('input') input: BulkAcknowledgeAlarmsDto,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<number> {
    this.logger.log(`Bulk acknowledging ${input.alarmIds.length} alarms by user ${userId}`);
    return this.plcAlarmService.bulkAcknowledge(
      input.alarmIds,
      tenantId,
      userId,
      input.notes,
    );
  }

  /**
   * Acknowledge all alarms for a PLC connection
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => Int, { name: 'acknowledgeAllAlarmsForConnection' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async acknowledgeAllAlarmsForConnection(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('notes', { type: () => String, nullable: true }) notes: string | undefined,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<number> {
    this.logger.log(`Acknowledging all alarms for PLC ${plcConnectionId} by user ${userId}`);
    return this.plcAlarmService.acknowledgeAllForConnection(
      plcConnectionId,
      tenantId,
      userId,
      notes,
    );
  }

  /**
   * Add notes to an alarm
   * SECURITY: Requires TENANT_ADMIN, MODULE_MANAGER, or OPERATOR role
   */
  @Mutation(() => PlcAlarm, { name: 'addAlarmNotes' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async addAlarmNotes(
    @Args('id', { type: () => ID }) id: string,
    @Args('notes', { type: () => String }) notes: string,
    @Tenant() tenantId: string,
  ): Promise<PlcAlarm> {
    return this.plcAlarmService.addNotes(id, tenantId, notes);
  }

  /**
   * Approve an alarm at a specific approval level
   * SECURITY: Requires TENANT_ADMIN, MODULE_MANAGER, or MODULE_USER role
   */
  @Mutation(() => PlcAlarm, { name: 'approvePlcAlarm' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async approvePlcAlarm(
    @Args('id', { type: () => ID }) id: string,
    @Args('level', { type: () => Int }) level: number,
    @Args('notes', { type: () => String, nullable: true }) notes: string | undefined,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PlcAlarm> {
    const userId = user.sub;

    // Map platform role to maximum allowed approval level
    const userRoles = user.roles || [];
    let maxAllowedLevel = 1; // MODULE_USER = operator level
    if (userRoles.includes(Role.MODULE_MANAGER)) maxAllowedLevel = 2;
    if (userRoles.includes(Role.TENANT_ADMIN) || userRoles.includes(Role.SUPER_ADMIN)) maxAllowedLevel = 3;
    if (level > maxAllowedLevel) {
      throw new Error(`Your role allows approval up to level ${maxAllowedLevel}`);
    }

    this.logger.log(`Approving alarm ${id} at level ${level} by user ${userId}`);
    return this.plcAlarmService.approveAlarm(tenantId, id, userId, level, notes);
  }

  /**
   * Escalate an alarm to the next required approval level
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER role
   */
  @Mutation(() => PlcAlarm, { name: 'escalatePlcAlarm' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async escalatePlcAlarm(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<PlcAlarm> {
    this.logger.log(`Escalating alarm ${id}`);
    return this.plcAlarmService.escalateAlarm(tenantId, id);
  }

  /**
   * Delete old alarms (data retention)
   * SECURITY: Requires TENANT_ADMIN role
   */
  @Mutation(() => Int, { name: 'deleteOldPlcAlarms' })
  @Roles(Role.TENANT_ADMIN)
  async deleteOldPlcAlarms(
    @Args('olderThan') olderThan: Date,
    @Tenant() tenantId: string,
  ): Promise<number> {
    this.logger.log(`Deleting alarms older than ${olderThan.toISOString()}`);
    return this.plcAlarmService.deleteOldAlarms(tenantId, olderThan);
  }

  // ==================== Telemetry Queries ====================

  /**
   * Get latest telemetry for a PLC connection
   */
  @Query(() => PlcTelemetry, { name: 'latestPlcTelemetry', nullable: true })
  async getLatestPlcTelemetry(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Tenant() tenantId: string,
  ): Promise<PlcTelemetry | null> {
    return this.plcTelemetryService.getLatest(plcConnectionId, tenantId);
  }

  /**
   * Get latest telemetry summary
   */
  @Query(() => LatestTelemetrySummaryDto, { name: 'latestTelemetrySummary', nullable: true })
  async getLatestTelemetrySummary(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Tenant() tenantId: string,
  ): Promise<LatestTelemetrySummaryDto | null> {
    return this.plcTelemetryService.getLatestSummary(plcConnectionId, tenantId);
  }

  /**
   * Get telemetry data with filtering
   */
  @Query(() => PaginatedPlcTelemetryDto, { name: 'plcTelemetry' })
  async getPlcTelemetry(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => PlcTelemetryFilterDto, nullable: true })
    filter?: PlcTelemetryFilterDto,
  ): Promise<PaginatedPlcTelemetryDto> {
    return this.plcTelemetryService.findAll(tenantId, filter);
  }

  /**
   * Get telemetry within time range
   */
  @Query(() => [PlcTelemetry], { name: 'plcTelemetryByTimeRange' })
  async getPlcTelemetryByTimeRange(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('timeRange') timeRange: TelemetryTimeRangeDto,
    @Tenant() tenantId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 1000 }) limit?: number,
  ): Promise<PlcTelemetry[]> {
    return this.plcTelemetryService.findByTimeRange(
      plcConnectionId,
      tenantId,
      timeRange,
      limit,
    );
  }

  /**
   * Get telemetry statistics
   */
  @Query(() => PlcTelemetryStatsDto, { name: 'plcTelemetryStats' })
  async getPlcTelemetryStats(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('timeRange') timeRange: TelemetryTimeRangeDto,
    @Tenant() tenantId: string,
  ): Promise<PlcTelemetryStatsDto> {
    return this.plcTelemetryService.getStats(plcConnectionId, tenantId, timeRange);
  }

  /**
   * Get feeding statistics from telemetry
   */
  @Query(() => FeedingStatsDto, { name: 'feedingStats' })
  async getFeedingStats(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('timeRange') timeRange: TelemetryTimeRangeDto,
    @Tenant() tenantId: string,
  ): Promise<FeedingStatsDto> {
    return this.plcTelemetryService.getFeedingStats(plcConnectionId, tenantId, timeRange);
  }

  /**
   * Get actuator usage statistics
   */
  @Query(() => ActuatorUsageStatsDto, { name: 'actuatorUsageStats' })
  async getActuatorUsageStats(
    @Args('plcConnectionId', { type: () => ID }) plcConnectionId: string,
    @Args('timeRange') timeRange: TelemetryTimeRangeDto,
    @Tenant() tenantId: string,
  ): Promise<ActuatorUsageStatsDto> {
    return this.plcTelemetryService.getActuatorUsageStats(plcConnectionId, tenantId, timeRange);
  }

  /**
   * Get latest telemetry for all connections
   */
  @Query(() => [LatestTelemetrySummaryDto], { name: 'allConnectionsTelemetrySummary' })
  async getAllConnectionsTelemetrySummary(
    @Tenant() tenantId: string,
  ): Promise<LatestTelemetrySummaryDto[]> {
    return this.plcTelemetryService.getLatestForAllConnections(tenantId);
  }

  /**
   * Delete old telemetry data (data retention)
   * SECURITY: Requires TENANT_ADMIN role
   */
  @Mutation(() => Int, { name: 'deleteOldPlcTelemetry' })
  @Roles(Role.TENANT_ADMIN)
  async deleteOldPlcTelemetry(
    @Args('olderThan') olderThan: Date,
    @Tenant() tenantId: string,
  ): Promise<number> {
    this.logger.log(`Deleting telemetry older than ${olderThan.toISOString()}`);
    return this.plcTelemetryService.deleteOldTelemetry(tenantId, olderThan);
  }
}

/**
 * PLC Connection Field Resolver
 * Provides field resolvers for the PlcConnection entity
 */
@Resolver(() => PlcConnection)
export class PlcConnectionResolver {
  constructor(
    private readonly feedingParameterService: FeedingParameterService,
    private readonly plcAlarmService: PlcAlarmService,
    private readonly plcTelemetryService: PlcTelemetryService,
  ) {}

  /**
   * Resolve active feeding parameter for a connection
   */
  @ResolveField(() => FeedingParameter, { name: 'activeParameter', nullable: true })
  async resolveActiveParameter(
    @Parent() connection: PlcConnection,
  ): Promise<FeedingParameter | null> {
    return this.feedingParameterService.findActiveForConnection(
      connection.id,
      connection.tenantId,
    );
  }

  /**
   * Resolve active alarm count for a connection
   */
  @ResolveField(() => Int, { name: 'activeAlarmCount' })
  async resolveActiveAlarmCount(
    @Parent() connection: PlcConnection,
  ): Promise<number> {
    const alarms = await this.plcAlarmService.findActive(
      connection.tenantId,
      connection.id,
    );
    return alarms.length;
  }

  /**
   * Resolve latest telemetry summary for a connection
   */
  @ResolveField(() => LatestTelemetrySummaryDto, { name: 'latestTelemetry', nullable: true })
  async resolveLatestTelemetry(
    @Parent() connection: PlcConnection,
  ): Promise<LatestTelemetrySummaryDto | null> {
    return this.plcTelemetryService.getLatestSummary(
      connection.id,
      connection.tenantId,
    );
  }
}

/**
 * Feeding Parameter Field Resolver
 * Provides field resolvers for the FeedingParameter entity
 */
@Resolver(() => FeedingParameter)
export class FeedingParameterResolver {
  constructor(
    private readonly plcConnectionService: PlcConnectionService,
  ) {}

  /**
   * Resolve PLC connection for a feeding parameter
   */
  @ResolveField(() => PlcConnection, { name: 'connection', nullable: true })
  async resolveConnection(
    @Parent() parameter: FeedingParameter,
  ): Promise<PlcConnection | null> {
    try {
      return await this.plcConnectionService.findById(
        parameter.plcConnectionId,
        parameter.tenantId,
      );
    } catch {
      return null;
    }
  }
}
