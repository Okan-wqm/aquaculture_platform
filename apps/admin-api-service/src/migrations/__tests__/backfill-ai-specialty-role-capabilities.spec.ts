import 'reflect-metadata';
import { BACKFILL } from '../1808300000000-BackfillAiSpecialtyRoleCapabilities';

/**
 * FARM-AI PR-1 backfill snapshot integrity — same discipline as
 * backfill-messaging-ai-role-capabilities.spec.ts: the migration writes BOTH
 * the panel_permissions sub-tree AND the derived resource_permissions strings;
 * the two MUST agree exactly like the runtime panelPermissionsToResourceArray.
 * Also pins the five-role coverage and the additive-merge safety shape.
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

describe('BackfillAiSpecialtyRoleCapabilities snapshot', () => {
  it('covers exactly the five shipped default roles', () => {
    expect(BACKFILL.map((r) => r.name).sort()).toEqual([
      'Feed Manager',
      'Operator',
      'Supervisor',
      'Technician',
      'Viewer',
    ]);
  });

  it('panel and resources agree (derived == declared) for every role', () => {
    for (const role of BACKFILL) {
      expect(role.resources).toEqual(derivedResources(role.panel));
    }
  });

  it('grants exactly the single farm-specialty capability — nothing else', () => {
    for (const role of BACKFILL) {
      expect(role.resources).toEqual(['ai_specialties:farm']);
      expect(Object.keys(role.panel)).toEqual(['ai_specialists']);
    }
  });
});
