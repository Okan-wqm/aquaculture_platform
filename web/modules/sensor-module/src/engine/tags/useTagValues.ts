import { useState, useEffect, useRef } from 'react';
import type { TagValueBus } from './TagValueBus';

/**
 * React hook that subscribes to multiple tags on the TagValueBus.
 * Returns a record of tag names to their latest values, re-rendering on each update.
 *
 * Performans: N adet tag guncellemesi N re-render yerine tek batch update tetikler.
 * Onceki implementasyon her tag icin ayri subscribe() cagiriyordu —
 * N tag ayni anda guncellediginde N ayri setState cagrilip N re-render olusuyordu.
 * Simdi tek wildcard ('*') subscription kullanilir ve React 18 automatic batching
 * ile ayni microtask'taki setState'ler birlesiyor.
 *
 * Performance: N simultaneous tag updates trigger a single batched re-render instead of N.
 * The previous implementation called subscribe() per tag — when N tags updated
 * simultaneously it caused N setState calls and N re-renders.
 * Now a single wildcard ('*') subscription is used and React 18 automatic batching
 * merges setState calls within the same microtask.
 *
 * NOTE: The tagBus parameter is currently passed directly.
 * Task 5 (ScadaRuntimeContext) will provide a context-based alternative.
 */
export function useTagValues(tagNames: string[], tagBus: TagValueBus): Record<string, unknown> {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    // Baslangic degerlerini senkron olarak al — ilk render'da deger kaybi olmaz
    // Fetch initial values synchronously — no value loss on first render
    const snap: Record<string, unknown> = {};
    for (const t of tagNames) {
      const val = tagBus.getLatest(t);
      if (val !== undefined) snap[t] = val;
    }
    return snap;
  });

  // Tag set'i ref'te tut — wildcard callback icinde guncel listeye erisim saglar
  // Keep tag set in a ref — gives the wildcard callback access to the current list
  const tagSetRef = useRef<Set<string>>(new Set(tagNames));

  useEffect(() => {
    tagSetRef.current = new Set(tagNames);
  }, [tagNames.join(',')]);  

  useEffect(() => {
    if (tagNames.length === 0) return;

    // Baslangic degerlerini yeniden oku — tag listesi degistiyse yeni tag'larin
    // mevcut degerlerini hemen goster
    // Re-read initial values — if the tag list changed, immediately show current
    // values for newly added tags
    const initial: Record<string, unknown> = {};
    for (const name of tagNames) {
      const val = tagBus.getLatest(name);
      if (val !== undefined) initial[name] = val;
    }
    if (Object.keys(initial).length > 0) {
      setValues(initial);
    }

    // Tek wildcard subscription — tum tag update'leri tek callback'e gelir
    // React 18 automatic batching ile ayni microtask'taki setState'ler birlesir
    // Single wildcard subscription — all tag updates arrive in one callback
    // React 18 automatic batching merges setState calls within the same microtask
    const unsub = tagBus.subscribe('*', (val: unknown, name: string) => {
      if (!tagSetRef.current.has(name)) return;

      setValues((prev) => {
        // Referans esitligi korur — deger degismemisse gereksiz render onlenir
        // Preserve referential equality — skips unnecessary re-render if value unchanged
        if (prev[name] === val) return prev;
        return { ...prev, [name]: val };
      });
    });

    return unsub;
     
  }, [tagBus, tagNames.join(',')]);

  return values;
}
