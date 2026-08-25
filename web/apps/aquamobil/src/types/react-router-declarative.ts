import type { NavigateOptions, To } from 'react-router';

export type DeclarativeNavigateResult = ReturnType<() => void>;

/** AquaMobil is standalone and cannot consume shared-ui's type augmentation. */
declare module 'react-router' {
  interface NavigateFunction {
    (to: To, options?: NavigateOptions): void;
    (delta: number): void;
  }
}
