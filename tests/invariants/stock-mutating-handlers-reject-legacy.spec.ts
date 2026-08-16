/**
 * Invariant (FARM-HIGH-052): every STOCK-MUTATING farm command handler must
 * reject the MobileCommandReceiptService 'legacy' (no idempotency key) mode.
 *
 * WHY a static source grep: the tier-1 fix makes clientCommandId + payloadHash
 * mandatory on the GraphQL inputs and REST DTOs, so a missing key is
 * structurally rejected at the edge. This gate is the tier-3 backstop — if a
 * future refactor removes the `receipt.mode === 'legacy'` reject from a
 * stock-mutating handler, a retry could silently double-decrement stock again.
 * Catching it at test time keeps the two fronts honest with the handler.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const STOCK_MUTATING_HANDLERS = [
  'apps/farm-service/src/batch/handlers/record-mortality.handler.ts',
  'apps/farm-service/src/batch/handlers/record-cull.handler.ts',
  'apps/farm-service/src/batch/handlers/transfer-batch.handler.ts',
];

describe('stock-mutating handlers reject legacy idempotency mode', () => {
  it.each(STOCK_MUTATING_HANDLERS)('%s rejects receipt.mode === legacy', (relPath) => {
    const source = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

    // The handler must explicitly branch on the legacy mode AND throw.
    expect(source).toMatch(/receipt\.mode\s*===\s*'legacy'/);
    // The reject is a BadRequestException for the missing idempotency envelope.
    expect(source).toMatch(/throw new BadRequestException\([^)]*idempotency envelope/);
  });

  it('keeps mobile meal identity validation in the canonical codec consumed by the sole port', () => {
    const coordinator = readFileSync(
      path.join(
        REPO_ROOT,
        'apps/farm-service/src/feeding-protocol/services/feeding-operation-coordinator.service.ts',
      ),
      'utf8',
    );
    const codec = readFileSync(
      path.join(
        REPO_ROOT,
        'apps/farm-service/src/feeding-protocol/feeding-operation-command.codec.ts',
      ),
      'utf8',
    );

    expect(coordinator).toMatch(
      /const candidate = compileFeedingOperationCommandArtifactV1\(command\)/,
    );
    expect(coordinator).toMatch(/const admittedCommand = candidate\.command/);
    expect(coordinator).not.toMatch(/command\.envelope\.clientCommandId/);
    expect(codec).toMatch(/identity\.requestId\s*!==\s*envelope\.clientCommandId/);
    expect(codec).toMatch(/mobile meal requestId differs from its envelope identity/);
  });
});
