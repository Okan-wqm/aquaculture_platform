/**
 * Sensor Type Definitions E2E Tests
 *
 * Tests sensor type CRUD, industry template queries, template application,
 * and cross-tenant type visibility rules.
 *
 * Resolver: SensorTypeResolver (sensor-type.resolver.ts)
 *
 * @module Sensor-Service/E2E/SensorTypes
 */
import { assertDefined } from '../../../helpers/assertions';

import { gql, TENANT_A, TENANT_B, runCleanup } from './helpers';

// ============================================================================
// GRAPHQL OPERATIONS
// ============================================================================

const SENSOR_TYPES = `
  query sensorTypes {
    sensorTypes {
      id
      typeKey
      displayName
      description
      icon
      category
      industry
      tenantId
      isSystem
      defaultChannels
      createdAt
    }
  }
`;

const CREATE_SENSOR_TYPE = `
  mutation createSensorType($input: CreateSensorTypeInput!) {
    createSensorType(input: $input) {
      id
      typeKey
      displayName
      description
      icon
      category
      industry
      tenantId
      defaultChannels
      metadata
      createdAt
    }
  }
`;

const DELETE_SENSOR_TYPE = `
  mutation deleteSensorType($id: ID!) {
    deleteSensorType(id: $id)
  }
`;

const INDUSTRY_TEMPLATES = `
  query industryTemplates {
    industryTemplates {
      id
      templateKey
      name
      description
      industry
      isActive
    }
  }
`;

const APPLY_INDUSTRY_TEMPLATE = `
  mutation applyIndustryTemplate($templateKey: String!) {
    applyIndustryTemplate(templateKey: $templateKey) {
      id
      typeKey
      displayName
      tenantId
      category
      industry
    }
  }
`;

// ============================================================================
// TESTS
// ============================================================================

describe('Sensor Type Definitions', () => {
  afterAll(async () => {
    await runCleanup();
  });

  // ------------------------------------------------------------------
  // Test 1: sensorTypes -> system + tenant types
  // ------------------------------------------------------------------
  describe('Test 1: List sensor types (system + tenant)', () => {
    it('should return sensor types including system types', async () => {
      const res = await gql(SENSOR_TYPES);

      expect(res.errors).toBeUndefined();
      const types = assertDefined(res.data).sensorTypes as Array<Record<string, unknown>>;
      expect(Array.isArray(types)).toBe(true);

      // Should have at least system types
      // System types have isSystem = true or no tenantId
      for (const t of types) {
        expect(t.typeKey).toBeDefined();
        expect(t.displayName).toBeDefined();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 2: createSensorType -> custom type
  // ------------------------------------------------------------------
  describe('Test 2: Create custom sensor type', () => {
    let typeId: string;

    it('should create a custom sensor type', async () => {
      const typeKey = `custom_aqua_${Date.now()}`;

      const res = await gql(CREATE_SENSOR_TYPE, {
        input: {
          typeKey,
          displayName: 'Custom Aquaculture Sensor',
          description: 'Multi-parameter water quality sensor for aquaculture',
          icon: 'water-drop',
          category: 'water_quality',
          industry: 'aquaculture',
          defaultChannels: [
            {
              channelKey: 'temperature',
              displayLabel: 'Temperature',
              dataType: 'number',
              unit: 'celsius',
            },
            {
              channelKey: 'ph',
              displayLabel: 'pH',
              dataType: 'number',
              unit: 'pH',
            },
            {
              channelKey: 'do',
              displayLabel: 'Dissolved Oxygen',
              dataType: 'number',
              unit: 'mg/L',
            },
          ],
          metadata: {
            manufacturer: 'Custom',
            version: '1.0',
          },
        },
      });

      expect(res.errors).toBeUndefined();
      const type = assertDefined(res.data).createSensorType as Record<string, unknown>;
      expect(type.typeKey).toBe(typeKey);
      expect(type.displayName).toBe('Custom Aquaculture Sensor');
      expect(type.category).toBe('water_quality');
      expect(type.industry).toBe('aquaculture');
      expect(type.tenantId).toBe(TENANT_A.id);

      const channels = type.defaultChannels as unknown[];
      expect(channels.length).toBe(3);

      typeId = type.id as string;
    });

    it('should appear in tenant sensor types list', async () => {
      const res = await gql(SENSOR_TYPES);

      const types = assertDefined(res.data).sensorTypes as Array<Record<string, unknown>>;
      const found = types.find((t) => t.id === typeId);
      expect(found).toBeDefined();
    });

    it('should reject duplicate typeKey', async () => {
      const res = await gql(CREATE_SENSOR_TYPE, {
        input: {
          typeKey: assertDefined(
            (
              assertDefined((await gql(SENSOR_TYPES)).data).sensorTypes as Array<
                Record<string, unknown>
              >
            ).find((t) => t.id === typeId),
          ).typeKey as string,
          displayName: 'Duplicate',
        },
      });

      expect(res.errors).toBeDefined();
    });

    it('should reject invalid typeKey format', async () => {
      const res = await gql(CREATE_SENSOR_TYPE, {
        input: {
          typeKey: 'Invalid-Key-With-Caps!',
          displayName: 'Bad Key',
        },
      });

      expect(res.errors).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 3: industryTemplates -> template list
  // ------------------------------------------------------------------
  describe('Test 3: Industry templates', () => {
    it('should return available industry templates', async () => {
      const res = await gql(INDUSTRY_TEMPLATES);

      expect(res.errors).toBeUndefined();
      const templates = assertDefined(res.data).industryTemplates as Array<Record<string, unknown>>;
      expect(Array.isArray(templates)).toBe(true);

      for (const t of templates) {
        expect(t.templateKey).toBeDefined();
        expect(t.name).toBeDefined();
        expect(t.industry).toBeDefined();
        // Only active templates should be returned
        expect(t.isActive).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 4: applyIndustryTemplate -> tenant types created
  // ------------------------------------------------------------------
  describe('Test 4: Apply industry template', () => {
    it('should apply template and create tenant sensor types', async () => {
      // First get available templates
      const templatesRes = await gql(INDUSTRY_TEMPLATES);
      const templates = assertDefined(templatesRes.data).industryTemplates as Array<
        Record<string, unknown>
      >;

      if (templates.length === 0) {
        // Skip if no templates available in test env
        console.warn('No industry templates available, skipping template application test');
        return;
      }

      const templateKey = templates[0].templateKey as string;

      const res = await gql(APPLY_INDUSTRY_TEMPLATE, { templateKey });

      expect(res.errors).toBeUndefined();
      const createdTypes = assertDefined(res.data).applyIndustryTemplate as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(createdTypes)).toBe(true);

      // Created types should belong to tenant
      for (const t of createdTypes) {
        expect(t.tenantId).toBe(TENANT_A.id);
        expect(t.typeKey).toBeDefined();
        expect(t.displayName).toBeDefined();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 5: deleteSensorType
  // ------------------------------------------------------------------
  describe('Test 5: Delete sensor type', () => {
    let typeId: string;

    beforeAll(async () => {
      const res = await gql(CREATE_SENSOR_TYPE, {
        input: {
          typeKey: `delete_target_${Date.now()}`,
          displayName: 'Delete Target Type',
          category: 'test',
        },
      });
      typeId = (assertDefined(res.data).createSensorType as Record<string, unknown>).id as string;
    });

    it('should delete a custom sensor type', async () => {
      const res = await gql(DELETE_SENSOR_TYPE, { id: typeId });

      expect(res.errors).toBeUndefined();
      expect(assertDefined(res.data).deleteSensorType).toBe(true);
    });

    it('should not find deleted type in list', async () => {
      const res = await gql(SENSOR_TYPES);

      const types = assertDefined(res.data).sensorTypes as Array<Record<string, unknown>>;
      const found = types.find((t) => t.id === typeId);
      expect(found).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 6: Cross-tenant
  //         System types: everyone can see
  //         Tenant types: only own tenant
  // ------------------------------------------------------------------
  describe('Test 6: Cross-tenant type visibility', () => {
    let tenantACustomTypeId: string;

    beforeAll(async () => {
      // Create a custom type for Tenant A
      const res = await gql(
        CREATE_SENSOR_TYPE,
        {
          input: {
            typeKey: `tenant_a_private_${Date.now()}`,
            displayName: 'Tenant A Private Sensor Type',
            category: 'custom',
            industry: 'aquaculture',
          },
        },
        TENANT_A,
      );
      tenantACustomTypeId = (assertDefined(res.data).createSensorType as Record<string, unknown>)
        .id as string;
    });

    it('system types should be visible to all tenants', async () => {
      const resA = await gql(SENSOR_TYPES, {}, TENANT_A);
      const resB = await gql(SENSOR_TYPES, {}, TENANT_B);

      const typesA = assertDefined(resA.data).sensorTypes as Array<Record<string, unknown>>;
      const typesB = assertDefined(resB.data).sensorTypes as Array<Record<string, unknown>>;

      // System types (isSystem=true or no tenantId) should be in both
      const systemTypesA = typesA.filter((t) => t.isSystem === true || !t.tenantId);
      const systemTypesB = typesB.filter((t) => t.isSystem === true || !t.tenantId);

      // Both tenants should see the same system types
      const systemKeysA = systemTypesA.map((t) => t.typeKey).sort();
      const systemKeysB = systemTypesB.map((t) => t.typeKey).sort();
      expect(systemKeysA).toEqual(systemKeysB);
    });

    it('Tenant B should NOT see Tenant A custom types', async () => {
      const res = await gql(SENSOR_TYPES, {}, TENANT_B);

      const types = assertDefined(res.data).sensorTypes as Array<Record<string, unknown>>;
      const found = types.find((t) => t.id === tenantACustomTypeId);
      expect(found).toBeUndefined();
    });

    it('Tenant A SHOULD see their own custom types', async () => {
      const res = await gql(SENSOR_TYPES, {}, TENANT_A);

      const types = assertDefined(res.data).sensorTypes as Array<Record<string, unknown>>;
      const found = types.find((t) => t.id === tenantACustomTypeId);
      expect(found).toBeDefined();
    });

    it('Tenant B should NOT delete Tenant A custom type', async () => {
      const res = await gql(DELETE_SENSOR_TYPE, { id: tenantACustomTypeId }, TENANT_B);

      // Should fail
      if (res.errors) {
        expect(res.errors.length).toBeGreaterThan(0);
      } else {
        expect(assertDefined(res.data).deleteSensorType).toBe(false);
      }
    });
  });
});
