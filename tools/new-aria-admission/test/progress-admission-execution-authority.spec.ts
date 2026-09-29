import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { admitScenario } from './admission-transaction-fixture';
import type { OracleProofOverrides } from './oracle-proof-fixture';

describe('sprint completion execution authority', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it.each([
    ['argv', { argv: ['node', 'other-verifier.mjs'] }],
    ['tool identity', { tool_id: 'attacker-verifier' }],
    ['tool', { tool_sha256: '9'.repeat(64) }],
    ['runtime identity', { runtime_id: 'attacker-runtime' }],
    ['runtime', { runtime_sha256: '8'.repeat(64) }],
    ['working directory', { cwd: 'workspace://attacker/checkout' }],
  ] as readonly [string, OracleProofOverrides][])(
    'rejects a self-consistent oracle report whose %s is outside authority',
    async (_name, overrides) => {
      const input = admissionInput(overrides);
      await expect(admitScenario(input)).rejects.toThrow(/execution.*authority/);
    },
  );
});
