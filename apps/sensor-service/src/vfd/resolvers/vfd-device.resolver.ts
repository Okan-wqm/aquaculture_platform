import { UseGuards, Logger } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { Roles, Role, Tenant, CurrentUser } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';

import {
  VfdDeviceFilterDto,
  VfdPaginationDto,
  RegisterVfdDto,
  UpdateVfdDto,
  PaginatedVfdDeviceListDto,
  VfdRegistrationResultDto,
  TestVfdConnectionInputDto,
  VfdConnectionTestResultDto,
  VfdStatsDto,
  VfdDrivenUnitOutcome,
  VfdDrivenUnitResolutionDto,
} from '../dto';
import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdDriveBinding } from '../entities/vfd-drive-binding.entity';
import { VfdReading } from '../entities/vfd-reading.entity';
import { VfdConnectionTesterService } from '../services/vfd-connection-tester.service';
import { VfdDataReaderService } from '../services/vfd-data-reader.service';
import { VfdDeviceService, CreateVfdDeviceInput, UpdateVfdDeviceInput } from '../services/vfd-device.service';
import {
  DrivenUnitResolution,
  VfdDriveBindingService,
} from '../services/vfd-drive-binding.service';

/**
 * VFD Device GraphQL Resolver
 */
@Resolver(() => VfdDevice)
@UseGuards(TenantGuard)
export class VfdDeviceResolver {
  private readonly logger = new Logger(VfdDeviceResolver.name);

  constructor(
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly connectionTesterService: VfdConnectionTesterService,
    private readonly dataReaderService: VfdDataReaderService,
    private readonly driveBindingService: VfdDriveBindingService
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
   * Get all VFD devices with filtering and pagination.
   * Returns paginated wrapper with { items, total, page, limit, totalPages }.
   */
  @Query(() => PaginatedVfdDeviceListDto, { name: 'vfdDevices' })
  async getVfdDevices(
    @Args('filter', { type: () => VfdDeviceFilterDto, nullable: true }) filter: VfdDeviceFilterDto,
    @Args('pagination', { type: () => VfdPaginationDto, nullable: true }) pagination: VfdPaginationDto,
    @Tenant() tenantId: string
  ): Promise<PaginatedVfdDeviceListDto> {
    const result = await this.vfdDeviceService.findAll(tenantId, filter, pagination);
    return result as PaginatedVfdDeviceListDto;
  }

  /**
   * Get VFD fleet statistics.
   * Returns { total, active, inactive, faulted, maintenance, byBrand, byProtocol, byStatus }.
   */
  @Query(() => VfdStatsDto, { name: 'vfdStats' })
  async getVfdStats(
    @Tenant() tenantId: string
  ): Promise<VfdStatsDto> {
    return this.vfdDeviceService.getStats(tenantId);
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
   * Register a new VFD device.
   * Returns VfdRegistrationResult with { success, vfdDevice, error, connectionTestPassed, latencyMs }.
   * Optionally tests connection during registration.
   *
   * SECURITY: Requires elevated permissions - creates industrial equipment entry
   */
  @Mutation(() => VfdRegistrationResultDto, { name: 'registerVfdDevice' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async registerVfdDevice(
    @Args('input', { type: () => RegisterVfdDto }) input: RegisterVfdDto,
    @Tenant() tenantId: string
  ): Promise<VfdRegistrationResultDto> {
    try {
      const device = await this.vfdDeviceService.create(input as CreateVfdDeviceInput, tenantId);

      let connectionTestPassed: boolean | undefined;
      let latencyMs: number | undefined;
      let connectionError: string | undefined;

      // If skipConnectionTest is not set, attempt connection test
      if (!input.skipConnectionTest) {
        try {
          const testResult = await this.connectionTesterService.testDeviceConnection(device.id, tenantId);
          connectionTestPassed = testResult.success;
          latencyMs = testResult.latencyMs;
          if (!testResult.success) {
            connectionError = testResult.error;
          }
        } catch (err) {
          // The device is registered; surface the connection failure to the
          // caller instead of swallowing it (truthful post-write status).
          connectionError = (err as Error).message;
          this.logger.warn(`Connection test failed during registration: ${connectionError}`);
          connectionTestPassed = false;
        }
      }

      return {
        success: true,
        vfdDevice: device,
        connectionTestPassed,
        latencyMs,
        error: connectionError,
      };
    } catch (err) {
      this.logger.error(`VFD registration failed: ${(err as Error).message}`);
      return {
        success: false,
        error: (err as Error).message,
      };
    }
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
   * Test connection for a VFD device.
   * Accepts TestVfdConnectionInput (protocol + configuration) for pre-registration testing.
   * Returns rich VfdConnectionTestResult with diagnostics, device info, etc.
   *
   * SECURITY: Requires elevated permissions - tests industrial equipment connectivity
   */
  @Mutation(() => VfdConnectionTestResultDto, { name: 'testVfdConnection' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async testVfdConnection(
    @Args('input', { type: () => TestVfdConnectionInputDto }) input: TestVfdConnectionInputDto,
    @Tenant() _tenantId: string
  ): Promise<VfdConnectionTestResultDto> {
    try {
      const result = await this.connectionTesterService.testConnection({
        protocol: input.protocol,
        configuration: input.configuration,
        brand: input.brand,
      });

      return {
        success: result.success,
        latencyMs: result.latencyMs,
        error: result.error,
        sampleData: result.parameters || result.sampleData,
        firmwareVersion: result.firmwareVersion,
        deviceInfo: result.serialNumber ? {
          serialNumber: result.serialNumber,
        } : undefined,
        testedAt: result.testedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        testedAt: new Date(),
      };
    }
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
   * Bind a drive to the equipment it turns — a feeder, a pump, a blower, anything
   * motorised. The binding is recorded as PENDING and confirmed asynchronously by
   * the service that owns equipment; until it is confirmed the drive will refuse
   * commands.
   *
   * SECURITY: Requires elevated permissions — decides what an actuator moves.
   */
  @Mutation(() => VfdDriveBinding, { name: 'bindVfdDrivenEquipment' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async bindVfdDrivenEquipment(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('drivenEquipmentId', { type: () => ID }) drivenEquipmentId: string,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string
  ): Promise<VfdDriveBinding> {
    // Existence check first: binding a nonexistent drive would create a binding
    // row nothing owns.
    await this.vfdDeviceService.findById(vfdDeviceId, tenantId);
    return this.driveBindingService.bind(vfdDeviceId, tenantId, drivenEquipmentId, userId);
  }

  /**
   * Forget what a drive is wired to. The drive stops accepting commands.
   *
   * SECURITY: Requires elevated permissions — disables an actuator.
   */
  @Mutation(() => Boolean, { name: 'unbindVfdDrivenEquipment' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async unbindVfdDrivenEquipment(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string
  ): Promise<boolean> {
    await this.vfdDeviceService.findById(vfdDeviceId, tenantId);
    return this.driveBindingService.unbind(vfdDeviceId, tenantId);
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

  /**
   * What this drive turns, and what its owner last said about it. Null when the
   * drive has never been bound — which is itself the operator-visible signal that
   * the drive cannot be commanded.
   */
  @ResolveField(() => VfdDriveBinding, { name: 'driveBinding', nullable: true })
  async getDriveBinding(
    @Parent() device: VfdDevice,
    @Tenant() tenantId: string
  ): Promise<VfdDriveBinding | null> {
    return this.driveBindingService.findBinding(device.id, tenantId);
  }

  /**
   * Which unit this drive serves, as a named outcome rather than a nullable id.
   */
  @ResolveField(() => VfdDrivenUnitResolutionDto, { name: 'drivenUnit' })
  async getDrivenUnit(
    @Parent() device: VfdDevice,
    @Tenant() tenantId: string
  ): Promise<VfdDrivenUnitResolutionDto> {
    const resolution = await this.driveBindingService.resolveDrivenUnit(device.id, tenantId);
    return this.toResolutionDto(device.id, tenantId, resolution);
  }

  /**
   * The unit id, and ONLY when exactly one unit follows from the driven equipment.
   *
   * The field name is unchanged from when this was a hand-typed column, but its
   * meaning is not: it is now derived through the attested binding, so it is null
   * for a pump (correctly — a pump serves no unit), null for an unconfirmed
   * binding, and null when a feeder serves several units. Callers that need to
   * know WHY it is null read `drivenUnit.outcome`.
   */
  @ResolveField(() => ID, { name: 'tankId', nullable: true })
  async getTankId(
    @Parent() device: VfdDevice,
    @Tenant() tenantId: string
  ): Promise<string | null> {
    const resolution = await this.driveBindingService.resolveDrivenUnit(device.id, tenantId);
    return resolution.kind === 'feeder_unit' ? resolution.unit.unitId : null;
  }

  /**
   * Project the server-side discriminated union onto its GraphQL shape. Every
   * branch is named; none of them collapses into a bare null.
   */
  private async toResolutionDto(
    deviceId: string,
    tenantId: string,
    resolution: DrivenUnitResolution
  ): Promise<VfdDrivenUnitResolutionDto> {
    switch (resolution.kind) {
      case 'unbound':
        return { outcome: VfdDrivenUnitOutcome.UNBOUND, units: [] };
      case 'unattested':
        return {
          outcome: VfdDrivenUnitOutcome.UNATTESTED,
          drivenEquipmentId: resolution.drivenEquipmentId,
          units: [],
        };
      case 'expired':
        return {
          outcome: VfdDrivenUnitOutcome.EXPIRED,
          drivenEquipmentId: resolution.drivenEquipmentId,
          units: [],
        };
      case 'not_a_feeder':
        return {
          outcome: VfdDrivenUnitOutcome.NOT_A_FEEDER,
          drivenEquipmentId: resolution.drivenEquipmentId,
          equipmentCategory: resolution.equipmentCategory,
          units: [],
        };
      case 'feeder_without_unit':
        return {
          outcome: VfdDrivenUnitOutcome.FEEDER_WITHOUT_UNIT,
          drivenEquipmentId: resolution.drivenEquipmentId,
          units: [],
        };
      case 'feeder_ambiguous':
      case 'feeder_unit':
        return {
          outcome:
            resolution.kind === 'feeder_unit'
              ? VfdDrivenUnitOutcome.FEEDER_UNIT
              : VfdDrivenUnitOutcome.FEEDER_AMBIGUOUS,
          drivenEquipmentId: resolution.drivenEquipmentId,
          units: await this.driveBindingService.findUnits(deviceId, tenantId),
        };
    }
  }
}
