/**
 * Browser-safe identity contract for durable mobile commands.
 *
 * Domain packages own their operation names; this cross-stack authority owns
 * the envelope schema generation shared by every domain. Creating identities
 * through the factory makes it impossible for a domain operation to publish a
 * locally invented schema-version string.
 */
export const MOBILE_COMMAND_ENVELOPE_CONTRACT_V1 = Object.freeze({
  schemaVersion: 'mobile-command-v1',
} as const);

export interface MobileCommandIdentityV1<OperationType extends string = string> {
  readonly operationType: OperationType;
  readonly schemaVersion: typeof MOBILE_COMMAND_ENVELOPE_CONTRACT_V1.schemaVersion;
}

export function defineMobileCommandIdentityV1<const OperationType extends string>(
  operationType: OperationType,
): MobileCommandIdentityV1<OperationType> {
  return Object.freeze({
    operationType,
    schemaVersion: MOBILE_COMMAND_ENVELOPE_CONTRACT_V1.schemaVersion,
  });
}
