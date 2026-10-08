import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * INVARIANT (FARM-HIGH-373, plan D12): every write that retires a measurement
 * point — a tank, system, equipment, department (its units) or site — closes
 * the water-quality sources standing there, in the same transaction, through
 * closeSourcesAtPoints.
 *
 * A source left live at a retired point keeps counting as bound
 * (liveChannelSourceCount): its parameter's update, delete, declare, clear and
 * template overwrite then refuse with 409 forever, and no API can name the
 * source to unbind once the point is gone.
 *
 * A file is a point retirer when it imports a point entity and writes a
 * retirement (isActive false, isDeleted true, softDelete). Files that retire
 * something else while importing a point entity are listed with the reason.
 */
const FARM_SRC = resolve(__dirname, '..', '..');

const POINT_ENTITY_IMPORT = /\/(tank|system|equipment|site|department)\.entity'/;
const RETIREMENT_WRITE = /isActive\s*[:=]\s*false|isDeleted\s*[:=]\s*true|\.softDelete\(/;

const NOT_POINT_RETIREMENTS: Readonly<Record<string, string>> = {
  'equipment/handlers/delete-sub-equipment.handler.ts':
    'retires a sub_equipment row; sub-equipment is not a measurement point',
  'harvest/handlers/delete-harvest-record.handler.ts':
    'soft-deletes harvest ledger rows; it reads the tank, it does not retire it',
  'feeding/services/feeding-program.service.ts':
    'removes a tank from a feeding program (feeding_program_tanks), not the tank',
};

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'migrations' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.entity.ts')
    ) {
      found.push(full);
    }
  }
  return found;
}

function retiresPoint(source: string): boolean {
  return POINT_ENTITY_IMPORT.test(source) && RETIREMENT_WRITE.test(source);
}

describe('INVARIANT: retiring a measurement point closes its water-quality sources', () => {
  const retirers = sourceFiles(FARM_SRC)
    .map((file) => ({ file: relative(FARM_SRC, file), source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => retiresPoint(source));

  it('finds the known point retirers (the scan is not vacuous)', () => {
    const files = retirers.map(({ file }) => file);
    for (const expected of [
      'tank/handlers/delete-tank.handler.ts',
      'system/handlers/delete-system.handler.ts',
      'equipment/handlers/delete-equipment.handler.ts',
      'department/handlers/delete-department.handler.ts',
      'site/handlers/delete-site.handler.ts',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it('every point retirer calls closeSourcesAtPoints', () => {
    const offenders = retirers
      .filter(({ file }) => !(file in NOT_POINT_RETIREMENTS))
      .filter(({ source }) => !source.includes('closeSourcesAtPoints('))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('lists no exception that no longer matches', () => {
    const files = new Set(retirers.map(({ file }) => file));
    expect(Object.keys(NOT_POINT_RETIREMENTS).filter((file) => !files.has(file))).toEqual([]);
  });

  it('recognises a retirement write next to a point entity', () => {
    expect(
      retiresPoint(
        "import { Tank } from '../entities/tank.entity';\nawait repo.update({ id }, { isActive: false });",
      ),
    ).toBe(true);
    expect(
      retiresPoint("import { Tank } from '../entities/tank.entity';\nreturn repo.find();"),
    ).toBe(false);
  });
});
