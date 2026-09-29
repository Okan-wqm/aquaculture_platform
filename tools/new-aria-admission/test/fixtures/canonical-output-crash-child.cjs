'use strict';

const fs = require('node:fs');

const [modulePath, outputPath, bytesBase64, barrierPath] = process.argv.slice(2);
const originalUnlink = fs.unlinkSync;

fs.unlinkSync = (path) => {
  if (String(path).includes('.new-aria-output-') && String(path).endsWith('.pending')) {
    fs.writeFileSync(barrierPath, 'linked', { flag: 'wx', mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  originalUnlink(path);
};

try {
  require('ts-node/register/transpile-only');
  const { writeNewCanonicalFile } = require(modulePath);
  writeNewCanonicalFile(outputPath, Buffer.from(bytesBase64, 'base64'));
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(message);
  process.exitCode = 1;
}
