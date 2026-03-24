import { useState, useEffect, useRef } from 'react';
import type { TagValueBus } from './TagValueBus';

/**
 * React hook that subscribes to multiple tags on the TagValueBus.
 * Returns a record of tag names to their latest values, re-rendering on each update.
 *
 * NOTE: The tagBus parameter is passed directly for now.
 * Task 5 (ScadaRuntimeContext) will provide a context-based alternative.
 */
export function useTagValues(tagNames: string[], tagBus: TagValueBus): Record<string, unknown> {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const snap: Record<string, unknown> = {};
    for (const t of tagNames) snap[t] = tagBus.getLatest(t);
    return snap;
  });

  const joinedRef = useRef(tagNames.join(','));

  useEffect(() => {
    const joined = tagNames.join(',');
    if (joined !== joinedRef.current) joinedRef.current = joined;

    const unsubs = tagNames.map((tag) =>
      tagBus.subscribe(tag, (val, name) => {
        setValues((prev) => ({ ...prev, [name]: val }));
      }),
    );
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagBus, tagNames.join(',')]);

  return values;
}
