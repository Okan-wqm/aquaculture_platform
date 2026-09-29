import { readFileSync, realpathSync, rmSync } from 'node:fs';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import {
  abortExecutionSigningReservation,
  reserveExecutionSigningCapability,
} from '../src/kernel/execution-signing-capability';
import {
  abortRepositoryExecutionSession,
  openRepositoryExecutionSession,
} from '../src/runtime/executable-runner';
import type { RepositoryExecutionSession } from '../src/runtime/executable-runner';
import { loadExecutionSigningCapability } from '../src/runtime/execution-signer';

import { trustRootBytes } from './attestation-fixture';
import {
  authorizedExecutionAuthority,
  executionPrivateKeyBytes,
  executionTrustRootBytes,
} from './execution-receipt-fixture';
import { currentEpochProviderFixture, currentEpochStoreFixture } from './current-epoch-fixture';
import { createGitTargetFixture, verifiedGitTarget } from './git-target-fixture';
import { digest, operatorTrustRootBytes } from './operator-authority-fixture';

describe('repository execution transaction', () => {
  it('can retry after a signing reservation conflict without burning the target', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    const repository = createGitTargetFixture();
    const target = verifiedGitTarget(repository);
    const runtimeSha256 = digest(readFileSync(process.execPath));
    const toolPath = realpathSync(__filename);
    const toolSha256 = digest(readFileSync(toolPath));
    const args = ['--mode', 'full'];
    const runtimeId = `node@${process.version}`;
    const operatorRoot = operatorTrustRootBytes();
    const epochStore = currentEpochStoreFixture(operatorRoot);
    const authority = authorizedExecutionAuthority({
      base_sha: target.base_sha,
      head_sha: target.head_sha,
      verifier_tool_id: 'new-aria-admission-verifier',
      verifier_sha256: toolSha256,
      verifier_argv_sha256: digest(
        canonicalJsonBytes([runtimeId, 'new-aria-admission-verifier', ...args]),
      ),
      runtime_id: runtimeId,
      toolchain_sha256: runtimeSha256,
      execution_cwd_sha256: digest(
        Buffer.from(`workspace://${target.repository_id}/${target.workspace_id}`),
      ),
      git_tool_id: target.git_tool_id,
      git_tool_sha256: target.git_tool_sha256,
      ...epochStore.authority,
    });
    const currentEpoch = currentEpochProviderFixture(authority, operatorRoot, epochStore);
    const executionRoot = executionTrustRootBytes();
    const capability = loadExecutionSigningCapability({
      authority,
      trust_root_bytes: executionRoot,
      evidence_trust_root_bytes: trustRootBytes(),
      private_key_pkcs8_der: executionPrivateKeyBytes(),
    });
    const request = {
      authority,
      target,
      signing_capability: capability,
      execution_trust_root_bytes: executionRoot,
      current_epoch_provider: currentEpoch.provider,
    };
    const conflicting = reserveExecutionSigningCapability(capability, authority, executionRoot);
    let session: RepositoryExecutionSession | undefined;
    try {
      expect(() => openRepositoryExecutionSession(request)).toThrow(/lifecycle|reserved/);
      abortExecutionSigningReservation(conflicting);
      expect(() => {
        session = openRepositoryExecutionSession(request);
      }).not.toThrow();
    } finally {
      if (session !== undefined) abortRepositoryExecutionSession(session);
      rmSync(repository.root, { force: true, recursive: true });
      currentEpoch.provider.close();
      rmSync(epochStore.root, { force: true, recursive: true });
      jest.useRealTimers();
    }
  });
});
