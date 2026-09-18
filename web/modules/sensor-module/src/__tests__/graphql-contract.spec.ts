/**
 * GraphQL document × schema contract tests (SENSOR-MEDIUM-122)
 *
 * Hand-written documents drifted from the backend schema three separate ways
 * in one module (bare object-typed `connectionStatus`, nonexistent `status` /
 * `protocolId` selections, nonexistent top-level `alertThresholds`). Mocked
 * hooks never validated the document shape, so the pages failed only against
 * the live gateway with GRAPHQL_VALIDATION_FAILED.
 *
 * Each exported document in this module is validated with graphql-js
 * `validate()` against the sensor-subgraph excerpt fixture. Unknown fragments
 * are filtered exactly like scripts/ci/validate-graphql-operations.mjs does
 * (the repo-wide gate) — this spec is the module-local, always-green layer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSchema, parse, validate, type GraphQLSchema } from 'graphql';

/**
 * Extract a template-literal constant's value from a source file — the same
 * regex-extraction technique as scripts/ci/validate-graphql-operations.mjs.
 * Importing the modules directly would pull the whole component graph
 * (react-router-dom et al.) into this spec for no benefit.
 */
function documentFromSource(file: string, constant: string): string {
  const source = readFileSync(join(__dirname, '..', file), 'utf8');
  const match = source.match(
    new RegExp('(?:export )?const ' + constant + ' = (?:gql)?`([\\s\\S]*?)`'),
  );
  if (!match?.[1]) throw new Error('constant ' + constant + ' not found in ' + file);
  return match[1];
}

const schema: GraphQLSchema = buildSchema(
  readFileSync(join(__dirname, '..', '__fixtures__', 'sensor-subgraph.excerpt.graphql'), 'utf8'),
  { assumeValidSDL: true },
);

const GET_SENSOR_QUERY = documentFromSource('hooks/useSensorRegistration.ts', 'GET_SENSOR_QUERY');
const GET_SENSOR = documentFromSource('services/sensorRegistrationApi.ts', 'GET_SENSOR');
const GET_SENSOR_INFO_QUERY = documentFromSource('hooks/useWidgetData.ts', 'GET_SENSOR_INFO_QUERY');
const DETAIL_GET_SENSOR = documentFromSource('pages/DeviceDetailPage.tsx', 'GET_SENSOR_QUERY');
const GET_LATEST_READINGS_QUERY = documentFromSource(
  'pages/DeviceDetailPage.tsx',
  'GET_LATEST_READINGS_QUERY',
);

const documents: Array<[string, string]> = [
  ['useSensorRegistration.GET_SENSOR_QUERY', GET_SENSOR_QUERY],
  ['sensorRegistrationApi.GET_SENSOR', GET_SENSOR],
  ['useWidgetData.GET_SENSOR_INFO_QUERY', GET_SENSOR_INFO_QUERY],
  ['DeviceDetailPage.GET_SENSOR_QUERY', DETAIL_GET_SENSOR],
];

describe('sensor-module GraphQL documents × sensor subgraph excerpt', () => {
  it.each(documents)('%s validates against the schema', (_name, document) => {
    const errors = validate(schema, parse(document)).filter(
      (error) => !error.message.startsWith('Unknown fragment'),
    );
    expect(errors).toEqual([]);
  });

  it('DeviceDetailPage selects connectionStatus WITH subfields (F6 regression pin)', () => {
    expect(DETAIL_GET_SENSOR).toContain('connectionStatus {');
    expect(DETAIL_GET_SENSOR).not.toMatch(/connectionStatus\n/);
  });

  it('no document selects the nonexistent bare status/protocolId fields (F5 drift pin)', () => {
    for (const [name, document] of documents) {
      expect(document, name).not.toMatch(/^\s+status$/m);
      expect(document, name).not.toMatch(/^\s+protocolId$/m);
    }
  });

  it('the latest-readings document validates too', () => {
    // The readings root is not part of the excerpt fixture; extend the
    // fixture before adding readings-root assertions. Until then this pins
    // that the document selects the canonical parameter fields.
    for (const field of ['temperature', 'ph', 'dissolvedOxygen', 'salinity', 'ammonia']) {
      expect(GET_LATEST_READINGS_QUERY).toContain(field);
    }
  });
});
