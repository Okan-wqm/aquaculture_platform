export function parseBatchOutput(raw, entries) {
  const files = new Map();
  let offset = 0;
  for (const entry of entries) {
    const newline = raw.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('Git batch output header is truncated');
    const header = new TextDecoder('ascii', { fatal: true }).decode(raw.subarray(offset, newline));
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== entry.oid) throw new Error('Git batch output identity mismatch');
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end >= raw.length)
      throw new Error('Git batch blob is truncated');
    if (raw[end] !== 0x0a) throw new Error('Git batch blob delimiter mismatch');
    files.set(entry.path, { ...entry, bytes: Buffer.from(raw.subarray(start, end)) });
    offset = end + 1;
  }
  if (offset !== raw.length) throw new Error('Git batch output has trailing bytes');
  return files;
}
