import { BadRequestException } from '@nestjs/common';

import { SentinelProxyPolicy } from '../sentinel-proxy.policy';

describe('SentinelProxyPolicy', () => {
  const policy = new SentinelProxyPolicy();
  const validBbox = '28.1,40.1,28.2,40.2';
  const fromDate = '2026-05-01T00:00:00.000Z';
  const toDate = '2026-05-03T00:00:00.000Z';

  it('rejects client-provided evalscript and collection on process requests', () => {
    expect(() => policy.validateProcessRequest({
      bbox: validBbox,
      fromDate,
      toDate,
      product: 'chlorophyll',
      evalscript: `//VERSION=3\nreturn [1];`,
    })).toThrow(BadRequestException);

    expect(() => policy.validateProcessRequest({
      bbox: validBbox,
      fromDate,
      toDate,
      product: 'chlorophyll',
      collection: 'sentinel-1-grd',
    })).toThrow(BadRequestException);
  });

  it('returns server-side product, collection, bbox, date, and dimension contract', () => {
    const result = policy.validateProcessRequest({
      bbox: validBbox,
      fromDate,
      toDate,
      width: '512',
      height: '256',
      product: 'chlorophyll',
    });

    expect(result.collection).toBe('sentinel-2-l2a');
    expect(result.evalscript).toContain('//VERSION=3');
    expect(result.bbox).toEqual([28.1, 40.1, 28.2, 40.2]);
    expect(result.width).toBe(512);
    expect(result.height).toBe(256);
    expect(result.fromIso).toBe(fromDate);
    expect(result.toIso).toBe(toDate);
  });

  it('rejects invalid bbox, oversized dimensions, and disallowed collections', () => {
    expect(() => policy.validateProcessRequest({
      bbox: '-200,40,28,41',
      fromDate,
      toDate,
      product: 'ndwi',
    })).toThrow(BadRequestException);

    expect(() => policy.validateProcessRequest({
      bbox: validBbox,
      fromDate,
      toDate,
      product: 'ndwi',
      width: '4096',
      height: '512',
    })).toThrow(BadRequestException);

    expect(() => policy.validateCatalogRequest({
      bbox: validBbox,
      fromDate,
      toDate,
      collections: 'sentinel-1-grd',
    })).toThrow(BadRequestException);
  });

  it('normalizes WMS query params through the allowlist', () => {
    const result = policy.validateWmsRequest('safe-layer', {
      bbox: validBbox,
      width: '512',
      height: '512',
      format: 'image/png',
      service: 'WMS',
      request: 'GetMap',
      ignored: 'must-not-forward',
    });

    expect(result.queryParams.get('bbox')).toBe(validBbox);
    expect(result.queryParams.get('format')).toBe('image/png');
    expect(result.queryParams.get('ignored')).toBeNull();
  });

  it('enforces upstream response type and size allowlists', () => {
    expect(() => policy.assertImageResponse('text/html', '128')).toThrow(BadRequestException);
    expect(() => policy.assertJsonResponse('application/json; charset=utf-8', '128')).not.toThrow();
    expect(() => policy.assertResponseBytes(16 * 1024 * 1024)).toThrow(BadRequestException);
  });
});
