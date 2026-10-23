/**
 * HR module-code parity invariant
 * ============================================================================
 *
 * A department belongs to a module (`departments_hr.moduleCode`), and the
 * Team area of each workspace lists only that module's people. The module
 * values are tenant module codes, so they must never name something the
 * platform does not know, and the Postgres enum the migration creates must
 * list exactly what the entity's TypeScript enum does — a value present in
 * one and not the other fails at write time in production, not in review.
 *
 * Two relations, both read from source so no service has to boot:
 *   1. every `HrModuleCode` value is an auth-service `ModuleCode` value;
 *   2. the migration's `departments_hr_modulecode_enum` literal list equals
 *      the `HrModuleCode` values.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { REPO_ROOT } from './helpers/farm-graphql-surface';

const HR_ENUMS = 'apps/hr-service/src/common/enums.ts';
const AUTH_MODULE_ENTITY = 'apps/auth-service/src/modules/system-module/entities/module.entity.ts';
const MIGRATION =
  'apps/hr-service/src/database/migrations/1802400000000-AddDepartmentHrModuleCode.ts';

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8');

/** The string values of `export enum <name> { A = 'a', ... }`. */
function enumValues(source: string, name: string): string[] {
  const body = new RegExp(`export enum ${name} \\{([^}]*)\\}`).exec(source)?.[1];
  if (body === undefined) throw new Error(`enum ${name} not found`);
  return [...body.matchAll(/=\s*'([^']+)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('HR module-code parity', () => {
  const hrValues = enumValues(read(HR_ENUMS), 'HrModuleCode');

  it('declares at least one module', () => {
    expect(hrValues.length).toBeGreaterThan(0);
  });

  it('names only tenant modules the platform knows (auth-service ModuleCode)', () => {
    const tenantModules = enumValues(read(AUTH_MODULE_ENTITY), 'ModuleCode');
    expect(hrValues.filter((value) => !tenantModules.includes(value))).toEqual([]);
  });

  it('creates a Postgres enum with exactly the HrModuleCode values', () => {
    const literal = /CREATE TYPE "departments_hr_modulecode_enum" AS ENUM\(([^)]*)\)/.exec(
      read(MIGRATION),
    )?.[1];
    if (literal === undefined)
      throw new Error('migration does not create departments_hr_modulecode_enum');
    const dbValues = [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect([...dbValues].sort()).toEqual([...hrValues].sort());
  });
});
