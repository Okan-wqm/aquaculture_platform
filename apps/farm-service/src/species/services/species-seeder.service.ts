/**
 * SpeciesSeederService
 *
 * Seeds a fresh tenant's `species` table with the standard
 * salmonid-aquaculture starter set that every grow-out farm
 * tracks on day one: Atlantic Salmon + the two cleaner-fish
 * species (Lumpfish + Ballan Wrasse) that salmon farms deploy
 * for sea-lice control. Scientific names and classification
 * metadata match FishBase / Mattilsynet records so downstream
 * regulatory exports (Mattilsynet reports, biomass reports) line
 * up with the reference catalogues out of the box.
 *
 * Phase 7.5 of the "Farm modülü kalan kör noktalar" plan — the
 * second onboarding seeder to land after
 * `WaterQualityParameterConfigSeederService`. The tenant
 * onboarding event handler (subscribes to `TenantCreated`)
 * invokes every registered seeder sequentially; a failure in
 * one seeder does not block the others.
 *
 * # Idempotency
 *
 * A second call on the same tenant re-detects existing rows by
 * `code` and skips them, so operators can safely re-run after
 * adding a single species manually. The seeder ONLY creates
 * rows — it never updates an existing row's fields, so an
 * operator override survives a rerun.
 *
 * # Tenant-scoped, not global
 *
 * Unlike `EquipmentType` / `FeedType` / `ChemicalType` (which
 * are cross-tenant catalogue tables), `Species` is tenant-
 * scoped — a farm operator picks which species they actually
 * work with and configures per-species thresholds. The
 * default seed set therefore lives on the tenant's rows.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { resolveOfficialSpeciesCode } from '../data/official-species-codes';
import {
  Species,
  SpeciesCategory,
  SpeciesStatus,
  SpeciesWaterType,
} from '../entities/species.entity';

export interface SpeciesSeedResult {
  seeded: string[];
  skipped: string[];
}

interface SpeciesSeedEntry {
  code: string;
  scientificName: string;
  commonName: string;
  localName?: string;
  family: string;
  genus: string;
  category: SpeciesCategory;
  waterType: SpeciesWaterType;
  description: string;
  isCleanerFish: boolean;
  cleanerFishType?: string;
}

/**
 * Atlantic-salmon grow-out starter catalogue. Scientific names
 * and family / genus fields come from FishBase; the two
 * cleaner-fish entries carry the `cleanerFishType` discriminator
 * the batch module uses to route deployments through the
 * cleaner-fish flow.
 */
const DEFAULT_SEEDS: readonly SpeciesSeedEntry[] = [
  {
    code: 'ATLANTIC_SALMON',
    scientificName: 'Salmo salar',
    commonName: 'Atlantic Salmon',
    localName: 'Atlantik Somonu',
    family: 'Salmonidae',
    genus: 'Salmo',
    category: SpeciesCategory.FISH,
    waterType: SpeciesWaterType.SALTWATER,
    description:
      'Cold-water anadromous salmonid; the default grow-out ' +
      'species for Norwegian / Scottish / Faroese marine farms. ' +
      'Smolt-to-harvest cycle ~14–22 months in sea cages.',
    isCleanerFish: false,
  },
  {
    code: 'LUMPFISH',
    scientificName: 'Cyclopterus lumpus',
    commonName: 'Lumpfish',
    localName: 'Taşbalığı',
    family: 'Cyclopteridae',
    genus: 'Cyclopterus',
    category: SpeciesCategory.FISH,
    waterType: SpeciesWaterType.SALTWATER,
    description:
      'Cold-water cleaner fish — grazes sea lice off salmon. ' +
      'Effective year-round in Norwegian waters (3–15°C). ' +
      'Deployed at 4–10% of the salmon cohort biomass.',
    isCleanerFish: true,
    cleanerFishType: 'lumpfish',
  },
  {
    code: 'BALLAN_WRASSE',
    scientificName: 'Labrus bergylta',
    commonName: 'Ballan Wrasse',
    localName: 'Balin Lapin',
    family: 'Labridae',
    genus: 'Labrus',
    category: SpeciesCategory.FISH,
    waterType: SpeciesWaterType.SALTWATER,
    description:
      'Warm-water cleaner fish — preferred over lumpfish when ' +
      'sea temperatures exceed 12°C. Slower to deploy (smaller ' +
      'hatchery output) but retains activity through summer.',
    isCleanerFish: true,
    cleanerFishType: 'wrasse',
  },
];

@Injectable()
export class SpeciesSeederService {
  private readonly logger = new Logger(SpeciesSeederService.name);

  constructor(
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
  ) {}

  /**
   * Seed the default species catalogue for a tenant.
   * Idempotent: existing rows (matched by `code`) are left
   * untouched. Returns the created / skipped codes so the
   * onboarding handler can log a summary.
   */
  async seedDefaults(tenantId: string): Promise<SpeciesSeedResult> {
    const existing = await this.speciesRepository.find({
      where: { tenantId },
      select: ['code'],
    });
    const existingCodes = new Set(existing.map((s) => s.code));

    const seeded: string[] = [];
    const skipped: string[] = [];

    for (const entry of DEFAULT_SEEDS) {
      if (existingCodes.has(entry.code)) {
        skipped.push(entry.code);
        continue;
      }
      const row = this.speciesRepository.create({
        tenantId,
        ...entry,
        // Official regulatory artskode from the seed-map SSoT — reports fail
        // closed on species without one, so new tenants start mapped.
        officialCode: resolveOfficialSpeciesCode(entry.scientificName),
        status: SpeciesStatus.ACTIVE,
        isActive: true,
        isDeleted: false,
      });
      await this.speciesRepository.save(row);
      seeded.push(entry.code);
    }

    this.logger.log(
      `Species seed for tenant ${tenantId.slice(0, 8)}...: ` +
        `${seeded.length} created, ${skipped.length} skipped.`,
    );
    return { seeded, skipped };
  }

  /** Visible for tests — expose the default seed catalogue. */
  getDefaults(): readonly SpeciesSeedEntry[] {
    return DEFAULT_SEEDS;
  }
}
