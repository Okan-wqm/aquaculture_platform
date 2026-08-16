import 'reflect-metadata';
import {
  CATALOGUE_CAPABILITIES,
  entitledCapabilities,
  entitledPermissionCategories,
} from '../services/permission-catalogue';
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

/**
 * RBAC-HIGH-010 third enforcement point — the role-editor catalogue view is
 * derived from the SAME entitlement SSoT as the write boundary and token mint,
 * so the UI can never offer a capability the write path rejects.
 */
describe('entitledPermissionCategories — UI catalogue entitlement filter', () => {
  it('with full entitlement, reproduces the entire catalogue verbatim', () => {
    const view = entitledPermissionCategories(new Set(CATALOGUE_CAPABILITIES));

    expect(Object.keys(view).sort()).toEqual(Object.keys(PERMISSION_CATEGORIES).sort());
    for (const [categoryKey, category] of Object.entries(PERMISSION_CATEGORIES)) {
      for (const [resourceKey, resource] of Object.entries(category.resources)) {
        expect(view[categoryKey]!.resources[resourceKey]!.actions).toEqual(resource.actions);
      }
    }
  });

  it('with core-only entitlement, drops hr/ai wholesale and keeps every core category intact', () => {
    const view = entitledPermissionCategories(entitledCapabilities(new Set()));

    // Module-gated categories are ABSENT — not rendered as empty groups.
    expect(view).not.toHaveProperty('hr');
    expect(view).not.toHaveProperty('ai');
    // Core categories keep their full action sets.
    for (const categoryKey of ['farm', 'batch', 'operations', 'reports', 'admin', 'messaging']) {
      expect(view[categoryKey]).toBeDefined();
      const source = PERMISSION_CATEGORIES[categoryKey as keyof typeof PERMISSION_CATEGORIES];
      for (const [resourceKey, resource] of Object.entries(source.resources)) {
        expect(view[categoryKey]!.resources[resourceKey]!.actions).toEqual(resource.actions);
      }
    }
  });

  it('a single enabled module re-admits exactly its own category', () => {
    const view = entitledPermissionCategories(entitledCapabilities(new Set(['ai'])));

    expect(view.ai).toBeDefined();
    expect(view.ai!.resources['ai_settings']!.actions).toEqual(
      expect.arrayContaining(['view', 'manage']),
    );
    expect(view).not.toHaveProperty('hr');
  });

  it('offers no capability outside the entitled set (UI ⊆ write-boundary invariant)', () => {
    const entitled = entitledCapabilities(new Set(['hr']));
    const view = entitledPermissionCategories(entitled);

    for (const category of Object.values(view)) {
      for (const [resourceKey, resource] of Object.entries(category.resources)) {
        for (const action of resource.actions) {
          expect(entitled.has(`${resourceKey}:${action}`)).toBe(true);
        }
      }
    }
  });
});
