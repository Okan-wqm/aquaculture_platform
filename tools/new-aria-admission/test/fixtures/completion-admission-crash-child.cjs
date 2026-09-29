'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [modulePath, requestPath, outputPath, rootSha256, epochRoot, bundlePath, barrierPath] =
  process.argv.slice(2);
Date.now = () => Date.parse('2026-09-02T12:30:00.000Z');
const originalRename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (
    path.basename(String(source)) === 'CANDIDATE.json' &&
    path.basename(String(destination)) === 'COMPLETE.json'
  ) {
    fs.writeFileSync(barrierPath, 'checkpoint committed\n', { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return originalRename(source, destination);
};

require('ts-node/register/transpile-only');
const { executeCompletionAdmissionCommand } = require(modulePath);
executeCompletionAdmissionCommand(requestPath, outputPath, rootSha256, epochRoot, bundlePath).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exit(1);
  },
);
