/**
 * Every viewer the console can face (FE-HIGH-335): each tenant role, each
 * subset of the four tenant modules, and — for a non-admin — each subset of
 * the permissions a nav page can require: the delegatable tenant capabilities
 * and the AI assistant's surface capability. A tenant admin holds every
 * permission (useAuth().hasPermission bypasses admins), so it gets one case
 * per module set.
 */
import type { MessageKey } from '@aquaculture/shared-ui';

import type { ConsoleNavInput, ConsoleRole, ModuleCode, NavPermission } from '../types';

export const ALL_MODULES: readonly ModuleCode[] = ['farm', 'hydroponics', 'sensor', 'hr'];
export const ALL_CAPABILITIES: readonly NavPermission[] = [
  'users:view',
  'roles:view',
  'settings:view',
  'ai_assistant:use',
];

export interface Viewer {
  readonly role: ConsoleRole;
  readonly modules: readonly ModuleCode[];
  readonly permissions: readonly NavPermission[];
}

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>(
    (acc, item) => [...acc, ...acc.map((subset) => [...subset, item])],
    [[]],
  );
}

export function allViewers(): Viewer[] {
  const moduleSets = subsets(ALL_MODULES);
  const capabilitySets = subsets(ALL_CAPABILITIES);
  return moduleSets.flatMap((modules): Viewer[] => [
    { role: 'TENANT_ADMIN', modules, permissions: ALL_CAPABILITIES },
    ...(['MODULE_MANAGER', 'MODULE_USER'] as const).flatMap((role) =>
      capabilitySets.map((permissions) => ({ role, modules, permissions })),
    ),
  ]);
}

/** Labels come back as `«key»` so a spec can tell a resolved label from a raw key. */
export const fakeT = (key: MessageKey): string => `«${key}»`;

export function navInput(viewer: Viewer): ConsoleNavInput {
  return {
    role: viewer.role,
    modules: viewer.modules.map((code) => ({ code })),
    hasPermission: (permission: string): boolean =>
      viewer.role === 'TENANT_ADMIN' || viewer.permissions.some((held) => held === permission),
    t: fakeT,
  };
}

export function describeViewer(viewer: Viewer): string {
  return `${viewer.role} modules=[${viewer.modules.join(',')}] caps=[${viewer.permissions.join(',')}]`;
}
