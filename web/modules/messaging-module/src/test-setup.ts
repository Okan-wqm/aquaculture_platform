import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// RTL auto-cleanup: explicit (vitest globals are on, but farm-module's
// established pattern keeps it visible and independent of globals config).
afterEach(() => {
  cleanup();
});

// The chat room scrolls its message body to the bottom on new data; jsdom has
// no layout, so give Element.scrollTo a silent no-op instead of jsdom's
// not-implemented console error.
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = (): void => undefined;
}
