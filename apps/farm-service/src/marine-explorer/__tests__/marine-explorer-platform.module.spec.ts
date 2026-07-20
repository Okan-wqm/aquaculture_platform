import { MODULE_METADATA } from '@nestjs/common/constants';

import { FarmStreamingResponseAdapter } from '../../common/http/farm-streaming-response.adapter';
import { MarineExplorerFeatureGate } from '../marine-explorer-feature-gate.service';
import { MarineExplorerPlatformModule } from '../marine-explorer-platform.module';

describe('MarineExplorerPlatformModule', () => {
  it('registers only inert platform prerequisites and no controllers', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      MarineExplorerPlatformModule,
    ) as unknown[] | undefined;
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      MarineExplorerPlatformModule,
    ) as unknown[] | undefined;

    expect(controllers ?? []).toEqual([]);
    expect(providers).toContain(MarineExplorerFeatureGate);
    expect(providers).toContain(FarmStreamingResponseAdapter);
  });
});
