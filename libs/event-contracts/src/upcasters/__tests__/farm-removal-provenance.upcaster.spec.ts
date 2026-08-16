import { createDefaultRegistry } from '../index';

describe('farm removal provenance v1 to v2 upcasters', () => {
  it.each(['MortalityRecorded', 'CullRecorded', 'BatchTransferred'] as const)(
    'preserves unknown provenance when upcasting historical %s',
    (eventType) => {
      const historical = {
        eventType,
        version: 1,
        eventId: 'event-1',
        tenantId: 'tenant-1',
        quantity: 12,
      };

      expect(createDefaultRegistry().upcast(historical)).toEqual({
        ...historical,
        version: 2,
      });
    },
  );

  it('preserves explicit derived provenance emitted by a v2 producer', () => {
    const current = {
      eventType: 'MortalityRecorded',
      version: 2,
      countDerived: true,
    };

    expect(createDefaultRegistry().upcast(current)).toEqual(current);
  });
});
