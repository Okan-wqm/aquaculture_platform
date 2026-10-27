import { collaborator, stub } from '@aquaculture/testing';

import { EdgeDeviceNatsController } from '../edge-device-nats.controller';
import { EdgeDeviceService } from '../edge-device.service';
import type { EdgeDevice } from '../entities/edge-device.entity';

const T = '11111111-1111-4111-8111-111111111111';
const S9 = '33333333-3333-4333-8333-333333333339';
const DEVICE = 'PLC-01';

function controller(device: EdgeDevice | null): {
  responder: EdgeDeviceNatsController;
  findByCode: jest.Mock;
} {
  const findByCode = jest.fn().mockResolvedValue(device);
  const responder = new EdgeDeviceNatsController(
    collaborator<EdgeDeviceService>({ findByCode }, 'EdgeDeviceService'),
  );
  return { responder, findByCode };
}

/**
 * request.sensor.verifyDeviceOwnership answers with the device's site (SEC-CRITICAL-207): the
 * /sensors gateway admits a site-bound sensor operator to the edge I/O of its own sites only.
 */
describe('EdgeDeviceNatsController.verifyDeviceOwnership (SEC-CRITICAL-207)', () => {
  it('answers a device of the tenant with its site', async () => {
    const { responder, findByCode } = controller(stub<EdgeDevice>({ siteId: S9 }));

    await expect(
      responder.verifyDeviceOwnership({ deviceCode: DEVICE, tenantId: T }),
    ).resolves.toEqual({
      owned: true,
      siteId: S9,
    });
    expect(findByCode).toHaveBeenCalledWith(DEVICE, T);
  });

  it('answers a device placed on no site with a null site', async () => {
    const { responder } = controller(stub<EdgeDevice>({ siteId: undefined }));

    await expect(
      responder.verifyDeviceOwnership({ deviceCode: DEVICE, tenantId: T }),
    ).resolves.toEqual({
      owned: true,
      siteId: null,
    });
  });

  it.each([
    ['a device the tenant does not own', { deviceCode: DEVICE, tenantId: T }],
    ['a tenant that is no tenant id', { deviceCode: DEVICE, tenantId: 'tenant-1' }],
    ['a device code with a separator', { deviceCode: 'PLC:01', tenantId: T }],
  ])('answers %s as not owned', async (_case, request) => {
    const { responder } = controller(null);

    await expect(responder.verifyDeviceOwnership(request)).resolves.toEqual({
      owned: false,
      siteId: null,
    });
  });
});
