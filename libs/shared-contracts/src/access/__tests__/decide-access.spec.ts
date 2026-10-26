import { OWNER_MODULE_CODES } from '../../modules/platform-modules';
import {
  NATS_SERVICE_NAMES,
  serviceCaller,
  type AccessIntent,
  type AccessRequest,
  type AccountAccessSpec,
  type Caller,
  type CompanyAccessSpec,
  type SelfAccessSpec,
  type ServiceSubjectAccess,
  type SubjectAccess,
} from '../access-spec';
import { decideAccess, deriveServiceGrants, type AccessDecision } from '../decide-access';
import { ALL_MODULES_SCOPE } from '../module-scope';
import type { PlatformRole } from '../platform-roles';
import {
  MalformedCallerError,
  isModuleAccess,
  isUserCaller,
  userCaller,
  type CallerClaim,
  type ModuleAccess,
  type UserCaller,
  type VerifiedMemberIdentity,
} from '../user-caller';

/**
 * decideAccess (RBAC-MEDIUM-024; ADR-051 §1, §4) — every viewer of ADR-051 §4 against every
 * access kind, intent and claim shape. A row here is the contract the guards (PKG-05), NATS
 * responders (PKG-09), sockets (PKG-10/11), notification fan-out (PKG-44) and the nav (PKG-34)
 * inherit by calling the same function.
 */

const TENANT = '00000000-0000-4000-8000-000000000001';

function member(
  userId: string,
  roles: readonly string[],
  moduleAccess?: ModuleAccess,
  capabilities: readonly string[] = [],
): UserCaller {
  return userCaller({ userId, tenantId: TENANT, roles, moduleAccess, capabilities });
}

/** ADR-051 §4: roles A, B, A′, B′ and the controls. */
const VIEWERS = {
  /** {farm: MODULE_MANAGER}, no company:view. */
  roleA: member('role-a', ['MODULE_USER'], { farm: 'MODULE_MANAGER' }),
  /** Company Viewer, no grants. */
  roleB: member('role-b', ['MODULE_USER'], {}, ['company:view']),
  /** Role A plus today's global MODULE_MANAGER. */
  roleAPrime: member('role-a-prime', ['MODULE_MANAGER'], { farm: 'MODULE_MANAGER' }),
  /** Role B plus today's global MODULE_MANAGER. */
  roleBPrime: member('role-b-prime', ['MODULE_MANAGER'], {}, ['company:view']),
  /** A farm operator (site S1 is decided by the site scope, not here). */
  farmOperatorS1: member('operator-s1', ['MODULE_USER'], { farm: 'MODULE_USER' }),
  hrManager: member('hr-manager', ['MODULE_MANAGER'], { hr: 'MODULE_MANAGER' }),
  /** A sensor manager (site S9 is decided by the site scope, not here). */
  sensorManagerS9: member('sensor-manager-s9', ['MODULE_MANAGER'], { sensor: 'MODULE_MANAGER' }),
  /** The module-access reader lists every enabled module as MODULE_MANAGER for TENANT_ADMIN. */
  tenantAdmin: member('tenant-admin', ['TENANT_ADMIN'], {
    farm: 'MODULE_MANAGER',
    hr: 'MODULE_MANAGER',
    sensor: 'MODULE_MANAGER',
  }),
  tenantAdminWithoutHr: member('tenant-admin-no-hr', ['TENANT_ADMIN'], {
    farm: 'MODULE_MANAGER',
    sensor: 'MODULE_MANAGER',
  }),
  superAdmin: userCaller({ userId: 'super-admin', tenantId: null, roles: ['SUPER_ADMIN'] }),
  /** A token minted before the claim existed: the global role must not stand in for it. */
  memberWithoutClaim: member('legacy-manager', ['MODULE_MANAGER']),
} as const;

type Viewer = keyof typeof VIEWERS;

function isViewer(key: string): key is Viewer {
  return key in VIEWERS;
}

const VIEWER_NAMES: readonly Viewer[] = Object.keys(VIEWERS).filter(isViewer);

type Expected = boolean | 'ALL' | readonly ('farm' | 'hr' | 'sensor' | 'hydroponics')[];

interface Surface {
  readonly name: string;
  readonly request: AccessRequest;
  readonly expected: Readonly<Record<Viewer, Expected>>;
}

const ALL_ALLOWED: Readonly<Record<Viewer, Expected>> = {
  roleA: true,
  roleB: true,
  roleAPrime: true,
  roleBPrime: true,
  farmOperatorS1: true,
  hrManager: true,
  sensorManagerS9: true,
  tenantAdmin: true,
  tenantAdminWithoutHr: true,
  superAdmin: true,
  memberWithoutClaim: true,
};

const NONE_ALLOWED: Readonly<Record<Viewer, Expected>> = {
  roleA: false,
  roleB: false,
  roleAPrime: false,
  roleBPrime: false,
  farmOperatorS1: false,
  hrManager: false,
  sensorManagerS9: false,
  tenantAdmin: false,
  tenantAdminWithoutHr: false,
  superAdmin: false,
  memberWithoutClaim: false,
};

/** The ADR-051 §4 matrix, one row per surface, every viewer a column. */
const SURFACES: readonly Surface[] = [
  {
    name: 'batches, tanks, feeds, water quality, storage (module farm, read)',
    request: { spec: { kind: 'module', module: 'farm' }, intent: 'read', roles: [] },
    expected: {
      ...NONE_ALLOWED,
      roleA: true,
      roleAPrime: true,
      farmOperatorS1: true,
      tenantAdmin: true,
      tenantAdminWithoutHr: true,
      superAdmin: true,
    },
  },
  {
    name: 'a farm write gated to managers (module farm, write, @Roles TENANT_ADMIN, MODULE_MANAGER)',
    request: {
      spec: { kind: 'module', module: 'farm' },
      intent: 'write',
      roles: ['TENANT_ADMIN', 'MODULE_MANAGER'],
    },
    expected: {
      ...NONE_ALLOWED,
      roleA: true,
      roleAPrime: true,
      tenantAdmin: true,
      tenantAdminWithoutHr: true,
      superAdmin: true,
    },
  },
  {
    name: 'a farm operation gated to TENANT_ADMIN (archiveFinanceCategory)',
    request: { spec: { kind: 'module', module: 'farm' }, intent: 'write', roles: ['TENANT_ADMIN'] },
    expected: { ...NONE_ALLOWED, tenantAdmin: true, tenantAdminWithoutHr: true, superAdmin: true },
  },
  {
    name: 'payroll, HR finance, labour cost (module hr, D6)',
    request: { spec: { kind: 'module', module: 'hr' }, intent: 'read', roles: [] },
    expected: { ...NONE_ALLOWED, hrManager: true, tenantAdmin: true, superAdmin: true },
  },
  {
    name: 'sensor resolvers, SCADA handshake (module sensor)',
    request: { spec: { kind: 'module', module: 'sensor' }, intent: 'read', roles: [] },
    expected: {
      ...NONE_ALLOWED,
      sensorManagerS9: true,
      tenantAdmin: true,
      tenantAdminWithoutHr: true,
      superAdmin: true,
    },
  },
  {
    name: 'workforce reads, employee(id) (scoped workforce)',
    request: { spec: { kind: 'scoped', scope: 'workforce' }, intent: 'read', roles: [] },
    expected: {
      ...NONE_ALLOWED,
      roleA: ['farm'],
      roleAPrime: ['farm'],
      farmOperatorS1: ['farm'],
      hrManager: 'ALL',
      sensorManagerS9: ['sensor'],
      tenantAdmin: 'ALL',
      tenantAdminWithoutHr: 'ALL',
      superAdmin: 'ALL',
    },
  },
  {
    name: 'alarms (scoped alerts)',
    request: { spec: { kind: 'scoped', scope: 'alerts' }, intent: 'read', roles: [] },
    expected: {
      ...NONE_ALLOWED,
      roleA: ['farm'],
      roleAPrime: ['farm'],
      farmOperatorS1: ['farm'],
      hrManager: ['hr'],
      sensorManagerS9: ['sensor'],
      tenantAdmin: 'ALL',
      tenantAdminWithoutHr: 'ALL',
      superAdmin: 'ALL',
    },
  },
  {
    name: 'registry writes gated to managers (scoped common-registry, @Roles MODULE_MANAGER)',
    request: {
      spec: { kind: 'scoped', scope: 'common-registry' },
      intent: 'write',
      roles: ['TENANT_ADMIN', 'MODULE_MANAGER'],
    },
    expected: {
      ...NONE_ALLOWED,
      roleA: ['farm'],
      roleAPrime: ['farm'],
      hrManager: ['hr'],
      sensorManagerS9: ['sensor'],
      tenantAdmin: 'ALL',
      tenantAdminWithoutHr: 'ALL',
      superAdmin: 'ALL',
    },
  },
  {
    name: 'company* fields, /tenant (company, read)',
    request: { spec: { kind: 'company' }, intent: 'read' },
    expected: {
      ...NONE_ALLOWED,
      roleB: true,
      roleBPrime: true,
      tenantAdmin: true,
      tenantAdminWithoutHr: true,
      superAdmin: true,
    },
  },
  {
    name: 'a Company write (always denied: there is no company:manage)',
    request: { spec: { kind: 'company' }, intent: 'write' },
    expected: NONE_ALLOWED,
  },
  {
    name: "the caller's own records, my* and DMs (self)",
    request: { spec: { kind: 'self' }, intent: 'write' },
    expected: ALL_ALLOWED,
  },
  {
    name: 'tenant user administration (account users:view)',
    request: { spec: { kind: 'account', capability: 'users:view' }, intent: 'read' },
    expected: { ...NONE_ALLOWED, tenantAdmin: true, tenantAdminWithoutHr: true, superAdmin: true },
  },
];

function outcome(decision: AccessDecision): Expected {
  if (!decision.allowed) return false;
  if (decision.kind !== 'scoped') return true;
  return decision.scope.kind === 'all' ? 'ALL' : decision.scope.modules;
}

/**
 * Typed code cannot hand decideAccess a copied caller or a request that names @Roles for a kind
 * that reads none (the compile-time rows below). A type predicate is unchecked, though: one that
 * reads fields only, as a payload validator or a guard reading handler metadata could write it,
 * lets either through. These are such predicates; the rows that use them prove that decideAccess
 * still refuses what they let through.
 */
function looksLikeUserCaller(value: unknown): value is UserCaller {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'user';
}

function looksLikeAccessRequest(value: unknown): value is AccessRequest {
  return typeof value === 'object' && value !== null && 'spec' in value && 'intent' in value;
}

function fieldCheckedCaller(value: unknown): UserCaller {
  if (!looksLikeUserCaller(value)) throw new Error('the fixture does not look like a caller');
  return value;
}

function fieldCheckedRequest(value: unknown): AccessRequest {
  if (!looksLikeAccessRequest(value)) throw new Error('the fixture does not look like a request');
  return value;
}

describe('decideAccess — the ADR-051 §4 viewer matrix', () => {
  const cells = SURFACES.flatMap((surface) =>
    VIEWER_NAMES.map((viewer) => [surface.name, viewer, surface] as const),
  );

  it.each(cells)('%s — %s', (_name, viewer, surface) => {
    const decision = decideAccess(VIEWERS[viewer], surface.request);
    expect(outcome(decision)).toEqual(surface.expected[viewer]);
    expect(decision.kind).toBe(surface.request.spec.kind);
  });

  it("today's global MODULE_MANAGER changes none of A's and B's cells (A′, B′)", () => {
    for (const surface of SURFACES) {
      expect(outcome(decideAccess(VIEWERS.roleAPrime, surface.request))).toEqual(
        outcome(decideAccess(VIEWERS.roleA, surface.request)),
      );
      expect(outcome(decideAccess(VIEWERS.roleBPrime, surface.request))).toEqual(
        outcome(decideAccess(VIEWERS.roleB, surface.request)),
      );
    }
  });
});

describe('decideAccess — claim shapes', () => {
  it('a missing claim and an empty claim are both no grants', () => {
    const missing = member('m', ['MODULE_USER']);
    const empty = member('e', ['MODULE_USER'], {});
    for (const module of OWNER_MODULE_CODES) {
      const request: AccessRequest = {
        spec: { kind: 'module', module },
        intent: 'read',
        roles: [],
      };
      expect(decideAccess(missing, request)).toEqual({
        allowed: false,
        kind: 'module',
        reason: 'no-grant',
      });
      expect(decideAccess(empty, request)).toEqual(decideAccess(missing, request));
    }
    expect(
      decideAccess(missing, {
        spec: { kind: 'scoped', scope: 'workforce' },
        intent: 'read',
        roles: [],
      }),
    ).toEqual({ allowed: false, kind: 'scoped', reason: 'empty-scope' });
  });

  it('the global role never grants module access, not even TENANT_ADMIN without a grant', () => {
    const adminWithoutClaim = member('a', ['TENANT_ADMIN']);
    expect(
      decideAccess(adminWithoutClaim, {
        spec: { kind: 'module', module: 'farm' },
        intent: 'read',
        roles: ['TENANT_ADMIN'],
      }),
    ).toEqual({ allowed: false, kind: 'module', reason: 'no-grant' });
    expect(
      decideAccess(VIEWERS.tenantAdminWithoutHr, {
        spec: { kind: 'module', module: 'hr' },
        intent: 'read',
        roles: ['TENANT_ADMIN'],
      }),
    ).toEqual({ allowed: false, kind: 'module', reason: 'no-grant' });
  });

  /** Every malformed shape of each claim (ADR-051 §2: malformed is 400), and the claim it names. */
  const MALFORMED: readonly (readonly [string, Partial<VerifiedMemberIdentity>, CallerClaim])[] = [
    ['a grant of an account role', { moduleAccess: { farm: 'SUPER_ADMIN' } }, 'moduleAccess'],
    ['a grant that is no role', { moduleAccess: { hr: 'x' } }, 'moduleAccess'],
    ['a grant in a module no one owns', { moduleAccess: { alert: 'MODULE_USER' } }, 'moduleAccess'],
    ['a grant in a lower-case role', { moduleAccess: { farm: 'module_manager' } }, 'moduleAccess'],
    ['a grant with no value', { moduleAccess: { farm: undefined } }, 'moduleAccess'],
    [
      'a JSON claim naming __proto__',
      { moduleAccess: JSON.parse('{"__proto__":{"sensor":"MODULE_MANAGER"}}') },
      'moduleAccess',
    ],
    ['a null claim', { moduleAccess: null }, 'moduleAccess'],
    ['a string claim', { moduleAccess: 'farm' }, 'moduleAccess'],
    ['an array claim', { moduleAccess: ['farm'] }, 'moduleAccess'],
    ['roles as a string', { roles: 'NOT_A_SUPER_ADMIN_ROLE' }, 'roles'],
    ['roles as one role string', { roles: 'SUPER_ADMIN' }, 'roles'],
    ['roles with a non-string entry', { roles: ['MODULE_USER', 1] }, 'roles'],
    ['roles missing', { roles: undefined }, 'roles'],
    ['capabilities as a string', { capabilities: 'users:view' }, 'capabilities'],
    ['capabilities with a non-string entry', { capabilities: [{}] }, 'capabilities'],
    ['a null capabilities claim', { capabilities: null }, 'capabilities'],
  ];

  it.each(MALFORMED)('a malformed claim never becomes a caller: %s', (_name, claims, claim) => {
    const identity: VerifiedMemberIdentity = {
      userId: 'u',
      tenantId: TENANT,
      roles: ['MODULE_USER'],
      ...claims,
    };
    let thrown: unknown;
    try {
      userCaller(identity);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedCallerError);
    expect(thrown).toMatchObject({ name: 'MalformedCallerError', claim });
  });

  it('a well-formed claim of every owner module is accepted', () => {
    const everyModule: ModuleAccess = Object.fromEntries(
      OWNER_MODULE_CODES.map((module) => [module, 'MODULE_USER']),
    );
    const caller = member('all', ['MODULE_USER'], everyModule);
    for (const module of OWNER_MODULE_CODES) {
      expect(
        decideAccess(caller, { spec: { kind: 'module', module }, intent: 'read', roles: [] }),
      ).toEqual({ allowed: true, kind: 'module' });
    }
  });

  it('a reserved module is gated like any other (hydroponics, D3)', () => {
    const grower = member('g', ['MODULE_USER'], { hydroponics: 'MODULE_USER' });
    const request: AccessRequest = {
      spec: { kind: 'module', module: 'hydroponics' },
      intent: 'read',
      roles: [],
    };
    expect(decideAccess(grower, request)).toEqual({ allowed: true, kind: 'module' });
    expect(decideAccess(VIEWERS.roleA, request).allowed).toBe(false);
  });
});

describe('decideAccess — @Roles checked by kind', () => {
  it('a module role never satisfies an account role', () => {
    expect(
      decideAccess(VIEWERS.roleA, {
        spec: { kind: 'module', module: 'farm' },
        intent: 'write',
        roles: ['TENANT_ADMIN'],
      }),
    ).toEqual({ allowed: false, kind: 'module', reason: 'roles' });
  });

  it('an account role never satisfies a module role', () => {
    const adminWithUserGrant = member('a', ['TENANT_ADMIN'], { farm: 'MODULE_USER' });
    expect(
      decideAccess(adminWithUserGrant, {
        spec: { kind: 'module', module: 'farm' },
        intent: 'write',
        roles: ['MODULE_MANAGER'],
      }),
    ).toEqual({ allowed: false, kind: 'module', reason: 'roles' });
  });

  it("a module role is read for the spec's module only", () => {
    const mixed = member('x', ['MODULE_USER'], { farm: 'MODULE_USER', sensor: 'MODULE_MANAGER' });
    expect(
      decideAccess(mixed, {
        spec: { kind: 'module', module: 'farm' },
        intent: 'write',
        roles: ['MODULE_MANAGER'],
      }),
    ).toEqual({ allowed: false, kind: 'module', reason: 'roles' });
  });

  it('a scope keeps only the modules whose grant satisfies @Roles', () => {
    const mixed = member('x', ['MODULE_USER'], { farm: 'MODULE_MANAGER', sensor: 'MODULE_USER' });
    expect(
      decideAccess(mixed, {
        spec: { kind: 'scoped', scope: 'alerts' },
        intent: 'write',
        roles: ['MODULE_MANAGER'],
      }),
    ).toEqual({ allowed: true, kind: 'scoped', scope: { kind: 'modules', modules: ['farm'] } });
  });

  /** A request for a kind that reads no @Roles, but naming roles: not an AccessRequest. */
  type WithRoles<Spec> = {
    readonly spec: Spec;
    readonly intent: AccessIntent;
    readonly roles: readonly PlatformRole[];
  };

  it('company, self and account requests cannot name @Roles (compile time)', () => {
    const selfWithRoles: [WithRoles<SelfAccessSpec>] extends [AccessRequest] ? true : false = false;
    const companyWithRoles: [WithRoles<CompanyAccessSpec>] extends [AccessRequest] ? true : false =
      false;
    const accountWithRoles: [WithRoles<AccountAccessSpec>] extends [AccessRequest] ? true : false =
      false;
    expect([selfWithRoles, companyWithRoles, accountWithRoles]).toEqual([false, false, false]);
  });

  // Typed code cannot build these requests (the row above); a field-checked one arrives anyway.
  it.each([
    ['self', '{"spec":{"kind":"self"},"intent":"write","roles":["TENANT_ADMIN"]}'],
    ['company', '{"spec":{"kind":"company"},"intent":"read","roles":["TENANT_ADMIN"]}'],
    [
      'account',
      '{"spec":{"kind":"account","capability":"users:view"},"intent":"read","roles":["SUPER_ADMIN"]}',
    ],
  ])('a %s request that names @Roles is denied, never decided without them', (kind, json) => {
    const request = fieldCheckedRequest(JSON.parse(json));
    for (const viewer of VIEWER_NAMES) {
      expect(decideAccess(VIEWERS[viewer], request)).toEqual({
        allowed: false,
        kind,
        reason: 'roles',
      });
    }
  });

  it('an hr grant gives ALL for workforce only when it satisfies @Roles', () => {
    const hrUser = member('h', ['MODULE_USER'], { hr: 'MODULE_USER', farm: 'MODULE_MANAGER' });
    expect(
      decideAccess(hrUser, {
        spec: { kind: 'scoped', scope: 'workforce' },
        intent: 'read',
        roles: [],
      }),
    ).toEqual({ allowed: true, kind: 'scoped', scope: ALL_MODULES_SCOPE });
    expect(
      decideAccess(hrUser, {
        spec: { kind: 'scoped', scope: 'workforce' },
        intent: 'write',
        roles: ['MODULE_MANAGER'],
      }),
    ).toEqual({ allowed: true, kind: 'scoped', scope: { kind: 'modules', modules: ['farm'] } });
  });
});

describe('decideAccess — service callers (ADR-051 §3 NATS requests)', () => {
  const TANK_REGISTRY: ServiceSubjectAccess = {
    caller: 'service',
    intent: 'read',
    senders: ['messaging_service'],
  };
  const TIME_ZONES: ServiceSubjectAccess = {
    caller: 'service',
    intent: 'read',
    senders: ['sensor_service'],
  };
  const messaging = serviceCaller('messaging_service');

  it('a declared sender passes `service` with the entry intent', () => {
    expect(
      decideAccess(messaging, { spec: { kind: 'service', entry: TANK_REGISTRY }, intent: 'read' }),
    ).toEqual({ allowed: true, kind: 'service' });
  });

  it('fails for a write intent: no service entry writes', () => {
    expect(
      decideAccess(messaging, { spec: { kind: 'service', entry: TANK_REGISTRY }, intent: 'write' }),
    ).toEqual({ allowed: false, kind: 'service', reason: 'intent' });
  });

  it('fails for a subject the service does not send', () => {
    expect(
      decideAccess(messaging, { spec: { kind: 'service', entry: TIME_ZONES }, intent: 'read' }),
    ).toEqual({ allowed: false, kind: 'service', reason: 'not-a-sender' });
    expect(
      decideAccess(serviceCaller('ai_service'), {
        spec: { kind: 'service', entry: TANK_REGISTRY },
        intent: 'read',
      }),
    ).toEqual({ allowed: false, kind: 'service', reason: 'not-a-sender' });
  });

  it.each(SURFACES.map((surface) => [surface.name, surface.request] as const))(
    'a service caller fails every member kind: %s',
    (_name, request) => {
      const decision = decideAccess(messaging, request);
      expect(decision).toEqual({ allowed: false, kind: request.spec.kind, reason: 'caller-kind' });
    },
  );

  it.each(VIEWER_NAMES)(
    'every member fails `service`, TENANT_ADMIN and SUPER_ADMIN included: %s',
    (viewer) => {
      const caller: Caller = VIEWERS[viewer];
      expect(
        decideAccess(caller, { spec: { kind: 'service', entry: TANK_REGISTRY }, intent: 'read' }),
      ).toEqual({ allowed: false, kind: 'service', reason: 'caller-kind' });
    },
  );
});

describe('deriveServiceGrants (SERVICE_GRANTS is derived, never written by hand)', () => {
  const REQUEST_ACCESS = {
    'request.farm.getTankRegistry': {
      caller: 'service',
      intent: 'read',
      senders: ['messaging_service'],
    },
    'request.farm.resolveTimeZones': {
      caller: 'service',
      intent: 'read',
      senders: ['sensor_service'],
    },
    'request.farm.validateSiteAssignment': {
      caller: 'service',
      intent: 'read',
      senders: ['auth_service', 'sensor_service'],
    },
    'request.farm.createTask': {
      caller: 'user',
      spec: { kind: 'module', module: 'farm' },
      intent: 'write',
      senders: ['ai_service'],
    },
  } as const satisfies Readonly<Record<string, SubjectAccess>>;

  it('maps each declared sender of a service subject to the subject and its intent', () => {
    expect(deriveServiceGrants(REQUEST_ACCESS)).toEqual({
      messaging_service: { 'request.farm.getTankRegistry': 'read' },
      sensor_service: {
        'request.farm.resolveTimeZones': 'read',
        'request.farm.validateSiteAssignment': 'read',
      },
      auth_service: { 'request.farm.validateSiteAssignment': 'read' },
    });
  });

  it('gives a member subject no service grant, and freezes what it derives', () => {
    const grants = deriveServiceGrants(REQUEST_ACCESS);
    expect(grants.ai_service).toBeUndefined();
    expect(Object.isFrozen(grants)).toBe(true);
    for (const subjects of Object.values(grants)) {
      expect(Object.isFrozen(subjects)).toBe(true);
    }
  });
});

describe('the caller vocabulary', () => {
  /** The public fields of a UserCaller: all a hand-written literal can hold. */
  type HandWritten = { readonly [K in keyof UserCaller]: UserCaller[K] };

  it('builds a member caller through userCaller, frozen, from a copy of the claim', () => {
    const claim: { farm?: 'MODULE_MANAGER' | 'MODULE_USER' } = { farm: 'MODULE_MANAGER' };
    const caller = member('u', ['MODULE_USER', 'TENANT_ADMIN'], claim, ['users:view']);
    claim.farm = 'MODULE_USER';
    expect(caller).toMatchObject({
      kind: 'user',
      userId: 'u',
      tenantId: TENANT,
      accountRole: 'TENANT_ADMIN',
      moduleAccess: { farm: 'MODULE_MANAGER' },
      capabilities: ['users:view'],
    });
    expect(Object.isFrozen(caller)).toBe(true);
    expect(Object.isFrozen(caller.moduleAccess)).toBe(true);
    expect(Object.isFrozen(caller.capabilities)).toBe(true);
    // The global MODULE_MANAGER is no account role.
    expect(member('m', ['MODULE_MANAGER'], {}).accountRole).toBeNull();
    expect(isUserCaller(caller)).toBe(true);
    // A hand-written object of the same fields is not a UserCaller: the brand is an ES private
    // field, which no literal can hold.
    const handWrittenIsCaller: [HandWritten] extends [UserCaller] ? true : false = false;
    expect(handWrittenIsCaller).toBe(false);
  });

  describe('a copy of a real caller is no caller', () => {
    const real = member('real', ['MODULE_USER']);
    const unchanged = { ...real };
    const widened = {
      ...real,
      accountRole: 'TENANT_ADMIN' as const,
      moduleAccess: { hr: 'MODULE_MANAGER' as const },
    };
    const hr: AccessRequest = { spec: { kind: 'module', module: 'hr' }, intent: 'read', roles: [] };

    it('a spread, unchanged or widened, does not compile as a UserCaller', () => {
      const unchangedIsCaller: [typeof unchanged] extends [UserCaller] ? true : false = false;
      const widenedIsCaller: [typeof widened] extends [UserCaller] ? true : false = false;
      expect([unchangedIsCaller, widenedIsCaller]).toEqual([false, false]);
    });

    /** The caller's class prototype, so a copy can pass an `instanceof` check too. */
    function callerPrototype(): object | null {
      const prototype: unknown = Object.getPrototypeOf(real);
      if (typeof prototype !== 'object') throw new Error('a caller has an object prototype');
      return prototype;
    }

    // Typed code cannot pass these copies (the row above); a field-checked copy arrives anyway.
    it.each([
      ['an unchanged spread', (): unknown => ({ ...unchanged })],
      ['a widened spread', (): unknown => ({ ...widened })],
      [
        'a widened spread given the caller prototype',
        (): unknown => Object.setPrototypeOf({ ...widened }, callerPrototype()),
      ],
      [
        'a JSON copy (a caller sent over the wire)',
        (): unknown => JSON.parse(JSON.stringify(real)),
      ],
    ])('%s is denied on every kind a member can ask', (_name, copy) => {
      const copied = copy();
      expect(isUserCaller(copied)).toBe(false);
      const forged = fieldCheckedCaller(copied);
      for (const request of [hr, ...SURFACES.map((surface) => surface.request)]) {
        expect(decideAccess(forged, request)).toEqual({
          allowed: false,
          kind: request.spec.kind,
          reason: 'unverified-caller',
        });
      }
      expect(isUserCaller(real)).toBe(true);
      expect(decideAccess(real, hr)).toEqual({
        allowed: false,
        kind: 'module',
        reason: 'no-grant',
      });
    });
  });

  it('names a service caller by its services.yaml identity', () => {
    expect(serviceCaller('auth_service')).toEqual({ kind: 'service', service: 'auth_service' });
    expect(NATS_SERVICE_NAMES).toContain('messaging_service');
    expect(Object.isFrozen(NATS_SERVICE_NAMES)).toBe(true);
  });

  it.each([
    [{}, true],
    [{ farm: 'MODULE_MANAGER', hr: 'MODULE_USER', hydroponics: 'MODULE_USER' }, true],
    [{ alert: 'MODULE_USER' }, false],
    [{ farm: 'TENANT_ADMIN' }, false],
    [{ farm: 'module_manager' }, false],
    [{ farm: undefined }, false],
    [null, false],
    [[], false],
    ['farm', false],
  ])('isModuleAccess(%j) is %s', (value, expected) => {
    expect(isModuleAccess(value)).toBe(expected);
  });
});
