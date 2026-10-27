import { stub } from '@aquaculture/testing';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { NATS_PATTERNS } from '@aquaculture/backend-common/constants';
import { of, throwError } from 'rxjs';

import { DeviceOwnershipService } from '../device-ownership.service';

const T = '11111111-1111-4111-8111-111111111111';
const S9 = '33333333-3333-4333-8333-333333333339';
const DEVICE = 'PLC-01';

function config(values: Record<string, string> = {}): ConfigService {
  return stub<ConfigService>({
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  });
}

function service(
  send: jest.Mock | undefined,
  values: Record<string, string> = {},
): DeviceOwnershipService {
  const nats = send === undefined ? undefined : stub<ClientProxy>({ send });
  return new DeviceOwnershipService(config(values), nats);
}

/**
 * The edge-device ownership helper answers with the device's site (SEC-CRITICAL-207), so the
 * /sensors gateway admits a site-bound sensor operator to the devices of its own sites only.
 */
describe('DeviceOwnershipService.devicePlacement (SEC-CRITICAL-207)', () => {
  it('asks sensor-service and returns the site of a device the tenant owns', async () => {
    const send = jest.fn().mockReturnValue(of({ owned: true, siteId: S9 }));
    const ownership = service(send);

    await expect(ownership.devicePlacement(DEVICE, T)).resolves.toEqual({ siteId: S9 });
    expect(send).toHaveBeenCalledWith(NATS_PATTERNS.SENSOR.VERIFY_DEVICE_OWNERSHIP, {
      deviceCode: DEVICE,
      tenantId: T,
    });
    ownership.onModuleDestroy();
  });

  it('places a device of a responder from the previous release on no site', async () => {
    const ownership = service(jest.fn().mockReturnValue(of({ owned: true })));

    await expect(ownership.devicePlacement(DEVICE, T)).resolves.toEqual({ siteId: null });
    ownership.onModuleDestroy();
  });

  it.each([
    ['a device the tenant does not own', of({ owned: false, siteId: null })],
    ['a malformed reply', of({ owned: 'yes' })],
    ['an unreachable sensor-service', throwError(() => new Error('timeout'))],
  ])('places nothing for %s', async (_case, reply) => {
    const ownership = service(jest.fn().mockReturnValue(reply));

    await expect(ownership.devicePlacement(DEVICE, T)).resolves.toBeNull();
    ownership.onModuleDestroy();
  });

  it('answers a repeated question from the cache', async () => {
    const send = jest.fn().mockReturnValue(of({ owned: true, siteId: S9 }));
    const ownership = service(send);

    await ownership.devicePlacement(DEVICE, T);
    await expect(ownership.devicePlacement(DEVICE, T)).resolves.toEqual({ siteId: S9 });
    expect(send).toHaveBeenCalledTimes(1);
    ownership.onModuleDestroy();
  });

  it('places nothing without NATS, and no site under SKIP_DEVICE_AUTH', async () => {
    const strict = service(undefined);
    const skipping = service(undefined, { SKIP_DEVICE_AUTH: 'true' });

    await expect(strict.devicePlacement(DEVICE, T)).resolves.toBeNull();
    await expect(skipping.devicePlacement(DEVICE, T)).resolves.toEqual({ siteId: null });
    strict.onModuleDestroy();
    skipping.onModuleDestroy();
  });
});
