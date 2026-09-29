import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliPath } from './cli-invocation-fixture';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('CLI failure surface', () => {
  it('redacts an absolute secret path from all public failure streams and artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-cli-secret-'));
    temporaryRoots.push(root);
    const secret = join(root, 'DO-NOT-LEAK-super-secret-request.json');
    const bundlePath = join(root, 'run-bundle');
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        'run-verifier',
        '--request',
        secret,
        '--operator-trust-root-sha256',
        'a'.repeat(64),
        '--current-epoch-root',
        join(root, 'missing-epoch-root'),
        '--bundle',
        bundlePath,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('{"execution_verdict":"FAILED"}\n');
    expect(result.stderr).toBe('new-aria-admission: COMMAND_FAILED\n');
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(() => readdirSync(bundlePath)).toThrow();
  });

  it('does not overwrite an existing bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-cli-existing-'));
    temporaryRoots.push(root);
    const bundlePath = join(root, 'run-bundle');
    mkdirSync(bundlePath);
    writeFileSync(join(bundlePath, 'KEEP'), 'owner data\n');
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        'run-verifier',
        '--request',
        join(root, 'missing'),
        '--operator-trust-root-sha256',
        'a'.repeat(64),
        '--current-epoch-root',
        join(root, 'missing-epoch-root'),
        '--bundle',
        bundlePath,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(readFileSync(join(bundlePath, 'KEEP'), 'utf8')).toBe('owner data\n');
  });
});
