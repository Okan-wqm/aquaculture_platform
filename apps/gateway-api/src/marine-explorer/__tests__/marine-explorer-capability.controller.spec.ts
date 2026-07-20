import { ForbiddenException } from '@nestjs/common';

import type { RequestWithEffectiveTenant } from '../../middleware/effective-tenant.middleware';
import { MarineExplorerCapabilityController } from '../marine-explorer-capability.controller';
import { MarineExplorerFeatureService } from '../marine-explorer-feature.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('MarineExplorerCapabilityController', () => {
  it('projects only the evaluated boolean for the authenticated tenant', async () => {
    const feature = {
      isEnabled: jest.fn().mockResolvedValue(false),
    } as Partial<MarineExplorerFeatureService> as MarineExplorerFeatureService;
    const controller = new MarineExplorerCapabilityController(feature);
    const request = { effectiveTenantId: TENANT_ID } as RequestWithEffectiveTenant;

    await expect(controller.capabilities(request)).resolves.toEqual({
      marineExplorer: { enabled: false },
    });
    expect(feature.isEnabled).toHaveBeenCalledWith(TENANT_ID);
  });

  it('denies system scope without a tenant', async () => {
    const controller = new MarineExplorerCapabilityController({} as MarineExplorerFeatureService);
    await expect(controller.capabilities({} as RequestWithEffectiveTenant)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
