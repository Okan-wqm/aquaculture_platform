import {
  evaluateFreshness,
  FreshnessContext,
  FreshnessPolicy,
  FreshnessProof,
} from '../src/kernel/freshness';

interface FreshnessContextFixture extends FreshnessContext {
  readonly current_invalidation_epochs: Map<string, string>;
}

const policy: FreshnessPolicy = {
  max_clock_skew_seconds: 30,
  proof_max_age_seconds: { SOURCE_CODE_ORACLE: 3600 },
  required_invalidation_keys: { SOURCE_CODE_ORACLE: ['authority', 'source_head'] },
} as const;

const proof = (): FreshnessProof => ({
  type: 'SOURCE_CODE_ORACLE',
  observed_at: '2026-09-02T12:00:00.000Z',
  valid_until: '2026-09-02T13:00:00.000Z',
  invalidation_epochs: [
    { key: 'authority', epoch: 'sha256:one' },
    { key: 'source_head', epoch: 'git:abc' },
  ],
});

const context = (): FreshnessContextFixture => ({
  now: '2026-09-02T12:30:00.000Z',
  current_invalidation_epochs: new Map([
    ['authority', 'sha256:one'],
    ['source_head', 'git:abc'],
  ]),
});

describe('typed evidence freshness', () => {
  it('accepts a current proof whose time and every invalidation epoch match', () => {
    expect(evaluateFreshness(proof(), context(), policy)).toBe('CURRENT');
  });

  it.each([
    ['expired', () => ({ ...context(), now: '2026-09-02T13:00:00.001Z' })],
    [
      'missing epoch',
      () => {
        const value = context();
        value.current_invalidation_epochs.delete('authority');
        return value;
      },
    ],
    [
      'changed epoch',
      () => {
        const value = context();
        value.current_invalidation_epochs.set('source_head', 'git:def');
        return value;
      },
    ],
  ])('marks %s evidence stale', (_name, mutate) => {
    expect(evaluateFreshness(proof(), mutate(), policy)).toBe('STALE');
  });

  it('rejects future, overlong, duplicate-key, empty-key, and invalid-time proofs', () => {
    expect(() =>
      evaluateFreshness({ ...proof(), observed_at: '2026-09-02T12:31:00.001Z' }, context(), policy),
    ).toThrow(/future/);
    expect(() =>
      evaluateFreshness({ ...proof(), valid_until: '2026-09-02T13:00:00.001Z' }, context(), policy),
    ).toThrow(/maximum age/);
    const firstEpoch = proof().invalidation_epochs.slice(0, 1);
    expect(() =>
      evaluateFreshness(
        { ...proof(), invalidation_epochs: [...firstEpoch, ...firstEpoch] },
        context(),
        policy,
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      evaluateFreshness(
        { ...proof(), invalidation_epochs: [{ key: '', epoch: 'x' }] },
        context(),
        policy,
      ),
    ).toThrow(/key/);
    expect(() => evaluateFreshness({ ...proof(), observed_at: 'bad' }, context(), policy)).toThrow(
      /timestamp/,
    );
  });

  it('rejects an attacker-selected invalidation set even when its epoch matches', () => {
    expect(() =>
      evaluateFreshness(
        { ...proof(), invalidation_epochs: [{ key: 'attacker_selected', epoch: 'same' }] },
        {
          ...context(),
          current_invalidation_epochs: new Map([['attacker_selected', 'same']]),
        },
        policy,
      ),
    ).toThrow(/required invalidation/);
  });
});
