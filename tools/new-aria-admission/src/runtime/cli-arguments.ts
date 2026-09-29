import { isAbsolute, normalize, relative, sep } from 'node:path';

interface RunVerifierCommand {
  readonly kind: 'run-verifier';
  readonly request_path: string;
  readonly bundle_path: string;
  readonly operator_trust_root_sha256: string;
  readonly current_epoch_root: string;
}

interface AdmitCompletionCommand {
  readonly kind: 'admit-completion';
  readonly request_path: string;
  readonly output_path: string;
  readonly bundle_path: string;
  readonly operator_trust_root_sha256: string;
  readonly current_epoch_root: string;
}

interface VerifyBundleCommand {
  readonly kind: 'verify-bundle';
  readonly request_path: string;
  readonly bundle_path: string;
  readonly operator_trust_root_sha256: string;
  readonly current_epoch_root: string;
}

interface VerifyHistoricalBundleCommand {
  readonly kind: 'verify-bundle-history';
  readonly request_path: string;
  readonly bundle_path: string;
  readonly operator_trust_root_sha256: string;
}

interface VerifyCompletionBundleCommand {
  readonly kind: 'verify-completion-bundle';
  readonly bundle_path: string;
  readonly operator_trust_root_sha256: string;
  readonly current_epoch_root: string;
  readonly checkpoint_root: string;
  readonly repository_root: string;
  readonly projection_path: string;
  readonly git_path: string;
}

interface VerifyHistoricalCompletionBundleCommand {
  readonly kind: 'verify-completion-bundle-history';
  readonly bundle_path: string;
  readonly operator_trust_root_sha256: string;
  readonly repository_root: string;
  readonly projection_path: string;
  readonly git_path: string;
}

export type CliCommand =
  | RunVerifierCommand
  | AdmitCompletionCommand
  | VerifyBundleCommand
  | VerifyHistoricalBundleCommand
  | VerifyCompletionBundleCommand
  | VerifyHistoricalCompletionBundleCommand;
const sha64 = /^[a-f0-9]{64}$/u;
const canonicalAbsolutePath = (value: string): boolean =>
  isAbsolute(value) && normalize(value) === value;
const containsPath = (parent: string, child: string): boolean => {
  const value = relative(parent, child);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
};
const pathsOverlap = (left: string, right: string): boolean =>
  containsPath(left, right) || containsPath(right, left);

function parseRunVerifier(args: readonly string[]): RunVerifierCommand {
  if (
    args.length !== 9 ||
    args[1] !== '--request' ||
    args[3] !== '--operator-trust-root-sha256' ||
    args[5] !== '--current-epoch-root' ||
    args[7] !== '--bundle'
  ) {
    throw new TypeError('run-verifier arguments do not match the canonical argv contract');
  }
  const requestPath = args[2];
  const operatorTrustRootSha256 = args[4];
  const currentEpochRoot = args[6];
  const bundlePath = args[8];
  if (
    requestPath === undefined ||
    !canonicalAbsolutePath(requestPath) ||
    operatorTrustRootSha256 === undefined ||
    !sha64.test(operatorTrustRootSha256) ||
    currentEpochRoot === undefined ||
    !canonicalAbsolutePath(currentEpochRoot) ||
    bundlePath === undefined ||
    !canonicalAbsolutePath(bundlePath)
  ) {
    throw new TypeError('run-verifier arguments are incomplete');
  }
  return {
    kind: 'run-verifier',
    request_path: requestPath,
    bundle_path: bundlePath,
    operator_trust_root_sha256: operatorTrustRootSha256,
    current_epoch_root: currentEpochRoot,
  };
}

function parseCompletionBundle(
  args: readonly string[],
): VerifyCompletionBundleCommand | VerifyHistoricalCompletionBundleCommand | undefined {
  if (
    args[0] === 'verify-completion-bundle' &&
    args.length === 15 &&
    args[1] === '--bundle' &&
    args[3] === '--operator-trust-root-sha256' &&
    args[5] === '--current-epoch-root' &&
    args[7] === '--checkpoint-root' &&
    args[9] === '--repository-root' &&
    args[11] === '--projection' &&
    args[13] === '--git' &&
    args[2] !== undefined &&
    canonicalAbsolutePath(args[2]) &&
    args[4] !== undefined &&
    sha64.test(args[4]) &&
    args[6] !== undefined &&
    canonicalAbsolutePath(args[6]) &&
    args[8] !== undefined &&
    canonicalAbsolutePath(args[8]) &&
    args[10] !== undefined &&
    canonicalAbsolutePath(args[10]) &&
    args[12] !== undefined &&
    canonicalAbsolutePath(args[12]) &&
    args[14] !== undefined &&
    canonicalAbsolutePath(args[14])
  )
    return Object.freeze({
      kind: 'verify-completion-bundle',
      bundle_path: args[2],
      operator_trust_root_sha256: args[4],
      current_epoch_root: args[6],
      checkpoint_root: args[8],
      repository_root: args[10],
      projection_path: args[12],
      git_path: args[14],
    });
  if (
    args[0] === 'verify-completion-bundle-history' &&
    args.length === 11 &&
    args[1] === '--bundle' &&
    args[3] === '--operator-trust-root-sha256' &&
    args[5] === '--repository-root' &&
    args[7] === '--projection' &&
    args[9] === '--git' &&
    args[2] !== undefined &&
    canonicalAbsolutePath(args[2]) &&
    args[4] !== undefined &&
    sha64.test(args[4]) &&
    args[6] !== undefined &&
    canonicalAbsolutePath(args[6]) &&
    args[8] !== undefined &&
    canonicalAbsolutePath(args[8]) &&
    args[10] !== undefined &&
    canonicalAbsolutePath(args[10])
  )
    return Object.freeze({
      kind: 'verify-completion-bundle-history',
      bundle_path: args[2],
      operator_trust_root_sha256: args[4],
      repository_root: args[6],
      projection_path: args[8],
      git_path: args[10],
    });
  return undefined;
}

export function parseCliArguments(args: readonly string[]): CliCommand {
  const completionBundle = parseCompletionBundle(args);
  if (completionBundle !== undefined) return completionBundle;
  if (args[0] === 'run-verifier') return parseRunVerifier(args);
  if (args[0] === 'verify-bundle') {
    const parsed = parseRunVerifier(['run-verifier', ...args.slice(1)]);
    return Object.freeze({ ...parsed, kind: 'verify-bundle' });
  }
  if (
    args[0] === 'verify-bundle-history' &&
    args.length === 7 &&
    args[1] === '--request' &&
    args[3] === '--operator-trust-root-sha256' &&
    args[5] === '--bundle' &&
    args[2] !== undefined &&
    canonicalAbsolutePath(args[2]) &&
    args[4] !== undefined &&
    sha64.test(args[4]) &&
    args[6] !== undefined &&
    canonicalAbsolutePath(args[6])
  ) {
    return Object.freeze({
      kind: 'verify-bundle-history',
      request_path: args[2],
      operator_trust_root_sha256: args[4],
      bundle_path: args[6],
    });
  }
  if (
    args[0] === 'admit-completion' &&
    args.length === 11 &&
    args[1] === '--request' &&
    args[3] === '--operator-trust-root-sha256' &&
    args[5] === '--current-epoch-root' &&
    args[7] === '--output' &&
    args[9] === '--bundle' &&
    args[2] !== undefined &&
    canonicalAbsolutePath(args[2]) &&
    args[4] !== undefined &&
    sha64.test(args[4]) &&
    args[6] !== undefined &&
    canonicalAbsolutePath(args[6]) &&
    args[8] !== undefined &&
    canonicalAbsolutePath(args[8]) &&
    args[10] !== undefined &&
    canonicalAbsolutePath(args[10]) &&
    !pathsOverlap(args[8], args[10])
  ) {
    return {
      kind: 'admit-completion',
      request_path: args[2],
      operator_trust_root_sha256: args[4],
      current_epoch_root: args[6],
      output_path: args[8],
      bundle_path: args[10],
    };
  }
  throw new TypeError('CLI arguments do not match a canonical command');
}
