/**
 * Event Upcaster Infrastructure
 *
 * Transforms legacy (v1) events into the current (v2+) format at deserialization time.
 * This ensures consumers only need to handle the latest event schema while older
 * events stored in JetStream are transparently upgraded.
 *
 * WHY: Event contracts evolve (e.g., nested objects → flat fields). Without upcasting,
 * every consumer must handle every historical schema version forever.
 */

/**
 * An upcaster transforms a single version of an event into the next version.
 * Multiple upcasters can be chained for multi-step version upgrades.
 */
export interface EventUpcaster {
  /** PascalCase event type this upcaster applies to */
  eventType: string;
  /** Source version this upcaster reads */
  fromVersion: number;
  /** Target version this upcaster produces */
  toVersion: number;
  /** Transform the event payload from fromVersion → toVersion */
  upcast(event: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Registry that chains upcasters by eventType and version.
 * Given an event at version N, it will apply all registered upcasters
 * in sequence until the event reaches the latest known version.
 */
export class EventUpcasterRegistry {
  private readonly upcasters = new Map<string, EventUpcaster[]>();

  /**
   * Register an upcaster. Upcasters for the same eventType are sorted by fromVersion.
   */
  register(upcaster: EventUpcaster): void {
    const key = upcaster.eventType;
    const chain = this.upcasters.get(key) ?? [];
    chain.push(upcaster);
    chain.sort((a, b) => a.fromVersion - b.fromVersion);
    this.upcasters.set(key, chain);
  }

  /**
   * Apply all applicable upcasters to an event.
   * If no upcasters match (unknown eventType or already at latest version), returns as-is.
   */
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    const eventType = event['eventType'] as string | undefined;
    if (!eventType) return event;

    const chain = this.upcasters.get(eventType);
    if (!chain || chain.length === 0) return event;

    let result = event;

    for (const upcaster of chain) {
      const currentVersion = (result['version'] as number) ?? 1;
      if (currentVersion === upcaster.fromVersion) {
        result = upcaster.upcast(result);
      }
    }

    return result;
  }
}
