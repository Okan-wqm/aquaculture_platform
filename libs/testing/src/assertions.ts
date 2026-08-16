/**
 * Fail-fast assertion helpers for tests.
 *
 * Jest matchers intentionally do not narrow values for TypeScript. These
 * helpers keep the runtime assertion and the static proof in one place, so
 * specs do not need non-null assertions or repeated casts at every access.
 */
export function defined<T>(
  value: T | null | undefined,
  description = 'Expected value to be defined',
): T {
  if (value === null || value === undefined) {
    throw new Error(description);
  }
  return value;
}

/** The structural part of a Jest mock used to read recorded invocations. */
export interface MockCallRecorder {
  readonly mock: {
    readonly calls: readonly (readonly unknown[])[];
  };
}

/**
 * Read one complete mock call with a fail-fast bounds check.
 *
 * Callers provide the expected tuple explicitly. The cast is centralized at
 * this test-only boundary instead of being repeated across every spec.
 */
export function mockCall<TArguments extends readonly unknown[]>(
  recorder: MockCallRecorder,
  callIndex = 0,
): TArguments {
  const call = defined(recorder.mock.calls[callIndex], `Expected mock call ${callIndex} to exist`);
  return call as TArguments;
}

/** Read one argument from a recorded mock call with bounds checks. */
export function mockCallArgument<TArgument>(
  recorder: MockCallRecorder,
  callIndex = 0,
  argumentIndex = 0,
): TArgument {
  const call = defined(recorder.mock.calls[callIndex], `Expected mock call ${callIndex} to exist`);
  const argument = defined(
    call[argumentIndex],
    `Expected argument ${argumentIndex} of mock call ${callIndex} to exist`,
  );
  return argument as TArgument;
}
