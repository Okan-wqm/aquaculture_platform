import 'reflect-metadata';
import { BACKFILL } from '../1808600000000-BackfillAiSpecialtyRoleCapabilities';

/**
 * RBAC-MEDIUM-016 backfill snapshot integrity — same contract as the
 * MT-HIGH-057 spec: the panel sub-tree and the derived resource strings MUST
 * agree, exactly like the runtime panelPermissionsToResourceArray, so the FE
 * never shows a capability the guard denies (or vice-versa).
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

  it.each(BACKFILL.map((r) => [r.name, r] as const))(
    'resource strings match the panel snapshot for %s',
    (_name, role) => {
      expect([...role.resources].sort()).toEqual(derivedResources(role.panel));
    },
  );

  it('grants exactly ai_specialties:farm to every seeded role (tier grants bound the rest)', () => {
    for (const role of BACKFILL) {
      expect([...role.resources]).toEqual(['ai_specialties:farm']);
      expect(Object.keys(role.panel)).toEqual(['ai_specialists']);
    }
  });
});
