import { SiteScopeCaller, Throttle } from '@aquaculture/backend-common/security';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';

import {
  EnvironmentScenesInput,
  SiteEnvironmentForecastInput,
  SiteEnvironmentHistoryInput,
} from './dto/environment.input';
import {
  EnvironmentLayerResponse,
  EnvironmentSceneCursorConnection,
  SiteEnvironmentValuesResponse,
} from './dto/environment.response';
import { EnvironmentMonitoringGate } from './services/environment-monitoring-gate.service';
import { EnvironmentReadService } from './services/environment-read.service';

@Resolver()
@UseGuards(TenantGuard)
@Throttle({ limit: 30, ttl: 60, keyPrefix: 'environment-read' })
export class EnvironmentResolver {
  constructor(
    private readonly environmentReadService: EnvironmentReadService,
    private readonly monitoringGate: EnvironmentMonitoringGate,
  ) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SiteEnvironmentValuesResponse, { complexity: 200 })
  async siteEnvironmentCurrent(
    @Args('siteId', { type: () => ID }) siteId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() caller: SiteScopeCaller,
  ): Promise<SiteEnvironmentValuesResponse> {
    this.monitoringGate.assertEnabled();
    return this.environmentReadService.current(tenantId, caller, siteId);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SiteEnvironmentValuesResponse, { complexity: 300 })
  async siteEnvironmentHistory(
    @Args('input') input: SiteEnvironmentHistoryInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() caller: SiteScopeCaller,
  ): Promise<SiteEnvironmentValuesResponse> {
    this.monitoringGate.assertEnabled();
    return this.environmentReadService.history(tenantId, caller, input);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SiteEnvironmentValuesResponse, { complexity: 250 })
  async siteEnvironmentForecast(
    @Args('input') input: SiteEnvironmentForecastInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() caller: SiteScopeCaller,
  ): Promise<SiteEnvironmentValuesResponse> {
    this.monitoringGate.assertEnabled();
    return this.environmentReadService.forecast(
      tenantId,
      caller,
      input.siteId,
      input.metrics,
      input.days,
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [EnvironmentLayerResponse], { complexity: 300 })
  async environmentLayerCatalog(
    @Args('siteId', { type: () => ID }) siteId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() caller: SiteScopeCaller,
  ): Promise<EnvironmentLayerResponse[]> {
    this.monitoringGate.assertEnabled();
    return this.environmentReadService.layerCatalog(tenantId, caller, siteId);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => EnvironmentSceneCursorConnection, { complexity: 250 })
  async environmentScenes(
    @Args('input') input: EnvironmentScenesInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() caller: SiteScopeCaller,
  ): Promise<EnvironmentSceneCursorConnection> {
    this.monitoringGate.assertEnabled();
    return this.environmentReadService.scenes(tenantId, caller, input);
  }
}
