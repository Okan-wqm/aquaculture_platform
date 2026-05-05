/**
 * useErrorMessage / parseGraphQLError tests
 */
import { describe, it, expect } from 'vitest';

import {
  parseGraphQLError,
  formatErrorForToast,
} from '../useErrorMessage';

describe('parseGraphQLError', () => {
  it('maps BATCH_WITHDRAWAL_BLOCKED to the curated Turkish copy', () => {
    const err = {
      response: {
        errors: [
          {
            message: 'raw server message',
            extensions: { code: 'BATCH_WITHDRAWAL_BLOCKED' },
          },
        ],
      },
    };
    const parsed = parseGraphQLError(err);
    expect(parsed.code).toBe('BATCH_WITHDRAWAL_BLOCKED');
    expect(parsed.message).toContain('ilaç kesintisi');
  });

  it('maps FEED_ASSIGNMENT_IN_USE + METER_READING_NOT_INCREASING + AUTO_GENERATE_THROTTLED', () => {
    for (const code of [
      'FEED_ASSIGNMENT_IN_USE',
      'METER_READING_NOT_INCREASING',
      'AUTO_GENERATE_THROTTLED',
    ]) {
      const parsed = parseGraphQLError({
        response: { errors: [{ extensions: { code } }] },
      });
      expect(parsed.code).toBe(code);
      // Curated message is non-empty and NOT the raw code.
      expect(parsed.message.length).toBeGreaterThan(0);
      expect(parsed.message).not.toBe(code);
    }
  });

  it('falls back to extensions.userMessage when code is unknown', () => {
    const parsed = parseGraphQLError({
      response: {
        errors: [
          {
            message: 'top-level message',
            extensions: {
              code: 'SOME_NEW_CODE_WE_DONT_KNOW_YET',
              userMessage: 'Sunucu-yan Türkçe mesaj.',
            },
          },
        ],
      },
    });
    expect(parsed.code).toBe('SOME_NEW_CODE_WE_DONT_KNOW_YET');
    expect(parsed.message).toBe('Sunucu-yan Türkçe mesaj.');
  });

  it('falls back to the top-level error message when no userMessage', () => {
    const parsed = parseGraphQLError({
      response: {
        errors: [
          {
            message: 'bare server error',
            extensions: { code: 'UNMAPPED_CODE' },
          },
        ],
      },
    });
    expect(parsed.message).toBe('bare server error');
  });

  it('handles errors without extensions at all (network / non-GraphQL)', () => {
    const parsed = parseGraphQLError({
      message: 'Network request failed',
    });
    expect(parsed.code).toBeUndefined();
    expect(parsed.message).toBe('Network request failed');
  });

  it('returns a safe fallback for null / undefined / weird shapes', () => {
    expect(parseGraphQLError(null).message).toBeTruthy();
    expect(parseGraphQLError(undefined).message).toBeTruthy();
    expect(parseGraphQLError({}).message).toBeTruthy();
    expect(parseGraphQLError(42).message).toBeTruthy();
  });

  it('surfaces extensions so callers can inspect structured payloads', () => {
    const parsed = parseGraphQLError({
      response: {
        errors: [
          {
            message: 'raw',
            extensions: {
              code: 'BATCH_WITHDRAWAL_BLOCKED',
              activeTreatments: [{ id: 'tx-1' }, { id: 'tx-2' }],
            },
          },
        ],
      },
    });
    expect(parsed.extensions?.activeTreatments).toEqual([
      { id: 'tx-1' },
      { id: 'tx-2' },
    ]);
  });
});

describe('formatErrorForToast', () => {
  it('returns just the user-facing string', () => {
    const msg = formatErrorForToast({
      response: {
        errors: [
          { extensions: { code: 'BATCH_NOT_FOUND' }, message: 'raw' },
        ],
      },
    });
    expect(msg).toContain('Parti bulunamadı');
  });
});
