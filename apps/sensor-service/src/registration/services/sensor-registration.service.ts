import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, FindOptionsWhere, DataSource } from 'typeorm';

import { Sensor, SensorType, SensorRegistrationStatus, SensorRole } from '../../database/entities/sensor.entity';
import { ConnectionTesterService, ExtendedTestResult } from '../../protocol/services/connection-tester.service';
import { ProtocolRegistryService } from '../../protocol/services/protocol-registry.service';
import { ProtocolValidatorService } from '../../protocol/services/protocol-validator.service';
import { ChannelDisplaySettings } from '../../database/entities/sensor-data-channel.entity';
import { CreateDataChannelInput } from '../dto/data-channel.dto';
import { ChannelManagementService, CreateChannelInput } from './channel-management.service';
import { resolveSerialNumber, throwIfSerialNumberConflict } from './serial-number.policy';
import { SensorTypeService } from '../../sensor-type/sensor-type.service';
import { safeSortField, safeSortOrder, createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { assertWithinQuota } from '@aquaculture/backend-common/quota';
import {
  resolvePlanLimits,
  tenantPlanFromLevel,
  createBaseEvent,
  type SensorRegisteredEvent,
  type SensorRegistrationStartedEvent,
  type SensorRegistrationCompletedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import {
  RegisterSensorInput,
  UpdateSensorProtocolInput,
  UpdateSensorInfoInput,
  SensorFilterInput,
  PaginationInput,
  RegisterParentWithChildrenInput,
} from '../dto/register-sensor.dto';

export interface RegistrationResult {
  success: boolean;
  sensor?: Sensor;
  error?: string;
  connectionTestPassed?: boolean;
  latencyMs?: number;
}

export type SensorListResult = IStandardPaginatedResult<Sensor>;

export interface ParentWithChildrenResult {
  success: boolean;
  parent?: Sensor;
  children?: Sensor[];
  error?: string;
  connectionTestPassed?: boolean;
  latencyMs?: number;
}

@Injectable()
export class SensorRegistrationService {
  private readonly logger = new Logger(SensorRegistrationService.name);

  constructor(
    @InjectRepository(Sensor)
    private sensorRepository: Repository<Sensor>,
    private dataSource: DataSource,
    private protocolRegistry: ProtocolRegistryService,
    private protocolValidator: ProtocolValidatorService,
    private connectionTester: ConnectionTesterService,
    private eventEmitter: EventEmitter2,
    private channelManagement: ChannelManagementService,
    // SENSOR-MEDIUM-071: bootstrap a custom type-definition's defaultChannels onto
    // a newly-registered sensor inside the registration transaction.
    private readonly sensorTypeService: SensorTypeService,
    // SENSOR-LOW-007: durable, contract-conformant registration lifecycle
    // events published through the transactional outbox → NATS (relay owns
    // delivery post-commit), replacing the in-process EventEmitter2 emissions
    // that no cross-service consumer could observe. OutboxPublisher is provided
    // globally by SensorOutboxModule.
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  // ── SENSOR-LOW-007 event builders (createBaseEvent, flat contract shape) ──
  private buildRegistrationStartedEvent(
    sensor: Sensor,
    protocolCode: string,
  ): SensorRegistrationStartedEvent {
    return {
      ...createBaseEvent<SensorRegistrationStartedEvent>('SensorRegistrationStarted', sensor.tenantId, {
        aggregateId: sensor.id,
        aggregateType: 'Sensor',
      }),
      sensorId: sensor.id,
      sensorName: sensor.name,
      protocolCode,
    };
  }

  private buildRegisteredEvent(sensor: Sensor, protocolCode: string): SensorRegisteredEvent {
    return {
      ...createBaseEvent<SensorRegisteredEvent>('SensorRegistered', sensor.tenantId, {
        aggregateId: sensor.id,
        aggregateType: 'Sensor',
      }),
      sensorId: sensor.id,
      farmId: sensor.farmId,
      pondId: sensor.pondId,
      sensorType: sensor.type,
      manufacturer: sensor.manufacturer,
      model: sensor.model,
    };
  }

  private buildRegistrationCompletedEvent(
    sensor: Sensor,
    protocolCode: string,
    connectionTestPassed: boolean,
  ): SensorRegistrationCompletedEvent {
    return {
      ...createBaseEvent<SensorRegistrationCompletedEvent>('SensorRegistrationCompleted', sensor.tenantId, {
        aggregateId: sensor.id,
        aggregateType: 'Sensor',
      }),
      sensorId: sensor.id,
      sensorName: sensor.name,
      protocolCode,
      farmId: sensor.farmId,
      pondId: sensor.pondId,
      connectionTestPassed,
    };
  }

  /**
   * Register a new sensor
   */
  async registerSensor(
    input: RegisterSensorInput,
    tenantId: string,
    // SENSOR-LOW-007: retained for the call signature; the registration events
    // are keyed by sensor/tenant, not the acting user (the contract has no
    // actor field), so this is intentionally unused here.
    _userId: string,
    /**
     * SSOT-C-13: tenant plan tier ordinal (PLAN_LEVEL) for per-plan sensor-count
     * quota. Undefined for platform SUPER_ADMIN → quota skipped. Enforced here at
     * the explicit registration path; the high-throughput ingestion auto-create
     * path is a separate concern and is not gated.
     */
    planLevel?: number,
  ): Promise<RegistrationResult> {
    // SSOT-C-13: fail-closed per-plan sensor-count quota, before any work.
    if (planLevel !== undefined) {
      const maxSensors = resolvePlanLimits(tenantPlanFromLevel(planLevel)).maxSensors;
      if (maxSensors !== -1) {
        const currentSensors = await this.sensorRepository.count({ where: { tenantId } });
        assertWithinQuota('sensors', currentSensors, maxSensors);
      }
    }

    // Validate protocol exists
    if (!this.protocolRegistry.hasProtocol(input.protocolCode)) {
      return {
        success: false,
        error: `Unknown protocol: ${input.protocolCode}`,
      };
    }

    // Validate configuration
    const validationResult = this.protocolValidator.validate(
      input.protocolCode,
      input.protocolConfiguration,
    );
    if (!validationResult.isValid) {
      return {
        success: false,
        error: `Configuration validation failed: ${validationResult.errors.map((e) => e.message).join(', ')}`,
      };
    }

    // Get protocol details
    const protocolDetails = await this.protocolRegistry.getProtocolDetails(input.protocolCode);

    // SENSOR-MEDIUM-072: serial_number is NOT NULL, but the DTO marks it optional.
    // Resolve it once (operator value, else a generated placeholder) so this path
    // reaches parity with the parent path and never nulls the column.
    const serialNumber = resolveSerialNumber(input.serialNumber, 'SENSOR');

    // Create sensor entity
    const sensor = this.sensorRepository.create({
      name: input.name,
      type: input.type,
      // SENSOR-MEDIUM-071: persist the custom type-definition reference so the
      // detail page and future channel re-sync can resolve it.
      typeDefinitionId: input.typeDefinitionId,
      protocolId: protocolDetails?.id,
      protocolConfiguration: input.protocolConfiguration as Record<string, unknown>,
      manufacturer: input.manufacturer,
      model: input.model,
      serialNumber,
      description: input.description,
      farmId: input.farmId,
      pondId: input.pondId,
      tankId: input.tankId,
      // New location hierarchy fields
      siteId: input.siteId,
      departmentId: input.departmentId,
      systemId: input.systemId,
      equipmentId: input.equipmentId,
      location: input.location,
      metadata: input.metadata as Record<string, unknown>,
      tenantId,
      registrationStatus: SensorRegistrationStatus.DRAFT,
      connectionStatus: {
        isConnected: false,
      },
      isActive: false,
    });

    // Save draft, persist the wizard's data channels, AND enqueue the
    // SensorRegistrationStarted event — all in ONE transaction (SENSOR-LOW-007 +
    // SENSOR-HIGH-018). Because channel creation joins the same transaction, a
    // failure (e.g. duplicate channelKey) rolls back the sensor row AND the
    // durable Started event together: no channel-less orphan, and no dangling
    // lifecycle event for a sensor that was never really registered. This
    // replaces the previous "commit sensor+event, then create channels, then
    // delete-on-failure" flow, which could leave a committed Started event for a
    // just-deleted sensor.
    let savedSensor: Sensor;
    try {
      savedSensor = await this.dataSource.transaction(async (manager) => {
        const persisted = await manager.save(Sensor, sensor);
        if (input.dataChannels && input.dataChannels.length > 0) {
          await this.channelManagement.createChannelsForSensor(
            persisted.id,
            tenantId,
            this.toChannelInputs(input.dataChannels),
            manager,
          );
        }
        // SENSOR-MEDIUM-071: bootstrap the type-definition's defaultChannels in the
        // same transaction. An unresolvable typeDefinitionId throws NotFoundException
        // here, rolling the whole registration back — the failure is surfaced, not
        // swallowed as the deleted createSensor back door did.
        if (input.typeDefinitionId) {
          await this.sensorTypeService.createChannelsFromTypeDefinition(
            persisted.id,
            tenantId,
            input.typeDefinitionId,
            manager,
          );
        }
        await this.outboxPublisher.enqueue(
          this.buildRegistrationStartedEvent(persisted, input.protocolCode),
          manager,
        );
        return persisted;
      });
    } catch (err) {
      // SENSOR-MEDIUM-072: a duplicate operator-supplied serial is a client-side
      // conflict, not an opaque server error — surface it as a domain
      // ConflictException instead of the raw "duplicate key value" driver text.
      throwIfSerialNumberConflict(err, serialNumber);
      // Full rollback already undid the sensor row and the Started event, so
      // there is nothing to compensate — just report the failure.
      return { success: false, error: (err as Error).message };
    }

    // Test connection if not skipped
    let connectionTestPassed = false;
    let latencyMs: number | undefined;

    if (!input.skipConnectionTest) {
      const testResult = await this.testSensorConnection(savedSensor.id, tenantId);
      connectionTestPassed = testResult.success;
      latencyMs = testResult.latencyMs;

      if (connectionTestPassed) {
        // Update status to active
        savedSensor.registrationStatus = SensorRegistrationStatus.ACTIVE;
        savedSensor.isActive = true;
        savedSensor.connectionStatus = {
          isConnected: true,
          lastTestedAt: new Date(),
          latencyMs: latencyMs,
        };
      } else {
        savedSensor.registrationStatus = SensorRegistrationStatus.TEST_FAILED;
        savedSensor.connectionStatus = {
          isConnected: false,
          lastTestedAt: new Date(),
          lastError: testResult.error,
        };
      }
    }

    // Persist the final status (if a test ran) AND enqueue the SensorRegistered
    // + SensorRegistrationCompleted events atomically (SENSOR-LOW-007).
    await this.dataSource.transaction(async (manager) => {
      if (!input.skipConnectionTest) {
        await manager.save(Sensor, savedSensor);
      }
      await this.outboxPublisher.enqueue(
        this.buildRegisteredEvent(savedSensor, input.protocolCode),
        manager,
      );
      await this.outboxPublisher.enqueue(
        this.buildRegistrationCompletedEvent(
          savedSensor,
          input.protocolCode,
          connectionTestPassed || Boolean(input.skipConnectionTest),
        ),
        manager,
      );
    });

    return {
      success: true,
      sensor: savedSensor,
      connectionTestPassed,
      latencyMs,
    };
  }

  /**
   * SENSOR-HIGH-018: map the GraphQL channel input to the channel-management
   * create input. The only real divergence is displaySettings.widgetType,
   * which the input types as a free string but the entity narrows to a fixed
   * set — narrow it here (unknown values drop to undefined) without an unsafe
   * cast.
   */
  private toChannelInputs(channels: CreateDataChannelInput[]): CreateChannelInput[] {
    return channels.map((ch) => ({
      ...ch,
      displaySettings: ch.displaySettings
        ? {
            ...ch.displaySettings,
            widgetType: this.narrowWidgetType(ch.displaySettings.widgetType),
          }
        : undefined,
    }));
  }

  private narrowWidgetType(
    widget?: string,
  ): ChannelDisplaySettings['widgetType'] {
    switch (widget) {
      case 'gauge':
      case 'sparkline':
      case 'number':
      case 'status':
        return widget;
      default:
        return undefined;
    }
  }

  /**
   * Test sensor connection
   */
  async testSensorConnection(
    sensorId: string,
    tenantId: string,
  ): Promise<ExtendedTestResult> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId, tenantId },
      relations: ['protocol'],
    });

    if (!sensor) {
      throw new NotFoundException(`Sensor not found: ${sensorId}`);
    }

    const protocolCode = sensor.protocol?.code || '';
    if (!protocolCode) {
      return {
        success: false,
        protocolCode: 'unknown',
        testedAt: new Date(),
        configUsed: sensor.protocolConfiguration || {},
        error: 'No protocol configured for this sensor',
      };
    }

    // Update status to testing
    sensor.registrationStatus = SensorRegistrationStatus.TESTING;
    await this.sensorRepository.save(sensor);

    // Test connection
    const result = await this.connectionTester.testConnection(
      protocolCode,
      {
        ...sensor.protocolConfiguration,
        sensorId: sensor.id,
        tenantId,
      },
      { timeout: 10000, fetchSampleData: true },
    );

    // Update sensor status based on result
    sensor.connectionStatus = {
      isConnected: result.success,
      lastTestedAt: new Date(),
      lastError: result.error,
      latencyMs: result.latencyMs,
    };

    if (result.success) {
      sensor.registrationStatus = SensorRegistrationStatus.ACTIVE;
      sensor.isActive = true;
    } else {
      sensor.registrationStatus = SensorRegistrationStatus.TEST_FAILED;
    }

    await this.sensorRepository.save(sensor);

    // Emit event
    this.eventEmitter.emit('sensor.connection.tested', {
      sensorId: sensor.id,
      tenantId,
      protocolCode,
      success: result.success,
      latencyMs: result.latencyMs,
      error: result.error,
    });

    return result;
  }

  /**
   * Activate a sensor (after successful test)
   */
  async activateSensor(sensorId: string, tenantId: string): Promise<Sensor> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId, tenantId },
    });

    if (!sensor) {
      throw new NotFoundException(`Sensor not found: ${sensorId}`);
    }

    if (sensor.registrationStatus === SensorRegistrationStatus.ACTIVE) {
      return sensor;
    }

    // Test connection first
    const testResult = await this.testSensorConnection(sensorId, tenantId);
    if (!testResult.success) {
      throw new BadRequestException(`Cannot activate sensor: connection test failed - ${testResult.error}`);
    }

    sensor.registrationStatus = SensorRegistrationStatus.ACTIVE;
    sensor.isActive = true;

    return this.sensorRepository.save(sensor);
  }

  /**
   * Suspend a sensor
   */
  async suspendSensor(sensorId: string, tenantId: string, reason?: string): Promise<Sensor> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId, tenantId },
    });

    if (!sensor) {
      throw new NotFoundException(`Sensor not found: ${sensorId}`);
    }

    sensor.registrationStatus = SensorRegistrationStatus.SUSPENDED;
    sensor.isActive = false;
    sensor.connectionStatus = {
      ...sensor.connectionStatus,
      isConnected: false,
      lastError: reason || 'Sensor suspended',
    };

    const savedSensor = await this.sensorRepository.save(sensor);

    this.eventEmitter.emit('sensor.suspended', {
      sensorId: sensor.id,
      tenantId,
      reason,
    });

    return savedSensor;
  }

  /**
   * Reactivate a suspended sensor
   */
  async reactivateSensor(sensorId: string, tenantId: string): Promise<Sensor> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId, tenantId },
    });

    if (!sensor) {
      throw new NotFoundException(`Sensor not found: ${sensorId}`);
    }

    if (sensor.registrationStatus !== SensorRegistrationStatus.SUSPENDED) {
      throw new BadRequestException('Sensor is not suspended');
    }

    return this.activateSensor(sensorId, tenantId);
  }

  /**
   * Update sensor protocol configuration
   */
  async updateProtocolConfig(
    input: UpdateSensorProtocolInput,
    tenantId: string,
  ): Promise<RegistrationResult> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: input.sensorId, tenantId },
      relations: ['protocol'],
    });

    if (!sensor) {
      throw new NotFoundException(`Sensor not found: ${input.sensorId}`);
    }

    const protocolCode = input.protocolCode || sensor.protocol?.code;
    if (!protocolCode) {
      return {
        success: false,
        error: 'No protocol specified',
      };
    }

    // Validate new configuration
    const validationResult = this.protocolValidator.validate(
      protocolCode,
      input.protocolConfiguration,
    );
    if (!validationResult.isValid) {
      return {
        success: false,
        error: `Configuration validation failed: ${validationResult.errors.map((e) => e.message).join(', ')}`,
      };
    }

    // Update protocol if changed
    if (input.protocolCode && input.protocolCode !== sensor.protocol?.code) {
      const newProtocol = await this.protocolRegistry.getProtocolDetails(input.protocolCode);
      if (newProtocol) {
        sensor.protocolId = newProtocol.id;
      }
    }

    sensor.protocolConfiguration = input.protocolConfiguration as Record<string, unknown>;
    sensor.registrationStatus = SensorRegistrationStatus.PENDING_TEST;

    const savedSensor = await this.sensorRepository.save(sensor);

    // Emit event
    this.eventEmitter.emit('sensor.protocol.changed', {
      sensorId: sensor.id,
      tenantId,
      protocolCode,
    });

    return {
      success: true,
      sensor: savedSensor,
    };
  }

  /**
   * Update sensor info
   */
  async updateSensorInfo(input: UpdateSensorInfoInput, tenantId: string): Promise<Sensor> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: input.sensorId, tenantId },
    });

    if (!sensor) {
      throw new NotFoundException(`Sensor not found: ${input.sensorId}`);
    }

    if (input.name !== undefined) sensor.name = input.name;
    if (input.type !== undefined) sensor.type = input.type;
    if (input.manufacturer !== undefined) sensor.manufacturer = input.manufacturer;
    if (input.model !== undefined) sensor.model = input.model;
    if (input.serialNumber !== undefined) sensor.serialNumber = input.serialNumber;
    if (input.description !== undefined) sensor.description = input.description;
    if (input.farmId !== undefined) sensor.farmId = input.farmId;
    if (input.pondId !== undefined) sensor.pondId = input.pondId;
    if (input.tankId !== undefined) sensor.tankId = input.tankId;
    // New location hierarchy fields
    if (input.siteId !== undefined) sensor.siteId = input.siteId;
    if (input.departmentId !== undefined) sensor.departmentId = input.departmentId;
    if (input.systemId !== undefined) sensor.systemId = input.systemId;
    if (input.equipmentId !== undefined) sensor.equipmentId = input.equipmentId;
    if (input.location !== undefined) sensor.location = input.location;
    if (input.metadata !== undefined) sensor.metadata = input.metadata as Record<string, unknown>;

    return this.sensorRepository.save(sensor);
  }

  /**
   * Delete sensor
   */
  async deleteSensor(sensorId: string, tenantId: string): Promise<boolean> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId, tenantId },
    });

    if (!sensor) {
      throw new NotFoundException(`Sensor not found: ${sensorId}`);
    }

    await this.sensorRepository.remove(sensor);

    this.eventEmitter.emit('sensor.deleted', {
      sensorId,
      tenantId,
    });

    return true;
  }

  /**
   * Get sensor by ID
   */
  async getSensor(sensorId: string, tenantId: string): Promise<Sensor | null> {
    return this.sensorRepository.findOne({
      where: { id: sensorId, tenantId },
      relations: ['protocol'],
    });
  }

  /**
   * List sensors with filtering and pagination
   */
  async listSensors(
    tenantId: string,
    filter?: SensorFilterInput,
    pagination?: PaginationInput,
  ): Promise<SensorListResult> {
    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const skip = (page - 1) * limit;

    const where: FindOptionsWhere<Sensor> = { tenantId };

    if (filter?.type) where.type = filter.type;
    if (filter?.registrationStatus) where.registrationStatus = filter.registrationStatus;
    if (filter?.farmId) where.farmId = filter.farmId;
    if (filter?.pondId) where.pondId = filter.pondId;
    if (filter?.tankId) where.tankId = filter.tankId;
    // New location hierarchy filters
    if (filter?.siteId) where.siteId = filter.siteId;
    if (filter?.departmentId) where.departmentId = filter.departmentId;
    if (filter?.systemId) where.systemId = filter.systemId;
    if (filter?.equipmentId) where.equipmentId = filter.equipmentId;

    // Handle search (name) — escape LIKE special chars to prevent wildcard injection
    if (filter?.search) {
      const escaped = filter.search.replace(/[\\%_]/g, '\\$&');
      where.name = Like(`%${escaped}%`);
    }

    const SENSOR_SORT_ALLOWLIST = ['createdAt', 'updatedAt', 'name', 'type', 'registrationStatus'] as const;
    const sortField = safeSortField(pagination?.sortBy, SENSOR_SORT_ALLOWLIST, 'createdAt');
    const sortDir = safeSortOrder(pagination?.sortOrder);

    const [items, total] = await this.sensorRepository.findAndCount({
      where,
      relations: ['protocol'],
      skip,
      take: limit,
      order: { [sortField]: sortDir },
    });

    return createStandardPaginatedResult(items, total, page, limit);
  }

  /**
   * Get sensors by protocol
   */
  async getSensorsByProtocol(protocolCode: string, tenantId: string): Promise<Sensor[]> {
    const protocol = await this.protocolRegistry.getProtocolDetails(protocolCode);
    if (!protocol) {
      return [];
    }

    return this.sensorRepository.find({
      where: { protocolId: protocol.id, tenantId },
      order: { name: 'ASC' },
      take: 500,
    });
  }

  /**
   * Get sensor statistics using a single aggregated SQL query (HIGH-007).
   * Previously loaded all entities into memory for JS-side aggregation.
   * Now uses GROUP BY for O(1) heap usage regardless of sensor count.
   */
  async getSensorStats(tenantId: string): Promise<{
    total: number;
    active: number;
    inactive: number;
    testing: number;
    failed: number;
    byType: Record<string, number>;
    byProtocol: Record<string, number>;
  }> {
    interface StatRow {
      registration_status: string;
      type: string;
      protocol_code: string | null;
      cnt: string;
    }

    const rows: StatRow[] = await this.dataSource.query(
      `SELECT s.registration_status, s.type,
              p.code AS protocol_code,
              COUNT(*) AS cnt
       FROM sensors s
       LEFT JOIN sensor_protocols p ON s.protocol_id = p.id
       WHERE s.tenant_id = $1
       GROUP BY s.registration_status, s.type, p.code`,
      [tenantId],
    );

    const stats = {
      total: 0,
      active: 0,
      inactive: 0,
      testing: 0,
      failed: 0,
      byType: {} as Record<string, number>,
      byProtocol: {} as Record<string, number>,
    };

    for (const row of rows) {
      const count = parseInt(row.cnt, 10) || 0;
      stats.total += count;

      switch (row.registration_status) {
        case SensorRegistrationStatus.ACTIVE:
          stats.active += count;
          break;
        case SensorRegistrationStatus.SUSPENDED:
        case SensorRegistrationStatus.DRAFT:
          stats.inactive += count;
          break;
        case SensorRegistrationStatus.TESTING:
        case SensorRegistrationStatus.PENDING_TEST:
          stats.testing += count;
          break;
        case SensorRegistrationStatus.TEST_FAILED:
          stats.failed += count;
          break;
      }

      stats.byType[row.type] = (stats.byType[row.type] || 0) + count;

      const protocolCode = row.protocol_code || 'unknown';
      stats.byProtocol[protocolCode] = (stats.byProtocol[protocolCode] || 0) + count;
    }

    return stats;
  }

  // ==================== Parent-Child Registration Methods ====================

  /**
   * Register a parent device with multiple child sensors
   * This is an atomic operation using a database transaction
   */
  async registerParentWithChildren(
    input: RegisterParentWithChildrenInput,
    tenantId: string,
    userId: string,
  ): Promise<ParentWithChildrenResult> {
    const { parent, children, skipConnectionTest } = input;

    // Validate protocol exists
    if (!this.protocolRegistry.hasProtocol(parent.protocolCode)) {
      return {
        success: false,
        error: `Unknown protocol: ${parent.protocolCode}`,
      };
    }

    // Validate protocol configuration
    const validationResult = this.protocolValidator.validate(
      parent.protocolCode,
      parent.protocolConfiguration,
    );
    if (!validationResult.isValid) {
      return {
        success: false,
        error: `Configuration validation failed: ${validationResult.errors.map((e) => e.message).join(', ')}`,
      };
    }

    // Validate at least one child sensor
    if (!children || children.length === 0) {
      return {
        success: false,
        error: 'At least one child sensor must be specified',
      };
    }

    // Start transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // SENSOR-MEDIUM-010: parent + children are declared outside the
    // transactional try so the connection test / status update can run AFTER
    // commit without the failure-inverting catch. A post-commit throw used to
    // hit rollbackTransaction() on an already-committed transaction (raising
    // TransactionNotStartedError, escaping the catch, and reporting the whole
    // create as failed → duplicate device on retry).
    let savedParent: Sensor;
    let savedChildren: Sensor[] = [];

    try {
      // Get protocol details
      const protocolDetails = await this.protocolRegistry.getProtocolDetails(parent.protocolCode);

      // SENSOR-MEDIUM-072: same serial-number policy as the single path.
      const parentSerialNumber = resolveSerialNumber(parent.serialNumber, 'PARENT');

      // Create parent device
      const parentSensor = queryRunner.manager.create(Sensor, {
        name: parent.name,
        type: SensorType.MULTI_PARAMETER,
        protocolId: protocolDetails?.id,
        protocolConfiguration: parent.protocolConfiguration as Record<string, unknown>,
        manufacturer: parent.manufacturer,
        model: parent.model,
        serialNumber: parentSerialNumber,
        // SENSOR-HIGH-025: description was validated on the DTO but dropped by
        // this create object (the single-sensor path persists it) — the wizard
        // notes silently vanished. Map it so read-back matches what was saved.
        description: parent.description,
        farmId: parent.farmId,
        pondId: parent.pondId,
        tankId: parent.tankId,
        // New location hierarchy fields
        siteId: parent.siteId,
        departmentId: parent.departmentId,
        systemId: parent.systemId,
        equipmentId: parent.equipmentId,
        location: parent.location,
        metadata: parent.metadata as Record<string, unknown>,
        tenantId,
        registrationStatus: SensorRegistrationStatus.DRAFT,
        connectionStatus: { isConnected: false },
        isActive: false,
        isParentDevice: true,
        sensorRole: SensorRole.PARENT,
        createdBy: userId,
      });

      savedParent = await queryRunner.manager.save(Sensor, parentSensor);
      this.logger.log(`Created parent device: ${savedParent.id}`);

      // Create child sensors
      savedChildren = [];
      for (let i = 0; i < children.length; i++) {
        const childInput = children[i];
        if (!childInput) continue;
        const childSerialNumber = `${parentSerialNumber}-CH${i + 1}`;

        const childSensor = queryRunner.manager.create(Sensor, {
          name: childInput.name,
          type: childInput.type,
          // SENSOR-MEDIUM-071: per-child custom type-definition reference.
          typeDefinitionId: childInput.typeDefinitionId,
          serialNumber: childSerialNumber,
          tenantId,
          farmId: parent.farmId,
          pondId: parent.pondId,
          tankId: parent.tankId,
          // Inherit location hierarchy from parent
          siteId: parent.siteId,
          departmentId: parent.departmentId,
          systemId: parent.systemId,
          equipmentId: parent.equipmentId,
          registrationStatus: SensorRegistrationStatus.DRAFT,
          connectionStatus: { isConnected: false },
          isActive: false,
          isParentDevice: false,
          sensorRole: SensorRole.CHILD,
          parentId: savedParent.id,
          dataPath: childInput.dataPath,
          unit: childInput.unit,
          minValue: childInput.minValue,
          maxValue: childInput.maxValue,
          calibrationEnabled: childInput.calibrationEnabled ?? false,
          calibrationMultiplier: childInput.calibrationMultiplier ?? 1.0,
          calibrationOffset: childInput.calibrationOffset ?? 0.0,
          alertThresholds: childInput.alertThresholds ? {
            warning: childInput.alertThresholds.warning,
            critical: childInput.alertThresholds.critical,
          } : undefined,
          displaySettings: childInput.displaySettings ? {
            showOnDashboard: childInput.displaySettings.showOnDashboard,
            widgetType: childInput.displaySettings.widgetType,
            color: childInput.displaySettings.color,
            sortOrder: childInput.displaySettings.sortOrder ?? i,
            decimalPlaces: childInput.displaySettings.decimalPlaces,
          } : {
            showOnDashboard: true,
            sortOrder: i,
          },
          createdBy: userId,
        });

        const savedChild = await queryRunner.manager.save(Sensor, childSensor);
        // SENSOR-MEDIUM-071: bootstrap the child's type-definition channels in the
        // same transaction; an unresolvable id rolls back the whole parent+children
        // create rather than silently skipping channels.
        if (childInput.typeDefinitionId) {
          await this.sensorTypeService.createChannelsFromTypeDefinition(
            savedChild.id,
            tenantId,
            childInput.typeDefinitionId,
            queryRunner.manager,
          );
        }
        savedChildren.push(savedChild);
        this.logger.log(`Created child sensor: ${savedChild.id} (${childInput.dataPath})`);
      }

      // SENSOR-LOW-007: enqueue the started event inside the same transaction
      // as the parent+children create so it is atomic with the rows.
      await this.outboxPublisher.enqueue(
        this.buildRegistrationStartedEvent(savedParent, parent.protocolCode),
        queryRunner.manager,
      );

      // Commit transaction — parent + children are now durably created.
      await queryRunner.commitTransaction();
    } catch (error) {
      // SENSOR-MEDIUM-010: only roll back while the transaction is still open.
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      this.logger.error('Failed to register parent with children', error);
      // SENSOR-MEDIUM-072: a duplicate operator-supplied parent serial is a
      // conflict, not an opaque failure — map it before the generic return.
      throwIfSerialNumberConflict(error, parent.serialNumber ?? '');
      return {
        success: false,
        error: `Registration failed: ${(error as Error).message}`,
      };
    } finally {
      await queryRunner.release();
    }

    // ── POST-COMMIT ──────────────────────────────────────────────────────
    // The devices are committed; a failure here must NOT invert the create to
    // a failure (that caused duplicate devices on retry). Downgrade status on
    // error instead. (SENSOR-LOW-007: the started event was enqueued inside the
    // create transaction above.)
    let connectionTestPassed = false;
    let latencyMs: number | undefined;

    if (!skipConnectionTest) {
      try {
        const testResult = await this.testParentConnection(savedParent.id, tenantId);
        connectionTestPassed = testResult.success;
        latencyMs = testResult.latencyMs;

        if (connectionTestPassed) {
          savedParent.registrationStatus = SensorRegistrationStatus.ACTIVE;
          savedParent.isActive = true;
          savedParent.connectionStatus = {
            isConnected: true,
            lastTestedAt: new Date(),
            latencyMs,
          };
          for (const child of savedChildren) {
            child.registrationStatus = SensorRegistrationStatus.ACTIVE;
            child.isActive = true;
          }
        } else {
          savedParent.registrationStatus = SensorRegistrationStatus.TEST_FAILED;
          savedParent.connectionStatus = {
            isConnected: false,
            lastTestedAt: new Date(),
            lastError: testResult.error,
          };
          for (const child of savedChildren) {
            child.registrationStatus = SensorRegistrationStatus.TEST_FAILED;
          }
        }

        await this.sensorRepository.save(savedParent);
        await this.sensorRepository.save(savedChildren);
      } catch (postErr) {
        // Devices remain committed in DRAFT; surface as a warning, not a
        // whole-registration failure.
        this.logger.warn(
          `Post-commit connection test/status update failed for parent ${savedParent.id}`,
          postErr as Error,
        );
      }
    }

    // SENSOR-LOW-007: enqueue the registered + completed events durably. Best
    // effort post-commit — a failure here does not undo the committed devices.
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.outboxPublisher.enqueue(
          this.buildRegisteredEvent(savedParent, parent.protocolCode),
          manager,
        );
        await this.outboxPublisher.enqueue(
          this.buildRegistrationCompletedEvent(
            savedParent,
            parent.protocolCode,
            connectionTestPassed || Boolean(skipConnectionTest),
          ),
          manager,
        );
      });
    } catch (evtErr) {
      this.logger.warn(
        `Failed to enqueue parent registration events for ${savedParent.id}`,
        evtErr as Error,
      );
    }

    const reloadedParent = await this.sensorRepository.findOne({
      where: { id: savedParent.id },
      relations: ['childSensors', 'protocol'],
    });

    return {
      success: true,
      parent: reloadedParent || savedParent,
      children: savedChildren,
      connectionTestPassed,
      latencyMs,
    };
  }

  /**
   * Test connection for a parent device
   */
  async testParentConnection(
    parentId: string,
    tenantId: string,
  ): Promise<ExtendedTestResult> {
    const parent = await this.sensorRepository.findOne({
      where: { id: parentId, tenantId, isParentDevice: true },
      relations: ['protocol'],
    });

    if (!parent) {
      throw new NotFoundException(`Parent device not found: ${parentId}`);
    }

    const protocolCode = parent.protocol?.code || '';
    if (!protocolCode) {
      return {
        success: false,
        protocolCode: 'unknown',
        testedAt: new Date(),
        configUsed: parent.protocolConfiguration || {},
        error: 'No protocol configured for this parent device',
      };
    }

    // Update status to testing
    parent.registrationStatus = SensorRegistrationStatus.TESTING;
    await this.sensorRepository.save(parent);

    // Test connection
    const result = await this.connectionTester.testConnection(
      protocolCode,
      {
        ...parent.protocolConfiguration,
        sensorId: parent.id,
        tenantId,
      },
      { timeout: 10000, fetchSampleData: true },
    );

    // Update parent status
    parent.connectionStatus = {
      isConnected: result.success,
      lastTestedAt: new Date(),
      lastError: result.error,
      latencyMs: result.latencyMs,
    };

    if (result.success) {
      parent.registrationStatus = SensorRegistrationStatus.ACTIVE;
      parent.isActive = true;
    } else {
      parent.registrationStatus = SensorRegistrationStatus.TEST_FAILED;
    }

    await this.sensorRepository.save(parent);

    // Emit event
    this.eventEmitter.emit('sensor.parent.connection.tested', {
      parentId: parent.id,
      tenantId,
      protocolCode,
      success: result.success,
      latencyMs: result.latencyMs,
      error: result.error,
    });

    return result;
  }

  /**
   * Get child sensors for a parent device
   */
  async getChildSensors(parentId: string, tenantId: string): Promise<Sensor[]> {
    return this.sensorRepository.find({
      where: { parentId, tenantId, sensorRole: SensorRole.CHILD },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Get parent device for a child sensor
   */
  async getParentDevice(childId: string, tenantId: string): Promise<Sensor | null> {
    const child = await this.sensorRepository.findOne({
      where: { id: childId, tenantId, sensorRole: SensorRole.CHILD },
      relations: ['parentSensor'],
    });

    return child?.parentSensor || null;
  }

  /**
   * Get parent device by ID with children
   */
  async getParentWithChildren(parentId: string, tenantId: string): Promise<Sensor | null> {
    return this.sensorRepository.findOne({
      where: { id: parentId, tenantId, isParentDevice: true },
      relations: ['childSensors', 'protocol'],
    });
  }

  /**
   * List parent devices with filtering
   */
  async listParentDevices(
    tenantId: string,
    filter?: SensorFilterInput,
    pagination?: PaginationInput,
  ): Promise<SensorListResult> {
    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const skip = (page - 1) * limit;

    const where: FindOptionsWhere<Sensor> = {
      tenantId,
      isParentDevice: true,
      sensorRole: SensorRole.PARENT,
    };

    if (filter?.registrationStatus) where.registrationStatus = filter.registrationStatus;
    if (filter?.farmId) where.farmId = filter.farmId;
    if (filter?.pondId) where.pondId = filter.pondId;
    if (filter?.tankId) where.tankId = filter.tankId;
    // New location hierarchy filters
    if (filter?.siteId) where.siteId = filter.siteId;
    if (filter?.departmentId) where.departmentId = filter.departmentId;
    if (filter?.systemId) where.systemId = filter.systemId;
    if (filter?.equipmentId) where.equipmentId = filter.equipmentId;
    if (filter?.search) {
      const escaped = filter.search.replace(/[\\%_]/g, '\\$&');
      where.name = Like(`%${escaped}%`);
    }

    const SENSOR_SORT_ALLOWLIST = ['createdAt', 'updatedAt', 'name', 'type', 'registrationStatus'] as const;
    const sortField = safeSortField(pagination?.sortBy, SENSOR_SORT_ALLOWLIST, 'createdAt');
    const sortDir = safeSortOrder(pagination?.sortOrder);

    const [items, total] = await this.sensorRepository.findAndCount({
      where,
      relations: ['childSensors', 'protocol'],
      skip,
      take: limit,
      order: { [sortField]: sortDir },
    });

    return createStandardPaginatedResult(items, total, page, limit);
  }

  /**
   * Delete parent device and all its children
   */
  async deleteParentWithChildren(parentId: string, tenantId: string): Promise<boolean> {
    const parent = await this.sensorRepository.findOne({
      where: { id: parentId, tenantId, isParentDevice: true },
      relations: ['childSensors'],
    });

    if (!parent) {
      throw new NotFoundException(`Parent device not found: ${parentId}`);
    }

    // Delete children first (CASCADE should handle this, but being explicit)
    if (parent.childSensors && parent.childSensors.length > 0) {
      await this.sensorRepository.remove(parent.childSensors);
    }

    // Delete parent
    await this.sensorRepository.remove(parent);

    this.eventEmitter.emit('sensor.parent.deleted', {
      parentId,
      tenantId,
      childCount: parent.childSensors?.length || 0,
    });

    return true;
  }
}
