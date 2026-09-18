#!/usr/bin/env node
/**
 * AquaMobil end-to-end validator — the "does data actually flow" gate.
 *
 * POLICY (2026-09-17, user directive: "her zaman uçtan uca validate"):
 *   DEFAULT (safe):  auth (login) + READ paths against the real gateway.
 *   --with-write:    additionally exercises CREATE → UPDATE → ARCHIVE on a
 *                    feeding protocol named `E2E-VALIDATE-<ts>` (cleaned up by
 *                    the archive step; also regression-tests the ProtocolFcrSource
 *                    enum wire format — it creates with fcrSource: MATRIX).
 *
 * Usage:
 *   node scripts/validate-e2e.mjs \
 *     --base https://89.38.97.90:8443 --email a@b.c --password secret \
 *     [--with-write]
 *
 * Self-signed gateways: run with
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/validate-e2e.mjs ...
 * (the droplet's 8443 endpoint presents a self-signed certificate; curl -k
 * equivalence. Never set this env outside the validation invocation.)
 *
 * Exit code 0 = all gates passed; anything else prints the failing gate.
 * No external dependencies (node >= 18 fetch).
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const BASE = opt('--base', 'https://89.38.97.90:8443').replace(/\/$/, '');
const EMAIL = opt('--email', '');
const PASSWORD = opt('--password', '');
const WITH_WRITE = flag('--with-write');
const INSECURE = BASE.startsWith('https://') ? [] : []; // TLS verified by default

if (!EMAIL || !PASSWORD) {
  console.error('usage: validate-e2e.mjs --base <url> --email <e> --password <p> [--with-write]');
  process.exit(2);
}

const results = [];
const gate = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function gql(query, variables, token, tenant) {
  const res = await fetch(`${BASE}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Id': tenant } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`HTTP ${res.status}, non-JSON body`);
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join(' | '));
  return json.data;
}

function tenantFromJwt(token) {
  const p = token.split('.')[1];
  return JSON.parse(Buffer.from(p + '='.repeat(-p.length % 4), 'base64url').toString())
    .tenantId;
}

// ── Gate 1: auth ────────────────────────────────────────────────────────────
let token, tenant;
try {
  const data = await gql(
    `mutation Login($input: LoginInput!) { login(input: $input) { accessToken user { email } } }`,
    { input: { email: EMAIL, password: PASSWORD } },
  );
  token = data.login.accessToken;
  tenant = tenantFromJwt(token);
  gate('auth: login issues a token', true, `user=${data.login.user.email} tenant=${tenant}`);
} catch (e) {
  gate('auth: login issues a token', false, e.message);
  process.exit(1);
}

// ── Gate 2: read ────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
try {
  const data = await gql(
    `query E2EPlans($planDate: String!) { feedingDayPlans(planDate: $planDate) { id unitName status mealsPlanned } }`,
    { planDate: today },
    token,
    tenant,
  );
  gate(
    'read: feedingDayPlans responds',
    Array.isArray(data.feedingDayPlans),
    `${data.feedingDayPlans.length} plan(s) for ${today}`,
  );
} catch (e) {
  gate('read: feedingDayPlans responds', false, e.message);
}

if (WITH_WRITE) {
  // Resolve a REAL tenant feed first — the protocol resolver refuses unknown
  // feed ids, so the validator adapts to whatever data the tenant actually has.
  let feedId;
  try {
    const data = await gql(`{ feeds { items { id name } total } }`, undefined, token, tenant);
    feedId = data.feeds.items[0]?.id;
    gate('write: tenant has a feed to bind', !!feedId, data.feeds.items[0]?.name ?? 'none');
  } catch (e) {
    gate('write: tenant has a feed to bind', false, e.message);
  }
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const name = `E2E-VALIDATE-${ts}`;
  const input = {
    name,
    bands: [
      {
        // Shape mirrors ProtocolBandInput exactly — feedCode/feedName are
        // OUTPUT-only fields (the resolver enriches them from the feed table).
        minWeightG: 0,
        maxWeightG: 5000,
        feedId,
        feedingRatePercent: 1,
        expectedFcr: 1.2,
      },
    ],
    defaultMealSchedule: {
      mealsPerDay: 1,
      entries: [{ time: '08:00', percentOfDaily: 100 }],
    },
    // fcrSource=MATRIX requires a matrix (domain rule) — a minimal valid one.
    fcrMatrix: { temperatures: [10], weights: [100], fcrValues: [[1.2]] },
    settings: { fcrSource: 'MATRIX' },
  };
  let id;
  if (feedId) try {
    const data = await gql(
      `mutation E2ECreate($input: CreateFeedingProtocolV2Input!) { createFeedingProtocolV2(input: $input) { id settings } }`,
      { input },
      token,
      tenant,
    );
    id = data.createFeedingProtocolV2.id;
    gate('write: create protocol (fcrSource=MATRIX)', !!id, `id=${id}`);
  } catch (e) {
    gate('write: create protocol (fcrSource=MATRIX)', false, e.message);
  }
  if (id) {
    // update + archive
    try {
      const data = await gql(
        `mutation E2EUpdate($input: UpdateFeedingProtocolV2Input!) { updateFeedingProtocolV2(input: $input) { id name } }`,
        { input: { ...input, id, name: name + '-updated' } },
        token,
        tenant,
      );
      gate('write: update protocol', data.updateFeedingProtocolV2.name.endsWith('-updated'));
    } catch (e) {
      gate('write: update protocol', false, e.message);
    }
    try {
      await gql(`mutation E2EArchive($id: ID!) { archiveFeedingProtocolV2(id: $id) { id status } }`, { id }, token, tenant);
      gate('write: archive protocol (cleanup)', true);
    } catch (e) {
      gate('write: archive protocol (cleanup)', false, e.message);
    }
  }
} else {
  console.log('skip write gates (pass --with-write to exercise create/update/archive)');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL GATES PASSED' : failed.length + ' GATE(S) FAILED'}`);
process.exit(failed.length === 0 ? 0 : 1);
