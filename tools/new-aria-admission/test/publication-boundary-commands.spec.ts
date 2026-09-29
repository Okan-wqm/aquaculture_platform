import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeBundleVerificationCommand,
  executeHistoricalBundleVerificationCommand,
} from '../src/runtime/executable-run-bundle-command';
import { executeVerifierInvocationCommand } from '../src/runtime/verifier-invocation-command';

import { createCliInvocationFixture, operatorRootPin } from './cli-invocation-fixture';
import { runGit } from './git-target-fixture';

const temporaryRoots: string[] = [];

function repositoryIdentity(root: string, reviewedRef: string): readonly string[] {
  return Object.freeze([
    runGit(root, 'rev-parse', 'HEAD'),
    runGit(root, 'rev-parse', reviewedRef),
    runGit(root, 'rev-parse', 'HEAD^{tree}'),
  ]);
}

describe('mutating command repository boundary', () => {
  const originalTmpdir = process.env.TMPDIR;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it('rejects a run bundle inside the reviewed repository before publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-run-boundary-'));
    temporaryRoots.push(root);
    const fixture = createCliInvocationFixture(root, temporaryRoots);
    const bundle = join(fixture.repository.root, 'run-evidence');
    const before = repositoryIdentity(fixture.repository.root, fixture.repository.reviewed_ref);

    expect(() =>
      executeVerifierInvocationCommand({
        kind: 'run-verifier',
        request_path: fixture.request_path,
        bundle_path: bundle,
        operator_trust_root_sha256: operatorRootPin(fixture.request_path),
        current_epoch_root: fixture.current_epoch_root,
      }),
    ).toThrow(/overlap/i);
    expect(existsSync(bundle)).toBe(false);
    expect(repositoryIdentity(fixture.repository.root, fixture.repository.reviewed_ref)).toEqual(
      before,
    );
  });

  it('rejects an epoch state root inside the reviewed repository before verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-verify-boundary-'));
    temporaryRoots.push(root);
    const fixture = createCliInvocationFixture(root, temporaryRoots);
    const epochRoot = join(fixture.repository.root, 'epoch-state');

    expect(() =>
      executeBundleVerificationCommand({
        kind: 'verify-bundle',
        request_path: fixture.bundle_verification_request_path,
        bundle_path: join(root, 'run-bundle'),
        operator_trust_root_sha256: operatorRootPin(fixture.request_path),
        current_epoch_root: epochRoot,
      }),
    ).toThrow(/overlap/i);
    expect(existsSync(epochRoot)).toBe(false);
  });

  it('rejects a private snapshot TMPDIR inside the reviewed repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-temp-boundary-'));
    temporaryRoots.push(root);
    const fixture = createCliInvocationFixture(root, temporaryRoots);
    process.env.TMPDIR = fixture.repository.root;
    const bundle = join(root, 'run-bundle');
    const before = repositoryIdentity(fixture.repository.root, fixture.repository.reviewed_ref);
    const entries = readdirSync(fixture.repository.root).sort();

    expect(() =>
      executeVerifierInvocationCommand({
        kind: 'run-verifier',
        request_path: fixture.request_path,
        bundle_path: bundle,
        operator_trust_root_sha256: operatorRootPin(fixture.request_path),
        current_epoch_root: fixture.current_epoch_root,
      }),
    ).toThrow(/overlap/i);
    expect(existsSync(bundle)).toBe(false);
    expect(repositoryIdentity(fixture.repository.root, fixture.repository.reviewed_ref)).toEqual(
      before,
    );
    expect(readdirSync(fixture.repository.root).sort()).toEqual(entries);
  });

  it('rejects current and historical bundle Git checks when TMPDIR is the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-readback-temp-'));
    temporaryRoots.push(root);
    const fixture = createCliInvocationFixture(root, temporaryRoots);
    const bundlePath = join(root, 'run-bundle');
    executeVerifierInvocationCommand({
      kind: 'run-verifier',
      request_path: fixture.request_path,
      bundle_path: bundlePath,
      operator_trust_root_sha256: operatorRootPin(fixture.request_path),
      current_epoch_root: fixture.current_epoch_root,
    });
    const common = {
      request_path: fixture.bundle_verification_request_path,
      bundle_path: bundlePath,
      operator_trust_root_sha256: operatorRootPin(fixture.request_path),
    } as const;
    const before = repositoryIdentity(fixture.repository.root, fixture.repository.reviewed_ref);
    const entries = readdirSync(fixture.repository.root).sort();
    process.env.TMPDIR = fixture.repository.root;

    expect(() =>
      executeBundleVerificationCommand({
        ...common,
        kind: 'verify-bundle',
        current_epoch_root: fixture.current_epoch_root,
      }),
    ).toThrow(/temporary root|overlap/i);
    expect(() =>
      executeHistoricalBundleVerificationCommand({
        ...common,
        kind: 'verify-bundle-history',
      }),
    ).toThrow(/temporary root|overlap/i);
    expect(existsSync(common.bundle_path)).toBe(true);
    expect(repositoryIdentity(fixture.repository.root, fixture.repository.reviewed_ref)).toEqual(
      before,
    );
    expect(readdirSync(fixture.repository.root).sort()).toEqual(entries);
  });
});
