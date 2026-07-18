import { MAX_BBOX_DEGREES_AREA } from '../../sentinel-hub/sentinel-proxy.policy';
import { MIN_SENTINEL_TILE_MATRIX, worstCaseTileAreaDeg2 } from '../marine-data.service';

/**
 * F2: the minimum servable Sentinel zoom is derived from the proxy policy's
 * bbox-area cap. These assertions lock the two together so a tile the service
 * emits can never be one the policy would reject with a 400.
 */
describe('sentinel tile zoom vs bbox-area policy', () => {
  it('admits the minimum zoom whose worst-case tile fits the policy cap', () => {
    expect(worstCaseTileAreaDeg2(MIN_SENTINEL_TILE_MATRIX)).toBeLessThanOrEqual(MAX_BBOX_DEGREES_AREA);
  });

  it('is tight: one zoom lower would exceed the cap', () => {
    if (MIN_SENTINEL_TILE_MATRIX === 0) {
      return;
    }
    expect(worstCaseTileAreaDeg2(MIN_SENTINEL_TILE_MATRIX - 1)).toBeGreaterThan(MAX_BBOX_DEGREES_AREA);
  });

  it('resolves to zoom 9 for the current 1 deg² cap', () => {
    expect(MIN_SENTINEL_TILE_MATRIX).toBe(9);
  });
});
