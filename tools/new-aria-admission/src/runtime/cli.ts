import { canonicalJsonBytes } from '../kernel/canonical-json';

import type { CliCommand } from './cli-arguments';
import { parseCliArguments } from './cli-arguments';
import { executeCompletionAdmissionCommand } from './completion-admission-command';
import {
  executeCurrentCompletionBundleCommand,
  executeHistoricalCompletionBundleCommand,
} from './completion-proof-bundle-command';
import type { CurrentlyVerifiedCompletionProofBundle } from './completion-proof-bundle-current';
import type { VerifiedCompletionProofBundle } from './completion-proof-bundle-verifier';
import {
  executeBundleVerificationCommand,
  executeHistoricalBundleVerificationCommand,
} from './executable-run-bundle-command';
import { executeVerifierInvocationCommand } from './verifier-invocation-command';

const jsonLine = (value: unknown): Buffer =>
  Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);

interface CommandOutcome {
  readonly kind:
    | 'admission'
    | 'execution'
    | 'historical-execution'
    | 'completion-bundle'
    | 'historical-completion';
  readonly exit_code: 0 | 1;
  readonly completion?: VerifiedCompletionProofBundle | CurrentlyVerifiedCompletionProofBundle;
}

function completionReadback(
  proof: VerifiedCompletionProofBundle | CurrentlyVerifiedCompletionProofBundle,
): Buffer {
  return jsonLine({
    schema_version: '1.0.0',
    contract_id: 'new-aria-completion-bundle-readback-v1',
    verdict: proof.current ? 'CURRENT' : 'HISTORICALLY_VALID',
    current: proof.current,
    bundle_sha256: proof.bundle_sha256,
    authority_sha256: proof.authority_sha256,
    evidence_sha256: proof.evidence_sha256,
    history_sha256: proof.history_sha256,
    projection_sha256: proof.projection_sha256,
    head_sha: proof.head_sha,
    valid_from: proof.valid_from,
    valid_until: proof.valid_until,
  });
}

async function executeCommand(command: CliCommand): Promise<CommandOutcome> {
  if (command.kind === 'verify-completion-bundle-history') {
    return {
      kind: 'historical-completion',
      exit_code: 0,
      completion: executeHistoricalCompletionBundleCommand(command),
    };
  }
  if (command.kind === 'verify-completion-bundle') {
    return {
      kind: 'completion-bundle',
      exit_code: 0,
      completion: executeCurrentCompletionBundleCommand(command),
    };
  }
  if (command.kind === 'verify-bundle-history') {
    executeHistoricalBundleVerificationCommand(command);
    return { kind: 'historical-execution', exit_code: 0 };
  }
  if (command.kind === 'verify-bundle') {
    executeBundleVerificationCommand(command);
    return { kind: 'execution', exit_code: 0 };
  }
  if (command.kind === 'run-verifier') {
    executeVerifierInvocationCommand(command);
    return { kind: 'execution', exit_code: 0 };
  }
  if (command.kind === 'admit-completion') {
    await executeCompletionAdmissionCommand(
      command.request_path,
      command.output_path,
      command.operator_trust_root_sha256,
      command.current_epoch_root,
      command.bundle_path,
    );
    return { kind: 'admission', exit_code: 0 };
  }
  throw new TypeError('CLI command is unsupported');
}

export async function main(args: readonly string[]): Promise<0 | 1> {
  const failureField =
    args[0] === 'admit-completion'
      ? 'admission_verdict'
      : args[0]?.startsWith('verify-completion-bundle') === true
        ? 'completion_bundle_verdict'
        : 'execution_verdict';
  try {
    const outcome = await executeCommand(parseCliArguments(args));
    if (outcome.completion !== undefined) {
      process.stdout.write(
        completionReadback(outcome.completion),
      );
      return outcome.exit_code;
    }
    process.stdout.write(
      outcome.kind === 'historical-execution'
        ? jsonLine({ current: false, historical_verdict: 'HISTORICALLY_VALID' })
        : jsonLine({
                [`${outcome.kind}_verdict`]: outcome.exit_code === 0 ? 'PASSED' : 'FAILED',
              }),
    );
    return outcome.exit_code;
  } catch {
    process.stdout.write(jsonLine({ [failureField]: 'FAILED' }));
    process.stderr.write('new-aria-admission: COMMAND_FAILED\n');
    return 1;
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
