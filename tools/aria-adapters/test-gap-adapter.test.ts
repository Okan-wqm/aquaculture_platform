import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeTestGaps } from './test-gap-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-test-gap-adapter-'));
const root = join(workspace, 'apps/farm-service/src');
mkdirSync(join(root, 'batch', '__tests__'), { recursive: true });
mkdirSync(join(root, 'database', 'migrations'), { recursive: true });

writeFileSync(
  join(root, 'batch', 'batch.handler.ts'),
  `
    export class BatchHandler {
      execute() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'batch', '__tests__', 'batch.handler.spec.ts'),
  `
    import { BatchHandler } from '../batch.handler';
    test('handler', () => expect(new BatchHandler().execute()).toBe(true));
  `,
  'utf8',
);
writeFileSync(
  join(root, 'batch', 'unsafe.controller.ts'),
  `
    export class UnsafeController {
      constructor(private readonly batches: BatchWriter) {}
      create() { return this.batches.write(); }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'auth.guard.ts'),
  `
    export class AuthGuard {
      canActivate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'weak-only.guard.ts'),
  `
    export class WeakOnlyGuard {
      canActivate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'batch', '__tests__', 'weak-symbol.spec.ts'),
  `
    test('mentions symbol only', () => expect('WeakOnlyGuard').toBeTruthy());
  `,
  'utf8',
);
writeFileSync(
  join(root, 'database', 'migrations', '001-drop.ts'),
  `
    export class DropTable001 {
      async up(queryRunner: any) {
        await queryRunner.query('DROP TABLE bad');
      }
    }
  `,
  'utf8',
);
// E13 FP class (2): a hazardous migration retired into the `.archive/`
// snapshot corpus is dead code — it must produce NO finding.
mkdirSync(join(root, 'database', 'migrations', '.archive', '2026-01-01T00-00-00-000Z'), {
  recursive: true,
});
writeFileSync(
  join(
    root,
    'database',
    'migrations',
    '.archive',
    '2026-01-01T00-00-00-000Z',
    '000-archived-drop.ts',
  ),
  `
    export class ArchivedDrop000 {
      async up(queryRunner: any) {
        await queryRunner.query('DROP TABLE retired');
      }
    }
  `,
  'utf8',
);
// Deliberate-break trap: this spec basename-matches unsafe.controller.ts, but
// it lives under an archived directory — if the archive filter ever stops
// excluding it from the TEST corpus it would satisfy unsafe.controller's
// coverage lookup and the finding asserted below would vanish.
mkdirSync(join(root, 'batch', 'archive'), { recursive: true });
writeFileSync(
  join(root, 'batch', 'archive', 'unsafe.controller.spec.ts'),
  `
    test('archived spec must not count as live coverage', () => expect(true).toBe(true));
  `,
  'utf8',
);

const output = analyzeTestGaps(
  { roots: ['apps/farm-service/src'], includeWriteBoundaryFindings: true },
  workspace,
);

assert.equal(output.metadata.adapter, 'test-gap-adapter');
assert.equal(
  output.observations.some((item) => item.type === 'test_gap_source_file'),
  true,
);
assert.equal(
  output.observations.some((item) => item.type === 'test_gap_test_file'),
  true,
);
assert.equal(
  output.observations.some((item) => item.type === 'test_gap_coverage_summary'),
  true,
);
assert.equal(
  output.findings.some((finding) => finding.path.endsWith('batch.handler.ts')),
  false,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'high_risk_source_without_adjacent_test' &&
      finding.path.endsWith('unsafe.controller.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'security_source_without_security_test' &&
      finding.path.endsWith('auth.guard.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'security_source_without_security_test' &&
      finding.path.endsWith('weak-only.guard.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'migration_without_test' && finding.path.endsWith('001-drop.ts'),
  ),
  true,
);
// E13 FP class (2): archived corpus is fully excluded from the scan — no
// findings against it, no observations for it, and it never appears in
// read_paths.
assert.equal(
  output.findings.some((finding) => finding.path.includes('.archive')),
  false,
);
assert.equal(
  output.read_paths.some((path) => path.includes('.archive') || path.includes('/archive/')),
  false,
);

// ARIA-MEDIUM-329 — security-sensitivity, high risk and coverage, measured on
// the shapes that produced F-010.
const e2eWorkspace = mkdtempSync(join(tmpdir(), 'aria-test-gap-e2e-'));
const write = (path: string, body: string): void => {
  mkdirSync(join(e2eWorkspace, path, '..'), { recursive: true });
  writeFileSync(join(e2eWorkspace, path), body, 'utf8');
};
// F-010's subject, verbatim: @Public on a read that returns a constant and
// takes no dependencies. Not a public write, not a guard, nothing to break.
write(
  'apps/ai-service/src/health/health.resolver.ts',
  `import { Resolver, Query } from '@nestjs/graphql';
import { Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';

@Resolver()
@Public()
@SkipTenantGuard()
export class HealthResolver {
  @Query(() => String, { description: 'Health check for AI service' })
  aiServiceHealth(): string {
    return 'ok';
  }
}
`,
);
// A public WRITE with a dependency: security-sensitive by definition.
write(
  'apps/auth-service/src/registration/registration.resolver.ts',
  `import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Public } from '@aquaculture/backend-common/decorators';

@Resolver()
export class RegistrationResolver {
  constructor(private readonly registrations: RegistrationService) {}

  @Public()
  @Mutation(() => Boolean)
  registerTenant(@Args('input') input: RegisterInput): Promise<boolean> {
    return this.registrations.register(input);
  }
}
`,
);
// A public REST write, reached by an e2e spec through its route.
write(
  'apps/auth-service/src/session/session.controller.ts',
  `import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '@aquaculture/backend-common/decorators';

@Controller('auth')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Public()
  @Post('login')
  login(@Body() body: LoginDto): Promise<string> {
    return this.sessions.login(body);
  }
}
`,
);
// '@Public' in prose only: no public write, no guard.
write(
  'apps/auth-service/src/session/public-routes.service.ts',
  `// Routes decorated @Public skip the JWT guard; this service only lists them.
export class PublicRoutesService {
  constructor(private readonly registry: RouteRegistry) {}
  list(): string[] {
    return this.registry.publicRoutes();
  }
}
`,
);
// The e2e specs that exercise them (F-010's provider: e2e/tests/mobile/
// ai-action-confirm.spec.ts:68 queries aiServiceHealth).
write(
  'e2e/tests/mobile/ai-action-confirm.spec.ts',
  `test('provision', async () => {
  await client.query(\`query ProvisionAi { aiServiceHealth }\`, {}, { token });
});
`,
);
write(
  'e2e/tests/auth/registration.spec.ts',
  `test('register', async () => {
  await client.mutate(
    \`mutation Register($input: RegisterInput!) { registerTenant(input: $input) }\`,
    { input },
  );
  await request.post('/api/auth/login').send({ email, password });
});
`,
);

const uncovered = analyzeTestGaps({ roots: ['apps'] }, e2eWorkspace);
const covered = analyzeTestGaps({ roots: ['apps'], coverageRoots: ['e2e'] }, e2eWorkspace);
const flagged = (result: typeof covered, suffix: string): string[] =>
  result.findings.filter((finding) => finding.path.endsWith(suffix)).map((finding) => finding.rule);

assert.deepEqual(
  flagged(covered, 'health/health.resolver.ts'),
  [],
  'a @Public constant resolver queried by an e2e spec is not a test gap',
);
assert.deepEqual(
  flagged(uncovered, 'health/health.resolver.ts'),
  [],
  'a @Public read returning a constant with no dependencies is neither security-sensitive nor high-risk',
);
assert.deepEqual(
  flagged(uncovered, 'session/public-routes.service.ts'),
  [],
  "'@Public' in a comment makes nothing security-sensitive",
);
assert.deepEqual(
  flagged(uncovered, 'registration/registration.resolver.ts'),
  ['security_source_without_security_test'],
  'a public write with no coverage signal stays a security test gap',
);
assert.deepEqual(
  flagged(uncovered, 'session/session.controller.ts'),
  ['security_source_without_security_test'],
  'a public REST write with no coverage signal stays a security test gap',
);
assert.deepEqual(
  flagged(covered, 'registration/registration.resolver.ts'),
  [],
  'an e2e spec calling the mutation by field name covers the public write',
);
assert.deepEqual(
  flagged(covered, 'session/session.controller.ts'),
  [],
  'an e2e spec calling the route covers the public REST write',
);
assert.ok(
  covered.read_paths.includes('e2e/tests/mobile/ai-action-confirm.spec.ts'),
  'coverage-provider specs are read, so they appear in read_paths',
);
assert.ok(
  !covered.findings.some((finding) => finding.path.startsWith('e2e/')),
  'a coverage root only provides coverage; it never becomes a finding subject',
);

process.stdout.write('test-gap-adapter tests passed\n');
