import { ValidationOptions, ValidateBy } from 'class-validator';

import {
  MonitoringAreaGeometry,
  MonitoringPosition,
  SiteLocation,
  SiteType,
} from '../entities/site.entity';

export const MIN_MONITORING_RADIUS_M = 100;
export const MAX_MONITORING_RADIUS_M = 20_000;
const MAX_MONITORING_VERTICES = 500;
const MAX_MONITORING_COORDINATE_NODES = 4_096;
const MAX_MONITORING_COORDINATE_DEPTH = 64;
const MAX_MONITORING_BBOX_KM = 40;
const EARTH_RADIUS_KM = 6_371.0088;
const GEOMETRY_KEYS = new Set(['type', 'coordinates']);

export interface SiteMonitoringContract {
  type: SiteType;
  location: SiteLocation | null | undefined;
  monitoringRadiusM: number;
  monitoringArea: MonitoringAreaGeometry | null | undefined;
}

type SiteMonitoringValidationContract = Omit<SiteMonitoringContract, 'monitoringArea'> & {
  readonly monitoringArea: unknown;
};

interface ParsedMonitoringArea {
  geometry: MonitoringAreaGeometry;
  rings: MonitoringPosition[][];
  positions: MonitoringPosition[];
}

interface RawPositionComplexity {
  readonly count: number;
  readonly tooComplex: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positionsEqual(left: MonitoringPosition, right: MonitoringPosition): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function parsePosition(value: unknown): MonitoringPosition | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }
  const longitude = value[0];
  const latitude = value[1];
  if (
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude)
  ) {
    return undefined;
  }
  return [longitude, latitude];
}

function signedArea(ring: MonitoringPosition[]): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index]!;
    const next = ring[index + 1]!;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function orientation(
  first: MonitoringPosition,
  second: MonitoringPosition,
  third: MonitoringPosition,
): number {
  const cross =
    (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
  if (Math.abs(cross) < 1e-12) {
    return 0;
  }
  return cross > 0 ? 1 : -1;
}

function pointOnSegment(
  point: MonitoringPosition,
  start: MonitoringPosition,
  end: MonitoringPosition,
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
  firstStart: MonitoringPosition,
  firstEnd: MonitoringPosition,
  secondStart: MonitoringPosition,
  secondEnd: MonitoringPosition,
): boolean {
  const o1 = orientation(firstStart, firstEnd, secondStart);
  const o2 = orientation(firstStart, firstEnd, secondEnd);
  const o3 = orientation(secondStart, secondEnd, firstStart);
  const o4 = orientation(secondStart, secondEnd, firstEnd);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }
  return (
    (o1 === 0 && pointOnSegment(secondStart, firstStart, firstEnd)) ||
    (o2 === 0 && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (o3 === 0 && pointOnSegment(firstStart, secondStart, secondEnd)) ||
    (o4 === 0 && pointOnSegment(firstEnd, secondStart, secondEnd))
  );
}

function ringSelfIntersects(ring: MonitoringPosition[]): boolean {
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
          ring[firstIndex]!,
          ring[firstIndex + 1]!,
          ring[secondIndex]!,
          ring[secondIndex + 1]!,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function pointInRing(point: MonitoringPosition, ring: MonitoringPosition[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 2; index < ring.length - 1; previous = index++) {
    const currentPosition = ring[index]!;
    const previousPosition = ring[previous]!;
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

function spanKilometres(
  minimumLongitude: number,
  maximumLongitude: number,
  minimumLatitude: number,
  maximumLatitude: number,
): { width: number; height: number } {
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

function parseRing(value: unknown): { ring?: MonitoringPosition[]; error?: string } {
  if (!Array.isArray(value) || value.length < 4) {
    return { error: 'Each monitoringArea ring must contain at least four positions' };
  }
  const ring: MonitoringPosition[] = [];
  for (const rawPosition of value) {
    const position = parsePosition(rawPosition);
    if (!position) {
      return {
        error:
          'Every monitoringArea position must be exactly [longitude, latitude] with finite numbers',
      };
    }
    if (position[0] < -180 || position[0] > 180) {
      return { error: 'monitoringArea longitude must be between -180 and 180' };
    }
    if (position[1] < -90 || position[1] > 90) {
      return { error: 'monitoringArea latitude must be between -90 and 90' };
    }
    ring.push(position);
  }
  if (!positionsEqual(ring[0]!, ring[ring.length - 1]!)) {
    return { error: 'Every monitoringArea ring must be closed' };
  }
  if (ringSelfIntersects(ring)) {
    return { error: 'monitoringArea rings must not self-intersect' };
  }
  if (Math.abs(signedArea(ring)) < 1e-12) {
    return { error: 'monitoringArea rings must enclose a non-zero area' };
  }
  return { ring };
}

function parsePolygonCoordinates(value: unknown): { ring?: MonitoringPosition[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'monitoringArea Polygon coordinates must contain one exterior ring' };
  }
  if (value.length !== 1) {
    return { error: 'monitoringArea holes are not supported' };
  }
  return parseRing(value[0]);
}

function rawPositionComplexity(value: unknown): RawPositionComplexity {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    visitedNodes += 1;
    if (
      visitedNodes > MAX_MONITORING_COORDINATE_NODES ||
      current.depth > MAX_MONITORING_COORDINATE_DEPTH
    ) {
      return { count, tooComplex: true };
    }
    if (!Array.isArray(current.value)) {
      continue;
    }
    if (
      current.value.length === 2 &&
      typeof current.value[0] === 'number' &&
      typeof current.value[1] === 'number'
    ) {
      count += 1;
      if (count > MAX_MONITORING_VERTICES) {
        return { count, tooComplex: false };
      }
      continue;
    }
    for (let index = current.value.length - 1; index >= 0; index -= 1) {
      stack.push({ value: current.value[index], depth: current.depth + 1 });
    }
  }

  return { count, tooComplex: false };
}

function parseMonitoringArea(value: unknown): { parsed?: ParsedMonitoringArea; error?: string } {
  if (!isRecord(value)) {
    return { error: 'monitoringArea must be a GeoJSON geometry object' };
  }
  if (Object.keys(value).some((key) => !GEOMETRY_KEYS.has(key))) {
    return { error: 'monitoringArea accepts a GeoJSON geometry, not a Feature or extra members' };
  }
  const type = value['type'];
  const coordinates = value['coordinates'];
  const rings: MonitoringPosition[][] = [];
  const complexity = rawPositionComplexity(coordinates);
  if (complexity.tooComplex) {
    return { error: 'monitoringArea coordinates exceed structural complexity limits' };
  }
  if (complexity.count > MAX_MONITORING_VERTICES) {
    return { error: 'monitoringArea must contain no more than 500 vertices' };
  }

  if (type === 'Polygon') {
    const result = parsePolygonCoordinates(coordinates);
    if (result.error) {
      return { error: result.error };
    }
    rings.push(result.ring!);
  } else if (type === 'MultiPolygon') {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      return { error: 'monitoringArea MultiPolygon coordinates must contain polygons' };
    }
    for (const polygon of coordinates) {
      const result = parsePolygonCoordinates(polygon);
      if (result.error) {
        return { error: result.error };
      }
      rings.push(result.ring!);
    }
  } else {
    return { error: 'monitoringArea type must be Polygon or MultiPolygon' };
  }

  const positions = rings.flat();
  const longitudes = positions.map((position) => position[0]);
  const latitudes = positions.map((position) => position[1]);
  const span = spanKilometres(
    Math.min(...longitudes),
    Math.max(...longitudes),
    Math.min(...latitudes),
    Math.max(...latitudes),
  );
  if (span.width > MAX_MONITORING_BBOX_KM || span.height > MAX_MONITORING_BBOX_KM) {
    return { error: 'monitoringArea bounding box must not exceed 40 km by 40 km' };
  }

  const geometry: MonitoringAreaGeometry =
    type === 'Polygon'
      ? { type, coordinates: [rings[0]!] }
      : { type, coordinates: rings.map((ring) => [ring]) };
  return { parsed: { geometry, rings, positions } };
}

function isValidLocation(location: SiteLocation | null | undefined): location is SiteLocation {
  return (
    location !== null &&
    location !== undefined &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

export function monitoringAreaGeometryError(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return parseMonitoringArea(value).error;
}

export function siteMonitoringContractError(
  contract: SiteMonitoringValidationContract,
): string | undefined {
  if (!Number.isInteger(contract.monitoringRadiusM)) {
    return 'monitoringRadiusM must be an integer';
  }
  if (
    contract.monitoringRadiusM < MIN_MONITORING_RADIUS_M ||
    contract.monitoringRadiusM > MAX_MONITORING_RADIUS_M
  ) {
    return 'monitoringRadiusM must be between 100 and 20000 metres';
  }

  if (contract.type === SiteType.SEA_CAGE && !isValidLocation(contract.location)) {
    return 'SEA_CAGE sites require a location with valid latitude and longitude';
  }
  if (contract.location && !isValidLocation(contract.location)) {
    return 'Site location must contain valid latitude and longitude';
  }

  if (contract.monitoringArea !== null && contract.monitoringArea !== undefined) {
    const result = parseMonitoringArea(contract.monitoringArea);
    if (result.error) {
      return result.error;
    }
    if (!isValidLocation(contract.location)) {
      return 'monitoringArea requires a site location with valid latitude and longitude';
    }
    const point: MonitoringPosition = [contract.location.longitude, contract.location.latitude];
    if (!result.parsed!.rings.some((ring) => pointInRing(point, ring))) {
      return 'monitoringArea must contain the site location';
    }
  }

  return undefined;
}

function locationsEqual(
  left: SiteLocation | null | undefined,
  right: SiteLocation | null | undefined,
): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return (
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    left.altitude === right.altitude
  );
}

function coordinatesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' || typeof right === 'number') {
    return left === right;
  }
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => coordinatesEqual(value, right[index]));
}

function monitoringAreasEqual(
  left: MonitoringAreaGeometry | null | undefined,
  right: MonitoringAreaGeometry | null | undefined,
): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return left.type === right.type && coordinatesEqual(left.coordinates, right.coordinates);
}

export function monitoringLocationChanged(
  current: SiteMonitoringContract,
  next: SiteMonitoringContract,
): boolean {
  return (
    current.type !== next.type ||
    !locationsEqual(current.location, next.location) ||
    current.monitoringRadiusM !== next.monitoringRadiusM ||
    !monitoringAreasEqual(current.monitoringArea, next.monitoringArea)
  );
}

export function IsMonitoringArea(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isMonitoringArea',
      validator: {
        validate: (value: unknown): boolean => monitoringAreaGeometryError(value) === undefined,
        defaultMessage: (): string =>
          'monitoringArea must be a valid EPSG:4326 Polygon or MultiPolygon geometry',
      },
    },
    validationOptions,
  );
}
