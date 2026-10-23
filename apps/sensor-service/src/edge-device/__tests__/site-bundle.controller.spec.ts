import { IS_PUBLIC_KEY, SKIP_TENANT_GUARD_KEY } from '@aquaculture/backend-common/decorators';
import { collaborator } from '@aquaculture/testing';
import { type Response } from 'express';

import { RATE_LIMIT_KEY } from '../../guards/rate-limit.guard';
import { type EdgeUpdateRequestService } from '../edge-update-request.service';
import { PROVISIONING_REFUSAL_BODY } from '../provisioning.controller';
import { SiteBundleController } from '../site-bundle.controller';

/**
 * The public endpoint root fetches a site bundle from (ADR-048 DEC-4.12, DEC-22): one
 * answer for everything that is not a bundle served inside its window, and nothing the
 * answer says tells a caller which of them it hit.
 */

const TENANT = '7e570000-0000-4000-8000-000000000001';
const REQUEST = '11111111-1111-4111-8111-111111111111';
const BUNDLE = '{"_type":"suderra.site-bundle.v1"}';

interface Sent {
  status?: number;
  type?: string;
  body?: string;
  headers: Record<string, string>;
}

function response(): { res: Response; sent: Sent } {
  const sent: Sent = { headers: {} };
  const res: Response = collaborator<Response>(
    {
      status: (code: number) => {
        sent.status = code;
        return res;
      },
      type: (value: string) => {
        sent.type = value;
        return res;
      },
      send: (body: string) => {
        sent.body = body;
        return res;
      },
      setHeader: (name: string, value: string) => {
        sent.headers[name] = value;
        return res;
      },
    },
    'Response',
  );
  return { res, sent };
}

describe('SiteBundleController', () => {
  const siteBundleOf = jest.fn();
  let controller: SiteBundleController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new SiteBundleController(
      collaborator<EdgeUpdateRequestService>({ siteBundleOf }, 'EdgeUpdateRequestService'),
    );
  });

  it('serves the bundle of an open request inside its window, uncached', async () => {
    siteBundleOf.mockResolvedValue(BUNDLE);
    const { res, sent } = response();
    await controller.getSiteBundle(TENANT, REQUEST, res);
    expect(sent).toMatchObject({
      status: 200,
      type: 'application/json',
      body: BUNDLE,
      headers: { 'Cache-Control': 'no-store' },
    });
    expect(siteBundleOf).toHaveBeenCalledWith(TENANT, REQUEST, expect.any(Date));
  });

  it.each([
    [
      'an unknown request, a closed window or another tenant',
      () => siteBundleOf.mockResolvedValue(null),
    ],
    ['a read that fails', () => siteBundleOf.mockRejectedValue(new Error('connection terminated'))],
  ])('answers %s with the one refusal body', async (_name, arrange) => {
    arrange();
    const { res, sent } = response();
    await controller.getSiteBundle(TENANT, REQUEST, res);
    expect(sent).toMatchObject({
      status: 404,
      type: 'application/json',
      body: PROVISIONING_REFUSAL_BODY,
    });
  });

  it.each([
    ['a tenant that is not a uuid', 'tenant', REQUEST],
    ['a request that is not a uuid', TENANT, 'latest'],
    ['a path-shaped request', TENANT, '../../etc/passwd'],
    ['an uppercase request id', TENANT, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
  ])(
    'answers %s with the same refusal body and reads nothing',
    async (_name, tenantId, requestId) => {
      const { res, sent } = response();
      await controller.getSiteBundle(tenantId, requestId, res);
      expect(sent).toMatchObject({ status: 404, body: PROVISIONING_REFUSAL_BODY });
      expect(siteBundleOf).not.toHaveBeenCalled();
    },
  );

  it('is public, outside the tenant guard, and rate limited', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, SiteBundleController)).toBe(true);
    expect(Reflect.getMetadata(SKIP_TENANT_GUARD_KEY, SiteBundleController)).toBe(true);
    expect(
      Reflect.getMetadata(RATE_LIMIT_KEY, SiteBundleController.prototype.getSiteBundle),
    ).toEqual({ limit: 30, windowMs: 60000 });
    expect(Reflect.getMetadata('path', SiteBundleController.prototype.getSiteBundle)).toBe(
      'api/devices/site-bundles/:tenantId/:requestId',
    );
  });
});
