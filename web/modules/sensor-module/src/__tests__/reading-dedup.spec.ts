import { isDuplicateReading, resetReadingDedup } from '../hooks/reading-dedup';

describe('reading-dedup — reconnect-window deduplication (Task 1.5)', () => {
  beforeEach(() => {
    resetReadingDedup();
  });

  it('suppresses a re-delivered eventId inside the window', () => {
    const reading = { eventId: 'aaaa' };
    expect(isDuplicateReading(reading, 1_000)).toBe(false);
    expect(isDuplicateReading(reading, 2_000)).toBe(true);
  });

  it('never suppresses distinct events, even back-to-back', () => {
    expect(isDuplicateReading({ eventId: 'a' }, 1_000)).toBe(false);
    expect(isDuplicateReading({ eventId: 'b' }, 1_001)).toBe(false);
  });

  it('forgets an id once the window has passed', () => {
    const reading = { eventId: 'a' };
    expect(isDuplicateReading(reading, 1_000)).toBe(false);
    expect(isDuplicateReading(reading, 1_000 + 5 * 60_000 + 1)).toBe(false);
  });

  it('passes payloads without identity through (pre-1.4 backcompat)', () => {
    expect(isDuplicateReading({}, 1_000)).toBe(false);
    expect(isDuplicateReading({}, 2_000)).toBe(false);
  });

  it('bounds tracked ids (no unbounded growth under a flood)', () => {
    for (let i = 0; i < 1_500; i++) {
      isDuplicateReading({ eventId: `ev-${i}` }, 1_000 + i);
    }
    // The earliest ids were evicted; a fresh id still registers fine and the
    // very first one is no longer remembered as duplicate.
    expect(isDuplicateReading({ eventId: 'ev-0' }, 2_000)).toBe(false);
    expect(isDuplicateReading({ eventId: 'ev-1' }, 2_000)).toBe(false);
    expect(isDuplicateReading({ eventId: 'ev-1' }, 2_001)).toBe(true);
  });
});
