/**
 * Test double for the stock-change scope (`TankBatchService.applyStockChange`).
 *
 * WHY it lives in one place: every handler that moves fish now writes through
 * the scope, and every one of their specs needs to (a) run the callback so the
 * handler's deltas actually land and (b) SEE that the scope was entered with the
 * right reason. Re-hand-rolling that in six specs is how the assertions drift.
 *
 * The double records what the production scope guarantees, so a spec can assert
 * it: the reason, every delta, and — because the real scope settles per unit —
 * the set of units the handler touched.
 */
import { TankBatchService } from '../../services/tank-batch.service';
import type { TankBatchDelta, TankMeta } from '../../services/tank-batch.service';
import type { StockChangeReason } from '../../services/unit-ration-recalculator.port';

export interface RecordedDelta {
  reason: StockChangeReason;
  tankId: string;
  delta: TankBatchDelta;
  tankMeta?: TankMeta;
}

export interface StockChangeDouble {
  /** Pass this where the handler expects a TankBatchService. */
  tankBatchService: TankBatchService;
  applyStockChange: jest.Mock;
  deltas: RecordedDelta[];
  /** Distinct units touched — what the real scope would recalculate, once each. */
  touchedUnits(): string[];
}

/**
 * @param savedRow what `applyDelta` resolves to (handlers read the saved TankBatch).
 */
export function createStockChangeDouble(savedRow: Record<string, unknown> = {}): StockChangeDouble {
  const deltas: RecordedDelta[] = [];
  const applyStockChange = jest.fn(
    async (
      _manager: unknown,
      _tenantId: string,
      reason: StockChangeReason,
      work: (stock: {
        applyDelta: (
          tankId: string,
          delta: TankBatchDelta,
          tankMeta?: TankMeta,
        ) => Promise<Record<string, unknown>>;
      }) => Promise<unknown>,
    ) =>
      work({
        applyDelta: async (tankId, delta, tankMeta) => {
          deltas.push({ reason, tankId, delta, tankMeta });
          return { totalQuantity: 0, totalBiomassKg: 0, cleanerFishBiomassKg: 0, ...savedRow };
        },
      }),
  );

  return {
    tankBatchService: { applyStockChange } as never,
    applyStockChange,
    deltas,
    touchedUnits: () => [...new Set(deltas.map((entry) => entry.tankId))],
  };
}
