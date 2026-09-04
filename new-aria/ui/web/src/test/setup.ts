// Vitest setup: explicit cleanup because `globals: false` means Testing Library
// cannot register its own afterEach hook. sessionStorage is reset between tests
// so token state never leaks from one spec into the next.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});
