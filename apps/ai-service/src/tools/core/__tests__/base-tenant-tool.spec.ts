import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { TenantScopedTool } from '../base-tenant-tool';
import { Tool } from '../tool.decorator';
import { ToolExecutionContext } from '../tool.interface';
import { humanToolContext } from '../../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';
import { TenantBoundaryViolation } from '../../../tenant-boundary/tenant-boundary-violation';

/**
 * AISAFETY-LOW-018 concurrency guard.
 *
 * TenantScopedTool is a singleton; the active QueryRunner must be bound to each
 * async execution (AsyncLocalStorage), never stored on the instance. This spec
 * runs two executions concurrently against different tenant schemas and asserts
 * each run() observes its OWN runner — proving no cross-tenant leak on the
 * shared instance. Runners are labelled via a WeakMap so no `as`-casts are
 * needed to identify which runner a run() saw.
 */

const runnerLabel = new WeakMap<object, string>();

@Tool({
  name: 'probe_tenant_runner',
  description: 'test tool that records which runner it saw',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator'],
  inputSchema: { type: 'object' },
  requiresModule: null,
  requiresConfirmation: false,
})
class ProbeTool extends TenantScopedTool<{ gate: Promise<void> }, string> {
  /** Expose the protected getter so the outside-execute() throw can be tested. */
  peekRunner(): QueryRunner {
    return this.queryRunner;
  }

  protected async run(input: { gate: Promise<void> }): Promise<string> {
    // Capture our runner, park on a barrier so the other execution interleaves,
    // then read again. Same runner across the await → our async context held.
    const before = this.queryRunner;
    await input.gate;
    const after = this.queryRunner;
    if (before !== after) {
      throw new Error('runner changed mid-run — async context was clobbered');
    }
    return runnerLabel.get(after) ?? 'unlabelled';
  }
}

function makeDataSource(label: string): DataSource {
  const qr = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  runnerLabel.set(qr, label);
  const ds = { createQueryRunner: (): QueryRunner => qr as never };
  return ds as never;
}

/** Tenants whose schemas the platform SSoT derives as tenant_aaaa…/tenant_bbbb…/tenant_cccc…. */
const TENANT_OF = {
  a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  s: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

// K10 (MT-HIGH-062): the schema comes from the tenant binding, never from a
// separately supplied field — the test builds contexts the way production does.
const ctx = (tenant: keyof typeof TENANT_OF): ToolExecutionContext =>
  humanToolContext({ tenantId: TENANT_OF[tenant], userId: 'u1', userRoles: ['operator'] });

describe('TenantScopedTool concurrency isolation (AISAFETY-LOW-018)', () => {
  it('each concurrent execution sees its OWN queryRunner (no cross-tenant race)', async () => {
    const toolA = new ProbeTool(makeDataSource('runner_a'));
    const toolB = new ProbeTool(makeDataSource('runner_b'));

    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));

    // Start both; each parks on its gate mid-run() so they interleave.
    const runA = toolA.execute({ gate: gateA }, ctx('a'));
    const runB = toolB.execute({ gate: gateB }, ctx('b'));

    // Release in reverse order to maximise interleaving.
    releaseB();
    releaseA();

    const [resA, resB] = await Promise.all([runA, runB]);

    expect(resA.success).toBe(true);
    expect(resA.data).toBe('runner_a');
    expect(resB.success).toBe(true);
    expect(resB.data).toBe('runner_b');
  });

  it('reading queryRunner outside execute() throws (no ambient runner to leak)', () => {
    const tool = new ProbeTool(makeDataSource('runner_x'));
    expect(() => tool.peekRunner()).toThrow(/only available inside run/i);
  });

  it('sets the tenant search_path on the runner before running', async () => {
    const captured: string[] = [];
    const qr = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockImplementation((sql: string) => {
        captured.push(sql);
        return Promise.resolve(undefined);
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const ds = { createQueryRunner: (): QueryRunner => qr as never };
    const tool = new ProbeTool(ds as never);

    await tool.execute({ gate: Promise.resolve() }, ctx('s'));

    expect(captured[0]).toContain('SET search_path TO "tenant_cccccccccccc4ccc"');
  });

  it('lets a tenant-boundary violation from run() escape so the AI run stops (K10)', async () => {
    // SCENARIO: run() hits a reply served for another tenant.
    // EXPECTS: the violation propagates instead of becoming a "schema unavailable" tool error.
    @Tool({
      name: 'probe_violating_runner',
      description: 'test tool whose run() crosses the tenant boundary',
      category: 'farm_query',
      runtime: 'cloud',
      requiredPermissions: ['operator'],
      inputSchema: { type: 'object' },
      requiresModule: null,
      requiresConfirmation: false,
    })
    class ViolatingTool extends TenantScopedTool<Record<string, never>, string> {
      protected run(): Promise<string> {
        return Promise.reject(
          new TenantBoundaryViolation('request.farm.ai.x', 'reply_tenant_mismatch'),
        );
      }
    }
    const tool = new ViolatingTool(makeDataSource('runner_v'));

    await expect(tool.execute({}, ctx('a'))).rejects.toBeInstanceOf(TenantBoundaryViolation);
  });
});
