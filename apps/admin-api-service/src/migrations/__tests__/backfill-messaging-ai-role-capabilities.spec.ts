import 'reflect-metadata';
import { BACKFILL } from '../1801300000000-BackfillMessagingAiRoleCapabilities';

/**
 * MT-HIGH-057 backfill snapshot integrity. The migration writes BOTH the
 * panel_permissions sub-tree AND the derived resource_permissions strings; the
 * two MUST agree (resource strings = every `${resource}:${action}` whose action
 * is true), exactly like the runtime panelPermissionsToResourceArray. A drift
 * between the two would grant a capability the FE shows but the guard denies (or
 * vice-versa). This locks them together without coupling to the auth-service
 * DEFAULT_ROLE_PERMISSIONS across services.
 */
function derivedResources(
  panel: Record<string, Record<string, Record<string, boolean>>>,
): string[] {
  const out: string[] = [];
  for (const resources of Object.values(panel)) {
    for (const [resource, actions] of Object.entries(resources)) {
      for (const [action, enabled] of Object.entries(actions)) {
        if (enabled) out.push(`${resource}:${action}`);
      }
    }
  }
  return out.sort();
}

describe('BackfillMessagingAiRoleCapabilities snapshot', () => {
  it('covers exactly the five shipped default roles', () => {
    expect(BACKFILL.map((r) => r.name).sort()).toEqual([
      'Feed Manager',
      'Operator',
      'Supervisor',
      'Technician',
      'Viewer',
    ]);
  });

  it.each(BACKFILL.map((r) => [r.name, r] as const))(
    'resource strings match the panel snapshot for %s',
    (_name, role) => {
      expect([...role.resources].sort()).toEqual(derivedResources(role.panel));
    },
  );

  it('resource strings are unique per role and use the resource:action format', () => {
    for (const role of BACKFILL) {
      expect(new Set(role.resources).size).toBe(role.resources.length);
      for (const r of role.resources) {
        expect(r).toMatch(/^[a-z0-9_]+:[a-z0-9_]+$/);
      }
    }
  });

  it('every role can chat and DM (WhatsApp-like floor); only Viewer cannot start groups', () => {
    for (const role of BACKFILL) {
      expect(role.resources).toEqual(
        expect.arrayContaining(['messages:send', 'ai_assistant:use', 'channels:create_dm']),
      );
    }
    const viewer = BACKFILL.find((r) => r.name === 'Viewer');
    expect(viewer?.resources).not.toContain('channels:create_group');
  });
});
