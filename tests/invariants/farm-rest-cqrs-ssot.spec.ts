import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BATCH_CONTROLLER = 'apps/farm-service/src/batch/controllers/batch.controller.ts';

describe('INVARIANT: farm REST mutations are CQRS adapters', () => {
  const source = readFileSync(resolve(REPO_ROOT, BATCH_CONTROLLER), 'utf8');

  it('does not call legacy BatchService write-owner methods from REST controllers', () => {
    expect(source).not.toMatch(
      /this\.batchService\.(createBatch|deleteBatch|allocateBatchToTank|recordOperation|updateBatchMetrics)\(/,
    );
  });

  it('routes batch REST writes through CommandBus and batch metrics through QueryBus', () => {
    expect(source).toMatch(/private readonly commandBus: CommandBus/);
    expect(source).toMatch(/private readonly queryBus: QueryBus/);
    expect(source).toMatch(/new CreateBatchCommand\(/);
    expect(source).toMatch(/new DeleteBatchCommand\(/);
    expect(source).toMatch(/new AllocateToTankCommand\(/);
    expect(source).toMatch(/new RecordMortalityCommand\(/);
    expect(source).toMatch(/new RecordCullCommand\(/);
    expect(source).toMatch(/new TransferBatchCommand\(/);
    expect(source).toMatch(/new CreateHarvestRecordCommand\(/);
    expect(source).toMatch(/new GetBatchPerformanceQuery\(/);
    expect(source).not.toMatch(/updateBatchMetrics\(/);
  });

  it('routes status updates through the existing CQRS status command', () => {
    expect(source).toMatch(/new UpdateBatchStatusCommand\(/);
    expect(source).not.toMatch(/this\.batchService\.updateBatch\(/);
  });

  it('does not use raw identity headers as REST tenant or actor authority', () => {
    expect(source).toMatch(/import type \{ TenantRequest \} from '@aquaculture\/backend-common\/types'/);
    expect(source).toMatch(/verifiedContext\(req: TenantRequest\)/);
    expect(source).not.toMatch(/@Headers\(['"]x-tenant-id['"]\)/);
    expect(source).not.toMatch(/@Headers\(['"]x-user-id['"]\)/);
    expect(source).not.toMatch(/userId \|\| ['"]system['"]/);
  });
});

describe('INVARIANT: CQRS auto-discovery uses class-reference registration', () => {
  const moduleSource = readFileSync(
    resolve(REPO_ROOT, 'platform/libs/cqrs/src/cqrs.module.ts'),
    'utf8',
  );

  it('registers discovered command handlers by command class reference before name fallback', () => {
    expect(moduleSource).toMatch(/commandMetadata\.command/);
    expect(moduleSource).toMatch(/this\.commandBus\.register\(\s*commandMetadata\.command/);
  });

  it('registers discovered query handlers by query class reference before name fallback', () => {
    expect(moduleSource).toMatch(/queryMetadata\.query/);
    expect(moduleSource).toMatch(/this\.queryBus\.register\(\s*queryMetadata\.query/);
  });
});
