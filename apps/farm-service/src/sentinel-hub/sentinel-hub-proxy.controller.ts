import type { TenantRequest } from '@aquaculture/backend-common/types';
import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response as ExpressResponse } from 'express';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

import { buildSentinelProcessBody } from './sentinel-process-request.factory';
import { SentinelHubService } from './sentinel-hub.service';
import { SentinelProxyPolicy } from './sentinel-proxy.policy';

/** Request timeout for Sentinel Hub API calls (30 seconds). */
const PROXY_TIMEOUT_MS = 30_000;

/** Copernicus Data Space Ecosystem base URL. */
const CDSE_BASE_URL = 'https://sh.dataspace.copernicus.eu';

type QueryValue = string | string[] | undefined;

type SentinelTenantRequest = TenantRequest & Request;

@Controller('api/sentinel-hub')
@UseGuards(JwtAuthGuard)
export class SentinelHubProxyController {
  private readonly logger = new Logger(SentinelHubProxyController.name);

  constructor(
    private readonly sentinelHubService: SentinelHubService,
    private readonly policy: SentinelProxyPolicy,
  ) {}

  /**
   * Extract tenant ID from the request context.
   * Reads only from trusted, server-set sources (verified assertion/JWT/tenant middleware).
   */
  private extractTenantId(req: SentinelTenantRequest): string {
    const tenantId = req.verifiedUserAssertion?.effectiveTenantId ?? req.user?.tenantId ?? req.tenantId;
    if (!tenantId) {
      throw new BadRequestException(
        'Tenant ID not found in request context. Ensure authentication is configured.',
      );
    }
    return tenantId;
  }

  /**
   * GET /api/sentinel-hub/wms/:layerId
   *
   * Proxies WMS/WMTS tile requests to Sentinel Hub. The proxy accepts only
   * a small allowlisted parameter set and injects OAuth tokens server-side.
   */
  @Get('wms/:layerId')
  async proxyWmsTile(
    @Param('layerId') layerId: string,
    @Req() req: SentinelTenantRequest,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const tenantId = this.extractTenantId(req);
    const requestPolicy = this.policy.validateWmsRequest(layerId, req.query);

    try {
      const tokenResult = await this.sentinelHubService.getAccessToken(tenantId);
      if (!tokenResult) {
        throw new BadRequestException('Sentinel Hub is not configured for this tenant');
      }

      const wmtsUrl = `${CDSE_BASE_URL}/ogc/wms/${layerId}?${requestPolicy.queryParams.toString()}`;
      const response = await this.fetchWithTimeout(wmtsUrl, {
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Sentinel Hub WMS returned ${response.status} for tenant ${tenantId}, layer ${layerId}`,
        );
        res.status(response.status).send('Sentinel Hub request failed');
        return;
      }

      this.policy.assertImageResponse(
        response.headers.get('content-type'),
        response.headers.get('content-length'),
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      this.policy.assertResponseBytes(buffer.byteLength);

      const contentType = response.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(buffer);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`WMS proxy error for tenant ${tenantId}: ${error}`);
      throw new InternalServerErrorException('Failed to proxy Sentinel Hub WMS request');
    }
  }

  /**
   * GET /api/sentinel-hub/process
   *
   * Proxies Processing API requests. Clients choose a named product; the
   * server chooses evalscript and collection from SentinelProxyPolicy.
   */
  @Get('process')
  async proxyProcessingApi(
    @Query('bbox') bbox: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('width') width: string,
    @Query('height') height: string,
    @Query('product') product: string,
    @Req() req: SentinelTenantRequest,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const tenantId = this.extractTenantId(req);
    const requestPolicy = this.policy.validateProcessRequest({
      bbox,
      fromDate,
      toDate,
      width,
      height,
      product,
      evalscript: this.firstQueryValue(req.query.evalscript as QueryValue),
      collection: this.firstQueryValue(req.query.collection as QueryValue),
    });

    try {
      const tokenResult = await this.sentinelHubService.getAccessToken(tenantId);
      if (!tokenResult) {
        throw new BadRequestException('Sentinel Hub is not configured for this tenant');
      }

      const response = await this.fetchWithTimeout(`${CDSE_BASE_URL}/api/v1/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenResult.accessToken}`,
        },
        body: buildSentinelProcessBody(requestPolicy),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(
          `Sentinel Hub Process returned ${response.status} for tenant ${tenantId}: ${errorText}`,
        );
        res.status(response.status).send('Sentinel Hub processing request failed');
        return;
      }

      this.policy.assertImageResponse(
        response.headers.get('content-type'),
        response.headers.get('content-length'),
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      this.policy.assertResponseBytes(buffer.byteLength);

      const contentType = response.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(buffer);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Processing API proxy error for tenant ${tenantId}: ${error}`);
      throw new InternalServerErrorException('Failed to proxy Sentinel Hub processing request');
    }
  }

  /**
   * GET /api/sentinel-hub/catalog/search
   *
   * Proxies STAC catalog search with bbox/date/collection allowlists.
   */
  @Get('catalog/search')
  async proxyCatalogSearch(
    @Query('bbox') bbox: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('collections') collections: string,
    @Req() req: SentinelTenantRequest,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const tenantId = this.extractTenantId(req);
    const requestPolicy = this.policy.validateCatalogRequest({
      bbox,
      fromDate,
      toDate,
      collections,
    });

    try {
      const tokenResult = await this.sentinelHubService.getAccessToken(tenantId);
      if (!tokenResult) {
        throw new BadRequestException('Sentinel Hub is not configured for this tenant');
      }

      const response = await this.fetchWithTimeout(`${CDSE_BASE_URL}/api/v1/catalog/1.0.0/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenResult.accessToken}`,
        },
        body: JSON.stringify({
          bbox: requestPolicy.bbox,
          datetime: requestPolicy.datetime,
          collections: requestPolicy.collections,
          limit: requestPolicy.limit,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(
          `Sentinel Hub Catalog returned ${response.status} for tenant ${tenantId}: ${errorText}`,
        );
        res.status(response.status).json({ error: 'Catalog search failed' });
        return;
      }

      this.policy.assertJsonResponse(
        response.headers.get('content-type'),
        response.headers.get('content-length'),
      );
      const data = await response.json();
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.json(data);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Catalog proxy error for tenant ${tenantId}: ${error}`);
      throw new InternalServerErrorException('Failed to proxy Sentinel Hub catalog search');
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private firstQueryValue(value: QueryValue): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
  }
}
