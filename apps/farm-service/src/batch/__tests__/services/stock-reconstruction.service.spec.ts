/**
 * StockReconstructionService.fold — the fail-closed folding of per-(tank, batch)
 * ledger rows into a site period-end total (FARM-HIGH-182). The SQL replay itself
 * is exercised against real Postgres by the CI integration spec; here we pin the
 * pure arithmetic + the fail-closed guards deterministically.
 */
import { StockReconstructionService } from '../../services/stock-reconstruction.service';

type Row = Parameters<typeof StockReconstructionService.fold>[0][number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    tankId: 't1',
    batchId: 'b1',
    speciesId: 'sp-1',
    speciesName: 'European seabass',
    speciesCode: 'SEABASS',
    inflowSigned: '10000',
    inflowRows: '1',
    mortality: '0',
    cull: '0',
    harvest: '0',
    unattributableRemovals: '0',
    avgWeightG: '250',
    ...overrides,
  };
}

describe('StockReconstructionService.fold', () => {
  it('reconstructs qty = inflow − mortality − cull − harvest and biomass = qty × weight', () => {
    const result = StockReconstructionService.fold([
      row({
        inflowSigned: '10000',
        mortality: '1200',
        cull: '300',
        harvest: '2500',
        avgWeightG: '400',
      }),
    ]);

    expect(result.complete).toBe(true);
    expect(result.totalQuantity).toBe(6000); // 10000 − 1200 − 300 − 2500
    expect(result.totalBiomassKg).toBe(2400); // 6000 × 400 / 1000
    expect(result.batchCount).toBe(1);
    expect(result.speciesBreakdown[0]).toMatchObject({
      speciesId: 'sp-1',
      quantity: 6000,
      biomassKg: 2400,
      avgWeightG: 400,
    });
  });

  it('sums the same batch across two tanks into one species total', () => {
    const result = StockReconstructionService.fold([
      row({ tankId: 't1', batchId: 'b1', inflowSigned: '5000', avgWeightG: '200' }),
      row({ tankId: 't2', batchId: 'b1', inflowSigned: '3000', avgWeightG: '200' }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.totalQuantity).toBe(8000);
    // One distinct batch across two tanks.
    expect(result.batchCount).toBe(1);
    expect(result.totalBiomassKg).toBe(1600); // 8000 × 200 / 1000
  });

  it('separates species into distinct breakdown entries', () => {
    const result = StockReconstructionService.fold([
      row({ tankId: 't1', batchId: 'b1', speciesId: 'sp-1', speciesCode: 'SAL' }),
      row({
        tankId: 't2',
        batchId: 'b2',
        speciesId: 'sp-2',
        speciesCode: 'TRO',
        speciesName: 'Rainbow trout',
      }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.speciesBreakdown).toHaveLength(2);
    expect(result.batchCount).toBe(2);
  });

  it('SKIPS a tank/batch that nets to 0 (emptied or transferred out, not a gap)', () => {
    const result = StockReconstructionService.fold([
      // Fully transferred out: +4000 initial then −4000 transfer_out nets to 0.
      row({ tankId: 't1', batchId: 'b1', inflowSigned: '0', inflowRows: '1' }),
      row({ tankId: 't2', batchId: 'b2', inflowSigned: '2000', avgWeightG: '100' }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.batchCount).toBe(1);
    expect(result.totalQuantity).toBe(2000);
  });

  it('FAILS CLOSED when a tank/batch has no positive-inflow allocation row', () => {
    const result = StockReconstructionService.fold([row({ inflowRows: '0' })]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/no stocking\/transfer-in allocation/);
  });

  it('FAILS CLOSED on a negative reconstruction (removals exceed inflow → ledger gap)', () => {
    const result = StockReconstructionService.fold([
      row({ inflowSigned: '1000', mortality: '900', harvest: '500' }), // → −400
    ]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/negative quantity/);
  });

  it('FAILS CLOSED when a batch has an un-attributable (NULL-tank) removal', () => {
    const result = StockReconstructionService.fold([row({ unattributableRemovals: '1' })]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/no tank/);
  });

  it('FAILS CLOSED when an in-stock tank/batch has no weight at the period end', () => {
    const result = StockReconstructionService.fold([
      row({ inflowSigned: '5000', avgWeightG: null }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/no recorded weight/);
  });

  it('does NOT fail closed for a zero-weight pair that is already out of stock', () => {
    // qty 0 → skipped before the weight guard, so a fully-emptied weightless
    // tank/batch does not block an otherwise-complete reconstruction.
    const result = StockReconstructionService.fold([
      row({
        tankId: 'gone',
        batchId: 'b1',
        inflowSigned: '1000',
        harvest: '1000',
        avgWeightG: null,
      }),
      row({ tankId: 'live', batchId: 'b2', inflowSigned: '2000', avgWeightG: '150' }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.totalQuantity).toBe(2000);
  });

  it('reconstructs an empty site to a complete zero (no pairs)', () => {
    const result = StockReconstructionService.fold([]);
    expect(result.complete).toBe(true);
    expect(result.totalQuantity).toBe(0);
    expect(result.batchCount).toBe(0);
    expect(result.speciesBreakdown).toEqual([]);
  });
});
