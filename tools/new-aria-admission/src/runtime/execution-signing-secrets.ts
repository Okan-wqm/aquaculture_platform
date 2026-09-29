import type { KeyObject } from 'node:crypto';

import type { ExecutionSigningCapability } from '../kernel/execution-signing-capability';
import type { AuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';

export interface ExecutionSigningSecret {
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly privateKey: KeyObject;
  readonly principalId: string;
  readonly keySha256: string;
  readonly trustRootSha256: string;
  readonly keyEpoch: number;
}

const secrets = new WeakMap<object, ExecutionSigningSecret>();

export function registerExecutionSigningSecret(
  capability: ExecutionSigningCapability,
  secret: ExecutionSigningSecret,
): void {
  if (secrets.has(capability)) {
    throw new TypeError('execution signing secret was already registered');
  }
  secrets.set(capability, secret);
}

export function requireExecutionSigningSecret(
  capability: ExecutionSigningCapability,
): ExecutionSigningSecret {
  const secret = secrets.get(capability);
  if (secret === undefined) {
    throw new TypeError('execution signing capability was not issued or was revoked');
  }
  return secret;
}

export function revokeExecutionSigningSecret(capability: ExecutionSigningCapability): void {
  if (!secrets.delete(capability)) {
    throw new TypeError('execution signing capability was not issued or was already revoked');
  }
}
