/**
 * PURE projections for the species farm-AI responder (PR-4, Production
 * specialist). Covers the species catalogue listing.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO entity metadata (createdAt/updatedAt/tenantId) and NO bulky JSONB
 *    blobs (optimalConditions/growthParameters/marketInfo/breedingInfo …) —
 *    the AI persona gets identity + classification + lifecycle status only.
 */
import { Species } from '../entities/species.entity';

/** Species catalogue row. */
export interface SpeciesDto {
  id: string;
  scientificName: string;
  commonName: string;
  localName: string | null;
  code: string;
  officialCode: string | null;
  category: string;
  waterType: string;
  family: string | null;
  genus: string | null;
  status: string;
  isActive: boolean;
}

/** Project a species catalogue row. */
export function projectSpecies(
  row: Pick<
    Species,
    | 'id'
    | 'scientificName'
    | 'commonName'
    | 'localName'
    | 'code'
    | 'officialCode'
    | 'category'
    | 'waterType'
    | 'family'
    | 'genus'
    | 'status'
    | 'isActive'
  >,
): SpeciesDto {
  return {
    id: row.id,
    scientificName: row.scientificName,
    commonName: row.commonName,
    localName: row.localName ?? null,
    code: row.code,
    officialCode: row.officialCode ?? null,
    category: String(row.category),
    waterType: String(row.waterType),
    family: row.family ?? null,
    genus: row.genus ?? null,
    status: String(row.status),
    isActive: row.isActive === true,
  };
}
