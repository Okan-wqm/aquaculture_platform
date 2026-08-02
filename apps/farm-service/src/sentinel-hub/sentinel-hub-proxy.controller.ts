import { Controller, Get, GoneException, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

export const RETIRED_SENTINEL_CONTROLLER_PATH = 'api/sentinel-hub';
export const RETIRED_SENTINEL_PREFIX_EXCLUSIONS = [
  RETIRED_SENTINEL_CONTROLLER_PATH,
  `${RETIRED_SENTINEL_CONTROLLER_PATH}/(.*)`,
] as const;

@Controller(RETIRED_SENTINEL_CONTROLLER_PATH)
@UseGuards(JwtAuthGuard)
export class SentinelHubProxyController {
  @Get(['wms/:layerId', 'process', 'catalog/search'])
  retiredBrowserProxy(): never {
    throw new GoneException(
      'The browser-directed Sentinel proxy is retired; use site-bound environment endpoints',
    );
  }
}
