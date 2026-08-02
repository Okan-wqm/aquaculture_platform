import type {
  GeoJsonPosition,
  MonitoringArea,
  MonitoringMultiPolygon,
  MonitoringPolygon,
} from '../../../hooks/useSites';

const MAX_MONITORING_VERTICES = 500;
const MAX_MONITORING_BBOX_KM = 40;
const EARTH_RADIUS_KM = 6_371.0088;
const GEOMETRY_KEYS = new Set(['type', 'coordinates']);

export interface MonitoringAreaSiteLocation {
  latitude: number | '';
  longitude: number | '';
}

export type MonitoringAreaUxValidationResult =
  | { valid: true; geometry: MonitoringArea }
  | { valid: false; message: string };

interface ParsedRing {
  valid: true;
  ring: GeoJsonPosition[];
}

interface InvalidRing {
  valid: false;
  message: string;
}

type RingResult = ParsedRing | InvalidRing;

function invalid(message: string): MonitoringAreaUxValidationResult {
  return { valid: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positionsEqual(left: GeoJsonPosition, right: GeoJsonPosition): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function parsePosition(value: unknown): GeoJsonPosition | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const longitude = value[0];
  const latitude = value[1];
  if (
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude)
  ) {
    return null;
  }
  return [longitude, latitude];
}

function orientation(
  first: GeoJsonPosition,
  second: GeoJsonPosition,
  third: GeoJsonPosition,
): number {
  const cross =
    (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
  if (Math.abs(cross) < 1e-12) {
    return 0;
  }
  return cross > 0 ? 1 : -1;
}

function pointOnSegment(
  point: GeoJsonPosition,
  start: GeoJsonPosition,
  end: GeoJsonPosition,
): boolean {
  return (
    orientation(start, end, point) === 0 &&
    point[0] >= Math.min(start[0], end[0]) &&
    point[0] <= Math.max(start[0], end[0]) &&
    point[1] >= Math.min(start[1], end[1]) &&
    point[1] <= Math.max(start[1], end[1])
  );
}

function segmentsIntersect(
  firstStart: GeoJsonPosition,
  firstEnd: GeoJsonPosition,
  secondStart: GeoJsonPosition,
  secondEnd: GeoJsonPosition,
): boolean {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);

  if (firstOrientation !== secondOrientation && thirdOrientation !== fourthOrientation) {
    return true;
  }
  return (
    (firstOrientation === 0 && pointOnSegment(secondStart, firstStart, firstEnd)) ||
    (secondOrientation === 0 && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (thirdOrientation === 0 && pointOnSegment(firstStart, secondStart, secondEnd)) ||
    (fourthOrientation === 0 && pointOnSegment(firstEnd, secondStart, secondEnd))
  );
}

function ringSelfIntersects(ring: GeoJsonPosition[]): boolean {
  const segmentCount = ring.length - 1;
  for (let firstIndex = 0; firstIndex < segmentCount; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < segmentCount; secondIndex += 1) {
      const adjacent =
        secondIndex === firstIndex + 1 || (firstIndex === 0 && secondIndex === segmentCount - 1);
      if (adjacent) {
        continue;
      }
      if (
        segmentsIntersect(
          ring[firstIndex],
          ring[firstIndex + 1],
          ring[secondIndex],
          ring[secondIndex + 1],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function signedArea(ring: GeoJsonPosition[]): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function parseRing(value: unknown): RingResult {
  if (!Array.isArray(value) || value.length < 4) {
    return {
      valid: false,
      message: 'Each monitoring-area ring needs at least four positions.',
    };
  }

  const ring: GeoJsonPosition[] = [];
  for (const rawPosition of value) {
    const position = parsePosition(rawPosition);
    if (!position) {
      return {
        valid: false,
        message:
          'Every monitoring-area position must be [longitude, latitude] using finite numbers.',
      };
    }
    if (position[0] < -180 || position[0] > 180) {
      return {
        valid: false,
        message: 'Monitoring-area longitude must be between -180 and 180.',
      };
    }
    if (position[1] < -90 || position[1] > 90) {
      return {
        valid: false,
        message: 'Monitoring-area latitude must be between -90 and 90.',
      };
    }
    ring.push(position);
  }

  if (!positionsEqual(ring[0], ring[ring.length - 1])) {
    return {
      valid: false,
      message: 'Every monitoring-area ring must be closed.',
    };
  }
  if (ringSelfIntersects(ring)) {
    return {
      valid: false,
      message: 'Monitoring-area rings must not cross themselves.',
    };
  }
  if (Math.abs(signedArea(ring)) < 1e-12) {
    return {
      valid: false,
      message: 'Monitoring-area rings must enclose a non-zero area.',
    };
  }
  return { valid: true, ring };
}

function rawPositionCount(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  if (value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return 1;
  }
  return value.reduce((total: number, nested: unknown) => total + rawPositionCount(nested), 0);
}

function pointInRing(point: GeoJsonPosition, ring: GeoJsonPosition[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 2; index < ring.length - 1; previous = index++) {
    const currentPosition = ring[index];
    const previousPosition = ring[previous];
    if (pointOnSegment(point, previousPosition, currentPosition)) {
      return true;
    }
    const crossesLatitude = currentPosition[1] > point[1] !== previousPosition[1] > point[1];
    if (
      crossesLatitude &&
      point[0] <
        ((previousPosition[0] - currentPosition[0]) * (point[1] - currentPosition[1])) /
          (previousPosition[1] - currentPosition[1]) +
          currentPosition[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function spanKilometres(positions: GeoJsonPosition[]): {
  width: number;
  height: number;
} {
  const longitudes = positions.map((position) => position[0]);
  const latitudes = positions.map((position) => position[1]);
  const minimumLongitude = Math.min(...longitudes);
  const maximumLongitude = Math.max(...longitudes);
  const minimumLatitude = Math.min(...latitudes);
  const maximumLatitude = Math.max(...latitudes);
  const toRadians = Math.PI / 180;
  const midpointLatitude = ((minimumLatitude + maximumLatitude) / 2) * toRadians;
  return {
    width:
      EARTH_RADIUS_KM *
      Math.abs(maximumLongitude - minimumLongitude) *
      toRadians *
      Math.cos(midpointLatitude),
    height: EARTH_RADIUS_KM * Math.abs(maximumLatitude - minimumLatitude) * toRadians,
  };
}

function hasValidSiteLocation(
  location: MonitoringAreaSiteLocation,
): location is { latitude: number; longitude: number } {
  return (
    typeof location.latitude === 'number' &&
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    typeof location.longitude === 'number' &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

/**
 * Fast UX prevalidation only. The farm-service remains the canonical authority
 * and repeats these checks before persistence.
 */
export function validateMonitoringAreaForSite(
  value: unknown,
  location: MonitoringAreaSiteLocation,
): MonitoringAreaUxValidationResult {
  if (!isRecord(value)) {
    return invalid('Monitoring area must be a GeoJSON geometry object.');
  }
  if (
    Object.keys(value).length !== GEOMETRY_KEYS.size ||
    Object.keys(value).some((key) => !GEOMETRY_KEYS.has(key))
  ) {
    return invalid('Use a Polygon or MultiPolygon geometry, not a Feature or extra properties.');
  }

  const coordinates = value.coordinates;
  if (rawPositionCount(coordinates) > MAX_MONITORING_VERTICES) {
    return invalid('Monitoring area must contain no more than 500 vertices.');
  }

  const rings: GeoJsonPosition[][] = [];
  if (value.type === 'Polygon') {
    if (!Array.isArray(coordinates) || coordinates.length !== 1) {
      return invalid('A Polygon must contain one exterior ring; holes are not supported.');
    }
    const ringResult = parseRing(coordinates[0]);
    if (!ringResult.valid) {
      return invalid(ringResult.message);
    }
    rings.push(ringResult.ring);
  } else if (value.type === 'MultiPolygon') {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      return invalid('A MultiPolygon must contain at least one polygon.');
    }
    for (const polygon of coordinates) {
      if (!Array.isArray(polygon) || polygon.length !== 1) {
        return invalid(
          'Each MultiPolygon polygon must contain one exterior ring; holes are not supported.',
        );
      }
      const ringResult = parseRing(polygon[0]);
      if (!ringResult.valid) {
        return invalid(ringResult.message);
      }
      rings.push(ringResult.ring);
    }
  } else {
    return invalid('Monitoring area type must be Polygon or MultiPolygon.');
  }

  const span = spanKilometres(rings.flat());
  if (span.width > MAX_MONITORING_BBOX_KM || span.height > MAX_MONITORING_BBOX_KM) {
    return invalid('Monitoring-area width and height must each be at most 40 km.');
  }
  if (!hasValidSiteLocation(location)) {
    return invalid('Enter valid site coordinates before adding a monitoring area.');
  }
  const sitePosition: GeoJsonPosition = [location.longitude, location.latitude];
  if (!rings.some((ring) => pointInRing(sitePosition, ring))) {
    return invalid('Monitoring area must contain the site coordinates.');
  }

  const geometry: MonitoringArea =
    value.type === 'Polygon'
      ? ({
          type: 'Polygon',
          coordinates: [rings[0]],
        } satisfies MonitoringPolygon)
      : ({
          type: 'MultiPolygon',
          coordinates: rings.map((ring) => [ring]),
        } satisfies MonitoringMultiPolygon);
  return { valid: true, geometry };
}
