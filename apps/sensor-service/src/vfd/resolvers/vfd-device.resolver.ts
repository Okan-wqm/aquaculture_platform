import { Resolver, Query, Mutation, Args, ID, Context, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { VfdDeviceService } from '../services/vfd-device.service';
import { VfdConnectionTesterService } from '../services/vfd-connection-tester.service';
import { VfdDataReaderService } from '../services/vfd-data-reader.service';
import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdReading } from '../entities/vfd-reading.entity';
import { VfdBrand, VfdProtocol, VfdDeviceStatus } from '../entities/vfd.enums';
import {
  VfdDeviceFilterDto,
  VfdPaginationDto,
  RegisterVfdDto,
  UpdateVfdDto,
} from '../dto';

/**
 * VFD Device GraphQL Resolver
 */
@Resolver(() => VfdDevice)
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
    @Context() context: { tenantId: string }
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.findById(id, context.tenantId);
  }

  /**
   * Get all VFD devices with filtering and pagination
   */
  @Query(() => [VfdDevice], { name: 'vfdDevices' })
  async getVfdDevices(
    @Args('filter', { type: () => VfdDeviceFilterDto, nullable: true }) filter: VfdDeviceFilterDto,
    @Args('pagination', { type: () => VfdPaginationDto, nullable: true }) pagination: VfdPaginationDto,
    @Context() context: { tenantId: string }
  ) {
    return this.vfdDeviceService.findAll(context.tenantId, filter, pagination);
  }

  /**
   * Get VFD devices by farm
   */
  @Query(() => [VfdDevice], { name: 'vfdDevicesByFarm' })
  async getVfdDevicesByFarm(
    @Args('farmId', { type: () => ID }) farmId: string,
    @Context() context: { tenantId: string }
  ): Promise<VfdDevice[]> {
    return this.vfdDeviceService.findByFarm(farmId, context.tenantId);
  }

  /**
   * Get VFD devices by tank
   */
  @Query(() => [VfdDevice], { name: 'vfdDevicesByTank' })
  async getVfdDevicesByTank(
    @Args('tankId', { type: () => ID }) tankId: string,
    @Context() context: { tenantId: string }
  ): Promise<VfdDevice[]> {
    return this.vfdDeviceService.findByTank(tankId, context.tenantId);
  }

  /**
   * Get VFD device count by status
   */
  @Query(() => String, { name: 'vfdDeviceCountByStatus', description: 'Returns JSON object with status counts' })
  async getVfdDeviceCountByStatus(
    @Context() context: { tenantId: string }
  ): Promise<string> {
    const counts = await this.vfdDeviceService.getCountByStatus(context.tenantId);
    return JSON.stringify(counts);
  }

  /**
   * Register a new VFD device
   */
  @Mutation(() => VfdDevice, { name: 'registerVfdDevice' })
  async registerVfdDevice(
    @Args('input', { type: () => RegisterVfdDto }) input: RegisterVfdDto,
    @Context() context: { tenantId: string }
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.create(input as any, context.tenantId);
  }

  /**
   * Update a VFD device
   */
  @Mutation(() => VfdDevice, { name: 'updateVfdDevice' })
  async updateVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { type: () => UpdateVfdDto }) input: UpdateVfdDto,
    @Context() context: { tenantId: string }
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.update(id, context.tenantId, input as any);
  }

  /**
   * Delete a VFD device
   */
  @Mutation(() => Boolean, { name: 'deleteVfdDevice' })
  async deleteVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: { tenantId: string }
  ): Promise<boolean> {
    return this.vfdDeviceService.delete(id, context.tenantId);
  }

  /**
   * Test connection for a VFD device
   */
  @Mutation(() => Boolean, { name: 'testVfdConnection' })
  async testVfdConnection(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: { tenantId: string }
  ): Promise<boolean> {
    const result = await this.connectionTesterService.testDeviceConnection(id, context.tenantId);
    return result.success;
  }

  /**
   * Activate a VFD device
   */
  @Mutation(() => VfdDevice, { name: 'activateVfdDevice' })
  async activateVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: { tenantId: string }
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.activate(id, context.tenantId);
  }

  /**
   * Deactivate a VFD device
   */
  @Mutation(() => VfdDevice, { name: 'deactivateVfdDevice' })
  async deactivateVfdDevice(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: { tenantId: string }
  ): Promise<VfdDevice> {
    return this.vfdDeviceService.deactivate(id, context.tenantId);
  }

  /**
   * Resolve latest reading for a device
   */
  @ResolveField(() => VfdReading, { name: 'latestReading', nullable: true })
  async getLatestReading(
    @Parent() device: VfdDevice,
    @Context() context: { tenantId: string }
  ): Promise<VfdReading | null> {
    return this.dataReaderService.getLatestReading(device.id, context.tenantId);
  }
}
