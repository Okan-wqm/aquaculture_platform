/**
 * Cursor Pagination Primitive — Unit Tests
 *
 * Covers the four public functions + the input normaliser:
 *   - encodeCursor / decodeCursor round-trip
 *   - decode rejects malformed input with BadRequestException
 *   - buildCursorResponse pagination math (hasNextPage,
 *     endCursor, drop-extra)
 *   - normaliseCursorInput clamping and caps
 */
import { BadRequestException } from '@nestjs/common';

import {
  buildCursorResponse,
  decodeCursor,
  DEFAULT_FIRST,
  DEFAULT_FIRST_CAP,
  encodeCursor,
  normaliseCursorInput,
  type CursorKeyedRow,
} from '../cursor';

function row(id: string, createdAt: string | Date): CursorKeyedRow {
  return { id, createdAt };
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips id + createdAt through base64url', () => {
    const original = row('11111111-1111-4111-8111-111111111111', new Date('2026-04-23T12:00:00Z'));
    const cursor = encodeCursor(original);
    // base64url is URL-safe — no `+` / `/` / `=` characters
    expect(cursor).not.toMatch(/[+/=]/);

    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe(original.id);
    expect(decoded.createdAt.toISOString()).toBe('2026-04-23T12:00:00.000Z');
  });

  it('accepts createdAt as either Date or ISO string on encode', () => {
    const asString = encodeCursor(row('a', '2026-01-01T00:00:00.000Z'));
    const asDate = encodeCursor(row('a', new Date('2026-01-01T00:00:00.000Z')));
    expect(asString).toBe(asDate);
  });

  it('decode throws BadRequestException on empty / null / non-string input', () => {
    expect(() => decodeCursor('')).toThrow(BadRequestException);
    expect(() => decodeCursor(null as unknown as string)).toThrow(BadRequestException);
    expect(() => decodeCursor(42 as unknown as string)).toThrow(BadRequestException);
  });

  it('decode throws on malformed JSON payload', () => {
    // A valid base64url of a non-JSON string
    const malformed = Buffer.from('not-json', 'utf8').toString('base64url');
    expect(() => decodeCursor(malformed)).toThrow(BadRequestException);
  });

  it('decode throws when required fields missing', () => {
    const missingId = Buffer.from(
      JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(missingId)).toThrow(BadRequestException);

    const missingCreatedAt = Buffer.from(JSON.stringify({ id: 'abc' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(missingCreatedAt)).toThrow(BadRequestException);
  });

  it('decode throws on invalid ISO timestamp', () => {
    const badTs = Buffer.from(JSON.stringify({ id: 'a', createdAt: 'nope' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(badTs)).toThrow(BadRequestException);
  });

  it('fail-closed posture: never silent-fallback to page 1', () => {
    // Every malformed path above throws — there is no silent
    // fallback path. The reason: a silent fallback would bury
    // client bugs under unexpected-page behaviour that looks
    // like data loss. This test is the canary against a
    // future regression that adds such a fallback "to be
    // helpful".
    expect(() => decodeCursor('garbage')).toThrow(BadRequestException);
    // Any parse that reaches the JSON step but fails structural
    // validation also throws. `decodeCursor` has zero return
    // paths that are not either a valid CursorPayload or a
    // BadRequestException.
  });
});

describe('buildCursorResponse', () => {
  const rows = [
    row('1', '2026-04-23T12:00:00Z'),
    row('2', '2026-04-23T11:00:00Z'),
    row('3', '2026-04-23T10:00:00Z'),
    row('4', '2026-04-23T09:00:00Z'),
  ];

  it('returns every row with hasNextPage=false when rows.length <= first', () => {
    const response = buildCursorResponse(rows, 10);
    expect(response.edges).toHaveLength(4);
    expect(response.pageInfo.hasNextPage).toBe(false);
    expect(response.pageInfo.endCursor).toBe(encodeCursor(rows[3]!));
  });

  it('drops the extra row and flags hasNextPage=true when rows.length > first', () => {
    // Caller's contract: fetch `first + 1` rows from the DB.
    // The extra row signals "more exists"; buildCursorResponse
    // drops it before returning.
    const response = buildCursorResponse(rows, 3);
    expect(response.edges).toHaveLength(3);
    expect(response.pageInfo.hasNextPage).toBe(true);
    expect(response.pageInfo.endCursor).toBe(encodeCursor(rows[2]!));
    // Ensure the 4th row is NOT in the returned edges — it's
    // the signal-only row, not a page member.
    expect(response.edges.some((e) => e.node.id === '4')).toBe(false);
  });

  it('returns empty response shape for empty rows', () => {
    const response = buildCursorResponse([], 20);
    expect(response.edges).toEqual([]);
    expect(response.pageInfo.hasNextPage).toBe(false);
    expect(response.pageInfo.endCursor).toBeNull();
  });

  it('each edge carries the cursor for that exact node (not the next one)', () => {
    const response = buildCursorResponse(rows.slice(0, 2), 10);
    expect(response.edges[0]!.cursor).toBe(encodeCursor(rows[0]!));
    expect(response.edges[1]!.cursor).toBe(encodeCursor(rows[1]!));
  });
});

describe('normaliseCursorInput', () => {
  it('undefined input → DEFAULT_FIRST with no after cursor', () => {
    const { first, after } = normaliseCursorInput(undefined);
    expect(first).toBe(DEFAULT_FIRST);
    expect(after).toBeNull();
  });

  it('null input is treated the same as undefined', () => {
    const { first, after } = normaliseCursorInput(null);
    expect(first).toBe(DEFAULT_FIRST);
    expect(after).toBeNull();
  });

  it('omitted first → DEFAULT_FIRST', () => {
    const { first } = normaliseCursorInput({ after: undefined });
    expect(first).toBe(DEFAULT_FIRST);
  });

  it('decoded after carries the cursor payload', () => {
    const cursor = encodeCursor(row('xyz', '2026-04-23T12:00:00Z'));
    const { first, after } = normaliseCursorInput({ first: 5, after: cursor });
    expect(first).toBe(5);
    expect(after?.id).toBe('xyz');
    expect(after?.createdAt.toISOString()).toBe('2026-04-23T12:00:00.000Z');
  });

  it('first > DEFAULT_FIRST_CAP throws BadRequestException', () => {
    expect(() => normaliseCursorInput({ first: DEFAULT_FIRST_CAP + 1 })).toThrow(
      BadRequestException,
    );
  });

  it('caller-supplied firstCap tightens the default cap', () => {
    // A resolver that's heavy per row (document metadata,
    // analytics rollups) passes a tighter cap. The primitive
    // enforces the stricter of the two.
    expect(() => normaliseCursorInput({ first: 60 }, 50)).toThrow(BadRequestException);
    // Still OK at the tighter cap.
    const { first } = normaliseCursorInput({ first: 50 }, 50);
    expect(first).toBe(50);
  });

  it('first < 1 throws BadRequestException', () => {
    expect(() => normaliseCursorInput({ first: 0 })).toThrow(BadRequestException);
    expect(() => normaliseCursorInput({ first: -5 })).toThrow(BadRequestException);
  });

  it('fractional first throws BadRequestException', () => {
    expect(() => normaliseCursorInput({ first: 1.5 })).toThrow(BadRequestException);
  });

  it('malformed after propagates the decodeCursor BadRequestException', () => {
    expect(() => normaliseCursorInput({ first: 10, after: 'not-a-cursor' })).toThrow(
      BadRequestException,
    );
  });
});

describe('DEFAULT constants', () => {
  it('DEFAULT_FIRST = 20 and DEFAULT_FIRST_CAP = 100', () => {
    // Canary — these values are publicly exported and resolver
    // defaults depend on them. Renaming / renumbering without
    // touching this test is a regression risk, so the canary
    // asserts the current platform-wide posture.
    expect(DEFAULT_FIRST).toBe(20);
    expect(DEFAULT_FIRST_CAP).toBe(100);
  });
});
