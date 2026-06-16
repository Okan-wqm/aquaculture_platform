// WHY: react-smooth (recharts' animation engine, v4.0.4) ships no type
// declarations, so `typeof import('react-smooth')` in test-setup.ts is an
// implicit `any` under the changed-files type-check guard (TS7016). recharts
// imports it as `import Animate from 'react-smooth'` (default) plus a few
// named helpers. WHAT: declare the minimal surface our test mock spreads over,
// so the React-19 test-setup mock is fully typed without `any`/ts-ignore.
declare module 'react-smooth' {
  import type { ComponentType, ReactNode } from 'react';

  type AnimateChildren =
    | ReactNode
    | ((style: Record<string, unknown>) => ReactNode);

  const Animate: ComponentType<{
    children?: AnimateChildren;
    isActive?: boolean;
    [prop: string]: unknown;
  }>;
  export default Animate;

  export const AnimateGroup: ComponentType<{
    children?: ReactNode;
    [prop: string]: unknown;
  }>;
  export function configBezier(...args: unknown[]): (input: number) => number;
  export function configSpring(
    config?: Record<string, unknown>,
  ): (input: number) => number;
}
