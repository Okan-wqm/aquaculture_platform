/**
 * Invariant (ADR-047 §1, SENSOR-CRITICAL-173): a sensor's broker credential
 * has one writer, and its directory has none in code.
 *
 * - The entity marks the credential columns (`mqtt_username`, the secret's
 *   HMAC and its pepper's key id) `insert: false, update: false`, so no ORM
 *   save — a row loaded before a rotation, a registration insert, a lifecycle
 *   write — can set them or put an old username back.
 * - The one SQL UPDATE of those columns lives in sensor-mqtt-identity.service.ts.
 * - `sensor.sensor_mqtt_directory` is written only by the trigger migration
 *   1826000000000 puts on `sensors`; a statement in the service code that
 *   inserts, updates or deletes it would be a second route that can drift from
 *   the username (tenant erasure's purge names its table through the shared
 *   route-table list, not a literal).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTITY = 'apps/sensor-service/src/database/entities/sensor.entity.ts';
const WRITER = 'apps/sensor-service/src/mqtt-identity/sensor-mqtt-identity.service.ts';

const CREDENTIAL_COLUMNS = ['mqtt_username', 'mqtt_secret_hmac', 'mqtt_secret_key_id'] as const;

const CREDENTIAL_UPDATE = new RegExp(
  `UPDATE\\s+(?:"?\\w+"?\\.)?"?sensors"?\\s+SET[\\s\\S]{0,600}?\\b(?:${CREDENTIAL_COLUMNS.join('|')})\\s*=`,
  'i',
);
const DIRECTORY_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?sensor"?\.)?"?sensor_mqtt_directory\b/i;

function sensorServiceSources(): string[] {
  return execFileSync('git', ['ls-files', 'apps/sensor-service/src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.length > 0)
    .filter((file) => !/(\.spec|\.test)\.ts$|\/__tests__\/|\/migrations\//.test(file));
}

describe('a sensor’s broker credential has one writer (ADR-047)', () => {
  const entity = readFileSync(path.join(REPO_ROOT, ENTITY), 'utf8');
  const sources = sensorServiceSources();

  it.each(CREDENTIAL_COLUMNS)(
    'the entity never lets an ORM insert or update write %s',
    (column) => {
      const decorator = new RegExp(`@Column\\(\\{[^}]*name: '${column}'[^}]*\\}\\)`).exec(entity);
      const found = decorator?.[0] ?? `no @Column for ${column}`;
      expect(found).toMatch(/insert: false/);
      expect(found).toMatch(/update: false/);
    },
  );

  it('only the identity service issues an SQL UPDATE of the credential columns', () => {
    expect(sources.length).toBeGreaterThan(100);
    const writers = sources.filter((file) =>
      CREDENTIAL_UPDATE.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
    );
    expect(writers).toEqual([WRITER]);
  });

  it('no service code writes the directory; the trigger does', () => {
    const writers = sources.filter((file) =>
      DIRECTORY_WRITE.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
    );
    expect(writers).toEqual([]);
  });
});
