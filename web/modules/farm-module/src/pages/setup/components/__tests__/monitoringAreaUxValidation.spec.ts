import { describe, expect, it } from 'vitest';

import { validateMonitoringAreaForSite } from '../monitoringAreaUxValidation';

const SITE_LOCATION = { latitude: 60.2, longitude: 5.2 };

const VALID_POLYGON = {
  type: 'Polygon',
  coordinates: [
    [
      [5.1, 60.1],
      [5.3, 60.1],
      [5.3, 60.3],
      [5.1, 60.3],
      [5.1, 60.1],
    ],
  ],
};

describe('validateMonitoringAreaForSite', () => {
  it('accepts a bounded polygon containing the site and returns normalized geometry', () => {
    expect(validateMonitoringAreaForSite(VALID_POLYGON, SITE_LOCATION)).toEqual({
      valid: true,
      geometry: VALID_POLYGON,
    });
  });

  it('rejects polygon holes before the canonical backend validation runs', () => {
    const result = validateMonitoringAreaForSite(
      {
        ...VALID_POLYGON,
        coordinates: [
          VALID_POLYGON.coordinates[0],
          [
            [5.18, 60.18],
            [5.22, 60.18],
            [5.22, 60.22],
            [5.18, 60.22],
            [5.18, 60.18],
          ],
        ],
      },
      SITE_LOCATION,
    );

    expect(result).toEqual({
      valid: false,
      message: 'A Polygon must contain one exterior ring; holes are not supported.',
    });
  });

  it('rejects self-intersection and an area that does not contain the site', () => {
    expect(
      validateMonitoringAreaForSite(
        {
          type: 'Polygon',
          coordinates: [
            [
              [5.1, 60.1],
              [5.3, 60.3],
              [5.1, 60.3],
              [5.3, 60.1],
              [5.1, 60.1],
            ],
          ],
        },
        SITE_LOCATION,
      ),
    ).toEqual({
      valid: false,
      message: 'Monitoring-area rings must not cross themselves.',
    });

    expect(
      validateMonitoringAreaForSite(
        {
          type: 'Polygon',
          coordinates: [
            [
              [6.0, 61.0],
              [6.1, 61.0],
              [6.1, 61.1],
              [6.0, 61.1],
              [6.0, 61.0],
            ],
          ],
        },
        SITE_LOCATION,
      ),
    ).toEqual({
      valid: false,
      message: 'Monitoring area must contain the site coordinates.',
    });
  });

  it('rejects more than 500 vertices and a bounding box over 40 km', () => {
    const denseRing = Array.from({ length: 501 }, (_unused, index) => {
      const angle = (index / 501) * Math.PI * 2;
      return [5.2 + Math.cos(angle) * 0.01, 60.2 + Math.sin(angle) * 0.01];
    });
    denseRing.push(denseRing[0]);

    expect(
      validateMonitoringAreaForSite({ type: 'Polygon', coordinates: [denseRing] }, SITE_LOCATION),
    ).toEqual({
      valid: false,
      message: 'Monitoring area must contain no more than 500 vertices.',
    });

    expect(
      validateMonitoringAreaForSite(
        {
          type: 'Polygon',
          coordinates: [
            [
              [5.0, 59.9],
              [5.2, 59.9],
              [5.2, 60.5],
              [5.0, 60.5],
              [5.0, 59.9],
            ],
          ],
        },
        SITE_LOCATION,
      ),
    ).toEqual({
      valid: false,
      message: 'Monitoring-area width and height must each be at most 40 km.',
    });
  });
});
