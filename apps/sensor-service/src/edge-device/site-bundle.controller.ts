import { Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';
import { Controller, Get, HttpStatus, Logger, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { SimpleRateLimitGuard, RateLimit } from '../guards/rate-limit.guard';

import { EdgeUpdateRequestService } from './edge-update-request.service';
import { PROVISIONING_REFUSAL_BODY } from './provisioning.controller';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The site bundle of a site-config update (ADR-048 DEC-4.12;
 * channels.json update_channel.carried_statements site-config.fetch).
 *
 * Root fetches the `suderra.site-bundle.v1` document from the URL the signed site
 * config names, on the platform API host the device's firewall allows, with no
 * credentials: the device presents nothing a platform could check. The document carries
 * no trust (root verifies every byte against the signed statement, so a substituted or
 * truncated one only fails the update) and no secret beyond the site's own
 * configuration, so access control is the shape of the request:
 *
 *   - the request id in the path is a random UUID the cloud chose before it signed the
 *     statement, so it is not guessable, and it is the only way to name a bundle;
 *   - the tenant in the path only selects the tenant's own boundary (the read runs
 *     inside it under row-level security): it grants nothing;
 *   - a bundle is served only while its request is open and inside the statement's
 *     window;
 *   - every other request — a malformed id, an unknown request, another tenant's, a
 *     window that is closed — gets the same answer, the one body provisioning refusals
 *     use (DEC-22): nothing here tells a caller which of those it hit. Rate limited.
 */
@Controller()
@Public()
@UseGuards(SimpleRateLimitGuard)
@SkipTenantGuard()
export class SiteBundleController {
  private readonly logger = new Logger(SiteBundleController.name);

  constructor(private readonly requests: EdgeUpdateRequestService) {}

  /** GET /api/devices/site-bundles/:tenantId/:requestId */
  @Get('api/devices/site-bundles/:tenantId/:requestId')
  @RateLimit({ limit: 30, windowMs: 60000 })
  async getSiteBundle(
    @Param('tenantId') tenantId: string,
    @Param('requestId') requestId: string,
    @Res() res: Response,
  ): Promise<void> {
    const bundle = await this.bundleOf(tenantId, requestId);
    res.setHeader('Cache-Control', 'no-store');
    if (bundle === null) {
      res.status(HttpStatus.NOT_FOUND).type('application/json').send(PROVISIONING_REFUSAL_BODY);
      return;
    }
    res.status(HttpStatus.OK).type('application/json').send(bundle);
  }

  private async bundleOf(tenantId: string, requestId: string): Promise<string | null> {
    if (!UUID.test(tenantId) || !UUID.test(requestId)) return null;
    try {
      return await this.requests.siteBundleOf(tenantId, requestId, new Date());
    } catch (error) {
      // An internal failure answers like an unknown request: the device retries inside its window.
      this.logger.error({
        event: 'site_bundle_read_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
