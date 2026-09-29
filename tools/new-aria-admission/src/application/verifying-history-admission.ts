export interface VerifiedVerifyingHistory {
  readonly event_chain_bytes: Buffer;
  readonly manifest_chain_bytes: readonly Buffer[];
  readonly manifest_chain_sha256s: readonly string[];
}

export function assertCompletionVerifyingHistory(
  eventBytes: Uint8Array,
  manifestBytes: readonly Uint8Array[],
  donePredecessorSha256: string | null,
  expected: VerifiedVerifyingHistory,
): void {
  const bytes = Buffer.from(eventBytes);
  if (bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
    throw new TypeError('completion event history framing is invalid');
  }
  const eventLines = bytes.toString('utf8').slice(0, -1).split('\n');
  const verifyingEventBytes = Buffer.from(`${eventLines.slice(0, 3).join('\n')}\n`);
  if (
    eventLines.length !== 4 ||
    manifestBytes.length !== 4 ||
    !verifyingEventBytes.equals(expected.event_chain_bytes) ||
    expected.manifest_chain_bytes.length !== 3 ||
    expected.manifest_chain_sha256s.length !== 3 ||
    expected.manifest_chain_bytes.some(
      (entry, index) => !entry.equals(Buffer.from(manifestBytes[index] ?? [])),
    ) ||
    donePredecessorSha256 !== expected.manifest_chain_sha256s[2]
  )
    throw new TypeError('completion history differs from signed VERIFYING dossier');
}
