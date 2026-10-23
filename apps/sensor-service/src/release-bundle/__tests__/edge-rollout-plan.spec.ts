import {
  assertPlanShape,
  type EdgeRolloutPlan,
  MAX_ROLLOUT_DEVICES,
  MAX_ROLLOUT_SITE_FILES_BYTES,
  MAX_ROLLOUT_WAVES,
  planDigest,
  recipeOf,
  type RolloutPlan,
  targetOf,
  termsOf,
} from '../edge-rollout-plan';
import { isLegalRolloutTransition, phaseOf } from '../edge-rollout.service';
import { EdgeRolloutKind, EdgeRolloutState } from '../entities/edge-rollout.entity';

/** The rules of a rollout that need no database (ADR-048 DEC-2.4, DEC-23). */

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TERMS = { localApproval: false, blockersOverride: false, maxOutageSeconds: 120 };
const plan = (over: Partial<EdgeRolloutPlan> = {}): EdgeRolloutPlan => ({
  kind: EdgeRolloutKind.EDGE_UPDATE,
  version: '1.7.0',
  terms: TERMS,
  windowNotBefore: null,
  windowSeconds: 7200,
  maxFailures: 0,
  waves: [[uuid(1)], [uuid(2), uuid(3)]],
  ...over,
});

describe('assertPlanShape', () => {
  it('admits a plan of waves of distinct devices', () => {
    expect(() => assertPlanShape(plan())).not.toThrow();
  });

  it.each([
    ['no wave', { waves: [] }, /between 1 and 10 waves|between 1 and 10 are allowed/],
    [
      'too many waves',
      { waves: Array.from({ length: MAX_ROLLOUT_WAVES + 1 }, (_, i) => [uuid(i + 1)]) },
      /waves/,
    ],
    ['an empty wave', { waves: [[uuid(1)], []] }, /wave 2 has no device/],
    ['a device that is not an id', { waves: [['RO-001']] }, /is not a device id/],
    ['a device in two waves', { waves: [[uuid(1)], [uuid(1)]] }, /in the cohort twice/],
    [
      'more devices than a rollout carries',
      { waves: [Array.from({ length: MAX_ROLLOUT_DEVICES + 1 }, (_, i) => uuid(i + 1))] },
      /at most 500/,
    ],
    ['a negative failure allowance', { maxFailures: -1 }, /failure allowance/],
    ['a fractional failure allowance', { maxFailures: 0.5 }, /failure allowance/],
    ['a failure allowance above the cohort', { maxFailures: 4 }, /failure allowance/],
    [
      'a window start with a fractional second',
      { windowNotBefore: new Date(1_700_000_000_500) },
      /fractional second/,
    ],
    ['a fractional window length', { windowSeconds: 7200.5 }, /not what the kind needs/],
    ['a version that is not path-safe', { version: '../1.7.0' }, /not what the kind needs/],
  ])('refuses %s', (_name, over, message) => {
    expect(() => assertPlanShape(plan(over as Partial<EdgeRolloutPlan>))).toThrow(message);
  });
});

describe('planDigest and recipeOf', () => {
  it('is 64 hex characters and stable', () => {
    expect(planDigest(plan())).toMatch(/^[0-9a-f]{64}$/);
    expect(planDigest(plan())).toBe(planDigest(plan()));
  });

  it('reads a stored rollout back into the recipe every statement of it is re-issued from', () => {
    const p = plan({ windowSeconds: 3600 });
    expect(
      recipeOf({ kind: p.kind, target: targetOf(p), terms: TERMS, windowSeconds: p.windowSeconds }),
    ).toEqual({ kind: 'edge-update', version: '1.7.0', terms: TERMS, windowSeconds: 3600 });
  });

  it('reads nothing from a target that does not fit the kind', () => {
    expect(
      recipeOf({
        kind: 'os-update',
        target: { version: '1.7.0' },
        terms: TERMS,
        windowSeconds: 7200,
      }),
    ).toBeNull();
    expect(
      recipeOf({ kind: 'edge-update', target: {}, terms: TERMS, windowSeconds: 7200 }),
    ).toBeNull();
  });
});

describe('phaseOf: what the campaign of a device says about it', () => {
  const row = (over: Partial<Parameters<typeof phaseOf>[0]>): Parameters<typeof phaseOf>[0] => ({
    refusal: null,
    requestId: 'r1',
    requestState: 'pending',
    ...over,
  });

  it.each([
    ['not signed yet', { requestId: null, requestState: null }, 'queued'],
    [
      'a refusal of the cloud',
      { refusal: 'cannot sign', requestId: null, requestState: null },
      'failed',
    ],
    ['delivered, waiting for a result', { requestState: 'pending' }, 'in-flight'],
    ['a retryable refusal awaiting its re-issue', { requestState: 'retry' }, 'in-flight'],
    ['replaced by a re-issue', { requestState: 'reissued' }, 'in-flight'],
    ['installed', { requestState: 'done' }, 'done'],
    ['a final refusal', { requestState: 'failed' }, 'failed'],
    ['a window the operator must reschedule', { requestState: 'reschedule' }, 'failed'],
    ['a window that closed in silence', { requestState: 'lapsed' }, 'failed'],
    ['a request that is gone', { requestState: null }, 'failed'],
  ])('%s is %s', (_name, over, phase) => {
    expect(phaseOf(row(over))).toBe(phase);
  });
});

describe('the rollout state machine', () => {
  const legal: ReadonlyArray<[EdgeRolloutState, EdgeRolloutState]> = [
    [EdgeRolloutState.AWAITING_APPROVAL, EdgeRolloutState.RUNNING],
    [EdgeRolloutState.AWAITING_APPROVAL, EdgeRolloutState.CANCELLED],
    [EdgeRolloutState.RUNNING, EdgeRolloutState.COMPLETED],
    [EdgeRolloutState.RUNNING, EdgeRolloutState.HALTED],
    [EdgeRolloutState.RUNNING, EdgeRolloutState.CANCELLED],
  ];

  it('has exactly these edges', () => {
    const all = Object.values(EdgeRolloutState);
    const found = all.flatMap((from) =>
      all.filter((to) => isLegalRolloutTransition(from, to)).map((to) => [from, to]),
    );
    expect(found).toEqual(legal);
  });

  it('ends for good in completed, halted and cancelled', () => {
    for (const end of [
      EdgeRolloutState.COMPLETED,
      EdgeRolloutState.HALTED,
      EdgeRolloutState.CANCELLED,
    ]) {
      for (const to of Object.values(EdgeRolloutState)) {
        expect(isLegalRolloutTransition(end, to)).toBe(false);
      }
    }
  });

  it('is entered into running from awaiting-approval only', () => {
    const into = Object.values(EdgeRolloutState).filter((from) =>
      isLegalRolloutTransition(from, EdgeRolloutState.RUNNING),
    );
    expect(into).toEqual([EdgeRolloutState.AWAITING_APPROVAL]);
  });
});

describe('the plans of the other kinds', () => {
  const group = [[uuid(1)]];
  const common = { windowNotBefore: null, windowSeconds: 7200, maxFailures: 0, waves: group };
  const POLICY = {
    interfaces: [],
    ot_rules: [{ id: 'plc', proto: 'tcp', dst: '10.0.0.0/24', ports: [{ from: 502, to: 502 }] }],
    time_sources: [],
  } as const;
  const site: RolloutPlan = { kind: EdgeRolloutKind.SITE_CONFIG, files: {}, ...common };
  const net: RolloutPlan = { kind: EdgeRolloutKind.SITE_NETPOLICY, policy: POLICY, ...common };
  const anchors: RolloutPlan = {
    kind: EdgeRolloutKind.TRUST_ANCHORS,
    bundleDigest: 'ab'.repeat(32),
    bundleSeq: 3,
    ...common,
  };

  it.each([
    ['a site config', site, { files: {} }, {}],
    ['a site policy', net, { policy: POLICY }, {}],
    ['the trust-anchors bundle', anchors, { bundleDigest: 'ab'.repeat(32), bundleSeq: 3 }, {}],
  ])('%s stores its target and no terms', (_name, plan, target, terms) => {
    expect(targetOf(plan)).toEqual(target);
    expect(termsOf(plan)).toEqual(terms);
    expect(() => assertPlanShape(plan)).not.toThrow();
  });

  it('reads each stored rollout back into the recipe its statements are issued from', () => {
    for (const plan of [site, net, anchors]) {
      const recipe = recipeOf({
        kind: plan.kind,
        target: targetOf(plan),
        terms: termsOf(plan),
        windowSeconds: plan.windowSeconds,
      });
      expect(recipe?.kind).toBe(plan.kind);
    }
  });

  it('is a plan of its own: the digest covers the kind and what it carries', () => {
    const digests = new Set([
      planDigest(site),
      planDigest(net),
      planDigest(anchors),
      planDigest(plan()),
      planDigest({ ...site, files: { 'io-config.yaml': 'dGFncw==' } }),
      planDigest({
        ...net,
        policy: { ...POLICY, time_sources: [{ id: 'ntp', host: 'ntp.example.com', nts: true }] },
      }),
      planDigest({ ...anchors, bundleSeq: 4 }),
      planDigest({ ...anchors, bundleDigest: 'cd'.repeat(32) }),
    ]);
    expect(digests.size).toBe(8);
  });

  it('refuses a site config whose files are more than a rollout stores', () => {
    const big = Buffer.alloc(MAX_ROLLOUT_SITE_FILES_BYTES + 1, 0x61).toString('base64');
    expect(() =>
      assertPlanShape({
        kind: EdgeRolloutKind.SITE_CONFIG,
        files: { 'io-config.yaml': big },
        ...common,
      }),
    ).toThrow(/at most 262144/);
  });

  it('refuses a site config naming a path that is not a site file, a trust-anchors plan without a digest', () => {
    expect(() =>
      assertPlanShape({
        kind: EdgeRolloutKind.SITE_CONFIG,
        files: { 'etc/passwd': 'eA==' },
        ...common,
      }),
    ).toThrow(/not what the kind needs/);
    expect(() =>
      assertPlanShape({ ...anchors, bundleDigest: 'not-a-digest' } as RolloutPlan),
    ).toThrow(/not what the kind needs/);
  });

  it('refuses a policy value JSON cannot state', () => {
    expect(() =>
      targetOf({
        ...net,
        policy: { ...POLICY, ot_rules: [{ ...POLICY.ot_rules[0], ports: [{ from: 1.5, to: 2 }] }] },
      } as RolloutPlan),
    ).toThrow(/not an integer/);
  });
});
