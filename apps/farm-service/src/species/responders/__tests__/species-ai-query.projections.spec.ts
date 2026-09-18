/**
 * Projection spec for the species farm-AI responder (PR-4): PII deep ban and
 * JSONB blob stripping.
 */
import { projectSpecies } from '../projections';
import { Species } from '../../entities/species.entity';

const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
  'description',
  'optimalConditions',
  'growthParameters',
  'marketInfo',
  'breedingInfo',
  'growthStages',
  'harvestDaysPerInputType',
  'tenantId',
  'createdAt',
  'updatedAt',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const SPECIES: Species = {
  id: 'sp1',
  tenantId: 't',
  scientificName: 'Dicentrarchus labrax',
  commonName: 'European Seabass',
  localName: 'Levrek',
  code: 'SEABASS',
  officialCode: 'DL',
  description: 'species description',
  category: 'warm_water',
  waterType: 'saltwater',
  family: 'Moronidae',
  genus: 'Dicentrarchus',
  optimalConditions: { temperature: { optimal: 22 } },
  growthParameters: { avgSGR: 1.4 },
  harvestDaysPerInputType: { fry: 400 },
  growthStages: [{ name: 'grower' }],
  marketInfo: { pricePerKg: 9 },
  breedingInfo: { season: 'winter' },
  status: 'active',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Species;

describe('species farm-AI projections (PR-4 read-only namespace)', () => {
  it('strips bulky JSONB blobs and entity metadata — deep key scan', () => {
    const projection = projectSpecies(SPECIES);
    const keys = collectKeys(projection);
    for (const banned of BANNED_KEYS) {
      expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
    }
  });

  it('keeps identity + classification + lifecycle status', () => {
    const projection = projectSpecies(SPECIES);
    expect(projection).toMatchObject({
      scientificName: 'Dicentrarchus labrax',
      commonName: 'European Seabass',
      localName: 'Levrek',
      code: 'SEABASS',
      category: 'warm_water',
      waterType: 'saltwater',
      status: 'active',
      isActive: true,
    });
  });
});
