import 'reflect-metadata';
import {
  AI_PERSONA_CATALOGUE,
  AI_SPECIALTY_MODULE_CODES,
  TENANT_CAPABILITY_CATALOGUE,
} from '@aquaculture/shared-contracts';
import {
  CATALOGUE_CAPABILITIES,
  entitledCapabilities,
  entitledPermissionCategories,
  isKnownCapability,
  requiredModulesFor,
} from '../services/permission-catalogue';

/**
 * TENANT_CAPABILITY_CATALOGUE is the single catalogue the tenant-admin role editor
 * (permissionCategories query), token-mint resolution, and TenantPermissionGuard
 * all consume. The wire permission string is `${resourceKey}:${action}`, so
 * resource keys MUST be globally unique across categories — a collision would
 * silently merge permissions between unrelated features.
 *
 * PKG-03 (RBAC-HIGH-025, RBAC-MEDIUM-026): the catalogue offers only keys a check
 * reads, `company:view` and `edge_devices:manage_io_config`; auth's whitelist,
 * entitlement and editor view follow it with no list of their own.
 */
describe('TENANT_CAPABILITY_CATALOGUE as auth reads it', () => {
  it('whitelists exactly the catalogue capabilities', () => {
    expect(isKnownCapability('company:view')).toBe(true);
    expect(isKnownCapability('edge_devices:manage_io_config')).toBe(true);
    expect(isKnownCapability('channels:create_group')).toBe(true);
    // No backend check read them: a grant of one restricted nothing (RBAC-HIGH-025).
    expect(isKnownCapability('batches:create')).toBe(false);
    expect(isKnownCapability('employees:view')).toBe(false);
    expect(isKnownCapability('channels:view')).toBe(false);
    expect(isKnownCapability('edge:manage-io-config')).toBe(false);
  });

  it('every resource key is globally unique across categories (permission strings are resourceKey:action)', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [categoryKey, category] of Object.entries(TENANT_CAPABILITY_CATALOGUE)) {
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
    expect(TENANT_CAPABILITY_CATALOGUE.ai.resources).not.toHaveProperty('settings');
    expect(TENANT_CAPABILITY_CATALOGUE.ai.resources).toHaveProperty('ai_settings');
  });
});

/**
 * RBAC-HIGH-010 third enforcement point — the role-editor catalogue view is
 * derived from the SAME entitlement SSoT as the write boundary and token mint,
 * so the UI can never offer a capability the write path rejects.
 */
describe('entitledPermissionCategories — UI catalogue entitlement filter', () => {
  it('with full entitlement, reproduces the entire catalogue verbatim', () => {
    const view = entitledPermissionCategories(CATALOGUE_CAPABILITIES);

    expect(Object.keys(view).sort()).toEqual(Object.keys(TENANT_CAPABILITY_CATALOGUE).sort());
    for (const [categoryKey, category] of Object.entries(TENANT_CAPABILITY_CATALOGUE)) {
      for (const [resourceKey, resource] of Object.entries(category.resources)) {
        expect(view[categoryKey]!.resources[resourceKey]!.actions).toEqual(resource.actions);
      }
    }
  });

  it('with core-only entitlement, drops the module-gated categories wholesale and keeps the core ones intact', () => {
    const view = entitledPermissionCategories(entitledCapabilities(new Set()));

    // Module-gated categories are ABSENT — not rendered as empty groups.
    expect(view).not.toHaveProperty('hr');
    expect(view).not.toHaveProperty('sensor');
    expect(view).not.toHaveProperty('ai');
    expect(view).not.toHaveProperty('ai_specialists');
    // Core categories keep their full action sets: the Company layer belongs to every tenant.
    expect(Object.keys(view)).toEqual(['company', 'admin', 'messaging']);
    for (const categoryKey of ['company', 'admin', 'messaging'] as const) {
      const source = TENANT_CAPABILITY_CATALOGUE[categoryKey];
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
    expect(view).not.toHaveProperty('sensor');
    // ai alone is not enough for the specialists — they also need their own module.
    expect(view).not.toHaveProperty('ai_specialists');
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

describe('module entitlement per capability', () => {
  it('company:view is core: every tenant has the Company layer', () => {
    expect(requiredModulesFor('company:view')).toBeUndefined();
    expect(entitledCapabilities(new Set()).has('company:view')).toBe(true);
  });

  it('edge_devices:manage_io_config needs the sensor module (RBAC-MEDIUM-026)', () => {
    expect(requiredModulesFor('edge_devices:manage_io_config')).toEqual(['sensor']);
    expect(entitledCapabilities(new Set()).has('edge_devices:manage_io_config')).toBe(false);
    expect(entitledCapabilities(new Set(['sensor'])).has('edge_devices:manage_io_config')).toBe(
      true,
    );
  });

  it('single-module gates are unchanged', () => {
    expect(requiredModulesFor('ai_personas:expert')).toEqual(['ai']);
    expect(requiredModulesFor('hr_finance:view_salary')).toEqual(['hr']);
    expect(requiredModulesFor('users:view')).toBeUndefined();
  });
});

/**
 * RBAC-MEDIUM-016 — module-scoped AI specialists. The capability that gates a
 * specialist persona is entitled only when BOTH the ai module and the
 * specialty's own module are enabled (all-of). The specialty modules come from
 * the AI catalogue (plan PKG-03), and so does each one's module gate.
 */
describe('ai_specialists — all-of module entitlement (RBAC-MEDIUM-016)', () => {
  it('offers one ai_specialties action per module a published specialty requires', () => {
    expect(TENANT_CAPABILITY_CATALOGUE.ai_specialists.resources.ai_specialties.actions).toEqual([
      ...AI_SPECIALTY_MODULE_CODES,
    ]);
    expect(isKnownCapability('ai_specialties:farm')).toBe(true);
  });

  it.each([...AI_SPECIALTY_MODULE_CODES])(
    'ai_specialties:%s requires the ai module AND its own module — either missing strips it',
    (module) => {
      const capability = `ai_specialties:${module}`;
      expect(requiredModulesFor(capability)).toEqual(['ai', module]);
      expect(entitledCapabilities(new Set(['ai'])).has(capability)).toBe(false);
      expect(entitledCapabilities(new Set([module])).has(capability)).toBe(false);
      expect(entitledCapabilities(new Set(['ai', module])).has(capability)).toBe(true);
    },
  );

  it('the role editor offers the category only with both modules', () => {
    const view = entitledPermissionCategories(entitledCapabilities(new Set(['ai', 'farm'])));
    expect(view.ai_specialists!.resources['ai_specialties']!.actions).toEqual(['farm']);
  });

  it('every capability the persona catalogue requires is a catalogue capability (SSoT cross-check)', () => {
    for (const entry of AI_PERSONA_CATALOGUE) {
      for (const capability of entry.requiredCapabilities) {
        expect(isKnownCapability(capability)).toBe(true);
      }
    }
  });
});
