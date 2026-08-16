/**
 * Service Worker build-artifact invariant (FE-CRITICAL-050-SW)
 *
 * WHY THIS TEST EXISTS:
 * The finding FE-CRITICAL-050 flagged a service worker whose hand-written
 * handlers (background `sync`, `notificationclick`, the LOGOUT cache-purge
 * `message` handler) and precache manifest were ALL ABSENT from the deployed
 * artifact. Under the old VitePWA `generateSW` strategy, `src/pwa/messaging-sw.ts`
 * was never bundled; `dist/sw.js` was an auto-generated worker with ZERO of those
 * listeners, so `offline-queue.ts`'s `sync-operations` / `sync-messages`
 * registrations had no handler to run and queued operations never replayed in
 * the background.
 *
 * A unit test that imports the SW source cannot catch this class of bug — the
 * SOURCE was always correct; the BUILD threw it away. The only test that proves
 * the fix is one that runs the REAL `vite build` and inspects the REAL emitted
 * artifact. This is a Tier-3 "make it detectable" guard: if anyone reverts
 * vite.config.ts to `generateSW`, or renames/deletes the SW, or drops the sync
 * handler, this test goes RED at build time.
 *
 * It deliberately runs the full production build once (in beforeAll) and asserts
 * against `dist/messaging-sw.js` — the exact file `virtual:pwa-register`
 * registers (filename: 'messaging-sw.ts' → emitted as messaging-sw.js).
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect, beforeAll } from 'vitest';

const APP_DIR = resolve(__dirname, '../../..');
const VITE_BIN = resolve(APP_DIR, '../../../node_modules/.bin/vite');
const execFileAsync = promisify(execFile);
// FE-CRITICAL-050-SW: vite.config.ts sets filename: 'messaging-sw.ts', so the
// injectManifest sub-build emits dist/messaging-sw.js — NOT dist/sw.js. This is
// the file virtual:pwa-register registers; asserting against it is asserting
// against the artifact the browser actually runs.
const SW_ARTIFACT = resolve(APP_DIR, 'dist/messaging-sw.js');

// A production vite build (app + injectManifest SW sub-build) takes ~30s on a
// loaded CI runner. Give the one-time build a wide ceiling; the assertions
// themselves are instant.
const BUILD_TIMEOUT_MS = 300_000;

let swSource = '';

describe('FE-CRITICAL-050-SW: deployed service worker artifact', () => {
  beforeAll(async () => {
    // Run the REAL production build. `vite build` drives VitePWA's injectManifest
    // strategy, which compiles src/pwa/messaging-sw.ts through its own Vite
    // sub-build and injects the precache manifest into self.__WB_MANIFEST.
    // Keep the Vitest worker event loop available while Vite runs. A synchronous
    // child process blocks worker RPC long enough for the coordinator's
    // `onTaskUpdate` call to time out even when every assertion passes.
    await execFileAsync(VITE_BIN, ['build'], {
      cwd: APP_DIR,
      env: { ...process.env, NODE_ENV: 'production' },
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(existsSync(SW_ARTIFACT)).toBe(true);
    swSource = readFileSync(SW_ARTIFACT, 'utf8');
  }, BUILD_TIMEOUT_MS);

  it('emits the SW as dist/messaging-sw.js (injectManifest, not generateSW)', () => {
    // If the build reverted to generateSW, the emitted dist/sw.js would be a
    // workbox-generated shell and messaging-sw.js would not exist.
    expect(swSource.length).toBeGreaterThan(0);
  });

  it('contains a background "sync" event listener (the dead handler the finding flagged)', () => {
    // offline-queue.ts registers sync-operations / sync-messages tags. They are
    // inert without a deployed `sync` listener. Minifiers preserve the event
    // name string literal, so a tolerant regex over single/double quotes proves
    // addEventListener('sync', ...) survived into the artifact.
    const syncListener = /addEventListener\(\s*["']sync["']/.test(swSource);
    expect(syncListener).toBe(true);
  });

  it('responds to the sync-operations / sync-messages tags from offline-queue.ts', () => {
    // The tag strings the queue registers must appear in the worker so the sync
    // handler actually matches them. This binds the SW artifact to the queue's
    // registration contract (offline-queue.ts queueOperation()).
    expect(swSource).toContain('sync-operations');
    expect(swSource).toContain('sync-messages');
  });

  it('inlines the precache manifest (self.__WB_MANIFEST was substituted, not left as a placeholder)', () => {
    // After injectManifest substitution the literal `self.__WB_MANIFEST` token is
    // GONE — replaced by an array of { url, revision } entries. Presence of the
    // unsubstituted token would mean precaching is broken (the generateSW
    // artifact the finding flagged had no precache entries at all).
    expect(swSource).not.toContain('__WB_MANIFEST');
    // The substituted manifest is an array of precache entries each carrying a
    // `revision` field; at least one real entry must be present.
    expect(swSource).toMatch(/revision\s*:/);
    // And it must reference at least one content-hashed app asset (the app shell
    // bundle), proving the manifest is non-empty.
    expect(swSource).toMatch(/index-[A-Za-z0-9_-]+\.js/);
  });

  it('FE-HIGH-058: precaches the index.html app shell (cold-offline launch fallback)', () => {
    // The cold-offline fallback (PrecacheFallbackPlugin → index.html) is only
    // viable if index.html is actually IN the precache manifest. vite.config.ts
    // includes `html` in globPatterns for exactly this reason. If anyone drops
    // `html` from the globs, the manifest loses its index.html entry and a
    // first-ever offline launch goes blank again — this assertion catches that at
    // build time (Tier-3 make-it-detectable).
    expect(swSource).toMatch(/["']url["']\s*:\s*["']index\.html["']/);
  });

  it('FE-HIGH-058: registers the precache-bound navigation fallback (no blank cold-offline page)', () => {
    // The NetworkFirst nav route must carry a PrecacheFallbackPlugin bound to the
    // precached index.html so a navigation that misses BOTH network and runtime
    // cache serves the app shell. The minifier preserves the fallbackURL string
    // literal and the navigate-mode predicate, so both survive into the artifact.
    expect(swSource).toContain('index.html');
    // The navigation route still gates on navigate mode (no fallback for /graphql
    // or assets — those are claimed earlier by handleFetchEvent).
    expect(swSource).toMatch(/["']navigate["']/);
    // The PrecacheFallbackPlugin hooks handlerDidError; its presence in the
    // artifact proves the fallback wiring survived the build.
    expect(swSource).toContain('handlerDidError');
  });

  it('preserves the LOGOUT cache-purge message handler (used by useAuth.tsx logout)', () => {
    // C-FE-01: on shared devices, logout must purge messaging caches via a
    // postMessage({ type: 'LOGOUT' }). The handler and the cache-key prefix it
    // clears must both survive into the artifact.
    const messageListener = /addEventListener\(\s*["']message["']/.test(swSource);
    expect(messageListener).toBe(true);
    expect(swSource).toContain('LOGOUT');
    expect(swSource).toContain('messaging-');
  });

  it('preserves the notificationclick handler', () => {
    const clickListener = /addEventListener\(\s*["']notificationclick["']/.test(swSource);
    expect(clickListener).toBe(true);
  });

  it('MOB-MEDIUM-002: bundles the closed-app queue replay (cookie refresh + drain lock)', () => {
    // The sync handler must ship the REAL replay lane, not just the client
    // notification: the RefreshToken document (cookie-based token mint), the
    // shared Web Lock name serializing SW and foreground drains, and the
    // queued-mutation registry all have to survive into the artifact. If the
    // sw-replay import is dropped (or tree-shaken), background sync silently
    // degrades back to the notify-only no-op this finding flagged.
    expect(swSource).toContain('refreshToken');
    expect(swSource).toContain('aquamobil-queue-drain');
    // A representative registry document proves OPERATION_MUTATIONS bundled.
    expect(swSource).toContain('RecordMortality');
  });

  it('does NOT register a raw "push" listener (FCM owns push via firebase-messaging-sw.js — FE-HIGH-057)', () => {
    // Push for AquaMobil is delivered by FCM through firebase-messaging-sw.js's
    // onBackgroundMessage, NOT as a raw `push` event in this workbox worker. A
    // `push` listener here would be dead code. Asserting its ABSENCE keeps the
    // FE-HIGH-057 boundary explicit in the artifact.
    const rawPushListener = /addEventListener\(\s*["']push["']/.test(swSource);
    expect(rawPushListener).toBe(false);
  });
});
