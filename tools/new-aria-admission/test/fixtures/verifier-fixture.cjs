'use strict';

const verdict = process.argv[2];
const exitCode = Number(process.argv[3]);

if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
  process.stderr.write('invalid fixture exit code\n');
  process.exitCode = 2;
} else {
  process.stdout.write(
    verdict === 'PADDED'
      ? ' { "semantic_verdict" : "PASSED" }\n'
      : `{"semantic_verdict":"${verdict}"}\n`,
  );
  process.stderr.write(`fixture:${verdict}:${exitCode}\n`);
  process.exitCode = exitCode;
}
