/**
 * INVARIANT: every service registers its access guards through its ADR-051 enrolment entry
 * (ADR-051 §3 "Enrolment", Enforcement; plan PKG-05; RBAC-HIGH-030, RBAC-HIGH-031).
 *
 * Which guards a service runs follows MODULE_ACCESS_ENROLMENT
 * (libs/backend-common/src/security/access-enrolment.ts): `account-role` registers RolesGuard as
 * before, `module-access` adds the classification guard and decides `@Roles` by kind. That holds
 * only if no service wires the guards any other way:
 *
 *   1. The keys of the map are exactly the services whose app.module.ts calls
 *      `accessGuardProviders`, each once and with its own `apps/` directory name.
 *   2. No app.module.ts names RolesGuard or AccessClassificationGuard (so none registers them as an
 *      APP_GUARD by hand), and no production source constructs either guard outside
 *      `accessGuardProviders`, nor calls the mode-taking builder behind it.
 *   3. A `module-access` service applies no `@UseGuards(RolesGuard)`: a guard Nest builds for a
 *      handler has no enrolment and would decide by `users.role` (account-role).
 *
 * Rule 3 runs per `module-access` service, so it holds vacuously while no service is enrolled
 * (R1) and bites the PR that flips one: hr-service applies `@UseGuards(RolesGuard)` on its leave
 * and performance resolvers today, so PKG-07 must remove them in the PR that enrols hr (plan
 * PKG-07 "remove the method-level RolesGuard"). The scanner self-test keeps the rule from passing
 * because it reads nothing.
 */
import {
  ACCESS_ENROLLED_SERVICES,
  MODULE_ACCESS_ENROLMENT,
  moduleAccessServices,
} from '../../libs/backend-common/src/security/access-enrolment';

import { readRepoFile } from './helpers/module-dictionary-sources';
import {
  accessGuardRegistrations,
  appModules,
  constructions,
  identifierUses,
  perHandlerRolesGuards,
  productionSources,
} from './helpers/module-access-registration';

const ACCESS_GUARDS: ReadonlySet<string> = new Set(['RolesGuard', 'AccessClassificationGuard']);
const PROVIDERS_FILE = 'libs/backend-common/src/guards/access-guard-providers.ts';

function servicePerHandlerRolesGuards(service: string): string[] {
  return productionSources([`apps/${service}/src`]).flatMap((file) =>
    perHandlerRolesGuards(file, readRepoFile(file)),
  );
}

describe('INVARIANT: access guards are registered only through the enrolment (ADR-051 §3)', () => {
  const modules = appModules();

  it('1. the enrolment keys are exactly the services that call accessGuardProviders, with their own name', () => {
    const registering: string[] = [];
    const problems: string[] = [];
    for (const [service, file] of modules) {
      const calls = accessGuardRegistrations(file, readRepoFile(file));
      if (calls.length === 0) continue;
      registering.push(service);
      if (calls.length !== 1)
        problems.push(`${file}: calls accessGuardProviders ${calls.length} times`);
      for (const argument of calls) {
        if (argument !== service) {
          problems.push(
            `${file}: accessGuardProviders(${String(argument)}) does not name ${service}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
    expect(registering.sort()).toEqual([...ACCESS_ENROLLED_SERVICES].sort());
    expect(Object.keys(MODULE_ACCESS_ENROLMENT).sort()).toEqual(
      [...ACCESS_ENROLLED_SERVICES].sort(),
    );
  });

  it('2a. no app.module.ts names RolesGuard or AccessClassificationGuard', () => {
    const named = [...modules.values()].flatMap((file) =>
      identifierUses(file, readRepoFile(file), ACCESS_GUARDS),
    );
    expect(named).toEqual([]);
  });

  it('2b. only accessGuardProviders constructs the access guards, and no app calls its mode-taking builder', () => {
    const files = productionSources(['apps', 'libs', 'platform']);
    const constructed = files
      .filter((file) => file !== PROVIDERS_FILE)
      .flatMap((file) => constructions(file, readRepoFile(file), ACCESS_GUARDS));
    const bypasses = productionSources(['apps']).flatMap((file) =>
      identifierUses(file, readRepoFile(file), new Set(['guardProvidersForEnrolment'])),
    );
    expect(constructed).toEqual([]);
    expect(bypasses).toEqual([]);
    expect(constructions(PROVIDERS_FILE, readRepoFile(PROVIDERS_FILE), ACCESS_GUARDS).length).toBe(
      2,
    );
  });

  it('3. no module-access service applies a per-handler RolesGuard', () => {
    expect(moduleAccessServices().flatMap(servicePerHandlerRolesGuards)).toEqual([]);
  });

  it('3 (scanner self-test). the rule reads UseGuards applications, not text', () => {
    const applied = '@UseGuards(GqlAuthGuard, RolesGuard)\nclass A {}\n';
    const commented = '// @UseGuards(RolesGuard)\n@UseGuards(GqlAuthGuard)\nclass A {}\n';
    expect(perHandlerRolesGuards('fixture.ts', applied)).toEqual([
      'fixture.ts:1 UseGuards(RolesGuard)',
    ]);
    expect(perHandlerRolesGuards('fixture.ts', commented)).toEqual([]);
  });
});
