/**
 * submitBlocker specs — the gate between a gloved thumb and a bad farm record.
 *
 * The log sheet writes irreversible entries into an offline queue that replays
 * without asking again, potentially hours later with nobody watching. So the
 * gate is not a form-validation nicety: anything it lets through is a record.
 * These specs pin every branch, and especially the stock ceiling — a mistyped
 * mortality larger than the pen's population is a data-integrity event.
 */
import { describe, expect, it } from 'vitest';

import { submitBlocker, type SubmitGateInput } from '../LogSheet';

import type { Tank } from '@/types';

function tank(overrides: Partial<Tank['batchMetrics']> & { id?: string } = {}): Tank {
  const { id = 'unit-a', ...metrics } = overrides;
  return {
    id,
    name: 'North 7',
    code: 'U-07',
    volume: 1200,
    status: 'ACTIVE',
    currentBiomass: 0,
    maxBiomass: 0,
    siteId: 'site-a',
    batchMetrics: {
      batchId: 'batch-1',
      batchNumber: 'B-2411',
      speciesId: null,
      speciesName: null,
      pieces: 92_400,
      avgWeight: 3400,
      biomass: 314_160,
      density: 22.1,
      capacityUsedPercent: 71,
      isOverCapacity: false,
      daysSinceStocking: 120,
      ...metrics,
    },
  };
}

function gate(over: Partial<SubmitGateInput> = {}): string | null {
  return submitBlocker({
    type: 'mortality',
    tank: tank(),
    qty: '10',
    destTankId: '',
    reason: 'DISEASE',
    wqEnteredCount: 0,
    integer: true,
    ...over,
  });
}

describe('submitBlocker', () => {
  it('passes a complete mortality entry', () => {
    expect(gate()).toBeNull();
  });

  it('requires a unit', () => {
    expect(gate({ tank: undefined })).toBe('Choose a unit');
  });

  it('refuses a unit with no stocked batch', () => {
    // Every payload this sheet builds carries batchId; an unstocked pen cannot
    // produce one, so the entry would fail on replay rather than at entry time.
    expect(gate({ tank: tank({ batchId: null }) })).toBe('This unit has no stocked batch');
  });

  it('requires a positive quantity', () => {
    expect(gate({ qty: '' })).toBe('Enter a quantity');
    expect(gate({ qty: '0' })).toBe('Enter a quantity');
    expect(gate({ qty: '-5' })).toBe('Enter a quantity');
    expect(gate({ qty: 'abc' })).toBe('Enter a quantity');
  });

  it('refuses fractional fish', () => {
    expect(gate({ qty: '2.5' })).toBe('Whole fish only');
  });

  it('refuses a count larger than the pen holds', () => {
    // The fat-finger case: an extra zero on a mortality count.
    expect(gate({ qty: '924000' })).toBe('Only 92,400 fish in this unit');
    expect(gate({ qty: '92400' })).toBeNull();
  });

  it('does not apply a stock ceiling when the population is unknown', () => {
    // pieces = 0 means "not reported", not "empty pen" — blocking every entry
    // would strand a worker whose inventory snapshot is incomplete.
    expect(gate({ tank: tank({ pieces: 0 }), qty: '50' })).toBeNull();
  });

  it('requires a cause for mortality and cull', () => {
    expect(gate({ reason: '' })).toBe('Choose a reason');
    expect(gate({ type: 'cull', reason: '' })).toBe('Choose a reason');
  });

  it('does not require a cause for a transfer', () => {
    expect(gate({ type: 'transfer', reason: '', destTankId: 'unit-b' })).toBeNull();
  });

  it('requires a destination for a transfer, and refuses the source', () => {
    expect(gate({ type: 'transfer', reason: '', destTankId: '' })).toBe(
      'Choose a destination unit',
    );
    expect(gate({ type: 'transfer', reason: '', destTankId: 'unit-a' })).toBe(
      'Destination must differ from source',
    );
  });

  it('gates water on readings rather than on a quantity', () => {
    // The water branch ignores qty entirely — its payload is a parameter map.
    expect(gate({ type: 'water', qty: '', wqEnteredCount: 0 })).toBe('Enter at least one reading');
    expect(gate({ type: 'water', qty: '', wqEnteredCount: 1 })).toBeNull();
  });

  it('still requires a stocked unit for a water reading', () => {
    expect(gate({ type: 'water', tank: tank({ batchId: null }), wqEnteredCount: 3 })).toBe(
      'This unit has no stocked batch',
    );
  });

  it('allows a decimal when the type is not counted in fish', () => {
    expect(
      gate({ type: 'transfer', integer: false, qty: '2.5', reason: '', destTankId: 'unit-b' }),
    ).toBeNull();
  });
});
