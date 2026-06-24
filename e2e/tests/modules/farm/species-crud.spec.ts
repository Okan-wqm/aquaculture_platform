/**
 * Species CRUD E2E Tests
 *
 * Species yaratma, okuma, guncelleme, silme ve filtreleme islemlerini
 * end-to-end olarak test eder.
 *
 * Resolvers:
 * - createSpecies (mutation)
 * - species (query by id)
 * - speciesList (query with filter)
 * - speciesByCode (query by code)
 * - updateSpecies (mutation)
 * - deleteSpecies (mutation)
 *
 * @module E2E/Farm/Species
 */
import { assertDefined } from '../../../helpers/assertions';

import {
  gqlExpectSuccess,
  gqlExpectError,
  TENANT_A_ID,
  TENANT_B_ID,
  USER_B_ID,
  SPECIES_FIELDS,
  uniqueSpeciesCode,
  uniqueScientificName,
  createTestSpecies,
} from './test-helpers';

describe('Species CRUD E2E', () => {
  // =========================================================================
  // Test 1: createSpecies -> species(id) -> speciesList(filter)
  // =========================================================================
  describe('Test 1: Create, Get, List', () => {
    let createdSpeciesId: string;
    const speciesCode = uniqueSpeciesCode();
    const scientificName = uniqueScientificName();

    it('should create a species with all required fields', async () => {
      const data = await gqlExpectSuccess<{ createSpecies: Record<string, unknown> }>(
        `
          mutation CreateSpecies($input: CreateSpeciesInput!) {
            createSpecies(input: $input) {
              ${SPECIES_FIELDS}
            }
          }
        `,
        {
          input: {
            scientificName,
            commonName: 'E2E Test Seabass',
            localName: 'Levrek',
            code: speciesCode,
            description: 'E2E test species',
            category: 'FISH',
            waterType: 'SALTWATER',
            family: 'Moronidae',
            genus: 'Dicentrarchus',
            status: 'ACTIVE',
            tags: ['market-size', 'grower'],
            notes: 'Created by e2e test',
          },
        },
      );

      const species = data.createSpecies;
      createdSpeciesId = species.id as string;

      expect(species.id).toBeDefined();
      expect(species.tenantId).toBe(TENANT_A_ID);
      expect(species.scientificName).toBe(scientificName);
      expect(species.commonName).toBe('E2E Test Seabass');
      expect(species.localName).toBe('Levrek');
      expect(species.code).toBe(speciesCode);
      expect(species.category).toBe('FISH');
      expect(species.waterType).toBe('SALTWATER');
      expect(species.family).toBe('Moronidae');
      expect(species.genus).toBe('Dicentrarchus');
      expect(species.status).toBe('ACTIVE');
      expect(species.isActive).toBe(true);
      expect(species.isCleanerFish).toBe(false);
      expect(species.tags).toEqual(expect.arrayContaining(['market-size', 'grower']));
    });

    it('should get species by ID', async () => {
      const data = await gqlExpectSuccess<{ species: Record<string, unknown> }>(
        `
          query GetSpecies($id: ID!) {
            species(id: $id) {
              ${SPECIES_FIELDS}
            }
          }
        `,
        { id: createdSpeciesId },
      );

      expect(data.species.id).toBe(createdSpeciesId);
      expect(data.species.scientificName).toBe(scientificName);
      expect(data.species.code).toBe(speciesCode);
    });

    it('should get species by code', async () => {
      const data = await gqlExpectSuccess<{ speciesByCode: Record<string, unknown> }>(
        `
          query GetSpeciesByCode($code: String!) {
            speciesByCode(code: $code) {
              ${SPECIES_FIELDS}
            }
          }
        `,
        { code: speciesCode },
      );

      expect(data.speciesByCode.id).toBe(createdSpeciesId);
      expect(data.speciesByCode.code).toBe(speciesCode);
    });

    it('should list species with filter', async () => {
      const data = await gqlExpectSuccess<{
        speciesList: { items: Array<Record<string, unknown>>; total: number };
      }>(
        `
          query ListSpecies($filter: SpeciesFilterInput) {
            speciesList(filter: $filter) {
              items {
                ${SPECIES_FIELDS}
              }
              total
            }
          }
        `,
        {
          filter: {
            category: 'FISH',
            waterType: 'SALTWATER',
            isActive: true,
          },
        },
      );

      expect(data.speciesList.items).toBeDefined();
      expect(data.speciesList.total).toBeGreaterThanOrEqual(1);

      const found = data.speciesList.items.find(
        (s: Record<string, unknown>) => s.id === createdSpeciesId,
      );
      expect(found).toBeDefined();
      expect(assertDefined(found).scientificName).toBe(scientificName);
    });
  });

  // =========================================================================
  // Test 2: Unique constraint — ayni tenant'ta ayni code veya scientificName
  // =========================================================================
  describe('Test 2: Unique Constraints', () => {
    let existingCode: string;
    let existingScientificName: string;

    beforeAll(async () => {
      const species = await createTestSpecies();
      existingCode = species.code as string;
      existingScientificName = species.scientificName as string;
    });

    it('should reject duplicate code in the same tenant', async () => {
      const errors = await gqlExpectError(
        `
          mutation CreateSpecies($input: CreateSpeciesInput!) {
            createSpecies(input: $input) { id }
          }
        `,
        {
          input: {
            scientificName: uniqueScientificName(),
            commonName: 'Duplicate Code Test',
            code: existingCode,
            category: 'FISH',
            waterType: 'SALTWATER',
          },
        },
      );

      expect(errors.length).toBeGreaterThan(0);
      const errorMessages = errors.map((e) => e.message.toLowerCase()).join(' ');
      expect(
        errorMessages.includes('duplicate') ||
          errorMessages.includes('exists') ||
          errorMessages.includes('unique') ||
          errorMessages.includes('already') ||
          errorMessages.includes('conflict'),
      ).toBe(true);
    });

    it('should reject duplicate scientificName in the same tenant', async () => {
      const errors = await gqlExpectError(
        `
          mutation CreateSpecies($input: CreateSpeciesInput!) {
            createSpecies(input: $input) { id }
          }
        `,
        {
          input: {
            scientificName: existingScientificName,
            commonName: 'Duplicate SciName Test',
            code: uniqueSpeciesCode(),
            category: 'FISH',
            waterType: 'SALTWATER',
          },
        },
      );

      expect(errors.length).toBeGreaterThan(0);
    });

    it('should allow same code in a DIFFERENT tenant', async () => {
      const data = await gqlExpectSuccess<{ createSpecies: Record<string, unknown> }>(
        `
          mutation CreateSpecies($input: CreateSpeciesInput!) {
            createSpecies(input: $input) {
              id code tenantId
            }
          }
        `,
        {
          input: {
            scientificName: uniqueScientificName(),
            commonName: 'Cross-tenant Code',
            code: existingCode,
            category: 'FISH',
            waterType: 'SALTWATER',
          },
        },
        TENANT_B_ID,
        USER_B_ID,
      );

      expect(data.createSpecies.code).toBe(existingCode);
      expect(data.createSpecies.tenantId).toBe(TENANT_B_ID);
    });
  });

  // =========================================================================
  // Test 3: updateSpecies -> deleteSpecies
  // =========================================================================
  describe('Test 3: Update and Delete', () => {
    let speciesId: string;

    beforeAll(async () => {
      const species = await createTestSpecies({
        commonName: 'Update Test Fish',
        notes: 'Original notes',
      });
      speciesId = species.id as string;
    });

    it('should update species fields', async () => {
      const data = await gqlExpectSuccess<{ updateSpecies: Record<string, unknown> }>(
        `
          mutation UpdateSpecies($input: UpdateSpeciesInput!) {
            updateSpecies(input: $input) {
              ${SPECIES_FIELDS}
            }
          }
        `,
        {
          input: {
            id: speciesId,
            commonName: 'Updated Fish Name',
            localName: 'Guncellenmis Balik',
            notes: 'Updated notes',
            status: 'EXPERIMENTAL',
            tags: ['organic', 'certified'],
          },
        },
      );

      expect(data.updateSpecies.id).toBe(speciesId);
      expect(data.updateSpecies.commonName).toBe('Updated Fish Name');
      expect(data.updateSpecies.localName).toBe('Guncellenmis Balik');
      expect(data.updateSpecies.notes).toBe('Updated notes');
      expect(data.updateSpecies.status).toBe('EXPERIMENTAL');
      expect(data.updateSpecies.tags).toEqual(expect.arrayContaining(['organic', 'certified']));
    });

    it('should soft-delete species', async () => {
      const data = await gqlExpectSuccess<{
        deleteSpecies: { success: boolean; id: string; message: string };
      }>(
        `
          mutation DeleteSpecies($id: ID!) {
            deleteSpecies(id: $id) {
              success
              id
              message
            }
          }
        `,
        { id: speciesId },
      );

      expect(data.deleteSpecies.success).toBe(true);
      expect(data.deleteSpecies.id).toBe(speciesId);
    });

    it('should not return deleted species in speciesList (isActive filter)', async () => {
      const data = await gqlExpectSuccess<{
        speciesList: { items: Array<Record<string, unknown>> };
      }>(
        `
          query ListSpecies($filter: SpeciesFilterInput) {
            speciesList(filter: $filter) {
              items { id isActive }
            }
          }
        `,
        { filter: { isActive: true } },
      );

      const found = data.speciesList.items.find((s: Record<string, unknown>) => s.id === speciesId);
      expect(found).toBeUndefined();
    });
  });

  // =========================================================================
  // Test 4: Species enums — category, waterType, status
  // =========================================================================
  describe('Test 4: Species Enums', () => {
    const categoryValues = [
      'FISH',
      'SHRIMP',
      'PRAWN',
      'CRAB',
      'LOBSTER',
      'MOLLUSK',
      'SEAWEED',
      'OTHER',
    ];
    const waterTypeValues = ['FRESHWATER', 'SALTWATER', 'BRACKISH'];
    const statusValues = ['ACTIVE', 'INACTIVE', 'EXPERIMENTAL', 'DISCONTINUED'];

    it.each(categoryValues)('should create species with category=%s', async (category) => {
      const species = await createTestSpecies({ category });
      expect(species.category).toBe(category);
    });

    it.each(waterTypeValues)('should create species with waterType=%s', async (waterType) => {
      const species = await createTestSpecies({ waterType });
      expect(species.waterType).toBe(waterType);
    });

    it.each(statusValues)('should create species with status=%s', async (status) => {
      const species = await createTestSpecies({ status });
      expect(species.status).toBe(status);
    });
  });

  // =========================================================================
  // Test 5: Cross-tenant isolation
  // =========================================================================
  describe('Test 5: Cross-tenant Isolation', () => {
    let tenantASpeciesId: string;

    beforeAll(async () => {
      const species = await createTestSpecies({ commonName: 'Tenant A Only Species' }, TENANT_A_ID);
      tenantASpeciesId = species.id as string;
    });

    it('should NOT return Tenant A species when Tenant B queries species(id)', async () => {
      const errors = await gqlExpectError(
        `
          query GetSpecies($id: ID!) {
            species(id: $id) { id tenantId }
          }
        `,
        { id: tenantASpeciesId },
        TENANT_B_ID,
        USER_B_ID,
      );

      expect(errors.length).toBeGreaterThan(0);
    });

    it('should NOT include Tenant A species in Tenant B speciesList', async () => {
      const data = await gqlExpectSuccess<{
        speciesList: { items: Array<Record<string, unknown>> };
      }>(
        `
          query ListSpecies($filter: SpeciesFilterInput) {
            speciesList(filter: $filter) {
              items { id tenantId }
            }
          }
        `,
        { filter: { isActive: true } },
        TENANT_B_ID,
        USER_B_ID,
      );

      const leak = data.speciesList.items.find(
        (s: Record<string, unknown>) => s.id === tenantASpeciesId,
      );
      expect(leak).toBeUndefined();
    });
  });
});
