/**
 * Alarm decision-core twin (drift invariant).
 *
 * Drives the `@platform/alarm-core` wasm façade — i.e. the very same Rust kernel
 * (`crates/alarm-core`), compiled to WebAssembly — over the SAME
 * `libs/sensor-contracts/fixtures/alarm/decision-core.json` the Rust golden test
 * asserts. Byte-identical decision math on both legs is what makes the edge and
 * SCADA-runtime alarm engines incapable of drifting on the canonical semantics.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { evaluateCondition, isOutsideDeadband, delayElapsed, DEFAULT_EPSILON } from './index';

interface ConditionCase {
  name: string;
  operator: string;
  value: number;
  threshold: number;
  expected: boolean;
}
interface DeadbandCase {
  name: string;
  operator: string;
  value: number;
  threshold: number;
  deadband: number;
  expected: boolean;
}
interface DelayCase {
  name: string;
  elapsed_ms: number;
  delay_ms: number;
  expected: boolean;
}
interface Suite {
  epsilon?: number;
  condition: ConditionCase[];
  deadband: DeadbandCase[];
  delay: DelayCase[];
}

const FIXTURE = join(
  __dirname,
  '..',
  '..',
  'sensor-contracts',
  'fixtures',
  'alarm',
  'decision-core.json',
);

const suite: Suite = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const epsilon = suite.epsilon ?? DEFAULT_EPSILON;

describe('alarm-core wasm façade — decision fixture parity', () => {
  it('default epsilon matches the fixture epsilon', () => {
    expect(DEFAULT_EPSILON).toBeCloseTo(epsilon, 12);
  });

  it.each(suite.condition.map((c) => [c.name, c] as const))(
    'condition %s',
    (_name, c) => {
      expect(evaluateCondition(c.operator, c.value, c.threshold, epsilon)).toBe(c.expected);
    },
  );

  it.each(suite.deadband.map((c) => [c.name, c] as const))(
    'deadband %s',
    (_name, c) => {
      expect(isOutsideDeadband(c.operator, c.value, c.threshold, c.deadband)).toBe(c.expected);
    },
  );

  it.each(suite.delay.map((c) => [c.name, c] as const))(
    'delay %s',
    (_name, c) => {
      expect(delayElapsed(c.elapsed_ms, c.delay_ms)).toBe(c.expected);
    },
  );
});

// NaN cannot be encoded in the shared JSON fixture, so its fail-safe contract is
// pinned here (and by the twin Rust unit test `nan_value_is_fail_safe`) so the
// two engines stay aligned on a garbage sample.
describe('alarm-core wasm façade — NaN is fail-safe', () => {
  it('raises no condition for a NaN reading (every operator)', () => {
    for (const op of ['<', '>', '<=', '>=', '==', '!=']) {
      expect(evaluateCondition(op, NaN, 50.0, epsilon)).toBe(false);
    }
  });

  it('never clears an active alarm on a NaN reading', () => {
    expect(isOutsideDeadband('>', NaN, 50.0, 2.0)).toBe(false);
    expect(isOutsideDeadband('==', NaN, 50.0, 2.0)).toBe(false);
  });
});
