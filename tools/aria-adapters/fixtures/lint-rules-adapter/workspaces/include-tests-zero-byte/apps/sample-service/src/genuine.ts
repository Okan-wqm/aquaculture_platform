export function one(): number {
  return 1;
}

export function run(expression: string): unknown {
  const wrapped = '(' + expression + ')';
  return eval(wrapped);
}
