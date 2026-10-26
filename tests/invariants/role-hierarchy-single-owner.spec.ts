/**
 * INVARIANT: the access vocabulary has one owner, `libs/shared-contracts/src/access/`
 * (RBAC-MEDIUM-024; ADR-051 §1, plan PKG-02).
 *
 * Before it, every surface typed its own: backend-common held `ROLE_HIERARCHY`, the web copied it
 * "matching backend", auth kept an unused `ROLE_LEVELS` (with a `VIEWER` no role has), the invite
 * check ranked roles by hand, the user entity and the messaging resolver each listed the roles in
 * privilege order, the mobile app kept a `ROLE_RANK` mirror, the web declared `UserRole` three
 * times, the SUPER_ADMIN/TENANT_ADMIN capability bypass was written twice, and the capability
 * catalogue was a literal no other workspace could import. A change to one copy silently
 * diverged from the others.
 *
 *   1. The one hierarchy is `PLATFORM_ROLES_BY_PRIVILEGE` (platform-roles.ts). The backend `Role`
 *      enum spells exactly its roles, and `roleHasPermission` answers exactly as it does.
 *   2. No product source outside the owner declares a hierarchy map, a privilege-ordered role list
 *      or a union of role literals (specs, migrations and generated code are exempt: generated
 *      unions come from the GraphQL schema the `Role` enum builds).
 *   3. The capability check (with its account-role bypass) is `holdsTenantCapabilities`, read by
 *      the backend and the web; the catalogue literal lives only in tenant-capabilities.ts.
 */
import {
  PLATFORM_ROLES_BY_PRIVILEGE,
  TENANT_CAPABILITY_CATALOGUE,
  platformRoleSatisfies,
} from '@aquaculture/shared-contracts';
import ts from 'typescript';

import { Role, roleHasPermission } from '../../libs/backend-common/src/decorators/roles.decorator';

import { readRepoFile, trackedFiles } from './helpers/module-dictionary-sources';
import { codeOf, roleVocabularyCopies } from './helpers/role-hierarchy-sources';

const OWNER = 'libs/shared-contracts/src/access/platform-roles.ts';
const BACKEND_CAPABILITY_CHECK =
  'libs/backend-common/src/decorators/require-permission.decorator.ts';
const WEB_CAPABILITY_CHECK = 'web/shared-ui/src/utils/tenant-capabilities.ts';
const AUTH_CATALOGUE = 'apps/auth-service/src/modules/tenant/services/permission-catalogue.ts';
const SOURCE_ROOTS = ['apps', 'libs', 'platform', 'web', 'mcp'];
const ROLES: ReadonlySet<string> = new Set(PLATFORM_ROLES_BY_PRIVILEGE);

/** Test code, migrations and generated files state facts about a moment, not the vocabulary. */
function isVocabularySource(file: string): boolean {
  return (
    /\.(ts|tsx)$/.test(file) &&
    !file.endsWith('.d.ts') &&
    file !== OWNER &&
    !/\.(spec|test)\.tsx?$/.test(file) &&
    !/(^|\/)(__tests__|__fixtures__|__mocks__|migrations|generated)\//.test(file) &&
    !/^apps\/[^/]+\/src\/test-utils\//.test(file) &&
    !file.includes('/node_modules/')
  );
}

const sources = trackedFiles(SOURCE_ROOTS).filter(isVocabularySource);

describe('INVARIANT: one owner for the access vocabulary (RBAC-MEDIUM-024)', () => {
  describe('1. the one role hierarchy', () => {
    it('the backend Role enum spells exactly the platform roles', () => {
      expect([...Object.values(Role)].sort()).toEqual([...PLATFORM_ROLES_BY_PRIVILEGE].sort());
    });

    it('roleHasPermission answers exactly as the owner, for every pair of roles', () => {
      for (const held of Object.values(Role)) {
        for (const required of Object.values(Role)) {
          expect(`${held} ⊇ ${required}: ${roleHasPermission(held, required)}`).toBe(
            `${held} ⊇ ${required}: ${platformRoleSatisfies(held, required)}`,
          );
        }
      }
    });
  });

  describe('2. no copy', () => {
    it('scans the product sources (a broken listing must not pass as "no copies")', () => {
      expect([...ROLES]).toEqual(['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER']);
      expect(sources.length).toBeGreaterThan(1000);
      expect(sources).toContain('web/shared-ui/src/contexts/AuthContext.tsx');
      expect(sources).toContain('libs/backend-common/src/decorators/roles.decorator.ts');
    });

    it('declares no hierarchy map, role order or role-literal union outside the owner', () => {
      const copies = sources.flatMap((file) => {
        const source = readRepoFile(file);
        if (![...ROLES].some((role) => source.includes(role))) return [];
        return roleVocabularyCopies(file, source, ROLES);
      });
      expect(
        copies.map((copy) => `${copy.where} ${copy.kind} of ${copy.roles.join(', ')}`),
      ).toEqual([]);
    });
  });

  describe('3. the capability check and catalogue', () => {
    it.each([BACKEND_CAPABILITY_CHECK, WEB_CAPABILITY_CHECK])(
      '%s reads holdsTenantCapabilities and names no account role itself',
      (file) => {
        const code = codeOf(file, readRepoFile(file));
        expect({ readsOwner: code.includes('holdsTenantCapabilities') }).toEqual({
          readsOwner: true,
        });
        expect(code.match(/\b(SUPER_ADMIN|TENANT_ADMIN)\b/g) ?? []).toEqual([]);
      },
    );

    it('auth-service reads the catalogue from shared-contracts and declares no catalogue literal', () => {
      const source = readRepoFile(AUTH_CATALOGUE);
      expect({ readsOwner: source.includes('TENANT_CAPABILITY_CATALOGUE') }).toEqual({
        readsOwner: true,
      });
      const file = ts.createSourceFile(AUTH_CATALOGUE, source, ts.ScriptTarget.Latest, true);
      const literals: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'resources' &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          literals.push(node.getText(file).slice(0, 40));
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      expect(literals).toEqual([]);
      expect(Object.keys(TENANT_CAPABILITY_CATALOGUE).length).toBeGreaterThan(0);
    });
  });
});
