/** One row of platform bootstrap stage 008's canonical role map. */
export interface LeastPrivilegeRoleSpec {
  readonly schema_name: string;
  readonly owner_role: string;
  readonly runtime_role: string;
  readonly provisioner_role: string | null;
}

const ROLE_MAP_LITERAL = /jsonb_to_recordset\(\s*'(\[[\s\S]*?\])'::jsonb/;
const ROLE_SPEC_KEYS = ['owner_role', 'provisioner_role', 'runtime_role', 'schema_name'];

function isStrictRoleSpec(value: unknown): value is LeastPrivilegeRoleSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  return (
    keys.length === ROLE_SPEC_KEYS.length &&
    keys.every((key, index) => key === ROLE_SPEC_KEYS[index]) &&
    typeof candidate['schema_name'] === 'string' &&
    typeof candidate['owner_role'] === 'string' &&
    typeof candidate['runtime_role'] === 'string' &&
    (typeof candidate['provisioner_role'] === 'string' || candidate['provisioner_role'] === null)
  );
}

/**
 * Compile the stage-008 SQL literal into a strict, non-vacuous role catalog.
 *
 * The SQL file remains the sole mutation authority. Every test/runtime
 * consumer calls this compiler instead of copying the schema/owner/runtime
 * triples. Malformed rows, duplicates, and empty authorities fail before any
 * database assertion can report a misleading green result.
 */
export function parseLeastPrivilegeRoleAuthority(
  sql: string,
  sourceLabel = 'platform bootstrap stage 008',
): readonly LeastPrivilegeRoleSpec[] {
  const literal = sql.match(ROLE_MAP_LITERAL)?.[1];
  if (!literal) {
    throw new Error(
      `[least-privilege-role-authority] Could not read jsonb_to_recordset role map from ${sourceLabel}.`,
    );
  }

  const parsed: unknown = JSON.parse(literal);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `[least-privilege-role-authority] ${sourceLabel} compiled to an empty role map.`,
    );
  }
  if (!parsed.every(isStrictRoleSpec)) {
    throw new Error(
      `[least-privilege-role-authority] ${sourceLabel} contains a row outside the strict role schema.`,
    );
  }

  const coordinates = new Set<string>();
  for (const spec of parsed) {
    for (const [kind, coordinate] of [
      ['schema', spec.schema_name],
      ['owner', spec.owner_role],
      ['runtime', spec.runtime_role],
    ] as const) {
      const key = `${kind}:${coordinate}`;
      if (coordinates.has(key)) {
        throw new Error(
          `[least-privilege-role-authority] ${sourceLabel} duplicates ${kind} coordinate "${coordinate}".`,
        );
      }
      coordinates.add(key);
    }
  }

  return Object.freeze(parsed.map((spec) => Object.freeze({ ...spec })));
}
