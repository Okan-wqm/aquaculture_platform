/**
 * FARM-HIGH-482 — the growth resolver's inputs on the wire.
 *
 * `recordGrowthSample` could never be called from the web: three independent
 * blockers stood one behind the other (a lowercase enum VALUE rejected at
 * variable coercion, undecorated inputs rejected by the global whitelist pipe,
 * and a display NAME sent where the column is a user UUID). A decorator list
 * proves none of that. This spec drives the real path a request takes: the
 * GraphQL variable coercion against the schema Nest builds from the resolver,
 * then the global ValidationPipe on what coercion produced.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import {
  type GraphQLSchema,
  type OperationDefinitionNode,
  getVariableValues,
  parse,
} from 'graphql';

import {
  GrowthMeasurementFilterInput,
  GrowthResolver,
  RecordGrowthSampleInput,
} from '../growth.resolver';

const BATCH_ID = '94c72240-4d9e-4f68-9c3a-0a7a4d0b4a11';
const TANK_ID = 'f642e76a-5a0b-4a0e-a4c6-3c1f2b6d8e10';
const USER_ID = '8551d3fa-eea8-4e42-97c6-1e63f2b0018f';

/** Mirrors create-service-app's defaults (the farm-service passes no overrides). */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  validationError: { target: false, value: false },
});

async function bind<T extends object>(
  metatype: new () => T,
  value: Record<string, unknown>,
): Promise<T> {
  const bound: unknown = await pipe.transform(value, { type: 'body', metatype });
  return bound as T;
}

const RECORD = parse(`
  mutation RecordGrowthSample($input: RecordGrowthSampleInput!) {
    recordGrowthSample(input: $input) { id }
  }
`);
const LIST = parse(`
  query GrowthMeasurements($filter: GrowthMeasurementFilterInput) {
    growthMeasurements(filter: $filter) { total }
  }
`);

/** What a client's variables become after GraphQL coercion, or the coercion errors. */
function coerce(
  schema: GraphQLSchema,
  document: ReturnType<typeof parse>,
  variables: Record<string, unknown>,
): { values?: Record<string, unknown>; errors: string[] } {
  const operation = document.definitions[0] as OperationDefinitionNode;
  const result = getVariableValues(schema, operation.variableDefinitions ?? [], variables);
  return result.errors
    ? { errors: result.errors.map((error) => error.message) }
    : { values: result.coerced, errors: [] };
}

/** The exact variables the fixed Sampling modal sends. */
function webVariables(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input: {
      batchId: BATCH_ID,
      tankId: TANK_ID,
      measurementDate: '2026-10-27T00:00:00.000Z',
      measurementType: 'ROUTINE',
      measurementMethod: 'MANUAL_SCALE',
      sampleSize: 3,
      populationSize: 4425,
      individualMeasurements: [
        { sampleNumber: 1, weight: 51.2 },
        { sampleNumber: 2, weight: 52.9 },
        { sampleNumber: 3, weight: 50.4 },
      ],
      measuredBy: USER_ID,
      notes: 'weekly sample',
      updateBatchWeight: true,
      ...overrides,
    },
  };
}

describe('growth resolver inputs on the wire (FARM-HIGH-482)', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await module.get(GraphQLSchemaFactory).create([GrowthResolver]);
  });

  describe('variable coercion (the schema)', () => {
    it('accepts the enum NAMES the web sends', () => {
      const { values, errors } = coerce(schema, RECORD, webVariables());

      expect(errors).toEqual([]);
      const input = values?.['input'] as Record<string, unknown>;
      // the schema hands the resolver the enum VALUES
      expect(input['measurementType']).toBe('routine');
      expect(input['measurementMethod']).toBe('manual_scale');
    });

    it.each([
      ['measurementType', 'routine', 'ROUTINE'],
      ['measurementMethod', 'manual_scale', 'MANUAL_SCALE'],
    ])('rejects the lowercase value the web used to send for %s', (field, wrong, right) => {
      const { errors } = coerce(schema, RECORD, webVariables({ [field]: wrong }));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`"${wrong}"`);
      expect(errors[0]).toContain(right); // the schema names what it would accept
    });
  });

  describe('the global validation pipe (the whitelist)', () => {
    async function recordInput(
      overrides: Record<string, unknown> = {},
    ): Promise<RecordGrowthSampleInput> {
      const { values, errors } = coerce(schema, RECORD, webVariables(overrides));
      expect(errors).toEqual([]);
      return bind(RecordGrowthSampleInput, values?.['input'] as Record<string, unknown>);
    }

    it('accepts the full payload the Sampling modal sends', async () => {
      const bound = await recordInput();

      expect(bound).toBeInstanceOf(RecordGrowthSampleInput);
      expect(bound.individualMeasurements).toHaveLength(3);
      expect(bound.measuredBy).toBe(USER_ID);
    });

    it('accepts the optional parts a richer form may add', async () => {
      const bound = await recordInput({
        conditions: {
          waterTemp: 11.5,
          dissolvedOxygen: 9.1,
          feedingStatus: 'fed',
          timeOfDay: '08:30',
          weatherConditions: 'overcast',
        },
        individualMeasurements: [
          { sampleNumber: 1, weight: 51.2, length: 17.4, width: 3.1, notes: 'clean' },
          { sampleNumber: 2, weight: 52.9 },
          { sampleNumber: 3, weight: 50.4 },
        ],
      });

      expect(bound.conditions?.feedingStatus).toBe('fed');
    });

    it('rejects a display NAME where the measurer is a user id (the third blocker)', async () => {
      await expect(recordInput({ measuredBy: 'Duygu Test' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      ['a non-uuid batch', { batchId: 'B-2026-00005' }],
      ['a non-uuid tank', { tankId: 'TNK-1' }],
      ['an empty sample list', { individualMeasurements: [] }],
      ['a zero weight', { individualMeasurements: [{ sampleNumber: 1, weight: 0 }] }],
      ['a negative weight', { individualMeasurements: [{ sampleNumber: 1, weight: -4 }] }],
      ['a zero sample number', { individualMeasurements: [{ sampleNumber: 0, weight: 5 }] }],
      ['a zero population', { populationSize: 0 }],
      ['a zero sample size', { sampleSize: 0 }],
      [
        'an unknown feeding status',
        { conditions: { feedingStatus: 'hungry', timeOfDay: '08:00' } },
      ],
      ['a malformed time of day', { conditions: { feedingStatus: 'fed', timeOfDay: '8am' } }],
      [
        'an out-of-range water temperature',
        { conditions: { waterTemp: 99, feedingStatus: 'fed', timeOfDay: '08:00' } },
      ],
    ])('rejects %s', async (_name, overrides) => {
      await expect(recordInput(overrides)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a key the schema does not know (forbidNonWhitelisted)', async () => {
      const { values } = coerce(schema, RECORD, webVariables());
      const input = { ...(values?.['input'] as Record<string, unknown>), surprise: 1 };

      await expect(bind(RecordGrowthSampleInput, input)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('growthMeasurements(filter:) (the read blocked the same way)', () => {
    async function filterInput(
      filter: Record<string, unknown>,
    ): Promise<GrowthMeasurementFilterInput> {
      const { values, errors } = coerce(schema, LIST, { filter });
      expect(errors).toEqual([]);
      return bind(GrowthMeasurementFilterInput, values?.['filter'] as Record<string, unknown>);
    }

    it('accepts an empty filter and every single property alone', async () => {
      await expect(filterInput({})).resolves.toBeInstanceOf(GrowthMeasurementFilterInput);
      for (const filter of [
        { batchId: BATCH_ID },
        { tankId: TANK_ID },
        { measurementType: 'ROUTINE' },
        { startDate: '2026-10-01T00:00:00.000Z' },
        { endDate: '2026-10-31T00:00:00.000Z' },
        { verifiedOnly: true },
        { performance: ['excellent', 'good'] },
        { measuredBy: USER_ID },
      ]) {
        await expect(filterInput(filter)).resolves.toBeInstanceOf(GrowthMeasurementFilterInput);
      }
    });

    it('binds dates as dates and the type as its value', async () => {
      const bound = await filterInput({
        measurementType: 'ROUTINE',
        startDate: '2026-10-01T00:00:00.000Z',
      });

      expect(bound.measurementType).toBe('routine');
      expect(bound.startDate).toBeInstanceOf(Date);
    });

    it.each([
      ['a non-uuid batch', { batchId: 'nope' }],
      ['a non-uuid tank', { tankId: 'nope' }],
      ['a non-uuid measurer', { measuredBy: 'Duygu Test' }],
      ['an unknown performance band', { performance: ['stellar'] }],
    ])('rejects %s', async (_name, filter) => {
      const { values } = coerce(schema, LIST, { filter });
      await expect(
        bind(GrowthMeasurementFilterInput, values?.['filter'] as Record<string, unknown>),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
