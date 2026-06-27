interface JestLiteMatchers {
  readonly not: JestLiteMatchers;
  toBe(expected: unknown): void;
  toContain(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeDefined(): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeUndefined(): void;
  toHaveLength(expected: number): void;
}

interface JestLiteEach {
  <T extends readonly unknown[]>(
    cases: readonly T[],
  ): (name: string, fn: (...args: T) => void | Promise<void>) => void;
  <T>(
    cases: readonly T[],
  ): (name: string, fn: (arg: T) => void | Promise<void>) => void;
}

interface JestLiteIt {
  (name: string, fn: () => void | Promise<void>): void;
  readonly each: JestLiteEach;
}

declare const describe: (name: string, fn: () => void) => void;
declare const it: JestLiteIt;
declare const expect: (actual: unknown) => JestLiteMatchers;
