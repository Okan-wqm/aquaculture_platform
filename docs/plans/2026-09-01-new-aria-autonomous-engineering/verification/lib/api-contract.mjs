import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  astFromValue,
  buildASTSchema,
  buildSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  print,
  parse,
  visit,
} from 'graphql';
import { canonicalJson, parseStrictJson, sha256, sha256File } from './canonical.mjs';

const schemaPaths = [
  'authority/graphql/commands.graphql',
  'authority/graphql/read-model.graphql',
  'authority/graphql/root.graphql',
];
const policyPath = 'verification/api-policy.json';

function schemaSource(planRoot) {
  return schemaPaths.map((path) => readFileSync(join(planRoot, path), 'utf8')).join('\n');
}

function sprintNumber(sprintId) {
  if (!/^S(?:0[1-9]|[1-6][0-9]|7[0-2])$/u.test(sprintId)) {
    throw new Error(`Invalid API activation sprint: ${sprintId}`);
  }
  return Number(sprintId.slice(1));
}

function activeMutationNames(policy, sprintId) {
  const checkpoint = sprintNumber(sprintId);
  return policy.mutation_activations
    .filter((entry) => sprintNumber(entry.sprint) <= checkpoint)
    .map((entry) => entry.name);
}

function phaseSchema(planRoot, policy, sprintId) {
  const active = new Set(activeMutationNames(policy, sprintId));
  const document = visit(parse(schemaSource(planRoot)), {
    SchemaDefinition(node) {
      const operationTypes = node.operationTypes.filter(
        (operation) => operation.operation !== 'mutation' || active.size > 0,
      );
      return { ...node, operationTypes };
    },
    ObjectTypeDefinition(node) {
      if (node.name.value !== 'Mutation') return undefined;
      if (active.size === 0) return null;
      return { ...node, fields: node.fields?.filter((field) => active.has(field.name.value)) };
    },
  });
  return buildASTSchema(document);
}

function phaseContract(schema) {
  const queries = Object.keys(schema.getQueryType()?.getFields() ?? {});
  const mutations = Object.keys(schema.getMutationType()?.getFields() ?? {});
  return {
    query_root: schema.getQueryType()?.name ?? null,
    mutation_root: schema.getMutationType()?.name ?? null,
    query_count: queries.length,
    mutation_count: mutations.length,
    query_source: 'terminal.query_fields',
    mutation_fields: mutations,
  };
}

function byName(values) {
  return [...values].sort((left, right) => left.name.localeCompare(right.name));
}

function appliedDirectives(...nodes) {
  return nodes
    .flatMap((node) => node?.directives ?? [])
    .map((directive) => {
      const args = byName(directive.arguments ?? []).map(
        (argument) => `${argument.name.value}:${print(argument.value)}`,
      );
      return `@${directive.name.value}${args.length === 0 ? '' : `(${args.join(',')})`}`;
    });
}

function defaultValue(value, type) {
  if (value === undefined) return null;
  const ast = astFromValue(value, type);
  if (!ast) throw new Error(`GraphQL default cannot be represented for ${String(type)}`);
  return print(ast);
}

function inputValueShape(value) {
  return [
    String(value.type),
    defaultValue(value.defaultValue, value.type),
    appliedDirectives(value.astNode),
  ];
}

function fieldsShape(type) {
  return Object.fromEntries(
    byName(Object.values(type.getFields())).map((field) => [
      field.name,
      [
        String(field.type),
        Object.fromEntries(
          byName(field.args).map((argument) => [argument.name, inputValueShape(argument)]),
        ),
        appliedDirectives(field.astNode),
      ],
    ]),
  );
}

function typeShape(type) {
  const directives = appliedDirectives(type.astNode, ...(type.extensionASTNodes ?? []));
  if (isScalarType(type)) {
    return ['SCALAR', type.specifiedByURL ?? null, directives];
  }
  if (isEnumType(type)) {
    const values = byName(type.getValues()).map((value) => [
      value.name,
      appliedDirectives(value.astNode),
    ]);
    return ['ENUM', values, directives];
  }
  if (isUnionType(type)) {
    return ['UNION', byName(type.getTypes()).map((member) => member.name), directives];
  }
  if (isInputObjectType(type)) {
    const fields = Object.fromEntries(
      byName(Object.values(type.getFields())).map((field) => [field.name, inputValueShape(field)]),
    );
    return ['INPUT_OBJECT', fields, directives];
  }
  if (isObjectType(type) || isInterfaceType(type)) {
    const kind = isObjectType(type) ? 'OBJECT' : 'INTERFACE';
    return [
      kind,
      byName(type.getInterfaces()).map((face) => face.name),
      fieldsShape(type),
      directives,
    ];
  }
  throw new Error(`Unsupported public GraphQL type: ${type.name}`);
}

function directiveShape(directive) {
  return [
    directive.isRepeatable,
    [...directive.locations].sort(),
    Object.fromEntries(
      byName(directive.args).map((argument) => [argument.name, inputValueShape(argument)]),
    ),
  ];
}

export function buildSchemaClosure(schema) {
  const types = byName(
    Object.values(schema.getTypeMap()).filter((type) => !type.name.startsWith('__')),
  );
  return {
    roots: {
      query: schema.getQueryType()?.name ?? null,
      mutation: schema.getMutationType()?.name ?? null,
      subscription: schema.getSubscriptionType()?.name ?? null,
    },
    schema_directives: appliedDirectives(schema.astNode, ...(schema.extensionASTNodes ?? [])),
    directives: Object.fromEntries(
      byName(schema.getDirectives()).map((directive) => [
        directive.name,
        directiveShape(directive),
      ]),
    ),
    types: Object.fromEntries(types.map((type) => [type.name, typeShape(type)])),
  };
}

function inputValueSignature(value) {
  const shape = inputValueShape(value);
  const fallback = shape[1] === null ? '' : `=${shape[1]}`;
  return `${shape[0]}${fallback}${shape[2].join('')}`;
}

function fieldSignature(field) {
  const args = byName(field.args).map(
    (argument) => `${argument.name}:${inputValueSignature(argument)}`,
  );
  const call = args.length === 0 ? '' : `(${args.join(',')})`;
  return `${call}:${String(field.type)}${appliedDirectives(field.astNode).join('')}`;
}

function rootFields(type) {
  if (!type) throw new Error('GraphQL root type missing');
  return Object.fromEntries(
    Object.values(type.getFields()).map((field) => [field.name, fieldSignature(field)]),
  );
}

export function buildApiContract(planRoot) {
  const schema = buildSchema(schemaSource(planRoot));
  const policy = parseStrictJson(readFileSync(join(planRoot, policyPath), 'utf8'));
  const closure = buildSchemaClosure(schema);
  return {
    schema_version: '1.0.0',
    generated: {
      marker: 'GENERATED; DO NOT EDIT',
      generator: 'verification/render-api-contract.mjs',
      generator_version: '1.0.0',
      inputs: [...schemaPaths, policyPath].map((path) => ({
        path,
        sha256: sha256File(join(planRoot, path)),
      })),
    },
    query_fields: rootFields(schema.getQueryType()),
    mutation_fields: rootFields(schema.getMutationType()),
    schema_closure: {
      algorithm: 'graphql-public-closure-v1',
      sha256: sha256(Buffer.from(canonicalJson(closure), 'utf8')),
    },
    lifecycle_mapping: policy.lifecycle_mapping,
    phase_contracts: Object.fromEntries(
      policy.phase_checkpoints.map((sprintId) => [
        sprintId,
        phaseContract(phaseSchema(planRoot, policy, sprintId)),
      ]),
    ),
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
