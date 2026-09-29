import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { parseStrictJson } from '../src/kernel/strict-json';
import type { JsonValue } from '../src/kernel/strict-json';
import { executionPrivateKeyBytes } from './execution-receipt-fixture';
import { gitPath } from './git-target-fixture';
import type { GitTargetFixture } from './git-target-fixture';
import { productionVerifierFixture } from './production-verifier-fixture';
import { digest } from './operator-authority-fixture';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
export const cliPath = join(workspaceRoot, 'dist/tools/new-aria-admission/runtime/cli.js');
const toolPath = realpathSync(
  join(workspaceRoot, 'dist/tools/new-aria-admission/verifier/admission-verifier.cjs'),
);
const toolSha256 = digest(readFileSync(toolPath));
const runtimeSha256 = digest(readFileSync(process.execPath));
type JsonRecord = { [key: string]: JsonValue };

export interface CliInvocationFixture {
  readonly request_path: string;
  readonly bundle_verification_request_path: string;
  readonly current_epoch_root: string;
  readonly repository: GitTargetFixture;
}

export function record(value: JsonValue, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record`);
  }
  return value;
}

function write(root: string, name: string, bytes: Uint8Array): string {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: name.includes('private') ? 0o600 : 0o644 });
  return path;
}

export function createCliInvocationFixture(
  root: string,
  temporaryRoots: string[],
): CliInvocationFixture {
  const fixture = productionVerifierFixture(toolPath);
  fixture.current_epoch_provider.close();
  temporaryRoots.push(fixture.repository.root, fixture.epoch_store_root);
  const roster = fixture.roster;
  const runs = [roster.baseline_run, ...roster.controls].map((run, index) => ({
    input_envelope_path: write(root, `input-${index.toString()}.json`, run.envelope.bytes),
    run_context_sha256: run.run_context_sha256,
    run_id: run.run_id,
  }));
  const targetPath = write(
    root,
    'target.json',
    canonicalJsonBytes({
      base_sha: fixture.repository.base,
      head_sha: fixture.repository.head,
      repository_id: 'repo-1',
      repository_root: fixture.repository.root,
      reviewed_ref: fixture.repository.reviewed_ref,
      workspace_id: 'workspace-1',
    }),
  );
  const evidenceRootPath = write(root, 'evidence-root.json', fixture.evidence_trust_root_bytes);
  const executionPrivateKeyPath = write(root, 'execution-private.der', executionPrivateKeyBytes());
  const executionRootPath = write(root, 'execution-root.json', fixture.execution_trust_root_bytes);
  const operatorEnvelopePath = write(
    root,
    'operator-envelope.json',
    fixture.operator_envelope_bytes,
  );
  const operatorRootPath = write(root, 'operator-root.json', fixture.operator_trust_root_bytes);
  const requestPath = write(
    root,
    'invocation.json',
    canonicalJsonBytes({
      args: fixture.baseline_args,
      contract_id: 'new-aria-verifier-invocation-v2',
      evidence_trust_root_path: evidenceRootPath,
      execution_private_key_path: executionPrivateKeyPath,
      execution_trust_root_path: executionRootPath,
      git_path: gitPath,
      git_sha256: fixture.authority.authority.document.git_tool_sha256,
      operator_envelope_path: operatorEnvelopePath,
      operator_trust_root_path: operatorRootPath,
      runs,
      runtime_sha256: runtimeSha256,
      schema_version: '1.0.0',
      target_request_path: targetPath,
      tool_id: 'new-aria-admission-verifier',
      tool_path: toolPath,
      tool_sha256: toolSha256,
    }),
  );
  const bundleVerificationRequestPath = write(
    root,
    'bundle-verification.json',
    canonicalJsonBytes({
      contract_id: 'new-aria-execution-bundle-verification-request-v1',
      execution_trust_root_path: executionRootPath,
      git_path: gitPath,
      git_sha256: fixture.authority.authority.document.git_tool_sha256,
      operator_envelope_path: operatorEnvelopePath,
      operator_trust_root_path: operatorRootPath,
      schema_version: '1.0.0',
      target_request_path: targetPath,
    }),
  );
  return {
    request_path: requestPath,
    bundle_verification_request_path: bundleVerificationRequestPath,
    current_epoch_root: fixture.epoch_store_root,
    repository: fixture.repository,
  };
}

export function operatorRootPin(requestPath: string): string {
  const request = record(parseStrictJson(readFileSync(requestPath)), 'verifier invocation');
  const rootPath = request.operator_trust_root_path;
  if (typeof rootPath !== 'string') throw new TypeError('operator root path is absent');
  return digest(readFileSync(rootPath));
}
