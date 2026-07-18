import type { ProcessPolicyResult } from './sentinel-proxy.policy';

/**
 * Single source of truth for the CDSE Processing API request body.
 *
 * Both the internal marine tile/point path (`MarineDataService.fetchSentinelProcess`)
 * and the raw proxy controller (`SentinelHubProxyController.proxyProcessingApi`)
 * build byte-identical bodies from a validated {@link ProcessPolicyResult}; the only
 * variation is an optional server-owned evalscript override (point/AOI products).
 * Keeping the construction here prevents the two call sites from drifting.
 */
export function buildSentinelProcessBody(
  policy: ProcessPolicyResult,
  evalscriptOverride?: string,
): string {
  return JSON.stringify({
    input: {
      bounds: {
        bbox: policy.bbox,
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [
        {
          type: policy.collection,
          dataFilter: {
            timeRange: {
              from: policy.fromIso,
              to: policy.toIso,
            },
          },
        },
      ],
    },
    output: {
      width: policy.width,
      height: policy.height,
      responses: [{ identifier: 'default', format: { type: 'image/png' } }],
    },
    evalscript: evalscriptOverride ?? policy.evalscript,
  });
}
