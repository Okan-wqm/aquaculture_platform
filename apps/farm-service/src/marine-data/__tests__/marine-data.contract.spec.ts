import { MarineCachePolicy } from '../marine-cache.policy';
import {
  CMEMS_LAYER_CATALOG,
  MARINE_LAYER_CATALOG,
  SENTINEL_LAYER_CATALOG,
} from '../marine-layer-catalog';

describe('marine data contract', () => {
  it('publishes each backend-owned marine layer exactly once', () => {
    const ids = MARINE_LAYER_CATALOG.map((layer) => layer.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      ...SENTINEL_LAYER_CATALOG.map((layer) => layer.id),
      ...CMEMS_LAYER_CATALOG.map((layer) => layer.id),
    ]);
  });

  it('keeps CMEMS upstream capability names inside the backend catalog', () => {
    for (const layer of CMEMS_LAYER_CATALOG) {
      const publicLayer = MARINE_LAYER_CATALOG.find((candidate) => candidate.id === layer.id);

      expect(publicLayer).toEqual(expect.objectContaining({
        id: layer.id,
        source: 'cmems',
        backendProduct: layer.product,
        capabilityLayer: `${layer.product}/${layer.dataset}/${layer.variable}`,
        supportsDepth: true,
      }));
    }
  });

  it('marks authenticated tiles private-cacheable and point analysis no-store', () => {
    const policy = new MarineCachePolicy();

    expect(policy.headersFor('tile')).toEqual({
      cacheControl: 'private, max-age=900, stale-while-revalidate=300',
      vary: ['Authorization', 'Cookie'],
    });
    expect(policy.headersFor('point-query')).toEqual({
      cacheControl: 'no-store',
      vary: ['Authorization', 'Cookie'],
    });
    expect(policy.headersFor('tile', 502)).toEqual({
      cacheControl: 'no-store',
      vary: ['Authorization', 'Cookie'],
    });
  });
});
