import { readdirSync } from 'node:fs';

import * as epochAdapter from '../src/adapters/file-current-epoch-provider';
import { checkpointIdentityFileName } from '../src/adapters/file-evidence-checkpoint-store';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { admitScenario } from './admission-transaction-fixture';

describe('completion admission external epoch invalidation', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('rejects D1 evidence when the external dependency epoch is already D2', async () => {
    const scenario = admissionInput();
    scenario.write_current_epochs({ revision: 2, dependency_sha256: 'a'.repeat(64) });

    await expect(admitScenario(scenario)).rejects.toThrow(/stale/i);
    expect(readdirSync(scenario.checkpoint_root)).toEqual([checkpointIdentityFileName]);
  });

  it('freshly rereads D2 immediately before CAS and leaves no completion checkpoint', async () => {
    const scenario = admissionInput();
    const readSnapshot = epochAdapter.readCurrentEpochSnapshot;
    let admissionReads = 0;
    jest.spyOn(epochAdapter, 'readCurrentEpochSnapshot').mockImplementation((...args) => {
      admissionReads += 1;
      if (admissionReads === 2) {
        scenario.write_current_epochs({ revision: 2, dependency_sha256: 'a'.repeat(64) });
      }
      return readSnapshot(...args);
    });

    await expect(admitScenario(scenario)).rejects.toThrow(/stale/i);
    expect(admissionReads).toBe(2);
    expect(readdirSync(scenario.checkpoint_root)).toEqual([checkpointIdentityFileName]);
  });

  it('propagates epoch expiry to CAS and rejects expiry before its first durable side effect', async () => {
    const scenario = admissionInput();
    scenario.write_current_epochs({
      revision: 2,
      valid_until: '2026-09-02T12:30:00.000Z',
    });
    const current = Date.parse('2026-09-02T12:30:00.000Z');
    const expired = current + 1;
    jest
      .spyOn(Date, 'now')
      .mockImplementation(() =>
        new Error().stack?.includes('compareAndSetBound') === true ? expired : current,
      );

    await expect(admitScenario(scenario)).rejects.toThrow(/checkpoint|fork|replay/i);
    expect(readdirSync(scenario.checkpoint_root)).toEqual([checkpointIdentityFileName]);
  });
});
