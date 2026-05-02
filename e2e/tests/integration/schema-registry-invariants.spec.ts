/**
 * SCHEMA_REGISTRY ↔ init-schemas.sh Invariants (MA4)
 * ============================================================================
 *
 * STATIC analysis — asserts that
 * `apps/db-migrate/src/schema-registry.ts` (the Single Source of Truth for
 * schemas + roles) stays in lockstep with the GENERATED region of
 * `infrastructure/docker/init-scripts/00-init-schemas.sh`.
 *
 * # Why this invariant exists
 *
 * 2026-04-16 deploy failed at migration-orchestrator time with:
 *   search_path pin verification failed for "notification"
 * because the notification schema had been added to SCHEMA_REGISTRY but the
 * hand-maintained init script never got the matching `CREATE SCHEMA` +
 * `ALTER OWNER` statements. Same class blocked `observability` and
 * `event_store` from ever materialising on droplets.
 *
 * MA4 closes the class via codegen + this invariant.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SCHEMA_REGISTRY } from '../../../apps/db-migrate/src/schema-registry';

const REPO_ROOT = resolve(__dirname, '../../..');
const INIT_SCRIPT_PATH = resolve(
  REPO_ROOT,
  'infrastructure/docker/init-scripts/00-init-schemas.sh',
);

const BEGIN_SENTINEL = '# BEGIN GENERATED — schema-registry';
const END_SENTINEL = '# END GENERATED — schema-registry';

function extractGeneratedRegion(initScript: string): string {
  const beginIdx = initScript.indexOf(BEGIN_SENTINEL);
  const endIdx = initScript.indexOf(END_SENTINEL);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    throw new Error(
      `Missing or malformed sentinels in init-schemas.sh.\n` +
        `Expected both "${BEGIN_SENTINEL}" and "${END_SENTINEL}".`,
    );
  }
  return initScript.slice(beginIdx + BEGIN_SENTINEL.length, endIdx);
}

describe('SCHEMA_REGISTRY ↔ init-schemas.sh invariants (MA4)', () => {
  const initScript = readFileSync(INIT_SCRIPT_PATH, 'utf8');
  const generated = extractGeneratedRegion(initScript);

  const entriesWithRole = SCHEMA_REGISTRY.filter(
    (e): e is typeof e & { role: string } => typeof e.role === 'string',
  );

  const createSchemas = new Map<string, string>();
  const alterOwners = new Map<string, string>();

  {
    const createRe =
      /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+AUTHORIZATION\s+(\w+)\s*;/gi;
    const alterRe = /ALTER\s+SCHEMA\s+(\w+)\s+OWNER\s+TO\s+(\w+)\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(generated)) !== null) {
      const schema = m[1];
      const role = m[2];
      if (schema && role) createSchemas.set(schema, role);
    }
    while ((m = alterRe.exec(generated)) !== null) {
      const schema = m[1];
      const role = m[2];
      if (schema && role) alterOwners.set(schema, role);
    }
  }

  it('every SCHEMA_REGISTRY entry with a role has a CREATE + ALTER OWNER in GENERATED', () => {
    const missing: string[] = [];
    for (const e of entriesWithRole) {
      const createdWith = createSchemas.get(e.schema);
      const ownedBy = alterOwners.get(e.schema);
      if (createdWith !== e.role || ownedBy !== e.role) {
        missing.push(
          `schema="${e.schema}" expected-role="${e.role}" ` +
            `(found CREATE=${createdWith ?? '<none>'}, ALTER=${ownedBy ?? '<none>'})`,
        );
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `SCHEMA_REGISTRY → init-schemas.sh drift (MA4):\n` +
          missing.map((m) => '  - ' + m).join('\n') +
          `\n\nResolution: \`npm run codegen:schema-registry\` and commit.`,
      );
    }
  });

  it('every CREATE SCHEMA in GENERATED has a matching ALTER OWNER', () => {
    const orphans: string[] = [];
    for (const [schema, role] of createSchemas) {
      const ownerRole = alterOwners.get(schema);
      if (ownerRole !== role) {
        orphans.push(
          `schema="${schema}": CREATE AUTHORIZATION=${role}, ` +
            `ALTER OWNER=${ownerRole ?? '<missing>'}`,
        );
      }
    }
    expect(orphans).toEqual([]);
  });

  it('no GENERATED schema is missing from SCHEMA_REGISTRY', () => {
    const registrySchemas = new Set(entriesWithRole.map((e) => e.schema));
    const orphans: string[] = [];
    for (const schema of createSchemas.keys()) {
      if (!registrySchemas.has(schema)) orphans.push(schema);
    }
    if (orphans.length > 0) {
      throw new Error(
        `Schemas in GENERATED but not in SCHEMA_REGISTRY: ${orphans.join(', ')}\n` +
          `Either add them to SCHEMA_REGISTRY (and regenerate), or move\n` +
          `their CREATE SCHEMA statement OUTSIDE the sentinels if truly hand-owned.`,
      );
    }
  });

  it('SCHEMA_REGISTRY count matches GENERATED count', () => {
    expect(createSchemas.size).toBe(entriesWithRole.length);
    expect(alterOwners.size).toBe(entriesWithRole.length);
  });
});
