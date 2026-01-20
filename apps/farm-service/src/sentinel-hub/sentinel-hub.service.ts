/**
 * Sentinel Hub Service
 *
 * Tenant bazlı Sentinel Hub kimlik bilgilerini yönetir.
 * Kimlik bilgileri AES-256-CBC ile şifrelenerek saklanır.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import {
  SentinelHubSettings,
  SentinelHubStatus,
  SentinelHubCredentials,
  SentinelHubWmtsConfig,
} from './entities/sentinel-hub-settings.entity';

// Encryption key - 32 characters for AES-256
const ENCRYPTION_KEY =
  process.env.SENTINEL_HUB_ENCRYPTION_KEY ||
  process.env.ENCRYPTION_KEY ||
  'aquaculture-platform-32char-key!'; // Default for development

const IV_LENGTH = 16;

@Injectable()
export class SentinelHubService {
  private readonly logger = new Logger(SentinelHubService.name);

  constructor(
    @InjectRepository(SentinelHubSettings)
    private readonly settingsRepo: Repository<SentinelHubSettings>,
  ) {}

  /**
   * Encrypt text using AES-256-CBC
   */
  private encrypt(text: string): string {
    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(
        'aes-256-cbc',
        Buffer.from(ENCRYPTION_KEY.slice(0, 32)),
        iv,
      );
      let encrypted = cipher.update(text);
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (error) {
      this.logger.error('Encryption failed:', error);
      throw new Error('Şifreleme hatası');
    }
  }

  /**
   * Decrypt text using AES-256-CBC
   */
  private decrypt(text: string): string {
    try {
      const parts = text.split(':');
      const iv = Buffer.from(parts.shift()!, 'hex');
      const encrypted = Buffer.from(parts.join(':'), 'hex');
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from(ENCRYPTION_KEY.slice(0, 32)),
        iv,
      );
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return decrypted.toString();
    } catch (error) {
      this.logger.error('Decryption failed:', error);
      throw new Error('Şifre çözme hatası');
    }
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

      // Encrypt credentials
      settings.clientId = this.encrypt(clientId);
      settings.clientSecret = this.encrypt(clientSecret);
      settings.isConfigured = true;

      // Encrypt instanceId if provided (for WMTS support)
      if (instanceId) {
        settings.instanceId = this.encrypt(instanceId);
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
   * Get decrypted credentials for a tenant
   */
  async getCredentials(tenantId: string): Promise<SentinelHubCredentials | null> {
    try {
      const settings = await this.settingsRepo.findOne({ where: { tenantId } });

      if (!settings || !settings.isConfigured) {
        return null;
      }

      // Update usage stats
      settings.usageCount += 1;
      settings.lastUsed = new Date();
      await this.settingsRepo.save(settings);

      // Decrypt and return
      return {
        clientId: this.decrypt(settings.clientId),
        clientSecret: this.decrypt(settings.clientSecret),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get credentials for tenant ${tenantId}:`,
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

      let clientIdMasked: string | undefined = undefined;
      if (settings.clientId) {
        try {
          const decrypted = this.decrypt(settings.clientId);
          clientIdMasked = this.maskClientId(decrypted);
        } catch {
          // If decryption fails, settings are corrupted
          clientIdMasked = '****';
        }
      }

      let instanceIdMasked: string | undefined = undefined;
      if (settings.instanceId) {
        try {
          const decrypted = this.decrypt(settings.instanceId);
          instanceIdMasked = this.maskClientId(decrypted);
        } catch {
          instanceIdMasked = '****';
        }
      }

      return {
        isConfigured: settings.isConfigured,
        clientIdMasked: clientIdMasked ?? undefined,
        instanceIdMasked: instanceIdMasked ?? undefined,
        lastUsed: settings.lastUsed ?? undefined,
        usageCount: settings.usageCount,
      };
    } catch (error) {
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
   */
  async getAccessToken(tenantId: string): Promise<{ accessToken: string; expiresIn: number } | null> {
    const CDSE_TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';

    try {
      const credentials = await this.getCredentials(tenantId);
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

      settings.instanceId = this.encrypt(instanceId);
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

      // Decrypt and return
      return {
        instanceId: this.decrypt(settings.instanceId),
        accessToken: tokenResult.accessToken,
        expiresIn: tokenResult.expiresIn,
      };
    } catch (error) {
      this.logger.error(`Failed to get WMTS config for tenant ${tenantId}:`, error);
      return null;
    }
  }
}
