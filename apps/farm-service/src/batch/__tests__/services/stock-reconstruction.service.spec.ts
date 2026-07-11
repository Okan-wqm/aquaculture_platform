/**
 * StockReconstructionService.fold — the fail-closed folding of per-batch ledger
 * rows into a site period-end total (FARM-HIGH-182). The SQL replay itself is
 * exercised against real Postgres by the CI integration spec; here we pin the
 * pure arithmetic + the fail-closed guards deterministically.
 */
import { StockReconstructionService } from '../../services/stock-reconstruction.service';

type Row = Parameters<typeof StockReconstructionService.fold>[0][number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    batchId: 'b1',
    speciesId: 'sp-1',
    speciesName: 'European seabass',
    speciesCode: 'SEABASS',
    initialQuantity: '10000',
    mortality: '0',
    cull: '0',
    harvest: '0',
    avgWeightG: '250',
    ...overrides,
  };
}

describe('StockReconstructionService.fold', () => {
  it('reconstructs qty = initial − mortality − cull − harvest and biomass = qty × weight', () => {
    const result = StockReconstructionService.fold([
      row({ initialQuantity: '10000', mortality: '1200', cull: '300', harvest: '2500', avgWeightG: '400' }),
    ]);

    expect(result.complete).toBe(true);
    // 10000 − 1200 − 300 − 2500 = 6000
    expect(result.totalQuantity).toBe(6000);
    // 6000 × 400 g / 1000 = 2400 kg
    expect(result.totalBiomassKg).toBe(2400);
    expect(result.batchCount).toBe(1);
    expect(result.speciesBreakdown[0]).toMatchObject({
      speciesId: 'sp-1',
      quantity: 6000,
      biomassKg: 2400,
      avgWeightG: 400,
    });
  });

  it('aggregates multiple batches of the same species', () => {
    const result = StockReconstructionService.fold([
      row({ batchId: 'b1', initialQuantity: '5000', mortality: '0', avgWeightG: '200' }),
      row({ batchId: 'b2', initialQuantity: '3000', mortality: '500', avgWeightG: '300' }),
    ]);
    expect(result.complete).toBe(true);
    // 5000 + 2500 = 7500
    expect(result.totalQuantity).toBe(7500);
    expect(result.speciesBreakdown).toHaveLength(1);
    // (5000×200 + 2500×300)/1000 = 1000 + 750 = 1750
    expect(result.totalBiomassKg).toBe(1750);
  });

  it('separates species into distinct breakdown entries', () => {
    const result = StockReconstructionService.fold([
      row({ batchId: 'b1', speciesId: 'sp-1', speciesCode: 'SAL' }),
      row({ batchId: 'b2', speciesId: 'sp-2', speciesCode: 'TRO', speciesName: 'Rainbow trout' }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.speciesBreakdown).toHaveLength(2);
  });

  it('SKIPS a batch that reconstructs to exactly 0 (emptied by the period end, not a gap)', () => {
    const result = StockReconstructionService.fold([
      row({ batchId: 'b1', initialQuantity: '4000', harvest: '4000' }), // → 0, skipped
      row({ batchId: 'b2', initialQuantity: '2000', avgWeightG: '100' }), // → 2000
    ]);
    expect(result.complete).toBe(true);
    expect(result.batchCount).toBe(1);
    expect(result.totalQuantity).toBe(2000);
  });

  it('FAILS CLOSED when a batch has no recorded initial quantity', () => {
    const result = StockReconstructionService.fold([row({ initialQuantity: null })]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/no recorded initial quantity/);
    expect(result.totalQuantity).toBe(0);
  });

  it('FAILS CLOSED on a negative reconstruction (removals exceed initial → ledger gap)', () => {
    const result = StockReconstructionService.fold([
      row({ initialQuantity: '1000', mortality: '900', harvest: '500' }), // → −400
    ]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/negative quantity/);
  });

  it('FAILS CLOSED when an in-stock batch has no weight at the period end', () => {
    const result = StockReconstructionService.fold([
      row({ initialQuantity: '5000', avgWeightG: null }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/no recorded weight/);
  });

  it('does NOT fail closed for a zero-weight batch that is already out of stock', () => {
    // qty 0 → skipped before the weight guard, so a fully-harvested weightless
    // batch does not block an otherwise-complete reconstruction.
    const result = StockReconstructionService.fold([
      row({ batchId: 'gone', initialQuantity: '1000', harvest: '1000', avgWeightG: null }),
      row({ batchId: 'live', initialQuantity: '2000', avgWeightG: '150' }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.totalQuantity).toBe(2000);
  });

  it('reconstructs an empty site to a complete zero (no batches)', () => {
    const result = StockReconstructionService.fold([]);
    expect(result.complete).toBe(true);
    expect(result.totalQuantity).toBe(0);
    expect(result.batchCount).toBe(0);
    expect(result.speciesBreakdown).toEqual([]);
  });
});
