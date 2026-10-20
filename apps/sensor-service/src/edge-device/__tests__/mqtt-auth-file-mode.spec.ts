/**
 * The legacy Mosquitto password-file mode is refused at boot in every
 * environment (SENSOR-LOW-008, ADR-048 DEC-5.7): a device activation commits
 * only when the device's own credential authenticates a CONNECT at
 * /mqtt/auth, and in file mode Mosquitto never asks, so no activation on
 * either agent channel could ever commit.
 */
import { ConfigService } from '@nestjs/config';
import { collaborator } from '@aquaculture/testing';

import { DeviceDirectoryService } from '../device-directory.service';
import { MqttAuthService } from '../mqtt-auth.service';
import { type ProvisioningReservationService } from '../provisioning-reservation.service';

// Startup never resolves a device, so the doubles define nothing: touching
// one would throw and name the missing member.
const buildService = (env: Record<string, string>): MqttAuthService =>
  new MqttAuthService(
    new ConfigService(env),
    collaborator<DeviceDirectoryService>({}, 'DeviceDirectoryService'),
    collaborator<ProvisioningReservationService>({}, 'ProvisioningReservationService'),
  );

describe('MqttAuthService runs the HTTP auth backend only', () => {
  it.each<Record<string, string>>([
    { NODE_ENV: 'production', MQTT_AUTH_MODE: 'file' },
    { NODE_ENV: 'development', MQTT_AUTH_MODE: 'file' },
    // The former migration opt-in no longer opens it.
    { NODE_ENV: 'production', MQTT_AUTH_MODE: 'file', MQTT_ALLOW_LEGACY_FILE_MODE: 'true' },
    { MQTT_AUTH_MODE: 'password_file' },
  ])('refuses to start with %o', async (env) => {
    await expect(buildService(env).onModuleInit()).rejects.toThrow(
      /is not supported: the broker must use the HTTP auth backend/,
    );
  });

  it('starts with the HTTP backend, explicit or by default', async () => {
    await expect(buildService({ MQTT_AUTH_MODE: 'http' }).onModuleInit()).resolves.toBeUndefined();
    await expect(buildService({}).onModuleInit()).resolves.toBeUndefined();
  });

  it('hashes device credentials at 600k PBKDF2 iterations', async () => {
    const { hash } = await buildService({}).generateCredentials();
    // $7$<iterations>$<salt>$<hash>
    expect(hash.startsWith('$7$600000$')).toBe(true);
  });
});
