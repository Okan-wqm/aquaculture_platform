const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

const input = readFileSync(0);
let passed = input.byteLength <= 24 * 1024 * 1024;
try {
  const value = JSON.parse(input.toString('utf8'));
  passed =
    passed &&
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        Object.keys(entry).sort().join(',') === 'object_base64,reference' &&
        typeof entry.object_base64 === 'string' &&
        entry.reference !== null &&
        typeof entry.reference === 'object' &&
        Object.keys(entry.reference).sort().join(',') === 'sha256,uri' &&
        typeof entry.reference.sha256 === 'string' &&
        entry.reference.uri === `aria-evidence://sha256/${entry.reference.sha256}` &&
        Buffer.from(entry.object_base64, 'base64').toString('base64') === entry.object_base64 &&
        createHash('sha256').update(Buffer.from(entry.object_base64, 'base64')).digest('hex') ===
          entry.reference.sha256,
    ) &&
    Buffer.from(value[0].object_base64, 'base64').equals(Buffer.from('verified-input-object\n')) &&
    JSON.stringify(value) === input.toString('utf8');
} catch {
  passed = false;
}
process.stdout.write(
  `${JSON.stringify({
    contract_id: 'new-aria-verifier-report-v1',
    result: {
      code: passed ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED',
      summary: 'stdin envelope verification',
    },
    schema_version: '1.0.0',
    verdict: passed ? 'PASSED' : 'FAILED',
  })}\n`,
);
process.stderr.write(`stdin:${input.byteLength.toString()}\n`);
process.exitCode = passed ? 0 : 1;
