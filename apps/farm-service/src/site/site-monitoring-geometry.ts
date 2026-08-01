import { MAX_MONITORING_RADIUS_M, MIN_MONITORING_RADIUS_M } from './dto/site-monitoring.validation';
import { MonitoringAreaGeometry, MonitoringPosition } from './entities/site.entity';

const GENERATED_AOI_VERTEX_COUNT = 32;
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Builds the canonical fallback AOI for a monitored site.
 *
 * Explicit tenant-provided polygons remain authoritative. This helper is the
 * single source of truth used when only a site point and monitoring radius are
 * available.
 */
export function createSiteMonitoringCircle(
  latitude: number,
  longitude: number,
  radiusM: number,
): MonitoringAreaGeometry {
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isInteger(radiusM) ||
    radiusM < MIN_MONITORING_RADIUS_M ||
    radiusM > MAX_MONITORING_RADIUS_M
  ) {
    throw new RangeError('Cannot construct monitoring AOI from invalid site coordinates');
  }

  const latitudeRadians = degreesToRadians(latitude);
  const longitudeRadians = degreesToRadians(longitude);
  const angularDistance = radiusM / EARTH_RADIUS_M;
  const positions: MonitoringPosition[] = Array.from(
    { length: GENERATED_AOI_VERTEX_COUNT },
    (_, index) => {
      const bearing = (2 * Math.PI * index) / GENERATED_AOI_VERTEX_COUNT;
      const destinationLatitude = Math.asin(
        Math.sin(latitudeRadians) * Math.cos(angularDistance) +
          Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
      );
      const destinationLongitude =
        longitudeRadians +
        Math.atan2(
          Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
          Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(destinationLatitude),
        );
      return [
        normalizeLongitude(radiansToDegrees(destinationLongitude)),
        radiansToDegrees(destinationLatitude),
      ];
    },
  );
  positions.push([...positions[0]!] as MonitoringPosition);
  return { type: 'Polygon', coordinates: [positions] };
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function normalizeLongitude(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}
