export type SemanticVerdict = 'PASSED' | 'FAILED';

export function workflowExitCode(verdict: SemanticVerdict, workflowSucceeded: boolean): 0 | 1 {
  if (verdict !== 'PASSED' && verdict !== 'FAILED') {
    throw new TypeError('semantic verdict is unknown');
  }
  if (typeof workflowSucceeded !== 'boolean')
    throw new TypeError('workflow result must be boolean');
  return verdict === 'PASSED' && workflowSucceeded ? 0 : 1;
}
