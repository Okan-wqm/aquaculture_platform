// SCENARIO: the instance manifest is loaded and applied, or the server refuses to start.
// EXPECTS: a valid manifest yields its ceiling and gates; allow_actions can only
// narrow the environment's grant, never widen it; every malformed shape fails closed.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigError } from '../src/config.ts';
import { effectiveAllowActions, loadInstancePolicy, requiredRoleFor } from '../src/instance-policy.ts';

function instanceDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aria-instance-${label}-`));
}

function writeInstance(
  dir: string,
  manifest: Record<string, unknown>,
  policy: Record<string, unknown> | null = { gates: [] },
): string {
  const manifestPath = join(dir, 'aria.manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  if (policy !== null) writeFileSync(join(dir, 'approval-policy.json'), JSON.stringify(policy));
  return manifestPath;
}

const LEGAL_GATES = {
  gates: [
    { action_class: 'statement_verification', description: 'Mark a statement verified.', requires_role: 'lawyer', auto: false },
    { action_class: 'corpus_inventory', description: 'Read the archive.', requires_role: null, auto: true },
  ],
};

test('no manifest configured means no instance policy, and the environment decides alone', () => {
  assert.equal(loadInstancePolicy({}), null);
  assert.equal(loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: '   ' }), null);
  assert.equal(effectiveAllowActions(true, null), true);
  assert.equal(effectiveAllowActions(false, null), false);
});

test('a valid manifest yields its identity, ceiling and gates', () => {
  const dir = instanceDir('valid');
  const manifestPath = writeInstance(
    dir,
    {
      id: 'legal',
      display_name: "Hukuk ARIA'sı",
      runtime: { profile_ceiling: 'standard', allow_actions: false },
      policies: { approval: 'approval-policy.json' },
    },
    LEGAL_GATES,
  );
  const policy = loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: manifestPath });
  assert.ok(policy);
  assert.equal(policy.instanceId, 'legal');
  assert.equal(policy.profileCeiling, 'standard');
  assert.equal(policy.allowActions, false);
  assert.equal(policy.gates.length, 2);
  assert.equal(requiredRoleFor(policy, 'statement_verification'), 'lawyer');
  assert.equal(requiredRoleFor(policy, 'corpus_inventory'), null);
  assert.equal(requiredRoleFor(policy, 'a_class_nobody_declared'), null);
});

test('the instance file may only narrow: it can turn actions off, never on', () => {
  const dir = instanceDir('narrow');
  const off = loadInstancePolicy({
    ARIA_INSTANCE_MANIFEST: writeInstance(dir, { id: 'legal', runtime: { allow_actions: false } }, null),
  });
  assert.ok(off);
  assert.equal(effectiveAllowActions(true, off), false, 'the manifest takes the grant away');
  assert.equal(effectiveAllowActions(false, off), false);

  const on = loadInstancePolicy({
    ARIA_INSTANCE_MANIFEST: writeInstance(instanceDir('widen'), { id: 'legal', runtime: { allow_actions: true } }, null),
  });
  assert.ok(on);
  assert.equal(effectiveAllowActions(false, on), false, 'the manifest cannot grant what the operator withheld');
  assert.equal(effectiveAllowActions(true, on), true);
});

test('a configured manifest that is missing, unparseable or not an object fails closed', () => {
  assert.throws(() => loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: join(instanceDir('absent'), 'nope.json') }), ConfigError);

  const badDir = instanceDir('bad-json');
  const badPath = join(badDir, 'aria.manifest.json');
  writeFileSync(badPath, '{ not json');
  assert.throws(() => loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: badPath }), ConfigError);

  const arrayDir = instanceDir('array');
  const arrayPath = join(arrayDir, 'aria.manifest.json');
  writeFileSync(arrayPath, '[]');
  assert.throws(() => loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: arrayPath }), ConfigError);
});

test('a manifest missing its id, or carrying a malformed runtime block, fails closed', () => {
  assert.throws(
    () => loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: writeInstance(instanceDir('no-id'), { runtime: {} }, null) }),
    ConfigError,
  );
  assert.throws(
    () => loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: writeInstance(instanceDir('bad-allow'), { id: 'legal', runtime: { allow_actions: 'no' } }, null) }),
    ConfigError,
  );
  assert.throws(
    () => loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: writeInstance(instanceDir('bad-ceiling'), { id: 'legal', runtime: { profile_ceiling: '' } }, null) }),
    ConfigError,
  );
});

test('a manifest pointing at a missing or malformed approval policy fails closed', () => {
  const dir = instanceDir('no-policy');
  const manifestPath = writeInstance(dir, { id: 'legal', policies: { approval: 'approval-policy.json' } }, null);
  assert.throws(() => loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: manifestPath }), ConfigError);

  assert.throws(
    () =>
      loadInstancePolicy({
        ARIA_INSTANCE_MANIFEST: writeInstance(instanceDir('no-gates'), { id: 'legal', policies: { approval: 'approval-policy.json' } }, { roles: [] }),
      }),
    ConfigError,
  );
});

test('an unenforceable gate is refused: neither automatic nor owned by a role', () => {
  assert.throws(
    () =>
      loadInstancePolicy({
        ARIA_INSTANCE_MANIFEST: writeInstance(
          instanceDir('orphan-gate'),
          { id: 'legal', policies: { approval: 'approval-policy.json' } },
          { gates: [{ action_class: 'redaction_and_production', requires_role: null, auto: false }] },
        ),
      }),
    ConfigError,
  );
});

test('a gate that is automatic yet names an approver is refused as contradictory', () => {
  assert.throws(
    () =>
      loadInstancePolicy({
        ARIA_INSTANCE_MANIFEST: writeInstance(
          instanceDir('contradictory-gate'),
          { id: 'legal', policies: { approval: 'approval-policy.json' } },
          { gates: [{ action_class: 'corpus_inventory', requires_role: 'lawyer', auto: true }] },
        ),
      }),
    ConfigError,
  );
});

test("the legal instance shipped in this repo loads and keeps the lawyer's gates", () => {
  const policy = loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: new URL('../../../arias/legal/aria.manifest.json', import.meta.url).pathname });
  assert.ok(policy);
  assert.equal(policy.instanceId, 'legal');
  assert.equal(policy.allowActions, false);
  assert.equal(policy.profileCeiling, 'standard');
  for (const actionClass of ['statement_verification', 'party_identity_merge', 'filed_version_declaration', 'redaction_and_production', 'external_effect']) {
    assert.equal(requiredRoleFor(policy, actionClass), 'lawyer', `${actionClass} must be lawyer-owned`);
  }
  assert.equal(requiredRoleFor(policy, 'corpus_inventory'), null, 'reading the archive is automatic');
});
