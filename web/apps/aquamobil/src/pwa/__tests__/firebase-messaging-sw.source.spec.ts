/**
 * firebase-messaging-sw.js source invariant — FE-CRITICAL-050-SW / FE-HIGH-057.
 *
 * The FCM service worker is a STATIC file (public/firebase-messaging-sw.js) that
 * cannot read import.meta.env. It previously initialised Firebase from
 * `self.__FIREBASE_CONFIG__`, a global the app NEVER set (the app posted the
 * config to the workbox SW, not this one), so initializeApp always received
 * undefined and FCM never worked.
 *
 * The fix reads config from THIS worker's own registration URL query params,
 * which useFirebaseMessaging now supplies. These assertions lock that contract
 * and the badge-on-push behaviour in place. They are Tier-3 "make it detectable"
 * guards: reverting to the `__FIREBASE_CONFIG__` global, or dropping the
 * query-param parse / badge update, turns this RED.
 *
 * Source-level (not runtime): the file uses importScripts() to load the hosted
 * Firebase SDK, which is not loadable in jsdom. The deterministic, meaningful
 * thing to assert is the SW's own config + badge wiring in the source.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

const SW_PATH = resolve(__dirname, '../../../public/firebase-messaging-sw.js');
const source = readFileSync(SW_PATH, 'utf8');

describe('FE-CRITICAL-050-SW: firebase-messaging-sw.js config wiring', () => {
  it('reads Firebase config from the worker URL query params (not the dead __FIREBASE_CONFIG__ global)', () => {
    // The broken path must be gone entirely.
    expect(source).not.toContain('__FIREBASE_CONFIG__');
    // The fix parses self.location's searchParams.
    expect(source).toMatch(/new URL\(self\.location\.href\)\.searchParams/);
    // ...and feeds each config field from those params into initializeApp.
    expect(source).toMatch(/\.get\(['"]apiKey['"]\)/);
    expect(source).toMatch(/\.get\(['"]projectId['"]\)/);
    expect(source).toMatch(/\.get\(['"]messagingSenderId['"]\)/);
    expect(source).toMatch(/\.get\(['"]appId['"]\)/);
    expect(source).toMatch(/firebase\.initializeApp\(/);
  });

  it('drives the app badge from the push payload in onBackgroundMessage', () => {
    // Badge updates moved here with push (the workbox SW no longer has a push
    // handler). onBackgroundMessage must update the badge from the payload.
    expect(source).toMatch(/onBackgroundMessage/);
    expect(source).toMatch(/setAppBadge|clearAppBadge/);
    expect(source).toMatch(/updateBadgeCount/);
  });

  it('keeps the FE-HIGH-009 notification-URL allowlist guard', () => {
    // The dual-SW change must not regress the existing security guard.
    expect(source).toMatch(/isAllowedNotificationUrl/);
    expect(source).toMatch(/ALLOWED_ORIGINS/);
  });

  it('navigates under the /mobile base, never the unrouted origin root', () => {
    // FE-CRITICAL-050-SW: AquaMobil is served behind `location /mobile/` and the
    // outer proxy strips the prefix, so SW-issued navigations MUST carry the
    // /mobile base. The bare `openWindow('/')` fallback the HEAD baseline shipped
    // lands on a path the proxy never routes to the app (a 404) — a tapped push
    // that goes nowhere is push that still does not work end to end.
    expect(source).toMatch(/const APP_BASENAME = '\/mobile'/);
    // The no-URL / blocked-URL fallback must open the app base, not bare '/'.
    expect(source).toMatch(/openWindow\(`\$\{APP_BASENAME\}\//);
    expect(source).not.toMatch(/openWindow\(\s*['"]\/['"]\s*\)/);
  });

  it('shows the notification with a real shipped icon under the /mobile base', () => {
    // FE-CRITICAL-050-SW: the HEAD baseline referenced `/icons/icon-192.png` and
    // `/icons/badge-72.png` — both unrouted (no /mobile prefix) AND non-existent
    // (the only PNGs shipped are icon-192x192.png / icon-512x512.png). The icon
    // must point at a real asset under the /mobile base; the numeric app badge is
    // driven by the Badge API (updateBadgeCount), not a non-existent badge image.
    expect(source).toMatch(/icon:\s*`\$\{APP_BASENAME\}\/icons\/icon-192x192\.png`/);
    expect(source).not.toMatch(/icon-192\.png/);
    expect(source).not.toMatch(/badge-72\.png/);
  });

  it('pins the Firebase SDK to an exact version (FE-HIGH-008, no ranges)', () => {
    expect(source).toMatch(/const FIREBASE_VERSION = '\d+\.\d+\.\d+'/);
    expect(source).not.toMatch(/firebasejs\/latest/);
  });
});
