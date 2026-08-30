import { SiteScopeCaller } from '@aquaculture/backend-common/security';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { Role, Roles } from '@aquaculture/backend-common/decorators';
import {
  All,
  BadGatewayException,
  Body,
  Controller,
  Get,
  GoneException,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CDSE_MAX_IMAGE_BYTES } from '../weather/services/cdse-sentinel.provider';
import { EnvironmentMonitoringGate } from '../weather/services/environment-monitoring-gate.service';

import { MarineCachePolicy, MarineCacheSubject } from './marine-cache.policy';
import {
  MarineDataService,
  MarineBinaryResponse,
  MarineRenderSaturatedException,
} from './marine-data.service';
import { MarineRenderDto } from './marine-data.dto';

export type MarineTenantRequest = Pick<
  TenantRequest,
  'verifiedIdentity' | 'verifiedUserAssertion'
>;

export interface MarineHttpResponse {
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  status(statusCode: number): MarineHttpResponse;
  setHeader(name: string, value: string | number | readonly string[]): MarineHttpResponse;
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(error?: Error): MarineHttpResponse;
  once<TArgs extends readonly unknown[]>(
    event: string,
    listener: (...args: TArgs) => void,
  ): MarineHttpResponse;
  off<TArgs extends readonly unknown[]>(
    event: string,
    listener: (...args: TArgs) => void,
  ): MarineHttpResponse;
}

export type MarineRenderer = Pick<MarineDataService, 'render'>;
export type MarineMonitoringGate = Pick<EnvironmentMonitoringGate, 'assertEnabled'>;

export const FARM_INTERNAL_MARINE_CONTROLLER_PATH = 'api/internal/marine';
export const FARM_INTERNAL_MARINE_PREFIX_EXCLUSIONS = [
  FARM_INTERNAL_MARINE_CONTROLLER_PATH,
  `${FARM_INTERNAL_MARINE_CONTROLLER_PATH}/(.*)`,
] as const;

@Controller(FARM_INTERNAL_MARINE_CONTROLLER_PATH)
@UseGuards(JwtAuthGuard)
@Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
export class MarineDataController {
  constructor(
    @Inject(MarineDataService)
    private readonly marineDataService: MarineRenderer,
    private readonly marineCachePolicy: MarineCachePolicy,
    @Inject(EnvironmentMonitoringGate)
    private readonly monitoringGate: MarineMonitoringGate,
  ) {}

  @Get('sites/:siteId/tiles/:layerId/:z/:x/:y.png')
  getTile(): never {
    throw new GoneException(
      'XYZ satellite tiles were retired because CDSE renders the authorized site area. Use the site render endpoint.',
    );
  }

  @Post('sites/:siteId/point-query')
  getPoint(): never {
    throw new GoneException(
      'Point sampling was retired because site model values are available through the site environment contract.',
    );
  }

  @Post('sites/:siteId/render')
  async render(
    @Param('siteId') siteId: string,
    @Body() body: MarineRenderDto,
    @Req() req: MarineTenantRequest,
    @Res() res: MarineHttpResponse,
  ): Promise<void> {
    this.monitoringGate.assertEnabled();
    const { tenantId, caller } = this.requestContext(req);
    const clientAbort = new AbortController();
    const handleClientClose = (): void => clientAbort.abort();
    res.once('close', handleClientClose);
    try {
      const upstream = await this.marineDataService.render({
        tenantId,
        caller,
        siteId,
        layerId: body.layerId,
        sceneId: body.sceneId,
        width: body.width,
        height: body.height,
        signal: clientAbort.signal,
      });
      if (clientAbort.signal.aborted) {
        upstream.dispose();
        return;
      }
      await this.streamBinary(res, upstream, 'render');
    } catch (error) {
      if (clientAbort.signal.aborted) {
        return;
      }
      if (error instanceof MarineRenderSaturatedException) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    } finally {
      res.off('close', handleClientClose);
    }
  }

  @All([
    'layers',
    'layers/:layerId/availability',
    'tiles/:layerId/:z/:x/:y.png',
    'point-query',
    'aoi-analysis',
  ])
  legacyEndpoint(): never {
    throw new GoneException(
      'This marine endpoint was retired. Use the site-bound environment contract.',
    );
  }

  private async streamBinary(
    res: MarineHttpResponse,
    upstream: MarineBinaryResponse,
    subject: MarineCacheSubject,
  ): Promise<void> {
    let disposed = false;
    let clientClosed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const dispose = (): void => {
      if (!disposed) {
        disposed = true;
        upstream.dispose();
      }
    };
    const handleClientClose = (): void => {
      clientClosed = true;
      dispose();
      if (reader) {
        void reader.cancel('Marine image client connection closed').catch(() => undefined);
      }
    };
    res.once('close', handleClientClose);
    try {
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.contentType);
      res.setHeader('X-Environment-Scene-Id', upstream.sceneId);
      res.setHeader('X-Environment-Valid-At', upstream.validAt.toISOString());
      if (upstream.contentLength !== null) {
        if (upstream.contentLength > CDSE_MAX_IMAGE_BYTES) {
          throw new BadGatewayException('Marine image response is too large');
        }
        res.setHeader('Content-Length', upstream.contentLength);
      }
      this.applyCacheHeaders(res, subject, upstream.status);

      const activeReader = upstream.body.getReader();
      reader = activeReader;
      let receivedBytes = 0;
      try {
        while (true) {
          const { done, value } = await activeReader.read();
          if (clientClosed) {
            throw new Error('Marine image client connection closed');
          }
          if (done) {
            break;
          }
          receivedBytes += value.byteLength;
          if (
            upstream.contentLength !== null &&
            receivedBytes > upstream.contentLength
          ) {
            void activeReader
              .cancel('Marine image response exceeded its declared byte length')
              .catch(() => undefined);
            const error = new BadGatewayException(
              'Marine image response exceeded its declared byte length',
            );
            if (res.headersSent) {
              res.destroy(error);
            }
            throw error;
          }
          if (receivedBytes > CDSE_MAX_IMAGE_BYTES) {
            void activeReader
              .cancel('Marine image response exceeded the byte limit')
              .catch(() => undefined);
            const error = new BadGatewayException('Marine image response is too large');
            if (res.headersSent) {
              res.destroy(error);
            }
            throw error;
          }
          if (!res.write(Buffer.from(value))) {
            await this.waitForDrainOrTermination(res, () => clientClosed);
          }
        }
        if (
          upstream.contentLength !== null &&
          receivedBytes !== upstream.contentLength
        ) {
          const error = new BadGatewayException(
            'Marine image response did not match its declared byte length',
          );
          if (res.headersSent) {
            res.destroy(error);
          }
          throw error;
        }
        if (clientClosed) {
          throw new Error('Marine image client connection closed');
        }
        res.end();
      } finally {
        try {
          activeReader.releaseLock();
        } catch {
          // Client-close cancellation can still own the pending read.
        }
        reader = null;
      }
    } finally {
      res.off('close', handleClientClose);
      dispose();
    }
  }

  private async waitForDrainOrTermination(
    res: MarineHttpResponse,
    isClientClosed: () => boolean,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        res.off('drain', handleDrain);
        res.off('error', handleError);
        res.off('close', handleClose);
      };
      const handleDrain = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const handleClose = (): void => {
        cleanup();
        reject(new Error('Marine image client connection closed'));
      };
      res.once('drain', handleDrain);
      res.once('error', handleError);
      res.once('close', handleClose);
      if (isClientClosed() || res.destroyed) {
        handleClose();
      }
    });
  }

  private applyCacheHeaders(
    res: MarineHttpResponse,
    subject: MarineCacheSubject,
    status?: number,
  ): void {
    const headers = this.marineCachePolicy.headersFor(subject, status);
    res.setHeader('Cache-Control', headers.cacheControl);
    res.setHeader('Vary', headers.vary.join(', '));
  }

  private requestContext(req: MarineTenantRequest): {
    tenantId: string;
    caller: SiteScopeCaller;
  } {
    const assertion = req.verifiedUserAssertion;
    const identity = req.verifiedIdentity;
    if (!assertion || identity?.serviceName !== 'gateway-api') {
      throw new UnauthorizedException('Verified gateway user assertion required');
    }
    const tenantId = assertion.effectiveTenantId;
    if (
      !tenantId ||
      identity.tenantId !== tenantId ||
      identity.effectiveTenantId !== tenantId
    ) {
      throw new UnauthorizedException('Verified gateway tenant scope is inconsistent');
    }
    return {
      tenantId,
      caller: {
        sub: assertion.subject,
        roles: assertion.roles as Role[],
        assignedSiteIds: assertion.assignedSiteIds,
      },
    };
  }
}
