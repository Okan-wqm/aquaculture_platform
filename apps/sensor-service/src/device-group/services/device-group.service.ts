import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { Sensor, SensorStatus } from '../../database/entities/sensor.entity';
import { EdgeDevice } from '../../edge-device/entities/edge-device.entity';
import { VfdDevice } from '../../vfd/entities/vfd-device.entity';
import { DeviceGroup, DeviceGroupType } from '../entities/device-group.entity';
import { DeviceGroupMember, DeviceMemberType } from '../entities/device-group-member.entity';

/**
 * Input for creating a device group
 */
export interface CreateDeviceGroupInput {
  name: string;
  description?: string;
  type?: DeviceGroupType;
  parentGroupId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating a device group
 */
export interface UpdateDeviceGroupInput {
  name?: string;
  description?: string;
  type?: DeviceGroupType;
  parentGroupId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for adding a member to a group
 */
export interface AddMemberInput {
  deviceType: DeviceMemberType;
  deviceId: string;
}

/**
 * Input for batch-updating sensor fields
 */
export interface BatchUpdateSensorsInput {
  siteId?: string;
  departmentId?: string;
  systemId?: string;
  equipmentId?: string;
  status?: SensorStatus;
  isActive?: boolean;
}

/**
 * Device Group Service
 * Manages device groups and batch operations on devices
 */
@Injectable()
export class DeviceGroupService {
  private readonly logger = new Logger(DeviceGroupService.name);

  constructor(
    @InjectRepository(DeviceGroup)
    private readonly groupRepository: Repository<DeviceGroup>,
    @InjectRepository(DeviceGroupMember)
    private readonly memberRepository: Repository<DeviceGroupMember>,
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @InjectRepository(EdgeDevice)
    private readonly edgeDeviceRepository: Repository<EdgeDevice>,
    @InjectRepository(VfdDevice)
    private readonly vfdDeviceRepository: Repository<VfdDevice>,
  ) {}

  /**
   * SENSOR-MEDIUM-007: verify every selected member's deviceId belongs to the
   * caller's tenant before it is persisted as a group member. Without this a
   * TENANT_ADMIN could store references to another tenant's (or guessed)
   * device UUIDs — a tenant-boundary violation that becomes a data leak the
   * moment any member resolver does an id-only lookup.
   */
  private async assertMembersOwnedByTenant(
    members: AddMemberInput[],
    tenantId: string,
  ): Promise<void> {
    const idsByType = new Map<DeviceMemberType, Set<string>>();
    for (const m of members) {
      if (!idsByType.has(m.deviceType)) idsByType.set(m.deviceType, new Set());
      idsByType.get(m.deviceType)!.add(m.deviceId);
    }

    for (const [deviceType, idSet] of idsByType) {
      const ids = [...idSet];
      let foundCount: number;
      switch (deviceType) {
        case DeviceMemberType.SENSOR:
          foundCount = await this.sensorRepository.count({ where: { id: In(ids), tenantId } });
          break;
        case DeviceMemberType.EDGE_DEVICE:
          foundCount = await this.edgeDeviceRepository.count({ where: { id: In(ids), tenantId } });
          break;
        case DeviceMemberType.VFD_DEVICE:
          foundCount = await this.vfdDeviceRepository.count({ where: { id: In(ids), tenantId } });
          break;
        default:
          // Unsupported member type (e.g. PLC_CONNECTION) — reject rather than
          // silently trusting an unvalidated device reference.
          throw new BadRequestException(
            `Unsupported device member type for ownership validation: ${deviceType}`,
          );
      }
      if (foundCount !== ids.length) {
        throw new BadRequestException(
          `One or more ${deviceType} members do not belong to this tenant`,
        );
      }
    }
  }

  /**
   * Create a new device group
   */
  async create(tenantId: string, input: CreateDeviceGroupInput): Promise<DeviceGroup> {
    this.logger.log(`Creating device group "${input.name}" for tenant ${tenantId}`);

    // Validate parent group belongs to the same tenant
    if (input.parentGroupId) {
      const parent = await this.groupRepository.findOne({
        where: { id: input.parentGroupId, tenantId },
      });

      if (!parent) {
        throw new NotFoundException(
          `Parent group with ID ${input.parentGroupId} not found`,
        );
      }
    }

    const group = this.groupRepository.create({
      ...input,
      tenantId,
      type: input.type ?? DeviceGroupType.CUSTOM,
    });

    return await this.groupRepository.save(group);
  }

  /**
   * Find all groups for a tenant
   */
  async findAll(tenantId: string): Promise<DeviceGroup[]> {
    return await this.groupRepository.find({
      where: { tenantId },
      order: { name: 'ASC' },
    });
  }

  /**
   * Find a single group by ID (tenant-isolated)
   */
  async findOne(id: string, tenantId: string): Promise<DeviceGroup> {
    const group = await this.groupRepository.findOne({
      where: { id, tenantId },
    });

    if (!group) {
      throw new NotFoundException(`Device group with ID ${id} not found`);
    }

    return group;
  }

  /**
   * Update a device group
   */
  async update(
    id: string,
    tenantId: string,
    input: UpdateDeviceGroupInput,
  ): Promise<DeviceGroup> {
    const group = await this.findOne(id, tenantId);

    // Validate new parent belongs to the same tenant and detect circular references
    if (input.parentGroupId !== undefined && input.parentGroupId !== null) {
      if (input.parentGroupId === id) {
        throw new BadRequestException('A group cannot be its own parent');
      }

      const parent = await this.groupRepository.findOne({
        where: { id: input.parentGroupId, tenantId },
      });

      if (!parent) {
        throw new NotFoundException(
          `Parent group with ID ${input.parentGroupId} not found`,
        );
      }

      // Walk ancestor chain to detect cycles
      let currentParentId: string | null | undefined = input.parentGroupId;
      const visited = new Set<string>([id]);
      while (currentParentId) {
        if (visited.has(currentParentId)) {
          throw new BadRequestException('Circular reference detected in group hierarchy');
        }
        visited.add(currentParentId);
        const ancestor = await this.groupRepository.findOne({ where: { id: currentParentId, tenantId } });
        currentParentId = ancestor?.parentGroupId;
      }
    }

    Object.assign(group, input);

    return await this.groupRepository.save(group);
  }

  /**
   * Delete a device group
   */
  async delete(id: string, tenantId: string): Promise<boolean> {
    const group = await this.findOne(id, tenantId);

    await this.groupRepository.remove(group);

    return true;
  }

  /**
   * Add members to a group in bulk
   */
  async addMembers(
    groupId: string,
    tenantId: string,
    members: AddMemberInput[],
  ): Promise<DeviceGroupMember[]> {
    // Verify group exists and belongs to tenant
    await this.findOne(groupId, tenantId);

    if (members.length === 0) {
      return [];
    }

    // SENSOR-MEDIUM-007: every member device must belong to this tenant.
    await this.assertMembersOwnedByTenant(members, tenantId);

    const entities = members.map((m) =>
      this.memberRepository.create({
        groupId,
        deviceType: m.deviceType,
        deviceId: m.deviceId,
      }),
    );

    // upsert-style: ignore conflicts on (groupId, deviceType, deviceId) unique constraint
    try {
      return await this.memberRepository.save(entities);
    } catch (error) {
      this.logger.warn(
        `Some members may already exist in group ${groupId}: ${(error as Error).message}`,
      );
      // Re-fetch after partial save
      return await this.getGroupMembers(groupId, tenantId);
    }
  }

  /**
   * Remove specific members from a group by member IDs
   */
  async removeMembers(
    groupId: string,
    tenantId: string,
    memberIds: string[],
  ): Promise<boolean> {
    // Verify group exists and belongs to tenant
    await this.findOne(groupId, tenantId);

    if (memberIds.length === 0) {
      return true;
    }

    await this.memberRepository.delete({
      groupId,
      id: In(memberIds),
    });

    return true;
  }

  /**
   * Get all members of a group
   */
  async getGroupMembers(
    groupId: string,
    tenantId: string,
  ): Promise<DeviceGroupMember[]> {
    // Verify group exists and belongs to tenant
    await this.findOne(groupId, tenantId);

    return await this.memberRepository.find({
      where: { groupId },
      order: { addedAt: 'ASC' },
    });
  }

  /**
   * Get members directly for a DeviceGroup entity (used by field resolver)
   */
  async getMembersForGroup(groupId: string): Promise<DeviceGroupMember[]> {
    return await this.memberRepository.find({
      where: { groupId },
      order: { addedAt: 'ASC' },
    });
  }

  /**
   * Batch update sensor fields for multiple sensors
   */
  async batchUpdateSensors(
    tenantId: string,
    sensorIds: string[],
    input: BatchUpdateSensorsInput,
  ): Promise<boolean> {
    if (sensorIds.length === 0) {
      return true;
    }

    this.logger.log(
      `Batch updating ${sensorIds.length} sensors for tenant ${tenantId}`,
    );

    const sensors = await this.sensorRepository.find({
      where: { id: In(sensorIds), tenantId },
    });

    if (sensors.length === 0) {
      return true;
    }

    const updates: Partial<Sensor> = {};
    if (input.siteId !== undefined) updates.siteId = input.siteId;
    if (input.departmentId !== undefined) updates.departmentId = input.departmentId;
    if (input.systemId !== undefined) updates.systemId = input.systemId;
    if (input.equipmentId !== undefined) updates.equipmentId = input.equipmentId;
    if (input.status !== undefined) updates.status = input.status;
    if (input.isActive !== undefined) updates.isActive = input.isActive;

    const updated = sensors.map((sensor) => Object.assign(sensor, updates));
    await this.sensorRepository.save(updated);

    return true;
  }

  /**
   * Batch activate sensors (set isActive=true, status=ACTIVE)
   */
  async batchActivateDevices(
    tenantId: string,
    sensorIds: string[],
  ): Promise<boolean> {
    return this.batchUpdateSensors(tenantId, sensorIds, {
      isActive: true,
      status: SensorStatus.ACTIVE,
    });
  }

  /**
   * Batch deactivate sensors (set isActive=false, status=INACTIVE)
   */
  async batchDeactivateDevices(
    tenantId: string,
    sensorIds: string[],
  ): Promise<boolean> {
    return this.batchUpdateSensors(tenantId, sensorIds, {
      isActive: false,
      status: SensorStatus.INACTIVE,
    });
  }

  /**
   * Move devices to a group: removes them from any other groups,
   * then adds them to the target group.
   */
  async moveDevicesToGroup(
    groupId: string,
    tenantId: string,
    members: AddMemberInput[],
  ): Promise<DeviceGroupMember[]> {
    // Verify target group exists and belongs to tenant
    await this.findOne(groupId, tenantId);

    if (members.length === 0) {
      return [];
    }

    // SENSOR-MEDIUM-007: every member device must belong to this tenant.
    await this.assertMembersOwnedByTenant(members, tenantId);

    // Remove each device from all groups belonging to this tenant only (not cross-tenant)
    const tenantGroups = await this.groupRepository.find({ where: { tenantId }, select: ['id'] });
    const tenantGroupIds = tenantGroups.map(g => g.id);
    if (tenantGroupIds.length > 0) {
      for (const member of members) {
        await this.memberRepository.delete({
          deviceType: member.deviceType,
          deviceId: member.deviceId,
          groupId: In(tenantGroupIds),
        });
      }
    }

    // Add to the new group
    return this.addMembers(groupId, tenantId, members);
  }
}
