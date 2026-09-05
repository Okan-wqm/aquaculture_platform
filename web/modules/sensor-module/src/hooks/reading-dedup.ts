/**
 * Reconnect-window dedup for live sensor readings (plan Task 1.5).
 *
 * The gateway re-broadcasts the live backlog into a room on every socket
 * (re)subscribe, and the MQTT/JetStream legs are at-least-once — so the
 * same logical reading can reach this client twice. Since Task 1.4 the
 * reading carries a DETERMINISTIC eventId: identity, not
 * (sensorId, timestamp) guessing, decides duplication.
 *
 * Bounded: at most MAX_TRACKED ids; anything older than WINDOW_MS is
 * evicted on insert (Map iterates in insertion order, so the oldest-first
 * sweep is a single pass).
 */
export interface DeduplicableReading {
  eventId?: string;
}

const WINDOW_MS = 5 * 60_000;
const MAX_TRACKED = 1_000;

const seenAt = new Map<string, number>();

export function isDuplicateReading(
  reading: DeduplicableReading,
  now: number = Date.now(),
): boolean {
  const id = reading.eventId;
  if (!id) {
    // Pre-1.4 payloads have no identity — never suppress unknown data.
    return false;
  }
  const previous = seenAt.get(id);
  seenAt.set(id, now);

  if (seenAt.size > MAX_TRACKED) {
    for (const [key, at] of seenAt) {
      if (now - at > WINDOW_MS) {
        seenAt.delete(key);
      } else {
        break;
      }
    }
    // Still over budget: drop the oldest entries regardless of age.
    while (seenAt.size > MAX_TRACKED) {
      const oldest = seenAt.keys().next();
      if (oldest.done) break;
      seenAt.delete(oldest.value);
    }
  }

  return previous !== undefined && now - previous <= WINDOW_MS;
}

/** Test/reset hook — clears the window. */
export function resetReadingDedup(): void {
  seenAt.clear();
}
