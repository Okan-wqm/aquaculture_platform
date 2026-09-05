// SCENARIO: the console registers the legal adapter with the kernel at boot and
// reports what the registry says afterwards.
// EXPECTS: no workspace or no pack → not applicable; an unbootstrapped tools
// root is bootstrapped first, then the manifest is registered; a quarantined
// tool is left alone and reported; a kernel refusal is reported in the kernel's
// words; and the inventory route refuses to spawn while the tool is not registered.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ServerConfig } from '../src/config.ts';
import { HttpError } from '../src/errors.ts';
import type { KernelRunner } from '../src/legal-readiness.ts';
import { LEGAL_ADAPTER_MANIFEST, readLegalReadiness, registerLegalAdapter, requireLegalAdapter } from '../src/legal-readiness.ts';

function dir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aria-readiness-${label}-`));
}

function configFor(workspaceRoot: string | null, toolsDir: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    token: 'unit-test-token-0123456789abcdef',
    toolsDir,
    workspaceRoot,
    workspaceBase: join(toolsDir, '..', 'workspaces'),
    kernelBin: '/bin/false',
    staticDir: join(toolsDir, '..', 'static'),
    allowActions: false,
    actionTimeoutMs: 1000,
    version: 'test',
    legalCasesDir: workspaceRoot === null ? join(toolsDir, '..', 'legal-cases') : join(workspaceRoot, 'data', 'legal-cases'),
    maxUploadBytes: 1024,
    instancePolicy: null,
  };
}

function workspaceWithPack(): string {
  const root = dir('ws');
  mkdirSync(join(root, 'packs', 'legal', 'adapters'), { recursive: true });
  writeFileSync(join(root, LEGAL_ADAPTER_MANIFEST), '{"tool_id":"legal-document-inventory"}');
  return root;
}

function writeRegistry(toolsDir: string, status: string | null): void {
  const tools = status === null ? [] : [{ tool_id: 'legal-document-inventory', status }];
  writeFileSync(join(toolsDir, 'registry.json'), JSON.stringify({ schema_version: 3, tools }));
}

/** A kernel stand-in that records every argv and answers as instructed. */
function stubKernel(answers: ReadonlyArray<{ readonly exitCode: number; readonly stderr?: string }>): { readonly run: KernelRunner; readonly calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const run: KernelRunner = async (_config, argv) => {
    calls.push([...argv]);
    const answer = answers[index] ?? { exitCode: 0 };
    index += 1;
    return { exitCode: answer.exitCode, stdout: '', stderr: answer.stderr ?? '', timedOut: false };
  };
  return { run, calls };
}

test('no workspace root, or a workspace without the pack, is not applicable and spawns nothing', async () => {
  const kernel = stubKernel([]);
  const none = await registerLegalAdapter(configFor(null, dir('tools')), kernel.run);
  assert.equal(none.adapter, 'not_applicable');
  const bare = await registerLegalAdapter(configFor(dir('bare-ws'), dir('tools')), kernel.run);
  assert.equal(bare.adapter, 'not_applicable');
  assert.match(bare.detail ?? '', /carries no legal pack/);
  assert.deepEqual(kernel.calls, []);
});

test('a fresh tools root is registered with ONE kernel call: registration creates the root, and no bootstrap is attempted', async () => {
  // MEASURED 2026-09-05: `integrity migrate-tools-bootstrap` refuses a workspace
  // without git (repo_resolution_failed), which is the legal container's shape,
  // while `tool register` on an empty root creates registry, ledgers and repo
  // identity itself. A bootstrap call here would break the shipped deployment.
  const workspace = workspaceWithPack();
  const tools = dir('tools');
  const kernel = stubKernel([{ exitCode: 0 }]);
  const result = await registerLegalAdapter(configFor(workspace, tools), kernel.run);
  assert.equal(result.adapter, 'registered');
  assert.equal(result.detail, null);
  assert.equal(kernel.calls.length, 1);
  assert.deepEqual(kernel.calls[0]?.slice(0, 2), ['tool', 'register']);
  assert.ok(!kernel.calls.some((argv) => argv.includes('migrate-tools-bootstrap')), 'no bootstrap command may be issued');
  assert.equal(kernel.calls[0]?.at(-1), join(workspace, LEGAL_ADAPTER_MANIFEST));
});

test('an already-registered root is re-registered at the same status, which the kernel permits', async () => {
  const workspace = workspaceWithPack();
  const tools = dir('tools');
  writeRegistry(tools, 'SHADOW');
  const kernel = stubKernel([{ exitCode: 0 }]);
  const result = await registerLegalAdapter(configFor(workspace, tools), kernel.run);
  assert.equal(result.adapter, 'registered');
  assert.equal(kernel.calls.length, 1);
  assert.deepEqual(kernel.calls[0]?.slice(0, 2), ['tool', 'register']);
});

test('a quarantined tool is left alone: the kernel refuses to re-register one, and only an audited unquarantine may lift it', async () => {
  const workspace = workspaceWithPack();
  const tools = dir('tools');
  writeFileSync(join(tools, 'repo_identity.json'), '{}');
  writeRegistry(tools, 'QUARANTINED');
  const kernel = stubKernel([]);
  const result = await registerLegalAdapter(configFor(workspace, tools), kernel.run);
  assert.equal(result.adapter, 'quarantined');
  assert.deepEqual(kernel.calls, [], 'no register attempt against a quarantined tool');
});

test("a kernel refusal is reported in the kernel's words, and the inventory route refuses to spawn", async () => {
  const workspace = workspaceWithPack();
  const tools = dir('tools');
  writeFileSync(join(tools, 'repo_identity.json'), '{}');
  writeRegistry(tools, null);
  const kernel = stubKernel([{ exitCode: 1, stderr: 'GovernanceError: register_tool blocked: manifest hash drift' }]);
  const config = configFor(workspace, tools);
  const boot = await registerLegalAdapter(config, kernel.run);
  assert.equal(boot.adapter, 'unregistered');
  assert.match(boot.detail ?? '', /aria tool register failed \(exit 1\): GovernanceError/);

  const live = await readLegalReadiness(config, boot);
  assert.equal(live.adapter, 'unregistered');
  assert.equal(live.detail, boot.detail, 'the boot reason travels to the live reading while the registry has no row');
  try {
    requireLegalAdapter(live);
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'legal_adapter_unregistered');
  }
});

test('the live reading follows the registry: registered at boot, quarantined after two bad runs', async () => {
  const workspace = workspaceWithPack();
  const tools = dir('tools');
  writeFileSync(join(tools, 'repo_identity.json'), '{}');
  writeRegistry(tools, 'SHADOW');
  const config = configFor(workspace, tools);
  const boot = await registerLegalAdapter(config, stubKernel([{ exitCode: 0 }]).run);
  assert.equal(boot.adapter, 'registered');
  assert.equal((await readLegalReadiness(config, boot)).adapter, 'registered');
  writeRegistry(tools, 'QUARANTINED');
  const later = await readLegalReadiness(config, boot);
  assert.equal(later.adapter, 'quarantined');
  assert.doesNotThrow(() => requireLegalAdapter({ toolId: 'legal-document-inventory', adapter: 'registered', detail: null }));
});
