import {
  All,
  BadGatewayException,
  Controller,
  Get,
  GoneException,
  Param,
  Post,
  Body,
  Req,
  Res,
  UnauthorizedException,
  Module,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildGatewayVerifiedUserAssertion,
  MARINE_BINARY_MAX_RESPONSE_BYTES,
  signedFetch,
} from '@aquaculture/backend-common/http';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../types';

type MarineProxyUser = Omit<AuthenticatedUser, 'tenantId'> & {
  /** Platform SUPER_ADMIN accounts intentionally have no home tenant. */
  readonly tenantId?: string | null;
  readonly mfaVerified?: boolean;
};

/**
 * Aggregate farm render deadline.
 *
 * A cache-cold exact-scene render can legitimately spend up to 5 seconds
 * resolving the company credential, 10 seconds obtaining an OAuth token, and
 * two bounded attempts for each of three 30-second CDSE requests (two
 * catalogue proofs plus the Processing request), including bounded
 * Retry-After delays. Keep this deadline above that complete farm-service
 * budget and below the edge-proxy deadline pinned by the deployment contract.
 */
export const MARINE_PROXY_REQUEST_TIMEOUT_MS = 210_000;
export const MARINE_PROXY_MAX_RESPONSE_BYTES = MARINE_BINARY_MAX_RESPONSE_BYTES;
export const GATEWAY_MARINE_CONTROLLER_PATH = 'api/marine';
export const GATEWAY_MARINE_PREFIX_EXCLUSIONS = [
  GATEWAY_MARINE_CONTROLLER_PATH,
  `${GATEWAY_MARINE_CONTROLLER_PATH}/(.*)`,
] as const;

export interface MarineProxyRequest {
  readonly headers: Request['headers'];
  readonly user?: MarineProxyUser;
  /** Authority-validated by EffectiveTenantMiddleware before this controller. */
  readonly effectiveTenantId?: string;
}

export interface MarineProxyResponse {
  readonly destroyed: boolean;
  readonly headersSent: boolean;
  status(statusCode: number): MarineProxyResponse;
  setHeader(name: string, value: number | string | readonly string[]): MarineProxyResponse;
  write(body: Buffer): boolean;
  end(): void;
  destroy(error?: Error): void;
  once(event: string, listener: (...args: unknown[]) => void): MarineProxyResponse;
  off(event: string, listener: (...args: unknown[]) => void): MarineProxyResponse;
}

@Controller(GATEWAY_MARINE_CONTROLLER_PATH)
export class MarineRoutesController {
  private readonly farmBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.farmBaseUrl = this.resolveFarmBaseUrl();
  }

  @Get('sites/:siteId/tiles/:layerId/:z/:x/:y.png')
  tile(): never {
    throw new GoneException(
      'XYZ satellite tiles were retired. Use the site-bound render endpoint.',
    );
  }

  @Post('sites/:siteId/point-query')
  pointQuery(): never {
    throw new GoneException('Point sampling was retired. Use the site environment contract.');
  }

  @Post('sites/:siteId/render')
  async render(
    @Param('siteId') siteId: string,
    @Body() body: unknown,
    @Req() req: MarineProxyRequest,
    @Res() res: MarineProxyResponse,
  ): Promise<void> {
    await this.proxy(
      req,
      res,
      'POST',
      `/api/internal/marine/sites/${encodeURIComponent(siteId)}/render`,
      body,
    );
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

  private async proxy(
    req: MarineProxyRequest,
    res: MarineProxyResponse,
    method: 'POST',
    internalPath: string,
    body?: unknown,
  ): Promise<void> {
    const user = this.requireUser(req);
    const homeTenantId = user.tenantId ?? null;
    const tenantId = this.requireEffectiveTenant(req, user);
    const assertion = buildGatewayVerifiedUserAssertion({
      subject: user.sub,
      tenantId: homeTenantId,
      effectiveTenantId: tenantId,
      roles: user.roles ?? [],
      email: user.email,
      mfaVerified: user.mfaVerified,
      assignedSiteIds: user.assignedSiteIds,
      mobileFeatures: user.mobileFeatures,
      resourcePermissions: user.resourcePermissions,
    });
    const bodyBytes = JSON.stringify(body ?? {});
    const targetUrl = `${this.farmBaseUrl}${internalPath}`;
    const controller = new AbortController();
    let clientClosed = false;
    let timedOut = false;
    const handleClientClose = (): void => {
      clientClosed = true;
      controller.abort();
    };
    res.once('close', handleClientClose);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MARINE_PROXY_REQUEST_TIMEOUT_MS);

    try {
      const response = await this.awaitAbortable(
        signedFetch(targetUrl, {
          method,
          headers: {
            Accept: req.headers.accept ?? '*/*',
            'Content-Type': 'application/json',
            'x-correlation-id': this.firstHeader(req.headers['x-correlation-id']),
            'x-verified-user-assertion': assertion,
          },
          body: bodyBytes,
          serviceName: 'gateway-api',
          tenantId,
          effectiveTenantId: tenantId,
          audience: 'farm',
          signal: controller.signal,
        }),
        controller.signal,
      );
      await this.streamBoundedResponse(response, res, controller.signal);
    } catch (error) {
      if (clientClosed) {
        return;
      }
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error('Marine proxy stream failed'));
        return;
      }
      if (error instanceof BadGatewayException) {
        throw error;
      }
      throw new BadGatewayException(
        timedOut ? 'farm-service marine proxy timed out' : 'farm-service marine proxy failed',
      );
    } finally {
      clearTimeout(timeout);
      res.off('close', handleClientClose);
      controller.abort();
    }
  }

  private async streamBoundedResponse(
    response: globalThis.Response,
    res: MarineProxyResponse,
    signal: AbortSignal,
  ): Promise<void> {
    let declaredLength: number | null;
    try {
      declaredLength = this.parseContentLength(response.headers.get('content-length'));
    } catch (error) {
      await this.cancelResponseBody(
        response.body,
        'Marine proxy response had an invalid byte length',
      );
      throw error;
    }
    if (declaredLength !== null && declaredLength > MARINE_PROXY_MAX_RESPONSE_BYTES) {
      await this.cancelResponseBody(response.body, 'Marine proxy response exceeded the byte limit');
      throw new BadGatewayException('farm-service marine response is too large');
    }
    if (!response.body) {
      if (declaredLength !== null && declaredLength !== 0) {
        throw new BadGatewayException('farm-service marine response body is incomplete');
      }
      this.applyUpstreamResponseMetadata(res, response, declaredLength);
      res.end();
      return;
    }

    this.applyUpstreamResponseMetadata(res, response, declaredLength);
    const reader = response.body.getReader();
    let receivedBytes = 0;
    let readerCancelled = false;
    try {
      while (true) {
        const chunk = await this.awaitAbortable(reader.read(), signal);
        if (chunk.done) {
          break;
        }
        const nextReceivedBytes = receivedBytes + chunk.value.byteLength;
        if (nextReceivedBytes > MARINE_PROXY_MAX_RESPONSE_BYTES) {
          await this.cancelReader(reader, 'Marine proxy response exceeded the byte limit');
          readerCancelled = true;
          throw new BadGatewayException('farm-service marine response is too large');
        }
        if (declaredLength !== null && nextReceivedBytes > declaredLength) {
          await this.cancelReader(
            reader,
            'Marine proxy response exceeded its declared byte length',
          );
          readerCancelled = true;
          throw new BadGatewayException('farm-service marine response body length is invalid');
        }
        receivedBytes = nextReceivedBytes;
        if (!res.write(Buffer.from(chunk.value))) {
          await this.waitForDrainOrAbort(res, signal);
        }
      }
      if (declaredLength !== null && receivedBytes !== declaredLength) {
        await this.cancelReader(reader, 'Marine proxy response body was incomplete');
        readerCancelled = true;
        throw new BadGatewayException('farm-service marine response body is incomplete');
      }
      res.end();
    } catch (error) {
      if (!readerCancelled) {
        await this.cancelReader(reader, 'Marine proxy response read failed');
      }
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Cancellation owns the locked reader until its pending read settles.
      }
    }
  }

  private applyUpstreamResponseMetadata(
    res: MarineProxyResponse,
    response: globalThis.Response,
    contentLength: number | null,
  ): void {
    res.status(response.status);
    const forwardedHeaders = [
      ['Content-Type', response.headers.get('content-type')],
      ['Cache-Control', response.headers.get('cache-control')],
      ['Vary', response.headers.get('vary')],
      ['Retry-After', response.headers.get('retry-after')],
      ['X-Environment-Scene-Id', response.headers.get('x-environment-scene-id')],
      ['X-Environment-Valid-At', response.headers.get('x-environment-valid-at')],
    ] as const;
    for (const [name, value] of forwardedHeaders) {
      if (value) {
        res.setHeader(name, value);
      }
    }
    if (contentLength !== null) {
      res.setHeader('Content-Length', contentLength);
    }
  }

  private async waitForDrainOrAbort(res: MarineProxyResponse, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        res.off('drain', handleDrain);
        res.off('error', handleError);
        res.off('close', handleClose);
        signal.removeEventListener('abort', handleAbort);
      };
      const handleDrain = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (error: unknown): void => {
        cleanup();
        reject(error instanceof Error ? error : new Error('Marine proxy response failed'));
      };
      const handleClose = (): void => {
        cleanup();
        reject(new Error('Marine proxy client connection closed'));
      };
      const handleAbort = (): void => {
        cleanup();
        reject(new Error('Marine proxy operation aborted'));
      };

      res.once('drain', handleDrain);
      res.once('error', handleError);
      res.once('close', handleClose);
      signal.addEventListener('abort', handleAbort, { once: true });
      if (signal.aborted || res.destroyed) {
        handleAbort();
      }
    });
  }

  private parseContentLength(value: string | null): number | null {
    if (value === null) {
      return null;
    }
    if (!/^\d+$/u.test(value)) {
      throw new BadGatewayException('farm-service marine response has an invalid byte length');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new BadGatewayException('farm-service marine response has an invalid byte length');
    }
    return parsed;
  }

  private async cancelResponseBody(
    body: ReadableStream<Uint8Array> | null,
    reason: string,
  ): Promise<void> {
    if (!body) {
      return;
    }
    try {
      await body.cancel(reason);
    } catch {
      // Protocol validation remains authoritative if upstream cancellation also fails.
    }
  }

  private async cancelReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    reason: string,
  ): Promise<void> {
    try {
      await reader.cancel(reason);
    } catch {
      // Preserve the original stream/protocol failure after best-effort cancellation.
    }
  }

  private async awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw new Error('Operation aborted');
    }
    return new Promise<T>((resolve, reject) => {
      const handleAbort = (): void => {
        signal.removeEventListener('abort', handleAbort);
        reject(new Error('Operation aborted'));
      };
      signal.addEventListener('abort', handleAbort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener('abort', handleAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', handleAbort);
          reject(
            error instanceof Error
              ? error
              : new Error('Marine proxy operation rejected without an Error'),
          );
        },
      );
      if (signal.aborted) {
        handleAbort();
      }
    });
  }

  private requireUser(req: MarineProxyRequest): MarineProxyUser {
    const user = req.user;
    if (!user?.sub) {
      throw new UnauthorizedException('Authentication required');
    }
    return user;
  }

  private requireEffectiveTenant(req: MarineProxyRequest, user: MarineProxyUser): string {
    const effectiveTenantId = req.effectiveTenantId ?? user.tenantId ?? undefined;
    if (!effectiveTenantId) {
      throw new UnauthorizedException('A validated tenant context is required');
    }

    const isSuperAdmin = user.roles?.includes('SUPER_ADMIN') ?? false;
    if (!isSuperAdmin && user.tenantId !== effectiveTenantId) {
      throw new UnauthorizedException('Tenant context does not match authenticated user');
    }
    return effectiveTenantId;
  }

  private firstHeader(value: string | string[] | undefined): string {
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
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
