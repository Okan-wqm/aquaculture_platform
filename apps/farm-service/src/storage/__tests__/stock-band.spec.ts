/**
 * The pure band rules of the two-tier stock model (plan K8).
 */
import {
  bandWorsened,
  poolStockBand,
  siteStockBand,
  stockUrgency,
  worsenedSeverity,
} from '../services/low-stock/stock-band';

describe('siteStockBand (tier 1: site on-hand vs site policy)', () => {
  it.each([
    // SCENARIO: above / at / below the site minimum, and empty.
    // EXPECTS: ok above, low at-or-below, out at zero.
    [120, 100, 'ok'],
    [100, 100, 'low_stock'],
    [99.5, 100, 'low_stock'],
    [0, 100, 'out_of_stock'],
  ] as const)('on-hand %p vs min %p → %p', (onHand, min, band) => {
    expect(siteStockBand(onHand, min)).toBe(band);
  });
});

describe('poolStockBand (tier 2: inventory position vs reorder threshold)', () => {
  it('is low when on-hand + open orders are at or below the threshold', () => {
    // SCENARIO: 300 on hand, 100 ordered, reorder at 500. EXPECTS: low.
    expect(poolStockBand(300, 100, 500)).toBe('low_stock');
    // SCENARIO: position exactly at the threshold. EXPECTS: low.
    expect(poolStockBand(400, 100, 500)).toBe('low_stock');
  });

  it('is ok when an open order already covers the shortfall (FARM-3)', () => {
    // SCENARIO: 300 on hand, 250 ordered, reorder at 500. EXPECTS: ok — no second purchase.
    expect(poolStockBand(300, 250, 500)).toBe('ok');
  });

  it('is out of stock on zero on-hand even with an order open (fish cannot eat an order)', () => {
    // SCENARIO: empty shelves, big order open. EXPECTS: out_of_stock.
    expect(poolStockBand(0, 1000, 500)).toBe('out_of_stock');
  });

  it('never reports low for an item that is not reorder-controlled (threshold 0)', () => {
    // SCENARIO: threshold 0, some stock. EXPECTS: ok; empty is still out.
    expect(poolStockBand(1, 0, 0)).toBe('ok');
    expect(poolStockBand(0, 0, 0)).toBe('out_of_stock');
  });
});

describe('edge trigger', () => {
  it('fires only when the band gets worse', () => {
    // SCENARIO: every transition. EXPECTS: only ok→low, ok→out, low→out.
    expect(bandWorsened('ok', 'low_stock')).toBe(true);
    expect(bandWorsened('ok', 'out_of_stock')).toBe(true);
    expect(bandWorsened('low_stock', 'out_of_stock')).toBe(true);
    expect(bandWorsened('low_stock', 'low_stock')).toBe(false);
    expect(bandWorsened('out_of_stock', 'low_stock')).toBe(false);
    expect(bandWorsened('ok', 'ok')).toBe(false);
  });

  it('narrows the severity to a non-ok band or null', () => {
    // SCENARIO: worsened vs not. EXPECTS: severity or null.
    expect(worsenedSeverity('ok', 'low_stock')).toBe('low_stock');
    expect(worsenedSeverity('low_stock', 'out_of_stock')).toBe('out_of_stock');
    expect(worsenedSeverity('low_stock', 'low_stock')).toBeNull();
    expect(worsenedSeverity('low_stock', 'ok')).toBeNull();
  });
});

describe('stockUrgency', () => {
  it('orders empty first, then by covered fraction', () => {
    // SCENARIO: empty, 10% and 90% covered. EXPECTS: 0 < 0.1 < 0.9.
    expect(stockUrgency(0, 100)).toBe(0);
    expect(stockUrgency(10, 100)).toBeCloseTo(0.1);
    expect(stockUrgency(90, 100)).toBeCloseTo(0.9);
  });
});
