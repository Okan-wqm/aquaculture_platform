import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliPath } from './cli-invocation-fixture';

describe('repository target CLI boundary', () => {
  it('rejects the unauthenticated target command without executing caller bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-cli-target-'));
    const executablePath = join(root, 'attacker-git');
    const markerPath = join(root, 'EXECUTED');
    const outputPath = join(root, 'target.json');
    try {
      writeFileSync(executablePath, `#!/bin/sh\ntouch '${markerPath}'\n`, { mode: 0o700 });
      const digest = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          'verify-target',
          '--request',
          join(root, 'request.json'),
          '--git',
          executablePath,
          '--git-sha256',
          digest,
          '--output',
          outputPath,
        ],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('{"execution_verdict":"FAILED"}\n');
      expect(result.stderr).toBe('new-aria-admission: COMMAND_FAILED\n');
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
