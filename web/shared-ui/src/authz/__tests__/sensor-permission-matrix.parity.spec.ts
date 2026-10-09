/**
 * Sensor mutation mirror parity: each mutation in SENSOR_MUTATION_ROLES
 * carries exactly the roles of the `@Roles(...)` on its resolver method.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SENSOR_MUTATION_RESOLVERS,
  SENSOR_MUTATION_ROLES,
  type SensorMutationName,
} from '../sensor-permission-matrix';

function repoFile(relative: string): string {
  let dir = __dirname;
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      return readFileSync(resolve(dir, relative), 'utf8');
    } catch {
      dir = resolve(dir, '..');
    }
  }
  throw new Error(`Could not locate ${relative} from the test`);
}

/** The roles of the @Roles decorator in the decorator block of a named mutation. */
function resolverRoles(source: string, mutation: string): string[] {
  const named = source.indexOf(`name: '${mutation}'`);
  if (named < 0) throw new Error(`No @Mutation named '${mutation}' in the resolver`);
  const block = source.slice(named, source.indexOf('async ', named));
  const roles = block.match(/@Roles\(([^)]*)\)/);
  if (roles === null || roles[1] === undefined) throw new Error(`'${mutation}' carries no @Roles`);
  return [
    ...new Set(
      roles[1]
        .split(',')
        .map((role) => role.trim().replace(/^Role\./, ''))
        .filter((role) => role.length > 0),
    ),
  ].sort();
}

describe('sensor mutation mirror parity', () => {
  it.each(Object.keys(SENSOR_MUTATION_ROLES) as SensorMutationName[])(
    '%s has the roles of its resolver',
    (mutation) => {
      const source = repoFile(SENSOR_MUTATION_RESOLVERS[mutation]);
      expect([...SENSOR_MUTATION_ROLES[mutation]].sort()).toEqual(resolverRoles(source, mutation));
    },
  );
});
