import {
  MAX_MONITORING_RADIUS_M,
  MIN_MONITORING_RADIUS_M,
} from '../dto/site-monitoring.validation';
import { createSiteMonitoringCircle } from '../site-monitoring-geometry';

describe('createSiteMonitoringCircle', () => {
  it.each([MIN_MONITORING_RADIUS_M, MAX_MONITORING_RADIUS_M])(
    'creates a closed canonical 32-vertex polygon at radius %s',
    (radiusM) => {
      const geometry = createSiteMonitoringCircle(60.39, 5.32, radiusM);

      expect(geometry.type).toBe('Polygon');
      expect(geometry.coordinates).toHaveLength(1);
      expect(geometry.coordinates[0]).toHaveLength(33);
      expect(geometry.coordinates[0]![32]).toEqual(geometry.coordinates[0]![0]);
    },
  );

  it.each([
    [91, 5, 2_000],
    [60, 181, 2_000],
    [60, 5, MIN_MONITORING_RADIUS_M - 1],
    [60, 5, MAX_MONITORING_RADIUS_M + 1],
    [60, 5, 100.5],
  ])('rejects an invalid site monitoring contract (%s, %s, %s)', (lat, lon, radius) => {
    expect(() => createSiteMonitoringCircle(lat, lon, radius)).toThrow(RangeError);
  });

  it('normalizes a circle that crosses the antimeridian', () => {
    const geometry = createSiteMonitoringCircle(60, 179.999, 20_000);

    for (const [longitude, latitude] of geometry.coordinates[0]!) {
      expect(longitude).toBeGreaterThanOrEqual(-180);
      expect(longitude).toBeLessThanOrEqual(180);
      expect(latitude).toBeGreaterThanOrEqual(-90);
      expect(latitude).toBeLessThanOrEqual(90);
    }
  });
});
