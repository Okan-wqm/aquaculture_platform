/**
 * Invariant (ADR-047 §1, SENSOR-CRITICAL-173): a sensor's broker principal
 * has one writer.
 *
 * - The principal lives in `sensor.sensor_mqtt_directory` (username, tenant,
 *   sensor, the secret's HMAC and its pepper's key id); the sensor keeps only
 *   `mqtt_username`, which the entity marks `insert: false, update: false`, so
 *   no ORM save — a row loaded before a rotation, a registration insert, a
 *   lifecycle write — can set it or put an old username back.
 * - sensor-mqtt-identity.service.ts is the one place that sets
 *   `mqtt_username` and the one place that inserts a directory row; it does
 *   both in one transaction, and a trigger checked at commit refuses it if
 *   they disagree.
 * - No service code updates or deletes a directory row: the trigger migration
 *   1826000000000 puts on `sensors` removes the route when the username is
 *   cleared or changed or the sensor deleted, and tenant erasure and the
 *   schema delete job purge it through MODULE_SCHEMAS `tenantRouteTables`,
 *   never by naming the table.
 * - Nothing persists a directory row through the ORM.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTITY = 'apps/sensor-service/src/database/entities/sensor.entity.ts';
const WRITER = 'apps/sensor-service/src/mqtt-identity/sensor-mqtt-identity.service.ts';

const USERNAME_UPDATE =
  /UPDATE\s+(?:"?\w+"?\.)?"?sensors"?(?:\s+(?:AS\s+)?\w+)?\s+SET[\s\S]{0,600}?\bmqtt_username\s*=/i;
const DIRECTORY_INSERT = /\bINSERT\s+INTO\s+(?:"?sensor"?\.)?"?sensor_mqtt_directory\b/i;
const DIRECTORY_CHANGE = /\b(?:UPDATE|DELETE\s+FROM)\s+(?:"?sensor"?\.)?"?sensor_mqtt_directory\b/i;
const DIRECTORY_ORM_WRITE =
  /\b(?:save|insert|update|upsert|delete|remove)\(\s*SensorMqttDirectory\b|getRepository\(\s*SensorMqttDirectory\b|Repository<\s*SensorMqttDirectory\s*>/;

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

  const writersOf = (pattern: RegExp): string[] =>
    sources.filter((file) => pattern.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')));

  it('the entity never lets an ORM insert or update write mqtt_username', () => {
    const decorator = /@Column\(\{[^}]*name: 'mqtt_username'[^}]*\}\)/.exec(entity);
    const found = decorator?.[0] ?? 'no @Column for mqtt_username';
    expect(found).toMatch(/insert: false/);
    expect(found).toMatch(/update: false/);
  });

  it('the sensor holds no secret: the directory row is the one home of the credential', () => {
    expect(entity).not.toMatch(/mqtt_secret/);
  });

  it('only the identity service sets mqtt_username and inserts a directory row', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(writersOf(USERNAME_UPDATE)).toEqual([WRITER]);
    expect(writersOf(DIRECTORY_INSERT)).toEqual([WRITER]);
  });

  it('no service code updates or deletes a directory row; the triggers and the purges do', () => {
    expect(writersOf(DIRECTORY_CHANGE)).toEqual([]);
  });

  it('nothing persists a directory row through the ORM', () => {
    expect(writersOf(DIRECTORY_ORM_WRITE)).toEqual([]);
  });
});
