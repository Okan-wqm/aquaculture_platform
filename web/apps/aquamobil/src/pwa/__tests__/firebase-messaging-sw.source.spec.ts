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

describe('MT-HIGH-050: firebase-messaging-sw.js active-user push gate', () => {
  it('learns the active session user from SET_ACTIVE_USER and clears it on LOGOUT', () => {
    // The SW must track the active session user via a SET_ACTIVE_USER message...
    expect(source).toMatch(/data\.type === 'SET_ACTIVE_USER'[\s\S]*?setActiveUser\(data\.userId\)/);
    // ...and clear it on LOGOUT so a logged-out device cannot show a user push.
    expect(source).toMatch(/data\.type === 'LOGOUT'[\s\S]*?clearActiveUser\(\)/);
  });

  it('encodes the gate decision: allow no-userId/matching, drop mismatched', () => {
    // The pure decision function must: allow an untargeted push (no userId),
    // and otherwise allow ONLY when the payload userId equals the active user.
    // Pinning the exact predicate body is a tier-3 guard — weakening it to e.g.
    // `return true` or dropping the equality check turns this RED.
    const gateBody = source.slice(
      source.indexOf('async function isPushForActiveUser'),
      source.indexOf('messaging.onBackgroundMessage'),
    );
    expect(gateBody).toMatch(/if \(!payloadUserId\) return true;/);
    expect(gateBody).toMatch(/return payloadUserId === active;/);
  });

  it('applies the gate inside onBackgroundMessage and suppresses a dropped push', () => {
    // The gate must run at the push entry point and short-circuit (no
    // showNotification) when the recipient is not the active user.
    const obm = source.slice(source.indexOf('messaging.onBackgroundMessage'));
    expect(obm).toMatch(/isPushForActiveUser\(notificationData\.userId\)\.then/);
    // A dropped push returns a resolved promise rather than showing a banner.
    expect(obm).toMatch(/if \(!allowed\)[\s\S]*?return Promise\.resolve\(\);/);
  });
});

describe('MSG-CRITICAL-056: firebase-messaging-sw.js data-only + durable active user', () => {
  it('persists the active user in the worker IndexedDB so it survives termination', () => {
    // In-memory activeUserId reset to null on cold start → legit pushes dropped.
    // The active user must be written to / read from IndexedDB.
    expect(source).toMatch(/indexedDB\.open\(/);
    expect(source).toMatch(/async function setActiveUser/);
    expect(source).toMatch(/async function clearActiveUser/);
    expect(source).toMatch(/async function getActiveUser/);
    // The SET_ACTIVE_USER / LOGOUT writes are kept alive past the event.
    expect(source).toMatch(/event\.waitUntil\(setActiveUser\(data\.userId\)\)/);
    expect(source).toMatch(/event\.waitUntil\(clearActiveUser\(\)\)/);
  });

  it('presents a data-only push from the data payload (title/body/badge), not a notification block', () => {
    const obm = source.slice(source.indexOf('messaging.onBackgroundMessage'));
    // Title/body read from data first (data-only messages carry no notification block).
    expect(obm).toMatch(/notificationData\.title \|\|/);
    expect(obm).toMatch(/notificationData\.body \|\|/);
    // MSG-MEDIUM-069: the badge count is read from data.badge, not the webpush field.
    expect(obm).toMatch(/Number\.parseInt\(notificationData\.badge/);
  });
});

describe('MSG-HIGH-069: firebase-messaging-sw.js notificationRef deep-link', () => {
  it('deep-links a chat push via its opaque notificationRef', () => {
    const click = source.slice(source.indexOf("addEventListener('notificationclick'"));
    // The ref is validated as a UUID and used to build the /messages?ref deep-link.
    expect(click).toMatch(/data\.notificationRef/);
    expect(click).toMatch(/UUID_PATTERN\.test\(rawRef\)/);
    expect(click).toMatch(/\/messages\?notificationRef=\$\{encodeURIComponent\(notificationRef\)\}/);
    // A focused window is handed the ref to resolve over its authenticated socket.
    expect(click).toMatch(/type: 'NAVIGATE_TO_NOTIFICATION_REF', notificationRef/);
  });
});
