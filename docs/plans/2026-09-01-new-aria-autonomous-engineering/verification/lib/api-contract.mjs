import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema } from 'graphql';
import { sha256File } from './canonical.mjs';

const schemaPaths = [
  'authority/graphql/commands.graphql',
  'authority/graphql/read-model.graphql',
  'authority/graphql/root.graphql',
];

function schemaSource(planRoot) {
  return schemaPaths.map((path) => readFileSync(join(planRoot, path), 'utf8')).join('\n');
}

function rootFields(type) {
  if (!type) throw new Error('GraphQL root type missing');
  return Object.fromEntries(
    Object.entries(type.getFields()).map(([name, field]) => [
      name,
      {
        type: String(field.type),
        arguments: Object.fromEntries(
          field.args.map((argument) => [argument.name, String(argument.type)]),
        ),
      },
    ]),
  );
}

function inputFields(schema) {
  const inputs = Object.values(schema.getTypeMap())
    .filter((type) => type.astNode && type.astNode.kind === 'InputObjectTypeDefinition')
    .sort((left, right) => left.name.localeCompare(right.name));
  return Object.fromEntries(
    inputs.map((type) => [
      type.name,
      Object.fromEntries(
        Object.entries(type.getFields()).map(([name, field]) => [name, String(field.type)]),
      ),
    ]),
  );
}

function enumValues(schema) {
  return Object.fromEntries(
    ['AriaSectionStatus', 'AriaFreshness'].map((name) => [
      name,
      schema
        .getType(name)
        .getValues()
        .map((value) => value.name),
    ]),
  );
}

export function buildApiContract(planRoot) {
  const schema = buildSchema(schemaSource(planRoot));
  return {
    schema_version: '1.0.0',
    generated: {
      marker: 'GENERATED; DO NOT EDIT',
      generator: 'verification/render-api-contract.mjs',
      generator_version: '1.0.0',
      inputs: schemaPaths.map((path) => ({ path, sha256: sha256File(join(planRoot, path)) })),
    },
    query_fields: rootFields(schema.getQueryType()),
    mutation_fields: rootFields(schema.getMutationType()),
    input_types: inputFields(schema),
    enums: enumValues(schema),
  };
}

export function loadApiSchema(planRoot) {
  return buildSchema(schemaSource(planRoot));
}

export function replayDecision(stored, incomingPayloadDigest) {
  if (!stored) return { action: 'DISPATCH_ONCE' };
  if (stored.payloadDigest === incomingPayloadDigest) {
    return { action: 'RETURN_STORED', result: stored.result };
  }
  return { action: 'INVALID_PAYLOAD_REUSE' };
}
