/**
 * TankOperation enum SSoT (Single Source of Truth)
 *
 * WHY this file exists
 * --------------------
 * OperationType, CullReason and MortalityReason were previously declared THREE
 * times each (entity copy + command copy + the Postgres enum type), and the
 * copies had DRIFTED:
 *   - the entity CullReason omitted QUALITY  → a QUALITY cull threw 22P02 at INSERT
 *     (FARM-HIGH-054)
 *   - the entity MortalityReason omitted PREDATION + CANNIBALISM → real predation /
 *     cannibalism mortality was silently coerced to UNKNOWN (FARM-MEDIUM-052)
 *
 * This leaf module is the ONE home for the three persistence enums. The entity
 * re-exports them (so `@Column({ enum })` and every existing importer keep one
 * identity), the command files re-export them, and the Postgres enum types are
 * brought into line by migration 1801000000000. The canonical VALUE sets mirror
 * the event-contracts MORTALITY_REASONS / CULL_REASONS (lowercase wire values).
 *
 * Zero imports here on purpose: keeping the leaf free of GraphQL / TypeORM /
 * entity imports prevents any circular-dependency or duplicate-registration
 * hazard. registerEnumType stays at its existing single call site per enum.
 */

/**
 * Operasyon tipi — production fish + cleaner fish operations.
 */
export enum OperationType {
  // Production fish operasyonları
  MORTALITY = 'mortality', // Doğal ölüm
  CULL = 'cull', // Ayıklama (small, deformed, sick)
  TRANSFER_OUT = 'transfer_out', // Transfer çıkış
  TRANSFER_IN = 'transfer_in', // Transfer giriş
  HARVEST = 'harvest', // Hasat
  SAMPLING = 'sampling', // Örnekleme
  ADJUSTMENT = 'adjustment', // Manuel düzeltme

  // Cleaner fish operasyonları
  CLEANER_DEPLOYMENT = 'cleaner_deployment', // Cleaner fish tanka ekleme
  CLEANER_MORTALITY = 'cleaner_mortality', // Cleaner fish ölümü
  CLEANER_REMOVAL = 'cleaner_removal', // Cleaner fish çıkarma (cull/disposal)
  CLEANER_TRANSFER_OUT = 'cleaner_transfer_out', // Cleaner fish transfer çıkış
  CLEANER_TRANSFER_IN = 'cleaner_transfer_in', // Cleaner fish transfer giriş
}

/**
 * Ayıklama (cull) nedeni.
 *
 * VALUES mirror event-contracts CULL_REASONS exactly (lowercase). QUALITY is
 * the value the entity copy was missing — its absence threw a DB enum violation
 * on a quality cull (FARM-HIGH-054).
 */
export enum CullReason {
  SMALL_SIZE = 'small_size', // Küçük boy
  DEFORMED = 'deformed', // Deformite
  SICK = 'sick', // Hasta
  POOR_GROWTH = 'poor_growth', // Zayıf büyüme
  GRADING = 'grading', // Grading sonucu
  QUALITY = 'quality', // Kalite yetersizliği
  OTHER = 'other', // Diğer
}

/**
 * Ölüm (mortality) nedeni.
 *
 * VALUES mirror event-contracts MORTALITY_REASONS exactly (lowercase).
 * PREDATION + CANNIBALISM are the values the entity copy was missing — their
 * absence silently coerced real predation / cannibalism mortality to UNKNOWN
 * (FARM-MEDIUM-052).
 */
export enum MortalityReason {
  DISEASE = 'disease', // Hastalık
  WATER_QUALITY = 'water_quality', // Su kalitesi
  STRESS = 'stress', // Stres
  HANDLING = 'handling', // Taşıma/işleme
  TEMPERATURE = 'temperature', // Sıcaklık şoku
  OXYGEN = 'oxygen', // Oksijen yetersizliği
  PREDATION = 'predation', // Predatör
  CANNIBALISM = 'cannibalism', // Yamyamlık
  UNKNOWN = 'unknown', // Bilinmiyor
  OTHER = 'other', // Diğer
}

/**
 * Type guard for CullReason — replaces the banned `value as CullReason` casts.
 * Used by the REST controller's reason parser so an unknown string falls back
 * to OTHER instead of being unsafely asserted into the enum.
 */
export function isCullReason(value: string | undefined | null): value is CullReason {
  return value != null && (Object.values(CullReason) as string[]).includes(value);
}

/**
 * Type guard for MortalityReason — replaces the banned uppercased-key lookup
 * (`MortalityReason[input.toUpperCase()] ?? UNKNOWN`) that WAS the silent
 * PREDATION/CANNIBALISM → UNKNOWN coercion bug.
 */
export function isMortalityReason(
  value: string | undefined | null,
): value is MortalityReason {
  return value != null && (Object.values(MortalityReason) as string[]).includes(value);
}
