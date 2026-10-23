import {
  assertPlanShape,
  type EdgeRolloutPlan,
  MAX_ROLLOUT_DEVICES,
  MAX_ROLLOUT_WAVES,
  planDigest,
  recipeOf,
  targetOf,
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
