import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACK_INDEX_MAGIC = 0xff744f63;
const SHA1_BYTES = 20;
const FANOUT_BYTES = 256 * 4;

function objectRow(buffer: Buffer, objectTable: number, count: number, oid: string): number {
  const wanted = Buffer.from(oid, 'hex');
  for (let index = 0; index < count; index += 1) {
    if (
      buffer
        .subarray(objectTable + index * SHA1_BYTES, objectTable + (index + 1) * SHA1_BYTES)
        .equals(wanted)
    ) {
      return index;
    }
  }
  throw new TypeError(`pack index does not contain ${oid}`);
}

function swapWords(buffer: Buffer, left: number, right: number): void {
  const value = buffer.readUInt32BE(left);
  buffer.writeUInt32BE(buffer.readUInt32BE(right), left);
  buffer.writeUInt32BE(value, right);
}

export function redirectPackedObject(
  repositoryRoot: string,
  authorizedOid: string,
  attackerOid: string,
): void {
  const packRoot = join(repositoryRoot, '.git/objects/pack');
  const indexes = readdirSync(packRoot).filter((name) => name.endsWith('.idx'));
  if (indexes.length !== 1 || indexes[0] === undefined) {
    throw new TypeError('fixture requires exactly one pack index');
  }
  const indexPath = join(packRoot, indexes[0]);
  const bytes = readFileSync(indexPath);
  if (bytes.readUInt32BE(0) !== PACK_INDEX_MAGIC || bytes.readUInt32BE(4) !== 2) {
    throw new TypeError('fixture requires a version-two pack index');
  }
  const objectCount = bytes.readUInt32BE(8 + 255 * 4);
  const objectTable = 8 + FANOUT_BYTES;
  const crcTable = objectTable + objectCount * SHA1_BYTES;
  const offsetTable = crcTable + objectCount * 4;
  const authorizedRow = objectRow(bytes, objectTable, objectCount, authorizedOid);
  const attackerRow = objectRow(bytes, objectTable, objectCount, attackerOid);
  const authorizedOffset = offsetTable + authorizedRow * 4;
  const attackerOffset = offsetTable + attackerRow * 4;
  if (
    (bytes.readUInt32BE(authorizedOffset) & 0x80000000) !== 0 ||
    (bytes.readUInt32BE(attackerOffset) & 0x80000000) !== 0
  ) {
    throw new TypeError('fixture does not support large pack offsets');
  }
  swapWords(bytes, crcTable + authorizedRow * 4, crcTable + attackerRow * 4);
  swapWords(bytes, authorizedOffset, attackerOffset);
  createHash('sha1')
    .update(bytes.subarray(0, -SHA1_BYTES))
    .digest()
    .copy(bytes, bytes.length - SHA1_BYTES);
  writeFileSync(indexPath, bytes);
}
