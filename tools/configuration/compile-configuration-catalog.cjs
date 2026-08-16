#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const yaml = require('js-yaml');

const root = resolve(__dirname, '../..');
const checkOnly = process.argv.includes('--check');

const inputs = {
  catalog: 'infrastructure/configuration/catalog.yaml',
  catalogSchema: 'infrastructure/configuration/catalog.schema.json',
  registrations: 'infrastructure/configuration/consumer-registrations.yaml',
  registrationsSchema: 'infrastructure/configuration/consumer-registrations.schema.json',
};

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function parseYaml(relativePath) {
  const document = yaml.load(read(relativePath), {
    schema: yaml.JSON_SCHEMA,
    json: false,
  });
  if (!isRecord(document)) {
    fail(`${relativePath}: expected one YAML object document`);
  }
  return document;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`configuration catalog: ${message}`);
}

function assertSchema(document, schemaPath, label) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schema = JSON.parse(read(schemaPath));
  const validate = ajv.compile(schema);
  if (!validate(document)) {
    fail(
      `${label} schema validation failed:\n${(validate.errors ?? [])
        .map((error) => `  ${error.instancePath || '/'} ${error.message}`)
        .join('\n')}`,
    );
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JCS cannot encode a non-finite number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  fail(`JCS cannot encode ${typeof value}`);
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function uniqueMap(values, keyOf, label) {
  const result = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) fail(`duplicate ${label}: ${key}`);
    result.set(key, value);
  }
  return result;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateValue(definition, value, source) {
  const type = definition.valueType;
  if (type === 'STRING' || type === 'SECRET') {
    if (typeof value !== 'string') fail(`${source}: ${type} value must be a string`);
  } else if (type === 'NUMBER') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`${source}: NUMBER value must be finite`);
    }
  } else if (type === 'BOOLEAN') {
    if (typeof value !== 'boolean') fail(`${source}: BOOLEAN value must be boolean`);
  } else if (type === 'JSON') {
    canonicalJson(value);
  }

  const rules = definition.validation ?? {};
  if (typeof value === 'number') {
    if (rules.integer === true && !Number.isSafeInteger(value)) fail(`${source}: must be integer`);
    if (rules.min !== undefined && value < rules.min) fail(`${source}: below minimum`);
    if (rules.max !== undefined && value > rules.max) fail(`${source}: above maximum`);
  }
  if (typeof value === 'string') {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      fail(`${source}: shorter than minLength`);
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      fail(`${source}: longer than maxLength`);
    }
    if (rules.pattern !== undefined && !new RegExp(rules.pattern, 'u').test(value)) {
      fail(`${source}: does not match pattern`);
    }
  }
  if (rules.choices !== undefined && !rules.choices.some((choice) => Object.is(choice, value))) {
    fail(`${source}: not in choices`);
  }
  if (rules.arrayItemType !== undefined) {
    if (!Array.isArray(value)) fail(`${source}: must be an array`);
    if (rules.arrayItemType === 'STRING' && value.some((item) => typeof item !== 'string')) {
      fail(`${source}: array items must be strings`);
    }
    if (rules.maxItems !== undefined && value.length > rules.maxItems) {
      fail(`${source}: has too many items`);
    }
  }
}

function assertSemanticCatalog(catalog, registrations) {
  const settings = catalog.settings;
  const consumers = registrations.consumers;
  const byId = uniqueMap(settings, (setting) => setting.id, 'setting id');
  uniqueMap(settings, (setting) => `${setting.service}/${setting.key}`, 'setting coordinate');
  const consumersById = uniqueMap(consumers, (consumer) => consumer.id, 'consumer id');
  uniqueMap(
    consumers.filter((consumer) => consumer.transport !== 'GRAPHQL_OPERATOR'),
    (consumer) => consumer.replyInboxPrefix,
    'runtime reply inbox prefix',
  );

  for (const setting of settings) {
    const source = `${setting.id} (${setting.service}/${setting.key})`;
    if (setting.valueType === 'SECRET' && hasOwn(setting, 'default')) {
      fail(`${source}: SECRET settings cannot carry defaults`);
    }
    if (setting.required && !hasOwn(setting, 'default')) {
      fail(`${source}: required setting needs an authoritative default`);
    }
    if (hasOwn(setting, 'default')) validateValue(setting, setting.default, `${source} default`);
    if (setting.valueType === 'BOOLEAN' && setting.ui.control !== 'TOGGLE') {
      fail(`${source}: BOOLEAN UI control must be TOGGLE`);
    }
    if (setting.valueType === 'NUMBER' && setting.ui.control !== 'NUMBER') {
      fail(`${source}: NUMBER UI control must be NUMBER`);
    }
    if (setting.valueType === 'SECRET' && setting.ui.control !== 'SECRET') {
      fail(`${source}: SECRET UI control must be SECRET`);
    }
    if (setting.valueType === 'JSON' && setting.ui.control !== 'JSON') {
      fail(`${source}: JSON UI control must be JSON`);
    }
    uniqueMap(
      setting.consumers.map((consumerId) => ({ consumerId })),
      (entry) => entry.consumerId,
      `${source} consumer registration`,
    );
    for (const consumerId of setting.consumers) {
      if (!consumersById.has(consumerId)) fail(`${source}: unknown consumer ${consumerId}`);
    }
  }

  const registeredBySetting = new Map(settings.map((setting) => [setting.id, new Set()]));
  for (const consumer of consumers) {
    const seen = new Set();
    for (const registration of consumer.keys) {
      if (seen.has(registration.id)) fail(`${consumer.id}: duplicate key ${registration.id}`);
      seen.add(registration.id);
      const setting = byId.get(registration.id);
      if (!setting) fail(`${consumer.id}: unknown setting ${registration.id}`);
      registeredBySetting.get(registration.id).add(consumer.id);
      if (registration.access === 'RUNTIME_SECRET_READ' && setting.valueType !== 'SECRET') {
        fail(`${consumer.id}/${registration.id}: secret read requires SECRET setting`);
      }
      if (registration.access === 'RUNTIME_READ' && setting.valueType === 'SECRET') {
        fail(`${consumer.id}/${registration.id}: SECRET setting cannot use non-secret read`);
      }
      if (
        consumer.transport === 'GRAPHQL_OPERATOR' &&
        registration.access !== 'OPERATOR_READ_WRITE'
      ) {
        fail(`${consumer.id}/${registration.id}: GraphQL operator access is inconsistent`);
      }
      if (
        consumer.transport !== 'GRAPHQL_OPERATOR' &&
        registration.access === 'OPERATOR_READ_WRITE'
      ) {
        fail(`${consumer.id}/${registration.id}: runtime consumer cannot receive operator access`);
      }
    }
  }

  for (const setting of settings) {
    const declared = [...setting.consumers].sort();
    const registered = [...registeredBySetting.get(setting.id)].sort();
    if (canonicalJson(declared) !== canonicalJson(registered)) {
      fail(
        `${setting.id}: catalog consumers ${declared.join(',')} do not equal registrations ${registered.join(',')}`,
      );
    }
  }
}

function stablePayload(catalog, registrations) {
  return {
    schemaVersion: 1,
    settings: [...catalog.settings]
      .map((setting) => ({
        ...setting,
        consumers: [...setting.consumers].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    consumers: [...registrations.consumers]
      .map((consumer) => ({
        ...consumer,
        keys: [...consumer.keys].sort((left, right) => left.id.localeCompare(right.id)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function tsLiteral(value) {
  return JSON.stringify(value, null, 2);
}

function serializedDefault(setting) {
  if (!hasOwn(setting, 'default')) return null;
  if (setting.valueType === 'JSON') return canonicalJson(setting.default);
  return String(setting.default);
}

function generatedHeader(catalogDigest) {
  return `/* AUTO-GENERATED by tools/configuration/compile-configuration-catalog.cjs.\n * Catalog digest: ${catalogDigest}\n * Do not edit this projection; edit infrastructure/configuration/catalog.yaml.\n */\n`;
}

function renderContracts(payload, catalogDigest) {
  const settings = payload.settings;
  const consumers = payload.consumers;
  const enumMembers = settings.map((setting) => `  ${setting.id}: '${setting.id}',`).join('\n');
  const consumerEnumMembers = consumers
    .map((consumer) => `  ${consumer.id}: '${consumer.id}',`)
    .join('\n');
  const definitionMap = settings
    .map(
      (setting) =>
        `  [ConfigurationKeyId.${setting.id}]: CONFIGURATION_DEFINITIONS[${settings.indexOf(setting)}]!,`,
    )
    .join('\n');
  const coordinateMap = settings
    .map((setting) => `  '${setting.service}/${setting.key}': ConfigurationKeyId.${setting.id},`)
    .join('\n');
  const runtimeConsumers = consumers
    .filter((consumer) => consumer.transport === 'NATS_RUNTIME')
    .map((consumer) => ({
      id: consumer.id,
      application: consumer.application,
      replyInboxPrefix: consumer.replyInboxPrefix,
      nonSecretKeys: consumer.keys
        .filter((registration) => registration.access === 'RUNTIME_READ')
        .map((registration) => registration.id),
      secretKeys: consumer.keys
        .filter((registration) => registration.access === 'RUNTIME_SECRET_READ')
        .map((registration) => registration.id),
    }));
  return `${generatedHeader(catalogDigest)}
export const CONFIGURATION_CATALOG_SCHEMA_VERSION = 1 as const;
export const CONFIGURATION_CATALOG_DIGEST = '${catalogDigest}' as const;

export const ConfigurationKeyId = {
${enumMembers}
} as const;
export type ConfigurationKeyId = (typeof ConfigurationKeyId)[keyof typeof ConfigurationKeyId];

export const ConfigurationConsumerId = {
${consumerEnumMembers}
} as const;
export type ConfigurationConsumerId =
  (typeof ConfigurationConsumerId)[keyof typeof ConfigurationConsumerId];

export const ConfigurationSnapshotStateV1 = {
  VALUE: 'VALUE',
  SECRET_SET: 'SECRET_SET',
  OPTIONAL_ABSENT: 'OPTIONAL_ABSENT',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  INVALID: 'INVALID',
  CATALOG_MISMATCH: 'CATALOG_MISMATCH',
} as const;
export type ConfigurationSnapshotStateV1 =
  (typeof ConfigurationSnapshotStateV1)[keyof typeof ConfigurationSnapshotStateV1];

export const ConfigurationSnapshotSourceV1 = {
  SYSTEM: 'SYSTEM',
  TENANT: 'TENANT',
  NONE: 'NONE',
} as const;
export type ConfigurationSnapshotSourceV1 =
  (typeof ConfigurationSnapshotSourceV1)[keyof typeof ConfigurationSnapshotSourceV1];

export const ConfigurationChangeIntentV1 = {
  SET: 'SET',
  CLEAR_OVERRIDE: 'CLEAR_OVERRIDE',
  SUPPRESS_FALLBACK: 'SUPPRESS_FALLBACK',
} as const;
export type ConfigurationChangeIntentV1 =
  (typeof ConfigurationChangeIntentV1)[keyof typeof ConfigurationChangeIntentV1];

export const ConfigurationStoredStateV1 = {
  ABSENT: 'ABSENT',
  ACTIVE_VALUE: 'ACTIVE_VALUE',
  ACTIVE_SECRET: 'ACTIVE_SECRET',
  INACTIVE_OVERRIDE: 'INACTIVE_OVERRIDE',
  FALLBACK_SUPPRESSED: 'FALLBACK_SUPPRESSED',
} as const;
export type ConfigurationStoredStateV1 =
  (typeof ConfigurationStoredStateV1)[keyof typeof ConfigurationStoredStateV1];

export type ConfigurationValueType = 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON' | 'SECRET';
export type ConfigurationScopePolicy =
  | 'SYSTEM_ONLY'
  | 'SYSTEM_WITH_TENANT_OVERRIDE'
  | 'TENANT_WITH_SYSTEM_FALLBACK';
export type ConfigurationUiControl = 'TEXT' | 'NUMBER' | 'TOGGLE' | 'SECRET' | 'SELECT' | 'JSON';

export interface ConfigurationCatalogDefinitionV1 {
  readonly id: ConfigurationKeyId;
  readonly service: string;
  readonly key: string;
  readonly category: string;
  readonly valueType: ConfigurationValueType;
  readonly scopePolicy: ConfigurationScopePolicy;
  readonly required: boolean;
  readonly mutable: boolean;
  readonly requiresRestart: boolean;
  readonly description: string;
  readonly default?: unknown;
  readonly validation?: Readonly<Record<string, unknown>>;
  readonly consumers: readonly ConfigurationConsumerId[];
  readonly ui: Readonly<{ label: string; order: number; control: ConfigurationUiControl }>;
}

export interface ConfigurationRuntimeConsumerV1 {
  readonly id: ConfigurationConsumerId;
  readonly application: string;
  readonly replyInboxPrefix: string;
  readonly nonSecretKeys: readonly ConfigurationKeyId[];
  readonly secretKeys: readonly ConfigurationKeyId[];
}

export const CONFIGURATION_DEFINITIONS: readonly ConfigurationCatalogDefinitionV1[] = ${tsLiteral(settings)};

export const CONFIGURATION_DEFINITION_BY_ID: Readonly<Record<ConfigurationKeyId, ConfigurationCatalogDefinitionV1>> = {
${definitionMap}
};

export const CONFIGURATION_KEY_ID_BY_COORDINATE: Readonly<Record<string, ConfigurationKeyId>> = {
${coordinateMap}
};

export const CONFIGURATION_RUNTIME_CONSUMERS: readonly ConfigurationRuntimeConsumerV1[] = ${tsLiteral(runtimeConsumers)};

export function configurationDefinition(id: ConfigurationKeyId): ConfigurationCatalogDefinitionV1 {
  return CONFIGURATION_DEFINITION_BY_ID[id];
}

export function isConfigurationKeyId(value: string): value is ConfigurationKeyId {
  return Object.prototype.hasOwnProperty.call(ConfigurationKeyId, value);
}

export function isConfigurationChangeIntentV1(value: string): value is ConfigurationChangeIntentV1 {
  return Object.prototype.hasOwnProperty.call(ConfigurationChangeIntentV1, value);
}

export function configurationKeyIdForCoordinate(service: string, key: string): ConfigurationKeyId | null {
  return CONFIGURATION_KEY_ID_BY_COORDINATE[\`${'${service}'}/${'${key}'}\`] ?? null;
}
`;
}

function renderRuntime(payload, catalogDigest) {
  const rows = payload.settings.map((setting) => ({
    id: setting.id,
    service: setting.service,
    key: setting.key,
    valueType: setting.valueType,
    scopePolicy: setting.scopePolicy,
    required: setting.required,
    mutable: setting.mutable,
    requiresRestart: setting.requiresRestart,
    validation: setting.validation ?? {},
  }));
  const map = rows
    .map(
      (row, index) =>
        `  [ConfigurationKeyId.${row.id}]: CONFIGURATION_RUNTIME_DEFINITIONS[${index}]!,`,
    )
    .join('\n');
  return `${generatedHeader(catalogDigest)}
import {
  ConfigurationKeyId,
  type ConfigurationCatalogDefinitionV1,
} from '@aquaculture/configuration-contracts';

export const CONFIGURATION_RUNTIME_DEFINITIONS = ${tsLiteral(rows)} as const satisfies readonly Pick<
  ConfigurationCatalogDefinitionV1,
  'id' | 'service' | 'key' | 'valueType' | 'scopePolicy' | 'required' | 'mutable' | 'requiresRestart' | 'validation'
>[];

export const CONFIGURATION_RUNTIME_DEFINITION_BY_ID: Readonly<
  Record<ConfigurationKeyId, (typeof CONFIGURATION_RUNTIME_DEFINITIONS)[number]>
> = {
${map}
};
`;
}

function renderGraphql(catalogDigest) {
  return `${generatedHeader(catalogDigest)}
import {
  ConfigurationChangeIntentV1,
  ConfigurationKeyId,
  ConfigurationSnapshotSourceV1,
  ConfigurationSnapshotStateV1,
} from '@aquaculture/configuration-contracts';
import { registerEnumType } from '@nestjs/graphql';

registerEnumType(ConfigurationKeyId, { name: 'ConfigurationKeyIdV1' });
registerEnumType(ConfigurationSnapshotStateV1, { name: 'ConfigurationSnapshotStateV1' });
registerEnumType(ConfigurationSnapshotSourceV1, { name: 'ConfigurationSnapshotSourceV1' });
registerEnumType(ConfigurationChangeIntentV1, { name: 'ConfigurationChangeIntentV1' });

export {
  ConfigurationChangeIntentV1,
  ConfigurationKeyId,
  ConfigurationSnapshotSourceV1,
  ConfigurationSnapshotStateV1,
};
`;
}

function renderUi(payload, catalogDigest) {
  const admin = payload.consumers.find((consumer) => consumer.id === 'ADMIN_PANEL_CONFIGURATION');
  if (!admin) fail('ADMIN_PANEL_CONFIGURATION registration is required');
  const ids = new Set(admin.keys.map((registration) => registration.id));
  const descriptors = payload.settings
    .filter((setting) => ids.has(setting.id))
    .map((setting) => ({
      id: setting.id,
      category: setting.category,
      label: setting.ui.label,
      order: setting.ui.order,
      control: setting.ui.control,
      valueType: setting.valueType,
      mutable: setting.mutable,
      required: setting.required,
      requiresRestart: setting.requiresRestart,
      description: setting.description,
      validation: setting.validation ?? {},
    }));
  return `${generatedHeader(catalogDigest)}
import {
  ConfigurationKeyId,
  type ConfigurationUiControl,
  type ConfigurationValueType,
} from '@aquaculture/configuration-contracts';

export interface ConfigurationUiDescriptorV1 {
  readonly id: ConfigurationKeyId;
  readonly category: string;
  readonly label: string;
  readonly order: number;
  readonly control: ConfigurationUiControl;
  readonly valueType: ConfigurationValueType;
  readonly mutable: boolean;
  readonly required: boolean;
  readonly requiresRestart: boolean;
  readonly description: string;
  readonly validation: Readonly<Record<string, unknown>>;
}

export const ADMIN_CONFIGURATION_UI: readonly ConfigurationUiDescriptorV1[] = ${tsLiteral(descriptors)};
`;
}

function renderSeeds(payload, catalogDigest) {
  const rows = payload.settings
    .filter((setting) => hasOwn(setting, 'default'))
    .map((setting) => ({
      catalogId: setting.id,
      service: setting.service,
      key: setting.key,
      value: serializedDefault(setting),
      valueType: setting.valueType.toLowerCase(),
      category: setting.category,
      description: setting.description,
      requiresRestart: setting.requiresRestart,
    }));
  return `${generatedHeader(catalogDigest)}
import { ConfigurationKeyId } from '@aquaculture/configuration-contracts';

export interface ConfigurationSeedRowV1 {
  readonly catalogId: ConfigurationKeyId;
  readonly service: string;
  readonly key: string;
  readonly value: string;
  readonly valueType: 'string' | 'number' | 'boolean' | 'json';
  readonly category: string;
  readonly description: string;
  readonly requiresRestart: boolean;
}

export const CONFIGURATION_SEED_ROWS = ${tsLiteral(rows)} as const satisfies readonly ConfigurationSeedRowV1[];
`;
}

function renderRuntimeAccess(payload, catalogDigest) {
  const runtime = payload.consumers.filter((consumer) => consumer.transport === 'NATS_RUNTIME');
  const accessByConsumer = {};
  for (const consumer of runtime) {
    accessByConsumer[consumer.application] = {
      replyInboxPrefix: consumer.replyInboxPrefix,
      nonSecretKeyIds: consumer.keys
        .filter((registration) => registration.access === 'RUNTIME_READ')
        .map((registration) => registration.id),
      secretKeyIds: consumer.keys
        .filter((registration) => registration.access === 'RUNTIME_SECRET_READ')
        .map((registration) => registration.id),
    };
  }
  return `${generatedHeader(catalogDigest)}
import type { ConfigurationKeyId } from '@aquaculture/configuration-contracts';

export interface ConfigRuntimeConsumerAccessV1 {
  readonly replyInboxPrefix: string;
  readonly nonSecretKeyIds: readonly ConfigurationKeyId[];
  readonly secretKeyIds: readonly ConfigurationKeyId[];
}

export const CONFIG_RUNTIME_ACCESS_BY_CONSUMER: Readonly<
  Record<string, ConfigRuntimeConsumerAccessV1>
> = ${tsLiteral(accessByConsumer)};
`;
}

function emit(relativePath, content) {
  const absolutePath = resolve(root, relativePath);
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  if (checkOnly) {
    let current;
    try {
      current = readFileSync(absolutePath, 'utf8');
    } catch {
      fail(`generated projection missing: ${relativePath}`);
    }
    if (current !== normalized) fail(`generated projection is stale: ${relativePath}`);
    return;
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, normalized, 'utf8');
}

const catalog = parseYaml(inputs.catalog);
const registrations = parseYaml(inputs.registrations);
assertSchema(catalog, inputs.catalogSchema, 'catalog');
assertSchema(registrations, inputs.registrationsSchema, 'consumer registrations');
assertSemanticCatalog(catalog, registrations);
const payload = stablePayload(catalog, registrations);
const catalogDigest = digest(payload);

emit(
  'infrastructure/configuration/generated/configuration-catalog.v1.json',
  `${canonicalJson({ schemaVersion: 1, catalogDigest, catalog: payload })}\n`,
);
emit(
  'libs/configuration-contracts/src/generated/configuration-catalog.generated.ts',
  renderContracts(payload, catalogDigest),
);
emit(
  'apps/config-service/src/configuration/generated/configuration-runtime.generated.ts',
  renderRuntime(payload, catalogDigest),
);
emit(
  'apps/config-service/src/configuration/generated/configuration-graphql.generated.ts',
  renderGraphql(catalogDigest),
);
emit(
  'web/modules/admin-panel/src/generated/configuration-ui.generated.ts',
  renderUi(payload, catalogDigest),
);
emit(
  'apps/config-service/src/database/generated/configuration-seed.generated.ts',
  renderSeeds(payload, catalogDigest),
);
emit(
  'libs/event-contracts/src/generated/configuration-runtime-access.generated.ts',
  renderRuntimeAccess(payload, catalogDigest),
);

process.stdout.write(
  `configuration catalog ${checkOnly ? 'verified' : 'generated'}: ${catalogDigest}\n`,
);
