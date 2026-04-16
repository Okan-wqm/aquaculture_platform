/**
 * Adoption Invariants
 * ============================================================================
 *
 * Closes the SSoT chain established by W0:
 *
 *   tests/invariants/_constants.ts           → SCHEMA_OWNING_SERVICES (13)
 *   tests/invariants/adoption-invariants.ts  → THIS FILE (enforces adoption)
 *
 * W0 landed the constant but the consumer did not exist — CTX-HIGH-001
 * in the unified audit flagged the SSoT pointing at a ghost enforcer.
 * This spec fills the gap and makes the chain load-bearing.
 *
 * # What this spec enforces
 *
 *   1. Every service in SCHEMA_OWNING_SERVICES (13 services) registers
 *      `SchemaDriftModule.forRoot({ serviceName: '<name>' })` in its
 *      `apps/<svc>/src/app.module.ts`. Per ADR-012, the validator fires
 *      at cold start and catches entity↔DB mapping drift before it
 *      corrupts production tenants (the 2026-04-14 incident class).
 *
 *   2. Services NOT in SCHEMA_OWNING_SERVICES (gateway-api, observability-
 *      service) MUST NOT register SchemaDriftModule (they own no schema).
 *      A defensive check so that accidental registration does not hide
 *      a genuine missing service.
 *
 *   3. Every registered service names itself correctly — no
 *      copy-paste typos where auth-service registers with serviceName
 *      'billing' (would validate the wrong schema at boot).
 *
 * # When this spec fails
 *
 *   - A schema-owning service's AppModule does not import
 *     SchemaDriftModule.forRoot → add the registration. Template:
 *     `SchemaDriftModule.forRoot({ serviceName: '<schema-name>' })`.
 *
 *   - A schemaless service (gateway-api / observability-service) has
 *     SchemaDriftModule.forRoot → remove the registration. These
 *     services do not own entity tables so the validator has nothing
 *     meaningful to validate and the registration is misleading noise.
 *
 *   - Service registers with a wrong serviceName (mismatch with its
 *     schema owner) → fix the serviceName string to match the schema.
 *
 * # Why a test instead of a runtime-only validator
 *
 *   SchemaDriftValidator fires OnApplicationBootstrap — it only catches
 *   drift on services that actually boot during the test run. A service
 *   can silently regress its registration and go unnoticed until the
 *   next production deploy's cold start. This static text-level
 *   assertion catches the regression at PR time regardless of whether
 *   the service is booted in CI.
 *
 * # References
 *
 *   - /root/.claude/plans/declarative-riding-shamir.md BLOCKER-8
 *     (service count reconciliation) + BLOCKER-19 (SSoT chain closure)
 *   - /var/aqua-saas/docs/adr/011-schema-ownership-model.md
 *   - /var/aqua-saas/docs/adr/012-schema-drift-prevention.md
 *   - /var/aqua-saas/tests/invariants/_constants.ts (SSoT for the allowlist)
 *   - /var/aqua-saas/docs/reviews/_audit/2026-04-W16-backend-platform.md
 *     (PLAT-HIGH-001 — event-store-service currently missing registration)
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  SCHEMA_OWNING_SERVICES,
  SCHEMALESS_SERVICES,
} from './_constants';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');

// Map from constant name (farm-service) to AppModule path.
// All apps follow the same convention: apps/<name>/src/app.module.ts.
function appModulePath(serviceName: string): string {
  return path.join(APPS_DIR, serviceName, 'src', 'app.module.ts');
}

function readAppModule(serviceName: string): string {
  const p = appModulePath(serviceName);
  if (!fs.existsSync(p)) {
    throw new Error(
      `AppModule not found for service '${serviceName}' at ${p}. ` +
        `Either the service does not exist or the convention has drifted.`,
    );
  }
  return fs.readFileSync(p, 'utf-8');
}

// Regex: SchemaDriftModule.forRoot({ serviceName: '<name>' ... })
// Tolerant of whitespace, trailing comma, additional options (e.g. fatal flag).
function extractServiceNameFromRegistration(
  moduleContent: string,
): string | null {
  const match = moduleContent.match(
    /SchemaDriftModule\.forRoot\s*\(\s*\{\s*[^}]*serviceName\s*:\s*['"]([\w-]+)['"]/,
  );
  return match ? match[1] : null;
}

function hasSchemaDriftImport(moduleContent: string): boolean {
  return /SchemaDriftModule/.test(moduleContent);
}

describe('Adoption Invariants — SchemaDriftModule registration (BLOCKER-19)', () => {
  describe.each(SCHEMA_OWNING_SERVICES)(
    'schema-owning service %s',
    (serviceName) => {
      let moduleContent: string;

      beforeAll(() => {
        moduleContent = readAppModule(serviceName);
      });

      it('imports SchemaDriftModule', () => {
        expect(hasSchemaDriftImport(moduleContent)).toBe(true);
      });

      it('registers SchemaDriftModule.forRoot with serviceName', () => {
        const registered =
          extractServiceNameFromRegistration(moduleContent);
        expect(registered).not.toBeNull();
      });

      it('registers with a serviceName matching the schema owner', () => {
        const registered =
          extractServiceNameFromRegistration(moduleContent);
        // Strip "-service" suffix for comparison when present.
        // e.g. "farm-service" registers as serviceName: 'farm'.
        const expectedCandidates = [
          serviceName,
          serviceName.replace(/-service$/, ''),
        ];
        expect(expectedCandidates).toContain(registered);
      });
    },
  );

  describe.each(SCHEMALESS_SERVICES)(
    'schemaless service %s',
    (serviceName) => {
      it('does NOT register SchemaDriftModule (no schema to validate)', () => {
        const moduleContent = readAppModule(serviceName);
        // Allow the import line in case it's needed for forRootAsync
        // variants in edge cases, but disallow the actual registration.
        // A bare import without registration does no harm; a forRoot
        // call is what we flag.
        const hasForRoot = /SchemaDriftModule\.forRoot\s*\(/.test(
          moduleContent,
        );
        expect(hasForRoot).toBe(false);
      });
    },
  );

  describe('SSoT integrity', () => {
    it('SCHEMA_OWNING_SERVICES and SCHEMALESS_SERVICES do not overlap', () => {
      const owning = new Set<string>(SCHEMA_OWNING_SERVICES);
      const overlap = SCHEMALESS_SERVICES.filter((s) => owning.has(s));
      expect(overlap).toEqual([]);
    });

    it('together cover every service under apps/** that ships an app.module', () => {
      const appsWithModule = fs
        .readdirSync(APPS_DIR)
        .filter((name) =>
          fs.existsSync(path.join(APPS_DIR, name, 'src', 'app.module.ts')),
        );

      const tracked = new Set<string>([
        ...SCHEMA_OWNING_SERVICES,
        ...SCHEMALESS_SERVICES,
      ]);

      const untracked = appsWithModule.filter((name) => !tracked.has(name));
      expect(untracked).toEqual([]);
    });
  });
});
