/**
 * Official species-code seed map (SSoT) — scientific name → the code the
 * Norwegian reporting APIs expect in `artskode` fields.
 *
 * Grow-out species follow the FAO ASFIS 3-alpha convention (settefisk
 * example in the official docs: SAL); the four cleaner-fish codes are the
 * rensefisk enum from the official schema (USB/BER/GRO/BNB). Verify against
 * the live swagger alongside RPT-017 before production submissions —
 * unmapped species fail closed in assembly (blocking MANUAL_REQUIRED), so a
 * wrong omission can never reach the regulator silently.
 *
 * Consumed by: the AddSpeciesOfficialCode migration backfill, the species
 * seeder (stamps new tenants), and Setup → Species (operator-editable per
 * tenant for species outside this map).
 */

export interface OfficialSpeciesCode {
  officialCode: string;
  scientificName: string;
  norwegianName: string;
}

export const OFFICIAL_SPECIES_CODES: readonly OfficialSpeciesCode[] = [
  // Grow-out (FAO ASFIS 3-alpha)
  { officialCode: 'SAL', scientificName: 'Salmo salar', norwegianName: 'Laks' },
  { officialCode: 'TRR', scientificName: 'Oncorhynchus mykiss', norwegianName: 'Regnbueørret' },
  { officialCode: 'TRS', scientificName: 'Salmo trutta', norwegianName: 'Ørret' },
  { officialCode: 'ACH', scientificName: 'Salvelinus alpinus', norwegianName: 'Røye' },
  { officialCode: 'COD', scientificName: 'Gadus morhua', norwegianName: 'Torsk' },
  { officialCode: 'HAL', scientificName: 'Hippoglossus hippoglossus', norwegianName: 'Kveite' },
  { officialCode: 'TUR', scientificName: 'Scophthalmus maximus', norwegianName: 'Piggvar' },
  { officialCode: 'BSS', scientificName: 'Dicentrarchus labrax', norwegianName: 'Havabbor' },
  { officialCode: 'SBG', scientificName: 'Sparus aurata', norwegianName: 'Dorade' },
  // Cleaner fish (official rensefisk enum)
  { officialCode: 'USB', scientificName: 'Cyclopterus lumpus', norwegianName: 'Rognkjeks' },
  { officialCode: 'BER', scientificName: 'Labrus bergylta', norwegianName: 'Berggylt' },
  { officialCode: 'GRO', scientificName: 'Symphodus melops', norwegianName: 'Grønngylt' },
  { officialCode: 'BNB', scientificName: 'Ctenolabrus rupestris', norwegianName: 'Bergnebb' },
] as const;

/**
 * FARM-MEDIUM-158 — the SINGLE source of truth for the official artskode shape.
 * Every Mattilsynet species code in the seed map above is exactly three
 * uppercase letters (SAL, USB, BER, …); the regulatory assemblers must all
 * validate against THIS pattern rather than forking their own (escape used
 * `{3}`, settefisk used `{2,5}` — the loose one would pass a non-official code
 * straight to the regulator).
 */
export const OFFICIAL_ARTSKODE_PATTERN = /^[A-Z]{3}$/;

/** Case-insensitive scientific-name lookup into the seed map. */
export function resolveOfficialSpeciesCode(scientificName: string): string | undefined {
  const needle = scientificName.trim().toLowerCase();
  return OFFICIAL_SPECIES_CODES.find((entry) => entry.scientificName.toLowerCase() === needle)
    ?.officialCode;
}
