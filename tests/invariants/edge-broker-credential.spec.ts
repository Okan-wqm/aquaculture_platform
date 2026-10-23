import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { stripComments } from './helpers/ts-source';

/**
 * SENSOR-MEDIUM-236 — re-provisioning never replaces a credential the running agent
 * holds before the reinstalled agent has proved its own (ADR-048 DEC-5.7, DEC-5.14).
 *
 * The broker credential has two slots: `mqtt_password_hash` (the latest activation's) and
 * `previous_mqtt_password_hash` (the last committed one, kept while that activation is
 * uncommitted). The database refuses any row that holds a previous credential outside a
 * pending activation (`CHK_edge_devices_previous_credential`, proven on real Postgres in
 * provisioning-reservation.rls.postgres.spec.ts). This spec pins, in comment-stripped
 * source, what the database cannot see:
 *
 *   - the broker credential columns are named only by the entity, the one service that
 *     moves them between slots, the authenticator that reads them, self-registration
 *     (which creates a device's first credential) and the redaction list. A new writer
 *     elsewhere would replace a committed credential outside the state machine;
 *   - activation moves the committed hash to the previous slot in the same `.set({…})`
 *     that writes the new one, and does so only while no credential was issued under the
 *     token (a repeated activation must not promote the uncommitted one);
 *   - the commit retires the previous credential and spends the token only for the hash
 *     the CONNECT proved (`mqtt_password_hash = :proven`);
 *   - a new window drops the uncommitted credential and restores the committed one, and a
 *     from-scratch reissue revokes both slots;
 *   - the authenticator never commits on the previous credential and hands the commit the
 *     hash it verified.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SENSOR = 'apps/sensor-service/src/edge-device/';
const ENTITY = `${SENSOR}entities/edge-device.entity.ts`;
const RESERVATIONS = `${SENSOR}provisioning-reservation.service.ts`;
const AUTH = `${SENSOR}mqtt-auth.service.ts`;
const SELF_REGISTRATION = `${SENSOR}provisioning.service.ts`;
const REDACTION = 'libs/backend-common/src/security/security-constants.ts';
const ALLOWED = new Set([ENTITY, RESERVATIONS, AUTH, SELF_REGISTRATION, REDACTION]);

const read = (path: string): string => stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'));

function productionSources(): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/*.ts', 'libs/*.ts', 'platform/*.ts'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.d.ts') &&
        !/\/(__tests__|__mocks__|test-helpers|testing|migrations)\//.test(path),
    );
}

/** The body of `async <name>(` up to the next method at the class's indentation. */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}(?:private |protected |public )?(?:async )?[A-Za-z]+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('broker credential slots (SENSOR-MEDIUM-236)', () => {
  it('the credential columns are named only where the state machine lives', () => {
    const touchers = productionSources().filter((path) =>
      /mqttPasswordHash|mqtt_password_hash|previousMqttPasswordHash|previous_mqtt_password_hash/.test(
        read(path),
      ),
    );
    // farm-service keeps its own audit redaction list; it audits no edge device.
    const unexpected = touchers.filter(
      (path) => !ALLOWED.has(path) && !path.startsWith('apps/farm-service/'),
    );
    expect(unexpected).toEqual([]);
    expect(touchers).toContain(RESERVATIONS);
  });

  it('activation keeps the committed credential beside the new one, and only while none was issued', () => {
    const body = methodBody(read(RESERVATIONS), 'issueCredentials');
    const keep = body.indexOf('previousMqttPasswordHash');
    const write = body.indexOf('mqttPasswordHash: credentials.mqttPasswordHash');
    expect(keep).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(keep);
    expect(body).toMatch(
      /CASE WHEN credentials_issued_at IS NULL THEN mqtt_password_hash ELSE previous_mqtt_password_hash END/,
    );
  });

  it('the commit retires the previous credential and names the hash that was proven', () => {
    const body = methodBody(read(RESERVATIONS), 'commitFirstSession');
    expect(body).toContain('previousMqttPasswordHash: null');
    expect(body).toContain("andWhere('mqtt_password_hash = :proven')");
    expect(body).toMatch(/proven:\s*provenHash/);
  });

  it('a new window restores the committed credential, a reissue revokes both', () => {
    const source = read(RESERVATIONS);
    const begin = methodBody(source, 'beginReprovisioning');
    expect(begin).toContain(
      "mqttPasswordHash: () => 'COALESCE(previous_mqtt_password_hash, mqtt_password_hash)'",
    );
    expect(begin).toContain('previousMqttPasswordHash: null');
    const reissue = methodBody(source, 'reissueToken');
    expect(reissue).toMatch(/mqttPasswordHash: null,\s*previousMqttPasswordHash: null/);
  });

  it('the authenticator commits only on the current credential, naming the hash it verified', () => {
    const source = read(AUTH);
    const verify = methodBody(source, 'verifyDeviceCredentials');
    const previousExit = verify.indexOf("proven === 'previous'");
    const commit = verify.indexOf('commitFirstSession(');
    expect(previousExit).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(previousExit);
    expect(verify).toMatch(/commitFirstSession\(device, new Date\(\), current\)/);
  });
});
