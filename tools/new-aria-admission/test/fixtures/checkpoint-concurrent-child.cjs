'use strict';

const { existsSync, writeFileSync } = require('node:fs');
const [modulePath, root, requestJson, markerPath, releasePath, failurePath] = process.argv.slice(2);
const fixedNow = Date.parse('2026-09-03T00:00:00.000Z');
let clockReads = 0;

function fail(error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeFileSync(failurePath, message, { mode: 0o600 });
  process.exitCode = 1;
}

Date.now = () => {
  clockReads += 1;
  if (markerPath !== '-' && clockReads === 3) {
    writeFileSync(markerPath, 'ready', { flag: 'wx', mode: 0o600 });
    while (!existsSync(releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return fixedNow;
};

try {
  require('ts-node/register/transpile-only');
  const { FileEvidenceCheckpointStore } = require(modulePath);
  const request = JSON.parse(requestJson);
  const store = new FileEvidenceCheckpointStore(root);
  store.compareAndSet(request).then(
    (result) => {
      store.close();
      process.stdout.write(result);
    },
    (error) => {
      try {
        store.close();
      } catch {
        /* Preserve the primary error. */
      }
      fail(error);
    },
  );
} catch (error) {
  fail(error);
}
