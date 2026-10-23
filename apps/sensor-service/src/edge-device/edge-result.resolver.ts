import { Tenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';

import { EdgeDeviceService } from './edge-device.service';
import { EdgeResultTelemetryService } from './edge-result-telemetry.service';
import { EdgeDeviceResult, EdgeDeviceResultSummary } from './entities/edge-device-result.entity';

/**
 * The console's view of what a Suderra OS device reported (ADR-048 DEC-27):
 * the `suderra.result.v1` documents root wrote — install and update results,
 * verification, rollbacks, lockdown, health gate, `/data` unlock, time — as
 * device-reported evidence. A result is an observation the device made about
 * itself; nothing here lets a console user act on a device.
 *
 * A device of another tenant answers like a device that does not exist: the
 * device is resolved through the caller's tenant first, and the rows are read
 * inside that tenant's boundary as well.
 */
@Resolver(() => EdgeDeviceResult)
export class EdgeDeviceResultResolver {
  constructor(
    private readonly results: EdgeResultTelemetryService,
    private readonly devices: EdgeDeviceService,
  ) {}

  @Query(() => [EdgeDeviceResult], {
    name: 'edgeDeviceResults',
    description:
      "A Suderra OS device's reported results, newest first, optionally of one kind (device-reported evidence, not authority)",
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async edgeDeviceResults(
    @Tenant() tenantId: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Args('kind', { type: () => String, nullable: true }) kind?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 }) limit?: number,
  ): Promise<EdgeDeviceResult[]> {
    if ((await this.devices.findById(deviceId, tenantId)) === null) return [];
    return this.results.list(tenantId, deviceId, { kind, limit });
  }

  @Query(() => EdgeDeviceResultSummary, {
    name: 'edgeDeviceResultSummary',
    nullable: true,
    description:
      'The newest result of every kind a device reported: installed version, verification, rollbacks and lockdown state as the device last said them',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async edgeDeviceResultSummary(
    @Tenant() tenantId: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
  ): Promise<EdgeDeviceResultSummary | null> {
    if ((await this.devices.findById(deviceId, tenantId)) === null) return null;
    const [latestByKind, stored] = await Promise.all([
      this.results.latestByKind(tenantId, deviceId),
      this.results.count(tenantId, deviceId),
    ]);
    return Object.assign(new EdgeDeviceResultSummary(), { deviceId, latestByKind, stored });
  }
}
