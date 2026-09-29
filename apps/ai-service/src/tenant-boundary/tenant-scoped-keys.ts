/**
 * Field names that would let a caller choose a tenant or a schema
 * (K10 / MT-HIGH-062). SSoT for two checks:
 *   - tests/invariants/ai-tenant-boundary.spec.ts walks every registered tool's
 *     input schema and fails when a property matches (the model is never
 *     offered such a parameter);
 *   - ToolExecutorService refuses a tool call whose input carries one anyway
 *     (a prompt-injected or hallucinated `tenantId`), and
 *     TenantBoundNatsClient refuses request fields that carry one.
 *
 * WHY normalised SUBSTRING matching (V-T1a-9): `tenantId`, `tenant_id`,
 * `x-tenant-id`, `tenantUuid`, `targetTenantId` and `searchPath` are the same
 * smuggling attempt spelled differently. An exact-name list lets every new
 * spelling through; a fragment match refuses them all, and a legitimate field
 * that happens to contain a fragment must be reviewed into the allowlist.
 */
const FORBIDDEN_FRAGMENTS: readonly string[] = ['tenant', 'schema', 'searchpath'];

/**
 * Normalised names that contain a forbidden fragment but select nothing,
 * each with the reviewed reason. Empty today: no tool offers such a field.
 */
export const TENANT_KEY_ALLOWLIST: Readonly<Record<string, string>> = {};

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/** True when `name` names a tenant or schema selector in any spelling. */
export function isTenantScopedKey(name: string): boolean {
  const normalised = normalise(name);
  if (normalised in TENANT_KEY_ALLOWLIST) return false;
  return FORBIDDEN_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/** Spellings a property-name pattern must not admit (probed against regex keywords). */
const TENANT_NAME_PROBES: readonly string[] = [
  'tenantId',
  'tenant_id',
  'tenant',
  'x-tenant-id',
  'schema',
  'search_path',
];

/** True when a JSON Schema `pattern` would accept a tenant/schema selector name. */
function patternAdmitsTenantKey(pattern: string): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'u');
  } catch {
    // An unparseable pattern cannot be proven tenant-free: treat it as admitting one.
    return true;
  }
  return TENANT_NAME_PROBES.some((probe) => regex.test(probe));
}

/**
 * Every object key (at any depth, arrays included) that names a tenant or
 * schema selector, as dotted paths. Empty means the value is tenant-free.
 */
export function findTenantScopedKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findTenantScopedKeys(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key;
    return [
      ...(isTenantScopedKey(key) ? [childPath] : []),
      ...findTenantScopedKeys(child, childPath),
    ];
  });
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every parameter a JSON Schema offers — at any depth, through `properties`,
 * `required`, `items`/`prefixItems`/`contains`, `additionalProperties`,
 * `unevaluatedProperties`, `patternProperties`, `propertyNames`,
 * `anyOf`/`oneOf`/`allOf`/`not`, `if`/`then`/`else`, `dependentSchemas`,
 * `dependencies`, and `$defs`/`definitions` (the targets of local `$ref`s) —
 * whose name selects a tenant or schema, plus every `$ref` the walk cannot
 * follow. Empty means the model is never offered a way to name a tenant.
 *
 * WHY a schema-aware walk instead of findTenantScopedKeys: JSON Schema
 * keywords (`$schema`, `description`) are not parameters, and parameter names
 * live under `properties`, one level below the keyword.
 *
 * WHY a non-local `$ref` is a hit (V-T1a-9): the walk cannot see the schema it
 * points at, so it cannot prove that schema offers no tenant parameter.
 */
export function findTenantScopedParameters(schema: unknown, path = ''): string[] {
  if (!isSchemaObject(schema)) return [];
  const hits = new Set<string>();
  const at = (name: string): string => (path ? `${path}.${name}` : name);
  const walk = (child: unknown, childPath: string): void => {
    findTenantScopedParameters(child, childPath).forEach((hit) => hits.add(hit));
  };

  const properties = schema['properties'];
  if (isSchemaObject(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (isTenantScopedKey(name)) hits.add(at(name));
      walk(child, at(name));
    }
  }
  const required = schema['required'];
  if (Array.isArray(required)) {
    required
      .filter((name): name is string => typeof name === 'string' && isTenantScopedKey(name))
      .forEach((name) => hits.add(at(name)));
  }
  for (const keyword of [
    'items',
    'additionalProperties',
    'unevaluatedProperties',
    'not',
    'contains',
    'if',
    'then',
    'else',
  ]) {
    walk(schema[keyword], at(`<${keyword}>`));
  }
  const patternProperties = schema['patternProperties'];
  if (isSchemaObject(patternProperties)) {
    for (const [pattern, child] of Object.entries(patternProperties)) {
      if (patternAdmitsTenantKey(pattern)) hits.add(at(`<patternProperties:${pattern}>`));
      walk(child, at('<patternProperties>'));
    }
  }
  const propertyNames = schema['propertyNames'];
  if (isSchemaObject(propertyNames)) {
    const enumerated: unknown[] = Array.isArray(propertyNames['enum']) ? propertyNames['enum'] : [];
    const named: unknown[] = [propertyNames['const'], ...enumerated];
    named
      .filter((name): name is string => typeof name === 'string' && isTenantScopedKey(name))
      .forEach((name) => hits.add(at(`<propertyNames:${name}>`)));
    const pattern = propertyNames['pattern'];
    if (typeof pattern === 'string' && patternAdmitsTenantKey(pattern)) {
      hits.add(at(`<propertyNames:${pattern}>`));
    }
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) => walk(branch, at(`<${keyword}[${index}]>`)));
    }
  }
  for (const keyword of ['$defs', 'definitions', 'dependentSchemas', 'dependencies']) {
    const map = schema[keyword];
    if (isSchemaObject(map)) {
      Object.entries(map).forEach(([name, child]) => walk(child, at(`<${keyword}.${name}>`)));
    }
  }
  const ref = schema['$ref'];
  if (typeof ref === 'string' && !/^#\/(?:\$defs|definitions)\/[^/]+$/.test(ref)) {
    hits.add(at(`<unverifiable $ref ${ref}>`));
  }
  return [...hits];
}
