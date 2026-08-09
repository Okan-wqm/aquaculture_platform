import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFindingRegistryRequestReceipt,
  parseFindingRegistryRequestReceipt,
  serializeFindingRegistryRequestReceipt,
} from './finding-registry-request-receipt';

const canonical = buildFindingRegistryRequestReceipt({
  repository: 'Okan-wqm/aquaculture_platform',
  repository_id: '1132698735',
  workflow_ref:
    'Okan-wqm/aquaculture_platform/.github/workflows/finding-registry-authority.yml@refs/heads/main',
  workflow_sha: '1'.repeat(40),
  workflow_run_id: 91,
  workflow_run_attempt: 2,
  command_id: 'finding-request:INC-1234',
  operation: 'add',
  input_sha256: '2'.repeat(64),
});

void describe('finding registry request receipt', () => {
  void it('round-trips one byte-canonical, content-bound request identity', () => {
    const bytes = Buffer.from(serializeFindingRegistryRequestReceipt(canonical), 'utf8');
    assert.deepEqual(parseFindingRegistryRequestReceipt(bytes), canonical);
    assert.equal(
      serializeFindingRegistryRequestReceipt(parseFindingRegistryRequestReceipt(bytes)),
      bytes.toString('utf8'),
    );
  });

  void it('rejects whitespace, key-order, unknown-field, and identity drift', () => {
    const value = JSON.parse(serializeFindingRegistryRequestReceipt(canonical)) as Record<
      string,
      unknown
    >;
    const variants = [
      Buffer.from(`${JSON.stringify(value).replaceAll(',', ',\n')}\n`, 'utf8'),
      Buffer.from(
        `${JSON.stringify(Object.fromEntries(Object.entries(value).reverse()))}\n`,
        'utf8',
      ),
      Buffer.from(`${JSON.stringify({ ...value, unexpected: true })}\n`, 'utf8'),
      Buffer.from(
        serializeFindingRegistryRequestReceipt(
          buildFindingRegistryRequestReceipt({
            ...canonical,
            command_id: 'finding-request:INC-9999',
          }),
        ),
        'utf8',
      ),
    ] as const;

    assert.throws(() => parseFindingRegistryRequestReceipt(variants[0]), /canonical/i);
    assert.throws(() => parseFindingRegistryRequestReceipt(variants[1]), /canonical/i);
    assert.throws(() => parseFindingRegistryRequestReceipt(variants[2]), /canonical/i);
    assert.notDeepEqual(parseFindingRegistryRequestReceipt(variants[3]), canonical);
  });

  void it('rejects invalid UTF-8 and noncanonical scalar domains', () => {
    assert.throws(
      () => parseFindingRegistryRequestReceipt(Buffer.from([0xc3, 0x28])),
      /UTF-8 JSON/i,
    );
    assert.throws(
      () =>
        buildFindingRegistryRequestReceipt({
          ...canonical,
          workflow_run_attempt: 0,
        }),
      /positive safe integer/i,
    );
    assert.throws(
      () =>
        buildFindingRegistryRequestReceipt({
          ...canonical,
          input_sha256: 'not-a-digest',
        }),
      /input_sha256/i,
    );
  });
});
