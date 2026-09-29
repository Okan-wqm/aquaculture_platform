import { createTrustedCompletionContext } from '../src/application/trusted-completion-context';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { MemoryCheckpointStore } from './memory-checkpoint-store-fixture';

describe('trusted checkpoint context capability', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('rejects structural and copied checkpoint stores', () => {
    const input = admissionInput().context_input;
    expect(() =>
      createTrustedCompletionContext({
        ...input,
        checkpoint_store: new MemoryCheckpointStore(),
      }),
    ).toThrow(/trusted checkpoint/i);
    expect(() =>
      createTrustedCompletionContext({
        ...input,
        checkpoint_store: {
          compareAndSet: input.checkpoint_store.compareAndSet.bind(input.checkpoint_store),
        },
      }),
    ).toThrow(/trusted checkpoint/i);
  });
});
