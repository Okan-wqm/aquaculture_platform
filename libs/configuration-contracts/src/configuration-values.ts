import type { ConfigurationCatalogDefinitionV1 } from './generated/configuration-catalog.generated';

export class ConfigurationValueError extends Error {
  constructor(
    readonly catalogId: string,
    message: string,
  ) {
    super(`${catalogId}: ${message}`);
    this.name = 'ConfigurationValueError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 8785-compatible serialization for the JSON value subset accepted by the catalog. */
export function canonicalConfigurationJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite JSON number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalConfigurationJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalConfigurationJson(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported JSON value type: ${typeof value}`);
}

function numberRule(rules: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = rules[key];
  return typeof value === 'number' ? value : undefined;
}

function validateValue(definition: ConfigurationCatalogDefinitionV1, value: unknown): void {
  const rules = definition.validation ?? {};
  if (typeof value === 'number') {
    if (rules['integer'] === true && !Number.isSafeInteger(value)) {
      throw new ConfigurationValueError(definition.id, 'value must be a safe integer');
    }
    const min = numberRule(rules, 'min');
    const max = numberRule(rules, 'max');
    if (min !== undefined && value < min) {
      throw new ConfigurationValueError(definition.id, `value must be at least ${min}`);
    }
    if (max !== undefined && value > max) {
      throw new ConfigurationValueError(definition.id, `value must be at most ${max}`);
    }
  }
  if (typeof value === 'string') {
    const minLength = numberRule(rules, 'minLength');
    const maxLength = numberRule(rules, 'maxLength');
    if (minLength !== undefined && value.length < minLength) {
      throw new ConfigurationValueError(
        definition.id,
        `value must have at least ${minLength} characters`,
      );
    }
    if (maxLength !== undefined && value.length > maxLength) {
      throw new ConfigurationValueError(
        definition.id,
        `value must have at most ${maxLength} characters`,
      );
    }
    const pattern = rules['pattern'];
    if (typeof pattern === 'string' && !new RegExp(pattern, 'u').test(value)) {
      throw new ConfigurationValueError(definition.id, 'value does not match the catalog pattern');
    }
  }
  const choices = rules['choices'];
  if (Array.isArray(choices) && !choices.some((choice) => Object.is(choice, value))) {
    throw new ConfigurationValueError(definition.id, 'value is not a catalog choice');
  }
  if (rules['arrayItemType'] === 'STRING') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new ConfigurationValueError(definition.id, 'value must be an array of strings');
    }
    const maxItems = numberRule(rules, 'maxItems');
    if (maxItems !== undefined && value.length > maxItems) {
      throw new ConfigurationValueError(definition.id, `array must have at most ${maxItems} items`);
    }
  }
}

/** Parse an operator input and return the one canonical string persisted by config-service. */
export function canonicalConfigurationInput(
  definition: ConfigurationCatalogDefinitionV1,
  input: string,
): string {
  let value: unknown;
  switch (definition.valueType) {
    case 'STRING':
    case 'SECRET':
      value = input;
      break;
    case 'BOOLEAN':
      if (input !== 'true' && input !== 'false') {
        throw new ConfigurationValueError(definition.id, 'boolean input must be true or false');
      }
      value = input === 'true';
      break;
    case 'NUMBER': {
      if (input.trim() === '') {
        throw new ConfigurationValueError(definition.id, 'number input cannot be empty');
      }
      const parsed = Number(input);
      if (!Number.isFinite(parsed)) {
        throw new ConfigurationValueError(definition.id, 'number input must be finite');
      }
      value = parsed;
      break;
    }
    case 'JSON':
      try {
        value = JSON.parse(input);
      } catch {
        throw new ConfigurationValueError(definition.id, 'input must be valid JSON');
      }
      break;
  }
  validateValue(definition, value);
  if (definition.valueType === 'STRING' || definition.valueType === 'SECRET') return input;
  return canonicalConfigurationJson(value);
}

/** Convert a canonical persisted string into the typed non-secret API value. */
export function parseCanonicalConfigurationValue(
  definition: ConfigurationCatalogDefinitionV1,
  stored: string,
): unknown {
  if (definition.valueType === 'SECRET') {
    throw new ConfigurationValueError(
      definition.id,
      'secret values cannot be projected as plaintext',
    );
  }
  if (definition.valueType === 'STRING') {
    validateValue(definition, stored);
    return stored;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new ConfigurationValueError(definition.id, 'stored value is not canonical JSON');
  }
  validateValue(definition, parsed);
  if (canonicalConfigurationJson(parsed) !== stored) {
    throw new ConfigurationValueError(definition.id, 'stored value is not canonical');
  }
  return parsed;
}
