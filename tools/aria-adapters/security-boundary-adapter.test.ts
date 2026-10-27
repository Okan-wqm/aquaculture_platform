import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeSecurityBoundaries } from './security-boundary-adapter';

const workspace = makeFixtureTree('aria-security-boundary-adapter-');
const apiRoot = join(workspace, 'apps/gateway-api/src');
const unguardedRoot = join(workspace, 'apps/unguarded-api/src');
const webRoot = join(workspace, 'web/shell/src');
mkdirSync(apiRoot, { recursive: true });
mkdirSync(unguardedRoot, { recursive: true });
mkdirSync(webRoot, { recursive: true });
mkdirSync(join(workspace, '.claude', 'worktrees', 'stale', 'apps', 'bad-api', 'src'), {
  recursive: true,
});

writeFileSync(
  join(apiRoot, 'app.module.ts'),
  `
    import { APP_GUARD } from '@nestjs/core';
    import { AuthGuard } from './auth.guard';
    export const providers = [{ provide: APP_GUARD, useClass: AuthGuard }];
  `,
  'utf8',
);

writeFileSync(
  join(apiRoot, 'health.controller.ts'),
  `
    import { Controller, Get } from '@nestjs/common';
    import { Public, SkipTenantGuard } from './decorators';
    @Controller('health')
    @Public()
    @SkipTenantGuard()
    export class HealthController {
      @Get()
      check() { return 'ok'; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(apiRoot, 'unsafe-public.controller.ts'),
  `
    import { Controller, Post } from '@nestjs/common';
    import { Public } from './decorators';
    @Controller('admin')
    export class UnsafePublicController {
      @Public()
      @Post()
      create() { return 'bad'; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(apiRoot, 'unsafe.resolver.ts'),
  `
    import { Mutation, Resolver } from '@nestjs/graphql';
    @Resolver()
    export class UnsafeResolver {
      @Mutation(() => Boolean)
      mutate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(unguardedRoot, 'unsafe.resolver.ts'),
  `
    import { Mutation, Resolver } from '@nestjs/graphql';
    @Resolver()
    export class UnguardedUnsafeResolver {
      @Mutation(() => Boolean)
      mutate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(apiRoot, 'safe.resolver.ts'),
  `
    import { Mutation, Resolver } from '@nestjs/graphql';
    import { Roles } from './decorators';
    @Resolver()
    @Roles('admin')
    export class SafeResolver {
      @Mutation(() => Boolean)
      mutate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(webRoot, 'unsafe-html.tsx'),
  `
    export function UnsafeHtml({ html }: { html: string }) {
      return <div dangerouslySetInnerHTML={{ __html: html }} />;
    }
  `,
  'utf8',
);
writeFileSync(
  join(webRoot, 'safe-html.tsx'),
  `
    import DOMPurify from 'dompurify';
    export function SafeHtml({ html }: { html: string }) {
      return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
    }
  `,
  'utf8',
);
writeFileSync(
  join(webRoot, 'comment-only-html.tsx'),
  `
    export function CommentOnlyHtml() {
      // Do not use dangerouslySetInnerHTML here.
      return <div>safe</div>;
    }
  `,
  'utf8',
);
writeFileSync(
  join(apiRoot, 'raw-sdk.service.ts'),
  `
    import Anthropic from '@anthropic-ai/sdk';
    export const client = new Anthropic();
  `,
  'utf8',
);
writeFileSync(
  join(workspace, '.claude', 'worktrees', 'stale', 'apps', 'bad-api', 'src', 'stale.controller.ts'),
  `
    import { Controller, Post } from '@nestjs/common';
    import { Public } from './decorators';
    @Controller('stale')
    export class StaleController {
      @Public()
      @Post()
      create() { return 'must-not-be-read'; }
    }
  `,
  'utf8',
);

const output = analyzeSecurityBoundaries(
  { roots: ['apps/gateway-api/src', 'apps/unguarded-api/src', 'web/shell/src'] },
  workspace,
);
const directRootOutput = analyzeSecurityBoundaries({ roots: ['.'] }, workspace);

assert.equal(output.metadata.adapter, 'security-boundary-adapter');
assert.equal(
  output.observations.some((item) => item.type === 'security_boundary_endpoint'),
  true,
);
assert.equal(
  output.observations.some((item) => item.type === 'security_sensitive_sink'),
  true,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'public_write_endpoint_without_allowlist' &&
      finding.path.endsWith('unsafe-public.controller.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'mutation_missing_role_boundary' && finding.path.includes('/unguarded-api/'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'dangerous_html_without_sanitizer' &&
      finding.path.endsWith('unsafe-html.tsx'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'raw_security_sensitive_import' &&
      finding.path.endsWith('raw-sdk.service.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some((finding) => finding.path.endsWith('health.controller.ts')),
  false,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.path.includes('/gateway-api/') && finding.path.endsWith('/unsafe.resolver.ts'),
  ),
  false,
);
assert.equal(
  output.findings.some((finding) => finding.path.endsWith('/safe.resolver.ts')),
  false,
);
assert.equal(
  output.findings.some((finding) => finding.path.endsWith('/safe-html.tsx')),
  false,
);
assert.equal(
  output.findings.some((finding) => finding.path.endsWith('/comment-only-html.tsx')),
  false,
);
assert.equal(
  output.observations.some((observation) => observation.path?.endsWith('/comment-only-html.tsx')),
  false,
);
assert.equal(
  directRootOutput.read_paths.some((path) => path.includes('.claude/worktrees')),
  false,
);
assert.equal(
  directRootOutput.findings.some((finding) => finding.message.includes('must-not-be-read')),
  false,
);

// Z-C1 — a security boundary is also wrong when it differs from the boundaries
// of its class peers, not only when it is absent. Absence cannot be tightened:
// every service registers an APP_GUARD and many classes carry a class-level
// UseGuards (authentication, not authorisation), so a write route without a role
// decorator is quiet by design. What is precise is the class itself:
//   authz_boundary_missing_among_peers: the class has at least 3 non-public write
//     routes, at least 75% of them carry a method-level Roles, Permissions,
//     RequiresCapability or UseGuards, this one does not, and the class has no
//     class-level Roles, Permissions or RequiresCapability. A class-level
//     UseGuards and an APP_GUARD do not cover it.
//   capability_differs_from_class_majority: the class has at least 4
//     RequiresCapability routes, one capability holds at least 75% of them, and
//     this route names another.
// New API pinned here: the two rule ids, read through analyzeSecurityBoundaries
// only. The four seed rows are the two shapes of the defect class behind Z14 (a
// role lost under a class-level guard) and Z03 (a capability swapped for
// another), written afresh as regression seeds; each rule has the near-misses
// where a threshold is not met or the route is deliberately public, so a rule
// that over-flags goes red as well.
const MISSING = 'authz_boundary_missing_among_peers';
const SWAPPED = 'capability_differs_from_class_majority';
const PEER_RULES: readonly string[] = [MISSING, SWAPPED];
const ROLES = "@Roles('TENANT_ADMIN')";
const PERMISSIONS = "@Permissions('stock:write')";
const cap = (value: string): string => `@RequiresCapability('${value}')`;
// One class per row: name | class decorators | routes | lost | swapped. A route
// group is `Verb name[*count] decorators…`; `*4` makes name1..name4. `lost` are
// the routes MISSING must name, `swapped` the routes SWAPPED must name.
const peerTable = `
seed-role-lost-under-class-guard | @Resolver() @UseGuards(TenantGuard) | Mutation write*4 ${ROLES}; Mutation deleteLot; Query lots | deleteLot |
seed-permission-lost-on-delete | @Controller() | Post create ${PERMISSIONS}; Put replace ${PERMISSIONS}; Patch update ${PERMISSIONS}; Delete remove; Get list | remove |
seed-capability-swapped | @Controller() | Get read*2 ${cap('ledger-ops')}; Post write*3 ${cap('ledger-ops')}; Post reverse ${cap('support-ops')} | | reverse
seed-capability-swapped-on-mutation | @Resolver() | Mutation write*4 ${cap('fleet-ops')}; Mutation retire ${cap('support-ops')} | | retire
peer-each-boundary-kind-counts | @Controller() | Post byRole ${ROLES}; Post byPermission ${PERMISSIONS}; Post byCapability ${cap('job-ops')}; Post byGuard @UseGuards(OwnerGuard); Post lost | lost |
peer-three-of-four-is-enough | @Controller() | Post write*3 ${ROLES}; Post lost | lost |
peer-every-unguarded-route-is-named | @Resolver() | Mutation write*6 ${ROLES}; Mutation lostA; Mutation lostB | lostA,lostB |
peer-reads-do-not-dilute | @Resolver() | Mutation write*3 ${ROLES}; Mutation lost; Query read*4 | lost |
peer-public-write-is-not-a-peer | @Resolver() | Mutation write*3 ${ROLES}; Mutation lost; Mutation webhook @Public() | lost |
near-all-unguarded | @Resolver() | Mutation write*5 | |
near-two-routes | @Controller() | Post guarded ${ROLES}; Post open | |
near-two-of-three | @Controller() | Post write*2 ${ROLES}; Post open | |
near-seven-of-ten | @Controller() | Post write*7 ${ROLES}; Post open*3 | |
near-query-among-guarded-writes | @Resolver() | Mutation write*4 ${ROLES}; Query lots; Get item | |
near-public-among-guarded-writes | @Resolver() | Mutation write*4 ${ROLES}; Mutation webhook @Public() | |
near-own-guard | @Controller() | Post write*4 ${ROLES}; Post signed @UseGuards(SignatureGuard) | |
near-class-level-Roles | @Resolver() ${ROLES} | Mutation write*4 ${ROLES}; Mutation open | |
near-class-level-Permissions | @Resolver() ${PERMISSIONS} | Mutation write*4 ${ROLES}; Mutation open | |
near-class-level-RequiresCapability | @Resolver() ${cap('stock-ops')} | Mutation write*4 ${ROLES}; Mutation open | |
cap-three-of-four-is-enough | @Controller() | Post write*3 ${cap('ops-a')}; Post odd ${cap('ops-b')} | | odd
cap-every-outlier-is-named | @Controller() | Post write*6 ${cap('ops-a')}; Post oddB ${cap('ops-b')}; Post oddC ${cap('ops-c')} | | oddB,oddC
near-cap-three-routes | @Controller() | Post write*2 ${cap('ops-a')}; Post odd ${cap('ops-b')} | |
near-cap-even-split | @Controller() | Post first*2 ${cap('ops-a')}; Post second*2 ${cap('ops-b')} | |
near-cap-three-of-five | @Controller() | Post first*3 ${cap('ops-a')}; Post second*2 ${cap('ops-b')} | |
near-cap-quote-style | @Controller() | Post write*4 ${cap('ops-a')}; Post same @RequiresCapability("ops-a") | |
near-cap-other-boundary-kind | @Controller() | Post write*4 ${cap('ops-a')}; Post byRole ${ROLES} | |
near-cap-all-the-same | @Controller() | Post write*5 ${cap('ops-a')} | |
`;
interface PeerCase {
  readonly name: string;
  readonly source: string;
  readonly lost: readonly string[];
  readonly swapped: readonly string[];
}
const names = (cell: string): string[] => cell.split(',').filter((name) => name !== '');
const peerCases: readonly PeerCase[] = peerTable
  .trim()
  .split('\n')
  .map((row): PeerCase => {
    const cells = row.split('|').map((cell) => cell.trim());
    const [name = '', classDecorators = '', routeList = '', lost = '', swapped = ''] = cells;
    const members = routeList.split(';').flatMap((group) => {
      const [verb = '', route = '', ...decorators] = group.trim().split(/\s+/);
      const [base = '', count] = route.split('*');
      const methods =
        count === undefined
          ? [base]
          : Array.from({ length: Number(count) }, (_, i) => `${base}${i + 1}`);
      const verbDecorator =
        verb === 'Mutation' || verb === 'Query' ? `@${verb}(() => Boolean)` : `@${verb}()`;
      return methods.flatMap((method) => [
        ...decorators.map((decorator) => `  ${decorator}`),
        `  ${verbDecorator}`,
        `  ${method}() { return true; }`,
      ]);
    });
    const source = [...classDecorators.split(' '), 'export class PeerClass {', ...members, '}', ''];
    return { name, source: source.join('\n'), lost: names(lost), swapped: names(swapped) };
  });

const peerWorkspace = makeFixtureTree('aria-security-boundary-peers-');
const peerDir = 'apps/peers-api/src';
mkdirSync(join(peerWorkspace, peerDir), { recursive: true });
// Every service registers an APP_GUARD; the peers are judged inside one.
writeFileSync(
  join(peerWorkspace, peerDir, 'app.module.ts'),
  `import { APP_GUARD } from '@nestjs/core';\nexport const providers = [{ provide: APP_GUARD, useClass: JwtAuthGuard }];\n`,
  'utf8',
);
for (const peerCase of peerCases) {
  writeFileSync(
    join(peerWorkspace, peerDir, `${peerCase.name}.controller.ts`),
    peerCase.source,
    'utf8',
  );
}
const peerOutput = analyzeSecurityBoundaries({ roots: [peerDir] }, peerWorkspace);

// Controls, green before and after: the peer rules add findings and change none
// of the others. Inside an APP_GUARD service the only findings of the existing
// rules are the two deliberately public writes, and the committed
// semantic-guard workspace still gives exactly its two findings.
assert.deepEqual(
  [
    ...new Set(
      peerOutput.findings.map((item) => item.rule).filter((rule) => !PEER_RULES.includes(rule)),
    ),
  ],
  ['public_write_endpoint_without_allowlist'],
);
const semanticGuard = analyzeSecurityBoundaries(
  {
    roots: [
      'tools/aria-adapters/fixtures/security-boundary-adapter/workspaces/semantic-guard/apps/api/src',
    ],
  },
  resolve(__dirname, '..', '..'),
);
assert.deepEqual(semanticGuard.findings.map((item) => item.rule).sort(), [
  'controller_missing_guard_boundary',
  'mutation_missing_role_boundary',
]);

// One list of every wrong answer, asserted once, so a failure names them all.
const peerMismatches: string[] = [];
const endpointsOf = (caseName: string): typeof peerOutput.observations =>
  peerOutput.observations.filter(
    (item) =>
      item.type === 'security_boundary_endpoint' &&
      item.path === `${peerDir}/${caseName}.controller.ts`,
  );
const flaggedBy = (rule: string, caseName: string): string[] =>
  peerOutput.findings
    .filter((item) => item.rule === rule && item.path === `${peerDir}/${caseName}.controller.ts`)
    .map(
      (item) =>
        endpointsOf(caseName).find((endpoint) => endpoint.line === item.line)?.name ??
        `<no route at line ${item.line}>`,
    )
    .sort();
for (const peerCase of peerCases) {
  const expected = { lost: [...peerCase.lost].sort(), swapped: [...peerCase.swapped].sort() };
  const observed = {
    lost: flaggedBy(MISSING, peerCase.name),
    swapped: flaggedBy(SWAPPED, peerCase.name),
  };
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    peerMismatches.push(
      `${peerCase.name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(observed)}`,
    );
  }
}
// RequiresCapability is a boundary decorator: the endpoint observation lists it.
const decoratorRows: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['seed-capability-swapped', 'reverse', ['RequiresCapability']],
  ['near-class-level-RequiresCapability', 'write1', ['RequiresCapability', 'Roles']],
  ['near-class-level-RequiresCapability', 'open', ['RequiresCapability']],
];
for (const [caseName, method, expected] of decoratorRows) {
  const observed = endpointsOf(caseName).find((endpoint) => endpoint.name === method)?.details
    ?.securityDecorators;
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    peerMismatches.push(
      `${caseName}.${method} securityDecorators: expected ${JSON.stringify(expected)}, got ${JSON.stringify(observed)}`,
    );
  }
}
// Both rules ship SHADOW with a complete rule contract in the manifest.
interface RuleContract {
  readonly defect_claim?: unknown;
  readonly premises?: unknown;
}
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'security-boundary-adapter.tool.json'), 'utf8'),
) as { status: string; rules: Record<string, RuleContract> };
if (manifest.status !== 'SHADOW') {
  peerMismatches.push(`manifest: status is ${manifest.status}, the peer rules ship SHADOW`);
}
for (const rule of PEER_RULES) {
  const contract: RuleContract | undefined = manifest.rules[rule];
  if (
    !contract ||
    typeof contract.defect_claim !== 'string' ||
    !Array.isArray(contract.premises) ||
    contract.premises.length === 0
  ) {
    peerMismatches.push(`manifest: no complete rule contract for ${rule}`);
  }
}
assert.deepEqual(peerMismatches, []);
// A peer finding cites the route it names, and two in one file keep distinct ids.
for (const finding of peerOutput.findings.filter((item) => PEER_RULES.includes(item.rule))) {
  assert.deepEqual(finding.evidence, [{ path: finding.path, line: finding.line }]);
}
assert.equal(new Set(peerOutput.findings.map((item) => item.id)).size, peerOutput.findings.length);

process.stdout.write('security-boundary-adapter tests passed\n');
