import type {
  DevicePlacementUnitKind,
  ResolveDevicePlacementRequest,
  ResolveDevicePlacementResponse,
} from '@platform/event-contracts';

/**
 * What farm knows about each level a placement names, read in the tenant's
 * boundary by the responder. A level the request does not name is null; a
 * level it names that does not exist, or is not live, is null too — farm
 * refuses both the same way, so the reply cannot tell a deleted unit from
 * another tenant's.
 */
export interface DevicePlacementFacts {
  readonly siteLive: boolean;
  readonly department: { readonly siteId: string | null } | null;
  readonly system: { readonly siteId: string; readonly departmentId: string | null } | null;
  readonly unit: {
    readonly kind: DevicePlacementUnitKind;
    readonly departmentId: string | null;
    /** Every system the unit is in: a tank's own, and each equipment-system link. */
    readonly systemIds: ReadonlySet<string>;
  } | null;
}

/**
 * Whether a device may stand at the place a request names: every level named
 * is live and belongs to the levels above it that are named too. The first
 * level that fails is the answer; a placeable request carries the unit's kind
 * (null when no unit is named), which decides whether the device records it as
 * a tank or as equipment.
 *
 * - A system or a unit is named with its department: farm places both under
 *   a department, so a request without one is refused at the department.
 * - A system with no department spans its site, so it fits any department of
 *   that site.
 * - A unit belongs to the named department, and to the named system only by
 *   farm's own links.
 */
export function judgeDevicePlacement(
  request: ResolveDevicePlacementRequest,
  facts: DevicePlacementFacts,
): ResolveDevicePlacementResponse {
  if (!facts.siteLive) {
    return { placeable: false, refusedAt: 'SITE' };
  }
  if (request.departmentId === null) {
    if (request.systemId !== null || request.unitId !== null) {
      return { placeable: false, refusedAt: 'DEPARTMENT' };
    }
  } else if (facts.department === null || facts.department.siteId !== request.siteId) {
    return { placeable: false, refusedAt: 'DEPARTMENT' };
  }
  if (request.systemId !== null) {
    const system = facts.system;
    if (
      system === null ||
      system.siteId !== request.siteId ||
      (request.departmentId !== null &&
        system.departmentId !== null &&
        system.departmentId !== request.departmentId)
    ) {
      return { placeable: false, refusedAt: 'SYSTEM' };
    }
  }
  if (request.unitId === null) {
    return { placeable: true, unitKind: null };
  }
  const unit = facts.unit;
  if (
    unit === null ||
    unit.departmentId !== request.departmentId ||
    (request.systemId !== null && !unit.systemIds.has(request.systemId))
  ) {
    return { placeable: false, refusedAt: 'UNIT' };
  }
  return { placeable: true, unitKind: unit.kind };
}
