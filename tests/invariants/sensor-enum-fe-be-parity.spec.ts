/**
 * Sensor FE/BE Enum Parity Invariant
 * ============================================================================
 *
 * Closes SENSOR-HIGH-028 (docs/reviews/2026-07-05-sensor-vfd-device-audit.md).
 *
 *   `SensorType` and `VfdChangeSetStatus` are real GraphQL enums defined on the
 *   backend and re-declared by hand in the sensor-module frontend (no codegen).
 *   A frontend member the backend does not define makes the mutation/query fail
 *   at the GraphQL boundary (enum-validation error), and a backend member the
 *   frontend does not handle crashes value-keyed lookups (e.g. STATUS_STYLES).
 *
 * # What this spec enforces (Tier-3 "make it detectable")
 *
 *   - Frontend `SensorType` member names are a SUBSET of the backend enum.
 *   - Frontend `VfdChangeSetStatus` member names are a SUBSET of the backend
 *     enum (the FE must not send a status the BE can't accept; missing FE
 *     members are allowed but flagged so verified/cancelled render).
 *
 * # When this spec fails
 *
 *   - A new value was added to one side only → mirror it on the other side
 *     (or, for a Postgres-enum backend column, add it there first via an
 *     ALTER TYPE migration before exposing it in the FE).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Extract the member NAMES of an `export enum <Name> { ... }` block. */
function enumMembers(file: string, enumName: string): string[] {
  const src = readFileSync(file, 'utf8');
  const re = new RegExp(`export enum ${enumName}\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const body = re.exec(src)?.[1];
  if (!body) throw new Error(`enum ${enumName} not found in ${file}`);
  const members: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m) members.push(m[1]!);
  }
  return members;
}

const FE_REGISTRATION = path.join(
  REPO_ROOT,
  'web/modules/sensor-module/src/types/registration.types.ts',
);
const BE_SENSOR_ENTITY = path.join(
  REPO_ROOT,
  'apps/sensor-service/src/database/entities/sensor.entity.ts',
);
const FE_VFD_TYPES = path.join(REPO_ROOT, 'web/modules/sensor-module/src/types/vfd.types.ts');
const BE_VFD_ENUMS = path.join(REPO_ROOT, 'apps/sensor-service/src/vfd/entities/vfd.enums.ts');

describe('Sensor FE/BE enum parity (SENSOR-HIGH-028)', () => {
  it('all target files exist', () => {
    for (const f of [FE_REGISTRATION, BE_SENSOR_ENTITY, FE_VFD_TYPES, BE_VFD_ENUMS]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  it('frontend SensorType is a subset of backend SensorType', () => {
    const fe = enumMembers(FE_REGISTRATION, 'SensorType');
    const be = new Set(enumMembers(BE_SENSOR_ENTITY, 'SensorType'));
    const extra = fe.filter((m) => !be.has(m));
    expect(extra).toEqual([]);
  });

  it('frontend VfdChangeSetStatus is a subset of backend VfdChangeSetStatus', () => {
    const fe = enumMembers(FE_VFD_TYPES, 'VfdChangeSetStatus');
    const be = new Set(enumMembers(BE_VFD_ENUMS, 'VfdChangeSetStatus'));
    const extra = fe.filter((m) => !be.has(m));
    expect(extra).toEqual([]);
  });
});
