'use strict';

const verdict = process.argv[2];
const exitCode = Number(process.argv[3]);

if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
  process.stderr.write('invalid fixture exit code\n');
  process.exitCode = 2;
} else {
  const report = JSON.stringify({
    contract_id: 'new-aria-verifier-report-v1',
    result: {
      code: verdict === 'PASSED' ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED',
      summary: 'fixture verifier result',
    },
    schema_version: '1.0.0',
    verdict,
  });
  process.stdout.write(verdict === 'PADDED' ? ` ${report}\n` : `${report}\n`);
  process.stderr.write(`fixture:${verdict}:${exitCode}\n`);
  process.exitCode = exitCode;
}
