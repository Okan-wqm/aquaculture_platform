import { EventEmitter } from 'node:events';

import {
  MARINE_BINARY_MAX_RESPONSE_BYTES,
  buildGatewayVerifiedUserAssertion,
  signedFetch,
} from '@aquaculture/backend-common/http';
import {
  BadGatewayException,
  GoneException,
  RequestMethod,
  UnauthorizedException,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';

import {
  GATEWAY_MARINE_CONTROLLER_PATH,
  GATEWAY_MARINE_PREFIX_EXCLUSIONS,
  MARINE_PROXY_MAX_RESPONSE_BYTES,
  MARINE_PROXY_REQUEST_TIMEOUT_MS,
  MarineRoutesController,
  type MarineProxyRequest,
  type MarineProxyResponse,
} from '../marine.routes';
import type { AuthenticatedUser } from '../../types';

jest.mock('@aquaculture/backend-common/http', () => {
  const actual = jest.requireActual<typeof import('@aquaculture/backend-common/http')>(
    '@aquaculture/backend-common/http',
  );
  return {
    ...actual,
    buildGatewayVerifiedUserAssertion: jest.fn(() => 'verified-user-assertion'),
    signedFetch: jest.fn(),
  };
});

const signedFetchMock = jest.mocked(signedFetch);
const buildAssertionMock = jest.mocked(buildGatewayVerifiedUserAssertion);

function makeController(): MarineRoutesController {
  return new MarineRoutesController(
    new ConfigService({
      FARM_SERVICE_REST_URL: 'http://farm-service:3000/graphql',
    }),
  );
}

function makeUser(): AuthenticatedUser {
  return {
    sub: 'user-1',
    email: 'user@example.test',
    tenantId: 'tenant-1',
    roles: ['TENANT_ADMIN'],
    assignedSiteIds: ['site-1'],
    mobileFeatures: ['offline-sync'],
    iat: 1,
    exp: 2,
  };
}

function makeRequest(
  user: MarineProxyRequest['user'] | null = makeUser(),
  effectiveTenantId?: string,
): MarineProxyRequest {
  return {
    headers: {
      accept: 'image/png',
      'x-correlation-id': 'corr-1',
    },
    user: user ?? undefined,
    effectiveTenantId,
  };
}

interface ResponseHarness {
  readonly response: MarineProxyResponse;
  readonly statusMock: jest.Mock<void, [number]>;
  readonly setHeaderMock: jest.Mock<void, [string, number | string | readonly string[]]>;
  readonly writeMock: jest.Mock<boolean, [Buffer]>;
  readonly endMock: jest.Mock<void, []>;
  readonly destroyMock: jest.Mock<void, [Error?]>;
  readonly emit: (event: string, ...args: unknown[]) => void;
  readonly listenerCount: (event: string) => number;
  readonly setWriteResult: (result: boolean) => void;
}

function makeResponse(): ResponseHarness {
  const events = new EventEmitter();
  const statusMock = jest.fn<void, [number]>();
  const setHeaderMock = jest.fn<void, [string, number | string | readonly string[]]>();
  let writeResult = true;
  let destroyed = false;
  let headersSent = false;
  const writeMock = jest.fn<boolean, [Buffer]>(() => {
    headersSent = true;
    return writeResult;
  });
  const endMock = jest.fn<void, []>(() => {
    headersSent = true;
  });
  const destroyMock = jest.fn<void, [Error?]>(() => {
    destroyed = true;
  });
  const response: MarineProxyResponse = {
    get destroyed() {
      return destroyed;
    },
    get headersSent() {
      return headersSent;
    },
    status(statusCode) {
      statusMock(statusCode);
      return response;
    },
    setHeader(name, value) {
      setHeaderMock(name, value);
      return response;
    },
    write(body) {
      return writeMock(body);
    },
    end() {
      endMock();
    },
    destroy(error) {
      destroyMock(error);
    },
    once(event, listener) {
      events.once(event, listener);
      return response;
    },
    off(event, listener) {
      events.off(event, listener);
      return response;
    },
  };
  return {
    response,
    statusMock,
    setHeaderMock,
    writeMock,
    endMock,
    destroyMock,
    emit: (event, ...args) => {
      events.emit(event, ...args);
    },
    listenerCount: (event) => events.listenerCount(event),
    setWriteResult: (result) => {
      writeResult = result;
    },
  };
}

function renderBody(): Record<string, string | number> {
  return {
    layerId: 'sentinel:natural-color',
    sceneId: 'scene-1',
    width: 1200,
    height: 675,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Expected asynchronous condition was not reached');
}

describe('MarineRoutesController', () => {
  beforeEach(() => {
    signedFetchMock.mockReset();
    buildAssertionMock.mockReset();
    buildAssertionMock.mockReturnValue('verified-user-assertion');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('owns the browser route, prefix exclusion, aggregate timeout, and render method contract', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MarineRoutesController)).toBe(
      GATEWAY_MARINE_CONTROLLER_PATH,
    );
    expect(GATEWAY_MARINE_PREFIX_EXCLUSIONS).toEqual([
      GATEWAY_MARINE_CONTROLLER_PATH,
      `${GATEWAY_MARINE_CONTROLLER_PATH}/(.*)`,
    ]);
    expect(MARINE_PROXY_REQUEST_TIMEOUT_MS).toBe(210_000);
    expect(Reflect.getMetadata(PATH_METADATA, MarineRoutesController.prototype.render)).toBe(
      'sites/:siteId/render',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, MarineRoutesController.prototype.render)).toBe(
      RequestMethod.POST,
    );
  });

  it('shares the 15 MiB response ceiling with the farm/CDSE binary contract', () => {
    expect(MARINE_PROXY_MAX_RESPONSE_BYTES).toBe(15 * 1024 * 1024);
    expect(MARINE_PROXY_MAX_RESPONSE_BYTES).toBe(MARINE_BINARY_MAX_RESPONSE_BYTES);
  });

  it('retires site XYZ tiles and point sampling without farm-service I/O', () => {
    const controller = makeController();

    expect(() => controller.tile()).toThrow(GoneException);
    expect(() => controller.pointQuery()).toThrow(GoneException);
    expect(buildAssertionMock).not.toHaveBeenCalled();
    expect(signedFetchMock).not.toHaveBeenCalled();
  });

  it('retires every arbitrary non-site-bound marine endpoint', () => {
    expect(() => makeController().legacyEndpoint()).toThrow(GoneException);
    expect(signedFetchMock).not.toHaveBeenCalled();
  });

  it('proxies an exact-scene site render and forwards only approved response metadata', async () => {
    const bytes = Buffer.from('rendered-png');
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(bytes.byteLength),
          'cache-control': 'private, no-store',
          vary: 'Authorization, Cookie',
          'x-environment-scene-id': 'scene-1',
          'x-environment-valid-at': '2026-06-20T10:00:00.000Z',
          'set-cookie': 'must-not-leak=true',
          connection: 'close',
        },
      }),
    );
    const target = makeResponse();

    await makeController().render(
      'site/with reserved characters',
      renderBody(),
      makeRequest(),
      target.response,
    );

    expect(signedFetchMock).toHaveBeenCalledWith(
      'http://farm-service:3000/api/internal/marine/sites/site%2Fwith%20reserved%20characters/render',
      expect.objectContaining({
        method: 'POST',
        serviceName: 'gateway-api',
        tenantId: 'tenant-1',
        audience: 'farm',
        body: JSON.stringify(renderBody()),
        headers: expect.objectContaining({
          Accept: 'image/png',
          'Content-Type': 'application/json',
          'x-correlation-id': 'corr-1',
          'x-verified-user-assertion': 'verified-user-assertion',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(buildAssertionMock).toHaveBeenCalledWith({
      subject: 'user-1',
      tenantId: 'tenant-1',
      effectiveTenantId: 'tenant-1',
      roles: ['TENANT_ADMIN'],
      email: 'user@example.test',
      mfaVerified: undefined,
      assignedSiteIds: ['site-1'],
      mobileFeatures: ['offline-sync'],
      resourcePermissions: undefined,
    });
    expect(target.statusMock).toHaveBeenCalledWith(200);
    expect(target.setHeaderMock).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(target.setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(target.setHeaderMock).toHaveBeenCalledWith('Vary', 'Authorization, Cookie');
    expect(target.setHeaderMock).toHaveBeenCalledWith('X-Environment-Scene-Id', 'scene-1');
    expect(target.setHeaderMock).toHaveBeenCalledWith(
      'X-Environment-Valid-At',
      '2026-06-20T10:00:00.000Z',
    );
    expect(target.setHeaderMock).toHaveBeenCalledWith('Content-Length', bytes.byteLength);
    expect(target.setHeaderMock).not.toHaveBeenCalledWith('Set-Cookie', expect.anything());
    expect(target.setHeaderMock).not.toHaveBeenCalledWith('Connection', expect.anything());
    expect(target.writeMock).toHaveBeenCalledWith(bytes);
    expect(target.endMock).toHaveBeenCalledTimes(1);
    expect(target.destroyMock).not.toHaveBeenCalled();
    expect(target.listenerCount('close')).toBe(0);
  });

  it('uses the validated effective tenant for a platform SUPER_ADMIN render', async () => {
    const bytes = Buffer.from('super-admin-render');
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(bytes.byteLength),
        },
      }),
    );
    const target = makeResponse();
    const platformAdmin: MarineProxyRequest['user'] = {
      sub: 'platform-admin',
      email: 'platform-admin@example.test',
      roles: ['SUPER_ADMIN'],
      mfaVerified: true,
      iat: 1,
      exp: 2,
    };

    await makeController().render(
      'site-1',
      renderBody(),
      makeRequest(platformAdmin, 'tenant-2'),
      target.response,
    );

    expect(buildAssertionMock).toHaveBeenCalledWith({
      subject: 'platform-admin',
      tenantId: null,
      effectiveTenantId: 'tenant-2',
      roles: ['SUPER_ADMIN'],
      email: 'platform-admin@example.test',
      mfaVerified: true,
      assignedSiteIds: undefined,
      mobileFeatures: undefined,
      resourcePermissions: undefined,
    });
    expect(signedFetchMock).toHaveBeenCalledWith(
      'http://farm-service:3000/api/internal/marine/sites/site-1/render',
      expect.objectContaining({
        tenantId: 'tenant-2',
        effectiveTenantId: 'tenant-2',
      }),
    );
    expect(target.endMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a platform SUPER_ADMIN render without a validated effective tenant', async () => {
    const platformAdmin: MarineProxyRequest['user'] = {
      sub: 'platform-admin',
      roles: ['SUPER_ADMIN'],
      mfaVerified: true,
      iat: 1,
      exp: 2,
    };

    await expect(
      makeController().render(
        'site-1',
        renderBody(),
        makeRequest(platformAdmin),
        makeResponse().response,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(signedFetchMock).not.toHaveBeenCalled();
  });

  it('forwards a bounded upstream saturation status and Retry-After contract', async () => {
    const bytes = Buffer.from(JSON.stringify({ message: 'Render capacity is busy' }));
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(bytes, {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'content-length': String(bytes.byteLength),
          'retry-after': '5',
        },
      }),
    );
    const target = makeResponse();

    await makeController().render('site-1', renderBody(), makeRequest(), target.response);

    expect(target.statusMock).toHaveBeenCalledWith(503);
    expect(target.setHeaderMock).toHaveBeenCalledWith('Retry-After', '5');
    expect(target.writeMock).toHaveBeenCalledWith(bytes);
    expect(target.endMock).toHaveBeenCalledTimes(1);
  });

  it.each(['-1', '1.5', '1e3', '12x', '9007199254740992'])(
    'rejects invalid Content-Length %s and cancels upstream before browser output',
    async (contentLength) => {
      const cancel = jest.fn<void, [unknown?]>();
      signedFetchMock.mockResolvedValue(
        new globalThis.Response(
          new ReadableStream<Uint8Array>({
            cancel,
          }),
          {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': contentLength },
          },
        ),
      );
      const target = makeResponse();

      await expect(
        makeController().render('site-1', renderBody(), makeRequest(), target.response),
      ).rejects.toThrow('invalid byte length');

      expect(cancel).toHaveBeenCalledWith('Marine proxy response had an invalid byte length');
      expect(target.statusMock).not.toHaveBeenCalled();
      expect(target.writeMock).not.toHaveBeenCalled();
      expect(target.endMock).not.toHaveBeenCalled();
      expect(target.destroyMock).not.toHaveBeenCalled();
    },
  );

  it('rejects an oversized declared response and cancels upstream before browser output', async () => {
    const cancel = jest.fn<void, [unknown?]>();
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(
        new ReadableStream<Uint8Array>({
          cancel,
        }),
        {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(MARINE_PROXY_MAX_RESPONSE_BYTES + 1),
          },
        },
      ),
    );
    const target = makeResponse();

    await expect(
      makeController().render('site-1', renderBody(), makeRequest(), target.response),
    ).rejects.toThrow(BadGatewayException);

    expect(cancel).toHaveBeenCalledWith('Marine proxy response exceeded the byte limit');
    expect(target.statusMock).not.toHaveBeenCalled();
    expect(target.setHeaderMock).not.toHaveBeenCalled();
    expect(target.writeMock).not.toHaveBeenCalled();
    expect(target.endMock).not.toHaveBeenCalled();
  });

  it('enforces the cumulative limit for chunked responses and destroys a partially sent response', async () => {
    const cancel = jest.fn<void, [unknown?]>();
    const maximumChunk = new Uint8Array(MARINE_PROXY_MAX_RESPONSE_BYTES);
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(maximumChunk);
            controller.enqueue(new Uint8Array([1]));
          },
          cancel,
        }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      ),
    );
    const target = makeResponse();

    await expect(
      makeController().render('site-1', renderBody(), makeRequest(), target.response),
    ).resolves.toBeUndefined();

    expect(target.writeMock).toHaveBeenCalledTimes(1);
    expect(target.writeMock.mock.calls[0]?.[0].byteLength).toBe(MARINE_PROXY_MAX_RESPONSE_BYTES);
    expect(cancel).toHaveBeenCalledWith('Marine proxy response exceeded the byte limit');
    expect(target.endMock).not.toHaveBeenCalled();
    expect(target.destroyMock).toHaveBeenCalledWith(expect.any(BadGatewayException));
  });

  it('streams an in-limit chunked response without inventing a Content-Length', async () => {
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
            controller.close();
          },
        }),
        { status: 206, headers: { 'content-type': 'image/png' } },
      ),
    );
    const target = makeResponse();

    await makeController().render('site-1', renderBody(), makeRequest(), target.response);

    expect(target.statusMock).toHaveBeenCalledWith(206);
    expect(Buffer.concat(target.writeMock.mock.calls.map(([chunk]) => chunk))).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    expect(target.setHeaderMock).not.toHaveBeenCalledWith('Content-Length', expect.anything());
    expect(target.endMock).toHaveBeenCalledTimes(1);
  });

  it('detects an incomplete declared response body and destroys the partial browser response', async () => {
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '5' },
      }),
    );
    const target = makeResponse();

    await expect(
      makeController().render('site-1', renderBody(), makeRequest(), target.response),
    ).resolves.toBeUndefined();

    expect(target.writeMock).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(target.endMock).not.toHaveBeenCalled();
    expect(target.destroyMock).toHaveBeenCalledWith(expect.any(BadGatewayException));
    expect(target.destroyMock.mock.calls[0]?.[0]?.message).toContain('body is incomplete');
  });

  it('rejects a missing body that declares non-zero bytes before sending headers', async () => {
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(null, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      }),
    );
    const target = makeResponse();

    await expect(
      makeController().render('site-1', renderBody(), makeRequest(), target.response),
    ).rejects.toThrow('body is incomplete');
    expect(target.statusMock).not.toHaveBeenCalled();
    expect(target.writeMock).not.toHaveBeenCalled();
    expect(target.endMock).not.toHaveBeenCalled();
  });

  it('rejects a body that exceeds its declared length and cancels before writing that chunk', async () => {
    const cancel = jest.fn<void, [unknown?]>();
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          },
          cancel,
        }),
        {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '3' },
        },
      ),
    );
    const target = makeResponse();

    await expect(
      makeController().render('site-1', renderBody(), makeRequest(), target.response),
    ).rejects.toThrow('body length is invalid');

    expect(cancel).toHaveBeenCalledWith('Marine proxy response exceeded its declared byte length');
    expect(target.writeMock).not.toHaveBeenCalled();
    expect(target.endMock).not.toHaveBeenCalled();
  });

  it('keeps the aggregate timeout alive through a stalled response body and cancels it', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn<void, [unknown?]>();
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel,
        }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      ),
    );
    const target = makeResponse();
    const render = makeController().render('site-1', renderBody(), makeRequest(), target.response);
    const assertion = expect(render).rejects.toThrow('marine proxy timed out');

    await jest.advanceTimersByTimeAsync(MARINE_PROXY_REQUEST_TIMEOUT_MS + 1);

    await assertion;
    expect(cancel).toHaveBeenCalledWith('Marine proxy response read failed');
    expect(target.writeMock).not.toHaveBeenCalled();
    expect(target.endMock).not.toHaveBeenCalled();
  });

  it('honors response backpressure before completing the upstream stream', async () => {
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      ),
    );
    const target = makeResponse();
    target.setWriteResult(false);

    const render = makeController().render('site-1', renderBody(), makeRequest(), target.response);
    await waitFor(() => target.writeMock.mock.calls.length === 1);
    expect(target.endMock).not.toHaveBeenCalled();

    target.emit('drain');

    await expect(render).resolves.toBeUndefined();
    expect(target.endMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the signed farm request when the browser disconnects before headers', async () => {
    let farmSignal: AbortSignal | undefined;
    signedFetchMock.mockImplementation(
      (_url, init) =>
        new Promise<globalThis.Response>((_resolve, reject) => {
          farmSignal = init?.signal ?? undefined;
          farmSignal?.addEventListener('abort', () => reject(new Error('farm aborted')), {
            once: true,
          });
        }),
    );
    const target = makeResponse();
    const render = makeController().render('site-1', renderBody(), makeRequest(), target.response);
    await waitFor(() => farmSignal !== undefined);

    target.emit('close');

    await expect(render).resolves.toBeUndefined();
    expect(farmSignal?.aborted).toBe(true);
    expect(target.writeMock).not.toHaveBeenCalled();
    expect(target.endMock).not.toHaveBeenCalled();
    expect(target.listenerCount('close')).toBe(0);
  });

  it('cancels the upstream reader when the browser disconnects mid-stream', async () => {
    const cancel = jest.fn<void, [unknown?]>();
    signedFetchMock.mockResolvedValue(
      new globalThis.Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel,
        }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      ),
    );
    const target = makeResponse();
    const render = makeController().render('site-1', renderBody(), makeRequest(), target.response);
    await waitFor(() => target.writeMock.mock.calls.length === 1);

    target.emit('close');

    await expect(render).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith('Marine proxy response read failed');
    expect(target.endMock).not.toHaveBeenCalled();
  });

  it('fails closed when the gateway request has no authenticated tenant user', async () => {
    const target = makeResponse();

    await expect(
      makeController().render('site-1', renderBody(), makeRequest(null), target.response),
    ).rejects.toThrow(UnauthorizedException);
    expect(signedFetchMock).not.toHaveBeenCalled();
  });
});
