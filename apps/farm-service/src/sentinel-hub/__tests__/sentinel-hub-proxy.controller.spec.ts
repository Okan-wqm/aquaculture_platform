import { GoneException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { SentinelHubProxyController } from '../sentinel-hub-proxy.controller';

describe('SentinelHubProxyController retired browser surface', () => {
  afterEach(() => jest.restoreAllMocks());

  it('pins every legacy browser route to an explicit HTTP 410 without an upstream call', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const controller = new SentinelHubProxyController();

    expect(() => controller.retiredBrowserProxy()).toThrow(GoneException);
    try {
      controller.retiredBrowserProxy();
    } catch (error) {
      expect(error).toBeInstanceOf(GoneException);
      expect((error as GoneException).getStatus()).toBe(410);
    }

    const paths = Reflect.getMetadata(
      PATH_METADATA,
      SentinelHubProxyController.prototype.retiredBrowserProxy,
    ) as string[];
    expect(paths).toEqual(['wms/:layerId', 'process', 'catalog/search']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
