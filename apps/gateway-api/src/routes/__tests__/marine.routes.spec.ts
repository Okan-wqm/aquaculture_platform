import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

import {
  buildGatewayVerifiedUserAssertion,
  signedFetch,
} from '@aquaculture/backend-common/http';

import {
  MarineRoutesController,
  type MarineProxyRequest,
  type MarineProxyResponse,
} from '../marine.routes';
import type { AuthenticatedUser } from '../../types';

jest.mock('@aquaculture/backend-common/http', () => ({
  buildGatewayVerifiedUserAssertion: jest.fn(() => 'verified-user-assertion'),
  signedFetch: jest.fn(),
}));

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

function makeRequest(user: AuthenticatedUser | null = makeUser()): MarineProxyRequest {
  return {
    headers: {
      accept: 'image/png',
      'x-correlation-id': 'corr-1',
    },
    user: user ?? undefined,
  };
}

function makeResponse(): {
  readonly response: MarineProxyResponse;
  readonly statusMock: jest.Mock<void, [number]>;
  readonly setHeaderMock: jest.Mock<void, [string, number | string | readonly string[]]>;
  readonly sendMock: jest.Mock<void, [Buffer]>;
} {
  const statusMock = jest.fn<void, [number]>();
  const setHeaderMock = jest.fn<void, [string, number | string | readonly string[]]>();
  const sendMock = jest.fn<void, [Buffer]>();
  const response: MarineProxyResponse = {
    status(statusCode) {
      statusMock(statusCode);
      return response;
    },
    setHeader(name, value) {
      setHeaderMock(name, value);
      return response;
    },
    send(body) {
      sendMock(body);
      return response;
    },
  };
  return { response, statusMock, setHeaderMock, sendMock };
}

describe('MarineRoutesController', () => {
  beforeEach(() => {
    signedFetchMock.mockReset();
    buildAssertionMock.mockReset();
    buildAssertionMock.mockReturnValue('verified-user-assertion');
  });

  it('proxies tile requests through signed farm-service internal marine contract', async () => {
    signedFetchMock.mockResolvedValue(new globalThis.Response(Buffer.from('png'), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=900',
        vary: 'Authorization, Cookie',
      },
    }));
    const controller = makeController();
    const { response, statusMock, setHeaderMock, sendMock } = makeResponse();

    await controller.tile(
      'sentinel:natural-color',
      '7',
      '33',
      '44',
      { date: '2026-06-20', depth: 0 },
      makeRequest(),
      response,
    );

    expect(buildAssertionMock).toHaveBeenCalledWith({
      subject: 'user-1',
      tenantId: 'tenant-1',
      effectiveTenantId: 'tenant-1',
      roles: ['TENANT_ADMIN'],
      email: 'user@example.test',
      assignedSiteIds: ['site-1'],
      mobileFeatures: ['offline-sync'],
    });
    expect(signedFetchMock).toHaveBeenCalledWith(
      'http://farm-service:3000/api/internal/marine/tiles/sentinel%3Anatural-color/7/33/44.png?date=2026-06-20&depth=0',
      expect.objectContaining({
        method: 'GET',
        serviceName: 'gateway-api',
        tenantId: 'tenant-1',
        audience: 'farm',
        headers: expect.objectContaining({
          Accept: 'image/png',
          'x-correlation-id': 'corr-1',
          'x-verified-user-assertion': 'verified-user-assertion',
        }),
      }),
    );
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'private, max-age=900');
    expect(setHeaderMock).toHaveBeenCalledWith('Vary', 'Authorization, Cookie');
    expect(sendMock).toHaveBeenCalledWith(Buffer.from('png'));
  });

  it('fails closed when the gateway request has no authenticated tenant user', async () => {
    const controller = makeController();
    const { response } = makeResponse();

    await expect(controller.layers(makeRequest(null), response)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(signedFetchMock).not.toHaveBeenCalled();
  });
});
