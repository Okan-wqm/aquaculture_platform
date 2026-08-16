import {
  RATE_LIMIT_CONFIG_KEY,
  type RateLimitRouteConfig,
} from '@aquaculture/backend-common/rate-limit';

import { UsersController } from '../users.controller';

describe('UsersController sensitive mutation limits', () => {
  it('pins direct password reset to the distributed sensitive policy', () => {
    const metadata = Reflect.getMetadata(
      RATE_LIMIT_CONFIG_KEY,
      UsersController.prototype.resetUserPassword,
    ) as RateLimitRouteConfig | undefined;

    expect(metadata).toMatchObject({
      name: 'admin-sensitive',
      limit: 3,
      windowMs: 300_000,
      requiresDistributedStore: true,
    });
  });
});
