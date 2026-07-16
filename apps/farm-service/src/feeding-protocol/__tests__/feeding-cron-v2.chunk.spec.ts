/**
 * MealWindowUpcoming toplu şekli (K-2): 500 girdi/event cap + devam
 * event'leri. Cap sabiti wire-schema validator'ıyla AYNI değerdir — şekil
 * sonradan değiştirilemez (breaking).
 */
import {
  chunkWindowEntries,
  MEAL_WINDOW_MAX_ENTRIES,
} from '../services/feeding-cron-v2.service';

describe('chunkWindowEntries (K-2 batched window shape)', () => {
  it('caps each event at 500 entries with continuation batches', () => {
    const entries = Array.from({ length: 1201 }, (_, i) => i);
    const chunks = chunkWindowEntries(entries, MEAL_WINDOW_MAX_ENTRIES);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toHaveLength(500);
    expect(chunks[2]).toHaveLength(201);
    // Sıra korunur — batchIndex tüketici için deterministiktir.
    expect(chunks[2]![0]).toBe(1000);
  });

  it('returns no batches for an empty window (no empty events on the wire)', () => {
    expect(chunkWindowEntries([], MEAL_WINDOW_MAX_ENTRIES)).toEqual([]);
  });

  it('keeps the 1000-unit common-first-meal case within a small batch count', () => {
    const chunks = chunkWindowEntries(Array.from({ length: 1000 }, (_, i) => i), MEAL_WINDOW_MAX_ENTRIES);
    expect(chunks).toHaveLength(2);
  });
});
