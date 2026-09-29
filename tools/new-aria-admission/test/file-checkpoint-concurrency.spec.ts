import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileEvidenceCheckpointStore } from '../src/adapters/file-evidence-checkpoint-store';
import type { EvidenceCheckpointRequest } from '../src/application/evidence-checkpoint';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';

import { checkpointProjectionTipFields } from './checkpoint-projection-fixture';

const storeModule = join(__dirname, '../src/adapters/file-evidence-checkpoint-store.ts');
const childScript = join(__dirname, 'fixtures/checkpoint-concurrent-child.cjs');
const tsNodeProject = join(__dirname, '../tsconfig.spec.json');
jest.setTimeout(120_000);

function request(version: number, digest: string): EvidenceCheckpointRequest {
  return {
    repository_id: 'repo-concurrent-tip',
    workspace_id: 'workspace-concurrent-tip',
    program_id: 'program-concurrent-tip',
    sprint_id: 'S01',
    authority_sha256: digest,
    evidence_id: `evidence-concurrent-${version.toString()}`,
    valid_from: '2026-09-02T00:00:00.000Z',
    valid_until: '2099-01-01T00:00:00.000Z',
    expected: null,
    next: {
      authority_sha256: digest,
      evidence_id: `evidence-concurrent-${version.toString()}`,
      version,
      manifest_sha256: digest,
      history_sha256: digest,
      ...checkpointProjectionTipFields(),
    },
  };
}

async function waitFor(
  path: string,
  failurePath: string,
  child: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!existsSync(path)) {
    if (existsSync(failurePath)) {
      throw new TypeError(readFileSync(failurePath, 'utf8'));
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new TypeError(`checkpoint child exited before barrier: ${stderr() || 'no stderr'}`);
    }
    if (Date.now() > deadline) throw new TypeError('checkpoint child barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('checkpoint cross-process linearization', () => {
  it('allows only one immutable final tip across concurrent versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-concurrent-'));
    const marker = join(tmpdir(), `new-aria-checkpoint-marker-${process.pid.toString()}`);
    const release = join(tmpdir(), `new-aria-checkpoint-release-${process.pid.toString()}`);
    const firstFailure = `${marker}.error`;
    const secondFailure = `${release}.error`;
    const genesis = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    genesis.close();
    const first = spawn(
      process.execPath,
      [
        childScript,
        storeModule,
        root,
        JSON.stringify(request(4, '4'.repeat(64))),
        marker,
        release,
        firstFailure,
      ],
      { env: { ...process.env, TS_NODE_PROJECT: tsNodeProject } },
    );
    let firstStdout = '';
    let firstStderr = '';
    first.stdout.on('data', (chunk: Buffer) => {
      firstStdout += chunk.toString();
    });
    first.stderr.on('data', (chunk: Buffer) => {
      firstStderr += chunk.toString();
    });
    try {
      await waitFor(marker, firstFailure, first, () => firstStderr);
      const second = spawnSync(
        process.execPath,
        [
          childScript,
          storeModule,
          root,
          JSON.stringify(request(5, '5'.repeat(64))),
          '-',
          '-',
          secondFailure,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, TS_NODE_PROJECT: tsNodeProject },
          timeout: 60_000,
        },
      );
      writeFileSync(release, 'continue', { flag: 'wx', mode: 0o600 });
      const firstStatus = await new Promise<number | null>((resolve) => {
        first.once('close', resolve);
      });
      expect(firstStatus).toBe(0);
      expect(firstStderr).toBe('');
      expect(second.status).toBe(0);
      expect([firstStdout, second.stdout].sort()).toEqual(['COMMITTED', 'CONFLICT']);
      expect(
        readdirSync(root).filter((name) => /^[a-f0-9]{64}-\d{10}-[a-f0-9]{64}\.json$/u.test(name)),
      ).toHaveLength(1);
    } finally {
      first.kill('SIGKILL');
      rmSync(marker, { force: true });
      rmSync(release, { force: true });
      rmSync(firstFailure, { force: true });
      rmSync(secondFailure, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
