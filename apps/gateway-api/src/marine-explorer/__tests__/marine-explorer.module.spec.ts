import { MODULE_METADATA } from '@nestjs/common/constants';

import { SignedStreamingProxyService } from '../../proxy/signed-streaming-proxy.service';
import { MarineExplorerFeatureService } from '../marine-explorer-feature.service';
import { MarineExplorerModule } from '../marine-explorer.module';

describe('MarineExplorerModule', () => {
  it('registers the capability gate and inert streaming prerequisite', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MarineExplorerModule) as
      | unknown[]
      | undefined;

    expect(providers).toContain(MarineExplorerFeatureService);
    expect(providers).toContain(SignedStreamingProxyService);
  });
});
