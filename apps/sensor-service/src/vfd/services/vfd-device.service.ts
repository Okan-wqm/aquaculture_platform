import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';

interface StatusCountResult {
  status: string;
  count: string;
}

import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdBrand, VfdProtocol, VfdDeviceStatus } from '../entities/vfd.enums';

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
  tankId?: string;
  tags?: string[];
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
  tankId?: string;
  tags?: string[];
  status?: VfdDeviceStatus;
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
 * Paginated result
 */
export interface PaginatedVfdDevices {
  items: VfdDevice[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
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
    private readonly vfdDeviceRepository: Repository<VfdDevice>
  ) {}

  /**
   * Create a new VFD device
   */
  async create(input: CreateVfdDeviceInput, tenantId: string): Promise<VfdDevice> {
    this.logger.log(`Creating VFD device: ${input.name} for tenant ${tenantId}`);

    // Validate protocol configuration
    this.validateProtocolConfiguration(input.protocol, input.protocolConfiguration);

    const deviceData: DeepPartial<VfdDevice> = {
      ...input,
      tenantId,
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
    pagination?: PaginationInput
  ): Promise<PaginatedVfdDevices> {
    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const skip = (page - 1) * limit;

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
      queryBuilder.andWhere('vfd.tankId = :tankId', { tankId: filter.tankId });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(vfd.name ILIKE :search OR vfd.model ILIKE :search OR vfd.serialNumber ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Apply sorting
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';
    queryBuilder.orderBy(`vfd.${sortBy}`, sortOrder);

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
   * Update a VFD device
   */
  async update(
    id: string,
    tenantId: string,
    input: UpdateVfdDeviceInput
  ): Promise<VfdDevice> {
    const device = await this.findById(id, tenantId);

    // Validate protocol configuration if being updated
    if (input.protocol && input.protocolConfiguration) {
      this.validateProtocolConfiguration(input.protocol, input.protocolConfiguration);
    } else if (input.protocolConfiguration && !input.protocol) {
      this.validateProtocolConfiguration(device.protocol, input.protocolConfiguration);
    }

    // Update fields
    Object.assign(device, input);
    device.updatedAt = new Date();

    const updatedDevice = await this.vfdDeviceRepository.save(device);
    this.logger.log(`VFD device ${id} updated`);

    return updatedDevice;
  }

  /**
   * Delete a VFD device
   */
  async delete(id: string, tenantId: string): Promise<boolean> {
    const device = await this.findById(id, tenantId);

    await this.vfdDeviceRepository.remove(device);
    this.logger.log(`VFD device ${id} deleted`);

    return true;
  }

  /**
   * Update device status
   */
  async updateStatus(
    id: string,
    tenantId: string,
    status: VfdDeviceStatus
  ): Promise<VfdDevice> {
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
    }
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
   * Get devices by tank
   */
  async findByTank(tankId: string, tenantId: string): Promise<VfdDevice[]> {
    return this.vfdDeviceRepository.find({
      where: { tankId, tenantId },
      order: { name: 'ASC' },
    });
  }

  /**
   * Validate protocol configuration
   */
  private validateProtocolConfiguration(
    protocol: VfdProtocol,
    config: Record<string, unknown>
  ): void {
    // Basic validation - more comprehensive validation is done by adapters
    if (!config || typeof config !== 'object') {
      throw new BadRequestException('Protocol configuration must be an object');
    }

    switch (protocol) {
      case VfdProtocol.MODBUS_RTU:
        if (!config.serialPort || !config.slaveId) {
          throw new BadRequestException(
            'Modbus RTU requires serialPort and slaveId'
          );
        }
        break;

      case VfdProtocol.MODBUS_TCP:
        if (!config.host) {
          throw new BadRequestException('Modbus TCP requires host');
        }
        break;

      case VfdProtocol.PROFIBUS_DP:
        if (!config.slaveAddress) {
          throw new BadRequestException('PROFIBUS DP requires slaveAddress');
        }
        break;

      case VfdProtocol.PROFINET:
        if (!config.deviceName || !config.ipAddress) {
          throw new BadRequestException(
            'PROFINET requires deviceName and ipAddress'
          );
        }
        break;

      case VfdProtocol.ETHERNET_IP:
        if (!config.host) {
          throw new BadRequestException('EtherNet/IP requires host');
        }
        break;

      case VfdProtocol.CANOPEN:
        if (!config.interface || config.nodeId === undefined) {
          throw new BadRequestException('CANopen requires interface and nodeId');
        }
        break;

      case VfdProtocol.BACNET_IP:
      case VfdProtocol.BACNET_MSTP:
        if (config.deviceInstance === undefined) {
          throw new BadRequestException('BACnet requires deviceInstance');
        }
        break;
    }
  }
}
