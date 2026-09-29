import { workflowExitCode } from '../src/kernel/verdict-propagation';

const verdictCases: readonly [
  verdict: Parameters<typeof workflowExitCode>[0],
  workflowSucceeded: boolean,
  expected: 0 | 1,
][] = [
  ['PASSED', true, 0],
  ['PASSED', false, 1],
  ['FAILED', true, 1],
  ['FAILED', false, 1],
];

describe('ARIA-AUDIT-026 positive verdict propagation invariant', () => {
  it.each(verdictCases)(
    'maps verdict=%s workflowSucceeded=%s to exit=%s',
    (verdict, succeeded, expected) => {
      expect(workflowExitCode(verdict, succeeded)).toBe(expected);
    },
  );

  it('rejects unknown verdicts instead of promoting transport success', () => {
    expect(() => {
      Reflect.apply(workflowExitCode, undefined, ['UNKNOWN', true]);
    }).toThrow(/verdict/);
    expect(() => {
      Reflect.apply(workflowExitCode, undefined, ['PASSED', 'false']);
    }).toThrow(/workflow/);
  });
});
