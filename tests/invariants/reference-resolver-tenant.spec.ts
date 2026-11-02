/**
 * INVARIANT: a `@ResolveReference` takes the tenant only from the request, never from the
 * federation representation; today's violators may only shrink (ADR-054 draft D-F 3, its rollout
 * PR-2, fixed by its PR-3).
 *
 * WHY: the representation of an `_entities` call is input the caller of the subgraph supplies,
 * while the tenant on the request is the gateway-verified one (the HMAC-bound assertion rebuilt
 * into `req.user`, libs/backend-common/src/middleware/verified-user-assertion.middleware.ts). A
 * reference resolver that selects data by a representation `tenantId` lets whoever can call the
 * subgraph choose the tenant. sensor-service already rejects that pattern
 * (apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts); nothing stops a new resolver, or
 * the next edit of an old one, from taking it up again, and no guard runs on a reference resolver.
 *
 * WHAT, for every `@ResolveReference` of every service under `apps/` (production sources): the
 * representation is its `@Parent()` parameter, else its first parameter (Nest passes the
 * representation first and the GraphQL context second). Two rules, each per handler:
 *   - `reads-tenant-from-representation`: a `tenantId` / `tenant_id` / `tenant` property is read
 *     from the representation or any name derived from it (`rep.tenantId`, `rep['tenantId']`,
 *     `const { tenantId } = rep`, `const x = rep.ctx; x.tenantId`, or destructured in the
 *     signature);
 *   - `passes-representation-whole`: the representation object itself (or an alias, or a rest
 *     copy) is handed to a call or spread, where the callee could read its tenant out of sight.
 * Violations are frozen by key (`file#Class.method:rule`) in
 * tests/invariants/reference-resolver-tenant.baseline.json: a new one FAILS; a fixed one FAILS
 * too until the same PR deletes its key (the message names it), so the baseline is always exactly
 * the violators.
 *
 * It does not prove that a resolver reads the tenant at all (one that relies on the tenant
 * context set from the request is correct); the ADR-051 classification invariant requires
 * `@AccessCaller()` on every reference resolver of an enrolled service. It changes no runtime
 * behaviour.
 */
import {
  baselineDiff,
  referenceTenantViolationsOf,
  staleKeysMessage,
} from './helpers/access-surface';
import { productionSources } from './helpers/module-access-handlers';
import { readRepoFile } from './helpers/module-dictionary-sources';

const BASELINE_FILE = 'tests/invariants/reference-resolver-tenant.baseline.json';

interface ReferenceBaseline {
  readonly _comment: string;
  readonly generated_against: string;
  readonly violations: readonly string[];
}

const baseline = JSON.parse(readRepoFile(BASELINE_FILE)) as ReferenceBaseline;

const referenceFiles = productionSources(['apps'])
  .map((file) => [file, readRepoFile(file)] as const)
  .filter(([, source]) => source.includes('ResolveReference'));

const violations = referenceFiles.flatMap(([file, source]) =>
  referenceTenantViolationsOf(file, source),
);

describe('INVARIANT: reference resolvers take the tenant only from the request (ADR-054 D-F 3)', () => {
  it('no new reference resolver reads its tenant from the representation', () => {
    const { grown, shrunk } = baselineDiff(
      violations.map((violation) => violation.key),
      baseline.violations,
    );
    const problems: string[] = [];
    if (grown.length > 0) {
      const at = new Map(violations.map((violation) => [violation.key, violation.line]));
      problems.push(
        `${grown.length} new reference-resolver tenant violation(s). Take the tenant from the ` +
          'request (context.req.user.tenantId, or @AccessCaller()), as ' +
          'apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts does; do not add the key to ' +
          `${BASELINE_FILE} to silence this spec.\n` +
          grown.map((key) => `  ${key} (line ${at.get(key) ?? '?'})`).join('\n'),
      );
    }
    if (shrunk.length > 0) {
      problems.push(staleKeysMessage(BASELINE_FILE, 'violation key(s)', shrunk));
    }
    if (problems.length > 0) throw new Error(problems.join('\n\n'));
  });

  it('the scan reads the real tree: it finds the reference resolvers of several services', () => {
    const services = new Set(
      referenceFiles.map(([file]) => file.split('/')[1]).filter((service) => service !== undefined),
    );
    expect(services.size).toBeGreaterThanOrEqual(2);
  });
});

describe('reference tenant rules — self-tests on fixture sources', () => {
  const keysOf = (body: string, signature = 'reference: Ref, context: Ctx'): string[] =>
    referenceTenantViolationsOf(
      'apps/x/src/x.resolver.ts',
      `@Resolver(() => T)\nclass R {\n  @ResolveReference()\n  ref(${signature}) {\n${body}\n  }\n}\n`,
    ).map((violation) => violation.key.split(':')[1] ?? '');

  it('the tenant from the request passes', () => {
    expect(
      keysOf(
        '    const tenantId = context?.req?.user?.tenantId;\n' +
          '    return this.repo.findOne({ where: { id: reference.id, tenantId } });',
      ),
    ).toEqual([]);
    expect(
      keysOf(
        '    const caller = context?.req?.user;\n    return this.lookup(reference.id, caller?.tenantId);',
      ),
    ).toEqual([]);
    expect(
      keysOf(
        '    return this.svc.find(ref.id, caller.tenantId);',
        '@Parent() ref: Ref, @AccessCaller() caller: AccessCaller',
      ),
    ).toEqual([]);
  });

  it('a tenant read off the representation fails, in every spelling', () => {
    const fails = ['reads-tenant-from-representation'];
    expect(keysOf('    return this.q.run(reference.id, reference.tenantId);')).toEqual(fails);
    expect(keysOf("    return this.q.run(reference['tenantId']);")).toEqual(fails);
    expect(
      keysOf('    const { id, tenantId } = reference;\n    return this.q.run(id, tenantId);'),
    ).toEqual(fails);
    expect(keysOf('    const r = reference as Ref;\n    return this.q.run(r!.tenantId);')).toEqual(
      fails,
    );
    expect(keysOf('    return this.q.run(id, tenantId);', '{ id, tenantId }: Ref')).toEqual(fails);
    expect(keysOf('    return this.q.run(rep.tenant_id);', 'ctx: Ctx, @Parent() rep: Ref')).toEqual(
      fails,
    );
    // A comment or a string is no read.
    expect(
      keysOf(
        "    // reference.tenantId is never trusted\n    return this.q.run('reference.tenantId');",
      ),
    ).toEqual([]);
  });

  it('handing the whole representation on fails; handing a field of it passes', () => {
    expect(keysOf('    return this.q.run(new GetFarm(reference));')).toEqual([
      'passes-representation-whole',
    ]);
    expect(keysOf('    return this.q.run({ ...reference });')).toEqual([
      'passes-representation-whole',
    ]);
    expect(keysOf('    const { id, ...rest } = reference;\n    return this.q.run(rest);')).toEqual([
      'passes-representation-whole',
    ]);
    expect(keysOf('    const id = reference.id;\n    return this.q.run(id);')).toEqual([]);
  });
});
