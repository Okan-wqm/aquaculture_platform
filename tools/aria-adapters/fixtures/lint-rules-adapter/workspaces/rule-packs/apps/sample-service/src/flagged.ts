// Fixture for lint-rules-adapter: one deliberate finding per rule pack.
export function sameBranches(flag: boolean): number {
  if (flag) {
    return 1;
  } else {
    return 1;
  }
}

export function sameCondition(a: number): string {
  if (a > 1) {
    return 'big';
  } else if (a > 1) {
    return 'also big';
  }
  return 'small';
}

export function runUserExpression(expression: string): unknown {
  return eval('(' + expression + ')');
}
