import {
  CHANNEL_BINDING_PROBLEMS,
  PARAMETER_SOURCE_ERROR,
  type ParameterSourceErrorCode,
} from '@aquaculture/shared-contracts';
import { describe, expect, it } from 'vitest';

import type { CoherenceWindow } from '../../../generated/graphql-types';
import { en, type MessageKey } from '../../../i18n/locales/en';
import { tr } from '../../../i18n/locales/tr';
import {
  bindingRefusal,
  errorText,
  PARAMETER_SOURCE_ERROR_CODES,
  PROBLEM_FIX,
  problemText,
  SOURCE_PROBLEM_CODES,
} from '../problems';

const PROBLEM_OWNERS = new Set(['parameter', 'channel', 'sensor', 'source', 'system']);

/** A translate over one locale map, as the provider does it. */
function translator(messages: Record<MessageKey, string>) {
  return (key: MessageKey, vars?: Record<string, string | number>): string =>
    Object.entries(vars ?? {}).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      messages[key],
    );
}

describe('the problem vocabulary', () => {
  it('covers every channel-binding problem the shared contract reports', () => {
    for (const code of CHANNEL_BINDING_PROBLEMS) {
      expect(SOURCE_PROBLEM_CODES).toContain(code);
    }
  });

  it.each(SOURCE_PROBLEM_CODES)(
    '%s has an owner that fixes it and English and Turkish text',
    (code) => {
      expect(PROBLEM_OWNERS.has(PROBLEM_FIX[code])).toBe(true);
      const key: MessageKey = `wqSource.problem.${code}`;
      expect(en[key].length).toBeGreaterThan(0);
      expect(tr[key].length).toBeGreaterThan(0);
      expect(tr[key]).not.toBe(en[key]);
      expect(en[`wqSource.fix.${PROBLEM_FIX[code]}`].length).toBeGreaterThan(0);
    },
  );

  it.each(PARAMETER_SOURCE_ERROR_CODES)('refusal %s has English and Turkish text', (code) => {
    expect(errorText(translator(en), code)).toBe(en[`wqSource.error.${code}`]);
    expect(errorText(translator(tr), code)).toBe(tr[`wqSource.error.${code}`]);
    expect(tr[`wqSource.error.${code}`]).not.toBe(en[`wqSource.error.${code}`]);
  });

  it('words a problem in the current language', () => {
    expect(problemText(translator(tr), 'CHANNEL_DISABLED')).toBe('Kanal kapalı');
    expect(problemText(translator(en), 'NOT_AT_POINT')).toBe(
      'The sensor does not stand at this measurement point',
    );
  });
});

describe('coherence windows', () => {
  // A Record over the generated enum: a window added to the API fails here until worded.
  const WINDOWS: Record<CoherenceWindow, true> = { SHORT: true, DAILY: true, LONG: true };

  it.each(Object.keys(WINDOWS))('%s has English and Turkish text', (window) => {
    const key = `wqSource.window.${window}`;
    expect(Object.prototype.hasOwnProperty.call(en, key)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(tr, key)).toBe(true);
  });
});

describe('bindingRefusal', () => {
  /** A refusal as the shared client throws it (GraphQLClientError keeps the errors). */
  function clientError(extensions: Record<string, unknown>): Error & { graphqlErrors: unknown[] } {
    return Object.assign(new Error('refused'), {
      code: String(extensions.code),
      graphqlErrors: [{ message: 'refused', extensions }],
    });
  }

  it('reads the problems of a refused bind', () => {
    const refusal = bindingRefusal(
      clientError({
        code: 'CHANNEL_BINDING_REFUSED',
        context: { problems: ['CHANNEL_DISABLED', 'QUANTITY_MISMATCH', 'NOT_A_CODE'] },
      }),
    );
    expect(refusal).toEqual({
      code: 'CHANNEL_BINDING_REFUSED',
      problems: ['CHANNEL_DISABLED', 'QUANTITY_MISMATCH'],
      retryable: false,
    });
  });

  it.each(Object.values(PARAMETER_SOURCE_ERROR))('recognises the stable code %s', (code) => {
    const refusal = bindingRefusal(clientError({ code }));
    expect(refusal?.code).toBe(code);
    const retryable: ParameterSourceErrorCode[] = [
      'CONCURRENT_WRITE',
      'SENSOR_DIRECTORY_UNAVAILABLE',
    ];
    expect(refusal?.retryable).toBe(retryable.includes(code));
    expect(refusal?.problems).toEqual([]);
  });

  it('reads graphql-request errors too', () => {
    const error = Object.assign(new Error('x'), {
      response: { errors: [{ message: 'x', extensions: { code: 'SOURCE_CONFLICT' } }] },
    });
    expect(bindingRefusal(error)?.code).toBe('SOURCE_CONFLICT');
  });

  it('is null for errors that are not a parameter-source refusal', () => {
    expect(bindingRefusal(new Error('Unable to connect to server'))).toBeNull();
    expect(bindingRefusal(clientError({ code: 'FORBIDDEN' }))).toBeNull();
    expect(bindingRefusal(null)).toBeNull();
    expect(bindingRefusal('BACKEND_UNAVAILABLE')).toBeNull();
  });
});
