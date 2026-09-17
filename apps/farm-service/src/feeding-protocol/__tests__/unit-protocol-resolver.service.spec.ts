/**
 * UnitProtocolResolverService — the unit-keyed protocol SSoT.
 *
 * Pins the contract the three former `batches_v2.protocolId` readers now share:
 *  - the lookup keys on `feeding_protocol_assignments.unitId`, joins the ACTIVE
 *    protocol, and NEVER touches `batches_v2` or the v1 `feeding_protocols`;
 *  - the rate is `ProtocolRateService`'s math (band × tempMultiplier ×
 *    (1 + rateAdj/100), clamped) — the same numbers the 06:00 generator emits;
 *  - "no temperature reading" means multiplier 1.0, never a fabricated default.
 *
 * The rate service is REAL here on purpose: stubbing it would leave the claim
 * "all callers now agree on one formula" untested.
 */
import { getTenantSchemaName } from '@aquaculture/backend-common/database';

import { ProtocolRateService, derivedBandWeightG } from '../services/protocol-rate.service';
import {
  UnitProtocolResolverService,
  type ProtocolSqlExecutor,
} from '../services/unit-protocol-resolver.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT_A = '77777777-7777-4777-8777-777777777777';
const UNIT_B = '88888888-8888-4888-8888-888888888888';

const BANDS = [
  {
    minWeightG: 0,
    maxWeightG: 200,
    feedId: 'feed-s1',
    feedCode: 'S1',
    feedName: 'Starter 1mm',
    feedingRatePercent: 3,
    expectedFcr: 1.1,
  },
  {
    minWeightG: 200,
    maxWeightG: 1000000,
    feedId: 'feed-g4',
    feedCode: 'G4',
    feedName: 'Grower 4mm',
    feedingRatePercent: 2,
    expectedFcr: 1.3,
  },
];

function row(unitId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unitId,
    overrides: null,
    protocolId: 'p-1',
    protocolName: 'Std Protocol',
    bands: BANDS,
    temperatureAdjustments: [{ minC: 10, maxC: 20, rateMultiplier: 1.2 }],
    settings: { fcrSource: 'band' },
    ...extra,
  };
}

/** Honest double: the resolver's parameter type IS `{ query }`, nothing more. */
function executor(query: jest.Mock): ProtocolSqlExecutor {
  return { query };
}

function makeResolver(): UnitProtocolResolverService {
  return new UnitProtocolResolverService(new ProtocolRateService());
}

/** 120 g from a unit aggregate: 100 kg over 833.33 fish. */
const W_120G = derivedBandWeightG(100, 833.3333333333334);
/** 350 g from a unit aggregate: 200 kg over 571.43 fish. */
const W_350G = derivedBandWeightG(200, 571.4285714285714);

describe('UnitProtocolResolverService.loadActiveBindings', () => {
  it('keys on the unit and never reads the retired batch column', async () => {
    const query = jest.fn().mockResolvedValue([row(UNIT_A)]);

    const bindings = await makeResolver().loadActiveBindings(executor(query), TENANT, [UNIT_A]);

    expect(bindings.get(UNIT_A)?.protocolId).toBe('p-1');
    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('feeding_protocol_assignments');
    expect(sql).toContain('feeding_protocols_v2');
    expect(sql).not.toContain('batches_v2');
    // Only ACTIVE assignments of ACTIVE, undeleted protocols count.
    expect(sql).toContain(`pa."status" = 'active'`);
    expect(sql).toContain(`p."status" = 'active'`);
    expect(sql).toContain(`p."isDeleted" = false`);
  });

  it('schema-qualifies and binds the tenant as a parameter', async () => {
    const query = jest.fn().mockResolvedValue([]);

    await makeResolver().loadActiveBindings(executor(query), TENANT, [UNIT_A]);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // Qualified against the tenant schema (not search_path), so the cron paths
    // that carry no request context still read the right tenant's tables.
    expect(sql).toContain(`"${getTenantSchemaName(TENANT)}".feeding_protocol_assignments`);
    expect(sql).toContain(`"${getTenantSchemaName(TENANT)}".feeding_protocols_v2`);
    // Tenant and unit ids are bound, never interpolated.
    expect(params[0]).toBe(TENANT);
    expect(params[1]).toEqual([UNIT_A]);
  });

  it('de-duplicates unit ids and skips the round trip when there are none', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const resolver = makeResolver();

    await resolver.loadActiveBindings(executor(query), TENANT, [UNIT_A, UNIT_A, UNIT_B]);
    expect((query.mock.calls[0] as [string, unknown[]])[1][1]).toEqual([UNIT_A, UNIT_B]);

    query.mockClear();
    const empty = await resolver.loadActiveBindings(executor(query), TENANT, []);
    expect(empty.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('parses jsonb columns whether the driver hands back objects or text', async () => {
    const query = jest.fn().mockResolvedValue([
      row(UNIT_A, {
        bands: JSON.stringify(BANDS),
        temperatureAdjustments: JSON.stringify([{ minC: 10, maxC: 20, rateMultiplier: 1.2 }]),
        settings: JSON.stringify({ fcrSource: 'band' }),
        overrides: JSON.stringify({ rateAdjustmentPercent: 10 }),
      }),
    ]);

    const bindings = await makeResolver().loadActiveBindings(executor(query), TENANT, [UNIT_A]);

    expect(bindings.get(UNIT_A)?.bands).toHaveLength(2);
    expect(bindings.get(UNIT_A)?.overrides?.rateAdjustmentPercent).toBe(10);
  });
});

describe('UnitProtocolResolverService.resolveRate', () => {
  it('reproduces the 06:00 generator formula: band x temp x override, clamped', async () => {
    const query = jest.fn().mockResolvedValue([
      row(UNIT_A, {
        overrides: { rateAdjustmentPercent: 10 },
        settings: { fcrSource: 'band', maxFeedingRatePercent: 10 },
      }),
    ]);
    const resolver = makeResolver();
    const bindings = await resolver.loadActiveBindings(executor(query), TENANT, [UNIT_A]);

    // 3 % × 1.2 (15 °C band) × 1.10 = 3.96
    const resolved = resolver.resolveRate(bindings.get(UNIT_A)!, W_120G, 15);

    expect(resolved).toMatchObject({
      unitId: UNIT_A,
      protocolId: 'p-1',
      protocolName: 'Std Protocol',
      bandIndex: 0,
      feedId: 'feed-s1',
      feedCode: 'S1',
      feedName: 'Starter 1mm',
    });
    expect(resolved?.effectiveRatePercent).toBeCloseTo(3.96, 6);
  });

  it('clamps to the protocol maximum rather than letting an override run away', async () => {
    const query = jest.fn().mockResolvedValue([
      row(UNIT_A, {
        overrides: { rateAdjustmentPercent: 50 },
        settings: { fcrSource: 'band', maxFeedingRatePercent: 4 },
      }),
    ]);
    const resolver = makeResolver();
    const bindings = await resolver.loadActiveBindings(executor(query), TENANT, [UNIT_A]);

    // 3 × 1.2 × 1.5 = 5.4 → clamped to 4.
    expect(resolver.resolveRate(bindings.get(UNIT_A)!, W_120G, 15)?.effectiveRatePercent).toBe(4);
  });

  it('leaves the multiplier at 1.0 when there is no temperature reading (P-20)', async () => {
    const query = jest.fn().mockResolvedValue([row(UNIT_A)]);
    const resolver = makeResolver();
    const bindings = await resolver.loadActiveBindings(executor(query), TENANT, [UNIT_A]);

    expect(resolver.resolveRate(bindings.get(UNIT_A)!, W_120G, null)?.effectiveRatePercent).toBe(3);
  });

  it('selects the band from the weight, half-open [min, max)', async () => {
    const query = jest.fn().mockResolvedValue([row(UNIT_A)]);
    const resolver = makeResolver();
    const bindings = await resolver.loadActiveBindings(executor(query), TENANT, [UNIT_A]);

    expect(resolver.resolveRate(bindings.get(UNIT_A)!, W_350G, null)?.feedCode).toBe('G4');
  });

  it('returns null for a protocol with no bands instead of inventing a rate', async () => {
    const query = jest.fn().mockResolvedValue([row(UNIT_A, { bands: [] })]);
    const resolver = makeResolver();
    const bindings = await resolver.loadActiveBindings(executor(query), TENANT, [UNIT_A]);

    expect(resolver.resolveRate(bindings.get(UNIT_A)!, W_120G, 15)).toBeNull();
  });
});

describe('UnitProtocolResolverService.resolveForUnit', () => {
  it('resolves a single unit through the same lookup and the same math', async () => {
    const query = jest.fn().mockResolvedValue([row(UNIT_A)]);

    const resolved = await makeResolver().resolveForUnit(
      executor(query),
      TENANT,
      UNIT_A,
      W_120G,
      15,
    );

    expect(resolved?.effectiveRatePercent).toBeCloseTo(3.6, 6); // 3 × 1.2
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('answers null when the unit has no active assignment', async () => {
    const query = jest.fn().mockResolvedValue([]);

    const resolved = await makeResolver().resolveForUnit(
      executor(query),
      TENANT,
      UNIT_A,
      W_120G,
      15,
    );

    expect(resolved).toBeNull();
  });
});
