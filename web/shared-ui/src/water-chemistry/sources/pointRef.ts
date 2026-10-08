/**
 * A measurement point — a site, a system (loop), a tank or non-tank water
 * equipment — in the three spellings the water-chemistry views meet it in:
 * the GraphQL input (exactly one id), the GraphQL result (`kind` as the enum
 * NAME, e.g. SYSTEM) and the URL (`tank:<uuid>`, so a fix link opens the
 * binding UI at the right point).
 */
import type { MeasurementPointInput, MeasurementPointKind } from '../../generated/graphql-types';

export type PointKind = 'site' | 'system' | 'tank' | 'equipment';

export interface PointRef {
  readonly kind: PointKind;
  readonly id: string;
}

const POINT_KINDS: readonly PointKind[] = ['site', 'system', 'tank', 'equipment'];

const KIND_OF_RESULT: Readonly<Record<MeasurementPointKind, PointKind>> = {
  SITE: 'site',
  SYSTEM: 'system',
  TANK: 'tank',
  EQUIPMENT: 'equipment',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPointKind(value: string): value is PointKind {
  return (POINT_KINDS as readonly string[]).includes(value);
}

/** The GraphQL input naming exactly this point. */
export function pointInput(point: PointRef): MeasurementPointInput {
  switch (point.kind) {
    case 'site':
      return { siteId: point.id };
    case 'system':
      return { systemId: point.id };
    case 'tank':
      return { tankId: point.id };
    case 'equipment':
      return { equipmentId: point.id };
  }
}

/** A point as the API returns it (kind is the enum name). */
export function pointOfResult(result: { kind: MeasurementPointKind; id: string }): PointRef {
  return { kind: KIND_OF_RESULT[result.kind], id: result.id };
}

/** The URL form, `tank:<uuid>`. */
export function formatPointRef(point: PointRef): string {
  return `${point.kind}:${point.id}`;
}

/** The point a URL value names, or null when it names none (unknown kind, not a UUID). */
export function parsePointRef(value: string | null): PointRef | null {
  if (value === null) return null;
  const separator = value.indexOf(':');
  if (separator < 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!isPointKind(kind) || !UUID.test(id)) return null;
  return { kind, id };
}

/** Whether two refs name the same point. */
export function samePoint(a: PointRef | null, b: PointRef | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.id === b.id;
}

/** The point a source row stands at: the one id it carries. */
export function pointOfSource(source: {
  readonly siteId: string | null;
  readonly systemId: string | null;
  readonly tankId: string | null;
  readonly equipmentId: string | null;
}): PointRef | null {
  if (source.tankId !== null) return { kind: 'tank', id: source.tankId };
  if (source.equipmentId !== null) return { kind: 'equipment', id: source.equipmentId };
  if (source.systemId !== null) return { kind: 'system', id: source.systemId };
  if (source.siteId !== null) return { kind: 'site', id: source.siteId };
  return null;
}
