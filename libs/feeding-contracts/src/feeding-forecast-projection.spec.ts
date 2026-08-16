import {
  assertFeedingForecastMortalityProvenanceV1,
  compileFeedingForecastMortalityProvenanceV1,
  FEEDING_FORECAST_PROJECTION_V1,
  compileFeedingForecastAlertV1,
  compileFeedingForecastBandPathV1,
  compileFeedingForecastPoolIdentityV1,
  feedingForecastAlertWithinHorizonV1,
  feedingForecastIsStaleV1,
  feedingForecastPoolMembershipV1,
  feedingForecastScopeKeysToPruneV1,
} from './feeding-forecast-projection';

describe('feeding forecast projection authority', () => {
  it('fans every unit into one tenant authority and at most one Site projection', () => {
    for (let index = 0; index < 64; index++) {
      const siteId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const memberships = feedingForecastPoolMembershipV1(siteId, index % 2 === 0);
      expect(memberships.filter(({ poolScope }) => poolScope === 'TENANT')).toEqual([
        { siteScopeKey: FEEDING_FORECAST_PROJECTION_V1.tenantScopeKey, poolScope: 'TENANT' },
      ]);
      expect(new Set(memberships.map(({ siteScopeKey }) => siteScopeKey)).size).toBe(
        memberships.length,
      );
      expect(memberships).toHaveLength(index % 2 === 0 ? 2 : 1);
    }
  });

  it('rejects contradictory persisted scope identities', () => {
    expect(() => compileFeedingForecastPoolIdentityV1('tenant', 'SITE')).toThrow(
      /conflicting pool semantics/,
    );
    expect(() =>
      compileFeedingForecastPoolIdentityV1('00000000-0000-4000-8000-000000000001', 'TENANT'),
    ).toThrow(/conflicting pool semantics/);
  });

  it('prunes the exact persisted-minus-desired set for every desired subset', () => {
    const siteIds = Array.from(
      { length: 12 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const persisted = [
      compileFeedingForecastPoolIdentityV1('tenant', 'TENANT'),
      ...siteIds.map((siteId) => compileFeedingForecastPoolIdentityV1(siteId, 'SITE')),
    ];
    for (let mask = 0; mask < 1 << siteIds.length; mask += 257) {
      const desired = persisted.filter(
        (identity, index) => index === 0 || (mask & (1 << (index - 1))) !== 0,
      );
      expect(feedingForecastScopeKeysToPruneV1(persisted, desired)).toEqual(
        persisted
          .filter((identity) => !desired.includes(identity))
          .map((identity) => identity.siteScopeKey)
          .sort(),
      );
    }
    expect(feedingForecastScopeKeysToPruneV1(persisted, [])).toEqual(
      persisted.map((identity) => identity.siteScopeKey).sort(),
    );
  });

  it('owns day-zero, terminal and transition feed resolution', () => {
    expect(
      compileFeedingForecastBandPathV1([
        { atDay: 0, feedId: 'feed-a' },
        { atDay: 12, feedId: 'feed-b' },
        { atDay: 40, feedId: 'feed-c' },
      ]),
    ).toEqual({
      currentFeedId: 'feed-a',
      terminalFeedId: 'feed-c',
      transitions: [
        { fromFeedId: 'feed-a', toFeedId: 'feed-b', atDay: 12 },
        { fromFeedId: 'feed-b', toFeedId: 'feed-c', atDay: 40 },
      ],
    });
  });

  it('slices alerts by atDay and evaluates staleness from explicit clocks', () => {
    const alert = compileFeedingForecastAlertV1({
      type: 'TRANSITION_COVERAGE_GAP',
      feedId: 'feed-b',
      unitId: 'unit-a',
      days: 100,
      atDay: 3,
    });
    expect(feedingForecastAlertWithinHorizonV1(alert, 7)).toBe(true);
    expect(feedingForecastAlertWithinHorizonV1(alert, 3)).toBe(false);
    const computedAt = new Date('2026-08-01T00:00:00.000Z');
    expect(feedingForecastIsStaleV1(computedAt, new Date('2026-08-02T01:59:59.999Z'))).toBe(
      false,
    );
    expect(feedingForecastIsStaleV1(computedAt, new Date('2026-08-02T02:00:00.001Z'))).toBe(
      true,
    );
  });

  it('compiles mixed mortality coverage from exact per-unit evidence', () => {
    const provenance = compileFeedingForecastMortalityProvenanceV1([
      { unitId: 'unit-b', source: 'none', dailySurvivalRate: 1 },
      { unitId: 'unit-a', source: 'species_survival_rate', dailySurvivalRate: 0.9997 },
    ]);

    expect(provenance).toEqual({
      schemaVersion: 'feeding-forecast-mortality-provenance/v1',
      coverage: 'PARTIAL',
      unitCount: 2,
      speciesRateUnitCount: 1,
      conservativeDefaultUnitCount: 1,
      units: [
        { unitId: 'unit-a', source: 'species_survival_rate', dailySurvivalRate: 0.9997 },
        { unitId: 'unit-b', source: 'none', dailySurvivalRate: 1 },
      ],
    });
    expect(
      assertFeedingForecastMortalityProvenanceV1(provenance, ['unit-a', 'unit-b']),
    ).toEqual(provenance);
  });

  it('rejects ambiguous legacy booleans and unit-set omissions', () => {
    expect(() =>
      assertFeedingForecastMortalityProvenanceV1({
        applied: true,
        source: 'species_survival_rate',
      }),
    ).toThrow(/not unit-addressable/);
    const oneUnit = compileFeedingForecastMortalityProvenanceV1([
      { unitId: 'unit-a', source: 'none', dailySurvivalRate: 1 },
    ]);
    expect(() =>
      assertFeedingForecastMortalityProvenanceV1(oneUnit, ['unit-a', 'unit-b']),
    ).toThrow(/exact unit set/);
  });
});
