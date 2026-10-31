/**
 * SENSOR-LOW-008 — legacy MQTT file mode (101 PBKDF2 iterations) must fail
 * closed in production. Starting the weak file-mode backend has to be an
 * explicit, audited operator decision, never a silent default.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { collaborator } from '@aquaculture/testing';

import { DeviceDirectoryService } from '../device-directory.service';
import { MqttAuthService } from '../mqtt-auth.service';
import type { SensorMqttBrokerAccess } from '../../mqtt-identity/sensor-mqtt-broker-access.service';

// These checks never reach a sensor's own principal (ADR-047): an empty
// double, so touching it throws and names the member.
const noSensorPrincipals = (): SensorMqttBrokerAccess =>
  collaborator<SensorMqttBrokerAccess>({}, 'SensorMqttBrokerAccess');

// File-mode startup never resolves a device, so the directory double defines
// nothing: touching it would throw and name the missing member.
const buildService = (env: Record<string, string>): MqttAuthService =>
  new MqttAuthService(
    new ConfigService(env),
    collaborator<DeviceDirectoryService>({}, 'DeviceDirectoryService'),
    noSensorPrincipals(),
  );

describe('MqttAuthService legacy file mode guard (SENSOR-LOW-008)', () => {
  it('refuses to start in production with file mode and no explicit opt-in', async () => {
    const service = buildService({ NODE_ENV: 'production', MQTT_AUTH_MODE: 'file' });
    await expect(service.onModuleInit()).rejects.toThrow(/MQTT_AUTH_MODE=file/);
  });

  it('allows file mode in production only with the explicit migration flag', async () => {
    const service = buildService({
      NODE_ENV: 'production',
      MQTT_AUTH_MODE: 'file',
      MQTT_ALLOW_LEGACY_FILE_MODE: 'true',
      MQTT_AUTH_ENABLED: 'false',
    });
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('defaults to the DB-backed HTTP backend (600k iterations)', async () => {
    const service = buildService({});
    const { hash } = await service.generateCredentials();
    // $7$<iterations>$<salt>$<hash>
    expect(hash.startsWith('$7$600000$')).toBe(true);
  });
});

describe('MqttAuthService legacy file mode password file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mqtt-file-mode-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to start without the password file it is told to keep', () => {
    // No default path: the only broker that read one was the simulator's,
    // which now runs the platform broker; a default would name nothing.
    expect(() => buildService({ MQTT_AUTH_MODE: 'file', MQTT_AUTH_ENABLED: 'true' })).toThrow(
      /MOSQUITTO_PASSWORD_FILE/,
    );
  });

  it("reads the string 'false' as off, so no password file is kept or read", async () => {
    const service = buildService({ MQTT_AUTH_MODE: 'file', MQTT_AUTH_ENABLED: 'false' });
    await expect(service.hasCredentials('edge-aaaaaaaa-pond-01')).resolves.toBe(false);
  });

  it('reads credentials from the password file it is given', async () => {
    // Read path only: a write would signal the broker (reloadMosquitto).
    const file = join(dir, 'passwd');
    writeFileSync(file, '# header\nedge-aaaaaaaa-pond-01:$7$101$c2FsdA==$aGFzaA==\n', 'utf-8');
    const service = buildService({
      MQTT_AUTH_MODE: 'file',
      MQTT_AUTH_ENABLED: 'true',
      MOSQUITTO_PASSWORD_FILE: file,
    });

    await expect(service.hasCredentials('edge-aaaaaaaa-pond-01')).resolves.toBe(true);
    await expect(service.hasCredentials('edge-aaaaaaaa-pond-02')).resolves.toBe(false);
  });
});
