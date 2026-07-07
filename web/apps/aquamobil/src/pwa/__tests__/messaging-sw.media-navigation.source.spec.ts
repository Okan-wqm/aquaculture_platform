/**
 * messaging-sw.ts media-route source invariant — MSG-MEDIUM-073.
 *
 * MEDIA_PATTERN (/\/(messaging|media)\//) matches any path under /messaging/,
 * which is ALSO the SPA route for the messaging page. Without a navigation
 * guard, navigating to /mobile/messaging/… (a `navigate` request that returns
 * the app-shell HTML) was routed through the media StaleWhileRevalidate
 * strategy — caching the HTML document under the media cache and risking a
 * stale page. The fix excludes top-level navigations from the media branch.
 *
 * Source-level (like firebase-messaging-sw.source.spec): the module registers a
 * `fetch` listener and pulls in workbox at load, so it is not cleanly importable
 * under jsdom. The deterministic, meaningful assertion is that the media branch
 * carries the navigation guard.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

const SW_PATH = resolve(__dirname, '../messaging-sw.ts');
const source = readFileSync(SW_PATH, 'utf8');

describe('MSG-MEDIUM-073: messaging-sw media route excludes navigations', () => {
  it('guards the media branch against top-level navigations', () => {
    // The media StaleWhileRevalidate branch must require a non-navigation request.
    expect(source).toMatch(/event\.request\.mode\s*!==\s*'navigate'/);
  });

  it('keeps the media branch limited to GET requests', () => {
    expect(source).toMatch(/event\.request\.method\s*===\s*'GET'/);
  });

  it('still passes GraphQL POSTs straight through (no auth-response caching)', () => {
    // Regression guard: the security-critical GraphQL pass-through must stay.
    expect(source).toMatch(/GRAPHQL_PATTERN\.test/);
    expect(source).toContain("event.request.method === 'POST'");
  });

  it('catches a failed GraphQL passthrough fetch (no unhandled respondWith rejection)', () => {
    // A bare `respondWith(fetch(req))` rejects on any network blip and the
    // browser logs "FetchEvent.respondWith received an error: TypeError: Load
    // failed". The passthrough must .catch() the fetch and resolve to a
    // network-error Response so the SW stays quiet while the app's fetch still
    // fails (its offline queue / retry handles the real network problem).
    const graphqlBranch = source.slice(
      source.indexOf('GRAPHQL_PATTERN.test'),
      source.indexOf('MEDIA_PATTERN.test'),
    );
    expect(graphqlBranch).toMatch(/\.catch\(/);
    expect(graphqlBranch).toContain('Response.error()');
  });
});
