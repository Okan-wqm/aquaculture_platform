import { hasOwn } from './json-contract';

const SOURCE_LOCAL_SUFFIX_PATTERN = '[A-Z0-9]+';
const SOURCE_LOCAL_NAMESPACE_PATTERN = '[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*';
const SCHEMA_SEMANTIC_FIELDS_KEY = 'x-source-finding-semantic-fields';
const CANONICAL_ID_PATTERN_SHAPE =
  /^\^\((?<namespaces>[^)]+)\)-\((?<classifiers>[^)]+)\)-\[0-9\]\{3\}\$$/;

interface FindingIdSchemaBranch {
  pattern?: unknown;
  const?: unknown;
}

interface FindingRegistrySchema {
  properties?: {
    id?: {
      oneOf?: FindingIdSchemaBranch[];
    };
    [property: string]: unknown;
  };
  [SCHEMA_SEMANTIC_FIELDS_KEY]?: unknown;
}

export interface FindingRegistrySchemaContract {
  canonicalIdPattern: string;
  canonicalIdRegex: RegExp;
  classifierPattern: string;
  grandfatheredIds: ReadonlySet<string>;
  rawIdRegex: RegExp;
  sourceLocalIdRegex: RegExp;
  semanticFields: readonly string[];
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((field): field is string => typeof field === 'string' && field.length > 0)
  );
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireUppercaseAlternation(value: string, field: string): string[] {
  const tokens = value.split('|');
  if (
    tokens.length === 0 ||
    !tokens.every((token) => /^[A-Z][A-Z0-9]*$/.test(token)) ||
    new Set(tokens).size !== tokens.length
  ) {
    throw new Error(`${field} must be a unique uppercase token alternation`);
  }
  return tokens;
}

export function parseFindingRegistrySchemaContract(
  rawSchema: unknown,
): FindingRegistrySchemaContract {
  if (typeof rawSchema !== 'object' || rawSchema === null || Array.isArray(rawSchema)) {
    throw new Error('finding registry schema must be an object');
  }
  const schema = rawSchema as FindingRegistrySchema;
  const idBranches = schema.properties?.id?.oneOf;
  if (!Array.isArray(idBranches)) {
    throw new Error('finding registry schema properties.id.oneOf must be an array');
  }

  const patternBranches = idBranches.filter(
    (branch): branch is FindingIdSchemaBranch & { pattern: string } =>
      typeof branch.pattern === 'string',
  );
  if (patternBranches.length !== 1) {
    throw new Error('finding registry schema must have exactly one canonical ID pattern');
  }
  const canonicalIdPattern = requireNonEmptyString(
    patternBranches[0]?.pattern,
    'finding registry canonical ID pattern',
  );
  const canonicalShape = CANONICAL_ID_PATTERN_SHAPE.exec(canonicalIdPattern);
  const namespacePattern = canonicalShape?.groups?.namespaces;
  const classifierPattern = canonicalShape?.groups?.classifiers;
  if (!namespacePattern || !classifierPattern) {
    throw new Error(
      'finding registry canonical ID pattern must retain PREFIX-CLASSIFIER-NNN structure',
    );
  }
  requireUppercaseAlternation(namespacePattern, 'finding registry namespaces');
  requireUppercaseAlternation(classifierPattern, 'finding registry classifiers');
  const canonicalIdRegex = new RegExp(canonicalIdPattern);
  const grandfatheredIds = new Set(
    idBranches
      .filter(
        (branch): branch is FindingIdSchemaBranch & { const: string } =>
          typeof branch.const === 'string',
      )
      .map((branch) => requireNonEmptyString(branch.const, 'finding registry grandfathered ID')),
  );
  if (grandfatheredIds.size !== idBranches.length - patternBranches.length) {
    throw new Error(
      'finding registry ID branches must be one pattern plus unique string constants',
    );
  }
  for (const grandfatheredId of grandfatheredIds) {
    if (
      !/^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-[0-9]{3}$/.test(grandfatheredId) ||
      canonicalIdRegex.test(grandfatheredId)
    ) {
      throw new Error(
        `finding registry grandfathered ID ${grandfatheredId} must be a noncanonical PREFIX-TAG-NNN literal`,
      );
    }
  }

  const semanticFields = schema[SCHEMA_SEMANTIC_FIELDS_KEY];
  if (!isNonEmptyStringArray(semanticFields)) {
    throw new Error(
      `finding registry schema ${SCHEMA_SEMANTIC_FIELDS_KEY} must be a non-empty string array`,
    );
  }
  if (new Set(semanticFields).size !== semanticFields.length) {
    throw new Error(
      `finding registry schema ${SCHEMA_SEMANTIC_FIELDS_KEY} must not contain duplicates`,
    );
  }
  for (const field of semanticFields) {
    if (!hasOwn(schema.properties ?? {}, field)) {
      throw new Error(`finding registry semantic field ${field} is absent from schema properties`);
    }
  }
  if (!semanticFields.includes('id')) {
    throw new Error('finding registry semantic fields must include id');
  }

  const sourceLocalPattern = `(?:(?<namespace>${SOURCE_LOCAL_NAMESPACE_PATTERN})-)?(?:${classifierPattern})-(?<sequence>[0-9]{3})`;
  const rawCanonicalAlternatives = [
    `(?:${SOURCE_LOCAL_NAMESPACE_PATTERN}-)?(?:${classifierPattern})-[0-9]{3}`,
    ...[...grandfatheredIds].sort().map(escapeRegex),
  ];
  const rawIdRegex = new RegExp(
    `(?<![A-Z0-9-])((?:${rawCanonicalAlternatives.join(
      '|',
    )})(?:-${SOURCE_LOCAL_SUFFIX_PATTERN})?)(?![A-Z0-9-])`,
    'g',
  );

  return {
    canonicalIdPattern,
    canonicalIdRegex,
    classifierPattern,
    grandfatheredIds,
    rawIdRegex,
    sourceLocalIdRegex: new RegExp(`^${sourceLocalPattern}$`),
    semanticFields: [...semanticFields],
  };
}

export function parseRawFindingId(
  rawId: string,
  contract: FindingRegistrySchemaContract,
): { namespace: string; sequence: number } | null {
  const candidates = [rawId];
  const suffixSeparator = rawId.lastIndexOf('-');
  if (suffixSeparator > 0) {
    candidates.push(rawId.slice(0, suffixSeparator));
  }

  for (const candidate of candidates) {
    const canonicalMatch = contract.canonicalIdRegex.exec(candidate);
    if (canonicalMatch) {
      const namespace = canonicalMatch[1];
      const sequence = Number.parseInt(candidate.slice(-3), 10);
      if (namespace && Number.isSafeInteger(sequence)) {
        return { namespace, sequence };
      }
    }
    const sourceLocalMatch = contract.sourceLocalIdRegex.exec(candidate);
    if (sourceLocalMatch?.groups?.sequence) {
      return {
        namespace: sourceLocalMatch.groups.namespace ?? 'UNSCOPED',
        sequence: Number.parseInt(sourceLocalMatch.groups.sequence, 10),
      };
    }
    if (contract.grandfatheredIds.has(candidate)) {
      const [namespace] = candidate.split('-');
      const sequence = Number.parseInt(candidate.slice(-3), 10);
      if (namespace && Number.isSafeInteger(sequence)) {
        return { namespace, sequence };
      }
    }
  }
  return null;
}

export function deriveRawFindingIdFloors(
  rawIds: readonly string[],
  contract: FindingRegistrySchemaContract,
): Record<string, number> {
  const floors = new Map<string, number>();
  for (const rawId of rawIds) {
    const parsed = parseRawFindingId(rawId, contract);
    if (!parsed) {
      throw new Error(`raw finding ID cannot be reserved: ${rawId}`);
    }
    floors.set(parsed.namespace, Math.max(floors.get(parsed.namespace) ?? 0, parsed.sequence));
  }
  return Object.fromEntries(
    [...floors].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}
