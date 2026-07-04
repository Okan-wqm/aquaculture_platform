/**
 * FeedingProtocolSeederService
 *
 * Seeds a tenant with the default Atlantic-salmon feeding
 * protocols covering the FRY → STARTER → GROWER → FINISHER life
 * stages that every Norwegian grow-out farm operates. Each
 * protocol carries temperature-curve feeding multipliers (FAO
 * reference ranges) and a target FCR so the feeding scheduler
 * can compute daily rations out of the box.
 *
 * Phase 7.5.* of the "Farm modülü kalan kör noktalar" plan —
 * third seeder in the onboarding fan-out after
 * `WaterQualityParameterConfigSeederService` and
 * `SpeciesSeederService`.
 *
 * # Idempotency
 *
 * A second call re-detects existing protocols by `(species,
 * stage)` pair and skips them. Operators can safely add or
 * tune individual protocols — a rerun never clobbers an
 * override.
 *
 * # Why only Atlantic Salmon?
 *
 * The seeder matches the species catalogue the sibling
 * `SpeciesSeederService` creates — Atlantic Salmon is the only
 * non-cleaner-fish default. Cleaner fish (Lumpfish, Ballan
 * Wrasse) don't follow the same grower-pellet life stages;
 * their feeding is ad-libitum / passive grazing, so a protocol
 * row would be misleading.
 *
 * # Marking isDefault
 *
 * Each protocol lands with `isDefault: true` so the batch
 * creation flow automatically picks it for new salmon batches.
 * Operators can un-flag the default and attach their own via
 * the `defaultFeedingProtocol` admin flow — the seeder never
 * reasserts the flag.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeedType } from '../entities/feed.entity';
import { FeedingProtocol } from '../entities/feeding-protocol.entity';

export interface FeedingProtocolSeedResult {
  seeded: string[];
  skipped: string[];
}

interface TemperatureRangeEntry {
  minTemp: number;
  maxTemp: number;
  feedingMultiplier: number;
}

interface FeedingProtocolSeedEntry {
  name: string;
  species: string;
  stage: FeedType;
  description: string;
  targetFcr: number;
  minDissolvedOxygen: number;
  optimalTemperature: {
    min: number;
    max: number;
    unit: 'celsius' | 'fahrenheit';
  };
  temperatureRanges: TemperatureRangeEntry[];
}

/**
 * Atlantic-salmon life-stage protocols. Temperature-curve
 * multipliers come from the Skretting / EWOS reference tables
 * common to Norwegian grow-out operations; FCR targets are
 * industry-standard for each stage.
 */
const DEFAULT_SEEDS: readonly FeedingProtocolSeedEntry[] = [
  {
    name: 'Atlantic Salmon — Fry',
    species: 'ATLANTIC_SALMON',
    stage: FeedType.FRY,
    description:
      'Freshwater fry phase (0.2g → 5g). Crumb feed 5–8× daily; ' +
      'temperature-curve biased to 10–14°C optimum.',
    targetFcr: 0.9,
    minDissolvedOxygen: 7.0,
    optimalTemperature: { min: 10, max: 14, unit: 'celsius' },
    temperatureRanges: [
      { minTemp: 4, maxTemp: 7, feedingMultiplier: 0.5 },
      { minTemp: 7, maxTemp: 10, feedingMultiplier: 0.8 },
      { minTemp: 10, maxTemp: 14, feedingMultiplier: 1.0 },
      { minTemp: 14, maxTemp: 17, feedingMultiplier: 0.9 },
    ],
  },
  {
    name: 'Atlantic Salmon — Starter',
    species: 'ATLANTIC_SALMON',
    stage: FeedType.STARTER,
    description:
      'Pre-smolt freshwater phase (5g → 80g). Pellet size 1.5–3mm; ' + '3–4 feedings/day.',
    targetFcr: 1.0,
    minDissolvedOxygen: 6.5,
    optimalTemperature: { min: 10, max: 14, unit: 'celsius' },
    temperatureRanges: [
      { minTemp: 4, maxTemp: 7, feedingMultiplier: 0.5 },
      { minTemp: 7, maxTemp: 10, feedingMultiplier: 0.85 },
      { minTemp: 10, maxTemp: 14, feedingMultiplier: 1.0 },
      { minTemp: 14, maxTemp: 17, feedingMultiplier: 0.95 },
    ],
  },
  {
    name: 'Atlantic Salmon — Grower',
    species: 'ATLANTIC_SALMON',
    stage: FeedType.GROWER,
    description:
      'Sea-water grow-out phase (80g → 3kg). Pellet size 4–7mm; ' +
      '2–3 feedings/day; main biomass cost centre.',
    targetFcr: 1.15,
    minDissolvedOxygen: 6.0,
    optimalTemperature: { min: 8, max: 14, unit: 'celsius' },
    temperatureRanges: [
      { minTemp: 2, maxTemp: 6, feedingMultiplier: 0.5 },
      { minTemp: 6, maxTemp: 10, feedingMultiplier: 0.85 },
      { minTemp: 10, maxTemp: 14, feedingMultiplier: 1.0 },
      { minTemp: 14, maxTemp: 18, feedingMultiplier: 0.9 },
      { minTemp: 18, maxTemp: 22, feedingMultiplier: 0.6 },
    ],
  },
  {
    name: 'Atlantic Salmon — Finisher',
    species: 'ATLANTIC_SALMON',
    stage: FeedType.FINISHER,
    description:
      'Pre-harvest finisher phase (3kg → harvest). Pellet 7–9mm; ' +
      'optimised fillet quality (astaxanthin, fatty acid profile).',
    targetFcr: 1.25,
    minDissolvedOxygen: 6.0,
    optimalTemperature: { min: 8, max: 14, unit: 'celsius' },
    temperatureRanges: [
      { minTemp: 2, maxTemp: 6, feedingMultiplier: 0.4 },
      { minTemp: 6, maxTemp: 10, feedingMultiplier: 0.8 },
      { minTemp: 10, maxTemp: 14, feedingMultiplier: 1.0 },
      { minTemp: 14, maxTemp: 18, feedingMultiplier: 0.85 },
    ],
  },
];

@Injectable()
export class FeedingProtocolSeederService {
  private readonly logger = new Logger(FeedingProtocolSeederService.name);

  constructor(
    @InjectRepository(FeedingProtocol)
    private readonly protocolRepository: Repository<FeedingProtocol>,
  ) {}

  async seedDefaults(tenantId: string): Promise<FeedingProtocolSeedResult> {
    const existing = await this.protocolRepository.find({
      where: { tenantId },
      select: ['species', 'stage'],
    });
    const existingKeys = new Set(existing.map((p) => `${p.species}:${p.stage}`));

    const seeded: string[] = [];
    const skipped: string[] = [];

    for (const entry of DEFAULT_SEEDS) {
      const key = `${entry.species}:${entry.stage}`;
      if (existingKeys.has(key)) {
        skipped.push(key);
        continue;
      }
      const row = this.protocolRepository.create({
        tenantId,
        name: entry.name,
        description: entry.description,
        species: entry.species,
        stage: entry.stage,
        // Map the compact seed shape to the canonical TemperatureRange the entity
        // + FeedingProtocolRateService expect ({ min, max, unit, feedingMultiplier }).
        // Previously the seeder wrote { minTemp, maxTemp } straight into the JSONB,
        // so min/max were undefined at read time and the temperature multiplier was
        // silently lost for every seeded protocol.
        temperatureRanges: entry.temperatureRanges.map((t) => ({
          min: t.minTemp,
          max: t.maxTemp,
          unit: 'celsius' as const,
          feedingMultiplier: t.feedingMultiplier,
        })),
        targetFcr: entry.targetFcr,
        minDissolvedOxygen: entry.minDissolvedOxygen,
        optimalTemperature: entry.optimalTemperature,
        isActive: true,
        isDefault: true,
      });
      await this.protocolRepository.save(row);
      seeded.push(key);
    }

    this.logger.log(
      `Feeding protocol seed for tenant ${tenantId.slice(0, 8)}...: ` +
        `${seeded.length} created, ${skipped.length} skipped.`,
    );
    return { seeded, skipped };
  }

  /** Visible for tests — expose the default seed catalogue. */
  getDefaults(): readonly FeedingProtocolSeedEntry[] {
    return DEFAULT_SEEDS;
  }
}
