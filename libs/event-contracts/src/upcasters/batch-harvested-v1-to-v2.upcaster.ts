import { EventUpcaster } from './event-upcaster';

/**
 * BatchHarvested v1 → v2 upcaster (cluster-1 / arbiter B2).
 *
 * v1 format: no `isFinal`.
 * v2 format: same fields PLUS optional `isFinal` (true when the harvest
 *            emptied the batch — the FINAL harvest signal).
 *
 * This is an IDENTITY upcaster — `isFinal` is OPTIONAL, so a v1 event
 * deserialised with the v2 TypeScript interface is already a valid v2
 * event with `isFinal` absent. The upcaster's only job is bumping the
 * `version` discriminator from 1 to 2 so the chained
 * `EventUpcasterRegistry.upcast` loop knows the chain is done.
 *
 * # Why NOT backfill `isFinal: false` here
 *
 * Backfilling would FABRICATE data: a v1 event never carried finality,
 * and `isFinal` cannot be derived retroactively from the v1 payload (it
 * comes from the live `batch.currentQuantity` at mint time, which the
 * event does not include). Injecting `false` would assert "this was a
 * partial harvest" as fact when it is genuinely unknown. The contract
 * therefore keeps `isFinal` OPTIONAL and the Tolerant-Reader rule
 * (missing → treat as `false`) lives on the CONSUMER, not in the wire
 * data — preserving the honest "this old event had no finality
 * information" truth. (Same identity-bump shape as
 * sensor-reading-v2-to-v3.upcaster.ts.)
 */
export const batchHarvestedUpcaster: EventUpcaster = {
  eventType: 'BatchHarvested',
  fromVersion: 1,
  toVersion: 2,
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    return { ...event, version: 2 };
  },
};
