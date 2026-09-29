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
 * WHY normalised matching: `tenantId`, `tenant_id`, `TENANT-ID` and
 * `searchPath` are the same smuggling attempt spelled differently.
 */
const FORBIDDEN_NORMALISED_NAMES: ReadonlySet<string> = new Set([
  'tenant',
  'tenantid',
  'tenants',
  'tenantids',
  'tenantschema',
  'schema',
  'schemaname',
  'searchpath',
]);

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/** True when `name` names a tenant or schema selector in any spelling. */
export function isTenantScopedKey(name: string): boolean {
  return FORBIDDEN_NORMALISED_NAMES.has(normalise(name));
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
 * Every parameter a JSON Schema offers (at any depth: `properties`, `items`,
 * `additionalProperties`, `patternProperties`, `anyOf`/`oneOf`/`allOf`,
 * `required`) whose name selects a tenant or schema. Empty means the model is
 * never offered a way to name a tenant.
 *
 * WHY a schema-aware walk instead of findTenantScopedKeys: JSON Schema
 * keywords (`$schema`, `description`) are not parameters, and parameter names
 * live under `properties`, one level below the keyword.
 */
export function findTenantScopedParameters(schema: unknown, path = ''): string[] {
  if (!isSchemaObject(schema)) return [];
  const hits = new Set<string>();
  const at = (name: string): string => (path ? `${path}.${name}` : name);

  const properties = schema['properties'];
  if (isSchemaObject(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (isTenantScopedKey(name)) hits.add(at(name));
      findTenantScopedParameters(child, at(name)).forEach((hit) => hits.add(hit));
    }
  }
  const required = schema['required'];
  if (Array.isArray(required)) {
    required
      .filter((name): name is string => typeof name === 'string' && isTenantScopedKey(name))
      .forEach((name) => hits.add(at(name)));
  }
  for (const keyword of ['items', 'additionalProperties', 'not', 'contains']) {
    findTenantScopedParameters(schema[keyword], at(`<${keyword}>`)).forEach((hit) => hits.add(hit));
  }
  const patternProperties = schema['patternProperties'];
  if (isSchemaObject(patternProperties)) {
    Object.values(patternProperties).forEach((child) =>
      findTenantScopedParameters(child, at('<patternProperties>')).forEach((hit) => hits.add(hit)),
    );
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) =>
        findTenantScopedParameters(branch, at(`<${keyword}[${index}]>`)).forEach((hit) =>
          hits.add(hit),
        ),
      );
    }
  }
  return [...hits];
}
