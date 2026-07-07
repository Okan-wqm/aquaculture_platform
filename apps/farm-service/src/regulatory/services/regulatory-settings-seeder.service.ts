/**
 * RegulatorySettingsSeederService
 *
 * Seeds a skeleton `regulatory_settings` row for a freshly onboarded
 * tenant so the Norwegian / Mattilsynet compliance surfaces (biomass
 * reports, mortality reports, Maskinporten OAuth2 flow) have a
 * deterministic anchor to read from. Without this row, the first
 * call to `GetRegulatorySettingsQuery` returns null and the UI
 * tenant-admin has to bootstrap the record from the settings page
 * before any regulatory feature is usable — the onboarding PR flow
 * is meant to avoid that cliff.
 *
 * Phase 7.5 of the "Farm modülü kalan kör noktalar" plan — the fourth
 * onboarding seeder to land alongside WaterQualityParameterConfig /
 * Species / FeedingProtocol. Each seeder is idempotent and isolated
 * by the onboarding handler's per-seeder try/catch.
 *
 * # Defaults
 *
 *   - Maskinporten environment: `TEST` — safe default, operator opts
 *     into `PRODUCTION` only after the integration partner has signed
 *     off on live credentials.
 *   - All credential columns left NULL — no secrets created blindly.
 *     The tenant-admin provides them via the settings mutation.
 *   - Site → lokalitetsnummer lives on the site rows (RPT-015), not here —
 *     the seeder creates no mapping.
 *
 * # Idempotency
 *
 * The unique index `(tenantId)` on the table means a second call
 * for the same tenant would throw; the seeder detects the existing
 * row up-front and skips.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RegulatorySettings } from '../entities/regulatory-settings.entity';

export interface RegulatorySettingsSeedResult {
  /**
   * Matches the seed-summary contract the tenant-onboarding handler
   * expects. Populated with the single logical row key the seeder
   * operates on (`regulatory-settings`) so the aggregate summary
   * line lists the right owner when something fails.
   */
  seeded: string[];
  skipped: string[];
}

@Injectable()
export class RegulatorySettingsSeederService {
  private readonly logger = new Logger(RegulatorySettingsSeederService.name);

  constructor(
    @InjectRepository(RegulatorySettings)
    private readonly settingsRepository: Repository<RegulatorySettings>,
  ) {}

  /**
   * Ensure a regulatory_settings row exists for the tenant. Creates a
   * skeleton row on first call, skips when a row already exists. The
   * return shape mirrors the other onboarding seeders so the
   * aggregate summary log line stays uniform.
   */
  async seedDefaults(tenantId: string): Promise<RegulatorySettingsSeedResult> {
    const existing = await this.settingsRepository.findOne({
      where: { tenantId },
      select: ['id'],
    });
    if (existing) {
      this.logger.log(
        `Regulatory-settings seed for tenant ${tenantId.slice(0, 8)}...: ` +
          'skipped (row already present).',
      );
      return { seeded: [], skipped: ['regulatory-settings'] };
    }

    const row = this.settingsRepository.create({
      tenantId,
      maskinportenEnvironment: 'TEST',
    });
    await this.settingsRepository.save(row);

    this.logger.log(
      `Regulatory-settings seed for tenant ${tenantId.slice(0, 8)}...: created.`,
    );
    return { seeded: ['regulatory-settings'], skipped: [] };
  }
}
