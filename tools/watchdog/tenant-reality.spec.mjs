/**
 * The probe decides who gets paged. Until now that decision had no test:
 * an adversarial review pointed out that inverting the ACTIVE and retired
 * branches would leave every check green. These pin the four verdicts that
 * matter and, more importantly, the two that must NOT fire.
 *
 * Run: npm run watchdog:test
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyTenantReality, parseTenantRealityRows } from './tenant-reality.mjs';

const active = (schemaExists, tableCount = schemaExists ? 42 : 0) => ({
  status: 'ACTIVE',
  schemaExists,
  tableCount,
});

test('a fully provisioned tenant is silent', () => {
  const verdict = classifyTenantReality([active(true)]);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.critical, false);
});

test('ACTIVE without a schema is CRITICAL — the shape found in production', () => {
  // Oceanfarm: served as fully provisioned, nowhere to put a row. It looks
  // healthy in the admin panel, which is what makes it the dangerous half.
  const verdict = classifyTenantReality([active(false)]);

  assert.equal(verdict.critical, true);
  assert.equal(verdict.counts.active_without_usable_schema, 1);
});

test('an empty schema counts as no schema', () => {
  // The shape a half-completed provisioning run leaves behind: the namespace
  // exists, so a naive existence check passes, and no table does.
  const verdict = classifyTenantReality([active(true, 0)]);

  assert.equal(verdict.critical, true);
  assert.equal(verdict.counts.active_without_usable_schema, 1);
});

test('a PENDING tenant without a schema is a warning, not a page', () => {
  // Suderra AS: provisioning stopped partway rather than claiming to have
  // finished. Worth fixing, not worth waking someone.
  const verdict = classifyTenantReality([
    { status: 'PENDING', schemaExists: false, tableCount: 0 },
  ]);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.critical, false);
  assert.equal(verdict.counts.unprovisioned_pending, 1);
});

test('a purged tenant with no schema is CORRECT and stays silent', () => {
  // The bug this test exists to prevent: counting a completed GDPR erasure as
  // "provisioning never finished" would page forever, and an alarm nobody can
  // honestly silence is one everybody learns to ignore.
  for (const status of ['PURGED', 'ARCHIVED', 'CANCELLED', 'DELETED']) {
    const verdict = classifyTenantReality([{ status, schemaExists: false, tableCount: 0 }]);

    assert.equal(verdict.ok, true, `${status} must be silent`);
    assert.equal(verdict.critical, false, `${status} must not page`);
  }
});

test('a schema that outlived its purged tenant is CRITICAL', () => {
  // The opposite failure, and the more serious one: data that should have been
  // erased is still on disk after the tenant was declared purged.
  const verdict = classifyTenantReality([{ status: 'PURGED', schemaExists: true, tableCount: 42 }]);

  assert.equal(verdict.critical, true);
  assert.equal(verdict.counts.schema_outlived_tenant, 1);
});

test('a mixed population reports every class at once', () => {
  const verdict = classifyTenantReality([
    active(true),
    active(false),
    { status: 'PENDING', schemaExists: false, tableCount: 0 },
    { status: 'PURGED', schemaExists: false, tableCount: 0 },
  ]);

  assert.equal(verdict.critical, true);
  assert.match(verdict.detail, /tenants=4/);
  assert.match(verdict.detail, /consistent=1/);
  assert.match(verdict.detail, /retired-as-expected=1/);
});

test('an empty platform is not a failure', () => {
  const verdict = classifyTenantReality([]);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.critical, false);
});

test('parses the psql wire format the probe actually emits', () => {
  const rows = parseTenantRealityRows('ACTIVE|t|42\nPENDING|f|0\n');

  assert.deepEqual(rows, [
    { status: 'ACTIVE', schemaExists: true, tableCount: 42 },
    { status: 'PENDING', schemaExists: false, tableCount: 0 },
  ]);
});

test('parsed rows feed the classifier without translation', () => {
  // The wire format and the judgement that reads it live in one module so
  // they cannot drift apart unnoticed; this proves the seam.
  const verdict = classifyTenantReality(parseTenantRealityRows('ACTIVE|f|0\n'));

  assert.equal(verdict.critical, true);
});
