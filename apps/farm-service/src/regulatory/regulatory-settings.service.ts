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
import { IsNull, Not, Repository } from 'typeorm';

import { Site } from '../site/entities/site.entity';
import { TenantContextError } from '@aquaculture/backend-common/database';
import { RegulatorySettings, CompanyAddress } from './entities/regulatory-settings.entity';

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
    @InjectRepository(Site)
    private readonly siteRepo: Repository<Site>,
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
  /**
   * Effective site → lokalitetsnummer mappings. `sites.lokalitetsnummer` is
   * the SSoT (RPT-015); the legacy settings jsonb is a transition fallback
   * (removed in Phase 4). When both exist and disagree, sites wins and the
   * drift is logged for the operator to reconcile.
   */
  async getEffectiveSiteLocalityMappings(tenantId: string): Promise<Record<string, number>> {
    const [settings, sites] = await Promise.all([
      this.getSettings(tenantId),
      this.siteRepo.find({
        where: { tenantId, lokalitetsnummer: Not(IsNull()) },
        select: ['id', 'lokalitetsnummer'],
      }),
    ]);

    const merged: Record<string, number> = { ...(settings?.siteLocalityMappings ?? {}) };
    for (const site of sites) {
      if (site.lokalitetsnummer == null) continue;
      const legacy = merged[site.id];
      if (legacy !== undefined && legacy !== site.lokalitetsnummer) {
        this.logger.warn(
          `Site ${site.id} lokalitetsnummer drift: sites=${site.lokalitetsnummer} ` +
            `settings-jsonb=${legacy} — sites is the SSoT and wins.`,
        );
      }
      merged[site.id] = site.lokalitetsnummer;
    }
    return merged;
  }

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
        // Transition write-through (RPT-015): sites.lokalitetsnummer is the
        // SSoT — mirror every mapping onto the site rows so old readers (the
        // jsonb) and new readers (sites) stay consistent until the jsonb is
        // dropped in Phase 4.
        for (const [siteId, lokalitetsnummer] of Object.entries(input.siteLocalityMappings)) {
          await this.siteRepo.update({ id: siteId, tenantId }, { lokalitetsnummer });
        }
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
    return !!(settings?.maskinportenClientId && settings?.maskinportenPrivateKeyEncrypted);
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
   * The organisation number that identifies a site's reports to Mattilsynet:
   * the site's `organisationNumberOverride` (RPT-015 — a co-located operator on
   * another org's licence) when set, else the tenant default from settings.
   * Returns null when neither is configured — the submission path fails closed.
   */
  async getEffectiveOrganisationNumber(tenantId: string, siteId: string): Promise<string | null> {
    const [settings, site] = await Promise.all([
      this.getSettings(tenantId),
      this.siteRepo.findOne({
        where: { id: siteId, tenantId },
        select: ['id', 'organisationNumberOverride'],
      }),
    ]);
    return site?.organisationNumberOverride ?? settings?.organisationNumber ?? null;
  }

  /**
   * Toggle per-report-type auto-submit opt-in (RPT-003, user decision). Merges
   * one key into `autoSubmitPolicies` so enabling SEA_LICE never disturbs a
   * SMOLT opt-in. Absent/false leaves the scheduler assembling drafts for
   * operator approval; true lets the auto-submit path transmit a READY draft.
   */
  async updateAutoSubmitPolicy(
    tenantId: string,
    reportType: string,
    enabled: boolean,
  ): Promise<RegulatorySettings> {
    let settings = await this.getSettings(tenantId);
    if (!settings) {
      settings = this.repo.create({ tenantId });
    }
    settings.autoSubmitPolicies = { ...(settings.autoSubmitPolicies ?? {}), [reportType]: enabled };
    const saved = await this.repo.save(settings);
    this.logger.log(
      `Auto-submit policy for ${reportType} set to ${enabled} (tenant ${tenantId.slice(0, 8)}…)`,
    );
    return saved;
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
