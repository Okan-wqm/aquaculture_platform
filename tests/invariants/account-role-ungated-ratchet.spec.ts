/**
 * INVARIANT: in every service still in `account-role` mode, the operations every member reaches
 * may only shrink (ADR-054 draft D-F 1, its rollout PR-2; ADR-051 §3; RBAC-HIGH-030).
 *
 * WHY: until a service flips to `module-access` (libs/backend-common/src/security/
 * access-enrolment.ts), RolesGuard decides by `canActivateByAccountRole`
 * (libs/backend-common/src/guards/roles.guard.ts): a handler with no `@Roles` on it or its class
 * admits any authenticated caller, and the classification invariant
 * (module-access-classification.spec.ts) binds only enrolled services. So between now and each
 * service's enrolment package, a new resolver without a gate ships open and nothing fails. This
 * spec freezes today's open surface so it can only get smaller.
 *
 * WHAT, per `account-role` service (plus `shared-libs`, the controllers and resolvers under
 * `libs/` and `platform/libs/` that services mount, such as the standard health and metrics
 * controllers), for every root Query, Mutation, Subscription and REST handler:
 *   - `ungated`: none of `@Roles` (or an alias from roles.decorator.ts), `@Access` or `@Public`
 *     on the handler or its class. An `@Access` counts only where the handler takes
 *     `@AccessCaller()`, the one place it is decided in `account-role` mode (RolesGuard's
 *     account-role path never reads it), so `@Access` alone cannot move an open operation out;
 *   - `moduleUserOnly`: the effective `@Roles` lists MODULE_USER, the bottom of the one hierarchy
 *     (libs/shared-contracts/src/access/platform-roles.ts), so every member passes it;
 *   - `public`: `@Public()` on the handler or its class (and no `@Access`), open without a token.
 *     D-F 1 names only the first two sets; the third is frozen too, because marking a handler
 *     `@Public()` would otherwise be the way to leave the first set.
 * Precedence is the guard's: `getAllAndOverride([handler, class])`, so the handler's declaration
 * beats its class's and an empty `@Roles()` counts as none. Each set is compared by key
 * (`file#Class.method`) with tests/invariants/account-role-ungated-ratchet.baseline.json:
 *   - a key in the code and not in the baseline FAILS: gate the operation (`@Roles` with a role
 *     above MODULE_USER, or `@Access` once its service enrols); adding the key to the baseline
 *     is a reviewed decision to ship one more open operation, never a way to silence this spec;
 *   - a key in the baseline and not in the code PASSES with a message: delete it from the
 *     baseline in the same PR, so the record keeps saying exactly what is open;
 *   - an `ungated` key that reappears as `moduleUserOnly` PASSES with a message to move it: it
 *     reaches the same callers and now declares a gate (open PR #2124 gates hr operations with
 *     `@ModuleUserOrHigher()` this way). Nothing moves the other way, and nothing moves into
 *     `public`.
 *
 * "Ungated" means no role or access decision: these are the operations the classification guard
 * denies the day their service enrols unless they gain `@Access` or `@Public`. Another guard may
 * still narrow one of them today; on main at 7a547f528, 17 of auth-service's 46 carry
 * `@RequireTenantPermission`, which its APP_GUARD TenantPermissionGuard checks for non-admins.
 *
 * What it does not see: an imperative check inside the handler body, farm-service's
 * PermissionMatrixGuard (a name-membership check, not a role decision), TenantPermissionGuard's
 * opt-in `@RequirePermission`, and field or reference resolvers (no guard runs on them; see
 * reference-resolver-tenant.spec.ts and the classification spec). It records a decorator fact,
 * not a reachability proof; the e2e characterization matrix records outcomes.
 *
 * It changes no runtime behaviour.
 */
import { isPlatformRole } from '@aquaculture/shared-contracts';

import {
  ACCESS_ENROLLED_SERVICES,
  MODULE_ACCESS_ENROLMENT,
} from '../../libs/backend-common/src/security/access-enrolment';

import {
  baselineDiff,
  ratchetDiff,
  ratchetSetsOf,
  type RatchetSets,
} from './helpers/access-surface';
import { readRepoFile } from './helpers/module-dictionary-sources';
import {
  productionSources,
  scanService,
  scanSource,
  type ScannedHandler,
} from './helpers/module-access-handlers';

const BASELINE_FILE = 'tests/invariants/account-role-ungated-ratchet.baseline.json';
const SHARED_LIBS = 'shared-libs';
const EMPTY_SETS: RatchetSets = { ungated: [], moduleUserOnly: [], public: [] };
const SET_NAMES = [
  'ungated',
  'moduleUserOnly',
  'public',
] as const satisfies readonly (keyof RatchetSets)[];

interface RatchetBaseline {
  readonly _comment: string;
  readonly generated_against: string;
  readonly services: Readonly<Record<string, RatchetSets>>;
}

const baseline = JSON.parse(readRepoFile(BASELINE_FILE)) as RatchetBaseline;

const accountRoleServices = ACCESS_ENROLLED_SERVICES.filter(
  (service) => MODULE_ACCESS_ENROLMENT[service] === 'account-role',
);

function scanGroup(group: string): ScannedHandler[] {
  if (group !== SHARED_LIBS) return scanService(group);
  return productionSources(['libs', 'platform/libs']).flatMap((file) =>
    scanSource(file, readRepoFile(file)),
  );
}

const groups: readonly string[] = [...accountRoleServices, SHARED_LIBS];
const scanned: Readonly<Record<string, readonly ScannedHandler[]>> = Object.fromEntries(
  groups.map((group) => [group, scanGroup(group)]),
);
const current: Readonly<Record<string, RatchetSets>> = Object.fromEntries(
  groups.map((group) => [group, ratchetSetsOf(scanned[group] ?? [])]),
);

describe('INVARIANT: account-role services never grow the operations every member reaches (ADR-054 D-F 1)', () => {
  it('the baseline lists every account-role service and shared-libs, and nothing else', () => {
    const listed = Object.keys(baseline.services).sort();
    const missing = groups.filter((group) => !listed.includes(group));
    expect({ missing }).toEqual({ missing: [] });
    const enrolled = listed.filter((group) => !groups.includes(group));
    if (enrolled.length > 0) {
      console.warn(
        `${BASELINE_FILE}: ${enrolled.join(', ')} left account-role mode (or no longer exists); ` +
          'delete its entry, the classification invariant binds it now.',
      );
    }
  });

  describe.each(groups.map((group) => [group]))('%s', (group) => {
    it.each(SET_NAMES.map((set) => [set]))('%s does not grow', (set) => {
      const { grown, moved, shrunk } = ratchetDiff(
        set,
        current[group]?.[set] ?? [],
        baseline.services[group] ?? EMPTY_SETS,
      );
      if (moved.length > 0) {
        console.warn(
          `${BASELINE_FILE}: ${group}: ${moved.length} ungated operation(s) gained a MODULE_USER ` +
            `gate; move these keys from ungated to moduleUserOnly:\n${moved
              .map((key) => `  ${key}`)
              .join('\n')}`,
        );
      }
      if (shrunk.length > 0) {
        console.warn(
          `${BASELINE_FILE}: ${group}.${set} shrank by ${shrunk.length}; delete these keys from ` +
            `the baseline in this PR:\n${shrunk.map((key) => `  ${key}`).join('\n')}`,
        );
      }
      if (grown.length > 0) {
        throw new Error(
          `${group}: ${grown.length} new ${set} operation(s) that every member${
            set === 'public' ? ', or anyone,' : ''
          } reaches under account-role.\n` +
            'Gate each with @Roles above MODULE_USER (or @Access once the service enrols); do not ' +
            `add it to ${BASELINE_FILE} to silence this spec.\n` +
            grown.map((key) => `  ${key}`).join('\n'),
        );
      }
    });
  });

  it('every role the scan reads is a platform role, so no MODULE_USER hides behind a constant', () => {
    const unreadable = groups.flatMap((group) =>
      (scanned[group] ?? []).flatMap((handler) =>
        handler.roles
          .filter((role) => !isPlatformRole(role))
          .map((role) => `${handler.file}#${handler.className}.${handler.method}: @Roles(${role})`),
      ),
    );
    expect(unreadable).toEqual([]);
  });

  it('the scan reads the real tree: every account-role service has root operations', () => {
    const empty = accountRoleServices.filter(
      (service) =>
        (scanned[service] ?? []).filter((h) => h.role !== 'reference' && h.role !== 'field')
          .length === 0,
    );
    expect(empty).toEqual([]);
  });
});

describe('ratchet sets — self-tests on fixture sources', () => {
  const setsOf = (source: string): RatchetSets =>
    ratchetSetsOf(scanSource('apps/x/src/x.resolver.ts', source));

  it('an operation with no @Roles, @Access or @Public is ungated; a field or reference resolver is not an operation', () => {
    expect(
      setsOf(
        '@Resolver(() => T)\nclass R {\n  @Query(() => String)\n  open() {}\n' +
          '  @ResolveField(() => Int)\n  f() {}\n  @ResolveReference()\n  ref() {}\n}\n',
      ),
    ).toEqual({ ungated: ['apps/x/src/x.resolver.ts#R.open'], moduleUserOnly: [], public: [] });
    expect(
      setsOf("@Controller('c')\nclass C {\n  @Post()\n  write() {}\n  helper() {}\n}\n").ungated,
    ).toEqual(['apps/x/src/x.resolver.ts#C.write']);
  });

  it('class-level @Roles gates every handler; the handler declaration beats the class; an empty @Roles() is none', () => {
    const source =
      '@Roles(Role.TENANT_ADMIN)\n@Resolver()\nclass R {\n  @Query(() => String)\n  a() {}\n' +
      '  @Roles(Role.MODULE_USER)\n  @Mutation(() => String)\n  b() {}\n' +
      '  @Roles()\n  @Mutation(() => String)\n  c() {}\n}\n';
    expect(setsOf(source)).toEqual({
      ungated: ['apps/x/src/x.resolver.ts#R.c'],
      moduleUserOnly: ['apps/x/src/x.resolver.ts#R.b'],
      public: [],
    });
  });

  it('an alias that reaches MODULE_USER is MODULE_USER-only; one that stops above it gates', () => {
    expect(
      setsOf(
        '@Resolver()\nclass R {\n  @ModuleUserOrHigher()\n  @Query(() => String)\n  a() {}\n' +
          '  @ModuleManagerOrHigher()\n  @Query(() => String)\n  b() {}\n' +
          '  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER)\n  @Query(() => String)\n  c() {}\n}\n',
      ).moduleUserOnly,
    ).toEqual(['apps/x/src/x.resolver.ts#R.a', 'apps/x/src/x.resolver.ts#R.c']);
  });

  it('@Public on the handler or class is public; comments never count', () => {
    expect(
      setsOf(
        '@Public()\n@Controller()\nclass H {\n  @Get()\n  live() {}\n}\n' +
          '@Resolver()\nclass R {\n  // @Roles(Role.TENANT_ADMIN)\n  @Query(() => String)\n  b() {}\n}\n',
      ),
    ).toEqual({
      ungated: ['apps/x/src/x.resolver.ts#R.b'],
      moduleUserOnly: [],
      public: ['apps/x/src/x.resolver.ts#H.live'],
    });
  });

  it('@Access gates only with @AccessCaller(), the one place account-role mode decides it', () => {
    const source =
      "@Resolver()\nclass R {\n  @Access.module('farm')\n  @Query(() => String)\n  alone() {}\n" +
      "  @Access.module('farm')\n  @Query(() => String)\n  decided(@AccessCaller() c: AccessCaller) {}\n" +
      "  @Access.module('farm')\n  @ModuleUserOrHigher()\n  @Query(() => String)\n  rolesToo() {}\n}\n";
    expect(setsOf(source)).toEqual({
      ungated: ['apps/x/src/x.resolver.ts#R.alone'],
      moduleUserOnly: ['apps/x/src/x.resolver.ts#R.rolesToo'],
      public: [],
    });
  });

  it('a grown set fails and a shrunk set only asks for the baseline to shrink', () => {
    expect(baselineDiff(['a', 'b', 'new'], ['a', 'b', 'gone'])).toEqual({
      grown: ['new'],
      shrunk: ['gone'],
    });
    expect(baselineDiff(['a'], ['a', 'b'])).toEqual({ grown: [], shrunk: ['b'] });
  });

  it('an ungated key that gains a MODULE_USER gate moves; nothing moves back or into public', () => {
    const frozen: RatchetSets = { ungated: ['u'], moduleUserOnly: ['m'], public: ['p'] };
    expect(ratchetDiff('moduleUserOnly', ['m', 'u'], frozen)).toEqual({
      grown: [],
      moved: ['u'],
      shrunk: [],
    });
    expect(ratchetDiff('ungated', ['u', 'm'], frozen)).toEqual({
      grown: ['m'],
      moved: [],
      shrunk: [],
    });
    expect(ratchetDiff('public', ['p', 'u'], frozen)).toEqual({
      grown: ['u'],
      moved: [],
      shrunk: [],
    });
  });
});
