import { EventEmitter } from 'node:events';

import { ROLES_KEY, Role } from '@aquaculture/backend-common/decorators';
import { BadGatewayException, GoneException } from '@nestjs/common';

import { CDSE_MAX_IMAGE_BYTES } from '../../weather/services/cdse-sentinel.provider';
import { MarineCachePolicy } from '../marine-cache.policy';
import {
  MarineDataController,
  type MarineHttpResponse,
  type MarineTenantRequest,
} from '../marine-data.controller';
import {
  MARINE_RENDER_RETRY_AFTER_SECONDS,
  MarineBinaryResponse,
  MarineRenderSaturatedException,
} from '../marine-data.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VALID_AT = new Date('2026-07-30T10:25:59.000Z');

function request(): MarineTenantRequest {
  return {
    verifiedIdentity: {
      serviceName: 'gateway-api',
      tenantId: TENANT_ID,
      effectiveTenantId: TENANT_ID,
      keyId: 'test-kid',
      audience: 'farm',
      nonce: 'nonce-1',
      version: 'v2',
    },
    verifiedUserAssertion: {
      issuer: 'gateway-api',
      subject: 'user-1',
      tenantId: TENANT_ID,
      effectiveTenantId: TENANT_ID,
      roles: ['MODULE_USER'],
      email: 'user@example.test',
      mfaVerified: true,
      issuedAt: new Date().toISOString(),
      assignedSiteIds: [SITE_ID],
    },
  };
}

class TestMarineResponse implements MarineHttpResponse {
  private readonly events = new EventEmitter();
  headersSent = false;
  destroyed = false;

  readonly status = jest.fn((_statusCode: number): MarineHttpResponse => this);
  readonly setHeader = jest.fn(
    (_name: string, _value: string | number | readonly string[]): MarineHttpResponse => this,
  );
  readonly write = jest.fn((_chunk: Buffer): boolean => {
    this.headersSent = true;
    return true;
  });
  readonly end = jest.fn((): void => {
    this.headersSent = true;
  });
  readonly destroy = jest.fn((_error?: Error): MarineHttpResponse => {
    this.destroyed = true;
    return this;
  });

  once<TArgs extends readonly unknown[]>(
    event: string,
    listener: (...args: TArgs) => void,
  ): MarineHttpResponse {
    this.events.once(event, listener);
    return this;
  }

  off<TArgs extends readonly unknown[]>(
    event: string,
    listener: (...args: TArgs) => void,
  ): MarineHttpResponse {
    this.events.off(event, listener);
    return this;
  }

  emit(event: string, ...args: readonly unknown[]): boolean {
    return this.events.emit(event, ...args);
  }

  listenerCount(event: string): number {
    return this.events.listenerCount(event);
  }
}

function response(): {
  res: TestMarineResponse;
  status: jest.Mock;
  setHeader: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  destroy: jest.Mock;
} {
  const res = new TestMarineResponse();
  return {
    res,
    status: res.status,
    setHeader: res.setHeader,
    write: res.write,
    end: res.end,
    destroy: res.destroy,
  };
}

describe('MarineDataController site-bound contract', () => {
  let service: {
    render: jest.Mock;
  };
  let gate: { assertEnabled: jest.Mock };
  let controller: MarineDataController;

  beforeEach(() => {
    service = {
      render: jest.fn(),
    };
    gate = { assertEnabled: jest.fn() };
    controller = new MarineDataController(service, new MarineCachePolicy(), gate);
  });

  it('requires a canonical farm-module role in addition to site assignment', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MarineDataController)).toEqual([
      Role.TENANT_ADMIN,
      Role.MODULE_MANAGER,
      Role.MODULE_USER,
    ]);
  });

  it('retires the XYZ route without any provider-facing service call', () => {
    expect(() => controller.getTile()).toThrow(GoneException);
    expect(gate.assertEnabled).not.toHaveBeenCalled();
    expect(service.render).not.toHaveBeenCalled();
  });

  it('retires misleading point sampling without any provider-facing service call', () => {
    expect(() => controller.getPoint()).toThrow(GoneException);
    expect(gate.assertEnabled).not.toHaveBeenCalled();
    expect(service.render).not.toHaveBeenCalled();
  });

  it('sets Retry-After before propagating bounded render saturation', async () => {
    service.render.mockRejectedValueOnce(new MarineRenderSaturatedException());
    const target = response();

    await expect(
      controller.render(
        SITE_ID,
        {
          layerId: 'sentinel:natural-color',
          sceneId: 'scene-1',
          width: 512,
          height: 512,
        },
        request(),
        target.res,
      ),
    ).rejects.toBeInstanceOf(MarineRenderSaturatedException);

    expect(target.setHeader).toHaveBeenCalledWith(
      'Retry-After',
      String(MARINE_RENDER_RETRY_AFTER_SECONDS),
    );
  });

  it('streams an exact site-area render without buffering and forwards the signed site scope', async () => {
    const dispose = jest.fn();
    const upstream: MarineBinaryResponse = {
      status: 200,
      contentType: 'image/png',
      contentLength: 3,
      sceneId: 'scene-1',
      validAt: VALID_AT,
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1, 2, 3]));
          streamController.close();
        },
      }),
      dispose,
    };
    service.render.mockResolvedValue(upstream);
    const target = response();

    await controller.render(
      SITE_ID,
      {
        layerId: 'sentinel:natural-color',
        sceneId: 'scene-1',
        width: 512,
        height: 512,
      },
      request(),
      target.res,
    );

    expect(gate.assertEnabled).toHaveBeenCalledTimes(1);
    expect(service.render).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        caller: {
          sub: 'user-1',
          roles: ['MODULE_USER'],
          assignedSiteIds: [SITE_ID],
        },
        siteId: SITE_ID,
        sceneId: 'scene-1',
      }),
    );
    expect(target.write).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(target.end).toHaveBeenCalledTimes(1);
    expect(target.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(target.setHeader).toHaveBeenCalledWith('X-Environment-Scene-Id', 'scene-1');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('cancels the upstream and releases a backpressure wait when the client closes', async () => {
    const dispose = jest.fn();
    service.render.mockResolvedValue({
      status: 200,
      contentType: 'image/png',
      contentLength: 3,
      sceneId: 'scene-1',
      validAt: VALID_AT,
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1, 2, 3]));
          streamController.close();
        },
      }),
      dispose,
    } satisfies MarineBinaryResponse);
    const target = response();
    target.write.mockReturnValue(false);

    const rendering = controller.render(
      SITE_ID,
      {
        layerId: 'sentinel:natural-color',
        sceneId: 'scene-1',
        width: 512,
        height: 512,
      },
      request(),
      target.res,
    );
    for (let attempt = 0; attempt < 10 && target.write.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(target.write).toHaveBeenCalledTimes(1);
    target.res.emit('close');
    await expect(rendering).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(target.end).not.toHaveBeenCalled();
    expect(target.res.listenerCount('drain')).toBe(0);
    expect(target.res.listenerCount('error')).toBe(0);
    expect(target.res.listenerCount('close')).toBe(0);
  });

  it('terminates a stream that exceeds its declared Content-Length', async () => {
    const dispose = jest.fn();
    service.render.mockResolvedValue({
      status: 200,
      contentType: 'image/png',
      contentLength: 3,
      sceneId: 'scene-1',
      validAt: VALID_AT,
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1, 2]));
          streamController.enqueue(new Uint8Array([3, 4]));
          streamController.close();
        },
      }),
      dispose,
    } satisfies MarineBinaryResponse);
    const target = response();

    await expect(
      controller.render(
        SITE_ID,
        {
          layerId: 'sentinel:natural-color',
          sceneId: 'scene-1',
          width: 512,
          height: 512,
        },
        request(),
        target.res,
      ),
    ).rejects.toThrow(BadGatewayException);

    expect(target.write).toHaveBeenCalledTimes(1);
    expect(target.destroy).toHaveBeenCalledTimes(1);
    expect(target.end).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('terminates a truncated stream before presenting it as a complete image', async () => {
    const dispose = jest.fn();
    service.render.mockResolvedValue({
      status: 200,
      contentType: 'image/png',
      contentLength: 4,
      sceneId: 'scene-1',
      validAt: VALID_AT,
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1, 2, 3]));
          streamController.close();
        },
      }),
      dispose,
    } satisfies MarineBinaryResponse);
    const target = response();

    await expect(
      controller.render(
        SITE_ID,
        {
          layerId: 'sentinel:natural-color',
          sceneId: 'scene-1',
          width: 512,
          height: 512,
        },
        request(),
        target.res,
      ),
    ).rejects.toThrow(BadGatewayException);

    expect(target.write).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(target.destroy).toHaveBeenCalledTimes(1);
    expect(target.end).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('destroys a partially written chunked response that exceeds the absolute byte limit', async () => {
    const dispose = jest.fn();
    service.render.mockResolvedValue({
      status: 200,
      contentType: 'image/png',
      contentLength: null,
      sceneId: 'scene-1',
      validAt: VALID_AT,
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1]));
          streamController.enqueue(new Uint8Array(CDSE_MAX_IMAGE_BYTES));
          streamController.close();
        },
      }),
      dispose,
    } satisfies MarineBinaryResponse);
    const target = response();

    await expect(
      controller.render(
        SITE_ID,
        {
          layerId: 'sentinel:natural-color',
          sceneId: 'scene-1',
          width: 512,
          height: 512,
        },
        request(),
        target.res,
      ),
    ).rejects.toThrow(BadGatewayException);

    expect(target.write).toHaveBeenCalledTimes(1);
    expect(target.destroy).toHaveBeenCalledTimes(1);
    expect(target.end).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts provider work when the client closes before an upstream response exists', async () => {
    const target = response();
    service.render.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<MarineBinaryResponse>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('provider cancelled')), {
            once: true,
          });
        }),
    );

    const rendering = controller.render(
      SITE_ID,
      {
        layerId: 'sentinel:natural-color',
        sceneId: 'scene-1',
        width: 512,
        height: 512,
      },
      request(),
      target.res,
    );
    for (let attempt = 0; attempt < 10 && service.render.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const signal = service.render.mock.calls[0]![0].signal as AbortSignal;

    target.res.emit('close');

    await expect(rendering).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(target.write).not.toHaveBeenCalled();
    expect(target.end).not.toHaveBeenCalled();
    expect(target.res.listenerCount('close')).toBe(0);
  });

  it('retires arbitrary non-site-bound endpoints with HTTP 410 semantics', () => {
    expect(() => controller.legacyEndpoint()).toThrow(GoneException);
  });

  it('rejects a legacy req.user identity without a gateway-bound assertion', async () => {
    const target = response();
    const legacyRequest: MarineTenantRequest = {};

    await expect(
      controller.render(
        SITE_ID,
        {
          layerId: 'sentinel:natural-color',
          sceneId: 'scene-1',
          width: 512,
          height: 512,
        },
        legacyRequest,
        target.res,
      ),
    ).rejects.toThrow('Verified gateway user assertion required');
    expect(service.render).not.toHaveBeenCalled();
  });

  it('rejects an assertion carried by a signed non-gateway service', async () => {
    const target = response();
    const nonGatewayRequest = request();
    nonGatewayRequest.verifiedIdentity = {
      ...nonGatewayRequest.verifiedIdentity!,
      serviceName: 'config-service',
    };

    await expect(
      controller.render(
        SITE_ID,
        {
          layerId: 'sentinel:natural-color',
          sceneId: 'scene-1',
          width: 512,
          height: 512,
        },
        nonGatewayRequest,
        target.res,
      ),
    ).rejects.toThrow('Verified gateway user assertion required');
    expect(service.render).not.toHaveBeenCalled();
  });
});
