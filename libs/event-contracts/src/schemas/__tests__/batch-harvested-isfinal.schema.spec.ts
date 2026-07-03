import { createBaseEvent } from '../../base-event';
import type { BatchHarvestedEvent } from '../../farm-events';
import { validateFarmEvent } from '../validator';

/**
 * Trust-boundary validation for the additive BatchHarvested.isFinal
 * field (arbiter B2). The wire schema marks isFinal optional+nullable —
 * NOT required — so ONE schema validates both v1 (no isFinal) and v2
 * (isFinal present) payloads. additionalProperties:false means the
 * field MUST be in the schema or a v2 event is dropped at the bridge;
 * these tests pin both directions.
 */
function baseHarvest(extra: Record<string, unknown>): Record<string, unknown> {
  const event: BatchHarvestedEvent = {
    ...createBaseEvent<BatchHarvestedEvent>('BatchHarvested', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      aggregateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      aggregateType: 'Batch',
    }),
    batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    harvestedQuantity: 1000,
    harvestedAt: '2026-06-12T00:00:00.000Z',
  };
  // The wire payload serialises harvestedAt as an ISO string, so we
  // spread the typed domain event (Date) and override that one field.
  // Assigning a typed object into a Record<string, unknown> is structural
  // widening, so it needs no double-cast escape hatch.
  return {
    ...event,
    harvestedAt: '2026-06-12T00:00:00.000Z',
    ...extra,
  };
}

describe('BatchHarvested isFinal schema (B2 additive)', () => {
  it('accepts a v2 event carrying isFinal: true', () => {
    const result = validateFarmEvent('BatchHarvested', baseHarvest({ version: 2, isFinal: true }));
    expect(result.valid).toBe(true);
  });

  it('accepts a v2 event carrying isFinal: false', () => {
    const result = validateFarmEvent('BatchHarvested', baseHarvest({ version: 2, isFinal: false }));
    expect(result.valid).toBe(true);
  });

  it('accepts a v1 event with NO isFinal (optional — one schema for both versions)', () => {
    const result = validateFarmEvent('BatchHarvested', baseHarvest({ version: 1 }));
    expect(result.valid).toBe(true);
  });

  it('rejects an unknown extra field (additionalProperties:false still enforced)', () => {
    const result = validateFarmEvent('BatchHarvested', baseHarvest({ version: 2, bogusField: 'x' }));
    expect(result.valid).toBe(false);
  });

  it('rejects a non-boolean isFinal', () => {
    const result = validateFarmEvent('BatchHarvested', baseHarvest({ version: 2, isFinal: 'yes' }));
    expect(result.valid).toBe(false);
  });
});
