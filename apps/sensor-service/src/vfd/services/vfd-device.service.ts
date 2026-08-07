import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';

import {
  ModbusRtuConfigDto,
  ModbusTcpConfigDto,
  ProfinetConfigDto,
  EthernetIpConfigDto,
  CanopenConfigDto,
  BacnetIpConfigDto,
  BacnetMstpConfigDto,
  ProfibusDpConfigDto,
} from '../dto/protocol-config.dto';

interface StatusCountResult {
  status: string;
  count: string;
}

import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdBrand, VfdProtocol, VfdDeviceStatus } from '../entities/vfd.enums';
import { VfdDriveBindingService } from './vfd-drive-binding.service';
import { VfdEdgeProvisioningService } from './vfd-edge-provisioning.service';

/** A drive's edge-gateway binding, captured for provisioning/decommission. */
interface EdgeBinding {
  tenantId: string;
  edgeDeviceId?: string | null;
  edgeModbusDeviceName?: string | null;
}

/**
 * Input for creating a VFD device
 */
export interface CreateVfdDeviceInput {
  name: string;
  brand: VfdBrand;
  model?: string;
  serialNumber?: string;
  protocol: VfdProtocol;
  protocolConfiguration: Record<string, unknown>;
  description?: string;
  location?: string;
  farmId?: string;
  tags?: string[];
  // SENSOR-HIGH-026: previously accepted by the DTO but dropped at persistence.
  modelSeries?: string;
  /**
   * The farm equipment this drive turns. Not stored on the device row — it opens
   * a VfdDriveBinding, which is PENDING until the owning service attests it.
   */
  drivenEquipmentId?: string;
  notes?: string;
  // SENSOR-CRITICAL-007: edge-delegated write binding (both-or-neither).
  edgeDeviceId?: string;
  edgeModbusDeviceName?: string;
}

/**
 * Input for updating a VFD device
 */
export interface UpdateVfdDeviceInput {
  name?: string;
  model?: string;
  serialNumber?: string;
  protocol?: VfdProtocol;
  protocolConfiguration?: Record<string, unknown>;
  description?: string;
  location?: string;
  farmId?: string;
  tags?: string[];
  status?: VfdDeviceStatus;
  // SENSOR-CRITICAL-007: edge-delegated write binding (both-or-neither).
  edgeDeviceId?: string;
  edgeModbusDeviceName?: string;
}

/**
 * Filter options for querying VFD devices
 */
export interface VfdDeviceFilterInput {
  status?: VfdDeviceStatus;
  brand?: VfdBrand;
  protocol?: VfdProtocol;
  farmId?: string;
  tankId?: string;
  search?: string;
}

/**
 * Pagination input
 */
export interface PaginationInput {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

/**
 * VFD Device Service
 * Handles CRUD operations for VFD devices
 */
@Injectable()
export class VfdDeviceService {
  private readonly logger = new Logger(VfdDeviceService.name);

  constructor(
    @InjectRepository(VfdDevice)
    private readonly vfdDeviceRepository: Repository<VfdDevice>,
    // Owns the drive→equipment binding. Registration may open one; deletion must
    // close one, or a re-used device id would inherit a dead binding.
    private readonly driveBindingService: VfdDriveBindingService,
    // @Optional so `new`-based unit tests and edge-less boots work; when present,
    // binding a drive to an edge gateway pushes it there as a Modbus device
    // (SENSOR-CRITICAL-007), and unbinding/deleting removes it.
    @Optional()
    private readonly edgeProvisioning?: VfdEdgeProvisioningService,
  ) {}

  /**
   * Create a new VFD device
   */
  async create(input: CreateVfdDeviceInput, tenantId: string): Promise<VfdDevice> {
    this.logger.log(`Creating VFD device: ${input.name} for tenant ${tenantId}`);

    // Validate protocol configuration
    this.validateProtocolConfiguration(input.protocol, input.protocolConfiguration);

    // SENSOR-CRITICAL-007: a drive is either fully bound to an edge gateway or
    // not bound at all — a half-bound record (gateway without a Modbus device
    // name, or vice versa) could never be dispatched to and must be rejected.
    this.validateEdgeBinding(input.edgeDeviceId, input.edgeModbusDeviceName);

    // `drivenEquipmentId` is NOT a device column — it opens a binding that the
    // owning service has to attest. Destructured out so the spread below cannot
    // smuggle it into the device row as an unchecked uuid, which is precisely the
    // shape `tank_id` and `pump_id` had.
    const { notes, drivenEquipmentId, ...rest } = input;
    const deviceData: DeepPartial<VfdDevice> = {
      ...rest,
      tenantId,
      // SENSOR-HIGH-026: reconcile the wizard's free-text `notes` into the
      // canonical `description` column (an explicit description wins if both
      // are present) instead of dropping it.
      description: input.description ?? notes,
      status: VfdDeviceStatus.DRAFT,
      connectionStatus: {
        isConnected: false,
        lastTestedAt: undefined,
        lastError: undefined,
        latencyMs: undefined,
      },
    };
    const device = this.vfdDeviceRepository.create(deviceData);

    const savedDevice = await this.vfdDeviceRepository.save(device);
    this.logger.log(`VFD device created with ID: ${savedDevice.id}`);

    // If the drive was created already bound to an edge gateway, push it there
    // as a Modbus device so the edge-delegated write path has a real target.
    if (savedDevice.edgeDeviceId && savedDevice.edgeModbusDeviceName) {
      await this.safeEdgeProvision(savedDevice);
    }

    // Commissioning-time binding. The drive stays uncommandable until the owning
    // service answers, which is the whole point — a registration cannot assert
    // what a farm equipment row is.
    if (drivenEquipmentId) {
      await this.driveBindingService.bind(savedDevice.id, tenantId, drivenEquipmentId);
    }

    return savedDevice;
  }

  /**
   * Find a VFD device by ID
   */
  async findById(id: string, tenantId: string): Promise<VfdDevice> {
    const device = await this.vfdDeviceRepository.findOne({
      where: { id, tenantId },
    });

    if (!device) {
      throw new NotFoundException(`VFD device with ID ${id} not found`);
    }

    return device;
  }

  /**
   * Find all VFD devices with filtering and pagination
   */
  async findAll(
    tenantId: string,
    filter?: VfdDeviceFilterInput,
    pagination?: PaginationInput,
  ): Promise<IStandardPaginatedResult<VfdDevice>> {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 20;
    const offset = (page - 1) * limit;

    const queryBuilder = this.vfdDeviceRepository
      .createQueryBuilder('vfd')
      .where('vfd.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter?.status) {
      queryBuilder.andWhere('vfd.status = :status', { status: filter.status });
    }

    if (filter?.brand) {
      queryBuilder.andWhere('vfd.brand = :brand', { brand: filter.brand });
    }

    if (filter?.protocol) {
      queryBuilder.andWhere('vfd.protocol = :protocol', { protocol: filter.protocol });
    }

    if (filter?.farmId) {
      queryBuilder.andWhere('vfd.farmId = :farmId', { farmId: filter.farmId });
    }

    if (filter?.tankId) {
      // Through the binding, not off the row. A drive "belongs to" a unit only
      // because the equipment it turns serves that unit, and only while the
      // owning service still says so.
      queryBuilder.andWhere(
        `EXISTS (
           SELECT 1 FROM vfd_drive_binding_units u
            WHERE u.vfd_device_id = vfd.id
              AND u.tenant_id = vfd."tenant_id"
              AND u.unit_id = :tankId
         )`,
        { tankId: filter.tankId },
      );
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(vfd.name ILIKE :search OR vfd.model ILIKE :search OR vfd.serialNumber ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    // Apply sorting with allowlist to prevent column injection
    const ALLOWED_SORT_COLUMNS = [
      'createdAt',
      'name',
      'brand',
      'status',
      'updatedAt',
      'model',
      'protocol',
    ];
    const sortBy = ALLOWED_SORT_COLUMNS.includes(pagination?.sortBy ?? '')
      ? pagination!.sortBy!
      : 'createdAt';
    const sortOrder = pagination?.sortOrder === 'ASC' ? 'ASC' : 'DESC';
    queryBuilder.orderBy(`vfd.${sortBy}`, sortOrder);

    // Get total count and items
    const [items, total] = await queryBuilder.skip(offset).take(limit).getManyAndCount();

    return createStandardPaginatedResult(items, total, page, limit);
  }

  /**
   * Update a VFD device
   */
  async update(id: string, tenantId: string, input: UpdateVfdDeviceInput): Promise<VfdDevice> {
    const device = await this.findById(id, tenantId);

    // Validate protocol configuration if being updated
    if (input.protocol && input.protocolConfiguration) {
      this.validateProtocolConfiguration(input.protocol, input.protocolConfiguration);
    } else if (input.protocolConfiguration && !input.protocol) {
      this.validateProtocolConfiguration(device.protocol, input.protocolConfiguration);
    }

    // Capture the PRIOR edge binding before mutating so we can decommission it
    // if the update unbinds the drive or re-points it at a different gateway/name.
    const priorBinding: EdgeBinding = {
      tenantId: device.tenantId,
      edgeDeviceId: device.edgeDeviceId,
      edgeModbusDeviceName: device.edgeModbusDeviceName,
    };

    // Update fields
    Object.assign(device, input);
    device.updatedAt = new Date();

    // SENSOR-CRITICAL-007: enforce both-or-neither on the RESULTING binding — an
    // update that sets only one half (or clears only one half) would leave a
    // half-bound record that can never be dispatched to.
    this.validateEdgeBinding(device.edgeDeviceId, device.edgeModbusDeviceName);

    const updatedDevice = await this.vfdDeviceRepository.save(device);
    this.logger.log(`VFD device ${id} updated`);

    await this.reconcileEdgeAfterUpdate(priorBinding, updatedDevice, input);

    return updatedDevice;
  }

  /**
   * Delete a VFD device
   */
  async delete(id: string, tenantId: string): Promise<boolean> {
    const device = await this.findById(id, tenantId);

    // Capture the binding before removal so we can decommission the Modbus device
    // on the edge gateway — a deleted drive must not leave a live writable device.
    const priorBinding: EdgeBinding = {
      tenantId: device.tenantId,
      edgeDeviceId: device.edgeDeviceId,
      edgeModbusDeviceName: device.edgeModbusDeviceName,
    };

    // Close the binding BEFORE the device row goes: an orphan binding would be
    // inherited by nothing, but it would still be counted by the unattested-drive
    // health surface and confuse whoever reads it.
    await this.driveBindingService.unbind(id, tenantId);

    await this.vfdDeviceRepository.remove(device);
    this.logger.log(`VFD device ${id} deleted`);

    if (priorBinding.edgeDeviceId && priorBinding.edgeModbusDeviceName) {
      await this.safeEdgeDecommission(priorBinding);
    }

    return true;
  }

  /**
   * After an update, reconcile the drive's edge binding: decommission the prior
   * Modbus device when it was unbound or re-pointed, and (re)provision the current
   * one when it is bound and the binding or edge-relevant config changed.
   */
  private async reconcileEdgeAfterUpdate(
    prior: EdgeBinding,
    current: VfdDevice,
    input: UpdateVfdDeviceInput,
  ): Promise<void> {
    if (!this.edgeProvisioning) {
      return;
    }
    const priorBound = !!prior.edgeDeviceId && !!prior.edgeModbusDeviceName;
    const nowBound = !!current.edgeDeviceId && !!current.edgeModbusDeviceName;
    const identityChanged =
      prior.edgeDeviceId !== current.edgeDeviceId ||
      prior.edgeModbusDeviceName !== current.edgeModbusDeviceName;

    // Decommission the prior device only when its identity is gone (unbound, or
    // re-pointed at a different gateway/name); a same-name reprovision below
    // handles config changes via the edge's idempotent add-or-replace.
    if (priorBound && identityChanged) {
      await this.safeEdgeDecommission(prior);
    }

    // (Re)provision when bound and either the binding moved or the edge-relevant
    // config (connection / protocol) changed.
    const configTouched = input.protocol !== undefined || input.protocolConfiguration !== undefined;
    if (nowBound && (identityChanged || configTouched)) {
      await this.safeEdgeProvision(current);
    }
  }

  /** Best-effort edge provisioning — never fails the DB mutation it follows. */
  private async safeEdgeProvision(device: VfdDevice): Promise<void> {
    if (!this.edgeProvisioning) {
      return;
    }
    try {
      const result = await this.edgeProvisioning.provisionDevice(device);
      if (result.skipped) {
        this.logger.debug(`Edge provision skipped for VFD ${device.id}: ${result.error}`);
      } else if (!result.success) {
        this.logger.warn(`Edge provision failed for VFD ${device.id}: ${result.error}`);
      } else {
        this.logger.log(`Edge provision succeeded for VFD ${device.id} (${result.latencyMs}ms)`);
      }
    } catch (error) {
      this.logger.warn(`Edge provision threw for VFD ${device.id}: ${(error as Error).message}`);
    }
  }

  /** Best-effort edge decommission — never fails the DB mutation it follows. */
  private async safeEdgeDecommission(binding: EdgeBinding): Promise<void> {
    if (!this.edgeProvisioning) {
      return;
    }
    try {
      const result = await this.edgeProvisioning.decommissionDevice(binding);
      if (!result.skipped && !result.success) {
        this.logger.warn(
          `Edge decommission of ${binding.edgeModbusDeviceName} failed: ${result.error}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Edge decommission of ${binding.edgeModbusDeviceName} threw: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update device status
   */
  async updateStatus(id: string, tenantId: string, status: VfdDeviceStatus): Promise<VfdDevice> {
    const device = await this.findById(id, tenantId);
    device.status = status;
    device.updatedAt = new Date();

    return this.vfdDeviceRepository.save(device);
  }

  /**
   * Update connection status
   */
  async updateConnectionStatus(
    id: string,
    tenantId: string,
    connectionStatus: {
      isConnected: boolean;
      lastTestedAt?: Date;
      lastError?: string;
      latencyMs?: number;
    },
  ): Promise<VfdDevice> {
    const device = await this.findById(id, tenantId);
    device.connectionStatus = {
      ...device.connectionStatus,
      ...connectionStatus,
    };
    device.updatedAt = new Date();

    return this.vfdDeviceRepository.save(device);
  }

  /**
   * Activate a device (change status from DRAFT/TEST_FAILED to ACTIVE)
   */
  async activate(id: string, tenantId: string): Promise<VfdDevice> {
    const device = await this.findById(id, tenantId);

    if (device.status === VfdDeviceStatus.ACTIVE) {
      return device;
    }

    if (!device.connectionStatus?.isConnected) {
      throw new BadRequestException('Device must pass connection test before activation');
    }

    device.status = VfdDeviceStatus.ACTIVE;
    device.updatedAt = new Date();

    return this.vfdDeviceRepository.save(device);
  }

  /**
   * Deactivate a device
   */
  async deactivate(id: string, tenantId: string): Promise<VfdDevice> {
    return this.updateStatus(id, tenantId, VfdDeviceStatus.SUSPENDED);
  }

  /**
   * Get device count by status
   */
  async getCountByStatus(tenantId: string): Promise<Record<VfdDeviceStatus, number>> {
    const counts = await this.vfdDeviceRepository
      .createQueryBuilder('vfd')
      .select('vfd.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('vfd.tenantId = :tenantId', { tenantId })
      .groupBy('vfd.status')
      .getRawMany<StatusCountResult>();

    const result: Record<string, number> = {};
    for (const status of Object.values(VfdDeviceStatus)) {
      result[status] = 0;
    }
    for (const row of counts) {
      result[row.status] = parseInt(row.count, 10);
    }

    return result as Record<VfdDeviceStatus, number>;
  }

  /**
   * Get devices by farm
   */
  async findByFarm(farmId: string, tenantId: string): Promise<VfdDevice[]> {
    return this.vfdDeviceRepository.find({
      where: { farmId, tenantId },
      order: { name: 'ASC' },
    });
  }

  /**
   * Drives serving a unit — resolved through the attested binding.
   *
   * The old form read a `tank_id` column an operator typed. That column is gone,
   * so this can no longer return a drive that merely CLAIMS to serve the unit: it
   * returns drives whose driven equipment the owning service says serves it. A
   * drive on a pump is correctly absent.
   */
  async findByTank(tankId: string, tenantId: string): Promise<VfdDevice[]> {
    return this.vfdDeviceRepository
      .createQueryBuilder('vfd')
      .where('vfd.tenantId = :tenantId', { tenantId })
      .andWhere(
        `EXISTS (
           SELECT 1 FROM vfd_drive_binding_units u
            WHERE u.vfd_device_id = vfd.id
              AND u.tenant_id = vfd."tenant_id"
              AND u.unit_id = :tankId
         )`,
        { tankId },
      )
      .orderBy('vfd.name', 'ASC')
      .getMany();
  }

  /**
   * Get fleet-level statistics: total, active, inactive, faulted, maintenance,
   * counts by brand, protocol, and status.
   */
  async getStats(tenantId: string): Promise<{
    total: number;
    active: number;
    inactive: number;
    faulted: number;
    maintenance: number;
    byBrand: Record<string, number>;
    byProtocol: Record<string, number>;
    byStatus: Record<string, number>;
  }> {
    // Get counts by status
    const statusCounts = await this.vfdDeviceRepository
      .createQueryBuilder('vfd')
      .select('vfd.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('vfd.tenantId = :tenantId', { tenantId })
      .groupBy('vfd.status')
      .getRawMany<StatusCountResult>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const status of Object.values(VfdDeviceStatus)) {
      byStatus[status] = 0;
    }
    for (const row of statusCounts) {
      const cnt = parseInt(row.count, 10);
      byStatus[row.status] = cnt;
      total += cnt;
    }

    // Get counts by brand
    const brandCounts = await this.vfdDeviceRepository
      .createQueryBuilder('vfd')
      .select('vfd.brand', 'brand')
      .addSelect('COUNT(*)', 'count')
      .where('vfd.tenantId = :tenantId', { tenantId })
      .groupBy('vfd.brand')
      .getRawMany<{ brand: string; count: string }>();

    const byBrand: Record<string, number> = {};
    for (const brand of Object.values(VfdBrand)) {
      byBrand[brand] = 0;
    }
    for (const row of brandCounts) {
      byBrand[row.brand] = parseInt(row.count, 10);
    }

    // Get counts by protocol
    const protocolCounts = await this.vfdDeviceRepository
      .createQueryBuilder('vfd')
      .select('vfd.protocol', 'protocol')
      .addSelect('COUNT(*)', 'count')
      .where('vfd.tenantId = :tenantId', { tenantId })
      .groupBy('vfd.protocol')
      .getRawMany<{ protocol: string; count: string }>();

    const byProtocol: Record<string, number> = {};
    for (const protocol of Object.values(VfdProtocol)) {
      byProtocol[protocol] = 0;
    }
    for (const row of protocolCounts) {
      byProtocol[row.protocol] = parseInt(row.count, 10);
    }

    // Map to frontend status categories
    const active = byStatus[VfdDeviceStatus.ACTIVE] || 0;
    const inactive =
      (byStatus[VfdDeviceStatus.SUSPENDED] || 0) + (byStatus[VfdDeviceStatus.OFFLINE] || 0);
    const faulted = byStatus[VfdDeviceStatus.TEST_FAILED] || 0;
    const maintenance =
      (byStatus[VfdDeviceStatus.DRAFT] || 0) +
      (byStatus[VfdDeviceStatus.PENDING_TEST] || 0) +
      (byStatus[VfdDeviceStatus.TESTING] || 0);

    return {
      total,
      active,
      inactive,
      faulted,
      maintenance,
      byBrand,
      byProtocol,
      byStatus,
    };
  }

  /**
   * SENSOR-CRITICAL-007: the edge-delegated write path addresses a drive by its
   * owning edge gateway (edgeDeviceId → MQTT command topic) AND the Modbus
   * `device` name that gateway exposes for it. One without the other cannot
   * route a write_modbus envelope, so the pair is enforced both-or-neither at
   * every write (create + update) — a half-bound record is rejected rather than
   * silently stored and later found undispatchable.
   */
  private validateEdgeBinding(
    edgeDeviceId: string | null | undefined,
    edgeModbusDeviceName: string | null | undefined,
  ): void {
    const hasGateway = edgeDeviceId != null && edgeDeviceId !== '';
    const hasDeviceName = edgeModbusDeviceName != null && edgeModbusDeviceName.trim() !== '';
    if (hasGateway !== hasDeviceName) {
      throw new BadRequestException(
        'Edge binding requires both edgeDeviceId and edgeModbusDeviceName together, or neither',
      );
    }
  }

  /**
   * Validate protocol configuration
   */
  private validateProtocolConfiguration(
    protocol: VfdProtocol,
    config: Record<string, unknown>,
  ): void {
    // Basic validation - more comprehensive validation is done by adapters
    if (!config || typeof config !== 'object') {
      throw new BadRequestException('Protocol configuration must be an object');
    }

    switch (protocol) {
      case VfdProtocol.MODBUS_RTU:
        if (!config['serialPort'] || !config['slaveId']) {
          throw new BadRequestException('Modbus RTU requires serialPort and slaveId');
        }
        break;

      case VfdProtocol.MODBUS_TCP:
        if (!config['host']) {
          throw new BadRequestException('Modbus TCP requires host');
        }
        break;

      case VfdProtocol.PROFIBUS_DP:
        if (!config['slaveAddress']) {
          throw new BadRequestException('PROFIBUS DP requires slaveAddress');
        }
        break;

      case VfdProtocol.PROFINET:
        if (!config['deviceName'] || !config['ipAddress']) {
          throw new BadRequestException('PROFINET requires deviceName and ipAddress');
        }
        break;

      case VfdProtocol.ETHERNET_IP:
        if (!config['host']) {
          throw new BadRequestException('EtherNet/IP requires host');
        }
        break;

      case VfdProtocol.CANOPEN:
        if (!config['interface'] || config['nodeId'] === undefined) {
          throw new BadRequestException('CANopen requires interface and nodeId');
        }
        break;

      case VfdProtocol.BACNET_IP:
      case VfdProtocol.BACNET_MSTP:
        if (config['deviceInstance'] === undefined) {
          throw new BadRequestException('BACnet requires deviceInstance');
        }
        break;
    }

    // SENSOR-HIGH-020: the register mutation validates protocolConfiguration
    // against the permissive flat union DTO (every field optional, almost no
    // Min/Max/@IsIP), so out-of-range baudRate/slaveId/unitId and malformed
    // hosts persist and only fail at the adapter/device layer. Run the strict
    // per-protocol DTO's class-validator here, keyed on protocol, so bounds and
    // formats are enforced at the boundary.
    this.validateAgainstStrictProtocolDto(protocol, config);
  }

  /**
   * SENSOR-HIGH-020: validate the raw config against the strict per-protocol
   * DTO (range/enum/IP constraints). Throws BadRequestException with the
   * flattened constraint messages on any violation.
   */
  private validateAgainstStrictProtocolDto(
    protocol: VfdProtocol,
    config: Record<string, unknown>,
  ): void {
    const dtoByProtocol: Partial<Record<VfdProtocol, new () => object>> = {
      [VfdProtocol.MODBUS_RTU]: ModbusRtuConfigDto,
      [VfdProtocol.MODBUS_TCP]: ModbusTcpConfigDto,
      [VfdProtocol.PROFINET]: ProfinetConfigDto,
      [VfdProtocol.ETHERNET_IP]: EthernetIpConfigDto,
      [VfdProtocol.CANOPEN]: CanopenConfigDto,
      [VfdProtocol.BACNET_IP]: BacnetIpConfigDto,
      [VfdProtocol.BACNET_MSTP]: BacnetMstpConfigDto,
      [VfdProtocol.PROFIBUS_DP]: ProfibusDpConfigDto,
    };

    const DtoClass = dtoByProtocol[protocol];
    if (!DtoClass) {
      return; // no strict schema for this protocol — presence check above applies
    }

    const instance = plainToInstance(DtoClass, config, {
      // protocolConfiguration is a JSON scalar; coerce numeric strings so a
      // well-formed "502" is not spuriously rejected — out-of-range values
      // still fail the Min/Max constraints.
      enableImplicitConversion: true,
    });
    const errors = validateSync(instance as object, {
      whitelist: false,
      forbidNonWhitelisted: false,
    });

    if (errors.length > 0) {
      throw new BadRequestException(
        `Invalid ${protocol} configuration: ${this.flattenValidationErrors(errors).join('; ')}`,
      );
    }
  }

  private flattenValidationErrors(errors: ValidationError[]): string[] {
    const messages: string[] = [];
    for (const err of errors) {
      if (err.constraints) {
        messages.push(...Object.values(err.constraints));
      }
      if (err.children && err.children.length > 0) {
        messages.push(...this.flattenValidationErrors(err.children));
      }
    }
    return messages;
  }
}
