import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';

import type { RequestWithEffectiveTenant } from '../middleware/effective-tenant.middleware';
import { MarineExplorerFeatureService } from './marine-explorer-feature.service';

@Controller('api/marine-explorer')
export class MarineExplorerCapabilityController {
  constructor(private readonly feature: MarineExplorerFeatureService) {}

  @Get('capabilities')
  async capabilities(@Req() request: RequestWithEffectiveTenant) {
    const tenantId = request.effectiveTenantId ?? request.user?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('A tenant context is required');
    }

    return {
      marineExplorer: {
        enabled: await this.feature.isEnabled(tenantId),
      },
    };
  }
}
