import policy from './jetstream-storage-policy.json';

type JetStreamStorageKind = keyof typeof policy.streams;

function requiredFileStoreBytes(): number {
  const allocations = Object.values(policy.streams).map((stream) => stream.max_bytes);
  const { numerator, denominator } = policy.reserve;
  if (
    policy.schema_version !== 1 ||
    !allocations.every((bytes) => Number.isSafeInteger(bytes) && bytes > 0) ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator < 1 ||
    numerator < denominator
  ) {
    throw new Error('Invalid canonical JetStream storage policy');
  }
  const reservedBytes = allocations.reduce((total, bytes) => total + bytes, 0) * numerator;
  if (!Number.isSafeInteger(reservedBytes)) {
    throw new Error('Canonical JetStream storage reservation exceeds safe integer arithmetic');
  }
  return Math.ceil(reservedBytes / denominator);
}

export const JETSTREAM_REQUIRED_FILE_STORE_BYTES = requiredFileStoreBytes();

/** Environment overrides may reduce a stream allocation, but never exceed the
 * capacity the same immutable policy reserves in the broker and deploy gate. */
export function getJetStreamStorageBudget(
  stream: JetStreamStorageKind,
  configuredValue?: unknown,
): number {
  const declared = policy.streams[stream].max_bytes;
  if (configuredValue === undefined) return declared;
  const parsed =
    typeof configuredValue === 'number'
      ? configuredValue
      : typeof configuredValue === 'string' && /^[0-9]+$/.test(configuredValue)
        ? Number(configuredValue)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > declared) {
    throw new Error(
      `NATS_${stream.toUpperCase()}_MAX_BYTES must be a positive safe integer no greater than its declared allocation (${declared})`,
    );
  }
  return parsed;
}
