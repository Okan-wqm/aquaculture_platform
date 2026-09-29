import { existsSync } from 'node:fs';

import type { ExecutableRunBundleVerificationInput } from './executable-run-bundle-verifier';
import {
  verifyExecutableRunBundle,
  verifyStagedExecutableRunBundle,
} from './executable-run-bundle-verifier';
import { promoteStagedExecutableRunBundle } from './executable-run-bundle-promotion';

export function recoverExistingExecutableRunBundle(
  input: ExecutableRunBundleVerificationInput,
): boolean {
  if (!existsSync(input.bundle_path)) return false;
  try {
    verifyExecutableRunBundle(input);
    return true;
  } catch {
    const staged = verifyStagedExecutableRunBundle(input);
    promoteStagedExecutableRunBundle(input.bundle_path, staged);
    verifyExecutableRunBundle(input);
    return true;
  }
}
