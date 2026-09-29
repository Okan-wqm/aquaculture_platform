import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { admitScenario } from './admission-transaction-fixture';

describe('execution stderr provenance at admission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('rejects signed negative-control stderr that is not the canonical failure object', async () => {
    const scenario = admissionInput({
      control_stderr_bytes: Buffer.from('attacker-selected stderr\n'),
    });

    await expect(admitScenario(scenario)).rejects.toThrow(/stderr|failure reason/i);
  });
});
