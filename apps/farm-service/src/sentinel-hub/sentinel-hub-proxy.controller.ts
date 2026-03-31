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
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { SentinelHubService } from './sentinel-hub.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

/**
 * SEC-C14: Sentinel Hub Backend Proxy Controller
 *
 * Proxies all Sentinel Hub API calls through the backend so that OAuth tokens
 * are NEVER exposed to the browser. This eliminates the XSS token exfiltration
 * attack surface described in finding C-14.
 *
 * Architecture:
 *   Browser -> farm-service proxy -> Sentinel Hub API (with server-side token)
 *
 * Each endpoint:
 *   1. Validates the user's JWT (via JwtAuthGuard from middleware pipeline)
 *   2. Extracts tenantId from the authenticated request
 *   3. Fetches the stored OAuth token for that tenant from the database
 *   4. Makes a server-side HTTP call to the Sentinel Hub API
 *   5. Streams the response back to the browser
 *
 * SECURITY: Tokens never leave the server. The browser only sees image/data responses.
 */

/** Request timeout for Sentinel Hub API calls (30 seconds) */
const PROXY_TIMEOUT_MS = 30_000;

/** Copernicus Data Space Ecosystem base URL */
const CDSE_BASE_URL = 'https://sh.dataspace.copernicus.eu';

/** Allowed WMTS layer IDs to prevent arbitrary path traversal */
const SAFE_LAYER_ID_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Extended request interface with tenant context set by middleware pipeline.
 * The tenantId is extracted from the verified JWT claim by TenantContextMiddleware.
 */
interface TenantRequest extends Request {
  tenantId?: string;
  user?: {
    sub: string;
    tenantId?: string;
    roles?: string[];
  };
}

@Controller('api/sentinel-hub')
@UseGuards(JwtAuthGuard)
export class SentinelHubProxyController {
  private readonly logger = new Logger(SentinelHubProxyController.name);

  constructor(
    private readonly sentinelHubService: SentinelHubService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Extract tenant ID from the request context.
   * Reads only from trusted, server-set sources (JWT claim or TenantGuard value).
   */
  private extractTenantId(req: TenantRequest): string {
    const tenantId = req.user?.tenantId || req.tenantId;
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
   * Proxies WMS/WMTS tile requests to Sentinel Hub.
   * The frontend provides tile parameters (bbox, width, height, etc.) as query params.
   * The backend injects the OAuth token server-side.
   *
   * @param layerId - The Sentinel Hub Configuration layer ID
   * @param req - Express request with tenant context from middleware
   * @param res - Express response for streaming the tile image
   */
  @Get('wms/:layerId')
  async proxyWmsTile(
    @Param('layerId') layerId: string,
    @Req() req: TenantRequest,
    @Res() res: Response,
  ): Promise<void> {
    const tenantId = this.extractTenantId(req);

    /** Validate layerId to prevent path traversal */
    if (!SAFE_LAYER_ID_REGEX.test(layerId)) {
      throw new BadRequestException('Invalid layer ID format');
    }

    try {
      const tokenResult = await this.sentinelHubService.getAccessToken(tenantId);
      if (!tokenResult) {
        throw new BadRequestException('Sentinel Hub is not configured for this tenant');
      }

      /** Build WMTS URL with the tenant's token injected server-side */
      const queryParams = new URLSearchParams(req.query as Record<string, string>);
      const wmtsUrl = `${CDSE_BASE_URL}/ogc/wms/${layerId}?${queryParams.toString()}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

      try {
        const response = await fetch(wmtsUrl, {
          headers: {
            Authorization: `Bearer ${tokenResult.accessToken}`,
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          this.logger.warn(
            `Sentinel Hub WMS returned ${response.status} for tenant ${tenantId}, layer ${layerId}`,
          );
          res.status(response.status).send('Sentinel Hub request failed');
          return;
        }

        /** Forward content type and cache headers */
        const contentType = response.headers.get('content-type');
        if (contentType) {
          res.setHeader('Content-Type', contentType);
        }
        res.setHeader('Cache-Control', 'public, max-age=3600');

        /** Stream the response body to the client */
        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);
      } catch (fetchError) {
        clearTimeout(timeout);
        throw fetchError;
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`WMS proxy error for tenant ${tenantId}: ${error}`);
      throw new InternalServerErrorException('Failed to proxy Sentinel Hub WMS request');
    }
  }

  /**
   * GET /api/sentinel-hub/process
   *
   * Proxies Processing API requests to Sentinel Hub.
   * Accepts evalscript and processing parameters as query params.
   * Used for water quality analysis layers (chlorophyll, turbidity, etc.).
   *
   * Query params: bbox, fromDate, toDate, width, height, evalscript, format
   */
  @Get('process')
  async proxyProcessingApi(
    @Query('bbox') bbox: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('width') width: string,
    @Query('height') height: string,
    @Query('evalscript') evalscript: string,
    @Req() req: TenantRequest,
    @Res() res: Response,
  ): Promise<void> {
    const tenantId = this.extractTenantId(req);

    /** Validate required parameters */
    if (!bbox || !fromDate || !toDate || !evalscript) {
      throw new BadRequestException('Missing required parameters: bbox, fromDate, toDate, evalscript');
    }

    try {
      const tokenResult = await this.sentinelHubService.getAccessToken(tenantId);
      if (!tokenResult) {
        throw new BadRequestException('Sentinel Hub is not configured for this tenant');
      }

      /** Parse bounding box coordinates */
      const bboxParts = bbox.split(',').map(Number);
      if (bboxParts.length !== 4 || bboxParts.some(isNaN)) {
        throw new BadRequestException('Invalid bbox format. Expected: minLon,minLat,maxLon,maxLat');
      }

      /** Build Processing API request body */
      const requestBody = {
        input: {
          bounds: {
            bbox: bboxParts,
            properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
          },
          data: [
            {
              type: 'sentinel-2-l2a',
              dataFilter: {
                timeRange: {
                  from: new Date(fromDate).toISOString(),
                  to: new Date(toDate).toISOString(),
                },
              },
            },
          ],
        },
        output: {
          width: parseInt(width, 10) || 512,
          height: parseInt(height, 10) || 512,
          responses: [{ identifier: 'default', format: { type: 'image/png' } }],
        },
        evalscript: decodeURIComponent(evalscript),
      };

      const processUrl = `${CDSE_BASE_URL}/api/v1/process`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

      try {
        const response = await fetch(processUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenResult.accessToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.warn(
            `Sentinel Hub Process returned ${response.status} for tenant ${tenantId}: ${errorText}`,
          );
          res.status(response.status).send('Sentinel Hub processing request failed');
          return;
        }

        /** Forward content type */
        const contentType = response.headers.get('content-type');
        if (contentType) {
          res.setHeader('Content-Type', contentType);
        }
        res.setHeader('Cache-Control', 'public, max-age=3600');

        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);
      } catch (fetchError) {
        clearTimeout(timeout);
        throw fetchError;
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Processing API proxy error for tenant ${tenantId}: ${error}`);
      throw new InternalServerErrorException('Failed to proxy Sentinel Hub processing request');
    }
  }

  /**
   * GET /api/sentinel-hub/catalog/search
   *
   * Proxies STAC catalog search requests to find available satellite imagery dates.
   * Used by the frontend date picker to show when imagery is available.
   *
   * Query params: bbox, fromDate, toDate, collections (comma-separated)
   */
  @Get('catalog/search')
  async proxyCatalogSearch(
    @Query('bbox') bbox: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('collections') collections: string,
    @Req() req: TenantRequest,
    @Res() res: Response,
  ): Promise<void> {
    const tenantId = this.extractTenantId(req);

    if (!bbox || !fromDate || !toDate) {
      throw new BadRequestException('Missing required parameters: bbox, fromDate, toDate');
    }

    try {
      const tokenResult = await this.sentinelHubService.getAccessToken(tenantId);
      if (!tokenResult) {
        throw new BadRequestException('Sentinel Hub is not configured for this tenant');
      }

      /** Parse bounding box */
      const bboxParts = bbox.split(',').map(Number);
      if (bboxParts.length !== 4 || bboxParts.some(isNaN)) {
        throw new BadRequestException('Invalid bbox format. Expected: minLon,minLat,maxLon,maxLat');
      }

      /** Build STAC catalog search request */
      const searchBody = {
        bbox: bboxParts,
        datetime: `${new Date(fromDate).toISOString()}/${new Date(toDate).toISOString()}`,
        collections: collections ? collections.split(',') : ['sentinel-2-l2a'],
        limit: 100,
      };

      const catalogUrl = `${CDSE_BASE_URL}/api/v1/catalog/1.0.0/search`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

      try {
        const response = await fetch(catalogUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenResult.accessToken}`,
          },
          body: JSON.stringify(searchBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.warn(
            `Sentinel Hub Catalog returned ${response.status} for tenant ${tenantId}: ${errorText}`,
          );
          res.status(response.status).json({ error: 'Catalog search failed' });
          return;
        }

        const data = await response.json();
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.json(data);
      } catch (fetchError) {
        clearTimeout(timeout);
        throw fetchError;
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Catalog proxy error for tenant ${tenantId}: ${error}`);
      throw new InternalServerErrorException('Failed to proxy Sentinel Hub catalog search');
    }
  }
}
