import { canonicalWireJsonSha256V1, sha256Hex } from '@aquaculture/shared-contracts';

import { freezeAuthorityGraphV1 } from './authority-immutability';
import {
  compileFeedingForecastPoolIdentityV1,
  type FeedingForecastPoolScope,
} from './feeding-forecast-projection';

export const FEEDING_FORECAST_GENERATION_REVISION = 'feeding-forecast-generation/v1';

export const FEEDING_FORECAST_GENERATION_STATES = Object.freeze([
  'BUILDING',
  'QUALIFIED',
  'ACTIVE',
  'RETIRED',
] as const);

export type FeedingForecastGenerationState = (typeof FEEDING_FORECAST_GENERATION_STATES)[number];

const FEEDING_FORECAST_GENERATION_AUTHORITY_SOURCE = {
  schemaVersion: FEEDING_FORECAST_GENERATION_REVISION,
  states: FEEDING_FORECAST_GENERATION_STATES,
  transitions: [
    ['BUILDING', 'QUALIFIED'],
    ['QUALIFIED', 'ACTIVE'],
    ['ACTIVE', 'RETIRED'],
  ],
  activePointer: {
    relation: 'feeding_forecast_active_generation',
    compareAndSwap: 'generation-id',
    cardinality: 'one-per-tenant',
  },
  generationRelation: 'feeding_forecast_generations',
  snapshotRelation: 'feeding_forecast_snapshots',
  snapshotMetadataFields: ['generationId', 'payloadDigest'],
  activeProjection: 'feeding_forecast_active_snapshots_v1',
  legacyQuarantineRelation: 'feeding_forecast_legacy_quarantine',
  mutationFunctions: {
    qualify: 'qualify_feeding_forecast_generation_v1',
    activate: 'activate_feeding_forecast_generation_v1',
    purgeRetired: 'purge_feeding_forecast_generations_v1',
  },
  retention: {
    deletableState: 'RETIRED',
    requiresActiveSuccessor: true,
  },
} as const;

export const FEEDING_FORECAST_GENERATION_AUTHORITY = freezeAuthorityGraphV1(
  FEEDING_FORECAST_GENERATION_AUTHORITY_SOURCE,
);

export const FEEDING_FORECAST_GENERATION_CATALOG_DIGEST = canonicalWireJsonSha256V1(
  {
    domain: 'aquaculture.feeding-forecast-generation-catalog',
    schemaVersion: FEEDING_FORECAST_GENERATION_REVISION,
  },
  FEEDING_FORECAST_GENERATION_AUTHORITY,
);

const SNAPSHOT_DIGEST_AUTHORITY = Object.freeze({
  domain: 'aquaculture.feeding-forecast-generation-snapshot',
  schemaVersion: FEEDING_FORECAST_GENERATION_REVISION,
});

const EXACT_SET_DIGEST_AUTHORITY = Object.freeze({
  domain: 'aquaculture.feeding-forecast-generation-exact-set',
  schemaVersion: FEEDING_FORECAST_GENERATION_REVISION,
});

export interface FeedingForecastGenerationSnapshotInputV1 {
  readonly siteScopeKey: string;
  readonly poolScope: FeedingForecastPoolScope;
  readonly payload: unknown;
}

export interface FeedingForecastGenerationSnapshotProofV1 {
  readonly siteScopeKey: string;
  readonly poolScope: FeedingForecastPoolScope;
  readonly payloadDigest: string;
}

export interface FeedingForecastGenerationExactSetProofV1 {
  readonly catalogDigest: string;
  readonly exactSetDigest: string;
  /** SQL-recomputable digest over the sorted persisted identity/digest tuples. */
  readonly membershipDigest: string;
  readonly snapshotCount: number;
  readonly snapshots: readonly FeedingForecastGenerationSnapshotProofV1[];
}

/**
 * Compiles the exact persisted scope set and payload hashes before the database
 * writer can mint a BUILDING generation. Scope identity, ordering and hashing
 * therefore have one authority shared by runtime and executable proofs.
 */
export function compileFeedingForecastGenerationExactSetProofV1(
  inputs: readonly FeedingForecastGenerationSnapshotInputV1[],
): FeedingForecastGenerationExactSetProofV1 {
  const seen = new Set<string>();
  const snapshots = inputs
    .map((input) => {
      const identity = compileFeedingForecastPoolIdentityV1(input.siteScopeKey, input.poolScope);
      if (seen.has(identity.siteScopeKey)) {
        throw new Error(`Duplicate forecast generation scope ${identity.siteScopeKey}`);
      }
      seen.add(identity.siteScopeKey);
      return Object.freeze({
        ...identity,
        payloadDigest: canonicalWireJsonSha256V1(SNAPSHOT_DIGEST_AUTHORITY, input.payload),
      });
    })
    .sort((left, right) =>
      left.siteScopeKey < right.siteScopeKey ? -1 : left.siteScopeKey > right.siteScopeKey ? 1 : 0,
    );

  const frozenSnapshots = Object.freeze(snapshots);
  const membershipPreimage = frozenSnapshots
    .map(
      ({ siteScopeKey, poolScope, payloadDigest }) =>
        `${siteScopeKey.length}:${siteScopeKey}|${poolScope.length}:${poolScope}|${payloadDigest}`,
    )
    .join('\n');
  return Object.freeze({
    catalogDigest: FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
    exactSetDigest: canonicalWireJsonSha256V1(EXACT_SET_DIGEST_AUTHORITY, frozenSnapshots),
    membershipDigest: sha256Hex(membershipPreimage),
    snapshotCount: frozenSnapshots.length,
    snapshots: frozenSnapshots,
  });
}
