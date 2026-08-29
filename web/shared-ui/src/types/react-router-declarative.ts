import type { NavigateOptions, To } from 'react-router';

export type DeclarativeNavigateResult = ReturnType<() => void>;

/**
 * This product uses React Router's Declarative Mode (`BrowserRouter` and
 * `MemoryRouter`). In that mode navigate completes synchronously and returns
 * void; the Promise-returning overload belongs to Data/Framework Mode.
 */
declare module 'react-router' {
  interface NavigateFunction {
    (to: To, options?: NavigateOptions): void;
    (delta: number): void;
  }
}
