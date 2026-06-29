/**
 * Sentinel Hub GraphQL Resolver
 *
 * Tenant bazlı Sentinel Hub ayarları için GraphQL API.
 */
import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SentinelHubService } from './sentinel-hub.service';
import {
  SentinelHubSettings,
  SentinelHubStatus,
  SentinelHubCredentials,
  SentinelHubToken,
  SentinelHubWmtsConfig,
} from './entities/sentinel-hub-settings.entity';
import { CurrentTenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { QueryBus } from '@platform/cqrs';
import { GetSentinelHubStatusQuery } from './queries/get-sentinel-hub-status.query';
import { GetSentinelHubCredentialsQuery } from './queries/get-sentinel-hub-credentials.query';
import { IsSentinelHubConfiguredQuery } from './queries/is-sentinel-hub-configured.query';

@Resolver(() => SentinelHubSettings)
@UseGuards(TenantGuard)
export class SentinelHubResolver {
  constructor(
    private readonly sentinelHubService: SentinelHubService,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Get Sentinel Hub configuration status (masked)
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => SentinelHubStatus, { name: 'sentinelHubStatus' })
  async getStatus(@CurrentTenant() tenantId: string): Promise<SentinelHubStatus> {
    return this.queryBus.execute(new GetSentinelHubStatusQuery(tenantId));
  }

  /**
   * Get Sentinel Hub credentials info (SAFE - secrets are masked)
   * Returns masked clientId, instanceId and metadata
   * SECURITY: clientSecret is NEVER returned - only hasClientSecret boolean
   */
  @Roles(Role.TENANT_ADMIN)
  @Query(() => SentinelHubCredentials, {
    name: 'sentinelHubCredentials',
    nullable: true,
  })
  async getCredentials(
    @CurrentTenant() tenantId: string,
  ): Promise<SentinelHubCredentials | null> {
    return this.queryBus.execute(new GetSentinelHubCredentialsQuery(tenantId));
  }

  /**
   * Save Sentinel Hub settings
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async saveSentinelHubSettings(
    @CurrentTenant() tenantId: string,
    @Args('clientId') clientId: string,
    @Args('clientSecret') clientSecret: string,
    @Args('instanceId', { nullable: true }) instanceId?: string,
  ): Promise<boolean> {
    return this.sentinelHubService.saveSettings(tenantId, clientId, clientSecret, instanceId);
  }

  /**
   * Delete Sentinel Hub settings
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteSentinelHubSettings(
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    return this.sentinelHubService.deleteSettings(tenantId);
  }

  /**
   * Check if Sentinel Hub is configured
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => Boolean, { name: 'isSentinelHubConfigured' })
  async isConfigured(@CurrentTenant() tenantId: string): Promise<boolean> {
    return this.queryBus.execute(new IsSentinelHubConfiguredQuery(tenantId));
  }

  /**
   * SEC-C14: Token query now returns only expiresIn metadata.
   *
   * The accessToken field is hidden via @HideField() on SentinelHubToken.
   * All actual Sentinel Hub API calls are proxied through
   * SentinelHubProxyController (/api/sentinel-hub/*), which injects
   * the OAuth token server-side. The frontend uses this query only to
   * check if a valid token can be obtained (i.e., credentials are working).
   */
  @Roles(Role.TENANT_ADMIN)
  @Query(() => SentinelHubToken, { name: 'sentinelHubToken', nullable: true })
  async getAccessToken(
    @CurrentTenant() tenantId: string,
  ): Promise<SentinelHubToken | null> {
    const result = await this.sentinelHubService.getAccessToken(tenantId);
    if (!result) return null;
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    };
  }

  /**
   * SEC-C14: WMTS config query now returns only instanceId + expiresIn.
   *
   * The accessToken is hidden via @HideField() on SentinelHubWmtsConfig.
   * The frontend uses the instanceId to construct proxy URLs (routed through
   * /api/sentinel-hub/wms/:layerId) and expiresIn for refresh scheduling.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => SentinelHubWmtsConfig, { name: 'sentinelHubWmtsConfig', nullable: true })
  async getWmtsConfig(
    @CurrentTenant() tenantId: string,
  ): Promise<SentinelHubWmtsConfig | null> {
    return this.sentinelHubService.getWmtsConfig(tenantId);
  }

  /**
   * Update only the Instance ID for WMTS support
   * Allows updating instanceId without re-entering client credentials
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async updateSentinelHubInstanceId(
    @CurrentTenant() tenantId: string,
    @Args('instanceId') instanceId: string,
  ): Promise<boolean> {
    return this.sentinelHubService.updateInstanceId(tenantId, instanceId);
  }
}
