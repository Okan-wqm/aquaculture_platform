import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runKernel } from '../src/actions.ts';
import { loadConfig } from '../src/config.ts';
import { acquireInstallationLock, installationStoragePaths } from '../src/installation-lock.ts';

test('a running kernel writer retains installation locks after the service closes its descriptors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aria-child-lease-'));
  const config = loadConfig({ ARIA_UI_TOKEN: 'lease-test-token-0123456789', ARIA_TOOLS_DIR: root, ARIA_WORKSPACE_ROOT: root, ARIA_KERNEL_BIN: process.execPath, ARIA_UI_LEDGER_KEY_FILE: join(root, 'key.pem'), ARIA_UI_PRINCIPALS_FILE: join(root, 'principals.json'), ARIA_LEGAL_CASES_DIR: join(root, 'cases'), ARIA_WORKSPACE_BASE: join(root, 'workspaces') });
  const paths = installationStoragePaths(config);
  const lease = acquireInstallationLock(paths);
  const marker = join(root, 'started');
  const release = join(root, 'release');
  const code = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'ready'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0)}},10);`;
  const outcome = runKernel(config, ['-e', code], 5000, lease);
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) await delay(10);
    assert.ok(existsSync(marker), 'writer must have started before releasing the service descriptor');
    lease.close();
    assert.throws(() => { const contender = acquireInstallationLock(paths); contender.close(); }, /writer already active/);
  } finally {
    writeFileSync(release, 'done');
    await outcome;
    lease.close();
  }
  const next = acquireInstallationLock(paths);
  next.close();
  rmSync(root, { recursive: true });
});

for (const mode of ['exit', 'timeout'] as const) test(`a Python adapter closing descriptors and starting a new session cannot survive kernel ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aria-adapter-lifetime-'));
  const config = loadConfig({ ARIA_UI_TOKEN: 'lease-test-token-0123456789', ARIA_TOOLS_DIR: root, ARIA_WORKSPACE_ROOT: root, ARIA_KERNEL_BIN: '/usr/bin/python3', ARIA_UI_LEDGER_KEY_FILE: join(root, 'key.pem'), ARIA_UI_PRINCIPALS_FILE: join(root, 'principals.json'), ARIA_LEGAL_CASES_DIR: join(root, 'cases'), ARIA_WORKSPACE_BASE: join(root, 'workspaces') });
  const paths = installationStoragePaths(config);
  const lease = acquireInstallationLock(paths);
  const heartbeat = join(root, 'writes');
  const stop = join(root, 'stop');
  const adapter = `import pathlib,time\np=pathlib.Path(${JSON.stringify(heartbeat)})\nstop=pathlib.Path(${JSON.stringify(stop)})\nfor i in range(1000):\n if stop.exists(): break\n p.write_text(str(i))\n time.sleep(0.01)\n`;
  const kernel = `import pathlib,subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',${JSON.stringify(adapter)}],close_fds=True,start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nwhile not pathlib.Path(${JSON.stringify(heartbeat)}).exists(): time.sleep(0.01)\n${mode === 'timeout' ? 'while True: time.sleep(1)\n' : ''}`;
  try {
    const result = await runKernel(config, ['-c', kernel], mode === 'timeout' ? 2000 : 5000, lease);
    if (mode === 'exit') assert.equal(result.exitCode, 0, result.stderr);
    else assert.equal(result.timedOut, true);
    lease.close();
    const next = acquireInstallationLock(paths);
    try {
      const before = readFileSync(heartbeat, 'utf8');
      await delay(200);
      assert.equal(readFileSync(heartbeat, 'utf8'), before, 'no old adapter may write after a new installation lease is acquired');
    } finally { next.close(); }
  } finally {
    writeFileSync(stop, 'stop');
    await delay(250);
    lease.close();
    rmSync(root, { recursive: true });
  }
});

