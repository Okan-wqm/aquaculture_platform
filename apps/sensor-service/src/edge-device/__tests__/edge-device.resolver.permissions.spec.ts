import 'reflect-metadata';

import { REQUIRED_TENANT_PERMISSIONS_KEY } from '@aquaculture/backend-common/decorators';
import {
  EDGE_DEVICE_IO_CONFIG_CAPABILITY,
  isTenantCapability,
} from '@aquaculture/shared-contracts';

import { EdgeDeviceResolver } from '../edge-device.resolver';

/**
 * RBAC-MEDIUM-026: the six edge-device I/O mutations require the catalogue capability
 * `edge_devices:manage_io_config`. They required `edge:manage-io-config`, which the catalogue did
 * not declare, so the grant authority refused it and no MODULE_MANAGER could ever hold it — only
 * the account roles, which bypass, could configure device I/O or drive a digital output.
 */
describe('EdgeDeviceResolver tenant permissions', () => {
  it('names a capability the role editor can grant', () => {
    expect(EDGE_DEVICE_IO_CONFIG_CAPABILITY).toBe('edge_devices:manage_io_config');
    expect(isTenantCapability(EDGE_DEVICE_IO_CONFIG_CAPABILITY)).toBe(true);
  });

  it.each([
    'addDeviceIoConfig',
    'updateDeviceIoConfig',
    'removeDeviceIoConfig',
    'pushIoConfigToDevice',
    'setDigitalOutput',
    'bulkAddDeviceIoConfigs',
  ])('%s requires edge_devices:manage_io_config', (methodName) => {
    const handler = EdgeDeviceResolver.prototype[methodName as keyof EdgeDeviceResolver] as object;

    expect(Reflect.getMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, handler)).toEqual([
      'edge_devices:manage_io_config',
    ]);
  });
});
