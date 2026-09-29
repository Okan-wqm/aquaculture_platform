import {
  SIGNAL_KEY_PREFIXES,
  isSignalKey,
  parseSignalKey,
  signalKey,
  stockScopeFromSiteScopeKey,
  type SignalKind,
  type SignalSubject,
} from '../signal-key';

const SITE = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

/**
 * One representative subject per kind. `satisfies Record<SignalKind, …>` makes a
 * new kind without a sample a compile error, so the round-trip below can never
 * silently skip a kind.
 */
const SAMPLES = {
  water: { kind: 'water', equipmentId: ID },
  'water-measurement': { kind: 'water-measurement', measurementId: ID },
  mortality: { kind: 'mortality', batchId: ID },
  stock: { kind: 'stock', scope: { level: 'site', siteId: SITE }, itemId: ID },
  'feed-stockout': { kind: 'feed-stockout', scope: { level: 'pool' }, feedId: ID },
  'feed-transition-gap': { kind: 'feed-transition-gap', unitId: ID, toFeedId: OTHER },
  'feed-transition': { kind: 'feed-transition', unitId: ID },
  fcr: { kind: 'fcr', batchId: ID },
  'meal-underfed': { kind: 'meal-underfed', unitId: ID },
  'meal-missed': { kind: 'meal-missed', unitId: ID },
  'unfed-unit': { kind: 'unfed-unit', unitId: ID },
  'feeding-window-oxygen': { kind: 'feeding-window-oxygen', unitId: ID },
} satisfies { [K in SignalKind]: Extract<SignalSubject, { kind: K }> };

describe('signalKey', () => {
  it.each(Object.values(SAMPLES))(
    // SCENARIO: every subject kind is rendered and parsed back.
    // EXPECTS: parse(render(s)) deep-equals s, and the key is recognised as a SignalKey.
    'round-trips %o',
    (subject: SignalSubject) => {
      const key = signalKey(subject);
      expect(parseSignalKey(key)).toEqual(subject);
      expect(isSignalKey(key)).toBe(true);
    },
  );

  it('renders the plan-documented shapes verbatim', () => {
    // SCENARIO: the keys other owners (tasks, AI suggestions) will match on.
    // EXPECTS: the exact strings the plan names — a format change is a contract change.
    expect(signalKey({ kind: 'water', equipmentId: ID })).toBe(`water:equipment:${ID}`);
    expect(signalKey({ kind: 'mortality', batchId: ID })).toBe(`mortality:batch:${ID}`);
    expect(signalKey({ kind: 'stock', scope: { level: 'site', siteId: SITE }, itemId: ID })).toBe(
      `stock:${SITE}:${ID}`,
    );
    expect(signalKey({ kind: 'stock', scope: { level: 'pool' }, itemId: ID })).toBe(
      `stock:pool:${ID}`,
    );
  });

  it('keeps every kind prefix distinct', () => {
    // SCENARIO: two kinds sharing a prefix would make parse ambiguous.
    // EXPECTS: the prefix table has no duplicates.
    const prefixes = Object.values(SIGNAL_KEY_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('keys mortality per batch, so two batches never share an incident', () => {
    // SCENARIO: deaths in batch A and batch B of the same tenant.
    // EXPECTS: two different keys (the old key was tenant-wide per alert type).
    expect(signalKey({ kind: 'mortality', batchId: ID })).not.toBe(
      signalKey({ kind: 'mortality', batchId: OTHER }),
    );
  });

  it.each([
    [{ kind: 'water', equipmentId: '' }],
    [{ kind: 'mortality', batchId: 'a:b' }],
    [{ kind: 'stock', scope: { level: 'site', siteId: 'pool' }, itemId: ID }],
  ] as Array<[SignalSubject]>)('refuses an unparseable subject %o', (subject) => {
    // SCENARIO: an id that would shift segments, or a site id that reads as the pool.
    // EXPECTS: a TypeError instead of a key that parses back to a different condition.
    expect(() => signalKey(subject)).toThrow(TypeError);
  });

  it.each([
    '',
    'water',
    'water:equipment',
    'water:tank:x',
    'stock:x',
    'mortality:batch:a:b',
    'a::b',
  ])('does not recognise %p as a signal key', (value) => {
    // SCENARIO: stray strings read from storage or the wire.
    // EXPECTS: parse returns null and the guard rejects them.
    expect(parseSignalKey(value)).toBeNull();
    expect(isSignalKey(value)).toBe(false);
  });

  it('maps the feed forecast scope key onto the two stock tiers', () => {
    // SCENARIO: FeedStockoutForecast carries a site UUID or the 'tenant' fallback (D-9).
    // EXPECTS: 'tenant' is the pool; anything else is that site.
    expect(stockScopeFromSiteScopeKey('tenant')).toEqual({ level: 'pool' });
    expect(stockScopeFromSiteScopeKey(SITE)).toEqual({ level: 'site', siteId: SITE });
  });
});
