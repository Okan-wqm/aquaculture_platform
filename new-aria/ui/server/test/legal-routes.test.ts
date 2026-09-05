// SCENARIO: the shipped legal instance, served end to end over HTTP.
// EXPECTS: with arias/legal/aria.manifest.json loaded and the environment's
// kernel-control switch OFF, the token holder can open a case, upload a
// document and start an inventory; the receipt names the authenticated
// principal (not a header); the inventory run is handed the receipt, the
// manifest's excluded roots and its cycle id; kernel control stays 403; a
// lawyer-owned class is 403 naming the class; and /me says all of this up front.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { HealthResponse, JobResponse, WhoAmIResponse } from '../../shared/api-contract.ts';
import type { LegalCaseCreatedResponse, LegalIntakeResponse, LegalUploadResponse } from '../../shared/legal-contract.ts';
import { loadConfig } from '../src/config.ts';
import { createConsoleServer } from '../src/index.ts';
import { loadOrCreateSigner } from '../src/ledger.ts';
import { LEGAL_ADAPTER_MANIFEST } from '../src/legal-readiness.ts';

const TOKEN = 'route-test-token-0123456789abcdef';
const LEGAL_MANIFEST = new URL('../../../arias/legal/aria.manifest.json', import.meta.url).pathname;

interface Harness {
  readonly base: string;
  readonly workspace: string;
  readonly toolsDir: string;
  readonly argvLog: string;
  readonly close: () => Promise<void>;
}

/**
 * A workspace shaped like the container's /opt/new-aria: the pack manifest
 * where the console expects it, the cases directory INSIDE the workspace root,
 * and a kernel stand-in that records its argv and exits 0.
 */
async function harness(registryStatus: string | null): Promise<Harness> {
  const workspace = mkdtempSync(join(tmpdir(), 'aria-routes-ws-'));
  mkdirSync(join(workspace, 'packs', 'legal', 'adapters'), { recursive: true });
  writeFileSync(join(workspace, LEGAL_ADAPTER_MANIFEST), '{"tool_id":"legal-document-inventory"}');
  const toolsDir = join(workspace, 'aria-tools');
  mkdirSync(join(toolsDir, 'packs', 'legal', 'cases'), { recursive: true });
  writeFileSync(join(toolsDir, 'repo_identity.json'), '{}');
  writeFileSync(join(toolsDir, 'registry.json'), JSON.stringify({ schema_version: 3, tools: registryStatus === null ? [] : [{ tool_id: 'legal-document-inventory', status: registryStatus }] }));
  const argvLog = join(workspace, 'kernel-argv.log');
  const kernelBin = join(workspace, 'aria-stub');
  writeFileSync(kernelBin, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argvLog}"\nexit 0\n`);
  chmodSync(kernelBin, 0o755);

  const config = loadConfig({
    ARIA_UI_TOKEN: TOKEN,
    ARIA_TOOLS_DIR: toolsDir,
    ARIA_WORKSPACE_ROOT: workspace,
    ARIA_LEGAL_CASES_DIR: join(workspace, 'data', 'legal-cases'),
    ARIA_INSTANCE_MANIFEST: LEGAL_MANIFEST,
    ARIA_KERNEL_BIN: kernelBin,
    ARIA_UI_ALLOW_ACTIONS: '0',
    ARIA_UI_HOST: '127.0.0.1',
    ARIA_UI_PORT: '8480',
    ARIA_UI_LEDGER_KEY_FILE: join(workspace, 'keys', 'ledger-ed25519.pem'),
  });
  const server = createConsoleServer(config, {
    boot: { toolId: 'legal-document-inventory', adapter: registryStatus === null ? 'unregistered' : 'registered', detail: registryStatus === null ? 'stub: never registered' : null, checkedAt: '2026-09-04T00:00:00.000Z' },
    signer: loadOrCreateSigner(config.ledgerKeyFile),
    signerDetail: null,
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    workspace,
    toolsDir,
    argvLog,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } };
  if (body !== undefined) {
    if (body instanceof Uint8Array) {
      init.body = body;
      (init.headers as Record<string, string>)['content-type'] = 'application/octet-stream';
    } else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
  }
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('the shipped legal profile takes a case in, end to end, with kernel control off', async () => {
  const h = await harness('SHADOW');
  try {
    const health = (await call(h.base, 'GET', '/api/v1/health')).body as unknown as HealthResponse;
    assert.equal(health.actionsEnabled, false, 'the manifest keeps kernel control off');
    assert.equal(health.legal.adapter, 'registered');

    const me = (await call(h.base, 'GET', '/api/v1/me')).body as unknown as WhoAmIResponse;
    assert.equal(me.principal.id, 'console-token-holder');
    assert.equal(me.principal.role, 'operator');
    assert.equal(me.permissions['case_intake'], true);
    assert.equal(me.permissions['corpus_inventory'], true);
    assert.equal(me.permissions['statement_verification'], false);
    assert.equal(me.permissions['kernel_control'], false);

    const created = await call(h.base, 'POST', '/api/v1/legal/cases', { caseId: 'sak-24-001', title: 'Bergen Eiendom mot Nordlys', custodian: 'Advokat Kari Nordmann' }, { 'x-aria-actor': 'Someone Else' });
    assert.equal(created.status, 201);
    assert.equal((created.body as unknown as LegalCaseCreatedResponse).caseMeta.createdBy, 'console-token-holder', 'the receipt names the authenticated principal, never a header');

    const uploaded = await call(h.base, 'POST', '/api/v1/legal/cases/sak-24-001/documents', new TextEncoder().encode('Fakturadato: 12.03.2024\n'), { 'x-aria-file-name': encodeURIComponent('vedlegg/faktura.txt'), 'x-aria-actor': 'Someone Else' });
    assert.equal(uploaded.status, 201);
    const record = (uploaded.body as unknown as LegalUploadResponse).record;
    assert.equal(record.receivedBy, 'console-token-holder');
    assert.equal(readFileSync(join(h.workspace, 'data', 'legal-cases', 'sak-24-001', 'archive', 'vedlegg', 'faktura.txt'), 'utf8'), 'Fakturadato: 12.03.2024\n');

    assert.ok(health.ledgerSigning, 'the public half of the ledger key is published');
    assert.equal(health.ledgerSigning.keyId, record.keyId, 'the receipt names the published key');
    assert.match(health.ledgerSigning.publicKeyPem, /BEGIN PUBLIC KEY/);

    const intake = (await call(h.base, 'GET', '/api/v1/legal/cases/sak-24-001/intake')).body as unknown as LegalIntakeResponse;
    assert.equal(intake.chain.status, 'intact');
    assert.equal(intake.chain.anchored, true, 'the signed head commits the row');
    assert.equal(intake.chain.keyId, record.keyId);
    assert.equal(intake.intake.length, 1);

    const started = await call(h.base, 'POST', '/api/v1/legal/cases/sak-24-001/inventory', { title: 'Bergen Eiendom mot Nordlys' });
    assert.equal(started.status, 202);
    const job = started.body as unknown as JobResponse;
    assert.equal(job.kind, 'legal-inventory');
    const inputIndex = job.command.indexOf('--input');
    assert.ok(inputIndex > 0, 'the kernel command carries --input');
    const input = JSON.parse(job.command[inputIndex + 1] ?? '{}') as Record<string, unknown>;
    assert.equal(input['case_id'], 'sak-24-001');
    assert.equal(input['archive_root'], 'data/legal-cases/sak-24-001/archive');
    assert.deepEqual(input['exclude_roots'], ['Ikke laste opp'], "the manifest's excluded roots reach the run");
    assert.deepEqual(input['intake'], [{ relativePath: 'vedlegg/faktura.txt', receivedAt: record.receivedAt, sha256: record.sha256 }], 'the receipt reaches the run with its digest, so learnedAt can be filled and the archive reconciled');
    const cycleIndex = job.command.indexOf('--cycle-id');
    assert.equal(input['cycle_id'], job.command[cycleIndex + 1], 'the input names the cycle the run is stamped with');
    assert.equal(job.command[job.command.indexOf('--workspace-root') + 1], h.workspace);

    const cycle = await call(h.base, 'POST', '/api/v1/actions/cycle', {});
    assert.equal(cycle.status, 403);
    assert.equal(cycle.body['error'], 'actions_disabled');
    const controlled = await call(h.base, 'POST', '/api/v1/actions/control', { verb: 'pause', reason: 'a reason long enough' });
    assert.equal(controlled.status, 403);
  } finally {
    await h.close();
  }
});

test('an inventory is refused before the kernel is spawned while the adapter is unregistered', async () => {
  const h = await harness(null);
  try {
    const health = (await call(h.base, 'GET', '/api/v1/health')).body as unknown as HealthResponse;
    assert.equal(health.legal.adapter, 'unregistered');
    assert.equal(health.legal.detail, 'stub: never registered');
    await call(h.base, 'POST', '/api/v1/legal/cases', { caseId: 'sak-24-002', title: 'x', custodian: 'y' });
    const started = await call(h.base, 'POST', '/api/v1/legal/cases/sak-24-002/inventory', {});
    assert.equal(started.status, 409);
    assert.equal(started.body['error'], 'legal_adapter_unregistered');
    assert.throws(() => readFileSync(h.argvLog), /ENOENT/, 'nothing was spawned');
  } finally {
    await h.close();
  }
});
