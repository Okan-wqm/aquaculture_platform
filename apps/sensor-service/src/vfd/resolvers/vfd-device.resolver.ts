import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { Roles, Role, TenantGuard, Tenant } from '@platform/backend-common';

import {
  VfdDeviceFilterDto,
  VfdPaginationDto,
  RegisterVfdDto,
  UpdateVfdDto,
} from '../dto';
import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdReading } from '../entities/vfd-reading.entity';
import { VfdConnectionTesterService } from '../services/vfd-connection-tester.service';
import { VfdDataReaderService } from '../services/vfd-data-reader.service';
import { VfdDeviceService, CreateVfdDeviceInput, UpdateVfdDeviceInput } from '../services/vfd-device.service';

/**
 * VFD Device GraphQL Resolver
 */
@Resolver(() => VfdDevice)
@UseGuards(TenantGuard)
export class VfdDeviceResolver {
  constructor(
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly connectionTesterService: VfdConnectionTesterService,
    private readonly dataReaderService: VfdDataReaderService
  ) {}

  /**
   * Get a single VFD device by ID
   */
  @Query(() => VfdDevice, { name: 'vfdDevice', nullable: true })
  async getVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.findById(id, tenantId);
  }

  /**
   * Get all VFD devices with filtering and pagination
   */
  @Query(() => [VfdDevice], { name: 'vfdDevices' })
  async getVfdDevices(
    @Args('filter', { type: () => VfdDeviceFilterDto, nullable: true }) filter: VfdDeviceFilterDto,
    @Args('pagination', { type: () => VfdPaginationDto, nullable: true }) pagination: VfdPaginationDto,
    @Tenant() tenantId: string
  ) {
    return this.vfdDeviceService.findAll(tenantId, filter, pagination);
  }

  /**
   * Get VFD devices by farm
   */
  @Query(() => [VfdDevice], { name: 'vfdDevicesByFarm' })
  async getVfdDevicesByFarm(
    @Args('farmId', { type: () => ID }) farmId: string,
    @Tenant() tenantId: string
  ): Promise<VfdDevice[]> {
    return this.vfdDeviceService.findByFarm(farmId, tenantId);
  }

  /**
   * Get VFD devices by tank
   */
  @Query(() => [VfdDevice], { name: 'vfdDevicesByTank' })
  async getVfdDevicesByTank(
    @Args('tankId', { type: () => ID }) tankId: string,
    @Tenant() tenantId: string
  ): Promise<VfdDevice[]> {
    return this.vfdDeviceService.findByTank(tankId, tenantId);
  }

  /**
   * Get VFD device count by status
   */
  @Query(() => String, { name: 'vfdDeviceCountByStatus', description: 'Returns JSON object with status counts' })
  async getVfdDeviceCountByStatus(
    @Tenant() tenantId: string
  ): Promise<string> {
    const counts = await this.vfdDeviceService.getCountByStatus(tenantId);
    return JSON.stringify(counts);
  }

  /**
   * Register a new VFD device
   * SECURITY: Requires elevated permissions - creates industrial equipment entry
   */
  @Mutation(() => VfdDevice, { name: 'registerVfdDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async registerVfdDevice(
    @Args('input', { type: () => RegisterVfdDto }) input: RegisterVfdDto,
    @Tenant() tenantId: string
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.create(input as CreateVfdDeviceInput, tenantId);
  }

  /**
   * Update a VFD device
   * SECURITY: Requires elevated permissions - modifies industrial equipment config
   */
  @Mutation(() => VfdDevice, { name: 'updateVfdDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { type: () => UpdateVfdDto }) input: UpdateVfdDto,
    @Tenant() tenantId: string
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.update(id, tenantId, input as UpdateVfdDeviceInput);
  }

  /**
   * Delete a VFD device
   * SECURITY: Requires TENANT_ADMIN - permanent deletion of industrial equipment
   */
  @Mutation(() => Boolean, { name: 'deleteVfdDevice' })
  @Roles(Role.TENANT_ADMIN)
  async deleteVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string
  ): Promise<boolean> {
    return this.vfdDeviceService.delete(id, tenantId);
  }

  /**
   * Test connection for a VFD device
   * SECURITY: Requires elevated permissions - tests industrial equipment connectivity
   */
  @Mutation(() => Boolean, { name: 'testVfdConnection' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async testVfdConnection(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string
  ): Promise<boolean> {
    const result = await this.connectionTesterService.testDeviceConnection(id, tenantId);
    return result.success;
  }

  /**
   * Activate a VFD device
   * SECURITY: Requires elevated permissions - enables industrial equipment
   */
  @Mutation(() => VfdDevice, { name: 'activateVfdDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async activateVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.activate(id, tenantId);
  }

  /**
   * Deactivate a VFD device
   * SECURITY: Requires elevated permissions - disables industrial equipment
   */
  @Mutation(() => VfdDevice, { name: 'deactivateVfdDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deactivateVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.deactivate(id, tenantId);
  }

  /**
   * Resolve latest reading for a device
   */
  @ResolveField(() => VfdReading, { name: 'latestReading', nullable: true })
  async getLatestReading(
    @Parent() device: VfdDevice,
    @Tenant() tenantId: string
  ): Promise<VfdReading | null> {
    return this.dataReaderService.getLatestReading(device.id, tenantId);
  }
}
