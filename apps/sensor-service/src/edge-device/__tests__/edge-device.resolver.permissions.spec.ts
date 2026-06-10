import 'reflect-metadata';

import { REQUIRED_TENANT_PERMISSIONS_KEY } from '@aquaculture/backend-common/decorators';

import { EdgeDeviceResolver } from '../edge-device.resolver';

describe('EdgeDeviceResolver tenant permissions', () => {
  it.each([
    'addDeviceIoConfig',
    'updateDeviceIoConfig',
    'removeDeviceIoConfig',
    'pushIoConfigToDevice',
    'bulkAddDeviceIoConfigs',
  ])('%s requires edge:manage-io-config', (methodName) => {
    const handler = EdgeDeviceResolver.prototype[
      methodName as keyof EdgeDeviceResolver
    ] as object;

    expect(Reflect.getMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, handler)).toEqual([
      'edge:manage-io-config',
    ]);
  });
});
