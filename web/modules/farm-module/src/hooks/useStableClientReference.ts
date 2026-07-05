/**
 * useStableClientReference — the SSoT for a Mattilsynet klientReferanse that
 * stays STABLE across retries of the same logical report submission.
 *
 * WHY (FARM-HIGH-126): klientReferanse is Mattilsynet's OWN idempotency key and
 * the key of the backend's @Unique(tenantId, reportType, klientReferanse) upsert.
 * If the frontend mints a fresh crypto.randomUUID() on every submit click, a
 * retry / double-click / network-timeout never collides — the backend inserts a
 * NEW regulatory_reports row AND submits a DUPLICATE report (and, for varsling
 * types, a duplicate legally-immediate urgent email) to the regulator. The whole
 * persist-first upsert design is inert without a stable key.
 *
 * Contract (mirrors useStockCommandEnvelope in useBatches.ts): the reference is
 * held in a ref and minted lazily on first read; it stays constant for every
 * subsequent read (retry) until reset() is called after a SUCCESSFUL submission,
 * at which point the next genuine submission mints a fresh one.
 */
import { useCallback, useRef } from 'react';

export interface StableClientReference {
  /** The stable reference for the current submission attempt (minted on first read). */
  get: () => string;
  /** Release the reference after a successful submit so the next report mints a fresh one. */
  reset: () => void;
}

export function useStableClientReference(): StableClientReference {
  const ref = useRef<string | null>(null);
  const get = useCallback((): string => {
    ref.current ??= crypto.randomUUID();
    return ref.current;
  }, []);
  const reset = useCallback((): void => {
    ref.current = null;
  }, []);
  return { get, reset };
}
