import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { acquireInstallationLock } from '../src/installation-lock.ts';

test('a second writer is rejected and explicit close releases every shared storage identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'aria-lock-'));
  const paths = [join(root, 'tools'), join(root, 'principals.json')];
  const lease = acquireInstallationLock(paths);
  try {
    assert.throws(() => acquireInstallationLock(paths), /writer already active/);
    assert.throws(() => acquireInstallationLock([paths[1]!]), /writer already active/);
  } finally { lease.close(); }
  const next = acquireInstallationLock(paths);
  next.close();
  rmSync(root, { recursive: true });
});

test('helper exit retains the lock; SIGKILL of owning process releases it without stale lock deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aria-lock-crash-'));
  const path = join(root, 'state');
  const module = new URL('../src/installation-lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireInstallationLock } from ${JSON.stringify(module)}; acquireInstallationLock([${JSON.stringify(path)}]); process.stdout.write('locked'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    assert.throws(() => acquireInstallationLock([path]), /writer already active/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const lease = acquireInstallationLock([path]);
    lease.close();
  } finally { child.kill('SIGKILL'); rmSync(root, { recursive: true }); }
});


test('symlink aliases share the canonical storage lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'aria-lock-alias-'));
  symlinkSync(root, join(root, 'alias'), 'dir');
  const lease = acquireInstallationLock([join(root, 'state')]);
  try { assert.throws(() => acquireInstallationLock([join(root, 'alias', 'state')]), /writer already active/); }
  finally { lease.close(); rmSync(root, { recursive: true }); }
});
