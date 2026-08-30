import { OUTBOX_OPTIONS } from '../constants';
import { OutboxEntityBase } from '../outbox-entity.base';
import { OutboxModule } from '../outbox.module';

class TestOutbox extends OutboxEntityBase {}

function registeredOptions(registration: ReturnType<typeof OutboxModule.forFeature>): unknown {
  const provider = registration.providers?.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'provide' in candidate &&
      candidate.provide === OUTBOX_OPTIONS,
  );
  if (!provider || typeof provider !== 'object' || !('useValue' in provider)) {
    throw new Error('OutboxModule did not register OUTBOX_OPTIONS');
  }
  return provider.useValue;
}

describe('OutboxModule feature capabilities', () => {
  it('denies privileged routing and recovery capabilities by default', () => {
    expect(registeredOptions(OutboxModule.forFeature(TestOutbox))).toEqual({
      allowSystemRouting: false,
      allowSecurityRecovery: false,
    });
  });

  it('preserves both explicit auth-owned capabilities in the DI provider', () => {
    expect(
      registeredOptions(
        OutboxModule.forFeature(TestOutbox, {
          allowSystemRouting: true,
          allowSecurityRecovery: true,
        }),
      ),
    ).toEqual({
      allowSystemRouting: true,
      allowSecurityRecovery: true,
    });
  });
});
