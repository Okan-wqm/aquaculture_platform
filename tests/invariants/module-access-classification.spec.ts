/**
 * INVARIANT: in every `module-access` service each operation is classified (ADR-051 §3,
 * Enforcement; plan PKG-05; RBAC-HIGH-030).
 *
 * AccessClassificationGuard denies an unannotated root field or REST handler at run time; this
 * spec fails the build first, and covers what no guard sees (Nest runs no guard on a reference or
 * field resolver):
 *
 *   1. Each root Query/Mutation/Subscription field and REST handler has `@Access` or `@Public`.
 *   2. Each `@ResolveReference` takes `@Parent()` and `@AccessCaller()`, has `@Access` on it or its
 *      class, and is never `@Public`.
 *   3. Each `@ResolveField` takes `@AccessCaller()` or is in PARENT_SCOPED_FIELDS with a non-empty
 *      reason; an entry naming no field resolver fails.
 *   4. A handler taking `@AccessCaller()` has `@Access` on it or its class (else it always denies).
 *   5. `Access.module` names a module the service owns (SERVICE_ACCESS_MODULES); `Access.company`
 *      is only on a Query in a `company-layer/` directory; `company`, `self` and `account` carry no
 *      `@Roles` (decideAccess denies such a pairing).
 *
 * The rules apply to the services MODULE_ACCESS_ENROLMENT marks `module-access`, so they hold
 * vacuously in R1, when none is, and fail the PR that enrols a service it has not classified. The
 * self-tests below run each rule on fixture sources, and the real-tree check shows what enrolling
 * the account-role services as they stand would break, so no rule passes because it reads nothing.
 *
 * It also lists every `@ResolveReference` of every service with the service's enrolment, which
 * the e2e matrix (e2e/tests/security/module-access-layers.matrix.ts) turns into one `_entities`
 * cell per §4 viewer.
 */
import {
  ACCESS_ENROLLED_SERVICES,
  MODULE_ACCESS_ENROLMENT,
  SERVICE_ACCESS_MODULES,
  isAccessEnrolledService,
  moduleAccessServices,
  type AccessEnrolledService,
} from '../../libs/backend-common/src/security/access-enrolment';
import { PARENT_SCOPED_FIELDS } from '../../libs/backend-common/src/security/parent-scoped-fields';
import {
  MODULE_ACCESS_VIEWERS,
  referenceCells,
  type ReferenceResolverEntry,
} from '../../e2e/tests/security/module-access-layers.matrix';

import {
  classificationViolations,
  memberSpecOf,
  platformRolesOf,
  referenceInventory,
  scanService,
  scanSource,
  type ClassificationRules,
} from './helpers/module-access-handlers';

function rulesOf(service: AccessEnrolledService): ClassificationRules {
  return {
    ownModules: SERVICE_ACCESS_MODULES[service],
    parentScoped: PARENT_SCOPED_FIELDS[service],
  };
}

const FIXTURE_RULES: ClassificationRules = { ownModules: ['farm'], parentScoped: {} };

function violationsOf(
  source: string,
  rules: ClassificationRules = FIXTURE_RULES,
  file = 'apps/x/src/x.resolver.ts',
): string[] {
  return classificationViolations(scanSource(file, source), rules);
}

describe('INVARIANT: module-access services classify every operation (ADR-051 §3)', () => {
  it('every module-access service passes every classification rule', () => {
    const violations = moduleAccessServices().flatMap((service) =>
      classificationViolations(scanService(service), rulesOf(service)),
    );
    expect(violations).toEqual([]);
  });

  it('an account-role service lists no parent-scoped field (its enrolling package fills it)', () => {
    const premature = ACCESS_ENROLLED_SERVICES.filter(
      (service) =>
        MODULE_ACCESS_ENROLMENT[service] === 'account-role' &&
        Object.keys(PARENT_SCOPED_FIELDS[service]).length > 0,
    );
    expect(premature).toEqual([]);
  });

  it('the rules bite the real tree: the account-role services, enrolled as they stand, would fail rules 1 and 3', () => {
    const violations = ACCESS_ENROLLED_SERVICES.filter(
      (service) => MODULE_ACCESS_ENROLMENT[service] === 'account-role',
    ).flatMap((service) => classificationViolations(scanService(service), rulesOf(service)));
    expect(violations.some((v) => v.includes('has no @Access and no @Public'))).toBe(true);
    expect(violations.some((v) => v.includes('PARENT_SCOPED_FIELDS with a reason'))).toBe(true);
  });
});

describe('classification rules — self-tests on fixture sources', () => {
  it('1. a root field or REST handler needs @Access or @Public, on it or its class', () => {
    expect(
      violationsOf('@Resolver()\nclass R {\n  @Query(() => String)\n  open() {}\n}\n'),
    ).toEqual(['apps/x/src/x.resolver.ts:3 R.open: query has no @Access and no @Public']);
    expect(violationsOf("@Controller('c')\nclass C {\n  @Post()\n  write() {}\n}\n")).toHaveLength(
      1,
    );
    expect(
      violationsOf(
        "@Access.module('farm')\n@Resolver()\nclass R {\n  @Mutation(() => String)\n  m() {}\n}\n",
      ),
    ).toEqual([]);
    expect(
      violationsOf('@Resolver()\nclass R {\n  @Public()\n  @Query(() => String)\n  h() {}\n}\n'),
    ).toEqual([]);
    expect(
      violationsOf(
        "// @Access.module('farm')\n@Resolver()\nclass R {\n  @Query(() => String)\n  q() {}\n}\n",
      ),
    ).toHaveLength(1);
  });

  it('2. a reference resolver takes @Parent() and @AccessCaller(), is classified and never public', () => {
    const bare =
      '@Resolver(() => Farm)\nclass R {\n  @ResolveReference()\n  ref(reference: Ref) {}\n}\n';
    expect(violationsOf(bare)).toEqual([
      'apps/x/src/x.resolver.ts:3 R.ref: a @ResolveReference takes @Parent() and @AccessCaller()',
      'apps/x/src/x.resolver.ts:3 R.ref: a @ResolveReference needs @Access on it or its class',
    ]);
    const good =
      "@Access.module('farm')\n@Resolver(() => Farm)\nclass R {\n  @ResolveReference()\n" +
      '  ref(@Parent() reference: Ref, @AccessCaller() caller: AccessCaller) {}\n}\n';
    expect(violationsOf(good)).toEqual([]);
    expect(
      violationsOf(good.replace('@ResolveReference()', '@Public()\n  @ResolveReference()')),
    ).toEqual(['apps/x/src/x.resolver.ts:4 R.ref: a @ResolveReference is never @Public']);
  });

  it('3. a field resolver decides or is parent-scoped with a reason; a stale entry fails', () => {
    const field =
      "@Access.module('farm')\n@Resolver(() => Tank)\nclass R {\n  @ResolveField(() => Int)\n  count(@Parent() tank: Tank) {}\n}\n";
    expect(violationsOf(field)).toEqual([
      'apps/x/src/x.resolver.ts:4 R.count: field Tank.count takes no @AccessCaller() and is not in PARENT_SCOPED_FIELDS with a reason',
    ]);
    expect(
      violationsOf(field, {
        ownModules: ['farm'],
        parentScoped: { 'Tank.count': 'derived from the tank row' },
      }),
    ).toEqual([]);
    expect(
      violationsOf(field, { ownModules: ['farm'], parentScoped: { 'Tank.count': ' ' } }),
    ).toEqual([
      'apps/x/src/x.resolver.ts:4 R.count: field Tank.count takes no @AccessCaller() and is not in PARENT_SCOPED_FIELDS with a reason',
      'PARENT_SCOPED_FIELDS gives Tank.count no reason',
    ]);
    expect(
      violationsOf(
        field.replace(
          '@Parent() tank: Tank',
          '@Parent() tank: Tank, @AccessCaller() c: AccessCaller',
        ),
        {
          ownModules: ['farm'],
          parentScoped: { 'Tank.volume': 'gone' },
        },
      ),
    ).toEqual(['PARENT_SCOPED_FIELDS names Tank.volume, which no field resolver resolves']);
    expect(
      violationsOf(
        "@Resolver(() => Tank)\nclass R {\n  @ResolveField('litres', () => Int)\n  volume(@Parent() t: Tank) {}\n}\n",
        {
          ownModules: ['farm'],
          parentScoped: { 'Tank.litres': 'derived from the tank row' },
        },
      ),
    ).toEqual([]);
  });

  it('4. a handler taking @AccessCaller() is classified', () => {
    const unclassified =
      '@Resolver(() => Tank)\nclass R {\n  @ResolveField(() => Int)\n  count(@Parent() t: Tank, @AccessCaller() c: AccessCaller) {}\n}\n';
    expect(violationsOf(unclassified)).toEqual([
      'apps/x/src/x.resolver.ts:3 R.count: takes @AccessCaller() but neither it nor its class has @Access',
    ]);
  });

  it('5. Access.module names an owned module; Access.company is a company-layer Query; no @Roles on company, self or account', () => {
    expect(
      violationsOf(
        "@Resolver()\nclass R {\n  @Access.module('hr')\n  @Query(() => String)\n  q() {}\n}\n",
      ),
    ).toEqual([
      'apps/x/src/x.resolver.ts:3 R.q: Access.module(hr) is not a module this service owns (farm)',
    ]);
    const company =
      '@Resolver()\nclass R {\n  @Access.company()\n  @Query(() => String)\n  tree() {}\n}\n';
    expect(violationsOf(company)).toEqual([
      'apps/x/src/x.resolver.ts:3 R.tree: Access.company is only for a Query under */company-layer/',
    ]);
    expect(violationsOf(company, FIXTURE_RULES, 'apps/x/src/company-layer/x.resolver.ts')).toEqual(
      [],
    );
    expect(
      violationsOf(
        company.replace('@Query', '@Mutation'),
        FIXTURE_RULES,
        'apps/x/src/company-layer/x.resolver.ts',
      ),
    ).toHaveLength(1);
    expect(
      violationsOf(
        '@Resolver()\nclass R {\n  @Access.self()\n  @Roles(Role.MODULE_USER)\n  @Query(() => String)\n  me() {}\n}\n',
      ),
    ).toEqual([
      'apps/x/src/x.resolver.ts:3 R.me: Access.self reads no @Roles, but @Roles is declared',
    ]);
  });
});

describe('reference resolvers, for the e2e matrix', () => {
  const inventory = referenceInventory();
  const entries: ReferenceResolverEntry[] = inventory.map(({ service, handler }) => {
    if (!isAccessEnrolledService(service)) {
      throw new Error(
        `${handler.file}: ${service} resolves a reference but registers no access guards`,
      );
    }
    return {
      service,
      enrolment: MODULE_ACCESS_ENROLMENT[service],
      typeName: handler.typeName ?? '?',
      spec: memberSpecOf(handler.handlerAccess ?? handler.classAccess),
      roles: platformRolesOf(handler),
    };
  });

  it('lists every reference resolver of every service, with its type', () => {
    expect(entries.map((entry) => `${entry.service}:${entry.typeName}`).sort()).toEqual(
      expect.arrayContaining([
        'auth-service:PublicUserProfile',
        'farm-service:Farm',
        'sensor-service:Sensor',
        'sensor-service:SensorReading',
      ]),
    );
    expect(entries.every((entry) => entry.typeName !== '?')).toBe(true);
  });

  it('gives the matrix one cell per reference resolver and §4 viewer, decided by the enrolment', () => {
    const cells = referenceCells(entries);
    expect(cells).toHaveLength(entries.length * MODULE_ACCESS_VIEWERS.length);
    for (const entry of entries) {
      const own = cells.filter((cell) => cell.operation === `_entities:${entry.typeName}`);
      expect(new Set(own.map((cell) => cell.viewer)).size).toBe(MODULE_ACCESS_VIEWERS.length);
      if (entry.enrolment === 'account-role') {
        expect(own.every((cell) => cell.expected === 'account-role')).toBe(true);
      } else {
        expect(own.every((cell) => cell.expected !== 'account-role')).toBe(true);
      }
    }
  });
});
