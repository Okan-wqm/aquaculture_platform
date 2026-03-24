import { useState, useEffect } from 'react';
import type { TagValueBus } from './TagValueBus';

/**
 * React hook that subscribes to a single tag on the TagValueBus.
 * Returns the latest value for the given tag name, re-rendering on each update.
 *
 * NOTE: The tagBus parameter is passed directly for now.
 * Task 5 (ScadaRuntimeContext) will provide a context-based alternative.
 */
export function useTagValue(tagName: string | undefined, tagBus: TagValueBus): unknown {
  const [value, setValue] = useState<unknown>(() =>
    tagName ? tagBus.getLatest(tagName) : undefined,
  );

  useEffect(() => {
    if (!tagName) return;
    setValue(tagBus.getLatest(tagName));
    return tagBus.subscribe(tagName, (val) => setValue(val));
  }, [tagBus, tagName]);

  return value;
}
