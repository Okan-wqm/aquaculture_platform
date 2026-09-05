import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireInstallationLock } from '../src/installation-lock.ts';
import { PrincipalAdministration } from '../src/principal-admin.ts';
import { loadOrCreatePrincipals } from '../src/principals.ts';
import { TOKEN_HOLDER_PRINCIPAL } from '../src/principal.ts';

test('admin requires unrestricted operator and live lease; mutations reload authentication and never disclose digests', () => {
  const root = mkdtempSync(join(tmpdir(), 'aria-admin-'));
  const path = join(root, 'principals.json');
  const lease = acquireInstallationLock([path]);
  try {
    const directory = loadOrCreatePrincipals(path, null, new Date().toISOString());
    const admin = new PrincipalAdministration(directory, lease);
    assert.throws(() => admin.execute({ ...TOKEN_HOLDER_PRINCIPAL, role: 'lawyer' }, { action: 'list' }), /instance_operator_required/);
    assert.throws(() => admin.execute({ ...TOKEN_HOLDER_PRINCIPAL, cases: [] }, { action: 'list' }), /instance_operator_required/);
    const result = admin.execute(TOKEN_HOLDER_PRINCIPAL, { action: 'add', id: 'alice', displayName: 'Alice', role: 'lawyer', cases: '*' });
    assert.ok('token' in result);
    assert.equal(directory.resolve(result.token)?.id, 'alice');
    assert.ok(!JSON.stringify(result).includes('tokenSha256'));
    assert.ok(!JSON.stringify(admin.execute(TOKEN_HOLDER_PRINCIPAL, { action: 'list' })).includes(result.token));
    admin.execute(TOKEN_HOLDER_PRINCIPAL, { action: 'revoke', id: 'alice' });
    assert.equal(directory.resolve(result.token), null);
    assert.throws(() => admin.execute(TOKEN_HOLDER_PRINCIPAL, { action: 'list', unexpected: true }), /invalid_principal_command/);
    lease.close();
    assert.throws(() => admin.execute(TOKEN_HOLDER_PRINCIPAL, { action: 'list' }), /active installation/);
  } finally { lease.close(); rmSync(root, { recursive: true }); }
});

test('offline CLI cannot mutate a live installation and does not fall back from online failure', async () => {
  const { runPrincipalsCli } = await import('../src/principals-cli.ts');
  const { loadConfig } = await import('../src/config.ts');
  const { installationStoragePaths } = await import('../src/installation-lock.ts');
  const root = mkdtempSync(join(tmpdir(), 'aria-offline-'));
  const env = { ARIA_TOOLS_DIR: join(root, 'tools'), ARIA_UI_PRINCIPALS_FILE: join(root, 'principals.json') };
  const lease = acquireInstallationLock(installationStoragePaths(loadConfig(env)));
  try {
    await assert.rejects(runPrincipalsCli(['add', '--offline', '--id', 'alice', '--display', 'Alice', '--role', 'lawyer', '--cases', '*'], env, ''), /writer already active/);
    await assert.rejects(runPrincipalsCli(['list'], env, ''), /ARIA_UI_TOKEN is required/);
  } finally { lease.close(); rmSync(root, { recursive: true }); }
});

test('online CLI changes live identity, rejects lawyer administration, and revoked bootstrap token has no fallback', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const { installationStoragePaths } = await import('../src/installation-lock.ts');
  const { createConsoleServer, prepareLegalReadiness } = await import('../src/index.ts');
  const { runPrincipalsCli } = await import('../src/principals-cli.ts');
  const root = mkdtempSync(join(tmpdir(), 'aria-admin-http-'));
  const token = 'bootstrap-operator-test-token';
  const config = loadConfig({ ARIA_TOOLS_DIR: join(root, 'tools'), ARIA_UI_TOKEN: token });
  const lease = acquireInstallationLock(installationStoragePaths(config));
  const readiness = await prepareLegalReadiness(config, lease);
  const server = createConsoleServer(config, readiness, lease);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(runPrincipalsCli(['list', '--offline'], { ARIA_TOOLS_DIR: config.toolsDir, ARIA_UI_PRINCIPALS_FILE: config.principalsFile ?? '' }, ''), /writer already active/);
    const output = await runPrincipalsCli(['add', '--id', 'lawyer', '--display', 'Lawyer', '--role', 'lawyer', '--cases', '*'], { ARIA_UI_URL: base, ARIA_UI_TOKEN: token }, '');
    const added: { token: string } = JSON.parse(output);
    assert.ok(!output.includes('tokenSha256'));
    await assert.rejects(runPrincipalsCli(['list'], { ARIA_UI_URL: base, ARIA_UI_TOKEN: added.token }, ''), /403/);
    const oversized = await fetch(`${base}/api/v1/admin/principals`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'list', extra: 'x'.repeat(70_000) }) });
    assert.equal(oversized.status, 413);
    await runPrincipalsCli(['revoke', '--id', 'console-token-holder'], { ARIA_UI_URL: base, ARIA_UI_TOKEN: token }, '');
    await assert.rejects(runPrincipalsCli(['list'], { ARIA_UI_URL: base, ARIA_UI_TOKEN: token }, ''), /401/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    lease.close();
    rmSync(root, { recursive: true });
  }
});
