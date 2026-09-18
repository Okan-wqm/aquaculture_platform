import { validateEventBySubject } from '@platform/event-contracts';

describe('validateEventBySubject (SEC-HIGH-100 — 2026-08-23 scan №45)', () => {
  it('accepts a valid event for a compiled subject', () => {
    const result = validateEventBySubject('events.farm.BatchCreated', {
      eventId: '01234567-89ab-4def-8abc-0123456789ab',
      eventType: 'BatchCreated',
      timestamp: new Date().toISOString(),
      tenantId: '11111111-1111-1111-1111-111111111111',
      aggregateId: '01234567-89ab-4def-8abc-0123456789ab',
      aggregateType: 'Batch',
      version: 1,
      batchId: '01234567-89ab-4def-8abc-0123456789ab',
      name: 'Test Batch',
      species: 'Salmon',
      quantity: 1000,
      stockedAt: new Date().toISOString(),
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a malformed event on a compiled subject (anchored to the SUBJECT, not the payload claim)', () => {
    // eventType lies about being valid; the subject decides which schema runs
    const result = validateEventBySubject('events.farm.BatchCreated', {
      eventType: 'SomethingElse',
      notTheRightShape: true,
    });
    expect(result.valid).toBe(false);
  });

  it('passes through subjects with no compiled schema (known-unknown)', () => {
    const result = validateEventBySubject('events.unknown.NoSchemaYet', { anything: true });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object payloads on a compiled subject', () => {
    const result = validateEventBySubject('events.farm.BatchCreated', 'just-a-string');
    expect(result.valid).toBe(false);
  });
});
