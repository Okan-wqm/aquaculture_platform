import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { readCanonicalFile } from '../src/runtime/canonical-files';
import { canonicalOutputPendingName } from '../src/runtime/canonical-output-recovery';
import {
  abortCanonicalOutput,
  publishCanonicalOutput,
  reserveCanonicalOutput,
} from '../src/runtime/canonical-output-reservation';
import { canonicalOutputReservationSidecarName } from '../src/runtime/canonical-output-reservation-io';

const bytes = Buffer.from('{"status":"VALID_AT"}\n');

function reservationBytes(): Buffer {
  return Buffer.concat([
    canonicalJsonBytes({
      schema_version: '1.0.0',
      contract_id: 'new-aria-canonical-output-reservation-v1',
      status: 'PENDING',
      expected_sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
    Buffer.from('\n'),
  ]);
}

describe('canonical output reservation provenance', () => {
  let root: string;
  let output: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'new-aria-output-reservation-'));
    output = join(root, 'projection.json');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([0, 7])('preserves a foreign %i-byte public output prefix', (length) => {
    const foreign = reservationBytes().subarray(0, length);
    writeFileSync(output, foreign, { mode: 0o600 });
    const before = lstatSync(output);

    expect(() => reserveCanonicalOutput(output, bytes)).toThrow();
    const after = lstatSync(output);
    expect({ inode: after.ino, bytes: readFileSync(output) }).toEqual({
      inode: before.ino,
      bytes: foreign,
    });
  });

  it.each([0, 7])('recovers a hidden %i-byte reservation sidecar', (length) => {
    const reservation = reservationBytes();
    const sidecar = join(
      root,
      canonicalOutputReservationSidecarName('projection.json', reservation),
    );
    writeFileSync(sidecar, reservation.subarray(0, length), { mode: 0o600 });

    const recovered = reserveCanonicalOutput(output, bytes);
    expect(() => publishCanonicalOutput(recovered)).not.toThrow();
    expect(readCanonicalFile(output, 'recovered projection')).toEqual(bytes);
    expect(existsSync(sidecar)).toBe(false);
  });

  it.each([
    ['partial', 7],
    ['complete', undefined],
  ])('recovers a %s final-byte pending write', (_label, prefixLength) => {
    reserveCanonicalOutput(output, bytes);
    const pending = join(root, canonicalOutputPendingName('projection.json', bytes));
    writeFileSync(pending, prefixLength === undefined ? bytes : bytes.subarray(0, prefixLength), {
      mode: 0o600,
    });

    const recovered = reserveCanonicalOutput(output, bytes);
    publishCanonicalOutput(recovered);
    expect(readFileSync(output)).toEqual(bytes);
    expect(existsSync(pending)).toBe(false);
  });

  it('aborts only an output paired with its exact hidden reservation inode', () => {
    const reserved = reserveCanonicalOutput(output, bytes);
    const sidecar = join(
      root,
      canonicalOutputReservationSidecarName('projection.json', reservationBytes()),
    );
    const outputStat = lstatSync(output);
    const sidecarStat = lstatSync(sidecar);
    expect({
      same_device: outputStat.dev === sidecarStat.dev,
      same_inode: outputStat.ino === sidecarStat.ino,
      output_links: outputStat.nlink,
      sidecar_links: sidecarStat.nlink,
    }).toEqual({
      same_device: true,
      same_inode: true,
      output_links: 2,
      sidecar_links: 2,
    });

    abortCanonicalOutput(reserved);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
