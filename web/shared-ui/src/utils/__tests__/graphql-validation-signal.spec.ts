/**
 * The GraphQL validation-failure signal (FE-MEDIUM-380, PKG-42). A document the router refuses
 * with GRAPHQL_VALIDATION_FAILED is the mark of a tab whose bundle predates a BREAKING schema
 * release; the shell's build-skew check listens for it. The signal lives in shared-ui, a
 * federation singleton, so a failure in any remote reaches the one listener the shell holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let signal: typeof import('../graphql-validation-signal');

describe('graphql-validation-signal', () => {
  beforeEach(async () => {
    vi.resetModules();
    signal = await import('../graphql-validation-signal');
  });

  it('notifies every listener when a response carries GRAPHQL_VALIDATION_FAILED', () => {
    const first = vi.fn();
    const second = vi.fn();
    signal.onGraphqlValidationFailure(first);
    signal.onGraphqlValidationFailure(second);

    signal.reportGraphqlErrors([
      {
        message: 'Cannot query field "ownerModule"',
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      },
    ]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('finds the code on any error of the response, once per response', () => {
    const listener = vi.fn();
    signal.onGraphqlValidationFailure(listener);

    signal.reportGraphqlErrors([
      { message: 'denied', extensions: { code: 'FORBIDDEN' } },
      { message: 'unknown field', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
      { message: 'unknown argument', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
    ]);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stays silent for every other error', () => {
    const listener = vi.fn();
    signal.onGraphqlValidationFailure(listener);

    signal.reportGraphqlErrors([
      { message: 'denied', extensions: { code: 'FORBIDDEN' } },
      { message: 'bad input', extensions: { code: 'BAD_USER_INPUT' } },
      { message: 'no extensions' },
    ]);

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying a listener once it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = signal.onGraphqlValidationFailure(listener);
    unsubscribe();

    signal.reportGraphqlErrors([
      { message: 'x', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
    ]);

    expect(listener).not.toHaveBeenCalled();
  });
});
