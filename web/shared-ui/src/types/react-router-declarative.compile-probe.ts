import type { NavigateFunction } from 'react-router';

import type { DeclarativeNavigateResult } from './react-router-declarative';

/** Compile-only proof for the BrowserRouter/MemoryRouter navigate overloads. */
export function assertDeclarativeNavigateContract(navigate: NavigateFunction): void {
  const pathResult: DeclarativeNavigateResult = navigate('/x');
  const deltaResult: DeclarativeNavigateResult = navigate(-1);

  void pathResult;
  void deltaResult;
}
