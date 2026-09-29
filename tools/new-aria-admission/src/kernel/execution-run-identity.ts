import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json';
import { requireIdentifier } from './identifiers';

const sha64 = /^[a-f0-9]{64}$/u;

export interface ExecutionRunIdentityInput {
  readonly execution_session_id: string;
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly input_envelope_sha256: string;
  readonly tree_sha: string;
}

export function executionRunNonceSha256(input: ExecutionRunIdentityInput): string {
  const executionSessionId = requireIdentifier(input.execution_session_id, 'execution session');
  const runId = requireIdentifier(input.run_id, 'execution run');
  if (!sha64.test(input.run_context_sha256) || !sha64.test(input.input_envelope_sha256)) {
    throw new TypeError('execution run context or envelope digest is invalid');
  }
  if (!/^[a-f0-9]{40}$/u.test(input.tree_sha)) {
    throw new TypeError('execution run tree digest is invalid');
  }
  return createHash('sha256')
    .update(
      canonicalJsonBytes({
        contract_id: 'new-aria-execution-run-nonce-v1',
        execution_session_id: executionSessionId,
        run_id: runId,
        run_context_sha256: input.run_context_sha256,
        input_envelope_sha256: input.input_envelope_sha256,
        tree_sha: input.tree_sha,
      }),
    )
    .digest('hex');
}
