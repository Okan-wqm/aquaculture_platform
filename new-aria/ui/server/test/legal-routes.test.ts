// SCENARIO: the shipped legal instance, served end to end over HTTP, with
// named principals.
// EXPECTS: with arias/legal/aria.manifest.json loaded and the environment's
// kernel-control switch OFF, the operator (shared token, seeded into the
// principals file) opens cases, uploads and starts an inventory; a lawyer added
// through the principals file sees only the case assigned to them (another
// matter reads 404 and is not listed), holds the lawyer-owned gates the
// operator does not, and may not open a case outside their assignment; every
// case-scoped request lands in the case's signed access ledger; the request
// log names no case and no file; kernel control stays 403.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ENDPOINTS } from '../../shared/api-contract.ts';
import type { HealthResponse, JobResponse, WhoAmIResponse } from '../../shared/api-contract.ts';
import type { LegalCaseCreatedResponse, LegalCasesResponse, LegalIntakeResponse, LegalUploadResponse } from '../../shared/legal-contract.ts';
import { accessCanonical, ACCESS_LEDGER } from '../src/access-log.ts';
import type { AccessRecord } from '../src/access-log.ts';
import { loadConfig } from '../src/config.ts';
import { createConsoleServer, prepareLegalReadiness } from '../src/index.ts';
import { readHead, verifyLedger } from '../src/ledger.ts';
import { LEGAL_ADAPTER_MANIFEST } from '../src/legal-readiness.ts';
import { setLogWriter } from '../src/log.ts';
import { addPrincipal, revokePrincipal } from '../src/principals.ts';

const OPERATOR_TOKEN = 'route-test-token-0123456789abcdef';
const LEGAL_MANIFEST = new URL('../../../arias/legal/aria.manifest.json', import.meta.url).pathname;

interface Harness {
  readonly base: string;
  readonly workspace: string;
  readonly toolsDir: string;
  readonly casesDir: string;
  readonly argvLog: string;
  readonly lawyerToken: string;
  readonly logLines: string[];
  readonly close: () => Promise<void>;
}

/**
 * A workspace shaped like the container's /opt/new-aria: the pack manifest
 * where the console expects it, the cases directory INSIDE the workspace root,
 * a kernel stand-in that records its argv and exits 0, and a principals file
 * seeded with the operator plus one lawyer assigned to sak-24-001.
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
  // The stub answers `tool register` (boot) and `tool run` alike: record argv, exit 0.
  writeFileSync(kernelBin, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argvLog}"\nexit 0\n`);
  chmodSync(kernelBin, 0o755);
  const principalsFile = join(workspace, 'data', 'legal', 'principals.json');

  const config = loadConfig({
    ARIA_UI_TOKEN: OPERATOR_TOKEN,
    ARIA_TOOLS_DIR: toolsDir,
    ARIA_WORKSPACE_ROOT: workspace,
    ARIA_LEGAL_CASES_DIR: join(workspace, 'data', 'legal-cases'),
    ARIA_INSTANCE_MANIFEST: LEGAL_MANIFEST,
    ARIA_KERNEL_BIN: kernelBin,
    ARIA_UI_ALLOW_ACTIONS: '0',
    ARIA_UI_HOST: '127.0.0.1',
    ARIA_UI_PORT: '8480',
    ARIA_UI_LEDGER_KEY_FILE: join(workspace, 'keys', 'ledger-ed25519.pem'),
    ARIA_UI_PRINCIPALS_FILE: principalsFile,
  });
  // Boot exactly as main() does: register, key, principals (seeded with the
  // operator). Log lines go to a sink, never to the test runner's stdout.
  const logLines: string[] = [];
  setLogWriter((line) => logLines.push(line));
  let readiness;
  try {
    readiness = await prepareLegalReadiness(config);
  } finally {
    setLogWriter(null);
  }
  readiness.boot = { toolId: 'legal-document-inventory', adapter: registryStatus === null ? 'unregistered' : 'registered', detail: registryStatus === null ? 'stub: never registered' : null, checkedAt: '2026-09-04T00:00:00.000Z' };
  const lawyer = addPrincipal(principalsFile, { id: 'kari', displayName: 'Advokat Kari Nordmann', role: 'lawyer', cases: ['sak-24-001'] }, '2026-09-05T08:00:00.000Z');
  // The directory is loaded at boot; reload it so the lawyer added above is known.
  const { loadPrincipals } = await import('../src/principals.ts');
  readiness.principals = loadPrincipals(principalsFile);

  const server = createConsoleServer(config, readiness);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    workspace,
    toolsDir,
    casesDir: join(workspace, 'data', 'legal-cases'),
    argvLog,
    lawyerToken: lawyer.token,
    logLines,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function call(base: string, token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, ...headers } };
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

/** Runs `work` while capturing every line the server would have written to stdout. */
async function capturingStdout<T>(sink: string[], work: () => Promise<T>): Promise<T> {
  setLogWriter((line) => sink.push(line));
  try {
    return await work();
  } finally {
    setLogWriter(null);
  }
}

test('the shipped legal profile takes a case in, end to end, with kernel control off and the operator named on every receipt', async () => {
  const h = await harness('SHADOW');
  try {
    const health = (await call(h.base, OPERATOR_TOKEN, 'GET', '/api/v1/health')).body as unknown as HealthResponse;
    assert.equal(health.actionsEnabled, false, 'the manifest keeps kernel control off');
    assert.equal(health.legal.adapter, 'registered');
    assert.equal(health.identity, 'principals_file');

    const me = (await call(h.base, OPERATOR_TOKEN, 'GET', '/api/v1/me')).body as unknown as WhoAmIResponse;
    assert.equal(me.principal.id, 'console-token-holder');
    assert.equal(me.principal.role, 'operator');
    assert.equal(me.principal.cases, '*');
    assert.equal(me.permissions['case_intake'], true);
    assert.equal(me.permissions['corpus_inventory'], true);
    assert.equal(me.permissions['statement_verification'], false);
    assert.equal(me.permissions['kernel_control'], false);

    const created = await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases', { caseId: 'sak-24-001', title: 'Bergen Eiendom mot Nordlys', custodian: 'Advokat Kari Nordmann' }, { 'x-aria-actor': 'Someone Else' });
    assert.equal(created.status, 201);
    assert.equal((created.body as unknown as LegalCaseCreatedResponse).caseMeta.createdBy, 'console-token-holder', 'the receipt names the authenticated principal, never a header');

    const pending = await call(h.base, h.lawyerToken, 'GET', '/api/v1/legal/cases/sak-24-001');
    assert.equal(pending.status, 200);
    assert.equal(pending.body['coverage'], null);
    assert.equal(pending.body['summary'], null);
    assert.equal(pending.body['runKey'], null);
    const initialList = await call(h.base, h.lawyerToken, 'GET', '/api/v1/legal/cases');
    assert.equal(initialList.status, 200);
    assert.ok(Array.isArray(initialList.body['cases']));
    assert.equal(initialList.body['cases'].length, 1);

    const uploaded = await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases/sak-24-001/documents', new TextEncoder().encode('Fakturadato: 12.03.2024\n'), { 'x-aria-file-name': encodeURIComponent('vedlegg/faktura.txt'), 'x-aria-actor': 'Someone Else' });
    assert.equal(uploaded.status, 201);
    const record = (uploaded.body as unknown as LegalUploadResponse).record;
    assert.equal(record.receivedBy, 'console-token-holder');
    assert.equal(readFileSync(join(h.casesDir, 'sak-24-001', 'archive', 'vedlegg', 'faktura.txt'), 'utf8'), 'Fakturadato: 12.03.2024\n');

    assert.ok(health.ledgerSigning, 'the public half of the ledger key is published');
    assert.equal(health.ledgerSigning.keyId, record.keyId, 'the receipt names the published key');
    assert.match(health.ledgerSigning.publicKeyPem, /BEGIN PUBLIC KEY/);

    const intake = (await call(h.base, OPERATOR_TOKEN, 'GET', '/api/v1/legal/cases/sak-24-001/intake')).body as unknown as LegalIntakeResponse;
    assert.equal(intake.chain.status, 'intact');
    assert.equal(intake.chain.anchored, true, 'the signed head commits the row');
    assert.equal(intake.chain.keyId, record.keyId);
    assert.equal(intake.intake.length, 1);

    const started = await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases/sak-24-001/inventory', { title: 'Bergen Eiendom mot Nordlys' });
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

    const cycle = await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/actions/cycle', {});
    assert.equal(cycle.status, 403);
    assert.equal(cycle.body['error'], 'actions_disabled');
    const controlled = await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/actions/control', { verb: 'pause', reason: 'a reason long enough' });
    assert.equal(controlled.status, 403);
  } finally {
    await h.close();
  }
});

test('the matter wall: a lawyer sees only the case assigned to them, holds the lawyer gates, and cannot open a case outside the assignment', async () => {
  const h = await harness('SHADOW');
  try {
    for (const caseId of ['sak-24-001', 'sak-24-002']) {
      const created = await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases', { caseId, title: `Sak ${caseId}`, custodian: 'Advokat Kari Nordmann' });
      assert.equal(created.status, 201);
    }
    // Artifacts exist only for cases the adapter ran over; the listing reads
    // artifacts, so give both cases a minimal case.json the reader accepts.
    const fixture = new URL('./fixtures/tools/packs/legal/cases/case_fixture/', import.meta.url).pathname;
    for (const caseId of ['sak-24-001', 'sak-24-002']) {
      const dir = join(h.toolsDir, 'packs', 'legal', 'cases', caseId);
      mkdirSync(dir, { recursive: true });
      for (const name of ['case', 'documents', 'versions', 'parties', 'timeline', 'statements', 'links', 'coverage']) {
        const text = readFileSync(join(fixture, `${name}.json`), 'utf8').replace(/case_fixture/g, caseId);
        writeFileSync(join(dir, `${name}.json`), text);
      }
    }

    const me = (await call(h.base, h.lawyerToken, 'GET', '/api/v1/me')).body as unknown as WhoAmIResponse;
    assert.equal(me.principal.id, 'kari');
    assert.equal(me.principal.role, 'lawyer');
    assert.deepEqual(me.principal.cases, ['sak-24-001']);
    assert.equal(me.permissions['statement_verification'], true, 'the lawyer holds the lawyer-owned gates');
    assert.equal(me.permissions['filed_version_declaration'], true);
    assert.equal(me.permissions['kernel_control'], false);

    const listed = (await call(h.base, h.lawyerToken, 'GET', '/api/v1/legal/cases')).body as unknown as LegalCasesResponse;
    assert.deepEqual(listed.cases.map((row) => row.caseId), ['sak-24-001'], 'the other matter is not listed');
    const operatorList = (await call(h.base, OPERATOR_TOKEN, 'GET', '/api/v1/legal/cases')).body as unknown as LegalCasesResponse;
    assert.deepEqual(operatorList.cases.map((row) => row.caseId).sort(), ['sak-24-001', 'sak-24-002']);

    for (const path of ['', '/documents', '/timeline', '/parties', '/statements', '/coverage', '/intake']) {
      const own = await call(h.base, h.lawyerToken, 'GET', `/api/v1/legal/cases/sak-24-001${path}`);
      assert.equal(own.status, 200, `own case ${path}`);
      const other = await call(h.base, h.lawyerToken, 'GET', `/api/v1/legal/cases/sak-24-002${path}`);
      assert.equal(other.status, 404, `other matter ${path} reads as absent`);
      assert.equal(other.body['error'], 'case_not_found');
      assert.ok(!JSON.stringify(other.body).includes('Sak sak-24-002'), 'no byte of the other matter leaks');
    }
    const upload = await call(h.base, h.lawyerToken, 'POST', '/api/v1/legal/cases/sak-24-002/documents', new TextEncoder().encode('x'), { 'x-aria-file-name': 'a.txt' });
    assert.equal(upload.status, 404);
    const opened = await call(h.base, h.lawyerToken, 'POST', '/api/v1/legal/cases', { caseId: 'sak-24-003', title: 'Ny sak', custodian: 'Kari' });
    assert.equal(opened.status, 403);
    assert.equal(opened.body['error'], 'case_not_assigned');

    // Every case-scoped request is in the case's signed access ledger, and
    // the ledger verifies under the published key. An operator's write sits
    // beside the lawyer's reads.
    const written = await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases/sak-24-001/documents', new TextEncoder().encode('Avtale\n'), { 'x-aria-file-name': 'avtale.txt' });
    assert.equal(written.status, 201);
    const rows = readFileSync(join(h.casesDir, 'sak-24-001', ACCESS_LEDGER), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as AccessRecord);
    assert.ok(rows.length >= 7, `${rows.length} access rows: ${rows.map((row) => `${row.principalId} ${row.method} ${row.route} ${row.status}`).join(' | ')}`);
    assert.ok(rows.some((row) => row.principalId === 'kari' && row.route === '/api/v1/legal/cases/:caseId/statements' && row.status === 200));
    assert.ok(rows.some((row) => row.principalId === 'console-token-holder' && row.method === 'POST'));
    const { loadOrCreateSigner } = await import('../src/ledger.ts');
    const signer = loadOrCreateSigner(join(h.workspace, 'keys', 'ledger-ed25519.pem'));
    const verdict = verifyLedger({ rows, head: await readHead(join(h.casesDir, 'sak-24-001'), ACCESS_LEDGER), canonical: accessCanonical, verifier: signer });
    assert.equal(verdict.status, 'intact');
    assert.equal(verdict.anchored, true);
    // The refused attempts on the other matter are in THAT case's ledger, as
    // attempts: an access record that omitted them would hide the one event a
    // custodian most wants to know about.
    const otherRows = readFileSync(join(h.casesDir, 'sak-24-002', ACCESS_LEDGER), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as AccessRecord);
    assert.ok(otherRows.some((row) => row.principalId === 'kari' && row.status === 404), "the lawyer's refused attempts on the other matter are recorded there, with their 404");
    assert.ok(!otherRows.some((row) => row.principalId === 'kari' && row.status === 200), 'and never as a served read');
  } finally {
    await h.close();
  }
});

test('the request log names no case and no file: a case id is a client', async () => {
  const h = await harness('SHADOW');
  try {
    const lines: string[] = [];
    await capturingStdout(lines, async () => {
      await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases', { caseId: 'sak-24-777', title: 'Hemmelig klient', custodian: 'Advokat Kari Nordmann' });
      await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases/sak-24-777/documents', new TextEncoder().encode('x'), { 'x-aria-file-name': encodeURIComponent('hemmelig_avtale.txt') });
      await call(h.base, OPERATOR_TOKEN, 'GET', '/api/v1/legal/cases/sak-24-777/intake');
      await call(h.base, OPERATOR_TOKEN, 'GET', '/api/v1/legal/cases/sak-24-777/documents/doc_0000000000000000');
      await call(h.base, OPERATOR_TOKEN, 'GET', '/api/v1/legal/cases/sak-24-777');
    });
    assert.ok(lines.some((line) => line.includes('"message":"request"')), 'requests were logged');
    const joined = lines.join('');
    assert.ok(!joined.includes('sak-24-777'), 'the case id never reaches stdout');
    assert.ok(!joined.includes('hemmelig'), 'neither the file name nor the title');
    assert.ok(!joined.includes('doc_0000000000000000'), 'nor a document id');
    assert.ok(joined.includes('/api/v1/legal/cases/[case]'), 'the path is masked, not dropped');
  } finally {
    await h.close();
  }
});

test('an inventory is refused before the kernel is spawned while the adapter is unregistered', async () => {
  const h = await harness(null);
  try {
    const health = (await call(h.base, OPERATOR_TOKEN, 'GET', '/api/v1/health')).body as unknown as HealthResponse;
    assert.equal(health.legal.adapter, 'unregistered');
    assert.equal(health.legal.detail, 'stub: never registered');
    await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases', { caseId: 'sak-24-002', title: 'x', custodian: 'y' });
    const before = readFileSync(h.argvLog, 'utf8');
    const started = await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases/sak-24-002/inventory', {});
    assert.equal(started.status, 409);
    assert.equal(started.body['error'], 'legal_adapter_unregistered');
    assert.equal(readFileSync(h.argvLog, 'utf8'), before, 'nothing was spawned beyond the boot registration');
  } finally {
    await h.close();
  }
});


test('revocation is effective on the next request and the bootstrap token cannot restore a revoked principal', async () => {
  const h = await harness('ACTIVE');
  try {
    const principalsFile = join(h.workspace, 'data/legal/principals.json');
    const get = (token: string): Promise<Response> => fetch(`${h.base}${ENDPOINTS.me.path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await get(h.lawyerToken)).status, 200);
    revokePrincipal(principalsFile, 'kari', '2026-09-05T11:00:00.000Z');
    assert.equal((await get(h.lawyerToken)).status, 401);
    revokePrincipal(principalsFile, 'console-token-holder', '2026-09-05T11:00:00.000Z');
    assert.equal((await get(OPERATOR_TOKEN)).status, 401);
  } finally { await h.close(); }
});

test('inventory jobs are readable only by principals assigned to the job case', async () => {
  const h = await harness('ACTIVE');
  try {
    for (const caseId of ['sak-24-001', 'sak-24-002']) {
      assert.equal((await call(h.base, OPERATOR_TOKEN, 'POST', '/api/v1/legal/cases', { caseId, title: caseId, custodian: 'Counsel' })).status, 201);
      const started = await call(h.base, OPERATOR_TOKEN, 'POST', `/api/v1/legal/cases/${caseId}/inventory`, {});
      assert.equal(started.status, 202);
      assert.equal(typeof started.body['jobId'], 'string');
      const path = ENDPOINTS.job.path.replace(':jobId', String(started.body['jobId']));
      const visible = await call(h.base, h.lawyerToken, 'GET', path);
      assert.equal(visible.status, caseId === 'sak-24-001' ? 200 : 404);
    }
  } finally { await h.close(); }
});
