import {
  BadGatewayException,
  Controller,
  Get,
  Param,
  Post,
  Body,
  Query,
  Req,
  Res,
  UnauthorizedException,
  Module,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildGatewayVerifiedUserAssertion,
  signedFetch,
} from '@aquaculture/backend-common/http';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;

type QueryRecord = Record<string, string | number | boolean | undefined>;

export interface MarineProxyRequest {
  readonly headers: Request['headers'];
  readonly user?: AuthenticatedUser;
}

export interface MarineProxyResponse {
  status(statusCode: number): MarineProxyResponse;
  setHeader(name: string, value: number | string | readonly string[]): MarineProxyResponse;
  send(body: Buffer): MarineProxyResponse;
}

@Controller('api/marine')
export class MarineRoutesController {
  private readonly farmBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.farmBaseUrl = this.resolveFarmBaseUrl();
  }

  @Get('layers')
  async layers(@Req() req: MarineProxyRequest, @Res() res: MarineProxyResponse): Promise<void> {
    await this.proxy(req, res, 'GET', '/api/internal/marine/layers');
  }

  @Get('layers/:layerId/availability')
  async availability(
    @Param('layerId') layerId: string,
    @Query() query: QueryRecord,
    @Req() req: MarineProxyRequest,
    @Res() res: MarineProxyResponse,
  ): Promise<void> {
    await this.proxy(
      req,
      res,
      'GET',
      `/api/internal/marine/layers/${encodeURIComponent(layerId)}/availability`,
      undefined,
      query,
    );
  }

  @Get('tiles/:layerId/:z/:x/:y.png')
  async tile(
    @Param('layerId') layerId: string,
    @Param('z') z: string,
    @Param('x') x: string,
    @Param('y') y: string,
    @Query() query: QueryRecord,
    @Req() req: MarineProxyRequest,
    @Res() res: MarineProxyResponse,
  ): Promise<void> {
    await this.proxy(
      req,
      res,
      'GET',
      `/api/internal/marine/tiles/${encodeURIComponent(layerId)}/${encodeURIComponent(z)}/${encodeURIComponent(x)}/${encodeURIComponent(y)}.png`,
      undefined,
      query,
    );
  }

  @Post('point-query')
  async pointQuery(
    @Body() body: unknown,
    @Req() req: MarineProxyRequest,
    @Res() res: MarineProxyResponse,
  ): Promise<void> {
    await this.proxy(req, res, 'POST', '/api/internal/marine/point-query', body);
  }

  @Post('aoi-analysis')
  async aoiAnalysis(
    @Body() body: unknown,
    @Req() req: MarineProxyRequest,
    @Res() res: MarineProxyResponse,
  ): Promise<void> {
    await this.proxy(req, res, 'POST', '/api/internal/marine/aoi-analysis', body);
  }

  private async proxy(
    req: MarineProxyRequest,
    res: MarineProxyResponse,
    method: 'GET' | 'POST',
    internalPath: string,
    body?: unknown,
    query?: QueryRecord,
  ): Promise<void> {
    const user = this.requireUser(req);
    const tenantId = user.tenantId;
    const assertion = buildGatewayVerifiedUserAssertion({
      subject: user.sub,
      tenantId,
      effectiveTenantId: tenantId,
      roles: user.roles ?? [],
      email: user.email,
      assignedSiteIds: user.assignedSiteIds,
      mobileFeatures: user.mobileFeatures,
      resourcePermissions: user.resourcePermissions,
    });
    const queryString = this.buildQueryString(query);
    const bodyBytes = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const contentType = method === 'POST' ? 'application/json' : undefined;
    const targetUrl = `${this.farmBaseUrl}${internalPath}${queryString}`;
    const response = await this.fetchSigned(targetUrl, tenantId, {
      method,
      headers: {
        Accept: req.headers.accept ?? '*/*',
        ...(contentType ? { 'Content-Type': contentType } : {}),
        'x-correlation-id': this.firstHeader(req.headers['x-correlation-id']),
        'x-verified-user-assertion': assertion,
      },
      body: method === 'POST' ? bodyBytes : undefined,
    });

    const responseBody = Buffer.from(await response.arrayBuffer());
    res.status(response.status);
    const contentTypeHeader = response.headers.get('content-type');
    if (contentTypeHeader) {
      res.setHeader('Content-Type', contentTypeHeader);
    }
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) {
      res.setHeader('Cache-Control', cacheControl);
    }
    const vary = response.headers.get('vary');
    if (vary) {
      res.setHeader('Vary', vary);
    }
    res.send(responseBody);
  }

  private async fetchSigned(
    url: string,
    tenantId: string,
    init: RequestInit,
  ): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await signedFetch(url, {
        ...init,
        serviceName: 'gateway-api',
        tenantId,
        audience: 'farm',
        signal: controller.signal,
      });
    } catch (error) {
      throw new BadGatewayException(
        `farm-service marine proxy failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireUser(req: MarineProxyRequest): AuthenticatedUser {
    const user = req.user;
    if (!user?.sub || !user.tenantId) {
      throw new UnauthorizedException('Authentication required');
    }
    return user;
  }

  private buildQueryString(query: QueryRecord | undefined): string {
    if (!query) {
      return '';
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    const encoded = params.toString();
    return encoded ? `?${encoded}` : '';
  }

  private firstHeader(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] ?? '' : value ?? '';
  }

  private resolveFarmBaseUrl(): string {
    const configured =
      this.configService.get<string>('FARM_SERVICE_REST_URL') ??
      this.configService.get<string>('FARM_SERVICE_URL') ??
      'http://localhost:3002/graphql';
    return configured.replace(/\/graphql\/?$/, '').replace(/\/$/, '');
  }
}

@Module({
  controllers: [MarineRoutesController],
})
export class MarineRoutesModule {}
