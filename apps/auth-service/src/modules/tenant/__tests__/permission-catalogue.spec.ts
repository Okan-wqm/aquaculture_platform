import 'reflect-metadata';
import { PERMISSION_CATEGORIES } from '../services/tenant-role.service';

/**
 * Faz 7 — messaging + AI capabilities added to the RBAC catalogue SSoT.
 *
 * PERMISSION_CATEGORIES is the single catalogue the tenant-admin role editor
 * (permissionCategories query), token-mint resolution, and TenantPermissionGuard
 * all consume. The wire permission string is `${resourceKey}:${action}`, so
 * resource keys MUST be globally unique across categories — a collision would
 * silently merge permissions between unrelated features. These specs lock the
 * new messaging/AI coverage in and guard that invariant (previously unguarded).
 */
describe('PERMISSION_CATEGORIES — messaging + AI coverage (Faz 7)', () => {
  it('includes a Messaging category with channel + message capabilities', () => {
    const messaging = PERMISSION_CATEGORIES.messaging;
    expect(messaging).toBeDefined();
    expect(messaging.resources.channels.actions).toEqual(
      expect.arrayContaining(['view', 'create_group', 'create_dm', 'manage']),
    );
    expect(messaging.resources.messages.actions).toContain('send');
  });

  it('includes an AI category with chat, settings, and persona-tier capabilities', () => {
    const ai = PERMISSION_CATEGORIES.ai;
    expect(ai).toBeDefined();
    expect(ai.resources.ai_assistant.actions).toContain('use');
    expect(ai.resources.ai_settings.actions).toEqual(
      expect.arrayContaining(['view', 'manage']),
    );
    expect(ai.resources.ai_personas.actions).toEqual(
      expect.arrayContaining(['operator', 'manager', 'expert', 'supervisor']),
    );
  });

  it('every resource key is globally unique across categories (permission strings are resourceKey:action)', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [categoryKey, category] of Object.entries(PERMISSION_CATEGORIES)) {
      for (const resourceKey of Object.keys(category.resources)) {
        const prior = seen.get(resourceKey);
        if (prior) {
          collisions.push(`${resourceKey} in both "${prior}" and "${categoryKey}"`);
        } else {
          seen.set(resourceKey, categoryKey);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('AI settings does NOT reuse the admin "settings" key (would collide into settings:manage)', () => {
    // Regression guard for the specific near-miss: AI settings must be a
    // distinct resource key so `settings:*` stays admin-only.
    expect(PERMISSION_CATEGORIES.ai.resources).not.toHaveProperty('settings');
    expect(PERMISSION_CATEGORIES.ai.resources).toHaveProperty('ai_settings');
  });
});
