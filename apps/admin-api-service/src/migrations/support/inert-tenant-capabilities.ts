/**
 * What migration 1810500000000-RemoveInertTenantCapabilities (RBAC-HIGH-025, plan PKG-03) removes
 * and how it reads the stored cells. Kept out of the migration file on purpose: TypeORM
 * instantiates every function a migration file exports, so a migration file exports its
 * migration class and nothing else (tests/invariants/migration-files-export-only-migrations).
 */

/** The keys PKG-03 removed from the catalogue: no backend check read any of them. */
export const INERT_TENANT_CAPABILITIES: readonly string[] = Object.freeze([
  // Farm Management
  'sites:view',
  'sites:create',
  'sites:edit',
  'sites:delete',
  'departments:view',
  'departments:create',
  'departments:edit',
  'departments:delete',
  'systems:view',
  'systems:create',
  'systems:edit',
  'systems:delete',
  'tanks:view',
  'tanks:create',
  'tanks:edit',
  'tanks:delete',
  'tanks:assign',
  'ponds:view',
  'ponds:create',
  'ponds:edit',
  'ponds:delete',
  'equipment:view',
  'equipment:create',
  'equipment:edit',
  'equipment:delete',
  'equipment:assign',
  // Batch & Production
  'batches:view',
  'batches:create',
  'batches:edit',
  'batches:delete',
  'batches:transfer',
  'batches:split',
  'batches:merge',
  'species:view',
  'species:create',
  'species:edit',
  'species:delete',
  'mortality:view',
  'mortality:record',
  'growth:view',
  'growth:record',
  'growth:analyze',
  'harvest:view',
  'harvest:plan',
  'harvest:record',
  // Operations
  'feeding:view',
  'feeding:record',
  'feeding:manage_schedules',
  'feeding:manage_inventory',
  'sensors:view',
  'sensors:configure',
  'sensors:calibrate',
  'sensors:manage_alerts',
  'maintenance:view',
  'maintenance:create_work_orders',
  'maintenance:complete',
  'maintenance:manage_schedules',
  'water_quality:view',
  'water_quality:record',
  // HR & Administration
  'employees:view',
  'employees:create',
  'employees:edit',
  'employees:delete',
  'attendance:view',
  'attendance:manage',
  'leave:view',
  'leave:approve',
  'shifts:view',
  'shifts:create',
  'shifts:edit',
  'shifts:delete',
  // Reports & Analytics
  'dashboard:view',
  'dashboard:analytics',
  'reports:view',
  'reports:export',
  'reports:create_custom',
  // Settings & User Management
  'settings:edit',
  // Messaging
  'channels:view',
  'channels:create_dm',
  'channels:manage',
  'messages:send',
]);

export const INERT: ReadonlySet<string> = new Set(INERT_TENANT_CAPABILITIES);

/** A role panel: category → resource → action → granted. */
export type Panel = Record<string, Record<string, Record<string, boolean>>>;

export interface OverrideSet {
  grants: string[];
  revokes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A jsonb cell as the driver returns it: an object, or its text. */
function jsonCell(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** The panel without the removed keys; a resource or category left empty is dropped. */
export function panelWithoutInert(panel: Panel): Panel {
  const result: Panel = {};
  for (const [category, resources] of Object.entries(panel)) {
    const keptResources: Record<string, Record<string, boolean>> = {};
    for (const [resource, actions] of Object.entries(resources)) {
      const kept = Object.fromEntries(
        Object.entries(actions).filter(([action]) => !INERT.has(`${resource}:${action}`)),
      );
      if (Object.keys(kept).length > 0) keptResources[resource] = kept;
    }
    if (Object.keys(keptResources).length > 0) result[category] = keptResources;
  }
  return result;
}

/** The stored panel as a panel, or `null` when the cell is not one (left untouched). */
export function readPanel(value: unknown): Panel | null {
  const cell = jsonCell(value);
  if (!isRecord(cell)) return null;
  const panel: Panel = {};
  for (const [category, resources] of Object.entries(cell)) {
    if (!isRecord(resources)) return null;
    panel[category] = {};
    for (const [resource, actions] of Object.entries(resources)) {
      if (!isRecord(actions)) return null;
      const typed: Record<string, boolean> = {};
      for (const [action, granted] of Object.entries(actions)) {
        if (typeof granted !== 'boolean') return null;
        typed[action] = granted;
      }
      panel[category][resource] = typed;
    }
  }
  return panel;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The overrides without the removed keys, or `null` when they hold none. */
export function overridesWithoutInert(value: unknown): OverrideSet | null {
  const cell = jsonCell(value);
  if (!isRecord(cell)) return null;
  const grants = stringList(cell['grants']);
  const revokes = stringList(cell['revokes']);
  if (![...grants, ...revokes].some((key) => INERT.has(key))) return null;
  return {
    grants: grants.filter((key) => !INERT.has(key)),
    revokes: revokes.filter((key) => !INERT.has(key)),
  };
}

/** How many override entries a cell holds, removed keys included. */
export function overrideEntryCount(value: unknown): number {
  const cell = jsonCell(value);
  if (!isRecord(cell)) return 0;
  return stringList(cell['grants']).length + stringList(cell['revokes']).length;
}
