#!/usr/bin/env node

import { closeSync, fstatSync, openSync, unlinkSync, writeSync } from 'node:fs';

function fail(message, outputPath, outputFd) {
  if (outputFd !== null) {
    try {
      closeSync(outputFd);
    } catch {
      // The descriptor may already be closed by the successful finalizer.
    }
  }
  if (outputPath !== null) {
    try {
      unlinkSync(outputPath);
    } catch {
      // A pre-open validation failure has no partial path to remove.
    }
  }
  process.stderr.write(`FATAL: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const hasExpectedMarker = args.length === 6;
if (
  (args.length !== 4 && !hasExpectedMarker) ||
  args[0] !== '--output' ||
  args[2] !== '--max-bytes' ||
  (hasExpectedMarker && args[4] !== '--expected-marker') ||
  !/^\/[\x21-\x7e]+$/.test(args[1] ?? '') ||
  !/^[1-9][0-9]*$/.test(args[3] ?? '') ||
  (hasExpectedMarker && !/^[A-Z][A-Z0-9_]{0,127}$/.test(args[5] ?? ''))
) {
  fail(
    'usage: read-bounded-line.mjs --output ABSOLUTE_PATH --max-bytes POSITIVE_INTEGER [--expected-marker UPPER_SNAKE_CASE]',
    null,
    null,
  );
}

const outputPath = args[1];
const maxBytes = Number(args[3]);
const expectedMarker = hasExpectedMarker ? Buffer.from(args[5], 'utf8') : null;
if (!Number.isSafeInteger(maxBytes) || maxBytes > 16 * 1024 * 1024) {
  fail('max-bytes exceeds the bounded-line reader safety ceiling', null, null);
}

let outputFd = null;
let writtenBytes = 0;
let markerOffset = 0;
let state = 'payload';

try {
  outputFd = openSync(outputPath, 'wx', 0o600);
} catch {
  fail('output must be a new regular path', null, null);
}

const abort = (message) => fail(message, outputPath, outputFd);

const finalize = () => {
  if (writtenBytes === 0) abort('canonical record must not be empty');
  const finalStat = fstatSync(outputFd);
  if (!finalStat.isFile() || finalStat.size !== writtenBytes || finalStat.mode & 0o077) {
    abort('post-write size, type, or mode attestation failed');
  }
  closeSync(outputFd);
  outputFd = null;
  state = 'complete';
  process.exit(0);
};

process.on('SIGINT', () => abort('bounded-line read interrupted'));
process.on('SIGTERM', () => abort('bounded-line read terminated'));

process.stdin.on('data', (chunk) => {
  let chunkOffset = 0;
  while (chunkOffset < chunk.length) {
    if (state === 'payload') {
      const newlineIndex = chunk.indexOf(0x0a, chunkOffset);
      const payloadEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      const payloadBytes = chunk.subarray(chunkOffset, payloadEnd);
      if (writtenBytes + payloadBytes.length > maxBytes) {
        abort('record exceeds max-bytes before the overflowing write');
      }
      let payloadOffset = 0;
      while (payloadOffset < payloadBytes.length) {
        payloadOffset += writeSync(
          outputFd,
          payloadBytes,
          payloadOffset,
          payloadBytes.length - payloadOffset,
        );
      }
      writtenBytes += payloadBytes.length;
      chunkOffset = payloadEnd;
      if (newlineIndex === -1) return;
      if (writtenBytes === 0) abort('canonical record must not be empty');
      chunkOffset += 1;
      state = expectedMarker === null ? 'await-eof' : 'marker';
      continue;
    }

    if (state === 'marker') {
      const newlineIndex = chunk.indexOf(0x0a, chunkOffset);
      const markerEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      const markerBytes = chunk.subarray(chunkOffset, markerEnd);
      if (
        markerOffset + markerBytes.length > expectedMarker.length ||
        !markerBytes.equals(
          expectedMarker.subarray(markerOffset, markerOffset + markerBytes.length),
        )
      ) {
        abort('terminal marker does not match the canonical protocol');
      }
      markerOffset += markerBytes.length;
      chunkOffset = markerEnd;
      if (newlineIndex === -1) return;
      if (markerOffset !== expectedMarker.length) {
        abort('terminal marker ended before the canonical protocol value');
      }
      chunkOffset += 1;
      if (chunkOffset !== chunk.length) {
        abort('input contains bytes after the terminal marker');
      }
      finalize();
      return;
    }

    abort('input continued after the canonical record');
  }
});

process.stdin.on('end', () => {
  if (state === 'await-eof') {
    finalize();
    return;
  }
  if (state !== 'complete') {
    abort('input ended before the complete canonical frame protocol');
  }
});

process.stdin.on('error', () => abort('input stream failed'));
