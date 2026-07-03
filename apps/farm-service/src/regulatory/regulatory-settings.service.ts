/**
 * Regulatory Settings Service
 *
 * Manages tenant-specific regulatory settings including:
 * - Company information
 * - Maskinporten OAuth2 credentials (encrypted at rest)
 * - Site → Lokalitetsnummer mappings
 * - Default contact information
 *
 * SECURITY: Sensitive credentials (client ID, private key) are encrypted
 * at rest with the canonical authenticated AES-256-GCM column transformer
 * attached to the RegulatorySettings entity
 * (createEncryptedColumnTransformer('REGULATORY_ENCRYPTION_KEY')). The ORM
 * encrypts on write and decrypts on read, so this service operates purely on
 * plaintext — there is no bespoke crypto here. GCM replaces the previous
 * unauthenticated AES-256-CBC scheme (malleability / padding-oracle class).
 * @see HIGH sentinel-cbc
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantContextError } from '@aquaculture/backend-common/database';
import {
  RegulatorySettings,
  CompanyAddress,
} from './entities/regulatory-settings.entity';

/**
 * Input for updating regulatory settings
 */
export interface UpdateRegulatorySettingsInput {
  companyName?: string;
  organisationNumber?: string;
  companyAddress?: CompanyAddress;
  maskinportenClientId?: string;
  maskinportenPrivateKey?: string;
  maskinportenKeyId?: string;
  maskinportenEnvironment?: string;
  defaultContactName?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  siteLocalityMappings?: Record<string, number>;
  slaughterApprovalNumber?: string;
}

@Injectable()
export class RegulatorySettingsService {
  private readonly logger = new Logger(RegulatorySettingsService.name);

  constructor(
    @InjectRepository(RegulatorySettings)
    private readonly repo: Repository<RegulatorySettings>,
  ) {}

  /**
   * Mask string for display (show first 4 and last 4 characters)
   */
  private maskString(value: string): string {
    if (!value) return '';
    if (value.length <= 8) return '****';
    return value.slice(0, 4) + '****' + value.slice(-4);
  }

  // ===========================================================================
  // CRUD OPERATIONS
  // ===========================================================================

  /**
   * Get regulatory settings for a tenant
   */
  async getSettings(tenantId: string): Promise<RegulatorySettings | null> {
    try {
      return await this.repo.findOne({ where: { tenantId } });
    } catch (error) {
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.error(`Failed to get settings for tenant ${tenantId}:`, error);
      return null;
    }
  }

  /**
   * Save or update regulatory settings for a tenant
   */
  async saveSettings(
    tenantId: string,
    input: UpdateRegulatorySettingsInput,
  ): Promise<RegulatorySettings> {
    try {
      let settings = await this.repo.findOne({ where: { tenantId } });

      if (!settings) {
        settings = this.repo.create({ tenantId });
      }

      // Update non-sensitive fields
      if (input.companyName !== undefined) {
        settings.companyName = input.companyName;
      }
      if (input.organisationNumber !== undefined) {
        settings.organisationNumber = input.organisationNumber;
      }
      if (input.companyAddress !== undefined) {
        settings.companyAddress = input.companyAddress;
      }
      if (input.defaultContactName !== undefined) {
        settings.defaultContactName = input.defaultContactName;
      }
      if (input.defaultContactEmail !== undefined) {
        settings.defaultContactEmail = input.defaultContactEmail;
      }
      if (input.defaultContactPhone !== undefined) {
        settings.defaultContactPhone = input.defaultContactPhone;
      }
      if (input.siteLocalityMappings !== undefined) {
        settings.siteLocalityMappings = input.siteLocalityMappings;
      }
      if (input.slaughterApprovalNumber !== undefined) {
        settings.slaughterApprovalNumber = input.slaughterApprovalNumber;
      }
      if (input.maskinportenEnvironment !== undefined) {
        settings.maskinportenEnvironment = input.maskinportenEnvironment;
      }
      if (input.maskinportenKeyId !== undefined) {
        settings.maskinportenKeyId = input.maskinportenKeyId;
      }

      // Store plaintext — the entity's AES-256-GCM column transformer
      // encrypts these fields transparently on save.
      if (input.maskinportenClientId !== undefined && input.maskinportenClientId !== '') {
        settings.maskinportenClientId = input.maskinportenClientId;
      }
      if (input.maskinportenPrivateKey !== undefined && input.maskinportenPrivateKey !== '') {
        settings.maskinportenPrivateKeyEncrypted = input.maskinportenPrivateKey;
      }

      const saved = await this.repo.save(settings);
      this.logger.log(`Regulatory settings saved for tenant: ${tenantId}`);
      return saved;
    } catch (error) {
      this.logger.error(`Failed to save settings for tenant ${tenantId}:`, error);
      throw new Error('Failed to save regulatory settings');
    }
  }

  // ===========================================================================
  // CREDENTIAL ACCESS (For MaskinportenService)
  // ===========================================================================

  /**
   * Get the Maskinporten client ID in plaintext.
   * The value is decrypted by the entity's AES-256-GCM column transformer on
   * read, so this returns the stored plaintext directly.
   */
  async getDecryptedClientId(tenantId: string): Promise<string | null> {
    const settings = await this.getSettings(tenantId);
    return settings?.maskinportenClientId ?? null;
  }

  /**
   * Get the Maskinporten private key in plaintext.
   * The value is decrypted by the entity's AES-256-GCM column transformer on
   * read, so this returns the stored plaintext directly.
   */
  async getDecryptedPrivateKey(tenantId: string): Promise<string | null> {
    const settings = await this.getSettings(tenantId);
    return settings?.maskinportenPrivateKeyEncrypted ?? null;
  }

  /**
   * Get Maskinporten configuration for a tenant (non-sensitive parts)
   */
  async getMaskinportenConfig(tenantId: string): Promise<{
    keyId: string | null;
    environment: string;
  } | null> {
    const settings = await this.getSettings(tenantId);
    if (!settings) return null;
    return {
      keyId: settings.maskinportenKeyId || null,
      environment: settings.maskinportenEnvironment || 'TEST',
    };
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  /**
   * Check if Maskinporten is configured for a tenant
   */
  async isConfigured(tenantId: string): Promise<boolean> {
    const settings = await this.getSettings(tenantId);
    return !!(
      settings?.maskinportenClientId &&
      settings?.maskinportenPrivateKeyEncrypted
    );
  }

  /**
   * Get masked client ID for display
   */
  async getMaskedClientId(tenantId: string): Promise<string | null> {
    try {
      const clientId = await this.getDecryptedClientId(tenantId);
      if (!clientId) return null;
      return this.maskString(clientId);
    } catch {
      return null;
    }
  }

  /**
   * Get site locality mapping for a specific site
   */
  async getLokalitetsnummer(tenantId: string, siteId: string): Promise<number | null> {
    const settings = await this.getSettings(tenantId);
    if (!settings?.siteLocalityMappings) return null;
    return settings.siteLocalityMappings[siteId] || null;
  }

  /**
   * Update site locality mapping
   */
  async updateSiteLocalityMapping(
    tenantId: string,
    siteId: string,
    lokalitetsnummer: number,
  ): Promise<void> {
    let settings = await this.getSettings(tenantId);
    if (!settings) {
      settings = this.repo.create({ tenantId, siteLocalityMappings: {} });
    }

    const mappings = settings.siteLocalityMappings || {};
    mappings[siteId] = lokalitetsnummer;
    settings.siteLocalityMappings = mappings;

    await this.repo.save(settings);
    this.logger.log(`Updated locality mapping for site ${siteId}: ${lokalitetsnummer}`);
  }

  /**
   * Delete regulatory settings for a tenant (for data cleanup)
   */
  async deleteSettings(tenantId: string): Promise<boolean> {
    try {
      const result = await this.repo.delete({ tenantId });
      return (result.affected || 0) > 0;
    } catch (error) {
      this.logger.error(`Failed to delete settings for tenant ${tenantId}:`, error);
      return false;
    }
  }
}
