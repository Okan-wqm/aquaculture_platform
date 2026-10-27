import {
  eventModuleRooms,
  memberModuleRooms,
  memberRegistryRooms,
  registryRoom,
  type ModuleSocketRoom,
  type SocketMember,
} from '@aquaculture/backend-common/websocket';
import type {
  ModuleAccessSpec,
  NonEmptyReadonlyArray,
  OwnerModuleCode,
  ScopedAccessSpec,
} from '@aquaculture/shared-contracts';
import type { FarmEventType } from '@platform/event-contracts';

/**
 * The access spec of every farm event the /farms socket pushes (SEC-CRITICAL-206; ADR-051 §3
 * step 1, ADR-052).
 *
 * WHY: the bridge forwarded 41 farm events to one `tenant:{id}` room, so every tenant member who
 * opened /farms received batches, mortality, feeding, meals, stock, tanks and sites, whatever
 * their module (D2). This map is now the one list of bridged events: the bridge subscribes to its
 * keys, the gateway emits only a key of it, and the rooms of an emit derive from the entry, so a
 * farm-private event cannot reach a tenant-wide room and an event without an entry is not pushed.
 *
 * WHAT:
 *   - farm-private (`module('farm')`): the farm module room, plus the room of the event's site
 *     when the event's wire schema carries `siteId` (`site: 'siteId'`). An event without a site
 *     reaches members tenant-wide in farm only; a site-bound operator never sees it.
 *     `farm-ws-event-access.spec.ts` holds `site` equal to the wire schema, so a producer that
 *     adds `siteId` makes the spec ask for the entry to follow. The fourteen `NO_SITE`
 *     farm-private events besides LowStockDetected (FARM-HIGH-336) get their site under
 *     FARM-HIGH-483, consumer schema first, then the producers (C5).
 *   - registry kinds (`scoped('common-registry')`): sites, site departments, site contacts and
 *     supplier sites, sent to the registry room of the module that owns the rows. Every registry
 *     row is farm's until PKG-16 puts the module on the event (ADR-052 Decision 5).
 */
type FarmModuleSpec = ModuleAccessSpec & { readonly module: 'farm' };
type CommonRegistrySpec = ScopedAccessSpec & { readonly scope: 'common-registry' };

/** A farm-private event, attributed to the site its `siteId` names when the schema carries one. */
export interface FarmPrivateEventAccess {
  readonly spec: FarmModuleSpec;
  readonly site: 'siteId' | null;
}

/** A registry event, sent to the registry room of the module that owns the row. */
export interface FarmRegistryEventAccess {
  readonly spec: CommonRegistrySpec;
  readonly owner: OwnerModuleCode;
}

export type FarmWsEventAccess = FarmPrivateEventAccess | FarmRegistryEventAccess;

/** The schema-validated event the bridge forwards, sent to clients unchanged. */
export type FarmWsEvent = Readonly<Record<string, unknown>>;

const FARM: FarmModuleSpec = Object.freeze({ kind: 'module', module: 'farm' });
const COMMON_REGISTRY: CommonRegistrySpec = Object.freeze({
  kind: 'scoped',
  scope: 'common-registry',
});

const ON_SITE: FarmPrivateEventAccess = Object.freeze({ spec: FARM, site: 'siteId' });
const NO_SITE: FarmPrivateEventAccess = Object.freeze({ spec: FARM, site: null });
const FARM_REGISTRY: FarmRegistryEventAccess = Object.freeze({
  spec: COMMON_REGISTRY,
  owner: 'farm',
});

export const FARM_WS_EVENT_ACCESS = Object.freeze({
  BatchCreated: NO_SITE,
  BatchHarvested: ON_SITE,
  BatchTransferred: ON_SITE,
  BatchStatusChanged: ON_SITE,
  BatchClosed: ON_SITE,
  BatchAllocatedToTank: ON_SITE,
  MortalityRecorded: ON_SITE,
  CullRecorded: ON_SITE,
  FeedingRecorded: NO_SITE,
  FeedInventoryLow: ON_SITE,
  LowStockDetected: NO_SITE,
  SiteCreated: FARM_REGISTRY,
  SiteUpdated: FARM_REGISTRY,
  SiteDeleted: FARM_REGISTRY,
  DepartmentCreated: FARM_REGISTRY,
  DepartmentUpdated: FARM_REGISTRY,
  DepartmentDeleted: FARM_REGISTRY,
  SystemCreated: ON_SITE,
  SystemUpdated: ON_SITE,
  SystemDeleted: ON_SITE,
  SiteContactsChanged: FARM_REGISTRY,
  TankCreated: NO_SITE,
  TankUpdated: NO_SITE,
  TankStatusChanged: NO_SITE,
  TankDeleted: NO_SITE,
  EquipmentCreated: ON_SITE,
  EquipmentUpdated: ON_SITE,
  EquipmentDeleted: ON_SITE,
  SubEquipmentCreated: NO_SITE,
  SubEquipmentUpdated: NO_SITE,
  SubEquipmentDeleted: NO_SITE,
  SupplierApprovedSitesChanged: FARM_REGISTRY,
  FeederCalibrationsSaved: NO_SITE,
  // Harvest follow-up lifecycle signals: a final harvest frees a tank and completes the batch.
  TankCleared: NO_SITE,
  BatchProductionCompleted: NO_SITE,
  // Meal-based feeding engine v2: the MealBoard and mobile meal surfaces render these live. The
  // batched MealWindowUpcoming is an automation hook for sensor-service, not a UI signal.
  MealFed: NO_SITE,
  MealSkipped: NO_SITE,
  MealMissed: ON_SITE,
  MealUnderfed: ON_SITE,
  FeedTypeTransitioned: ON_SITE,
  UnfedUnitDetected: ON_SITE,
} satisfies { readonly [E in FarmEventType]?: FarmWsEventAccess });

export type FarmWsEventType = keyof typeof FARM_WS_EVENT_ACCESS;

export function isFarmWsEventType(value: string): value is FarmWsEventType {
  return Object.prototype.hasOwnProperty.call(FARM_WS_EVENT_ACCESS, value);
}

/** The bridged farm events, in the map's order. */
export const FARM_WS_EVENT_TYPES: readonly FarmWsEventType[] = Object.freeze(
  Object.keys(FARM_WS_EVENT_ACCESS).filter(isFarmWsEventType),
);

/** The name clients listen for: the event type with a lower-case first letter. */
export function farmSocketEventName(type: FarmWsEventType): string {
  return `${type.charAt(0).toLowerCase()}${type.slice(1)}`;
}

function siteOf(access: FarmPrivateEventAccess, event: FarmWsEvent): string | null {
  if (access.site === null) return null;
  const site = event[access.site];
  return typeof site === 'string' && site.length > 0 ? site : null;
}

/** The rooms an emit of `type` reaches, derived from its entry. */
export function farmEventRooms(
  tenantId: string,
  type: FarmWsEventType,
  event: FarmWsEvent,
): NonEmptyReadonlyArray<ModuleSocketRoom> {
  const access: FarmWsEventAccess = FARM_WS_EVENT_ACCESS[type];
  if ('owner' in access) return [registryRoom(tenantId, access.owner)];
  return eventModuleRooms(tenantId, access.spec.module, siteOf(access, event));
}

/** The rooms a /farms socket joins: farm rooms of its scope and registry rooms of its grants. */
export function farmSocketRooms(member: SocketMember): readonly ModuleSocketRoom[] {
  return [...memberModuleRooms(member, 'farm'), ...memberRegistryRooms(member)];
}
