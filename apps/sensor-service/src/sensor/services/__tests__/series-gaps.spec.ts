import { gapsIn } from '../channel-reading-query.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = new Date('2026-09-16T00:00:00Z');

/** Buckets of `width` starting at the given offsets (minutes from START). */
const buckets = (width: number, offsets: number[]): Array<{ bucket: Date; bucketEnd: Date }> =>
  offsets.map((minutes) => {
    const bucket = new Date(START.getTime() + minutes * MINUTE);
    return { bucket, bucketEnd: new Date(bucket.getTime() + width) };
  });

const range = (hours: number) => ({ start: START, end: new Date(START.getTime() + hours * HOUR) });

describe('gapsIn — where a channel went quiet, by its own rhythm', () => {
  it('reports a missing stretch on a channel that fills every bucket', () => {
    const quarter = 15 * MINUTE;
    const offsets = [0, 15, 30, 45, 120, 135, 150, 165];
    expect(gapsIn(buckets(quarter, offsets), range(3))).toEqual([
      {
        start: new Date(START.getTime() + 60 * MINUTE),
        end: new Date(START.getTime() + 120 * MINUTE),
      },
    ]);
  });

  it('does not call a slow channel quiet for filling every other bucket', () => {
    const quarter = 15 * MINUTE;
    const everyHalfHour = Array.from({ length: 12 }, (_, index) => index * 30);
    expect(gapsIn(buckets(quarter, everyHalfHour), range(6))).toEqual([]);
  });

  it('still reports a real outage on a slow channel', () => {
    const quarter = 15 * MINUTE;
    const offsets = [0, 30, 60, 90, 450, 480, 510, 540];
    const gaps = gapsIn(buckets(quarter, offsets), range(9.25));
    expect(gaps).toEqual([
      {
        start: new Date(START.getTime() + 105 * MINUTE),
        end: new Date(START.getTime() + 450 * MINUTE),
      },
    ]);
  });

  it('treats a 25-hour local day as one step, not a gap', () => {
    const days = [
      { bucket: new Date('2025-10-24T22:00:00Z'), bucketEnd: new Date('2025-10-25T22:00:00Z') },
      { bucket: new Date('2025-10-25T22:00:00Z'), bucketEnd: new Date('2025-10-26T23:00:00Z') },
      { bucket: new Date('2025-10-26T23:00:00Z'), bucketEnd: new Date('2025-10-27T23:00:00Z') },
    ];
    expect(
      gapsIn(days, {
        start: new Date('2025-10-24T22:00:00Z'),
        end: new Date('2025-10-27T23:00:00Z'),
      }),
    ).toEqual([]);
  });

  it('reports the whole range for a channel with no data', () => {
    expect(gapsIn([], range(1))).toEqual([range(1)]);
  });
});
