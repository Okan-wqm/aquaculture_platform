/**
 * Invariant (SENSOR-MEDIUM-161/206): a sensor's place has one writer.
 *
 * Where a sensor stands — site, department, system, tank or equipment, the
 * legacy farm and pond, and when it was placed there — is written when the row
 * is inserted and, after that, only by SensorPlacementService's move, after
 * farm accepts the place. Two things make that structural:
 *
 * - The entity marks every one of those columns `update: false`, so no ORM
 *   update (a save() of a row loaded before a move, a batch edit, a lifecycle
 *   write) can change them. A second writer used to put moved sensors back.
 * - The one SQL UPDATE of those columns lives in sensor-placement.service.ts;
 *   any other `UPDATE sensors SET <place column>` is a second, unchecked writer.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTITY = 'apps/sensor-service/src/database/entities/sensor.entity.ts';
const WRITER = 'apps/sensor-service/src/registration/services/sensor-placement.service.ts';

const PLACE_COLUMNS = [
  'site_id',
  'department_id',
  'system_id',
  'tank_id',
  'equipment_id',
  'farm_id',
  'pond_id',
  'placed_at',
] as const;

const PLACE_UPDATE = new RegExp(
  `UPDATE\\s+(?:"?\\w+"?\\.)?"?sensors"?(?:\\s+(?:AS\\s+)?\\w+)?\\s+SET[\\s\\S]{0,600}?\\b(?:${PLACE_COLUMNS.join('|')})\\s*=`,
  'i',
);

function sensorServiceSources(): string[] {
  return execFileSync('git', ['ls-files', 'apps/sensor-service/src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.length > 0)
    .filter((file) => !/(\.spec|\.test)\.ts$|\/__tests__\/|\/migrations\//.test(file));
}

describe('a sensor’s place has one writer (SENSOR-MEDIUM-161/206)', () => {
  const entity = readFileSync(path.join(REPO_ROOT, ENTITY), 'utf8');

  it.each(PLACE_COLUMNS)('the entity never lets an ORM update write %s', (column) => {
    const decorator = new RegExp(`@Column\\(\\{[^}]*name: '${column}'[^}]*\\}\\)`).exec(entity);
    expect(decorator?.[0] ?? `no @Column for ${column}`).toMatch(/update: false/);
  });

  it('only the placement service issues an SQL UPDATE of the place columns', () => {
    const sources = sensorServiceSources();
    expect(sources.length).toBeGreaterThan(100);
    const writers = sources.filter((file) =>
      PLACE_UPDATE.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
    );
    expect(writers).toEqual([WRITER]);
  });
});
