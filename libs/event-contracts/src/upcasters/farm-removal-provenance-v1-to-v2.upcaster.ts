import type { EventUpcaster } from './event-upcaster';

/**
 * v2 records whether a fish count was supplied or derived from biomass.
 * Historical v1 payloads do not contain enough information to reconstruct
 * that fact, so the upcast is deliberately identity-only: absence remains the
 * typed `unknown` state expressed by the optional contract field.
 */
function provenanceIdentityUpcaster(eventType: string): EventUpcaster {
  return {
    eventType,
    fromVersion: 1,
    toVersion: 2,
    upcast(event: Record<string, unknown>): Record<string, unknown> {
      return { ...event, version: 2 };
    },
  };
}

export const farmRemovalProvenanceUpcasters = [
  provenanceIdentityUpcaster('MortalityRecorded'),
  provenanceIdentityUpcaster('CullRecorded'),
  provenanceIdentityUpcaster('BatchTransferred'),
] as const;
