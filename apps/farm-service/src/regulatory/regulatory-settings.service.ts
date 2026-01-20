/**
 * Regulatory Settings Service
 *
 * Manages tenant-specific regulatory settings including:
 * - Company information
 * - Maskinporten OAuth2 credentials (AES-256-CBC encrypted)
 * - Site → Lokalitetsnummer mappings
 * - Default contact information
 *
 * SECURITY: Sensitive credentials (client ID, private key) are encrypted
 * at rest using AES-256-CBC with random IV per encryption.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import {
  RegulatorySettings,
  CompanyAddress,
} from './entities/regulatory-settings.entity';

// Encryption key - 32 characters for AES-256
const ENCRYPTION_KEY =
  process.env.REGULATORY_ENCRYPTION_KEY ||
  process.env.ENCRYPTION_KEY ||
  'aquaculture-platform-32char-key!'; // Default for development only

const IV_LENGTH = 16;

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

  // ===========================================================================
  // ENCRYPTION METHODS (AES-256-CBC)
  // ===========================================================================

  /**
   * Encrypt text using AES-256-CBC with random IV
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
      throw new Error('Encryption error');
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
      throw new Error('Decryption error');
    }
  }

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

      // Encrypt sensitive fields before saving
      if (input.maskinportenClientId !== undefined && input.maskinportenClientId !== '') {
        settings.maskinportenClientId = this.encrypt(input.maskinportenClientId);
      }
      if (input.maskinportenPrivateKey !== undefined && input.maskinportenPrivateKey !== '') {
        settings.maskinportenPrivateKeyEncrypted = this.encrypt(input.maskinportenPrivateKey);
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
   * Get decrypted Maskinporten client ID
   */
  async getDecryptedClientId(tenantId: string): Promise<string | null> {
    try {
      const settings = await this.getSettings(tenantId);
      if (!settings?.maskinportenClientId) return null;
      return this.decrypt(settings.maskinportenClientId);
    } catch (error) {
      this.logger.error(`Failed to decrypt client ID for tenant ${tenantId}:`, error);
      return null;
    }
  }

  /**
   * Get decrypted Maskinporten private key
   */
  async getDecryptedPrivateKey(tenantId: string): Promise<string | null> {
    try {
      const settings = await this.getSettings(tenantId);
      if (!settings?.maskinportenPrivateKeyEncrypted) return null;
      return this.decrypt(settings.maskinportenPrivateKeyEncrypted);
    } catch (error) {
      this.logger.error(`Failed to decrypt private key for tenant ${tenantId}:`, error);
      return null;
    }
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
