/**
 * SENSOR-LOW-008 — legacy MQTT file mode (101 PBKDF2 iterations) must fail
 * closed in production. Starting the weak file-mode backend has to be an
 * explicit, audited operator decision, never a silent default.
 */
import { MqttAuthService } from '../mqtt-auth.service';

const buildConfig = (env: Record<string, string>) => ({
  get: (key: string, fallback?: unknown): unknown => env[key] ?? fallback,
});

const buildService = (env: Record<string, string>): MqttAuthService =>
  new MqttAuthService(buildConfig(env) as never, {} as never, {} as never, {} as never);

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

  it('defaults to the DB-backed HTTP backend (600k iterations)', () => {
    const service = buildService({});
    const { hash } = service.generateCredentials();
    // $7$<iterations>$<salt>$<hash>
    expect(hash.startsWith('$7$600000$')).toBe(true);
  });
});
