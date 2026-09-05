// SCENARIO: the approval policy decides case actions per class and per role.
// EXPECTS: an automatic class is open to any principal, a lawyer-owned class is
// refused to the operator and named in the refusal, a class the policy never
// mentions is refused, kernel control still answers to the allow_actions switch,
// and the shipped legal instance opens a case for the token holder while keeping
// every lawyer gate closed to it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ServerConfig } from '../src/config.ts';
import { HttpError } from '../src/errors.ts';
import { decideAction, permissionsFor, requireGate } from '../src/gates.ts';
import { decideGate, effectiveAllowActions, loadInstancePolicy } from '../src/instance-policy.ts';
import type { Principal } from '../src/principal.ts';
import { TOKEN_HOLDER_PRINCIPAL } from '../src/principal.ts';

const LEGAL_MANIFEST = new URL('../../../arias/legal/aria.manifest.json', import.meta.url).pathname;

function configWith(environmentAllows: boolean, manifest: string | null): ServerConfig {
  const instancePolicy = manifest === null ? null : loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: manifest });
  return {
    host: '127.0.0.1',
    port: 0,
    token: 'unit-test-token-0123456789abcdef',
    principalsFile: null,
    toolsDir: '/tmp/never-read',
    workspaceRoot: null,
    workspaceBase: '/tmp/never-read/workspaces',
    kernelBin: '/bin/false',
    staticDir: '/tmp/never-read/static',
    allowActions: effectiveAllowActions(environmentAllows, instancePolicy),
    actionTimeoutMs: 1000,
    version: 'test',
    legalCasesDir: '/tmp/never-read/legal-cases',
    maxUploadBytes: 1024,
    instancePolicy,
  };
}

const LAWYER: Principal = { id: 'kari', displayName: 'Advokat Kari Nordmann', role: 'lawyer', cases: '*' };

function refusal(run: () => void): HttpError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a refusal, but the call returned' });
}

test('the shipped legal instance opens a case for the token holder, and keeps kernel control off', () => {
  const config = configWith(false, LEGAL_MANIFEST);
  assert.equal(config.allowActions, false, 'the manifest narrows kernel control to off');
  assert.doesNotThrow(() => requireGate(config, TOKEN_HOLDER_PRINCIPAL, 'case_intake'));
  assert.doesNotThrow(() => requireGate(config, TOKEN_HOLDER_PRINCIPAL, 'corpus_inventory'));
  const kernel = refusal(() => requireGate(config, TOKEN_HOLDER_PRINCIPAL, 'kernel_control'));
  assert.equal(kernel.status, 403);
  assert.equal(kernel.code, 'actions_disabled');
  assert.match(kernel.detail ?? '', /runtime\.allow_actions false/);
});

test('every lawyer-owned class is refused to the operator by name, and open to a lawyer', () => {
  const config = configWith(false, LEGAL_MANIFEST);
  for (const actionClass of ['statement_verification', 'party_identity_merge', 'filed_version_declaration', 'document_removal', 'case_lifecycle', 'redaction_and_production', 'external_effect'] as const) {
    const error = refusal(() => requireGate(config, TOKEN_HOLDER_PRINCIPAL, actionClass));
    assert.equal(error.status, 403);
    assert.equal(error.code, 'action_class_refused');
    assert.match(error.detail ?? '', new RegExp(`^${actionClass} requires role lawyer;`));
    assert.doesNotThrow(() => requireGate(config, LAWYER, actionClass), `${actionClass} must be open to the lawyer role`);
  }
});

test('a class the policy never names is refused: silence is not consent', () => {
  const policy = loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: LEGAL_MANIFEST });
  assert.ok(policy);
  assert.deepEqual(decideGate(policy, 'lawyer', 'a_class_nobody_declared'), { allowed: false, reason: 'action_class_ungoverned', requiredRole: null });
  assert.deepEqual(decideGate(policy, 'operator', 'corpus_inventory'), { allowed: true, basis: 'automatic' });
  assert.deepEqual(decideGate(policy, 'lawyer', 'statement_verification'), { allowed: true, basis: 'role' });
  assert.deepEqual(decideGate(policy, 'operator', 'statement_verification'), { allowed: false, reason: 'role_required', requiredRole: 'lawyer' });
});

test('without an instance manifest the environment switch governs case work, as it always did', () => {
  const off = configWith(false, null);
  const refused = refusal(() => requireGate(off, TOKEN_HOLDER_PRINCIPAL, 'case_intake'));
  assert.equal(refused.code, 'actions_disabled');
  const on = configWith(true, null);
  assert.doesNotThrow(() => requireGate(on, TOKEN_HOLDER_PRINCIPAL, 'case_intake'));
  assert.doesNotThrow(() => requireGate(on, TOKEN_HOLDER_PRINCIPAL, 'kernel_control'));
});

test('the permission map answers every class the console knows, for the principal asked about', () => {
  const config = configWith(false, LEGAL_MANIFEST);
  const operator = permissionsFor(config, TOKEN_HOLDER_PRINCIPAL);
  assert.deepEqual(operator, {
    kernel_read: true,
    kernel_control: false,
    case_intake: true,
    corpus_inventory: true,
    statement_verification: false,
    party_identity_merge: false,
    filed_version_declaration: false,
    document_removal: false,
    case_lifecycle: false,
    redaction_and_production: false,
    external_effect: false,
  });
  const lawyer = permissionsFor(config, LAWYER);
  assert.equal(lawyer['statement_verification'], true);
  assert.equal(lawyer['kernel_read'], false);
  assert.equal(lawyer['kernel_control'], false, 'a lawyer does not steer the kernel');
  assert.equal(decideAction(config, LAWYER, 'redaction_and_production').allowed, true);
});

test('enabled kernel control still requires an operator with unrestricted case scope', () => {
  const config = configWith(true, null);
  for (const principal of [LAWYER, { ...TOKEN_HOLDER_PRINCIPAL, cases: ['sak-24-001'] }]) {
    assert.equal(permissionsFor(config, principal)['kernel_read'], false);
    assert.equal(permissionsFor(config, principal)['kernel_control'], false);
    assert.throws(() => requireGate(config, principal, 'kernel_control'), { code: 'action_class_refused' });
  }
  assert.equal(permissionsFor(config, TOKEN_HOLDER_PRINCIPAL)['kernel_control'], true);
});
