/**
 * useTagWrite — Write tag values via IDataProvider.
 *
 * Implements an optimistic update pattern:
 *  1. The local override is applied immediately (via ref; no provider round-trip).
 *  2. writeTagValue is sent to the provider.
 *  3. On error, the pre-write value is restored and lastError is set.
 *
 * Multiple concurrent writes are tracked so isWriting stays true until every
 * in-flight write has resolved.
 */

import { useState, useRef, useCallback } from 'react';
import { useDataProvider } from '../providers';

export interface TagWriteResult {
  writeTag: (tagId: string, value: unknown) => Promise<void>;
  toggleTag: (tagId: string) => Promise<void>;
  incrementTag: (tagId: string, delta: number) => Promise<void>;
  isWriting: boolean;
  lastError: string | null;
}

export function useTagWrite(): TagWriteResult {
  const provider = useDataProvider();

  // Track number of in-flight writes so isWriting is correct even when
  // multiple tags are written concurrently.
  const inflightRef = useRef(0);
  const [isWriting, setIsWriting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Optimistic value overrides applied before the server round-trip completes.
  // Stored in a ref to avoid triggering re-renders; the DataProvider's own
  // subscription mechanism will update consumers once the write is confirmed.
  const optimisticRef = useRef<Record<string, unknown>>({});

  const beginWrite = useCallback(() => {
    inflightRef.current += 1;
    if (inflightRef.current === 1) setIsWriting(true);
  }, []);

  const endWrite = useCallback((error?: string) => {
    inflightRef.current = Math.max(0, inflightRef.current - 1);
    if (inflightRef.current === 0) setIsWriting(false);
    if (error !== undefined) setLastError(error);
  }, []);

  // -------------------------------------------------------------------------
  // writeTag
  // -------------------------------------------------------------------------
  const writeTag = useCallback(
    async (tagId: string, value: unknown): Promise<void> => {
      // Capture pre-write value for rollback.
      const prev = provider.getTagValue(tagId);
      const prevValue = prev?.value;

      // Optimistic update.
      optimisticRef.current = { ...optimisticRef.current, [tagId]: value };
      setLastError(null);
      beginWrite();

      try {
        await provider.writeTagValue(tagId, value);
        // Clean up the optimistic entry — real value is now authoritative.
        const next = { ...optimisticRef.current };
        delete next[tagId];
        optimisticRef.current = next;
        endWrite();
      } catch (err) {
        // Rollback: restore the previous optimistic override so any downstream
        // consumers that read from this ref see the old value until the
        // DataProvider's subscription delivers the actual server state.
        optimisticRef.current = { ...optimisticRef.current, [tagId]: prevValue };
        const message = err instanceof Error ? err.message : String(err);
        endWrite(message);
        throw err;
      }
    },
    [provider, beginWrite, endWrite],
  );

  // -------------------------------------------------------------------------
  // toggleTag  (boolean / 0-1 toggle)
  // -------------------------------------------------------------------------
  const toggleTag = useCallback(
    async (tagId: string): Promise<void> => {
      const current = provider.getTagValue(tagId);
      const currentValue = current?.value;

      let toggled: unknown;
      if (typeof currentValue === 'boolean') {
        toggled = !currentValue;
      } else if (typeof currentValue === 'number') {
        toggled = currentValue === 0 ? 1 : 0;
      } else {
        // For string or unknown types treat '0'/'false' as falsy.
        const isFalsy =
          currentValue === '0' ||
          currentValue === 'false' ||
          currentValue === null ||
          currentValue === undefined;
        toggled = isFalsy ? 1 : 0;
      }

      return writeTag(tagId, toggled);
    },
    [provider, writeTag],
  );

  // -------------------------------------------------------------------------
  // incrementTag
  // -------------------------------------------------------------------------
  const incrementTag = useCallback(
    async (tagId: string, delta: number): Promise<void> => {
      const current = provider.getTagValue(tagId);
      const rawValue = current?.value;
      const numericValue =
        typeof rawValue === 'number'
          ? rawValue
          : typeof rawValue === 'string'
            ? parseFloat(rawValue)
            : 0;

      const next = isNaN(numericValue) ? delta : numericValue + delta;
      return writeTag(tagId, next);
    },
    [provider, writeTag],
  );

  return {
    writeTag,
    toggleTag,
    incrementTag,
    isWriting,
    lastError,
  };
}
