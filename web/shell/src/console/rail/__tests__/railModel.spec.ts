/**
 * The built console nav IS the rail's model (FE-HIGH-335 → IndustrialRail).
 *
 * WHY: IndustrialRail renders `RailWorkspace` and the shell hands it
 * buildConsoleNav's output with no adapter in between, so the two shapes must
 * stay assignable — `asRail` below stops compiling the day they drift — and
 * every icon an area names must have a component in the rail's vocabulary.
 */
import {
  CONSOLE_RAIL_ICONS,
  CONSOLE_WORKSPACE_IDS,
  type MessageKey,
  type RailWorkspace,
} from '@aquaculture/shared-ui';
import { describe, expect, it } from 'vitest';

import { buildConsoleNav, CONSOLE_WORKSPACES, type Workspace } from '../../nav';

/** Compile-time: a built workspace is a rail workspace as it is. */
function asRail(workspaces: readonly Workspace[]): readonly RailWorkspace[] {
  return workspaces;
}

describe('console nav → rail model', () => {
  it('names only icons the rail can draw', () => {
    for (const workspace of CONSOLE_WORKSPACES) {
      for (const area of workspace.areas) {
        expect(Object.keys(CONSOLE_RAIL_ICONS)).toContain(area.icon);
      }
    }
  });

  it('declares the workspaces the rail knows, in its order', () => {
    expect(CONSOLE_WORKSPACES.map((workspace) => workspace.id)).toEqual([...CONSOLE_WORKSPACE_IDS]);
  });

  it('hands the rail every workspace a full tenant admin sees, unchanged', () => {
    const built = buildConsoleNav({
      modules: ['farm', 'hydroponics', 'sensor', 'hr'].map((code) => ({ code })),
      role: 'TENANT_ADMIN',
      hasPermission: () => true,
      t: (key: MessageKey) => key,
    });
    const rail = asRail(built);
    expect(rail.map((workspace) => workspace.id)).toEqual([...CONSOLE_WORKSPACE_IDS]);
    expect(rail.every((workspace) => workspace.areas.length > 0)).toBe(true);
  });
});
