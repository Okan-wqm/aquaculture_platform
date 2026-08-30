import {
  siteMonitoringContractError,
  monitoringLocationChanged,
} from '../dto/site-monitoring.validation';
import { MonitoringAreaGeometry, SiteLocation, SiteType } from '../entities/site.entity';

const LOCATION: SiteLocation = {
  latitude: 60,
  longitude: 5,
};

const VALID_POLYGON: MonitoringAreaGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [4.99, 59.99],
      [5.01, 59.99],
      [5.01, 60.01],
      [4.99, 60.01],
      [4.99, 59.99],
    ],
  ],
};

function contract(
  overrides: Partial<{
    type: SiteType;
    location: SiteLocation | null;
    monitoringRadiusM: number;
    monitoringArea: MonitoringAreaGeometry | null;
  }> = {},
) {
  return {
    type: SiteType.SEA_CAGE,
    location: LOCATION,
    monitoringRadiusM: 2_000,
    monitoringArea: VALID_POLYGON,
    ...overrides,
  };
}

describe('site monitoring contract validation', () => {
  it('accepts a valid Polygon and a valid MultiPolygon containing the site point', () => {
    expect(siteMonitoringContractError(contract())).toBeUndefined();
    expect(
      siteMonitoringContractError(
        contract({
          monitoringArea: {
            type: 'MultiPolygon',
            coordinates: [
              [
                [
                  [4.99, 59.99],
                  [5.01, 59.99],
                  [5.01, 60.01],
                  [4.99, 60.01],
                  [4.99, 59.99],
                ],
              ],
              [
                [
                  [5.1, 60.1],
                  [5.11, 60.1],
                  [5.11, 60.11],
                  [5.1, 60.11],
                  [5.1, 60.1],
                ],
              ],
            ],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('requires a finite, in-range location for SEA_CAGE sites', () => {
    expect(siteMonitoringContractError(contract({ location: null }))).toMatch(/SEA_CAGE.*location/);
    expect(
      siteMonitoringContractError(
        contract({ location: { latitude: Number.POSITIVE_INFINITY, longitude: 5 } }),
      ),
    ).toMatch(/valid latitude and longitude/);
    expect(
      siteMonitoringContractError(contract({ location: { latitude: 60, longitude: 181 } })),
    ).toMatch(/valid latitude and longitude/);
  });

  it('enforces an integer monitoring radius from 100 through 20,000 metres', () => {
    expect(siteMonitoringContractError(contract({ monitoringRadiusM: 99 }))).toMatch(
      /between 100 and 20000/,
    );
    expect(siteMonitoringContractError(contract({ monitoringRadiusM: 100 }))).toBeUndefined();
    expect(siteMonitoringContractError(contract({ monitoringRadiusM: 20_001 }))).toMatch(
      /between 100 and 20000/,
    );
    expect(siteMonitoringContractError(contract({ monitoringRadiusM: 2_000.5 }))).toMatch(
      /integer/,
    );
  });

  it.each([
    [
      'holes',
      {
        type: 'Polygon',
        coordinates: [
          VALID_POLYGON.coordinates[0],
          [
            [4.995, 59.995],
            [5.005, 59.995],
            [5.005, 60.005],
            [4.995, 60.005],
            [4.995, 59.995],
          ],
        ],
      },
      /holes/,
    ],
    [
      'open rings',
      {
        type: 'Polygon',
        coordinates: [
          [
            [4.99, 59.99],
            [5.01, 59.99],
            [5.01, 60.01],
            [4.99, 60.01],
          ],
        ],
      },
      /closed/,
    ],
    [
      'self-intersection',
      {
        type: 'Polygon',
        coordinates: [
          [
            [4.99, 59.99],
            [5.01, 60.01],
            [4.99, 60.01],
            [5.01, 59.99],
            [4.99, 59.99],
          ],
        ],
      },
      /self-intersect/,
    ],
    [
      'out-of-range coordinates',
      {
        type: 'Polygon',
        coordinates: [
          [
            [181, 59.99],
            [181, 60.01],
            [179, 60.01],
            [179, 59.99],
            [181, 59.99],
          ],
        ],
      },
      /longitude/,
    ],
    [
      'oversized bounding box',
      {
        type: 'Polygon',
        coordinates: [
          [
            [4, 59],
            [6, 59],
            [6, 61],
            [4, 61],
            [4, 59],
          ],
        ],
      },
      /40 km/,
    ],
  ])('rejects %s', (_name, monitoringArea, errorPattern) => {
    expect(
      siteMonitoringContractError(
        contract({ monitoringArea: monitoringArea as MonitoringAreaGeometry }),
      ),
    ).toMatch(errorPattern);
  });

  it('rejects geometries with more than 500 coordinate positions', () => {
    const positions: Array<[number, number]> = [];
    for (let index = 0; index < 500; index += 1) {
      const angle = (index / 499) * Math.PI * 2;
      positions.push([5 + Math.cos(angle) * 0.01, 60 + Math.sin(angle) * 0.01]);
    }
    positions.push(positions[0]!);

    expect(
      siteMonitoringContractError(
        contract({
          monitoringArea: {
            type: 'Polygon',
            coordinates: [positions],
          },
        }),
      ),
    ).toMatch(/500 vertices/);
  });

  it('rejects deeply nested malformed coordinate JSON without recursive stack growth', () => {
    let coordinates: unknown = [5, 60];
    for (let depth = 0; depth < 10_000; depth += 1) {
      coordinates = [coordinates];
    }

    expect(() =>
      siteMonitoringContractError({
        ...contract(),
        monitoringArea: {
          type: 'Polygon',
          coordinates,
        },
      }),
    ).not.toThrow();
    expect(
      siteMonitoringContractError({
        ...contract(),
        monitoringArea: {
          type: 'Polygon',
          coordinates,
        },
      }),
    ).toMatch(/structural complexity/);
  });

  it('requires the site point to be inside the monitoring geometry', () => {
    expect(
      siteMonitoringContractError(contract({ location: { latitude: 60.5, longitude: 5.5 } })),
    ).toMatch(/must contain the site location/);
  });

  it('detects only actual location, radius, or geometry changes', () => {
    const current = contract();

    expect(monitoringLocationChanged(current, contract())).toBe(false);
    expect(
      monitoringLocationChanged(
        current,
        contract({ monitoringRadiusM: current.monitoringRadiusM + 1 }),
      ),
    ).toBe(true);
    expect(
      monitoringLocationChanged(
        current,
        contract({ location: { latitude: 60.001, longitude: 5 } }),
      ),
    ).toBe(true);
    expect(monitoringLocationChanged(current, contract({ monitoringArea: null }))).toBe(true);
    expect(monitoringLocationChanged(current, contract({ type: SiteType.LAND_BASED }))).toBe(true);
  });
});
