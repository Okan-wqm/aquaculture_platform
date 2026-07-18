import { BadRequestException } from '@nestjs/common';

import { SentinelProxyPolicy } from '../sentinel-proxy.policy';

/**
 * F1: point queries must render at the policy's MIN_DIMENSION (64), not 1×1.
 * A 1×1 output is rejected by the shared process policy, which is why every
 * Sentinel point query used to 400 before reaching CDSE.
 */
describe('sentinel process dimension policy', () => {
  const policy = new SentinelProxyPolicy();
  const base = {
    bbox: '29.000,40.000,29.010,40.010',
    fromDate: '2026-01-01',
    toDate: '2026-01-02',
    product: 'chlorophyll',
  };

  it('rejects a 1×1 render below MIN_DIMENSION', () => {
    expect(() => policy.validateProcessRequest({ ...base, width: '1', height: '1' })).toThrow(
      BadRequestException,
    );
  });

  it('accepts a 64×64 render at MIN_DIMENSION', () => {
    const result = policy.validateProcessRequest({ ...base, width: '64', height: '64' });

    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
    expect(result.collection).toBe('sentinel-2-l2a');
  });
});
