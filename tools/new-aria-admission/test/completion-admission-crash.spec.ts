import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeCompletionAdmissionCommand } from '../src/runtime/completion-admission-command';
import { readCompletionProofBundle } from '../src/runtime/completion-proof-bundle-reader';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { completionCommandFixture } from './completion-command-fixture';

const childPath = join(__dirname, 'fixtures/completion-admission-crash-child.cjs');
const commandModule = join(__dirname, '../src/runtime/completion-admission-command.ts');
const tsNodeProject = join(__dirname, '../tsconfig.spec.json');

async function waitForBarrier(path: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = process.hrtime.bigint() + 600_000_000_000n;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new TypeError('completion admission child exited before the post-CAS barrier');
    }
    if (process.hrtime.bigint() > deadline)
      throw new TypeError('completion admission barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('completion admission crash recovery', () => {
  const originalCheckpointRoot = process.env.NEW_ARIA_CHECKPOINT_DIRECTORY;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalCheckpointRoot === undefined) delete process.env.NEW_ARIA_CHECKPOINT_DIRECTORY;
    else process.env.NEW_ARIA_CHECKPOINT_DIRECTORY = originalCheckpointRoot;
    cleanupAdmissionFixtures();
  });

  it('recovers a post-CAS CANDIDATE after SIGKILL and source expiry', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-02T12:30:00.000Z'));
    const scenario = admissionInput();
    const root = mkdtempSync(join(tmpdir(), 'new-aria-command-crash-'));
    chmodSync(root, 0o700);
    const fixture = completionCommandFixture(root, scenario);
    process.env.NEW_ARIA_CHECKPOINT_DIRECTORY = scenario.checkpoint_root;
    const barrier = join(root, 'post-cas-barrier');
    const child = spawn(
      process.execPath,
      [
        childPath,
        commandModule,
        fixture.request_path,
        fixture.output_path,
        fixture.operator_trust_root_sha256,
        fixture.current_epoch_root,
        fixture.bundle_path,
        barrier,
      ],
      {
        env: {
          ...process.env,
          NEW_ARIA_CHECKPOINT_DIRECTORY: scenario.checkpoint_root,
          TS_NODE_PROJECT: tsNodeProject,
        },
      },
    );
    try {
      await waitForBarrier(barrier, child);
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
      expect(existsSync(join(fixture.bundle_path, 'CANDIDATE.json'))).toBe(true);
      expect(existsSync(join(fixture.bundle_path, 'COMPLETE.json'))).toBe(false);
      expect(readFileSync(fixture.output_path, 'utf8')).toContain('"status":"PENDING"');
      const checkpointEntries = readdirSync(scenario.checkpoint_root).sort();
      for (const path of fixture.removable_source_paths) unlinkSync(path);
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-03T00:00:00.000Z'));

      await executeCompletionAdmissionCommand(
        fixture.request_path,
        fixture.output_path,
        fixture.operator_trust_root_sha256,
        fixture.current_epoch_root,
        fixture.bundle_path,
      );

      expect(existsSync(join(fixture.bundle_path, 'CANDIDATE.json'))).toBe(false);
      expect(existsSync(join(fixture.bundle_path, 'COMPLETE.json'))).toBe(true);
      expect(readdirSync(scenario.checkpoint_root).sort()).toEqual(checkpointEntries);
      const bundle = readCompletionProofBundle(fixture.bundle_path, 'COMPLETE.json');
      expect(readFileSync(fixture.output_path)).toEqual(bundle.source.projection_artifact_bytes);
    } finally {
      child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);
});
