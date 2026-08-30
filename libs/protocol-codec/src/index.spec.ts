/**
 * `@platform/protocol-codec` façade smoke test.
 *
 * The exhaustive byte-for-byte conformance lives in the golden twin
 * (`apps/sensor-service/.../protocol-codec-golden.spec.ts`, which drives the
 * SAME `crates/protocol-codec/tests/golden/*.json` the Rust harness asserts).
 * This spec only proves the wasm façade LOADS and its public surface is wired
 * — the CRC/frame math and the typed error path — so the lib's own test target
 * has coverage rather than being an empty package.
 */
import { crc16Modbus, frameWithCrc, parseMbapHeader, ProtocolCodecError } from './index';

describe('@platform/protocol-codec façade', () => {
  it('loads the wasm and computes a CRC-16-Modbus in range', () => {
    const crc = crc16Modbus(new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]));
    expect(Number.isInteger(crc)).toBe(true);
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(0xffff);
  });

  it('frameWithCrc appends the little-endian CRC-16 trailer of the payload', () => {
    const data = new Uint8Array([0x01, 0x03, 0x02, 0x00, 0x0a]);
    const framed = frameWithCrc(data);
    expect(framed.length).toBe(data.length + 2);

    const crc = crc16Modbus(data);
    expect(framed[data.length]).toBe(crc & 0xff);
    expect(framed[data.length + 1]).toBe((crc >> 8) & 0xff);
  });

  it('raises a typed ProtocolCodecError on a truncated MBAP frame', () => {
    expect(() => parseMbapHeader(new Uint8Array([0x00]))).toThrow(ProtocolCodecError);
  });
});
