import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeTestGaps } from './test-gap-adapter';

const workspace = makeFixtureTree('aria-test-gap-adapter-');
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
// A write boundary is a route or handler the framework wires up (DET testgap-1):
// the method carries its write decorator, not just a name that sounds like one.
writeFileSync(
  join(root, 'batch', 'unsafe.controller.ts'),
  `
    import { Post } from '@nestjs/common';
    export class UnsafeController {
      constructor(private readonly batches: BatchWriter) {}
      @Post()
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
const e2eWorkspace = makeFixtureTree('aria-test-gap-e2e-');
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

// DET testgap-1 (ledger B03, Z-C3) — "performs writes" is what the class DOES:
// a write decorator on a method, or a @CommandHandler class that is not a
// @QueryHandler. It used to be a text regex over the whole file, which read
// createQueryBuilder( in a query handler, `@Post` in a comment and `.create(`
// entity construction as writes, and missed a command handler that only
// saves, inserts or soft-deletes.
const writesWorkspace = makeFixtureTree('aria-test-gap-writes-');
const writesRoot = 'apps/farm-service/src';
const put = (path: string, body: string): void => {
  mkdirSync(join(writesWorkspace, writesRoot, path, '..'), { recursive: true });
  writeFileSync(join(writesWorkspace, writesRoot, path), body, 'utf8');
};
writeFileSync(
  join(writesWorkspace, 'tsconfig.base.json'),
  JSON.stringify({ compilerOptions: { paths: { '@farm/*': [`${writesRoot}/*`] } } }),
  'utf8',
);

// Writes with no spec anywhere: every one is a gap.
put(
  'pond/pond-registry.controller.ts',
  `import { Body, Controller, Post } from '@nestjs/common';

@Controller('ponds')
export class PondRegistryController {
  constructor(private readonly ponds: PondService) {}

  @Post()
  createPond(@Body() dto: CreatePondDto): Promise<string> {
    return this.ponds.register(dto);
  }
}
`,
);
// Each write decorator on its own, with a method name no text rule would read.
for (const decorator of ['Post', 'Put', 'Patch', 'Delete', 'Mutation']) {
  const resolver = decorator === 'Mutation';
  put(
    `write-routes/${decorator.toLowerCase()}-route.${resolver ? 'resolver' : 'controller'}.ts`,
    `export class ${decorator}Route${resolver ? 'Resolver' : 'Controller'} {
  constructor(private readonly store: RouteStore) {}

  @${decorator}()
  apply(): Promise<void> {
    return this.store.apply();
  }
}
`,
  );
}
put(
  'shift/shift-swap.handler.ts',
  `import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

@CommandHandler(SwapShiftCommand)
export class SwapShiftHandler implements ICommandHandler<SwapShiftCommand> {
  constructor(private readonly shifts: ShiftRepository) {}

  async execute(command: SwapShiftCommand): Promise<void> {
    await this.shifts.remove(command.shiftId);
  }
}
`,
);
// Command handlers whose only writes are verbs the text rule never knew.
put(
  'feed/record-feed.handler.ts',
  `import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

@CommandHandler(RecordFeedCommand)
export class RecordFeedHandler implements ICommandHandler<RecordFeedCommand> {
  constructor(private readonly feeds: FeedRepository) {}

  async execute(command: RecordFeedCommand): Promise<void> {
    await this.feeds.insert(command.entry);
  }
}
`,
);
put(
  'batch/retire-batch.handler.ts',
  `import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

@CommandHandler(RetireBatchCommand)
export class RetireBatchHandler implements ICommandHandler<RetireBatchCommand> {
  constructor(private readonly batches: BatchRepository) {}

  async execute(command: RetireBatchCommand): Promise<void> {
    await this.batches.softDelete(command.batchId);
  }
}
`,
);

// Near-misses: none of these performs a write, so none is a write-boundary gap.
put(
  'pond/pond-report.controller.ts',
  `import { Controller, Get } from '@nestjs/common';

@Controller('ponds')
export class PondReportController {
  constructor(private readonly ponds: PondRepository) {}

  @Get('report')
  report(): Promise<PondRow[]> {
    return this.ponds.createQueryBuilder('pond').getMany();
  }
}
`,
);
put(
  'batch/get-batch.handler.ts',
  `import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

@QueryHandler(GetBatchQuery)
export class GetBatchHandler implements IQueryHandler<GetBatchQuery> {
  constructor(private readonly batches: BatchRepository) {}

  async execute(query: GetBatchQuery): Promise<BatchView[]> {
    const builder = this.batches.createQueryBuilder('batch');
    const runner = this.batches.manager.connection.createQueryRunner();
    await runner.release();
    return builder.where('batch.pondId = :pondId', { pondId: query.pondId }).getMany();
  }
}
`,
);
put(
  'pond/list-ponds.handler.ts',
  `import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

@QueryHandler(ListPondsQuery)
export class ListPondsHandler implements IQueryHandler<ListPondsQuery> {
  constructor(private readonly ponds: PondRepository) {}

  async execute(query: ListPondsQuery): Promise<PondView[]> {
    const rows = await this.ponds.find({ where: { farmId: query.farmId } });
    return rows.map((row) => this.ponds.create(row));
  }
}
`,
);
put(
  'pond/pond-comments.controller.ts',
  `import { Controller, Get } from '@nestjs/common';

// Reads only. Writes live in PondRegistryController (@Post) and are never
// reached from here: no update(), no delete(), no remove().
/* @Delete is deliberately absent. */
@Controller('ponds')
export class PondCommentsController {
  constructor(private readonly ponds: PondRepository) {}

  @Get('comments')
  comments(): Promise<string[]> {
    return this.ponds.listComments();
  }
}
`,
);
put(
  'pond/pond-docs.controller.ts',
  `import { Controller, Get } from '@nestjs/common';

@Controller('ponds')
export class PondDocsController {
  constructor(private readonly docs: DocsRepository) {}

  @Get('docs')
  @ApiOperation({ summary: 'Read-only listing: a @Post here is rejected, use the registry' })
  listDocs(): Promise<string[]> {
    return this.docs.titles();
  }
}
`,
);
// A service is not one of the role suffixes, whatever decorates it.
put(
  'pond/pond-registry.service.ts',
  `import { Post } from '@nestjs/common';

export class PondRegistryService {
  constructor(private readonly ponds: PondRepository) {}

  @Post()
  register(dto: CreatePondDto): Promise<string> {
    return this.ponds.add(dto);
  }
}
`,
);
// A write handler with a spec beside it (adjacency) ...
put(
  'shift/swap-seat.handler.ts',
  `import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

@CommandHandler(SwapSeatCommand)
export class SwapSeatHandler implements ICommandHandler<SwapSeatCommand> {
  constructor(private readonly seats: SeatRepository) {}

  async execute(command: SwapSeatCommand): Promise<void> {
    await this.seats.save(command.seat);
  }
}
`,
);
put(
  'shift/__tests__/swap-seat.handler.spec.ts',
  `import { SwapSeatHandler } from '../swap-seat.handler';

test('swaps a seat', async () => {
  const seats = { save: jest.fn() };
  await new SwapSeatHandler(seats).execute({ seat: {} });
});
`,
);
// ... and one reached only by an import through the workspace path alias.
put(
  'pond/open-pond.handler.ts',
  `import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

@CommandHandler(OpenPondCommand)
export class OpenPondHandler implements ICommandHandler<OpenPondCommand> {
  constructor(private readonly ponds: PondRepository) {}

  async execute(command: OpenPondCommand): Promise<void> {
    await this.ponds.save(command.pond);
  }
}
`,
);
put(
  '__tests__/integration/pond-lifecycle.spec.ts',
  `import { OpenPondHandler } from '@farm/pond/open-pond.handler';

test('opens a pond', async () => {
  const ponds = { save: jest.fn() };
  await new OpenPondHandler(ponds).execute({ pond: {} });
});
`,
);
// A decorated write that returns a constant and takes nothing has no
// behaviour a test could pin (the existing constant carve-out).
put(
  'status/ping.controller.ts',
  `import { Controller, Post } from '@nestjs/common';

@Controller('ping')
export class PingController {
  @Post()
  acknowledge(): string {
    return 'ok';
  }
}
`,
);

const writeGapRule = 'high_risk_source_without_adjacent_test';
const writeGaps = (result: ReturnType<typeof analyzeTestGaps>): string[] =>
  result.findings
    .filter((finding) => finding.rule === writeGapRule)
    .map((finding) => finding.path.slice(`${writesRoot}/`.length))
    .sort();

// Zero production change: the write-boundary findings stay behind their flag.
assert.deepEqual(
  writeGaps(analyzeTestGaps({ roots: [writesRoot] }, writesWorkspace)),
  [],
  'without includeWriteBoundaryFindings the rule emits nothing, whatever the predicate says',
);

const expectedWriteGaps = [
  'batch/retire-batch.handler.ts',
  'feed/record-feed.handler.ts',
  'pond/pond-registry.controller.ts',
  'shift/shift-swap.handler.ts',
  'write-routes/delete-route.controller.ts',
  'write-routes/mutation-route.resolver.ts',
  'write-routes/patch-route.controller.ts',
  'write-routes/post-route.controller.ts',
  'write-routes/put-route.controller.ts',
];
const actualWriteGaps = writeGaps(
  analyzeTestGaps({ roots: [writesRoot], includeWriteBoundaryFindings: true }, writesWorkspace),
);
assert.deepEqual(
  {
    missed: expectedWriteGaps.filter((path) => !actualWriteGaps.includes(path)),
    falseAlarms: actualWriteGaps.filter((path) => !expectedWriteGaps.includes(path)),
  },
  { missed: [], falseAlarms: [] },
  'a write decorator or a @CommandHandler is a write boundary; a @QueryHandler, a @Get route, ' +
    'a comment or string naming a decorator, a non-role file, a covered handler and a constant ' +
    'class are not',
);

// The curated semantic_regression case is the fixture lane's pin of the same
// predicate. Its input runs here as well, so the write handler, its covered twin
// and the query-handler trap are enforced by this suite, not only by the nightly
// fixture refresh.
const repoRoot = resolve(__dirname, '..', '..');
const semanticFixtures = 'tools/aria-adapters/fixtures/test-gap-adapter';
const semanticCase = JSON.parse(
  readFileSync(join(repoRoot, semanticFixtures, 'cases', 'semantic-adjacent-tests.json'), 'utf8'),
) as { readonly input: Parameters<typeof analyzeTestGaps>[0] };
assert.deepEqual(
  analyzeTestGaps(semanticCase.input, repoRoot).findings.map((finding) => finding.path),
  [
    `${semanticFixtures}/workspaces/semantic-testgap/apps/billing-service/src/payment/refund.handler.ts`,
  ],
  'the semantic fixture flags the uncovered command handler only: not its covered twin, not the query handler',
);

process.stdout.write('test-gap-adapter tests passed\n');
