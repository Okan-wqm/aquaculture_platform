/**
 * Protocol-codec golden-fixture twin (ADR-026 drift invariant).
 *
 * The Rust golden harness (`crates/protocol-codec/tests/golden_fixtures.rs`)
 * and this TypeScript spec consume the SAME `crates/protocol-codec/tests/golden/*.json`
 * files and must produce byte-identical output. Here the TypeScript leg drives
 * the `@platform/protocol-codec` wasm façade — i.e. the very same Rust parser,
 * compiled to WebAssembly — so any divergence would be a build/binding bug, and
 * a future hand-rolled TS decoder that drifts from the crate would fail here.
 *
 * This is the twin the harness's own doc-comment references but that did not
 * exist until the wasm build landed.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import {
  crc16Modbus,
  parseMbapHeader,
  parseRtuFrame,
  parseAsciiFrame,
  decodeReadHoldingRegistersResponse,
  decodeReadInputRegistersResponse,
  decodeWriteSingleRegister,
  decodeWriteMultipleRegistersResponse,
  decodeExceptionResponse,
  ProtocolCodecError,
} from '@platform/protocol-codec';

const GOLDEN_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'crates',
  'protocol-codec',
  'tests',
  'golden',
);

interface Fixture {
  name: string;
  description: string;
  decoder: string;
  wire_hex: string;
  expected_ok?: unknown;
  expected_err?: { kind: string };
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s/g, '');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return out;
}

/** Dispatch mirrors the Rust harness's `dispatch_ok` projection exactly. */
const DISPATCH: Record<string, (b: Uint8Array) => unknown> = {
  parse_mbap_header: (b) => parseMbapHeader(b),
  parse_rtu_frame: (b) => parseRtuFrame(b),
  parse_ascii_frame: (b) => parseAsciiFrame(b),
  decode_read_holding_registers_response: (b) => decodeReadHoldingRegistersResponse(b),
  decode_read_input_registers_response: (b) => decodeReadInputRegistersResponse(b),
  decode_write_single_register: (b) => decodeWriteSingleRegister(b),
  decode_write_multiple_registers_response: (b) => decodeWriteMultipleRegistersResponse(b),
  decode_exception_response: (b) => decodeExceptionResponse(b),
};

function loadFixtures(): Fixture[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) as Fixture);
}

describe('protocol-codec wasm façade — golden fixture parity', () => {
  const fixtures = loadFixtures();

  it('has fixtures to assert', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))(
    'fixture %s matches the shared golden expectation',
    (_name, fixture) => {
      const bytes = hexToBytes(fixture.wire_hex);
      const decoder = DISPATCH[fixture.decoder];
      if (!decoder) {
        throw new Error(`fixture ${fixture.name}: unknown decoder ${fixture.decoder}`);
      }

      if (fixture.expected_ok !== undefined) {
        expect(decoder(bytes)).toEqual(fixture.expected_ok);
      } else if (fixture.expected_err !== undefined) {
        try {
          decoder(bytes);
          throw new Error(`fixture ${fixture.name}: expected error, got ok`);
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolCodecError);
          expect((err as ProtocolCodecError).kind).toBe(fixture.expected_err.kind);
        }
      } else {
        throw new Error(`fixture ${fixture.name}: neither expected_ok nor expected_err`);
      }
    },
  );

  it('crc16Modbus matches the canonical 01 03 0000 000A frame body (0xCDC5)', () => {
    expect(crc16Modbus(hexToBytes('01030000000A'))).toBe(0xcdc5);
  });
});
