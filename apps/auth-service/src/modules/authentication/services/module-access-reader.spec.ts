import { Role } from '@aquaculture/backend-common/decorators';

import {
  readModuleAccess,
  type ModuleAccessPrincipal,
  type ModuleAccessQuery,
} from './module-access-reader';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

interface ModuleRow {
  readonly code: unknown;
  readonly name: unknown;
  readonly defaultRoute: unknown;
  readonly role?: unknown;
}

function row(code: string, role?: unknown): ModuleRow {
  return { code, name: `${code} module`, defaultRoute: `/${code}`, role };
}

/**
 * A query double that answers each of the three reads by the table it names and records every
 * call, so a spec can pin both the answer and the SQL that produced it.
 */
function queryAnswering(rows: {
  platform?: readonly ModuleRow[];
  tenant?: readonly ModuleRow[];
  member?: readonly ModuleRow[];
}): { query: ModuleAccessQuery; calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const query: ModuleAccessQuery = (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/gu, ' ').trim(), params });
    if (sql.includes('user_module_assignments')) return Promise.resolve(rows.member ?? []);
    if (sql.includes('tenant_modules')) return Promise.resolve(rows.tenant ?? []);
    return Promise.resolve(rows.platform ?? []);
  };
  return { query, calls };
}

function principal(role: Role, tenantId: string | null = TENANT_ID): ModuleAccessPrincipal {
  return { id: USER_ID, role, tenantId };
}

const NO_DROPS = { not_owner_module: 0, unknown_code: 0, role_missing: 0 };

/**
 * The module-access reader (ADR-051 §2; RBAC-HIGH-027, RBAC-MEDIUM-029): one reader for every
 * kind of caller. It joins tenant_modules.isEnabled for members as well as administrators,
 * narrows grants to owner modules, takes a member's role from the assignment row and never
 * from users.role, and counts every code it leaves out of the claim.
 */
describe('readModuleAccess (RBAC-HIGH-027, RBAC-MEDIUM-029)', () => {
  describe('a member', () => {
    it('takes each grant from its assignment row, narrowed to the owner modules', async () => {
      const { query } = queryAnswering({
        member: [
          row('farm', 'MODULE_MANAGER'),
          row('sensor', 'MODULE_USER'),
          row('alert', 'MODULE_USER'),
          row('ai', 'MODULE_MANAGER'),
          row('legacy-reports', 'MODULE_USER'),
        ],
      });

      const read = await readModuleAccess(query, principal(Role.MODULE_USER));

      expect(read.moduleAccess).toEqual({ farm: 'MODULE_MANAGER', sensor: 'MODULE_USER' });
      expect(read.dropped).toEqual({ ...NO_DROPS, not_owner_module: 2, unknown_code: 1 });
    });

    it('keeps alert and ai in the legacy modules list the R1 web still reads (C1)', async () => {
      const { query } = queryAnswering({
        member: [row('farm', 'MODULE_USER'), row('alert', 'MODULE_USER')],
      });

      const read = await readModuleAccess(query, principal(Role.MODULE_USER));

      expect(read.modules).toEqual([
        { code: 'farm', name: 'farm module', defaultRoute: '/farm' },
        { code: 'alert', name: 'alert module', defaultRoute: '/alert' },
      ]);
    });

    it('reads only assignments of the token tenant whose module the tenant still has enabled', async () => {
      const { query, calls } = queryAnswering({ member: [] });

      await readModuleAccess(query, principal(Role.MODULE_USER));

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.params).toEqual([USER_ID, TENANT_ID]);
      expect(call?.sql).toContain('FROM auth.user_module_assignments uma');
      expect(call?.sql).toContain(
        'JOIN auth.tenant_modules tm ON tm."tenantId" = uma."tenantId" AND tm."moduleId" = uma."moduleId"',
      );
      expect(call?.sql).toContain('tm."isEnabled" = true');
      expect(call?.sql).toContain('uma."userId" = $1 AND uma."tenantId" = $2');
      expect(call?.sql).toContain('uma."isActive" = true');
      expect(call?.sql).toContain('(uma."expiresAt" IS NULL OR uma."expiresAt" >= now())');
    });

    it('grants nothing for a row without a role, and counts it', async () => {
      const { query } = queryAnswering({
        member: [row('farm', null), row('hr', 'TENANT_ADMIN'), row('sensor', 'MODULE_USER')],
      });

      const read = await readModuleAccess(query, principal(Role.MODULE_USER));

      expect(read.moduleAccess).toEqual({ sensor: 'MODULE_USER' });
      expect(read.dropped).toEqual({ ...NO_DROPS, role_missing: 2 });
      expect(read.modules.map((module) => module.code)).toEqual(['farm', 'hr', 'sensor']);
    });

    it('never derives a grant from the global MODULE_MANAGER role: an hr row of MODULE_USER stays MODULE_USER', async () => {
      const { query } = queryAnswering({
        member: [row('hr', 'MODULE_USER'), row('farm', 'MODULE_MANAGER')],
      });

      const read = await readModuleAccess(query, principal(Role.MODULE_MANAGER));

      expect(read.moduleAccess).toEqual({ hr: 'MODULE_USER', farm: 'MODULE_MANAGER' });
    });

    it('holds no grant without assignments, whatever users.role says', async () => {
      const { query } = queryAnswering({ member: [] });

      const read = await readModuleAccess(query, principal(Role.MODULE_MANAGER));

      expect(read).toEqual({ moduleAccess: {}, modules: [], dropped: NO_DROPS });
    });

    it('reads nothing for a member without a tenant (the mint refuses such a principal)', async () => {
      const { query, calls } = queryAnswering({ member: [row('farm', 'MODULE_USER')] });

      const read = await readModuleAccess(query, principal(Role.MODULE_USER, null));

      expect(calls).toEqual([]);
      expect(read).toEqual({ moduleAccess: {}, modules: [], dropped: NO_DROPS });
    });
  });

  describe('TENANT_ADMIN', () => {
    it('manages every module the tenant has enabled, narrowed to the owner modules', async () => {
      const { query, calls } = queryAnswering({
        tenant: [row('farm'), row('hr'), row('alert'), row('ai'), row('sensor')],
      });

      const read = await readModuleAccess(query, principal(Role.TENANT_ADMIN));

      expect(read.moduleAccess).toEqual({
        farm: 'MODULE_MANAGER',
        hr: 'MODULE_MANAGER',
        sensor: 'MODULE_MANAGER',
      });
      expect(read.modules.map((module) => module.code)).toEqual([
        'farm',
        'hr',
        'alert',
        'ai',
        'sensor',
      ]);
      expect(read.dropped).toEqual({ ...NO_DROPS, not_owner_module: 2 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.params).toEqual([TENANT_ID]);
      expect(calls[0]?.sql).toContain('tm."isEnabled" = true');
      expect(calls[0]?.sql).not.toContain('user_module_assignments');
    });

    it('cannot reach hr in a tenant without hr', async () => {
      const { query } = queryAnswering({ tenant: [row('farm'), row('sensor')] });

      const read = await readModuleAccess(query, principal(Role.TENANT_ADMIN));

      expect(read.moduleAccess).toEqual({ farm: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' });
      expect('hr' in read.moduleAccess).toBe(false);
    });
  });

  describe('SUPER_ADMIN', () => {
    it('lists every active platform module and holds no grant (decideAccess gives the platform pass)', async () => {
      const { query, calls } = queryAnswering({
        platform: [row('farm'), row('hr'), row('alert')],
      });

      const read = await readModuleAccess(query, principal(Role.SUPER_ADMIN, null));

      expect(read.moduleAccess).toEqual({});
      expect(read.modules.map((module) => module.code)).toEqual(['farm', 'hr', 'alert']);
      expect(read.dropped).toEqual(NO_DROPS);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain('FROM auth.modules');
      expect(calls[0]?.sql).toContain('"isActive" = true');
    });
  });

  it('counts a row whose columns are not text as an unknown code and lists it nowhere', async () => {
    const { query } = queryAnswering({
      member: [{ code: 7, name: 'x', defaultRoute: '/x', role: 'MODULE_USER' }],
    });

    const read = await readModuleAccess(query, principal(Role.MODULE_USER));

    expect(read).toEqual({
      moduleAccess: {},
      modules: [],
      dropped: { ...NO_DROPS, unknown_code: 1 },
    });
  });

  it('returns a frozen read, so no caller can widen a claim after it was read', async () => {
    const { query } = queryAnswering({ member: [row('farm', 'MODULE_USER')] });

    const read = await readModuleAccess(query, principal(Role.MODULE_USER));

    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.moduleAccess)).toBe(true);
    expect(Object.isFrozen(read.modules)).toBe(true);
    expect(Object.isFrozen(read.dropped)).toBe(true);
  });
});
