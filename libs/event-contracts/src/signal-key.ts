/**
 * signalKey — the ONE identity of a farm condition (ALERT-MEDIUM-006, plan ALERT-4).
 *
 * WHY: the same farm condition (a tank's dissolved oxygen crashing, a batch dying,
 * a feed running out at a site) is looked at by several owners — the alert-engine
 * incident, the auto-rule task, the AI tracking suggestion and the tracking finding.
 * Each used to spell its own key (`system:water-quality:{tank}`,
 * `system:mortality:{alertType}` tenant-wide, …), so two owners could never tell
 * they were talking about the same condition, and mortality in batch B bumped the
 * incident titled for batch A. One builder here makes every owner derive the key
 * from the same subject, so equal conditions produce equal keys by construction.
 *
 * WHAT: `signalKey(subject)` renders a discriminated subject into a stable,
 * colon-separated key; `parseSignalKey(key)` is its exact inverse. The result is a
 * BRANDED string: the only way to obtain a `SignalKey` is this builder, so a
 * consumer that types its key field as `SignalKey` cannot be handed a hand-spelled
 * string (tier 1 — the compiler refuses it). `tests/invariants/signal-key-ssot.spec.ts`
 * closes the remaining hole (a `as SignalKey` cast, or a hand-spelled key literal).
 *
 * INVARIANT: every id segment is non-empty and colon-free, and a site segment is
 * never the literal `pool`; if violated → `signalKey` throws, because a key that
 * cannot be parsed back would silently merge or split conditions.
 */

declare const SIGNAL_KEY_BRAND: unique symbol;

/** A key produced by {@link signalKey}. Plain strings are not assignable to it. */
export type SignalKey = string & { readonly [SIGNAL_KEY_BRAND]: true };

/**
 * Stock is committed in two tiers (plan K8): a SITE holds physical stock, the
 * POOL (the tenant's own sites summed) is what procurement reorders against.
 */
export type StockSignalScope = { level: 'site'; siteId: string } | { level: 'pool' };

/** Every farm condition a signal key can name. */
export type SignalSubject =
  /** Water quality of one unit (a tank IS equipment — plan K6). */
  | { kind: 'water'; equipmentId: string }
  /** Water quality of a measurement with no unit (neither equipment nor tank id). */
  | { kind: 'water-measurement'; measurementId: string }
  /** Mortality of one batch — per batch, never tenant-wide. */
  | { kind: 'mortality'; batchId: string }
  /** Stock level of one item at a site or across the pool. */
  | { kind: 'stock'; scope: StockSignalScope; itemId: string }
  /** Forecast stockout of one feed at a site or across the pool. */
  | { kind: 'feed-stockout'; scope: StockSignalScope; feedId: string }
  /** A unit's upcoming feed change whose target feed does not cover it. */
  | { kind: 'feed-transition-gap'; unitId: string; toFeedId: string }
  /** A unit's completed feed-type change (audit only, no incident). */
  | { kind: 'feed-transition'; unitId: string }
  /** Feed conversion of one batch. */
  | { kind: 'fcr'; batchId: string }
  /** A unit fed less than planned. */
  | { kind: 'meal-underfed'; unitId: string }
  /** A unit whose meal was missed. */
  | { kind: 'meal-missed'; unitId: string }
  /** A fish-bearing unit with no effective feeding plan. */
  | { kind: 'unfed-unit'; unitId: string }
  /** A unit whose dissolved oxygen is too low to feed in its meal window. */
  | { kind: 'feeding-window-oxygen'; unitId: string };

export type SignalKind = SignalSubject['kind'];

/** The literal a pool-scoped stock key uses in place of a site id. */
const POOL_SEGMENT = 'pool';

/**
 * Leading segments of every key. Two kinds never share a prefix, so the prefix
 * alone decides how the rest of a key is read.
 */
export const SIGNAL_KEY_PREFIXES: Readonly<Record<SignalKind, string>> = {
  water: 'water:equipment',
  'water-measurement': 'water:measurement',
  mortality: 'mortality:batch',
  stock: 'stock',
  'feed-stockout': 'feed-stockout',
  'feed-transition-gap': 'feed-transition-gap:unit',
  'feed-transition': 'feed-transition:unit',
  fcr: 'fcr:batch',
  'meal-underfed': 'meal-underfed:unit',
  'meal-missed': 'meal-missed:unit',
  'unfed-unit': 'unfed:unit',
  'feeding-window-oxygen': 'feeding-oxygen:unit',
};

/** WHY: a colon inside an id would shift every later segment on parse. */
function segment(value: string, field: string): string {
  if (value.length === 0 || value.includes(':')) {
    throw new TypeError(`signalKey: ${field} must be a non-empty, colon-free id (got "${value}")`);
  }
  return value;
}

function scopeSegment(scope: StockSignalScope): string {
  if (scope.level === 'pool') return POOL_SEGMENT;
  if (scope.siteId === POOL_SEGMENT) {
    throw new TypeError('signalKey: a site id cannot be the reserved word "pool"');
  }
  return segment(scope.siteId, 'siteId');
}

/** Render a farm condition's subject into its platform-wide key. */
export function signalKey(subject: SignalSubject): SignalKey {
  const prefix = SIGNAL_KEY_PREFIXES[subject.kind];
  let rendered: string;
  switch (subject.kind) {
    case 'water':
      rendered = `${prefix}:${segment(subject.equipmentId, 'equipmentId')}`;
      break;
    case 'water-measurement':
      rendered = `${prefix}:${segment(subject.measurementId, 'measurementId')}`;
      break;
    case 'mortality':
    case 'fcr':
      rendered = `${prefix}:${segment(subject.batchId, 'batchId')}`;
      break;
    case 'stock':
      rendered = `${prefix}:${scopeSegment(subject.scope)}:${segment(subject.itemId, 'itemId')}`;
      break;
    case 'feed-stockout':
      rendered = `${prefix}:${scopeSegment(subject.scope)}:${segment(subject.feedId, 'feedId')}`;
      break;
    case 'feed-transition-gap':
      rendered =
        `${prefix}:${segment(subject.unitId, 'unitId')}:` + segment(subject.toFeedId, 'toFeedId');
      break;
    case 'feed-transition':
    case 'meal-underfed':
    case 'meal-missed':
    case 'unfed-unit':
    case 'feeding-window-oxygen':
      rendered = `${prefix}:${segment(subject.unitId, 'unitId')}`;
      break;
  }
  return rendered as SignalKey;
}

function parseScope(value: string): StockSignalScope {
  return value === POOL_SEGMENT ? { level: 'pool' } : { level: 'site', siteId: value };
}

/** Kinds whose key is `<two-segment prefix>:<one id>`, keyed by that prefix. */
function singleIdSubject(prefix: string, id: string): SignalSubject | null {
  switch (prefix) {
    case SIGNAL_KEY_PREFIXES.water:
      return { kind: 'water', equipmentId: id };
    case SIGNAL_KEY_PREFIXES['water-measurement']:
      return { kind: 'water-measurement', measurementId: id };
    case SIGNAL_KEY_PREFIXES.mortality:
      return { kind: 'mortality', batchId: id };
    case SIGNAL_KEY_PREFIXES.fcr:
      return { kind: 'fcr', batchId: id };
    case SIGNAL_KEY_PREFIXES['feed-transition']:
      return { kind: 'feed-transition', unitId: id };
    case SIGNAL_KEY_PREFIXES['meal-underfed']:
      return { kind: 'meal-underfed', unitId: id };
    case SIGNAL_KEY_PREFIXES['meal-missed']:
      return { kind: 'meal-missed', unitId: id };
    case SIGNAL_KEY_PREFIXES['unfed-unit']:
      return { kind: 'unfed-unit', unitId: id };
    case SIGNAL_KEY_PREFIXES['feeding-window-oxygen']:
      return { kind: 'feeding-window-oxygen', unitId: id };
    default:
      return null;
  }
}

/**
 * Inverse of {@link signalKey}. Returns `null` for anything the builder could not
 * have produced (unknown prefix, wrong segment count, empty segment), so a caller
 * reading a key from storage or the wire can tell a real key from a stray string.
 */
export function parseSignalKey(key: string): SignalSubject | null {
  const parts = key.split(':');
  if (parts.some((part) => part.length === 0)) return null;
  const [first, second, third, fourth] = parts;
  if (first === undefined || second === undefined || third === undefined) return null;

  if (parts.length === 3) {
    if (first === SIGNAL_KEY_PREFIXES.stock) {
      return { kind: 'stock', scope: parseScope(second), itemId: third };
    }
    if (first === SIGNAL_KEY_PREFIXES['feed-stockout']) {
      return { kind: 'feed-stockout', scope: parseScope(second), feedId: third };
    }
    return singleIdSubject(`${first}:${second}`, third);
  }
  if (
    parts.length === 4 &&
    fourth !== undefined &&
    `${first}:${second}` === SIGNAL_KEY_PREFIXES['feed-transition-gap']
  ) {
    return { kind: 'feed-transition-gap', unitId: third, toFeedId: fourth };
  }
  return null;
}

/** True when `value` is exactly what {@link signalKey} would produce for some subject. */
export function isSignalKey(value: string): value is SignalKey {
  const subject = parseSignalKey(value);
  return subject !== null && signalKey(subject) === value;
}

/**
 * Map the feed-coverage forecast's `siteScopeKey` (a site UUID, or the documented
 * tenant-wide fallback `'tenant'` — D-9) onto the two-tier stock scope.
 */
export function stockScopeFromSiteScopeKey(siteScopeKey: string): StockSignalScope {
  return siteScopeKey === 'tenant' ? { level: 'pool' } : { level: 'site', siteId: siteScopeKey };
}
