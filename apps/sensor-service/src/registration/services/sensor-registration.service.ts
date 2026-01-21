import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, FindOptionsWhere, DataSource } from 'typeorm';

import { Sensor, SensorType, SensorRegistrationStatus, SensorRole } from '../../database/entities/sensor.entity';
import { ConnectionTesterService, ExtendedTestResult } from '../../protocol/services/connection-tester.service';
import { ProtocolRegistryService } from '../../protocol/services/protocol-registry.service';
import { ProtocolValidatorService } from '../../protocol/services/protocol-validator.service';
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

export interface SensorListResult {
  items: Sensor[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

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
  ) {}

  /**
   * Register a new sensor
   */
  async registerSensor(
    input: RegisterSensorInput,
    tenantId: string,
    userId: string,
  ): Promise<RegistrationResult> {
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

    // Create sensor entity
    const sensor = this.sensorRepository.create({
      name: input.name,
      type: input.type,
      protocolId: protocolDetails?.id,
      protocolConfiguration: input.protocolConfiguration as Record<string, unknown>,
      manufacturer: input.manufacturer,
      model: input.model,
      serialNumber: input.serialNumber,
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

    // Save draft
    const savedSensor = await this.sensorRepository.save(sensor);

    // Emit registration started event
    this.eventEmitter.emit('sensor.registration.started', {
      sensorId: savedSensor.id,
      tenantId,
      userId,
      protocolCode: input.protocolCode,
    });

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

      await this.sensorRepository.save(savedSensor);
    }

    // Emit registration completed event
    this.eventEmitter.emit('sensor.registration.completed', {
      sensorId: savedSensor.id,
      tenantId,
      userId,
      protocolCode: input.protocolCode,
      success: connectionTestPassed || input.skipConnectionTest,
    });

    return {
      success: true,
      sensor: savedSensor,
      connectionTestPassed,
      latencyMs,
    };
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
    const pageSize = pagination?.pageSize || 20;
    const skip = (page - 1) * pageSize;

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

    // Handle search (name)
    if (filter?.search) {
      where.name = Like(`%${filter.search}%`);
    }

    const [items, total] = await this.sensorRepository.findAndCount({
      where,
      relations: ['protocol'],
      skip,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
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
    });
  }

  /**
   * Get sensor statistics
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
    const sensors = await this.sensorRepository.find({
      where: { tenantId },
      relations: ['protocol'],
    });

    const stats = {
      total: sensors.length,
      active: 0,
      inactive: 0,
      testing: 0,
      failed: 0,
      byType: {} as Record<string, number>,
      byProtocol: {} as Record<string, number>,
    };

    for (const sensor of sensors) {
      // Status counts
      switch (sensor.registrationStatus) {
        case SensorRegistrationStatus.ACTIVE:
          stats.active++;
          break;
        case SensorRegistrationStatus.SUSPENDED:
        case SensorRegistrationStatus.DRAFT:
          stats.inactive++;
          break;
        case SensorRegistrationStatus.TESTING:
        case SensorRegistrationStatus.PENDING_TEST:
          stats.testing++;
          break;
        case SensorRegistrationStatus.TEST_FAILED:
          stats.failed++;
          break;
      }

      // Type counts
      stats.byType[sensor.type] = (stats.byType[sensor.type] || 0) + 1;

      // Protocol counts
      const protocolCode = sensor.protocol?.code || 'unknown';
      stats.byProtocol[protocolCode] = (stats.byProtocol[protocolCode] || 0) + 1;
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

    try {
      // Get protocol details
      const protocolDetails = await this.protocolRegistry.getProtocolDetails(parent.protocolCode);

      // Generate serial number for parent if not provided
      const parentSerialNumber = parent.serialNumber || `PARENT-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      // Create parent device
      const parentSensor = queryRunner.manager.create(Sensor, {
        name: parent.name,
        type: SensorType.MULTI_PARAMETER,
        protocolId: protocolDetails?.id,
        protocolConfiguration: parent.protocolConfiguration as Record<string, unknown>,
        manufacturer: parent.manufacturer,
        model: parent.model,
        serialNumber: parentSerialNumber,
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

      const savedParent = await queryRunner.manager.save(Sensor, parentSensor);
      this.logger.log(`Created parent device: ${savedParent.id}`);

      // Create child sensors
      const savedChildren: Sensor[] = [];
      for (let i = 0; i < children.length; i++) {
        const childInput = children[i];
        if (!childInput) continue;
        const childSerialNumber = `${parentSerialNumber}-CH${i + 1}`;

        const childSensor = queryRunner.manager.create(Sensor, {
          name: childInput.name,
          type: childInput.type,
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
        savedChildren.push(savedChild);
        this.logger.log(`Created child sensor: ${savedChild.id} (${childInput.dataPath})`);
      }

      // Commit transaction
      await queryRunner.commitTransaction();

      // Emit registration started event
      this.eventEmitter.emit('sensor.parent.registration.started', {
        parentId: savedParent.id,
        childIds: savedChildren.map(c => c.id),
        tenantId,
        userId,
        protocolCode: parent.protocolCode,
      });

      // Test connection if not skipped
      let connectionTestPassed = false;
      let latencyMs: number | undefined;

      if (!skipConnectionTest) {
        const testResult = await this.testParentConnection(savedParent.id, tenantId);
        connectionTestPassed = testResult.success;
        latencyMs = testResult.latencyMs;

        // Update parent status based on test result
        if (connectionTestPassed) {
          savedParent.registrationStatus = SensorRegistrationStatus.ACTIVE;
          savedParent.isActive = true;
          savedParent.connectionStatus = {
            isConnected: true,
            lastTestedAt: new Date(),
            latencyMs,
          };

          // Activate all children too
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

        // Save updated statuses
        await this.sensorRepository.save(savedParent);
        await this.sensorRepository.save(savedChildren);
      }

      // Emit registration completed event
      this.eventEmitter.emit('sensor.parent.registration.completed', {
        parentId: savedParent.id,
        childIds: savedChildren.map(c => c.id),
        tenantId,
        userId,
        protocolCode: parent.protocolCode,
        success: connectionTestPassed || skipConnectionTest,
      });

      // Reload parent with children relation
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
    } catch (error) {
      // Rollback on error
      await queryRunner.rollbackTransaction();
      this.logger.error('Failed to register parent with children', error);
      return {
        success: false,
        error: `Registration failed: ${(error as Error).message}`,
      };
    } finally {
      await queryRunner.release();
    }
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
    const pageSize = pagination?.pageSize || 20;
    const skip = (page - 1) * pageSize;

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
    if (filter?.search) where.name = Like(`%${filter.search}%`);

    const [items, total] = await this.sensorRepository.findAndCount({
      where,
      relations: ['childSensors', 'protocol'],
      skip,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
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
