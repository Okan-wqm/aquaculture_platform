/**
 * The value a channel's `dataPath` names in a parsed MQTT payload: dot
 * segments, each optionally indexing an array (`sensors.mid`, `values[0]`).
 * Undefined when any segment is missing or crosses a non-object. Total over
 * any payload shape: it never throws on what a device sends.
 */
export function valueAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const indexStr = arrayMatch[2];
      if (key && indexStr) {
        const objCurrent = current as Record<string, unknown>;
        const arr = objCurrent[key];
        if (Array.isArray(arr)) {
          current = arr[parseInt(indexStr, 10)];
        } else {
          return undefined;
        }
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }

    if (current === undefined) {
      return undefined;
    }
  }

  return current;
}
