import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeCompletionAdmissionCommand } from '../src/runtime/completion-admission-command';
import {
  prepareSprintCompletion,
  preparedCompletionProjectionBytes,
} from '../src/application/progress-admission';
import { CompletionProofBundlePublication } from '../src/runtime/completion-proof-bundle';
import {
  executeCurrentCompletionBundleCommand,
  executeHistoricalCompletionBundleCommand,
} from '../src/runtime/completion-proof-bundle-command';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import {
  completionCommandFixture,
  completionProofBundleSource,
} from './completion-command-fixture';
import { admitScenario } from './admission-transaction-fixture';
import { gitPath, runGit } from './git-target-fixture';

function repositoryIdentity(repositoryRoot: string, reviewedRef: string): readonly string[] {
  return Object.freeze([
    runGit(repositoryRoot, 'rev-parse', 'HEAD'),
    runGit(repositoryRoot, 'rev-parse', reviewedRef),
    runGit(repositoryRoot, 'rev-parse', 'HEAD^{tree}'),
  ]);
}

describe('completion admission physical publication separation', () => {
  const originalCheckpointRoot = process.env.NEW_ARIA_CHECKPOINT_DIRECTORY;
  const originalTmpdir = process.env.TMPDIR;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalCheckpointRoot === undefined) delete process.env.NEW_ARIA_CHECKPOINT_DIRECTORY;
    else process.env.NEW_ARIA_CHECKPOINT_DIRECTORY = originalCheckpointRoot;
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    cleanupAdmissionFixtures();
  });

  it.each(['output', 'bundle', 'checkpoint', 'epoch'] as const)(
    'rejects a %s destination inside the verified repository before effects',
    async (kind) => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-02T12:30:00.000Z'));
      const scenario = admissionInput();
      const root = mkdtempSync(join(tmpdir(), 'new-aria-completion-path-'));
      chmodSync(root, 0o700);
      const fixture = completionCommandFixture(root, scenario);
      const repository = scenario.context_input.verified_target;
      const before = repositoryIdentity(repository.repository_root, repository.reviewed_ref);
      const inside = join(repository.repository_root, '.git', `aria-${kind}`);
      process.env.NEW_ARIA_CHECKPOINT_DIRECTORY =
        kind === 'checkpoint' ? inside : scenario.checkpoint_root;
      const output = kind === 'output' ? inside : fixture.output_path;
      const bundle = kind === 'bundle' ? inside : fixture.bundle_path;
      const epoch = kind === 'epoch' ? inside : fixture.current_epoch_root;

      await expect(
        executeCompletionAdmissionCommand(
          fixture.request_path,
          output,
          fixture.operator_trust_root_sha256,
          epoch,
          bundle,
        ),
      ).rejects.toThrow(/overlap/i);
      expect(existsSync(inside)).toBe(false);
      expect(repositoryIdentity(repository.repository_root, repository.reviewed_ref)).toEqual(
        before,
      );
      rmSync(root, { recursive: true, force: true });
    },
  );

  it('rejects a temporary executable root inside the repository before admission effects', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-02T12:30:00.000Z'));
    const scenario = admissionInput();
    const root = mkdtempSync(join(tmpdir(), 'new-aria-completion-temp-'));
    chmodSync(root, 0o700);
    const fixture = completionCommandFixture(root, scenario);
    process.env.NEW_ARIA_CHECKPOINT_DIRECTORY = scenario.checkpoint_root;
    process.env.TMPDIR = scenario.context_input.verified_target.repository_root;

    await expect(
      executeCompletionAdmissionCommand(
        fixture.request_path,
        fixture.output_path,
        fixture.operator_trust_root_sha256,
        fixture.current_epoch_root,
        fixture.bundle_path,
      ),
    ).rejects.toThrow(/temporary root|overlap/i);
    expect(existsSync(fixture.output_path)).toBe(false);
    expect(existsSync(fixture.bundle_path)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a symlink alias and leaves a recoverable checkpoint link untouched', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-02T12:30:00.000Z'));
    const scenario = admissionInput();
    const root = mkdtempSync(join(tmpdir(), 'new-aria-completion-alias-'));
    chmodSync(root, 0o700);
    const fixture = completionCommandFixture(root, scenario);
    const repositoryRoot = scenario.context_input.verified_target.repository_root;
    const alias = join(root, 'repository-alias');
    symlinkSync(repositoryRoot, alias);
    await admitScenario(scenario);
    const checkpointRoot = scenario.checkpoint_root;
    const finalName = readdirSync(checkpointRoot).find((name) =>
      /^[a-f0-9]{64}-[0-9]{10}-[a-f0-9]{64}\.json$/u.test(name),
    );
    if (finalName === undefined) throw new TypeError('checkpoint final fixture is absent');
    const record = join(checkpointRoot, finalName);
    const temporary = join(
      checkpointRoot,
      `.${finalName}.${process.pid.toString()}.00000000-0000-4000-8000-000000000000.tmp`,
    );
    linkSync(record, temporary);
    const before = lstatSync(record);
    const beforeBytes = readFileSync(record);
    process.env.NEW_ARIA_CHECKPOINT_DIRECTORY = scenario.checkpoint_root;

    await expect(
      executeCompletionAdmissionCommand(
        fixture.request_path,
        join(alias, '.git', 'refs', 'heads', 'aria-output'),
        fixture.operator_trust_root_sha256,
        fixture.current_epoch_root,
        fixture.bundle_path,
      ),
    ).rejects.toThrow(/physical|overlap/i);
    const after = lstatSync(record);
    expect({ ino: after.ino, nlink: after.nlink, bytes: readFileSync(record) }).toEqual({
      ino: before.ino,
      nlink: before.nlink,
      bytes: beforeBytes,
    });
    expect(lstatSync(temporary).ino).toBe(before.ino);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a current-readback checkpoint root inside the repository before opening it', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-02T12:30:00.000Z'));
    const scenario = admissionInput();
    const root = mkdtempSync(join(tmpdir(), 'new-aria-current-path-'));
    chmodSync(root, 0o700);
    const prepared = prepareSprintCompletion(scenario.candidate, scenario.context);
    const projection = preparedCompletionProjectionBytes(prepared);
    const projectionPath = join(root, 'projection.json');
    writeFileSync(projectionPath, projection, { mode: 0o600 });
    const bundlePath = join(root, 'bundle');
    const publication = new CompletionProofBundlePublication(bundlePath);
    publication.stage(completionProofBundleSource(scenario, projection));
    publication.detachCandidate();
    renameSync(join(bundlePath, 'CANDIDATE.json'), join(bundlePath, 'COMPLETE.json'));
    const target = scenario.context_input.verified_target;
    const checkpointRoot = join(target.repository_root, '.git', 'aria-current-checkpoint');

    expect(() =>
      executeCurrentCompletionBundleCommand({
        kind: 'verify-completion-bundle',
        bundle_path: bundlePath,
        operator_trust_root_sha256: scenario.context_input.progress_authority.trust_root_sha256,
        current_epoch_root: scenario.current_epoch_root,
        checkpoint_root: checkpointRoot,
        repository_root: target.repository_root,
        projection_path: projectionPath,
        git_path: gitPath,
      }),
    ).toThrow(/overlap/i);
    expect(existsSync(checkpointRoot)).toBe(false);
    process.env.TMPDIR = bundlePath;
    const bundleEntries = readdirSync(bundlePath).sort();
    expect(() =>
      executeHistoricalCompletionBundleCommand({
        kind: 'verify-completion-bundle-history',
        bundle_path: bundlePath,
        operator_trust_root_sha256: scenario.context_input.progress_authority.trust_root_sha256,
        repository_root: target.repository_root,
        projection_path: projectionPath,
        git_path: gitPath,
      }),
    ).toThrow(/temporary root|overlap/i);
    expect(readdirSync(bundlePath).sort()).toEqual(bundleEntries);
    rmSync(root, { recursive: true, force: true });
  });
});
