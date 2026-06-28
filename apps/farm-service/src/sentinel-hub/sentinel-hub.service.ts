/**
 * Sentinel Hub Service
 *
 * Tenant bazlı Sentinel Hub kimlik bilgilerini yönetir.
 *
 * SECURITY: Secret columns are encrypted at rest with the canonical
 * authenticated AES-256-GCM column transformer attached to the entity
 * (createEncryptedColumnTransformer('SENTINEL_HUB_ENCRYPTION_KEY')). The ORM
 * encrypts on write and decrypts on read, so this service operates purely on
 * plaintext — there is no bespoke crypto here. GCM replaces the previous
 * unauthenticated AES-256-CBC scheme (malleability / padding-oracle class).
 * @see HIGH sentinel-cbc
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantContextError } from '@aquaculture/backend-common/database';
import {
  SentinelHubSettings,
  SentinelHubStatus,
  SentinelHubCredentials,
  SentinelHubWmtsConfig,
} from './entities/sentinel-hub-settings.entity';

@Injectable()
export class SentinelHubService implements OnModuleInit {
  private readonly logger = new Logger(SentinelHubService.name);

  constructor(
    @InjectRepository(SentinelHubSettings)
    private readonly settingsRepo: Repository<SentinelHubSettings>,
  ) {}

  onModuleInit(): void {
    this.logger.log('SentinelHubService initialized (AES-256-GCM column encryption via ORM transformer)');
  }

  /**
   * Mask client ID for display (show first 4 and last 4 characters)
   */
  private maskClientId(clientId: string): string {
    if (clientId.length <= 8) {
      return '****';
    }
    return clientId.slice(0, 4) + '****' + clientId.slice(-4);
  }

  /**
   * Save Sentinel Hub settings for a tenant
   */
  async saveSettings(
    tenantId: string,
    clientId: string,
    clientSecret: string,
    instanceId?: string,
  ): Promise<boolean> {
    try {
      let settings = await this.settingsRepo.findOne({ where: { tenantId } });

      if (!settings) {
        settings = this.settingsRepo.create({ tenantId });
      }

      // Store plaintext — the entity's AES-256-GCM column transformer
      // encrypts these fields transparently on save.
      settings.clientId = clientId;
      settings.clientSecret = clientSecret;
      settings.isConfigured = true;

      // Store instanceId if provided (for WMTS support)
      if (instanceId) {
        settings.instanceId = instanceId;
      }

      await this.settingsRepo.save(settings);

      this.logger.log(`Sentinel Hub settings saved for tenant: ${tenantId}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to save Sentinel Hub settings for tenant ${tenantId}:`,
        error,
      );
      throw new Error('Ayarlar kaydedilemedi');
    }
  }

  /**
   * Get credentials info for a tenant (SAFE - no secrets exposed)
   * Returns masked clientId and metadata only
   */
  async getCredentials(tenantId: string): Promise<SentinelHubCredentials | null> {
    try {
      const settings = await this.settingsRepo.findOne({ where: { tenantId } });

      if (!settings || !settings.isConfigured) {
        return null;
      }

      // Values are already plaintext (ORM transformer decrypted on read).
      // Mask clientId for display (never the secret).
      const clientIdMasked = this.maskClientId(settings.clientId);

      const instanceIdMasked = settings.instanceId
        ? this.maskClientId(settings.instanceId)
        : undefined;

      // Return SAFE response - no secrets!
      return {
        clientId: clientIdMasked,
        instanceId: instanceIdMasked,
        hasClientSecret: !!settings.clientSecret,
        isConfigured: settings.isConfigured,
      };
    } catch (error) {
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.error(
        `Failed to get credentials for tenant ${tenantId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Get decrypted credentials for internal use only (token generation)
   * PRIVATE - Never expose via GraphQL or API
   */
  private async getDecryptedCredentialsInternal(
    tenantId: string,
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    try {
      const settings = await this.settingsRepo.findOne({ where: { tenantId } });

      if (!settings || !settings.isConfigured) {
        return null;
      }

      // Update usage stats
      settings.usageCount += 1;
      settings.lastUsed = new Date();
      await this.settingsRepo.save(settings);

      // Values are already plaintext (ORM transformer decrypted on read).
      return {
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
      };
    } catch (error) {
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.error(
        `Failed to get internal credentials for tenant ${tenantId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Get status (without sensitive data) for a tenant
   */
  async getStatus(tenantId: string): Promise<SentinelHubStatus> {
    try {
      const settings = await this.settingsRepo.findOne({ where: { tenantId } });

      if (!settings) {
        return {
          isConfigured: false,
          clientIdMasked: undefined,
          instanceIdMasked: undefined,
          lastUsed: undefined,
          usageCount: 0,
        };
      }

      // Values are already plaintext (ORM transformer decrypted on read).
      const clientIdMasked = settings.clientId
        ? this.maskClientId(settings.clientId)
        : undefined;

      const instanceIdMasked = settings.instanceId
        ? this.maskClientId(settings.instanceId)
        : undefined;

      return {
        isConfigured: settings.isConfigured,
        clientIdMasked,
        instanceIdMasked,
        lastUsed: settings.lastUsed ?? undefined,
        usageCount: settings.usageCount,
      };
    } catch (error) {
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.error(
        `Failed to get status for tenant ${tenantId}:`,
        error,
      );
      return {
        isConfigured: false,
        clientIdMasked: undefined,
        instanceIdMasked: undefined,
        lastUsed: undefined,
        usageCount: 0,
      };
    }
  }

  /**
   * Delete settings for a tenant
   */
  async deleteSettings(tenantId: string): Promise<boolean> {
    try {
      const result = await this.settingsRepo.delete({ tenantId });
      this.logger.log(`Sentinel Hub settings deleted for tenant: ${tenantId}`);
      return (result.affected ?? 0) > 0;
    } catch (error) {
      this.logger.error(
        `Failed to delete settings for tenant ${tenantId}:`,
        error,
      );
      throw new Error('Ayarlar silinemedi');
    }
  }

  /**
   * Check if a tenant has configured Sentinel Hub
   */
  async isConfigured(tenantId: string): Promise<boolean> {
    const settings = await this.settingsRepo.findOne({
      where: { tenantId },
      select: ['isConfigured'],
    });
    return settings?.isConfigured ?? false;
  }

  /**
   * Get access token from CDSE (Copernicus Data Space Ecosystem)
   * This proxies the token request to avoid CORS issues in the browser
   * Uses internal method to get decrypted credentials (never exposed via API)
   */
  async getAccessToken(tenantId: string): Promise<{ accessToken: string; expiresIn: number } | null> {
    const CDSE_TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';

    try {
      // Use internal method to get decrypted credentials (not the public API)
      const credentials = await this.getDecryptedCredentialsInternal(tenantId);
      if (!credentials) {
        this.logger.warn(`No credentials found for tenant ${tenantId}`);
        return null;
      }

      const response = await fetch(CDSE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`CDSE token request failed: ${response.status} - ${errorText}`);
        throw new Error('Token alınamadı');
      }

      const data = await response.json();
      this.logger.log(`CDSE token obtained successfully for tenant ${tenantId}`);

      return {
        accessToken: data.access_token,
        expiresIn: data.expires_in || 1800,
      };
    } catch (error) {
      this.logger.error(`Failed to get CDSE token for tenant ${tenantId}:`, error);
      throw new Error('Sentinel Hub kimlik doğrulama başarısız');
    }
  }

  /**
   * Update only the instanceId for a tenant (for WMTS support)
   * Allows updating instanceId without re-entering client credentials
   */
  async updateInstanceId(tenantId: string, instanceId: string): Promise<boolean> {
    try {
      const settings = await this.settingsRepo.findOne({ where: { tenantId } });

      if (!settings || !settings.isConfigured) {
        throw new Error('Önce Sentinel Hub kimlik bilgilerini yapılandırın');
      }

      // Store plaintext — the entity transformer encrypts on save.
      settings.instanceId = instanceId;
      await this.settingsRepo.save(settings);

      this.logger.log(`Instance ID updated for tenant: ${tenantId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to update instanceId for tenant ${tenantId}:`, error);
      throw error;
    }
  }

  /**
   * Get WMTS configuration (instanceId + token) for a tenant
   * Used by frontend to construct WMTS tile URLs
   */
  async getWmtsConfig(tenantId: string): Promise<SentinelHubWmtsConfig | null> {
    try {
      const settings = await this.settingsRepo.findOne({ where: { tenantId } });

      if (!settings || !settings.instanceId) {
        this.logger.debug(`No WMTS instanceId configured for tenant ${tenantId}`);
        return null;
      }

      // Get access token
      const tokenResult = await this.getAccessToken(tenantId);
      if (!tokenResult) {
        return null;
      }

      // instanceId is already plaintext (ORM transformer decrypted on read).
      return {
        instanceId: settings.instanceId,
        accessToken: tokenResult.accessToken,
        expiresIn: tokenResult.expiresIn,
      };
    } catch (error) {
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.error(`Failed to get WMTS config for tenant ${tenantId}:`, error);
      return null;
    }
  }
}
