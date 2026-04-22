/**
 * SensorServiceProfileService unit tests — Faz 3 stage 3.
 *
 * Pins the env-var → enum mapping so a future caller cannot drift
 * the gate name (`SENSOR_SERVICE_PROFILE`) or the accepted values
 * (`legacy`, `control-plane`) without breaking the test.
 */

import { ConfigService } from '@nestjs/config';

import {
  SensorServiceProfile,
  SensorServiceProfileService,
} from '../sensor-service-profile.service';

function makeConfig(value: string | undefined): ConfigService {
  return {
    get: jest.fn().mockReturnValue(value),
  } as unknown as ConfigService;
}

describe('SensorServiceProfileService', () => {
  it('defaults to legacy when env var is unset', () => {
    const svc = new SensorServiceProfileService(makeConfig(undefined));
    expect(svc.getProfile()).toBe(SensorServiceProfile.Legacy);
    expect(svc.isLegacyDataPlaneEnabled()).toBe(true);
  });

  it('defaults to legacy when env var is empty string', () => {
    const svc = new SensorServiceProfileService(makeConfig(''));
    expect(svc.getProfile()).toBe(SensorServiceProfile.Legacy);
    expect(svc.isLegacyDataPlaneEnabled()).toBe(true);
  });

  it('parses "legacy" exactly', () => {
    const svc = new SensorServiceProfileService(makeConfig('legacy'));
    expect(svc.getProfile()).toBe(SensorServiceProfile.Legacy);
    expect(svc.isLegacyDataPlaneEnabled()).toBe(true);
  });

  it('parses "control-plane" exactly', () => {
    const svc = new SensorServiceProfileService(makeConfig('control-plane'));
    expect(svc.getProfile()).toBe(SensorServiceProfile.ControlPlane);
    expect(svc.isLegacyDataPlaneEnabled()).toBe(false);
  });

  it('lower-cases input — "Control-Plane" maps to control-plane', () => {
    const svc = new SensorServiceProfileService(makeConfig('Control-Plane'));
    expect(svc.getProfile()).toBe(SensorServiceProfile.ControlPlane);
  });

  it('trims whitespace — "  legacy  " maps to legacy', () => {
    const svc = new SensorServiceProfileService(makeConfig('  legacy  '));
    expect(svc.getProfile()).toBe(SensorServiceProfile.Legacy);
  });

  it('falls back to legacy on an unrecognised value (without throwing)', () => {
    const svc = new SensorServiceProfileService(makeConfig('typo'));
    expect(svc.getProfile()).toBe(SensorServiceProfile.Legacy);
    expect(svc.isLegacyDataPlaneEnabled()).toBe(true);
  });

  it('NatsConsumer is enabled in BOTH profiles (strangler-fig rollout)', () => {
    const legacy = new SensorServiceProfileService(makeConfig('legacy'));
    const cp = new SensorServiceProfileService(makeConfig('control-plane'));
    expect(legacy.isNatsConsumerEnabled()).toBe(true);
    expect(cp.isNatsConsumerEnabled()).toBe(true);
  });
});
