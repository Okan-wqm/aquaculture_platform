/**
 * WaterQualityParameterConfigSeederService
 *
 * Seeds a tenant's `water_quality_parameter_configs` table with a
 * standard salmonid-aquaculture starter set: the seven parameters
 * every farm records from day one (temperature, pH, dissolved
 * oxygen, ammonia, nitrite, salinity, turbidity). Threshold
 * (optimal / warning / critical) bands default to the FAO /
 * Mattilsynet ranges for Atlantic salmon grow-out.
 *
 * Phase 7.5 partial of the "Farm modülü kalan kör noktalar" plan —
 * closes the phase-6.5 follow-up gap (new tenants hitting strict
 * mode need a way to provision the default config set without
 * clicking through the setup page). The full phase 7.5
 * `TenantOnboardingService.seed()` fan-out wraps this seeder with
 * the other onboarding steps (equipment types, species,
 * feeding protocols, regulatory settings).
 *
 * Idempotent: a second call on the same tenant re-detects existing
 * rows by `code` and skips them so operators can safely re-run
 * after adding a single parameter by hand.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import {
  ParameterDataType,
  ParameterGroup,
  WaterQualityParameterConfig,
} from '../entities/water-quality-parameter-config.entity';

export interface SeedResult {
  seeded: string[];
  skipped: string[];
}

interface SeedEntry {
  code: string;
  name: string;
  unit: string;
  dataType: ParameterDataType;
  precision: number;
  group: ParameterGroup;
  optimalMin?: number;
  optimalMax?: number;
  warningMin?: number;
  warningMax?: number;
  criticalMin?: number;
  criticalMax?: number;
  chartColor: string;
  icon?: string;
  displayOrder: number;
  isRequired: boolean;
  isQuickAccess: boolean;
  chartAxisGroup?: 'left' | 'right';
}

/**
 * FAO / Mattilsynet reference bands for Atlantic salmon grow-out.
 * Operators can override per-parameter after seeding; re-running
 * the seeder will not clobber their edits thanks to the code-based
 * idempotency check.
 */
const DEFAULT_SEEDS: readonly SeedEntry[] = [
  {
    code: 'temperature',
    name: 'Temperature',
    unit: '°C',
    dataType: ParameterDataType.NUMBER,
    precision: 2,
    group: ParameterGroup.BASIC,
    optimalMin: 8,
    optimalMax: 14,
    warningMin: 4,
    warningMax: 18,
    criticalMin: 0,
    criticalMax: 22,
    chartColor: '#ef4444',
    icon: 'thermometer',
    displayOrder: 1,
    isRequired: true,
    isQuickAccess: true,
    chartAxisGroup: 'left',
  },
  {
    code: 'ph',
    name: 'pH',
    unit: 'pH',
    dataType: ParameterDataType.NUMBER,
    precision: 2,
    group: ParameterGroup.BASIC,
    optimalMin: 6.5,
    optimalMax: 8.5,
    warningMin: 6.0,
    warningMax: 9.0,
    criticalMin: 5.5,
    criticalMax: 9.5,
    chartColor: '#8b5cf6',
    icon: 'flask',
    displayOrder: 2,
    isRequired: true,
    isQuickAccess: true,
    chartAxisGroup: 'left',
  },
  {
    code: 'dissolved_oxygen',
    name: 'Dissolved Oxygen',
    unit: 'mg/L',
    dataType: ParameterDataType.NUMBER,
    precision: 2,
    group: ParameterGroup.BASIC,
    optimalMin: 7,
    optimalMax: 12,
    warningMin: 5,
    warningMax: 14,
    criticalMin: 3,
    criticalMax: 16,
    chartColor: '#3b82f6',
    icon: 'droplet',
    displayOrder: 3,
    isRequired: true,
    isQuickAccess: true,
    chartAxisGroup: 'right',
  },
  {
    code: 'ammonia',
    name: 'Ammonia (NH₃)',
    unit: 'mg/L',
    dataType: ParameterDataType.NUMBER,
    precision: 3,
    group: ParameterGroup.NITROGEN_CYCLE,
    optimalMin: 0,
    optimalMax: 0.02,
    warningMin: 0,
    warningMax: 0.05,
    criticalMin: 0,
    criticalMax: 0.1,
    chartColor: '#f59e0b',
    icon: 'alert-triangle',
    displayOrder: 4,
    isRequired: false,
    isQuickAccess: true,
    chartAxisGroup: 'right',
  },
  {
    code: 'nitrite',
    name: 'Nitrite (NO₂⁻)',
    unit: 'mg/L',
    dataType: ParameterDataType.NUMBER,
    precision: 3,
    group: ParameterGroup.NITROGEN_CYCLE,
    optimalMin: 0,
    optimalMax: 0.1,
    warningMin: 0,
    warningMax: 0.5,
    criticalMin: 0,
    criticalMax: 1.0,
    chartColor: '#eab308',
    icon: 'alert-circle',
    displayOrder: 5,
    isRequired: false,
    isQuickAccess: false,
    chartAxisGroup: 'right',
  },
  {
    code: 'salinity',
    name: 'Salinity',
    unit: 'ppt',
    dataType: ParameterDataType.NUMBER,
    precision: 1,
    group: ParameterGroup.BASIC,
    optimalMin: 30,
    optimalMax: 34,
    warningMin: 25,
    warningMax: 36,
    criticalMin: 20,
    criticalMax: 40,
    chartColor: '#14b8a6',
    icon: 'waves',
    displayOrder: 6,
    isRequired: false,
    isQuickAccess: false,
    chartAxisGroup: 'left',
  },
  {
    code: 'turbidity',
    name: 'Turbidity',
    unit: 'NTU',
    dataType: ParameterDataType.NUMBER,
    precision: 2,
    group: ParameterGroup.BASIC,
    optimalMin: 0,
    optimalMax: 5,
    warningMin: 0,
    warningMax: 20,
    criticalMin: 0,
    criticalMax: 50,
    chartColor: '#64748b',
    icon: 'eye-off',
    displayOrder: 7,
    isRequired: false,
    isQuickAccess: false,
    chartAxisGroup: 'left',
  },
];

@Injectable()
export class WaterQualityParameterConfigSeederService {
  private readonly logger = new Logger(
    WaterQualityParameterConfigSeederService.name,
  );

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly configRepository: Repository<WaterQualityParameterConfig>,
  ) {}

  /**
   * Seed the default parameter catalogue for a tenant.
   * Idempotent: existing entries (matched by `code`) are left
   * untouched. Returns the list of codes that got created versus
   * skipped so the caller can surface the outcome in the UI.
   */
  async seedDefaults(tenantId: string): Promise<SeedResult> {
    const existing = await this.configRepository.find({
      where: { tenantId },
      select: ['code'],
    });
    const existingCodes = new Set(existing.map((c) => c.code));

    const seeded: string[] = [];
    const skipped: string[] = [];

    for (const entry of DEFAULT_SEEDS) {
      if (existingCodes.has(entry.code)) {
        skipped.push(entry.code);
        continue;
      }
      const row = this.configRepository.create({
        tenantId,
        ...entry,
        isActive: true,
        isVisible: true,
        templateSource: 'salmonid_default_v1',
      });
      await this.configRepository.save(row);
      seeded.push(entry.code);
    }

    this.logger.log(
      `Parameter config seed for tenant ${tenantId.slice(0, 8)}...: ` +
        `${seeded.length} created, ${skipped.length} skipped.`,
    );
    return { seeded, skipped };
  }

  /** Visible for tests — expose the default seed catalogue. */
  getDefaults(): readonly SeedEntry[] {
    return DEFAULT_SEEDS;
  }
}
