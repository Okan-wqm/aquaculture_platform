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
import { CurrentTenant, TenantGuard } from '@platform/backend-common';

@Resolver(() => SentinelHubSettings)
@UseGuards(TenantGuard)
export class SentinelHubResolver {
  constructor(private readonly sentinelHubService: SentinelHubService) {}

  /**
   * Get Sentinel Hub configuration status (masked)
   */
  @Query(() => SentinelHubStatus, { name: 'sentinelHubStatus' })
  async getStatus(@CurrentTenant() tenantId: string): Promise<SentinelHubStatus> {
    return this.sentinelHubService.getStatus(tenantId);
  }

  /**
   * Get Sentinel Hub credentials (decrypted)
   * Only used internally by the frontend for API calls
   */
  @Query(() => SentinelHubCredentials, {
    name: 'sentinelHubCredentials',
    nullable: true,
  })
  async getCredentials(
    @CurrentTenant() tenantId: string,
  ): Promise<SentinelHubCredentials | null> {
    return this.sentinelHubService.getCredentials(tenantId);
  }

  /**
   * Save Sentinel Hub settings
   */
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
  @Mutation(() => Boolean)
  async deleteSentinelHubSettings(
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    return this.sentinelHubService.deleteSettings(tenantId);
  }

  /**
   * Check if Sentinel Hub is configured
   */
  @Query(() => Boolean, { name: 'isSentinelHubConfigured' })
  async isConfigured(@CurrentTenant() tenantId: string): Promise<boolean> {
    return this.sentinelHubService.isConfigured(tenantId);
  }

  /**
   * Get access token from CDSE (proxied to avoid CORS)
   * Frontend calls this instead of CDSE directly
   */
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
   * Get WMTS configuration (instanceId + token)
   * Used by frontend to construct WMTS tile URLs for fast satellite imagery
   */
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
  @Mutation(() => Boolean)
  async updateSentinelHubInstanceId(
    @CurrentTenant() tenantId: string,
    @Args('instanceId') instanceId: string,
  ): Promise<boolean> {
    return this.sentinelHubService.updateInstanceId(tenantId, instanceId);
  }
}
