import * as registry from '../sentinel-product-registry';

describe('Sentinel process product registry', () => {
  it('contains only the backend render allowlist', () => {
    expect(Object.keys(registry.SENTINEL_PROCESS_PRODUCTS).sort()).toEqual([
      'chlorophyll',
      'natural-color',
      'ndwi',
      'turbidity',
    ]);
    expect(registry.getSentinelProcessProduct('sentinel:chlorophyll')).toBeNull();
    expect(registry.getSentinelProcessProduct('unknown')).toBeNull();
  });

  it('does not retain the retired point-query surface or false measurement units', () => {
    expect(registry).not.toHaveProperty('SENTINEL_POINT_PRODUCTS');
    expect(registry).not.toHaveProperty('getSentinelPointProduct');
    expect(JSON.stringify(registry.SENTINEL_PROCESS_PRODUCTS)).not.toContain('mg/m3');
    expect(JSON.stringify(registry.SENTINEL_PROCESS_PRODUCTS)).not.toContain('NTU');
  });
});
