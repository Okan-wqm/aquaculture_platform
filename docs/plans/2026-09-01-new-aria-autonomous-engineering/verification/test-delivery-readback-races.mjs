#!/usr/bin/env node

import assert from 'node:assert/strict';
import { verifyDeliveryReadback } from './delivery-readback.mjs';
import { createReadbackSuite } from './delivery-readback-test-fixture.mjs';

const suite = createReadbackSuite();
const { withReadbackCase } = suite;
process.once('exit', suite.cleanup);

await withReadbackCase(
  () => {},
  async (authority, _calls, github) => {
    const originalFetch = globalThis.fetch;
    let mainReads = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/git/ref/heads/main') && (mainReads += 1) === 2) {
        github.bodies.ref.object.sha = '9'.repeat(40);
      }
      return originalFetch(url, options);
    };
    try {
      await assert.rejects(
        verifyDeliveryReadback(authority),
        /changed during verification/u,
        'provider facts changed during dossier verification were accepted',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

async function rejectFinalNoteRace(name, mutate, pattern) {
  await withReadbackCase(
    () => {},
    async (authority, _calls, github) => {
      const originalFetch = globalThis.fetch;
      let noteReads = 0;
      globalThis.fetch = async (url, options) => {
        if (String(url).includes('/issues/1393/comments?') && (noteReads += 1) === 2) {
          mutate(github.bodies.comments);
        }
        return originalFetch(url, options);
      };
      try {
        await assert.rejects(verifyDeliveryReadback(authority), pattern, `${name} was accepted`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
}

await rejectFinalNoteRace(
  'final-note edit between snapshots',
  ([comment]) =>
    (comment.updated_at = new Date(Date.parse(comment.updated_at) + 1_000).toISOString()),
  /immutable/u,
);
await rejectFinalNoteRace(
  'final-note delete between snapshots',
  (comments) => comments.splice(0),
  /exactly one/u,
);
await rejectFinalNoteRace(
  'final-note identity change between snapshots',
  ([comment]) => {
    comment.id = 9002;
    comment.node_id = 'IC_kwDOQ4Ocb86gZGlmZg';
    comment.html_url =
      'https://github.com/Okan-wqm/aquaculture_platform/pull/1393#issuecomment-9002';
  },
  /changed during verification/u,
);

const boundary = Date.now();
await withReadbackCase(
  (value) => {
    value.observed_at = new Date(boundary - 1_000).toISOString();
    value.valid_until = new Date(boundary + 1_000).toISOString();
  },
  async (authority) => {
    const originalNow = Date.now;
    let now = boundary;
    Date.now = () => now;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...arguments_) => {
      const response = await originalFetch(...arguments_);
      now = boundary + 2_000;
      return response;
    };
    try {
      await assert.rejects(verifyDeliveryReadback(authority), /freshness/u);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  },
);

suite.cleanup();
process.removeListener('exit', suite.cleanup);
process.stdout.write('PASS delivery-readback-races mutants=5\n');
